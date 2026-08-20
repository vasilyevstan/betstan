#!/usr/bin/env bash
set -euo pipefail
##############################################################################
# audit-oci-primary-retirement-stan.sh
# Read-only terminal retirement audit for OCI primary migration.
# Exit codes: 0=AZURE_RETIRED, 1=NO_GO, 2=AUDIT_INCOMPLETE,
#             3=BILLING_INGESTION_PENDING
# NEVER mutates/cancels/deletes/re-enables/approves anything.
##############################################################################

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=azure-retirement-billing-lib-stan.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/azure-retirement-billing-lib-stan.sh"
GH_REPOSITORY="vasilyevstan/betstan"

# Reviewed constants
readonly CANONICAL_HOST="betstan.xyz"
readonly REDIRECT_HOST="www.betstan.xyz"
readonly AZURE_RESOURCE_GROUP="betstan-rg"
readonly AZURE_MANAGED_GROUP="MC_betstan-rg_betstan-aks_eastus"
readonly BASTION_CIDR="192.0.2.1/32"
readonly BASTION_MAX_SESSION_TTL_SECONDS=10800
readonly RETAINED_SP_DISPLAY_NAME="betstan-github-sp"
readonly WORKFLOW_MIGRATE="oci-migrate.yml"
readonly WORKFLOW_RECOVERY="oci-migration-recovery.yml"
readonly WORKFLOW_CAPACITY="oci-capacity-acquire.yml"
readonly WORKFLOW_INFRASTRUCTURE="oci-infrastructure.yml"
readonly WORKFLOW_OCI_BUILD="oci-production-build.yml"
readonly WORKFLOW_DEPLOY="oci-production-deploy.yml"
readonly WORKFLOW_AZURE_BUILD="production-build.yml"
readonly WORKFLOW_AZURE_DEPLOY="production-deploy.yml"
readonly BILLING_MIN_WINDOWS=3
readonly BILLING_MIN_SPAN_HOURS=96
readonly BILLING_MAX_STALE_HOURS=48
readonly INERT_RECORD_THRESHOLD_SECONDS=86400
readonly IDENTITY_STATE_SCHEMA="betstan.identity-retirement-terminal.v1"
readonly IDENTITY_ATTESTATION_SCHEMA="betstan.identity-retirement-legacy-attestation.v1"
readonly OCI_CLI_VERSION_REQUIRED="3.90.0"
readonly OCI_REGISTRY_MAX_BYTES=500000000
readonly OCI_BOOT_VOLUME_GB=50
readonly OCI_BOOT_VOLUME_VPUS_PER_GB=10
readonly OCI_MONGO_VOLUME_GB=50
readonly OCI_A1_OCPUS=2
readonly OCI_A1_MEMORY_GB=12
readonly OCI_LB_MIN_MBPS=10
readonly OCI_LB_MAX_MBPS=10
readonly OCI_EXPECTED_MONTHLY_COST=0
readonly OCI_REGION="eu-frankfurt-1"
readonly REVIEWED_INGRESS_IPV4="92.5.96.113"

# Reviewed private OCI infrastructure evidence (fail-closed, not caller-substitutable)
readonly REVIEWED_INFRASTRUCTURE_RUN_ID="32254874213"
readonly REVIEWED_INFRASTRUCTURE_RUN_ATTEMPT="1"
readonly REVIEWED_MIGRATION_RUN_ID="32256565339"
readonly REVIEWED_MIGRATION_RUN_ATTEMPT="1"
readonly REVIEWED_MIGRATION_SOURCE_SHA="a1716b64a36d48dbb35023200a96282587d0ac91"
readonly REVIEWED_MIGRATION_ID="32256565339-1"
readonly REVIEWED_CLUSTER_RESOURCE_FINGERPRINT="6047248565caed9e7f35e9608cefc99d2ceb097faab16a5f5f9cbfc61d5baf16"
readonly REVIEWED_OCI_PROVENANCE_DIGEST="6aacf7029e8ea5a5b3e905a4c07e6318885f69786332b079d30f2b3790fed8b2"
readonly REVIEWED_OCI_INVENTORY_DIGEST="56c3fac911b71a31214129b5a027c669a362c62fb6b9b6e4559d439c834d8377"
readonly REVIEWED_ARTIFACT_DIGEST="427b598c9c140803d6fb3bbceca4caa7554e8e34e5c866b49f92e43709b54bd7"

# Reviewed private identity evidence anchors (fail-closed)
readonly REVIEWED_IDENTITY_STATE_DIGEST="72b983e77fd2f76916ed47def8747ee4a9f1d4be69c72b58508b13e1ddc420ff"
readonly REVIEWED_IDENTITY_ATTESTATION_DIGEST="8c6ee112d76c17194f8c04505f6e43323221986ca59b4891f2e8845062f0ca40"

# Reviewed Azure resource-retirement evidence anchor (fail-closed)
# From terminal verify event 2026-08-19T15:43:22.623Z; execute completed 15:42:17.622Z
readonly REVIEWED_RETIREMENT_STATE_DIGEST="ca76c3cf5eeba00974e41ff8677093f8b1b757d746322937a9efccf5d0354ba4"
readonly REVIEWED_RETIREMENT_STATE_SCHEMA="betstan.azure-retirement.v1"
readonly REVIEWED_RETIREMENT_STATE_PHASE="retired"
# From successful retirement plan at 2026-08-19T15:08:55.209Z (28-resource allowlist)
readonly REVIEWED_AZURE_INVENTORY_DIGEST="b38349b0c710fbb1141cdcb85ee69e444fa3facdffe744d36153b0673d2934c6"
# Hardcoded reviewed cutoff: do not derive from mutable file mtime or caller input
readonly RETIREMENT_CUTOFF_EPOCH=1787154202
readonly BILLING_CUTOFF_EPOCH=1787184000
readonly BILLING_CUTOFF_DATE="2026-08-20"
readonly BILLING_FIRST_USAGE_DATE="20260820"
readonly BILLING_QUERY_START_DATE="2026-08-12"

# Required inputs
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
OCI_COMPARTMENT_OCID="${OCI_COMPARTMENT_OCID:-}"
OCI_INFRASTRUCTURE_PROVENANCE_FILE="${OCI_INFRASTRUCTURE_PROVENANCE_FILE:-}"
EXPECTED_OCI_INVENTORY_DIGEST="${EXPECTED_OCI_INVENTORY_DIGEST:-}"
EXPECTED_OCI_PROVENANCE_DIGEST="${EXPECTED_OCI_PROVENANCE_DIGEST:-}"
AZURE_SUBSCRIPTION_FINGERPRINT="${AZURE_SUBSCRIPTION_FINGERPRINT:-}"
AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256="${AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256:-}"
AZURE_RETIREMENT_STATE_FILE="${AZURE_RETIREMENT_STATE_FILE:-}"
MIGRATION_RUN_ID="${MIGRATION_RUN_ID:-}"
MIGRATION_RUN_ATTEMPT="${MIGRATION_RUN_ATTEMPT:-}"
MIGRATION_ID="${MIGRATION_ID:-}"
MIGRATION_SHA="${MIGRATION_SHA:-}"
IDENTITY_STATE_FILE="${IDENTITY_STATE_FILE:-}"
IDENTITY_ATTESTATION_FILE="${IDENTITY_ATTESTATION_FILE:-}"
BILLING_OBSERVATION_FILE="${BILLING_OBSERVATION_FILE:-}"
AUDIT_WORK_PARENT="${AUDIT_WORK_PARENT:-}"

# Globals
declare -i errors=0 unknowns=0
AUDIT_WORK_DIR=""
AZURE_SUBSCRIPTION_BOUND=false
AZURE_SUBSCRIPTION_ID=""

##############################################################################
# Utilities
##############################################################################
emit() { printf '%s\n' "$1"; }

die_nogo() { emit "NO_GO reason=$1"; exit 1; }
die_incomplete() { emit "AUDIT_INCOMPLETE reason=$1"; exit 2; }

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

require_input() {
  [[ -n "$1" ]] || die_incomplete "missing_input_$2"
}

require_input "$OCI_DIAGNOSTIC_URL" OCI_DIAGNOSTIC_URL
require_input "$OCI_COMPARTMENT_OCID" OCI_COMPARTMENT_OCID
require_input "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" OCI_INFRASTRUCTURE_PROVENANCE_FILE
require_input "$EXPECTED_OCI_INVENTORY_DIGEST" EXPECTED_OCI_INVENTORY_DIGEST
require_input "$EXPECTED_OCI_PROVENANCE_DIGEST" EXPECTED_OCI_PROVENANCE_DIGEST
require_input "$AZURE_SUBSCRIPTION_FINGERPRINT" AZURE_SUBSCRIPTION_FINGERPRINT
require_input "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256
require_input "$AZURE_RETIREMENT_STATE_FILE" AZURE_RETIREMENT_STATE_FILE
require_input "$MIGRATION_RUN_ID" MIGRATION_RUN_ID
require_input "$MIGRATION_RUN_ATTEMPT" MIGRATION_RUN_ATTEMPT
require_input "$MIGRATION_ID" MIGRATION_ID
require_input "$MIGRATION_SHA" MIGRATION_SHA
require_input "$IDENTITY_STATE_FILE" IDENTITY_STATE_FILE
require_input "$IDENTITY_ATTESTATION_FILE" IDENTITY_ATTESTATION_FILE

validate_private_file() {
  local file="$1" label="$2"
  [[ -f "$file" && ! -L "$file" ]] || {
    emit "${label}=not_regular_file"; unknowns=$((unknowns + 1)); return 1; }
  local mode
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file" 2>/dev/null)" || {
    emit "${label}=stat_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$mode" == "600" ]] || {
    emit "${label}=unsafe_mode"; unknowns=$((unknowns + 1)); return 1; }
  return 0
}

state_field() {
  local file="$1" key="$2"
  local count val
  count="$(grep -c "^${key}=" "$file")" || count=0
  [[ "$count" == "1" ]] || return 1
  val="$(grep "^${key}=" "$file" | cut -d= -f2-)"
  printf '%s' "$val"
}

validate_exact_field_set() {
  local file="$1" expected_fields="$2" label="$3"
  local actual_fields total_fields unique_fields expected_count

  if grep -q '^[[:space:]]*$' "$file" ||
     grep -qv '^[A-Za-z_][A-Za-z0-9_]*=.*$' "$file"; then
    emit "${label}=malformed_line"
    return 1
  fi
  actual_fields="$(sed 's/=.*//' "$file" | LC_ALL=C sort)"
  [[ "$actual_fields" == "$expected_fields" ]] || {
    emit "${label}=field_set_mismatch"
    return 1
  }
  total_fields="$(wc -l <"$file" | tr -d ' ')"
  unique_fields="$(sed 's/=.*//' "$file" | LC_ALL=C sort -u | wc -l | tr -d ' ')"
  expected_count="$(printf '%s\n' "$expected_fields" | wc -l | tr -d ' ')"
  [[ "$total_fields" == "$expected_count" &&
     "$unique_fields" == "$expected_count" ]] || {
    emit "${label}=duplicate_field"
    return 1
  }
}

GH_SECRET_COUNT=""
GH_SECRET_ERROR=""
github_secret_count() {
  local endpoint="$1" secret_name="$2"
  local response valid
  GH_SECRET_COUNT=""
  GH_SECRET_ERROR=""

  response="$(gh api "${endpoint}?per_page=100&page=1" 2>/dev/null)" || {
    GH_SECRET_ERROR="api_error"
    return 1
  }
  valid="$(jq -r '
    type == "object" and
    (.total_count | type) == "number" and
    .total_count >= 0 and
    (.total_count | floor) == .total_count and
    .total_count <= 100 and
    (.secrets | type) == "array" and
    (.secrets | length) == .total_count and
    all(.secrets[]; type == "object" and (.name | type) == "string") and
    ([.secrets[].name] | unique | length) == (.secrets | length)
  ' <<<"$response" 2>/dev/null)" || {
    GH_SECRET_ERROR="parse_error"
    return 1
  }
  [[ "$valid" == "true" ]] || {
    GH_SECRET_ERROR="incomplete_listing"
    return 1
  }
  GH_SECRET_COUNT="$(jq -r --arg name "$secret_name" \
    '[.secrets[] | select(.name == $name)] | length' \
    <<<"$response" 2>/dev/null)" || {
    GH_SECRET_ERROR="count_error"
    return 1
  }
  [[ "$GH_SECRET_COUNT" =~ ^[0-9]+$ ]] || {
    GH_SECRET_ERROR="count_invalid"
    return 1
  }
}

##############################################################################
# Input validation
##############################################################################
emit "audit_mode=read_only"

[[ "$BILLING_CUTOFF_EPOCH" -gt "$RETIREMENT_CUTOFF_EPOCH" &&
   $((BILLING_CUTOFF_EPOCH - RETIREMENT_CUTOFF_EPOCH)) -lt 86400 ]] ||
  die_incomplete "billing_cutoff_binding_invalid"

# Validate diagnostic URL format
diagnostic_host="${OCI_DIAGNOSTIC_URL#https://}"
diagnostic_host="${diagnostic_host%%/*}"
[[ "$OCI_DIAGNOSTIC_URL" == "https://${diagnostic_host}" ]] ||
  die_incomplete "invalid_diagnostic_url"
