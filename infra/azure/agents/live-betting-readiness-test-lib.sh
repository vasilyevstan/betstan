#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SAFE_PARENT="${BETSTAN_TEST_TMPDIR:-$ROOT_DIR/.test-workdirs}"
TEST_ROOT="$SAFE_PARENT/live-betting-readiness-$$"
TEST_BIN_DIR="$TEST_ROOT/bin"
ORIGINAL_PATH="$PATH"
mkdir -p "$TEST_BIN_DIR"
trap '[[ "${KEEP_TEST_WORKDIR:-0}" == "1" ]] || rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "live_betting_readiness_tests=FAIL reason=$*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  [[ "$expected" == "$actual" ]] || fail "$message expected=$expected actual=$actual"
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  grep -Fq "$pattern" "$file" || fail "$message missing=$pattern file=$file"
}

assert_not_contains() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  if grep -Fq "$pattern" "$file"; then
    fail "$message unexpected=$pattern file=$file"
  fi
}

summary_value() {
  local file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$file" | head -n 1
}

create_image_provenance() {
  local file="$1"
  local stack="$2"
  python3 - "$file" "$stack" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
stack = sys.argv[2]
source_sha = "a" * 40
services = [
    "auth",
    "bet",
    "backoffice",
    "client",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
]
rows = []
for index, service in enumerate(services, 1):
    digest = f"sha256:{index:064x}"
    if stack == "azure":
        repository = f"fixture.invalid/gaming_{service}"
        image_ref = f"{repository}:{source_sha}@{digest}"
        rows.append("\t".join([service, repository, image_ref, digest]))
    else:
        repository = "ocir.example.invalid/fixture/betstan_images"
        image_ref = f"{repository}@{digest}"
        rows.append("\t".join([service, repository, image_ref, digest, digest]))
path.write_text("\n".join(rows) + "\n", encoding="utf-8")
PY
}

create_exact_master_provenance() {
  cat >"$1" <<'EOF_PROVENANCE'
source_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
source_ref=refs/heads/master
run_attempt=1
EOF_PROVENANCE
}

create_schema_evidence() {
  cat >"$1" <<'EOF_SCHEMA'
schema_version=live-betting-v1
backfill_complete=true
index_ready=true
EOF_SCHEMA
}

create_dark_baseline() {
  cat >"$1" <<'EOF_BASELINE'
live_betting_readiness=GO
mode=dark
actual_live_kickoffs_enabled=false
active_matches=0
submitted_live_slips=0
EOF_BASELINE
}

cat >"$TEST_BIN_DIR/kubectl" <<'EOF_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
fail_command="${STUB_COMMAND_FAILURE:-}"

numeric_max() {
  local left="${1:-0}"
  local right="${2:-0}"
  if (( right > left )); then
    printf '%s' "$right"
  else
    printf '%s' "$left"
  fi
}

pending_bucket_with_legacy() {
  local base_count="${1:-0}"
  local base_age="${2:-0}"
  local legacy_count="${3:-0}"
  local legacy_age="${4:-0}"
  local include_legacy="${5:-0}"
  local total_count="$base_count"
  local oldest_age="$base_age"
  if [[ "$include_legacy" == "1" ]]; then
    total_count=$(( total_count + legacy_count ))
    if (( legacy_count > 0 )); then
      oldest_age="$(numeric_max "$oldest_age" "$legacy_age")"
    fi
  fi
  printf '%s %s\n' "$total_count" "$oldest_age"
}

capture_query_script() {
  local target="$1"
  local script_content="$2"
  if [[ -n "${STUB_QUERY_CAPTURE_DIR:-}" ]]; then
    mkdir -p "$STUB_QUERY_CAPTURE_DIR"
    printf '%s\n' "$script_content" >"$STUB_QUERY_CAPTURE_DIR/${target}.js"
  fi
}

