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
  local expected_uid="${16:-*}"
  local expected_resource_version="${17:-*}"
  local expected_acquired_at_epoch="${18:-*}"
  local expected_lease_duration_seconds="${19:-*}"
  local expected_released_at_epoch="${20:-*}"
  local next_incident_manifest_sha256="${21:-*}"
  local next_incident_owner_run_id="${22:-*}"
  local next_incident_restore_run_id="${23:-*}"
  local next_incident_control_sha="${24:-*}"
  local exact_core_preimage="${25:-false}"
  local expected_predecessor_incident_manifest_sha256="${26:-__ABSENT__}"
  local expected_predecessor_incident_owner_run_id="${27:-__ABSENT__}"
  local expected_predecessor_incident_restore_run_id="${28:-__ABSENT__}"
  local expected_predecessor_incident_control_sha="${29:-__ABSENT__}"
  local next_incident_current_run_metadata_sha256="${30:-*}"
  local next_incident_request_created_at_epoch="${31:-*}"
  local next_incident_provider_transition_epoch="${32:-*}"
  local next_incident_predecessor_lease_until_epoch="${33:-*}"
  local next_incident_new_lease_until_epoch="${34:-*}"
  local expected_predecessor_incident_current_run_metadata_sha256="${35:-__ABSENT__}"
  local expected_predecessor_incident_request_created_at_epoch="${36:-__ABSENT__}"
  local expected_predecessor_incident_provider_transition_epoch="${37:-__ABSENT__}"
  local expected_predecessor_incident_predecessor_lease_until_epoch="${38:-__ABSENT__}"
  local expected_predecessor_incident_new_lease_until_epoch="${39:-__ABSENT__}"
  {
    if [[ -n "${LOCK_REPLACE_PREIMAGE_JSON:-}" ]]; then
      printf '%s' "$LOCK_REPLACE_PREIMAGE_JSON"
    else
      kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" -o json
    fi
  } |
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
    expected_uid,
    expected_resource_version,
    expected_acquired_at_epoch,
    expected_lease_duration_seconds,
    expected_released_at_epoch,
    next_incident_manifest_sha256,
    next_incident_owner_run_id,
    next_incident_restore_run_id,
    next_incident_control_sha,
    exact_core_preimage,
    expected_predecessor_incident_manifest_sha256,
    expected_predecessor_incident_owner_run_id,
    expected_predecessor_incident_restore_run_id,
    expected_predecessor_incident_control_sha,
    next_incident_current_run_metadata_sha256,
    next_incident_request_created_at_epoch,
    next_incident_provider_transition_epoch,
    next_incident_predecessor_lease_until_epoch,
    next_incident_new_lease_until_epoch,
    expected_predecessor_incident_current_run_metadata_sha256,
    expected_predecessor_incident_request_created_at_epoch,
    expected_predecessor_incident_provider_transition_epoch,
    expected_predecessor_incident_predecessor_lease_until_epoch,
    expected_predecessor_incident_new_lease_until_epoch,
) = sys.argv[1:]
document = json.load(sys.stdin)
data = document.setdefault("data", {})
if expected_uid != "*" and document.get("metadata", {}).get("uid") != expected_uid:
    raise SystemExit("lock UID compare-and-swap precondition failed")
if (
    expected_resource_version != "*"
    and document.get("metadata", {}).get("resourceVersion")
    != expected_resource_version
):
    raise SystemExit("lock resourceVersion compare-and-swap precondition failed")

checks = {
    "state": expected_state,
    "holder": expected_holder,
    "operation-id": expected_operation_id,
    "source-sha": expected_source_sha,
    "acquired-at-epoch": expected_acquired_at_epoch,
    "lease-duration-seconds": expected_lease_duration_seconds,
    "lease-until-epoch": expected_lease_until_epoch,
    "released-at-epoch": expected_released_at_epoch,
    "fencing-generation": expected_fencing_generation,
}
incident_keys = (
    "incident-manifest-sha256",
    "incident-owner-run-id",
    "incident-restore-run-id",
    "incident-control-sha",
    "incident-current-run-metadata-sha256",
    "incident-request-created-at-epoch",
    "incident-provider-transition-epoch",
    "incident-predecessor-lease-until-epoch",
    "incident-new-lease-until-epoch",
)
expected_incident_values = (
    expected_predecessor_incident_manifest_sha256,
    expected_predecessor_incident_owner_run_id,
    expected_predecessor_incident_restore_run_id,
    expected_predecessor_incident_control_sha,
    expected_predecessor_incident_current_run_metadata_sha256,
    expected_predecessor_incident_request_created_at_epoch,
    expected_predecessor_incident_provider_transition_epoch,
    expected_predecessor_incident_predecessor_lease_until_epoch,
    expected_predecessor_incident_new_lease_until_epoch,
)
if any(key.startswith("incident-") and key not in incident_keys for key in data):
    raise SystemExit("lock preimage contains an unknown incident field")
