#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
MIGRATION="$OCI_DIR/scripts/migrate-from-azure.sh"
RECOVERY="$OCI_DIR/scripts/recover-azure-migration.sh"
STATE_HELPER="$OCI_DIR/scripts/migration-state.py"
BOUNDED="$OCI_DIR/scripts/bounded-command.py"
MIGRATION_WORKFLOW="$ROOT_DIR/.github/workflows/oci-migrate.yml"
RECOVERY_WORKFLOW="$ROOT_DIR/.github/workflows/oci-migration-recovery.yml"
WORK_DIR="$OCI_DIR/tests/.migration-recovery-work"

fail() {
  echo "migration_recovery_contract=FAIL reason=$*" >&2
  exit 1
}

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

for file in \
  "$MIGRATION" "$RECOVERY" "$OCI_DIR/scripts/migration-common.sh"; do
  bash -n "$file"
done
PYTHONPYCACHEPREFIX="$WORK_DIR/pycache" \
  python3 -m py_compile "$STATE_HELPER" "$BOUNDED"
node --check "$OCI_DIR/scripts/mongo-canonical-signature.js"

run_failure() {
  local point="$1"
  local expected_boundary="$2"
  local expected_recovery="$3"
  local expected_oci_state="$4"
  local output="$WORK_DIR/${point//\//-}.env"
  if OCI_RUNTIME_MODE=oke \
      MIGRATION_SIMULATION=1 \
      MIGRATION_FAIL_AT="$point" \
      MIGRATION_SIMULATION_OUTPUT="$output" \
      "$MIGRATION" replace >/dev/null 2>&1; then
    fail "failure injection unexpectedly passed: $point"
  fi
  grep -Fxq "failure_point=$point" "$output" ||
    fail "failure point was not recorded: $point"
  grep -Fxq "destructive_boundary=$expected_boundary" "$output" ||
    fail "destructive boundary differs for $point"
  grep -Fxq "recovery_required=$expected_recovery" "$output" ||
    fail "recovery state differs for $point"
  grep -Fxq "oci_state=$expected_oci_state" "$output" ||
    fail "OCI closure/baseline state differs for $point"
  grep -Fxq "azure_apps=frozen" "$output" ||
    fail "Azure writers were not kept frozen for $point"
  grep -Fxq "azure_stopped=true" "$output" ||
    fail "Azure stop evidence is absent for $point"
}

for point in \
  azure-start azure-provisioning azure-freeze source-queue-drain \
  runner-capacity archive-capture corrupt-archive disposable-validation \
  cancellation hang target-queue-drain oci-freeze; do
  run_failure "$point" false false baseline
done

databases=(
  gaming_auth gaming_bet gaming_backoffice gaming_event
  gaming_gamemaster gaming_moderation gaming_resulting gaming_slip
)
for database in "${databases[@]}"; do
  for point in \
    "before-drop-$database" "after-drop-$database" \
    "before-restore-$database" "after-restore-$database"; do
    run_failure "$point" true true closed
  done
done

for point in \
  rabbitmq-recreate restart-auth restart-client mongo-write-lock \
  rabbitmq-write-lock protected-health public-health; do
  run_failure "$point" true true closed
done
run_failure post-boundary-cancellation true true closed
run_failure post-boundary-hang true true closed
run_failure cutover-committed true false committed-locked
run_failure mongo-write-unlocked true false committed-mongo-writable
run_failure rabbitmq-write-unlocked true false committed-writable
run_failure retry-after-cutover true false forward-only

success_output="$WORK_DIR/success.env"
OCI_RUNTIME_MODE=oke \
MIGRATION_SIMULATION=1 \
MIGRATION_SIMULATION_OUTPUT="$success_output" \
  "$MIGRATION" replace >/dev/null
grep -Fxq 'result=success' "$success_output" ||
  fail "exact successful replacement simulation failed"
grep -Fxq 'exact_database_count=8' "$success_output" ||
  fail "successful replacement did not require eight exact databases"
grep -Fxq 'oci_state=healthy' "$success_output" ||
  fail "successful replacement did not reach exact health"
grep -Fxq 'azure_stopped=true' "$success_output" ||
  fail "successful replacement did not retain Azure stop evidence"

