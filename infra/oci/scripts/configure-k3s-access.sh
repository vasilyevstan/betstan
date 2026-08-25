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
OCI_K3S_LOCAL_SSH_PORT="${OCI_K3S_LOCAL_SSH_PORT:-12222}"
OCI_K3S_LOCAL_API_PORT="${OCI_K3S_LOCAL_API_PORT:-16443}"
OCI_BASTION_SESSION_TTL="${OCI_BASTION_SESSION_TTL:-10800}"
OCI_INSTANCE_COMMAND_TIMEOUT="${OCI_INSTANCE_COMMAND_TIMEOUT:-120}"
OCI_INSTANCE_COMMAND_POLL_ATTEMPTS="${OCI_INSTANCE_COMMAND_POLL_ATTEMPTS:-150}"
OCI_K3S_OS_USER="${OCI_K3S_OS_USER:-ubuntu}"
OCI_K3S_RETAIN_TARGET_SSH="${OCI_K3S_RETAIN_TARGET_SSH:-false}"
OCI_BASTION_DEFAULT_CLIENT_CIDR="${OCI_BASTION_DEFAULT_CLIENT_CIDR:-192.0.2.1/32}"

[[ "$MODE" == "open" || "$MODE" == "cleanup" ]] ||
  oci_die "usage: configure-k3s-access.sh [open|cleanup]"
[[ -n "$SESSION_STATE_FILE" ]] ||
  oci_die "SESSION_STATE_FILE is required"
[[ "$OCI_BASTION_DEFAULT_CLIENT_CIDR" == "192.0.2.1/32" ]] ||
  oci_die "OCI Bastion default CIDR differs from the reviewed non-routable value"

delete_session() {
  local session_id="${1:-}"
  [[ -n "$session_id" ]] || return 0
  oci bastion session delete \
    --session-id "$session_id" \
    --force \
    --wait-for-state SUCCEEDED \
    --max-wait-seconds 300 >/dev/null
}

release_target_ssh_key() {
  local failed=0
  rm -f -- \
    "$target_private_key" \
    "$target_public_key" \
    "$target_known_hosts" || failed=1
  target_private_key=""
  target_public_key=""
  target_known_hosts=""
  write_session_state
  [[ "$failed" == "0" ]] ||
    oci_die "target SSH key material could not be fully removed"
}

reset_bastion_allowlist() {
  local bastion_id="${1:-}"
  [[ -n "$bastion_id" ]] || return 0
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

normalize_host_public_key() {
  local raw_key="$1"
  local normalized key_file
  normalized="$(
    awk '
      NF {
        if ($1 ~ /^(ssh-(ed25519|rsa)|rsa-sha2-(256|512)|ecdsa-sha2-nistp(256|384|521))$/) {
          print $1 " " $2
        } else if ($2 ~ /^(ssh-(ed25519|rsa)|rsa-sha2-(256|512)|ecdsa-sha2-nistp(256|384|521))$/) {
          print $2 " " $3
        }
      }
    ' <<<"$raw_key"
  )"
  [[ "$(wc -l <<<"$normalized" | tr -d ' ')" == "1" ]] ||
    oci_die "OCI host-key evidence did not contain exactly one supported public key"
  key_file="$(mktemp "$WORK_DIR/.host-key.XXXXXX")"
  printf '%s\n' "$normalized" >"$key_file"
  ssh-keygen -l -f "$key_file" >/dev/null ||
    oci_die "OCI host-key evidence is not a valid SSH public key"
  rm -f -- "$key_file"
  printf '%s\n' "$normalized"
}

write_known_host() {
  local host="$1"
  local port="$2"
  local public_key="$3"
  local output_file="$4"
  local marker="$host"
  [[ "$host" =~ ^[A-Za-z0-9._:-]+$ ]] ||
    oci_die "known-host identity contains unsupported characters"
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ && "$port" -le 65535 ]] ||
    oci_die "known-host port is invalid"
  if [[ "$port" != "22" ]]; then
    marker="[${host}]:${port}"
  fi
  printf '%s %s\n' "$marker" "$public_key" >"$output_file"
  chmod 600 "$output_file"
}

