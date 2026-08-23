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
node --check "$OCI_DIR/agents/playwright-live-acceptance.config.js"
node --check "$OCI_DIR/agents/oci-live-acceptance.spec.js"
grep -Fq "getByRole('link', { name: 'BetStan', exact: true })" \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check does not use the accessible BetStan brand"
if grep -Fq "locator('body')).toContainText('BetStan')" \
    "$OCI_DIR/agents/oci-live-smoke.spec.js"; then
  fail "OCI browser check still relies on image alt text appearing in body text"
fi
acceptance_spec="$OCI_DIR/agents/oci-live-acceptance.spec.js"
grep -Fq 'const publicContext = await browser.newContext({' "$acceptance_spec" &&
  grep -Fq 'baseURL: process.env.E2E_BASE_URL' "$acceptance_spec" ||
  fail "OCI live acceptance public context is not bound to the configured base URL"
grep -Fq '}, acceptanceEventIds);' "$acceptance_spec" ||
  fail "OCI live acceptance does not pass scoped event IDs into the browser context"
grep -Fq "publicContext.request.get('/api/backoffice')" "$acceptance_spec" &&
  grep -Fq 'expect(publicBackoffice.status()).toBe(401)' "$acceptance_spec" ||
  fail "OCI live acceptance does not prove anonymous backoffice reads fail closed"
for phase in FIRST_HALF_STOPPAGE SECOND_HALF_STOPPAGE; do
  grep -Fq "'$phase'" "$acceptance_spec" ||
    fail "OCI live acceptance omits runtime phase $phase"
done
if grep -Fq "'STOPPAGE_TIME'" "$acceptance_spec"; then
  fail "OCI live acceptance asserts a phase that the runtime never emits"
fi

lessons="$OCI_DIR/LESSONS_LEARNED.md"
[[ -f "$lessons" ]] || fail "OCI lessons file is missing"
for lesson in \
    "approval wait is an active workflow state" \
    "OCI deletion and registry layer reclamation are asynchronous" \
    "target-loopback tunnel" \
    "No retained backup or old-OCI rollback exists" \
    "Mongo \`fsyncLock\` is process-local" \
    "application rollout does not prove that asynchronous RabbitMQ" \
    "Pre-commit public checks must be read-only" \
    "Never return a blind \`NO_GO\`"; do
    grep -Fq "$lesson" "$lessons" ||
      fail "OCI lessons omit required recovery guidance: $lesson"
done
for agent in \
    betstan-migration-recovery \
    betstan-domain-ingress \
    betstan-azure-retirement; do
    agent_file="$ROOT_DIR/.github/agents/${agent}.agent.md"
    [[ -f "$agent_file" ]] || fail "required recovery agent is missing: $agent"
    grep -Fq "infra/oci/LESSONS_LEARNED.md" "$agent_file" ||
      fail "recovery agent does not read OCI lessons: $agent"
done
grep -Fq "A run waiting for environment approval is active, not hung" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent can misclassify approval waits"
grep -Fq "After \`cutover-committed\`, never retry from Azure" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent can roll back a committed cutover"
grep -Fq "controller-level HTTP mutation fence" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent does not preserve the restart-safe HTTP fence"
grep -Fq "remove the exact 17 application bindings" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent does not require the RabbitMQ routing fence"
grep -Fq "one bounded in-pod deletion loop" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent permits per-binding Bastion round trips"
grep -Fq "https://betstan.xyz" \
    "$ROOT_DIR/.github/agents/betstan-domain-ingress.agent.md" ||
    fail "domain ingress agent lacks the canonical host"
grep -Fq "A successful delete command alone is not" \
    "$ROOT_DIR/.github/agents/betstan-azure-retirement.agent.md" ||
    fail "Azure retirement agent trusts delete acceptance"
grep -Fq 'runtime_deploy_source_sha' \
    "$ROOT_DIR/.github/agents/betstan-azure-retirement.agent.md" ||
    fail "Azure retirement agent omits recovery deployment lineage"
grep -Fq 'never replace optimistic concurrency with a wildcard' \
    "$ROOT_DIR/.github/agents/betstan-azure-retirement.agent.md" ||
    fail "Azure retirement agent permits an unfenced AKS delete"
retirement_operator="$ROOT_DIR/infra/azure/agents/retire-production-stan.sh"
migration_success_contract="$OCI_DIR/scripts/migration-success-contract.sh"
[[ -x "$retirement_operator" ]] ||
  fail "checked-in Azure retirement operator is missing or not executable"
[[ -x "$migration_success_contract" ]] ||
  fail "shared migration-success contract is missing or not executable"
grep -Fq \
    'MODE=validate "$ROOT_DIR/infra/oci/scripts/migration-success-contract.sh"' \
    "$retirement_operator" ||
  fail "Azure retirement does not consume the shared migration-success contract"
for retirement_contract in \
    'oci-migration-success-provenance-${MIGRATION_RUN_ID}-${MIGRATION_RUN_ATTEMPT}' \
    'validate_initial_inventory "$INITIAL_INVENTORY_FILE"' \
    'az rest' \
    '--headers "If-Match=${CLUSTER_ETAG}"' \
    'wait_for_cluster_absence' \
    'validate_inventory_subset "$CURRENT_INVENTORY_FILE"' \
    'verify_subscription_absence' \
    'AZURE_RESOURCES_RETIRED cost_verification=pending_delayed_reporting'; do
    grep -Fq -- "$retirement_contract" "$retirement_operator" ||
      fail "Azure retirement operator omits contract: $retirement_contract"
done
! grep -Eq 'az (ad|role)|gh secret (delete|set)|oci |kubectl ' \
  "$retirement_operator" ||
  fail "Azure retirement operator crosses identity, OCI, or Kubernetes boundaries"

# shellcheck source=../scripts/lib.sh
source "$OCI_DIR/scripts/lib.sh"
[[ "$(oci_normalize_list_json "")" == '{"data":[]}' ]] ||
  fail "empty OCI array response was not normalized"
[[ "$(oci_normalize_list_json "" items)" == '{"data":{"items":[]}}' ]] ||
  fail "empty OCI items response was not normalized"
queue_fixture="$(
  printf '%s\n' \
    'name messages_ready messages_unacknowledged consumers' \
    'event_new_event 0 0 1' \
    'bet_place_bet 2 1 3'
)"
queue_rows="$(oci_rabbitmq_queue_rows <<<"$queue_fixture")" ||
  fail "RabbitMQ queue output with a header was rejected"
[[ "$(awk 'NF {count++} END {print count+0}' <<<"$queue_rows")" == "2" ]] ||
  fail "RabbitMQ header was counted as a queue"
[[ "$(awk '{sum += $2 + $3} END {print sum+0}' <<<"$queue_rows")" == "3" ]] ||
  fail "RabbitMQ normalized backlog differs"
[[ "$(awk '{sum += $4} END {print sum+0}' <<<"$queue_rows")" == "4" ]] ||
  fail "RabbitMQ normalized consumer count differs"
if oci_rabbitmq_queue_rows <<<'name messages_ready messages_unacknowledged consumers extra' >/dev/null; then
  fail "malformed RabbitMQ queue output was accepted"
fi
if oci_rabbitmq_queue_rows <<<$'name messages_ready messages_unacknowledged consumers\nname messages_ready messages_unacknowledged consumers' >/dev/null; then
  fail "duplicate RabbitMQ queue headers were accepted"