partial_output="$WORK_DIR/partial-retry.env"
OCI_RUNTIME_MODE=oke \
MIGRATION_SIMULATION=1 \
MIGRATION_SIMULATE_PARTIAL_RETRY=1 \
MIGRATION_SIMULATION_OUTPUT="$partial_output" \
  "$MIGRATION" replace >/dev/null
grep -Fxq 'partial_retry=1' "$partial_output" ||
  fail "partial retry was not exercised"
grep -Fxq 'recovery_required=false' "$partial_output" ||
  fail "successful full retry did not clear recovery-required"

run_recovery_simulation() {
  local scenario="$1"
  local expected_safe="$2"
  local expected_defer="$3"
  local output="$WORK_DIR/recovery-$scenario.env"
  local evidence="$WORK_DIR/recovery-$scenario-evidence.env"
  RECOVERY_SIMULATION=1 \
  RECOVERY_SIMULATION_SCENARIO="$scenario" \
  RECOVERY_RESULT_FILE="$output" \
  RECOVERY_EVIDENCE_FILE="$evidence" \
  AZURE_ACTUAL_CLUSTER_RESOURCE_ID_SHA256="$(
    printf fixture | shasum -a 256 | awk '{print $1}'
  )" \
    "$RECOVERY" >/dev/null
  grep -Fxq "safe_to_stop=$expected_safe" "$output" ||
    fail "recovery safe-to-stop decision differs: $scenario"
  grep -Fxq "defer=$expected_defer" "$output" ||
    fail "recovery defer decision differs: $scenario"
}

run_recovery_simulation approval-wait false true
run_recovery_simulation active-fresh false true
run_recovery_simulation missing-heartbeat false true
run_recovery_simulation stale-heartbeat true false
run_recovery_simulation concurrent-recovery false true
run_recovery_simulation completed-failure true false

python3 "$STATE_HELPER" create \
  --name betstan-oci-migration-journal \
  --namespace default \
  --set schema-version=1 \
  --set migration-id=old \
  --set owner-run-id=100 \
  --set owner-run-attempt=1 \
  --set fencing-token=4 \
  --set sequence=9 \
  --set phase=recovery-required \
  --set heartbeat-epoch=1 \
  --set destructive-boundary=true \
  --set recovery-required=true \
  >"$WORK_DIR/azure-state.json"
cp "$WORK_DIR/azure-state.json" "$WORK_DIR/oci-state.json"
python3 "$STATE_HELPER" compare \
  "$WORK_DIR/azure-state.json" "$WORK_DIR/oci-state.json"
python3 "$STATE_HELPER" mutate "$WORK_DIR/azure-state.json" \
  --expect migration-id=old \
  --expect fencing-token=4 \
  --expect sequence=9 \
  --set migration-id=retry \
  --set owner-run-id=101 \
  --set fencing-token=5 \
  --set sequence=10 \
  --set phase=lock-taken-over \
  >"$WORK_DIR/taken-over-state.json"
grep -Fq '"fencing-token": "5"' "$WORK_DIR/taken-over-state.json" ||
  fail "stale-lock takeover did not advance the fencing token"
if python3 "$STATE_HELPER" mutate "$WORK_DIR/taken-over-state.json" \
  --expect fencing-token=4 --set phase=unsafe >/dev/null 2>&1; then
  fail "stale fencing token was accepted"
fi
python3 "$STATE_HELPER" mirror \
  "$WORK_DIR/azure-state.json" "$WORK_DIR/taken-over-state.json" \
  --expect-target migration-id=retry \
  --expect-target fencing-token=5 \
  >"$WORK_DIR/reconciled-state.json"
python3 "$STATE_HELPER" compare \
  "$WORK_DIR/azure-state.json" "$WORK_DIR/reconciled-state.json" ||
  fail "one-sided CAS state could not be safely reconciled"

