#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=../../azure/agents/live-betting-readiness-lib.sh
source "$OCI_ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"

OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-rollback-readiness}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_PUBLIC_URL="${OCI_PUBLIC_URL:-https://betstan.xyz}"
OCI_REDIRECT_URL="${OCI_REDIRECT_URL:-https://www.betstan.xyz}"
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-20}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
MAX_QUEUE_READY="${MAX_QUEUE_READY:-80}"
MAX_QUEUE_UNACK="${MAX_QUEUE_UNACK:-80}"
MIN_ROLLOUT_REVISIONS="${MIN_ROLLOUT_REVISIONS:-2}"
REQUIRED_QUEUES="${REQUIRED_QUEUES:-event_new_event,gamemaster_new_event,bet_place_bet}"
TARGET_SHA="${TARGET_SHA:-}"
AUTH_MONGO_SELECTOR="${AUTH_MONGO_SELECTOR:-app=gaming-auth-mongo}"
AUTH_DB_NAME="${AUTH_DB_NAME:-gaming_auth}"
AUTH_USER_COLLECTION="${AUTH_USER_COLLECTION:-users}"
AUTH_DEPLOYMENT="${AUTH_DEPLOYMENT:-gaming-auth-depl}"
AUTH_POD_SELECTOR="${AUTH_POD_SELECTOR:-app=gaming-auth}"
AUTH_CONTAINER="${AUTH_CONTAINER:-gaming-auth}"
ROLLBACK_SERVICES=(auth bet backoffice client event gamemaster moderation resulting slip)
API_CONTRACTS=(
  "/|html"
  "/api/auth/currentuser|auth"
  "/api/event|prematch"
  "/api/slip|object"
  "/api/bet|object"
  "/api/bet/stats|array"
  "/api/backoffice|backoffice"
)

prepare_private_dir() {
  local directory="$1"
  oci_prepare_safe_private_dir "$directory"
}

create_unique_private_dir() {
  local parent="$1"
  local prefix="$2"
  python3 - "$parent" "$prefix" <<'PY'
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

failures_file_append() {
  printf '%s\n' "$1" >>"$OUTPUT_DIR/failures.txt"
}

capture_http() {
  local base_url="$1"
  local label="$2"
  local path="$3"
  local expected_kind="$4"
  local body_file="$WORK_DIR/http-body"
  local headers_file="$WORK_DIR/http-headers"
  local summary_file="$WORK_DIR/http-summary.json"
  local meta status effective_url content_type shape expected_status_label

  meta="$({
    curl --location --silent --show-error --max-time "$REQUEST_TIMEOUT" \
      --output "$body_file" --dump-header "$headers_file" \
      --write-out '%{http_code}\t%{url_effective}\t%{content_type}' \
      "${base_url}${path}"
  })" || {
    failures_file_append "http ${label}${path}: request failed"
    return 1
  }
  IFS=$'\t' read -r status effective_url content_type <<<"$meta"
  expected_status_label=200
  if [[ "$expected_kind" == "backoffice" ]]; then
    expected_status_label="200 or legacy protected 401"
  fi
  if [[ "$status" != "200" &&
      ! ("$expected_kind" == "backoffice" && "$status" == "401") ]]; then
    failures_file_append "http ${label}${path}: expected ${expected_status_label} got ${status}"
    return 1
  fi
  case "$expected_kind" in
    html)
      [[ "$content_type" == text/html* ]] || {
        failures_file_append "http ${label}${path}: expected HTML content"
        return 1
      }
      shape="html"
      ;;
    auth)
      [[ "$content_type" == application/json* ]] || {
        failures_file_append "http ${label}${path}: expected JSON content"
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
        failures_file_append "http ${label}${path}: incompatible auth payload"
        return 1
      }
      ;;
    prematch)
      [[ "$content_type" == application/json* ]] || {
        failures_file_append "http ${label}${path}: expected JSON content"
        return 1
      }
      if ! live_betting_write_http_summary "$body_file" "$headers_file" "$summary_file" legacy-prematch-events \
          2>"$WORK_DIR/http-summary.stderr"; then
        failures_file_append "http ${label}${path}: incompatible legacy PRE_MATCH payload"
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
        failures_file_append "http ${label}${path}: unable to summarize legacy PRE_MATCH payload"
        return 1
      }
      ;;
    array)
      [[ "$content_type" == application/json* ]] || {
        failures_file_append "http ${label}${path}: expected JSON content"
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
        failures_file_append "http ${label}${path}: incompatible array payload"
        return 1
      }
      ;;
    backoffice)
      [[ "$content_type" == application/json* ]] || {
        failures_file_append "http ${label}${path}: expected JSON content"
        return 1
      }
      shape="$(python3 - "$body_file" "$status" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding='utf-8'))
