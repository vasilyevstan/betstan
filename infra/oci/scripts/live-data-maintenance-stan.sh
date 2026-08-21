#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

ACTION="${1:-}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
STATE_FILE="${STATE_FILE:-}"
INGRESS_NAMESPACE="${INGRESS_NAMESPACE:-ingress-nginx}"
INGRESS_CONFIGMAP="${INGRESS_CONFIGMAP:-ingress-nginx-controller}"
WAIT_ATTEMPTS="${WAIT_ATTEMPTS:-60}"
WAIT_SECONDS="${WAIT_SECONDS:-2}"

BASE_SERVER_SNIPPET='if ($host = "www.betstan.xyz") {
  return 308 https://betstan.xyz$request_uri;
}'
WRITE_FENCE_DIRECTIVE='if ($request_method !~ ^(GET|HEAD|OPTIONS)$) {
  return 503;
}'
FENCED_SERVER_SNIPPET="${BASE_SERVER_SNIPPET}"$'\n'"${WRITE_FENCE_DIRECTIVE}"

writer_services=(bet event moderation resulting slip gamemaster)
quiesce_order=(gamemaster event slip moderation resulting bet)
restore_order=(bet event moderation resulting slip gamemaster)

fail() {
  echo "live_data_maintenance=${ACTION:-missing} status=FAIL reason=$*" >&2
  exit 1
}

