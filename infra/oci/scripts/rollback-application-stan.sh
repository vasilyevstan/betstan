#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=application-registry.sh
source "$SCRIPT_DIR/application-registry.sh"
# shellcheck source=../../azure/agents/live-betting-readiness-lib.sh
source "$OCI_ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"

REPO="${REPO:-${GITHUB_REPOSITORY:-vasilyevstan/betstan}}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-rollback}"
TARGET_SHA="${TARGET_SHA:-}"
BASELINE_SOURCE_RUN_ID="${BASELINE_SOURCE_RUN_ID:-}"
BASELINE_SOURCE_RUN_ATTEMPT="${BASELINE_SOURCE_RUN_ATTEMPT:-1}"
BASELINE_ARTIFACT_NAME="${BASELINE_ARTIFACT_NAME:-}"
BASELINE_RETENTION_DAYS="${BASELINE_RETENTION_DAYS:-30}"
ROLLBACK_MODE="${ROLLBACK_MODE:-execute}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_PUBLIC_URL="${OCI_PUBLIC_URL:-}"
OCI_REDIRECT_URL="${OCI_REDIRECT_URL:-}"
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
OCI_INFRASTRUCTURE_PROVENANCE_FILE="${OCI_INFRASTRUCTURE_PROVENANCE_FILE:-}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-20}"
SSE_TIMEOUT="${SSE_TIMEOUT:-5}"
SSE_PATH="${SSE_PATH:-/api/event/stream}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
MAX_POST_ROLLBACK_QUEUE_READY="${MAX_POST_ROLLBACK_QUEUE_READY:-5}"
MAX_POST_ROLLBACK_QUEUE_UNACK="${MAX_POST_ROLLBACK_QUEUE_UNACK:-5}"
MAX_POST_ROLLBACK_QUEUE_READY_GROWTH="${MAX_POST_ROLLBACK_QUEUE_READY_GROWTH:-0}"
MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH="${MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH:-0}"
LIVE_BETTING_READINESS_SCRIPT="${LIVE_BETTING_READINESS_SCRIPT:-infra/oci/agents/live-betting-readiness-stan.sh}"
ROLLBACK_READINESS_SCRIPT="${ROLLBACK_READINESS_SCRIPT:-infra/oci/scripts/rollback-readiness-stan.sh}"
ROLLBACK_ORDER=(auth bet backoffice client event moderation resulting slip gamemaster)
API_CONTRACTS=(
  "/|html"
  "/api/auth/currentuser|auth"
  "/api/event|prematch"
  "/api/slip|object"
  "/api/bet|object"
  "/api/bet/stats|array"
  "/api/backoffice|array"
)

prepare_private_dir() {
  local directory="$1"
  oci_prepare_safe_private_dir "$directory"
}

create_unique_private_dir() {
  local parent="$1"
  local prefix="$2"
  python3 - "$parent" "$prefix" <<'PY'
import os
import sys
import uuid
from pathlib import Path

parent = Path(sys.argv[1])
prefix = sys.argv[2]
parent.mkdir(mode=0o700, parents=True, exist_ok=True)
for _ in range(64):
    candidate = parent / f"{prefix}-{uuid.uuid4().hex}"
    try:
        candidate.mkdir(mode=0o700)
    except FileExistsError:
        continue
    print(candidate)
    raise SystemExit(0)
raise SystemExit("unable to allocate unique private directory")
PY
}

write_text_atomic() {
  local target="$1"
  local temp_file="${target}.tmp.$$.$RANDOM"
  cat >"$temp_file"
  mv "$temp_file" "$target"
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

validate_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

enforce_rollback_readiness_contract() {
  local summary_file="$1"
  local readiness_status readiness_mode readiness_phase readiness_operator
  [[ -f "$summary_file" ]] || oci_die "rollback readiness summary is missing"
  readiness_status="$(live_betting_env_file_value "$summary_file" rollback_readiness || true)"
  [[ "$readiness_status" == "GO" ]] || oci_die "rollback readiness summary did not authorize the rollback"
  readiness_mode="$(live_betting_env_file_value "$summary_file" mode || true)"
  readiness_phase="$(live_betting_env_file_value "$summary_file" phase || true)"
  readiness_operator="$(live_betting_env_file_value "$summary_file" rollback_operator || true)"
  case "$readiness_mode" in
    shared|legacy|application-rollback)
      ;;
    migration-transition)
      if [[ -n "$readiness_operator" ]]; then
        oci_die "rollback readiness entered migration-transition at phase ${readiness_phase:-unknown}; do not roll application images. Run the reviewed topology rollback operator instead: $readiness_operator"
      fi
      oci_die "rollback readiness entered migration-transition at phase ${readiness_phase:-unknown}; application image rollback is blocked until a reviewed topology rollback operator is provided"
      ;;
    '')
      oci_die "rollback readiness summary is missing mode"
      ;;
    *)
      oci_die "rollback readiness reported unsupported mode: $readiness_mode"
      ;;
  esac
}

validate_source_run() {
  local run_json_file="$1"
  local workflow_id="$2"
  python3 - "$run_json_file" "$workflow_id" "$REPO" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

run = json.load(open(sys.argv[1], encoding='utf-8'))
workflow_id, repository, retention_days = sys.argv[2:5]
created_at = run.get('created_at') or run.get('run_started_at') or run.get('updated_at')
if not created_at:
    raise SystemExit('source run metadata is missing a timestamp')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=int(retention_days)):
    raise SystemExit('source run is outside the rollback retention window')
valid = (
    str(run.get('workflow_id', '')) == workflow_id and
    run.get('path') == '.github/workflows/oci-production-deploy.yml' and
    run.get('event') == 'workflow_dispatch' and
    run.get('head_branch') == 'master' and
    ((run.get('head_repository') or {}).get('full_name') == repository) and
    run.get('status') == 'completed' and
    run.get('run_attempt') == 1
)
if not valid:
    raise SystemExit('source run is not a trusted master-dispatched OCI deploy')
PY
}

validate_recovery_run() {
  local run_json_file="$1"
  local workflow_id="$2"
  python3 - "$run_json_file" "$workflow_id" "$REPO" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

run = json.load(open(sys.argv[1], encoding="utf-8"))
workflow_id, repository, retention_days = sys.argv[2:5]
created_at = run.get("created_at") or run.get("run_started_at") or run.get("updated_at")
if not created_at:
    raise SystemExit("recovery run metadata is missing a timestamp")
created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
if datetime.now(timezone.utc) - created > timedelta(days=int(retention_days)):
    raise SystemExit("recovery run is outside the rollback retention window")
valid = (
    str(run.get("workflow_id", "")) == workflow_id and
    run.get("path") == ".github/workflows/oci-ghcr-cache-recovery.yml" and
    run.get("event") == "workflow_dispatch" and
    run.get("head_branch") == "master" and
    ((run.get("head_repository") or {}).get("full_name") == repository) and
    run.get("status") == "completed" and
    run.get("conclusion") == "success" and
    run.get("run_attempt") == 1
)
if not valid:
    raise SystemExit("recovery run is not exact first-attempt GHCR cache recovery metadata")
PY
}

validate_recovery_transition_provenance() {
  local file="$1"
  local expected_run_id="$2"
  python3 - "$file" "$expected_run_id" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
run_id = sys.argv[2]
required = {
    "schema", "transition_workflow", "transition_run_id", "transition_run_attempt",
    "source_sha", "images_sha256", "infrastructure_run_id",
    "infrastructure_run_attempt", "infrastructure_provenance_sha256",
    "runtime_mode", "runtime_fingerprint", "registry_provider", "registry_host",
    "registry_repository", "registry_public_anonymous", "public_host",
    "canonical_host", "redirect_host", "diagnostic_host",
    "transition_plan_state_sha256", "rabbitmq_baseline_sha256",
    "credential_retirement", "ocir_repository_retirement", "transition_status",
}
if not path.is_file() or path.is_symlink():
    raise SystemExit("recovery transition provenance is missing")
values = {}
for raw in path.read_text(encoding="utf-8").splitlines():
    if not raw or "=" not in raw:
        raise SystemExit("recovery transition provenance is malformed")
    key, value = raw.split("=", 1)
    if key in values or key not in required:
        raise SystemExit("recovery transition provenance key set is invalid")
    values[key] = value
if set(values) != required:
    raise SystemExit("recovery transition provenance key set is incomplete")
if (values["schema"] != "betstan.ghcr-cache-recovery-transition.v1" or
        values["transition_workflow"] != "oci-ghcr-cache-recovery" or
        values["transition_run_id"] != run_id or
        values["transition_run_attempt"] != "1" or
        values["runtime_mode"] != "k3s" or
        values["registry_provider"] != "ghcr" or
        values["registry_host"] != "ghcr.io" or
        values["registry_repository"] != "ghcr.io/vasilyevstan/betstan-images" or
        values["registry_public_anonymous"] != "true" or
        values["credential_retirement"] != "pass" or
        values["ocir_repository_retirement"] != "pass" or
        values["transition_status"] != "PASS"):
    raise SystemExit("recovery transition provenance is not an exact completed recovery")
if not re.fullmatch(r"[0-9a-f]{40}", values["source_sha"]):
    raise SystemExit("recovery transition source SHA is invalid")
if not re.fullmatch(r"[1-9][0-9]*", values["infrastructure_run_id"]):
    raise SystemExit("recovery transition infrastructure run is invalid")
if values["infrastructure_run_attempt"] != "1":
    raise SystemExit("recovery transition infrastructure run is not first attempt")
for key in ("images_sha256", "infrastructure_provenance_sha256",
            "runtime_fingerprint", "transition_plan_state_sha256",
            "rabbitmq_baseline_sha256"):
    if not re.fullmatch(r"[0-9a-f]{64}", values[key]):
        raise SystemExit("recovery transition hash is invalid")
PY
}