status = sys.argv[2]
if status == '200':
    if not isinstance(payload, list):
        raise SystemExit(1)
    print('array')
else:
    errors = payload.get('errors') if isinstance(payload, dict) else None
    if (
        not isinstance(errors, list)
        or not errors
        or any(
            not isinstance(error, dict)
            or not isinstance(error.get('message'), str)
            or not error['message']
            for error in errors
        )
    ):
        raise SystemExit(1)
    print('unauthorized.errors')
PY
)" || {
        failures_file_append "http ${label}${path}: incompatible Backoffice payload"
        return 1
      }
      ;;
    object)
      [[ "$content_type" == application/json* ]] || {
        failures_file_append "http ${label}${path}: expected JSON content"
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
        failures_file_append "http ${label}${path}: incompatible object payload"
        return 1
      }
      ;;
    *)
      failures_file_append "http ${label}${path}: unsupported expectation ${expected_kind}"
      return 1
      ;;
  esac

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$path" "$status" "$effective_url" "$content_type" "$shape" \
    >>"$OUTPUT_DIR/current-http.tsv"
}

capture_api_contracts() {
  local base_url="$1"
  local label="$2"
  local contract path expected_kind
  for contract in "${API_CONTRACTS[@]}"; do
    IFS='|' read -r path expected_kind <<<"$contract"
    capture_http "$base_url" "$label" "$path" "$expected_kind" || true
  done
}

cleanup_work_dir() {
  rm -rf "$WORK_DIR"
  rmdir "$WORK_PARENT_DIR" 2>/dev/null || true
}

prepare_private_dir "$OUTPUT_DIR"
WORK_PARENT_DIR="$OUTPUT_DIR/.workdirs"
prepare_private_dir "$WORK_PARENT_DIR"
WORK_DIR="$(create_unique_private_dir "$WORK_PARENT_DIR" readiness)"
trap cleanup_work_dir EXIT

for command_name in kubectl curl python3 awk; do
  oci_require_command "$command_name"
