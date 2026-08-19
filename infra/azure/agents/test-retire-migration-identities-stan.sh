#!/usr/bin/env bash
set -euo pipefail

# Test contract for retire-temporary-identity-stan.sh
# Covers: success plan/execute/verify, partial deletion/resume, already-absent,
# wrong scope, changed object identity, missing/duplicate fields,
# GitHub secret/workflow failures, and retained identity protection.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATOR="$ROOT_DIR/infra/azure/agents/retire-migration-identities-stan.sh"
WORK_DIR="$ROOT_DIR/infra/azure/agents/.identity-retirement-fixture-work"
BIN_DIR="$WORK_DIR/bin"

rm -rf "$WORK_DIR"
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

# --- Fixture metadata ---
write_metadata() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/metadata.env" <<'META'
tenant_id=tenant-fixture-001
subscription_id=sub-fixture-001
migration_app_id=app-migration-001
recovery_app_id=app-recovery-002
migration_sp_object_id=sp-migration-obj-001
recovery_sp_object_id=sp-recovery-obj-002
role_assignment_id_1=/subscriptions/sub-fixture-001/providers/Microsoft.Authorization/roleAssignments/ra-001
role_assignment_id_2=/subscriptions/sub-fixture-001/providers/Microsoft.Authorization/roleAssignments/ra-002
role_assignment_id_3=/subscriptions/sub-fixture-001/providers/Microsoft.Authorization/roleAssignments/ra-003
custom_role_id_1=custom-role-migration-001
custom_role_id_2=custom-role-recovery-002
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
      if [[ "$*" == *tenantId* ]]; then
        printf 'wrong-tenant\n'
      else
        printf 'wrong-sub\n'
      fi
    elif [[ "${STUB_WRONG_TENANT:-0}" == "1" ]]; then
      if [[ "$*" == *tenantId* ]]; then
        printf 'wrong-tenant\n'
      else
        printf 'sub-fixture-001\n'
      fi
    else
      if [[ "$*" == *tenantId* ]]; then
        printf 'tenant-fixture-001\n'
      else
        printf 'sub-fixture-001\n'
      fi
    fi
    ;;
  "ad sp")
    case "${3:-}" in
      list)
        if [[ "${STUB_RETAINED_SP_MISSING:-0}" == "1" ]]; then
          printf '\n'
        else
          printf 'betstan-github-sp\n'
        fi
        ;;
      delete)
        sp_id=""
        while [[ $# -gt 0 ]]; do
          if [[ "$1" == "--id" ]]; then sp_id="$2"; break; fi
          shift
        done
        if [[ "${STUB_SP_DELETE_FAIL:-0}" == "1" ]]; then
          exit 1
        fi
        if [[ "${STUB_SP_ALREADY_ABSENT:-0}" == "1" ]]; then
          exit 1
        fi
        ;;
      show)
        sp_id=""
        while [[ $# -gt 0 ]]; do
          if [[ "$1" == "--id" ]]; then sp_id="$2"; break; fi
          shift
        done
        if [[ "${STUB_SP_ALREADY_ABSENT:-0}" == "1" ]]; then
          exit 1
        fi
        if [[ "${STUB_CHANGED_OBJECT:-0}" == "1" ]]; then
          printf '{"objectId":"changed-object"}\n'
          exit 0
        fi
        exit 1
        ;;
    esac
    ;;
  "ad app")
    case "${3:-}" in
      delete)
        if [[ "${STUB_APP_ALREADY_ABSENT:-0}" == "1" ]]; then
          exit 1
        fi
        ;;
      show)
        if [[ "${STUB_APP_ALREADY_ABSENT:-0}" == "1" ]]; then
          exit 1
        fi
        exit 1
        ;;
    esac
    ;;
  "role assignment")
    case "${3:-}" in
      delete)
        if [[ "${STUB_RA_CRASH:-0}" == "1" ]]; then
          exit 99
        fi
        ;;
      list)
        printf '\n'
        ;;
    esac
    ;;
  "role definition")
    case "${3:-}" in
      delete)
        if [[ "${STUB_ROLE_ALREADY_ABSENT:-0}" == "1" ]]; then
          exit 1
        fi
        ;;
      list)
        printf '0\n'
        ;;
    esac
    ;;
  *)
    printf 'unexpected az call: %s\n' "$*" >&2
    exit 1
    ;;
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
        if [[ "${STUB_RETAINED_SECRET_MISSING:-0}" == "1" ]]; then
          printf '\n'
        elif [[ "$*" == *"--env"* ]]; then
          # Environment secret list (for verify absent checks)
          if [[ "${STUB_SECRET_STILL_PRESENT:-0}" == "1" ]]; then
            printf 'OCI_MIGRATION_AZURE_CREDENTIALS\n'
          else
            printf '\n'
          fi
        else
          printf 'AZURE_CREDENTIALS\n'
        fi
        ;;
      delete)
        if [[ "${STUB_SECRET_DELETE_FAIL:-0}" == "1" ]]; then
          exit 1
        fi
        ;;
    esac
    ;;
  workflow)
    case "${2:-}" in
      disable)
        if [[ "${STUB_WORKFLOW_DISABLE_FAIL:-0}" == "1" ]]; then
          exit 1
        fi
        ;;
      view)
        if [[ "${STUB_WORKFLOW_DISABLE_FAIL:-0}" == "1" ]]; then
          printf '{"state":"active"}\n'
        else
          printf 'disabled_manually\n'
        fi
        ;;
    esac
    ;;
  *)
    printf 'unexpected gh call: %s\n' "$*" >&2
    exit 1
    ;;
