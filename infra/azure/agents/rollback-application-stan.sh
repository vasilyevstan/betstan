#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=live-betting-readiness-lib.sh
source "$ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"
REPO="${REPO:-${GITHUB_REPOSITORY:-vasilyevstan/betstan}}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/production-rollback}"
NAMESPACE="${NAMESPACE:-default}"
TARGET_SHA="${TARGET_SHA:-}"
BASELINE_SOURCE_RUN_ID="${BASELINE_SOURCE_RUN_ID:-}"
BASELINE_SOURCE_RUN_ATTEMPT="${BASELINE_SOURCE_RUN_ATTEMPT:-1}"
BASELINE_ARTIFACT_NAME="${BASELINE_ARTIFACT_NAME:-}"
BASELINE_RETENTION_DAYS="${BASELINE_RETENTION_DAYS:-30}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-20}"
SSE_TIMEOUT="${SSE_TIMEOUT:-5}"
SSE_PATH="${SSE_PATH:-/api/event/stream}"
ROLLBACK_MODE="${ROLLBACK_MODE:-execute}"
HOSTS="${HOSTS:-}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
MAX_POST_ROLLBACK_QUEUE_READY="${MAX_POST_ROLLBACK_QUEUE_READY:-5}"
MAX_POST_ROLLBACK_QUEUE_UNACK="${MAX_POST_ROLLBACK_QUEUE_UNACK:-5}"
MAX_POST_ROLLBACK_QUEUE_READY_GROWTH="${MAX_POST_ROLLBACK_QUEUE_READY_GROWTH:-0}"
MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH="${MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH:-0}"
LIVE_BETTING_READINESS_SCRIPT="${LIVE_BETTING_READINESS_SCRIPT:-infra/azure/agents/live-betting-readiness-stan.sh}"
ROLLBACK_READINESS_SCRIPT="${ROLLBACK_READINESS_SCRIPT:-infra/azure/agents/rollback-readiness-stan.sh}"
ROLLBACK_ORDER=(auth bet backoffice client event moderation resulting slip gamemaster)
API_CONTRACTS=(
  "/|html"
  "/api/auth/currentuser|auth"
  "/api/event|prematch"
  "/api/slip|object"
  "/api/bet|object"
  "/api/bet/stats|object"
  "/api/backoffice|array"
)

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

prepare_private_dir() {
  local directory="$1"
  live_betting_prepare_private_dir "$directory" || fail "unsafe private directory: $directory"
}

validate_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

enforce_rollback_readiness_contract() {
  local summary_file="$1"
  local readiness_status readiness_mode readiness_phase readiness_operator
  [[ -f "$summary_file" ]] || fail "rollback readiness summary is missing"
  readiness_status="$(live_betting_env_file_value "$summary_file" rollback_readiness || true)"
  [[ "$readiness_status" == "GO" ]] || fail "rollback readiness summary did not authorize the rollback"
  readiness_mode="$(live_betting_env_file_value "$summary_file" mode || true)"
  readiness_phase="$(live_betting_env_file_value "$summary_file" phase || true)"
  readiness_operator="$(live_betting_env_file_value "$summary_file" rollback_operator || true)"
  case "$readiness_mode" in
    shared|legacy|application-rollback)
      ;;
    migration-transition)
      if [[ -n "$readiness_operator" ]]; then
        fail "rollback readiness entered migration-transition at phase ${readiness_phase:-unknown}; do not roll application images. Run the reviewed topology rollback operator instead: $readiness_operator"
      fi
      fail "rollback readiness entered migration-transition at phase ${readiness_phase:-unknown}; application image rollback is blocked until a reviewed topology rollback operator is provided"
      ;;
    '')
      fail "rollback readiness summary is missing mode"
      ;;
    *)
      fail "rollback readiness reported unsupported mode: $readiness_mode"
      ;;
  esac
}

validate_run_metadata() {
  local run_json_file="$1"
  local expected_workflow_id="$2"
  local expected_path="$3"
  local expected_event="$4"
  local expected_sha="$5"
  python3 - "$run_json_file" "$expected_workflow_id" "$expected_path" "$expected_event" "$expected_sha" "$REPO" "$BASELINE_RETENTION_DAYS" <<'PY'
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
    raise SystemExit('run metadata is outside the rollback retention window')
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
    raise SystemExit('trusted workflow provenance validation failed')
PY
}

