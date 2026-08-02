#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="${1:-open}"
INFRA_PROVENANCE_FILE="${INFRA_PROVENANCE_FILE:-}"
ACQUISITION_PROVENANCE_FILE="${ACQUISITION_PROVENANCE_FILE:-}"
SESSION_STATE_FILE="${SESSION_STATE_FILE:-}"
WORK_DIR="${WORK_DIR:-${RUNNER_TEMP:-/tmp}/betstan-k3s-access}"
KUBECONFIG="${KUBECONFIG:-$WORK_DIR/kubeconfig}"
OCI_K3S_LOCAL_API_PORT="${OCI_K3S_LOCAL_API_PORT:-16443}"
OCI_BASTION_SESSION_TTL="${OCI_BASTION_SESSION_TTL:-10800}"
OCI_K3S_OS_USER="${OCI_K3S_OS_USER:-ubuntu}"
OCI_BASTION_DEFAULT_CLIENT_CIDR="${OCI_BASTION_DEFAULT_CLIENT_CIDR:-192.0.2.1/32}"

[[ "$MODE" == "open" || "$MODE" == "cleanup" ]] ||
  oci_die "usage: configure-k3s-access.sh [open|cleanup]"
[[ -n "$SESSION_STATE_FILE" ]] ||
  oci_die "SESSION_STATE_FILE is required"
[[ "$OCI_BASTION_DEFAULT_CLIENT_CIDR" == "192.0.2.1/32" ]] ||
  oci_die "OCI Bastion default CIDR differs from the reviewed non-routable value"

delete_session() {
  local session_id="${1:-}"
  [[ -n "$session_id" ]] || return
  oci bastion session delete \
    --session-id "$session_id" \
    --force \
    --wait-for-state SUCCEEDED \
    --max-wait-seconds 300 >/dev/null
}

reset_bastion_allowlist() {
  local bastion_id="${1:-}"
  [[ -n "$bastion_id" ]] || return
  oci bastion bastion update \
    --bastion-id "$bastion_id" \
    --client-cidr-list "[\"$OCI_BASTION_DEFAULT_CLIENT_CIDR\"]" \
    --force \
    --wait-for-state SUCCEEDED \
    --max-wait-seconds 300 >/dev/null
}

resolve_session_id() {
  local bastion_id="$1"
  local display_name="$2"
  local sessions
  sessions="$(
    oci bastion session list \
      --bastion-id "$bastion_id" \
      --display-name "$display_name" \
      --all
  )"
  sessions="$(oci_normalize_list_json "$sessions")"
  jq -er '
    [.data[]? | select(."lifecycle-state" != "DELETED")] as $matches |
    if ($matches | length) == 0 then ""
    elif ($matches | length) == 1 then $matches[0].id
    else error("duplicate Bastion sessions")
    end
  ' <<<"$sessions"
}

wait_active_session_id() {
  local bastion_id="$1"
  local display_name="$2"
  local sessions state session_id count
  for _ in $(seq 1 60); do
    sessions="$(
      oci bastion session list \
        --bastion-id "$bastion_id" \
        --display-name "$display_name" \
        --all
    )"
    sessions="$(oci_normalize_list_json "$sessions")"
    count="$(
      jq -r '[.data[]? | select(."lifecycle-state" != "DELETED")] | length' \
        <<<"$sessions"
    )"
    [[ "$count" -le 1 ]] ||
      oci_die "multiple OCI Bastion sessions share the managed name"
    state="$(
      jq -r '
        [.data[]? | select(."lifecycle-state" != "DELETED")][0]."lifecycle-state" // empty
      ' <<<"$sessions"
    )"
    session_id="$(
      jq -r '
        [.data[]? | select(."lifecycle-state" != "DELETED")][0].id // empty
      ' <<<"$sessions"
    )"
    if [[ "$state" == "ACTIVE" && -n "$session_id" ]]; then
      printf '%s' "$session_id"
      return
    fi
    [[ "$state" != "FAILED" ]] ||
      oci_die "OCI Bastion session entered FAILED state"
    sleep 5
  done
  oci_die "OCI Bastion session did not become ACTIVE"
}

