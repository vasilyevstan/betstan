#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-plan}"
GH_REPOSITORY="${GH_REPOSITORY:-vasilyevstan/betstan}"
AZURE_RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-betstan-rg}"
AZURE_CLUSTER_NAME="${AZURE_CLUSTER_NAME:-betstan-aks}"
AZURE_EXPECTED_NODE_RESOURCE_GROUP="${AZURE_EXPECTED_NODE_RESOURCE_GROUP:-MC_betstan-rg_betstan-aks_eastus}"
AZURE_AKS_API_VERSION=2025-10-01
MIGRATION_RUN_ID="${MIGRATION_RUN_ID:-}"
MIGRATION_RUN_ATTEMPT="${MIGRATION_RUN_ATTEMPT:-}"
MIGRATION_ID="${MIGRATION_ID:-}"
SOURCE_SHA="${SOURCE_SHA:-}"
AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256="${AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256:-}"
AZURE_EXPECTED_SUBSCRIPTION_ID_SHA256="${AZURE_EXPECTED_SUBSCRIPTION_ID_SHA256:-}"
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
RETIREMENT_STATE_DIR="${RETIREMENT_STATE_DIR:-}"
EXPECTED_INVENTORY_SHA256="${EXPECTED_INVENTORY_SHA256:-}"
RETIRE_AZURE_CONFIRMATION="${RETIRE_AZURE_CONFIRMATION:-}"
DELETE_WAIT_SECONDS="${DELETE_WAIT_SECONDS:-30}"
DELETE_MAX_LOOPS="${DELETE_MAX_LOOPS:-240}"
ABSENCE_VERIFY_LOOPS="${ABSENCE_VERIFY_LOOPS:-2}"
ABSENCE_VERIFY_SLEEP_SECONDS="${ABSENCE_VERIFY_SLEEP_SECONDS:-900}"
MANAGED_GROUP_GRACE_LOOPS="${MANAGED_GROUP_GRACE_LOOPS:-20}"

STATE_FILE=""
INITIAL_INVENTORY_FILE=""
CURRENT_INVENTORY_FILE=""
ARTIFACT_DIR=""
SUMMARY_FILE=""
RUN_JSON=""
ARTIFACTS_JSON=""
AZURE_SUBSCRIPTION_ID=""
CLUSTER_ETAG=""
FINAL_JOURNAL_SHA256=""
RESUME_STARTED=0

die() {
  printf 'NO_GO azure_retirement_reason=%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    die "required command is unavailable: $1"
}

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

env_value() {
  local file="$1"
  local key="$2"
  local count
  count="$(grep -c "^${key}=" "$file" || true)"
  [[ "$count" == "1" ]] ||
    die "machine-readable evidence has missing or duplicate field: $key"
  sed -n "s/^${key}=//p" "$file"
}

require_summary_value() {
  local key="$1"
  local expected="$2"
  local actual
  actual="$(env_value "$SUMMARY_FILE" "$key")"
  [[ "$actual" == "$expected" ]] ||
    die "migration success evidence differs for field: $key"
}

require_positive_integer() {
  local key="$1"
  local value
  value="$(env_value "$SUMMARY_FILE" "$key")"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] ||
    die "migration success evidence is not positive for field: $key"
}

write_state() {
  local phase="$1"
  local temporary="${STATE_FILE}.tmp"
  {
    printf 'schema=betstan.azure-retirement.v1\n'
    printf 'phase=%s\n' "$phase"
    printf 'migration_id=%s\n' "$MIGRATION_ID"
    printf 'source_sha=%s\n' "$SOURCE_SHA"
    printf 'github_run_id=%s\n' "$MIGRATION_RUN_ID"
    printf 'github_run_attempt=%s\n' "$MIGRATION_RUN_ATTEMPT"
    printf 'inventory_sha256=%s\n' "$EXPECTED_INVENTORY_SHA256"
    printf 'cluster_resource_id_sha256=%s\n' \
      "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256"
    printf 'subscription_id_sha256=%s\n' \
      "$AZURE_EXPECTED_SUBSCRIPTION_ID_SHA256"
    printf 'cluster_etag=%s\n' "$CLUSTER_ETAG"
    printf 'final_journal_sha256=%s\n' "$FINAL_JOURNAL_SHA256"
  } > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$STATE_FILE"
}

