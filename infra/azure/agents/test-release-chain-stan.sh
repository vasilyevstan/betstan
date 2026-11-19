#!/usr/bin/env bash
set -euo pipefail
# Skip when the CI diff cannot affect this suite (infra/ci/suite_gate.py).
betstan_gate="$(dirname "${BASH_SOURCE[0]}")/../../ci/suite_gate.py"; betstan_gate_rc=0
[[ ! -f "$betstan_gate" ]] || python3 -I "$betstan_gate" "${BASH_SOURCE[0]}" || betstan_gate_rc=$?
[[ "$betstan_gate_rc" != 3 ]] || exit 0; [[ "$betstan_gate_rc" == 0 ]] || exit "$betstan_gate_rc"; export BETSTAN_SUITE_GATE_PASSED=1

# Stubbed contract for release-chain-stan.sh: canonical helpers are replaced in
# a throwaway checkout so no GitHub or production call can happen.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNNER_SOURCE="$ROOT_DIR/infra/azure/agents/release-chain-stan.sh"
WORK="$ROOT_DIR/.test-workdirs/release-chain.$$"
trap 'rm -rf "$WORK"' EXIT
CHECKOUT="$WORK/checkout"
AGENTS="$CHECKOUT/infra/azure/agents"
REQUESTS="$WORK/requests"
BIN="$WORK/bin"
LOG="$WORK/calls.log"
mkdir -p "$AGENTS" "$REQUESTS" "$BIN"
cp "$RUNNER_SOURCE" "$AGENTS/release-chain-stan.sh"

cat >"$AGENTS/copilot-cli-protected-operation-policy-stan.sh" <<'EOF'
#!/usr/bin/env bash
case "$2" in
  oci-live-data-*) echo '{"workflow":"oci-live-data-rollout.yml"}' ;;
  oci-production-deploy) echo '{"workflow":"oci-production-deploy.yml"}' ;;
  oci-live-betting-activate) echo '{"workflow":"oci-live-betting-activate.yml"}' ;;
  *) exit 1 ;;
esac
EOF
cat >"$AGENTS/copilot-cli-dispatch-stan.sh" <<'EOF'
#!/usr/bin/env bash
operation="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["operation"])' "$1")"
echo "dispatcher $operation $2" >>"$STUB_LOG"
[[ "$(pwd -P)" == "$STUB_ROOT" ]] || { echo "dispatch=REJECTED reason=not-repository-root"; exit 1; }
[[ "$2" == "--prepare-disabled-ghosts" ]] && { echo "prepared=ok"; exit 0; }
[[ "$operation" == "${STUB_DISPATCH_FAIL:-none}" ]] && { echo "dispatch=UNKNOWN next_action=reconcile"; exit 1; }
case "$operation" in
  oci-live-data-*) echo "dispatch=ACCEPTED run_id=101 next_action=observe-exact-run" ;;
  oci-production-deploy) echo "dispatch=ACCEPTED run_id=202 next_action=observe-exact-run" ;;
  oci-live-betting-activate) echo "dispatch=ACCEPTED run_id=303 next_action=observe-exact-run" ;;
esac
EOF
cat >"$AGENTS/copilot-cli-run-approval-stan.sh" <<'EOF'
#!/usr/bin/env bash
echo "approve $1 $2 op=$EXPECTED_OPERATION auto=$COPILOT_CLI_AUTO_APPROVE" >>"$STUB_LOG"
touch "$STUB_STATE/approved-$1"
EOF
cat >"$AGENTS/production-run-exclusivity-stan.sh" <<'EOF'
#!/usr/bin/env bash
echo "exclusivity exclude=${EXCLUDE_RUN_ID:-none}" >>"$STUB_LOG"
echo "production_run_exclusivity=PASS"
EOF
cat >"$BIN/gh" <<'EOF'
#!/usr/bin/env bash
count() {
  local file="$STUB_STATE/$1" value=0
  [[ -f "$file" ]] && value="$(cat "$file")"
  value=$((value + 1))
  echo "$value" >"$file"
  echo "$value"
}
case "$1 $2" in
  "api repos/example/repo/commits/master") echo "$STUB_MASTER" ;;
  "workflow enable"|"workflow disable")
    echo "gh $1 $2 $3" >>"$STUB_LOG"
    [[ "$2" != enable || -z "${STUB_ENABLE_FAIL:-}" ]] ;;
  "run view")
    run="$3"
    case "$7" in
      jobs) echo "job/failing step" ;;
      status)
        if [[ " ${STUB_UNGATED_RUNS:-} " == *" $run "* ]]; then echo completed
        elif [[ " ${STUB_QUEUED_RUNS:-} " == *" $run "* ]]; then echo queued
        else echo in_progress; fi ;;
      status,conclusion,jobs)
        conclusion=success
        [[ " ${STUB_FAIL_RUNS:-} " == *" $run "* ]] && conclusion=failure
        calls="$(count "status-$run")"
        if [[ " ${STUB_FLAKY_RUNS:-} " == *" $run "* && "$calls" == 1 ]]; then echo "HTTP 502" >&2; exit 1; fi
        if [[ "$calls" -le 2 ]]; then echo "in_progress||Step $run"; else echo "completed|$conclusion|"; fi ;;
    esac ;;
  *)
    if [[ "$2" == repos/example/repo/actions/workflows/* ]]; then
      echo "${STUB_WORKFLOW_STATE:-disabled_manually}"
    elif [[ "$2" == */pending_deployments ]]; then
      run="${2%/pending_deployments}"; run="${run##*/}"
      if [[ " ${STUB_UNGATED_RUNS:-} ${STUB_QUEUED_RUNS:-} " == *" $run "* || -f "$STUB_STATE/approved-$run" ]]; then
        echo 0
      else
        echo 1
      fi
    else
      echo "unexpected gh $*" >&2; exit 1
    fi ;;
