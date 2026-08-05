#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
WORK_DIR="$OCI_DIR/tests/.k3s-runtime-work"

fail() {
  echo "OCI k3s runtime contract failure: $*" >&2
  exit 1
}

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/bin" "$WORK_DIR/responses"
trap 'rm -rf "$WORK_DIR"' EXIT

OCI_K3S_VERSION='v1.34.9+k3s1' \
OCI_K3S_BINARY_SHA256='c782d6bb71eb2eb30f034aaddabb480294f9fdae5a7bca49ac5e3e0f66b96ea5' \
  "$OCI_DIR/scripts/bootstrap-k3s.sh" render-cloud-init > "$WORK_DIR/cloud-init.yaml"
[[ "$(wc -c < "$WORK_DIR/cloud-init.yaml" | tr -d ' ')" -lt 32768 ]] ||
  fail "k3s cloud-init exceeds the reviewed user-data ceiling"
grep -Fq 'provider-id=oci://__OCI_INSTANCE_OCID__' "$OCI_DIR/scripts/bootstrap-k3s.sh" ||
  fail "k3s bootstrap does not bind the node providerID to OCI instance metadata"
grep -Fq "Authorization: Bearer Oracle" "$OCI_DIR/scripts/bootstrap-k3s.sh" ||
  fail "k3s bootstrap does not use the authenticated OCI metadata endpoint"
grep -Fq 'type: NodePort' "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml" ||
  fail "k3s ingress is not NodePort"
grep -Fq 'http: 30080' "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml" ||
  fail "k3s HTTP NodePort differs"
grep -Fq 'https: 30443' "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml" ||
  fail "k3s HTTPS NodePort differs"
! grep -Fq 'type: LoadBalancer' "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml" ||
  fail "k3s Kubernetes assets create a LoadBalancer service"
provisioner="$OCI_DIR/scripts/provision.sh"
grep -Fq -- "--arg source \"\$OCI_LB_SUBNET_CIDR\"" "$provisioner" ||
  fail "k3s worker NSG lacks the dedicated load-balancer subnet path"
grep -Fq "description:(\"lb-subnet-to-nodeport-\" + (\$port|tostring))" \
  "$provisioner" ||
  fail "k3s worker NSG lacks exact subnet-to-NodePort rules"
grep -Fq -- "--arg destination \"\$OCI_WORKER_SUBNET_CIDR\"" "$provisioner" ||
  fail "k3s load-balancer NSG lacks the dedicated worker subnet path"
grep -Fq "description:(\"lb-to-worker-subnet-\" + (\$port|tostring))" \
  "$provisioner" ||
  fail "k3s load-balancer NSG lacks exact subnet-to-worker rules"
grep -Fq "description:(\"lb-to-world-return-\" + (\$port|tostring))" \
  "$provisioner" ||
  fail "k3s load-balancer NSG lacks explicit public return rules"
grep -Fq "description:(\"worker-to-lb-return-\" + (\$port|tostring))" \
  "$provisioner" ||
  fail "k3s load-balancer NSG lacks explicit backend return rules"
grep -Fq "sourcePortRange:{min:\$port,max:\$port}" "$provisioner" ||
  fail "k3s load-balancer return rules do not bind their source ports"
grep -Fq 'destinationPortRange:{min:1024,max:65535}' "$provisioner" ||
  fail "k3s load-balancer return rules do not bind ephemeral destinations"
grep -Fq '"is-stateless" // null' "$provisioner" ||
  fail "managed NSG reconciliation does not verify statefulness"
grep -Fq '"source-port-range".min // null' "$provisioner" ||
  fail "managed NSG reconciliation does not verify source-port bounds"
for description in \
  lb-subnet-to-nodeport-30080 lb-subnet-to-nodeport-30443 \
  lb-to-worker-subnet-30080 lb-to-worker-subnet-30443 \
  lb-to-world-return-80 lb-to-world-return-443 \
  worker-to-lb-return-30080 worker-to-lb-return-30443; do
  grep -Fq "\"$description\"" "$provisioner" ||
    fail "k3s exact NSG rule set omits $description"
