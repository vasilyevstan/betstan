#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=live-betting-readiness-test-lib.sh
source "$ROOT_DIR/infra/azure/agents/live-betting-readiness-test-lib.sh"
SCRIPT="$ROOT_DIR/infra/azure/agents/live-betting-readiness-stan.sh"

run_live_betting_scenario azure-dark "$SCRIPT" azure \
  MODE=dark \
  STUB_BET_PENDING_COUNT=1 \
  STUB_BET_PENDING_AGE_SECONDS=60 \
  STUB_BET_PROCESSING_COUNT=1 \
  STUB_BET_PROCESSING_AGE_SECONDS=30 \
  STUB_MODERATION_PENDING_COUNT=1 \
  STUB_MODERATION_PENDING_AGE_SECONDS=90 \
  STUB_MODERATION_PROCESSING_COUNT=1 \
  STUB_MODERATION_PROCESSING_AGE_SECONDS=45 \
  STUB_RESULTING_PENDING_COUNT=1 \
  STUB_RESULTING_PENDING_AGE_SECONDS=120 \
  STUB_RESULTING_PROCESSING_COUNT=1 \
  STUB_RESULTING_PROCESSING_AGE_SECONDS=50 \
  STUB_RESULTING_RETRY_PENDING_COUNT=1 \
  STUB_RESULTING_RETRY_PENDING_AGE_SECONDS=75 \
  STUB_RESULTING_RETRY_PROCESSING_COUNT=1 \
  STUB_RESULTING_RETRY_PROCESSING_AGE_SECONDS=60
