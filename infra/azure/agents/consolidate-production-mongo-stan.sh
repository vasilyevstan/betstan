#!/usr/bin/env bash
set -euo pipefail

# Purpose: migrate seven service databases into the retained auth Mongo, switch
# applications, validate, and explicitly retire or restore the legacy topology.
#
# Operations:
#   plan       Print the sanitized immutable migration mapping.
#   preflight  Validate the exact repository and live legacy topology read-only.
#   migrate    Freeze-confirmed backup, restore, URI switch, and application start.
#   cleanup    Delete the exact seven validated legacy StatefulSets/Services/PVCs.
#   rollback   Reverse-copy shared data into recreated legacy databases and switch back.
#   unlock     Remove an explicitly confirmed stale migration-operation lock.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATION="${1:-}"
NAMESPACE="${NAMESPACE:-default}"
APPROVED_SHA="${APPROVED_SHA:-}"
MIGRATION_ID="${MIGRATION_ID:-}"
BACKUP_DIR="${BACKUP_DIR:-}"
TARGET_STS="${TARGET_STS:-gaming-auth-mongo-depl}"
TARGET_POD="${TARGET_POD:-gaming-auth-mongo-depl-0}"
TARGET_PVC="${TARGET_PVC:-gaming-auth-mongo-data-gaming-auth-mongo-depl-0}"
TARGET_SIZE="${TARGET_SIZE:-8Gi}"
SHARED_SERVICE="${SHARED_SERVICE:-gaming-shared-mongo-srv}"
TOPOLOGY_CONFIGMAP="${TOPOLOGY_CONFIGMAP:-gaming-mongo-topology}"
LOCK_CONFIGMAP="${LOCK_CONFIGMAP:-gaming-mongo-migration-lock}"
LOCK_SCRIPT="$ROOT_DIR/infra/azure/agents/shared-mongo-operation-lock-stan.sh"
SIGNATURE_SCRIPT="$ROOT_DIR/infra/azure/agents/mongo-database-signature-stan.js"
LEGACY_MANIFEST_DIR="$ROOT_DIR/infra/k8s/legacy-mongo"

APPLICATIONS=(auth bet backoffice event gamemaster moderation resulting slip)

DATABASE_MAPPINGS=(
  "gaming_bet|gaming-bet-mongo-depl-0|gaming-bet-depl|gaming-bet-mongo-srv|gaming-bet-mongo-data-gaming-bet-mongo-depl-0"
  "gaming_backoffice|gaming-backoffice-mongo-depl-0|gaming-backoffice-depl|gaming-backoffice-mongo-srv|gaming-backoffice-mongo-data-gaming-backoffice-mongo-depl-0"
  "gaming_event|gaming-event-mongo-depl-0|gaming-event-depl|gaming-event-mongo-srv|gaming-event-mongo-data-gaming-event-mongo-depl-0"
  "gaming_gamemaster|gaming-gamemaster-mongo-depl-0|gaming-gamemaster-depl|gaming-gamemaster-mongo-srv|gaming-gamemaster-mongo-data-gaming-gamemaster-mongo-depl-0"
  "gaming_moderation|gaming-moderation-mongo-depl-0|gaming-moderation-depl|gaming-moderation-mongo-srv|gaming-moderation-mongo-data-gaming-moderation-mongo-depl-0"
  "gaming_resulting|gaming-resulting-mongo-depl-0|gaming-resulting-depl|gaming-resulting-mongo-srv|gaming-resulting-mongo-data-gaming-resulting-mongo-depl-0"
  "gaming_slip|gaming-slip-mongo-depl-0|gaming-slip-depl|gaming-slip-mongo-srv|gaming-slip-mongo-data-gaming-slip-mongo-depl-0"
)

AUTH_MAPPING="gaming_auth|gaming-auth-mongo-depl-0|gaming-auth-depl|gaming-auth-mongo-srv|$TARGET_PVC"
TEMP_FILES=()
LOCK_HELD=false
LOCK_TOKEN=""

release_lock() {
  [[ "$LOCK_HELD" == true && -n "$LOCK_TOKEN" ]] || return 0
  NAMESPACE="$NAMESPACE" \
    LOCK_CONFIGMAP="$LOCK_CONFIGMAP" \
    LOCK_TOKEN="$LOCK_TOKEN" \
    OPERATION_ID="$MIGRATION_ID" \
    SOURCE_SHA="$APPROVED_SHA" \
    "$LOCK_SCRIPT" release >/dev/null
  LOCK_HELD=false
}

cleanup_operation() {
  local exit_code=$?
  local release_code=0
  trap - EXIT
  set +e
  release_lock
  release_code=$?
  if [[ "${#TEMP_FILES[@]}" -gt 0 ]]; then
    rm -f -- "${TEMP_FILES[@]}"
  fi
  if [[ "$exit_code" -eq 0 && "$release_code" -ne 0 ]]; then
    exit "$release_code"
  fi
  exit "$exit_code"
}
trap cleanup_operation EXIT

