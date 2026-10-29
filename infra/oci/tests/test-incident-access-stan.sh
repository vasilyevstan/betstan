#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/scripts/incident_access_stan.py"
WORK_PARENT="$ROOT_DIR/infra/oci/tests/.incident-access-workdirs"
mkdir -p "$WORK_PARENT"
WORK_DIR="$(mktemp -d "$WORK_PARENT/test.XXXXXX")"
BIN_DIR="$WORK_DIR/bin"
CLOUD_DIR="$WORK_DIR/cloud"
mkdir -p "$BIN_DIR" "$CLOUD_DIR"

cleanup() {
  rm -rf -- "$WORK_DIR"
  rmdir "$WORK_PARENT" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "incident access test failed: $*" >&2
  exit 1
}

cat >"$BIN_DIR/oci" <<'PY'
#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

root = Path(os.environ["MOCK_CLOUD_DIR"])
args = sys.argv[1:]
mode = os.environ.get("MOCK_REMOVE_MODE", "success")
read_mode = os.environ.get("MOCK_READ_MODE", "")
(root / "calls.log").open("a", encoding="utf-8").write(" ".join(args) + "\n")


def load(name):
    return json.loads((root / name).read_text(encoding="utf-8"))


def save(name, value):
    (root / name).write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def option(name):
    return args[args.index(name) + 1]


json_read = (
    args[:4] == ["network", "nsg", "rules", "list"]
    or args[:3] == ["bastion", "session", "get"]
    or args[:3] == ["bastion", "session", "list"]
)
mutation = (
    args[:4] == ["network", "nsg", "rules", "remove"]
    or args[:3] == ["bastion", "session", "delete"]
    or args[:3] == ["bastion", "bastion", "update"]
)
if json_read and (
    args.count("--output") != 1
    or args[-2:] != ["--output", "json"]
):
    print("JSON read did not pin terminal --output json", file=sys.stderr)
    raise SystemExit(2)
if mutation and "--output" in args:
    print("mutation unexpectedly received --output", file=sys.stderr)
    raise SystemExit(2)


if args[:4] == ["network", "nsg", "rules", "list"]:
    if read_mode == "blank-rules-list":
        raise SystemExit(0)
    print(json.dumps({"data": load("rules.json")}))
    raise SystemExit(0)

