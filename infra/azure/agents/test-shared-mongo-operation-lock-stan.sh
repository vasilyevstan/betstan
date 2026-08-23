#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCK_SCRIPT="$ROOT_DIR/infra/azure/agents/shared-mongo-operation-lock-stan.sh"
WORK_DIR="$(mktemp -d "$ROOT_DIR/.shared-mongo-operation-lock.XXXXXX")"
STATE_FILE="$WORK_DIR/configmap.json"
GET_COUNT_FILE="$WORK_DIR/get-count"
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

  cat "$state_file"
  exit 0
fi

if [[ "${1:-}" == "replace" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  replacement="$(mktemp)"
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
  rm -f -- "$GET_COUNT_FILE"
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

echo "shared_mongo_operation_lock_tests=PASS"
