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
AUTH_ENTRYPOINT="$ROOT_DIR/auth/src/index.ts"
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
[[ "$(grep -Fc 'mongosh --quiet --file /dev/stdin' "$MIGRATION")" == "2" ]] ||
  fail "canonical signatures are not executed in non-REPL mongosh file mode"

run_failure() {
  local point="$1"
  local expected_boundary="$2"
  local expected_recovery="$3"
  local expected_oci_state="$4"
  local expected_http_fence="$5"
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
  grep -Fxq "http_write_fence=$expected_http_fence" "$output" ||
    fail "HTTP write-fence state differs for $point"
  grep -Fxq "azure_apps=frozen" "$output" ||
    fail "Azure writers were not kept frozen for $point"
  grep -Fxq "azure_stopped=true" "$output" ||
    fail "Azure stop evidence is absent for $point"
}

for point in \
  azure-start azure-provisioning azure-freeze source-queue-drain \
  runner-capacity archive-capture corrupt-archive disposable-validation \
  cancellation hang target-queue-drain oci-freeze http-write-fence-install; do
  run_failure "$point" false false baseline false
done
run_failure http-write-fence-installed-crash false false closed true

databases=(
  gaming_auth gaming_bet gaming_backoffice gaming_event
  gaming_gamemaster gaming_moderation gaming_resulting gaming_slip
)
for database in "${databases[@]}"; do
  for point in \
    "before-drop-$database" "after-drop-$database" \
    "before-restore-$database" "after-restore-$database"; do
    run_failure "$point" true true closed true
  done
done

for point in \
  auth-startup-before-mongo-lock mongo-write-lock \
  rabbitmq-recreate restart-auth restart-gamemaster \
  rabbitmq-consumer-convergence \
  rabbitmq-write-lock restart-client http-write-fence-runtime \
  mongo-restart-during-public-health protected-health public-health; do
  run_failure "$point" true true closed true
done
run_failure post-boundary-cancellation true true closed true
run_failure post-boundary-hang true true closed true
run_failure cutover-committed true false committed-locked true
run_failure gamemaster-quiesced-after-commit true false committed-locked true
run_failure mongo-write-unlocked true false committed-mongo-writable true
run_failure rabbitmq-write-unlocked true false committed-writable true
run_failure http-write-fence-removed true false committed-writable false
run_failure retry-after-cutover true false forward-only true

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
grep -Fxq 'http_write_fence=false' "$success_output" ||
  fail "successful replacement retained the HTTP write fence"
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
  --set active-source-sha=1111111111111111111111111111111111111111 \
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
  --set http-write-fence=true \
  >"$WORK_DIR/mirror-base.json"
python3 "$STATE_HELPER" summary "$WORK_DIR/mirror-base.json" |
  grep -Fxq 'http-write-fence=true' ||
  fail "sanitized migration summary omitted the HTTP write fence"
python3 "$STATE_HELPER" summary "$WORK_DIR/mirror-base.json" |
  grep -Fxq \
    'active-source-sha=1111111111111111111111111111111111111111' ||
  fail "sanitized migration summary omitted the active source SHA"
python3 "$STATE_HELPER" mutate "$WORK_DIR/mirror-base.json" \
  --expect active-source-sha=1111111111111111111111111111111111111111 \
  --expect migration-id=100-1 \
  --expect fencing-token=1 \
  --expect sequence=4 \
  --set active-source-sha=2222222222222222222222222222222222222222 \
  --set migration-id=101-1 \
  --set owner-run-id=101 \
  --set fencing-token=2 \
  --set sequence=5 \
  --set phase=lock-taken-over \
  --set heartbeat-epoch=11 \
  >"$WORK_DIR/cross-release-takeover.json"
python3 "$STATE_HELPER" reconcile --kind journal \
  "$WORK_DIR/cross-release-takeover.json" "$WORK_DIR/mirror-base.json" \
  >"$WORK_DIR/cross-release-reconciled.json"
python3 "$STATE_HELPER" compare \
  "$WORK_DIR/cross-release-takeover.json" \
  "$WORK_DIR/cross-release-reconciled.json" ||
  fail "descendant release takeover could not be mirrored safely"
grep -Fq \
  '"original-source-sha": "1111111111111111111111111111111111111111"' \
  "$WORK_DIR/cross-release-reconciled.json" ||
  fail "descendant release takeover changed immutable journal lineage"
