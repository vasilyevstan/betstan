#!/usr/bin/env bash
set -euo pipefail

# Focused contract for the maintenance-fenced rollback recovery operator and the
# maintenance-fenced readiness phase. Every case is offline: kubectl, curl and
# the maintenance/lock helpers are replaced by recorded fakes so the accepted
# fenced state and each fail-closed case are enforced deterministically.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATOR="$ROOT_DIR/infra/oci/scripts/recover-fenced-rollback-stan.sh"
READINESS="$ROOT_DIR/infra/oci/scripts/rollback-readiness-stan.sh"
CLEANUP_CLASSIFIER="$ROOT_DIR/infra/oci/scripts/backoffice-cleanup-journal-classifier.js"
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
QUIESCED=(backoffice bet event gamemaster moderation resulting slip)

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

refresh_baseline_manifest() {
  python3 - "$BASELINE_DIR" <<'PY'
import hashlib
import sys
from pathlib import Path
root = Path(sys.argv[1])
(root / "SHA256SUMS").write_text("".join(
    f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root)}\n"
    for path in sorted(root.rglob("*"))
    if path.is_file() and path.name != "SHA256SUMS"
), encoding="utf-8")
PY
}

write_baseline_deploy_provenance() {
  cat >"$BASELINE_DIR/trusted-deploy-provenance.txt" <<EOF
source_sha=$TARGET_SHA
deployment_workflow=oci-production-deploy
deployment_run_id=34045296926
deployment_run_attempt=1
registry_provider=ghcr
registry_host=ghcr.io
registry_repository=ghcr.io/vasilyevstan/betstan-images
registry_public_anonymous=true
image_provenance_sha256=$(shasum -a 256 "$BASELINE_DIR/images.tsv" | awk '{print $1}')
EOF
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
  : >"$STATE_DIR/lock.log"
  printf 'held\n' >"$STATE_DIR/maintenance"
  printf 'held\n' >"$STATE_DIR/lock"
  printf '0\n' >"$STATE_DIR/moderation-restarts"
  printf 'absent\n' >"$STATE_DIR/cash-back-bet"
  printf 'absent\n' >"$STATE_DIR/cash-back-resulting"

  # Baseline artifact describes the known-good target generation.
  {
    printf 'baseline_source_sha=%s\n' "$TARGET_SHA"
    printf 'baseline_deploy_workflow=oci-production-deploy\n'
    printf 'baseline_deploy_run_id=%s\n' 34045296926
    printf 'baseline_deploy_run_attempt=1\n'
    printf 'baseline_build_workflow=oci-production-build\n'
    printf 'baseline_build_run_id=%s\n' 34037745321
    printf 'baseline_build_run_attempt=1\n'
    printf 'baseline_capture_run_id=34068138505\n'
    printf 'baseline_capture_run_attempt=1\n'
    printf 'namespace=betstan-oci\n'
    printf 'database_restore=disabled\n'
    printf 'registry_provider=ghcr\n'
    printf 'registry_host=ghcr.io\n'
    printf 'registry_repository=ghcr.io/vasilyevstan/betstan-images\n'
    printf 'registry_public_anonymous=true\n'
  } >"$BASELINE_DIR/baseline-provenance.env"

  : >"$BASELINE_DIR/deployments.tsv"
  : >"$BASELINE_DIR/images.tsv"
  : >"$BUILD_DIR/images.tsv"
  local service
  for service in "${SERVICES[@]}" telemetry; do
    printf '%s\t%s\t30\t1\t1\t1\n' "$service" "$(image_for target "$service")" \
      >>"$BASELINE_DIR/deployments.tsv"
    printf '%s\tghcr.io/vasilyevstan/betstan-images\t%s\tsha256:%s\tsha256:%s\n' \
      "$service" "$(image_for target "$service")" "$(digest_for target "$service")" "$(digest_for target "$service")" \
      >>"$BASELINE_DIR/images.tsv"
    printf '%s\tghcr.io/vasilyevstan/betstan-images\t%s\tsha256:%s\tsha256:%s\n' \
      "$service" "$(image_for deployed "$service")" "$(digest_for deployed "$service")" "$(digest_for deployed "$service")" \
      >>"$BUILD_DIR/images.tsv"
    printf '%s\n' "$(image_for deployed "$service")" >"$STATE_DIR/image-$service"
    if printf '%s\n' "${QUIESCED[@]}" | grep -qx "$service"; then
      printf '0\n' >"$STATE_DIR/replicas-$service"
    else
      printf '1\n' >"$STATE_DIR/replicas-$service"
    fi
  done
  printf '%s\n' "$(image_for deployed telemetry)" >"$STATE_DIR/image-telemetry"
  printf '1\n' >"$STATE_DIR/replicas-telemetry"
  printf '1\n' >"$STATE_DIR/ready-telemetry"
  : >"$STATE_DIR/service-telemetry"
  printf '2\n' >"$STATE_DIR/telemetry-routes"
  cat >"$BASELINE_DIR/telemetry-pre-run.env" <<EOF
mode=retained
image=$(image_for target telemetry)
database_initialized=true
queue_present=true
EOF
  awk -F '\t' '{print $1 "\t" $3}' "$BASELINE_DIR/images.tsv" >"$BASELINE_DIR/live-images.tsv"
  awk -F '\t' '{print $1 "\t" $1 "-pod\t" $3}' "$BASELINE_DIR/images.tsv" >"$BASELINE_DIR/pod-images.tsv"
  printf 'telemetry:events:v1\t0\t0\t1\n' >"$BASELINE_DIR/queues.tsv"
  write_baseline_deploy_provenance
  refresh_baseline_manifest

  write_fakes
}

write_fakes() {
  cat >"$BIN_DIR/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${FAKE_STATE_DIR}"
printf '%s\n' "$*" >>"$STATE_DIR/kubectl.log"
printf 'kubectl %s\n' "$*" >>"$STATE_DIR/operations.log"
svc_from_depl() { sed -e 's/^gaming-//' -e 's/-depl$//' <<<"$1"; }
case "$1" in
  get)
    case "$2" in
      deployment)
        depl="$3"; svc="$(svc_from_depl "$depl")"
        if [[ "$svc" == "telemetry" && ! -f "$STATE_DIR/image-telemetry" ]]; then
          exit 0
        fi
        image="$(cat "$STATE_DIR/image-$svc")"
        replicas="$(cat "$STATE_DIR/replicas-$svc")"
        if [[ "$*" == *"readyReplicas"* ]]; then printf '%s' "$replicas"; exit 0; fi
        if [[ "$*" == *"-o json"* ]]; then
          ready="$replicas"
          [[ -f "$STATE_DIR/ready-$svc" ]] && ready="$(cat "$STATE_DIR/ready-$svc")"
          flag=absent
          [[ ! -f "$STATE_DIR/cash-back-$svc" ]] || flag="$(cat "$STATE_DIR/cash-back-$svc")"
          python3 - "$svc" "$image" "$replicas" "$ready" "$flag" <<'PY'
