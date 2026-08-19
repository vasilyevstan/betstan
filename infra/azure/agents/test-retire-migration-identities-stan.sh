#!/usr/bin/env bash
set -euo pipefail

# Test contract for retire-migration-identities-stan.sh
# Verifies fail-closed presence probes: API errors are never accepted as absence.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATOR="$ROOT_DIR/infra/azure/agents/retire-migration-identities-stan.sh"
WORK_DIR="$ROOT_DIR/infra/azure/agents/.test-workdirs/identity-retirement-$$-$(date +%s)"
BIN_DIR="$WORK_DIR/bin"

mkdir -p "$BIN_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

PASS=0
FAIL=0
SCENARIOS=0

pass() { PASS=$((PASS + 1)); SCENARIOS=$((SCENARIOS + 1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); SCENARIOS=$((SCENARIOS + 1)); printf '  FAIL: %s\n' "$1" >&2; }

# Valid GUIDs for fixtures
GUID_TENANT="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
GUID_SUB="11111111-2222-3333-4444-555555555555"
GUID_MIG_APP="22222222-3333-4444-5555-666666666666"
GUID_REC_APP="33333333-4444-5555-6666-777777777777"
GUID_MIG_SP="44444444-5555-6666-7777-888888888888"
GUID_REC_SP="55555555-6666-7777-8888-999999999999"
GUID_RETAINED_SP="66666666-7777-8888-9999-aaaaaaaaaaaa"
GUID_ROLE1="77777777-8888-9999-aaaa-bbbbbbbbbbbb"
GUID_ROLE2="88888888-9999-aaaa-bbbb-cccccccccccc"
GUID_RA1="99999999-aaaa-bbbb-cccc-dddddddddddd"
GUID_RA2="aaaaaaaa-bbbb-cccc-dddd-111111111111"
GUID_RA3="bbbbbbbb-cccc-dddd-eeee-222222222222"

RA_ID_1="/subscriptions/$GUID_SUB/providers/Microsoft.Authorization/roleAssignments/$GUID_RA1"
RA_ID_2="/subscriptions/$GUID_SUB/providers/Microsoft.Authorization/roleAssignments/$GUID_RA2"
RA_ID_3="/subscriptions/$GUID_SUB/providers/Microsoft.Authorization/roleAssignments/$GUID_RA3"

write_metadata() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/metadata.env" <<META
tenant_id=$GUID_TENANT
subscription_id=$GUID_SUB
migration_app_id=$GUID_MIG_APP
recovery_app_id=$GUID_REC_APP
migration_sp_object_id=$GUID_MIG_SP
recovery_sp_object_id=$GUID_REC_SP
retained_sp_object_id=$GUID_RETAINED_SP
role_assignment_id_1=$RA_ID_1
role_assignment_id_2=$RA_ID_2
role_assignment_id_3=$RA_ID_3
custom_role_id_1=$GUID_ROLE1
custom_role_id_2=$GUID_ROLE2
migration_environment=azure-migration
recovery_environment=azure-recovery
retained_sp_display_name=betstan-github-sp
retained_secret_name=AZURE_CREDENTIALS
repository=vasilyevstan/betstan
META
  chmod 600 "$dir/metadata.env"
}

# --- Stub: az ---
# Probes use filtered list queries returning counts.
# STUB_PROBE_*_FAIL=1 makes the probe command itself fail (simulating API error).
# STUB_*_ALREADY_ABSENT=1 makes the probe return count=0 (proven absent).
# STUB_*_STILL_PRESENT=1 makes the probe return count=1 (still present).
cat > "$BIN_DIR/az" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${STUB_AZ_LOG:?}"

