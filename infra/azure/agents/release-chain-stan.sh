#!/usr/bin/env bash
# Purpose: run CLI-owned protected release stages as one bounded command
#          instead of a manual enable/dispatch/disable/approve/watch sequence.
# Usage (from a clean checkout detached at the request's controlSha, which must
# be the current master tip):
#   ./infra/azure/agents/release-chain-stan.sh /absolute/path/request.json
#   ./infra/azure/agents/release-chain-stan.sh /absolute/path/live-data.json --chain
# One request runs one stage. --chain starts from an oci-live-data-* request and
# then derives the oci-production-deploy and oci-live-betting-activate requests
# from its inputs and the previous run ID (written beside it, mode 600), so the
# deploy is dispatched well inside the 1,800-second handoff lease.
# Each stage: prepare disabled ghosts for the two frozen transition workflows,
# enable the workflow, dispatch with the canonical dispatcher, disable the
# workflow once the exact run reaches its pending environment gate (or
# completes), submit eligible CLI-owned gates through the canonical approval
# helper, and wait for the conclusion. A workflow the policy keeps active
# (approvalWorkflowState=active, e.g. ghcr-package-management.yml) is
# dispatched and approved as is: never enabled or disabled. Every other exit
# disables the workflow,
# except a dispatched run that never materialized: disabling it could strand
# that run, so the workflow is left enabled with an explicit warning (no gate
# can be approved while it is enabled). This helper grants no authority: the
# dispatcher, policy, approval helper and workflow gates decide. It never
# cancels, reruns or replays a run.
# Exit: 0 success, 1 run failed or timed out, 2 not started, unconfirmed
# dispatch or unproven materialization (follow next_action; never replay).
set -euo pipefail

ROOT_DIR="$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
AGENTS_DIR="$ROOT_DIR/infra/azure/agents"
DISPATCHER="$AGENTS_DIR/copilot-cli-dispatch-stan.sh"
POLICY="$AGENTS_DIR/copilot-cli-protected-operation-policy-stan.sh"
APPROVER="$AGENTS_DIR/copilot-cli-run-approval-stan.sh"
EXCLUSIVITY="$AGENTS_DIR/production-run-exclusivity-stan.sh"
REPO="${REPO:-vasilyevstan/betstan}"
POLL_SECONDS="${RELEASE_CHAIN_POLL_SECONDS:-15}"
JOB_POLL_SECONDS="${RELEASE_CHAIN_JOB_POLL_SECONDS:-5}"
START_SECONDS="${RELEASE_CHAIN_START_SECONDS:-600}"
RUN_SECONDS="${RELEASE_CHAIN_RUN_SECONDS:-3600}"
EXCLUSIVE_SECONDS="${RELEASE_CHAIN_EXCLUSIVE_SECONDS:-2700}"
HEARTBEAT_SECONDS="${RELEASE_CHAIN_HEARTBEAT_SECONDS:-300}"

REQUEST="${1:-}"
MODE="${2:-}"
ACTIVE_WORKFLOW=""
UNMATERIALIZED_RUN=""
LAST_RUN_ID=""
cd "$ROOT_DIR"

log() { printf 'release_chain %s\n' "$*"; }

stop() {
  local code="$1"
  shift
  log "result=BLOCK $*"
  exit "$code"
}

cleanup() {
  if [[ -n "$UNMATERIALIZED_RUN" ]]; then
    log "warning=workflow-left-enabled workflow=$ACTIVE_WORKFLOW run_id=$UNMATERIALIZED_RUN" \
      "next=disable it once that run has a pending gate or completes; never replay"
  elif [[ -n "$ACTIVE_WORKFLOW" ]]; then
    gh workflow disable "$ACTIVE_WORKFLOW" -R "$REPO" >/dev/null 2>&1 ||
      log "warning=disable-failed workflow=$ACTIVE_WORKFLOW (disable it now)"
  fi
}
trap cleanup EXIT

json_field() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"
}

# Must match the dispatcher's frozen prepared-transition allowlist; the
# dispatcher rejects any mismatch, so this choice cannot widen authority.
is_transition_workflow() {
  case "$1" in
    oci-live-data-rollout.yml|oci-live-betting-activate.yml) return 0 ;;
    *) return 1 ;;
  esac
}

wait_exclusive() {
  local deadline=$((SECONDS + EXCLUSIVE_SECONDS)) output announced=0
  while :; do
    output="$(REPO="$REPO" "$EXCLUSIVITY" 2>&1)" || true
    [[ "$output" == *"production_run_exclusivity=PASS"* ]] && return 0
    ((SECONDS < deadline)) || stop 2 "reason=exclusivity-timeout"
    if ((announced == 0)); then
      log "waiting=production-exclusivity detail=\"$(printf '%s\n' "$output" | tail -1)\""
      announced=1
    fi
    sleep "$POLL_SECONDS"
  done
}

