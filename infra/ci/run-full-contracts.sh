#!/usr/bin/env bash
# Nightly backstop: run one contract shard with suite selection disabled.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
shard="${1:?usage: run-full-contracts.sh <shard>}"
export BETSTAN_CI_FULL=1

if [[ "$shard" != azure ]]; then
  BETSTAN_CONTRACT_SHARD="$shard" exec "$ROOT_DIR/infra/oci/tests/run-contracts.sh"
fi
# Guarded production-build suites that no OCI shard owns.
for suite in \
  test-production-rollback-stan.sh \
  test-live-betting-readiness-stan.sh \
  test-shared-mongo-operation-lock-stan.sh; do
  printf '> %s\n' "$suite"
  "$ROOT_DIR/infra/azure/agents/$suite"
done
