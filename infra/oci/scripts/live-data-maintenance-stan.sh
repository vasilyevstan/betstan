#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

ACTION="${1:-}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
STATE_FILE="${STATE_FILE:-}"
BASELINE_DEPLOYMENTS_FILE="${BASELINE_DEPLOYMENTS_FILE:-}"
BASELINE_LIVE_IMAGES_FILE="${BASELINE_LIVE_IMAGES_FILE:-}"
READINESS_FILE="${READINESS_FILE:-}"
RESTORE_KEEP_FENCE="${RESTORE_KEEP_FENCE:-false}"
LOCK_CONFIGMAP="${LOCK_CONFIGMAP:-gaming-mongo-migration-lock}"
INCIDENT_MANIFEST_SHA256="${INCIDENT_MANIFEST_SHA256:-}"
INCIDENT_OWNER_RUN_ID="${INCIDENT_OWNER_RUN_ID:-}"
INCIDENT_RESTORE_RUN_ID="${INCIDENT_RESTORE_RUN_ID:-}"
INCIDENT_CONTROL_SHA="${INCIDENT_CONTROL_SHA:-}"
NOW_EPOCH="${NOW_EPOCH:-}"
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

writer_services=(backoffice bet event moderation resulting slip gamemaster)
all_services=(auth bet backoffice client event gamemaster moderation resulting slip telemetry)
reader_services=(auth client telemetry)
quiesce_order=(backoffice gamemaster event slip moderation resulting bet)
restore_order=(bet event moderation resulting slip gamemaster backoffice)

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

[[ "$RESTORE_KEEP_FENCE" = "true" || "$RESTORE_KEEP_FENCE" = "false" ]] ||
  fail "RESTORE_KEEP_FENCE must be true or false"

