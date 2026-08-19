#!/usr/bin/env bash
# Entrypoint: run all OCI contract test suites in deterministic order.
# Summarises results without masking failures (set -e halts on first failure;
# use BETSTAN_RUN_ALL=1 to collect all results before exiting non-zero).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TESTS_DIR="$ROOT_DIR/infra/oci/tests"

# Deterministic suite order
suites=(
  "$TESTS_DIR/test-contract.sh"
  "$TESTS_DIR/test-capacity-contract.sh"
  "$TESTS_DIR/test-image-reuse-contract.sh"
  "$TESTS_DIR/test-k3s-runtime-contract.sh"
  "$TESTS_DIR/test-migration-recovery-contract.sh"
  "$TESTS_DIR/test-mongo-upgrade.sh"
)

# Also include the OCI health contract (lives under agents/)
suites+=("$ROOT_DIR/infra/oci/agents/test-health-contract-stan.sh")

passed=0
failed=0
failed_names=()

for suite in "${suites[@]}"; do
  name="$(basename "$suite")"
  printf '▶ %s\n' "$name"
  if "$suite"; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    failed_names+=("$name")
    if [[ "${BETSTAN_RUN_ALL:-0}" != "1" ]]; then
      printf 'FAIL %s — aborting (set BETSTAN_RUN_ALL=1 to continue)\n' "$name" >&2
      exit 1
    fi
  fi
done

printf '\noci_contracts_summary passed=%d failed=%d total=%d\n' \
  "$passed" "$failed" "$(( passed + failed ))"

if [[ "$failed" -gt 0 ]]; then
  printf 'FAILED suites: %s\n' "${failed_names[*]}" >&2
  exit 1
fi
