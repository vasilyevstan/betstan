#!/usr/bin/env bash
set -euo pipefail

# Purpose: create isolated stage AKS with autoscaler 1->3 and ingress for IP access.

RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg-stage}"
LOCATION="${LOCATION:-eastus}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks-stage}"
# Use a larger single node so the stage workload can stay on one machine
# without forcing immediate scale-out under normal load.
NODE_VM_SIZE="${NODE_VM_SIZE:-Standard_B4ms}"
MIN_COUNT="${MIN_COUNT:-1}"
MAX_COUNT="${MAX_COUNT:-3}"
JWT_KEY_VALUE="${JWT_KEY:-}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

require_cmd az
require_cmd kubectl
require_cmd helm

if ! az group exists --name "$RESOURCE_GROUP" -o tsv | grep -q "true"; then
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
fi

if ! az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" >/dev/null 2>&1; then
  az aks create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --location "$LOCATION" \
    --node-count "$MIN_COUNT" \
    --node-vm-size "$NODE_VM_SIZE" \
    --enable-managed-identity \
    --generate-ssh-keys \
    --output none
fi

NODEPOOL_NAME="$(az aks nodepool list -g "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --query '[0].name' -o tsv)"
az aks nodepool update \
  --resource-group "$RESOURCE_GROUP" \
  --cluster-name "$CLUSTER_NAME" \
  --name "$NODEPOOL_NAME" \
  --enable-cluster-autoscaler \
  --min-count "$MIN_COUNT" \
  --max-count "$MAX_COUNT" \
  --output none

az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update >/dev/null
helm repo update >/dev/null
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --wait \
  --timeout 15m >/dev/null

if ! kubectl get secret jwt-secret -n default >/dev/null 2>&1; then
  if [[ -z "$JWT_KEY_VALUE" ]]; then
    echo "ERROR: JWT_KEY is required to create stage jwt-secret." >&2
    exit 1
  fi
  if [[ ${#JWT_KEY_VALUE} -lt 32 ]]; then
    echo "ERROR: JWT_KEY must be at least 32 chars." >&2
    exit 1
  fi
  kubectl create secret generic jwt-secret \
    --from-literal=JWT_KEY="$JWT_KEY_VALUE" \
    --namespace default >/dev/null
fi

INGRESS_IP="$(kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
echo "stage_resource_group=$RESOURCE_GROUP"
echo "stage_cluster_name=$CLUSTER_NAME"
echo "stage_nodepool=$NODEPOOL_NAME"
echo "stage_autoscaler_min=$MIN_COUNT"
echo "stage_autoscaler_max=$MAX_COUNT"
echo "stage_ingress_ip=${INGRESS_IP:-pending}"
