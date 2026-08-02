#!/usr/bin/env bash

CAPACITY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$CAPACITY_SCRIPT_DIR/lib.sh"

OCI_CAPACITY_MANAGED_BY="oci-capacity-acquire"
OCI_CAPACITY_CONTRACT_VERSION="1"

oci_capacity_require_contract() {
  oci_assert_repository_root
  oci_require_command jq
  oci_require_command python3
  oci_require_vars \
    OCI_REGION OCI_TENANCY_OCID OCI_COMPARTMENT_OCID OCI_COMPARTMENT_NAME \
    OCI_CAPACITY_QUOTA_NAME OCI_VCN_NAME OCI_K3S_INSTANCE_NAME \
    OCI_K3S_IMAGE_OCID OCI_K3S_VERSION OCI_K3S_BINARY_SHA256 \
    OCI_K3S_SSH_PUBLIC_KEY OCI_NODE_SHAPE OCI_A1_OCPUS \
    OCI_A1_MEMORY_GB OCI_A1_MEMORY_PROFILES OCI_BOOT_VOLUME_GB \
    OCI_EXPECTED_MONTHLY_COST SOURCE_SHA
  oci_require_value OCI_NODE_SHAPE VM.Standard.A1.Flex
  oci_require_value OCI_A1_OCPUS 2
  oci_require_value OCI_A1_MEMORY_GB 12
  oci_require_value OCI_BOOT_VOLUME_GB 50
  oci_require_value OCI_EXPECTED_MONTHLY_COST 0
  [[ "$(oci_runtime_mode)" == "k3s" ]] ||
    oci_die "capacity acquisition requires OCI_RUNTIME_MODE=k3s"
  [[ "$OCI_REGION" == "eu-frankfurt-1" ]] ||
    oci_die "capacity acquisition is restricted to the verified home region"
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    oci_die "SOURCE_SHA must be a complete lowercase commit SHA"
  [[ "$OCI_K3S_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$ ]] ||
    oci_die "OCI_K3S_VERSION must be a pinned k3s release"
  [[ "$OCI_K3S_BINARY_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    oci_die "OCI_K3S_BINARY_SHA256 must be a lowercase SHA256"
  [[ "$OCI_K3S_SSH_PUBLIC_KEY" =~ ^ssh-(ed25519|rsa)[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]] ||
    oci_die "OCI_K3S_SSH_PUBLIC_KEY must be an SSH public key"
  oci_require_ocid OCI_TENANCY_OCID
  oci_require_ocid OCI_COMPARTMENT_OCID
  oci_require_ocid OCI_K3S_IMAGE_OCID
  oci_capacity_profiles_json >/dev/null
}

oci_capacity_profiles_json() {
  python3 - "$OCI_A1_MEMORY_PROFILES" <<'PY'
import json
import sys

allowed = {6, 8, 10, 12}
result = []
for raw in sys.argv[1].split(","):
    value = raw.strip()
    if not value or not value.isdigit():
        raise SystemExit("OCI_A1_MEMORY_PROFILES must be a comma-separated integer list")
    memory = int(value)
    if memory not in allowed:
        raise SystemExit(f"unvalidated A1 memory profile: {memory}")
    if memory not in result:
        result.append(memory)
if not result or result[0] != 12:
    raise SystemExit("the A1 profile priority must begin with 12 GB")
print(json.dumps(result, separators=(",", ":")))
PY
}

oci_capacity_tags() {
  jq -cn \
    --arg source_sha "$SOURCE_SHA" \
    --arg run_id "${OCI_CAPACITY_RUN_ID:-local}" \
    --arg managed_by "$OCI_CAPACITY_MANAGED_BY" \
    --arg contract "$OCI_CAPACITY_CONTRACT_VERSION" \
    '{
      "betstan-managed": "true",
      "betstan-managed-by": $managed_by,
      "betstan-runtime": "k3s",
      "betstan-contract": $contract,
      "expected-monthly-cost": "0",
      "source-sha": $source_sha,
      "acquisition-run-id": $run_id
    }'
}

oci_capacity_managed_instances() {
  local instances
  instances="$(
    oci compute instance list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --all
  )"
  instances="$(oci_normalize_list_json "$instances")"
  jq --arg managed_by "$OCI_CAPACITY_MANAGED_BY" '
    {
      data: [
        .data[]?
        | select(."lifecycle-state" != "TERMINATED")
        | select(."freeform-tags"."betstan-managed-by" == $managed_by)
      ]
    }
  ' <<<"$instances"
}

oci_capacity_all_active_instances() {
  local instances
  instances="$(
    oci compute instance list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --all
  )"
  instances="$(oci_normalize_list_json "$instances")"
  jq '{data: [.data[]? | select(."lifecycle-state" != "TERMINATED")]}' <<<"$instances"
}

oci_capacity_validate_instance() {
  local instance_json="$1"
  local profiles_json
  profiles_json="$(oci_capacity_profiles_json)"
  jq -e \
    --arg name "$OCI_K3S_INSTANCE_NAME" \
    --arg image "$OCI_K3S_IMAGE_OCID" \
    --arg managed_by "$OCI_CAPACITY_MANAGED_BY" \
    --arg contract "$OCI_CAPACITY_CONTRACT_VERSION" \
    --argjson profiles "$profiles_json" '
      . as $instance |
      $instance.shape == "VM.Standard.A1.Flex" and
      $instance."display-name" == $name and
      $instance."image-id" == $image and
      ($instance."shape-config".ocpus == 2) and
      ($profiles | index($instance."shape-config"."memory-in-gbs")) != null and
      ($instance."lifecycle-state" == "PROVISIONING" or
       $instance."lifecycle-state" == "STARTING" or
       $instance."lifecycle-state" == "RUNNING") and
      $instance."freeform-tags"."betstan-managed" == "true" and
      $instance."freeform-tags"."betstan-managed-by" == $managed_by and
      $instance."freeform-tags"."betstan-runtime" == "k3s" and
      $instance."freeform-tags"."betstan-contract" == $contract and
      $instance."freeform-tags"."expected-monthly-cost" == "0"
    ' <<<"$instance_json" >/dev/null ||
    oci_die "managed capacity instance violates the approved A1 contract"
}

oci_capacity_require_singleton() {
  local active managed active_count managed_count
  active="$(oci_capacity_all_active_instances)"
  managed="$(oci_capacity_managed_instances)"
  active_count="$(jq '.data | length' <<<"$active")"
  managed_count="$(jq '.data | length' <<<"$managed")"
  [[ "$managed_count" -le 1 ]] ||
    oci_die "multiple managed capacity instances exist"
  [[ "$active_count" == "$managed_count" ]] ||
    oci_die "an unmanaged compute instance exists in the dedicated compartment"
  if [[ "$managed_count" == "1" ]]; then
    oci_capacity_validate_instance "$(jq '.data[0]' <<<"$managed")"
  fi
  printf '%s' "$managed_count"
}

oci_capacity_require_home_region() {
  local home
  home="$(
    oci iam region-subscription list \
      --query 'data[?"is-home-region" == `true`]."region-name" | [0]' \
      --raw-output
  )"
  [[ "$home" == "$OCI_REGION" ]] ||
    oci_die "OCI_REGION is not the tenancy home region"
}

oci_capacity_require_quota() {
  local quotas quota_id quota statements total
  quotas="$(
    oci limits quota list \
      --compartment-id "$OCI_TENANCY_OCID" \
      --all
  )"
  quotas="$(oci_normalize_list_json "$quotas")"
  quota_id="$(
    jq -r --arg name "$OCI_CAPACITY_QUOTA_NAME" '
      [.data[]? | select(.name == $name and ."lifecycle-state" == "ACTIVE")] as $matches
      | if ($matches | length) == 1 then $matches[0].id else empty end
    ' <<<"$quotas"
  )"
  [[ -n "$quota_id" ]] ||
    oci_die "the exact active Always Free quota policy is missing"
  quota="$(oci limits quota get --quota-id "$quota_id")"
  statements="$(jq -c '.data.statements // []' <<<"$quota")"
  for required in \
    "zero compute quotas in compartment $OCI_COMPARTMENT_NAME" \
    "zero compute-core quotas in compartment $OCI_COMPARTMENT_NAME" \
    "zero compute-memory quotas in compartment $OCI_COMPARTMENT_NAME" \
    "zero block-storage quotas in compartment $OCI_COMPARTMENT_NAME" \
    "set compute-core quota standard-a1-core-regional-count to 2 in compartment $OCI_COMPARTMENT_NAME where request.region = $OCI_REGION" \
    "set compute-memory quota standard-a1-memory-regional-count to 12 in compartment $OCI_COMPARTMENT_NAME where request.region = $OCI_REGION" \
    "set block-storage quota volume-count to 2 in compartment $OCI_COMPARTMENT_NAME where request.region = $OCI_REGION" \
    "set block-storage quota total-storage-gb to 100 in compartment $OCI_COMPARTMENT_NAME where request.region = $OCI_REGION"; do
    jq -e --arg required "$required" 'index($required) != null' \
      <<<"$statements" >/dev/null ||
      oci_die "Always Free quota policy is missing a required statement"
  done

  for limit in standard-a1-core-regional-count standard-a1-memory-regional-count; do
    quota="$(
      oci limits resource-availability get \
        --service-name compute \
        --limit-name "$limit" \
        --compartment-id "$OCI_COMPARTMENT_OCID"
    )"
    total="$(
      jq -r '(.data.available // 0) + (.data.used // 0)' <<<"$quota"
    )"
    if [[ "$limit" == "standard-a1-core-regional-count" ]]; then
      [[ "$total" == "2" || "$total" == "2.0" ]] ||
        oci_die "effective regional A1 core quota is not exactly 2"
    else
      [[ "$total" == "12" || "$total" == "12.0" ]] ||
        oci_die "effective regional A1 memory quota is not exactly 12 GB"
    fi
  done
}

