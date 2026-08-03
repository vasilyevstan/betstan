#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=capacity-common.sh
source "$SCRIPT_DIR/capacity-common.sh"

MODE="${1:-check}"
PROVENANCE_DIR="${PROVENANCE_DIR:-$OCI_ROOT_DIR/artifacts/oci-capacity}"
PROVENANCE_FILE="$PROVENANCE_DIR/provenance.env"
INVENTORY_FILE="$PROVENANCE_DIR/inventory.json"

[[ "$MODE" == "check" || "$MODE" == "record" || "$MODE" == "cleanup" ]] ||
  oci_die "usage: reconcile-capacity.sh [check|record|cleanup]"

oci_capacity_require_contract
oci_require_cli_version
oci_capacity_require_home_region
oci_capacity_require_quota

cleanup_orphaned_boot_volumes() {
  local ads ad volumes attachments attached_ids volume_id state
  ads="$(oci_capacity_availability_domains)"
  while IFS= read -r ad; do
    volumes="$(
      oci bv boot-volume list \
        --compartment-id "$OCI_COMPARTMENT_OCID" \
        --availability-domain "$ad" \
        --all
    )"
    volumes="$(oci_normalize_list_json "$volumes")"
    attachments="$(
      oci compute boot-volume-attachment list \
        --compartment-id "$OCI_COMPARTMENT_OCID" \
        --availability-domain "$ad" \
        --all
    )"
    attachments="$(oci_normalize_list_json "$attachments")"
    attached_ids="$(
      jq -c '[
        .data[]?
        | select(."lifecycle-state" != "DETACHED")
        | ."boot-volume-id"
      ]' <<<"$attachments"
    )"
    while IFS=$'\t' read -r volume_id state; do
      [[ -n "$volume_id" ]] || continue
      jq -e --arg id "$volume_id" 'index($id) == null' \
        <<<"$attached_ids" >/dev/null || continue
      [[ "$state" == "AVAILABLE" || "$state" == "FAULTY" ]] || continue
      oci bv boot-volume delete \
        --boot-volume-id "$volume_id" \
        --force >/dev/null
      oci_log "deleted_orphaned_managed_boot_volume=1"
    done < <(
      jq -r --arg managed_by "$OCI_CAPACITY_MANAGED_BY" '
        .data[]?
        | select(."freeform-tags"."betstan-managed-by" == $managed_by)
        | [.id, ."lifecycle-state"] | @tsv
      ' <<<"$volumes"
    )
  done < <(jq -r '.[]' <<<"$ads")
}

