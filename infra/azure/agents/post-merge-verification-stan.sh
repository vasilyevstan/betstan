#!/usr/bin/env bash
set -euo pipefail

# Purpose: verify merged-to-master rollout health before declaring production safe.
# Usage examples:
#   PR=50 ./infra/azure/agents/post-merge-verification-stan.sh
#   ALLOW_SHA_ONLY=1 MERGE_SHA=<emergency-sha> ./infra/azure/agents/post-merge-verification-stan.sh

REPO="${REPO:-vasilyevstan/betstan}"
PR_NUMBER="${1:-${PR:-}}"
MERGE_SHA="${MERGE_SHA:-}"
NAMESPACE="${NAMESPACE:-default}"
HOSTS="${HOSTS:-www.betstan.xyz,betstan.xyz}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-20}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
REQUIRED_QUEUES="${REQUIRED_QUEUES:-event_new_event,gamemaster_new_event,event_result,bet_place_bet}"
ALLOW_SHA_ONLY="${ALLOW_SHA_ONLY:-0}"
PROVENANCE_SCRIPT="${PROVENANCE_SCRIPT:-infra/azure/agents/workflow-run-provenance-stan.sh}"

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
    rm -rf -- "${tmp_files[@]}"
  fi
}
trap cleanup EXIT

for bin in gh kubectl curl python3; do
  command -v "$bin" >/dev/null 2>&1 || fail "required binary not found: $bin"
done

if [[ -n "$PR_NUMBER" ]]; then
  pr_json="$(mktemp)"
  add_tmp "$pr_json"
  gh pr view "$PR_NUMBER" --repo "$REPO" \
    --json state,mergedAt,mergeCommit,baseRefName,headRefName > "$pr_json"
  read -r pr_state pr_merged_at merge_sha_from_pr base_ref head_ref <<<"$(python3 - "$pr_json" <<'PY'
import json,sys
obj=json.load(open(sys.argv[1]))
merge=obj.get("mergeCommit") or {}
print(
    (obj.get("state") or ""),
    (obj.get("mergedAt") or ""),
    (merge.get("oid") or ""),
    (obj.get("baseRefName") or ""),
    (obj.get("headRefName") or ""),
)
PY
)"
  [[ "$pr_state" == "MERGED" ]] || fail "PR #$PR_NUMBER is not merged"
  [[ -n "$pr_merged_at" ]] || fail "PR #$PR_NUMBER mergedAt is empty"
  [[ -n "$merge_sha_from_pr" ]] || fail "PR #$PR_NUMBER merge commit is missing"
  [[ "$base_ref" == "master" && "$head_ref" == "dev" ]] ||
    fail "PR #$PR_NUMBER was not a dev-to-master production promotion"
  if [[ -n "$MERGE_SHA" && "$MERGE_SHA" != "$merge_sha_from_pr" ]]; then
    fail "MERGE_SHA does not match PR #$PR_NUMBER"
  fi
  MERGE_SHA="$merge_sha_from_pr"
else
  [[ -n "$MERGE_SHA" ]] || fail "set PR=<number> or MERGE_SHA=<sha>"
  [[ "$ALLOW_SHA_ONLY" == "1" ]] ||
    fail "SHA-only verification is emergency-only; set ALLOW_SHA_ONLY=1 explicitly"
fi

echo "merge_sha=$MERGE_SHA"

[[ -x "$PROVENANCE_SCRIPT" ]] || fail "provenance script is not executable: $PROVENANCE_SCRIPT"
if ! build_provenance="$(
  REPO="$REPO" WORKFLOW=production-build TARGET_SHA="$MERGE_SHA" \
    "$PROVENANCE_SCRIPT"
)"; then
  fail "production-build lacks successful first-attempt provenance for $MERGE_SHA"
fi
IFS=$'\t' read -r build_run_id build_status build_conclusion build_url <<<"$build_provenance"
echo "workflow_ok=production-build run_id=$build_run_id url=$build_url"

