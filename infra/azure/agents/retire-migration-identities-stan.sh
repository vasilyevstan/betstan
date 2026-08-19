#!/usr/bin/env bash
set -euo pipefail

# Exact migration/recovery identity retirement operator.
# Verifies exact object relationships before writing deletion intent.
# All presence probes are fail-closed: API errors are fatal.
# Closes GitHub execution (guards, workflow, secrets) before crossing
# the identity boundary (role-assignments, SPs, apps, custom-roles).
# Terminal state is written only after full verification-intent proves
# all temporary objects absent.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export ROOT_DIR
MODE="${1:-plan}"
METADATA_FILE="${IDENTITY_RETIREMENT_METADATA:-}"
STATE_DIR="${IDENTITY_RETIREMENT_STATE_DIR:-}"
SAFE_CLEANUP="${IDENTITY_RETIREMENT_SAFE_CLEANUP:-0}"
# Fixed repository - never accept arbitrary caller values
GH_REPOSITORY="vasilyevstan/betstan"

STATE_FILE=""
RESUME_STARTED=0

# Bounded propagation retry configuration (safe test defaults: no retries)
VERIFY_MAX_RETRIES="${IDENTITY_RETIREMENT_VERIFY_MAX_RETRIES:-0}"
VERIFY_RETRY_SLEEP="${IDENTITY_RETIREMENT_VERIFY_RETRY_SLEEP:-0}"

# Exact metadata field set (28 keys)
ALLOWED_KEYS=(
  tenant_id subscription_id
  migration_app_id recovery_app_id
  migration_sp_object_id recovery_sp_object_id retained_sp_object_id
  role_assignment_id_1 role_assignment_id_2 role_assignment_id_3
  role_assignment_1_principal_id role_assignment_1_role_definition_id role_assignment_1_scope
  role_assignment_2_principal_id role_assignment_2_role_definition_id role_assignment_2_scope
  role_assignment_3_principal_id role_assignment_3_role_definition_id role_assignment_3_scope
  custom_role_id_1 custom_role_id_2
  custom_role_1_assignable_scope custom_role_2_assignable_scope
  migration_environment recovery_environment
  retained_sp_display_name retained_secret_name repository
)

# Exact intermediate state field set (6 keys)
INTERMEDIATE_STATE_KEYS=(schema phase metadata_sha256 tenant_id subscription_id repository)

# Exact terminal state field set (23 keys)
TERMINAL_STATE_KEYS=(
  schema phase metadata_sha256
  tenant_id subscription_id repository
  migration_app_id recovery_app_id
  migration_sp_object_id recovery_sp_object_id
  role_assignment_id_1 role_assignment_id_2 role_assignment_id_3
  custom_role_id_1 custom_role_id_2
  retained_sp_object_id retained_sp_display_name retained_secret_name
  migration_environment recovery_environment
  migration_secret_name recovery_secret_name workflow_name
)

# All nonterminal workflow run statuses to fence
RUN_STATUSES=(queued in_progress waiting pending requested)

# Both workflows to fence before identity boundary
FENCED_WORKFLOWS=(oci-migrate.yml oci-migration-recovery.yml)

die() {
  printf 'NO_GO identity_retirement_reason=%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required_command_unavailable"
}

