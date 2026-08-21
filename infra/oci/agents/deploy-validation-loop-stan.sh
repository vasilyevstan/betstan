#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-${OCI_HEALTH_MAX_ATTEMPTS:-3}}"
SLEEP_SECONDS="${SLEEP_SECONDS:-${OCI_HEALTH_SLEEP_SECONDS:-30}}"
VALIDATION_MAX_LOOPS="${VALIDATION_MAX_LOOPS:-3}"
VALIDATION_SLEEP_SECONDS="${VALIDATION_SLEEP_SECONDS:-20}"
VALIDATION_SCRIPT="${VALIDATION_SCRIPT:-$OCI_DIR/agents/validation-loop-stan.sh}"
LIVE_BETTING_READINESS_SCRIPT="${LIVE_BETTING_READINESS_SCRIPT:-$OCI_DIR/agents/live-betting-readiness-stan.sh}"
SERVICE_OPS_SCRIPT="${SERVICE_OPS_SCRIPT:-$OCI_DIR/agents/service-ops-stan.sh}"
NODE_LOGS_SCRIPT="${NODE_LOGS_SCRIPT:-$OCI_DIR/agents/node-logs-stan.sh}"
LIVE_BETTING_READINESS_MODE="${LIVE_BETTING_READINESS_MODE:-dark}"
LIVE_READINESS_REQUEST_TIMEOUT="${LIVE_READINESS_REQUEST_TIMEOUT:-15}"
LIVE_READINESS_SSE_TIMEOUT="${LIVE_READINESS_SSE_TIMEOUT:-20}"
IMAGE_PROVENANCE_FILE="${IMAGE_PROVENANCE_FILE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/oci-deploy-validation}"

for value in \
  MAX_ATTEMPTS SLEEP_SECONDS VALIDATION_MAX_LOOPS VALIDATION_SLEEP_SECONDS \
  LIVE_READINESS_REQUEST_TIMEOUT LIVE_READINESS_SSE_TIMEOUT; do
  [[ "${!value}" =~ ^[1-9][0-9]*$ ]] || {
    echo "NO_GO deploy_validation_reason=$value must be positive" >&2
    exit 1
  }
done
case "$LIVE_BETTING_READINESS_MODE" in
  dark|monitor)
    ;;
  *)
    echo "NO_GO deploy_validation_reason=LIVE_BETTING_READINESS_MODE must be dark or monitor" >&2
    exit 1
    ;;
esac
[[ -n "$IMAGE_PROVENANCE_FILE" && -f "$IMAGE_PROVENANCE_FILE" ]] || {
  echo "NO_GO deploy_validation_reason=IMAGE_PROVENANCE_FILE is required" >&2
  exit 1
}
mkdir -p "$OUTPUT_DIR"

capture_diagnostics() {
  local attempt="$1"
  local directory="$OUTPUT_DIR/attempt-${attempt}"
  mkdir -p "$directory"
  {
    printf 'attempt=%s\n' "$attempt"
    printf 'image_provenance_file=%s\n' "$IMAGE_PROVENANCE_FILE"
    printf 'live_betting_readiness_mode=%s\n' "$LIVE_BETTING_READINESS_MODE"
    date -u '+utc=%Y-%m-%dT%H:%M:%SZ'
  } > "$directory/context.txt"
  "$SERVICE_OPS_SCRIPT" > "$directory/service-ops.txt" 2>&1 || true
  "$NODE_LOGS_SCRIPT" > "$directory/node-logs.txt" 2>&1 || true
}

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "oci_deploy_validation_attempt=${attempt}/${MAX_ATTEMPTS}"
  if MAX_LOOPS="$VALIDATION_MAX_LOOPS" \
      SLEEP_SECONDS="$VALIDATION_SLEEP_SECONDS" \
      OUTPUT_DIR="$OUTPUT_DIR/validation-${attempt}" \
      "$VALIDATION_SCRIPT"; then
    readiness_output_dir="$OUTPUT_DIR/live-readiness/attempt-${attempt}"
    if MODE="$LIVE_BETTING_READINESS_MODE" \
      BASE_URL="$OCI_PUBLIC_URL" \
      SECONDARY_PUBLIC_URL="$OCI_REDIRECT_URL" \
      DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
      IMAGE_PROVENANCE_FILE="$IMAGE_PROVENANCE_FILE" \
      REQUEST_TIMEOUT="$LIVE_READINESS_REQUEST_TIMEOUT" \
      SSE_TIMEOUT="$LIVE_READINESS_SSE_TIMEOUT" \
      OUTPUT_DIR="$readiness_output_dir" \
      "$LIVE_BETTING_READINESS_SCRIPT"; then
      echo "DEPLOYED_HEALTHY"
      exit 0
    fi
  fi
  capture_diagnostics "$attempt"
  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    sleep "$SLEEP_SECONDS"
  fi
done

echo "NO_GO deploy_validation_reason=all bounded attempts failed" >&2
exit 1