if all(value == "__ABSENT__" for value in expected_incident_values):
    if any(key in data for key in incident_keys):
        raise SystemExit("lock preimage contains an unnamed incident predecessor")
    expected_incident = {}
elif any(value in {"*", "__ABSENT__"} for value in expected_incident_values):
    raise SystemExit("lock incident predecessor binding is incomplete")
else:
    expected_incident = dict(zip(incident_keys, expected_incident_values))
    if any(data.get(key) != value for key, value in expected_incident.items()):
        raise SystemExit("lock incident predecessor binding differs")
for key, expected in checks.items():
    if expected != "*" and data.get(key, "") != expected:
        raise SystemExit("lock compare-and-swap precondition failed")
allowed_keys = set(checks) | set(expected_incident)
if exact_core_preimage == "true" and set(data) != allowed_keys:
    raise SystemExit("lock compare-and-swap preimage contains unexpected fields")
if exact_core_preimage not in {"true", "false"}:
    raise SystemExit("lock compare-and-swap exact-preimage mode is invalid")

data["state"] = next_state
data["holder"] = next_holder
data["operation-id"] = next_operation_id
data["source-sha"] = next_source_sha
data["acquired-at-epoch"] = next_acquired_at_epoch
data["lease-duration-seconds"] = next_lease_duration_seconds
data["lease-until-epoch"] = next_lease_until_epoch
data["released-at-epoch"] = next_released_at_epoch
data["fencing-generation"] = next_fencing_generation
incident_values = {
    "incident-manifest-sha256": next_incident_manifest_sha256,
    "incident-owner-run-id": next_incident_owner_run_id,
    "incident-restore-run-id": next_incident_restore_run_id,
    "incident-control-sha": next_incident_control_sha,
    "incident-current-run-metadata-sha256":
        next_incident_current_run_metadata_sha256,
    "incident-request-created-at-epoch":
        next_incident_request_created_at_epoch,
    "incident-provider-transition-epoch":
        next_incident_provider_transition_epoch,
    "incident-predecessor-lease-until-epoch":
        next_incident_predecessor_lease_until_epoch,
    "incident-new-lease-until-epoch":
        next_incident_new_lease_until_epoch,
}
for key in incident_keys:
    data.pop(key, None)
next_incident = tuple(incident_values.values())
if all(value == "*" for value in next_incident):
    pass
elif any(value == "*" for value in next_incident):
    raise SystemExit("next incident binding is incomplete")
else:
    data.update(incident_values)
document.get("metadata", {}).pop("managedFields", None)
json.dump(document, sys.stdout)
' "$expected_state" "$expected_holder" "$expected_operation_id" \
      "$expected_source_sha" "$expected_lease_until_epoch" \
      "$expected_fencing_generation" "$next_state" "$next_holder" \
      "$next_operation_id" "$next_source_sha" "$next_acquired_at_epoch" \
      "$next_lease_duration_seconds" "$next_lease_until_epoch" \
      "$next_released_at_epoch" "$next_fencing_generation" "$expected_uid" \
      "$expected_resource_version" "$expected_acquired_at_epoch" \
      "$expected_lease_duration_seconds" "$expected_released_at_epoch" \
      "$next_incident_manifest_sha256" "$next_incident_owner_run_id" \
      "$next_incident_restore_run_id" "$next_incident_control_sha" \
      "$exact_core_preimage" \
      "$expected_predecessor_incident_manifest_sha256" \
      "$expected_predecessor_incident_owner_run_id" \
      "$expected_predecessor_incident_restore_run_id" \
      "$expected_predecessor_incident_control_sha" \
      "$next_incident_current_run_metadata_sha256" \
      "$next_incident_request_created_at_epoch" \
      "$next_incident_provider_transition_epoch" \
      "$next_incident_predecessor_lease_until_epoch" \
      "$next_incident_new_lease_until_epoch" \
      "$expected_predecessor_incident_current_run_metadata_sha256" \
      "$expected_predecessor_incident_request_created_at_epoch" \
      "$expected_predecessor_incident_provider_transition_epoch" \
      "$expected_predecessor_incident_predecessor_lease_until_epoch" \
      "$expected_predecessor_incident_new_lease_until_epoch" |
    kubectl replace -f - >/dev/null
}