if args[:4] == ["network", "nsg", "rules", "remove"]:
    ids = set(json.loads(option("--security-rule-ids")))
    rules = load("rules.json")
    if mode != "not-applied":
        save("rules.json", [rule for rule in rules if rule.get("id") not in ids])
    if mode == "apply-error":
        print("simulated applied-then-error", file=sys.stderr)
        raise SystemExit(1)
    if mode == "not-applied":
        print("simulated not-applied", file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(0)

if args[:3] == ["bastion", "session", "get"]:
    if read_mode == "blank-session-get":
        raise SystemExit(0)
    if read_mode == "malformed-session-get":
        print("not-json")
        raise SystemExit(0)
    session_id = option("--session-id")
    matches = [
        item for item in load("sessions.json")
        if item.get("id") == session_id
    ]
    if len(matches) != 1:
        raise SystemExit(1)
    print(json.dumps({"data": matches[0]}))
    raise SystemExit(0)

if args[:3] == ["bastion", "session", "list"]:
    if read_mode == "malformed-session-list":
        print("not-json")
        raise SystemExit(0)
    if read_mode == "failed-session-list":
        print("simulated list failure", file=sys.stderr)
        raise SystemExit(1)
    bastion_id = option("--bastion-id")
    display_name = option("--display-name")
    if display_name == os.environ.get("MOCK_EMPTY_SESSION_NAME", ""):
        raise SystemExit(0)
    matches = [
        item for item in load("sessions.json")
        if item.get("bastion-id") == bastion_id
        and item.get("display-name") == display_name
    ]
    print(json.dumps({"data": matches}))
    raise SystemExit(0)

if args[:3] == ["bastion", "session", "delete"]:
    session_id = option("--session-id")
    sessions = load("sessions.json")
    if mode != "not-applied":
        save(
            "sessions.json",
            [
                item for item in sessions
                if item.get("id") != session_id
            ],
        )
    if mode == "apply-error":
        print("simulated applied-then-error", file=sys.stderr)
        raise SystemExit(1)
    if mode == "not-applied":
        print("simulated not-applied", file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(0)

if args[:3] == ["bastion", "bastion", "update"]:
    with (root / "allowlist-updates.log").open("a", encoding="utf-8") as handle:
        handle.write(option("--bastion-id") + "\n")
    raise SystemExit(0)

print("unexpected OCI invocation: " + " ".join(args), file=sys.stderr)
raise SystemExit(2)
PY
chmod +x "$BIN_DIR/oci"

MANIFEST="$(printf '7%.0s' {1..64})"
JOURNAL="$(printf '8%.0s' {1..64})"
CONTROL_A="$(printf 'a%.0s' {1..40})"
CONTROL_B="$(printf 'b%.0s' {1..40})"
CONTROL_C="$(printf 'c%.0s' {1..40})"
AUTHORITY_A="$(printf 'd%.0s' {1..64})"
AUTHORITY_B="$(printf 'e%.0s' {1..64})"
OWNER=39945618182
NSG=ocid1.networksecuritygroup.oc1.test
BASTION=ocid1.bastion.oc1.test

python3 - "$CLOUD_DIR" "$NSG" "$BASTION" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
nsg, bastion = sys.argv[2:]


def write(name, value):
    (root / name).write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def rule(rule_id, run, cidr, expiry):
    return {
        "id": rule_id,
        "description": (
            f"betstan-github-runner run={run} attempt=1 expires={expiry}"
        ),
        "source": cidr,
        "direction": "INGRESS",
        "protocol": "6",
        "source-type": "CIDR_BLOCK",
        "tcp-options": {
            "destination-port-range": {"min": 6443, "max": 6443}
        },
    }


def session(session_id, run):
    return {
        "id": session_id,
        "bastion-id": bastion,
        "display-name": f"betstan-k3s-ssh-{run}-1",
        "lifecycle-state": "ACTIVE",
    }


write(
    "rules.json",
    [
        rule("rule-a", 5000, "198.51.100.10/32", 1792803600),
        rule("unrelated-rule", 9000, "198.51.100.90/32", 1792900000),
    ],
)
write(
    "sessions.json",
    [
        session("session-a", 5000),
        {
            "id": "unrelated-session",
            "bastion-id": bastion,
            "display-name": "betstan-k3s-ssh-9000-1",
            "lifecycle-state": "ACTIVE",
        },
    ],
)
PY

run_access() {
  local runtime="$1"
  shift
  PATH="$BIN_DIR:$PATH" \
  MOCK_CLOUD_DIR="$CLOUD_DIR" \
  INCIDENT_MANIFEST_SHA256="$MANIFEST" \
  INCIDENT_OWNER_RUN_ID="$OWNER" \
  INCIDENT_JOURNAL_IDENTITY_SHA256="$JOURNAL" \
  INCIDENT_RESTORE_RUN_ID="${TEST_RESTORE_RUN_ID:-5001}" \
  INCIDENT_RUN_ATTEMPT=1 \
  INCIDENT_CONTROL_SHA="${TEST_CONTROL_SHA:-$CONTROL_B}" \
  INCIDENT_CONTINUATION_GENERATION="${TEST_GENERATION:-1}" \
  INCIDENT_CONTINUATION_RUN_ID="${TEST_PREDECESSOR_RUN_ID:-5000}" \
  INCIDENT_CONTINUATION_CONTROL_SHA="${TEST_PREDECESSOR_CONTROL_SHA:-$CONTROL_A}" \
  INCIDENT_CONTINUATION_AUTHORITY_SHA256="${TEST_PREDECESSOR_AUTHORITY_SHA256:-$AUTHORITY_A}" \
  OCI_ENDPOINT_NSG_OCID="$NSG" \
  OCI_BASTION_OCID="$BASTION" \
  NOW_EPOCH=1792800000 \
    "$SCRIPT" "$@" --runtime-mode "$runtime"
}

make_records() {
  local receipt="$1"
  local current="$2"
  local output="$3"
  jq -c -s '.[0].obligations[0].resource as $predecessor |
    if $predecessor == null then [.[1]] else [$predecessor, .[1]] end' \
    "$receipt" "$current" >"$output"
}

LINEAGE_A="$WORK_DIR/lineage-a.json"
jq -cnS \
  --arg control "$CONTROL_A" \
  --arg authority "$AUTHORITY_A" \
  '[{runId:5000,controlSha:$control,authorityGeneration:0,authoritySha256:$authority}]' \
  >"$LINEAGE_A"
LINEAGE_AB="$WORK_DIR/lineage-ab.json"
jq -cnS \
  --arg control_a "$CONTROL_A" \
  --arg control_b "$CONTROL_B" \
  --arg authority_a "$AUTHORITY_A" \
  --arg authority_b "$AUTHORITY_B" \
  '[
    {runId:5000,controlSha:$control_a,authorityGeneration:0,authoritySha256:$authority_a},
    {runId:5001,controlSha:$control_b,authorityGeneration:1,authoritySha256:$authority_b}
  ]' >"$LINEAGE_AB"

# Pre-journal A survives B's genuine not-applied cleanup and is inherited by C.
set +e
MOCK_REMOVE_MODE=not-applied run_access oke cleanup-lineage \
  --lineage-file "$LINEAGE_A" \
  --output "$WORK_DIR/oke-prejournal-b.json" \
  >"$WORK_DIR/oke-prejournal-b.out" 2>&1
status=$?
set -e
[[ "$status" -ne 0 &&
   ! -e "$WORK_DIR/oke-prejournal-b.json" &&
   "$(jq -r '[.[] | select(.id == "rule-b")] | length' \
      "$CLOUD_DIR/rules.json")" == "0" ]] ||
  fail "pre-journal OKE cleanup-only B unexpectedly succeeded"
MOCK_REMOVE_MODE=apply-error \
TEST_RESTORE_RUN_ID=5002 \
TEST_CONTROL_SHA="$CONTROL_C" \
TEST_GENERATION=2 \
TEST_PREDECESSOR_RUN_ID=5001 \
TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
  run_access oke cleanup-lineage \
    --lineage-file "$LINEAGE_AB" \
    --output "$WORK_DIR/oke-prejournal-c.json" >/dev/null
[[ "$(jq -r '.obligations[0].result' \
      "$WORK_DIR/oke-prejournal-c.json")" == "applied-after-reread" &&
   "$(jq -r '.obligations[1].result' \
      "$WORK_DIR/oke-prejournal-c.json")" == "already-absent" ]] ||
  fail "pre-journal OKE obligation was lost across B"
python3 - "$CLOUD_DIR/rules.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
rules = json.loads(path.read_text())
rules.append(
    {
        "id": "rule-a",
        "description": (
            "betstan-github-runner run=5000 attempt=1 "
            "expires=1792803600"
        ),
        "source": "198.51.100.10/32",
        "direction": "INGRESS",
        "protocol": "6",
        "source-type": "CIDR_BLOCK",
        "tcp-options": {
            "destination-port-range": {"min": 6443, "max": 6443}
        },
    }
)
path.write_text(json.dumps(rules, sort_keys=True, separators=(",", ":")))
PY

OKE_RECEIPT="$WORK_DIR/oke-lineage-cleanup.json"
run_access oke cleanup-lineage \
  --lineage-file "$LINEAGE_A" \
  --output "$OKE_RECEIPT" >/dev/null
[[ "$(jq -r .obligations[0].result "$OKE_RECEIPT")" == "applied" &&
   "$(jq -r '[.[] | select(.id == "rule-a")] | length' \
      "$CLOUD_DIR/rules.json")" == "0" &&
   "$(jq -r '[.[] | select(.id == "unrelated-rule")] | length' \
      "$CLOUD_DIR/rules.json")" == "1" ]] ||
  fail "OKE predecessor cleanup did not remove only A"

MOCK_READ_MODE=blank-rules-list \
  run_access oke cleanup-lineage \
    --lineage-file "$LINEAGE_A" \
    --output "$WORK_DIR/oke-empty-list.json" >/dev/null
[[ "$(jq -r .obligations[0].result \
      "$WORK_DIR/oke-empty-list.json")" == "already-absent" &&
   "$(jq -r '[.[] | select(.id == "unrelated-rule")] | length' \
      "$CLOUD_DIR/rules.json")" == "1" ]] ||
  fail "OKE blank successful rules list was not treated as absent"

python3 - "$CLOUD_DIR/rules.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
rules = json.loads(path.read_text())
rules.append(
    {
        "id": "rule-b",
        "description": (
            "betstan-github-runner run=5001 attempt=1 "
            "expires=1792807200"
        ),
        "source": "198.51.100.11/32",
        "direction": "INGRESS",
        "protocol": "6",
        "source-type": "CIDR_BLOCK",
        "tcp-options": {
            "destination-port-range": {"min": 6443, "max": 6443}
        },
    }
)
path.write_text(json.dumps(rules, sort_keys=True, separators=(",", ":")))
PY
cat >"$WORK_DIR/oke-current.env" <<EOF
OCI_ENDPOINT_NSG_OCID=$NSG
OCI_RUNNER_RULE_ID=rule-b
OCI_RUNNER_RULE_DESCRIPTION=betstan-github-runner\\ run=5001\\ attempt=1\\ expires=1792807200
OCI_RUNNER_RULE_CIDR=198.51.100.11/32
OCI_RUNNER_RULE_EXPIRES=1792807200
EOF
run_access oke capture \
  --state-file "$WORK_DIR/oke-current.env" \
  --output "$WORK_DIR/oke-current.json" >/dev/null
make_records "$OKE_RECEIPT" "$WORK_DIR/oke-current.json" \
  "$WORK_DIR/oke-records.json"

MOCK_REMOVE_MODE=apply-error run_access oke cleanup-published \
  --records-file "$WORK_DIR/oke-records.json" \
  --current-record-file "$WORK_DIR/oke-current.json" \
  --current-state-file "$WORK_DIR/oke-current.env" \
  --lineage-cleanup-receipt-file "$OKE_RECEIPT" \
  --cleanup-lineage-file "$LINEAGE_A" \
  --output "$WORK_DIR/oke-cleanup.json" >/dev/null
[[ "$(jq -r .allAbsent "$WORK_DIR/oke-cleanup.json")" == "true" &&
   "$(jq -r '[.[] | select(.id == "rule-a" or .id == "rule-b")] | length' \
      "$CLOUD_DIR/rules.json")" == "0" &&
   "$(jq -r '[.[] | select(.id == "unrelated-rule")] | length' \
      "$CLOUD_DIR/rules.json")" == "1" ]] ||
  fail "OKE published cleanup did not reconcile A and B exactly"

run_access oke cleanup-published \
  --records-file "$WORK_DIR/oke-records.json" \
  --current-record-file "$WORK_DIR/oke-current.json" \
  --current-state-file "$WORK_DIR/oke-current.env" \
  --lineage-cleanup-receipt-file "$OKE_RECEIPT" \
  --cleanup-lineage-file "$LINEAGE_A" \
  --output "$WORK_DIR/oke-cleanup-restart.json" >/dev/null
[[ "$(jq -r '[.records[].result] | all(. == "already-absent")' \
    "$WORK_DIR/oke-cleanup-restart.json")" == "true" ]] ||
  fail "OKE cleanup was not restart-idempotent"

set +e
run_access oke cleanup-published \
  --records-file "$WORK_DIR/oke-records.json" \
  --current-record-file "$WORK_DIR/oke-current.json" \
  --current-state-file "$WORK_DIR/missing-oke-current.env" \
  --lineage-cleanup-receipt-file "$OKE_RECEIPT" \
  --cleanup-lineage-file "$LINEAGE_A" \
  --output "$WORK_DIR/should-not-exist.json" \
  >"$WORK_DIR/missing-state.out" 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]] ||
  fail "published OKE cleanup accepted missing current state"

