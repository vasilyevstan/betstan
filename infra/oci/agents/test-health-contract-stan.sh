#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
HEALTH="$OCI_DIR/agents/health-check-stan.sh"
HEALTHY="$OCI_DIR/tests/fixtures/health/healthy.json"
_SAFE_PARENT="${BETSTAN_TEST_TMPDIR:-${ROOT_DIR}/.test-workdirs}"
mkdir -p "$_SAFE_PARENT"
WORK_DIR="$(mktemp -d "$_SAFE_PARENT/health-contract-XXXXXX")"

mkdir -p "$WORK_DIR/bin"
trap 'rm -rf "$WORK_DIR"' EXIT

grep -Fq 'service, _, _, manifest_digest, platform_digest = row' "$HEALTH" &&
  grep -Fq \
    'expected[f"gaming-{service}"] = {manifest_digest, platform_digest}' \
    "$HEALTH" || {
  echo "application pod health omits a provenance-bound CRI digest" >&2
  exit 1
}

OCI_HEALTH_FIXTURE_FILE="$HEALTHY" "$HEALTH" | grep -qx DEPLOYED_HEALTHY
jq '
  .context.runtime_mode="k3s" |
  .ingress.load_balancer_service_count=0
' "$HEALTHY" > "$WORK_DIR/healthy-k3s.json"
OCI_HEALTH_FIXTURE_FILE="$WORK_DIR/healthy-k3s.json" \
  "$HEALTH" | grep -qx DEPLOYED_HEALTHY

run_failure() {
  local name="$1"
  local filter="$2"
  local code="$3"
  local fixture="$WORK_DIR/${name}.json"
  local output="$WORK_DIR/${name}.out"
  jq "$filter" "$HEALTHY" > "$fixture"
  if OCI_HEALTH_FIXTURE_FILE="$fixture" "$HEALTH" >"$output" 2>&1; then
    echo "fixture unexpectedly passed: $name" >&2
    exit 1
  fi
  grep -Fq "code=${code}" "$output" || {
    echo "fixture did not produce expected redacted reason: $name" >&2
    cat "$output" >&2
    exit 1
  }
  if grep -Eq 'ocid1\.|([0-9]{1,3}\.){3}[0-9]{1,3}' "$output"; then
    echo "fixture diagnostic leaked provider identity: $name" >&2
    exit 1
  fi
}

run_failure wrong-context '.context.kube_provenance=false' wrong-context
run_failure wrong-architecture '.node.architecture="amd64"' wrong-architecture
run_failure missing-workload 'del(.workloads[0])' workload-set
run_failure platform-digest '.platform_workloads[0].image="mutable"' platform-digest
run_failure empty-endpoint '.services[0].ready_endpoints=false' empty-endpoint
run_failure extra-mongo '.mongo.statefulset_count=2' extra-mongo
run_failure wrong-pvc-identity '.mongo.pvc_inventory[0].name="gaming-bet-mongo-data"' mongo-pvc-topology
run_failure extra-legacy-pvc '.mongo.pvc_inventory += [{"name":"gaming-bet-mongo-data-gaming-bet-mongo-depl-0","phase":"Bound"}]' mongo-pvc-topology
run_failure inventory-unbound-pvc '.mongo.pvc_inventory[0].phase="Pending"' mongo-pvc-topology
run_failure unbound-pvc '.mongo.pvc_bound=false' mongo-pvc-unbound
run_failure mongo-version '.mongo.version="7.0.21"|.mongo.major_minor="7.0"' mongo-version
run_failure mongo-fcv '.mongo.fcv="8.0"' mongo-fcv
run_failure digest-mismatch '.pods[0].digest_match=false' digest-mismatch
run_failure restart-increase '.pods[0].restarts=1' restart-increase
run_failure oom-kill '.pods[0].last_reason="OOMKilled"' pod-failure-reason
run_failure node-pressure '.node.memory_pressure=true' node-pressure
run_failure invalid-api-json '.application.api_json=false' api-json
run_failure certificate-failure '.ingress.certificate_ready=false' certificate
run_failure canonical-certificate-failure '.ingress.canonical_certificate_ready=false' canonical-certificate
run_failure diagnostic-certificate-failure '.ingress.diagnostic_certificate_ready=false' diagnostic-certificate
run_failure cluster-issuer-failure '.ingress.cluster_issuer_ready=false' cluster-issuer
run_failure www-redirect-failure '.ingress.www_redirect=false' www-redirect
run_failure diagnostic-https-failure '.ingress.diagnostic_https_trusted=false' diagnostic-https
run_failure canonical-dns-failure '.ingress.dns_match=false' canonical-dns
run_failure queue-loss '.rabbitmq.queue_count=21' queue-count
run_failure consumer-loss '.rabbitmq.all_consumers=false' queue-consumers
run_failure resource-breach '.node.memory_percent=71' memory-threshold
run_failure wrong-lb-shape '.inventory.lb_shape="100Mbps"' lb-shape
run_failure wrong-lb-bandwidth '.inventory.lb_max_mbps=20' lb-bandwidth