validate_retry_config() {
  [[ "$VERIFY_MAX_RETRIES" =~ ^[0-9]+$ ]] || die "verify_max_retries_not_integer"
  [[ "$VERIFY_RETRY_SLEEP" =~ ^[0-9]+$ ]] || die "verify_retry_sleep_not_integer"
  [[ "$VERIFY_MAX_RETRIES" -le 30 ]] || die "verify_max_retries_exceeds_bound"
  [[ "$VERIFY_RETRY_SLEEP" -le 60 ]] || die "verify_retry_sleep_exceeds_bound"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# --- Validation primitives ---

is_valid_guid() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

is_valid_role_assignment_id() {
  # Accept subscription-scoped or resource-group-scoped role assignments
  local pattern='^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/resourceGroups/[a-zA-Z0-9._-]+)?/providers/Microsoft\.Authorization/roleAssignments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  [[ "$1" =~ $pattern ]]
}

is_valid_role_definition_id() {
  local pattern='^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/providers/Microsoft\.Authorization/roleDefinitions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  [[ "$1" =~ $pattern ]]
}

is_valid_scope() {
  local pattern='^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/resourceGroups/[a-zA-Z0-9._-]+)?$'
  [[ "$1" =~ $pattern ]]
}

has_control_chars() { [[ "$1" =~ [[:cntrl:]] ]]; }
is_safe_name() { [[ "$1" =~ ^[a-zA-Z0-9._/@-]+$ ]]; }

validate_no_control_chars() {
  local label="$1" value="$2"
  has_control_chars "$value" && die "metadata_control_chars"
  return 0
}

validate_guid_field() {
  local label="$1" value="$2"
  validate_no_control_chars "$label" "$value"
  is_valid_guid "$value" || die "metadata_invalid_guid"
}

validate_role_assignment_id_field() {
  local label="$1" value="$2"
  validate_no_control_chars "$label" "$value"
  is_valid_role_assignment_id "$value" || die "metadata_invalid_role_assignment_id"
}

validate_role_definition_id_field() {
  local label="$1" value="$2"
  validate_no_control_chars "$label" "$value"
  is_valid_role_definition_id "$value" || die "metadata_invalid_role_definition_id"
}

validate_scope_field() {
  local label="$1" value="$2"
  validate_no_control_chars "$label" "$value"
  is_valid_scope "$value" || die "metadata_invalid_scope"
}

validate_safe_name_field() {
  local label="$1" value="$2"
  validate_no_control_chars "$label" "$value"
  is_safe_name "$value" || die "metadata_invalid_name"
}

validate_subscription_binding() {
  local label="$1" value="$2" expected_sub="$3"
  local embedded
  embedded="$(printf '%s' "$value" | sed -n 's|^/subscriptions/\([^/]*\).*$|\1|p')"
  [[ "$embedded" == "$expected_sub" ]] || die "metadata_wrong_subscription_binding"
}

# --- Metadata parsing ---

env_value() {
  local file="$1" key="$2" count
  count="$(grep -c "^${key}=" "$file" || true)"
  [[ "$count" == "1" ]] || die "field_missing_or_duplicate"
  sed -n "s/^${key}=//p" "$file"
}

# --- State file management ---

write_state() {
  local phase="$1"
  # Use mktemp in same directory; cleanup on any failure
  local temporary
  temporary="$(mktemp "${STATE_FILE}.XXXXXXXX")" || die "state_temp_create_failed"
  chmod 600 "$temporary"
  # Cleanup trap for this subshell scope
  _state_temp_cleanup() { rm -f "$temporary" 2>/dev/null; }
  trap _state_temp_cleanup EXIT

  if [[ "$phase" == "retired" ]]; then
    {
      printf 'schema=betstan.identity-retirement-terminal.v1\n'
      printf 'phase=retired\n'
      printf 'metadata_sha256=%s\n' "$(sha256_file "$METADATA_FILE")"
      printf 'tenant_id=%s\n' "$TENANT_ID"
      printf 'subscription_id=%s\n' "$SUBSCRIPTION_ID"
      printf 'repository=%s\n' "$GH_REPOSITORY"
      printf 'migration_app_id=%s\n' "$MIGRATION_APP_ID"
      printf 'recovery_app_id=%s\n' "$RECOVERY_APP_ID"
      printf 'migration_sp_object_id=%s\n' "$MIGRATION_SP_OBJECT_ID"
      printf 'recovery_sp_object_id=%s\n' "$RECOVERY_SP_OBJECT_ID"
      printf 'role_assignment_id_1=%s\n' "$ROLE_ASSIGNMENT_ID_1"
      printf 'role_assignment_id_2=%s\n' "$ROLE_ASSIGNMENT_ID_2"
      printf 'role_assignment_id_3=%s\n' "$ROLE_ASSIGNMENT_ID_3"
      printf 'custom_role_id_1=%s\n' "$CUSTOM_ROLE_ID_1"
      printf 'custom_role_id_2=%s\n' "$CUSTOM_ROLE_ID_2"
      printf 'retained_sp_object_id=%s\n' "$RETAINED_SP_OBJECT_ID"
      printf 'retained_sp_display_name=%s\n' "$RETAINED_SP_DISPLAY_NAME"
      printf 'retained_secret_name=%s\n' "$RETAINED_SECRET_NAME"
      printf 'migration_environment=%s\n' "$MIGRATION_ENV"
      printf 'recovery_environment=%s\n' "$RECOVERY_ENV"
      printf 'migration_secret_name=OCI_MIGRATION_AZURE_CREDENTIALS\n'
      printf 'recovery_secret_name=AZURE_MIGRATION_RECOVERY_CREDENTIALS\n'
      printf 'workflow_name=oci-migration-recovery.yml\n'
    } > "$temporary"
  else
    {
      printf 'schema=betstan.identity-retirement.v1\n'
      printf 'phase=%s\n' "$phase"
      printf 'metadata_sha256=%s\n' "$(sha256_file "$METADATA_FILE")"
      printf 'tenant_id=%s\n' "$TENANT_ID"
      printf 'subscription_id=%s\n' "$SUBSCRIPTION_ID"
      printf 'repository=%s\n' "$GH_REPOSITORY"
    } > "$temporary"
  fi

  # Validate temp was written correctly
  [[ -s "$temporary" ]] || die "state_temp_write_failed"
  mv "$temporary" "$STATE_FILE" || die "state_atomic_mv_failed"
  trap - EXIT
}

# --- State validation ---

validate_exact_field_set() {
  local file="$1"; shift
  local -a expected_keys=("$@")
  local file_keys expected_sorted
  file_keys="$(sed 's/=.*//' "$file" | sort)"
  expected_sorted="$(printf '%s\n' "${expected_keys[@]}" | sort)"
  [[ "$file_keys" == "$expected_sorted" ]] || die "state_field_set_mismatch"
  # Reject duplicates
  local unique_count total_count
  unique_count="$(sed 's/=.*//' "$file" | sort -u | wc -l | tr -d ' ')"
  total_count="$(wc -l < "$file" | tr -d ' ')"
  [[ "$unique_count" == "$total_count" ]] || die "state_duplicate_fields"
  # Reject empty values
  local line
  while IFS= read -r line; do
    [[ "$line" =~ ^[a-z_0-9]+=.+$ ]] || die "state_empty_or_malformed_field"
  done < "$file"
}

validate_state_identity() {
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || die "retirement_state_missing"
  local state_perms
  state_perms="$(stat -f '%Lp' "$STATE_FILE" 2>/dev/null || stat -c '%a' "$STATE_FILE" 2>/dev/null)"
  [[ "$state_perms" == "600" ]] || die "state_file_wrong_permissions"
  local state_schema
  state_schema="$(env_value "$STATE_FILE" schema)"
  if [[ "$state_schema" == "betstan.identity-retirement.v1" ]]; then
    validate_exact_field_set "$STATE_FILE" "${INTERMEDIATE_STATE_KEYS[@]}"
    [[ "$(env_value "$STATE_FILE" metadata_sha256)" == "$(sha256_file "$METADATA_FILE")" ]] ||
      die "retirement_state_metadata_differs"
  elif [[ "$state_schema" == "betstan.identity-retirement-terminal.v1" ]]; then
    validate_exact_field_set "$STATE_FILE" "${TERMINAL_STATE_KEYS[@]}"
  else
    die "retirement_state_schema_invalid"
  fi
  [[ "$(env_value "$STATE_FILE" tenant_id)" == "$TENANT_ID" ]] ||
    die "retirement_state_tenant_differs"
  [[ "$(env_value "$STATE_FILE" subscription_id)" == "$SUBSCRIPTION_ID" ]] ||
    die "retirement_state_subscription_differs"
  [[ "$(env_value "$STATE_FILE" repository)" == "$GH_REPOSITORY" ]] ||
    die "retirement_state_repository_differs"
}

# Load all bindings from terminal state file (post-cleanup verify path).
# Only valid for terminal schema; non-terminal state NEVER bypasses metadata.
load_from_terminal_state() {
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || die "retirement_state_missing"
  local state_perms
  state_perms="$(stat -f '%Lp' "$STATE_FILE" 2>/dev/null || stat -c '%a' "$STATE_FILE" 2>/dev/null)"
  [[ "$state_perms" == "600" ]] || die "state_file_wrong_permissions"
  local state_schema
  state_schema="$(env_value "$STATE_FILE" schema)"
  [[ "$state_schema" == "betstan.identity-retirement-terminal.v1" ]] ||
    die "state_not_terminal_schema:cannot_verify_without_metadata"
  validate_exact_field_set "$STATE_FILE" "${TERMINAL_STATE_KEYS[@]}"
  [[ "$(env_value "$STATE_FILE" phase)" == "retired" ]] ||
    die "state_not_retired:cannot_verify_without_metadata"

  TENANT_ID="$(env_value "$STATE_FILE" tenant_id)"
  SUBSCRIPTION_ID="$(env_value "$STATE_FILE" subscription_id)"
  MIGRATION_APP_ID="$(env_value "$STATE_FILE" migration_app_id)"
  RECOVERY_APP_ID="$(env_value "$STATE_FILE" recovery_app_id)"
  MIGRATION_SP_OBJECT_ID="$(env_value "$STATE_FILE" migration_sp_object_id)"
  RECOVERY_SP_OBJECT_ID="$(env_value "$STATE_FILE" recovery_sp_object_id)"
  RETAINED_SP_OBJECT_ID="$(env_value "$STATE_FILE" retained_sp_object_id)"
  ROLE_ASSIGNMENT_ID_1="$(env_value "$STATE_FILE" role_assignment_id_1)"
  ROLE_ASSIGNMENT_ID_2="$(env_value "$STATE_FILE" role_assignment_id_2)"
  ROLE_ASSIGNMENT_ID_3="$(env_value "$STATE_FILE" role_assignment_id_3)"
  CUSTOM_ROLE_ID_1="$(env_value "$STATE_FILE" custom_role_id_1)"
  CUSTOM_ROLE_ID_2="$(env_value "$STATE_FILE" custom_role_id_2)"
  MIGRATION_ENV="$(env_value "$STATE_FILE" migration_environment)"
  RECOVERY_ENV="$(env_value "$STATE_FILE" recovery_environment)"
  RETAINED_SP_DISPLAY_NAME="$(env_value "$STATE_FILE" retained_sp_display_name)"
  RETAINED_SECRET_NAME="$(env_value "$STATE_FILE" retained_secret_name)"

  # Validate every terminal value
  validate_guid_field "tenant_id" "$TENANT_ID"
  validate_guid_field "subscription_id" "$SUBSCRIPTION_ID"
  validate_guid_field "migration_app_id" "$MIGRATION_APP_ID"
  validate_guid_field "recovery_app_id" "$RECOVERY_APP_ID"
  validate_guid_field "migration_sp_object_id" "$MIGRATION_SP_OBJECT_ID"
  validate_guid_field "recovery_sp_object_id" "$RECOVERY_SP_OBJECT_ID"
  validate_guid_field "retained_sp_object_id" "$RETAINED_SP_OBJECT_ID"
  validate_guid_field "custom_role_id_1" "$CUSTOM_ROLE_ID_1"
  validate_guid_field "custom_role_id_2" "$CUSTOM_ROLE_ID_2"
  is_valid_role_assignment_id "$ROLE_ASSIGNMENT_ID_1" || die "terminal_state_invalid_ra_id"
  is_valid_role_assignment_id "$ROLE_ASSIGNMENT_ID_2" || die "terminal_state_invalid_ra_id"
  is_valid_role_assignment_id "$ROLE_ASSIGNMENT_ID_3" || die "terminal_state_invalid_ra_id"

  # Validate fixed bindings
  [[ "$RETAINED_SP_DISPLAY_NAME" == "betstan-github-sp" ]] || die "terminal_state_fixed_name_mismatch"
  [[ "$RETAINED_SECRET_NAME" == "AZURE_CREDENTIALS" ]] || die "terminal_state_fixed_name_mismatch"
  [[ "$MIGRATION_ENV" == "oci-migration" ]] || die "terminal_state_fixed_name_mismatch"
  [[ "$RECOVERY_ENV" == "azure-migration-recovery" ]] || die "terminal_state_fixed_name_mismatch"
  [[ "$(env_value "$STATE_FILE" migration_secret_name)" == "OCI_MIGRATION_AZURE_CREDENTIALS" ]] ||
    die "terminal_state_fixed_name_mismatch"
  [[ "$(env_value "$STATE_FILE" recovery_secret_name)" == "AZURE_MIGRATION_RECOVERY_CREDENTIALS" ]] ||
    die "terminal_state_fixed_name_mismatch"
  [[ "$(env_value "$STATE_FILE" workflow_name)" == "oci-migration-recovery.yml" ]] ||
    die "terminal_state_fixed_name_mismatch"

  [[ "$(env_value "$STATE_FILE" repository)" == "$GH_REPOSITORY" ]] ||
    die "terminal_state_repository_mismatch"

  # Compare terminal fields to loaded metadata when metadata is present
  if [[ -n "$METADATA_FILE" && -f "$METADATA_FILE" && ! -L "$METADATA_FILE" ]]; then
    [[ "$(env_value "$STATE_FILE" metadata_sha256)" == "$(sha256_file "$METADATA_FILE")" ]] ||
      die "terminal_state_metadata_digest_mismatch"
  fi
}

# --- Field declarations ---
TENANT_ID="" ; SUBSCRIPTION_ID=""
MIGRATION_APP_ID="" ; RECOVERY_APP_ID=""
MIGRATION_SP_OBJECT_ID="" ; RECOVERY_SP_OBJECT_ID="" ; RETAINED_SP_OBJECT_ID=""
ROLE_ASSIGNMENT_ID_1="" ; ROLE_ASSIGNMENT_ID_2="" ; ROLE_ASSIGNMENT_ID_3=""
RA1_PRINCIPAL="" ; RA1_ROLE_DEF="" ; RA1_SCOPE=""
RA2_PRINCIPAL="" ; RA2_ROLE_DEF="" ; RA2_SCOPE=""
RA3_PRINCIPAL="" ; RA3_ROLE_DEF="" ; RA3_SCOPE=""
CUSTOM_ROLE_ID_1="" ; CUSTOM_ROLE_ID_2=""
CR1_SCOPE="" ; CR2_SCOPE=""
MIGRATION_ENV="" ; RECOVERY_ENV=""
RETAINED_SP_DISPLAY_NAME="" ; RETAINED_SECRET_NAME=""

load_metadata() {
  [[ -n "$METADATA_FILE" ]] || die "metadata_file_not_specified"
  [[ "$METADATA_FILE" == /* ]] || die "metadata_path_not_absolute"
  [[ -f "$METADATA_FILE" && ! -L "$METADATA_FILE" ]] || die "metadata_file_missing_or_symlink"

  local meta_perms
  meta_perms="$(stat -f '%Lp' "$METADATA_FILE" 2>/dev/null || stat -c '%a' "$METADATA_FILE" 2>/dev/null)"
  [[ "$meta_perms" == "600" ]] || die "metadata_file_wrong_permissions"

  local line_num=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_num=$((line_num + 1))
    [[ "$line" =~ ^[a-z_0-9]+= ]] || die "metadata_malformed_line"
  done < "$METADATA_FILE"

  local file_keys expected_keys
  file_keys="$(sed 's/=.*//' "$METADATA_FILE" | sort)"
  expected_keys="$(printf '%s\n' "${ALLOWED_KEYS[@]}" | sort)"
  [[ "$file_keys" == "$expected_keys" ]] || die "metadata_unknown_or_missing_keys"

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
  RA1_PRINCIPAL="$(env_value "$METADATA_FILE" role_assignment_1_principal_id)"
  RA1_ROLE_DEF="$(env_value "$METADATA_FILE" role_assignment_1_role_definition_id)"
  RA1_SCOPE="$(env_value "$METADATA_FILE" role_assignment_1_scope)"
  RA2_PRINCIPAL="$(env_value "$METADATA_FILE" role_assignment_2_principal_id)"
  RA2_ROLE_DEF="$(env_value "$METADATA_FILE" role_assignment_2_role_definition_id)"
  RA2_SCOPE="$(env_value "$METADATA_FILE" role_assignment_2_scope)"
  RA3_PRINCIPAL="$(env_value "$METADATA_FILE" role_assignment_3_principal_id)"
  RA3_ROLE_DEF="$(env_value "$METADATA_FILE" role_assignment_3_role_definition_id)"
  RA3_SCOPE="$(env_value "$METADATA_FILE" role_assignment_3_scope)"
  CUSTOM_ROLE_ID_1="$(env_value "$METADATA_FILE" custom_role_id_1)"
  CUSTOM_ROLE_ID_2="$(env_value "$METADATA_FILE" custom_role_id_2)"
  CR1_SCOPE="$(env_value "$METADATA_FILE" custom_role_1_assignable_scope)"
  CR2_SCOPE="$(env_value "$METADATA_FILE" custom_role_2_assignable_scope)"
  MIGRATION_ENV="$(env_value "$METADATA_FILE" migration_environment)"
  RECOVERY_ENV="$(env_value "$METADATA_FILE" recovery_environment)"
  RETAINED_SP_DISPLAY_NAME="$(env_value "$METADATA_FILE" retained_sp_display_name)"
  RETAINED_SECRET_NAME="$(env_value "$METADATA_FILE" retained_secret_name)"

  # Non-empty check
  local field
  for field in TENANT_ID SUBSCRIPTION_ID MIGRATION_APP_ID RECOVERY_APP_ID \
    MIGRATION_SP_OBJECT_ID RECOVERY_SP_OBJECT_ID RETAINED_SP_OBJECT_ID \
    ROLE_ASSIGNMENT_ID_1 ROLE_ASSIGNMENT_ID_2 ROLE_ASSIGNMENT_ID_3 \
    RA1_PRINCIPAL RA1_ROLE_DEF RA1_SCOPE \
    RA2_PRINCIPAL RA2_ROLE_DEF RA2_SCOPE \
    RA3_PRINCIPAL RA3_ROLE_DEF RA3_SCOPE \
    CUSTOM_ROLE_ID_1 CUSTOM_ROLE_ID_2 CR1_SCOPE CR2_SCOPE \
    MIGRATION_ENV RECOVERY_ENV RETAINED_SP_DISPLAY_NAME RETAINED_SECRET_NAME; do
    [[ -n "${!field}" ]] || die "metadata_empty_field"
  done

  # GUID validation
  validate_guid_field "tenant_id" "$TENANT_ID"
  validate_guid_field "subscription_id" "$SUBSCRIPTION_ID"
  validate_guid_field "migration_app_id" "$MIGRATION_APP_ID"
  validate_guid_field "recovery_app_id" "$RECOVERY_APP_ID"
  validate_guid_field "migration_sp_object_id" "$MIGRATION_SP_OBJECT_ID"
  validate_guid_field "recovery_sp_object_id" "$RECOVERY_SP_OBJECT_ID"
  validate_guid_field "retained_sp_object_id" "$RETAINED_SP_OBJECT_ID"
  validate_guid_field "custom_role_id_1" "$CUSTOM_ROLE_ID_1"
  validate_guid_field "custom_role_id_2" "$CUSTOM_ROLE_ID_2"
  validate_guid_field "role_assignment_1_principal_id" "$RA1_PRINCIPAL"
  validate_guid_field "role_assignment_2_principal_id" "$RA2_PRINCIPAL"
  validate_guid_field "role_assignment_3_principal_id" "$RA3_PRINCIPAL"

  # Role assignment resource IDs
  validate_role_assignment_id_field "role_assignment_id_1" "$ROLE_ASSIGNMENT_ID_1"
  validate_role_assignment_id_field "role_assignment_id_2" "$ROLE_ASSIGNMENT_ID_2"
  validate_role_assignment_id_field "role_assignment_id_3" "$ROLE_ASSIGNMENT_ID_3"
  validate_subscription_binding "role_assignment_id_1" "$ROLE_ASSIGNMENT_ID_1" "$SUBSCRIPTION_ID"
  validate_subscription_binding "role_assignment_id_2" "$ROLE_ASSIGNMENT_ID_2" "$SUBSCRIPTION_ID"
  validate_subscription_binding "role_assignment_id_3" "$ROLE_ASSIGNMENT_ID_3" "$SUBSCRIPTION_ID"

  # Role definition IDs
  validate_role_definition_id_field "role_assignment_1_role_definition_id" "$RA1_ROLE_DEF"
  validate_role_definition_id_field "role_assignment_2_role_definition_id" "$RA2_ROLE_DEF"
  validate_role_definition_id_field "role_assignment_3_role_definition_id" "$RA3_ROLE_DEF"
  validate_subscription_binding "role_assignment_1_role_definition_id" "$RA1_ROLE_DEF" "$SUBSCRIPTION_ID"
  validate_subscription_binding "role_assignment_2_role_definition_id" "$RA2_ROLE_DEF" "$SUBSCRIPTION_ID"
  validate_subscription_binding "role_assignment_3_role_definition_id" "$RA3_ROLE_DEF" "$SUBSCRIPTION_ID"

  # Scopes
  validate_scope_field "role_assignment_1_scope" "$RA1_SCOPE"
  validate_scope_field "role_assignment_2_scope" "$RA2_SCOPE"
  validate_scope_field "role_assignment_3_scope" "$RA3_SCOPE"
  validate_scope_field "custom_role_1_assignable_scope" "$CR1_SCOPE"
  validate_scope_field "custom_role_2_assignable_scope" "$CR2_SCOPE"
  validate_subscription_binding "role_assignment_1_scope" "$RA1_SCOPE" "$SUBSCRIPTION_ID"
  validate_subscription_binding "role_assignment_2_scope" "$RA2_SCOPE" "$SUBSCRIPTION_ID"
  validate_subscription_binding "role_assignment_3_scope" "$RA3_SCOPE" "$SUBSCRIPTION_ID"
  validate_subscription_binding "custom_role_1_assignable_scope" "$CR1_SCOPE" "$SUBSCRIPTION_ID"
  validate_subscription_binding "custom_role_2_assignable_scope" "$CR2_SCOPE" "$SUBSCRIPTION_ID"

  # Safe names
  validate_safe_name_field "migration_environment" "$MIGRATION_ENV"
  validate_safe_name_field "recovery_environment" "$RECOVERY_ENV"
  validate_safe_name_field "retained_sp_display_name" "$RETAINED_SP_DISPLAY_NAME"
  validate_safe_name_field "retained_secret_name" "$RETAINED_SECRET_NAME"
  validate_safe_name_field "repository" "$(env_value "$METADATA_FILE" repository)"

  # Fixed names
  [[ "$RETAINED_SP_DISPLAY_NAME" == "betstan-github-sp" ]] || die "metadata_retained_sp_name_mismatch"
  [[ "$RETAINED_SECRET_NAME" == "AZURE_CREDENTIALS" ]] || die "metadata_retained_secret_name_mismatch"
  [[ "$MIGRATION_ENV" == "oci-migration" ]] || die "metadata_migration_env_name_mismatch"
  [[ "$RECOVERY_ENV" == "azure-migration-recovery" ]] || die "metadata_recovery_env_name_mismatch"

  # Repository must match fixed value
  local meta_repo
  meta_repo="$(env_value "$METADATA_FILE" repository)"
  [[ "$meta_repo" == "$GH_REPOSITORY" ]] || die "metadata_repository_mismatch"

  # Uniqueness
  [[ "$MIGRATION_APP_ID" != "$RECOVERY_APP_ID" ]] || die "metadata_duplicate_app_ids"
  [[ "$MIGRATION_SP_OBJECT_ID" != "$RECOVERY_SP_OBJECT_ID" ]] || die "metadata_duplicate_sp_object_ids"
  [[ "$CUSTOM_ROLE_ID_1" != "$CUSTOM_ROLE_ID_2" ]] || die "metadata_duplicate_custom_role_ids"
  [[ "$ROLE_ASSIGNMENT_ID_1" != "$ROLE_ASSIGNMENT_ID_2" ]] || die "metadata_duplicate_role_assignment_ids"
  [[ "$ROLE_ASSIGNMENT_ID_1" != "$ROLE_ASSIGNMENT_ID_3" ]] || die "metadata_duplicate_role_assignment_ids"
  [[ "$ROLE_ASSIGNMENT_ID_2" != "$ROLE_ASSIGNMENT_ID_3" ]] || die "metadata_duplicate_role_assignment_ids"
  [[ "$RETAINED_SP_OBJECT_ID" != "$MIGRATION_SP_OBJECT_ID" ]] || die "metadata_retained_sp_equals_temporary"
  [[ "$RETAINED_SP_OBJECT_ID" != "$RECOVERY_SP_OBJECT_ID" ]] || die "metadata_retained_sp_equals_temporary"

  # Principal IDs must reference known temporary SPs
  for field in RA1_PRINCIPAL RA2_PRINCIPAL RA3_PRINCIPAL; do
    local val="${!field}"
    [[ "$val" == "$MIGRATION_SP_OBJECT_ID" || "$val" == "$RECOVERY_SP_OBJECT_ID" ]] ||
      die "metadata_principal_not_temporary_sp"
  done
}

# --- GitHub repository and environment variable queries ---

query_recovery_variable_repo() {
  local value
  value="$(gh variable get OCI_MIGRATION_RECOVERY_ENABLED --repo "$GH_REPOSITORY" 2>/dev/null)" ||
    die "recovery_variable_repo_query_failed"
  [[ "$value" == "false" ]] || die "recovery_enabled_must_be_false_repo"
}

query_recovery_variable_env() {
  local value
  value="$(gh variable get OCI_MIGRATION_RECOVERY_ENABLED --repo "$GH_REPOSITORY" --env "$RECOVERY_ENV" 2>/dev/null)" ||
    die "recovery_variable_env_query_failed"
  [[ "$value" == "false" ]] || die "recovery_enabled_must_be_false_env"
}

query_arm_variable_repo() {
  local value
  value="$(gh variable get OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH --repo "$GH_REPOSITORY" 2>/dev/null)" ||
    die "arm_variable_repo_query_failed"
  [[ "$value" == "0" ]] || die "arm_epoch_must_be_zero_repo"
}

query_arm_variable_env() {
  local value
  value="$(gh variable get OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH --repo "$GH_REPOSITORY" --env "$RECOVERY_ENV" 2>/dev/null)" ||
    die "arm_variable_env_query_failed"
  [[ "$value" == "0" ]] || die "arm_epoch_must_be_zero_env"
}

query_all_guard_variables() {
  query_recovery_variable_repo
  query_recovery_variable_env
  query_arm_variable_repo
  query_arm_variable_env
}

set_recovery_variable_repo() {
  gh variable set OCI_MIGRATION_RECOVERY_ENABLED --repo "$GH_REPOSITORY" --body "false" 2>/dev/null ||
    die "recovery_variable_repo_set_failed"
}

set_recovery_variable_env() {
  gh variable set OCI_MIGRATION_RECOVERY_ENABLED --repo "$GH_REPOSITORY" --env "$RECOVERY_ENV" --body "false" 2>/dev/null ||
    die "recovery_variable_env_set_failed"
}

set_arm_variable_repo() {
  gh variable set OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH --repo "$GH_REPOSITORY" --body "0" 2>/dev/null ||
    die "arm_variable_repo_set_failed"
}

set_arm_variable_env() {
  gh variable set OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH --repo "$GH_REPOSITORY" --env "$RECOVERY_ENV" --body "0" 2>/dev/null ||
    die "arm_variable_env_set_failed"
}

set_all_guard_variables() {
  set_recovery_variable_repo
  set_recovery_variable_env
  set_arm_variable_repo
  set_arm_variable_env
}

verify_azure_context() {
  local actual_sub
  actual_sub="$(az account show --query 'id' -o tsv)" || die "azure_account_unavailable"
  [[ "$actual_sub" == "$SUBSCRIPTION_ID" ]] || die "wrong_subscription"
  local actual_tenant
  actual_tenant="$(az account show --query 'tenantId' -o tsv)" || die "azure_tenant_unavailable"
  [[ "$actual_tenant" == "$TENANT_ID" ]] || die "wrong_tenant"
}

# --- Fail-closed probes (present/absent/die-on-error) ---

probe_sp_presence() {
  local object_id="$1" output rc=0
  output="$(az ad sp list --filter "id eq '$object_id'" --query 'length(@)' -o tsv 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "probe_sp_api_error"
  case "$output" in
    0) printf 'absent' ;; 1) printf 'present' ;;
    *) die "probe_sp_unexpected_count" ;;
  esac
}