case "${1:-} ${2:-}" in
  "account show")
    if [[ "${STUB_WRONG_SUBSCRIPTION:-0}" == "1" ]]; then
      if [[ "$*" == *tenantId* ]]; then printf 'wrong-tenant\n'; else printf 'wrong-sub\n'; fi
    elif [[ "${STUB_WRONG_TENANT:-0}" == "1" ]]; then
      if [[ "$*" == *tenantId* ]]; then printf 'wrong-tenant\n'; else printf '%s\n' "$STUB_EXPECTED_SUB"; fi
    else
      if [[ "$*" == *tenantId* ]]; then printf '%s\n' "$STUB_EXPECTED_TENANT"; else printf '%s\n' "$STUB_EXPECTED_SUB"; fi
    fi
    ;;
  "ad sp")
    case "${3:-}" in
      list)
        # Probe: filtered list query
        # Check if this is the retained SP probe or temporary SP probe
        if [[ "$*" == *"$STUB_RETAINED_SP_OID"* ]]; then
          if [[ "${STUB_RETAINED_SP_MISSING:-0}" == "1" ]]; then
            # For count query
            if [[ "$*" == *"length"* ]]; then
              printf '0\n'
            else
              printf '[]\n'
            fi
          elif [[ "${STUB_PROBE_RETAINED_SP_FAIL:-0}" == "1" ]]; then
            printf 'AuthenticationError\n' >&2
            exit 1
          else
            if [[ "$*" == *"length"* ]]; then
              printf '1\n'
            else
              printf '[{"displayName":"%s","id":"%s"}]\n' \
                "${STUB_RETAINED_SP_DISPLAY:-betstan-github-sp}" "$STUB_RETAINED_SP_OID"
            fi
          fi
        else
          # Temporary SP probe
          if [[ "${STUB_PROBE_SP_FAIL:-0}" == "1" ]]; then
            printf 'ServiceUnavailable\n' >&2
            exit 1
          fi
          if [[ "${STUB_SP_ALREADY_ABSENT:-0}" == "1" ]]; then
            printf '0\n'
          elif [[ "${STUB_SP_STILL_PRESENT:-0}" == "1" ]]; then
            printf '1\n'
          else
            printf '0\n'
          fi
        fi
        ;;
      delete)
        if [[ "${STUB_SP_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
        if [[ "${STUB_SP_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
        ;;
      *)
        printf 'unexpected az ad sp subcommand: %s\n' "${3:-}" >&2; exit 1
        ;;
    esac
    ;;
  "ad app")
    case "${3:-}" in
      list)
        if [[ "${STUB_PROBE_APP_FAIL:-0}" == "1" ]]; then
          printf 'ServiceUnavailable\n' >&2; exit 1
        fi
        if [[ "${STUB_APP_ALREADY_ABSENT:-0}" == "1" ]]; then
          printf '0\n'
        elif [[ "${STUB_APP_STILL_PRESENT:-0}" == "1" ]]; then
          printf '1\n'
        else
          printf '0\n'
        fi
        ;;
      delete)
        if [[ "${STUB_APP_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
        ;;
    esac
    ;;
  "role assignment")
    case "${3:-}" in
      list)
        if [[ "${STUB_PROBE_RA_FAIL:-0}" == "1" ]]; then
          printf 'Forbidden\n' >&2; exit 1
        fi
        if [[ "${STUB_RA_STILL_PRESENT:-0}" == "1" ]]; then
          printf '1\n'
        else
          printf '0\n'
        fi
        ;;
      delete)
        if [[ "${STUB_RA_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
        ;;
    esac
    ;;
  "role definition")
    case "${3:-}" in
      list)
        if [[ "${STUB_PROBE_ROLE_FAIL:-0}" == "1" ]]; then
          printf 'NetworkError\n' >&2; exit 1
        fi
        if [[ "${STUB_ROLE_ALREADY_ABSENT:-0}" == "1" ]]; then
          printf '0\n'
        elif [[ "${STUB_ROLE_STILL_PRESENT:-0}" == "1" ]]; then
          printf '1\n'
        else
          printf '0\n'
        fi
        ;;
      delete)
        if [[ "${STUB_ROLE_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
        ;;
    esac
    ;;
  *) printf 'unexpected az call: %s\n' "$*" >&2; exit 1 ;;
esac
STUB
chmod +x "$BIN_DIR/az"

# --- Stub: gh ---
cat > "$BIN_DIR/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${STUB_GH_LOG:?}"
case "${1:-}" in
  secret)
    case "${2:-}" in
      list)
        if [[ "$*" == *"--env"* ]]; then
          if [[ "${STUB_PROBE_SECRET_FAIL:-0}" == "1" ]]; then
            printf 'HttpError\n' >&2; exit 1
          fi
          if [[ "${STUB_SECRET_STILL_PRESENT:-0}" == "1" ]]; then
            printf 'OCI_MIGRATION_AZURE_CREDENTIALS    Updated 2025-01-01\n'
          else
            printf '\n'
          fi
        else
          if [[ "${STUB_PROBE_REPO_SECRET_FAIL:-0}" == "1" ]]; then
            printf 'HttpError\n' >&2; exit 1
          fi
          if [[ "${STUB_RETAINED_SECRET_MISSING:-0}" == "1" ]]; then
            printf 'OTHER_SECRET    Updated 2025-01-01\n'
          else
            printf 'AZURE_CREDENTIALS    Updated 2025-01-01\n'
          fi
        fi
        ;;
      delete)
        if [[ "${STUB_SECRET_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
        ;;
    esac
    ;;
  variable)
    case "${2:-}" in
      get)
        var_name="${3:-}"
        if [[ "$var_name" == "OCI_MIGRATION_RECOVERY_ENABLED" ]]; then
          if [[ "${STUB_RECOVERY_ENABLED:-false}" != "false" ]]; then
            printf '%s\n' "${STUB_RECOVERY_ENABLED}"
          else
            printf 'false\n'
          fi
        elif [[ "$var_name" == "OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH" ]]; then
          if [[ "${STUB_ARM_EPOCH:-0}" != "0" ]]; then
            printf '%s\n' "${STUB_ARM_EPOCH}"
          else
            printf '0\n'
          fi
        else
          printf 'unknown variable: %s\n' "$var_name" >&2; exit 1
        fi
        ;;
      set) ;;
    esac
    ;;
  workflow)
    case "${2:-}" in
      disable)
        if [[ "${STUB_WORKFLOW_DISABLE_FAIL:-0}" == "1" ]]; then exit 1; fi
        ;;
      view)
        if [[ "${STUB_PROBE_WORKFLOW_FAIL:-0}" == "1" ]]; then
          printf 'HttpError\n' >&2; exit 1
        fi
        if [[ "${STUB_WORKFLOW_DISABLE_FAIL:-0}" == "1" && "${STUB_PROBE_WORKFLOW_FAIL:-0}" != "1" ]]; then
          printf 'active\n'
        else
          printf 'disabled_manually\n'
        fi
        ;;
    esac
    ;;
  *) printf 'unexpected gh call: %s\n' "$*" >&2; exit 1 ;;
