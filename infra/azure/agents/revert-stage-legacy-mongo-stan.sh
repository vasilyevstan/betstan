#!/usr/bin/env bash
set -euo pipefail

# Purpose: rollback stage from shared mongo back to per-service mongo endpoints.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg-stage}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks-stage}"
NAMESPACE="${NAMESPACE:-default}"

LEGACY_MONGO_STS=(
  gaming-auth-mongo-depl
  gaming-bet-mongo-depl
  gaming-backoffice-mongo-depl
  gaming-event-mongo-depl
  gaming-gamemaster-mongo-depl
  gaming-moderation-mongo-depl
  gaming-resulting-mongo-depl
  gaming-slip-mongo-depl
)

MONGO_URIS=(
  "gaming-auth-depl:mongodb://gaming-auth-mongo-srv:27017/gaming_auth"
  "gaming-bet-depl:mongodb://gaming-bet-mongo-srv:27017/gaming_bet"
  "gaming-backoffice-depl:mongodb://gaming-backoffice-mongo-srv:27017/gaming_backoffice"
  "gaming-event-depl:mongodb://gaming-event-mongo-srv:27017/gaming_event"
  "gaming-gamemaster-depl:mongodb://gaming-gamemaster-mongo-srv:27017/gaming_gamemaster"
  "gaming-moderation-depl:mongodb://gaming-moderation-mongo-srv:27017/gaming_moderation"
  "gaming-resulting-depl:mongodb://gaming-resulting-mongo-srv:27017/gaming_resulting"
  "gaming-slip-depl:mongodb://gaming-slip-mongo-srv:27017/gaming_slip"
)

command -v az >/dev/null 2>&1 || { echo "ERROR: missing az" >&2; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "ERROR: missing kubectl" >&2; exit 1; }

az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing >/dev/null

for sts in "${LEGACY_MONGO_STS[@]}"; do
  kubectl scale "statefulset/${sts}" -n "$NAMESPACE" --replicas=1
done

for sts in "${LEGACY_MONGO_STS[@]}"; do
  kubectl rollout status "statefulset/${sts}" -n "$NAMESPACE" --timeout=8m
done

for mapping in "${MONGO_URIS[@]}"; do
  IFS=':' read -r deployment uri <<<"$mapping"
  kubectl set env "deployment/${deployment}" -n "$NAMESPACE" MONGO_URI="$uri"
done

for svc in auth bet backoffice event gamemaster moderation resulting slip; do
  kubectl rollout status "deployment/gaming-${svc}-depl" -n "$NAMESPACE" --timeout=8m
done

kubectl scale statefulset/gaming-shared-mongo-depl -n "$NAMESPACE" --replicas=0

cd "$ROOT_DIR"
BASE_URL="http://$(kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}')"
BASE_URL="$BASE_URL" ./infra/azure/agents/smoke-liveness-stan.sh
./infra/azure/agents/service-ops-stan.sh

echo "stage_revert_status=PASS"
