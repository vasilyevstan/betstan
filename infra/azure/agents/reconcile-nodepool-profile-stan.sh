#!/usr/bin/env bash
set -euo pipefail

# Purpose: create or reconcile an AKS node pool's Azure profile.
# Workload cutover and legacy pool deletion are intentionally unsupported.

RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg-stage}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks-stage}"
TARGET_POOL_NAME="${TARGET_POOL_NAME:-nodepool2}"
TARGET_VM_SIZE="${TARGET_VM_SIZE:-Standard_B4as_v2}"
TARGET_OS_DISK_TYPE="${TARGET_OS_DISK_TYPE:-Managed}"
TARGET_OS_DISK_SIZE_GB="${TARGET_OS_DISK_SIZE_GB:-64}"
TARGET_MIN_COUNT="${TARGET_MIN_COUNT:-1}"
TARGET_MAX_COUNT="${TARGET_MAX_COUNT:-3}"
TARGET_INITIAL_COUNT="${TARGET_INITIAL_COUNT:-1}"
EXECUTE_CUTOVER="${EXECUTE_CUTOVER:-false}"
DELETE_LEGACY_POOL="${DELETE_LEGACY_POOL:-false}"

if [[ "$EXECUTE_CUTOVER" == "true" || "$DELETE_LEGACY_POOL" == "true" ]]; then
  echo "ERROR: automated workload cutover and legacy node-pool deletion are intentionally disabled." >&2
  echo "Take consistent Mongo snapshots and follow the documented sequential migration runbook before deleting a legacy pool." >&2
  exit 1
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

require_cmd az

require_positive_integer() {
  local variable_name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: ${variable_name} must be a positive integer, got: ${value}" >&2
    exit 1
  fi
}

require_positive_integer TARGET_OS_DISK_SIZE_GB "$TARGET_OS_DISK_SIZE_GB"
require_positive_integer TARGET_MIN_COUNT "$TARGET_MIN_COUNT"
require_positive_integer TARGET_MAX_COUNT "$TARGET_MAX_COUNT"
require_positive_integer TARGET_INITIAL_COUNT "$TARGET_INITIAL_COUNT"

case "$TARGET_OS_DISK_TYPE" in
  Managed|Ephemeral) ;;
  *)
    echo "ERROR: TARGET_OS_DISK_TYPE must be Managed or Ephemeral, got: ${TARGET_OS_DISK_TYPE}" >&2
    exit 1
    ;;
esac

if (( 10#$TARGET_MIN_COUNT > 10#$TARGET_MAX_COUNT )); then
  echo "ERROR: TARGET_MIN_COUNT must not exceed TARGET_MAX_COUNT" >&2
  exit 1
fi

if (( 10#$TARGET_INITIAL_COUNT < 10#$TARGET_MIN_COUNT || 10#$TARGET_INITIAL_COUNT > 10#$TARGET_MAX_COUNT )); then
  echo "ERROR: TARGET_INITIAL_COUNT must be within TARGET_MIN_COUNT..TARGET_MAX_COUNT" >&2
  exit 1
fi

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
    --node-osdisk-type "$TARGET_OS_DISK_TYPE" \
    --node-osdisk-size "$TARGET_OS_DISK_SIZE_GB" \
    --enable-cluster-autoscaler \
    --min-count "$TARGET_MIN_COUNT" \
    --max-count "$TARGET_MAX_COUNT" \
    -o none
else
  existing_vm_size="$(az aks nodepool show -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" -n "$TARGET_POOL_NAME" --query vmSize -o tsv)"
  existing_os_disk_type="$(az aks nodepool show -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" -n "$TARGET_POOL_NAME" --query osDiskType -o tsv)"
  existing_os_disk_size_gb="$(az aks nodepool show -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" -n "$TARGET_POOL_NAME" --query osDiskSizeGb -o tsv)"
  profile_mismatches=()

  if [[ "$existing_vm_size" != "$TARGET_VM_SIZE" ]]; then
    profile_mismatches+=("vmSize: expected ${TARGET_VM_SIZE}, found ${existing_vm_size:-<empty>}")
  fi
  if [[ "$existing_os_disk_type" != "$TARGET_OS_DISK_TYPE" ]]; then
    profile_mismatches+=("osDiskType: expected ${TARGET_OS_DISK_TYPE}, found ${existing_os_disk_type:-<empty>}")
  fi
  if [[ ! "$existing_os_disk_size_gb" =~ ^[0-9]+$ ]]; then
    profile_mismatches+=("osDiskSizeGb: expected ${TARGET_OS_DISK_SIZE_GB}, found ${existing_os_disk_size_gb:-<empty>}")
  elif (( 10#$existing_os_disk_size_gb != 10#$TARGET_OS_DISK_SIZE_GB )); then
    profile_mismatches+=("osDiskSizeGb: expected ${TARGET_OS_DISK_SIZE_GB}, found ${existing_os_disk_size_gb}")
  fi

  if (( ${#profile_mismatches[@]} > 0 )); then
    echo "ERROR: existing target pool ${TARGET_POOL_NAME} does not match the requested immutable profile:" >&2
    printf '  - %s\n' "${profile_mismatches[@]}" >&2
    echo "Create a replacement pool or change the target profile; refusing to claim alignment." >&2
    exit 1
  fi

  echo "target_pool_profile_aligned=true"
fi

az aks nodepool update \
  -g "$RESOURCE_GROUP" \
  --cluster-name "$CLUSTER_NAME" \
  -n "$TARGET_POOL_NAME" \
  --enable-cluster-autoscaler \
  --min-count "$TARGET_MIN_COUNT" \
  --max-count "$TARGET_MAX_COUNT" \
  -o none

az aks nodepool list -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" \
  --query "[].{name:name,vmSize:vmSize,osDiskType:osDiskType,osDiskSizeGb:osDiskSizeGb,mode:mode,count:count,enableAutoScaling:enableAutoScaling,minCount:minCount,maxCount:maxCount}" -o json
