#!/usr/bin/env bash
set -euo pipefail

# Focused contract for the maintenance-fenced rollback recovery operator and the
# maintenance-fenced readiness phase. Every case is offline: kubectl, curl and
# the maintenance/lock helpers are replaced by recorded fakes so the accepted
# fenced state and each fail-closed case are enforced deterministically.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATOR="$ROOT_DIR/infra/oci/scripts/recover-fenced-rollback-stan.sh"
READINESS="$ROOT_DIR/infra/oci/scripts/rollback-readiness-stan.sh"
WORKFLOW_FILE="$ROOT_DIR/.github/workflows/oci-production-rollback.yml"
POLICY="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"

WORK_PARENT="$ROOT_DIR/infra/oci/tests/.rollback-contract-workdirs"
mkdir -p "$WORK_PARENT"
WORK_DIR="$(mktemp -d "$WORK_PARENT/fenced-XXXXXX")"
chmod 700 "$WORK_DIR"
cleanup() {
  if [[ "${KEEP_TEST_WORKDIR:-0}" != "1" ]]; then
    rm -rf "$WORK_DIR"
    rmdir "$WORK_PARENT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

TARGET_SHA=4444444444444444444444444444444444444444
DEPLOYED_SHA=5555555555555555555555555555555555555555
DEPLOY_RUN_ID=34068978832
DATA_RUN_ID=34068138505
INFRA_RUN_ID=34039847193
SERVICES=(auth bet backoffice client event moderation resulting slip gamemaster)
QUIESCED=(bet event gamemaster moderation resulting slip)

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  grep -Fq -- "$2" "$1" || fail "expected '$2' in $1"
}

digest_for() {
  # Deterministic distinct digests per (generation, service).
  printf '%s' "$1-$2" | shasum -a 256 | awk '{print $1}'
}

image_for() {
  printf 'ghcr.io/vasilyevstan/betstan-images@sha256:%s' "$(digest_for "$1" "$2")"
}

# ---------------------------------------------------------------- fixtures ---
new_case() {
  local name="$1"
  CASE_DIR="$WORK_DIR/$name"
  BIN_DIR="$CASE_DIR/bin"
  STATE_DIR="$CASE_DIR/state"
  BASELINE_DIR="$CASE_DIR/baseline"
  BUILD_DIR="$CASE_DIR/build"
  OUT_DIR="$CASE_DIR/out"
  mkdir -p "$BIN_DIR" "$STATE_DIR" "$BASELINE_DIR" "$BUILD_DIR" "$OUT_DIR"

  : >"$STATE_DIR/kubectl.log"
  printf 'held\n' >"$STATE_DIR/maintenance"
  printf 'held\n' >"$STATE_DIR/lock"
  printf '0\n' >"$STATE_DIR/moderation-restarts"

  # Baseline artifact describes the known-good target generation.
  {
    printf 'baseline_source_sha=%s\n' "$TARGET_SHA"
    printf 'baseline_deploy_run_id=%s\n' 34045296926
    printf 'baseline_build_run_id=%s\n' 34037745321
    printf 'database_restore=disabled\n'
    printf 'registry_provider=ghcr\n'
    printf 'registry_repository=ghcr.io/vasilyevstan/betstan-images\n'
    printf 'registry_public_anonymous=true\n'
  } >"$BASELINE_DIR/baseline-provenance.env"

  : >"$BASELINE_DIR/deployments.tsv"
  : >"$BASELINE_DIR/images.tsv"
  : >"$BUILD_DIR/images.tsv"
  local service
  for service in "${SERVICES[@]}"; do
    printf '%s\t%s\t30\t1\t1\t1\n' "$service" "$(image_for target "$service")" \
      >>"$BASELINE_DIR/deployments.tsv"
    printf '%s\tghcr.io/vasilyevstan/betstan-images\t%s\tsha256:%s\n' \
      "$service" "$(image_for target "$service")" "$(digest_for target "$service")" \
      >>"$BASELINE_DIR/images.tsv"
    printf '%s\tghcr.io/vasilyevstan/betstan-images\t%s\tsha256:%s\n' \
      "$service" "$(image_for deployed "$service")" "$(digest_for deployed "$service")" \
      >>"$BUILD_DIR/images.tsv"
    printf '%s\n' "$(image_for deployed "$service")" >"$STATE_DIR/image-$service"
    if printf '%s\n' "${QUIESCED[@]}" | grep -qx "$service"; then
      printf '0\n' >"$STATE_DIR/replicas-$service"
    else
      printf '1\n' >"$STATE_DIR/replicas-$service"
    fi
  done

  write_fakes
}

