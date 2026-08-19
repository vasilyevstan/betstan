#!/usr/bin/env bash
set -euo pipefail

# Exact migration/recovery identity retirement operator.
# Deletes only the recorded temporary migration/recovery SPs, app registrations,
# role assignments, custom roles, GitHub environment secrets, and disables the
# oci-migration-recovery.yml workflow. Retains the general betstan-github-sp
# and repository AZURE_CREDENTIALS. Requires evidence from GitHub repository
# variables that recovery is disabled and ARM epoch is zero.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export ROOT_DIR
MODE="${1:-plan}"
METADATA_FILE="${IDENTITY_RETIREMENT_METADATA:-}"
STATE_DIR="${IDENTITY_RETIREMENT_STATE_DIR:-}"
SAFE_CLEANUP="${IDENTITY_RETIREMENT_SAFE_CLEANUP:-0}"
GH_REPOSITORY="${GH_REPOSITORY:-vasilyevstan/betstan}"

STATE_FILE=""
RESUME_STARTED=0

# Exact allowed metadata keys (order-independent, no extras permitted)
ALLOWED_KEYS=(
  tenant_id subscription_id migration_app_id recovery_app_id
  migration_sp_object_id recovery_sp_object_id retained_sp_object_id
  role_assignment_id_1 role_assignment_id_2 role_assignment_id_3
  custom_role_id_1 custom_role_id_2
  migration_environment recovery_environment
  retained_sp_display_name retained_secret_name repository
)

die() {
  printf 'NO_GO identity_retirement_reason=%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    die "required_command_unavailable:$1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# --- Input validation primitives ---

is_valid_guid() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

is_valid_role_assignment_id() {
  local id="$1"
  # Must be: /subscriptions/<GUID>/providers/Microsoft.Authorization/roleAssignments/<GUID>
  local pattern='^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/providers/Microsoft\.Authorization/roleAssignments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  [[ "$id" =~ $pattern ]]
}

has_control_chars() {
  # Reject any control characters (ASCII 0x00-0x1F, 0x7F) except none expected
  [[ "$1" =~ [[:cntrl:]] ]]
}

is_safe_name() {
  # Alphanumeric, hyphens, underscores, dots, slashes (for repo names)
  [[ "$1" =~ ^[a-zA-Z0-9._/@-]+$ ]]
}

validate_no_control_chars() {
  local label="$1" value="$2"
  if has_control_chars "$value"; then
    die "metadata_control_chars_in:$label"
  fi
}

validate_guid_field() {
  local label="$1" value="$2"
  validate_no_control_chars "$label" "$value"
  is_valid_guid "$value" || die "metadata_invalid_guid:$label"
}

validate_role_assignment_field() {
  local label="$1" value="$2"
  validate_no_control_chars "$label" "$value"
  is_valid_role_assignment_id "$value" || die "metadata_invalid_role_assignment_id:$label"
}

validate_role_assignment_subscription() {
  local label="$1" value="$2" expected_sub="$3"
  local embedded_sub
  embedded_sub="$(printf '%s' "$value" | sed -n 's|^/subscriptions/\([^/]*\)/.*|\1|p')"
  [[ "$embedded_sub" == "$expected_sub" ]] ||
    die "metadata_role_assignment_wrong_subscription:$label"
}

validate_safe_name_field() {
  local label="$1" value="$2"
  validate_no_control_chars "$label" "$value"
  is_safe_name "$value" || die "metadata_invalid_name:$label"
}

# --- Metadata parsing ---

env_value() {
  local file="$1"
  local key="$2"
  local count
  count="$(grep -c "^${key}=" "$file" || true)"
  [[ "$count" == "1" ]] ||
    die "metadata_missing_or_duplicate_field:$key"
  sed -n "s/^${key}=//p" "$file"
}

write_state() {
  local phase="$1"
  local temporary="${STATE_FILE}.tmp"
  {
    printf 'schema=betstan.identity-retirement.v1\n'
    printf 'phase=%s\n' "$phase"
    printf 'metadata_sha256=%s\n' "$(sha256_file "$METADATA_FILE")"
    printf 'tenant_id=%s\n' "$TENANT_ID"
    printf 'subscription_id=%s\n' "$SUBSCRIPTION_ID"
    printf 'repository=%s\n' "$GH_REPOSITORY"
  } > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$STATE_FILE"
}

validate_state_identity() {
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] ||
    die "retirement_state_missing"
  [[ "$(env_value "$STATE_FILE" schema)" == "betstan.identity-retirement.v1" ]] ||
    die "retirement_state_schema_differs"
  [[ "$(env_value "$STATE_FILE" metadata_sha256)" == "$(sha256_file "$METADATA_FILE")" ]] ||
    die "retirement_state_metadata_differs"
  [[ "$(env_value "$STATE_FILE" tenant_id)" == "$TENANT_ID" ]] ||
    die "retirement_state_tenant_differs"
  [[ "$(env_value "$STATE_FILE" subscription_id)" == "$SUBSCRIPTION_ID" ]] ||
    die "retirement_state_subscription_differs"
  [[ "$(env_value "$STATE_FILE" repository)" == "$GH_REPOSITORY" ]] ||
    die "retirement_state_repository_differs"
}