# Validate diagnostic IPv4 octets
diag_ip="${diagnostic_host%.nip.io}"
if [[ "$diag_ip" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  for octet in "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"; do
    [[ "$octet" -le 255 ]] || die_incomplete "invalid_diagnostic_ipv4"
  done
else
  die_incomplete "invalid_diagnostic_url_format"
fi
[[ "$diag_ip" == "$REVIEWED_INGRESS_IPV4" ]] ||
  die_incomplete "diagnostic_ip_binding_mismatch"

# Required commands
for cmd in oci az gh curl dig openssl jq date stat mktemp find sleep; do
  command -v "$cmd" >/dev/null 2>&1 ||
    die_incomplete "missing_command_${cmd}"
done
if ! command -v sha256sum >/dev/null 2>&1 &&
   ! command -v shasum >/dev/null 2>&1; then
  die_incomplete "missing_command_sha256"
fi

# Validate inputs
[[ "$MIGRATION_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  die_incomplete "invalid_run_id"
[[ "$MIGRATION_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] ||
  die_incomplete "invalid_run_attempt"
[[ "$MIGRATION_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  die_incomplete "invalid_migration_sha"
[[ "$EXPECTED_OCI_INVENTORY_DIGEST" =~ ^[0-9a-f]{64}$ ]] ||
  die_incomplete "invalid_inventory_digest"
[[ "$EXPECTED_OCI_PROVENANCE_DIGEST" =~ ^[0-9a-f]{64}$ ]] ||
  die_incomplete "invalid_provenance_digest"
[[ "$AZURE_SUBSCRIPTION_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] ||
  die_incomplete "invalid_subscription_fingerprint"
[[ "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  die_incomplete "invalid_cluster_resource_id_sha256"
[[ "$OCI_COMPARTMENT_OCID" =~ ^ocid1\.[a-z0-9-]+\.oc[0-9]*\..+ ]] ||
  die_incomplete "invalid_compartment_ocid"

# Fail-closed: caller-provided values must match reviewed constants
[[ "$MIGRATION_RUN_ID" == "$REVIEWED_MIGRATION_RUN_ID" ]] ||
  die_incomplete "run_id_binding_mismatch"
[[ "$MIGRATION_RUN_ATTEMPT" == "$REVIEWED_MIGRATION_RUN_ATTEMPT" ]] ||
  die_incomplete "run_attempt_binding_mismatch"
[[ "$MIGRATION_SHA" == "$REVIEWED_MIGRATION_SOURCE_SHA" ]] ||
  die_incomplete "source_sha_binding_mismatch"
[[ "$MIGRATION_ID" == "$REVIEWED_MIGRATION_ID" ]] ||
  die_incomplete "migration_id_binding_mismatch"
[[ "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" == "$REVIEWED_CLUSTER_RESOURCE_FINGERPRINT" ]] ||
  die_incomplete "cluster_fingerprint_binding_mismatch"
[[ "$EXPECTED_OCI_PROVENANCE_DIGEST" == "$REVIEWED_OCI_PROVENANCE_DIGEST" ]] ||
  die_incomplete "provenance_digest_binding_mismatch"
[[ "$EXPECTED_OCI_INVENTORY_DIGEST" == "$REVIEWED_OCI_INVENTORY_DIGEST" ]] ||
  die_incomplete "inventory_digest_binding_mismatch"

# Validate Azure retirement state file as resource-retirement evidence anchor
validate_private_file "$AZURE_RETIREMENT_STATE_FILE" "retirement_state" ||
  die_incomplete "retirement_state_file_invalid"
ret_state_digest="$(sha256_file "$AZURE_RETIREMENT_STATE_FILE")" || die_incomplete "retirement_state_hash_error"
[[ "$ret_state_digest" == "$REVIEWED_RETIREMENT_STATE_DIGEST" ]] ||
  die_incomplete "retirement_state_digest_mismatch"
retirement_state_fields="cluster_etag
cluster_resource_id_sha256
final_journal_sha256
github_run_attempt
github_run_id
inventory_sha256
migration_id
phase
schema
source_sha
subscription_id_sha256"
validate_exact_field_set \
  "$AZURE_RETIREMENT_STATE_FILE" \
  "$retirement_state_fields" \
  "retirement_state" ||
  die_incomplete "retirement_state_field_contract"
ret_state_schema="$(state_field "$AZURE_RETIREMENT_STATE_FILE" "schema")" ||
  die_incomplete "retirement_state_schema_missing"
[[ "$ret_state_schema" == "$REVIEWED_RETIREMENT_STATE_SCHEMA" ]] ||
  die_incomplete "retirement_state_schema_mismatch"
ret_state_phase="$(state_field "$AZURE_RETIREMENT_STATE_FILE" "phase")" ||
  die_incomplete "retirement_state_phase_missing"
[[ "$ret_state_phase" == "$REVIEWED_RETIREMENT_STATE_PHASE" ]] ||
  die_incomplete "retirement_state_phase_mismatch"
# Validate retirement state inventory hash against reviewed 28-resource allowlist
ret_state_inv="$(state_field "$AZURE_RETIREMENT_STATE_FILE" "inventory_sha256")" ||
  die_incomplete "retirement_state_inventory_missing"
[[ "$ret_state_inv" == "$REVIEWED_AZURE_INVENTORY_DIGEST" ]] ||
  die_incomplete "retirement_state_inventory_mismatch"
[[ "$(state_field "$AZURE_RETIREMENT_STATE_FILE" migration_id)" == "$MIGRATION_ID" ]] ||
  die_incomplete "retirement_state_migration_id_mismatch"
[[ "$(state_field "$AZURE_RETIREMENT_STATE_FILE" source_sha)" == "$MIGRATION_SHA" ]] ||
  die_incomplete "retirement_state_source_sha_mismatch"
[[ "$(state_field "$AZURE_RETIREMENT_STATE_FILE" github_run_id)" == "$MIGRATION_RUN_ID" ]] ||
  die_incomplete "retirement_state_run_id_mismatch"
[[ "$(state_field "$AZURE_RETIREMENT_STATE_FILE" github_run_attempt)" == "$MIGRATION_RUN_ATTEMPT" ]] ||
  die_incomplete "retirement_state_run_attempt_mismatch"
[[ "$(state_field "$AZURE_RETIREMENT_STATE_FILE" cluster_resource_id_sha256)" == "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" ]] ||
  die_incomplete "retirement_state_cluster_fingerprint_mismatch"
[[ "$(state_field "$AZURE_RETIREMENT_STATE_FILE" subscription_id_sha256)" == "$AZURE_SUBSCRIPTION_FINGERPRINT" ]] ||
  die_incomplete "retirement_state_subscription_fingerprint_mismatch"
ret_state_journal_sha="$(state_field "$AZURE_RETIREMENT_STATE_FILE" final_journal_sha256)" ||
  die_incomplete "retirement_state_journal_sha_missing"
[[ "$ret_state_journal_sha" =~ ^[0-9a-f]{64}$ ]] ||
  die_incomplete "retirement_state_journal_sha_invalid"
ret_state_etag="$(state_field "$AZURE_RETIREMENT_STATE_FILE" cluster_etag)" ||
  die_incomplete "retirement_state_etag_missing"
[[ "$ret_state_etag" =~ ^[0-9a-fA-F-]{36}$ ]] ||
  die_incomplete "retirement_state_etag_invalid"

# Work directory
if [[ -n "$AUDIT_WORK_PARENT" ]]; then
  [[ -d "$AUDIT_WORK_PARENT" && ! -L "$AUDIT_WORK_PARENT" ]] ||
    die_incomplete "audit_work_parent_invalid"
  local_mode="$(stat -c '%a' "$AUDIT_WORK_PARENT" 2>/dev/null || stat -f '%Lp' "$AUDIT_WORK_PARENT" 2>/dev/null)" || die_incomplete "stat_work_parent_failed"
  [[ "$local_mode" == "700" ]] ||
    die_incomplete "audit_work_parent_unsafe_mode"
  AUDIT_WORK_DIR="$(mktemp -d "${AUDIT_WORK_PARENT}/audit.XXXXXX")"
else
  AUDIT_WORK_DIR="$(mktemp -d)"
fi
chmod 0700 "$AUDIT_WORK_DIR"
# shellcheck disable=SC2329 # Invoked by EXIT trap.
cleanup() { rm -rf "$AUDIT_WORK_DIR"; }
trap cleanup EXIT

# Provenance file validation
validate_private_file "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" "provenance_file" || {
  die_incomplete "provenance_file_invalid"; }
prov_digest="$(sha256_file "$OCI_INFRASTRUCTURE_PROVENANCE_FILE")"
[[ "$prov_digest" == "$EXPECTED_OCI_PROVENANCE_DIGEST" ]] || {
  emit "oci_provenance_digest=mismatch"; die_nogo "provenance_digest_mismatch"; }

# Parse provenance using state_field (bash 3.2 compatible, no associative arrays).
prov_field() { state_field "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" "$1"; }

provenance_fields="OCI_MONGO_VOLUME_OCID
availability_domain
bastion_fingerprint
bastion_ocid
boot_volume_gb
boot_volume_ocid
boot_volume_vpus_per_gb
canonical_host
cert_manager_acmesolver_digest
cert_manager_cainjector_digest
cert_manager_chart_sha256
cert_manager_chart_version
cert_manager_controller_digest
cert_manager_startup_digest
cert_manager_webhook_digest
compartment_ocid
diagnostic_host
expected_monthly_cost
infrastructure_finalized
infrastructure_run_attempt
infrastructure_run_id
ingress_ipv4
ingress_nginx_chart_sha256
ingress_nginx_chart_version
instance_fingerprint
instance_ocid
instance_private_ip
instance_public_ip
k3s_node_name
k3s_version
lb_max_mbps
lb_min_mbps
lb_nsg_ocid
lb_ocid
lb_subnet_ocid
mongo_volume_attachment_ocid
mongo_volume_gb
mongo_volume_ocid
namespace
network_prepared
node_memory_gb
node_ocpus
node_shape
public_host
redirect_host
region
runtime_mode
source_sha
target_ssh_public_key_sha256
vcn_fingerprint
vcn_ocid
worker_nsg_ocid
worker_subnet_ocid"
validate_exact_field_set \
  "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" \
  "$provenance_fields" \
  "oci_provenance" ||
  die_incomplete "provenance_field_contract"

[[ "$(prov_field runtime_mode)" == "k3s" ]] ||
  die_incomplete "provenance_runtime_not_k3s"
[[ "$(prov_field source_sha)" == "$MIGRATION_SHA" ]] ||
  die_incomplete "provenance_source_sha_mismatch"
[[ "$(prov_field infrastructure_run_id)" == "$REVIEWED_INFRASTRUCTURE_RUN_ID" ]] ||
  die_incomplete "provenance_run_id_mismatch"
[[ "$(prov_field infrastructure_run_attempt)" == "$REVIEWED_INFRASTRUCTURE_RUN_ATTEMPT" ]] ||
  die_incomplete "provenance_run_attempt_mismatch"
[[ "$(prov_field network_prepared)" == "true" ]] ||
  die_incomplete "provenance_network_not_prepared"
[[ "$(prov_field infrastructure_finalized)" == "true" ]] ||
  die_incomplete "provenance_not_finalized"
[[ "$(prov_field region)" == "$OCI_REGION" ]] ||
  die_incomplete "provenance_region_mismatch"
[[ "$(prov_field compartment_ocid)" == "$OCI_COMPARTMENT_OCID" ]] ||
  die_incomplete "provenance_compartment_mismatch"
[[ "$(prov_field canonical_host)" == "$CANONICAL_HOST" ]] ||
  die_incomplete "provenance_canonical_host_mismatch"
[[ "$(prov_field redirect_host)" == "$REDIRECT_HOST" ]] ||
  die_incomplete "provenance_redirect_host_mismatch"
[[ "$(prov_field diagnostic_host)" == "$diagnostic_host" ]] ||
  die_incomplete "provenance_diagnostic_host_mismatch"
[[ "$(prov_field ingress_ipv4)" == "$diag_ip" ]] ||
  die_incomplete "provenance_ingress_ip_mismatch"
[[ "$(prov_field public_host)" == "$CANONICAL_HOST" ]] ||
  die_incomplete "provenance_public_host_mismatch"
[[ "$(prov_field node_shape)" == "VM.Standard.A1.Flex" ]] ||
  die_incomplete "provenance_shape_mismatch"
[[ "$(prov_field node_ocpus)" == "$OCI_A1_OCPUS" ]] ||
  die_incomplete "provenance_ocpus_mismatch"
[[ "$(prov_field node_memory_gb)" == "$OCI_A1_MEMORY_GB" ]] ||
  die_incomplete "provenance_memory_mismatch"
[[ "$(prov_field boot_volume_gb)" == "$OCI_BOOT_VOLUME_GB" ]] ||
  die_incomplete "provenance_boot_volume_mismatch"
[[ "$(prov_field boot_volume_vpus_per_gb)" == "$OCI_BOOT_VOLUME_VPUS_PER_GB" ]] ||
  die_incomplete "provenance_boot_volume_vpus_mismatch"
[[ "$(prov_field mongo_volume_gb)" == "$OCI_MONGO_VOLUME_GB" ]] ||
  die_incomplete "provenance_mongo_mismatch"
[[ "$(prov_field lb_min_mbps)" == "$OCI_LB_MIN_MBPS" ]] ||
  die_incomplete "provenance_lb_min_mismatch"
[[ "$(prov_field lb_max_mbps)" == "$OCI_LB_MAX_MBPS" ]] ||
  die_incomplete "provenance_lb_max_mismatch"
[[ "$(prov_field expected_monthly_cost)" == "0" ]] ||
  die_incomplete "provenance_cost_mismatch"
[[ "$(prov_field namespace)" == "betstan-oci" ]] ||
  die_incomplete "provenance_namespace_mismatch"
[[ "$(prov_field k3s_node_name)" == "betstan-k3s" ]] ||
  die_incomplete "provenance_node_name_mismatch"
[[ "$(prov_field k3s_version)" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$ ]] ||
  die_incomplete "provenance_k3s_version_invalid"
[[ "$(prov_field target_ssh_public_key_sha256)" =~ ^[0-9a-f]{64}$ ]] ||
  die_incomplete "provenance_ssh_fingerprint_invalid"

PROV_VCN_OCID="$(prov_field vcn_ocid)"
PROV_BASTION_OCID="$(prov_field bastion_ocid)"
PROV_INSTANCE_OCID="$(prov_field instance_ocid)"
PROV_BOOT_VOLUME_OCID="$(prov_field boot_volume_ocid)"
PROV_MONGO_VOLUME_OCID="$(prov_field mongo_volume_ocid)"
PROV_ATTACHMENT_OCID="$(prov_field mongo_volume_attachment_ocid)"
PROV_LB_OCID="$(prov_field lb_ocid)"
PROV_WORKER_SUBNET_OCID="$(prov_field worker_subnet_ocid)"
PROV_LB_SUBNET_OCID="$(prov_field lb_subnet_ocid)"
PROV_AVAILABILITY_DOMAIN="$(prov_field availability_domain)"
for ocid_binding in \
  "vcn:${PROV_VCN_OCID}" \
  "bastion:${PROV_BASTION_OCID}" \
  "instance:${PROV_INSTANCE_OCID}" \
  "bootvolume:${PROV_BOOT_VOLUME_OCID}" \
  "volume:${PROV_MONGO_VOLUME_OCID}" \
  "volumeattachment:${PROV_ATTACHMENT_OCID}" \
  "loadbalancer:${PROV_LB_OCID}" \
  "subnet:${PROV_WORKER_SUBNET_OCID}" \
  "subnet:${PROV_LB_SUBNET_OCID}"; do
  ocid_type="${ocid_binding%%:*}"
  ocid_value="${ocid_binding#*:}"
  [[ "$ocid_value" == "ocid1.${ocid_type}."* ]] ||
    die_incomplete "provenance_${ocid_type}_ocid_invalid"
done
for network_ocid_field in worker_nsg_ocid lb_nsg_ocid; do
  [[ "$(prov_field "$network_ocid_field")" == ocid1.networksecuritygroup.* ]] ||
    die_incomplete "provenance_${network_ocid_field}_invalid"
done
[[ "$(prov_field OCI_MONGO_VOLUME_OCID)" == "$PROV_MONGO_VOLUME_OCID" ]] ||
  die_incomplete "provenance_mongo_volume_alias_mismatch"
[[ "$(printf '%s' "$PROV_VCN_OCID" | sha256_text)" == "$(prov_field vcn_fingerprint)" ]] ||
  die_incomplete "provenance_vcn_fingerprint_mismatch"
[[ "$(printf '%s' "$PROV_BASTION_OCID" | sha256_text)" == "$(prov_field bastion_fingerprint)" ]] ||
  die_incomplete "provenance_bastion_fingerprint_mismatch"
[[ "$(printf '%s' "$PROV_INSTANCE_OCID" | sha256_text)" == "$(prov_field instance_fingerprint)" ]] ||
  die_incomplete "provenance_instance_fingerprint_mismatch"
for chart_sha_field in ingress_nginx_chart_sha256 cert_manager_chart_sha256; do
  [[ "$(prov_field "$chart_sha_field")" =~ ^[0-9a-f]{64}$ ]] ||
    die_incomplete "provenance_${chart_sha_field}_invalid"
done
for image_digest_field in \
  cert_manager_controller_digest \
  cert_manager_webhook_digest \
  cert_manager_cainjector_digest \
  cert_manager_acmesolver_digest \
  cert_manager_startup_digest; do
  [[ "$(prov_field "$image_digest_field")" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    die_incomplete "provenance_${image_digest_field}_invalid"
done

emit "oci_provenance_digest=verified"

##############################################################################
# 1. Public health (GET/HEAD only, trusted TLS/DNS)
##############################################################################
check_public_health() {
  local fail_count=0

  # DNS: require apex+www resolve to exactly diagnostic IPv4, no AAAA
  local apex_a www_a
  apex_a="$(dig +short A "$CANONICAL_HOST" 2>/dev/null)" || {
    emit "dns_canonical_a=query_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$apex_a" ]] || {
    emit "dns_canonical_a=empty"; unknowns=$((unknowns + 1)); return 1; }
  www_a="$(dig +short A "$REDIRECT_HOST" 2>/dev/null)" || {
    emit "dns_redirect_a=query_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$www_a" ]] || {
    emit "dns_redirect_a=empty"; unknowns=$((unknowns + 1)); return 1; }

  # Validate exactly the diagnostic IP, no extras
  [[ "$(printf '%s\n' "$apex_a" | sed '/^$/d' | wc -l | tr -d ' ')" == "1" &&
     "$apex_a" == "$diag_ip" ]] || {
    emit "dns_canonical_a=unexpected"; errors=$((errors + 1)); fail_count=$((fail_count + 1)); }
  [[ "$(printf '%s\n' "$www_a" | sed '/^$/d' | wc -l | tr -d ' ')" == "1" &&
     "$www_a" == "$diag_ip" ]] || {
    emit "dns_redirect_a=unexpected"; errors=$((errors + 1)); fail_count=$((fail_count + 1)); }

  # AAAA: must be absent (fail closed on query error)
  local apex_aaaa www_aaaa
  apex_aaaa="$(dig +short AAAA "$CANONICAL_HOST" 2>/dev/null)" || {
    emit "dns_canonical_aaaa=query_error"; unknowns=$((unknowns + 1)); return 1; }
  if [[ -n "$apex_aaaa" ]]; then
    emit "dns_canonical_aaaa=present"; errors=$((errors + 1)); fail_count=$((fail_count + 1))
  fi
  www_aaaa="$(dig +short AAAA "$REDIRECT_HOST" 2>/dev/null)" || {
    emit "dns_redirect_aaaa=query_error"; unknowns=$((unknowns + 1)); return 1; }
  if [[ -n "$www_aaaa" ]]; then
    emit "dns_redirect_aaaa=present"; errors=$((errors + 1)); fail_count=$((fail_count + 1))
  fi

  # HTTP: canonical 200, path-preserving www redirect, diagnostic 200.
  local canonical_code redirect_code diag_code
  canonical_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 10 "https://${CANONICAL_HOST}/" 2>/dev/null)" || {
    emit "http_canonical=connection_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$canonical_code" =~ ^[0-9]{3}$ ]] || {
    emit "http_canonical=invalid_status"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$canonical_code" == "200" ]] || {
    emit "http_canonical=${canonical_code}"; errors=$((errors + 1)); fail_count=$((fail_count + 1)); }

  local header_file="$AUDIT_WORK_DIR/redirect-headers"
  local api_probe_path="/api/auth/currentuser?retirement-audit=1"
  redirect_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 10 --dump-header "$header_file" \
    "https://${REDIRECT_HOST}${api_probe_path}" 2>/dev/null)" || {
    emit "http_redirect=connection_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$redirect_code" =~ ^[0-9]{3}$ ]] || {
    emit "http_redirect=invalid_status"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$redirect_code" == "308" ]] || {
    emit "http_redirect_code=${redirect_code}"; errors=$((errors + 1)); fail_count=$((fail_count + 1)); }
  # Validate exactly one Location header with exact value
  local location_count location_val
  location_count="$(grep -ci '^location:' "$header_file" 2>/dev/null)" || location_count=0
  [[ "$location_count" == "1" ]] || {
    emit "http_redirect_location=missing_or_multiple"; unknowns=$((unknowns + 1)); return 1; }
  location_val="$(grep -i '^location:' "$header_file" | tr -d '\r' | sed 's/^[Ll]ocation: *//')"
  [[ "$location_val" == "https://${CANONICAL_HOST}${api_probe_path}" ]] || {
    emit "http_redirect_location=incorrect"; errors=$((errors + 1)); fail_count=$((fail_count + 1)); }

  diag_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 10 "https://${diagnostic_host}/" 2>/dev/null)" || {
    emit "http_diagnostic=connection_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$diag_code" =~ ^[0-9]{3}$ ]] || {
    emit "http_diagnostic=invalid_status"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$diag_code" == "200" ]] || {
    emit "http_diagnostic=${diag_code}"; errors=$((errors + 1)); fail_count=$((fail_count + 1)); }

  local api_host api_label api_body api_headers api_code api_content_type
  for api_host in "$CANONICAL_HOST" "$diagnostic_host"; do
    if [[ "$api_host" == "$CANONICAL_HOST" ]]; then
      api_label="canonical"
    else
      api_label="diagnostic"
    fi
    api_body="$AUDIT_WORK_DIR/${api_label}-api.json"
    api_headers="$AUDIT_WORK_DIR/${api_label}-api.headers"
    api_code="$(curl -sS --output "$api_body" --dump-header "$api_headers" \
      -w '%{http_code}' --max-time 10 \
      "https://${api_host}/api/auth/currentuser" 2>/dev/null)" || {
      emit "http_${api_label}_api=connection_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$api_code" =~ ^[0-9]{3}$ ]] || {
      emit "http_${api_label}_api=invalid_status"; unknowns=$((unknowns + 1)); return 1; }
    if [[ "$api_code" != "200" ]]; then
      emit "http_${api_label}_api=${api_code}"
      errors=$((errors + 1))
      fail_count=$((fail_count + 1))
      continue
    fi
    api_content_type="$(
      awk 'tolower($1)=="content-type:" {$1=""; sub(/^ /,""); sub(/\r$/,""); print}' \
        "$api_headers" | tail -n 1
    )"
    if [[ "$api_content_type" != application/json* ]] ||
       ! jq -e 'type == "object" and has("currentUser")' \
         "$api_body" >/dev/null 2>&1; then
      emit "http_${api_label}_api=invalid_json"
      errors=$((errors + 1))
      fail_count=$((fail_count + 1))
    fi
  done

  # TLS canonical: verify trust, issuer, SANs (apex+www), expiry
  local cert_file="$AUDIT_WORK_DIR/canonical.pem"
  local tls_out tls_rc=0
  tls_out="$(printf 'Q\n' | openssl s_client -connect "${CANONICAL_HOST}:443" \
      -servername "$CANONICAL_HOST" -verify_return_error \
      -showcerts 2>/dev/null)" || tls_rc=$?
  if [[ "$tls_rc" -ne 0 ]]; then
    emit "tls_canonical=connection_error"; unknowns=$((unknowns + 1)); return 1; fi
  printf '%s\n' "$tls_out" | openssl x509 -out "$cert_file" 2>/dev/null || {
    emit "tls_canonical=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  chmod 0600 "$cert_file"

  local issuer
  issuer="$(openssl x509 -in "$cert_file" -noout -issuer 2>/dev/null)" || {
    emit "tls_canonical_issuer=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$issuer" != *"Encrypt"* ]]; then
    emit "tls_canonical_issuer=untrusted"; errors=$((errors + 1)); fail_count=$((fail_count + 1))
  else
    emit "tls_canonical_issuer=trusted"
  fi

  local san_text
  san_text="$(openssl x509 -in "$cert_file" -noout -text 2>/dev/null)" || {
    emit "tls_canonical_san=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  # Canonical cert must have apex+www SANs
  if ! grep -qE "DNS:${CANONICAL_HOST}([ ,]|\$)" <<<"$san_text"; then
    emit "tls_canonical_san_apex=missing"; errors=$((errors + 1)); fail_count=$((fail_count + 1))
  fi
  if ! grep -qE "DNS:${REDIRECT_HOST}([ ,]|\$)" <<<"$san_text"; then
    emit "tls_canonical_san_www=missing"; errors=$((errors + 1)); fail_count=$((fail_count + 1))
  fi
  # Canonical cert expiry
  openssl x509 -in "$cert_file" -noout -checkend 0 2>/dev/null || {
    emit "tls_canonical_expired=true"; errors=$((errors + 1)); fail_count=$((fail_count + 1)); }

  # TLS diagnostic: independent cert with diagnostic SAN and expiry
  local diag_cert="$AUDIT_WORK_DIR/diagnostic.pem"
  local diag_tls_out
  diag_tls_out="$(printf 'Q\n' | openssl s_client -connect "${diagnostic_host}:443" \
      -servername "$diagnostic_host" -verify_return_error \
      -showcerts 2>/dev/null)" || {
    emit "tls_diagnostic=connection_error"; unknowns=$((unknowns + 1)); return 1; }
  printf '%s\n' "$diag_tls_out" | openssl x509 -out "$diag_cert" 2>/dev/null || {
    emit "tls_diagnostic=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  chmod 0600 "$diag_cert"
  local diag_issuer
  diag_issuer="$(openssl x509 -in "$diag_cert" -noout -issuer 2>/dev/null)" || {
    emit "tls_diagnostic_issuer=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$diag_issuer" != *"Encrypt"* ]]; then
    emit "tls_diagnostic_issuer=untrusted"; errors=$((errors + 1)); fail_count=$((fail_count + 1))
  else
    emit "tls_diagnostic_issuer=trusted"
  fi
  # Diagnostic cert must have diagnostic SAN
  local diag_san
  diag_san="$(openssl x509 -in "$diag_cert" -noout -text 2>/dev/null)" || {
    emit "tls_diagnostic_san=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  if ! grep -qF "DNS:${diagnostic_host}" <<<"$diag_san"; then
    emit "tls_diagnostic_san=missing"; errors=$((errors + 1)); fail_count=$((fail_count + 1))
  fi
  # Diagnostic cert expiry
  openssl x509 -in "$diag_cert" -noout -checkend 0 2>/dev/null || {
    emit "tls_diagnostic_expired=true"; errors=$((errors + 1)); fail_count=$((fail_count + 1)); }

  if [[ "$fail_count" -gt 0 ]]; then
    return 1
  fi
  emit "public_health=verified"
  return 0
}

##############################################################################
# 2. OCI inventory via real inventory.sh
##############################################################################
check_oci_inventory() {
  local inv_out="$AUDIT_WORK_DIR/oci-inventory.json"
  local inv_rc=0

  # Run the real inventory helper (env vars are already set/exported)
  env \
    OCI_RUNTIME_MODE=k3s \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$inv_out" \
    OCI_COMPARTMENT_OCID="$OCI_COMPARTMENT_OCID" \
    OCI_EXPECTED_MONTHLY_COST="$OCI_EXPECTED_MONTHLY_COST" \
    OCI_A1_OCPUS="$OCI_A1_OCPUS" \
    OCI_A1_MEMORY_GB="$OCI_A1_MEMORY_GB" \
    OCI_LB_MIN_MBPS="$OCI_LB_MIN_MBPS" \
    OCI_LB_MAX_MBPS="$OCI_LB_MAX_MBPS" \
    OCI_REGISTRY_MAX_BYTES="$OCI_REGISTRY_MAX_BYTES" \
    OCI_IMAGE_PREFIX="betstan" \
    OCI_BOOT_VOLUME_GB="$OCI_BOOT_VOLUME_GB" \
    OCI_BOOT_VOLUME_VPUS_PER_GB="$OCI_BOOT_VOLUME_VPUS_PER_GB" \
    OCI_MONGO_VOLUME_GB="$OCI_MONGO_VOLUME_GB" \
    OCI_CLI_VERSION="$OCI_CLI_VERSION_REQUIRED" \
    bash "$ROOT_DIR/infra/oci/scripts/inventory.sh" >/dev/null 2>&1 || inv_rc=$?

  if [[ "$inv_rc" -ne 0 ]]; then
    emit "oci_inventory=failed"; unknowns=$((unknowns + 1)); return 1; fi
  [[ -f "$inv_out" && -s "$inv_out" ]] || {
    emit "oci_inventory=no_output"; unknowns=$((unknowns + 1)); return 1; }

  # Validate digest
  local actual_digest
  actual_digest="$(sha256_file "$inv_out")"
  [[ "$actual_digest" == "$EXPECTED_OCI_INVENTORY_DIGEST" ]] || {
    emit "oci_inventory_digest=mismatch"; errors=$((errors + 1)); return 1; }
  emit "oci_inventory_digest=verified"

  local instance_json
  instance_json="$(oci compute instance get \
    --instance-id "$PROV_INSTANCE_OCID" 2>/dev/null)" || {
    emit "oci_instance=api_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e '.data | type == "object"' <<<"$instance_json" >/dev/null 2>&1 || {
    emit "oci_instance=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e \
    --arg id "$PROV_INSTANCE_OCID" \
    --arg compartment "$OCI_COMPARTMENT_OCID" \
    --arg ad "$PROV_AVAILABILITY_DOMAIN" \
    --arg source_sha "$MIGRATION_SHA" \
    --argjson ocpus "$OCI_A1_OCPUS" \
    --argjson memory "$OCI_A1_MEMORY_GB" '
      .data.id == $id and
      .data."compartment-id" == $compartment and
      .data."availability-domain" == $ad and
      .data."display-name" == "betstan-k3s-node" and
      .data.shape == "VM.Standard.A1.Flex" and
      .data."shape-config".ocpus == $ocpus and
      .data."shape-config"."memory-in-gbs" == $memory and
      .data."lifecycle-state" == "RUNNING" and
      .data."freeform-tags"."betstan-managed" == "true" and
      .data."freeform-tags".provider == "oci" and
      .data."freeform-tags"."betstan-runtime" == "k3s" and
      .data."freeform-tags"."expected-monthly-cost" == "0" and
      .data."freeform-tags"."source-sha" == $source_sha
    ' <<<"$instance_json" >/dev/null 2>&1 || {
    emit "oci_instance=provenance_mismatch"; errors=$((errors + 1)); return 1; }

  local boot_volume_json
  boot_volume_json="$(oci bv boot-volume get \
    --boot-volume-id "$PROV_BOOT_VOLUME_OCID" 2>/dev/null)" || {
    emit "oci_boot_volume=api_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e '.data | type == "object"' <<<"$boot_volume_json" >/dev/null 2>&1 || {
    emit "oci_boot_volume=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e \
    --arg id "$PROV_BOOT_VOLUME_OCID" \
    --arg compartment "$OCI_COMPARTMENT_OCID" \
    --arg ad "$PROV_AVAILABILITY_DOMAIN" \
    --arg source_sha "$MIGRATION_SHA" \
    --argjson size "$OCI_BOOT_VOLUME_GB" \
    --argjson vpus "$OCI_BOOT_VOLUME_VPUS_PER_GB" '
      .data.id == $id and
      .data."compartment-id" == $compartment and
      .data."availability-domain" == $ad and
      .data."display-name" == "betstan-k3s-node (Boot Volume)" and
      .data."size-in-gbs" == $size and
      .data."vpus-per-gb" == $vpus and
      .data."lifecycle-state" == "AVAILABLE" and
      .data."freeform-tags"."betstan-managed" == "true" and
      .data."freeform-tags".provider == "oci" and
      .data."freeform-tags"."betstan-runtime" == "k3s" and
      .data."freeform-tags"."expected-monthly-cost" == "0" and
      .data."freeform-tags"."source-sha" == $source_sha
    ' <<<"$boot_volume_json" >/dev/null 2>&1 || {
    emit "oci_boot_volume=provenance_mismatch"; errors=$((errors + 1)); return 1; }

  local mongo_volume_json
  mongo_volume_json="$(oci bv volume get \
    --volume-id "$PROV_MONGO_VOLUME_OCID" 2>/dev/null)" || {
    emit "oci_mongo_volume=api_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e '.data | type == "object"' <<<"$mongo_volume_json" >/dev/null 2>&1 || {
    emit "oci_mongo_volume=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e \
    --arg id "$PROV_MONGO_VOLUME_OCID" \
    --arg compartment "$OCI_COMPARTMENT_OCID" \
    --arg ad "$PROV_AVAILABILITY_DOMAIN" \
    --argjson size "$OCI_MONGO_VOLUME_GB" '
      .data.id == $id and
      .data."compartment-id" == $compartment and
      .data."availability-domain" == $ad and
      .data."display-name" == "betstan-oci-mongo-50g" and
      .data."size-in-gbs" == $size and
      .data."vpus-per-gb" == 0 and
      .data."lifecycle-state" == "AVAILABLE" and
      .data."freeform-tags"."betstan-managed" == "true" and
      .data."freeform-tags".provider == "oci" and
      .data."freeform-tags"."betstan-runtime" == "k3s" and
      .data."freeform-tags"."expected-monthly-cost" == "0"
    ' <<<"$mongo_volume_json" >/dev/null 2>&1 || {
    emit "oci_mongo_volume=provenance_mismatch"; errors=$((errors + 1)); return 1; }

  local attachment_json
  attachment_json="$(oci compute volume-attachment get \
    --volume-attachment-id "$PROV_ATTACHMENT_OCID" 2>/dev/null)" || {
    emit "oci_mongo_attachment=api_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e '.data | type == "object"' <<<"$attachment_json" >/dev/null 2>&1 || {
    emit "oci_mongo_attachment=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e \
    --arg id "$PROV_ATTACHMENT_OCID" \
    --arg instance "$PROV_INSTANCE_OCID" \
    --arg volume "$PROV_MONGO_VOLUME_OCID" '
      .data.id == $id and
      .data."instance-id" == $instance and
      .data."volume-id" == $volume and
      .data."lifecycle-state" == "ATTACHED"
    ' <<<"$attachment_json" >/dev/null 2>&1 || {
    emit "oci_mongo_attachment=provenance_mismatch"; errors=$((errors + 1)); return 1; }

  local load_balancer_json
  load_balancer_json="$(oci lb load-balancer get \
    --load-balancer-id "$PROV_LB_OCID" 2>/dev/null)" || {
    emit "oci_load_balancer=api_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e '.data | type == "object"' <<<"$load_balancer_json" >/dev/null 2>&1 || {
    emit "oci_load_balancer=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e \
    --arg id "$PROV_LB_OCID" \
    --arg compartment "$OCI_COMPARTMENT_OCID" \
    --arg subnet "$PROV_LB_SUBNET_OCID" \
    --arg ingress "$diag_ip" \
    --argjson minimum "$OCI_LB_MIN_MBPS" \
    --argjson maximum "$OCI_LB_MAX_MBPS" '
      .data.id == $id and
      .data."compartment-id" == $compartment and
      .data."display-name" == "betstan-oci-ingress" and
      .data."lifecycle-state" == "ACTIVE" and
      .data."shape-name" == "flexible" and
      .data."shape-details"."minimum-bandwidth-in-mbps" == $minimum and
      .data."shape-details"."maximum-bandwidth-in-mbps" == $maximum and
      (.data."subnet-ids" | sort) == ([$subnet] | sort) and
      ([.data."ip-addresses"[] |
        select(."is-public" == true and ."ip-address" == $ingress)] | length) == 1 and
      .data."freeform-tags"."betstan-managed" == "true" and
      .data."freeform-tags".provider == "oci" and
      .data."freeform-tags"."betstan-runtime" == "k3s" and
      .data."freeform-tags"."expected-monthly-cost" == "0"
    ' <<<"$load_balancer_json" >/dev/null 2>&1 || {
    emit "oci_load_balancer=provenance_mismatch"; errors=$((errors + 1)); return 1; }

  # Bastion validation via exact provenance OCID.
  local bastion_json
  bastion_json="$(oci bastion bastion get \
    --bastion-id "${PROV_BASTION_OCID}" 2>/dev/null)" || {
    emit "oci_bastion=api_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e '.data | type == "object"' <<<"$bastion_json" >/dev/null 2>&1 || {
    emit "oci_bastion=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  jq -e \
    --arg id "$PROV_BASTION_OCID" \
    --arg compartment "$OCI_COMPARTMENT_OCID" \
    --arg subnet "$PROV_WORKER_SUBNET_OCID" \
    --arg cidr "$BASTION_CIDR" \
    --argjson ttl "$BASTION_MAX_SESSION_TTL_SECONDS" '
      .data.id == $id and
      .data."compartment-id" == $compartment and
      .data.name == "betstan-oci-bastion" and
      .data."lifecycle-state" == "ACTIVE" and
      .data."target-subnet-id" == $subnet and
      .data."max-session-ttl-in-seconds" == $ttl and
      (.data."client-cidr-block-allow-list" | sort) == ([$cidr] | sort) and
      .data."freeform-tags"."betstan-managed" == "true" and
      .data."freeform-tags".provider == "oci" and
      .data."freeform-tags"."expected-monthly-cost" == "0"
    ' <<<"$bastion_json" >/dev/null 2>&1 || {
    emit "oci_bastion=provenance_mismatch"; errors=$((errors + 1)); return 1; }

  # Zero active/creating sessions — fetch all, materialize, then count
  local sessions_json sessions_array sessions_total
  sessions_json="$(oci bastion session list \
    --bastion-id "${PROV_BASTION_OCID}" --all 2>/dev/null)" || {
    emit "oci_bastion_sessions=api_error"; unknowns=$((unknowns + 1)); return 1; }
  # Materialize complete .data array and validate type
  sessions_array="$(printf '%s' "$sessions_json" | jq -c '
    if .data | type == "array" then .data else error("not_array") end
  ' 2>/dev/null)" || {
    emit "oci_bastion_sessions=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  sessions_total="$(printf '%s' "$sessions_array" | jq 'length' 2>/dev/null)" || {
    emit "oci_bastion_sessions=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$sessions_total" =~ ^[0-9]+$ ]] || {
    emit "oci_bastion_sessions=parse_error"; unknowns=$((unknowns + 1)); return 1; }

  local active_count creating_count
  active_count="$(printf '%s' "$sessions_array" | jq '
    [.[] | select(."lifecycle-state" == "ACTIVE")] | length' 2>/dev/null)" || {
    emit "oci_bastion_sessions=count_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$active_count" =~ ^[0-9]+$ ]] || {
    emit "oci_bastion_sessions=count_error"; unknowns=$((unknowns + 1)); return 1; }
  creating_count="$(printf '%s' "$sessions_array" | jq '
    [.[] | select(."lifecycle-state" == "CREATING")] | length' 2>/dev/null)" || {
    emit "oci_bastion_sessions=count_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$creating_count" =~ ^[0-9]+$ ]] || {
    emit "oci_bastion_sessions=count_error"; unknowns=$((unknowns + 1)); return 1; }

  if [[ "$active_count" -gt 0 ]]; then
    emit "oci_bastion_active_sessions=${active_count}"; errors=$((errors + 1)); return 1; fi
  if [[ "$creating_count" -gt 0 ]]; then
    emit "oci_bastion_creating_sessions=${creating_count}"; errors=$((errors + 1)); return 1; fi
  emit "oci_bastion_total_sessions=${sessions_total}"

  emit "oci_live_resources=verified"
  return 0
}

