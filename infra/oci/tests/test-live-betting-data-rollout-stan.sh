#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNNER="$ROOT_DIR/infra/oci/scripts/live-betting-data-rollout-stan.sh"
VERIFIER="$ROOT_DIR/infra/oci/scripts/verify-live-betting-data-evidence-stan.sh"
MAINTENANCE="$ROOT_DIR/infra/oci/scripts/live-data-maintenance-stan.sh"
WORKFLOW="$ROOT_DIR/.github/workflows/oci-live-data-rollout.yml"
DEPLOY_WORKFLOW="$ROOT_DIR/.github/workflows/oci-production-deploy.yml"
WORK_PARENT="$ROOT_DIR/infra/oci/tests/.live-data-rollout-workdirs"
SOURCE_SHA=1111111111111111111111111111111111111111
BUILD_RUN_ID=2001
INFRASTRUCTURE_RUN_ID=3001

"$ROOT_DIR/infra/oci/tests/test-cleanup-live-acceptance-slips-stan.sh" >/dev/null

mkdir -p "$WORK_PARENT"
work_dir="$(mktemp -d "$WORK_PARENT/test.XXXXXX")"
stub_bin="$work_dir/bin"
stub_state="$work_dir/state"
images_file="$work_dir/images.tsv"
mkdir -p "$stub_bin" "$stub_state"
cleanup() {
  rm -rf -- "$work_dir"
  rmdir "$WORK_PARENT" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "live data rollout contract test failed: $*" >&2
  exit 1
}

write_manifest() {
  local directory="$1"
  python3 - "$directory" <<'PY'
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

make_resume_baseline() {
  local directory="$1"
  local capture_run_id="$2"
  local recovery_run_id="$3"
  mkdir -p "$directory"
  cat >"$directory/baseline-provenance.env" <<EOF
baseline_capture_run_id=$capture_run_id
baseline_recovery_run_id=$recovery_run_id
EOF
  write_manifest "$directory"
  shasum -a 256 "$directory/SHA256SUMS" | awk '{print $1}'
}

cat >"$stub_bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

state="${STUB_STATE_DIR:?}"
scenario="${STUB_SCENARIO:?}"
mkdir -p "$state/jobs" "$state/applied"

is_blocked_reschedule_job() {
  local job="$1"
  local manifest="$state/jobs/$job.yaml"
  [[ -f "$manifest" ]] || return 1
  grep -Fq 'rescheduleSyntheticEvent.js' "$manifest" || return 1
  if [[ "$scenario" == "reschedule-blocked-apply" ]]; then
    grep -Fq -- '- "apply"' "$manifest"
  else
    [[ "$scenario" == reschedule-blocked* ]]
  fi
}

if [[ "${1:-}" == "create" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  manifest="$(mktemp "$state/jobs/pending.XXXXXX")"
  cat >"$manifest"
  job="$(
    awk '
      /^metadata:/ { in_metadata=1; next }
      in_metadata && /^  name:/ { print $2; exit }
    ' "$manifest"
  )"
  [[ -n "$job" ]]
  mv "$manifest" "$state/jobs/$job.yaml"
  exit 0
fi

if [[ "${1:-}" == "get" ]]; then
  case "${2:-}" in
    namespace|service)
      printf '{}\n'
      exit 0
      ;;
    secret)
      if [[ "$scenario" == "secret-api-error" ]]; then
        echo "forbidden" >&2
        exit 9
      fi
      exit 0
      ;;
    serviceaccount)
      printf '{"imagePullSecrets":[]}\n'
      exit 0
      ;;
    job)
      if is_blocked_reschedule_job "${3:-}"; then
        if [[ "$scenario" == "reschedule-blocked-status-retry" &&
          ! -e "$state/job-status-read-failed" ]]; then
          touch "$state/job-status-read-failed"
          exit 9
        fi
        if [[ "$scenario" == "reschedule-blocked-succeeded-deadline" ]]; then
          printf '%s\n' \
            '{"status":{"succeeded":1,"conditions":[{"type":"Failed","status":"True","reason":"DeadlineExceeded"}]}}'
        elif [[ ("$scenario" == "reschedule-blocked-pod-phase-race" ||
              "$scenario" == "reschedule-blocked-contradictory-success") &&
          ! -e "$state/pod-phase-race-observed" ]]; then
          printf '{"status":{}}\n'
        elif [[ "$scenario" == "reschedule-blocked-contradictory-success" ]]; then
          printf '%s\n' \
            '{"status":{"succeeded":1,"conditions":[{"type":"Complete","status":"True","reason":"CompletionsReached"}]}}'
        else
          failure_reason=BackoffLimitExceeded
          [[ "$scenario" != "reschedule-blocked-deadline" ]] ||
            failure_reason=DeadlineExceeded
          jq -n --arg reason "$failure_reason" '{
            status:{
              failed:1,
              conditions:[{
                type:"Failed",
                status:"True",
                reason:$reason
              }]
            }
          }'
        fi
      elif [[ "$scenario" == "image-pull" ]]; then
        printf '{"status":{}}\n'
      else
        printf '%s\n' \
          '{"status":{"succeeded":1,"conditions":[{"type":"Complete","status":"True","reason":"CompletionsReached"}]}}'
      fi
      exit 0
      ;;
    deployment)
      printf '0|0|0|0'
      exit 0
      ;;
    pods)
      selected_job=""
      for argument in "$@"; do
        if [[ "$argument" == job-name=* ]]; then
          selected_job="${argument#job-name=}"
        fi
      done
      if [[ -n "$selected_job" ]] &&
        is_blocked_reschedule_job "$selected_job"; then
        [[ "$scenario" != "reschedule-blocked-status-error" ]] || exit 9
        if [[ "$scenario" == "reschedule-blocked-status-retry" &&
          ! -e "$state/pod-status-read-failed" ]]; then
          touch "$state/pod-status-read-failed"
          exit 9
        fi
        pod_phase=Failed
        if [[ ("$scenario" == "reschedule-blocked-pod-phase-race" ||
              "$scenario" == "reschedule-blocked-contradictory-success") &&
          ! -e "$state/pod-phase-race-observed" ]]; then
          pod_phase=Running
          touch "$state/pod-phase-race-observed"
        elif [[ "$scenario" == "reschedule-blocked-never-converges" ]]; then
          pod_phase=Running
        fi
        container_signal=0
        [[ "$scenario" != "reschedule-blocked-signaled" ]] || container_signal=15
        jq -n \
          --arg pod_phase "$pod_phase" \
          --argjson container_signal "$container_signal" '{
          items:[{
            status:{
              phase:$pod_phase,
              containerStatuses:[{
                state:{
                  terminated:{
                    reason:"Error",
                    exitCode:1,
                    signal:$container_signal,
                    message:"private runtime detail"
                  }
                }
              }]
            }
          }]
        }'
      elif [[ "$scenario" == "image-pull" && "$*" == *"job-name="* ]]; then
        printf '%s\n' \
          '{"items":[{"status":{"phase":"Pending","containerStatuses":[{"state":{"waiting":{"reason":"ImagePullBackOff","message":"secret registry detail"}}}]}}]}'
      elif [[ "$*" == *"app=gaming-auth-mongo"* ]]; then
        printf 'mongo-0'
      elif [[ "$*" == *"app=gaming-rabbitmq"* ]]; then
        printf 'rabbitmq-0'
      else
        printf '{"items":[]}\n'
      fi
      exit 0
      ;;
  esac
fi