fail() {
  echo "shared_mongo_operation=${OPERATION:-missing} status=FAIL reason=$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command missing: $1"
}

require_value() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$name must equal the documented confirmation value"
}

checksum_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

database_signature() {
  local pod="$1"
  local database="$2"
  {
    printf 'const DB_NAME = "%s";\n' "$database"
    cat "$SIGNATURE_SCRIPT"
  } | kubectl exec -i -n "$NAMESPACE" "$pod" -- mongosh --quiet |
    tail -n 1
}

database_exists() {
  local pod="$1"
  local database="$2"
  local exists
  exists="$(
    kubectl exec -n "$NAMESPACE" "$pod" -- mongosh --quiet --eval "
      const result = db.adminCommand({listDatabases: 1, nameOnly: true});
      print(result.databases.some((item) => item.name === \"$database\"));
    " | tail -n 1
  )"
  [[ "$exists" == "true" ]]
}

deployment_mongo_uri() {
  local deployment="$1"
  local container="${deployment%-depl}"
  kubectl get deployment "$deployment" -n "$NAMESPACE" -o json |
    python3 -c '
import json
import sys

container_name = sys.argv[1]
document = json.load(sys.stdin)
values = [
    variable.get("value", "")
    for container in document["spec"]["template"]["spec"]["containers"]
    if container["name"] == container_name
    for variable in container.get("env", [])
    if variable["name"] == "MONGO_URI"
]
print(values[0] if len(values) == 1 else "")
' "$container"
}

mongo_runtime_signature() {
  local pod="$1"
  kubectl exec -n "$NAMESPACE" "$pod" -- mongosh --quiet --eval '
    const result = db.adminCommand({getParameter: 1, featureCompatibilityVersion: 1});
    if (result.ok !== 1) {
      throw new Error("unable to read featureCompatibilityVersion");
    }
    print(db.version() + "|" + result.featureCompatibilityVersion.version);
  ' | tail -n 1
}

database_size_bytes() {
  local pod="$1"
  local database="$2"
  kubectl exec -n "$NAMESPACE" "$pod" -- mongosh --quiet --eval "
    const stats = db.getSiblingDB(\"$database\").stats(1);
    if (stats.ok !== 1) {
      throw new Error(\"unable to read database stats\");
    }
    print(Math.ceil((stats.dataSize || 0) + (stats.indexSize || 0)));
  " | tail -n 1
}

quantity_bytes() {
  local quantity="$1"
  local number unit multiplier
  if [[ "$quantity" =~ ^([1-9][0-9]*)(Mi|Gi|Ti)$ ]]; then
    number="${BASH_REMATCH[1]}"
    unit="${BASH_REMATCH[2]}"
  else
    fail "unsupported storage quantity: $quantity"
  fi
  case "$unit" in
    Mi) multiplier=$((1024 * 1024)) ;;
    Gi) multiplier=$((1024 * 1024 * 1024)) ;;
    Ti) multiplier=$((1024 * 1024 * 1024 * 1024)) ;;
  esac
  echo $((number * multiplier))
}

backup_path() {
  local database="$1"
  printf '%s/%s-%s.archive.gz' "$BACKUP_DIR" "$MIGRATION_ID" "$database"
}

signature_path() {
  local database="$1"
  printf '%s/%s-%s.signature.json' "$BACKUP_DIR" "$MIGRATION_ID" "$database"
}

