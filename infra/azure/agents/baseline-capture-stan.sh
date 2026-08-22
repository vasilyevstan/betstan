#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=live-betting-readiness-lib.sh
source "$ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"
REPO="${REPO:-${GITHUB_REPOSITORY:-vasilyevstan/betstan}}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/production-baseline}"
NAMESPACE="${NAMESPACE:-default}"
HOSTS="${HOSTS:-betstan.xyz,www.betstan.xyz}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-20}"
SSE_TIMEOUT="${SSE_TIMEOUT:-5}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
TOPOLOGY_CONFIGMAP="${TOPOLOGY_CONFIGMAP:-gaming-mongo-topology}"
LOCK_CONFIGMAP="${LOCK_CONFIGMAP:-gaming-mongo-migration-lock}"
MIGRATION_BACKUP_DIR="${MIGRATION_BACKUP_DIR:-}"
PROVENANCE_SCRIPT="${PROVENANCE_SCRIPT:-infra/azure/agents/workflow-run-provenance-stan.sh}"
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

capture_configmap() {
  local name="$1"
  local output_file="$2"
  if kubectl get configmap "$name" -n "$NAMESPACE" -o json >"$output_file" 2>/dev/null; then
    :
  else
    printf '{"present":false,"name":"%s"}\n' "$name" >"$output_file"
  fi
}

capture_http() {
  local host="$1"
  local path="$2"
  local expected_kind="$3"
  local body_file="$WORK_DIR/http-body"
  local headers_file="$WORK_DIR/http-headers"
  local summary_file="$WORK_DIR/http-summary.json"
  local meta status effective_url content_type shape body_sha

  meta="$({
    curl --location --silent --show-error --max-time "$REQUEST_TIMEOUT" \
      --output "$body_file" --dump-header "$headers_file" \
      --write-out '%{http_code}\t%{url_effective}\t%{content_type}' \
      "https://${host}${path}"
  })" || fail "HTTP probe failed for ${host}${path}"
  IFS=$'\t' read -r status effective_url content_type <<<"$meta"
  [[ "$status" == "200" ]] || fail "expected HTTP 200 for ${host}${path}, got ${status}"
  body_sha="$(sha256_file "$body_file")"

  case "$expected_kind" in
    html)
      [[ "$content_type" == text/html* ]] ||
        fail "expected text/html for ${host}${path}, got ${content_type:-missing}"
      shape="html"
      ;;
    auth)
      [[ "$content_type" == application/json* ]] ||
        fail "expected JSON for ${host}${path}, got ${content_type:-missing}"
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, dict) or 'currentUser' not in payload:
    raise SystemExit(1)
print('object.currentUser')
PY
)" || fail "invalid auth JSON shape for ${host}${path}"
      ;;
    prematch)
      [[ "$content_type" == application/json* ]] ||
        fail "expected JSON for ${host}${path}, got ${content_type:-missing}"
      if ! live_betting_write_http_summary "$body_file" "$headers_file" "$summary_file" legacy-prematch-events \
          2>"$WORK_DIR/http-summary.stderr"; then
        fail "invalid legacy PRE_MATCH event JSON shape for ${host}${path}"
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
)" || fail "unable to summarize legacy PRE_MATCH event contract for ${host}${path}"
      ;;
    array)
      [[ "$content_type" == application/json* ]] ||
        fail "expected JSON for ${host}${path}, got ${content_type:-missing}"
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, list):
    raise SystemExit(1)
print('array')
PY
)" || fail "invalid array JSON shape for ${host}${path}"
      ;;
    object)
      [[ "$content_type" == application/json* ]] ||
        fail "expected JSON for ${host}${path}, got ${content_type:-missing}"
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, dict):
    raise SystemExit(1)
print('object')
PY
)" || fail "invalid object JSON shape for ${host}${path}"
      ;;
    *)
      fail "unsupported HTTP expectation: $expected_kind"
      ;;
  esac

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$host" "$path" "$status" "$effective_url" "$content_type" "$shape:$body_sha" \
    >>"$OUTPUT_DIR/public-http.tsv"
}

capture_api_contracts() {
  local host="$1"
  local contract path expected_kind
  for contract in "${API_CONTRACTS[@]}"; do
    IFS='|' read -r path expected_kind <<<"$contract"
    capture_http "$host" "$path" "$expected_kind"
  done
}