##############################################################################
# 3. Azure absence
##############################################################################
check_azure_absence() {
  local account_json="$AUDIT_WORK_DIR/account.json"
  az account show -o json > "$account_json" 2>/dev/null || {
    emit "azure_account=api_error"; unknowns=$((unknowns + 1)); return 1; }
  local sub_state sub_id live_tenant
  sub_state="$(jq -r '.state // empty' "$account_json" 2>/dev/null)" || {
    emit "azure_account=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$sub_state" ]] || {
    emit "azure_account=empty_state"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$sub_state" == "Enabled" ]] || {
    emit "azure_account_state=not_enabled"; unknowns=$((unknowns + 1)); return 1; }
  sub_id="$(jq -r '.id // empty' "$account_json" 2>/dev/null)" || {
    emit "azure_account=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$sub_id" && "$sub_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || {
    emit "azure_account=invalid_subscription_id"; unknowns=$((unknowns + 1)); return 1; }
  live_tenant="$(jq -r '.tenantId // empty' "$account_json" 2>/dev/null)" || {
    emit "azure_account=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$live_tenant" && "$live_tenant" =~ ^[0-9a-fA-F]{8}- ]] || {
    emit "azure_account=invalid_tenant"; unknowns=$((unknowns + 1)); return 1; }

  # Fingerprint: hash raw subscription ID (NOT lowercased)
  local sub_sha
  sub_sha="$(printf '%s' "$sub_id" | sha256_text)"
  [[ "$sub_sha" == "$AZURE_SUBSCRIPTION_FINGERPRINT" ]] || {
    emit "azure_subscription_binding=mismatch"; unknowns=$((unknowns + 1)); return 1; }
  AZURE_SUBSCRIPTION_ID="$sub_id"
  AZURE_SUBSCRIPTION_BOUND=true
  emit "azure_subscription_binding=verified"

  # Resource groups
  local primary_exists managed_exists
  primary_exists="$(az group exists --name "$AZURE_RESOURCE_GROUP" \
    --subscription "$sub_id" 2>/dev/null)" || {
    emit "azure_primary_group=api_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$primary_exists" == "true" || "$primary_exists" == "false" ]] || {
    emit "azure_primary_group=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$primary_exists" == "true" ]]; then
    emit "azure_primary_group=present"; errors=$((errors + 1))
  else
    emit "azure_primary_group=absent"
  fi
  managed_exists="$(az group exists --name "$AZURE_MANAGED_GROUP" \
    --subscription "$sub_id" 2>/dev/null)" || {
    emit "azure_managed_group=api_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$managed_exists" == "true" || "$managed_exists" == "false" ]] || {
    emit "azure_managed_group=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$managed_exists" == "true" ]]; then
    emit "azure_managed_group=present"; errors=$((errors + 1))
  else
    emit "azure_managed_group=absent"
  fi

  # BetStan resource check: exact retired groups and known AKS orphan patterns
  # Never require whole subscription empty (unrelated resources exist)
  local resources_json resources_array
  resources_json="$(az resource list --subscription "$sub_id" -o json 2>/dev/null)" || {
    emit "azure_resources=api_error"; unknowns=$((unknowns + 1)); return 1; }
  # Validate response is a JSON array
  resources_array="$(printf '%s' "$resources_json" | jq -c '
    if type == "array" then . else error("not_array") end
  ' 2>/dev/null)" || {
    emit "azure_resources=parse_error"; unknowns=$((unknowns + 1)); return 1; }

  # Check for resources in exact retired groups (case-insensitive)
  local betstan_count
  betstan_count="$(printf '%s' "$resources_array" | jq '
    [.[] | select(
      (.resourceGroup | ascii_downcase) == "betstan-rg" or
      (.resourceGroup | ascii_downcase) == "mc_betstan-rg_betstan-aks_eastus"
    )] | length' 2>/dev/null)" || {
    emit "azure_resources=count_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$betstan_count" =~ ^[0-9]+$ ]] || {
    emit "azure_resources=count_error"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$betstan_count" -gt 0 ]]; then
    emit "azure_betstan_resources=${betstan_count}"; errors=$((errors + 1))
  fi

  # Check for known AKS orphan patterns in any group
  local orphan_count
  orphan_count="$(printf '%s' "$resources_array" | jq '
    [.[] | select(
      (.type | ascii_downcase) as $t |
      (.name | ascii_downcase) as $n |
      (.resourceGroup | ascii_downcase) as $rg |
      (($n | contains("betstan")) or
       ($rg | contains("betstan")) or
       ($t == "microsoft.containerservice/managedclusters" and $n == "betstan-aks") or
       ($t == "microsoft.compute/virtualmachinescalesets" and ($n | contains("betstan"))) or
       ($t == "microsoft.compute/disks" and ($n | contains("betstan"))) or
       ($t == "microsoft.compute/snapshots" and ($n | contains("betstan"))) or
       ($t == "microsoft.network/publicipaddresses" and ($n | contains("betstan"))) or
       ($t == "microsoft.network/loadbalancers" and ($n | contains("betstan"))) or
       ($t == "microsoft.insights/components" and ($n | contains("betstan"))) or
       ($t == "microsoft.operationalinsights/workspaces" and ($n | contains("betstan"))))
    )] | length' 2>/dev/null)" || {
    emit "azure_orphan_resources=count_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$orphan_count" =~ ^[0-9]+$ ]] || {
    emit "azure_orphan_resources=count_error"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$orphan_count" -gt 0 ]]; then
    emit "azure_orphan_resources=${orphan_count}"; errors=$((errors + 1))
  fi

  return 0
}