validate_run_metadata() {
  local run_json_file="$1"
  local workflow_id="$2"
  local expected_path="$3"
  local expected_event="$4"
  local expected_sha="$5"
  python3 - "$run_json_file" "$workflow_id" "$expected_path" "$expected_event" "$expected_sha" "$REPO" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

run = json.load(open(sys.argv[1], encoding='utf-8'))
workflow_id, path, event, head_sha, repository, retention_days = sys.argv[2:8]
created_at = run.get('created_at') or run.get('run_started_at') or run.get('updated_at')
if not created_at:
    raise SystemExit('run metadata is missing a timestamp')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=int(retention_days)):
    raise SystemExit('run is outside the rollback retention window')
valid = (
    str(run.get('workflow_id', '')) == workflow_id and
    run.get('path') == path and
    run.get('event') == event and
    run.get('head_sha') == head_sha and
    run.get('head_branch') == 'master' and
    ((run.get('head_repository') or {}).get('full_name') == repository) and
    run.get('status') == 'completed' and
    run.get('conclusion') == 'success' and
    run.get('run_attempt') == 1
)
if not valid:
    raise SystemExit('trusted run validation failed')
PY
}

validate_artifact_listing() {
  local artifacts_file="$1"
  local expected_name="$2"
  local label="$3"
  python3 - "$artifacts_file" "$expected_name" "$label" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

artifacts = json.load(open(sys.argv[1], encoding='utf-8')).get('artifacts', [])
name = sys.argv[2]
label = sys.argv[3]
retention_days = int(sys.argv[4])
matching = [artifact for artifact in artifacts if artifact.get('name') == name]
if len(matching) != 1:
    raise SystemExit(f'{label} artifact identity does not resolve to exactly one artifact')
artifact = matching[0]
if artifact.get('expired'):
    raise SystemExit(f'{label} artifact is expired')
created_at = artifact.get('created_at') or artifact.get('updated_at')
if not created_at:
    raise SystemExit(f'{label} artifact is missing a timestamp')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=retention_days):
    raise SystemExit(f'{label} artifact is outside the rollback retention window')
PY
}

validate_evidence_env_file() {
  local file="$1"
  local label="$2"
  python3 - "$file" "$label" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
label = sys.argv[2]
if not path.is_file():
    raise SystemExit(f'{label} is missing')
keys = set()
for line_number, raw_line in enumerate(
    path.read_text(encoding='utf-8').splitlines(),
    start=1,
):
    if not raw_line:
        continue
    if '=' not in raw_line:
        raise SystemExit(f'{label} has a malformed line at {line_number}')
    key, _value = raw_line.split('=', 1)
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
        raise SystemExit(f'{label} has an invalid key at {line_number}')
    if key in keys:
        raise SystemExit(f'{label} contains duplicate key {key}')
    keys.add(key)
PY
}

evidence_value() {
  live_betting_env_file_value "$1" "$2"
}

checksum_manifest_contains_once() {
  local directory="$1"
  local relative_path="$2"
  awk -v relative_path="$relative_path" '
    {
      path = $2
      sub(/^\*/, "", path)
      if (path == relative_path) {
        count += 1
      }
    }
    END {
      exit(count == 1 ? 0 : 1)
    }
  ' "$directory/SHA256SUMS"
}

verify_checksums() {
  local directory="$1"
  local checksum_file="$directory/SHA256SUMS"
  [[ -f "$checksum_file" ]] || oci_die "baseline artifact is missing SHA256SUMS"
  while read -r checksum relative_path; do
    [[ -n "$checksum" && -n "$relative_path" ]] || continue
    relative_path="${relative_path# }"
    actual_path="$directory/$relative_path"
    [[ -f "$actual_path" ]] || oci_die "baseline checksum references a missing file: $relative_path"
    [[ "$(sha256_file "$actual_path")" == "$checksum" ]] ||
      oci_die "checksum mismatch for ${relative_path}"
  done <"$checksum_file"
}

load_baseline_images() {
  BASELINE_IMAGES_FILE="$1"
  local count=0 service repository image_ref digest platform_digest
  application_registry_require_ghcr
  while IFS=$'\t' read -r service repository image_ref digest platform_digest; do
    [[ -n "$service" ]] || continue
    [[ "$service" =~ ^(auth|bet|backoffice|client|event|gamemaster|moderation|resulting|slip)$ ]] ||
      oci_die "baseline contains an unexpected service"
    [[ "$image_ref" =~ @sha256:[0-9a-f]{64}$ ]] || oci_die "baseline image for ${service} is mutable"
    application_registry_validate_repository "$repository"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ &&
       "$platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
      oci_die "baseline image digest is invalid"
    [[ "$image_ref" == "${repository}@${digest}" ]] ||
      oci_die "baseline image reference does not bind its GHCR manifest digest"
    [[ "$repository" == "ghcr.io/vasilyevstan/betstan-images" ]] ||
      oci_die "rollback rejects legacy OCIR references after GHCR migration"
    count=$((count + 1))
  done <"$BASELINE_IMAGES_FILE"
  [[ "$count" == "9" ]] || oci_die "baseline image provenance must contain exactly nine services"
  for service in "${ROLLBACK_ORDER[@]}"; do
    expected_ref "$service" >/dev/null
    expected_manifest_digest "$service" >/dev/null
    expected_platform_digest "$service" >/dev/null
  done
}

baseline_lookup() {
  local service="$1"
  local column="$2"
  awk -F '\t' -v service="$service" -v column="$column" '
    $1 == service {
      print $column
      found = 1
      exit
    }
    END {
      if (!found) {
        exit 1
      }
    }
  ' "$BASELINE_IMAGES_FILE"
}

expected_ref() {
  baseline_lookup "$1" 3 || oci_die "baseline image provenance is missing $1"
}

expected_manifest_digest() {
  baseline_lookup "$1" 4 || oci_die "baseline image provenance is missing $1"
}

expected_platform_digest() {
  baseline_lookup "$1" 5 || oci_die "baseline image provenance is missing $1"
}

capture_pre_rollback_state() {
  local output_file="$1"
  local current_images_file="${2:-}"
  : >"$output_file"
  if [[ -n "$current_images_file" ]]; then
    : >"$current_images_file"
  fi
  for service in "${ROLLBACK_ORDER[@]}"; do
    local deployment="gaming-${service}-depl"
    local container="gaming-${service}"
    local deployment_json="$WORK_DIR/${service}-current-deployment.json"
    kubectl get deployment "$deployment" -n "$OCI_K8S_NAMESPACE" -o json >"$deployment_json"
    read -r image revision ready available < <(
      python3 - "$deployment_json" "$container" <<'PY'
import json
import sys

doc = json.load(open(sys.argv[1], encoding='utf-8'))
container = sys.argv[2]
image = ''
for item in doc.get('spec', {}).get('template', {}).get('spec', {}).get('containers', []):
    if item.get('name') == container:
        image = item.get('image', '')
        break
print(
    image,
    doc.get('metadata', {}).get('annotations', {}).get('deployment.kubernetes.io/revision', '0'),
    doc.get('status', {}).get('readyReplicas', 0),
    doc.get('status', {}).get('availableReplicas', 0),
)
PY
    )
    if [[ -n "$current_images_file" ]]; then
      if [[ "$image" =~ ^(.+)@(sha256:[0-9a-f]{64})$ ]]; then
        printf '%s\t%s\t%s\t%s\n' "$service" "${BASH_REMATCH[1]}" "$image" "${BASH_REMATCH[2]}" >>"$current_images_file"
      else
        oci_die "current deployment ${deployment} does not use an immutable digest"
      fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$service" "$deployment" "$image" "$revision" "$ready/$available" >>"$output_file"
  done
}

