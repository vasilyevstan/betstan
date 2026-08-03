#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
HEALTH="$OCI_DIR/agents/health-check-stan.sh"
HEALTHY="$OCI_DIR/tests/fixtures/health/healthy.json"
WORK_DIR="$OCI_DIR/tests/.health-fixture-work"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/bin"
trap 'rm -rf "$WORK_DIR"' EXIT

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
run_failure unbound-pvc '.mongo.pvc_bound=false' mongo-pvc-unbound
run_failure digest-mismatch '.pods[0].digest_match=false' digest-mismatch
run_failure restart-increase '.pods[0].restarts=1' restart-increase
run_failure oom-kill '.pods[0].last_reason="OOMKilled"' pod-failure-reason
run_failure node-pressure '.node.memory_pressure=true' node-pressure
run_failure invalid-api-json '.application.api_json=false' api-json
run_failure certificate-failure '.ingress.certificate_ready=false' certificate
run_failure queue-loss '.rabbitmq.queue_count=16' queue-count
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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    --write-out) shift 2 ;;
    --max-time) shift 2 ;;
    --silent|--show-error) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == http://* ]]; then
  printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://203.0.113.10.nip.io/\r\n\r\n' > "$headers"
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

PATH="$WORK_DIR/bin:$PATH" OCI_PUBLIC_URL=https://203.0.113.10.nip.io \
  OUTPUT_DIR="$WORK_DIR/smoke-good" "$OCI_DIR/agents/smoke-liveness-stan.sh" >/dev/null
if PATH="$WORK_DIR/bin:$PATH" STUB_BAD_API=1 \
  OCI_PUBLIC_URL=https://203.0.113.10.nip.io \
  OUTPUT_DIR="$WORK_DIR/smoke-bad" "$OCI_DIR/agents/smoke-liveness-stan.sh" \
  >"$WORK_DIR/smoke-bad.out" 2>&1; then
  echo "invalid API command stub unexpectedly passed" >&2
  exit 1
fi
grep -Eq 'API returned (non-JSON content|invalid JSON)' "$WORK_DIR/smoke-bad.out"

cat > "$WORK_DIR/bin/playwright" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'playwright-ran\n' >> "${STUB_PLAYWRIGHT_LOG:?}"
STUB
chmod +x "$WORK_DIR/bin/playwright"
: > "$WORK_DIR/playwright.log"

OCI_HEALTH_FIXTURE_FILE="$HEALTHY" \
OCI_PUBLIC_URL=https://203.0.113.10.nip.io \
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
OCI_PUBLIC_URL=https://203.0.113.10.nip.io \
OCI_CLUSTER_CHECKS_ALREADY_PASSED=1 \
MAX_LOOPS=1 \
SLEEP_SECONDS=1 \
OUTPUT_DIR="$WORK_DIR/public-only" \
  "$OCI_DIR/agents/validation-loop-stan.sh" |
  grep -q 'oci_validation_loop=PASS'
grep -Fq 'playwright-ran' "$WORK_DIR/playwright.log" ||
  { echo "public-only validation skipped browser checks" >&2; exit 1; }

if OCI_PUBLIC_URL=https://203.0.113.10.nip.io \
    OCI_PUBLIC_CHECKS_ALREADY_PASSED=1 \
    OCI_E2E_ALREADY_PASSED=1 \
    OCI_CLUSTER_CHECKS_ALREADY_PASSED=1 \
    MAX_LOOPS=1 \
    SLEEP_SECONDS=1 \
      "$OCI_DIR/agents/validation-loop-stan.sh" >/dev/null 2>&1; then
  echo "validation loop accepted skipping both public and cluster checks" >&2
  exit 1
fi

echo "oci_health_fixture_contract=PASS scenarios=25"