##############################################################################
# 4. Identity retirement verification
##############################################################################
check_identity() {
  # Validate state file
  validate_private_file "$IDENTITY_STATE_FILE" "identity_state" || return 1

  # Fail-closed: identity state file must match reviewed digest
  local id_state_digest
  id_state_digest="$(sha256_file "$IDENTITY_STATE_FILE")" || {
    emit "identity_state=error reason=hash_failed"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$id_state_digest" == "$REVIEWED_IDENTITY_STATE_DIGEST" ]] || {
    emit "identity_state=error reason=state_digest_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  # Parse and validate exact field set
  local expected_fields="custom_role_id_1
custom_role_id_2
metadata_sha256
migration_app_id
migration_environment
migration_secret_name
migration_sp_object_id
phase
recovery_app_id
recovery_environment
recovery_secret_name
recovery_sp_object_id
repository
retained_secret_name
retained_sp_display_name
retained_sp_object_id
role_assignment_id_1
role_assignment_id_2
role_assignment_id_3
schema
subscription_id
tenant_id
workflow_name"
  local actual_fields
  actual_fields="$(sed '/^[[:space:]]*$/d; s/=.*//' "$IDENTITY_STATE_FILE" | sort)"
  [[ "$actual_fields" == "$expected_fields" ]] || {
    emit "identity_state=error reason=field_set_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  # Validate uniqueness of keys (no duplicates)
  local unique_count total_count
  total_count="$(sed '/^[[:space:]]*$/d' "$IDENTITY_STATE_FILE" | wc -l | tr -d ' ')"
  unique_count="$(sed '/^[[:space:]]*$/d; s/=.*//' "$IDENTITY_STATE_FILE" | sort -u | wc -l | tr -d ' ')"
  [[ "$total_count" == "$unique_count" ]] || {
    emit "identity_state=error reason=duplicate_keys"; unknowns=$((unknowns + 1)); return 1; }

  # Validate schema and phase
  local schema phase
  schema="$(state_field "$IDENTITY_STATE_FILE" "schema")" || {
    emit "identity_state=error reason=schema_missing"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$schema" == "$IDENTITY_STATE_SCHEMA" ]] || {
    emit "identity_state=error reason=schema_mismatch"; unknowns=$((unknowns + 1)); return 1; }
  phase="$(state_field "$IDENTITY_STATE_FILE" "phase")" || {
    emit "identity_state=error reason=phase_missing"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$phase" == "retired" ]] || {
    emit "identity_state=error reason=phase_not_retired"; unknowns=$((unknowns + 1)); return 1; }

  # UUID validation regex
  local uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

  # Tenant/subscription binding (unconditional cross-validation)
  local state_tenant state_sub
  state_tenant="$(state_field "$IDENTITY_STATE_FILE" "tenant_id")" || return 1
  state_sub="$(state_field "$IDENTITY_STATE_FILE" "subscription_id")" || return 1
  [[ "$state_tenant" =~ $uuid_re ]] || {
    emit "identity_state=error reason=invalid_tenant_uuid"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$state_sub" =~ $uuid_re ]] || {
    emit "identity_state=error reason=invalid_subscription_uuid"; unknowns=$((unknowns + 1)); return 1; }

  # Cross-validate against live Azure account (unconditional)
  local live_tenant live_sub
  [[ -f "$AUDIT_WORK_DIR/account.json" ]] || {
    emit "identity_state=error reason=no_azure_account"; unknowns=$((unknowns + 1)); return 1; }
  live_tenant="$(jq -r '.tenantId // empty' "$AUDIT_WORK_DIR/account.json" 2>/dev/null)" || live_tenant=""
  live_sub="$(jq -r '.id // empty' "$AUDIT_WORK_DIR/account.json" 2>/dev/null)" || live_sub=""
  [[ -n "$live_tenant" ]] || {
    emit "identity_state=error reason=live_tenant_empty"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$state_tenant" == "$live_tenant" ]] || {
    emit "identity_state=error reason=tenant_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$live_sub" ]] || {
    emit "identity_state=error reason=live_sub_empty"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$state_sub" == "$live_sub" ]] || {
    emit "identity_state=error reason=subscription_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  # Repository binding
  local state_repo
  state_repo="$(state_field "$IDENTITY_STATE_FILE" "repository")" || return 1
  [[ "$state_repo" == "$GH_REPOSITORY" ]] || {
    emit "identity_state=error reason=repository_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  # Fixed-value bindings
  local fv
  fv="$(state_field "$IDENTITY_STATE_FILE" "retained_sp_display_name")" || return 1
  [[ "$fv" == "$RETAINED_SP_DISPLAY_NAME" ]] || {
    emit "identity_state=error reason=fixed_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }
  fv="$(state_field "$IDENTITY_STATE_FILE" "retained_secret_name")" || return 1
  [[ "$fv" == "AZURE_CREDENTIALS" ]] || {
    emit "identity_state=error reason=fixed_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }
  fv="$(state_field "$IDENTITY_STATE_FILE" "migration_environment")" || return 1
  [[ "$fv" == "oci-migration" ]] || {
    emit "identity_state=error reason=fixed_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }
  fv="$(state_field "$IDENTITY_STATE_FILE" "recovery_environment")" || return 1
  [[ "$fv" == "azure-migration-recovery" ]] || {
    emit "identity_state=error reason=fixed_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }
  fv="$(state_field "$IDENTITY_STATE_FILE" "migration_secret_name")" || return 1
  [[ "$fv" == "OCI_MIGRATION_AZURE_CREDENTIALS" ]] || {
    emit "identity_state=error reason=fixed_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }
  fv="$(state_field "$IDENTITY_STATE_FILE" "recovery_secret_name")" || return 1
  [[ "$fv" == "AZURE_MIGRATION_RECOVERY_CREDENTIALS" ]] || {
    emit "identity_state=error reason=fixed_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }
  fv="$(state_field "$IDENTITY_STATE_FILE" "workflow_name")" || return 1
  [[ "$fv" == "$WORKFLOW_RECOVERY" ]] || {
    emit "identity_state=error reason=fixed_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  # Extract temporary IDs and validate syntax
  local mig_app rec_app mig_sp rec_sp ra1 ra2 ra3 cr1 cr2 retained_sp
  mig_app="$(state_field "$IDENTITY_STATE_FILE" "migration_app_id")" || return 1
  rec_app="$(state_field "$IDENTITY_STATE_FILE" "recovery_app_id")" || return 1
  mig_sp="$(state_field "$IDENTITY_STATE_FILE" "migration_sp_object_id")" || return 1
  rec_sp="$(state_field "$IDENTITY_STATE_FILE" "recovery_sp_object_id")" || return 1
  ra1="$(state_field "$IDENTITY_STATE_FILE" "role_assignment_id_1")" || return 1
  ra2="$(state_field "$IDENTITY_STATE_FILE" "role_assignment_id_2")" || return 1
  ra3="$(state_field "$IDENTITY_STATE_FILE" "role_assignment_id_3")" || return 1
  cr1="$(state_field "$IDENTITY_STATE_FILE" "custom_role_id_1")" || return 1
  cr2="$(state_field "$IDENTITY_STATE_FILE" "custom_role_id_2")" || return 1
  retained_sp="$(state_field "$IDENTITY_STATE_FILE" "retained_sp_object_id")" || return 1

  # Validate UUID syntax for apps/SPs/custom roles
  for id_val in "$mig_app" "$rec_app" "$mig_sp" "$rec_sp" "$retained_sp" "$cr1" "$cr2"; do
    [[ "$id_val" =~ $uuid_re ]] || {
      emit "identity_state=error reason=invalid_id_syntax"; unknowns=$((unknowns + 1)); return 1; }
  done
  # Empty check
  for id_val in "$mig_app" "$rec_app" "$mig_sp" "$rec_sp" "$cr1" "$cr2" "$retained_sp"; do
    [[ -n "$id_val" ]] || {
      emit "identity_state=error reason=empty_id"; unknowns=$((unknowns + 1)); return 1; }
  done
  # RA syntax: subscription-root, RG-scoped, or exact AKS resource-scoped
  # All must bind the state subscription. Reject arbitrary nested provider paths.
  local ra_guid_re="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
  local ra_sub_root="^/subscriptions/${state_sub}/providers/microsoft\.authorization/roleassignments/${ra_guid_re}\$"
  local ra_rg_scope="^/subscriptions/${state_sub}/resourcegroups/(betstan-rg|mc_betstan-rg_betstan-aks_eastus)/providers/microsoft\.authorization/roleassignments/${ra_guid_re}\$"
  local ra_aks_scope="^/subscriptions/${state_sub}/resourcegroups/betstan-rg/providers/microsoft\.containerservice/managedclusters/betstan-aks/providers/microsoft\.authorization/roleassignments/${ra_guid_re}\$"
  for ra_val in "$ra1" "$ra2" "$ra3"; do
    local ra_normalized
    ra_normalized="$(printf '%s' "$ra_val" | tr '[:upper:]' '[:lower:]')"
    if [[ "$ra_normalized" =~ $ra_sub_root ]] || \
       [[ "$ra_normalized" =~ $ra_rg_scope ]] || \
       [[ "$ra_normalized" =~ $ra_aks_scope ]]; then
      : # valid
    else
      emit "identity_state=error reason=invalid_ra_syntax"; unknowns=$((unknowns + 1)); return 1
    fi
  done

  # Uniqueness: all 9 temporary IDs must be distinct
  local -a temp_ids=("$mig_app" "$rec_app" "$mig_sp" "$rec_sp" "$ra1" "$ra2" "$ra3" "$cr1" "$cr2")
  local unique_temp
  unique_temp="$(printf '%s\n' "${temp_ids[@]}" | sort -u | wc -l | tr -d ' ')"
  [[ "$unique_temp" == "9" ]] || {
    emit "identity_state=error reason=duplicate_temporary_ids"; unknowns=$((unknowns + 1)); return 1; }
  # Retained must not overlap temporary
  for tid in "${temp_ids[@]}"; do
    [[ "$retained_sp" != "$tid" ]] || {
      emit "identity_state=error reason=retained_overlaps_temporary"; unknowns=$((unknowns + 1)); return 1; }
  done

  # Verify absence of temporary IDs via Azure
  local checked=0 present=0
  for app_id in "$mig_app" "$rec_app"; do
    local app_count
    app_count="$(az ad app list --filter "appId eq '${app_id}'" --query 'length(@)' -o tsv 2>/dev/null)" || {
      emit "identity_app_check=api_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$app_count" =~ ^[0-9]+$ ]] || {
      emit "identity_app_check=parse_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$app_count" == "0" ]] || {
      emit "identity_temp_app=present"; errors=$((errors + 1)); present=$((present + app_count)); }
    checked=$((checked + 1))
  done
  for sp_id in "$mig_sp" "$rec_sp"; do
    local sp_count
    sp_count="$(az ad sp list --all --query "[?id=='${sp_id}'] | length(@)" -o tsv 2>/dev/null)" || {
      emit "identity_sp_check=api_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$sp_count" =~ ^[0-9]+$ ]] || {
      emit "identity_sp_check=parse_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$sp_count" == "0" ]] || {
      emit "identity_temp_sp=present"; errors=$((errors + 1)); present=$((present + sp_count)); }
    checked=$((checked + 1))
  done
  for ra_id in "$ra1" "$ra2" "$ra3"; do
    local ra_count
    ra_count="$(az role assignment list --all --query "[?id=='${ra_id}'] | length(@)" -o tsv 2>/dev/null)" || {
      emit "identity_ra_check=api_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$ra_count" =~ ^[0-9]+$ ]] || {
      emit "identity_ra_check=parse_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$ra_count" == "0" ]] || {
      emit "identity_temp_ra=present"; errors=$((errors + 1)); present=$((present + ra_count)); }
    checked=$((checked + 1))
  done
  for cr_id in "$cr1" "$cr2"; do
    local cr_count
    cr_count="$(az role definition list --custom-role-only true --query "[?name=='${cr_id}'] | length(@)" -o tsv 2>/dev/null)" || {
      emit "identity_cr_check=api_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$cr_count" =~ ^[0-9]+$ ]] || {
      emit "identity_cr_check=parse_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$cr_count" == "0" ]] || {
      emit "identity_temp_cr=present"; errors=$((errors + 1)); present=$((present + cr_count)); }
    checked=$((checked + 1))
  done

  [[ "$checked" == "9" ]] || {
    emit "identity_checked=${checked}"; unknowns=$((unknowns + 1)); return 1; }
  emit "identity_temporary_checked=9"
  emit "identity_temporary_present=${present}"

  # Verify retained SP is exactly present
  local retained_count retained_name
  retained_count="$(az ad sp list --all --query "[?id=='${retained_sp}'] | length(@)" -o tsv 2>/dev/null)" || {
    emit "retained_sp=api_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$retained_count" =~ ^[0-9]+$ ]] || {
    emit "retained_sp=count_parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$retained_count" == "1" ]] || {
    emit "retained_sp=count_${retained_count}"; errors=$((errors + 1)); return 1; }
  retained_name="$(az ad sp list --all --query "[?id=='${retained_sp}'].displayName | [0]" -o tsv 2>/dev/null)" || {
    emit "retained_sp=name_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$retained_name" == "$RETAINED_SP_DISPLAY_NAME" ]] || {
    emit "retained_sp=name_mismatch"; errors=$((errors + 1)); return 1; }

  # Verify retained SP has exactly zero role assignments (inert zero-cost credential)
  local retained_ra_json retained_ra_count
  retained_ra_json="$(az role assignment list --all \
    --assignee-object-id "$retained_sp" -o json 2>/dev/null)" || {
    emit "retained_sp_assignments=api_error"; unknowns=$((unknowns + 1)); return 1; }
  retained_ra_count="$(printf '%s' "$retained_ra_json" | jq 'if type == "array" then length else empty end' 2>/dev/null)" || {
    emit "retained_sp_assignments=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$retained_ra_count" =~ ^[0-9]+$ ]] || {
    emit "retained_sp_assignments=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$retained_ra_count" == "0" ]] || {
    emit "retained_sp_assignments=nonzero count=${retained_ra_count}"; errors=$((errors + 1)); return 1; }
  emit "retained_sp_assignments=zero"

  emit "retained_sp=present"

  # Verify complete secret listings before classifying exact names.
  if ! github_secret_count \
    "repos/${GH_REPOSITORY}/environments/oci-migration/secrets" \
    "OCI_MIGRATION_AZURE_CREDENTIALS"; then
    emit "temp_secret_oci_migration=${GH_SECRET_ERROR}"
    unknowns=$((unknowns + 1))
    return 1
  fi
  if [[ "$GH_SECRET_COUNT" -gt 0 ]]; then
    emit "temp_secret_oci_migration=present"; errors=$((errors + 1))
  else
    emit "temp_secret_oci_migration=absent"
  fi

  if ! github_secret_count \
    "repos/${GH_REPOSITORY}/environments/azure-migration-recovery/secrets" \
    "AZURE_MIGRATION_RECOVERY_CREDENTIALS"; then
    emit "temp_secret_azure_recovery=${GH_SECRET_ERROR}"
    unknowns=$((unknowns + 1))
    return 1
  fi
  if [[ "$GH_SECRET_COUNT" -gt 0 ]]; then
    emit "temp_secret_azure_recovery=present"; errors=$((errors + 1))
  else
    emit "temp_secret_azure_recovery=absent"
  fi

  # Verify retained repo secret PRESENT
  if ! github_secret_count \
    "repos/${GH_REPOSITORY}/actions/secrets" \
    "AZURE_CREDENTIALS"; then
    emit "retained_repo_credential=${GH_SECRET_ERROR}"
    unknowns=$((unknowns + 1))
    return 1
  fi
  if [[ "$GH_SECRET_COUNT" == "1" ]]; then
    emit "retained_repo_credential=present"
  else
    emit "retained_repo_credential=missing"; errors=$((errors + 1))
  fi

  return 0
}

