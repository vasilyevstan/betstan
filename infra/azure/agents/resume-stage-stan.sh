#!/usr/bin/env bash
set -euo pipefail

# Purpose: resume stage AKS compute and optionally run quick readiness checks.

RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg-stage}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks-stage}"
WAIT_SECONDS="${WAIT_SECONDS:-20}"
MAX_WAIT_LOOPS="${MAX_WAIT_LOOPS:-90}"
RUN_HEALTH_CHECKS="${RUN_HEALTH_CHECKS:-true}"

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

power_state="$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --query "powerState.code" -o tsv)"
echo "stage_cluster_power_state_before=${power_state}"

if [[ "$power_state" != "Running" ]]; then
  az aks start -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" -o none
fi

for _ in $(seq 1 "$MAX_WAIT_LOOPS"); do
  power_state="$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --query "powerState.code" -o tsv)"
  if [[ "$power_state" == "Running" ]]; then
    break
  fi
  sleep "$WAIT_SECONDS"
done

power_state="$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --query "powerState.code" -o tsv)"
if [[ "$power_state" != "Running" ]]; then
  echo "ERROR: stage cluster did not reach Running state (current=${power_state})" >&2
  exit 1
fi

az aks get-credentials -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --overwrite-existing >/dev/null
echo "stage_cluster_power_state_after=${power_state}"

if [[ "$RUN_HEALTH_CHECKS" == "true" ]]; then
  kubectl get nodes -o wide
  kubectl get deploy -n default
  kubectl get sts -n default
fi

