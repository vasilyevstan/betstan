#!/usr/bin/env bash
set -euo pipefail

# Purpose: run reusable service health checks for AKS-backed services.
# Usage examples:
#   ./infra/azure/agents/health-check-stan.sh
#   SERVICE=gamemaster ./infra/azure/agents/health-check-stan.sh
#   SERVICES=auth,bet,backoffice,event,gamemaster,moderation,resulting,slip ./infra/azure/agents/health-check-stan.sh
#   SERVICE=gamemaster SSH_ENABLED=1 SSH_USER=azureuser ./infra/azure/agents/health-check-stan.sh

NAMESPACE="${NAMESPACE:-default}"
SINCE="${SINCE:-30m}"
AKS_RG="${AKS_RG:-betstan-rg}"
AKS_NAME="${AKS_NAME:-betstan-aks}"
SERVICE="${SERVICE:-}"
SERVICES="${SERVICES:-}"
SSH_ENABLED="${SSH_ENABLED:-0}"
SSH_USER="${SSH_USER:-}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"
SSH_PRIVATE_KEY="${SSH_PRIVATE_KEY:-}"
SSH_EXTRA_ARGS="${SSH_EXTRA_ARGS:-}"

default_services=(auth bet backoffice event gamemaster moderation resulting slip)
tmp_ssh_key=""

cleanup() {
  if [[ -n "$tmp_ssh_key" && -f "$tmp_ssh_key" ]]; then
    rm -f "$tmp_ssh_key"
  fi
  return 0
}
trap cleanup EXIT

log() {
  printf '%s\n' "$*"
}

section() {
  printf '\n=== %s ===\n' "$1"
}

service_app_label() {
  printf 'gaming-%s' "$1"
}

service_deployment() {
  printf 'gaming-%s-depl' "$1"
}

service_svc() {
  printf 'gaming-%s-srv' "$1"
}

unique_nodes_from_pods() {
  kubectl get pods -n "$NAMESPACE" -l "$1" -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' \
    | awk 'NF && !seen[$0]++'
}

describe_service() {
  local service="$1"
  local app_label deployment svc_name
  local service_failed=0
  app_label="$(service_app_label "$service")"
  deployment="$(service_deployment "$service")"
  svc_name="$(service_svc "$service")"

  section "service=$service namespace=$NAMESPACE"
  log "app_label=$app_label deployment=$deployment service=$svc_name"

  section "deployment"
  if ! kubectl get deploy "$deployment" -n "$NAMESPACE" -o wide; then
    log "deployment_missing=1"
    service_failed=1
  fi

  if ! kubectl rollout status deploy/"$deployment" -n "$NAMESPACE" --timeout=30s; then
    log "rollout_status=unavailable"
    service_failed=1
  fi

  section "service + endpoints"
  kubectl get svc "$svc_name" -n "$NAMESPACE" -o wide || { log "service_missing=1"; service_failed=1; }
  kubectl get endpoints "$svc_name" -n "$NAMESPACE" -o wide || { log "endpoints_missing=1"; service_failed=1; }

  section "pods"
  if ! kubectl get pods -n "$NAMESPACE" -l "app=$app_label" -o wide; then
    log "pod_list_failed=1"
    service_failed=1
  fi

  section "pod readiness and restarts"
  if kubectl get pods -n "$NAMESPACE" -l "app=$app_label" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeName}{"\t"}{.status.phase}{"\t"}{range .status.containerStatuses[*]}{.restartCount}{" "}{end}{"\n"}{end}' \
    | awk 'BEGIN{fail=0} {sum=0; for(i=4;i<=NF;i++) sum+=$i; printf "%s\tnode=%s\tphase=%s\trestarts=%s\n", $1, $2, $3, sum; if($3!="Running" || sum>0) fail=1} END{exit fail}'; then
    :
  else
    log "pod_readiness_failed=1"
    service_failed=1
  fi

  section "recent error logs (since=$SINCE)"
  local pod
  while IFS= read -r pod; do
    [[ -z "$pod" ]] && continue
    if kubectl logs -n "$NAMESPACE" "$pod" --since="$SINCE" 2>/dev/null | grep -Eiq 'error|exception|failed|panic|throw'; then
      log "--- $pod ---"
      kubectl logs -n "$NAMESPACE" "$pod" --since="$SINCE" 2>/dev/null | grep -Ei 'error|exception|failed|panic|throw' | tail -n 50
    fi
    if kubectl get pod -n "$NAMESPACE" "$pod" -o jsonpath='{range .status.containerStatuses[*]}{.restartCount}{"\n"}{end}' 2>/dev/null | awk 'BEGIN{sum=0} {sum+=$1} END{exit !(sum>0)}'; then
      log "--- $pod previous logs (restart detected) ---"
      kubectl logs -n "$NAMESPACE" "$pod" --previous --since="$SINCE" 2>/dev/null | tail -n 50 || true
    fi
  done < <(kubectl get pods -n "$NAMESPACE" -l "app=$app_label" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')

  section "node diagnostics"
  local node
  while IFS= read -r node; do
    [[ -z "$node" ]] && continue
    log "--- node=$node ---"
    kubectl describe node "$node" | sed -n '1,120p'
    if kubectl top node "$node" >/dev/null 2>&1; then
      kubectl top node "$node" || true
    fi
    if [[ "$SSH_ENABLED" == "1" ]]; then
      run_ssh_node_diagnostics "$node" || log "ssh_diagnostics_failed node=$node"
    fi
  done < <(unique_nodes_from_pods "app=$app_label")

  return "$service_failed"
}