emit_workflow_payload() {
  local pending_count="$1"
  local pending_age="$2"
  local processing_count="$3"
  local processing_age="$4"
  local exhausted_count="$5"
  local exhausted_age="$6"
  printf '{"mongoOk":true,"pending":{"count":%s,"oldestAgeSeconds":%s},"processing":{"count":%s,"oldestAgeSeconds":%s},"exhausted":{"count":%s,"oldestAgeSeconds":%s}}\n' \
    "$pending_count" "$pending_age" "$processing_count" "$processing_age" "$exhausted_count" "$exhausted_age"
}

emit_retry_payload() {
  local pending_count="$1"
  local pending_age="$2"
  local processing_count="$3"
  local processing_age="$4"
  local dead_letter_count="$5"
  local dead_letter_age="$6"
  printf '{"mongoOk":true,"pending":{"count":%s,"oldestAgeSeconds":%s},"processing":{"count":%s,"oldestAgeSeconds":%s},"exhausted":{"count":%s,"oldestAgeSeconds":%s},"deadLetter":{"count":%s,"oldestAgeSeconds":%s}}\n' \
    "$pending_count" "$pending_age" "$processing_count" "$processing_age" "$dead_letter_count" "$dead_letter_age" "$dead_letter_count" "$dead_letter_age"
}

if [[ "$args" == *"get deploy,sts"* ]]; then
  [[ "$fail_command" != "workloads" ]] || exit 1
  python3 - "$IMAGE_PROVENANCE_FILE" "${STUB_FLAG_VALUE:-false}" "${STUB_FLAG_MISSING:-0}" <<'PY'
import json
import sys
from pathlib import Path

images_path, flag_value, flag_missing = sys.argv[1:]
items = []
rows = []
for raw_line in Path(images_path).read_text(encoding='utf-8').splitlines():
    if not raw_line.strip():
        continue
    parts = raw_line.split('\t')
    rows.append((parts[0], parts[2]))
for service, image_ref in rows:
    env = []
    if service == 'gamemaster' and flag_missing != '1':
        env.append({'name': 'LIVE_KICKOFFS_ENABLED', 'value': flag_value})
    items.append({
        'apiVersion': 'apps/v1',
        'kind': 'Deployment',
        'metadata': {'name': f'gaming-{service}-depl'},
        'spec': {
            'replicas': 1,
            'template': {'spec': {'containers': [{'name': f'gaming-{service}', 'image': image_ref, 'env': env}]}}
        },
        'status': {'readyReplicas': 1, 'availableReplicas': 1},
    })
items.append({
    'apiVersion': 'apps/v1',
    'kind': 'Deployment',
    'metadata': {'name': 'gaming-rabbitmq-depl'},
    'spec': {'replicas': 1, 'template': {'spec': {'containers': [{'name': 'gaming-rabbitmq', 'image': 'docker.io/library/rabbitmq@sha256:' + ('f' * 64)}]}}},
    'status': {'readyReplicas': 1, 'availableReplicas': 1},
})
items.append({
    'apiVersion': 'apps/v1',
    'kind': 'StatefulSet',
    'metadata': {'name': 'gaming-auth-mongo-depl'},
    'spec': {'replicas': 1, 'template': {'spec': {'containers': [{'name': 'gaming-auth-mongo', 'image': 'docker.io/library/mongo@sha256:' + ('e' * 64)}]}}},
    'status': {'readyReplicas': 1, 'availableReplicas': 1},
})
print(json.dumps({'items': items}))
PY
  exit 0
fi
if [[ "$args" == *"get persistentvolumeclaims"* ]]; then
  [[ "$fail_command" != "pvcs" ]] || exit 1
  python3 - \
    "${STUB_MONGO_PVC_NAME:-gaming-auth-mongo-data}" \
    "${STUB_MONGO_PVC_PHASE:-Bound}" \
    "${STUB_EXTRA_MONGO_PVC:-}" \
    "${STUB_MONGO_PVC_MISSING:-0}" <<'PY'
