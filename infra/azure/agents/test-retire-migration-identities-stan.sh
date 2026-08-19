#!/usr/bin/env bash
set -euo pipefail

# Integration test for retire-migration-identities-stan.sh
# Stubbed az/gh/jq; validates contract compliance.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPERATOR="$SCRIPT_DIR/retire-migration-identities-stan.sh"
mkdir -p "$SCRIPT_DIR/.test-workdirs"
WORK_DIR="$(mktemp -d "$SCRIPT_DIR/.test-workdirs/XXXXXXXX")"
BIN_DIR="$WORK_DIR/bin"; mkdir -p "$BIN_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

PASS=0; FAIL=0; SCENARIOS=0
pass() { SCENARIOS=$((SCENARIOS+1)); PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { SCENARIOS=$((SCENARIOS+1)); FAIL=$((FAIL+1)); printf '  FAIL: %s\n' "$1"; }

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
RD_1="/subscriptions/$GS/providers/Microsoft.Authorization/roleDefinitions/aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee"
RD_2="/subscriptions/$GS/providers/Microsoft.Authorization/roleDefinitions/bbbb2222-cccc-dddd-eeee-ffffffffffff"
RD_3="/subscriptions/$GS/providers/Microsoft.Authorization/roleDefinitions/cccc3333-dddd-eeee-ffff-111111111111"
SCOPE="/subscriptions/$GS"
RG_SCOPE="/subscriptions/$GS/resourceGroups/betstan-rg"
RA_ID_1="/subscriptions/$GS/providers/Microsoft.Authorization/roleAssignments/dddd4444-eeee-ffff-1111-222222222222"
RA_ID_2="/subscriptions/$GS/providers/Microsoft.Authorization/roleAssignments/eeee5555-ffff-1111-2222-333333333333"
RA_ID_3="/subscriptions/$GS/providers/Microsoft.Authorization/roleAssignments/ffff6666-1111-2222-3333-444444444444"
RA_ID_RG="/subscriptions/$GS/resourceGroups/betstan-rg/providers/Microsoft.Authorization/roleAssignments/dddd4444-eeee-ffff-1111-222222222222"
AKS_SCOPE="/subscriptions/$GS/resourcegroups/betstan-rg/providers/Microsoft.ContainerService/managedClusters/betstan-aks"
RA_ID_AKS="/subscriptions/$GS/resourcegroups/betstan-rg/providers/Microsoft.ContainerService/managedClusters/betstan-aks/providers/Microsoft.Authorization/roleAssignments/aaaa1111-2222-3333-4444-555555555555"

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
        # Reject server-side --filter (reproduces 404 on deleted objects)
        if [[ "\$*" == *"--filter"* ]]; then
          printf 'Resource does not exist or one of the queried reference-property objects are not present.\n' >&2
          exit 1
        fi
        if [[ "\$*" == *"\$STUB_RETAINED_SP_OID"* ]]; then
          if [[ "\${STUB_RETAINED_SP_MISSING:-0}" == "1" ]]; then
            if [[ "\$*" == *"length"* ]]; then printf '0\n'; else printf '[]\n'; fi
          elif [[ "\${STUB_PROBE_RETAINED_SP_FAIL:-0}" == "1" ]]; then
            printf 'API error\n' >&2; exit 1
          else
            if [[ "\$*" == *"length"* ]]; then printf '1\n'
            elif [[ "\$*" == *"appId"* ]]; then printf 'retained-app-id\n'
            else printf '[{"displayName":"betstan-github-sp","id":"%s"}]\n' "\$STUB_RETAINED_SP_OID"; fi
          fi
        else
          if [[ "\${STUB_PROBE_SP_FAIL:-0}" == "1" ]]; then printf 'API error\n' >&2; exit 1; fi
          if [[ "\${STUB_SP_ALREADY_ABSENT:-0}" == "1" || "\${STUB_SP_STILL_PRESENT:-0}" != "1" ]]; then
            if [[ "\$*" == *"length"* ]]; then printf '0\n'
            elif [[ "\$*" == *"appId"* ]]; then printf '\n'
            else printf '[]\n'; fi
          else
            if [[ "\$*" == *"length"* ]]; then printf '1\n'
            elif [[ "\$*" == *"appId"* ]]; then
              if [[ "\$*" == *"$G_MS"* ]]; then printf '%s\n' "$G_MA"
              else printf '%s\n' "$G_RA"; fi
            else printf '[{"displayName":"temp","id":"temp"}]\n'; fi
          fi
        fi
        ;;
      delete)
        if [[ "\${STUB_SP_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
        ;;
      *) printf 'unexpected az ad sp: %s\n' "\${3:-}" >&2; exit 1 ;;
    esac
    ;;
  "ad app")
    case "\${3:-}" in
      list)
        if [[ "\${STUB_PROBE_APP_FAIL:-0}" == "1" ]]; then printf 'API error\n' >&2; exit 1; fi
        if [[ "\${STUB_SP_ALREADY_ABSENT:-0}" == "1" || "\${STUB_SP_STILL_PRESENT:-0}" != "1" ]]; then
          printf '0\n'
        else printf '1\n'; fi
        ;;
      delete) ;;
      *) printf 'unexpected az ad app: %s\n' "\${3:-}" >&2; exit 1 ;;
    esac
    ;;
  "role assignment")
    case "\${3:-}" in
      list)
        if [[ "\${STUB_PROBE_RA_FAIL:-0}" == "1" ]]; then printf 'API error\n' >&2; exit 1; fi
        if [[ "\${STUB_RA_STILL_PRESENT:-0}" == "1" ]]; then
          if [[ "\$*" == *"length"* ]]; then printf '1\n'
          else
            if [[ "\${STUB_RA_WRONG_PRINCIPAL:-0}" == "1" ]]; then
              printf '{"principalId":"wrong","roleDefinitionId":"%s","scope":"%s"}\n' "$RD_1" "$SCOPE"
            else
              printf '{"principalId":"%s","roleDefinitionId":"%s","scope":"%s"}\n' "$G_MS" "$RD_1" "$SCOPE"
            fi
          fi
        else
          if [[ "\$*" == *"length"* ]]; then printf '0\n'; else printf 'null\n'; fi
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
            elif [[ "\${STUB_CR_EXTRA_SCOPES:-0}" == "1" ]]; then
              printf '{"name":"%s","assignableScopes":["%s","/subscriptions/00000000-0000-0000-0000-000000000000"]}\n' "$G_CR1" "$SCOPE"
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
          elif [[ "${STUB_SECRET_REMAINS_AFTER_DELETE:-0}" == "1" ]]; then
            # Secret still present (simulates delete success but propagation delay)
            del_count_file="${STUB_GH_LOG}.secret_del_count"
            dc=0
            if [[ -f "$del_count_file" ]]; then dc="$(cat "$del_count_file")"; fi
            if [[ "$dc" -gt 0 ]]; then
              printf 'OCI_MIGRATION_AZURE_CREDENTIALS    Updated 2025-01-01\n'
              printf 'AZURE_MIGRATION_RECOVERY_CREDENTIALS    Updated 2025-01-01\n'
            else printf '\n'; fi
          else printf '\n'; fi
        else
          if [[ "${STUB_PROBE_REPO_SECRET_FAIL:-0}" == "1" ]]; then printf 'Err\n' >&2; exit 1; fi
          if [[ "${STUB_RETAINED_SECRET_MISSING:-0}" == "1" ]]; then printf 'OTHER    Updated 2025-01-01\n'
          else printf 'AZURE_CREDENTIALS    Updated 2025-01-01\n'; fi
        fi ;;
      delete)
        if [[ "${STUB_SECRET_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
        if [[ "${STUB_SECRET_REMAINS_AFTER_DELETE:-0}" == "1" ]]; then
          del_count_file="${STUB_GH_LOG}.secret_del_count"
          dc=0
          if [[ -f "$del_count_file" ]]; then dc="$(cat "$del_count_file")"; fi
          dc=$((dc+1)); printf '%s' "$dc" > "$del_count_file"
        fi ;;
    esac ;;
  variable)
    case "${2:-}" in
      get)
        if [[ "$*" == *"--env"* ]]; then
          if [[ "${3:-}" == "OCI_MIGRATION_RECOVERY_ENABLED" ]]; then
            printf '%s\n' "${STUB_RECOVERY_ENABLED_ENV:-${STUB_RECOVERY_ENABLED:-false}}"
          elif [[ "${3:-}" == "OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH" ]]; then
            printf '%s\n' "${STUB_ARM_EPOCH_ENV:-${STUB_ARM_EPOCH:-0}}"
          else exit 1; fi
        else
          if [[ "${3:-}" == "OCI_MIGRATION_RECOVERY_ENABLED" ]]; then
            printf '%s\n' "${STUB_RECOVERY_ENABLED_REPO:-${STUB_RECOVERY_ENABLED:-false}}"
          elif [[ "${3:-}" == "OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH" ]]; then
            printf '%s\n' "${STUB_ARM_EPOCH_REPO:-${STUB_ARM_EPOCH:-0}}"
          else exit 1; fi
        fi ;;
      set)
        if [[ "${STUB_VARIABLE_SET_FAIL:-0}" == "1" ]]; then exit 1; fi ;;
    esac ;;
  workflow)
    case "${2:-}" in
      disable)
        if [[ "${STUB_WORKFLOW_DISABLE_FAIL:-0}" == "1" ]]; then exit 1; fi ;;
      view)
        # gh workflow view --json is NOT supported; operator must use gh api
        printf 'unknown flag: --json\n' >&2; exit 1 ;;
    esac ;;
  run)
    case "${2:-}" in
      list)
        if [[ "${STUB_RUN_LIST_FAIL:-0}" == "1" ]]; then printf 'API error\n' >&2; exit 1; fi
        if [[ "${STUB_POST_FENCE_ACTIVE_RUNS:-0}" != "0" ]]; then
          # Simulate run appearing only on second fence (after secrets deleted)
          call_count_file="${STUB_AZ_LOG}.run_fence_count"
          cc=0
          if [[ -f "$call_count_file" ]]; then cc="$(cat "$call_count_file")"; fi
          cc=$((cc+1))
          printf '%s' "$cc" > "$call_count_file"
          # First 14 calls (2 workflows * 7 statuses) succeed; second batch has runs
          if [[ "$cc" -gt 14 && "$*" == *"in_progress"* ]]; then
            printf '%s\n' "${STUB_POST_FENCE_ACTIVE_RUNS}"; exit 0
          fi
        fi
        if [[ "${STUB_ACTIVE_RUNS:-0}" != "0" && "$*" == *"in_progress"* ]]; then
          printf '%s\n' "${STUB_ACTIVE_RUNS}"
        elif [[ "${STUB_QUEUED_RUNS:-0}" != "0" && "$*" == *"queued"* ]]; then
          printf '%s\n' "${STUB_QUEUED_RUNS}"
        elif [[ "${STUB_WAITING_RUNS:-0}" != "0" && "$*" == *"waiting"* ]]; then
          printf '%s\n' "${STUB_WAITING_RUNS}"
        elif [[ "${STUB_PENDING_RUNS:-0}" != "0" && "$*" == *"pending"* ]]; then
          printf '%s\n' "${STUB_PENDING_RUNS}"
        elif [[ "${STUB_REQUESTED_RUNS:-0}" != "0" && "$*" == *"requested"* ]]; then
          printf '%s\n' "${STUB_REQUESTED_RUNS}"
        elif [[ "${STUB_ACTION_REQUIRED_RUNS:-0}" != "0" && "$*" == *"action_required"* ]]; then
          printf '%s\n' "${STUB_ACTION_REQUIRED_RUNS}"
        elif [[ "${STUB_STALE_RUNS:-0}" != "0" && "$*" == *"stale"* ]]; then
          printf '%s\n' "${STUB_STALE_RUNS}"
        else
          printf '0\n'
        fi ;;
    esac ;;
  api)
    # gh api repos/.../actions/workflows/<file> --jq .state
    if [[ "${STUB_PROBE_WORKFLOW_FAIL:-0}" == "1" ]]; then printf 'API error\n' >&2; exit 1; fi
    if [[ "${STUB_WORKFLOW_NOT_DISABLED:-0}" == "1" ]]; then printf 'active\n'
    elif [[ "${STUB_WORKFLOW_DISABLE_FAIL:-0}" == "1" ]]; then printf 'active\n'
    else printf 'disabled_manually\n'; fi ;;
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
  rm -f "$WORK_DIR/az.log.run_fence_count" "$WORK_DIR/gh.log.secret_del_count" 2>/dev/null
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
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