done
grep -Fq 'path: /var/lib/betstan/mongo' "$OCI_DIR/k8s/overlays/k3s/kustomization.yaml" ||
  fail "k3s Mongo local PV path differs"
grep -Fq '__OCI_K3S_NODE_NAME__' "$OCI_DIR/k8s/overlays/k3s/kustomization.yaml" ||
  fail "k3s Mongo PV lacks exact node affinity"

cat > "$WORK_DIR/bin/oci" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  echo "3.90.0"
  exit 0
fi
printf '%s\n' "$*" >> "${MOCK_OCI_LOG:?}"
case "$*" in
  "ce cluster list "*) response=clusters.json ;;
  "ce node-pool list "*) response=node-pools.json ;;
  "compute instance list "*) response=instances.json ;;
  "bv volume list "*) response=volumes.json ;;
  "bv boot-volume list "*) response=boot-volumes.json ;;
  "lb load-balancer list "*) response=load-balancers.json ;;
  "nlb network-load-balancer list "*) response=network-load-balancers.json ;;
  "network nat-gateway list "*) response=nat-gateways.json ;;
  "network internet-gateway list "*) response=internet-gateways.json ;;
  "network service-gateway list "*) response=service-gateways.json ;;
  "network public-ip list "*) response=public-ips.json ;;
  "bastion bastion list "*) response=bastions.json ;;
  "artifacts container repository list "*) response=repositories.json ;;
  "os bucket list "*) response=buckets.json ;;
  "bastion session delete "*)
    if [[ -n "${MOCK_OCI_FAIL_SESSION_ID:-}" &&
          "$*" == *"$MOCK_OCI_FAIL_SESSION_ID"* ]]; then
      exit 1
    fi
    exit 0
    ;;
  "bastion bastion update "*) exit 0 ;;
  *) echo "unexpected mock OCI command: $*" >&2; exit 1 ;;
esac
cat "${MOCK_OCI_RESPONSES:?}/$response"
MOCK
chmod +x "$WORK_DIR/bin/oci"

cat > "$WORK_DIR/responses/clusters.json" <<'JSON'
{"data":[]}
JSON
cat > "$WORK_DIR/responses/node-pools.json" <<'JSON'
{"data":[]}
JSON
cat > "$WORK_DIR/responses/instances.json" <<'JSON'
{"data":[{
  "display-name":"betstan-k3s",
  "shape":"VM.Standard.A1.Flex",
  "shape-config":{"ocpus":2,"memory-in-gbs":12},
  "lifecycle-state":"RUNNING",
  "freeform-tags":{
    "betstan-managed":"true",
    "provider":"oci",
    "betstan-runtime":"k3s",
    "expected-monthly-cost":"0"
  }
}]}
JSON
cat > "$WORK_DIR/responses/volumes.json" <<'JSON'
{"data":[{
  "display-name":"betstan-mongo",
  "size-in-gbs":50,
  "vpus-per-gb":0,
  "lifecycle-state":"AVAILABLE"
}]}
JSON
cat > "$WORK_DIR/responses/boot-volumes.json" <<'JSON'
{"data":[{
  "display-name":"betstan-boot",
  "size-in-gbs":50,
  "vpus-per-gb":10,
  "lifecycle-state":"AVAILABLE"
}]}
JSON
cat > "$WORK_DIR/responses/load-balancers.json" <<'JSON'
{"data":[{
  "display-name":"betstan-ingress",
  "shape-name":"flexible",
  "shape-details":{
    "minimum-bandwidth-in-mbps":10,
    "maximum-bandwidth-in-mbps":10
  },
  "ip-addresses":[{
    "ip-address":"192.0.2.10",
    "is-public":true,
    "reserved-ip":null
  }],
  "freeform-tags":{
    "betstan-managed":"true",
    "provider":"oci",
    "expected-monthly-cost":"0"
  },
  "lifecycle-state":"ACTIVE"
}]}
JSON
cat > "$WORK_DIR/responses/network-load-balancers.json" <<'JSON'
{"data":{"items":[]}}
JSON
cat > "$WORK_DIR/responses/nat-gateways.json" <<'JSON'
{"data":[]}
JSON
cat > "$WORK_DIR/responses/internet-gateways.json" <<'JSON'
{"data":[{"lifecycle-state":"AVAILABLE"}]}
JSON
cat > "$WORK_DIR/responses/service-gateways.json" <<'JSON'
{"data":[]}
JSON
cat > "$WORK_DIR/responses/public-ips.json" <<'JSON'
{"data":[{
  "ip-address":"192.0.2.10",
  "lifecycle-state":"ASSIGNED",
  "lifetime":"RESERVED",
  "assigned-entity-id":"ocid1.privateip.oc1..fixture",
  "scope":"REGION"
}]}
JSON
cat > "$WORK_DIR/responses/bastions.json" <<'JSON'
{"data":[{
  "name":"betstan-bastion",
  "lifecycle-state":"ACTIVE",
  "freeform-tags":{
    "betstan-managed":"true",
    "provider":"oci",
    "expected-monthly-cost":"0"
  }
}]}
JSON
cat > "$WORK_DIR/responses/repositories.json" <<'JSON'
{"data":{"items":[{
  "display-name":"betstan_images",
  "image-count":9,
  "layer-count":18,
  "layers-size-in-bytes":171415038,
  "is-public":false,
  "is-immutable":true
}]}}
JSON
cat > "$WORK_DIR/responses/buckets.json" <<'JSON'
{"data":[]}
JSON

