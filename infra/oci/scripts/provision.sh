#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="${1:-cloud}"
PROVENANCE_DIR="${PROVENANCE_DIR:-$OCI_ROOT_DIR/artifacts/oci-infrastructure}"
PROVENANCE_FILE="${PROVENANCE_FILE:-$PROVENANCE_DIR/provenance.env}"
INVENTORY_FILE="${INVENTORY_FILE:-$PROVENANCE_DIR/inventory.json}"
SOURCE_SHA="${SOURCE_SHA:-${GITHUB_SHA:-}}"
OCI_MONGO_VPUS_PER_GB="${OCI_MONGO_VPUS_PER_GB:-0}"

[[ "$MODE" == "cloud" || "$MODE" == "addons" ]] ||
  oci_die "usage: provision.sh [cloud|addons]"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || oci_die "SOURCE_SHA must be the exact approved commit"
oci_require_cli_version
oci_require_command jq
oci_require_vars \
  OCI_COMPARTMENT_OCID OCI_COMPARTMENT_NAME OCI_REGION OCI_AVAILABILITY_DOMAIN \
  OCI_CLUSTER_NAME OCI_NODE_POOL_NAME OCI_VCN_NAME OCI_K8S_NAMESPACE \
  OCI_KUBERNETES_VERSION OCI_NODE_IMAGE_OCID OCI_VCN_CIDR \
  OCI_WORKER_SUBNET_CIDR OCI_LB_SUBNET_CIDR OCI_PODS_CIDR OCI_SERVICES_CIDR \
  OCI_A1_OCPUS OCI_A1_MEMORY_GB OCI_BOOT_VOLUME_GB OCI_MONGO_VOLUME_GB \
  OCI_LB_MIN_MBPS OCI_LB_MAX_MBPS OCI_EXPECTED_MONTHLY_COST OCI_LB_NAME
oci_require_value OCI_A1_OCPUS 2
oci_require_value OCI_A1_MEMORY_GB 12
oci_require_value OCI_MONGO_VOLUME_GB 50
oci_require_value OCI_LB_MIN_MBPS 10
oci_require_value OCI_LB_MAX_MBPS 10
oci_require_value OCI_EXPECTED_MONTHLY_COST 0
[[ "$OCI_MONGO_VPUS_PER_GB" == "0" ]] ||
  oci_die "Mongo block volume must use the zero-VPU lower-cost profile"

oci_prepare_private_dir "$PROVENANCE_DIR"
tags="$(jq -cn --arg sha "$SOURCE_SHA" '{
  "betstan-managed": "true",
  "provider": "oci",
  "expected-monthly-cost": "0",
  "source-sha": $sha
}')"