validate_source_run() {
  local run_json_file="$1"
  local expected_workflow_id="$2"
  python3 - "$run_json_file" "$expected_workflow_id" "$REPO" "$BASELINE_RETENTION_DAYS" <<'PY'
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
    run.get('path') == '.github/workflows/production-deploy.yml' and
    run.get('event') == 'workflow_dispatch' and
    run.get('head_branch') == 'master' and
    ((run.get('head_repository') or {}).get('full_name') == repository) and
    run.get('status') == 'completed' and
    run.get('run_attempt') == 1
)
if not valid:
    raise SystemExit('source run is not a trusted master-dispatched production deploy')
PY
}

validate_artifact_listing() {
  local artifacts_json_file="$1"
  python3 - "$artifacts_json_file" "$BASELINE_ARTIFACT_NAME" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

artifacts = json.load(open(sys.argv[1], encoding='utf-8')).get('artifacts', [])
artifact_name = sys.argv[2]
retention_days = int(sys.argv[3])
matching = [artifact for artifact in artifacts if artifact.get('name') == artifact_name]
if len(matching) != 1:
    raise SystemExit('baseline artifact identity does not resolve to exactly one artifact')
artifact = matching[0]
if artifact.get('expired'):
    raise SystemExit('baseline artifact is expired')
created_at = artifact.get('created_at') or artifact.get('updated_at')
if not created_at:
    raise SystemExit('baseline artifact does not expose a timestamp')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=retention_days):
    raise SystemExit('baseline artifact is outside the rollback retention window')
PY
}

verify_checksums() {
  local directory="$1"
  local checksum_file="$directory/SHA256SUMS"
  [[ -f "$checksum_file" ]] || fail "baseline artifact is missing SHA256SUMS"
  while read -r checksum relative_path; do
    [[ -n "$checksum" && -n "$relative_path" ]] || continue
    relative_path="${relative_path# }"
    local actual_path="$directory/$relative_path"
    [[ -f "$actual_path" ]] || fail "baseline checksum file references a missing file: $relative_path"
    [[ "$(sha256_file "$actual_path")" == "$checksum" ]] ||
      fail "checksum mismatch for ${relative_path}"
  done <"$checksum_file"
}

