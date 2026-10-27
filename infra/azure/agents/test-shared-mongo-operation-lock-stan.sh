#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCK_SCRIPT="$ROOT_DIR/infra/azure/agents/shared-mongo-operation-lock-stan.sh"
WORK_DIR="$(mktemp -d "$ROOT_DIR/.shared-mongo-operation-lock.XXXXXX")"
STATE_FILE="$WORK_DIR/configmap.json"
GET_COUNT_FILE="$WORK_DIR/get-count"
REPLACE_COUNT_FILE="$WORK_DIR/replace-count"
SHA_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

fail() {
  echo "shared_mongo_operation_lock_tests=FAIL reason=$*" >&2
  exit 1
}

mkdir -p "$WORK_DIR/bin"
cat >"$WORK_DIR/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

state_file="${STUB_STATE_FILE:?}"
count_file="${STUB_GET_COUNT_FILE:?}"

if [[ "${1:-}" == "create" && "${2:-}" == "configmap" ]]; then
  shift 2
  name="${1:?}"
  shift
  if [[ -f "$state_file" ]]; then
    echo "Error from server (AlreadyExists): configmaps \"$name\" already exists" >&2
    exit 1
  fi
  namespace="default"
  literals=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--namespace)
        namespace="$2"
        shift 2
        ;;
      --from-literal=*)
        literals+=("${1#--from-literal=}")
        shift
        ;;
      *)
        shift
        ;;
    esac
  done
  python3 - "$state_file" "$name" "$namespace" "${literals[@]}" <<'PY'
import json
import sys

path = sys.argv[1]
name = sys.argv[2]
namespace = sys.argv[3]
data = {}
for literal in sys.argv[4:]:
    key, value = literal.split("=", 1)
    data[key] = value