# --- Metadata field declarations ---
TENANT_ID=""
SUBSCRIPTION_ID=""
MIGRATION_APP_ID=""
RECOVERY_APP_ID=""
MIGRATION_SP_OBJECT_ID=""
RECOVERY_SP_OBJECT_ID=""
RETAINED_SP_OBJECT_ID=""
ROLE_ASSIGNMENT_ID_1=""
ROLE_ASSIGNMENT_ID_2=""
ROLE_ASSIGNMENT_ID_3=""
CUSTOM_ROLE_ID_1=""
CUSTOM_ROLE_ID_2=""
MIGRATION_ENV=""
RECOVERY_ENV=""
RETAINED_SP_DISPLAY_NAME=""
RETAINED_SECRET_NAME=""

load_metadata() {
  [[ -n "$METADATA_FILE" ]] || die "metadata_file_not_specified"
  [[ -f "$METADATA_FILE" && ! -L "$METADATA_FILE" ]] ||
    die "metadata_file_missing_or_symlink"

  # Reject malformed lines: every line must be key=value with safe key name
  local line_num=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_num=$((line_num + 1))
    [[ "$line" =~ ^[a-z_0-9]+= ]] ||
      die "metadata_malformed_line:$line_num"
  done < "$METADATA_FILE"

  # Reject unknown keys: extract all keys and ensure exact match against allowed set
  local file_keys
  file_keys="$(sed 's/=.*//' "$METADATA_FILE" | sort)"
  local expected_keys
  expected_keys="$(printf '%s\n' "${ALLOWED_KEYS[@]}" | sort)"
  [[ "$file_keys" == "$expected_keys" ]] ||
    die "metadata_unknown_or_missing_keys"

  # Parse exact fields
  TENANT_ID="$(env_value "$METADATA_FILE" tenant_id)"
  SUBSCRIPTION_ID="$(env_value "$METADATA_FILE" subscription_id)"
  MIGRATION_APP_ID="$(env_value "$METADATA_FILE" migration_app_id)"
  RECOVERY_APP_ID="$(env_value "$METADATA_FILE" recovery_app_id)"
  MIGRATION_SP_OBJECT_ID="$(env_value "$METADATA_FILE" migration_sp_object_id)"
  RECOVERY_SP_OBJECT_ID="$(env_value "$METADATA_FILE" recovery_sp_object_id)"
  RETAINED_SP_OBJECT_ID="$(env_value "$METADATA_FILE" retained_sp_object_id)"
  ROLE_ASSIGNMENT_ID_1="$(env_value "$METADATA_FILE" role_assignment_id_1)"
  ROLE_ASSIGNMENT_ID_2="$(env_value "$METADATA_FILE" role_assignment_id_2)"
  ROLE_ASSIGNMENT_ID_3="$(env_value "$METADATA_FILE" role_assignment_id_3)"
  CUSTOM_ROLE_ID_1="$(env_value "$METADATA_FILE" custom_role_id_1)"
  CUSTOM_ROLE_ID_2="$(env_value "$METADATA_FILE" custom_role_id_2)"
  MIGRATION_ENV="$(env_value "$METADATA_FILE" migration_environment)"
  RECOVERY_ENV="$(env_value "$METADATA_FILE" recovery_environment)"
  RETAINED_SP_DISPLAY_NAME="$(env_value "$METADATA_FILE" retained_sp_display_name)"
  RETAINED_SECRET_NAME="$(env_value "$METADATA_FILE" retained_secret_name)"

  # Validate non-empty
  local field
  for field in TENANT_ID SUBSCRIPTION_ID MIGRATION_APP_ID RECOVERY_APP_ID \
    MIGRATION_SP_OBJECT_ID RECOVERY_SP_OBJECT_ID RETAINED_SP_OBJECT_ID \
    ROLE_ASSIGNMENT_ID_1 ROLE_ASSIGNMENT_ID_2 ROLE_ASSIGNMENT_ID_3 \
    CUSTOM_ROLE_ID_1 CUSTOM_ROLE_ID_2 \
    MIGRATION_ENV RECOVERY_ENV RETAINED_SP_DISPLAY_NAME RETAINED_SECRET_NAME; do
    [[ -n "${!field}" ]] || die "metadata_empty_field:$field"
  done

  # Syntactic validation: GUIDs
  validate_guid_field "tenant_id" "$TENANT_ID"
  validate_guid_field "subscription_id" "$SUBSCRIPTION_ID"
  validate_guid_field "migration_app_id" "$MIGRATION_APP_ID"
  validate_guid_field "recovery_app_id" "$RECOVERY_APP_ID"
  validate_guid_field "migration_sp_object_id" "$MIGRATION_SP_OBJECT_ID"
  validate_guid_field "recovery_sp_object_id" "$RECOVERY_SP_OBJECT_ID"
  validate_guid_field "retained_sp_object_id" "$RETAINED_SP_OBJECT_ID"
  validate_guid_field "custom_role_id_1" "$CUSTOM_ROLE_ID_1"
  validate_guid_field "custom_role_id_2" "$CUSTOM_ROLE_ID_2"

  # Syntactic validation: role assignment resource IDs
  validate_role_assignment_field "role_assignment_id_1" "$ROLE_ASSIGNMENT_ID_1"
  validate_role_assignment_field "role_assignment_id_2" "$ROLE_ASSIGNMENT_ID_2"
  validate_role_assignment_field "role_assignment_id_3" "$ROLE_ASSIGNMENT_ID_3"

  # Semantic: role assignments must reference the correct subscription
  validate_role_assignment_subscription "role_assignment_id_1" \
    "$ROLE_ASSIGNMENT_ID_1" "$SUBSCRIPTION_ID"
  validate_role_assignment_subscription "role_assignment_id_2" \
    "$ROLE_ASSIGNMENT_ID_2" "$SUBSCRIPTION_ID"
  validate_role_assignment_subscription "role_assignment_id_3" \
    "$ROLE_ASSIGNMENT_ID_3" "$SUBSCRIPTION_ID"

  # Syntactic validation: safe names (no injection)
  validate_safe_name_field "migration_environment" "$MIGRATION_ENV"
  validate_safe_name_field "recovery_environment" "$RECOVERY_ENV"
  validate_safe_name_field "retained_sp_display_name" "$RETAINED_SP_DISPLAY_NAME"
  validate_safe_name_field "retained_secret_name" "$RETAINED_SECRET_NAME"
  validate_safe_name_field "repository" "$(env_value "$METADATA_FILE" repository)"

  # Exact expected fixed names
  [[ "$RETAINED_SP_DISPLAY_NAME" == "betstan-github-sp" ]] ||
    die "metadata_retained_sp_name_mismatch"
  [[ "$RETAINED_SECRET_NAME" == "AZURE_CREDENTIALS" ]] ||
    die "metadata_retained_secret_name_mismatch"

  # Reject duplicates across identities
  [[ "$MIGRATION_APP_ID" != "$RECOVERY_APP_ID" ]] ||
    die "metadata_duplicate_app_ids"
  [[ "$MIGRATION_SP_OBJECT_ID" != "$RECOVERY_SP_OBJECT_ID" ]] ||
    die "metadata_duplicate_sp_object_ids"
  [[ "$CUSTOM_ROLE_ID_1" != "$CUSTOM_ROLE_ID_2" ]] ||
    die "metadata_duplicate_custom_role_ids"
  [[ "$ROLE_ASSIGNMENT_ID_1" != "$ROLE_ASSIGNMENT_ID_2" ]] ||
    die "metadata_duplicate_role_assignment_ids"
  [[ "$ROLE_ASSIGNMENT_ID_1" != "$ROLE_ASSIGNMENT_ID_3" ]] ||
    die "metadata_duplicate_role_assignment_ids"
  [[ "$ROLE_ASSIGNMENT_ID_2" != "$ROLE_ASSIGNMENT_ID_3" ]] ||
    die "metadata_duplicate_role_assignment_ids"

  # Retained SP must not equal any temporary SP
  [[ "$RETAINED_SP_OBJECT_ID" != "$MIGRATION_SP_OBJECT_ID" ]] ||
    die "metadata_retained_sp_equals_temporary"
  [[ "$RETAINED_SP_OBJECT_ID" != "$RECOVERY_SP_OBJECT_ID" ]] ||
    die "metadata_retained_sp_equals_temporary"
}