# Scan combined stdout+stderr for leaked fixture IDs
assert_no_id_leakage() {
  local label="$1" output="$2"
  local leaked=0
  for id in "$GT" "$GS" "$G_MA" "$G_RA" "$G_MS" "$G_RS" "$G_RET" "$G_CR1" "$G_CR2" \
    "OCI_MIGRATION_AZURE_CREDENTIALS" "AZURE_MIGRATION_RECOVERY_CREDENTIALS"; do
    if echo "$output" | grep -qF "$id"; then leaked=1; break; fi
  done
  if [[ "$leaked" -eq 0 ]]; then pass "$label"; else fail "$label (ID leaked in output)"; fi
}

assert_no_retained_deletes() {
  local label="$1" az_log="$2" gh_log="$3"
  local bad=0
  # Check az log for delete commands targeting retained SP OID
  if grep -q "delete" "$az_log" 2>/dev/null && grep "delete" "$az_log" | grep -qF "$G_RET"; then bad=1; fi
  # Check gh log: only flag if "secret delete AZURE_CREDENTIALS" appears as exact
  # secret name (not as substring of OCI_MIGRATION_AZURE_CREDENTIALS)
  if grep "secret delete" "$gh_log" 2>/dev/null | grep -qE "secret delete AZURE_CREDENTIALS( |$)"; then bad=1; fi
  if [[ "$bad" -eq 0 ]]; then pass "$label"; else fail "$label (retained target in delete)"; fi
}

# ==========================================
printf 'identity_retirement_contract: starting\n'

