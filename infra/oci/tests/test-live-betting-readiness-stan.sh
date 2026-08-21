#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../azure/agents/live-betting-readiness-test-lib.sh
source "$ROOT_DIR/infra/azure/agents/live-betting-readiness-test-lib.sh"
SCRIPT="$ROOT_DIR/infra/oci/agents/live-betting-readiness-stan.sh"

run_live_betting_scenario oci-monitor "$SCRIPT" oci \
  MODE=monitor \
  STUB_FLAG_VALUE=true \
  STUB_ACTIVE_MATCHES=5 \
  STUB_SUBMITTED_LIVE_SLIPS=9 \
  STUB_BET_PENDING_COUNT=1 \
  STUB_BET_PENDING_AGE_SECONDS=120 \
  STUB_BET_PROCESSING_COUNT=1 \
  STUB_BET_PROCESSING_AGE_SECONDS=45 \
  STUB_MODERATION_PENDING_COUNT=1 \
  STUB_MODERATION_PENDING_AGE_SECONDS=180 \
  STUB_MODERATION_PROCESSING_COUNT=1 \
  STUB_MODERATION_PROCESSING_AGE_SECONDS=60 \
  STUB_RESULTING_PENDING_COUNT=1 \
  STUB_RESULTING_PENDING_AGE_SECONDS=240 \
  STUB_RESULTING_PROCESSING_COUNT=1 \
  STUB_RESULTING_PROCESSING_AGE_SECONDS=75 \
  STUB_RESULTING_RETRY_PENDING_COUNT=1 \
  STUB_RESULTING_RETRY_PENDING_AGE_SECONDS=90 \
  STUB_RESULTING_RETRY_PROCESSING_COUNT=1 \
  STUB_RESULTING_RETRY_PROCESSING_AGE_SECONDS=60
assert_eq 0 "$RUN_RC" "OCI monitor mode should pass"
assert_contains "$RUN_SUMMARY_FILE" 'mode=monitor' 'OCI monitor summary should persist mode'
assert_contains "$RUN_SUMMARY_FILE" 'secondary_redirect_status=308' 'OCI monitor should validate redirect host'
assert_contains "$RUN_SUMMARY_FILE" 'diagnostic_event_status=200' 'OCI monitor should validate diagnostic event API'
assert_contains "$RUN_SUMMARY_FILE" 'sse_diagnostic_status=200' 'OCI monitor should validate diagnostic SSE'
assert_contains "$RUN_SUMMARY_FILE" 'bet_pending_bet_update_processing_count=1' 'OCI monitor should surface bet processing backlog'
assert_contains "$RUN_SUMMARY_FILE" 'moderation_parked_place_bet_processing_count=1' 'OCI monitor should surface moderation processing backlog'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_pending_moderation_result_processing_count=1' 'OCI monitor should surface resulting processing backlog'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_retry_record_dead_letter_count=0' 'OCI monitor should surface retry dead-letter count'
assert_contains "$RUN_SUMMARY_FILE" 'workflow_processing_count_limit=6' 'OCI monitor should surface workflow processing threshold'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-moderation-parked-place-bet.js" 'processing: { statuses: ["PROCESSING"], includeLegacyMissingStatus: false, primaryField: "leaseUntil", fallbackField: "" }' 'OCI moderation query should use leaseUntil for processing age'
assert_not_contains "$RUN_QUERY_CAPTURE_DIR/mongo-moderation-parked-place-bet.js" 'parkedAt' 'OCI moderation query should not reference nonexistent parkedAt fields'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-retry-record.js" 'deadLetter: { statuses: ["DEAD_LETTER"], includeLegacyMissingStatus: false, primaryField: "deadLetteredAt", fallbackField: "" }' 'OCI retry query should use DEAD_LETTER and deadLetteredAt for terminal age'

