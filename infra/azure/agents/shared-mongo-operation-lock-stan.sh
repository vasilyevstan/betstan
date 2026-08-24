#!/usr/bin/env bash
set -euo pipefail

# Purpose: serialize every shared-Mongo migration, rollback, cleanup, and deploy
# operation with a resource-versioned ConfigMap compare-and-swap.

ACTION="${1:-}"
NAMESPACE="${NAMESPACE:-default}"
LOCK_CONFIGMAP="${LOCK_CONFIGMAP:-gaming-mongo-migration-lock}"
LOCK_TOKEN="${LOCK_TOKEN:-}"
OPERATION_ID="${OPERATION_ID:-}"
SOURCE_SHA="${SOURCE_SHA:-}"
LOCK_LEASE_SECONDS="${LOCK_LEASE_SECONDS:-21600}"
NOW_EPOCH="${NOW_EPOCH:-}"
LEGACY_RECOVERY_HINT="active database operation lock lease metadata is missing or invalid; recover only with shared-mongo-operation-lock-stan.sh force-release after confirming the exact stale OPERATION_ID and SOURCE_SHA"

fail() {
  echo "shared_mongo_lock=${ACTION:-missing} status=FAIL reason=$*" >&2
  exit 1
}

for command_name in kubectl python3; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command missing: $command_name"
done

