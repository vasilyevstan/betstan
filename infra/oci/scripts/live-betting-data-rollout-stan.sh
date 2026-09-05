#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

PHASE="${PHASE:-${1:-}}"
SOURCE_SHA="${SOURCE_SHA:-}"
BUILD_RUN_ID="${BUILD_RUN_ID:-}"
INFRASTRUCTURE_RUN_ID="${INFRASTRUCTURE_RUN_ID:-}"
IMAGE_PROVENANCE_FILE="${IMAGE_PROVENANCE_FILE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-live-data-rollout}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
BATCH_SIZE="${BATCH_SIZE:-100}"
JOB_TIMEOUT_SECONDS="${JOB_TIMEOUT_SECONDS:-1800}"
JOB_TERMINAL_STATE_GRACE_SECONDS="${JOB_TERMINAL_STATE_GRACE_SECONDS:-30}"
RUN_ID="${GITHUB_RUN_ID:-}"
RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}"
BASELINE_SHA256="${BASELINE_SHA256:-}"
BASELINE_RECOVERY_RUN_ID="${BASELINE_RECOVERY_RUN_ID:-0}"
BASELINE_RECOVERY_SOURCE_SHA="${BASELINE_RECOVERY_SOURCE_SHA:-none}"
MAINTENANCE_FENCE_ENFORCED="${MAINTENANCE_FENCE_ENFORCED:-false}"
WRITERS_QUIESCED="${WRITERS_QUIESCED:-false}"
RUNTIME_HELD_FOR_DEPLOY="${RUNTIME_HELD_FOR_DEPLOY:-false}"
OPERATION_LOCK_ENFORCED="${OPERATION_LOCK_ENFORCED:-false}"
OPERATION_LOCK_HANDOFF="${OPERATION_LOCK_HANDOFF:-false}"

services=(event gamemaster moderation resulting bet slip)
created_jobs=()
raw_files=()
job_sequence=0
LAST_JOB_OUTCOME=""
LAST_JOB_POD_COUNT=""
LAST_JOB_POD_PHASE=""
LAST_JOB_CONTAINER_STATE=""
LAST_JOB_CONTAINER_REASON=""
LAST_JOB_EXIT_CODE=""
LAST_JOB_SIGNAL=""

fail() {
  echo "live_betting_data_rollout=FAIL phase=${PHASE:-missing} reason=$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  local job
  for job in "${created_jobs[@]:-}"; do
    [[ -n "$job" ]] || continue
    kubectl delete job "$job" \
      -n "$OCI_K8S_NAMESPACE" \
      --ignore-not-found=true \
      --wait=false \
      --request-timeout=5s >/dev/null 2>&1
  done
  local raw_file
  for raw_file in "${raw_files[@]:-}"; do
    [[ -n "$raw_file" ]] && rm -f -- "$raw_file"
  done
  exit "$status"
}
trap cleanup EXIT

case "$PHASE" in
  dry-run|apply-backfills|apply-slip-index) ;;
  *) fail "phase must be dry-run, apply-backfills, or apply-slip-index" ;;