attest_target_host_key() {
  local command_text content target command_id execution_json lifecycle_state
  local output_file expected_sha actual_sha exit_code output_type attempt
  local public_key reported_public_key_sha256 actual_public_key_sha256
  local output_line_count
  command_text='set -eu
key_file=/etc/ssh/ssh_host_ed25519_key.pub
test -f "$key_file"
public_key="$(cat "$key_file")"
public_key_sha256="$(printf "%s\n" "$public_key" | sha256sum | cut -d " " -f 1)"
printf "%s\n%s\n" "$public_key" "$public_key_sha256"'
  content="$(
    jq -cn --arg text "$command_text" \
      '{source:{sourceType:"TEXT",text:$text},output:{outputType:"TEXT"}}'
  )"
  target="$(jq -cn --arg instance_id "$instance_ocid" '{instanceId:$instance_id}')"
  command_id="$(
    oci instance-agent command create \
      --compartment-id "$OCI_COMPARTMENT_OCID" \
      --timeout-in-seconds "$OCI_INSTANCE_COMMAND_TIMEOUT" \
      --target "$target" \
      --content "$content" \
      --display-name "betstan-host-key-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}" \
      --query 'data.id' \
      --raw-output
  )"
  oci_require_ocid command_id

  execution_json="$WORK_DIR/target-host-key-command.json"
  lifecycle_state=""
  for attempt in $(seq 1 "$OCI_INSTANCE_COMMAND_POLL_ATTEMPTS"); do
    oci instance-agent command-execution get \
      --command-id "$command_id" \
      --instance-id "$instance_ocid" >"$execution_json"
    lifecycle_state="$(jq -r '.data."lifecycle-state" // empty' "$execution_json")"
    case "$lifecycle_state" in
      SUCCEEDED)
        break
        ;;
      FAILED|TIMED_OUT|CANCELED)
        oci_die "OCI-attested target host-key command ended in state $lifecycle_state"
        ;;
      ACCEPTED|IN_PROGRESS|'')
        sleep 2
        ;;
      *)
        oci_die "OCI-attested target host-key command returned unexpected state $lifecycle_state"
        ;;
    esac
  done
  [[ "$lifecycle_state" == "SUCCEEDED" ]] ||
    oci_die "OCI-attested target host-key command did not complete in time"
  [[ "$(jq -r '.data."instance-agent-command-id" // empty' "$execution_json")" == "$command_id" &&
     "$(jq -r '.data."instance-id" // empty' "$execution_json")" == "$instance_ocid" ]] ||
    oci_die "OCI-attested target host-key response identity does not match the request"

  output_type="$(jq -r '.data.content."output-type" // empty' "$execution_json")"
  exit_code="$(jq -r '.data.content."exit-code" // empty' "$execution_json")"
  expected_sha="$(jq -r '.data.content."text-sha256" // empty' "$execution_json")"
  [[ "$output_type" == "TEXT" && "$exit_code" == "0" ]] ||
    oci_die "OCI-attested target host-key response is incomplete"
  output_file="$WORK_DIR/target-host-key-output"
  jq -j '.data.content.text // empty' "$execution_json" >"$output_file"
  if [[ -n "$expected_sha" ]]; then
    [[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] ||
      oci_die "OCI-attested target host-key response checksum is malformed"
    actual_sha="$(oci_sha256 <"$output_file")"
    [[ "$actual_sha" == "$expected_sha" ]] ||
      oci_die "OCI-attested target host-key output checksum does not match"
  fi

  output_line_count="$(wc -l <"$output_file" | tr -d ' ')"
  [[ "$output_line_count" == "2" ]] ||
    oci_die "OCI-attested target host-key payload is incomplete"
  public_key="$(sed -n '1p' "$output_file")"
  reported_public_key_sha256="$(sed -n '2p' "$output_file")"
  [[ "$reported_public_key_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    oci_die "OCI-attested target host-key payload checksum is malformed"
  actual_public_key_sha256="$(printf '%s\n' "$public_key" | oci_sha256)"
  [[ "$actual_public_key_sha256" == "$reported_public_key_sha256" ]] ||
    oci_die "OCI-attested target host-key payload checksum does not match"
  normalize_host_public_key "$public_key"
}

session_connection_metadata() {
  local session_id="$1"
  local target_port="$2"
  local session expected_endpoint expected_command actual_command public_key
  expected_endpoint="host.bastion.${OCI_CLI_REGION}.oci.oraclecloud.com"
  expected_command="ssh -i <privateKey> -N -L <localPort>:${instance_private_ip}:${target_port} -p 22 ${session_id}@${expected_endpoint}"
  session="$(oci bastion session get --session-id "$session_id")"
  jq -e \
    --arg session_id "$session_id" \
    --arg instance_id "$instance_ocid" \
    --arg private_ip "$instance_private_ip" \
    --argjson target_port "$target_port" '
      .data.id == $session_id and
      .data."lifecycle-state" == "ACTIVE" and
      .data."target-resource-details"."session-type" == "PORT_FORWARDING" and
      .data."target-resource-details"."target-resource-id" == $instance_id and
      .data."target-resource-details"."target-resource-private-ip-address" == $private_ip and
      .data."target-resource-details"."target-resource-port" == $target_port
    ' <<<"$session" >/dev/null ||
    oci_die "OCI Bastion session target differs from the requested port forward"
  actual_command="$(jq -r '.data."ssh-metadata".command // empty' <<<"$session")"
  [[ "$actual_command" == "$expected_command" ]] ||
    oci_die "OCI Bastion SSH metadata differs from the requested port forward"
  public_key="$(
    normalize_host_public_key "$(
      jq -r '.data."bastion-public-host-key-info" // empty' <<<"$session"
    )"
  )"
  printf '%s\t%s\n' "$expected_endpoint" "$public_key"
}

