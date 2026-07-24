#!/usr/bin/env bash
set -euo pipefail

# Purpose: determine service operational status and collect targeted pod diagnostics.
# Usage examples:
#   ./infra/azure/agents/service-ops-stan.sh
#   SELECTOR=app=gaming-auth ./infra/azure/agents/service-ops-stan.sh
#   NAMESPACE=default SINCE=20m ./infra/azure/agents/service-ops-stan.sh

NAMESPACE="${NAMESPACE:-default}"
SELECTOR="${SELECTOR:-}"
SINCE="${SINCE:-30m}"

selector_args=()
if [[ -n "$SELECTOR" ]]; then
  selector_args=(-l "$SELECTOR")
fi

run_kubectl_get() {
  if [[ -n "$SELECTOR" ]]; then
    kubectl get "$1" -n "$NAMESPACE" -l "$SELECTOR" "${@:2}"
  else
    kubectl get "$1" -n "$NAMESPACE" "${@:2}"
  fi
}

echo "=== deployments (namespace=$NAMESPACE) ==="
run_kubectl_get deploy

echo "=== statefulsets (namespace=$NAMESPACE) ==="
run_kubectl_get sts || true

echo "=== pods (namespace=$NAMESPACE) ==="
run_kubectl_get pods -o wide

echo "=== services and endpoints (namespace=$NAMESPACE) ==="
run_kubectl_get svc || true
run_kubectl_get endpoints || true

echo "=== unavailable/failed pods ==="
run_kubectl_get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{range .status.conditions[*]}{.type}={.status}{" "}{end}{"\n"}{end}' \
  | awk '$2!="Running" {print}'

echo "=== restart counts ==="
run_kubectl_get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.containerStatuses[*]}{.restartCount}{" "}{end}{"\n"}{end}' \
  | awk '{sum=0; for(i=2;i<=NF;i++) sum+=$i; print $1 "\t" sum}'

echo "=== recent error logs (since=$SINCE) ==="
for pod in $(run_kubectl_get pods -o jsonpath='{.items[*].metadata.name}'); do
  if kubectl logs -n "$NAMESPACE" "$pod" --since="$SINCE" 2>/dev/null | grep -Eiq 'error|exception|failed|panic'; then
    echo "--- $pod ---"
    kubectl logs -n "$NAMESPACE" "$pod" --since="$SINCE" 2>/dev/null | grep -Ei 'error|exception|failed|panic' | tail -n 50
  fi
done