single_id() {
  local json
  json="$(oci_normalize_list_json "$1")"
  local name="$2"
  local field="${3:-display-name}"
  local count id
  count="$(jq -r --arg name "$name" --arg field "$field" '
    [.data[]? | select(.[$field] == $name and
      (."lifecycle-state" // "") != "TERMINATED" and
      (."lifecycle-state" // "") != "DELETED")] | length
  ' <<<"$json")"
  [[ "$count" -le 1 ]] || oci_die "multiple OCI resources share managed name '$name'"
  if [[ "$count" == "1" ]]; then
    jq -e --arg name "$name" --arg field "$field" '
      [.data[]? | select(.[$field] == $name and
        (."lifecycle-state" // "") != "TERMINATED" and
        (."lifecycle-state" // "") != "DELETED")][0]."freeform-tags" as $tags |
      $tags["betstan-managed"] == "true" and
      $tags.provider == "oci" and
      $tags["expected-monthly-cost"] == "0"
    ' <<<"$json" >/dev/null ||
      oci_die "existing resource with managed name lacks the exact BetStan OCI tags: $name"
  fi
  id="$(jq -r --arg name "$name" --arg field "$field" '
    [.data[]? | select(.[$field] == $name and
      (."lifecycle-state" // "") != "TERMINATED" and
      (."lifecycle-state" // "") != "DELETED")][0].id // empty
  ' <<<"$json")"
  printf '%s' "$id"
}

ensure_nsg_rule() {
  local nsg_id="$1"
  local description="$2"
  local rule_json="$3"
  local existing
  existing="$(
    oci network nsg rules list \
      --network-security-group-id "$nsg_id" --all
  )"
  existing="$(oci_normalize_list_json "$existing")"
  if jq -e --arg description "$description" --argjson expected "$rule_json" '
      [.data[]? | select(.description == $description)] as $matches
      | ($matches | length) == 1
      and ($matches[0].direction == $expected.direction)
      and ($matches[0].protocol == $expected.protocol)
      and (($matches[0].source // null) == ($expected.source // null))
      and (($matches[0]."source-type" // null) == ($expected.sourceType // null))
      and (($matches[0].destination // null) == ($expected.destination // null))
      and (($matches[0]."destination-type" // null) == ($expected.destinationType // null))
      and (($matches[0]."tcp-options"."destination-port-range".min // null) ==
        ($expected.tcpOptions.destinationPortRange.min // null))
      and (($matches[0]."tcp-options"."destination-port-range".max // null) ==
        ($expected.tcpOptions.destinationPortRange.max // null))
    ' <<<"$existing" >/dev/null; then
    return
  fi
  jq -e --arg description "$description" \
    '[.data[]? | select(.description == $description)] | length == 0' \
    <<<"$existing" >/dev/null ||
    oci_die "managed NSG rule differs from the approved contract: $description"
  oci network nsg rules add \
    --network-security-group-id "$nsg_id" \
    --security-rules "[$rule_json]" >/dev/null
}

if [[ "$MODE" == "cloud" ]]; then
  "$SCRIPT_DIR/preflight.sh"

  compartment_name="$(
    oci iam compartment get --compartment-id "$OCI_COMPARTMENT_OCID" \
      --query 'data.name' --raw-output
  )"
  [[ "$compartment_name" == "$OCI_COMPARTMENT_NAME" ]] ||
    oci_die "compartment OCID does not match OCI_COMPARTMENT_NAME"

  vcns="$(oci network vcn list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
  vcn_id="$(single_id "$vcns" "$OCI_VCN_NAME")"
  if [[ -z "$vcn_id" ]]; then
    vcn_id="$(
      oci network vcn create \
        --compartment-id "$OCI_COMPARTMENT_OCID" \
        --cidr-block "$OCI_VCN_CIDR" \
        --display-name "$OCI_VCN_NAME" \
        --dns-label betstanoci \
        --freeform-tags "$tags" \
        --wait-for-state AVAILABLE \
        --query 'data.id' --raw-output
    )"
  fi
  vcn="$(
    oci network vcn get --vcn-id "$vcn_id"
  )"
  [[ "$(jq -r '.data."cidr-block"' <<<"$vcn")" == "$OCI_VCN_CIDR" ]] ||
    oci_die "existing VCN CIDR differs from approved configuration"

  igw_name="${OCI_VCN_NAME}-internet"
  igws="$(oci network internet-gateway list --compartment-id "$OCI_COMPARTMENT_OCID" --vcn-id "$vcn_id" --all)"
  igw_id="$(single_id "$igws" "$igw_name")"
  if [[ -z "$igw_id" ]]; then
    igw_id="$(
      oci network internet-gateway create \
        --compartment-id "$OCI_COMPARTMENT_OCID" \
        --vcn-id "$vcn_id" \
        --is-enabled true \
        --display-name "$igw_name" \
        --freeform-tags "$tags" \
        --wait-for-state AVAILABLE \
        --query 'data.id' --raw-output
    )"
  fi

  route_name="${OCI_VCN_NAME}-public-routes"
  routes="$(oci network route-table list --compartment-id "$OCI_COMPARTMENT_OCID" --vcn-id "$vcn_id" --all)"
  route_id="$(single_id "$routes" "$route_name")"
  route_rules="$(jq -cn --arg igw "$igw_id" '[{
    destination: "0.0.0.0/0",
    destinationType: "CIDR_BLOCK",
    networkEntityId: $igw,
    description: "internet-egress-only"
  }]')"
  if [[ -z "$route_id" ]]; then
    route_id="$(
      oci network route-table create \
        --compartment-id "$OCI_COMPARTMENT_OCID" \
        --vcn-id "$vcn_id" \
        --display-name "$route_name" \
        --route-rules "$route_rules" \
        --freeform-tags "$tags" \
        --wait-for-state AVAILABLE \
        --query 'data.id' --raw-output
    )"
  else
    oci network route-table update \
      --rt-id "$route_id" --route-rules "$route_rules" --force >/dev/null
  fi

  security_list_name="${OCI_VCN_NAME}-public-restricted"
  security_lists="$(oci network security-list list --compartment-id "$OCI_COMPARTMENT_OCID" --vcn-id "$vcn_id" --all)"
  security_list_id="$(single_id "$security_lists" "$security_list_name")"
  egress_rules='[{"destination":"0.0.0.0/0","destinationType":"CIDR_BLOCK","isStateless":false,"protocol":"all","description":"outbound-only"}]'
  if [[ -z "$security_list_id" ]]; then
    security_list_id="$(
      oci network security-list create \
        --compartment-id "$OCI_COMPARTMENT_OCID" \
        --vcn-id "$vcn_id" \
        --display-name "$security_list_name" \
        --egress-security-rules "$egress_rules" \
        --ingress-security-rules '[]' \
        --freeform-tags "$tags" \
        --wait-for-state AVAILABLE \
        --query 'data.id' --raw-output
    )"
  else
    oci network security-list update \
      --security-list-id "$security_list_id" \
      --egress-security-rules "$egress_rules" \
      --ingress-security-rules '[]' --force >/dev/null
  fi

  declare -A nsg_ids=()
  for role in endpoint worker lb; do
    name="${OCI_VCN_NAME}-${role}-nsg"
    nsgs="$(oci network nsg list --compartment-id "$OCI_COMPARTMENT_OCID" --vcn-id "$vcn_id" --all)"
    id="$(single_id "$nsgs" "$name")"
    if [[ -z "$id" ]]; then
      id="$(
        oci network nsg create \
          --compartment-id "$OCI_COMPARTMENT_OCID" \
          --vcn-id "$vcn_id" \
          --display-name "$name" \
          --freeform-tags "$tags" \
          --wait-for-state AVAILABLE \
          --query 'data.id' --raw-output
      )"
    fi
    nsg_ids["$role"]="$id"
  done

  ensure_nsg_rule "${nsg_ids[endpoint]}" "workers-to-api-6443" "$(
    jq -cn --arg source "${nsg_ids[worker]}" '{
      direction:"INGRESS", protocol:"6", sourceType:"NETWORK_SECURITY_GROUP",
      source:$source, isStateless:false, description:"workers-to-api-6443",
      tcpOptions:{destinationPortRange:{min:6443,max:6443}}
    }'
  )"
  ensure_nsg_rule "${nsg_ids[endpoint]}" "endpoint-to-workers" "$(
    jq -cn --arg destination "${nsg_ids[worker]}" '{
      direction:"EGRESS", protocol:"all", destinationType:"NETWORK_SECURITY_GROUP",
      destination:$destination, isStateless:false, description:"endpoint-to-workers"
    }'
  )"
  ensure_nsg_rule "${nsg_ids[worker]}" "endpoint-to-kubelet-10250" "$(
    jq -cn --arg source "${nsg_ids[endpoint]}" '{
      direction:"INGRESS", protocol:"6", sourceType:"NETWORK_SECURITY_GROUP",
      source:$source, isStateless:false, description:"endpoint-to-kubelet-10250",
      tcpOptions:{destinationPortRange:{min:10250,max:10250}}
    }'
  )"
  ensure_nsg_rule "${nsg_ids[worker]}" "endpoint-to-nodeports" "$(
    jq -cn --arg source "${nsg_ids[endpoint]}" '{
      direction:"INGRESS", protocol:"6", sourceType:"NETWORK_SECURITY_GROUP",
      source:$source, isStateless:false, description:"endpoint-to-nodeports",
      tcpOptions:{destinationPortRange:{min:30000,max:32767}}
    }'
  )"
  ensure_nsg_rule "${nsg_ids[worker]}" "worker-internal" "$(
    jq -cn --arg source "${nsg_ids[worker]}" '{
      direction:"INGRESS", protocol:"all", sourceType:"NETWORK_SECURITY_GROUP",
      source:$source, isStateless:false, description:"worker-internal"
    }'
  )"
  ensure_nsg_rule "${nsg_ids[worker]}" "lb-to-nodeports" "$(
    jq -cn --arg source "${nsg_ids[lb]}" '{
      direction:"INGRESS", protocol:"6", sourceType:"NETWORK_SECURITY_GROUP",
      source:$source, isStateless:false, description:"lb-to-nodeports",
      tcpOptions:{destinationPortRange:{min:30000,max:32767}}
    }'
  )"
  ensure_nsg_rule "${nsg_ids[worker]}" "worker-internet-egress" '{
    "direction":"EGRESS","protocol":"all","destinationType":"CIDR_BLOCK",
    "destination":"0.0.0.0/0","isStateless":false,"description":"worker-internet-egress"
  }'
  for port in 80 443; do
    ensure_nsg_rule "${nsg_ids[lb]}" "world-to-lb-${port}" "$(
      jq -cn --argjson port "$port" '{
        direction:"INGRESS", protocol:"6", sourceType:"CIDR_BLOCK",
        source:"0.0.0.0/0", isStateless:false,
        description:("world-to-lb-" + ($port|tostring)),
        tcpOptions:{destinationPortRange:{min:$port,max:$port}}
      }'
    )"
  done
  ensure_nsg_rule "${nsg_ids[lb]}" "lb-to-worker-nodeports" "$(
    jq -cn --arg destination "${nsg_ids[worker]}" '{
      direction:"EGRESS", protocol:"6", destinationType:"NETWORK_SECURITY_GROUP",
      destination:$destination, isStateless:false, description:"lb-to-worker-nodeports",
      tcpOptions:{destinationPortRange:{min:30000,max:32767}}
    }'
  )"

  security_list_ids="$(jq -cn --arg id "$security_list_id" '[$id]')"
  declare -A subnet_ids=()
  for role in worker lb; do
    if [[ "$role" == "worker" ]]; then
      cidr="$OCI_WORKER_SUBNET_CIDR"
      dns_label=workers
    else
      cidr="$OCI_LB_SUBNET_CIDR"
      dns_label=loadbalancers
    fi
    name="${OCI_VCN_NAME}-${role}-public"
    subnets="$(oci network subnet list --compartment-id "$OCI_COMPARTMENT_OCID" --vcn-id "$vcn_id" --all)"
    id="$(single_id "$subnets" "$name")"
    if [[ -z "$id" ]]; then
      id="$(
        oci network subnet create \
          --compartment-id "$OCI_COMPARTMENT_OCID" \
          --vcn-id "$vcn_id" \
          --cidr-block "$cidr" \
          --display-name "$name" \
          --dns-label "$dns_label" \
          --route-table-id "$route_id" \
          --security-list-ids "$security_list_ids" \
          --prohibit-public-ip-on-vnic false \
          --freeform-tags "$tags" \
          --wait-for-state AVAILABLE \
          --query 'data.id' --raw-output
      )"
    fi
    subnet="$(oci network subnet get --subnet-id "$id")"
    jq -e --arg cidr "$cidr" --arg route "$route_id" --arg security_list "$security_list_id" '
      .data."cidr-block" == $cidr and
      .data."route-table-id" == $route and
      .data."prohibit-public-ip-on-vnic" == false and
      (.data."security-list-ids" | sort) == ([$security_list] | sort)
    ' <<<"$subnet" >/dev/null ||
      oci_die "existing $role subnet differs from the approved public/restricted contract"
    subnet_ids["$role"]="$id"
  done

  clusters="$(oci ce cluster list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
  cluster_id="$(single_id "$clusters" "$OCI_CLUSTER_NAME" name)"
  if [[ -z "$cluster_id" ]]; then
    service_subnets="$(jq -cn --arg id "${subnet_ids[lb]}" '[$id]')"
    endpoint_nsgs="$(jq -cn --arg id "${nsg_ids[endpoint]}" '[$id]')"
    oci ce cluster create \
      --name "$OCI_CLUSTER_NAME" \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --vcn-id "$vcn_id" \
      --kubernetes-version "$OCI_KUBERNETES_VERSION" \
      --type BASIC_CLUSTER \
      --service-lb-subnet-ids "$service_subnets" \
      --service-lb-freeform-tags "$tags" \
      --endpoint-subnet-id "${subnet_ids[worker]}" \
      --endpoint-nsg-ids "$endpoint_nsgs" \
      --endpoint-public-ip-enabled true \
      --pods-cidr "$OCI_PODS_CIDR" \
      --services-cidr "$OCI_SERVICES_CIDR" \
      --dashboard-enabled false \
      --tiller-enabled false \
      --freeform-tags "$tags" \
      --wait-for-state SUCCEEDED >/dev/null
    clusters="$(oci ce cluster list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
    cluster_id="$(single_id "$clusters" "$OCI_CLUSTER_NAME" name)"
  fi
  [[ -n "$cluster_id" ]] || oci_die "OKE cluster creation did not return the managed cluster"
  cluster="$(oci ce cluster get --cluster-id "$cluster_id")"
  [[ "$(jq -r '.data.type' <<<"$cluster")" == "BASIC_CLUSTER" ]] ||
    oci_die "existing OKE cluster is not BASIC_CLUSTER"
  jq -e \
    --arg version "$OCI_KUBERNETES_VERSION" \
    --arg vcn "$vcn_id" \
    --arg endpoint_subnet "${subnet_ids[worker]}" \
    --arg endpoint_nsg "${nsg_ids[endpoint]}" \
    --arg lb_subnet "${subnet_ids[lb]}" \
    --arg pods "$OCI_PODS_CIDR" \
    --arg services "$OCI_SERVICES_CIDR" '
      .data."kubernetes-version" == $version and
      .data."vcn-id" == $vcn and
      .data."endpoint-config"."subnet-id" == $endpoint_subnet and
      .data."endpoint-config"."is-public-ip-enabled" == true and
      (.data."endpoint-config"."nsg-ids" | sort) == ([$endpoint_nsg] | sort) and
      (.data.options."service-lb-subnet-ids" | sort) == ([$lb_subnet] | sort) and
      .data.options."service-lb-freeform-tags"["betstan-managed"] == "true" and
      .data.options."service-lb-freeform-tags".provider == "oci" and
      .data.options."service-lb-freeform-tags"["expected-monthly-cost"] == "0" and
      .data.options."kubernetes-network-config"."pods-cidr" == $pods and
      .data.options."kubernetes-network-config"."services-cidr" == $services
    ' <<<"$cluster" >/dev/null ||
    oci_die "existing OKE cluster network/version contract differs; explicit replacement review is required"

  pools="$(oci ce node-pool list --compartment-id "$OCI_COMPARTMENT_OCID" --cluster-id "$cluster_id" --all)"
  node_pool_id="$(single_id "$pools" "$OCI_NODE_POOL_NAME" name)"
  if [[ -z "$node_pool_id" ]]; then
    shape_config="$(jq -cn --argjson ocpus "$OCI_A1_OCPUS" --argjson memory "$OCI_A1_MEMORY_GB" \
      '{ocpus:$ocpus,memoryInGBs:$memory}')"
    placement="$(jq -cn --arg ad "$OCI_AVAILABILITY_DOMAIN" --arg subnet "${subnet_ids[worker]}" \
      '[{availabilityDomain:$ad,subnetId:$subnet}]')"
    worker_nsgs="$(jq -cn --arg id "${nsg_ids[worker]}" '[$id]')"
    oci ce node-pool create \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --cluster-id "$cluster_id" \
      --name "$OCI_NODE_POOL_NAME" \
      --node-shape VM.Standard.A1.Flex \
      --node-shape-config "$shape_config" \
      --kubernetes-version "$OCI_KUBERNETES_VERSION" \
      --node-image-id "$OCI_NODE_IMAGE_OCID" \
      --node-boot-volume-size-in-gbs "$OCI_BOOT_VOLUME_GB" \
      --size 1 \
      --placement-configs "$placement" \
      --nsg-ids "$worker_nsgs" \
      --initial-node-labels '[{"key":"betstan.io/provider","value":"oci"}]' \
      --node-freeform-tags "$tags" \
      --freeform-tags "$tags" \
      --wait-for-state SUCCEEDED >/dev/null
    pools="$(oci ce node-pool list --compartment-id "$OCI_COMPARTMENT_OCID" --cluster-id "$cluster_id" --all)"
    node_pool_id="$(single_id "$pools" "$OCI_NODE_POOL_NAME" name)"
  fi
  [[ -n "$node_pool_id" ]] || oci_die "OKE node pool creation did not return the managed pool"
  pool="$(oci ce node-pool get --node-pool-id "$node_pool_id")"
  jq -e \
    --argjson ocpus "$OCI_A1_OCPUS" \
    --argjson memory "$OCI_A1_MEMORY_GB" \
    --argjson boot "$OCI_BOOT_VOLUME_GB" \
    --arg image "$OCI_NODE_IMAGE_OCID" \
    --arg ad "$OCI_AVAILABILITY_DOMAIN" \
    --arg subnet "${subnet_ids[worker]}" \
    --arg worker_nsg "${nsg_ids[worker]}" '
    .data."node-shape" == "VM.Standard.A1.Flex" and
    .data."node-config-details".size == 1 and
    .data."node-shape-config".ocpus == $ocpus and
    .data."node-shape-config"."memory-in-gbs" == $memory and
    .data."node-source-details"."image-id" == $image and
    .data."node-source-details"."boot-volume-size-in-gbs" == $boot and
    (.data."node-config-details"."nsg-ids" | sort) == ([$worker_nsg] | sort) and
    ([.data."node-config-details"."placement-configs"[]?
      | select(."availability-domain" == $ad and ."subnet-id" == $subnet)
    ] | length) == 1
  ' <<<"$pool" >/dev/null || oci_die "existing node pool violates the one-node A1 contract"

  volume_name="${OCI_CLUSTER_NAME}-mongo-50g"
  volumes="$(oci bv volume list --compartment-id "$OCI_COMPARTMENT_OCID" --availability-domain "$OCI_AVAILABILITY_DOMAIN" --all)"
  mongo_volume_id="$(single_id "$volumes" "$volume_name")"
  if [[ -z "$mongo_volume_id" ]]; then
    mongo_volume_id="$(
      oci bv volume create \
        --compartment-id "$OCI_COMPARTMENT_OCID" \
        --availability-domain "$OCI_AVAILABILITY_DOMAIN" \
        --display-name "$volume_name" \
        --size-in-gbs "$OCI_MONGO_VOLUME_GB" \
        --vpus-per-gb "$OCI_MONGO_VPUS_PER_GB" \
        --freeform-tags "$tags" \
        --wait-for-state AVAILABLE \
        --query 'data.id' --raw-output
    )"
  fi
  volume="$(oci bv volume get --volume-id "$mongo_volume_id")"
  jq -e --argjson size "$OCI_MONGO_VOLUME_GB" '
    .data."size-in-gbs" == $size and .data."vpus-per-gb" == 0 and
    .data."lifecycle-state" == "AVAILABLE"
  ' <<<"$volume" >/dev/null || oci_die "Mongo block volume violates size/performance contract"

  {
    printf 'source_sha=%q\n' "$SOURCE_SHA"
    printf 'infrastructure_run_id=%q\n' "${GITHUB_RUN_ID:-local}"
    printf 'infrastructure_run_attempt=%q\n' "${GITHUB_RUN_ATTEMPT:-1}"
    printf 'region=%q\n' "$OCI_REGION"
    printf 'compartment_ocid=%q\n' "$OCI_COMPARTMENT_OCID"
    printf 'cluster_ocid=%q\n' "$cluster_id"
    printf 'cluster_fingerprint=%q\n' "$(oci_fingerprint "$cluster_id")"
    printf 'vcn_ocid=%q\n' "$vcn_id"
    printf 'endpoint_nsg_ocid=%q\n' "${nsg_ids[endpoint]}"
    printf 'worker_nsg_ocid=%q\n' "${nsg_ids[worker]}"
    printf 'lb_nsg_ocid=%q\n' "${nsg_ids[lb]}"
    printf 'worker_subnet_ocid=%q\n' "${subnet_ids[worker]}"
    printf 'lb_subnet_ocid=%q\n' "${subnet_ids[lb]}"
    printf 'node_pool_ocid=%q\n' "$node_pool_id"
    printf 'OCI_MONGO_VOLUME_OCID=%q\n' "$mongo_volume_id"
    printf 'mongo_volume_ocid=%q\n' "$mongo_volume_id"
    printf 'namespace=%q\n' "$OCI_K8S_NAMESPACE"
    printf 'lb_name=%q\n' "$OCI_LB_NAME"
    printf 'kubernetes_version=%q\n' "$OCI_KUBERNETES_VERSION"
    printf 'node_shape=%q\n' "VM.Standard.A1.Flex"
    printf 'node_ocpus=%q\n' "$OCI_A1_OCPUS"
    printf 'node_memory_gb=%q\n' "$OCI_A1_MEMORY_GB"
    printf 'boot_volume_gb=%q\n' "$OCI_BOOT_VOLUME_GB"
    printf 'mongo_volume_gb=%q\n' "$OCI_MONGO_VOLUME_GB"
    printf 'lb_min_mbps=%q\n' "$OCI_LB_MIN_MBPS"
    printf 'lb_max_mbps=%q\n' "$OCI_LB_MAX_MBPS"
    printf 'expected_monthly_cost=%q\n' "$OCI_EXPECTED_MONTHLY_COST"
  } > "$PROVENANCE_FILE"
  chmod 600 "$PROVENANCE_FILE"
  INVENTORY_MODE=preflight OUTPUT_FILE="$INVENTORY_FILE" "$SCRIPT_DIR/inventory.sh"
  oci_log "oci_cloud_provision=PASS exact_provenance_recorded=1"
  exit 0
