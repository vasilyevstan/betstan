#!/usr/bin/env bash
set -euo pipefail

# Purpose: validate deployed stack and loop with remediation hints until healthy.
# Usage:
#   E2E_BASE_URL=http://48.206.235.122 ./infra/azure/agents/validation-loop-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MAX_LOOPS="${MAX_LOOPS:-6}"
SLEEP_SECONDS="${SLEEP_SECONDS:-20}"
DOMAIN="${DOMAIN:-www.betstan.xyz}"
E2E_BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:3000}"

check_nodes_ready() {
  local total ready
  total="$(kubectl get nodes --no-headers | wc -l | tr -d ' ')"
  ready="$(kubectl get nodes --no-headers | awk '$2=="Ready"{c++} END{print c+0}')"
  [[ "$total" -gt 0 && "$total" -eq "$ready" ]]
}

check_default_pods_ready() {
  local bad
  bad="$(kubectl get pods -n default --no-headers | awk '
    {
      split($2, a, "/");
      if ($3 != "Running" || a[1] != a[2]) bad++
    }
    END {print bad+0}
  ')"
  [[ "$bad" -eq 0 ]]
}

check_https_domain() {
  curl -sS -I --max-time 20 "https://${DOMAIN}" >/dev/null 2>&1
}

check_certificate_ready() {
  local ready
  ready="$(kubectl get certificate -n default betstan-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  [[ "$ready" == "True" ]]
}

run_e2e() {
  (cd "$ROOT_DIR/client" && E2E_BASE_URL="$E2E_BASE_URL" npx playwright test --config=playwright.config.js)
}

for i in $(seq 1 "$MAX_LOOPS"); do
  echo "=== validation-loop iteration $i/$MAX_LOOPS ==="

  if ! check_nodes_ready; then
    echo "nodes not fully ready"
    kubectl get nodes
    sleep "$SLEEP_SECONDS"
    continue
  fi

  if ! check_default_pods_ready; then
    echo "default namespace has non-ready pods"
    kubectl get pods -n default
    sleep "$SLEEP_SECONDS"
    continue
  fi

  if ! check_certificate_ready; then
    echo "certificate betstan-tls is not ready"
    kubectl get certificate,order,challenge -n default
    sleep "$SLEEP_SECONDS"
    continue
  fi

  if ! check_https_domain; then
    echo "https endpoint for ${DOMAIN} is not reachable yet"
    sleep "$SLEEP_SECONDS"
    continue
  fi

  if ! run_e2e; then
    echo "e2e suite failed"
    sleep "$SLEEP_SECONDS"
    continue
  fi

  echo "validation-loop status=PASS"
  exit 0
done

echo "validation-loop status=FAILED"
exit 1