grep -Fq \
  '"active-source-sha": "2222222222222222222222222222222222222222"' \
  "$WORK_DIR/cross-release-reconciled.json" ||
  fail "descendant release takeover did not bind the active source SHA"
python3 "$STATE_HELPER" mutate "$WORK_DIR/mirror-base.json" \
  --set active-source-sha=2222222222222222222222222222222222222222 \
  --set sequence=5 \
  --set phase=source-captured \
  --set heartbeat-epoch=11 \
  >"$WORK_DIR/same-owner-lineage-drift.json"
if python3 "$STATE_HELPER" reconcile --kind journal \
    "$WORK_DIR/same-owner-lineage-drift.json" "$WORK_DIR/mirror-base.json" \
    >/dev/null 2>&1; then
  fail "same migration owner changed active source lineage"
fi
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
  'recover_closed_oci:' \
  'recovery_deploy_source_sha:' \
  'RECOVER CLOSED OCI DATA FROM AZURE' \
  'DEPLOY_SOURCE_SHA:' \
  'compare-image-inputs.sh' \
  'validate_run \' \
  'oci-production-deploy.yml "$DEPLOY_RUN_ID" workflow_dispatch "$DEPLOY_SOURCE_SHA"' \
  'grep -Fx "source_sha=$DEPLOY_SOURCE_SHA" artifacts/deploy/provenance.txt' \
  'runtime_deploy_source_sha=$DEPLOY_SOURCE_SHA' \
  'closed_recovery_retry=$RECOVER_CLOSED_OCI' \
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
  'source_sha="$(get_phase_field active-source-sha)"' \
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
  '"aks_power_state=$aks_power_state"' \
  'vmss_instances_deallocated=true' \
  'azure_cluster_stopped_deallocated=true' \
  'for attempt in 1 2 3; do' \
  'az aks start' \
  'az aks stop' \
  'Always stop and deallocate exact Azure source with evidence' \
  'OCI_PUBLIC_CHECKS_ALREADY_PASSED: "1"' \
  'OCI_E2E_ALREADY_PASSED: "1"' \
  'Run read-only public OCI validation with mutation fence' \
  'OCI_EXPECT_HTTP_MUTATION_FENCE: "1"' \
  'post-commit-validate:' \
  "needs.finalize.result == 'success'" \
  'Validate public write path after committed fence removal' \
  'http_mutation_fence_removed=true'; do
  grep -Fq "$literal" "$MIGRATION_WORKFLOW" ||
    fail "migration workflow is missing: $literal"
done
[[ "$(grep -Fc 'az vmss list-instances' "$MIGRATION_WORKFLOW")" -ge 3 ]] ||
  fail "every Azure stop path does not independently verify VMSS deallocation"
[[ "$(grep -Fc 'type == "array" and' "$MIGRATION_WORKFLOW")" -ge 3 ]] ||
  fail "Azure stop paths do not safely accept an empty VMSS instance set"
! grep -Fq 'length >= 1 and' "$MIGRATION_WORKFLOW" ||
  fail "Azure stop paths incorrectly require a retained VMSS instance"
[[ "$(grep -Fc 'install -m 600 -- "$KUBE_CONFIG_PATH" "$AZURE_KUBECONFIG"' \
  "$MIGRATION_WORKFLOW")" -eq 2 ]] ||
  fail "Azure action kubeconfigs are not materialized at both isolated paths"
[[ "$(grep -Fc 'exit "$cleanup_status"' "$MIGRATION_WORKFLOW")" -eq 2 ]] ||
  fail "unexpected kubeconfig paths can bypass credential cleanup"
[[ "$(grep -Fc 'Stopped|Deallocated)' "$MIGRATION_WORKFLOW")" -ge 4 ]] ||
  fail "migration does not accept both Azure stopped-state representations"
grep -Fq '[ "$provisioning" = "Failed" ]' "$MIGRATION_WORKFLOW" ||
  fail "migration cannot restart the exact failed/deallocated source"
[[ "$(grep -Ec "steps\\.(final_)?oci_cli\\.outcome == 'success'" \
  "$MIGRATION_WORKFLOW")" -eq 2 ]] ||
  fail "migration can run Bastion cleanup before an OCI CLI is installed"
! grep -Eq 'az aks (create|update|delete)|az aks nodepool' "$MIGRATION_WORKFLOW" ||
  fail "migration workflow can create, resize, or delete Azure"