prepare_backup_dir() {
  [[ -n "$BACKUP_DIR" ]] || fail "BACKUP_DIR is required"
  [[ "$BACKUP_DIR" == /* ]] || fail "BACKUP_DIR must be an absolute path"
  mkdir -p -m 700 "$BACKUP_DIR"
  local resolved
  resolved="$(cd "$BACKUP_DIR" && pwd -P)"
  case "$resolved/" in
    "$ROOT_DIR/"*)
      fail "BACKUP_DIR must be outside the repository"
      ;;
  esac
  BACKUP_DIR="$resolved"
  umask 077
}

validate_identifiers() {
  [[ "$MIGRATION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] ||
    fail "MIGRATION_ID must be 1..63 safe characters"
  [[ "$TARGET_SIZE" =~ ^[1-9][0-9]*(Mi|Gi|Ti)$ ]] ||
    fail "TARGET_SIZE is invalid"
}

validate_exact_checkout() {
  require_command git
  [[ "$APPROVED_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    fail "APPROVED_SHA must be a complete lowercase commit SHA"
  local head
  head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  [[ "$head" == "$APPROVED_SHA" ]] ||
    fail "APPROVED_SHA does not equal the checked-out commit"
  [[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no)" ]] ||
    fail "tracked worktree changes are not allowed"
}

acquire_lock() {
  LOCK_TOKEN="${MIGRATION_ID}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  NAMESPACE="$NAMESPACE" \
    LOCK_CONFIGMAP="$LOCK_CONFIGMAP" \
    LOCK_TOKEN="$LOCK_TOKEN" \
    OPERATION_ID="$MIGRATION_ID" \
    SOURCE_SHA="$APPROVED_SHA" \
    "$LOCK_SCRIPT" acquire >/dev/null
  LOCK_HELD=true
}

remove_stale_lock() {
  NAMESPACE="$NAMESPACE" \
    LOCK_CONFIGMAP="$LOCK_CONFIGMAP" \
    LOCK_TOKEN="unlock-${MIGRATION_ID}" \
    OPERATION_ID="$MIGRATION_ID" \
    SOURCE_SHA="$APPROVED_SHA" \
    CONFIRM_FORCE_RELEASE=release-matching-stale-database-lock \
    "$LOCK_SCRIPT" force-release >/dev/null
}

validate_repository_contract() {
  [[ -x "$LOCK_SCRIPT" ]] || fail "database operation lock helper is missing"
  [[ -f "$SIGNATURE_SCRIPT" ]] || fail "database signature helper is missing"
  [[ -d "$LEGACY_MANIFEST_DIR" ]] || fail "legacy rollback manifests are missing"

  local active_mongo_manifests=()
  while IFS= read -r manifest; do
    active_mongo_manifests+=("$manifest")
  done < <(
    find "$ROOT_DIR/infra/k8s" -maxdepth 1 -type f -name '*-mongo-depl.yaml' -print |
      LC_ALL=C sort
  )
  [[ "${#active_mongo_manifests[@]}" -eq 1 &&
    "${active_mongo_manifests[0]}" == "$ROOT_DIR/infra/k8s/auth-mongo-depl.yaml" ]] ||
    fail "active manifests must contain only auth-mongo-depl.yaml"

  local legacy_manifests=()
  while IFS= read -r manifest; do
    legacy_manifests+=("$manifest")
  done < <(
    find "$LEGACY_MANIFEST_DIR" -maxdepth 1 -type f -name '*-mongo-depl.yaml' -print |
      LC_ALL=C sort
  )
  [[ "${#legacy_manifests[@]}" -eq 7 ]] ||
    fail "exactly seven legacy rollback manifests are required"

  local mapping database _source_pod deployment _service _pvc service expected_uri actual_uri
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database _source_pod deployment _service _pvc <<<"$mapping"
    service="${deployment#gaming-}"
    service="${service%-depl}"
    expected_uri="mongodb://${SHARED_SERVICE}:27017/${database}"
    actual_uri="$(
      awk '
        $0 ~ /name: MONGO_URI/ {getline; sub(/^[[:space:]]+value:[[:space:]]*/, ""); gsub(/"/, ""); print; exit}
      ' "$ROOT_DIR/infra/k8s/${service}-depl.yaml"
    )"
    [[ "$actual_uri" == "$expected_uri" ]] ||
      fail "shared URI mapping mismatch for $service"
  done
}

set_journal() {
  local mode="$1"
  local phase="$2"
  local validated="$3"
  kubectl create configmap "$TOPOLOGY_CONFIGMAP" -n "$NAMESPACE" \
    --from-literal="mode=$mode" \
    --from-literal="phase=$phase" \
    --from-literal="validated=$validated" \
    --from-literal="migration-id=$MIGRATION_ID" \
    --from-literal="source-sha=$APPROVED_SHA" \
    --dry-run=client -o yaml |
    kubectl apply -f - >/dev/null
}

require_journal() {
  local expected_mode="$1"
  local expected_phase="$2"
  local actual
  actual="$(
    kubectl get configmap "$TOPOLOGY_CONFIGMAP" -n "$NAMESPACE" \
      -o jsonpath='{.data.mode}|{.data.phase}|{.data.migration-id}|{.data.source-sha}' \
      2>/dev/null || true
  )"
  [[ "$actual" == "$expected_mode|$expected_phase|$MIGRATION_ID|$APPROVED_SHA" ]] ||
    fail "migration journal does not match this operation"
}

journal_state() {
  kubectl get configmap "$TOPOLOGY_CONFIGMAP" -n "$NAMESPACE" \
    -o jsonpath='{.data.mode}|{.data.phase}|{.data.migration-id}|{.data.source-sha}' \
    2>/dev/null || true
}

validate_migrate_journal() {
  local current mode phase migration_id source_sha
  current="$(journal_state)"
  [[ -n "$current" ]] || return 0
  IFS='|' read -r mode phase migration_id source_sha <<<"$current"

  if [[ "$mode" == "transition" &&
    "$migration_id" == "$MIGRATION_ID" &&
    "$source_sha" == "$APPROVED_SHA" ]]; then
    case "$phase" in
      backing-up | preparing-target | restoring)
        return 0
        ;;
      *)
        fail "migration progressed beyond a safely resumable phase; roll back first"
        ;;
    esac
  fi

  if [[ "$mode" == "legacy" && "$phase" == "rollback-complete" ]]; then
    [[ "$migration_id" != "$MIGRATION_ID" ]] ||
      fail "a fresh MIGRATION_ID is required after rollback"
    return 0
  fi

  fail "existing topology journal does not permit migration"
}

