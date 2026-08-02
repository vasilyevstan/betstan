#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

OFFLINE="${OFFLINE:-0}"
OCI_RUNTIME_MODE="$(oci_runtime_mode)"
if [[ "${1:-}" == "--offline" ]]; then
  OFFLINE=1
fi

oci_assert_repository_root
oci_require_command jq
oci_require_command python3

oci_require_vars \
  OCI_A1_OCPUS OCI_A1_MEMORY_GB OCI_BOOT_VOLUME_GB OCI_MONGO_VOLUME_GB \
  OCI_LB_MIN_MBPS OCI_LB_MAX_MBPS OCI_EXPECTED_MONTHLY_COST \
  OCI_MEMORY_MAX_PERCENT OCI_DISK_MAX_PERCENT OCI_NODE_SHAPE \
  OCI_REGISTRY_MAX_BYTES
oci_require_value OCI_NODE_SHAPE VM.Standard.A1.Flex
oci_require_value OCI_A1_OCPUS 2
oci_require_value OCI_A1_MEMORY_GB 12
oci_require_value OCI_MONGO_VOLUME_GB 50
oci_require_value OCI_LB_MIN_MBPS 10
oci_require_value OCI_LB_MAX_MBPS 10
oci_require_value OCI_EXPECTED_MONTHLY_COST 0
oci_require_value OCI_REGISTRY_MAX_BYTES 500000000
oci_require_value OCI_MEMORY_MAX_PERCENT 70
oci_require_value OCI_DISK_MAX_PERCENT 70

oci_is_positive_int "$OCI_BOOT_VOLUME_GB" ||
  oci_die "OCI_BOOT_VOLUME_GB must be a positive integer"
(( OCI_BOOT_VOLUME_GB + OCI_MONGO_VOLUME_GB <= 200 )) ||
  oci_die "boot plus block storage exceeds the 200 GB Always Free allowance"

grep -Fq 'VM.Standard.A1.Flex' "$OCI_DIR/config/free-tier.env.example" ||
  oci_die "Free Tier shape contract is missing"
if [[ "$OCI_RUNTIME_MODE" == "oke" ]]; then
  grep -Fq 'type: LoadBalancer' "$OCI_DIR/helm/ingress-nginx-values.yaml" ||
    oci_die "OKE ingress-nginx must create the only LoadBalancer service"
  grep -Fq 'shape-flex-min: "10"' "$OCI_DIR/helm/ingress-nginx-values.yaml" ||
    oci_die "OKE ingress minimum bandwidth is not fixed at 10 Mbps"
  grep -Fq 'shape-flex-max: "10"' "$OCI_DIR/helm/ingress-nginx-values.yaml" ||
    oci_die "OKE ingress maximum bandwidth is not fixed at 10 Mbps"
else
  grep -Fq 'type: NodePort' "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml" ||
    oci_die "k3s ingress-nginx must use NodePort"
  grep -Fq 'http: 30080' "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml" ||
    oci_die "k3s ingress HTTP NodePort must be 30080"
  grep -Fq 'https: 30443' "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml" ||
    oci_die "k3s ingress HTTPS NodePort must be 30443"
  if grep -Fq 'type: LoadBalancer' "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml"; then
    oci_die "k3s Kubernetes manifests must not create a LoadBalancer service"
  fi
fi
if grep -R -n -E 'infra/k8s/legacy-mongo|legacy-mongo/' "$OCI_DIR/k8s" \
    --exclude-dir=fixtures >/dev/null; then
  oci_die "OCI overlay references rollback-only legacy Mongo"
fi

if [[ "$OFFLINE" == "1" ]]; then
  oci_log "oci_preflight=PASS mode=offline expected_monthly_cost=0"
  exit 0
fi

oci_require_cli_version
oci_require_vars \
  OCI_REGION OCI_TENANCY_OCID OCI_CI_USER_OCID OCI_CI_KEY_FINGERPRINT \
  OCI_COMPARTMENT_OCID OCI_COMPARTMENT_NAME