cleanup_access() {
  local pf_session_id="" managed_session_id="" tunnel_pid="" key_dir=""
  local pf_session_name="" managed_session_name="" bastion_ocid=""
  local failed=0
  if [[ -f "$SESSION_STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$SESSION_STATE_FILE"
  fi
  if [[ -z "$pf_session_id" && -n "$bastion_ocid" && -n "$pf_session_name" ]]; then
    pf_session_id="$(resolve_session_id "$bastion_ocid" "$pf_session_name")" ||
      failed=1
  fi
  if [[ -z "$managed_session_id" && -n "$bastion_ocid" &&
        -n "$managed_session_name" ]]; then
    managed_session_id="$(
      resolve_session_id "$bastion_ocid" "$managed_session_name"
    )" || failed=1
  fi
  if [[ -n "$tunnel_pid" ]] && kill -0 "$tunnel_pid" 2>/dev/null; then
    kill "$tunnel_pid" || failed=1
    wait "$tunnel_pid" 2>/dev/null || true
  fi
  delete_session "$pf_session_id" || failed=1
  delete_session "$managed_session_id" || failed=1
  reset_bastion_allowlist "$bastion_ocid" || failed=1
  rm -f -- "$KUBECONFIG" || failed=1
  rm -f "$SESSION_STATE_FILE" || failed=1
  if [[ -n "$key_dir" && "$key_dir" == "$WORK_DIR/"* ]]; then
    rm -rf -- "$key_dir" || failed=1
  fi
  [[ "$failed" == "0" ]] ||
    oci_die "k3s access cleanup could not revoke every remote and local artifact"
}

cleanup_open_failure() {
  local status=$?
  trap - EXIT
  if [[ "$status" != "0" ]]; then
    cleanup_access || status=1
  fi
  exit "$status"
}

if [[ "$MODE" == "cleanup" ]]; then
  oci_require_cli_version
  oci_require_command jq
  cleanup_access
  oci_log "k3s_access_cleanup=PASS"
  exit 0
fi

oci_assert_repository_root
oci_require_cli_version
oci_require_command jq
oci_require_command kubectl
oci_require_command ssh
oci_require_command ssh-keygen
oci_require_vars OCI_COMPARTMENT_OCID RUNNER_PUBLIC_IPV4
oci_require_ocid OCI_COMPARTMENT_OCID
oci_validate_public_ipv4 "$RUNNER_PUBLIC_IPV4" ||
  oci_die "RUNNER_PUBLIC_IPV4 must be a globally routable IPv4"
[[ "$OCI_K3S_LOCAL_API_PORT" =~ ^[1-9][0-9]{3,4}$ ]] ||
  oci_die "OCI_K3S_LOCAL_API_PORT must be an unprivileged TCP port"
(( OCI_K3S_LOCAL_API_PORT <= 65535 )) ||
  oci_die "OCI_K3S_LOCAL_API_PORT exceeds the TCP port range"
[[ "$OCI_BASTION_SESSION_TTL" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "OCI_BASTION_SESSION_TTL must be a positive integer"
(( OCI_BASTION_SESSION_TTL <= 10800 )) ||
  oci_die "OCI_BASTION_SESSION_TTL exceeds the OCI Bastion maximum"
[[ -f "$INFRA_PROVENANCE_FILE" ]] ||
  oci_die "INFRA_PROVENANCE_FILE is required"

unset runtime_mode instance_ocid cluster_ocid instance_fingerprint
unset instance_private_ip availability_domain bastion_ocid
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
provenance_bastion_ocid="${bastion_ocid:-}"
if [[ -n "$ACQUISITION_PROVENANCE_FILE" ]]; then
  [[ -f "$ACQUISITION_PROVENANCE_FILE" ]] ||
    oci_die "ACQUISITION_PROVENANCE_FILE does not exist"
  unset runtime_mode instance_ocid instance_fingerprint
  unset instance_private_ip private_ip availability_domain
  # shellcheck disable=SC1090
  source "$ACQUISITION_PROVENANCE_FILE"
  instance_private_ip="${instance_private_ip:-${private_ip:-}}"
  bastion_ocid="$provenance_bastion_ocid"
fi
oci_require_vars \
  runtime_mode instance_ocid instance_fingerprint instance_private_ip \
  availability_domain bastion_ocid
[[ "$runtime_mode" == "k3s" ]] ||
  oci_die "k3s access received non-k3s infrastructure provenance"
oci_require_ocid instance_ocid
oci_require_ocid bastion_ocid
[[ "$(oci_fingerprint "$instance_ocid")" == "$instance_fingerprint" ]] ||
  oci_die "k3s instance provenance fingerprint mismatch"

instance="$(
  oci compute instance get --instance-id "$instance_ocid"
)"
jq -e \
  --arg compartment "$OCI_COMPARTMENT_OCID" \
  --arg ad "$availability_domain" '
    .data."compartment-id" == $compartment and
    .data."availability-domain" == $ad and
    .data.shape == "VM.Standard.A1.Flex" and
    .data."lifecycle-state" == "RUNNING" and
    .data."freeform-tags"."betstan-runtime" == "k3s"
  ' <<<"$instance" >/dev/null ||
  oci_die "live k3s instance identity differs from provenance"

vnic_attachments="$(
  oci compute vnic-attachment list \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --instance-id "$instance_ocid" \
    --all
)"
vnic_attachments="$(oci_normalize_list_json "$vnic_attachments")"
vnic_id="$(
  jq -r '
    [.data[]? | select(
      ."lifecycle-state" == "ATTACHED" and
      (."nic-index" // 0) == 0
    )] as $matches |
    if ($matches | length) == 1 then $matches[0]."vnic-id" else empty end
  ' <<<"$vnic_attachments"
)"
[[ -n "$vnic_id" ]] || oci_die "k3s instance primary VNIC is missing"
vnic="$(oci network vnic get --vnic-id "$vnic_id")"
live_private_ip="$(jq -r '.data."private-ip" // empty' <<<"$vnic")"
[[ "$live_private_ip" == "$instance_private_ip" ]] ||
  oci_die "live k3s private IP differs from provenance"

bastion="$(
  oci bastion bastion get --bastion-id "$bastion_ocid"
)"
bastion_endpoint="$(jq -r '.data."bastion-endpoint" // empty' <<<"$bastion")"
[[ "$(jq -r '.data."lifecycle-state"' <<<"$bastion")" == "ACTIVE" ]] ||
  oci_die "OCI Bastion is not ACTIVE"
