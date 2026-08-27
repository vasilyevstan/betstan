#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$OUTPUT_DIR"
cat >"$OUTPUT_DIR/summary.env" <<'EOF'
rollback_readiness=GO
mode=migration-transition
phase=backing-up
rollback_operator=infra/oci/scripts/reviewed-topology-rollback-stan.sh
EOF
cat "$OUTPUT_DIR/summary.env"
