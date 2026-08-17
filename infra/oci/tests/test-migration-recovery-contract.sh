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

for point in rabbitmq-recreate restart-auth restart-client protected-health public-health; do
  run_failure "$point" true true closed
done
run_failure post-boundary-cancellation true true closed
run_failure post-boundary-hang true true closed

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

if "$BOUNDED" --timeout-seconds 1 --attempts 1 \
  --classification injected-hang -- sleep 5 >/dev/null 2>&1; then
  fail "bounded command accepted an injected hang"
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
  'journal_heartbeat_epoch=' \
  'fencing_generation=' \
  'artifact_run_binding=${run_id}-${run_attempt}' \
  'database_count=8' \
  'logical_source_target_parity=true' \
  'oci_reopened_healthy=true' \
  'azure_writers_frozen=true' \
  'azure_cluster_stopped_deallocated=true' \
  'az aks start' \
  'az aks stop' \
  'Always stop and deallocate exact Azure source with evidence' \
  'OCI_PUBLIC_CHECKS_ALREADY_PASSED: "1"' \
  'OCI_E2E_ALREADY_PASSED: "1"'; do
  grep -Fq "$literal" "$MIGRATION_WORKFLOW" ||
    fail "migration workflow is missing: $literal"
done
! grep -Eq 'az aks (create|update|delete)|az aks nodepool' "$MIGRATION_WORKFLOW" ||
  fail "migration workflow can create, resize, or delete Azure"

for literal in \
  'workflows: ["oci-migrate"]' \
  'cron: "*/15 * * * *"' \
  'workflow_dispatch:' \
  "vars.OCI_MIGRATION_RECOVERY_ENABLED == 'true'" \
  "vars.OCI_MIGRATION_RECOVERY_ENABLED || 'false'" \
  'OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH' \
  '86400' \
  'name: azure-migration-recovery' \
  'AZURE_MIGRATION_RECOVERY_CREDENTIALS' \
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
  'betstan-oci-migration-journal' \
  'betstan-oci-migration-lock' \
  'fencing-token' \
  'heartbeat-epoch' \
  'destructive-boundary' \
  'recovery-required' \
  'state_assert_fence' \
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
  'rabbitmq-recreated' \
  'awaiting-protected-health'; do
  grep -Fq "$literal" "$MIGRATION" ||
    fail "migration state machine is missing: $literal"
done
! grep -Eiq 'watchdog|restore_azure|Object Storage|snapshot' "$MIGRATION" ||
  fail "migration can reopen Azure or retain a prohibited recovery copy"

echo "migration_recovery_contract=PASS"
