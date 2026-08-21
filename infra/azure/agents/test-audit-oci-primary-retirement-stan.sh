#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$TEST_DIR/../../.." && pwd)"
AUDIT_SOURCE="$TEST_DIR/audit-oci-primary-retirement-stan.sh"
BILLING_LIBRARY="$TEST_DIR/azure-retirement-billing-lib-stan.sh"
# shellcheck source=azure-retirement-billing-lib-stan.sh
# shellcheck disable=SC1091
source "$BILLING_LIBRARY"

WORK_PARENT="$(mktemp -d "${TEST_DIR}/.terminal-audit-tests.XXXXXX")"
chmod 0700 "$WORK_PARENT"
trap 'rm -rf "$WORK_PARENT"' EXIT

declare -i passed=0 failed=0
pass() { passed=$((passed + 1)); printf 'PASS %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s%s\n' "$1" "${2:+: $2}"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label" "expected=$expected actual=$actual"
  fi
}

assert_contains() {
  local value="$1" expected="$2" label="$3"
  if grep -Fq "$expected" <<<"$value"; then
    pass "$label"
  else
    fail "$label" "missing=$expected"
  fi
}

assert_not_contains() {
  local value="$1" unexpected="$2" label="$3"
  if grep -Fq "$unexpected" <<<"$value"; then
    fail "$label" "found=$unexpected"
  else
    pass "$label"
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256_text() {
  printf '%s' "$1" | betstan_billing_sha256_text
}

epoch_date() {
  local epoch="$1"
  date -u -r "$epoch" +%Y-%m-%d 2>/dev/null ||
    date -u -d "@${epoch}" +%Y-%m-%d
}

epoch_iso() {
  local epoch="$1"
  date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    date -u -d "@${epoch}" +%Y-%m-%dT%H:%M:%SZ
}

readonly SUBSCRIPTION_ID="12345678-1234-1234-1234-123456789abc"
SUBSCRIPTION_FINGERPRINT="$(
  printf '%s' "$SUBSCRIPTION_ID" | betstan_billing_sha256_text
)"
readonly TENANT_ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
readonly MIGRATION_RUN_ID="32256565339"
readonly MIGRATION_RUN_ATTEMPT="1"
readonly MIGRATION_ID="32256565339-1"
readonly MIGRATION_SHA="a1716b64a36d48dbb35023200a96282587d0ac91"
readonly CLUSTER_FINGERPRINT="6047248565caed9e7f35e9608cefc99d2ceb097faab16a5f5f9cbfc61d5baf16"
readonly AZURE_INVENTORY_DIGEST="b38349b0c710fbb1141cdcb85ee69e444fa3facdffe744d36153b0673d2934c6"
readonly FINAL_JOURNAL_SHA="be19756ec8dc80e967c481def89b7d8466b74dd4cf2ae4756ce16ecc40b21be9"
readonly COMPARTMENT_OCID="ocid1.compartment.oc1..aaaaauditfixture"
readonly VCN_OCID="ocid1.vcn.oc1.eu-frankfurt-1.auditvcn"
readonly WORKER_NSG_OCID="ocid1.networksecuritygroup.oc1.eu-frankfurt-1.auditworker"
readonly LB_NSG_OCID="ocid1.networksecuritygroup.oc1.eu-frankfurt-1.auditlb"
readonly WORKER_SUBNET_OCID="ocid1.subnet.oc1.eu-frankfurt-1.auditworker"
readonly LB_SUBNET_OCID="ocid1.subnet.oc1.eu-frankfurt-1.auditlb"
readonly BASTION_OCID="ocid1.bastion.oc1.eu-frankfurt-1.auditbastion"
readonly INSTANCE_OCID="ocid1.instance.oc1.eu-frankfurt-1.auditinstance"
readonly BOOT_VOLUME_OCID="ocid1.bootvolume.oc1.eu-frankfurt-1.auditboot"
readonly MONGO_VOLUME_OCID="ocid1.volume.oc1.eu-frankfurt-1.auditmongo"
readonly ATTACHMENT_OCID="ocid1.volumeattachment.oc1.eu-frankfurt-1.auditattachment"
readonly LOAD_BALANCER_OCID="ocid1.loadbalancer.oc1.eu-frankfurt-1.auditlb"
readonly AVAILABILITY_DOMAIN="fixture:EU-FRANKFURT-1-AD-1"
readonly INGRESS_IP="92.5.96.113"
readonly RETAINED_SP="aabbccdd-1122-3344-5566-778899001122"
readonly MIGRATION_APP="11111111-1111-1111-1111-111111111111"
readonly RECOVERY_APP="22222222-2222-2222-2222-222222222222"
readonly MIGRATION_SP="33333333-3333-3333-3333-333333333333"
readonly RECOVERY_SP="44444444-4444-4444-4444-444444444444"
readonly CUSTOM_ROLE_1="88888888-8888-8888-8888-888888888888"
readonly CUSTOM_ROLE_2="99999999-9999-9999-9999-999999999999"
readonly ROLE_ASSIGNMENT_1="/subscriptions/${SUBSCRIPTION_ID}/resourcegroups/betstan-rg/providers/Microsoft.ContainerService/managedClusters/betstan-aks/providers/Microsoft.Authorization/roleAssignments/55555555-5555-5555-5555-555555555555"
readonly ROLE_ASSIGNMENT_2="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/MC_betstan-rg_betstan-aks_eastus/providers/Microsoft.Authorization/roleAssignments/66666666-6666-6666-6666-666666666666"
readonly ROLE_ASSIGNMENT_3="/subscriptions/${SUBSCRIPTION_ID}/resourcegroups/betstan-rg/providers/Microsoft.ContainerService/managedClusters/betstan-aks/providers/Microsoft.Authorization/roleAssignments/77777777-7777-7777-7777-777777777777"
NOW_EPOCH="$(date -u +%s)"
RECENT_CUTOFF_EPOCH=$((NOW_EPOCH - 3600))
MATURE_CUTOFF_EPOCH=$((NOW_EPOCH - 10 * 86400))

