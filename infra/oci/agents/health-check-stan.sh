#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
# shellcheck source=../scripts/lib.sh
source "$OCI_DIR/scripts/lib.sh"

FIXTURE_FILE="${OCI_HEALTH_FIXTURE_FILE:-}"
if [[ -n "$FIXTURE_FILE" ]]; then
  [[ -f "$FIXTURE_FILE" ]] || oci_die "health fixture file does not exist"
  exec python3 "$OCI_DIR/agents/health-contract.py" "$FIXTURE_FILE"
fi

OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/oci-health}"
WORK_DIR="$OUTPUT_DIR/.raw"
SNAPSHOT_FILE="$OUTPUT_DIR/snapshot.json"
INFRA_PROVENANCE_FILE="${INFRA_PROVENANCE_FILE:-}"
IMAGE_PROVENANCE_FILE="${IMAGE_PROVENANCE_FILE:-}"
OCI_PUBLIC_URL="${OCI_PUBLIC_URL:-}"
OCI_REDIRECT_URL="${OCI_REDIRECT_URL:-}"
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
OCI_EXPECTED_SOURCE_SHA="${OCI_EXPECTED_SOURCE_SHA:-}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_MEMORY_MAX_PERCENT="${OCI_MEMORY_MAX_PERCENT:-70}"
OCI_DISK_MAX_PERCENT="${OCI_DISK_MAX_PERCENT:-70}"
OCI_CPU_MAX_PERCENT="${OCI_CPU_MAX_PERCENT:-90}"

oci_require_command kubectl
oci_require_cli_version
oci_require_command jq
oci_require_command python3
oci_require_vars \
  INFRA_PROVENANCE_FILE IMAGE_PROVENANCE_FILE OCI_PUBLIC_URL OCI_REDIRECT_URL \
  OCI_DIAGNOSTIC_URL OCI_EXPECTED_SOURCE_SHA
