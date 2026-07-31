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
AUTH_MONGO_SELECTOR="${AUTH_MONGO_SELECTOR:-app=gaming-auth-mongo}"
AUTH_DB_NAME="${AUTH_DB_NAME:-gaming_auth}"
AUTH_USER_COLLECTION="${AUTH_USER_COLLECTION:-users}"
AUTH_DEPLOYMENT="${AUTH_DEPLOYMENT:-gaming-auth-depl}"
AUTH_POD_SELECTOR="${AUTH_POD_SELECTOR:-app=gaming-auth}"
AUTH_CONTAINER="${AUTH_CONTAINER:-gaming-auth}"
AUTH_IMAGE_REPOSITORY="${AUTH_IMAGE_REPOSITORY:-stanvasilyev/gaming_auth}"
PROVENANCE_SCRIPT="${PROVENANCE_SCRIPT:-infra/azure/agents/workflow-run-provenance-stan.sh}"

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

for bin in gh git kubectl curl awk python3; do
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

target_sha_valid=true
if [[ -z "$TARGET_SHA" ]]; then
  add_failure "TARGET_SHA is required before rollback action"
  target_sha_valid=false
elif ! [[ "$TARGET_SHA" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  add_failure "TARGET_SHA must be 7..40 hex characters"
  target_sha_valid=false
fi

auth_names_valid=true
if ! [[ "$AUTH_DB_NAME" =~ ^[A-Za-z0-9_-]+$ ]] ||
  ! [[ "$AUTH_USER_COLLECTION" =~ ^[A-Za-z0-9_-]+$ ]]; then
  add_failure "auth database and collection names must contain only letters, numbers, underscores, or hyphens"
  auth_names_valid=false
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

if [[ -n "$TARGET_SHA" && "$target_sha_valid" == true && "$auth_names_valid" == true ]]; then
  target_sha_full="$(git rev-parse "${TARGET_SHA}^{commit}" 2>/dev/null || true)"
  target_login="$(git show "${TARGET_SHA}:auth/src/route/LogIn.ts" 2>/dev/null || true)"
  if [[ -z "$target_sha_full" || -z "$target_login" ]]; then
    add_failure "unable to inspect auth login compatibility at target sha $TARGET_SHA"
  elif ! grep -q "normalizeIdentifier" <<<"$target_login" ||
    ! grep -q "User.findOne({ identifierNormalized })" <<<"$target_login"; then
    auth_rollout_state="$(
      kubectl get deployment "$AUTH_DEPLOYMENT" -n "$NAMESPACE" -o jsonpath='{.metadata.generation}|{.status.observedGeneration}|{.spec.replicas}|{.status.updatedReplicas}|{.status.readyReplicas}|{.status.availableReplicas}' 2>/dev/null || true
    )"
    IFS='|' read -r auth_generation auth_observed auth_replicas auth_updated auth_ready auth_available <<<"$auth_rollout_state"
    auth_generation="${auth_generation:-0}"
    auth_observed="${auth_observed:-0}"
    auth_replicas="${auth_replicas:-0}"
    auth_updated="${auth_updated:-0}"
    auth_ready="${auth_ready:-0}"
    auth_available="${auth_available:-0}"

    auth_rollout_observed=true
    if [[ "$auth_generation" -eq 0 ||
      "$auth_observed" -lt "$auth_generation" ||
      "$auth_updated" -ne "$auth_replicas" ||
      "$auth_ready" -ne "$auth_replicas" ||
      "$auth_available" -ne "$auth_replicas" ]]; then
      auth_rollout_observed=false
      add_failure "auth rollout is not fully observed: generation=$auth_generation observed=$auth_observed replicas=$auth_replicas updated=$auth_updated ready=$auth_ready available=$auth_available"
    fi

    auth_pod_rows="$(
      kubectl get pods -n "$NAMESPACE" -l "$AUTH_POD_SELECTOR" \
        -o jsonpath="{range .items[*]}{.metadata.name}|{.status.phase}|{.status.conditions[?(@.type=='Ready')].status}|{.spec.containers[?(@.name=='${AUTH_CONTAINER}')].image}{'\\n'}{end}" 2>/dev/null || true
    )"
    serving_auth_images=()
    ready_auth_pod_count=0
    missing_auth_container=false
    while IFS='|' read -r auth_pod auth_phase auth_pod_ready auth_pod_image; do
      if [[ "$auth_phase" == "Running" && "$auth_pod_ready" == "True" ]]; then
        ready_auth_pod_count=$((ready_auth_pod_count + 1))
        if [[ -z "$auth_pod_image" ]]; then
          missing_auth_container=true
          add_failure "ready auth pod $auth_pod is missing container $AUTH_CONTAINER"
        else
          serving_auth_images+=("$auth_pod_image")
        fi
      fi
    done <<<"$auth_pod_rows"

    incompatible_serving_image="$missing_auth_container"
    expected_auth_image="${AUTH_IMAGE_REPOSITORY}:${target_sha_full}"
    if [[ "$ready_auth_pod_count" -eq 0 ]]; then
      incompatible_serving_image=true
      add_failure "no ready auth pods found for selector: $AUTH_POD_SELECTOR"
    else
      for serving_auth_image in "${serving_auth_images[@]}"; do
        if [[ "$serving_auth_image" != "$expected_auth_image" &&
          ! "$serving_auth_image" =~ ^${expected_auth_image}@sha256:[0-9a-f]{64}$ ]]; then
          incompatible_serving_image=true
        fi
      done
    fi

    auth_mongo_pod="$(kubectl get pod -n "$NAMESPACE" -l "$AUTH_MONGO_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    if [[ -z "$auth_mongo_pod" ]]; then
      add_failure "auth mongo pod missing for selector: $AUTH_MONGO_SELECTOR"
    else
      mongo_query="db.getCollection('${AUTH_USER_COLLECTION}').countDocuments({identifierNormalized: {\$type: 'string'}})"
      if ! normalized_count="$(
        kubectl exec -n "$NAMESPACE" "$auth_mongo_pod" -- \
          mongosh --quiet "mongodb://localhost:27017/${AUTH_DB_NAME}" --eval "$mongo_query" 2>/dev/null
      )"; then
        add_failure "unable to count normalized auth identifiers before rollback"
      else
        normalized_count="$(tail -n 1 <<<"$normalized_count" | tr -d '\r')"
        if ! [[ "$normalized_count" =~ ^[0-9]+$ ]]; then
          add_failure "unexpected normalized auth identifier count: $normalized_count"
        elif [[ "$normalized_count" -gt 0 ]]; then
          add_failure "target auth at $TARGET_SHA is not identifier-compatible; found $normalized_count normalized account(s). Keep the current auth image and roll back only compatible services, or forward-fix"
        elif [[ "$auth_rollout_observed" != true || "$incompatible_serving_image" == true ]]; then
          add_failure "target auth at $TARGET_SHA is not identifier-compatible and serving auth images are: ${serving_auth_images[*]:-none}. Keep the current auth image during rollback; a zero account count is not an atomic rollback window"
        else
          echo "auth_identifier_rollback_check=PASS normalized_accounts=0 target_supports_identifiers=false"
        fi
      fi
    fi
  else
    echo "auth_identifier_rollback_check=PASS target_supports_identifiers=true"
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

if [[ "$target_sha_valid" == true ]]; then
  for workflow in production-build production-deploy; do
    if ! provenance="$(
      REPO="$REPO" WORKFLOW="$workflow" TARGET_SHA="$TARGET_SHA" \
        "$PROVENANCE_SCRIPT" 2>/dev/null
    )"; then
      add_failure "target sha $TARGET_SHA lacks a verifiable successful $workflow run"
    else
      read -r run_id run_status run_conclusion run_url <<<"$provenance"
      echo "rollback_provenance_ok=$workflow run_id=$run_id url=$run_url"
    fi
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