probe_sp_app_id() {
  local object_id="$1" output rc=0
  output="$(az ad sp list --filter "id eq '$object_id'" --query '[0].appId' -o tsv 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "probe_sp_app_id_api_error"
  printf '%s' "$output"
}

probe_app_presence() {
  local app_id="$1" output rc=0
  output="$(az ad app list --filter "appId eq '$app_id'" --query 'length(@)' -o tsv 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "probe_app_api_error"
  case "$output" in
    0) printf 'absent' ;; 1) printf 'present' ;;
    *) die "probe_app_unexpected_count" ;;
  esac
}

probe_role_assignment_presence() {
  local id="$1" output rc=0
  output="$(az role assignment list --all --query "[?id=='$id'] | length(@)" -o tsv 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "probe_role_assignment_api_error"
  case "$output" in
    0) printf 'absent' ;; 1) printf 'present' ;;
    *) die "probe_role_assignment_unexpected_count" ;;
  esac
}

probe_role_assignment_details() {
  local id="$1" output rc=0
  output="$(az role assignment list --all --query "[?id=='$id'] | [0]" -o json 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "probe_role_assignment_details_api_error"
  printf '%s' "$output"
}

probe_custom_role_presence() {
  local role_id="$1" output rc=0
  output="$(az role definition list --name "$role_id" --query 'length(@)' -o tsv 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "probe_custom_role_api_error"
  case "$output" in
    0) printf 'absent' ;; 1) printf 'present' ;;
    *) die "probe_custom_role_unexpected_count" ;;
  esac
}