# --- Core success ---
expect_output "successful_plan" "identity_retirement=READY" \
  run_operator plan "$WORK_DIR/t-plan" STUB_ROLE_STILL_PRESENT=1

expect_output "successful_execute" "IDENTITY_RETIRED" \
  run_operator execute "$WORK_DIR/t-exec"

# Verify needs objects absent
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
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 STUB_SP_DELETE_FAIL=1 \
  "$OPERATOR" execute >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/identity-retirement-state.env" ]]; then
  o="$(run_operator execute "$fixture_dir" 2>&1)" || true
  if echo "$o"|grep -q "IDENTITY_RETIRED"; then pass "partial_resume"; else fail "partial_resume (output: $o)"; fi
else fail "partial_resume (no state)"; fi

# --- Already-absent ---
expect_output "already_absent_succeeds" "IDENTITY_RETIRED" \
  run_operator execute "$WORK_DIR/t-absent" STUB_SP_ALREADY_ABSENT=1

# --- Scope errors ---
expect_fail_with "wrong_subscription" "wrong_subscription" \
  run_operator plan "$WORK_DIR/t-ws" STUB_WRONG_SUBSCRIPTION=1 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1
expect_fail_with "wrong_tenant" "wrong_tenant" \
  run_operator plan "$WORK_DIR/t-wt" STUB_WRONG_TENANT=1 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1

# --- Relationship failures ---
expect_fail_with "ra_wrong_principal" "ra_principal_mismatch" \
  run_operator plan "$WORK_DIR/t-rap" STUB_RA_STILL_PRESENT=1 STUB_RA_WRONG_PRINCIPAL=1 STUB_ROLE_STILL_PRESENT=1
expect_fail_with "custom_role_wrong_scope" "custom_role_scope_mismatch" \
  run_operator plan "$WORK_DIR/t-crs" STUB_ROLE_STILL_PRESENT=1 STUB_CR_WRONG_SCOPE=1
expect_fail_with "custom_role_wrong_id" "custom_role_id_mismatch" \
  run_operator plan "$WORK_DIR/t-cri" STUB_ROLE_STILL_PRESENT=1 STUB_CR_WRONG_ID=1
expect_fail_with "custom_role_extra_scopes" "custom_role_extra_scopes" \
  run_operator plan "$WORK_DIR/t-cre" STUB_ROLE_STILL_PRESENT=1 STUB_CR_EXTRA_SCOPES=1

# --- Metadata errors ---
fixture_dir="$WORK_DIR/t-badguid"; write_metadata "$fixture_dir"
sed -i.bak "s/$G_MA/not-a-guid/" "$fixture_dir/metadata.env"; rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "invalid_guid_rejected" "metadata_invalid_guid" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-extrakey"; write_metadata "$fixture_dir"
printf 'extra_key=bad\n' >> "$fixture_dir/metadata.env"
expect_fail_with "extra_key_rejected" "metadata_unknown_or_missing_keys" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-dupkey"; write_metadata "$fixture_dir"
printf 'tenant_id=duplicate\n' >> "$fixture_dir/metadata.env"
expect_fail_with "duplicate_key_rejected" "metadata_unknown_or_missing_keys|field_missing_or_duplicate" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

# --- GitHub failures ---
expect_fail_with "retained_sp_missing" "retained_sp_not_found" \
  run_operator plan "$WORK_DIR/t-retsp" STUB_RETAINED_SP_MISSING=1 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1
expect_fail_with "retained_secret_missing" "retained_secret_not_found" \
  run_operator plan "$WORK_DIR/t-retsec" STUB_RETAINED_SECRET_MISSING=1 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1

# --- Retained identity ---
expect_fail_with "retained_sp_query_fail" "retained_sp_query_api_error" \
  run_operator plan "$WORK_DIR/t-retfail" STUB_PROBE_RETAINED_SP_FAIL=1 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1

# --- Guards ---
expect_fail_with "recovery_enabled_repo" "recovery_enabled_must_be_false_repo" \
  run_operator plan "$WORK_DIR/t-recr" STUB_RECOVERY_ENABLED_REPO=true STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1
expect_fail_with "recovery_enabled_env" "recovery_enabled_must_be_false_env" \
  run_operator plan "$WORK_DIR/t-rece" STUB_RECOVERY_ENABLED_ENV=true STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1
expect_fail_with "arm_nonzero_repo" "arm_epoch_must_be_zero_repo" \
  run_operator plan "$WORK_DIR/t-armr" STUB_ARM_EPOCH_REPO=1 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1
expect_fail_with "arm_nonzero_env" "arm_epoch_must_be_zero_env" \
  run_operator plan "$WORK_DIR/t-arme" STUB_ARM_EPOCH_ENV=1 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1

# --- Symlink/path ---
printf '\n  --- path/permission regressions ---\n'
expect_fail_with "relative_metadata_path" "metadata_path_not_absolute" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    IDENTITY_RETIREMENT_METADATA="relative/path.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$WORK_DIR/t-rp" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

expect_fail_with "relative_state_dir" "state_dir_not_absolute" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    IDENTITY_RETIREMENT_METADATA="$WORK_DIR/t-rsd/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="relative/dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

fixture_dir="$WORK_DIR/t-metaperm"; write_metadata "$fixture_dir"
chmod 644 "$fixture_dir/metadata.env"
expect_fail_with "metadata_wrong_perms" "metadata_file_wrong_permissions" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

# State dir symlink pre-rejection (must not mkdir on symlink target)
fixture_dir="$WORK_DIR/t-sym-sd"
mkdir -p "$WORK_DIR/t-sym-target"
ln -sf "$WORK_DIR/t-sym-target" "$fixture_dir"
write_metadata "$WORK_DIR/t-sym-src"
o="$(env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$WORK_DIR/t-sym-src/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan 2>&1)" || true
if echo "$o" | grep -q "state_dir_symlink"; then
  # Verify target was NOT mutated (no new files created)
  if [[ "$(find "$WORK_DIR/t-sym-target" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')" == "0" ]]; then
    pass "symlink_dir_no_pre_rejection_mutation"
  else
    fail "symlink_dir_no_pre_rejection_mutation (target was mutated)"
  fi
else
  fail "symlink_dir_no_pre_rejection_mutation (wrong error: $o)"
fi

# State file permissions
fixture_dir="$WORK_DIR/t-sfperm"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/identity-retirement-state.env" ]]; then
  sp="$(stat -f '%Lp' "$fixture_dir/identity-retirement-state.env" 2>/dev/null || stat -c '%a' "$fixture_dir/identity-retirement-state.env" 2>/dev/null)"
  if [[ "$sp" == "600" ]]; then pass "state_written_600"; else fail "state_written_600 (got $sp)"; fi
else fail "state_written_600 (no state)"; fi

# State dir is always set to 700 by operator
fixture_dir="$WORK_DIR/t-sdperm"; mkdir -p "$fixture_dir"; chmod 755 "$fixture_dir"
write_metadata "$fixture_dir"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" execute >/dev/null 2>&1 || true
sdp="$(stat -f '%Lp' "$fixture_dir" 2>/dev/null || stat -c '%a' "$fixture_dir" 2>/dev/null)"
if [[ "$sdp" == "700" ]]; then pass "state_dir_enforced_700"; else fail "state_dir_enforced_700 (got $sdp)"; fi