require_bound_pvc() {
  local pvc="$1"
  local phase
  phase="$(kubectl get pvc "$pvc" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [[ "$phase" == "Bound" ]] || fail "PVC is not Bound: $pvc"
}

require_ready_pod() {
  local pod="$1"
  local ready
  ready="$(
    kubectl get pod "$pod" -n "$NAMESPACE" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true
  )"
  [[ "$ready" == "True" ]] || fail "pod is not Ready: $pod"
}

verify_legacy_runtime() {
  local mapping database source_pod _deployment _service pvc
  local target_runtime source_runtime database_bytes total_bytes target_bytes
  require_ready_pod "gaming-auth-mongo-depl-0"
  require_bound_pvc "$TARGET_PVC"
  database_exists "gaming-auth-mongo-depl-0" gaming_auth ||
    fail "source database is missing: gaming_auth"
  target_runtime="$(mongo_runtime_signature "gaming-auth-mongo-depl-0")"
  [[ "$target_runtime" =~ ^[0-9]+\.[0-9]+\.[0-9]+\|[0-9]+\.[0-9]+$ ]] ||
    fail "auth Mongo returned an invalid version/FCV"
  total_bytes="$(database_size_bytes "gaming-auth-mongo-depl-0" gaming_auth)"
  [[ "$total_bytes" =~ ^[0-9]+$ ]] ||
    fail "gaming_auth returned an invalid data size"
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database source_pod _deployment _service pvc <<<"$mapping"
    require_ready_pod "$source_pod"
    require_bound_pvc "$pvc"
    database_exists "$source_pod" "$database" ||
      fail "source database is missing: $database"
    source_runtime="$(mongo_runtime_signature "$source_pod")"
    [[ "$source_runtime" == "$target_runtime" ]] ||
      fail "Mongo version/FCV mismatch for $database"
    database_bytes="$(database_size_bytes "$source_pod" "$database")"
    [[ "$database_bytes" =~ ^[0-9]+$ ]] ||
      fail "$database returned an invalid data size"
    total_bytes=$((total_bytes + database_bytes))
    database_signature "$source_pod" "$database" >/dev/null ||
      fail "unable to inventory $database"
  done
  database_signature "gaming-auth-mongo-depl-0" gaming_auth >/dev/null ||
    fail "unable to inventory gaming_auth"

  target_bytes="$(quantity_bytes "$TARGET_SIZE")"
  [[ $((total_bytes * 2)) -le "$target_bytes" ]] ||
    fail "combined data and indexes exceed 50% of TARGET_SIZE"

  local current_request storage_class expansion_allowed
  current_request="$(
    kubectl get pvc "$TARGET_PVC" -n "$NAMESPACE" \
      -o jsonpath='{.spec.resources.requests.storage}'
  )"
  if [[ "$(quantity_bytes "$current_request")" -lt "$target_bytes" ]]; then
    storage_class="$(
      kubectl get pvc "$TARGET_PVC" -n "$NAMESPACE" \
        -o jsonpath='{.spec.storageClassName}'
    )"
    [[ -n "$storage_class" ]] || fail "auth PVC has no StorageClass"
    expansion_allowed="$(
      kubectl get storageclass "$storage_class" \
        -o jsonpath='{.allowVolumeExpansion}' 2>/dev/null || true
    )"
    [[ "$expansion_allowed" == "true" ]] ||
      fail "auth PVC StorageClass does not allow expansion"
  fi

  echo "mongo_runtime_compatibility=PASS runtime=$target_runtime databases=8"
  echo "mongo_capacity=PASS target=$TARGET_SIZE utilization_limit_percent=50"
}

verify_legacy_applications() {
  local mapping database _source_pod deployment service _pvc expected_uri actual_uri
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database _source_pod deployment service _pvc <<<"$mapping"
    expected_uri="mongodb://${service}:27017/${database}"
    actual_uri="$(deployment_mongo_uri "$deployment")"
    [[ "$actual_uri" == "$expected_uri" ]] ||
      fail "live legacy URI mismatch for $deployment"
  done
  echo "legacy_mongo_uris=PASS deployments=8"
}

verify_queue_drain() {
  local rabbit_pod queue_dump total_ready total_unack
  rabbit_pod="$(
    kubectl get pod -n "$NAMESPACE" -l app=gaming-rabbitmq \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
  )"
  [[ -n "$rabbit_pod" ]] || fail "RabbitMQ pod is missing"
  queue_dump="$(mktemp)"
  TEMP_FILES+=("$queue_dump")
  kubectl exec -n "$NAMESPACE" "$rabbit_pod" -- \
    rabbitmqctl list_queues name messages_ready messages_unacknowledged >"$queue_dump"
  read -r total_ready total_unack <<<"$(
    awk 'NR>1 {ready+=$2; unack+=$3} END {print ready+0, unack+0}' "$queue_dump"
  )"
  [[ "$total_ready" -eq 0 && "$total_unack" -eq 0 ]] ||
    fail "RabbitMQ is not drained"
  rm -f "$queue_dump"
}

