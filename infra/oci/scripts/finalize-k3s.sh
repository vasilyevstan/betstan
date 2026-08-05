#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

NETWORK_PROVENANCE_FILE="${NETWORK_PROVENANCE_FILE:-}"
ACQUISITION_PROVENANCE_FILE="${ACQUISITION_PROVENANCE_FILE:-}"
PROVENANCE_DIR="${PROVENANCE_DIR:-$OCI_ROOT_DIR/artifacts/oci-infrastructure}"
PROVENANCE_FILE="${PROVENANCE_FILE:-$PROVENANCE_DIR/provenance.env}"
INVENTORY_FILE="${INVENTORY_FILE:-$PROVENANCE_DIR/inventory.json}"
K3S_ACCESS_STATE_FILE="${K3S_ACCESS_STATE_FILE:-}"
SOURCE_SHA="${SOURCE_SHA:-${GITHUB_SHA:-}}"
OCI_MONGO_VPUS_PER_GB="${OCI_MONGO_VPUS_PER_GB:-0}"
OCI_MONGO_DEVICE="${OCI_MONGO_DEVICE:-/dev/oracleoci/oraclevdb}"
OCI_K3S_NODE_NAME="${OCI_K3S_NODE_NAME:-betstan-k3s}"

oci_assert_repository_root
[[ "$(oci_runtime_mode)" == "k3s" ]] ||
  oci_die "finalize-k3s.sh requires OCI_RUNTIME_MODE=k3s"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "SOURCE_SHA must be the exact approved commit"
[[ -f "$NETWORK_PROVENANCE_FILE" ]] ||
  oci_die "NETWORK_PROVENANCE_FILE is required"
[[ -f "$ACQUISITION_PROVENANCE_FILE" ]] ||
  oci_die "ACQUISITION_PROVENANCE_FILE is required"
[[ -f "$K3S_ACCESS_STATE_FILE" ]] ||
  oci_die "K3S_ACCESS_STATE_FILE is required"
[[ "$OCI_MONGO_DEVICE" == "/dev/oracleoci/oraclevdb" ]] ||
  oci_die "OCI_MONGO_DEVICE differs from the reviewed attachment path"

oci_require_cli_version
oci_require_command jq
oci_require_command kubectl
oci_require_command helm
oci_require_command ssh
oci_require_vars \
  OCI_COMPARTMENT_OCID OCI_REGION OCI_CLUSTER_NAME OCI_K8S_NAMESPACE \
  OCI_K3S_IMAGE_OCID OCI_K3S_VERSION OCI_BOOT_VOLUME_GB \
  OCI_MONGO_VOLUME_GB OCI_LB_NAME OCI_LB_MIN_MBPS OCI_LB_MAX_MBPS \
  OCI_EXPECTED_MONTHLY_COST OCI_INGRESS_NGINX_CHART_VERSION \
  OCI_INGRESS_NGINX_CHART_SHA256 OCI_CERT_MANAGER_CHART_VERSION \
  OCI_CERT_MANAGER_CHART_SHA256 OCI_CERT_MANAGER_CONTROLLER_DIGEST \
  OCI_CERT_MANAGER_WEBHOOK_DIGEST OCI_CERT_MANAGER_CAINJECTOR_DIGEST \
  OCI_CERT_MANAGER_ACMESOLVER_DIGEST OCI_CERT_MANAGER_STARTUP_DIGEST
oci_require_ocid OCI_COMPARTMENT_OCID
oci_require_ocid OCI_K3S_IMAGE_OCID
oci_require_value OCI_BOOT_VOLUME_GB 50
oci_require_value OCI_MONGO_VOLUME_GB 50
oci_require_value OCI_LB_MIN_MBPS 10
oci_require_value OCI_LB_MAX_MBPS 10
oci_require_value OCI_EXPECTED_MONTHLY_COST 0
oci_require_value OCI_MONGO_VPUS_PER_GB 0

