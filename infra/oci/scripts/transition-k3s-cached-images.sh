#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=application-registry.sh
source "$SCRIPT_DIR/application-registry.sh"

RECOVERY_DIR="${RECOVERY_DIR:-}"
INFRA_PROVENANCE_FILE="${INFRA_PROVENANCE_FILE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-}"
SOURCE_SHA="${SOURCE_SHA:-}"
RECOVERY_RUN_ID="${RECOVERY_RUN_ID:-}"
RECOVERY_RUN_ATTEMPT="${RECOVERY_RUN_ATTEMPT:-}"
RESUME_RECOVERY_RUN_ID="${RESUME_RECOVERY_RUN_ID:-0}"
TRANSITION_PHASE="${TRANSITION_PHASE:-rebind}"
RETIRE_OCIR_REPOSITORY="${RETIRE_OCIR_REPOSITORY:-0}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
ROLLOUT_TIMEOUT_SECONDS="${ROLLOUT_TIMEOUT_SECONDS:-300}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
SERVICES=(auth bet backoffice client event gamemaster moderation resulting slip)

env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '
    $1 == key {
      if (found++) exit 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (found != 1) exit 1
      print value
    }
  ' "$file"
}

sha256_file() {
  oci_sha256 <"$1"
}

capture_diagnostics() {
  local service
  mkdir -p "$OUTPUT_DIR/transition-diagnostics"
  for service in "${SERVICES[@]}"; do
    kubectl get deployment "gaming-${service}-depl" -n "$OCI_K8S_NAMESPACE" -o json \
      >"$OUTPUT_DIR/transition-diagnostics/${service}-deployment.json" 2>&1 || true
    kubectl get pods -n "$OCI_K8S_NAMESPACE" -l "app=gaming-${service}" -o json \
      >"$OUTPUT_DIR/transition-diagnostics/${service}-pods.json" 2>&1 || true
  done
}

fail_transition() {
  capture_diagnostics
  oci_die "$1"
}

verify_live_platform() {
  local service="$1"
  local image_ref="$2"
  local platform_digest="$3"
  local deployment="gaming-${service}-depl"
  local container="gaming-${service}"
  local deployment_json="$OUTPUT_DIR/.${service}-deployment.json"
  local pods_json="$OUTPUT_DIR/.${service}-pods.json"

  kubectl get deployment "$deployment" -n "$OCI_K8S_NAMESPACE" -o json >"$deployment_json" &&
    kubectl get pods -n "$OCI_K8S_NAMESPACE" -l "app=gaming-${service}" -o json >"$pods_json" &&
    python3 - "$deployment_json" "$pods_json" "$container" "$image_ref" "$platform_digest" <<'PY'
import json
import sys

deployment_path, pods_path, container, image_ref, platform_digest = sys.argv[1:]
deployment = json.loads(open(deployment_path, encoding="utf-8").read())
pods = json.loads(open(pods_path, encoding="utf-8").read())
manifest_digest = image_ref.rsplit("@", 1)[-1]
images = [
    item.get("image", "")
    for item in deployment.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    if item.get("name") == container
]
if images != [image_ref]:
    raise SystemExit("Deployment image does not match the verified GHCR digest")
ready = 0
for pod in pods.get("items", []):
    if pod.get("metadata", {}).get("deletionTimestamp"):
        continue
    for status in pod.get("status", {}).get("containerStatuses", []):
        if status.get("name") != container:
            continue
        image_id = status.get("imageID", "")
        if not status.get("ready") or not (
            image_id.endswith("@" + manifest_digest)
            or image_id.endswith("@" + platform_digest)
        ):
            raise SystemExit("Pod does not serve the verified manifest/platform digest")
        ready += 1
if ready == 0:
    raise SystemExit("No ready application pod serves the verified GHCR digest")
PY
  local status=$?
  rm -f -- "$deployment_json" "$pods_json"
  return "$status"
}