import json
import sys

name, phase, extra_name, missing = sys.argv[1:]
items = []
if missing != "1":
    items.append({"metadata": {"name": name}, "status": {"phase": phase}})
if extra_name:
    items.append({"metadata": {"name": extra_name}, "status": {"phase": "Bound"}})
print(json.dumps({"items": items}))
PY
  exit 0
fi
if [[ "$args" == *"get pods"* ]]; then
  [[ "$fail_command" != "pods" ]] || exit 1
  python3 - "$IMAGE_PROVENANCE_FILE" "${STUB_TOPOLOGY_MODE:-shared}" <<'PY'
import json
import sys
from pathlib import Path

images_path = Path(sys.argv[1])
topology_mode = sys.argv[2]
items = []
for raw_line in images_path.read_text(encoding='utf-8').splitlines():
    if not raw_line.strip():
        continue
    service, _repository, image_ref, digest, *_rest = raw_line.split('\t')
    name = f'gaming-{service}'
    items.append({
        'metadata': {'name': f'{name}-pod-0', 'labels': {'app': name}},
        'status': {'containerStatuses': [{'name': name, 'ready': True, 'imageID': image_ref}]},
    })
items.append({
    'metadata': {'name': 'gaming-rabbitmq-pod-0', 'labels': {'app': 'gaming-rabbitmq'}},
    'status': {'containerStatuses': [{'name': 'gaming-rabbitmq', 'ready': True, 'imageID': 'docker.io/library/rabbitmq@sha256:' + ('f' * 64)}]},
})
items.append({
    'metadata': {'name': 'gaming-auth-mongo-pod-0', 'labels': {'app': 'gaming-auth-mongo'}},
    'status': {'containerStatuses': [{'name': 'gaming-auth-mongo', 'ready': True, 'imageID': 'docker.io/library/mongo@sha256:' + ('e' * 64)}]},
})
if topology_mode == 'legacy':
    for service in ('bet', 'moderation', 'resulting', 'gamemaster', 'slip'):
        items.append({
            'metadata': {'name': f'gaming-{service}-mongo-pod-0', 'labels': {'app': f'gaming-{service}-mongo'}},
            'status': {'containerStatuses': [{'name': f'gaming-{service}-mongo', 'ready': True, 'imageID': 'docker.io/library/mongo@sha256:' + ('d' * 64)}]},
        })
print(json.dumps({'items': items}))
PY
  exit 0
fi
if [[ "$args" == *"get configmap gaming-mongo-topology"* ]]; then
  [[ "$fail_command" != "topology" ]] || exit 1
  if [[ "${STUB_TOPOLOGY_MISSING:-0}" == "1" ]]; then
    echo 'Error from server (NotFound): configmaps "gaming-mongo-topology" not found' >&2
    exit 1
  fi
  printf '{"data":{"mode":"%s","validated":"%s","migration-id":"fixture-migration"}}\n' \
    "${STUB_TOPOLOGY_MODE:-shared}" "${STUB_TOPOLOGY_VALIDATED:-true}"
  exit 0
fi
if [[ "$args" == *"get configmap gaming-mongo-migration-lock"* ]]; then
  [[ "$fail_command" != "lock" ]] || exit 1
  if [[ "${STUB_LOCK_MISSING:-0}" == "1" ]]; then
    echo 'Error from server (NotFound): configmaps "gaming-mongo-migration-lock" not found' >&2
    exit 1
  fi
  jq -cn \
    --arg state "${STUB_LOCK_STATE:-released}" \
    --arg holder "${STUB_LOCK_HOLDER:-}" \
    --arg operation "${STUB_LOCK_OPERATION_ID:-}" \
    --arg source_sha "${STUB_LOCK_SOURCE_SHA:-}" '{
      data:{
        state:$state,
        holder:$holder,
        "operation-id":$operation,
        "source-sha":$source_sha
      }
    }'
  exit 0