##############################################################################
# 4b. Legacy identity attestation (optional handoff evidence)
# Standard future operator-produced terminal state runs without this file.
# Legacy attestation provides cryptographic binding of the reconstruction
# process that produced the terminal state from historical session events.
##############################################################################
check_identity_attestation() {
  # Legacy attestation is required for this historical production handoff
  validate_private_file "$IDENTITY_ATTESTATION_FILE" "identity_attestation" || return 1

  # Fail-closed: attestation file must match reviewed digest
  local att_digest
  att_digest="$(sha256_file "$IDENTITY_ATTESTATION_FILE")" || {
    emit "identity_attestation=error reason=hash_failed"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$att_digest" == "$REVIEWED_IDENTITY_ATTESTATION_DIGEST" ]] || {
    emit "identity_attestation=error reason=attestation_digest_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  # Exact ordered field set (16 fields)
  local expected_fields="activity_evidence_sha256
creation_event_sha256
deletion_completed_at
deletion_event_sha256
deletion_result_sha256
phase
reconstructed_metadata_sha256
relationship_event_sha256
retained_identity_intact
reverification_completed_at
reverification_event_sha256
reverification_result_sha256
schema
temporary_objects_absent
temporary_objects_checked
terminal_state_sha256"
  local actual_fields
  actual_fields="$(sed '/^[[:space:]]*$/d; s/=.*//' "$IDENTITY_ATTESTATION_FILE" | sort)"
  [[ "$actual_fields" == "$expected_fields" ]] || {
    emit "identity_attestation=error reason=field_set_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  # Uniqueness
  local att_total att_unique
  att_total="$(sed '/^[[:space:]]*$/d' "$IDENTITY_ATTESTATION_FILE" | wc -l | tr -d ' ')"
  att_unique="$(sed '/^[[:space:]]*$/d; s/=.*//' "$IDENTITY_ATTESTATION_FILE" | sort -u | wc -l | tr -d ' ')"
  [[ "$att_total" == "$att_unique" ]] || {
    emit "identity_attestation=error reason=duplicate_keys"; unknowns=$((unknowns + 1)); return 1; }

  # Schema validation
  local att_schema
  att_schema="$(state_field "$IDENTITY_ATTESTATION_FILE" "schema")" || {
    emit "identity_attestation=error reason=schema_missing"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$att_schema" == "$IDENTITY_ATTESTATION_SCHEMA" ]] || {
    emit "identity_attestation=error reason=schema_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  # Phase must be retired
  local att_phase
  att_phase="$(state_field "$IDENTITY_ATTESTATION_FILE" "phase")" || {
    emit "identity_attestation=error reason=phase_missing"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$att_phase" == "retired" ]] || {
    emit "identity_attestation=error reason=phase_not_retired"; unknowns=$((unknowns + 1)); return 1; }

  # SHA256 fields must be valid hex-64
  local sha_re='^[0-9a-f]{64}$'
  local sha_field
  for sha_field in terminal_state_sha256 reconstructed_metadata_sha256 \
      creation_event_sha256 relationship_event_sha256 deletion_event_sha256 \
      deletion_result_sha256 reverification_event_sha256 reverification_result_sha256 \
      activity_evidence_sha256; do
    local sha_val
    sha_val="$(state_field "$IDENTITY_ATTESTATION_FILE" "$sha_field")" || {
      emit "identity_attestation=error reason=${sha_field}_missing"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$sha_val" =~ $sha_re ]] || {
      emit "identity_attestation=error reason=${sha_field}_invalid"; unknowns=$((unknowns + 1)); return 1; }
  done

  # Timestamp fields: ISO 8601 format (e.g., 2024-01-15T12:00:00Z)
  local ts_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  local ts_field
  for ts_field in deletion_completed_at reverification_completed_at; do
    local ts_val
    ts_val="$(state_field "$IDENTITY_ATTESTATION_FILE" "$ts_field")" || {
      emit "identity_attestation=error reason=${ts_field}_missing"; unknowns=$((unknowns + 1)); return 1; }
    [[ "$ts_val" =~ $ts_re ]] || {
      emit "identity_attestation=error reason=${ts_field}_invalid"; unknowns=$((unknowns + 1)); return 1; }
  done

  # Timestamp ordering: deletion must precede reverification
  local del_ts rev_ts
  del_ts="$(state_field "$IDENTITY_ATTESTATION_FILE" "deletion_completed_at")" || return 1
  rev_ts="$(state_field "$IDENTITY_ATTESTATION_FILE" "reverification_completed_at")" || return 1
  [[ "$del_ts" < "$rev_ts" ]] || {
    emit "identity_attestation=error reason=timestamp_order_invalid"; unknowns=$((unknowns + 1)); return 1; }

  # temporary_objects_checked must equal 9
  local att_checked
  att_checked="$(state_field "$IDENTITY_ATTESTATION_FILE" "temporary_objects_checked")" || {
    emit "identity_attestation=error reason=checked_missing"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$att_checked" == "9" ]] || {
    emit "identity_attestation=error reason=checked_not_9"; unknowns=$((unknowns + 1)); return 1; }

  # temporary_objects_absent must be true
  local att_absent
  att_absent="$(state_field "$IDENTITY_ATTESTATION_FILE" "temporary_objects_absent")" || {
    emit "identity_attestation=error reason=absent_missing"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$att_absent" == "true" ]] || {
    emit "identity_attestation=error reason=absent_not_true"; unknowns=$((unknowns + 1)); return 1; }

  # retained_identity_intact must be true
  local att_retained
  att_retained="$(state_field "$IDENTITY_ATTESTATION_FILE" "retained_identity_intact")" || {
    emit "identity_attestation=error reason=retained_missing"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$att_retained" == "true" ]] || {
    emit "identity_attestation=error reason=retained_not_true"; unknowns=$((unknowns + 1)); return 1; }

  # Binding: terminal_state_sha256 must equal hash of identity state file
  local state_hash
  state_hash="$(sha256_file "$IDENTITY_STATE_FILE")" || {
    emit "identity_attestation=error reason=state_hash_failed"; unknowns=$((unknowns + 1)); return 1; }
  local att_state_hash
  att_state_hash="$(state_field "$IDENTITY_ATTESTATION_FILE" "terminal_state_sha256")" || return 1
  [[ "$att_state_hash" == "$state_hash" ]] || {
    emit "identity_attestation=error reason=state_hash_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  # Binding: reconstructed_metadata_sha256 must equal state metadata_sha256
  local state_metadata_sha
  state_metadata_sha="$(state_field "$IDENTITY_STATE_FILE" "metadata_sha256")" || {
    emit "identity_attestation=error reason=metadata_sha_unavailable"; unknowns=$((unknowns + 1)); return 1; }
  local att_metadata_sha
  att_metadata_sha="$(state_field "$IDENTITY_ATTESTATION_FILE" "reconstructed_metadata_sha256")" || return 1
  [[ "$att_metadata_sha" == "$state_metadata_sha" ]] || {
    emit "identity_attestation=error reason=metadata_hash_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  emit "identity_attestation=valid"
  return 0
}

##############################################################################
# 5. Recovery variables
##############################################################################
check_recovery_variables() {
  # Repository-level
  local repo_enabled repo_epoch
  repo_enabled="$(gh api "repos/${GH_REPOSITORY}/actions/variables/OCI_MIGRATION_RECOVERY_ENABLED" --jq '.value' 2>/dev/null)" || {
    emit "recovery_repo_enabled=api_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$repo_enabled" ]] || {
    emit "recovery_repo_enabled=empty"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$repo_enabled" != "false" ]]; then
    emit "recovery_repo_enabled=unexpected"; errors=$((errors + 1))
  else
    emit "recovery_repo_enabled=false"
  fi

  repo_epoch="$(gh api "repos/${GH_REPOSITORY}/actions/variables/OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH" --jq '.value' 2>/dev/null)" || {
    emit "recovery_repo_epoch=api_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$repo_epoch" ]] || {
    emit "recovery_repo_epoch=empty"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$repo_epoch" != "0" ]]; then
    emit "recovery_repo_epoch=unexpected"; errors=$((errors + 1))
  else
    emit "recovery_repo_epoch=0"
  fi

  # Environment-level (overrides repository)
  local env_enabled env_epoch
  env_enabled="$(gh api "repos/${GH_REPOSITORY}/environments/azure-migration-recovery/variables/OCI_MIGRATION_RECOVERY_ENABLED" --jq '.value' 2>/dev/null)" || {
    emit "recovery_env_enabled=api_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$env_enabled" ]] || {
    emit "recovery_env_enabled=empty"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$env_enabled" != "false" ]]; then
    emit "recovery_env_enabled=unexpected"; errors=$((errors + 1))
  else
    emit "recovery_env_enabled=false"
  fi

  env_epoch="$(gh api "repos/${GH_REPOSITORY}/environments/azure-migration-recovery/variables/OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH" --jq '.value' 2>/dev/null)" || {
    emit "recovery_env_epoch=api_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ -n "$env_epoch" ]] || {
    emit "recovery_env_epoch=empty"; unknowns=$((unknowns + 1)); return 1; }
  if [[ "$env_epoch" != "0" ]]; then
    emit "recovery_env_epoch=unexpected"; errors=$((errors + 1))
  else
    emit "recovery_env_epoch=0"
  fi

  return 0
}

##############################################################################
# 6. Workflows
##############################################################################
_expected_workflow_state() {
  case "$1" in
    "$WORKFLOW_MIGRATE") echo "active" ;;
    "$WORKFLOW_RECOVERY") echo "disabled_manually" ;;
    "$WORKFLOW_CAPACITY") echo "disabled_manually" ;;
    "$WORKFLOW_INFRASTRUCTURE") echo "active" ;;
    "$WORKFLOW_OCI_BUILD") echo "active" ;;
    "$WORKFLOW_DEPLOY") echo "active" ;;
    "$WORKFLOW_AZURE_BUILD") echo "active" ;;
    "$WORKFLOW_AZURE_DEPLOY") echo "active" ;;
    *) echo "unknown" ;;
  esac
}

