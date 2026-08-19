#!/usr/bin/env bash
# migration-success-contract.sh -- Single source of truth for the
# betstan.oci-migration-success.v1 provenance envelope.
#
# Usage:
#   MODE=emit  ./migration-success-contract.sh <output-file> [key=value ...]
#   MODE=validate ./migration-success-contract.sh <input-file> \
#       SOURCE_SHA=... MIGRATION_RUN_ID=... MIGRATION_RUN_ATTEMPT=... \
#       MIGRATION_ID=... AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256=...
#
# The helper guarantees:
#   - Exactly the canonical ordered field set (no duplicates, no missing, no unknown)
#   - Semantic validation of every field
#   - Fail-closed on any violation
set -euo pipefail

# --- Canonical ordered field set ---------------------------------------------
# This is the ONLY place that defines the contract field list.
CONTRACT_FIELDS=(
  schema
  migration_id
  source_sha
  runtime_deploy_source_sha
  closed_recovery_retry
  github_run_id
  github_run_attempt
  terminal_phase
  terminal_status
  journal_generation
  fencing_generation
  journal_sequence
  journal_heartbeat_epoch
  final_journal_sha256
  artifact_run_binding
  destructive_boundary_crossed
  database_count
  logical_source_target_parity
  source_signature_aggregate_sha256
  target_signature_aggregate_sha256
  oci_reopened_healthy
  http_mutation_fence_removed
  azure_writers_frozen
  azure_cluster_resource_id_sha256
  aks_power_state
  vmss_instances_deallocated
  azure_cluster_stopped_deallocated
)

CONTRACT_SCHEMA="betstan.oci-migration-success.v1"
CONTRACT_DATABASE_COUNT=8

# Allowed validation-context keys (MODE=validate extra args)
_CONTRACT_CONTEXT_KEYS=(
  SOURCE_SHA
  MIGRATION_RUN_ID
  MIGRATION_RUN_ATTEMPT
  MIGRATION_ID
  AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256
)

# --- Internal helpers --------------------------------------------------------
_contract_die() {
  printf 'CONTRACT_VIOLATION field=%s reason=%s\n' "${2:-unknown}" "$1" >&2
  exit 1
}

_contract_env_value() {
  local file="$1" key="$2"
  local count
  count="$(grep -c "^${key}=" "$file" || true)"
  if [[ "$count" == "0" ]]; then
    _contract_die "missing_field" "$key"
  elif [[ "$count" != "1" ]]; then
    _contract_die "duplicate_field" "$key"
  fi
  sed -n "s/^${key}=//p" "$file"
}

_contract_require_sha40() {
  local key="$1" value="$2"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] ||
    _contract_die "invalid_sha40" "$key"
}

_contract_require_sha256() {
  local key="$1" value="$2"
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] ||
    _contract_die "invalid_sha256" "$key"
}

_contract_require_positive_int() {
  local key="$1" value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] ||
    _contract_die "not_positive_integer" "$key"
}

_contract_require_exact() {
  local key="$1" expected="$2" actual="$3"
  [[ "$actual" == "$expected" ]] ||
    _contract_die "value_mismatch(expected=${expected})" "$key"
}

_contract_require_boolean() {
  local key="$1" value="$2"
  [[ "$value" == "true" || "$value" == "false" ]] ||
    _contract_die "invalid_boolean" "$key"
}