capture_sse() {
  local host="$1"
  local body_file="$WORK_DIR/sse-body"
  local headers_file="$WORK_DIR/sse-headers"
  local status_file="$WORK_DIR/sse-status"
  local curl_status status content_type effective_url duration_seconds

  if curl --location --silent --show-error --max-time "$SSE_TIMEOUT" \
      --header 'Accept: text/event-stream' \
      --output "$body_file" --dump-header "$headers_file" \
      --write-out '%{http_code}\t%{url_effective}\t%{time_total}' \
      "https://${host}${SSE_PATH}" >"$status_file"; then
    curl_status=0
  else
    curl_status=$?
  fi
  [[ "$curl_status" == "0" || "$curl_status" == "28" ]] ||
    fail "SSE probe failed for ${host}${SSE_PATH}"
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
  )" || fail "SSE connectivity contract failed for ${host}${SSE_PATH}"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$host" "$status" "$effective_url" "$content_type" "$(sha256_file "$body_file")" \
    >>"$OUTPUT_DIR/sse.tsv"
}

prepare_private_dir "$OUTPUT_DIR"
WORK_PARENT_DIR="$OUTPUT_DIR/.workdirs"
prepare_private_dir "$WORK_PARENT_DIR"
WORK_DIR="$(live_betting_create_unique_private_dir "$WORK_PARENT_DIR" baseline)"
trap 'rm -rf -- "$WORK_DIR"; rmdir "$WORK_PARENT_DIR" 2>/dev/null || true' EXIT

for command_name in gh git kubectl curl python3 jq awk sed find; do
  require_command "$command_name"
done

[[ -x "$PROVENANCE_SCRIPT" ]] || fail "provenance script is not executable: $PROVENANCE_SCRIPT"

: >"$OUTPUT_DIR/deployments.tsv"
current_source_sha=""
for service in "${ROLLBACK_SERVICES[@]}"; do
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  deployment_json="$WORK_DIR/${service}-deployment.json"
  kubectl get deployment "$deployment" -n "$NAMESPACE" -o json >"$deployment_json"
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
  [[ -n "$image" ]] || fail "deployment ${deployment} does not declare container ${container}"
  if [[ "$image" =~ ^(.+):([0-9a-f]{40})@(sha256:[0-9a-f]{64})$ ]]; then
    repository="${BASH_REMATCH[1]}"
    source_sha="${BASH_REMATCH[2]}"
    digest="${BASH_REMATCH[3]}"
  else
    fail "deployment ${deployment} does not use an immutable SHA-tagged image"
  fi
  if [[ -z "$current_source_sha" ]]; then
    current_source_sha="$source_sha"
  elif [[ "$current_source_sha" != "$source_sha" ]]; then
    fail "live workloads do not agree on a single baseline SHA"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$service" "$deployment" "$container" "$repository" "$image" "$digest" \
    "$revision" "$desired" "$ready" "$updated" "$available" >>"$OUTPUT_DIR/deployments.tsv"
done
[[ "$current_source_sha" =~ ^[0-9a-f]{40}$ ]] || fail "unable to determine current production source SHA"

deploy_provenance="$({
  REPO="$REPO" WORKFLOW=production-deploy TARGET_SHA="$current_source_sha" \
    "$PROVENANCE_SCRIPT"
})" || fail "missing trusted production deploy provenance for ${current_source_sha}"
IFS=$'\t' read -r trusted_deploy_run_id trusted_deploy_status trusted_deploy_conclusion trusted_deploy_url <<<"$deploy_provenance"
[[ "$trusted_deploy_run_id" =~ ^[1-9][0-9]*$ ]] || fail "invalid trusted deploy run ID"

trusted_dir="$WORK_DIR/trusted-deploy"
prepare_private_dir "$trusted_dir"
gh run download "$trusted_deploy_run_id" --repo "$REPO" \
  --name "deploy-provenance-${trusted_deploy_run_id}-1" --dir "$trusted_dir" >/dev/null
trusted_provenance_file="$(find "$trusted_dir" -type f -name provenance.txt | head -n 1)"
trusted_images_file="$(find "$trusted_dir" -type f -name images.tsv | head -n 1)"
[[ -f "$trusted_provenance_file" ]] || fail "trusted deploy provenance artifact is missing provenance.txt"
[[ -f "$trusted_images_file" ]] || fail "trusted deploy provenance artifact is missing images.tsv"
cp "$trusted_provenance_file" "$OUTPUT_DIR/trusted-deploy-provenance.txt"
cp "$trusted_images_file" "$OUTPUT_DIR/images.tsv"