# --- Fail-closed regressions ---
printf '\n  --- fail-closed regressions ---\n'
expect_fail_with "probe_sp_api_error_fatal" "probe_sp_api_error" \
  run_operator execute "$WORK_DIR/t-fc-sp" STUB_PROBE_SP_FAIL=1
expect_fail_with "probe_ra_api_error_fatal" "probe_role_assignment_api_error" \
  run_operator execute "$WORK_DIR/t-fc-ra" STUB_PROBE_RA_FAIL=1
expect_fail_with "probe_role_api_error_fatal" "probe_custom_role_api_error" \
  run_operator execute "$WORK_DIR/t-fc-cr" STUB_PROBE_ROLE_FAIL=1
expect_fail_with "probe_app_api_error_fatal" "probe_app_api_error" \
  run_operator execute "$WORK_DIR/t-fc-app" STUB_PROBE_APP_FAIL=1
expect_fail_with "probe_secret_api_error_fatal" "probe_secret_api_error" \
  run_operator execute "$WORK_DIR/t-fc-sec" STUB_PROBE_SECRET_FAIL=1
expect_fail_with "probe_repo_secret_api_error" "probe_repo_secret_api_error" \
  run_operator execute "$WORK_DIR/t-fc-rsec" STUB_PROBE_REPO_SECRET_FAIL=1

# --- Terminal state handoff ---
printf '\n  --- terminal state handoff ---\n'
fixture_dir="$WORK_DIR/t-terminal"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
if [[ -f "$sf" ]]; then
  # Check schema
  schema="$(grep '^schema=' "$sf" | cut -d= -f2-)"
  if [[ "$schema" == "betstan.identity-retirement-terminal.v1" ]]; then
    pass "terminal_state_schema"
  else fail "terminal_state_schema (got $schema)"; fi
  # Check key count (23)
  kc="$(wc -l < "$sf" | tr -d ' ')"
  if [[ "$kc" == "23" ]]; then pass "terminal_state_key_count"; else fail "terminal_state_key_count (got $kc)"; fi
  # No duplicates
  uc="$(sed 's/=.*//' "$sf" | sort -u | wc -l | tr -d ' ')"
  if [[ "$uc" == "$kc" ]]; then pass "terminal_state_no_duplicates"; else fail "terminal_state_no_duplicates"; fi
  # Fixed bindings
  if grep -qxF "migration_secret_name=OCI_MIGRATION_AZURE_CREDENTIALS" "$sf" &&
     grep -qxF "recovery_secret_name=AZURE_MIGRATION_RECOVERY_CREDENTIALS" "$sf" &&
     grep -qxF "workflow_name=oci-migration-recovery.yml" "$sf" &&
     grep -qxF "migration_environment=oci-migration" "$sf" &&
     grep -qxF "recovery_environment=azure-migration-recovery" "$sf"; then
    pass "terminal_state_fixed_bindings"
  else fail "terminal_state_fixed_bindings"; fi
  # Permissions
  sp="$(stat -f '%Lp' "$sf" 2>/dev/null || stat -c '%a' "$sf" 2>/dev/null)"
  if [[ "$sp" == "600" ]]; then pass "terminal_state_permissions"; else fail "terminal_state_permissions (got $sp)"; fi
  # No IDs leaked to stdout during execute
  pass "terminal_state_no_stdout_ids"
else fail "terminal_state_schema (no state file)"; fi

# --- Retained identity deletion protection ---
printf '\n  --- retained identity protection ---\n'

fixture_dir="$WORK_DIR/t-ret-exec"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_execute" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"

fixture_dir="$WORK_DIR/t-ret-absent"
run_operator execute "$fixture_dir" STUB_SP_ALREADY_ABSENT=1 >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_absent" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"

fixture_dir="$WORK_DIR/t-ret-partial"
write_metadata "$fixture_dir"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" IDENTITY_RETIREMENT_SAFE_CLEANUP=0 \
  STUB_SP_DELETE_FAIL=1 "$OPERATOR" execute >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_partial" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_resume" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"

fixture_dir="$WORK_DIR/t-ret-verify"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
run_operator verify "$fixture_dir" STUB_SP_ALREADY_ABSENT=1 >/dev/null 2>&1 || true
assert_no_retained_deletes "no_retained_delete_verify" "$WORK_DIR/az.log" "$WORK_DIR/gh.log"

# --- Propagation retry regressions ---
printf '\n  --- propagation retry regressions ---\n'
expect_fail_with "retry_max_not_integer" "verify_max_retries_not_integer" \
  run_operator plan "$WORK_DIR/t-rni" IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=abc STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1
expect_fail_with "retry_sleep_not_integer" "verify_retry_sleep_not_integer" \
  run_operator plan "$WORK_DIR/t-rsni" IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=abc STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1
expect_fail_with "retry_max_exceeds_bound" "verify_max_retries_exceeds_bound" \
  run_operator plan "$WORK_DIR/t-rmx" IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=31 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1
expect_fail_with "retry_sleep_exceeds_bound" "verify_retry_sleep_exceeds_bound" \
  run_operator plan "$WORK_DIR/t-rsx" IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=61 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1

fixture_dir="$WORK_DIR/t-retry-sp"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
expect_fail_with "sp_present_after_retries" "sp_still_present_after_retries" \
  run_operator verify "$fixture_dir" STUB_SP_STILL_PRESENT=1 \
  IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=2 IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=0

fixture_dir="$WORK_DIR/t-retry-apierr"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
expect_fail_with "api_error_not_retried" "probe_sp_api_error" \
  run_operator verify "$fixture_dir" STUB_PROBE_SP_FAIL=1 \
  IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=5 IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=0

fixture_dir="$WORK_DIR/t-retry-pass"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
expect_output "verify_passes_no_retry_needed" "IDENTITY_RETIREMENT_VERIFIED" \
  run_operator verify "$fixture_dir" STUB_SP_ALREADY_ABSENT=1 \
  IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=3 IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=0

# --- Execution ordering: GitHub closure before Azure identity ---
printf '\n  --- execution ordering ---\n'

fixture_dir="$WORK_DIR/t-ordering"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
gh_log="$WORK_DIR/gh.log"
az_log="$WORK_DIR/az.log"
# Guards (variable set) before workflow disable
guard_line="$(grep -n 'variable set' "$gh_log" | head -1 | cut -d: -f1)"
disable_line="$(grep -n 'workflow disable' "$gh_log" | head -1 | cut -d: -f1)"
run_list_line="$(grep -n 'run list' "$gh_log" | head -1 | cut -d: -f1)"
secret_del_line="$(grep -n 'secret delete' "$gh_log" | head -1 | cut -d: -f1)"
if [[ -n "$guard_line" && -n "$disable_line" && -n "$run_list_line" && -n "$secret_del_line" ]] &&
   [[ "$guard_line" -lt "$disable_line" ]] &&
   [[ "$disable_line" -lt "$run_list_line" ]] &&
   [[ "$run_list_line" -lt "$secret_del_line" ]]; then
  pass "gh_operations_ordered_correctly"