# --- Field set validation (shared by emit and validate) ----------------------
_contract_validate_field_set() {
  local file="$1"

  # Reject blank lines
  if grep -q '^[[:space:]]*$' "$file"; then
    _contract_die "blank_lines_present" "envelope"
  fi

  # Reject lines without key=value structure
  if grep -qv '=' "$file"; then
    _contract_die "malformed_line" "envelope"
  fi

  # Extract actual keys in file order
  local actual_keys
  actual_keys="$(sed 's/=.*//' "$file")"

  # Line count check (catches duplicates or extra lines early)
  local line_count field_count
  line_count="$(printf '%s\n' "$actual_keys" | wc -l | tr -d ' ')"
  field_count="${#CONTRACT_FIELDS[@]}"
  if [[ "$line_count" -gt "$field_count" ]]; then
    # Identify duplicate or unknown via sorted comparison
    local actual_sorted expected_sorted
    actual_sorted="$(printf '%s\n' "$actual_keys" | sort)"
    expected_sorted="$(printf '%s\n' "${CONTRACT_FIELDS[@]}" | sort)"
    local dup
    dup="$(printf '%s\n' "$actual_keys" | sort | uniq -d | head -1)"
    if [[ -n "$dup" ]]; then
      _contract_die "duplicate_field" "$dup"
    fi
    local unknown
    unknown="$(comm -23 <(echo "$actual_sorted") <(echo "$expected_sorted") | head -1)"
    if [[ -n "$unknown" ]]; then
      _contract_die "unknown_field" "$unknown"
    fi
    _contract_die "line_count_mismatch(expected=${field_count},actual=${line_count})" "envelope"
  fi

  if [[ "$line_count" -lt "$field_count" ]]; then
    # Identify missing field
    local actual_sorted expected_sorted
    actual_sorted="$(printf '%s\n' "$actual_keys" | sort)"
    expected_sorted="$(printf '%s\n' "${CONTRACT_FIELDS[@]}" | sort)"
    local missing
    missing="$(comm -13 <(echo "$actual_sorted") <(echo "$expected_sorted") | head -1)"
    if [[ -n "$missing" ]]; then
      _contract_die "missing_field" "$missing"
    fi
    _contract_die "line_count_mismatch(expected=${field_count},actual=${line_count})" "envelope"
  fi

  # Exact count matches -- now enforce canonical order
  local expected_keys
  expected_keys="$(printf '%s\n' "${CONTRACT_FIELDS[@]}")"

  if [[ "$actual_keys" != "$expected_keys" ]]; then
    # Same count, figure out what's wrong: unknown, missing, or reordered
    local actual_sorted expected_sorted
    actual_sorted="$(printf '%s\n' "$actual_keys" | sort)"
    expected_sorted="$(printf '%s\n' "${CONTRACT_FIELDS[@]}" | sort)"

    local unknown
    unknown="$(comm -23 <(echo "$actual_sorted") <(echo "$expected_sorted") | head -1)"
    if [[ -n "$unknown" ]]; then
      _contract_die "unknown_field" "$unknown"
    fi

    local missing
    missing="$(comm -13 <(echo "$actual_sorted") <(echo "$expected_sorted") | head -1)"
    if [[ -n "$missing" ]]; then
      _contract_die "missing_field" "$missing"
    fi

    # All fields present but wrong order
    _contract_die "field_order_violated" "envelope"
  fi
}

