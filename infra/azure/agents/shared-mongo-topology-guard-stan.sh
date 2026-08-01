#!/usr/bin/env bash
set -euo pipefail

# Purpose: refuse normal deployments unless production has completed the
# one-instance Mongo migration and matches the committed shared topology.

NAMESPACE="${NAMESPACE:-default}"
TOPOLOGY_CONFIGMAP="${TOPOLOGY_CONFIGMAP:-gaming-mongo-topology}"
AUTH_MONGO_STS="${AUTH_MONGO_STS:-gaming-auth-mongo-depl}"
AUTH_MONGO_PVC="${AUTH_MONGO_PVC:-gaming-auth-mongo-data-gaming-auth-mongo-depl-0}"
MIN_AUTH_MONGO_CAPACITY="${MIN_AUTH_MONGO_CAPACITY:-8Gi}"
SHARED_MONGO_SERVICE="${SHARED_MONGO_SERVICE:-gaming-shared-mongo-srv}"

LEGACY_MONGO_STS=(
  gaming-bet-mongo-depl
  gaming-backoffice-mongo-depl
  gaming-event-mongo-depl
  gaming-gamemaster-mongo-depl
  gaming-moderation-mongo-depl
  gaming-resulting-mongo-depl
  gaming-slip-mongo-depl
)

SERVICE_DATABASES=(
  "auth:gaming_auth"
  "bet:gaming_bet"
  "backoffice:gaming_backoffice"
  "event:gaming_event"
  "gamemaster:gaming_gamemaster"
  "moderation:gaming_moderation"
  "resulting:gaming_resulting"
  "slip:gaming_slip"
)

fail() {
  echo "shared_mongo_topology=FAIL reason=$*" >&2
  exit 1
}

quantity_bytes() {
  local quantity="$1"
  local number unit multiplier
  if [[ "$quantity" =~ ^([1-9][0-9]*)(Mi|Gi|Ti)$ ]]; then
    number="${BASH_REMATCH[1]}"
    unit="${BASH_REMATCH[2]}"
  else
    fail "unsupported storage quantity: $quantity"
  fi
  case "$unit" in
    Mi) multiplier=$((1024 * 1024)) ;;
    Gi) multiplier=$((1024 * 1024 * 1024)) ;;
    Ti) multiplier=$((1024 * 1024 * 1024 * 1024)) ;;
  esac
  echo $((number * multiplier))
}

for command_name in kubectl python3; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command missing: $command_name"
done

mode="$(
  kubectl get configmap "$TOPOLOGY_CONFIGMAP" -n "$NAMESPACE" \
    -o jsonpath='{.data.mode}' 2>/dev/null || true
)"
validated="$(
  kubectl get configmap "$TOPOLOGY_CONFIGMAP" -n "$NAMESPACE" \
    -o jsonpath='{.data.validated}' 2>/dev/null || true
)"
migration_id="$(
  kubectl get configmap "$TOPOLOGY_CONFIGMAP" -n "$NAMESPACE" \
    -o jsonpath='{.data.migration-id}' 2>/dev/null || true
)"

[[ "$mode" == "shared" ]] ||
  fail "migration marker mode must be shared"
[[ "$validated" == "true" ]] ||
  fail "migration marker must be validated"
[[ "$migration_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] ||
  fail "migration marker ID is missing or invalid"

auth_sts_state="$(
  kubectl get statefulset "$AUTH_MONGO_STS" -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}|{.status.readyReplicas}|{.status.currentReplicas}' \
    2>/dev/null || true
)"
[[ "$auth_sts_state" == "1|1|1" ]] ||
  fail "$AUTH_MONGO_STS is not exactly one ready replica"

for legacy_sts in "${LEGACY_MONGO_STS[@]}"; do
  if kubectl get statefulset "$legacy_sts" -n "$NAMESPACE" >/dev/null 2>&1; then
    fail "legacy StatefulSet still exists: $legacy_sts"
  fi
done

auth_pvc_state="$(
  kubectl get pvc "$AUTH_MONGO_PVC" -n "$NAMESPACE" \
    -o jsonpath='{.status.phase}' 2>/dev/null || true
)"
[[ "$auth_pvc_state" == "Bound" ]] ||
  fail "$AUTH_MONGO_PVC is not Bound"
auth_pvc_capacity="$(
  kubectl get pvc "$AUTH_MONGO_PVC" -n "$NAMESPACE" \
    -o jsonpath='{.status.capacity.storage}' 2>/dev/null || true
)"
[[ "$(quantity_bytes "$auth_pvc_capacity")" -ge "$(quantity_bytes "$MIN_AUTH_MONGO_CAPACITY")" ]] ||
  fail "$AUTH_MONGO_PVC is smaller than $MIN_AUTH_MONGO_CAPACITY"

mongo_pvcs=()
while IFS= read -r pvc; do
  mongo_pvcs+=("$pvc")
done < <(
  kubectl get pvc -n "$NAMESPACE" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' |
    awk '/mongo/'
)
[[ "${#mongo_pvcs[@]}" -eq 1 && "${mongo_pvcs[0]}" == "$AUTH_MONGO_PVC" ]] ||
  fail "expected only the retained auth Mongo PVC"

service_selector="$(
  kubectl get service "$SHARED_MONGO_SERVICE" -n "$NAMESPACE" \
    -o jsonpath='{.spec.selector.app}' 2>/dev/null || true
)"
[[ "$service_selector" == "gaming-auth-mongo" ]] ||
  fail "$SHARED_MONGO_SERVICE does not select the auth Mongo pod"

for mapping in "${SERVICE_DATABASES[@]}"; do
  IFS=':' read -r service database <<<"$mapping"
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  expected_uri="mongodb://${SHARED_MONGO_SERVICE}:27017/${database}"
  actual_uri="$(
    kubectl get deployment "$deployment" -n "$NAMESPACE" -o json |
      python3 -c '
import json
import sys

container_name = sys.argv[1]
document = json.load(sys.stdin)
values = [
    variable.get("value", "")
    for container in document["spec"]["template"]["spec"]["containers"]
    if container["name"] == container_name
    for variable in container.get("env", [])
    if variable["name"] == "MONGO_URI"
]
print(values[0] if len(values) == 1 else "")
' "$container"
  )"
  [[ "$actual_uri" == "$expected_uri" ]] ||
    fail "$deployment has an unexpected MONGO_URI"
done

echo "shared_mongo_topology=PASS migration_id=$migration_id databases=${#SERVICE_DATABASES[@]}"