validate_identity() {
  [[ "$LOCK_TOKEN" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] ||
    fail "LOCK_TOKEN is missing or invalid"
  [[ "$OPERATION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] ||
    fail "OPERATION_ID is missing or invalid"
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    fail "SOURCE_SHA must be a complete lowercase commit SHA"
}

validate_lease() {
  [[ "$LOCK_LEASE_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
    fail "LOCK_LEASE_SECONDS must be a positive integer"
  (( LOCK_LEASE_SECONDS >= 60 && LOCK_LEASE_SECONDS <= 86400 )) ||
    fail "LOCK_LEASE_SECONDS must be between 60 and 86400 seconds"
}

is_positive_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

current_epoch() {
  if [[ -n "$NOW_EPOCH" ]]; then
    [[ "$NOW_EPOCH" =~ ^[1-9][0-9]*$ ]] ||
      fail "NOW_EPOCH must be a positive integer when provided"
    printf '%s\n' "$NOW_EPOCH"
    return 0
  fi
  date -u +%s
}

read_lock_fields() {
  kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" -o json |
    python3 -c '
import json
import sys

data = json.load(sys.stdin).get("data", {})
print("|".join([
    data.get("state", ""),
    data.get("holder", ""),
    data.get("operation-id", ""),
    data.get("source-sha", ""),
    data.get("acquired-at-epoch", ""),
    data.get("lease-duration-seconds", ""),
    data.get("lease-until-epoch", ""),
    data.get("released-at-epoch", ""),
    data.get("fencing-generation", ""),
]))
'
}

require_active_lease_metadata() {
  local acquired_at_epoch="$1"
  local lease_duration_seconds="$2"
  local lease_until_epoch="$3"
  local fencing_generation="$4"
  is_positive_integer "$acquired_at_epoch" || fail "$LEGACY_RECOVERY_HINT"
  is_positive_integer "$lease_duration_seconds" || fail "$LEGACY_RECOVERY_HINT"
  is_positive_integer "$lease_until_epoch" || fail "$LEGACY_RECOVERY_HINT"
  is_positive_integer "$fencing_generation" || fail "$LEGACY_RECOVERY_HINT"
}

lease_is_expired() {
  local lease_until_epoch="$1"
  local now_epoch="$2"
  is_positive_integer "$lease_until_epoch" || fail "$LEGACY_RECOVERY_HINT"
  (( lease_until_epoch <= now_epoch ))
}

next_generation() {
  local current_generation="$1"
  if is_positive_integer "$current_generation"; then
    printf '%s\n' "$(( current_generation + 1 ))"
  else
    printf '1\n'
  fi
}

cas_expected_value() {
  local value="$1"
  if is_positive_integer "$value"; then
    printf '%s\n' "$value"
  else
    printf '*\n'
  fi
}

replace_lock_state() {
  local expected_state="$1"
  local expected_holder="$2"
  local expected_operation_id="$3"
  local expected_source_sha="$4"
  local expected_lease_until_epoch="$5"
  local expected_fencing_generation="$6"
  local next_state="$7"
  local next_holder="$8"
  local next_operation_id="$9"
  local next_source_sha="${10}"
  local next_acquired_at_epoch="${11}"
  local next_lease_duration_seconds="${12}"
  local next_lease_until_epoch="${13}"
  local next_released_at_epoch="${14}"
  local next_fencing_generation="${15}"
  kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" -o json |
    python3 -c '
import json
import sys

(
    expected_state,
    expected_holder,
    expected_operation_id,
    expected_source_sha,
    expected_lease_until_epoch,
    expected_fencing_generation,
    next_state,
    next_holder,
    next_operation_id,
    next_source_sha,
    next_acquired_at_epoch,
    next_lease_duration_seconds,
    next_lease_until_epoch,
    next_released_at_epoch,
    next_fencing_generation,
) = sys.argv[1:]
document = json.load(sys.stdin)
data = document.setdefault("data", {})

checks = {
    "state": expected_state,
    "holder": expected_holder,
    "operation-id": expected_operation_id,
    "source-sha": expected_source_sha,
    "lease-until-epoch": expected_lease_until_epoch,
    "fencing-generation": expected_fencing_generation,
}
for key, expected in checks.items():
    if expected != "*" and data.get(key, "") != expected:
        raise SystemExit("lock compare-and-swap precondition failed")

data["state"] = next_state
data["holder"] = next_holder
data["operation-id"] = next_operation_id
data["source-sha"] = next_source_sha
data["acquired-at-epoch"] = next_acquired_at_epoch
data["lease-duration-seconds"] = next_lease_duration_seconds
data["lease-until-epoch"] = next_lease_until_epoch
data["released-at-epoch"] = next_released_at_epoch
data["fencing-generation"] = next_fencing_generation
document.get("metadata", {}).pop("managedFields", None)
json.dump(document, sys.stdout)
' "$expected_state" "$expected_holder" "$expected_operation_id" \
      "$expected_source_sha" "$expected_lease_until_epoch" \
      "$expected_fencing_generation" "$next_state" "$next_holder" \
      "$next_operation_id" "$next_source_sha" "$next_acquired_at_epoch" \
      "$next_lease_duration_seconds" "$next_lease_until_epoch" \
      "$next_released_at_epoch" "$next_fencing_generation" |
    kubectl replace -f - >/dev/null
}

case "$ACTION" in
  acquire)
    validate_identity
    validate_lease
    now_epoch="$(current_epoch)"
    lease_until_epoch="$(( now_epoch + LOCK_LEASE_SECONDS ))"
    if kubectl create configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" \
      --from-literal="state=active" \
      --from-literal="holder=$LOCK_TOKEN" \
      --from-literal="operation-id=$OPERATION_ID" \
      --from-literal="source-sha=$SOURCE_SHA" \
      --from-literal="acquired-at-epoch=$now_epoch" \
      --from-literal="lease-duration-seconds=$LOCK_LEASE_SECONDS" \
      --from-literal="lease-until-epoch=$lease_until_epoch" \
      --from-literal="released-at-epoch=0" \
      --from-literal="fencing-generation=1" \
      >/dev/null 2>&1; then
      echo "shared_mongo_lock=acquire status=PASS lease_until_epoch=$lease_until_epoch"
      exit 0
    fi
    lock_state="$(read_lock_fields)" || fail "unable to read database operation lock"
    IFS='|' read -r state holder operation_id source_sha acquired_at_epoch \
      lease_duration_seconds lease_until_epoch_current released_at_epoch \
      fencing_generation <<<"$lock_state"
    case "$state" in
      released)
        [[ -z "$holder" ]] || fail "released database operation lock must not retain a holder"
        next_fencing_generation="$(next_generation "$fencing_generation")"
        replace_lock_state released "" "*" "*" \
          "$(cas_expected_value "$lease_until_epoch_current")" \
          "$(cas_expected_value "$fencing_generation")" \
          active "$LOCK_TOKEN" "$OPERATION_ID" "$SOURCE_SHA" \
          "$now_epoch" "$LOCK_LEASE_SECONDS" "$lease_until_epoch" "0" \
          "$next_fencing_generation" \
          >/dev/null 2>&1 || fail "another database operation holds $LOCK_CONFIGMAP"
        echo "shared_mongo_lock=acquire status=PASS lease_until_epoch=$lease_until_epoch"
        ;;
      active)
        require_active_lease_metadata \
          "$acquired_at_epoch" \
          "$lease_duration_seconds" \
          "$lease_until_epoch_current" \
          "$fencing_generation"
        lease_is_expired "$lease_until_epoch_current" "$now_epoch" ||
          fail "another database operation holds $LOCK_CONFIGMAP"
        next_fencing_generation="$(next_generation "$fencing_generation")"
        replace_lock_state active "$holder" "$operation_id" "$source_sha" \
          "$lease_until_epoch_current" "$fencing_generation" \
          active "$LOCK_TOKEN" "$OPERATION_ID" "$SOURCE_SHA" \
          "$now_epoch" "$LOCK_LEASE_SECONDS" "$lease_until_epoch" "0" \
          "$next_fencing_generation" \
          >/dev/null 2>&1 || fail "stale database lock changed while reclaiming"
        echo "shared_mongo_lock=acquire status=PASS reclaimed=expired previous_holder=${holder:-none} lease_until_epoch=$lease_until_epoch"
        ;;
      *)
        fail "unexpected database operation lock state"
        ;;
    esac
    ;;
  verify)
    validate_identity
    now_epoch="$(current_epoch)"
    lock_state="$(read_lock_fields)" || fail "unable to read database operation lock"
    IFS='|' read -r state holder operation_id source_sha acquired_at_epoch \
      lease_duration_seconds lease_until_epoch released_at_epoch \
      fencing_generation <<<"$lock_state"
    [[ "$state" == "active" &&
      "$holder" == "$LOCK_TOKEN" &&
      "$operation_id" == "$OPERATION_ID" &&
      "$source_sha" == "$SOURCE_SHA" ]] ||
      fail "active database operation lock does not match the expected handoff"
    require_active_lease_metadata \
      "$acquired_at_epoch" \
      "$lease_duration_seconds" \
      "$lease_until_epoch" \
      "$fencing_generation"
    (( lease_until_epoch > now_epoch )) ||
      fail "active database operation lock has expired"
    echo "shared_mongo_lock=verify status=PASS lease_until_epoch=$lease_until_epoch fencing_generation=$fencing_generation"
    ;;
  renew)
    validate_identity
    validate_lease
    observed_lease_until_epoch=""
    now_epoch="$(current_epoch)"
    lock_state="$(read_lock_fields)" || fail "unable to read database operation lock"
    IFS='|' read -r state holder operation_id source_sha acquired_at_epoch \
      lease_duration_seconds lease_until_epoch released_at_epoch \
      fencing_generation <<<"$lock_state"
    [[ "$state" == "active" &&
      "$holder" == "$LOCK_TOKEN" &&
      "$operation_id" == "$OPERATION_ID" &&
      "$source_sha" == "$SOURCE_SHA" ]] ||
      fail "active database operation lock does not match the expected owner"
    require_active_lease_metadata \
      "$acquired_at_epoch" \
      "$lease_duration_seconds" \
      "$lease_until_epoch" \
      "$fencing_generation"
    if lease_is_expired "$lease_until_epoch" "$now_epoch"; then
      fail "active database operation lock has expired and cannot be renewed"
    fi
    [[ "$acquired_at_epoch" =~ ^[1-9][0-9]*$ ]] || acquired_at_epoch="$now_epoch"
    observed_lease_until_epoch="$lease_until_epoch"
    lease_until_epoch="$(( now_epoch + LOCK_LEASE_SECONDS ))"
    next_fencing_generation="$(next_generation "$fencing_generation")"
    replace_lock_state active "$LOCK_TOKEN" "$OPERATION_ID" "$SOURCE_SHA" \
      "$observed_lease_until_epoch" "$fencing_generation" \
      active "$LOCK_TOKEN" "$OPERATION_ID" "$SOURCE_SHA" \
      "$acquired_at_epoch" "$LOCK_LEASE_SECONDS" "$lease_until_epoch" "0" \
      "$next_fencing_generation" ||
      fail "lock changed while renewing"
    echo "shared_mongo_lock=renew status=PASS lease_until_epoch=$lease_until_epoch fencing_generation=$next_fencing_generation"
    ;;
  verify-released)
    validate_identity
    lock_state="$(read_lock_fields)" || fail "unable to read database operation lock"
    IFS='|' read -r state holder operation_id source_sha acquired_at_epoch \
      lease_duration_seconds lease_until_epoch released_at_epoch \
      fencing_generation <<<"$lock_state"
    [[ "$state" == "released" &&
      -z "$holder" &&
      "$operation_id" == "$OPERATION_ID" &&
      "$source_sha" == "$SOURCE_SHA" ]] ||
      fail "released database operation lock does not match the expected handoff"
    echo "shared_mongo_lock=verify-released status=PASS"
    ;;
  release)
    validate_identity
    error_file="$(mktemp)"
    trap 'rm -f "$error_file"' EXIT
    if ! lock_json="$(
      kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" -o json \
        2>"$error_file"
    )"; then
      if grep -Eqi 'not[ -]?found' "$error_file"; then
        echo "shared_mongo_lock=release status=SKIPPED reason=not-found"
        exit 0
      fi
      fail "unable to read database operation lock"
    fi
    lock_state="$(
      python3 -c '