validate_recovery_evidence() {
  local file="$1"
  python3 - "$file" "$SOURCE_SHA" "$RECOVERY_RUN_ID" "$RECOVERY_RUN_ATTEMPT" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
expected_source, expected_run, expected_attempt = sys.argv[2:]
required = {
    "schema", "recovery_origin", "registry_provider", "registry_repository",
    "anonymous_pull", "source_sha", "trusted_build_run_id",
    "trusted_upstream_run_id", "recovery_run_id", "recovery_run_attempt",
    "images_sha256",
}
if not path.is_file() or path.is_symlink():
    raise SystemExit("recovery evidence is not a regular file")
values = {}
for raw in path.read_text(encoding="utf-8").splitlines():
    if not raw or "=" not in raw:
        raise SystemExit("recovery evidence is malformed")
    key, value = raw.split("=", 1)
    if key in values or key not in required or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        raise SystemExit("recovery evidence key set is invalid")
    values[key] = value
if set(values) != required:
    raise SystemExit("recovery evidence key set is incomplete")
if values["schema"] != "betstan.ghcr-cache-recovery.v1":
    raise SystemExit("recovery evidence schema is invalid")
if values["recovery_origin"] != "containerd-cache" or values["registry_provider"] != "ghcr":
    raise SystemExit("recovery evidence origin is invalid")
if values["registry_repository"] != "ghcr.io/vasilyevstan/betstan-images":
    raise SystemExit("recovery evidence registry identity is invalid")
if values["anonymous_pull"] != "pass":
    raise SystemExit("recovery evidence does not prove anonymous pull verification")
if values["source_sha"] != expected_source or values["recovery_run_id"] != expected_run:
    raise SystemExit("recovery evidence does not bind the selected recovery")
if values["recovery_run_attempt"] != expected_attempt:
    raise SystemExit("recovery evidence is not a first attempt")
for key in ("trusted_build_run_id", "trusted_upstream_run_id"):
    if not re.fullmatch(r"[1-9][0-9]*", values[key]):
        raise SystemExit("recovery evidence historical build lineage is invalid")
if not re.fullmatch(r"[0-9a-f]{64}", values["images_sha256"]):
    raise SystemExit("recovery evidence image hash is invalid")
PY
}

validate_transition_plan_evidence() {
  local file="$1"
  local expected_carrier_run_id="$2"
  local expected_images_sha256="$3"
  local expected_infrastructure_sha256="$4"
  local expected_plan_sha256="$5"
  local expected_rabbitmq_sha256="$6"
  python3 - "$file" "$SOURCE_SHA" "$expected_carrier_run_id" \
    "$expected_images_sha256" "$expected_infrastructure_sha256" \
    "$expected_plan_sha256" "$expected_rabbitmq_sha256" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
expected_source, expected_carrier, expected_images, expected_infrastructure, expected_plan, expected_rabbit = sys.argv[2:]
required = {
    "schema", "source_sha", "plan_origin_recovery_run_id",
    "plan_carrier_recovery_run_id", "plan_carrier_recovery_run_attempt",
    "images_sha256", "infrastructure_provenance_sha256",
    "transition_plan_sha256", "rabbitmq_baseline_sha256",
}
if not path.is_file() or path.is_symlink():
    raise SystemExit("transition plan evidence is missing or unsafe")
values = {}
for raw in path.read_text(encoding="utf-8").splitlines():
    if not raw or "=" not in raw:
        raise SystemExit("transition plan evidence is malformed")
    key, value = raw.split("=", 1)
    if key in values or key not in required:
        raise SystemExit("transition plan evidence key set is invalid")
    values[key] = value
if set(values) != required:
    raise SystemExit("transition plan evidence key set is incomplete")
if values["schema"] != "betstan.ghcr-cache-transition-plan.v1":
    raise SystemExit("transition plan evidence schema is invalid")
if values["source_sha"] != expected_source:
    raise SystemExit("transition plan evidence source differs")
for key in ("plan_origin_recovery_run_id", "plan_carrier_recovery_run_id"):
    if not re.fullmatch(r"[1-9][0-9]*", values[key]):
        raise SystemExit("transition plan evidence run lineage is invalid")
if (
    values["plan_carrier_recovery_run_id"] != expected_carrier
    or values["plan_carrier_recovery_run_attempt"] != "1"
):
    raise SystemExit("transition plan evidence carrier differs")
expected = {
    "images_sha256": expected_images,
    "infrastructure_provenance_sha256": expected_infrastructure,
    "transition_plan_sha256": expected_plan,
    "rabbitmq_baseline_sha256": expected_rabbit,
}
for key, value in expected.items():
    if not re.fullmatch(r"[0-9a-f]{64}", values[key]) or values[key] != value:
        raise SystemExit(f"transition plan evidence hash differs: {key}")
PY
}

application_registry_require_ghcr
oci_require_command kubectl
oci_require_command jq
oci_require_command python3
[[ -d "$RECOVERY_DIR" && ! -L "$RECOVERY_DIR" ]] ||
  oci_die "RECOVERY_DIR must be a regular recovery artifact directory"
[[ -f "$INFRA_PROVENANCE_FILE" && ! -L "$INFRA_PROVENANCE_FILE" ]] ||
  oci_die "INFRA_PROVENANCE_FILE must be a regular file"
[[ -n "$OUTPUT_DIR" && "$OUTPUT_DIR" != "/" && "$OUTPUT_DIR" != "." ]] ||
  oci_die "OUTPUT_DIR is unsafe"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "SOURCE_SHA must identify the historical recovered source"