run_ssh_node_diagnostics() {
  local node="$1"
  local node_ip
  node_ip="$(kubectl get node "$node" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')"
  if [[ -z "$node_ip" ]]; then
    log "ssh_skip=node_ip_missing node=$node"
    return 1
  fi
  if [[ -z "$SSH_USER" && -z "$SSH_KEY_PATH" && -z "$SSH_PRIVATE_KEY" ]]; then
    log "ssh_skip=missing_credentials node=$node ip=$node_ip"
    return 1
  fi

  section "ssh node diagnostics (node=$node ip=$node_ip)"
  local ssh_cmd=(ssh -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no)
  if [[ -n "$SSH_KEY_PATH" ]]; then
    ssh_cmd+=(-i "$SSH_KEY_PATH")
  elif [[ -n "$SSH_PRIVATE_KEY" ]]; then
    tmp_ssh_key="$(mktemp)"
    chmod 600 "$tmp_ssh_key"
    printf '%s\n' "$SSH_PRIVATE_KEY" > "$tmp_ssh_key"
    ssh_cmd+=(-i "$tmp_ssh_key")
  fi
  if [[ -n "$SSH_EXTRA_ARGS" ]]; then
    # shellcheck disable=SC2206
    ssh_cmd+=($SSH_EXTRA_ARGS)
  fi
  ssh_cmd+=("${SSH_USER}@${node_ip}")
  "${ssh_cmd[@]}" 'echo "hostname=$(hostname)"; uptime; sudo journalctl -u kubelet -n 60 --no-pager || journalctl -n 60 --no-pager'
}

if [[ -n "$SERVICES" ]]; then
  IFS=, read -r -a services <<< "$SERVICES"
elif [[ -n "$SERVICE" && "$SERVICE" != "all" ]]; then
  services=("$SERVICE")
else
  services=("${default_services[@]}")
fi

section "cluster summary"
az aks show -g "$AKS_RG" -n "$AKS_NAME" \
  --query '{provisioningState:provisioningState,powerState:powerState.code,nodeCount:agentPoolProfiles[0].count,vmSize:agentPoolProfiles[0].vmSize}' \
  -o table || true
kubectl get nodes -o wide

section "kubernetes context"
kubectl config current-context || true

overall_failure=0
for service in "${services[@]}"; do
  if ! describe_service "$service"; then
    overall_failure=1
  fi
done

if [[ "$overall_failure" -ne 0 ]]; then
  log "health_status=FAILED"
  exit 1
fi

log "health_status=OK"
