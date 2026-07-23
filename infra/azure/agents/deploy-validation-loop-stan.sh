#!/usr/bin/env bash
set -euo pipefail

# Purpose: post-deploy validation and diagnostics loop.
# Runs layered checks with retries and captures diagnostics on failures.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INGRESS_NAMESPACE="${INGRESS_NAMESPACE:-ingress-nginx}"
INGRESS_SERVICE="${INGRESS_SERVICE:-ingress-nginx-controller}"
DOMAIN="${DOMAIN:-48.206.235.122.nip.io}"
CERT_NAME="${CERT_NAME:-betstan-nip-tls}"
E2E_BASE_URL="${E2E_BASE_URL:-}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
SLEEP_SECONDS="${SLEEP_SECONDS:-30}"
VALIDATION_MAX_LOOPS="${VALIDATION_MAX_LOOPS:-3}"
VALIDATION_SLEEP_SECONDS="${VALIDATION_SLEEP_SECONDS:-20}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/deploy-validation}"

mkdir -p "$OUTPUT_DIR"

is_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

if ! is_positive_int "$MAX_ATTEMPTS"; then
  echo "WARN: MAX_ATTEMPTS='$MAX_ATTEMPTS' is invalid, defaulting to 3"
  MAX_ATTEMPTS=3
fi

if ! is_positive_int "$SLEEP_SECONDS"; then
  echo "WARN: SLEEP_SECONDS='$SLEEP_SECONDS' is invalid, defaulting to 30"
  SLEEP_SECONDS=30
fi

if ! is_positive_int "$VALIDATION_MAX_LOOPS"; then
  echo "WARN: VALIDATION_MAX_LOOPS='$VALIDATION_MAX_LOOPS' is invalid, defaulting to 3"
  VALIDATION_MAX_LOOPS=3
fi

if ! is_positive_int "$VALIDATION_SLEEP_SECONDS"; then
  echo "WARN: VALIDATION_SLEEP_SECONDS='$VALIDATION_SLEEP_SECONDS' is invalid, defaulting to 20"
  VALIDATION_SLEEP_SECONDS=20
fi

if [[ -z "$E2E_BASE_URL" ]]; then
  INGRESS_IP="$(kubectl get svc "$INGRESS_SERVICE" -n "$INGRESS_NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
  if [[ -n "${INGRESS_IP:-}" ]]; then
    E2E_BASE_URL="http://${INGRESS_IP}"
  else
    E2E_BASE_URL="https://${DOMAIN}"
  fi
fi

capture_diagnostics() {
  local attempt="$1"
  local reason="$2"
  local dir="$OUTPUT_DIR/attempt-${attempt}"
  mkdir -p "$dir"

  {
    echo "attempt=${attempt}"
    echo "reason=${reason}"
    echo "domain=${DOMAIN}"
    echo "cert_name=${CERT_NAME}"
    echo "e2e_base_url=${E2E_BASE_URL}"
    date -u '+utc=%Y-%m-%dT%H:%M:%SZ'
  } > "$dir/context.txt"

  kubectl get nodes -o wide > "$dir/kubectl-nodes.txt" 2>&1 || true
  kubectl get events -A --sort-by=.lastTimestamp > "$dir/kubectl-events.txt" 2>&1 || true
  kubectl get deploy,sts,pods,svc,endpoints -n default -o wide > "$dir/kubectl-default-workloads.txt" 2>&1 || true

  "$ROOT_DIR/infra/azure/agents/service-ops-stan.sh" > "$dir/service-ops.txt" 2>&1 || true
  "$ROOT_DIR/infra/azure/agents/node-logs-stan.sh" > "$dir/node-logs.txt" 2>&1 || true
}

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "=== deploy-validation attempt ${attempt}/${MAX_ATTEMPTS} ==="

  if "$ROOT_DIR/infra/azure/agents/smoke-liveness-stan.sh"; then
    if DOMAIN="$DOMAIN" CERT_NAME="$CERT_NAME" E2E_BASE_URL="$E2E_BASE_URL" MAX_LOOPS="$VALIDATION_MAX_LOOPS" SLEEP_SECONDS="$VALIDATION_SLEEP_SECONDS" \
      "$ROOT_DIR/infra/azure/agents/validation-loop-stan.sh"; then
      echo "deploy_validation_status=PASS"
      exit 0
    fi
    capture_diagnostics "$attempt" "validation-loop-failed"
  else
    capture_diagnostics "$attempt" "smoke-liveness-failed"
  fi

  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    sleep "$SLEEP_SECONDS"
  fi
done

echo "deploy_validation_status=FAILED"
echo "diagnostics_dir=${OUTPUT_DIR}"
exit 1