for command_name in kubectl jq python3; do
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
  local expected_image="${3:-}"
  local deployment pods_json
  deployment="$(deployment_json "$service")" || return 1
  jq -e --argjson expected "$expected" --arg expected_image "$expected_image" \
    --arg container "gaming-$service" '
    (.spec.replicas // 0) == $expected and
    (.status.replicas // 0) == $expected and
    (.status.updatedReplicas // 0) == $expected and
    (.status.readyReplicas // 0) == $expected and
    (.status.availableReplicas // 0) == $expected and
    ($expected_image == "" or
      ([.spec.template.spec.containers[]? |
        select(.name == $container and .image == $expected_image)] | length) == 1)
  ' <<<"$deployment" >/dev/null || return 1
  pods_json="$(
    kubectl get pods -n "$OCI_K8S_NAMESPACE" \
      -l "app=gaming-${service}" \
      -o json
  )" || return 1
  if [[ "$expected" == "0" ]]; then
    jq -e '.items | length == 0' <<<"$pods_json" >/dev/null
  else
    jq -e --argjson expected "$expected" --arg expected_image "$expected_image" \
      --arg container "gaming-$service" '
      (.items | length) == $expected and
      all(.items[];
        .metadata.deletionTimestamp == null and
        .status.phase == "Running" and
        ($expected_image == "" or
          ([.spec.containers[]? |
            select(.name == $container and .image == $expected_image)] | length) == 1) and
        any(.status.conditions[]?;
          .type == "Ready" and .status == "True"))
    ' <<<"$pods_json" >/dev/null
  fi
}

wait_for_deployment() {
  local service="$1"
  local expected="$2"
  local expected_image="${3:-}"
  for _ in $(seq 1 "$WAIT_ATTEMPTS"); do
    if deployment_is_stable "$service" "$expected" "$expected_image"; then
      return 0
    fi
    sleep "$WAIT_SECONDS"
  done
  fail "$(deployment_name "$service") did not reach $expected stable replicas"
}

scale_service() {
  local service="$1"
  local replicas="$2"
  local expected_image="${3:-}"
  kubectl scale "deployment/$(deployment_name "$service")" \
    -n "$OCI_K8S_NAMESPACE" \
    --replicas="$replicas" >/dev/null ||
    fail "$(deployment_name "$service") scale request failed"
  wait_for_deployment "$service" "$replicas" "$expected_image"
}

current_epoch() {
  if [[ -n "$NOW_EPOCH" ]]; then
    [[ "$NOW_EPOCH" =~ ^[1-9][0-9]*$ ]] ||
      fail "NOW_EPOCH must be a positive integer when provided"
    printf '%s\n' "$NOW_EPOCH"
  else
    date -u +%s
  fi
}

verify_incident_lock() {
  [[ "$INCIDENT_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ &&
     "$INCIDENT_OWNER_RUN_ID" =~ ^[1-9][0-9]*$ &&
     "$INCIDENT_RESTORE_RUN_ID" =~ ^[1-9][0-9]*$ &&
     "$INCIDENT_CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    fail "complete incident lock authentication is required"
  local now_epoch lock_json
  now_epoch="$(current_epoch)"
  lock_json="$(
    kubectl get configmap "$LOCK_CONFIGMAP" \
      -n "$OCI_K8S_NAMESPACE" -o json
  )" || fail "incident database lock is unavailable"
  python3 - \
    "$lock_json" \
    "$INCIDENT_MANIFEST_SHA256" \
    "$INCIDENT_OWNER_RUN_ID" \
    "$INCIDENT_RESTORE_RUN_ID" \
    "$INCIDENT_CONTROL_SHA" \
    "$now_epoch" <<'PY' || fail "incident database lock authentication failed"
import json
import re
import sys

document = json.loads(sys.argv[1])
manifest, owner, restore, control, now_raw = sys.argv[2:]
metadata = document.get("metadata")
data = document.get("data")
if not isinstance(metadata, dict) or not isinstance(data, dict):
    raise SystemExit(1)
if not isinstance(metadata.get("uid"), str) or not metadata["uid"]:
    raise SystemExit(1)
if not re.fullmatch(r"[1-9][0-9]*", metadata.get("resourceVersion", "")):
    raise SystemExit(1)
expected = {
    "state": "active",
    "holder": f"live-data-incident-{restore}-1",
    "operation-id": "live-data-incident-restore",
    "source-sha": control,
    "released-at-epoch": "0",
    "incident-manifest-sha256": manifest,
    "incident-owner-run-id": owner,
    "incident-restore-run-id": restore,
    "incident-control-sha": control,
}
if any(data.get(key) != value for key, value in expected.items()):
    raise SystemExit(1)
if set(data) != {
    *expected,
    "acquired-at-epoch",
    "lease-duration-seconds",
    "lease-until-epoch",
    "fencing-generation",
    "incident-current-run-metadata-sha256",
    "incident-request-created-at-epoch",
    "incident-provider-transition-epoch",
    "incident-predecessor-lease-until-epoch",
    "incident-new-lease-until-epoch",
}:
    raise SystemExit(1)
if not re.fullmatch(
    r"[0-9a-f]{64}",
    data.get("incident-current-run-metadata-sha256", ""),
):
    raise SystemExit(1)
numeric = {}
for key in (
    "acquired-at-epoch",
    "lease-duration-seconds",
    "lease-until-epoch",
    "fencing-generation",
    "incident-request-created-at-epoch",
    "incident-provider-transition-epoch",
    "incident-predecessor-lease-until-epoch",
    "incident-new-lease-until-epoch",
):
    value = data.get(key, "")
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise SystemExit(1)
    numeric[key] = int(value)
now = int(now_raw)
if not (
    numeric["acquired-at-epoch"]
    == numeric["incident-provider-transition-epoch"]
    and numeric["lease-until-epoch"]
    == numeric["incident-new-lease-until-epoch"]
    and numeric["lease-until-epoch"]
    == numeric["acquired-at-epoch"]
    + numeric["lease-duration-seconds"]
    and numeric["incident-request-created-at-epoch"]
    > numeric["incident-predecessor-lease-until-epoch"]
    and numeric["incident-provider-transition-epoch"]
    >= numeric["incident-request-created-at-epoch"]
    and 60 <= numeric["lease-duration-seconds"] <= 86400
    and numeric["lease-until-epoch"] > now
):
    raise SystemExit(1)
PY
}

set_service_image() {
  local service="$1"
  local image="$2"
  [[ "$image" =~ ^ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}$ ]] ||
    fail "baseline image is invalid for $service"
  kubectl set image "deployment/$(deployment_name "$service")" \
    -n "$OCI_K8S_NAMESPACE" \
    "gaming-${service}=${image}" >/dev/null ||
    fail "$(deployment_name "$service") image update failed"
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
      wait_for_deployment "$service" "$replicas"
      printf 'service\t%s\t%s\n' "$service" "$replicas"
    done
  } >"$temporary"
  mv "$temporary" "$STATE_FILE"
}

reconstruct_baseline_state() {
  local temporary
  require_state_file_path
  [[ -n "$BASELINE_DEPLOYMENTS_FILE" && -n "$BASELINE_LIVE_IMAGES_FILE" ]] ||
    fail "authenticated baseline deployment and live-image files are required"
  [[ -f "$BASELINE_DEPLOYMENTS_FILE" && ! -L "$BASELINE_DEPLOYMENTS_FILE" &&
     -f "$BASELINE_LIVE_IMAGES_FILE" && ! -L "$BASELINE_LIVE_IMAGES_FILE" ]] ||
    fail "authenticated baseline files are missing or unsafe"
  mkdir -p "$(dirname "$STATE_FILE")"
  [[ ! -L "$STATE_FILE" ]] || fail "STATE_FILE must not be a symbolic link"
  temporary="${STATE_FILE}.tmp"
  rm -f -- "$temporary"
  umask 077
  python3 - \
    "$BASELINE_DEPLOYMENTS_FILE" \
    "$BASELINE_LIVE_IMAGES_FILE" \
    "$temporary" \
    "$OCI_K8S_NAMESPACE" \
    "${all_services[@]}" <<'PY'
import os
import re
import sys

deployments_path, images_path, output_path, namespace, *services = sys.argv[1:]
service_set = set(services)
if len(service_set) != len(services):
    raise SystemExit("baseline service contract contains duplicates")
image_pattern = re.compile(
    r"ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}"
)

def read_rows(path, columns):
    rows = {}
    with open(path, encoding="utf-8", newline="") as handle:
        for raw in handle:
            if not raw.endswith("\n"):
                raise SystemExit("baseline table is missing a final newline")
            fields = raw[:-1].split("\t")
            if len(fields) != columns:
                raise SystemExit("baseline table has an invalid column count")
            service = fields[0]
            if service not in service_set or service in rows:
                raise SystemExit("baseline table has unexpected or duplicate services")
            rows[service] = fields[1:]
    if set(rows) != service_set:
        raise SystemExit("baseline table has incomplete service coverage")
    return rows

deployments = read_rows(deployments_path, 6)
images = read_rows(images_path, 2)
for service in services:
    image, revision, desired, ready, available = deployments[service]
    if not image_pattern.fullmatch(image) or images[service] != [image]:
        raise SystemExit(f"baseline image mismatch for {service}")
    if not revision.isdigit() or int(revision) <= 0:
        raise SystemExit(f"baseline revision is invalid for {service}")
    counts = (desired, ready, available)
    if any(not value.isdigit() or int(value) <= 0 for value in counts):
        raise SystemExit(f"baseline replicas are missing or zero for {service}")
    if len(set(counts)) != 1:
        raise SystemExit(f"baseline replicas were not stable for {service}")

with open(output_path, "x", encoding="utf-8", newline="") as handle:
    handle.write("state_version\t2\n")
    handle.write(f"namespace\t{namespace}\n")
    for service in services:
        image, _, desired, _, _ = deployments[service]
        handle.write(f"service\t{service}\t{desired}\t{image}\n")
os.chmod(output_path, 0o600)
PY
  mv "$temporary" "$STATE_FILE"
}

validate_state() {
  local service count namespace version
  require_state_file_path
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] ||
    fail "maintenance state file is missing or unsafe"
  version="$(awk -F '\t' '$1 == "state_version" {print $2}' "$STATE_FILE")"
  [[ "$version" = "1" || "$version" = "2" ]] ||
    fail "maintenance state version is invalid"
  [[ "$(awk -F '\t' -v version="$version" '$1 == "state_version" && $2 == version {count++} END {print count+0}' "$STATE_FILE")" == "1" ]] ||
    fail "maintenance state version is duplicated"
  namespace="$(awk -F '\t' '$1 == "namespace" {print $2}' "$STATE_FILE")"
  [[ "$namespace" == "$OCI_K8S_NAMESPACE" ]] ||
    fail "maintenance state namespace mismatch"
  if [[ "$version" = "1" ]]; then
    count="$(awk -F '\t' '$1 == "service" {count++} END {print count+0}' "$STATE_FILE")"
    [[ "$count" == "${#writer_services[@]}" ]] ||
      fail "maintenance state has incomplete service coverage"
    for service in "${writer_services[@]}"; do
      count="$(
        awk -F '\t' -v service="$service" '
          $1 == "service" && NF == 3 && $2 == service &&
            $3 ~ /^[1-9][0-9]*$/ {count++}
          END {print count+0}
        ' "$STATE_FILE"
      )"
      [[ "$count" == "1" ]] ||
        fail "maintenance state is invalid for $service"
    done
  else
    count="$(awk -F '\t' '$1 == "service" {count++} END {print count+0}' "$STATE_FILE")"
    [[ "$count" == "${#all_services[@]}" ]] ||
      fail "baseline maintenance state has incomplete service coverage"
    for service in "${all_services[@]}"; do
      count="$(
        awk -F '\t' -v service="$service" '
          $1 == "service" && NF == 4 && $2 == service &&
            $3 ~ /^[1-9][0-9]*$/ &&
            $4 ~ /^ghcr\.io\/vasilyevstan\/betstan-images@sha256:[0-9a-f]{64}$/ {
              count++
            }
          END {print count+0}
        ' "$STATE_FILE"
      )"
      [[ "$count" == "1" ]] ||
        fail "baseline maintenance state is invalid for $service"
    done
  fi
  [[ "$(awk -F '\t' 'NF == 0 || ($1 != "state_version" && $1 != "namespace" && $1 != "service") {count++} END {print count+0}' "$STATE_FILE")" == "0" ]] ||
    fail "maintenance state contains unexpected records"
}