derive_request() {
  python3 - "$@" <<'PY'
import json, os, sys

source, run_id, operation, target = sys.argv[1:5]
request = json.load(open(source))
inputs = request["inputs"]
if operation == "oci-production-deploy":
    derived = {key: inputs[key] for key in ("approved_sha", "build_run_id", "infrastructure_run_id")}
    derived["data_run_id"] = run_id
    for key in ("checkpoint_source_sha", "disk_checkpoint_run_id",
                "baseline_recovery_run_id", "baseline_recovery_source_sha"):
        derived[key] = inputs[key]
    derived["confirmation"] = "DEPLOY OCI EXACT SHA"
else:
    derived = {key: inputs[key] for key in ("approved_sha", "build_run_id", "infrastructure_run_id")}
    derived["deployment_run_id"] = run_id
    derived["confirmation"] = "ACTIVATE OCI LIVE BETTING"
request["operation"] = operation
request["inputs"] = derived
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w") as handle:
    json.dump(request, handle, indent=2)
    handle.write("\n")
PY
}

run_stage() {
  local request="$1" operation workflow expected_state output run_id mode deadline
  local state conclusion step began next_heartbeat next_approval=0 pending failed
  operation="$(json_field "$request" operation)"
  # The policy says whether the workflow is kept disabled between runs or, like
  # ghcr-package-management.yml, stays active and is approved while active.
  read -r workflow expected_state < <("$POLICY" get "$operation" |
    python3 -c 'import json, sys; p = json.load(sys.stdin); print(p["workflow"], p.get("approvalWorkflowState", "disabled_manually"))') ||
    stop 2 "reason=policy-unresolved operation=$operation"
  [[ -n "$workflow" && "$expected_state" =~ ^(active|disabled_manually)$ ]] ||
    stop 2 "reason=policy-unresolved operation=$operation"
  state="$(gh api "repos/$REPO/actions/workflows/$workflow" --jq .state)" ||
    stop 2 "reason=workflow-state-unreadable workflow=$workflow"
  [[ "$state" == "$expected_state" ]] || stop 2 "reason=workflow-not-${expected_state%_manually} workflow=$workflow"

  mode="--dispatch"
  if is_transition_workflow "$workflow"; then
    mode="--dispatch-prepared"
    output="$("$DISPATCHER" "$request" --prepare-disabled-ghosts 2>&1)" || {
      printf '%s\n' "$output" | tail -3
      stop 2 "reason=prepare-failed operation=$operation"
    }
  fi

  if [[ "$expected_state" == disabled_manually ]]; then
    ACTIVE_WORKFLOW="$workflow"
    gh workflow enable "$workflow" -R "$REPO" >/dev/null || stop 2 "reason=enable-failed workflow=$workflow"
  fi
  output="$("$DISPATCHER" "$request" "$mode" 2>&1)" || {
    printf '%s\n' "$output" | tail -3
    stop 2 "reason=dispatch-unconfirmed operation=$operation"
  }
  run_id="$(printf '%s\n' "$output" | sed -n 's/.*dispatch=ACCEPTED run_id=\([0-9][0-9]*\).*/\1/p' | tail -1)"
  [[ -n "$run_id" ]] || {
    printf '%s\n' "$output" | tail -3
    stop 2 "reason=dispatch-unconfirmed operation=$operation"
  }
  began="$SECONDS"
  log "stage=$operation run_id=$run_id dispatched"

  # Disable only once the exact run has materialized (its expected pending
  # environment, or completion), then approve with the workflow disabled.
  if [[ "$expected_state" == disabled_manually ]]; then
    UNMATERIALIZED_RUN="$run_id"
    deadline=$((SECONDS + START_SECONDS))
    while :; do
      pending="$(gh api "repos/$REPO/actions/runs/$run_id/pending_deployments" --jq length 2>/dev/null)" || pending=0
      ((pending > 0)) && break
      state="$(gh run view "$run_id" -R "$REPO" --json status --jq .status 2>/dev/null)" || state=unknown
      [[ "$state" == "completed" ]] && break
      ((SECONDS < deadline)) || stop 2 "reason=materialization-unproven operation=$operation run_id=$run_id"
      sleep "$JOB_POLL_SECONDS"
    done
    UNMATERIALIZED_RUN=""
    gh workflow disable "$workflow" -R "$REPO" >/dev/null || stop 2 "reason=disable-failed-run-waiting-unapproved workflow=$workflow run_id=$run_id"
    ACTIVE_WORKFLOW=""
  fi

  deadline=$((SECONDS + RUN_SECONDS))
  next_heartbeat=$((SECONDS + HEARTBEAT_SECONDS))
  while :; do
    # A transient read failure is unknown, not a failed run: keep polling.
    if ! IFS='|' read -r state conclusion step < <(gh run view "$run_id" -R "$REPO" --json status,conclusion,jobs \
      --jq '[.status, (.conclusion // ""), ([.jobs[].steps[]? | select(.status == "in_progress") | .name] | first // "")] | join("|")' 2>/dev/null); then
      state=unknown conclusion="" step=""
    fi
    [[ "$state" == "completed" ]] && break
    ((SECONDS < deadline)) || stop 1 "reason=run-timeout operation=$operation run_id=$run_id step=\"$step\""
    pending="$(gh api "repos/$REPO/actions/runs/$run_id/pending_deployments" --jq length 2>/dev/null)" || pending=0
    if ((pending > 0 && SECONDS >= next_approval)); then
      if output="$(COPILOT_CLI_AUTO_APPROVE=true EXPECTED_OPERATION="$operation" "$APPROVER" "$run_id" --approve 2>&1)"; then
        log "stage=$operation run_id=$run_id gate=approved"
      else
        log "stage=$operation run_id=$run_id gate=not-approved detail=\"$(printf '%s\n' "$output" | tail -1)\""
      fi
      next_approval=$((SECONDS + 60))
    fi
    if ((SECONDS >= next_heartbeat)); then
      log "stage=$operation run_id=$run_id elapsed=$(((SECONDS - began) / 60))m step=\"$step\""
      next_heartbeat=$((SECONDS + HEARTBEAT_SECONDS))
    fi
    sleep "$POLL_SECONDS"
  done

  if [[ "$conclusion" != "success" ]]; then
    # shellcheck disable=SC2016 # jq variables, not shell expansion
    failed="$(gh run view "$run_id" -R "$REPO" --json jobs \
      --jq '[.jobs[] | .name as $job | .steps[]? | select(.conclusion == "failure") | "\($job)/\(.name)"] | join("; ")')" || failed=unknown
    log "stage=$operation run_id=$run_id result=FAILED conclusion=$conclusion failed=\"$failed\""
    log "next=read 'gh run view $run_id -R $REPO --log-failed', fix at a new master SHA"
    exit 1
  fi
  log "stage=$operation run_id=$run_id result=SUCCESS minutes=$(((SECONDS - began) / 60))"
  LAST_RUN_ID="$run_id"
}