[[ "$OCI_EXPECTED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "OCI_EXPECTED_SOURCE_SHA must be a full lowercase commit SHA"
[[ -f "$INFRA_PROVENANCE_FILE" && -f "$IMAGE_PROVENANCE_FILE" ]] ||
  oci_die "health check requires verified infrastructure and image provenance files"
oci_require_value OCI_MEMORY_MAX_PERCENT 70
oci_require_value OCI_DISK_MAX_PERCENT 70
[[ "$OCI_CPU_MAX_PERCENT" == "90" ]] || oci_die "OCI_CPU_MAX_PERCENT must be 90"

unset source_sha runtime_mode cluster_ocid cluster_fingerprint
unset instance_ocid instance_fingerprint k3s_node_name
unset compartment_ocid namespace ingress_ipv4 public_host canonical_host
unset redirect_host diagnostic_host lb_ocid
unset node_shape node_ocpus node_memory_gb mongo_volume_gb lb_min_mbps lb_max_mbps expected_monthly_cost
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
oci_require_vars \
  runtime_mode compartment_ocid namespace ingress_ipv4 public_host \
  canonical_host redirect_host diagnostic_host lb_ocid
[[ "$runtime_mode" == "$(oci_runtime_mode)" ]] ||
  oci_die "health runtime differs from infrastructure provenance"
[[ "$source_sha" == "$OCI_EXPECTED_SOURCE_SHA" ]] ||
  oci_die "health source SHA differs from infrastructure provenance"
[[ "$public_host" == "$canonical_host" &&
   "${OCI_PUBLIC_URL%/}" == "https://${canonical_host}" &&
   "${OCI_REDIRECT_URL%/}" == "https://${redirect_host}" &&
   "${OCI_DIAGNOSTIC_URL%/}" == "https://${diagnostic_host}" &&
   "$canonical_host" == "betstan.xyz" &&
   "$redirect_host" == "www.${canonical_host}" &&
   "$diagnostic_host" == "${ingress_ipv4}.nip.io" ]] ||
  oci_die "health URLs differ from exact canonical ingress provenance"
[[ "$node_shape" == "VM.Standard.A1.Flex" && "$node_ocpus" == "2" &&
   "$node_memory_gb" == "12" && "$mongo_volume_gb" == "50" &&
   "$lb_min_mbps" == "10" && "$lb_max_mbps" == "10" &&
   "$expected_monthly_cost" == "0" ]] ||
  oci_die "health provenance violates approved Free Tier constants"
[[ "$namespace" == "$OCI_K8S_NAMESPACE" ]] || oci_die "namespace differs from infrastructure provenance"
if [[ "$runtime_mode" == "oke" ]]; then
  oci_require_vars cluster_ocid cluster_fingerprint
  runtime_ocid="$cluster_ocid"
  expected_runtime_fingerprint="$cluster_fingerprint"
else
  oci_require_vars instance_ocid instance_fingerprint k3s_node_name
  runtime_ocid="$instance_ocid"
  expected_runtime_fingerprint="$instance_fingerprint"
fi
[[ "$(oci_fingerprint "$runtime_ocid")" == "$expected_runtime_fingerprint" ]] ||
  oci_die "runtime fingerprint differs from infrastructure provenance"

oci_prepare_private_dir "$OUTPUT_DIR"
rm -rf "$WORK_DIR"
oci_prepare_private_dir "$WORK_DIR"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

public_ok=false
if [[ "${OCI_PUBLIC_CHECKS_ALREADY_PASSED:-0}" == "1" ]]; then
  public_ok=true
elif OCI_PUBLIC_URL="$OCI_PUBLIC_URL" \
  OCI_REDIRECT_URL="$OCI_REDIRECT_URL" \
  OCI_DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
  OUTPUT_DIR="$WORK_DIR/smoke" \
  "$OCI_DIR/agents/smoke-liveness-stan.sh" >/dev/null; then
  public_ok=true
fi

e2e_ok=false
if [[ "${OCI_E2E_ALREADY_PASSED:-0}" == "1" ]]; then
  e2e_ok=true
else
  playwright="$ROOT_DIR/client/node_modules/.bin/playwright"
  [[ -x "$playwright" ]] || oci_die "Playwright dependencies are missing from client/node_modules"
  if (
    cd "$ROOT_DIR"
    NODE_PATH="$ROOT_DIR/client/node_modules" \
    E2E_BASE_URL="$OCI_PUBLIC_URL" \
    OCI_E2E_OUTPUT_DIR="$WORK_DIR/e2e" \
      "$playwright" test --config "$OCI_DIR/agents/playwright.config.js"
  ) >/dev/null 2>&1; then
    e2e_ok=true
  fi
fi

cluster_json="$WORK_DIR/cluster.json"
kubeconfig_json="$WORK_DIR/kubeconfig.json"
nodes_json="$WORK_DIR/nodes.json"
metrics_json="$WORK_DIR/metrics.json"
summary_json="$WORK_DIR/summary.json"
deployments_json="$WORK_DIR/deployments.json"
statefulsets_json="$WORK_DIR/statefulsets.json"
ingress_deployments_json="$WORK_DIR/ingress-deployments.json"
cert_deployments_json="$WORK_DIR/cert-deployments.json"
certificates_json="$WORK_DIR/certificates.json"
cluster_issuer_json="$WORK_DIR/cluster-issuer.json"
pods_json="$WORK_DIR/pods.json"
services_json="$WORK_DIR/services.json"
slices_json="$WORK_DIR/slices.json"
pvcs_json="$WORK_DIR/pvcs.json"
lb_json="$WORK_DIR/lb.json"
inventory_json="$WORK_DIR/inventory.json"

if [[ "$runtime_mode" == "oke" ]]; then
  oci ce cluster get --cluster-id "$cluster_ocid" > "$cluster_json"
else
  oci compute instance get --instance-id "$instance_ocid" > "$cluster_json"
fi
kubectl config view --raw --minify -o json > "$kubeconfig_json"
kubectl get nodes -o json > "$nodes_json"
node_name="$(jq -r '.items[0].metadata.name // empty' "$nodes_json")"
[[ -n "$node_name" ]] || oci_die "Kubernetes worker node is missing"
kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes > "$metrics_json"
kubectl get --raw "/api/v1/nodes/${node_name}/proxy/stats/summary" > "$summary_json"
kubectl get deployments -n "$OCI_K8S_NAMESPACE" -o json > "$deployments_json"
kubectl get statefulsets -n "$OCI_K8S_NAMESPACE" -o json > "$statefulsets_json"
kubectl get deployments -n ingress-nginx -o json > "$ingress_deployments_json"
kubectl get deployments -n cert-manager -o json > "$cert_deployments_json"
kubectl get certificates -n "$OCI_K8S_NAMESPACE" -o json > "$certificates_json"
kubectl get clusterissuer letsencrypt-prod -o json > "$cluster_issuer_json"
kubectl get pods -n "$OCI_K8S_NAMESPACE" -o json > "$pods_json"
kubectl get services -n "$OCI_K8S_NAMESPACE" -o json > "$services_json"
kubectl get endpointslices.discovery.k8s.io -n "$OCI_K8S_NAMESPACE" -o json > "$slices_json"
kubectl get persistentvolumeclaims -n "$OCI_K8S_NAMESPACE" -o json > "$pvcs_json"
oci lb load-balancer get --load-balancer-id "$lb_ocid" > "$lb_json"
INVENTORY_MODE=complete OUTPUT_FILE="$inventory_json" "$OCI_DIR/scripts/inventory.sh" >/dev/null

configured_server="$(jq -r '.clusters[0].cluster.server // empty' "$kubeconfig_json")"
if [[ "$runtime_mode" == "oke" ]]; then
  kube_provenance="$(
    jq -r --arg cluster "$cluster_ocid" '
      ([.users[].user.exec.args[]? | select(. == $cluster)] | length == 1)
    ' "$kubeconfig_json"
  )"
  provider_endpoint="$(jq -r '.data.endpoints."public-endpoint" // empty' "$cluster_json")"
  if [[ -z "$configured_server" || -z "$provider_endpoint" ||
        "$configured_server" != *"$provider_endpoint"* ]]; then
    kube_provenance=false
  fi
else
  kube_provenance="$(
    jq -r --arg node "$k3s_node_name" --arg provider_id "oci://${instance_ocid}" '
      (.items | length) == 1 and
      .items[0].metadata.name == $node and
      .items[0].spec.providerID == $provider_id
    ' "$nodes_json"
  )"
  if [[ ! "$configured_server" =~ ^https://127\.0\.0\.1:[0-9]+$ ]]; then
    kube_provenance=false
  fi
fi
live_compartment="$(jq -r '.data."compartment-id"' "$cluster_json")"

node_health="$(
  python3 - "$nodes_json" "$metrics_json" "$summary_json" <<'PY'
import json
import re
import sys

nodes = json.load(open(sys.argv[1], encoding="utf-8"))
metrics = json.load(open(sys.argv[2], encoding="utf-8"))
summary = json.load(open(sys.argv[3], encoding="utf-8"))

def cpu_cores(value):
    match = re.fullmatch(r"([0-9.]+)(n|u|m)?", value)
    if not match:
        raise ValueError(f"unsupported CPU quantity: {value}")
    amount = float(match.group(1))
    return amount * {"n": 1e-9, "u": 1e-6, "m": 1e-3, None: 1}[match.group(2)]

def bytes_value(value):
    match = re.fullmatch(r"([0-9.]+)(Ki|Mi|Gi|Ti|K|M|G|T)?", value)
    if not match:
        raise ValueError(f"unsupported memory quantity: {value}")
    amount = float(match.group(1))
    suffix = match.group(2)
    powers = {None: 1, "Ki": 1024, "Mi": 1024**2, "Gi": 1024**3, "Ti": 1024**4,
              "K": 1000, "M": 1000**2, "G": 1000**3, "T": 1000**4}
    return amount * powers[suffix]

items = nodes.get("items", [])
node = items[0] if items else {}
conditions = {item.get("type"): item.get("status") for item in node.get("status", {}).get("conditions", [])}
usage = (metrics.get("items") or [{}])[0].get("usage", {})
allocatable = node.get("status", {}).get("allocatable", {})
cpu_percent = cpu_cores(usage["cpu"]) / cpu_cores(allocatable["cpu"]) * 100
memory_percent = bytes_value(usage["memory"]) / bytes_value(allocatable["memory"]) * 100
filesystem = summary.get("node", {}).get("fs", {})
disk_percent = float(filesystem["usedBytes"]) / float(filesystem["capacityBytes"]) * 100
print(json.dumps({
    "count": len(items),
    "ready": conditions.get("Ready") == "True",
    "architecture": node.get("status", {}).get("nodeInfo", {}).get("architecture"),
    "instance_type": node.get("metadata", {}).get("labels", {}).get("node.kubernetes.io/instance-type"),
    "memory_pressure": conditions.get("MemoryPressure") == "True",
    "disk_pressure": conditions.get("DiskPressure") == "True",
    "pid_pressure": conditions.get("PIDPressure") == "True",
    "network_unavailable": conditions.get("NetworkUnavailable") == "True",
    "cpu_percent": round(cpu_percent, 2),
    "memory_percent": round(memory_percent, 2),
    "disk_percent": round(disk_percent, 2),
}))
PY
)" || oci_die "unable to calculate fail-closed Kubernetes resource thresholds"

workloads="$(
  jq -s '
    [
      .[0].items[]? | {
        kind:"Deployment", name:.metadata.name,
        desired:(.spec.replicas // 0), ready:(.status.availableReplicas // 0)
      }
    ] + [
      .[1].items[]? | {
        kind:"StatefulSet", name:.metadata.name,
        desired:(.spec.replicas // 0), ready:(.status.readyReplicas // 0)
      }
    ]
  ' "$deployments_json" "$statefulsets_json"
)"

platform_workloads="$(
  python3 - "$ingress_deployments_json" "$cert_deployments_json" <<'PY'
import json
import sys

result = []
for namespace, path in (("ingress-nginx", sys.argv[1]), ("cert-manager", sys.argv[2])):
    deployments = json.load(open(path, encoding="utf-8"))
    for item in deployments.get("items", []):
        container = (item.get("spec", {}).get("template", {}).get("spec", {}).get("containers") or [{}])[0]
        result.append({
            "identity": f"{namespace}/{item.get('metadata', {}).get('name')}",
            "desired": item.get("spec", {}).get("replicas", 0),
            "ready": item.get("status", {}).get("availableReplicas", 0),
            "architecture": item.get("spec", {}).get("template", {}).get("spec", {}).get(
                "nodeSelector", {}
            ).get("kubernetes.io/arch"),
            "image": container.get("image", ""),
        })
print(json.dumps(result))
PY
)"

pods="$(
  python3 - "$pods_json" "$IMAGE_PROVENANCE_FILE" <<'PY'
import csv
import json
import sys

pods = json.load(open(sys.argv[1], encoding="utf-8"))
expected = {
    "gaming-auth-mongo": {
        "sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3",
        "sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4",
    },
    "gaming-rabbitmq": {
        "sha256:6033d0c2f4e9eb49dda9623067a96d317bc7b550513bd18532fbd3cd9a941c1b",
    },
}
with open(sys.argv[2], encoding="utf-8") as handle:
    for row in csv.reader(handle, delimiter="\t"):
        if not row:
            continue
        service, _, _, manifest_digest, platform_digest = row
        expected[f"gaming-{service}"] = {manifest_digest, platform_digest}

result = []
for pod in pods.get("items", []):
    statuses = pod.get("status", {}).get("containerStatuses") or []
    reasons = []
    digest_match = True
    for status in statuses:
        waiting = status.get("state", {}).get("waiting", {}).get("reason")
        terminated = status.get("lastState", {}).get("terminated", {}).get("reason")
        if waiting:
            reasons.append(waiting)
        if terminated:
            reasons.append(terminated)
        digests = expected.get(status.get("name"), set())
        if not any(
            status.get("imageID", "").endswith("@" + digest)
            for digest in digests
        ):
            digest_match = False
    if pod.get("status", {}).get("reason"):
        reasons.append(pod["status"]["reason"])
    conditions = {item.get("type"): item.get("status") for item in pod.get("status", {}).get("conditions", [])}
    result.append({
        "name": pod.get("metadata", {}).get("name"),
        "ready": conditions.get("Ready") == "True" and bool(statuses) and all(item.get("ready") for item in statuses),
        "architecture": "arm64",
        "digest_match": digest_match,
        "restarts": sum(int(item.get("restartCount", 0)) for item in statuses),
        "last_reason": ",".join(reasons),
    })
print(json.dumps(result))
PY
)"