scale_applications() {
  local replicas="$1"
  local service deployment attempt desired available ready pod_count
  for service in "${APPLICATIONS[@]}"; do
    deployment="gaming-${service}-depl"
    kubectl scale deployment "$deployment" -n "$NAMESPACE" --replicas="$replicas" >/dev/null
    if [[ "$replicas" -eq 1 ]]; then
      kubectl rollout status deployment "$deployment" -n "$NAMESPACE" --timeout=5m
    fi
  done
  if [[ "$replicas" -eq 0 ]]; then
    for service in "${APPLICATIONS[@]}"; do
      deployment="gaming-${service}-depl"
      for attempt in {1..150}; do
        read -r desired available ready <<<"$(
          kubectl get deployment "$deployment" -n "$NAMESPACE" \
            -o jsonpath='{.spec.replicas} {.status.availableReplicas} {.status.readyReplicas}' \
            2>/dev/null || true
        )"
        desired="${desired:-0}"
        available="${available:-0}"
        ready="${ready:-0}"
        pod_count="$(
          kubectl get pods -n "$NAMESPACE" -l "app=gaming-${service}" \
            -o name 2>/dev/null | wc -l | tr -d ' '
        )"
        if [[ "$desired" -eq 0 &&
          "$available" -eq 0 &&
          "$ready" -eq 0 &&
          "$pod_count" -eq 0 ]]; then
          break
        fi
        sleep 2
      done
      [[ "$desired" -eq 0 &&
        "$available" -eq 0 &&
        "$ready" -eq 0 &&
        "$pod_count" -eq 0 ]] ||
        fail "application pods did not terminate: $deployment"
    done
  fi
}

write_backups() {
  local mapping database source_pod _deployment _service _pvc archive signature tmp_archive
  local existing_entry expected_checksum
  local manifest="$BACKUP_DIR/$MIGRATION_ID-manifest.tsv"
  touch "$manifest"
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database source_pod _deployment _service _pvc <<<"$mapping"
    archive="$(backup_path "$database")"
    signature="$(signature_path "$database")"
    existing_entry="$(awk -F '\t' -v expected="$database" '$1 == expected {print $0}' "$manifest")"
    if [[ -n "$existing_entry" ]]; then
      [[ -s "$archive" && -s "$signature" ]] ||
        fail "journaled backup is incomplete for $database"
      expected_checksum="$(awk -F '\t' -v expected="$database" '$1 == expected {print $3}' "$manifest")"
      [[ "$(checksum_file "$archive")" == "$expected_checksum" ]] ||
        fail "journaled backup checksum mismatch for $database"
      database_signature "$source_pod" "$database" |
        cmp -s "$signature" - ||
        fail "source database changed since backup: $database"
      continue
    fi
    if [[ -e "$archive" || -e "$signature" ]]; then
      rm -f "$archive" "$signature"
    fi
    tmp_archive="${archive}.partial"
    rm -f "$tmp_archive"
    kubectl exec -n "$NAMESPACE" "$source_pod" -- \
      mongodump --quiet --archive --gzip --db "$database" >"$tmp_archive"
    [[ -s "$tmp_archive" ]] || fail "empty backup for $database"
    mv "$tmp_archive" "$archive"
    database_signature "$source_pod" "$database" >"$signature"
    [[ -s "$signature" ]] || fail "empty signature for $database"
    printf '%s\t%s\t%s\n' "$database" "$(basename "$archive")" "$(checksum_file "$archive")" \
      >>"$manifest"
  done
  chmod 600 "$manifest" "$BACKUP_DIR"/"$MIGRATION_ID"-*
}

verify_backups() {
  local manifest="$BACKUP_DIR/$MIGRATION_ID-manifest.tsv"
  [[ -f "$manifest" ]] || fail "backup manifest is missing"
  [[ "$(wc -l <"$manifest" | tr -d ' ')" == "8" ]] ||
    fail "backup manifest must contain exactly eight databases"
  local database archive_name expected_checksum archive actual_checksum
  while IFS=$'\t' read -r database archive_name expected_checksum; do
    [[ "$database" =~ ^gaming_[a-z]+$ ]] || fail "invalid backup database entry"
    [[ "$archive_name" == "$MIGRATION_ID-$database.archive.gz" ]] ||
      fail "invalid backup archive mapping for $database"
    archive="$BACKUP_DIR/$archive_name"
    [[ -s "$archive" ]] || fail "backup archive is missing"
    actual_checksum="$(checksum_file "$archive")"
    [[ "$actual_checksum" == "$expected_checksum" ]] ||
      fail "backup checksum mismatch for $database"
    [[ -s "$(signature_path "$database")" ]] ||
      fail "backup signature is missing for $database"
  done <"$manifest"
  local mapping expected_database _source_pod _deployment _service _pvc
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r expected_database _source_pod _deployment _service _pvc <<<"$mapping"
    [[ "$(awk -F '\t' -v expected="$expected_database" '$1 == expected {count++} END {print count+0}' "$manifest")" == "1" ]] ||
      fail "backup manifest must contain one entry for $expected_database"
  done
}