# --- Semantic validation -----------------------------------------------------
# Validates ALL semantic relationships. Parameters passed as env-style args:
#   SOURCE_SHA, MIGRATION_RUN_ID, MIGRATION_RUN_ATTEMPT, MIGRATION_ID,
#   AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256
_contract_validate_semantics() {
  local file="$1"
  shift

  # Parse and strict-check context parameters (reject duplicates)
  local ctx_source_sha="" ctx_run_id="" ctx_run_attempt=""
  local ctx_migration_id="" ctx_cluster_fingerprint=""
  local ctx_seen="" arg ctx_key
  for arg in "$@"; do
    [[ "$arg" == *=* ]] ||
      _contract_die "malformed_context_arg" "context"
    ctx_key="${arg%%=*}"
    local ctx_known=0
    local ck
    for ck in "${_CONTRACT_CONTEXT_KEYS[@]}"; do
      if [[ "$ctx_key" == "$ck" ]]; then
        ctx_known=1
        break
      fi
    done
    [[ "$ctx_known" == "1" ]] ||
      _contract_die "unknown_context_key(${ctx_key})" "context"
    if printf '%s\n' "$ctx_seen" | grep -Fxq "$ctx_key"; then
      _contract_die "duplicate_context_key(${ctx_key})" "context"
    fi
    ctx_seen="${ctx_seen}${ctx_key}
"
    case "$ctx_key" in
      SOURCE_SHA) ctx_source_sha="${arg#*=}" ;;
      MIGRATION_RUN_ID) ctx_run_id="${arg#*=}" ;;
      MIGRATION_RUN_ATTEMPT) ctx_run_attempt="${arg#*=}" ;;
      MIGRATION_ID) ctx_migration_id="${arg#*=}" ;;
      AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256) ctx_cluster_fingerprint="${arg#*=}" ;;
    esac
  done

  # Schema
  local schema
  schema="$(_contract_env_value "$file" schema)"
  _contract_require_exact "schema" "$CONTRACT_SCHEMA" "$schema"

  # Identity binding
  local migration_id
  migration_id="$(_contract_env_value "$file" migration_id)"
  if [[ -n "$ctx_migration_id" ]]; then
    _contract_require_exact "migration_id" "$ctx_migration_id" "$migration_id"
  fi
  [[ "$migration_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] ||
    _contract_die "invalid_format" "migration_id"

  # Source SHA
  local source_sha
  source_sha="$(_contract_env_value "$file" source_sha)"
  _contract_require_sha40 "source_sha" "$source_sha"
  if [[ -n "$ctx_source_sha" ]]; then
    _contract_require_exact "source_sha" "$ctx_source_sha" "$source_sha"
  fi

  # Runtime deploy source SHA and closed-recovery lineage
  local runtime_deploy_source_sha closed_recovery_retry
  runtime_deploy_source_sha="$(_contract_env_value "$file" runtime_deploy_source_sha)"
  _contract_require_sha40 "runtime_deploy_source_sha" "$runtime_deploy_source_sha"
  closed_recovery_retry="$(_contract_env_value "$file" closed_recovery_retry)"
  _contract_require_boolean "closed_recovery_retry" "$closed_recovery_retry"

  # Lineage relation: ordinary vs closed-recovery
  case "$closed_recovery_retry" in
    false)
      [[ "$runtime_deploy_source_sha" == "$source_sha" ]] ||
        _contract_die "ordinary_migration_sha_differs" "runtime_deploy_source_sha"
      ;;
    true)
      [[ "$runtime_deploy_source_sha" != "$source_sha" ]] ||
        _contract_die "closed_recovery_must_differ" "runtime_deploy_source_sha"
      ;;
  esac

  # Run binding
  local run_id run_attempt artifact_run_binding
  run_id="$(_contract_env_value "$file" github_run_id)"
  _contract_require_positive_int "github_run_id" "$run_id"
  run_attempt="$(_contract_env_value "$file" github_run_attempt)"
  _contract_require_positive_int "github_run_attempt" "$run_attempt"
  artifact_run_binding="$(_contract_env_value "$file" artifact_run_binding)"
  _contract_require_exact "artifact_run_binding" "${run_id}-${run_attempt}" "$artifact_run_binding"
  if [[ -n "$ctx_run_id" ]]; then
    _contract_require_exact "github_run_id" "$ctx_run_id" "$run_id"
  fi
  if [[ -n "$ctx_run_attempt" ]]; then
    _contract_require_exact "github_run_attempt" "$ctx_run_attempt" "$run_attempt"
  fi
  # Intrinsic: migration_id must equal github_run_id-github_run_attempt
  _contract_require_exact "migration_id" "${run_id}-${run_attempt}" "$migration_id"

  # Terminal state
  _contract_require_exact "terminal_phase" "DEPLOYED_HEALTHY" \
    "$(_contract_env_value "$file" terminal_phase)"
  _contract_require_exact "terminal_status" "DEPLOYED_HEALTHY" \
    "$(_contract_env_value "$file" terminal_status)"

  # Journal and fencing (positive integers, must be equal)
  local jgen fgen
  jgen="$(_contract_env_value "$file" journal_generation)"
  fgen="$(_contract_env_value "$file" fencing_generation)"
  _contract_require_positive_int "journal_generation" "$jgen"
  _contract_require_positive_int "fencing_generation" "$fgen"
  [[ "$jgen" == "$fgen" ]] ||
    _contract_die "generation_mismatch(journal=${jgen},fencing=${fgen})" "fencing_generation"
  _contract_require_positive_int "journal_sequence" \
    "$(_contract_env_value "$file" journal_sequence)"
  _contract_require_positive_int "journal_heartbeat_epoch" \
    "$(_contract_env_value "$file" journal_heartbeat_epoch)"

  # Final journal hash
  local final_journal_sha256
  final_journal_sha256="$(_contract_env_value "$file" final_journal_sha256)"
  _contract_require_sha256 "final_journal_sha256" "$final_journal_sha256"

  # Destructive boundary
  _contract_require_exact "destructive_boundary_crossed" "true" \
    "$(_contract_env_value "$file" destructive_boundary_crossed)"

  # Database count and parity
  local database_count logical_parity
  database_count="$(_contract_env_value "$file" database_count)"
  _contract_require_exact "database_count" "$CONTRACT_DATABASE_COUNT" "$database_count"
  logical_parity="$(_contract_env_value "$file" logical_source_target_parity)"
  _contract_require_exact "logical_source_target_parity" "true" "$logical_parity"

  # Signature parity
  local source_sig target_sig
  source_sig="$(_contract_env_value "$file" source_signature_aggregate_sha256)"
  target_sig="$(_contract_env_value "$file" target_signature_aggregate_sha256)"
  _contract_require_sha256 "source_signature_aggregate_sha256" "$source_sig"
  _contract_require_sha256 "target_signature_aggregate_sha256" "$target_sig"
  [[ "$source_sig" == "$target_sig" ]] ||
    _contract_die "signature_parity_mismatch" "target_signature_aggregate_sha256"

  # OCI reopened
  _contract_require_exact "oci_reopened_healthy" "true" \
    "$(_contract_env_value "$file" oci_reopened_healthy)"

  # HTTP fence removed
  _contract_require_exact "http_mutation_fence_removed" "true" \
    "$(_contract_env_value "$file" http_mutation_fence_removed)"

  # Azure frozen
  _contract_require_exact "azure_writers_frozen" "true" \
    "$(_contract_env_value "$file" azure_writers_frozen)"

  # Cluster fingerprint (case-preserving)
  local cluster_fp
  cluster_fp="$(_contract_env_value "$file" azure_cluster_resource_id_sha256)"
  _contract_require_sha256 "azure_cluster_resource_id_sha256" "$cluster_fp"
  if [[ -n "$ctx_cluster_fingerprint" ]]; then
    _contract_require_exact "azure_cluster_resource_id_sha256" \
      "$ctx_cluster_fingerprint" "$cluster_fp"
  fi

  # AKS power state
  local aks_power
  aks_power="$(_contract_env_value "$file" aks_power_state)"
  [[ "$aks_power" == "Stopped" || "$aks_power" == "Deallocated" ]] ||
    _contract_die "invalid_power_state" "aks_power_state"

  # VMSS deallocated
  _contract_require_exact "vmss_instances_deallocated" "true" \
    "$(_contract_env_value "$file" vmss_instances_deallocated)"

  # Azure cluster stopped/deallocated
  _contract_require_exact "azure_cluster_stopped_deallocated" "true" \
    "$(_contract_env_value "$file" azure_cluster_stopped_deallocated)"
}

