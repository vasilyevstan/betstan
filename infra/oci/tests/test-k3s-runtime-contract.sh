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
  "bastion session delete "*) exit 0 ;;
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
{"data":[]}
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
tunnel_pid=$!
access_work="$WORK_DIR/access"
key_dir="$access_work/bastion-keys"
mkdir -p "$key_dir"
touch "$key_dir/id_ed25519"
state_file="$WORK_DIR/access.env"
kubeconfig_file="$WORK_DIR/kubeconfig"
touch "$kubeconfig_file"
{
  printf 'bastion_ocid=%q\n' 'ocid1.bastion.oc1.fixture'
  printf 'managed_session_id=%q\n' 'ocid1.bastionsession.oc1.managed'
  printf 'pf_session_id=%q\n' 'ocid1.bastionsession.oc1.forward'
  printf 'tunnel_pid=%q\n' "$tunnel_pid"
  printf 'key_dir=%q\n' "$key_dir"
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
! kill -0 "$tunnel_pid" 2>/dev/null ||
  fail "k3s access cleanup left the exact tunnel process running"
wait "$tunnel_pid" 2>/dev/null || true
[[ ! -e "$state_file" && ! -e "$key_dir" && ! -e "$kubeconfig_file" ]] ||
  fail "k3s access cleanup left session state, kubeconfig, or ephemeral keys"
grep -Fq 'bastion session delete --session-id ocid1.bastionsession.oc1.forward' \
  "$WORK_DIR/oci.log" ||
  fail "k3s access cleanup did not delete the port-forwarding session"
grep -Fq 'bastion session delete --session-id ocid1.bastionsession.oc1.managed' \
  "$WORK_DIR/oci.log" ||
  fail "k3s access cleanup did not delete the managed SSH session"
grep -Fq '192.0.2.1/32' "$WORK_DIR/oci.log" ||
  fail "k3s access cleanup did not restore the non-routable Bastion CIDR"
grep -Fq 'OCI_BASTION_SESSION_TTL="${OCI_BASTION_SESSION_TTL:-10800}"' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s Bastion sessions do not match the protected workflow ceiling"

finalizer="$OCI_DIR/scripts/finalize-k3s.sh"
grep -Fq -- '--shape-name flexible' "$finalizer" ||
  fail "k3s finalizer does not create a flexible OCI load balancer"
grep -Fq -- '--health-checker-protocol TCP' "$finalizer" ||
  fail "k3s finalizer does not use TCP load balancer health checks"
grep -Fq 'ensure_listener betstan-http 80 betstan-http' "$finalizer" ||
  fail "k3s finalizer lacks the exact HTTP listener"
grep -Fq 'ensure_listener betstan-https 443 betstan-https' "$finalizer" ||
  fail "k3s finalizer lacks the exact HTTPS listener"
grep -Fq 'UUID=$uuid' "$finalizer" ||
  fail "k3s finalizer does not persist the Mongo mount by UUID"

echo "oci_k3s_runtime_contract=PASS"
