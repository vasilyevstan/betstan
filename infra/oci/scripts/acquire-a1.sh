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
OUTPUT_FILE="$WORK_DIR/launch-output.log"
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
    --argjson size "$OCI_BOOT_VOLUME_GB" \
    --argjson vpus "$OCI_BOOT_VOLUME_VPUS_PER_GB" '
      {
        sourceType: "image",
        imageId: $image,
        bootVolumeSizeInGBs: $size,
        bootVolumeVpusPerGB: $vpus
      }
    '
)"
shape_config="$(
  jq -cn \
    --argjson ocpus "$OCI_A1_OCPUS" \
    --argjson memory "$memory_gb" \
    '{ocpus:$ocpus,memoryInGBs:$memory}'
)"
nsg_ids="$(jq -cn --arg nsg "$nsg_id" '[$nsg]')"
agent_config='{
  "isManagementDisabled": false,
  "areAllPluginsDisabled": false,
  "pluginsConfig": [
    {"name": "Bastion", "desiredState": "ENABLED"},
    {"name": "Compute Instance Run Command", "desiredState": "ENABLED"}
  ]
}'

set +e
oci compute instance launch \
  --compartment-id "$OCI_COMPARTMENT_OCID" \
  --availability-domain "$availability_domain" \
  --shape "$OCI_NODE_SHAPE" \
  --shape-config "$shape_config" \
  --source-details "$source_details" \
  --subnet-id "$subnet_id" \
  --assign-public-ip true \
  --assign-private-dns-record true \
  --nsg-ids "$nsg_ids" \
  --vnic-display-name betstan-k3s-primary \
  --display-name "$OCI_K3S_INSTANCE_NAME" \
  --hostname-label betstank3s \
  --freeform-tags "$tags" \
  --ssh-authorized-keys-file "$SSH_PUBLIC_KEY_FILE" \
  --user-data-file "$USER_DATA_FILE" \
  --is-pv-encryption-in-transit-enabled true \
  --agent-config "$agent_config" \
  --wait-for-state RUNNING \
  --wait-for-state TERMINATED \
  --wait-interval-seconds 15 \
  --max-wait-seconds 900 \
  --query 'data.id' \
  --raw-output >"$OUTPUT_FILE" 2>"$ERROR_FILE"
launch_status=$?
set -e

if [[ "$launch_status" != "0" ]]; then
  launch_error="$(
    {
      cat "$OUTPUT_FILE"
      cat "$ERROR_FILE"
    } | oci_redact
  )"
  if grep -Eiq \
      'OutOfHostCapacity|OUT_OF_HOST_CAPACITY|out of host capacity' \
      <<<"$launch_error"; then
    PROVENANCE_DIR="$PROVENANCE_DIR" "$SCRIPT_DIR/reconcile-capacity.sh" cleanup >/dev/null
    oci_capacity_output instance_acquired false
    oci_capacity_output acquisition_status CAPACITY_UNAVAILABLE
    oci_log \
      "capacity_acquisition=CAPACITY_UNAVAILABLE report=$reported_status memory_gb=$memory_gb"
    exit 0
  fi
  [[ -n "$launch_error" ]] ||
    launch_error="OCI CLI exited with status $launch_status without diagnostics"
  oci_die "A1 launch failed with a non-capacity error: $launch_error"
fi

instance_id="$(<"$OUTPUT_FILE")"
oci_require_ocid_value="$instance_id"
[[ "$oci_require_ocid_value" =~ ^ocid1\.instance\.oc[0-9]*\..+ ]] ||
  oci_die "OCI launch did not return an instance OCID"
instance_state="$(
  oci compute instance get \
    --instance-id "$instance_id" \
    --query 'data."lifecycle-state"' \
    --raw-output
)"
[[ "$instance_state" == "RUNNING" ]] ||
  oci_die "managed A1 launch entered $instance_state before RUNNING"

PROVENANCE_DIR="$PROVENANCE_DIR" "$SCRIPT_DIR/reconcile-capacity.sh" record
oci_capacity_output acquisition_status ACQUIRED
oci_log \
  "capacity_acquisition=ACQUIRED report=$reported_status memory_gb=$memory_gb expected_monthly_cost=0"