# --- GitHub repository variable queries (evidence, not caller assertions) ---

query_recovery_variable() {
  local value
  value="$(gh variable get OCI_MIGRATION_RECOVERY_ENABLED \
    --repo "$GH_REPOSITORY" 2>/dev/null)" ||
    die "recovery_variable_query_failed"
  [[ "$value" == "false" ]] ||
    die "recovery_enabled_must_be_false:actual=$value"
}

query_arm_variable() {
  local value
  value="$(gh variable get OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH \
    --repo "$GH_REPOSITORY" 2>/dev/null)" ||
    die "arm_variable_query_failed"
  [[ "$value" == "0" ]] ||
    die "arm_epoch_must_be_zero:actual=$value"
}

set_recovery_variable() {
  gh variable set OCI_MIGRATION_RECOVERY_ENABLED --repo "$GH_REPOSITORY" \
    --body "false" 2>/dev/null ||
    die "recovery_variable_set_failed"
}

set_arm_variable() {
  gh variable set OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH --repo "$GH_REPOSITORY" \
    --body "0" 2>/dev/null ||
    die "arm_variable_set_failed"
}

verify_azure_context() {
  local actual_sub
  actual_sub="$(az account show --query 'id' -o tsv)" ||
    die "azure_account_unavailable"
  [[ "$actual_sub" == "$SUBSCRIPTION_ID" ]] ||
    die "wrong_subscription:expected=$SUBSCRIPTION_ID,actual=$actual_sub"

  local actual_tenant
  actual_tenant="$(az account show --query 'tenantId' -o tsv)" ||
    die "azure_tenant_unavailable"
  [[ "$actual_tenant" == "$TENANT_ID" ]] ||
    die "wrong_tenant:expected=$TENANT_ID,actual=$actual_tenant"
}

