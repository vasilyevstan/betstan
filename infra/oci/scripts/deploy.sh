#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SOURCE_SHA="${SOURCE_SHA:-${1:-}}"
IMAGE_PROVENANCE_FILE="${IMAGE_PROVENANCE_FILE:-${2:-}}"
INFRA_PROVENANCE_FILE="${INFRA_PROVENANCE_FILE:-${3:-}}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-deploy}"
RENDERED_FILE="${RENDERED_FILE:-$OUTPUT_DIR/rendered.yaml}"
OCI_CERT_EMAIL="${OCI_CERT_EMAIL:-}"
OCI_CANONICAL_HOST="${OCI_CANONICAL_HOST:-betstan.xyz}"
OCI_REDIRECT_HOST="${OCI_REDIRECT_HOST:-www.betstan.xyz}"

[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || oci_die "SOURCE_SHA must be a full lowercase commit SHA"
[[ -f "$IMAGE_PROVENANCE_FILE" ]] || oci_die "verified image provenance TSV is required"
[[ -f "$INFRA_PROVENANCE_FILE" ]] || oci_die "verified infrastructure provenance is required"
oci_require_command kubectl
oci_require_command jq
oci_require_command ruby
oci_require_cli_version
oci_require_vars \
  OCI_JWT_KEY OCI_REGISTRY_HOST OCI_REGISTRY_USERNAME OCI_REGISTRY_AUTH_TOKEN \
  OCI_K8S_NAMESPACE OCI_CERT_EMAIL OCI_COMPARTMENT_OCID

unset source_sha runtime_mode infrastructure_finalized
unset cluster_ocid cluster_fingerprint instance_ocid instance_fingerprint
unset compartment_ocid ingress_ipv4 public_host canonical_host redirect_host diagnostic_host
unset lb_ocid k3s_node_name
unset node_shape node_ocpus node_memory_gb mongo_volume_gb lb_min_mbps lb_max_mbps expected_monthly_cost
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
[[ "${source_sha:-}" == "$SOURCE_SHA" ]] || oci_die "infrastructure provenance source SHA mismatch"
oci_require_vars \
  runtime_mode infrastructure_finalized compartment_ocid ingress_ipv4 \
  public_host canonical_host redirect_host diagnostic_host
[[ "$runtime_mode" == "$(oci_runtime_mode)" ]] ||
  oci_die "infrastructure provenance runtime mismatch"
[[ "$infrastructure_finalized" == "true" ]] ||
  oci_die "infrastructure provenance is not finalized"
[[ "$node_shape" == "VM.Standard.A1.Flex" && "$node_ocpus" == "2" &&
   "$node_memory_gb" == "12" && "$mongo_volume_gb" == "50" &&
   "$lb_min_mbps" == "10" && "$lb_max_mbps" == "10" &&
   "$expected_monthly_cost" == "0" ]] ||
  oci_die "infrastructure provenance violates approved Free Tier constants"
[[ "$compartment_ocid" == "$OCI_COMPARTMENT_OCID" ]] ||
  oci_die "infrastructure provenance compartment mismatch"
oci_validate_public_ipv4 "$ingress_ipv4" || oci_die "provenance ingress address is not public IPv4"
[[ "$OCI_CANONICAL_HOST" == "betstan.xyz" &&
   "$OCI_REDIRECT_HOST" == "www.${OCI_CANONICAL_HOST}" ]] ||
  oci_die "deployment canonical hosts differ from the reviewed contract"
[[ "$public_host" == "$OCI_CANONICAL_HOST" &&
   "$canonical_host" == "$OCI_CANONICAL_HOST" &&
   "$redirect_host" == "$OCI_REDIRECT_HOST" ]] ||
  oci_die "public hosts differ from infrastructure provenance"
[[ "$diagnostic_host" == "${ingress_ipv4}.nip.io" ]] ||
  oci_die "diagnostic host is not derived from the provenance IPv4"

kubeconfig_json="$(kubectl config view --raw --minify -o json)"
cluster_server="$(jq -r '.clusters[0].cluster.server // empty' <<<"$kubeconfig_json")"
if [[ "$runtime_mode" == "oke" ]]; then
  oci_require_vars cluster_ocid cluster_fingerprint
  [[ "$(oci_fingerprint "$cluster_ocid")" == "$cluster_fingerprint" ]] ||
    oci_die "infrastructure cluster fingerprint mismatch"
  cluster="$(oci ce cluster get --cluster-id "$cluster_ocid")"
  [[ "$(jq -r '.data."compartment-id"' <<<"$cluster")" == "$compartment_ocid" ]] ||
    oci_die "live cluster compartment does not match infrastructure provenance"
  [[ "$(jq -r '.data.type' <<<"$cluster")" == "BASIC_CLUSTER" ]] ||
    oci_die "live cluster is not OKE Basic"
  jq -e --arg cluster "$cluster_ocid" '
    [.users[].user.exec.args[]? | select(. == $cluster)] | length == 1
  ' <<<"$kubeconfig_json" >/dev/null ||
    oci_die "kubeconfig was not generated from the exact cluster OCID"
  provider_endpoint="$(jq -r '.data.endpoints."public-endpoint" // empty' <<<"$cluster")"
  [[ -n "$cluster_server" && "$cluster_server" == *"$provider_endpoint"* ]] ||
    oci_die "kubeconfig API endpoint does not match OCI cluster provenance"
  runtime_fingerprint="$cluster_fingerprint"
else
  oci_require_vars instance_ocid instance_fingerprint lb_ocid k3s_node_name
  [[ "$(oci_fingerprint "$instance_ocid")" == "$instance_fingerprint" ]] ||
    oci_die "infrastructure instance fingerprint mismatch"
  [[ "$cluster_server" =~ ^https://127\.0\.0\.1:[0-9]+$ ]] ||
    oci_die "k3s kubeconfig does not use the local Bastion tunnel"
  instance="$(oci compute instance get --instance-id "$instance_ocid")"
  jq -e \
    --arg compartment "$compartment_ocid" \
    --arg sha "$SOURCE_SHA" '
      .data."compartment-id" == $compartment and
      .data."lifecycle-state" == "RUNNING" and
      .data.shape == "VM.Standard.A1.Flex" and
      .data."freeform-tags"."betstan-runtime" == "k3s" and
      .data."freeform-tags"."source-sha" == $sha
    ' <<<"$instance" >/dev/null ||
    oci_die "live k3s instance differs from infrastructure provenance"
  node="$(kubectl get node "$k3s_node_name" -o json)"
  jq -e --arg provider_id "oci://${instance_ocid}" '
    .spec.providerID == $provider_id and
    .metadata.labels."kubernetes.io/arch" == "arm64" and
    ([.status.conditions[] | select(
      .type == "Ready" and .status == "True"
    )] | length) == 1
  ' <<<"$node" >/dev/null ||
    oci_die "k3s node identity or readiness differs from provenance"
  runtime_fingerprint="$instance_fingerprint"
fi

oci_prepare_private_dir "$OUTPUT_DIR"
OCI_CANONICAL_HOST="$canonical_host" \
OCI_REDIRECT_HOST="$redirect_host" \
OCI_CERT_EMAIL="$OCI_CERT_EMAIL" \
OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
IMAGE_PROVENANCE_FILE="$IMAGE_PROVENANCE_FILE" \
INFRA_PROVENANCE_FILE="$INFRA_PROVENANCE_FILE" \
OUTPUT_FILE="$RENDERED_FILE" \
  "$SCRIPT_DIR/render-manifests.sh"

emit_documents() {
  local selector="$1"
  ruby -ryaml - "$RENDERED_FILE" "$selector" <<'RUBY'
file, selector = ARGV
kind, name_pattern = selector.split(":", 2)
pattern = Regexp.new(name_pattern)
YAML.load_stream(File.read(file)).compact.each do |document|
  next unless document["kind"] == kind
  next unless document.dig("metadata", "name").to_s.match?(pattern)
  print YAML.dump(document)
end
RUBY
}

apply_documents() {
  local selector="$1"
  local rendered
  rendered="$(emit_documents "$selector")"
  [[ -n "$rendered" ]] || oci_die "render selector returned no documents: $selector"
  printf '%s' "$rendered" | kubectl apply -f -
}

mongo_target_image="$(
  ruby -ryaml - "$RENDERED_FILE" <<'RUBY'
documents = YAML.load_stream(File.read(ARGV.fetch(0))).compact
mongo = documents.find { |document|
  document["kind"] == "StatefulSet" &&
    document.dig("metadata", "name") == "gaming-auth-mongo-depl"
}
abort "rendered Mongo StatefulSet is missing" unless mongo
containers = mongo.dig("spec", "template", "spec", "containers") || []
container = containers.find { |item| item["name"] == "gaming-auth-mongo" }
abort "rendered Mongo container is missing" unless container
puts container.fetch("image")
RUBY
)"
mongo_upgrade_state_file="$OUTPUT_DIR/mongo-upgrade.env"

apply_documents "Namespace:^${OCI_K8S_NAMESPACE}$"

printf '%s' "$OCI_JWT_KEY" |
  kubectl create secret generic jwt-secret \
    --namespace "$OCI_K8S_NAMESPACE" \
    --from-file=JWT_KEY=/dev/stdin \
    --dry-run=client -o yaml |
  kubectl apply -f - >/dev/null

python3 - "$OCI_REGISTRY_HOST" "$OCI_REGISTRY_USERNAME" <<'PY' |
import base64
import json
import os
import sys

host, username = sys.argv[1:3]
password = os.environ["OCI_REGISTRY_AUTH_TOKEN"]
auth = base64.b64encode(f"{username}:{password}".encode()).decode()
print(json.dumps({"auths": {host: {"username": username, "password": password, "auth": auth}}}))
PY
  kubectl create secret generic ocir-pull \
    --namespace "$OCI_K8S_NAMESPACE" \
    --type=kubernetes.io/dockerconfigjson \
    --from-file=.dockerconfigjson=/dev/stdin \
    --dry-run=client -o yaml |
  kubectl apply -f - >/dev/null
kubectl patch serviceaccount default -n "$OCI_K8S_NAMESPACE" --type merge \
  -p '{"imagePullSecrets":[{"name":"ocir-pull"}]}' >/dev/null

apply_documents 'PersistentVolume:^gaming-auth-mongo-data$'
apply_documents 'PersistentVolumeClaim:^gaming-auth-mongo-data$'
kubectl wait pvc/gaming-auth-mongo-data -n "$OCI_K8S_NAMESPACE" \
  --for=jsonpath='{.status.phase}'=Bound --timeout=10m
apply_documents 'ClusterIssuer:^letsencrypt-prod$'
apply_documents 'Service:^gaming-(auth-mongo|shared-mongo)-srv$'
OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
MONGO_TARGET_IMAGE="$mongo_target_image" \
MONGO_UPGRADE_STATE_FILE="$mongo_upgrade_state_file" \
  "$SCRIPT_DIR/upgrade-mongo.sh" prepare
apply_documents 'StatefulSet:^gaming-auth-mongo-depl$'
kubectl rollout status statefulset/gaming-auth-mongo-depl \
  -n "$OCI_K8S_NAMESPACE" --timeout=10m
mongo_pod="$(
  kubectl get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo \
    -o jsonpath='{.items[0].metadata.name}'
)"
[[ -n "$mongo_pod" ]] || oci_die "Mongo pod is missing after rollout"
mongo_ready=0
for _ in $(seq 1 60); do
  if kubectl exec -n "$OCI_K8S_NAMESPACE" "$mongo_pod" -- \
      mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null |
      grep -qx 1; then
    mongo_ready=1
    break
  fi
  sleep 5
done
[[ "$mongo_ready" == "1" ]] || oci_die "Mongo did not become ready before deployment"
OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
MONGO_TARGET_IMAGE="$mongo_target_image" \
MONGO_UPGRADE_STATE_FILE="$mongo_upgrade_state_file" \
  "$SCRIPT_DIR/upgrade-mongo.sh" finalize
for database in \
  gaming_auth gaming_bet gaming_backoffice gaming_event \
  gaming_gamemaster gaming_moderation gaming_resulting gaming_slip; do
  database_exists="$(
    kubectl exec -n "$OCI_K8S_NAMESPACE" "$mongo_pod" -- \
      mongosh --quiet --eval "
        print(db.adminCommand({listDatabases:1}).databases.some(d=>d.name==='${database}'));
      "
  )"
  if [[ "$database_exists" != "true" ]]; then
    kubectl exec -n "$OCI_K8S_NAMESPACE" "$mongo_pod" -- \
      mongosh --quiet --eval \
      "db.getSiblingDB('${database}').createCollection('_betstan_oci_init')" >/dev/null
  fi