verify_exact_digest() {
  local service="$1"
  local deployment="gaming-${service}-depl"
  local container="gaming-${service}"
  local deployment_json="$WORK_DIR/${service}-verify-deployment.json"
  local pods_json="$WORK_DIR/${service}-verify-pods.json"
  kubectl get deployment "$deployment" -n "$OCI_K8S_NAMESPACE" -o json >"$deployment_json"
  kubectl get pods -n "$OCI_K8S_NAMESPACE" -l "app=${container}" -o json >"$pods_json"
  python3 - "$deployment_json" "$pods_json" "$container" "$service" \
    "$(expected_ref "$service")" "$(expected_manifest_digest "$service")" \
    "$(expected_platform_digest "$service")" \
    >>"$OUTPUT_DIR/exact-digest-verification.tsv" <<'PY'
import json
import sys

deployment = json.load(open(sys.argv[1], encoding='utf-8'))
pods = json.load(open(sys.argv[2], encoding='utf-8'))
container, service, expected_ref, manifest_digest, platform_digest = sys.argv[3:8]
images = [
    item.get('image', '')
    for item in deployment.get('spec', {}).get('template', {}).get('spec', {}).get('containers', [])
    if item.get('name') == container
]
if images != [expected_ref]:
    raise SystemExit(f'{service}: deployment image does not match baseline digest')
ready_pods = 0
for pod in pods.get('items', []):
    if pod.get('metadata', {}).get('deletionTimestamp') is not None:
        continue
    pod_name = pod.get('metadata', {}).get('name', '')
    for status in pod.get('status', {}).get('containerStatuses', []):
        if status.get('name') != container:
            continue
        if not status.get('ready'):
            raise SystemExit(f'{service}: pod {pod_name} is not ready')
        image_id = status.get('imageID', '')
        if not (
            image_id.endswith('@' + manifest_digest)
            or image_id.endswith('@' + platform_digest)
        ):
            raise SystemExit(
                f'{service}: pod {pod_name} does not serve the expected manifest/platform digest'
            )
        ready_pods += 1
        print(service, pod_name, image_id, sep='\t')
if ready_pods == 0:
    raise SystemExit(f'{service}: no ready pods serve the expected digest')
PY
}

capture_http() {
  local base_url="$1"
  local path="$2"
  local expected_kind="$3"
  local label="$4"
  local body_file="$WORK_DIR/http-body"
  local headers_file="$WORK_DIR/http-headers"
  local summary_file="$WORK_DIR/http-summary.json"
  local meta status effective_url content_type shape

  meta="$({
    curl --location --silent --show-error --max-time "$REQUEST_TIMEOUT" \
      --output "$body_file" --dump-header "$headers_file" \
      --write-out '%{http_code}\t%{url_effective}\t%{content_type}' \
      "${base_url}${path}"
  })" || {
    printf 'ERROR: HTTP verification failed for %s%s\n' "$base_url" "$path" >&2
    return 1
  }
  IFS=$'\t' read -r status effective_url content_type <<<"$meta"
  [[ "$status" == "200" ]] || {
    printf 'ERROR: HTTP %s for %s%s\n' "$status" "$base_url" "$path" >&2
    return 1
  }
  case "$expected_kind" in
    html)
      [[ "$content_type" == text/html* ]] || {
        printf 'ERROR: expected HTML for %s%s\n' "$base_url" "$path" >&2
        return 1
      }
      shape="html"
      ;;
    auth)
      [[ "$content_type" == application/json* ]] || {
        printf 'ERROR: expected JSON for %s%s\n' "$base_url" "$path" >&2
        return 1
      }
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, dict) or 'currentUser' not in payload:
    raise SystemExit(1)
print('object.currentUser')
PY
)" || {
        printf 'ERROR: invalid auth JSON for %s%s\n' "$base_url" "$path" >&2
        return 1
      }
      ;;
    prematch)
      [[ "$content_type" == application/json* ]] || {
        printf 'ERROR: expected JSON for %s%s\n' "$base_url" "$path" >&2
        return 1
      }
      if ! live_betting_write_http_summary "$body_file" "$headers_file" "$summary_file" legacy-prematch-events \
          2>"$WORK_DIR/http-summary.stderr"; then
        printf 'ERROR: invalid legacy PRE_MATCH event JSON for %s%s\n' "$base_url" "$path" >&2
        return 1
      fi
      shape="$(python3 - "$summary_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
print(
    "legacy-prematch:"
    f"events={payload.get('legacy_prematch_events', 0)}:"
    f"1x2={payload.get('legacy_prematch_1x2_odds', 0)}:"
    f"cs={payload.get('legacy_prematch_correct_score_odds', 0)}"
)
PY
)" || {
        printf 'ERROR: unable to summarize legacy PRE_MATCH contract for %s%s\n' "$base_url" "$path" >&2
        return 1
      }
      ;;
    array)
      [[ "$content_type" == application/json* ]] || {
        printf 'ERROR: expected JSON for %s%s\n' "$base_url" "$path" >&2
        return 1
      }
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, list):
    raise SystemExit(1)
print('array')
PY
)" || {
        printf 'ERROR: invalid array JSON for %s%s\n' "$base_url" "$path" >&2
        return 1
      }
      ;;
    object)
      [[ "$content_type" == application/json* ]] || {
        printf 'ERROR: expected JSON for %s%s\n' "$base_url" "$path" >&2
        return 1
      }
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, dict):
    raise SystemExit(1)
print('object')
PY
)" || {
        printf 'ERROR: invalid object JSON for %s%s\n' "$base_url" "$path" >&2
        return 1
      }
      ;;
    *)
      printf 'ERROR: unsupported HTTP verification kind %s\n' "$expected_kind" >&2
      return 1
      ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$CURRENT_STEP_LABEL" "$label" "$path" "$status" "$effective_url" "$shape:$(sha256_file "$body_file")" \
    >>"$OUTPUT_DIR/public-verification.tsv"
}

capture_api_contracts() {
  local base_url="$1"
  local label="$2"
  local contract path expected_kind
  for contract in "${API_CONTRACTS[@]}"; do
    IFS='|' read -r path expected_kind <<<"$contract"
    capture_http "$base_url" "$path" "$expected_kind" "$label" || return 1
  done
}

capture_sse() {
  local base_url="$1"
  local label="$2"
  local body_file="$WORK_DIR/sse-body"
  local headers_file="$WORK_DIR/sse-headers"
  local status_file="$WORK_DIR/sse-status"
  local curl_status status effective_url content_type duration_seconds

  if curl --location --silent --show-error --max-time "$SSE_TIMEOUT" \
      --header 'Accept: text/event-stream' \
      --output "$body_file" --dump-header "$headers_file" \
      --write-out '%{http_code}\t%{url_effective}\t%{time_total}' \
      "${base_url}${SSE_PATH}" >"$status_file"; then
    curl_status=0
  else
    curl_status=$?
  fi
  [[ "$curl_status" == "0" || "$curl_status" == "28" ]] || {
    printf 'ERROR: SSE verification failed for %s\n' "$label" >&2
    return 1
  }
  IFS=$'\t' read -r status effective_url duration_seconds <"$status_file" || true
  live_betting_trace_sse_probe_inputs \
    "${base_url}${SSE_PATH}" \
    "$curl_status" \
    "$status" \
    "$duration_seconds" \
    "$SSE_TIMEOUT"
  if [[ "$SSE_REQUIRED" == "false" && "$curl_status" == "0" &&
      ( "$status" == "404" || "$status" == "502" ) ]]; then
    content_type="legacy-absent"
  else
    content_type="$(
      live_betting_validate_sse_connectivity \
        "$headers_file" \
        "$body_file" \
        "$curl_status" \
        "$status" \
        "$duration_seconds" \
        "$SSE_TIMEOUT" \
        "${base_url}${SSE_PATH}"
    )" || {
      printf 'ERROR: SSE connectivity contract failed for %s%s\n' "$label" "$SSE_PATH" >&2
      return 1
    }
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$CURRENT_STEP_LABEL" "$label" "$status" "$effective_url" "$(sha256_file "$body_file")" \
    >>"$OUTPUT_DIR/sse-verification.tsv"
}

verify_queue_state() {
  local baseline_file="$1"
  local rabbit_pod current_queue_file
  current_queue_file="$WORK_DIR/current-queues.tsv"
  rabbit_pod="$(kubectl get pod -n "$OCI_K8S_NAMESPACE" -l "$RABBIT_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [[ -n "$rabbit_pod" ]] || {
    printf 'ERROR: RabbitMQ pod not found\n' >&2
    return 1
  }
  kubectl exec -n "$OCI_K8S_NAMESPACE" "$rabbit_pod" -- \
    rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers >"$WORK_DIR/current-queues.raw"
  oci_rabbitmq_queue_rows <"$WORK_DIR/current-queues.raw" >"$current_queue_file" || {
    printf 'ERROR: unable to normalize RabbitMQ queue state\n' >&2
    return 1
  }
  live_betting_compare_queue_snapshots \
    "$baseline_file" \
    "$current_queue_file" \
    "$CURRENT_STEP_LABEL" \
    "$MAX_POST_ROLLBACK_QUEUE_READY" \
    "$MAX_POST_ROLLBACK_QUEUE_UNACK" \
    "$MAX_POST_ROLLBACK_QUEUE_READY_GROWTH" \
    "$MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH" \
    "${REQUIRED_LIVE_QUEUE_PREFIXES:-event_live_update.}" \
    "${MIN_DYNAMIC_LIVE_QUEUE_CONSUMERS:-1}" \
    >>"$OUTPUT_DIR/queue-verification.tsv"
}

run_live_betting_readiness() {
  local label="$1"
  local images_file="$2"
  local readiness_output_dir="$3"
  mkdir -p "$readiness_output_dir"
  MODE=rollback-drain \
    BASE_URL="$OCI_PUBLIC_URL" \
    SECONDARY_PUBLIC_URL="$OCI_REDIRECT_URL" \
    DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
    OCI_PUBLIC_URL="$OCI_PUBLIC_URL" \
    OCI_REDIRECT_URL="$OCI_REDIRECT_URL" \
    OCI_DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
    IMAGE_PROVENANCE_FILE="$images_file" \
    OUTPUT_DIR="$readiness_output_dir" \
    OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
    NAMESPACE="$OCI_K8S_NAMESPACE" \
    SSE_REQUIRED="$SSE_REQUIRED" \
    "$LIVE_BETTING_READINESS_SCRIPT" >"$OUTPUT_DIR/${label}.txt" 2>&1
}