write_session_state() {
  local state_dir state_tmp
  state_dir="$(dirname "$SESSION_STATE_FILE")"
  state_tmp="${SESSION_STATE_FILE}.tmp"
  mkdir -p "$state_dir"
  umask 077
  {
    printf 'bastion_ocid=%q\n' "$bastion_ocid"
    printf 'ssh_session_id=%q\n' "$ssh_session_id"
    printf 'ssh_session_name=%q\n' "$ssh_session_name"
    printf 'ssh_tunnel_pid=%q\n' "$ssh_tunnel_pid"
    printf 'api_tunnel_pid=%q\n' "$api_tunnel_pid"
    printf 'key_dir=%q\n' "$key_dir"
    printf 'bastion_endpoint=%q\n' "$bastion_endpoint"
    printf 'target_private_key=%q\n' "$target_private_key"
    printf 'target_known_hosts=%q\n' "$target_known_hosts"
    printf 'instance_ocid=%q\n' "$instance_ocid"
    printf 'instance_private_ip=%q\n' "$instance_private_ip"
    printf 'os_user=%q\n' "$OCI_K3S_OS_USER"
    printf 'local_ssh_port=%q\n' "$OCI_K3S_LOCAL_SSH_PORT"
  } > "$state_tmp"
  mv -f "$state_tmp" "$SESSION_STATE_FILE"
  chmod 600 "$SESSION_STATE_FILE"
}

stop_tunnel() {
  local tunnel_pid="${1:-}"
  [[ -n "$tunnel_pid" ]] || return 0
  if kill -0 "$tunnel_pid" 2>/dev/null; then
    kill "$tunnel_pid"
  fi
  wait "$tunnel_pid" 2>/dev/null || true
}

cleanup_access() {
  # Keep legacy API-session fields readable so interrupted pre-upgrade runs can be revoked.
  local ssh_session_id="" api_session_id=""
  local ssh_session_name="" api_session_name=""
  local ssh_tunnel_pid="" api_tunnel_pid=""
  local key_dir="" bastion_ocid="" bastion_endpoint=""
  local failed=0 resolved_session_id=""
  if [[ -f "$SESSION_STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$SESSION_STATE_FILE"
  fi
  if [[ -n "$bastion_ocid" && -n "$ssh_session_name" ]]; then
    resolved_session_id="$(
      resolve_session_id "$bastion_ocid" "$ssh_session_name"
    )" && ssh_session_id="$resolved_session_id" || failed=1
  fi
  if [[ -n "$bastion_ocid" && -n "$api_session_name" ]]; then
    resolved_session_id="$(
      resolve_session_id "$bastion_ocid" "$api_session_name"
    )" && api_session_id="$resolved_session_id" || failed=1
  fi
  stop_tunnel "$api_tunnel_pid" || failed=1
  stop_tunnel "$ssh_tunnel_pid" || failed=1
  delete_session "$api_session_id" || failed=1
  delete_session "$ssh_session_id" || failed=1
  reset_bastion_allowlist "$bastion_ocid" || failed=1
  rm -f -- "$KUBECONFIG" || failed=1
  rm -f -- \
    "${SESSION_STATE_FILE}.tmp" \
    "$WORK_DIR/target-api-tunnel.log" \
    "$WORK_DIR/bastion-api-tunnel.log" \
    "$WORK_DIR/bastion-ssh-tunnel.log" || failed=1
  if [[ -n "$key_dir" && "$key_dir" == "$WORK_DIR/"* ]]; then
    rm -rf -- "$key_dir" || failed=1
  fi
  if [[ "$failed" == "0" ]]; then
    rm -f -- "$SESSION_STATE_FILE" || failed=1
  elif [[ -f "$SESSION_STATE_FILE" ]]; then
    chmod 600 "$SESSION_STATE_FILE" || true
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

validate_local_port() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[1-9][0-9]{3,4}$ ]] ||
    oci_die "$name must be an unprivileged TCP port"
  (( value >= 1024 && value <= 65535 )) ||
    oci_die "$name must be in the unprivileged TCP port range"
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
oci_require_vars \
  OCI_COMPARTMENT_OCID OCI_CLI_REGION OCI_K3S_SSH_PRIVATE_KEY \
  RUNNER_PUBLIC_IPV4