check_workflows() {
  local -a workflows=(
    "$WORKFLOW_CAPACITY"
    "$WORKFLOW_INFRASTRUCTURE"
    "$WORKFLOW_MIGRATE"
    "$WORKFLOW_RECOVERY"
    "$WORKFLOW_OCI_BUILD"
    "$WORKFLOW_DEPLOY"
    "$WORKFLOW_AZURE_BUILD"
    "$WORKFLOW_AZURE_DEPLOY"
  )
  local wf wf_base errors_at_entry=$errors

  # Fetch master SHA once
  local master_json master_sha
  master_json="$(gh api "repos/${GH_REPOSITORY}/git/ref/heads/master" 2>/dev/null)" || {
    emit "workflow_master=api_error"; unknowns=$((unknowns + 1)); return 1; }
  master_sha="$(printf '%s' "$master_json" | jq -r '.object.sha // empty' 2>/dev/null)" || {
    emit "workflow_master=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$master_sha" =~ ^[0-9a-f]{40}$ ]] || {
    emit "workflow_master=invalid_sha"; unknowns=$((unknowns + 1)); return 1; }

  for wf in "${workflows[@]}"; do
    wf_base="${wf%.yml}"
    local wf_json wf_state wf_expected
    wf_json="$(gh api "repos/${GH_REPOSITORY}/actions/workflows/${wf}" 2>/dev/null)" || {
      emit "workflow_${wf_base}=api_error"; unknowns=$((unknowns + 1)); return 1; }
    wf_state="$(printf '%s' "$wf_json" | jq -r '.state // empty' 2>/dev/null)" || {
      emit "workflow_${wf_base}=parse_error"; unknowns=$((unknowns + 1)); return 1; }
    [[ -n "$wf_state" ]] || {
      emit "workflow_${wf_base}=empty_state"; unknowns=$((unknowns + 1)); return 1; }
    wf_expected="$(_expected_workflow_state "$wf")"
    if [[ "$wf_state" != "$wf_expected" ]]; then
      emit "workflow_${wf_base}_state=unexpected"; errors=$((errors + 1))
    else
      emit "workflow_${wf_base}_state=correct"
    fi

    # Nonterminal status checks
    local -a nonterminal_statuses=(queued in_progress waiting requested pending action_required stale)
    local status
    for status in "${nonterminal_statuses[@]}"; do
      local runs_json run_count
      runs_json="$(gh api "repos/${GH_REPOSITORY}/actions/workflows/${wf}/runs?status=${status}&per_page=100" 2>/dev/null)" || {
        emit "workflow_${wf_base}_${status}=api_error"; unknowns=$((unknowns + 1)); return 1; }
      run_count="$(printf '%s' "$runs_json" | jq '.total_count // empty' 2>/dev/null)" || {
        emit "workflow_${wf_base}_${status}=parse_error"; unknowns=$((unknowns + 1)); return 1; }
      [[ "$run_count" =~ ^[0-9]+$ ]] || {
        emit "workflow_${wf_base}_${status}=parse_error"; unknowns=$((unknowns + 1)); return 1; }

      [[ "$run_count" != "0" ]] || continue

      if [[ "$status" == "queued" ]]; then
        # Overflow: > 100 unfetched is AUDIT_INCOMPLETE
        if [[ "$run_count" -gt 100 ]]; then
          emit "queued_overflow=${run_count}"; unknowns=$((unknowns + 1)); return 1; fi

        # Materialize and validate array
        local fetched_count
        fetched_count="$(printf '%s' "$runs_json" | jq '[.workflow_runs[]?] | length' 2>/dev/null)" || {
          emit "workflow_${wf_base}_queued=array_parse_error"; unknowns=$((unknowns + 1)); return 1; }
        [[ "$fetched_count" == "$run_count" ]] || {
          emit "workflow_${wf_base}_queued=count_mismatch"; unknowns=$((unknowns + 1)); return 1; }

        # Write array to file for safe iteration
        local runs_file="$AUDIT_WORK_DIR/${wf_base}-queued-runs.json"
        printf '%s' "$runs_json" | jq -c '.workflow_runs[]?' > "$runs_file" 2>/dev/null || {
          emit "workflow_${wf_base}_queued=materialize_error"; unknowns=$((unknowns + 1)); return 1; }

        local inert_count=0 active_count=0
        local now_epoch
        now_epoch="$(date -u +%s)" || {
          emit "workflow_${wf_base}_queued=date_error"; unknowns=$((unknowns + 1)); return 1; }
        [[ "$now_epoch" =~ ^[1-9][0-9]*$ ]] || {
          emit "workflow_${wf_base}_queued=epoch_error"; unknowns=$((unknowns + 1)); return 1; }

        while IFS= read -r run_line; do
          [[ -n "$run_line" ]] || continue
          local run_updated run_created run_head_sha run_id
          run_updated="$(printf '%s' "$run_line" | jq -r '.updated_at // empty' 2>/dev/null)" || {
            emit "workflow_${wf_base}_queued=field_parse_error"; unknowns=$((unknowns + 1)); return 1; }
          run_created="$(printf '%s' "$run_line" | jq -r '.created_at // empty' 2>/dev/null)" || {
            emit "workflow_${wf_base}_queued=field_parse_error"; unknowns=$((unknowns + 1)); return 1; }
          run_head_sha="$(printf '%s' "$run_line" | jq -r '.head_sha // empty' 2>/dev/null)" || {
            emit "workflow_${wf_base}_queued=field_parse_error"; unknowns=$((unknowns + 1)); return 1; }
          run_id="$(printf '%s' "$run_line" | jq -r '.id // empty' 2>/dev/null)" || {
            emit "workflow_${wf_base}_queued=field_parse_error"; unknowns=$((unknowns + 1)); return 1; }

          # Validate formats
          [[ "$run_updated" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
            emit "workflow_${wf_base}_queued_timestamp=malformed"; unknowns=$((unknowns + 1)); return 1; }
          [[ "$run_created" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
            emit "workflow_${wf_base}_queued_timestamp=malformed"; unknowns=$((unknowns + 1)); return 1; }
          [[ "$run_head_sha" =~ ^[0-9a-f]{40}$ ]] || {
            emit "workflow_${wf_base}_queued_sha=malformed"; unknowns=$((unknowns + 1)); return 1; }
          [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || {
            emit "workflow_${wf_base}_queued_id=malformed"; unknowns=$((unknowns + 1)); return 1; }

          # Parse timestamp
          local updated_epoch
          updated_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$run_updated" +%s 2>/dev/null)" || \
          updated_epoch="$(date -u -d "$run_updated" +%s 2>/dev/null)" || {
            emit "workflow_${wf_base}_queued_date_parse=failed"; unknowns=$((unknowns + 1)); return 1; }
          [[ "$updated_epoch" =~ ^[1-9][0-9]*$ ]] || {
            emit "workflow_${wf_base}_queued_epoch=invalid"; unknowns=$((unknowns + 1)); return 1; }
          local age_seconds=$((now_epoch - updated_epoch))
          local stale_and_unchanged=false
          if [[ "$age_seconds" -gt "$INERT_RECORD_THRESHOLD_SECONDS" && "$run_created" == "$run_updated" ]]; then
            stale_and_unchanged=true
          fi

          # Jobs/deployments
          local jobs_json jobs_count
          jobs_json="$(gh api "repos/${GH_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=1" 2>/dev/null)" || {
            emit "workflow_${wf_base}_jobs=api_error"; unknowns=$((unknowns + 1)); return 1; }
          jobs_count="$(printf '%s' "$jobs_json" | jq '.total_count // empty' 2>/dev/null)" || {
            emit "workflow_${wf_base}_jobs=parse_error"; unknowns=$((unknowns + 1)); return 1; }
          [[ "$jobs_count" =~ ^[0-9]+$ ]] || {
            emit "workflow_${wf_base}_jobs=parse_error"; unknowns=$((unknowns + 1)); return 1; }

          local pending_json pending_count
          pending_json="$(gh api "repos/${GH_REPOSITORY}/actions/runs/${run_id}/pending_deployments" 2>/dev/null)" || {
            emit "workflow_${wf_base}_deploys=api_error"; unknowns=$((unknowns + 1)); return 1; }
          pending_count="$(printf '%s' "$pending_json" | jq '
            if type == "array" then length else error("not_array") end
          ' 2>/dev/null)" || {
            emit "workflow_${wf_base}_deploys=parse_error"; unknowns=$((unknowns + 1)); return 1; }
          [[ "$pending_count" =~ ^[0-9]+$ ]] || {
            emit "workflow_${wf_base}_deploys=parse_error"; unknowns=$((unknowns + 1)); return 1; }

          # Inert classification: disabled workflow + stale unchanged + 0 jobs + 0 deploys + sha != master
          if [[ "$wf_state" == "disabled_manually" &&
                "$stale_and_unchanged" == "true" &&
                "$jobs_count" == "0" &&
                "$pending_count" == "0" &&
                "$run_head_sha" != "$master_sha" ]]; then
            inert_count=$((inert_count + 1))
          else
            active_count=$((active_count + 1))
          fi
        done < "$runs_file"

        emit "workflow_${wf_base}_queued_inert=${inert_count}"
        if [[ "$active_count" -gt 0 ]]; then
          emit "workflow_${wf_base}_queued_active=${active_count}"
          errors=$((errors + active_count))
        fi
      else
        # Non-queued nonterminal: any count > 0 is error
        emit "workflow_${wf_base}_${status}=${run_count}"; errors=$((errors + 1))
      fi
    done
  done
  [[ "$errors" -eq "$errors_at_entry" ]] && return 0 || return 1
}

##############################################################################
# 7. Journal/migration evidence (inline contract validation)
##############################################################################
check_journal() {
  local artifact_name="oci-migration-success-provenance-${MIGRATION_RUN_ID}-${MIGRATION_RUN_ATTEMPT}"
  local artifact_dir="$AUDIT_WORK_DIR/artifact"
  mkdir -p "$artifact_dir"
  chmod 0700 "$artifact_dir"

  # Validate run identity
  local run_json
  run_json="$(gh api "repos/${GH_REPOSITORY}/actions/runs/${MIGRATION_RUN_ID}" 2>/dev/null)" || {
    emit "migration_run=api_error"; unknowns=$((unknowns + 1)); return 1; }
  local run_valid
  run_valid="$(printf '%s' "$run_json" | jq -e \
    --arg sha "$MIGRATION_SHA" \
    --argjson attempt "$MIGRATION_RUN_ATTEMPT" '
      .path == ".github/workflows/oci-migrate.yml" and
      .event == "workflow_dispatch" and
      .head_branch == "master" and
      .head_sha == $sha and
      .run_attempt == $attempt and
      .status == "completed" and
      .conclusion == "success"
    ' 2>/dev/null)" || {
    emit "migration_run=invalid"; errors=$((errors + 1)); return 1; }
  [[ "$run_valid" == "true" ]] || {
    emit "migration_run=invalid"; errors=$((errors + 1)); return 1; }
  emit "migration_run=verified"

  # Verify unique unexpired artifact with total_count validation
  local artifacts_json artifacts_total artifacts_match
  artifacts_json="$(gh api \
    "repos/${GH_REPOSITORY}/actions/runs/${MIGRATION_RUN_ID}/artifacts?per_page=100" 2>/dev/null)" || {
    emit "migration_artifact=api_error"; unknowns=$((unknowns + 1)); return 1; }
  artifacts_total="$(printf '%s' "$artifacts_json" | jq '.total_count // empty' 2>/dev/null)" || {
    emit "migration_artifact=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$artifacts_total" =~ ^[0-9]+$ ]] || {
    emit "migration_artifact=parse_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$artifacts_total" -le 100 ]] || {
    emit "migration_artifact=overflow"; unknowns=$((unknowns + 1)); return 1; }
  artifacts_match="$(printf '%s' "$artifacts_json" | jq -e --arg name "$artifact_name" '
    [.artifacts[] | select(.name == $name and .expired == false)] | length == 1
  ' 2>/dev/null)" || {
    emit "migration_artifact=not_unique"; errors=$((errors + 1)); return 1; }
  [[ "$artifacts_match" == "true" ]] || {
    emit "migration_artifact=not_unique"; errors=$((errors + 1)); return 1; }

  # Download artifact
  gh run download "$MIGRATION_RUN_ID" \
    --repo "$GH_REPOSITORY" \
    --name "$artifact_name" \
    --dir "$artifact_dir" 2>/dev/null || {
    emit "migration_artifact=download_failed"; unknowns=$((unknowns + 1)); return 1; }

  # Validate exactly one regular summary file
  local file_count
  file_count="$(find "$artifact_dir" -type f -name "migration-summary.env" | wc -l | tr -d ' ')"
  [[ "$file_count" == "1" ]] || {
    emit "migration_journal=file_count_error"; unknowns=$((unknowns + 1)); return 1; }
  local summary_file
  summary_file="$(find "$artifact_dir" -type f -name "migration-summary.env" -print)"
  [[ ! -L "$summary_file" ]] || {
    emit "migration_journal=symlink"; unknowns=$((unknowns + 1)); return 1; }

  # Validate artifact digest against reviewed constant (0644 from GitHub Actions)
  local artifact_digest
  artifact_digest="$(sha256_file "$summary_file")" || {
    emit "migration_journal=hash_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$artifact_digest" == "$REVIEWED_ARTIFACT_DIGEST" ]] || {
    emit "migration_journal=artifact_digest_mismatch"; errors=$((errors + 1)); return 1; }

  # Delegate full structural + semantic validation to shared contract helper
  local contract_helper="$ROOT_DIR/infra/oci/scripts/migration-success-contract.sh"
  [[ -f "$contract_helper" && -x "$contract_helper" ]] || {
    emit "migration_journal=contract_helper_missing"; unknowns=$((unknowns + 1)); return 1; }
  local contract_rc=0
  MODE=validate bash "$contract_helper" "$summary_file" \
    "SOURCE_SHA=${MIGRATION_SHA}" \
    "MIGRATION_RUN_ID=${MIGRATION_RUN_ID}" \
    "MIGRATION_RUN_ATTEMPT=${MIGRATION_RUN_ATTEMPT}" \
    "MIGRATION_ID=${MIGRATION_ID}" \
    "AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256=${AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256}" \
    2>/dev/null || contract_rc=$?
  if [[ "$contract_rc" -ne 0 ]]; then
    emit "migration_journal=contract_violation"; errors=$((errors + 1)); return 1
  fi
  local artifact_journal_sha
  artifact_journal_sha="$(state_field "$summary_file" final_journal_sha256)" || {
    emit "migration_journal=journal_sha_missing"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$artifact_journal_sha" == "$ret_state_journal_sha" ]] || {
    emit "migration_journal=retirement_state_mismatch"; errors=$((errors + 1)); return 1; }

  emit "http_mutation_fence=released"
  emit "migration_journal=verified"
  return 0
}