for digest_name in \
  OCI_CERT_MANAGER_CONTROLLER_DIGEST OCI_CERT_MANAGER_WEBHOOK_DIGEST \
  OCI_CERT_MANAGER_CAINJECTOR_DIGEST OCI_CERT_MANAGER_ACMESOLVER_DIGEST \
  OCI_CERT_MANAGER_STARTUP_DIGEST; do
  [[ "${!digest_name}" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "$digest_name must be an immutable multi-architecture digest"
done

unset source_sha runtime_mode network_prepared region compartment_ocid
unset vcn_ocid vcn_fingerprint worker_nsg_ocid lb_nsg_ocid
unset worker_subnet_ocid lb_subnet_ocid bastion_ocid bastion_fingerprint
# shellcheck disable=SC1090
source "$NETWORK_PROVENANCE_FILE"
network_source_sha="${source_sha:-}"
network_runtime_mode="${runtime_mode:-}"
network_region="${region:-}"
network_compartment_ocid="${compartment_ocid:-}"
network_vcn_ocid="${vcn_ocid:-}"
network_vcn_fingerprint="${vcn_fingerprint:-}"
network_worker_nsg_ocid="${worker_nsg_ocid:-}"
network_lb_nsg_ocid="${lb_nsg_ocid:-}"
network_worker_subnet_ocid="${worker_subnet_ocid:-}"
network_lb_subnet_ocid="${lb_subnet_ocid:-}"
network_bastion_ocid="${bastion_ocid:-}"
network_bastion_fingerprint="${bastion_fingerprint:-}"
network_prepared_value="${network_prepared:-}"

unset source_sha runtime_mode region compartment_ocid instance_ocid
unset instance_fingerprint availability_domain image_ocid shape ocpus memory_gb
unset boot_volume_gb boot_volume_vpus_per_gb boot_volume_ocid
unset vnic_ocid subnet_ocid private_ip public_ip target_ssh_public_key_sha256
# shellcheck disable=SC1090
source "$ACQUISITION_PROVENANCE_FILE"
acquisition_source_sha="${source_sha:-}"
acquisition_runtime_mode="${runtime_mode:-}"
acquisition_region="${region:-}"
acquisition_compartment_ocid="${compartment_ocid:-}"
acquisition_instance_ocid="${instance_ocid:-}"
acquisition_instance_fingerprint="${instance_fingerprint:-}"
acquisition_ad="${availability_domain:-}"
acquisition_image_ocid="${image_ocid:-}"
acquisition_shape="${shape:-}"
acquisition_ocpus="${ocpus:-}"
acquisition_memory_gb="${memory_gb:-}"
acquisition_boot_volume_gb="${boot_volume_gb:-}"
acquisition_boot_volume_vpus="${boot_volume_vpus_per_gb:-}"
acquisition_boot_volume_ocid="${boot_volume_ocid:-}"
acquisition_vnic_ocid="${vnic_ocid:-}"
acquisition_subnet_ocid="${subnet_ocid:-}"
acquisition_private_ip="${private_ip:-}"
acquisition_public_ip="${public_ip:-}"
acquisition_target_ssh_public_key_sha256="${target_ssh_public_key_sha256:-}"

for required_value in \
  "$network_source_sha" "$network_runtime_mode" "$network_region" \
  "$network_compartment_ocid" "$network_vcn_ocid" "$network_vcn_fingerprint" \
  "$network_worker_nsg_ocid" "$network_lb_nsg_ocid" \
  "$network_worker_subnet_ocid" "$network_lb_subnet_ocid" \
  "$network_bastion_ocid" "$network_bastion_fingerprint" \
  "$acquisition_source_sha" "$acquisition_runtime_mode" \
  "$acquisition_region" "$acquisition_compartment_ocid" \
  "$acquisition_instance_ocid" "$acquisition_instance_fingerprint" \
  "$acquisition_ad" "$acquisition_image_ocid" "$acquisition_shape" \
  "$acquisition_ocpus" "$acquisition_memory_gb" \
  "$acquisition_boot_volume_gb" "$acquisition_boot_volume_vpus" \
  "$acquisition_boot_volume_ocid" \
  "$acquisition_vnic_ocid" "$acquisition_subnet_ocid" \
  "$acquisition_private_ip" "$acquisition_public_ip" \
  "$acquisition_target_ssh_public_key_sha256"; do
  [[ -n "$required_value" ]] ||
    oci_die "infrastructure or acquisition provenance is incomplete"
done

[[ "$network_prepared_value" == "true" ]] ||
  oci_die "network provenance is not marked prepared"
[[ "$network_runtime_mode" == "k3s" && "$acquisition_runtime_mode" == "k3s" ]] ||
  oci_die "provenance runtime mode is not k3s"
[[ "$network_source_sha" == "$SOURCE_SHA" &&
    "$acquisition_source_sha" == "$SOURCE_SHA" ]] ||
  oci_die "network and acquisition provenance must match the approved source SHA"
[[ "$network_region" == "$OCI_REGION" &&
    "$acquisition_region" == "$OCI_REGION" ]] ||
  oci_die "provenance region differs from OCI_REGION"
[[ "$network_compartment_ocid" == "$OCI_COMPARTMENT_OCID" &&
    "$acquisition_compartment_ocid" == "$OCI_COMPARTMENT_OCID" ]] ||
  oci_die "provenance compartment differs from OCI_COMPARTMENT_OCID"
[[ "$acquisition_subnet_ocid" == "$network_worker_subnet_ocid" ]] ||
  oci_die "acquired instance is not in the prepared worker subnet"
[[ "$acquisition_shape" == "VM.Standard.A1.Flex" &&
    "$acquisition_ocpus" == "2" &&
    "$acquisition_memory_gb" == "12" &&
    "$acquisition_boot_volume_gb" == "50" &&
    "$acquisition_boot_volume_vpus" == "$OCI_BOOT_VOLUME_VPUS_PER_GB" ]] ||
  oci_die "acquisition provenance violates the approved A1 profile"
[[ "$acquisition_image_ocid" == "$OCI_K3S_IMAGE_OCID" ]] ||
  oci_die "acquisition image differs from OCI_K3S_IMAGE_OCID"
[[ "$acquisition_target_ssh_public_key_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "acquisition target SSH public-key fingerprint is invalid"
oci_validate_public_ipv4 "$acquisition_public_ip" ||
  oci_die "acquisition provenance lacks a globally routable instance IPv4"

for ocid in \
  "$network_vcn_ocid" "$network_worker_nsg_ocid" "$network_lb_nsg_ocid" \
  "$network_worker_subnet_ocid" "$network_lb_subnet_ocid" \
  "$network_bastion_ocid" "$acquisition_instance_ocid" \
  "$acquisition_boot_volume_ocid" "$acquisition_vnic_ocid"; do
  [[ "$ocid" == ocid1.* ]] || oci_die "provenance contains an invalid OCID"
done
[[ "$(oci_fingerprint "$network_vcn_ocid")" == "$network_vcn_fingerprint" ]] ||
  oci_die "VCN provenance fingerprint mismatch"
[[ "$(oci_fingerprint "$network_bastion_ocid")" == "$network_bastion_fingerprint" ]] ||
  oci_die "Bastion provenance fingerprint mismatch"
[[ "$(oci_fingerprint "$acquisition_instance_ocid")" == "$acquisition_instance_fingerprint" ]] ||
  oci_die "instance provenance fingerprint mismatch"

instance="$(oci compute instance get --instance-id "$acquisition_instance_ocid")"
jq -e \
  --arg compartment "$OCI_COMPARTMENT_OCID" \
  --arg ad "$acquisition_ad" \
  --arg image "$OCI_K3S_IMAGE_OCID" \
  --arg sha "$SOURCE_SHA" '
    .data."compartment-id" == $compartment and
    .data."availability-domain" == $ad and
    .data."image-id" == $image and
    .data.shape == "VM.Standard.A1.Flex" and
    .data."shape-config".ocpus == 2 and
    .data."shape-config"."memory-in-gbs" == 12 and
    .data."lifecycle-state" == "RUNNING" and
    .data."freeform-tags"."betstan-managed" == "true" and
    .data."freeform-tags".provider == "oci" and
    .data."freeform-tags"."betstan-runtime" == "k3s" and
    .data."freeform-tags"."source-sha" == $sha and
    .data."freeform-tags"."expected-monthly-cost" == "0"
  ' <<<"$instance" >/dev/null ||
  oci_die "live k3s instance differs from trusted provenance"

vnic="$(oci network vnic get --vnic-id "$acquisition_vnic_ocid")"
jq -e \
  --arg private_ip "$acquisition_private_ip" \
  --arg public_ip "$acquisition_public_ip" \
  --arg subnet "$network_worker_subnet_ocid" \
  --arg worker_nsg "$network_worker_nsg_ocid" '
    .data."private-ip" == $private_ip and
    .data."public-ip" == $public_ip and
    .data."subnet-id" == $subnet and
    (.data."nsg-ids" | sort) == ([$worker_nsg] | sort)
  ' <<<"$vnic" >/dev/null ||
  oci_die "live k3s VNIC differs from trusted provenance"

boot_volume="$(oci bv boot-volume get --boot-volume-id "$acquisition_boot_volume_ocid")"
jq -e \
  --arg ad "$acquisition_ad" \
  --argjson size "$OCI_BOOT_VOLUME_GB" \
  --argjson vpus "$OCI_BOOT_VOLUME_VPUS_PER_GB" '
    .data."availability-domain" == $ad and
    .data."size-in-gbs" == $size and
    .data."vpus-per-gb" == $vpus and
    .data."lifecycle-state" == "AVAILABLE"
  ' <<<"$boot_volume" >/dev/null ||
  oci_die "live boot volume differs from the approved 50 GB Balanced contract"

node_json="$(kubectl --request-timeout=15s get node "$OCI_K3S_NODE_NAME" -o json)"
jq -e \
  --arg version "$OCI_K3S_VERSION" \
  --arg instance "$acquisition_instance_ocid" '
    .metadata.labels."kubernetes.io/arch" == "arm64" and
    .metadata.labels."betstan.io/runtime" == "k3s" and
    .metadata.labels."node.kubernetes.io/instance-type" == "VM.Standard.A1.Flex" and
    .spec.providerID == ("oci://" + $instance) and
    .status.nodeInfo.kubeletVersion == $version and
    ([.status.conditions[] | select(.type == "Ready" and .status == "True")] | length) == 1
  ' <<<"$node_json" >/dev/null ||
  oci_die "k3s node identity, architecture, version, or readiness is invalid"
for forbidden_addon in traefik servicelb local-path-provisioner; do
  if kubectl --request-timeout=15s \
      get deployment "$forbidden_addon" -n kube-system >/dev/null 2>&1; then
    oci_die "bundled k3s addon must remain disabled: $forbidden_addon"
  fi
done

tags="$(jq -cn --arg sha "$SOURCE_SHA" '{
  "betstan-managed": "true",
  "provider": "oci",
  "betstan-runtime": "k3s",
  "expected-monthly-cost": "0",
  "source-sha": $sha
}')"
volume_name="${OCI_CLUSTER_NAME}-mongo-50g"
volumes="$(
  oci bv volume list \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --all
)"
volumes="$(oci_normalize_list_json "$volumes")"
volume_count="$(
  jq -r --arg name "$volume_name" '
    [.data[]? | select(
      ."display-name" == $name and
      ."lifecycle-state" != "TERMINATED"
    )] | length
  ' <<<"$volumes"
)"
[[ "$volume_count" -le 1 ]] ||
  oci_die "multiple Mongo volumes share the managed name"
mongo_volume_ocid="$(
  jq -r --arg name "$volume_name" '
    [.data[]? | select(
      ."display-name" == $name and
      ."lifecycle-state" != "TERMINATED"
    )][0].id // empty
  ' <<<"$volumes"
)"
if [[ -z "$mongo_volume_ocid" ]]; then
  mongo_volume_ocid="$(
    oci bv volume create \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --availability-domain "$acquisition_ad" \
      --display-name "$volume_name" \
      --size-in-gbs "$OCI_MONGO_VOLUME_GB" \
      --vpus-per-gb "$OCI_MONGO_VPUS_PER_GB" \
      --freeform-tags "$tags" \
      --wait-for-state AVAILABLE \
      --query 'data.id' \
      --raw-output
  )"