[[ "$(jq -r '[.[] | select(.runId == 5000)] | length' \
    "$WORK_DIR/oke-records.json")" == "1" ]] ||
  fail "journaled OKE A fixture is missing"
python3 - "$CLOUD_DIR/rules.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
rules = json.loads(path.read_text())
rules.append(
    {
        "id": "rule-a",
        "description": (
            "betstan-github-runner run=5000 attempt=1 "
            "expires=1792803600"
        ),
        "source": "198.51.100.10/32",
        "direction": "INGRESS",
        "protocol": "6",
        "source-type": "CIDR_BLOCK",
        "tcp-options": {
            "destination-port-range": {"min": 6443, "max": 6443}
        },
    }
)
path.write_text(json.dumps(rules, sort_keys=True, separators=(",", ":")))
PY
set +e
rm -f "$WORK_DIR/oke-not-applied.json"
MOCK_REMOVE_MODE=not-applied run_access oke cleanup-lineage \
  --lineage-file "$LINEAGE_A" \
  --output "$WORK_DIR/oke-not-applied.json" \
  >"$WORK_DIR/oke-not-applied.out" 2>&1
status=$?
set -e
[[ "$status" -ne 0 &&
   ! -e "$WORK_DIR/oke-not-applied.json" &&
   "$(jq -r '[.[] | select(.id == "rule-a")] | length' \
      "$CLOUD_DIR/rules.json")" == "1" &&
   "$(jq -r '[.[] | select(.id == "rule-b")] | length' \
      "$CLOUD_DIR/rules.json")" == "0" ]] ||
  fail "OKE not-applied removal was not terminal"