state_replicas() {
  awk -F '\t' -v service="$1" '
    $1 == "service" && $2 == service {print $3}
  ' "$STATE_FILE"
}

state_image() {
  awk -F '\t' -v service="$1" '
    $1 == "service" && $2 == service {print $4}
  ' "$STATE_FILE"
}

verify_baseline_images() {
  local service image deployment
  validate_state
  [[ "$(awk -F '\t' '$1 == "state_version" {print $2}' "$STATE_FILE")" = "2" ]] ||
    fail "baseline image verification requires authenticated baseline state"
  for service in "${all_services[@]}"; do
    image="$(state_image "$service")"
    deployment="$(deployment_json "$service")" ||
      fail "$(deployment_name "$service") is unavailable"
    jq -e --arg image "$image" --arg container "gaming-$service" '
      [.spec.template.spec.containers[]? |
        select(.name == $container and .image == $image)] | length == 1
    ' <<<"$deployment" >/dev/null ||
      fail "$(deployment_name "$service") image differs from the authenticated baseline"
  done
}

verify_quiesced() {
  local service
  for service in "${writer_services[@]}"; do
    deployment_is_stable "$service" 0 ||
      fail "$(deployment_name "$service") is not quiesced"
  done
}

verify_held() {
  [[ "$(fence_config_status)" == "true" ]] ||
    fail "HTTP mutation fence is not configured"
  [[ "$(runtime_fence_status)" == "true" ]] ||
    fail "HTTP mutation fence is not active in ingress"
  verify_quiesced
}