fi
if [[ "$args" == *"rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers"* ]]; then
  [[ "$fail_command" != "rabbit" ]] || exit 1
  ready="${STUB_QUEUE_READY:-0}"
  unack="${STUB_QUEUE_UNACK:-0}"
  durable_consumers="${STUB_DURABLE_CONSUMERS:-1}"
  dynamic_consumers="${STUB_DYNAMIC_QUEUE_CONSUMERS:-2}"
  echo 'name messages_ready messages_unacknowledged consumers'
  if [[ "${STUB_DROP_DURABLE_QUEUE:-}" != "event_live_projection" ]]; then
    printf 'event_live_projection %s %s %s\n' "$ready" "$unack" "$durable_consumers"
  fi
  if [[ "${STUB_DROP_DURABLE_QUEUE:-}" != "moderation_live_event_update" ]]; then
    printf 'moderation_live_event_update %s %s %s\n' "$ready" "$unack" "$durable_consumers"
  fi
  if [[ "${STUB_DROP_DURABLE_QUEUE:-}" != "resulting_live_event_update" ]]; then
    printf 'resulting_live_event_update %s %s %s\n' "$ready" "$unack" "$durable_consumers"
  fi
  if [[ "${STUB_DROP_DYNAMIC_QUEUE:-0}" != "1" ]]; then
    printf 'event_live_update.fixture-pod %s %s %s\n' "$ready" "$unack" "$dynamic_consumers"
  fi
  exit 0