[[ "$RECOVERY_RUN_ID" =~ ^[1-9][0-9]*$ && "$RECOVERY_RUN_ATTEMPT" == "1" ]] ||
  oci_die "transition requires an explicit first-attempt recovery run"
[[ "$RESUME_RECOVERY_RUN_ID" =~ ^(0|[1-9][0-9]*)$ &&
   "$RESUME_RECOVERY_RUN_ID" != "$RECOVERY_RUN_ID" ]] ||
  oci_die "RESUME_RECOVERY_RUN_ID must be 0 or a different first-attempt recovery run"
[[ "$TRANSITION_PHASE" == "plan" ||
   "$TRANSITION_PHASE" == "rebind" ||
   "$TRANSITION_PHASE" == "retire" ]] ||
  oci_die "TRANSITION_PHASE must be plan, rebind, or retire"
[[ "$RETIRE_OCIR_REPOSITORY" == "0" || "$RETIRE_OCIR_REPOSITORY" == "1" ]] ||
  oci_die "RETIRE_OCIR_REPOSITORY must be 0 or 1"
if [[ "$TRANSITION_PHASE" == "plan" || "$TRANSITION_PHASE" == "rebind" ]]; then
  [[ "$RETIRE_OCIR_REPOSITORY" == "0" ]] ||
    oci_die "the OCIR repository cannot be retired during image rebinding"
else
  [[ "$RETIRE_OCIR_REPOSITORY" == "1" ]] ||
    oci_die "credential retirement must also retire the empty OCIR repository"
  oci_require_command oci
  oci_require_vars OCI_COMPARTMENT_OCID OCI_IMAGE_PREFIX
  oci_require_ocid OCI_COMPARTMENT_OCID