jq '
  .context.runtime_mode="k3s" |
  .ingress.load_balancer_service_count=1
' "$HEALTHY" > "$WORK_DIR/k3s-load-balancer-service.json"
if OCI_HEALTH_FIXTURE_FILE="$WORK_DIR/k3s-load-balancer-service.json" \
    "$HEALTH" >"$WORK_DIR/k3s-load-balancer-service.out" 2>&1; then
  echo "k3s LoadBalancer service fixture unexpectedly passed" >&2
  exit 1
fi
grep -Fq 'code=load-balancer-count' "$WORK_DIR/k3s-load-balancer-service.out"

cat > "$WORK_DIR/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
output=/dev/null
headers=/dev/null
url=""
method=GET
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    --write-out) shift 2 ;;
    --max-time) shift 2 ;;
    --request) method="$2"; shift 2 ;;
    --header|--data) shift 2 ;;
    --silent|--show-error|--fail) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$method" == "POST" && "${STUB_MUTATION_FENCE:-0}" == "1" ]]; then
  printf 'HTTP/2 503\r\ncontent-type: text/html\r\n\r\n' > "$headers"
  printf 'maintenance' > "$output"
  printf '503'
elif [[ "$url" == http://betstan.xyz/* ]]; then
  location="https://betstan.xyz/${url#http://betstan.xyz/}"
  printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: %s\r\n\r\n' "$location" > "$headers"
  : > "$output"
  printf '308'
elif [[ "$url" == http://www.betstan.xyz/* || "$url" == https://www.betstan.xyz/* ]]; then
  path="${url#*://www.betstan.xyz/}"
  if [[ "${STUB_BAD_REDIRECT:-0}" == "1" ]]; then
    printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://www.betstan.xyz/%s\r\n\r\n' "$path" > "$headers"
  else
    printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://betstan.xyz/%s\r\n\r\n' "$path" > "$headers"
  fi
  : > "$output"
  printf '308'
elif [[ "$url" == http://203.0.113.10.nip.io/* ]]; then
  location="https://203.0.113.10.nip.io/${url#http://203.0.113.10.nip.io/}"
  printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: %s\r\n\r\n' "$location" > "$headers"
  : > "$output"
  printf '308'
elif [[ "$url" == */api/* ]]; then
  printf 'HTTP/2 200\r\ncontent-type: application/json\r\n\r\n' > "$headers"
  if [[ "${STUB_BAD_API:-0}" == "1" && "$url" == */api/auth/currentuser ]]; then
    printf '<html>wrong route</html>' > "$output"
  elif [[ "$url" == */api/auth/currentuser ]]; then
    printf '{"currentUser":null}' > "$output"
  else
    printf '[]' > "$output"
  fi
  printf '200'
else
  printf 'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' > "$headers"
  printf 'BetStan.xyz demo app' > "$output"
  printf '200'
fi
STUB
chmod +x "$WORK_DIR/bin/curl"

cat > "$WORK_DIR/bin/dig" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
record_type="${2:-}"
if [[ "$record_type" == "A" ]]; then
  if [[ "${STUB_BAD_DNS:-0}" == "1" ]]; then
    printf '198.51.100.20\n'
  else
    printf '203.0.113.10\n'
  fi
elif [[ "$record_type" == "AAAA" && "${STUB_AAAA:-0}" == "1" ]]; then
  printf '2001:db8::10\n'
fi
STUB
chmod +x "$WORK_DIR/bin/dig"

cat > "$WORK_DIR/bin/openssl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
operation="${1:-}"
shift || true
case "$operation" in
  s_client)
    [[ "${STUB_UNTRUSTED_CERT:-0}" != "1" ]] || exit 1
    printf '%s\n' 'fixture-certificate'
    ;;
  x509)
    output=""
    mode=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -out) output="$2"; shift 2 ;;
        -issuer|-text|-checkend) mode="$1"; shift ;;
        -in) shift 2 ;;
        -noout) shift ;;
        *) shift ;;
      esac
    done
    case "$mode" in
      -issuer)
        if [[ "${STUB_WRONG_ISSUER:-0}" == "1" ]]; then
          printf '%s\n' 'issuer=O = Fixture CA'
        else
          printf '%s\n' "issuer=C = US, O = Let's Encrypt, CN = R12"
        fi
        ;;
      -text)
        if [[ "${STUB_WRONG_SAN:-0}" == "1" ]]; then
          printf '%s\n' 'X509v3 Subject Alternative Name: DNS:wrong.example'
        else
          printf '%s\n' \
            'X509v3 Subject Alternative Name: DNS:betstan.xyz, DNS:www.betstan.xyz, DNS:203.0.113.10.nip.io'
        fi
        ;;
      -checkend)
        [[ "${STUB_EXPIRING_CERT:-0}" != "1" ]]
        ;;
      *)
        [[ -n "$output" ]] || exit 1
        cat > "$output"
        ;;
    esac
    ;;
  *)
    exit 1
    ;;