fi
if [[ "$args" == *"mongosh --quiet --norc --eval"* ]]; then
  target="mongo"
  query_script="${@: -1}"
  case "$args" in
    *"activeMatches"*) target="mongo-active" ;;
    *"submittedLiveSlips"*) target="mongo-submitted-slips" ;;
    *"pendingbetupdates"*) target="mongo-bet-pending-bet-update" ;;
    *"parkedplacebets"*) target="mongo-moderation-parked-place-bet" ;;
    *"pendingmoderationresults"*) target="mongo-resulting-pending-moderation-result" ;;
    *"retryrecords"*) target="mongo-resulting-retry-record" ;;
  esac
  capture_query_script "$target" "$query_script"
  [[ "$fail_command" != "mongo" && "$fail_command" != "$target" ]] || exit 1
  malformed_target="${STUB_MONGO_MALFORMED_TARGET:-}"
  include_legacy_pending=0
  if [[ "$query_script" == *'includeLegacyMissingStatus: true'* ]]; then
    include_legacy_pending=1
  fi
  case "$target" in
    mongo-active)
      if [[ "$malformed_target" == "$target" ]]; then
        printf '{"mongoOk":true,"activeMatches":"oops"}\n'
      else
        printf '{"mongoOk":true,"activeMatches":%s}\n' "${STUB_ACTIVE_MATCHES:-0}"
      fi
      ;;
    mongo-submitted-slips)
      if [[ "$malformed_target" == "$target" ]]; then
        printf '{"mongoOk":true,"submittedLiveSlips":"oops"}\n'
      else
        printf '{"mongoOk":true,"submittedLiveSlips":%s}\n' "${STUB_SUBMITTED_LIVE_SLIPS:-0}"
      fi
      ;;
    mongo-bet-pending-bet-update)
      if [[ "$malformed_target" == "$target" ]]; then
        printf '{"mongoOk":true,"pending":{"count":"oops","oldestAgeSeconds":0},"processing":{"count":0,"oldestAgeSeconds":0},"exhausted":{"count":0,"oldestAgeSeconds":0}}\n'
      else
        read -r pending_count pending_age < <(
          pending_bucket_with_legacy \
            "${STUB_BET_PENDING_COUNT:-0}" \
            "${STUB_BET_PENDING_AGE_SECONDS:-0}" \
            "${STUB_BET_LEGACY_PENDING_COUNT:-0}" \
            "${STUB_BET_LEGACY_PENDING_AGE_SECONDS:-0}" \
            "$include_legacy_pending"
        )
        emit_workflow_payload \
          "$pending_count" \
          "$pending_age" \
          "${STUB_BET_PROCESSING_COUNT:-0}" \
          "${STUB_BET_PROCESSING_AGE_SECONDS:-0}" \
          "${STUB_BET_EXHAUSTED_COUNT:-0}" \
          "${STUB_BET_EXHAUSTED_AGE_SECONDS:-0}"
      fi
      ;;
    mongo-moderation-parked-place-bet)
      if [[ "$malformed_target" == "$target" ]]; then
        printf '{"mongoOk":true,"pending":{"count":"oops","oldestAgeSeconds":0},"processing":{"count":0,"oldestAgeSeconds":0},"exhausted":{"count":0,"oldestAgeSeconds":0}}\n'
      else
        read -r pending_count pending_age < <(
          pending_bucket_with_legacy \
            "${STUB_MODERATION_PENDING_COUNT:-0}" \
            "${STUB_MODERATION_PENDING_AGE_SECONDS:-0}" \
            "${STUB_MODERATION_LEGACY_PENDING_COUNT:-0}" \
            "${STUB_MODERATION_LEGACY_PENDING_AGE_SECONDS:-0}" \
            "$include_legacy_pending"
        )
        emit_workflow_payload \
          "$pending_count" \
          "$pending_age" \
          "${STUB_MODERATION_PROCESSING_COUNT:-0}" \
          "${STUB_MODERATION_PROCESSING_AGE_SECONDS:-0}" \
          "${STUB_MODERATION_EXHAUSTED_COUNT:-0}" \
          "${STUB_MODERATION_EXHAUSTED_AGE_SECONDS:-0}"
      fi
      ;;
    mongo-resulting-pending-moderation-result)
      if [[ "$malformed_target" == "$target" ]]; then
        printf '{"mongoOk":true,"pending":{"count":"oops","oldestAgeSeconds":0},"processing":{"count":0,"oldestAgeSeconds":0},"exhausted":{"count":0,"oldestAgeSeconds":0}}\n'
      else
        read -r pending_count pending_age < <(
          pending_bucket_with_legacy \
            "${STUB_RESULTING_PENDING_COUNT:-0}" \
            "${STUB_RESULTING_PENDING_AGE_SECONDS:-0}" \
            "${STUB_RESULTING_LEGACY_PENDING_COUNT:-0}" \
            "${STUB_RESULTING_LEGACY_PENDING_AGE_SECONDS:-0}" \
            "$include_legacy_pending"
        )
        emit_workflow_payload \
          "$pending_count" \
          "$pending_age" \
          "${STUB_RESULTING_PROCESSING_COUNT:-0}" \
          "${STUB_RESULTING_PROCESSING_AGE_SECONDS:-0}" \
          "${STUB_RESULTING_EXHAUSTED_COUNT:-0}" \
          "${STUB_RESULTING_EXHAUSTED_AGE_SECONDS:-0}"
      fi
      ;;
    mongo-resulting-retry-record)
      if [[ "$malformed_target" == "$target" ]]; then
        printf '{"mongoOk":true,"pending":{"count":"oops","oldestAgeSeconds":0},"processing":{"count":0,"oldestAgeSeconds":0},"exhausted":{"count":0,"oldestAgeSeconds":0},"deadLetter":{"count":0,"oldestAgeSeconds":0}}\n'
      else
        read -r pending_count pending_age < <(
          pending_bucket_with_legacy \
            "${STUB_RESULTING_RETRY_PENDING_COUNT:-0}" \
            "${STUB_RESULTING_RETRY_PENDING_AGE_SECONDS:-0}" \
            "${STUB_RESULTING_RETRY_LEGACY_PENDING_COUNT:-0}" \
            "${STUB_RESULTING_RETRY_LEGACY_PENDING_AGE_SECONDS:-0}" \
            "$include_legacy_pending"
        )
        emit_retry_payload \
          "$pending_count" \
          "$pending_age" \
          "${STUB_RESULTING_RETRY_PROCESSING_COUNT:-0}" \
          "${STUB_RESULTING_RETRY_PROCESSING_AGE_SECONDS:-0}" \
          "${STUB_RESULTING_RETRY_DEAD_LETTER_COUNT:-0}" \
          "${STUB_RESULTING_RETRY_DEAD_LETTER_AGE_SECONDS:-0}"
      fi
      ;;
    *)
      printf '{"mongoOk":true}\n'
      ;;
  esac
  exit 0
