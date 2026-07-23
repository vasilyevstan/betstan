#!/usr/bin/env bash
set -euo pipefail

# Purpose: deploy manifests to the current AKS context.
# Usage:
#   ./infra/azure/agents/deploy-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

kubectl apply -f infra/k8s-prod/cert-issuer.yaml
kubectl apply -f infra/k8s
kubectl apply -f infra/k8s-prod/ingress-srv.yaml
kubectl apply -f infra/k8s-prod/ingress-srv-nip.yaml

kubectl get pods -n default
kubectl get ingress gaming-ingress-service gaming-ingress-service-nip
