#!/usr/bin/env bash
set -euo pipefail

# Test contract for retire-migration-identities-stan.sh
# Validates fail-closed probes, relationship verification, and all guards.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATOR="$ROOT_DIR/infra/azure/agents/retire-migration-identities-stan.sh"
WORK_DIR="$ROOT_DIR/infra/azure/agents/.test-workdirs/identity-retirement-$$-$(date +%s)"
BIN_DIR="$WORK_DIR/bin"

mkdir -p "$BIN_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

PASS=0; FAIL=0; SCENARIOS=0
pass() { PASS=$((PASS+1)); SCENARIOS=$((SCENARIOS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); SCENARIOS=$((SCENARIOS+1)); printf '  FAIL: %s\n' "$1" >&2; }

# --- GUIDs ---
GT="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
GS="11111111-2222-3333-4444-555555555555"
G_MA="22222222-3333-4444-5555-666666666666"
G_RA="33333333-4444-5555-6666-777777777777"
G_MS="44444444-5555-6666-7777-888888888888"
G_RS="55555555-6666-7777-8888-999999999999"
G_RET="66666666-7777-8888-9999-aaaaaaaaaaaa"
G_CR1="77777777-8888-9999-aaaa-bbbbbbbbbbbb"
G_CR2="88888888-9999-aaaa-bbbb-cccccccccccc"
G_RA1="99999999-aaaa-bbbb-cccc-dddddddddddd"
G_RA2="aaaaaaaa-bbbb-cccc-dddd-111111111111"
G_RA3="bbbbbbbb-cccc-dddd-eeee-222222222222"

RA_ID_1="/subscriptions/$GS/providers/Microsoft.Authorization/roleAssignments/$G_RA1"
RA_ID_2="/subscriptions/$GS/providers/Microsoft.Authorization/roleAssignments/$G_RA2"
RA_ID_3="/subscriptions/$GS/providers/Microsoft.Authorization/roleAssignments/$G_RA3"
RD_1="/subscriptions/$GS/providers/Microsoft.Authorization/roleDefinitions/$G_CR1"
RD_2="/subscriptions/$GS/providers/Microsoft.Authorization/roleDefinitions/$G_CR2"
RD_3="/subscriptions/$GS/providers/Microsoft.Authorization/roleDefinitions/$G_CR1"
SCOPE="/subscriptions/$GS"

write_metadata() {
  local dir="$1"; mkdir -p "$dir"
  cat > "$dir/metadata.env" <<META
tenant_id=$GT
subscription_id=$GS
migration_app_id=$G_MA
recovery_app_id=$G_RA
migration_sp_object_id=$G_MS
recovery_sp_object_id=$G_RS
retained_sp_object_id=$G_RET
role_assignment_id_1=$RA_ID_1
role_assignment_id_2=$RA_ID_2
role_assignment_id_3=$RA_ID_3
role_assignment_1_principal_id=$G_MS
role_assignment_1_role_definition_id=$RD_1
role_assignment_1_scope=$SCOPE
role_assignment_2_principal_id=$G_RS
role_assignment_2_role_definition_id=$RD_2
role_assignment_2_scope=$SCOPE
role_assignment_3_principal_id=$G_MS
role_assignment_3_role_definition_id=$RD_3
role_assignment_3_scope=$SCOPE
custom_role_id_1=$G_CR1
custom_role_id_2=$G_CR2
custom_role_1_assignable_scope=$SCOPE
custom_role_2_assignable_scope=$SCOPE
migration_environment=oci-migration
recovery_environment=azure-migration-recovery
retained_sp_display_name=betstan-github-sp
retained_secret_name=AZURE_CREDENTIALS
repository=vasilyevstan/betstan
META
  chmod 600 "$dir/metadata.env"
}

# --- Stub: az ---
JQ_REAL="$(command -v jq)"
cat > "$BIN_DIR/az" <<STUB
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "\${STUB_AZ_LOG:?}"

case "\${1:-} \${2:-}" in
  "account show")
    if [[ "\${STUB_WRONG_SUBSCRIPTION:-0}" == "1" ]]; then
      if [[ "\$*" == *tenantId* ]]; then printf 'wrong-t\n'; else printf 'wrong-s\n'; fi
    elif [[ "\${STUB_WRONG_TENANT:-0}" == "1" ]]; then
      if [[ "\$*" == *tenantId* ]]; then printf 'wrong-t\n'; else printf '%s\n' "\$STUB_EXPECTED_SUB"; fi
    else
      if [[ "\$*" == *tenantId* ]]; then printf '%s\n' "\$STUB_EXPECTED_TENANT"; else printf '%s\n' "\$STUB_EXPECTED_SUB"; fi
    fi
    ;;
  "ad sp")
    case "\${3:-}" in
      list)
        if [[ "\$*" == *"$G_RET"* ]]; then
          # Retained SP branch
          if [[ "\${STUB_RETAINED_SP_MISSING:-0}" == "1" ]]; then
            if [[ "\$*" == *"length"* ]]; then printf '0\n'; else printf '[]\n'; fi
          elif [[ "\${STUB_PROBE_RETAINED_SP_FAIL:-0}" == "1" ]]; then
            printf 'AuthError\n' >&2; exit 1
          else
            if [[ "\$*" == *"length"* ]]; then printf '1\n'
            elif [[ "\$*" == *"appId"* ]]; then printf '%s\n' "$G_RET"
            elif [[ "\$*" == *"json"* ]]; then
              printf '[{"displayName":"%s","id":"%s"}]\n' "\${STUB_RETAINED_SP_DISPLAY:-betstan-github-sp}" "$G_RET"
            else
              printf '[{"displayName":"%s","id":"%s"}]\n' "\${STUB_RETAINED_SP_DISPLAY:-betstan-github-sp}" "$G_RET"
            fi
          fi
        else
          # Temporary SP branch
          if [[ "\${STUB_PROBE_SP_FAIL:-0}" == "1" ]]; then printf 'Err\n' >&2; exit 1; fi
          if [[ "\${STUB_SP_ALREADY_ABSENT:-0}" == "1" ]]; then
            if [[ "\$*" == *"length"* ]]; then printf '0\n'
            elif [[ "\$*" == *"appId"* ]]; then printf '\n'
            else printf '0\n'; fi
          elif [[ "\${STUB_SP_WRONG_APP:-0}" == "1" ]]; then
            if [[ "\$*" == *"length"* ]]; then printf '1\n'
            elif [[ "\$*" == *"appId"* ]]; then printf 'deadbeef-0000-0000-0000-000000000000\n'
            else printf '1\n'; fi
          else
            # Present with correct appId
            if [[ "\$*" == *"length"* ]]; then printf '1\n'
            elif [[ "\$*" == *"appId"* ]]; then
              if [[ "\$*" == *"$G_MS"* ]]; then printf '%s\n' "$G_MA"
              else printf '%s\n' "$G_RA"
              fi
            else printf '1\n'; fi
          fi
        fi
        ;;
      delete)
        if [[ "\${STUB_SP_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
        if [[ "\${STUB_SP_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
        ;;
      *) printf 'unexpected az ad sp: %s\n' "\${3:-}" >&2; exit 1 ;;
    esac
    ;;
  "ad app")
    case "\${3:-}" in
      list)
        if [[ "\${STUB_PROBE_APP_FAIL:-0}" == "1" ]]; then printf 'Err\n' >&2; exit 1; fi
        printf '0\n'
        ;;
      delete)
        if [[ "\${STUB_APP_ALREADY_ABSENT:-0}" == "1" ]]; then exit 1; fi
        ;;
      *) printf 'unexpected az ad app: %s\n' "\${3:-}" >&2; exit 1 ;;
    esac
    ;;
  "role assignment")
    case "\${3:-}" in
      list)
        if [[ "\${STUB_PROBE_RA_FAIL:-0}" == "1" ]]; then printf 'Err\n' >&2; exit 1; fi
        if [[ "\${STUB_RA_STILL_PRESENT:-0}" == "1" ]]; then
          if [[ "\$*" == *"length"* ]]; then printf '1\n'
          else
            if [[ "\${STUB_RA_WRONG_PRINCIPAL:-0}" == "1" ]]; then
              printf '{"principalId":"wrong-guid-0000-0000-0000-000000000000","roleDefinitionId":"%s","scope":"%s"}\n' "$RD_1" "$SCOPE"
            elif [[ "\${STUB_RA_WRONG_ROLE:-0}" == "1" ]]; then
              printf '{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-000000000000","scope":"%s"}\n' "$G_MS" "$GS" "$SCOPE"
            elif [[ "\${STUB_RA_WRONG_SCOPE:-0}" == "1" ]]; then
              printf '{"principalId":"%s","roleDefinitionId":"%s","scope":"/subscriptions/00000000-0000-0000-0000-000000000000"}\n' "$G_MS" "$RD_1"
            else
              if [[ "\$*" == *"$G_RA1"* ]]; then
                printf '{"principalId":"%s","roleDefinitionId":"%s","scope":"%s"}\n' "$G_MS" "$RD_1" "$SCOPE"
              elif [[ "\$*" == *"$G_RA2"* ]]; then
                printf '{"principalId":"%s","roleDefinitionId":"%s","scope":"%s"}\n' "$G_RS" "$RD_2" "$SCOPE"
              else
                printf '{"principalId":"%s","roleDefinitionId":"%s","scope":"%s"}\n' "$G_MS" "$RD_3" "$SCOPE"
              fi
            fi
          fi
        else
          if [[ "\$*" == *"length"* ]]; then printf '0\n'
          else printf 'null\n'; fi
        fi
        ;;
      delete)
        if [[ "\${STUB_RA_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
        ;;
      *) printf 'unexpected az role assignment: %s\n' "\${3:-}" >&2; exit 1 ;;
    esac
    ;;
  "role definition")
    case "\${3:-}" in
      list)
        if [[ "\${STUB_PROBE_ROLE_FAIL:-0}" == "1" ]]; then printf 'Err\n' >&2; exit 1; fi
        if [[ "\${STUB_ROLE_STILL_PRESENT:-0}" == "1" ]]; then
          if [[ "\$*" == *"length"* ]]; then printf '1\n'
          else
            if [[ "\${STUB_CR_WRONG_SCOPE:-0}" == "1" ]]; then
              printf '{"name":"%s","assignableScopes":["/subscriptions/00000000-0000-0000-0000-000000000000"]}\n' "$G_CR1"
            elif [[ "\${STUB_CR_WRONG_ID:-0}" == "1" ]]; then
              printf '{"name":"wrong-id","assignableScopes":["%s"]}\n' "$SCOPE"
            else
              if [[ "\$*" == *"$G_CR1"* ]]; then
                printf '{"name":"%s","assignableScopes":["%s"]}\n' "$G_CR1" "$SCOPE"
              else
                printf '{"name":"%s","assignableScopes":["%s"]}\n' "$G_CR2" "$SCOPE"
              fi
            fi
          fi
        else
          printf '0\n'
        fi
        ;;
      delete)
        if [[ "\${STUB_ROLE_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
        ;;
      *) printf 'unexpected az role definition: %s\n' "\${3:-}" >&2; exit 1 ;;
    esac
    ;;
  *) printf 'unexpected az: %s\n' "\$*" >&2; exit 1 ;;
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
          if [[ "${STUB_PROBE_SECRET_FAIL:-0}" == "1" ]]; then printf 'Err\n' >&2; exit 1; fi
          if [[ "${STUB_SECRET_STILL_PRESENT:-0}" == "1" ]]; then
            printf 'OCI_MIGRATION_AZURE_CREDENTIALS    Updated 2025-01-01\n'
            printf 'AZURE_MIGRATION_RECOVERY_CREDENTIALS    Updated 2025-01-01\n'
          else printf '\n'; fi
        else
          if [[ "${STUB_PROBE_REPO_SECRET_FAIL:-0}" == "1" ]]; then printf 'Err\n' >&2; exit 1; fi
          if [[ "${STUB_RETAINED_SECRET_MISSING:-0}" == "1" ]]; then printf 'OTHER    Updated 2025-01-01\n'
          else printf 'AZURE_CREDENTIALS    Updated 2025-01-01\n'; fi
        fi ;;
      delete)
        if [[ "${STUB_SECRET_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi ;;
    esac ;;
  variable)
    case "${2:-}" in
      get)
        # Discriminate repo-scoped vs env-scoped
        if [[ "$*" == *"--env"* ]]; then
          # Environment-scoped variable query
          if [[ "${3:-}" == "OCI_MIGRATION_RECOVERY_ENABLED" ]]; then
            printf '%s\n' "${STUB_RECOVERY_ENABLED_ENV:-${STUB_RECOVERY_ENABLED:-false}}"
          elif [[ "${3:-}" == "OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH" ]]; then
            printf '%s\n' "${STUB_ARM_EPOCH_ENV:-${STUB_ARM_EPOCH:-0}}"
          else exit 1; fi
        else
          # Repository-scoped variable query
          if [[ "${3:-}" == "OCI_MIGRATION_RECOVERY_ENABLED" ]]; then
            printf '%s\n' "${STUB_RECOVERY_ENABLED_REPO:-${STUB_RECOVERY_ENABLED:-false}}"
          elif [[ "${3:-}" == "OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH" ]]; then
            printf '%s\n' "${STUB_ARM_EPOCH_REPO:-${STUB_ARM_EPOCH:-0}}"
          else exit 1; fi
        fi ;;
      set) ;;
    esac ;;
  workflow)
    case "${2:-}" in
      disable)
        if [[ "${STUB_WORKFLOW_DISABLE_FAIL:-0}" == "1" ]]; then exit 1; fi ;;
      view)
        if [[ "${STUB_PROBE_WORKFLOW_FAIL:-0}" == "1" ]]; then printf 'Err\n' >&2; exit 1; fi
        if [[ "${STUB_WORKFLOW_DISABLE_FAIL:-0}" == "1" ]]; then printf 'active\n'
        else printf 'disabled_manually\n'; fi ;;
    esac ;;
  *) printf 'unexpected gh: %s\n' "$*" >&2; exit 1 ;;
