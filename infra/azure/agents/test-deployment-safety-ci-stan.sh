#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
AZURE_WORKFLOW="$ROOT_DIR/.github/workflows/production-deploy.yml"
OCI_WORKFLOW="$ROOT_DIR/.github/workflows/oci-production-deploy.yml"
BUILD_WORKFLOW="$ROOT_DIR/.github/workflows/production-build.yml"
OCI_DEPLOY_SCRIPT="$ROOT_DIR/infra/oci/scripts/deploy.sh"
AZURE_IMAGE_PROVENANCE="$ROOT_DIR/infra/azure/agents/image_provenance_stan.py"
PRE_COMMIT_CHECK="$ROOT_DIR/infra/azure/agents/pre-commit-infra-check-stan.sh"
PR_MERGE_SAFETY_TEST="$ROOT_DIR/infra/azure/agents/test-pr-merge-safety-stan.sh"
PROTECTED_OPERATION_POLICY_TEST="$ROOT_DIR/infra/azure/agents/test-copilot-cli-protected-operation-policy-stan.sh"
CLI_DISPATCH_TEST="$ROOT_DIR/infra/azure/agents/test-copilot-cli-dispatch-stan.sh"
RUN_APPROVAL_TEST="$ROOT_DIR/infra/azure/agents/test-copilot-cli-run-approval-stan.sh"
RUN_EXCLUSIVITY_TEST="$ROOT_DIR/infra/azure/agents/test-production-run-exclusivity-stan.sh"
WORKFLOW_TRIGGER_GUARD="$ROOT_DIR/infra/azure/agents/workflow-trigger-guard-stan.sh"
LIVE_DATA_ROLLOUT_TEST="$ROOT_DIR/infra/oci/tests/test-live-betting-data-rollout-stan.sh"
GHCR_CONTRACT_TEST="$ROOT_DIR/infra/oci/tests/test-ghcr-contract.sh"

test_output="$(mktemp)"
secret_fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-secret-scan.XXXXXX")"
permission_fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-status-writers.XXXXXX")"
secret_guard="$secret_fixture_dir/ingress-guard"
# Test seam only: this plan is a plain internal shell variable that is set
# exclusively by the in-file regressions below. It is deliberately never
# read from the environment, so no ambient or exported value can steer
# fixture teardown. An empty plan is the normal/production case and makes
# the simulator a harmless no-op. The only other accepted values are the
# exact literal "persistent" (the target reappears on every attempt) and a
# positive decimal count N (the target reappears for the first N attempts
# and then settles), so the regressions never depend on timing flakiness.
fixture_cleanup_contention_plan=""

# Fails closed on any plan value that is not empty, not exactly
# "persistent", and not a positive decimal count. This must run before the
# count ever reaches an arithmetic context, because bash evaluates
# arithmetic operands recursively and would otherwise execute command
# substitutions embedded in the value. The reason is fixed and sanitized:
# the rejected value is never echoed.
validate_fixture_cleanup_contention_plan() {
  local plan="${fixture_cleanup_contention_plan:-}"

  if [[ -z "$plan" || "$plan" == "persistent" ]]; then
    return 0
  fi
  if [[ "$plan" =~ ^[1-9][0-9]*$ ]]; then
    return 0
  fi
  echo "test-deployment-safety-ci-stan: internal fixture cleanup contention plan is not empty, \"persistent\", or a positive count; reason=fixture-cleanup-plan-invalid" >&2
  return 1
}

# Forces remove_fixture_tree_with_bounded_retry below to observe
# deterministic simulated removal contention instead of a real filesystem
# race.
simulate_fixture_cleanup_contention_for_test() {
  local target="$1"
  local attempt="$2"
  local plan="${fixture_cleanup_contention_plan:-}"

  [[ -n "$plan" ]] || return 0
  validate_fixture_cleanup_contention_plan || return 1
  # "$plan" is validated digits here, and is expanded rather than named so
  # the arithmetic operand is a literal count.
  if [[ "$plan" == "persistent" ]] || (( attempt <= $plan )); then
    mkdir -p "$target"
    : >"$target/.cleanup-contention-marker"
  fi
}

# Emits bounded, deterministic evidence about what is still blocking the
# removal of a fixture tree. Entries are printed relative to the target, so
# the absolute private fixture parent/target prefix never reaches a log.
report_fixture_cleanup_blocking_entries() {
  local target="$1"
  local entry
  local printed=0

  echo "test-deployment-safety-ci-stan: fixture cleanup did not settle within its fixed bound; reason=fixture-cleanup-race" >&2
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    echo "test-deployment-safety-ci-stan: fixture-cleanup-blocking-entry=${entry#./}" >&2
    printed=$(( printed + 1 ))
  done < <(
    cd "$target" 2>/dev/null &&
      find . -mindepth 1 -maxdepth 2 2>/dev/null | LC_ALL=C sort | head -n 10
  )
  if (( printed == 0 )); then
    echo "test-deployment-safety-ci-stan: fixture-cleanup-blocking-entry=<unreadable>" >&2
  fi
}

# Removes a fixture directory tree, tolerating only brief, bounded
# transient filesystem contention (for example residual activity from a
# fixture-local synthetic git repository) instead of looping indefinitely
# or letting a stray "Directory not empty" failure abort teardown. Returns
# 0 once the target is verified absent, 1 if contention persists through
# every attempt in the small fixed bound below, and 2 for misuse (an empty
# target or an invalid internal plan) so caller misuse can never be
# mistaken for real filesystem contention.
remove_fixture_tree_with_bounded_retry() {
  local target="${1:-}"
  local max_attempts=5
  local retry_delay="0.2"
  local attempt

  if [[ -z "$target" ]]; then
    echo "test-deployment-safety-ci-stan: refusing to remove an empty fixture target; reason=fixture-cleanup-target-empty" >&2
    return 2
  fi
  validate_fixture_cleanup_contention_plan || return 2

  for (( attempt = 1; attempt <= max_attempts; attempt++ )); do
    rm -rf "$target" 2>/dev/null || true
    simulate_fixture_cleanup_contention_for_test "$target" "$attempt" || return 2
    if [[ ! -e "$target" ]]; then
      return 0
    fi
    if (( attempt < max_attempts )); then
      sleep "$retry_delay"
    fi
  done
  report_fixture_cleanup_blocking_entries "$target"
  return 1
}

# Runs the bounded cleanup helper under an explicit internal contention
# plan. The plan is assigned only inside an isolated subshell, which bash
# both discards on return and enters with the parent's traps reset, so the
# main shell never holds a simulated plan at any instant. A post-call
# restore is deliberately not relied upon: a pending SIGTERM (or any other
# interruption) is serviced at a command boundary, which for the previous
# main-shell form could fire after the removal returned but before the
# restore assignment and hand the single production EXIT teardown a
# "persistent" or invalid plan for the whole fixture root. With the plan
# confined here, every exit and cancellation path reaches cleanup with the
# empty production plan.
run_bounded_fixture_cleanup_with_plan() {
  local plan="$1"
  local target="$2"
  local status=0

  (
    fixture_cleanup_contention_plan="$plan"
    remove_fixture_tree_with_bounded_retry "$target"
  ) || status=$?
  return "$status"
}