record_instance() {
  local managed instance instance_id state network vcn_id subnet_id nsg_id
  local attachments attachment_count boot_volume_id boot_volume
  local vnic_attachments vnic_attachment_count vnic_id vnic public_ip private_ip
  local tags merged_tags live_tags live_boot_tags
  local instance_fingerprint memory_gb boot_gb
  local boot_vpus ad target_ssh_public_key_sha256
  local live_target_ssh_public_key_sha256

  managed="$(oci_capacity_managed_instances)"
  [[ "$(jq '.data | length' <<<"$managed")" == "1" ]] ||
    oci_die "record mode requires exactly one managed capacity instance"
  instance="$(jq '.data[0]' <<<"$managed")"
  oci_capacity_validate_instance "$instance"
  instance_id="$(jq -r '.id' <<<"$instance")"
  state="$(jq -r '."lifecycle-state"' <<<"$instance")"
  if [[ "$state" != "RUNNING" ]]; then
    oci compute instance get \
      --instance-id "$instance_id" \
      --wait-for-state RUNNING \
      --max-wait-seconds 900 >/dev/null ||
      oci_die "managed A1 instance did not reach RUNNING"
  fi
  instance="$(oci compute instance get --instance-id "$instance_id" --query data)"
  oci_capacity_validate_instance "$instance"
  target_ssh_public_key_sha256="$(
    oci_ssh_ed25519_public_key_sha256 "$OCI_K3S_SSH_PUBLIC_KEY"
  )"
  live_target_ssh_public_key_sha256="$(
    oci_ssh_ed25519_public_key_sha256 "$(
      jq -r '.metadata.ssh_authorized_keys // empty' <<<"$instance"
    )"
  )"
  [[ "$live_target_ssh_public_key_sha256" == \
     "$target_ssh_public_key_sha256" ]] ||
    oci_die "managed instance target SSH key differs from acquisition configuration"

  network="$(oci_capacity_discover_network)"
  IFS=$'\t' read -r vcn_id subnet_id nsg_id <<<"$network"
  ad="$(jq -r '."availability-domain"' <<<"$instance")"

  attachments="$(
    oci compute boot-volume-attachment list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --availability-domain "$ad" \
      --instance-id "$instance_id" \
      --all
  )"
  attachments="$(oci_normalize_list_json "$attachments")"
  attachment_count="$(
    jq '[.data[]? | select(."lifecycle-state" != "DETACHED")] | length' \
      <<<"$attachments"
  )"
  [[ "$attachment_count" == "1" ]] ||
    oci_die "managed instance must have exactly one boot volume"
  boot_volume_id="$(
    jq -r '[.data[]? | select(."lifecycle-state" != "DETACHED")][0]."boot-volume-id"' \
      <<<"$attachments"
  )"
  boot_volume="$(oci bv boot-volume get --boot-volume-id "$boot_volume_id")"
  boot_gb="$(jq -r '.data."size-in-gbs"' <<<"$boot_volume")"
  boot_vpus="$(jq -r '.data."vpus-per-gb"' <<<"$boot_volume")"
  [[ "$boot_gb" == "$OCI_BOOT_VOLUME_GB" ]] ||
    oci_die "managed instance boot volume violates the 50 GB contract"
  [[ "$boot_vpus" == "$OCI_BOOT_VOLUME_VPUS_PER_GB" ]] ||
    oci_die "managed instance boot volume violates the Balanced performance contract"
  tags="$(oci_capacity_tags)"
  merged_tags="$(
    jq -c --argjson required "$tags" '."freeform-tags" + $required' \
      <<<"$instance"
  )"
  oci compute instance update \
    --instance-id "$instance_id" \
    --freeform-tags "$merged_tags" \
    --force \
    --wait-for-state RUNNING \
    --max-wait-seconds 300 >/dev/null
  live_tags="$(
    oci compute instance get \
      --instance-id "$instance_id" \
      --query 'data."freeform-tags"' \
      --output json
  )"
  jq -e --argjson expected "$tags" '
    . as $actual
    | ($expected | to_entries)
    | all(.[]; $actual[.key] == .value)
  ' <<<"$live_tags" >/dev/null ||
    oci_die "managed instance tags do not match the current acquisition contract"
  if ! jq -e --argjson expected "$tags" '
      .data."freeform-tags" as $actual
      | ($expected | to_entries)
      | all(.[]; $actual[.key] == .value)
    ' <<<"$boot_volume" >/dev/null; then
    oci bv boot-volume update \
      --boot-volume-id "$boot_volume_id" \
      --freeform-tags "$tags" \
      --force >/dev/null
  fi
  live_boot_tags="$(
    oci bv boot-volume get \
      --boot-volume-id "$boot_volume_id" \
      --query 'data."freeform-tags"' \
      --output json
  )"
  jq -e --argjson expected "$tags" '
    . as $actual
    | ($expected | to_entries)
    | all(.[]; $actual[.key] == .value)
  ' <<<"$live_boot_tags" >/dev/null ||
    oci_die "managed boot volume tags do not match the current acquisition contract"

  vnic_attachments="$(
    oci compute vnic-attachment list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --instance-id "$instance_id" \
      --all
  )"
  vnic_attachments="$(oci_normalize_list_json "$vnic_attachments")"
  vnic_attachment_count="$(
    jq '[.data[]? | select(."lifecycle-state" == "ATTACHED")] | length' \
      <<<"$vnic_attachments"
  )"
  [[ "$vnic_attachment_count" == "1" ]] ||
    oci_die "managed instance must have exactly one attached VNIC"
  vnic_id="$(
    jq -r '[.data[]? | select(."lifecycle-state" == "ATTACHED")][0]."vnic-id"' \
      <<<"$vnic_attachments"
  )"
  vnic="$(oci network vnic get --vnic-id "$vnic_id")"
  jq -e \
    --arg subnet "$subnet_id" \
    --arg nsg "$nsg_id" '
      .data."subnet-id" == $subnet and
      (.data."nsg-ids" | index($nsg)) != null and
      .data."is-primary" == true
    ' <<<"$vnic" >/dev/null ||
    oci_die "managed instance VNIC differs from the prepared network contract"
  public_ip="$(jq -r '.data."public-ip" // empty' <<<"$vnic")"
  private_ip="$(jq -r '.data."private-ip" // empty' <<<"$vnic")"
  oci_validate_public_ipv4 "$public_ip" ||
    oci_die "managed instance does not have the required public IPv4"
  [[ "$private_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    oci_die "managed instance private IPv4 is invalid"

  memory_gb="$(
    jq -r '
      ."shape-config"."memory-in-gbs"
      | if type == "number" and . == floor
        then floor
        else error("instance memory is not an integer number of GiB")
        end
    ' <<<"$instance"
  )"
  instance_fingerprint="$(oci_fingerprint "$instance_id")"
  oci_prepare_private_dir "$PROVENANCE_DIR"
  {
    printf 'source_sha=%q\n' "$SOURCE_SHA"
    printf 'runtime_mode=%q\n' k3s
    printf 'region=%q\n' "$OCI_REGION"
    printf 'compartment_ocid=%q\n' "$OCI_COMPARTMENT_OCID"
    printf 'instance_ocid=%q\n' "$instance_id"
    printf 'instance_fingerprint=%q\n' "$instance_fingerprint"
    printf 'cluster_ocid=%q\n' "$instance_id"
    printf 'cluster_fingerprint=%q\n' "$instance_fingerprint"
    printf 'instance_nsg_ocid=%q\n' "$nsg_id"
    printf 'endpoint_nsg_ocid=%q\n' "$nsg_id"
    printf 'worker_nsg_ocid=%q\n' "$nsg_id"
    printf 'vcn_ocid=%q\n' "$vcn_id"
    printf 'worker_subnet_ocid=%q\n' "$subnet_id"
    printf 'subnet_ocid=%q\n' "$subnet_id"
    printf 'boot_volume_ocid=%q\n' "$boot_volume_id"
    printf 'vnic_ocid=%q\n' "$vnic_id"
    printf 'instance_public_ip=%q\n' "$public_ip"
    printf 'instance_private_ip=%q\n' "$private_ip"
    printf 'public_ip=%q\n' "$public_ip"
    printf 'private_ip=%q\n' "$private_ip"
    printf 'availability_domain=%q\n' "$ad"
    printf 'node_shape=%q\n' "$OCI_NODE_SHAPE"
    printf 'shape=%q\n' "$OCI_NODE_SHAPE"
    printf 'a1_ocpus=%q\n' "$OCI_A1_OCPUS"
    printf 'ocpus=%q\n' "$OCI_A1_OCPUS"
    printf 'a1_memory_gb=%q\n' "$memory_gb"
    printf 'memory_gb=%q\n' "$memory_gb"
    printf 'boot_volume_gb=%q\n' "$boot_gb"
    printf 'boot_volume_vpus_per_gb=%q\n' "$boot_vpus"
    printf 'node_image_ocid=%q\n' "$OCI_K3S_IMAGE_OCID"
    printf 'image_ocid=%q\n' "$OCI_K3S_IMAGE_OCID"
    printf 'k3s_version=%q\n' "$OCI_K3S_VERSION"
    printf 'k3s_binary_sha256=%q\n' "$OCI_K3S_BINARY_SHA256"
    printf 'target_ssh_public_key_sha256=%q\n' "$target_ssh_public_key_sha256"
    printf 'acquisition_run_id=%q\n' "${OCI_CAPACITY_RUN_ID:-local}"
    printf 'expected_monthly_cost=%q\n' 0
  } > "$PROVENANCE_FILE"
  chmod 600 "$PROVENANCE_FILE"

  jq -cn \
    --arg runtime k3s \
    --arg shape "$OCI_NODE_SHAPE" \
    --arg ad "$ad" \
    --arg state RUNNING \
    --argjson ocpus "$OCI_A1_OCPUS" \
    --argjson memory "$memory_gb" \
    --argjson boot "$boot_gb" \
    --argjson boot_vpus "$boot_vpus" \
    '{
      expected_monthly_cost: 0,
      runtime: $runtime,
      instance_count: 1,
      state: $state,
      shape: $shape,
      availability_domain: $ad,
      ocpus: $ocpus,
      memory_gb: $memory,
      boot_volume_count: 1,
      boot_volume_gb: $boot,
      boot_volume_vpus_per_gb: $boot_vpus
    }' > "$INVENTORY_FILE"
  chmod 600 "$INVENTORY_FILE"
  oci_capacity_output instance_acquired true
  oci_capacity_output instance_fingerprint "$instance_fingerprint"
  oci_log "capacity_reconciliation=PASS instance_count=1 runtime=k3s expected_monthly_cost=0"
}

case "$MODE" in
  cleanup)
    cleanup_orphaned_boot_volumes
    count="$(oci_capacity_require_singleton)"
    oci_log "capacity_cleanup=PASS instance_count=$count"
    ;;
  check)
    count="$(oci_capacity_require_singleton)"
    if [[ "$count" == "1" ]]; then
      oci_capacity_output instance_exists true
      oci_log "capacity_reconciliation=EXISTS instance_count=1"
    else
      oci_capacity_output instance_exists false
      oci_log "capacity_reconciliation=EMPTY instance_count=0"
    fi
    ;;
  record)
    oci_capacity_require_singleton >/dev/null
    record_instance
    ;;
esac
