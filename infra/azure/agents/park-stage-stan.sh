#!/usr/bin/env bash
set -euo pipefail

# Purpose: stop stage AKS compute while keeping the stage resource group.

RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg-stage}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks-stage}"
WAIT_SECONDS="${WAIT_SECONDS:-15}"
MAX_WAIT_LOOPS="${MAX_WAIT_LOOPS:-80}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

require_cmd az

if ! az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" >/dev/null 2>&1; then
  echo "ERROR: cluster not found: ${RESOURCE_GROUP}/${CLUSTER_NAME}" >&2
  exit 1
fi

power_state="$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --query "powerState.code" -o tsv)"
echo "stage_cluster_power_state_before=${power_state}"

if [[ "$power_state" != "Stopped" ]]; then
  az aks stop -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" -o none
fi

for _ in $(seq 1 "$MAX_WAIT_LOOPS"); do
  power_state="$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --query "powerState.code" -o tsv)"
  if [[ "$power_state" == "Stopped" ]]; then
    break
  fi
  sleep "$WAIT_SECONDS"
done

power_state="$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --query "powerState.code" -o tsv)"
if [[ "$power_state" != "Stopped" ]]; then
  echo "ERROR: stage cluster did not reach Stopped state (current=${power_state})" >&2
  exit 1
fi

node_rg="$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --query "nodeResourceGroup" -o tsv)"
echo "stage_cluster_power_state_after=${power_state}"
echo "stage_node_resource_group=${node_rg}"

echo "stage_rg_resources:"
az resource list -g "$RESOURCE_GROUP" --query "[].{type:type,name:name}" -o tsv || true

echo "stage_node_rg_billable_like_resources:"
az resource list -g "$node_rg" \
  --query "[?contains(type, 'publicIPAddresses') || contains(type, 'disks') || contains(type, 'loadBalancers') || contains(type, 'virtualMachineScaleSets')].{type:type,name:name}" \
  -o tsv || true

