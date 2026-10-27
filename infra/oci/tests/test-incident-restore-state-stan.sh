#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/scripts/incident_restore_state_stan.py"
WORK_PARENT="$ROOT_DIR/infra/oci/tests/.incident-restore-state-workdirs"
mkdir -p "$WORK_PARENT"
WORK_DIR="$(mktemp -d "$WORK_PARENT/test.XXXXXX")"
STATE_DIR="$WORK_DIR/state"
BIN_DIR="$WORK_DIR/bin"
mkdir -p "$STATE_DIR" "$BIN_DIR"

cleanup() {
  rm -rf -- "$WORK_DIR"
  rmdir "$WORK_PARENT" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "incident restore state test failed: $*" >&2
  exit 1
}

cat >"$BIN_DIR/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

state="${STUB_STATE_DIR:?}"
lock_name="gaming-mongo-migration-lock"
journal_name="gaming-oci-live-data-incident-restore"

path_for() {
  case "$1" in
    "$lock_name") printf '%s/lock.json' "$state" ;;
    "$journal_name") printf '%s/journal.json' "$state" ;;
    *) exit 2 ;;
  esac
}

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" ]]; then
  path="$(path_for "${3:-}")"
  if [[ ! -f "$path" ]]; then
    echo "Error from server (NotFound): configmaps \"${3:-}\" not found" >&2
    exit 1
  fi
  cat "$path"
  exit 0
fi