esac
EOF
chmod +x "$AGENTS"/*.sh "$BIN/gh"

git -C "$CHECKOUT" init -q
git -C "$CHECKOUT" -c user.name=test -c user.email=test@example.invalid add -A
git -C "$CHECKOUT" -c user.name=test -c user.email=test@example.invalid commit -qm fixture
CONTROL="$(git -C "$CHECKOUT" rev-parse HEAD)"
STUB_ROOT="$(cd "$CHECKOUT" && pwd -P)"

cat >"$REQUESTS/live-data.json" <<EOF
{"schemaVersion":1,"repository":"example/repo","operation":"oci-live-data-resume-activation-released",
 "controlSha":"$CONTROL","subjectSha":"$CONTROL","targetSha":null,
 "inputs":{"approved_sha":"$CONTROL","build_run_id":"11","infrastructure_run_id":"12",
  "checkpoint_source_sha":"cccccccccccccccccccccccccccccccccccccccc","disk_checkpoint_run_id":"13",
  "baseline_recovery_run_id":"0","baseline_recovery_source_sha":"none","phase":"apply-slip-index","confirmation":"x"}}
EOF
sed 's/"apply-slip-index"/"dry-run"/' "$REQUESTS/live-data.json" >"$REQUESTS/dry-run.json"
cat >"$REQUESTS/deploy.json" <<EOF
{"schemaVersion":1,"repository":"example/repo","operation":"oci-production-deploy",
 "controlSha":"$CONTROL","subjectSha":"$CONTROL","targetSha":null,"inputs":{}}
EOF

run_case() {
  local expected="$1" pattern="$2" output status=0
  shift 2
  rm -rf "$WORK/state" "$LOG" "$REQUESTS"/oci-*
  mkdir -p "$WORK/state"
  # Run from / to prove the runner enters the repository root itself.
  output="$(cd / && env PATH="$BIN:$PATH" REPO=example/repo STUB_LOG="$LOG" STUB_STATE="$WORK/state" \
    STUB_ROOT="$STUB_ROOT" STUB_MASTER="$CONTROL" RELEASE_CHAIN_POLL_SECONDS=0 RELEASE_CHAIN_JOB_POLL_SECONDS=0 \
    "$@" 2>&1)" || status=$?
  if [[ "$status" != "$expected" || "$output" != *"$pattern"* ]]; then
    echo "expected exit $expected with '$pattern', got $status:" >&2
    printf '%s\n' "$output" >&2
    [[ -f "$LOG" ]] && cat "$LOG" >&2
    exit 1
  fi
}

calls() { tr '\n' ';' <"$LOG"; }

expect_calls() {
  local actual
  actual="$(calls)"
  [[ "$actual" == "$1" ]] || { echo "calls mismatch:" >&2; echo " want $1" >&2; echo " got  $actual" >&2; exit 1; }
}

RUN="$AGENTS/release-chain-stan.sh"

# Chain: prepared transitions, plain deploy, disable at each pending gate (or
# completion) before approval, approval only where a gate is pending, a
# transient read failure tolerated, and derived requests bound to run IDs.
run_case 0 "result=SUCCESS control_sha=$CONTROL" STUB_UNGATED_RUNS=303 STUB_FLAKY_RUNS=202 \
  "$RUN" "$REQUESTS/live-data.json" --chain
expect_calls "exclusivity exclude=none;dispatcher oci-live-data-resume-activation-released --prepare-disabled-ghosts;gh workflow enable oci-live-data-rollout.yml;dispatcher oci-live-data-resume-activation-released --dispatch-prepared;gh workflow disable oci-live-data-rollout.yml;approve 101 --approve op=oci-live-data-resume-activation-released auto=true;gh workflow enable oci-production-deploy.yml;dispatcher oci-production-deploy --dispatch;gh workflow disable oci-production-deploy.yml;approve 202 --approve op=oci-production-deploy auto=true;dispatcher oci-live-betting-activate --prepare-disabled-ghosts;gh workflow enable oci-live-betting-activate.yml;dispatcher oci-live-betting-activate --dispatch-prepared;gh workflow disable oci-live-betting-activate.yml;"
python3 - "$REQUESTS" "$CONTROL" <<'PY'
import json, os, stat, sys
folder, control = sys.argv[1:3]
deploy_path = os.path.join(folder, "oci-production-deploy-101.json")
activate_path = os.path.join(folder, "oci-live-betting-activate-202.json")
for path in (deploy_path, activate_path):
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600, path
deploy, activate = json.load(open(deploy_path)), json.load(open(activate_path))
assert deploy["operation"] == "oci-production-deploy"
assert deploy["controlSha"] == control and deploy["targetSha"] is None
assert deploy["inputs"] == {
    "approved_sha": control, "build_run_id": "11", "infrastructure_run_id": "12",
    "data_run_id": "101", "checkpoint_source_sha": "c" * 40, "disk_checkpoint_run_id": "13",
    "baseline_recovery_run_id": "0", "baseline_recovery_source_sha": "none",
    "confirmation": "DEPLOY OCI EXACT SHA"}, deploy["inputs"]
assert activate["operation"] == "oci-live-betting-activate"
assert activate["inputs"] == {
    "approved_sha": control, "build_run_id": "11", "infrastructure_run_id": "12",
    "deployment_run_id": "202", "confirmation": "ACTIVATE OCI LIVE BETTING"}, activate["inputs"]
PY

# The chain stops at the first failed run and dispatches nothing after it.
run_case 1 "result=FAILED conclusion=failure failed=\"job/failing step\"" STUB_FAIL_RUNS=202 \
  "$RUN" "$REQUESTS/live-data.json" --chain
[[ "$(calls)" != *"oci-live-betting-activate"* ]] || { echo "activation ran after a failed deploy" >&2; exit 1; }

# An unconfirmed dispatch is never replayed and the workflow is disabled again.
run_case 2 "reason=dispatch-unconfirmed operation=oci-production-deploy" STUB_DISPATCH_FAIL=oci-production-deploy \
  "$RUN" "$REQUESTS/deploy.json"
expect_calls "exclusivity exclude=none;gh workflow enable oci-production-deploy.yml;dispatcher oci-production-deploy --dispatch;gh workflow disable oci-production-deploy.yml;"

# A run with no pending gate and no completion is never disabled (that could
# strand it); the workflow stays enabled with an explicit next action.
run_case 2 "reason=materialization-unproven operation=oci-production-deploy run_id=202" STUB_QUEUED_RUNS=202 \
  RELEASE_CHAIN_START_SECONDS=0 "$RUN" "$REQUESTS/deploy.json"
expect_calls "exclusivity exclude=none;gh workflow enable oci-production-deploy.yml;dispatcher oci-production-deploy --dispatch;"

# A failed enable dispatches nothing, reports not started, and disables again.
run_case 2 "reason=enable-failed workflow=oci-production-deploy.yml" STUB_ENABLE_FAIL=1 "$RUN" "$REQUESTS/deploy.json"
expect_calls "exclusivity exclude=none;gh workflow enable oci-production-deploy.yml;gh workflow disable oci-production-deploy.yml;"

# Preflight refusals happen before any workflow is enabled or dispatched.
run_case 2 "reason=control-sha-not-master-tip" STUB_MASTER=ffffffffffffffffffffffffffffffffffffffff \
  "$RUN" "$REQUESTS/deploy.json"
[[ ! -f "$LOG" ]] || { echo "preflight refusal made calls: $(calls)" >&2; exit 1; }
run_case 2 "reason=workflow-not-disabled" STUB_WORKFLOW_STATE=active "$RUN" "$REQUESTS/deploy.json"
[[ "$(calls)" == "exclusivity exclude=none;" ]] || { echo "enabled despite active workflow: $(calls)" >&2; exit 1; }
run_case 2 "reason=chain-must-start-with-live-data" "$RUN" "$REQUESTS/deploy.json" --chain
run_case 2 "reason=chain-needs-apply-slip-index-without-recovery-baseline" "$RUN" "$REQUESTS/dry-run.json" --chain
[[ ! -f "$LOG" ]] || { echo "unchainable request made calls: $(calls)" >&2; exit 1; }
echo dirty >"$CHECKOUT/untracked"
run_case 2 "reason=checkout-not-clean-at-control-sha" "$RUN" "$REQUESTS/deploy.json"
rm -f "$CHECKOUT/untracked"

echo "release_chain_tests=PASS"