verify_retained_identity() {
  # Prove retained SP exists by exact object ID and validate displayName
  local sp_json
  sp_json="$(az ad sp show --id "$RETAINED_SP_OBJECT_ID" -o json 2>/dev/null)" ||
    die "retained_sp_not_found:$RETAINED_SP_OBJECT_ID"
  local actual_display
  actual_display="$(printf '%s' "$sp_json" | jq -r '.displayName // empty')"
  [[ "$actual_display" == "$RETAINED_SP_DISPLAY_NAME" ]] ||
    die "retained_sp_display_name_mismatch:expected=$RETAINED_SP_DISPLAY_NAME,actual=$actual_display"

  # Prove repository AZURE_CREDENTIALS secret exists (exact first-column match)
  local secret_names
  secret_names="$(gh secret list --repo "$GH_REPOSITORY" 2>/dev/null |
    awk '{print $1}')" ||
    die "retained_secret_query_failed"
  printf '%s\n' "$secret_names" | grep -qxF "$RETAINED_SECRET_NAME" ||
    die "retained_secret_not_found:$RETAINED_SECRET_NAME"
}

verify_gh_repository() {
  local expected_repo
  expected_repo="$(env_value "$METADATA_FILE" repository)"
  [[ "$expected_repo" == "$GH_REPOSITORY" ]] ||
    die "wrong_repository:expected=$expected_repo,actual=$GH_REPOSITORY"
}

# --- Deletion helpers (tolerate already-absent) ---

delete_role_assignment() {
  local assignment_id="$1"
  local rc=0
  az role assignment delete --ids "$assignment_id" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    if az role assignment list --query "[?id=='$assignment_id']" -o tsv 2>/dev/null |
      grep -q .; then
      die "role_assignment_delete_failed:$assignment_id"
    fi
  fi
}