service_health="$(
  python3 - "$services_json" "$slices_json" <<'PY'
import json
import sys

services = json.load(open(sys.argv[1], encoding="utf-8"))
slices = json.load(open(sys.argv[2], encoding="utf-8"))
ready = {}
for item in slices.get("items", []):
    name = item.get("metadata", {}).get("labels", {}).get("kubernetes.io/service-name")
    if not name:
        continue
    endpoints = item.get("endpoints") or []
    ready[name] = ready.get(name, False) or any(
        endpoint.get("addresses")
        and endpoint.get("conditions", {}).get("ready") is not False
        for endpoint in endpoints
    )
print(json.dumps([
    {
        "name": item.get("metadata", {}).get("name"),
        "type": item.get("spec", {}).get("type", "ClusterIP"),
        "ready_endpoints": ready.get(item.get("metadata", {}).get("name"), False),
    }
    for item in services.get("items", [])
]))
PY
)"

mongo_pod="$(kubectl get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$mongo_pod" ]] || oci_die "Mongo pod is missing"
mongo_runtime_json="$(
  kubectl exec -n "$OCI_K8S_NAMESPACE" "$mongo_pod" -- \
    mongosh --quiet --eval '
      const result=db.adminCommand({getParameter:1,featureCompatibilityVersion:1});
      if (result.ok !== 1) throw new Error("FCV read failed");
      print(JSON.stringify({
        version:db.version(),
        majorMinor:db.version().split(".").slice(0,2).join("."),
        fcv:result.featureCompatibilityVersion.version
      }));
    '
)"
jq -e '
  .version == "8.2.12" and .majorMinor == "8.2" and .fcv == "8.2"