esac
STUB
chmod +x "$WORK_DIR/bin/openssl"

PATH="$WORK_DIR/bin:$PATH" \
  OCI_PUBLIC_URL=https://betstan.xyz \
  OCI_REDIRECT_URL=https://www.betstan.xyz \
  OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
  OUTPUT_DIR="$WORK_DIR/smoke-good" "$OCI_DIR/agents/smoke-liveness-stan.sh" >/dev/null
PATH="$WORK_DIR/bin:$PATH" \
STUB_MUTATION_FENCE=1 \
OCI_EXPECT_HTTP_MUTATION_FENCE=1 \
OCI_PUBLIC_URL=https://betstan.xyz \
OCI_REDIRECT_URL=https://www.betstan.xyz \
OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
OUTPUT_DIR="$WORK_DIR/smoke-fenced" \
  "$OCI_DIR/agents/smoke-liveness-stan.sh" >/dev/null
if PATH="$WORK_DIR/bin:$PATH" \
    OCI_EXPECT_HTTP_MUTATION_FENCE=1 \
    OCI_PUBLIC_URL=https://betstan.xyz \
    OCI_REDIRECT_URL=https://www.betstan.xyz \
    OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
    OUTPUT_DIR="$WORK_DIR/smoke-unfenced" \
    "$OCI_DIR/agents/smoke-liveness-stan.sh" \
    >"$WORK_DIR/smoke-unfenced.out" 2>&1; then
  echo "missing HTTP mutation fence unexpectedly passed" >&2
  exit 1
fi
grep -Fq 'mutating request bypassed the HTTP maintenance fence' \
  "$WORK_DIR/smoke-unfenced.out"
if PATH="$WORK_DIR/bin:$PATH" STUB_BAD_API=1 \
  OCI_PUBLIC_URL=https://betstan.xyz \
  OCI_REDIRECT_URL=https://www.betstan.xyz \
  OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
  OUTPUT_DIR="$WORK_DIR/smoke-bad" "$OCI_DIR/agents/smoke-liveness-stan.sh" \
  >"$WORK_DIR/smoke-bad.out" 2>&1; then
  echo "invalid API command stub unexpectedly passed" >&2
  exit 1
fi
grep -Eq 'API returned (non-JSON content|invalid JSON)' "$WORK_DIR/smoke-bad.out"
for failure_mode in \
  STUB_BAD_DNS STUB_AAAA STUB_BAD_REDIRECT STUB_UNTRUSTED_CERT \
  STUB_WRONG_ISSUER STUB_WRONG_SAN STUB_EXPIRING_CERT; do
  if env PATH="$WORK_DIR/bin:$PATH" "$failure_mode=1" \
      OCI_PUBLIC_URL=https://betstan.xyz \
      OCI_REDIRECT_URL=https://www.betstan.xyz \
      OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
      OUTPUT_DIR="$WORK_DIR/smoke-${failure_mode}" \
      "$OCI_DIR/agents/smoke-liveness-stan.sh" >/dev/null 2>&1; then
    echo "$failure_mode unexpectedly passed canonical smoke validation" >&2
    exit 1
  fi
done

