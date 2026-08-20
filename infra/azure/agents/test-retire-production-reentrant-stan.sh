#!/usr/bin/env bash
# Regression: verify two retirement contract instances can run concurrently
# without fixture directory collisions.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_SCRIPT="$ROOT_DIR/infra/azure/agents/test-retire-production-stan.sh"

# Each instance gets its own mktemp directory via the shared safe parent.
# Override BETSTAN_TEST_TMPDIR so both instances share the same parent but
# allocate unique subdirs -- proving no collision.
_SAFE_PARENT="${BETSTAN_TEST_TMPDIR:-${ROOT_DIR}/.test-workdirs}"
mkdir -p "$_SAFE_PARENT"
export BETSTAN_TEST_TMPDIR="$_SAFE_PARENT"

# Launch two instances in parallel
pids=()
for _ in 1 2; do
  "$TEST_SCRIPT" &
  pids+=($!)
done

# Wait for both and require both to pass
failures=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    failures=$((failures + 1))
  fi
done

if [[ "$failures" -gt 0 ]]; then
  printf 'FAIL reentrant_retirement_contract: %d/%d instances failed\n' \
    "$failures" "${#pids[@]}" >&2
  exit 1
fi

printf 'reentrant_retirement_contract=PASS concurrent_instances=%d\n' "${#pids[@]}"
