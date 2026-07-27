#!/usr/bin/env bash
set -euo pipefail

# Purpose: deploy stage stack, migrate per-service mongo data into one shared mongo,
# switch service MONGO_URI values, and keep legacy mongo instances scaled to zero for rollback.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg-stage}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks-stage}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
NAMESPACE="${NAMESPACE:-default}"
SCALE_DOWN_LEGACY_MONGO="${SCALE_DOWN_LEGACY_MONGO:-true}"
RUN_E2E="${RUN_E2E:-false}"
MIGRATE_FROM_LEGACY="${MIGRATE_FROM_LEGACY:-true}"

SERVICES=(auth bet backoffice client event gamemaster moderation resulting slip)
DB_DEPLOYMENTS=(
  "gaming-auth-depl:gaming_auth:gaming-auth-mongo-depl-0"
  "gaming-bet-depl:gaming_bet:gaming-bet-mongo-depl-0"
  "gaming-backoffice-depl:gaming_backoffice:gaming-backoffice-mongo-depl-0"
  "gaming-event-depl:gaming_event:gaming-event-mongo-depl-0"
  "gaming-gamemaster-depl:gaming_gamemaster:gaming-gamemaster-mongo-depl-0"
  "gaming-moderation-depl:gaming_moderation:gaming-moderation-mongo-depl-0"
  "gaming-resulting-depl:gaming_resulting:gaming-resulting-mongo-depl-0"
  "gaming-slip-depl:gaming_slip:gaming-slip-mongo-depl-0"
)
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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

require_cmd az
require_cmd kubectl

az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing >/dev/null

cd "$ROOT_DIR"
kubectl apply -f infra/k8s
kubectl apply -f infra/k8s-stage/shared-mongo.yaml
kubectl apply -f infra/k8s-stage/ingress-ip.yaml

if [[ "$IMAGE_TAG" != "latest" ]]; then
  kubectl set image deployment/gaming-auth-depl gaming-auth="stanvasilyev/gaming_auth:${IMAGE_TAG}"
  kubectl set image deployment/gaming-bet-depl gaming-bet="stanvasilyev/gaming_bet:${IMAGE_TAG}"
  kubectl set image deployment/gaming-backoffice-depl gaming-backoffice="stanvasilyev/gaming_backoffice:${IMAGE_TAG}"
  kubectl set image deployment/gaming-client-depl gaming-client="stanvasilyev/gaming_client:${IMAGE_TAG}"
  kubectl set image deployment/gaming-event-depl gaming-event="stanvasilyev/gaming_event:${IMAGE_TAG}"
  kubectl set image deployment/gaming-gamemaster-depl gaming-gamemaster="stanvasilyev/gaming_gamemaster:${IMAGE_TAG}"
  kubectl set image deployment/gaming-moderation-depl gaming-moderation="stanvasilyev/gaming_moderation:${IMAGE_TAG}"
  kubectl set image deployment/gaming-resulting-depl gaming-resulting="stanvasilyev/gaming_resulting:${IMAGE_TAG}"
  kubectl set image deployment/gaming-slip-depl gaming-slip="stanvasilyev/gaming_slip:${IMAGE_TAG}"
fi

for svc in "${SERVICES[@]}"; do
  kubectl rollout status "deployment/gaming-${svc}-depl" -n "$NAMESPACE" --timeout=8m
done
kubectl rollout status statefulset/gaming-shared-mongo-depl -n "$NAMESPACE" --timeout=8m

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

shared_pod="gaming-shared-mongo-depl-0"

if [[ "$MIGRATE_FROM_LEGACY" == "true" ]]; then
  for mapping in "${DB_DEPLOYMENTS[@]}"; do
    IFS=':' read -r deployment db_name source_pod <<<"$mapping"
    archive_path="$TMP_DIR/${db_name}.archive.gz"
    echo "Migrating $db_name from $source_pod to shared mongo..."
    kubectl exec -n "$NAMESPACE" "$source_pod" -- \
      mongodump --archive --gzip --db "$db_name" > "$archive_path"
    kubectl exec -i -n "$NAMESPACE" "$shared_pod" -- \
      mongorestore --archive --gzip --drop --nsInclude "${db_name}.*" < "$archive_path"
  done
fi

print_collection_counts() {
  local pod_name="$1"
  local db_name="$2"
  kubectl exec -n "$NAMESPACE" "$pod_name" -- sh -lc \
    "mongosh --quiet --eval \"const dbName='${db_name}'; const d=db.getSiblingDB(dbName); d.getCollectionNames().sort().forEach((c)=>print(c+':'+d.getCollection(c).countDocuments({})));\""
}

if [[ "$MIGRATE_FROM_LEGACY" == "true" ]]; then
  for mapping in "${DB_DEPLOYMENTS[@]}"; do
    IFS=':' read -r _ db_name source_pod <<<"$mapping"
    src_counts="$TMP_DIR/${db_name}.src.counts"
    dst_counts="$TMP_DIR/${db_name}.dst.counts"
    print_collection_counts "$source_pod" "$db_name" | sort > "$src_counts"
    print_collection_counts "$shared_pod" "$db_name" | sort > "$dst_counts"
    if ! diff -u "$src_counts" "$dst_counts" >/dev/null; then
      echo "ERROR: data parity check failed for ${db_name}" >&2
      diff -u "$src_counts" "$dst_counts" || true
      exit 1
    fi
  done
fi

for mapping in "${DB_DEPLOYMENTS[@]}"; do
  IFS=':' read -r deployment db_name _ <<<"$mapping"
  kubectl set env "deployment/${deployment}" -n "$NAMESPACE" \
    MONGO_URI="mongodb://gaming-shared-mongo-srv:27017/${db_name}"
done

for svc in auth bet backoffice event gamemaster moderation resulting slip; do
  kubectl rollout status "deployment/gaming-${svc}-depl" -n "$NAMESPACE" --timeout=8m
done

if [[ "$SCALE_DOWN_LEGACY_MONGO" == "true" ]]; then
  for sts in "${LEGACY_MONGO_STS[@]}"; do
    kubectl scale "statefulset/${sts}" -n "$NAMESPACE" --replicas=0
  done
fi

ingress_ip="$(kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}')"
BASE_URL="http://${ingress_ip}"

IGNORE_ENDPOINT_REGEX='^(gaming-.*-mongo-srv|kubernetes)$' BASE_URL="$BASE_URL" \
  "$ROOT_DIR/infra/azure/agents/smoke-liveness-stan.sh"

"$ROOT_DIR/infra/azure/agents/service-ops-stan.sh"

if [[ "$RUN_E2E" == "true" ]]; then
  E2E_BASE_URL="$BASE_URL" "$ROOT_DIR/infra/azure/agents/qa-e2e-stan.sh"
fi

echo "stage_shared_db_deploy_status=PASS"
echo "stage_base_url=${BASE_URL}"
