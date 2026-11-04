#!/usr/bin/env bash
set -euo pipefail

# Purpose: low-cost operational controls for AKS.
# Usage:
#   ./infra/azure/agents/cost-ops-stan.sh stop
#   ./infra/azure/agents/cost-ops-stan.sh start
#   ./infra/azure/agents/cost-ops-stan.sh scale 2

ACTION="${1:-}"
RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks}"

case "$ACTION" in
  stop)
    az aks stop -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME"
    ;;
  start)
    az aks start -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME"
    ;;
  scale)
    TARGET_COUNT="${2:-1}"
    az aks scale -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --node-count "$TARGET_COUNT"
    ;;
  *)
    echo "Usage: $0 {stop|start|scale <count>}" >&2
    exit 1
    ;;
esac

