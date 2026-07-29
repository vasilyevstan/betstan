#!/usr/bin/env bash
set -euo pipefail

# Purpose: delete the entire stage resource group to remove stage costs.

RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg-stage}"
WAIT_SECONDS="${WAIT_SECONDS:-15}"
MAX_WAIT_LOOPS="${MAX_WAIT_LOOPS:-80}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

require_cmd az

exists="$(az group exists --name "$RESOURCE_GROUP" -o tsv)"
if [[ "$exists" == "false" ]]; then
  echo "stage_resource_group_present=false"
  echo "stage_resource_group_deleted=true"
  exit 0
fi

az group delete --name "$RESOURCE_GROUP" --yes --no-wait

for _ in $(seq 1 "$MAX_WAIT_LOOPS"); do
  exists="$(az group exists --name "$RESOURCE_GROUP" -o tsv)"
  if [[ "$exists" == "false" ]]; then
    echo "stage_resource_group_deleted=true"
    exit 0
  fi
  sleep "$WAIT_SECONDS"
done

echo "ERROR: stage resource group deletion did not complete in time" >&2
exit 1