fi
mongo_volume="$(oci bv volume get --volume-id "$mongo_volume_ocid")"
jq -e \
  --arg ad "$acquisition_ad" \
  --argjson size "$OCI_MONGO_VOLUME_GB" '
    .data."availability-domain" == $ad and
    .data."size-in-gbs" == $size and
    .data."vpus-per-gb" == 0 and
    .data."lifecycle-state" == "AVAILABLE" and
    .data."freeform-tags"."betstan-managed" == "true" and
    .data."freeform-tags"."betstan-runtime" == "k3s" and
    .data."freeform-tags"."expected-monthly-cost" == "0"
  ' <<<"$mongo_volume" >/dev/null ||
  oci_die "Mongo block volume differs from the approved 50 GB contract"

attachments="$(
  oci compute volume-attachment list \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --instance-id "$acquisition_instance_ocid" \
    --all
)"
attachments="$(oci_normalize_list_json "$attachments")"
attachment_id="$(
  jq -r --arg volume "$mongo_volume_ocid" '
    [.data[]? | select(
      ."volume-id" == $volume and
      ."lifecycle-state" != "DETACHED"
    )] as $matches |
    if ($matches | length) == 1 then $matches[0].id else empty end
  ' <<<"$attachments"
)"
if [[ -z "$attachment_id" ]]; then
  attachment_id="$(
    oci compute volume-attachment attach-paravirtualized-volume \
      --instance-id "$acquisition_instance_ocid" \
      --volume-id "$mongo_volume_ocid" \
      --device "$OCI_MONGO_DEVICE" \
      --display-name "${OCI_CLUSTER_NAME}-mongo-attachment" \
      --is-read-only false \
      --is-shareable false \
      --wait-for-state ATTACHED \
      --query 'data.id' \
      --raw-output
  )"
