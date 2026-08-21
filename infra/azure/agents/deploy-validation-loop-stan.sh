#!/usr/bin/env bash
set -euo pipefail

# Purpose: post-deploy validation and diagnostics loop.
# Runs layered checks with retries and captures diagnostics on failures.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DOMAIN="${DOMAIN:-betstan.xyz}"
CERT_NAME="${CERT_NAME:-betstan-tls}"
E2E_BASE_URL="${E2E_BASE_URL:-https://${DOMAIN}}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
SLEEP_SECONDS="${SLEEP_SECONDS:-30}"
VALIDATION_MAX_LOOPS="${VALIDATION_MAX_LOOPS:-3}"
VALIDATION_SLEEP_SECONDS="${VALIDATION_SLEEP_SECONDS:-20}"
SMOKE_LIVENESS_SCRIPT="${SMOKE_LIVENESS_SCRIPT:-$ROOT_DIR/infra/azure/agents/smoke-liveness-stan.sh}"
VALIDATION_LOOP_SCRIPT="${VALIDATION_LOOP_SCRIPT:-$ROOT_DIR/infra/azure/agents/validation-loop-stan.sh}"
LIVE_BETTING_READINESS_SCRIPT="${LIVE_BETTING_READINESS_SCRIPT:-$ROOT_DIR/infra/azure/agents/live-betting-readiness-stan.sh}"
SERVICE_OPS_SCRIPT="${SERVICE_OPS_SCRIPT:-$ROOT_DIR/infra/azure/agents/service-ops-stan.sh}"
NODE_LOGS_SCRIPT="${NODE_LOGS_SCRIPT:-$ROOT_DIR/infra/azure/agents/node-logs-stan.sh}"
LIVE_BETTING_READINESS_MODE="${LIVE_BETTING_READINESS_MODE:-dark}"
LIVE_READINESS_REQUEST_TIMEOUT="${LIVE_READINESS_REQUEST_TIMEOUT:-15}"
LIVE_READINESS_SSE_TIMEOUT="${LIVE_READINESS_SSE_TIMEOUT:-20}"
IMAGE_PROVENANCE_FILE="${IMAGE_PROVENANCE_FILE:-}"
SECONDARY_PUBLIC_URL="${SECONDARY_PUBLIC_URL:-}"
DIAGNOSTIC_URL="${DIAGNOSTIC_URL:-}"
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

if ! is_positive_int "$LIVE_READINESS_REQUEST_TIMEOUT"; then
  echo "WARN: LIVE_READINESS_REQUEST_TIMEOUT='$LIVE_READINESS_REQUEST_TIMEOUT' is invalid, defaulting to 15"
  LIVE_READINESS_REQUEST_TIMEOUT=15
fi

if ! is_positive_int "$LIVE_READINESS_SSE_TIMEOUT"; then
  echo "WARN: LIVE_READINESS_SSE_TIMEOUT='$LIVE_READINESS_SSE_TIMEOUT' is invalid, defaulting to 20"
  LIVE_READINESS_SSE_TIMEOUT=20
fi

case "$LIVE_BETTING_READINESS_MODE" in
  dark|monitor)
    ;;
  *)
    echo "ERROR: LIVE_BETTING_READINESS_MODE must be dark or monitor" >&2
    exit 1
    ;;
esac

[[ -n "$IMAGE_PROVENANCE_FILE" && -f "$IMAGE_PROVENANCE_FILE" ]] || {
  echo "ERROR: IMAGE_PROVENANCE_FILE is required for live readiness validation" >&2
  exit 1
}

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
    echo "image_provenance_file=${IMAGE_PROVENANCE_FILE}"
    echo "live_betting_readiness_mode=${LIVE_BETTING_READINESS_MODE}"
    echo "secondary_public_url=${SECONDARY_PUBLIC_URL}"
    echo "diagnostic_url=${DIAGNOSTIC_URL}"
    date -u '+utc=%Y-%m-%dT%H:%M:%SZ'
  } > "$dir/context.txt"

  kubectl get nodes -o wide > "$dir/kubectl-nodes.txt" 2>&1 || true
  kubectl get events -A --sort-by=.lastTimestamp > "$dir/kubectl-events.txt" 2>&1 || true
  kubectl get deploy,sts,pods,svc,endpoints -n default -o wide > "$dir/kubectl-default-workloads.txt" 2>&1 || true

  "$SERVICE_OPS_SCRIPT" > "$dir/service-ops.txt" 2>&1 || true
  "$NODE_LOGS_SCRIPT" > "$dir/node-logs.txt" 2>&1 || true
}

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "=== deploy-validation attempt ${attempt}/${MAX_ATTEMPTS} ==="

  if BASE_URL="$E2E_BASE_URL" "$SMOKE_LIVENESS_SCRIPT"; then
    if DOMAIN="$DOMAIN" CERT_NAME="$CERT_NAME" E2E_BASE_URL="$E2E_BASE_URL" MAX_LOOPS="$VALIDATION_MAX_LOOPS" SLEEP_SECONDS="$VALIDATION_SLEEP_SECONDS" \
      "$VALIDATION_LOOP_SCRIPT"; then
      readiness_output_dir="$OUTPUT_DIR/live-readiness/attempt-${attempt}"
      if MODE="$LIVE_BETTING_READINESS_MODE" \
        BASE_URL="$E2E_BASE_URL" \
        SECONDARY_PUBLIC_URL="$SECONDARY_PUBLIC_URL" \
        DIAGNOSTIC_URL="$DIAGNOSTIC_URL" \
        IMAGE_PROVENANCE_FILE="$IMAGE_PROVENANCE_FILE" \
        REQUEST_TIMEOUT="$LIVE_READINESS_REQUEST_TIMEOUT" \
        SSE_TIMEOUT="$LIVE_READINESS_SSE_TIMEOUT" \
        OUTPUT_DIR="$readiness_output_dir" \
        "$LIVE_BETTING_READINESS_SCRIPT"; then
        echo "deploy_validation_status=PASS"
        exit 0
      fi
      capture_diagnostics "$attempt" "live-betting-readiness-failed"
    else
      capture_diagnostics "$attempt" "validation-loop-failed"
    fi
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