load_baseline_images() {
  BASELINE_IMAGES_FILE="$1"
  local count=0
  while IFS=$'\t' read -r service _repository image_ref digest; do
    [[ -n "$service" ]] || continue
    [[ "$image_ref" =~ ^.+:[0-9a-f]{40}@sha256:[0-9a-f]{64}$ ]] ||
      fail "baseline image for ${service} must be repo:<40sha>@sha256:<64>"
    count=$((count + 1))
  done <"$BASELINE_IMAGES_FILE"
  [[ "$count" == "9" ]] || fail "baseline image provenance must contain exactly nine services"
  for service in "${ROLLBACK_ORDER[@]}"; do
    expected_ref "$service" >/dev/null
    expected_digest "$service" >/dev/null
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

expected_repository() {
  baseline_lookup "$1" 2 || fail "baseline image provenance is missing $1"
}

expected_ref() {
  baseline_lookup "$1" 3 || fail "baseline image provenance is missing $1"
}

expected_digest() {
  baseline_lookup "$1" 4 || fail "baseline image provenance is missing $1"
}

capture_pre_rollback_state() {
  local output_file="$1"
  local current_images_file="${2:-}"
  : >"$output_file"
  if [[ -n "$current_images_file" ]]; then
    : >"$current_images_file"
  fi
  local captured_source_sha=""
  for service in "${ROLLBACK_ORDER[@]}"; do
    local deployment="gaming-${service}-depl"
    local container="gaming-${service}"
    local deployment_json="$WORK_DIR/${service}-current-deployment.json"
    kubectl get deployment "$deployment" -n "$NAMESPACE" -o json >"$deployment_json"
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
    [[ -n "$image" ]] || fail "deployment ${deployment} does not declare ${container}"
    if [[ "$image" =~ ^(.+):([0-9a-f]{40})@(sha256:[0-9a-f]{64})$ ]]; then
      local repository="${BASH_REMATCH[1]}"
      local source_sha="${BASH_REMATCH[2]}"
      local digest="${BASH_REMATCH[3]}"
      if [[ -z "$captured_source_sha" ]]; then
        captured_source_sha="$source_sha"
      elif [[ "$captured_source_sha" != "$source_sha" ]]; then
        captured_source_sha="mixed"
      fi
      if [[ -n "$current_images_file" ]]; then
        printf '%s\t%s\t%s\t%s\n' "$service" "$repository" "$image" "$digest" >>"$current_images_file"
      fi
    elif [[ -n "$current_images_file" ]]; then
      fail "current deployment ${deployment} does not use an immutable SHA-tagged image"
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$service" "$deployment" "$image" "$revision" "$ready/$available" >>"$output_file"
  done
  CURRENT_LIVE_SHA="$captured_source_sha"
}

verify_exact_digest() {
  local service="$1"
  local deployment="gaming-${service}-depl"
  local container="gaming-${service}"
  local deployment_json="$WORK_DIR/${service}-verify-deployment.json"
  local pods_json="$WORK_DIR/${service}-verify-pods.json"
  kubectl get deployment "$deployment" -n "$NAMESPACE" -o json >"$deployment_json"
  kubectl get pods -n "$NAMESPACE" -l "app=${container}" -o json >"$pods_json"
  python3 - "$deployment_json" "$pods_json" "$container" "$service" "$(expected_ref "$service")" "$(expected_digest "$service")" >>"$OUTPUT_DIR/exact-digest-verification.tsv" <<'PY'
import json
import sys

deployment = json.load(open(sys.argv[1], encoding='utf-8'))
pods = json.load(open(sys.argv[2], encoding='utf-8'))
container, service, expected_ref, expected_digest = sys.argv[3:7]
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
        if not image_id.endswith('@' + expected_digest):
            raise SystemExit(f'{service}: pod {pod_name} does not serve the expected digest')
        ready_pods += 1
        print(service, pod_name, image_id, sep='\t')
if ready_pods == 0:
    raise SystemExit(f'{service}: no ready pods serve the expected digest')
PY
}

capture_http_json() {
  local host="$1"
  local path="$2"
  local expected_kind="$3"
  local body_file="$WORK_DIR/http-body"
  local headers_file="$WORK_DIR/http-headers"
  local summary_file="$WORK_DIR/http-summary.json"
  local meta status effective_url content_type shape

  meta="$({
    curl --location --silent --show-error --max-time "$REQUEST_TIMEOUT" \
      --output "$body_file" --dump-header "$headers_file" \
      --write-out '%{http_code}\t%{url_effective}\t%{content_type}' \
      "https://${host}${path}"
  })" || {
    printf 'ERROR: HTTP verification failed for %s%s\n' "$host" "$path" >&2
    return 1
  }
  IFS=$'\t' read -r status effective_url content_type <<<"$meta"
  [[ "$status" == "200" ]] || {
    printf 'ERROR: HTTP %s for %s%s\n' "$status" "$host" "$path" >&2
    return 1
  }
  case "$expected_kind" in
    auth)
      [[ "$content_type" == application/json* ]] || {
        printf 'ERROR: non-JSON auth response from %s\n' "$host" >&2
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
        printf 'ERROR: invalid auth payload for %s%s\n' "$host" "$path" >&2
        return 1
      }
      ;;
    prematch)
      [[ "$content_type" == application/json* ]] || {
        printf 'ERROR: non-JSON event response from %s\n' "$host" >&2
        return 1
      }
      if ! live_betting_write_http_summary "$body_file" "$headers_file" "$summary_file" legacy-prematch-events \
          2>"$WORK_DIR/http-summary.stderr"; then
        printf 'ERROR: invalid legacy PRE_MATCH event payload for %s\n' "$host" >&2
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
        printf 'ERROR: unable to summarize legacy PRE_MATCH event payload for %s\n' "$host" >&2
        return 1
      }
      ;;
    array)
      [[ "$content_type" == application/json* ]] || {
        printf 'ERROR: non-JSON response from %s%s\n' "$host" "$path" >&2
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
        printf 'ERROR: invalid array payload for %s%s\n' "$host" "$path" >&2
        return 1
      }
      ;;
    object)
      [[ "$content_type" == application/json* ]] || {
        printf 'ERROR: non-JSON response from %s%s\n' "$host" "$path" >&2
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
        printf 'ERROR: invalid object payload for %s%s\n' "$host" "$path" >&2
        return 1
      }
      ;;
    html)
      [[ "$content_type" == text/html* ]] || {
        printf 'ERROR: non-HTML response from %s%s\n' "$host" "$path" >&2
        return 1
      }
      shape="html"
      ;;
    *)
      printf 'ERROR: unsupported HTTP verification kind %s\n' "$expected_kind" >&2
      return 1
      ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$CURRENT_STEP_LABEL" "$host" "$path" "$status" "$effective_url" "$shape:$(sha256_file "$body_file")" \
    >>"$OUTPUT_DIR/public-verification.tsv"
}

