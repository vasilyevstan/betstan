#!/usr/bin/env bash
set -euo pipefail

# Purpose: enforce a single-node baseline profile on AKS using a larger VM size.
# Safe-by-default: cutover actions are disabled unless EXECUTE_CUTOVER=true.

RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg-stage}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks-stage}"
TARGET_POOL_NAME="${TARGET_POOL_NAME:-nodepool2}"
TARGET_VM_SIZE="${TARGET_VM_SIZE:-Standard_B4ms}"
TARGET_MIN_COUNT="${TARGET_MIN_COUNT:-1}"
TARGET_MAX_COUNT="${TARGET_MAX_COUNT:-3}"
TARGET_INITIAL_COUNT="${TARGET_INITIAL_COUNT:-1}"
LEGACY_POOL_NAME="${LEGACY_POOL_NAME:-nodepool1}"
EXECUTE_CUTOVER="${EXECUTE_CUTOVER:-false}"
DELETE_LEGACY_POOL="${DELETE_LEGACY_POOL:-false}"
NAMESPACE="${NAMESPACE:-default}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

require_cmd az
require_cmd kubectl

if ! az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" >/dev/null 2>&1; then
  echo "ERROR: cluster not found: ${RESOURCE_GROUP}/${CLUSTER_NAME}" >&2
  exit 1
fi

existing_pool="$(az aks nodepool list -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --query "[?name=='${TARGET_POOL_NAME}'].name | [0]" -o tsv)"
if [[ -z "$existing_pool" ]]; then
  az aks nodepool add \
    -g "$RESOURCE_GROUP" \
    --cluster-name "$CLUSTER_NAME" \
    -n "$TARGET_POOL_NAME" \
    --mode System \
    --node-count "$TARGET_INITIAL_COUNT" \
    --node-vm-size "$TARGET_VM_SIZE" \
    --enable-cluster-autoscaler \
    --min-count "$TARGET_MIN_COUNT" \
    --max-count "$TARGET_MAX_COUNT" \
    -o none
fi

az aks nodepool update \
  -g "$RESOURCE_GROUP" \
  --cluster-name "$CLUSTER_NAME" \
  -n "$TARGET_POOL_NAME" \
  --enable-cluster-autoscaler \
  --min-count "$TARGET_MIN_COUNT" \
  --max-count "$TARGET_MAX_COUNT" \
  -o none

az aks get-credentials -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --overwrite-existing >/dev/null
az aks nodepool list -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" \
  --query "[].{name:name,vmSize:vmSize,mode:mode,count:count,enableAutoScaling:enableAutoScaling,minCount:minCount,maxCount:maxCount}" -o json
kubectl get nodes -o wide

if [[ "$EXECUTE_CUTOVER" != "true" ]]; then
  echo "cutover_skipped=true (set EXECUTE_CUTOVER=true to move workloads)"
  exit 0
fi

legacy_nodes="$(kubectl get nodes -l agentpool="${LEGACY_POOL_NAME}" -o name | sed 's#node/##')"
if [[ -n "$legacy_nodes" ]]; then
  for node in $legacy_nodes; do
    kubectl cordon "$node"
  done
  for node in $legacy_nodes; do
    kubectl get pods -n "$NAMESPACE" --field-selector spec.nodeName="$node" -o name | xargs -r kubectl delete -n "$NAMESPACE"
  done
fi

kubectl get pods -n "$NAMESPACE" -o wide

if [[ "$DELETE_LEGACY_POOL" == "true" ]]; then
  if az aks nodepool list -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --query "[?name=='${LEGACY_POOL_NAME}'].name | [0]" -o tsv | grep -q .; then
    az aks nodepool delete -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" -n "$LEGACY_POOL_NAME" -o none
  fi
fi