document = {
    "apiVersion": "v1",
    "kind": "ConfigMap",
    "metadata": {
        "name": name,
        "namespace": namespace,
        "uid": "fixture-lock-uid",
        "resourceVersion": "1",
    },
    "data": data,
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(document, fh)
PY
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" ]]; then
  if [[ ! -f "$state_file" ]]; then
    echo "Error from server (NotFound): configmaps \"missing\" not found" >&2
    exit 1
  fi

  count=0
  if [[ -f "$count_file" ]]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s\n' "$count" >"$count_file"
  if [[ "${STUB_FAIL_GET_NUMBER:-}" == "$count" ]]; then
    echo "simulated lock read failure" >&2
    exit 1
  fi

  if [[ -n "${STUB_SIMULATE_RENEW_ON_GET:-}" &&
    "$count" == "$STUB_SIMULATE_RENEW_ON_GET" ]]; then
    python3 - "$state_file" <<'PY'
import json
import os
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    document = json.load(fh)

data = document.setdefault("data", {})
data["state"] = "active"
data["holder"] = os.environ["STUB_SIMULATE_RENEW_HOLDER"]
data["operation-id"] = os.environ["STUB_SIMULATE_RENEW_OPERATION"]
data["source-sha"] = os.environ["STUB_SIMULATE_RENEW_SOURCE_SHA"]
data["acquired-at-epoch"] = os.environ["STUB_SIMULATE_RENEW_ACQUIRED_AT"]
data["lease-duration-seconds"] = os.environ["STUB_SIMULATE_RENEW_LEASE_DURATION"]
data["lease-until-epoch"] = os.environ["STUB_SIMULATE_RENEW_LEASE_UNTIL"]
data["released-at-epoch"] = "0"
data["fencing-generation"] = os.environ["STUB_SIMULATE_RENEW_GENERATION"]
document.setdefault("metadata", {})
document["metadata"]["resourceVersion"] = str(
    int(document["metadata"].get("resourceVersion", "1")) + 1
)

with open(path, "w", encoding="utf-8") as fh:
    json.dump(document, fh)
PY
  fi

  if [[ "${STUB_SIMULATE_UID_ON_GET:-}" == "$count" ||
        "${STUB_SIMULATE_VERSION_ON_GET:-}" == "$count" ]]; then
    python3 - "$state_file" "$count" <<'PY'
import json
import os
import sys

path, count = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    document = json.load(handle)
if os.environ.get("STUB_SIMULATE_UID_ON_GET") == count:
    document["metadata"]["uid"] = "recreated-lock-uid"
if os.environ.get("STUB_SIMULATE_VERSION_ON_GET") == count:
    document["metadata"]["resourceVersion"] = str(
        int(document["metadata"]["resourceVersion"]) + 1
    )
with open(path, "w", encoding="utf-8") as handle:
    json.dump(document, handle)
PY
  fi

  cat "$state_file"
  exit 0
fi

if [[ "${1:-}" == "replace" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  replace_count_file="${STUB_REPLACE_COUNT_FILE:?}"
  replace_count=0
  [[ ! -f "$replace_count_file" ]] || replace_count="$(cat "$replace_count_file")"
  printf '%s\n' "$((replace_count + 1))" >"$replace_count_file"
  if [[ "${STUB_FAIL_REPLACE:-}" == "true" ]]; then
    cat >/dev/null
    echo "simulated resourceVersion conflict" >&2
    exit 1
  fi
  replacement="$state_file.replacement.$$"
  umask 077
  : >"$replacement"
  cat >"$replacement"
  python3 - "$state_file" "$replacement" <<'PY'
import json
import sys

state_path = sys.argv[1]
replacement_path = sys.argv[2]
with open(state_path, "r", encoding="utf-8") as fh:
    current = json.load(fh)
with open(replacement_path, "r", encoding="utf-8") as fh:
    replacement = json.load(fh)

if replacement.get("metadata", {}).get("resourceVersion") != current.get("metadata", {}).get("resourceVersion"):
    raise SystemExit("resourceVersion conflict")

replacement.setdefault("metadata", {})["resourceVersion"] = str(
    int(current["metadata"]["resourceVersion"]) + 1
)
with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(replacement, fh)
PY
  rm -f "$replacement"
  if [[ "${STUB_REPLACE_MODE:-}" == "apply-then-fail" ]]; then
    echo "simulated uncertain replace response" >&2
    exit 1
  fi
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 1
STUB
chmod +x "$WORK_DIR/bin/kubectl"

run_lock() {
  PATH="$WORK_DIR/bin:$PATH" \
  STUB_STATE_FILE="$STATE_FILE" \
  STUB_GET_COUNT_FILE="$GET_COUNT_FILE" \
  STUB_REPLACE_COUNT_FILE="$REPLACE_COUNT_FILE" \
    env "$@"
}

run_lock_case() {
  local holder="$1"
  local operation="$2"
  local source_sha="$3"
  local lock_var="LOCK_TOKEN"
  local operation_var="OPERATION_ID"
  local source_var="SOURCE_SHA"
  shift 3
  run_lock \
    "${lock_var}=$holder" \
    "${operation_var}=$operation" \
    "${source_var}=$source_sha" \
    "$@"
}

reset_get_counter() {
  rm -f -- "$GET_COUNT_FILE" "$REPLACE_COUNT_FILE"
}

write_lock_document() {
  local state="$1"
  local holder="$2"
  local operation_id="$3"
  local source_sha="$4"
  local acquired_at_epoch="$5"
  local lease_duration_seconds="$6"
  local lease_until_epoch="$7"
  local released_at_epoch="$8"
  local fencing_generation="$9"
  local resource_version="${10:-1}"
  python3 - \
    "$STATE_FILE" \
    "$state" \
    "$holder" \
    "$operation_id" \
    "$source_sha" \
    "$acquired_at_epoch" \
    "$lease_duration_seconds" \
    "$lease_until_epoch" \
    "$released_at_epoch" \
    "$fencing_generation" \
    "$resource_version" <<'PY'
import json
import sys

(
    path,
    state,
    holder,
    operation_id,
    source_sha,
    acquired_at_epoch,
    lease_duration_seconds,
    lease_until_epoch,
    released_at_epoch,
    fencing_generation,
    resource_version,
) = sys.argv[1:]

raw_values = {
    "state": state,
    "holder": holder,
    "operation-id": operation_id,
    "source-sha": source_sha,
    "acquired-at-epoch": acquired_at_epoch,
    "lease-duration-seconds": lease_duration_seconds,
    "lease-until-epoch": lease_until_epoch,
    "released-at-epoch": released_at_epoch,
    "fencing-generation": fencing_generation,
}

data = {
    key: value
    for key, value in raw_values.items()
    if value != "__ABSENT__"
}

document = {
    "apiVersion": "v1",
    "kind": "ConfigMap",
    "metadata": {
        "name": "gaming-mongo-migration-lock",
        "namespace": "default",
        "uid": "fixture-lock-uid",
        "resourceVersion": resource_version,
    },
    "data": data,
}

with open(path, "w", encoding="utf-8") as fh:
    json.dump(document, fh)
PY
}

assert_lock_values() {
  python3 - "$STATE_FILE" "$@" <<'PY'
import json
import sys

path = sys.argv[1]
expected_args = sys.argv[2:]
if len(expected_args) % 2 != 0:
    raise SystemExit("expected key/value pairs")

with open(path, "r", encoding="utf-8") as fh:
    document = json.load(fh)

data = document.get("data", {})
for index in range(0, len(expected_args), 2):
    key = expected_args[index]
    expected = expected_args[index + 1]
    actual = data.get(key, "__ABSENT__")
    if actual != expected:
        raise SystemExit(f"{key} expected {expected} got {actual}")
PY
}

assert_lock_output_contains() {
  local output="$1"
  local expected="$2"
  grep -Fq "$expected" <<<"$output" ||
    fail "expected output to contain: $expected"
}

reset_get_counter
rm -f -- "$STATE_FILE"
output="$(
  run_lock_case \
    holder-a \
    live-data-dry-run \
    "$SHA_A" \
    LOCK_LEASE_SECONDS=120 \
    NOW_EPOCH=1000 \
    "$LOCK_SCRIPT" acquire
)"
assert_lock_output_contains \
  "$output" \
  'shared_mongo_lock=acquire status=PASS lease_until_epoch=1120'
assert_lock_values \
  state active \
  holder holder-a \
  operation-id live-data-dry-run \
  source-sha "$SHA_A" \
  acquired-at-epoch 1000 \
  lease-duration-seconds 120 \
  lease-until-epoch 1120 \
  released-at-epoch 0 \
  fencing-generation 1

run_lock_case \
  holder-a \
  live-data-dry-run \
  "$SHA_A" \
  NOW_EPOCH=1100 \
  "$LOCK_SCRIPT" verify >/dev/null ||
  fail "verify rejected a live lease"

run_lock_case \
  holder-a \
  live-data-dry-run \
  "$SHA_A" \
  LOCK_LEASE_SECONDS=60 \
  NOW_EPOCH=1110 \
  "$LOCK_SCRIPT" renew >/dev/null ||
  fail "renew failed for the active holder"
assert_lock_values \
  acquired-at-epoch 1000 \
  lease-duration-seconds 60 \
  lease-until-epoch 1170 \
  fencing-generation 2

output="$(
  run_lock_case \
    holder-a \
    live-data-dry-run \
    "$SHA_A" \
    NOW_EPOCH=1111 \
    "$LOCK_SCRIPT" release
)"
assert_lock_output_contains \
  "$output" \
  'shared_mongo_lock=release status=PASS released_at_epoch=1111'
assert_lock_values \
  state released \
  holder '' \
  operation-id live-data-dry-run \
  source-sha "$SHA_A" \
  lease-until-epoch 0 \
  released-at-epoch 1111 \
  fencing-generation 3

run_lock_case \
  holder-a \
  live-data-dry-run \
  "$SHA_A" \
  NOW_EPOCH=1111 \
  "$LOCK_SCRIPT" verify-released >/dev/null ||
  fail "verify-released rejected the released handoff"

write_lock_document \
  active \
  holder-stale \
  stale-data-rollout \
  "$SHA_A" \
  1000 \
  60 \
  1060 \
  0 \
  7 \
  10
reset_get_counter
output="$(
  run_lock_case \
    holder-new \
    live-data-apply-slip-index \
    "$SHA_B" \
    LOCK_LEASE_SECONDS=90 \
    NOW_EPOCH=2000 \
    "$LOCK_SCRIPT" acquire
)"
assert_lock_output_contains \
  "$output" \
  'shared_mongo_lock=acquire status=PASS reclaimed=expired previous_holder=holder-stale lease_until_epoch=2090'
