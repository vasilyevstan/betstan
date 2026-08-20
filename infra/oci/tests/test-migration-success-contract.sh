#!/usr/bin/env bash
# Focused offline tests for the migration-success provenance contract helper.
# Tests: ordinary, closed-recovery, unknown/missing/duplicate fields,
#        invalid lineage relation, parity mismatch, wrong fingerprints.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONTRACT="$ROOT_DIR/infra/oci/scripts/migration-success-contract.sh"
WORK_BASE="$ROOT_DIR/infra/oci/tests/.test-workdirs"
mkdir -p "$WORK_BASE"
WORK_DIR="$(mktemp -d "$WORK_BASE/migration-success-contract-XXXXXX")"

PASS=0
FAIL=0

fail() {
  echo "FAIL: $*" >&2
  FAIL=$((FAIL + 1))
}

pass() {
  PASS=$((PASS + 1))
}

trap 'rm -rf "$WORK_DIR"' EXIT

# Syntax check
bash -n "$CONTRACT" || { fail "bash -n failed"; exit 1; }

# --- Fixture values --------------------------------------------------------
SOURCE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ANCESTOR_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
SIG_SHA256="$(printf 'c%.0s' {1..64})"
JOURNAL_SHA256="$(printf 'd%.0s' {1..64})"
CLUSTER_FP="$(printf 'e%.0s' {1..64})"

make_valid_env() {
  local recovery="${1:-false}"
  local deploy_sha="$SOURCE_SHA"
  [[ "$recovery" == "false" ]] || deploy_sha="$ANCESTOR_SHA"
  cat <<EOF
schema=betstan.oci-migration-success.v1
migration_id=42-1
source_sha=${SOURCE_SHA}
runtime_deploy_source_sha=${deploy_sha}
closed_recovery_retry=${recovery}
github_run_id=42
github_run_attempt=1
terminal_phase=DEPLOYED_HEALTHY
terminal_status=DEPLOYED_HEALTHY
journal_generation=5
fencing_generation=5
journal_sequence=12
journal_heartbeat_epoch=1700000000
final_journal_sha256=${JOURNAL_SHA256}
artifact_run_binding=42-1
destructive_boundary_crossed=true
database_count=8
logical_source_target_parity=true
source_signature_aggregate_sha256=${SIG_SHA256}
target_signature_aggregate_sha256=${SIG_SHA256}
oci_reopened_healthy=true
http_mutation_fence_removed=true
azure_writers_frozen=true
azure_cluster_resource_id_sha256=${CLUSTER_FP}
aks_power_state=Stopped
vmss_instances_deallocated=true
azure_cluster_stopped_deallocated=true
EOF
}

# --- Test: ordinary migration validates ------------------------------------
echo "--- Test: ordinary migration validates"
make_valid_env false > "$WORK_DIR/ordinary.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/ordinary.env" \
    SOURCE_SHA="$SOURCE_SHA" \
    MIGRATION_RUN_ID=42 \
    MIGRATION_RUN_ATTEMPT=1 \
    MIGRATION_ID=42-1 \
    AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256="$CLUSTER_FP"; then
  pass
else
  fail "ordinary migration should validate"
fi

# --- Test: closed-recovery migration validates -----------------------------
echo "--- Test: closed-recovery migration validates"
make_valid_env true > "$WORK_DIR/recovery.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/recovery.env" \
    SOURCE_SHA="$SOURCE_SHA" \
    MIGRATION_RUN_ID=42 \
    MIGRATION_RUN_ATTEMPT=1 \
    MIGRATION_ID=42-1 \
    AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256="$CLUSTER_FP"; then
  pass
else
  fail "closed-recovery migration should validate"
fi