rm -f "$WORK_DIR/oke-lineage-c-blocked.json"
set +e
MOCK_REMOVE_MODE=not-applied \
TEST_RESTORE_RUN_ID=5002 \
TEST_CONTROL_SHA="$CONTROL_C" \
TEST_GENERATION=2 \
TEST_PREDECESSOR_RUN_ID=5001 \
TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
  run_access oke cleanup-lineage \
    --lineage-file "$LINEAGE_AB" \
    --output "$WORK_DIR/oke-lineage-c-blocked.json" \
    >"$WORK_DIR/oke-lineage-c-blocked.out" 2>&1
status=$?
set -e
[[ "$status" -ne 0 &&
   ! -e "$WORK_DIR/oke-lineage-c-blocked.json" &&
   "$(jq -r '[.[] | select(.id == "rule-a")] | length' \
      "$CLOUD_DIR/rules.json")" == "1" ]] ||
  fail "OKE continuation C succeeded while A remained"

MOCK_REMOVE_MODE=apply-error \
TEST_RESTORE_RUN_ID=5002 \
TEST_CONTROL_SHA="$CONTROL_C" \
TEST_GENERATION=2 \
TEST_PREDECESSOR_RUN_ID=5001 \
TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
  run_access oke cleanup-lineage \
    --lineage-file "$LINEAGE_AB" \
    --output "$WORK_DIR/oke-lineage-c.json" >/dev/null
