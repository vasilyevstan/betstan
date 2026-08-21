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

replace_lock_state() {
  local expected_state="$1"
  local expected_holder="$2"
  local next_state="$3"
  local next_holder="$4"
  kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" -o json |
    python3 -c '
import json
import sys

expected_state, expected_holder, next_state, next_holder, operation_id, source_sha = sys.argv[1:]
document = json.load(sys.stdin)
data = document.setdefault("data", {})
if data.get("state", "") != expected_state or data.get("holder", "") != expected_holder:
    raise SystemExit("lock compare-and-swap precondition failed")
data["state"] = next_state
data["holder"] = next_holder
data["operation-id"] = operation_id
data["source-sha"] = source_sha
document.get("metadata", {}).pop("managedFields", None)
json.dump(document, sys.stdout)
' "$expected_state" "$expected_holder" "$next_state" "$next_holder" \
      "$OPERATION_ID" "$SOURCE_SHA" |
    kubectl replace -f - >/dev/null
}

case "$ACTION" in
  acquire)
    validate_identity
    if kubectl create configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" \
      --from-literal="state=active" \
      --from-literal="holder=$LOCK_TOKEN" \
      --from-literal="operation-id=$OPERATION_ID" \
      --from-literal="source-sha=$SOURCE_SHA" \
      >/dev/null 2>&1; then
      echo "shared_mongo_lock=acquire status=PASS"
      exit 0
    fi
    replace_lock_state released "" active "$LOCK_TOKEN" >/dev/null 2>&1 ||
      fail "another database operation holds $LOCK_CONFIGMAP"
    echo "shared_mongo_lock=acquire status=PASS"
    ;;
  verify)
    validate_identity
    lock_state="$(
      kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" \
        -o jsonpath='{.data.state}|{.data.holder}|{.data.operation-id}|{.data.source-sha}'
    )" || fail "unable to read database operation lock"
    IFS='|' read -r state holder operation_id source_sha <<<"$lock_state"
    [[ "$state" == "active" &&
      "$holder" == "$LOCK_TOKEN" &&
      "$operation_id" == "$OPERATION_ID" &&
      "$source_sha" == "$SOURCE_SHA" ]] ||
      fail "active database operation lock does not match the expected handoff"
    echo "shared_mongo_lock=verify status=PASS"
    ;;
  verify-released)
    validate_identity
    lock_state="$(
      kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" \
        -o jsonpath='{.data.state}|{.data.holder}|{.data.operation-id}|{.data.source-sha}'
    )" || fail "unable to read database operation lock"
    IFS='|' read -r state holder operation_id source_sha <<<"$lock_state"
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
    current_holder="$(
      python3 -c 'import json,sys; print(json.load(sys.stdin).get("data", {}).get("holder", ""))' \
        <<<"$lock_json"
    )"
    if [[ "$current_holder" != "$LOCK_TOKEN" ]]; then
      echo "shared_mongo_lock=release status=SKIPPED reason=not-holder"
      exit 0
    fi
    replace_lock_state active "$LOCK_TOKEN" released "" ||
      fail "lock changed while releasing"
    echo "shared_mongo_lock=release status=PASS"
    ;;
  force-release)
    validate_identity
    [[ "${CONFIRM_FORCE_RELEASE:-}" == "release-matching-stale-database-lock" ]] ||
      fail "CONFIRM_FORCE_RELEASE is missing"
    lock_state="$(
      kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" \
        -o jsonpath='{.data.state}|{.data.holder}|{.data.operation-id}|{.data.source-sha}' \
        2>/dev/null || true
    )"
    IFS='|' read -r state holder operation_id source_sha <<<"$lock_state"
    [[ "$state" == "active" &&
      -n "$holder" &&
      "$operation_id" == "$OPERATION_ID" &&
      "$source_sha" == "$SOURCE_SHA" ]] ||
      fail "stale lock does not match this operation ID and SHA"
    replace_lock_state active "$holder" released "" ||
      fail "lock changed while force-releasing"
    echo "shared_mongo_lock=force-release status=PASS"
    ;;
  *)
    echo "usage: $0 {acquire|verify|verify-released|release|force-release}" >&2
    exit 2
    ;;
esac