# --- Test: emit mode produces valid file -----------------------------------
echo "--- Test: emit mode produces valid file"
if MODE=emit "$CONTRACT" "$WORK_DIR/emitted.env" \
    "schema=betstan.oci-migration-success.v1" \
    "migration_id=42-1" \
    "source_sha=$SOURCE_SHA" \
    "runtime_deploy_source_sha=$SOURCE_SHA" \
    "closed_recovery_retry=false" \
    "github_run_id=42" \
    "github_run_attempt=1" \
    "terminal_phase=DEPLOYED_HEALTHY" \
    "terminal_status=DEPLOYED_HEALTHY" \
    "journal_generation=5" \
    "fencing_generation=5" \
    "journal_sequence=12" \
    "journal_heartbeat_epoch=1700000000" \
    "final_journal_sha256=$JOURNAL_SHA256" \
    "artifact_run_binding=42-1" \
    "destructive_boundary_crossed=true" \
    "database_count=8" \
    "logical_source_target_parity=true" \
    "source_signature_aggregate_sha256=$SIG_SHA256" \
    "target_signature_aggregate_sha256=$SIG_SHA256" \
    "oci_reopened_healthy=true" \
    "http_mutation_fence_removed=true" \
    "azure_writers_frozen=true" \
    "azure_cluster_resource_id_sha256=$CLUSTER_FP" \
    "aks_power_state=Stopped" \
    "vmss_instances_deallocated=true" \
    "azure_cluster_stopped_deallocated=true"; then
  # Re-validate independently
  if MODE=validate "$CONTRACT" "$WORK_DIR/emitted.env"; then
    pass
  else
    fail "emitted file should re-validate"
  fi
else
  fail "emit mode should succeed with valid inputs"
fi

# --- Test: unknown field rejected ------------------------------------------
echo "--- Test: unknown field rejected"
make_valid_env false > "$WORK_DIR/unknown.env"
echo "bonus_field=surprise" >> "$WORK_DIR/unknown.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/unknown.env" 2>/dev/null; then
  fail "unknown field should be rejected"
else
  pass
fi

# --- Test: missing field rejected ------------------------------------------
echo "--- Test: missing field rejected"
make_valid_env false | grep -v "^oci_reopened_healthy=" > "$WORK_DIR/missing.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/missing.env" 2>/dev/null; then
  fail "missing field should be rejected"
else
  pass
fi

# --- Test: duplicate field rejected ----------------------------------------
echo "--- Test: duplicate field rejected"
make_valid_env false > "$WORK_DIR/duplicate.env"
echo "source_sha=$SOURCE_SHA" >> "$WORK_DIR/duplicate.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/duplicate.env" 2>/dev/null; then
  fail "duplicate field should be rejected"
else
  pass
fi

# --- Test: reordered envelope rejected --------------------------------------
echo "--- Test: reordered envelope rejected"
{
  make_valid_env false | sort
} > "$WORK_DIR/reordered.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/reordered.env" 2>/dev/null; then
  fail "reordered envelope should be rejected"
else
  pass
fi

# --- Test: invalid lineage relation (ordinary with different SHA) ----------
echo "--- Test: invalid lineage - ordinary with ancestor SHA"
{
  make_valid_env false | sed "s/^runtime_deploy_source_sha=.*/runtime_deploy_source_sha=$ANCESTOR_SHA/"
} > "$WORK_DIR/bad-lineage-ordinary.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/bad-lineage-ordinary.env" 2>/dev/null; then
  fail "ordinary with ancestor SHA should fail lineage check"
else
  pass
fi

# --- Test: invalid lineage relation (recovery with same SHA) ---------------
echo "--- Test: invalid lineage - recovery with same SHA"
{
  make_valid_env false | sed "s/^closed_recovery_retry=.*/closed_recovery_retry=true/"
} > "$WORK_DIR/bad-lineage-recovery.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/bad-lineage-recovery.env" 2>/dev/null; then
  fail "recovery with same SHA should fail lineage check"
else
  pass
fi

# --- Test: parity mismatch (source != target signature) --------------------
echo "--- Test: parity mismatch"
BAD_SIG="$(printf 'f%.0s' {1..64})"
{
  make_valid_env false | sed "s/^target_signature_aggregate_sha256=.*/target_signature_aggregate_sha256=$BAD_SIG/"
} > "$WORK_DIR/parity.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/parity.env" 2>/dev/null; then
  fail "parity mismatch should be rejected"
else
  pass
fi

# --- Test: wrong cluster fingerprint --------------------------------------
echo "--- Test: wrong cluster fingerprint"
WRONG_FP="$(printf '9%.0s' {1..64})"
make_valid_env false > "$WORK_DIR/wrong-fp.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/wrong-fp.env" \
    SOURCE_SHA="$SOURCE_SHA" \
    AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256="$WRONG_FP" 2>/dev/null; then
  fail "wrong fingerprint should be rejected"
else
  pass
fi

# --- Test: invalid aks_power_state -----------------------------------------
echo "--- Test: invalid aks_power_state"
{
  make_valid_env false | sed "s/^aks_power_state=.*/aks_power_state=Running/"
} > "$WORK_DIR/bad-power.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/bad-power.env" 2>/dev/null; then
  fail "invalid power state should be rejected"