fi
for queue_probe in \
  "$OCI_DIR/scripts/baseline-capture-stan.sh" \
  "$OCI_DIR/scripts/rollback-readiness-stan.sh" \
  "$OCI_DIR/scripts/rollback-application-stan.sh" \
  "$ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"; do
  grep -Fq 'rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers' \
    "$queue_probe" ||
    fail "RabbitMQ queue probe does not suppress non-tabular CLI output: $queue_probe"
done
for api_contract_probe in \
  "$OCI_DIR/scripts/baseline-capture-stan.sh" \
  "$OCI_DIR/scripts/rollback-readiness-stan.sh" \
  "$OCI_DIR/scripts/rollback-application-stan.sh" \
  "$ROOT_DIR/infra/azure/agents/baseline-capture-stan.sh" \
  "$ROOT_DIR/infra/azure/agents/rollback-application-stan.sh"; do
  grep -Fq '"/api/bet/stats|array"' "$api_contract_probe" ||
    fail "bet stats rollback contract is not array-shaped: $api_contract_probe"
done
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
ingress_ipv4=203.0.113.10
public_host=betstan.xyz
canonical_host=betstan.xyz
redirect_host=www.betstan.xyz
diagnostic_host=203.0.113.10.nip.io
ENV

IMAGE_PROVENANCE_FILE="$WORK_DIR/images.tsv" \
OCI_RUNTIME_MODE=oke \
INFRA_PROVENANCE_FILE="$WORK_DIR/infrastructure.env" \
OUTPUT_FILE="$WORK_DIR/rendered.yaml" \
WORK_DIR="$WORK_DIR/render-work" \
OCI_K8S_NAMESPACE=betstan-oci \
OCI_CANONICAL_HOST=betstan.xyz \
OCI_REDIRECT_HOST=www.betstan.xyz \
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
backend_names = %w[
  gaming-auth-depl gaming-bet-depl gaming-backoffice-depl gaming-event-depl
  gaming-gamemaster-depl gaming-moderation-depl gaming-resulting-depl
  gaming-slip-depl
]
backends = by_kind.fetch("Deployment").select {
  |deployment| backend_names.include?(deployment.dig("metadata", "name"))
}
abort "eight backend deployments required" unless backends.length == 8
abort "backend numeric non-root identity differs" unless backends.all? {
  |deployment| deployment.dig(
    "spec", "template", "spec", "containers", 0, "securityContext"
  ).then {
    |context| context["runAsNonRoot"] == true &&
      context["runAsUser"] == 1000 && context["runAsGroup"] == 1000
  }
}
mongo = by_kind.fetch("StatefulSet").first
abort "base StatefulSet claim template survived OCI patch" if mongo.dig("spec", "volumeClaimTemplates")
abort "Mongo does not use the explicit 50Gi claim" unless mongo.dig(
  "spec", "template", "spec", "volumes", 0, "persistentVolumeClaim", "claimName"
) == "gaming-auth-mongo-data"
abort "legacy Mongo rendered" if File.read(ARGV.fetch(0)).include?("legacy-mongo")
abort "expected canonical and redirect OCI ingresses" unless by_kind.fetch("Ingress").length == 2
abort "expected canonical and diagnostic certificates" unless by_kind.fetch("Certificate").length == 2
ingress_hosts = by_kind.fetch("Ingress").flat_map {
  |ingress| ingress.fetch("spec").fetch("rules").map { |rule| rule.fetch("host") }
}.sort
abort "OCI ingress host set differs" unless ingress_hosts ==
  %w[203.0.113.10.nip.io betstan.xyz www.betstan.xyz]
canonical_certificate = by_kind.fetch("Certificate").find {
  |certificate| certificate.dig("metadata", "name") == "betstan-oci-canonical-tls"
}
abort "canonical certificate SAN set differs" unless canonical_certificate.dig(
  "spec", "dnsNames"
).sort == %w[betstan.xyz www.betstan.xyz]
redirect = by_kind.fetch("Ingress").find {
  |ingress| ingress.dig("metadata", "name") == "gaming-oci-www-redirect"
}
abort "www ingress must leave HTTP for the canonical redirect" unless redirect.dig(
  "metadata", "annotations", "nginx.ingress.kubernetes.io/ssl-redirect"
) == "false"
abort "www ingress contains an admission-rejected redirect variable" if redirect.dig(
  "metadata", "annotations"
).key?("nginx.ingress.kubernetes.io/permanent-redirect")
puts "oci_rendered_topology=PASS"
RUBY
grep -Fq "apply_documents 'Certificate:^betstan-oci-(canonical-)?tls$'" \
  "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not apply both TLS Certificate resources"
grep -Fq "apply_documents 'Ingress:^gaming-oci-(ingress|www-redirect)$'" \
  "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not apply canonical/diagnostic and www redirect ingresses"
grep -Fq 'certificate was not issued by Let' \
  "$OCI_DIR/agents/smoke-liveness-stan.sh" ||
  fail "OCI public smoke does not verify the served certificate issuer"
grep -Fq 'certificate expires within seven days' \
  "$OCI_DIR/agents/smoke-liveness-stan.sh" ||
  fail "OCI public smoke does not verify served certificate expiry"
grep -Fq 'mutating request bypassed the HTTP maintenance fence' \
  "$OCI_DIR/agents/smoke-liveness-stan.sh" ||
  fail "OCI public smoke cannot prove the cutover HTTP mutation fence"

OCI_RUNTIME_MODE=k3s \
OCI_K3S_NODE_NAME=betstan-k3s \
IMAGE_PROVENANCE_FILE="$WORK_DIR/images.tsv" \
INFRA_PROVENANCE_FILE="$WORK_DIR/infrastructure.env" \
OUTPUT_FILE="$WORK_DIR/rendered-k3s.yaml" \
WORK_DIR="$WORK_DIR/render-k3s-work" \
OCI_K8S_NAMESPACE=betstan-oci \
OCI_CANONICAL_HOST=betstan.xyz \
OCI_REDIRECT_HOST=www.betstan.xyz \
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
for ingress_values in \
  "$OCI_DIR/helm/ingress-nginx-values.yaml" \
  "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml"; do
  grep -Fq 'tag: v1.15.1' "$ingress_values" ||
    fail "ingress-nginx does not support strict ACME challenge paths"
  grep -Fq 'digest: sha256:594ceea76b01c592858f803f9ff4d2cb40542cae2060410b2c95f75907d659e1' \
    "$ingress_values" ||
    fail "ingress-nginx digest differs from the reviewed multi-architecture image"
  ! grep -Eq "strict-validate-path-type:[[:space:]]*['\"]?false" "$ingress_values" ||
    fail "ingress-nginx strict path validation was disabled"
  grep -Fq 'if ($host = "www.betstan.xyz") {' "$ingress_values" ||
    fail "ingress-nginx lacks the exact www redirect host guard"
  grep -Fq 'return 308 https://betstan.xyz$request_uri;' "$ingress_values" ||
    fail "ingress-nginx does not preserve the www request URI in its HTTPS redirect"
done
mongo_target_digest=sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3
for mongo_target_file in \
  "$OCI_DIR/k8s/base/kustomization.yaml" \
  "$OCI_DIR/scripts/verify-images.sh" \
  "$OCI_DIR/agents/health-check-stan.sh"; do
  grep -Fq "$mongo_target_digest" "$mongo_target_file" ||
    fail "Mongo target identity differs from the requested immutable index: $mongo_target_file"
done
mongo_upgrade="$OCI_DIR/scripts/upgrade-mongo.sh"
grep -Fq 'MONGO_TRANSITION_VERSION=8.0.29' "$mongo_upgrade" ||
  fail "Mongo upgrade omits the reviewed 8.0 transition release"