if [[ "${1:-}" == "logs" ]]; then
  job="${2#job/}"
  manifest="$state/jobs/$job.yaml"
  [[ -f "$manifest" ]]
  service="$(
    sed -n 's#.*gaming_shared_never_matches##; s#.*\/gaming_\([a-z]*\)".*#\1#p' "$manifest" |
      head -n 1
  )"
  [[ -n "$service" ]]
  is_apply=false
  grep -Fq -- '- "--apply"' "$manifest" && is_apply=true

  if grep -Fq 'rescheduleSyntheticEvent.js' "$manifest"; then
    if is_blocked_reschedule_job "$job" &&
      [[ "$scenario" == "reschedule-blocked-exception" ]]; then
      printf 'database exception for secret-user\n'
      exit 0
    fi
    if is_blocked_reschedule_job "$job"; then
      changed=0
      reason="event or Slip dependency"
      blocker_database="gaming_bet"
      blocker_collection="bets"
      mode=dry-run
      grep -Fq -- '- "apply"' "$manifest" && mode=apply
      grep -Fq -- '- "verify"' "$manifest" && mode=verify
      [[ "$scenario" != "reschedule-blocked-changed" ]] || changed=1
      [[ "$scenario" != "reschedule-blocked-unknown-reason" ]] ||
        reason="event or Slip dependency for secret-user"
      if [[ "$scenario" == "reschedule-blocked-source-missing" ]]; then
        reason="Backoffice source identity does not match the reviewed fixture"
        blocker_database="gaming_backoffice"
        blocker_collection="events"
      fi
      blocked_report="$(
        jq -n \
          --arg mode "$mode" \
          --arg reason "$reason" \
          --arg blocker_database "$blocker_database" \
          --arg blocker_collection "$blocker_collection" \
          --argjson changed "$changed" '{
            mode:$mode,
            targetEventId:"0fd6a3633bf1fcf09d95c17d",
            targetKickoff:"2026-09-13T08:05:00.000Z",
            state:"blocked",
            ready:false,
            scanned:20,
            matched:0,
            changed:$changed,
            errorCount:1,
            journalVerified:false,
            snapshotDocumentCount:0,
            targetDocumentCount:0,
            blockers:[{
              database:$blocker_database,
              collection:$blocker_collection,
              count:1,
              reason:$reason
            }]
          }'
      )"
      printf '%s\n' "$blocked_report"
      if [[ "$scenario" == "reschedule-blocked-multiple" ]]; then
        printf '%s\n' "$blocked_report"
      fi
      if [[ "$scenario" == "reschedule-blocked-log-retry" &&
        ! -e "$state/log-read-failed" ]]; then
        touch "$state/log-read-failed"
        exit 9
      fi
      [[ "$scenario" != "reschedule-blocked-log-error" ]] || exit 9
      exit 0
    fi
    mode=dry-run
    reschedule_state=candidate
    matched=0
    changed=0
    journal_verified=false
    snapshot_document_count=0
    target_document_count=3
    if [[ "$scenario" == "final" ]]; then
      reschedule_state=completed
      matched=1
      journal_verified=true
    fi
    if grep -Fq -- '- "apply"' "$manifest"; then
      mode=apply
      reschedule_state=applied
      changed=4
      journal_verified=true
      touch "$state/applied/event-reschedule"
    elif grep -Fq -- '- "verify"' "$manifest"; then
      mode=verify
      reschedule_state=verified
      journal_verified=true
    elif [[ -f "$state/applied/event-reschedule" ]]; then
      reschedule_state=applied
      matched=3
      journal_verified=true
    fi
    jq -n \
      --arg mode "$mode" \
      --arg state "$reschedule_state" \
      --argjson matched "$matched" \
      --argjson changed "$changed" \
      --argjson journal_verified "$journal_verified" \
      --argjson snapshot_document_count "$snapshot_document_count" '{
        mode:$mode,
        targetEventId:"0fd6a3633bf1fcf09d95c17d",
        targetKickoff:"2026-09-13T08:05:00.000Z",
        state:$state,
        ready:true,
        scanned:20,
        matched:$matched,
        changed:$changed,
        errorCount:0,
        journalVerified:$journal_verified,
        snapshotDocumentCount:$snapshot_document_count,
        targetDocumentCount:3,
        blockers:[]
      } + (
        if $journal_verified
        then {
          snapshotSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          targetSha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
        else {}
        end
      )'
    exit 0
  fi

  if grep -Fq 'ensureDraftIndexes.js' "$manifest"; then
    index_state=missing
    ready=false
    changed=0
    blockers=1
    all_applied=true
    for expected in event gamemaster moderation resulting bet slip; do
      [[ -f "$state/applied/$expected" ]] || all_applied=false
    done
    if [[ "$scenario" == "final" || "$all_applied" == "true" ]]; then
      ready=true
      blockers=0
    fi
    if [[ -f "$state/applied/slip-index" ]]; then
      index_state=matching
      ready=true
      blockers=0
    fi
    if [[ "$is_apply" == "true" ]]; then
      touch "$state/applied/slip-index"
      changed=1
    fi
    mode=dry-run
    [[ "$is_apply" == "false" ]] || mode=apply
    jq -n \
      --arg mode "$mode" \
      --arg index_state "$index_state" \
      --argjson ready "$ready" \
      --argjson changed "$changed" \
      --argjson blockers "$blockers" '{
        mode:$mode,
        ready:$ready,
        scanned:3,
        matched:$blockers,
        changed:$changed,
        skipped:(3-$blockers),
        errorCount:$blockers,
        existingIndex:$index_state,
        indexName:"slip_draft_unique_by_kind",
        blocking:{
          draftCount:3,
          duplicateGroupCount:0,
          duplicateDraftCount:0,
          missingBetKindCount:$blockers,
          invalidBetKindCount:0,
          missingDraftKeyCount:0,
          invalidDraftKeyCount:0,
          mismatchedDraftKeyCount:0,
          missingRowKindCount:0,
          invalidRowKindCount:0,
          mismatchedRowKindCount:0,
          unnormalizedDraftCount:$blockers
        }
      }'
    exit 0
  fi

  matched=0
  changed=0
  mode=dry-run
  if [[ "$scenario" == "pending" ]]; then
    matched=2
  elif [[ "$scenario" == "backfills" && ! -f "$state/applied/$service" ]]; then
    matched=1
  fi
  if [[ "$is_apply" == "true" ]]; then
    mode=apply
    matched=1
    changed=1
    touch "$state/applied/$service"
  fi

  duplicate_json='[]'
  if [[ "$scenario" == "duplicates" && "$service" == "slip" ]]; then
    duplicate_json='[{"userId":"secret-user","betKind":"PRE_MATCH","count":2,"slipIds":["secret-slip"]}]'
  fi
  jq -n \
    --arg mode "$mode" \
    --arg service "$service" \
    --argjson matched "$matched" \
    --argjson changed "$changed" \
    --argjson duplicates "$duplicate_json" '{
      mode:$mode,
      batchSize:100,
      collection:"all",
      scanned:5,
      matched:$matched,
      changed:$changed,
      skipped:(5-$matched),
      errorCount:0,
      collections:[{
        collection:$service,
        scanned:5,
        matched:$matched,
        changed:$changed,
        skipped:(5-$matched),
        errorCount:0
      }],
      duplicateDrafts:$duplicates
    }'
  exit 0
fi

if [[ "${1:-}" == "delete" && "${2:-}" == "job" ]]; then
  [[ "$scenario" != "reschedule-blocked-delete-error" ]] || exit 9
  mkdir -p "$state/deleted"
  touch "$state/deleted/${3:-unknown}"
  exit 0
fi

if [[ "${1:-}" == "delete" || "${1:-}" == "rollout" || "${1:-}" == "exec" ]]; then
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 1
SH
chmod +x "$stub_bin/kubectl"

cat >"$stub_bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == "api" ]]
endpoint="${2:-}"
case "$endpoint" in
  */actions/workflows/oci-live-data-rollout.yml)
    printf '{"id":339733789}\n'
    ;;
  */actions/runs/*/attempts/1)
    requested_run_id="${endpoint%/attempts/1}"
    requested_run_id="${requested_run_id##*/}"
    jq -n \
      --argjson id "${STUB_RESUME_RUN_ID:?}" \
      --argjson workflow_id 339733789 \
      --arg source_sha "${STUB_RESUME_RUN_SOURCE:?}" \
      --arg repository "${STUB_RESUME_REPOSITORY:?}" \
      --arg title "oci-live-data apply-slip-index ${STUB_RESUME_RUN_SOURCE}" \
      --arg requested_run_id "$requested_run_id" '{
        id: $id,
        workflow_id: $workflow_id,
        path: ".github/workflows/oci-live-data-rollout.yml",
        event: "workflow_dispatch",
        head_sha: $source_sha,
        head_branch: "master",
        head_repository: {full_name: $repository},
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
        display_title: $title,
        requested_run_id: $requested_run_id
      }'
    ;;
  *)
    echo "unexpected gh api endpoint: $endpoint" >&2
    exit 1
    ;;
esac
SH
chmod +x "$stub_bin/gh"

for service in auth bet backoffice client event gamemaster moderation resulting slip; do
  printf '%s\tregistry.example/betstan\tregistry.example/betstan@sha256:%064d\tsha256:%064d\tsha256:%064d\n' \
    "$service" 1 1 1 >>"$images_file"
done

run_phase() {
  local phase="$1"
  local scenario="$2"
  local run_id="$3"
  local output="$4"
  local recovery_run_id="${5:-0}"
  local recovery_source_sha="${6:-none}"
  local baseline_sha="${7:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  local job_timeout="${JOB_TIMEOUT_OVERRIDE_SECONDS:-10}"
  local terminal_grace="${JOB_TERMINAL_GRACE_OVERRIDE_SECONDS:-30}"
  local maintenance_fence=false
  local writers_quiesced=false
  local runtime_handoff=false
  local lock_handoff=false
  if [[ "$phase" != "dry-run" ]]; then
    maintenance_fence=true
    writers_quiesced=true
  fi
  if [[ "$phase" == "apply-slip-index" ]]; then
    runtime_handoff=true
    lock_handoff=true
  fi
  rm -rf -- "$stub_state"
  mkdir -p "$stub_state"
  PATH="$stub_bin:$PATH" \
  STUB_STATE_DIR="$stub_state" \
  STUB_SCENARIO="$scenario" \
  PHASE="$phase" \
  SOURCE_SHA="$SOURCE_SHA" \
  BUILD_RUN_ID="$BUILD_RUN_ID" \
  INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  IMAGE_PROVENANCE_FILE="$images_file" \
  OUTPUT_DIR="$output" \
  OCI_K8S_NAMESPACE=betstan-oci \
  JOB_TIMEOUT_SECONDS="$job_timeout" \
  JOB_TERMINAL_STATE_GRACE_SECONDS="$terminal_grace" \
  GITHUB_RUN_ID="$run_id" \
  GITHUB_RUN_ATTEMPT=1 \
  BASELINE_SHA256="$baseline_sha" \
  BASELINE_RECOVERY_RUN_ID="$recovery_run_id" \
  BASELINE_RECOVERY_SOURCE_SHA="$recovery_source_sha" \
  MAINTENANCE_FENCE_ENFORCED="$maintenance_fence" \
  WRITERS_QUIESCED="$writers_quiesced" \
  RUNTIME_HELD_FOR_DEPLOY="$runtime_handoff" \
  OPERATION_LOCK_ENFORCED=true \
  OPERATION_LOCK_HANDOFF="$lock_handoff" \
    "$RUNNER" >/dev/null
}