fi

oci_require_command kubectl
oci_require_command helm
oci_require_vars \
  OCI_INGRESS_NGINX_CHART_VERSION OCI_INGRESS_NGINX_CHART_SHA256 \
  OCI_CERT_MANAGER_CHART_VERSION OCI_CERT_MANAGER_CHART_SHA256 \
  OCI_CERT_MANAGER_CONTROLLER_DIGEST OCI_CERT_MANAGER_WEBHOOK_DIGEST \
  OCI_CERT_MANAGER_CAINJECTOR_DIGEST OCI_CERT_MANAGER_ACMESOLVER_DIGEST \
  OCI_CERT_MANAGER_STARTUP_DIGEST
for digest_name in \
  OCI_CERT_MANAGER_CONTROLLER_DIGEST OCI_CERT_MANAGER_WEBHOOK_DIGEST \
  OCI_CERT_MANAGER_CAINJECTOR_DIGEST OCI_CERT_MANAGER_ACMESOLVER_DIGEST \
  OCI_CERT_MANAGER_STARTUP_DIGEST; do
  [[ "${!digest_name}" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "$digest_name must be an immutable multi-architecture digest"
done
[[ -f "$PROVENANCE_FILE" ]] || oci_die "cloud provenance must exist before add-on installation"
unset cluster_ocid cluster_fingerprint endpoint_nsg_ocid lb_nsg_ocid lb_subnet_ocid lb_name
# shellcheck disable=SC1090
source "$PROVENANCE_FILE"
oci_require_vars cluster_ocid cluster_fingerprint lb_nsg_ocid lb_name
oci_require_ocid cluster_ocid
oci_require_ocid lb_nsg_ocid

kubeconfig_json="$(kubectl config view --raw --minify -o json)"
jq -e --arg cluster "$cluster_ocid" '
  [.users[].user.exec.args[]? | select(. == $cluster)] | length == 1
' <<<"$kubeconfig_json" >/dev/null || oci_die "kubectl is not configured from the exact cluster OCID"
[[ "$(oci_fingerprint "$cluster_ocid")" == "$cluster_fingerprint" ]] ||
  oci_die "cluster provenance fingerprint mismatch"

work_dir="$PROVENANCE_DIR/addons-work"
rm -rf "$work_dir"
oci_prepare_private_dir "$work_dir"
cleanup_addon_work() {
  rm -rf "$work_dir"
}
trap cleanup_addon_work EXIT
values_file="$work_dir/ingress-values.yaml"
sed \
  -e "s#__OCI_LB_NSG_OCID__#${lb_nsg_ocid}#g" \
  -e "s#__OCI_LB_NAME__#${lb_name}#g" \
  "$OCI_DIR/helm/ingress-nginx-values.yaml" > "$values_file"

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update >/dev/null
helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
helm repo update >/dev/null
helm pull ingress-nginx/ingress-nginx \
  --version "$OCI_INGRESS_NGINX_CHART_VERSION" \
  --destination "$work_dir"
helm pull jetstack/cert-manager \
  --version "$OCI_CERT_MANAGER_CHART_VERSION" \
  --destination "$work_dir"
ingress_chart="$work_dir/ingress-nginx-${OCI_INGRESS_NGINX_CHART_VERSION}.tgz"
cert_chart="$work_dir/cert-manager-${OCI_CERT_MANAGER_CHART_VERSION}.tgz"
[[ "$(oci_sha256 < "$ingress_chart")" == "$OCI_INGRESS_NGINX_CHART_SHA256" ]] ||
  oci_die "ingress-nginx chart archive hash differs from the reviewed artifact"
[[ "$(oci_sha256 < "$cert_chart")" == "$OCI_CERT_MANAGER_CHART_SHA256" ]] ||
  oci_die "cert-manager chart archive hash differs from the reviewed artifact"
helm upgrade --install ingress-nginx "$ingress_chart" \
  --namespace ingress-nginx --create-namespace \
  --values "$values_file" \
  --wait --timeout 15m
helm upgrade --install cert-manager "$cert_chart" \
  --namespace cert-manager --create-namespace \
  --set crds.enabled=true \
  --set-string "image.digest=$OCI_CERT_MANAGER_CONTROLLER_DIGEST" \
  --set-string "webhook.image.digest=$OCI_CERT_MANAGER_WEBHOOK_DIGEST" \
  --set-string "cainjector.image.digest=$OCI_CERT_MANAGER_CAINJECTOR_DIGEST" \
  --set-string "acmesolver.image.digest=$OCI_CERT_MANAGER_ACMESOLVER_DIGEST" \
  --set-string "startupapicheck.image.digest=$OCI_CERT_MANAGER_STARTUP_DIGEST" \
  --set 'nodeSelector.kubernetes\.io/arch=arm64' \
  --set 'webhook.nodeSelector.kubernetes\.io/arch=arm64' \
  --set 'cainjector.nodeSelector.kubernetes\.io/arch=arm64' \
  --set 'startupapicheck.nodeSelector.kubernetes\.io/arch=arm64' \
  --set resources.requests.cpu=50m \
  --set resources.requests.memory=64Mi \
  --set resources.limits.cpu=250m \
  --set resources.limits.memory=192Mi \
  --set webhook.resources.requests.cpu=25m \
  --set webhook.resources.requests.memory=48Mi \
  --set webhook.resources.limits.cpu=150m \
  --set webhook.resources.limits.memory=128Mi \
  --set cainjector.resources.requests.cpu=25m \
  --set cainjector.resources.requests.memory=64Mi \
  --set cainjector.resources.limits.cpu=150m \
  --set cainjector.resources.limits.memory=160Mi \
  --wait --timeout 15m

ingress_ipv4=""
for _ in $(seq 1 90); do
  ingress_ipv4="$(
    kubectl get service ingress-nginx-controller -n ingress-nginx \
      -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true
  )"
  [[ -n "$ingress_ipv4" ]] && break
  sleep 10
done
oci_validate_public_ipv4 "$ingress_ipv4" || oci_die "ingress did not receive a public IPv4 address"

load_balancers="$(oci lb load-balancer list --compartment-id "$OCI_COMPARTMENT_OCID" --display-name "$lb_name" --all)"
load_balancers="$(oci_normalize_list_json "$load_balancers")"
lb_count="$(jq -r '[.data[]? | select(."lifecycle-state" != "DELETED")] | length' <<<"$load_balancers")"
[[ "$lb_count" == "1" ]] || oci_die "expected exactly one OCI load balancer with the managed name"
lb_ocid="$(jq -r '.data[0].id' <<<"$load_balancers")"
lb="$(oci lb load-balancer get --load-balancer-id "$lb_ocid")"
jq -e --arg ip "$ingress_ipv4" --argjson min "$OCI_LB_MIN_MBPS" --argjson max "$OCI_LB_MAX_MBPS" '
  .data."shape-name" == "flexible" and
  .data."shape-details"."minimum-bandwidth-in-mbps" == $min and
  .data."shape-details"."maximum-bandwidth-in-mbps" == $max and
  ([.data."ip-addresses"[]."ip-address" | select(. == $ip)] | length) == 1
' <<<"$lb" >/dev/null || oci_die "OCI load balancer shape or ingress IPv4 violates provenance"

grep -v -E '^(lb_ocid|ingress_ipv4|public_host|ingress_nginx_chart_(version|sha256)|cert_manager_(chart_(version|sha256)|(controller|webhook|cainjector|acmesolver|startup)_digest))=' \
  "$PROVENANCE_FILE" > "$work_dir/provenance.env"
{
  printf 'lb_ocid=%q\n' "$lb_ocid"
  printf 'ingress_ipv4=%q\n' "$ingress_ipv4"
  printf 'public_host=%q\n' "${ingress_ipv4}.nip.io"
  printf 'ingress_nginx_chart_version=%q\n' "$OCI_INGRESS_NGINX_CHART_VERSION"
  printf 'ingress_nginx_chart_sha256=%q\n' "$OCI_INGRESS_NGINX_CHART_SHA256"
  printf 'cert_manager_chart_version=%q\n' "$OCI_CERT_MANAGER_CHART_VERSION"
  printf 'cert_manager_chart_sha256=%q\n' "$OCI_CERT_MANAGER_CHART_SHA256"
  printf 'cert_manager_controller_digest=%q\n' "$OCI_CERT_MANAGER_CONTROLLER_DIGEST"
  printf 'cert_manager_webhook_digest=%q\n' "$OCI_CERT_MANAGER_WEBHOOK_DIGEST"
  printf 'cert_manager_cainjector_digest=%q\n' "$OCI_CERT_MANAGER_CAINJECTOR_DIGEST"
  printf 'cert_manager_acmesolver_digest=%q\n' "$OCI_CERT_MANAGER_ACMESOLVER_DIGEST"
  printf 'cert_manager_startup_digest=%q\n' "$OCI_CERT_MANAGER_STARTUP_DIGEST"
} >> "$work_dir/provenance.env"
mv "$work_dir/provenance.env" "$PROVENANCE_FILE"
chmod 600 "$PROVENANCE_FILE"
rm -rf "$work_dir"
trap - EXIT
INVENTORY_MODE=complete OUTPUT_FILE="$INVENTORY_FILE" "$SCRIPT_DIR/inventory.sh"
oci_log "oci_addons_provision=PASS load_balancer_count=1 bandwidth=10/10"