fi
[[ "$OCI_K8S_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  oci_die "OCI_K8S_NAMESPACE is invalid"
[[ "$ROLLOUT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] &&
  (( ROLLOUT_TIMEOUT_SECONDS <= 900 )) ||
  oci_die "ROLLOUT_TIMEOUT_SECONDS must be a bounded positive integer"

[[ "$OUTPUT_DIR" == "$RECOVERY_DIR" ]] ||
  oci_die "transition evidence must be added to the exact verified recovery artifact directory"
RECOVERY_EVIDENCE_FILE="$RECOVERY_DIR/recovery-evidence.env"
RECOVERY_IMAGES_FILE="$RECOVERY_DIR/images.tsv"
validate_recovery_evidence "$RECOVERY_EVIDENCE_FILE"
[[ -f "$RECOVERY_IMAGES_FILE" && ! -L "$RECOVERY_IMAGES_FILE" ]] ||
  oci_die "recovery images.tsv is missing"
[[ "$(sha256_file "$RECOVERY_IMAGES_FILE")" == \
   "$(env_value "$RECOVERY_EVIDENCE_FILE" images_sha256)" ]] ||
  oci_die "recovery evidence does not bind the exact recovered image set"

trusted_build_run_id="$(env_value "$RECOVERY_EVIDENCE_FILE" trusted_build_run_id)"
trusted_upstream_run_id="$(env_value "$RECOVERY_EVIDENCE_FILE" trusted_upstream_run_id)"
PROVENANCE_DIR="$RECOVERY_DIR" SOURCE_SHA="$SOURCE_SHA" \
EXPECTED_BUILD_RUN_ID="$trusted_build_run_id" EXPECTED_BUILD_RUN_ATTEMPT=1 \
EXPECTED_UPSTREAM_RUN_ID="$trusted_upstream_run_id" \
PROVENANCE_MODE=recovery EXPECTED_RECOVERY_RUN_ID="$RECOVERY_RUN_ID" \
EXPECTED_RECOVERY_RUN_ATTEMPT=1 OUTPUT_FILE="$OUTPUT_DIR/verified-images.tsv" \
VERIFY_REMOTE=0 BOOT_IMAGES=0 ANONYMOUS_PULL=0 \
  "$SCRIPT_DIR/verify-images.sh"
cmp -s "$RECOVERY_IMAGES_FILE" "$OUTPUT_DIR/verified-images.tsv" ||
  oci_die "recovery provenance does not reproduce the verified recovered image set"
rm -f -- "$OUTPUT_DIR/verified-images.tsv"

unset runtime_mode instance_fingerprint infrastructure_run_id infrastructure_run_attempt
unset public_host canonical_host redirect_host diagnostic_host namespace
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
[[ "${runtime_mode:-}" == "k3s" &&
   "${instance_fingerprint:-}" =~ ^[0-9a-f]{64}$ &&
   "${infrastructure_run_id:-}" =~ ^[1-9][0-9]*$ &&
   "${infrastructure_run_attempt:-}" == "1" &&
   "${namespace:-}" == "$OCI_K8S_NAMESPACE" ]] ||
  oci_die "transition infrastructure provenance is not the exact active k3s runtime"
[[ "${public_host:-}" && "${canonical_host:-}" && "${redirect_host:-}" &&
   "${diagnostic_host:-}" ]] ||
  oci_die "transition infrastructure provenance has incomplete public endpoints"
infrastructure_provenance_sha256="$(sha256_file "$INFRA_PROVENANCE_FILE")"

TRANSITION_PLAN_FILE="$OUTPUT_DIR/transition-plan.tsv"
RABBITMQ_BASELINE_FILE="$OUTPUT_DIR/rabbitmq-baseline.txt"
TRANSITION_PLAN_EVIDENCE_FILE="$OUTPUT_DIR/transition-plan-evidence.env"
current_plan="$OUTPUT_DIR/.current-transition-plan.tsv"
: >"$current_plan"
pending_count=0
for service in "${SERVICES[@]}"; do
  service_file="$RECOVERY_DIR/${service}.env"
  [[ -f "$service_file" && ! -L "$service_file" ]] ||
    oci_die "recovery artifact is missing $service provenance"
  image_ref="$(awk -F '\t' -v service="$service" '$1 == service { count++; value=$3 } END { if (count != 1) exit 1; print value }' "$RECOVERY_IMAGES_FILE")" ||
    oci_die "recovery images are missing or duplicate $service"
  origin_repository="$(env_value "$service_file" recovery_origin_repository)"
  origin_digest="$(env_value "$service_file" recovery_origin_manifest_digest)"
  platform_digest="$(awk -F '\t' -v service="$service" '$1 == service { count++; value=$5 } END { if (count != 1) exit 1; print value }' "$RECOVERY_IMAGES_FILE")" ||
    oci_die "recovery platform digest is missing for $service"
  old_ref="${origin_repository}@${origin_digest}"
  live_ref="$(kubectl get deployment "gaming-${service}-depl" -n "$OCI_K8S_NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}')"
  if [[ "$live_ref" == "$old_ref" ]]; then
    transition_state=pending
    pending_count=$((pending_count + 1))
  elif [[ "$live_ref" == "$image_ref" ]]; then
    verify_live_platform "$service" "$image_ref" "$platform_digest" ||
      oci_die "already-transitioned deployment $service does not serve the verified GHCR digest"
    transition_state=already-ghcr
  else
    oci_die "live deployment $service is neither its recovered OCIR origin nor verified GHCR digest"
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$service" "$old_ref" "$image_ref" "$platform_digest" "$transition_state" \
    >>"$current_plan"
done
[[ "$(awk 'END { print NR }' "$current_plan")" == "9" ]] ||
  oci_die "transition plan must contain exactly nine application services"
plan_file_count=0
for plan_file in \
  "$TRANSITION_PLAN_FILE" \
  "$RABBITMQ_BASELINE_FILE" \
  "$TRANSITION_PLAN_EVIDENCE_FILE"; do
  if [[ -e "$plan_file" || -L "$plan_file" ]]; then
    plan_file_count=$((plan_file_count + 1))
  fi
done
[[ "$plan_file_count" == "0" || "$plan_file_count" == "3" ]] ||
  oci_die "transition plan artifacts are incomplete"
plan_exists=0
if [[ "$plan_file_count" == "3" ]]; then
  [[ -f "$TRANSITION_PLAN_FILE" && ! -L "$TRANSITION_PLAN_FILE" &&
     -s "$RABBITMQ_BASELINE_FILE" && ! -L "$RABBITMQ_BASELINE_FILE" &&
     -f "$TRANSITION_PLAN_EVIDENCE_FILE" &&
     ! -L "$TRANSITION_PLAN_EVIDENCE_FILE" ]] ||
    oci_die "transition plan artifacts are unsafe"
  plan_exists=1
fi

if [[ "$TRANSITION_PHASE" == "plan" ]]; then
  if [[ "$plan_exists" == "1" ]]; then
    [[ "$RESUME_RECOVERY_RUN_ID" != "0" ]] ||
      oci_die "an existing transition plan requires an explicit prior recovery run"
  else
    [[ "$RESUME_RECOVERY_RUN_ID" == "0" && "$pending_count" == "9" ]] ||
      oci_die "a fresh transition plan requires all nine deployments on the OCIR baseline"
  fi
  iteration_plan=""
elif [[ "$TRANSITION_PHASE" == "rebind" ]]; then
  [[ "$plan_exists" == "1" ]] ||
    oci_die "image rebinding requires an immutable pre-rebind transition plan"
  iteration_plan="$current_plan"
else
  [[ "$plan_exists" == "1" &&
     -f "$OUTPUT_DIR/rebind-provenance.env" &&
     ! -L "$OUTPUT_DIR/rebind-provenance.env" ]] ||
    oci_die "credential retirement requires the exact verified rebind evidence"
  ((pending_count == 0)) ||
    oci_die "credential retirement requires all application deployments on verified GHCR digests"
  iteration_plan="$current_plan"
fi
if [[ "$plan_exists" == "1" ]]; then
  awk -F '\t' 'NF == 5 && ($5 == "pending" || $5 == "already-ghcr") {
    if (!($1 in count)) unique++
    count[$1]++; print $1 "\t" $2 "\t" $3 "\t" $4
  } END {
    if (NR != 9 || unique != 9) exit 1
    for (service in count) if (count[service] != 1) exit 1
  }' "$TRANSITION_PLAN_FILE" >"$OUTPUT_DIR/.original-transition-identities.tsv" ||
    oci_die "immutable transition plan is malformed"
  cut -f1-4 "$current_plan" >"$OUTPUT_DIR/.current-transition-identities.tsv"
  cmp -s \
    "$OUTPUT_DIR/.original-transition-identities.tsv" \
    "$OUTPUT_DIR/.current-transition-identities.tsv" ||
    oci_die "live transition identities differ from the immutable pre-rebind plan"
  rm -f -- \
    "$OUTPUT_DIR/.original-transition-identities.tsv" \
    "$OUTPUT_DIR/.current-transition-identities.tsv"
  transition_plan_state_sha256="$(sha256_file "$TRANSITION_PLAN_FILE")"
  rabbitmq_baseline_sha256="$(sha256_file "$RABBITMQ_BASELINE_FILE")"
  if [[ "$TRANSITION_PHASE" == "plan" ]]; then
    expected_plan_carrier="$RESUME_RECOVERY_RUN_ID"
  else
    expected_plan_carrier="$RECOVERY_RUN_ID"
  fi
  validate_transition_plan_evidence \
    "$TRANSITION_PLAN_EVIDENCE_FILE" \
    "$expected_plan_carrier" \
    "$(sha256_file "$RECOVERY_IMAGES_FILE")" \
    "$infrastructure_provenance_sha256" \
    "$transition_plan_state_sha256" \
    "$rabbitmq_baseline_sha256"
  plan_origin_recovery_run_id="$(
    env_value "$TRANSITION_PLAN_EVIDENCE_FILE" plan_origin_recovery_run_id
  )"
  transition_plan_evidence_sha256="$(
    sha256_file "$TRANSITION_PLAN_EVIDENCE_FILE"
  )"