capture_summary_state() {
  local state_file="$1"
  local service deployment container deployment_json
  local temp_state_file="${state_file}.tmp.$$.$RANDOM"
  : >"$temp_state_file"
  for service in "${ROLLBACK_ORDER[@]}"; do
    deployment="gaming-${service}-depl"
    container="gaming-${service}"
    deployment_json="$WORK_DIR/${service}-summary-deployment.json"
    kubectl get deployment "$deployment" -n "$OCI_K8S_NAMESPACE" -o json >"$deployment_json" 2>/dev/null || true
    python3 - "$deployment_json" "$service" "$container" >>"$temp_state_file" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
service, container = sys.argv[2:4]
if not path.exists() or path.stat().st_size == 0:
    print(service, 'missing', sep='\t')
    raise SystemExit(0)
try:
    doc = json.load(open(path, encoding='utf-8'))
except json.JSONDecodeError:
    print(service, 'invalid-json', sep='\t')
    raise SystemExit(0)
image = ''
for item in doc.get('spec', {}).get('template', {}).get('spec', {}).get('containers', []):
    if item.get('name') == container:
        image = item.get('image', '')
        break
print(service, image, doc.get('metadata', {}).get('annotations', {}).get('deployment.kubernetes.io/revision', '0'), sep='\t')
PY
  done
  mv "$temp_state_file" "$state_file"
}

record_partial_failure() {
  local service="$1"
  local deployment="$2"
  local stage="$3"
  local message="$4"
  CURRENT_STEP_LABEL="failed-${service}"
  capture_summary_state "$OUTPUT_DIR/partial-state.tsv"
  write_text_atomic "$OUTPUT_DIR/failure-state.env" <<EOF
status=FAIL
failed_service=$service
failed_deployment=$deployment
failed_stage=$stage
failed_step_label=$CURRENT_STEP_LABEL
message=$message
EOF
}

cleanup_work_dir() {
  rm -rf "$WORK_DIR"
  rmdir "$WORK_PARENT_DIR" 2>/dev/null || true
}

prepare_private_dir "$OUTPUT_DIR"
WORK_PARENT_DIR="$OUTPUT_DIR/.workdirs"
prepare_private_dir "$WORK_PARENT_DIR"
WORK_DIR="$(create_unique_private_dir "$WORK_PARENT_DIR" rollback)"
trap cleanup_work_dir EXIT

oci_require_command gh
oci_require_command git
oci_require_command kubectl
oci_require_command curl
oci_require_command python3
oci_require_command jq
validate_positive_int "$BASELINE_SOURCE_RUN_ID" || oci_die "BASELINE_SOURCE_RUN_ID must be positive"
[[ "$BASELINE_SOURCE_RUN_ATTEMPT" == "1" ]] || oci_die "BASELINE_SOURCE_RUN_ATTEMPT must be exactly 1"
validate_positive_int "$BASELINE_RETENTION_DAYS" || oci_die "BASELINE_RETENTION_DAYS must be positive"
[[ "$ROLLBACK_MODE" == "execute" || "$ROLLBACK_MODE" == "dry-run" ]] ||
  oci_die "ROLLBACK_MODE must be execute or dry-run"
[[ "$MAX_POST_ROLLBACK_QUEUE_READY" =~ ^[0-9]+$ ]] || oci_die "MAX_POST_ROLLBACK_QUEUE_READY must be a non-negative integer"
[[ "$MAX_POST_ROLLBACK_QUEUE_UNACK" =~ ^[0-9]+$ ]] || oci_die "MAX_POST_ROLLBACK_QUEUE_UNACK must be a non-negative integer"
[[ "$MAX_POST_ROLLBACK_QUEUE_READY_GROWTH" =~ ^[0-9]+$ ]] || oci_die "MAX_POST_ROLLBACK_QUEUE_READY_GROWTH must be a non-negative integer"
[[ "$MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH" =~ ^[0-9]+$ ]] || oci_die "MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH must be a non-negative integer"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || oci_die "TARGET_SHA must be a full lowercase commit SHA"
expected_artifact_name="oci-production-baseline-${BASELINE_SOURCE_RUN_ID}-${BASELINE_SOURCE_RUN_ATTEMPT}"
[[ "$BASELINE_ARTIFACT_NAME" == "$expected_artifact_name" ]] ||
  oci_die "BASELINE_ARTIFACT_NAME must be ${expected_artifact_name}"
[[ "$OCI_PUBLIC_URL" == https://* && "$OCI_REDIRECT_URL" == https://* ]] ||
  oci_die "OCI public URLs must use https://"

if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
  [[ "$GITHUB_REF_NAME" == "master" ]] || oci_die "rollback must be dispatched from master"
fi
git fetch --quiet origin master:refs/remotes/origin/master
current_master_sha="$(git rev-parse origin/master)"
working_head_sha="$(git rev-parse HEAD)"
[[ "$working_head_sha" == "$current_master_sha" ]] || oci_die "workflow must run from the current master tip"
[[ "$TARGET_SHA" != "$current_master_sha" ]] || oci_die "TARGET_SHA must be historical, not current master"
git cat-file -e "${TARGET_SHA}^{commit}" || oci_die "TARGET_SHA is not a commit in repository history"
resolved_target_sha="$(git rev-parse "${TARGET_SHA}^{commit}")"
[[ "$resolved_target_sha" == "$TARGET_SHA" ]] || oci_die "TARGET_SHA must be a full immutable commit SHA"
git merge-base --is-ancestor "$TARGET_SHA" "$current_master_sha" ||
  oci_die "TARGET_SHA must be an ancestor of current master"

ADMIN_AUTH_EVIDENCE_PATHS=(
  "backoffice/src/middleware/RequireAdmin.ts"
  "backoffice/src/service/VerifyAdminSession.ts"
)
admin_auth_evidence_present=true
for admin_auth_evidence_path in "${ADMIN_AUTH_EVIDENCE_PATHS[@]}"; do
  git cat-file -e "${TARGET_SHA}:${admin_auth_evidence_path}" 2>/dev/null ||
    admin_auth_evidence_present=false
done
if [[ "$admin_auth_evidence_present" == "true" ]]; then
  ADMIN_AUTH_ROLLBACK_CHECK=persisted-admin-evidence
else
  ADMIN_AUTH_CAPABILITY_FILE="${ADMIN_AUTH_CAPABILITY_FILE:-}"
  [[ -n "$ADMIN_AUTH_CAPABILITY_FILE" ]] ||
    oci_die "TARGET_SHA is missing persisted-admin Backoffice authorization evidence and no ADMIN_AUTH_CAPABILITY_FILE was supplied"
  [[ -f "$ADMIN_AUTH_CAPABILITY_FILE" ]] ||
    oci_die "ADMIN_AUTH_CAPABILITY_FILE does not exist"
  admin_auth_capability="$(live_betting_first_env_value "$ADMIN_AUTH_CAPABILITY_FILE" capability)"
  admin_auth_source_sha="$(live_betting_first_env_value "$ADMIN_AUTH_CAPABILITY_FILE" source_sha)"
  admin_auth_reason="$(live_betting_first_env_value "$ADMIN_AUTH_CAPABILITY_FILE" reason)"
  admin_auth_approved_by="$(live_betting_first_env_value "$ADMIN_AUTH_CAPABILITY_FILE" approved_by)"
  [[ "$admin_auth_capability" == "legacy-admin-auth-accepted" ]] ||
    oci_die "ADMIN_AUTH_CAPABILITY_FILE capability must be legacy-admin-auth-accepted"
  [[ "$admin_auth_source_sha" == "$TARGET_SHA" ]] ||
    oci_die "ADMIN_AUTH_CAPABILITY_FILE source_sha does not match TARGET_SHA"
  [[ -n "$admin_auth_reason" ]] ||
    oci_die "ADMIN_AUTH_CAPABILITY_FILE reason must be non-empty"
  [[ -n "$admin_auth_approved_by" ]] ||
    oci_die "ADMIN_AUTH_CAPABILITY_FILE approved_by must be non-empty"
  ADMIN_AUTH_ROLLBACK_CHECK=explicit-capability-override
fi

source_run_json="$WORK_DIR/source-run.json"
trusted_source_workflow_id="$(gh api "repos/$REPO/actions/workflows/oci-production-deploy.yml" --jq '.id')"
gh api "repos/$REPO/actions/runs/$BASELINE_SOURCE_RUN_ID/attempts/$BASELINE_SOURCE_RUN_ATTEMPT" >"$source_run_json"
validate_source_run "$source_run_json" "$trusted_source_workflow_id"

artifacts_json="$WORK_DIR/source-run-artifacts.json"
gh api "repos/$REPO/actions/runs/$BASELINE_SOURCE_RUN_ID/artifacts" >"$artifacts_json"
validate_artifact_listing \
  "$artifacts_json" \
  "$BASELINE_ARTIFACT_NAME" \
  "baseline"

BASELINE_DIR="$OUTPUT_DIR/baseline"
prepare_private_dir "$BASELINE_DIR"
gh run download "$BASELINE_SOURCE_RUN_ID" --repo "$REPO" \
  --name "$BASELINE_ARTIFACT_NAME" --dir "$BASELINE_DIR" >/dev/null
BASELINE_DIR="$BASELINE_DIR" \
EXPECTED_SOURCE_SHA="$TARGET_SHA" \
EXPECTED_NAMESPACE="$OCI_K8S_NAMESPACE" \
  "$SCRIPT_DIR/validate-rollback-baseline-stan.sh" >/dev/null
verify_checksums "$BASELINE_DIR"
[[ -f "$BASELINE_DIR/baseline-provenance.env" ]] || oci_die "baseline artifact is missing baseline-provenance.env"
[[ -f "$BASELINE_DIR/images.tsv" ]] || oci_die "baseline artifact is missing images.tsv"
[[ -f "$BASELINE_DIR/queues.tsv" ]] || oci_die "baseline artifact is missing queues.tsv"
validate_evidence_env_file \
  "$BASELINE_DIR/baseline-provenance.env" \
  "baseline-provenance.env"
baseline_source_sha="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_source_sha
)" || oci_die "baseline provenance is missing baseline_source_sha"
baseline_deploy_workflow="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_deploy_workflow
)" || oci_die "baseline provenance is missing baseline_deploy_workflow"
baseline_deploy_run_id="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_deploy_run_id
)" || oci_die "baseline deploy provenance is missing a run ID"
baseline_deploy_run_attempt="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_deploy_run_attempt
)" || oci_die "baseline deploy provenance is missing a run attempt"
baseline_build_workflow="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_build_workflow
)" || oci_die "baseline provenance is missing baseline_build_workflow"
baseline_build_run_id="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_build_run_id
)" || oci_die "baseline build provenance is missing a run ID"
baseline_build_run_attempt="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_build_run_attempt
)" || oci_die "baseline build provenance is missing a run attempt"
baseline_recovery_run_id="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_recovery_run_id || true
)"
baseline_recovery_run_attempt="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_recovery_run_attempt || true
)"
baseline_transition_provenance_file="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_transition_provenance_file || true
)"
baseline_capture_run_id="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_capture_run_id
)" || oci_die "baseline provenance is missing baseline_capture_run_id"
baseline_capture_run_attempt="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" baseline_capture_run_attempt
)" || oci_die "baseline provenance is missing baseline_capture_run_attempt"
baseline_namespace="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" namespace
)" || oci_die "baseline provenance is missing namespace"
public_url="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" public_url
)" || oci_die "baseline artifact is missing public_url"
redirect_url="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" redirect_url
)" || oci_die "baseline artifact is missing redirect_url"
diagnostic_url="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" diagnostic_url || true
)"
sse_path="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" sse_path || true
)"
sse_required="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" sse_required || true
)"
database_restore="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" database_restore
)" || oci_die "baseline provenance is missing database_restore"
baseline_registry_provider="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" registry_provider
)" || oci_die "baseline provenance is missing registry_provider"
baseline_registry_host="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" registry_host
)" || oci_die "baseline provenance is missing registry_host"
baseline_registry_repository="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" registry_repository
)" || oci_die "baseline provenance is missing registry_repository"
baseline_registry_public_anonymous="$(
  evidence_value "$BASELINE_DIR/baseline-provenance.env" registry_public_anonymous
)" || oci_die "baseline provenance is missing registry_public_anonymous"

