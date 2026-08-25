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
  "artifacts container image list "*) response=images.json ;;
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
set_registry_fixture() {
  local unique_generations="$1"
  local tag_generations="${2:-$1}"
  jq -n \
    --argjson unique_generations "$unique_generations" \
    --argjson tag_generations "$tag_generations" '
      def services: [
        "auth", "bet", "backoffice", "client", "event", "gamemaster",
        "moderation", "resulting", "slip"
      ];
      def pad($value; $width):
        ($value | tostring) as $text
        | ("0" * ($width - ($text | length))) + $text;
      {
        data: {
          items: [
            range(0; $tag_generations) as $tag_generation
            | range(0; 9) as $service_index
            | ($tag_generation % $unique_generations) as $image_generation
            | {
                "repository-name": "betstan_images",
                version: (
                  "oci-\(services[$service_index])-" +
                  pad($tag_generation + 1; 40)
                ),
                digest: (
                  "sha256:" +
                  pad(($image_generation * 9) + $service_index + 1; 64)
                ),
                "lifecycle-state": "AVAILABLE",
                "defined-tags": {
                  padding: ("x" * 60000)
                }
              }
          ]
        }
      }
    ' > "$WORK_DIR/responses/images.json"
  jq -n --argjson image_count "$((unique_generations * 9))" '
    {
      data: {
        items: [{
          "display-name": "betstan_images",
          "image-count": $image_count,
          "layer-count": ($image_count * 4),
          "layers-size-in-bytes": (100000000 + ($image_count * 9000000)),
          "is-public": false,
          "is-immutable": true
        }]
      }
    }
  ' > "$WORK_DIR/responses/repositories.json"
}
set_registry_fixture 1

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

cat > "$WORK_DIR/ghcr-evidence.env" <<'ENV'
registry_provider=ghcr
registry_host=ghcr.io
registry_repository=ghcr.io/vasilyevstan/betstan-images
package_visibility=public
anonymous_pull=pass
build_first_attempt=true
ENV
env "${inventory_env[@]}" \
  APPLICATION_REGISTRY_PROVIDER=ghcr \
  INVENTORY_MODE=preflight \
  OUTPUT_FILE="$WORK_DIR/ghcr-pre-recovery-inventory.json" \
  "$OCI_DIR/scripts/inventory.sh"
jq -e '
  .mode == "preflight" and
  .application_registry.provider == "ghcr" and
  .application_registry.ocir_application_repository_absent == false and
  (.registry_repositories | length) == 1
' "$WORK_DIR/ghcr-pre-recovery-inventory.json" >/dev/null ||
  fail "GHCR preflight forced legacy OCIR repository retirement before recovery"
cat > "$WORK_DIR/responses/repositories.json" <<'JSON'
{"data":{"items":[]}}
JSON
env "${inventory_env[@]}" \
  APPLICATION_REGISTRY_PROVIDER=ghcr \
  APPLICATION_REGISTRY_EVIDENCE_FILE="$WORK_DIR/ghcr-evidence.env" \
  INVENTORY_MODE=complete \
  OUTPUT_FILE="$WORK_DIR/ghcr-inventory.json" \
  "$OCI_DIR/scripts/inventory.sh"
jq -e '
  .application_registry.provider == "ghcr" and
  .application_registry.public_anonymous == true and
  .application_registry.ocir_application_repository_absent == true and
  .application_registry.validated_build_evidence == true and
  (.registry_repositories | length) == 0
' "$WORK_DIR/ghcr-inventory.json" >/dev/null ||
  fail "explicit public GHCR policy did not accept an absent OCIR application repository"
if env "${inventory_env[@]}" \
    APPLICATION_REGISTRY_PROVIDER=ghcr \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$WORK_DIR/ghcr-missing-evidence.json" \
    "$OCI_DIR/scripts/inventory.sh" >/dev/null 2>&1; then
  fail "GHCR inventory accepted absent OCIR without public build validation evidence"
fi
set_registry_fixture 1

set_registry_fixture 2 4
[[ "$(wc -c < "$WORK_DIR/responses/images.json" | tr -d ' ')" -gt 2000000 ]] ||
  fail "registry fixture does not exceed the runner argument limit"
env "${inventory_env[@]}" \
  INVENTORY_MODE=complete \
  OUTPUT_FILE="$WORK_DIR/two-generation-inventory.json" \
  "$OCI_DIR/scripts/inventory.sh"
jq -e '
  .registry_images_per_generation == 9 and
  .registry_max_generations == 3 and
  .registry_repositories[0].image_count == 18 and
  .registry_image_analysis.tag_generation_count == 4 and
  .registry_image_analysis.unique_generation_count == 2
