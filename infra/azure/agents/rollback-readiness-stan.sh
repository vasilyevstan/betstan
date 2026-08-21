#!/usr/bin/env bash
set -euo pipefail

# Purpose: produce an explicit GO/NO_GO signal before rollback actions in production.
# Usage examples:
#   ./infra/azure/agents/rollback-readiness-stan.sh
#   TARGET_SHA=<sha> ./infra/azure/agents/rollback-readiness-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=live-betting-readiness-lib.sh
source "$ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"

REPO="${REPO:-vasilyevstan/betstan}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/rollback-readiness}"
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
TOPOLOGY_CONFIGMAP="${TOPOLOGY_CONFIGMAP:-gaming-mongo-topology}"
LOCK_CONFIGMAP="${LOCK_CONFIGMAP:-gaming-mongo-migration-lock}"
MIGRATION_ID="${MIGRATION_ID:-}"
MIGRATION_BACKUP_DIR="${MIGRATION_BACKUP_DIR:-}"
EXPECTED_DATABASES=(
  gaming_auth gaming_bet gaming_backoffice gaming_event
  gaming_gamemaster gaming_moderation gaming_resulting gaming_slip
)

prepare_private_dir() {
  local directory="$1"
  if ! live_betting_prepare_private_dir "$directory"; then
    printf 'ERROR: unsafe private directory: %s\n' "$directory" >&2
    exit 1
  fi
}

prepare_private_dir "$OUTPUT_DIR"
WORK_PARENT_DIR="$OUTPUT_DIR/.workdirs"
prepare_private_dir "$WORK_PARENT_DIR"
WORK_DIR="$(live_betting_create_unique_private_dir "$WORK_PARENT_DIR" readiness)"
trap 'rm -rf -- "$WORK_DIR"; rmdir "$WORK_PARENT_DIR" 2>/dev/null || true' EXIT

FAILURES_FILE="$OUTPUT_DIR/failures.txt"
IMAGES_FILE="$OUTPUT_DIR/running-images.txt"
CURRENT_HTTP_FILE="$OUTPUT_DIR/current-http.tsv"
QUEUE_FILE="$OUTPUT_DIR/queue-state.tsv"
SUMMARY_FILE="$OUTPUT_DIR/summary.env"
: >"$FAILURES_FILE"
: >"$IMAGES_FILE"
: >"$CURRENT_HTTP_FILE"
: >"$QUEUE_FILE"

SUMMARY_STATUS="NO_GO"
SUMMARY_MODE="shared"
SUMMARY_PHASE=""
SUMMARY_OPERATOR=""
AUTH_IDENTIFIER_ROLLBACK_CHECK="unknown"
AUTH_NORMALIZED_IDENTIFIER_COUNT="unknown"
TARGET_SUPPORTS_NORMALIZED_IDENTIFIERS="unknown"

add_failure() {
  printf '%s\n' "$*" >>"$FAILURES_FILE"
}

checksum_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

write_summary() {
  {
    printf 'rollback_readiness=%s\n' "$SUMMARY_STATUS"
    printf 'mode=%s\n' "$SUMMARY_MODE"
    printf 'phase=%s\n' "$SUMMARY_PHASE"
    printf 'namespace=%s\n' "$NAMESPACE"
    printf 'hosts=%s\n' "$HOSTS"
    printf 'max_messages_ready=%s\n' "$MAX_MESSAGES_READY"
    printf 'max_messages_unack=%s\n' "$MAX_MESSAGES_UNACK"
    printf 'min_rollout_revisions=%s\n' "$MIN_ROLLOUT_REVISIONS"
    printf 'target_sha=%s\n' "$TARGET_SHA"
    printf 'auth_identifier_rollback_check=%s\n' "$AUTH_IDENTIFIER_ROLLBACK_CHECK"
    printf 'auth_normalized_identifier_count=%s\n' "$AUTH_NORMALIZED_IDENTIFIER_COUNT"
    printf 'target_supports_normalized_identifiers=%s\n' "$TARGET_SUPPORTS_NORMALIZED_IDENTIFIERS"
    printf 'rollback_operator=%s\n' "$SUMMARY_OPERATOR"
  } >"$SUMMARY_FILE"
}