[[ "$bastion_endpoint" =~ ^[A-Za-z0-9.-]+$ ]] ||
  oci_die "OCI Bastion endpoint is invalid"

runner_cidr="$(jq -cn --arg cidr "${RUNNER_PUBLIC_IPV4}/32" '[$cidr]')"
oci bastion bastion update \
  --bastion-id "$bastion_ocid" \
  --client-cidr-list "$runner_cidr" \
  --force \
  --wait-for-state SUCCEEDED \
  --max-wait-seconds 300 >/dev/null

oci_prepare_private_dir "$WORK_DIR"
key_dir="$WORK_DIR/bastion-keys"
oci_prepare_private_dir "$key_dir"
private_key="$key_dir/id_ed25519"
public_key="${private_key}.pub"
known_hosts="$key_dir/known_hosts"
managed_session_id=""
pf_session_id=""
tunnel_pid=""
managed_session_name="betstan-k3s-managed-${GITHUB_RUN_ID:-local}"
pf_session_name="betstan-k3s-api-${GITHUB_RUN_ID:-local}"
{
  printf 'bastion_ocid=%q\n' "$bastion_ocid"
  printf 'managed_session_id=%q\n' "$managed_session_id"
  printf 'managed_session_name=%q\n' "$managed_session_name"
  printf 'pf_session_id=%q\n' "$pf_session_id"
  printf 'pf_session_name=%q\n' "$pf_session_name"
  printf 'tunnel_pid=%q\n' "$tunnel_pid"
  printf 'key_dir=%q\n' "$key_dir"
  printf 'bastion_endpoint=%q\n' "$bastion_endpoint"
  printf 'private_key=%q\n' "$private_key"
  printf 'known_hosts=%q\n' "$known_hosts"
  printf 'instance_private_ip=%q\n' "$instance_private_ip"
  printf 'os_user=%q\n' "$OCI_K3S_OS_USER"
} > "$SESSION_STATE_FILE"
chmod 600 "$SESSION_STATE_FILE"
trap cleanup_open_failure EXIT
ssh-keygen \
  -q -t ed25519 \
  -C "betstan-bastion-${GITHUB_RUN_ID:-local}" \
  -N "" \
  -f "$private_key"
chmod 600 "$private_key"

plugin_ready=0
for _ in $(seq 1 60); do
  plugin_status="$(
    oci instance-agent plugin get \
      --instanceagent-id "$instance_ocid" \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --plugin-name Bastion \
      --query 'data.status' \
      --raw-output 2>/dev/null || true
  )"
  if [[ "$plugin_status" == "RUNNING" ]]; then
    plugin_ready=1
    break
  fi
  sleep 10
done
[[ "$plugin_ready" == "1" ]] ||
  oci_die "OCI Bastion agent plugin did not become RUNNING"

oci bastion session create-managed-ssh \
  --bastion-id "$bastion_ocid" \
  --display-name "$managed_session_name" \
  --key-type PUB \
  --ssh-public-key-file "$public_key" \
  --session-ttl "$OCI_BASTION_SESSION_TTL" \
  --target-resource-id "$instance_ocid" \
  --target-private-ip "$instance_private_ip" \
  --target-port 22 \
  --target-os-username "$OCI_K3S_OS_USER" \
  --wait-for-state SUCCEEDED \
  --max-wait-seconds 600 >/dev/null