' <<<"$mongo_runtime_json" >/dev/null ||
  oci_die "Mongo runtime differs from exact version 8.2.12 and FCV 8.2"
database_json="$(
  kubectl exec -n "$OCI_K8S_NAMESPACE" "$mongo_pod" -- \
    mongosh --quiet --eval \
    'print(JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>d.name).filter(n=>n.startsWith("gaming_")).sort()))'
)"
jq -e 'type == "array"' <<<"$database_json" >/dev/null || oci_die "Mongo database inventory is invalid"

mongo_sts_count="$(jq '[.items[]? | select(.metadata.name | test("mongo"))] | length' "$statefulsets_json")"
mongo_pvc_count="$(jq '[.items[]? | select(.metadata.name | test("mongo"))] | length' "$pvcs_json")"
mongo_pvc_inventory="$(
  jq -c '[
    .items[]?
    | select(.metadata.name | test("mongo"))
    | {
        name: .metadata.name,
        phase: (.status.phase // "")
      }
  ] | sort_by(.name)' "$pvcs_json"
)"
mongo_pvc_bound="$(jq -r '[.items[]? | select(.metadata.name == "gaming-auth-mongo-data")][0].status.phase == "Bound"' "$pvcs_json")"
mongo_pvc_size="$(jq -r '[.items[]? | select(.metadata.name == "gaming-auth-mongo-data")][0].spec.resources.requests.storage // ""' "$pvcs_json")"
mongo_pvc_gib=0
[[ "$mongo_pvc_size" == "50Gi" ]] && mongo_pvc_gib=50