inventory_env=(
  PATH="$WORK_DIR/bin:$PATH"
  MOCK_OCI_LOG="$WORK_DIR/oci.log"
  MOCK_OCI_RESPONSES="$WORK_DIR/responses"
  OCI_CLI_VERSION=3.90.0
  OCI_RUNTIME_MODE=k3s
  OCI_COMPARTMENT_OCID=ocid1.compartment.oc1..fixture
  OCI_EXPECTED_MONTHLY_COST=0
  OCI_A1_OCPUS=2
  OCI_A1_MEMORY_GB=12
  OCI_LB_MIN_MBPS=10
  OCI_LB_MAX_MBPS=10
  OCI_REGISTRY_MAX_BYTES=500000000
  OCI_IMAGE_PREFIX=betstan
  OCI_BOOT_VOLUME_GB=50
  OCI_MONGO_VOLUME_GB=50
)
env "${inventory_env[@]}" \
  INVENTORY_MODE=complete \
  OUTPUT_FILE="$WORK_DIR/k3s-inventory.json" \
  "$OCI_DIR/scripts/inventory.sh"
jq -e '
  .runtime_mode == "k3s" and
  (.clusters | length) == 0 and
  (.node_pools | length) == 0 and
  (.instances | length) == 1 and
  .instances[0].runtime == "k3s" and
  .expected_monthly_cost == 0
' "$WORK_DIR/k3s-inventory.json" >/dev/null ||
  fail "valid direct-k3s inventory was rejected"

cat > "$WORK_DIR/responses/public-ips.json" <<'JSON'
{"data":[{
  "ip-address":"192.0.2.11",
  "lifecycle-state":"ASSIGNED",
  "lifetime":"RESERVED",
  "assigned-entity-id":"ocid1.privateip.oc1..unrelated",
  "scope":"REGION"
}]}
JSON
if env "${inventory_env[@]}" \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$WORK_DIR/unrelated-reserved-ip-inventory.json" \
    "$OCI_DIR/scripts/inventory.sh" >/dev/null 2>&1; then
  fail "unrelated reserved public IP was accepted"
fi

cat > "$WORK_DIR/responses/public-ips.json" <<'JSON'
{"data":[{
  "ip-address":"192.0.2.10",
  "lifecycle-state":"ASSIGNED",
  "lifetime":"RESERVED",
  "assigned-entity-id":"ocid1.privateip.oc1..fixture",
  "scope":"REGION"
},{
  "ip-address":"192.0.2.11",
  "lifecycle-state":"ASSIGNED",
  "lifetime":"RESERVED",
  "assigned-entity-id":"ocid1.privateip.oc1..extra",
  "scope":"REGION"
}]}
JSON
if env "${inventory_env[@]}" \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$WORK_DIR/extra-reserved-ip-inventory.json" \
    "$OCI_DIR/scripts/inventory.sh" >/dev/null 2>&1; then
  fail "extra reserved public IP was accepted"