run_live_betting_scenario oci-activate "$SCRIPT" oci MODE=activate STUB_FLAG_VALUE=true STUB_ACTIVE_MATCHES=1 STUB_SUBMITTED_LIVE_SLIPS=2
assert_eq 0 "$RUN_RC" "OCI activate mode should pass"
assert_contains "$RUN_SUMMARY_FILE" 'schema_evidence_verified=true' 'OCI activate should validate schema evidence'
assert_contains "$RUN_SUMMARY_FILE" 'rollback_baseline_verified=true' 'OCI activate should validate rollback baseline'
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=none' 'OCI activate should report no failed checks'
assert_contains "$RUN_SUMMARY_FILE" 'legacy_prematch_events=1' 'OCI activate should persist prematch evidence'

run_live_betting_scenario oci-legacy-monitor "$SCRIPT" oci \
  MODE=monitor \
  STUB_TOPOLOGY_MODE=legacy \
  STUB_FLAG_VALUE=true \
  STUB_BET_LEGACY_PENDING_COUNT=1 \
  STUB_BET_LEGACY_PENDING_AGE_SECONDS=120 \
  STUB_RESULTING_RETRY_LEGACY_PENDING_COUNT=1 \
  STUB_RESULTING_RETRY_LEGACY_PENDING_AGE_SECONDS=180
assert_eq 0 "$RUN_RC" "OCI monitor should support legacy topology parking diagnostics"
assert_contains "$RUN_SUMMARY_FILE" 'topology_mode=legacy' 'OCI legacy monitor should persist topology mode'
assert_contains "$RUN_SUMMARY_FILE" 'bet_pending_bet_update_pending_count=1' 'OCI legacy monitor should classify missing-status bet docs as pending'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_retry_record_pending_count=1' 'OCI legacy monitor should classify missing-status retry docs as pending'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-bet-pending-bet-update.js" 'includeLegacyMissingStatus: true' 'OCI bet query should include legacy missing-status docs'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-retry-record.js" 'includeLegacyMissingStatus: true' 'OCI retry query should include legacy missing-status docs'

run_live_betting_scenario oci-sse-heartbeat "$SCRIPT" oci MODE=monitor STUB_FLAG_VALUE=true STUB_SSE_MODE=bad-heartbeat
assert_eq 1 "$RUN_RC" "OCI monitor should fail without SSE heartbeat"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=sse_contract' 'missing SSE heartbeat should fail SSE contract'

run_live_betting_scenario oci-prematch-empty "$SCRIPT" oci MODE=monitor STUB_FLAG_VALUE=true STUB_EVENT_MODE=empty
assert_eq 1 "$RUN_RC" "OCI monitor should fail on empty PRE_MATCH payload"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=legacy_prematch_api' 'empty event payload should fail prematch contract'

run_live_betting_scenario oci-retry-dead-letter "$SCRIPT" oci MODE=monitor STUB_FLAG_VALUE=true STUB_RESULTING_RETRY_DEAD_LETTER_COUNT=1 STUB_RESULTING_RETRY_DEAD_LETTER_AGE_SECONDS=45
assert_eq 1 "$RUN_RC" "OCI monitor should fail on retry dead-letter backlog"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_workflow_parking' 'retry dead-letter backlog should fail workflow parking contract'

run_live_betting_scenario oci-terminal-buckets "$SCRIPT" oci \
  MODE=monitor \
  STUB_FLAG_VALUE=true \
  STUB_BET_EXHAUSTED_COUNT=1 \
  STUB_BET_EXHAUSTED_AGE_SECONDS=30 \
  STUB_RESULTING_EXHAUSTED_COUNT=1 \
  STUB_RESULTING_EXHAUSTED_AGE_SECONDS=60
assert_eq 1 "$RUN_RC" "OCI monitor should fail when non-retry terminal workflow buckets are non-zero"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_workflow_parking' 'OCI non-retry terminal workflow buckets should fail workflow parking contract'
assert_contains "$RUN_SCENARIO_DIR/output/mongo-bet-pending-bet-update.json" '"exhausted":{"count":1,"oldestAgeSeconds":30}' 'OCI bet terminal fixture should surface exhausted counts'
assert_contains "$RUN_SCENARIO_DIR/output/mongo-resulting-pending-moderation-result.json" '"exhausted":{"count":1,"oldestAgeSeconds":60}' 'OCI resulting pending moderation terminal fixture should surface exhausted counts'

echo 'live_betting_readiness_tests=PASS stack=oci scenarios=7'