prepare_target() {
  kubectl patch pvc "$TARGET_PVC" -n "$NAMESPACE" --type=merge \
    -p "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"$TARGET_SIZE\"}}}}" >/dev/null
  kubectl apply -n "$NAMESPACE" -f "$ROOT_DIR/infra/k8s/auth-mongo-depl.yaml" >/dev/null

  local capacity attempt
  capacity=""
  for attempt in {1..120}; do
    capacity="$(
      kubectl get pvc "$TARGET_PVC" -n "$NAMESPACE" \
        -o jsonpath='{.status.capacity.storage}' 2>/dev/null || true
    )"
    if [[ "$(quantity_bytes "${capacity:-1Mi}")" -ge "$(quantity_bytes "$TARGET_SIZE")" ]]; then
      break
    fi
    sleep 5
  done
  [[ "$(quantity_bytes "${capacity:-1Mi}")" -ge "$(quantity_bytes "$TARGET_SIZE")" ]] ||
    fail "auth PVC online expansion did not reach $TARGET_SIZE"

  require_bound_pvc "$TARGET_PVC"
  require_ready_pod "$TARGET_POD"
}

restore_shared_databases() {
  local mapping database _source_pod _deployment _service _pvc archive expected_signature
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database _source_pod _deployment _service _pvc <<<"$mapping"
    archive="$(backup_path "$database")"
    kubectl exec -n "$NAMESPACE" "$TARGET_POD" -- mongosh --quiet --eval \
      "db.getSiblingDB(\"$database\").dropDatabase()" >/dev/null
    kubectl exec -i -n "$NAMESPACE" "$TARGET_POD" -- \
      mongorestore --quiet --archive --gzip --drop --nsInclude="${database}.*" <"$archive"
    expected_signature="$(signature_path "$database")"
    database_signature "$TARGET_POD" "$database" |
      cmp -s "$expected_signature" - ||
      fail "restored database parity failed for $database"
  done
  database_signature "$TARGET_POD" gaming_auth |
    cmp -s "$(signature_path gaming_auth)" - ||
    fail "gaming_auth changed during target preparation"
}

set_shared_uris() {
  local mapping database _source_pod deployment _service _pvc
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database _source_pod deployment _service _pvc <<<"$mapping"
    kubectl set env deployment/"$deployment" -n "$NAMESPACE" \
      "MONGO_URI=mongodb://${SHARED_SERVICE}:27017/${database}" >/dev/null
  done
}

set_legacy_uris() {
  local mapping database _source_pod deployment service _pvc
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database _source_pod deployment service _pvc <<<"$mapping"
    kubectl set env deployment/"$deployment" -n "$NAMESPACE" \
      "MONGO_URI=mongodb://${service}:27017/${database}" >/dev/null
  done
}

verify_shared_databases() {
  local mapping database _source_pod _deployment _service _pvc
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database _source_pod _deployment _service _pvc <<<"$mapping"
    database_signature "$TARGET_POD" "$database" |
      cmp -s "$(signature_path "$database")" - ||
      fail "shared database parity failed for $database"
  done
}

verify_shared_database_presence() {
  local mapping database _source_pod _deployment _service _pvc signature current_file
  local baseline_file
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database _source_pod _deployment _service _pvc <<<"$mapping"
    database_exists "$TARGET_POD" "$database" ||
      fail "shared database is missing: $database"
    signature="$(database_signature "$TARGET_POD" "$database")"
    [[ -n "$signature" ]] ||
      fail "unable to validate shared database: $database"
    baseline_file="$(signature_path "$database")"
    [[ -s "$baseline_file" ]] ||
      fail "baseline signature is missing for $database"
    current_file="$(mktemp)"
    TEMP_FILES+=("$current_file")
    printf '%s\n' "$signature" >"$current_file"
    python3 - "$baseline_file" "$current_file" <<'PY' ||
import json
import sys

baseline = json.load(open(sys.argv[1]))
current = json.load(open(sys.argv[2]))
baseline_collections = {item["name"]: item for item in baseline["collections"]}
current_collections = {item["name"]: item for item in current["collections"]}

for name, expected in baseline_collections.items():
    if name not in current_collections:
        raise SystemExit(f"missing baseline collection: {name}")
    actual = current_collections[name]
    for field in ("type", "options", "idIndex", "indexes"):
        if expected.get(field) != actual.get(field):
            raise SystemExit(f"metadata mismatch: {name}.{field}")
PY
      fail "shared database baseline metadata changed for $database"
  done
}

verify_shared_uris() {
  local mapping database _source_pod deployment _service _pvc actual_uri expected_uri
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database _source_pod deployment _service _pvc <<<"$mapping"
    expected_uri="mongodb://${SHARED_SERVICE}:27017/${database}"
    actual_uri="$(deployment_mongo_uri "$deployment")"
    [[ "$actual_uri" == "$expected_uri" ]] ||
      fail "unexpected live URI for $deployment"
  done
}

