#!/usr/bin/env bash
set -euo pipefail

# Purpose: run post-deploy smoke/liveness checks against AKS ingress and core API.
# Usage:
#   ./infra/azure/agents/smoke-liveness-stan.sh
#   BASE_URL=http://48.206.235.122 ./infra/azure/agents/smoke-liveness-stan.sh

INGRESS_NAMESPACE="${INGRESS_NAMESPACE:-ingress-nginx}"
INGRESS_SERVICE="${INGRESS_SERVICE:-ingress-nginx-controller}"
EXPECTED_HOME_TEXT="${EXPECTED_HOME_TEXT:-BetStan.xyz demo app}"
BASE_URL="${BASE_URL:-}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-25}"

if [[ -z "$BASE_URL" ]]; then
  INGRESS_IP="$(kubectl get svc "$INGRESS_SERVICE" -n "$INGRESS_NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')"
  if [[ -z "${INGRESS_IP:-}" ]]; then
    echo "ERROR: ingress external IP not found" >&2
    exit 1
  fi
  BASE_URL="http://${INGRESS_IP}"
fi

echo "smoke_base_url=$BASE_URL"

echo "=== readiness gate ==="
kubectl get deploy,sts -n default

echo "=== homepage check ==="
home_body="$(curl -fsS --max-time "$REQUEST_TIMEOUT" "${BASE_URL}/")"
if ! grep -qi "$EXPECTED_HOME_TEXT" <<<"$home_body"; then
  echo "ERROR: homepage does not include expected text: $EXPECTED_HOME_TEXT" >&2
  exit 1
fi

echo "=== auth API check ==="
auth_response="$(curl -fsS --max-time "$REQUEST_TIMEOUT" "${BASE_URL}/api/auth/currentuser")"
if ! grep -q "currentUser" <<<"$auth_response"; then
  echo "ERROR: /api/auth/currentuser response missing currentUser field" >&2
  exit 1
fi

echo "=== endpoints check ==="
kubectl get endpoints -n default | awk 'NR==1 || $2 != "<none>"'
missing_endpoints="$(kubectl get endpoints -n default --no-headers | awk '$2=="<none>" {print $1}')"
if [[ -n "${missing_endpoints:-}" ]]; then
  echo "ERROR: services without endpoints detected" >&2
  echo "$missing_endpoints" >&2
  exit 1
fi

echo "smoke_liveness_status=PASS"