fi
echo "unexpected kubectl invocation: $args" >&2
exit 1
EOF_KUBECTL
chmod +x "$TEST_BIN_DIR/kubectl"

cat >"$TEST_BIN_DIR/curl" <<'EOF_CURL'
#!/usr/bin/env bash
set -euo pipefail
output_file=""
headers_file=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      output_file="$2"
      shift 2
      ;;
    --dump-header)
      headers_file="$2"
      shift 2
      ;;
    --write-out)
      shift 2
      ;;
    --max-time|--request|--header|--data)
      shift 2
      ;;
    --silent|--show-error|--location)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
[[ -n "$url" ]] || exit 2
base_url="${BASE_URL:-${OCI_PUBLIC_URL:-}}"
secondary_url="${SECONDARY_PUBLIC_URL:-${OCI_REDIRECT_URL:-}}"
diagnostic_url="${DIAGNOSTIC_URL:-${OCI_DIAGNOSTIC_URL:-}}"
status="200"
body='{}'
headers=$'HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-cache, no-transform\r\n\r\n'
kind=""
if [[ "$url" == "$secondary_url"*"/api/auth/currentuser?live-betting-redirect=1" ]]; then
  kind="secondary-redirect"
  status="308"
  body=''
  headers=$(printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: %s/api/auth/currentuser?live-betting-redirect=1\r\n\r\n' "$base_url")
elif [[ "$url" == *"/api/event/stream" ]]; then
  kind="sse"
  body=': heartbeat

'
  case "${STUB_SSE_MODE:-good}" in
    good)
      headers=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      ;;
    bad-headers)
      headers=$'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: max-age=60\r\nX-Accel-Buffering: yes\r\n\r\n'
      ;;
    bad-heartbeat)
      headers=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      body='event: snapshot

data: {"eventId":"fixture"}

'
      ;;
    *)
      ;;
  esac
elif [[ "$url" == *"/api/event" ]]; then
  kind="event"
  case "${STUB_EVENT_MODE:-good}" in
    good)
      body='[{"eventId":"legacy-event","name":"Legacy Home - Legacy Away","home":"Legacy Home","away":"Legacy Away","time":"2026-01-01T12:00:00.000Z","products":[{"type":"1X2","name":"1X2","odds":[{"id":"home","name":"Legacy Home","value":1.91},{"id":"draw","name":"Draw","value":3.2},{"id":"away","name":"Legacy Away","value":4.1}]},{"type":"CS","name":"Correct Score","odds":[{"id":"1-0","name":"1 - 0","value":7.0},{"id":"1-1","name":"1 - 1","value":6.4},{"id":"2-1","name":"2 - 1","value":8.2}]}]}]'
      ;;
    live-only)
      body='[{"eventId":"live-event","name":"Live Home - Live Away","home":"Live Home","away":"Live Away","time":"2026-01-01T12:00:00.000Z","phase":"LIVE","live":{"sequence":44,"minute":75},"products":[{"type":"1X2","name":"1X2","odds":[{"id":"home","name":"Live Home","value":1.4},{"id":"draw","name":"Draw","value":5.0},{"id":"away","name":"Live Away","value":8.5}]},{"type":"CS","name":"Correct Score","odds":[{"id":"1-0","name":"1 - 0","value":5.5},{"id":"1-1","name":"1 - 1","value":7.2},{"id":"2-1","name":"2 - 1","value":8.4}]}]}]'
      ;;
    malformed)
      body='[{"eventId":"broken-event","name":"Broken Home - Broken Away","time":"not-a-date","products":[{"type":"1X2","name":"1X2","odds":[{"id":"home","name":"Broken Home","value":"oops"}]}]}]'
      ;;
    empty)
      body='[]'
      ;;
    *)
      body='[]'
      ;;
  esac