apply_env_overrides() {
  local file="$1"
  shift
  while [[ $# -gt 0 ]]; do
    local key="${1%%=*}" value="${1#*=}"
    if grep -q "^${key}=" "$file"; then
      sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file"
      rm -f "$file.bak"
    else
      printf '%s=%s\n' "$key" "$value" >>"$file"
    fi
    shift
  done
}

write_provenance() {
  local file="$1"
  shift
  local hex_a hex_b hex_c
  hex_a="$(printf 'a%.0s' {1..64})"
  hex_b="$(printf 'b%.0s' {1..64})"
  hex_c="$(printf 'c%.0s' {1..64})"
  printf '%s\n' \
    "source_sha=${MIGRATION_SHA}" \
    "infrastructure_run_id=32254874213" \
    "infrastructure_run_attempt=1" \
    "runtime_mode=k3s" \
    "network_prepared=true" \
    "infrastructure_finalized=true" \
    "region=eu-frankfurt-1" \
    "compartment_ocid=${COMPARTMENT_OCID}" \
    "vcn_ocid=${VCN_OCID}" \
    "vcn_fingerprint=$(sha256_text "$VCN_OCID")" \
    "worker_nsg_ocid=${WORKER_NSG_OCID}" \
    "lb_nsg_ocid=${LB_NSG_OCID}" \
    "worker_subnet_ocid=${WORKER_SUBNET_OCID}" \
    "lb_subnet_ocid=${LB_SUBNET_OCID}" \
    "bastion_ocid=${BASTION_OCID}" \
    "bastion_fingerprint=$(sha256_text "$BASTION_OCID")" \
    "instance_ocid=${INSTANCE_OCID}" \
    "instance_fingerprint=$(sha256_text "$INSTANCE_OCID")" \
    "instance_private_ip=10.42.24.34" \
    "instance_public_ip=130.61.216.66" \
    "availability_domain=${AVAILABILITY_DOMAIN}" \
    "boot_volume_ocid=${BOOT_VOLUME_OCID}" \
    "mongo_volume_ocid=${MONGO_VOLUME_OCID}" \
    "OCI_MONGO_VOLUME_OCID=${MONGO_VOLUME_OCID}" \
    "mongo_volume_attachment_ocid=${ATTACHMENT_OCID}" \
    "lb_ocid=${LOAD_BALANCER_OCID}" \
    "ingress_ipv4=${INGRESS_IP}" \
    "public_host=betstan.xyz" \
    "canonical_host=betstan.xyz" \
    "redirect_host=www.betstan.xyz" \
    "diagnostic_host=${INGRESS_IP}.nip.io" \
    "namespace=betstan-oci" \
    "k3s_node_name=betstan-k3s" \
    "k3s_version=v1.34.9+k3s1" \
    "target_ssh_public_key_sha256=${hex_a}" \
    "node_shape=VM.Standard.A1.Flex" \
    "node_ocpus=2" \
    "node_memory_gb=12" \
    "boot_volume_gb=50" \
    "boot_volume_vpus_per_gb=10" \
    "mongo_volume_gb=50" \
    "lb_min_mbps=10" \
    "lb_max_mbps=10" \
    "expected_monthly_cost=0" \
    "ingress_nginx_chart_version=4.15.1" \
    "ingress_nginx_chart_sha256=${hex_a}" \
    "cert_manager_chart_version=v1.21.1" \
    "cert_manager_chart_sha256=${hex_b}" \
    "cert_manager_controller_digest=sha256:${hex_a}" \
    "cert_manager_webhook_digest=sha256:${hex_b}" \
    "cert_manager_cainjector_digest=sha256:${hex_c}" \
    "cert_manager_acmesolver_digest=sha256:${hex_a}" \
    "cert_manager_startup_digest=sha256:${hex_b}" \
    >"$file"
  apply_env_overrides "$file" "$@"
  chmod 0600 "$file"
}

write_identity_state() {
  local file="$1"
  printf '%s\n' \
    "custom_role_id_1=${CUSTOM_ROLE_1}" \
    "custom_role_id_2=${CUSTOM_ROLE_2}" \
    "metadata_sha256=$(printf 'd%.0s' {1..64})" \
    "migration_app_id=${MIGRATION_APP}" \
    "migration_environment=oci-migration" \
    "migration_secret_name=OCI_MIGRATION_AZURE_CREDENTIALS" \
    "migration_sp_object_id=${MIGRATION_SP}" \
    "phase=retired" \
    "recovery_app_id=${RECOVERY_APP}" \
    "recovery_environment=azure-migration-recovery" \
    "recovery_secret_name=AZURE_MIGRATION_RECOVERY_CREDENTIALS" \
    "recovery_sp_object_id=${RECOVERY_SP}" \
    "repository=vasilyevstan/betstan" \
    "retained_secret_name=AZURE_CREDENTIALS" \
    "retained_sp_display_name=betstan-github-sp" \
    "retained_sp_object_id=${RETAINED_SP}" \
    "role_assignment_id_1=${ROLE_ASSIGNMENT_1}" \
    "role_assignment_id_2=${ROLE_ASSIGNMENT_2}" \
    "role_assignment_id_3=${ROLE_ASSIGNMENT_3}" \
    "schema=betstan.identity-retirement-terminal.v1" \
    "subscription_id=${SUBSCRIPTION_ID}" \
    "tenant_id=${TENANT_ID}" \
    "workflow_name=oci-migration-recovery.yml" \
    >"$file"
  chmod 0600 "$file"
}

write_attestation() {
  local file="$1" identity_state="$2"
  local state_hash metadata_hash
  state_hash="$(sha256_file "$identity_state")"
  metadata_hash="$(sed -n 's/^metadata_sha256=//p' "$identity_state")"
  printf '%s\n' \
    "activity_evidence_sha256=$(printf '1%.0s' {1..64})" \
    "creation_event_sha256=$(printf '2%.0s' {1..64})" \
    "deletion_completed_at=2026-08-19T15:45:46.007Z" \
    "deletion_event_sha256=$(printf '3%.0s' {1..64})" \
    "deletion_result_sha256=$(printf '4%.0s' {1..64})" \
    "phase=retired" \
    "reconstructed_metadata_sha256=${metadata_hash}" \
    "relationship_event_sha256=$(printf '5%.0s' {1..64})" \
    "retained_identity_intact=true" \
    "reverification_completed_at=2026-08-19T15:48:08.675Z" \
    "reverification_event_sha256=$(printf '6%.0s' {1..64})" \
    "reverification_result_sha256=$(printf '7%.0s' {1..64})" \
    "schema=betstan.identity-retirement-legacy-attestation.v1" \
    "temporary_objects_absent=true" \
    "temporary_objects_checked=9" \
    "terminal_state_sha256=${state_hash}" \
    >"$file"
  chmod 0600 "$file"
}

write_retirement_state() {
  local file="$1"
  printf '%s\n' \
    "schema=betstan.azure-retirement.v1" \
    "phase=retired" \
    "migration_id=${MIGRATION_ID}" \
    "source_sha=${MIGRATION_SHA}" \
    "github_run_id=${MIGRATION_RUN_ID}" \
    "github_run_attempt=${MIGRATION_RUN_ATTEMPT}" \
    "inventory_sha256=${AZURE_INVENTORY_DIGEST}" \
    "cluster_resource_id_sha256=${CLUSTER_FINGERPRINT}" \
    "subscription_id_sha256=${SUBSCRIPTION_FINGERPRINT}" \
    "cluster_etag=50abc89d-8711-4fc2-9d77-709d2a892a81" \
    "final_journal_sha256=${FINAL_JOURNAL_SHA}" \
    >"$file"
  chmod 0600 "$file"
}

write_migration_summary() {
  local file="$1"
  local signature
  signature="$(printf '8%.0s' {1..64})"
  printf '%s\n' \
    "schema=betstan.oci-migration-success.v1" \
    "migration_id=${MIGRATION_ID}" \
    "source_sha=${MIGRATION_SHA}" \
    "runtime_deploy_source_sha=${MIGRATION_SHA}" \
    "closed_recovery_retry=false" \
    "github_run_id=${MIGRATION_RUN_ID}" \
    "github_run_attempt=${MIGRATION_RUN_ATTEMPT}" \
    "terminal_phase=DEPLOYED_HEALTHY" \
    "terminal_status=DEPLOYED_HEALTHY" \
    "journal_generation=8" \
    "fencing_generation=8" \
    "journal_sequence=42" \
    "journal_heartbeat_epoch=1787150000" \
    "final_journal_sha256=${FINAL_JOURNAL_SHA}" \
    "artifact_run_binding=${MIGRATION_ID}" \
    "destructive_boundary_crossed=true" \
    "database_count=8" \
    "logical_source_target_parity=true" \
    "source_signature_aggregate_sha256=${signature}" \
    "target_signature_aggregate_sha256=${signature}" \
    "oci_reopened_healthy=true" \
    "http_mutation_fence_removed=true" \
    "azure_writers_frozen=true" \
    "azure_cluster_resource_id_sha256=${CLUSTER_FINGERPRINT}" \
    "aks_power_state=Stopped" \
    "vmss_instances_deallocated=true" \
    "azure_cluster_stopped_deallocated=true" \
    >"$file"
  chmod 0600 "$file"
}

write_observation() {
  local file="$1" cutoff_epoch="$2" cutoff_date="$3"
  shift 3
  local -a epochs=("$@")
  local entry epoch currency previous_chain="$BETSTAN_BILLING_ZERO_CHAIN"
  local epoch_csv="" actual_csv="" amortized_csv="" digest_csv=""
  local chain_csv="" currency_csv=""
  local digest_pair
  digest_pair="$(printf 'a%.0s' {1..64}):$(printf 'b%.0s' {1..64})"
  for entry in "${epochs[@]}"; do
    epoch="${entry%%:*}"
    if [[ "$entry" == *:* ]]; then
      currency="${entry#*:}"
    else
      currency="USD"
    fi
    local chain
    chain="$(betstan_billing_chain_hash \
      "$previous_chain" "$SUBSCRIPTION_FINGERPRINT" "$cutoff_epoch" \
      "$currency" "$epoch" "clean" "clean" "$digest_pair")"
    epoch_csv="${epoch_csv:+${epoch_csv},}${epoch}"
    actual_csv="${actual_csv:+${actual_csv},}clean"
    amortized_csv="${amortized_csv:+${amortized_csv},}clean"
    digest_csv="${digest_csv:+${digest_csv},}${digest_pair}"
    chain_csv="${chain_csv:+${chain_csv},}${chain}"
    currency_csv="${currency_csv:+${currency_csv},}${currency}"
    previous_chain="$chain"
  done
  local first_entry="${epochs[0]}"
  local last_entry="${epochs[$((${#epochs[@]} - 1))]}"
  local first="${first_entry%%:*}" last="${last_entry%%:*}"
  printf '%s\n' \
    "api_version=${BETSTAN_BILLING_API_VERSION}" \
    "currencies=${currency_csv}" \
    "cutoff_date=${cutoff_date}" \
    "cutoff_epoch=${cutoff_epoch}" \
    "observation_chain_sha256s=${chain_csv}" \
    "observation_epochs=${epoch_csv}" \
    "recorder_version=${BETSTAN_BILLING_RECORDER_VERSION}" \
    "response_digests=${digest_csv}" \
    "results_actual=${actual_csv}" \
    "results_amortized=${amortized_csv}" \
    "schema=${BETSTAN_BILLING_SCHEMA}" \
    "subscription_fingerprint=${SUBSCRIPTION_FINGERPRINT}" \
    "total_span_hours=$(((last - first) / 3600))" \
    "usage_api_version=${BETSTAN_BILLING_USAGE_API_VERSION}" \
    >"$file"
  chmod 0600 "$file"
}

create_provider_stubs() {
  local directory="$1"
  mkdir -p "$directory"

  cat >"$directory/oci" <<'OCI'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${STUB_OCI_FAIL:-0}" == "1" ]]; then
  printf '%s\n' "PROVIDER_SECRET_MARKER" >&2
  exit 1
fi
if [[ "${1:-}" == "--version" ]]; then
  printf '%s\n' "${STUB_OCI_VERSION:-3.90.0}"
  exit 0
fi
words=()
for argument in "$@"; do
  case "$argument" in
    --*) break ;;
    *) words+=("$argument") ;;
  esac
done
key=""
for word in "${words[@]}"; do
  key="${key:+${key}/}${word}"
done
case "$key" in
  ce/cluster/list|ce/node-pool/list|network/nat-gateway/list|network/service-gateway/list|os/bucket/list)
    printf '{"data":[]}\n'
    ;;
  compute/instance/list)
    jq -cn --arg id "$STUB_INSTANCE_OCID" '{
      data:[{
        id:$id,
        "display-name":"betstan-k3s-node",
        shape:"VM.Standard.A1.Flex",
        "lifecycle-state":"RUNNING",
        "shape-config":{ocpus:2,"memory-in-gbs":12},
        "freeform-tags":{
          "betstan-managed":"true",
          provider:"oci",
          "expected-monthly-cost":"0",
          "betstan-runtime":"k3s"
        }
      }]
    }'
    ;;
  compute/instance/get)
    instance_id="$STUB_INSTANCE_OCID"
    [[ "${STUB_OCI_INSTANCE_MISMATCH:-0}" == "0" ]] ||
      instance_id="${instance_id}-changed"
    jq -cn \
      --arg id "$instance_id" \
      --arg compartment "$STUB_COMPARTMENT_OCID" \
      --arg ad "$STUB_AVAILABILITY_DOMAIN" \
      --arg source "$STUB_MIGRATION_SHA" '{
        data:{
          id:$id,
          "compartment-id":$compartment,
          "availability-domain":$ad,
          "display-name":"betstan-k3s-node",
          shape:"VM.Standard.A1.Flex",
          "shape-config":{ocpus:2,"memory-in-gbs":12},
          "lifecycle-state":"RUNNING",
          "freeform-tags":{
            "betstan-managed":"true",
            provider:"oci",
            "betstan-runtime":"k3s",
            "expected-monthly-cost":"0",
            "source-sha":$source
          }
        }
      }'
    ;;
  bv/volume/list)
    jq -cn --arg id "$STUB_MONGO_VOLUME_OCID" '{
      data:[{
        id:$id,
        "display-name":"betstan-oci-mongo-50g",
        "size-in-gbs":50,
        "vpus-per-gb":0,
        "lifecycle-state":"AVAILABLE"
      }]
    }'
    ;;
  bv/volume/get)
    jq -cn \
      --arg id "$STUB_MONGO_VOLUME_OCID" \
      --arg compartment "$STUB_COMPARTMENT_OCID" \
      --arg ad "$STUB_AVAILABILITY_DOMAIN" '{
        data:{
          id:$id,
          "compartment-id":$compartment,
          "availability-domain":$ad,
          "display-name":"betstan-oci-mongo-50g",
          "size-in-gbs":50,
          "vpus-per-gb":0,
          "lifecycle-state":"AVAILABLE",
          "freeform-tags":{
            "betstan-managed":"true",
            provider:"oci",
            "betstan-runtime":"k3s",
            "expected-monthly-cost":"0"
          }
        }
      }'
    ;;
  bv/boot-volume/list)
    jq -cn --arg id "$STUB_BOOT_VOLUME_OCID" '{
      data:[{
        id:$id,
        "display-name":"betstan-k3s-node (Boot Volume)",
        "size-in-gbs":50,
        "vpus-per-gb":10,
        "lifecycle-state":"AVAILABLE"
      }]
    }'
    ;;
  bv/boot-volume/get)
    jq -cn \
      --arg id "$STUB_BOOT_VOLUME_OCID" \
      --arg compartment "$STUB_COMPARTMENT_OCID" \
      --arg ad "$STUB_AVAILABILITY_DOMAIN" \
      --arg source "$STUB_MIGRATION_SHA" '{
        data:{
          id:$id,
          "compartment-id":$compartment,
          "availability-domain":$ad,
          "display-name":"betstan-k3s-node (Boot Volume)",
          "size-in-gbs":50,
          "vpus-per-gb":10,
          "lifecycle-state":"AVAILABLE",
          "freeform-tags":{
            "betstan-managed":"true",
            provider:"oci",
            "betstan-runtime":"k3s",
            "expected-monthly-cost":"0",
            "source-sha":$source
          }
        }
      }'
    ;;
  compute/volume-attachment/get)
    jq -cn \
      --arg id "$STUB_ATTACHMENT_OCID" \
      --arg instance "$STUB_INSTANCE_OCID" \
      --arg volume "$STUB_MONGO_VOLUME_OCID" '{
        data:{
          id:$id,
          "instance-id":$instance,
          "volume-id":$volume,
          "lifecycle-state":"ATTACHED"
        }
      }'
    ;;
  lb/load-balancer/list)
    jq -cn --arg id "$STUB_LOAD_BALANCER_OCID" --arg ingress "$STUB_INGRESS_IP" '{
      data:[{
        id:$id,
        "display-name":"betstan-oci-ingress",
        "shape-name":"flexible",
        "lifecycle-state":"ACTIVE",
        "shape-details":{
          "minimum-bandwidth-in-mbps":10,
          "maximum-bandwidth-in-mbps":10
        },
        "ip-addresses":[{"ip-address":$ingress,"is-public":true}],
        "freeform-tags":{
          "betstan-managed":"true",
          provider:"oci",
          "expected-monthly-cost":"0"
        }
      }]
    }'
    ;;
  lb/load-balancer/get)
    jq -cn \
      --arg id "$STUB_LOAD_BALANCER_OCID" \
      --arg compartment "$STUB_COMPARTMENT_OCID" \
      --arg subnet "$STUB_LB_SUBNET_OCID" \
      --arg ingress "$STUB_INGRESS_IP" '{
        data:{
          id:$id,
          "compartment-id":$compartment,
          "display-name":"betstan-oci-ingress",
          "lifecycle-state":"ACTIVE",
          "shape-name":"flexible",
          "shape-details":{
            "minimum-bandwidth-in-mbps":10,
            "maximum-bandwidth-in-mbps":10
          },
          "subnet-ids":[$subnet],
          "ip-addresses":[{"ip-address":$ingress,"is-public":true}],
          "freeform-tags":{
            "betstan-managed":"true",
            provider:"oci",
            "betstan-runtime":"k3s",
            "expected-monthly-cost":"0"
          }
        }
      }'
    ;;
  nlb/network-load-balancer/list|artifacts/container/repository/list)
    if [[ "$key" == "nlb/network-load-balancer/list" ]]; then
      printf '{"data":{"items":[]}}\n'
    else
      printf '{"data":{"items":[{"display-name":"betstan_images","image-count":9,"layer-count":49,"layers-size-in-bytes":171413487,"is-public":false,"is-immutable":null}]}}\n'
    fi
    ;;
  network/internet-gateway/list)
    printf '{"data":[{"lifecycle-state":"AVAILABLE"}]}\n'
    ;;
  network/public-ip/list)
    jq -cn --arg ingress "$STUB_INGRESS_IP" '{
      data:[{
        "ip-address":$ingress,
        "lifecycle-state":"ASSIGNED",
        lifetime:"RESERVED",
        "assigned-entity-id":"lb",
        scope:"REGION"
      }]
    }'
    ;;
  bastion/bastion/list)
    jq -cn --arg id "$STUB_BASTION_OCID" '{
      data:[{
        id:$id,
        name:"betstan-oci-bastion",
        "lifecycle-state":"ACTIVE",
        "freeform-tags":{
          "betstan-managed":"true",
          provider:"oci",
          "expected-monthly-cost":"0"
        }
      }]
    }'
    ;;
  bastion/bastion/get)
    jq -cn \
      --arg id "$STUB_BASTION_OCID" \
      --arg compartment "$STUB_COMPARTMENT_OCID" \
      --arg subnet "$STUB_WORKER_SUBNET_OCID" \
      --arg cidr "${STUB_BASTION_CIDR:-192.0.2.1/32}" '{
        data:{
          id:$id,
          "compartment-id":$compartment,
          name:"betstan-oci-bastion",
          "lifecycle-state":"ACTIVE",
          "target-subnet-id":$subnet,
          "client-cidr-block-allow-list":[$cidr],
          "max-session-ttl-in-seconds":10800,
          "freeform-tags":{
            "betstan-managed":"true",
            provider:"oci",
            "expected-monthly-cost":"0"
          }
        }
      }'
    ;;
  bastion/session/list)
    case "${STUB_SESSION_STATE:-DELETED}" in
      DELETED) printf '{"data":[{"id":"historical","lifecycle-state":"DELETED"}]}\n' ;;
      ACTIVE) printf '{"data":[{"id":"active","lifecycle-state":"ACTIVE"}]}\n' ;;
      CREATING) printf '{"data":[{"id":"creating","lifecycle-state":"CREATING"}]}\n' ;;
      MALFORMED) printf '{"data":{}}\n' ;;
    esac
    ;;
  *)
    printf 'unsupported oci command: %s\n' "$key" >&2
    exit 64
    ;;