fi
attachment="$(oci compute volume-attachment get --volume-attachment-id "$attachment_id")"
jq -e \
  --arg instance "$acquisition_instance_ocid" \
  --arg volume "$mongo_volume_ocid" \
  --arg device "$OCI_MONGO_DEVICE" '
    .data."instance-id" == $instance and
    .data."volume-id" == $volume and
    .data.device == $device and
    (.data."attachment-type" | ascii_downcase) == "paravirtualized" and
    .data."is-read-only" == false and
    .data."is-shareable" == false and
    .data."lifecycle-state" == "ATTACHED"
  ' <<<"$attachment" >/dev/null ||
  oci_die "Mongo volume attachment differs from the approved contract"

unset target_private_key target_known_hosts instance_private_ip os_user
unset local_ssh_port ssh_tunnel_pid
# shellcheck disable=SC1090
source "$K3S_ACCESS_STATE_FILE"
for access_value in \
  "${target_private_key:-}" "${target_known_hosts:-}" \
  "${instance_private_ip:-}" "${os_user:-}" "${local_ssh_port:-}" \
  "${ssh_tunnel_pid:-}"; do
  [[ -n "$access_value" ]] ||
    oci_die "k3s access state is incomplete"
done
[[ "$instance_private_ip" == "$acquisition_private_ip" ]] ||
  oci_die "k3s access state targets an unexpected private IP"
