#!/usr/bin/env bash
set -euo pipefail

# Purpose: deploy manifests to the current AKS context.
# Usage:
#   ./infra/azure/agents/deploy-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

kubectl apply -f infra/k8s-prod/cert-issuer.yaml

# We rolled back the single shared `gaming-mongo` instance to several per-service
# MongoDBs (the previous known-good topology). `kubectl apply` does not prune
# resources whose manifests were deleted, so remove the obsolete shared MongoDB
# resource explicitly (idempotent).
kubectl delete statefulset "gaming-mongo-depl" --ignore-not-found
kubectl delete service "gaming-mongo-srv" --ignore-not-found
kubectl delete pvc "gaming-mongo-data-gaming-mongo-depl-0" --ignore-not-found

kubectl apply -f infra/k8s
kubectl apply -f infra/k8s-prod/ingress-srv.yaml
kubectl apply -f infra/k8s-prod/ingress-srv-nip.yaml

kubectl get pods -n default
kubectl get ingress gaming-ingress-service gaming-ingress-service-nip