delete_sp() {
  local object_id="$1"
  local rc=0
  az ad sp delete --id "$object_id" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    if az ad sp show --id "$object_id" >/dev/null 2>&1; then
      die "sp_delete_failed:$object_id"
    fi
  fi
}

delete_app_registration() {
  local app_id="$1"
  local rc=0
  az ad app delete --id "$app_id" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    if az ad app show --id "$app_id" >/dev/null 2>&1; then
      die "app_registration_delete_failed:$app_id"
    fi
  fi
}

delete_custom_role() {
  local role_id="$1"
  local rc=0
  az role definition delete --name "$role_id" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    local count
    count="$(az role definition list --name "$role_id" \
      --query 'length(@)' -o tsv 2>/dev/null || echo 0)"
    if [[ "$count" != "0" ]]; then
      die "custom_role_delete_failed:$role_id"
    fi
  fi
}

delete_environment_secret() {
  local env_name="$1"
  local secret_name="$2"
  local rc=0
  gh secret delete "$secret_name" --repo "$GH_REPOSITORY" \
    --env "$env_name" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    if gh secret list --repo "$GH_REPOSITORY" --env "$env_name" 2>/dev/null |
      awk '{print $1}' | grep -qxF "$secret_name"; then
      die "github_secret_delete_failed:$env_name/$secret_name"
    fi
  fi
}

disable_workflow() {
  local workflow_file="$1"
  if ! gh workflow disable "$workflow_file" --repo "$GH_REPOSITORY" 2>/dev/null; then
    local state
    state="$(gh workflow view "$workflow_file" --repo "$GH_REPOSITORY" \
      --json state --jq '.state' 2>/dev/null || true)"
    [[ "$state" == "disabled_manually" || "$state" == "disabled" ]] ||
      die "workflow_disable_failed:$workflow_file"
  fi
}

# --- Verification helpers ---

verify_sp_absent() {
  local object_id="$1"
  if az ad sp show --id "$object_id" >/dev/null 2>&1; then
    die "sp_still_present:$object_id"
  fi
}

verify_app_absent() {
  local app_id="$1"
  if az ad app show --id "$app_id" >/dev/null 2>&1; then
    die "app_still_present:$app_id"
  fi
}

verify_role_assignment_absent() {
  local assignment_id="$1"
  local result
  result="$(az role assignment list --query "[?id=='$assignment_id']" \
    -o tsv 2>/dev/null || true)"
  [[ -z "$result" ]] || die "role_assignment_still_present:$assignment_id"
}

verify_custom_role_absent() {
  local role_id="$1"
  local count
  count="$(az role definition list --name "$role_id" \
    --query 'length(@)' -o tsv 2>/dev/null || true)"
  [[ "$count" == "0" || -z "$count" ]] || die "custom_role_still_present:$role_id"
}

verify_secret_absent() {
  local env_name="$1"
  local secret_name="$2"
  if gh secret list --repo "$GH_REPOSITORY" --env "$env_name" 2>/dev/null |
    awk '{print $1}' | grep -qxF "$secret_name"; then
    die "secret_still_present:$env_name/$secret_name"
  fi
}

verify_workflow_disabled() {
  local workflow_file="$1"
  local state
  state="$(gh workflow view "$workflow_file" --repo "$GH_REPOSITORY" \
    --json state --jq '.state' 2>/dev/null || true)"
  [[ "$state" == "disabled_manually" || "$state" == "disabled" ]] ||
    die "workflow_still_enabled:$workflow_file"
}

# --- Main ---

require_command az
require_command gh
require_command jq

load_metadata
verify_gh_repository

[[ -n "$STATE_DIR" ]] || die "state_dir_not_specified"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
STATE_FILE="$STATE_DIR/identity-retirement-state.env"

