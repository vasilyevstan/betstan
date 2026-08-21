#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../azure/agents/live-betting-readiness-test-lib.sh
source "$ROOT_DIR/infra/azure/agents/live-betting-readiness-test-lib.sh"
SCRIPT="$ROOT_DIR/infra/oci/agents/live-betting-readiness-stan.sh"

run_live_betting_scenario oci-rollback-drain-contract "$SCRIPT" oci MODE=rollback-drain
assert_eq 0 "$RUN_RC" "OCI rollback-drain contract should pass when drained"
assert_contains "$RUN_SUMMARY_FILE" 'mode=rollback-drain' 'OCI rollback-drain summary should persist mode'
assert_contains "$RUN_SUMMARY_FILE" 'secondary_redirect_status=308' 'OCI rollback-drain should validate redirect host'
assert_contains "$RUN_SUMMARY_FILE" 'diagnostic_event_status=200' 'OCI rollback-drain should validate diagnostic event API'
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=none' 'OCI rollback-drain should report no failed checks'

run_live_betting_scenario oci-rollback-drain-active "$SCRIPT" oci MODE=rollback-drain STUB_SUBMITTED_LIVE_SLIPS=1
assert_eq 1 "$RUN_RC" "OCI rollback-drain contract should fail with submitted live slips"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_counts' 'submitted live slips should fail rollback-drain mongo counts'

echo 'live_betting_rollback_readiness_tests=PASS stack=oci scenarios=2'