python3 - "$MIGRATION_WORKFLOW" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
public_job = text.index("  public-validate:")
finalize_job = text.index("  finalize:", public_job)
read_only = text.index(
    "Run read-only public OCI validation with mutation fence", public_job)
fence_expectation = text.index(
    'OCI_EXPECT_HTTP_MUTATION_FENCE: "1"', read_only)
browser_install = text.index(
    "Install browser validation dependencies", finalize_job)
transition = text.index(
    "Finalize success or enforce post-boundary closure", finalize_job)
azure_stop = text.index(
    "Always stop and deallocate exact Azure source with evidence", transition)
post_commit_job = text.index("  post-commit-validate:", azure_stop)
post_commit = text.index(
    "Validate public write path after committed fence removal", post_commit_job)
if not (public_job < read_only < fence_expectation < finalize_job <
        transition < azure_stop < post_commit_job < browser_install <
        post_commit):
    raise SystemExit("read-only/public-write validation ordering differs")
if "playwright" in text[public_job:finalize_job].lower():
    raise SystemExit("pre-commit public validation can execute mutating browser checks")
if "playwright" in text[finalize_job:post_commit_job].lower():
    raise SystemExit("credentialed finalization can execute package browser code")
post_commit_block = text[post_commit:]
for output in ("public_url", "redirect_url", "diagnostic_url"):
    expected = f"${{{{ needs.migrate.outputs.{output} }}}}"
    if expected not in post_commit_block:
        raise SystemExit(f"post-commit validation lacks migrated {output}")
if "steps.provenance.outputs." in post_commit_block:
    raise SystemExit("post-commit validation uses job-local unset URL outputs")
PY

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
  'owner_run_json="$(' \
  '[ "$owner_head_sha" = "$EXPECTED_SOURCE_SHA" ]' \
  'owner_conclusion="$(jq -r' \
  '.conclusion // empty' \
  '"repos/$REPOSITORY/actions/runs/$EXPECTED_OWNER_RUN_ID/attempts/1"' \
  'mkdir -p artifacts/azure-migration-recovery' \
  'Materialize isolated Azure recovery kubeconfig' \
  'install -m 600 -- "$KUBE_CONFIG_PATH" "$AZURE_KUBECONFIG"' \
  '[ ! -f "$RECOVERY_RESULT_FILE" ]' \
  'exit "${recovery_status:-1}"' \
  'cancel-in-progress: true' \
  'az aks stop'; do
  grep -Fq "$literal" "$RECOVERY_WORKFLOW" ||
    fail "recovery workflow is missing: $literal"
done
! grep -Fq '@tsv' "$RECOVERY_WORKFLOW" ||
  fail "recovery workflow can shift nullable owner-run fields"
! grep -Eq \
  'OCI_MIGRATION_AZURE_CREDENTIALS|OCI_CI_PRIVATE_KEY_PEM|OCI_K3S_SSH_PRIVATE_KEY|OCI_MIGRATION_AGE_IDENTITY' \
  "$RECOVERY_WORKFLOW" ||
  fail "recovery workflow receives broader migration or OCI credentials"
! grep -Eq 'az aks (start|create|update|delete)|az aks nodepool' "$RECOVERY_WORKFLOW" ||
  fail "recovery workflow exceeds stop/read-only Azure permissions"
[[ "$(grep -Fc 'Stopped|Deallocated)' "$RECOVERY_WORKFLOW")" -ge 2 ]] ||
  fail "recovery does not accept both Azure stopped-state representations"
grep -Fq '[ "$provisioning" = "Failed" ]' "$RECOVERY_WORKFLOW" ||
  fail "recovery rejects a safely deallocated failed AKS control plane"
! grep -Eq 'scale deployment .*--replicas [1-9]' "$RECOVERY" ||
  fail "recovery script can reopen Azure applications"