[[ -f "$target_private_key" ]] ||
  oci_die "target SSH private key is missing"
[[ -f "$target_known_hosts" ]] ||
  oci_die "target SSH known-hosts file is missing"
[[ "$local_ssh_port" =~ ^[1-9][0-9]{3,4}$ ]] ||
  oci_die "target SSH local port is invalid"
(( local_ssh_port >= 1024 && local_ssh_port <= 65535 )) ||
  oci_die "target SSH local port is invalid"
kill -0 "$ssh_tunnel_pid" 2>/dev/null ||
  oci_die "target SSH Bastion tunnel is not running"
[[ "$os_user" == "ubuntu" ]] ||
  oci_die "unexpected k3s operating-system user"

ssh \
  -i "$target_private_key" \
  -p "$local_ssh_port" \
  -o BatchMode=yes \
  -o CheckHostIP=no \
  -o ConnectTimeout=10 \
  -o HostKeyAlias="$acquisition_instance_ocid" \
  -o IdentitiesOnly=yes \
  -o PasswordAuthentication=no \
  -o PreferredAuthentications=publickey \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$target_known_hosts" \
  "${os_user}@127.0.0.1" \
  "bash -s -- '$OCI_MONGO_DEVICE'" <<'REMOTE'
set -euo pipefail
device="$1"
mount_path=/var/lib/betstan/mongo
[[ "$device" == /dev/oracleoci/oraclevdb ]] ||
  { echo "unexpected Mongo device" >&2; exit 1; }
for _ in $(seq 1 60); do
  sudo test -b "$device" && break
  sleep 5
done
sudo test -b "$device" ||
  { echo "Mongo block device did not appear" >&2; exit 1; }
filesystem="$(sudo blkid -s TYPE -o value "$device" 2>/dev/null || true)"
if [[ -z "$filesystem" ]]; then
  sudo mkfs.ext4 -F "$device" >/dev/null
elif [[ "$filesystem" != "ext4" ]]; then
  echo "Mongo block volume contains an unexpected filesystem" >&2
  exit 1
fi
uuid="$(sudo blkid -s UUID -o value "$device")"
[[ "$uuid" =~ ^[0-9a-f-]+$ ]] ||
  { echo "Mongo filesystem UUID is invalid" >&2; exit 1; }
fstab_entry="UUID=$uuid $mount_path ext4 defaults,x-systemd.device-timeout=180 0 2"
if sudo grep -F " $mount_path " /etc/fstab >/dev/null; then
  sudo grep -Fx "$fstab_entry" /etc/fstab >/dev/null ||
    { echo "existing Mongo fstab entry differs" >&2; exit 1; }
else
  printf '%s\n' "$fstab_entry" | sudo tee -a /etc/fstab >/dev/null
fi
sudo mkdir -p "$mount_path"
if mountpoint -q "$mount_path"; then
  [[ "$(findmnt -n -o UUID --target "$mount_path")" == "$uuid" ]] ||
    { echo "Mongo path is mounted from an unexpected volume" >&2; exit 1; }
else
  sudo mount "$mount_path"
fi
sudo chown 999:999 "$mount_path"
sudo chmod 0700 "$mount_path"
sudo test "$(findmnt -n -o FSTYPE --target "$mount_path")" = ext4
sudo systemctl is-active --quiet k3s
REMOTE

load_balancers="$(
  oci lb load-balancer list \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --display-name "$OCI_LB_NAME" \
    --all
)"
load_balancers="$(oci_normalize_list_json "$load_balancers")"
lb_count="$(
  jq '[.data[]? | select(."lifecycle-state" != "DELETED")] | length' \
    <<<"$load_balancers"
)"
[[ "$lb_count" -le 1 ]] ||
  oci_die "multiple OCI load balancers share the managed name"
lb_ocid="$(
  jq -r '
    [.data[]? | select(."lifecycle-state" != "DELETED")][0].id // empty
  ' <<<"$load_balancers"
)"
if [[ -z "$lb_ocid" ]]; then
  subnet_ids="$(jq -cn --arg id "$network_lb_subnet_ocid" '[$id]')"
  nsg_ids="$(jq -cn --arg id "$network_lb_nsg_ocid" '[$id]')"
  shape_details="$(
    jq -cn \
      --argjson min "$OCI_LB_MIN_MBPS" \
      --argjson max "$OCI_LB_MAX_MBPS" \
      '{minimumBandwidthInMbps:$min,maximumBandwidthInMbps:$max}'
  )"
  oci lb load-balancer create \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --display-name "$OCI_LB_NAME" \
    --shape-name flexible \
    --shape-details "$shape_details" \
    --subnet-ids "$subnet_ids" \
    --nsg-ids "$nsg_ids" \
    --is-private false \
    --freeform-tags "$tags" \
    --wait-for-state SUCCEEDED \
    --max-wait-seconds 1200 >/dev/null
  load_balancers="$(
    oci lb load-balancer list \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --display-name "$OCI_LB_NAME" \
      --all
  )"
  load_balancers="$(oci_normalize_list_json "$load_balancers")"
  lb_ocid="$(
    jq -r '
      [.data[]? | select(."lifecycle-state" != "DELETED")] as $matches |
      if ($matches | length) == 1 then $matches[0].id else empty end
    ' <<<"$load_balancers"
  )"
