#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
WORK_DIR="$OCI_DIR/tests/.contract-work"

fail() {
  echo "OCI contract failure: $*" >&2
  exit 1
}

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/provenance"
trap 'rm -rf "$WORK_DIR"' EXIT

command -v ruby >/dev/null 2>&1 || fail "ruby is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"

while IFS= read -r script; do
  bash -n "$script"
done < <(find "$OCI_DIR" -type f -name '*.sh' | sort)
PYTHONPYCACHEPREFIX="$WORK_DIR/pycache" \
  python3 -m py_compile "$OCI_DIR/agents/health-contract.py"
node --check "$OCI_DIR/agents/playwright.config.js"
node --check "$OCI_DIR/agents/oci-live-smoke.spec.js"

# shellcheck source=../scripts/lib.sh
source "$OCI_DIR/scripts/lib.sh"
[[ "$(oci_normalize_list_json "")" == '{"data":[]}' ]] ||
  fail "empty OCI array response was not normalized"
[[ "$(oci_normalize_list_json "" items)" == '{"data":{"items":[]}}' ]] ||
  fail "empty OCI items response was not normalized"
redacted="$(
  printf '%s\n' \
    'Authorization: Bearer header-secret' \
    'token=query-secret' \
    'cookie: session=cookie-secret' \
    '-----BEGIN RSA PRIVATE KEY-----' \
    'private-key-body-secret' \
    '-----END RSA PRIVATE KEY-----' \
    'safe-tail' |
    oci_redact
)"
for secret in header-secret query-secret cookie-secret private-key-body-secret; do
  [[ "$redacted" != *"$secret"* ]] ||
    fail "OCI redaction leaked fixture secret: $secret"
done
[[ "$redacted" == *"[REDACTED_PRIVATE_KEY]"* ]] ||
  fail "OCI redaction omitted the private-key marker"
[[ "$redacted" == *"safe-tail"* ]] ||
  fail "OCI redaction removed content after the private-key block"
header_key="Author""ization"
header_value="header-fixture-value"
header_redacted="$(printf '%s: %s\n' "$header_key" "$header_value" | oci_redact)"
[[ "$header_redacted" != *"$header_value"* ]] ||
  fail "OCI redaction leaked a constructed header value"

ruby -ryaml - "$ROOT_DIR" <<'RUBY'
root = ARGV.fetch(0)
files = Dir.glob(File.join(root, "infra/oci/**/*.{yaml,yml}")) +
  Dir.glob(File.join(root, ".github/workflows/oci-*.yml"))
files.sort.each do |file|
  begin
    YAML.load_stream(File.read(file))
  rescue Psych::SyntaxError => error
    abort "#{file}: #{error.message}"
  end
end
puts "oci_yaml_parse=PASS files=#{files.length}"
RUBY

OFFLINE=1 \
OCI_RUNTIME_MODE=oke \
OCI_A1_OCPUS=2 \
OCI_A1_MEMORY_GB=12 \
OCI_NODE_SHAPE=VM.Standard.A1.Flex \
OCI_BOOT_VOLUME_GB=50 \
OCI_MONGO_VOLUME_GB=50 \
OCI_LB_MIN_MBPS=10 \
OCI_LB_MAX_MBPS=10 \
OCI_EXPECTED_MONTHLY_COST=0 \
OCI_REGISTRY_MAX_BYTES=500000000 \
OCI_MEMORY_MAX_PERCENT=70 \
OCI_DISK_MAX_PERCENT=70 \
  "$OCI_DIR/scripts/preflight.sh" --offline >/dev/null

services=(auth bet backoffice client event gamemaster moderation resulting slip)
index=1
for service in "${services[@]}"; do
  digit="$index"
  digest="$(printf '%064d' "$digit")"
  repository="fixture.invalid/namespace/betstan_images"
  cat > "$WORK_DIR/provenance/${service}.env" <<ENV