capture_api_contracts() {
  local host="$1"
  local contract path expected_kind
  for contract in "${API_CONTRACTS[@]}"; do
    IFS='|' read -r path expected_kind <<<"$contract"
    capture_http_json "$host" "$path" "$expected_kind" || return 1
  done
}

capture_sse() {
  local host="$1"
  local body_file="$WORK_DIR/sse-body"
  local headers_file="$WORK_DIR/sse-headers"
  local status_file="$WORK_DIR/sse-status"
  local curl_status status effective_url content_type duration_seconds

  if curl --location --silent --show-error --max-time "$SSE_TIMEOUT" \
      --header 'Accept: text/event-stream' \
      --output "$body_file" --dump-header "$headers_file" \
      --write-out '%{http_code}\t%{url_effective}\t%{time_total}' \
      "https://${host}${SSE_PATH}" >"$status_file"; then
    curl_status=0
  else
    curl_status=$?
  fi
  [[ "$curl_status" == "0" || "$curl_status" == "28" ]] || {
    printf 'ERROR: SSE verification failed for %s\n' "$host" >&2
    return 1
  }
  IFS=$'\t' read -r status effective_url duration_seconds <"$status_file" || true
  live_betting_trace_sse_probe_inputs \
    "${host}${SSE_PATH}" \
    "$curl_status" \
    "$status" \
    "$duration_seconds" \
    "$SSE_TIMEOUT"
  content_type="$(
    live_betting_validate_sse_connectivity \
      "$headers_file" \
      "$body_file" \
      "$curl_status" \
      "$status" \
      "$duration_seconds" \
      "$SSE_TIMEOUT" \
      "${host}${SSE_PATH}"
  )" || {
    printf 'ERROR: SSE connectivity contract failed for %s%s\n' "$host" "$SSE_PATH" >&2
    return 1
  }
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$CURRENT_STEP_LABEL" "$host" "$status" "$effective_url" "$(sha256_file "$body_file")" \
    >>"$OUTPUT_DIR/sse-verification.tsv"
}

verify_queue_state() {
  local baseline_file="$1"
  local rabbit_pod
  local current_queue_file="$WORK_DIR/current-queues.tsv"
  rabbit_pod="$(kubectl get pod -n "$NAMESPACE" -l "$RABBIT_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [[ -n "$rabbit_pod" ]] || fail "RabbitMQ pod not found"
  kubectl exec -n "$NAMESPACE" "$rabbit_pod" -- \
    rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers >"$WORK_DIR/current-queues.raw"
  awk '
    NR == 1 {
      if ($1 != "name" || $2 != "messages_ready" || $3 != "messages_unacknowledged" || $4 != "consumers") {
        exit 2
      }
      next
    }
    NF == 4 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ {
      print $1 "\t" $2 "\t" $3 "\t" $4
    }
  ' "$WORK_DIR/current-queues.raw" >"$current_queue_file" || fail "unable to normalize queue state"
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
  local host_csv="$3"
  local readiness_output_dir="$4"
  IFS=',' read -r -a readiness_hosts <<<"$host_csv"
  local primary_host="${readiness_hosts[0]:-}"
  [[ -n "$primary_host" ]] || fail "HOSTS must contain at least one public host"
  mkdir -p "$readiness_output_dir"
  MODE=rollback-drain \
    BASE_URL="https://${primary_host}" \
    IMAGE_PROVENANCE_FILE="$images_file" \
    OUTPUT_DIR="$readiness_output_dir" \
    NAMESPACE="$NAMESPACE" \
    "$LIVE_BETTING_READINESS_SCRIPT" >"$OUTPUT_DIR/${label}.txt" 2>&1
}

capture_summary_state() {
  local state_file="$1"
  : >"$state_file"
  for service in "${ROLLBACK_ORDER[@]}"; do
    local deployment="gaming-${service}-depl"
    local container="gaming-${service}"
    local deployment_json="$WORK_DIR/${service}-summary-deployment.json"
    kubectl get deployment "$deployment" -n "$NAMESPACE" -o json >"$deployment_json" 2>/dev/null || true
    python3 - "$deployment_json" "$service" "$container" >>"$state_file" <<'PY'
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
}