import json, sys
service, image, replicas, ready, flag = sys.argv[1:]
env = [{"name": "UNRELATED", "value": "retained"}]
if flag != "absent":
    env.append({"name": "CASH_BACK_ENABLED", "value": flag})
print(json.dumps({"spec": {"replicas": int(replicas), "template": {"spec": {"containers": [
    {"name": "gaming-" + service, "image": image, "env": env}
]}}}, "status": {"readyReplicas": int(ready), "updatedReplicas": int(ready), "availableReplicas": int(ready)}}))
PY
          exit 0
        fi
        printf '%s' "$image"; exit 0
        ;;
      service)
        [[ -f "$STATE_DIR/service-telemetry" ]] && printf '{"metadata":{"name":"gaming-telemetry-srv"}}'
        exit 0
        ;;
      ingress)
        routes="$(cat "$STATE_DIR/telemetry-routes")"
        python3 - "$routes" "${FAKE_TELEMETRY_ROUTE_HOST_MODE:-expected}" <<'PY'
import json, sys
count = int(sys.argv[1])
mode = sys.argv[2]
hosts = ["host-0", "host-1"]
if mode == "same-host":
    hosts = ["host-0", "host-0"]
elif mode == "unexpected":
    hosts = ["host-0", "host-other"]
elif mode != "expected":
    raise SystemExit("unsupported route-host fixture mode")
rules = []
for index, host in enumerate(hosts):
    paths = [{"path": "/?(.*)", "backend": {"service": {"name": "gaming-client-srv"}}}]
    if index < count:
        paths.insert(0, {"path": "/api/telemetry/?(.*)", "backend": {"service": {"name": "gaming-telemetry-srv"}}})
    rules.append({"host": host, "http": {"paths": paths}})
json.dump({"spec": {"rules": rules}}, sys.stdout)
PY
        exit 0
        ;;
      deployment/*|pod|pods)
        if [[ "$2" == deployment/* ]]; then
          svc="$(svc_from_depl "${2#deployment/}")"
          printf '%s' "$(cat "$STATE_DIR/image-$svc")"; exit 0
        fi
        if [[ "$2" == pods && "$*" == *"-o json" ]]; then
          for service in bet resulting; do
            if [[ "$*" == *"app=gaming-${service}"* ]]; then
              flag="${FAKE_CASH_BACK_POD_FLAG:-$(cat "$STATE_DIR/cash-back-$service")}"
              python3 - "$service" "$flag" <<'PY'
import json, sys
service, flag = sys.argv[1:]
env = [{"name": "UNRELATED", "value": "retained"}]
if flag != "absent":
    env.append({"name": "CASH_BACK_ENABLED", "value": flag})
print(json.dumps({"items": [{"spec": {"containers": [{"name": "gaming-" + service, "env": env}]}}]}))
PY
              exit 0
            fi
          done
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
    if [[ "$2" == env ]]; then
      [[ "${FAKE_CASH_BACK_ENV_FAIL:-}" != "$svc" ]] || exit 1
      for arg in "$@"; do
        case "$arg" in
          CASH_BACK_ENABLED-) printf 'absent\n' >"$STATE_DIR/cash-back-$svc" ;;
          CASH_BACK_ENABLED=*) printf '%s\n' "${arg#*=}" >"$STATE_DIR/cash-back-$svc" ;;
        esac
      done
      exit 0
    fi
    for arg in "$@"; do
      [[ "$arg" == *=ghcr.io/* ]] && printf '%s\n' "${arg#*=}" >"$STATE_DIR/image-$svc"
    done
    exit 0
    ;;
  delete)
    case "$2" in
      deployment) rm -f "$STATE_DIR/image-telemetry" "$STATE_DIR/replicas-telemetry" "$STATE_DIR/ready-telemetry" ;;
      service) rm -f "$STATE_DIR/service-telemetry" ;;
    esac
    exit 0
    ;;
  patch)
    printf '0\n' >"$STATE_DIR/telemetry-routes"
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
printf 'maintenance %s\n' "$1" >>"$STATE_DIR/operations.log"
case "$1" in
  verify-held)
    [[ "$(cat "$STATE_DIR/maintenance")" == "held" ]] || { echo "not held" >&2; exit 1; }
    for service in backoffice bet event gamemaster moderation resulting slip; do
      [[ "$(cat "$STATE_DIR/replicas-$service")" == "0" ]] ||
        { echo "writer is not quiesced" >&2; exit 1; }
    done
    echo "live_data_maintenance=verify-held status=PASS" ;;
  hold)
    if [[ "${FAKE_REHOLD_FAILS:-0}" == "1" ]]; then echo "hold failed" >&2; exit 1; fi
    for service in backoffice bet event gamemaster moderation resulting slip; do
      printf '0\n' >"$STATE_DIR/replicas-$service"
    done
    printf 'held\n' >"$STATE_DIR/maintenance"; echo "held" ;;
  release)
    if [[ "${FAKE_FENCE_RELEASE_FAILS:-0}" == "1" ]]; then echo "release failed" >&2; exit 1; fi
    [[ "$(cat "$STATE_DIR/lock")" == "released" ]] ||
      { echo "fence release preceded lock release" >&2; exit 1; }
    printf 'released\n' >"$STATE_DIR/maintenance"; echo "released" ;;
esac
EOF

  cat >"$BIN_DIR/lock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${FAKE_STATE_DIR}"
[[ "$LOCK_TOKEN" == "live-data-${FAKE_EXPECTED_DATA_RUN}-1" ]] || { echo "wrong lock token" >&2; exit 1; }
[[ "$SOURCE_SHA" == "$FAKE_EXPECTED_SOURCE_SHA" ]] || { echo "wrong lock source sha" >&2; exit 1; }
printf '%s\n' "$1" >>"$STATE_DIR/lock.log"
printf 'lock %s\n' "$1" >>"$STATE_DIR/operations.log"
case "$1" in
  verify)
    [[ "$(cat "$STATE_DIR/lock")" == "held" ]] || {
      echo "shared_mongo_lock=verify status=FAIL reason=active database operation lock has expired" >&2
      exit 1
    } ;;
  acquire)
    if [[ "${FAKE_REACQUIRE_FAILS:-0}" == "1" &&
      "$(cat "$STATE_DIR/lock")" == "released" ]]; then
      echo "reacquire failed" >&2
      exit 1
    fi
    [[ "$(cat "$STATE_DIR/lock")" != "contended" ]] || {
      echo "another database operation holds the lock" >&2; exit 1
    }
    [[ -n "${LOCK_LEASE_SECONDS:-}" ]] || { echo "acquire requires a lease" >&2; exit 1; }
    printf 'held\n' >"$STATE_DIR/lock" ;;
  release)
    case "${FAKE_LOCK_RELEASE_MODE:-released}" in
      released) printf 'released\n' >"$STATE_DIR/lock" ;;
      ambiguous-held) exit 1 ;;
      ambiguous-absent) printf 'released\n' >"$STATE_DIR/lock"; exit 1 ;;
      ambiguous-expired) printf 'expired\n' >"$STATE_DIR/lock"; exit 1 ;;
      ambiguous-conflict) printf 'contended\n' >"$STATE_DIR/lock"; exit 1 ;;
      *) echo "invalid release mode" >&2; exit 1 ;;
    esac
    ;;
  verify-released)
    [[ "$(cat "$STATE_DIR/lock")" == "released" ]] || { echo "lock still held" >&2; exit 1; } ;;
esac
echo "shared_mongo_lock=$1 status=PASS"
EOF

  cat >"$BIN_DIR/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "show ${TARGET_SHA}:infra/k8s/bet-depl.yaml"|"show ${TARGET_SHA}:infra/k8s/resulting-depl.yaml")
    flag="${FAKE_CASH_BACK_TARGET_FLAG:-absent}"
    [[ "$flag" != missing ]] || exit 1
    service="${2##*/}"; service="${service%-depl.yaml}"
    printf 'kind: Deployment\nmetadata:\n  name: gaming-%s-depl\nspec:\n  template:\n    spec:\n      containers:\n        - name: gaming-%s\n          env:\n            - name: UNRELATED\n              value: retained\n' "$service" "$service"
    if [[ "$flag" == indirect ]]; then
      printf '            - name: CASH_BACK_ENABLED\n              valueFrom:\n                configMapKeyRef: {name: flags, key: cashback}\n'
    elif [[ "$flag" == duplicate ]]; then
      printf '            - name: CASH_BACK_ENABLED\n              value: "false"\n            - name: CASH_BACK_ENABLED\n              value: "false"\n'
    elif [[ "$flag" != absent ]]; then
      printf '            - name: CASH_BACK_ENABLED\n              value: "%s"\n' "$flag"
    fi
    ;;
  "show ${TARGET_SHA}:backoffice/src/event/listener/NewEventListener.ts")
    [[ "${FAKE_TARGET_HAS_CLEANUP_GUARD:-0}" == "1" ]] || exit 1
    cat <<'SOURCE'