' "$WORK_DIR/two-generation-inventory.json" >/dev/null ||
  fail "complete candidate and rollback image generations were rejected"

set_registry_fixture 3 6
env "${inventory_env[@]}" \
  INVENTORY_MODE=complete \
  OUTPUT_FILE="$WORK_DIR/three-generation-inventory.json" \
  "$OCI_DIR/scripts/inventory.sh"
jq -e '
  .registry_repositories[0].image_count == 27 and
  .registry_image_analysis.tag_generation_count == 6 and
  .registry_image_analysis.unique_generation_count == 3 and
  .registry_image_analysis.incomplete_tag_generation_count == 0
' "$WORK_DIR/three-generation-inventory.json" >/dev/null ||
  fail "three bounded complete registry generations were rejected"

jq '.data.items[0].version = "invalid-tag"' \
  "$WORK_DIR/responses/images.json" \
  > "$WORK_DIR/responses/images.json.tmp"
mv "$WORK_DIR/responses/images.json.tmp" "$WORK_DIR/responses/images.json"
if env "${inventory_env[@]}" \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$WORK_DIR/malformed-tag-inventory.json" \
    "$OCI_DIR/scripts/inventory.sh" >/dev/null 2>&1; then
  fail "malformed registry image tag was accepted"
fi

set_registry_fixture 3 6
jq '
  .data.items[8].version = .data.items[0].version
' "$WORK_DIR/responses/images.json" \
  > "$WORK_DIR/responses/images.json.tmp"
mv "$WORK_DIR/responses/images.json.tmp" "$WORK_DIR/responses/images.json"
if env "${inventory_env[@]}" \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$WORK_DIR/mixed-generation-inventory.json" \
    "$OCI_DIR/scripts/inventory.sh" >/dev/null 2>&1; then
  fail "incomplete registry service generation was accepted"
fi

set_registry_fixture 3 6
jq '.data.items[1].digest = .data.items[0].digest' \
  "$WORK_DIR/responses/images.json" \
  > "$WORK_DIR/responses/images.json.tmp"
mv "$WORK_DIR/responses/images.json.tmp" "$WORK_DIR/responses/images.json"
if env "${inventory_env[@]}" \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$WORK_DIR/cross-service-digest-inventory.json" \
    "$OCI_DIR/scripts/inventory.sh" >/dev/null 2>&1; then
  fail "registry digest shared across service identities was accepted"
fi

set_registry_fixture 1
jq '.data.items[0]["image-count"] = 10' \
  "$WORK_DIR/responses/repositories.json" \
  > "$WORK_DIR/responses/repositories.json.tmp"
mv "$WORK_DIR/responses/repositories.json.tmp" \
  "$WORK_DIR/responses/repositories.json"
if env "${inventory_env[@]}" \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$WORK_DIR/partial-generation-inventory.json" \
    "$OCI_DIR/scripts/inventory.sh" >/dev/null 2>&1; then
  fail "partial registry image generation was accepted"
fi

set_registry_fixture 4 8
if env "${inventory_env[@]}" \
    INVENTORY_MODE=complete \
    OUTPUT_FILE="$WORK_DIR/fourth-generation-inventory.json" \
    "$OCI_DIR/scripts/inventory.sh" >/dev/null 2>&1; then
  fail "fourth registry image generation was accepted"
fi
set_registry_fixture 3 6

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
grep -Fq 'for tunnel_attempt in $(seq 1 6)' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not retry an ACTIVE session whose SSH endpoint is not ready"
grep -Fq 'while (( target_ssh_attempt < 30 ))' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access shortened the bounded target SSH readiness window"
grep -Fq 'tunnel_failed=1' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access cannot distinguish endpoint failure from target startup"
grep -Fq 'bastion_ssh_tunnel_retry=$tunnel_attempt reason=endpoint-not-ready' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not classify Bastion endpoint propagation retries"
grep -Fq 'stop_tunnel "$ssh_tunnel_pid"' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not stop a failed tunnel before retrying"
grep -Fq 'ssh_tunnel_pid=""' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not clear a failed tunnel PID before persisting retry state"
! grep -Eq 'iptables|netfilter|ufw' "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access mutates the target host firewall"
! grep -Eq 'ControlMaster|ControlPersist' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s API tunnel leaves a reusable SSH control channel"
grep -Fq '(( OCI_BASTION_SESSION_TTL >= 1800 ))' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not enforce the OCI Bastion minimum session TTL"
grep -Fq 'OCI_INSTANCE_COMMAND_POLL_ATTEMPTS="${OCI_INSTANCE_COMMAND_POLL_ATTEMPTS:-150}"' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not tolerate the bounded Run Command acceptance window"
grep -Fq '(( OCI_INSTANCE_COMMAND_POLL_ATTEMPTS <= 150 ))' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access does not bound Run Command polling"
! grep -Fq 'StrictHostKeyChecking=accept-new' \
  "$OCI_DIR/scripts/configure-k3s-access.sh" ||
  fail "k3s access still trusts first-use SSH host keys"