for literal in \
  'validate_expected_completed_journal' \
  '"$state_migration" == "$EXPECTED_MIGRATION_ID"' \
  '"$state_fence" == "$EXPECTED_FENCING_GENERATION"' \
  '"$state_source_sha" == "$EXPECTED_SOURCE_SHA"' \
  '.data["active-source-sha"] // .data["original-source-sha"]' \
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
  'active-source-sha=$SOURCE_SHA' \
  'cross-release retry requires a fully unlocked pre-destructive failure' \
  'cross-release retry OCI replica baseline differs from the journal' \
  'cross-release retry Azure applications are not frozen' \
  'verify_frozen_source_queues' \
  'git merge-base --is-ancestor "$existing_source" "$SOURCE_SHA"' \
  'cross-release retry found a live OCI write lock or HTTP fence' \
  'cross-release recovery retry requires an active closed post-boundary journal' \
  'cross-release recovery retry OCI applications are not closed' \
  'cross-release recovery retry lost the OCI HTTP write fence' \
  'cross-release recovery retry has an inactive OCI baseline' \
  'exactly eight Mongo PVCs' \
  'deployment_mongo_uri' \
  'MONGO_REVIEWED_INDEX_DIGEST=sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3' \
  'MONGO_REVIEWED_AMD64_MANIFEST=sha256:41afd6e1183f57e4e4d03ab733070671fca8553da2b36f15d6e3fc9760494d17' \
  'MONGO_REVIEWED_ARM64_MANIFEST=sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4' \
  'source-mongo-identities.json' \
  'source-mongo-identities=' \
  'target-mongo-container-id=' \
  'target-mongo-restart-count=' \
  'restore_source_mongo_manifest_from_state true' \
  'verify_source_mongo_identity' \
  'verify_target_mongo_identity' \
  'verify_target_mongo_identity false' \
  'freeze_azure_after_commit' \
  'verify_cutover_write_locks' \
  'mongodump --quiet --archive --gzip' \
  'age --encrypt' \
  'docker run -d --name "$disposable_container"' \
  'dropDatabase()' \
  'signature-$database' \
  'target-signature-manifest-sha256' \
  'logical-parity=true' \
  'start_auth_before_mongo_lock' \
  'auth-started-before-mongo-lock' \
  'target-exactly-validated-after-auth-startup' \
  'auth index initialization requires an unlocked OCI Mongo' \
  'auth index initialization requires the retained HTTP fence' \
  'lock_target_writes' \
  'runCommand({currentOp:1,$all:true})' \
  '(result.fsyncLock !== undefined &&' \
  'print(result.fsyncLock === true)' \
  'const lockCount=Number(result.lockCount)' \
  'retry journal Mongo write-lock state is invalid' \
  'retry Mongo write-lock state did not reconcile' \
  'wait_rabbitmq_consumer_convergence' \
  'QUEUE_CONVERGENCE_DEADLINE_SECONDS' \
  'autonomous_deadline_remaining' \
  'kube_before_autonomous_deadline' \
  'rabbitmq_consumer_convergence=WAIT' \
  'rabbitmq_consumer_convergence=PASS' \
  'RabbitMQ consumer topology did not converge' \
  'backlogged=' \
  'rabbitmq-consumer-convergence' \
  'rabbitmq_expected_binding_rows' \
  'rabbitmq_application_binding_rows' \
  'rabbitmq_binding_rows_are_reviewed_subset' \
  'rabbitmq_routing_fence_status' \
  '.properties_key == "~"' \
  'rabbitmqadmin -q delete binding' \
  'rabbitmq_routing_fence=PASS' \
  'rabbitmq_routing_fence_removed=PASS' \
  'migration_failure_hook rabbitmq-write-lock' \
  'ensure_forward_http_write_fence' \
  'quiesce_gamemaster_after_commit' \
  'migration_failure_hook gamemaster-quiesced-after-commit' \
  'lock_rabbitmq_writes' \
  'INGRESS_CONTROLLER_CONFIGMAP="ingress-nginx-controller"' \
  'if (\$request_method !~ ^(GET|HEAD|OPTIONS)\$)' \
  'http-write-fence=false' \
  'http_write_fence_config_status' \
  'http_write_fence_runtime_status' \
  "jq -r '.items[].metadata.name'" \
  'ingress controller replicas disagree on the HTTP write fence' \
  'install_http_write_fence' \
  'wait_http_write_fence_runtime true' \
  'state_optional_value http-write-fence' \
  'remove_http_write_fence' \
  'migration_failure_hook http-write-fence-removed' \
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
! grep -Fq '.currentOp().fsyncLock' "$MIGRATION" ||
  fail "migration uses mongosh currentOp(), which omits MongoDB 8.2 fsyncLock"
python3 - "$MIGRATION" "$OCI_DIR/scripts/migration-common.sh" <<'PY'
from pathlib import Path
import sys