validate_state_identity() {
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] ||
    die "retirement state is missing"
  [[ "$(env_value "$STATE_FILE" schema)" == "betstan.azure-retirement.v1" ]] ||
    die "retirement state schema differs"
  [[ "$(env_value "$STATE_FILE" migration_id)" == "$MIGRATION_ID" ]] ||
    die "retirement state migration differs"
  [[ "$(env_value "$STATE_FILE" source_sha)" == "$SOURCE_SHA" ]] ||
    die "retirement state SHA differs"
  [[ "$(env_value "$STATE_FILE" github_run_id)" == "$MIGRATION_RUN_ID" ]] ||
    die "retirement state run differs"
  [[ "$(env_value "$STATE_FILE" github_run_attempt)" == "$MIGRATION_RUN_ATTEMPT" ]] ||
    die "retirement state run attempt differs"
  [[ "$(env_value "$STATE_FILE" inventory_sha256)" == "$EXPECTED_INVENTORY_SHA256" ]] ||
    die "retirement state inventory differs"
  [[ "$(env_value "$STATE_FILE" cluster_resource_id_sha256)" == "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" ]] ||
    die "retirement state cluster identity differs"
  [[ "$(env_value "$STATE_FILE" subscription_id_sha256)" == "$AZURE_EXPECTED_SUBSCRIPTION_ID_SHA256" ]] ||
    die "retirement state subscription identity differs"
  CLUSTER_ETAG="$(env_value "$STATE_FILE" cluster_etag)"
  FINAL_JOURNAL_SHA256="$(env_value "$STATE_FILE" final_journal_sha256)"
  [[ -n "$CLUSTER_ETAG" && "$CLUSTER_ETAG" != *$'\n'* ]] ||
    die "retirement state cluster ETag is invalid"
  [[ "$FINAL_JOURNAL_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    die "retirement state journal digest is invalid"
}

group_presence() {
  local result
  if ! result="$(
    az group exists \
      --subscription "$AZURE_SUBSCRIPTION_ID" \
      --name "$1" -o tsv
  )"; then
    return 2
  fi
  case "$result" in
    true) printf present ;;
    false) printf absent ;;
    *) return 2 ;;
  esac
}

list_group_resources() {
  local group="$1"
  local output="$2"
  local raw="${output}.raw"
  az resource list \
    --subscription "$AZURE_SUBSCRIPTION_ID" \
    --resource-group "$group" -o json > "$raw"
  jq -e 'type == "array"' "$raw" >/dev/null
  jq 'sort_by(.id | ascii_downcase)' "$raw" > "$output"
  rm -f "$raw"
}

combine_inventory() {
  local primary="$1"
  local managed="$2"
  local output="$3"
  jq -s 'add | sort_by(.id | ascii_downcase)' "$primary" "$managed" > "$output"
  chmod 600 "$output"
}

validate_initial_inventory() {
  local inventory="$1"
  jq -e \
    --arg primary "$AZURE_RESOURCE_GROUP" \
    --arg managed "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" '
      def count_type($group; $type):
        [.[] | select(
          (.resourceGroup | ascii_downcase) == ($group | ascii_downcase) and
          (.type | ascii_downcase) == ($type | ascii_downcase)
        )] | length;
      length == 28 and
      count_type($primary; "Microsoft.ContainerService/managedClusters") == 1 and
      count_type($primary; "Microsoft.Compute/snapshots") == 8 and
      count_type($primary; "Microsoft.Insights/metricalerts") == 3 and
      count_type($primary; "microsoft.insights/actiongroups") == 1 and
      count_type($managed; "Microsoft.Compute/virtualMachineScaleSets") == 1 and
      count_type($managed; "Microsoft.Compute/disks") == 8 and
      count_type($managed; "Microsoft.Network/loadBalancers") == 1 and
      count_type($managed; "Microsoft.Network/publicIPAddresses") == 2 and
      count_type($managed; "Microsoft.ManagedIdentity/userAssignedIdentities") == 1 and
      count_type($managed; "Microsoft.Network/networkSecurityGroups") == 1 and
      count_type($managed; "Microsoft.Network/virtualNetworks") == 1
    ' "$inventory" >/dev/null ||
    die "Azure resource inventory differs from the approved 28-resource allowlist"
}

validate_inventory_subset() {
  local current="$1"
  jq -e --slurpfile initial "$INITIAL_INVENTORY_FILE" '
    ($initial[0] | map(.id | ascii_downcase)) as $approved |
    all(.[]; (.id | ascii_downcase) as $id | $approved | index($id) != null)
  ' "$current" >/dev/null ||
    die "an unapproved resource appeared after retirement started"
}