probe_custom_role_details() {
  local role_id="$1" output rc=0
  output="$(az role definition list --name "$role_id" --query '[0]' -o json 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "probe_custom_role_details_api_error"
  printf '%s' "$output"
}

probe_env_secret_presence() {
  local env_name="$1" secret_name="$2" output rc=0
  output="$(gh secret list --repo "$GH_REPOSITORY" --env "$env_name" 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "probe_secret_api_error"
  if printf '%s\n' "$output" | awk '{print $1}' | grep -qxF "$secret_name"; then
    printf 'present'
  else
    printf 'absent'
  fi
}

probe_repo_secret_presence() {
  local secret_name="$1" output rc=0
  output="$(gh secret list --repo "$GH_REPOSITORY" 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "probe_repo_secret_api_error"
  if printf '%s\n' "$output" | awk '{print $1}' | grep -qxF "$secret_name"; then
    printf 'present'
  else
    printf 'absent'
  fi
}

# --- Retained identity verification ---

verify_retained_identity() {
  local sp_output rc=0
  sp_output="$(az ad sp list --filter "id eq '$RETAINED_SP_OBJECT_ID'" -o json 2>&1)" || rc=$?
  [[ "$rc" -eq 0 ]] || die "retained_sp_query_api_error"
  local sp_count
  sp_count="$(printf '%s' "$sp_output" | jq 'length')" || die "retained_sp_response_parse_error"
  [[ "$sp_count" == "1" ]] || die "retained_sp_not_found"
  local actual_display
  actual_display="$(printf '%s' "$sp_output" | jq -r '.[0].displayName // empty')"
  [[ "$actual_display" == "$RETAINED_SP_DISPLAY_NAME" ]] ||
    die "retained_sp_display_name_mismatch"

  local secret_status
  secret_status="$(probe_repo_secret_presence "$RETAINED_SECRET_NAME")"
  [[ "$secret_status" == "present" ]] || die "retained_secret_not_found"
}