python3 "$STATE_HELPER" create \
  --name betstan-oci-migration-journal \
  --namespace default \
  --set schema-version=1 \
  --set journal-id=fixture-journal \
  --set original-source-sha=1111111111111111111111111111111111111111 \
  --set migration-id=100-1 \
  --set owner-run-id=100 \
  --set owner-run-attempt=1 \
  --set fencing-token=1 \
  --set sequence=4 \
  --set phase=source-captured \
  --set heartbeat-epoch=10 \
  --set destructive-boundary=false \
  --set recovery-required=false \
  --set azure-cluster-fingerprint=azure-fixture \
  --set oci-cluster-fingerprint=oci-fixture \
  --set azure-baseline=azure-baseline \
  --set azure-baseline-sha256=azure-hash \
  --set oci-baseline=oci-baseline \
  --set oci-baseline-sha256=oci-hash \
  >"$WORK_DIR/mirror-base.json"
python3 "$STATE_HELPER" mutate "$WORK_DIR/mirror-base.json" \
  --expect sequence=4 \
  --set sequence=5 \
  --set phase=archives-validated \
  --set heartbeat-epoch=11 \
  >"$WORK_DIR/mirror-ahead.json"
python3 "$STATE_HELPER" reconcile --kind journal \
  "$WORK_DIR/mirror-ahead.json" "$WORK_DIR/mirror-base.json" \
  >"$WORK_DIR/mirror-forward.json"
python3 "$STATE_HELPER" compare \
  "$WORK_DIR/mirror-ahead.json" "$WORK_DIR/mirror-forward.json" ||
  fail "one-step interrupted journal update was not reconciled"
python3 "$STATE_HELPER" mutate "$WORK_DIR/mirror-ahead.json" \
  --set original-source-sha=2222222222222222222222222222222222222222 \
  >"$WORK_DIR/mirror-unsafe.json"
if python3 "$STATE_HELPER" reconcile --kind journal \
    "$WORK_DIR/mirror-unsafe.json" "$WORK_DIR/mirror-base.json" \
    >/dev/null 2>&1; then
  fail "journal reconciliation accepted immutable identity drift"
fi
python3 "$STATE_HELPER" create \
  --name betstan-oci-migration-lock \
  --namespace default \
  --set schema-version=1 \
  --set journal-id=fixture-journal \
  --set migration-id=100-1 \
  --set owner-run-id=100 \
  --set owner-run-attempt=1 \
  --set fencing-token=1 \
  --set state=active \
  >"$WORK_DIR/lock-active.json"
python3 "$STATE_HELPER" mutate "$WORK_DIR/lock-active.json" \
  --set state=released >"$WORK_DIR/lock-released.json"
python3 "$STATE_HELPER" reconcile --kind lock \
  "$WORK_DIR/lock-released.json" "$WORK_DIR/lock-active.json" \
  >"$WORK_DIR/lock-forward.json"
python3 "$STATE_HELPER" compare \
  "$WORK_DIR/lock-released.json" "$WORK_DIR/lock-forward.json" ||
  fail "interrupted lock release was not reconciled"

if "$BOUNDED" --timeout-seconds 1 --attempts 1 \
  --classification injected-hang -- sleep 5 >/dev/null 2>&1; then
  fail "bounded command accepted an injected hang"
fi
child_pid_file="$WORK_DIR/bounded-child.pid"
"$BOUNDED" --timeout-seconds 60 --attempts 1 \
  --classification injected-signal -- \
  sh -c 'sleep 30 & child=$!; echo "$child" > "$1"; wait "$child"' \
    sh "$child_pid_file" >/dev/null 2>&1 &
wrapper_pid=$!
for _ in $(seq 1 50); do
  [[ -s "$child_pid_file" ]] && break
  sleep 0.1
done
[[ -s "$child_pid_file" ]] ||
  fail "bounded command did not start its signal fixture"
child_pid="$(cat "$child_pid_file")"
kill "$wrapper_pid"
wait "$wrapper_pid" 2>/dev/null || true
if kill -0 "$child_pid" 2>/dev/null; then
  kill "$child_pid" 2>/dev/null || true
  fail "bounded command left its child running after termination"
fi