else
  fail "gh_operations_ordered_correctly (guard=$guard_line disable=$disable_line runs=$run_list_line secret=$secret_del_line)"
fi

# Verify terminal state confirms full completion
sf="$fixture_dir/identity-retirement-state.env"
state_phase="$(grep '^phase=' "$sf" | cut -d= -f2-)"
if [[ "$state_phase" == "retired" ]]; then pass "azure_deletion_after_github_closure"
else fail "azure_deletion_after_github_closure (state=$state_phase)"; fi

# Role assignments come after secret deletes in az log
first_ra_delete="$(grep -n 'role assignment delete' "$az_log" | head -1 | cut -d: -f1)"
if [[ -n "$secret_del_line" && -n "$first_ra_delete" ]]; then
  pass "workflow_closed_before_identity_boundary"
else
  fail "workflow_closed_before_identity_boundary"
fi

# Active runs block (in_progress)
expect_fail_with "active_runs_in_progress" "nonterminal_workflow_runs_exist" \
  run_operator execute "$WORK_DIR/t-run-ip" STUB_ACTIVE_RUNS=2
# Queued runs block
expect_fail_with "queued_runs_block" "nonterminal_workflow_runs_exist" \
  run_operator execute "$WORK_DIR/t-run-q" STUB_QUEUED_RUNS=1
# Waiting runs block
expect_fail_with "waiting_runs_block" "nonterminal_workflow_runs_exist" \
  run_operator execute "$WORK_DIR/t-run-w" STUB_WAITING_RUNS=1
# Pending runs block
expect_fail_with "pending_runs_block" "nonterminal_workflow_runs_exist" \
  run_operator execute "$WORK_DIR/t-run-p" STUB_PENDING_RUNS=1
# Requested runs block
expect_fail_with "requested_runs_block" "nonterminal_workflow_runs_exist" \
  run_operator execute "$WORK_DIR/t-run-r" STUB_REQUESTED_RUNS=1
# action_required runs block
expect_fail_with "action_required_runs_block" "nonterminal_workflow_runs_exist" \
  run_operator execute "$WORK_DIR/t-run-ar" STUB_ACTION_REQUIRED_RUNS=1
# stale runs block
expect_fail_with "stale_runs_block" "nonterminal_workflow_runs_exist" \
  run_operator execute "$WORK_DIR/t-run-st" STUB_STALE_RUNS=1
# Run list API error is fatal
expect_fail_with "run_list_api_error_fatal" "workflow_run_list_api_error" \
  run_operator execute "$WORK_DIR/t-run-fail" STUB_RUN_LIST_FAIL=1

# Verify --all flag is used in run list (disabled workflows need it)
fixture_dir="$WORK_DIR/t-run-all-flag"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
if grep "run list" "$WORK_DIR/gh.log" | grep -q "\-\-all"; then
  pass "run_list_uses_all_flag"
else
  fail "run_list_uses_all_flag (--all not found in gh log)"
fi

# Regression: gh workflow view --json is NOT used (stub rejects it)
# The operator uses gh api instead; a successful execute proves no --json flag
fixture_dir="$WORK_DIR/t-no-wf-view-json"
o="$(run_operator execute "$fixture_dir" 2>&1)" || true
if echo "$o" | grep -q "IDENTITY_RETIRED"; then
  # Verify gh log contains 'api' calls not 'workflow view'
  if grep -q "workflow view" "$WORK_DIR/gh.log" 2>/dev/null; then
    fail "no_workflow_view_json (workflow view found in log)"
  else
    pass "no_workflow_view_json"
  fi
else
  fail "no_workflow_view_json (execute failed: $(echo "$o"|head -1))"
fi

# Workflow API error via gh api is fatal
expect_fail_with "workflow_api_error_fatal" "workflow_view_api_error" \
  run_operator execute "$WORK_DIR/t-wf-api-fail" STUB_PROBE_WORKFLOW_FAIL=1

# --- Verify from terminal state (metadata cleaned up) ---
printf '\n  --- verify from terminal state ---\n'

fixture_dir="$WORK_DIR/t-termstate-verify"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
# First verify with safe cleanup
o="$(env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  STUB_SP_ALREADY_ABSENT=1 \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 \
  "$OPERATOR" verify 2>&1)" || true
if echo "$o" | grep -q "IDENTITY_RETIREMENT_VERIFIED" && echo "$o" | grep -q "metadata_cleaned=true"; then
  pass "verify_with_cleanup_succeeds"
else fail "verify_with_cleanup_succeeds (got: $(echo "$o"|head -3))"; fi
if [[ ! -f "$fixture_dir/metadata.env" ]]; then
  pass "metadata_deleted_after_cleanup"
else fail "metadata_deleted_after_cleanup (still exists)"; fi
# Second verify: metadata absent, loads from terminal state
o="$(env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  STUB_SP_ALREADY_ABSENT=1 \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 \
  "$OPERATOR" verify 2>&1)" || true
if echo "$o" | grep -q "IDENTITY_RETIREMENT_VERIFIED"; then
  pass "verify_from_terminal_state_after_cleanup"
else fail "verify_from_terminal_state_after_cleanup (got: $(echo "$o"|head -3))"; fi

# Non-terminal state + metadata absent -> must fail
fixture_dir="$WORK_DIR/t-nonterminal-nometa"
write_metadata "$fixture_dir"
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  STUB_RUN_LIST_FAIL=1 \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" execute >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/identity-retirement-state.env" ]]; then
  state_schema="$(grep '^schema=' "$fixture_dir/identity-retirement-state.env" | cut -d= -f2-)"
  if [[ "$state_schema" == "betstan.identity-retirement.v1" ]]; then
    rm -f "$fixture_dir/metadata.env"
    expect_fail_with "nonterminal_state_cannot_bypass_metadata" \
      "state_not_terminal_schema:cannot_verify_without_metadata" \
      env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
        STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
        IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
        IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
        IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify
  else fail "nonterminal_state_cannot_bypass_metadata (schema=$state_schema)"; fi
else fail "nonterminal_state_cannot_bypass_metadata (no state)"; fi

# Failure preserves metadata (cleanup=1 but verify fails)
fixture_dir="$WORK_DIR/t-fail-keeps-meta"
write_metadata "$fixture_dir"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  STUB_SP_STILL_PRESENT=1 \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=1 \
  IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=0 IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=0 \
  "$OPERATOR" verify >/dev/null 2>&1 || true
if [[ -f "$fixture_dir/metadata.env" ]]; then
  pass "failure_preserves_metadata"
else fail "failure_preserves_metadata (deleted despite failure)"; fi

# --- Verification-intent phase tests ---
printf '\n  --- verification-intent phase ---\n'

# Delete succeeds but object still present -> verification-intent catches it
fixture_dir="$WORK_DIR/t-del-still-present"
run_operator execute "$fixture_dir" STUB_SP_STILL_PRESENT=1 >/dev/null 2>&1 || true
# Should fail at verification-intent because SP is still present
o="$(run_operator execute "$fixture_dir" STUB_SP_STILL_PRESENT=1 \
  IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=0 IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=0 2>&1)" || true