assert_eq 0 "$RUN_RC" "dark mode should pass"
assert_contains "$RUN_STDOUT" 'live_betting_readiness=GO' 'dark summary should report GO'
assert_contains "$RUN_SUMMARY_FILE" 'mode=dark' 'dark summary should persist mode'
assert_contains "$RUN_SUMMARY_FILE" 'actual_live_kickoffs_enabled=false' 'dark summary should persist dark flag'
assert_contains "$RUN_SUMMARY_FILE" 'overdue_unstarted_events=0' 'dark summary should include overdue unstarted events'
assert_contains "$RUN_SUMMARY_FILE" 'simulation_quarantines=0' 'dark summary should include simulation quarantines'
assert_contains "$RUN_SUMMARY_FILE" 'unstarted_event_grace_seconds=120' 'dark summary should include the overdue grace period'
assert_contains "$RUN_SUMMARY_FILE" 'workflow_pending_count_limit=2' 'dark summary should persist pending workflow threshold'
assert_contains "$RUN_SUMMARY_FILE" 'bet_pending_bet_update_pending_count=1' 'dark summary should include bet pending parking count'
assert_contains "$RUN_SUMMARY_FILE" 'bet_pending_bet_update_processing_count=1' 'dark summary should include bet processing parking count'
assert_contains "$RUN_SUMMARY_FILE" 'moderation_parked_place_bet_pending_count=1' 'dark summary should include moderation pending parking count'
assert_contains "$RUN_SUMMARY_FILE" 'moderation_parked_place_bet_processing_count=1' 'dark summary should include moderation processing parking count'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_pending_moderation_result_pending_count=1' 'dark summary should include resulting pending parking count'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_pending_moderation_result_processing_count=1' 'dark summary should include resulting processing parking count'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_retry_record_pending_count=1' 'dark summary should include retry pending parking count'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_retry_record_processing_count=1' 'dark summary should include retry processing parking count'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_retry_record_dead_letter_count=0' 'dark summary should include retry dead-letter count'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-bet-pending-bet-update.js" 'collectionName: "pendingbetupdates"' 'bet query should use actual PendingBetUpdate collection name'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-bet-pending-bet-update.js" 'pending: { statuses: ["PENDING"], includeLegacyMissingStatus: true, primaryField: "nextAttemptAt", fallbackField: "createdAt" }' 'bet query should classify pending PendingBetUpdate docs by nextAttemptAt or createdAt'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-bet-pending-bet-update.js" 'processing: { statuses: ["PROCESSING"], includeLegacyMissingStatus: false, primaryField: "leaseUntil", fallbackField: "" }' 'bet query should classify processing PendingBetUpdate docs by leaseUntil'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-bet-pending-bet-update.js" 'exhausted: { statuses: ["EXHAUSTED"], includeLegacyMissingStatus: false, primaryField: "exhaustedAt", fallbackField: "" }' 'bet query should classify exhausted PendingBetUpdate docs by exhaustedAt'
assert_not_contains "$RUN_QUERY_CAPTURE_DIR/mongo-bet-pending-bet-update.js" 'countDocuments({})' 'bet query should not scan the whole collection as a single bucket'
assert_not_contains "$RUN_QUERY_CAPTURE_DIR/mongo-bet-pending-bet-update.js" 'processing: {count: 0' 'bet query should not hardcode zero processing metrics'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-moderation-parked-place-bet.js" 'collectionName: "parkedplacebets"' 'moderation query should use actual ParkedPlaceBet collection name'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-moderation-parked-place-bet.js" 'pending: { statuses: ["PENDING"], includeLegacyMissingStatus: true, primaryField: "nextAttemptAt", fallbackField: "createdAt" }' 'moderation query should use nextAttemptAt or createdAt for pending age'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-moderation-parked-place-bet.js" 'processing: { statuses: ["PROCESSING"], includeLegacyMissingStatus: false, primaryField: "leaseUntil", fallbackField: "" }' 'moderation query should use leaseUntil for processing age'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-moderation-parked-place-bet.js" 'exhausted: { statuses: ["EXHAUSTED"], includeLegacyMissingStatus: false, primaryField: "exhaustedAt", fallbackField: "" }' 'moderation query should use exhaustedAt for terminal age'
assert_not_contains "$RUN_QUERY_CAPTURE_DIR/mongo-moderation-parked-place-bet.js" 'parkedAt' 'moderation query should not reference nonexistent parkedAt fields'
assert_not_contains "$RUN_QUERY_CAPTURE_DIR/mongo-moderation-parked-place-bet.js" 'processing: {count: 0' 'moderation query should not hardcode zero processing metrics'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-pending-moderation-result.js" 'collectionName: "pendingmoderationresults"' 'resulting pending moderation query should use actual collection name'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-pending-moderation-result.js" 'pending: { statuses: ["PENDING"], includeLegacyMissingStatus: true, primaryField: "nextAttemptAt", fallbackField: "createdAt" }' 'resulting pending moderation query should use nextAttemptAt or createdAt for pending age'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-pending-moderation-result.js" 'processing: { statuses: ["PROCESSING"], includeLegacyMissingStatus: false, primaryField: "leasedUntil", fallbackField: "" }' 'resulting pending moderation query should use leasedUntil for processing age'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-pending-moderation-result.js" 'exhausted: { statuses: ["EXHAUSTED"], includeLegacyMissingStatus: false, primaryField: "exhaustedAt", fallbackField: "" }' 'resulting pending moderation query should use exhaustedAt for terminal age'
assert_not_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-pending-moderation-result.js" 'countDocuments({})' 'resulting pending moderation query should not collapse all docs into one bucket'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-retry-record.js" 'collectionName: "retryrecords"' 'retry query should use actual RetryRecord collection name'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-retry-record.js" 'pending: { statuses: ["PENDING"], includeLegacyMissingStatus: true, primaryField: "nextAttemptAt", fallbackField: "createdAt" }' 'retry query should classify pending RetryRecord docs by nextAttemptAt or createdAt'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-retry-record.js" 'processing: { statuses: ["PROCESSING"], includeLegacyMissingStatus: false, primaryField: "leasedUntil", fallbackField: "" }' 'retry query should use leasedUntil for processing age'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-retry-record.js" 'deadLetter: { statuses: ["DEAD_LETTER"], includeLegacyMissingStatus: false, primaryField: "deadLetteredAt", fallbackField: "" }' 'retry query should use DEAD_LETTER and deadLetteredAt for terminal age'
assert_not_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-retry-record.js" 'statuses: ["EXHAUSTED"]' 'retry query should not invent an EXHAUSTED status bucket'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-active.js" 'time: {$lt: overdueBefore}' 'Gamemaster query should bound overdue unstarted events by time'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-active.js" '"simulationFailure.quarantinedAt": {$exists: true, $ne: null}' 'Gamemaster query should count only persisted simulation quarantines'
assert_not_contains "$RUN_QUERY_CAPTURE_DIR/mongo-active.js" '__UNSTARTED_EVENT_GRACE_SECONDS__' 'Gamemaster query should resolve the configured grace period'

run_live_betting_scenario azure-activate "$SCRIPT" azure MODE=activate STUB_FLAG_VALUE=true STUB_ACTIVE_MATCHES=2 STUB_SUBMITTED_LIVE_SLIPS=3
assert_eq 0 "$RUN_RC" "activate mode should pass"
assert_contains "$RUN_SUMMARY_FILE" 'mode=activate' 'activate summary should persist mode'
assert_contains "$RUN_SUMMARY_FILE" 'schema_evidence_verified=true' 'activate summary should persist schema evidence'
assert_contains "$RUN_SUMMARY_FILE" 'rollback_baseline_verified=true' 'activate summary should persist rollback baseline'