for literal in \
  'replace_oci_data:' \
  'inputs.replace_oci_data == true' \
  'build_run_id:' \
  'redirect_url: ${{ steps.provenance.outputs.redirect_url }}' \
  'diagnostic_url: ${{ steps.provenance.outputs.diagnostic_url }}' \
  'OCI_REDIRECT_URL:' \
  'OCI_DIAGNOSTIC_URL:' \
  '[ "$OCI_PUBLIC_URL" = "https://betstan.xyz" ]' \
  '[ "$OCI_REDIRECT_URL" = "https://www.betstan.xyz" ]' \
  'name: oci-migration-success-provenance-${{ github.run_id }}-${{ github.run_attempt }}' \
  'migration-summary.env' \
  'schema=betstan.oci-migration-success.v1' \
  'terminal_status=DEPLOYED_HEALTHY' \
  '[ "$migration_id" = "${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" ]' \
  '[ "$source_sha" = "$SOURCE_SHA" ]' \
  'journal_heartbeat_epoch=' \
  'fencing_generation=' \
  'final_journal_sha256=' \
  'artifact_run_binding=${run_id}-${run_attempt}' \
  'database_count=8' \
  'logical_source_target_parity=true' \
  'oci_reopened_healthy=true' \
  'azure_writers_frozen=true' \
  'azure_cluster_resource_id_sha256=' \
  'aks_power_state=Stopped' \
  'vmss_instances_deallocated=true' \
  'azure_cluster_stopped_deallocated=true' \
  'for attempt in 1 2 3; do' \
  'az aks start' \
  'az aks stop' \
  'Always stop and deallocate exact Azure source with evidence' \
  'OCI_PUBLIC_CHECKS_ALREADY_PASSED: "1"' \
  'OCI_E2E_ALREADY_PASSED: "1"'; do
  grep -Fq "$literal" "$MIGRATION_WORKFLOW" ||
    fail "migration workflow is missing: $literal"
done
[[ "$(grep -Fc 'az vmss list-instances' "$MIGRATION_WORKFLOW")" -ge 3 ]] ||
  fail "every Azure stop path does not independently verify VMSS deallocation"
! grep -Eq 'az aks (create|update|delete)|az aks nodepool' "$MIGRATION_WORKFLOW" ||
  fail "migration workflow can create, resize, or delete Azure"

for literal in \
  'workflows: ["oci-migrate"]' \
  'cron: "*/15 * * * *"' \
  'workflow_dispatch:' \
  'source_sha:' \
  'migration_run_id:' \
  'migration_run_attempt:' \
  'migration_id:' \
  'fencing_generation:' \
  'STOP AZURE FOR EXACT MIGRATION' \
  "vars.OCI_MIGRATION_RECOVERY_ENABLED == 'true'" \
  "vars.OCI_MIGRATION_RECOVERY_ENABLED || 'false'" \
  'OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH' \
  '86400' \
  'name: azure-migration-recovery' \
  'AZURE_MIGRATION_RECOVERY_CREDENTIALS' \
  'EXPECTED_SOURCE_SHA:' \
  'EXPECTED_OWNER_RUN_ID:' \
  'EXPECTED_OWNER_RUN_ATTEMPT:' \
  'EXPECTED_MIGRATION_ID:' \
  'EXPECTED_FENCING_GENERATION:' \
  '[ "$head_sha" = "$EXPECTED_SOURCE_SHA" ]' \
  'cancel-in-progress: true' \
  'az aks stop'; do
  grep -Fq "$literal" "$RECOVERY_WORKFLOW" ||
    fail "recovery workflow is missing: $literal"
done
! grep -Eq \
  'OCI_MIGRATION_AZURE_CREDENTIALS|OCI_CI_PRIVATE_KEY_PEM|OCI_K3S_SSH_PRIVATE_KEY|OCI_MIGRATION_AGE_IDENTITY' \
  "$RECOVERY_WORKFLOW" ||
  fail "recovery workflow receives broader migration or OCI credentials"
! grep -Eq 'az aks (start|create|update|delete)|az aks nodepool' "$RECOVERY_WORKFLOW" ||
  fail "recovery workflow exceeds stop/read-only Azure permissions"
! grep -Eq 'scale deployment .*--replicas [1-9]' "$RECOVERY" ||
  fail "recovery script can reopen Azure applications"
for literal in \
  'validate_expected_completed_journal' \
  '"$state_migration" == "$EXPECTED_MIGRATION_ID"' \
  '"$state_fence" == "$EXPECTED_FENCING_GENERATION"' \
  '"$state_source_sha" == "$EXPECTED_SOURCE_SHA"' \
  'different-active-migration'; do
  grep -Fq "$literal" "$RECOVERY" ||
    fail "recovery script is not bound to exact migration evidence: $literal"
