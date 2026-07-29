#!/usr/bin/env bash
set -euo pipefail

# Purpose: run repeated stage validation for a soak window.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg-stage}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks-stage}"
SOAK_HOURS="${SOAK_HOURS:-24}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-600}"
MAX_FAILURES="${MAX_FAILURES:-1}"

command -v az >/dev/null 2>&1 || { echo "ERROR: missing az" >&2; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "ERROR: missing kubectl" >&2; exit 1; }

az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing >/dev/null

end_ts="$(( $(date +%s) + SOAK_HOURS * 3600 ))"
failures=0
iteration=0

while [[ "$(date +%s)" -lt "$end_ts" ]]; do
  iteration="$((iteration + 1))"
  echo "=== stage soak iteration ${iteration} ==="
  ingress_ip="$(kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}')"
  BASE_URL="http://${ingress_ip}"

  if ! IGNORE_ENDPOINT_REGEX='^(gaming-.*-mongo-srv|kubernetes)$' BASE_URL="$BASE_URL" \
      "$ROOT_DIR/infra/azure/agents/smoke-liveness-stan.sh"; then
    failures="$((failures + 1))"
  fi
  if ! "$ROOT_DIR/infra/azure/agents/service-ops-stan.sh"; then
    failures="$((failures + 1))"
  fi

  kubectl get nodes -o wide
  kubectl top nodes || true

  if [[ "$failures" -gt "$MAX_FAILURES" ]]; then
    echo "stage_soak_status=FAILED"
    echo "failure_count=$failures"
    exit 1
  fi

  sleep "$INTERVAL_SECONDS"
done

echo "stage_soak_status=PASS"