fi

# Credentials are checked before touching a Deployment but are not changed until
# every recovered GHCR image has rolled out and its serving platform is verified.
service_account_json="$(kubectl get serviceaccount default -n "$OCI_K8S_NAMESPACE" -o json)"
if jq -e '(.imagePullSecrets // []) == [{"name":"ocir-pull"}]' \
    <<<"$service_account_json" >/dev/null; then
  service_account_state=legacy
elif jq -e '((.imagePullSecrets // []) | length) == 0' \
    <<<"$service_account_json" >/dev/null; then
  service_account_state=retired
else
  oci_die "default service account has an unexpected imagePullSecrets state"
fi
secret_json="$(
  kubectl get secret ocir-pull -n "$OCI_K8S_NAMESPACE" \
    --ignore-not-found -o json
)" || oci_die "could not determine whether the OCIR pull secret exists"
if [[ -n "$secret_json" ]]; then
  jq -e '.type == "kubernetes.io/dockerconfigjson"' <<<"$secret_json" >/dev/null ||
    oci_die "ocir-pull is not the expected dockerconfigjson secret"
  secret_state=legacy
else
  secret_state=retired
fi
if [[ "$TRANSITION_PHASE" == "plan" || "$TRANSITION_PHASE" == "rebind" ]] &&
   ((pending_count > 0)); then
  [[ "$service_account_state" == "legacy" && "$secret_state" == "legacy" ]] ||
    oci_die "pending rebinding requires the exact OCIR pull credential to remain intact"
fi