[[ "$baseline_source_sha" == "$TARGET_SHA" ]] || oci_die "baseline source SHA does not match TARGET_SHA"
[[ "$baseline_deploy_workflow" == "oci-production-deploy" ||
   "$baseline_deploy_workflow" == "oci-ghcr-cache-recovery" ]] ||
  oci_die "baseline deploy workflow is not trusted"
[[ "$baseline_deploy_run_attempt" == "1" ]] || oci_die "baseline deploy provenance is not first-attempt"
[[ "$baseline_build_workflow" == "oci-production-build" ]] ||
  oci_die "baseline build workflow is not trusted"
[[ "$baseline_build_run_attempt" == "1" ]] || oci_die "baseline build provenance is not first-attempt"
validate_positive_int "$baseline_deploy_run_id" || oci_die "baseline deploy provenance is missing a run ID"
validate_positive_int "$baseline_build_run_id" || oci_die "baseline build provenance is missing a run ID"
if [[ "$baseline_deploy_workflow" == "oci-ghcr-cache-recovery" ]]; then
  [[ "$baseline_recovery_run_id" == "$baseline_deploy_run_id" &&
     "$baseline_recovery_run_attempt" == "1" &&
     "$baseline_transition_provenance_file" == "trusted-recovery-transition-provenance.env" ]] ||
    oci_die "recovery baseline does not bind the exact first-attempt transition evidence"
else
  [[ ( -z "$baseline_recovery_run_id" &&
       -z "$baseline_recovery_run_attempt" &&
       -z "$baseline_transition_provenance_file" ) ||
     ( "$baseline_recovery_run_id" == "0" &&
       "$baseline_recovery_run_attempt" == "0" &&
       "$baseline_transition_provenance_file" == "none" ) ]] ||
    oci_die "ordinary deploy baseline carries unauthorized recovery authority"
fi
validate_positive_int "$baseline_capture_run_id" ||
  oci_die "baseline provenance is missing a capture run ID"
[[ "$baseline_capture_run_attempt" == "1" ]] ||
  oci_die "baseline capture provenance is not first-attempt"
[[ "$baseline_namespace" == "$OCI_K8S_NAMESPACE" ]] ||
  oci_die "baseline namespace does not match the selected namespace"
[[ "$database_restore" == "disabled" ]] || oci_die "database restore must remain disabled"
[[ "$baseline_registry_provider" == "ghcr" &&
   "$baseline_registry_host" == "ghcr.io" &&
   "$baseline_registry_repository" == "ghcr.io/vasilyevstan/betstan-images" &&
   "$baseline_registry_public_anonymous" == "true" ]] ||
  oci_die "rollback baseline is not a public GHCR generation"
[[ "$public_url" == https://* && "$redirect_url" == https://* ]] ||
  oci_die "baseline artifact public URLs must use https://"
if [[ -z "$OCI_PUBLIC_URL" ]]; then
  OCI_PUBLIC_URL="$public_url"
else
  [[ "$OCI_PUBLIC_URL" == "$public_url" ]] || oci_die "OCI_PUBLIC_URL does not match the trusted baseline public URL"
fi
if [[ -z "$OCI_REDIRECT_URL" ]]; then
  OCI_REDIRECT_URL="$redirect_url"
else
  [[ "$OCI_REDIRECT_URL" == "$redirect_url" ]] || oci_die "OCI_REDIRECT_URL does not match the trusted baseline redirect URL"
fi
if [[ -z "$OCI_DIAGNOSTIC_URL" ]]; then
  OCI_DIAGNOSTIC_URL="${diagnostic_url:-}"
elif [[ -n "${diagnostic_url:-}" ]]; then
  [[ "$OCI_DIAGNOSTIC_URL" == "$diagnostic_url" ]] || oci_die "OCI_DIAGNOSTIC_URL does not match the trusted baseline diagnostic URL"
fi
if [[ -n "${sse_path:-}" ]]; then
  SSE_PATH="$sse_path"
fi
SSE_REQUIRED="${sse_required:-true}"
[[ "$SSE_REQUIRED" == "true" || "$SSE_REQUIRED" == "false" ]] ||
  oci_die "baseline sse_required must be true or false"

trusted_build_workflow_id="$(gh api "repos/$REPO/actions/workflows/oci-production-build.yml" --jq '.id')"
build_run_json="$WORK_DIR/build-run.json"
gh api "repos/$REPO/actions/runs/$baseline_build_run_id/attempts/1" >"$build_run_json"
if [[ "$baseline_deploy_workflow" == "oci-ghcr-cache-recovery" ]]; then
  trusted_recovery_workflow_id="$(
    gh api "repos/$REPO/actions/workflows/oci-ghcr-cache-recovery.yml" --jq '.id'
  )"
  recovery_run_json="$WORK_DIR/recovery-run.json"
  gh api "repos/$REPO/actions/runs/$baseline_deploy_run_id/attempts/1" >"$recovery_run_json"
  validate_recovery_run "$recovery_run_json" "$trusted_recovery_workflow_id"
else
  deploy_run_json="$WORK_DIR/deploy-run.json"
  gh api "repos/$REPO/actions/runs/$baseline_deploy_run_id/attempts/1" >"$deploy_run_json"
  validate_run_metadata "$deploy_run_json" "$trusted_source_workflow_id" \
    '.github/workflows/oci-production-deploy.yml' 'workflow_dispatch' "$TARGET_SHA"
fi
validate_run_metadata "$build_run_json" "$trusted_build_workflow_id" \
  '.github/workflows/oci-production-build.yml' 'workflow_run' "$TARGET_SHA"

load_baseline_images "$BASELINE_DIR/images.tsv"

INFRASTRUCTURE_RUN_ID="${INFRASTRUCTURE_RUN_ID:-}"
OCI_INFRASTRUCTURE_PROVENANCE_SHA256="${OCI_INFRASTRUCTURE_PROVENANCE_SHA256:-}"
OCI_RUNTIME_FINGERPRINT="${OCI_RUNTIME_FINGERPRINT:-}"
validate_positive_int "$INFRASTRUCTURE_RUN_ID" || oci_die "INFRASTRUCTURE_RUN_ID must be positive"
[[ "$OCI_INFRASTRUCTURE_PROVENANCE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "OCI_INFRASTRUCTURE_PROVENANCE_SHA256 must be a sha256 hex digest"
[[ "$OCI_RUNTIME_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "OCI_RUNTIME_FINGERPRINT must be a sha256 hex digest"
[[ -f "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" ]] ||
  oci_die "OCI_INFRASTRUCTURE_PROVENANCE_FILE is missing"
validate_evidence_env_file \
  "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" \
  "selected infrastructure provenance"
selected_infrastructure_run_id="$(
  evidence_value "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" infrastructure_run_id
)" || oci_die "selected infrastructure provenance is missing infrastructure_run_id"
selected_infrastructure_run_attempt="$(
  evidence_value "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" infrastructure_run_attempt
)" || oci_die "selected infrastructure provenance is missing infrastructure_run_attempt"
selected_infrastructure_runtime_mode="$(
  evidence_value "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" runtime_mode
)" || oci_die "selected infrastructure provenance is missing runtime_mode"
selected_infrastructure_namespace="$(
  evidence_value "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" namespace
)" || oci_die "selected infrastructure provenance is missing namespace"
case "$selected_infrastructure_runtime_mode" in
  oke)
    selected_infrastructure_runtime_fingerprint="$(
      evidence_value "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" cluster_fingerprint
    )" || oci_die "selected OKE infrastructure provenance is missing cluster_fingerprint"
    ;;
  k3s)
    selected_infrastructure_runtime_fingerprint="$(
      evidence_value "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" instance_fingerprint
    )" || oci_die "selected k3s infrastructure provenance is missing instance_fingerprint"
    ;;
  *)
    oci_die "selected infrastructure provenance runtime_mode is invalid"
    ;;