esac
OCI
  chmod 0700 "$directory/oci"

  cat >"$directory/az" <<'AZ'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${STUB_AZ_FAIL:-0}" == "1" ]]; then
  printf '%s\n' "PROVIDER_SECRET_MARKER" >&2
  exit 1
fi
command_name="${1:-}"
subcommand="${2:-}"
case "$command_name" in
  account)
    printf '{"id":"%s","state":"Enabled","tenantId":"%s"}\n' \
      "$STUB_SUBSCRIPTION_ID" "$STUB_TENANT_ID"
    ;;
  group)
    name=""
    shift 2
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name) shift; name="${1:-}" ;;
      esac
      shift
    done
    if [[ "$name" == MC_* ]]; then
      printf '%s\n' "${STUB_MANAGED_GROUP_EXISTS:-false}"
    else
      printf '%s\n' "${STUB_PRIMARY_GROUP_EXISTS:-false}"
    fi
    ;;
  resource)
    printf '%s\n' "${STUB_AZ_RESOURCES:-[]}"
    ;;
  ad)
    arguments="$*"
    if [[ "$subcommand" == "app" ]]; then
      printf '0\n'
    elif [[ "$subcommand" == "sp" ]]; then
      if [[ "$arguments" == *"--filter"* ]]; then
        exit 90
      fi
      if [[ "$arguments" == *"$STUB_RETAINED_SP"* ]]; then
        if [[ "$arguments" == *"displayName"* ]]; then
          printf 'betstan-github-sp\n'
        else
          printf '%s\n' "${STUB_RETAINED_SP_COUNT:-1}"
        fi
      else
        printf '0\n'
      fi
    fi
    ;;
  role)
    arguments="$*"
    if [[ "$subcommand" == "assignment" ]]; then
      if [[ "$arguments" == *"--assignee-object-id"* ]]; then
        printf '%s\n' "${STUB_RETAINED_ASSIGNMENTS:-[]}"
      elif [[ "$arguments" == *"--assignee"* ]]; then
        exit 91
      else
        printf '0\n'
      fi
    else
      printf '0\n'
    fi
    ;;
  rest)
    [[ -z "${STUB_BILLING_CALLED_FILE:-}" ]] ||
      : >"$STUB_BILLING_CALLED_FILE"
    method=""
    url=""
    body=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --method) shift; method="${1:-}" ;;
        --url) shift; url="${1:-}" ;;
        --body) shift; body="${1:-}" ;;
      esac
      shift
    done
    if [[ "$url" == *"/providers/Microsoft.Consumption/usageDetails?"* ]]; then
      [[ "$method" == "get" && -z "$body" ]] || exit 95
      if [[ "$url" == *"MC_betstan-rg_betstan-aks_eastus"* ]]; then
        usage_group="MC_betstan-rg_betstan-aks_eastus"
      else
        usage_group="betstan-rg"
      fi
      usage_metric="${url#*metric=}"
      usage_metric="${usage_metric%%&*}"
      usage_date="$STUB_USAGE_DATE"
      usage_iso="${usage_date:0:4}-${usage_date:4:2}-${usage_date:6:2}T00:00:00Z"
      usage_item() {
        local id_suffix="$1" cost="$2"
        jq -cn \
          --arg id "/usage/${usage_metric}/${usage_group}/${id_suffix}" \
          --arg subscription "$STUB_SUBSCRIPTION_ID" \
          --arg resource_group "$usage_group" \
          --arg date "$usage_iso" \
          --argjson cost "$cost" '{
            id:$id,
            kind:"legacy",
            properties:{
              subscriptionId:$subscription,
              resourceGroup:$resource_group,
              cost:$cost,
              date:$date,
              billingCurrency:"USD",
              chargeType:(if $cost < 0 then "Refund" else "Usage" end)
            }
          }'
      }
      case "${STUB_BILLING_MODE:-clean}" in
        negative)
          if [[ "$usage_group" == "betstan-rg" ]]; then
            item="$(usage_item negative -1)"
            jq -cn --argjson item "$item" '{value:[$item]}'
          else
            printf '{"value":[]}\n'
          fi
          ;;
        cancellation)
          if [[ "$usage_group" == "betstan-rg" ]]; then
            positive_item="$(usage_item positive 5)"
            negative_item="$(usage_item negative -5)"
            jq -cn --argjson positive "$positive_item" --argjson negative "$negative_item" \
              '{value:[$positive,$negative]}'
          else
            printf '{"value":[]}\n'
          fi
          ;;
        *)
          printf '{"value":[]}\n'
          ;;
      esac
      exit 0
    fi
    cost_type=""
    if [[ -n "$body" ]]; then
      cost_type="$(printf '%s' "$body" | jq -r '.type')"
    fi
    [[ "$method" == "post" ]] || exit 93
    printf '%s' "$body" | jq -e \
      --arg resource_group "betstan-rg" \
      --arg managed_group "MC_betstan-rg_betstan-aks_eastus" '
        (.timePeriod.from | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$")) and
        (.timePeriod.to | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T23:59:59Z$")) and
        .dataset.filter.dimensions.name == "ResourceGroup" and
        .dataset.filter.dimensions.operator == "In" and
        (.dataset.filter.dimensions.values | sort) ==
          ([$resource_group, $managed_group] | sort)
      ' >/dev/null || exit 94
    columns='[
      {"name":"Cost","type":"Number"},
      {"name":"UsageDate","type":"Number"},
      {"name":"ResourceGroup","type":"String"},
      {"name":"Currency","type":"String"}
    ]'
    case "${STUB_BILLING_MODE:-clean}" in
      clean)
        jq -cn --argjson columns "$columns" \
          '{properties:{columns:$columns,rows:[]}}'
        ;;
      positive)
        jq -cn --argjson columns "$columns" --argjson date "$STUB_USAGE_DATE" \
          '{properties:{columns:$columns,rows:[[5,$date,"betstan-rg","USD"]]}}'
        ;;
      negative)
        jq -cn --argjson columns "$columns" --argjson date "$STUB_USAGE_DATE" \
          '{properties:{columns:$columns,rows:[[-1,$date,"betstan-rg","USD"]]}}'
        ;;
      cancellation)
        jq -cn --argjson columns "$columns" --argjson date "$STUB_USAGE_DATE" \
          '{properties:{columns:$columns,rows:[[0,$date,"betstan-rg","USD"]]}}'
        ;;
      mixed_currency)
        jq -cn --argjson columns "$columns" --argjson date "$STUB_USAGE_DATE" '{
          properties:{columns:$columns,rows:[
            [1,$date,"unrelated-rg","USD"],
            [1,$date,"unrelated-rg","EUR"]
          ]}
        }'
        ;;
      bad_nextlink)
        jq -cn --argjson columns "$columns" \
          '{properties:{columns:$columns,rows:[],nextLink:42}}'
        ;;
      bad_columns)
        jq -cn '{
          properties:{
            columns:[
              {name:"Cost",type:"String"},
              {name:"UsageDate",type:"Number"},
              {name:"ResourceGroup",type:"String"},
              {name:"Currency",type:"String"}
            ],
            rows:[]
          }
        }'
        ;;
      paginated_reordered)
        next_url="https://management.azure.com/subscriptions/${STUB_SUBSCRIPTION_ID}/providers/Microsoft.CostManagement/Query?api-version=2021-10-01&page=2"
        if [[ "$url" == /subscriptions/* ]]; then
          jq -cn --argjson columns "$columns" --arg next "$next_url" '{
            properties:{
              columns:$columns,
              rows:[],
              nextLink:$next
            }
          }'
        elif [[ "$url" == "$next_url" ]]; then
          jq -cn --argjson date "$STUB_USAGE_DATE" '{
            properties:{
              columns:[
                {name:"Currency",type:"String"},
                {name:"ResourceGroup",type:"String"},
                {name:"Cost",type:"Number"},
                {name:"UsageDate",type:"Number"}
              ],
              rows:[["USD","betstan-rg",3,$date]]
            }
          }'
        else
          exit 92
        fi
        ;;
      cross_subscription_nextlink)
        jq -cn --argjson columns "$columns" '{
          properties:{
            columns:$columns,
            rows:[],
            nextLink:"https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.CostManagement/query?page=2"
          }
        }'
        ;;
      positive_actual_bad_amortized)
        if [[ "$cost_type" == "ActualCost" ]]; then
          jq -cn --argjson columns "$columns" --argjson date "$STUB_USAGE_DATE" \
            '{properties:{columns:$columns,rows:[[5,$date,"betstan-rg","USD"]]}}'
        else
          jq -cn '{
            properties:{
              columns:[
                {name:"Cost",type:"String"},
                {name:"UsageDate",type:"Number"},
                {name:"ResourceGroup",type:"String"},
                {name:"Currency",type:"String"}
              ],
              rows:[]
            }
          }'
        fi
        ;;
      clean_eur)
        jq -cn --argjson columns "$columns" --argjson date "$STUB_USAGE_DATE" \
          '{properties:{columns:$columns,rows:[[0,$date,"betstan-rg","EUR"]]}}'
        ;;
      cross_currency)
        if [[ "$cost_type" == "ActualCost" ]]; then
          currency="USD"
        else
          currency="EUR"
        fi
        jq -cn --argjson columns "$columns" --argjson date "$STUB_USAGE_DATE" \
          --arg currency "$currency" \
          '{properties:{columns:$columns,rows:[[0,$date,"unrelated-rg",$currency]]}}'
        ;;
    esac
    ;;
  *)
    exit 64
    ;;
esac
AZ
  chmod 0700 "$directory/az"

  cat >"$directory/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${STUB_GH_FAIL:-0}" == "1" ]]; then
  printf '%s\n' "PROVIDER_SECRET_MARKER" >&2
  exit 1
fi
case "${1:-}" in
  api)
    shift
    url="${1:-}"
    shift
    jq_filter=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --jq) shift; jq_filter="${1:-}" ;;
      esac
      shift
    done
    apply_filter() {
      local payload="$1"
      if [[ -n "$jq_filter" ]]; then
        printf '%s' "$payload" | jq -r "$jq_filter"
      else
        printf '%s' "$payload"
      fi
    }
    empty_secrets='{"total_count":0,"secrets":[]}'
    repo_secrets='{"total_count":1,"secrets":[{"name":"AZURE_CREDENTIALS"}]}'
    empty_runs='{"total_count":0,"workflow_runs":[]}'
    if [[ "$url" == *"/environments/oci-migration/secrets?"* ]]; then
      apply_filter "${STUB_MIGRATION_SECRETS:-$empty_secrets}"
    elif [[ "$url" == *"/environments/azure-migration-recovery/secrets?"* ]]; then
      apply_filter "${STUB_RECOVERY_SECRETS:-$empty_secrets}"
    elif [[ "$url" == *"/actions/secrets?"* ]]; then
      apply_filter "${STUB_REPO_SECRETS:-$repo_secrets}"
    elif [[ "$url" == *"/environments/azure-migration-recovery/variables/OCI_MIGRATION_RECOVERY_ENABLED"* ]]; then
      apply_filter '{"value":"false"}'
    elif [[ "$url" == *"/environments/azure-migration-recovery/variables/OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH"* ]]; then
      apply_filter '{"value":"0"}'
    elif [[ "$url" == *"/actions/variables/OCI_MIGRATION_RECOVERY_ENABLED"* ]]; then
      apply_filter '{"value":"false"}'
    elif [[ "$url" == *"/actions/variables/OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH"* ]]; then
      apply_filter '{"value":"0"}'
    elif [[ "$url" == *"/git/ref/heads/master"* ]]; then
      apply_filter "{\"object\":{\"sha\":\"$STUB_MASTER_SHA\"}}"
    elif [[ "$url" == *"/actions/workflows/"*"/runs?"* ]]; then
      if [[ "$url" == *"oci-migration-recovery.yml"* &&
            "$url" == *"status=queued"* &&
            -n "${STUB_RECOVERY_QUEUED_RUNS:-}" ]]; then
        apply_filter "$STUB_RECOVERY_QUEUED_RUNS"
      elif [[ "$url" == *"/production-deploy.yml/runs?"* &&
              "$url" == *"status=in_progress"* &&
              "${STUB_AZURE_DEPLOY_IN_PROGRESS:-0}" == "1" ]]; then
        apply_filter '{"total_count":1,"workflow_runs":[]}'
      else
        apply_filter "$empty_runs"
      fi
    elif [[ "$url" == *"/actions/workflows/"* ]]; then
      case "$url" in
        *oci-migrate.yml*) state="active" ;;
        *oci-migration-recovery.yml*) state="disabled_manually" ;;
        *oci-capacity-acquire.yml*) state="disabled_manually" ;;
        *oci-infrastructure.yml*) state="active" ;;
        *oci-production-build.yml*) state="active" ;;
        *oci-live-data-rollout.yml*) state="active" ;;
        *oci-production-deploy.yml*) state="active" ;;
        *production-build.yml*) state="active" ;;
        *production-deploy.yml*) state="${STUB_AZURE_DEPLOY_STATE:-active}" ;;
        *) exit 65 ;;
      esac
      apply_filter "{\"state\":\"${state}\"}"
    elif [[ "$url" == *"/actions/runs/"*"/artifacts?"* ]]; then
      apply_filter "{\"total_count\":1,\"artifacts\":[{\"name\":\"oci-migration-success-provenance-${STUB_MIGRATION_RUN_ID}-${STUB_MIGRATION_RUN_ATTEMPT}\",\"expired\":false}]}"
    elif [[ "$url" == *"/actions/runs/"*"/jobs?"* ]]; then
      apply_filter '{"total_count":0,"jobs":[]}'
    elif [[ "$url" == *"/actions/runs/"*"/pending_deployments"* ]]; then
      apply_filter "${STUB_PENDING_DEPLOYMENTS:-[]}"
    elif [[ "$url" == *"/actions/runs/"* ]]; then
      apply_filter "{\"path\":\".github/workflows/oci-migrate.yml\",\"event\":\"workflow_dispatch\",\"head_branch\":\"master\",\"head_sha\":\"${STUB_MIGRATION_SHA}\",\"run_attempt\":${STUB_MIGRATION_RUN_ATTEMPT},\"status\":\"completed\",\"conclusion\":\"success\"}"
    else
      exit 66
    fi
    ;;
  run)
    shift
    [[ "${1:-}" == "download" ]] || exit 67
    shift
    destination=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --dir) shift; destination="${1:-}" ;;
      esac
      shift
    done
    [[ -n "$destination" ]]
    mkdir -p "$destination"
    cp "$STUB_ARTIFACT_SOURCE" "$destination/migration-summary.env"
    ;;
  *)
    exit 68
    ;;
esac
GH
  chmod 0700 "$directory/gh"

  cat >"$directory/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
url=""
header_file=""
output_file=""
for argument in "$@"; do
  if [[ "$argument" == -*f* ]]; then
    exit 93
  fi
done
while [[ $# -gt 0 ]]; do
  case "$1" in
    https://*) url="$1" ;;
    --dump-header) shift; header_file="${1:-}" ;;
    --output|-o) shift; output_file="${1:-}" ;;
  esac
  shift
done
if [[ "$url" == "https://www.betstan.xyz/api/auth/currentuser?retirement-audit=1" ]]; then
  code="${STUB_REDIRECT_STATUS:-308}"
  printf 'HTTP/2 %s\r\nlocation: https://betstan.xyz/api/auth/currentuser?retirement-audit=1\r\n' \
    "$code" >"$header_file"
elif [[ "$url" == "https://betstan.xyz/api/auth/currentuser" ]]; then
  code="${STUB_CANONICAL_API_STATUS:-200}"
  printf 'HTTP/2 %s\r\ncontent-type: application/json; charset=utf-8\r\n' \
    "$code" >"$header_file"
  printf '%s' "${STUB_CANONICAL_API_BODY:-{\"currentUser\":null}}" >"$output_file"
elif [[ "$url" == *".nip.io/api/auth/currentuser" ]]; then
  code="${STUB_DIAGNOSTIC_API_STATUS:-200}"
  printf 'HTTP/2 %s\r\ncontent-type: application/json; charset=utf-8\r\n' \
    "$code" >"$header_file"
  printf '%s' "${STUB_DIAGNOSTIC_API_BODY:-{\"currentUser\":null}}" >"$output_file"
elif [[ "$url" == "https://betstan.xyz/" ]]; then
  code="${STUB_CANONICAL_STATUS:-200}"
elif [[ "$url" == *".nip.io/" ]]; then
  code="${STUB_DIAGNOSTIC_STATUS:-200}"
else
  exit 94
fi
printf '%s' "$code"
CURL
  chmod 0700 "$directory/curl"

  cat >"$directory/dig" <<'DIG'
#!/usr/bin/env bash
set -euo pipefail
record_type=""
for argument in "$@"; do
  case "$argument" in
    A|AAAA) record_type="$argument" ;;
  esac
done
if [[ "$record_type" == "AAAA" ]]; then
  [[ "${STUB_AAAA_PRESENT:-0}" == "0" ]] || printf '2001:db8::1\n'
else
  printf '%s\n' "${STUB_INGRESS_IP}"
fi
DIG
  chmod 0700 "$directory/dig"

  cat >"$directory/openssl" <<'OPENSSL'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  s_client)
    input="$(cat)"
    [[ "$input" == Q* ]] || exit 95
    printf '%s\n' \
      '-----BEGIN CERTIFICATE-----' \
      'TEST' \
      '-----END CERTIFICATE-----'
    ;;
  x509)
    if [[ "$*" == *"-out "* ]]; then
      output=""
      previous=""
      for argument in "$@"; do
        if [[ "$previous" == "-out" ]]; then
          output="$argument"
          break
        fi
        previous="$argument"
      done
      cat >"$output"
    elif [[ "$*" == *"-issuer"* ]]; then
      printf 'issuer=CN = R11, O = Lets Encrypt\n'
    elif [[ "$*" == *"-text"* ]]; then
      printf 'X509v3 Subject Alternative Name:\n DNS:betstan.xyz, DNS:www.betstan.xyz, DNS:%s.nip.io\n' "$STUB_INGRESS_IP"
    elif [[ "$*" == *"-checkend"* ]]; then
      exit 0
    else
      exit 96
    fi
    ;;
  *)
    exit 97
    ;;
esac
OPENSSL
  chmod 0700 "$directory/openssl"
}

provider_environment() {
  printf '%s\n' \
    "STUB_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
    "STUB_TENANT_ID=${TENANT_ID}" \
    "STUB_RETAINED_SP=${RETAINED_SP}" \
    "STUB_COMPARTMENT_OCID=${COMPARTMENT_OCID}" \
    "STUB_INSTANCE_OCID=${INSTANCE_OCID}" \
    "STUB_BOOT_VOLUME_OCID=${BOOT_VOLUME_OCID}" \
    "STUB_MONGO_VOLUME_OCID=${MONGO_VOLUME_OCID}" \
    "STUB_ATTACHMENT_OCID=${ATTACHMENT_OCID}" \
    "STUB_LOAD_BALANCER_OCID=${LOAD_BALANCER_OCID}" \
    "STUB_BASTION_OCID=${BASTION_OCID}" \
    "STUB_WORKER_SUBNET_OCID=${WORKER_SUBNET_OCID}" \
    "STUB_LB_SUBNET_OCID=${LB_SUBNET_OCID}" \
    "STUB_AVAILABILITY_DOMAIN=${AVAILABILITY_DOMAIN}" \
    "STUB_MIGRATION_SHA=${MIGRATION_SHA}" \
    "STUB_INGRESS_IP=${INGRESS_IP}" \
    "STUB_MASTER_SHA=fedcba0987654321fedcba0987654321fedcba09" \
    "STUB_MIGRATION_RUN_ID=${MIGRATION_RUN_ID}" \
    "STUB_MIGRATION_RUN_ATTEMPT=${MIGRATION_RUN_ATTEMPT}"
}

compute_inventory_digest() {
  local stub_directory="$1" output="$2"
  local -a environment=()
  while IFS= read -r entry; do
    environment+=("$entry")
  done < <(provider_environment)
  env -i \
    "PATH=${stub_directory}:${PATH}" \
    "${environment[@]}" \
    OCI_RUNTIME_MODE=k3s \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$output" \
    OCI_COMPARTMENT_OCID="$COMPARTMENT_OCID" \
    OCI_EXPECTED_MONTHLY_COST=0 \
    OCI_A1_OCPUS=2 \
    OCI_A1_MEMORY_GB=12 \
    OCI_LB_MIN_MBPS=10 \
    OCI_LB_MAX_MBPS=10 \
    OCI_REGISTRY_MAX_BYTES=500000000 \
    OCI_IMAGE_PREFIX=betstan \
    OCI_BOOT_VOLUME_GB=50 \
    OCI_BOOT_VOLUME_VPUS_PER_GB=10 \
    OCI_MONGO_VOLUME_GB=50 \
    OCI_CLI_VERSION=3.90.0 \
    /bin/bash "$ROOT_DIR/infra/oci/scripts/inventory.sh" >/dev/null
  sha256_file "$output"
}

make_audit_fixture() {
  local runtime_directory="$1" cutoff_epoch="$2" cutoff_date="$3"
  local provenance="$4" identity="$5" attestation="$6"
  local retirement="$7" artifact="$8" inventory_digest="$9"
  local runtime
  runtime="$(mktemp -d "${runtime_directory}/operator.XXXXXX")"
  cp "$BILLING_LIBRARY" "$runtime/azure-retirement-billing-lib-stan.sh"
  local provenance_digest identity_digest attestation_digest
  local retirement_digest artifact_digest cutoff_usage query_start
  local retirement_cutoff_epoch=$((cutoff_epoch - 3600))
  provenance_digest="$(sha256_file "$provenance")"
  identity_digest="$(sha256_file "$identity")"
  attestation_digest="$(sha256_file "$attestation")"
  retirement_digest="$(sha256_file "$retirement")"
  artifact_digest="$(sha256_file "$artifact")"
  cutoff_usage="${cutoff_date//-/}"
  query_start="$(epoch_date "$((cutoff_epoch - 7 * 86400))")"
  sed \
    -e "s|^ROOT_DIR=.*|ROOT_DIR=\"${ROOT_DIR}\"|" \
    -e "s/^readonly REVIEWED_OCI_PROVENANCE_DIGEST=.*/readonly REVIEWED_OCI_PROVENANCE_DIGEST=\"${provenance_digest}\"/" \
    -e "s/^readonly REVIEWED_OCI_INVENTORY_DIGEST=.*/readonly REVIEWED_OCI_INVENTORY_DIGEST=\"${inventory_digest}\"/" \
    -e "s/^readonly REVIEWED_ARTIFACT_DIGEST=.*/readonly REVIEWED_ARTIFACT_DIGEST=\"${artifact_digest}\"/" \
    -e "s/^readonly REVIEWED_IDENTITY_STATE_DIGEST=.*/readonly REVIEWED_IDENTITY_STATE_DIGEST=\"${identity_digest}\"/" \
    -e "s/^readonly REVIEWED_IDENTITY_ATTESTATION_DIGEST=.*/readonly REVIEWED_IDENTITY_ATTESTATION_DIGEST=\"${attestation_digest}\"/" \
    -e "s/^readonly REVIEWED_RETIREMENT_STATE_DIGEST=.*/readonly REVIEWED_RETIREMENT_STATE_DIGEST=\"${retirement_digest}\"/" \
    -e "s/^readonly RETIREMENT_CUTOFF_EPOCH=.*/readonly RETIREMENT_CUTOFF_EPOCH=${retirement_cutoff_epoch}/" \
    -e "s/^readonly BILLING_CUTOFF_EPOCH=.*/readonly BILLING_CUTOFF_EPOCH=${cutoff_epoch}/" \
    -e "s/^readonly BILLING_CUTOFF_DATE=.*/readonly BILLING_CUTOFF_DATE=\"${cutoff_date}\"/" \
    -e "s/^readonly BILLING_FIRST_USAGE_DATE=.*/readonly BILLING_FIRST_USAGE_DATE=\"${cutoff_usage}\"/" \
    -e "s/^readonly BILLING_QUERY_START_DATE=.*/readonly BILLING_QUERY_START_DATE=\"${query_start}\"/" \
    "$AUDIT_SOURCE" >"$runtime/audit-oci-primary-retirement-stan.sh"
  chmod 0700 "$runtime/audit-oci-primary-retirement-stan.sh"
  AUDIT_FIXTURE="$runtime/audit-oci-primary-retirement-stan.sh"
  PROVENANCE_DIGEST="$provenance_digest"
}

CASE_DIR=""
STATE_DIR=""
STUB_DIR=""
RUNTIME_DIR=""
PROVENANCE=""
IDENTITY_STATE=""
ATTESTATION=""
RETIREMENT_STATE=""
ARTIFACT=""
INVENTORY_DIGEST=""
new_case() {
  local name="$1"
  CASE_DIR="$WORK_PARENT/$name"
  STATE_DIR="$CASE_DIR/state"
  STUB_DIR="$CASE_DIR/bin"
  RUNTIME_DIR="$CASE_DIR/runtime"
  mkdir -p "$STATE_DIR" "$RUNTIME_DIR"
  chmod 0700 "$STATE_DIR" "$RUNTIME_DIR"
  create_provider_stubs "$STUB_DIR"
  PROVENANCE="$STATE_DIR/provenance.env"
  IDENTITY_STATE="$STATE_DIR/identity-state.env"
  ATTESTATION="$STATE_DIR/attestation.env"
  RETIREMENT_STATE="$STATE_DIR/retirement-state.env"
  ARTIFACT="$STATE_DIR/migration-summary.env"
  write_provenance "$PROVENANCE"
  write_identity_state "$IDENTITY_STATE"
  write_attestation "$ATTESTATION" "$IDENTITY_STATE"
  write_retirement_state "$RETIREMENT_STATE"
  write_migration_summary "$ARTIFACT"
  INVENTORY_DIGEST="$(compute_inventory_digest \
    "$STUB_DIR" "$STATE_DIR/baseline-inventory.json")"
}

RUN_OUTPUT=""
RUN_RC=0
run_audit() {
  local observation_file="$1" cutoff_epoch="$2"
  shift 2
  local cutoff_date post_cutoff_date
  cutoff_date="$(epoch_date "$cutoff_epoch")"
  post_cutoff_date="$(epoch_date "$((cutoff_epoch + 86400))")"
  post_cutoff_date="${post_cutoff_date//-/}"
  make_audit_fixture \
    "$RUNTIME_DIR" "$cutoff_epoch" "$cutoff_date" \
    "$PROVENANCE" "$IDENTITY_STATE" "$ATTESTATION" \
    "$RETIREMENT_STATE" "$ARTIFACT" "$INVENTORY_DIGEST"

  local -a environment=(
    "PATH=${STUB_DIR}:${PATH}"
    "OCI_DIAGNOSTIC_URL=https://${INGRESS_IP}.nip.io"
    "OCI_COMPARTMENT_OCID=${COMPARTMENT_OCID}"
    "OCI_INFRASTRUCTURE_PROVENANCE_FILE=${PROVENANCE}"
    "EXPECTED_OCI_INVENTORY_DIGEST=${INVENTORY_DIGEST}"
    "EXPECTED_OCI_PROVENANCE_DIGEST=${PROVENANCE_DIGEST}"
    "AZURE_SUBSCRIPTION_FINGERPRINT=${SUBSCRIPTION_FINGERPRINT}"
    "AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256=${CLUSTER_FINGERPRINT}"
    "AZURE_RETIREMENT_STATE_FILE=${RETIREMENT_STATE}"
    "MIGRATION_RUN_ID=${MIGRATION_RUN_ID}"
    "MIGRATION_RUN_ATTEMPT=${MIGRATION_RUN_ATTEMPT}"
    "MIGRATION_ID=${MIGRATION_ID}"
    "MIGRATION_SHA=${MIGRATION_SHA}"
    "IDENTITY_STATE_FILE=${IDENTITY_STATE}"
    "IDENTITY_ATTESTATION_FILE=${ATTESTATION}"
    "AUDIT_WORK_PARENT=${STATE_DIR}"
    "STUB_ARTIFACT_SOURCE=${ARTIFACT}"
    "STUB_USAGE_DATE=${post_cutoff_date}"
  )
  while IFS= read -r entry; do
    environment+=("$entry")
  done < <(provider_environment)
  [[ -z "$observation_file" ]] ||
    environment+=("BILLING_OBSERVATION_FILE=${observation_file}")
  while [[ $# -gt 0 ]]; do
    environment+=("$1")
    shift
  done

  RUN_RC=0
  RUN_OUTPUT="$(env -i "${environment[@]}" /bin/bash "$AUDIT_FIXTURE" 2>&1)" ||
    RUN_RC=$?
}

printf '%s\n' "Running terminal retirement audit contract tests"

new_case missing-input
run_audit "" "$RECENT_CUTOFF_EPOCH" "OCI_DIAGNOSTIC_URL="
assert_eq 2 "$RUN_RC" "missing audit input is incomplete"
assert_contains "$RUN_OUTPUT" "missing_input_OCI_DIAGNOSTIC_URL" \
  "missing audit input uses the incomplete contract"

new_case pending-grace
run_audit "" "$RECENT_CUTOFF_EPOCH"
assert_eq 3 "$RUN_RC" "recent cutoff exits billing-pending"
assert_contains "$RUN_OUTPUT" "resource_phase=RESOURCE_RETIREMENT_COMPLETE" \
  "recent cutoff preserves resource completion"
assert_contains "$RUN_OUTPUT" "terminal_phase=BILLING_INGESTION_PENDING" \
  "recent cutoff is billing pending"
assert_contains "$RUN_OUTPUT" "billing_phase=ingestion_grace" \
  "recent cutoff is not audit incomplete"
assert_contains "$RUN_OUTPUT" "workflow_production-deploy_state=correct" \
  "all production-capable workflows are governed"
assert_contains "$RUN_OUTPUT" "workflow_oci-production-build_state=correct" \
  "OCI build workflow is governed"
assert_contains "$RUN_OUTPUT" "workflow_oci-live-data-rollout_state=correct" \
  "OCI data rollout workflow is governed"

new_case mature
mature_cutoff_date="$(epoch_date "$MATURE_CUTOFF_EPOCH")"
OBSERVATION="$STATE_DIR/billing-observations.env"
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" "$mature_cutoff_date" \
  "$((NOW_EPOCH - 5 * 86400))" \
  "$((NOW_EPOCH - 3 * 86400))" \
  "$((NOW_EPOCH - 1 * 86400))"
run_audit "$OBSERVATION" "$MATURE_CUTOFF_EPOCH"
assert_eq 0 "$RUN_RC" "mature clean audit exits zero"
assert_contains "$RUN_OUTPUT" "terminal_phase=AZURE_RETIRED" \
  "mature chained observations retire Azure"

new_case positive
run_audit "" "$MATURE_CUTOFF_EPOCH" "STUB_BILLING_MODE=positive"
assert_eq 1 "$RUN_RC" "positive post-cutoff cost is NO_GO"
assert_contains "$RUN_OUTPUT" "resource_phase=RESOURCE_RETIREMENT_COMPLETE" \
  "positive billing does not erase resource completion"
assert_contains "$RUN_OUTPUT" "billing_phase=unsafe_post_cutoff_cost" \
  "positive billing phase is explicit"

new_case billing-boundary
boundary_usage_date="$(epoch_date "$MATURE_CUTOFF_EPOCH")"
boundary_usage_date="${boundary_usage_date//-/}"
run_audit "" "$MATURE_CUTOFF_EPOCH" \
  "STUB_BILLING_MODE=positive" "STUB_USAGE_DATE=${boundary_usage_date}"
assert_eq 1 "$RUN_RC" "first full UTC billing day is included"
assert_contains "$RUN_OUTPUT" "billing_phase=unsafe_post_cutoff_cost" \
  "billing boundary has no intra-day attribution claim"

new_case negative
run_audit "" "$MATURE_CUTOFF_EPOCH" "STUB_BILLING_MODE=negative"
assert_eq 3 "$RUN_RC" "negative adjustment remains nonterminal"
assert_contains "$RUN_OUTPUT" "billing_phase=historical_adjustment_pending" \
  "negative adjustment is not clean evidence"

new_case http-status
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_CANONICAL_STATUS=503"
assert_eq 1 "$RUN_RC" "HTTP 503 is NO_GO"
assert_contains "$RUN_OUTPUT" "http_canonical=503" \
  "HTTP status remains deterministic"
assert_not_contains "$RUN_OUTPUT" "http_canonical=connection_error" \
  "HTTP status is not misclassified as transport failure"
assert_contains "$RUN_OUTPUT" "resource_retirement=false" \
  "HTTP residue clears the resource component flag"

new_case api-json
run_audit "" "$RECENT_CUTOFF_EPOCH" 'STUB_CANONICAL_API_BODY={"wrong":true}'
assert_eq 1 "$RUN_RC" "invalid canonical API health is NO_GO"
assert_contains "$RUN_OUTPUT" "http_canonical_api=invalid_json" \
  "public health requires a live JSON API route"

new_case bastion-cidr
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_BASTION_CIDR=0.0.0.0/0"
assert_eq 1 "$RUN_RC" "wrong Bastion CIDR is NO_GO"
assert_contains "$RUN_OUTPUT" "oci_bastion=provenance_mismatch" \
  "Bastion uses client CIDR allow list"

new_case instance-binding
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_OCI_INSTANCE_MISMATCH=1"
assert_eq 1 "$RUN_RC" "changed instance ID is NO_GO"
assert_contains "$RUN_OUTPUT" "oci_instance=provenance_mismatch" \
  "live instance binds to provenance"

new_case provenance-shape
apply_env_overrides "$PROVENANCE" "infrastructure_finalized=false"
run_audit "" "$RECENT_CUTOFF_EPOCH"
assert_eq 2 "$RUN_RC" "unfinished real-shape provenance is incomplete"
assert_contains "$RUN_OUTPUT" "provenance_not_finalized" \
  "infrastructure_finalized is the authoritative field"

new_case identity-scope
invalid_assignment="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/unrelated-rg/providers/Microsoft.Authorization/roleAssignments/66666666-6666-6666-6666-666666666666"
apply_env_overrides "$IDENTITY_STATE" "role_assignment_id_2=${invalid_assignment}"
write_attestation "$ATTESTATION" "$IDENTITY_STATE"
run_audit "" "$RECENT_CUTOFF_EPOCH"
assert_eq 2 "$RUN_RC" "substituted assignment parent is incomplete"
assert_contains "$RUN_OUTPUT" "identity_state=error reason=invalid_ra_syntax" \
  "assignment scope is exact after case normalization"

new_case secret-overflow
overflow='{"total_count":101,"secrets":[{"name":"unrelated"}]}'
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_MIGRATION_SECRETS=${overflow}"
assert_eq 2 "$RUN_RC" "unfetched secret pages are incomplete"
assert_contains "$RUN_OUTPUT" "temp_secret_oci_migration=incomplete_listing" \
  "secret listing completeness is enforced"

new_case secret-present
present_secret='{"total_count":1,"secrets":[{"name":"OCI_MIGRATION_AZURE_CREDENTIALS"}]}'
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_MIGRATION_SECRETS=${present_secret}"
assert_eq 1 "$RUN_RC" "temporary migration secret is NO_GO"
assert_contains "$RUN_OUTPUT" "temp_secret_oci_migration=present" \
  "temporary secret presence is explicit"
assert_contains "$RUN_OUTPUT" "identity_retirement=false" \
  "identity residue clears the identity component flag"

new_case retained-assignment
run_audit "" "$RECENT_CUTOFF_EPOCH" 'STUB_RETAINED_ASSIGNMENTS=[{"id":"still-assigned"}]'
assert_eq 1 "$RUN_RC" "retained identity assignment is NO_GO"
assert_contains "$RUN_OUTPUT" "retained_sp_assignments=nonzero" \
  "retained identity must remain unprivileged"

new_case pagination
run_audit "" "$MATURE_CUTOFF_EPOCH" "STUB_BILLING_MODE=paginated_reordered"
assert_eq 1 "$RUN_RC" "positive reordered page is NO_GO"
assert_contains "$RUN_OUTPUT" "billing_ActualCost_positive=1" \
  "each page is normalized before aggregation"

new_case cancellation
run_audit "" "$MATURE_CUTOFF_EPOCH" "STUB_BILLING_MODE=cancellation"
assert_eq 1 "$RUN_RC" "positive charge cannot net against refund"
assert_contains "$RUN_OUTPUT" "billing_phase=unsafe_post_cutoff_cost" \
  "item-level usage details preserve positive precedence"

new_case cross-subscription-nextlink
run_audit "" "$MATURE_CUTOFF_EPOCH" \
  "STUB_BILLING_MODE=cross_subscription_nextlink"
assert_eq 2 "$RUN_RC" "cross-subscription nextLink is incomplete"
assert_contains "$RUN_OUTPUT" "nextlink_invalid" \
  "billing continuation stays on the bound subscription endpoint"

new_case positive-with-malformed-peer
run_audit "" "$MATURE_CUTOFF_EPOCH" \
  "STUB_BILLING_MODE=positive_actual_bad_amortized"
assert_eq 1 "$RUN_RC" "known positive billing dominates malformed peer data"
assert_contains "$RUN_OUTPUT" "billing_phase=unsafe_post_cutoff_cost" \
  "known positive billing cannot be downgraded to incomplete"

new_case nextlink
run_audit "" "$MATURE_CUTOFF_EPOCH" "STUB_BILLING_MODE=bad_nextlink"
assert_eq 2 "$RUN_RC" "malformed nextLink is incomplete"
assert_contains "$RUN_OUTPUT" "nextlink_type_error" \
  "nextLink parse errors do not become end-of-pages"

new_case currency
run_audit "" "$MATURE_CUTOFF_EPOCH" "STUB_BILLING_MODE=mixed_currency"
assert_eq 2 "$RUN_RC" "mixed provider currency is incomplete"
assert_contains "$RUN_OUTPUT" "mixed_currency" \
  "mixed currency has no silent default"

new_case column-metadata
run_audit "" "$MATURE_CUTOFF_EPOCH" "STUB_BILLING_MODE=bad_columns"
assert_eq 2 "$RUN_RC" "wrong billing column metadata is incomplete"
assert_contains "$RUN_OUTPUT" "column_contract_error" \
  "billing column types are exact"

new_case observation-span
OBSERVATION="$STATE_DIR/billing-observations.env"
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$(epoch_date "$MATURE_CUTOFF_EPOCH")" \
  "$((NOW_EPOCH - 5 * 86400))" \
  "$((NOW_EPOCH - 3 * 86400))" \
  "$((NOW_EPOCH - 1 * 86400))"
apply_env_overrides "$OBSERVATION" "total_span_hours=95"
run_audit "$OBSERVATION" "$MATURE_CUTOFF_EPOCH"
assert_eq 2 "$RUN_RC" "tampered total span is incomplete"
assert_contains "$RUN_OUTPUT" "observation_span_mismatch" \
  "total span is recomputed"

new_case observation-digest
OBSERVATION="$STATE_DIR/billing-observations.env"
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$(epoch_date "$MATURE_CUTOFF_EPOCH")" \
  "$((NOW_EPOCH - 5 * 86400))" \
  "$((NOW_EPOCH - 3 * 86400))" \
  "$((NOW_EPOCH - 1 * 86400))"
apply_env_overrides "$OBSERVATION" "response_digests=invalid"
run_audit "$OBSERVATION" "$MATURE_CUTOFF_EPOCH"
assert_eq 2 "$RUN_RC" "malformed response digests are incomplete"
assert_contains "$RUN_OUTPUT" "observation_digests_invalid" \
  "digest pairs are exact and counted"

new_case observation-api
OBSERVATION="$STATE_DIR/billing-observations.env"
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$(epoch_date "$MATURE_CUTOFF_EPOCH")" \
  "$((NOW_EPOCH - 5 * 86400))" \
  "$((NOW_EPOCH - 3 * 86400))" \
  "$((NOW_EPOCH - 1 * 86400))"
apply_env_overrides "$OBSERVATION" "api_version=2022-10-01"
run_audit "$OBSERVATION" "$MATURE_CUTOFF_EPOCH"
assert_eq 2 "$RUN_RC" "wrong observation API version is incomplete"
assert_contains "$RUN_OUTPUT" "observation_api_mismatch" \
  "observation API version is exact"

new_case observation-usage-api
OBSERVATION="$STATE_DIR/billing-observations.env"
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$(epoch_date "$MATURE_CUTOFF_EPOCH")" \
  "$((NOW_EPOCH - 5 * 86400))" \
  "$((NOW_EPOCH - 3 * 86400))" \
  "$((NOW_EPOCH - 1 * 86400))"
apply_env_overrides "$OBSERVATION" "usage_api_version=2022-01-01"
run_audit "$OBSERVATION" "$MATURE_CUTOFF_EPOCH"
assert_eq 2 "$RUN_RC" "wrong usage-detail API version is incomplete"
assert_contains "$RUN_OUTPUT" "observation_usage_api_mismatch" \
  "usage-detail API version is exact"

new_case observation-stale-boundary
OBSERVATION="$STATE_DIR/billing-observations.env"
stale_cutoff_epoch=$((NOW_EPOCH - 12 * 86400))
write_observation "$OBSERVATION" "$stale_cutoff_epoch" \
  "$(epoch_date "$stale_cutoff_epoch")" \
  "$((NOW_EPOCH - 7 * 86400))" \
  "$((NOW_EPOCH - 5 * 86400))" \
  "$((NOW_EPOCH - 48 * 3600 - 1))"
run_audit "$OBSERVATION" "$stale_cutoff_epoch"
assert_eq 3 "$RUN_RC" "observation just over 48 hours remains pending"
assert_contains "$RUN_OUTPUT" "billing_observation=last_too_stale" \
  "freshness boundary compares exact seconds"

new_case observation-chain
OBSERVATION="$STATE_DIR/billing-observations.env"
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$(epoch_date "$MATURE_CUTOFF_EPOCH")" \
  "$((NOW_EPOCH - 5 * 86400))" \
  "$((NOW_EPOCH - 3 * 86400))" \
  "$((NOW_EPOCH - 1 * 86400))"
chain_before="$(betstan_billing_state_field "$OBSERVATION" observation_chain_sha256s)"
if [[ "$chain_before" == 0* ]]; then
  sed -i.bak \
    's/^observation_chain_sha256s=0/observation_chain_sha256s=1/' \
    "$OBSERVATION"
else
  sed -i.bak \
    's/^observation_chain_sha256s=./observation_chain_sha256s=0/' \
    "$OBSERVATION"
fi
rm -f "$OBSERVATION.bak"
chain_after="$(betstan_billing_state_field "$OBSERVATION" observation_chain_sha256s)"
if [[ "$chain_after" != "$chain_before" ]]; then
  pass "audit chain tamper fixture changes evidence"
else
  fail "audit chain tamper fixture changes evidence"
fi
run_audit "$OBSERVATION" "$MATURE_CUTOFF_EPOCH"
assert_eq 2 "$RUN_RC" "tampered observation chain is incomplete"
assert_contains "$RUN_OUTPUT" "observation_chain_mismatch" \
  "observation prefix integrity is enforced"

new_case too-few-windows
OBSERVATION="$STATE_DIR/billing-observations.env"
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$(epoch_date "$MATURE_CUTOFF_EPOCH")" \
  "$((NOW_EPOCH - 1 * 86400))"
run_audit "$OBSERVATION" "$MATURE_CUTOFF_EPOCH"
assert_eq 3 "$RUN_RC" "too few valid windows remain pending"
assert_contains "$RUN_OUTPUT" "terminal_phase=BILLING_INGESTION_PENDING" \
  "immature evidence is not incomplete"

new_case observation-currency-continuity
OBSERVATION="$STATE_DIR/billing-observations.env"
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$(epoch_date "$MATURE_CUTOFF_EPOCH")" \
  "$((NOW_EPOCH - 5 * 86400)):USD" \
  "$((NOW_EPOCH - 3 * 86400)):NO_ROWS" \
  "$((NOW_EPOCH - 1 * 86400)):NO_ROWS"
run_audit "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "STUB_BILLING_MODE=clean_eur"
assert_eq 2 "$RUN_RC" "live currency binds to established observation currency"
assert_contains "$RUN_OUTPUT" "billing_observation=currency_mismatch" \
  "trailing NO_ROWS cannot reset observation currency"

new_case inert-record
old_timestamp="$(epoch_iso "$((NOW_EPOCH - 3 * 86400))")"
queued_json="$(jq -cn \
  --arg timestamp "$old_timestamp" \
  --arg sha "1111111111111111111111111111111111111111" '{
    total_count:1,
    workflow_runs:[{
      id:123,
      created_at:$timestamp,
      updated_at:$timestamp,
      head_sha:$sha
    }]
  }')"
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_RECOVERY_QUEUED_RUNS=${queued_json}"
assert_eq 3 "$RUN_RC" "inert queued record remains billing-pending"
assert_contains "$RUN_OUTPUT" "workflow_oci-migration-recovery_queued_inert=1" \
  "inert provider artifact is reported"

new_case active-record
old_timestamp="$(epoch_iso "$((NOW_EPOCH - 3 * 86400))")"
master_sha="fedcba0987654321fedcba0987654321fedcba09"
queued_json="$(jq -cn \
  --arg timestamp "$old_timestamp" \
  --arg sha "$master_sha" '{
    total_count:1,
    workflow_runs:[{
      id:124,
      created_at:$timestamp,
      updated_at:$timestamp,
      head_sha:$sha
    }]
  }')"
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_RECOVERY_QUEUED_RUNS=${queued_json}"
assert_eq 1 "$RUN_RC" "current-provenance queued record is NO_GO"
assert_contains "$RUN_OUTPUT" "workflow_oci-migration-recovery_queued_active=1" \
  "active queued record is not classified inert"
assert_contains "$RUN_OUTPUT" "workflow_retirement=false" \
  "active workflow residue clears the workflow component flag"

new_case malformed-pending-deployments
old_timestamp="$(epoch_iso "$((NOW_EPOCH - 3 * 86400))")"
queued_json="$(jq -cn \
  --arg timestamp "$old_timestamp" \
  --arg sha "1111111111111111111111111111111111111111" '{
    total_count:1,
    workflow_runs:[{
      id:125,
      created_at:$timestamp,
      updated_at:$timestamp,
      head_sha:$sha
    }]
  }')"