run_live_betting_scenario azure-legacy-missing-status-under-limit "$SCRIPT" azure \
  MODE=dark \
  STUB_TOPOLOGY_MODE=legacy \
  STUB_BET_LEGACY_PENDING_COUNT=1 \
  STUB_BET_LEGACY_PENDING_AGE_SECONDS=60 \
  STUB_MODERATION_LEGACY_PENDING_COUNT=1 \
  STUB_MODERATION_LEGACY_PENDING_AGE_SECONDS=120 \
  STUB_RESULTING_LEGACY_PENDING_COUNT=1 \
  STUB_RESULTING_LEGACY_PENDING_AGE_SECONDS=180 \
  STUB_RESULTING_RETRY_LEGACY_PENDING_COUNT=1 \
  STUB_RESULTING_RETRY_LEGACY_PENDING_AGE_SECONDS=90
assert_eq 0 "$RUN_RC" "legacy topology should pass when statusless backlog stays below limits"
assert_contains "$RUN_SUMMARY_FILE" 'topology_mode=legacy' 'legacy scenario should persist topology mode'
assert_contains "$RUN_SUMMARY_FILE" 'lock_state=not_applicable' 'legacy scenario should skip shared lock enforcement'
assert_contains "$RUN_SUMMARY_FILE" 'bet_pending_bet_update_pending_count=1' 'legacy scenario should classify missing-status bet docs as pending'
assert_contains "$RUN_SUMMARY_FILE" 'moderation_parked_place_bet_pending_count=1' 'legacy scenario should classify missing-status moderation docs as pending'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_pending_moderation_result_pending_count=1' 'legacy scenario should classify missing-status resulting docs as pending'
assert_contains "$RUN_SUMMARY_FILE" 'resulting_retry_record_pending_count=1' 'legacy scenario should classify missing-status retry docs as pending'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-bet-pending-bet-update.js" 'includeLegacyMissingStatus: true' 'bet query should explicitly include legacy missing-status docs'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-moderation-parked-place-bet.js" 'includeLegacyMissingStatus: true' 'moderation query should explicitly include legacy missing-status docs'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-pending-moderation-result.js" 'includeLegacyMissingStatus: true' 'resulting pending moderation query should explicitly include legacy missing-status docs'
assert_contains "$RUN_QUERY_CAPTURE_DIR/mongo-resulting-retry-record.js" 'includeLegacyMissingStatus: true' 'retry query should explicitly include legacy missing-status docs'

run_live_betting_scenario azure-rollback-drain "$SCRIPT" azure MODE=rollback-drain
assert_eq 0 "$RUN_RC" "rollback-drain should pass when drained"
assert_contains "$RUN_SUMMARY_FILE" 'mode=rollback-drain' 'rollback summary should persist mode'
assert_contains "$RUN_SUMMARY_FILE" 'active_matches=0' 'rollback summary should show zero active matches'
assert_contains "$RUN_SUMMARY_FILE" 'legacy_prematch_events=1' 'rollback summary should persist prematch evidence'

run_live_betting_scenario azure-prematch-live-only "$SCRIPT" azure MODE=rollback-drain STUB_EVENT_MODE=live-only
assert_eq 1 "$RUN_RC" "rollback-drain should fail without legacy PRE_MATCH evidence"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=legacy_prematch_api' 'live-only event payload should fail prematch contract'

run_live_betting_scenario azure-prematch-malformed "$SCRIPT" azure MODE=monitor STUB_FLAG_VALUE=true STUB_EVENT_MODE=malformed
assert_eq 1 "$RUN_RC" "monitor mode should fail on malformed PRE_MATCH payload"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=legacy_prematch_api' 'malformed event payload should fail prematch contract'

run_live_betting_scenario azure-flag-wrong "$SCRIPT" azure MODE=dark STUB_FLAG_VALUE=true
assert_eq 1 "$RUN_RC" "dark mode should fail with wrong flag"
assert_contains "$RUN_SUMMARY_FILE" 'live_betting_readiness=NO_GO' 'wrong flag should report NO_GO'
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=workload_images' 'wrong flag should fail workload image contract'