migration = Path(sys.argv[1]).read_text()
common = Path(sys.argv[2]).read_text()
kube_capture = migration[
    migration.index("kube_capture() {"):migration.index("\n}\n", migration.index("kube_capture() {")) + 3
]
migration_run = common[
    common.index("migration_run() {"):common.index("\n}\n", common.index("migration_run() {")) + 3
]
if "migration_maybe_heartbeat 1" in kube_capture:
    raise SystemExit("captured Kubernetes reads force redundant mirrored heartbeats")
if "migration_maybe_heartbeat 1" in migration_run:
    raise SystemExit("short external commands force redundant mirrored heartbeats")

rabbit_restart = migration.index(
    'scale_deployment oci "$OCI_K8S_NAMESPACE" gaming-rabbitmq-depl 1'
)
rabbit_normalize = migration.index(
    "  normalize_rabbitmq_permissions\n", rabbit_restart
)
rabbit_state = migration.index(
    "  state_advance rabbitmq-recreated true true", rabbit_normalize
)
passive_loop = migration.index(
    '  for service in auth "${RABBITMQ_PASSIVE_SERVICES[@]}"; do',
    rabbit_state,
)
gamemaster_start = migration.index(
    '  autonomous_start_epoch="$(migration_epoch)"', passive_loop
)
rabbit_convergence = migration.index(
    '  wait_rabbitmq_consumer_convergence oci "$autonomous_start_epoch"\n',
    gamemaster_start,
)
rabbit_convergence_failure = migration.index(
    "  migration_failure_hook rabbitmq-consumer-convergence\n",
    rabbit_convergence,
)
rabbit_lock = migration.index(
    '  lock_rabbitmq_writes "$autonomous_start_epoch"\n',
    rabbit_convergence_failure,
)
rabbit_lock_failure = migration.index(
    "  migration_failure_hook rabbitmq-write-lock\n",
    rabbit_lock,
)
client_start = migration.index(
    '  scale_deployment oci "$OCI_K8S_NAMESPACE" gaming-client-depl',
    rabbit_lock_failure,
)
if not (
    rabbit_restart < rabbit_normalize < rabbit_state < passive_loop
    < gamemaster_start < rabbit_convergence
    < rabbit_convergence_failure < rabbit_lock < rabbit_lock_failure
    < client_start
):
    raise SystemExit(
        "RabbitMQ recovery does not fence before autonomous publishing"
    )

convergence_start = migration.index("wait_rabbitmq_consumer_convergence() {")
convergence_end = migration.index("\n}\n", convergence_start)
convergence = migration[convergence_start:convergence_end]
for required in (
    'seq 1 "$QUEUE_CONVERGENCE_ATTEMPTS"',
    'migration_sleep "$QUEUE_CONVERGENCE_SLEEP_SECONDS"',
    "QUEUE_CONVERGENCE_DEADLINE_SECONDS",
    "autonomous_start_epoch",
    'rabbit_queue_rows "$provider" "$autonomous_start_epoch"',
    '"$count" == "17"',
    '"$names" == "$expected"',
    '"$backlog" == "0"',
    '"$bad" == "0"',
    "missing=",
    "extra=",
    "zero_consumers=",
    "backlogged=",
):
    if required not in convergence:
        raise SystemExit(
            f"RabbitMQ convergence gate is missing: {required}"
        )

bindings_start = migration.index("RABBITMQ_BINDING_MAPPINGS=(")
bindings_end = migration.index("\n)", bindings_start)
bindings = [
    line.strip().strip('"')
    for line in migration[bindings_start:bindings_end].splitlines()[1:]
    if line.strip()
]
if len(bindings) != 17 or len(set(bindings)) != 17:
    raise SystemExit("RabbitMQ binding baseline is not exactly 17 unique rows")

lock_start = migration.index("lock_rabbitmq_writes() {")
lock_end = migration.index("\n}\n", lock_start)
lock = migration[lock_start:lock_end]
for required in (
    'rabbitmq_application_binding_rows "$autonomous_start_epoch"',
    "rabbitmq_expected_binding_rows",
    "rabbitmqadmin -q delete binding",
    'rabbitmq_routing_fence_status "$autonomous_start_epoch"',
    "elapsed < QUEUE_CONVERGENCE_DEADLINE_SECONDS",
    'remaining="$(( QUEUE_CONVERGENCE_DEADLINE_SECONDS - elapsed ))"',
    'migration_raw rabbitmq-binding-fence "$remaining" 1',
):
    if required not in lock:
        raise SystemExit(f"RabbitMQ routing fence is missing: {required}")