esac
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "SOURCE_SHA must be a complete lowercase commit SHA"
[[ "$BUILD_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "BUILD_RUN_ID must be a positive integer"
[[ "$INFRASTRUCTURE_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "INFRASTRUCTURE_RUN_ID must be a positive integer"
[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "GITHUB_RUN_ID must be a positive integer"
[[ "$RUN_ATTEMPT" == "1" ]] ||
  fail "only first-attempt runs are accepted"
[[ "$BATCH_SIZE" =~ ^[1-9][0-9]*$ ]] ||
  fail "BATCH_SIZE must be a positive integer"
(( BATCH_SIZE <= 1000 )) ||
  fail "BATCH_SIZE exceeds the reviewed bound"
[[ "$JOB_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
  fail "JOB_TIMEOUT_SECONDS must be a positive integer"
(( JOB_TIMEOUT_SECONDS <= 3600 )) ||
  fail "JOB_TIMEOUT_SECONDS exceeds the reviewed one-hour bound"
[[ "$JOB_TERMINAL_STATE_GRACE_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
  fail "JOB_TERMINAL_STATE_GRACE_SECONDS must be a positive integer"
(( JOB_TERMINAL_STATE_GRACE_SECONDS <= 60 )) ||
  fail "JOB_TERMINAL_STATE_GRACE_SECONDS exceeds the reviewed one-minute bound"
[[ "$OCI_K8S_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  fail "OCI_K8S_NAMESPACE is invalid"
[[ -f "$IMAGE_PROVENANCE_FILE" ]] ||
  fail "IMAGE_PROVENANCE_FILE not found"
[[ -n "$OUTPUT_DIR" && "$OUTPUT_DIR" != "/" && "$OUTPUT_DIR" != "." ]] ||
  fail "OUTPUT_DIR is unsafe"
[[ "$BASELINE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  fail "BASELINE_SHA256 must bind the protected pre-mutation baseline"
[[ "$BASELINE_RECOVERY_RUN_ID" == "0" ||
   "$BASELINE_RECOVERY_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "BASELINE_RECOVERY_RUN_ID must be 0 or an exact recovery run ID"
if [[ "$BASELINE_RECOVERY_RUN_ID" == "0" ]]; then
  [[ "$BASELINE_RECOVERY_SOURCE_SHA" == "none" ]] ||
    fail "normal data rollout cannot carry recovery source authority"
else
  [[ "$BASELINE_RECOVERY_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    fail "recovery data rollout must bind the historical recovery source SHA"
fi
for boolean_name in \
  MAINTENANCE_FENCE_ENFORCED WRITERS_QUIESCED RUNTIME_HELD_FOR_DEPLOY \
  OPERATION_LOCK_ENFORCED OPERATION_LOCK_HANDOFF; do
  [[ "${!boolean_name}" == "true" || "${!boolean_name}" == "false" ]] ||
    fail "$boolean_name must be boolean"
done
[[ "$OPERATION_LOCK_ENFORCED" == "true" ]] ||
  fail "the shared database operation lock must cover every phase"
if [[ "$PHASE" == "dry-run" ]]; then
  [[ "$MAINTENANCE_FENCE_ENFORCED" == "false" &&
     "$WRITERS_QUIESCED" == "false" &&
     "$RUNTIME_HELD_FOR_DEPLOY" == "false" &&
     "$OPERATION_LOCK_HANDOFF" == "false" ]] ||
    fail "dry-run must not claim a maintenance handoff"
else
  [[ "$MAINTENANCE_FENCE_ENFORCED" == "true" &&
     "$WRITERS_QUIESCED" == "true" ]] ||
    fail "mutating phases require a write fence and quiesced writers"
  if [[ "$PHASE" == "apply-slip-index" ]]; then
    [[ "$RUNTIME_HELD_FOR_DEPLOY" == "true" &&
       "$OPERATION_LOCK_HANDOFF" == "true" ]] ||
      fail "the final phase must retain runtime and database locks for deploy"
  else
    [[ "$RUNTIME_HELD_FOR_DEPLOY" == "false" &&
       "$OPERATION_LOCK_HANDOFF" == "false" ]] ||
      fail "backfill-only phase must not retain a deploy handoff"
  fi
fi

for command_name in kubectl jq python3; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command is unavailable: $command_name"
done

mkdir -p "$OUTPUT_DIR/reports"
kubectl get namespace "$OCI_K8S_NAMESPACE" >/dev/null
kubectl get service gaming-shared-mongo-srv \
  -n "$OCI_K8S_NAMESPACE" >/dev/null
if ! OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
    "$SCRIPT_DIR/verify-public-registry-credentials.sh"; then
  fail "public GHCR registry credential validation failed"
fi

image_for_service() {
  local service="$1"
  local matches image_ref
  matches="$(
    awk -F '\t' -v service="$service" '$1 == service { count += 1; value = $3 } END {
      if (count != 1) exit 1
      print value
    }' "$IMAGE_PROVENANCE_FILE"
  )" || fail "missing or duplicate immutable image for $service"
  image_ref="$matches"
  [[ "$image_ref" =~ ^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] ||
    fail "image for $service is not an immutable digest"
  printf '%s' "$image_ref"
}

create_job() {
  local service="$1"
  local command_path="$2"
  local mode="$3"
  local image_ref="$4"
  local job_name="$5"
  local database="gaming_${service}"
  local args
  case "$command_path:$mode" in
    dist/scripts/backfillDataCompatibility.js:dry-run)
      args='
          args:
            - "--batch-size"
            - "'"$BATCH_SIZE"'"'
      ;;
    dist/scripts/backfillDataCompatibility.js:apply)
      args='
          args:
            - "--batch-size"
            - "'"$BATCH_SIZE"'"
            - "--apply"'
      ;;
    dist/scripts/ensureDraftIndexes.js:dry-run)
      args=""
      ;;
    dist/scripts/ensureDraftIndexes.js:apply)
      args='
          args:
            - "--apply"'
      ;;
    dist/scripts/cleanupObsoleteSyntheticEvent.js:dry-run)
      args='
          args:
            - "--mode"
            - "dry-run"'
      ;;
    dist/scripts/cleanupObsoleteSyntheticEvent.js:apply)
      args='
          args:
            - "--mode"
            - "apply"
            - "--confirmation"
            - "REMOVE_OBSOLETE_EVENT:6a623af592af5a95b1d0bb79"'
      ;;
    *)
      fail "unsupported data job command or mode: $command_path/$mode"
      ;;
  esac

  cat <<YAML | kubectl create -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: $job_name
  namespace: $OCI_K8S_NAMESPACE
  labels:
    betstan.io/operation: live-data-rollout
    betstan.io/source-sha: $SOURCE_SHA
    betstan.io/phase: $PHASE
spec:
  backoffLimit: 0
  activeDeadlineSeconds: $JOB_TIMEOUT_SECONDS
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        betstan.io/operation: live-data-rollout
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      nodeSelector:
        kubernetes.io/arch: arm64

      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: data-rollout
          image: $image_ref
          imagePullPolicy: IfNotPresent
          command:
            - node
            - $command_path$args
          env:
            - name: MONGO_URI
              value: "mongodb://gaming-shared-mongo-srv:27017/$database"
            - name: SOURCE_SHA
              value: "$SOURCE_SHA"
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            readOnlyRootFilesystem: true
YAML
}

sleep_before_job_retry() {
  local retry_deadline="$1"
  local now sleep_seconds

  now="$(date +%s)"
  sleep_seconds=$(( retry_deadline - now ))
  (( sleep_seconds > 0 )) || return 0
  (( sleep_seconds <= 2 )) || sleep_seconds=2
  sleep "$sleep_seconds"
}

collect_complete_job_report() {
  local job_name="$1"
  local raw_file="$2"
  local report_deadline="$3"
  local now request_timeout

  while true; do
    now="$(date +%s)"
    (( now < report_deadline )) || break
    request_timeout=$(( report_deadline - now ))
    (( request_timeout <= 10 )) || request_timeout=10
    : >"$raw_file"
    if kubectl logs "job/$job_name" \
        -n "$OCI_K8S_NAMESPACE" \
        --container data-rollout \
        --request-timeout="${request_timeout}s" >"$raw_file" 2>/dev/null; then
      return 0
    fi
    rm -f -- "$raw_file"
    sleep_before_job_retry "$report_deadline"
  done

  rm -f -- "$raw_file"
  return 1
}

wait_for_job_report() {
  local job_name="$1"
  local raw_file="$2"
  local allow_blocked_cleanup="${3:-false}"
  local expected_mode="${4:-}"
  local deadline=$(( $(date +%s) + JOB_TIMEOUT_SECONDS ))
  local job_json="" pod_state="" pod_count="unknown" pod_phase="Unknown"
  local container_state="unknown" container_reason="Unknown"
  local container_exit_code="unknown" container_signal="unknown" job_state=""
  local job_complete job_failure_target job_failed_condition
  local job_deadline_exceeded job_failed_count
  local terminal_failure_observed=false
  local terminal_state_observed_at=0 terminal_state_deadline=0
  local status_deadline request_timeout sleep_seconds now

  [[ "$allow_blocked_cleanup" == "true" ||
     "$allow_blocked_cleanup" == "false" ]] ||
    fail "blocked cleanup report policy is invalid"
  if [[ "$allow_blocked_cleanup" == "true" ]]; then
    [[ "$expected_mode" == "dry-run" || "$expected_mode" == "apply" ]] ||
      fail "blocked cleanup report mode is invalid"
  fi

  while true; do
    if [[ "$terminal_failure_observed" == "true" ]]; then
      status_deadline="$terminal_state_deadline"
    else
      status_deadline="$deadline"
    fi
    now="$(date +%s)"
    (( now < status_deadline )) || break
    request_timeout=$(( status_deadline - now ))
    (( request_timeout <= 10 )) || request_timeout=10
    if ! pod_state="$(
      kubectl get pods \
        -n "$OCI_K8S_NAMESPACE" \
        -l "job-name=$job_name" \
        -o json \
        --request-timeout="${request_timeout}s" 2>/dev/null |
        jq -er '
          def safe:
            if type == "string" and
               test("^[A-Za-z0-9_.:-]+$")
            then .
            else "Unknown"
            end;

          (.items // []) as $items |
          if ($items | length) == 0 then
            ["0", "Missing", "unknown", "PodNotCreated", "unknown", "unknown"]
          elif ($items | length) > 1 then
            [
              ($items | length | tostring),
              "Ambiguous",
              "unknown",
              "MultiplePods",
              "unknown",
              "unknown"
            ]
          else
            $items[0] as $pod |
            ($pod.status.containerStatuses // []) as $statuses |
            if ($statuses | length) == 0 then
              (([
                $pod.status.conditions[]? |
                select(.type == "PodScheduled" and .status == "False")
              ] | first) // {}) as $condition |
              [
                "1",
                (($pod.status.phase // "Unknown") | safe),
                "waiting",
                (($condition.reason // "ContainerNotStarted") | safe),
                "unknown",
                "unknown"
              ]
            elif ($statuses | length) > 1 then
              [
                "1",
                (($pod.status.phase // "Unknown") | safe),
                "unknown",
                "MultipleContainers",
                "unknown",
                "unknown"
              ]
            else
              $statuses[0].state as $state |
              if $state.waiting then
                [
                  "1",
                  (($pod.status.phase // "Unknown") | safe),
                  "waiting",
                  (($state.waiting.reason // "Unknown") | safe),
                  "unknown",
                  "unknown"
                ]
              elif $state.running then
                [
                  "1",
                  (($pod.status.phase // "Unknown") | safe),
                  "running",
                  "Running",
                  "unknown",
                  "unknown"
                ]
              elif $state.terminated then
                [
                  "1",
                  (($pod.status.phase // "Unknown") | safe),
                  "terminated",
                  (($state.terminated.reason // "Unknown") | safe),
                  (
                    if (($state.terminated.exitCode | type) == "number") and
                       ($state.terminated.exitCode >= 0) and
                       ($state.terminated.exitCode == ($state.terminated.exitCode | floor))
                    then ($state.terminated.exitCode | tostring)
                    else "unknown"
                    end
                  ),
                  (
                    if (
                      (($state.terminated.signal // 0) | type) == "number"
                    ) and
                       (($state.terminated.signal // 0) >= 0) and
                       (
                         ($state.terminated.signal // 0) ==
                         (($state.terminated.signal // 0) | floor)
                       )
                    then (($state.terminated.signal // 0) | tostring)
                    else "unknown"
                    end
                  )
                ]
              else
                [
                  "1",
                  (($pod.status.phase // "Unknown") | safe),
                  "unknown",
                  "StateMissing",
                  "unknown",
                  "unknown"
                ]
              end
            end
          end |
          @tsv
        ' 2>/dev/null
    )"; then
      sleep_before_job_retry "$status_deadline"
      continue
    fi
    IFS=$'\t' read -r \
      pod_count pod_phase container_state container_reason \
      container_exit_code container_signal <<<"$pod_state"

    if [[ "$container_state" == "terminated" &&
      "$container_reason" != "Completed" ]]; then
      if [[ "$terminal_failure_observed" == "false" ]]; then
        terminal_failure_observed=true
        terminal_state_observed_at="$(date +%s)"
        terminal_state_deadline=$((
          terminal_state_observed_at + JOB_TERMINAL_STATE_GRACE_SECONDS
        ))
      fi
    fi
    case "$container_reason" in
      ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError|\
      CreateContainerError|RunContainerError|CrashLoopBackOff|\
      PreCreateHookError|PostStartHookError|Unschedulable)
        fail "data job startup failed for $job_name; pod_count=$pod_count pod_phase=$pod_phase container_state=$container_state reason=$container_reason"
        ;;
    esac

    if [[ "$terminal_failure_observed" == "true" ]]; then
      status_deadline="$terminal_state_deadline"
    else
      status_deadline="$deadline"
    fi
    now="$(date +%s)"
    (( now < status_deadline )) || continue
    request_timeout=$(( status_deadline - now ))
    (( request_timeout <= 10 )) || request_timeout=10
    if ! job_json="$(
      kubectl get job "$job_name" \
        -n "$OCI_K8S_NAMESPACE" \
        -o json \
        --request-timeout="${request_timeout}s" 2>/dev/null
    )"; then
      sleep_before_job_retry "$status_deadline"
      continue
    fi
    if ! job_state="$(
      jq -er '
        (.status.conditions // []) as $conditions |
        [
          (any($conditions[];
            .type == "Complete" and .status == "True")),
          (any($conditions[];
            .type == "FailureTarget" and .status == "True")),
          (any($conditions[];
            .type == "Failed" and .status == "True")),
          (any($conditions[];
            (
              .type == "FailureTarget" or
              .type == "Failed"
            ) and
            .status == "True" and
            .reason == "DeadlineExceeded"
          )),
          ((.status.failed // 0) > 0)
        ] |
        @tsv
      ' <<<"$job_json" 2>/dev/null
    )"; then
      sleep_before_job_retry "$status_deadline"
      continue
    fi
    IFS=$'\t' read -r \
      job_complete job_failure_target job_failed_condition \
      job_deadline_exceeded job_failed_count <<<"$job_state"

    if [[ "$job_deadline_exceeded" == "true" ]]; then
      fail "data Job exceeded its active deadline for $job_name"
    fi
    if [[ "$job_complete" == "true" &&
      ("$terminal_failure_observed" == "true" ||
       "$job_failure_target" == "true" ||
       "$job_failed_condition" == "true" ||
       "$job_failed_count" == "true") ]]; then
      fail "data Job reported contradictory completion and failure for $job_name"
    fi
    if [[ ("$job_failure_target" == "true" ||
          "$job_failed_condition" == "true" ||
          "$job_failed_count" == "true") &&
      "$terminal_failure_observed" == "false" ]]; then
      terminal_failure_observed=true
      terminal_state_observed_at="$(date +%s)"
      terminal_state_deadline=$((
        terminal_state_observed_at + JOB_TERMINAL_STATE_GRACE_SECONDS
      ))
    fi
    if [[ "$job_complete" == "true" ]]; then
      collect_complete_job_report "$job_name" "$raw_file" "$deadline" ||
        fail "unable to collect completed job report"
      LAST_JOB_OUTCOME="success"
      LAST_JOB_POD_COUNT=""
      LAST_JOB_POD_PHASE=""
      LAST_JOB_CONTAINER_STATE=""
      LAST_JOB_CONTAINER_REASON=""
      LAST_JOB_EXIT_CODE="0"
      LAST_JOB_SIGNAL="0"
      return 0
    fi

    if [[ "$terminal_failure_observed" == "true" &&
      ("$job_failed_condition" != "true" || "$pod_phase" != "Failed") ]]; then
      # K3s may expose the terminated container before Pod and Job status converge.
      now="$(date +%s)"
      sleep_seconds=$(( terminal_state_deadline - now ))
      (( sleep_seconds > 0 )) || continue
      (( sleep_seconds <= 2 )) || sleep_seconds=2
      sleep "$sleep_seconds"
      continue
    fi
    if [[ "$terminal_failure_observed" == "true" ]]; then
      if ! collect_complete_job_report \
          "$job_name" "$raw_file" "$terminal_state_deadline"; then
        fail "unable to collect complete failed job report for $job_name"
      fi
      if [[ "$allow_blocked_cleanup" == "true" &&
        "$pod_count" == "1" &&
        "$pod_phase" == "Failed" &&
        "$container_state" == "terminated" &&
        "$container_reason" == "Error" &&
        "$container_exit_code" == "1" &&
        "$container_signal" == "0" ]] &&
        validate_blocked_cleanup_report "$raw_file" "$expected_mode"; then
        LAST_JOB_OUTCOME="structured-blocked"
        LAST_JOB_POD_COUNT="$pod_count"
        LAST_JOB_POD_PHASE="$pod_phase"
        LAST_JOB_CONTAINER_STATE="$container_state"
        LAST_JOB_CONTAINER_REASON="$container_reason"
        LAST_JOB_EXIT_CODE="$container_exit_code"
        LAST_JOB_SIGNAL="$container_signal"
        return 0
      fi
      fail "data job failed for $job_name; raw logs were withheld; pod_count=$pod_count pod_phase=$pod_phase container_state=$container_state reason=$container_reason"
    fi

    now="$(date +%s)"
    sleep_seconds=$(( deadline - now ))
    (( sleep_seconds > 0 )) || continue
    (( sleep_seconds <= 5 )) || sleep_seconds=5
    sleep "$sleep_seconds"
  done

  if (( terminal_state_deadline > 0 )); then
    fail "data job terminal state did not converge for $job_name; pod_count=$pod_count pod_phase=$pod_phase container_state=$container_state reason=$container_reason"
  fi
  fail "data job timed out for $job_name; pod_count=$pod_count pod_phase=$pod_phase container_state=$container_state reason=$container_reason"
}

run_job() {
  local service="$1"
  local command_path="$2"
  local mode="$3"
  local raw_file
  local image_ref
  local job_name
  local allow_blocked_cleanup="${4:-false}"

  job_sequence=$((job_sequence + 1))
  job_name="live-data-${service}-${RUN_ID}-${job_sequence}"
  image_ref="$(image_for_service "$service")"
  raw_file="$(mktemp "${TMPDIR:-/tmp}/betstan-live-data.XXXXXX")"
  raw_files+=("$raw_file")
  created_jobs+=("$job_name")
  create_job "$service" "$command_path" "$mode" "$image_ref" "$job_name"
  wait_for_job_report \
    "$job_name" "$raw_file" "$allow_blocked_cleanup" "$mode"
  LAST_RAW_FILE="$raw_file"
  kubectl delete job "$job_name" \
    -n "$OCI_K8S_NAMESPACE" \
    --ignore-not-found=true \
    --wait=false \
    --request-timeout=5s >/dev/null 2>&1 || true
}

sanitize_backfill_report() {
  local raw_file="$1"
  local service="$2"
  local stage="$3"
  local expected_mode="$4"
  local output="$OUTPUT_DIR/reports/${stage}-${service}.json"
  local temporary="${output}.tmp"

  jq -e \
    --arg service "$service" \
    --arg stage "$stage" \
    --arg expected_mode "$expected_mode" '
      def nonnegative_integer:
        type == "number" and . >= 0 and . == floor;
      . as $report |
      select(
        ($report.mode == $expected_mode) and
        ($report.scanned | nonnegative_integer) and
        ($report.matched | nonnegative_integer) and
        ($report.changed | nonnegative_integer) and
        ($report.skipped | nonnegative_integer) and
        ($report.errorCount == 0) and
        ($report.collections | type == "array") and
        ([$report.collections[] |
          (.scanned | nonnegative_integer) and
          (.matched | nonnegative_integer) and
          (.changed | nonnegative_integer) and
          (.skipped | nonnegative_integer) and
          (.errorCount == 0)
        ] | all) and
        ($report.scanned == ([$report.collections[].scanned] | add // 0)) and
        ($report.matched == ([$report.collections[].matched] | add // 0)) and
        ($report.changed == ([$report.collections[].changed] | add // 0)) and
        ($report.skipped == ([$report.collections[].skipped] | add // 0)) and
        (($expected_mode != "dry-run") or $report.changed == 0) and
        (($expected_mode != "apply") or $report.changed == $report.matched) and
        (($service != "slip") or ($report.duplicateDrafts | type == "array"))
      ) |
      {
        kind: "backfill",
        service: $service,
        stage: $stage,
        mode: .mode,
        batchSize: .batchSize,
        scanned: .scanned,
        matched: .matched,
        changed: .changed,
        skipped: .skipped,
        errorCount: .errorCount,
        duplicateDraftGroupCount:
          (if $service == "slip" then (.duplicateDrafts | length) else 0 end),
        collections: [
          .collections[] |
          {
            collection,
            scanned,
            matched,
            changed,
            skipped,
            errorCount
          }
        ]
      }
    ' "$raw_file" >"$temporary" ||
    fail "backfill report contract failed for $service/$stage"
  mv "$temporary" "$output"
  rm -f -- "$raw_file"
  LAST_REPORT="$output"
}

sanitize_index_report() {
  local raw_file="$1"
  local stage="$2"
  local expected_mode="$3"
  local output="$OUTPUT_DIR/reports/${stage}-slip-index.json"
  local temporary="${output}.tmp"

  jq -e \
    --arg stage "$stage" \
    --arg expected_mode "$expected_mode" '
      def nonnegative_integer:
        type == "number" and . >= 0 and . == floor;
      . as $report |
      select(
        ($report.mode == $expected_mode) and
        ($report.ready | type == "boolean") and
        ($report.scanned | nonnegative_integer) and
        ($report.matched | nonnegative_integer) and
        ($report.changed | nonnegative_integer) and
        ($report.skipped | nonnegative_integer) and
        ($report.errorCount | nonnegative_integer) and
        ($report.existingIndex == "missing" or
         $report.existingIndex == "matching" or
         $report.existingIndex == "conflicting") and
        ($report.indexName == "slip_draft_unique_by_kind") and
        ($report.blocking | type == "object") and
        ([$report.blocking[] | nonnegative_integer] | all) and
        (($expected_mode != "dry-run") or $report.changed == 0)
      ) |
      {
        kind: "slip-index",
        service: "slip",
        stage: $stage,
        mode: .mode,
        ready: .ready,
        scanned: .scanned,
        matched: .matched,
        changed: .changed,
        skipped: .skipped,
        errorCount: .errorCount,
        existingIndex: .existingIndex,
        indexName: .indexName,
        blocking: .blocking
      }
    ' "$raw_file" >"$temporary" ||
    fail "Slip index report contract failed for $stage"
  mv "$temporary" "$output"
  rm -f -- "$raw_file"
  LAST_REPORT="$output"
}

project_cleanup_report() {
  local raw_file="$1"
  local stage="$2"
  local expected_mode="$3"
  local output="$4"

  jq -e \
    -s \
    --arg stage "$stage" \
    --arg expected_mode "$expected_mode" \
    --arg target_event_id "6a623af592af5a95b1d0bb79" '
      def nonnegative_integer:
        type == "number" and . >= 0 and . == floor;
      def exact_keys($required; $optional):
        (keys_unsorted) as $actual |
        (($required - $actual) | length) == 0 and
        (($actual - ($required + $optional)) | length) == 0;
      def service:
        if . == "gaming_event" then "event"
        elif . == "gaming_gamemaster" then "gamemaster"
        elif . == "gaming_moderation" then "moderation"
        elif . == "gaming_resulting" then "resulting"
        elif . == "gaming_bet" then "bet"
        elif . == "gaming_slip" then "slip"
        else null
        end;
      def allowed_collection($service; $collection):
        if $service == "event" then
          $collection == "events"
        elif $service == "gamemaster" then
          $collection == "eventarchives"
        elif $service == "moderation" then
          ["bets", "resulteds", "parkedplacebets"] | index($collection) != null
        elif $service == "resulting" then
          [
            "bets",
            "betarchives",
            "finalscoreledgers",
            "livesettlementledgers",
            "pendingmoderationresults",
            "retryrecords"
          ] | index($collection) != null
        elif $service == "bet" then
          ["bets", "pendingbetupdates", "betplacementconflicts"] |
            index($collection) != null
        elif $service == "slip" then
          ["slips", "sliparchives"] | index($collection) != null
        else false
        end;
      def reason_code:
        if . == "event reference" then "event_reference"
        elif . == "event source identity does not match the reviewed fixture" or
             . == "Gamemaster identity does not match the reviewed fixture"
        then "identity_mismatch"
        elif . == "duplicate Gamemaster archive records"
        then "duplicate_tombstone"
        elif . == "Gamemaster archive contains an unrelated or invalid record" or
             . == "Gamemaster tombstone snapshot is invalid" or
             . == "invalid tombstone"
        then "invalid_tombstone"
        else null
        end;
      select(length == 1) |
      .[0] as $report |
      select(
        ($report | type == "object") and
        ($report | exact_keys(
          [
            "mode",
            "targetEventId",
            "state",
            "ready",
            "scanned",
            "matched",
            "changed",
            "errorCount",
            "tombstoneVerified",
            "snapshotDocumentCount",
            "blockers"
          ];
          ["snapshotSha256"]
        )) and
        ($report.mode == $expected_mode) and
        ($report.targetEventId == $target_event_id) and
        ($report.state == "absent" or
         $report.state == "candidate" or
         $report.state == "partial" or
         $report.state == "removed" or
         $report.state == "restored" or
         $report.state == "blocked") and
        ($report.ready | type == "boolean") and
        ($report.scanned | nonnegative_integer) and
        ($report.matched | nonnegative_integer) and
        ($report.changed | nonnegative_integer) and
        ($report.errorCount | nonnegative_integer) and
        ($report.tombstoneVerified | type == "boolean") and
        ($report.snapshotDocumentCount | nonnegative_integer) and
        (($report | has("snapshotSha256") | not) or
         ($report.snapshotSha256 | test("^[0-9a-f]{64}$"))) and
        ($report.blockers | type == "array") and
        ([$report.blockers[] |
          . as $blocker |
          ($blocker | type == "object") and
          ($blocker | exact_keys(
            ["database", "collection", "count", "reason"];
            []
          )) and
          ($blocker.database | service) as $service |
          ($blocker.reason | reason_code) as $reason_code |
          ($service != null) and
          ($reason_code != null) and
          allowed_collection($service; $blocker.collection) and
          ($blocker.count | nonnegative_integer) and
          ($blocker.count > 0)
        ] | all) and
        (
          (
            $report.ready == true and
            $report.state != "blocked" and
            $report.errorCount == 0 and
            ($report.blockers | length) == 0
          ) or
          (
            $report.ready == false and
            $report.state == "blocked" and
            $report.changed == 0 and
            $report.errorCount > 0 and
            $report.errorCount == ($report.blockers | length)
          )
        ) and
        (($expected_mode != "dry-run") or $report.changed == 0)
      ) |
      $report |
      {
        kind: "obsolete-event-cleanup",
        stage: $stage,
        mode,
        targetEventId,
        state,
        ready,
        scanned,
        matched,
        changed,
        errorCount,
        tombstoneVerified,
        snapshotDocumentCount,
        snapshotSha256,
        blockerCount: (.blockers | length),
        blockers: [
          .blockers[] |
          (.database | service) as $service |
          {
            service: $service,
            collection,
            count,
            reasonCode: (.reason | reason_code)
          }
        ]
      }
    ' "$raw_file" >"$output"
}

validate_blocked_cleanup_report() {
  local raw_file="$1"
  local expected_mode="$2"
  local temporary="${raw_file}.sanitized"

  if project_cleanup_report \
      "$raw_file" job-failure-validation "$expected_mode" "$temporary" &&
    jq -e '
      .state == "blocked" and
      .ready == false and
      .changed == 0 and
      .errorCount > 0 and
      .blockerCount > 0
    ' "$temporary" >/dev/null; then
    rm -f -- "$temporary"
    return 0
  fi
  rm -f -- "$temporary"
  return 1
}

sanitize_cleanup_report() {
  local raw_file="$1"
  local stage="$2"
  local expected_mode="$3"
  local output="$OUTPUT_DIR/reports/${stage}-obsolete-event.json"
  local temporary="${output}.tmp"

  project_cleanup_report "$raw_file" "$stage" "$expected_mode" "$temporary" ||
    fail "obsolete event cleanup report contract failed for $stage"
  mv "$temporary" "$output"
  rm -f -- "$raw_file"
  LAST_REPORT="$output"
}

run_backfill() {
  local service="$1"
  local mode="$2"
  local stage="$3"
  local expected_mode="dry-run"
  [[ "$mode" == "apply" ]] && expected_mode="apply"
  run_job "$service" "dist/scripts/backfillDataCompatibility.js" "$mode"
  sanitize_backfill_report "$LAST_RAW_FILE" "$service" "$stage" "$expected_mode"
}

run_index() {
  local mode="$1"
  local stage="$2"
  local expected_mode="dry-run"
  [[ "$mode" == "apply" ]] && expected_mode="apply"
  run_job slip "dist/scripts/ensureDraftIndexes.js" "$mode"
  sanitize_index_report "$LAST_RAW_FILE" "$stage" "$expected_mode"
}

run_obsolete_event_cleanup() {
  local mode="$1"
  local stage="$2"
  run_job event "dist/scripts/cleanupObsoleteSyntheticEvent.js" "$mode" true
  sanitize_cleanup_report "$LAST_RAW_FILE" "$stage" "$mode"
}

write_evidence_manifest() {
  python3 - "$OUTPUT_DIR" <<'PY'
import hashlib
import sys
from pathlib import Path

root = Path(sys.argv[1])
manifest = root / "SHA256SUMS"
rows = []
for path in sorted(root.rglob("*")):
    if not path.is_file() or path == manifest:
        continue
    relative = path.relative_to(root).as_posix()
    rows.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {relative}")
manifest.write_text("\n".join(rows) + "\n", encoding="utf-8")
PY
}

write_cleanup_blocker_evidence() {
  local report="$1"
  local completed_at report_sha256 output temporary

  [[ "$LAST_JOB_OUTCOME" == "structured-blocked" &&
     "$LAST_JOB_POD_COUNT" == "1" &&
     "$LAST_JOB_POD_PHASE" == "Failed" &&
     "$LAST_JOB_CONTAINER_STATE" == "terminated" &&
     "$LAST_JOB_CONTAINER_REASON" == "Error" &&
     "$LAST_JOB_EXIT_CODE" == "1" &&
     "$LAST_JOB_SIGNAL" == "0" ]] ||
    fail "blocked cleanup report is missing its exact failed-job evidence"
  jq -e '
    .state == "blocked" and
    .ready == false and
    .changed == 0 and
    .errorCount > 0 and
    .blockerCount > 0
  ' "$report" >/dev/null ||
    fail "blocked cleanup report cannot produce failure evidence"

  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  report_sha256="$(
    python3 - "$report" <<'PY'
import hashlib
import sys
from pathlib import Path

print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
  )"
  output="$OUTPUT_DIR/cleanup-blocker-failure.json"
  temporary="${output}.tmp"
  jq -n \
    --slurpfile cleanup "$report" \
    --arg source_sha "$SOURCE_SHA" \
    --arg build_run_id "$BUILD_RUN_ID" \
    --arg infrastructure_run_id "$INFRASTRUCTURE_RUN_ID" \
    --arg workflow_run_id "$RUN_ID" \
    --arg workflow_run_attempt "$RUN_ATTEMPT" \
    --arg phase "$PHASE" \
    --arg report_sha256 "$report_sha256" \
    --arg pod_phase "$LAST_JOB_POD_PHASE" \
    --arg container_state "$LAST_JOB_CONTAINER_STATE" \
    --arg container_reason "$LAST_JOB_CONTAINER_REASON" \
    --argjson pod_count "$LAST_JOB_POD_COUNT" \
    --argjson exit_code "$LAST_JOB_EXIT_CODE" \
    --argjson container_signal "$LAST_JOB_SIGNAL" \
    --arg completed_at "$completed_at" '
      {
        schemaVersion: "live-betting-cleanup-blocker-v1",
        status: "FAIL",
        sourceSha: $source_sha,
        buildRunId: $build_run_id,
        infrastructureRunId: $infrastructure_run_id,
        workflowRunId: $workflow_run_id,
        workflowRunAttempt: $workflow_run_attempt,
        phase: $phase,
        stage: $cleanup[0].stage,
        targetEventId: $cleanup[0].targetEventId,
        mode: $cleanup[0].mode,
        state: $cleanup[0].state,
        ready: $cleanup[0].ready,
        changed: $cleanup[0].changed,
        errorCount: $cleanup[0].errorCount,
        blockerCount: $cleanup[0].blockerCount,
        reportSha256: $report_sha256,
        job: {
          outcome: "failed",
          podCount: $pod_count,
          podPhase: $pod_phase,
          containerState: $container_state,
          containerReason: $container_reason,
          exitCode: $exit_code,
          signal: $container_signal
        },
        completedAt: $completed_at
      }
    ' >"$temporary"
  mv "$temporary" "$output"
  write_evidence_manifest
}

require_cleanup_ready() {
  local report="$1"
  if [[ "$(jq -r '.ready' "$report")" != "true" ]]; then
    write_cleanup_blocker_evidence "$report"
    fail "obsolete event cleanup is blocked; sanitized failure evidence recorded"
  fi
}

require_cleanup_complete() {
  local report="$1"
  local state
  state="$(jq -r '.state' "$report")"
  [[ "$state" == "absent" || "$state" == "removed" ]] ||
    fail "obsolete event cleanup is incomplete: $state"
}

require_safe_slip_report() {
  local report="$1"
  [[ "$(jq -r '.duplicateDraftGroupCount' "$report")" == "0" ]] ||
    fail "duplicate draft slips require manual resolution before rollout"
}

require_empty_backfill_report() {
  local report="$1"
  [[ "$(jq -r '.matched' "$report")" == "0" ]] ||
    fail "backfill verification still matches documents"
}

require_non_conflicting_index() {
  local report="$1"
  [[ "$(jq -r '.existingIndex' "$report")" != "conflicting" ]] ||
    fail "a conflicting Slip draft index exists"
}

verify_cluster_runtime() {
  local deployment state
  for deployment in gaming-auth-depl gaming-backoffice-depl gaming-client-depl; do
    kubectl rollout status "deployment/$deployment" \
      -n "$OCI_K8S_NAMESPACE" --timeout=2m >/dev/null ||
      fail "runtime deployment became unhealthy after a data write"
  done
  if [[ "$WRITERS_QUIESCED" == "true" ]]; then
    for deployment in \
      gaming-bet-depl \
      gaming-event-depl \
      gaming-gamemaster-depl \
      gaming-moderation-depl \
      gaming-resulting-depl \
      gaming-slip-depl; do
      state="$(
        kubectl get deployment "$deployment" \
          -n "$OCI_K8S_NAMESPACE" \
          -o jsonpath='{.spec.replicas}|{.status.replicas}|{.status.readyReplicas}|{.status.availableReplicas}'
      )"
      [[ "$state" == "0|||" || "$state" == "0|0|0|0" ]] ||
        fail "quiesced writer deployment resumed during a data write"
    done
  else
    fail "mutating runtime verification requires quiesced writers"
  fi
  kubectl rollout status statefulset/gaming-auth-mongo-depl \
    -n "$OCI_K8S_NAMESPACE" --timeout=2m >/dev/null ||
    fail "Mongo became unhealthy after a data write"
  kubectl rollout status deployment/gaming-rabbitmq-depl \
    -n "$OCI_K8S_NAMESPACE" --timeout=2m >/dev/null ||
    fail "RabbitMQ became unhealthy after a data write"

  local mongo_pod rabbitmq_pod
  mongo_pod="$(
    kubectl get pods -n "$OCI_K8S_NAMESPACE" \
      -l app=gaming-auth-mongo \
      -o jsonpath='{.items[0].metadata.name}'
  )"
  rabbitmq_pod="$(
    kubectl get pods -n "$OCI_K8S_NAMESPACE" \
      -l app=gaming-rabbitmq \
      -o jsonpath='{.items[0].metadata.name}'
  )"
  [[ -n "$mongo_pod" && -n "$rabbitmq_pod" ]] ||
    fail "runtime dependency pod is missing after a data write"
  kubectl exec -n "$OCI_K8S_NAMESPACE" "$mongo_pod" -- \
    mongosh --quiet --eval 'quit(db.adminCommand({ping:1}).ok === 1 ? 0 : 1)' \
    >/dev/null ||
    fail "Mongo ping failed after a data write"
  kubectl exec -n "$OCI_K8S_NAMESPACE" "$rabbitmq_pod" -- \
    rabbitmq-diagnostics -q ping >/dev/null ||
    fail "RabbitMQ ping failed after a data write"
}

run_all_dry() {
  local stage="$1"
  local require_empty="$2"
  local service report
  for service in "${services[@]}"; do
    run_backfill "$service" dry-run "$stage"
    report="$LAST_REPORT"
    if [[ "$service" == "slip" ]]; then
      require_safe_slip_report "$report"
    fi
    if [[ "$require_empty" == "true" ]]; then
      require_empty_backfill_report "$report"
    fi
  done
}

backfill_complete=false
index_ready=false
obsolete_event_cleanup_complete=false

case "$PHASE" in
  dry-run)
    run_obsolete_event_cleanup dry-run preflight
    require_cleanup_ready "$LAST_REPORT"
    cleanup_state="$(jq -r '.state' "$LAST_REPORT")"
    [[ "$cleanup_state" != "partial" ]] ||
      fail "obsolete event cleanup is partially applied"
    if [[ "$cleanup_state" == "absent" || "$cleanup_state" == "removed" ]]; then
      obsolete_event_cleanup_complete=true
    fi
    run_all_dry preflight false
    run_index dry-run preflight
    require_non_conflicting_index "$LAST_REPORT"
    total_matches="$(
      jq -s '[.[].matched] | add' "$OUTPUT_DIR"/reports/preflight-{event,gamemaster,moderation,resulting,bet,slip}.json
    )"
    [[ "$total_matches" == "0" ]] && backfill_complete=true
    if [[ "$(jq -r '.ready' "$LAST_REPORT")" == "true" &&
      "$(jq -r '.existingIndex' "$LAST_REPORT")" == "matching" ]]; then
      index_ready=true
    fi
    ;;
  apply-backfills)
    run_obsolete_event_cleanup dry-run preflight
    require_cleanup_ready "$LAST_REPORT"
    run_all_dry preflight false
    run_index dry-run preflight
    require_non_conflicting_index "$LAST_REPORT"
    for service in "${services[@]}"; do
      run_backfill "$service" apply apply
      [[ "$service" != "slip" ]] || require_safe_slip_report "$LAST_REPORT"
      verify_cluster_runtime
      run_backfill "$service" dry-run verify
      [[ "$service" != "slip" ]] || require_safe_slip_report "$LAST_REPORT"
      require_empty_backfill_report "$LAST_REPORT"
    done
    run_obsolete_event_cleanup apply apply
    require_cleanup_ready "$LAST_REPORT"
    require_cleanup_complete "$LAST_REPORT"
    verify_cluster_runtime
    run_obsolete_event_cleanup dry-run verify
    require_cleanup_ready "$LAST_REPORT"
    require_cleanup_complete "$LAST_REPORT"
    obsolete_event_cleanup_complete=true
    run_index dry-run final
    require_non_conflicting_index "$LAST_REPORT"
    [[ "$(jq -r '.ready' "$LAST_REPORT")" == "true" ]] ||
      fail "Slip data is not normalized after backfills"
    backfill_complete=true
    [[ "$(jq -r '.existingIndex' "$LAST_REPORT")" == "matching" ]] &&
      index_ready=true
    ;;
  apply-slip-index)
    run_obsolete_event_cleanup dry-run preflight
    require_cleanup_ready "$LAST_REPORT"
    require_cleanup_complete "$LAST_REPORT"
    obsolete_event_cleanup_complete=true
    run_all_dry preflight false
    run_index dry-run preflight
    require_non_conflicting_index "$LAST_REPORT"
    for service in "${services[@]}"; do
      run_backfill "$service" apply apply
      [[ "$service" != "slip" ]] || require_safe_slip_report "$LAST_REPORT"
      verify_cluster_runtime
      run_backfill "$service" dry-run verify
      [[ "$service" != "slip" ]] || require_safe_slip_report "$LAST_REPORT"
      require_empty_backfill_report "$LAST_REPORT"
    done
    run_index dry-run final
    require_non_conflicting_index "$LAST_REPORT"
    [[ "$(jq -r '.ready' "$LAST_REPORT")" == "true" ]] ||
      fail "Slip index preflight is not ready"
    run_index apply apply
    require_non_conflicting_index "$LAST_REPORT"
    [[ "$(jq -r '.ready' "$LAST_REPORT")" == "true" ]] ||
      fail "Slip index apply did not report ready"
    verify_cluster_runtime
    run_index dry-run verify
    [[ "$(jq -r '.ready' "$LAST_REPORT")" == "true" ]] ||
      fail "Slip index verification did not report ready"
    [[ "$(jq -r '.existingIndex' "$LAST_REPORT")" == "matching" ]] ||
      fail "Slip draft index does not match the exact reviewed definition"
    [[ "$(jq -r '.errorCount' "$LAST_REPORT")" == "0" ]] ||
      fail "Slip index verification retained blockers"
    backfill_complete=true
    index_ready=true
    ;;
esac

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$OUTPUT_DIR/provenance.env" <<EOF
schema_version=live-betting-v1
source_sha=$SOURCE_SHA
build_run_id=$BUILD_RUN_ID
infrastructure_run_id=$INFRASTRUCTURE_RUN_ID
baseline_sha256=$BASELINE_SHA256
baseline_recovery_run_id=$BASELINE_RECOVERY_RUN_ID
baseline_recovery_source_sha=$BASELINE_RECOVERY_SOURCE_SHA
workflow_run_id=$RUN_ID
workflow_run_attempt=$RUN_ATTEMPT
phase=$PHASE
status=PASS
backfill_complete=$backfill_complete
index_ready=$index_ready
obsolete_event_cleanup_complete=$obsolete_event_cleanup_complete
maintenance_fence_enforced=$MAINTENANCE_FENCE_ENFORCED
writers_quiesced=$WRITERS_QUIESCED
runtime_held_for_deploy=$RUNTIME_HELD_FOR_DEPLOY
operation_lock_enforced=$OPERATION_LOCK_ENFORCED
operation_lock_handoff=$OPERATION_LOCK_HANDOFF
completed_at=$completed_at
EOF

jq -s \
  --arg source_sha "$SOURCE_SHA" \
  --arg build_run_id "$BUILD_RUN_ID" \
  --arg infrastructure_run_id "$INFRASTRUCTURE_RUN_ID" \
  --arg baseline_sha256 "$BASELINE_SHA256" \
  --arg baseline_recovery_run_id "$BASELINE_RECOVERY_RUN_ID" \
  --arg baseline_recovery_source_sha "$BASELINE_RECOVERY_SOURCE_SHA" \
  --arg workflow_run_id "$RUN_ID" \
  --arg workflow_run_attempt "$RUN_ATTEMPT" \
  --arg phase "$PHASE" \
  --arg completed_at "$completed_at" \
  --argjson backfill_complete "$backfill_complete" \
  --argjson index_ready "$index_ready" \
  --argjson obsolete_event_cleanup_complete "$obsolete_event_cleanup_complete" \
  --argjson maintenance_fence_enforced "$MAINTENANCE_FENCE_ENFORCED" \
  --argjson writers_quiesced "$WRITERS_QUIESCED" \
  --argjson runtime_held_for_deploy "$RUNTIME_HELD_FOR_DEPLOY" \
  --argjson operation_lock_enforced "$OPERATION_LOCK_ENFORCED" \
  --argjson operation_lock_handoff "$OPERATION_LOCK_HANDOFF" '
    {
      schema_version: "live-betting-v1",
      source_sha: $source_sha,
      build_run_id: $build_run_id,
      infrastructure_run_id: $infrastructure_run_id,
      baseline_sha256: $baseline_sha256,
      baseline_recovery_run_id: $baseline_recovery_run_id,
      baseline_recovery_source_sha: $baseline_recovery_source_sha,
      workflow_run_id: $workflow_run_id,
      workflow_run_attempt: $workflow_run_attempt,
      phase: $phase,
      status: "PASS",
      backfill_complete: $backfill_complete,
      index_ready: $index_ready,
      obsolete_event_cleanup_complete: $obsolete_event_cleanup_complete,
      maintenance_fence_enforced: $maintenance_fence_enforced,
      writers_quiesced: $writers_quiesced,
      runtime_held_for_deploy: $runtime_held_for_deploy,
      operation_lock_enforced: $operation_lock_enforced,
      operation_lock_handoff: $operation_lock_handoff,
      completed_at: $completed_at,
      reports: .
    }
  ' "$OUTPUT_DIR"/reports/*.json >"$OUTPUT_DIR/journal.json"

if [[ "$PHASE" == "apply-slip-index" ]]; then
  cat >"$OUTPUT_DIR/schema.env" <<EOF
schema_version=live-betting-v1
source_sha=$SOURCE_SHA
build_run_id=$BUILD_RUN_ID
infrastructure_run_id=$INFRASTRUCTURE_RUN_ID
baseline_sha256=$BASELINE_SHA256
baseline_recovery_run_id=$BASELINE_RECOVERY_RUN_ID
baseline_recovery_source_sha=$BASELINE_RECOVERY_SOURCE_SHA
data_run_id=$RUN_ID
data_run_attempt=$RUN_ATTEMPT
backfill_complete=true
index_ready=true
obsolete_event_cleanup_complete=true
maintenance_fence_enforced=true
writers_quiesced=true
runtime_held_for_deploy=true
operation_lock_enforced=true
operation_lock_handoff=true
EOF
fi

write_evidence_manifest

EVIDENCE_DIR="$OUTPUT_DIR" \
EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
EXPECTED_PHASE="$PHASE" \
EXPECTED_RUN_ID="$RUN_ID" \
EXPECTED_RUN_ATTEMPT="$RUN_ATTEMPT" \
EXPECTED_BASELINE_RECOVERY_RUN_ID="$BASELINE_RECOVERY_RUN_ID" \
EXPECTED_BASELINE_RECOVERY_SOURCE_SHA="$BASELINE_RECOVERY_SOURCE_SHA" \
  "$SCRIPT_DIR/verify-live-betting-data-evidence-stan.sh" >/dev/null

echo "live_betting_data_rollout=PASS phase=$PHASE backfill_complete=$backfill_complete index_ready=$index_ready"