run_audit "" "$RECENT_CUTOFF_EPOCH" \
  "STUB_RECOVERY_QUEUED_RUNS=${queued_json}" \
  "STUB_PENDING_DEPLOYMENTS=null"
assert_eq 2 "$RUN_RC" "non-array pending deployments are incomplete"
assert_contains "$RUN_OUTPUT" "workflow_oci-migration-recovery_deploys=parse_error" \
  "pending deployments require an explicit array"

new_case additional-workflow-run
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_AZURE_DEPLOY_IN_PROGRESS=1"
assert_eq 1 "$RUN_RC" "legacy production deploy run is NO_GO"
assert_contains "$RUN_OUTPUT" "workflow_production-deploy_in_progress=1" \
  "nonterminal checks cover all production-capable workflows"

new_case contract-corruption
apply_env_overrides "$ARTIFACT" "terminal_status=BROKEN"
run_audit "" "$RECENT_CUTOFF_EPOCH"
assert_eq 1 "$RUN_RC" "semantic migration corruption is NO_GO"
assert_contains "$RUN_OUTPUT" "migration_journal=contract_violation" \
  "real migration contract rejects corruption"
assert_contains "$RUN_OUTPUT" "journal_verified=false" \
  "journal residue clears the journal component flag"

new_case azure-resource
resource_json='[{"name":"betstan-aks","type":"Microsoft.ContainerService/managedClusters","resourceGroup":"unrelated-rg"}]'
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_AZ_RESOURCES=${resource_json}"
assert_eq 1 "$RUN_RC" "subscription-wide BetStan orphan is NO_GO"
assert_contains "$RUN_OUTPUT" "azure_orphan_resources=1" \
  "subscription-wide orphan scan is active"