[[ "$(jq -r '.obligations[0].result' \
      "$WORK_DIR/oke-lineage-c.json")" == "applied-after-reread" &&
   "$(jq -r '.obligations[1].result' \
      "$WORK_DIR/oke-lineage-c.json")" == "already-absent" &&
   "$(jq -r '[.[] | select(.id == "rule-a" or .id == "rule-b")] | length' \
      "$CLOUD_DIR/rules.json")" == "0" &&
   "$(jq -r '[.[] | select(.id == "unrelated-rule")] | length' \
      "$CLOUD_DIR/rules.json")" == "1" ]] ||
  fail "OKE continuation C forgot A or changed an unrelated rule"

TEST_RESTORE_RUN_ID=5002 \
TEST_CONTROL_SHA="$CONTROL_C" \
TEST_GENERATION=2 \
TEST_PREDECESSOR_RUN_ID=5001 \
TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
  run_access oke cleanup-lineage \
    --lineage-file "$LINEAGE_AB" \
    --output "$WORK_DIR/oke-lineage-c-restart.json" >/dev/null
[[ "$(jq -r '[.obligations[].result] | all(. == "already-absent")' \
      "$WORK_DIR/oke-lineage-c-restart.json")" == "true" ]] ||
  fail "OKE inherited cleanup was not restart-idempotent"

python3 - "$CLOUD_DIR/sessions.json" "$BASTION" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
bastion = sys.argv[2]
sessions = [
    {
        "id": "session-a",
        "bastion-id": bastion,
        "display-name": "betstan-k3s-ssh-5000-1",
        "lifecycle-state": "ACTIVE",
    },
    {
        "id": "unrelated-session",
        "bastion-id": bastion,
        "display-name": "betstan-k3s-ssh-9000-1",
        "lifecycle-state": "ACTIVE",
    },
]
path.write_text(json.dumps(sessions, sort_keys=True, separators=(",", ":")))
PY

