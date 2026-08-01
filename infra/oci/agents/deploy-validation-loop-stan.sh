#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-${OCI_HEALTH_MAX_ATTEMPTS:-3}}"
SLEEP_SECONDS="${SLEEP_SECONDS:-${OCI_HEALTH_SLEEP_SECONDS:-30}}"
VALIDATION_MAX_LOOPS="${VALIDATION_MAX_LOOPS:-3}"
VALIDATION_SLEEP_SECONDS="${VALIDATION_SLEEP_SECONDS:-20}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/oci-deploy-validation}"

for value in MAX_ATTEMPTS SLEEP_SECONDS VALIDATION_MAX_LOOPS VALIDATION_SLEEP_SECONDS; do
  [[ "${!value}" =~ ^[1-9][0-9]*$ ]] || {
    echo "NO_GO deploy_validation_reason=$value must be positive" >&2
    exit 1
  }
done
mkdir -p "$OUTPUT_DIR"

capture_diagnostics() {
  local attempt="$1"
  local directory="$OUTPUT_DIR/attempt-${attempt}"
  mkdir -p "$directory"
  {
    printf 'attempt=%s\n' "$attempt"
    date -u '+utc=%Y-%m-%dT%H:%M:%SZ'
  } > "$directory/context.txt"
  "$OCI_DIR/agents/service-ops-stan.sh" > "$directory/service-ops.txt" 2>&1 || true
  "$OCI_DIR/agents/node-logs-stan.sh" > "$directory/node-logs.txt" 2>&1 || true
}

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "oci_deploy_validation_attempt=${attempt}/${MAX_ATTEMPTS}"
  if MAX_LOOPS="$VALIDATION_MAX_LOOPS" \
      SLEEP_SECONDS="$VALIDATION_SLEEP_SECONDS" \
      OUTPUT_DIR="$OUTPUT_DIR/validation-${attempt}" \
      "$OCI_DIR/agents/validation-loop-stan.sh"; then
    echo "DEPLOYED_HEALTHY"
    exit 0
  fi
  capture_diagnostics "$attempt"
  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    sleep "$SLEEP_SECONDS"
  fi
done

echo "NO_GO deploy_validation_reason=all bounded attempts failed" >&2
exit 1