assert_lock_values \
  state active \
  holder holder-new \
  operation-id live-data-apply-slip-index \
  source-sha "$SHA_B" \
  acquired-at-epoch 2000 \
  lease-duration-seconds 90 \
  lease-until-epoch 2090 \
  released-at-epoch 0 \
  fencing-generation 8

write_lock_document \
  active \
  holder-legacy \
  legacy-rollout \
  "$SHA_A" \
  1200 \
  __ABSENT__ \
  __ABSENT__ \
  0 \
  __ABSENT__ \
  21
reset_get_counter
invalid_reclaim_output="$WORK_DIR/invalid-reclaim.out"
if run_lock_case \
  holder-reclaimer \
  live-data-dry-run \
  "$SHA_B" \
  LOCK_LEASE_SECONDS=90 \
  NOW_EPOCH=2000 \
  "$LOCK_SCRIPT" acquire >"$invalid_reclaim_output" 2>&1; then
  fail "acquire reclaimed an active lock with invalid lease metadata"
fi
assert_lock_output_contains \
  "$(cat "$invalid_reclaim_output")" \
  'recover only with shared-mongo-operation-lock-stan.sh force-release'
assert_lock_values \
  state active \
  holder holder-legacy \
  operation-id legacy-rollout \
  source-sha "$SHA_A" \
  acquired-at-epoch 1200 \
  lease-duration-seconds __ABSENT__ \
  lease-until-epoch __ABSENT__ \
  released-at-epoch 0 \
  fencing-generation __ABSENT__

output="$(
  run_lock_case \
    holder-ops \
    legacy-rollout \
    "$SHA_A" \
    CONFIRM_FORCE_RELEASE=release-matching-stale-database-lock \
    NOW_EPOCH=2001 \
    "$LOCK_SCRIPT" force-release
)"
assert_lock_output_contains \
  "$output" \
  'shared_mongo_lock=force-release status=PASS released_at_epoch=2001'
assert_lock_values \
  state released \
  holder '' \
  operation-id legacy-rollout \
  source-sha "$SHA_A" \
  released-at-epoch 2001 \
  fencing-generation 1

write_lock_document \
  active \
  holder-renew \
  renew-rollout \
  "$SHA_B" \
  1000 \
  60 \
  1060 \
  0 \
  4 \
  31
reset_get_counter
expired_renew_output="$WORK_DIR/expired-renew.out"
if run_lock_case \
  holder-renew \
  renew-rollout \
  "$SHA_B" \
  LOCK_LEASE_SECONDS=120 \
  NOW_EPOCH=2000 \
  "$LOCK_SCRIPT" renew >"$expired_renew_output" 2>&1; then
  fail "renew resurrected an expired lock"
fi
assert_lock_output_contains \
  "$(cat "$expired_renew_output")" \
  'active database operation lock has expired and cannot be renewed'
assert_lock_values \
  state active \
  holder holder-renew \
  operation-id renew-rollout \
  source-sha "$SHA_B" \
  acquired-at-epoch 1000 \
  lease-duration-seconds 60 \
  lease-until-epoch 1060 \
  released-at-epoch 0 \
  fencing-generation 4

write_lock_document \
  active \
  holder-owner \
  owner-rollout \
  "$SHA_A" \
  1000 \
  60 \
  1060 \
  0 \
  11 \
  41
reset_get_counter
reclaim_race_output="$WORK_DIR/reclaim-race.out"
if run_lock_case \
  holder-racer \
  racer-rollout \
  "$SHA_B" \
  LOCK_LEASE_SECONDS=90 \
  NOW_EPOCH=2000 \
  STUB_SIMULATE_RENEW_ON_GET=2 \
  STUB_SIMULATE_RENEW_HOLDER=holder-owner \
  STUB_SIMULATE_RENEW_OPERATION=owner-rollout \
  STUB_SIMULATE_RENEW_SOURCE_SHA="$SHA_A" \
  STUB_SIMULATE_RENEW_ACQUIRED_AT=1000 \
  STUB_SIMULATE_RENEW_LEASE_DURATION=120 \
  STUB_SIMULATE_RENEW_LEASE_UNTIL=2120 \
  STUB_SIMULATE_RENEW_GENERATION=12 \
  "$LOCK_SCRIPT" acquire >"$reclaim_race_output" 2>&1; then
  fail "expired reclaim stole a lock that was renewed before compare-and-swap"