if [[ "${1:-}" == "create" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  input="$(cat)"
  name="$(jq -r '.metadata.name' <<<"$input")"
  path="$(path_for "$name")"
  [[ ! -f "$path" ]] || {
    echo "Error from server (AlreadyExists)" >&2
    exit 1
  }
  jq '.metadata.uid = "incident-state-uid" |
      .metadata.resourceVersion = "1"' <<<"$input" >"$path"
  if [[ "${STUB_CREATE_MODE:-}" == "apply-then-fail" ]]; then
    echo "uncertain create" >&2
    exit 1
  fi
  exit 0
fi

if [[ "${1:-}" == "replace" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  input="$(cat)"
  name="$(jq -r '.metadata.name' <<<"$input")"
  path="$(path_for "$name")"
  [[ -f "$path" ]] || exit 1
  if [[ "${STUB_REPLACE_MODE:-}" == "fail" ]]; then
    echo "replace conflict" >&2
    exit 1
  fi
  current_version="$(jq -r '.metadata.resourceVersion' "$path")"
  input_version="$(jq -r '.metadata.resourceVersion' <<<"$input")"
  [[ "$current_version" == "$input_version" ]] || {
    echo "resourceVersion conflict" >&2
    exit 1
  }
  jq --arg version "$((current_version + 1))" \
    '.metadata.resourceVersion = $version' <<<"$input" >"$path"
  if [[ "${STUB_REPLACE_MODE:-}" == "apply-then-fail" ]]; then
    echo "uncertain replace" >&2
    exit 1
  fi
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 2
SH
chmod +x "$BIN_DIR/kubectl"

MANIFEST="$(printf '7%.0s' {1..64})"
CONTROL_A="$(printf 'a%.0s' {1..40})"
CONTROL_B="$(printf 'b%.0s' {1..40})"
CONTROL_C="$(printf 'c%.0s' {1..40})"
CONTROL_D="$(printf 'd%.0s' {1..40})"
CONTROL_X="$(printf 'e%.0s' {1..40})"
OWNER=39945618182
HELD_SOURCE=70679a6179df2167cb39f185cb0c26dca2ce649d
JOURNAL_IDENTITY_JSON='{"fixedJournal":"held-owner-39945618182"}'
JOURNAL_IDENTITY_SHA="$(
  python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' \
    "$JOURNAL_IDENTITY_JSON"
)"

python3 - \
  "$STATE_DIR" "$MANIFEST" "$OWNER" "$HELD_SOURCE" \
  "$CONTROL_A" "$CONTROL_B" "$CONTROL_C" "$CONTROL_D" \
  "$JOURNAL_IDENTITY_SHA" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

(
    root_raw,
    manifest,
    owner,
    held_source,
    control_a,
    control_b,
    control_c,
    control_d,
    journal,
) = sys.argv[1:]
root = Path(root_raw)


def write(name, value):
    (root / name).write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def document(version, data):
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": "gaming-mongo-migration-lock",
            "namespace": "betstan-oci",
            "uid": "lock-uid",
            "resourceVersion": str(version),
        },
        "data": data,
    }


held = document(
    10,
    {
        "state": "active",
        "holder": "live-data-39945618182-1",
        "operation-id": "live-data-apply-slip-index",
        "source-sha": held_source,
        "acquired-at-epoch": "1792761824",
        "lease-duration-seconds": "7200",
        "lease-until-epoch": "1792769419",
        "released-at-epoch": "0",
        "fencing-generation": "519",
    },
)


def active(version, run, control, acquired, generation, predecessor_cutoff):
    lease_until = acquired + 7200
    return document(
        version,
        {
            "state": "active",
            "holder": f"live-data-incident-{run}-1",
            "operation-id": "live-data-incident-restore",
            "source-sha": control,
            "acquired-at-epoch": str(acquired),
            "lease-duration-seconds": "7200",
            "lease-until-epoch": str(lease_until),
            "released-at-epoch": "0",
            "fencing-generation": str(generation),
            "incident-manifest-sha256": manifest,
            "incident-owner-run-id": owner,
            "incident-restore-run-id": str(run),
            "incident-control-sha": control,
            "incident-current-run-metadata-sha256": hashlib.sha256(
                f"run-{run}".encode()
            ).hexdigest(),
            "incident-request-created-at-epoch": str(
                predecessor_cutoff + 1
            ),
            "incident-provider-transition-epoch": str(acquired),
            "incident-predecessor-lease-until-epoch": str(
                predecessor_cutoff
            ),
            "incident-new-lease-until-epoch": str(lease_until),
        },
    )


active_a = active(11, 5000, control_a, 1792769420, 520, 1792769419)
active_b = active(12, 5001, control_b, 1792776621, 521, 1792776620)
active_c = active(13, 5002, control_c, 1792783822, 522, 1792783821)
active_d = active(14, 5003, control_d, 1792791023, 523, 1792791022)
released_d = document(
    15,
    {
        "state": "released",
        "holder": "",
        "operation-id": "live-data-incident-restore",
        "source-sha": control_d,
        "acquired-at-epoch": "1792791023",
        "lease-duration-seconds": "0",
        "lease-until-epoch": "0",
        "released-at-epoch": "1792791200",
        "fencing-generation": "524",
    },
)


def access(run, control, generation):
    return {
        "schemaVersion": "betstan.oci-live-data-incident-access.v1",
        "runtimeMode": "k3s",
        "manifestSha256": manifest,
        "ownerRunId": int(owner),
        "journalIdentitySha256": journal,
        "runId": run,
        "runAttempt": 1,
        "controlSha": control,
        "authorityGeneration": generation,
        "resource": {
            "kind": "k3s-bastion-session",
            "bastionOcid": "ocid1.bastion.oc1.test",
            "sessionId": f"session-{run}",
            "sessionName": f"betstan-k3s-ssh-{run}-1",
        },
    }


for name, value in (
    ("held.json", held),
    ("active-a.json", active_a),
    ("active-b.json", active_b),
    ("active-c.json", active_c),
    ("active-d.json", active_d),
    ("released-d.json", released_d),
    ("access-a.json", access(5000, control_a, 0)),
    ("access-b.json", access(5001, control_b, 1)),
    ("access-c.json", access(5002, control_c, 2)),
    ("access-d.json", access(5003, control_d, 3)),
):
    write(name, value)
write("lock.json", held)
PY

write_handoff() {
  local from="$1"
  local to="$2"
  local output="$3"
  python3 - \
    "$from" "$to" "$MANIFEST" "$JOURNAL_IDENTITY_JSON" \
    "$JOURNAL_IDENTITY_SHA" "$output" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

from_control, to_control, manifest, identity_raw, identity_sha, output = sys.argv[1:]
identity = json.loads(identity_raw)
proof = {
    "schemaVersion": "betstan.oci-live-data-incident-control-handoff.v1",
    "fromControlSha": from_control,
    "toControlSha": to_control,
    "relation": "same" if from_control == to_control else "descendant",
    "manifestSha256": manifest,
    "journalIdentity": identity,
    "journalIdentitySha256": identity_sha,
    "imageInputs": "unchanged",
}
raw = json.dumps(proof, sort_keys=True, separators=(",", ":"))
proof["proofSha256"] = hashlib.sha256(raw.encode()).hexdigest()
Path(output).write_text(
    json.dumps(proof, sort_keys=True, separators=(",", ":")),
    encoding="utf-8",
)
PY
}

write_handoff "$CONTROL_A" "$CONTROL_B" "$WORK_DIR/handoff-a-b.json"
write_handoff "$CONTROL_A" "$CONTROL_C" "$WORK_DIR/handoff-a-c.json"
write_handoff "$CONTROL_B" "$CONTROL_C" "$WORK_DIR/handoff-b-c.json"
write_handoff "$CONTROL_C" "$CONTROL_D" "$WORK_DIR/handoff-c-d.json"
write_handoff "$CONTROL_A" "$CONTROL_D" "$WORK_DIR/handoff-a-d.json"

run_state() {
  local run_id="$1"
  local control="$2"
  local generation="$3"
  local fence="$4"
  local access_file="$5"
  shift 5
  local -a extra_env=(INCIDENT_STATE_TEST=1)
  while [[ "${1:-}" == *=* ]]; do
    extra_env+=("$1")
    shift
  done
  PATH="$BIN_DIR:$PATH" \
  STUB_STATE_DIR="$STATE_DIR" \
  OCI_K8S_NAMESPACE=betstan-oci \
  INCIDENT_MANIFEST_SHA256="$MANIFEST" \
  INCIDENT_OWNER_RUN_ID="$OWNER" \
  INCIDENT_RESTORE_RUN_ID="$run_id" \
  INCIDENT_RUN_ATTEMPT=1 \
  INCIDENT_CONTROL_SHA="$control" \
  INCIDENT_JOURNAL_IDENTITY_SHA256="$JOURNAL_IDENTITY_SHA" \
  INCIDENT_CONTINUATION_GENERATION="$generation" \
  INCIDENT_LOCK_LEASE_SECONDS=7200 \
  INCIDENT_ACCESS_RECORD_FILE="$access_file" \
  OBSERVED_FENCE_STATUS="$fence" \
  NOW_EPOCH=1792800000 \
  HELD_LOCK_UID=lock-uid \
  HELD_RESOURCE_VERSION=10 \
  HELD_LOCK_HOLDER=live-data-39945618182-1 \
  HELD_LOCK_OPERATION_ID=live-data-apply-slip-index \
  HELD_LOCK_SOURCE_SHA="$HELD_SOURCE" \
  HELD_ACQUIRED_AT_EPOCH=1792761824 \
  HELD_LEASE_DURATION_SECONDS=7200 \
  HELD_LEASE_UNTIL_EPOCH=1792769419 \
  HELD_RELEASED_AT_EPOCH=0 \
  HELD_FENCING_GENERATION=519 \
    env "${extra_env[@]}" "$SCRIPT" "$@"
}

assert_no_journal_rejection() {
  local fixture="$1"
  local fence="${2:-true}"
  cp "$WORK_DIR/$fixture.json" "$STATE_DIR/lock.json"
  rm -f -- "$STATE_DIR/journal.json"
  set +e
  run_state 5000 "$CONTROL_A" 0 "$fence" "$STATE_DIR/access-a.json" \
    classify >"$WORK_DIR/$fixture.out" 2>&1
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    fail "invalid held successor was accepted: $fixture"
  fi
  [[ ! -e "$STATE_DIR/journal.json" ]] ||
    fail "invalid held successor created a journal: $fixture"
}

cp "$STATE_DIR/active-a.json" "$WORK_DIR/active-a-valid.json"
jq '.metadata.uid = "changed-lock-uid"' \
  "$WORK_DIR/active-a-valid.json" >"$WORK_DIR/first-changed-uid.json"
jq '.metadata.resourceVersion = "10"' \
  "$WORK_DIR/active-a-valid.json" >"$WORK_DIR/first-equal-version.json"
jq '.metadata.resourceVersion = "9"' \
  "$WORK_DIR/active-a-valid.json" >"$WORK_DIR/first-lower-version.json"
jq '.data["fencing-generation"] = "521"' \
  "$WORK_DIR/active-a-valid.json" >"$WORK_DIR/first-skipped-generation.json"
jq '
  .data["acquired-at-epoch"] = "1792769418" |
  .data["lease-until-epoch"] = "1792776618" |
  .data["incident-provider-transition-epoch"] = "1792769418" |
  .data["incident-new-lease-until-epoch"] = "1792776618"
' "$WORK_DIR/active-a-valid.json" >"$WORK_DIR/first-pre-expiry.json"
jq '
  .data["lease-duration-seconds"] = "7100" |
  .data["lease-until-epoch"] =
    ((.data["acquired-at-epoch"] | tonumber) + 7100 | tostring) |
  .data["incident-new-lease-until-epoch"] =
    .data["lease-until-epoch"]
' "$WORK_DIR/active-a-valid.json" >"$WORK_DIR/first-wrong-duration.json"
jq '.data["incident-request-created-at-epoch"] = "1792769419"' \
  "$WORK_DIR/active-a-valid.json" >"$WORK_DIR/first-request-equality.json"
jq '.data["incident-predecessor-lease-until-epoch"] = "1792769418"' \
  "$WORK_DIR/active-a-valid.json" >"$WORK_DIR/first-wrong-cutoff.json"
jq '.data["incident-current-run-metadata-sha256"] = "invalid"' \
  "$WORK_DIR/active-a-valid.json" >"$WORK_DIR/first-wrong-run-metadata.json"

for rejected in \
  first-changed-uid \
  first-equal-version \
  first-lower-version \
  first-skipped-generation \
  first-pre-expiry \
  first-wrong-duration \
  first-request-equality \
  first-wrong-cutoff \
  first-wrong-run-metadata
do
  assert_no_journal_rejection "$rejected"
done
assert_no_journal_rejection active-a-valid false

cp "$STATE_DIR/held.json" "$STATE_DIR/lock.json"
classification="$(
  run_state 5000 "$CONTROL_A" 0 true "$STATE_DIR/access-a.json" classify
)"
[[ "$(jq -r .classification <<<"$classification")" == "held-predecessor" ]] ||
  fail "held predecessor was not classified"