verified_fence_status() {
  local configured runtime
  configured="$(fence_config_status)" ||
    fail "HTTP mutation fence configuration is not recognized"
  runtime="$(runtime_fence_status)" ||
    fail "HTTP mutation fence runtime is not recognized"
  [[ "$configured" == "$runtime" ]] ||
    fail "HTTP mutation fence configuration and runtime differ"
  printf '%s\n' "$configured"
}

reconcile_incident_writers() {
  verify_incident_lock
  [[ "$(fence_config_status)" == "true" &&
     "$(runtime_fence_status)" == "true" ]] ||
    fail "incident writer reconciliation requires the active HTTP fence"
  local service
  for service in "${quiesce_order[@]}"; do
    verify_incident_lock
    scale_service "$service" 0
  done
  verify_incident_lock
  verify_held
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
  local service replicas image version
  validate_state
  version="$(awk -F '\t' '$1 == "state_version" {print $2}' "$STATE_FILE")"
  if [[ "$version" = "2" ]]; then
    [[ "$(fence_config_status)" == "true" &&
       "$(runtime_fence_status)" == "true" ]] ||
      fail "authenticated baseline restoration requires the active HTTP fence"
    if [[ "$RESTORE_KEEP_FENCE" = "true" ]]; then
      verify_incident_lock
    fi
    for service in "${reader_services[@]}"; do
      replicas="$(state_replicas "$service")"
      image="$(state_image "$service")"
      set_service_image "$service" "$image"
      scale_service "$service" "$replicas" "$image"
    done
    for service in "${restore_order[@]}"; do
      replicas="$(state_replicas "$service")"
      image="$(state_image "$service")"
      set_service_image "$service" "$image"
      scale_service "$service" "$replicas" "$image"
    done
    if [[ "$RESTORE_KEEP_FENCE" = "true" ]]; then
      verify_incident_lock
      [[ "$(fence_config_status)" == "true" &&
         "$(runtime_fence_status)" == "true" ]] ||
        fail "authenticated baseline restoration lost the HTTP fence"
    fi
  else
    for service in "${restore_order[@]}"; do
      replicas="$(state_replicas "$service")"
      scale_service "$service" "$replicas"
    done
  fi
  if [[ "$RESTORE_KEEP_FENCE" = "false" ]]; then
    set_fence_config false
    wait_for_fence false
    rm -f -- "$STATE_FILE"
  fi
}