cleanup() {
  local primary_status=$?
  local final_status="$primary_status"

  rm -f "$test_output" 2>/dev/null || true
  rm -f "$secret_fixture_dir/safe.yml" "$secret_fixture_dir/unsafe.yml" "$secret_guard" \
    2>/dev/null || true
  rmdir "$secret_fixture_dir" 2>/dev/null || true

  if ! remove_fixture_tree_with_bounded_retry "$permission_fixture_dir"; then
    echo "test-deployment-safety-ci-stan: fixture cleanup contention persisted; reason=fixture-cleanup-race" >&2
    if [[ "$final_status" -eq 0 ]]; then
      final_status=1
    fi
  fi

  exit "$final_status"
}
trap cleanup EXIT

coverage_fixture_cleanup_transient_dir="$permission_fixture_dir/fixture-cleanup-transient"

# Transient contention settles inside the fixed bound. These scratch trees
# are deliberately not synthetic git repositories; the helper under test is
# the only thing that removes them.
mkdir -p "$coverage_fixture_cleanup_transient_dir/repository/nested"
if ! run_bounded_fixture_cleanup_with_plan 2 "$coverage_fixture_cleanup_transient_dir"; then
  echo "ERROR: transient fixture cleanup contention did not settle within the fixed bound" >&2
  exit 1
fi
if [[ -e "$coverage_fixture_cleanup_transient_dir" ]]; then
  echo "ERROR: transient fixture cleanup contention left the fixture tree behind" >&2
  exit 1
fi
mkdir -p "$coverage_fixture_cleanup_transient_dir/repository/nested"
if [[ -e "$coverage_fixture_cleanup_transient_dir/.cleanup-contention-marker" ]]; then
  echo "ERROR: settled fixture cleanup contention contaminated the next fixture" >&2
  exit 1
fi

# Persistent contention stays inside the fixed bound, reports the stable
# race reason, and emits relative-only blocking evidence.
coverage_fixture_cleanup_persistent_dir="$permission_fixture_dir/fixture-cleanup-persistent"
coverage_fixture_cleanup_persistent_stderr="$permission_fixture_dir/fixture-cleanup-persistent.stderr"
mkdir -p "$coverage_fixture_cleanup_persistent_dir/repository/nested"
coverage_fixture_cleanup_persistent_start="$SECONDS"
coverage_fixture_cleanup_persistent_status=0
run_bounded_fixture_cleanup_with_plan persistent \
  "$coverage_fixture_cleanup_persistent_dir" \
  2>"$coverage_fixture_cleanup_persistent_stderr" ||
  coverage_fixture_cleanup_persistent_status=$?
coverage_fixture_cleanup_persistent_elapsed=$(( SECONDS - coverage_fixture_cleanup_persistent_start ))
if [[ "$coverage_fixture_cleanup_persistent_status" -ne 1 ]]; then
  echo "ERROR: persistent fixture cleanup contention did not report bounded contention failure (got $coverage_fixture_cleanup_persistent_status, expected 1)" >&2
  exit 1
fi
if [[ "$coverage_fixture_cleanup_persistent_elapsed" -ge 5 ]]; then
  echo "ERROR: persistent fixture cleanup contention exceeded its fixed bound" >&2
  exit 1
fi
if [[ ! -e "$coverage_fixture_cleanup_persistent_dir" ]]; then
  echo "ERROR: persistent fixture cleanup contention unexpectedly cleared" >&2
  exit 1
fi
if ! grep -qF "reason=fixture-cleanup-race" \
    "$coverage_fixture_cleanup_persistent_stderr"; then
  echo "ERROR: bounded fixture cleanup failure did not report its sanitized reason" >&2
  exit 1
fi
if ! grep -qxF \
    "test-deployment-safety-ci-stan: fixture-cleanup-blocking-entry=.cleanup-contention-marker" \
    "$coverage_fixture_cleanup_persistent_stderr"; then
  echo "ERROR: bounded fixture cleanup failure did not report relative blocking evidence" >&2
  exit 1
fi
if grep -qF "$permission_fixture_dir" \
    "$coverage_fixture_cleanup_persistent_stderr"; then
  echo "ERROR: bounded fixture cleanup diagnostics leaked an absolute fixture path" >&2
  exit 1
fi

# Every non-conforming internal plan is rejected before any removal and
# before any arithmetic, with a reason that cannot be confused with real
# filesystem contention and without executing anything embedded in it.
coverage_fixture_cleanup_invalid_plan_sentinel="$permission_fixture_dir/fixture-cleanup-invalid-plan-sentinel"
coverage_fixture_cleanup_invalid_plans=(
  "0"
  "01"
  "-1"
  "1.5"
  "abc"
  "persistent extra"
  " persistent"
  "2; touch $coverage_fixture_cleanup_invalid_plan_sentinel"
  "a[\$(touch $coverage_fixture_cleanup_invalid_plan_sentinel)]"
)
coverage_fixture_cleanup_invalid_plan_index=0
for coverage_fixture_cleanup_invalid_plan in \
    "${coverage_fixture_cleanup_invalid_plans[@]}"; do
  coverage_fixture_cleanup_invalid_plan_index=$(( coverage_fixture_cleanup_invalid_plan_index + 1 ))
  coverage_fixture_cleanup_invalid_plan_target="$permission_fixture_dir/fixture-cleanup-invalid-plan-$coverage_fixture_cleanup_invalid_plan_index"
  mkdir -p "$coverage_fixture_cleanup_invalid_plan_target/repository/nested"
  coverage_fixture_cleanup_invalid_plan_status=0
  run_bounded_fixture_cleanup_with_plan \
    "$coverage_fixture_cleanup_invalid_plan" \
    "$coverage_fixture_cleanup_invalid_plan_target" \
    >"$test_output" 2>&1 || coverage_fixture_cleanup_invalid_plan_status=$?
  if [[ "$coverage_fixture_cleanup_invalid_plan_status" -ne 2 ]]; then
    echo "ERROR: invalid internal fixture cleanup plan #$coverage_fixture_cleanup_invalid_plan_index was not rejected" >&2
    exit 1
  fi
  if ! grep -qF "reason=fixture-cleanup-plan-invalid" "$test_output"; then
    echo "ERROR: invalid internal fixture cleanup plan #$coverage_fixture_cleanup_invalid_plan_index did not report its sanitized reason" >&2
    exit 1
  fi
  if grep -qF "reason=fixture-cleanup-race" "$test_output"; then
    echo "ERROR: invalid internal fixture cleanup plan #$coverage_fixture_cleanup_invalid_plan_index was reported as filesystem contention" >&2
    exit 1
  fi
  if grep -qF "$permission_fixture_dir" "$test_output"; then
    echo "ERROR: invalid internal fixture cleanup plan #$coverage_fixture_cleanup_invalid_plan_index leaked an absolute fixture path" >&2
    exit 1
  fi
  if [[ ! -d "$coverage_fixture_cleanup_invalid_plan_target/repository/nested" ]]; then
    echo "ERROR: invalid internal fixture cleanup plan #$coverage_fixture_cleanup_invalid_plan_index removed fixture content before validation" >&2
    exit 1
  fi
  if [[ -e "$coverage_fixture_cleanup_invalid_plan_sentinel" ]]; then
    echo "ERROR: invalid internal fixture cleanup plan #$coverage_fixture_cleanup_invalid_plan_index executed an embedded command" >&2
    exit 1
  fi
done

