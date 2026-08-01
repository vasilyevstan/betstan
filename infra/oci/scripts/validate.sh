#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-validation}"
oci_prepare_private_dir "$OUTPUT_DIR"

OUTPUT_FILE="$OUTPUT_DIR/inventory.json" INVENTORY_MODE=complete \
  "$SCRIPT_DIR/inventory.sh"
OUTPUT_DIR="$OUTPUT_DIR/health" \
  "$OCI_DIR/agents/health-check-stan.sh"
OUTPUT_DIR="$OUTPUT_DIR/smoke" \
  "$OCI_DIR/agents/smoke-liveness-stan.sh"

oci_log "oci_validation=PASS"