done
[[ "$OCI_PUBLIC_URL" == https://* ]] || oci_die "OCI_PUBLIC_URL must use https://"
[[ "$OCI_REDIRECT_URL" == https://* ]] || oci_die "OCI_REDIRECT_URL must use https://"
[[ -z "$OCI_DIAGNOSTIC_URL" || "$OCI_DIAGNOSTIC_URL" == https://* ]] ||
  oci_die "OCI_DIAGNOSTIC_URL must use https:// when provided"
[[ "$MAX_QUEUE_READY" =~ ^[0-9]+$ ]] || oci_die "MAX_QUEUE_READY must be a non-negative integer"
[[ "$MAX_QUEUE_UNACK" =~ ^[0-9]+$ ]] || oci_die "MAX_QUEUE_UNACK must be a non-negative integer"
[[ "$MIN_ROLLOUT_REVISIONS" =~ ^[1-9][0-9]*$ ]] || oci_die "MIN_ROLLOUT_REVISIONS must be positive"
if [[ -z "$TARGET_SHA" ]]; then
  failures_file_append "TARGET_SHA is required before OCI rollback action"
elif ! [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  failures_file_append "TARGET_SHA must be a full lowercase commit SHA"
fi
if ! [[ "$AUTH_DB_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || ! [[ "$AUTH_USER_COLLECTION" =~ ^[A-Za-z0-9_-]+$ ]]; then
  failures_file_append "auth database and collection names must contain only letters, numbers, underscores, or hyphens"
fi

: >"$OUTPUT_DIR/failures.txt"
: >"$OUTPUT_DIR/workload-state.tsv"
: >"$OUTPUT_DIR/rollout-history.tsv"
: >"$OUTPUT_DIR/current-http.tsv"
: >"$OUTPUT_DIR/queue-state.tsv"
AUTH_IDENTIFIER_ROLLBACK_CHECK="unknown"
AUTH_NORMALIZED_IDENTIFIER_COUNT="unknown"
TARGET_SUPPORTS_NORMALIZED_IDENTIFIERS="unknown"

for service in "${ROLLBACK_SERVICES[@]}"; do
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  deployment_json="$WORK_DIR/${service}-deployment.json"
  kubectl get deployment "$deployment" -n "$OCI_K8S_NAMESPACE" -o json >"$deployment_json" || {
    failures_file_append "workload ${deployment}: unable to inspect deployment"
    continue
  }
  python3 - "$deployment_json" "$container" "$service" >>"$OUTPUT_DIR/workload-state.tsv" 2>>"$WORK_DIR/workload-errors.log" <<'PY' || failures_file_append "workload ${deployment}: incompatible deployment state"
import json
import sys

doc = json.load(open(sys.argv[1], encoding='utf-8'))
container = sys.argv[2]
service = sys.argv[3]
image = ''
for item in doc.get('spec', {}).get('template', {}).get('spec', {}).get('containers', []):
    if item.get('name') == container:
        image = item.get('image', '')
        break
if not image or '@sha256:' not in image:
    raise SystemExit(1)
desired = int(doc.get('spec', {}).get('replicas', 0) or 0)
ready = int(doc.get('status', {}).get('readyReplicas', 0) or 0)
updated = int(doc.get('status', {}).get('updatedReplicas', 0) or 0)
available = int(doc.get('status', {}).get('availableReplicas', 0) or 0)
if desired < 1 or ready != desired or updated != desired or available != desired:
    raise SystemExit(1)
print(service, image, desired, ready, updated, available, sep='\t')
PY

  revision_count="$(kubectl rollout history "deployment/${deployment}" -n "$OCI_K8S_NAMESPACE" 2>/dev/null | awk '/^[0-9]+/ {c++} END {print c+0}')"
  printf '%s\t%s\n' "$service" "$revision_count" >>"$OUTPUT_DIR/rollout-history.tsv"
  if [[ "$revision_count" -lt "$MIN_ROLLOUT_REVISIONS" ]]; then
    failures_file_append "rollout ${deployment}: only ${revision_count} revision(s)"
  fi
done

url_entries=("canonical|$OCI_PUBLIC_URL" "redirect|$OCI_REDIRECT_URL")
if [[ -n "$OCI_DIAGNOSTIC_URL" ]]; then
  url_entries+=("diagnostic|$OCI_DIAGNOSTIC_URL")
fi
for entry in "${url_entries[@]}"; do
  IFS='|' read -r label base_url <<<"$entry"
  capture_api_contracts "$base_url" "$label"
done

rabbit_pod="$(kubectl get pod -n "$OCI_K8S_NAMESPACE" -l "$RABBIT_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$rabbit_pod" ]]; then
  failures_file_append "rabbitmq: pod missing for selector ${RABBIT_SELECTOR}"
else
  queue_raw="$WORK_DIR/queues.raw"
  kubectl exec -n "$OCI_K8S_NAMESPACE" "$rabbit_pod" -- \
    rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers >"$queue_raw" ||
    failures_file_append 'rabbitmq: unable to read queue state'
  if [[ -s "$queue_raw" ]]; then
    if oci_rabbitmq_queue_rows <"$queue_raw" >"$OUTPUT_DIR/queue-state.tsv"; then
      python3 - "$OUTPUT_DIR/queue-state.tsv" "$REQUIRED_QUEUES" "$MAX_QUEUE_READY" "$MAX_QUEUE_UNACK" <<'PY' || failures_file_append "rabbitmq: queue thresholds violated"
import sys
from pathlib import Path

queue_file, required_csv, max_ready, max_unack = sys.argv[1:5]
required = [item for item in required_csv.split(',') if item]
rows = {}
for raw_line in Path(queue_file).read_text(encoding='utf-8').splitlines():
    if not raw_line:
        continue
    name, ready, unack, consumers = raw_line.split('\t')
    rows[name] = (int(ready), int(unack), int(consumers))
missing = [name for name in required if name not in rows]
if missing:
    raise SystemExit(1)
total_ready = 0
total_unack = 0
for name, (ready, unack, consumers) in rows.items():
    total_ready += ready
    total_unack += unack
    if name in required and consumers < 1:
        raise SystemExit(1)
if total_ready > int(max_ready) or total_unack > int(max_unack):
    raise SystemExit(1)
print(f'total_ready={total_ready}')
print(f'total_unack={total_unack}')
PY
    else
      failures_file_append 'rabbitmq: queue output was malformed'
    fi
  fi
fi

if [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] &&
  [[ "$AUTH_DB_NAME" =~ ^[A-Za-z0-9_-]+$ ]] &&
  [[ "$AUTH_USER_COLLECTION" =~ ^[A-Za-z0-9_-]+$ ]]; then
  target_sha_full="$(git rev-parse "${TARGET_SHA}^{commit}" 2>/dev/null || true)"
  target_login="$(git show "${TARGET_SHA}:auth/src/route/LogIn.ts" 2>/dev/null || true)"
  if [[ -z "$target_sha_full" || -z "$target_login" || "$target_sha_full" != "$TARGET_SHA" ]]; then
    AUTH_IDENTIFIER_ROLLBACK_CHECK="missing-git-evidence"
    failures_file_append "auth rollback compatibility: unable to inspect auth login at target sha $TARGET_SHA"
  elif grep -q "normalizeIdentifier" <<<"$target_login" &&
    grep -q "User.findOne({ identifierNormalized })" <<<"$target_login"; then
    TARGET_SUPPORTS_NORMALIZED_IDENTIFIERS="true"
    AUTH_NORMALIZED_IDENTIFIER_COUNT="0"
    AUTH_IDENTIFIER_ROLLBACK_CHECK="compatible"
  else
    TARGET_SUPPORTS_NORMALIZED_IDENTIFIERS="false"
    auth_rollout_state="$(
      kubectl get deployment "$AUTH_DEPLOYMENT" -n "$OCI_K8S_NAMESPACE" \
        -o jsonpath='{.metadata.generation}|{.status.observedGeneration}|{.spec.replicas}|{.status.updatedReplicas}|{.status.readyReplicas}|{.status.availableReplicas}' \
        2>/dev/null || true
    )"
    IFS='|' read -r auth_generation auth_observed auth_replicas auth_updated auth_ready auth_available <<<"$auth_rollout_state"
    auth_generation="${auth_generation:-0}"
    auth_observed="${auth_observed:-0}"
    auth_replicas="${auth_replicas:-0}"
    auth_updated="${auth_updated:-0}"
    auth_ready="${auth_ready:-0}"
    auth_available="${auth_available:-0}"
    if [[ "$auth_generation" -eq 0 ||
      "$auth_observed" -lt "$auth_generation" ||
      "$auth_updated" -ne "$auth_replicas" ||
      "$auth_ready" -ne "$auth_replicas" ||
      "$auth_available" -ne "$auth_replicas" ]]; then
      AUTH_IDENTIFIER_ROLLBACK_CHECK="rollout-not-observed"
      failures_file_append "auth rollback compatibility: auth rollout is not fully observed"
    fi

    auth_pod_rows="$(
      kubectl get pods -n "$OCI_K8S_NAMESPACE" -l "$AUTH_POD_SELECTOR" \
        -o jsonpath="{range .items[*]}{.metadata.name}|{.status.phase}|{.status.conditions[?(@.type=='Ready')].status}|{.spec.containers[?(@.name=='${AUTH_CONTAINER}')].image}{'\\n'}{end}" \
        2>/dev/null || true
    )"
    ready_auth_pod_count=0
    while IFS='|' read -r auth_pod auth_phase auth_pod_ready _auth_pod_image; do
      [[ -n "$auth_pod" ]] || continue
      if [[ "$auth_phase" == "Running" && "$auth_pod_ready" == "True" ]]; then
        ready_auth_pod_count=$((ready_auth_pod_count + 1))
      fi
    done <<<"$auth_pod_rows"
    if [[ "$ready_auth_pod_count" -eq 0 ]]; then
      AUTH_IDENTIFIER_ROLLBACK_CHECK="no-ready-auth-pods"
      failures_file_append "auth rollback compatibility: no ready auth pods found for selector ${AUTH_POD_SELECTOR}"
    fi

    auth_mongo_pod="$(kubectl get pod -n "$OCI_K8S_NAMESPACE" -l "$AUTH_MONGO_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    if [[ -z "$auth_mongo_pod" ]]; then
      AUTH_IDENTIFIER_ROLLBACK_CHECK="missing-auth-mongo"
      failures_file_append "auth rollback compatibility: auth mongo pod missing for selector ${AUTH_MONGO_SELECTOR}"
    else
      mongo_query="db.getCollection('${AUTH_USER_COLLECTION}').countDocuments({identifierNormalized: {\$type: 'string'}})"
      if ! normalized_count="$(
        kubectl exec -n "$OCI_K8S_NAMESPACE" "$auth_mongo_pod" -- \
          mongosh --quiet "mongodb://localhost:27017/${AUTH_DB_NAME}" --eval "$mongo_query" 2>/dev/null
      )"; then
        AUTH_IDENTIFIER_ROLLBACK_CHECK="query-failed"
        failures_file_append "auth rollback compatibility: unable to count normalized auth identifiers"
      else
        normalized_count="$(tail -n 1 <<<"$normalized_count" | tr -d '\r')"
        AUTH_NORMALIZED_IDENTIFIER_COUNT="$normalized_count"
        if ! [[ "$normalized_count" =~ ^[0-9]+$ ]]; then
          AUTH_IDENTIFIER_ROLLBACK_CHECK="invalid-query-result"
          failures_file_append "auth rollback compatibility: unexpected normalized auth identifier count ${normalized_count}"
        elif [[ "$normalized_count" -gt 0 ]]; then
          AUTH_IDENTIFIER_ROLLBACK_CHECK="incompatible"
          failures_file_append "auth rollback compatibility: target auth at $TARGET_SHA cannot serve ${normalized_count} normalized account(s)"
        elif [[ "$AUTH_IDENTIFIER_ROLLBACK_CHECK" == "unknown" ]]; then
          AUTH_IDENTIFIER_ROLLBACK_CHECK="compatible"
        fi
      fi
    fi
  fi
fi

if [[ -s "$OUTPUT_DIR/failures.txt" ]]; then
  status="NO_GO"
else
  status="GO"
fi

write_text_atomic "$OUTPUT_DIR/summary.env" <<EOF
rollback_readiness=$status
mode=application-rollback
phase=steady-state
namespace=$OCI_K8S_NAMESPACE
public_url=$OCI_PUBLIC_URL
redirect_url=$OCI_REDIRECT_URL
diagnostic_url=$OCI_DIAGNOSTIC_URL
max_queue_ready=$MAX_QUEUE_READY
max_queue_unack=$MAX_QUEUE_UNACK
min_rollout_revisions=$MIN_ROLLOUT_REVISIONS
required_queues=$REQUIRED_QUEUES
target_sha=$TARGET_SHA
auth_identifier_rollback_check=$AUTH_IDENTIFIER_ROLLBACK_CHECK
auth_normalized_identifier_count=$AUTH_NORMALIZED_IDENTIFIER_COUNT
target_supports_normalized_identifiers=$TARGET_SUPPORTS_NORMALIZED_IDENTIFIERS
rollback_operator=
EOF

cat "$OUTPUT_DIR/summary.env"
if [[ "$status" != "GO" ]]; then
  cat "$OUTPUT_DIR/failures.txt" >&2
  exit 1
fi