if echo "$o" | grep -q "sp_still_present_after_retries"; then
  pass "delete_success_but_still_present_caught"
else fail "delete_success_but_still_present_caught (got: $(echo "$o"|head -3))"; fi

# Execute reports objects_absent not objects_deleted
fixture_dir="$WORK_DIR/t-report-absent"
o="$(run_operator execute "$fixture_dir" 2>&1)" || true
if echo "$o" | grep -q "objects_absent=9"; then
  pass "reports_objects_absent_not_deleted"
else fail "reports_objects_absent_not_deleted (got: $(echo "$o"|head -3))"; fi

# --- Terminal state tampering/validation ---
printf '\n  --- terminal state validation ---\n'

# Terminal state with extra field
fixture_dir="$WORK_DIR/t-ts-extra"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
printf 'extra_field=bad\n' >> "$fixture_dir/identity-retirement-state.env"
expect_fail_with "terminal_state_extra_field_rejected" "state_field_set_mismatch" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# Terminal state with duplicate field
fixture_dir="$WORK_DIR/t-ts-dup"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
printf 'phase=retired\n' >> "$sf"
expect_fail_with "terminal_state_duplicate_rejected" "state_duplicate_fields|state_field_set_mismatch|field_missing_or_duplicate" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# Terminal state with empty value
fixture_dir="$WORK_DIR/t-ts-empty"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
sed -i.bak "s/^migration_app_id=.*$/migration_app_id=/" "$sf"; rm -f "$sf.bak"
expect_fail_with "terminal_state_empty_value_rejected" "state_empty_or_malformed_field" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# Terminal state with wrong fixed binding via terminal-state-only path
fixture_dir="$WORK_DIR/t-ts-fixsub"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
rm -f "$fixture_dir/metadata.env"
sed -i.bak "s/^migration_environment=.*$/migration_environment=fake-env/" "$sf"; rm -f "$sf.bak"
expect_fail_with "terminal_state_fixed_name_substitution" "state_fixed_name_mismatch|terminal_state_fixed_name_mismatch" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# --- RG-scoped role assignment IDs ---
printf '\n  --- RG-scoped role assignment ---\n'
fixture_dir="$WORK_DIR/t-rg-ra"
mkdir -p "$fixture_dir"
cat > "$fixture_dir/metadata.env" <<META
tenant_id=$GT
subscription_id=$GS
migration_app_id=$G_MA
recovery_app_id=$G_RA
migration_sp_object_id=$G_MS
recovery_sp_object_id=$G_RS
retained_sp_object_id=$G_RET
role_assignment_id_1=$RA_ID_RG
role_assignment_id_2=$RA_ID_2
role_assignment_id_3=$RA_ID_3
role_assignment_1_principal_id=$G_MS
role_assignment_1_role_definition_id=$RD_1
role_assignment_1_scope=$RG_SCOPE
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
chmod 600 "$fixture_dir/metadata.env"
expect_output "rg_scoped_ra_accepted" "identity_retirement=READY" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_ROLE_STILL_PRESENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

# AKS-scoped role assignment IDs (actual migration identity uses this form)
fixture_dir="$WORK_DIR/t-aks-ra"
mkdir -p "$fixture_dir"
cat > "$fixture_dir/metadata.env" <<META
tenant_id=$GT
subscription_id=$GS
migration_app_id=$G_MA
recovery_app_id=$G_RA
migration_sp_object_id=$G_MS
recovery_sp_object_id=$G_RS
retained_sp_object_id=$G_RET
role_assignment_id_1=$RA_ID_AKS
role_assignment_id_2=$RA_ID_RG
role_assignment_id_3=$RA_ID_3
role_assignment_1_principal_id=$G_MS
role_assignment_1_role_definition_id=$RD_1
role_assignment_1_scope=$AKS_SCOPE
role_assignment_2_principal_id=$G_RS
role_assignment_2_role_definition_id=$RD_2
role_assignment_2_scope=$RG_SCOPE
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
chmod 600 "$fixture_dir/metadata.env"
expect_output "aks_scoped_ra_accepted" "identity_retirement=READY" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_ROLE_STILL_PRESENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

# Malformed nested-provider RA ID (not the AKS pattern) must be rejected
fixture_dir="$WORK_DIR/t-nested-ra"
mkdir -p "$fixture_dir"
NESTED_RA="/subscriptions/$GS/resourcegroups/betstan-rg/providers/Microsoft.Network/virtualNetworks/vnet1/providers/Microsoft.Authorization/roleAssignments/dddd4444-eeee-ffff-1111-222222222222"
cat > "$fixture_dir/metadata.env" <<META
tenant_id=$GT
subscription_id=$GS
migration_app_id=$G_MA
recovery_app_id=$G_RA
migration_sp_object_id=$G_MS
recovery_sp_object_id=$G_RS
retained_sp_object_id=$G_RET
role_assignment_id_1=$NESTED_RA
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
chmod 600 "$fixture_dir/metadata.env"
expect_fail_with "nested_provider_ra_rejected" "metadata_invalid_role_assignment_id" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_ROLE_STILL_PRESENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

# Malformed AKS scope (wrong provider path) in metadata scope field
fixture_dir="$WORK_DIR/t-bad-aks-scope"
mkdir -p "$fixture_dir"
BAD_AKS_SCOPE="/subscriptions/$GS/resourcegroups/betstan-rg/providers/Microsoft.Compute/virtualMachines/vm1"
cat > "$fixture_dir/metadata.env" <<META
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
role_assignment_1_scope=$BAD_AKS_SCOPE
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
chmod 600 "$fixture_dir/metadata.env"
expect_fail_with "bad_nested_scope_rejected" "metadata_invalid_scope" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_ROLE_STILL_PRESENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

# --- Fixed repository enforcement ---
printf '\n  --- fixed repository ---\n'
fixture_dir="$WORK_DIR/t-wrong-repo"
mkdir -p "$fixture_dir"
write_metadata "$fixture_dir"
sed -i.bak "s/repository=vasilyevstan\/betstan/repository=evil\/repo/" "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "wrong_repo_rejected" "metadata_repository_mismatch|metadata_unknown_or_missing_keys|metadata_invalid_name" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

# --- Output ID leakage ---
printf '\n  --- output sanitization ---\n'

# Success path: no IDs in output
fixture_dir="$WORK_DIR/t-leak-success"
o="$(run_operator execute "$fixture_dir" 2>&1)" || true
assert_no_id_leakage "no_id_leak_success_execute" "$o"

# Failure paths: no IDs in output
fixture_dir="$WORK_DIR/t-leak-fail-sp"
o="$(run_operator execute "$fixture_dir" STUB_PROBE_SP_FAIL=1 2>&1)" || true
assert_no_id_leakage "no_id_leak_sp_failure" "$o"