grep -Fq 'MONGO_TARGET_VERSION=8.2.12' "$mongo_upgrade" ||
  fail "Mongo upgrade omits the exact Azure-compatible target release"
grep -Fq 'MONGO_TARGET_ARM64_MANIFEST=sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4' \
  "$mongo_upgrade" ||
  fail "Mongo upgrade omits the exact ARM64 target manifest"
grep -Fq 'sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4' \
  "$OCI_DIR/agents/health-check-stan.sh" ||
  fail "Mongo health omits the exact ARM64 target manifest"
grep -Fq "setFeatureCompatibilityVersion:'\${requested}'" "$mongo_upgrade" ||
  fail "Mongo upgrade does not advance FCV explicitly"
grep -Fq '"$SCRIPT_DIR/upgrade-mongo.sh" prepare' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not prepare the staged Mongo upgrade"
grep -Fq '"$SCRIPT_DIR/upgrade-mongo.sh" finalize' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not finalize the staged Mongo upgrade"
grep -Fq '"$SCRIPT_DIR/upgrade-mongo.sh" resume' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not reopen ingress after staged Mongo maintenance"
grep -Fq 'readOnly: true' "$mongo_upgrade" ||
  fail "Mongo fresh-storage inspection is not read-only"
grep -Fq "trap 'cleanup 143' TERM" "$mongo_upgrade" ||
  fail "Mongo upgrade can report a terminated command as successful"
grep -Fq 'exit 41' "$mongo_upgrade" ||
  fail "Mongo fresh-storage inspection does not fail closed on enumeration errors"
python3 - "$OCI_DIR/scripts/deploy.sh" <<'PY'
import sys

text = open(sys.argv[1], encoding="utf-8").read()
prepare = text.index('"$SCRIPT_DIR/upgrade-mongo.sh" prepare')
apply_target = text.index("apply_documents 'StatefulSet:^gaming-auth-mongo-depl$'", prepare)
finalize = text.index('"$SCRIPT_DIR/upgrade-mongo.sh" finalize', apply_target)
provenance = text.index('} > "$OUTPUT_DIR/provenance.txt"', finalize)
resume = text.index('"$SCRIPT_DIR/upgrade-mongo.sh" resume', provenance)
completed = text.index('oci_log "oci_deploy=PASS', resume)
if not prepare < apply_target < finalize < provenance < resume < completed:
    raise SystemExit("Mongo maintenance/deploy ordering differs")
PY
grep -Fq 'sha256:6033d0c2f4e9eb49dda9623067a96d317bc7b550513bd18532fbd3cd9a941c1b' \
  "$OCI_DIR/agents/health-check-stan.sh" ||
  fail "RabbitMQ health identity differs from the requested immutable index"
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
reuse_images="$OCI_DIR/scripts/reuse-images.sh"
compare_image_inputs="$OCI_DIR/scripts/compare-image-inputs.sh"
grep -Fq 'repository="${OCI_REGISTRY_HOST}/${OCI_REGISTRY_NAMESPACE}/${OCI_IMAGE_PREFIX}_images"' \
  "$build_images" ||
  fail "OCI builds must share one repository so common layers stay inside the Free Tier allowance"
grep -Fq 'tag="${repository}:oci-${service}-${SOURCE_SHA}"' "$build_images" ||
  fail "shared OCI repository tags must bind the service and exact source SHA"
grep -Fq -- '--prefer-index=false' "$reuse_images" ||
  fail "unchanged OCI images are not reused by immutable digest"
grep -Fq 'oci_(die|log|require_command|require_vars|prepare_private_dir)' \
  "$compare_image_inputs" ||
  fail "OCI image input comparison omits the transitive build library contract"
grep -Fq 'untracked helper dependency' "$compare_image_inputs" ||
  fail "OCI image input comparison does not enforce a closed helper dependency set"
inventory="$OCI_DIR/scripts/inventory.sh"
registry_pruner="$OCI_DIR/scripts/prune-registry-generation.sh"
grep -Fq '[$prefix + "_images"]' "$inventory" ||
  fail "OCI inventory must allow only the shared image repository"
grep -Fq 'REGISTRY_IMAGES_PER_GENERATION=9' "$inventory" ||
  fail "OCI inventory must require complete nine-image generations"
grep -Fq 'REGISTRY_MAX_GENERATIONS=3' "$inventory" ||
  fail "OCI inventory must retain at most two rollback generations"
grep -Fq '(.image_count % $registry_images_per_generation) != 0' "$inventory" ||
  fail "OCI inventory must reject partial image generations"
grep -Fq 'oci artifacts container image list' "$inventory" ||
  fail "OCI inventory must inspect exact image tags and digests"
grep -Fq '"repository-name": ."repository-name"' "$inventory" ||
  fail "OCI inventory must bound registry metadata before jq argument use"
grep -Fq 'incomplete_tag_generation_count' "$inventory" ||
  fail "OCI inventory must reject incomplete service tag generations"
grep -Fq 'digest_service_conflict_count' "$inventory" ||
  fail "OCI inventory must reject cross-service digest identities"
grep -Fq 'EXPECTED_IMAGES_BEFORE=36' "$registry_pruner" ||
  fail "registry pruning must require exactly four complete generations"
grep -Fq 'EXPECTED_PROTECTED_IMAGES=27' "$registry_pruner" ||
  fail "registry pruning must retain exactly three complete generations"
grep -Fq 'obsolete generation overlaps a protected generation' "$registry_pruner" ||
  fail "registry pruning does not reject protected digest overlap"
grep -Fq 'registry contains an unknown, missing, or unexpected image generation' \
  "$registry_pruner" ||
  fail "registry pruning does not fail closed on unknown images"
grep -Fq 'read_provenance_repository "$TARGET_IMAGES_FILE"' "$registry_pruner" ||
  fail "registry pruning does not derive one exact provenance repository"
grep -Fq 'OCI registry pruning did not reach the exact protected digest set' \
  "$registry_pruner" ||
  fail "registry pruning does not wait for asynchronous deletion"
grep -Fq '.layers_size_bytes <= $max_bytes' "$registry_pruner" ||
  fail "registry pruning does not wait for bounded registry accounting"
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

grep -R -n -E '\baz\b|AKS|azure\.com|AZURE_' \
  "$OCI_DIR/agents" \
  --exclude='test-health-contract-stan.sh' \
  --exclude='oci-live-smoke.spec.js' >/dev/null 2>&1 &&
  fail "OCI health agents contain an Azure dependency"
