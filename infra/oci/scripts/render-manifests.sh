#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=application-registry.sh
source "$SCRIPT_DIR/application-registry.sh"

IMAGE_PROVENANCE_FILE="${IMAGE_PROVENANCE_FILE:-${1:-}}"
INFRA_PROVENANCE_FILE="${INFRA_PROVENANCE_FILE:-${2:-}}"
OUTPUT_FILE="${OUTPUT_FILE:-${3:-$OCI_ROOT_DIR/artifacts/oci-rendered.yaml}}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_CANONICAL_HOST="${OCI_CANONICAL_HOST:-betstan.xyz}"
OCI_REDIRECT_HOST="${OCI_REDIRECT_HOST:-www.betstan.xyz}"
OCI_CERT_EMAIL="${OCI_CERT_EMAIL:-}"
OCI_K3S_NODE_NAME="${OCI_K3S_NODE_NAME:-betstan-k3s}"
OCI_PRODUCTION_MONITOR_SELF_HEAL_ENABLED="${OCI_PRODUCTION_MONITOR_SELF_HEAL_ENABLED:-false}"
WORK_DIR="${WORK_DIR:-$(dirname "$OUTPUT_FILE")/.oci-render-work}"

[[ -f "$IMAGE_PROVENANCE_FILE" ]] || oci_die "image provenance TSV is required"
[[ -f "$INFRA_PROVENANCE_FILE" ]] || oci_die "infrastructure provenance file is required"
[[ "$OCI_K8S_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  oci_die "OCI_K8S_NAMESPACE is not a valid Kubernetes namespace"
[[ "$OCI_CANONICAL_HOST" == "betstan.xyz" ]] ||
  oci_die "OCI_CANONICAL_HOST must be betstan.xyz"
[[ "$OCI_REDIRECT_HOST" == "www.${OCI_CANONICAL_HOST}" ]] ||
  oci_die "OCI_REDIRECT_HOST must be the canonical www host"
[[ "$OCI_CERT_EMAIL" == *@*.* ]] || oci_die "OCI_CERT_EMAIL is required for ACME"
[[ "$OCI_PRODUCTION_MONITOR_SELF_HEAL_ENABLED" =~ ^(true|false)$ ]] ||
  oci_die "OCI_PRODUCTION_MONITOR_SELF_HEAL_ENABLED must be true or false"
oci_require_command kubectl
oci_require_command ruby
application_registry_require_ghcr

unset OCI_MONGO_VOLUME_OCID source_sha cluster_ocid compartment_ocid ingress_ipv4
unset public_host canonical_host redirect_host diagnostic_host
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
oci_require_vars \
  OCI_MONGO_VOLUME_OCID ingress_ipv4 public_host canonical_host redirect_host \
  diagnostic_host
oci_require_ocid OCI_MONGO_VOLUME_OCID
[[ "$canonical_host" == "$OCI_CANONICAL_HOST" &&
   "$redirect_host" == "$OCI_REDIRECT_HOST" &&
   "$public_host" == "$canonical_host" ]] ||
  oci_die "canonical host inputs differ from infrastructure provenance"
[[ "$diagnostic_host" == "${ingress_ipv4}.nip.io" ]] ||
  oci_die "diagnostic host is not derived from the infrastructure IPv4"

rm -rf "$WORK_DIR"
oci_prepare_private_dir "$WORK_DIR"
cleanup_render_work() {
  rm -rf "$WORK_DIR"
}
trap cleanup_render_work EXIT
raw_manifest="$WORK_DIR/kustomize.yaml"
if [[ "$(oci_runtime_mode)" == "k3s" ]]; then
  [[ "$OCI_K3S_NODE_NAME" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
    oci_die "OCI_K3S_NODE_NAME is not a valid Kubernetes node name"
  kustomize_root="$OCI_DIR/k8s/overlays/k3s"
else
  kustomize_root="$OCI_DIR/k8s"
fi
kubectl kustomize --load-restrictor=LoadRestrictionsNone "$kustomize_root" > "$raw_manifest"
mkdir -p "$(dirname "$OUTPUT_FILE")"

ruby -ryaml - "$raw_manifest" "$IMAGE_PROVENANCE_FILE" "$OUTPUT_FILE" \
  "$OCI_K8S_NAMESPACE" "$canonical_host" "$redirect_host" "$diagnostic_host" \
  "$OCI_CERT_EMAIL" "$(application_registry_repository)" \
  "$OCI_MONGO_VOLUME_OCID" "$OCI_K3S_NODE_NAME" \
  "$OCI_PRODUCTION_MONITOR_SELF_HEAL_ENABLED" <<'RUBY'
raw_file, images_file, output_file, namespace, canonical_host, redirect_host,
  diagnostic_host, cert_email, application_repository, volume_ocid, node_name,
  self_heal_enabled = ARGV
images = {}
File.readlines(images_file, chomp: true).reject(&:empty?).each do |line|
  service, repository, image_ref, digest, platform_digest = line.split("\t", 5)
  abort "invalid image provenance row" unless service && image_ref && digest && platform_digest
  abort "image provenance repository is not public GHCR" unless repository == application_repository
  abort "invalid immutable image reference for #{service}" unless image_ref.end_with?("@#{digest}") &&
    digest.match?(/\Asha256:[0-9a-f]{64}\z/) &&
    platform_digest.match?(/\Asha256:[0-9a-f]{64}\z/)
  abort "duplicate image provenance for #{service}" if images.key?(service)
  images[service] = image_ref
end
expected = %w[auth bet backoffice client event gamemaster moderation resulting slip]
abort "image provenance must contain exactly nine services" unless images.keys.sort == expected.sort

documents = YAML.load_stream(File.read(raw_file)).compact
namespaced_kinds = documents.map { |document| document["kind"] }.uniq -
  %w[Namespace PersistentVolume ClusterIssuer ClusterRole ClusterRoleBinding]

replace = lambda do |value|
  case value
  when Hash
    value.transform_values { |child| replace.call(child) }
  when Array
    value.map { |child| replace.call(child) }
  when String
    value
      .gsub("__OCI_CANONICAL_HOST__", canonical_host)
      .gsub("__OCI_REDIRECT_HOST__", redirect_host)
      .gsub("__OCI_DIAGNOSTIC_HOST__", diagnostic_host)
      .gsub("__OCI_CERT_EMAIL__", cert_email)
      .gsub("__OCI_K8S_NAMESPACE__", namespace)
      .gsub("__OCI_MONGO_VOLUME_OCID__", volume_ocid)
      .gsub("__OCI_K3S_NODE_NAME__", node_name)
      .gsub("__OCI_PRODUCTION_MONITOR_SELF_HEAL_ENABLED__", self_heal_enabled)
  else
    value
  end
end
documents.map! { |document| replace.call(document) }

documents.each do |document|
  metadata = document["metadata"] ||= {}
  metadata["namespace"] = namespace if namespaced_kinds.include?(document["kind"])
  next unless document["kind"] == "Deployment"

  containers = document.dig("spec", "template", "spec", "containers") || []
  containers.each do |container|
    next unless container["name"]&.start_with?("gaming-")
    service = container["name"].delete_prefix("gaming-")
    container["image"] = images.fetch(service) if images.key?(service)
  end
end

namespace_document = {
  "apiVersion" => "v1",
  "kind" => "Namespace",
  "metadata" => {
    "name" => namespace,
    "labels" => {
      "app.kubernetes.io/part-of" => "betstan",
      "betstan.io/provider" => "oci"
    }
  }
}
documents.unshift(namespace_document)

serialized = documents.map { |document| YAML.dump(document) }.join
abort "render contains unresolved placeholder" if serialized.include?("__OCI_")
abort "render contains legacy Mongo" if serialized.include?("legacy-mongo")
File.write(output_file, serialized)
RUBY

ruby -ryaml - "$OUTPUT_FILE" "$canonical_host" "$redirect_host" "$diagnostic_host" <<'RUBY'
documents = YAML.load_stream(File.read(ARGV.fetch(0))).compact
canonical_host, redirect_host, diagnostic_host = ARGV[1, 3]
count = ->(kind) { documents.count { |document| document["kind"] == kind } }
abort "expected exactly one Mongo StatefulSet" unless documents.count { |document|
  document["kind"] == "StatefulSet" && document.dig("metadata", "name") == "gaming-auth-mongo-depl"
} == 1
abort "expected exactly one Mongo PVC" unless documents.count { |document|
  document["kind"] == "PersistentVolumeClaim" &&
    document.dig("metadata", "name") == "gaming-auth-mongo-data" &&
    document.dig("spec", "resources", "requests", "storage") == "50Gi"
} == 1
abort "expected exactly one Mongo PV" unless documents.count { |document|
  document["kind"] == "PersistentVolume" &&
    document.dig("spec", "capacity", "storage") == "50Gi"
} == 1
abort "expected twelve deployments" unless count.call("Deployment") == 12
abort "expected canonical, redirect, and monitor ingresses" unless count.call("Ingress") == 3
abort "expected canonical and diagnostic certificates" unless count.call("Certificate") == 2
ingress_hosts = documents.select { |document| document["kind"] == "Ingress" }.flat_map {
  |document| document.fetch("spec").fetch("rules").map { |rule| rule.fetch("host") }
}
abort "rendered ingress hosts differ from the approved set" unless ingress_hosts.sort.uniq ==
  [canonical_host, diagnostic_host, redirect_host].sort
certificates = documents.select { |document| document["kind"] == "Certificate" }
certificate_hosts = certificates.flat_map { |certificate| certificate.dig("spec", "dnsNames") }.sort
abort "rendered certificate SANs differ from the approved set" unless certificate_hosts ==
  [canonical_host, diagnostic_host, redirect_host].sort
documents.select { |document| document["kind"] == "Service" }.each do |service|
  abort "application service is public" unless service.dig("spec", "type") == "ClusterIP"
end
documents.select { |document| %w[Deployment StatefulSet].include?(document["kind"]) }.each do |workload|
  containers = workload.dig("spec", "template", "spec", "containers") || []
  containers.each do |container|
    abort "mutable image in rendered workload" unless container.fetch("image").match?(/@sha256:[0-9a-f]{64}\z/)
  end
end
puts "oci_render_contract=PASS documents=#{documents.length}"
RUBY

rm -rf "$WORK_DIR"
trap - EXIT