cp "$STATE_DIR/active-a.json" "$STATE_DIR/lock.json"
classification="$(
  run_state 5001 "$CONTROL_B" 1 true "$STATE_DIR/access-b.json" \
    INCIDENT_CONTINUATION_RUN_ID=5000 \
    INCIDENT_CONTINUATION_CONTROL_SHA="$CONTROL_A" \
    classify
)"
[[ "$(jq -r .classification <<<"$classification")" == \
  "incident-active-successor-fenced" ]] ||
  fail "no-journal active successor was not classified"
run_state 5001 "$CONTROL_B" 1 true "$STATE_DIR/access-b.json" \
  INCIDENT_CONTINUATION_RUN_ID=5000 \
  INCIDENT_CONTINUATION_CONTROL_SHA="$CONTROL_A" \
  adopt-active "$STATE_DIR/active-a.json" >/dev/null
[[ "$(jq -r '.data["control-sha"]' "$STATE_DIR/journal.json")" == \
  "$CONTROL_A" ]] || fail "no-journal active successor was not adopted"

rm -f -- "$STATE_DIR/journal.json"
cp "$STATE_DIR/active-a.json" "$STATE_DIR/lock.json"
run_state 5000 "$CONTROL_A" 0 true "$STATE_DIR/access-a.json" \
  STUB_CREATE_MODE=apply-then-fail \
  record-active "$STATE_DIR/active-a.json" >/dev/null
