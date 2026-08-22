#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=../../azure/agents/live-betting-readiness-lib.sh
source "$OCI_ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"

REPO="${REPO:-${GITHUB_REPOSITORY:-vasilyevstan/betstan}}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-baseline}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_PUBLIC_URL="${OCI_PUBLIC_URL:-https://betstan.xyz}"
OCI_REDIRECT_URL="${OCI_REDIRECT_URL:-https://www.betstan.xyz}"
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-20}"
SSE_TIMEOUT="${SSE_TIMEOUT:-5}"
BASELINE_RETENTION_DAYS="${BASELINE_RETENTION_DAYS:-30}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
MIGRATION_STATE_CONFIGMAP="${MIGRATION_STATE_CONFIGMAP:-betstan-oci-migration-journal}"
MIGRATION_LOCK_CONFIGMAP="${MIGRATION_LOCK_CONFIGMAP:-betstan-oci-migration-lock}"
MIGRATION_EVIDENCE_REFERENCE="${MIGRATION_EVIDENCE_REFERENCE:-}"
RUN_LOOKBACK="${RUN_LOOKBACK:-40}"
ROLLBACK_SERVICES=(auth bet backoffice client event gamemaster moderation resulting slip)
API_CONTRACTS=(
  "/|html"
  "/api/auth/currentuser|auth"
  "/api/event|prematch"
  "/api/slip|object"
  "/api/bet|object"
  "/api/bet/stats|array"
  "/api/backoffice|array"
)
SSE_PATH="${SSE_PATH:-/api/event/stream}"

prepare_private_dir() {
  local directory="$1"
  oci_prepare_safe_private_dir "$directory"
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

capture_configmap() {
  local name="$1"
  local output_file="$2"
  if kubectl get configmap "$name" -n "$OCI_K8S_NAMESPACE" -o json >"$output_file" 2>/dev/null; then
    :
  else
    printf '{"present":false,"name":"%s"}\n' "$name" >"$output_file"
  fi
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
  })" || oci_die "HTTP probe failed for ${base_url}${path}"
  IFS=$'\t' read -r status effective_url content_type <<<"$meta"
  [[ "$status" == "200" ]] || oci_die "expected HTTP 200 for ${base_url}${path}, got ${status}"
  case "$expected_kind" in
    html)
      [[ "$content_type" == text/html* ]] || oci_die "expected HTML for ${base_url}${path}"
      shape="html"
      ;;
    auth)
      [[ "$content_type" == application/json* ]] || oci_die "expected JSON for ${base_url}${path}"
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, dict) or 'currentUser' not in payload:
    raise SystemExit(1)
print('object.currentUser')
PY
)" || oci_die "invalid auth JSON for ${base_url}${path}"
      ;;
    prematch)
      [[ "$content_type" == application/json* ]] || oci_die "expected JSON for ${base_url}${path}"
      if ! live_betting_write_http_summary "$body_file" "$headers_file" "$summary_file" legacy-prematch-events \
          2>"$WORK_DIR/http-summary.stderr"; then
        oci_die "invalid legacy PRE_MATCH event JSON for ${base_url}${path}"
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
)" || oci_die "unable to summarize legacy PRE_MATCH contract for ${base_url}${path}"
      ;;
    array)
      [[ "$content_type" == application/json* ]] || oci_die "expected JSON for ${base_url}${path}"
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, list):
    raise SystemExit(1)
print('array')
PY
)" || oci_die "invalid array JSON for ${base_url}${path}"
      ;;
    object)
      [[ "$content_type" == application/json* ]] || oci_die "expected JSON for ${base_url}${path}"
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, dict):
    raise SystemExit(1)
print('object')
PY
)" || oci_die "invalid object JSON for ${base_url}${path}"
      ;;
    *)
      oci_die "unsupported HTTP expectation: $expected_kind"
      ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$path" "$status" "$effective_url" "$content_type" "$shape:$(sha256_file "$body_file")" \
    >>"$OUTPUT_DIR/public-http.tsv"
}

