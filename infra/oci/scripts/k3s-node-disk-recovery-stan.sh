#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
ACTION="${1:-}"
SOURCE_SHA="${SOURCE_SHA:-}"
INFRASTRUCTURE_RUN_ID="${INFRASTRUCTURE_RUN_ID:-}"
GHCR_BUILD_RUN_ID="${GHCR_BUILD_RUN_ID:-}"
DIAGNOSIS_RUN_ID="${DIAGNOSIS_RUN_ID:-}"
RECLAIM_CATEGORY="${RECLAIM_CATEGORY:-none}"
RECLAIM_IMAGE_IDS="${RECLAIM_IMAGE_IDS:-[]}"
SESSION_STATE_FILE="${SESSION_STATE_FILE:-}"
CANDIDATE_IMAGES_FILE="${CANDIDATE_IMAGES_FILE:-}"
GHCR_PACKAGE_VALIDATION_FILE="${GHCR_PACKAGE_VALIDATION_FILE:-}"
GHCR_GENERATIONS_FILE="${GHCR_GENERATIONS_FILE:-}"
DIAGNOSIS_FILE="${DIAGNOSIS_FILE:-}"
INFRA_PROVENANCE_FILE="${INFRA_PROVENANCE_FILE:-}"
OUTPUT_FILE="${OUTPUT_FILE:-}"
WORK_DIR="${WORK_DIR:-${RUNNER_TEMP:-$PWD}/k3s-disk-recovery-work}"
REMOTE_RUNNER="${K3S_DISK_REMOTE_RUNNER:-}"
EVIDENCE_HELPER="$SCRIPT_DIR/k3s_disk_recovery_stan.py"
CAPACITY_HELPER="$SCRIPT_DIR/k3s-node-filesystem-capacity-stan.sh"
REMOTE_SCRIPT="$SCRIPT_DIR/k3s-node-disk-remote-stan.sh"

fail() {
  echo "k3s_disk_recovery=${ACTION:-missing} status=FAIL reason=$*" >&2
  exit 1
}

[[ "$ACTION" == "diagnose" || "$ACTION" == "reclaim" ]] ||
  fail "usage: $0 {diagnose|reclaim}"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "SOURCE_SHA is invalid"