write_fakes() {
  cat >"$BIN_DIR/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${FAKE_STATE_DIR}"
printf '%s\n' "$*" >>"$STATE_DIR/kubectl.log"
svc_from_depl() { sed -e 's/^gaming-//' -e 's/-depl$//' <<<"$1"; }
case "$1" in
  get)
    case "$2" in
      deployment)
        depl="$3"; svc="$(svc_from_depl "$depl")"
        image="$(cat "$STATE_DIR/image-$svc")"
        replicas="$(cat "$STATE_DIR/replicas-$svc")"
        if [[ "$*" == *"readyReplicas"* ]]; then printf '%s' "$replicas"; exit 0; fi
        if [[ "$*" == *"-o json"* ]]; then
          cat <<JSON
{"spec":{"replicas":$replicas,"template":{"spec":{"containers":[{"name":"gaming-$svc","image":"$image"}]}}},
 "status":{"readyReplicas":$replicas,"updatedReplicas":$replicas,"availableReplicas":$replicas}}
JSON
          exit 0
        fi
        printf '%s' "$image"; exit 0
        ;;
      deployment/*|pod|pods)
        if [[ "$2" == deployment/* ]]; then
          svc="$(svc_from_depl "${2#deployment/}")"
          printf '%s' "$(cat "$STATE_DIR/image-$svc")"; exit 0
        fi
        if [[ "$*" == *"gaming-moderation"* ]]; then
          if [[ "${FAKE_MODERATION_FLAPS:-0}" == "1" ]]; then
            current="$(cat "$STATE_DIR/moderation-restarts")"
            printf '%s\n' "$((current + 1))" >"$STATE_DIR/moderation-restarts"
          fi
          cat "$STATE_DIR/moderation-restarts"; exit 0
        fi
        printf 'gaming-rabbitmq-depl-fake'; exit 0
        ;;
    esac
    ;;
  set)
    depl="${3#deployment/}"; svc="$(svc_from_depl "$depl")"
    for arg in "$@"; do
      [[ "$arg" == *=ghcr.io/* ]] && printf '%s\n' "${arg#*=}" >"$STATE_DIR/image-$svc"
    done
    exit 0
    ;;
  scale)
    depl="${2#deployment/}"; svc="$(svc_from_depl "$depl")"
    for arg in "$@"; do
      [[ "$arg" == --replicas=* ]] && printf '%s\n' "${arg#--replicas=}" >"$STATE_DIR/replicas-$svc"
    done
    exit 0
    ;;
  rollout)
    if [[ -n "${FAKE_ROLLOUT_FAILS:-}" && "$*" == *"gaming-${FAKE_ROLLOUT_FAILS}-depl"* ]]; then
      echo "rollout failed" >&2; exit 1
    fi
    exit 0 ;;
  exec) printf 'event_new_event\t0\t0\t0\n'; exit 0 ;;
esac
exit 0
EOF

  cat >"$BIN_DIR/maintenance" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${FAKE_STATE_DIR}"
case "$1" in
  verify-held)
    [[ "$(cat "$STATE_DIR/maintenance")" == "held" ]] || { echo "not held" >&2; exit 1; }
    echo "live_data_maintenance=verify-held status=PASS" ;;
  hold) printf 'held\n' >"$STATE_DIR/maintenance"; echo "held" ;;
  release)
    if [[ "${FAKE_FENCE_RELEASE_FAILS:-0}" == "1" ]]; then echo "release failed" >&2; exit 1; fi
    printf 'released\n' >"$STATE_DIR/maintenance"; echo "released" ;;
esac
EOF

  cat >"$BIN_DIR/lock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${FAKE_STATE_DIR}"
[[ "$LOCK_TOKEN" == "live-data-${FAKE_EXPECTED_DATA_RUN}-1" ]] || { echo "wrong lock token" >&2; exit 1; }
[[ "$SOURCE_SHA" == "$FAKE_EXPECTED_SOURCE_SHA" ]] || { echo "wrong lock source sha" >&2; exit 1; }
case "$1" in
  verify)
    [[ "$(cat "$STATE_DIR/lock")" == "held" ]] || {
      echo "shared_mongo_lock=verify status=FAIL reason=active database operation lock has expired" >&2
      exit 1
    } ;;
  acquire)
    [[ "$(cat "$STATE_DIR/lock")" != "contended" ]] || {
      echo "another database operation holds the lock" >&2; exit 1
    }
    [[ -n "${LOCK_LEASE_SECONDS:-}" ]] || { echo "acquire requires a lease" >&2; exit 1; }
    printf 'held\n' >"$STATE_DIR/lock" ;;
  release) printf 'released\n' >"$STATE_DIR/lock" ;;
  verify-released)
    [[ "$(cat "$STATE_DIR/lock")" == "released" ]] || { echo "lock still held" >&2; exit 1; } ;;
esac
echo "shared_mongo_lock=$1 status=PASS"
EOF

  # Readiness fake: asserts the phase contract the operator must request.
  cat >"$BIN_DIR/readiness" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$OUTPUT_DIR"
phase="${ROLLBACK_READINESS_PHASE:-steady-state}"
status=GO
if [[ "$phase" == "maintenance-fenced" ]]; then
  [[ -n "${MAINTENANCE_LIVE_IMAGES_FILE:-}" && -f "$MAINTENANCE_LIVE_IMAGES_FILE" ]] ||
    { echo "fenced readiness requires live images" >&2; exit 1; }
  [[ "${MAINTENANCE_DEPLOYED_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
    { echo "fenced readiness requires deployed sha" >&2; exit 1; }
  [[ "${FAKE_FENCED_READINESS:-GO}" == "GO" ]] && status=GO || status=NO_GO
else
  [[ "${FAKE_STEADY_READINESS:-GO}" == "GO" ]] && status=GO || status=NO_GO
fi
printf 'rollback_readiness=%s\nmode=application-rollback\nphase=%s\n' \
  "$status" "$phase" >"$OUTPUT_DIR/summary.env"
[[ "$status" == "GO" ]] || exit 1
EOF
  chmod 755 "$BIN_DIR"/*
}

run_operator() {
  env \
  PATH="$BIN_DIR:$PATH" \
  FAKE_STATE_DIR="$STATE_DIR" \
  FAKE_EXPECTED_DATA_RUN="$DATA_RUN_ID" \
  FAKE_EXPECTED_SOURCE_SHA="$DEPLOYED_SHA" \
  TARGET_SHA="${OVERRIDE_TARGET_SHA:-$TARGET_SHA}" \
  DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
  FENCED_DEPLOY_RUN_ID="${FENCED_DEPLOY_RUN_ID:-$DEPLOY_RUN_ID}" \
  FENCED_DATA_RUN_ID="${FENCED_DATA_RUN_ID:-$DATA_RUN_ID}" \
  INFRASTRUCTURE_RUN_ID="$INFRA_RUN_ID" \
  BASELINE_DIR="$BASELINE_DIR" \
  PRE_RECOVERY_BUILD_DIR="$BUILD_DIR" \
  OUTPUT_DIR="$OUT_DIR" \
  READINESS_SCRIPT="$BIN_DIR/readiness" \
  MAINTENANCE_SCRIPT="$BIN_DIR/maintenance" \
  LOCK_SCRIPT="$BIN_DIR/lock" \
  MODERATION_OBSERVATION_ATTEMPTS=2 \
  MODERATION_OBSERVATION_SLEEP_SECONDS=0 \
  "$@" \
  "$OPERATOR"
}

# ------------------------------------------------------------ accepted case ---
new_case accepted
run_operator >"$CASE_DIR/out.txt" 2>&1 ||
  fail "accepted fenced state was rejected: $(cat "$CASE_DIR/out.txt")"
assert_contains "$CASE_DIR/out.txt" 'oci_fenced_rollback_recovery=PASS'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'status=PASS'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'maintenance_fence=released'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=released'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock_acquisition=verified'
[[ "$(cat "$STATE_DIR/maintenance")" == "released" ]] ||
  fail 'accepted fenced recovery did not release the maintenance fence'
[[ "$(cat "$STATE_DIR/lock")" == "released" ]] ||
  fail 'accepted fenced recovery did not release the database lock'
for service in "${SERVICES[@]}"; do
  [[ "$(cat "$STATE_DIR/image-$service")" == "$(image_for target "$service")" ]] ||
    fail "accepted fenced recovery did not restore $service to the baseline digest"
  [[ "$(cat "$STATE_DIR/replicas-$service")" == "1" ]] ||
    fail "accepted fenced recovery did not restore $service replicas"
done
# Established safe order: lock released before the public fence.
lock_line="$(grep -n 'shared_mongo_lock=release ' "$OUT_DIR/fenced-lock-release.txt" | head -1 | cut -d: -f1)"
[[ -n "$lock_line" ]] || fail 'lock release evidence missing'
[[ -f "$OUT_DIR/fenced-fence-release.txt" ]] || fail 'fence release evidence missing'
# Restore order must lead with API dependencies and end with Gamemaster.
[[ "$(head -1 "$OUT_DIR/fenced-restore-order.tsv" | cut -f1)" == "auth" ]] ||
  fail 'fenced restore order did not start with auth'
[[ "$(tail -1 "$OUT_DIR/fenced-restore-order.tsv" | cut -f1)" == "gamemaster" ]] ||
  fail 'fenced restore order did not end with gamemaster'

# ---------------------------------------------------------- fail-closed set ---
expect_reject() {
  local name="$1" message="$2"; shift 2
  new_case "$name"
  "$@"
  if run_operator >"$CASE_DIR/out.txt" 2>&1; then
    fail "fenced recovery accepted $name"
  fi
  assert_contains "$CASE_DIR/out.txt" "$message"
}

mutate_baseline_target() {
  sed -i.bak "s/baseline_source_sha=$TARGET_SHA/baseline_source_sha=6666666666666666666666666666666666666666/" \
    "$BASELINE_DIR/baseline-provenance.env"
}
break_fence() { printf 'released\n' >"$STATE_DIR/maintenance"; }
break_lock() { printf 'expired\n' >"$STATE_DIR/lock"; }
contend_lock() { printf 'contended\n' >"$STATE_DIR/lock"; }
wrong_live_digest() { printf '%s\n' "$(image_for other event)" >"$STATE_DIR/image-event"; }
unexpected_quiesced() { printf '1\n' >"$STATE_DIR/replicas-event"; }

expect_reject wrong-target \
  'baseline does not describe the rollback target' mutate_baseline_target
expect_reject missing-fence \
  'maintenance fence and writer quiescence are not intact' break_fence
expect_reject contended-lock \
  'the transferred database lock is held by another live operation' contend_lock

# An expired lease with the fence and quiescence still intact is the documented
# rehold state: reclaim it (fencing generation bumped) rather than fail.
new_case expired-lock-reclaim
break_lock
run_operator >"$CASE_DIR/out.txt" 2>&1 ||
  fail "fenced recovery rejected a reclaimable expired lease: $(cat "$CASE_DIR/out.txt")"
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock_acquisition=reclaimed'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'status=PASS'

# A live generation that is not the authorized deployed generation must be
# rejected before any mutation.
new_case wrong-live-digest
wrong_live_digest
if run_operator >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted a wrong live digest'
fi
grep -Fq 'set image' "$STATE_DIR/kubectl.log" &&
  fail 'fenced recovery mutated a deployment despite a wrong live digest'

# The fenced readiness gate itself must be able to reject (unexpected 200 on a
# fenced path, unexpected quiesced workload, or excessive backlog all surface
# here as NO_GO) and must do so before mutation.
new_case fenced-readiness-nogo
if run_operator FAKE_FENCED_READINESS=NO_GO >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery ignored a fenced readiness rejection'
fi
assert_contains "$CASE_DIR/out.txt" \
  'maintenance-fenced readiness rejected the fenced rollback recovery'
grep -Fq 'set image' "$STATE_DIR/kubectl.log" &&
  fail 'fenced recovery mutated a deployment after readiness rejection'

# Post-restore steady-state failure must re-hold maintenance and keep the lock.
new_case steady-nogo
if run_operator FAKE_STEADY_READINESS=NO_GO >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted a failing steady-state gate'
fi
assert_contains "$CASE_DIR/out.txt" \
  'restored generation failed ordinary steady-state readiness'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'status=FAIL'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'maintenance_fence=re-held'
# By this point the lock was already legitimately released in the contract
# order, so the summary must say so rather than claim a lock it does not hold.
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=released'
[[ "$(cat "$STATE_DIR/maintenance")" == "held" ]] ||
  fail 'failed fenced recovery did not re-hold maintenance'

# A failure during the restore itself, before the contract releases anything,
# must re-hold maintenance AND preserve the transferred database lock.
new_case restore-failure
if run_operator FAKE_ROLLOUT_FAILS=moderation >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted a failed rollout'
fi
assert_contains "$CASE_DIR/out.txt" 'rollout did not complete for gaming-moderation-depl'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'maintenance_fence=re-held'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=retained'
[[ "$(cat "$STATE_DIR/lock")" == "held" ]] ||
  fail 'restore failure released the transferred database lock'
[[ "$(cat "$STATE_DIR/maintenance")" == "held" ]] ||
  fail 'restore failure did not re-hold maintenance'

# Moderation restarting during the observation window must also fail closed
# with the lock still held.
new_case moderation-unstable
if run_operator FAKE_MODERATION_FLAPS=1 >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted a flapping Moderation pod'
fi
assert_contains "$CASE_DIR/out.txt" \
  'gaming-moderation restarted during the recovery observation window'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=retained'
[[ "$(cat "$STATE_DIR/lock")" == "held" ]] ||
  fail 'moderation instability released the transferred database lock'

# Fence release failure must also re-hold and preserve evidence.
new_case fence-release-failure
if run_operator FAKE_FENCE_RELEASE_FAILS=1 >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted a failed fence release'
fi
assert_contains "$CASE_DIR/out.txt" \
  'the maintenance fence could not be released safely'
[[ "$(cat "$STATE_DIR/maintenance")" == "held" ]] ||
  fail 'fence release failure did not re-hold maintenance'
# The summary must honestly report that the lock was already released.
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=released'

# Identity guards.
new_case same-generation
if OVERRIDE_TARGET_SHA="$DEPLOYED_SHA" run_operator >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted the deployed generation as its target'
fi
assert_contains "$CASE_DIR/out.txt" \
  'fenced rollback recovery cannot target the deployed generation'

new_case outside-incomplete-deployment
if FENCED_DEPLOY_RUN_ID=0 run_operator >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery ran outside an incomplete deployment'
fi
assert_contains "$CASE_DIR/out.txt" 'FENCED_DEPLOY_RUN_ID must be a positive integer'

new_case wrong-data-run
if FENCED_DATA_RUN_ID=999 run_operator >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted a wrong data run lock token'
fi

# ------------------------------------------------- readiness phase contract ---
# The readiness script must fail closed on an unknown phase and must require the
# fenced evidence rather than silently degrading to steady state.
phase_out="$WORK_DIR/phase-unknown.txt"
if ROLLBACK_READINESS_PHASE=whatever OUTPUT_DIR="$WORK_DIR/phase-unknown" \
    TARGET_SHA="$TARGET_SHA" "$READINESS" >"$phase_out" 2>&1; then
  fail 'readiness accepted an unknown phase'
fi
assert_contains "$phase_out" 'unsupported ROLLBACK_READINESS_PHASE'

phase_out="$WORK_DIR/phase-unbound.txt"
if ROLLBACK_READINESS_PHASE=maintenance-fenced OUTPUT_DIR="$WORK_DIR/phase-unbound" \
    TARGET_SHA="$TARGET_SHA" "$READINESS" >"$phase_out" 2>&1; then
  fail 'readiness accepted an unbound maintenance-fenced phase'
fi
assert_contains "$phase_out" 'MAINTENANCE_DEPLOYED_SOURCE_SHA'

# ------------------------------------------------------- static assertions ---
bash -n "$OPERATOR" "$READINESS"
assert_contains "$WORKFLOW_FILE" 'run: ./infra/oci/scripts/recover-fenced-rollback-stan.sh'
assert_contains "$WORKFLOW_FILE" 'RECOVER OCI FENCED ROLLBACK'
assert_contains "$WORKFLOW_FILE" '[ "$BASELINE_SOURCE_RUN_ID" = "$FENCED_DEPLOY_RUN_ID" ]'
assert_contains "$WORKFLOW_FILE" '[ "$pre_recovery_source_sha" = "$DEPLOYED_SOURCE_SHA" ]'
assert_contains "$WORKFLOW_FILE" '[ "$fenced_conclusion" = "failure" ]'
assert_contains "$WORKFLOW_FILE" 'Re-enter maintenance after an incomplete deployment'
assert_contains "$WORKFLOW_FILE" "if: inputs.partial_rollback_run_id == '0' && inputs.fenced_deploy_run_id == '0'"

# No generic bypass may exist anywhere in the trusted rollback tooling.
for forbidden in SKIP_READINESS FORCE_ROLLBACK BYPASS_READINESS ALLOW_UNHEALTHY; do
  if grep -rq "$forbidden" "$OPERATOR" "$READINESS" "$WORKFLOW_FILE"; then
    fail "trusted rollback tooling exposes a generic bypass: $forbidden"
  fi
done

# The fenced operation must be dispatch-bound, never automatic.
"$POLICY" get oci-production-rollback-fenced |
  python3 -c '
import json, sys
policy = json.load(sys.stdin)
assert policy["authority"] == "dispatch-record", "fenced rollback must be dispatch-bound"
assert policy["environment"] == "oci-production", "fenced rollback must use oci-production"
assert policy["fixedInputs"]["confirmation"] == "RECOVER OCI FENCED ROLLBACK"
assert policy["fixedInputs"]["partial_rollback_run_id"] == "0"
for name in ("fenced_deploy_run_id", "fenced_data_run_id", "pre_recovery_build_run_id"):
    assert name in policy["positiveIntegerInputs"], name
assert "deployed_source_sha" in policy["fullShaInputs"]
assert policy["targetRelation"] == "ancestor"
print("fenced_rollback_policy=PASS")
'

echo 'oci_fenced_rollback_recovery_contract=PASS'
