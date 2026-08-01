#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

IMAGE_PROVENANCE_FILE="${IMAGE_PROVENANCE_FILE:-${1:-}}"
INFRA_PROVENANCE_FILE="${INFRA_PROVENANCE_FILE:-${2:-}}"
OUTPUT_FILE="${OUTPUT_FILE:-${3:-$OCI_ROOT_DIR/artifacts/oci-rendered.yaml}}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_PUBLIC_HOST="${OCI_PUBLIC_HOST:-}"
OCI_CERT_EMAIL="${OCI_CERT_EMAIL:-}"
WORK_DIR="${WORK_DIR:-$(dirname "$OUTPUT_FILE")/.oci-render-work}"

[[ -f "$IMAGE_PROVENANCE_FILE" ]] || oci_die "image provenance TSV is required"
[[ -f "$INFRA_PROVENANCE_FILE" ]] || oci_die "infrastructure provenance file is required"
[[ "$OCI_K8S_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  oci_die "OCI_K8S_NAMESPACE is not a valid Kubernetes namespace"
[[ "$OCI_PUBLIC_HOST" =~ ^[a-z0-9.-]+$ && "$OCI_PUBLIC_HOST" == *.nip.io ]] ||
  oci_die "OCI_PUBLIC_HOST must be an IP-derived nip.io hostname"
[[ "$OCI_CERT_EMAIL" == *@*.* ]] || oci_die "OCI_CERT_EMAIL is required for ACME"
oci_require_command kubectl
oci_require_command ruby

unset OCI_MONGO_VOLUME_OCID source_sha cluster_ocid compartment_ocid ingress_ipv4
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
oci_require_vars OCI_MONGO_VOLUME_OCID
oci_require_ocid OCI_MONGO_VOLUME_OCID

rm -rf "$WORK_DIR"
oci_prepare_private_dir "$WORK_DIR"
cleanup_render_work() {
  rm -rf "$WORK_DIR"
}
trap cleanup_render_work EXIT
raw_manifest="$WORK_DIR/kustomize.yaml"
kubectl kustomize --load-restrictor=LoadRestrictionsNone "$OCI_DIR/k8s" > "$raw_manifest"
mkdir -p "$(dirname "$OUTPUT_FILE")"

ruby -ryaml - "$raw_manifest" "$IMAGE_PROVENANCE_FILE" "$OUTPUT_FILE" \
  "$OCI_K8S_NAMESPACE" "$OCI_PUBLIC_HOST" "$OCI_CERT_EMAIL" "$OCI_MONGO_VOLUME_OCID" <<'RUBY'
raw_file, images_file, output_file, namespace, public_host, cert_email, volume_ocid = ARGV
images = {}
File.readlines(images_file, chomp: true).reject(&:empty?).each do |line|
  service, _repository, image_ref, digest, platform_digest = line.split("\t", 5)
  abort "invalid image provenance row" unless service && image_ref && digest && platform_digest
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
  %w[Namespace PersistentVolume ClusterIssuer]

replace = lambda do |value|
  case value
  when Hash
    value.transform_values { |child| replace.call(child) }
  when Array
    value.map { |child| replace.call(child) }
  when String
    value
      .gsub("__OCI_PUBLIC_HOST__", public_host)
      .gsub("__OCI_CERT_EMAIL__", cert_email)
      .gsub("__OCI_MONGO_VOLUME_OCID__", volume_ocid)
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

ruby -ryaml - "$OUTPUT_FILE" <<'RUBY'
documents = YAML.load_stream(File.read(ARGV.fetch(0))).compact
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
abort "expected ten deployments" unless count.call("Deployment") == 10
abort "expected one ingress" unless count.call("Ingress") == 1
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