fi
[[ -n "$lb_ocid" ]] ||
  oci_die "OCI load balancer creation did not return the managed load balancer"
load_balancer="$(oci lb load-balancer get --load-balancer-id "$lb_ocid")"
jq -e \
  --arg subnet "$network_lb_subnet_ocid" \
  --arg nsg "$network_lb_nsg_ocid" \
  --argjson min "$OCI_LB_MIN_MBPS" \
  --argjson max "$OCI_LB_MAX_MBPS" '
    .data."lifecycle-state" == "ACTIVE" and
    .data."is-private" == false and
    .data."shape-name" == "flexible" and
    .data."shape-details"."minimum-bandwidth-in-mbps" == $min and
    .data."shape-details"."maximum-bandwidth-in-mbps" == $max and
    (.data."subnet-ids" | sort) == ([$subnet] | sort) and
    (.data."network-security-group-ids" | sort) == ([$nsg] | sort) and
    .data."freeform-tags"."betstan-managed" == "true" and
    .data."freeform-tags"."betstan-runtime" == "k3s" and
    .data."freeform-tags"."expected-monthly-cost" == "0"
  ' <<<"$load_balancer" >/dev/null ||
  oci_die "OCI load balancer differs from the approved public 10/10 Mbps contract"

ensure_backend_set() {
  local name="$1"
  local port="$2"
  local backend_sets
  backend_sets="$(oci lb backend-set list --load-balancer-id "$lb_ocid" --all)"
  backend_sets="$(oci_normalize_list_json "$backend_sets")"
  local count
  count="$(jq -r --arg name "$name" '[.data[]? | select(.name == $name)] | length' <<<"$backend_sets")"
  [[ "$count" -le 1 ]] || oci_die "duplicate load balancer backend set: $name"
  if [[ "$count" == "0" ]]; then
    oci lb backend-set create \
      --load-balancer-id "$lb_ocid" \
      --name "$name" \
      --policy ROUND_ROBIN \
      --health-checker-protocol TCP \
      --health-checker-port "$port" \
      --health-checker-interval-in-ms 10000 \
      --health-checker-timeout-in-ms 3000 \
      --health-checker-retries 3 \
      --wait-for-state SUCCEEDED \
      --max-wait-seconds 600 >/dev/null
  fi
  local backend_set
  backend_set="$(
    oci lb backend-set get \
      --load-balancer-id "$lb_ocid" \
      --backend-set-name "$name"
  )"
  jq -e --argjson port "$port" '
    .data.policy == "ROUND_ROBIN" and
    .data."health-checker".protocol == "TCP" and
    .data."health-checker".port == $port and
    .data."health-checker"."interval-in-millis" == 10000 and
    .data."health-checker"."timeout-in-millis" == 3000 and
    .data."health-checker".retries == 3
  ' <<<"$backend_set" >/dev/null ||
    oci_die "load balancer backend set differs from the approved contract: $name"
}

ensure_backend() {
  local backend_set_name="$1"
  local port="$2"
  local backends
  backends="$(
    oci lb backend list \
      --load-balancer-id "$lb_ocid" \
      --backend-set-name "$backend_set_name" \
      --all
  )"
  backends="$(oci_normalize_list_json "$backends")"
  local count
  count="$(
    jq -r \
      --arg ip "$acquisition_private_ip" \
      --argjson port "$port" '
        [.data[]? | select(."ip-address" == $ip and .port == $port)] | length
      ' <<<"$backends"
  )"
  [[ "$count" -le 1 ]] ||
    oci_die "duplicate load balancer backend: $backend_set_name"
  [[ "$(jq -r '.data | length' <<<"$backends")" == "$count" ]] ||
    oci_die "load balancer backend set contains an unexpected target: $backend_set_name"
  if [[ "$count" == "0" ]]; then
    oci lb backend create \
      --load-balancer-id "$lb_ocid" \
      --backend-set-name "$backend_set_name" \
      --ip-address "$acquisition_private_ip" \
      --port "$port" \
      --weight 1 \
      --backup false \
      --drain false \
      --offline false \
      --wait-for-state SUCCEEDED \
      --max-wait-seconds 600 >/dev/null
  fi
  local backend
  backend="$(
    oci lb backend get \
      --load-balancer-id "$lb_ocid" \
      --backend-set-name "$backend_set_name" \
      --backend-name "${acquisition_private_ip}:${port}"
  )"
  jq -e \
    --arg ip "$acquisition_private_ip" \
    --argjson port "$port" '
      .data."ip-address" == $ip and
      .data.port == $port and
      .data.weight == 1 and
      .data.backup == false and
      .data.drain == false and
      .data.offline == false
    ' <<<"$backend" >/dev/null ||
    oci_die "load balancer backend differs from the approved contract: $backend_set_name"
}