# The destructive target itself is guarded before any rm, for both an empty
# argument and a missing argument.
for coverage_fixture_cleanup_empty_target_case in explicit-empty missing; do
  coverage_fixture_cleanup_empty_target_status=0
  if [[ "$coverage_fixture_cleanup_empty_target_case" == "explicit-empty" ]]; then
    remove_fixture_tree_with_bounded_retry "" >"$test_output" 2>&1 ||
      coverage_fixture_cleanup_empty_target_status=$?
  else
    remove_fixture_tree_with_bounded_retry >"$test_output" 2>&1 ||
      coverage_fixture_cleanup_empty_target_status=$?
  fi
  if [[ "$coverage_fixture_cleanup_empty_target_status" -ne 2 ]]; then
    echo "ERROR: bounded fixture cleanup accepted an empty target ($coverage_fixture_cleanup_empty_target_case)" >&2
    exit 1
  fi
  if ! grep -qF "reason=fixture-cleanup-target-empty" "$test_output"; then
    echo "ERROR: empty bounded fixture cleanup target did not report its sanitized reason ($coverage_fixture_cleanup_empty_target_case)" >&2
    exit 1
  fi
  if grep -qF "reason=fixture-cleanup-race" "$test_output"; then
    echo "ERROR: empty bounded fixture cleanup target was reported as filesystem contention ($coverage_fixture_cleanup_empty_target_case)" >&2
    exit 1
  fi
done

# The retired environment name is inert. It is referenced here only to
# prove ambient neutrality and never appears in runtime control flow: a
# hostile exported value must not execute a command, change the status,
# add delay, or create a contention sentinel.
coverage_fixture_cleanup_ambient_sentinel="$permission_fixture_dir/fixture-cleanup-ambient-sentinel"
coverage_fixture_cleanup_ambient_values=(
  "persistent"
  "a[\$(touch $coverage_fixture_cleanup_ambient_sentinel)]"
)
coverage_fixture_cleanup_ambient_index=0
for coverage_fixture_cleanup_ambient_value in \
    "${coverage_fixture_cleanup_ambient_values[@]}"; do
  coverage_fixture_cleanup_ambient_index=$(( coverage_fixture_cleanup_ambient_index + 1 ))
  coverage_fixture_cleanup_ambient_target="$permission_fixture_dir/fixture-cleanup-ambient-$coverage_fixture_cleanup_ambient_index"
  mkdir -p "$coverage_fixture_cleanup_ambient_target/repository/nested"
  coverage_fixture_cleanup_ambient_start="$SECONDS"
  coverage_fixture_cleanup_ambient_status=0
  (
    export BETSTAN_TEST_FIXTURE_CLEANUP_CONTENTION="$coverage_fixture_cleanup_ambient_value"
    remove_fixture_tree_with_bounded_retry "$coverage_fixture_cleanup_ambient_target"
  ) >"$test_output" 2>&1 || coverage_fixture_cleanup_ambient_status=$?
  coverage_fixture_cleanup_ambient_elapsed=$(( SECONDS - coverage_fixture_cleanup_ambient_start ))
  if [[ "$coverage_fixture_cleanup_ambient_status" -ne 0 ]]; then
    echo "ERROR: a hostile ambient fixture cleanup value #$coverage_fixture_cleanup_ambient_index changed the bounded cleanup status" >&2
    exit 1
  fi
  # The target being absent after a status-0 return proves the simulator
  # never ran, so no retry sleep was executed either. The coarse elapsed
  # bound below is defence in depth only.
  if [[ -e "$coverage_fixture_cleanup_ambient_target" ]]; then
    echo "ERROR: a hostile ambient fixture cleanup value #$coverage_fixture_cleanup_ambient_index simulated contention" >&2
    exit 1
  fi
  if [[ "$coverage_fixture_cleanup_ambient_elapsed" -ge 2 ]]; then
    echo "ERROR: a hostile ambient fixture cleanup value #$coverage_fixture_cleanup_ambient_index added retry delay" >&2
    exit 1
  fi
  if [[ -e "$coverage_fixture_cleanup_ambient_sentinel" ]]; then
    echo "ERROR: a hostile ambient fixture cleanup value #$coverage_fixture_cleanup_ambient_index executed an embedded command" >&2
    exit 1
  fi
  if [[ -s "$test_output" ]]; then
    echo "ERROR: a hostile ambient fixture cleanup value #$coverage_fixture_cleanup_ambient_index produced output" >&2
    exit 1
  fi
  if [[ -n "${fixture_cleanup_contention_plan:-}" ]]; then
    echo "ERROR: a hostile ambient fixture cleanup value #$coverage_fixture_cleanup_ambient_index reached the internal plan" >&2
    exit 1
  fi
done

# Actual cleanup exit semantics: a bounded cleanup failure upgrades a
# successful primary status to 1 and preserves any nonzero primary status,
# and both paths carry the stable race marker without leaking private
# absolute paths.
coverage_fixture_cleanup_child_script="$(
  declare -f validate_fixture_cleanup_contention_plan
  declare -f simulate_fixture_cleanup_contention_for_test
  declare -f report_fixture_cleanup_blocking_entries
  declare -f remove_fixture_tree_with_bounded_retry
  declare -f cleanup
  cat <<'CHILD'
set -euo pipefail
permission_fixture_dir="$1"
fixture_cleanup_contention_plan="$2"
child_primary_status="$3"
test_output="$permission_fixture_dir/.unused-test-output"
secret_fixture_dir="$permission_fixture_dir/.unused-secret-dir"
secret_guard="$secret_fixture_dir/.unused-guard"
mkdir -p "$permission_fixture_dir/coverage-review-fixture-1/repository/.git"
trap cleanup EXIT
(exit "$child_primary_status")
CHILD
)"

assert_fixture_cleanup_child_case() {
  local label="$1"
  local target="$2"
  local plan="$3"
  local child_primary_status="$4"
  local expected_status="$5"
  local observed=0

  bash -c "$coverage_fixture_cleanup_child_script" _ \
    "$target" "$plan" "$child_primary_status" \
    >"$test_output" 2>&1 || observed=$?
  if [[ "$observed" -ne "$expected_status" ]]; then
    echo "ERROR: $label exited $observed (expected $expected_status)" >&2
    exit 1
  fi
  if ! grep -qF "reason=fixture-cleanup-race" "$test_output"; then
    echo "ERROR: $label did not report the bounded fixture cleanup race marker" >&2
    exit 1
  fi
  if grep -qF "$target" "$test_output"; then
    echo "ERROR: $label leaked its absolute fixture target into diagnostics" >&2
    exit 1
  fi
  if grep -qF "$permission_fixture_dir" "$test_output"; then
    echo "ERROR: $label leaked the absolute fixture parent into diagnostics" >&2
    exit 1
  fi
}

assert_fixture_cleanup_child_case \
  "cleanup with a successful body and persistent contention" \
  "$permission_fixture_dir/cleanup-upgrades-success-test" persistent 0 1
assert_fixture_cleanup_child_case \
  "cleanup with a pre-existing primary failure and persistent contention" \
  "$permission_fixture_dir/cleanup-preserves-primary-failure-test" persistent 42 42

# Cancellation while a simulated contention plan is driving a bounded
# cleanup must never reach the real EXIT teardown. The child below is
# interrupted from inside that window, so its EXIT cleanup runs against
# the whole fixture root: with the plan confined to the helper subshell it
# must remove that root completely, report no simulated contention, and
# still surrender a nonzero termination status.
coverage_fixture_cleanup_cancellation_child_script="$(
  declare -f validate_fixture_cleanup_contention_plan
  declare -f simulate_fixture_cleanup_contention_for_test
  declare -f report_fixture_cleanup_blocking_entries
  declare -f remove_fixture_tree_with_bounded_retry
  declare -f run_bounded_fixture_cleanup_with_plan
  declare -f cleanup
  cat <<'CHILD'