run_live_betting_scenario azure-absent-consumer "$SCRIPT" azure MODE=monitor STUB_FLAG_VALUE=true STUB_DYNAMIC_QUEUE_CONSUMERS=0
assert_eq 1 "$RUN_RC" "monitor mode should fail when live consumer is absent"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=rabbitmq_queues' 'missing consumer should fail rabbitmq contract'

run_live_betting_scenario azure-queue-backlog "$SCRIPT" azure MODE=monitor STUB_FLAG_VALUE=true STUB_QUEUE_READY=3 MAX_LIVE_QUEUE_READY=0
assert_eq 1 "$RUN_RC" "monitor mode should fail on queue backlog"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=rabbitmq_queues' 'queue backlog should fail rabbitmq contract'

run_live_betting_scenario azure-sse-headers "$SCRIPT" azure MODE=monitor STUB_FLAG_VALUE=true STUB_SSE_MODE=bad-headers
assert_eq 1 "$RUN_RC" "monitor mode should fail on bad SSE headers"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=sse_contract' 'bad SSE headers should fail SSE contract'

run_live_betting_scenario azure-active-drain "$SCRIPT" azure MODE=rollback-drain STUB_ACTIVE_MATCHES=1
assert_eq 1 "$RUN_RC" "rollback-drain should fail with active matches"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_counts' 'active drain should fail Mongo count contract'

run_live_betting_scenario azure-overdue-unstarted "$SCRIPT" azure MODE=dark STUB_OVERDUE_UNSTARTED_EVENTS=1
assert_eq 1 "$RUN_RC" "dark mode should fail with an overdue unstarted event"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_counts' 'overdue unstarted events should fail Mongo count contract'

run_live_betting_scenario azure-simulation-quarantine "$SCRIPT" azure MODE=monitor STUB_FLAG_VALUE=true STUB_SIMULATION_QUARANTINES=1
assert_eq 1 "$RUN_RC" "monitor mode should fail with a simulation quarantine"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_counts' 'simulation quarantines should fail Mongo count contract'

run_live_betting_scenario azure-bet-pending-over-limit "$SCRIPT" azure MODE=dark STUB_BET_PENDING_COUNT=3
assert_eq 1 "$RUN_RC" "dark mode should fail on excessive bet parking backlog"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_workflow_parking' 'excessive bet parking backlog should fail workflow parking contract'

run_live_betting_scenario azure-moderation-pending-age-over-limit "$SCRIPT" azure MODE=dark STUB_MODERATION_PENDING_AGE_SECONDS=301 STUB_MODERATION_PENDING_COUNT=1
assert_eq 1 "$RUN_RC" "dark mode should fail on stale moderation parking backlog"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_workflow_parking' 'stale moderation parking backlog should fail workflow parking contract'

run_live_betting_scenario azure-retry-processing-over-limit "$SCRIPT" azure MODE=dark STUB_RESULTING_RETRY_PROCESSING_COUNT=2 STUB_RESULTING_RETRY_PROCESSING_AGE_SECONDS=181
assert_eq 1 "$RUN_RC" "dark mode should fail on excessive retry processing backlog"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_workflow_parking' 'retry processing backlog should fail workflow parking contract'

run_live_betting_scenario azure-retry-dead-letter "$SCRIPT" azure MODE=monitor STUB_FLAG_VALUE=true STUB_RESULTING_RETRY_DEAD_LETTER_COUNT=1 STUB_RESULTING_RETRY_DEAD_LETTER_AGE_SECONDS=30
assert_eq 1 "$RUN_RC" "monitor mode should fail when retry dead-letter backlog is non-zero"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_workflow_parking' 'retry dead-letter backlog should fail workflow parking contract'

run_live_betting_scenario azure-terminal-buckets "$SCRIPT" azure \
  MODE=monitor \
  STUB_FLAG_VALUE=true \
  STUB_BET_EXHAUSTED_COUNT=1 \
  STUB_BET_EXHAUSTED_AGE_SECONDS=30 \
  STUB_MODERATION_EXHAUSTED_COUNT=1 \
  STUB_MODERATION_EXHAUSTED_AGE_SECONDS=45 \
  STUB_RESULTING_EXHAUSTED_COUNT=1 \
  STUB_RESULTING_EXHAUSTED_AGE_SECONDS=60 \
  STUB_RESULTING_RETRY_DEAD_LETTER_COUNT=1 \
  STUB_RESULTING_RETRY_DEAD_LETTER_AGE_SECONDS=90