case "$ACTION" in
  replace-expired-active)
    validate_identity
    validate_lease
    [[ "$OPERATION_ID" = "live-data-incident-restore" ]] ||
      fail "replace-expired-active is restricted to live-data-incident-restore"
    [[ "${EXPECTED_LOCK_UID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ &&
       "${EXPECTED_RESOURCE_VERSION:-}" =~ ^[1-9][0-9]{0,127}$ &&
       "${EXPECTED_LOCK_HOLDER:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ &&
       "${EXPECTED_LOCK_OPERATION_ID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ &&
       "${EXPECTED_LOCK_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ &&
       "${EXPECTED_ACQUIRED_AT_EPOCH:-}" =~ ^[1-9][0-9]{0,15}$ &&
       "${EXPECTED_LEASE_DURATION_SECONDS:-}" =~ ^[1-9][0-9]{0,4}$ &&
       "${EXPECTED_LEASE_UNTIL_EPOCH:-}" =~ ^[1-9][0-9]{0,15}$ &&
       "${EXPECTED_RELEASED_AT_EPOCH:-}" = "0" &&
       "${EXPECTED_FENCING_GENERATION:-}" =~ ^[1-9][0-9]{0,15}$ ]] ||
      fail "replace-expired-active requires the complete expected active preimage"
    [[ "${EXPECTED_INCIDENT_MANIFEST_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] ||
      fail "EXPECTED_INCIDENT_MANIFEST_SHA256 is invalid"
    [[ "${EXPECTED_INCIDENT_OWNER_RUN_ID:-}" =~ ^[1-9][0-9]*$ &&
       "${EXPECTED_INCIDENT_RUN_ID:-}" =~ ^[1-9][0-9]*$ &&
       "${EXPECTED_INCIDENT_CONTROL_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
      fail "replace-expired-active incident run/control binding is invalid"
    [[ "${REQUEST_CURRENT_RUN_METADATA_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] ||
      fail "REQUEST_CURRENT_RUN_METADATA_SHA256 is invalid"
    [[ "${REQUEST_CREATED_AT_EPOCH:-}" =~ ^[1-9][0-9]{0,15}$ ]] ||
      fail "REQUEST_CREATED_AT_EPOCH must be a positive integer"
    [[ "${PROVIDER_TRANSITION_EPOCH:-}" =~ ^[1-9][0-9]{0,15}$ ]] ||
      fail "PROVIDER_TRANSITION_EPOCH must be a positive integer"
    [[ "$LOCK_TOKEN" = "live-data-incident-${EXPECTED_INCIDENT_RUN_ID}-1" &&
       "$SOURCE_SHA" = "$EXPECTED_INCIDENT_CONTROL_SHA" ]] ||
      fail "replace-expired-active owner does not match the incident run/control binding"
    predecessor_manifest="${EXPECTED_PREDECESSOR_INCIDENT_MANIFEST_SHA256:-__ABSENT__}"
    predecessor_owner="${EXPECTED_PREDECESSOR_INCIDENT_OWNER_RUN_ID:-__ABSENT__}"
    predecessor_restore="${EXPECTED_PREDECESSOR_INCIDENT_RESTORE_RUN_ID:-__ABSENT__}"
    predecessor_control="${EXPECTED_PREDECESSOR_INCIDENT_CONTROL_SHA:-__ABSENT__}"
    predecessor_run_metadata="${EXPECTED_PREDECESSOR_INCIDENT_CURRENT_RUN_METADATA_SHA256:-__ABSENT__}"
    predecessor_request_created="${EXPECTED_PREDECESSOR_INCIDENT_REQUEST_CREATED_AT_EPOCH:-__ABSENT__}"
    predecessor_transition="${EXPECTED_PREDECESSOR_INCIDENT_PROVIDER_TRANSITION_EPOCH:-__ABSENT__}"
    predecessor_cutoff="${EXPECTED_PREDECESSOR_INCIDENT_PREDECESSOR_LEASE_UNTIL_EPOCH:-__ABSENT__}"
    predecessor_new_lease="${EXPECTED_PREDECESSOR_INCIDENT_NEW_LEASE_UNTIL_EPOCH:-__ABSENT__}"
    predecessor_absent="__ABSENT____ABSENT____ABSENT____ABSENT____ABSENT____ABSENT____ABSENT____ABSENT____ABSENT__"
    if [[ "$predecessor_manifest$predecessor_owner$predecessor_restore$predecessor_control$predecessor_run_metadata$predecessor_request_created$predecessor_transition$predecessor_cutoff$predecessor_new_lease" != "$predecessor_absent" ]]; then
      [[ "$predecessor_manifest" =~ ^[0-9a-f]{64}$ &&
         "$predecessor_owner" =~ ^[1-9][0-9]*$ &&
         "$predecessor_restore" =~ ^[1-9][0-9]*$ &&
         "$predecessor_control" =~ ^[0-9a-f]{40}$ &&
         "$predecessor_run_metadata" =~ ^[0-9a-f]{64}$ ]] ||
        fail "replace-expired-active predecessor incident binding is incomplete or invalid"
      is_positive_integer "$predecessor_request_created" ||
        fail "replace-expired-active predecessor request epoch is invalid"
      is_positive_integer "$predecessor_transition" ||
        fail "replace-expired-active predecessor transition epoch is invalid"
      is_positive_integer "$predecessor_cutoff" ||
        fail "replace-expired-active predecessor cutoff is invalid"
      is_positive_integer "$predecessor_new_lease" ||
        fail "replace-expired-active predecessor new lease is invalid"
      (( predecessor_request_created > predecessor_cutoff &&
         predecessor_transition >= predecessor_request_created &&
         predecessor_transition == EXPECTED_ACQUIRED_AT_EPOCH &&
         predecessor_new_lease == EXPECTED_LEASE_UNTIL_EPOCH &&
         predecessor_new_lease ==
           predecessor_transition + EXPECTED_LEASE_DURATION_SECONDS )) ||
        fail "replace-expired-active predecessor timing binding is inconsistent"
    fi
    (( EXPECTED_LEASE_DURATION_SECONDS >= 60 &&
       EXPECTED_LEASE_DURATION_SECONDS <= 86400 &&
       EXPECTED_FENCING_GENERATION < 9007199254740991 )) ||
      fail "replace-expired-active preimage lease or generation is out of range"

    (( EXPECTED_ACQUIRED_AT_EPOCH < EXPECTED_LEASE_UNTIL_EPOCH &&
       REQUEST_CREATED_AT_EPOCH > EXPECTED_LEASE_UNTIL_EPOCH )) ||
      fail "incident request was not created strictly after the exact expired lease"
    (( PROVIDER_TRANSITION_EPOCH >= REQUEST_CREATED_AT_EPOCH &&
       PROVIDER_TRANSITION_EPOCH > EXPECTED_LEASE_UNTIL_EPOCH )) ||
      fail "provider transition epoch is stale for the exact expired lease"
    lease_until_epoch="$(( PROVIDER_TRANSITION_EPOCH + LOCK_LEASE_SECONDS ))"
    next_fencing_generation="$(( EXPECTED_FENCING_GENERATION + 1 ))"
    if ! lock_json="$(
      kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" -o json
    )"; then
      fail "replace-expired-active could not read the expected preimage"
    fi
    if ! python3 - \
      "$lock_json" \
      "$EXPECTED_LOCK_UID" \
      "$EXPECTED_RESOURCE_VERSION" \
      "$EXPECTED_LOCK_HOLDER" \
      "$EXPECTED_LOCK_OPERATION_ID" \
      "$EXPECTED_LOCK_SOURCE_SHA" \
      "$EXPECTED_ACQUIRED_AT_EPOCH" \
      "$EXPECTED_LEASE_DURATION_SECONDS" \
      "$EXPECTED_LEASE_UNTIL_EPOCH" \
      "$EXPECTED_RELEASED_AT_EPOCH" \
      "$EXPECTED_FENCING_GENERATION" \
      "$predecessor_manifest" \
      "$predecessor_owner" \
      "$predecessor_restore" \
      "$predecessor_control" \
      "$predecessor_run_metadata" \
      "$predecessor_request_created" \
      "$predecessor_transition" \
      "$predecessor_cutoff" \
      "$predecessor_new_lease" <<'PY'
import json
import sys

document = json.loads(sys.argv[1])
expected = sys.argv[2:12]
predecessor = sys.argv[12:]
metadata = document.get("metadata")
data = document.get("data")
if not isinstance(metadata, dict) or not isinstance(data, dict):
    raise SystemExit("lock preimage is malformed")
if metadata.get("uid") != expected[0] or metadata.get("resourceVersion") != expected[1]:
    raise SystemExit("lock preimage identity changed")
keys = (
    "holder",
    "operation-id",
    "source-sha",
    "acquired-at-epoch",
    "lease-duration-seconds",
    "lease-until-epoch",
    "released-at-epoch",
    "fencing-generation",
)
expected_data = {"state": "active", **dict(zip(keys, expected[2:]))}
incident_keys = (
    "incident-manifest-sha256",
    "incident-owner-run-id",
    "incident-restore-run-id",
    "incident-control-sha",
    "incident-current-run-metadata-sha256",
    "incident-request-created-at-epoch",
    "incident-provider-transition-epoch",
    "incident-predecessor-lease-until-epoch",
    "incident-new-lease-until-epoch",
)
if all(value == "__ABSENT__" for value in predecessor):
    pass
elif any(value == "__ABSENT__" for value in predecessor):
    raise SystemExit("lock predecessor incident binding is incomplete")
else:
    expected_data.update(dict(zip(incident_keys, predecessor)))
if data != expected_data:
    raise SystemExit("lock preimage changed")
PY
    then
      fail "replace-expired-active observed a lock that differs from the complete expected preimage"
    fi

    export LOCK_REPLACE_PREIMAGE_JSON="$lock_json"
    if replace_lock_state \
      active \
      "$EXPECTED_LOCK_HOLDER" \
      "$EXPECTED_LOCK_OPERATION_ID" \
      "$EXPECTED_LOCK_SOURCE_SHA" \
      "$EXPECTED_LEASE_UNTIL_EPOCH" \
      "$EXPECTED_FENCING_GENERATION" \
      active \
      "$LOCK_TOKEN" \
      "$OPERATION_ID" \
      "$SOURCE_SHA" \
      "$PROVIDER_TRANSITION_EPOCH" \
      "$LOCK_LEASE_SECONDS" \
      "$lease_until_epoch" \
      "0" \
      "$next_fencing_generation" \
      "$EXPECTED_LOCK_UID" \
      "$EXPECTED_RESOURCE_VERSION" \
      "$EXPECTED_ACQUIRED_AT_EPOCH" \
      "$EXPECTED_LEASE_DURATION_SECONDS" \
      "$EXPECTED_RELEASED_AT_EPOCH" \
      "$EXPECTED_INCIDENT_MANIFEST_SHA256" \
      "$EXPECTED_INCIDENT_OWNER_RUN_ID" \
      "$EXPECTED_INCIDENT_RUN_ID" \
      "$EXPECTED_INCIDENT_CONTROL_SHA" \
      true \
      "$predecessor_manifest" \
      "$predecessor_owner" \
      "$predecessor_restore" \
      "$predecessor_control" \
      "$REQUEST_CURRENT_RUN_METADATA_SHA256" \
      "$REQUEST_CREATED_AT_EPOCH" \
      "$PROVIDER_TRANSITION_EPOCH" \
      "$EXPECTED_LEASE_UNTIL_EPOCH" \
      "$lease_until_epoch" \
      "$predecessor_run_metadata" \
      "$predecessor_request_created" \
      "$predecessor_transition" \
      "$predecessor_cutoff" \
      "$predecessor_new_lease"; then
      unset LOCK_REPLACE_PREIMAGE_JSON
      echo "shared_mongo_lock=replace-expired-active status=PASS result=applied current_run_metadata_sha256=$REQUEST_CURRENT_RUN_METADATA_SHA256 request_created_at_epoch=$REQUEST_CREATED_AT_EPOCH provider_transition_epoch=$PROVIDER_TRANSITION_EPOCH predecessor_lease_until_epoch=$EXPECTED_LEASE_UNTIL_EPOCH lease_until_epoch=$lease_until_epoch fencing_generation=$next_fencing_generation"
      exit 0
    fi
    unset LOCK_REPLACE_PREIMAGE_JSON

    if ! observed_json="$(
      kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" -o json
    )"; then
      fail "replace-expired-active result is ambiguous after the single replace"
    fi
    classification="$(
      python3 - \
        "$observed_json" \
        "$EXPECTED_LOCK_UID" \
        "$EXPECTED_RESOURCE_VERSION" \
        "$EXPECTED_LOCK_HOLDER" \
        "$EXPECTED_LOCK_OPERATION_ID" \
        "$EXPECTED_LOCK_SOURCE_SHA" \
        "$EXPECTED_ACQUIRED_AT_EPOCH" \
        "$EXPECTED_LEASE_DURATION_SECONDS" \
        "$EXPECTED_LEASE_UNTIL_EPOCH" \
        "$EXPECTED_RELEASED_AT_EPOCH" \
        "$EXPECTED_FENCING_GENERATION" \
        "$LOCK_TOKEN" \
        "$OPERATION_ID" \
        "$SOURCE_SHA" \
        "$PROVIDER_TRANSITION_EPOCH" \
        "$LOCK_LEASE_SECONDS" \
        "$lease_until_epoch" \
        "$next_fencing_generation" \
        "$EXPECTED_INCIDENT_MANIFEST_SHA256" \
        "$EXPECTED_INCIDENT_OWNER_RUN_ID" \
        "$EXPECTED_INCIDENT_RUN_ID" \
        "$EXPECTED_INCIDENT_CONTROL_SHA" \
        "$predecessor_manifest" \
        "$predecessor_owner" \
        "$predecessor_restore" \
        "$predecessor_control" \
        "$REQUEST_CURRENT_RUN_METADATA_SHA256" \
        "$REQUEST_CREATED_AT_EPOCH" \
        "$PROVIDER_TRANSITION_EPOCH" \
        "$EXPECTED_LEASE_UNTIL_EPOCH" \
        "$lease_until_epoch" \
        "$predecessor_run_metadata" \
        "$predecessor_request_created" \
        "$predecessor_transition" \
        "$predecessor_cutoff" \
        "$predecessor_new_lease" <<'PY'
import json
import re
import sys

(
    uid,
    resource_version,
    old_holder,
    old_operation,
    old_source,
    old_acquired,
    old_duration,
    old_until,
    old_released,
    old_generation,
    new_holder,
    new_operation,
    new_source,
    new_acquired,
    new_duration,
    new_until,
    new_generation,
    manifest_sha256,
    owner_run_id,
    restore_run_id,
    control_sha,
    predecessor_manifest_sha256,
    predecessor_owner_run_id,
    predecessor_restore_run_id,
    predecessor_control_sha,
    current_run_metadata_sha256,
    request_created_at_epoch,
    provider_transition_epoch,
    predecessor_lease_until_epoch,
    new_lease_until_epoch,
    predecessor_run_metadata_sha256,
    predecessor_request_created_at_epoch,
    predecessor_provider_transition_epoch,
    predecessor_predecessor_lease_until_epoch,
    predecessor_new_lease_until_epoch,
) = sys.argv[2:]
document = json.loads(sys.argv[1])
metadata = document.get("metadata")
data = document.get("data")
if not isinstance(metadata, dict) or not isinstance(data, dict):
    print("ambiguous")
    raise SystemExit
preimage = {
    "state": "active",
    "holder": old_holder,
    "operation-id": old_operation,
    "source-sha": old_source,
    "acquired-at-epoch": old_acquired,
    "lease-duration-seconds": old_duration,
    "lease-until-epoch": old_until,
    "released-at-epoch": old_released,
    "fencing-generation": old_generation,
}
predecessor = (
    predecessor_manifest_sha256,
    predecessor_owner_run_id,
    predecessor_restore_run_id,
    predecessor_control_sha,
    predecessor_run_metadata_sha256,
    predecessor_request_created_at_epoch,
    predecessor_provider_transition_epoch,
    predecessor_predecessor_lease_until_epoch,
    predecessor_new_lease_until_epoch,
)
if not all(value == "__ABSENT__" for value in predecessor):
    preimage.update({
        "incident-manifest-sha256": predecessor_manifest_sha256,
        "incident-owner-run-id": predecessor_owner_run_id,
        "incident-restore-run-id": predecessor_restore_run_id,
        "incident-control-sha": predecessor_control_sha,
        "incident-current-run-metadata-sha256":
            predecessor_run_metadata_sha256,
        "incident-request-created-at-epoch":
            predecessor_request_created_at_epoch,
        "incident-provider-transition-epoch":
            predecessor_provider_transition_epoch,
        "incident-predecessor-lease-until-epoch":
            predecessor_predecessor_lease_until_epoch,
        "incident-new-lease-until-epoch":
            predecessor_new_lease_until_epoch,
    })
postimage = {
    "state": "active",
    "holder": new_holder,
    "operation-id": new_operation,
    "source-sha": new_source,
    "acquired-at-epoch": new_acquired,
    "lease-duration-seconds": new_duration,
    "lease-until-epoch": new_until,
    "released-at-epoch": "0",
    "fencing-generation": new_generation,
    "incident-manifest-sha256": manifest_sha256,
    "incident-owner-run-id": owner_run_id,
    "incident-restore-run-id": restore_run_id,
    "incident-control-sha": control_sha,
    "incident-current-run-metadata-sha256": current_run_metadata_sha256,
    "incident-request-created-at-epoch": request_created_at_epoch,
    "incident-provider-transition-epoch": provider_transition_epoch,
    "incident-predecessor-lease-until-epoch":
        predecessor_lease_until_epoch,
    "incident-new-lease-until-epoch": new_lease_until_epoch,
}
observed_uid = metadata.get("uid")
observed_version = metadata.get("resourceVersion")
if observed_uid == uid and observed_version == resource_version and data == preimage:
    print("not-applied")
elif (
    observed_uid == uid
    and isinstance(observed_version, str)
    and re.fullmatch(r"[1-9][0-9]*", observed_version)
    and observed_version != resource_version
    and data == postimage
):
    print("applied")
else:
    print("ambiguous")
PY
    )" || fail "replace-expired-active result classification failed"
    case "$classification" in
      applied)
        echo "shared_mongo_lock=replace-expired-active status=PASS result=applied-after-reread current_run_metadata_sha256=$REQUEST_CURRENT_RUN_METADATA_SHA256 request_created_at_epoch=$REQUEST_CREATED_AT_EPOCH provider_transition_epoch=$PROVIDER_TRANSITION_EPOCH predecessor_lease_until_epoch=$EXPECTED_LEASE_UNTIL_EPOCH lease_until_epoch=$lease_until_epoch fencing_generation=$next_fencing_generation"
        ;;
      not-applied)
        fail "replace-expired-active was not applied; no retry is permitted"
        ;;
      *)
        fail "replace-expired-active result is ambiguous after the single replace"
        ;;
    esac
    ;;
  acquire-released)
    validate_identity
    validate_lease
    [[ "${EXPECTED_LOCK_UID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] ||
      fail "EXPECTED_LOCK_UID is required for released-only acquisition"
    [[ "${EXPECTED_FENCING_GENERATION:-}" =~ ^[1-9][0-9]{0,15}$ ]] ||
      fail "EXPECTED_FENCING_GENERATION is required for released-only acquisition"
    (( EXPECTED_FENCING_GENERATION < 9007199254740991 )) ||
      fail "released-only fencing generation exceeds the safe increment range"
    now_epoch="$(current_epoch)"
    lease_until_epoch="$(( now_epoch + LOCK_LEASE_SECONDS ))"
    next_fencing_generation="$(( EXPECTED_FENCING_GENERATION + 1 ))"
    replace_lock_state released "" "*" "*" "*" "$EXPECTED_FENCING_GENERATION" \
      active "$LOCK_TOKEN" "$OPERATION_ID" "$SOURCE_SHA" \
      "$now_epoch" "$LOCK_LEASE_SECONDS" "$lease_until_epoch" "0" \
      "$next_fencing_generation" "$EXPECTED_LOCK_UID" ||
      fail "observed released database operation lock changed before acquisition"
    echo "shared_mongo_lock=acquire-released status=PASS lease_until_epoch=$lease_until_epoch fencing_generation=$next_fencing_generation"
    ;;
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
    strict_release=false
    if [[ -n "${EXPECTED_LOCK_UID:-}${EXPECTED_RESOURCE_VERSION:-}${EXPECTED_FENCING_GENERATION:-}${EXPECTED_LEASE_UNTIL_EPOCH:-}" ]]; then
      strict_release=true
      [[ "${EXPECTED_LOCK_UID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ &&
         "${EXPECTED_RESOURCE_VERSION:-}" =~ ^[1-9][0-9]{0,127}$ &&
         "${EXPECTED_FENCING_GENERATION:-}" =~ ^[1-9][0-9]{0,15}$ &&
         "${EXPECTED_LEASE_UNTIL_EPOCH:-}" =~ ^[1-9][0-9]{0,15}$ ]] ||
        fail "strict release requires a complete valid expected lock snapshot"
      (( EXPECTED_FENCING_GENERATION < 9007199254740990 )) ||
        fail "strict release fencing generation exceeds the safe handoff range"
    fi
    error_file="$(mktemp)"
    trap 'rm -f "$error_file"' EXIT
    if ! lock_json="$(
      kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" -o json \
        2>"$error_file"
    )"; then
      if grep -Eqi 'not[ -]?found' "$error_file"; then
        [[ "$strict_release" == "false" ]] ||
          fail "strict release expected an existing owned lock"
        echo "shared_mongo_lock=release status=SKIPPED reason=not-found"
        exit 0
      fi
      fail "unable to read database operation lock"
    fi
    lock_state="$(
      python3 -c '
import json
import sys

document = json.load(sys.stdin)
data = document.get("data", {})
print("|".join([
    data.get("state", ""),
    data.get("holder", ""),
    data.get("operation-id", ""),
    data.get("source-sha", ""),
    data.get("acquired-at-epoch", ""),
    data.get("lease-duration-seconds", ""),
    data.get("lease-until-epoch", ""),
    data.get("fencing-generation", ""),
    document.get("metadata", {}).get("uid", ""),
    document.get("metadata", {}).get("resourceVersion", ""),
]))
' <<<"$lock_json"
    )"
    IFS='|' read -r state holder operation_id source_sha acquired_at_epoch \
      lease_duration_seconds lease_until_epoch fencing_generation \
      observed_uid observed_resource_version <<<"$lock_state"
    if [[ "$state" == "released" ]]; then
      [[ "$strict_release" == "false" ]] ||
        fail "strict release cannot consume an already released lock"
      echo "shared_mongo_lock=release status=SKIPPED reason=already-released"
      exit 0
    fi
    if [[ "$holder" != "$LOCK_TOKEN" ||
      "$operation_id" != "$OPERATION_ID" ||
      "$source_sha" != "$SOURCE_SHA" ]]; then
      [[ "$strict_release" == "false" ]] ||
        fail "strict release lock does not match the expected owner"
      echo "shared_mongo_lock=release status=SKIPPED reason=not-holder"
      exit 0
    fi
    now_epoch="$(current_epoch)"
    if [[ "$strict_release" == "true" ]]; then
      [[ "$state" == "active" &&
         "$observed_uid" == "$EXPECTED_LOCK_UID" &&
         "$observed_resource_version" == "$EXPECTED_RESOURCE_VERSION" &&
         "$fencing_generation" == "$EXPECTED_FENCING_GENERATION" &&
         "$lease_until_epoch" == "$EXPECTED_LEASE_UNTIL_EPOCH" ]] ||
        fail "strict release lock differs from the observed snapshot"
      [[ "$acquired_at_epoch" =~ ^[1-9][0-9]{0,15}$ &&
         "$lease_duration_seconds" =~ ^[1-9][0-9]{0,4}$ ]] ||
        fail "strict release lease metadata is invalid"
      (( acquired_at_epoch <= now_epoch &&
         lease_until_epoch > acquired_at_epoch &&
         lease_duration_seconds >= 60 && lease_duration_seconds <= 86400 )) ||
        fail "strict release lease metadata is inconsistent"
    else
      [[ "$acquired_at_epoch" =~ ^[1-9][0-9]*$ ]] || acquired_at_epoch=0
    fi
    next_fencing_generation="$(next_generation "$fencing_generation")"
    predecessor_manifest="${EXPECTED_PREDECESSOR_INCIDENT_MANIFEST_SHA256:-__ABSENT__}"
    predecessor_owner="${EXPECTED_PREDECESSOR_INCIDENT_OWNER_RUN_ID:-__ABSENT__}"
    predecessor_restore="${EXPECTED_PREDECESSOR_INCIDENT_RESTORE_RUN_ID:-__ABSENT__}"
    predecessor_control="${EXPECTED_PREDECESSOR_INCIDENT_CONTROL_SHA:-__ABSENT__}"
    predecessor_run_metadata="${EXPECTED_PREDECESSOR_INCIDENT_CURRENT_RUN_METADATA_SHA256:-__ABSENT__}"
    predecessor_request_created="${EXPECTED_PREDECESSOR_INCIDENT_REQUEST_CREATED_AT_EPOCH:-__ABSENT__}"
    predecessor_transition="${EXPECTED_PREDECESSOR_INCIDENT_PROVIDER_TRANSITION_EPOCH:-__ABSENT__}"
    predecessor_cutoff="${EXPECTED_PREDECESSOR_INCIDENT_PREDECESSOR_LEASE_UNTIL_EPOCH:-__ABSENT__}"
    predecessor_new_lease="${EXPECTED_PREDECESSOR_INCIDENT_NEW_LEASE_UNTIL_EPOCH:-__ABSENT__}"
    predecessor_absent="__ABSENT____ABSENT____ABSENT____ABSENT____ABSENT____ABSENT____ABSENT____ABSENT____ABSENT__"
    if [[ "$predecessor_manifest$predecessor_owner$predecessor_restore$predecessor_control$predecessor_run_metadata$predecessor_request_created$predecessor_transition$predecessor_cutoff$predecessor_new_lease" != "$predecessor_absent" ]]; then
      [[ "$predecessor_manifest" =~ ^[0-9a-f]{64}$ &&
         "$predecessor_owner" =~ ^[1-9][0-9]*$ &&
         "$predecessor_restore" =~ ^[1-9][0-9]*$ &&
         "$predecessor_control" =~ ^[0-9a-f]{40}$ &&
         "$predecessor_run_metadata" =~ ^[0-9a-f]{64}$ &&
         "$predecessor_request_created" =~ ^[1-9][0-9]*$ &&
         "$predecessor_transition" =~ ^[1-9][0-9]*$ &&
         "$predecessor_cutoff" =~ ^[1-9][0-9]*$ &&
         "$predecessor_new_lease" =~ ^[1-9][0-9]*$ ]] ||
        fail "release predecessor incident binding is incomplete or invalid"
      (( predecessor_request_created > predecessor_cutoff &&
         predecessor_transition >= predecessor_request_created &&
         predecessor_transition == acquired_at_epoch &&
         predecessor_new_lease == lease_until_epoch &&
         predecessor_new_lease ==
           predecessor_transition + lease_duration_seconds )) ||
        fail "release predecessor incident timing binding is inconsistent"
    fi
    replace_lock_state active "$LOCK_TOKEN" "$OPERATION_ID" "$SOURCE_SHA" \
      "$(cas_expected_value "$lease_until_epoch")" \
      "$(cas_expected_value "$fencing_generation")" \
      released "" "$OPERATION_ID" "$SOURCE_SHA" \
      "$acquired_at_epoch" "0" "0" "$now_epoch" "$next_fencing_generation" \
      "${EXPECTED_LOCK_UID:-*}" "${EXPECTED_RESOURCE_VERSION:-*}" \
      "*" "*" "*" "*" "*" "*" "*" false \
      "$predecessor_manifest" "$predecessor_owner" "$predecessor_restore" \
      "$predecessor_control" \
      "*" "*" "*" "*" "*" \
      "$predecessor_run_metadata" "$predecessor_request_created" \
      "$predecessor_transition" "$predecessor_cutoff" \
      "$predecessor_new_lease" ||
      fail "lock changed while releasing"
    if [[ "$strict_release" == "true" ]]; then
      echo "shared_mongo_lock=release status=PASS released_at_epoch=$now_epoch strict_snapshot=true fencing_generation=$next_fencing_generation"
    else
      echo "shared_mongo_lock=release status=PASS released_at_epoch=$now_epoch"
    fi
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
    echo "usage: $0 {acquire|acquire-released|replace-expired-active|verify|renew|verify-released|release|force-release}" >&2
    exit 2
    ;;
esac