done
grep -Fq 'migration_heartbeat "$now" >&2' \
  "$OCI_DIR/scripts/migration-common.sh" ||
  fail "migration heartbeat can contaminate captured command output"
for literal in \
  'drain_azure_queues' \
  'Azure RabbitMQ did not drain before recovery freeze' \
  'cancelled migration run identity is invalid'; do
  grep -Fq "$literal" "$RECOVERY" ||
    fail "recovery safety contract is missing: $literal"
done

for literal in \
  'betstan-oci-migration-journal' \
  'betstan-oci-migration-lock' \
  'fencing-token' \
  'heartbeat-epoch' \
  'destructive-boundary' \
  'recovery-required' \
  'state_assert_fence' \
  'state_reconcile_existing' \
  'state_recover_partial_creation' \
  'owner_run_is_conclusively_inactive' \
  'exactly eight Mongo PVCs' \
  'deployment_mongo_uri' \
  'mongodump --quiet --archive --gzip' \
  'age --encrypt' \
  'docker run -d --name "$disposable_container"' \
  'dropDatabase()' \
  'signature-$database' \
  'target-signature-manifest-sha256' \
  'logical-parity=true' \
  'lock_target_writes' \
  'lock_rabbitmq_writes' \
  'cutover-committed' \
  'cutover-committed | cutover-forward-recovery' \
  'last_committed_phase="$phase"' \
  'current_phase="${last_committed_phase:-$(state_value phase' \
  'OCI cutover is committed; retrying from Azure is permanently forbidden' \
  'migration_failure_hook mongo-write-unlocked' \
  'migration_failure_hook rabbitmq-write-unlocked' \
  'rabbitmq-recreated' \
  'awaiting-protected-health'; do
  grep -Fq "$literal" "$MIGRATION" ||
    fail "migration state machine is missing: $literal"
done
python3 - "$MIGRATION" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
replace = text.index("      verify_target_exact\n", text.index("case \"$MODE\" in"))
mongo_lock = text.index("      lock_target_writes\n", replace)
restart = text.index("      recreate_rabbitmq_and_restart\n", mongo_lock)
finalize = text.index("    finalize-success)", restart)
target_pod = text.index("target_mongo_pod=\"$(kube_capture", finalize)
lock_check = text.index("$(target_write_lock_status)", target_pod)
commit = text.index("state_advance cutover-committed", finalize)
mongo_unlock = text.index("      unlock_target_writes\n", commit)
mongo_unlock_failure = text.index(
    "migration_failure_hook mongo-write-unlocked", mongo_unlock)
rabbit_unlock = text.index("      unlock_rabbitmq_writes\n", mongo_unlock)
rabbit_unlock_failure = text.index(
    "migration_failure_hook rabbitmq-write-unlocked", rabbit_unlock)
completed = text.index("state_advance completed", rabbit_unlock)
if not (replace < mongo_lock < restart < finalize < target_pod < lock_check <
        commit < mongo_unlock < mongo_unlock_failure < rabbit_unlock <
        rabbit_unlock_failure < completed):
    raise SystemExit("write-lock/cutover ordering differs")

cleanup = text.index("cleanup() {")
cleanup_case = text.index('case "$current_phase" in', cleanup)
cleanup_committed = text.index(
    "cutover-committed | cutover-forward-recovery)", cleanup_case)
cleanup_close = text.index("close_oci || cleanup_failed=1", cleanup_committed)
if not cleanup_case < cleanup_committed < cleanup_close:
    raise SystemExit("process cleanup closes OCI after committed cutover")

fail_closed = text.index("    fail-closed)", finalize)
fail_closed_case = text.index('case "$(state_value phase)" in', fail_closed)
fail_closed_committed = text.index(
    "cutover-committed | cutover-forward-recovery)", fail_closed_case)
fail_closed_close = text.index("            close_oci\n", fail_closed_committed)
if not fail_closed_case < fail_closed_committed < fail_closed_close:
    raise SystemExit("explicit cleanup closes OCI after committed cutover")
PY
! grep -Eiq 'watchdog|restore_azure|Object Storage|snapshot' "$MIGRATION" ||
  fail "migration can reopen Azure or retain a prohibited recovery copy"

echo "migration_recovery_contract=PASS"