# --- Emit mode ---------------------------------------------------------------
# Writes an ordered envelope from key=value arguments, then validates it.
# Atomic: everything (mktemp, chmod, write, validate, mv) runs inside a
# subshell with a local EXIT trap. On any failure the trap removes the temp;
# a pre-existing destination is never altered. Rejects directory or
# non-regular-file destinations (absent is allowed).
_contract_emit() {
  local output_file="$1"
  shift

  local dest_dir
  dest_dir="$(dirname "$output_file")"
  [[ -d "$dest_dir" ]] ||
    _contract_die "destination_dir_missing" "emit"

  # Reject if destination exists but is not a regular file
  if [[ -e "$output_file" && ! -f "$output_file" ]]; then
    _contract_die "destination_not_regular_file" "emit"
  fi
  if [[ -L "$output_file" ]]; then
    _contract_die "destination_is_symlink" "emit"
  fi

  # Run entirely inside a subshell with EXIT trap on the temp
  (
    _emit_tmp=""
    trap '[[ -z "$_emit_tmp" ]] || rm -f "$_emit_tmp"' EXIT

    _emit_tmp="$(mktemp "${dest_dir}/.contract-emit-XXXXXXXX")"
    chmod 0600 "$_emit_tmp"

    # Validate and collect args; reject malformed or duplicate keys
    local keys_seen="" arg key
    for arg in "$@"; do
      [[ "$arg" == *=* ]] ||
        _contract_die "malformed_emit_arg" "emit"
      key="${arg%%=*}"
      if printf '%s\n' "$keys_seen" | grep -Fxq "$key"; then
        _contract_die "duplicate_emit_key" "$key"
      fi
      keys_seen="${keys_seen}${key}
"
    done

    # Write in canonical order
    local field found_value
    for field in "${CONTRACT_FIELDS[@]}"; do
      found_value=""
      local matched=0
      for arg in "$@"; do
        key="${arg%%=*}"
        if [[ "$key" == "$field" ]]; then
          found_value="${arg#*=}"
          matched=1
          break
        fi
      done
      if [[ "$matched" == "0" ]]; then
        _contract_die "missing_emit_key" "$field"
      fi
      printf '%s=%s\n' "$field" "$found_value" >> "$_emit_tmp"
    done

    # Reject unknown keys
    for arg in "$@"; do
      key="${arg%%=*}"
      local found=0
      for field in "${CONTRACT_FIELDS[@]}"; do
        if [[ "$key" == "$field" ]]; then
          found=1
          break
        fi
      done
      if [[ "$found" == "0" ]]; then
        _contract_die "unknown_emit_key" "$key"
      fi
    done

    # Validate temp completely BEFORE making it the destination
    _contract_validate_field_set "$_emit_tmp"
    _contract_validate_semantics "$_emit_tmp"

    # Atomic rename -- pre-existing destination untouched until this point
    mv "$_emit_tmp" "$output_file"
    # Clear trap variable: temp no longer exists at old path
    _emit_tmp=""
  )
}