# Pre-journal A remains authority-linked when cleanup-only B has no session.
set +e
MOCK_REMOVE_MODE=not-applied run_access k3s cleanup-lineage \
  --lineage-file "$LINEAGE_A" \
  --output "$WORK_DIR/k3s-prejournal-b.json" \
  >"$WORK_DIR/k3s-prejournal-b.out" 2>&1
status=$?
set -e
[[ "$status" -ne 0 &&
   ! -e "$WORK_DIR/k3s-prejournal-b.json" &&
   "$(jq -r '[.[] | select(.id == "session-b")] | length' \
      "$CLOUD_DIR/sessions.json")" == "0" ]] ||
  fail "pre-journal k3s cleanup-only B unexpectedly succeeded"
MOCK_REMOVE_MODE=apply-error \
TEST_RESTORE_RUN_ID=5002 \
TEST_CONTROL_SHA="$CONTROL_C" \
TEST_GENERATION=2 \
TEST_PREDECESSOR_RUN_ID=5001 \
TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
  run_access k3s cleanup-lineage \
    --lineage-file "$LINEAGE_AB" \
    --output "$WORK_DIR/k3s-prejournal-c.json" >/dev/null
[[ "$(jq -r '.obligations[0].result' \
      "$WORK_DIR/k3s-prejournal-c.json")" == "applied-after-reread" &&
   "$(jq -r '.obligations[1].result' \
      "$WORK_DIR/k3s-prejournal-c.json")" == "already-absent" ]] ||
  fail "pre-journal k3s obligation was lost across B"
python3 - "$CLOUD_DIR/sessions.json" "$BASTION" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
sessions = json.loads(path.read_text())
sessions.append(
    {
        "id": "session-a",
        "bastion-id": sys.argv[2],
        "display-name": "betstan-k3s-ssh-5000-1",
        "lifecycle-state": "ACTIVE",
    }
)
path.write_text(json.dumps(sessions, sort_keys=True, separators=(",", ":")))
PY

K3S_RECEIPT="$WORK_DIR/k3s-lineage-cleanup.json"
MOCK_REMOVE_MODE=apply-error run_access k3s cleanup-lineage \
  --lineage-file "$LINEAGE_A" \
  --output "$K3S_RECEIPT" >/dev/null
[[ "$(jq -r .obligations[0].result "$K3S_RECEIPT")" == "applied-after-reread" &&
   "$(jq -r '[.[] | select(.id == "session-a")] | length' \
      "$CLOUD_DIR/sessions.json")" == "0" &&
   "$(jq -r '[.[] | select(.id == "unrelated-session")] | length' \
      "$CLOUD_DIR/sessions.json")" == "1" ]] ||
  fail "k3s predecessor cleanup did not remove only A"

python3 - "$CLOUD_DIR/sessions.json" "$BASTION" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
sessions = json.loads(path.read_text())
sessions.append(
    {
        "id": "session-b",
        "bastion-id": sys.argv[2],
        "display-name": "betstan-k3s-ssh-5001-1",
        "lifecycle-state": "ACTIVE",
    }
)
path.write_text(json.dumps(sessions, sort_keys=True, separators=(",", ":")))
PY
cat >"$WORK_DIR/k3s-current.env" <<EOF
bastion_ocid=$BASTION
ssh_session_id=session-b
ssh_session_name=betstan-k3s-ssh-5001-1
ssh_tunnel_pid=101
api_tunnel_pid=102
key_dir=$WORK_DIR/keys
bastion_endpoint=host.example
target_private_key=$WORK_DIR/target-key
target_known_hosts=$WORK_DIR/known-hosts
instance_ocid=ocid1.instance.oc1.test
instance_private_ip=10.0.0.10
os_user=ubuntu
local_ssh_port=22022
EOF
for read_mode in blank-session-get malformed-session-get; do
  output="$WORK_DIR/k3s-current-${read_mode}.json"
  rm -f "$output"
  if MOCK_READ_MODE="$read_mode" \
    run_access k3s capture \
      --state-file "$WORK_DIR/k3s-current.env" \
      --output "$output" >/dev/null 2>&1; then
    fail "$read_mode unexpectedly produced an incident access record"
  fi
  [[ ! -e "$output" ]] ||
    fail "$read_mode retained a failed incident access record"