verify_shared_applications() {
  local mapping _database _source_pod deployment _service _pvc available
  verify_shared_uris
  for mapping in "$AUTH_MAPPING" "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _database _source_pod deployment _service _pvc <<<"$mapping"
    available="$(
      kubectl get deployment "$deployment" -n "$NAMESPACE" \
        -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true
    )"
    [[ "${available:-0}" -ge 1 ]] ||
      fail "deployment is not available: $deployment"
  done
}

delete_legacy_resources() {
  local cleanup_map="$BACKUP_DIR/$MIGRATION_ID-cleanup-pvs.tsv"
  local cleanup_map_tmp="${cleanup_map}.partial"
  local mapping _database source_pod _deployment service pvc sts pv attempt

  if [[ ! -f "$cleanup_map" ]]; then
    : >"$cleanup_map_tmp"
    for mapping in "${DATABASE_MAPPINGS[@]}"; do
      IFS='|' read -r _database _source_pod _deployment _service pvc <<<"$mapping"
      pv="$(
        kubectl get pvc "$pvc" -n "$NAMESPACE" \
          -o jsonpath='{.spec.volumeName}' 2>/dev/null || true
      )"
      [[ -n "$pv" ]] || fail "PVC has no bound PV: $pvc"
      printf '%s\t%s\n' "$pvc" "$pv" >>"$cleanup_map_tmp"
    done
    mv "$cleanup_map_tmp" "$cleanup_map"
    chmod 600 "$cleanup_map"
  fi
  [[ "$(wc -l <"$cleanup_map" | tr -d ' ')" == "7" ]] ||
    fail "cleanup PVC/PV journal must contain seven entries"

  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _database source_pod _deployment service pvc <<<"$mapping"
    sts="${source_pod%-0}"
    pv="$(awk -F '\t' -v expected="$pvc" '$1 == expected {print $2}' "$cleanup_map")"
    [[ -n "$pv" ]] || fail "cleanup journal is missing PVC: $pvc"
    kubectl delete statefulset "$sts" -n "$NAMESPACE" --wait=true --ignore-not-found
    kubectl delete service "$service" -n "$NAMESPACE" --ignore-not-found
    kubectl delete pvc "$pvc" -n "$NAMESPACE" --wait=true --ignore-not-found
    for attempt in {1..120}; do
      if ! kubectl get pv "$pv" >/dev/null 2>&1; then
        break
      fi
      sleep 5
    done
    if kubectl get pv "$pv" >/dev/null 2>&1; then
      fail "PV was not reclaimed after deleting PVC: $pvc"
    fi
  done
}

apply_legacy_manifests() {
  local manifest
  while IFS= read -r manifest; do
    kubectl apply -n "$NAMESPACE" -f "$manifest" >/dev/null
  done < <(
    find "$LEGACY_MANIFEST_DIR" -maxdepth 1 -type f -name '*-mongo-depl.yaml' \
      -print | LC_ALL=C sort
  )
  local mapping _database source_pod _deployment _service _pvc sts
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _database source_pod _deployment _service _pvc <<<"$mapping"
    sts="${source_pod%-0}"
    kubectl rollout status statefulset "$sts" -n "$NAMESPACE" --timeout=10m
  done
}

reverse_restore_legacy() {
  local mapping database source_pod _deployment _service _pvc archive
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database source_pod _deployment _service _pvc <<<"$mapping"
    archive="$BACKUP_DIR/$MIGRATION_ID-rollback-$database.archive.gz"
    kubectl exec -n "$NAMESPACE" "$TARGET_POD" -- \
      mongodump --quiet --archive --gzip --db "$database" >"${archive}.partial"
    mv "${archive}.partial" "$archive"
    kubectl exec -n "$NAMESPACE" "$source_pod" -- mongosh --quiet --eval \
      "db.getSiblingDB(\"$database\").dropDatabase()" >/dev/null
    kubectl exec -i -n "$NAMESPACE" "$source_pod" -- \
      mongorestore --quiet --archive --gzip --drop --nsInclude="${database}.*" <"$archive"
    database_signature "$TARGET_POD" "$database" |
      cmp -s <(database_signature "$source_pod" "$database") - ||
      fail "reverse-restore parity failed for $database"
  done
}

print_plan() {
  echo "target_statefulset=$TARGET_STS"
  echo "target_pvc=$TARGET_PVC"
  echo "shared_service=$SHARED_SERVICE"
  echo "database_count=8"
  local mapping database source_pod deployment service pvc
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r database source_pod deployment service pvc <<<"$mapping"
    echo "migrate=$database source_pod=$source_pod deployment=$deployment"
    echo "retire_statefulset=${source_pod%-0} retire_service=$service retire_pvc=$pvc"
  done
}