fi
assert_lock_output_contains \
  "$(cat "$reclaim_race_output")" \
  'stale database lock changed while reclaiming'
assert_lock_values \
  state active \
  holder holder-owner \
  operation-id owner-rollout \
  source-sha "$SHA_A" \
  acquired-at-epoch 1000 \
  lease-duration-seconds 120 \
  lease-until-epoch 2120 \
  released-at-epoch 0 \
  fencing-generation 12

run_lock_case \
  holder-owner \
  owner-rollout \
  "$SHA_A" \
  NOW_EPOCH=2001 \
  "$LOCK_SCRIPT" verify >/dev/null ||
  fail "verify rejected the concurrently renewed owner lock"

reset_strict_fixture() {
  write_lock_document active holder-owner owner-rollout "$SHA_A" \
    1000 60 1060 0 11 41
  reset_get_counter
}

run_strict_release() {
  run_lock_case holder-owner owner-rollout "$SHA_A" \
    EXPECTED_LOCK_UID=fixture-lock-uid \
    EXPECTED_RESOURCE_VERSION=41 \
    EXPECTED_FENCING_GENERATION=11 \
    EXPECTED_LEASE_UNTIL_EPOCH=1060 \
    NOW_EPOCH=2000 \
    "$@" \
    "$LOCK_SCRIPT" release
}

for strict_case in uid version generation lease incomplete foreign operation source released malformed duration future inconsistent missing; do
  reset_strict_fixture
  strict_args=(NOW_EPOCH=2000)
  case "$strict_case" in
    uid) strict_args=(EXPECTED_LOCK_UID=other-lock-uid) ;;
    version) strict_args=(EXPECTED_RESOURCE_VERSION=40) ;;
    generation) strict_args=(EXPECTED_FENCING_GENERATION=10) ;;
    lease) strict_args=(EXPECTED_LEASE_UNTIL_EPOCH=1061) ;;
    incomplete) strict_args=(EXPECTED_RESOURCE_VERSION=) ;;
    operation) strict_args=(OPERATION_ID=other-rollout) ;;
    source) strict_args=("SOURCE_SHA=$SHA_B") ;;
    foreign)
      write_lock_document active other-owner owner-rollout "$SHA_A" \
        1000 60 1060 0 11 41
      ;;
    released)
      write_lock_document released '' owner-rollout "$SHA_A" \
        1000 0 0 1999 11 41
      ;;
    malformed)
      write_lock_document active holder-owner owner-rollout "$SHA_A" \
        1000 __ABSENT__ 1060 0 11 41
      ;;
    duration)
      write_lock_document active holder-owner owner-rollout "$SHA_A" \
        1000 59 1060 0 11 41
      ;;
    future)
      write_lock_document active holder-owner owner-rollout "$SHA_A" \
        2001 60 2061 0 11 41
      strict_args=(EXPECTED_LEASE_UNTIL_EPOCH=2061)
      ;;
    inconsistent)
      write_lock_document active holder-owner owner-rollout "$SHA_A" \
        1060 60 1060 0 11 41
      ;;
    missing) rm -f -- "$STATE_FILE" ;;
  esac
  if [[ -f "$STATE_FILE" ]]; then
    cp "$STATE_FILE" "$WORK_DIR/strict-before.json"
  fi
  if run_strict_release "${strict_args[@]}" >"$WORK_DIR/strict-rejection.out" 2>&1; then
    fail "strict release accepted $strict_case snapshot"
  fi
  if [[ "$strict_case" == "missing" ]]; then
    [[ ! -e "$STATE_FILE" ]] || fail "strict release recreated a missing lock"
  else
    cmp -s "$STATE_FILE" "$WORK_DIR/strict-before.json" ||
      fail "rejected strict release changed the $strict_case snapshot"
  fi
done

for race in uid version replace; do
  reset_strict_fixture
  case "$race" in
    uid) strict_args=(STUB_SIMULATE_UID_ON_GET=2) ;;
    version) strict_args=(STUB_SIMULATE_VERSION_ON_GET=2) ;;
    replace) strict_args=(STUB_FAIL_REPLACE=true) ;;
  esac
  if run_strict_release "${strict_args[@]}" >"$WORK_DIR/strict-race.out" 2>&1; then
    fail "strict release ignored the $race compare-and-swap race"
  fi
  assert_lock_values state active holder holder-owner fencing-generation 11
done

reset_strict_fixture
output="$(run_strict_release)" ||
  fail "strict release rejected the exact expired owner's snapshot"
assert_lock_output_contains "$output" 'strict_snapshot=true fencing_generation=12'
assert_lock_values state released holder '' operation-id owner-rollout \
  source-sha "$SHA_A" fencing-generation 12

if run_lock_case holder-next next-rollout "$SHA_B" \
  EXPECTED_LOCK_UID=fixture-lock-uid EXPECTED_FENCING_GENERATION=11 \
  LOCK_LEASE_SECONDS=60 NOW_EPOCH=2001 \
  "$LOCK_SCRIPT" acquire-released >"$WORK_DIR/strict-acquire.out" 2>&1; then
  fail "released-only acquisition ignored the exact released generation"
fi
assert_lock_values state released holder '' fencing-generation 12

run_lock_case holder-next next-rollout "$SHA_B" \
  EXPECTED_LOCK_UID=fixture-lock-uid EXPECTED_FENCING_GENERATION=12 \
  LOCK_LEASE_SECONDS=60 NOW_EPOCH=2001 \
  "$LOCK_SCRIPT" acquire-released >/dev/null ||
  fail "released-only acquisition rejected the exact strict-release result"