release_runtime() {
  [[ "$(fence_config_status)" == "true" ]] ||
    fail "HTTP mutation fence is not configured for release"
  local service replicas image version=""
  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" && ! -L "$STATE_FILE" ]]; then
    validate_state
    version="$(awk -F '\t' '$1 == "state_version" {print $2}' "$STATE_FILE")"
  fi
  if [[ "$version" = "2" ]]; then
    for service in "${all_services[@]}"; do
      replicas="$(state_replicas "$service")"
      image="$(state_image "$service")"
      deployment_is_stable "$service" "$replicas" "$image" ||
        fail "$(deployment_name "$service") does not match the authenticated baseline"
    done
  else
    for service in "${writer_services[@]}"; do
      replicas="$(deployment_replicas "$service")"
      [[ "$replicas" =~ ^[1-9][0-9]*$ ]] ||
        fail "$(deployment_name "$service") is not restored"
      deployment_is_stable "$service" "$replicas" ||
        fail "$(deployment_name "$service") is not stable for release"
    done
  fi
  set_fence_config false
  wait_for_fence false
}

capture_readiness() {
  local temporary service replicas image
  validate_state
  [[ "$(awk -F '\t' '$1 == "state_version" {print $2}' "$STATE_FILE")" = "2" ]] ||
    fail "readiness capture requires authenticated baseline state"
  [[ -n "$READINESS_FILE" && "$READINESS_FILE" != "/" &&
     "$READINESS_FILE" != "." && ! -L "$READINESS_FILE" ]] ||
    fail "READINESS_FILE is required and must be a specific regular path"
  [[ "$(fence_config_status)" == "false" &&
     "$(runtime_fence_status)" == "false" ]] ||
    fail "readiness capture requires the released HTTP fence"
  temporary="${READINESS_FILE}.tmp"
  mkdir -p "$(dirname "$READINESS_FILE")"
  rm -f -- "$temporary"
  umask 077
  {
    printf 'service\treplicas\timage\n'
    for service in "${all_services[@]}"; do
      replicas="$(state_replicas "$service")"
      image="$(state_image "$service")"
      deployment_is_stable "$service" "$replicas" "$image" ||
        fail "$(deployment_name "$service") is not ready at the authenticated baseline"
      printf '%s\t%s\t%s\n' "$service" "$replicas" "$image"
    done
  } >"$temporary"
  mv "$temporary" "$READINESS_FILE"
  rm -f -- "$STATE_FILE"
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

case "$ACTION" in
  reconstruct-baseline)
    reconstruct_baseline_state
    echo "live_data_maintenance=reconstruct-baseline status=PASS authenticated_services=${#all_services[@]}"
    ;;
  verify-baseline-images)
    verify_baseline_images
    echo "live_data_maintenance=verify-baseline-images status=PASS authenticated_services=${#all_services[@]}"
    ;;
  fence-writes)
    set_fence_config true
    wait_for_fence true
    echo "live_data_maintenance=fence-writes status=PASS http_mutation_fence=true writers_quiesced=false"
    ;;
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
  verify-quiesced)
    verify_quiesced
    echo "live_data_maintenance=verify-quiesced status=PASS writers_quiesced=true"
    ;;
  fence-status)
    fence_status="$(verified_fence_status)"
    echo "live_data_maintenance=fence-status status=PASS fence=$fence_status"
    ;;
  restore)
    if ! (restore_runtime); then
      if [[ "$RESTORE_KEEP_FENCE" = "true" ]]; then
        reconcile_incident_writers ||
          fail "authenticated baseline restoration and writer reconciliation failed"
        fail "authenticated baseline restoration failed; writers were re-quiesced"
      fi
      fail "baseline restoration failed"
    fi
    echo "live_data_maintenance=restore status=PASS http_mutation_fence=$RESTORE_KEEP_FENCE writers_quiesced=false"
    ;;
  reconcile-incident-writers)
    reconcile_incident_writers
    echo "live_data_maintenance=reconcile-incident-writers status=PASS http_mutation_fence=true writers_quiesced=true"
    ;;
  hold)
    hold_runtime
    echo "live_data_maintenance=hold status=PASS http_mutation_fence=true writers_quiesced=true"
    ;;
  release)
    release_runtime
    echo "live_data_maintenance=release status=PASS http_mutation_fence=false writers_quiesced=false"
    ;;
  capture-readiness)
    capture_readiness
    echo "live_data_maintenance=capture-readiness status=PASS authenticated_services=${#all_services[@]}"
    ;;
  *)
    echo "usage: $0 {reconstruct-baseline|verify-baseline-images|fence-writes|enter|verify-held|verify-quiesced|fence-status|restore|reconcile-incident-writers|hold|release|capture-readiness}" >&2
    exit 2
    ;;
esac