service=${service}
repository=${repository}
source_sha=1111111111111111111111111111111111111111
tag=${repository}:oci-${service}-1111111111111111111111111111111111111111
digest=sha256:${digest}
platform_digest=sha256:${digest}
image_ref=${repository}@sha256:${digest}
platform=linux/arm64
build_run_id=fixture
build_run_attempt=1
ENV
  index=$((index + 1))
done
PROVENANCE_DIR="$WORK_DIR/provenance" \
SOURCE_SHA=1111111111111111111111111111111111111111 \
OUTPUT_FILE="$WORK_DIR/images.tsv" \
VERIFY_REMOTE=0 BOOT_IMAGES=0 \
  "$OCI_DIR/scripts/verify-images.sh" >/dev/null
cat > "$WORK_DIR/infrastructure.env" <<'ENV'
source_sha=1111111111111111111111111111111111111111
OCI_MONGO_VOLUME_OCID=ocid1.volume.oc1.fixture.fixturevalue
ENV

IMAGE_PROVENANCE_FILE="$WORK_DIR/images.tsv" \
OCI_RUNTIME_MODE=oke \
INFRA_PROVENANCE_FILE="$WORK_DIR/infrastructure.env" \
OUTPUT_FILE="$WORK_DIR/rendered.yaml" \
WORK_DIR="$WORK_DIR/render-work" \
OCI_K8S_NAMESPACE=betstan-oci \
OCI_PUBLIC_HOST=203.0.113.10.nip.io \
OCI_CERT_EMAIL=fixture@example.invalid \
  "$OCI_DIR/scripts/render-manifests.sh" >/dev/null

ruby -ryaml - "$WORK_DIR/rendered.yaml" <<'RUBY'
documents = YAML.load_stream(File.read(ARGV.fetch(0))).compact
by_kind = documents.group_by { |document| document["kind"] }
abort "nine application deployments plus RabbitMQ required" unless by_kind.fetch("Deployment").length == 10
abort "single Mongo StatefulSet required" unless by_kind.fetch("StatefulSet").map {
  |item| item.dig("metadata", "name")
} == ["gaming-auth-mongo-depl"]
abort "single Mongo PVC required" unless by_kind.fetch("PersistentVolumeClaim").length == 1
abort "Mongo PVC must start at 50Gi" unless by_kind["PersistentVolumeClaim"][0].dig(
  "spec", "resources", "requests", "storage"
) == "50Gi"
abort "single Mongo PV required" unless by_kind.fetch("PersistentVolume").length == 1
services = by_kind.fetch("Service")
abort "Mongo or RabbitMQ service became public" unless services.all? {
  |service| service.dig("spec", "type") == "ClusterIP"
}
images = (by_kind.fetch("Deployment") + by_kind.fetch("StatefulSet")).flat_map {
  |workload| workload.dig("spec", "template", "spec", "containers").map { |container| container["image"] }
}
abort "mutable image rendered" unless images.all? { |image| image.match?(/@sha256:[0-9a-f]{64}\z/) }
workloads = by_kind.fetch("Deployment") + by_kind.fetch("StatefulSet")
abort "ARM64 node selector missing" unless workloads.all? {
  |workload| workload.dig("spec", "template", "spec", "nodeSelector", "kubernetes.io/arch") == "arm64"
}
abort "resource requests/limits missing" unless workloads.all? {
  |workload| workload.dig("spec", "template", "spec", "containers").all? {
    |container| container.dig("resources", "requests") && container.dig("resources", "limits")
  }
}
mongo = by_kind.fetch("StatefulSet").first
abort "base StatefulSet claim template survived OCI patch" if mongo.dig("spec", "volumeClaimTemplates")
abort "Mongo does not use the explicit 50Gi claim" unless mongo.dig(
  "spec", "template", "spec", "volumes", 0, "persistentVolumeClaim", "claimName"
) == "gaming-auth-mongo-data"
abort "legacy Mongo rendered" if File.read(ARGV.fetch(0)).include?("legacy-mongo")
abort "expected one OCI ingress" unless by_kind.fetch("Ingress").length == 1
puts "oci_rendered_topology=PASS"
RUBY