assert_lock_values state active holder holder-next operation-id next-rollout \
  source-sha "$SHA_B" fencing-generation 13

if run_lock_case holder-racer racer-rollout "$SHA_A" \
  EXPECTED_LOCK_UID=fixture-lock-uid EXPECTED_FENCING_GENERATION=12 \
  LOCK_LEASE_SECONDS=60 NOW_EPOCH=2002 \
  "$LOCK_SCRIPT" acquire-released >"$WORK_DIR/strict-competitor.out" 2>&1; then
  fail "released-only acquisition replaced a competing owner"
fi
assert_lock_values state active holder holder-next fencing-generation 13

output="$(
  run_lock_case holder-racer racer-rollout "$SHA_A" "$LOCK_SCRIPT" release
)"
assert_lock_output_contains "$output" 'status=SKIPPED reason=not-holder'
assert_lock_values state active holder holder-next fencing-generation 13

write_lock_document released '' owner-rollout "$SHA_A" 1000 0 0 2000 12 42
output="$(
  run_lock_case holder-owner owner-rollout "$SHA_A" "$LOCK_SCRIPT" release
)"
assert_lock_output_contains "$output" 'status=SKIPPED reason=already-released'

rm -f -- "$STATE_FILE"
output="$(
  run_lock_case holder-owner owner-rollout "$SHA_A" "$LOCK_SCRIPT" release
)"
assert_lock_output_contains "$output" 'status=SKIPPED reason=not-found'

INCIDENT_SOURCE=cccccccccccccccccccccccccccccccccccccccc
INCIDENT_MANIFEST=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
INCIDENT_RUN_METADATA_A=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
INCIDENT_RUN_METADATA_B=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
HELD_SOURCE=70679a6179df2167cb39f185cb0c26dca2ce649d
reset_incident_fixture() {
  write_lock_document \
    active \
    live-data-39945618182-1 \
    live-data-apply-slip-index \
    "$HELD_SOURCE" \
    1792761824 \
    7200 \
    1792769419 \
    0 \
    519 \
    4155167
  reset_get_counter
}

run_incident_replace() {
  run_lock_case \
    live-data-incident-5000-1 \
    live-data-incident-restore \
    "$INCIDENT_SOURCE" \
    EXPECTED_LOCK_UID=fixture-lock-uid \
    EXPECTED_RESOURCE_VERSION=4155167 \
    EXPECTED_LOCK_HOLDER=live-data-39945618182-1 \
    EXPECTED_LOCK_OPERATION_ID=live-data-apply-slip-index \
    EXPECTED_LOCK_SOURCE_SHA="$HELD_SOURCE" \
    EXPECTED_ACQUIRED_AT_EPOCH=1792761824 \
    EXPECTED_LEASE_DURATION_SECONDS=7200 \
    EXPECTED_LEASE_UNTIL_EPOCH=1792769419 \
    EXPECTED_RELEASED_AT_EPOCH=0 \
    EXPECTED_FENCING_GENERATION=519 \
    EXPECTED_INCIDENT_MANIFEST_SHA256="$INCIDENT_MANIFEST" \
    EXPECTED_INCIDENT_OWNER_RUN_ID=39945618182 \
    EXPECTED_INCIDENT_RUN_ID=5000 \
    EXPECTED_INCIDENT_CONTROL_SHA="$INCIDENT_SOURCE" \
    REQUEST_CURRENT_RUN_METADATA_SHA256="$INCIDENT_RUN_METADATA_A" \
    REQUEST_CREATED_AT_EPOCH=1792769420 \
    PROVIDER_TRANSITION_EPOCH=1792770000 \
    LOCK_LEASE_SECONDS=7200 \
    NOW_EPOCH=1 \
    "$@" \
    "$LOCK_SCRIPT" replace-expired-active
}

reset_incident_fixture
incident_output="$(run_incident_replace)" ||
  fail "strict incident replacement rejected the exact expired preimage"
assert_lock_output_contains "$incident_output" \
  'shared_mongo_lock=replace-expired-active status=PASS result=applied'
assert_lock_output_contains "$incident_output" \
  'request_created_at_epoch=1792769420 provider_transition_epoch=1792770000 predecessor_lease_until_epoch=1792769419 lease_until_epoch=1792777200'
assert_lock_values \
  state active \
  holder live-data-incident-5000-1 \
  operation-id live-data-incident-restore \
  source-sha "$INCIDENT_SOURCE" \
  acquired-at-epoch 1792770000 \
  lease-duration-seconds 7200 \
  lease-until-epoch 1792777200 \
  released-at-epoch 0 \
  fencing-generation 520 \
  incident-manifest-sha256 "$INCIDENT_MANIFEST" \
  incident-owner-run-id 39945618182 \
  incident-restore-run-id 5000 \
  incident-control-sha "$INCIDENT_SOURCE" \
  incident-current-run-metadata-sha256 "$INCIDENT_RUN_METADATA_A" \
  incident-request-created-at-epoch 1792769420 \
  incident-provider-transition-epoch 1792770000 \
  incident-predecessor-lease-until-epoch 1792769419 \
  incident-new-lease-until-epoch 1792777200
[[ "$(cat "$REPLACE_COUNT_FILE")" == "1" ]] ||
  fail "strict incident replacement issued more than one replace"