fi

cat > "$WORK_DIR/responses/public-ips.json" <<'JSON'
{"data":[{
  "ip-address":"192.0.2.10",
  "lifecycle-state":"ASSIGNED",
  "lifetime":"RESERVED",
  "assigned-entity-id":"ocid1.privateip.oc1..fixture",
  "scope":"REGION"
}]}
JSON
cat > "$WORK_DIR/responses/clusters.json" <<'JSON'
{"data":[{
  "name":"unexpected-oke",
  "type":"BASIC_CLUSTER",
  "lifecycle-state":"ACTIVE",
  "kubernetes-version":"v1.34.1"
}]}
JSON
if env "${inventory_env[@]}" \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$WORK_DIR/mixed-inventory.json" \
    "$OCI_DIR/scripts/inventory.sh" >/dev/null 2>&1; then
  fail "mixed OKE and direct-k3s inventory was accepted"
fi

python3 -c '
import signal
import sys
import time
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
time.sleep(300)
' &
ssh_tunnel_pid=$!
python3 -c '
import signal
import sys
import time
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
time.sleep(300)
' &
api_tunnel_pid=$!
access_work="$WORK_DIR/access"
key_dir="$access_work/bastion-keys"
mkdir -p "$key_dir"
touch \
  "$key_dir/bastion_id_ed25519" \
  "$key_dir/target_id_ed25519" \
  "$key_dir/target_known_hosts"
state_file="$WORK_DIR/access.env"
kubeconfig_file="$WORK_DIR/kubeconfig"
touch "$kubeconfig_file"
{
  printf 'bastion_ocid=%q\n' 'ocid1.bastion.oc1.fixture'
  printf 'ssh_session_id=%q\n' 'ocid1.bastionsession.oc1.ssh'
  printf 'ssh_tunnel_pid=%q\n' "$ssh_tunnel_pid"
  printf 'api_tunnel_pid=%q\n' "$api_tunnel_pid"
  printf 'key_dir=%q\n' "$key_dir"
  printf 'target_private_key=%q\n' "$key_dir/target_id_ed25519"
  printf 'target_known_hosts=%q\n' "$key_dir/target_known_hosts"
  printf 'instance_private_ip=%q\n' '10.42.28.31'
  printf 'os_user=%q\n' 'ubuntu'
  printf 'local_ssh_port=%q\n' '12222'
} > "$state_file"
: > "$WORK_DIR/oci.log"
PATH="$WORK_DIR/bin:$PATH" \
MOCK_OCI_LOG="$WORK_DIR/oci.log" \
MOCK_OCI_RESPONSES="$WORK_DIR/responses" \
OCI_CLI_VERSION=3.90.0 \
SESSION_STATE_FILE="$state_file" \
WORK_DIR="$access_work" \
KUBECONFIG="$kubeconfig_file" \
  "$OCI_DIR/scripts/configure-k3s-access.sh" cleanup >/dev/null
! kill -0 "$ssh_tunnel_pid" 2>/dev/null ||
  fail "k3s access cleanup left the exact SSH tunnel process running"
! kill -0 "$api_tunnel_pid" 2>/dev/null ||
  fail "k3s access cleanup left the exact API tunnel process running"
wait "$ssh_tunnel_pid" 2>/dev/null || true
wait "$api_tunnel_pid" 2>/dev/null || true
[[ ! -e "$state_file" && ! -e "$key_dir" && ! -e "$kubeconfig_file" ]] ||
  fail "k3s access cleanup left session state, kubeconfig, or ephemeral keys"
grep -Fq 'bastion session delete --session-id ocid1.bastionsession.oc1.ssh' \
  "$WORK_DIR/oci.log" ||
  fail "k3s access cleanup did not delete the SSH port-forwarding session"
[[ "$(grep -Fc 'bastion session delete' "$WORK_DIR/oci.log")" == "1" ]] ||
  fail "k3s access cleanup deleted an unexpected Bastion session"