OCI_RUNTIME_MODE=k3s \
OCI_K3S_NODE_NAME=betstan-k3s \
IMAGE_PROVENANCE_FILE="$WORK_DIR/images.tsv" \
INFRA_PROVENANCE_FILE="$WORK_DIR/infrastructure.env" \
OUTPUT_FILE="$WORK_DIR/rendered-k3s.yaml" \
WORK_DIR="$WORK_DIR/render-k3s-work" \
OCI_K8S_NAMESPACE=betstan-oci \
OCI_PUBLIC_HOST=203.0.113.10.nip.io \
OCI_CERT_EMAIL=fixture@example.invalid \
  "$OCI_DIR/scripts/render-manifests.sh" >/dev/null
ruby -ryaml - "$WORK_DIR/rendered-k3s.yaml" <<'RUBY'
documents = YAML.load_stream(File.read(ARGV.fetch(0))).compact
volume = documents.find {
  |document| document["kind"] == "PersistentVolume" &&
    document.dig("metadata", "name") == "gaming-auth-mongo-data"
}
abort "k3s Mongo PV contains an OCI CSI source" if volume.dig("spec", "csi")
abort "k3s Mongo PV lacks the stable local path" unless volume.dig(
  "spec", "local", "path"
) == "/var/lib/betstan/mongo"
node_values = volume.dig(
  "spec", "nodeAffinity", "required", "nodeSelectorTerms", 0,
  "matchExpressions", 0, "values"
)
abort "k3s Mongo PV lacks exact node affinity" unless node_values == ["betstan-k3s"]
mongo = documents.find {
  |document| document["kind"] == "StatefulSet" &&
    document.dig("metadata", "name") == "gaming-auth-mongo-depl"
}
abort "k3s Mongo fsGroup differs" unless mongo.dig(
  "spec", "template", "spec", "securityContext", "fsGroup"
) == 999
puts "oci_k3s_rendered_topology=PASS"
RUBY

kustomization="$OCI_DIR/k8s/base/kustomization.yaml"
for manifest in \
  auth-depl.yaml bet-depl.yaml backoffice-depl.yaml client-depl.yaml \
  event-depl.yaml gamemaster-depl.yaml moderation-depl.yaml \
  resulting-depl.yaml slip-depl.yaml rabbitmq-depl.yaml auth-mongo-depl.yaml; do
  grep -Fq "infra/k8s/$manifest" "$kustomization" ||
    fail "explicit manifest missing from Kustomize allowlist: $manifest"
done
if grep -Eq 'legacy-mongo|resources:[[:space:]]*$' "$kustomization" &&
  grep -Fq 'legacy-mongo' "$kustomization"; then
  fail "legacy Mongo appears in Kustomize allowlist"
fi
grep -R -n -E 'find[[:space:]]+.*infra/k8s|kubectl apply -[fR][[:space:]]+infra/k8s([[:space:]]|$)' \
  "$OCI_DIR" "$ROOT_DIR/.github/workflows/oci-"*.yml >/dev/null 2>&1 &&
  fail "OCI path recursively applies infra/k8s"

load_balancer_declarations="$(
  grep -R -h -E '^[[:space:]]*type:[[:space:]]*LoadBalancer[[:space:]]*$' \
    "$OCI_DIR" | wc -l | tr -d ' '
)"
[[ "$load_balancer_declarations" == "1" ]] ||
  fail "OCI assets must declare exactly one LoadBalancer service"
grep -Fq 'oci.oraclecloud.com/load-balancer-type: "lb"' "$OCI_DIR/helm/ingress-nginx-values.yaml"
grep -Fq 'oci-load-balancer-security-list-management-mode: "None"' "$OCI_DIR/helm/ingress-nginx-values.yaml"
grep -Fq 'digest: sha256:d2fbc4ec70d8aa2050dd91a91506e998765e86c96f32cffb56c503c9c34eed5b' \
  "$OCI_DIR/helm/ingress-nginx-values.yaml"
grep -Fq 'shape-flex-min: "10"' "$OCI_DIR/helm/ingress-nginx-values.yaml"
grep -Fq 'shape-flex-max: "10"' "$OCI_DIR/helm/ingress-nginx-values.yaml"