reset_get_counter
second_incident_output="$(
  run_lock_case \
    live-data-incident-5001-1 \
    live-data-incident-restore \
    "$INCIDENT_SOURCE" \
    EXPECTED_LOCK_UID=fixture-lock-uid \
    EXPECTED_RESOURCE_VERSION=4155168 \
    EXPECTED_LOCK_HOLDER=live-data-incident-5000-1 \
    EXPECTED_LOCK_OPERATION_ID=live-data-incident-restore \
    EXPECTED_LOCK_SOURCE_SHA="$INCIDENT_SOURCE" \
    EXPECTED_ACQUIRED_AT_EPOCH=1792770000 \
    EXPECTED_LEASE_DURATION_SECONDS=7200 \
    EXPECTED_LEASE_UNTIL_EPOCH=1792777200 \
    EXPECTED_RELEASED_AT_EPOCH=0 \
    EXPECTED_FENCING_GENERATION=520 \
    EXPECTED_PREDECESSOR_INCIDENT_MANIFEST_SHA256="$INCIDENT_MANIFEST" \
    EXPECTED_PREDECESSOR_INCIDENT_OWNER_RUN_ID=39945618182 \
    EXPECTED_PREDECESSOR_INCIDENT_RESTORE_RUN_ID=5000 \
    EXPECTED_PREDECESSOR_INCIDENT_CONTROL_SHA="$INCIDENT_SOURCE" \
    EXPECTED_PREDECESSOR_INCIDENT_CURRENT_RUN_METADATA_SHA256="$INCIDENT_RUN_METADATA_A" \
    EXPECTED_PREDECESSOR_INCIDENT_REQUEST_CREATED_AT_EPOCH=1792769420 \
    EXPECTED_PREDECESSOR_INCIDENT_PROVIDER_TRANSITION_EPOCH=1792770000 \
    EXPECTED_PREDECESSOR_INCIDENT_PREDECESSOR_LEASE_UNTIL_EPOCH=1792769419 \
    EXPECTED_PREDECESSOR_INCIDENT_NEW_LEASE_UNTIL_EPOCH=1792777200 \
    EXPECTED_INCIDENT_MANIFEST_SHA256="$INCIDENT_MANIFEST" \
    EXPECTED_INCIDENT_OWNER_RUN_ID=39945618182 \
    EXPECTED_INCIDENT_RUN_ID=5001 \
    EXPECTED_INCIDENT_CONTROL_SHA="$INCIDENT_SOURCE" \
    REQUEST_CURRENT_RUN_METADATA_SHA256="$INCIDENT_RUN_METADATA_B" \
    REQUEST_CREATED_AT_EPOCH=1792777201 \
    PROVIDER_TRANSITION_EPOCH=1792778000 \
    LOCK_LEASE_SECONDS=7200 \
    NOW_EPOCH=999999999999999 \
    "$LOCK_SCRIPT" replace-expired-active
)" || fail "second strict incident replacement rejected its named predecessor"
assert_lock_output_contains "$second_incident_output" \
  'shared_mongo_lock=replace-expired-active status=PASS result=applied'
assert_lock_output_contains "$second_incident_output" \
  'request_created_at_epoch=1792777201 provider_transition_epoch=1792778000 predecessor_lease_until_epoch=1792777200 lease_until_epoch=1792785200'
assert_lock_values \
  state active \
  holder live-data-incident-5001-1 \
  fencing-generation 521 \
  incident-manifest-sha256 "$INCIDENT_MANIFEST" \
  incident-owner-run-id 39945618182 \
  incident-restore-run-id 5001 \
  incident-control-sha "$INCIDENT_SOURCE" \
  incident-current-run-metadata-sha256 "$INCIDENT_RUN_METADATA_B" \
  incident-request-created-at-epoch 1792777201 \
  incident-provider-transition-epoch 1792778000 \
  incident-predecessor-lease-until-epoch 1792777200 \
  incident-new-lease-until-epoch 1792785200
[[ "$(cat "$REPLACE_COUNT_FILE")" == "1" ]] ||
  fail "second strict incident replacement issued more than one replace"

reset_get_counter
run_lock_case \
  live-data-incident-5001-1 \
  live-data-incident-restore \
  "$INCIDENT_SOURCE" \
  EXPECTED_LOCK_UID=fixture-lock-uid \
  EXPECTED_RESOURCE_VERSION=4155169 \
  EXPECTED_FENCING_GENERATION=521 \
  EXPECTED_LEASE_UNTIL_EPOCH=1792785200 \
  EXPECTED_PREDECESSOR_INCIDENT_MANIFEST_SHA256="$INCIDENT_MANIFEST" \
  EXPECTED_PREDECESSOR_INCIDENT_OWNER_RUN_ID=39945618182 \
  EXPECTED_PREDECESSOR_INCIDENT_RESTORE_RUN_ID=5001 \
  EXPECTED_PREDECESSOR_INCIDENT_CONTROL_SHA="$INCIDENT_SOURCE" \
  EXPECTED_PREDECESSOR_INCIDENT_CURRENT_RUN_METADATA_SHA256="$INCIDENT_RUN_METADATA_B" \
  EXPECTED_PREDECESSOR_INCIDENT_REQUEST_CREATED_AT_EPOCH=1792777201 \
  EXPECTED_PREDECESSOR_INCIDENT_PROVIDER_TRANSITION_EPOCH=1792778000 \
  EXPECTED_PREDECESSOR_INCIDENT_PREDECESSOR_LEASE_UNTIL_EPOCH=1792777200 \
  EXPECTED_PREDECESSOR_INCIDENT_NEW_LEASE_UNTIL_EPOCH=1792785200 \
  NOW_EPOCH=1792778001 \
  "$LOCK_SCRIPT" release >/dev/null ||
  fail "strict incident release rejected the exact second takeover"