prepare_private_dir "$OUTPUT_DIR"
WORK_PARENT_DIR="$OUTPUT_DIR/.workdirs"
prepare_private_dir "$WORK_PARENT_DIR"
WORK_DIR="$(live_betting_create_unique_private_dir "$WORK_PARENT_DIR" rollback)"
trap 'rm -rf -- "$WORK_DIR"; rmdir "$WORK_PARENT_DIR" 2>/dev/null || true' EXIT

for command_name in gh git kubectl curl python3 jq awk; do
  require_command "$command_name"
done
validate_positive_int "$BASELINE_SOURCE_RUN_ID" || fail "BASELINE_SOURCE_RUN_ID must be a positive integer"
[[ "$BASELINE_SOURCE_RUN_ATTEMPT" == "1" ]] || fail "BASELINE_SOURCE_RUN_ATTEMPT must be exactly 1"
validate_positive_int "$BASELINE_RETENTION_DAYS" || fail "BASELINE_RETENTION_DAYS must be positive"
[[ "$ROLLBACK_MODE" == "execute" || "$ROLLBACK_MODE" == "dry-run" ]] ||
  fail "ROLLBACK_MODE must be execute or dry-run"
[[ "$MAX_POST_ROLLBACK_QUEUE_READY" =~ ^[0-9]+$ ]] || fail "MAX_POST_ROLLBACK_QUEUE_READY must be a non-negative integer"
[[ "$MAX_POST_ROLLBACK_QUEUE_UNACK" =~ ^[0-9]+$ ]] || fail "MAX_POST_ROLLBACK_QUEUE_UNACK must be a non-negative integer"
[[ "$MAX_POST_ROLLBACK_QUEUE_READY_GROWTH" =~ ^[0-9]+$ ]] || fail "MAX_POST_ROLLBACK_QUEUE_READY_GROWTH must be a non-negative integer"
[[ "$MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH" =~ ^[0-9]+$ ]] || fail "MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH must be a non-negative integer"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "TARGET_SHA must be a full lowercase commit SHA"
expected_artifact_name="production-baseline-${BASELINE_SOURCE_RUN_ID}-${BASELINE_SOURCE_RUN_ATTEMPT}"
[[ "$BASELINE_ARTIFACT_NAME" == "$expected_artifact_name" ]] ||
  fail "BASELINE_ARTIFACT_NAME must be ${expected_artifact_name}"

if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
  [[ "$GITHUB_REF_NAME" == "master" ]] || fail "rollback must be dispatched from master"
fi
git fetch --quiet origin master:refs/remotes/origin/master
current_master_sha="$(git rev-parse origin/master)"
working_head_sha="$(git rev-parse HEAD)"
[[ "$working_head_sha" == "$current_master_sha" ]] || fail "workflow must run from the current master tip"
[[ "$TARGET_SHA" != "$current_master_sha" ]] || fail "TARGET_SHA must be historical, not current master"
git cat-file -e "${TARGET_SHA}^{commit}" || fail "TARGET_SHA is not a commit in repository history"
resolved_target_sha="$(git rev-parse "${TARGET_SHA}^{commit}")"
[[ "$resolved_target_sha" == "$TARGET_SHA" ]] || fail "TARGET_SHA must be a full immutable commit SHA"
git merge-base --is-ancestor "$TARGET_SHA" "$current_master_sha" ||
  fail "TARGET_SHA must be an ancestor of current master"

source_run_json="$WORK_DIR/source-run.json"
trusted_source_workflow_id="$(gh api "repos/$REPO/actions/workflows/production-deploy.yml" --jq '.id')"
gh api "repos/$REPO/actions/runs/$BASELINE_SOURCE_RUN_ID/attempts/$BASELINE_SOURCE_RUN_ATTEMPT" >"$source_run_json"
validate_source_run "$source_run_json" "$trusted_source_workflow_id"

artifacts_json="$WORK_DIR/source-run-artifacts.json"
gh api "repos/$REPO/actions/runs/$BASELINE_SOURCE_RUN_ID/artifacts" >"$artifacts_json"
validate_artifact_listing "$artifacts_json"

BASELINE_DIR="$OUTPUT_DIR/baseline"
prepare_private_dir "$BASELINE_DIR"
gh run download "$BASELINE_SOURCE_RUN_ID" --repo "$REPO" \
  --name "$BASELINE_ARTIFACT_NAME" --dir "$BASELINE_DIR" >/dev/null
