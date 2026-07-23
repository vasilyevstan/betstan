#!/usr/bin/env bash
set -euo pipefail

# Purpose: recreate (cycle) the AKS nodes when the cluster is stuck/unhealthy
#          and individual pod restarts are not enough to bring the app back up.
#
# It reimages the node pool in place, which cordons, drains, and rebuilds the
# underlying node VMs with a fresh image — effectively "recreating the nodes"
# without deleting the cluster, its ingress IP, or persistent volumes.
#
# Usage:
#   ./infra/azure/agents/recreate-nodes-stan.sh
#   NODEPOOL=nodepool1 ./infra/azure/agents/recreate-nodes-stan.sh
#
# Env overrides:
#   RESOURCE_GROUP (default: betstan-rg)
#   CLUSTER_NAME   (default: betstan-aks)
#   NODEPOOL       (default: auto-detected first agent pool)

RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks}"
NODEPOOL="${NODEPOOL:-}"

echo "=== Cluster power/provisioning state ==="
POWER_STATE=$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" \
  --query "powerState.code" -o tsv 2>/dev/null || true)
echo "  powerState: ${POWER_STATE:-<unknown>}"

# A stopped cluster cannot be reimaged — start it first.
if [[ "$POWER_STATE" == "Stopped" ]]; then
  echo "  Cluster is stopped — starting it before recreating nodes..."
  az aks start -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME"
fi

if [[ -z "$NODEPOOL" ]]; then
  NODEPOOL=$(az aks nodepool list \
    -g "$RESOURCE_GROUP" \
    --cluster-name "$CLUSTER_NAME" \
    --query "[0].name" -o tsv)
fi
echo "  Node pool: $NODEPOOL"

echo
echo "=== Reimaging (recreating) nodes in pool '$NODEPOOL' ==="
echo "  This cordons, drains, and rebuilds the node VMs. Give it a few minutes."
az aks nodepool upgrade \
  -g "$RESOURCE_GROUP" \
  --cluster-name "$CLUSTER_NAME" \
  -n "$NODEPOOL" \
  --node-image-only

echo
echo "=== Refreshing kubectl credentials ==="
az aks get-credentials \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CLUSTER_NAME" \
  --overwrite-existing

echo
echo "=== Post-recreate node status ==="
kubectl get nodes -o wide || true

echo
echo "Done. Nodes have been recreated. Redeploy the workloads if needed:"
echo "  ./infra/azure/agents/deploy-stan.sh"
echo "Then verify with:"
echo "  ./infra/azure/agents/troubleshoot-stan.sh"
