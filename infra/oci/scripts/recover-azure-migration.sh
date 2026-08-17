#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=migration-common.sh
source "$SCRIPT_DIR/migration-common.sh"

AZURE_KUBECONFIG="${AZURE_KUBECONFIG:-}"
AZURE_NAMESPACE="${AZURE_NAMESPACE:-default}"
AZURE_CLUSTER_FINGERPRINT="${AZURE_ACTUAL_CLUSTER_RESOURCE_ID_SHA256:-}"
AZURE_EXPECTED_CLUSTER_SERVER_SHA256="${AZURE_EXPECTED_CLUSTER_SERVER_SHA256:-}"
REPOSITORY="${GITHUB_REPOSITORY:-}"
STATE_CONFIGMAP="${MIGRATION_STATE_CONFIGMAP:-betstan-oci-migration-journal}"
LOCK_CONFIGMAP="${MIGRATION_LOCK_CONFIGMAP:-betstan-oci-migration-lock}"
STALE_HEARTBEAT_SECONDS="${MIGRATION_STALE_HEARTBEAT_SECONDS:-3600}"
STARTUP_GRACE_SECONDS="${MIGRATION_STARTUP_GRACE_SECONDS:-600}"
RESULT_FILE="${RECOVERY_RESULT_FILE:-recovery-result.env}"
EVIDENCE_FILE="${RECOVERY_EVIDENCE_FILE:-recovery-evidence.env}"
COMMAND_TIMEOUT_SECONDS="${RECOVERY_COMMAND_TIMEOUT_SECONDS:-120}"
APP_SERVICES=(auth bet backoffice event gamemaster moderation resulting slip client)

write_result() {
  local safe_to_stop="$1"
  local defer="$2"
  local reason="$3"
  local cancelled_run_id="${4:-}"
  mkdir -p "$(dirname "$RESULT_FILE")" "$(dirname "$EVIDENCE_FILE")"
  printf '%s\n' \
    "safe_to_stop=$safe_to_stop" \
    "defer=$defer" \
    "reason=$reason" \
    "cancelled_run_id=$cancelled_run_id" >"$RESULT_FILE"
  printf '%s\n' \
    "timestamp=$(migration_iso8601)" \
    "cluster_fingerprint=$AZURE_CLUSTER_FINGERPRINT" \
    "safe_to_stop=$safe_to_stop" \
    "defer=$defer" \
    "reason=$reason" \
    "cancelled_run_id=$cancelled_run_id" >"$EVIDENCE_FILE"
}

simulate() {
  local scenario="${RECOVERY_SIMULATION_SCENARIO:-idle}"
  case "$scenario" in
    approval-wait | active-fresh | missing-heartbeat)
      write_result false true "$scenario"
      ;;
    stale-heartbeat)
      write_result true false stale-run-cancelled 4242
      ;;
    concurrent-recovery)
      write_result false true duplicate-collapsed
      ;;
    idle | completed-failure)
      write_result true false azure-frozen
      ;;
    *)
      migration_die "unknown recovery simulation scenario: $scenario"
      ;;
  esac
}

if [[ "${RECOVERY_SIMULATION:-0}" == "1" ]]; then
  simulate
  exit 0
fi