esac
STUB
chmod +x "$BIN_DIR/gh"

# --- Stub: jq ---
JQ_REAL="$(command -v jq)"
cat > "$BIN_DIR/jq" <<STUB
#!/usr/bin/env bash
exec "$JQ_REAL" "\$@"
STUB
chmod +x "$BIN_DIR/jq"

# --- Helpers ---

run_operator() {
  local mode="$1"; shift
  local fixture_dir="$1"; shift
  write_metadata "$fixture_dir"

  local extra_env=()
  while [[ $# -gt 0 ]]; do extra_env+=("$1"); shift; done

  : > "$WORK_DIR/az.log"
  : > "$WORK_DIR/gh.log"
  env \
    PATH="$BIN_DIR:$PATH" \
    STUB_AZ_LOG="$WORK_DIR/az.log" \
    STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GUID_TENANT" \
    STUB_EXPECTED_SUB="$GUID_SUB" \
    STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    GH_REPOSITORY="vasilyevstan/betstan" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 \
    ${extra_env[@]+"${extra_env[@]}"} \
    "$OPERATOR" "$mode"
}

expect_output() {
  local label="$1" pattern="$2"; shift 2
  local output
  output="$("$@" 2>&1)" || true
  if echo "$output" | grep -qE "$pattern"; then pass "$label"
  else fail "$label (pattern: $pattern, got: $(echo "$output" | tail -1))"; fi
}

expect_fail_with() {
  local label="$1" pattern="$2"; shift 2
  local output
  if output="$("$@" 2>&1)"; then fail "$label (should have failed)"
  else
    if echo "$output" | grep -qE "$pattern"; then pass "$label"
    else fail "$label (expected: $pattern, got: $(echo "$output" | tail -1))"; fi
  fi
}

# ==========================================
# TEST SCENARIOS
# ==========================================
printf 'identity_retirement_contract: starting\n'

# --- Core success path ---
expect_output "successful_plan" "identity_retirement=READY phase=plan" \
  run_operator plan "$WORK_DIR/t-plan"

expect_output "successful_execute" "IDENTITY_RETIRED objects_deleted=9" \
  run_operator execute "$WORK_DIR/t-execute"

run_operator execute "$WORK_DIR/t-verify-flow" >/dev/null 2>&1 || true
expect_output "successful_verify" "IDENTITY_RETIREMENT_VERIFIED" \
  run_operator verify "$WORK_DIR/t-verify-flow"

# --- Partial deletion / resume ---
fixture_dir="$WORK_DIR/t-resume"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  STUB_SP_DELETE_FAIL=1 STUB_SP_STILL_PRESENT=1 \
  "$OPERATOR" execute >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/identity-retirement-state.env" ]]; then
  output="$(run_operator execute "$fixture_dir" 2>&1)" || true
  if echo "$output" | grep -q "IDENTITY_RETIRED"; then pass "partial_deletion_resume"
  else fail "partial_deletion_resume"; fi
else fail "partial_deletion_resume (no state)"; fi

# --- Already-absent (proven empty response) ---
expect_output "already_absent_objects" "IDENTITY_RETIRED" \
  run_operator execute "$WORK_DIR/t-absent" \
  STUB_SP_ALREADY_ABSENT=1 STUB_APP_ALREADY_ABSENT=1 STUB_ROLE_ALREADY_ABSENT=1

# --- Wrong scope ---
expect_fail_with "wrong_subscription" "wrong_subscription" \
  run_operator plan "$WORK_DIR/t-wrong-sub" STUB_WRONG_SUBSCRIPTION=1
expect_fail_with "wrong_tenant" "wrong_tenant" \
  run_operator plan "$WORK_DIR/t-wrong-tenant" STUB_WRONG_TENANT=1

# --- Changed object (still present after delete) ---
expect_fail_with "changed_object_sp" "sp_delete_failed" \
  run_operator execute "$WORK_DIR/t-changed-sp" \
  STUB_SP_DELETE_FAIL=1 STUB_SP_STILL_PRESENT=1

# --- Missing/duplicate/malformed metadata ---
fixture_dir="$WORK_DIR/t-missing-field"
mkdir -p "$fixture_dir"
cat > "$fixture_dir/metadata.env" <<META
tenant_id=$GUID_TENANT
subscription_id=$GUID_SUB
META
chmod 600 "$fixture_dir/metadata.env"
expect_fail_with "missing_metadata_field" "metadata_unknown_or_missing_keys" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-dup-field"
write_metadata "$fixture_dir"
printf 'tenant_id=duplicate\n' >> "$fixture_dir/metadata.env"
expect_fail_with "duplicate_metadata_field" \
  "metadata_unknown_or_missing_keys|metadata_missing_or_duplicate_field" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-malformed"
mkdir -p "$fixture_dir"
printf 'NOT A VALID LINE\n' > "$fixture_dir/metadata.env"
chmod 600 "$fixture_dir/metadata.env"
expect_fail_with "malformed_metadata_line" "metadata_malformed_line" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-bad-guid"
write_metadata "$fixture_dir"
sed -i.bak "s/^tenant_id=.*/tenant_id=not-a-guid/" "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "invalid_guid_format" "metadata_invalid_guid" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-ra-wrong-sub"
write_metadata "$fixture_dir"
sed -i.bak "s|role_assignment_id_1=.*|role_assignment_id_1=/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/$GUID_RA1|" \
  "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "role_assignment_wrong_subscription" "metadata_role_assignment_wrong_subscription" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- GitHub secret/workflow failures ---
expect_fail_with "github_secret_delete_failure" "github_secret_delete_failed" \
  run_operator execute "$WORK_DIR/t-secret-fail" \
  STUB_SECRET_DELETE_FAIL=1 STUB_SECRET_STILL_PRESENT=1
expect_fail_with "workflow_disable_failure" "workflow_disable_failed" \
  run_operator execute "$WORK_DIR/t-wf-fail" STUB_WORKFLOW_DISABLE_FAIL=1

# --- Retained identity protection ---
expect_fail_with "retained_sp_missing" "retained_sp_not_found" \
  run_operator plan "$WORK_DIR/t-retained-sp" STUB_RETAINED_SP_MISSING=1
expect_fail_with "retained_sp_display_mismatch" "retained_sp_display_name_mismatch" \
  run_operator plan "$WORK_DIR/t-sp-display" STUB_RETAINED_SP_DISPLAY=wrong-name
expect_fail_with "retained_secret_missing" "retained_secret_not_found" \
  run_operator plan "$WORK_DIR/t-retained-secret" STUB_RETAINED_SECRET_MISSING=1

# --- Wrong repository ---
fixture_dir="$WORK_DIR/t-wrong-repo"
write_metadata "$fixture_dir"
sed -i.bak 's/repository=vasilyevstan\/betstan/repository=other\/repo/' "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "wrong_repository" "wrong_repository" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- Recovery/ARM guards ---
expect_fail_with "recovery_variable_guard" "recovery_enabled_must_be_false" \
  run_operator plan "$WORK_DIR/t-recovery-var" STUB_RECOVERY_ENABLED=true
expect_fail_with "arm_epoch_guard" "arm_epoch_must_be_zero" \
  run_operator plan "$WORK_DIR/t-arm-var" STUB_ARM_EPOCH=1724000000

# --- Symlink rejection ---
fixture_dir="$WORK_DIR/t-symlink"
mkdir -p "$fixture_dir"
write_metadata "$WORK_DIR/t-symlink-src"
ln -sf "$WORK_DIR/t-symlink-src/metadata.env" "$fixture_dir/metadata.env"
expect_fail_with "symlink_metadata_rejection" "metadata_file_missing_or_symlink" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- Safe cleanup / metadata preservation ---
fixture_dir="$WORK_DIR/t-cleanup"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 \
  "$OPERATOR" verify >/dev/null 2>&1 || true
if [[ ! -f "$fixture_dir/metadata.env" && -f "$fixture_dir/identity-retirement-state.env" ]]; then
  pass "safe_cleanup_metadata_removed_state_preserved"
else fail "safe_cleanup_metadata_removed_state_preserved"; fi

fixture_dir="$WORK_DIR/t-no-cleanup"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 \
  "$OPERATOR" verify >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/metadata.env" ]]; then pass "metadata_retained_without_cleanup_flag"
else fail "metadata_retained_without_cleanup_flag"; fi

# --- Duplicate/targeting protection ---
fixture_dir="$WORK_DIR/t-dup-app"
write_metadata "$fixture_dir"
sed -i.bak "s/^recovery_app_id=.*/recovery_app_id=$GUID_MIG_APP/" "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "duplicate_app_ids" "metadata_duplicate_app_ids" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-target-retained"
write_metadata "$fixture_dir"
sed -i.bak "s/^migration_sp_object_id=.*/migration_sp_object_id=$GUID_RETAINED_SP/" "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "retained_sp_targeting_protection" "metadata_retained_sp_equals_temporary" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- Failure preserves metadata ---
fixture_dir="$WORK_DIR/t-fail-preserves"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 STUB_WORKFLOW_DISABLE_FAIL=1 \
  "$OPERATOR" execute >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/metadata.env" ]]; then pass "failure_preserves_metadata"
else fail "failure_preserves_metadata"; fi

# ==========================================
# FAIL-CLOSED REGRESSIONS: API errors never accepted as absence
# ==========================================
printf '\n  --- fail-closed regressions ---\n'

# SP probe API error during delete fallback
expect_fail_with "probe_sp_api_error_not_absence" "probe_sp_api_error" \
  run_operator execute "$WORK_DIR/t-probe-sp-err" \
  STUB_SP_DELETE_FAIL=1 STUB_PROBE_SP_FAIL=1

# App probe API error during delete fallback
expect_fail_with "probe_app_api_error_not_absence" "probe_app_api_error" \
  run_operator execute "$WORK_DIR/t-probe-app-err" \
  STUB_APP_ALREADY_ABSENT=1 STUB_PROBE_APP_FAIL=1

# Role assignment probe API error during delete fallback
expect_fail_with "probe_ra_api_error_not_absence" "probe_role_assignment_api_error" \
  run_operator execute "$WORK_DIR/t-probe-ra-err" \
  STUB_RA_DELETE_FAIL=1 STUB_PROBE_RA_FAIL=1

# Custom role probe API error during delete fallback
expect_fail_with "probe_role_api_error_not_absence" "probe_custom_role_api_error" \
  run_operator execute "$WORK_DIR/t-probe-role-err" \
  STUB_ROLE_ALREADY_ABSENT=1 STUB_PROBE_ROLE_FAIL=1

# Secret probe API error during delete fallback
expect_fail_with "probe_secret_api_error_not_absence" "probe_secret_api_error" \
  run_operator execute "$WORK_DIR/t-probe-secret-err" \
  STUB_SECRET_DELETE_FAIL=1 STUB_PROBE_SECRET_FAIL=1

# Retained SP probe API error during plan
expect_fail_with "retained_sp_probe_api_error" "retained_sp_query_api_error" \
  run_operator plan "$WORK_DIR/t-retained-sp-err" STUB_PROBE_RETAINED_SP_FAIL=1

# Repo secret probe API error during plan (retained secret check)
expect_fail_with "retained_secret_probe_api_error" "probe_repo_secret_api_error" \
  run_operator plan "$WORK_DIR/t-retained-secret-err" STUB_PROBE_REPO_SECRET_FAIL=1

# Workflow view API error during verify
fixture_dir="$WORK_DIR/t-wf-probe-err"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
expect_fail_with "workflow_view_api_error_in_verify" "workflow_view_api_error" \
  run_operator verify "$fixture_dir" STUB_PROBE_WORKFLOW_FAIL=1

# SP probe API error during terminal verify
fixture_dir="$WORK_DIR/t-verify-sp-err"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
expect_fail_with "verify_sp_probe_api_error" "probe_sp_api_error" \
  run_operator verify "$fixture_dir" STUB_PROBE_SP_FAIL=1

# ==========================================
# SUMMARY
# ==========================================
printf '\nidentity_retirement_contract=%s scenarios=%d pass=%d fail=%d\n' \
  "$( [[ "$FAIL" -eq 0 ]] && printf 'PASS' || printf 'FAIL' )" \
  "$SCENARIOS" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