verify_gh_repository() {
  local expected_repo
  expected_repo="$(env_value "$METADATA_FILE" repository)"
  [[ "$expected_repo" == "$GH_REPOSITORY" ]] || die "wrong_repository"
}

# --- Relationship verification (plan phase) ---

verify_sp_relationship() {
  local sp_oid="$1" expected_app_id="$2" label="$3"
  local status
  status="$(probe_sp_presence "$sp_oid")"
  if [[ "$status" == "present" ]]; then
    local actual_app_id
    actual_app_id="$(probe_sp_app_id "$sp_oid")"
    [[ "$actual_app_id" == "$expected_app_id" ]] ||
      die "sp_app_id_mismatch"
  fi
}

verify_role_assignment_relationship() {
  local ra_id="$1" expected_principal="$2" expected_role_def="$3" expected_scope="$4" label="$5"
  local status
  status="$(probe_role_assignment_presence "$ra_id")"
  if [[ "$status" == "present" ]]; then
    local details
    details="$(probe_role_assignment_details "$ra_id")"
    local actual_principal actual_role_def actual_scope
    actual_principal="$(printf '%s' "$details" | jq -r '.principalId // empty')"
    actual_role_def="$(printf '%s' "$details" | jq -r '.roleDefinitionId // empty')"
    actual_scope="$(printf '%s' "$details" | jq -r '.scope // empty')"
    [[ "$actual_principal" == "$expected_principal" ]] ||
      die "ra_principal_mismatch"
    local lower_actual_role lower_expected_role lower_actual_scope lower_expected_scope
    lower_actual_role="$(printf '%s' "$actual_role_def" | tr '[:upper:]' '[:lower:]')"
    lower_expected_role="$(printf '%s' "$expected_role_def" | tr '[:upper:]' '[:lower:]')"
    lower_actual_scope="$(printf '%s' "$actual_scope" | tr '[:upper:]' '[:lower:]')"
    lower_expected_scope="$(printf '%s' "$expected_scope" | tr '[:upper:]' '[:lower:]')"
    [[ "$lower_actual_role" == "$lower_expected_role" ]] ||
      die "ra_role_definition_mismatch"
    [[ "$lower_actual_scope" == "$lower_expected_scope" ]] ||
      die "ra_scope_mismatch"
  fi
}