for script in "$OCI_DIR/scripts"/*.sh; do
  case "$(basename "$script")" in
    migrate-from-azure.sh | migration-success-contract.sh | recover-azure-migration.sh)
      continue
      ;;
  esac
  grep -Eiq '\baz\b|AKS|AZURE_|azure\.com' "$script" &&
    fail "non-migration OCI script contains an Azure dependency: $script"
done
for workflow in "$ROOT_DIR/.github/workflows"/oci-*.yml; do
  case "$(basename "$workflow")" in
    oci-migrate.yml | oci-migration-recovery.yml)
      continue
      ;;
  esac
  grep -Eq 'AZURE_|azure/login|azure/aks-set-context' "$workflow" &&
    fail "Azure credential/reference exists outside OCI migration: $workflow"
done

build_workflow="$ROOT_DIR/.github/workflows/oci-production-build.yml"
capacity_workflow="$ROOT_DIR/.github/workflows/oci-capacity-acquire.yml"
infra_workflow="$ROOT_DIR/.github/workflows/oci-infrastructure.yml"
data_workflow="$ROOT_DIR/.github/workflows/oci-live-data-rollout.yml"
deploy_workflow="$ROOT_DIR/.github/workflows/oci-production-deploy.yml"
migrate_workflow="$ROOT_DIR/.github/workflows/oci-migrate.yml"
recovery_workflow="$ROOT_DIR/.github/workflows/oci-migration-recovery.yml"
validate_workflow="$ROOT_DIR/.github/workflows/oci-validate.yml"
cli_installer="$OCI_DIR/scripts/install-cli.sh"
deployment_safety_agent="$ROOT_DIR/.github/agents/betstan-deployment-safety.agent.md"
azure_deploy_workflow="$ROOT_DIR/.github/workflows/production-deploy.yml"
oci_live_readiness="$OCI_DIR/agents/live-betting-readiness-stan.sh"

grep -Fq 'read every cited path from that same tree' "$deployment_safety_agent"
grep -Fq 'never infer topology safety from a count' "$deployment_safety_agent"
grep -Fq './infra/azure/agents/shared-mongo-topology-guard-stan.sh' \
  "$azure_deploy_workflow"
grep -Fq 'export REQUIRED_MONGO_TOPOLOGY_MODE=shared' "$oci_live_readiness"
grep -Fq 'export EXPECTED_SHARED_MONGO_PVC=gaming-auth-mongo-data' \
  "$oci_live_readiness"
if grep -Eiq 'at least (eight|8) Mongo PVC' \
  "$deployment_safety_agent" "$azure_deploy_workflow" "$deploy_workflow"; then
  fail "current production safety sources retain the retired eight-PVC gate"
fi

grep -Fq 'workflow_run:' "$build_workflow"
grep -Fq 'workflows: ["production-build"]' "$build_workflow"
grep -Fq 'github.event.workflow_run.head_sha' "$build_workflow"
grep -Fq 'environment:' "$build_workflow"
grep -Fq 'name: oci-build' "$build_workflow"
grep -Fq 'docker login "$OCI_REGISTRY_HOST"' "$build_workflow"
grep -Fq 'exact OCI tag already exists; refusing overwrite' "$OCI_DIR/scripts/build-images.sh"
grep -Fq 'OCI_REUSE_SOURCE_SHA' "$build_workflow"
grep -Fq 'OCI_REUSE_BUILD_RUN_ID' "$build_workflow"
grep -Fq 'compare-image-inputs.sh' "$build_workflow"
grep -Fq 'reuse-images.sh' "$build_workflow"
grep -Fq 'for reuse_attempt in 1 2 3' "$build_workflow"
grep -Fq 'upstream-${{ github.event.workflow_run.id }}' "$build_workflow"
grep -Fq 'group: oci-build-${{ github.event.workflow_run.head_sha }}' "$build_workflow"
! grep -Eq 'OCI_CLI_|OCI_CI_PRIVATE_KEY_PEM' "$build_workflow" ||
  fail "OCI build workflow receives an API signing key"

grep -Fq 'schedule:' "$capacity_workflow"
grep -Fq 'cron: "*/5 * * * *"' "$capacity_workflow"
grep -Fq 'workflow_dispatch:' "$capacity_workflow"
grep -Fq 'github.run_attempt == 1' "$capacity_workflow"
grep -Fq "vars.OCI_CAPACITY_CATCHER_ENABLED == 'true'" "$capacity_workflow"
grep -Fq "github.event_name == 'workflow_dispatch'" "$capacity_workflow"
grep -Fq "inputs.approved_sha != ''" "$capacity_workflow"
grep -Fq 'group: oci-control-plane' "$capacity_workflow"
grep -Fq 'name: oci-capacity-acquire' "$capacity_workflow"
grep -Fq 'OCI_CAPACITY_PRIVATE_KEY_PEM' "$capacity_workflow"
! grep -Eq 'OCI_CI_PRIVATE_KEY_PEM|OCI_REGISTRY_|OCI_JWT_|AZURE_|azure/' \
  "$capacity_workflow" ||
  fail "capacity workflow receives credentials outside its dedicated identity"

for workflow in "$infra_workflow" "$data_workflow" "$deploy_workflow" "$migrate_workflow"; do
  grep -Fq 'workflow_dispatch:' "$workflow"
  grep -Fq 'github.run_attempt == 1' "$workflow"
  grep -Fq 'group: oci-control-plane' "$workflow"
done
for workflow in "$infra_workflow" "$data_workflow" "$deploy_workflow"; do
  [[ "$(grep -Fc \
    'OCI_K3S_SSH_PRIVATE_KEY: ${{ secrets.OCI_K3S_SSH_PRIVATE_KEY }}' \
    "$workflow")" == "1" ]] ||
    fail "target SSH private key must be scoped to one k3s access step: $(basename "$workflow")"
done
[[ "$(grep -Fc \
  'OCI_K3S_SSH_PRIVATE_KEY: ${{ secrets.OCI_K3S_SSH_PRIVATE_KEY }}' \
  "$migrate_workflow")" == "2" ]] ||
  fail "migration SSH key must be scoped to migration and finalization access steps"
! grep -Fq 'OCI_K3S_SSH_PRIVATE_KEY' "$capacity_workflow" ||
  fail "capacity acquisition must receive only the target SSH public key"
grep -Fq 'OCI_K3S_RETAIN_TARGET_SSH: "true"' "$infra_workflow" ||
  fail "infrastructure finalization does not retain target SSH within its access step"
grep -Fq 'unset OCI_K3S_SSH_PRIVATE_KEY' "$infra_workflow" ||
  fail "infrastructure finalization does not clear the target SSH secret before use"
! grep -Fq 'OCI_K3S_RETAIN_TARGET_SSH' "$data_workflow" "$deploy_workflow" "$migrate_workflow" ||
  fail "deployment or migration retains target SSH key material after API forwarding"
for workflow in "$deploy_workflow" "$migrate_workflow"; do
  public_job_line="$(grep -n -m1 '^  public-validate:' "$workflow" | cut -d: -f1)"
  next_job_line="$(awk -v start="$public_job_line" '
    NR > start && /^  [A-Za-z0-9_-]+:/ {print NR; exit}
  ' "$workflow"  )"
  [[ -n "$next_job_line" ]] || next_job_line=$(( $(wc -l <"$workflow") + 1 ))
  public_secrets="$(
    sed -n "${public_job_line},$((next_job_line - 1))p" "$workflow" |
      grep -c 'secrets\.' || true
  )"
  public_cloud_credentials="$(
    sed -n "${public_job_line},$((next_job_line - 1))p" "$workflow" |
      grep -Ec \
        'OCI_CLI_|OCI_CI_PRIVATE_KEY|AZURE_CONFIG|azure/login|aks-set-context|configure-kubectl-oke' ||
      true
  )"
  [[ -n "$public_job_line" && "$public_secrets" == "0" &&
      "$public_cloud_credentials" == "0" ]] ||
    fail "public validation shares a job with cloud credentials: $(basename "$workflow")"
  grep -Fq 'persist-credentials: false' "$workflow" ||
    fail "public validation checkout persists a GitHub credential: $(basename "$workflow")"
  grep -Fq 'OCI_CLUSTER_CHECKS_ALREADY_PASSED: "1"' "$workflow" ||
    fail "public validation is not isolated from cluster checks: $(basename "$workflow")"
  grep -Fq 'OCI_PUBLIC_CHECKS_ALREADY_PASSED: "1"' "$workflow" ||
    fail "protected validation still executes package code: $(basename "$workflow")"
  grep -Fq 'OCI_E2E_ALREADY_PASSED: "1"' "$workflow" ||
    fail "protected validation still executes browser code: $(basename "$workflow")"