done
run_access k3s capture \
  --state-file "$WORK_DIR/k3s-current.env" \
  --output "$WORK_DIR/k3s-current.json" >/dev/null
make_records "$K3S_RECEIPT" "$WORK_DIR/k3s-current.json" \
  "$WORK_DIR/k3s-records.json"

MOCK_REMOVE_MODE=apply-error run_access k3s cleanup-published \
  --records-file "$WORK_DIR/k3s-records.json" \
  --current-record-file "$WORK_DIR/k3s-current.json" \
  --current-state-file "$WORK_DIR/k3s-current.env" \
  --lineage-cleanup-receipt-file "$K3S_RECEIPT" \
  --cleanup-lineage-file "$LINEAGE_A" \
  --output "$WORK_DIR/k3s-cleanup.json" >/dev/null
[[ "$(jq -r .allAbsent "$WORK_DIR/k3s-cleanup.json")" == "true" &&
   "$(jq -r '[.[] | select(.id == "session-a" or .id == "session-b")] | length' \
      "$CLOUD_DIR/sessions.json")" == "0" &&
   "$(jq -r '[.[] | select(.id == "unrelated-session")] | length' \
      "$CLOUD_DIR/sessions.json")" == "1" ]] ||
  fail "k3s published cleanup did not reconcile A and B exactly"

run_access k3s cleanup-published \
  --records-file "$WORK_DIR/k3s-records.json" \
  --current-record-file "$WORK_DIR/k3s-current.json" \
  --current-state-file "$WORK_DIR/k3s-current.env" \
  --lineage-cleanup-receipt-file "$K3S_RECEIPT" \
  --cleanup-lineage-file "$LINEAGE_A" \
  --output "$WORK_DIR/k3s-cleanup-restart.json" >/dev/null
[[ "$(jq -r '[.records[].result] | all(. == "already-absent")' \
    "$WORK_DIR/k3s-cleanup-restart.json")" == "true" ]] ||
  fail "k3s cleanup was not restart-idempotent"

[[ "$(grep -Fc "$BASTION" "$CLOUD_DIR/allowlist-updates.log")" -ge 3 ]] ||
  fail "k3s cleanup did not reset the exact Bastion allowlist"

[[ "$(jq -r '[.[] | select(.runId == 5000)] | length' \
    "$WORK_DIR/k3s-records.json")" == "1" ]] ||
  fail "journaled k3s A fixture is missing"
python3 - "$CLOUD_DIR/sessions.json" "$BASTION" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
sessions = json.loads(path.read_text())
sessions.append(
    {
        "id": "session-a",
        "bastion-id": sys.argv[2],
        "display-name": "betstan-k3s-ssh-5000-1",
        "lifecycle-state": "ACTIVE",
    }
)
path.write_text(json.dumps(sessions, sort_keys=True, separators=(",", ":")))
PY
rm -f "$WORK_DIR/k3s-not-applied.json"
set +e
MOCK_REMOVE_MODE=not-applied run_access k3s cleanup-lineage \
  --lineage-file "$LINEAGE_A" \
  --output "$WORK_DIR/k3s-not-applied.json" \
  >"$WORK_DIR/k3s-not-applied.out" 2>&1
status=$?
set -e
[[ "$status" -ne 0 &&
   ! -e "$WORK_DIR/k3s-not-applied.json" &&
   "$(jq -r '[.[] | select(.id == "session-a")] | length' \
      "$CLOUD_DIR/sessions.json")" == "1" &&
   "$(jq -r '[.[] | select(.id == "session-b")] | length' \
      "$CLOUD_DIR/sessions.json")" == "0" ]] ||
  fail "k3s cleanup-only B did not retain A without opening B"

rm -f "$WORK_DIR/k3s-lineage-c-blocked.json"
set +e
MOCK_REMOVE_MODE=not-applied \
TEST_RESTORE_RUN_ID=5002 \
TEST_CONTROL_SHA="$CONTROL_C" \
TEST_GENERATION=2 \
TEST_PREDECESSOR_RUN_ID=5001 \
TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
  run_access k3s cleanup-lineage \
    --lineage-file "$LINEAGE_AB" \
    --output "$WORK_DIR/k3s-lineage-c-blocked.json" \
    >"$WORK_DIR/k3s-lineage-c-blocked.out" 2>&1