# --- Validate mode -----------------------------------------------------------
_contract_validate() {
  local input_file="$1"
  shift

  [[ -f "$input_file" ]] ||
    _contract_die "file_not_found" "envelope"
  [[ ! -L "$input_file" ]] ||
    _contract_die "symlink_rejected" "envelope"

  _contract_validate_field_set "$input_file"
  _contract_validate_semantics "$input_file" "$@"
}

# --- Public API (field list query) -------------------------------------------
contract_field_list() {
  printf '%s\n' "${CONTRACT_FIELDS[@]}"
}

contract_sorted_field_list() {
  printf '%s\n' "${CONTRACT_FIELDS[@]}" | sort
}

# --- Entry point (when run as a script) --------------------------------------
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  CONTRACT_MODE="${MODE:-validate}"
  case "$CONTRACT_MODE" in
    emit)
      [[ $# -ge 1 ]] || { echo "Usage: MODE=emit $0 <output-file> [key=value ...]" >&2; exit 1; }
      _contract_emit "$@"
      ;;
    validate)
      [[ $# -ge 1 ]] || { echo "Usage: MODE=validate $0 <input-file> [CONTEXT=value ...]" >&2; exit 1; }
      _contract_validate "$@"
      ;;
    fields)
      contract_field_list
      ;;
    sorted-fields)
      contract_sorted_field_list
      ;;
    *)
      echo "Unknown MODE=$CONTRACT_MODE (use emit, validate, fields, sorted-fields)" >&2
      exit 1
      ;;
  esac
fi