verify_checksums "$BASELINE_DIR"
[[ -f "$BASELINE_DIR/baseline-provenance.env" ]] || fail "baseline artifact is missing baseline-provenance.env"
[[ -f "$BASELINE_DIR/images.tsv" ]] || fail "baseline artifact is missing images.tsv"
[[ -f "$BASELINE_DIR/queues.tsv" ]] || fail "baseline artifact is missing queues.tsv"
# shellcheck disable=SC1090
source "$BASELINE_DIR/baseline-provenance.env"
[[ "${baseline_source_sha:-}" == "$TARGET_SHA" ]] || fail "baseline source SHA does not match TARGET_SHA"
[[ "${baseline_deploy_run_attempt:-}" == "1" ]] || fail "baseline deploy provenance is not first-attempt"
[[ "${baseline_build_run_attempt:-}" == "1" ]] || fail "baseline build provenance is not first-attempt"
validate_positive_int "${baseline_deploy_run_id:-0}" || fail "baseline deploy provenance is missing a run ID"
validate_positive_int "${baseline_build_run_id:-0}" || fail "baseline build provenance is missing a run ID"
[[ "${database_restore:-}" == "disabled" ]] || fail "database restore must remain disabled during application rollback"
[[ -n "${hosts:-}" ]] || fail "baseline artifact is missing hosts"
[[ -n "${sse_path:-}" ]] || fail "baseline artifact is missing sse_path"
if [[ -z "$HOSTS" ]]; then
  HOSTS="$hosts"
fi
SSE_PATH="$sse_path"

build_run_json="$WORK_DIR/build-run.json"
deploy_run_json="$WORK_DIR/deploy-run.json"
trusted_build_workflow_id="$(gh api "repos/$REPO/actions/workflows/production-build.yml" --jq '.id')"
gh api "repos/$REPO/actions/runs/$baseline_build_run_id/attempts/1" >"$build_run_json"
gh api "repos/$REPO/actions/runs/$baseline_deploy_run_id/attempts/1" >"$deploy_run_json"
validate_run_metadata "$build_run_json" "$trusted_build_workflow_id" \
  '.github/workflows/production-build.yml' 'push' "$TARGET_SHA"
validate_run_metadata "$deploy_run_json" "$trusted_source_workflow_id" \
  '.github/workflows/production-deploy.yml' 'workflow_dispatch' "$TARGET_SHA"

load_baseline_images "$BASELINE_DIR/images.tsv"
: >"$OUTPUT_DIR/exact-digest-verification.tsv"
: >"$OUTPUT_DIR/public-verification.tsv"
: >"$OUTPUT_DIR/sse-verification.tsv"
: >"$OUTPUT_DIR/queue-verification.tsv"
: >"$OUTPUT_DIR/rollout-order.tsv"
cat >"$OUTPUT_DIR/queue-thresholds.env" <<EOF2
max_post_rollback_queue_ready=$MAX_POST_ROLLBACK_QUEUE_READY
max_post_rollback_queue_unack=$MAX_POST_ROLLBACK_QUEUE_UNACK
max_post_rollback_queue_ready_growth=$MAX_POST_ROLLBACK_QUEUE_READY_GROWTH
max_post_rollback_queue_unack_growth=$MAX_POST_ROLLBACK_QUEUE_UNACK_GROWTH
EOF2
CURRENT_STEP_LABEL=precheck
capture_pre_rollback_state "$OUTPUT_DIR/pre-rollback-state.tsv" "$OUTPUT_DIR/current-images.tsv"

ROLLBACK_READINESS_OUTPUT_DIR="$OUTPUT_DIR/rollback-readiness"
[[ -x "$ROLLBACK_READINESS_SCRIPT" ]] || fail "rollback readiness script is not executable: $ROLLBACK_READINESS_SCRIPT"
TARGET_SHA="$TARGET_SHA" NAMESPACE="$NAMESPACE" HOSTS="$HOSTS" OUTPUT_DIR="$ROLLBACK_READINESS_OUTPUT_DIR" \
  "$ROLLBACK_READINESS_SCRIPT" >"$OUTPUT_DIR/shared-mongo-readiness.txt" 2>&1 ||
  fail "shared-Mongo rollback readiness rejected the rollback"