esac
validate_positive_int "$selected_infrastructure_run_id" ||
  oci_die "selected infrastructure provenance run ID is invalid"
[[ "$selected_infrastructure_run_attempt" == "1" ]] ||
  oci_die "selected infrastructure provenance is not first-attempt"
[[ "$selected_infrastructure_runtime_fingerprint" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "selected infrastructure provenance runtime fingerprint is invalid"
[[ "$selected_infrastructure_namespace" == "$OCI_K8S_NAMESPACE" ]] ||
  oci_die "selected infrastructure provenance namespace does not match"

if [[ "$baseline_deploy_workflow" == "oci-ghcr-cache-recovery" ]]; then
  ORIGINAL_DEPLOY_PROVENANCE_FILE="$BASELINE_DIR/$baseline_transition_provenance_file"
  checksum_manifest_contains_once "$BASELINE_DIR" "$baseline_transition_provenance_file" ||
    oci_die "embedded recovery transition provenance is not covered exactly once by baseline checksums"
  validate_recovery_transition_provenance \
    "$ORIGINAL_DEPLOY_PROVENANCE_FILE" "$baseline_deploy_run_id"

  deploy_source_sha="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" source_sha)"
  deployment_run_id="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" transition_run_id)"
  deployment_run_attempt="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" transition_run_attempt)"
  runtime_mode="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" runtime_mode)"
  runtime_fingerprint="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" runtime_fingerprint)"
  image_provenance_sha256="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" images_sha256)"
  rabbitmq_baseline_sha256="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" rabbitmq_baseline_sha256)"
  deploy_public_host="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" public_host)"
  deploy_canonical_host="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" canonical_host)"
  deploy_redirect_host="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" redirect_host)"
  deploy_diagnostic_host="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" diagnostic_host)"
  deploy_registry_provider="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" registry_provider)"
  deploy_registry_host="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" registry_host)"
  deploy_registry_repository="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" registry_repository)"
  deploy_registry_public_anonymous="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" registry_public_anonymous)"
  infrastructure_run_id="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" infrastructure_run_id)"
  infrastructure_run_attempt="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" infrastructure_run_attempt)"
  infrastructure_provenance_sha256="$(evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" infrastructure_provenance_sha256)"

  [[ "$deploy_source_sha" == "$TARGET_SHA" &&
     "$deployment_run_id" == "$baseline_deploy_run_id" &&
     "$deployment_run_attempt" == "1" &&
     "$image_provenance_sha256" == "$(sha256_file "$BASELINE_DIR/images.tsv")" &&
     "$runtime_mode" == "k3s" &&
     "$runtime_fingerprint" =~ ^[0-9a-f]{64}$ &&
     "$deploy_registry_provider" == "ghcr" &&
     "$deploy_registry_host" == "ghcr.io" &&
     "$deploy_registry_repository" == "ghcr.io/vasilyevstan/betstan-images" &&
     "$deploy_registry_public_anonymous" == "true" ]] ||
    oci_die "recovery transition provenance does not bind the selected GHCR rollback baseline"
  [[ "$deploy_public_host" == "$deploy_canonical_host" &&
     "$public_url" == "https://${deploy_canonical_host}" &&
     "$redirect_url" == "https://${deploy_redirect_host}" ]] ||
    oci_die "recovery transition endpoints do not match the rollback baseline"
  if [[ -n "$diagnostic_url" ]]; then
    [[ "$diagnostic_url" == "https://${deploy_diagnostic_host}" ]] ||
      oci_die "recovery transition diagnostic endpoint does not match the rollback baseline"
  fi
  DEPLOY_PROVENANCE_ORIGIN=recovery-transition
  DEPLOY_PROVENANCE_BINDING=recorded-recovery-infrastructure
  # Recovery evidence stays in its dedicated schema; it is never reconstructed
  # or augmented as an ordinary oci-production-deploy artifact.
  NORMALIZED_DEPLOY_PROVENANCE_FILE="$ORIGINAL_DEPLOY_PROVENANCE_FILE"
else
ORIGINAL_DEPLOY_PROVENANCE_FILE="$BASELINE_DIR/trusted-deploy-provenance.txt"
DEPLOY_PROVENANCE_ORIGIN=baseline-embedded
if [[ -f "$ORIGINAL_DEPLOY_PROVENANCE_FILE" ]]; then
  checksum_manifest_contains_once "$BASELINE_DIR" "trusted-deploy-provenance.txt" ||
    oci_die "embedded trusted deploy provenance is not covered exactly once by baseline checksums"
else
  DEPLOY_PROVENANCE_ORIGIN=reconstructed-exact-deploy-artifact
  deploy_artifact_name="oci-deploy-provenance-${baseline_deploy_run_id}-1"
  deploy_artifacts_json="$WORK_DIR/deploy-run-artifacts.json"
  gh api "repos/$REPO/actions/runs/$baseline_deploy_run_id/artifacts" >"$deploy_artifacts_json"
  validate_artifact_listing \
    "$deploy_artifacts_json" \
    "$deploy_artifact_name" \
    "deploy provenance"
  DEPLOY_PROVENANCE_DIR="$WORK_DIR/deploy-provenance"
  prepare_private_dir "$DEPLOY_PROVENANCE_DIR"
  gh run download "$baseline_deploy_run_id" --repo "$REPO" \
    --name "$deploy_artifact_name" --dir "$DEPLOY_PROVENANCE_DIR" >/dev/null
  [[ -z "$(find "$DEPLOY_PROVENANCE_DIR" -type l -print -quit)" ]] ||
    oci_die "deploy provenance artifact must not contain symbolic links"
  [[ -f "$DEPLOY_PROVENANCE_DIR/provenance.txt" ]] ||
    oci_die "deploy provenance artifact is missing provenance.txt"
  [[ -f "$DEPLOY_PROVENANCE_DIR/images.tsv" ]] ||
    oci_die "deploy provenance artifact is missing images.tsv"
  [[ -f "$DEPLOY_PROVENANCE_DIR/rabbitmq-baseline.txt" ]] ||
    oci_die "deploy provenance artifact is missing rabbitmq-baseline.txt"
  [[ "$(sha256_file "$DEPLOY_PROVENANCE_DIR/images.tsv")" == \
     "$(sha256_file "$BASELINE_DIR/images.tsv")" ]] ||
    oci_die "recovered deploy provenance images do not match the rollback baseline"
  ORIGINAL_DEPLOY_PROVENANCE_FILE="$DEPLOY_PROVENANCE_DIR/provenance.txt"
fi

validate_evidence_env_file \
  "$ORIGINAL_DEPLOY_PROVENANCE_FILE" \
  "trusted deploy provenance"
