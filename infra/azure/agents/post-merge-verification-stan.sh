#!/usr/bin/env bash
set -euo pipefail

# Purpose: verify merged-to-master rollout health before declaring production safe.
# Usage examples:
#   PR=50 ./infra/azure/agents/post-merge-verification-stan.sh
#   MERGE_SHA=<merge-commit-sha> ./infra/azure/agents/post-merge-verification-stan.sh

REPO="${REPO:-vasilyevstan/betstan}"
PR_NUMBER="${1:-${PR:-}}"
MERGE_SHA="${MERGE_SHA:-}"
NAMESPACE="${NAMESPACE:-default}"
WORKFLOWS="${WORKFLOWS:-build-push,deploy-manifests}"
HOSTS="${HOSTS:-www.betstan.xyz,betstan.xyz}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-20}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
REQUIRED_QUEUES="${REQUIRED_QUEUES:-event_new_event,gamemaster_new_event,event_result,bet_place_bet}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

tmp_files=()
add_tmp() {
  tmp_files+=("$1")
}
cleanup() {
  if [[ ${#tmp_files[@]} -gt 0 ]]; then
    rm -f "${tmp_files[@]}"
  fi
}
trap cleanup EXIT

for bin in gh kubectl curl python3; do
  command -v "$bin" >/dev/null 2>&1 || fail "required binary not found: $bin"
done

if [[ -z "$MERGE_SHA" ]]; then
  [[ -n "$PR_NUMBER" ]] || fail "set PR=<number> or MERGE_SHA=<sha>"
  pr_json="$(mktemp)"
  add_tmp "$pr_json"
  gh pr view "$PR_NUMBER" --repo "$REPO" --json state,mergedAt,mergeCommit > "$pr_json"
  read -r pr_state pr_merged_at merge_sha_from_pr <<<"$(python3 - "$pr_json" <<'PY'
import json,sys
obj=json.load(open(sys.argv[1]))
merge=obj.get("mergeCommit") or {}
print((obj.get("state") or ""), (obj.get("mergedAt") or ""), (merge.get("oid") or ""))
PY
)"
  [[ "$pr_state" == "MERGED" ]] || fail "PR #$PR_NUMBER is not merged"
  [[ -n "$pr_merged_at" ]] || fail "PR #$PR_NUMBER mergedAt is empty"
  [[ -n "$merge_sha_from_pr" ]] || fail "PR #$PR_NUMBER merge commit is missing"
  MERGE_SHA="$merge_sha_from_pr"
fi

echo "merge_sha=$MERGE_SHA"

for workflow in ${WORKFLOWS//,/ }; do
  run_json="$(mktemp)"
  add_tmp "$run_json"
  gh run list --repo "$REPO" --workflow "$workflow" --commit "$MERGE_SHA" --limit 1 --json databaseId,status,conclusion,url > "$run_json"
  read -r run_id run_status run_conclusion run_url <<<"$(python3 - "$run_json" <<'PY'
import json,sys
runs=json.load(open(sys.argv[1]))
if not runs:
  print("", "", "", "")
else:
  run=runs[0]
  print(run.get("databaseId",""), run.get("status",""), run.get("conclusion",""), run.get("url",""))
PY
)"
  [[ -n "$run_id" ]] || fail "workflow '$workflow' not found for commit $MERGE_SHA"
  [[ "$run_status" == "completed" ]] || fail "workflow '$workflow' status is $run_status"
  [[ "$run_conclusion" == "success" ]] || fail "workflow '$workflow' conclusion is $run_conclusion"
  echo "workflow_ok=$workflow run_id=$run_id url=$run_url"
done

echo "=== workload readiness ==="
kubectl get deploy -n "$NAMESPACE"
kubectl get sts -n "$NAMESPACE"

bad_deploys="$(kubectl get deploy -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.readyReplicas}{"\t"}{.status.replicas}{"\n"}{end}' | awk '$2 != $3')"
[[ -z "$bad_deploys" ]] || fail "unready deployments:\n$bad_deploys"

bad_sts="$(kubectl get sts -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.readyReplicas}{"\t"}{.status.replicas}{"\n"}{end}' | awk '$2 != $3')"
[[ -z "$bad_sts" ]] || fail "unready statefulsets:\n$bad_sts"

tmp_body="$(mktemp)"
add_tmp "$tmp_body"
for host in ${HOSTS//,/ }; do
  for path in /api/event /api/auth/currentuser; do
    code="$(curl -sS -m "$REQUEST_TIMEOUT" -o "$tmp_body" -w '%{http_code}' "https://${host}${path}" || true)"
    [[ "$code" == "200" ]] || fail "host=$host path=$path returned HTTP $code"
    if [[ "$path" == "/api/auth/currentuser" ]]; then
      grep -q "currentUser" "$tmp_body" || fail "host=$host path=$path missing currentUser field"
    else
      first_char="$(head -c 1 "$tmp_body" || true)"
      [[ "$first_char" == "[" ]] || fail "host=$host path=$path expected JSON array response"
    fi
    echo "api_ok host=$host path=$path code=$code"
  done
done

rabbit_pod="$(kubectl get pod -n "$NAMESPACE" -l "$RABBIT_SELECTOR" -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$rabbit_pod" ]] || fail "rabbitmq pod not found by selector: $RABBIT_SELECTOR"

queues_tmp="$(mktemp)"
add_tmp "$queues_tmp"
kubectl exec -n "$NAMESPACE" "$rabbit_pod" -- rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers > "$queues_tmp"
echo "=== queue snapshot ==="
cat "$queues_tmp"

for q in ${REQUIRED_QUEUES//,/ }; do
  line="$(awk -v q="$q" '$1==q {print $0}' "$queues_tmp")"
  [[ -n "$line" ]] || fail "required queue missing: $q"
  consumers="$(awk -v q="$q" '$1==q {print $4}' "$queues_tmp")"
  [[ "${consumers:-0}" -ge 1 ]] || fail "queue $q has no consumers"
done

echo "post_merge_verification_status=PASS"