##############################################################################
# Authoritative billing implementation. The shared library owns provider
# response normalization and observation-chain validation.
##############################################################################
check_billing() {
  [[ "$AZURE_SUBSCRIPTION_BOUND" == "true" ]] || {
    emit "billing=subscription_not_bound"; unknowns=$((unknowns + 1)); return 1; }
  local subscription_id account_subscription account_state subscription_sha
  subscription_id="$AZURE_SUBSCRIPTION_ID"
  account_subscription="$(jq -r '.id // empty' "$AUDIT_WORK_DIR/account.json" 2>/dev/null)" || {
    emit "billing=no_subscription"; unknowns=$((unknowns + 1)); return 1; }
  account_state="$(jq -r '.state // empty' "$AUDIT_WORK_DIR/account.json" 2>/dev/null)" || {
    emit "billing=account_state_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$subscription_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || {
    emit "billing=invalid_subscription"; unknowns=$((unknowns + 1)); return 1; }
  subscription_sha="$(printf '%s' "$subscription_id" | sha256_text)" || {
    emit "billing=subscription_hash_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$account_subscription" == "$subscription_id" &&
     "$account_state" == "Enabled" &&
     "$subscription_sha" == "$AZURE_SUBSCRIPTION_FINGERPRINT" ]] || {
    emit "billing=subscription_binding_mismatch"; unknowns=$((unknowns + 1)); return 1; }

  local now_epoch today
  now_epoch="$(date -u +%s)" || {
    emit "billing=date_error"; unknowns=$((unknowns + 1)); return 1; }
  today="$(date -u +%Y-%m-%d)" || {
    emit "billing=today_error"; unknowns=$((unknowns + 1)); return 1; }
  [[ "$now_epoch" =~ ^[1-9][0-9]*$ &&
     "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || {
    emit "billing=date_invalid"; unknowns=$((unknowns + 1)); return 1; }

  local actual_file="$AUDIT_WORK_DIR/billing-actual.json"
  local amortized_file="$AUDIT_WORK_DIR/billing-amortized.json"
  local actual_query_ok=true amortized_query_ok=true
  if ! betstan_billing_query_cost_type \
    "ActualCost" \
    "$subscription_id" \
    "$BILLING_QUERY_START_DATE" \
    "$today" \
    "$BILLING_FIRST_USAGE_DATE" \
    "$actual_file"; then
    emit "billing_ActualCost=${BETSTAN_BILLING_ERROR_REASON}"
    unknowns=$((unknowns + 1))
    actual_query_ok=false
  fi
  if ! betstan_billing_query_cost_type \
    "AmortizedCost" \
    "$subscription_id" \
    "$BILLING_QUERY_START_DATE" \
    "$today" \
    "$BILLING_FIRST_USAGE_DATE" \
    "$amortized_file"; then
    emit "billing_AmortizedCost=${BETSTAN_BILLING_ERROR_REASON}"
    unknowns=$((unknowns + 1))
    amortized_query_ok=false
  fi

  local actual_result="" amortized_result=""
  local actual_currency="" amortized_currency="" live_currency
  local actual_positive="" amortized_positive=""
  if [[ "$actual_query_ok" == "true" ]]; then
    actual_result="$(jq -r '.result' "$actual_file")"
    actual_currency="$(jq -r '.currency' "$actual_file")"
    actual_positive="$(jq -r '.positive' "$actual_file")"
    emit "billing_ActualCost_positive=${actual_positive}"
  fi
  if [[ "$amortized_query_ok" == "true" ]]; then
    amortized_result="$(jq -r '.result' "$amortized_file")"
    amortized_currency="$(jq -r '.currency' "$amortized_file")"
    amortized_positive="$(jq -r '.positive' "$amortized_file")"
    emit "billing_AmortizedCost_positive=${amortized_positive}"
  fi

  if [[ "$actual_result" == "nogo" || "$amortized_result" == "nogo" ]]; then
    BILLING_RESULT="nogo"
    errors=$((errors + 1))
    emit "billing_live_result=nogo"
    return 0
  fi
  [[ "$actual_query_ok" == "true" && "$amortized_query_ok" == "true" ]] ||
    return 1

  if [[ "$actual_currency" != "NO_ROWS" &&
        "$amortized_currency" != "NO_ROWS" &&
        "$actual_currency" != "$amortized_currency" ]]; then
    emit "billing=cost_type_currency_mismatch"
    unknowns=$((unknowns + 1))
    return 1
  fi
  if [[ "$actual_currency" != "NO_ROWS" ]]; then
    live_currency="$actual_currency"
  else
    live_currency="$amortized_currency"
  fi

  if [[ "$actual_result" == "pending_adjustment" ||
        "$amortized_result" == "pending_adjustment" ]]; then
    BILLING_RESULT="pending_adjustment"
    emit "billing_live_result=pending_adjustment"
    return 0
  fi
  [[ "$actual_result" == "clean" && "$amortized_result" == "clean" ]] || {
    emit "billing=unexpected_result"; unknowns=$((unknowns + 1)); return 1; }

  local cutoff_age_seconds=$((now_epoch - BILLING_CUTOFF_EPOCH))
  local cutoff_age_hours=$((cutoff_age_seconds / 3600))
  if [[ "$cutoff_age_seconds" -le "$BETSTAN_BILLING_GRACE_SECONDS" ]]; then
    BILLING_RESULT="pending_grace"
    emit "billing_cutoff_age_hours=${cutoff_age_hours}"
    emit "billing_live_result=pending_grace"
    return 0
  fi

  if [[ -z "$BILLING_OBSERVATION_FILE" ]]; then
    BILLING_RESULT="pending_observation"
    emit "billing_observation=absent"
    return 0
  fi
  validate_private_file "$BILLING_OBSERVATION_FILE" "billing_observation" || return 1
  if ! betstan_billing_validate_observation_file \
    "$BILLING_OBSERVATION_FILE" \
    "$AZURE_SUBSCRIPTION_FINGERPRINT" \
    "$BILLING_CUTOFF_EPOCH" \
    "$BILLING_CUTOFF_DATE"; then
    emit "billing_observation=${BETSTAN_BILLING_ERROR_REASON}"
    unknowns=$((unknowns + 1))
    return 1
  fi

  if [[ "$BETSTAN_BILLING_OBS_COUNT" -lt "$BILLING_MIN_WINDOWS" ]]; then
    BILLING_RESULT="pending_observation"
    emit "billing_observation=too_few_windows"
    return 0
  fi
  if [[ "$BETSTAN_BILLING_OBS_SPAN_HOURS" -lt "$BILLING_MIN_SPAN_HOURS" ]]; then
    BILLING_RESULT="pending_observation"
    emit "billing_observation=span_too_short"
    return 0
  fi
  if [[ "$BETSTAN_BILLING_OBS_LAST_EPOCH" -gt "$now_epoch" ]]; then
    BILLING_RESULT="pending_observation"
    emit "billing_observation=future_last"
    return 0
  fi
  local stale_seconds=$((now_epoch - BETSTAN_BILLING_OBS_LAST_EPOCH))
  if [[ "$stale_seconds" -gt $((BILLING_MAX_STALE_HOURS * 3600)) ]]; then
    BILLING_RESULT="pending_observation"
    emit "billing_observation=last_too_stale"
    return 0
  fi
  if [[ "$live_currency" != "NO_ROWS" &&
        -n "$BETSTAN_BILLING_OBS_CURRENCY" &&
        "$live_currency" != "$BETSTAN_BILLING_OBS_CURRENCY" ]]; then
    emit "billing_observation=currency_mismatch"
    unknowns=$((unknowns + 1))
    return 1
  fi

  BILLING_RESULT="retired"
  emit "billing_live_result=retired"
  emit "billing_observation=valid"
}