[[ "$(jq -r '.data.phase' "$STATE_DIR/journal.json")" == \
  "incident-active-fenced" ]] ||
  fail "first exact active successor was not recorded"

run_state 5001 "$CONTROL_B" 1 true "$STATE_DIR/access-b.json" \
  INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_A" \
  INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-a-b.json" \
  record-access "$STATE_DIR/access-b.json" >/dev/null
cp "$STATE_DIR/journal.json" "$WORK_DIR/journal-a-with-b-access.json"

cp "$STATE_DIR/active-b.json" "$STATE_DIR/lock.json"
cp "$STATE_DIR/journal.json" "$WORK_DIR/journal-before-control-rejections.json"
set +e
run_state 5002 "$CONTROL_C" 2 true "$STATE_DIR/access-c.json" \
    INCIDENT_CONTINUATION_RUN_ID=5001 \
    INCIDENT_CONTINUATION_CONTROL_SHA="$CONTROL_B" \
    INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_A" \
    INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-a-d.json" \
    classify >"$WORK_DIR/substituted-proof.out" 2>&1
status=$?
set -e
if [[ "$status" -eq 0 ]]; then
  fail "substituted journal-control proof was accepted"
fi
cmp -s "$STATE_DIR/journal.json" \
  "$WORK_DIR/journal-before-control-rejections.json" ||
  fail "substituted journal-control proof changed the journal"
