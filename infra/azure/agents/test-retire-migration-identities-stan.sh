#!/usr/bin/env bash
set -euo pipefail

# Test contract for retire-migration-identities-stan.sh
# Uses unique work directory under .test-workdirs for reentrancy.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATOR="$ROOT_DIR/infra/azure/agents/retire-migration-identities-stan.sh"
WORK_DIR="$ROOT_DIR/infra/azure/agents/.test-workdirs/identity-retirement-$$-$(date +%s)"
BIN_DIR="$WORK_DIR/bin"

mkdir -p "$BIN_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

PASS=0
FAIL=0
SCENARIOS=0

pass() {
  PASS=$((PASS + 1))
  SCENARIOS=$((SCENARIOS + 1))
  printf '  PASS: %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  SCENARIOS=$((SCENARIOS + 1))
  printf '  FAIL: %s\n' "$1" >&2
}

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

# --- Fixture metadata ---
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
      show)
        sp_id=""
        while [[ $# -gt 0 ]]; do
          if [[ "$1" == "--id" ]]; then sp_id="$2"; break; fi
          shift
        done
        if [[ "$sp_id" == "$STUB_RETAINED_SP_OID" ]]; then
          if [[ "${STUB_RETAINED_SP_MISSING:-0}" == "1" ]]; then exit 1; fi
          printf '{"displayName":"%s","id":"%s"}\n' \
            "${STUB_RETAINED_SP_DISPLAY:-betstan-github-sp}" "$sp_id"
        else
          if [[ "${STUB_SP_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
          if [[ "${STUB_CHANGED_OBJECT:-0}" == "1" ]]; then
            printf '{"objectId":"changed-object"}\n'
            exit 0
          fi
          exit 1
        fi
        ;;
      delete)
        if [[ "${STUB_SP_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
        if [[ "${STUB_SP_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
        ;;
      *)
        printf 'unexpected az ad sp subcommand: %s\n' "${3:-}" >&2
        exit 1
        ;;
    esac
    ;;
  "ad app")
    case "${3:-}" in
      delete)
        if [[ "${STUB_APP_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
        ;;
      show)
        if [[ "${STUB_APP_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
        exit 1
        ;;
    esac
    ;;
  "role assignment")
    case "${3:-}" in
      delete) ;;
      list) printf '\n' ;;
    esac
    ;;
  "role definition")
    case "${3:-}" in
      delete)
        if [[ "${STUB_ROLE_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
        ;;
      list) printf '0\n' ;;
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
          if [[ "${STUB_SECRET_STILL_PRESENT:-0}" == "1" ]]; then
            printf 'OCI_MIGRATION_AZURE_CREDENTIALS    Updated 2025-01-01\n'
          else
            printf '\n'
          fi
        else
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
        if [[ "${STUB_WORKFLOW_DISABLE_FAIL:-0}" == "1" ]]; then
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

# --- Stub: jq (pass to real jq) ---
JQ_REAL="$(command -v jq)"
cat > "$BIN_DIR/jq" <<STUB
#!/usr/bin/env bash
exec "$JQ_REAL" "\$@"
STUB
chmod +x "$BIN_DIR/jq"

# --- Helpers ---

run_operator() {
  local mode="$1"
  shift
  local fixture_dir="$1"
  shift
  write_metadata "$fixture_dir"

  local extra_env=()
  while [[ $# -gt 0 ]]; do
    extra_env+=("$1")
    shift
  done

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
  local label="$1"
  local pattern="$2"
  shift 2
  local output
  output="$("$@" 2>&1)" || true
  if echo "$output" | grep -qE "$pattern"; then
    pass "$label"
  else
    fail "$label (pattern: $pattern, got: $(echo "$output" | tail -2))"
  fi
}

expect_fail_with() {
  local label="$1"
  local pattern="$2"
  shift 2
  local output
  if output="$("$@" 2>&1)"; then
    fail "$label (should have failed)"
  else
    if echo "$output" | grep -qE "$pattern"; then
      pass "$label"
    else
      fail "$label (expected: $pattern, got: $(echo "$output" | tail -1))"
    fi
  fi
}

# ==========================================
# TEST SCENARIOS
# ==========================================

printf 'identity_retirement_contract: starting\n'

# --- 1. Successful plan ---
expect_output "successful_plan" \
  "identity_retirement=READY phase=plan" \
  run_operator plan "$WORK_DIR/test-plan"

# --- 2. Successful execute ---
expect_output "successful_execute" \
  "IDENTITY_RETIRED objects_deleted=9" \
  run_operator execute "$WORK_DIR/test-execute"

# --- 3. Successful verify after execute ---
run_operator execute "$WORK_DIR/test-verify-flow" >/dev/null 2>&1 || true
expect_output "successful_verify" \
  "IDENTITY_RETIREMENT_VERIFIED" \
  run_operator verify "$WORK_DIR/test-verify-flow"

# --- 4. Partial deletion / resume (SP delete fails, SP still present) ---
fixture_dir="$WORK_DIR/test-resume"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
if env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" \
  STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  STUB_SP_DELETE_FAIL=1 \
  STUB_CHANGED_OBJECT=1 \
  "$OPERATOR" execute >/dev/null 2>&1; then
  fail "partial_crash_should_fail"
else
  if [[ -f "$fixture_dir/identity-retirement-state.env" ]]; then
    : > "$WORK_DIR/az.log"
    : > "$WORK_DIR/gh.log"
    output="$(env \
      PATH="$BIN_DIR:$PATH" \
      STUB_AZ_LOG="$WORK_DIR/az.log" \
      STUB_GH_LOG="$WORK_DIR/gh.log" \
      STUB_EXPECTED_TENANT="$GUID_TENANT" \
      STUB_EXPECTED_SUB="$GUID_SUB" \
      STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
      IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
      IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
      GH_REPOSITORY="vasilyevstan/betstan" \
      "$OPERATOR" execute 2>&1)" || true
    if echo "$output" | grep -q "IDENTITY_RETIRED"; then
      pass "partial_deletion_resume"
    else
      fail "partial_deletion_resume (output: $output)"
    fi
  else
    fail "partial_deletion_resume (no state file)"
  fi
fi

# --- 5. Already-absent objects ---
expect_output "already_absent_objects" \
  "IDENTITY_RETIRED" \
  run_operator execute "$WORK_DIR/test-absent" \
  STUB_SP_ALREADY_ABSENT=1 STUB_APP_ALREADY_ABSENT=1 STUB_ROLE_ALREADY_ABSENT=1

# --- 6. Wrong subscription ---
expect_fail_with "wrong_subscription" "wrong_subscription" \
  run_operator plan "$WORK_DIR/test-wrong-sub" STUB_WRONG_SUBSCRIPTION=1

# --- 7. Wrong tenant ---
expect_fail_with "wrong_tenant" "wrong_tenant" \
  run_operator plan "$WORK_DIR/test-wrong-tenant" STUB_WRONG_TENANT=1

# --- 8. Changed object identity (SP still present after delete) ---
expect_fail_with "changed_object_identity" "sp_delete_failed" \
  run_operator execute "$WORK_DIR/test-changed-obj" \
  STUB_SP_DELETE_FAIL=1 STUB_CHANGED_OBJECT=1

# --- 9. Missing metadata field ---
fixture_dir="$WORK_DIR/test-missing-field"
mkdir -p "$fixture_dir"
cat > "$fixture_dir/metadata.env" <<META
tenant_id=$GUID_TENANT
subscription_id=$GUID_SUB
migration_app_id=$GUID_MIG_APP
META
chmod 600 "$fixture_dir/metadata.env"
expect_fail_with "missing_metadata_field" "metadata_unknown_or_missing_keys" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 10. Duplicate metadata field ---
fixture_dir="$WORK_DIR/test-dup-field"
write_metadata "$fixture_dir"
printf 'tenant_id=duplicate\n' >> "$fixture_dir/metadata.env"
expect_fail_with "duplicate_metadata_field" \
  "metadata_unknown_or_missing_keys|metadata_missing_or_duplicate_field" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 11. Unknown extra field ---
fixture_dir="$WORK_DIR/test-unknown-field"
write_metadata "$fixture_dir"
printf 'extra_field=injected\n' >> "$fixture_dir/metadata.env"
expect_fail_with "unknown_extra_field" "metadata_unknown_or_missing_keys" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 12. Malformed metadata line ---
fixture_dir="$WORK_DIR/test-malformed"
mkdir -p "$fixture_dir"
printf 'INVALID LINE WITHOUT EQUALS\n' > "$fixture_dir/metadata.env"
chmod 600 "$fixture_dir/metadata.env"
expect_fail_with "malformed_metadata_line" "metadata_malformed_line" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 13. Invalid GUID format ---
fixture_dir="$WORK_DIR/test-bad-guid"
write_metadata "$fixture_dir"
sed -i.bak "s/^tenant_id=.*/tenant_id=not-a-valid-guid/" "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "invalid_guid_format" "metadata_invalid_guid" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 14. Role assignment wrong subscription binding ---
fixture_dir="$WORK_DIR/test-ra-wrong-sub"
write_metadata "$fixture_dir"
sed -i.bak "s|role_assignment_id_1=.*|role_assignment_id_1=/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/$GUID_RA1|" \
  "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "role_assignment_wrong_subscription" \
  "metadata_role_assignment_wrong_subscription" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 15. GitHub secret delete failure (secret still present) ---
expect_fail_with "github_secret_delete_failure" "github_secret_delete_failed" \
  run_operator execute "$WORK_DIR/test-secret-fail" \
  STUB_SECRET_DELETE_FAIL=1 STUB_SECRET_STILL_PRESENT=1

# --- 16. Workflow disable failure ---
expect_fail_with "workflow_disable_failure" "workflow_disable_failed" \
  run_operator execute "$WORK_DIR/test-wf-fail" STUB_WORKFLOW_DISABLE_FAIL=1

# --- 17. Retained SP protection (SP missing) ---
expect_fail_with "retained_sp_missing" "retained_sp_not_found" \
  run_operator plan "$WORK_DIR/test-retained-sp" STUB_RETAINED_SP_MISSING=1

# --- 18. Retained SP displayName mismatch ---
expect_fail_with "retained_sp_display_mismatch" "retained_sp_display_name_mismatch" \
  run_operator plan "$WORK_DIR/test-sp-display" STUB_RETAINED_SP_DISPLAY=wrong-name

# --- 19. Retained secret protection ---
expect_fail_with "retained_secret_missing" "retained_secret_not_found" \
  run_operator plan "$WORK_DIR/test-retained-secret" STUB_RETAINED_SECRET_MISSING=1

# --- 20. Wrong repository ---
fixture_dir="$WORK_DIR/test-wrong-repo"
write_metadata "$fixture_dir"
sed -i.bak 's/repository=vasilyevstan\/betstan/repository=other\/repo/' \
  "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "wrong_repository" "wrong_repository" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 21. Recovery variable not false ---
expect_fail_with "recovery_variable_guard" "recovery_enabled_must_be_false" \
  run_operator plan "$WORK_DIR/test-recovery-var" STUB_RECOVERY_ENABLED=true

# --- 22. ARM epoch variable not zero ---
expect_fail_with "arm_epoch_guard" "arm_epoch_must_be_zero" \
  run_operator plan "$WORK_DIR/test-arm-var" STUB_ARM_EPOCH=1724000000

# --- 23. Symlink metadata rejection ---
fixture_dir="$WORK_DIR/test-symlink"
mkdir -p "$fixture_dir"
write_metadata "$WORK_DIR/test-symlink-source"
ln -sf "$WORK_DIR/test-symlink-source/metadata.env" "$fixture_dir/metadata.env"
expect_fail_with "symlink_metadata_rejection" "metadata_file_missing_or_symlink" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 24. Safe cleanup removes metadata, preserves state ---
fixture_dir="$WORK_DIR/test-cleanup"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
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
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 \
  "$OPERATOR" verify >/dev/null 2>&1 || true
if [[ ! -f "$fixture_dir/metadata.env" && -f "$fixture_dir/identity-retirement-state.env" ]]; then
  pass "safe_cleanup_metadata_removed_state_preserved"
else
  fail "safe_cleanup_metadata_removed_state_preserved"
fi

# --- 25. Metadata retained without cleanup flag ---
fixture_dir="$WORK_DIR/test-no-cleanup"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
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
  "$OPERATOR" verify >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/metadata.env" ]]; then
  pass "metadata_retained_without_cleanup_flag"
else
  fail "metadata_retained_without_cleanup_flag"
fi

# --- 26. Duplicate app IDs rejection ---
fixture_dir="$WORK_DIR/test-dup-app"
write_metadata "$fixture_dir"
sed -i.bak "s/^recovery_app_id=.*/recovery_app_id=$GUID_MIG_APP/" "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "duplicate_app_ids" "metadata_duplicate_app_ids" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 27. Retained SP targeting protection ---
fixture_dir="$WORK_DIR/test-target-retained"
write_metadata "$fixture_dir"
sed -i.bak "s/^migration_sp_object_id=.*/migration_sp_object_id=$GUID_RETAINED_SP/" \
  "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "retained_sp_targeting_protection" \
  "metadata_retained_sp_equals_temporary" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 28. Control characters in metadata values ---
fixture_dir="$WORK_DIR/test-control-chars"
write_metadata "$fixture_dir"
# Inject a tab into tenant_id value
printf 'tenant_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee\tee\n' > "$fixture_dir/metadata-inject.env"
# Build metadata with injected value
sed "1s/.*/$(cat "$fixture_dir/metadata-inject.env")/" \
  "$fixture_dir/metadata.env" > "$fixture_dir/metadata2.env"
mv "$fixture_dir/metadata2.env" "$fixture_dir/metadata.env"
chmod 600 "$fixture_dir/metadata.env"
expect_fail_with "control_chars_rejection" \
  "metadata_malformed_line|metadata_invalid_guid|metadata_control_chars" \
  env PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GUID_TENANT" STUB_EXPECTED_SUB="$GUID_SUB" \
  STUB_RETAINED_SP_OID="$GUID_RETAINED_SP" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  "$OPERATOR" plan

# --- 29. Failure preserves metadata ---
fixture_dir="$WORK_DIR/test-fail-preserves"
write_metadata "$fixture_dir"
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
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 \
  STUB_WORKFLOW_DISABLE_FAIL=1 \
  "$OPERATOR" execute >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/metadata.env" ]]; then
  pass "failure_preserves_metadata"
else
  fail "failure_preserves_metadata"
fi

# ==========================================
# SUMMARY
# ==========================================

printf '\nidentity_retirement_contract=%s scenarios=%d pass=%d fail=%d\n' \
  "$( [[ "$FAIL" -eq 0 ]] && printf 'PASS' || printf 'FAIL' )" \
  "$SCENARIOS" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