enforce_rollback_readiness_contract "$ROLLBACK_READINESS_OUTPUT_DIR/summary.env"
[[ -x "$LIVE_BETTING_READINESS_SCRIPT" ]] || fail "live-betting readiness script is not executable: $LIVE_BETTING_READINESS_SCRIPT"
if ! run_live_betting_readiness \
    preflight-live-gate \
    "$OUTPUT_DIR/current-images.tsv" \
    "$HOSTS" \
    "$OUTPUT_DIR/preflight-live-readiness"; then
  fail "live-aware rollback drain gate rejected the rollback"
fi

printf '%s\n' "${ROLLBACK_ORDER[@]}" >"$OUTPUT_DIR/planned-rollout-order.txt"
if [[ "$ROLLBACK_MODE" == "dry-run" ]]; then
  cat >"$OUTPUT_DIR/rollback-summary.env" <<EOF2
status=PASS
mode=dry-run
target_sha=$TARGET_SHA
baseline_source_run_id=$BASELINE_SOURCE_RUN_ID
baseline_artifact_name=$BASELINE_ARTIFACT_NAME
database_restore=disabled
EOF2
  printf 'rollback_validation=PASS mode=dry-run target_sha=%s\n' "$TARGET_SHA"
  exit 0
fi

CURRENT_STEP_LABEL=post-apply
IFS=',' read -r -a host_list <<<"$HOSTS"
completed_services=()
for service in "${ROLLBACK_ORDER[@]}"; do
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  printf '%s\n' "$service" >>"$OUTPUT_DIR/rollout-order.tsv"
  if ! kubectl set image "deployment/${deployment}" -n "$NAMESPACE" \
      "${container}=$(expected_ref "$service")" >/dev/null; then
    CURRENT_STEP_LABEL="failed-${service}"
    capture_summary_state "$OUTPUT_DIR/partial-state.tsv"
    fail "failed to update ${deployment} to the baseline image"
  fi
  if ! kubectl rollout status "deployment/${deployment}" -n "$NAMESPACE" --timeout=5m; then
    CURRENT_STEP_LABEL="failed-${service}"
    capture_summary_state "$OUTPUT_DIR/partial-state.tsv"
    fail "rollout did not complete for ${deployment}"
  fi
  if ! verify_exact_digest "$service"; then
    CURRENT_STEP_LABEL="failed-${service}"
    capture_summary_state "$OUTPUT_DIR/partial-state.tsv"
    fail "exact digest verification failed for ${deployment}"
  fi
  for host in "${host_list[@]}"; do
    [[ -n "$host" ]] || continue
    if ! capture_api_contracts "$host"; then
      CURRENT_STEP_LABEL="failed-${service}"
      capture_summary_state "$OUTPUT_DIR/partial-state.tsv"
      fail "public API verification failed for ${host} after ${deployment}"
    fi
    if ! capture_sse "$host"; then
      CURRENT_STEP_LABEL="failed-${service}"
      capture_summary_state "$OUTPUT_DIR/partial-state.tsv"
      fail "SSE verification failed for ${host} after ${deployment}"
    fi
  done
  if ! verify_queue_state "$BASELINE_DIR/queues.tsv"; then
    CURRENT_STEP_LABEL="failed-${service}"
    capture_summary_state "$OUTPUT_DIR/partial-state.tsv"
    fail "RabbitMQ verification failed after ${deployment}"
  fi
  completed_services+=("$service")
done

CURRENT_STEP_LABEL=post-rollback-readiness
if ! run_live_betting_readiness \
    post-rollback-live-gate \
    "$BASELINE_DIR/images.tsv" \
    "$HOSTS" \
    "$OUTPUT_DIR/live-readiness"; then
  CURRENT_STEP_LABEL=failed-live-readiness
  capture_summary_state "$OUTPUT_DIR/partial-state.tsv"
  fail "post-rollback live readiness rejected the target digest set"
fi

capture_summary_state "$OUTPUT_DIR/final-state.tsv"
cat >"$OUTPUT_DIR/rollback-summary.env" <<EOF2
status=PASS
mode=execute
target_sha=$TARGET_SHA
baseline_source_run_id=$BASELINE_SOURCE_RUN_ID
baseline_artifact_name=$BASELINE_ARTIFACT_NAME
completed_services=${completed_services[*]}
database_restore=disabled
EOF2
printf 'rollback_status=PASS target_sha=%s services=%s\n' "$TARGET_SHA" "${#completed_services[@]}"