trusted_build_run_id="$(sed -n 's/^upstream_run_id=//p' "$trusted_provenance_file")"
trusted_build_run_attempt="$(sed -n 's/^upstream_run_attempt=//p' "$trusted_provenance_file")"
trusted_image_sha="$(sed -n 's/^image_sha=//p' "$trusted_provenance_file")"
trusted_upstream_event="$(sed -n 's/^upstream_event=//p' "$trusted_provenance_file")"
[[ "$trusted_image_sha" == "$current_source_sha" ]] || fail "trusted deploy provenance SHA does not match live workloads"
[[ "$trusted_build_run_id" =~ ^[1-9][0-9]*$ ]] || fail "trusted deploy provenance is missing build run ID"
[[ "$trusted_build_run_attempt" == "1" ]] || fail "trusted deploy provenance build attempt is not first-attempt"
[[ "$trusted_upstream_event" == "push" ]] || fail "trusted deploy provenance did not come from a push build"

python3 - "$OUTPUT_DIR/images.tsv" "$OUTPUT_DIR/deployments.tsv" <<'PY'
import sys
from pathlib import Path

images = {}
for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines():
    if not line:
        continue
    service, repository, image_ref, digest = line.split('\t')
    images[service] = (repository, image_ref, digest)

deployments = {}
for line in Path(sys.argv[2]).read_text(encoding='utf-8').splitlines():
    if not line:
        continue
    service, _deployment, _container, repository, image_ref, digest, *_rest = line.split('\t')
    deployments[service] = (repository, image_ref, digest)

if set(images) != set(deployments):
    raise SystemExit('service sets differ between trusted artifact and live deployments')
for service in images:
    if images[service] != deployments[service]:
        raise SystemExit(f'{service}: live deployment does not match trusted provenance')
PY

: >"$OUTPUT_DIR/pod-images.tsv"
while IFS=$'\t' read -r service deployment container _repository _image_ref digest _revision _desired _ready _updated _available; do
  pods_json="$WORK_DIR/${service}-pods.json"
  kubectl get pods -n "$NAMESPACE" -l "app=${container}" -o json >"$pods_json"
  python3 - "$pods_json" "$service" "$container" "$digest" >>"$OUTPUT_DIR/pod-images.tsv" <<'PY'
import json
import sys

doc = json.load(open(sys.argv[1], encoding='utf-8'))
service, container, digest = sys.argv[2:5]
ready_pods = 0
for item in doc.get('items', []):
    if item.get('metadata', {}).get('deletionTimestamp') is not None:
        continue
    pod = item.get('metadata', {}).get('name', '')
    for status in item.get('status', {}).get('containerStatuses', []):
        if status.get('name') != container:
            continue
        image_id = status.get('imageID', '')
        ready = 'true' if status.get('ready') else 'false'
        if ready != 'true':
            raise SystemExit(f'{service}: {pod} is not Ready')
        if not image_id.endswith('@' + digest):
            raise SystemExit(f'{service}: {pod} imageID does not match {digest}')
        ready_pods += 1
        print(service, pod, container, ready, image_id, sep='\t')
if ready_pods == 0:
    raise SystemExit(f'{service}: no ready pods found')
PY

done <"$OUTPUT_DIR/deployments.tsv"

rabbit_pod="$(kubectl get pod -n "$NAMESPACE" -l "$RABBIT_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[[ -n "$rabbit_pod" ]] || fail "RabbitMQ pod not found for selector ${RABBIT_SELECTOR}"
queue_raw="$WORK_DIR/queues.raw"
kubectl exec -n "$NAMESPACE" "$rabbit_pod" -- \
  rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers >"$queue_raw"
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
' "$queue_raw" >"$OUTPUT_DIR/queues.tsv" || fail "unable to normalize queue snapshot"
[[ -s "$OUTPUT_DIR/queues.tsv" ]] || fail "queue snapshot is empty"

: >"$OUTPUT_DIR/public-http.tsv"
: >"$OUTPUT_DIR/sse.tsv"
IFS=',' read -r -a host_list <<<"$HOSTS"
for host in "${host_list[@]}"; do
  [[ -n "$host" ]] || continue
  capture_api_contracts "$host"
  capture_sse "$host"