for dockerfile in "$OCI_DIR/build/Dockerfile.backend" "$OCI_DIR/build/Dockerfile.client"; do
  while IFS= read -r base_image; do
    [[ "$base_image" == \$* || "$base_image" =~ @sha256:[0-9a-f]{64}$ ]] ||
      fail "OCI Dockerfile contains an unpinned base image: $dockerfile"
  done < <(
    awk '
      toupper($1) == "FROM" {
        image = 2
        if ($image ~ /^--platform=/) {
          image += 1
        }
        print $image
      }
    ' "$dockerfile"
  )
  grep -Eq '^ARG [A-Z_]+_IMAGE=[^[:space:]]+@sha256:[0-9a-f]{64}$' "$dockerfile" ||
    fail "OCI Dockerfile image ARG is not digest-pinned: $dockerfile"
  grep -Fq 'FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build' "$dockerfile" ||
    fail "OCI Dockerfile must compile architecture-independent assets on BUILDPLATFORM: $dockerfile"
done
verify_images="$OCI_DIR/scripts/verify-images.sh"
build_images="$OCI_DIR/scripts/build-images.sh"
grep -Fq 'repository="${OCI_REGISTRY_HOST}/${OCI_REGISTRY_NAMESPACE}/${OCI_IMAGE_PREFIX}_images"' \
  "$build_images" ||
  fail "OCI builds must share one repository so common layers stay inside the Free Tier allowance"
grep -Fq 'tag="${repository}:oci-${service}-${SOURCE_SHA}"' "$build_images" ||
  fail "shared OCI repository tags must bind the service and exact source SHA"
inventory="$OCI_DIR/scripts/inventory.sh"
grep -Fq '[$prefix + "_images"]' "$inventory" ||
  fail "OCI inventory must allow only the shared image repository"
grep -Fq 'select(.image_count != 9)' "$inventory" ||
  fail "OCI inventory must require all nine exact application images"
grep -Fq 'docker run -d --platform linux/arm64 --name "$container"' "$verify_images" ||
  fail "OCI application boot verification must run the ARM64 images"
if grep -Eq -- '--platform linux/arm64 --name "\$(mongo|rabbit)"' "$verify_images"; then
  fail "OCI build verification dependencies must use the runner native platform"
fi
grep -Fq 'docker exec --user rabbitmq "$rabbit" rabbitmq-diagnostics -q ping' "$verify_images" ||
  fail "RabbitMQ readiness verification must run as the image user"
grep -R -n -E 'image:[[:space:]]+[^[:space:]#]+:(latest|main|master|dev)([[:space:]#]|$)' \
  "$OCI_DIR" "$ROOT_DIR/.github/workflows/oci-"*.yml >/dev/null 2>&1 &&
  fail "OCI path contains a mutable image tag"

grep -R -n -E '\baz\b|AKS|azure\.com|betstan\.xyz|www\.betstan\.xyz' \
  "$OCI_DIR/agents" \
  --exclude='test-health-contract-stan.sh' \
  --exclude='oci-live-smoke.spec.js' >/dev/null 2>&1 &&
  fail "OCI health agents contain an Azure or canonical-DNS dependency"
