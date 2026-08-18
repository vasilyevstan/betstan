#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=migration-common.sh
source "$SCRIPT_DIR/migration-common.sh"

MODE="${1:-replace}"
SOURCE_SHA="${SOURCE_SHA:-}"
REPLACE_OCI_DATA="${REPLACE_OCI_DATA:-false}"
AZURE_KUBECONFIG="${AZURE_KUBECONFIG:-}"
OCI_KUBECONFIG="${OCI_KUBECONFIG:-}"
AZURE_NAMESPACE="${AZURE_NAMESPACE:-default}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_RABBITMQ_BASELINE_FILE="${OCI_RABBITMQ_BASELINE_FILE:-}"
RUNNER_TEMP="${RUNNER_TEMP:-}"
WORK_DIR="${WORK_DIR:-${RUNNER_TEMP:+$RUNNER_TEMP/oci-migration-transport}}"
JOURNAL_FILE="${JOURNAL_FILE:-$OCI_ROOT_DIR/artifacts/oci-migration/journal.tsv}"
SUMMARY_FILE="${SUMMARY_FILE:-$OCI_ROOT_DIR/artifacts/oci-migration/phase.env}"
MIGRATION_ID="${MIGRATION_ID:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}}"
OWNER_RUN_ID="${GITHUB_RUN_ID:-local}"
OWNER_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
REPOSITORY="${GITHUB_REPOSITORY:-}"
AZURE_CLUSTER_FINGERPRINT="${AZURE_ACTUAL_CLUSTER_RESOURCE_ID_SHA256:-}"
AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256="${AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256:-}"
OCI_CLUSTER_FINGERPRINT="${OCI_EXPECTED_CLUSTER_FINGERPRINT:-}"
AZURE_EXPECTED_CLUSTER_SERVER_SHA256="${AZURE_EXPECTED_CLUSTER_SERVER_SHA256:-}"
OCI_EXPECTED_CLUSTER_OCID="${OCI_EXPECTED_CLUSTER_OCID:-}"
OCI_RUNTIME_MODE="$(oci_runtime_mode)"
OCI_K3S_NODE_NAME="${OCI_K3S_NODE_NAME:-betstan-k3s}"
STATE_CONFIGMAP="${MIGRATION_STATE_CONFIGMAP:-betstan-oci-migration-journal}"
LOCK_CONFIGMAP="${MIGRATION_LOCK_CONFIGMAP:-betstan-oci-migration-lock}"
COMMAND_TIMEOUT_SECONDS="${MIGRATION_COMMAND_TIMEOUT_SECONDS:-120}"
STREAM_TIMEOUT_SECONDS="${MIGRATION_STREAM_TIMEOUT_SECONDS:-900}"
MONGO_VALIDATION_TIMEOUT_SECONDS="${MIGRATION_MONGO_VALIDATION_TIMEOUT_SECONDS:-600}"
QUEUE_DRAIN_ATTEMPTS="${QUEUE_DRAIN_ATTEMPTS:-30}"
QUEUE_DRAIN_SLEEP_SECONDS="${QUEUE_DRAIN_SLEEP_SECONDS:-10}"
RUNNER_CAPACITY_MULTIPLIER="${RUNNER_CAPACITY_MULTIPLIER:-2}"
RUNNER_CAPACITY_RESERVE_BYTES="${RUNNER_CAPACITY_RESERVE_BYTES:-2147483648}"
SIGNATURE_SCRIPT="$SCRIPT_DIR/mongo-canonical-signature.js"
STATE_HELPER="$SCRIPT_DIR/migration-state.py"
MONGO_REVIEWED_VERSION=8.2.12
MONGO_REVIEWED_FCV=8.2
MONGO_REVIEWED_INDEX_DIGEST=sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3
MONGO_REVIEWED_AMD64_MANIFEST=sha256:41afd6e1183f57e4e4d03ab733070671fca8553da2b36f15d6e3fc9760494d17
MONGO_REVIEWED_ARM64_MANIFEST=sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4
MONGO_REVIEWED_TARGET_IMAGE="docker.io/library/mongo@$MONGO_REVIEWED_INDEX_DIGEST"
INGRESS_CONTROLLER_NAMESPACE="ingress-nginx"
INGRESS_CONTROLLER_CONFIGMAP="ingress-nginx-controller"
INGRESS_BASE_SERVER_SNIPPET="if (\$host = \"www.betstan.xyz\") {
  return 308 https://betstan.xyz\$request_uri;
}"
INGRESS_HTTP_WRITE_FENCE_DIRECTIVE="if (\$request_method !~ ^(GET|HEAD|OPTIONS)\$) {
  return 503;
}"
INGRESS_FENCED_SERVER_SNIPPET="${INGRESS_BASE_SERVER_SNIPPET}"$'\n'"${INGRESS_HTTP_WRITE_FENCE_DIRECTIVE}"

APP_SERVICES=(auth bet backoffice event gamemaster moderation resulting slip client)
BACKEND_SERVICES=(auth bet backoffice event gamemaster moderation resulting slip)
DATABASE_MAPPINGS=(
  "auth|gaming_auth|gaming-auth-mongo-depl|gaming-auth-mongo-depl-0|gaming-auth-mongo-data-gaming-auth-mongo-depl-0"
  "bet|gaming_bet|gaming-bet-mongo-depl|gaming-bet-mongo-depl-0|gaming-bet-mongo-data-gaming-bet-mongo-depl-0"
  "backoffice|gaming_backoffice|gaming-backoffice-mongo-depl|gaming-backoffice-mongo-depl-0|gaming-backoffice-mongo-data-gaming-backoffice-mongo-depl-0"
  "event|gaming_event|gaming-event-mongo-depl|gaming-event-mongo-depl-0|gaming-event-mongo-data-gaming-event-mongo-depl-0"
  "gamemaster|gaming_gamemaster|gaming-gamemaster-mongo-depl|gaming-gamemaster-mongo-depl-0|gaming-gamemaster-mongo-data-gaming-gamemaster-mongo-depl-0"
  "moderation|gaming_moderation|gaming-moderation-mongo-depl|gaming-moderation-mongo-depl-0|gaming-moderation-mongo-data-gaming-moderation-mongo-depl-0"
  "resulting|gaming_resulting|gaming-resulting-mongo-depl|gaming-resulting-mongo-depl-0|gaming-resulting-mongo-data-gaming-resulting-mongo-depl-0"
  "slip|gaming_slip|gaming-slip-mongo-depl|gaming-slip-mongo-depl-0|gaming-slip-mongo-data-gaming-slip-mongo-depl-0"
)

state_initialized=0
state_boundary=0
state_recovery=0
fencing_token=""
operation_success=0
oci_frozen=0
disposable_container=""
disposable_volume=""
cleanup_running=0
transport_dir=""
signature_dir=""
state_dir=""
identity_file=""
azure_baseline=""
oci_baseline=""
target_mongo_pod=""
target_mongo_image=""
target_mongo_uid=""
target_mongo_image_id=""
target_mongo_container_id=""
target_mongo_restart_count=""
target_runtime_signature=""
source_mongo_manifest=""
last_committed_phase=""

state_boundary_text() {
  [[ "$state_boundary" == "1" ]] && printf true || printf false
}

state_recovery_text() {
  [[ "$state_recovery" == "1" ]] && printf true || printf false
}

simulate() {
  local output="${MIGRATION_SIMULATION_OUTPUT:?MIGRATION_SIMULATION_OUTPUT is required}"
  local fail_at="${MIGRATION_FAIL_AT:-}"
  local partial="${MIGRATION_SIMULATE_PARTIAL_RETRY:-0}"
  local boundary=false
  local recovery=false
  local oci_state=baseline
  local point database service
  local points=(
    azure-start azure-provisioning azure-freeze source-queue-drain runner-capacity
    archive-capture corrupt-archive disposable-validation cancellation hang
    target-queue-drain oci-freeze http-write-fence-install
  )
  mkdir -p "$(dirname "$output")"
  for point in "${points[@]}"; do
    if [[ "$fail_at" == "$point" ]]; then
      printf '%s\n' \
        "result=failed" \
        "failure_point=$point" \
        "destructive_boundary=$boundary" \
        "recovery_required=$recovery" \
        "oci_state=$oci_state" \
        "http_write_fence=false" \
        "azure_apps=frozen" \
        "azure_stopped=true" >"$output"
      return 97
    fi
  done
  if [[ "$fail_at" == "http-write-fence-installed-crash" ]]; then
    printf '%s\n' \
      "result=failed" \
      "failure_point=$fail_at" \
      "destructive_boundary=false" \
      "recovery_required=false" \
      "oci_state=closed" \
      "http_write_fence=true" \
      "azure_apps=frozen" \
      "azure_stopped=true" >"$output"
    return 97
  fi
  boundary=true
  oci_state=closed
  for point in post-boundary-cancellation post-boundary-hang; do
    if [[ "$fail_at" == "$point" ]]; then
      recovery=true
      printf '%s\n' \
        "result=failed" \
        "failure_point=$point" \
        "destructive_boundary=$boundary" \
        "recovery_required=$recovery" \
        "oci_state=$oci_state" \
        "http_write_fence=true" \
        "azure_apps=frozen" \
        "azure_stopped=true" >"$output"
      return 97
    fi
  done
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r service database _sts _pod _pvc <<<"$mapping"
    for point in "before-drop-$database" "after-drop-$database" \
      "before-restore-$database" "after-restore-$database"; do
      if [[ "$fail_at" == "$point" ]]; then
        recovery=true
        printf '%s\n' \
          "result=failed" \
          "failure_point=$point" \
          "destructive_boundary=$boundary" \
          "recovery_required=$recovery" \
          "oci_state=$oci_state" \
          "http_write_fence=true" \
          "azure_apps=frozen" \
          "azure_stopped=true" >"$output"
        return 97
      fi
    done
  done
  for point in \
    rabbitmq-recreate restart-auth restart-client mongo-write-lock \
    rabbitmq-write-lock http-write-fence-runtime \
    mongo-restart-during-public-health protected-health public-health; do
    if [[ "$fail_at" == "$point" ]]; then
      recovery=true
      printf '%s\n' \
        "result=failed" \
        "failure_point=$point" \
        "destructive_boundary=$boundary" \
        "recovery_required=$recovery" \
        "oci_state=closed" \
        "http_write_fence=true" \
        "azure_apps=frozen" \
        "azure_stopped=true" >"$output"
      return 97
    fi
  done
  case "$fail_at" in
    cutover-committed)
      printf '%s\n' \
        "result=failed" \
        "failure_point=$fail_at" \
        "destructive_boundary=true" \
        "recovery_required=false" \
        "oci_state=committed-locked" \
        "http_write_fence=true" \
        "azure_apps=frozen" \
        "azure_stopped=true" >"$output"
      return 97
      ;;
    mongo-write-unlocked)
      printf '%s\n' \
        "result=failed" \
        "failure_point=$fail_at" \
        "destructive_boundary=true" \
        "recovery_required=false" \
        "oci_state=committed-mongo-writable" \
        "http_write_fence=true" \
        "azure_apps=frozen" \
        "azure_stopped=true" >"$output"
      return 97
      ;;
    rabbitmq-write-unlocked)
      printf '%s\n' \
        "result=failed" \
        "failure_point=$fail_at" \
        "destructive_boundary=true" \
        "recovery_required=false" \
        "oci_state=committed-writable" \
        "http_write_fence=true" \
        "azure_apps=frozen" \
        "azure_stopped=true" >"$output"
      return 97
      ;;
    http-write-fence-removed)
      printf '%s\n' \
        "result=failed" \
        "failure_point=$fail_at" \
        "destructive_boundary=true" \
        "recovery_required=false" \
        "oci_state=committed-writable" \
        "http_write_fence=false" \
        "azure_apps=frozen" \
        "azure_stopped=true" >"$output"
      return 97
      ;;
    retry-after-cutover)
      printf '%s\n' \
        "result=forbidden" \
        "failure_point=$fail_at" \
        "destructive_boundary=true" \
        "recovery_required=false" \
        "oci_state=forward-only" \
        "http_write_fence=true" \
        "azure_apps=frozen" \
        "azure_stopped=true" >"$output"
      return 98
      ;;
  esac
  printf '%s\n' \
    "result=success" \
    "partial_retry=$partial" \
    "destructive_boundary=true" \
    "recovery_required=false" \
    "oci_state=healthy" \
    "http_write_fence=false" \
    "exact_database_count=8" \
    "azure_apps=frozen" \
    "azure_stopped=true" >"$output"
}

if [[ "${MIGRATION_SIMULATION:-0}" == "1" ]]; then
  simulate
  exit $?
fi

provider_namespace() {
  if [[ "$1" == "azure" ]]; then
    printf '%s' "$AZURE_NAMESPACE"
  else
    printf '%s' "$OCI_K8S_NAMESPACE"
  fi
}

provider_kubeconfig() {
  if [[ "$1" == "azure" ]]; then
    printf '%s' "$AZURE_KUBECONFIG"
  else
    printf '%s' "$OCI_KUBECONFIG"
  fi
}

kube_raw() {
  local provider="$1"
  local classification="$2"
  local timeout_seconds="$3"
  local attempts="$4"
  shift 4
  migration_raw "$classification" "$timeout_seconds" "$attempts" \
    kubectl --kubeconfig "$(provider_kubeconfig "$provider")" "$@"
}

kube_run() {
  local provider="$1"
  local classification="$2"
  local timeout_seconds="$3"
  local attempts="$4"
  shift 4
  migration_run "$classification" "$timeout_seconds" "$attempts" \
    kubectl --kubeconfig "$(provider_kubeconfig "$provider")" "$@"
}

kube_capture() {
  local provider="$1"
  local classification="$2"
  local timeout_seconds="$3"
  local attempts="$4"
  shift 4
  migration_maybe_heartbeat
  migration_raw "$classification" "$timeout_seconds" "$attempts" \
    kubectl --kubeconfig "$(provider_kubeconfig "$provider")" "$@"
  local status=$?
  migration_maybe_heartbeat
  return "$status"
}

state_file() {
  printf '%s/%s-%s.json' "$state_dir" "$1" "$2"
}

state_fetch_cm() {
  local provider="$1"
  local kind="$2"
  local name file error_file error
  if [[ "$kind" == "journal" ]]; then
    name="$STATE_CONFIGMAP"
  else
    name="$LOCK_CONFIGMAP"
  fi
  file="$(state_file "$provider" "$kind")"
  error_file="${file}.error"
  if kube_raw "$provider" state-read 30 2 \
      get configmap "$name" -n "$(provider_namespace "$provider")" -o json \
      >"$file" 2>"$error_file"; then
    rm -f "$error_file"
    printf 'present'
    return 0
  fi
  error="$(cat "$error_file")"
  rm -f "$file" "$error_file"
  if [[ "$error" == *NotFound* || "$error" == *"not found"* ]]; then
    printf 'missing'
    return 0
  fi
  migration_die "unable to read $provider migration $kind"
}

state_compare_kind() {
  migration_raw state-compare 30 1 python3 "$STATE_HELPER" compare \
    "$(state_file azure "$1")" "$(state_file oci "$1")"
}

state_reconcile_kind() {
  local kind="$1"
  if state_compare_kind "$kind" >/dev/null 2>&1; then
    return 0
  fi
  migration_raw state-reconcile 30 1 \
    python3 "$STATE_HELPER" reconcile \
      --kind "$kind" \
      "$(state_file azure "$kind")" \
      "$(state_file oci "$kind")" |
    kube_raw oci state-reconcile 30 1 replace -f - >/dev/null
  local statuses=("${PIPESTATUS[@]}")
  [[ "${statuses[0]}" == "0" && "${statuses[1]}" == "0" ]] ||
    migration_die "unsafe or failed $kind mirror reconciliation"
  [[ "$(state_fetch_cm oci "$kind")" == "present" ]] ||
    migration_die "reconciled OCI $kind disappeared"
  state_compare_kind "$kind"
}

state_value() {
  migration_raw state-value 30 1 python3 "$STATE_HELPER" value \
    "$(state_file azure journal)" "$1"
}

state_lock_value() {
  migration_raw state-value 30 1 python3 "$STATE_HELPER" value \
    "$(state_file azure lock)" "$1"
}

state_optional_value() {
  migration_raw state-value 30 1 jq -r \
    --arg key "$1" '.data[$key] // empty' "$(state_file azure journal)"
}