verify_custom_role_relationship() {
  local role_id="$1" expected_scope="$2" label="$3"
  local status
  status="$(probe_custom_role_presence "$role_id")"
  if [[ "$status" == "present" ]]; then
    local details
    details="$(probe_custom_role_details "$role_id")"
    local actual_id
    actual_id="$(printf '%s' "$details" | jq -r '.name // empty')"
    [[ "$actual_id" == "$role_id" ]] || die "custom_role_id_mismatch"
    # Require EXACT assignableScopes set (one scope only, no extras)
    local scope_count actual_scope
    scope_count="$(printf '%s' "$details" | jq '.assignableScopes | length')"
    [[ "$scope_count" == "1" ]] || die "custom_role_extra_scopes"
    actual_scope="$(printf '%s' "$details" | jq -r '.assignableScopes[0] // empty')"
    local lower_actual lower_expected
    lower_actual="$(printf '%s' "$actual_scope" | tr '[:upper:]' '[:lower:]')"
    lower_expected="$(printf '%s' "$expected_scope" | tr '[:upper:]' '[:lower:]')"
    [[ "$lower_actual" == "$lower_expected" ]] || die "custom_role_scope_mismatch"
  fi
}

verify_all_relationships() {
  verify_sp_relationship "$MIGRATION_SP_OBJECT_ID" "$MIGRATION_APP_ID" "migration_sp"
  verify_sp_relationship "$RECOVERY_SP_OBJECT_ID" "$RECOVERY_APP_ID" "recovery_sp"

  verify_role_assignment_relationship "$ROLE_ASSIGNMENT_ID_1" \
    "$RA1_PRINCIPAL" "$RA1_ROLE_DEF" "$RA1_SCOPE" "ra_1"
  verify_role_assignment_relationship "$ROLE_ASSIGNMENT_ID_2" \
    "$RA2_PRINCIPAL" "$RA2_ROLE_DEF" "$RA2_SCOPE" "ra_2"
  verify_role_assignment_relationship "$ROLE_ASSIGNMENT_ID_3" \
    "$RA3_PRINCIPAL" "$RA3_ROLE_DEF" "$RA3_SCOPE" "ra_3"

  verify_custom_role_relationship "$CUSTOM_ROLE_ID_1" "$CR1_SCOPE" "custom_role_1"
  verify_custom_role_relationship "$CUSTOM_ROLE_ID_2" "$CR2_SCOPE" "custom_role_2"
}