set -euo pipefail
permission_fixture_dir="$1"
child_interrupted_marker="$2"
test_output="$permission_fixture_dir/.unused-test-output"
secret_fixture_dir="$permission_fixture_dir/.unused-secret-dir"
secret_guard="$secret_fixture_dir/.unused-guard"
fixture_cleanup_contention_plan=""
child_plan_target="$permission_fixture_dir/cancellation-plan-target"
mkdir -p "$child_plan_target/repository/nested"
mkdir -p "$permission_fixture_dir/coverage-review-fixture-1/repository/.git"
trap cleanup EXIT
trap 'exit 143' TERM
child_shell_pid=$$
(
  # Narrow internal synchronization instead of a fixed sleep: the
  # simulated contention marker exists only once the persistent plan is
  # actually driving the bounded cleanup, so the interruption always lands
  # inside that window. The wait is bounded so a missing window fails the
  # assertions below instead of hanging.
  child_wait=0
  while [[ ! -e "$child_plan_target/.cleanup-contention-marker" ]]; do
    child_wait=$(( child_wait + 1 ))
    if [[ "$child_wait" -ge 400 ]]; then
      exit 0
    fi
    sleep 0.05
  done
  : >"$child_interrupted_marker"
  kill -TERM "$child_shell_pid" 2>/dev/null || true
) &
# The plan-driven call legitimately reports its own simulated contention,
# so its stderr is captured inside the doomed fixture root. Anything left
# on the child streams therefore comes from the real EXIT teardown.
run_bounded_fixture_cleanup_with_plan persistent "$child_plan_target" \
  2>"$permission_fixture_dir/cancellation-plan-call.stderr" || true
echo "child-reached-normal-return"
exit 7
CHILD
)"

coverage_fixture_cleanup_cancellation_root="$permission_fixture_dir/fixture-cleanup-cancellation"
coverage_fixture_cleanup_cancellation_marker="$permission_fixture_dir/fixture-cleanup-cancellation.interrupted"
mkdir -p "$coverage_fixture_cleanup_cancellation_root"
coverage_fixture_cleanup_cancellation_status=0
bash -c "$coverage_fixture_cleanup_cancellation_child_script" _ \
  "$coverage_fixture_cleanup_cancellation_root" \
  "$coverage_fixture_cleanup_cancellation_marker" \
  >"$test_output" 2>&1 || coverage_fixture_cleanup_cancellation_status=$?
if [[ ! -e "$coverage_fixture_cleanup_cancellation_marker" ]]; then
  echo "ERROR: the fixture cleanup cancellation regression never reached an active contention plan" >&2
  exit 1
fi
if grep -qF "child-reached-normal-return" "$test_output"; then
  echo "ERROR: the fixture cleanup cancellation regression was interrupted only after a normal return" >&2
  exit 1
fi
if [[ "$coverage_fixture_cleanup_cancellation_status" -ne 143 ]]; then
  echo "ERROR: cancellation during an active fixture cleanup plan did not preserve its termination status (got $coverage_fixture_cleanup_cancellation_status, expected 143)" >&2
  exit 1
fi
if [[ -e "$coverage_fixture_cleanup_cancellation_root" ]]; then
  echo "ERROR: cancellation during an active fixture cleanup plan left the fixture root behind" >&2
  exit 1
fi
if grep -qF "reason=fixture-cleanup-race" "$test_output"; then
  echo "ERROR: cancellation during an active fixture cleanup plan let real teardown simulate contention" >&2
  exit 1
fi
if grep -qF "reason=fixture-cleanup-plan-invalid" "$test_output"; then
  echo "ERROR: cancellation during an active fixture cleanup plan let real teardown observe an invalid plan" >&2
  exit 1
fi
if grep -qF "$permission_fixture_dir" "$test_output"; then
  echo "ERROR: the fixture cleanup cancellation regression leaked an absolute fixture path" >&2
  exit 1
fi
rm -f "$coverage_fixture_cleanup_cancellation_marker"

if [[ -n "${fixture_cleanup_contention_plan:-}" ]]; then
  echo "ERROR: an internal fixture cleanup contention plan leaked past its regressions" >&2
  exit 1
fi
echo "coverage_fixture_cleanup_race_tests=PASS"

assert_secret_fixture_rejected() {
  local label="$1"
  if BRANCH_NAME=feature/test \
      INFRA_DIRS="$secret_fixture_dir" \
      INGRESS_GUARD="$secret_guard" \
      "$PRE_COMMIT_CHECK" >"$test_output" 2>&1; then
    echo "ERROR: $label unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "possible hard-coded secret value" "$test_output"
}

grep -qF 'INFRA_DIRS="${INFRA_DIRS:-infra .github/workflows}"' \
  "$PRE_COMMIT_CHECK" || {
    echo "ERROR: infrastructure secret scan no longer covers every infra tree" >&2
    exit 1
  }

if BRANCH_NAME=master GITHUB_ACTIONS=false "$PRE_COMMIT_CHECK" >"$test_output" 2>&1; then
  echo "ERROR: local master pre-commit check unexpectedly passed" >&2
  exit 1
fi
grep -qF "direct work on master is forbidden" "$test_output"

BRANCH_NAME=master GITHUB_ACTIONS=true "$PRE_COMMIT_CHECK" >"$test_output" 2>&1
if grep -qF "direct work on master is forbidden" "$test_output"; then
  echo "ERROR: GitHub Actions master validation was blocked" >&2
  exit 1
fi

cat >"$secret_guard" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "ingress_fixture=PASS"
SH
chmod +x "$secret_guard"
cat >"$secret_fixture_dir/safe.yml" <<'YAML'
permissions:
  id-token: read
  id-token: write
  id-token: none
contracts:
  - contents=read,id-token=read
  - contents=read,id-token=write
  - contents=read,id-token=none
token: ${SAFE_TOKEN}
token: $SAFE_TOKEN
token: "${SAFE_TOKEN}"
token: $(printf safe)
token: ${{ secrets.NPM_TOKEN }}
NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
MONGO_PASSWORD: ${MONGO_PASSWORD}
authToken: "$AUTH_TOKEN"
SSH_PRIVATE_KEY: "${SSH_PRIVATE_KEY:-}"
"NODE_AUTH_TOKEN": "${{ secrets.NPM_TOKEN }}"
'MONGO_PASSWORD': '${MONGO_PASSWORD}'
{"authToken":"${AUTH_TOKEN}"}
az ad sp credential reset --query "{clientId: appId, clientSecret: password, subscriptionId: '$SUBSCRIPTION_ID', tenantId: tenant}"
YAML
BRANCH_NAME=feature/test \
  INFRA_DIRS="$secret_fixture_dir" \
  INGRESS_GUARD="$secret_guard" \
  "$PRE_COMMIT_CHECK" >"$test_output" 2>&1
printf '%s%s\n%s%s\n' \
  'evil-id-to' 'ken: writehunter2xyz' \
  'contract: id-to' 'ken=writehunter2xyz' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "malformed id-token fixtures"
