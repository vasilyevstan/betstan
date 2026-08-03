#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

INVENTORY_MODE="${INVENTORY_MODE:-${1:-preflight}}"
OUTPUT_FILE="${OUTPUT_FILE:-}"
OCI_RUNTIME_MODE="$(oci_runtime_mode)"
[[ "$INVENTORY_MODE" == "preflight" || "$INVENTORY_MODE" == "complete" ]] ||
  oci_die "INVENTORY_MODE must be preflight or complete"
oci_require_cli_version
oci_require_command jq
oci_require_vars \
  OCI_COMPARTMENT_OCID OCI_EXPECTED_MONTHLY_COST \
  OCI_A1_OCPUS OCI_A1_MEMORY_GB OCI_LB_MIN_MBPS OCI_LB_MAX_MBPS \
  OCI_REGISTRY_MAX_BYTES OCI_IMAGE_PREFIX OCI_BOOT_VOLUME_GB OCI_MONGO_VOLUME_GB
oci_require_ocid OCI_COMPARTMENT_OCID

clusters="$(oci ce cluster list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
node_pools="$(oci ce node-pool list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
instances="$(oci compute instance list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
volumes="$(oci bv volume list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
boot_volumes="$(
  oci bv boot-volume list \
    --compartment-id "$OCI_COMPARTMENT_OCID" --all
)"
load_balancers="$(oci lb load-balancer list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
network_load_balancers="$(oci nlb network-load-balancer list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
nat_gateways="$(oci network nat-gateway list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
internet_gateways="$(oci network internet-gateway list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
service_gateways="$(oci network service-gateway list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
public_ips="$(
  oci network public-ip list \
    --scope REGION \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --all
)"
bastions="$(oci bastion bastion list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
repositories="$(oci artifacts container repository list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
buckets="$(oci os bucket list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
clusters="$(oci_normalize_list_json "$clusters")"
node_pools="$(oci_normalize_list_json "$node_pools")"
instances="$(oci_normalize_list_json "$instances")"
volumes="$(oci_normalize_list_json "$volumes")"
boot_volumes="$(oci_normalize_list_json "$boot_volumes")"
load_balancers="$(oci_normalize_list_json "$load_balancers")"
network_load_balancers="$(oci_normalize_list_json "$network_load_balancers" items)"
nat_gateways="$(oci_normalize_list_json "$nat_gateways")"
internet_gateways="$(oci_normalize_list_json "$internet_gateways")"
service_gateways="$(oci_normalize_list_json "$service_gateways")"
public_ips="$(oci_normalize_list_json "$public_ips")"
bastions="$(oci_normalize_list_json "$bastions")"
repositories="$(oci_normalize_list_json "$repositories" items)"
buckets="$(oci_normalize_list_json "$buckets")"
expected_repositories="$(
  jq -cn --arg prefix "$OCI_IMAGE_PREFIX" '[$prefix + "_images"]'
)"