ensure_listener() {
  local name="$1"
  local port="$2"
  local backend_set_name="$3"
  local current_lb
  current_lb="$(oci lb load-balancer get --load-balancer-id "$lb_ocid")"
  local count
  count="$(jq -r --arg name "$name" 'if .data.listeners[$name] then 1 else 0 end' <<<"$current_lb")"
  if [[ "$count" == "0" ]]; then
    oci lb listener create \
      --load-balancer-id "$lb_ocid" \
      --name "$name" \
      --default-backend-set-name "$backend_set_name" \
      --port "$port" \
      --protocol TCP \
      --wait-for-state SUCCEEDED \
      --max-wait-seconds 600 >/dev/null
  fi
  current_lb="$(oci lb load-balancer get --load-balancer-id "$lb_ocid")"
  jq -e \
    --arg name "$name" \
    --arg backend_set "$backend_set_name" \
    --argjson port "$port" '
      .data.listeners[$name].name == $name and
      .data.listeners[$name].port == $port and
      .data.listeners[$name].protocol == "TCP" and
      .data.listeners[$name]."default-backend-set-name" == $backend_set
    ' <<<"$current_lb" >/dev/null ||
    oci_die "load balancer listener differs from the approved contract: $name"
}

ensure_backend_set betstan-http 30080
ensure_backend betstan-http 30080
ensure_listener betstan-http 80 betstan-http
ensure_backend_set betstan-https 30443
ensure_backend betstan-https 30443
ensure_listener betstan-https 443 betstan-https

work_dir="$PROVENANCE_DIR/k3s-addons-work"
rm -rf -- "$work_dir"
oci_prepare_private_dir "$work_dir"
cleanup_addon_work() {
  rm -rf -- "$work_dir"
}
trap cleanup_addon_work EXIT

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
  --namespace ingress-nginx \
  --create-namespace \
  --values "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml" \
  --wait \
  --timeout 15m
helm upgrade --install cert-manager "$cert_chart" \
  --namespace cert-manager \
  --create-namespace \
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
  --wait \
  --timeout 15m

ingress_service="$(
  kubectl --request-timeout=15s \
    get service ingress-nginx-controller -n ingress-nginx -o json
)"
jq -e '
  .spec.type == "NodePort" and
  ([.spec.ports[] | select(
    .name == "http" and .port == 80 and .nodePort == 30080
  )] | length) == 1 and
  ([.spec.ports[] | select(
    .name == "https" and .port == 443 and .nodePort == 30443
  )] | length) == 1 and
  ((.status.loadBalancer.ingress // []) | length) == 0
' <<<"$ingress_service" >/dev/null ||
  oci_die "k3s ingress service differs from the fixed NodePort contract"

lb_public_ip="$(
  jq -r '
    [.data."ip-addresses"[]? | select(."is-public" == true)][0]."ip-address" // empty
  ' <<<"$load_balancer"
)"
oci_validate_public_ipv4 "$lb_public_ip" ||
  oci_die "OCI load balancer did not receive a globally routable IPv4"

for backend_spec in "betstan-http:${acquisition_private_ip}:30080" "betstan-https:${acquisition_private_ip}:30443"; do
  IFS=: read -r backend_set_name backend_ip backend_port <<<"$backend_spec"
  backend_healthy=0
  for _ in $(seq 1 60); do
    health="$(
      oci lb backend-health get \
        --load-balancer-id "$lb_ocid" \
        --backend-set-name "$backend_set_name" \
        --backend-name "${backend_ip}:${backend_port}" \
        --query 'data.status' \
        --raw-output 2>/dev/null || true
    )"
    if [[ "$health" == "OK" ]]; then
      backend_healthy=1
      break
    fi
    sleep 10
  done
  [[ "$backend_healthy" == "1" ]] ||
    oci_die "OCI load balancer backend did not become healthy: $backend_set_name"
done