if [[ "$TRANSITION_PHASE" == "plan" ]]; then
  if [[ "$plan_exists" == "0" ]]; then
    rabbit_pod="$(kubectl get pod -n "$OCI_K8S_NAMESPACE" -l "$RABBIT_SELECTOR" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    [[ -n "$rabbit_pod" ]] ||
      fail_transition "RabbitMQ pod is unavailable for rollback queue baseline"
    queue_raw="$OUTPUT_DIR/.rabbitmq-queues.raw"
    if ! kubectl exec -n "$OCI_K8S_NAMESPACE" "$rabbit_pod" -- \
        rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers \
        >"$queue_raw"; then
      fail_transition "could not capture RabbitMQ queue baseline"
    fi
    oci_rabbitmq_queue_rows <"$queue_raw" | awk '{print $1}' | sort -u \
      >"$RABBITMQ_BASELINE_FILE" ||
      fail_transition "RabbitMQ queue baseline was malformed"
    rm -f -- "$queue_raw"
    [[ -s "$RABBITMQ_BASELINE_FILE" ]] ||
      fail_transition "RabbitMQ queue baseline is empty"
    mv "$current_plan" "$TRANSITION_PLAN_FILE"
    chmod 600 "$TRANSITION_PLAN_FILE" "$RABBITMQ_BASELINE_FILE"
    plan_origin_recovery_run_id="$RECOVERY_RUN_ID"
    transition_plan_state_sha256="$(sha256_file "$TRANSITION_PLAN_FILE")"
    rabbitmq_baseline_sha256="$(sha256_file "$RABBITMQ_BASELINE_FILE")"
  else
    rm -f -- "$current_plan"
    plan_origin_recovery_run_id="$(
      env_value "$TRANSITION_PLAN_EVIDENCE_FILE" plan_origin_recovery_run_id
    )"
  fi
  plan_evidence_tmp="$OUTPUT_DIR/.transition-plan-evidence.env"
  printf '%s\n' \
    'schema=betstan.ghcr-cache-transition-plan.v1' \
    "source_sha=$SOURCE_SHA" \
    "plan_origin_recovery_run_id=$plan_origin_recovery_run_id" \
    "plan_carrier_recovery_run_id=$RECOVERY_RUN_ID" \
    'plan_carrier_recovery_run_attempt=1' \
    "images_sha256=$(sha256_file "$RECOVERY_IMAGES_FILE")" \
    "infrastructure_provenance_sha256=$infrastructure_provenance_sha256" \
    "transition_plan_sha256=$transition_plan_state_sha256" \
    "rabbitmq_baseline_sha256=$rabbitmq_baseline_sha256" \
    >"$plan_evidence_tmp"
  chmod 600 "$plan_evidence_tmp"
  mv "$plan_evidence_tmp" "$TRANSITION_PLAN_EVIDENCE_FILE"
  oci_log "ghcr_cache_transition=PLAN_VERIFIED services=9 plan_origin_run_id=$plan_origin_recovery_run_id"
  exit 0
fi

while IFS=$'\t' read -r service _old_ref image_ref platform_digest transition_state; do
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  if [[ "$transition_state" == "pending" ]]; then
    if ! kubectl set image "deployment/${deployment}" \
        "${container}=${image_ref}" -n "$OCI_K8S_NAMESPACE" >/dev/null ||
        ! kubectl rollout status "deployment/${deployment}" -n "$OCI_K8S_NAMESPACE" \
          --timeout="${ROLLOUT_TIMEOUT_SECONDS}s" >/dev/null; then
      fail_transition "sequential GHCR transition failed for ${service}"
    fi
  elif [[ "$transition_state" != "already-ghcr" ]]; then
    fail_transition "transition plan contains an invalid state for ${service}"
  fi
  if ! verify_live_platform "$service" "$image_ref" "$platform_digest"; then
    fail_transition "post-rollout platform-digest verification failed for ${service}"
  fi
done <"$iteration_plan"

if [[ "$TRANSITION_PHASE" == "retire" ]]; then
  rm -f -- "$current_plan"
  [[ "$(env_value "$OUTPUT_DIR/rebind-provenance.env" schema)" == \
     "betstan.ghcr-cache-recovery-rebind.v1" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" source_sha)" == "$SOURCE_SHA" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" recovery_run_id)" == "$RECOVERY_RUN_ID" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" recovery_run_attempt)" == "1" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" images_sha256)" == \
       "$(sha256_file "$RECOVERY_IMAGES_FILE")" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" transition_plan_state_sha256)" == \
       "$transition_plan_state_sha256" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" rabbitmq_baseline_sha256)" == \
       "$(sha256_file "$OUTPUT_DIR/rabbitmq-baseline.txt")" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" transition_plan_evidence_sha256)" == \
       "$transition_plan_evidence_sha256" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" plan_origin_recovery_run_id)" == \
       "$plan_origin_recovery_run_id" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" credential_retirement)" == "pending" &&
     "$(env_value "$OUTPUT_DIR/rebind-provenance.env" transition_status)" == "REBIND_VERIFIED" ]] ||
    oci_die "credential retirement does not match the verified rebind evidence"