assert_eq 1 "$RUN_RC" "monitor mode should fail when terminal workflow buckets are non-zero"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_workflow_parking' 'terminal workflow buckets should fail workflow parking contract'
assert_contains "$RUN_SCENARIO_DIR/output/mongo-bet-pending-bet-update.json" '"exhausted":{"count":1,"oldestAgeSeconds":30}' 'bet terminal fixture should surface exhausted counts'
assert_contains "$RUN_SCENARIO_DIR/output/mongo-moderation-parked-place-bet.json" '"exhausted":{"count":1,"oldestAgeSeconds":45}' 'moderation terminal fixture should surface exhausted counts'
assert_contains "$RUN_SCENARIO_DIR/output/mongo-resulting-pending-moderation-result.json" '"exhausted":{"count":1,"oldestAgeSeconds":60}' 'resulting pending moderation terminal fixture should surface exhausted counts'
assert_contains "$RUN_SCENARIO_DIR/output/mongo-resulting-retry-record.json" '"deadLetter":{"count":1,"oldestAgeSeconds":90}' 'retry terminal fixture should surface dead-letter counts'

run_live_betting_scenario azure-db-command-failure-bet "$SCRIPT" azure MODE=dark STUB_COMMAND_FAILURE=mongo-bet-pending-bet-update
assert_eq 1 "$RUN_RC" "dark mode should fail when bet workflow Mongo query fails"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_workflow_parking' 'bet workflow Mongo command failure should fail workflow parking contract'

run_live_betting_scenario azure-malformed-resulting "$SCRIPT" azure MODE=monitor STUB_FLAG_VALUE=true STUB_MONGO_MALFORMED_TARGET=mongo-resulting-pending-moderation-result
assert_eq 1 "$RUN_RC" "monitor mode should fail on malformed resulting pending workflow metrics"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=mongo_workflow_parking' 'malformed resulting workflow metrics should fail workflow parking contract'

run_live_betting_scenario azure-missing-provenance "$SCRIPT" azure MODE=activate STUB_FLAG_VALUE=true EXACT_MASTER_PROVENANCE_FILE=
assert_eq 1 "$RUN_RC" "activate mode should fail when provenance is missing"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=exact_master_provenance' 'missing provenance should fail exact-master contract'

run_live_betting_scenario azure-topology-lock "$SCRIPT" azure MODE=dark STUB_LOCK_STATE=active
assert_eq 1 "$RUN_RC" "dark mode should fail when topology lock is active"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=topology_lock' 'active lock should fail topology contract'

run_live_betting_scenario azure-expected-topology-lock "$SCRIPT" azure \
  MODE=dark \
  STUB_LOCK_STATE=active \
  STUB_LOCK_HOLDER=live-data-4003-1 \
  STUB_LOCK_OPERATION_ID=live-data-apply-slip-index \
  STUB_LOCK_SOURCE_SHA=1111111111111111111111111111111111111111 \
  EXPECTED_OPERATION_LOCK_HOLDER=live-data-4003-1 \
  EXPECTED_OPERATION_LOCK_ID=live-data-apply-slip-index \
  EXPECTED_OPERATION_LOCK_SOURCE_SHA=1111111111111111111111111111111111111111
assert_eq 0 "$RUN_RC" "dark validation should accept the exact active deploy handoff lock"
assert_contains "$RUN_SUMMARY_FILE" 'lock_state=active' 'expected active lock should be recorded'

run_live_betting_scenario azure-wrong-topology-lock-holder "$SCRIPT" azure \
  MODE=dark \
  STUB_LOCK_STATE=active \
  STUB_LOCK_HOLDER=different-holder \
  STUB_LOCK_OPERATION_ID=live-data-apply-slip-index \
  STUB_LOCK_SOURCE_SHA=1111111111111111111111111111111111111111 \
  EXPECTED_OPERATION_LOCK_HOLDER=live-data-4003-1 \
  EXPECTED_OPERATION_LOCK_ID=live-data-apply-slip-index \
  EXPECTED_OPERATION_LOCK_SOURCE_SHA=1111111111111111111111111111111111111111
assert_eq 1 "$RUN_RC" "dark validation should reject a different active lock holder"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=topology_lock' 'wrong active lock should fail topology contract'

run_live_betting_scenario azure-command-failure "$SCRIPT" azure MODE=dark STUB_COMMAND_FAILURE=workloads
assert_eq 1 "$RUN_RC" "dark mode should fail when kubectl workloads command fails"
assert_contains "$RUN_SUMMARY_FILE" 'failed_checks=workload_images' 'command failure should fail workload inspection'

echo 'live_betting_readiness_tests=PASS stack=azure scenarios=21'