elif [[ "$url" == *"/api/auth/currentuser" ]]; then
  kind="current-user"
  body='{"currentUser":null}'
fi
if [[ "${STUB_CURL_FAILURE:-}" == "$kind" ]]; then
  exit 56
fi
[[ -n "$output_file" ]] && printf '%s' "$body" >"$output_file"
[[ -n "$headers_file" ]] && printf '%s' "$headers" >"$headers_file"
printf '%s' "$status"
EOF_CURL
chmod +x "$TEST_BIN_DIR/curl"

run_live_betting_scenario() {
  local scenario="$1"
  local script="$2"
  local stack="$3"
  shift 3
  local scenario_dir="$TEST_ROOT/$scenario"
  local stdout_file="$scenario_dir/stdout.txt"
  local stderr_file="$scenario_dir/stderr.txt"
  mkdir -p "$scenario_dir"
  create_image_provenance "$scenario_dir/images.tsv" "$stack"
  create_exact_master_provenance "$scenario_dir/exact-master.env"
  create_schema_evidence "$scenario_dir/schema.env"
  create_dark_baseline "$scenario_dir/dark-baseline.env"
  mkdir -p "$scenario_dir/query-captures"
  if (
    export PATH="$TEST_BIN_DIR:$ORIGINAL_PATH"
    export IMAGE_PROVENANCE_FILE="$scenario_dir/images.tsv"
    export EXACT_MASTER_PROVENANCE_FILE="$scenario_dir/exact-master.env"
    export LIVE_SCHEMA_EVIDENCE_FILE="$scenario_dir/schema.env"
    export ROLLBACK_BASELINE_FILE="$scenario_dir/dark-baseline.env"
    export OUTPUT_DIR="$scenario_dir/output"
    export STUB_QUERY_CAPTURE_DIR="$scenario_dir/query-captures"
    export REQUEST_TIMEOUT=1
    export SSE_TIMEOUT=1
    export KUBECTL_TIMEOUT=1s
    export STUB_FLAG_VALUE=false
    export STUB_FLAG_MISSING=0
    export STUB_TOPOLOGY_MODE=shared
    export STUB_TOPOLOGY_VALIDATED=true
    export STUB_TOPOLOGY_MISSING=0
    export STUB_MONGO_PVC_PHASE=Bound
    export STUB_EXTRA_MONGO_PVC=
    export STUB_MONGO_PVC_MISSING=0
    export STUB_LOCK_STATE=released
    export STUB_LOCK_HOLDER=
    export STUB_LOCK_OPERATION_ID=
    export STUB_LOCK_SOURCE_SHA=
    export STUB_LOCK_MISSING=0
    export EXPECTED_OPERATION_LOCK_HOLDER=
    export EXPECTED_OPERATION_LOCK_ID=
    export EXPECTED_OPERATION_LOCK_SOURCE_SHA=
    export STUB_QUEUE_READY=0
    export STUB_QUEUE_UNACK=0
    export STUB_DURABLE_CONSUMERS=1
    export STUB_DYNAMIC_QUEUE_CONSUMERS=2
    export STUB_DROP_DYNAMIC_QUEUE=0
    export STUB_DROP_DURABLE_QUEUE=
    export STUB_ACTIVE_MATCHES=0
    export STUB_SUBMITTED_LIVE_SLIPS=0
    export STUB_BET_PENDING_COUNT=0
    export STUB_BET_PENDING_AGE_SECONDS=0
    export STUB_BET_LEGACY_PENDING_COUNT=0
    export STUB_BET_LEGACY_PENDING_AGE_SECONDS=0
    export STUB_BET_PROCESSING_COUNT=0
    export STUB_BET_PROCESSING_AGE_SECONDS=0
    export STUB_BET_EXHAUSTED_COUNT=0
    export STUB_BET_EXHAUSTED_AGE_SECONDS=0
    export STUB_MODERATION_PENDING_COUNT=0
    export STUB_MODERATION_PENDING_AGE_SECONDS=0
    export STUB_MODERATION_LEGACY_PENDING_COUNT=0
    export STUB_MODERATION_LEGACY_PENDING_AGE_SECONDS=0
    export STUB_MODERATION_PROCESSING_COUNT=0
    export STUB_MODERATION_PROCESSING_AGE_SECONDS=0
    export STUB_MODERATION_EXHAUSTED_COUNT=0
    export STUB_MODERATION_EXHAUSTED_AGE_SECONDS=0
    export STUB_RESULTING_PENDING_COUNT=0
    export STUB_RESULTING_PENDING_AGE_SECONDS=0
    export STUB_RESULTING_LEGACY_PENDING_COUNT=0
    export STUB_RESULTING_LEGACY_PENDING_AGE_SECONDS=0
    export STUB_RESULTING_PROCESSING_COUNT=0
    export STUB_RESULTING_PROCESSING_AGE_SECONDS=0
    export STUB_RESULTING_EXHAUSTED_COUNT=0
    export STUB_RESULTING_EXHAUSTED_AGE_SECONDS=0
    export STUB_RESULTING_RETRY_PENDING_COUNT=0
    export STUB_RESULTING_RETRY_PENDING_AGE_SECONDS=0
    export STUB_RESULTING_RETRY_LEGACY_PENDING_COUNT=0
    export STUB_RESULTING_RETRY_LEGACY_PENDING_AGE_SECONDS=0
    export STUB_RESULTING_RETRY_PROCESSING_COUNT=0
    export STUB_RESULTING_RETRY_PROCESSING_AGE_SECONDS=0
    export STUB_RESULTING_RETRY_DEAD_LETTER_COUNT=0
    export STUB_RESULTING_RETRY_DEAD_LETTER_AGE_SECONDS=0
    export STUB_MONGO_MALFORMED_TARGET=
    export STUB_SSE_MODE=good
    export STUB_EVENT_MODE=good
    export STUB_CURL_FAILURE=
    export STUB_COMMAND_FAILURE=
    export MODE=dark
    if [[ "$stack" == "azure" ]]; then
      export STUB_MONGO_PVC_NAME="gaming-auth-mongo-data-gaming-auth-mongo-depl-0"
      export BASE_URL="https://public.example.invalid"
      export SECONDARY_PUBLIC_URL=""
      export DIAGNOSTIC_URL=""
    else
      export STUB_MONGO_PVC_NAME="gaming-auth-mongo-data"
      unset BASE_URL SECONDARY_PUBLIC_URL DIAGNOSTIC_URL
      export OCI_PUBLIC_URL="https://betstan.xyz"
      export OCI_REDIRECT_URL="https://www.betstan.xyz"
      export OCI_DIAGNOSTIC_URL="https://203.0.113.10.nip.io"
    fi
    for assignment in "$@"; do
      export "$assignment"
    done
    "$script"
  ) >"$stdout_file" 2>"$stderr_file"; then
    RUN_RC=0
  else
    RUN_RC=$?
  fi
  RUN_STDOUT="$stdout_file"
  RUN_STDERR="$stderr_file"
  RUN_SCENARIO_DIR="$scenario_dir"
  RUN_SUMMARY_FILE="$scenario_dir/output/summary.env"
  RUN_QUERY_CAPTURE_DIR="$scenario_dir/query-captures"
}