state_active_source_sha() {
  local active_source
  active_source="$(state_optional_value active-source-sha)"
  if [[ -z "$active_source" ]]; then
    active_source="$(state_value original-source-sha)"
  fi
  [[ "$active_source" =~ ^[0-9a-f]{40}$ ]] ||
    migration_die "active migration source SHA is invalid"
  printf '%s' "$active_source"
}

state_monotonic_epoch() {
  local previous="$1"
  local now
  now="$(migration_epoch)"
  [[ "$previous" =~ ^[0-9]+$ ]] ||
    migration_die "journal heartbeat is invalid"
  if (( now <= previous )); then
    now=$((previous + 1))
  fi
  printf '%s' "$now"
}

state_create_one() {
  local provider="$1"
  local kind="$2"
  shift 2
  local name namespace arguments=() value
  if [[ "$kind" == "journal" ]]; then
    name="$STATE_CONFIGMAP"
  else
    name="$LOCK_CONFIGMAP"
  fi
  namespace="$(provider_namespace "$provider")"
  for value in "$@"; do
    arguments+=(--set "$value")
  done
  migration_raw state-document 30 1 \
    python3 "$STATE_HELPER" create \
      --name "$name" --namespace "$namespace" "${arguments[@]}" |
    kube_raw "$provider" state-create 30 1 create -f -
  local statuses=("${PIPESTATUS[@]}")
  [[ "${statuses[0]}" == "0" && "${statuses[1]}" == "0" ]]
}

state_replace_one() {
  local provider="$1"
  local kind="$2"
  shift 2
  local file arguments=() item
  file="$(state_file "$provider" "$kind")"
  for item in "$@"; do
    arguments+=("$item")
  done
  migration_raw state-document 30 1 \
    python3 "$STATE_HELPER" mutate "$file" "${arguments[@]}" |
    kube_raw "$provider" state-cas 30 1 replace -f -
  local statuses=("${PIPESTATUS[@]}")
  [[ "${statuses[0]}" == "0" && "${statuses[1]}" == "0" ]]
}

state_checkpoint_one() {
  local provider="$1"
  local kind="$2"
  local checkpoint="$3"
  migration_raw state-checkpoint 30 1 \
    cp "$(state_file "$provider" "$kind")" "$checkpoint"
}

state_restore_one() {
  local provider="$1"
  local kind="$2"
  local checkpoint="$3"
  shift 3
  local current status arguments=() item
  status="$(state_fetch_cm "$provider" "$kind")"
  [[ "$status" == "present" ]] || return 1
  current="$(state_file "$provider" "$kind")"
  if migration_raw state-compare 30 1 \
      python3 "$STATE_HELPER" compare "$checkpoint" "$current" \
      >/dev/null 2>&1; then
    return 0
  fi
  for item in "$@"; do
    arguments+=(--expect-target "$item")
  done
  migration_raw state-document 30 1 \
    python3 "$STATE_HELPER" mirror "$checkpoint" "$current" "${arguments[@]}" |
    kube_raw "$provider" state-cas-rollback 30 1 replace -f -
  local statuses=("${PIPESTATUS[@]}")
  [[ "${statuses[0]}" == "0" && "${statuses[1]}" == "0" ]]
}

state_read_all() {
  local azure_journal oci_journal azure_lock oci_lock
  azure_journal="$(state_fetch_cm azure journal)"
  oci_journal="$(state_fetch_cm oci journal)"
  azure_lock="$(state_fetch_cm azure lock)"
  oci_lock="$(state_fetch_cm oci lock)"
  printf '%s|%s|%s|%s' \
    "$azure_journal" "$oci_journal" "$azure_lock" "$oci_lock"
}

state_validate_contract() {
  local active_source
  active_source="$(state_active_source_sha)"
  [[ "$(state_value schema-version)" == "1" &&
    "$(state_lock_value schema-version)" == "1" &&
    "$(state_value owner-workflow)" == ".github/workflows/oci-migrate.yml" &&
    "$active_source" =~ ^[0-9a-f]{40}$ &&
    "$(state_value journal-id)" == "$(state_lock_value journal-id)" &&
    "$(state_value migration-id)" == "$(state_lock_value migration-id)" &&
    "$(state_value owner-run-id)" == "$(state_lock_value owner-run-id)" &&
    "$(state_value owner-run-attempt)" == "$(state_lock_value owner-run-attempt)" &&
    "$(state_value fencing-token)" == "$(state_lock_value fencing-token)" ]] ||
    migration_die "journal and lock identity contract differs"
}

state_reconcile_existing() {
  state_reconcile_kind journal
  state_reconcile_kind lock
  state_read_all >/dev/null

  local journal_phase journal_fence journal_migration journal_owner journal_attempt
  local lock_fence lock_migration lock_owner lock_attempt lock_state provider
  journal_phase="$(state_value phase)"
  journal_fence="$(state_value fencing-token)"
  journal_migration="$(state_value migration-id)"
  journal_owner="$(state_value owner-run-id)"
  journal_attempt="$(state_value owner-run-attempt)"
  lock_fence="$(state_lock_value fencing-token)"
  lock_migration="$(state_lock_value migration-id)"
  lock_owner="$(state_lock_value owner-run-id)"
  lock_attempt="$(state_lock_value owner-run-attempt)"
  lock_state="$(state_lock_value state)"

  if [[ "$journal_phase" == "lock-taken-over" &&
    "$journal_fence" =~ ^[1-9][0-9]*$ &&
    "$lock_fence" =~ ^[1-9][0-9]*$ &&
    "$journal_fence" -eq $((lock_fence + 1)) ]]; then
    state_compare_kind lock
    for provider in azure oci; do
      state_replace_one "$provider" lock \
        --expect "migration-id=$lock_migration" \
        --expect "owner-run-id=$lock_owner" \
        --expect "owner-run-attempt=$lock_attempt" \
        --expect "fencing-token=$lock_fence" \
        --expect "state=$lock_state" \
        --set "migration-id=$journal_migration" \
        --set "owner-run-id=$journal_owner" \
        --set "owner-run-attempt=$journal_attempt" \
        --set "fencing-token=$journal_fence" \
        --set "state=active" >/dev/null ||
        migration_die "interrupted takeover lock could not be completed"
    done
  fi

  state_read_all >/dev/null
  state_reconcile_kind lock
  state_read_all >/dev/null
  state_compare_kind journal
  state_compare_kind lock
  state_validate_contract
}

state_recover_partial_creation() {
  local presence="$1"
  local file kind provider first_file=""
  local old_migration old_owner old_attempt old_fence old_journal expected_journal
  local document_source document_azure document_oci document_sequence
  local document_phase document_boundary document_recovery
  for provider in azure oci; do
    for kind in journal lock; do
      file="$(state_file "$provider" "$kind")"
      if [[ -f "$file" ]]; then
        first_file="$file"
        break 2
      fi
    done
  done
  [[ -n "$first_file" ]] ||
    migration_die "partial migration state has no readable document"
  old_migration="$(migration_raw state-value 30 1 \
    python3 "$STATE_HELPER" value "$first_file" migration-id)"
  old_owner="$(migration_raw state-value 30 1 \
    python3 "$STATE_HELPER" value "$first_file" owner-run-id)"
  old_attempt="$(migration_raw state-value 30 1 \
    python3 "$STATE_HELPER" value "$first_file" owner-run-attempt)"
  old_fence="$(migration_raw state-value 30 1 \
    python3 "$STATE_HELPER" value "$first_file" fencing-token)"
  old_journal="$(migration_raw state-value 30 1 \
    python3 "$STATE_HELPER" value "$first_file" journal-id)"
  migration_safe_id "$old_migration" &&
    migration_is_positive_int "$old_owner" &&
    migration_is_positive_int "$old_attempt" &&
    [[ "$old_fence" == "1" ]] ||
    migration_die "partial initial state identity is invalid"
  expected_journal="$(
    printf '%s|%s|%s|%s' \
      "$SOURCE_SHA" "$AZURE_CLUSTER_FINGERPRINT" \
      "$OCI_CLUSTER_FINGERPRINT" "$old_migration" |
      migration_sha256
  )"
  [[ "$old_journal" == "$expected_journal" ]] ||
    migration_die "partial initial journal ID differs"
  [[ "$old_owner" != "$OWNER_RUN_ID" ]] ||
    migration_die "current run cannot repair its own partial state"
  owner_run_is_conclusively_inactive "$old_owner" "$old_attempt" ||
    migration_die "partial initial state owner is not conclusively inactive"

  for provider in azure oci; do
    for kind in journal lock; do
      file="$(state_file "$provider" "$kind")"
      [[ -f "$file" ]] || continue
      [[ "$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" schema-version)" == "1" &&
        "$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" journal-id)" == "$old_journal" &&
        "$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" migration-id)" == "$old_migration" &&
        "$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" owner-run-id)" == "$old_owner" &&
        "$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" owner-run-attempt)" == "$old_attempt" &&
        "$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" fencing-token)" == "1" ]] ||
        migration_die "partial initial state documents disagree"
      if [[ "$kind" == "journal" ]]; then
        document_source="$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" original-source-sha)"
        document_azure="$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" azure-cluster-fingerprint)"
        document_oci="$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" oci-cluster-fingerprint)"
        document_sequence="$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" sequence)"
        document_phase="$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" phase)"
        document_boundary="$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" destructive-boundary)"
        document_recovery="$(migration_raw state-value 30 1 \
          python3 "$STATE_HELPER" value "$file" recovery-required)"
        [[ "$document_source" == "$SOURCE_SHA" &&
          "$document_azure" == "$AZURE_CLUSTER_FINGERPRINT" &&
          "$document_oci" == "$OCI_CLUSTER_FINGERPRINT" &&
          "$document_sequence" == "0" &&
          "$document_phase" == "initialized" &&
          "$document_boundary" == "false" &&
          "$document_recovery" == "false" ]] ||
          migration_die "partial journal is beyond safe initial creation"
      else
        [[ "$(migration_raw state-value 30 1 \
            python3 "$STATE_HELPER" value "$file" state)" == "active" ]] ||
          migration_die "partial lock is not an initial active lock"
      fi
    done
  done

  for provider in azure oci; do
    kube_raw "$provider" state-create-recovery 30 2 \
      delete configmap "$STATE_CONFIGMAP" "$LOCK_CONFIGMAP" \
      -n "$(provider_namespace "$provider")" --ignore-not-found >/dev/null
  done
  [[ "$(state_read_all)" == "missing|missing|missing|missing" ]] ||
    migration_die "partial initial state cleanup did not converge"
  migration_log "partial_initial_state_recovered=$presence"
}