##############################################################################
# Execution
##############################################################################
resource_pass=true
identity_pass=true
workflow_pass=true
journal_pass=true

health_status=0
component_errors_before=$errors
component_unknowns_before=$unknowns
check_public_health || health_status=$?
if [[ "$health_status" -ne 0 || "$errors" -gt "$component_errors_before" ||
      "$unknowns" -gt "$component_unknowns_before" ]]; then
  resource_pass=false
fi

oci_status=0
component_errors_before=$errors
component_unknowns_before=$unknowns
check_oci_inventory || oci_status=$?
if [[ "$oci_status" -ne 0 || "$errors" -gt "$component_errors_before" ||
      "$unknowns" -gt "$component_unknowns_before" ]]; then
  resource_pass=false
fi

azure_status=0
component_errors_before=$errors
component_unknowns_before=$unknowns
check_azure_absence || azure_status=$?
if [[ "$azure_status" -ne 0 || "$errors" -gt "$component_errors_before" ||
      "$unknowns" -gt "$component_unknowns_before" ]]; then
  resource_pass=false
fi

identity_status=0
component_errors_before=$errors
component_unknowns_before=$unknowns
check_identity || identity_status=$?
if [[ "$identity_status" -ne 0 || "$errors" -gt "$component_errors_before" ||
      "$unknowns" -gt "$component_unknowns_before" ]]; then
  identity_pass=false
fi

attestation_status=0
component_errors_before=$errors
component_unknowns_before=$unknowns
check_identity_attestation || attestation_status=$?
if [[ "$attestation_status" -ne 0 || "$errors" -gt "$component_errors_before" ||
      "$unknowns" -gt "$component_unknowns_before" ]]; then
  identity_pass=false
fi

recovery_status=0
component_errors_before=$errors
component_unknowns_before=$unknowns
check_recovery_variables || recovery_status=$?
if [[ "$recovery_status" -ne 0 || "$errors" -gt "$component_errors_before" ||
      "$unknowns" -gt "$component_unknowns_before" ]]; then
  identity_pass=false
fi

workflow_status=0
component_errors_before=$errors
component_unknowns_before=$unknowns
check_workflows || workflow_status=$?
if [[ "$workflow_status" -ne 0 || "$errors" -gt "$component_errors_before" ||
      "$unknowns" -gt "$component_unknowns_before" ]]; then
  workflow_pass=false
fi

journal_status=0
component_errors_before=$errors
component_unknowns_before=$unknowns
check_journal || journal_status=$?
if [[ "$journal_status" -ne 0 || "$errors" -gt "$component_errors_before" ||
      "$unknowns" -gt "$component_unknowns_before" ]]; then
  journal_pass=false
fi

pre_billing_errors="$errors"
pre_billing_unknowns="$unknowns"
BILLING_RESULT="incomplete"
billing_unknowns_before="$unknowns"
billing_status=0
check_billing || billing_status=$?
if [[ "$billing_status" -ne 0 && "$unknowns" == "$billing_unknowns_before" ]]; then
  emit "billing=unexpected_failure"
  unknowns=$((unknowns + 1))
fi

##############################################################################
# Phase determination
##############################################################################
emit "resource_retirement=${resource_pass}"
emit "identity_retirement=${identity_pass}"
emit "workflow_retirement=${workflow_pass}"
emit "journal_verified=${journal_pass}"
emit "errors=${errors}"
emit "unknowns=${unknowns}"

if [[ "$pre_billing_errors" == "0" && "$pre_billing_unknowns" == "0" &&
      "$resource_pass" == "true" && "$identity_pass" == "true" &&
      "$workflow_pass" == "true" && "$journal_pass" == "true" ]]; then
  emit "resource_phase=RESOURCE_RETIREMENT_COMPLETE"
fi

if [[ "$errors" -gt 0 ]]; then
  emit "terminal_phase=NO_GO"
  if [[ "$BILLING_RESULT" == "nogo" ]]; then
    emit "billing_phase=unsafe_post_cutoff_cost"
  fi
  exit 1
fi

if [[ "$unknowns" -gt 0 ]]; then
  emit "terminal_phase=AUDIT_INCOMPLETE"
  exit 2
fi

if [[ "$resource_pass" != "true" || "$identity_pass" != "true" ||
      "$workflow_pass" != "true" || "$journal_pass" != "true" ]]; then
  emit "terminal_phase=AUDIT_INCOMPLETE"
  exit 2
fi

if [[ "$BILLING_RESULT" == "nogo" ]]; then
  emit "terminal_phase=NO_GO"
  emit "billing_phase=unsafe_post_cutoff_cost"
  exit 1
elif [[ "$BILLING_RESULT" == "retired" ]]; then
  emit "terminal_phase=AZURE_RETIRED"
  emit "billing_phase=mature_clean_windows"
  exit 0
elif [[ "$BILLING_RESULT" == "pending_adjustment" ]]; then
  emit "terminal_phase=BILLING_INGESTION_PENDING"
  emit "billing_phase=historical_adjustment_pending"
  exit 3
elif [[ "$BILLING_RESULT" == "pending_grace" ]]; then
  emit "terminal_phase=BILLING_INGESTION_PENDING"
  emit "billing_phase=ingestion_grace"
  exit 3
elif [[ "$BILLING_RESULT" == "pending_observation" ]]; then
  emit "terminal_phase=BILLING_INGESTION_PENDING"
  emit "billing_phase=awaiting_observation"
  exit 3
else
  emit "terminal_phase=AUDIT_INCOMPLETE"
  exit 2
fi