oci_require_ocid OCI_COMPARTMENT_OCID
oci_validate_public_ipv4 "$RUNNER_PUBLIC_IPV4" ||
  oci_die "RUNNER_PUBLIC_IPV4 must be a globally routable IPv4"
validate_local_port OCI_K3S_LOCAL_SSH_PORT "$OCI_K3S_LOCAL_SSH_PORT"
validate_local_port OCI_K3S_LOCAL_API_PORT "$OCI_K3S_LOCAL_API_PORT"
[[ "$OCI_K3S_LOCAL_SSH_PORT" != "$OCI_K3S_LOCAL_API_PORT" ]] ||
  oci_die "local SSH and k3s API ports must differ"
[[ "$OCI_K3S_RETAIN_TARGET_SSH" == "true" ||
   "$OCI_K3S_RETAIN_TARGET_SSH" == "false" ]] ||
  oci_die "OCI_K3S_RETAIN_TARGET_SSH must be true or false"
[[ "$OCI_INSTANCE_COMMAND_TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "OCI_INSTANCE_COMMAND_TIMEOUT must be a positive integer"
(( OCI_INSTANCE_COMMAND_TIMEOUT <= 300 )) ||
  oci_die "OCI_INSTANCE_COMMAND_TIMEOUT exceeds 300 seconds"
[[ "$OCI_INSTANCE_COMMAND_POLL_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "OCI_INSTANCE_COMMAND_POLL_ATTEMPTS must be a positive integer"
(( OCI_INSTANCE_COMMAND_POLL_ATTEMPTS <= 150 )) ||
  oci_die "OCI_INSTANCE_COMMAND_POLL_ATTEMPTS exceeds 150"
[[ "$OCI_BASTION_SESSION_TTL" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "OCI_BASTION_SESSION_TTL must be a positive integer"
(( OCI_BASTION_SESSION_TTL >= 1800 )) ||
  oci_die "OCI_BASTION_SESSION_TTL is below the OCI Bastion minimum"
(( OCI_BASTION_SESSION_TTL <= 10800 )) ||
  oci_die "OCI_BASTION_SESSION_TTL exceeds the OCI Bastion maximum"
[[ -f "$INFRA_PROVENANCE_FILE" ]] ||
  oci_die "INFRA_PROVENANCE_FILE is required"

unset runtime_mode instance_ocid cluster_ocid instance_fingerprint
unset instance_private_ip availability_domain bastion_ocid
unset target_ssh_public_key_sha256
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
provenance_bastion_ocid="${bastion_ocid:-}"
expected_target_ssh_public_key_sha256="${target_ssh_public_key_sha256:-}"
if [[ -n "$ACQUISITION_PROVENANCE_FILE" ]]; then
  [[ -f "$ACQUISITION_PROVENANCE_FILE" ]] ||
    oci_die "ACQUISITION_PROVENANCE_FILE does not exist"
  unset runtime_mode instance_ocid instance_fingerprint
  unset instance_private_ip private_ip availability_domain
  unset target_ssh_public_key_sha256
  # shellcheck disable=SC1090
  source "$ACQUISITION_PROVENANCE_FILE"
  instance_private_ip="${instance_private_ip:-${private_ip:-}}"
  bastion_ocid="$provenance_bastion_ocid"
  expected_target_ssh_public_key_sha256="${target_ssh_public_key_sha256:-}"
fi
oci_require_vars \
  runtime_mode instance_ocid instance_fingerprint instance_private_ip \
  availability_domain bastion_ocid expected_target_ssh_public_key_sha256
[[ "$runtime_mode" == "k3s" ]] ||
  oci_die "k3s access received non-k3s infrastructure provenance"
oci_require_ocid instance_ocid
oci_require_ocid bastion_ocid
[[ "$(oci_fingerprint "$instance_ocid")" == "$instance_fingerprint" ]] ||
  oci_die "k3s instance provenance fingerprint mismatch"
[[ "$expected_target_ssh_public_key_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "k3s target SSH public-key fingerprint is invalid"

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
jq -e \
  --arg compartment "$OCI_COMPARTMENT_OCID" \
  --argjson ttl "$OCI_BASTION_SESSION_TTL" '
    .data."compartment-id" == $compartment and
    .data."bastion-type" == "STANDARD" and
    .data."lifecycle-state" == "ACTIVE" and
    .data."max-session-ttl-in-seconds" >= $ttl
  ' <<<"$bastion" >/dev/null ||
  oci_die "OCI Bastion identity or session limit differs from the access contract"

oci_prepare_private_dir "$WORK_DIR"
key_dir="$WORK_DIR/bastion-keys"
oci_prepare_private_dir "$key_dir"
bastion_private_key="$key_dir/bastion_id_ed25519"
bastion_public_key="${bastion_private_key}.pub"
target_private_key="$key_dir/target_id_ed25519"
target_public_key="${target_private_key}.pub"
bastion_known_hosts="$key_dir/bastion_known_hosts"
target_known_hosts="$key_dir/target_known_hosts"
ssh_session_id=""
ssh_tunnel_pid=""
api_tunnel_pid=""
bastion_endpoint=""
run_identity="${GITHUB_RUN_ID:-local-$PPID}-${GITHUB_RUN_ATTEMPT:-1}"
ssh_session_name="betstan-k3s-ssh-${run_identity}"
write_session_state
trap cleanup_open_failure EXIT

runner_cidr="$(jq -cn --arg cidr "${RUNNER_PUBLIC_IPV4}/32" '[$cidr]')"
oci bastion bastion update \
  --bastion-id "$bastion_ocid" \
  --client-cidr-list "$runner_cidr" \
  --force \
  --wait-for-state SUCCEEDED \
  --max-wait-seconds 300 >/dev/null

ssh-keygen \
  -q -t ed25519 \
  -C "betstan-bastion-${run_identity}" \
  -N "" \
  -f "$bastion_private_key"
chmod 600 "$bastion_private_key"
printf '%s\n' "$OCI_K3S_SSH_PRIVATE_KEY" > "$target_private_key"
unset OCI_K3S_SSH_PRIVATE_KEY
chmod 600 "$target_private_key"
ssh-keygen -y -P "" -f "$target_private_key" > "$target_public_key" ||
  oci_die "OCI_K3S_SSH_PRIVATE_KEY is not an unencrypted ED25519 key"
actual_target_ssh_public_key_sha256="$(
  oci_ssh_ed25519_public_key_sha256 "$(cat "$target_public_key")"
)"
[[ "$actual_target_ssh_public_key_sha256" == \
   "$expected_target_ssh_public_key_sha256" ]] ||
  oci_die "target SSH private key does not match acquisition provenance"
target_host_public_key="$(attest_target_host_key)"
write_known_host "$instance_ocid" 22 "$target_host_public_key" "$target_known_hosts"

oci bastion session create-port-forwarding \
  --bastion-id "$bastion_ocid" \
  --display-name "$ssh_session_name" \
  --key-type PUB \
  --ssh-public-key-file "$bastion_public_key" \
  --session-ttl "$OCI_BASTION_SESSION_TTL" \
  --target-resource-id "$instance_ocid" \
  --target-private-ip "$instance_private_ip" \
  --target-port 22 \
  --wait-for-state SUCCEEDED \
  --max-wait-seconds 600 >/dev/null
ssh_session_id="$(
  wait_active_session_id "$bastion_ocid" "$ssh_session_name"
)"
IFS=$'\t' read -r bastion_endpoint bastion_host_public_key < <(
  session_connection_metadata "$ssh_session_id" 22
)
write_known_host "$bastion_endpoint" 22 "$bastion_host_public_key" "$bastion_known_hosts"
write_session_state

start_bastion_ssh_tunnel() {
  : >"$WORK_DIR/bastion-ssh-tunnel.log"
  ssh \
    -i "$bastion_private_key" \
    -N \
    -L "127.0.0.1:${OCI_K3S_LOCAL_SSH_PORT}:${instance_private_ip}:22" \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o IdentitiesOnly=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$bastion_known_hosts" \
    -p 22 \
    "${ssh_session_id}@${bastion_endpoint}" \
    >"$WORK_DIR/bastion-ssh-tunnel.log" 2>&1 &
  ssh_tunnel_pid=$!
  write_session_state
}

target_ssh_options=(
  -i "$target_private_key"
  -p "$OCI_K3S_LOCAL_SSH_PORT"
  -o BatchMode=yes
  -o CheckHostIP=no
  -o ConnectTimeout=10
  -o HostKeyAlias="$instance_ocid"
  -o IdentitiesOnly=yes
  -o PasswordAuthentication=no
  -o PreferredAuthentications=publickey
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$target_known_hosts"
)
ssh_ready=0
target_ssh_attempt=0
for tunnel_attempt in $(seq 1 6); do
  tunnel_failed=0
  start_bastion_ssh_tunnel
  while (( target_ssh_attempt < 30 )); do
    if ! kill -0 "$ssh_tunnel_pid" 2>/dev/null; then
      tunnel_failed=1
      break
    fi
    target_ssh_attempt=$((target_ssh_attempt + 1))
    if ssh \
        "${target_ssh_options[@]}" \
        "${OCI_K3S_OS_USER}@127.0.0.1" \
        'sudo test -s /etc/rancher/k3s/k3s.yaml' \
        >/dev/null 2>&1; then
      ssh_ready=1
      break 2
    fi
    sleep 10
  done
  stop_tunnel "$ssh_tunnel_pid"
  ssh_tunnel_pid=""
  write_session_state
  if [[ "$tunnel_failed" == "1" &&
    "$tunnel_attempt" -lt 6 &&
    "$target_ssh_attempt" -lt 30 ]]; then
    oci_log "bastion_ssh_tunnel_retry=$tunnel_attempt reason=endpoint-not-ready"
    sleep 15
  else
    break
  fi
done
[[ "$ssh_ready" == "1" ]] ||
  oci_die "target SSH did not become usable through OCI Bastion"

mkdir -p "$(dirname "$KUBECONFIG")"
ssh \
  "${target_ssh_options[@]}" \
  "${OCI_K3S_OS_USER}@127.0.0.1" \
  'sudo cat /etc/rancher/k3s/k3s.yaml' |
  sed -E \
    "s#server: https://[^:]+:6443#server: https://127.0.0.1:${OCI_K3S_LOCAL_API_PORT}#" \
    > "$KUBECONFIG"
chmod 600 "$KUBECONFIG"
EXPECTED_K3S_SERVER="https://127.0.0.1:${OCI_K3S_LOCAL_API_PORT}" \
  KUBECONFIG="$KUBECONFIG" \
  "$SCRIPT_DIR/validate-k3s-kubeconfig.sh"

ssh \
  "${target_ssh_options[@]}" \
  -N \
  -L "127.0.0.1:${OCI_K3S_LOCAL_API_PORT}:127.0.0.1:6443" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  "${OCI_K3S_OS_USER}@127.0.0.1" \
  >"$WORK_DIR/target-api-tunnel.log" 2>&1 &
api_tunnel_pid=$!
write_session_state

tunnel_ready=0
for _ in $(seq 1 60); do
  kill -0 "$api_tunnel_pid" 2>/dev/null ||
    oci_die "k3s API Bastion tunnel process exited"
  if KUBECONFIG="$KUBECONFIG" \
      kubectl --request-timeout=10s get --raw=/readyz >/dev/null 2>&1; then
    tunnel_ready=1
    break
  fi
  sleep 5
done
[[ "$tunnel_ready" == "1" ]] ||
  oci_die "k3s API is unavailable through OCI Bastion"
if [[ "$OCI_K3S_RETAIN_TARGET_SSH" == "false" ]]; then
  release_target_ssh_key
fi
trap - EXIT
oci_log "k3s_access=PASS transport=oci-bastion-target-ssh-loopback"