managed_session_id="$(
  wait_active_session_id "$bastion_ocid" "$managed_session_name"
)"
{
  printf 'bastion_ocid=%q\n' "$bastion_ocid"
  printf 'managed_session_id=%q\n' "$managed_session_id"
  printf 'managed_session_name=%q\n' "$managed_session_name"
  printf 'pf_session_id=%q\n' "$pf_session_id"
  printf 'pf_session_name=%q\n' "$pf_session_name"
  printf 'tunnel_pid=%q\n' "$tunnel_pid"
  printf 'key_dir=%q\n' "$key_dir"
  printf 'bastion_endpoint=%q\n' "$bastion_endpoint"
  printf 'private_key=%q\n' "$private_key"
  printf 'known_hosts=%q\n' "$known_hosts"
  printf 'instance_private_ip=%q\n' "$instance_private_ip"
  printf 'os_user=%q\n' "$OCI_K3S_OS_USER"
} > "$SESSION_STATE_FILE"

printf -v quoted_private_key '%q' "$private_key"
printf -v quoted_known_hosts '%q' "$known_hosts"
proxy_command="ssh -i $quoted_private_key -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$quoted_known_hosts -W %h:%p -p 22 ${managed_session_id}@${bastion_endpoint}"
ssh_ready=0
for _ in $(seq 1 30); do
  if ssh \
      -i "$private_key" \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$known_hosts" \
      -o "ProxyCommand=$proxy_command" \
      "${OCI_K3S_OS_USER}@${instance_private_ip}" \
      'sudo test -s /etc/rancher/k3s/k3s.yaml' \
      >/dev/null 2>&1; then
    ssh_ready=1
    break
  fi
  sleep 10
done
[[ "$ssh_ready" == "1" ]] ||
  oci_die "managed SSH Bastion session did not become usable"
mkdir -p "$(dirname "$KUBECONFIG")"
ssh \
  -i "$private_key" \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$known_hosts" \
  -o "ProxyCommand=$proxy_command" \
  "${OCI_K3S_OS_USER}@${instance_private_ip}" \
  'sudo cat /etc/rancher/k3s/k3s.yaml' |
  sed -E \
    "s#server: https://[^:]+:6443#server: https://127.0.0.1:${OCI_K3S_LOCAL_API_PORT}#" \
    > "$KUBECONFIG"
chmod 600 "$KUBECONFIG"
grep -Fq "server: https://127.0.0.1:${OCI_K3S_LOCAL_API_PORT}" "$KUBECONFIG" ||
  oci_die "retrieved k3s kubeconfig has an unexpected server"
KUBECONFIG="$KUBECONFIG" kubectl config view --raw --minify >/dev/null ||
  oci_die "retrieved k3s kubeconfig is invalid"
oci bastion session create-port-forwarding \
  --bastion-id "$bastion_ocid" \
  --display-name "$pf_session_name" \
  --key-type PUB \
  --ssh-public-key-file "$public_key" \
  --session-ttl "$OCI_BASTION_SESSION_TTL" \
  --target-resource-id "$instance_ocid" \
  --target-private-ip "$instance_private_ip" \
  --target-port 6443 \
  --wait-for-state SUCCEEDED \
  --max-wait-seconds 600 >/dev/null
pf_session_id="$(
  wait_active_session_id "$bastion_ocid" "$pf_session_name"
)"

ssh \
  -i "$private_key" \
  -N \
  -L "127.0.0.1:${OCI_K3S_LOCAL_API_PORT}:${instance_private_ip}:6443" \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$known_hosts" \
  -p 22 \
  "${pf_session_id}@${bastion_endpoint}" \
  >"$WORK_DIR/bastion-tunnel.log" 2>&1 &
tunnel_pid=$!
{
  printf 'bastion_ocid=%q\n' "$bastion_ocid"
  printf 'managed_session_id=%q\n' "$managed_session_id"
  printf 'managed_session_name=%q\n' "$managed_session_name"
  printf 'pf_session_id=%q\n' "$pf_session_id"
  printf 'pf_session_name=%q\n' "$pf_session_name"
  printf 'tunnel_pid=%q\n' "$tunnel_pid"
  printf 'key_dir=%q\n' "$key_dir"
  printf 'bastion_endpoint=%q\n' "$bastion_endpoint"
  printf 'private_key=%q\n' "$private_key"
  printf 'known_hosts=%q\n' "$known_hosts"
  printf 'instance_private_ip=%q\n' "$instance_private_ip"
  printf 'os_user=%q\n' "$OCI_K3S_OS_USER"
} > "$SESSION_STATE_FILE"
chmod 600 "$SESSION_STATE_FILE"

tunnel_ready=0
for _ in $(seq 1 60); do
  kill -0 "$tunnel_pid" 2>/dev/null ||
    oci_die "k3s Bastion tunnel process exited"
  if KUBECONFIG="$KUBECONFIG" kubectl get --raw=/readyz >/dev/null 2>&1; then
    tunnel_ready=1
    break
  fi
  sleep 5
done
[[ "$tunnel_ready" == "1" ]] ||
  oci_die "k3s API is unavailable through OCI Bastion"
trap - EXIT
oci_log "k3s_access=PASS transport=oci-bastion"