assert_lock_values \
  state released \
  holder '' \
  fencing-generation 522 \
  incident-manifest-sha256 __ABSENT__ \
  incident-owner-run-id __ABSENT__ \
  incident-restore-run-id __ABSENT__ \
  incident-control-sha __ABSENT__ \
  incident-current-run-metadata-sha256 __ABSENT__ \
  incident-request-created-at-epoch __ABSENT__ \
  incident-provider-transition-epoch __ABSENT__ \
  incident-predecessor-lease-until-epoch __ABSENT__ \
  incident-new-lease-until-epoch __ABSENT__

reset_get_counter
run_lock_case \
  holder-ordinary \
  live-data-dry-run \
  "$SHA_A" \
  EXPECTED_LOCK_UID=fixture-lock-uid \
  EXPECTED_FENCING_GENERATION=522 \
  LOCK_LEASE_SECONDS=60 \
  NOW_EPOCH=1792778002 \
  "$LOCK_SCRIPT" acquire-released >/dev/null ||
  fail "ordinary acquisition rejected the canonical released incident generation"
assert_lock_values \
  state active \
  holder holder-ordinary \
  operation-id live-data-dry-run \
  fencing-generation 523 \
  incident-manifest-sha256 __ABSENT__ \
  incident-owner-run-id __ABSENT__ \
  incident-restore-run-id __ABSENT__ \
  incident-control-sha __ABSENT__ \
  incident-current-run-metadata-sha256 __ABSENT__ \
  incident-request-created-at-epoch __ABSENT__ \
  incident-provider-transition-epoch __ABSENT__ \
  incident-predecessor-lease-until-epoch __ABSENT__ \
  incident-new-lease-until-epoch __ABSENT__

reset_incident_fixture
run_incident_replace >/dev/null ||
  fail "incident mismatch fixture could not create the first takeover"
reset_get_counter
cp "$STATE_FILE" "$WORK_DIR/incident-predecessor-before.json"
if run_lock_case \
    live-data-incident-5001-1 \
    live-data-incident-restore \
    "$INCIDENT_SOURCE" \
    EXPECTED_LOCK_UID=fixture-lock-uid \
    EXPECTED_RESOURCE_VERSION=4155168 \
    EXPECTED_LOCK_HOLDER=live-data-incident-5000-1 \
    EXPECTED_LOCK_OPERATION_ID=live-data-incident-restore \
    EXPECTED_LOCK_SOURCE_SHA="$INCIDENT_SOURCE" \
    EXPECTED_ACQUIRED_AT_EPOCH=1792770000 \
    EXPECTED_LEASE_DURATION_SECONDS=7200 \
    EXPECTED_LEASE_UNTIL_EPOCH=1792777200 \
    EXPECTED_RELEASED_AT_EPOCH=0 \
    EXPECTED_FENCING_GENERATION=520 \
    EXPECTED_PREDECESSOR_INCIDENT_MANIFEST_SHA256="$INCIDENT_MANIFEST" \
    EXPECTED_PREDECESSOR_INCIDENT_OWNER_RUN_ID=39945618182 \
    EXPECTED_PREDECESSOR_INCIDENT_RESTORE_RUN_ID=4999 \
    EXPECTED_PREDECESSOR_INCIDENT_CONTROL_SHA="$INCIDENT_SOURCE" \
    EXPECTED_PREDECESSOR_INCIDENT_CURRENT_RUN_METADATA_SHA256="$INCIDENT_RUN_METADATA_A" \
    EXPECTED_PREDECESSOR_INCIDENT_REQUEST_CREATED_AT_EPOCH=1792769420 \
    EXPECTED_PREDECESSOR_INCIDENT_PROVIDER_TRANSITION_EPOCH=1792770000 \
    EXPECTED_PREDECESSOR_INCIDENT_PREDECESSOR_LEASE_UNTIL_EPOCH=1792769419 \
    EXPECTED_PREDECESSOR_INCIDENT_NEW_LEASE_UNTIL_EPOCH=1792777200 \
    EXPECTED_INCIDENT_MANIFEST_SHA256="$INCIDENT_MANIFEST" \
    EXPECTED_INCIDENT_OWNER_RUN_ID=39945618182 \
    EXPECTED_INCIDENT_RUN_ID=5001 \
    EXPECTED_INCIDENT_CONTROL_SHA="$INCIDENT_SOURCE" \
    REQUEST_CURRENT_RUN_METADATA_SHA256="$INCIDENT_RUN_METADATA_B" \
    REQUEST_CREATED_AT_EPOCH=1792777201 \
    PROVIDER_TRANSITION_EPOCH=1792778000 \
    LOCK_LEASE_SECONDS=7200 \
    "$LOCK_SCRIPT" replace-expired-active \
      >"$WORK_DIR/incident-predecessor-mismatch.out" 2>&1; then
  fail "strict incident replacement accepted a mismatched named predecessor"
fi
[[ ! -e "$REPLACE_COUNT_FILE" ]] ||
  fail "mismatched incident predecessor reached kubectl replace"
cmp -s "$STATE_FILE" "$WORK_DIR/incident-predecessor-before.json" ||
  fail "mismatched incident predecessor changed the lock"

reset_incident_fixture
if run_incident_replace REQUEST_CREATED_AT_EPOCH=1792769418 \
    >"$WORK_DIR/incident-unexpired.out" 2>&1; then
  fail "strict incident replacement accepted a request created before cutoff"
fi
[[ ! -e "$REPLACE_COUNT_FILE" ]] ||
  fail "pre-cutoff incident request reached kubectl replace"