set +e
run_state 5002 "$CONTROL_C" 2 true "$STATE_DIR/access-c.json" \
    INCIDENT_CONTINUATION_RUN_ID=5001 \
    INCIDENT_CONTINUATION_CONTROL_SHA="$CONTROL_X" \
    INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_A" \
    INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-a-c.json" \
    classify >"$WORK_DIR/substituted-successor.out" 2>&1
status=$?
set -e
if [[ "$status" -eq 0 ]]; then
  fail "unrelated successor control was accepted"
fi
cmp -s "$STATE_DIR/journal.json" \
  "$WORK_DIR/journal-before-control-rejections.json" ||
  fail "unrelated successor control changed the journal"

cp "$STATE_DIR/active-b.json" "$WORK_DIR/active-b-valid.json"
jq '
  .data["acquired-at-epoch"] = "1792776618" |
  .data["lease-until-epoch"] = "1792783818"
' "$WORK_DIR/active-b-valid.json" >"$WORK_DIR/b-predecessor-unexpired.json"
cp "$WORK_DIR/b-predecessor-unexpired.json" "$STATE_DIR/lock.json"
set +e
run_state 5002 "$CONTROL_C" 2 true "$STATE_DIR/access-c.json" \
    INCIDENT_CONTINUATION_RUN_ID=5001 \
    INCIDENT_CONTINUATION_CONTROL_SHA="$CONTROL_B" \
    INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_A" \
    INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-a-c.json" \
    classify >"$WORK_DIR/b-predecessor-unexpired.out" 2>&1
status=$?
set -e
if [[ "$status" -eq 0 ]]; then
  fail "predecessor-unexpired successor was accepted"
fi

cp "$STATE_DIR/active-b.json" "$STATE_DIR/lock.json"
classification="$(
  run_state 5002 "$CONTROL_C" 2 true "$STATE_DIR/access-c.json" \
    INCIDENT_CONTINUATION_RUN_ID=5001 \
    INCIDENT_CONTINUATION_CONTROL_SHA="$CONTROL_B" \
    INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_A" \
    INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-a-c.json" \
    classify
)"
[[ "$(jq -r .classification <<<"$classification")" == \
    "incident-active-successor-fenced" &&
   "$(jq -r .successorControlSha <<<"$classification")" == \
    "$CONTROL_B" ]] ||
  fail "A journal to B active successor was not classified"
run_state 5002 "$CONTROL_C" 2 true "$STATE_DIR/access-c.json" \
  INCIDENT_CONTINUATION_RUN_ID=5001 \
  INCIDENT_CONTINUATION_CONTROL_SHA="$CONTROL_B" \
  INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_A" \
  INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-a-c.json" \
  adopt-active "$STATE_DIR/active-b.json" >/dev/null
[[ "$(jq -r '.data["control-sha"]' "$STATE_DIR/journal.json")" == \
    "$CONTROL_B" &&
   "$(jq -r '.data["operation-run-id"]' "$STATE_DIR/journal.json")" == \
    "5001" ]] ||
  fail "authority-derived B successor was not adopted"

cp "$STATE_DIR/active-c.json" "$STATE_DIR/lock.json"
run_state 5002 "$CONTROL_C" 2 true "$STATE_DIR/access-c.json" \
  INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_B" \
  INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-b-c.json" \
  record-active "$STATE_DIR/active-c.json" >/dev/null
[[ "$(jq -r '.data["control-sha"]' "$STATE_DIR/journal.json")" == \
    "$CONTROL_C" &&
   "$(jq -r '.data["operation-run-id"]' "$STATE_DIR/journal.json")" == \
    "5002" ]] ||
  fail "B to C CAS successor was not recorded after control rebinding"