deploy_source_sha="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" source_sha
)" || oci_die "trusted deploy provenance is missing source_sha"
deployment_workflow="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" deployment_workflow || true
)"
deployment_run_id="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" deployment_run_id
)" || oci_die "trusted deploy provenance is missing deployment_run_id"
deployment_run_attempt="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" deployment_run_attempt
)" || oci_die "trusted deploy provenance is missing deployment_run_attempt"
runtime_mode="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" runtime_mode
)" || oci_die "trusted deploy provenance is missing runtime_mode"
runtime_fingerprint="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" runtime_fingerprint
)" || oci_die "trusted deploy provenance is missing runtime_fingerprint"
image_provenance_sha256="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" image_provenance_sha256
)" || oci_die "trusted deploy provenance is missing image_provenance_sha256"
rabbitmq_baseline_sha256="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" rabbitmq_baseline_sha256
)" || oci_die "trusted deploy provenance is missing rabbitmq_baseline_sha256"
rendered_manifest_sha256="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" rendered_manifest_sha256
)" || oci_die "trusted deploy provenance is missing rendered_manifest_sha256"
deploy_public_host="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" public_host
)" || oci_die "trusted deploy provenance is missing public_host"
deploy_canonical_host="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" canonical_host
)" || oci_die "trusted deploy provenance is missing canonical_host"
deploy_redirect_host="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" redirect_host
)" || oci_die "trusted deploy provenance is missing redirect_host"
deploy_diagnostic_host="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" diagnostic_host
)" || oci_die "trusted deploy provenance is missing diagnostic_host"
deploy_registry_provider="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" registry_provider
)" || oci_die "trusted deploy provenance is missing registry_provider"
deploy_registry_host="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" registry_host
)" || oci_die "trusted deploy provenance is missing registry_host"
deploy_registry_repository="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" registry_repository
)" || oci_die "trusted deploy provenance is missing registry_repository"
deploy_registry_public_anonymous="$(
  evidence_value "$ORIGINAL_DEPLOY_PROVENANCE_FILE" registry_public_anonymous
)" || oci_die "trusted deploy provenance is missing registry_public_anonymous"

[[ "$deploy_source_sha" == "$TARGET_SHA" ]] ||
  oci_die "trusted deploy provenance source SHA does not match TARGET_SHA"
if [[ -n "$deployment_workflow" ]]; then
  [[ "$deployment_workflow" == "oci-production-deploy" ]] ||
    oci_die "trusted deploy provenance workflow identity is invalid"
else
  [[ "$DEPLOY_PROVENANCE_ORIGIN" == "baseline-embedded" ||
     "$DEPLOY_PROVENANCE_ORIGIN" == "reconstructed-exact-deploy-artifact" ]] ||
    oci_die "only a previously trusted exact deploy artifact may omit deployment_workflow"
fi
[[ "$deployment_run_id" == "$baseline_deploy_run_id" ]] ||
  oci_die "trusted deploy provenance run does not match baseline provenance"
[[ "$deployment_run_attempt" == "1" ]] ||
  oci_die "trusted deploy provenance is not first-attempt"
[[ "$runtime_mode" == "oke" || "$runtime_mode" == "k3s" ]] ||
  oci_die "trusted deploy provenance runtime_mode is invalid"
