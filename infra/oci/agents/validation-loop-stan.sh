#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
MAX_LOOPS="${MAX_LOOPS:-3}"
SLEEP_SECONDS="${SLEEP_SECONDS:-20}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/oci-validation-loop}"
OCI_PUBLIC_URL="${OCI_PUBLIC_URL:-}"

[[ "$MAX_LOOPS" =~ ^[1-9][0-9]*$ ]] || {
  echo "NO_GO validation_reason=MAX_LOOPS must be positive" >&2
  exit 1
}
[[ "$SLEEP_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  echo "NO_GO validation_reason=SLEEP_SECONDS must be positive" >&2
  exit 1
}
[[ -n "$OCI_PUBLIC_URL" ]] || {
  echo "NO_GO validation_reason=OCI_PUBLIC_URL is required" >&2
  exit 1
}
mkdir -p "$OUTPUT_DIR"

for attempt in $(seq 1 "$MAX_LOOPS"); do
  echo "oci_validation_iteration=${attempt}/${MAX_LOOPS}"
  if OCI_PUBLIC_URL="$OCI_PUBLIC_URL" OUTPUT_DIR="$OUTPUT_DIR/smoke-${attempt}" \
      "$OCI_DIR/agents/smoke-liveness-stan.sh"; then
    playwright="$ROOT_DIR/client/node_modules/.bin/playwright"
    if [[ -x "$playwright" ]] && (
      cd "$ROOT_DIR"
      NODE_PATH="$ROOT_DIR/client/node_modules" \
      E2E_BASE_URL="$OCI_PUBLIC_URL" \
      OCI_E2E_OUTPUT_DIR="$OUTPUT_DIR/e2e-${attempt}" \
        "$playwright" test --config "$OCI_DIR/agents/playwright.config.js"
    ); then
      if OCI_PUBLIC_CHECKS_ALREADY_PASSED=1 OCI_E2E_ALREADY_PASSED=1 \
          OUTPUT_DIR="$OUTPUT_DIR/health-${attempt}" \
          "$OCI_DIR/agents/health-check-stan.sh"; then
        echo "oci_validation_loop=PASS"
        exit 0
      fi
    fi
  fi
  if [[ "$attempt" -lt "$MAX_LOOPS" ]]; then
    sleep "$SLEEP_SECONDS"
  fi
done

echo "NO_GO validation_reason=bounded OCI validation loop exhausted" >&2
exit 1