grep -Fq '192.0.2.1/32' "$WORK_DIR/oci.log" ||
  fail "k3s access cleanup did not restore the non-routable Bastion CIDR"
PATH="$WORK_DIR/bin:$PATH" \
MOCK_OCI_LOG="$WORK_DIR/oci.log" \
MOCK_OCI_RESPONSES="$WORK_DIR/responses" \
OCI_CLI_VERSION=3.90.0 \
SESSION_STATE_FILE="$state_file" \
WORK_DIR="$access_work" \
KUBECONFIG="$kubeconfig_file" \
  "$OCI_DIR/scripts/configure-k3s-access.sh" cleanup >/dev/null ||
  fail "k3s access cleanup is not idempotent after partial or prior cleanup"

retry_key_dir="$access_work/retry-keys"
mkdir -p "$retry_key_dir"
touch "$retry_key_dir/target_id_ed25519" "$kubeconfig_file"
{
  printf 'bastion_ocid=%q\n' 'ocid1.bastion.oc1.fixture'
  printf 'ssh_session_id=%q\n' 'ocid1.bastionsession.oc1.retry'
  printf 'ssh_session_name=%q\n' ''
  printf 'ssh_tunnel_pid=%q\n' ''
  printf 'api_tunnel_pid=%q\n' ''
  printf 'key_dir=%q\n' "$retry_key_dir"
} > "$state_file"
if PATH="$WORK_DIR/bin:$PATH" \
    MOCK_OCI_LOG="$WORK_DIR/oci.log" \
    MOCK_OCI_RESPONSES="$WORK_DIR/responses" \
    MOCK_OCI_FAIL_SESSION_ID=ocid1.bastionsession.oc1.retry \
    OCI_CLI_VERSION=3.90.0 \
    SESSION_STATE_FILE="$state_file" \
    WORK_DIR="$access_work" \
    KUBECONFIG="$kubeconfig_file" \
      "$OCI_DIR/scripts/configure-k3s-access.sh" cleanup >/dev/null 2>&1; then
  fail "k3s access cleanup hid a remote session-deletion failure"
fi
[[ -f "$state_file" && ! -e "$retry_key_dir" && ! -e "$kubeconfig_file" ]] ||
  fail "failed remote cleanup did not preserve retry state and remove key material"
PATH="$WORK_DIR/bin:$PATH" \
MOCK_OCI_LOG="$WORK_DIR/oci.log" \
MOCK_OCI_RESPONSES="$WORK_DIR/responses" \
OCI_CLI_VERSION=3.90.0 \
SESSION_STATE_FILE="$state_file" \
WORK_DIR="$access_work" \
KUBECONFIG="$kubeconfig_file" \
  "$OCI_DIR/scripts/configure-k3s-access.sh" cleanup >/dev/null ||
  fail "k3s access cleanup could not retry from preserved state"
[[ ! -e "$state_file" ]] ||
  fail "successful remote cleanup retry retained stale state"

grep -Fq 'OCI_BASTION_SESSION_TTL="${OCI_BASTION_SESSION_TTL:-10800}"' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s Bastion sessions do not match the protected workflow ceiling"
[[ "$(grep -Fc 'bastion session create-port-forwarding' \
  "$OCI_DIR/scripts/configure-k3s-access.sh")" == "1" ]] ||
  fail "k3s access must create exactly one SSH port-forwarding session"
! grep -Fq 'create-managed-ssh' "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access still uses managed SSH, which is unsupported on Ubuntu A1"
grep -Fq '.data."ssh-metadata".command' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not derive the Bastion endpoint from session metadata"
grep -Fq 'OCI_K3S_SSH_PRIVATE_KEY' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not require the retained target SSH private key"
grep -Fq 'OCI_K3S_RETAIN_TARGET_SSH="${OCI_K3S_RETAIN_TARGET_SSH:-false}"' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not remove the target key by default"
grep -Fq 'release_target_ssh_key' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not remove the target key after API forwarding"
grep -Fq -- \
  '-L "127.0.0.1:${OCI_K3S_LOCAL_API_PORT}:127.0.0.1:6443"' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s API does not use the target SSH loopback forward"