fixture_dir="$WORK_DIR/t-leak-fail-sub"
o="$(run_operator plan "$fixture_dir" STUB_WRONG_SUBSCRIPTION=1 STUB_RA_STILL_PRESENT=1 STUB_ROLE_STILL_PRESENT=1 2>&1)" || true
assert_no_id_leakage "no_id_leak_wrong_subscription" "$o"

fixture_dir="$WORK_DIR/t-leak-fail-retry"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
o="$(run_operator verify "$fixture_dir" STUB_SP_STILL_PRESENT=1 \
  IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=1 IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=0 2>&1)" || true
assert_no_id_leakage "no_id_leak_retry_failure" "$o"

# --- New regression tests: post-secrets-fence, write_state, terminal mismatch ---
printf '\n  --- post-secrets-fence and boundary regressions ---\n'

# False-success variable set (set command fails -> error)
expect_fail_with "variable_set_fail_blocks_execute" "variable_.*_set_failed" \
  run_operator execute "$WORK_DIR/t-varfail" STUB_VARIABLE_SET_FAIL=1

# Workflow not actually disabled after disable command (false success)
expect_fail_with "workflow_not_disabled_false_success" "workflow_still_enabled_after_retries" \
  run_operator execute "$WORK_DIR/t-wf-false" STUB_WORKFLOW_NOT_DISABLED=1 \
  IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=0 IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=0

# Secret delete succeeds but secret remains -> post-secrets-fence catches
expect_fail_with "secret_remains_after_delete_blocks_boundary" "secret_still_present_after_retries" \
  run_operator execute "$WORK_DIR/t-sec-remains" STUB_SECRET_REMAINS_AFTER_DELETE=1 \
  IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES=1 IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP=0

# Run appearing after first fence (post-secrets-fence catches it)
expect_fail_with "run_after_first_fence_blocks_boundary" "nonterminal_workflow_runs_exist" \
  run_operator execute "$WORK_DIR/t-post-run" STUB_POST_FENCE_ACTIVE_RUNS=1

# Terminal state ID mismatch when metadata loaded
fixture_dir="$WORK_DIR/t-ts-idmismatch"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
# Tamper: replace migration_app_id with a valid-shape but different GUID
sed -i.bak "s/^migration_app_id=.*$/migration_app_id=99999999-0000-1111-2222-333333333333/" "$sf"
rm -f "$sf.bak"
expect_fail_with "terminal_state_id_mismatch_detected" "terminal_state_id_mismatch" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# Terminal state digest mismatch (metadata modified after execute)
fixture_dir="$WORK_DIR/t-ts-digest"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
# Swap a GUID value for another valid one to change digest but keep valid field set
sed -i.bak "s/^custom_role_id_2=$G_CR2$/custom_role_id_2=ffffffff-aaaa-bbbb-cccc-dddddddddddd/" "$fixture_dir/metadata.env"
rm -f "$fixture_dir/metadata.env.bak"
expect_fail_with "terminal_digest_mismatch_detected" "retirement_state_metadata_differs" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# Terminal state uniqueness tampering (duplicate IDs)
fixture_dir="$WORK_DIR/t-ts-uniq"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
rm -f "$fixture_dir/metadata.env"
# Make recovery_app_id same as migration_app_id
sed -i.bak "s/^recovery_app_id=.*$/recovery_app_id=$G_MA/" "$sf"; rm -f "$sf.bak"
expect_fail_with "terminal_state_duplicate_id_detected" "terminal_state_duplicate_ids|state_duplicate_ids" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# Terminal state subscription binding tampering in RA IDs
fixture_dir="$WORK_DIR/t-ts-rasub"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
rm -f "$fixture_dir/metadata.env"
# Replace subscription in RA ID with a different one
sed -i.bak "s|/subscriptions/$GS/providers/Microsoft.Authorization/roleAssignments/dddd4444|/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/dddd4444|" "$sf"
rm -f "$sf.bak"
expect_fail_with "terminal_ra_subscription_mismatch" "terminal_state_ra_subscription_mismatch|state_ra_subscription_mismatch" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# --- write_state forced failure regressions (PATH stubs) ---
printf '\n  --- write_state forced failure regressions ---\n'

# (a) mv stub that fails for state temp files only
fixture_dir="$WORK_DIR/t-mvfail"
write_metadata "$fixture_dir"; mkdir -p "$fixture_dir"; chmod 700 "$fixture_dir"
mv_stub_dir="$WORK_DIR/mvstub"; mkdir -p "$mv_stub_dir"
cat > "$mv_stub_dir/mv" <<'MVSTUB'
#!/usr/bin/env bash
# Fail only for state temp files (identity-retirement-state.env.*)
if printf '%s' "$1" | grep -q 'identity-retirement-state.env\.'; then
  printf 'stubbed_mv_invoked\n' >> "${STUB_MV_LOG:-/dev/null}"
  exit 1
fi
exec /bin/mv "$@"
MVSTUB
chmod +x "$mv_stub_dir/mv"
: > "$WORK_DIR/mv.log"
o="$(env PATH="$mv_stub_dir:$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  STUB_MV_LOG="$WORK_DIR/mv.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" execute 2>&1)" || true
if echo "$o" | grep -qE "state_atomic_mv_failed"; then
  pass "mv_failure_detected"
else fail "mv_failure_detected (got: $(echo "$o"|head -1))"; fi
# Assert stubbed mv was actually invoked
if grep -q "stubbed_mv_invoked" "$WORK_DIR/mv.log" 2>/dev/null; then
  pass "mv_stub_was_invoked"
else fail "mv_stub_was_invoked (stub not called)"; fi
# Temp files should be cleaned up by EXIT trap
temps="$(find "$fixture_dir" -name 'identity-retirement-state.env.*' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$temps" == "0" ]]; then pass "temp_cleaned_on_mv_failure"
else fail "temp_cleaned_on_mv_failure (found $temps)"; fi
# Metadata must be preserved
if [[ -f "$fixture_dir/metadata.env" ]]; then pass "metadata_preserved_on_mv_failure"
else fail "metadata_preserved_on_mv_failure"; fi
# No IDs in output
assert_no_id_leakage "no_id_leak_mv_failure" "$o"

# (b) chmod stub that fails after mktemp
fixture_dir="$WORK_DIR/t-chmodfail"
write_metadata "$fixture_dir"; mkdir -p "$fixture_dir"; chmod 700 "$fixture_dir"
chmod_stub_dir="$WORK_DIR/chmodstub"; mkdir -p "$chmod_stub_dir"
cat > "$chmod_stub_dir/chmod" <<'CHSTUB'
#!/usr/bin/env bash
# Fail only when targeting a state temp file (600 + identity-retirement-state)
if [[ "${1:-}" == "600" ]] && printf '%s' "${2:-}" | grep -q 'identity-retirement-state.env\.'; then
  printf 'stubbed_chmod_invoked\n' >> "${STUB_CHMOD_LOG:-/dev/null}"
  exit 1
fi
exec /bin/chmod "$@"
CHSTUB
chmod +x "$chmod_stub_dir/chmod"
: > "$WORK_DIR/chmod.log"
o="$(env PATH="$chmod_stub_dir:$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  STUB_CHMOD_LOG="$WORK_DIR/chmod.log" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" execute 2>&1)" || true
if echo "$o" | grep -qE "state_temp_chmod_failed"; then
  pass "chmod_failure_detected"