cluster_presence() {
  local primary_resources="$RETIREMENT_STATE_DIR/cluster-check.json"
  local group_status match
  group_status="$(group_presence "$AZURE_RESOURCE_GROUP")" || return 2
  if [[ "$group_status" == "absent" ]]; then
    printf absent
    return 0
  fi
  list_group_resources "$AZURE_RESOURCE_GROUP" "$primary_resources" || return 2
  match="$(jq -r \
    --arg name "$AZURE_CLUSTER_NAME" '
      any(.[]; (.type | ascii_downcase) ==
        "microsoft.containerservice/managedclusters" and .name == $name)
    ' "$primary_resources")" || return 2
  case "$match" in
    true) printf present ;;
    false) printf absent ;;
    *) return 2 ;;
  esac
}

wait_for_cluster_absence() {
  local loop status
  for loop in $(seq 1 "$DELETE_MAX_LOOPS"); do
    status="$(cluster_presence)" ||
      die "Azure API could not determine exact AKS presence"
    if [[ "$status" == "absent" ]]; then
      return 0
    fi
    sleep "$DELETE_WAIT_SECONDS"
  done
  printf 'DELETE_PENDING azure_resource=aks\n' >&2
  exit 2
}

wait_for_group_absence() {
  local group="$1"
  local label="$2"
  local loop status
  for loop in $(seq 1 "$DELETE_MAX_LOOPS"); do
    status="$(group_presence "$group")" ||
      die "Azure API could not determine exact resource-group presence"
    if [[ "$status" == "absent" ]]; then
      return 0
    fi
    sleep "$DELETE_WAIT_SECONDS"
  done
  printf 'DELETE_PENDING azure_resource=%s\n' "$label" >&2
  exit 2
}

wait_for_managed_group_cleanup() {
  local loop status
  for loop in $(seq 1 "$MANAGED_GROUP_GRACE_LOOPS"); do
    status="$(group_presence "$AZURE_EXPECTED_NODE_RESOURCE_GROUP")" ||
      die "Azure API could not determine managed resource-group presence"
    if [[ "$status" == "absent" ]]; then
      return 0
    fi
    sleep "$DELETE_WAIT_SECONDS"
  done
  return 1
}

verify_subscription_absence() {
  local resources="$RETIREMENT_STATE_DIR/subscription-resources.json"
  local groups="$RETIREMENT_STATE_DIR/subscription-groups.json"
  local loop
  for loop in $(seq 1 "$ABSENCE_VERIFY_LOOPS"); do
    az group list --subscription "$AZURE_SUBSCRIPTION_ID" -o json > "$groups"
    az resource list --subscription "$AZURE_SUBSCRIPTION_ID" -o json > "$resources"
    jq -e \
      --arg primary "$AZURE_RESOURCE_GROUP" \
      --arg managed "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" '
        all(.[]; ((.name | ascii_downcase) != ($primary | ascii_downcase)) and
          ((.name | ascii_downcase) != ($managed | ascii_downcase)))
      ' "$groups" >/dev/null ||
      die "an exact BetStan resource group still exists"
    jq -e \
      --arg primary "$AZURE_RESOURCE_GROUP" \
      --arg managed "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" '
        all(.[]; ((.resourceGroup | ascii_downcase) != ($primary | ascii_downcase)) and
          ((.resourceGroup | ascii_downcase) != ($managed | ascii_downcase)))
      ' "$resources" >/dev/null ||
      die "a resource remains in an exact BetStan resource group"
    if [[ "$loop" -lt "$ABSENCE_VERIFY_LOOPS" ]]; then
      sleep "$ABSENCE_VERIFY_SLEEP_SECONDS"
    fi
  done
}

cleanup_private_evidence() {
  rm -rf "$ARTIFACT_DIR" "$RETIREMENT_STATE_DIR/public-health"
  rm -f \
    "$RUN_JSON" \
    "$ARTIFACTS_JSON" \
    "$RETIREMENT_STATE_DIR/account.json" \
    "$RETIREMENT_STATE_DIR/cluster.json" \
    "$RETIREMENT_STATE_DIR/primary-inventory.json" \
    "$RETIREMENT_STATE_DIR/managed-inventory.json" \
    "$RETIREMENT_STATE_DIR/managed-group.json" \
    "$RETIREMENT_STATE_DIR/primary-group.json" \
    "$RETIREMENT_STATE_DIR/cluster-check.json" \
    "$RETIREMENT_STATE_DIR/subscription-resources.json" \
    "$RETIREMENT_STATE_DIR/subscription-groups.json" \
    "$INITIAL_INVENTORY_FILE" \
    "$CURRENT_INVENTORY_FILE"
}