capture_api_contracts() {
  local base_url="$1"
  local label="$2"
  local contract path expected_kind
  for contract in "${API_CONTRACTS[@]}"; do
    IFS='|' read -r path expected_kind <<<"$contract"
    capture_http "$base_url" "$path" "$expected_kind" "$label"
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
  [[ "$curl_status" == "0" || "$curl_status" == "28" ]] ||
    oci_die "SSE probe failed for ${base_url}${SSE_PATH}"
  IFS=$'\t' read -r status effective_url duration_seconds <"$status_file" || true
  live_betting_trace_sse_probe_inputs \
    "${base_url}${SSE_PATH}" \
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
      "${base_url}${SSE_PATH}"
  )" || oci_die "SSE connectivity contract failed for ${base_url}${SSE_PATH}"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$status" "$effective_url" "$content_type" "$(sha256_file "$body_file")" \
    >>"$OUTPUT_DIR/sse.tsv"
}

validate_deploy_metadata() {
  local metadata_file="$1"
  local workflow_id="$2"
  python3 - "$metadata_file" "$workflow_id" "$REPO" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

run = json.load(open(sys.argv[1], encoding='utf-8'))
workflow_id, repository, retention_days = sys.argv[2:5]
created_at = run.get('created_at') or run.get('run_started_at') or run.get('updated_at')
if not created_at:
    raise SystemExit('deploy run metadata is missing a timestamp')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=int(retention_days)):
    raise SystemExit('deploy run is outside the rollback retention window')
valid = (
    str(run.get('workflow_id', '')) == workflow_id and
    run.get('path') == '.github/workflows/oci-production-deploy.yml' and
    run.get('event') == 'workflow_dispatch' and
    run.get('head_branch') == 'master' and
    ((run.get('head_repository') or {}).get('full_name') == repository) and
    run.get('status') == 'completed' and
    run.get('conclusion') == 'success' and
    run.get('run_attempt') == 1
)
if not valid:
    raise SystemExit('deploy run is not trusted OCI production deploy provenance')
PY
}

validate_build_metadata() {
  local metadata_file="$1"
  local workflow_id="$2"
  local source_sha="$3"
  python3 - "$metadata_file" "$workflow_id" "$source_sha" "$REPO" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

run = json.load(open(sys.argv[1], encoding='utf-8'))
workflow_id, source_sha, repository, retention_days = sys.argv[2:6]
created_at = run.get('created_at') or run.get('run_started_at') or run.get('updated_at')
if not created_at:
    raise SystemExit('build run metadata is missing a timestamp')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=int(retention_days)):
    raise SystemExit('build run is outside the rollback retention window')
valid = (
    str(run.get('workflow_id', '')) == workflow_id and
    run.get('path') == '.github/workflows/oci-production-build.yml' and
    run.get('event') == 'workflow_run' and
    run.get('head_sha') == source_sha and
    run.get('head_branch') == 'master' and
    ((run.get('head_repository') or {}).get('full_name') == repository) and
    run.get('status') == 'completed' and
    run.get('conclusion') == 'success' and
    run.get('run_attempt') == 1
)
if not valid:
    raise SystemExit('build run is not trusted OCI build provenance')
PY
}

validate_artifact_listing() {
  local artifacts_file="$1"
  local artifact_name="$2"
  python3 - "$artifacts_file" "$artifact_name" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

artifacts = json.load(open(sys.argv[1], encoding='utf-8')).get('artifacts', [])
name = sys.argv[2]
retention_days = int(sys.argv[3])
matching = [artifact for artifact in artifacts if artifact.get('name') == name]
if len(matching) != 1:
    raise SystemExit('artifact identity does not resolve to exactly one artifact')
artifact = matching[0]
if artifact.get('expired'):
    raise SystemExit('artifact is expired')
created_at = artifact.get('created_at') or artifact.get('updated_at')
if not created_at:
    raise SystemExit('artifact timestamp is missing')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=retention_days):
    raise SystemExit('artifact is outside the rollback retention window')
PY
}

compare_live_images() {
  local candidate_images_file="$1"
  python3 - "$candidate_images_file" "$OUTPUT_DIR/live-images.tsv" <<'PY'
import sys
from pathlib import Path

candidate = {}
for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines():
    if not line:
        continue
    service, _repository, image_ref, _digest, _platform_digest = line.split('\t')
    candidate[service] = image_ref
live = {}
for line in Path(sys.argv[2]).read_text(encoding='utf-8').splitlines():
    if not line:
        continue
    service, image_ref = line.split('\t')
    live[service] = image_ref
if candidate != live:
    raise SystemExit(1)
PY
}