else
  pass
fi

# --- Test: Deallocated power state accepted --------------------------------
echo "--- Test: Deallocated power state (case-preserving)"
{
  make_valid_env false | sed "s/^aks_power_state=.*/aks_power_state=Deallocated/"
} > "$WORK_DIR/dealloc-power.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/dealloc-power.env"; then
  pass
else
  fail "Deallocated power state should be accepted"
fi

# --- Test: invalid journal (zero) -----------------------------------------
echo "--- Test: zero journal_generation rejected"
{
  make_valid_env false | sed "s/^journal_generation=.*/journal_generation=0/"
} > "$WORK_DIR/zero-journal.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/zero-journal.env" 2>/dev/null; then
  fail "zero journal_generation should be rejected"
else
  pass
fi

# --- Test: run binding mismatch --------------------------------------------
echo "--- Test: run binding mismatch"
{
  make_valid_env false | sed "s/^artifact_run_binding=.*/artifact_run_binding=99-2/"
} > "$WORK_DIR/bad-binding.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/bad-binding.env" 2>/dev/null; then
  fail "mismatched run binding should be rejected"
else
  pass
fi

# --- Test: migration_id != run_id-run_attempt rejected ---------------------
echo "--- Test: migration_id intrinsic mismatch rejected"
{
  make_valid_env false | sed "s/^migration_id=.*/migration_id=99-9/"
} > "$WORK_DIR/bad-migration-id.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/bad-migration-id.env" 2>/dev/null; then
  fail "migration_id != run_id-attempt should be rejected"
else
  pass
fi

# --- Test: fields mode lists canonical fields ------------------------------
echo "--- Test: fields mode"
field_count="$(MODE=fields "$CONTRACT" | wc -l | tr -d ' ')"
if [[ "$field_count" == "27" ]]; then
  pass
else
  fail "fields mode should list 27 fields, got $field_count"
fi

# --- Test: sorted-fields matches retirement allowlist order ----------------
echo "--- Test: sorted-fields mode"
sorted_output="$(MODE=sorted-fields "$CONTRACT")"
expected_sorted="$(printf '%s\n' \
  aks_power_state \
  artifact_run_binding \
  azure_cluster_resource_id_sha256 \
  azure_cluster_stopped_deallocated \
  azure_writers_frozen \
  closed_recovery_retry \
  database_count \
  destructive_boundary_crossed \
  fencing_generation \
  final_journal_sha256 \
  github_run_attempt \
  github_run_id \
  http_mutation_fence_removed \
  journal_generation \
  journal_heartbeat_epoch \
  journal_sequence \
  logical_source_target_parity \
  migration_id \
  oci_reopened_healthy \
  runtime_deploy_source_sha \
  schema \
  source_sha \
  source_signature_aggregate_sha256 \
  target_signature_aggregate_sha256 \
  terminal_phase \
  terminal_status \
  vmss_instances_deallocated
)"
if [[ "$sorted_output" == "$expected_sorted" ]]; then
  pass
else
  fail "sorted-fields output doesn't match expected"
fi

# --- Test: emit rejects duplicate key -------------------------------------
echo "--- Test: emit rejects duplicate key"
if MODE=emit "$CONTRACT" "$WORK_DIR/dup-emit.env" \
    "schema=betstan.oci-migration-success.v1" \
    "schema=betstan.oci-migration-success.v1" \
    "migration_id=42-1" 2>/dev/null; then
  fail "emit should reject duplicate keys"
else
  pass
fi

# --- Test: emit rejects unknown key ---------------------------------------
echo "--- Test: emit rejects unknown key"
if MODE=emit "$CONTRACT" "$WORK_DIR/unknown-emit.env" \
    "schema=betstan.oci-migration-success.v1" \
    "migration_id=42-1" \
    "source_sha=$SOURCE_SHA" \
    "runtime_deploy_source_sha=$SOURCE_SHA" \
    "closed_recovery_retry=false" \
    "github_run_id=42" \
    "github_run_attempt=1" \
    "terminal_phase=DEPLOYED_HEALTHY" \
    "terminal_status=DEPLOYED_HEALTHY" \
    "journal_generation=5" \
    "fencing_generation=5" \
    "journal_sequence=12" \
    "journal_heartbeat_epoch=1700000000" \
    "final_journal_sha256=$JOURNAL_SHA256" \
    "artifact_run_binding=42-1" \
    "destructive_boundary_crossed=true" \
    "database_count=8" \
    "logical_source_target_parity=true" \
    "source_signature_aggregate_sha256=$SIG_SHA256" \
    "target_signature_aggregate_sha256=$SIG_SHA256" \
    "oci_reopened_healthy=true" \
    "http_mutation_fence_removed=true" \
    "azure_writers_frozen=true" \
    "azure_cluster_resource_id_sha256=$CLUSTER_FP" \
    "aks_power_state=Stopped" \
    "vmss_instances_deallocated=true" \
    "azure_cluster_stopped_deallocated=true" \
    "sneaky_extra=evil" 2>/dev/null; then
  fail "emit should reject unknown keys"