status=$?
set -e
[[ "$status" -ne 0 &&
   ! -e "$WORK_DIR/k3s-lineage-c-blocked.json" &&
   "$(jq -r '[.[] | select(.id == "session-a")] | length' \
      "$CLOUD_DIR/sessions.json")" == "1" ]] ||
  fail "k3s continuation C succeeded while A remained"

MOCK_REMOVE_MODE=apply-error \
TEST_RESTORE_RUN_ID=5002 \
TEST_CONTROL_SHA="$CONTROL_C" \
TEST_GENERATION=2 \
TEST_PREDECESSOR_RUN_ID=5001 \
TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
  run_access k3s cleanup-lineage \
    --lineage-file "$LINEAGE_AB" \
    --output "$WORK_DIR/k3s-lineage-c.json" >/dev/null
[[ "$(jq -r '.obligations[0].result' \
      "$WORK_DIR/k3s-lineage-c.json")" == "applied-after-reread" &&
   "$(jq -r '.obligations[1].result' \
      "$WORK_DIR/k3s-lineage-c.json")" == "already-absent" &&
   "$(jq -r '[.[] | select(.id == "session-a" or .id == "session-b")] | length' \
      "$CLOUD_DIR/sessions.json")" == "0" &&
   "$(jq -r '[.[] | select(.id == "unrelated-session")] | length' \
      "$CLOUD_DIR/sessions.json")" == "1" ]] ||
  fail "k3s continuation C forgot A or changed an unrelated session"

TEST_RESTORE_RUN_ID=5002 \
TEST_CONTROL_SHA="$CONTROL_C" \
TEST_GENERATION=2 \
TEST_PREDECESSOR_RUN_ID=5001 \
TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
  run_access k3s cleanup-lineage \
    --lineage-file "$LINEAGE_AB" \
    --output "$WORK_DIR/k3s-lineage-c-restart.json" >/dev/null
[[ "$(jq -r '[.obligations[].result] | all(. == "already-absent")' \
      "$WORK_DIR/k3s-lineage-c-restart.json")" == "true" ]] ||
  fail "k3s inherited cleanup was not restart-idempotent"

MOCK_EMPTY_SESSION_NAME=betstan-k3s-ssh-5001-1 \
TEST_RESTORE_RUN_ID=5002 \
TEST_CONTROL_SHA="$CONTROL_C" \
TEST_GENERATION=2 \
TEST_PREDECESSOR_RUN_ID=5001 \
TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
  run_access k3s cleanup-lineage \
    --lineage-file "$LINEAGE_AB" \
    --output "$WORK_DIR/k3s-lineage-c-empty-list.json" >/dev/null
[[ "$(jq -r '[.obligations[].result] | all(. == "already-absent")' \
      "$WORK_DIR/k3s-lineage-c-empty-list.json")" == "true" &&
   "$(jq -r '[.[] | select(.id == "unrelated-session")] | length' \
      "$CLOUD_DIR/sessions.json")" == "1" ]] ||
  fail "k3s blank successful session list was not treated as absent"

for read_mode in malformed-session-list failed-session-list; do
  output="$WORK_DIR/k3s-lineage-c-${read_mode}.json"
  rm -f "$output"
  if MOCK_READ_MODE="$read_mode" \
    TEST_RESTORE_RUN_ID=5002 \
    TEST_CONTROL_SHA="$CONTROL_C" \
    TEST_GENERATION=2 \
    TEST_PREDECESSOR_RUN_ID=5001 \
    TEST_PREDECESSOR_CONTROL_SHA="$CONTROL_B" \
    TEST_PREDECESSOR_AUTHORITY_SHA256="$AUTHORITY_B" \
      run_access k3s cleanup-lineage \
        --lineage-file "$LINEAGE_AB" \
        --output "$output" >/dev/null 2>&1; then
    fail "$read_mode unexpectedly produced a cleanup receipt"
  fi
  [[ ! -e "$output" ]] ||
    fail "$read_mode retained a failed cleanup receipt"
done

echo "incident_access_tests=PASS"