! grep -Fq 'StrictHostKeyChecking=accept-new' \
  "$OCI_DIR/scripts/finalize-k3s.sh" ||
  fail "k3s finalization weakens the attested target host-key policy"
for literal in \
  '.data."bastion-public-host-key-info"' \
  'oci instance-agent command create' \
  'oci instance-agent command-execution get' \
  'public_key_sha256="$(printf "%s\n" "$public_key" | sha256sum' \
  'if [[ -n "$expected_sha" ]]; then' \
  '"$actual_public_key_sha256" == "$reported_public_key_sha256"' \
  'ssh-keygen -l -f -' \
  'write_known_host "$instance_ocid" 22' \
  'StrictHostKeyChecking=yes' \
  'validate-k3s-kubeconfig.sh'; do
  grep -Fq "$literal" "$OCI_DIR/scripts/configure-k3s-access.sh" ||
    fail "k3s access lacks an attested SSH or kubeconfig boundary: $literal"
done

cat >"$WORK_DIR/bin/kubectl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "config view --kubeconfig "*" --raw --minify -o json" ]] ||
  exit 98
cat "${MOCK_KUBECONFIG_VIEW:?}"
MOCK
chmod +x "$WORK_DIR/bin/kubectl"
cat >"$WORK_DIR/valid-kubeconfig-view.json" <<'JSON'
{
  "apiVersion": "v1",
  "kind": "Config",
  "preferences": {},
  "clusters": [{
    "name": "default",
    "cluster": {
      "certificate-authority-data": "Q0E=",
      "server": "https://127.0.0.1:16443"
    }
  }],
  "contexts": [{
    "name": "default",
    "context": {"cluster": "default", "user": "default"}
  }],
  "current-context": "default",
  "users": [{
    "name": "default",
    "user": {
      "client-certificate-data": "Q0VSVA==",
      "client-key-data": "S0VZ"
    }
  }]
}
JSON
printf '%s\n' 'apiVersion: v1' >"$WORK_DIR/valid-kubeconfig"
PATH="$WORK_DIR/bin:$PATH" \
MOCK_KUBECONFIG_VIEW="$WORK_DIR/valid-kubeconfig-view.json" \
KUBECONFIG="$WORK_DIR/valid-kubeconfig" \
EXPECTED_K3S_SERVER='https://127.0.0.1:16443' \
  "$OCI_DIR/scripts/validate-k3s-kubeconfig.sh" >/dev/null ||
  fail "valid inline-certificate k3s kubeconfig was rejected"
jq -e '
  .clusters[0].cluster.server == "https://127.0.0.1:16443" and
  (.users[0].user | keys | sort) ==
    ["client-certificate-data", "client-key-data"]
' "$WORK_DIR/valid-kubeconfig" >/dev/null ||
  fail "k3s kubeconfig was not reduced to the safe normalized shape"

jq '.users[0].user.exec = {"command":"/tmp/untrusted"}' \
  "$WORK_DIR/valid-kubeconfig-view.json" >"$WORK_DIR/exec-kubeconfig-view.json"
printf '%s\n' 'apiVersion: v1' >"$WORK_DIR/exec-kubeconfig"
if PATH="$WORK_DIR/bin:$PATH" \
    MOCK_KUBECONFIG_VIEW="$WORK_DIR/exec-kubeconfig-view.json" \
    KUBECONFIG="$WORK_DIR/exec-kubeconfig" \
    EXPECTED_K3S_SERVER='https://127.0.0.1:16443' \
      "$OCI_DIR/scripts/validate-k3s-kubeconfig.sh" >/dev/null 2>&1; then
  fail "k3s kubeconfig accepted an executable credential plugin"
fi

cat >"$WORK_DIR/external-key-kubeconfig" <<'YAML'
apiVersion: v1
users:
- name: default
  user:
    client-key: /tmp/untrusted
YAML
if PATH="$WORK_DIR/bin:$PATH" \
    MOCK_KUBECONFIG_VIEW="$WORK_DIR/valid-kubeconfig-view.json" \
    KUBECONFIG="$WORK_DIR/external-key-kubeconfig" \
    EXPECTED_K3S_SERVER='https://127.0.0.1:16443' \
      "$OCI_DIR/scripts/validate-k3s-kubeconfig.sh" >/dev/null 2>&1; then
  fail "k3s kubeconfig accepted an external credential file"
fi

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
