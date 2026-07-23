#!/usr/bin/env bash
set -euo pipefail

# Purpose: gather quick diagnostics for AKS and workload failures.
# Usage:
#   ./infra/azure/agents/troubleshoot-stan.sh

echo "=== AKS cluster status ==="
az aks show -g betstan-rg -n betstan-aks \
  --query '{provisioningState:provisioningState,powerState:powerState.code,nodeCount:agentPoolProfiles[0].count,vmSize:agentPoolProfiles[0].vmSize}' \
  -o table

echo
echo "=== Kubernetes nodes ==="
kubectl get nodes -o wide

echo
echo "=== Non-ready pods ==="
kubectl get pods -A --field-selector=status.phase!=Running

echo
echo "=== Ingress + LB ==="
kubectl get ingress gaming-ingress-service -o wide || true
kubectl get svc -n ingress-nginx ingress-nginx-controller -o wide || true