[[ "$runtime_fingerprint" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "trusted deploy provenance is missing a runtime fingerprint"
[[ "$image_provenance_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "trusted deploy provenance is missing an image provenance hash"
[[ "$rabbitmq_baseline_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "trusted deploy provenance is missing a RabbitMQ baseline hash"
[[ "$rendered_manifest_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "trusted deploy provenance is missing a rendered manifest hash"
[[ "$image_provenance_sha256" == "$(sha256_file "$BASELINE_DIR/images.tsv")" ]] ||
  oci_die "trusted deploy provenance image hash does not match the rollback baseline"
[[ "$deploy_registry_provider" == "ghcr" &&
   "$deploy_registry_host" == "ghcr.io" &&
   "$deploy_registry_repository" == "ghcr.io/vasilyevstan/betstan-images" &&
   "$deploy_registry_public_anonymous" == "true" ]] ||
  oci_die "trusted deploy provenance does not authorize public GHCR rollback"
if [[ "$DEPLOY_PROVENANCE_ORIGIN" == "reconstructed-exact-deploy-artifact" ]]; then
  [[ "$rabbitmq_baseline_sha256" == \
     "$(sha256_file "$DEPLOY_PROVENANCE_DIR/rabbitmq-baseline.txt")" ]] ||
    oci_die "recovered deploy provenance RabbitMQ hash is invalid"
fi
[[ "$deploy_public_host" == "$deploy_canonical_host" ]] ||
  oci_die "trusted deploy provenance public and canonical hosts differ"
[[ "$public_url" == "https://${deploy_canonical_host}" ]] ||
  oci_die "trusted deploy provenance canonical host does not match the baseline"
[[ "$redirect_url" == "https://${deploy_redirect_host}" ]] ||
  oci_die "trusted deploy provenance redirect host does not match the baseline"
if [[ -n "$diagnostic_url" ]]; then
  [[ "$diagnostic_url" == "https://${deploy_diagnostic_host}" ]] ||
    oci_die "trusted deploy provenance diagnostic host does not match the baseline"
fi

recorded_infrastructure_fields=0
for infrastructure_key in \
  infrastructure_run_id \
  infrastructure_run_attempt \
  infrastructure_provenance_sha256; do
  if evidence_value \
      "$ORIGINAL_DEPLOY_PROVENANCE_FILE" \
      "$infrastructure_key" >/dev/null; then
    recorded_infrastructure_fields=$((recorded_infrastructure_fields + 1))
  fi
done

NORMALIZED_DEPLOY_PROVENANCE_FILE="$OUTPUT_DIR/trusted-deploy-provenance.txt"
if [[ "$recorded_infrastructure_fields" == "0" ]]; then
  DEPLOY_PROVENANCE_BINDING=legacy-runtime-fingerprint
  [[ "$OCI_RUNTIME_FINGERPRINT" == "$runtime_fingerprint" ]] ||
    oci_die "selected runtime fingerprint does not match the legacy trusted deploy provenance"
  if [[ -n "${OCI_RUNTIME_MODE:-}" ]]; then
    [[ "$OCI_RUNTIME_MODE" == "$runtime_mode" ]] ||
      oci_die "selected runtime mode does not match the legacy trusted deploy provenance"
  fi
  {
    cat "$ORIGINAL_DEPLOY_PROVENANCE_FILE"
    printf '\n'
    printf 'infrastructure_run_id=%s\n' "$INFRASTRUCTURE_RUN_ID"
    printf 'infrastructure_run_attempt=1\n'
    printf 'infrastructure_provenance_sha256=%s\n' \
      "$OCI_INFRASTRUCTURE_PROVENANCE_SHA256"
    printf 'infrastructure_binding=legacy-runtime-fingerprint\n'
    printf 'original_deploy_provenance_sha256=%s\n' \
      "$(sha256_file "$ORIGINAL_DEPLOY_PROVENANCE_FILE")"
  } | write_text_atomic "$NORMALIZED_DEPLOY_PROVENANCE_FILE"
elif [[ "$recorded_infrastructure_fields" == "3" ]]; then
  DEPLOY_PROVENANCE_BINDING=recorded-infrastructure
  write_text_atomic "$NORMALIZED_DEPLOY_PROVENANCE_FILE" \
    <"$ORIGINAL_DEPLOY_PROVENANCE_FILE"
else
  oci_die "trusted deploy provenance has incomplete infrastructure binding"
fi
fi
chmod 600 "$NORMALIZED_DEPLOY_PROVENANCE_FILE"
validate_evidence_env_file \
  "$NORMALIZED_DEPLOY_PROVENANCE_FILE" \
  "normalized trusted deploy provenance"
infrastructure_run_id="$(
  evidence_value "$NORMALIZED_DEPLOY_PROVENANCE_FILE" infrastructure_run_id
)" || oci_die "trusted deploy provenance is missing an infrastructure run ID"
infrastructure_run_attempt="$(
  evidence_value "$NORMALIZED_DEPLOY_PROVENANCE_FILE" infrastructure_run_attempt
)" || oci_die "trusted deploy provenance is missing an infrastructure run attempt"
infrastructure_provenance_sha256="$(
  evidence_value "$NORMALIZED_DEPLOY_PROVENANCE_FILE" infrastructure_provenance_sha256
)" || oci_die "trusted deploy provenance is missing an infrastructure provenance hash"
validate_positive_int "$infrastructure_run_id" ||
  oci_die "trusted deploy provenance is missing an infrastructure run ID"
[[ "$infrastructure_run_attempt" == "1" ]] ||
  oci_die "trusted deploy provenance infrastructure run is not first-attempt"
[[ "$infrastructure_provenance_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  oci_die "trusted deploy provenance is missing an infrastructure provenance hash"
[[ "$INFRASTRUCTURE_RUN_ID" == "$infrastructure_run_id" ]] ||
  oci_die "selected infrastructure run does not match the trusted baseline infrastructure run"
[[ "$OCI_INFRASTRUCTURE_PROVENANCE_SHA256" == "$infrastructure_provenance_sha256" ]] ||
  oci_die "selected infrastructure provenance hash does not match the trusted baseline"
[[ "$OCI_RUNTIME_FINGERPRINT" == "$runtime_fingerprint" ]] ||
  oci_die "selected runtime fingerprint does not match the trusted baseline"
if [[ -n "${OCI_RUNTIME_MODE:-}" ]]; then
  [[ "$OCI_RUNTIME_MODE" == "$runtime_mode" ]] ||
    oci_die "selected runtime mode does not match the trusted baseline"
fi
[[ "$(sha256_file "$OCI_INFRASTRUCTURE_PROVENANCE_FILE")" == \
   "$OCI_INFRASTRUCTURE_PROVENANCE_SHA256" ]] ||
  oci_die "selected infrastructure provenance file hash does not match"
[[ "$selected_infrastructure_run_id" == "$INFRASTRUCTURE_RUN_ID" ]] ||
  oci_die "selected infrastructure provenance file has the wrong run ID"
[[ "$selected_infrastructure_runtime_mode" == "$runtime_mode" ]] ||
  oci_die "selected infrastructure provenance runtime mode does not match the trusted baseline"
[[ "$selected_infrastructure_runtime_fingerprint" == "$OCI_RUNTIME_FINGERPRINT" ]] ||
  oci_die "selected infrastructure provenance runtime fingerprint does not match"

write_text_atomic "$OUTPUT_DIR/deploy-provenance-binding.env" <<EOF2
origin=$DEPLOY_PROVENANCE_ORIGIN
binding=$DEPLOY_PROVENANCE_BINDING
source_sha=$deploy_source_sha
deployment_run_id=$deployment_run_id
deployment_run_attempt=$deployment_run_attempt
infrastructure_run_id=$infrastructure_run_id
infrastructure_run_attempt=$infrastructure_run_attempt
infrastructure_provenance_sha256=$infrastructure_provenance_sha256
runtime_mode=$runtime_mode
runtime_fingerprint=$runtime_fingerprint
original_deploy_provenance_sha256=$(sha256_file "$ORIGINAL_DEPLOY_PROVENANCE_FILE")
normalized_deploy_provenance_sha256=$(sha256_file "$NORMALIZED_DEPLOY_PROVENANCE_FILE")
EOF2
: >"$OUTPUT_DIR/exact-digest-verification.tsv"
: >"$OUTPUT_DIR/public-verification.tsv"
: >"$OUTPUT_DIR/sse-verification.tsv"
: >"$OUTPUT_DIR/queue-verification.tsv"
: >"$OUTPUT_DIR/rollout-order.tsv"
write_text_atomic "$OUTPUT_DIR/queue-thresholds.env" <<EOF2
max_post_rollback_queue_ready=$MAX_POST_ROLLBACK_QUEUE_READY
max_post_rollback_queue_unack=$MAX_POST_ROLLBACK_QUEUE_UNACK
max_post_rollback_queue_ready_growth=$MAX_POST_ROLLBACK_QUEUE_READY_GROWTH
max_post_rollback_queue_unack_growth=$MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH
EOF2
CURRENT_STEP_LABEL=precheck
capture_pre_rollback_state "$OUTPUT_DIR/pre-rollback-state.tsv" "$OUTPUT_DIR/current-images.tsv"

ROLLBACK_READINESS_OUTPUT_DIR="$OUTPUT_DIR/rollback-readiness"
[[ -x "$ROLLBACK_READINESS_SCRIPT" ]] || oci_die "rollback readiness script is not executable: $ROLLBACK_READINESS_SCRIPT"
if ! TARGET_SHA="$TARGET_SHA" \
    OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
    OCI_PUBLIC_URL="$OCI_PUBLIC_URL" \
    OCI_REDIRECT_URL="$OCI_REDIRECT_URL" \
    OCI_DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
    OUTPUT_DIR="$ROLLBACK_READINESS_OUTPUT_DIR" \
    "$ROLLBACK_READINESS_SCRIPT" >"$OUTPUT_DIR/rollback-readiness.txt" 2>&1; then
  oci_die "OCI rollback readiness rejected the rollback"
fi
enforce_rollback_readiness_contract "$ROLLBACK_READINESS_OUTPUT_DIR/summary.env"
[[ -x "$LIVE_BETTING_READINESS_SCRIPT" ]] || oci_die "live-betting readiness script is not executable: $LIVE_BETTING_READINESS_SCRIPT"
if ! run_live_betting_readiness \
    preflight-live-gate \
    "$OUTPUT_DIR/current-images.tsv" \
    "$OUTPUT_DIR/preflight-live-readiness"; then
  oci_die "live-aware rollback drain gate rejected the rollback"
fi

printf '%s\n' "${ROLLBACK_ORDER[@]}" >"$OUTPUT_DIR/planned-rollout-order.txt"
if [[ "$ROLLBACK_MODE" == "dry-run" ]]; then
  write_text_atomic "$OUTPUT_DIR/rollback-summary.env" <<EOF2
status=PASS
mode=dry-run
target_sha=$TARGET_SHA
baseline_source_run_id=$BASELINE_SOURCE_RUN_ID
baseline_artifact_name=$BASELINE_ARTIFACT_NAME
infrastructure_run_id=$INFRASTRUCTURE_RUN_ID
deploy_provenance_origin=$DEPLOY_PROVENANCE_ORIGIN
deploy_provenance_binding=$DEPLOY_PROVENANCE_BINDING
admin_auth_rollback_check=$ADMIN_AUTH_ROLLBACK_CHECK
database_restore=disabled
EOF2
  oci_log "oci_rollback_validation=PASS mode=dry-run target_sha=$TARGET_SHA"
  exit 0
fi

CURRENT_STEP_LABEL=post-apply
url_entries=("canonical|$OCI_PUBLIC_URL" "redirect|$OCI_REDIRECT_URL")
if [[ -n "$OCI_DIAGNOSTIC_URL" ]]; then
  url_entries+=("diagnostic|$OCI_DIAGNOSTIC_URL")
fi
completed_services=()
for service in "${ROLLBACK_ORDER[@]}"; do
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  printf '%s\n' "$service" >>"$OUTPUT_DIR/rollout-order.tsv"
  if ! kubectl set image "deployment/${deployment}" -n "$OCI_K8S_NAMESPACE" \
      "${container}=$(expected_ref "$service")" >/dev/null; then
    record_partial_failure "$service" "$deployment" set-image "failed to update ${deployment} to the baseline image"
    oci_die "failed to update ${deployment} to the baseline image"
  fi
  if ! kubectl rollout status "deployment/${deployment}" -n "$OCI_K8S_NAMESPACE" --timeout=10m; then
    record_partial_failure "$service" "$deployment" rollout-status "rollout did not complete for ${deployment}"
    oci_die "rollout did not complete for ${deployment}"
  fi
  if ! verify_exact_digest "$service"; then
    record_partial_failure "$service" "$deployment" exact-digest "exact digest verification failed for ${deployment}"
    oci_die "exact digest verification failed for ${deployment}"
  fi
  for entry in "${url_entries[@]}"; do
    IFS='|' read -r label base_url <<<"$entry"
    if ! capture_api_contracts "$base_url" "$label"; then
      record_partial_failure "$service" "$deployment" public-api "public API verification failed for ${label} after ${deployment}"
      oci_die "public API verification failed for ${label} after ${deployment}"
    fi
    if ! capture_sse "$base_url" "$label"; then
      record_partial_failure "$service" "$deployment" sse "SSE verification failed for ${label} after ${deployment}"
      oci_die "SSE verification failed for ${label} after ${deployment}"
    fi
  done
  if ! verify_queue_state "$BASELINE_DIR/queues.tsv"; then
    record_partial_failure "$service" "$deployment" rabbitmq "RabbitMQ verification failed after ${deployment}"
    oci_die "RabbitMQ verification failed after ${deployment}"
  fi
  completed_services+=("$service")
done

CURRENT_STEP_LABEL=post-rollback-readiness
if ! run_live_betting_readiness \
    post-rollback-live-gate \
    "$BASELINE_DIR/images.tsv" \
    "$OUTPUT_DIR/live-readiness"; then
  CURRENT_STEP_LABEL=failed-live-readiness
  capture_summary_state "$OUTPUT_DIR/partial-state.tsv"
  write_text_atomic "$OUTPUT_DIR/failure-state.env" <<EOF
status=FAIL
failed_service=post-rollback
failed_deployment=live-readiness
failed_stage=post-rollback-readiness
failed_step_label=$CURRENT_STEP_LABEL
message=post-rollback live readiness rejected the target digest set
EOF
  oci_die "post-rollback live readiness rejected the target digest set"
fi

capture_summary_state "$OUTPUT_DIR/final-state.tsv"
write_text_atomic "$OUTPUT_DIR/rollback-summary.env" <<EOF2
status=PASS
mode=execute
target_sha=$TARGET_SHA
baseline_source_run_id=$BASELINE_SOURCE_RUN_ID
baseline_artifact_name=$BASELINE_ARTIFACT_NAME
infrastructure_run_id=$INFRASTRUCTURE_RUN_ID
deploy_provenance_origin=$DEPLOY_PROVENANCE_ORIGIN
deploy_provenance_binding=$DEPLOY_PROVENANCE_BINDING
admin_auth_rollback_check=$ADMIN_AUTH_ROLLBACK_CHECK
completed_services=${completed_services[*]}
database_restore=disabled
EOF2
oci_log "oci_rollback_status=PASS target_sha=$TARGET_SHA services=${#completed_services[@]}"