else
  pass
fi

# --- Test: generation mismatch (journal != fencing) -------------------------
echo "--- Test: generation mismatch rejected"
{
  make_valid_env false | sed "s/^fencing_generation=.*/fencing_generation=99/"
} > "$WORK_DIR/gen-mismatch.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/gen-mismatch.env" 2>/dev/null; then
  fail "journal != fencing generation should be rejected"
else
  pass
fi

# --- Test: malformed emit arg (no equals) ------------------------------------
echo "--- Test: malformed emit arg rejected"
if MODE=emit "$CONTRACT" "$WORK_DIR/malformed-emit.env" \
    "schema=betstan.oci-migration-success.v1" \
    "bad_no_equals" 2>/dev/null; then
  fail "malformed emit arg (no =) should be rejected"
else
  pass
fi

# --- Test: unknown context key rejected --------------------------------------
echo "--- Test: unknown context key rejected"
make_valid_env false > "$WORK_DIR/ctx-unknown.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/ctx-unknown.env" \
    SOURCE_SHA="$SOURCE_SHA" \
    TYPO_KEY="oops" 2>/dev/null; then
  fail "unknown context key should be rejected"
else
  pass
fi

# --- Test: malformed context arg (no equals) ---------------------------------
echo "--- Test: malformed context arg rejected"
make_valid_env false > "$WORK_DIR/ctx-malformed.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/ctx-malformed.env" \
    "not_a_key_value" 2>/dev/null; then
  fail "malformed context arg should be rejected"
else
  pass
fi

# --- Test: duplicate context key rejected (last-wins prevented) --------------
echo "--- Test: duplicate context key rejected"
WRONG_SHA="ffffffffffffffffffffffffffffffffffffffff"
make_valid_env false > "$WORK_DIR/ctx-dup.env"
if MODE=validate "$CONTRACT" "$WORK_DIR/ctx-dup.env" \
    SOURCE_SHA="$WRONG_SHA" \
    SOURCE_SHA="$SOURCE_SHA" 2>/dev/null; then
  fail "duplicate context key should be rejected even if second is correct"
else
  pass
fi

# --- Test: emit does not leave temp on semantic failure ----------------------
echo "--- Test: emit cleans temp on failure"
if MODE=emit "$CONTRACT" "$WORK_DIR/fail-atomic.env" \
    "schema=betstan.oci-migration-success.v1" \
    "migration_id=42-1" \
    "source_sha=$SOURCE_SHA" \
    "runtime_deploy_source_sha=$ANCESTOR_SHA" \
    "closed_recovery_retry=false" \
    "github_run_id=42" \
    "github_run_attempt=1" \
    "terminal_phase=DEPLOYED_HEALTHY" \
    "terminal_status=DEPLOYED_HEALTHY" \
    "journal_generation=5" \
    "fencing_generation=5" \
    "journal_sequence=12" \
    "journal_heartbeat_epoch=1700000000" \
    "final_journal_sha256=$JOURNAL_SHA256" \
    "artifact_run_binding=42-1" \
    "destructive_boundary_crossed=true" \
    "database_count=8" \
    "logical_source_target_parity=true" \
    "source_signature_aggregate_sha256=$SIG_SHA256" \
    "target_signature_aggregate_sha256=$SIG_SHA256" \
    "oci_reopened_healthy=true" \
    "http_mutation_fence_removed=true" \
    "azure_writers_frozen=true" \
    "azure_cluster_resource_id_sha256=$CLUSTER_FP" \
    "aks_power_state=Stopped" \
    "vmss_instances_deallocated=true" \
    "azure_cluster_stopped_deallocated=true" 2>/dev/null; then
  fail "emit with bad lineage should fail"