done
[[ -s "$OUTPUT_DIR/public-http.tsv" ]] || fail "public HTTP evidence was not captured"
[[ -s "$OUTPUT_DIR/sse.tsv" ]] || fail "SSE evidence was not captured"

capture_configmap "$TOPOLOGY_CONFIGMAP" "$OUTPUT_DIR/mongo-topology.json"
capture_configmap "$LOCK_CONFIGMAP" "$OUTPUT_DIR/mongo-lock.json"

migration_mode="$(jq -r '.data.mode // empty' "$OUTPUT_DIR/mongo-topology.json" 2>/dev/null || true)"
migration_phase="$(jq -r '.data.phase // empty' "$OUTPUT_DIR/mongo-topology.json" 2>/dev/null || true)"
migration_id="$(jq -r '.data["migration-id"] // empty' "$OUTPUT_DIR/mongo-topology.json" 2>/dev/null || true)"
: >"$OUTPUT_DIR/migration-backup-references.tsv"
if [[ "$migration_mode" == "transition" ]]; then
  [[ -n "$migration_id" ]] || fail "transition topology is missing a migration ID"
  [[ "$MIGRATION_BACKUP_DIR" == /* && -d "$MIGRATION_BACKUP_DIR" ]] ||
    fail "MIGRATION_BACKUP_DIR is required to reference active migration backups"
  manifest_path="$MIGRATION_BACKUP_DIR/${migration_id}-manifest.tsv"
  [[ -f "$manifest_path" ]] || fail "migration manifest is missing: ${migration_id}-manifest.tsv"
  printf 'manifest\t%s\t%s\n' \
    "${migration_id}-manifest.tsv" "$(sha256_file "$manifest_path")" >>"$OUTPUT_DIR/migration-backup-references.tsv"
  while IFS=$'\t' read -r database archive_name expected_checksum; do
    [[ -n "$database" && -n "$archive_name" && "$expected_checksum" =~ ^[0-9a-f]{64}$ ]] ||
      fail "migration manifest contains an invalid backup reference"
    printf 'archive\t%s\t%s\n' "$archive_name" "$expected_checksum" >>"$OUTPUT_DIR/migration-backup-references.tsv"
  done <"$manifest_path"
else
  printf 'state\t%s\t%s\n' "${migration_mode:-absent}" "${migration_phase:-none}" >"$OUTPUT_DIR/migration-backup-references.tsv"
fi

cat >"$OUTPUT_DIR/baseline-provenance.env" <<EOF2
baseline_source_sha=$current_source_sha
baseline_deploy_workflow=production-deploy
baseline_deploy_run_id=$trusted_deploy_run_id
baseline_deploy_run_attempt=1
baseline_deploy_status=$trusted_deploy_status
baseline_deploy_conclusion=$trusted_deploy_conclusion
baseline_deploy_url=$trusted_deploy_url
baseline_build_workflow=production-build
baseline_build_run_id=$trusted_build_run_id
baseline_build_run_attempt=$trusted_build_run_attempt
baseline_capture_run_id=${GITHUB_RUN_ID:-local}
baseline_capture_run_attempt=${GITHUB_RUN_ATTEMPT:-1}
namespace=$NAMESPACE
hosts=$HOSTS
sse_path=$SSE_PATH
database_restore=disabled
EOF2

required_files=(
  baseline-provenance.env
  images.tsv
  deployments.tsv
  pod-images.tsv
  queues.tsv
  public-http.tsv
  sse.tsv
  mongo-topology.json
  mongo-lock.json
  migration-backup-references.tsv
  trusted-deploy-provenance.txt
)
: >"$OUTPUT_DIR/SHA256SUMS"
for file in "${required_files[@]}"; do
  [[ -s "$OUTPUT_DIR/$file" ]] || fail "required baseline artifact file is missing: $file"
  printf '%s  %s\n' "$(sha256_file "$OUTPUT_DIR/$file")" "$file" >>"$OUTPUT_DIR/SHA256SUMS"
done
chmod 600 "$OUTPUT_DIR"/*

printf 'baseline_capture=PASS source_sha=%s trusted_deploy_run_id=%s trusted_build_run_id=%s\n' \
  "$current_source_sha" "$trusted_deploy_run_id" "$trusted_build_run_id"