printf '%s%s\n%s%s\n%s%s\n%s%s\n%s%s\n%s%s\n%s%s\n%s%s\n' \
  'to' 'ken=${SAFE_TOKEN}fixed' \
  'to' 'ken=$SAFE_TOKEN-fixed' \
  'to' 'ken=${{ secrets.NPM_TOKEN }}fixed' \
  'to' 'ken="${SAFE_TOKEN}"fixed' \
  'to' 'ken=$(printf safe)fixed' \
  'to' 'ken=${SAFE_TOKEN},fixed-literal' \
  'to' 'ken=${SAFE_TOKEN}]fixed-literal' \
  'to' 'ken: ${{ secrets.NPM_TOKEN }} fixed-literal' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "safe-value literal suffix fixtures"
printf '%s%s\n' \
  'safe_ref: ${SAFE_TOKEN}, to' \
  'ken: hunter2xyz' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "mixed safe reference and hard-coded token fixture"
printf '%s%s\n' \
  'to' \
  'ken: hunter2xyz # synthetic inline comment' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "commented hard-coded token fixture"
printf '%s%s\n' 'to' 'ken: hunter2xyz' >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "hard-coded token fixture"
printf '%s\n' \
  'token=hunter2xyz' \
  'az resource show --query "{clientSecret: hunter2xyz}"' \
  'clientSecret=password az account show --query name' \
  'az account show --query name clientSecret=password' \
  "printf 'authToken=hunter2xyz\\n'" \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "line-context bypass fixtures"
printf '%s%s\n%s%s\n%s%s\n%s%s\n' \
  'MONGO_PASS' 'WORD: hunter2xyz' \
  'JWT_SEC' 'RET=hunter2xyz' \
  'NODE_AUTH_TO' 'KEN: hunter2xyz' \
  'authTo' 'ken: hunter2xyz' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "prefixed secret-key fixtures"
printf '"NODE_AUTH_TO%s": "hunter2xyz"\n' 'KEN' \
  >"$secret_fixture_dir/unsafe.yml"
printf "'MONGO_PASS%s': 'hunter2xyz'\n" 'WORD' \
  >>"$secret_fixture_dir/unsafe.yml"
printf '{"authTo%s":"hunter2xyz"}\n' 'ken' \
  >>"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "quoted secret-key fixtures"
rm -f "$secret_fixture_dir/unsafe.yml"

if grep -Fq 'if "--query" in original' "$PRE_COMMIT_CHECK" ||
    grep -Fq 'if "printf" in original and "%q" in original' "$PRE_COMMIT_CHECK"; then
  echo "ERROR: infrastructure secret scan retains a line-wide bypass" >&2
  exit 1
fi