if [[ "$OCI_RUNTIME_MODE" == "oke" ]]; then
  oci_require_vars \
    OCI_AVAILABILITY_DOMAIN OCI_KUBERNETES_VERSION OCI_NODE_IMAGE_OCID \
    OCI_NODE_POOL_NAME
  runtime_image_ocid="$OCI_NODE_IMAGE_OCID"
else
  oci_require_vars OCI_K3S_IMAGE_OCID OCI_K3S_VERSION OCI_K3S_BINARY_SHA256
  [[ "$OCI_K3S_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$ ]] ||
    oci_die "OCI_K3S_VERSION must be an exact k3s release"
  [[ "$OCI_K3S_BINARY_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    oci_die "OCI_K3S_BINARY_SHA256 must be a SHA256 digest"
  runtime_image_ocid="$OCI_K3S_IMAGE_OCID"
fi
oci_require_vars \
  OCI_CLI_USER OCI_CLI_TENANCY OCI_CLI_FINGERPRINT OCI_CLI_KEY_CONTENT OCI_CLI_REGION
oci_require_ocid OCI_TENANCY_OCID
oci_require_ocid OCI_CI_USER_OCID
oci_require_ocid OCI_COMPARTMENT_OCID
oci_require_ocid runtime_image_ocid

[[ "$OCI_CLI_USER" == "$OCI_CI_USER_OCID" ]] ||
  oci_die "OCI_CLI_USER does not match OCI_CI_USER_OCID"
[[ "$OCI_CLI_TENANCY" == "$OCI_TENANCY_OCID" ]] ||
  oci_die "OCI_CLI_TENANCY does not match OCI_TENANCY_OCID"
[[ "$OCI_CLI_FINGERPRINT" == "$OCI_CI_KEY_FINGERPRINT" ]] ||
  oci_die "OCI_CLI_FINGERPRINT does not match OCI_CI_KEY_FINGERPRINT"
[[ "$OCI_CLI_REGION" == "$OCI_REGION" ]] ||
  oci_die "OCI_CLI_REGION does not match the approved home region"

user_id="$(oci iam user get --user-id "$OCI_CI_USER_OCID" --query 'data.id' --raw-output)"
[[ "$user_id" == "$OCI_CI_USER_OCID" ]] || oci_die "OCI CI identity verification failed"

compartment="$(
  oci iam compartment get --compartment-id "$OCI_COMPARTMENT_OCID"
)"
compartment_name="$(jq -r '.data.name // empty' <<<"$compartment")"
compartment_state="$(jq -r '.data["lifecycle-state"] // empty' <<<"$compartment")"
[[ "$compartment_name" == "$OCI_COMPARTMENT_NAME" && "$compartment_state" == "ACTIVE" ]] ||
  oci_die "OCI compartment identity or lifecycle state does not match"

home_region="$(
  oci iam region-subscription list \
    --query 'data[?"is-home-region" == `true`]."region-name" | [0]' --raw-output
)"
[[ "$home_region" == "$OCI_REGION" ]] ||
  oci_die "OCI_REGION is not the tenancy home region required by Always Free A1"

if [[ "$OCI_RUNTIME_MODE" == "oke" ]]; then
  core_limit_name="${OCI_A1_CORE_LIMIT_NAME:-standard-a1-core-count}"
  memory_limit_name="${OCI_A1_MEMORY_LIMIT_NAME:-standard-a1-memory-count}"
  existing_pools="$(
    oci ce node-pool list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --name "$OCI_NODE_POOL_NAME" --all
  )"
  existing_pools="$(oci_normalize_list_json "$existing_pools")"
  existing_pool_count="$(
    jq '[.data[]? | select(."lifecycle-state" != "DELETED")] | length' <<<"$existing_pools"
  )"
  [[ "$existing_pool_count" -le 1 ]] ||
    oci_die "multiple managed node pools share OCI_NODE_POOL_NAME"
  if [[ "$existing_pool_count" == "1" ]]; then
    jq -e '
      [.data[]? | select(."lifecycle-state" != "DELETED")] as $pools |
      $pools[0]."node-shape" == "VM.Standard.A1.Flex" and
      $pools[0]."node-config-details".size == 1 and
      $pools[0]."node-shape-config".ocpus == 2 and
      $pools[0]."node-shape-config"."memory-in-gbs" == 12
    ' <<<"$existing_pools" >/dev/null ||
      oci_die "existing managed node pool violates the approved A1 fit"
  else
    available_cores="$(
      oci limits resource-availability get \
        --service-name compute \
        --limit-name "$core_limit_name" \
        --compartment-id "$OCI_COMPARTMENT_OCID" \
        --availability-domain "$OCI_AVAILABILITY_DOMAIN" \
        --query 'data.available' --raw-output
    )" ||
      oci_die "unable to query A1 core availability; set OCI_A1_CORE_LIMIT_NAME if the provider name differs"
    available_memory="$(
      oci limits resource-availability get \
        --service-name compute \
        --limit-name "$memory_limit_name" \
        --compartment-id "$OCI_COMPARTMENT_OCID" \
        --availability-domain "$OCI_AVAILABILITY_DOMAIN" \
        --query 'data.available' --raw-output
    )" ||
      oci_die "unable to query A1 memory availability; set OCI_A1_MEMORY_LIMIT_NAME if the provider name differs"
    if ! python3 - "$available_cores" "$available_memory" <<'PY'