case "$MODE" in
  plan)
    verify_azure_context
    query_recovery_variable
    query_arm_variable
    verify_retained_identity

    printf 'identity_retirement=READY phase=plan '
    printf 'role_assignments=3 sps=2 apps=2 custom_roles=2 '
    printf 'secrets=2 workflow=oci-migration-recovery.yml\n'
    ;;

  execute)
    verify_azure_context
    query_recovery_variable
    query_arm_variable

    # Explicitly enforce recovery=false and arm=0 before/during execution
    set_recovery_variable
    set_arm_variable

    if [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]]; then
      validate_state_identity
      RESUME_STARTED=1
    fi

    local_phase="initialized"
    if [[ "$RESUME_STARTED" == "1" ]]; then
      local_phase="$(env_value "$STATE_FILE" phase)"
    fi

    while true; do
      case "$local_phase" in
        initialized)
          verify_retained_identity
          write_state role-assignments-intent
          local_phase=role-assignments-intent
          ;;
        role-assignments-intent)
          delete_role_assignment "$ROLE_ASSIGNMENT_ID_1"
          delete_role_assignment "$ROLE_ASSIGNMENT_ID_2"
          delete_role_assignment "$ROLE_ASSIGNMENT_ID_3"
          write_state sps-intent
          local_phase=sps-intent
          ;;
        sps-intent)
          delete_sp "$MIGRATION_SP_OBJECT_ID"
          delete_sp "$RECOVERY_SP_OBJECT_ID"
          write_state apps-intent
          local_phase=apps-intent
          ;;
        apps-intent)
          delete_app_registration "$MIGRATION_APP_ID"
          delete_app_registration "$RECOVERY_APP_ID"
          write_state custom-roles-intent
          local_phase=custom-roles-intent
          ;;
        custom-roles-intent)
          delete_custom_role "$CUSTOM_ROLE_ID_1"
          delete_custom_role "$CUSTOM_ROLE_ID_2"
          write_state secrets-intent
          local_phase=secrets-intent
          ;;
        secrets-intent)
          delete_environment_secret "$MIGRATION_ENV" \
            "OCI_MIGRATION_AZURE_CREDENTIALS"
          delete_environment_secret "$RECOVERY_ENV" \
            "AZURE_MIGRATION_RECOVERY_CREDENTIALS"
          write_state workflow-intent
          local_phase=workflow-intent
          ;;
        workflow-intent)
          set_recovery_variable
          set_arm_variable
          disable_workflow "oci-migration-recovery.yml"
          write_state retired
          local_phase=retired
          ;;
        retired)
          verify_retained_identity
          query_recovery_variable
          query_arm_variable
          printf 'IDENTITY_RETIRED objects_deleted=9 secrets_deleted=2 workflow_disabled=1\n'
          break
          ;;
        *)
          die "unknown_state_phase:$local_phase"
          ;;
      esac
    done
    ;;

  verify)
    verify_azure_context
    query_recovery_variable
    query_arm_variable

    if [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]]; then
      validate_state_identity
      [[ "$(env_value "$STATE_FILE" phase)" == "retired" ]] ||
        die "verify_requires_retired_state"
    else
      die "retirement_state_missing"
    fi

    # Verify all temporary objects absent
    verify_role_assignment_absent "$ROLE_ASSIGNMENT_ID_1"
    verify_role_assignment_absent "$ROLE_ASSIGNMENT_ID_2"
    verify_role_assignment_absent "$ROLE_ASSIGNMENT_ID_3"
    verify_sp_absent "$MIGRATION_SP_OBJECT_ID"
    verify_sp_absent "$RECOVERY_SP_OBJECT_ID"
    verify_app_absent "$MIGRATION_APP_ID"
    verify_app_absent "$RECOVERY_APP_ID"
    verify_custom_role_absent "$CUSTOM_ROLE_ID_1"
    verify_custom_role_absent "$CUSTOM_ROLE_ID_2"
    verify_secret_absent "$MIGRATION_ENV" "OCI_MIGRATION_AZURE_CREDENTIALS"
    verify_secret_absent "$RECOVERY_ENV" "AZURE_MIGRATION_RECOVERY_CREDENTIALS"
    verify_workflow_disabled "oci-migration-recovery.yml"

    # Prove retained identity still intact
    verify_retained_identity

    printf 'IDENTITY_RETIREMENT_VERIFIED all_temporary_objects_absent=true retained_identity_intact=true\n'

    # Cleanup private metadata only after terminal verification;
    # state file is preserved for auditability
    if [[ "$SAFE_CLEANUP" == "1" ]]; then
      rm -f "$METADATA_FILE"
      printf 'metadata_cleaned=true\n'
    fi
    ;;

  *)
    die "unknown_mode:$MODE"
    ;;
esac