[[ "$INFRASTRUCTURE_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "INFRASTRUCTURE_RUN_ID is invalid"
[[ "$GHCR_BUILD_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "GHCR_BUILD_RUN_ID is invalid"
[[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] ||
  fail "GITHUB_RUN_ID is invalid"
[[ "${GITHUB_RUN_ATTEMPT:-}" == "1" ]] ||
  fail "disk recovery requires first workflow attempt"
[[ -n "$SESSION_STATE_FILE" && -f "$SESSION_STATE_FILE" ]] ||
  fail "SESSION_STATE_FILE is unavailable"
[[ -n "$CANDIDATE_IMAGES_FILE" && -f "$CANDIDATE_IMAGES_FILE" ]] ||
  fail "candidate image evidence is unavailable"
[[ -n "$INFRA_PROVENANCE_FILE" && -f "$INFRA_PROVENANCE_FILE" ]] ||
  fail "bound infrastructure provenance is unavailable"
[[ -n "$OUTPUT_FILE" && "$OUTPUT_FILE" != "/" && "$OUTPUT_FILE" != "." ]] ||
  fail "OUTPUT_FILE is required"
[[ ! -L "$OUTPUT_FILE" ]] || fail "OUTPUT_FILE must not be a symbolic link"
for command_name in jq python3 sha256sum base64; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command is unavailable: $command_name"
done

mkdir -p "$WORK_DIR" "$(dirname "$OUTPUT_FILE")"
chmod 700 "$WORK_DIR"
runtime_before="$WORK_DIR/runtime-before.json"
capacity_before="$WORK_DIR/capacity-before.json"
reclaim_plan="$WORK_DIR/reclaim-plan.json"
runtime_after="$WORK_DIR/runtime-after.json"
capacity_after="$WORK_DIR/capacity-after.json"

unset canonical_host k3s_node_name
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
[[ "${canonical_host:-}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ &&
   "$canonical_host" == *.* ]] ||
  fail "bound canonical host is invalid"
[[ "${k3s_node_name:-}" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  fail "bound k3s node name is invalid"
[[ "${OCI_K3S_NODE_NAME:-$k3s_node_name}" == "$k3s_node_name" ]] ||
  fail "configured k3s node name differs from bound infrastructure"

unset target_private_key target_known_hosts instance_ocid instance_private_ip os_user
unset local_ssh_port ssh_tunnel_pid
# shellcheck disable=SC1090
source "$SESSION_STATE_FILE"
for access_value in \
  "${target_private_key:-}" "${target_known_hosts:-}" "${instance_ocid:-}" \
  "${instance_private_ip:-}" "${os_user:-}" "${local_ssh_port:-}" \
  "${ssh_tunnel_pid:-}"; do
  [[ -n "$access_value" ]] || fail "k3s access state is incomplete"
done
[[ -f "$target_private_key" && -f "$target_known_hosts" ]] ||
  fail "strict SSH key material is missing"
[[ "$local_ssh_port" =~ ^[1-9][0-9]{3,4}$ ]] ||
  fail "target SSH local port is invalid"
(( local_ssh_port >= 1024 && local_ssh_port <= 65535 )) ||
  fail "target SSH local port is invalid"
kill -0 "$ssh_tunnel_pid" 2>/dev/null ||
  fail "target SSH Bastion tunnel is not running"
[[ "$os_user" == "ubuntu" ]] || fail "unexpected k3s operating-system user"

run_remote() {
  local remote_action="$1"
  local selected="${2:-[]}"
  if [[ -n "$REMOTE_RUNNER" ]]; then
    "$REMOTE_RUNNER" "$remote_action" "$selected"
    return
  fi
  local encoded encoded_host encoded_node
  encoded="$(printf '%s' "$selected" | base64 | tr -d '\n')"
  encoded_host="$(printf '%s' "$canonical_host" | base64 | tr -d '\n')"
  encoded_node="$(printf '%s' "$k3s_node_name" | base64 | tr -d '\n')"
  # The stdin-only node runner uses the same strict parser as ordinary readiness.
  {
    declare -f oci_rabbitmq_queue_rows
    cat "$REMOTE_SCRIPT"
  } | ssh \
    -i "$target_private_key" \
    -p "$local_ssh_port" \
    -o BatchMode=yes \
    -o CheckHostIP=no \
    -o ConnectTimeout=10 \
    -o HostKeyAlias="$instance_ocid" \
    -o IdentitiesOnly=yes \
    -o PasswordAuthentication=no \
    -o PreferredAuthentications=publickey \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$target_known_hosts" \
    "${os_user}@127.0.0.1" \
    "sudo K3S_DISK_SELECTED_IMAGE_IDS_B64=$encoded K3S_DISK_CANONICAL_HOST_B64=$encoded_host K3S_DISK_NODE_NAME_B64=$encoded_node bash -s -- $remote_action"
}

capture_capacity() {
  local output="$1"
  OUTPUT_FILE="$output" \
  OCI_K3S_NODE_NAME="$k3s_node_name" \
  OCI_DISK_MAX_PERCENT=70 \
    "$CAPACITY_HELPER" measure >/dev/null
}

run_remote snapshot "[]" >"$runtime_before" ||
  fail "read-only runtime snapshot failed"
capture_capacity "$capacity_before" ||
  fail "kubelet filesystem cross-check failed"

if [[ "$ACTION" == "diagnose" ]]; then
  [[ "$RECLAIM_CATEGORY" == "none" && "$RECLAIM_IMAGE_IDS" == "[]" ]] ||
    fail "diagnosis does not accept reclaim inputs"
  [[ -z "$DIAGNOSIS_RUN_ID" ]] ||
    fail "diagnosis run ID is not valid during diagnosis"
  "$EVIDENCE_HELPER" diagnose \
    --runtime "$runtime_before" \
    --capacity "$capacity_before" \
    --candidate-images "$CANDIDATE_IMAGES_FILE" \
    --source-sha "$SOURCE_SHA" \
    --infrastructure-run-id "$INFRASTRUCTURE_RUN_ID" \
    --ghcr-build-run-id "$GHCR_BUILD_RUN_ID" \
    --workflow-run-id "$GITHUB_RUN_ID" \
    --output "$OUTPUT_FILE"
  echo "k3s_disk_recovery=diagnose status=PASS manifest=$OUTPUT_FILE"
  exit 0
fi

[[ "$DIAGNOSIS_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "DIAGNOSIS_RUN_ID is invalid"
[[ -n "$DIAGNOSIS_FILE" && -f "$DIAGNOSIS_FILE" ]] ||
  fail "bound diagnosis manifest is unavailable"
"$EVIDENCE_HELPER" validate-diagnosis \
  --diagnosis "$DIAGNOSIS_FILE" \
  --source-sha "$SOURCE_SHA" \
  --infrastructure-run-id "$INFRASTRUCTURE_RUN_ID" \
  --ghcr-build-run-id "$GHCR_BUILD_RUN_ID" \
  --workflow-run-id "$DIAGNOSIS_RUN_ID"
plan_args=(
  --diagnosis "$DIAGNOSIS_FILE"
  --runtime "$runtime_before"
  --capacity "$capacity_before"
  --category "$RECLAIM_CATEGORY"
  --image-ids "$RECLAIM_IMAGE_IDS"
  --output "$reclaim_plan"
)
if [[ "$RECLAIM_CATEGORY" == "cri-owned-unused-images" ]]; then
  [[ -n "$GHCR_PACKAGE_VALIDATION_FILE" &&
     -f "$GHCR_PACKAGE_VALIDATION_FILE" ]] ||
    fail "bound GHCR protected-generation evidence is unavailable"
  [[ -n "$GHCR_GENERATIONS_FILE" &&
     -s "$GHCR_GENERATIONS_FILE" && ! -L "$GHCR_GENERATIONS_FILE" ]] ||
    fail "bound GHCR generation map is unavailable"
  plan_args+=(--protected-generations "$GHCR_PACKAGE_VALIDATION_FILE")
  plan_args+=(--generation-map "$GHCR_GENERATIONS_FILE")
fi
"$EVIDENCE_HELPER" plan-reclaim "${plan_args[@]}"

mutation_succeeded=true
case "$RECLAIM_CATEGORY" in
  apt-package-cache)
    if ! run_remote reclaim-apt-package-cache "[]"; then
      mutation_succeeded=false
    fi
    ;;
  cri-owned-unused-images)
    if ! run_remote reclaim-cri-owned-unused-images "$RECLAIM_IMAGE_IDS"; then
      mutation_succeeded=false
    fi
    ;;
  *)
    fail "unsupported reclaim category"
    ;;
esac

post_capture_succeeded=true
run_remote snapshot "[]" >"$runtime_after" || post_capture_succeeded=false
capture_capacity "$capacity_after" || post_capture_succeeded=false
if [[ "$post_capture_succeeded" != "true" ]]; then
  "$EVIDENCE_HELPER" write-incomplete-reclaim \
    --diagnosis "$DIAGNOSIS_FILE" \
    --category "$RECLAIM_CATEGORY" \
    --image-ids "$RECLAIM_IMAGE_IDS" \
    --reason post-state-capture-failed \
    --output "$OUTPUT_FILE"
  fail "post-state capture failed after bounded mutation"
fi

set +e
"$EVIDENCE_HELPER" finalize-reclaim \
  --diagnosis "$DIAGNOSIS_FILE" \
  --post-runtime "$runtime_after" \
  --post-capacity "$capacity_after" \
  --category "$RECLAIM_CATEGORY" \
  --image-ids "$RECLAIM_IMAGE_IDS" \
  --mutation-succeeded "$mutation_succeeded" \
  --output "$OUTPUT_FILE"
finalize_status=$?
set -e
[[ "$finalize_status" -eq 0 ]] ||
  fail "reclaim remained incomplete; no alternate category was attempted"
echo "k3s_disk_recovery=reclaim status=PASS manifest=$OUTPUT_FILE"
