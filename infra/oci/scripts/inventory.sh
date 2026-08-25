#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# Inventory keeps legacy OCIR retirement evidence separate from forward
# application-registry authority.
APPLICATION_REGISTRY_PROVIDER="${APPLICATION_REGISTRY_PROVIDER:-ocir}"
if [[ "$APPLICATION_REGISTRY_PROVIDER" == "ghcr" ]]; then
  # shellcheck source=application-registry.sh
  source "$SCRIPT_DIR/application-registry.sh"
  application_registry_require_ghcr
elif [[ "$APPLICATION_REGISTRY_PROVIDER" != "ocir" ]]; then
  oci_die "APPLICATION_REGISTRY_PROVIDER must be ghcr or explicit legacy ocir"
fi

INVENTORY_MODE="${INVENTORY_MODE:-${1:-preflight}}"
OUTPUT_FILE="${OUTPUT_FILE:-}"
OCI_RUNTIME_MODE="$(oci_runtime_mode)"
REGISTRY_IMAGES_PER_GENERATION=9
REGISTRY_MAX_GENERATIONS=3
REGISTRY_SERVICES_JSON='[
  "auth", "bet", "backoffice", "client", "event", "gamemaster",
  "moderation", "resulting", "slip"
]'
[[ "$INVENTORY_MODE" == "preflight" || "$INVENTORY_MODE" == "complete" ]] ||
  oci_die "INVENTORY_MODE must be preflight or complete"
oci_require_cli_version
oci_require_command jq
oci_require_vars \
  OCI_COMPARTMENT_OCID OCI_EXPECTED_MONTHLY_COST \
  OCI_A1_OCPUS OCI_A1_MEMORY_GB OCI_LB_MIN_MBPS OCI_LB_MAX_MBPS \
  OCI_REGISTRY_MAX_BYTES OCI_IMAGE_PREFIX OCI_BOOT_VOLUME_GB OCI_MONGO_VOLUME_GB
oci_require_ocid OCI_COMPARTMENT_OCID

ghcr_evidence_valid=false
if [[ "$APPLICATION_REGISTRY_PROVIDER" == "ghcr" &&
      "$INVENTORY_MODE" == "complete" ]]; then
  APPLICATION_REGISTRY_EVIDENCE_FILE="${APPLICATION_REGISTRY_EVIDENCE_FILE:-}"
  [[ -f "$APPLICATION_REGISTRY_EVIDENCE_FILE" &&
     ! -L "$APPLICATION_REGISTRY_EVIDENCE_FILE" ]] ||
    oci_die "GHCR infrastructure finalization requires exact public-package validation evidence"
  awk -F= '
    $1 == "registry_provider" && $2 == "ghcr" { provider=1 }
    $1 == "registry_host" && $2 == "ghcr.io" { host=1 }
    $1 == "registry_repository" && $2 == "ghcr.io/vasilyevstan/betstan-images" { repository=1 }
    $1 == "package_visibility" && $2 == "public" { visibility=1 }
    $1 == "anonymous_pull" && $2 == "pass" { anonymous=1 }
    $1 == "build_first_attempt" && $2 == "true" { build=1 }
    END { exit(provider && host && repository && visibility && anonymous && build ? 0 : 1) }
  ' "$APPLICATION_REGISTRY_EVIDENCE_FILE" ||
    oci_die "GHCR evidence does not bind a successful public anonymous build"
  ghcr_evidence_valid=true
fi

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
if [[ "$APPLICATION_REGISTRY_PROVIDER" == "ocir" ]]; then
  images="$(
    oci artifacts container image list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --repository-name "${OCI_IMAGE_PREFIX}_images" \
      --all
  )"
  images="$(oci_normalize_list_json "$images" items)"
else
  images='{"data":{"items":[]}}'