rabbit_pod="$(kubectl get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-rabbitmq -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$rabbit_pod" ]] || oci_die "RabbitMQ pod is missing"
queue_output="$(
  kubectl exec -n "$OCI_K8S_NAMESPACE" "$rabbit_pod" -- \
    rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers
)"
queue_rows="$(oci_rabbitmq_queue_rows <<<"$queue_output")" ||
  oci_die "RabbitMQ queue output is malformed"
queue_count="$(awk 'NF {count++} END {print count+0}' <<<"$queue_rows")"
queue_backlog="$(awk '{sum += $2 + $3} END {print sum+0}' <<<"$queue_rows")"
all_consumers=true
awk '$4 < 1 {bad=1} END {exit bad}' <<<"$queue_rows" || all_consumers=false
queue_baseline_match=false
if [[ -n "${OCI_RABBITMQ_BASELINE_FILE:-}" ]]; then
  [[ -f "$OCI_RABBITMQ_BASELINE_FILE" ]] || oci_die "RabbitMQ baseline file is missing"
  observed_names="$(awk '{print $1}' <<<"$queue_rows" | sort)"
  expected_names="$(sort "$OCI_RABBITMQ_BASELINE_FILE")"
  [[ "$observed_names" == "$expected_names" ]] && queue_baseline_match=true