# --- Deletion helpers ---

delete_role_assignment() {
  local id="$1" rc=0
  az role assignment delete --ids "$id" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    local status
    status="$(probe_role_assignment_presence "$id")"
    [[ "$status" == "absent" ]] || die "role_assignment_delete_failed"
  fi
}

delete_sp() {
  local oid="$1" rc=0
  az ad sp delete --id "$oid" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    local status
    status="$(probe_sp_presence "$oid")"
    [[ "$status" == "absent" ]] || die "sp_delete_failed"
  fi
}

delete_app_registration() {
  local app_id="$1" rc=0
  az ad app delete --id "$app_id" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    local status
    status="$(probe_app_presence "$app_id")"
    [[ "$status" == "absent" ]] || die "app_registration_delete_failed"
  fi
}

delete_custom_role() {
  local role_id="$1" rc=0
  az role definition delete --name "$role_id" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    local status
    status="$(probe_custom_role_presence "$role_id")"
    [[ "$status" == "absent" ]] || die "custom_role_delete_failed"
  fi
}

delete_environment_secret() {
  local env_name="$1" secret_name="$2" rc=0
  gh secret delete "$secret_name" --repo "$GH_REPOSITORY" --env "$env_name" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    local status
    status="$(probe_env_secret_presence "$env_name" "$secret_name")"
    [[ "$status" == "absent" ]] || die "github_secret_delete_failed"
  fi
}

disable_workflow() {
  local wf="$1"
  if ! gh workflow disable "$wf" --repo "$GH_REPOSITORY" 2>/dev/null; then
    local state rc=0
    state="$(gh workflow view "$wf" --repo "$GH_REPOSITORY" --json state --jq '.state' 2>&1)" || rc=$?
    [[ "$rc" -eq 0 ]] || die "workflow_view_api_error"
    [[ "$state" == "disabled_manually" || "$state" == "disabled" ]] ||
      die "workflow_disable_failed"
  fi
}

# Verify no nonterminal runs across all fenced workflows/statuses.
# Fail closed on API errors; only accept proven-zero.
verify_no_active_runs() {
  local wf status output rc count
  for wf in "${FENCED_WORKFLOWS[@]}"; do
    for status in "${RUN_STATUSES[@]}"; do
      rc=0
      output="$(gh run list --workflow "$wf" --repo "$GH_REPOSITORY" \
        --status "$status" --json databaseId --jq 'length' 2>&1)" || rc=$?
      [[ "$rc" -eq 0 ]] || die "workflow_run_list_api_error"
      count="$output"
      [[ "$count" =~ ^[0-9]+$ ]] || die "workflow_run_list_parse_error"
      [[ "$count" == "0" ]] || die "nonterminal_workflow_runs_exist"
    done
  done
}

# --- Verification helpers with bounded propagation retries ---

verify_sp_absent() {
  local oid="$1" attempt=0 s
  while true; do
    s="$(probe_sp_presence "$oid")"
    [[ "$s" == "present" ]] || break
    [[ "$attempt" -lt "$VERIFY_MAX_RETRIES" ]] ||
      die "sp_still_present_after_retries"
    attempt=$((attempt+1))
    sleep "$VERIFY_RETRY_SLEEP"
  done
}

verify_app_absent() {
  local app_id="$1" attempt=0 s
  while true; do
    s="$(probe_app_presence "$app_id")"
    [[ "$s" == "present" ]] || break
    [[ "$attempt" -lt "$VERIFY_MAX_RETRIES" ]] ||
      die "app_still_present_after_retries"
    attempt=$((attempt+1))
    sleep "$VERIFY_RETRY_SLEEP"
  done
}