esac
STUB
chmod +x "$BIN_DIR/gh"

# --- Stub: jq (passthrough to real) ---
cat > "$BIN_DIR/jq" <<JQSTUB
#!/usr/bin/env bash
exec "$JQ_REAL" "\$@"
JQSTUB
chmod +x "$BIN_DIR/jq"

# --- Helpers ---
run_operator() {
  local mode="$1"; shift; local fixture_dir="$1"; shift
  write_metadata "$fixture_dir"
  local extra_env=()
  while [[ $# -gt 0 ]]; do extra_env+=("$1"); shift; done
  : > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 \
    ${extra_env[@]+"${extra_env[@]}"} "$OPERATOR" "$mode"
}

expect_output() {
  local l="$1" p="$2"; shift 2; local o
  o="$("$@" 2>&1)" || true
  if echo "$o" | grep -qE "$p"; then pass "$l"; else fail "$l (got: $(echo "$o"|head -3|tail -1))"; fi
}
expect_fail_with() {
  local l="$1" p="$2"; shift 2; local o
  if o="$("$@" 2>&1)"; then fail "$l (should fail)"
  elif echo "$o"|grep -qE "$p"; then pass "$l"
  else fail "$l (got: $(echo "$o"|head -3|tail -1))"; fi
}

# ==========================================
printf 'identity_retirement_contract: starting\n'

# --- Core success ---
expect_output "successful_plan" "identity_retirement=READY" \
  run_operator plan "$WORK_DIR/t-plan" STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1

expect_output "successful_execute" "IDENTITY_RETIRED" \
  run_operator execute "$WORK_DIR/t-exec"

# Verify needs objects absent (execute deleted them)
fixture_dir="$WORK_DIR/t-vflow"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
expect_output "successful_verify" "IDENTITY_RETIREMENT_VERIFIED" \
  run_operator verify "$fixture_dir" STUB_SP_ALREADY_ABSENT=1

# --- Partial/resume ---
fixture_dir="$WORK_DIR/t-resume"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 STUB_SP_DELETE_FAIL=1 \
  "$OPERATOR" execute >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/identity-retirement-state.env" ]]; then
  o="$(run_operator execute "$fixture_dir" 2>&1)" || true
  if echo "$o"|grep -q "IDENTITY_RETIRED"; then pass "partial_resume"; else fail "partial_resume (output: $o)"; fi
else fail "partial_resume (no state file)"; fi

# --- Already-absent ---
expect_output "already_absent" "IDENTITY_RETIRED" \
  run_operator execute "$WORK_DIR/t-abs" STUB_SP_ALREADY_ABSENT=1 STUB_APP_ALREADY_ABSENT=1

# --- Scope errors ---
expect_fail_with "wrong_subscription" "wrong_subscription" run_operator plan "$WORK_DIR/t-ws" STUB_WRONG_SUBSCRIPTION=1
expect_fail_with "wrong_tenant" "wrong_tenant" run_operator plan "$WORK_DIR/t-wt" STUB_WRONG_TENANT=1

# --- Relationship failures ---
expect_fail_with "sp_app_id_mismatch" "sp_app_id_mismatch" \
  run_operator plan "$WORK_DIR/t-sp-mismatch" STUB_SP_WRONG_APP=1 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1

expect_fail_with "ra_principal_mismatch" "ra_principal_mismatch" \
  run_operator plan "$WORK_DIR/t-ra-princ" STUB_RA_STILL_PRESENT=1 STUB_RA_WRONG_PRINCIPAL=1 STUB_ROLE_STILL_PRESENT=1

expect_fail_with "ra_role_definition_mismatch" "ra_role_definition_mismatch" \
  run_operator plan "$WORK_DIR/t-ra-role" STUB_RA_STILL_PRESENT=1 STUB_RA_WRONG_ROLE=1 STUB_ROLE_STILL_PRESENT=1

expect_fail_with "ra_scope_mismatch" "ra_scope_mismatch" \
  run_operator plan "$WORK_DIR/t-ra-scope" STUB_RA_STILL_PRESENT=1 STUB_RA_WRONG_SCOPE=1 STUB_ROLE_STILL_PRESENT=1

expect_fail_with "custom_role_id_mismatch" "custom_role_id_mismatch" \
  run_operator plan "$WORK_DIR/t-cr-id" STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1 STUB_CR_WRONG_ID=1

expect_fail_with "custom_role_scope_mismatch" "custom_role_scope_mismatch" \
  run_operator plan "$WORK_DIR/t-cr-scope" STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1 STUB_CR_WRONG_SCOPE=1

# --- Metadata errors ---
fixture_dir="$WORK_DIR/t-malformed"; mkdir -p "$fixture_dir"
printf 'NOT VALID\n' > "$fixture_dir/metadata.env"; chmod 600 "$fixture_dir/metadata.env"
expect_fail_with "malformed_line" "metadata_malformed_line" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-badguid"; write_metadata "$fixture_dir"
sed -i.bak "s/^tenant_id=.*/tenant_id=bad/" "$fixture_dir/metadata.env"; rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "invalid_guid" "metadata_invalid_guid" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

# --- GitHub failures ---
expect_fail_with "secret_delete_fail" "github_secret_delete_failed" \
  run_operator execute "$WORK_DIR/t-sf" STUB_SECRET_DELETE_FAIL=1 STUB_SECRET_STILL_PRESENT=1

expect_fail_with "workflow_disable_fail" "workflow_disable_failed" \
  run_operator execute "$WORK_DIR/t-wdf" STUB_WORKFLOW_DISABLE_FAIL=1

# --- Retained identity ---
expect_fail_with "retained_sp_missing" "retained_sp_not_found" run_operator plan "$WORK_DIR/t-rsm" STUB_RETAINED_SP_MISSING=1
expect_fail_with "retained_sp_display" "retained_sp_display_name_mismatch" run_operator plan "$WORK_DIR/t-rsd" STUB_RETAINED_SP_DISPLAY=wrong
expect_fail_with "retained_secret_missing" "retained_secret_not_found" run_operator plan "$WORK_DIR/t-rsec" STUB_RETAINED_SECRET_MISSING=1

# --- Guards ---
expect_fail_with "recovery_guard" "recovery_enabled_must_be_false" run_operator plan "$WORK_DIR/t-rec" STUB_RECOVERY_ENABLED=true
expect_fail_with "arm_guard" "arm_epoch_must_be_zero" run_operator plan "$WORK_DIR/t-arm" STUB_ARM_EPOCH=999

# Scope-specific: env-only override (repo false but env true)
expect_fail_with "recovery_guard_env_only" "recovery_enabled_must_be_false:scope=env" \
  run_operator plan "$WORK_DIR/t-rec-env" STUB_RECOVERY_ENABLED_REPO=false STUB_RECOVERY_ENABLED_ENV=true
expect_fail_with "arm_guard_env_only" "arm_epoch_must_be_zero:scope=env" \
  run_operator plan "$WORK_DIR/t-arm-env" STUB_ARM_EPOCH_REPO=0 STUB_ARM_EPOCH_ENV=42
# Scope-specific: repo-only (repo true but env false)
expect_fail_with "recovery_guard_repo_only" "recovery_enabled_must_be_false:scope=repo" \
  run_operator plan "$WORK_DIR/t-rec-repo" STUB_RECOVERY_ENABLED_REPO=true STUB_RECOVERY_ENABLED_ENV=false
expect_fail_with "arm_guard_repo_only" "arm_epoch_must_be_zero:scope=repo" \
  run_operator plan "$WORK_DIR/t-arm-repo" STUB_ARM_EPOCH_REPO=7 STUB_ARM_EPOCH_ENV=0

# --- Symlink ---
fixture_dir="$WORK_DIR/t-sym"; mkdir -p "$fixture_dir"
write_metadata "$WORK_DIR/t-sym-src"
ln -sf "$WORK_DIR/t-sym-src/metadata.env" "$fixture_dir/metadata.env"
expect_fail_with "symlink_rejection" "metadata_file_missing_or_symlink" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

# --- Cleanup semantics ---
fixture_dir="$WORK_DIR/t-clean"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 STUB_SP_ALREADY_ABSENT=1 \
  "$OPERATOR" verify >/dev/null 2>&1 || true
if [[ ! -f "$fixture_dir/metadata.env" && -f "$fixture_dir/identity-retirement-state.env" ]]; then
  pass "safe_cleanup"
else fail "safe_cleanup (metadata=$(test -f "$fixture_dir/metadata.env" && echo present || echo absent) state=$(test -f "$fixture_dir/identity-retirement-state.env" && echo present || echo absent))"; fi

fixture_dir="$WORK_DIR/t-noclean"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 STUB_SP_ALREADY_ABSENT=1 \
  "$OPERATOR" verify >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/metadata.env" ]]; then pass "metadata_retained"; else fail "metadata_retained"; fi

# --- Duplicate/targeting ---
fixture_dir="$WORK_DIR/t-dup"; write_metadata "$fixture_dir"
sed -i.bak "s/^recovery_app_id=.*/recovery_app_id=$G_MA/" "$fixture_dir/metadata.env"; rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "dup_app_ids" "metadata_duplicate_app_ids" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-tgt"; write_metadata "$fixture_dir"
sed -i.bak "s/^migration_sp_object_id=.*/migration_sp_object_id=$G_RET/" "$fixture_dir/metadata.env"; rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "target_retained" "metadata_retained_sp_equals_temporary" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

# --- Failure preserves metadata ---
fixture_dir="$WORK_DIR/t-fpres"; write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 STUB_WORKFLOW_DISABLE_FAIL=1 \
  "$OPERATOR" execute >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/metadata.env" ]]; then pass "fail_preserves_metadata"; else fail "fail_preserves_metadata"; fi

# --- Fail-closed regressions ---
printf '\n  --- fail-closed regressions ---\n'
expect_fail_with "probe_sp_api_err" "probe_sp_api_error" \
  run_operator execute "$WORK_DIR/t-pse" STUB_PROBE_SP_FAIL=1

expect_fail_with "probe_app_api_err" "probe_app_api_error" \
  run_operator execute "$WORK_DIR/t-pae" STUB_PROBE_APP_FAIL=1 STUB_APP_ALREADY_ABSENT=1

expect_fail_with "probe_ra_api_err" "probe_role_assignment_api_error" \
  run_operator execute "$WORK_DIR/t-prae" STUB_PROBE_RA_FAIL=1

expect_fail_with "probe_role_api_err" "probe_custom_role_api_error" \
  run_operator execute "$WORK_DIR/t-prle" STUB_PROBE_ROLE_FAIL=1

expect_fail_with "probe_secret_api_err" "probe_secret_api_error" \
  run_operator execute "$WORK_DIR/t-psce" STUB_PROBE_SECRET_FAIL=1 STUB_SECRET_DELETE_FAIL=1

expect_fail_with "retained_sp_api_err" "retained_sp_query_api_error" \
  run_operator plan "$WORK_DIR/t-rsae" STUB_PROBE_RETAINED_SP_FAIL=1

expect_fail_with "repo_secret_api_err" "probe_repo_secret_api_error" \
  run_operator plan "$WORK_DIR/t-rrsae" STUB_PROBE_REPO_SECRET_FAIL=1

fixture_dir="$WORK_DIR/t-wvae"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
expect_fail_with "workflow_view_api_err" "workflow_view_api_error" \
  run_operator verify "$fixture_dir" STUB_SP_ALREADY_ABSENT=1 STUB_PROBE_WORKFLOW_FAIL=1

fixture_dir="$WORK_DIR/t-vspe"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
expect_fail_with "verify_sp_api_err" "probe_sp_api_error" \
  run_operator verify "$fixture_dir" STUB_PROBE_SP_FAIL=1

# --- Terminal state handoff (re-auditability after metadata cleanup) ---
printf '\n  --- terminal state handoff ---\n'

# Execute to get terminal state, then verify+cleanup
fixture_dir="$WORK_DIR/t-handoff"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
STATE_F="$fixture_dir/identity-retirement-state.env"

# Permissions: state file must be 0600
perms="$(stat -f '%Lp' "$STATE_F" 2>/dev/null || stat -c '%a' "$STATE_F" 2>/dev/null)"
if [[ "$perms" == "600" ]]; then pass "state_file_0600"; else fail "state_file_0600 (got: $perms)"; fi

# State file must not be a symlink
if [[ -f "$STATE_F" && ! -L "$STATE_F" ]]; then pass "state_not_symlink"; else fail "state_not_symlink"; fi

# Terminal state must contain all exact IDs for audit re-proof
required_state_keys=(
  migration_sp_object_id recovery_sp_object_id
  migration_app_id recovery_app_id
  role_assignment_id_1 role_assignment_id_2 role_assignment_id_3
  custom_role_id_1 custom_role_id_2
  migration_environment recovery_environment
  retained_sp_object_id retained_sp_display_name retained_secret_name
  tenant_id subscription_id repository phase schema
)
all_present=true
for key in "${required_state_keys[@]}"; do
  if ! grep -q "^${key}=" "$STATE_F"; then all_present=false; break; fi
done
if [[ "$all_present" == "true" ]]; then pass "terminal_state_has_audit_ids"
else fail "terminal_state_has_audit_ids (missing: $key)"; fi

# Verify exact values match metadata
if [[ "$(grep '^migration_sp_object_id=' "$STATE_F" | sed 's/^[^=]*=//')" == "$G_MS" ]] &&
   [[ "$(grep '^role_assignment_id_1=' "$STATE_F" | sed 's/^[^=]*=//')" == "$RA_ID_1" ]] &&
   [[ "$(grep '^custom_role_id_1=' "$STATE_F" | sed 's/^[^=]*=//')" == "$G_CR1" ]] &&
   [[ "$(grep '^retained_sp_object_id=' "$STATE_F" | sed 's/^[^=]*=//')" == "$G_RET" ]]; then
  pass "terminal_state_exact_values"
else fail "terminal_state_exact_values"; fi

# Intermediate (non-retired) state must NOT contain IDs (minimal surface)
fixture_dir="$WORK_DIR/t-intermediate"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 STUB_SP_DELETE_FAIL=1 \
  "$OPERATOR" execute >/dev/null 2>&1 || true
INT_STATE="$fixture_dir/identity-retirement-state.env"
if [[ -f "$INT_STATE" ]] && ! grep -q "^migration_sp_object_id=" "$INT_STATE"; then
  pass "intermediate_state_minimal"
else fail "intermediate_state_minimal"; fi

# Operator must never print IDs to stdout/stderr
fixture_dir="$WORK_DIR/t-noleak"
out="$(run_operator execute "$fixture_dir" 2>&1)" || true
leaked=false
for guid in "$G_MS" "$G_RS" "$G_MA" "$G_RA" "$G_CR1" "$G_CR2" "$G_RA1" "$G_RA2" "$G_RA3"; do
  if echo "$out" | grep -qF "$guid"; then leaked=true; break; fi
done
if [[ "$leaked" == "false" ]]; then pass "no_id_leak_stdout"; else fail "no_id_leak_stdout (leaked: $guid)"; fi

# After cleanup, state alone is sufficient for audit
fixture_dir="$WORK_DIR/t-audit-handoff"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 STUB_SP_ALREADY_ABSENT=1 \
  "$OPERATOR" verify >/dev/null 2>&1 || true
# Metadata deleted, state remains with full IDs
if [[ ! -f "$fixture_dir/metadata.env" ]] &&
   [[ -f "$fixture_dir/identity-retirement-state.env" ]] &&
   grep -q "^migration_sp_object_id=$G_MS" "$fixture_dir/identity-retirement-state.env" &&
   grep -q "^role_assignment_id_3=" "$fixture_dir/identity-retirement-state.env" &&
   grep -q "^retained_sp_object_id=$G_RET" "$fixture_dir/identity-retirement-state.env"; then
  pass "post_cleanup_state_self_sufficient"
else fail "post_cleanup_state_self_sufficient"; fi

# --- Retained identity deletion protection ---
# No delete command must ever target retained_sp_object_id, betstan-github-sp,
# or repository-level AZURE_CREDENTIALS. Asserted via command log inspection.
printf '\n  --- retained identity protection ---\n'

# Helper: assert no retained-identity-targeting commands in logs
assert_no_retained_deletes() {
  local label="$1" az_log="$2" gh_log="$3"
  local violations=0

  # No az sp/app delete targeting retained SP OID
  if grep -q "delete.*$G_RET" "$az_log" 2>/dev/null; then
    violations=$((violations+1))
    printf '    violation: az delete targets retained SP OID\n' >&2
  fi

  # No gh secret delete of AZURE_CREDENTIALS without --env (repo-level)
  # Environment secret deletes include --env; repo-level ones do not
  if grep "secret delete.*AZURE_CREDENTIALS" "$gh_log" 2>/dev/null | grep -qv -- "--env"; then
    violations=$((violations+1))
    printf '    violation: gh secret delete targets repo AZURE_CREDENTIALS\n' >&2
  fi

  if [[ "$violations" -eq 0 ]]; then pass "$label"; else fail "$label ($violations violations)"; fi
}

# Scenario: successful full execute
fixture_dir="$WORK_DIR/t-prot-exec"
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_execute" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"

# Scenario: already-absent path
fixture_dir="$WORK_DIR/t-prot-absent"
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
run_operator execute "$fixture_dir" STUB_SP_ALREADY_ABSENT=1 STUB_APP_ALREADY_ABSENT=1 >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_absent" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"

# Scenario: partial failure + resume
fixture_dir="$WORK_DIR/t-prot-resume"
write_metadata "$fixture_dir"
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 STUB_SP_DELETE_FAIL=1 \
  "$OPERATOR" execute >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_partial" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"
# Resume after partial
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_resume" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"

# Scenario: verify mode (should only probe, never delete retained)
fixture_dir="$WORK_DIR/t-prot-verify"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
: > "$WORK_DIR/az.log"; : > "$WORK_DIR/gh.log"
run_operator verify "$fixture_dir" STUB_SP_ALREADY_ABSENT=1 >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_verify" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"

# --- Path and permission regressions ---
printf '\n  --- path/permission regressions ---\n'

# Relative metadata path rejected
fixture_dir="$WORK_DIR/t-relpath"; write_metadata "$fixture_dir"
expect_fail_with "relative_metadata_path" "metadata_path_not_absolute" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="relative/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

# Relative state dir rejected
expect_fail_with "relative_state_dir" "state_dir_not_absolute" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="relative/state" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

# Metadata with wrong permissions (0644) rejected
fixture_dir="$WORK_DIR/t-metaperm"; write_metadata "$fixture_dir"
chmod 644 "$fixture_dir/metadata.env"
expect_fail_with "metadata_wrong_perms" "metadata_file_wrong_permissions" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

# Symlinked state directory rejected
fixture_dir="$WORK_DIR/t-symdir-real"; mkdir -p "$fixture_dir"
ln -sfn "$fixture_dir" "$WORK_DIR/t-symdir-link"
write_metadata "$fixture_dir"
expect_fail_with "symlinked_state_dir" "state_dir_symlink" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$WORK_DIR/t-symdir-link" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

# State file with wrong permissions (0644) rejected on resume
fixture_dir="$WORK_DIR/t-stateperm"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
chmod 644 "$fixture_dir/identity-retirement-state.env"
expect_fail_with "state_file_wrong_perms" "state_file_wrong_permissions" \
  run_operator execute "$fixture_dir"

# Pre-created temp symlink in state dir rejected (write_state safety)
fixture_dir="$WORK_DIR/t-tempsym"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
# Create a predictable trap: symlink at the temp location write_state would use
# Since temp name is unpredictable (PID+RANDOM), we test by creating many symlinks
# Instead, we test indirectly: state file written is never a symlink after execute
STATE_F="$fixture_dir/identity-retirement-state.env"
if [[ -f "$STATE_F" && ! -L "$STATE_F" ]]; then pass "state_written_not_symlink"
else fail "state_written_not_symlink"; fi

# State dir that resolves elsewhere via symlink (caught as symlink)
fixture_dir="$WORK_DIR/t-resolve"
mkdir -p "$WORK_DIR/t-resolve-target"
write_metadata "$WORK_DIR/t-resolve-target"
ln -sfn "$WORK_DIR/t-resolve-target" "$WORK_DIR/t-resolve-via"
expect_fail_with "state_dir_resolves_elsewhere" "state_dir_symlink" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$WORK_DIR/t-resolve-target/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$WORK_DIR/t-resolve-via" GH_REPOSITORY="vasilyevstan/betstan" "$OPERATOR" plan

# ==========================================
printf '\nidentity_retirement_contract=%s scenarios=%d pass=%d fail=%d\n' \
  "$([[ "$FAIL" -eq 0 ]] && printf 'PASS' || printf 'FAIL')" "$SCENARIOS" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