import decimal
import sys
if decimal.Decimal(sys.argv[1]) < 2 or decimal.Decimal(sys.argv[2]) < 12:
    raise SystemExit(1)
PY
    then
      oci_die "insufficient current A1 service-limit availability"
    fi
  fi

  capacity_status="$(
    oci compute compute-capacity-report create \
      --compartment-id "$OCI_TENANCY_OCID" \
      --availability-domain "$OCI_AVAILABILITY_DOMAIN" \
      --shape-availabilities \
        '[{"instanceShape":"VM.Standard.A1.Flex","instanceShapeConfig":{"ocpus":2,"memoryInGBs":12}}]' \
      --query 'data."shape-availabilities"[0]."availability-status"' \
      --raw-output
  )" || oci_die "unable to query current A1 host capacity"
  [[ "$capacity_status" == "AVAILABLE" ]] ||
    oci_die "A1 host capacity is unavailable in the approved availability domain"
else
  instances="$(
    oci compute instance list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --all
  )"
  instances="$(oci_normalize_list_json "$instances")"
  managed_instance_count="$(
    jq '
      [.data[]? | select(
        ."lifecycle-state" != "TERMINATED" and
        ."freeform-tags"."betstan-managed" == "true" and
        ."freeform-tags".provider == "oci" and
        ."freeform-tags"."betstan-runtime" == "k3s"
      )] | length
    ' <<<"$instances"
  )"
  [[ "$managed_instance_count" -le 1 ]] ||
    oci_die "multiple managed k3s instances exist"
  if [[ "$managed_instance_count" == "1" ]]; then
    jq -e '
      [.data[]? | select(
        ."lifecycle-state" != "TERMINATED" and
        ."freeform-tags"."betstan-runtime" == "k3s"
      )][0] |
      .shape == "VM.Standard.A1.Flex" and
      ."shape-config".ocpus == 2 and
      ."shape-config"."memory-in-gbs" == 12
    ' <<<"$instances" >/dev/null ||
      oci_die "existing k3s instance violates the approved A1 profile"
  fi
fi

image_shapes="$(oci compute image-shape-compatibility-entry list --image-id "$runtime_image_ocid" --all)"
image_shapes="$(oci_normalize_list_json "$image_shapes")"
jq -e '[.data[]? | select(.shape == "VM.Standard.A1.Flex")] | length == 1' \
  <<<"$image_shapes" >/dev/null ||
  oci_die "runtime image is not compatible with VM.Standard.A1.Flex"

INVENTORY_MODE=preflight "$SCRIPT_DIR/inventory.sh" >/dev/null
oci_log "oci_preflight=PASS mode=live home_region_verified=1 expected_monthly_cost=0"