verify_role_assignment_absent() {
  local id="$1" attempt=0 s
  while true; do
    s="$(probe_role_assignment_presence "$id")"
    [[ "$s" == "present" ]] || break
    [[ "$attempt" -lt "$VERIFY_MAX_RETRIES" ]] ||
      die "role_assignment_still_present_after_retries"
    attempt=$((attempt+1))
    sleep "$VERIFY_RETRY_SLEEP"
  done
}

verify_custom_role_absent() {
  local role_id="$1" attempt=0 s
  while true; do
    s="$(probe_custom_role_presence "$role_id")"
    [[ "$s" == "present" ]] || break
    [[ "$attempt" -lt "$VERIFY_MAX_RETRIES" ]] ||
      die "custom_role_still_present_after_retries"
    attempt=$((attempt+1))
    sleep "$VERIFY_RETRY_SLEEP"
  done
}

verify_secret_absent() {
  local env_name="$1" secret_name="$2" attempt=0 s
  while true; do
    s="$(probe_env_secret_presence "$env_name" "$secret_name")"
    [[ "$s" == "present" ]] || break
    [[ "$attempt" -lt "$VERIFY_MAX_RETRIES" ]] ||
      die "secret_still_present_after_retries"
    attempt=$((attempt+1))
    sleep "$VERIFY_RETRY_SLEEP"
  done
}

verify_workflow_disabled() {
  local wf="$1" attempt=0 state rc
  while true; do
    rc=0
    state="$(gh workflow view "$wf" --repo "$GH_REPOSITORY" --json state --jq '.state' 2>&1)" || rc=$?
    [[ "$rc" -eq 0 ]] || die "workflow_view_api_error"
    [[ "$state" == "disabled_manually" || "$state" == "disabled" ]] || {
      [[ "$attempt" -lt "$VERIFY_MAX_RETRIES" ]] ||
        die "workflow_still_enabled_after_retries"
      attempt=$((attempt+1))
      sleep "$VERIFY_RETRY_SLEEP"
      continue
    }
    break
  done
}

# Full absence verification for all temporary objects
verify_all_absent() {
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
  query_all_guard_variables
  verify_no_active_runs
  verify_retained_identity
}

# --- Main ---

require_command az
require_command gh
require_command jq
validate_retry_config

[[ -n "$STATE_DIR" ]] || die "state_dir_not_specified"
[[ "$STATE_DIR" == /* ]] || die "state_dir_not_absolute"
# Reject existing symlink BEFORE any mkdir/chmod
if [[ -e "$STATE_DIR" || -L "$STATE_DIR" ]]; then
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || die "state_dir_symlink"
fi
# Validate resolved parent is sane (not /, not /tmp, not broad)
STATE_DIR_PARENT="$(dirname "$STATE_DIR")"
[[ -d "$STATE_DIR_PARENT" && ! -L "$STATE_DIR_PARENT" ]] || die "state_dir_parent_invalid"
STATE_DIR_PARENT_REAL="$(cd "$STATE_DIR_PARENT" && pwd -P)"
[[ "$STATE_DIR_PARENT_REAL" == "$STATE_DIR_PARENT" ]] || die "state_dir_parent_resolves_elsewhere"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
STATE_DIR_REAL="$(cd "$STATE_DIR" && pwd -P)"
[[ "$STATE_DIR_REAL" == "$STATE_DIR" ]] || die "state_dir_resolves_elsewhere"
STATE_DIR_PERMS="$(stat -f '%Lp' "$STATE_DIR" 2>/dev/null || stat -c '%a' "$STATE_DIR" 2>/dev/null)"
[[ "$STATE_DIR_PERMS" == "700" ]] || die "state_dir_wrong_permissions"
STATE_FILE="$STATE_DIR/identity-retirement-state.env"

# Metadata loading: required for plan/execute; for verify, load from terminal state
# if metadata was cleaned up (only terminal schema can bypass metadata requirement).
METADATA_LOADED_FROM_STATE=0
if [[ "$MODE" == "verify" && ( -z "$METADATA_FILE" || ! -f "$METADATA_FILE" ) ]]; then
  load_from_terminal_state
  METADATA_LOADED_FROM_STATE=1
else
  load_metadata
  verify_gh_repository
fi

case "$MODE" in
  plan)
    verify_azure_context
    query_all_guard_variables
    verify_retained_identity
    verify_all_relationships
    printf 'identity_retirement=READY '
    printf 'role_assignments=3 sps=2 apps=2 custom_roles=2 '
    printf 'secrets=2 workflow=oci-migration-recovery.yml\n'
    ;;

  execute)
    verify_azure_context
    query_all_guard_variables

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
          verify_all_relationships
          write_state guards-intent
          local_phase=guards-intent
          ;;
        guards-intent)
          set_all_guard_variables
          write_state workflow-intent
          local_phase=workflow-intent
          ;;
        workflow-intent)
          disable_workflow "oci-migration-recovery.yml"
          write_state runs-fence
          local_phase=runs-fence
          ;;
        runs-fence)
          verify_no_active_runs
          write_state secrets-intent
          local_phase=secrets-intent
          ;;
        secrets-intent)
          delete_environment_secret "$MIGRATION_ENV" "OCI_MIGRATION_AZURE_CREDENTIALS"
          delete_environment_secret "$RECOVERY_ENV" "AZURE_MIGRATION_RECOVERY_CREDENTIALS"
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
          write_state verification-intent
          local_phase=verification-intent
          ;;
        verification-intent)
          verify_all_absent
          write_state retired
          local_phase=retired
          ;;
        retired)
          verify_all_absent
          printf 'IDENTITY_RETIRED objects_absent=9 secrets_absent=2 workflow_disabled=1\n'
          break
          ;;
        *) die "unknown_state_phase" ;;
      esac
    done
    ;;

  verify)
    verify_azure_context
    query_all_guard_variables

    if [[ "$METADATA_LOADED_FROM_STATE" == "1" ]]; then
      :
    elif [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]]; then
      validate_state_identity
      [[ "$(env_value "$STATE_FILE" phase)" == "retired" ]] || die "verify_requires_retired_state"
    else
      die "retirement_state_missing"
    fi

    verify_all_absent

    printf 'IDENTITY_RETIREMENT_VERIFIED all_temporary_objects_absent=true retained_identity_intact=true\n'

    if [[ "$SAFE_CLEANUP" == "1" && -n "$METADATA_FILE" && -f "$METADATA_FILE" ]]; then
      rm -f "$METADATA_FILE"
      printf 'metadata_cleaned=true\n'
    fi
    ;;

  *) die "unknown_mode" ;;
esac