validate_inputs() {
  [[ -f "$AZURE_KUBECONFIG" ]] ||
    migration_die "isolated Azure kubeconfig is required"
  [[ "$AZURE_CLUSTER_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] ||
    migration_die "exact Azure cluster fingerprint is required"
  [[ "$AZURE_EXPECTED_CLUSTER_SERVER_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    migration_die "exact Azure API server fingerprint is required"
  [[ "$REPOSITORY" == */* ]] ||
    migration_die "GITHUB_REPOSITORY is required"
  migration_is_positive_int "$STALE_HEARTBEAT_SECONDS" ||
    migration_die "stale heartbeat threshold must be positive"
  migration_is_positive_int "$STARTUP_GRACE_SECONDS" ||
    migration_die "startup grace must be positive"
  migration_is_positive_int "$COMMAND_TIMEOUT_SECONDS" ||
    migration_die "recovery command timeout must be positive"
  local command_name
  for command_name in kubectl gh jq python3; do
    migration_require_command "$command_name"
  done
}

validate_kubeconfig() {
  local config server actual_hash
  config="$(kube_capture kubeconfig-read 30 2 \
    config view --raw --minify -o json)"
  server="$(migration_raw kubeconfig-json 30 1 jq -r \
    '.clusters[0].cluster.server // empty' <<<"$config")"
  [[ "$server" == https://* ]] ||
    migration_die "Azure recovery kubeconfig has no HTTPS API server"
  actual_hash="$(migration_fingerprint "$server")"
  [[ "$actual_hash" == "$AZURE_EXPECTED_CLUSTER_SERVER_SHA256" ]] ||
    migration_die "Azure recovery API server fingerprint differs"
}

kube_raw() {
  local classification="$1"
  local timeout_seconds="$2"
  local attempts="$3"
  shift 3
  migration_raw "$classification" "$timeout_seconds" "$attempts" \
    kubectl --kubeconfig "$AZURE_KUBECONFIG" "$@"
}

kube_capture() {
  local classification="$1"
  local timeout_seconds="$2"
  local attempts="$3"
  shift 3
  migration_raw "$classification" "$timeout_seconds" "$attempts" \
    kubectl --kubeconfig "$AZURE_KUBECONFIG" "$@"
}

read_configmap() {
  local name="$1"
  local output="$2"
  local error_file="${output}.error"
  if kube_raw recovery-state-read 30 2 \
      get configmap "$name" -n "$AZURE_NAMESPACE" -o json \
      >"$output" 2>"$error_file"; then
    rm -f "$error_file"
    printf present
    return
  fi
  local error
  error="$(cat "$error_file")"
  rm -f "$output" "$error_file"
  if [[ "$error" == *NotFound* || "$error" == *"not found"* ]]; then
    printf missing
    return
  fi
  migration_die "Azure migration state read failed"
}

active_runs_json() {
  migration_raw github-runs-read 45 2 \
    gh api "repos/$REPOSITORY/actions/workflows/oci-migrate.yml/runs?branch=master&per_page=20"
}

run_age_seconds() {
  local timestamp="$1"
  python3 - "$timestamp" <<'PY'
from datetime import datetime, timezone
import sys

value = sys.argv[1].replace("Z", "+00:00")
created = datetime.fromisoformat(value)
print(int((datetime.now(timezone.utc) - created).total_seconds()))
PY
}

cancel_stale_run() {
  local run_id="$1"
  local attempt="$2"
  local document status
  if ! migration_raw github-run-cancel 45 1 \
      gh api --method POST "repos/$REPOSITORY/actions/runs/$run_id/cancel" \
      >/dev/null; then
    document="$(migration_raw github-run-read 45 2 \
      gh api "repos/$REPOSITORY/actions/runs/$run_id/attempts/$attempt")"
    status="$(migration_raw github-run-status 30 1 jq -r '.status' <<<"$document")"
    [[ "$status" == "completed" ]] ||
      migration_die "stale run cancellation was not supported or conclusive"
    return
  fi
  for _ in $(seq 1 30); do
    document="$(migration_raw github-run-read 45 2 \
      gh api "repos/$REPOSITORY/actions/runs/$run_id/attempts/$attempt")"
    status="$(migration_raw github-run-status 30 1 jq -r '.status' <<<"$document")"
    [[ "$status" == "completed" ]] && return 0
    migration_sleep 5
  done
  migration_die "stale migration run did not become completed after cancellation"
}

inspect_active_runs() {
  local runs active_count queued_count in_progress_count run_id attempt status created age
  local state_file lock_file state_presence lock_presence heartbeat now heartbeat_age
  local state_owner lock_owner state_attempt lock_attempt state_migration lock_migration
  local state_fence lock_fence lock_state state_fingerprint journal_id lock_journal_id
  local phase sequence boundary recovery_required owner_workflow state_schema lock_schema
  runs="$(active_runs_json)"
  active_count="$(migration_raw github-runs-filter 30 1 jq '
    [.workflow_runs[] | select(
      .path == ".github/workflows/oci-migrate.yml" and
      .head_branch == "master" and
      .head_repository.full_name == "'"$REPOSITORY"'" and
      (.status == "queued" or .status == "in_progress" or
       .status == "waiting" or .status == "pending" or
       .status == "requested")
    )] | length
  ' <<<"$runs")"
  [[ "$active_count" =~ ^[0-9]+$ ]] ||
    migration_die "active migration run count is invalid"
  [[ "$active_count" != "0" ]] || return 0

  queued_count="$(migration_raw github-runs-filter 30 1 jq '
    [.workflow_runs[] | select(
      .path == ".github/workflows/oci-migrate.yml" and
      .head_branch == "master" and
      .head_repository.full_name == "'"$REPOSITORY"'" and
      (.status == "queued" or .status == "waiting" or
       .status == "pending" or .status == "requested")
    )] | length
  ' <<<"$runs")"
  if [[ "$queued_count" != "0" ]]; then
    write_result false true active-approval-or-queue
    return 10
  fi

  in_progress_count="$(migration_raw github-runs-filter 30 1 jq '
    [.workflow_runs[] | select(
      .path == ".github/workflows/oci-migrate.yml" and
      .head_branch == "master" and
      .head_repository.full_name == "'"$REPOSITORY"'" and
      .status == "in_progress"
    )] | length
  ' <<<"$runs")"
  [[ "$in_progress_count" == "1" ]] || {
    write_result false true multiple-active-migrations
    return 10
  }
  read -r run_id attempt status created <<<"$(
    migration_raw github-runs-filter 30 1 jq -r '
      [.workflow_runs[] | select(
        .path == ".github/workflows/oci-migrate.yml" and
        .head_branch == "master" and
        .head_repository.full_name == "'"$REPOSITORY"'" and
        .status == "in_progress"
      )][0] | [.id,.run_attempt,.status,.created_at] | @tsv
    ' <<<"$runs"
  )"
  [[ "$run_id" =~ ^[1-9][0-9]*$ && "$attempt" == "1" &&
    "$status" == "in_progress" ]] ||
    migration_die "active migration identity is invalid"
  age="$(run_age_seconds "$created")"
  state_file="$(dirname "$RESULT_FILE")/azure-journal.json"
  lock_file="$(dirname "$RESULT_FILE")/azure-lock.json"
  state_presence="$(read_configmap "$STATE_CONFIGMAP" "$state_file")"
  lock_presence="$(read_configmap "$LOCK_CONFIGMAP" "$lock_file")"
  if [[ "$state_presence" != "present" || "$lock_presence" != "present" ]]; then
    if (( age <= STARTUP_GRACE_SECONDS )); then
      write_result false true active-startup-grace
    else
      write_result false true active-missing-heartbeat
    fi
    return 10
  fi

  state_owner="$(migration_raw recovery-state 30 1 jq -r '.data["owner-run-id"]' "$state_file")"
  lock_owner="$(migration_raw recovery-state 30 1 jq -r '.data["owner-run-id"]' "$lock_file")"
  state_attempt="$(migration_raw recovery-state 30 1 jq -r '.data["owner-run-attempt"]' "$state_file")"
  lock_attempt="$(migration_raw recovery-state 30 1 jq -r '.data["owner-run-attempt"]' "$lock_file")"
  state_migration="$(migration_raw recovery-state 30 1 jq -r '.data["migration-id"]' "$state_file")"
  lock_migration="$(migration_raw recovery-state 30 1 jq -r '.data["migration-id"]' "$lock_file")"
  state_fence="$(migration_raw recovery-state 30 1 jq -r '.data["fencing-token"]' "$state_file")"
  lock_fence="$(migration_raw recovery-state 30 1 jq -r '.data["fencing-token"]' "$lock_file")"
  lock_state="$(migration_raw recovery-state 30 1 jq -r '.data.state' "$lock_file")"
  state_fingerprint="$(
    migration_raw recovery-state 30 1 jq -r \
      '.data["azure-cluster-fingerprint"]' "$state_file"
  )"
  state_schema="$(migration_raw recovery-state 30 1 jq -r \
    '.data["schema-version"]' "$state_file")"
  lock_schema="$(migration_raw recovery-state 30 1 jq -r \
    '.data["schema-version"]' "$lock_file")"
  journal_id="$(migration_raw recovery-state 30 1 jq -r \
    '.data["journal-id"]' "$state_file")"
  lock_journal_id="$(migration_raw recovery-state 30 1 jq -r \
    '.data["journal-id"]' "$lock_file")"
  owner_workflow="$(migration_raw recovery-state 30 1 jq -r \
    '.data["owner-workflow"]' "$state_file")"
  phase="$(migration_raw recovery-state 30 1 jq -r '.data.phase' "$state_file")"
  sequence="$(migration_raw recovery-state 30 1 jq -r '.data.sequence' "$state_file")"
  boundary="$(migration_raw recovery-state 30 1 jq -r \
    '.data["destructive-boundary"]' "$state_file")"
  recovery_required="$(migration_raw recovery-state 30 1 jq -r \
    '.data["recovery-required"]' "$state_file")"
  [[ "$state_owner" == "$run_id" && "$lock_owner" == "$run_id" &&
    "$state_attempt" == "$attempt" && "$lock_attempt" == "$attempt" &&
    "$state_migration" == "$lock_migration" &&
    "$state_fence" == "$lock_fence" &&
    "$lock_state" == "active" &&
    "$state_fingerprint" == "$AZURE_CLUSTER_FINGERPRINT" &&
    "$state_schema" == "1" && "$lock_schema" == "1" &&
    "$journal_id" == "$lock_journal_id" &&
    "$owner_workflow" == ".github/workflows/oci-migrate.yml" &&
    -n "$phase" && "$sequence" =~ ^[0-9]+$ &&
    ("$boundary" == "true" || "$boundary" == "false") &&
    ("$recovery_required" == "true" || "$recovery_required" == "false") ]] || {
    write_result false true active-lock-or-fence-mismatch
    return 10
  }
  heartbeat="$(migration_raw recovery-state 30 1 jq -r \
    '.data["heartbeat-epoch"]' "$state_file")"
  [[ "$heartbeat" =~ ^[1-9][0-9]*$ ]] || {
    write_result false true active-missing-heartbeat
    return 10
  }
  now="$(migration_epoch)"
  heartbeat_age=$((now - heartbeat))
  if (( heartbeat_age <= STALE_HEARTBEAT_SECONDS )); then
    write_result false true active-fresh-heartbeat
    return 10
  fi

  cancel_stale_run "$run_id" "$attempt"
  printf '%s' "$run_id"
}

wait_deployment_zero() {
  local namespace="$1"
  local deployment="$2"
  local selector="$3"
  local attempt state desired available ready pods
  for attempt in $(seq 1 60); do
    state="$(kube_capture workload-read 30 2 \
      get deployment "$deployment" -n "$namespace" \
      -o jsonpath='{.spec.replicas}|{.status.availableReplicas}|{.status.readyReplicas}')"
    IFS='|' read -r desired available ready <<<"$state"
    available="${available:-0}"
    ready="${ready:-0}"
    pods="$(
      kube_capture pod-read 30 2 get pods -n "$namespace" \
        -l "$selector" -o json |
        migration_raw pod-count 30 1 jq '.items | length'
    )"
    if [[ "$desired" == "0" && "$available" == "0" &&
      "$ready" == "0" && "$pods" == "0" ]]; then
      return 0
    fi
    migration_sleep 5
  done
  migration_die "Azure deployment did not reach zero: $deployment"
}

freeze_azure() {
  local service mongo_count
  kube_raw ingress-freeze "$COMMAND_TIMEOUT_SECONDS" 2 \
    scale deployment ingress-nginx-controller -n ingress-nginx \
    --replicas 0 >/dev/null
  wait_deployment_zero ingress-nginx ingress-nginx-controller \
    app.kubernetes.io/component=controller
  for service in "${APP_SERVICES[@]}"; do
    kube_raw application-freeze "$COMMAND_TIMEOUT_SECONDS" 2 \
      scale deployment "gaming-${service}-depl" -n "$AZURE_NAMESPACE" \
      --replicas 0 >/dev/null
  done
  for service in "${APP_SERVICES[@]}"; do
    wait_deployment_zero "$AZURE_NAMESPACE" "gaming-${service}-depl" \
      "app=gaming-${service}"
  done
  mongo_count="$(
    kube_capture mongo-read 30 2 get statefulsets -n "$AZURE_NAMESPACE" -o json |
      migration_raw mongo-count 30 1 jq '
        [.items[] | select(
          .metadata.name | test(
            "^gaming-(auth|bet|backoffice|event|gamemaster|moderation|resulting|slip)-mongo-depl$"
          )
        ) | select(.spec.replicas == 1 and (.status.readyReplicas // 0) == 1)] |
        length
      '
  )"
  [[ "$mongo_count" == "8" ]] ||
    migration_die "recovery freeze did not preserve all eight Mongo StatefulSets"
}

main() {
  validate_inputs
  validate_kubeconfig
  local cancelled_run_id=""
  set +e
  cancelled_run_id="$(inspect_active_runs)"
  local inspection_status=$?
  set -e
  if [[ "$inspection_status" == "10" ]]; then
    migration_log "azure_migration_recovery=DEFER"
    exit 0
  fi
  [[ "$inspection_status" == "0" ]] ||
    migration_die "active migration inspection failed"
  write_result true false recovery-conclusive "$cancelled_run_id"
  freeze_azure
  write_result true false azure-frozen "$cancelled_run_id"
  migration_log \
    "azure_migration_recovery=PASS azure_apps=frozen azure_mongo_statefulsets=8"
}

main
