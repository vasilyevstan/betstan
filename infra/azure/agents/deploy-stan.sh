#!/usr/bin/env bash
set -euo pipefail

# Purpose: deploy manifests to the current AKS context.
# Usage:
#   ./infra/azure/agents/deploy-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

lock_script="$ROOT_DIR/infra/azure/agents/shared-mongo-operation-lock-stan.sh"
source_sha="$(git rev-parse HEAD)"
lock_token="deploy-stan-$(date -u +%Y%m%dT%H%M%SZ)-$$"
lock_operation="deploy-stan-${source_sha}"

release_lock() {
  local exit_code=$?
  local release_code=0
  trap - EXIT
  set +e
  LOCK_TOKEN="$lock_token" OPERATION_ID="$lock_operation" SOURCE_SHA="$source_sha" \
    "$lock_script" release >/dev/null
  release_code=$?
  if [[ "$exit_code" -eq 0 && "$release_code" -ne 0 ]]; then
    exit "$release_code"
  fi
  exit "$exit_code"
}
trap release_lock EXIT

LOCK_TOKEN="$lock_token" OPERATION_ID="$lock_operation" SOURCE_SHA="$source_sha" \
  "$lock_script" acquire
"$ROOT_DIR/infra/azure/agents/shared-mongo-topology-guard-stan.sh"

kubectl apply -f infra/k8s-prod/cert-issuer.yaml
kubectl apply -f infra/k8s
kubectl apply -f infra/k8s-prod/ingress-srv.yaml
kubectl delete \
  ingress/gaming-ingress-service-nip \
  certificate/betstan-nip-tls \
  secret/betstan-nip-tls \
  --namespace default \
  --ignore-not-found

kubectl get pods -n default
kubectl get ingress gaming-ingress-service