inventory="$(
  jq -n \
    --argjson clusters "$clusters" \
    --argjson node_pools "$node_pools" \
    --argjson instances "$instances" \
    --argjson volumes "$volumes" \
    --argjson boot_volumes "$boot_volumes" \
    --argjson load_balancers "$load_balancers" \
    --argjson network_load_balancers "$network_load_balancers" \
    --argjson nat_gateways "$nat_gateways" \
    --argjson internet_gateways "$internet_gateways" \
    --argjson service_gateways "$service_gateways" \
    --argjson public_ips "$public_ips" \
    --argjson bastions "$bastions" \
    --argjson repositories "$repositories" \
    --argjson buckets "$buckets" \
    --argjson expected_repositories "$expected_repositories" \
    --arg mode "$INVENTORY_MODE" \
    --arg runtime_mode "$OCI_RUNTIME_MODE" \
    --argjson expected_cost "$OCI_EXPECTED_MONTHLY_COST" '
      {
        mode: $mode,
        runtime_mode: $runtime_mode,
        expected_monthly_cost: $expected_cost,
        clusters: [
          $clusters.data[]?
          | select(."lifecycle-state" != "DELETED")
          | {name, type, state: ."lifecycle-state", kubernetes_version: ."kubernetes-version"}
        ],
        node_pools: [
          $node_pools.data[]?
          | select(."lifecycle-state" != "DELETED")
          | {
              name,
              shape: ."node-shape",
              size: (."node-config-details".size // 0),
              ocpus: (."node-shape-config".ocpus // 0),
              memory_gb: (."node-shape-config"."memory-in-gbs" // 0),
              state: ."lifecycle-state"
            }
        ],
        instances: [
          $instances.data[]?
          | select(."lifecycle-state" != "TERMINATED")
          | {
              name: ."display-name",
              shape,
              ocpus: (."shape-config".ocpus // 0),
              memory_gb: (."shape-config"."memory-in-gbs" // 0),
              runtime: (."freeform-tags"."betstan-runtime" // ""),
              managed: (
                ."freeform-tags"["betstan-managed"] == "true" and
                ."freeform-tags".provider == "oci" and
                ."freeform-tags"["expected-monthly-cost"] == "0"
              ),
              state: ."lifecycle-state"
            }
        ],
        block_volumes: [
          $volumes.data[]?
          | select(."lifecycle-state" != "TERMINATED")
          | {
              name: ."display-name",
              size_gb: ."size-in-gbs",
              vpus_per_gb: ."vpus-per-gb",
              state: ."lifecycle-state"
            }
        ],
        boot_volumes: [
          $boot_volumes.data[]?
          | select(."lifecycle-state" != "TERMINATED")
          | {
              name: ."display-name",
              size_gb: ."size-in-gbs",
              vpus_per_gb: ."vpus-per-gb",
              state: ."lifecycle-state"
            }
        ],
        load_balancers: [
          $load_balancers.data[]?
          | select(."lifecycle-state" != "DELETED")
          | {
              name: ."display-name",
              shape: ."shape-name",
              minimum_mbps: (."shape-details"."minimum-bandwidth-in-mbps" // 0),
              maximum_mbps: (."shape-details"."maximum-bandwidth-in-mbps" // 0),
              managed: (
                ."freeform-tags"["betstan-managed"] == "true" and
                ."freeform-tags".provider == "oci" and
                ."freeform-tags"["expected-monthly-cost"] == "0"
              ),
              state: ."lifecycle-state"
            }
        ],
        network_load_balancer_count: ([
          $network_load_balancers.data.items[]?
          | select(."lifecycle-state" != "DELETED")
        ] | length),
        nat_gateway_count: ([
          $nat_gateways.data[]? | select(."lifecycle-state" != "TERMINATED")
        ] | length),
        internet_gateway_count: ([
          $internet_gateways.data[]? | select(."lifecycle-state" != "TERMINATED")
        ] | length),
        service_gateway_count: ([
          $service_gateways.data[]? | select(."lifecycle-state" != "TERMINATED")
        ] | length),
        reserved_public_ips: [
          $public_ips.data[]?
          | select(."lifecycle-state" != "TERMINATED")
          | {
              lifetime,
              assigned: (."assigned-entity-id" != null),
              scope
            }
        ],
        bastions: [
          $bastions.data[]?
          | select(."lifecycle-state" != "DELETED")
          | {
              name,
              state: ."lifecycle-state",
              managed: (
                ."freeform-tags"["betstan-managed"] == "true" and
                ."freeform-tags".provider == "oci" and
                ."freeform-tags"["expected-monthly-cost"] == "0"
              )
            }
        ],
        registry_repositories: [
          $repositories.data.items[]?
          | {
              name: ."display-name",
              image_count: ."image-count",
              layer_count: ."layer-count",
              layers_size_bytes: ."layers-size-in-bytes",
              public: ."is-public",
              immutable: ."is-immutable"
            }
        ],
        registry_layers_size_bytes: ([
          $repositories.data.items[]? | ."layers-size-in-bytes"
        ] | add // 0),
        registry_measurement_complete: (
          [$repositories.data.items[]? | (."layers-size-in-bytes" | type)] |
          all(. == "number")
        ),
        expected_registry_repositories: $expected_repositories,
        object_storage_buckets: [
          $buckets.data[]? | {name, storage_tier: ."storage-tier"}
        ]
      }
    '
)"

jq -e --argjson ocpus "$OCI_A1_OCPUS" --argjson memory "$OCI_A1_MEMORY_GB" \
  --argjson lb_min "$OCI_LB_MIN_MBPS" --argjson lb_max "$OCI_LB_MAX_MBPS" \
  --argjson boot_vpus "$OCI_BOOT_VOLUME_VPUS_PER_GB" \
  --argjson registry_max "$OCI_REGISTRY_MAX_BYTES" '
    .expected_monthly_cost == 0 and
    .nat_gateway_count == 0 and
    .service_gateway_count == 0 and
    .internet_gateway_count <= 1 and
    (.reserved_public_ips | length) == 0 and
    .network_load_balancer_count == 0 and
    ([.clusters[] | select(.type != "BASIC_CLUSTER")] | length) == 0 and
    ([.node_pools[] | select(
      .shape != "VM.Standard.A1.Flex" or .size != 1 or
      .ocpus != $ocpus or .memory_gb != $memory
    )] | length) == 0 and
    ([.instances[] | select(
      .shape != "VM.Standard.A1.Flex" or
      .ocpus != $ocpus or .memory_gb != $memory
    )] | length) == 0 and
    ([.block_volumes[] | select(.vpus_per_gb != 0)] | length) == 0 and
    ([.boot_volumes[] | select(.vpus_per_gb != $boot_vpus)] | length) == 0 and
    (.load_balancers | length) <= 1 and
    ([.load_balancers[] | select(
      .shape != "flexible" or
      .managed != true or
      .minimum_mbps != $lb_min or .maximum_mbps != $lb_max
    )] | length) == 0 and
    (([.block_volumes[].size_gb] | add // 0) +
     ([.boot_volumes[].size_gb] | add // 0)) <= 200 and
    .registry_measurement_complete == true and
    .registry_layers_size_bytes <= $registry_max and
    ([.registry_repositories[].name] | sort) ==
      (.expected_registry_repositories | sort) and
    ([.registry_repositories[] | select(.image_count != 9)] | length) == 0 and
    ([.registry_repositories[] | select(
      .public != false or (.immutable != true and .immutable != null)
    )] | length) == 0 and
    (.object_storage_buckets | length) == 0
  ' <<<"$inventory" >/dev/null ||
  oci_die "OCI inventory violates the approved zero-cost allowlist"

if [[ "$OCI_RUNTIME_MODE" == "k3s" ]]; then
  jq -e '
    (.clusters | length) == 0 and
    (.node_pools | length) == 0 and
    ([.instances[] | select(
      .runtime != "k3s" or .managed != true
    )] | length) == 0 and
    ([.bastions[] | select(.managed != true)] | length) == 0 and
    (.bastions | length) <= 1
  ' <<<"$inventory" >/dev/null ||
    oci_die "OCI inventory mixes OKE and direct-k3s resources"
else
  jq -e '
    ([.instances[] | select(.runtime == "k3s")] | length) == 0 and
    (.bastions | length) == 0
  ' <<<"$inventory" >/dev/null ||
    oci_die "OCI inventory mixes direct-k3s resources into OKE mode"
fi

if [[ "$INVENTORY_MODE" == "complete" ]]; then
  if [[ "$OCI_RUNTIME_MODE" == "k3s" ]]; then
    jq -e --argjson boot "$OCI_BOOT_VOLUME_GB" --argjson mongo "$OCI_MONGO_VOLUME_GB" '
      (.clusters | length) == 0 and
      (.node_pools | length) == 0 and
      (.instances | length) == 1 and
      .instances[0].runtime == "k3s" and
      .instances[0].managed == true and
      (.block_volumes | length) == 1 and
      .block_volumes[0].size_gb == $mongo and
      (.boot_volumes | length) == 1 and
      .boot_volumes[0].size_gb == $boot and
      (.load_balancers | length) == 1
      and (.bastions | length) == 1
    ' <<<"$inventory" >/dev/null ||
      oci_die "OCI k3s inventory is incomplete or contains an unexpected resource count"
  else
    jq -e --argjson boot "$OCI_BOOT_VOLUME_GB" --argjson mongo "$OCI_MONGO_VOLUME_GB" '
      (.clusters | length) == 1 and
      (.node_pools | length) == 1 and
      (.instances | length) == 1 and
      (.block_volumes | length) == 1 and
      .block_volumes[0].size_gb == $mongo and
      (.boot_volumes | length) == 1 and
      .boot_volumes[0].size_gb == $boot and
      (.load_balancers | length) == 1
    ' <<<"$inventory" >/dev/null ||
      oci_die "OCI OKE inventory is incomplete or contains an unexpected resource count"
  fi
fi

if [[ -n "$OUTPUT_FILE" ]]; then
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  jq -S . <<<"$inventory" > "$OUTPUT_FILE"
else
  jq -S . <<<"$inventory"
fi