for script in "$OCI_DIR/scripts"/*.sh; do
  [[ "$(basename "$script")" == "migrate-from-azure.sh" ]] && continue
  grep -Eiq '\baz\b|AKS|AZURE_|azure\.com|betstan\.xyz|www\.betstan\.xyz' "$script" &&
    fail "non-migration OCI script contains an Azure dependency: $script"
done
for workflow in "$ROOT_DIR/.github/workflows"/oci-*.yml; do
  [[ "$(basename "$workflow")" == "oci-migrate.yml" ]] && continue
  grep -Eq 'AZURE_|azure/login|azure/aks-set-context' "$workflow" &&
    fail "Azure credential/reference exists outside OCI migration: $workflow"
done

build_workflow="$ROOT_DIR/.github/workflows/oci-production-build.yml"
capacity_workflow="$ROOT_DIR/.github/workflows/oci-capacity-acquire.yml"
infra_workflow="$ROOT_DIR/.github/workflows/oci-infrastructure.yml"
deploy_workflow="$ROOT_DIR/.github/workflows/oci-production-deploy.yml"
migrate_workflow="$ROOT_DIR/.github/workflows/oci-migrate.yml"
validate_workflow="$ROOT_DIR/.github/workflows/oci-validate.yml"

grep -Fq 'workflow_run:' "$build_workflow"
grep -Fq 'workflows: ["production-build"]' "$build_workflow"
grep -Fq 'github.event.workflow_run.head_sha' "$build_workflow"
grep -Fq 'environment:' "$build_workflow"
grep -Fq 'name: oci-build' "$build_workflow"
grep -Fq 'docker login "$OCI_REGISTRY_HOST"' "$build_workflow"
grep -Fq 'exact OCI tag already exists; refusing overwrite' "$OCI_DIR/scripts/build-images.sh"
grep -Fq 'group: oci-build-${{ github.event.workflow_run.head_sha }}' "$build_workflow"
! grep -Eq 'OCI_CLI_|OCI_CI_PRIVATE_KEY_PEM' "$build_workflow" ||
  fail "OCI build workflow receives an API signing key"

grep -Fq 'schedule:' "$capacity_workflow"
grep -Fq 'cron: "*/5 * * * *"' "$capacity_workflow"
grep -Fq 'workflow_dispatch:' "$capacity_workflow"
grep -Fq 'github.run_attempt == 1' "$capacity_workflow"
grep -Fq "vars.OCI_CAPACITY_CATCHER_ENABLED == 'true'" "$capacity_workflow"
grep -Fq 'group: oci-control-plane' "$capacity_workflow"
grep -Fq 'name: oci-capacity-acquire' "$capacity_workflow"
grep -Fq 'OCI_CAPACITY_PRIVATE_KEY_PEM' "$capacity_workflow"
! grep -Eq 'OCI_CI_PRIVATE_KEY_PEM|OCI_REGISTRY_|OCI_JWT_|AZURE_|azure/' \
  "$capacity_workflow" ||
  fail "capacity workflow receives credentials outside its dedicated identity"

for workflow in "$infra_workflow" "$deploy_workflow" "$migrate_workflow"; do
  grep -Fq 'workflow_dispatch:' "$workflow"
  grep -Fq 'github.run_attempt == 1' "$workflow"
  grep -Fq 'group: oci-control-plane' "$workflow"
done
grep -Fq 'name: oci-infrastructure' "$infra_workflow"
grep -Fq 'PROVISION OCI ZERO COST' "$infra_workflow"
grep -Fq 'name: oci-production' "$deploy_workflow"
grep -Fq 'DEPLOY OCI EXACT SHA' "$deploy_workflow"
grep -Fq 'name: oci-migration' "$migrate_workflow"
grep -Fq 'MIGRATE AZURE DATA TO OCI' "$migrate_workflow"
grep -Fq 'OCI_MIGRATION_AZURE_CREDENTIALS' "$migrate_workflow"
grep -Fq 'OCI_MIGRATION_AGE_IDENTITY' "$migrate_workflow"
grep -Fq 'if: always()' "$infra_workflow"
grep -Fq 'if: always()' "$deploy_workflow"
grep -Fq 'if: always()' "$migrate_workflow"

grep -Fq 'pull_request:' "$validate_workflow"
! grep -Eq 'workflow_dispatch:|workflow_run:|^[[:space:]]+push:' "$validate_workflow" ||
  fail "oci-validate must remain PR-only"
! grep -Eq 'secrets\.|OCI_CLI_' "$validate_workflow" ||
  fail "oci-validate must not access credentials"

for workflow in "$infra_workflow" "$deploy_workflow" "$migrate_workflow"; do
  for variable in OCI_CLI_USER OCI_CLI_TENANCY OCI_CLI_FINGERPRINT OCI_CLI_KEY_CONTENT OCI_CLI_REGION; do
    grep -Fq "$variable:" "$workflow" ||
      fail "official OCI CLI mapping missing from $(basename "$workflow"): $variable"
  done