cp "$ROOT_DIR"/.github/workflows/*.yml "$permission_fixture_dir/"
WORKFLOW_PERMISSION_DIR="$permission_fixture_dir" \
  "$WORKFLOW_TRIGGER_GUARD" >"$test_output" 2>&1

cat >"$permission_fixture_dir/runner-context.yml" <<'YAML'
name: runner-context
on: workflow_dispatch
permissions: {}
jobs:
  checks:
    runs-on: ubuntu-latest
    env:
      LITERAL: ${{ 'runner.temp' }}
    steps:
      - run: echo safe
        env:
          TMPDIR: ${{ runner.temp }}
YAML
WORKFLOW_PERMISSION_DIR="$permission_fixture_dir" \
  "$WORKFLOW_TRIGGER_GUARD" >"$test_output" 2>&1
while IFS= read -r expression; do
  cat >"$permission_fixture_dir/runner-context.yml" <<YAML
name: runner-context
on: workflow_dispatch
permissions: {}
jobs:
  checks:
    runs-on: ubuntu-latest
    env:
      TMPDIR: >-
        $expression
    steps:
      - run: echo unsafe
YAML
  if WORKFLOW_PERMISSION_DIR="$permission_fixture_dir" \
      "$WORKFLOW_TRIGGER_GUARD" >"$test_output" 2>&1; then
    echo "ERROR: job environment runner context unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "runner-context.yml:checks.env.TMPDIR uses unsupported runner context" \
    "$test_output"
done <<'EXPRESSIONS'
${{ runner.temp }}
${{ format('}} {0}', runner['temp']) }}
EXPRESSIONS
rm -f "$permission_fixture_dir/runner-context.yml"

cat >"$permission_fixture_dir/rogue-status-writer.yml" <<'YAML'
name: rogue-status-writer
on: workflow_dispatch
permissions:
  statuses: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo unsafe
YAML
if WORKFLOW_PERMISSION_DIR="$permission_fixture_dir" \
    "$WORKFLOW_TRIGGER_GUARD" >"$test_output" 2>&1; then
  echo "ERROR: secondary statuses:write workflow unexpectedly passed" >&2
  exit 1
fi
grep -qF "branch-policy.yml must be the sole explicit statuses:write workflow" \
  "$test_output"
rm -f "$permission_fixture_dir/rogue-status-writer.yml"
cat >"$permission_fixture_dir/implicit-permissions.yml" <<'YAML'
name: implicit-permissions
on: workflow_dispatch
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo "${{ github.token }}"
YAML
if WORKFLOW_PERMISSION_DIR="$permission_fixture_dir" \
    "$WORKFLOW_TRIGGER_GUARD" >"$test_output" 2>&1; then
  echo "ERROR: implicit workflow permissions unexpectedly passed" >&2
  exit 1
fi
grep -qF "every workflow job must declare effective permissions" "$test_output"


"$PR_MERGE_SAFETY_TEST"
"$PROTECTED_OPERATION_POLICY_TEST"
"$CLI_DISPATCH_TEST"
"$RUN_APPROVAL_TEST"
"$RUN_EXCLUSIVITY_TEST"
# The full OCI scope owns these suites in its live/provenance shards. A caller
# may delegate them only when its aggregate requires those shard results.
# Standalone production-build callers continue to execute both.
if [[ "${BETSTAN_CONTRACT_ORCHESTRATED:-0}" != "1" ]]; then
  "$LIVE_DATA_ROLLOUT_TEST"
  "$GHCR_CONTRACT_TEST"
fi
python3 -I - \
  "$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
compile(path.read_bytes(), str(path), "exec")
PY

python3 -I - "$AZURE_WORKFLOW" "$OCI_WORKFLOW" "$BUILD_WORKFLOW" "$OCI_DEPLOY_SCRIPT" <<'PY'
import copy
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

azure_workflow = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
oci_workflow = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
build_workflow_path = pathlib.Path(sys.argv[3])
build_workflow_bytes = build_workflow_path.read_bytes()
build_workflow = build_workflow_bytes.decode("utf-8")
build_workflow_blob = hashlib.sha1(
    f"blob {len(build_workflow_bytes)}\0".encode("utf-8")
    + build_workflow_bytes
).hexdigest()
oci_deploy_script = pathlib.Path(sys.argv[4]).read_text(encoding="utf-8")

trusted_build_workflow_blob = "1e3118276cc4746e824303245339c25de4411c15"
lean_build_workflow_blob = "7f036e038c780d929417ea7e9f6227bdf9d5fb89"
trusted_build_restoration = build_workflow_blob == trusted_build_workflow_blob

expected_azure_order = [
    "auth",
    "bet",
    "client",
    "event",
    "moderation",
    "resulting",
    "slip",
    "backoffice",
    "gamemaster",
]
expected_oci_order = [
    "telemetry",
    "auth",
    "bet",
    "event",
    "moderation",
    "resulting",
    "slip",
    "backoffice",
    "client",
    "gamemaster",
]
approved_action_refs = {
    "actions/checkout": "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    "actions/setup-node": "a0853c24544627f65ddf259abe73b1d18a591444",
    "actions/cache": "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    "docker/setup-buildx-action": "37fe631027851001ddb9b187196cc803df7f5f0e",
    "docker/login-action": "dbcb813823bdd20940b903addbd779551569679f",
    "docker/build-push-action": "c3c9e263c25d99ce0380d002d59b67737d91b0dc",
    "actions/upload-artifact": "b7c566a772e6b6bfb58ed0dc250532a479d7789f",
}
full_sha_pattern = re.compile(r"^[0-9a-f]{40}$")


def fail(message: str) -> None:
    raise SystemExit(message)


if build_workflow_blob not in (
    trusted_build_workflow_blob,
    lean_build_workflow_blob,
):
    fail(
        "production-build.yml is neither the trusted restoration nor "
        "the reviewed lean workflow"
    )


def parse_rollouts(text: str) -> list[str]:
    match = re.search(r"rollouts=\(\n(?P<body>.*?)\n\s*\)", text, re.S)
    if not match:
        fail("Azure deploy workflow rollout list is missing")
    return re.findall(r"'([^|']+)\|", match.group("body"))


def parse_services(text: str) -> list[str]:
    match = re.search(r"services=\((?P<body>[^\)]*)\)", text, re.S)
    if not match:
        fail("OCI deploy service list is missing")
    return re.findall(r"\b([a-z]+)\b", match.group("body"))


def parse_uses_entries(text: str) -> list[tuple[int, str]]:
    entries: list[tuple[int, str]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        match = re.match(r"\s*uses:\s*([^\s#]+)", line)
        if match:
            entries.append((line_number, match.group(1)))
    if not entries:
        fail("production-build.yml does not declare any uses entries")
    return entries


def validate_action_pins(text: str, label: str = "production-build.yml") -> list[str]:
    errors: list[str] = []
    seen_repositories: set[str] = set()

    for line_number, use in parse_uses_entries(text):
        match = re.fullmatch(r"(?P<repository>[^@\s]+)@(?P<ref>[^\s]+)", use)
        if not match:
            errors.append(f"{label} line {line_number} does not pin an action ref: {use}")
            continue

        repository = match.group("repository")
        ref = match.group("ref")
        seen_repositories.add(repository)

        expected_ref = approved_action_refs.get(repository)
        if expected_ref is None:
            errors.append(
                f"{label} line {line_number} references an unreviewed third-party action: {repository}"
            )
            continue

        if not full_sha_pattern.fullmatch(ref):
            errors.append(
                f"{label} line {line_number} is not pinned to a full 40-character lowercase hex commit SHA: {use}"
            )
            continue

        if ref != expected_ref:
            errors.append(
                f"{label} line {line_number} is pinned to {repository}@{ref}, expected {repository}@{expected_ref}"
            )

    missing_repositories = sorted(set(approved_action_refs) - seen_repositories)
    unexpected_repositories = sorted(seen_repositories - set(approved_action_refs))
    if missing_repositories or unexpected_repositories:
        fragments: list[str] = []
        if missing_repositories:
            fragments.append("missing reviewed actions: " + ", ".join(missing_repositories))
        if unexpected_repositories:
            fragments.append("unexpected actions: " + ", ".join(unexpected_repositories))
        errors.append(f"{label} action inventory changed ({'; '.join(fragments)})")

    return errors


def mutate_once(text: str, needle: str, replacement: str) -> str:
    mutated = text.replace(needle, replacement, 1)
    if mutated == text:
        fail(f"fixture mutation failed for {needle!r}")
    return mutated


def validate_build_output_defaults(document: dict) -> list[str]:
    steps = document.get("jobs", {}).get("build", {}).get("steps", [])
    matches = [step for step in steps if step.get("id") == "build"]
    expected_env = {
        "DOCKER_BUILD_SUMMARY": "false",
        "DOCKER_BUILD_RECORD_UPLOAD": "false",
    }
    if len(matches) != 1 or matches[0].get("env") != expected_env:
        return ["image build must disable new summary and build-record publishing at step scope"]
    return []


if parse_rollouts(azure_workflow) != expected_azure_order:
    fail("Azure deploy workflow rollout order changed")
provenance_marker = "python3 infra/azure/agents/image_provenance_stan.py"
provider_markers = (
    "- name: Azure login",
    "az aks get-credentials",
    "baseline-capture-stan.sh",
    "shared-mongo-operation-lock-stan.sh",
    "kubectl ",
)
if provenance_marker not in azure_workflow:
    fail("Azure deploy workflow is missing immutable provenance validation")
provenance_index = azure_workflow.index(provenance_marker)
if any(
    marker in azure_workflow and azure_workflow.index(marker) < provenance_index
    for marker in provider_markers
):
    fail("Azure provenance validation does not precede every provider or mutation boundary")
if parse_services(oci_deploy_script) != expected_oci_order:
    fail("OCI deploy script rollout order changed")

action_pin_errors = validate_action_pins(build_workflow)
if action_pin_errors:
    fail("\n".join(action_pin_errors))

negative_cases = {
    "floating-major-tag": (
        mutate_once(
            build_workflow,
            f"actions/cache@{approved_action_refs['actions/cache']}",
            "actions/cache@v6",
        ),
        "is not pinned to a full 40-character lowercase hex commit SHA",
    ),
    "short-sha": (
        mutate_once(
            build_workflow,
            f"docker/login-action@{approved_action_refs['docker/login-action']}",
            "docker/login-action@dbcb813823bdd20940b903addbd779551569679",
        ),
        "is not pinned to a full 40-character lowercase hex commit SHA",
    ),
    "uppercase-nonhex": (
        mutate_once(
            build_workflow,
            f"actions/setup-node@{approved_action_refs['actions/setup-node']}",
            f"actions/setup-node@{approved_action_refs['actions/setup-node'].upper()}",
        ),
        "is not pinned to a full 40-character lowercase hex commit SHA",
    ),
    "wrong-full-sha": (
        mutate_once(
            build_workflow,
            f"docker/build-push-action@{approved_action_refs['docker/build-push-action']}",
            "docker/build-push-action@0000000000000000000000000000000000000000",
        ),
        "expected docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc",
    ),
    "unknown-action": (
        mutate_once(
            build_workflow,
            f"actions/upload-artifact@{approved_action_refs['actions/upload-artifact']}",
            "acme/unknown-action@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
        ),
        "references an unreviewed third-party action",
    ),
}

for name, (candidate, expected_fragment) in negative_cases.items():
    candidate_errors = validate_action_pins(candidate, name)
    if not candidate_errors:
        fail(f"{name} fixture unexpectedly passed")
    if any(expected_fragment in error for error in candidate_errors):
        continue
    fail(f"{name} fixture failed for the wrong reason: {' | '.join(candidate_errors)}")

build_document = json.loads(subprocess.check_output(
    ["ruby", "-ryaml", "-rjson", "-e",
     "puts JSON.generate(YAML.load_stream(File.read(ARGV.fetch(0))).first)",
     sys.argv[3]],
    text=True,
))
output_errors = validate_build_output_defaults(build_document)
if output_errors:
    fail("\n".join(output_errors))

for text, label in (
    (azure_workflow, "Azure deploy workflow"),
    (oci_deploy_script, "OCI deploy script"),
):
    if "gamemaster must rollout last" not in text:
        fail(f"{label} lost the gamemaster-last guard")

for expected_fragment in (
    "IMAGE_PROVENANCE_FILE: artifacts/deploy-provenance/images.tsv",
    "SECONDARY_PUBLIC_URL: ${{ format('https://www.{0}', env.APP_DOMAIN) }}",
    "LIVE_BETTING_READINESS_MODE: dark",
    "LIVE_READINESS_REQUEST_TIMEOUT: \"15\"",
    "LIVE_READINESS_SSE_TIMEOUT: \"20\"",
    "path: artifacts/deploy-validation/live-readiness",
):
    if expected_fragment not in azure_workflow:
        fail(f"Azure deploy workflow missing readiness wiring: {expected_fragment}")

for expected_fragment in (
    "IMAGE_PROVENANCE_FILE: artifacts/oci-deploy/images.tsv",
    "OCI_PUBLIC_URL: ${{ steps.provenance.outputs.public_url }}",
    "OCI_REDIRECT_URL: ${{ steps.provenance.outputs.redirect_url }}",
    "OCI_DIAGNOSTIC_URL: ${{ steps.provenance.outputs.diagnostic_url }}",
    "LIVE_BETTING_READINESS_MODE: dark",
    "LIVE_READINESS_REQUEST_TIMEOUT: \"15\"",
    "LIVE_READINESS_SSE_TIMEOUT: \"20\"",
    "path: artifacts/oci-deploy-validation/live-readiness",
):
    if expected_fragment not in oci_workflow:
        fail(f"OCI deploy workflow missing readiness wiring: {expected_fragment}")

if trusted_build_restoration:
    print("production_build_trusted_restoration=PASS")
    print(f"production_build_action_pins=PASS cases={len(negative_cases) + 1}")
    print("deployment_safety_ci_tests=PASS")
    sys.exit(0)

scope_step = next(
    step for step in build_document["jobs"]["change-scope"]["steps"]
    if step.get("id") == "scope"
)
scope_run = scope_step["run"]
scope_prefix = "python3 - <<'PY'\n"
scope_suffix = "\nPY\n"
if not scope_run.startswith(scope_prefix) or not scope_run.endswith(scope_suffix):
    fail("production-build change-scope step no longer exposes its classifier")
scope_code = scope_run[len(scope_prefix):-len(scope_suffix)]

def run_change_scope(paths, event_name="pull_request"):
    with tempfile.TemporaryDirectory() as directory:
        fixture_dir = pathlib.Path(directory)
        git_stub = fixture_dir / "git"
        git_stub.write_text(
            "#!/usr/bin/env bash\nprintf '%s\\n' \"${STUB_CHANGED_PATHS:-}\"\n",
            encoding="utf-8",
        )
        git_stub.chmod(0o755)
        output_path = fixture_dir / "github-output"
        environment = os.environ.copy()
        environment.update({
            "BASE_SHA": "0" * 40,
            "HEAD_SHA": "1" * 40,
            "GITHUB_EVENT_NAME": event_name,
            "GITHUB_OUTPUT": str(output_path),
            "PATH": f"{fixture_dir}:{environment['PATH']}",
            "STUB_CHANGED_PATHS": "\n".join(paths),
        })
        subprocess.run(
            [sys.executable, "-c", scope_code],
            check=True,
            env=environment,
            stdout=subprocess.DEVNULL,
        )
        outputs = dict(
            line.split("=", 1)
            for line in output_path.read_text(encoding="utf-8").splitlines()
        )
        return outputs

deployment_scope_fixtures = {
    "none": (["docs/wiki/Quality-Gates.md"], "none"),
    "meta": ([".github/workflows/production-build.yml"], "meta"),
    "deploy": ([".github/workflows/production-deploy.yml"], "full"),
    "rollback-workflow": (
        [".github/workflows/production-rollback.yml"], "full"
    ),
    "baseline": (["infra/azure/agents/baseline-capture-stan.sh"], "full"),
    "deploy-operator": (["infra/azure/agents/deploy-stan.sh"], "full"),
    "rollback": (["infra/azure/agents/rollback-application-stan.sh"], "full"),
    "shared-lock": (
        ["infra/azure/agents/shared-mongo-operation-lock-stan.sh"], "full"
    ),
    "shared-lock-test": (
        ["infra/azure/agents/test-shared-mongo-operation-lock-stan.sh"], "full"
    ),
    "rename-old-and-new": (
        [
            "infra/azure/agents/rollback-application-stan.sh",
            "docs/archive/rollback-application-stan.sh",
        ],
        "full",
    ),
}
for name, (paths, expected_scope) in deployment_scope_fixtures.items():
    actual_scope = run_change_scope(paths)["deployment_safety"]
    if actual_scope != expected_scope:
        fail(
            f"deployment scope fixture {name} selected {actual_scope}, "
            f"expected {expected_scope}"
        )
print(
    "production_build_deployment_scope=PASS "
    f"cases={len(deployment_scope_fixtures)}"
)

all_services = [
    "auth", "bet", "backoffice", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry", "client",
]
selector_fixtures = {
    "unrelated": (
        ["docs/wiki/Quality-Gates.md"],
        "pull_request",
        {
            "auth_smoke": "false",
            "coverage_needed": "false",
            "coverage_matrix": {"service": ["none"]},
            "deployment_safety": "none",
            "runtime_validation": "false",
        },
    ),
    "service": (
        ["auth/src/index.js"],
        "pull_request",
        {
            "auth_smoke": "true",
            "coverage_needed": "true",
            "coverage_matrix": {"service": ["auth"]},
            "deployment_safety": "none",
            "runtime_validation": "false",
        },
    ),
    "common": (
        ["common/src/contracts.ts"],
        "pull_request",
        {
            "auth_smoke": "true",
            "coverage_needed": "true",
            "coverage_matrix": {"service": all_services},
            "deployment_safety": "none",
            "runtime_validation": "false",
        },
    ),
    "unknown": (
        ["package.json"],
        "pull_request",
        {
            "auth_smoke": "true",
            "coverage_needed": "true",
            "coverage_matrix": {"service": all_services},
            "deployment_safety": "none",
            "runtime_validation": "false",
        },
    ),
    "rename-old-and-new": (
        ["auth/src/legacy.js", "docs/archive/legacy.js"],
        "pull_request",
        {
            "auth_smoke": "true",
            "coverage_needed": "true",
            "coverage_matrix": {"service": ["auth"]},
            "deployment_safety": "none",
            "runtime_validation": "false",
        },
    ),
    "push-full": (
        [],
        "push",
        {
            "auth_smoke": "true",
            "coverage_needed": "true",
            "coverage_matrix": {"service": all_services},
            "deployment_safety": "full",
            "runtime_validation": "true",
        },
    ),
}
for name, (paths, event_name, expected) in selector_fixtures.items():
    actual = run_change_scope(paths, event_name)
    actual["coverage_matrix"] = json.loads(actual["coverage_matrix"])
    if actual != expected:
        fail(f"change-scope fixture {name} selected {actual}, expected {expected}")
print(f"production_build_change_scope=PASS cases={len(selector_fixtures)}")

quality_gate_step = next(
    step for step in build_document["jobs"]["pr-quality-gates"]["steps"]
    if step.get("name") == "Require every validation gate"
)
quality_gate_script = quality_gate_step["run"]
quality_environment = {
    "SCOPE_RESULT": "success",
    "MANIFEST_RESULT": "success",
    "INGRESS_RESULT": "success",
    "RUNTIME_NEEDED": "false",
    "SCRIPT_RESULT": "skipped",
    "WORKFLOW_RESULT": "success",
    "DEPLOYMENT_SAFETY_NEEDED": "none",
    "DEPLOYMENT_SAFETY_RESULT": "skipped",
    "AUTH_NEEDED": "false",
    "AUTH_CONTAINER_RESULT": "skipped",
    "COVERAGE_NEEDED": "false",
    "COVERAGE_RESULT": "skipped",
}

def quality_gate_result(overrides):
    environment = os.environ.copy()
    environment.update(quality_environment)
    environment.update(overrides)
    return subprocess.run(
        ["bash", "-c", quality_gate_script],
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode

if quality_gate_result({}) != 0:
    fail("unaffected quality aggregation fixture failed")
quality_gate_negative_fixtures = {
    "runtime-skipped-when-selected": {
        "RUNTIME_NEEDED": "true",
        "SCRIPT_RESULT": "skipped",
    },
    "auth-skipped-when-selected": {
        "AUTH_NEEDED": "true",
        "AUTH_CONTAINER_RESULT": "skipped",
    },
    "deployment-skipped-when-selected": {
        "DEPLOYMENT_SAFETY_NEEDED": "full",
        "DEPLOYMENT_SAFETY_RESULT": "skipped",
    },
    "coverage-skipped-when-selected": {
        "COVERAGE_NEEDED": "true",
        "COVERAGE_RESULT": "skipped",
    },
}
for name, overrides in quality_gate_negative_fixtures.items():
    if quality_gate_result(overrides) == 0:
        fail(f"quality aggregation accepted {name}")
if quality_gate_result({
    "RUNTIME_NEEDED": "true",
    "SCRIPT_RESULT": "success",
    "AUTH_NEEDED": "true",
    "AUTH_CONTAINER_RESULT": "success",
    "DEPLOYMENT_SAFETY_NEEDED": "full",
    "DEPLOYMENT_SAFETY_RESULT": "success",
    "COVERAGE_NEEDED": "true",
    "COVERAGE_RESULT": "success",
}) != 0:
    fail("fully selected quality aggregation fixture failed")
build_condition = build_document["jobs"]["build"]["if"]
for required_result in (
    "needs.deploy-runtime-script-validate.result == 'success'",
    "needs.auth-container-smoke.result == 'success'",
):
    if required_result not in build_condition:
        fail(f"push build can bypass required result: {required_result}")
print(
    "production_build_quality_aggregation=PASS "
    f"cases={len(quality_gate_negative_fixtures) + 2}"
)

for key in ("DOCKER_BUILD_SUMMARY", "DOCKER_BUILD_RECORD_UPLOAD"):
    for value in (None, "true"):
        candidate = copy.deepcopy(build_document)
        build_step = next(
            step for step in candidate["jobs"]["build"]["steps"]
            if step.get("id") == "build"
        )
        if value is None:
            del build_step["env"][key]
        else:
            build_step["env"][key] = value
        if not validate_build_output_defaults(candidate):
            fail(f"build-output fixture unexpectedly passed: {key}={value}")
wrong_scope = copy.deepcopy(build_document)
wrong_scope_step = next(
    step for step in wrong_scope["jobs"]["build"]["steps"]
    if step.get("id") == "build"
)
wrong_scope["jobs"]["build"]["env"] = wrong_scope_step.pop("env")
if not validate_build_output_defaults(wrong_scope):
    fail("job-wide build output settings unexpectedly passed")
print("production_build_output_defaults=PASS cases=6")

for required_test in (
    "./infra/azure/agents/pre-commit-infra-check-stan.sh",
    "./infra/azure/agents/test-deployment-safety-ci-stan.sh",
    "./infra/azure/agents/test-deploy-validation-loop-stan.sh",
    "./infra/azure/agents/test-live-betting-readiness-stan.sh",
    "./infra/azure/agents/test-live-betting-rollback-readiness-stan.sh",
    "./infra/azure/agents/test-production-rollback-stan.sh",
    "./infra/azure/agents/test-shared-mongo-operation-lock-stan.sh",
):
    if required_test not in build_workflow:
        fail(f"production-build.yml is missing {required_test}")
for duplicated_test in (
    "./infra/oci/tests/test-deploy-validation-loop-stan.sh",
    "./infra/oci/tests/test-live-data-maintenance-stan.sh",
    "./infra/oci/tests/test-live-betting-control-stan.sh",
    "./infra/oci/tests/test-revalidate-live-activation-stan.sh",
    "./infra/oci/tests/test-live-betting-data-rollout-stan.sh",
    "./infra/oci/tests/test-live-betting-readiness-stan.sh",
    "./infra/oci/tests/rollback-live-readiness-contract.sh",
    "./infra/oci/tests/rollback-contract.sh",
):
    if duplicated_test in build_workflow:
        fail(f"production-build.yml duplicates OCI validation: {duplicated_test}")
if build_document["jobs"]["deployment-safety-contracts"].get("timeout-minutes") != 45:
    fail("production-build deployment safety job lacks the 45-minute bound")
for required_fragment in (
    "types: [opened, synchronize, reopened]",
    "change-scope:",
    "coverage_needed: ${{ steps.scope.outputs.coverage_needed }}",
    "coverage_matrix: ${{ steps.scope.outputs.coverage_matrix }}",
    "deployment_safety: ${{ steps.scope.outputs.deployment_safety }}",
    'matrix: ${{ fromJSON(needs.change-scope.outputs.coverage_matrix) }}',
    "if: needs.change-scope.outputs.deployment_safety != 'none'",
    "if: needs.change-scope.outputs.coverage_needed == 'true'",
    '"git", "diff", "--no-renames", "--name-only"',
    ".github/workflows/production-rollback.yml",
    "infra/azure/agents/baseline-capture-stan.sh",
    "infra/azure/agents/deploy-stan.sh",
    "infra/azure/agents/rollback-application-stan.sh",
    "infra/azure/agents/production-run-exclusivity-stan.sh",
    "infra/azure/agents/shared-mongo-operation-lock-stan.sh",
):
    if required_fragment not in build_workflow:
        fail(f"production-build.yml is missing lean routing: {required_fragment}")
if "types: [opened, synchronize, reopened, edited]" in build_workflow:
    fail("production-build.yml reruns source validation on metadata edits")
if "Record unaffected service coverage" in build_workflow:
    fail("production-build.yml retains the dummy coverage sentinel job")

print(f"production_build_action_pins=PASS cases={len(negative_cases) + 1}")
print("deployment_safety_ci_tests=PASS")
PY

grep -Fq 'reject_telemetry_era_source(Path.cwd())' \
  "$AZURE_IMAGE_PROVENANCE" || {
    echo "Azure provenance validator is missing the Telemetry-era source guard" >&2
    exit 1
  }
grep -Fq \
  "Telemetry-era releases use the active OCI deployment path; dormant Azure deployment is unavailable." \
  "$AZURE_IMAGE_PROVENANCE" || {
    echo "Azure provenance validator emitted the wrong Telemetry-era diagnostic" >&2
    exit 1
  }