oci_capacity_single_id() {
  local json="$1"
  local name="$2"
  local count
  count="$(
    jq -r --arg name "$name" '
      [.data[]? | select(."display-name" == $name and
        (."lifecycle-state" // "") != "TERMINATED" and
        (."lifecycle-state" // "") != "DELETED")] | length
    ' <<<"$json"
  )"
  [[ "$count" == "1" ]] ||
    oci_die "expected exactly one prepared OCI resource named '$name'"
  jq -e --arg name "$name" '
    [.data[]? | select(."display-name" == $name and
      (."lifecycle-state" // "") != "TERMINATED" and
      (."lifecycle-state" // "") != "DELETED")][0]
      | ."freeform-tags"."betstan-managed" == "true"
      and ."freeform-tags".provider == "oci"
      and ."freeform-tags"."expected-monthly-cost" == "0"
  ' <<<"$json" >/dev/null ||
    oci_die "prepared OCI resource lacks the exact zero-cost tags: $name"
  jq -r --arg name "$name" '
    [.data[]? | select(."display-name" == $name and
      (."lifecycle-state" // "") != "TERMINATED" and
      (."lifecycle-state" // "") != "DELETED")][0].id
  ' <<<"$json"
}

oci_capacity_discover_network() {
  local vcns vcn_id subnets subnet_id nsgs nsg_id subnet
  vcns="$(
    oci network vcn list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --all
  )"
  vcns="$(oci_normalize_list_json "$vcns")"
  vcn_id="$(oci_capacity_single_id "$vcns" "$OCI_VCN_NAME")"

  subnets="$(
    oci network subnet list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --vcn-id "$vcn_id" \
      --all
  )"
  subnets="$(oci_normalize_list_json "$subnets")"
  subnet_id="$(
    oci_capacity_single_id "$subnets" "${OCI_VCN_NAME}-worker-public"
  )"
  subnet="$(oci network subnet get --subnet-id "$subnet_id")"
  jq -e '
    .data."availability-domain" == null and
    .data."prohibit-public-ip-on-vnic" == false and
    .data."lifecycle-state" == "AVAILABLE"
  ' <<<"$subnet" >/dev/null ||
    oci_die "prepared worker subnet must be regional, available, and public-IP capable"

  nsgs="$(
    oci network nsg list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --vcn-id "$vcn_id" \
      --all
  )"
  nsgs="$(oci_normalize_list_json "$nsgs")"
  nsg_id="$(
    oci_capacity_single_id "$nsgs" "${OCI_VCN_NAME}-worker-nsg"
  )"
  printf '%s\t%s\t%s\n' "$vcn_id" "$subnet_id" "$nsg_id"
}

oci_capacity_availability_domains() {
  local ads
  ads="$(
    oci iam availability-domain list \
      --compartment-id "$OCI_TENANCY_OCID"
  )"
  ads="$(oci_normalize_list_json "$ads")"
  jq -c '[.data[]?.name] | unique | sort' <<<"$ads"
}

oci_capacity_output() {
  local name="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$name" "$value" >> "$GITHUB_OUTPUT"
  fi
}