done

apply_documents 'Service:^gaming-rabbitmq-srv$'
apply_documents 'Deployment:^gaming-rabbitmq-depl$'
kubectl rollout status deployment/gaming-rabbitmq-depl \
  -n "$OCI_K8S_NAMESPACE" --timeout=10m

# Roll out API dependencies before Client; Gamemaster remains the final producer.
services=(auth bet event moderation resulting slip backoffice client gamemaster)
[[ "${services[$(( ${#services[@]} - 1 ))]}" == "gamemaster" ]] ||
  oci_die "gamemaster must rollout last"
for service in "${services[@]}"; do
  apply_documents "Service:^gaming-${service}-srv$"
  apply_documents "Deployment:^gaming-${service}-depl$"
  kubectl rollout status "deployment/gaming-${service}-depl" \
    -n "$OCI_K8S_NAMESPACE" --timeout=10m
done

rabbit_pod="$(
  kubectl get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-rabbitmq \
    -o jsonpath='{.items[0].metadata.name}'
)"
[[ -n "$rabbit_pod" ]] || oci_die "RabbitMQ pod is missing after rollout"
rabbit_baseline_ready=0
queue_rows=""
for _ in $(seq 1 60); do
  queue_state="$(
    kubectl exec -n "$OCI_K8S_NAMESPACE" "$rabbit_pod" -- \
      rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers \
      2>/dev/null || true
  )"
  if queue_rows="$(oci_rabbitmq_queue_rows <<<"$queue_state")"; then
    queue_count="$(awk 'NF {count++} END {print count+0}' <<<"$queue_rows")"
    if [[ "$queue_count" == "17" ]] &&
        awk '$4 < 1 {bad=1} END {exit bad}' <<<"$queue_rows"; then
      rabbit_baseline_ready=1
      break
    fi
  fi
  sleep 5