for command in az jq sed grep awk; do
  require_command "$command"
done
[[ "$MODE" == "plan" || "$MODE" == "execute" || "$MODE" == "verify" ]] ||
  die "usage: retire-production-stan.sh [plan|execute|verify]"
[[ "$GH_REPOSITORY" == "vasilyevstan/betstan" ]] ||
  die "GH_REPOSITORY differs from the production repository"
[[ "$AZURE_RESOURCE_GROUP" == "betstan-rg" ]] ||
  die "AZURE_RESOURCE_GROUP differs from the production group"
[[ "$AZURE_CLUSTER_NAME" == "betstan-aks" ]] ||
  die "AZURE_CLUSTER_NAME differs from the production cluster"
[[ "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" == "MC_betstan-rg_betstan-aks_eastus" ]] ||
  die "Azure managed resource group differs from the production identity"
[[ "$MIGRATION_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  die "MIGRATION_RUN_ID must be a positive integer"
[[ "$MIGRATION_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] ||
  die "MIGRATION_RUN_ATTEMPT must be a positive integer"
[[ "$MIGRATION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{5,79}$ ]] ||
  die "MIGRATION_ID has an invalid format"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  die "SOURCE_SHA must be a full lowercase commit SHA"
[[ "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  die "AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256 must be a SHA-256 digest"
[[ "$AZURE_EXPECTED_SUBSCRIPTION_ID_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  die "AZURE_EXPECTED_SUBSCRIPTION_ID_SHA256 must be a SHA-256 digest"
[[ "$OCI_DIAGNOSTIC_URL" =~ ^https://([0-9]{1,3}\.){3}[0-9]{1,3}\.nip\.io$ ]] ||
  die "OCI_DIAGNOSTIC_URL must be the exact HTTPS diagnostic host"
[[ "$RETIREMENT_STATE_DIR" == /* ]] ||
  die "RETIREMENT_STATE_DIR must be an absolute private path"
[[ "$RETIREMENT_STATE_DIR" != "/" &&
  "$RETIREMENT_STATE_DIR" != "$HOME" &&
  "$RETIREMENT_STATE_DIR" != "$ROOT_DIR" ]] ||
  die "RETIREMENT_STATE_DIR must not be a broad root directory"
[[ "$DELETE_WAIT_SECONDS" =~ ^[1-9][0-9]*$ &&
  "$DELETE_MAX_LOOPS" =~ ^[1-9][0-9]*$ &&
  "$ABSENCE_VERIFY_LOOPS" =~ ^[1-9][0-9]*$ &&
  "$ABSENCE_VERIFY_SLEEP_SECONDS" =~ ^[0-9]+$ &&
  "$MANAGED_GROUP_GRACE_LOOPS" =~ ^[1-9][0-9]*$ ]] ||
  die "retirement wait settings must be bounded integers"

[[ ! -L "$RETIREMENT_STATE_DIR" ]] ||
  die "RETIREMENT_STATE_DIR must not be a symlink"
mkdir -p "$RETIREMENT_STATE_DIR"
[[ -d "$RETIREMENT_STATE_DIR" && ! -L "$RETIREMENT_STATE_DIR" ]] ||
  die "RETIREMENT_STATE_DIR is not a private directory"
chmod 700 "$RETIREMENT_STATE_DIR"
STATE_FILE="$RETIREMENT_STATE_DIR/retirement-state.env"
INITIAL_INVENTORY_FILE="$RETIREMENT_STATE_DIR/initial-inventory.json"
CURRENT_INVENTORY_FILE="$RETIREMENT_STATE_DIR/current-inventory.json"
ARTIFACT_DIR="$RETIREMENT_STATE_DIR/migration-artifact"
RUN_JSON="$RETIREMENT_STATE_DIR/migration-run.json"
ARTIFACTS_JSON="$RETIREMENT_STATE_DIR/migration-artifacts.json"
account_json="$RETIREMENT_STATE_DIR/account.json"
cluster_json="$RETIREMENT_STATE_DIR/cluster.json"
primary_inventory="$RETIREMENT_STATE_DIR/primary-inventory.json"
managed_inventory="$RETIREMENT_STATE_DIR/managed-inventory.json"

az account show -o json > "$account_json"
jq -e '.state == "Enabled" and (.id | type == "string")' \
  "$account_json" >/dev/null ||
  die "Azure subscription is not enabled"
AZURE_SUBSCRIPTION_ID="$(jq -r .id "$account_json")"
subscription_digest="$(
  printf '%s' "$AZURE_SUBSCRIPTION_ID" |
    tr '[:upper:]' '[:lower:]' |
    sha256_text
)"
[[ "$subscription_digest" == "$AZURE_EXPECTED_SUBSCRIPTION_ID_SHA256" ]] ||
  die "active Azure subscription differs from the approved fingerprint"

if [[ -f "$STATE_FILE" ]]; then
  [[ "$MODE" == "execute" || "$MODE" == "verify" ]] ||
    die "retirement state already exists; use execute or verify"
  [[ "$EXPECTED_INVENTORY_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    die "resume requires the approved inventory digest"
  validate_state_identity
  initial_phase="$(env_value "$STATE_FILE" phase)"
  case "$initial_phase" in
    planned)
      ;;
    aks-delete-intent|aks-delete-submitted|aks-absent|managed-delete-intent|managed-delete-submitted|managed-absent|primary-delete-intent|primary-delete-submitted|resource-groups-absent|retired)
      RESUME_STARTED=1
      ;;
    *)
      die "retirement state contains an unknown phase"
      ;;
  esac
  if [[ "$initial_phase" != "retired" &&
    "$initial_phase" != "resource-groups-absent" ]]; then
    [[ -f "$INITIAL_INVENTORY_FILE" && ! -L "$INITIAL_INVENTORY_FILE" ]] ||
      die "initial retirement inventory is missing"
  fi
fi

if [[ "$RESUME_STARTED" == "0" ]]; then
  for command in gh curl dig openssl; do
    require_command "$command"
  done
  rm -rf "$ARTIFACT_DIR"
  mkdir -p "$ARTIFACT_DIR"
  chmod 700 "$ARTIFACT_DIR"

  gh api "repos/${GH_REPOSITORY}/actions/runs/${MIGRATION_RUN_ID}" > "$RUN_JSON"
jq -e \
  --arg sha "$SOURCE_SHA" \
  --argjson attempt "$MIGRATION_RUN_ATTEMPT" '
    .path == ".github/workflows/oci-migrate.yml" and
    .event == "workflow_dispatch" and
    .head_branch == "master" and
    .head_sha == $sha and
    .run_attempt == $attempt and
    .status == "completed" and
    .conclusion == "success"
  ' "$RUN_JSON" >/dev/null ||
  die "GitHub migration run is not the exact successful master attempt"
if [[ "$MODE" != "verify" ]]; then
  [[ "$(gh api "repos/${GH_REPOSITORY}/git/ref/heads/master" --jq .object.sha)" == "$SOURCE_SHA" ]] ||
    die "SOURCE_SHA is no longer current master"
fi

artifact_name="oci-migration-success-provenance-${MIGRATION_RUN_ID}-${MIGRATION_RUN_ATTEMPT}"
gh api \
  "repos/${GH_REPOSITORY}/actions/runs/${MIGRATION_RUN_ID}/artifacts?per_page=100" \
  > "$ARTIFACTS_JSON"
jq -e --arg name "$artifact_name" '
  [.artifacts[] | select(.name == $name and .expired == false)] | length == 1
' "$ARTIFACTS_JSON" >/dev/null ||
  die "exact unexpired migration success artifact is not unique"
gh run download "$MIGRATION_RUN_ID" \
  --repo "$GH_REPOSITORY" \
  --name "$artifact_name" \
  --dir "$ARTIFACT_DIR"

summary_count="$(
  find "$ARTIFACT_DIR" -type f -name migration-summary.env | wc -l | tr -d ' '
)"
[[ "$summary_count" == "1" ]] ||
  die "migration success artifact does not contain exactly one summary"
SUMMARY_FILE="$(find "$ARTIFACT_DIR" -type f -name migration-summary.env -print)"
[[ ! -L "$SUMMARY_FILE" ]] ||
  die "migration success summary must not be a symlink"
chmod 600 "$SUMMARY_FILE"

allowed_summary_keys='aks_power_state
artifact_run_binding
azure_cluster_resource_id_sha256
azure_cluster_stopped_deallocated
azure_writers_frozen
closed_recovery_retry
database_count
destructive_boundary_crossed
fencing_generation
final_journal_sha256
github_run_attempt
github_run_id
http_mutation_fence_removed
journal_generation
journal_heartbeat_epoch
journal_sequence
logical_source_target_parity
migration_id
oci_reopened_healthy
runtime_deploy_source_sha
schema
source_sha
source_signature_aggregate_sha256
target_signature_aggregate_sha256
terminal_phase
terminal_status
vmss_instances_deallocated'
actual_summary_keys="$(
  sed '/^[[:space:]]*$/d; s/=.*//' "$SUMMARY_FILE" | sort
)"
[[ "$actual_summary_keys" == "$allowed_summary_keys" ]] ||
  die "migration success summary field set differs from the retirement contract"
require_summary_value schema betstan.oci-migration-success.v1
require_summary_value migration_id "$MIGRATION_ID"
require_summary_value source_sha "$SOURCE_SHA"
runtime_deploy_source_sha="$(
  env_value "$SUMMARY_FILE" runtime_deploy_source_sha
)"
[[ "$runtime_deploy_source_sha" =~ ^[0-9a-f]{40}$ ]] ||
  die "runtime deployment source SHA is invalid"
closed_recovery_retry="$(
  env_value "$SUMMARY_FILE" closed_recovery_retry
)"
case "$closed_recovery_retry" in
  false)
    [[ "$runtime_deploy_source_sha" == "$SOURCE_SHA" ]] ||
      die "ordinary migration runtime deployment SHA differs"
    ;;
  true)
    [[ "$runtime_deploy_source_sha" != "$SOURCE_SHA" ]] ||
      die "closed-recovery runtime deployment SHA was not an ancestor"
    ;;
  *)
    die "closed-recovery retry flag is invalid"
    ;;
esac
require_summary_value github_run_id "$MIGRATION_RUN_ID"
require_summary_value github_run_attempt "$MIGRATION_RUN_ATTEMPT"
require_summary_value artifact_run_binding \
  "${MIGRATION_RUN_ID}-${MIGRATION_RUN_ATTEMPT}"
require_summary_value terminal_phase DEPLOYED_HEALTHY
require_summary_value terminal_status DEPLOYED_HEALTHY
require_summary_value destructive_boundary_crossed true
require_summary_value database_count 8
require_summary_value logical_source_target_parity true
require_summary_value oci_reopened_healthy true
require_summary_value http_mutation_fence_removed true
require_summary_value azure_writers_frozen true
require_summary_value azure_cluster_resource_id_sha256 \
  "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256"
summary_power_state="$(env_value "$SUMMARY_FILE" aks_power_state)"
[[ "$summary_power_state" == "Stopped" ||
  "$summary_power_state" == "Deallocated" ]] ||
  die "migration success summary does not prove a stopped AKS control plane"
require_summary_value vmss_instances_deallocated true
require_summary_value azure_cluster_stopped_deallocated true
require_positive_integer journal_generation
require_positive_integer journal_sequence
require_positive_integer journal_heartbeat_epoch
require_positive_integer fencing_generation
FINAL_JOURNAL_SHA256="$(env_value "$SUMMARY_FILE" final_journal_sha256)"
[[ "$FINAL_JOURNAL_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  die "final migration journal digest is invalid"
source_signature="$(env_value "$SUMMARY_FILE" source_signature_aggregate_sha256)"
target_signature="$(env_value "$SUMMARY_FILE" target_signature_aggregate_sha256)"
[[ "$source_signature" =~ ^[0-9a-f]{64}$ &&
  "$source_signature" == "$target_signature" ]] ||
  die "source and target aggregate signatures do not match"

OCI_PUBLIC_URL=https://betstan.xyz \
OCI_REDIRECT_URL=https://www.betstan.xyz \
OCI_DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
OUTPUT_DIR="$RETIREMENT_STATE_DIR/public-health" \
  "$ROOT_DIR/infra/oci/agents/smoke-liveness-stan.sh" >/dev/null
fi

primary_status="$(group_presence "$AZURE_RESOURCE_GROUP")" ||
  die "Azure API could not determine primary resource-group presence"
managed_status="$(group_presence "$AZURE_EXPECTED_NODE_RESOURCE_GROUP")" ||
  die "Azure API could not determine managed resource-group presence"
if [[ "$MODE" == "verify" ]]; then
  [[ "$primary_status" == "absent" && "$managed_status" == "absent" ]] ||
    die "Azure resource groups remain"
  [[ "$EXPECTED_INVENTORY_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    die "verify requires the approved inventory digest"
  validate_state_identity
  verify_subscription_absence
  write_state retired
  cleanup_private_evidence
  printf 'AZURE_RESOURCES_RETIRED cost_verification=pending_delayed_reporting\n'
  exit 0
fi

if [[ -f "$STATE_FILE" ]]; then
  [[ "$MODE" == "execute" ]] ||
    die "retirement state already exists; use execute to resume"
else
  [[ "$primary_status" == "present" && "$managed_status" == "present" ]] ||
    die "initial Azure resource groups are not both present"
  az aks show \
    --subscription "$AZURE_SUBSCRIPTION_ID" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$AZURE_CLUSTER_NAME" -o json > "$cluster_json"
  cluster_id="$(jq -r .id "$cluster_json")"
  cluster_id_digest="$(
    printf '%s' "$cluster_id" | sha256_text
  )"
  [[ "$cluster_id_digest" == "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" ]] ||
    die "live AKS resource identity differs from the approved fingerprint"
  [[ "$(jq -r .nodeResourceGroup "$cluster_json")" == "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" ]] ||
    die "live AKS managed resource group differs"
  live_power_state="$(jq -r '.powerState.code // empty' "$cluster_json")"
  [[ "$live_power_state" == "Stopped" ||
    "$live_power_state" == "Deallocated" ]] ||
    die "AKS control plane is not stopped"
  CLUSTER_ETAG="$(jq -r '.eTag // .etag // empty' "$cluster_json")"
  [[ -n "$CLUSTER_ETAG" ]] ||
    die "live AKS ETag is missing"

  list_group_resources "$AZURE_RESOURCE_GROUP" "$primary_inventory"
  list_group_resources "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" "$managed_inventory"
  combine_inventory "$primary_inventory" "$managed_inventory" \
    "$INITIAL_INVENTORY_FILE"
  validate_initial_inventory "$INITIAL_INVENTORY_FILE"
  vmss_name="$(
    jq -r '
      [.[] | select(
        (.type | ascii_downcase) ==
          "microsoft.compute/virtualmachinescalesets"
      )] | if length == 1 then .[0].name else empty end
    ' "$managed_inventory"
  )"
  [[ -n "$vmss_name" ]] ||
    die "expected exactly one Azure VM scale set"
  az vmss list-instances \
    --subscription "$AZURE_SUBSCRIPTION_ID" \
    --resource-group "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" \
    --name "$vmss_name" \
    --expand instanceView -o json |
    jq -e '
      type == "array" and
      all(.[]; any(.instanceView.statuses[]?;
        .code == "PowerState/deallocated"))
    ' >/dev/null ||
    die "an Azure VM scale-set instance is not deallocated"
  for group in "$AZURE_RESOURCE_GROUP" "$AZURE_EXPECTED_NODE_RESOURCE_GROUP"; do
    az lock list \
      --subscription "$AZURE_SUBSCRIPTION_ID" \
      --resource-group "$group" -o json |
      jq -e 'length == 0' >/dev/null ||
      die "an Azure resource-group lock blocks exact retirement"
  done
  inventory_sha256="$(sha256_file "$INITIAL_INVENTORY_FILE")"
  if [[ "$MODE" == "plan" ]]; then
    printf 'azure_retirement=READY_TO_CONFIRM inventory_sha256=%s resources=28\n' \
      "$inventory_sha256"
    exit 0
  fi
  [[ "$EXPECTED_INVENTORY_SHA256" == "$inventory_sha256" ]] ||
    die "approved inventory digest differs from the live inventory"
  expected_confirmation="DELETE AZURE AFTER OCI ${MIGRATION_ID} ${SOURCE_SHA} ${inventory_sha256}"
  [[ "$RETIRE_AZURE_CONFIRMATION" == "$expected_confirmation" ]] ||
    die "destructive retirement confirmation differs"
  write_state planned
fi

while true; do
  phase="$(env_value "$STATE_FILE" phase)"
  case "$phase" in
    planned)
      list_group_resources "$AZURE_RESOURCE_GROUP" "$primary_inventory"
      list_group_resources "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" "$managed_inventory"
      combine_inventory "$primary_inventory" "$managed_inventory" \
        "$CURRENT_INVENTORY_FILE"
      [[ "$(sha256_file "$CURRENT_INVENTORY_FILE")" == "$EXPECTED_INVENTORY_SHA256" ]] ||
        die "Azure inventory drifted after destructive approval"
      write_state aks-delete-intent
      ;;
    aks-delete-intent)
      cluster_status="$(cluster_presence)" ||
        die "Azure API could not determine exact AKS presence"
      if [[ "$cluster_status" == "absent" ]]; then
        write_state aks-absent
        continue
      fi
      az aks show \
        --subscription "$AZURE_SUBSCRIPTION_ID" \
        --resource-group "$AZURE_RESOURCE_GROUP" \
        --name "$AZURE_CLUSTER_NAME" -o json > "$cluster_json"
      live_cluster_id="$(jq -r '.id // empty' "$cluster_json")"
      live_cluster_digest="$(
        printf '%s' "$live_cluster_id" | sha256_text
      )"
      [[ "$live_cluster_digest" == "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" ]] ||
        die "AKS identity changed after delete intent"
      provisioning_state="$(jq -r '.provisioningState // empty' "$cluster_json")"
      live_etag="$(jq -r '.eTag // .etag // empty' "$cluster_json")"
      if [[ "$provisioning_state" != "Deleting" ]]; then
        [[ "$live_etag" == "$CLUSTER_ETAG" ]] ||
          die "AKS ETag changed after delete intent"
        az rest \
          --method delete \
          --url "${live_cluster_id}?api-version=${AZURE_AKS_API_VERSION}" \
          --headers "If-Match=${CLUSTER_ETAG}" \
          --output none
      fi
      write_state aks-delete-submitted
      ;;
    aks-delete-submitted)
      wait_for_cluster_absence
      write_state aks-absent
      ;;
    aks-absent)
      managed_status="$(group_presence "$AZURE_EXPECTED_NODE_RESOURCE_GROUP")" ||
        die "Azure API could not determine managed resource-group presence"
      if [[ "$managed_status" == "absent" ]]; then
        write_state managed-absent
      else
        write_state managed-delete-intent
      fi
      ;;
    managed-delete-intent)
      if wait_for_managed_group_cleanup; then
        write_state managed-absent
        continue
      fi
      list_group_resources \
        "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" "$CURRENT_INVENTORY_FILE"
      validate_inventory_subset "$CURRENT_INVENTORY_FILE"
      managed_group_json="$RETIREMENT_STATE_DIR/managed-group.json"
      az group show \
        --subscription "$AZURE_SUBSCRIPTION_ID" \
        --name "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" \
        -o json > "$managed_group_json"
      managed_group_state="$(
        jq -r '.properties.provisioningState // empty' "$managed_group_json"
      )"
      if [[ "$managed_group_state" != "Deleting" ]]; then
        az group delete \
          --subscription "$AZURE_SUBSCRIPTION_ID" \
          --name "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" \
          --yes --no-wait
      fi
      write_state managed-delete-submitted
      ;;
    managed-delete-submitted)
      wait_for_group_absence \
        "$AZURE_EXPECTED_NODE_RESOURCE_GROUP" managed-resource-group
      write_state managed-absent
      ;;
    managed-absent)
      primary_status="$(group_presence "$AZURE_RESOURCE_GROUP")" ||
        die "Azure API could not determine primary resource-group presence"
      if [[ "$primary_status" == "absent" ]]; then
        write_state resource-groups-absent
      else
        list_group_resources "$AZURE_RESOURCE_GROUP" "$CURRENT_INVENTORY_FILE"
        validate_inventory_subset "$CURRENT_INVENTORY_FILE"
        write_state primary-delete-intent
      fi
      ;;
    primary-delete-intent)
      primary_status="$(group_presence "$AZURE_RESOURCE_GROUP")" ||
        die "Azure API could not determine primary resource-group presence"
      if [[ "$primary_status" == "absent" ]]; then
        write_state resource-groups-absent
        continue
      fi
      list_group_resources "$AZURE_RESOURCE_GROUP" "$CURRENT_INVENTORY_FILE"
      validate_inventory_subset "$CURRENT_INVENTORY_FILE"
      primary_group_json="$RETIREMENT_STATE_DIR/primary-group.json"
      az group show \
        --subscription "$AZURE_SUBSCRIPTION_ID" \
        --name "$AZURE_RESOURCE_GROUP" \
        -o json > "$primary_group_json"
      primary_group_state="$(
        jq -r '.properties.provisioningState // empty' "$primary_group_json"
      )"
      if [[ "$primary_group_state" != "Deleting" ]]; then
        az group delete \
          --subscription "$AZURE_SUBSCRIPTION_ID" \
          --name "$AZURE_RESOURCE_GROUP" \
          --yes --no-wait
      fi
      write_state primary-delete-submitted
      ;;
    primary-delete-submitted)
      wait_for_group_absence "$AZURE_RESOURCE_GROUP" primary-resource-group
      write_state resource-groups-absent
      ;;
    resource-groups-absent | retired)
      verify_subscription_absence
      write_state retired
      cleanup_private_evidence
      printf 'AZURE_RESOURCES_RETIRED cost_verification=pending_delayed_reporting\n'
      break
      ;;
    *)
      die "retirement state contains an unknown phase"
      ;;
  esac
done