new_case active-session
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_SESSION_STATE=ACTIVE"
assert_eq 1 "$RUN_RC" "active Bastion session is NO_GO"
assert_contains "$RUN_OUTPUT" "oci_bastion_active_sessions=1" \
  "Bastion activity is explicit"

new_case provider-leak
run_audit "" "$RECENT_CUTOFF_EPOCH" "STUB_AZ_FAIL=1"
assert_eq 2 "$RUN_RC" "provider error is incomplete"
assert_not_contains "$RUN_OUTPUT" "PROVIDER_SECRET_MARKER" \
  "provider stderr is not leaked"

new_case subscription-binding
billing_called="$STATE_DIR/billing-called"
run_audit "" "$MATURE_CUTOFF_EPOCH" \
  "STUB_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000000" \
  "STUB_BILLING_CALLED_FILE=${billing_called}"
assert_eq 2 "$RUN_RC" "wrong live subscription is incomplete"
assert_contains "$RUN_OUTPUT" "billing=subscription_not_bound" \
  "billing independently requires a verified subscription binding"
if [[ ! -e "$billing_called" ]]; then
  pass "wrong subscription performs no Cost Management query"
else
  fail "wrong subscription performs no Cost Management query"
fi

new_case concurrent
first_output="$CASE_DIR/first.out"
second_output="$CASE_DIR/second.out"
(
  run_audit "" "$RECENT_CUTOFF_EPOCH"
  printf '%s\n' "$RUN_OUTPUT"
  exit "$RUN_RC"
) >"$first_output" 2>&1 &
first_pid=$!
(
  run_audit "" "$RECENT_CUTOFF_EPOCH"
  printf '%s\n' "$RUN_OUTPUT"
  exit "$RUN_RC"
) >"$second_output" 2>&1 &
second_pid=$!
first_rc=0
second_rc=0
if wait "$first_pid"; then
  first_rc=0
else
  first_rc=$?
fi
if wait "$second_pid"; then
  second_rc=0
else
  second_rc=$?
fi
assert_eq 3 "$first_rc" "first concurrent audit remains billing-pending"
assert_eq 3 "$second_rc" "second concurrent audit remains billing-pending"
assert_contains "$(cat "$first_output")" "resource_phase=RESOURCE_RETIREMENT_COMPLETE" \
  "first concurrent audit retains its state"
assert_contains "$(cat "$second_output")" "resource_phase=RESOURCE_RETIREMENT_COMPLETE" \
  "second concurrent audit retains its state"

printf 'terminal_audit_tests passed=%d failed=%d total=%d\n' \
  "$passed" "$failed" "$((passed + failed))"
[[ "$failed" -eq 0 ]]