elif [[ "$queue_count" == "$(oci_application_rabbitmq_queue_count)" ]]; then
  queue_baseline_match=true
fi

canonical_certificate_ready="$(
  jq -r --arg canonical "$canonical_host" --arg redirect "$redirect_host" '
    [.items[] | select(
      .metadata.name == "betstan-oci-canonical-tls" and
      .spec.issuerRef.kind == "ClusterIssuer" and
      .spec.issuerRef.name == "letsencrypt-prod" and
      (.spec.dnsNames | sort) == ([$canonical, $redirect] | sort) and
      ([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length) == 1
    )] | length == 1
  ' "$certificates_json"
)"
diagnostic_certificate_ready="$(
  jq -r --arg diagnostic "$diagnostic_host" '
    [.items[] | select(
      .metadata.name == "betstan-oci-tls" and
      .spec.issuerRef.kind == "ClusterIssuer" and
      .spec.issuerRef.name == "letsencrypt-prod" and
      .spec.dnsNames == [$diagnostic] and
      ([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length) == 1
    )] | length == 1
  ' "$certificates_json"
)"
cluster_issuer_ready="$(
  jq -r '
    .metadata.name == "letsencrypt-prod" and
    .spec.acme.server == "https://acme-v02.api.letsencrypt.org/directory" and
    ([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length) == 1
  ' "$cluster_issuer_json"
)"
certificate_ready=false
[[ "$canonical_certificate_ready" == "true" &&
   "$diagnostic_certificate_ready" == "true" &&
   "$cluster_issuer_ready" == "true" ]] &&
  certificate_ready=true
load_balancer_service_count="$(
  kubectl get services -A -o json |
    jq '[.items[] | select(.spec.type == "LoadBalancer")] | length'
)"
live_ingress_ip="$(
  if [[ "$runtime_mode" == "oke" ]]; then
    kubectl get service ingress-nginx-controller -n ingress-nginx \
      -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
  else
    jq -r '
      [.data."ip-addresses"[]? | select(."is-public" == true)][0]."ip-address" // empty
    ' "$lb_json"
  fi
)"
ipv4_match=false
provider_lb_ip_match="$(
  jq -r --arg ip "$ingress_ipv4" '
    [.data."ip-addresses"[]?."ip-address" | select(. == $ip)] | length == 1
  ' "$lb_json"
)"
[[ "$live_ingress_ip" == "$ingress_ipv4" && "$provider_lb_ip_match" == "true" ]] &&
  ipv4_match=true

if [[ "$runtime_mode" == "oke" ]]; then
  lb_type="$(
    kubectl get service ingress-nginx-controller -n ingress-nginx -o json |
      jq -r '.metadata.annotations["oci.oraclecloud.com/load-balancer-type"] // empty'
  )"
else
  lb_type=lb
fi
lb_shape="$(jq -r '.data."shape-name"' "$lb_json")"
lb_min="$(jq -r '.data."shape-details"."minimum-bandwidth-in-mbps"' "$lb_json")"
lb_max="$(jq -r '.data."shape-details"."maximum-bandwidth-in-mbps"' "$lb_json")"

all_immutable="$(
  jq -s '
    ([.[0].items[], .[1].items[]]
      | map(.spec.template.spec.containers[]?.image)
      | all(test("@sha256:[0-9a-f]{64}$")))
  ' "$deployments_json" "$statefulsets_json"
)"
all_digest_match="$(jq -r 'all(.digest_match == true)' <<<"$pods")"