classification="$(
  run_state 5003 "$CONTROL_D" 3 true "$STATE_DIR/access-d.json" \
    INCIDENT_CONTINUATION_RUN_ID=5002 \
    INCIDENT_CONTINUATION_CONTROL_SHA="$CONTROL_C" \
    INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_C" \
    INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-c-d.json" \
    classify
)"
[[ "$(jq -r .classification <<<"$classification")" == \
  "incident-active-fenced" ]] ||
  fail "C predecessor was not classified before the D CAS"
run_state 5003 "$CONTROL_D" 3 true "$STATE_DIR/access-d.json" \
  INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_C" \
  INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-c-d.json" \
  record-access "$STATE_DIR/access-d.json" >/dev/null
cp "$STATE_DIR/active-d.json" "$STATE_DIR/lock.json"
run_state 5003 "$CONTROL_D" 3 true "$STATE_DIR/access-d.json" \
  INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA="$CONTROL_C" \
  INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE="$WORK_DIR/handoff-c-d.json" \
  record-active "$STATE_DIR/active-d.json" >/dev/null
[[ "$(jq -r '.data["control-sha"]' "$STATE_DIR/journal.json")" == \
    "$CONTROL_D" &&
   "$(jq -r '.data["access-records-json"] | fromjson | length' \
      "$STATE_DIR/journal.json")" == "4" ]] ||
  fail "C to D CAS successor or access lineage was not recorded"

cp "$STATE_DIR/released-d.json" "$STATE_DIR/lock.json"
classification="$(
  run_state 5003 "$CONTROL_D" 3 true "$STATE_DIR/access-d.json" classify
)"
[[ "$(jq -r .classification <<<"$classification")" == \
  "released-fenced-recovery" ]] ||
  fail "release-response crash was not classified"
run_state 5003 "$CONTROL_D" 3 true "$STATE_DIR/access-d.json" \
  record-released "$STATE_DIR/released-d.json" >/dev/null
classification="$(
  run_state 5003 "$CONTROL_D" 3 true "$STATE_DIR/access-d.json" classify
)"
[[ "$(jq -r .classification <<<"$classification")" == "released-fenced" ]] ||
  fail "released fenced continuation was not classified"

classification="$(
  run_state 5003 "$CONTROL_D" 3 false "$STATE_DIR/access-d.json" classify
)"
[[ "$(jq -r .classification <<<"$classification")" == \
  "released-unfenced-recovery" ]] ||
  fail "fence-release crash was not classified"
run_state 5003 "$CONTROL_D" 3 false "$STATE_DIR/access-d.json" \
  record-unfenced >/dev/null

READINESS="$(printf '9%.0s' {1..64})"
EVIDENCE="$(printf '6%.0s' {1..64})"
run_state 5003 "$CONTROL_D" 3 false "$STATE_DIR/access-d.json" \
  READINESS_SHA256="$READINESS" \
  STUB_REPLACE_MODE=apply-then-fail \
  record-readiness >/dev/null
[[ "$(jq -r '.data.phase' "$STATE_DIR/journal.json")" == \
  "readiness-captured" ]] ||
  fail "uncertain readiness transition did not recognize its postimage"
run_state 5003 "$CONTROL_D" 3 false "$STATE_DIR/access-d.json" \
  EVIDENCE_SHA256="$EVIDENCE" record-sealed >/dev/null
cp "$STATE_DIR/journal.json" "$WORK_DIR/journal-before-failed-replace.json"
set +e
run_state 5003 "$CONTROL_D" 3 false "$STATE_DIR/access-d.json" \
    STUB_REPLACE_MODE=fail \
    record-published >"$WORK_DIR/not-applied.out" 2>&1
status=$?
set -e
if [[ "$status" -eq 0 ]]; then
  fail "not-applied journal replacement was accepted"
fi
cmp -s "$STATE_DIR/journal.json" \
  "$WORK_DIR/journal-before-failed-replace.json" ||
  fail "not-applied journal replacement changed the preimage"
grep -Fq 'no retry is permitted' "$WORK_DIR/not-applied.out" ||
  fail "not-applied journal replacement was not terminal"
run_state 5003 "$CONTROL_D" 3 false "$STATE_DIR/access-d.json" \
  record-published >/dev/null
classification="$(
  run_state 5003 "$CONTROL_D" 3 false "$STATE_DIR/access-d.json" classify
)"
[[ "$(jq -r .classification <<<"$classification")" == "published" ]] ||
  fail "published incident state was not terminal"

echo "incident_restore_state_tests=PASS"