import { isBeforePreSeptemberCleanupCutoff } from "../preSeptemberCleanupBoundary";
if (isBeforePreSeptemberCleanupCutoff(data.time)) {
  this.channel.ack(msg);
  return;
}
await Event.updateOne(
SOURCE
    ;;
  "show ${TARGET_SHA}:backoffice/src/event/preSeptemberCleanupBoundary.ts")
    [[ "${FAKE_TARGET_HAS_CLEANUP_GUARD:-0}" == "1" ]] || exit 1
    cat <<'SOURCE'
export const PRE_SEPTEMBER_CLEANUP_CUTOFF =
  "2026-09-01T00:00:00Z" as const;
export const PRE_SEPTEMBER_CLEANUP_CUTOFF_MS =
  Date.UTC(2026, 8, 1, 0, 0, 0, 0);
export const isBeforePreSeptemberCleanupCutoff = (
const parsed = parseExplicitZoneTimestamp(value);
return parsed !== null && parsed < PRE_SEPTEMBER_CLEANUP_CUTOFF_MS;
SOURCE
    ;;
  *)
    exit 1
    ;;
esac
EOF

  # Readiness fake: asserts the phase contract the operator must request.
  cat >"$BIN_DIR/readiness" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$OUTPUT_DIR"
phase="${ROLLBACK_READINESS_PHASE:-steady-state}"
printf 'readiness %s\n' "$phase" >>"$FAKE_STATE_DIR/operations.log"
status=GO
cleanup_state="$(
  node - \
    "$BACKOFFICE_CLEANUP_CLASSIFIER_SCRIPT" \
    "${FAKE_BACKOFFICE_CLEANUP_SCENARIO:-absent}" <<'NODE_CLASSIFIER'
"use strict";
const { createHash } = require("crypto");
const { classifyBackofficeCleanupJournal } = require(process.argv[2]);
const scenario = process.argv[3];
let rows = [];
if (scenario !== "absent") {
  const identities = [{
    eventId: "cleanup-event-a",
    time: "2026-08-31T23:59:59.999Z",
  }];
  const journal = {
    _id: "backoffice-events-before:2026-09-01T00:00:00Z",
    candidateCount: 1,
    createdAt: new Date("2026-09-01T00:05:00.000Z"),
    cutoff: "2026-09-01T00:00:00Z",
    digest: createHash("sha256")
      .update(JSON.stringify(identities))
      .digest("hex"),
    identities,
    operation: "delete-backoffice-events-before-cutoff",
    schemaVersion: "backoffice-pre-september-events-cleanup-v1",
    sourceSha: "a".repeat(40),
    state: "applied",
    appliedAt: new Date("2026-09-01T00:06:00.000Z"),
  };
  if (scenario === "malformed-extra-field") {
    journal.unreviewed = true;
  } else if (scenario !== "valid-applied") {
    throw new Error(`unknown fenced cleanup scenario: ${scenario}`);
  }
  rows = [journal];
}
process.stdout.write(`${classifyBackofficeCleanupJournal(rows)}\n`);
NODE_CLASSIFIER
)"
cleanup_guard="${FAKE_READINESS_TARGET_HAS_CLEANUP_GUARD:-${FAKE_TARGET_HAS_CLEANUP_GUARD:-0}}"
if [[ "$cleanup_guard" == "1" ]]; then
  cleanup_guard=true
else
  cleanup_guard=false
fi
case "$cleanup_state:$cleanup_guard" in
  absent:*)
    cleanup_check=not-started
    ;;
  applied:true)
    cleanup_check=compatible-target
    ;;
  applied:false)
    cleanup_check=incompatible-target
    status=NO_GO
    ;;
  prepared:*)
    cleanup_check=recovery-required
    status=NO_GO
    ;;
  *)
    cleanup_check=invalid-journal
    status=NO_GO
    ;;