else
  # Verify neither output nor temp exist in the work dir
  if compgen -G "$WORK_DIR/fail-atomic.env" >/dev/null 2>&1 ||
     compgen -G "$WORK_DIR/.contract-emit-*" >/dev/null 2>&1; then
    fail "emit left temp or output file on failure"
  else
    pass
  fi
fi

# --- Test: emit preserves pre-existing destination on failure ----------------
echo "--- Test: emit preserves pre-existing destination on failure"
echo "ORIGINAL_CONTENT" > "$WORK_DIR/preserve-target.env"
if MODE=emit "$CONTRACT" "$WORK_DIR/preserve-target.env" \
    "schema=betstan.oci-migration-success.v1" \
    "migration_id=42-1" \
    "source_sha=$SOURCE_SHA" \
    "runtime_deploy_source_sha=$ANCESTOR_SHA" \
    "closed_recovery_retry=false" \
    "github_run_id=42" \
    "github_run_attempt=1" \
    "terminal_phase=DEPLOYED_HEALTHY" \
    "terminal_status=DEPLOYED_HEALTHY" \
    "journal_generation=5" \
    "fencing_generation=5" \
    "journal_sequence=12" \
    "journal_heartbeat_epoch=1700000000" \
    "final_journal_sha256=$JOURNAL_SHA256" \
    "artifact_run_binding=42-1" \
    "destructive_boundary_crossed=true" \
    "database_count=8" \
    "logical_source_target_parity=true" \
    "source_signature_aggregate_sha256=$SIG_SHA256" \
    "target_signature_aggregate_sha256=$SIG_SHA256" \
    "oci_reopened_healthy=true" \
    "http_mutation_fence_removed=true" \
    "azure_writers_frozen=true" \
    "azure_cluster_resource_id_sha256=$CLUSTER_FP" \
    "aks_power_state=Stopped" \
    "vmss_instances_deallocated=true" \
    "azure_cluster_stopped_deallocated=true" 2>/dev/null; then
  fail "emit with bad lineage should fail"
else
  # Pre-existing file must be intact
  if [[ "$(cat "$WORK_DIR/preserve-target.env")" == "ORIGINAL_CONTENT" ]]; then
    pass
  else
    fail "emit altered pre-existing destination on failure"
  fi
fi

# --- Test: successful emit produces 0600 permissions -------------------------
echo "--- Test: emit output has mode 0600"
MODE=emit "$CONTRACT" "$WORK_DIR/perms.env" \
    "schema=betstan.oci-migration-success.v1" \
    "migration_id=42-1" \
    "source_sha=$SOURCE_SHA" \
    "runtime_deploy_source_sha=$SOURCE_SHA" \
    "closed_recovery_retry=false" \
    "github_run_id=42" \
    "github_run_attempt=1" \
    "terminal_phase=DEPLOYED_HEALTHY" \
    "terminal_status=DEPLOYED_HEALTHY" \
    "journal_generation=5" \
    "fencing_generation=5" \
    "journal_sequence=12" \
    "journal_heartbeat_epoch=1700000000" \
    "final_journal_sha256=$JOURNAL_SHA256" \
    "artifact_run_binding=42-1" \
    "destructive_boundary_crossed=true" \
    "database_count=8" \
    "logical_source_target_parity=true" \
    "source_signature_aggregate_sha256=$SIG_SHA256" \
    "target_signature_aggregate_sha256=$SIG_SHA256" \
    "oci_reopened_healthy=true" \
    "http_mutation_fence_removed=true" \
    "azure_writers_frozen=true" \
    "azure_cluster_resource_id_sha256=$CLUSTER_FP" \
    "aks_power_state=Stopped" \
    "vmss_instances_deallocated=true" \
    "azure_cluster_stopped_deallocated=true"
perms="$(stat -c '%a' "$WORK_DIR/perms.env" 2>/dev/null || stat -f '%Lp' "$WORK_DIR/perms.env" 2>/dev/null)"
if [[ "$perms" == "600" ]]; then
  pass
else
  fail "emit output should be mode 600, got $perms"
fi

# --- Test: trap cleans temp on mv failure (stubbed mv) -----------------------
echo "--- Test: trap cleans created temp on mv failure"
mkdir -p "$WORK_DIR/mv-fail-dest"
# Create a wrapper script that uses a fake mv to simulate failure
cat > "$WORK_DIR/mv-fail-emit.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
DEST_DIR="$1"; shift
CONTRACT="$1"; shift
# Inject a failing mv into PATH
BIN_DIR="$DEST_DIR/.stubbin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/mv" <<'MV_STUB'
#!/usr/bin/env bash
# Allow mv only if not targeting the output file
for a in "$@"; do
  case "$a" in
    */stubbed-output.env) exit 1 ;;
  esac