case "$OPERATION" in
  plan)
    validate_repository_contract
    print_plan
    ;;
  preflight)
    for command_name in kubectl python3 awk find cmp; do
      require_command "$command_name"
    done
    validate_identifiers
    validate_exact_checkout
    validate_repository_contract
    prepare_backup_dir
    verify_legacy_runtime
    verify_legacy_applications
    echo "shared_mongo_operation=preflight status=PASS databases=8"
    ;;
  migrate)
    for command_name in kubectl python3 awk find cmp; do
      require_command "$command_name"
    done
    validate_identifiers
    validate_exact_checkout
    validate_repository_contract
    prepare_backup_dir
    require_value CONFIRM_MAINTENANCE "${CONFIRM_MAINTENANCE:-}" "writers-paused"
    require_value CONFIRM_RECOVERY_COPIES "${CONFIRM_RECOVERY_COPIES:-}" "verified-eight-recovery-copies"
    acquire_lock
    validate_migrate_journal
    verify_legacy_runtime
    verify_legacy_applications
    verify_queue_drain
    set_journal transition backing-up false
    scale_applications 0
    write_backups
    verify_backups
    set_journal transition preparing-target false
    prepare_target
    set_journal transition restoring false
    restore_shared_databases
    set_journal transition switching false
    set_shared_uris
    set_journal transition validating-applications false
    scale_applications 1
    verify_shared_database_presence
    verify_shared_applications
    set_journal transition awaiting-cleanup false
    echo "shared_mongo_operation=migrate status=PASS next=cleanup"
    ;;
  cleanup)
    for command_name in kubectl python3 awk find cmp; do
      require_command "$command_name"
    done
    validate_identifiers
    validate_exact_checkout
    validate_repository_contract
    prepare_backup_dir
    require_value CONFIRM_APPLICATION_VALIDATED \
      "${CONFIRM_APPLICATION_VALIDATED:-}" "shared-mongo-application-validation-passed"
    require_value CONFIRM_DELETE_LEGACY_MONGO \
      "${CONFIRM_DELETE_LEGACY_MONGO:-}" "delete-seven-legacy-mongo-volumes"
    acquire_lock
    require_journal transition awaiting-cleanup
    verify_backups
    verify_shared_database_presence
    verify_shared_applications
    delete_legacy_resources
    set_journal shared complete true
    NAMESPACE="$NAMESPACE" TOPOLOGY_CONFIGMAP="$TOPOLOGY_CONFIGMAP" \
      "$ROOT_DIR/infra/azure/agents/shared-mongo-topology-guard-stan.sh"
    echo "shared_mongo_operation=cleanup status=PASS retired_databases=7"
    ;;
  rollback)
    for command_name in kubectl python3 awk find cmp; do
      require_command "$command_name"
    done
    validate_identifiers
    validate_exact_checkout
    validate_repository_contract
    prepare_backup_dir
    require_value CONFIRM_ROLLBACK \
      "${CONFIRM_ROLLBACK:-}" "restore-seven-legacy-databases"
    acquire_lock
    current_journal="$(journal_state)"
    reverse_copy=false
    case "$current_journal" in
      "transition|backing-up|$MIGRATION_ID|$APPROVED_SHA" | \
      "transition|preparing-target|$MIGRATION_ID|$APPROVED_SHA" | \
      "transition|restoring|$MIGRATION_ID|$APPROVED_SHA" | \
      "transition|switching|$MIGRATION_ID|$APPROVED_SHA")
        reverse_copy=false
        ;;
      "transition|validating-applications|$MIGRATION_ID|$APPROVED_SHA" | \
      "transition|awaiting-cleanup|$MIGRATION_ID|$APPROVED_SHA" | \
      "shared|complete|$MIGRATION_ID|$APPROVED_SHA" | \
      "transition|rollback-copying|$MIGRATION_ID|$APPROVED_SHA")
        reverse_copy=true
        ;;
      "transition|rollback-data-restored|$MIGRATION_ID|$APPROVED_SHA")
        reverse_copy=false
        ;;
      *)
        fail "migration journal phase is not safe for rollback"
        ;;
    esac
    scale_applications 0
    apply_legacy_manifests
    if [[ "$reverse_copy" == true ]]; then
      verify_shared_uris
      verify_shared_database_presence
      set_journal transition rollback-copying false
      reverse_restore_legacy
    fi
    set_journal transition rollback-data-restored false
    set_legacy_uris
    scale_applications 1
    set_journal legacy rollback-complete true
    echo "shared_mongo_operation=rollback status=PASS restored_databases=7"
    ;;
  unlock)
    require_command kubectl
    require_command python3
    validate_identifiers
    validate_exact_checkout
    require_value CONFIRM_UNLOCK \
      "${CONFIRM_UNLOCK:-}" "remove-stale-migration-lock"
    remove_stale_lock
    echo "shared_mongo_operation=unlock status=PASS"
    ;;
  *)
    echo "usage: $0 {plan|preflight|migrate|cleanup|rollback|unlock}" >&2
    exit 2
    ;;
esac
