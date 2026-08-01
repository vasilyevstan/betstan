#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
# shellcheck source=../scripts/lib.sh
source "$OCI_DIR/scripts/lib.sh"

INFRA_PROVENANCE_FILE="${INFRA_PROVENANCE_FILE:-}"
oci_require_vars INFRA_PROVENANCE_FILE
[[ -f "$INFRA_PROVENANCE_FILE" ]] || oci_die "infrastructure provenance file is missing"
unset cluster_ocid cluster_fingerprint
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
[[ "$(oci_fingerprint "$cluster_ocid")" == "$cluster_fingerprint" ]] ||
  oci_die "node diagnostics cluster fingerprint mismatch"
kubeconfig_json="$(kubectl config view --raw --minify -o json)"
jq -e --arg cluster "$cluster_ocid" \
  '[.users[].user.exec.args[]? | select(. == $cluster)] | length == 1' \
  <<<"$kubeconfig_json" >/dev/null || oci_die "node diagnostics refuse the current kubecontext"

{
  echo "=== node identity and pressure ==="
  kubectl get nodes -o json |
    jq -r '.items[] | [
      .metadata.name,
      .status.nodeInfo.architecture,
      .metadata.labels["node.kubernetes.io/instance-type"],
      ([.status.conditions[] | select(.type == "Ready")][0].status // "Unknown"),
      ([.status.conditions[] | select(.type == "MemoryPressure")][0].status // "Unknown"),
      ([.status.conditions[] | select(.type == "DiskPressure")][0].status // "Unknown"),
      ([.status.conditions[] | select(.type == "PIDPressure")][0].status // "Unknown"),
      ([.status.conditions[] | select(.type == "NetworkUnavailable")][0].status // "False")
    ] | @tsv'

  echo "=== node metrics ==="
  kubectl top nodes --no-headers

  echo "=== node warning events ==="
  kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp -o json |
    jq -r '.items[-80:][]? | [.reason, .regarding.kind, .regarding.name, .message] | @tsv'
} | oci_redact