oci_prepare_private_dir "$PROVENANCE_DIR"
{
  printf 'source_sha=%q\n' "$SOURCE_SHA"
  printf 'infrastructure_run_id=%q\n' "${GITHUB_RUN_ID:-local}"
  printf 'infrastructure_run_attempt=%q\n' "${GITHUB_RUN_ATTEMPT:-1}"
  printf 'runtime_mode=%q\n' "k3s"
  printf 'network_prepared=%q\n' "true"
  printf 'infrastructure_finalized=%q\n' "true"
  printf 'region=%q\n' "$OCI_REGION"
  printf 'compartment_ocid=%q\n' "$OCI_COMPARTMENT_OCID"
  printf 'vcn_ocid=%q\n' "$network_vcn_ocid"
  printf 'vcn_fingerprint=%q\n' "$network_vcn_fingerprint"
  printf 'worker_nsg_ocid=%q\n' "$network_worker_nsg_ocid"
  printf 'lb_nsg_ocid=%q\n' "$network_lb_nsg_ocid"
  printf 'worker_subnet_ocid=%q\n' "$network_worker_subnet_ocid"
  printf 'lb_subnet_ocid=%q\n' "$network_lb_subnet_ocid"
  printf 'bastion_ocid=%q\n' "$network_bastion_ocid"
  printf 'bastion_fingerprint=%q\n' "$network_bastion_fingerprint"
  printf 'instance_ocid=%q\n' "$acquisition_instance_ocid"
  printf 'instance_fingerprint=%q\n' "$acquisition_instance_fingerprint"
  printf 'instance_private_ip=%q\n' "$acquisition_private_ip"
  printf 'instance_public_ip=%q\n' "$acquisition_public_ip"
  printf 'availability_domain=%q\n' "$acquisition_ad"
  printf 'boot_volume_ocid=%q\n' "$acquisition_boot_volume_ocid"
  printf 'mongo_volume_ocid=%q\n' "$mongo_volume_ocid"
  printf 'OCI_MONGO_VOLUME_OCID=%q\n' "$mongo_volume_ocid"
  printf 'mongo_volume_attachment_ocid=%q\n' "$attachment_id"
  printf 'lb_ocid=%q\n' "$lb_ocid"
  printf 'ingress_ipv4=%q\n' "$lb_public_ip"
  printf 'public_host=%q\n' "${lb_public_ip}.nip.io"
  printf 'namespace=%q\n' "$OCI_K8S_NAMESPACE"
  printf 'k3s_node_name=%q\n' "$OCI_K3S_NODE_NAME"
  printf 'k3s_version=%q\n' "$OCI_K3S_VERSION"
  printf 'target_ssh_public_key_sha256=%q\n' \
    "$acquisition_target_ssh_public_key_sha256"
  printf 'node_shape=%q\n' "VM.Standard.A1.Flex"
  printf 'node_ocpus=%q\n' "2"
  printf 'node_memory_gb=%q\n' "12"
  printf 'boot_volume_gb=%q\n' "$OCI_BOOT_VOLUME_GB"
  printf 'boot_volume_vpus_per_gb=%q\n' "$OCI_BOOT_VOLUME_VPUS_PER_GB"
  printf 'mongo_volume_gb=%q\n' "$OCI_MONGO_VOLUME_GB"
  printf 'lb_min_mbps=%q\n' "$OCI_LB_MIN_MBPS"
  printf 'lb_max_mbps=%q\n' "$OCI_LB_MAX_MBPS"
  printf 'expected_monthly_cost=%q\n' "$OCI_EXPECTED_MONTHLY_COST"
  printf 'ingress_nginx_chart_version=%q\n' "$OCI_INGRESS_NGINX_CHART_VERSION"
  printf 'ingress_nginx_chart_sha256=%q\n' "$OCI_INGRESS_NGINX_CHART_SHA256"
  printf 'cert_manager_chart_version=%q\n' "$OCI_CERT_MANAGER_CHART_VERSION"
  printf 'cert_manager_chart_sha256=%q\n' "$OCI_CERT_MANAGER_CHART_SHA256"
  printf 'cert_manager_controller_digest=%q\n' "$OCI_CERT_MANAGER_CONTROLLER_DIGEST"
  printf 'cert_manager_webhook_digest=%q\n' "$OCI_CERT_MANAGER_WEBHOOK_DIGEST"
  printf 'cert_manager_cainjector_digest=%q\n' "$OCI_CERT_MANAGER_CAINJECTOR_DIGEST"
  printf 'cert_manager_acmesolver_digest=%q\n' "$OCI_CERT_MANAGER_ACMESOLVER_DIGEST"
  printf 'cert_manager_startup_digest=%q\n' "$OCI_CERT_MANAGER_STARTUP_DIGEST"
} > "$PROVENANCE_FILE"
chmod 600 "$PROVENANCE_FILE"
INVENTORY_MODE=complete OUTPUT_FILE="$INVENTORY_FILE" "$SCRIPT_DIR/inventory.sh"

rm -rf -- "$work_dir"
trap - EXIT
oci_log "oci_k3s_finalize=PASS load_balancer_count=1 bandwidth=10/10"