fi

if [[ "$TRANSITION_PHASE" == "rebind" ]]; then
  rm -f -- "$current_plan"
  {
    printf 'schema=betstan.ghcr-cache-recovery-rebind.v1\n'
    printf 'transition_workflow=oci-ghcr-cache-recovery\n'
    printf 'recovery_run_id=%s\nrecovery_run_attempt=1\n' "$RECOVERY_RUN_ID"
    printf 'source_sha=%s\nimages_sha256=%s\n' "$SOURCE_SHA" "$(sha256_file "$RECOVERY_IMAGES_FILE")"
    printf 'infrastructure_run_id=%s\ninfrastructure_run_attempt=1\n' "$infrastructure_run_id"
    printf 'infrastructure_provenance_sha256=%s\n' "$infrastructure_provenance_sha256"
    printf 'runtime_mode=k3s\nruntime_fingerprint=%s\n' "$instance_fingerprint"
    printf 'registry_provider=ghcr\nregistry_host=ghcr.io\n'
    printf 'registry_repository=ghcr.io/vasilyevstan/betstan-images\nregistry_public_anonymous=true\n'
    printf 'public_host=%s\ncanonical_host=%s\nredirect_host=%s\ndiagnostic_host=%s\n' \
      "$public_host" "$canonical_host" "$redirect_host" "$diagnostic_host"
    printf 'transition_plan_state_sha256=%s\n' "$transition_plan_state_sha256"
    printf 'rabbitmq_baseline_sha256=%s\n' "$rabbitmq_baseline_sha256"
    printf 'transition_plan_evidence_sha256=%s\n' "$transition_plan_evidence_sha256"
    printf 'plan_origin_recovery_run_id=%s\n' "$plan_origin_recovery_run_id"
    printf 'credential_retirement=pending\ntransition_status=REBIND_VERIFIED\n'
  } >"$OUTPUT_DIR/rebind-provenance.env"
  chmod 600 "$OUTPUT_DIR/rebind-provenance.env"
  oci_log "ghcr_cache_transition=REBIND_VERIFIED services=9 ocir_pull_retired=false"
  exit 0
fi

service_account_json="$(kubectl get serviceaccount default -n "$OCI_K8S_NAMESPACE" -o json)"
if jq -e '(.imagePullSecrets // []) == [{"name":"ocir-pull"}]' \
    <<<"$service_account_json" >/dev/null; then
  if ! kubectl patch serviceaccount default -n "$OCI_K8S_NAMESPACE" --type=json \
      -p='[{"op":"remove","path":"/imagePullSecrets/0"}]' >/dev/null; then
    fail_transition "could not retire the legacy OCIR service-account reference"
  fi
elif ! jq -e '((.imagePullSecrets // []) | length) == 0' \
    <<<"$service_account_json" >/dev/null; then
  fail_transition "image pull credentials changed before verified retirement"
fi
secret_json="$(
  kubectl get secret ocir-pull -n "$OCI_K8S_NAMESPACE" \
    --ignore-not-found -o json
)" || fail_transition "could not determine the OCIR pull secret state before retirement"
if [[ -n "$secret_json" ]]; then
  jq -e '.type == "kubernetes.io/dockerconfigjson"' <<<"$secret_json" >/dev/null ||
    fail_transition "ocir-pull changed before verified retirement"
  if ! kubectl delete secret ocir-pull -n "$OCI_K8S_NAMESPACE" --wait=true >/dev/null; then
    fail_transition "could not retire the exact legacy OCIR pull secret"
  fi
fi
kubectl get serviceaccount default -n "$OCI_K8S_NAMESPACE" -o json |
  jq -e '(.imagePullSecrets // []) | length == 0' >/dev/null ||
  fail_transition "default service account still has an application imagePullSecret"
remaining_secret="$(
  kubectl get secret ocir-pull -n "$OCI_K8S_NAMESPACE" \
    --ignore-not-found -o name
)" || fail_transition "could not verify OCIR pull secret retirement"
if [[ -n "$remaining_secret" ]]; then
  fail_transition "legacy OCIR pull secret still exists after credential retirement"
fi

repository_name="${OCI_IMAGE_PREFIX}_images"
repositories="$(
  oci artifacts container repository list \
    --compartment-id "$OCI_COMPARTMENT_OCID" --all
)"
repositories="$(oci_normalize_list_json "$repositories" items)"
jq -e --arg expected "$repository_name" '
  [.data.items[]? | select(."lifecycle-state" != "DELETED") | ."display-name"] |
  all(. == $expected)
' <<<"$repositories" >/dev/null ||
  fail_transition "unexpected OCIR repositories prevent bounded application-registry retirement"