esac
if [[ "$phase" == "maintenance-fenced" ]]; then
  [[ -n "${MAINTENANCE_LIVE_IMAGES_FILE:-}" && -f "$MAINTENANCE_LIVE_IMAGES_FILE" ]] ||
    { echo "fenced readiness requires live images" >&2; exit 1; }
  [[ "${MAINTENANCE_DEPLOYED_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
    { echo "fenced readiness requires deployed sha" >&2; exit 1; }
  if [[ "${FAKE_FENCED_READINESS:-GO}" != "GO" ]]; then
    status=NO_GO
  fi
else
  if [[ "${FAKE_STEADY_READINESS:-GO}" != "GO" ]]; then
    status=NO_GO
  fi
fi
cat >"$OUTPUT_DIR/summary.env" <<SUMMARY
rollback_readiness=$status
mode=application-rollback
phase=$phase
backoffice_cleanup_rollback_check=$cleanup_check
backoffice_cleanup_journal_state=$cleanup_state
target_supports_backoffice_cleanup_guard=$cleanup_guard
SUMMARY
[[ "$status" == "GO" ]] || exit 1
EOF
  chmod 755 "$BIN_DIR"/*

  cat >"$BIN_DIR/telemetry-verifier" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${FAKE_STATE_DIR}"
mkdir -p "$OUTPUT_DIR"
case "$MODE" in
  retained)
    [[ -f "$STATE_DIR/image-telemetry" ]]
    [[ "$(cat "$STATE_DIR/image-telemetry")" == "$EXPECTED_IMAGE" ]]
    [[ "$(cat "$STATE_DIR/ready-telemetry")" == "1" ]]
    [[ -f "$STATE_DIR/service-telemetry" ]]
    [[ "$(cat "$STATE_DIR/telemetry-routes")" == "2" ]]
    [[ "$EXPECTED_DATABASE_INITIALIZED" == "true" || "$EXPECTED_DATABASE_INITIALIZED" == "false" ]]
    ;;
  absent)
    [[ ! -f "$STATE_DIR/image-telemetry" ]]
    [[ ! -f "$STATE_DIR/service-telemetry" ]]
    [[ "$(cat "$STATE_DIR/telemetry-routes")" == "0" ]]
    ;;
  *) exit 1 ;;
esac
printf 'telemetry_recovery=PASS\nmode=%s\n' "$MODE" >"$OUTPUT_DIR/summary.env"
EOF
  chmod 755 "$BIN_DIR/telemetry-verifier"
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
  OCI_PUBLIC_URL=https://host-0 \
  OCI_DIAGNOSTIC_URL=https://host-1 \
  BACKOFFICE_CLEANUP_CLASSIFIER_SCRIPT="$CLEANUP_CLASSIFIER" \
  READINESS_SCRIPT="$BIN_DIR/readiness" \
  MAINTENANCE_SCRIPT="$BIN_DIR/maintenance" \
  LOCK_SCRIPT="$BIN_DIR/lock" \
  TELEMETRY_RECOVERY_SCRIPT="$BIN_DIR/telemetry-verifier" \
  MODERATION_OBSERVATION_ATTEMPTS=2 \
  MODERATION_OBSERVATION_SLEEP_SECONDS=0 \
  "$@" \
  "$OPERATOR"
}

if [[ -n "${CAPTURED_BASELINE_DIR:-}" ]]; then
  TARGET_SHA="$(awk -F= '$1 == "baseline_source_sha" {print $2}' "$CAPTURED_BASELINE_DIR/baseline-provenance.env")"
  new_case captured-baseline
  BASELINE_DIR="$CAPTURED_BASELINE_DIR"
  if [[ "${CAPTURED_BASELINE_EXPECT_REJECTION:-false}" == "true" ]]; then
    while IFS=$'\t' read -r service image _; do
      printf '%s\n' "$image" >"$STATE_DIR/image-$service"
    done <"$BASELINE_DIR/live-images.tsv"
    if run_operator >"$CASE_DIR/out.txt" 2>&1; then
      assert_contains "$CASE_DIR/out.txt" 'oci_fenced_rollback_recovery=PASS'
      [[ ! -f "$STATE_DIR/image-telemetry" ]] ||
        fail "accepted downgrade did not reach the expected Telemetry removal"
      printf 'captured_authority_removal=UNSAFE_ACCEPTANCE telemetry_removed=true\n' >&2
      fail "fenced consumer accepted a captured authority-removal downgrade"
    fi
    assert_contains "$CASE_DIR/out.txt" \
      'ordinary rollback baseline omits trusted deploy provenance'
    assert_contains "$CASE_DIR/out.txt" \
      'fenced recovery baseline validation failed'
    [[ ! -s "$STATE_DIR/operations.log" &&
       ! -s "$STATE_DIR/lock.log" &&
       ! -s "$STATE_DIR/kubectl.log" &&
       "$(cat "$STATE_DIR/maintenance")" == "held" &&
       "$(cat "$STATE_DIR/lock")" == "held" ]] ||
      fail "authority-removal rejection occurred after a runtime operation"
    printf 'captured_authority_removal=REJECTED_BEFORE_RUNTIME_OPERATIONS\n'
    exit 0
  fi
  run_operator >"$CASE_DIR/out.txt" 2>&1 ||
    fail "actual captured baseline was rejected: $(cat "$CASE_DIR/out.txt")"
  while IFS=$'\t' read -r service image _; do
    [[ "$(cat "$STATE_DIR/image-$service")" == "$image" ]] ||
      fail "actual captured baseline did not restore exact $service image"
    [[ "$(cat "$STATE_DIR/replicas-$service")" == "1" ]] ||
      fail "actual captured baseline did not restore $service replicas"
  done <"$BASELINE_DIR/live-images.tsv"
  [[ "$(cat "$STATE_DIR/telemetry-routes")" == "2" &&
     -f "$STATE_DIR/service-telemetry" ]] ||
    fail "actual captured baseline lost the retained Telemetry routes/service"
  python3 - "$STATE_DIR/operations.log" "$OUT_DIR/fenced-restore-order.tsv" <<'PY'
import sys
from pathlib import Path
events = Path(sys.argv[1]).read_text().splitlines()
order = ["auth", "bet", "event", "moderation", "resulting", "slip", "client", "gamemaster", "backoffice"]
assert [line.split("\t")[0] for line in Path(sys.argv[2]).read_text().splitlines()] == order
restores = [line.split()[3] for line in events if line.startswith("kubectl set image ")]
assert restores == [f"deployment/gaming-{service}-depl" for service in order + ["telemetry"]]
fenced = events.index("readiness maintenance-fenced")
first_restore = next(i for i, line in enumerate(events) if line.startswith("kubectl set image "))
telemetry_restore = next(i for i, line in enumerate(events) if line.startswith("kubectl set image deployment/gaming-telemetry-depl "))
assert fenced < first_restore < telemetry_restore < events.index("lock release") < events.index("maintenance release") < events.index("readiness steady-state")
PY
  assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'status=PASS'
  assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=released'
  assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'maintenance_fence=released'
  printf 'captured_baseline_fenced_recovery=PASS\n'
  exit 0
fi

new_case cash-back-compatible-baseline
printf 'true\n' >"$STATE_DIR/cash-back-bet"
printf 'true\n' >"$STATE_DIR/cash-back-resulting"
run_operator FAKE_CASH_BACK_TARGET_FLAG=false >"$CASE_DIR/out.txt" 2>&1 ||
  fail "aware-but-disabled cash-back baseline restoration failed"
[[ "$(cat "$STATE_DIR/cash-back-bet")" == false &&
   "$(cat "$STATE_DIR/cash-back-resulting")" == false ]] ||
  fail "cash-back generation stayed enabled after baseline restoration"
python3 - "$STATE_DIR/operations.log" <<'PY'
from pathlib import Path
import sys
rows = Path(sys.argv[1]).read_text().splitlines()
changes = [i for i, row in enumerate(rows) if row.startswith("kubectl set env ")]
first_scale = next(i for i, row in enumerate(rows) if row.startswith("kubectl scale "))
assert len(changes) == 2 and max(changes) < first_scale
assert all("CASH_BACK_ENABLED=false" in rows[i] for i in changes)
assert not any("UNRELATED=" in row for row in rows)
PY

new_case cash-back-legacy-absence
printf 'true\n' >"$STATE_DIR/cash-back-bet"
printf 'true\n' >"$STATE_DIR/cash-back-resulting"
run_operator >"$CASE_DIR/out.txt" 2>&1 || fail "legacy absent flag restoration failed"
[[ "$(cat "$STATE_DIR/cash-back-bet")" == absent &&
   "$(cat "$STATE_DIR/cash-back-resulting")" == absent ]] ||
  fail "legacy flag absence retained the active generation flag"

for flag in missing duplicate indirect invalid; do
  new_case "cash-back-invalid-source-$flag"
  if run_operator "FAKE_CASH_BACK_TARGET_FLAG=$flag" >"$CASE_DIR/out.txt" 2>&1; then
    fail "invalid source flag was accepted: $flag"
  fi
  if grep -Eq '^(set env|set image|scale) ' "$STATE_DIR/kubectl.log"; then
    fail "invalid source flag was rejected after mutation: $flag"
  fi
done

for failure in env-write stale-pod; do
  new_case "cash-back-$failure"
  if [[ "$failure" == env-write ]]; then
    failure_env=FAKE_CASH_BACK_ENV_FAIL=resulting
  else
    failure_env=FAKE_CASH_BACK_POD_FLAG=true
  fi
  if run_operator FAKE_CASH_BACK_TARGET_FLAG=false "$failure_env" >"$CASE_DIR/out.txt" 2>&1; then
    fail "cash-back configuration failure was accepted: $failure"
  fi
  [[ "$(cat "$STATE_DIR/maintenance")" == held &&
     "$(cat "$STATE_DIR/lock")" == held &&
     "$(cat "$STATE_DIR/replicas-bet")" == 0 &&
     "$(cat "$STATE_DIR/replicas-resulting")" == 0 ]] ||
    fail "cash-back configuration failure did not retain maintenance"
done

# Applied cleanup plus an incompatible target must be rejected before the
# recovery can restart Backoffice and consume a delayed pre-cutoff delivery.
new_case cleanup-applied-incompatible
printf 'queued\n' >"$STATE_DIR/pre-cutoff-redelivery"
if run_operator \
    FAKE_BACKOFFICE_CLEANUP_SCENARIO=valid-applied \
    FAKE_TARGET_HAS_CLEANUP_GUARD=0 \
    FAKE_READINESS_TARGET_HAS_CLEANUP_GUARD=1 \
    >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery trusted readiness evidence for an incompatible listener'
fi
assert_contains "$CASE_DIR/out.txt" \
  'readiness cleanup guard capability does not match the exact rollback target'
[[ "$(cat "$STATE_DIR/replicas-backoffice")" == "0" ]] ||
  fail 'rejected fenced recovery restarted Backoffice'
[[ "$(cat "$STATE_DIR/maintenance")" == "held" ]] ||
  fail 'rejected fenced recovery released the maintenance fence'
[[ "$(cat "$STATE_DIR/lock")" == "held" ]] ||
  fail 'rejected fenced recovery released the database lock'
[[ -f "$STATE_DIR/pre-cutoff-redelivery" ]] ||
  fail 'rejected fenced recovery processed queued pre-cutoff redelivery'
if grep -Eq '^(set image|scale) ' "$STATE_DIR/kubectl.log"; then
  fail 'rejected fenced recovery mutated an image or replica count'
fi

# The exact raw-document classifier must make malformed cleanup evidence a
# maintenance-fenced NO_GO before any workload mutation or boundary release.
new_case cleanup-malformed
if run_operator \
    FAKE_BACKOFFICE_CLEANUP_SCENARIO=malformed-extra-field \
    FAKE_TARGET_HAS_CLEANUP_GUARD=1 \
    >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted a malformed raw cleanup journal'
fi
assert_contains "$CASE_DIR/out.txt" \
  'maintenance-fenced readiness rejected the fenced rollback recovery'
[[ "$(cat "$STATE_DIR/replicas-backoffice")" == "0" ]] ||
  fail 'malformed cleanup evidence restarted Backoffice'
[[ "$(cat "$STATE_DIR/maintenance")" == "held" ]] ||
  fail 'malformed cleanup evidence released the maintenance fence'
[[ "$(cat "$STATE_DIR/lock")" == "held" ]] ||
  fail 'malformed cleanup evidence released the database lock'
if grep -Eq '^(set image|scale) ' "$STATE_DIR/kubectl.log"; then
  fail 'malformed cleanup evidence reached fenced workload mutation'
fi

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
[[ "$(cat "$STATE_DIR/image-telemetry")" == "$(image_for target telemetry)" ]] ||
  fail "accepted fenced recovery did not restore exact pre-run Telemetry digest"
# Raw lock/fence command output stays outside uploaded evidence.
[[ ! -e "$OUT_DIR/fenced-lock-release.txt" ]] ||
  fail 'raw lock release output leaked into fenced recovery evidence'
[[ ! -e "$OUT_DIR/fenced-fence-release.txt" ]] ||
  fail 'raw fence release output leaked into fenced recovery evidence'
# Restore order must lead with Auth and restore Backoffice last.
[[ "$(head -1 "$OUT_DIR/fenced-restore-order.tsv" | cut -f1)" == "auth" ]] ||
  fail 'fenced restore order did not start with auth'
[[ "$(tail -1 "$OUT_DIR/fenced-restore-order.tsv" | cut -f1)" == "backoffice" ]] ||
  fail 'fenced restore order did not restore Backoffice last'

for route_host_mode in same-host unexpected; do
  new_case "invalid-route-hosts-$route_host_mode"
  if run_operator FAKE_TELEMETRY_ROUTE_HOST_MODE="$route_host_mode" \
      >"$CASE_DIR/out.txt" 2>&1; then
    fail "fenced recovery accepted $route_host_mode Telemetry routes"
  fi
  assert_contains "$CASE_DIR/out.txt" \
    'live legacy workloads are not an authorized rollout prefix'
  grep -Fq 'set image' "$STATE_DIR/kubectl.log" &&
    fail "fenced recovery mutated a workload for $route_host_mode Telemetry routes"
done

# Every recovery checkpoint is replayable: a second invocation may observe an
# exact baseline prefix and candidate suffix in the reviewed restore order.
RECOVERY_ORDER=(auth bet event moderation resulting slip client gamemaster backoffice)
for checkpoint in "${!RECOVERY_ORDER[@]}"; do
  new_case "recovery-checkpoint-$checkpoint"
  for ((index = 0; index <= checkpoint; index++)); do
    service="${RECOVERY_ORDER[$index]}"
    printf '%s\n' "$(image_for target "$service")" >"$STATE_DIR/image-$service"
  done
  run_operator >"$CASE_DIR/out.txt" 2>&1 ||
    fail "fenced recovery checkpoint $checkpoint was not resumable: $(cat "$CASE_DIR/out.txt")"
done

configure_first_activation() {
  local stage="$1" service
  local file
  for file in images.tsv live-images.tsv deployments.tsv pod-images.tsv; do
    awk -F '\t' '$1 != "telemetry"' "$BASELINE_DIR/$file" >"$BASELINE_DIR/$file.tmp"
    mv "$BASELINE_DIR/$file.tmp" "$BASELINE_DIR/$file"
  done
  cat >"$BASELINE_DIR/telemetry-pre-run.env" <<EOF
mode=absent
image=none
database_initialized=false
queue_present=false
EOF
  for service in "${SERVICES[@]}"; do
    printf '%s\n' "$(image_for target "$service")" >"$STATE_DIR/image-$service"
  done
  rm -f "$STATE_DIR/image-telemetry" "$STATE_DIR/replicas-telemetry" \
    "$STATE_DIR/ready-telemetry" "$STATE_DIR/service-telemetry"
  printf '0\n' >"$STATE_DIR/telemetry-routes"
  case "$stage" in
    absent) ;;
    service)
      : >"$STATE_DIR/service-telemetry"
      ;;
    deployment-unready)
      : >"$STATE_DIR/service-telemetry"
      printf '%s\n' "$(image_for deployed telemetry)" >"$STATE_DIR/image-telemetry"
      printf '1\n' >"$STATE_DIR/replicas-telemetry"
      printf '0\n' >"$STATE_DIR/ready-telemetry"
      printf '2\n' >"$STATE_DIR/telemetry-routes"
      ;;
    route-one|no-routes|deployment-only|ready|routes-without-service)
      printf '%s\n' "$(image_for deployed telemetry)" >"$STATE_DIR/image-telemetry"
      printf '1\n' >"$STATE_DIR/replicas-telemetry"
      printf '1\n' >"$STATE_DIR/ready-telemetry"
      if [[ "$stage" != "deployment-only" && "$stage" != "routes-without-service" ]]; then
        : >"$STATE_DIR/service-telemetry"
      fi
      if [[ "$stage" == "route-one" ]]; then
        printf '1\n' >"$STATE_DIR/telemetry-routes"
      elif [[ "$stage" == "ready" || "$stage" == "routes-without-service" ]]; then
        printf '2\n' >"$STATE_DIR/telemetry-routes"
      else
        printf '0\n' >"$STATE_DIR/telemetry-routes"
      fi
      ;;
    route-only)
      printf '2\n' >"$STATE_DIR/telemetry-routes"
      ;;
    *) fail "unknown first-activation fixture stage: $stage" ;;
  esac
  write_baseline_deploy_provenance
  refresh_baseline_manifest
}

FORWARD_WRITERS=(bet event moderation resulting slip backoffice gamemaster)
configure_cleanup_overlay() {
  local split="$1" index service
  configure_first_activation no-routes
  for service in auth client; do
    printf '%s\n' "$(image_for deployed "$service")" >"$STATE_DIR/image-$service"
  done
  for ((index = 0; index < split; index++)); do
    service="${FORWARD_WRITERS[$index]}"
    printf '%s\n' "$(image_for deployed "$service")" >"$STATE_DIR/image-$service"
  done
}

# The first split reproduces a failed Telemetry ingress apply followed by the
# deployment's candidate-reader cleanup. Later splits cover forward progress.
for ((split = 0; split <= ${#FORWARD_WRITERS[@]}; split++)); do
  new_case "deployment-cleanup-$split"
  configure_cleanup_overlay "$split"
  run_operator >"$CASE_DIR/out.txt" 2>&1 ||
    fail "deployment cleanup split $split was rejected: $(cat "$CASE_DIR/out.txt")"
  assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'status=PASS'
  [[ "$(cat "$STATE_DIR/maintenance")" == "released" &&
     "$(cat "$STATE_DIR/lock")" == "released" ]] ||
    fail "deployment cleanup split $split retained maintenance or lock"
  for service in "${SERVICES[@]}"; do
    [[ "$(cat "$STATE_DIR/image-$service")" == "$(image_for target "$service")" &&
       "$(cat "$STATE_DIR/replicas-$service")" == "1" ]] ||
      fail "deployment cleanup split $split did not restore $service"
  done
  [[ ! -f "$STATE_DIR/image-telemetry" && ! -f "$STATE_DIR/service-telemetry" &&
     "$(cat "$STATE_DIR/telemetry-routes")" == "0" ]] ||
    fail "deployment cleanup split $split retained new Telemetry resources"
done

for invalid in writer-gap writer-suffix reader-baseline foreign-image active-writer missing-fence contended-lock; do
  new_case "deployment-cleanup-invalid-$invalid"
  configure_cleanup_overlay 0
  case "$invalid" in
    writer-gap) printf '%s\n' "$(image_for deployed event)" >"$STATE_DIR/image-event" ;;
    writer-suffix)
      for service in event moderation resulting slip backoffice gamemaster; do
        printf '%s\n' "$(image_for deployed "$service")" >"$STATE_DIR/image-$service"
      done ;;
    reader-baseline) printf '%s\n' "$(image_for target auth)" >"$STATE_DIR/image-auth" ;;
    foreign-image) printf '%s\n' "$(image_for other event)" >"$STATE_DIR/image-event" ;;
    active-writer) printf '1\n' >"$STATE_DIR/replicas-event" ;;
    missing-fence) printf 'released\n' >"$STATE_DIR/maintenance" ;;
    contended-lock) printf 'contended\n' >"$STATE_DIR/lock" ;;
  esac
  if run_operator >"$CASE_DIR/out.txt" 2>&1; then
    fail "deployment cleanup accepted $invalid"
  fi
  if grep -Eq '^(set |scale |patch |delete )' "$STATE_DIR/kubectl.log"; then
    fail "deployment cleanup mutated workloads before rejecting $invalid"
  fi
  if [[ "$invalid" != "contended-lock" && -s "$STATE_DIR/lock.log" ]]; then
    fail "deployment cleanup touched the lock before rejecting $invalid"
  fi
done

for stage in absent deployment-unready no-routes deployment-only ready; do
  new_case "first-activation-$stage"
  configure_first_activation "$stage"
  run_operator >"$CASE_DIR/out.txt" 2>&1 ||
    fail "first-activation $stage recovery was rejected: $(cat "$CASE_DIR/out.txt")"
  assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'telemetry_state=absent'
  [[ ! -f "$STATE_DIR/image-telemetry" ]] ||
    fail "first-activation $stage retained a new Telemetry deployment"
  [[ ! -f "$STATE_DIR/service-telemetry" ]] ||
    fail "first-activation $stage retained a new Telemetry service"
  [[ "$(cat "$STATE_DIR/telemetry-routes")" == "0" ]] ||
    fail "first-activation $stage retained a new Telemetry ingress path"
done

for stage in service route-one route-only routes-without-service; do
  new_case "first-activation-impossible-$stage"
  configure_first_activation "$stage"
  if run_operator >"$CASE_DIR/out.txt" 2>&1; then
    fail "first-activation impossible state $stage was accepted"
  fi
  assert_contains "$CASE_DIR/out.txt" \
    'live legacy workloads are not an authorized rollout prefix'
  grep -Fq 'set image' "$STATE_DIR/kubectl.log" &&
    fail "first-activation impossible state $stage mutated a workload"
done

new_case first-activation-unchanged-legacy
configure_first_activation absent
for service in "${SERVICES[@]}"; do
  awk -F '\t' -v OFS='\t' -v selected="$service" \
    -v image="$(image_for target "$service")" \
    -v digest="sha256:$(digest_for target "$service")" \
    '$1 == selected {$3 = image; $4 = digest; $5 = digest} {print}' \
    "$BUILD_DIR/images.tsv" >"$BUILD_DIR/images.tsv.next"
  mv "$BUILD_DIR/images.tsv.next" "$BUILD_DIR/images.tsv"
done
run_operator >"$CASE_DIR/out.txt" 2>&1 ||
  fail "first activation with unchanged legacy images was rejected: $(cat "$CASE_DIR/out.txt")"
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'telemetry_state=absent'

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
  refresh_baseline_manifest
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

new_case missing-telemetry-evidence
rm "$BASELINE_DIR/telemetry-pre-run.env"
if run_operator >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted missing Telemetry pre-run evidence'
fi

new_case duplicate-telemetry-evidence
printf 'mode=retained\n' >>"$BASELINE_DIR/telemetry-pre-run.env"
refresh_baseline_manifest
if run_operator >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted repeated Telemetry pre-run evidence'
fi

real_python3="$(command -v python3)"
for scenario in checksum-retained provenance-retained checksum-absent provenance-absent parser-failure; do
  new_case "restore-profile-$scenario"
  if [[ "$scenario" == *-absent ]]; then
    configure_first_activation absent
  fi
  case "$scenario" in
    provenance-*)
      sed -i.bak '/^deployment_workflow=/d' "$BASELINE_DIR/trusted-deploy-provenance.txt"
      refresh_baseline_manifest
      ;;
  esac
  cat >"$BIN_DIR/python3" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# Reach canonical validation after the operator's earlier envelope checksum check.
if [[ "${FAKE_CANONICAL_CHECKSUM_TAMPER:-false}" == "true" &&
      "$#" == "7" && "$1" == "-" && "$2" == "${BASELINE_DIR:?}" ]]; then
  printf 'unbound-change\n' >>"$BASELINE_DIR/queues.tsv"
  printf 'tampered\n' >>"${FAKE_STATE_DIR:?}/canonical-tamper.log"
fi
if [[ "$#" == "2" && "$1" == "-" && "$2" == "${BASELINE_DIR:?}" ]]; then
  printf 'profile\n' >>"${FAKE_STATE_DIR:?}/profile-parse.log"
  if [[ "${FAKE_PROFILE_PARSE_FAILURE:-false}" == "true" ]]; then
    echo "injected restore profile parser failure" >&2
    exit 37
  fi
fi
exec "${REAL_PYTHON3:?}" "$@"
SH
  chmod +x "$BIN_DIR/python3"
  if run_operator REAL_PYTHON3="$real_python3" \
      FAKE_CANONICAL_CHECKSUM_TAMPER="$([[ "$scenario" == checksum-* ]] && printf true || printf false)" \
      FAKE_PROFILE_PARSE_FAILURE="$([[ "$scenario" == "parser-failure" ]] && printf true || printf false)" \
      >"$CASE_DIR/out.txt" 2>&1; then
    fail "fenced recovery OR-wrapper accepted $scenario"
  fi
  if ! grep -Fq 'fenced recovery baseline validation failed' "$CASE_DIR/out.txt"; then
    cat "$CASE_DIR/out.txt" >&2
    fail "fenced recovery did not reach canonical $scenario rejection"
  fi
  if [[ "$scenario" == "parser-failure" ]]; then
    assert_contains "$CASE_DIR/out.txt" 'injected restore profile parser failure'
    [[ "$(cat "$STATE_DIR/profile-parse.log")" == "profile" ]] ||
      fail 'fenced recovery did not propagate its profile parser failure'
  else
    [[ ! -e "$STATE_DIR/profile-parse.log" ]] ||
      fail "fenced recovery parsed a profile after canonical $scenario failure"
    if [[ "$scenario" == checksum-* ]]; then
      assert_contains "$CASE_DIR/out.txt" 'rollback baseline checksum mismatch: queues.tsv'
      [[ "$(cat "$STATE_DIR/canonical-tamper.log")" == "tampered" ]] ||
        fail 'checksum failure did not exercise the canonical validator in its OR-wrapper'
    else
      assert_contains "$CASE_DIR/out.txt" \
        'ordinary rollback baseline omits current deploy-workflow provenance'
    fi
  fi
  [[ ! -s "$STATE_DIR/operations.log" &&
     ! -s "$STATE_DIR/lock.log" &&
     ! -s "$STATE_DIR/kubectl.log" &&
     ! -e "$OUT_DIR/fenced-restore-plan.tsv" &&
     "$(cat "$STATE_DIR/maintenance")" == "held" &&
     "$(cat "$STATE_DIR/lock")" == "held" ]] ||
    fail "fenced recovery changed state after $scenario"
done

for replicas in 2 01; do
  new_case "unsupported-retained-replicas-$replicas"
  python3 - "$BASELINE_DIR" "$replicas" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
replicas = sys.argv[2]
path = root / "deployments.tsv"
rows = [line.split("\t") for line in path.read_text().splitlines()]
for row in rows:
    if row[0] == "telemetry":
        row[3:6] = [replicas] * 3
path.write_text("".join("\t".join(row) + "\n" for row in rows))
if replicas == "2":
    path = root / "pod-images.tsv"
    rows = [line.split("\t") for line in path.read_text().splitlines()]
    second = next(row.copy() for row in rows if row[0] == "telemetry")
    second[1] += "-second"
    rows.append(second)
    path.write_text("".join("\t".join(row) + "\n" for row in rows))
PY
  refresh_baseline_manifest
  BASELINE_DIR="$BASELINE_DIR" EXPECTED_SOURCE_SHA="$TARGET_SHA" \
  EXPECTED_NAMESPACE=betstan-oci REQUIRE_CURRENT_DEPLOY_PROVENANCE=true \
    "$ROOT_DIR/infra/oci/scripts/validate-rollback-baseline-stan.sh" >/dev/null
  if run_operator >"$CASE_DIR/out.txt" 2>&1; then
    fail "fenced recovery accepted retained Telemetry replicas $replicas"
  fi
  assert_contains "$CASE_DIR/out.txt" \
    "retained Telemetry desired replicas $replicas cannot use the existing single-replica restore path"
  [[ ! -s "$STATE_DIR/operations.log" &&
     ! -s "$STATE_DIR/lock.log" &&
     ! -s "$STATE_DIR/kubectl.log" &&
     ! -e "$OUT_DIR/fenced-restore-plan.tsv" &&
     "$(cat "$STATE_DIR/maintenance")" == "held" &&
     "$(cat "$STATE_DIR/lock")" == "held" ]] ||
    fail 'unsupported retained Telemetry reached runtime recovery'
done
printf 'fenced_restore_profile_failure_propagation=PASS\n'

for mutation in \
    duplicate-baseline duplicate-deployment duplicate-current unknown-current \
    missing-current-telemetry substituted-current four-column-current \
    current-digest-mismatch current-repository-mismatch \
    missing-baseline-telemetry altered-baseline-telemetry \
    missing-baseline-deployment; do
  new_case "invalid-inventory-$mutation"
  python3 - "$BASELINE_DIR" "$BUILD_DIR" "$mutation" <<'PY'
import sys
from pathlib import Path
baseline, build = map(Path, sys.argv[1:3])
mutation = sys.argv[3]
path = build / "images.tsv"
if mutation in {"duplicate-baseline", "missing-baseline-telemetry", "altered-baseline-telemetry"}:
    path = baseline / "images.tsv"
elif mutation in {"duplicate-deployment", "missing-baseline-deployment"}:
    path = baseline / "deployments.tsv"
rows = [line.split("\t") for line in path.read_text().splitlines()]
if mutation.startswith("duplicate"):
    rows.append(rows[0].copy())
elif mutation == "unknown-current":
    row = rows[0].copy()
    row[0] = "unknown"
    rows.append(row)
elif mutation.startswith("missing") or mutation == "substituted-current":
    service = "auth" if mutation == "substituted-current" else "telemetry"
    rows = [row for row in rows if row[0] != service]
elif mutation == "four-column-current":
    rows = [row[:4] for row in rows]
elif mutation in {"current-digest-mismatch", "altered-baseline-telemetry"}:
    rows[-1][3] = "sha256:" + "f" * 64
elif mutation == "current-repository-mismatch":
    rows[-1][1] = "ghcr.io/other/images"
else:
    raise SystemExit("unknown fenced inventory fixture")
path.write_text("".join("\t".join(row) + "\n" for row in rows))
PY
  refresh_baseline_manifest
  if run_operator >"$CASE_DIR/out.txt" 2>&1; then
    fail "fenced recovery accepted $mutation"
  fi
  if grep -Eq '^(set image|scale|delete|patch|apply) ' "$STATE_DIR/kubectl.log"; then
    fail "fenced recovery mutated workloads for $mutation"
  fi
  [[ ! -s "$STATE_DIR/lock.log" &&
     "$(cat "$STATE_DIR/maintenance")" == "held" ]] ||
    fail "fenced recovery changed safeguards for $mutation"
done

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
# By this point the released lock must be reacquired with the original identity.
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=reacquired'
[[ "$(cat "$STATE_DIR/maintenance")" == "held" ]] ||
  fail 'failed fenced recovery did not re-hold maintenance'
[[ "$(cat "$STATE_DIR/lock")" == "held" ]] ||
  fail 'failed fenced recovery did not reacquire the original database lock'

new_case ambiguous-release-lock-retained
if run_operator FAKE_LOCK_RELEASE_MODE=ambiguous-held >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted an ambiguous lock release'
fi
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=retained'
[[ "$(grep -c '^acquire$' "$STATE_DIR/lock.log")" == "0" ]] ||
  fail 'ambiguous release reacquired a lock whose exact identity remained active'

for release_state in ambiguous-absent ambiguous-expired; do
  new_case "ambiguous-release-${release_state#ambiguous-}"
  if run_operator FAKE_LOCK_RELEASE_MODE="$release_state" >"$CASE_DIR/out.txt" 2>&1; then
    fail "fenced recovery accepted $release_state"
  fi
  assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=reacquired'
  [[ "$(grep -c '^acquire$' "$STATE_DIR/lock.log")" == "1" ]] ||
    fail "$release_state did not reacquire the original lock exactly once"
done

new_case ambiguous-release-conflicting-owner
if run_operator FAKE_LOCK_RELEASE_MODE=ambiguous-conflict >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted an ambiguous release with a conflicting owner'
fi
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=reacquire-failed'
[[ "$(cat "$STATE_DIR/lock")" == "contended" ]] ||
  fail 'conflicting lock owner was overwritten'

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
# The summary must report successful re-hold and reacquisition.
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=reacquired'

new_case rehold-failure
if run_operator FAKE_STEADY_READINESS=NO_GO FAKE_REHOLD_FAILS=1 \
    >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted a failed maintenance re-hold'
fi
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'maintenance_fence=rehold-failed'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=reacquire-failed'

new_case reacquire-failure
if run_operator FAKE_STEADY_READINESS=NO_GO FAKE_REACQUIRE_FAILS=1 \
    >"$CASE_DIR/out.txt" 2>&1; then
  fail 'fenced recovery accepted a failed original-lock reacquisition'
fi
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'maintenance_fence=re-held'
assert_contains "$OUT_DIR/fenced-recovery-summary.env" 'database_lock=reacquire-failed'

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
assert_contains "$OPERATOR" 'oci_require_retained_telemetry_restore_profile "$BASELINE_DIR" >/dev/null ||'
assert_contains "$OPERATOR" 'if telemetry["mode"] != "retained" or deployments[service][1] != "1":'
assert_contains "$OPERATOR" 'raise SystemExit("baseline Telemetry cannot use the existing single-replica restore path")'
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