emit_and_exit() {
  write_summary
  cat "$SUMMARY_FILE"
  if [[ -s "$IMAGES_FILE" ]]; then
    echo "=== running images ==="
    cat "$IMAGES_FILE"
  fi
  if [[ "$SUMMARY_STATUS" != "GO" ]]; then
    if [[ -s "$FAILURES_FILE" ]]; then
      echo "reasons:" >&2
      cat "$FAILURES_FILE" >&2
    fi
    exit 1
  fi
  exit 0
}

validate_transition_backup_dir() {
  if [[ "$MIGRATION_BACKUP_DIR" != /* || ! -d "$MIGRATION_BACKUP_DIR" ]]; then
    add_failure "MIGRATION_BACKUP_DIR must be an existing absolute directory"
    return
  fi
  local backup_real repo_real permissions
  backup_real="$(cd "$MIGRATION_BACKUP_DIR" && pwd -P)"
  repo_real="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$repo_real" && ("$backup_real" == "$repo_real" || "$backup_real" == "$repo_real/"*) ]]; then
    add_failure "MIGRATION_BACKUP_DIR must be outside the repository"
  fi
  permissions="$(
    stat -c '%a' "$MIGRATION_BACKUP_DIR" 2>/dev/null ||
      stat -f '%Lp' "$MIGRATION_BACKUP_DIR" 2>/dev/null ||
      true
  )"
  if ! [[ "$permissions" =~ ^[0-7]{3,4}$ ]] || ((10#$permissions % 100 != 0)); then
    add_failure "MIGRATION_BACKUP_DIR must not grant group or other permissions"
  fi
}

capture_jsonpath() {
  local output_file="$1"
  shift
  if "$@" >"$output_file" 2>"$WORK_DIR/capture.stderr"; then
    cat "$output_file"
    return 0
  fi
  return 1
}

check_http_contract() {
  local host="$1"
  local path="$2"
  local expected_kind="$3"
  local label="$4"
  local body_file="$WORK_DIR/${label}.body"
  local headers_file="$WORK_DIR/${label}.headers"
  local summary_file="$WORK_DIR/${label}.summary.json"
  local meta status effective_url content_type shape

  meta="$({
    curl --location --silent --show-error --max-time "$REQUEST_TIMEOUT" \
      --output "$body_file" --dump-header "$headers_file" \
      --write-out '%{http_code}\t%{url_effective}\t%{content_type}' \
      "https://${host}${path}"
  })" || {
    add_failure "host=$host path=$path request failed"
    return 1
  }
  IFS=$'\t' read -r status effective_url content_type <<<"$meta"
  if [[ "$status" != "200" ]]; then
    add_failure "host=$host path=$path returned HTTP $status"
    return 1
  fi

  case "$expected_kind" in
    prematch)
      [[ "$content_type" == application/json* ]] || {
        add_failure "host=$host path=$path expected JSON content"
        return 1
      }
      if ! live_betting_write_http_summary "$body_file" "$headers_file" "$summary_file" legacy-prematch-events \
          2>"$WORK_DIR/${label}.summary.stderr"; then
        add_failure "host=$host path=$path missing legacy PRE_MATCH evidence"
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
        add_failure "host=$host path=$path could not summarize legacy PRE_MATCH evidence"
        return 1
      }
      ;;
    auth)
      [[ "$content_type" == application/json* ]] || {
        add_failure "host=$host path=$path expected JSON content"
        return 1
      }
      if ! live_betting_write_http_summary "$body_file" "$headers_file" "$summary_file" current-user \
          2>"$WORK_DIR/${label}.summary.stderr"; then
        add_failure "host=$host path=$path incompatible currentUser payload"
        return 1
      fi
      shape="object.currentUser"
      ;;
    *)
      add_failure "host=$host path=$path unsupported expectation $expected_kind"
      return 1
      ;;
  esac

  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$host" "$path" "$status" "$effective_url" "$shape" >>"$CURRENT_HTTP_FILE"
}

for bin in gh git kubectl curl awk python3; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    add_failure "required binary missing: $bin"
  fi
done
if [[ -s "$FAILURES_FILE" ]]; then
  emit_and_exit
fi

topology_state=""
if ! topology_state="$(
  kubectl get configmap "$TOPOLOGY_CONFIGMAP" -n "$NAMESPACE" \
    -o jsonpath='{.data.mode}|{.data.phase}|{.data.migration-id}|{.data.source-sha}' \
    2>"$WORK_DIR/topology.stderr"
)"; then
  if ! grep -Eqi 'not[ -]?found' "$WORK_DIR/topology.stderr"; then
    add_failure "unable to read the shared-Mongo topology journal"
  fi
  topology_state=""
fi
IFS='|' read -r topology_mode topology_phase topology_migration_id topology_source_sha <<<"$topology_state"

if [[ "$topology_mode" == "transition" ]]; then
  SUMMARY_MODE="migration-transition"
  SUMMARY_PHASE="$topology_phase"
  case "$topology_phase" in
    backing-up|preparing-target|restoring|switching|validating-applications|awaiting-cleanup|rollback-copying|rollback-data-restored)
      ;;
    *)
      add_failure "unsupported shared-Mongo migration rollback phase: ${topology_phase:-missing}"
      ;;
  esac
  [[ "$MIGRATION_ID" == "$topology_migration_id" && -n "$MIGRATION_ID" ]] ||
    add_failure "MIGRATION_ID must match the active migration journal"
  [[ "$TARGET_SHA" == "$topology_source_sha" && "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    add_failure "TARGET_SHA must equal the migration journal source SHA"
  validate_transition_backup_dir

  lock_state=""
  if ! lock_state="$(
    kubectl get configmap "$LOCK_CONFIGMAP" -n "$NAMESPACE" -o jsonpath='{.data.state}' \
      2>"$WORK_DIR/lock.stderr"
  )"; then
    if ! grep -Eqi 'not[ -]?found' "$WORK_DIR/lock.stderr"; then
      add_failure "unable to read the database operation lock"
    fi
    lock_state=""
  fi
  [[ "$lock_state" == "released" ]] || add_failure "database operation lock must be released before rollback"

  case "$topology_phase" in
    validating-applications|awaiting-cleanup|rollback-copying|rollback-data-restored)
      if [[ "$MIGRATION_BACKUP_DIR" == /* && -d "$MIGRATION_BACKUP_DIR" ]]; then
        migration_manifest="$MIGRATION_BACKUP_DIR/$MIGRATION_ID-manifest.tsv"
        if [[ ! -f "$migration_manifest" || "$(wc -l <"$migration_manifest" | tr -d ' ')" != "8" ]]; then
          add_failure "migration backup manifest must contain eight databases"
        else
          for expected_database in "${EXPECTED_DATABASES[@]}"; do
            if [[ "$(awk -F '\t' -v database="$expected_database" '$1 == database { count++ } END { print count + 0 }' "$migration_manifest")" != "1" ]]; then
              add_failure "migration backup manifest must contain exactly one $expected_database entry"
            fi
          done
          while IFS=$'\t' read -r database archive_name expected_checksum; do
            if ! [[ "$database" =~ ^gaming_[a-z]+$ ]] || [[ "$archive_name" != "$MIGRATION_ID-$database.archive.gz" ]]; then
              add_failure "invalid migration backup mapping"
              continue
            fi
            archive="$MIGRATION_BACKUP_DIR/$archive_name"
            if [[ ! -s "$archive" ]]; then
              add_failure "migration backup archive is missing for $database"
            elif [[ "$(checksum_file "$archive")" != "$expected_checksum" ]]; then
              add_failure "migration backup checksum mismatch for $database"
            fi
          done <"$migration_manifest"
        fi
      fi
      ;;
  esac

  if [[ ! -s "$FAILURES_FILE" ]]; then
    SUMMARY_STATUS="GO"
    SUMMARY_OPERATOR="infra/azure/agents/consolidate-production-mongo-stan.sh"
  fi
  emit_and_exit
fi

if [[ "$topology_mode" == "shared" ]]; then
  if ! NAMESPACE="$NAMESPACE" "$ROOT_DIR/infra/azure/agents/shared-mongo-topology-guard-stan.sh"; then
    add_failure "shared Mongo topology guard failed"
  fi
elif [[ -n "$topology_mode" && "$topology_mode" != "legacy" ]]; then
  add_failure "unsupported shared-Mongo topology mode: $topology_mode"
fi

SUMMARY_MODE="${topology_mode:-shared}"

target_sha_valid=true
if [[ -z "$TARGET_SHA" ]]; then
  add_failure "TARGET_SHA is required before rollback action"
  target_sha_valid=false
elif ! [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  add_failure "TARGET_SHA must be a full lowercase commit SHA"
  target_sha_valid=false
fi

auth_names_valid=true
if ! [[ "$AUTH_DB_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || ! [[ "$AUTH_USER_COLLECTION" =~ ^[A-Za-z0-9_-]+$ ]]; then
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

for host in ${HOSTS//,/ }; do
  check_http_contract "$host" /api/event prematch "${host//[^A-Za-z0-9]/_}-event" || true
  check_http_contract "$host" /api/auth/currentuser auth "${host//[^A-Za-z0-9]/_}-auth" || true
done

rabbit_pod="$(kubectl get pod -n "$NAMESPACE" -l "$RABBIT_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$rabbit_pod" ]]; then
  add_failure "rabbitmq pod missing for selector: $RABBIT_SELECTOR"
else
  queue_dump="$WORK_DIR/queues.raw"
  if ! kubectl exec -n "$NAMESPACE" "$rabbit_pod" -- rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers >"$queue_dump"; then
    add_failure "unable to read RabbitMQ queues"
  else
    if ! awk '
      NR == 1 {
        if ($1 != "name" || $2 != "messages_ready" || $3 != "messages_unacknowledged" || $4 != "consumers") {
          exit 1
        }
        next
      }
      NR > 1 {
        if (NF < 4) {
          exit 1
        }
        print $1 "\t" $2 "\t" $3 "\t" $4
      }
    ' "$queue_dump" >"$QUEUE_FILE"; then
      add_failure "RabbitMQ queue output was malformed"
    else
      read -r total_ready total_unack <<<"$(awk -F '\t' '{ready+=$2; unack+=$3} END {print ready+0, unack+0}' "$QUEUE_FILE")"
      if [[ "$total_ready" -gt "$MAX_MESSAGES_READY" ]]; then
        add_failure "queue ready backlog too high: $total_ready > $MAX_MESSAGES_READY"
      fi
      if [[ "$total_unack" -gt "$MAX_MESSAGES_UNACK" ]]; then
        add_failure "queue unack backlog too high: $total_unack > $MAX_MESSAGES_UNACK"
      fi
    fi
  fi
fi

if [[ "$target_sha_valid" == true && "$auth_names_valid" == true ]]; then
  target_sha_full="$(git rev-parse "${TARGET_SHA}^{commit}" 2>/dev/null || true)"
  target_login="$(git show "${TARGET_SHA}:auth/src/route/LogIn.ts" 2>/dev/null || true)"
  if [[ -z "$target_sha_full" || -z "$target_login" || "$target_sha_full" != "$TARGET_SHA" ]]; then
    add_failure "unable to inspect auth login compatibility at target sha $TARGET_SHA"
    AUTH_IDENTIFIER_ROLLBACK_CHECK="missing-git-evidence"
  elif ! grep -q "normalizeIdentifier" <<<"$target_login" || ! grep -q "User.findOne({ identifierNormalized })" <<<"$target_login"; then
    TARGET_SUPPORTS_NORMALIZED_IDENTIFIERS="false"
    auth_rollout_state="$(kubectl get deployment "$AUTH_DEPLOYMENT" -n "$NAMESPACE" -o jsonpath='{.metadata.generation}|{.status.observedGeneration}|{.spec.replicas}|{.status.updatedReplicas}|{.status.readyReplicas}|{.status.availableReplicas}' 2>/dev/null || true)"
    IFS='|' read -r auth_generation auth_observed auth_replicas auth_updated auth_ready auth_available <<<"$auth_rollout_state"
    auth_generation="${auth_generation:-0}"
    auth_observed="${auth_observed:-0}"
    auth_replicas="${auth_replicas:-0}"
    auth_updated="${auth_updated:-0}"
    auth_ready="${auth_ready:-0}"
    auth_available="${auth_available:-0}"

    auth_rollout_observed=true
    if [[ "$auth_generation" -eq 0 || "$auth_observed" -lt "$auth_generation" || "$auth_updated" -ne "$auth_replicas" || "$auth_ready" -ne "$auth_replicas" || "$auth_available" -ne "$auth_replicas" ]]; then
      auth_rollout_observed=false
      add_failure "auth rollout is not fully observed: generation=$auth_generation observed=$auth_observed replicas=$auth_replicas updated=$auth_updated ready=$auth_ready available=$auth_available"
    fi

    auth_pod_rows="$(kubectl get pods -n "$NAMESPACE" -l "$AUTH_POD_SELECTOR" -o jsonpath="{range .items[*]}{.metadata.name}|{.status.phase}|{.status.conditions[?(@.type=='Ready')].status}|{.spec.containers[?(@.name=='${AUTH_CONTAINER}')].image}{'\\n'}{end}" 2>/dev/null || true)"
    serving_auth_images=()
    ready_auth_pod_count=0
    missing_auth_container=false
    while IFS='|' read -r auth_pod auth_phase auth_pod_ready auth_pod_image; do
      [[ -n "$auth_pod" ]] || continue
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
        if [[ "$serving_auth_image" != "$expected_auth_image" && ! "$serving_auth_image" =~ ^${expected_auth_image}@sha256:[0-9a-f]{64}$ ]]; then
          incompatible_serving_image=true
        fi
      done
    fi

    auth_mongo_pod="$(kubectl get pod -n "$NAMESPACE" -l "$AUTH_MONGO_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    if [[ -z "$auth_mongo_pod" ]]; then
      add_failure "auth mongo pod missing for selector: $AUTH_MONGO_SELECTOR"
      AUTH_IDENTIFIER_ROLLBACK_CHECK="missing-auth-mongo"
    else
      mongo_query="db.getCollection('${AUTH_USER_COLLECTION}').countDocuments({identifierNormalized: {\$type: 'string'}})"
      if ! normalized_count="$(kubectl exec -n "$NAMESPACE" "$auth_mongo_pod" -- mongosh --quiet "mongodb://localhost:27017/${AUTH_DB_NAME}" --eval "$mongo_query" 2>/dev/null)"; then
        add_failure "unable to count normalized auth identifiers before rollback"
        AUTH_IDENTIFIER_ROLLBACK_CHECK="query-failed"
      else
        normalized_count="$(tail -n 1 <<<"$normalized_count" | tr -d '\r')"
        AUTH_NORMALIZED_IDENTIFIER_COUNT="$normalized_count"
        if ! [[ "$normalized_count" =~ ^[0-9]+$ ]]; then
          add_failure "unexpected normalized auth identifier count: $normalized_count"
          AUTH_IDENTIFIER_ROLLBACK_CHECK="invalid-query-result"
        elif [[ "$normalized_count" -gt 0 ]]; then
          add_failure "target auth at $TARGET_SHA is not identifier-compatible; found $normalized_count normalized account(s). Keep the current auth image and roll back only compatible services, or forward-fix"
          AUTH_IDENTIFIER_ROLLBACK_CHECK="incompatible"
        elif [[ "$auth_rollout_observed" != true || "$incompatible_serving_image" == true ]]; then
          add_failure "target auth at $TARGET_SHA is not identifier-compatible and serving auth images are: ${serving_auth_images[*]:-none}. Keep the current auth image during rollback; a zero account count is not an atomic rollback window"
          AUTH_IDENTIFIER_ROLLBACK_CHECK="serving-image-mismatch"
        else
          AUTH_IDENTIFIER_ROLLBACK_CHECK="compatible"
        fi
      fi
    fi
  else
    TARGET_SUPPORTS_NORMALIZED_IDENTIFIERS="true"
    AUTH_NORMALIZED_IDENTIFIER_COUNT="0"
    AUTH_IDENTIFIER_ROLLBACK_CHECK="compatible"
  fi
fi

deploy_names="$(kubectl get deploy -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' || true)"
for d in $deploy_names; do
  rev_count="$(kubectl rollout history "deploy/${d}" -n "$NAMESPACE" 2>/dev/null | awk '/^[0-9]+/ {c++} END{print c+0}')"
  if [[ "$rev_count" -lt "$MIN_ROLLOUT_REVISIONS" ]]; then
    add_failure "deployment $d has only $rev_count rollout revision(s)"
  fi
done

kubectl get deploy -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.template.spec.containers[*]}{.image}{" "}{end}{"\n"}{end}' >"$IMAGES_FILE" || true

if [[ "$target_sha_valid" == true ]]; then
  for workflow in production-build production-deploy; do
    if ! provenance="$(REPO="$REPO" WORKFLOW="$workflow" TARGET_SHA="$TARGET_SHA" "$PROVENANCE_SCRIPT" 2>/dev/null)"; then
      add_failure "target sha $TARGET_SHA lacks a verifiable successful $workflow run"
    else
      read -r run_id run_status run_conclusion run_url <<<"$provenance"
      printf 'rollback_provenance_ok=%s run_id=%s url=%s\n' "$workflow" "$run_id" "$run_url"
    fi
  done
fi

if [[ ! -s "$FAILURES_FILE" ]]; then
  SUMMARY_STATUS="GO"
fi
emit_and_exit