esac
STUB
chmod +x "$BIN_DIR/gh"

# --- Stub: jq (pass through to real jq) ---
cat > "$BIN_DIR/jq" <<'STUB'
#!/usr/bin/env bash
exec /usr/bin/env jq "$@" 2>/dev/null || exec jq "$@"
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
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    GH_REPOSITORY="vasilyevstan/betstan" \
    RECOVERY_ENABLED=false \
    ARM_COUNT=0 \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 \
    ${extra_env[@]+"${extra_env[@]}"} \
    "$OPERATOR" "$mode"
}

expect_pass() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$label"
  else
    fail "$label"
  fi
}

expect_fail() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "$label (should have failed)"
  else
    pass "$label"
  fi
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
    fail "$label (expected pattern: $pattern)"
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

# --- 4. Partial deletion / resume ---
# Simulate failure during SP deletion (SP still present = genuine failure),
# then resume successfully after transient issue resolves
fixture_dir="$WORK_DIR/test-resume"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
if env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  STUB_SP_DELETE_FAIL=1 \
  STUB_CHANGED_OBJECT=1 \
  "$OPERATOR" execute >/dev/null 2>&1; then
  fail "partial_crash_should_fail"
else
  # State file should exist with partial phase
  if [[ -f "$fixture_dir/identity-retirement-state.env" ]]; then
    # Resume without failure
    : > "$WORK_DIR/az.log"
    : > "$WORK_DIR/gh.log"
    output="$(env \
      PATH="$BIN_DIR:$PATH" \
      STUB_AZ_LOG="$WORK_DIR/az.log" \
      STUB_GH_LOG="$WORK_DIR/gh.log" \
      IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
      IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
      GH_REPOSITORY="vasilyevstan/betstan" \
      RECOVERY_ENABLED=false \
      ARM_COUNT=0 \
      "$OPERATOR" execute 2>&1)" || true
    if echo "$output" | grep -q "IDENTITY_RETIRED"; then
      pass "partial_deletion_resume"
    else
      fail "partial_deletion_resume"
    fi
  else
    fail "partial_deletion_resume (no state file)"
  fi
fi

# --- 5. Already-absent objects ---
expect_output "already_absent_sps" \
  "IDENTITY_RETIRED" \
  run_operator execute "$WORK_DIR/test-absent" \
  STUB_SP_ALREADY_ABSENT=1 STUB_APP_ALREADY_ABSENT=1 STUB_ROLE_ALREADY_ABSENT=1

# --- 6. Wrong subscription ---
expect_fail "wrong_subscription" \
  run_operator plan "$WORK_DIR/test-wrong-sub" STUB_WRONG_SUBSCRIPTION=1

# --- 7. Wrong tenant ---
expect_fail "wrong_tenant" \
  run_operator plan "$WORK_DIR/test-wrong-tenant" STUB_WRONG_TENANT=1

# --- 8. Changed object identity (SP still present after delete attempt) ---
fixture_dir="$WORK_DIR/test-changed-object"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  STUB_SP_DELETE_FAIL=1 \
  STUB_CHANGED_OBJECT=1 \
  "$OPERATOR" execute 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*sp_delete_failed"; then
  pass "changed_object_identity"
else
  fail "changed_object_identity"
fi

# --- 9. Missing metadata field ---
fixture_dir="$WORK_DIR/test-missing-field"
mkdir -p "$fixture_dir"
cat > "$fixture_dir/metadata.env" <<'META'
tenant_id=tenant-fixture-001
subscription_id=sub-fixture-001
migration_app_id=app-migration-001
META
chmod 600 "$fixture_dir/metadata.env"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  "$OPERATOR" plan 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*metadata_missing_or_duplicate_field"; then
  pass "missing_metadata_field"
else
  fail "missing_metadata_field"
fi

# --- 10. Duplicate metadata field ---
fixture_dir="$WORK_DIR/test-duplicate-field"
mkdir -p "$fixture_dir"
write_metadata "$fixture_dir"
# Add duplicate field
printf 'tenant_id=duplicate\n' >> "$fixture_dir/metadata.env"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  "$OPERATOR" plan 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*metadata_missing_or_duplicate_field"; then
  pass "duplicate_metadata_field"
