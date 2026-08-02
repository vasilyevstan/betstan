#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=capacity-common.sh
source "$SCRIPT_DIR/capacity-common.sh"

WORK_DIR="${WORK_DIR:-$(mktemp -d)}"
PROVENANCE_DIR="${PROVENANCE_DIR:-$OCI_ROOT_DIR/artifacts/oci-capacity}"
REPORT_FILE="$WORK_DIR/capacity-report.json"
USER_DATA_FILE="$WORK_DIR/cloud-init.yaml"
SSH_PUBLIC_KEY_FILE="$WORK_DIR/k3s-ssh.pub"
ERROR_FILE="$WORK_DIR/launch-error.log"
OCI_CAPACITY_RUN_NUMBER="${OCI_CAPACITY_RUN_NUMBER:-1}"

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

oci_capacity_require_contract
oci_require_cli_version
oci_capacity_require_home_region
oci_capacity_require_quota
[[ "$OCI_CAPACITY_RUN_NUMBER" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "OCI_CAPACITY_RUN_NUMBER must be a positive integer"

existing_count="$(oci_capacity_require_singleton)"
if [[ "$existing_count" == "1" ]]; then
  PROVENANCE_DIR="$PROVENANCE_DIR" "$SCRIPT_DIR/reconcile-capacity.sh" record
  oci_capacity_output acquisition_status ALREADY_ACQUIRED
  oci_log "capacity_acquisition=ALREADY_ACQUIRED"
  exit 0
fi

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"
network="$(oci_capacity_discover_network)"
IFS=$'\t' read -r _vcn_id subnet_id nsg_id <<<"$network"

OUTPUT_FILE="$REPORT_FILE" "$SCRIPT_DIR/capacity-report.sh" >/dev/null
candidate="$(
  python3 - "$REPORT_FILE" "$OCI_CAPACITY_RUN_NUMBER" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    report = json.load(stream)
run_number = int(sys.argv[2])
candidates = report["candidates"]
available = [item for item in candidates if item["status"] == "AVAILABLE"]
if available:
    for memory in report["profiles"]:
        matching = [item for item in available if item["memory_gb"] == memory]
        if matching:
            choice = matching[(run_number - 1) % len(matching)]
            break
else:
    if not candidates:
        raise SystemExit("capacity report has no candidates")
    choice = candidates[(run_number - 1) % len(candidates)]
print(json.dumps(choice, separators=(",", ":")))
PY
)"
availability_domain="$(jq -r '.availability_domain' <<<"$candidate")"
memory_gb="$(jq -r '.memory_gb' <<<"$candidate")"
reported_status="$(jq -r '.status' <<<"$candidate")"

OCI_K3S_VERSION="$OCI_K3S_VERSION" \
OCI_K3S_BINARY_SHA256="$OCI_K3S_BINARY_SHA256" \
  "$SCRIPT_DIR/bootstrap-k3s.sh" render-cloud-init > "$USER_DATA_FILE"
printf '%s\n' "$OCI_K3S_SSH_PUBLIC_KEY" > "$SSH_PUBLIC_KEY_FILE"
chmod 600 "$USER_DATA_FILE" "$SSH_PUBLIC_KEY_FILE"

tags="$(oci_capacity_tags)"
source_details="$(
  jq -cn \
    --arg image "$OCI_K3S_IMAGE_OCID" \
    --argjson size "$OCI_BOOT_VOLUME_GB" '
      {
        sourceType: "image",
        imageId: $image,
        bootVolumeSizeInGBs: $size,
        bootVolumeVpusPerGB: 0
      }
    '
)"
shape_config="$(
  jq -cn \
    --argjson ocpus "$OCI_A1_OCPUS" \
    --argjson memory "$memory_gb" \
    '{ocpus:$ocpus,memoryInGBs:$memory}'
)"
vnic_details="$(
  jq -cn \
    --arg subnet "$subnet_id" \
    --arg nsg "$nsg_id" \
    --argjson tags "$tags" '
      {
        subnetId: $subnet,
        assignPublicIp: true,
        assignPrivateDnsRecord: true,
        nsgIds: [$nsg],
        displayName: "betstan-k3s-primary",
        freeformTags: $tags
      }
    '
)"
agent_config='{
  "isManagementDisabled": false,
  "areAllPluginsDisabled": false,
  "pluginsConfig": [
    {"name": "Bastion", "desiredState": "ENABLED"},
    {"name": "Compute Instance Run Command", "desiredState": "ENABLED"}
  ]
}'

set +e
instance_id="$(
  oci compute instance launch \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --availability-domain "$availability_domain" \
    --shape "$OCI_NODE_SHAPE" \
    --shape-config "$shape_config" \
    --source-details "$source_details" \
    --create-vnic-details "$vnic_details" \
    --display-name "$OCI_K3S_INSTANCE_NAME" \
    --hostname-label betstank3s \
    --freeform-tags "$tags" \
    --ssh-authorized-keys-file "$SSH_PUBLIC_KEY_FILE" \
    --user-data-file "$USER_DATA_FILE" \
    --is-pv-encryption-in-transit-enabled true \
    --agent-config "$agent_config" \
    --wait-for-state RUNNING \
    --wait-interval-seconds 15 \
    --max-wait-seconds 900 \
    --query 'data.id' \
    --raw-output 2>"$ERROR_FILE"
)"
launch_status=$?
set -e

if [[ "$launch_status" != "0" ]]; then
  if grep -Eiq \
      'OutOfHostCapacity|OUT_OF_HOST_CAPACITY|out of host capacity' \
      "$ERROR_FILE"; then
    PROVENANCE_DIR="$PROVENANCE_DIR" "$SCRIPT_DIR/reconcile-capacity.sh" cleanup >/dev/null
    oci_capacity_output instance_acquired false
    oci_capacity_output acquisition_status CAPACITY_UNAVAILABLE
    oci_log \
      "capacity_acquisition=CAPACITY_UNAVAILABLE report=$reported_status memory_gb=$memory_gb"
    exit 0
  fi
  redacted="$(oci_redact < "$ERROR_FILE")"
  oci_die "A1 launch failed with a non-capacity error: $redacted"
fi

oci_require_ocid_value="$instance_id"
[[ "$oci_require_ocid_value" =~ ^ocid1\.instance\.oc[0-9]*\..+ ]] ||
  oci_die "OCI launch did not return an instance OCID"

PROVENANCE_DIR="$PROVENANCE_DIR" "$SCRIPT_DIR/reconcile-capacity.sh" record
oci_capacity_output acquisition_status ACQUIRED
oci_log \
  "capacity_acquisition=ACQUIRED report=$reported_status memory_gb=$memory_gb expected_monthly_cost=0"