done
[[ "$rabbit_baseline_ready" == "1" ]] ||
  oci_die "RabbitMQ did not establish the expected 17-consumer baseline"
awk '{print $1}' <<<"$queue_rows" | sort > "$OUTPUT_DIR/rabbitmq-baseline.txt"

apply_documents 'Certificate:^betstan-oci-(canonical-)?tls$'
apply_documents 'Ingress:^gaming-oci-(ingress|www-redirect)$'

if [[ "$runtime_mode" == "oke" ]]; then
  live_ingress_ip="$(
    kubectl get service ingress-nginx-controller -n ingress-nginx \
      -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
  )"
else
  lb="$(oci lb load-balancer get --load-balancer-id "$lb_ocid")"
  live_ingress_ip="$(
    jq -r '
      [.data."ip-addresses"[]? | select(."is-public" == true)][0]."ip-address" // empty
    ' <<<"$lb"
  )"
fi
[[ "$live_ingress_ip" == "$ingress_ipv4" ]] ||
  oci_die "Kubernetes ingress IPv4 differs from infrastructure provenance"

declare -A expected_digests=()
declare -A expected_platform_digests=()
while IFS=$'\t' read -r service _repository _image_ref digest platform_digest; do
  expected_digests["$service"]="$digest"
  expected_platform_digests["$service"]="$platform_digest"