grep -Fq 'kubectl --request-timeout=10s get --raw=/readyz' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s API readiness does not have a bounded request timeout"
! grep -Eq 'iptables|netfilter|ufw' "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access mutates the target host firewall"
! grep -Eq 'ControlMaster|ControlPersist' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s API tunnel leaves a reusable SSH control channel"
grep -Fq '(( OCI_BASTION_SESSION_TTL >= 1800 ))' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not enforce the OCI Bastion minimum session TTL"

finalizer="$OCI_DIR/scripts/finalize-k3s.sh"
for access_field in \
  target_private_key target_known_hosts instance_private_ip os_user \
  local_ssh_port ssh_tunnel_pid; do
  grep -Fq "printf '$access_field=%q" \
    "$OCI_DIR/scripts/configure-k3s-access.sh" ||
    fail "k3s access state does not write $access_field"
  grep -Fq "\${${access_field}:-}" "$finalizer" ||
    fail "k3s finalizer does not require access-state field $access_field"
done
! grep -Eq 'managed_session_id|ProxyCommand=' "$finalizer" ||
  fail "k3s finalizer still depends on managed SSH"
grep -Fq '"${os_user}@127.0.0.1"' "$finalizer" ||
  fail "k3s finalizer does not use the local target SSH forward"
grep -Fq 'kubectl --request-timeout=15s get node' "$finalizer" ||
  fail "k3s finalizer node lookup does not have a bounded request timeout"
grep -Fq -- '--shape-name flexible' "$finalizer" ||
  fail "k3s finalizer does not create a flexible OCI load balancer"
grep -Fq 'lb_dataplane_contract="explicit-return-v1"' "$finalizer" ||
  fail "k3s load balancer lacks the one-time data-plane contract marker"
grep -Fq 'oci lb load-balancer update-load-balancer-shape' "$finalizer" ||
  fail "k3s load balancer lacks the supported in-place data-plane refresh"
grep -Fq -- '--shape-details "$shape_details"' "$finalizer" ||
  fail "k3s data-plane refresh does not retain the exact 10/10 shape details"
grep -Fq '.data."freeform-tags"."source-sha" == $sha' "$finalizer" ||
  fail "k3s load balancer tags are not rebound to the exact infrastructure SHA"
grep -Fq '(.data."attachment-type" | ascii_downcase) == "paravirtualized"' \
  "$finalizer" ||
  fail "k3s finalizer does not normalize OCI attachment type casing"
jq -e '
  (.data."attachment-type" | ascii_downcase) == "paravirtualized"
' <<< '{"data":{"attachment-type":"paravirtualized"}}' >/dev/null ||
  fail "provider-reported lowercase paravirtualized attachment was rejected"
if jq -e '
    (.data."attachment-type" | ascii_downcase) == "paravirtualized"
  ' <<< '{"data":{"attachment-type":"iscsi"}}' >/dev/null; then
  fail "non-paravirtualized attachment type was accepted"
fi
grep -Fq -- '--health-checker-protocol TCP' "$finalizer" ||
  fail "k3s finalizer does not use TCP load balancer health checks"
grep -Fq 'ensure_listener betstan-http 80 betstan-http' "$finalizer" ||
  fail "k3s finalizer lacks the exact HTTP listener"
grep -Fq 'ensure_listener betstan-https 443 betstan-https' "$finalizer" ||
  fail "k3s finalizer lacks the exact HTTPS listener"
grep -Fq 'UUID=$uuid' "$finalizer" ||
  fail "k3s finalizer does not persist the Mongo mount by UUID"
grep -Fq 'if sudo mountpoint -q "$mount_path"; then' "$finalizer" ||
  fail "k3s finalizer checks the protected Mongo mount without privilege"
grep -Fq 'sudo findmnt -n -o UUID --target "$mount_path"' "$finalizer" ||
  fail "k3s finalizer cannot validate the protected Mongo mount UUID"
grep -Fq 'sudo findmnt -n -o FSTYPE --target "$mount_path"' "$finalizer" ||
  fail "k3s finalizer cannot validate the protected Mongo filesystem"

echo "oci_k3s_runtime_contract=PASS"