if ! deploy_provenance="$(
  REPO="$REPO" WORKFLOW=production-deploy TARGET_SHA="$MERGE_SHA" \
    "$PROVENANCE_SCRIPT"
)"; then
  fail "production-deploy lacks successful first-attempt provenance for $MERGE_SHA"
fi
IFS=$'\t' read -r deploy_run_id deploy_status deploy_conclusion deploy_url <<<"$deploy_provenance"
echo "workflow_ok=production-deploy run_id=$deploy_run_id url=$deploy_url"

provenance_dir="$(mktemp -d)"
add_tmp "$provenance_dir"
gh run download "$deploy_run_id" --repo "$REPO" \
  --name "deploy-provenance-${deploy_run_id}-1" --dir "$provenance_dir"
provenance_file="$provenance_dir/provenance.txt"
images_file="$provenance_dir/images.tsv"
[[ -f "$provenance_file" ]] || fail "deploy provenance artifact is missing"
[[ -f "$images_file" ]] || fail "deploy image provenance artifact is missing"
deployed_sha="$(sed -n 's/^image_sha=//p' "$provenance_file")"
upstream_run_id="$(sed -n 's/^upstream_run_id=//p' "$provenance_file")"
[[ "$deployed_sha" == "$MERGE_SHA" ]] ||
  fail "deploy provenance SHA $deployed_sha does not match expected $MERGE_SHA"
[[ "$upstream_run_id" == "$build_run_id" ]] ||
  fail "deploy run used upstream build $upstream_run_id, expected $build_run_id"
[[ "$(wc -l < "$images_file" | tr -d ' ')" == "9" ]] ||
  fail "deploy image provenance must contain exactly nine services"
echo "deploy_provenance=PASS image_sha=$deployed_sha upstream_run_id=$upstream_run_id"

NAMESPACE="$NAMESPACE" ./infra/azure/agents/shared-mongo-topology-guard-stan.sh

echo "=== workload readiness ==="
kubectl get deploy -n "$NAMESPACE"
kubectl get sts -n "$NAMESPACE"

bad_deploys="$(kubectl get deploy -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.readyReplicas}{"\t"}{.status.replicas}{"\n"}{end}' | awk '$2 != $3')"
[[ -z "$bad_deploys" ]] || fail "unready deployments:\n$bad_deploys"

bad_sts="$(kubectl get sts -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.readyReplicas}{"\t"}{.status.replicas}{"\n"}{end}' | awk '$2 != $3')"
[[ -z "$bad_sts" ]] || fail "unready statefulsets:\n$bad_sts"

while IFS=$'\t' read -r service _repository image_ref digest; do
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  deployed_ref="$(
    kubectl get deployment "$deployment" -n "$NAMESPACE" -o json |
      python3 -c '
import json
import sys

container = sys.argv[1]
document = json.load(sys.stdin)
matches = [
    item["image"]
    for item in document["spec"]["template"]["spec"]["containers"]
    if item["name"] == container
]
print(matches[0] if len(matches) == 1 else "")
' "$container"
  )"
  [[ "$deployed_ref" == "$image_ref" ]] ||
    fail "deployment $deployment uses $deployed_ref, expected $image_ref"

  pod_image_ids="$(
    kubectl get pods -n "$NAMESPACE" -l "app=${container}" \
      -o jsonpath='{range .items[*].status.containerStatuses[*]}{.name}{"\t"}{.ready}{"\t"}{.imageID}{"\n"}{end}'
  )"
  matching_pods=0
  while IFS=$'\t' read -r pod_container pod_ready image_id; do
    if [[ "$pod_container" == "$container" &&
      "$pod_ready" == "true" &&
      "$image_id" =~ @sha256:[0-9a-f]{64}$ ]]; then
      matching_pods=$((matching_pods + 1))
    fi
  done <<<"$pod_image_ids"
  [[ "$matching_pods" -ge 1 ]] ||
    fail "deployment $deployment has no ready pod with a content-addressed image ID"
  echo "image_ok deployment=$deployment ref=$image_ref"
done < "$images_file"

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
