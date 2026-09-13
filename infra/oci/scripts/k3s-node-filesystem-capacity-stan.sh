#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-measure}"
OUTPUT_FILE="${OUTPUT_FILE:-}"
OCI_K3S_NODE_NAME="${OCI_K3S_NODE_NAME:-betstan-k3s}"
OCI_DISK_MAX_PERCENT="${OCI_DISK_MAX_PERCENT:-70}"

fail() {
  echo "k3s_node_filesystem_capacity=${ACTION:-missing} status=FAIL reason=$*" >&2
  exit 1
}

[[ "$ACTION" == "measure" || "$ACTION" == "require-at-most" ]] ||
  fail "usage: $0 {measure|require-at-most}"
[[ "$OCI_K3S_NODE_NAME" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]] ||
  fail "OCI_K3S_NODE_NAME is invalid"
[[ "$OCI_DISK_MAX_PERCENT" == "70" ]] ||
  fail "OCI_DISK_MAX_PERCENT must remain 70"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is unavailable"

nodes_json="$(kubectl get nodes -o json)" ||
  fail "unable to read k3s node identity"
node_name="$(
  jq -er --arg expected "$OCI_K3S_NODE_NAME" '
    if (.items | length) == 1 and .items[0].metadata.name == $expected
    then .items[0].metadata.name
    else error("unexpected k3s node identity")
    end
  ' <<<"$nodes_json"
)" || fail "expected single k3s node is unavailable"
summary_json="$(
  kubectl get --raw "/api/v1/nodes/${node_name}/proxy/stats/summary"
)" || fail "unable to read kubelet filesystem summary"

measurement="$(
  python3 - "$node_name" "$OCI_DISK_MAX_PERCENT" "$summary_json" <<'PY'
import json
import sys

node_name, threshold_text, raw = sys.argv[1:]
try:
    payload = json.loads(raw)
    filesystem = payload["node"]["fs"]
    capacity = int(filesystem["capacityBytes"])
    used = int(filesystem["usedBytes"])
    available = int(filesystem["availableBytes"])
    threshold = int(threshold_text)
except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
    raise SystemExit(f"invalid kubelet filesystem summary: {exc}")
if capacity <= 0 or used < 0 or available < 0 or used > capacity:
    raise SystemExit("invalid kubelet filesystem byte values")
used_percent = round(used / capacity * 100, 2)
print(json.dumps({
    "schemaVersion": "k3s-node-filesystem-capacity.v1",
    "nodeName": node_name,
    "capacityBytes": capacity,
    "usedBytes": used,
    "availableBytes": available,
    "usedPercent": used_percent,
    "thresholdPercent": threshold,
    "withinLimit": used * 100 <= capacity * threshold,
}, sort_keys=True, separators=(",", ":")))
PY
)" || fail "unable to validate kubelet filesystem summary"

if [[ -n "$OUTPUT_FILE" ]]; then
  [[ "$OUTPUT_FILE" != "/" && "$OUTPUT_FILE" != "." && ! -L "$OUTPUT_FILE" ]] ||
    fail "OUTPUT_FILE is unsafe"
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  printf '%s\n' "$measurement" >"$OUTPUT_FILE"
fi
printf '%s\n' "$measurement"

if [[ "$ACTION" == "require-at-most" ]] &&
   [[ "$(jq -r '.withinLimit' <<<"$measurement")" != "true" ]]; then
  fail "root filesystem already exceeds the fixed 70 percent limit"
fi