pending_output="$work_dir/pending"
run_phase dry-run pending 4001 "$pending_output"
grep -Fxq 'schema_version=live-betting-v4' "$pending_output/provenance.env"
grep -Fxq 'phase=dry-run' "$pending_output/provenance.env"
grep -Fxq 'backfill_complete=false' "$pending_output/provenance.env"
grep -Fxq 'index_ready=false' "$pending_output/provenance.env"
grep -Fxq 'event_reschedule_complete=false' "$pending_output/provenance.env"
[[ ! -e "$pending_output/schema.env" ]] ||
  fail "dry-run emitted final schema evidence"
if grep -R -E 'secret-user|secret-slip|mongodb://' "$pending_output" >/dev/null; then
  fail "sanitized dry-run evidence leaked sensitive data"
fi

recovery_output="$work_dir/recovery"
recovery_source_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
run_phase dry-run pending 4007 "$recovery_output" 799 "$recovery_source_sha"
grep -Fxq 'baseline_recovery_run_id=799' "$recovery_output/provenance.env"
grep -Fxq \
  "baseline_recovery_source_sha=$recovery_source_sha" \
  "$recovery_output/provenance.env"

blocked_output="$work_dir/reschedule-blocked"
blocked_log="$work_dir/reschedule-blocked.out"
if run_phase dry-run reschedule-blocked 4009 "$blocked_output" \
    >"$blocked_log" 2>&1; then
  fail "structured blocked reschedule report was accepted as rollout readiness"
fi
grep -Fq \
  'event reschedule is blocked; sanitized failure evidence recorded' \
  "$blocked_log" ||
  fail "structured blocked reschedule did not report retained sanitized evidence"
blocked_report="$blocked_output/reports/preflight-event-reschedule.json"
blocked_failure="$blocked_output/reschedule-blocker-failure.json"
[[ -f "$blocked_report" && -f "$blocked_failure" &&
   -f "$blocked_output/SHA256SUMS" ]] ||
  fail "structured blocked reschedule did not retain checksummed evidence"
jq -e '
  .kind == "fixed-event-reschedule" and
  .stage == "preflight" and
  .mode == "dry-run" and
  .targetKickoff == "2026-09-13T08:05:00.000Z" and
  .state == "blocked" and
  .ready == false and
  .changed == 0 and
  .errorCount == 1 and
  .blockerCount == 1 and
  .blockers == [{
    service:"bet",
    collection:"bets",
    count:1,
    reasonCode:"event_or_slip_dependency"
  }]
' "$blocked_report" >/dev/null ||
  fail "structured blocked reschedule report was not normalized"
jq -e \
  --arg source_sha "$SOURCE_SHA" \
  --arg build_run_id "$BUILD_RUN_ID" \
  --arg infrastructure_run_id "$INFRASTRUCTURE_RUN_ID" '
    .schemaVersion == "live-betting-reschedule-blocker-v1" and
    .status == "FAIL" and
    .sourceSha == $source_sha and
    .buildRunId == $build_run_id and
    .infrastructureRunId == $infrastructure_run_id and
    .workflowRunId == "4009" and
    .workflowRunAttempt == "1" and
    .phase == "dry-run" and
    .stage == "preflight" and
    .targetEventId == "0fd6a3633bf1fcf09d95c17d" and
    .targetKickoff == "2026-09-13T08:05:00.000Z" and
    .mode == "dry-run" and
    .state == "blocked" and
    .ready == false and
    .changed == 0 and
    .errorCount == 1 and
    .blockerCount == 1 and
    (.reportSha256 | test("^[0-9a-f]{64}$")) and
    .job == {
      outcome:"failed",
      podCount:1,
      podPhase:"Failed",
      containerState:"terminated",
      containerReason:"Error",
      exitCode:1,
      signal:0
    } and
    (.completedAt | test(
      "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
    ))
  ' "$blocked_failure" >/dev/null ||
  fail "reschedule blocker failure envelope is incomplete"
expected_report_sha="$(shasum -a 256 "$blocked_report" | awk '{print $1}')"
[[ "$(jq -r '.reportSha256' "$blocked_failure")" == "$expected_report_sha" ]] ||
  fail "reschedule blocker failure envelope does not bind the sanitized report"