reset_incident_fixture
if run_incident_replace REQUEST_CREATED_AT_EPOCH=1792769419 \
    >"$WORK_DIR/incident-cutoff-equality.out" 2>&1; then
  fail "strict incident replacement accepted cutoff equality"
fi
[[ ! -e "$REPLACE_COUNT_FILE" ]] ||
  fail "cutoff-equality incident request reached kubectl replace"

reset_incident_fixture
if run_incident_replace PROVIDER_TRANSITION_EPOCH=1792769419 \
    >"$WORK_DIR/incident-stale-provider-time.out" 2>&1; then
  fail "strict incident replacement accepted stale provider time"
fi
[[ ! -e "$REPLACE_COUNT_FILE" ]] ||
  fail "stale provider time reached kubectl replace"

reset_incident_fixture
if run_incident_replace PROVIDER_TRANSITION_EPOCH= \
    >"$WORK_DIR/incident-missing-provider-time.out" 2>&1; then
  fail "strict incident replacement accepted missing provider time"
fi
[[ ! -e "$REPLACE_COUNT_FILE" ]] ||
  fail "missing provider time reached kubectl replace"

reset_incident_fixture
if run_incident_replace REQUEST_CURRENT_RUN_METADATA_SHA256=invalid \
    >"$WORK_DIR/incident-invalid-run-metadata.out" 2>&1; then
  fail "strict incident replacement accepted malformed run metadata digest"
fi
[[ ! -e "$REPLACE_COUNT_FILE" ]] ||
  fail "malformed run metadata digest reached kubectl replace"

reset_incident_fixture
write_lock_document active changed-owner live-data-apply-slip-index "$HELD_SOURCE" \
  1792761824 7200 1792769419 0 519 4155167
if run_incident_replace >"$WORK_DIR/incident-mismatch.out" 2>&1; then
  fail "strict incident replacement accepted a mismatched complete preimage"
fi
[[ ! -e "$REPLACE_COUNT_FILE" ]] ||
  fail "mismatched incident preimage reached kubectl replace"
assert_lock_values state active holder changed-owner fencing-generation 519

reset_incident_fixture
python3 - "$STATE_FILE" <<'PY'
import json
import sys
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    document = json.load(handle)
document["data"]["incident-unknown"] = "value"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(document, handle)
PY
if run_incident_replace >"$WORK_DIR/incident-extra-key.out" 2>&1; then
  fail "strict incident replacement accepted an incomplete data preimage"
fi
[[ ! -e "$REPLACE_COUNT_FILE" ]] ||
  fail "unexpected incident preimage fields reached kubectl replace"

reset_incident_fixture
if run_incident_replace STUB_FAIL_REPLACE=true \
    >"$WORK_DIR/incident-not-applied.out" 2>&1; then
  fail "strict incident replacement retried a confirmed not-applied replace"
fi
assert_lock_output_contains "$(cat "$WORK_DIR/incident-not-applied.out")" \
  'was not applied; no retry is permitted'
[[ "$(cat "$REPLACE_COUNT_FILE")" == "1" && "$(cat "$GET_COUNT_FILE")" == "2" ]] ||
  fail "not-applied incident replacement did not use one replace and one reread"
assert_lock_values state active holder live-data-39945618182-1 \
  fencing-generation 519 released-at-epoch 0

reset_incident_fixture
incident_output="$(
  run_incident_replace STUB_REPLACE_MODE=apply-then-fail
)" || fail "strict incident replacement did not recognize its exact postimage"
assert_lock_output_contains "$incident_output" 'result=applied-after-reread'
[[ "$(cat "$REPLACE_COUNT_FILE")" == "1" && "$(cat "$GET_COUNT_FILE")" == "2" ]] ||
  fail "uncertain applied replacement did not use one replace and one reread"
assert_lock_values state active holder live-data-incident-5000-1 \
  fencing-generation 520 released-at-epoch 0

reset_incident_fixture
if run_incident_replace \
    STUB_FAIL_REPLACE=true \
    STUB_SIMULATE_RENEW_ON_GET=2 \
    STUB_SIMULATE_RENEW_HOLDER=other-holder \
    STUB_SIMULATE_RENEW_OPERATION=other-operation \
    STUB_SIMULATE_RENEW_SOURCE_SHA="$SHA_A" \
    STUB_SIMULATE_RENEW_ACQUIRED_AT=1792770000 \
    STUB_SIMULATE_RENEW_LEASE_DURATION=7200 \
    STUB_SIMULATE_RENEW_LEASE_UNTIL=1792777200 \
    STUB_SIMULATE_RENEW_GENERATION=520 \
    >"$WORK_DIR/incident-ambiguous.out" 2>&1; then
  fail "strict incident replacement accepted an ambiguous drifted reread"
fi
assert_lock_output_contains "$(cat "$WORK_DIR/incident-ambiguous.out")" \
  'result is ambiguous after the single replace'
[[ "$(cat "$REPLACE_COUNT_FILE")" == "1" ]] ||
  fail "ambiguous incident replacement retried"

reset_incident_fixture
if run_incident_replace STUB_FAIL_REPLACE=true STUB_FAIL_GET_NUMBER=2 \
    >"$WORK_DIR/incident-read-failure.out" 2>&1; then
  fail "strict incident replacement accepted an unreadable uncertain result"
fi
assert_lock_output_contains "$(cat "$WORK_DIR/incident-read-failure.out")" \
  'result is ambiguous after the single replace'
[[ "$(cat "$REPLACE_COUNT_FILE")" == "1" ]] ||
  fail "unreadable incident replacement retried"

echo "shared_mongo_operation_lock_tests=PASS"
