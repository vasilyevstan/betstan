#!/usr/bin/env bash
set -euo pipefail

# Purpose: deploy manifests to the current AKS context.
# Usage:
#   ./infra/azure/agents/deploy-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

kubectl apply -f infra/k8s-prod/cert-issuer.yaml

# The 8 per-service MongoDBs were consolidated into a single shared `gaming-mongo`
# instance. `kubectl apply` does not prune resources whose manifests were deleted,
# so remove the obsolete per-service MongoDB resources explicitly (idempotent).
for svc in auth backoffice bet event gamemaster moderation resulting slip; do
  kubectl delete statefulset "gaming-${svc}-mongo-depl" --ignore-not-found
  kubectl delete service "gaming-${svc}-mongo-srv" --ignore-not-found
  kubectl delete pvc "gaming-${svc}-mongo-data-gaming-${svc}-mongo-depl-0" --ignore-not-found
done

kubectl apply -f infra/k8s
kubectl apply -f infra/k8s-prod/ingress-srv.yaml
kubectl apply -f infra/k8s-prod/ingress-srv-nip.yaml

kubectl get pods -n default
kubectl get ingress gaming-ingress-service gaming-ingress-service-nip