cat > "$WORK_DIR/bin/playwright" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'playwright-ran\n' >> "${STUB_PLAYWRIGHT_LOG:?}"
printf 'legacy-admin-ui=%s\n' "${OCI_ALLOW_LEGACY_ADMIN_UI:?}" \
  >> "${STUB_PLAYWRIGHT_LOG:?}"
STUB
chmod +x "$WORK_DIR/bin/playwright"
: > "$WORK_DIR/playwright.log"

OCI_HEALTH_FIXTURE_FILE="$HEALTHY" \
OCI_PUBLIC_URL=https://betstan.xyz \
OCI_REDIRECT_URL=https://www.betstan.xyz \
OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
OCI_PUBLIC_CHECKS_ALREADY_PASSED=1 \
OCI_E2E_ALREADY_PASSED=1 \
MAX_LOOPS=1 \
SLEEP_SECONDS=1 \
OUTPUT_DIR="$WORK_DIR/cluster-only" \
  "$OCI_DIR/agents/validation-loop-stan.sh" |
  grep -q 'oci_validation_loop=PASS'
[[ ! -s "$WORK_DIR/playwright.log" ]] ||
  { echo "cluster-only validation executed browser code" >&2; exit 1; }

PATH="$WORK_DIR/bin:$PATH" \
PLAYWRIGHT_BIN="$WORK_DIR/bin/playwright" \
STUB_PLAYWRIGHT_LOG="$WORK_DIR/playwright.log" \
OCI_PUBLIC_URL=https://betstan.xyz \
OCI_REDIRECT_URL=https://www.betstan.xyz \
OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
OCI_CLUSTER_CHECKS_ALREADY_PASSED=1 \
MAX_LOOPS=1 \
SLEEP_SECONDS=1 \
OUTPUT_DIR="$WORK_DIR/public-only" \
  "$OCI_DIR/agents/validation-loop-stan.sh" |
  grep -q 'oci_validation_loop=PASS'
grep -Fq 'playwright-ran' "$WORK_DIR/playwright.log" ||
  { echo "public-only validation skipped browser checks" >&2; exit 1; }
grep -Fq 'legacy-admin-ui=0' "$WORK_DIR/playwright.log" ||
  { echo "public validation did not default to strict admin UI checks" >&2; exit 1; }
: > "$WORK_DIR/playwright.log"
PATH="$WORK_DIR/bin:$PATH" \
PLAYWRIGHT_BIN="$WORK_DIR/bin/playwright" \
STUB_PLAYWRIGHT_LOG="$WORK_DIR/playwright.log" \
OCI_PUBLIC_URL=https://betstan.xyz \
OCI_REDIRECT_URL=https://www.betstan.xyz \
OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
OCI_CLUSTER_CHECKS_ALREADY_PASSED=1 \
OCI_ALLOW_LEGACY_ADMIN_UI=1 \
MAX_LOOPS=1 \
SLEEP_SECONDS=1 \
OUTPUT_DIR="$WORK_DIR/legacy-public" \
  "$OCI_DIR/agents/validation-loop-stan.sh" |
  grep -q 'oci_validation_loop=PASS'
grep -Fq 'legacy-admin-ui=1' "$WORK_DIR/playwright.log" ||
  { echo "historical recovery UI control did not reach browser checks" >&2; exit 1; }

if OCI_PUBLIC_URL=https://betstan.xyz \
    OCI_REDIRECT_URL=https://www.betstan.xyz \
    OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
    OCI_PUBLIC_CHECKS_ALREADY_PASSED=1 \
    OCI_E2E_ALREADY_PASSED=1 \
    OCI_CLUSTER_CHECKS_ALREADY_PASSED=1 \
    MAX_LOOPS=1 \
    SLEEP_SECONDS=1 \
      "$OCI_DIR/agents/validation-loop-stan.sh" >/dev/null 2>&1; then
  echo "validation loop accepted skipping both public and cluster checks" >&2
  exit 1
fi
if OCI_ALLOW_LEGACY_ADMIN_UI=unexpected \
    OCI_PUBLIC_URL=https://betstan.xyz \
    OCI_REDIRECT_URL=https://www.betstan.xyz \
    OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
    MAX_LOOPS=1 \
    SLEEP_SECONDS=1 \
      "$OCI_DIR/agents/validation-loop-stan.sh" >/dev/null 2>&1; then
  echo "validation loop accepted an invalid legacy admin UI control" >&2
  exit 1
fi

echo "oci_health_fixture_contract=PASS scenarios=42"