if "rabbitmqctl set_permissions -p / guest '.*' '^$' '.*'" in migration:
    raise SystemExit("RabbitMQ ACL fence can crash autonomous publishers")

deadline_start = migration.index("autonomous_deadline_remaining() {")
deadline_end = migration.index("\n}\n", deadline_start)
deadline = migration[deadline_start:deadline_end]
deadline_kube_start = migration.index("kube_before_autonomous_deadline() {")
deadline_kube_end = migration.index("\n}\n", deadline_kube_start)
deadline_kube = migration[deadline_kube_start:deadline_kube_end]
for required in (
    "QUEUE_CONVERGENCE_DEADLINE_SECONDS",
    '(( remaining > 0 ))',
):
    if required not in deadline:
        raise SystemExit(
            f"RabbitMQ absolute deadline helper is missing: {required}"
        )
for required in (
    'remaining="$(autonomous_deadline_remaining',
    'migration_raw "$classification" "$remaining" 1',
):
    if required not in deadline_kube:
        raise SystemExit(
            f"RabbitMQ bounded Kubernetes helper is missing: {required}"
        )
if migration.count(
    'kube_before_autonomous_deadline \\\n'
    '    oci workload-scale "$autonomous_start_epoch"'
) != 2:
    raise SystemExit("gamemaster starts are not bounded by the absolute deadline")
if migration.count(
    'kube_before_autonomous_deadline \\\n'
    '    oci workload-rollout "$autonomous_start_epoch"'
) != 2:
    raise SystemExit("gamemaster rollouts are not bounded by the absolute deadline")

unlock_start = migration.index("unlock_rabbitmq_writes() {")
unlock_end = migration.index("\n}\n", unlock_start)
unlock = migration[unlock_start:unlock_end]
for required in (
    "rabbitmq_binding_rows_are_reviewed_subset",
    "rabbitmq_application_binding_rows",
    "wait_rabbitmq_consumer_convergence",
):
    if required not in unlock:
        raise SystemExit(
            f"RabbitMQ binding restoration is not retry-safe: {required}"
        )
PY
[[ "$(grep -Fc 'verify_source_mongo_identity "$pod"' "$MIGRATION")" -ge 3 ]] ||
  fail "migration does not revalidate each source around capture"
[[ "$(grep -Fc 'verify_target_mongo_identity' "$MIGRATION")" -ge 6 ]] ||
  fail "migration does not revalidate the target around replacement"
[[ "$(grep -Fc 'verify_cutover_write_locks' "$MIGRATION")" -ge 3 ]] ||
  fail "migration does not revalidate both write locks immediately before commit"
python3 - "$MIGRATION" "$AUTH_ENTRYPOINT" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
auth_entrypoint = Path(sys.argv[2]).read_text()
replace = text.index("      verify_target_exact\n", text.index("case \"$MODE\" in"))
auth_start = text.index("      start_auth_before_mongo_lock\n", replace)
mongo_lock = text.index("      lock_target_writes\n", auth_start)
post_auth_exact = text.index(
    "      verify_target_exact target-exactly-validated-after-auth-startup\n",
    mongo_lock,
)
restart = text.index("      recreate_rabbitmq_and_restart\n", post_auth_exact)
main_freeze = text.rindex("      freeze_oci\n", 0, replace)
fence_install = text.index("      install_http_write_fence\n", main_freeze)
retry_unlock = text.index("      unlock_target_writes_for_retry\n", fence_install)
finalize = text.index("    finalize-success)", restart)
finalize_phase = text.index('finalize_phase="$(state_value phase)"', finalize)
target_pod = text.index("target_mongo_pod=\"$(kube_capture", finalize)
lock_check = text.index("          verify_cutover_write_locks\n", target_pod)
final_exact = text.index("          verify_final_exact_state\n", lock_check)
lock_recheck = text.index("          verify_cutover_write_locks\n", final_exact)
commit = text.index("state_advance cutover-committed", finalize)
forward_http_fence = text.index(
    "      ensure_forward_http_write_fence\n", commit)
gamemaster_quiesce = text.index(
    "      quiesce_gamemaster_after_commit\n", forward_http_fence)
gamemaster_quiesce_failure = text.index(
    "migration_failure_hook gamemaster-quiesced-after-commit",
    gamemaster_quiesce)
