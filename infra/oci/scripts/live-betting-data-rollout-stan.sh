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
RUN_ID="${GITHUB_RUN_ID:-}"
RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}"
BASELINE_SHA256="${BASELINE_SHA256:-}"
MAINTENANCE_FENCE_ENFORCED="${MAINTENANCE_FENCE_ENFORCED:-false}"
WRITERS_QUIESCED="${WRITERS_QUIESCED:-false}"
RUNTIME_HELD_FOR_DEPLOY="${RUNTIME_HELD_FOR_DEPLOY:-false}"
OPERATION_LOCK_ENFORCED="${OPERATION_LOCK_ENFORCED:-false}"
OPERATION_LOCK_HANDOFF="${OPERATION_LOCK_HANDOFF:-false}"

services=(event gamemaster moderation resulting bet slip)
created_jobs=()
raw_files=()
job_sequence=0

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
      --wait=false >/dev/null 2>&1
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
[[ "$OCI_K8S_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  fail "OCI_K8S_NAMESPACE is invalid"
[[ -f "$IMAGE_PROVENANCE_FILE" ]] ||
  fail "IMAGE_PROVENANCE_FILE not found"
[[ -n "$OUTPUT_DIR" && "$OUTPUT_DIR" != "/" && "$OUTPUT_DIR" != "." ]] ||
  fail "OUTPUT_DIR is unsafe"
[[ "$BASELINE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  fail "BASELINE_SHA256 must bind the protected pre-mutation baseline"
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
kubectl get secret ocir-pull \
  -n "$OCI_K8S_NAMESPACE" >/dev/null

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
  if [[ "$command_path" == "dist/scripts/backfillDataCompatibility.js" ]]; then
    args='
          args:
            - "--batch-size"
            - "'"$BATCH_SIZE"'"'
  else
    args=""
  fi
  if [[ "$mode" == "apply" ]]; then
    args+='
          args:
            - "--apply"'
    if [[ "$command_path" == "dist/scripts/backfillDataCompatibility.js" ]]; then
      args='
          args:
            - "--batch-size"
            - "'"$BATCH_SIZE"'"
            - "--apply"'
    fi
  fi

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
      imagePullSecrets:
        - name: ocir-pull
      securityContext:
        runAsNonRoot: true
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

wait_for_job_report() {
  local job_name="$1"
  local raw_file="$2"
  local deadline=$(( $(date +%s) + JOB_TIMEOUT_SECONDS ))
  local job_json

  while (( $(date +%s) < deadline )); do
    job_json="$(kubectl get job "$job_name" -n "$OCI_K8S_NAMESPACE" -o json)"
    if jq -e '(.status.succeeded // 0) == 1' <<<"$job_json" >/dev/null; then
      kubectl logs "job/$job_name" \
        -n "$OCI_K8S_NAMESPACE" \
        --container data-rollout >"$raw_file" 2>/dev/null ||
        fail "unable to collect completed job report"
      return 0
    fi
    if jq -e '(.status.failed // 0) > 0' <<<"$job_json" >/dev/null; then
      kubectl logs "job/$job_name" \
        -n "$OCI_K8S_NAMESPACE" \
        --container data-rollout >"$raw_file" 2>/dev/null || true
      fail "data job failed for $job_name; raw logs were withheld"
    fi
    sleep 5
  done

  fail "data job timed out for $job_name"
}

run_job() {
  local service="$1"
  local command_path="$2"
  local mode="$3"
  local raw_file
  local image_ref
  local job_name

  job_sequence=$((job_sequence + 1))
  job_name="live-data-${service}-${RUN_ID}-${job_sequence}"
  image_ref="$(image_for_service "$service")"
  raw_file="$(mktemp "${TMPDIR:-/tmp}/betstan-live-data.XXXXXX")"
  raw_files+=("$raw_file")
  created_jobs+=("$job_name")
  create_job "$service" "$command_path" "$mode" "$image_ref" "$job_name"
  wait_for_job_report "$job_name" "$raw_file"
  kubectl delete job "$job_name" \
    -n "$OCI_K8S_NAMESPACE" \
    --ignore-not-found=true \
    --wait=false >/dev/null
  LAST_RAW_FILE="$raw_file"
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

case "$PHASE" in
  dry-run)
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
      fail "Slip data is not normalized after backfills"
    backfill_complete=true
    [[ "$(jq -r '.existingIndex' "$LAST_REPORT")" == "matching" ]] &&
      index_ready=true
    ;;
  apply-slip-index)
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
workflow_run_id=$RUN_ID
workflow_run_attempt=$RUN_ATTEMPT
phase=$PHASE
status=PASS
backfill_complete=$backfill_complete
index_ready=$index_ready
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
  --arg workflow_run_id "$RUN_ID" \
  --arg workflow_run_attempt "$RUN_ATTEMPT" \
  --arg phase "$PHASE" \
  --arg completed_at "$completed_at" \
  --argjson backfill_complete "$backfill_complete" \
  --argjson index_ready "$index_ready" \
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
      workflow_run_id: $workflow_run_id,
      workflow_run_attempt: $workflow_run_attempt,
      phase: $phase,
      status: "PASS",
      backfill_complete: $backfill_complete,
      index_ready: $index_ready,
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
data_run_id=$RUN_ID
data_run_attempt=$RUN_ATTEMPT
backfill_complete=true
index_ready=true
maintenance_fence_enforced=true
writers_quiesced=true
runtime_held_for_deploy=true
operation_lock_enforced=true
operation_lock_handoff=true
EOF
fi

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

EVIDENCE_DIR="$OUTPUT_DIR" \
EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
EXPECTED_PHASE="$PHASE" \
EXPECTED_RUN_ID="$RUN_ID" \
EXPECTED_RUN_ATTEMPT="$RUN_ATTEMPT" \
  "$SCRIPT_DIR/verify-live-betting-data-evidence-stan.sh" >/dev/null

echo "live_betting_data_rollout=PASS phase=$PHASE backfill_complete=$backfill_complete index_ready=$index_ready"