(
  cd "$blocked_output"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || fail "reschedule blocker failure evidence checksum is invalid"
if EVIDENCE_DIR="$blocked_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=dry-run \
  EXPECTED_RUN_ID=4009 \
  EXPECTED_RUN_ATTEMPT=1 \
    "$VERIFIER" >/dev/null 2>&1; then
  fail "reschedule blocker diagnostics were accepted as successful data evidence"
fi
[[ ! -e "$blocked_output/provenance.env" &&
   ! -e "$blocked_output/journal.json" &&
   ! -e "$blocked_output/schema.env" ]] ||
  fail "blocked reschedule emitted success-shaped rollout evidence"
if grep -R -E \
    'gaming_bet|event or Slip dependency|secret-user|mongodb://|private runtime detail' \
    "$blocked_output" >/dev/null; then
  fail "reschedule blocker evidence retained raw or sensitive diagnostics"
fi
[[ -e "$stub_state/deleted/live-data-event-4009-1" ]] ||
  fail "blocked reschedule did not delete its Kubernetes Job"

missing_source_output="$work_dir/reschedule-blocked-source-missing"
missing_source_log="$work_dir/reschedule-blocked-source-missing.out"
if run_phase dry-run reschedule-blocked-source-missing 4017 \
    "$missing_source_output" >"$missing_source_log" 2>&1; then
  fail "missing source fixture was accepted as rollout readiness"
fi
missing_source_report="$missing_source_output/reports/preflight-event-reschedule.json"
missing_source_failure="$missing_source_output/reschedule-blocker-failure.json"
[[ -f "$missing_source_report" && -f "$missing_source_failure" &&
   -f "$missing_source_output/SHA256SUMS" ]] ||
  fail "missing source fixture did not retain checksummed blocker evidence"
jq -e '
  .state == "blocked" and
  .ready == false and
  .journalVerified == false and
  .snapshotDocumentCount == 0 and
  .targetDocumentCount == 0 and
  .blockers == [{
    service:"backoffice",
    collection:"events",
    count:1,
    reasonCode:"identity_mismatch"
  }]
' "$missing_source_report" >/dev/null ||
  fail "missing source fixture blocker was not normalized"
jq -e '
  .schemaVersion == "live-betting-reschedule-blocker-v1" and
  .status == "FAIL" and
  .workflowRunId == "4017" and
  .phase == "dry-run" and
  .state == "blocked" and
  .blockerCount == 1 and
  .job.exitCode == 1
' "$missing_source_failure" >/dev/null ||
  fail "missing source fixture failure envelope is incomplete"
(
  cd "$missing_source_output"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || fail "missing source fixture blocker checksums are invalid"
[[ ! -e "$missing_source_output/provenance.env" &&
   ! -e "$missing_source_output/journal.json" &&
   ! -e "$missing_source_output/schema.env" ]] ||
  fail "missing source fixture emitted success-shaped rollout evidence"
[[ -e "$stub_state/deleted/live-data-event-4017-1" ]] ||
  fail "missing source fixture did not delete its Kubernetes Job"

race_output="$work_dir/reschedule-blocked-pod-phase-race"
race_log="$work_dir/reschedule-blocked-pod-phase-race.out"
if JOB_TIMEOUT_OVERRIDE_SECONDS=1 \
  run_phase dry-run reschedule-blocked-pod-phase-race 4012 "$race_output" \
      >"$race_log" 2>&1; then
  fail "pod-phase race blocker was accepted as rollout readiness"
fi
[[ -e "$stub_state/pod-phase-race-observed" ]] ||
  fail "pod-phase race scenario did not expose the transient Running phase"
[[ -f "$race_output/reports/preflight-event-reschedule.json" &&
   -f "$race_output/reschedule-blocker-failure.json" &&
   -f "$race_output/SHA256SUMS" ]] ||
  fail "pod-phase race discarded structured reschedule evidence"
jq -e '
  .status == "FAIL" and
  .workflowRunId == "4012" and
  .job == {
    outcome:"failed",
    podCount:1,
    podPhase:"Failed",
    containerState:"terminated",
    containerReason:"Error",
    exitCode:1,
    signal:0
  }
' "$race_output/reschedule-blocker-failure.json" >/dev/null ||
  fail "pod-phase race did not retain converged failed-job evidence"
(
  cd "$race_output"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || fail "pod-phase race evidence checksum is invalid"
if grep -R -E \
    'gaming_bet|event or Slip dependency|secret-user|mongodb://|private runtime detail' \
    "$race_output" "$race_log" 2>/dev/null | grep -q .; then
  fail "pod-phase race evidence leaked raw diagnostics"
fi
[[ -e "$stub_state/deleted/live-data-event-4012-1" ]] ||
  fail "pod-phase race did not delete its Kubernetes Job"

nonconverging_output="$work_dir/reschedule-blocked-never-converges"
nonconverging_log="$work_dir/reschedule-blocked-never-converges.out"
nonconverging_started="$SECONDS"
if JOB_TERMINAL_GRACE_OVERRIDE_SECONDS=1 \
  run_phase dry-run reschedule-blocked-never-converges 4013 \
      "$nonconverging_output" >"$nonconverging_log" 2>&1; then
  fail "non-converging failed Job was accepted as rollout readiness"
fi
nonconverging_elapsed=$(( SECONDS - nonconverging_started ))
(( nonconverging_elapsed < 8 )) ||
  fail "terminal convergence used the longer execution deadline"
if [[ -d "$nonconverging_output" ]] &&
  find "$nonconverging_output" -type f -print -quit | grep -q .; then
  fail "non-converging failed Job persisted diagnostic evidence"
fi

delete_error_output="$work_dir/reschedule-blocked-delete-error"
delete_error_log="$work_dir/reschedule-blocked-delete-error.out"
if run_phase dry-run reschedule-blocked-delete-error 4014 \
    "$delete_error_output" >"$delete_error_log" 2>&1; then
  fail "delete-error blocker was accepted as rollout readiness"
fi
[[ -f "$delete_error_output/reports/preflight-event-reschedule.json" &&
   -f "$delete_error_output/reschedule-blocker-failure.json" &&
   -f "$delete_error_output/SHA256SUMS" ]] ||
  fail "Kubernetes Job deletion failure discarded blocker evidence"
(
  cd "$delete_error_output"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || fail "delete-error blocker evidence checksum is invalid"
[[ ! -e "$stub_state/deleted/live-data-event-4014-1" ]] ||
  fail "delete-error scenario unexpectedly reported successful Job deletion"

status_retry_output="$work_dir/reschedule-blocked-status-retry"
status_retry_log="$work_dir/reschedule-blocked-status-retry.out"
if run_phase dry-run reschedule-blocked-status-retry 4015 \
    "$status_retry_output" >"$status_retry_log" 2>&1; then
  fail "status-retry blocker was accepted as rollout readiness"
fi
[[ -e "$stub_state/pod-status-read-failed" &&
   -e "$stub_state/job-status-read-failed" ]] ||
  fail "status-retry scenario did not exercise both transient status failures"
[[ -f "$status_retry_output/reports/preflight-event-reschedule.json" &&
   -f "$status_retry_output/reschedule-blocker-failure.json" &&
   -f "$status_retry_output/SHA256SUMS" ]] ||
  fail "transient Kubernetes status failures discarded blocker evidence"
(
  cd "$status_retry_output"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || fail "status-retry blocker evidence checksum is invalid"

log_retry_output="$work_dir/reschedule-blocked-log-retry"
log_retry_log="$work_dir/reschedule-blocked-log-retry.out"
if run_phase dry-run reschedule-blocked-log-retry 4016 \
    "$log_retry_output" >"$log_retry_log" 2>&1; then
  fail "log-retry blocker was accepted as rollout readiness"
fi
[[ -e "$stub_state/log-read-failed" ]] ||
  fail "log-retry scenario did not exercise a transient partial log read"
[[ -f "$log_retry_output/reports/preflight-event-reschedule.json" &&
   -f "$log_retry_output/reschedule-blocker-failure.json" &&
   -f "$log_retry_output/SHA256SUMS" ]] ||
  fail "transient partial log failure discarded blocker evidence"
(
  cd "$log_retry_output"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || fail "log-retry blocker evidence checksum is invalid"

for blocked_scenario in \
  reschedule-blocked-changed \
  reschedule-blocked-multiple \
  reschedule-blocked-exception \
  reschedule-blocked-unknown-reason \
  reschedule-blocked-deadline \
  reschedule-blocked-signaled \
  reschedule-blocked-succeeded-deadline \
  reschedule-blocked-status-error \
  reschedule-blocked-log-error \
  reschedule-blocked-contradictory-success; do
  invalid_output="$work_dir/$blocked_scenario"
  invalid_log="$work_dir/$blocked_scenario.out"
  invalid_job_timeout=10
  [[ "$blocked_scenario" != "reschedule-blocked-status-error" ]] ||
    invalid_job_timeout=1
  invalid_terminal_grace=30
  [[ "$blocked_scenario" != "reschedule-blocked-log-error" ]] ||
    invalid_terminal_grace=1
  if JOB_TIMEOUT_OVERRIDE_SECONDS="$invalid_job_timeout" \
    JOB_TERMINAL_GRACE_OVERRIDE_SECONDS="$invalid_terminal_grace" \
    run_phase dry-run "$blocked_scenario" 4010 "$invalid_output" \
      >"$invalid_log" 2>&1; then
    fail "invalid blocked reschedule output was accepted: $blocked_scenario"
  fi
  if [[ -d "$invalid_output" ]] &&
    find "$invalid_output" -type f -print -quit | grep -q .; then
    fail "invalid blocked reschedule output persisted evidence: $blocked_scenario"
  fi
  if grep -R -E \
      'secret-user|mongodb://|private runtime detail' \
      "$invalid_output" "$invalid_log" 2>/dev/null | grep -q .; then
    fail "invalid blocked reschedule output leaked raw diagnostics: $blocked_scenario"
  fi
  [[ -e "$stub_state/deleted/live-data-event-4010-1" ]] ||
    fail "invalid blocked reschedule did not delete its Kubernetes Job: $blocked_scenario"
done

apply_blocked_output="$work_dir/reschedule-blocked-apply"
apply_blocked_log="$work_dir/reschedule-blocked-apply.out"
if run_phase apply-backfills reschedule-blocked-apply 4011 \
    "$apply_blocked_output" >"$apply_blocked_log" 2>&1; then
  fail "structured blocked reschedule apply was accepted as rollout readiness"
fi
apply_blocked_report="$apply_blocked_output/reports/apply-event-reschedule.json"
[[ -f "$apply_blocked_report" &&
   -f "$apply_blocked_output/reschedule-blocker-failure.json" &&
   -f "$apply_blocked_output/SHA256SUMS" ]] ||
  fail "blocked reschedule apply did not retain checksummed evidence"
jq -e '
  .mode == "apply" and
  .stage == "apply" and
  .state == "blocked" and
  .ready == false and
  .changed == 0 and
  .blockers[0].reasonCode == "event_or_slip_dependency"
' "$apply_blocked_report" >/dev/null ||
  fail "blocked reschedule apply evidence is invalid"
jq -e '
  .status == "FAIL" and
  .phase == "apply-backfills" and
  .stage == "apply" and
  .mode == "apply" and
  .changed == 0 and
  .job.exitCode == 1
' "$apply_blocked_output/reschedule-blocker-failure.json" >/dev/null ||
  fail "blocked reschedule apply failure envelope is invalid"
(
  cd "$apply_blocked_output"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || fail "blocked reschedule apply evidence checksum is invalid"
[[ ! -e "$apply_blocked_output/provenance.env" &&
   ! -e "$apply_blocked_output/journal.json" &&
   ! -e "$apply_blocked_output/schema.env" ]] ||
  fail "blocked reschedule apply emitted success-shaped evidence"
[[ -e "$stub_state/deleted/live-data-event-4011-21" ]] ||
  fail "blocked reschedule apply did not delete its Kubernetes Job"

backfill_output="$work_dir/backfills"
run_phase apply-backfills backfills 4002 "$backfill_output"
grep -Fxq 'schema_version=live-betting-v4' "$backfill_output/provenance.env"
grep -Fxq 'phase=apply-backfills' "$backfill_output/provenance.env"
grep -Fxq 'backfill_complete=true' "$backfill_output/provenance.env"
grep -Fxq 'event_reschedule_complete=true' "$backfill_output/provenance.env"
[[ ! -e "$backfill_output/schema.env" ]] ||
  fail "backfill phase emitted final schema evidence"

normal_baseline="$work_dir/normal-baseline"
normal_baseline_sha="$(make_resume_baseline "$normal_baseline" 4003 0)"
final_output="$work_dir/final"
run_phase apply-slip-index final 4003 "$final_output" 0 none "$normal_baseline_sha"
grep -Fxq 'schema_version=live-betting-v4' "$final_output/provenance.env"
grep -Fxq 'schema_version=live-betting-v4' "$final_output/schema.env"
grep -Fxq 'phase=apply-slip-index' "$final_output/provenance.env"
grep -Fxq 'backfill_complete=true' "$final_output/schema.env"
grep -Fxq 'index_ready=true' "$final_output/schema.env"
grep -Fxq 'event_reschedule_complete=true' "$final_output/schema.env"
grep -Fxq 'runtime_held_for_deploy=true' "$final_output/schema.env"
grep -Fxq 'operation_lock_handoff=true' "$final_output/schema.env"
grep -Fxq 'baseline_recovery_source_sha=none' "$final_output/schema.env"
normal_resolution="$(
  EVIDENCE_DIR="$final_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4003 \
  EXPECTED_RUN_ATTEMPT=1 \
  RESUME_BASELINE_DIR="$normal_baseline" \
  VERIFY_RESUME_APPLIED_RUN=true \
  RESUME_REPOSITORY=vasilyevstan/betstan \
  PATH="$stub_bin:$PATH" \
  STUB_RESUME_RUN_ID=4003 \
  STUB_RESUME_RUN_SOURCE="$SOURCE_SHA" \
  STUB_RESUME_REPOSITORY=vasilyevstan/betstan \
    "$VERIFIER"
)"
grep -Fxq \
  'schema_version=live-betting-data-resume-resolution-v1' \
  <<<"$normal_resolution"
grep -Fxq 'prerequisite_data_run_id=4003' <<<"$normal_resolution"
grep -Fxq 'applied_data_run_id=4003' <<<"$normal_resolution"
grep -Fxq "applied_source_sha=$SOURCE_SHA" <<<"$normal_resolution"

unknown_version_output="$work_dir/unknown-version"
cp -R "$final_output" "$unknown_version_output"
rm -f "$unknown_version_output/SHA256SUMS"
python3 - "$unknown_version_output" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("provenance.env", "schema.env"):
    path = root / name
    path.write_text(
        path.read_text(encoding="utf-8").replace(
            "schema_version=live-betting-v4",
            "schema_version=live-betting-v5",
        ),
        encoding="utf-8",
    )
journal_path = root / "journal.json"
journal = json.loads(journal_path.read_text(encoding="utf-8"))
journal["schema_version"] = "live-betting-v5"
journal_path.write_text(
    json.dumps(journal, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
write_manifest "$unknown_version_output"
if EVIDENCE_DIR="$unknown_version_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4003 \
  EXPECTED_RUN_ATTEMPT=1 \
    "$VERIFIER" >/dev/null 2>&1; then
  fail "unknown live betting evidence version was accepted"
fi

legacy_output="$work_dir/legacy-v1"
cp -R "$final_output" "$legacy_output"
rm -f "$legacy_output/SHA256SUMS"
mv \
  "$legacy_output/reports/preflight-event-reschedule.json" \
  "$legacy_output/reports/preflight-obsolete-event.json"
# Historical live-betting-v1 cleanup evidence stays pinned to the original
# obsolete event identity; it must not inherit a reschedule identity.
jq '
  {
    kind:"obsolete-event-cleanup",
    stage,
    mode:"dry-run",
    targetEventId:"6a623af592af5a95b1d0bb79",
    state:"removed",
    ready:true,
    scanned,
    matched:0,
    changed:0,
    errorCount:0,
    tombstoneVerified:true,
    snapshotDocumentCount,
    snapshotSha256,
    blockerCount:0,
    blockers:[]
  }
' "$legacy_output/reports/preflight-obsolete-event.json" \
  >"$legacy_output/reports/preflight-obsolete-event.json.tmp"
mv \
  "$legacy_output/reports/preflight-obsolete-event.json.tmp" \
  "$legacy_output/reports/preflight-obsolete-event.json"
python3 - "$legacy_output" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("provenance.env", "schema.env"):
    path = root / name
    text = path.read_text(encoding="utf-8")
    text = text.replace("schema_version=live-betting-v4", "schema_version=live-betting-v1")
    text = text.replace(
        "event_reschedule_complete=true",
        "obsolete_event_cleanup_complete=true",
    )
    path.write_text(text, encoding="utf-8")

journal_path = root / "journal.json"
journal = json.loads(journal_path.read_text(encoding="utf-8"))
journal["schema_version"] = "live-betting-v1"
journal["obsolete_event_cleanup_complete"] = journal.pop(
    "event_reschedule_complete"
)
journal["reports"] = [
    json.loads(path.read_text(encoding="utf-8"))
    for path in sorted((root / "reports").glob("*.json"))
]
journal_path.write_text(
    json.dumps(journal, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
write_manifest "$legacy_output"
EVIDENCE_DIR="$legacy_output" \
EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
EXPECTED_PHASE=apply-slip-index \
EXPECTED_RUN_ID=4003 \
EXPECTED_RUN_ATTEMPT=1 \
  "$VERIFIER" >/dev/null ||
  fail "v4 verifier rejected a valid historical v1 data artifact"

retained_v2_output="$work_dir/retained-v2"
cp -R "$final_output" "$retained_v2_output"
rm -f "$retained_v2_output/SHA256SUMS"
python3 - "$retained_v2_output" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("provenance.env", "schema.env"):
    path = root / name
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        "schema_version=live-betting-v4",
        "schema_version=live-betting-v2",
    )
    path.write_text(text, encoding="utf-8")

for path in sorted((root / "reports").glob("*-event-reschedule.json")):
    report = json.loads(path.read_text(encoding="utf-8"))
    report["targetEventId"] = "42643b4c173d1c7b8eeed765"
    report["targetKickoff"] = "2026-09-11T08:05:00.000Z"
    path.write_text(
        json.dumps(report, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

journal_path = root / "journal.json"
journal = json.loads(journal_path.read_text(encoding="utf-8"))
journal["schema_version"] = "live-betting-v2"
journal["reports"] = [
    json.loads(path.read_text(encoding="utf-8"))
    for path in sorted((root / "reports").glob("*.json"))
]
journal_path.write_text(
    json.dumps(journal, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
write_manifest "$retained_v2_output"
EVIDENCE_DIR="$retained_v2_output" \
EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
EXPECTED_PHASE=apply-slip-index \
EXPECTED_RUN_ID=4003 \
EXPECTED_RUN_ATTEMPT=1 \
  "$VERIFIER" >/dev/null ||
  fail "v4 verifier rejected a valid retained v2 data artifact"

retained_v3_output="$work_dir/retained-v3"
cp -R "$final_output" "$retained_v3_output"
rm -f "$retained_v3_output/SHA256SUMS"
python3 - "$retained_v3_output" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("provenance.env", "schema.env"):
    path = root / name
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        "schema_version=live-betting-v4",
        "schema_version=live-betting-v3",
    )
    path.write_text(text, encoding="utf-8")

for path in sorted((root / "reports").glob("*-event-reschedule.json")):
    report = json.loads(path.read_text(encoding="utf-8"))
    report["targetEventId"] = "eb4608ac531f5d9578113167"
    report["targetKickoff"] = "2026-09-12T08:05:00.000Z"
    path.write_text(
        json.dumps(report, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

journal_path = root / "journal.json"
journal = json.loads(journal_path.read_text(encoding="utf-8"))
journal["schema_version"] = "live-betting-v3"
journal["reports"] = [
    json.loads(path.read_text(encoding="utf-8"))
    for path in sorted((root / "reports").glob("*.json"))
]
journal_path.write_text(
    json.dumps(journal, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
write_manifest "$retained_v3_output"
EVIDENCE_DIR="$retained_v3_output" \
EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
EXPECTED_PHASE=apply-slip-index \
EXPECTED_RUN_ID=4003 \
EXPECTED_RUN_ATTEMPT=1 \
  "$VERIFIER" >/dev/null ||
  fail "v4 verifier rejected a valid retained v3 data artifact"

v1_as_v2_output="$work_dir/v1-as-v2"
cp -R "$legacy_output" "$v1_as_v2_output"
rm -f "$v1_as_v2_output/SHA256SUMS"
python3 - "$v1_as_v2_output" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("provenance.env", "schema.env"):
    path = root / name
    path.write_text(
        path.read_text(encoding="utf-8").replace(
            "schema_version=live-betting-v1",
            "schema_version=live-betting-v2",
        ),
        encoding="utf-8",
    )
journal_path = root / "journal.json"
journal = json.loads(journal_path.read_text(encoding="utf-8"))
journal["schema_version"] = "live-betting-v2"
journal_path.write_text(
    json.dumps(journal, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
write_manifest "$v1_as_v2_output"
if EVIDENCE_DIR="$v1_as_v2_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4003 \
  EXPECTED_RUN_ATTEMPT=1 \
    "$VERIFIER" >/dev/null 2>&1; then
  fail "v1 cleanup evidence was accepted after v2 schema substitution"
fi

v2_as_v3_output="$work_dir/v2-as-v3"
cp -R "$retained_v2_output" "$v2_as_v3_output"
rm -f "$v2_as_v3_output/SHA256SUMS"
python3 - "$v2_as_v3_output" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("provenance.env", "schema.env"):
    path = root / name
    path.write_text(
        path.read_text(encoding="utf-8").replace(
            "schema_version=live-betting-v2",
            "schema_version=live-betting-v3",
        ),
        encoding="utf-8",
    )
for path in sorted((root / "reports").glob("*-event-reschedule.json")):
    report = json.loads(path.read_text(encoding="utf-8"))
    report["targetEventId"] = "eb4608ac531f5d9578113167"
    report["targetKickoff"] = "2026-09-12T08:05:00.000Z"
    path.write_text(
        json.dumps(report, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
journal_path = root / "journal.json"
journal = json.loads(journal_path.read_text(encoding="utf-8"))
journal["schema_version"] = "live-betting-v3"
journal_path.write_text(
    json.dumps(journal, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
write_manifest "$v2_as_v3_output"
if EVIDENCE_DIR="$v2_as_v3_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4003 \
  EXPECTED_RUN_ATTEMPT=1 \
    "$VERIFIER" >/dev/null 2>&1; then
  fail "v2 Sep11 evidence was accepted after v3 schema substitution"
fi

v3_as_v2_output="$work_dir/v3-as-v2"
cp -R "$retained_v3_output" "$v3_as_v2_output"
rm -f "$v3_as_v2_output/SHA256SUMS"
python3 - "$v3_as_v2_output" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("provenance.env", "schema.env"):
    path = root / name
    path.write_text(
        path.read_text(encoding="utf-8").replace(
            "schema_version=live-betting-v3",
            "schema_version=live-betting-v2",
        ),
        encoding="utf-8",
    )
for path in sorted((root / "reports").glob("*-event-reschedule.json")):
    report = json.loads(path.read_text(encoding="utf-8"))
    report["targetEventId"] = "42643b4c173d1c7b8eeed765"
    report["targetKickoff"] = "2026-09-11T08:05:00.000Z"
    path.write_text(
        json.dumps(report, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
journal_path = root / "journal.json"
journal = json.loads(journal_path.read_text(encoding="utf-8"))
journal["schema_version"] = "live-betting-v2"
journal_path.write_text(
    json.dumps(journal, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
write_manifest "$v3_as_v2_output"
if EVIDENCE_DIR="$v3_as_v2_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4003 \
  EXPECTED_RUN_ATTEMPT=1 \
    "$VERIFIER" >/dev/null 2>&1; then
  fail "v3 Sep12 evidence was accepted after v2 schema substitution"
fi

v3_as_v4_output="$work_dir/v3-as-v4"
cp -R "$retained_v3_output" "$v3_as_v4_output"
rm -f "$v3_as_v4_output/SHA256SUMS"
python3 - "$v3_as_v4_output" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("provenance.env", "schema.env"):
    path = root / name
    path.write_text(
        path.read_text(encoding="utf-8").replace(
            "schema_version=live-betting-v3",
            "schema_version=live-betting-v4",
        ),
        encoding="utf-8",
    )
journal_path = root / "journal.json"
journal = json.loads(journal_path.read_text(encoding="utf-8"))
journal["schema_version"] = "live-betting-v4"
journal_path.write_text(
    json.dumps(journal, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
write_manifest "$v3_as_v4_output"
v3_as_v4_error="$work_dir/v3-as-v4.err"
if EVIDENCE_DIR="$v3_as_v4_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4003 \
  EXPECTED_RUN_ATTEMPT=1 \
    "$VERIFIER" >/dev/null 2>"$v3_as_v4_error"; then
  fail "v3 Sep12 evidence was accepted after v4 schema substitution"
fi
grep -Fq 'targets an unexpected event' "$v3_as_v4_error" ||
  fail "v3-to-v4 substitution did not fail on the generation identity"

v4_as_v3_output="$work_dir/v4-as-v3"
cp -R "$final_output" "$v4_as_v3_output"
rm -f "$v4_as_v3_output/SHA256SUMS"
python3 - "$v4_as_v3_output" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("provenance.env", "schema.env"):
    path = root / name
    path.write_text(
        path.read_text(encoding="utf-8").replace(
            "schema_version=live-betting-v4",
            "schema_version=live-betting-v3",
        ),
        encoding="utf-8",
    )
journal_path = root / "journal.json"
journal = json.loads(journal_path.read_text(encoding="utf-8"))
journal["schema_version"] = "live-betting-v3"
journal_path.write_text(
    json.dumps(journal, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
write_manifest "$v4_as_v3_output"
v4_as_v3_error="$work_dir/v4-as-v3.err"
if EVIDENCE_DIR="$v4_as_v3_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4003 \
  EXPECTED_RUN_ATTEMPT=1 \
    "$VERIFIER" >/dev/null 2>"$v4_as_v3_error"; then
  fail "v4 Sep13 evidence was accepted after v3 schema substitution"
fi
grep -Fq 'targets an unexpected event' "$v4_as_v3_error" ||
  fail "v4-to-v3 substitution did not fail on the generation identity"

original_applied_source=2222222222222222222222222222222222222222
chained_baseline="$work_dir/chained-baseline"
chained_baseline_sha="$(make_resume_baseline "$chained_baseline" 3999 0)"
chained_output="$work_dir/chained"
mkdir -p "$chained_output"
cat >"$chained_output/resume-authority.env" <<EOF
schema_version=live-betting-data-resume-v1
applied_data_run_id=3999
applied_source_sha=$original_applied_source
failed_deploy_run_id=4999
resume_maintenance_mode=released-runtime
failed_deploy_job_conclusion=success
public_validate_job_conclusion=failure
release_step_conclusion=success
rehold_step_conclusion=skipped
failed_activation_run_id=0
current_source_sha=$SOURCE_SHA
baseline_sha256=$chained_baseline_sha
runtime_images_sha256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
application_change_scope=github-infra-docs-only
status=PASS
EOF
run_phase apply-slip-index final 4008 "$chained_output" 0 none "$chained_baseline_sha"
chained_resolution="$(
  EVIDENCE_DIR="$chained_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4008 \
  EXPECTED_RUN_ATTEMPT=1 \
  RESUME_BASELINE_DIR="$chained_baseline" \
  VERIFY_RESUME_APPLIED_RUN=true \
  RESUME_REPOSITORY=vasilyevstan/betstan \
  PATH="$stub_bin:$PATH" \
  STUB_RESUME_RUN_ID=3999 \
  STUB_RESUME_RUN_SOURCE="$original_applied_source" \
  STUB_RESUME_REPOSITORY=vasilyevstan/betstan \
    "$VERIFIER"
)"
grep -Fxq 'prerequisite_data_run_id=4008' <<<"$chained_resolution"
grep -Fxq 'applied_data_run_id=3999' <<<"$chained_resolution"
grep -Fxq \
  "applied_source_sha=$original_applied_source" \
  <<<"$chained_resolution"

switched_source=3333333333333333333333333333333333333333
source_tampered_output="$work_dir/chained-source-tampered"
cp -R "$chained_output" "$source_tampered_output"
sed -i.bak \
  "s/^applied_source_sha=$original_applied_source$/applied_source_sha=$switched_source/" \
  "$source_tampered_output/resume-authority.env"
rm "$source_tampered_output/resume-authority.env.bak"
write_manifest "$source_tampered_output"
if EVIDENCE_DIR="$source_tampered_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4008 \
  EXPECTED_RUN_ATTEMPT=1 \
  RESUME_BASELINE_DIR="$chained_baseline" \
  VERIFY_RESUME_APPLIED_RUN=true \
  RESUME_REPOSITORY=vasilyevstan/betstan \
  PATH="$stub_bin:$PATH" \
  STUB_RESUME_RUN_ID=3999 \
  STUB_RESUME_RUN_SOURCE="$original_applied_source" \
  STUB_RESUME_REPOSITORY=vasilyevstan/betstan \
    "$VERIFIER" >/dev/null 2>&1; then
  fail "chained resume evidence switched the original applied source authority"
fi

tampered_chained_output="$work_dir/chained-tampered"
cp -R "$chained_output" "$tampered_chained_output"
sed -i.bak \
  's/^applied_data_run_id=3999$/applied_data_run_id=3998/' \
  "$tampered_chained_output/resume-authority.env"
rm "$tampered_chained_output/resume-authority.env.bak"
write_manifest "$tampered_chained_output"
if EVIDENCE_DIR="$tampered_chained_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4008 \
  EXPECTED_RUN_ATTEMPT=1 \
  RESUME_BASELINE_DIR="$chained_baseline" \
    "$VERIFIER" >/dev/null 2>&1; then
  fail "chained resume evidence switched the original applied data authority"
fi

cp "$final_output/schema.env" "$work_dir/schema.env"
printf 'index_ready=false\n' >>"$final_output/schema.env"
if EVIDENCE_DIR="$final_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4003 \
  EXPECTED_RUN_ATTEMPT=1 \
    "$VERIFIER" >/dev/null 2>&1; then
  fail "tampered schema evidence was accepted"
fi
mv "$work_dir/schema.env" "$final_output/schema.env"

if EVIDENCE_DIR="$final_output" \
  EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
  EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
  EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
  EXPECTED_PHASE=apply-slip-index \
  EXPECTED_RUN_ID=4003 \
  EXPECTED_RUN_ATTEMPT=1 \
  EXPECTED_BASELINE_RECOVERY_RUN_ID=799 \
    "$VERIFIER" >/dev/null 2>&1; then
  fail "data evidence accepted a switched recovery authority"
fi

duplicates_output="$work_dir/duplicates"
if run_phase dry-run duplicates 4004 "$duplicates_output" >/dev/null 2>&1; then
  fail "duplicate draft slips were accepted"
fi
if [[ -d "$duplicates_output" ]] &&
  grep -R -E 'secret-user|secret-slip' "$duplicates_output" >/dev/null; then
  fail "failed duplicate scan persisted raw identifiers"
fi

for manifest in "$stub_state"/jobs/*.yaml; do
  grep -Eq 'image: .+@sha256:[0-9a-f]{64}$' "$manifest" ||
    fail "job did not use an immutable image digest"
  grep -Fq 'automountServiceAccountToken: false' "$manifest" ||
    fail "job mounted a Kubernetes API token"
  grep -Fq 'kubernetes.io/arch: arm64' "$manifest" ||
    fail "job was not bound to the approved image architecture"
  grep -Fq 'runAsNonRoot: true' "$manifest" ||
    fail "job did not require a non-root identity"
  grep -Fq 'runAsUser: 1000' "$manifest" ||
    fail "job did not use the backend runtime UID"
  grep -Fq 'runAsGroup: 1000' "$manifest" ||
    fail "job did not use the backend runtime GID"
  grep -Fq 'readOnlyRootFilesystem: true' "$manifest" ||
    fail "job filesystem was writable"
  if grep -Fq 'src/scripts/' "$manifest"; then
    fail "job invoked TypeScript source instead of the compiled CLI"
  fi
done

image_pull_output="$work_dir/image-pull.out"
if run_phase dry-run image-pull 4005 "$work_dir/image-pull" \
    >"$image_pull_output" 2>&1; then
  fail "image pull failure was accepted"
fi
grep -Fq \
  'pod_count=1 pod_phase=Pending container_state=waiting reason=ImagePullBackOff' \
  "$image_pull_output" ||
  fail "image pull failure did not report sanitized pod state"
if grep -Fq 'secret registry detail' "$image_pull_output"; then
  fail "image pull diagnostics leaked the provider message"
fi

secret_error_output="$work_dir/secret-api-error.out"
if run_phase dry-run secret-api-error 4006 "$work_dir/secret-api-error" \
    >"$secret_error_output" 2>&1; then
  fail "Kubernetes secret API failure was treated as secret absence"
fi
grep -Fq 'could not determine whether the legacy OCIR pull secret exists' \
  "$secret_error_output" ||
  fail "Kubernetes secret API failure did not preserve the fail-closed reason"
[[ ! -d "$stub_state/jobs" || -z "$(find "$stub_state/jobs" -type f -print -quit)" ]] ||
  fail "secret API failure reached live data job creation"

for literal in \
  'validate_blocked_reschedule_report' \
  'write_reschedule_blocker_evidence' \
  'live-betting-reschedule-blocker-v1' \
  'structured-blocked' \
  'sanitized failure evidence recorded'; do
  grep -Fq "$literal" "$RUNNER" ||
    fail "data runner is missing structured reschedule failure contract: $literal"
done

for literal in \
  'name: oci-migration' \
  'DRY RUN LIVE DATA EXACT SHA' \
  'APPLY LIVE BACKFILLS EXACT SHA' \
  'APPLY LIVE SLIP INDEX EXACT SHA' \
  'RESUME APPLIED LIVE DATA EXACT SHA' \
  'RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME EXACT SHA' \
  'RESUME APPLIED LIVE DATA AND CLEAN FAILED ACTIVATION EXACT SHA' \
  'RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME AND CLEAN FAILED ACTIVATION EXACT SHA' \
  'production-run-exclusivity-stan.sh' \
  'shared-mongo-operation-lock-stan.sh acquire' \
  'shared-mongo-operation-lock-stan.sh release' \
  'shared-mongo-operation-lock-stan.sh renew' \
  'shared-mongo-operation-lock-stan.sh verify' \
  'live-data-maintenance-stan.sh enter' \
  'live-data-maintenance-stan.sh verify-held' \
  'live-data-maintenance-stan.sh verify-quiesced' \
  'live-data-maintenance-stan.sh hold' \
  'baseline-capture-stan.sh' \
  'Capture and validate pre-mutation rollback baseline' \
  "steps.operation_lock.outcome == 'success'" \
  'baseline_recovery_run_id:' \
  'oci-ghcr-cache-recovery.yml' \
  'ghcr-cache-recovery-' \
  'BASELINE_RECOVERY_DIR=artifacts/recovery' \
  'EXPECTED_BASELINE_RECOVERY_RUN_ID="$BASELINE_RECOVERY_RUN_ID"' \
  'Bind historical recovery source through its exact artifact' \
  'BASELINE_RECOVERY_SOURCE_SHA: ${{ steps.recovery_authority.outputs.source_sha || '\''none'\'' }}' \
  'failed_deploy_run_id:' \
  'attempts/1/jobs?per_page=100' \
  '.name == "deploy"' \
  '.name == "public-validate"' \
  'Release live data maintenance fence' \
  'Re-enter maintenance after an incomplete deployment' \
  'success:failure:success:skipped' \
  'failure:skipped:failure:success' \
  'failure:skipped:skipped:success' \
  'resume_maintenance_mode=released-runtime' \
  'resume_maintenance_mode=retained-hold' \
  'failed_activation_run_id:' \
  'failed_activation_user_id:' \
  'oci-production-baseline-${{ inputs.failed_deploy_run_id }}-1' \
  'oci-live-betting-activate.yml' \
  'oci-live-activation-${FAILED_ACTIVATION_RUN_ID}-1' \
  'Verify exact failed-deploy resume state' \
  'git merge-base --is-ancestor "$prior_source_sha" "$SOURCE_SHA"' \
  '.github/*|infra/*|*.md' \
  'Application path changed after applied data' \
  'EXPECTED_PHASE=apply-slip-index' \
  'OUTPUT_FILE=artifacts/oci-live-data-rollout/resume-images.tsv' \
  'expected_manifest=' \
  'endswith("@" + $manifest)' \
  'for service in auth backoffice client; do' \
  'Resume supporting pod image mismatch' \
  'RESUME_BASELINE_DIR=artifacts/oci-data-baseline-before' \
  'VERIFY_RESUME_APPLIED_RUN=true' \
  'RESUME_REPOSITORY="$REPOSITORY"' \
  'resume_applied_data_run_id' \
  'resume_applied_source_sha' \
  'RESOLVED_APPLIED_DATA_RUN_ID: ${{ steps.provenance.outputs.resume_applied_data_run_id }}' \
  'RESOLVED_APPLIED_SOURCE_SHA: ${{ steps.provenance.outputs.resume_applied_source_sha }}' \
  'applied_data_run_id=$RESOLVED_APPLIED_DATA_RUN_ID' \
  'applied_source_sha=$RESOLVED_APPLIED_SOURCE_SHA' \
  'EXPECTED_SOURCE_SHA="$expected_baseline_source_sha"' \
  'EXPECTED_RECOVERY_RUN_ID="$expected_recovery_run_id"' \
  'restore_or_verify_retained_hold' \
  'Delete exact orphaned live-acceptance slips' \
  'cleanup-live-acceptance-slips-stan.sh' \
  'EXPECTED_AUTH_USER_COUNT=0' \
  'ALLOWED_BET_KINDS=LIVE,PRE_MATCH' \
  'MAX_ACTIVE_SLIPS=2' \
  'runtime_images_sha256=' \
  'application_change_scope=github-infra-docs-only' \
  'validate-rollback-baseline-stan.sh' \
  'SSE_REQUIREMENT: deployed-source' \
  'SHARED_MONGO_LOCK_LEASE_SECONDS: "14400"' \
  'SHARED_MONGO_HANDOFF_LOCK_LEASE_SECONDS: "1800"' \
  '(failure() || cancelled())' \
  "steps.maintenance_enter.outcome == 'success'" \
  'Require executed data-step evidence' \
  "steps.data.outcome != 'skipped'" \
  'test -f artifacts/oci-live-data-rollout/evidence/SHA256SUMS' \
  'verify-live-betting-data-evidence-stan.sh'; do
  grep -Fq "$literal" "$WORKFLOW" ||
    fail "data workflow is missing safety contract: $literal"
done
[[ "$(grep -Fc 'SSE_REQUIREMENT: deployed-source' "$WORKFLOW")" == "2" ]] ||
  fail "data workflow does not source-gate both baseline SSE checks"
for literal in \
  'data_run_id:' \
  'baseline_recovery_run_id:' \
  'baseline_recovery_source_sha:' \
  'oci-ghcr-cache-recovery.yml' \
  'ghcr-cache-recovery-${BASELINE_RECOVERY_SOURCE_SHA}-${BASELINE_RECOVERY_RUN_ID}-1' \
  'oci-live-data-rollout.yml' \
  'EXPECTED_PHASE=apply-slip-index' \
  'EXPECTED_BASELINE_RECOVERY_RUN_ID="$BASELINE_RECOVERY_RUN_ID"' \
  'EXPECTED_BASELINE_RECOVERY_SOURCE_SHA="$BASELINE_RECOVERY_SOURCE_SHA"' \
  'artifacts/data/schema.env' \
  'shared-mongo-operation-lock-stan.sh verify' \
  'live-data-maintenance-stan.sh verify-held' \
  'live-data-maintenance-stan.sh release' \
  'live-data-maintenance-stan.sh hold' \
  "steps.handoff.outcome == 'success'"; do
  grep -Fq "$literal" "$DEPLOY_WORKFLOW" ||
    fail "deploy workflow is missing data prerequisite: $literal"
done
[[ -x "$MAINTENANCE" ]] ||
  fail "maintenance operator is not executable"

python3 - "$WORKFLOW" "$DEPLOY_WORKFLOW" <<'PY'
import sys
from pathlib import Path

data = Path(sys.argv[1]).read_text(encoding="utf-8")
deploy = Path(sys.argv[2]).read_text(encoding="utf-8")


def require_order(text: str, markers: list[str], label: str) -> None:
    positions = []
    for marker in markers:
        position = text.find(marker)
        if position < 0:
            raise SystemExit(f"{label} is missing ordered marker: {marker}")
        positions.append(position)
    if positions != sorted(positions):
        raise SystemExit(f"{label} safety operations are out of order")


require_order(
    data,
    [
        "Verify exact failed-deploy resume state",
        "Capture and validate pre-mutation rollback baseline",
        "Acquire database operation lock",
        "Enter or re-establish live data maintenance",
        "Delete exact orphaned live-acceptance slips",
        "Execute exact-digest live data phase",
        "Restore runtime or verify final deploy handoff",
        "shared-mongo-operation-lock-stan.sh renew",
        "Upload exact sanitized data evidence",
        "Restore runtime or retain hold if final handoff packaging failed",
        "Release database operation lock unless handed to deploy",
    ],
    "data workflow",
)
require_order(
    deploy,
    [
        "Download exact live data readiness evidence",
        "Download exact pre-mutation rollback baseline",
        "Verify immutable image and infrastructure provenance",
        "Verify transferred database lock and maintenance fence",
        "Deploy immutable images sequentially",
        "Bind schema evidence to deployment provenance",
        "Run protected OCI cluster validation loop",
        "Release transferred lock after protected validation",
        "Release live data maintenance fence",
        "Re-enter maintenance after an incomplete deployment",
    ],
    "deploy workflow",
)
for literal in (
    "SHARED_MONGO_LOCK_TOKEN: live-data-${{ github.run_id }}-${{ github.run_attempt }}",
    "SHARED_MONGO_LOCK_OPERATION: live-data-${{ inputs.phase }}",
    "OPERATION_LOCK_HANDOFF: ${{ inputs.phase == 'apply-slip-index' }}",
    "FAILED_DEPLOY_RUN_ID: ${{ inputs.failed_deploy_run_id }}",
    "FAILED_ACTIVATION_RUN_ID: ${{ inputs.failed_activation_run_id }}",
    "FAILED_ACTIVATION_USER_ID: ${{ inputs.failed_activation_user_id }}",
    "if: inputs.failed_deploy_run_id != '0'",
    "if: inputs.failed_activation_run_id != '0'",
    "failed_deploy_run_id=$FAILED_DEPLOY_RUN_ID",
    "failed_activation_run_id=$FAILED_ACTIVATION_RUN_ID",
):
    if literal not in data:
        raise SystemExit(f"data workflow is missing lock handoff contract: {literal}")

resume = data[
    data.index("- name: Verify exact failed-deploy resume state"):
    data.index("- name: Capture and validate pre-mutation rollback baseline")
]
require_order(
    resume,
    [
        "for service in auth bet backoffice client event gamemaster moderation resulting slip; do",
        "Resume deployment image mismatch",
        'case "$RESUME_MAINTENANCE_MODE" in',
        "released-runtime)",
        "retained-hold)",
        "live-data-maintenance-stan.sh verify-quiesced",
        "for service in auth backoffice client; do",
        "kubectl rollout status",
        "Resume supporting pod image mismatch",
    ],
    "failed-deploy resume",
)
if "Resume pod image mismatch" in resume:
    raise SystemExit("failed-deploy resume still requires pods for quiesced writers")
if '[ "$(baseline_value baseline_capture_run_id)" = "$PREREQUISITE_RUN_ID" ]' in resume:
    raise SystemExit(
        "failed-deploy resume still rejects a checksum-bound chained authority"
    )

maintenance = data[
    data.index("- name: Enter or re-establish live data maintenance"):
    data.index("- name: Delete exact orphaned live-acceptance slips")
]
for literal in (
    'if [ "$FAILED_DEPLOY_RUN_ID" = "0" ] ||',
    '[ "$RESUME_MAINTENANCE_MODE" = "released-runtime" ]',
    '[ "$RESUME_MAINTENANCE_MODE" = "retained-hold" ]',
    "live-data-maintenance-stan.sh enter",
    "live-data-maintenance-stan.sh hold",
):
    if literal not in maintenance:
        raise SystemExit(
            f"data workflow does not re-establish failed-deploy maintenance: {literal}"
        )

handoff = data[
    data.index("- name: Restore runtime or verify final deploy handoff"):
    data.index("- name: Capture post-phase runtime baseline")
]
for literal in (
    'if [ "$FAILED_DEPLOY_RUN_ID" = "0" ] ||',
    '[ "$RESUME_MAINTENANCE_MODE" = "released-runtime" ]',
    '[ "$RESUME_MAINTENANCE_MODE" = "retained-hold" ]',
    "live-data-maintenance-stan.sh restore",
    "live-data-maintenance-stan.sh verify-held",
):
    if literal not in handoff:
        raise SystemExit(
            f"data workflow does not restore released runtime after phase failure: {literal}"
        )

abort = data[
    data.index("- name: Restore runtime or retain hold if final handoff packaging failed"):
    data.index("- name: Release database operation lock unless handed to deploy")
]
for literal in (
    'if [ "$FAILED_DEPLOY_RUN_ID" = "0" ] ||',
    '[ "$RESUME_MAINTENANCE_MODE" = "released-runtime" ]',
    '[ "$RESUME_MAINTENANCE_MODE" = "retained-hold" ]',
    "live-data-maintenance-stan.sh restore",
    "live-data-maintenance-stan.sh verify-held",
):
    if literal not in abort:
        raise SystemExit(
            f"data workflow does not retain a failed-deploy hold on abort: {literal}"
        )

resume_mode_env = (
    "RESUME_MAINTENANCE_MODE: "
    "${{ steps.provenance_request.outputs.resume_maintenance_mode || 'none' }}"
)
if data.count(resume_mode_env) != 3:
    raise SystemExit(
        "data workflow must bind the resume maintenance mode to exactly three "
        "maintenance and cleanup steps"
    )

for literal in (
    "EXPECTED_OPERATION_LOCK_HOLDER: live-data-${{ inputs.data_run_id }}-1",
    "EXPECTED_OPERATION_LOCK_ID: live-data-apply-slip-index",
    "EXPECTED_OPERATION_LOCK_SOURCE_SHA: ${{ inputs.approved_sha }}",
    'OCI_EXPECT_HTTP_MUTATION_FENCE: "1"',
    "shared-mongo-operation-lock-stan.sh verify-released",
):
    if literal not in deploy:
        raise SystemExit(f"deploy workflow is missing fenced validation contract: {literal}")

deploy_lines = deploy.splitlines()
acquire_indexes = [
    index
    for index, line in enumerate(deploy_lines)
    if "shared-mongo-operation-lock-stan.sh acquire" in line
]
if len(acquire_indexes) != 2:
    raise SystemExit("deploy workflow must have exactly two guarded lock acquisitions")
for index in acquire_indexes:
    invocation = "\n".join(deploy_lines[max(0, index - 6) : index + 1])
    if (
        'LOCK_LEASE_SECONDS="$SHARED_MONGO_DEPLOY_LOCK_LEASE_SECONDS"'
        not in invocation
    ):
        raise SystemExit("deploy lock acquisition is missing the bounded deploy lease")
if sum(
    "shared-mongo-operation-lock-stan.sh renew" in line
    for line in deploy_lines
) != 2:
    raise SystemExit("deploy workflow must renew each verified lock path exactly once")
PY

echo "live_betting_data_rollout_tests=PASS"