done
deploy_public_job_line="$(
  grep -n -m1 '^  public-validate:' "$deploy_workflow" | cut -d: -f1
)"
deploy_dependency_line="$(
  grep -n -m1 'name: Install browser validation dependencies' \
    "$deploy_workflow" | cut -d: -f1
)"
[[ "$deploy_dependency_line" -gt "$deploy_public_job_line" ]] ||
  fail "deployment browser validation is not in its credential-free public job"
migration_public_job_line="$(
  grep -n -m1 '^  public-validate:' "$migrate_workflow" | cut -d: -f1
)"
migration_finalize_job_line="$(
  grep -n -m1 '^  finalize:' "$migrate_workflow" | cut -d: -f1
)"
migration_post_job_line="$(
  grep -n -m1 '^  post-commit-validate:' "$migrate_workflow" | cut -d: -f1
)"
migration_dependency_line="$(
  grep -n -m1 'name: Install browser validation dependencies' \
    "$migrate_workflow" | cut -d: -f1
)"
[[ -n "$migration_post_job_line" &&
    "$migration_public_job_line" -lt "$migration_finalize_job_line" &&
    "$migration_finalize_job_line" -lt "$migration_post_job_line" &&
    "$migration_dependency_line" -gt "$migration_post_job_line" ]] ||
  fail "migration browser validation is not isolated after finalization"
migration_post_secrets="$(
  sed -n "${migration_post_job_line},\$p" "$migrate_workflow" |
    grep -c 'secrets\.' || true
)"
migration_post_cloud_credentials="$(
  sed -n "${migration_post_job_line},\$p" "$migrate_workflow" |
    grep -Ec \
      'OCI_CLI_|OCI_CI_PRIVATE_KEY|AZURE_CONFIG|azure/login|aks-set-context|configure-kubectl-oke' ||
    true
)"
[[ "$migration_post_secrets" == "0" &&
    "$migration_post_cloud_credentials" == "0" ]] ||
  fail "post-commit browser validation receives cloud credentials"
grep -Fq 'name: oci-infrastructure' "$infra_workflow"
grep -Fq 'PROVISION OCI ZERO COST' "$infra_workflow"
grep -Fq -- '- prune-registry' "$infra_workflow"
grep -Fq 'PRUNE OBSOLETE OCI IMAGE GENERATION' "$infra_workflow"
grep -Fq 'prune-registry-generation.sh' "$infra_workflow"
grep -Fq 'oci-image-provenance-${OBSOLETE_SHA}-${OBSOLETE_BUILD_RUN_ID}-1' \
  "$infra_workflow"
grep -Fq 'oci-image-provenance-${FALLBACK_SHA}-${FALLBACK_BUILD_RUN_ID}-1' \
  "$infra_workflow"
grep -Fq 'oci-deploy-provenance-${DEPLOYED_RUN_ID}-1' "$infra_workflow"
registry_checkout_line="$(
  grep -n -m1 'Checkout exact current master' "$infra_workflow" | cut -d: -f1
)"
registry_evidence_line="$(
  grep -n -m1 'Initialize registry prune evidence' "$infra_workflow" | cut -d: -f1
)"
[[ -n "$registry_checkout_line" && -n "$registry_evidence_line" &&
    "$registry_checkout_line" -lt "$registry_evidence_line" ]] ||
  fail "registry prune evidence is initialized before checkout cleanup"
grep -Fq 'name: oci-migration' "$data_workflow"
grep -Fq 'DRY RUN LIVE DATA EXACT SHA' "$data_workflow"
grep -Fq 'APPLY LIVE BACKFILLS EXACT SHA' "$data_workflow"
grep -Fq 'APPLY LIVE SLIP INDEX EXACT SHA' "$data_workflow"
grep -Fq 'shared-mongo-operation-lock-stan.sh acquire' "$data_workflow"
grep -Fq 'shared-mongo-operation-lock-stan.sh release' "$data_workflow"
grep -Fq 'verify-live-betting-data-evidence-stan.sh' "$data_workflow"
grep -Fq 'name: oci-production' "$deploy_workflow"
grep -Fq 'DEPLOY OCI EXACT SHA' "$deploy_workflow"
grep -Fq 'data_run_id:' "$deploy_workflow"
grep -Fq 'EXPECTED_PHASE=apply-slip-index' "$deploy_workflow"
grep -Fq 'name: oci-migration' "$migrate_workflow"
grep -Fq 'REPLACE OCI DATA FROM AZURE' "$migrate_workflow"
grep -Fq 'replace_oci_data:' "$migrate_workflow"
grep -Fq 'inputs.replace_oci_data == true' "$migrate_workflow"
grep -Fq 'build_run_id:' "$migrate_workflow"
grep -Fq 'redirect_url: ${{ steps.provenance.outputs.redirect_url }}' "$migrate_workflow"
grep -Fq 'diagnostic_url: ${{ steps.provenance.outputs.diagnostic_url }}' "$migrate_workflow"
grep -Fq 'OCI_REDIRECT_URL:' "$migrate_workflow"
grep -Fq 'OCI_DIAGNOSTIC_URL:' "$migrate_workflow"
grep -Fq '[ "$OCI_PUBLIC_URL" = "https://betstan.xyz" ]' "$migrate_workflow"
grep -Fq '[ "$OCI_REDIRECT_URL" = "https://www.betstan.xyz" ]' "$migrate_workflow"
grep -Fq '[[ "$OCI_DIAGNOSTIC_URL" =~ ^https://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.nip\.io$ ]]' \
  "$migrate_workflow"
grep -Fq 'name: oci-migration-success-provenance-${{ github.run_id }}-${{ github.run_attempt }}' \
  "$migrate_workflow"
grep -Fq 'path: artifacts/oci-migration-success/migration-summary.env' "$migrate_workflow"
grep -Fq 'MODE=emit ./infra/oci/scripts/migration-success-contract.sh' \
  "$migrate_workflow" ||
  fail "OCI migration does not emit through the shared migration-success contract"
grep -Fq 'schema=betstan.oci-migration-success.v1' "$migrate_workflow"
grep -Fq 'terminal_phase=DEPLOYED_HEALTHY' "$migrate_workflow"
grep -Fq 'terminal_status=DEPLOYED_HEALTHY' "$migrate_workflow"
grep -Fq 'journal_heartbeat_epoch=' "$migrate_workflow"
grep -Fq 'fencing_generation=' "$migrate_workflow"
grep -Fq 'artifact_run_binding=${run_id}-${run_attempt}' "$migrate_workflow"
grep -Fq 'destructive_boundary_crossed=true' "$migrate_workflow"
grep -Fq 'database_count=8' "$migrate_workflow"
grep -Fq 'logical_source_target_parity=true' "$migrate_workflow"
grep -Fq 'oci_reopened_healthy=true' "$migrate_workflow"
grep -Fq 'azure_writers_frozen=true' "$migrate_workflow"
grep -Fq 'azure_cluster_stopped_deallocated=true' "$migrate_workflow"
public_job_line="$(grep -n -m1 '^  public-validate:' "$migrate_workflow" | cut -d: -f1)"
terminal_summary_line="$(
  grep -n -m1 'terminal_status=DEPLOYED_HEALTHY' "$migrate_workflow" |
    cut -d: -f1
)"
[[ "$terminal_summary_line" -gt "$public_job_line" ]] ||
  fail "terminal migration success provenance is emitted before public validation"