jq -n \
  --arg runtime_mode "$runtime_mode" \
  --arg cluster_fingerprint "$(oci_fingerprint "$(jq -r '.data.id' "$cluster_json")")" \
  --arg expected_cluster_fingerprint "$expected_runtime_fingerprint" \
  --arg compartment_fingerprint "$(oci_fingerprint "$live_compartment")" \
  --arg expected_compartment_fingerprint "$(oci_fingerprint "$compartment_ocid")" \
  --arg namespace "$OCI_K8S_NAMESPACE" \
  --arg expected_namespace "$namespace" \
  --argjson kube_provenance "$kube_provenance" \
  --argjson node "$node_health" \
  --argjson workloads "$workloads" \
  --argjson platform_workloads "$platform_workloads" \
  --argjson pods "$pods" \
  --argjson mongo_sts_count "$mongo_sts_count" \
  --argjson mongo_pvc_count "$mongo_pvc_count" \
  --argjson mongo_pvc_inventory "$mongo_pvc_inventory" \
  --argjson mongo_pvc_bound "$mongo_pvc_bound" \
  --argjson mongo_pvc_gib "$mongo_pvc_gib" \
  --argjson mongo_runtime "$mongo_runtime_json" \
  --argjson databases "$database_json" \
  --argjson services "$service_health" \
  --argjson queue_count "$queue_count" \
  --argjson queue_baseline_match "$queue_baseline_match" \
  --argjson all_consumers "$all_consumers" \
  --argjson queue_backlog "$queue_backlog" \
  --argjson lb_count "$load_balancer_service_count" \
  --argjson ipv4_match "$ipv4_match" \
  --argjson certificate_ready "$certificate_ready" \
  --argjson canonical_certificate_ready "$canonical_certificate_ready" \
  --argjson diagnostic_certificate_ready "$diagnostic_certificate_ready" \
  --argjson cluster_issuer_ready "$cluster_issuer_ready" \
  --argjson public_ok "$public_ok" \
  --argjson e2e_ok "$e2e_ok" \
  --argjson all_immutable "$all_immutable" \
  --argjson all_digest_match "$all_digest_match" \
  --arg lb_type "$lb_type" \
  --arg lb_shape "$lb_shape" \
  --argjson lb_min "$lb_min" \
  --argjson lb_max "$lb_max" \
  --argjson memory_threshold "$OCI_MEMORY_MAX_PERCENT" \
  --argjson disk_threshold "$OCI_DISK_MAX_PERCENT" \
  --argjson cpu_threshold "$OCI_CPU_MAX_PERCENT" \
  '{
    context: {
      runtime_mode: $runtime_mode,
      cluster_fingerprint: $cluster_fingerprint,
      expected_cluster_fingerprint: $expected_cluster_fingerprint,
      compartment_fingerprint: $compartment_fingerprint,
      expected_compartment_fingerprint: $expected_compartment_fingerprint,
      namespace: $namespace,
      expected_namespace: $expected_namespace,
      kube_provenance: $kube_provenance
    },
    thresholds: {
      memory_percent: $memory_threshold,
      disk_percent: $disk_threshold,
      cpu_percent: $cpu_threshold
    },
    node: $node,
    workloads: $workloads,
    platform_workloads: $platform_workloads,
    pods: $pods,
    mongo: {
      statefulset_count: $mongo_sts_count,
      pvc_count: $mongo_pvc_count,
      pvc_inventory: $mongo_pvc_inventory,
      pvc_bound: $mongo_pvc_bound,
      pvc_gib: $mongo_pvc_gib,
      version: $mongo_runtime.version,
      major_minor: $mongo_runtime.majorMinor,
      fcv: $mongo_runtime.fcv,
      logical_databases: $databases
    },
    services: $services,
    rabbitmq: {
      queue_count: $queue_count,
      baseline_match: $queue_baseline_match,
      all_consumers: $all_consumers,
      backlog: $queue_backlog
    },
    ingress: {
      load_balancer_service_count: $lb_count,
      ipv4_match: $ipv4_match,
      certificate_ready: $certificate_ready,
      canonical_certificate_ready: $canonical_certificate_ready,
      diagnostic_certificate_ready: $diagnostic_certificate_ready,
      cluster_issuer_ready: $cluster_issuer_ready,
      https_trusted: $public_ok,
      http_redirect: $public_ok,
      www_redirect: $public_ok,
      diagnostic_https_trusted: $public_ok,
      dns_match: $public_ok
    },
    application: {
      homepage_marker: $public_ok,
      api_json: $public_ok,
      e2e: $e2e_ok
    },
    images: {
      all_immutable: $all_immutable,
      all_digest_match: $all_digest_match
    },
    inventory: {
      expected_monthly_cost: 0,
      unexpected_billable: false,
      lb_type: $lb_type,
      lb_shape: $lb_shape,
      lb_min_mbps: $lb_min,
      lb_max_mbps: $lb_max
    }
  }' > "$SNAPSHOT_FILE"

python3 "$OCI_DIR/agents/health-contract.py" "$SNAPSHOT_FILE"
