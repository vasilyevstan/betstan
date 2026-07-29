#!/usr/bin/env bash
set -euo pipefail

# Purpose: inspect AKS node-level health and gather warning/error signals.
# Usage examples:
#   ./infra/azure/agents/node-logs-stan.sh
#   NODE=aks-nodepool1-12345678-vmss000001 ./infra/azure/agents/node-logs-stan.sh
#   NAMESPACE=default ./infra/azure/agents/node-logs-stan.sh

NODE="${NODE:-}"
NAMESPACE="${NAMESPACE:-default}"
SINCE="${SINCE:-30m}"

echo "=== nodes ==="
kubectl get nodes -o wide

if [[ -n "$NODE" ]]; then
  echo "=== describe node: $NODE ==="
  kubectl describe node "$NODE"
fi

echo "=== warning events (last 100) ==="
kubectl get events -A --sort-by=.lastTimestamp 2>/dev/null | grep -E 'Warning|Failed|Error' | tail -n 100 || true

if [[ -n "$NODE" ]]; then
  echo "=== pods on node: $NODE (namespace=$NAMESPACE) ==="
  kubectl get pods -n "$NAMESPACE" -o wide --field-selector "spec.nodeName=$NODE"
fi

echo "=== restarting pods (namespace=$NAMESPACE) ==="
kubectl get pods -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.containerStatuses[*]}{.restartCount}{" "}{end}{"\n"}{end}' \
  | awk '{sum=0; for(i=2;i<=NF;i++) sum+=$i; if(sum>0) print $1 "\t" sum}'

echo "=== recent error logs (namespace=$NAMESPACE, since=$SINCE) ==="
for pod in $(kubectl get pods -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}'); do
  if kubectl logs -n "$NAMESPACE" "$pod" --since="$SINCE" 2>/dev/null | grep -Eiq 'error|exception|failed|panic'; then
    echo "--- $pod ---"
    kubectl logs -n "$NAMESPACE" "$pod" --since="$SINCE" 2>/dev/null | grep -Ei 'error|exception|failed|panic' | tail -n 40
  fi
done
