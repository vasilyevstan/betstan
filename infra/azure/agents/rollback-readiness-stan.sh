#!/usr/bin/env bash
set -euo pipefail

# Purpose: produce an explicit GO/NO_GO signal before rollback actions in production.
# Usage examples:
#   ./infra/azure/agents/rollback-readiness-stan.sh
#   TARGET_SHA=<sha> ./infra/azure/agents/rollback-readiness-stan.sh

REPO="${REPO:-vasilyevstan/betstan}"
NAMESPACE="${NAMESPACE:-default}"
HOSTS="${HOSTS:-www.betstan.xyz,betstan.xyz}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-20}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
MAX_MESSAGES_READY="${MAX_MESSAGES_READY:-200}"
MAX_MESSAGES_UNACK="${MAX_MESSAGES_UNACK:-200}"
MIN_ROLLOUT_REVISIONS="${MIN_ROLLOUT_REVISIONS:-2}"
TARGET_SHA="${TARGET_SHA:-}"

failures_file="$(mktemp)"
images_file="$(mktemp)"
tmp_files=("$failures_file" "$images_file")
add_tmp() {
  tmp_files+=("$1")
}
cleanup() {
  if [[ ${#tmp_files[@]} -gt 0 ]]; then
    rm -f "${tmp_files[@]}"
  fi
}
trap cleanup EXIT

add_failure() {
  printf '%s\n' "$*" >> "$failures_file"
}

for bin in gh kubectl curl awk python3; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    add_failure "required binary missing: $bin"
  fi
done

if [[ -s "$failures_file" ]]; then
  echo "rollback_readiness=NO_GO"
  echo "reasons:"
  cat "$failures_file"
  exit 1
fi

if [[ -n "$TARGET_SHA" ]] && ! [[ "$TARGET_SHA" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  add_failure "TARGET_SHA must be 7..40 hex characters"
fi

ready_nodes="$(kubectl get nodes --no-headers 2>/dev/null | awk '$2=="Ready"{c++} END{print c+0}' || echo 0)"
if [[ "$ready_nodes" -lt 1 ]]; then
  add_failure "no Ready AKS nodes detected"
fi

bad_deploys="$(kubectl get deploy -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.readyReplicas}{"\t"}{.status.replicas}{"\n"}{end}' | awk '$2 != $3' || true)"
if [[ -n "${bad_deploys:-}" ]]; then
  add_failure "unready deployments:\n$bad_deploys"
fi

bad_sts="$(kubectl get sts -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.readyReplicas}{"\t"}{.status.replicas}{"\n"}{end}' | awk '$2 != $3' || true)"
if [[ -n "${bad_sts:-}" ]]; then
  add_failure "unready statefulsets:\n$bad_sts"
fi

tmp_body="$(mktemp)"
add_tmp "$tmp_body"
for host in ${HOSTS//,/ }; do
  for path in /api/event /api/auth/currentuser; do
    code="$(curl -sS -m "$REQUEST_TIMEOUT" -o "$tmp_body" -w '%{http_code}' "https://${host}${path}" || true)"
    if [[ "$code" != "200" ]]; then
      add_failure "host=$host path=$path returned HTTP $code"
    fi
  done
done

rabbit_pod="$(kubectl get pod -n "$NAMESPACE" -l "$RABBIT_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$rabbit_pod" ]]; then
  add_failure "rabbitmq pod missing for selector: $RABBIT_SELECTOR"
else
  queue_dump="$(mktemp)"
  add_tmp "$queue_dump"
  if ! kubectl exec -n "$NAMESPACE" "$rabbit_pod" -- rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers > "$queue_dump"; then
    add_failure "unable to read RabbitMQ queues"
  else
    read -r total_ready total_unack <<<"$(awk 'NR>1 {ready+=$2; unack+=$3} END {print ready+0, unack+0}' "$queue_dump")"
    if [[ "$total_ready" -gt "$MAX_MESSAGES_READY" ]]; then
      add_failure "queue ready backlog too high: $total_ready > $MAX_MESSAGES_READY"
    fi
    if [[ "$total_unack" -gt "$MAX_MESSAGES_UNACK" ]]; then
      add_failure "queue unack backlog too high: $total_unack > $MAX_MESSAGES_UNACK"
    fi
  fi
fi

deploy_names="$(kubectl get deploy -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' || true)"
for d in $deploy_names; do
  rev_count="$(kubectl rollout history "deploy/${d}" -n "$NAMESPACE" 2>/dev/null | awk '/^[0-9]+/ {c++} END{print c+0}')"
  if [[ "$rev_count" -lt "$MIN_ROLLOUT_REVISIONS" ]]; then
    add_failure "deployment $d has only $rev_count rollout revision(s)"
  fi
done

kubectl get deploy -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.template.spec.containers[*]}{.image}{" "}{end}{"\n"}{end}' > "$images_file" || true

if [[ -n "$TARGET_SHA" ]]; then
  for workflow in build-push deploy-manifests; do
    wf_json="$(mktemp)"
    add_tmp "$wf_json"
    gh run list --repo "$REPO" --workflow "$workflow" --commit "$TARGET_SHA" --limit 1 --json status,conclusion > "$wf_json" || true
    read -r wf_status wf_conclusion <<<"$(python3 - "$wf_json" <<'PY'
import json,sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
  raw=fh.read().strip()
runs=json.loads(raw) if raw else []
if not runs:
  print("", "")
else:
  run=runs[0]
  print(run.get("status",""), run.get("conclusion",""))
PY
)"
    if [[ "$wf_status" != "completed" || "$wf_conclusion" != "success" ]]; then
      add_failure "target sha $TARGET_SHA lacks successful $workflow run"
    fi
    rm -f "$wf_json"
  done
fi

echo "=== running images ==="
cat "$images_file"

if [[ -s "$failures_file" ]]; then
  echo "rollback_readiness=NO_GO"
  echo "reasons:"
  cat "$failures_file"
  exit 1
fi

echo "rollback_readiness=GO"