done
for variable in OCI_CLI_USER OCI_CLI_TENANCY OCI_CLI_FINGERPRINT OCI_CLI_KEY_CONTENT OCI_CLI_REGION; do
  grep -Fq "$variable:" "$capacity_workflow" ||
    fail "official OCI CLI mapping missing from oci-capacity-acquire.yml: $variable"
done
grep -Fq 'echo "$RUNNER_TEMP/oci-capacity-home/.local/bin" >> "$GITHUB_PATH"' \
  "$capacity_workflow" ||
  fail "capacity workflow does not expose the isolated OCI CLI installation on PATH"
for workflow in "$infra_workflow" "$deploy_workflow" "$migrate_workflow"; do
  grep -Fq 'echo "$RUNNER_TEMP/oci-home/.local/bin" >> "$GITHUB_PATH"' "$workflow" ||
    fail "isolated OCI CLI installation is not on PATH in $(basename "$workflow")"
done
! grep -Eq 'AZURE_|azure/' "$infra_workflow" "$deploy_workflow" ||
  fail "Azure credentials leaked into OCI infrastructure/deployment"

while IFS= read -r use; do
  [[ "$use" =~ @[0-9a-f]{40}$ ]] ||
    fail "third-party action is not pinned to a full commit SHA: $use"
done < <(
  sed -n -E 's/^[[:space:]]*uses:[[:space:]]*([^[:space:]#]+).*/\1/p' \
    "$ROOT_DIR/.github/workflows"/oci-*.yml
)

grep -Fq 'OCI_A1_OCPUS=2' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_CLI_VERSION=3.90.0' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_A1_MEMORY_GB=12' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_A1_MEMORY_PROFILES=12' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_RUNTIME_MODE=oke' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_K3S_VERSION=v1.34.9+k3s1' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_K3S_BINARY_SHA256=c782d6bb71eb2eb30f034aaddabb480294f9fdae5a7bca49ac5e3e0f66b96ea5' \
  "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_MONGO_VOLUME_GB=50' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_EXPECTED_MONTHLY_COST=0' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_REGISTRY_MAX_BYTES=500000000' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_INGRESS_NGINX_CHART_SHA256=3eff0bd18151d6e6b1c441463410571443dda1ac78292cb189346628de784f0c' \
  "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_CERT_MANAGER_CHART_SHA256=c27101f3f3e2349fb4a9e704316105bf7b52ad73b8c8257d3498ef7f2f6a4adc' \
  "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'VM.Standard.A1.Flex' "$OCI_DIR/scripts/provision.sh"
grep -Fq -- '--type BASIC_CLUSTER' "$OCI_DIR/scripts/provision.sh"
grep -Fq 'compute-capacity-report create' "$OCI_DIR/scripts/preflight.sh"
grep -Fq 'compute compute-capacity-report create' "$OCI_DIR/scripts/capacity-report.sh"
grep -Fq 'oci compute instance launch' "$OCI_DIR/scripts/acquire-a1.sh"
! grep -Fq -- '--fault-domain' "$OCI_DIR/scripts/acquire-a1.sh" ||
  fail "capacity acquisition must let OCI choose the fault domain"
if grep -R -n -E 'nat-gateway create|--type ENHANCED_CLUSTER|VM\.Standard\.(E|D|B|X|GPU)' \
  "$OCI_DIR/scripts" >/dev/null 2>&1; then
  fail "OCI scripts contain a paid infrastructure fallback"
fi

"$OCI_DIR/agents/test-health-contract-stan.sh"
"$OCI_DIR/tests/test-capacity-contract.sh"
"$OCI_DIR/tests/test-k3s-runtime-contract.sh"

git -C "$ROOT_DIR" diff --exit-code -- .github/workflows/production-build.yml >/dev/null ||
  fail "production-build.yml was modified"

echo "oci_offline_contract=PASS"