done < "$IMAGE_PROVENANCE_FILE"
for service in "${services[@]}"; do
  desired="$(
    kubectl get deployment "gaming-${service}-depl" -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath='{.spec.template.spec.containers[0].image}'
  )"
  [[ "$desired" == *"@${expected_digests[$service]}" ]] ||
    oci_die "deployment does not request the approved digest: $service"
  image_ids="$(
    kubectl get pods -n "$OCI_K8S_NAMESPACE" -l "app=gaming-${service}" \
      -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.imageID}{"\n"}{end}{end}'
  )"
  [[ -n "$image_ids" ]] || oci_die "no serving pod image ID found for $service"
  while IFS= read -r image_id; do
    [[ "$image_id" == *"@${expected_platform_digests[$service]}" ]] ||
      oci_die "serving pod platform digest differs from provenance: $service"
  done <<<"$image_ids"
done

load_balancer_count="$(
  kubectl get services -A -o json |
    jq '[.items[] | select(.spec.type == "LoadBalancer")] | length'
)"
if [[ "$runtime_mode" == "oke" ]]; then
  [[ "$load_balancer_count" == "1" ]] ||
    oci_die "OKE cluster must expose exactly one LoadBalancer service"
else
  [[ "$load_balancer_count" == "0" ]] ||
    oci_die "k3s must not expose a Kubernetes LoadBalancer service"