prepare_private_dir "$OUTPUT_DIR"
WORK_PARENT_DIR="$OUTPUT_DIR/.workdirs"
prepare_private_dir "$WORK_PARENT_DIR"
WORK_DIR="$(live_betting_create_unique_private_dir "$WORK_PARENT_DIR" baseline)"
trap 'rm -rf -- "$WORK_DIR"; rmdir "$WORK_PARENT_DIR" 2>/dev/null || true' EXIT

oci_require_command gh
oci_require_command git
oci_require_command kubectl
oci_require_command curl
oci_require_command python3
oci_require_command jq
validate_positive_int "$BASELINE_RETENTION_DAYS" || oci_die "BASELINE_RETENTION_DAYS must be positive"
validate_positive_int "$RUN_LOOKBACK" || oci_die "RUN_LOOKBACK must be positive"
[[ "$OCI_PUBLIC_URL" == https://* ]] || oci_die "OCI_PUBLIC_URL must be https://"
[[ "$OCI_REDIRECT_URL" == https://* ]] || oci_die "OCI_REDIRECT_URL must be https://"
[[ "$OCI_DIAGNOSTIC_URL" == https://* ]] || oci_die "OCI_DIAGNOSTIC_URL must be https://"

: >"$OUTPUT_DIR/live-images.tsv"
: >"$OUTPUT_DIR/deployments.tsv"
for service in "${ROLLBACK_SERVICES[@]}"; do
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  deployment_json="$WORK_DIR/${service}-deployment.json"
  kubectl get deployment "$deployment" -n "$OCI_K8S_NAMESPACE" -o json >"$deployment_json"
  read -r image revision desired ready updated available < <(
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
    doc.get('spec', {}).get('replicas', 0),
    doc.get('status', {}).get('readyReplicas', 0),
    doc.get('status', {}).get('updatedReplicas', 0),
    doc.get('status', {}).get('availableReplicas', 0),
)
PY
  )
  [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || oci_die "deployment ${deployment} does not use an immutable digest"
  printf '%s\t%s\n' "$service" "$image" >>"$OUTPUT_DIR/live-images.tsv"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$service" "$image" "$revision" "$desired" "$ready" "$available" >>"$OUTPUT_DIR/deployments.tsv"
done

trusted_deploy_workflow_id="$(gh api "repos/$REPO/actions/workflows/oci-production-deploy.yml" --jq '.id')"
trusted_build_workflow_id="$(gh api "repos/$REPO/actions/workflows/oci-production-build.yml" --jq '.id')"
runs_json="$WORK_DIR/deploy-runs.json"
gh run list --repo "$REPO" --workflow oci-production-deploy.yml \
  --limit "$RUN_LOOKBACK" --json databaseId,createdAt,status,conclusion >"$runs_json"
python3 - "$runs_json" "$BASELINE_RETENTION_DAYS" >"$WORK_DIR/deploy-candidates.txt" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

runs = json.load(open(sys.argv[1], encoding='utf-8'))
retention_days = int(sys.argv[2])
for run in runs:
    if run.get('status') != 'completed' or run.get('conclusion') != 'success':
        continue
    created_at = run.get('createdAt') or run.get('created_at')
    if not created_at:
        continue
    created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
    if datetime.now(timezone.utc) - created <= timedelta(days=retention_days):
        print(run.get('databaseId'))
PY

matched_deploy_run_id=""
matched_source_sha=""
matched_build_run_id=""
while IFS= read -r run_id; do
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || continue
  metadata_file="$WORK_DIR/deploy-run-${run_id}.json"
  gh api "repos/$REPO/actions/runs/$run_id/attempts/1" >"$metadata_file"
  if ! validate_deploy_metadata "$metadata_file" "$trusted_deploy_workflow_id"; then
    continue
  fi
  artifact_name="oci-deploy-provenance-${run_id}-1"
  artifacts_file="$WORK_DIR/deploy-run-${run_id}-artifacts.json"
  gh api "repos/$REPO/actions/runs/$run_id/artifacts" >"$artifacts_file"
  if ! validate_artifact_listing "$artifacts_file" "$artifact_name"; then
    continue
  fi
  candidate_dir="$WORK_DIR/candidate-${run_id}"
  prepare_private_dir "$candidate_dir"
  gh run download "$run_id" --repo "$REPO" --name "$artifact_name" --dir "$candidate_dir" >/dev/null
  candidate_images_file="$(find "$candidate_dir" -type f -name images.tsv | head -n 1)"
  candidate_provenance_file="$(find "$candidate_dir" -type f -name provenance.txt | head -n 1)"
  [[ -f "$candidate_images_file" && -f "$candidate_provenance_file" ]] || continue
  if ! compare_live_images "$candidate_images_file"; then
    continue
  fi
  matched_source_sha="$(sed -n 's/^source_sha=//p' "$candidate_provenance_file")"
  [[ "$matched_source_sha" =~ ^[0-9a-f]{40}$ ]] || continue
  matched_deploy_run_id="$run_id"
  cp "$candidate_images_file" "$OUTPUT_DIR/images.tsv"
  cp "$candidate_provenance_file" "$OUTPUT_DIR/trusted-deploy-provenance.txt"
  break
done <"$WORK_DIR/deploy-candidates.txt"

[[ -n "$matched_deploy_run_id" ]] || oci_die "unable to find trusted OCI deploy provenance for the live digest set"

build_runs_json="$WORK_DIR/build-runs.json"
gh run list --repo "$REPO" --workflow oci-production-build.yml \
  --commit "$matched_source_sha" --limit 20 \
  --json databaseId,createdAt,status,conclusion >"$build_runs_json"
python3 - "$build_runs_json" "$BASELINE_RETENTION_DAYS" >"$WORK_DIR/build-candidates.txt" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

runs = json.load(open(sys.argv[1], encoding='utf-8'))
retention_days = int(sys.argv[2])
for run in runs:
    if run.get('status') != 'completed' or run.get('conclusion') != 'success':
        continue
    created_at = run.get('createdAt') or run.get('created_at')
    if not created_at:
        continue
    created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
    if datetime.now(timezone.utc) - created <= timedelta(days=retention_days):
        print(run.get('databaseId'))
PY

while IFS= read -r run_id; do
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || continue
  metadata_file="$WORK_DIR/build-run-${run_id}.json"
  gh api "repos/$REPO/actions/runs/$run_id/attempts/1" >"$metadata_file"
  if validate_build_metadata "$metadata_file" "$trusted_build_workflow_id" "$matched_source_sha"; then
    matched_build_run_id="$run_id"
    build_artifact_name="oci-image-provenance-${matched_source_sha}-${run_id}-1"
    artifacts_file="$WORK_DIR/build-run-${run_id}-artifacts.json"
    gh api "repos/$REPO/actions/runs/$run_id/artifacts" >"$artifacts_file"
    validate_artifact_listing "$artifacts_file" "$build_artifact_name"
    break
  fi
done <"$WORK_DIR/build-candidates.txt"

[[ -n "$matched_build_run_id" ]] || oci_die "unable to find trusted OCI build provenance for ${matched_source_sha}"

: >"$OUTPUT_DIR/pod-images.tsv"
while IFS=$'\t' read -r service _repository _image_ref _digest platform_digest; do
  pods_json="$WORK_DIR/${service}-pods.json"
  kubectl get pods -n "$OCI_K8S_NAMESPACE" -l "app=gaming-${service}" -o json >"$pods_json"
  python3 - "$pods_json" "$service" "$platform_digest" >>"$OUTPUT_DIR/pod-images.tsv" <<'PY'
import json
import sys

doc = json.load(open(sys.argv[1], encoding='utf-8'))
service, platform_digest = sys.argv[2:4]
ready_pods = 0
for item in doc.get('items', []):
    if item.get('metadata', {}).get('deletionTimestamp') is not None:
        continue
    pod = item.get('metadata', {}).get('name', '')
    for status in item.get('status', {}).get('containerStatuses', []):
        if status.get('name') != f'gaming-{service}':
            continue
        if not status.get('ready'):
            raise SystemExit(f'{service}: pod {pod} is not Ready')
        image_id = status.get('imageID', '')
        if not image_id.endswith('@' + platform_digest):
            raise SystemExit(f'{service}: pod {pod} does not serve {platform_digest}')
        ready_pods += 1
        print(service, pod, image_id, sep='\t')
if ready_pods == 0:
    raise SystemExit(f'{service}: no ready pods found')
PY
done <"$OUTPUT_DIR/images.tsv"

rabbit_pod="$(kubectl get pod -n "$OCI_K8S_NAMESPACE" -l "$RABBIT_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[[ -n "$rabbit_pod" ]] || oci_die "RabbitMQ pod not found for selector ${RABBIT_SELECTOR}"
queue_raw="$WORK_DIR/queues.raw"
kubectl exec -n "$OCI_K8S_NAMESPACE" "$rabbit_pod" -- \
  rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers >"$queue_raw"
oci_rabbitmq_queue_rows <"$queue_raw" >"$OUTPUT_DIR/queues.tsv" ||
  oci_die "unable to normalize RabbitMQ queue state"
[[ -s "$OUTPUT_DIR/queues.tsv" ]] || oci_die "queue snapshot is empty"

: >"$OUTPUT_DIR/public-http.tsv"
: >"$OUTPUT_DIR/sse.tsv"
for entry in \
  "canonical|$OCI_PUBLIC_URL" \
  "redirect|$OCI_REDIRECT_URL" \
  "diagnostic|$OCI_DIAGNOSTIC_URL"; do
  IFS='|' read -r label base_url <<<"$entry"
  capture_api_contracts "$base_url" "$label"
  capture_sse "$base_url" "$label"
done
[[ -s "$OUTPUT_DIR/public-http.tsv" ]] || oci_die "public HTTP evidence was not captured"
[[ -s "$OUTPUT_DIR/sse.tsv" ]] || oci_die "SSE evidence was not captured"

capture_configmap "$MIGRATION_STATE_CONFIGMAP" "$OUTPUT_DIR/migration-journal.json"
capture_configmap "$MIGRATION_LOCK_CONFIGMAP" "$OUTPUT_DIR/migration-lock.json"
if [[ -n "$MIGRATION_EVIDENCE_REFERENCE" ]]; then
  printf 'reference\t%s\tconfigured\n' "$MIGRATION_EVIDENCE_REFERENCE" >"$OUTPUT_DIR/migration-backup-references.tsv"
else
  printf 'state\tdatabase-restore-excluded\tapplication-rollback-only\n' >"$OUTPUT_DIR/migration-backup-references.tsv"
fi

cat >"$OUTPUT_DIR/baseline-provenance.env" <<EOF2
baseline_source_sha=$matched_source_sha
baseline_deploy_workflow=oci-production-deploy
baseline_deploy_run_id=$matched_deploy_run_id
baseline_deploy_run_attempt=1
baseline_build_workflow=oci-production-build
baseline_build_run_id=$matched_build_run_id
baseline_build_run_attempt=1
baseline_capture_run_id=${GITHUB_RUN_ID:-local}
baseline_capture_run_attempt=${GITHUB_RUN_ATTEMPT:-1}
namespace=$OCI_K8S_NAMESPACE
public_url=$OCI_PUBLIC_URL
redirect_url=$OCI_REDIRECT_URL
diagnostic_url=$OCI_DIAGNOSTIC_URL
sse_path=$SSE_PATH
database_restore=disabled
EOF2

required_files=(
  baseline-provenance.env
  images.tsv
  live-images.tsv
  deployments.tsv
  pod-images.tsv
  queues.tsv
  public-http.tsv
  sse.tsv
  migration-journal.json
  migration-lock.json
  migration-backup-references.tsv
  trusted-deploy-provenance.txt
)
: >"$OUTPUT_DIR/SHA256SUMS"
for file in "${required_files[@]}"; do
  [[ -s "$OUTPUT_DIR/$file" ]] || oci_die "required baseline artifact file is missing: $file"
  printf '%s  %s\n' "$(sha256_file "$OUTPUT_DIR/$file")" "$file" >>"$OUTPUT_DIR/SHA256SUMS"
done
chmod 600 "$OUTPUT_DIR"/*

oci_log "oci_baseline_capture=PASS source_sha=${matched_source_sha} deploy_run_id=${matched_deploy_run_id} build_run_id=${matched_build_run_id}"
