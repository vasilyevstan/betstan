#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=live-betting-readiness-test-lib.sh
source "$ROOT_DIR/infra/azure/agents/live-betting-readiness-test-lib.sh"
SCRIPT="$ROOT_DIR/infra/azure/agents/live-betting-readiness-stan.sh"

run_live_betting_scenario azure-rollback-drain-contract "$SCRIPT" azure MODE=rollback-drain
assert_eq 0 "$RUN_RC" "rollback-drain contract should pass when drained"
assert_contains "$RUN_SUMMARY_FILE" 'mode=rollback-drain' 'rollback-drain summary should persist mode'
assert_contains "$RUN_SUMMARY_FILE" 'image_provenance_rows=9' 'rollback-drain should verify nine immutable images'
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=none' 'rollback-drain should report no failed checks'

run_live_betting_scenario azure-rollback-drain-active "$SCRIPT" azure MODE=rollback-drain STUB_ACTIVE_MATCHES=1
assert_eq 1 "$RUN_RC" "rollback-drain contract should fail with active matches"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_counts' 'active matches should fail rollback-drain mongo counts'

echo 'live_betting_rollback_readiness_tests=PASS stack=azure scenarios=2'