repository_count="$(
  jq -r --arg expected "$repository_name" '
    [.data.items[]? |
      select(."lifecycle-state" != "DELETED" and ."display-name" == $expected)
    ] | length
  ' <<<"$repositories"
)"
((repository_count <= 1)) ||
  fail_transition "multiple OCIR application repositories match the retirement target"
if [[ "$repository_count" == "1" ]]; then
  repository_id="$(
    jq -r --arg expected "$repository_name" '
      [.data.items[]? |
        select(."lifecycle-state" != "DELETED" and ."display-name" == $expected)
      ][0].id
    ' <<<"$repositories"
  )"
  jq -e --arg expected "$repository_name" '
    [.data.items[]? |
      select(."lifecycle-state" != "DELETED" and ."display-name" == $expected)
    ] as $matches |
    ($matches | length) == 1 and
    all(
      $matches[];
      ."image-count" == 0 and ."layer-count" == 0 and
      ."layers-size-in-bytes" == 0 and ."is-public" == false
    )
  ' <<<"$repositories" >/dev/null ||
    fail_transition "OCIR application repository still contains images or layers"
  [[ "$repository_id" =~ ^ocid1\.containerrepo\.[a-z0-9.-]+$ ]] ||
    fail_transition "OCIR application repository ID is invalid"
  oci artifacts container repository delete \
    --repository-id "$repository_id" --force >/dev/null ||
    fail_transition "empty OCIR application repository deletion failed"
  repository_retired=0
  for _ in $(seq 1 30); do
    remaining="$(
      oci artifacts container repository list \
        --compartment-id "$OCI_COMPARTMENT_OCID" --all
    )"
    remaining="$(oci_normalize_list_json "$remaining" items)"
    if jq -e --arg expected "$repository_name" '
        [.data.items[]? |
          select(."lifecycle-state" != "DELETED" and ."display-name" == $expected)
        ] | length == 0
      ' <<<"$remaining" >/dev/null; then
      repository_retired=1
      break
    fi
    sleep 2
  done
  [[ "$repository_retired" == "1" ]] ||
    fail_transition "empty OCIR application repository remained after deletion"
fi

{
  printf 'schema=betstan.ghcr-cache-recovery-transition.v1\n'
  printf 'transition_workflow=oci-ghcr-cache-recovery\n'
  printf 'transition_run_id=%s\ntransition_run_attempt=1\n' "$RECOVERY_RUN_ID"
  printf 'source_sha=%s\nimages_sha256=%s\n' "$SOURCE_SHA" "$(sha256_file "$RECOVERY_IMAGES_FILE")"
  printf 'infrastructure_run_id=%s\ninfrastructure_run_attempt=1\n' "$infrastructure_run_id"
  printf 'infrastructure_provenance_sha256=%s\n' "$infrastructure_provenance_sha256"
  printf 'runtime_mode=k3s\nruntime_fingerprint=%s\n' "$instance_fingerprint"
  printf 'registry_provider=ghcr\nregistry_host=ghcr.io\n'
  printf 'registry_repository=ghcr.io/vasilyevstan/betstan-images\nregistry_public_anonymous=true\n'
  printf 'public_host=%s\ncanonical_host=%s\nredirect_host=%s\ndiagnostic_host=%s\n' \
    "$public_host" "$canonical_host" "$redirect_host" "$diagnostic_host"
  printf 'transition_plan_state_sha256=%s\n' "$transition_plan_state_sha256"
  printf 'rabbitmq_baseline_sha256=%s\ncredential_retirement=pass\n' \
    "$(sha256_file "$OUTPUT_DIR/rabbitmq-baseline.txt")"
  printf 'ocir_repository_retirement=pass\ntransition_status=PASS\n'
} >"$OUTPUT_DIR/transition-provenance.env"

(
  cd "$RECOVERY_DIR"
  : > SHA256SUMS
  for file in \
    auth.env bet.env backoffice.env client.env event.env gamemaster.env moderation.env resulting.env slip.env \
    images.tsv recovery-evidence.env transition-plan.tsv transition-plan-evidence.env \
    rabbitmq-baseline.txt rebind-provenance.env transition-provenance.env; do
    [[ -f "$file" && ! -L "$file" ]] || exit 1
    printf '%s  %s\n' "$(sha256_file "$file")" "$file" >>SHA256SUMS
  done
)
chmod 600 "$RECOVERY_DIR"/*.env "$RECOVERY_DIR"/*.tsv "$RECOVERY_DIR"/SHA256SUMS
oci_log "ghcr_cache_transition=PASS services=9 ocir_pull_retired=true ocir_repository_retired=true"