grep -Fq 'OCI_MIGRATION_AZURE_CREDENTIALS' "$migrate_workflow"
grep -Fq 'OCI_MIGRATION_AGE_IDENTITY' "$migrate_workflow"
grep -Fq 'az aks start' "$migrate_workflow"
grep -Fq 'az aks stop' "$migrate_workflow"
[[ "$(grep -Fc 'type == "array" and' "$migrate_workflow")" -ge 3 ]] ||
  fail "Azure stop paths do not safely accept an empty VMSS instance set"
! grep -Fq 'length >= 1 and' "$migrate_workflow" ||
  fail "Azure stop paths incorrectly require a retained VMSS instance"
[[ "$(grep -Fc 'install -m 600 -- "$KUBE_CONFIG_PATH" "$AZURE_KUBECONFIG"' \
  "$migrate_workflow")" -eq 2 ]] ||
  fail "Azure action kubeconfigs are not materialized at both isolated paths"
[[ "$(grep -Fc 'exit "$cleanup_status"' "$migrate_workflow")" -eq 2 ]] ||
  fail "unexpected kubeconfig paths can bypass credential cleanup"
[[ "$(grep -Fc 'Stopped|Deallocated)' "$migrate_workflow")" -ge 4 ]] ||
  fail "migration does not accept both Azure stopped-state representations"
grep -Fq '[ "$provisioning" = "Failed" ]' "$migrate_workflow" ||
  fail "migration cannot restart the exact failed/deallocated source"
[[ "$(grep -Ec "steps\\.(final_)?oci_cli\\.outcome == 'success'" \
  "$migrate_workflow")" -eq 2 ]] ||
  fail "migration can run Bastion cleanup before an OCI CLI is installed"
! grep -Eq 'az aks (create|update|delete)|az aks nodepool' "$migrate_workflow" ||
  fail "migration workflow can create, resize, or delete Azure compute"
grep -Fq 'if: always()' "$infra_workflow"
grep -Fq 'if: always()' "$deploy_workflow"
grep -Fq 'if: always()' "$migrate_workflow"

grep -Fq 'name: oci-migration-recovery' "$recovery_workflow"
grep -Fq 'workflows: ["oci-migrate"]' "$recovery_workflow"
grep -Fq 'cron: "*/15 * * * *"' "$recovery_workflow"
grep -Fq 'workflow_dispatch:' "$recovery_workflow"
grep -Fq "vars.OCI_MIGRATION_RECOVERY_ENABLED == 'true'" "$recovery_workflow"
grep -Fq "vars.OCI_MIGRATION_RECOVERY_ENABLED || 'false'" "$recovery_workflow"
grep -Fq 'OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH' "$recovery_workflow"
grep -Fq '86400' "$recovery_workflow"
grep -Fq 'name: azure-migration-recovery' "$recovery_workflow"
grep -Fq 'AZURE_MIGRATION_RECOVERY_CREDENTIALS' "$recovery_workflow"
grep -Fq 'group: azure-migration-recovery' "$recovery_workflow"
grep -Fq 'cancel-in-progress: true' "$recovery_workflow"
grep -Fq 'actions: write' "$recovery_workflow"
grep -Fq 'az aks stop' "$recovery_workflow"
[[ "$(grep -Fc 'Stopped|Deallocated)' "$recovery_workflow")" -ge 2 ]] ||
  fail "recovery does not accept both Azure stopped-state representations"
grep -Fq '[ "$provisioning" = "Failed" ]' "$recovery_workflow" ||
  fail "recovery rejects a safely deallocated failed AKS control plane"
! grep -Eq \
  'OCI_MIGRATION_AZURE_CREDENTIALS|OCI_CI_PRIVATE_KEY_PEM|OCI_K3S_SSH_PRIVATE_KEY|OCI_MIGRATION_AGE_IDENTITY' \
  "$recovery_workflow" ||
  fail "stop-only recovery receives migration or OCI credentials"
! grep -Eq 'az aks (start|create|update|delete)|az aks nodepool' "$recovery_workflow" ||
  fail "stop-only recovery can start, create, resize, or delete Azure compute"

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
for workflow in "$capacity_workflow" "$infra_workflow" "$deploy_workflow" "$migrate_workflow"; do
  grep -Fq './infra/oci/scripts/install-cli.sh' "$workflow" ||
    fail "pinned OCI CLI installer missing from $(basename "$workflow")"
  ! grep -Fq 'oracle-actions/run-oci-cli-command' "$workflow" ||
    fail "opaque OCI CLI action remains in $(basename "$workflow")"
done
grep -Fq '"oci-cli==${OCI_CLI_VERSION}"' "$cli_installer" ||
  fail "OCI CLI package installation is not pinned to OCI_CLI_VERSION"
grep -Fq 'python3 -m pip install' "$cli_installer" ||
  fail "OCI CLI installer does not use the runner's explicit Python 3"
! grep -R --include='*.sh' -F -- '--network-security-group-id' "$OCI_DIR/scripts" >/dev/null ||
  fail "OCI scripts use the unsupported NSG rule argument --network-security-group-id"
grep -Fq -- '--nsg-id "$nsg_id"' "$OCI_DIR/scripts/provision.sh" ||
  fail "OCI network reconciliation does not use the supported NSG rule argument"
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