mongo_unlock = text.index(
    "      unlock_target_writes\n", gamemaster_quiesce_failure)
mongo_unlock_failure = text.index(
    "migration_failure_hook mongo-write-unlocked", mongo_unlock)
rabbit_unlock = text.index("      unlock_rabbitmq_writes\n", mongo_unlock)
rabbit_unlock_failure = text.index(
    "migration_failure_hook rabbitmq-write-unlocked", rabbit_unlock)
http_fence_remove = text.index("      remove_http_write_fence\n", rabbit_unlock)
http_fence_failure = text.index(
    "migration_failure_hook http-write-fence-removed", http_fence_remove)
completed = text.index("state_advance completed", http_fence_failure)
committed_case = text.index(
    "        cutover-committed | cutover-forward-recovery)", lock_recheck)
forward_identity = text.index(
    "          verify_target_mongo_identity false", committed_case)
if not (main_freeze < fence_install < retry_unlock < replace < auth_start <
        mongo_lock < post_auth_exact < restart < finalize < finalize_phase <
        target_pod < lock_check < final_exact < lock_recheck < commit <
        committed_case < forward_identity < forward_http_fence <
        gamemaster_quiesce < gamemaster_quiesce_failure < mongo_unlock <
        mongo_unlock_failure < rabbit_unlock < rabbit_unlock_failure <
        http_fence_remove < http_fence_failure < completed):
    raise SystemExit("write-lock/cutover ordering differs")

auth_function_start = text.index("start_auth_before_mongo_lock() {")
auth_function_end = text.index("\n}\n", auth_function_start)
auth_function = text[auth_function_start:auth_function_end]
for required in (
    '$(target_write_lock_status)" == "false"',
    '$(http_write_fence_config_status)" == "true"',
    "wait_deployment_zero oci ingress-nginx",
    "gaming-rabbitmq-depl",
    '"gaming-${service}-depl"',
    'baseline_value "$oci_baseline" auth',
    "rollout status deployment/gaming-auth-depl",
    '[[ "$service" == "auth" ]] && continue',
    "migration_failure_hook auth-startup-before-mongo-lock",
):
    if required not in auth_function:
        raise SystemExit(f"pre-lock auth startup is missing: {required}")
if not (
    auth_entrypoint.index("await User.init()")
    < auth_entrypoint.index("app.listen(3000")
):
    raise SystemExit("auth no longer requires index initialization before readiness")

retry_unlock_start = text.index("unlock_target_writes_for_retry() {")
retry_unlock_end = text.index("\n}\n", retry_unlock_start)
retry_unlock_function = text[retry_unlock_start:retry_unlock_end]
runtime_read = retry_unlock_function.index(
    'lock_status="$(target_write_lock_status)"'
)
journal_read = retry_unlock_function.index(
    'journal_lock="$(state_optional_value mongo-write-lock)"'
)
runtime_unlock = retry_unlock_function.index(
    'if [[ "$lock_status" == "true" ]]; then'
)
journal_reconcile = retry_unlock_function.index(
    'if [[ "$lock_status" == "true" || "$journal_lock" == "true" ]]'
)
state_release = retry_unlock_function.index(
    "state_advance retry-write-lock-released", journal_reconcile
)
state_refresh = retry_unlock_function.index(
    "state_read_all >/dev/null", state_release
)
state_compare = retry_unlock_function.index(
    "state_compare_kind journal", state_refresh
)
final_assertion = retry_unlock_function.index(
    "retry Mongo write-lock state did not reconcile", state_compare
)
if not (
    runtime_read < journal_read < runtime_unlock < journal_reconcile
    < state_release < state_refresh < state_compare < final_assertion
):
    raise SystemExit("retry does not reconcile a process-cleared Mongo write lock")

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
grep -Fq "journal's original source SHA immutable" \
  "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
  fail "migration recovery agent omits immutable cross-release lineage"
grep -Fq "descendant hotfix can replace only the active source SHA" \
  "$OCI_DIR/LESSONS_LEARNED.md" ||
  fail "OCI lessons omit the descendant hotfix takeover boundary"
grep -Fq "Recreate sanitized recovery artifact directories after checkout" \
  "$OCI_DIR/LESSONS_LEARNED.md" ||
  fail "OCI lessons omit checkout-safe recovery evidence"

echo "migration_recovery_contract=PASS"