else
  fail "duplicate_metadata_field"
fi

# --- 11. GitHub secret delete failure ---
fixture_dir="$WORK_DIR/test-secret-fail"
write_metadata "$fixture_dir"
# First run execute to get to secrets-intent state, then fail on secret delete
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  STUB_SECRET_DELETE_FAIL=1 \
  STUB_SECRET_STILL_PRESENT=1 \
  "$OPERATOR" execute 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*github_secret_delete_failed"; then
  pass "github_secret_delete_failure"
else
  fail "github_secret_delete_failure"
fi

# --- 12. Workflow disable failure ---
fixture_dir="$WORK_DIR/test-workflow-fail"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  STUB_WORKFLOW_DISABLE_FAIL=1 \
  "$OPERATOR" execute 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*workflow_disable_failed"; then
  pass "workflow_disable_failure"
else
  fail "workflow_disable_failure"
fi

# --- 13. Retained identity protection (SP missing) ---
expect_fail "retained_sp_protection" \
  run_operator plan "$WORK_DIR/test-retained-sp" STUB_RETAINED_SP_MISSING=1

# --- 14. Retained identity protection (secret missing) ---
expect_fail "retained_secret_protection" \
  run_operator plan "$WORK_DIR/test-retained-secret" STUB_RETAINED_SECRET_MISSING=1

# --- 15. Wrong repository ---
fixture_dir="$WORK_DIR/test-wrong-repo"
write_metadata "$fixture_dir"
# Override repository in metadata to wrong value
sed -i.bak 's/repository=vasilyevstan\/betstan/repository=other\/repo/' \
  "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  "$OPERATOR" plan 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*wrong_repository"; then
  pass "wrong_repository"
else
  fail "wrong_repository"
fi

# --- 16. Recovery enabled guard ---
fixture_dir="$WORK_DIR/test-recovery-enabled"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=true \
  ARM_COUNT=0 \
  "$OPERATOR" plan 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*recovery_must_be_disabled"; then
  pass "recovery_enabled_guard"
else
  fail "recovery_enabled_guard"
fi

# --- 17. ARM count guard ---
fixture_dir="$WORK_DIR/test-arm-count"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=5 \
  "$OPERATOR" plan 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*arm_count_must_be_zero"; then
  pass "arm_count_guard"
else
  fail "arm_count_guard"
fi

# --- 18. Symlink metadata rejection ---
fixture_dir="$WORK_DIR/test-symlink"
mkdir -p "$fixture_dir"
write_metadata "$WORK_DIR/test-symlink-source"
ln -sf "$WORK_DIR/test-symlink-source/metadata.env" "$fixture_dir/metadata.env"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  "$OPERATOR" plan 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*metadata_file_missing_or_symlink"; then
  pass "symlink_metadata_rejection"
else
  fail "symlink_metadata_rejection"
fi

# --- 19. Safe cleanup flag ---
fixture_dir="$WORK_DIR/test-cleanup"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 \
  "$OPERATOR" verify >/dev/null 2>&1 || true
if [[ ! -f "$fixture_dir/metadata.env" ]]; then
  pass "safe_cleanup_removes_metadata"
else
  fail "safe_cleanup_removes_metadata"
fi

# --- 20. Metadata retained without cleanup flag ---
fixture_dir="$WORK_DIR/test-no-cleanup"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 \
  "$OPERATOR" verify >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/metadata.env" ]]; then
  pass "metadata_retained_without_cleanup_flag"
else
  fail "metadata_retained_without_cleanup_flag"
fi

# --- 21. Duplicate app IDs rejection ---
fixture_dir="$WORK_DIR/test-dup-app"
mkdir -p "$fixture_dir"
write_metadata "$fixture_dir"
sed -i.bak 's/recovery_app_id=app-recovery-002/recovery_app_id=app-migration-001/' \
  "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
: > "$WORK_DIR/az.log"
: > "$WORK_DIR/gh.log"
output="$(env \
  PATH="$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" \
  STUB_GH_LOG="$WORK_DIR/gh.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  GH_REPOSITORY="vasilyevstan/betstan" \
  RECOVERY_ENABLED=false \
  ARM_COUNT=0 \
  "$OPERATOR" plan 2>&1)" || true
if echo "$output" | grep -q "NO_GO.*metadata_duplicate_app_ids"; then
  pass "duplicate_app_ids_rejection"
else
  fail "duplicate_app_ids_rejection"
fi

# ==========================================
# SUMMARY
# ==========================================

printf '\nidentity_retirement_contract=%s scenarios=%d pass=%d fail=%d\n' \
  "$( [[ "$FAIL" -eq 0 ]] && printf 'PASS' || printf 'FAIL' )" \
  "$SCENARIOS" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