validate_production_build_deployment_safety_contract() {
  local workflow_file="$1"
  ruby - "$workflow_file" <<'RUBY'
require "yaml"

workflow_file = ARGV.fetch(0)
workflow_text = File.read(workflow_file)
expected_checkout = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"
approved_action_refs = {
  "actions/checkout" => "11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/setup-node" => "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/cache" => "0400d5f644dc74513175e3cd8d07132dd4860809",
  "docker/setup-buildx-action" => "e468171a9de216ec08956ac3ada2f0791b6bd435",
  "docker/login-action" => "184bdaa0721073962dff0199f1fb9940f07167d1",
  "docker/build-push-action" => "ca052bb54ab0790a636c9b5f226502c73d547a25",
  "actions/upload-artifact" => "ea165f8d65b6e75b540449e92b4886f43607fa02",
}.freeze
expected_syntax_targets = [
  "infra/azure/agents/deploy-validation-loop-stan.sh",
  "infra/azure/agents/live-betting-readiness-lib.sh",
  "infra/azure/agents/live-betting-readiness-stan.sh",
  "infra/azure/agents/live-betting-readiness-test-lib.sh",
  "infra/azure/agents/pre-commit-infra-check-stan.sh",
  "infra/azure/agents/test-deploy-validation-loop-stan.sh",
  "infra/azure/agents/test-deployment-safety-ci-stan.sh",
  "infra/azure/agents/test-live-betting-readiness-stan.sh",
  "infra/azure/agents/test-live-betting-rollback-readiness-stan.sh",
  "infra/azure/agents/test-production-rollback-stan.sh",
  "infra/oci/agents/deploy-validation-loop-stan.sh",
  "infra/oci/agents/live-betting-readiness-stan.sh",
  "infra/oci/scripts/deploy.sh",
  "infra/oci/scripts/live-data-maintenance-stan.sh",
  "infra/oci/scripts/live-betting-control-stan.sh",
  "infra/oci/scripts/revalidate-live-activation-stan.sh",
  "infra/oci/scripts/live-betting-data-rollout-stan.sh",
  "infra/oci/scripts/shared-mongo-operation-lock-stan.sh",
  "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh",
  "infra/oci/tests/test-deploy-validation-loop-stan.sh",
  "infra/oci/tests/test-live-data-maintenance-stan.sh",
  "infra/oci/tests/test-live-betting-control-stan.sh",
  "infra/oci/tests/test-revalidate-live-activation-stan.sh",
  "infra/oci/tests/test-live-betting-data-rollout-stan.sh",
  "infra/oci/tests/test-live-betting-readiness-stan.sh",
  "infra/oci/tests/rollback-live-readiness-contract.sh",
  "infra/oci/tests/rollback-contract.sh",
]
expected_exec_targets = [
  "./infra/azure/agents/pre-commit-infra-check-stan.sh",
  "./infra/azure/agents/test-deployment-safety-ci-stan.sh",
  "./infra/azure/agents/test-deploy-validation-loop-stan.sh",
  "./infra/azure/agents/test-live-betting-readiness-stan.sh",
  "./infra/azure/agents/test-live-betting-rollback-readiness-stan.sh",
  "./infra/azure/agents/test-production-rollback-stan.sh",
  "./infra/oci/tests/test-deploy-validation-loop-stan.sh",
  "./infra/oci/tests/test-live-data-maintenance-stan.sh",
  "./infra/oci/tests/test-live-betting-control-stan.sh",
  "./infra/oci/tests/test-revalidate-live-activation-stan.sh",
  "./infra/oci/tests/test-live-betting-data-rollout-stan.sh",
  "./infra/oci/tests/test-live-betting-readiness-stan.sh",
  "./infra/oci/tests/rollback-live-readiness-contract.sh",
  "./infra/oci/tests/rollback-contract.sh",
]
expected_yaml_targets = [
  ".github/workflows/production-build.yml",
  ".github/workflows/production-deploy.yml",
  ".github/workflows/oci-live-betting-activate.yml",
  ".github/workflows/oci-live-betting-disable.yml",
  ".github/workflows/oci-live-data-rollout.yml",
  ".github/workflows/oci-production-deploy.yml",
]

def flatten_strings(value, output = [])
  case value
  when String
    output << value
  when Array
    value.each { |item| flatten_strings(item, output) }
  when Hash
    value.each do |key, item|
      flatten_strings(key, output)
      flatten_strings(item, output)
    end
  end
  output
end

def writable_permissions?(value)
  case value
  when String
    value.include?("write")
  when Hash
    value.any? { |_key, item| writable_permissions?(item) }
  else
    false
  end
end

def deep_stringify_workflow_keys(value)
  case value
  when Hash
    value.each_with_object({}) do |(key, item), output|
      normalized_key = key == true ? "on" : key.to_s
      output[normalized_key] = deep_stringify_workflow_keys(item)
    end
  when Array
    value.map { |item| deep_stringify_workflow_keys(item) }
  else
    value
  end
end

def load_workflow_document(text)
  deep_stringify_workflow_keys(YAML.load_stream(text).first)
end

def parse_action_uses(workflow_text)
  entries = []
  workflow_text.each_line.with_index(1) do |line, line_number|
    next unless line =~ /^\s*uses:\s*([^\s#]+)/

    entries << {
      "line" => line_number,
      "use" => Regexp.last_match(1),
    }
  end
  entries
end

def validate_action_pins(workflow_text, approved_action_refs)
  errors = []
  seen_repositories = []

  parse_action_uses(workflow_text).each do |entry|
    line_number = entry.fetch("line")
    use = entry.fetch("use")
    match = use.match(/\A(?<repository>[^@\s]+)@(?<ref>[^\s]+)\z/)

    unless match
      errors << "production-build uses entry at line #{line_number} does not pin an action ref: #{use}"
      next
    end

    repository = match[:repository]
    ref = match[:ref]
    seen_repositories << repository

    expected_ref = approved_action_refs[repository]
    unless expected_ref
      errors << "production-build uses entry at line #{line_number} references an unreviewed third-party action: #{repository}"
      next
    end

    unless ref.match?(/\A[0-9a-f]{40}\z/)
      errors << "production-build uses entry at line #{line_number} is not pinned to a full 40-character lowercase hex commit SHA: #{use}"
      next
    end

    next if ref == expected_ref

    errors << "production-build uses entry at line #{line_number} is pinned to #{repository}@#{ref}, expected #{repository}@#{expected_ref}"
  end

  missing_repositories = approved_action_refs.keys - seen_repositories.uniq
  unexpected_repositories = seen_repositories.uniq - approved_action_refs.keys
  if missing_repositories.any? || unexpected_repositories.any?
    fragments = []
    fragments << "missing reviewed actions: #{missing_repositories.join(', ')}" if missing_repositories.any?
    fragments << "unexpected actions: #{unexpected_repositories.sort.join(', ')}" if unexpected_repositories.any?
    errors << "production-build action inventory changed (#{fragments.join('; ')})"
  end

  errors
end

def normalize_run(run)
  ruby_block = run.match(/ruby -ryaml -e '\n(?<body>.*?)\n\s*'/m)
  normalized_run = if ruby_block
    run.sub(ruby_block[0], "RUBY_PRODUCTION_WORKFLOW_PARSE\n")
  else
    run
  end
  tokens = normalized_run.lines.map { |line| line.strip }.reject(&:empty?)
  [tokens, ruby_block&.named_captures&.fetch("body", nil)]
end

def validate_workflow(
  workflow_text,
  expected_checkout:,
  approved_action_refs:,
  expected_syntax_targets:,
  expected_exec_targets:,
  expected_yaml_targets:
)
  errors = []
  document = load_workflow_document(workflow_text)
  jobs = document["jobs"] || {}

  permissions = document["permissions"]
  errors << "production-build permissions must stay read-only" unless permissions == { "contents" => "read" }
  errors << "production-build must not request writable permissions" if writable_permissions?(permissions)
  errors.concat(validate_action_pins(workflow_text, approved_action_refs))

  safety_job = jobs["deployment-safety-contracts"]
  unless safety_job.is_a?(Hash)
    errors << "deployment-safety-contracts job is missing"
    return errors
  end
  errors << "deployment-safety-contracts must stay on ubuntu-latest" unless safety_job["runs-on"] == "ubuntu-latest"
  errors << "deployment-safety-contracts must not declare job env" if safety_job.key?("env")
  errors << "deployment-safety-contracts must not declare job permissions" if safety_job.key?("permissions")

  safety_job_strings = flatten_strings(safety_job)
  if safety_job_strings.any? { |value| value.include?("secrets.") || value.include?("${{ secrets.") }
    errors << "deployment-safety-contracts must not receive production credentials"
  end
  if safety_job_strings.any? { |value| value.match?(/\b(OCI_CLI_|OCI_CI_|AZURE_|KUBECONFIG|GITHUB_TOKEN|DOCKERHUB_)\b/) }
    errors << "deployment-safety-contracts references production-capable credentials"
  end
  if safety_job_strings.any? { |value| value.include?("${{ vars.") }
    errors << "deployment-safety-contracts must not rely on mutable workflow vars"
  end

  steps = safety_job["steps"]
  unless steps.is_a?(Array) && steps.length == 2
    errors << "deployment-safety-contracts must keep exactly two steps"
    return errors
  end

  checkout_step = steps[0] || {}
  validate_step = steps[1] || {}
  errors << "deployment-safety-contracts checkout action is no longer pinned" unless checkout_step["uses"] == expected_checkout
  errors << "deployment-safety-contracts checkout step changed shape" unless checkout_step.keys.sort == %w[name uses]
  errors << "deployment-safety-contracts validation step changed shape" unless validate_step.keys.sort == %w[name run]

  tokens, yaml_block = normalize_run(validate_step["run"].to_s)
  syntax_targets = []
  exec_targets = []
  unexpected_tokens = []

  tokens.each do |token|
    case token
    when "RUBY_PRODUCTION_WORKFLOW_PARSE"
      next
    when /\Abash -n (.+)\z/
      syntax_targets << Regexp.last_match(1)
    when /\A\.\//
      exec_targets << token
    else
      unexpected_tokens << token
    end
  end

  errors << "deployment-safety-contracts contains unexpected commands: #{unexpected_tokens.join(', ')}" unless unexpected_tokens.empty?
  errors << "deployment-safety-contracts syntax checks changed" unless syntax_targets == expected_syntax_targets
  errors << "deployment-safety-contracts fixture executions changed" unless exec_targets == expected_exec_targets

  run_text = validate_step["run"].to_s
  if (forbidden_command = run_text.each_line.map(&:strip).reject(&:empty?).find { |line| line.match?(/\b(kubectl|gh|curl)\b/) })
    errors << "deployment-safety-contracts contains a production-capable command: #{forbidden_command}"
  end
  if (dangerous_local = exec_targets.find { |target| target.match?(%r{\A\./infra/(?:azure|oci)/(?:agents|scripts)/(?!(?:pre-commit-infra-check|test-).+\.sh\z).+}) })
    errors << "deployment-safety-contracts invokes a non-fixture local command: #{dangerous_local}"
  end

  unless yaml_block &&
         yaml_block.include?("YAML.load_stream(File.read(file))") &&
         expected_yaml_targets.all? { |target| yaml_block.include?(target) }
    errors << "deployment-safety-contracts workflow YAML parse block changed"
  end

  pr_job = jobs["pr-quality-gates"] || {}
  errors << "pr-quality-gates must depend on deployment-safety-contracts" unless Array(pr_job["needs"]).include?("deployment-safety-contracts")
  pr_gate_step = Array(pr_job["steps"]).find { |step| step["name"] == "Require every validation gate" } || {}
  pr_gate_env = pr_gate_step["env"] || {}
  unless pr_gate_env["DEPLOYMENT_SAFETY_RESULT"] == "${{ needs.deployment-safety-contracts.result }}"
    errors << "pr-quality-gates lost deployment-safety result wiring"
  end
  unless pr_gate_step["run"].to_s.include?('$DEPLOYMENT_SAFETY_RESULT')
    errors << "pr-quality-gates no longer checks deployment-safety result"
  end

  build_job = jobs["build"] || {}
  errors << "build must depend on deployment-safety-contracts" unless Array(build_job["needs"]).include?("deployment-safety-contracts")
  unless build_job["if"].to_s.include?("needs.deployment-safety-contracts.result == 'success'")
    errors << "build no longer blocks on deployment-safety failure"
  end

  errors
end

def mutate_once(text, needle, replacement)
  mutated = text.sub(needle, replacement)
  raise "fixture mutation failed for #{needle.inspect}" if mutated == text
  mutated
end

errors = validate_workflow(
  workflow_text,
  expected_checkout: expected_checkout,
  approved_action_refs: approved_action_refs,
  expected_syntax_targets: expected_syntax_targets,
  expected_exec_targets: expected_exec_targets,
  expected_yaml_targets: expected_yaml_targets,
)
abort(errors.join("\n")) unless errors.empty?

negative_cases = {
  "missing-fixture-test" => [
    mutate_once(
      workflow_text,
      "          ./infra/oci/tests/rollback-contract.sh\n",
      ""
    ),
    "deployment-safety-contracts fixture executions changed",
  ],
  "production-capable-command" => [
    mutate_once(
      workflow_text,
      "          ./infra/azure/agents/pre-commit-infra-check-stan.sh\n",
      "          kubectl get deployments -n default\n          ./infra/azure/agents/pre-commit-infra-check-stan.sh\n"
    ),
    "deployment-safety-contracts contains a production-capable command",
  ],
  "writable-permissions" => [
    mutate_once(
      workflow_text,
      "permissions:\n  contents: read",
      "permissions:\n  contents: write"
    ),
    "production-build permissions must stay read-only",
  ],
  "floating-major-tag" => [
    mutate_once(
      workflow_text,
      "actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809",
      "actions/cache@v4"
    ),
    "is not pinned to a full 40-character lowercase hex commit SHA",
  ],
  "short-sha" => [
    mutate_once(
      workflow_text,
      "docker/login-action@184bdaa0721073962dff0199f1fb9940f07167d1",
      "docker/login-action@184bdaa0721073962dff0199f1fb9940f07167d"
    ),
    "is not pinned to a full 40-character lowercase hex commit SHA",
  ],
  "uppercase-nonhex" => [
    mutate_once(
      workflow_text,
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/setup-node@49933EA5288CAECA8642D1E84AFBD3F7D6820020"
    ),
    "is not pinned to a full 40-character lowercase hex commit SHA",
  ],
  "wrong-full-sha" => [
    mutate_once(
      workflow_text,
      "docker/build-push-action@ca052bb54ab0790a636c9b5f226502c73d547a25",
      "docker/build-push-action@0000000000000000000000000000000000000000"
    ),
    "expected docker/build-push-action@ca052bb54ab0790a636c9b5f226502c73d547a25",
  ],
  "unknown-action" => [
    mutate_once(
      workflow_text,
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "acme/unknown-action@ea165f8d65b6e75b540449e92b4886f43607fa02"
    ),
    "references an unreviewed third-party action",
  ],
  "ungated-build" => [
    mutate_once(
      workflow_text,
      "      needs.deployment-safety-contracts.result == 'success' &&\n",
      ""
    ),
    "build no longer blocks on deployment-safety failure",
  ],
}

negative_cases.each do |name, (candidate, expected_error)|
  candidate_errors = validate_workflow(
    candidate,
    expected_checkout: expected_checkout,
    approved_action_refs: approved_action_refs,
    expected_syntax_targets: expected_syntax_targets,
    expected_exec_targets: expected_exec_targets,
    expected_yaml_targets: expected_yaml_targets,
  )
  if candidate_errors.empty?
    abort("#{name} fixture unexpectedly passed")
  end
  next if candidate_errors.any? { |error| error.include?(expected_error) }

  abort("#{name} fixture failed for the wrong reason: #{candidate_errors.join(' | ')}")
end

puts "production_build_deployment_safety_contract=PASS cases=#{negative_cases.length + 1}"
RUBY
}

validate_production_build_deployment_safety_contract \
  "$ROOT_DIR/.github/workflows/production-build.yml"

if [[ "${BETSTAN_CONTRACT_ORCHESTRATED:-0}" != "1" ]]; then
  "$OCI_DIR/tests/test-migration-success-contract.sh"
  "$OCI_DIR/tests/test-capacity-contract.sh"
  "$OCI_DIR/tests/test-image-reuse-contract.sh"
  "$OCI_DIR/tests/test-k3s-runtime-contract.sh"
  "$OCI_DIR/tests/test-registry-prune-contract.sh"
  "$OCI_DIR/tests/test-migration-recovery-contract.sh"
  "$OCI_DIR/tests/test-mongo-upgrade.sh"
  "$OCI_DIR/agents/test-health-contract-stan.sh"
  "$ROOT_DIR/infra/azure/agents/test-retire-production-reentrant-stan.sh"
  "$ROOT_DIR/infra/azure/agents/test-retire-migration-identities-stan.sh"
  "$ROOT_DIR/infra/azure/agents/test-audit-oci-primary-retirement-stan.sh"
fi

echo "oci_offline_contract=PASS"