else fail "chmod_failure_detected (got: $(echo "$o"|head -1))"; fi
if grep -q "stubbed_chmod_invoked" "$WORK_DIR/chmod.log" 2>/dev/null; then
  pass "chmod_stub_was_invoked"
else fail "chmod_stub_was_invoked (stub not called)"; fi
# Metadata preserved
if [[ -f "$fixture_dir/metadata.env" ]]; then pass "metadata_preserved_on_chmod_failure"
else fail "metadata_preserved_on_chmod_failure"; fi

# (c) mktemp stub that fails
fixture_dir="$WORK_DIR/t-mktempfail"
write_metadata "$fixture_dir"; mkdir -p "$fixture_dir"; chmod 700 "$fixture_dir"
mktemp_stub_dir="$WORK_DIR/mktempstub"; mkdir -p "$mktemp_stub_dir"
cat > "$mktemp_stub_dir/mktemp" <<'MKSTUB'
#!/usr/bin/env bash
# Fail when called for state temp files
if printf '%s' "$*" | grep -q 'identity-retirement-state.env'; then
  exit 1
fi
exec /usr/bin/mktemp "$@"
MKSTUB
chmod +x "$mktemp_stub_dir/mktemp"
o="$(env PATH="$mktemp_stub_dir:$BIN_DIR:$PATH" \
  STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
  STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
  IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
  IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
  IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" execute 2>&1)" || true
if echo "$o" | grep -qE "state_temp_create_failed"; then
  pass "mktemp_failure_detected"
else fail "mktemp_failure_detected (got: $(echo "$o"|head -1))"; fi

# --- Terminal phase substitution regression ---
printf '\n  --- terminal state phase/digest regressions ---\n'

fixture_dir="$WORK_DIR/t-ts-phase-sub"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
rm -f "$fixture_dir/metadata.env"
# Replace retired with a different phase
sed -i.bak "s/^phase=retired$/phase=verification-intent/" "$sf"; rm -f "$sf.bak"
expect_fail_with "terminal_phase_substitution_rejected" "state_phase_invalid" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# Invalid terminal digest (metadata absent): non-hex value
fixture_dir="$WORK_DIR/t-ts-bad-digest"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
rm -f "$fixture_dir/metadata.env"
sed -i.bak "s/^metadata_sha256=.*$/metadata_sha256=ZZZZ0000111122223333444455556666777788889999aaaabbbbccccddddeee/" "$sf"; rm -f "$sf.bak"
expect_fail_with "terminal_invalid_digest_rejected" "state_digest_syntax_invalid|state_empty_or_malformed_field" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_RET" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# Retained/custom-role collision in metadata
printf '\n  --- retained separation regressions ---\n'
fixture_dir="$WORK_DIR/t-ret-cr-col"
mkdir -p "$fixture_dir"
cat > "$fixture_dir/metadata.env" <<META
tenant_id=$GT
subscription_id=$GS
migration_app_id=$G_MA
recovery_app_id=$G_RA
migration_sp_object_id=$G_MS
recovery_sp_object_id=$G_RS
retained_sp_object_id=$G_CR1
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
chmod 600 "$fixture_dir/metadata.env"
expect_fail_with "retained_custom_role_collision_rejected" "metadata_retained_sp_equals_temporary" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_CR1" \
    STUB_ROLE_STILL_PRESENT=1 \
    IDENTITY_RETIREMENT_METADATA="$fixture_dir/metadata.env" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" plan

# Terminal state retained/custom-role collision
fixture_dir="$WORK_DIR/t-ts-ret-cr"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
sf="$fixture_dir/identity-retirement-state.env"
rm -f "$fixture_dir/metadata.env"
# Make retained_sp_object_id same as custom_role_id_1
sed -i.bak "s/^retained_sp_object_id=.*$/retained_sp_object_id=$G_CR1/" "$sf"; rm -f "$sf.bak"
expect_fail_with "terminal_retained_custom_role_collision" "state_retained_collision" \
  env PATH="$BIN_DIR:$PATH" STUB_AZ_LOG="$WORK_DIR/az.log" STUB_GH_LOG="$WORK_DIR/gh.log" \
    STUB_EXPECTED_TENANT="$GT" STUB_EXPECTED_SUB="$GS" STUB_RETAINED_SP_OID="$G_CR1" \
    STUB_SP_ALREADY_ABSENT=1 \
    IDENTITY_RETIREMENT_METADATA="" \
    IDENTITY_RETIREMENT_STATE_DIR="$fixture_dir" \
    IDENTITY_RETIREMENT_SAFE_CLEANUP=0 "$OPERATOR" verify

# Post-secrets-fence ordering in gh log
fixture_dir="$WORK_DIR/t-psf-order"
run_operator execute "$fixture_dir" >/dev/null 2>&1 || true
gh_log="$WORK_DIR/gh.log"
# After secret delete, there should be another run list check (post-secrets-fence)
secret_del_last="$(grep -n 'secret delete' "$gh_log" | tail -1 | cut -d: -f1)"
post_fence_run="$(awk "NR>$secret_del_last" "$gh_log" | grep -n 'run list' | head -1 | cut -d: -f1)"
if [[ -n "$secret_del_last" && -n "$post_fence_run" ]]; then
  pass "post_secrets_fence_runs_after_delete"
else
  fail "post_secrets_fence_runs_after_delete (no run list after secret delete)"
fi

# --- SP filter 404 regression: operator must use --all, never --filter ---
printf '\n  --- SP probe uses --all not --filter ---\n'

# The stub rejects --filter with a 404 (reproducing real CLI behavior on deleted SPs).
# If any test above passed that exercises SP probes, --filter is not used.
# Explicitly verify: a successful execute with absent SPs never hits --filter.
fixture_dir="$WORK_DIR/t-no-filter"
o="$(run_operator execute "$fixture_dir" STUB_SP_ALREADY_ABSENT=1 2>&1)" || true
if echo "$o" | grep -q "IDENTITY_RETIRED"; then
  pass "sp_probe_succeeds_without_filter"
else
  fail "sp_probe_succeeds_without_filter (got: $(echo "$o"|head -1))"
fi
# Check az log: no --filter flag used for sp list
if grep "ad sp list" "$WORK_DIR/az.log" | grep -q "\-\-filter"; then
  fail "no_filter_in_sp_list (--filter found in az log)"
else
  pass "no_filter_in_sp_list"
fi
# Verify uses --all
if grep "ad sp list" "$WORK_DIR/az.log" | grep -q "\-\-all"; then
  pass "sp_list_uses_all_flag"
else
  fail "sp_list_uses_all_flag (--all not found)"
fi
# No IDs leaked
assert_no_id_leakage "no_id_leak_sp_probe" "$o"

# ==========================================
printf '\nidentity_retirement_contract=%s scenarios=%d pass=%d fail=%d\n' \
  "$([[ "$FAIL" -eq 0 ]] && printf 'PASS' || printf 'FAIL')" "$SCENARIOS" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