[[ "$REQUEST" == /* && -f "$REQUEST" ]] || stop 2 "reason=usage request must be an absolute file path"
[[ -z "$MODE" || "$MODE" == "--chain" ]] || stop 2 "reason=usage second argument must be --chain"
if [[ "$MODE" == "--chain" ]]; then
  [[ "$(json_field "$REQUEST" operation)" == oci-live-data-* ]] ||
    stop 2 "reason=chain-must-start-with-live-data"
  # Deploy binds only an apply-slip-index handoff without a recovery baseline
  # (that belongs to oci-production-deploy-recovered); refuse before any stage.
  python3 -c '
import json, sys
inputs = json.load(open(sys.argv[1]))["inputs"]
sys.exit(not (inputs.get("phase") == "apply-slip-index"
              and inputs.get("baseline_recovery_run_id") == "0"
              and inputs.get("baseline_recovery_source_sha") == "none"))' "$REQUEST" ||
    stop 2 "reason=chain-needs-apply-slip-index-without-recovery-baseline"
fi
control_sha="$(json_field "$REQUEST" controlSha)"
[[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" == "$control_sha" && -z "$(git -C "$ROOT_DIR" status --porcelain)" ]] ||
  stop 2 "reason=checkout-not-clean-at-control-sha"
master_sha="$(gh api "repos/$REPO/commits/master" --jq .sha)" || stop 2 "reason=master-unreadable"
[[ "$master_sha" == "$control_sha" ]] || stop 2 "reason=control-sha-not-master-tip master=$master_sha"

wait_exclusive
run_stage "$REQUEST"
if [[ "$MODE" == "--chain" ]]; then
  request_dir="$(dirname "$REQUEST")"
  deploy_request="$request_dir/oci-production-deploy-$LAST_RUN_ID.json"
  derive_request "$REQUEST" "$LAST_RUN_ID" oci-production-deploy "$deploy_request"
  run_stage "$deploy_request"
  activate_request="$request_dir/oci-live-betting-activate-$LAST_RUN_ID.json"
  derive_request "$deploy_request" "$LAST_RUN_ID" oci-live-betting-activate "$activate_request"
  run_stage "$activate_request"
fi
log "result=SUCCESS control_sha=$control_sha"