fi
public_data_services="$(
  kubectl get services -n "$OCI_K8S_NAMESPACE" -o json |
    jq '[.items[] | select(
      (.metadata.name | test("mongo|rabbitmq")) and .spec.type != "ClusterIP"
    )] | length'
)"
[[ "$public_data_services" == "0" ]] || oci_die "Mongo or RabbitMQ became public"

{
  printf 'source_sha=%s\n' "$SOURCE_SHA"
  printf 'runtime_mode=%s\n' "$runtime_mode"
  printf 'runtime_fingerprint=%s\n' "$runtime_fingerprint"
  printf 'image_provenance_sha256=%s\n' "$(oci_sha256 < "$IMAGE_PROVENANCE_FILE")"
  printf 'rendered_manifest_sha256=%s\n' "$(oci_sha256 < "$RENDERED_FILE")"
  printf 'rabbitmq_baseline_sha256=%s\n' "$(oci_sha256 < "$OUTPUT_DIR/rabbitmq-baseline.txt")"
  printf 'public_host=%s\n' "$public_host"
  printf 'canonical_host=%s\n' "$canonical_host"
  printf 'redirect_host=%s\n' "$redirect_host"
  printf 'diagnostic_host=%s\n' "$diagnostic_host"
  printf 'deployment_run_id=%s\n' "${GITHUB_RUN_ID:-local}"
  printf 'deployment_run_attempt=%s\n' "${GITHUB_RUN_ATTEMPT:-1}"
} > "$OUTPUT_DIR/provenance.txt"
rm -f "$RENDERED_FILE"

OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
MONGO_TARGET_IMAGE="$mongo_target_image" \
MONGO_UPGRADE_STATE_FILE="$mongo_upgrade_state_file" \
  "$SCRIPT_DIR/upgrade-mongo.sh" resume

oci_log "oci_deploy=PASS source_sha=$SOURCE_SHA workloads_sequential=1"