[[ "$OCI_K8S_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  fail "OCI_K8S_NAMESPACE is invalid"
[[ "$INGRESS_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  fail "INGRESS_NAMESPACE is invalid"
[[ "$INGRESS_CONFIGMAP" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] ||
  fail "INGRESS_CONFIGMAP is invalid"
[[ "$WAIT_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] ||
  fail "WAIT_ATTEMPTS must be positive"
[[ "$WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
  fail "WAIT_SECONDS must be positive"
(( WAIT_ATTEMPTS <= 300 )) || fail "WAIT_ATTEMPTS exceeds the reviewed bound"
(( WAIT_SECONDS <= 10 )) || fail "WAIT_SECONDS exceeds the reviewed bound"

for command_name in kubectl jq; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command is unavailable: $command_name"
done

deployment_name() {
  printf 'gaming-%s-depl' "$1"
}

fence_config_status() {
  local snippet
  snippet="$(
    kubectl get configmap "$INGRESS_CONFIGMAP" \
      -n "$INGRESS_NAMESPACE" \
      -o jsonpath='{.data.server-snippet}'
  )"
  case "$snippet" in
    "$BASE_SERVER_SNIPPET")
      printf false
      ;;
    "$FENCED_SERVER_SNIPPET")
      printf true
      ;;
    *)
      return 1
      ;;
  esac
}

set_fence_config() {
  local expected="$1"
  local current desired patch
  current="$(fence_config_status)" ||
    fail "ingress server-snippet differs from the reviewed baseline and fence"
  [[ "$current" == "$expected" ]] && return 0
  if [[ "$expected" == "true" ]]; then
    desired="$FENCED_SERVER_SNIPPET"
  else
    desired="$BASE_SERVER_SNIPPET"
  fi
  patch="$(jq -cn --arg snippet "$desired" '{data:{"server-snippet":$snippet}}')"
  kubectl patch configmap "$INGRESS_CONFIGMAP" \
    -n "$INGRESS_NAMESPACE" \
    --type merge \
    --patch "$patch" >/dev/null
  [[ "$(fence_config_status)" == "$expected" ]] ||
    fail "ingress ConfigMap did not reach the requested fence state"
}

runtime_fence_status() {
  local pods_json pod_count pod rendered
  kubectl rollout status deployment/ingress-nginx-controller \
    -n "$INGRESS_NAMESPACE" --timeout=2m >/dev/null || return 1
  pods_json="$(
    kubectl get pods -n "$INGRESS_NAMESPACE" \
      -l app.kubernetes.io/component=controller \
      -o json
  )" || return 1
  jq -e '
    (.items | length) > 0 and
    all(.items[];
      .metadata.deletionTimestamp == null and
      .status.phase == "Running" and
      any(.status.conditions[]?;
        .type == "Ready" and .status == "True"))
  ' <<<"$pods_json" >/dev/null || return 1
  pod_count="$(jq -r '.items | length' <<<"$pods_json")"
  [[ "$pod_count" =~ ^[1-9][0-9]*$ ]] || return 1

  local fenced_count=0
  while IFS= read -r pod; do
    [[ -n "$pod" ]] || return 1
    rendered="$(
      kubectl exec -n "$INGRESS_NAMESPACE" "$pod" -- \
        sh -c 'nginx -T 2>&1'
    )" || return 1
    grep -Fq 'return 308 https://betstan.xyz$request_uri;' <<<"$rendered" ||
      return 1
    if grep -Fq 'if ($request_method !~ ^(GET|HEAD|OPTIONS)$) {' <<<"$rendered"; then
      fenced_count=$((fenced_count + 1))
    fi
  done < <(jq -r '.items[].metadata.name' <<<"$pods_json")

  if [[ "$fenced_count" == "$pod_count" ]]; then
    printf true
  elif [[ "$fenced_count" == "0" ]]; then
    printf false
  else
    return 1
  fi
}

wait_for_fence() {
  local expected="$1"
  local observed=""
  for _ in $(seq 1 "$WAIT_ATTEMPTS"); do
    if observed="$(runtime_fence_status)" && [[ "$observed" == "$expected" ]]; then
      return 0
    fi
    sleep "$WAIT_SECONDS"
  done
  fail "ingress runtime did not reach fence state $expected"
}

deployment_json() {
  kubectl get deployment "$(deployment_name "$1")" \
    -n "$OCI_K8S_NAMESPACE" \
    -o json
}

deployment_replicas() {
  deployment_json "$1" | jq -r '.spec.replicas // 0'
}

deployment_is_stable() {
  local service="$1"
  local expected="$2"
  local deployment pods_json
  deployment="$(deployment_json "$service")" || return 1
  jq -e --argjson expected "$expected" '
    (.spec.replicas // 0) == $expected and
    (.status.replicas // 0) == $expected and
    (.status.updatedReplicas // 0) == $expected and
    (.status.readyReplicas // 0) == $expected and
    (.status.availableReplicas // 0) == $expected
  ' <<<"$deployment" >/dev/null || return 1
  pods_json="$(
    kubectl get pods -n "$OCI_K8S_NAMESPACE" \
      -l "app=gaming-${service}" \
      -o json
  )" || return 1
  if [[ "$expected" == "0" ]]; then
    jq -e '.items | length == 0' <<<"$pods_json" >/dev/null
  else
    jq -e --argjson expected "$expected" '
      (.items | length) == $expected and
      all(.items[];
        .metadata.deletionTimestamp == null and
        .status.phase == "Running" and
        any(.status.conditions[]?;
          .type == "Ready" and .status == "True"))
    ' <<<"$pods_json" >/dev/null
  fi
}

wait_for_deployment() {
  local service="$1"
  local expected="$2"
  for _ in $(seq 1 "$WAIT_ATTEMPTS"); do
    if deployment_is_stable "$service" "$expected"; then
      return 0
    fi
    sleep "$WAIT_SECONDS"
  done
  fail "$(deployment_name "$service") did not reach $expected stable replicas"
}

scale_service() {
  local service="$1"
  local replicas="$2"
  kubectl scale "deployment/$(deployment_name "$service")" \
    -n "$OCI_K8S_NAMESPACE" \
    --replicas="$replicas" >/dev/null
  wait_for_deployment "$service" "$replicas"
}

require_state_file_path() {
  [[ -n "$STATE_FILE" && "$STATE_FILE" != "/" && "$STATE_FILE" != "." ]] ||
    fail "STATE_FILE is required and must be a specific file"
}

capture_state() {
  local temporary service replicas
  require_state_file_path
  mkdir -p "$(dirname "$STATE_FILE")"
  [[ ! -L "$STATE_FILE" ]] || fail "STATE_FILE must not be a symbolic link"
  temporary="${STATE_FILE}.tmp"
  umask 077
  {
    printf 'state_version\t1\n'
    printf 'namespace\t%s\n' "$OCI_K8S_NAMESPACE"
    for service in "${writer_services[@]}"; do
      replicas="$(deployment_replicas "$service")"
      [[ "$replicas" =~ ^[1-9][0-9]*$ ]] ||
        fail "$(deployment_name "$service") must be running before maintenance"
      deployment_is_stable "$service" "$replicas" ||
        fail "$(deployment_name "$service") is not stable before maintenance"
      printf 'service\t%s\t%s\n' "$service" "$replicas"
    done
  } >"$temporary"
  mv "$temporary" "$STATE_FILE"
}

validate_state() {
  local service count namespace
  require_state_file_path
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] ||
    fail "maintenance state file is missing or unsafe"
  [[ "$(awk -F '\t' '$1 == "state_version" && $2 == "1" {count++} END {print count+0}' "$STATE_FILE")" == "1" ]] ||
    fail "maintenance state version is invalid"
  namespace="$(awk -F '\t' '$1 == "namespace" {print $2}' "$STATE_FILE")"
  [[ "$namespace" == "$OCI_K8S_NAMESPACE" ]] ||
    fail "maintenance state namespace mismatch"
  count="$(awk -F '\t' '$1 == "service" {count++} END {print count+0}' "$STATE_FILE")"
  [[ "$count" == "${#writer_services[@]}" ]] ||
    fail "maintenance state has incomplete service coverage"
  for service in "${writer_services[@]}"; do
    count="$(
      awk -F '\t' -v service="$service" '
        $1 == "service" && $2 == service && $3 ~ /^[1-9][0-9]*$/ {count++}
        END {print count+0}
      ' "$STATE_FILE"
    )"
    [[ "$count" == "1" ]] ||
      fail "maintenance state is invalid for $service"
  done
  [[ "$(awk -F '\t' 'NF == 0 || ($1 != "state_version" && $1 != "namespace" && $1 != "service") {count++} END {print count+0}' "$STATE_FILE")" == "0" ]] ||
    fail "maintenance state contains unexpected records"
}

state_replicas() {
  awk -F '\t' -v service="$1" '
    $1 == "service" && $2 == service {print $3}
  ' "$STATE_FILE"
}

verify_held() {
  [[ "$(fence_config_status)" == "true" ]] ||
    fail "HTTP mutation fence is not configured"
  [[ "$(runtime_fence_status)" == "true" ]] ||
    fail "HTTP mutation fence is not active in ingress"
  local service
  for service in "${writer_services[@]}"; do
    deployment_is_stable "$service" 0 ||
      fail "$(deployment_name "$service") is not quiesced"
  done
}

hold_runtime() {
  set_fence_config true
  wait_for_fence true
  local service
  for service in "${quiesce_order[@]}"; do
    scale_service "$service" 0
  done
  verify_held
}

restore_runtime() {
  local service replicas
  validate_state
  for service in "${restore_order[@]}"; do
    replicas="$(state_replicas "$service")"
    scale_service "$service" "$replicas"
  done
  set_fence_config false
  wait_for_fence false
  rm -f -- "$STATE_FILE"
}

release_runtime() {
  [[ "$(fence_config_status)" == "true" ]] ||
    fail "HTTP mutation fence is not configured for release"
  local service replicas
  for service in "${writer_services[@]}"; do
    replicas="$(deployment_replicas "$service")"
    [[ "$replicas" =~ ^[1-9][0-9]*$ ]] ||
      fail "$(deployment_name "$service") is not restored"
    deployment_is_stable "$service" "$replicas" ||
      fail "$(deployment_name "$service") is not stable for release"
  done
  set_fence_config false
  wait_for_fence false
}

case "$ACTION" in
  enter)
    [[ "$(fence_config_status)" == "false" ]] ||
      fail "maintenance entry requires the reviewed unfenced baseline"
    capture_state
    if ! (hold_runtime); then
      restore_runtime || true
      fail "unable to enter maintenance; restoration was attempted"
    fi
    echo "live_data_maintenance=enter status=PASS http_mutation_fence=true writers_quiesced=true"
    ;;
  verify-held)
    verify_held
    echo "live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true"
    ;;
  restore)
    restore_runtime
    echo "live_data_maintenance=restore status=PASS http_mutation_fence=false writers_quiesced=false"
    ;;
  hold)
    hold_runtime
    echo "live_data_maintenance=hold status=PASS http_mutation_fence=true writers_quiesced=true"
    ;;
  release)
    release_runtime
    echo "live_data_maintenance=release status=PASS http_mutation_fence=false writers_quiesced=false"
    ;;
  *)
    echo "usage: $0 {enter|verify-held|restore|hold|release}" >&2
    exit 2
    ;;
esac