owner_run_is_conclusively_inactive() {
  local run_id="$1"
  local attempt="$2"
  local expected_source_sha="${3:-}"
  local document status
  if [[ -n "${MIGRATION_OWNER_RUN_FIXTURE:-}" ]]; then
    document="$(cat "$MIGRATION_OWNER_RUN_FIXTURE")"
  else
    [[ "$REPOSITORY" == */* ]] ||
      migration_die "GITHUB_REPOSITORY is required for stale-lock inspection"
    document="$(
      migration_raw github-run-read 45 2 \
        gh api "repos/$REPOSITORY/actions/runs/$run_id/attempts/$attempt"
    )" || migration_die "owner run state is unknown; stale lock is retained"
  fi
  migration_raw github-run-identity 30 1 jq -e \
    --argjson id "$run_id" \
    --argjson attempt "$attempt" \
    --arg source_sha "$expected_source_sha" \
    --arg repository "$REPOSITORY" '
      .id == $id and
      .run_attempt == $attempt and
      .path == ".github/workflows/oci-migrate.yml" and
      .head_branch == "master" and
      ($source_sha == "" or .head_sha == $source_sha) and
      (.head_repository.full_name == $repository or $repository == "")
    ' <<<"$document" >/dev/null ||
    migration_die "stale lock owner does not identify the exact migration workflow"
  status="$(migration_raw github-run-status 30 1 jq -r '.status' <<<"$document")"
  case "$status" in
    completed)
      return 0
      ;;
    queued | in_progress | waiting | pending | requested)
      return 1
      ;;
    *)
      migration_die "stale lock owner has an unknown run state: $status"
      ;;
  esac
}

state_new_documents() {
  local journal_id="$1"
  local fence="$2"
  local now="$3"
  local azure_hash oci_hash
  azure_hash="$(printf '%s' "$azure_baseline" | migration_sha256)"
  oci_hash="$(printf '%s' "$oci_baseline" | migration_sha256)"
  local journal_values=(
    "schema-version=1"
    "journal-id=$journal_id"
    "original-source-sha=$SOURCE_SHA"
    "active-source-sha=$SOURCE_SHA"
    "migration-id=$MIGRATION_ID"
    "owner-run-id=$OWNER_RUN_ID"
    "owner-run-attempt=$OWNER_RUN_ATTEMPT"
    "owner-workflow=.github/workflows/oci-migrate.yml"
    "fencing-token=$fence"
    "sequence=0"
    "phase=initialized"
    "heartbeat-epoch=$now"
    "destructive-boundary=false"
    "recovery-required=false"
    "azure-cluster-fingerprint=$AZURE_CLUSTER_FINGERPRINT"
    "oci-cluster-fingerprint=$OCI_CLUSTER_FINGERPRINT"
    "azure-baseline=$azure_baseline"
    "azure-baseline-sha256=$azure_hash"
    "oci-baseline=$oci_baseline"
    "oci-baseline-sha256=$oci_hash"
    "signature-manifest-sha256="
    "transfer-manifest-sha256="
    "mongo-write-lock=false"
    "rabbitmq-write-lock=false"
    "http-write-fence=false"
  )
  local lock_values=(
    "schema-version=1"
    "journal-id=$journal_id"
    "migration-id=$MIGRATION_ID"
    "owner-run-id=$OWNER_RUN_ID"
    "owner-run-attempt=$OWNER_RUN_ATTEMPT"
    "fencing-token=$fence"
    "state=active"
  )
  if ! state_create_one azure journal "${journal_values[@]}" ||
      ! state_create_one oci journal "${journal_values[@]}" ||
      ! state_create_one azure lock "${lock_values[@]}" ||
      ! state_create_one oci lock "${lock_values[@]}"; then
    local provider kind name rollback_failed=0
    for provider in azure oci; do
      for kind in journal lock; do
        if [[ "$kind" == "journal" ]]; then
          name="$STATE_CONFIGMAP"
        else
          name="$LOCK_CONFIGMAP"
        fi
        kube_raw "$provider" state-create-rollback 30 2 \
          delete configmap "$name" -n "$(provider_namespace "$provider")" \
          --ignore-not-found >/dev/null || rollback_failed=1
      done
    done
    [[ "$rollback_failed" == "0" ]] ||
      migration_die "mirrored state creation failed and metadata rollback was incomplete"
    migration_die "unable to create both mirrored journal and lock ConfigMaps"
  fi
}

state_takeover() {
  local preserve_recovery="$1"
  local old_migration old_run old_attempt old_source
  local old_fence old_sequence old_heartbeat
  local journal_id now
  old_migration="$(state_value migration-id)"
  old_run="$(state_value owner-run-id)"
  old_attempt="$(state_value owner-run-attempt)"
  old_source="$(state_active_source_sha)"
  old_fence="$(state_value fencing-token)"
  old_sequence="$(state_value sequence)"
  old_heartbeat="$(state_value heartbeat-epoch)"
  journal_id="$(state_value journal-id)"
  [[ "$old_fence" =~ ^[1-9][0-9]*$ &&
    "$old_sequence" =~ ^[0-9]+$ ]] ||
    migration_die "existing journal fencing or sequence is invalid"
  now="$(state_monotonic_epoch "$old_heartbeat")"
  fencing_token=$((old_fence + 1))

  owner_run_is_conclusively_inactive \
    "$old_run" "$old_attempt" "$old_source" ||
    migration_die "migration lock owner is active; takeover is forbidden"
  case "$(state_lock_value state)" in
    active | released)
      ;;
    *)
      migration_die "migration lock state is invalid"
      ;;
  esac

  local provider transaction_failed=0 rollback_failed=0
  for provider in azure oci; do
    state_checkpoint_one "$provider" journal \
      "$state_dir/takeover-${provider}-journal.json"
    state_checkpoint_one "$provider" lock \
      "$state_dir/takeover-${provider}-lock.json"
  done
  for provider in azure oci; do
    state_replace_one "$provider" journal \
      --expect "migration-id=$old_migration" \
      --expect "owner-run-id=$old_run" \
      --expect "owner-run-attempt=$old_attempt" \
      --expect "fencing-token=$old_fence" \
      --expect "sequence=$old_sequence" \
      --set "active-source-sha=$SOURCE_SHA" \
      --set "migration-id=$MIGRATION_ID" \
      --set "owner-run-id=$OWNER_RUN_ID" \
      --set "owner-run-attempt=$OWNER_RUN_ATTEMPT" \
      --set "fencing-token=$fencing_token" \
      --set "sequence=$((old_sequence + 1))" \
      --set "phase=lock-taken-over" \
      --set "heartbeat-epoch=$now" || {
        transaction_failed=1
        break
      }
    state_replace_one "$provider" lock \
      --expect "journal-id=$journal_id" \
      --expect "migration-id=$old_migration" \
      --expect "owner-run-id=$old_run" \
      --expect "owner-run-attempt=$old_attempt" \
      --expect "fencing-token=$old_fence" \
      --set "migration-id=$MIGRATION_ID" \
      --set "owner-run-id=$OWNER_RUN_ID" \
      --set "owner-run-attempt=$OWNER_RUN_ATTEMPT" \
      --set "fencing-token=$fencing_token" \
      --set "state=active" || {
        transaction_failed=1
        break
      }
  done
  if [[ "$transaction_failed" == "1" ]]; then
    for provider in azure oci; do
      state_restore_one "$provider" journal \
        "$state_dir/takeover-${provider}-journal.json" \
        "migration-id=$MIGRATION_ID" \
        "owner-run-id=$OWNER_RUN_ID" \
        "owner-run-attempt=$OWNER_RUN_ATTEMPT" \
        "active-source-sha=$SOURCE_SHA" \
        "fencing-token=$fencing_token" \
        "sequence=$((old_sequence + 1))" \
        "phase=lock-taken-over" || rollback_failed=1
      state_restore_one "$provider" lock \
        "$state_dir/takeover-${provider}-lock.json" \
        "migration-id=$MIGRATION_ID" \
        "owner-run-id=$OWNER_RUN_ID" \
        "owner-run-attempt=$OWNER_RUN_ATTEMPT" \
        "fencing-token=$fencing_token" \
        "state=active" || rollback_failed=1
    done
    [[ "$rollback_failed" == "0" ]] ||
      migration_die "stale-lock takeover failed and CAS rollback was incomplete"
    migration_die "stale-lock takeover compare-and-swap failed"
  fi
  state_read_all >/dev/null
  state_compare_kind journal
  state_compare_kind lock
  state_validate_contract
  state_boundary="$(state_value destructive-boundary)"
  state_recovery="$(state_value recovery-required)"
  if [[ "$preserve_recovery" != "true" ]]; then
    state_boundary=0
    state_recovery=0
  fi
}

validate_cross_release_takeover() {
  local existing_source="$1"
  local phase lock_status service stored_oci_baseline
  [[ "$existing_source" != "$SOURCE_SHA" ]] ||
    return 0
  [[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]] ||
    migration_die "cross-release retry checkout differs from SOURCE_SHA"
  git cat-file -e "${existing_source}^{commit}" 2>/dev/null ||
    migration_die "prior active migration SHA is unavailable"
  git merge-base --is-ancestor "$existing_source" "$SOURCE_SHA" ||
    migration_die "cross-release retry is not a descendant of the active journal SHA"
  applications_are_zero azure ||
    migration_die "cross-release retry Azure applications are not frozen"
  wait_deployment_zero azure ingress-nginx ingress-nginx-controller \
    app.kubernetes.io/component=controller
  for service in "${APP_SERVICES[@]}"; do
    wait_deployment_zero azure "$AZURE_NAMESPACE" "gaming-${service}-depl" \
      "app=gaming-${service}"
  done
  verify_frozen_source_queues

  phase="$(state_value phase)"
  case "$phase" in
    failed-before-destructive-boundary)
      [[ "$(state_value destructive-boundary)" == "false" &&
        "$(state_value recovery-required)" == "false" &&
        "$(state_optional_value mongo-write-lock)" == "false" &&
        "$(state_optional_value rabbitmq-write-lock)" == "false" &&
        "$(state_optional_value http-write-fence)" == "false" ]] ||
        migration_die "cross-release retry requires a fully unlocked pre-destructive failure"
      [[ "$oci_baseline" == "$(state_value oci-baseline)" ]] ||
        migration_die "cross-release retry OCI replica baseline differs from the journal"
      [[ "$(target_write_lock_status)" == "false" &&
        "$(rabbitmq_write_permission)" == ".*" &&
        "$(http_write_fence_config_status)" == "false" &&
        "$(http_write_fence_runtime_status)" == "false" ]] ||
        migration_die "cross-release retry found a live OCI write lock or HTTP fence"
      ;;
    recovery-required)
      [[ "$(state_value destructive-boundary)" == "true" &&
        "$(state_value recovery-required)" == "true" &&
        "$(state_lock_value state)" == "active" &&
        "$(state_optional_value http-write-fence)" == "true" ]] ||
        migration_die "cross-release recovery retry requires an active closed post-boundary journal"
      applications_are_zero oci ||
        migration_die "cross-release recovery retry OCI applications are not closed"
      wait_deployment_zero oci ingress-nginx ingress-nginx-controller \
        app.kubernetes.io/component=controller
      wait_deployment_zero oci "$OCI_K8S_NAMESPACE" gaming-rabbitmq-depl \
        app=gaming-rabbitmq
      [[ "$(http_write_fence_config_status)" == "true" ]] ||
        migration_die "cross-release recovery retry lost the OCI HTTP write fence"
      lock_status="$(target_write_lock_status)"
      [[ "$lock_status" == "true" || "$lock_status" == "false" ]] ||
        migration_die "cross-release recovery retry cannot determine the OCI Mongo lock"
      stored_oci_baseline="$(state_value oci-baseline)"
      [[ "$(baseline_value "$stored_oci_baseline" ingress)" =~ ^[1-9][0-9]*$ &&
        "$(baseline_value "$stored_oci_baseline" rabbitmq)" == "1" ]] ||
        migration_die "cross-release recovery retry has an inactive OCI baseline"
      for service in "${APP_SERVICES[@]}"; do
        [[ "$(baseline_value "$stored_oci_baseline" "$service")" =~ ^[1-9][0-9]*$ ]] ||
          migration_die "cross-release recovery retry has an inactive $service baseline"
      done
      ;;
    *)
      migration_die "cross-release retry phase is not safely recoverable"
      ;;
  esac
}

state_acquire() {
  local presence now journal_id lock_state existing_source
  local existing_azure existing_oci
  local existing_phase
  presence="$(state_read_all)"
  now="$(migration_epoch)"
  case "$presence" in
    missing\|missing\|missing\|missing)
      journal_id="$(
        printf '%s|%s|%s|%s' \
          "$SOURCE_SHA" "$AZURE_CLUSTER_FINGERPRINT" \
          "$OCI_CLUSTER_FINGERPRINT" "$MIGRATION_ID" |
          migration_sha256
      )"
      fencing_token=1
      state_new_documents "$journal_id" "$fencing_token" "$now"
      ;;
    present\|present\|present\|present)
      state_reconcile_existing
      existing_phase="$(state_value phase)"
      case "$existing_phase" in
        cutover-committed | completed | cutover-forward-recovery)
          migration_die \
            "OCI cutover is committed; retrying from Azure is permanently forbidden"
          ;;
      esac
      existing_source="$(state_active_source_sha)"
      existing_azure="$(state_value azure-cluster-fingerprint)"
      existing_oci="$(state_value oci-cluster-fingerprint)"
      [[ "$existing_azure" == "$AZURE_CLUSTER_FINGERPRINT" &&
        "$existing_oci" == "$OCI_CLUSTER_FINGERPRINT" ]] ||
        migration_die "live cluster fingerprints differ from the mirrored journal"
      local expected_azure_baseline_hash expected_oci_baseline_hash
      expected_azure_baseline_hash="$(
        printf '%s' "$(state_value azure-baseline)" | migration_sha256
      )"
      expected_oci_baseline_hash="$(
        printf '%s' "$(state_value oci-baseline)" | migration_sha256
      )"
      [[ "$(state_value azure-baseline-sha256)" == "$expected_azure_baseline_hash" ]] ||
        migration_die "Azure baseline hash differs from the mirrored journal"
      [[ "$(state_value oci-baseline-sha256)" == "$expected_oci_baseline_hash" ]] ||
        migration_die "OCI baseline hash differs from the mirrored journal"
      validate_cross_release_takeover "$existing_source"
      lock_state="$(state_lock_value state)"
      if [[ "$(state_value migration-id)" == "$MIGRATION_ID" &&
            "$(state_value owner-run-id)" == "$OWNER_RUN_ID" &&
            "$(state_value owner-run-attempt)" == "$OWNER_RUN_ATTEMPT" &&
            "$lock_state" == "active" ]]; then
        fencing_token="$(state_value fencing-token)"
      else
        state_takeover "$(state_value recovery-required)"
      fi
      azure_baseline="$(state_value azure-baseline)"
      oci_baseline="$(state_value oci-baseline)"
      ;;
    *)
      state_recover_partial_creation "$presence"
      journal_id="$(
        printf '%s|%s|%s|%s' \
          "$SOURCE_SHA" "$AZURE_CLUSTER_FINGERPRINT" \
          "$OCI_CLUSTER_FINGERPRINT" "$MIGRATION_ID" |
          migration_sha256
      )"
      fencing_token=1
      state_new_documents "$journal_id" "$fencing_token" "$now"
      ;;
  esac
  state_initialized=1
  state_read_all >/dev/null
  state_compare_kind journal
  state_compare_kind lock
  state_validate_contract
  [[ "$(state_active_source_sha)" == "$SOURCE_SHA" ]] ||
    migration_die "migration journal is not bound to this active source SHA"
  state_boundary="$(state_value destructive-boundary)"
  state_recovery="$(state_value recovery-required)"
  last_committed_phase="$(state_value phase)"
  [[ "$state_boundary" == "true" ]] && state_boundary=1 || state_boundary=0
  [[ "$state_recovery" == "true" ]] && state_recovery=1 || state_recovery=0
  if [[ "$(state_optional_value http-write-fence)" == "true" ||
        "$(http_write_fence_config_status)" == "true" ]]; then
    oci_frozen=1
  fi
  printf 'timestamp\tsequence\tphase\tfencing_token\tdestructive_boundary\trecovery_required\n' \
    >"$JOURNAL_FILE"
}

state_load_owned() {
  local presence
  presence="$(state_read_all)"
  [[ "$presence" == "present|present|present|present" ]] ||
    migration_die "mirrored migration state is unavailable"
  state_compare_kind journal
  state_compare_kind lock
  state_validate_contract
  [[ "$(state_value migration-id)" == "$MIGRATION_ID" &&
    "$(state_value owner-run-id)" == "$OWNER_RUN_ID" &&
    "$(state_value owner-run-attempt)" == "$OWNER_RUN_ATTEMPT" &&
    "$(state_active_source_sha)" == "$SOURCE_SHA" ]] ||
    migration_die "migration state is fenced by another run"
  fencing_token="$(state_value fencing-token)"
  [[ "$(state_lock_value fencing-token)" == "$fencing_token" ]] ||
    migration_die "migration lock fencing token differs from journal"
  state_initialized=1
  state_boundary="$(state_value destructive-boundary)"
  state_recovery="$(state_value recovery-required)"
  last_committed_phase="$(state_value phase)"
  [[ "$state_boundary" == "true" ]] && state_boundary=1 || state_boundary=0
  [[ "$state_recovery" == "true" ]] && state_recovery=1 || state_recovery=0
  azure_baseline="$(state_value azure-baseline)"
  oci_baseline="$(state_value oci-baseline)"
  printf 'timestamp\tsequence\tphase\tfencing_token\tdestructive_boundary\trecovery_required\n' \
    >"$JOURNAL_FILE"
}

state_assert_fence() {
  state_read_all >/dev/null
  state_compare_kind journal
  state_compare_kind lock
  state_validate_contract
  [[ "$(state_value migration-id)" == "$MIGRATION_ID" &&
    "$(state_value owner-run-id)" == "$OWNER_RUN_ID" &&
    "$(state_value owner-run-attempt)" == "$OWNER_RUN_ATTEMPT" &&
    "$(state_active_source_sha)" == "$SOURCE_SHA" &&
    "$(state_value fencing-token)" == "$fencing_token" &&
    "$(state_lock_value migration-id)" == "$MIGRATION_ID" &&
    "$(state_lock_value owner-run-id)" == "$OWNER_RUN_ID" &&
    "$(state_lock_value owner-run-attempt)" == "$OWNER_RUN_ATTEMPT" &&
    "$(state_lock_value fencing-token)" == "$fencing_token" &&
    "$(state_lock_value state)" == "active" ]] ||
    migration_die "migration process is fenced by a newer owner"
}

migration_heartbeat() {
  local requested_now="${1:-$(migration_epoch)}"
  [[ "$state_initialized" == "1" ]] || return 0
  local sequence phase previous_heartbeat now provider
  local transaction_failed=0 rollback_failed=0
  state_read_all >/dev/null
  state_compare_kind journal
  state_validate_contract
  sequence="$(state_value sequence)"
  phase="$(state_value phase)"
  previous_heartbeat="$(state_value heartbeat-epoch)"
  now="$requested_now"
  if (( now <= previous_heartbeat )); then
    now=$((previous_heartbeat + 1))
  fi
  for provider in azure oci; do
    state_checkpoint_one "$provider" journal \
      "$state_dir/heartbeat-${provider}-journal.json"
  done
  for provider in azure oci; do
    state_replace_one "$provider" journal \
      --expect "migration-id=$MIGRATION_ID" \
      --expect "owner-run-id=$OWNER_RUN_ID" \
      --expect "owner-run-attempt=$OWNER_RUN_ATTEMPT" \
      --expect "fencing-token=$fencing_token" \
      --expect "sequence=$sequence" \
      --expect "phase=$phase" \
      --set "heartbeat-epoch=$now" || {
        transaction_failed=1
        break
      }
  done
  if [[ "$transaction_failed" == "1" ]]; then
    for provider in azure oci; do
      state_restore_one "$provider" journal \
        "$state_dir/heartbeat-${provider}-journal.json" \
        "migration-id=$MIGRATION_ID" \
        "owner-run-id=$OWNER_RUN_ID" \
        "owner-run-attempt=$OWNER_RUN_ATTEMPT" \
        "fencing-token=$fencing_token" \
        "sequence=$sequence" \
        "phase=$phase" \
        "heartbeat-epoch=$now" || rollback_failed=1
    done
    [[ "$rollback_failed" == "0" ]] ||
      migration_die "heartbeat mirror update failed and CAS rollback was incomplete"
    migration_die "heartbeat mirror compare-and-swap failed"
  fi
}

state_advance() {
  local phase="$1"
  local boundary="$2"
  local recovery="$3"
  shift 3
  local old_sequence old_heartbeat now provider item
  local transaction_failed=0 rollback_failed=0
  local arguments=()
  state_read_all >/dev/null
  state_compare_kind journal
  state_compare_kind lock
  state_validate_contract
  old_sequence="$(state_value sequence)"
  old_heartbeat="$(state_value heartbeat-epoch)"
  now="$(state_monotonic_epoch "$old_heartbeat")"
  arguments=(
    --expect "migration-id=$MIGRATION_ID"
    --expect "owner-run-id=$OWNER_RUN_ID"
    --expect "owner-run-attempt=$OWNER_RUN_ATTEMPT"
    --expect "fencing-token=$fencing_token"
    --expect "sequence=$old_sequence"
    --set "sequence=$((old_sequence + 1))"
    --set "phase=$phase"
    --set "heartbeat-epoch=$now"
    --set "destructive-boundary=$boundary"
    --set "recovery-required=$recovery"
  )
  for item in "$@"; do
    arguments+=(--set "$item")
  done
  for provider in azure oci; do
    state_checkpoint_one "$provider" journal \
      "$state_dir/advance-${provider}-journal.json"
  done
  for provider in azure oci; do
    state_replace_one "$provider" journal "${arguments[@]}" || {
      transaction_failed=1
      break
    }
  done
  if [[ "$transaction_failed" == "1" ]]; then
    for provider in azure oci; do
      state_restore_one "$provider" journal \
        "$state_dir/advance-${provider}-journal.json" \
        "migration-id=$MIGRATION_ID" \
        "owner-run-id=$OWNER_RUN_ID" \
        "owner-run-attempt=$OWNER_RUN_ATTEMPT" \
        "fencing-token=$fencing_token" \
        "sequence=$((old_sequence + 1))" \
        "phase=$phase" || rollback_failed=1
    done
    [[ "$rollback_failed" == "0" ]] ||
      migration_die "phase mirror update failed and CAS rollback was incomplete"
    migration_die "phase mirror compare-and-swap failed: $phase"
  fi
  last_committed_phase="$phase"
  state_boundary=0
  state_recovery=0
  [[ "$boundary" == "true" ]] && state_boundary=1
  [[ "$recovery" == "true" ]] && state_recovery=1
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(migration_iso8601)" "$((old_sequence + 1))" "$phase" \
    "$fencing_token" "$boundary" "$recovery" >>"$JOURNAL_FILE"
  migration_failure_hook "$phase"
}

state_release() {
  local provider transaction_failed=0 rollback_failed=0
  state_read_all >/dev/null
  state_compare_kind lock
  state_validate_contract
  for provider in azure oci; do
    state_checkpoint_one "$provider" lock \
      "$state_dir/release-${provider}-lock.json"
  done
  for provider in azure oci; do
    state_replace_one "$provider" lock \
      --expect "migration-id=$MIGRATION_ID" \
      --expect "owner-run-id=$OWNER_RUN_ID" \
      --expect "owner-run-attempt=$OWNER_RUN_ATTEMPT" \
      --expect "fencing-token=$fencing_token" \
      --expect "state=active" \
      --set "state=released" || {
        transaction_failed=1
        break
      }
  done
  if [[ "$transaction_failed" == "1" ]]; then
    for provider in azure oci; do
      state_restore_one "$provider" lock \
        "$state_dir/release-${provider}-lock.json" \
        "migration-id=$MIGRATION_ID" \
        "owner-run-id=$OWNER_RUN_ID" \
        "owner-run-attempt=$OWNER_RUN_ATTEMPT" \
        "fencing-token=$fencing_token" \
        "state=released" || rollback_failed=1
    done
    [[ "$rollback_failed" == "0" ]] ||
      migration_die "lock release failed and CAS rollback was incomplete"
    migration_die "lock release compare-and-swap failed"
  fi
}

state_write_summary() {
  state_read_all >/dev/null
  state_compare_kind journal
  migration_raw state-summary 30 1 \
    python3 "$STATE_HELPER" summary "$(state_file azure journal)" \
    >"$SUMMARY_FILE"
}

validate_kubeconfig() {
  local provider="$1"
  local expected_server_hash="$2"
  local expected_runtime_id="${3:-}"
  local config server node
  config="$(
    kube_capture "$provider" kubeconfig-read 30 2 \
      config view --raw --minify -o json
  )"
  server="$(migration_raw kubeconfig-json 30 1 jq -r \
    '.clusters[0].cluster.server // empty' <<<"$config")"
  [[ "$server" == https://* ]] ||
    migration_die "$provider kubeconfig has no HTTPS API server"
  if [[ -n "$expected_server_hash" ]]; then
    [[ "$(migration_fingerprint "$server")" == "$expected_server_hash" ]] ||
      migration_die "$provider API server fingerprint mismatch"
  fi
  if [[ -n "$expected_runtime_id" ]]; then
    if [[ "$OCI_RUNTIME_MODE" == "oke" ]]; then
      migration_raw kubeconfig-identity 30 1 jq -e \
        --arg runtime "$expected_runtime_id" '
          [.users[].user.exec.args[]? | select(. == $runtime)] | length == 1
        ' <<<"$config" >/dev/null ||
        migration_die "OCI kubeconfig does not identify the exact runtime"
    else
      [[ "$server" =~ ^https://127\.0\.0\.1:[0-9]+$ ]] ||
        migration_die "k3s kubeconfig must use the local Bastion tunnel"
      node="$(kube_capture oci node-identity 30 2 \
        get node "$OCI_K3S_NODE_NAME" -o json)"
      migration_raw node-identity 30 1 jq -e \
        --arg provider_id "oci://${expected_runtime_id}" '
          .spec.providerID == $provider_id and
          .metadata.labels."kubernetes.io/arch" == "arm64" and
          ([.status.conditions[] | select(
            .type == "Ready" and .status == "True"
          )] | length) == 1
        ' <<<"$node" >/dev/null ||
        migration_die "k3s node identity differs from provenance"
    fi
  fi
}

baseline_capture() {
  local provider="$1"
  local ingress service replicas result
  ingress="$(kube_capture "$provider" baseline-read 30 2 \
    get deployment ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.spec.replicas}')"
  [[ "$ingress" =~ ^[0-9]+$ ]] || migration_die "invalid $provider ingress baseline"
  result="ingress=$ingress"
  if [[ "$provider" == "oci" ]]; then
    replicas="$(kube_capture oci baseline-read 30 2 \
      get deployment gaming-rabbitmq-depl -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath='{.spec.replicas}')"
    [[ "$replicas" =~ ^[0-9]+$ ]] || migration_die "invalid OCI RabbitMQ baseline"
    result="$result,rabbitmq=$replicas"
  fi
  for service in "${APP_SERVICES[@]}"; do
    replicas="$(kube_capture "$provider" baseline-read 30 2 \
      get deployment "gaming-${service}-depl" \
      -n "$(provider_namespace "$provider")" \
      -o jsonpath='{.spec.replicas}')"
    [[ "$replicas" =~ ^[0-9]+$ ]] ||
      migration_die "invalid $provider replica baseline for $service"
    result="$result,$service=$replicas"
  done
  printf '%s' "$result"
}

baseline_value() {
  local baseline="$1"
  local key="$2"
  local entry old_ifs="$IFS"
  IFS=,
  for entry in $baseline; do
    if [[ "${entry%%=*}" == "$key" ]]; then
      IFS="$old_ifs"
      printf '%s' "${entry#*=}"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

http_write_fence_config_status() {
  local snippet
  snippet="$(kube_capture oci ingress-config-read 30 2 \
    get configmap "$INGRESS_CONTROLLER_CONFIGMAP" \
    -n "$INGRESS_CONTROLLER_NAMESPACE" \
    -o jsonpath='{.data.server-snippet}')"
  case "$snippet" in
    "$INGRESS_BASE_SERVER_SNIPPET")
      printf false
      ;;
    "$INGRESS_FENCED_SERVER_SNIPPET")
      printf true
      ;;
    *)
      migration_die \
        "ingress controller server-snippet differs from the reviewed baseline or mutation fence"
      ;;
  esac
}

set_http_write_fence_config() {
  local expected="$1"
  local current desired patch
  [[ "$expected" == "true" || "$expected" == "false" ]] ||
    migration_die "HTTP write fence state must be true or false"
  current="$(http_write_fence_config_status)"
  [[ "$current" == "$expected" ]] && return 0
  if [[ "$expected" == "true" ]]; then
    desired="$INGRESS_FENCED_SERVER_SNIPPET"
  else
    desired="$INGRESS_BASE_SERVER_SNIPPET"
  fi
  patch="$(migration_raw ingress-config-patch 30 1 \
    jq -cn --arg snippet "$desired" \
      '{data:{"server-snippet":$snippet}}')"
  kube_run oci ingress-config-patch "$COMMAND_TIMEOUT_SECONDS" 2 \
    patch configmap "$INGRESS_CONTROLLER_CONFIGMAP" \
    -n "$INGRESS_CONTROLLER_NAMESPACE" \
    --type merge --patch "$patch" >/dev/null
  [[ "$(http_write_fence_config_status)" == "$expected" ]] ||
    migration_die "ingress HTTP write fence ConfigMap did not reach the requested state"
}

http_write_fence_runtime_status() {
  local deployment_state desired available pods_json pod_count pod_names
  local pod rendered fence_line fenced_count=0
  deployment_state="$(kube_capture oci ingress-workload-read 30 2 \
    get deployment ingress-nginx-controller \
    -n "$INGRESS_CONTROLLER_NAMESPACE" \
    -o jsonpath='{.spec.replicas}|{.status.availableReplicas}')"
  IFS='|' read -r desired available <<<"$deployment_state"
  available="${available:-0}"
  [[ "$desired" =~ ^[1-9][0-9]*$ && "$available" == "$desired" ]] ||
    migration_die "ingress controller is not fully available for mutation-fence validation"
  pods_json="$(kube_capture oci ingress-pod-read 30 2 \
    get pods -n "$INGRESS_CONTROLLER_NAMESPACE" \
    -l app.kubernetes.io/component=controller -o json)"
  pod_count="$(migration_raw ingress-pod-count 30 1 \
    jq '.items | length' <<<"$pods_json")"
  [[ "$pod_count" == "$desired" ]] ||
    migration_die "ingress controller pod count differs from its available replicas"
  migration_raw ingress-pod-readiness 30 1 jq -e '
    all(.items[];
      .metadata.deletionTimestamp == null and
      .status.phase == "Running" and
      any(.status.conditions[]?;
        .type == "Ready" and .status == "True"))
  ' <<<"$pods_json" >/dev/null ||
    migration_die "an ingress controller pod is not stably Ready"
  pod_names="$(migration_raw ingress-pod-names 30 1 \
    jq -r '.items[].metadata.name' <<<"$pods_json")"
  [[ "$(awk 'NF {count++} END {print count+0}' <<<"$pod_names")" == "$pod_count" ]] ||
    migration_die "ingress controller pod-name inventory is incomplete"
  fence_line="${INGRESS_HTTP_WRITE_FENCE_DIRECTIVE%%$'\n'*}"
  while IFS= read -r pod; do
    [[ -n "$pod" ]] || continue
    rendered="$(kube_capture oci ingress-runtime-read 60 2 \
      exec -n "$INGRESS_CONTROLLER_NAMESPACE" "$pod" -- \
      sh -c 'nginx -T 2>&1')"
    grep -Fq 'return 308 https://betstan.xyz$request_uri;' <<<"$rendered" ||
      migration_die "running ingress controller lost the reviewed www redirect"
    if grep -Fq "$fence_line" <<<"$rendered"; then
      fenced_count=$((fenced_count + 1))
    fi
  done <<<"$pod_names"
  if [[ "$fenced_count" == "$pod_count" ]]; then
    printf true
  elif [[ "$fenced_count" == "0" ]]; then
    printf false
  else
    migration_die "ingress controller replicas disagree on the HTTP write fence"
  fi
}

wait_http_write_fence_runtime() {
  local expected="$1"
  local attempt actual=""
  for attempt in $(seq 1 30); do
    if actual="$(http_write_fence_runtime_status)" &&
        [[ "$actual" == "$expected" ]]; then
      return 0
    fi
    migration_sleep 2
  done
  migration_die \
    "running ingress controller HTTP write fence did not reach state $expected"
}

install_http_write_fence() {
  state_assert_fence
  set_http_write_fence_config true
  state_advance http-write-fence-installed \
    "$(state_boundary_text)" "$(state_recovery_text)" \
    "http-write-fence=true"
  migration_failure_hook http-write-fence-install
}

remove_http_write_fence() {
  set_http_write_fence_config false
  wait_http_write_fence_runtime false
}

wait_deployment_zero() {
  local provider="$1"
  local namespace="$2"
  local deployment="$3"
  local selector="$4"
  local attempt state desired available ready pods
  for attempt in $(seq 1 60); do
    state="$(kube_capture "$provider" workload-read 30 2 \
      get deployment "$deployment" -n "$namespace" \
      -o jsonpath='{.spec.replicas}|{.status.availableReplicas}|{.status.readyReplicas}')"
    IFS='|' read -r desired available ready <<<"$state"
    available="${available:-0}"
    ready="${ready:-0}"
    pods="$(
      kube_capture "$provider" pod-read 30 2 \
        get pods -n "$namespace" -l "$selector" -o json |
        migration_raw pod-count 30 1 jq '.items | length'
    )"
    if [[ "$desired" == "0" && "$available" == "0" &&
          "$ready" == "0" && "$pods" == "0" ]]; then
      return 0
    fi
    migration_sleep 5
  done
  migration_die "$provider deployment did not reach zero: $deployment"
}

scale_deployment() {
  local provider="$1"
  local namespace="$2"
  local deployment="$3"
  local replicas="$4"
  kube_run "$provider" workload-scale "$COMMAND_TIMEOUT_SECONDS" 2 \
    scale deployment "$deployment" -n "$namespace" --replicas "$replicas" >/dev/null
}

freeze_ingress() {
  local provider="$1"
  scale_deployment "$provider" ingress-nginx ingress-nginx-controller 0
  wait_deployment_zero "$provider" ingress-nginx ingress-nginx-controller \
    app.kubernetes.io/component=controller
}

freeze_applications() {
  local provider="$1"
  local namespace service
  namespace="$(provider_namespace "$provider")"
  for service in "${APP_SERVICES[@]}"; do
    scale_deployment "$provider" "$namespace" "gaming-${service}-depl" 0
  done
  for service in "${APP_SERVICES[@]}"; do
    wait_deployment_zero "$provider" "$namespace" "gaming-${service}-depl" \
      "app=gaming-${service}"
  done
}

rabbit_queue_rows() {
  local provider="$1"
  local namespace pod output
  namespace="$(provider_namespace "$provider")"
  pod="$(kube_capture "$provider" rabbitmq-pod 30 2 \
    get pods -n "$namespace" -l app=gaming-rabbitmq \
    -o jsonpath='{.items[0].metadata.name}')"
  [[ -n "$pod" ]] || migration_die "$provider RabbitMQ pod is missing"
  output="$(kube_capture "$provider" rabbitmq-queues 60 2 \
    exec -n "$namespace" "$pod" -- \
    rabbitmqctl list_queues --quiet \
      name messages_ready messages_unacknowledged consumers)"
  oci_rabbitmq_queue_rows <<<"$output" ||
    migration_die "$provider RabbitMQ queue output is malformed"
}

drain_queues() {
  local provider="$1"
  local attempt rows names expected count backlog bad_consumers
  expected="$(LC_ALL=C sort "$OCI_RABBITMQ_BASELINE_FILE")"
  for attempt in $(seq 1 "$QUEUE_DRAIN_ATTEMPTS"); do
    rows="$(rabbit_queue_rows "$provider")"
    count="$(awk 'NF {count++} END {print count+0}' <<<"$rows")"
    names="$(awk '{print $1}' <<<"$rows" | LC_ALL=C sort)"
    [[ "$count" == "17" && "$names" == "$expected" ]] ||
      migration_die "$provider RabbitMQ topology differs from the exact 17-queue baseline"
    backlog="$(awk '{sum += $2 + $3} END {print sum+0}' <<<"$rows")"
    bad_consumers="$(
      awk '($2 != 0 || $3 != 0) && $4 < 1 {bad++} END {print bad+0}' <<<"$rows"
    )"
    [[ "$bad_consumers" == "0" ]] ||
      migration_die "$provider RabbitMQ has queued messages without consumers"
    [[ "$backlog" == "0" ]] && return 0
    migration_sleep "$QUEUE_DRAIN_SLEEP_SECONDS"
  done
  migration_die "$provider RabbitMQ did not drain before the bounded deadline"
}

applications_are_zero() {
  local provider="$1"
  local namespace service replicas
  namespace="$(provider_namespace "$provider")"
  for service in "${APP_SERVICES[@]}"; do
    replicas="$(kube_capture "$provider" workload-read 30 2 \
      get deployment "gaming-${service}-depl" -n "$namespace" \
      -o jsonpath='{.spec.replicas}')"
    [[ "$replicas" == "0" ]] || return 1
  done
}

verify_frozen_source_queues() {
  local rows count backlog names expected
  rows="$(rabbit_queue_rows azure)"
  count="$(awk 'NF {count++} END {print count+0}' <<<"$rows")"
  backlog="$(awk '{sum += $2 + $3} END {print sum+0}' <<<"$rows")"
  [[ "$backlog" == "0" ]] ||
    migration_die "frozen Azure retry source has a RabbitMQ backlog"
  if [[ "$count" == "17" ]]; then
    names="$(awk '{print $1}' <<<"$rows" | LC_ALL=C sort)"
    expected="$(LC_ALL=C sort "$OCI_RABBITMQ_BASELINE_FILE")"
    [[ "$names" == "$expected" ]] ||
      migration_die "frozen Azure retry queue names differ"
  else
    [[ "$count" == "0" ]] ||
      migration_die "frozen Azure retry has a partial RabbitMQ topology"
  fi
}

mongo_eval() {
  local provider="$1"
  local pod="$2"
  local script="$3"
  kube_capture "$provider" mongo-read "$COMMAND_TIMEOUT_SECONDS" 2 \
    exec -n "$(provider_namespace "$provider")" "$pod" -- \
    mongosh --quiet --eval "$script"
}

target_write_lock_status() {
  mongo_eval oci "$target_mongo_pod" '
    const result=db.getSiblingDB("admin").runCommand({currentOp:1,$all:true});
    if (Number(result.ok) !== 1 ||
        (result.fsyncLock !== undefined &&
         typeof result.fsyncLock !== "boolean")) {
      throw new Error("Mongo fsync lock status is unavailable");
    }
    print(result.fsyncLock === true);
  '
}

lock_target_writes() {
  local result
  [[ "$(target_write_lock_status)" == "false" ]] ||
    migration_die "OCI Mongo write lock was already active unexpectedly"
  result="$(mongo_eval oci "$target_mongo_pod" '
    const result=db.getSiblingDB("admin").runCommand({fsync:1,lock:true});
    const lockCount=Number(result.lockCount);
    print(JSON.stringify({ok:Number(result.ok),lockCount}));
  ')"
  migration_raw mongo-write-lock 30 1 jq -e \
    '.ok == 1 and .lockCount >= 1' <<<"$result" >/dev/null ||
    migration_die "OCI Mongo could not enter read-only cutover validation"
  [[ "$(target_write_lock_status)" == "true" ]] ||
    migration_die "OCI Mongo write lock is not active"
  state_advance target-write-locked true true "mongo-write-lock=true"
}

unlock_target_writes() {
  local result
  if [[ "$(target_write_lock_status)" == "false" ]]; then
    return 0
  fi
  result="$(mongo_eval oci "$target_mongo_pod" '
    const result=db.getSiblingDB("admin").runCommand({fsyncUnlock:1});
    const lockCount=Number(result.lockCount);
    print(JSON.stringify({ok:Number(result.ok),lockCount}));
  ')"
  migration_raw mongo-write-unlock 30 1 jq -e \
    '.ok == 1 and .lockCount == 0' <<<"$result" >/dev/null ||
    migration_die "OCI Mongo write lock could not be released"
  [[ "$(target_write_lock_status)" == "false" ]] ||
    migration_die "OCI Mongo remained write-locked after activation"
}

unlock_target_writes_for_retry() {
  target_mongo_pod="$(kube_capture oci target-pod 30 2 \
    get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo \
    -o jsonpath='{.items[0].metadata.name}')"
  [[ -n "$target_mongo_pod" ]] ||
    migration_die "OCI Mongo pod is unavailable for retry preparation"
  if [[ "$(target_write_lock_status)" == "true" ]]; then
    unlock_target_writes
    state_advance retry-write-lock-released true true \
      "mongo-write-lock=false"
  fi
}

rabbitmq_write_permission() {
  local pod output
  pod="$(kube_capture oci rabbitmq-pod 30 2 \
    get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-rabbitmq \
    -o jsonpath='{.items[0].metadata.name}')"
  [[ -n "$pod" ]] ||
    migration_die "OCI RabbitMQ pod is missing for permission validation"
  output="$(kube_capture oci rabbitmq-permissions 60 2 \
    exec -n "$OCI_K8S_NAMESPACE" "$pod" -- \
    rabbitmqctl list_user_permissions guest)"
  awk '
    $1 == "/" && NF == 4 { print $3; found++ }
    END { if (found != 1) exit 1 }
  ' <<<"$output" ||
    migration_die "OCI RabbitMQ guest permissions are malformed"
}

lock_rabbitmq_writes() {
  local pod
  pod="$(kube_capture oci rabbitmq-pod 30 2 \
    get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-rabbitmq \
    -o jsonpath='{.items[0].metadata.name}')"
  kube_run oci rabbitmq-write-lock 60 2 \
    exec -n "$OCI_K8S_NAMESPACE" "$pod" -- \
    rabbitmqctl set_permissions -p / guest '.*' '^$' '.*' >/dev/null
  [[ "$(rabbitmq_write_permission)" == "^$" ]] ||
    migration_die "OCI RabbitMQ publish permission remained enabled"
  state_advance messaging-write-locked true true \
    "mongo-write-lock=true" "rabbitmq-write-lock=true"
}

unlock_rabbitmq_writes() {
  local pod
  pod="$(kube_capture oci rabbitmq-pod 30 2 \
    get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-rabbitmq \
    -o jsonpath='{.items[0].metadata.name}')"
  kube_run oci rabbitmq-write-unlock 60 2 \
    exec -n "$OCI_K8S_NAMESPACE" "$pod" -- \
    rabbitmqctl set_permissions -p / guest '.*' '.*' '.*' >/dev/null
  [[ "$(rabbitmq_write_permission)" == ".*" ]] ||
    migration_die "OCI RabbitMQ publish permission was not restored"
}

verify_cutover_write_locks() {
  [[ "$(state_optional_value mongo-write-lock)" == "true" &&
    "$(target_write_lock_status)" == "true" &&
    "$(state_optional_value rabbitmq-write-lock)" == "true" &&
    "$(rabbitmq_write_permission)" == "^$" &&
    "$(state_optional_value http-write-fence)" == "true" &&
    "$(http_write_fence_config_status)" == "true" &&
    "$(http_write_fence_runtime_status)" == "true" ]] ||
    migration_die \
      "OCI data, messaging, or external HTTP write fence changed before parity certification"
}

mongo_runtime() {
  mongo_eval "$1" "$2" '
    const result=db.adminCommand({getParameter:1,featureCompatibilityVersion:1});
    if (result.ok !== 1) throw new Error("FCV read failed");
    print(JSON.stringify({
      version:db.version(),
      majorMinor:db.version().split(".").slice(0,2).join("."),
      fcv:result.featureCompatibilityVersion.version
    }));
  '
}

mongo_runtime_is_reviewed() {
  migration_raw mongo-runtime 30 1 jq -e \
    --arg version "$MONGO_REVIEWED_VERSION" \
    --arg fcv "$MONGO_REVIEWED_FCV" '
      .version == $version and
      .majorMinor == $fcv and
      .fcv == $fcv
    ' <<<"$1" >/dev/null
}

source_mongo_image_is_reviewed() {
  [[ "$1" == *"@$MONGO_REVIEWED_INDEX_DIGEST" ||
    "$1" == *"@$MONGO_REVIEWED_AMD64_MANIFEST" ]]
}

target_mongo_image_is_reviewed() {
  [[ "$1" == *"@$MONGO_REVIEWED_INDEX_DIGEST" ||
    "$1" == *"@$MONGO_REVIEWED_ARM64_MANIFEST" ]]
}

mongo_non_system_databases() {
  mongo_eval "$1" "$2" '
    const system=new Set(["admin","config","local"]);
    const result=db.adminCommand({listDatabases:1,nameOnly:true});
    print(JSON.stringify(
      result.databases.map(item=>item.name).filter(name=>!system.has(name)).sort()
    ));
  '
}

deployment_mongo_uri() {
  local provider="$1"
  local service="$2"
  kube_capture "$provider" deployment-mapping 30 2 \
    get deployment "gaming-${service}-depl" \
    -n "$(provider_namespace "$provider")" -o json |
    migration_raw deployment-mapping 30 1 jq -r \
      --arg container "gaming-${service}" '
        [
          .spec.template.spec.containers[] |
          select(.name == $container) |
          .env[]? |
          select(.name == "MONGO_URI") |
          .value
        ] |
        if length == 1 then .[0] else "" end
      '
}

expected_database_json() {
  printf '%s\n' "${DATABASE_MAPPINGS[@]}" |
    awk -F'|' '{print $2}' |
    LC_ALL=C sort |
    migration_raw database-json 30 1 jq -Rsc \
      'split("\n") | map(select(length > 0))'
}

mongo_signature_kube() {
  local provider="$1"
  local pod="$2"
  local database="$3"
  local output="$4"
  local script_file="$signature_dir/${database}.script.js"
  {
    printf 'const DB_NAME = "%s";\n' "$database"
    cat "$SIGNATURE_SCRIPT"
  } >"$script_file"
  # Mongosh 2.5 treats bare stdin as a REPL; file mode emits only the script result.
  kube_raw "$provider" mongo-signature "$MONGO_VALIDATION_TIMEOUT_SECONDS" 2 \
    exec -i -n "$(provider_namespace "$provider")" "$pod" -- \
    mongosh --quiet --file /dev/stdin <"$script_file" >"$output"
  [[ -s "$output" ]] || migration_die "empty canonical signature for $database"
  migration_raw signature-json 30 1 jq -e . "$output" >/dev/null ||
    migration_die "invalid canonical signature for $database"
  rm -f "$script_file"
}

mongo_signature_docker() {
  local database="$1"
  local output="$2"
  local script_file="$signature_dir/${database}.disposable.js"
  {
    printf 'const DB_NAME = "%s";\n' "$database"
    cat "$SIGNATURE_SCRIPT"
  } >"$script_file"
  migration_raw disposable-signature "$MONGO_VALIDATION_TIMEOUT_SECONDS" 2 \
    docker exec -i "$disposable_container" mongosh --quiet --file /dev/stdin \
    <"$script_file" >"$output"
  [[ -s "$output" ]] || migration_die "empty disposable signature for $database"
  migration_raw signature-json 30 1 jq -e . "$output" >/dev/null ||
    migration_die "invalid disposable signature for $database"
  rm -f "$script_file"
}

validate_source_topology() {
  local statefulsets expected_count=0 mapping service database sts pod pvc
  local sts_json pod_json claim phase runtime digest uid container_id restart_count
  local non_system expected_json
  local runtime_reference="" digest_reference="" source_pvcs target_statefulsets
  local expected_uri actual_uri source_rows
  source_rows="${source_mongo_manifest}.rows"
  : >"$source_rows"
  statefulsets="$(kube_capture azure source-statefulsets 30 2 \
    get statefulsets -n "$AZURE_NAMESPACE" -o json)"
  expected_count="$(
    migration_raw source-statefulsets 30 1 jq '
      [.items[] | select(.metadata.name | test(
        "^gaming-(auth|bet|backoffice|event|gamemaster|moderation|resulting|slip)-mongo-depl$"
      ))] | length
    ' <<<"$statefulsets"
  )"
  [[ "$expected_count" == "8" ]] ||
    migration_die "Azure must contain all eight exact Mongo StatefulSets"
  [[ "$(migration_raw source-statefulsets 30 1 jq \
    '[.items[] | select(.metadata.name | test("mongo"))] | length' \
    <<<"$statefulsets")" == "8" ]] ||
    migration_die "Azure contains an unknown Mongo StatefulSet"
  source_pvcs="$(kube_capture azure source-pvcs 30 2 \
    get persistentvolumeclaims -n "$AZURE_NAMESPACE" -o json)"
  [[ "$(migration_raw source-pvcs 30 1 jq \
    '[.items[] | select(.metadata.name | test("mongo-data"))] | length' \
    <<<"$source_pvcs")" == "8" ]] ||
    migration_die "Azure must contain exactly eight Mongo PVCs"

  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r service database sts pod pvc <<<"$mapping"
    expected_uri="mongodb://gaming-${service}-mongo-srv:27017/${database}"
    actual_uri="$(deployment_mongo_uri azure "$service")"
    [[ "$actual_uri" == "$expected_uri" ]] ||
      migration_die "Azure application/database mapping differs for $service"
    sts_json="$(kube_capture azure source-statefulset 30 2 \
      get statefulset "$sts" -n "$AZURE_NAMESPACE" -o json)"
    migration_raw source-statefulset 30 1 jq -e \
      --arg pod "$pod" --arg pvc "$pvc" '
        .spec.replicas == 1 and
        (.status.readyReplicas // 0) == 1 and
        (.spec.volumeClaimTemplates | length) == 1 and
        (.spec.template.spec.containers | length) == 1 and
        .spec.template.spec.containers[0].volumeMounts[0].mountPath == "/data/db"
      ' <<<"$sts_json" >/dev/null ||
      migration_die "Azure Mongo StatefulSet mapping is invalid: $sts"
    phase="$(kube_capture azure source-pvc 30 2 \
      get pvc "$pvc" -n "$AZURE_NAMESPACE" -o jsonpath='{.status.phase}')"
    [[ "$phase" == "Bound" ]] || migration_die "Azure PVC is not Bound: $pvc"
    claim="$(kube_capture azure source-pod 30 2 \
      get pod "$pod" -n "$AZURE_NAMESPACE" \
      -o jsonpath='{.spec.volumes[?(@.name=="'"${sts%-depl}"'-data")].persistentVolumeClaim.claimName}')"
    [[ "$claim" == "$pvc" ]] ||
      migration_die "Azure Mongo pod/PVC mapping differs for $database"
    pod_json="$(kube_capture azure source-pod 30 2 \
      get pod "$pod" -n "$AZURE_NAMESPACE" -o json)"
    migration_raw source-pod 30 1 jq -e '
      ([.status.conditions[] | select(.type == "Ready" and .status == "True")] | length) == 1
    ' <<<"$pod_json" >/dev/null ||
      migration_die "Azure Mongo pod is not Ready: $pod"
    digest="$(migration_raw source-pod 30 1 jq -r \
      '.status.containerStatuses[0].imageID // empty' <<<"$pod_json")"
    source_mongo_image_is_reviewed "$digest" ||
      migration_die "Azure Mongo image differs from the reviewed 8.2.12 release: $pod"
    uid="$(migration_raw source-pod 30 1 jq -r '.metadata.uid // empty' <<<"$pod_json")"
    [[ "$uid" =~ ^[a-z0-9-]+$ ]] ||
      migration_die "Azure Mongo pod UID is unreadable: $pod"
    container_id="$(migration_raw source-pod 30 1 jq -r \
      '.status.containerStatuses[0].containerID // empty' <<<"$pod_json")"
    [[ "$container_id" =~ ^[a-z0-9+.-]+://[a-zA-Z0-9._:-]+$ ]] ||
      migration_die "Azure Mongo container ID is unreadable: $pod"
    restart_count="$(migration_raw source-pod 30 1 jq -r \
      '.status.containerStatuses[0].restartCount // empty' <<<"$pod_json")"
    [[ "$restart_count" =~ ^[0-9]+$ ]] ||
      migration_die "Azure Mongo restart count is unreadable: $pod"
    if [[ -z "$digest_reference" ]]; then
      digest_reference="$digest"
    else
      [[ "$digest" == "$digest_reference" ]] ||
        migration_die "Azure Mongo image digests differ"
    fi
    runtime="$(mongo_runtime azure "$pod")"
    migration_raw mongo-runtime 30 1 jq -e \
      '.version != null and .majorMinor != null and .fcv != null' <<<"$runtime" >/dev/null ||
      migration_die "Azure Mongo version/FCV is unreadable: $pod"
    mongo_runtime_is_reviewed "$runtime" ||
      migration_die "Azure Mongo runtime differs from exact version 8.2.12 and FCV 8.2: $pod"
    if [[ -z "$runtime_reference" ]]; then
      runtime_reference="$(migration_raw mongo-runtime 30 1 jq -c \
        '{version,majorMinor,fcv}' <<<"$runtime")"
    else
      [[ "$(migration_raw mongo-runtime 30 1 jq -c \
        '{version,majorMinor,fcv}' <<<"$runtime")" == "$runtime_reference" ]] ||
        migration_die "Azure Mongo version/FCV differs across sources"
    fi
    non_system="$(mongo_non_system_databases azure "$pod")"
    expected_json="$(migration_raw database-json 30 1 jq -cn --arg database "$database" \
      '[$database]')"
    [[ "$non_system" == "$expected_json" ]] ||
      migration_die "Azure source inventory is not exact for $database"
    migration_raw source-manifest 30 1 jq -cn \
      --arg pod "$pod" \
      --arg uid "$uid" \
      --arg image_id "$digest" \
      --arg container_id "$container_id" \
      --arg restart_count "$restart_count" \
      --argjson runtime "$runtime" \
      '{
        pod:$pod,
        uid:$uid,
        image_id:$image_id,
        container_id:$container_id,
        restart_count:$restart_count,
        runtime:$runtime
      }' >>"$source_rows"
  done
  migration_raw source-manifest 30 1 jq -cs 'sort_by(.pod)' \
    "$source_rows" >"$source_mongo_manifest"
  rm -f "$source_rows"
  [[ "$(migration_raw source-manifest 30 1 jq 'length' "$source_mongo_manifest")" == "8" ]] ||
    migration_die "Azure Mongo identity manifest does not contain all eight sources"
  migration_log "azure_mongo_runtime=$(
    migration_raw mongo-runtime 30 1 jq -r \
      '.version + "/fcv-" + .fcv' <<<"$runtime_reference"
  )"

  target_statefulsets="$(kube_capture oci target-statefulsets 30 2 \
    get statefulsets -n "$OCI_K8S_NAMESPACE" -o json)"
  [[ "$(migration_raw target-statefulsets 30 1 jq \
    '[.items[] | select(.metadata.name | test("mongo"))] | length' \
    <<<"$target_statefulsets")" == "1" ]] ||
    migration_die "OCI target must contain exactly one Mongo StatefulSet"
  migration_raw target-statefulsets 30 1 jq -e '
    [.items[] | select(
      .metadata.name == "gaming-auth-mongo-depl" and
      .spec.replicas == 1 and
      (.status.readyReplicas // 0) == 1
    )] | length == 1
  ' <<<"$target_statefulsets" >/dev/null ||
    migration_die "OCI target Mongo StatefulSet is not exactly ready"
  [[ "$(kube_capture oci target-pvc 30 2 \
    get pvc gaming-auth-mongo-data -n "$OCI_K8S_NAMESPACE" \
    -o jsonpath='{.status.phase}')" == "Bound" ]] ||
    migration_die "OCI target Mongo PVC is not Bound"
  target_mongo_pod="$(kube_capture oci target-pod 30 2 \
    get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo \
    -o jsonpath='{.items[0].metadata.name}')"
  [[ -n "$target_mongo_pod" ]] || migration_die "OCI Mongo pod is missing"
  target_mongo_image="$(kube_capture oci target-image 30 2 \
    get statefulset gaming-auth-mongo-depl -n "$OCI_K8S_NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}')"
  [[ "$target_mongo_image" == "$MONGO_REVIEWED_TARGET_IMAGE" ]] ||
    migration_die "OCI Mongo does not request the reviewed 8.2.12 image"
  pod_json="$(kube_capture oci target-image 30 2 \
    get pod "$target_mongo_pod" -n "$OCI_K8S_NAMESPACE" -o json)"
  target_mongo_uid="$(migration_raw target-image 30 1 jq -r \
    '.metadata.uid // empty' <<<"$pod_json")"
  [[ "$target_mongo_uid" =~ ^[a-z0-9-]+$ ]] ||
    migration_die "OCI Mongo pod UID is unreadable"
  target_mongo_image_id="$(migration_raw target-image 30 1 jq -r \
    '.status.containerStatuses[0].imageID // empty' <<<"$pod_json")"
  target_mongo_image_is_reviewed "$target_mongo_image_id" ||
    migration_die "OCI running Mongo image differs from the reviewed ARM64 release"
  target_mongo_container_id="$(migration_raw target-image 30 1 jq -r \
    '.status.containerStatuses[0].containerID // empty' <<<"$pod_json")"
  [[ "$target_mongo_container_id" =~ ^[a-z0-9+.-]+://[a-zA-Z0-9._:-]+$ ]] ||
    migration_die "OCI Mongo container ID is unreadable"
  target_mongo_restart_count="$(migration_raw target-image 30 1 jq -r \
    '.status.containerStatuses[0].restartCount // empty' <<<"$pod_json")"
  [[ "$target_mongo_restart_count" =~ ^[0-9]+$ ]] ||
    migration_die "OCI Mongo restart count is unreadable"
  target_runtime_signature="$(mongo_runtime oci "$target_mongo_pod")"
  mongo_runtime_is_reviewed "$target_runtime_signature" ||
    migration_die "OCI Mongo runtime differs from exact version 8.2.12 and FCV 8.2"
  migration_log "oci_mongo_runtime=$(
    migration_raw mongo-runtime 30 1 jq -r \
      '.version + "/fcv-" + .fcv' <<<"$target_runtime_signature"
  )"
  [[ "$(migration_raw mongo-runtime 30 1 jq -c \
    '{version,majorMinor,fcv}' <<<"$target_runtime_signature")" == "$runtime_reference" ]] ||
    migration_die "Azure and OCI Mongo version/FCV differ"
  verify_target_mongo_identity
  non_system="$(mongo_non_system_databases oci "$target_mongo_pod")"
  migration_raw target-inventory 30 1 jq -e \
    --argjson expected "$(expected_database_json)" '
      all(.[]; $expected | index(.) != null)
    ' <<<"$non_system" >/dev/null ||
    migration_die "OCI contains a non-allowlisted application database"
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r service database _sts _pod _pvc <<<"$mapping"
    expected_uri="mongodb://gaming-shared-mongo-srv:27017/${database}"
    actual_uri="$(deployment_mongo_uri oci "$service")"
    [[ "$actual_uri" == "$expected_uri" ]] ||
      migration_die "OCI application/database mapping differs for $service"
  done
}

restore_source_mongo_manifest_from_state() {
  local required="$1"
  local content expected_hash actual_hash
  content="$(state_optional_value source-mongo-identities)"
  expected_hash="$(state_optional_value source-mongo-manifest-sha256)"
  if [[ -z "$content" && -z "$expected_hash" && "$required" == "false" ]]; then
    return
  fi
  [[ -n "$content" && "$expected_hash" =~ ^[0-9a-f]{64}$ ]] ||
    migration_die "persisted Azure Mongo identity manifest is incomplete"
  printf '%s\n' "$content" >"$source_mongo_manifest"
  migration_raw source-manifest 30 1 jq -e \
    --arg version "$MONGO_REVIEWED_VERSION" \
    --arg fcv "$MONGO_REVIEWED_FCV" '
      type == "array" and
      length == 8 and
      all(.[];
        (.pod | type == "string") and
        (.uid | test("^[a-z0-9-]+$")) and
        (.image_id | type == "string") and
        (.container_id | test("^[a-z0-9+.-]+://[a-zA-Z0-9._:-]+$")) and
        (.restart_count | test("^[0-9]+$")) and
        .runtime.version == $version and
        .runtime.majorMinor == $fcv and
        .runtime.fcv == $fcv
      )
    ' "$source_mongo_manifest" >/dev/null ||
    migration_die "persisted Azure Mongo identity manifest is invalid"
  actual_hash="$(migration_sha256 <"$source_mongo_manifest")"
  [[ "$actual_hash" == "$expected_hash" ]] ||
    migration_die "persisted Azure Mongo identity manifest hash differs"
}

verify_source_mongo_identity() {
  local pod="$1"
  local pod_json uid image_id container_id restart_count runtime expected
  local expected_uid expected_image_id expected_container_id expected_restart_count
  local expected_runtime actual_runtime
  pod_json="$(kube_capture azure source-mongo-identity 30 2 \
    get pod "$pod" -n "$AZURE_NAMESPACE" -o json)"
  migration_raw source-mongo-identity 30 1 jq -e '
    ([.status.conditions[] | select(
      .type == "Ready" and .status == "True"
    )] | length) == 1
  ' <<<"$pod_json" >/dev/null ||
    migration_die "Azure Mongo pod changed readiness during migration: $pod"
  uid="$(migration_raw source-mongo-identity 30 1 jq -r \
    '.metadata.uid // empty' <<<"$pod_json")"
  image_id="$(migration_raw source-mongo-identity 30 1 jq -r \
    '.status.containerStatuses[0].imageID // empty' <<<"$pod_json")"
  container_id="$(migration_raw source-mongo-identity 30 1 jq -r \
    '.status.containerStatuses[0].containerID // empty' <<<"$pod_json")"
  restart_count="$(migration_raw source-mongo-identity 30 1 jq -r \
    '.status.containerStatuses[0].restartCount // empty' <<<"$pod_json")"
  source_mongo_image_is_reviewed "$image_id" ||
    migration_die "Azure Mongo image drifted from the reviewed release: $pod"
  runtime="$(mongo_runtime azure "$pod")"
  mongo_runtime_is_reviewed "$runtime" ||
    migration_die "Azure Mongo runtime drifted from version 8.2.12 and FCV 8.2: $pod"

  if [[ -f "$source_mongo_manifest" ]]; then
    expected="$(migration_raw source-manifest 30 1 jq -c \
      --arg pod "$pod" '
        [.[] | select(.pod == $pod)] |
        if length == 1 then .[0] else empty end
      ' "$source_mongo_manifest")"
    [[ -n "$expected" ]] ||
      migration_die "Azure Mongo pod is absent from the preflight identity manifest: $pod"
    expected_uid="$(migration_raw source-manifest 30 1 jq -r \
      '.uid' <<<"$expected")"
    expected_image_id="$(migration_raw source-manifest 30 1 jq -r \
      '.image_id' <<<"$expected")"
    expected_container_id="$(migration_raw source-manifest 30 1 jq -r \
      '.container_id' <<<"$expected")"
    expected_restart_count="$(migration_raw source-manifest 30 1 jq -r \
      '.restart_count' <<<"$expected")"
    expected_runtime="$(migration_raw source-manifest 30 1 jq -c \
      '.runtime | {version,majorMinor,fcv}' <<<"$expected")"
    actual_runtime="$(migration_raw mongo-runtime 30 1 jq -c \
      '{version,majorMinor,fcv}' <<<"$runtime")"
    [[ "$uid" == "$expected_uid" &&
      "$image_id" == "$expected_image_id" &&
      "$container_id" == "$expected_container_id" &&
      "$restart_count" == "$expected_restart_count" &&
      "$actual_runtime" == "$expected_runtime" ]] ||
      migration_die "Azure Mongo pod identity changed after preflight: $pod"
  fi
}

verify_target_mongo_identity() {
  local require_baseline="${1:-true}"
  local desired_image pod_json uid image_id container_id restart_count runtime
  local expected_runtime actual_runtime
  [[ "$require_baseline" == "true" || "$require_baseline" == "false" ]] ||
    migration_die "target Mongo identity validation mode is invalid"
  desired_image="$(kube_capture oci target-mongo-identity 30 2 \
    get statefulset gaming-auth-mongo-depl -n "$OCI_K8S_NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}')"
  [[ "$desired_image" == "$MONGO_REVIEWED_TARGET_IMAGE" ]] ||
    migration_die "OCI Mongo desired image drifted from the reviewed release"
  pod_json="$(kube_capture oci target-mongo-identity 30 2 \
    get pod "$target_mongo_pod" -n "$OCI_K8S_NAMESPACE" -o json)"
  migration_raw target-mongo-identity 30 1 jq -e '
    ([.status.conditions[] | select(
      .type == "Ready" and .status == "True"
    )] | length) == 1
  ' <<<"$pod_json" >/dev/null ||
    migration_die "OCI Mongo pod changed readiness during migration"
  uid="$(migration_raw target-mongo-identity 30 1 jq -r \
    '.metadata.uid // empty' <<<"$pod_json")"
  image_id="$(migration_raw target-mongo-identity 30 1 jq -r \
    '.status.containerStatuses[0].imageID // empty' <<<"$pod_json")"
  container_id="$(migration_raw target-mongo-identity 30 1 jq -r \
    '.status.containerStatuses[0].containerID // empty' <<<"$pod_json")"
  restart_count="$(migration_raw target-mongo-identity 30 1 jq -r \
    '.status.containerStatuses[0].restartCount // empty' <<<"$pod_json")"
  target_mongo_image_is_reviewed "$image_id" ||
    migration_die "OCI Mongo image drifted from the reviewed ARM64 release"
  runtime="$(mongo_runtime oci "$target_mongo_pod")"
  mongo_runtime_is_reviewed "$runtime" ||
    migration_die "OCI Mongo runtime drifted from version 8.2.12 and FCV 8.2"
  if [[ "$require_baseline" == "true" ]]; then
    [[ "$uid" == "$target_mongo_uid" &&
      "$image_id" == "$target_mongo_image_id" &&
      "$container_id" == "$target_mongo_container_id" &&
      "$restart_count" == "$target_mongo_restart_count" ]] ||
      migration_die "OCI Mongo pod identity changed after preflight"
    expected_runtime="$(migration_raw mongo-runtime 30 1 jq -c \
      '{version,majorMinor,fcv}' <<<"$target_runtime_signature")"
    actual_runtime="$(migration_raw mongo-runtime 30 1 jq -c \
      '{version,majorMinor,fcv}' <<<"$runtime")"
    [[ "$actual_runtime" == "$expected_runtime" ]] ||
      migration_die "OCI Mongo runtime changed after preflight"
  fi
}

verify_source_mongo_stays_ready() {
  local mapping _service _database sts _pod _pvc ready replicas
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _service _database sts _pod _pvc <<<"$mapping"
    replicas="$(kube_capture azure source-mongo-read 30 2 \
      get statefulset "$sts" -n "$AZURE_NAMESPACE" -o jsonpath='{.spec.replicas}')"
    ready="$(kube_capture azure source-mongo-read 30 2 \
      get statefulset "$sts" -n "$AZURE_NAMESPACE" \
      -o jsonpath='{.status.readyReplicas}')"
    [[ "$replicas" == "1" && "$ready" == "1" ]] ||
      migration_die "Azure Mongo StatefulSet changed during freeze: $sts"
    verify_source_mongo_identity "$_pod"
  done
}

freeze_azure() {
  local already_frozen=0
  applications_are_zero azure && already_frozen=1
  freeze_ingress azure
  migration_failure_hook azure-freeze
  if [[ "$already_frozen" == "1" ]]; then
    verify_frozen_source_queues
  else
    drain_queues azure
  fi
  migration_failure_hook source-queue-drain
  freeze_applications azure
  verify_source_mongo_stays_ready
}

database_size_bytes() {
  local provider="$1"
  local pod="$2"
  local database="$3"
  mongo_eval "$provider" "$pod" "
    const result=db.getSiblingDB('${database}').stats(1);
    if (result.ok !== 1) throw new Error('stats failed');
    print(Math.ceil(
      (result.dataSize || 0) + (result.indexSize || result.totalIndexSize || 0)
    ));
  "
}

runner_capacity_gate() {
  local total=0 mapping _service database _sts pod _pvc bytes available required
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _service database _sts pod _pvc <<<"$mapping"
    bytes="$(database_size_bytes azure "$pod" "$database")"
    [[ "$bytes" =~ ^[0-9]+$ ]] ||
      migration_die "invalid source size for $database"
    total=$((total + bytes))
  done
  available="$(
    migration_raw runner-capacity 30 1 df -Pk "$WORK_DIR" |
      awk 'NR == 2 {print $4 * 1024}'
  )"
  [[ "$available" =~ ^[0-9]+$ ]] ||
    migration_die "runner free capacity is unreadable"
  required=$((total * RUNNER_CAPACITY_MULTIPLIER + RUNNER_CAPACITY_RESERVE_BYTES))
  (( available >= required )) ||
    migration_die "runner capacity gate rejected all-eight encrypted transport staging"
  printf '%s' "$required" >"$WORK_DIR/disposable-capacity-bytes"
  migration_failure_hook runner-capacity
}

capture_transfers() {
  local manifest="$WORK_DIR/transfer-manifest.tsv"
  local signature_manifest="$WORK_DIR/signature-manifest.tsv"
  local mapping _service database _sts pod _pvc signature archive
  local cipher_hash signature_hash
  : >"$manifest"
  : >"$signature_manifest"
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _service database _sts pod _pvc <<<"$mapping"
    signature="$signature_dir/${database}.source.json"
    archive="$transport_dir/${database}.archive.gz.age"
    verify_source_mongo_identity "$pod"
    mongo_signature_kube azure "$pod" "$database" "$signature"
    verify_source_mongo_identity "$pod"
    migration_maybe_heartbeat 1
    kube_raw azure mongo-transport "$STREAM_TIMEOUT_SECONDS" 1 \
      exec -n "$AZURE_NAMESPACE" "$pod" -- \
      mongodump --quiet --archive --gzip --db "$database" |
      migration_raw transport-encryption "$STREAM_TIMEOUT_SECONDS" 1 \
        age --encrypt --recipient "$OCI_MIGRATION_AGE_RECIPIENT" \
        --output "$archive"
    local statuses=("${PIPESTATUS[@]}")
    [[ "${statuses[0]}" == "0" && "${statuses[1]}" == "0" && -s "$archive" ]] ||
      migration_die "encrypted compressed transport capture failed for $database"
    verify_source_mongo_identity "$pod"
    migration_maybe_heartbeat 1
    cipher_hash="$(migration_sha256 <"$archive")"
    signature_hash="$(migration_sha256 <"$signature")"
    printf '%s\t%s\t%s\n' "$database" "$cipher_hash" "$signature_hash" >>"$manifest"
    printf '%s\t%s\n' "$database" "$signature_hash" >>"$signature_manifest"
  done
  [[ "$(wc -l <"$manifest" | tr -d ' ')" == "8" ]] ||
    migration_die "transport manifest does not contain all eight databases"
  state_advance source-captured "$(state_boundary_text)" "$(state_recovery_text)" \
    "transfer-manifest-sha256=$(migration_sha256 <"$manifest")" \
    "signature-manifest-sha256=$(migration_sha256 <"$signature_manifest")"
  migration_failure_hook archive-capture
}

wait_disposable_mongo() {
  local attempt
  for attempt in $(seq 1 60); do
    if migration_raw disposable-ping 30 1 \
      docker exec "$disposable_container" mongosh --quiet \
      --eval 'quit(db.adminCommand({ping:1}).ok === 1 ? 0 : 1)' \
      >/dev/null 2>&1; then
      return 0
    fi
    migration_sleep 2
  done
  migration_die "disposable isolated Mongo did not become ready"
}

validate_transfers_disposable() {
  local mapping _service database _sts _pod _pvc archive expected actual
  local disposable_runtime expected_runtime
  disposable_container="betstan-oci-transfer-${OWNER_RUN_ID}-${OWNER_RUN_ATTEMPT}"
  disposable_container="${disposable_container:0:63}"
  disposable_volume="${disposable_container}-data"
  migration_run disposable-image 300 2 docker pull "$target_mongo_image" >/dev/null
  migration_run disposable-volume 60 1 \
    docker volume create "$disposable_volume" >/dev/null
  migration_run disposable-start 60 1 \
    docker run -d --name "$disposable_container" \
    --network none \
    --mount "type=volume,src=$disposable_volume,dst=/data/db" \
    "$target_mongo_image" >/dev/null
  wait_disposable_mongo
  disposable_runtime="$(migration_raw disposable-runtime 30 1 \
    docker exec "$disposable_container" mongosh --quiet --eval '
      const result=db.adminCommand({getParameter:1,featureCompatibilityVersion:1});
      print(JSON.stringify({
        version:db.version(),
        majorMinor:db.version().split(".").slice(0,2).join("."),
        fcv:result.featureCompatibilityVersion.version
      }));
    ' | migration_raw disposable-runtime-json 30 1 jq -c .)"
  expected_runtime="$(migration_raw mongo-runtime 30 1 jq -c \
    '{version,majorMinor,fcv}' <<<"$target_runtime_signature")"
  [[ "$disposable_runtime" == "$expected_runtime" ]] ||
    migration_die "disposable Mongo version/FCV differs from OCI target"
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _service database _sts _pod _pvc <<<"$mapping"
    archive="$transport_dir/${database}.archive.gz.age"
    expected="$signature_dir/${database}.source.json"
    actual="$signature_dir/${database}.disposable.json"
    migration_maybe_heartbeat 1
    migration_raw transport-decryption "$STREAM_TIMEOUT_SECONDS" 1 \
      age --decrypt --identity "$identity_file" "$archive" |
      migration_raw disposable-restore "$STREAM_TIMEOUT_SECONDS" 1 \
        docker exec -i "$disposable_container" \
        mongorestore --quiet --archive --gzip --stopOnError \
          --nsInclude="${database}.*"
    local statuses=("${PIPESTATUS[@]}")
    [[ "${statuses[0]}" == "0" && "${statuses[1]}" == "0" ]] ||
      migration_die "disposable restore rejected transport for $database"
    mongo_signature_docker "$database" "$actual"
    cmp -s "$expected" "$actual" ||
      migration_die "disposable canonical equality failed for $database"
  done
  [[ "$(migration_raw disposable-inventory 30 1 \
    docker exec "$disposable_container" mongosh --quiet --eval '
      const system=new Set(["admin","config","local"]);
      const result=db.adminCommand({listDatabases:1,nameOnly:true});
      print(JSON.stringify(
        result.databases.map(item=>item.name).filter(name=>!system.has(name)).sort()
      ));
    ')" == "$(expected_database_json)" ]] ||
    migration_die "disposable database inventory is not exact"
  migration_failure_hook corrupt-archive
  migration_failure_hook disposable-validation
  migration_run disposable-delete 60 2 docker rm -f "$disposable_container" >/dev/null
  disposable_container=""
  migration_run disposable-volume-delete 60 2 \
    docker volume rm "$disposable_volume" >/dev/null
  disposable_volume=""
  state_advance transfers-disposable-validated \
    "$(state_boundary_text)" "$(state_recovery_text)"
}

freeze_oci() {
  local already_frozen=0
  local rabbit_replicas rows backlog
  applications_are_zero oci && already_frozen=1
  oci_frozen=1
  freeze_ingress oci
  if [[ "$already_frozen" == "1" ]]; then
    rabbit_replicas="$(kube_capture oci workload-read 30 2 \
      get deployment gaming-rabbitmq-depl -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath='{.spec.replicas}')"
    if [[ "$rabbit_replicas" != "0" ]]; then
      rows="$(rabbit_queue_rows oci)"
      backlog="$(awk '{sum += $2 + $3} END {print sum+0}' <<<"$rows")"
      [[ "$backlog" == "0" ]] ||
        migration_die "closed OCI retry has a RabbitMQ backlog"
    fi
  else
    drain_queues oci
  fi
  migration_failure_hook target-queue-drain
  freeze_applications oci
  if [[ "$(kube_capture oci workload-read 30 2 \
    get deployment gaming-rabbitmq-depl -n "$OCI_K8S_NAMESPACE" \
    -o jsonpath='{.spec.replicas}')" != "0" ]]; then
    rows="$(rabbit_queue_rows oci)"
    backlog="$(awk '{sum += $2 + $3} END {print sum+0}' <<<"$rows")"
    [[ "$backlog" == "0" ]] || migration_die "OCI RabbitMQ backlog is not zero"
  fi
  state_advance oci-writers-frozen \
    "$(state_boundary_text)" "$(state_recovery_text)"
  migration_failure_hook oci-freeze
}

drop_target_databases() {
  local inventory mapping _service database _sts _pod _pvc result
  verify_target_mongo_identity
  inventory="$(mongo_non_system_databases oci "$target_mongo_pod")"
  migration_raw target-inventory 30 1 jq -e \
    --argjson expected "$(expected_database_json)" '
      all(.[]; $expected | index(.) != null)
    ' <<<"$inventory" >/dev/null ||
    migration_die "OCI contains a non-allowlisted database before destructive replacement"
  state_advance destructive-boundary true true
  migration_failure_hook post-boundary-cancellation
  migration_failure_hook post-boundary-hang
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _service database _sts _pod _pvc <<<"$mapping"
    state_assert_fence
    verify_target_mongo_identity
    migration_failure_hook "before-drop-$database"
    result="$(mongo_eval oci "$target_mongo_pod" \
      "print(JSON.stringify(db.getSiblingDB('${database}').dropDatabase()));")"
    migration_raw drop-result 30 1 jq -e '.ok == 1' <<<"$result" >/dev/null ||
      migration_die "OCI database drop did not succeed: $database"
    [[ "$(mongo_eval oci "$target_mongo_pod" "
      print(db.adminCommand({listDatabases:1,nameOnly:true}).databases
        .some(item=>item.name==='${database}'));
    ")" == "false" ]] ||
      migration_die "OCI database remains visible after drop: $database"
    verify_target_mongo_identity
    state_advance "dropped-$database" true true
    migration_failure_hook "after-drop-$database"
  done
}

restore_target_databases() {
  local mapping _service database _sts _pod _pvc archive
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _service database _sts _pod _pvc <<<"$mapping"
    archive="$transport_dir/${database}.archive.gz.age"
    state_assert_fence
    verify_target_mongo_identity
    migration_failure_hook "before-restore-$database"
    migration_maybe_heartbeat 1
    migration_raw transport-decryption "$STREAM_TIMEOUT_SECONDS" 1 \
      age --decrypt --identity "$identity_file" "$archive" |
      kube_raw oci target-restore "$STREAM_TIMEOUT_SECONDS" 1 \
        exec -i -n "$OCI_K8S_NAMESPACE" "$target_mongo_pod" -- \
        mongorestore --quiet --archive --gzip --stopOnError \
          --nsInclude="${database}.*"
    local statuses=("${PIPESTATUS[@]}")
    [[ "${statuses[0]}" == "0" && "${statuses[1]}" == "0" ]] ||
      migration_die "OCI restore failed for $database"
    verify_target_mongo_identity
    state_advance "restored-$database" true true
    migration_failure_hook "after-restore-$database"
  done
}

verify_target_exact() {
  local inventory mapping _service database _sts _pod _pvc expected actual
  local signature_hash source_aggregate target_aggregate
  local signature_args=()
  local target_manifest="$WORK_DIR/target-signature-manifest.tsv"
  : >"$target_manifest"
  verify_target_mongo_identity
  inventory="$(mongo_non_system_databases oci "$target_mongo_pod")"
  [[ "$inventory" == "$(expected_database_json)" ]] ||
    migration_die "OCI application database inventory is not the exact eight-name set"
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _service database _sts _pod _pvc <<<"$mapping"
    expected="$signature_dir/${database}.source.json"
    actual="$signature_dir/${database}.target.json"
    verify_target_mongo_identity
    mongo_signature_kube oci "$target_mongo_pod" "$database" "$actual"
    verify_target_mongo_identity
    cmp -s "$expected" "$actual" ||
      migration_die "OCI DB/collection/document/index/validator/options equality failed: $database"
    signature_hash="$(migration_sha256 <"$actual")"
    signature_args+=("signature-$database=$signature_hash")
    printf '%s\t%s\n' "$database" "$signature_hash" >>"$target_manifest"
  done
  source_aggregate="$(state_value signature-manifest-sha256)"
  target_aggregate="$(migration_sha256 <"$target_manifest")"
  [[ "$source_aggregate" =~ ^[0-9a-f]{64}$ &&
    "$target_aggregate" == "$source_aggregate" ]] ||
    migration_die "aggregate source/target signature parity failed"
  verify_target_mongo_identity
  state_advance target-exactly-validated true true \
    "database-count=8" \
    "logical-parity=true" \
    "target-signature-manifest-sha256=$target_aggregate" \
    "${signature_args[@]}"
}

restore_oci_baseline() {
  local service replicas ingress rabbit
  rabbit="$(baseline_value "$oci_baseline" rabbitmq)"
  scale_deployment oci "$OCI_K8S_NAMESPACE" gaming-rabbitmq-depl "$rabbit"
  if (( rabbit > 0 )); then
    kube_run oci rabbitmq-rollout 600 1 \
      rollout status deployment/gaming-rabbitmq-depl \
      -n "$OCI_K8S_NAMESPACE" --timeout=9m
  fi
  for service in "${APP_SERVICES[@]}"; do
    replicas="$(baseline_value "$oci_baseline" "$service")"
    scale_deployment oci "$OCI_K8S_NAMESPACE" "gaming-${service}-depl" "$replicas"
    if (( replicas > 0 )); then
      kube_run oci workload-rollout 600 1 \
        rollout status "deployment/gaming-${service}-depl" \
        -n "$OCI_K8S_NAMESPACE" --timeout=9m
    fi
  done
  set_http_write_fence_config false
  ingress="$(baseline_value "$oci_baseline" ingress)"
  scale_deployment oci ingress-nginx ingress-nginx-controller "$ingress"
  if (( ingress > 0 )); then
    kube_run oci ingress-rollout 600 1 \
      rollout status deployment/ingress-nginx-controller \
      -n ingress-nginx --timeout=9m
  fi
  oci_frozen=0
}

close_oci() {
  freeze_ingress oci
  set_http_write_fence_config true
  freeze_applications oci
  scale_deployment oci "$OCI_K8S_NAMESPACE" gaming-rabbitmq-depl 0
  wait_deployment_zero oci "$OCI_K8S_NAMESPACE" gaming-rabbitmq-depl \
    app=gaming-rabbitmq
  oci_frozen=1
}

recreate_rabbitmq_and_restart() {
  local service replicas ingress rows count names expected backlog bad
  state_assert_fence
  verify_target_mongo_identity
  scale_deployment oci "$OCI_K8S_NAMESPACE" gaming-rabbitmq-depl 0
  wait_deployment_zero oci "$OCI_K8S_NAMESPACE" gaming-rabbitmq-depl \
    app=gaming-rabbitmq
  replicas="$(baseline_value "$oci_baseline" rabbitmq)"
  [[ "$replicas" == "1" ]] ||
    migration_die "OCI RabbitMQ baseline must be exactly one replica"
  scale_deployment oci "$OCI_K8S_NAMESPACE" gaming-rabbitmq-depl 1
  kube_run oci rabbitmq-rollout 600 1 \
    rollout status deployment/gaming-rabbitmq-depl \
    -n "$OCI_K8S_NAMESPACE" --timeout=9m
  unlock_rabbitmq_writes
  state_advance rabbitmq-recreated true true "rabbitmq-write-lock=false"
  migration_failure_hook rabbitmq-recreate

  for service in "${BACKEND_SERVICES[@]}" client; do
    state_assert_fence
    verify_target_mongo_identity
    replicas="$(baseline_value "$oci_baseline" "$service")"
    [[ "$replicas" =~ ^[1-9][0-9]*$ ]] ||
      migration_die "OCI successful baseline requires active $service replicas"
    scale_deployment oci "$OCI_K8S_NAMESPACE" "gaming-${service}-depl" "$replicas"
    kube_run oci workload-rollout 600 1 \
      rollout status "deployment/gaming-${service}-depl" \
      -n "$OCI_K8S_NAMESPACE" --timeout=9m
    state_advance "restarted-$service" true true
    migration_failure_hook "restart-$service"
  done

  rows="$(rabbit_queue_rows oci)"
  count="$(awk 'NF {count++} END {print count+0}' <<<"$rows")"
  names="$(awk '{print $1}' <<<"$rows" | LC_ALL=C sort)"
  expected="$(LC_ALL=C sort "$OCI_RABBITMQ_BASELINE_FILE")"
  backlog="$(awk '{sum += $2 + $3} END {print sum+0}' <<<"$rows")"
  bad="$(awk '$4 < 1 {bad++} END {print bad+0}' <<<"$rows")"
  [[ "$count" == "17" && "$names" == "$expected" &&
    "$backlog" == "0" && "$bad" == "0" ]] ||
    migration_die "OCI RabbitMQ is not exact after sequential consumer restart"
  lock_rabbitmq_writes

  ingress="$(baseline_value "$oci_baseline" ingress)"
  [[ "$ingress" =~ ^[1-9][0-9]*$ ]] ||
    migration_die "OCI ingress baseline must be active for validation"
  state_assert_fence
  verify_target_mongo_identity
  [[ "$(state_optional_value http-write-fence)" == "true" &&
    "$(http_write_fence_config_status)" == "true" ]] ||
    migration_die "HTTP mutation fence is absent before ingress activation"
  scale_deployment oci ingress-nginx ingress-nginx-controller "$ingress"
  kube_run oci ingress-rollout 600 1 \
    rollout status deployment/ingress-nginx-controller \
    -n ingress-nginx --timeout=9m
  wait_http_write_fence_runtime true
  migration_failure_hook http-write-fence-runtime
  state_advance awaiting-protected-health true true \
    "http-write-fence=true"
}

verify_final_exact_state() {
  local mapping _service database _sts _pod _pvc actual expected
  local service replicas desired ingress rows names expected_names count backlog bad
  local inventory ingress_state
  target_mongo_pod="$(kube_capture oci target-pod 30 2 \
    get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo \
    -o jsonpath='{.items[0].metadata.name}')"
  verify_target_mongo_identity
  inventory="$(mongo_non_system_databases oci "$target_mongo_pod")"
  [[ "$inventory" == "$(expected_database_json)" ]] ||
    migration_die "final OCI database inventory is not exact"
  mkdir -p "$signature_dir"
  for mapping in "${DATABASE_MAPPINGS[@]}"; do
    IFS='|' read -r _service database _sts _pod _pvc <<<"$mapping"
    actual="$signature_dir/${database}.final.json"
    mongo_signature_kube oci "$target_mongo_pod" "$database" "$actual"
    expected="$(state_value "signature-$database")"
    [[ -n "$expected" && "$(migration_sha256 <"$actual")" == "$expected" ]] ||
      migration_die "final canonical signature differs for $database"
  done
  for service in "${APP_SERVICES[@]}"; do
    replicas="$(baseline_value "$oci_baseline" "$service")"
    desired="$(kube_capture oci final-workload 30 2 \
      get deployment "gaming-${service}-depl" -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath='{.spec.replicas}|{.status.availableReplicas}')"
    [[ "$desired" == "$replicas|$replicas" ]] ||
      migration_die "final OCI deployment replicas differ: $service"
  done
  ingress="$(baseline_value "$oci_baseline" ingress)"
  ingress_state="$(kube_capture oci final-ingress 30 2 \
    get deployment ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.spec.replicas}|{.status.availableReplicas}')"
  [[ "$ingress_state" == "$ingress|$ingress" ]] ||
    migration_die "final OCI ingress replicas differ"
  rows="$(rabbit_queue_rows oci)"
  names="$(awk '{print $1}' <<<"$rows" | LC_ALL=C sort)"
  expected_names="$(LC_ALL=C sort "$OCI_RABBITMQ_BASELINE_FILE")"
  count="$(awk 'NF {count++} END {print count+0}' <<<"$rows")"
  backlog="$(awk '{sum += $2 + $3} END {print sum+0}' <<<"$rows")"
  bad="$(awk '$4 < 1 {bad++} END {print bad+0}' <<<"$rows")"
  [[ "$count" == "17" && "$names" == "$expected_names" &&
    "$backlog" == "0" && "$bad" == "0" ]] ||
    migration_die "final OCI RabbitMQ state differs"
  verify_target_mongo_identity
}

ensure_azure_frozen() {
  freeze_ingress azure
  freeze_applications azure
  verify_source_mongo_stays_ready
}

freeze_azure_after_commit() {
  freeze_ingress azure
  freeze_applications azure
}

cleanup() {
  local status="$1"
  [[ "$cleanup_running" == "0" ]] || exit "$status"
  cleanup_running=1
  trap - EXIT INT TERM
  set +e
  local cleanup_failed=0
  local current_phase=""
  local live_http_fence=""
  if [[ -n "$disposable_container" ]]; then
    migration_raw disposable-delete 60 2 \
      docker rm -f "$disposable_container" >/dev/null 2>&1 ||
      cleanup_failed=1
  fi
  if [[ -n "$disposable_volume" ]]; then
    migration_raw disposable-volume-delete 60 2 \
      docker volume rm "$disposable_volume" >/dev/null 2>&1 ||
      cleanup_failed=1
  fi
  if [[ "$operation_success" != "1" && "$state_initialized" == "1" ]]; then
    current_phase="${last_committed_phase:-$(state_value phase 2>/dev/null || true)}"
    if [[ "$state_boundary" == "1" ]]; then
      case "$current_phase" in
        cutover-committed | cutover-forward-recovery)
          freeze_azure_after_commit || cleanup_failed=1
          if live_http_fence="$(http_write_fence_config_status)"; then
            state_advance cutover-forward-recovery true false \
              "http-write-fence=$live_http_fence" || cleanup_failed=1
          else
            cleanup_failed=1
          fi
          ;;
        completed)
          freeze_azure_after_commit || cleanup_failed=1
          ;;
        *)
          close_oci || cleanup_failed=1
          ensure_azure_frozen || cleanup_failed=1
          state_advance recovery-required true true \
            "http-write-fence=true" || cleanup_failed=1
          ;;
      esac
    else
      local baseline_restore_failed=0
      if [[ "$oci_frozen" == "1" ]]; then
        restore_oci_baseline || baseline_restore_failed=1
      fi
      ensure_azure_frozen || baseline_restore_failed=1
      if [[ "$baseline_restore_failed" == "0" ]]; then
        state_advance failed-before-destructive-boundary false false \
          "http-write-fence=false" ||
          cleanup_failed=1
        state_release || cleanup_failed=1
      else
        close_oci || cleanup_failed=1
        state_advance pre-destructive-recovery-required false true \
          "http-write-fence=true" ||
          cleanup_failed=1
        cleanup_failed=1
      fi
    fi
    state_write_summary || cleanup_failed=1
  fi
  rm -rf "$WORK_DIR"
  if [[ "$cleanup_failed" == "1" && "$status" == "0" ]]; then
    status=1
  fi
  exit "$status"
}

validate_inputs() {
  [[ "$MODE" == "replace" || "$MODE" == "finalize-success" ||
    "$MODE" == "fail-closed" || "$MODE" == "status" ]] ||
    migration_die "usage: $0 {replace|finalize-success|fail-closed|status}"
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    migration_die "SOURCE_SHA must be a complete lowercase commit SHA"
  [[ "$REPLACE_OCI_DATA" == "true" ]] ||
    migration_die "REPLACE_OCI_DATA must be exactly true"
  migration_safe_id "$MIGRATION_ID" ||
    migration_die "MIGRATION_ID is invalid"
  [[ "$OWNER_RUN_ID" == "local" || "$OWNER_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
    migration_die "owner run ID is invalid"
  [[ "$OWNER_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] ||
    migration_die "owner run attempt is invalid"
  [[ -n "$RUNNER_TEMP" && -n "$WORK_DIR" ]] ||
    migration_die "RUNNER_TEMP and an ephemeral WORK_DIR are required"
  mkdir -p "$WORK_DIR"
  WORK_DIR="$(cd "$WORK_DIR" && pwd -P)"
  case "$WORK_DIR/" in
    "$(cd "$RUNNER_TEMP" && pwd -P)/"*) ;;
    *) migration_die "transport WORK_DIR must remain under RUNNER_TEMP" ;;
  esac
  [[ -f "$AZURE_KUBECONFIG" && -f "$OCI_KUBECONFIG" &&
    "$AZURE_KUBECONFIG" != "$OCI_KUBECONFIG" ]] ||
    migration_die "isolated Azure and OCI kubeconfigs are required"
  [[ -f "$OCI_RABBITMQ_BASELINE_FILE" ]] ||
    migration_die "verified exact RabbitMQ baseline is required"
  [[ "$(LC_ALL=C sort -u "$OCI_RABBITMQ_BASELINE_FILE" | wc -l | tr -d ' ')" == "17" ]] ||
    migration_die "RabbitMQ baseline must contain exactly 17 unique queues"
  migration_is_positive_int "$COMMAND_TIMEOUT_SECONDS" ||
    migration_die "command timeout must be positive"
  migration_is_positive_int "$STREAM_TIMEOUT_SECONDS" ||
    migration_die "stream timeout must be positive"
  migration_is_positive_int "$MONGO_VALIDATION_TIMEOUT_SECONDS" ||
    migration_die "Mongo validation timeout must be positive"
  migration_is_positive_int "$QUEUE_DRAIN_ATTEMPTS" ||
    migration_die "queue drain attempts must be positive"
  migration_is_positive_int "$QUEUE_DRAIN_SLEEP_SECONDS" ||
    migration_die "queue drain sleep must be positive"
  migration_is_positive_int "$RUNNER_CAPACITY_MULTIPLIER" ||
    migration_die "runner capacity multiplier must be positive"
  migration_is_positive_int "$RUNNER_CAPACITY_RESERVE_BYTES" ||
    migration_die "runner capacity reserve must be positive"
  [[ "$AZURE_CLUSTER_FINGERPRINT" =~ ^[0-9a-f]{64}$ &&
    "$OCI_CLUSTER_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] ||
    migration_die "cluster fingerprints are required"
  [[ "$AZURE_CLUSTER_FINGERPRINT" == "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" ]] ||
    migration_die "Azure resource fingerprint differs from the approved cluster"
  local actual_oci_fingerprint
  actual_oci_fingerprint="$(migration_fingerprint "$OCI_EXPECTED_CLUSTER_OCID")"
  [[ "$actual_oci_fingerprint" == "$OCI_CLUSTER_FINGERPRINT" ]] ||
    migration_die "OCI runtime fingerprint differs from provenance"
  [[ -f "$SIGNATURE_SCRIPT" && -x "$STATE_HELPER" &&
    -x "$MIGRATION_BOUNDED_COMMAND" ]] ||
    migration_die "migration helpers are unavailable"
  local command_name
  for command_name in kubectl jq python3 gh git cmp awk sort; do
    migration_require_command "$command_name"
  done
  if [[ "$MODE" == "replace" ]]; then
    migration_require_command age
    migration_require_command docker
    oci_require_vars OCI_MIGRATION_AGE_RECIPIENT OCI_MIGRATION_AGE_IDENTITY
    [[ "$OCI_MIGRATION_AGE_RECIPIENT" == age1* ]] ||
      migration_die "age recipient is invalid"
  fi
  umask 077
  transport_dir="$WORK_DIR/transfers"
  signature_dir="$WORK_DIR/signatures"
  state_dir="$WORK_DIR/state"
  identity_file="$WORK_DIR/age-identity.txt"
  source_mongo_manifest="$state_dir/source-mongo-identities.json"
  mkdir -p "$transport_dir" "$signature_dir" "$state_dir" \
    "$(dirname "$JOURNAL_FILE")" "$(dirname "$SUMMARY_FILE")"
  chmod 700 "$WORK_DIR" "$transport_dir" "$signature_dir" "$state_dir"
  if [[ "$MODE" == "replace" ]]; then
    printf '%s\n' "$OCI_MIGRATION_AGE_IDENTITY" >"$identity_file"
    chmod 600 "$identity_file"
  fi
}

main() {
  local finalize_phase=""
  validate_inputs
  trap 'cleanup $?' EXIT
  trap 'cleanup 130' INT
  trap 'cleanup 143' TERM

  validate_kubeconfig azure "$AZURE_EXPECTED_CLUSTER_SERVER_SHA256"
  validate_kubeconfig oci "" "$OCI_EXPECTED_CLUSTER_OCID"
  kube_run azure namespace-read 30 2 get namespace "$AZURE_NAMESPACE" >/dev/null
  kube_run oci namespace-read 30 2 get namespace "$OCI_K8S_NAMESPACE" >/dev/null

  case "$MODE" in
    replace)
      validate_source_topology
      azure_baseline="$(baseline_capture azure)"
      oci_baseline="$(baseline_capture oci)"
      state_acquire
      state_advance azure-inspected \
        "$(state_boundary_text)" "$(state_recovery_text)" \
        "target-mongo-pod-uid=$target_mongo_uid" \
        "target-mongo-image-id=$target_mongo_image_id" \
        "target-mongo-container-id=$target_mongo_container_id" \
        "target-mongo-restart-count=$target_mongo_restart_count" \
        "target-mongo-runtime=$target_runtime_signature" \
        "source-mongo-manifest-sha256=$(migration_sha256 <"$source_mongo_manifest")" \
        "source-mongo-identities=$(migration_raw source-manifest 30 1 \
          jq -c . "$source_mongo_manifest")"
      freeze_azure
      state_advance azure-writers-frozen \
        "$(state_boundary_text)" "$(state_recovery_text)"
      runner_capacity_gate
      capture_transfers
      validate_transfers_disposable
      freeze_oci
      install_http_write_fence
      unlock_target_writes_for_retry
      verify_source_mongo_stays_ready
      drop_target_databases
      restore_target_databases
      verify_target_exact
      verify_target_mongo_identity
      lock_target_writes
      recreate_rabbitmq_and_restart
      state_write_summary
      rm -rf "$WORK_DIR"
      operation_success=1
      trap - EXIT INT TERM
      migration_log \
        "oci_migration_replace=PASS databases=8 azure_writers=frozen state=awaiting-protected-health"
      ;;
    finalize-success)
      state_load_owned
      finalize_phase="$(state_value phase)"
      target_mongo_pod="$(kube_capture oci target-pod 30 2 \
        get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo \
        -o jsonpath='{.items[0].metadata.name}')"
      [[ -n "$target_mongo_pod" ]] ||
        migration_die "OCI Mongo pod is missing for cutover finalization"
      case "$finalize_phase" in
        awaiting-protected-health)
          restore_source_mongo_manifest_from_state true
          ensure_azure_frozen
          target_mongo_uid="$(state_value target-mongo-pod-uid)"
          target_mongo_image_id="$(state_value target-mongo-image-id)"
          target_mongo_container_id="$(state_value target-mongo-container-id)"
          target_mongo_restart_count="$(state_value target-mongo-restart-count)"
          target_runtime_signature="$(state_value target-mongo-runtime)"
          [[ "$target_mongo_uid" =~ ^[a-z0-9-]+$ ]] ||
            migration_die "persisted OCI Mongo pod UID is invalid"
          target_mongo_image_is_reviewed "$target_mongo_image_id" ||
            migration_die "persisted OCI Mongo image identity is invalid"
          [[ "$target_mongo_container_id" =~ ^[a-z0-9+.-]+://[a-zA-Z0-9._:-]+$ &&
            "$target_mongo_restart_count" =~ ^[0-9]+$ ]] ||
            migration_die "persisted OCI Mongo container identity is invalid"
          mongo_runtime_is_reviewed "$target_runtime_signature" ||
            migration_die "persisted OCI Mongo runtime identity is invalid"
          verify_target_mongo_identity true
          verify_cutover_write_locks
          verify_final_exact_state
          verify_target_mongo_identity true
          verify_cutover_write_locks
          state_advance cutover-committed true false \
            "mongo-write-lock=true" "rabbitmq-write-lock=true" \
            "http-write-fence=true"
          ;;
        cutover-committed | cutover-forward-recovery)
          freeze_azure_after_commit
          verify_target_mongo_identity false
          ;;
        completed)
          freeze_azure_after_commit
          verify_target_mongo_identity false
          [[ "$(target_write_lock_status)" == "false" &&
            "$(rabbitmq_write_permission)" == ".*" &&
            "$(state_optional_value http-write-fence)" == "false" &&
            "$(http_write_fence_config_status)" == "false" &&
            "$(http_write_fence_runtime_status)" == "false" ]] ||
            migration_die "completed cutover retained a write lock"
          if [[ "$(state_lock_value state)" == "active" ]]; then
            state_release
          else
            [[ "$(state_lock_value state)" == "released" ]] ||
              migration_die "completed cutover lock state is invalid"
          fi
          state_write_summary
          rm -rf "$WORK_DIR"
          operation_success=1
          trap - EXIT INT TERM
          migration_log \
            "oci_migration_finalize=PASS databases=8 recovery_required=false"
          exit 0
          ;;
        *)
          migration_die "migration is not in a forward finalization phase"
          ;;
      esac
      unlock_target_writes
      migration_failure_hook mongo-write-unlocked
      unlock_rabbitmq_writes
      migration_failure_hook rabbitmq-write-unlocked
      remove_http_write_fence
      migration_failure_hook http-write-fence-removed
      state_advance completed true false \
        "mongo-write-lock=false" "rabbitmq-write-lock=false" \
        "http-write-fence=false"
      state_release
      state_write_summary
      rm -rf "$WORK_DIR"
      operation_success=1
      trap - EXIT INT TERM
      migration_log \
        "oci_migration_finalize=PASS databases=8 recovery_required=false"
      ;;
    fail-closed)
      state_load_owned
      restore_source_mongo_manifest_from_state false
      if [[ "$state_boundary" == "1" ]]; then
        case "$(state_value phase)" in
          cutover-committed | cutover-forward-recovery)
            freeze_azure_after_commit
            state_advance cutover-forward-recovery true false \
              "http-write-fence=$(http_write_fence_config_status)"
            ;;
          completed)
            freeze_azure_after_commit
            ;;
          *)
            close_oci
            ensure_azure_frozen
            state_advance recovery-required true true \
              "http-write-fence=true"
            ;;
        esac
      else
        restore_oci_baseline
        ensure_azure_frozen
        state_advance failed-before-destructive-boundary false false \
          "http-write-fence=false"
        if [[ "$(state_lock_value state)" == "active" ]]; then
          state_release
        fi
      fi
      state_write_summary
      rm -rf "$WORK_DIR"
      operation_success=1
      trap - EXIT INT TERM
      migration_log \
        "oci_migration_fail_closed=PASS destructive_boundary=$state_boundary"
      ;;
    status)
      state_load_owned
      state_write_summary
      rm -rf "$WORK_DIR"
      operation_success=1
      trap - EXIT INT TERM
      ;;
  esac
}

main