done
exec /bin/mv "$@"
MV_STUB
chmod +x "$BIN_DIR/mv"
PATH="$BIN_DIR:$PATH" MODE=emit "$CONTRACT" "$DEST_DIR/stubbed-output.env" "$@"
INNER
chmod +x "$WORK_DIR/mv-fail-emit.sh"
if "$WORK_DIR/mv-fail-emit.sh" "$WORK_DIR/mv-fail-dest" "$CONTRACT" \
    "schema=betstan.oci-migration-success.v1" \
    "migration_id=42-1" \
    "source_sha=$SOURCE_SHA" \
    "runtime_deploy_source_sha=$SOURCE_SHA" \
    "closed_recovery_retry=false" \
    "github_run_id=42" \
    "github_run_attempt=1" \
    "terminal_phase=DEPLOYED_HEALTHY" \
    "terminal_status=DEPLOYED_HEALTHY" \
    "journal_generation=5" \
    "fencing_generation=5" \
    "journal_sequence=12" \
    "journal_heartbeat_epoch=1700000000" \
    "final_journal_sha256=$JOURNAL_SHA256" \
    "artifact_run_binding=42-1" \
    "destructive_boundary_crossed=true" \
    "database_count=8" \
    "logical_source_target_parity=true" \
    "source_signature_aggregate_sha256=$SIG_SHA256" \
    "target_signature_aggregate_sha256=$SIG_SHA256" \
    "oci_reopened_healthy=true" \
    "http_mutation_fence_removed=true" \
    "azure_writers_frozen=true" \
    "azure_cluster_resource_id_sha256=$CLUSTER_FP" \
    "aks_power_state=Stopped" \
    "vmss_instances_deallocated=true" \
    "azure_cluster_stopped_deallocated=true" 2>/dev/null; then
  fail "emit with failing mv should not succeed"
else
  # Temp must have been cleaned by the EXIT trap
  if compgen -G "$WORK_DIR/mv-fail-dest/.contract-emit-*" >/dev/null 2>&1; then
    fail "emit left temp file after mv failure"
  else
    pass
  fi
  # Output must not exist
  if [[ -f "$WORK_DIR/mv-fail-dest/stubbed-output.env" ]]; then
    fail "emit produced output despite mv failure"
  else
    pass
  fi
fi

# --- Test: directory destination rejected ------------------------------------
echo "--- Test: directory destination rejected"
mkdir -p "$WORK_DIR/dir-as-dest"
if MODE=emit "$CONTRACT" "$WORK_DIR/dir-as-dest" \
    "schema=betstan.oci-migration-success.v1" \
    "migration_id=42-1" \
    "source_sha=$SOURCE_SHA" \
    "runtime_deploy_source_sha=$SOURCE_SHA" \
    "closed_recovery_retry=false" \
    "github_run_id=42" \
    "github_run_attempt=1" \
    "terminal_phase=DEPLOYED_HEALTHY" \
    "terminal_status=DEPLOYED_HEALTHY" \
    "journal_generation=5" \
    "fencing_generation=5" \
    "journal_sequence=12" \
    "journal_heartbeat_epoch=1700000000" \
    "final_journal_sha256=$JOURNAL_SHA256" \
    "artifact_run_binding=42-1" \
    "destructive_boundary_crossed=true" \
    "database_count=8" \
    "logical_source_target_parity=true" \
    "source_signature_aggregate_sha256=$SIG_SHA256" \
    "target_signature_aggregate_sha256=$SIG_SHA256" \
    "oci_reopened_healthy=true" \
    "http_mutation_fence_removed=true" \
    "azure_writers_frozen=true" \
    "azure_cluster_resource_id_sha256=$CLUSTER_FP" \
    "aks_power_state=Stopped" \
    "vmss_instances_deallocated=true" \
    "azure_cluster_stopped_deallocated=true" 2>/dev/null; then
  fail "emit to a directory path should be rejected"
else
  pass
fi

# --- Summary -----------------------------------------------------------------
echo ""
echo "migration-success-contract tests: $PASS passed, $FAIL failed"
[[ "$FAIL" == "0" ]] || exit 1