fi
images="$(
  jq -c '{
    data: {
      items: [
        .data.items[]?
        | {
            "repository-name": ."repository-name",
            version,
            digest,
            "lifecycle-state": ."lifecycle-state"
          }
      ]
    }
  }' <<<"$images"
)"
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
    --argjson images "$images" \
    --argjson buckets "$buckets" \
    --argjson expected_repositories "$expected_repositories" \
    --argjson registry_images_per_generation "$REGISTRY_IMAGES_PER_GENERATION" \
    --argjson registry_max_generations "$REGISTRY_MAX_GENERATIONS" \
    --argjson registry_services "$REGISTRY_SERVICES_JSON" \
    --arg expected_repository "${OCI_IMAGE_PREFIX}_images" \
    --arg application_registry_provider "$APPLICATION_REGISTRY_PROVIDER" \
    --arg application_registry_repository "ghcr.io/vasilyevstan/betstan-images" \
    --argjson ghcr_evidence_valid "$ghcr_evidence_valid" \
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
              public_ip_count: ([
                ."ip-addresses"[]?
                | select(."is-public" == true)
              ] | length),
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
          | . as $public_ip
          | {
              lifetime,
              assigned: (."assigned-entity-id" != null),
              scope,
              load_balancer_owned: (
                ([
                  $load_balancers.data[]?
                  | select(."lifecycle-state" != "DELETED")
                  | ."ip-addresses"[]?
                  | select(."is-public" == true)
                  | ."ip-address"
                ] | index($public_ip."ip-address")) != null
              )
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
        registry_image_analysis: (
          [
            $images.data.items[]?
            | . as $image
            | (
                (
                  (.version // "")
                  | try capture(
                      "^oci-(?<service>auth|bet|backoffice|client|event|gamemaster|moderation|resulting|slip)-(?<source_sha>[0-9a-f]{40})$"
                    ) catch null
                ) // null
              ) as $tag
            | {
                valid: (
                  $tag != null and
                  ($image.digest // "" | test("^sha256:[0-9a-f]{64}$")) and
                  $image."repository-name" == $expected_repository and
                  $image."lifecycle-state" == "AVAILABLE"
                ),
                service: ($tag.service // ""),
                source_sha: ($tag.source_sha // ""),
                digest: ($image.digest // "")
              }
          ] as $rows
          | ($rows | map(select(.valid))) as $valid_rows
          | ($valid_rows | group_by(.source_sha)) as $tag_generations
          | ($valid_rows | unique_by(.digest)) as $unique_images
          | {
              listed_tag_count: ($rows | length),
              valid_tag_count: ($valid_rows | length),
              tag_generation_count: ($tag_generations | length),
              incomplete_tag_generation_count: ([
                $tag_generations[]
                | select(
                    length != $registry_images_per_generation or
                    ([.[].service] | unique | sort) !=
                      ($registry_services | sort) or
                    ([.[].digest] | unique | length) !=
                      $registry_images_per_generation
                  )
              ] | length),
              unique_image_count: ($unique_images | length),
              unique_generation_count: ([
                $tag_generations[]
                | sort_by(.service)
                | map(.service + "=" + .digest)
                | join("|")
              ] | unique | length),
              digest_service_conflict_count: ([
                ($valid_rows | group_by(.digest))[]
                | select(([.[].service] | unique | length) != 1)
              ] | length),
              unique_service_distribution_valid: (
                ($unique_images | length) > 0 and
                ([$unique_images[].service] | unique | sort) ==
                  ($registry_services | sort) and
                ([
                  ($unique_images | group_by(.service))[] | length
                ] | unique) == [
                  (($unique_images | length) / $registry_images_per_generation)
                ]
              )
            }
        ),
        registry_images_per_generation: $registry_images_per_generation,
        registry_max_generations: $registry_max_generations,
        expected_registry_repositories: $expected_repositories,
        application_registry: {
          provider: $application_registry_provider,
          repository: $application_registry_repository,
          public_anonymous: ($application_registry_provider == "ghcr"),
          validated_build_evidence: $ghcr_evidence_valid,
          ocir_application_repository_absent: (
            [$repositories.data.items[]? | ."display-name"] |
            index($expected_repository) == null
          )
        },
        object_storage_buckets: [
          $buckets.data[]? | {name, storage_tier: ."storage-tier"}
        ]
      }
    '
)"

jq -e --argjson ocpus "$OCI_A1_OCPUS" --argjson memory "$OCI_A1_MEMORY_GB" \
  --argjson lb_min "$OCI_LB_MIN_MBPS" --argjson lb_max "$OCI_LB_MAX_MBPS" \
  --argjson boot_vpus "$OCI_BOOT_VOLUME_VPUS_PER_GB" \
  --arg expected_repository "${OCI_IMAGE_PREFIX}_images" \
  --argjson registry_max "$OCI_REGISTRY_MAX_BYTES" \
  --argjson registry_images_per_generation "$REGISTRY_IMAGES_PER_GENERATION" \
  --argjson registry_max_generations "$REGISTRY_MAX_GENERATIONS" '
    .expected_monthly_cost == 0 and
    .nat_gateway_count == 0 and
    .service_gateway_count == 0 and
    .internet_gateway_count <= 1 and
    ([.reserved_public_ips[] | select(
      .lifetime != "RESERVED" or .assigned != true or
      .scope != "REGION" or .load_balancer_owned != true
    )] | length) == 0 and
    (.reserved_public_ips | length) ==
      ([.load_balancers[].public_ip_count] | add // 0) and
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
      .public_ip_count != 1 or
      .minimum_mbps != $lb_min or .maximum_mbps != $lb_max
    )] | length) == 0 and
    (([.block_volumes[].size_gb] | add // 0) +
     ([.boot_volumes[].size_gb] | add // 0)) <= 200 and
    (
      if .application_registry.provider == "ocir" then
        .registry_measurement_complete == true and
        .registry_layers_size_bytes <= $registry_max and
        ([.registry_repositories[].name] | sort) ==
          (.expected_registry_repositories | sort) and
        ([.registry_repositories[] | select(
          .image_count < $registry_images_per_generation or
          .image_count > ($registry_images_per_generation * $registry_max_generations) or
          (.image_count % $registry_images_per_generation) != 0
        )] | length) == 0 and
        .registry_image_analysis.listed_tag_count ==
          .registry_image_analysis.valid_tag_count and
        .registry_image_analysis.incomplete_tag_generation_count == 0 and
        .registry_image_analysis.digest_service_conflict_count == 0 and
        .registry_image_analysis.unique_service_distribution_valid == true and
        .registry_image_analysis.unique_image_count ==
          ([.registry_repositories[].image_count] | add // 0) and
        .registry_image_analysis.unique_generation_count ==
          (.registry_image_analysis.unique_image_count /
           $registry_images_per_generation) and
        ([.registry_repositories[] | select(
          .public != false or (.immutable != true and .immutable != null)
        )] | length) == 0
      else
        .application_registry.repository == "ghcr.io/vasilyevstan/betstan-images" and
        .application_registry.public_anonymous == true and
        .registry_measurement_complete == true and
        (
          if .mode == "complete" then
            .application_registry.validated_build_evidence == true and
            .application_registry.ocir_application_repository_absent == true and
            (.registry_repositories | length) == 0 and
            .registry_layers_size_bytes == 0
          else
            (.registry_repositories | length) <= 1 and
            .registry_layers_size_bytes <= $registry_max and
            all(
              .registry_repositories[];
              .name == $expected_repository and
              .image_count <= ($registry_images_per_generation * $registry_max_generations) and
              .layers_size_bytes <= $registry_max and
              .public == false
            )
          end
        )
      end
    ) and
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