import json
import sys

data = json.load(sys.stdin).get("data", {})
print("|".join([
    data.get("state", ""),
    data.get("holder", ""),
    data.get("operation-id", ""),
    data.get("source-sha", ""),
    data.get("acquired-at-epoch", ""),
    data.get("lease-until-epoch", ""),
    data.get("fencing-generation", ""),
]))
' <<<"$lock_json"
    )"
    IFS='|' read -r state holder operation_id source_sha acquired_at_epoch \
      lease_until_epoch fencing_generation <<<"$lock_state"
    if [[ "$state" == "released" ]]; then
      echo "shared_mongo_lock=release status=SKIPPED reason=already-released"
      exit 0
    fi
    if [[ "$holder" != "$LOCK_TOKEN" ||
      "$operation_id" != "$OPERATION_ID" ||
      "$source_sha" != "$SOURCE_SHA" ]]; then
      echo "shared_mongo_lock=release status=SKIPPED reason=not-holder"
      exit 0
    fi
    [[ "$acquired_at_epoch" =~ ^[1-9][0-9]*$ ]] || acquired_at_epoch=0
    now_epoch="$(current_epoch)"
    next_fencing_generation="$(next_generation "$fencing_generation")"
    replace_lock_state active "$LOCK_TOKEN" "$OPERATION_ID" "$SOURCE_SHA" \
      "$(cas_expected_value "$lease_until_epoch")" \
      "$(cas_expected_value "$fencing_generation")" \
      released "" "$OPERATION_ID" "$SOURCE_SHA" \
      "$acquired_at_epoch" "0" "0" "$now_epoch" "$next_fencing_generation" ||
      fail "lock changed while releasing"
    echo "shared_mongo_lock=release status=PASS released_at_epoch=$now_epoch"
    ;;
  force-release)
    validate_identity
    [[ "${CONFIRM_FORCE_RELEASE:-}" == "release-matching-stale-database-lock" ]] ||
      fail "CONFIRM_FORCE_RELEASE is missing"
    lock_state="$(read_lock_fields 2>/dev/null || true)"
    IFS='|' read -r state holder operation_id source_sha acquired_at_epoch \
      lease_duration_seconds lease_until_epoch released_at_epoch \
      fencing_generation <<<"$lock_state"
    [[ "$state" == "active" &&
      -n "$holder" &&
      "$operation_id" == "$OPERATION_ID" &&
      "$source_sha" == "$SOURCE_SHA" ]] ||
      fail "stale lock does not match this operation ID and SHA"
    [[ "$acquired_at_epoch" =~ ^[1-9][0-9]*$ ]] || acquired_at_epoch=0
    now_epoch="$(current_epoch)"
    next_fencing_generation="$(next_generation "$fencing_generation")"
    replace_lock_state active "$holder" "$operation_id" "$source_sha" \
      "$(cas_expected_value "$lease_until_epoch")" \
      "$(cas_expected_value "$fencing_generation")" \
      released "" "$OPERATION_ID" "$SOURCE_SHA" \
      "$acquired_at_epoch" "0" "0" "$now_epoch" "$next_fencing_generation" ||
      fail "lock changed while force-releasing"
    echo "shared_mongo_lock=force-release status=PASS released_at_epoch=$now_epoch"
    ;;
  *)
    echo "usage: $0 {acquire|verify|renew|verify-released|release|force-release}" >&2
    exit 2
    ;;
esac
