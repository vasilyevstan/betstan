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

cat >"$stub_bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

state="${STUB_STATE_DIR:?}"
scenario="${STUB_SCENARIO:?}"
mkdir -p "$state/jobs" "$state/applied"

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
    namespace|service|secret)
      printf '{}\n'
      exit 0
      ;;
    job)
      if [[ "$scenario" == "image-pull" ]]; then
        printf '{"status":{}}\n'
      else
        printf '{"status":{"succeeded":1}}\n'
      fi
      exit 0
      ;;
    deployment)
      printf '0|0|0|0'
      exit 0
      ;;
    pods)
      if [[ "$scenario" == "image-pull" && "$*" == *"job-name="* ]]; then
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

if [[ "${1:-}" == "delete" || "${1:-}" == "rollout" || "${1:-}" == "exec" ]]; then
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 1
SH
chmod +x "$stub_bin/kubectl"

for service in auth bet backoffice client event gamemaster moderation resulting slip; do
  printf '%s\tregistry.example/betstan\tregistry.example/betstan@sha256:%064d\tsha256:%064d\tsha256:%064d\n' \
    "$service" 1 1 1 >>"$images_file"
done

run_phase() {
  local phase="$1"
  local scenario="$2"
  local run_id="$3"
  local output="$4"
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
  JOB_TIMEOUT_SECONDS=10 \
  GITHUB_RUN_ID="$run_id" \
  GITHUB_RUN_ATTEMPT=1 \
  BASELINE_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  MAINTENANCE_FENCE_ENFORCED="$maintenance_fence" \
  WRITERS_QUIESCED="$writers_quiesced" \
  RUNTIME_HELD_FOR_DEPLOY="$runtime_handoff" \
  OPERATION_LOCK_ENFORCED=true \
  OPERATION_LOCK_HANDOFF="$lock_handoff" \
    "$RUNNER" >/dev/null
}

pending_output="$work_dir/pending"
run_phase dry-run pending 4001 "$pending_output"
grep -Fxq 'phase=dry-run' "$pending_output/provenance.env"
grep -Fxq 'backfill_complete=false' "$pending_output/provenance.env"
grep -Fxq 'index_ready=false' "$pending_output/provenance.env"
[[ ! -e "$pending_output/schema.env" ]] ||
  fail "dry-run emitted final schema evidence"
if grep -R -E 'secret-user|secret-slip|mongodb://' "$pending_output" >/dev/null; then
  fail "sanitized dry-run evidence leaked sensitive data"
fi

backfill_output="$work_dir/backfills"
run_phase apply-backfills backfills 4002 "$backfill_output"
grep -Fxq 'phase=apply-backfills' "$backfill_output/provenance.env"
grep -Fxq 'backfill_complete=true' "$backfill_output/provenance.env"
[[ ! -e "$backfill_output/schema.env" ]] ||
  fail "backfill phase emitted final schema evidence"

final_output="$work_dir/final"
run_phase apply-slip-index final 4003 "$final_output"
grep -Fxq 'phase=apply-slip-index' "$final_output/provenance.env"
grep -Fxq 'backfill_complete=true' "$final_output/schema.env"
grep -Fxq 'index_ready=true' "$final_output/schema.env"
grep -Fxq 'runtime_held_for_deploy=true' "$final_output/schema.env"
grep -Fxq 'operation_lock_handoff=true' "$final_output/schema.env"
EVIDENCE_DIR="$final_output" \
EXPECTED_SOURCE_SHA="$SOURCE_SHA" \
EXPECTED_BUILD_RUN_ID="$BUILD_RUN_ID" \
EXPECTED_INFRASTRUCTURE_RUN_ID="$INFRASTRUCTURE_RUN_ID" \
EXPECTED_PHASE=apply-slip-index \
EXPECTED_RUN_ID=4003 \
EXPECTED_RUN_ATTEMPT=1 \
  "$VERIFIER" >/dev/null

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

for literal in \
  'name: oci-migration' \
  'DRY RUN LIVE DATA EXACT SHA' \
  'APPLY LIVE BACKFILLS EXACT SHA' \
  'APPLY LIVE SLIP INDEX EXACT SHA' \
  'production-run-exclusivity-stan.sh' \
  'shared-mongo-operation-lock-stan.sh acquire' \
  'shared-mongo-operation-lock-stan.sh release' \
  'shared-mongo-operation-lock-stan.sh renew' \
  'shared-mongo-operation-lock-stan.sh verify' \
  'live-data-maintenance-stan.sh enter' \
  'live-data-maintenance-stan.sh verify-held' \
  'baseline-capture-stan.sh' \
  'SSE_REQUIREMENT: deployed-source' \
  'SHARED_MONGO_LOCK_LEASE_SECONDS: "14400"' \
  'SHARED_MONGO_HANDOFF_LOCK_LEASE_SECONDS: "1800"' \
  '(failure() || cancelled())' \
  "steps.maintenance_enter.outcome == 'success'" \
  'verify-live-betting-data-evidence-stan.sh'; do
  grep -Fq "$literal" "$WORKFLOW" ||
    fail "data workflow is missing safety contract: $literal"
done
[[ "$(grep -Fc 'SSE_REQUIREMENT: deployed-source' "$WORKFLOW")" == "2" ]] ||
  fail "data workflow does not source-gate both baseline SSE checks"
for literal in \
  'data_run_id:' \
  'oci-live-data-rollout.yml' \
  'EXPECTED_PHASE=apply-slip-index' \
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
        "Acquire database operation lock",
        "Capture pre-mutation rollback baseline",
        "Fence writes and quiesce legacy data writers",
        "Execute exact-digest live data phase",
        "Restore runtime or verify final deploy handoff",
        "shared-mongo-operation-lock-stan.sh renew",
        "Upload exact sanitized data evidence",
        "Restore runtime if final handoff packaging failed",
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
):
    if literal not in data:
        raise SystemExit(f"data workflow is missing lock handoff contract: {literal}")
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
