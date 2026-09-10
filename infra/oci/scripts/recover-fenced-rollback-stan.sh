#!/usr/bin/env bash
set -euo pipefail

# Purpose: restore the exact known-good application generation while the live
#          data maintenance handoff is still held open by an incomplete
#          deployment.
#
# This operator exists because the ordinary rollback path deliberately requires
# a healthy steady state. After an incomplete deployment re-enters maintenance,
# production is intentionally fenced: the six live-data writer Deployments are
# quiesced to zero, mutating HTTP is answered with 503, and the transferred
# database lock is still held. That is a correct safety posture, but it also
# means an ordinary rollback can never pass its pre-mutation gate, so the last
# known-good generation is unreachable exactly when it is needed most.
#
# This is NOT a skip, force, or bypass. It asserts a different, positively
# specified expected state, and it is usable only when bound to the exact failed
# deployment run, its immutable baseline artifact, the exact deployed
# generation, the exact rollback target, and evidence that the deployment
# successfully re-entered maintenance. Any deviation fails closed and re-holds
# maintenance without releasing the database lock.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

TARGET_SHA="${TARGET_SHA:-}"
DEPLOYED_SOURCE_SHA="${DEPLOYED_SOURCE_SHA:-}"
FENCED_DEPLOY_RUN_ID="${FENCED_DEPLOY_RUN_ID:-}"
FENCED_DATA_RUN_ID="${FENCED_DATA_RUN_ID:-}"
BASELINE_DIR="${BASELINE_DIR:-}"
PRE_RECOVERY_BUILD_DIR="${PRE_RECOVERY_BUILD_DIR:-}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-rollback}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_PUBLIC_URL="${OCI_PUBLIC_URL:-https://betstan.xyz}"
OCI_REDIRECT_URL="${OCI_REDIRECT_URL:-https://www.betstan.xyz}"
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
OCI_INFRASTRUCTURE_PROVENANCE_FILE="${OCI_INFRASTRUCTURE_PROVENANCE_FILE:-}"
OCI_INFRASTRUCTURE_PROVENANCE_SHA256="${OCI_INFRASTRUCTURE_PROVENANCE_SHA256:-}"
INFRASTRUCTURE_RUN_ID="${INFRASTRUCTURE_RUN_ID:-}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-10m}"
MODERATION_OBSERVATION_ATTEMPTS="${MODERATION_OBSERVATION_ATTEMPTS:-10}"
MODERATION_OBSERVATION_SLEEP_SECONDS="${MODERATION_OBSERVATION_SLEEP_SECONDS:-6}"
FENCED_LOCK_LEASE_SECONDS="${FENCED_LOCK_LEASE_SECONDS:-5400}"
READINESS_SCRIPT="${READINESS_SCRIPT:-$SCRIPT_DIR/rollback-readiness-stan.sh}"
MAINTENANCE_SCRIPT="${MAINTENANCE_SCRIPT:-$SCRIPT_DIR/live-data-maintenance-stan.sh}"
LOCK_SCRIPT="${LOCK_SCRIPT:-$SCRIPT_DIR/shared-mongo-operation-lock-stan.sh}"
TELEMETRY_RECOVERY_SCRIPT="${TELEMETRY_RECOVERY_SCRIPT:-$SCRIPT_DIR/verify-telemetry-recovery-state-stan.sh}"

# Restore order mirrors the reviewed OCI deployment order: API dependencies
# first, Client after them, Gamemaster last.
RESTORE_ORDER=(auth bet backoffice event moderation resulting slip client gamemaster)
QUIESCED_SERVICES=(bet event gamemaster moderation resulting slip)

MAINTENANCE_REHELD=false
MAINTENANCE_REHOLD_STATUS=not-required
FENCED_LOCK_ACQUISITION=unknown
# Tracks whether the transferred database lock has actually been released, so a
# later failure summary reports the true state instead of assuming it is held.
DATABASE_LOCK_STATE=retained
FENCED_MUTATION_STARTED=false

write_text_atomic() {
  local target="$1"
  local temporary="${target}.tmp.$$.$RANDOM"
  cat >"$temporary"
  mv "$temporary" "$target"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Any failure after this point must leave production fenced and the database
# lock held, so a later attempt still sees an intact maintenance handoff.
rehold_maintenance() {
  local reason="$1"
  if [[ "$MAINTENANCE_REHELD" == "true" ]]; then
    [[ "$MAINTENANCE_REHOLD_STATUS" == "re-held" ]]
    return
  fi
  MAINTENANCE_REHELD=true
  if "$MAINTENANCE_SCRIPT" hold >"$WORK_DIR/fenced-rehold.txt" 2>&1 &&
      "$MAINTENANCE_SCRIPT" verify-held \
        >>"$WORK_DIR/fenced-rehold.txt" 2>&1; then
    MAINTENANCE_REHOLD_STATUS=re-held
    return 0
  fi
  MAINTENANCE_REHOLD_STATUS=rehold-failed
  return 1
}

reacquire_original_lock() {
  if [[ "$DATABASE_LOCK_STATE" != "released" &&
    "$DATABASE_LOCK_STATE" != "release-ambiguous" ]]; then
    return 0
  fi
  if [[ "$MAINTENANCE_REHOLD_STATUS" != "re-held" ]]; then
    DATABASE_LOCK_STATE=reacquire-failed
    return 1
  fi
  if [[ "$DATABASE_LOCK_STATE" == "release-ambiguous" ]]; then
    if NAMESPACE="$OCI_K8S_NAMESPACE" \
        LOCK_TOKEN="live-data-${FENCED_DATA_RUN_ID}-1" \
        OPERATION_ID="live-data-apply-slip-index" \
        SOURCE_SHA="$DEPLOYED_SOURCE_SHA" \
        "$LOCK_SCRIPT" verify >"$WORK_DIR/fenced-lock-reacquire.txt" 2>&1; then
      DATABASE_LOCK_STATE=retained
      return 0
    fi
  fi
  if NAMESPACE="$OCI_K8S_NAMESPACE" \
      LOCK_TOKEN="live-data-${FENCED_DATA_RUN_ID}-1" \
      OPERATION_ID="live-data-apply-slip-index" \
      LOCK_LEASE_SECONDS="$FENCED_LOCK_LEASE_SECONDS" \
      SOURCE_SHA="$DEPLOYED_SOURCE_SHA" \
      "$LOCK_SCRIPT" acquire >"$WORK_DIR/fenced-lock-reacquire.txt" 2>&1 &&
    NAMESPACE="$OCI_K8S_NAMESPACE" \
      LOCK_TOKEN="live-data-${FENCED_DATA_RUN_ID}-1" \
      OPERATION_ID="live-data-apply-slip-index" \
      SOURCE_SHA="$DEPLOYED_SOURCE_SHA" \
      "$LOCK_SCRIPT" verify >>"$WORK_DIR/fenced-lock-reacquire.txt" 2>&1; then
    DATABASE_LOCK_STATE=reacquired
    return 0
  fi
  DATABASE_LOCK_STATE=reacquire-failed
  return 1
}

fenced_die() {
  local reason="$1"
  rehold_maintenance "$reason" || true
  reacquire_original_lock || true
  write_text_atomic "$OUTPUT_DIR/fenced-recovery-summary.env" <<EOF
status=FAIL
mode=fenced-rollback-recovery
target_sha=$TARGET_SHA
deployed_source_sha=$DEPLOYED_SOURCE_SHA
fenced_deploy_run_id=$FENCED_DEPLOY_RUN_ID
fenced_data_run_id=$FENCED_DATA_RUN_ID
maintenance_fence=$MAINTENANCE_REHOLD_STATUS
database_lock=$DATABASE_LOCK_STATE
database_lock_acquisition=$FENCED_LOCK_ACQUISITION
database_restore=disabled
message=$reason
EOF
  oci_die "$reason"
}

require_regular_file() {
  [[ -f "$1" && ! -L "$1" ]] || oci_die "required evidence file is invalid: $1"
}

for command_name in kubectl curl python3 awk; do
  oci_require_command "$command_name"
done

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "TARGET_SHA must be a full lowercase commit SHA"
[[ "$DEPLOYED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "DEPLOYED_SOURCE_SHA must be a full lowercase commit SHA"
[[ "$TARGET_SHA" != "$DEPLOYED_SOURCE_SHA" ]] ||
  oci_die "fenced rollback recovery cannot target the deployed generation"
[[ "$FENCED_DEPLOY_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "FENCED_DEPLOY_RUN_ID must be a positive integer"
[[ "$FENCED_DATA_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "FENCED_DATA_RUN_ID must be a positive integer"
[[ -n "$BASELINE_DIR" && -d "$BASELINE_DIR" && ! -L "$BASELINE_DIR" ]] ||
  oci_die "BASELINE_DIR must be a regular directory"
[[ -n "$PRE_RECOVERY_BUILD_DIR" && -d "$PRE_RECOVERY_BUILD_DIR" &&
  ! -L "$PRE_RECOVERY_BUILD_DIR" ]] ||
  oci_die "PRE_RECOVERY_BUILD_DIR must be a regular directory"
[[ -x "$READINESS_SCRIPT" ]] || oci_die "rollback readiness script is not executable"
[[ -x "$MAINTENANCE_SCRIPT" ]] || oci_die "maintenance script is not executable"
[[ -x "$LOCK_SCRIPT" ]] || oci_die "shared Mongo lock script is not executable"
[[ -x "$TELEMETRY_RECOVERY_SCRIPT" ]] ||
  oci_die "Telemetry recovery verification script is not executable"

oci_prepare_safe_private_dir "$OUTPUT_DIR"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/betstan-fenced-recovery.XXXXXX")"
chmod 700 "$WORK_DIR"
cleanup_private_work() {
  local exit_status=$?
  local output_policy_status=0
  if [[ "$exit_status" != "0" && "$FENCED_MUTATION_STARTED" == "true" &&
    ! -f "$OUTPUT_DIR/fenced-recovery-summary.env" ]]; then
    rehold_maintenance "unexpected recovery failure" || true
    reacquire_original_lock || true
    write_text_atomic "$OUTPUT_DIR/fenced-recovery-summary.env" <<EOF
status=FAIL
mode=fenced-rollback-recovery
target_sha=$TARGET_SHA
deployed_source_sha=$DEPLOYED_SOURCE_SHA
fenced_deploy_run_id=$FENCED_DEPLOY_RUN_ID
fenced_data_run_id=$FENCED_DATA_RUN_ID
maintenance_fence=$MAINTENANCE_REHOLD_STATUS
database_lock=$DATABASE_LOCK_STATE
database_lock_acquisition=$FENCED_LOCK_ACQUISITION
database_restore=disabled
message=unexpected-recovery-failure
EOF
  fi
  rm -rf -- "$OUTPUT_DIR/fenced-readiness" \
    "$OUTPUT_DIR/steady-readiness" "$OUTPUT_DIR/telemetry-validation"
  rm -rf -- "$WORK_DIR"
  if ! python3 - "$OUTPUT_DIR" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
allowed = {
    "fenced-expected-current.tsv",
    "fenced-moderation-stability.tsv",
    "fenced-observed-current.tsv",
    "fenced-output-policy-failure.env",
    "fenced-recovery-summary.env",
    "fenced-restore-order.tsv",
    "fenced-restore-plan.tsv",
    "fenced-telemetry.env",
}
violations = []
for path in sorted(root.rglob("*")):
    if path.is_dir() and not path.is_symlink():
        continue
    relative = path.relative_to(root).as_posix()
    if relative not in allowed or path.is_symlink():
        violations.append(relative)
        path.unlink(missing_ok=True)
for directory in sorted(
    (path for path in root.rglob("*") if path.is_dir()),
    key=lambda value: len(value.parts),
    reverse=True,
):
    try:
        directory.rmdir()
    except OSError:
        pass
if violations:
    raise SystemExit(1)
PY
  then
    write_text_atomic "$OUTPUT_DIR/fenced-output-policy-failure.env" <<EOF
status=FAIL
failure_code=output-allowlist-violation
EOF
    output_policy_status=1
  fi
  if [[ "$exit_status" == "0" && "$output_policy_status" != "0" ]]; then
    return 1
  fi
  return "$exit_status"
}
trap cleanup_private_work EXIT

require_regular_file "$BASELINE_DIR/baseline-provenance.env"
require_regular_file "$BASELINE_DIR/deployments.tsv"
require_regular_file "$BASELINE_DIR/images.tsv"
require_regular_file "$BASELINE_DIR/telemetry-pre-run.env"
require_regular_file "$PRE_RECOVERY_BUILD_DIR/images.tsv"
grep -Eq "^[0-9a-f]{64}  telemetry-pre-run\\.env$" "$BASELINE_DIR/SHA256SUMS" ||
  oci_die "baseline does not checksum-bind the pre-run Telemetry state"
(
  cd "$BASELINE_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS >/dev/null
  else
    shasum -a 256 -c SHA256SUMS >/dev/null
  fi
) || oci_die "baseline checksum evidence is invalid"

# The infrastructure provenance the workflow verified must be the same bytes the
# operator acts on.
if [[ -n "$OCI_INFRASTRUCTURE_PROVENANCE_SHA256" ]]; then
  require_regular_file "$OCI_INFRASTRUCTURE_PROVENANCE_FILE"
  actual_infrastructure_sha256="$(sha256_file "$OCI_INFRASTRUCTURE_PROVENANCE_FILE")"
  [[ "$actual_infrastructure_sha256" == "$OCI_INFRASTRUCTURE_PROVENANCE_SHA256" ]] ||
    oci_die "infrastructure provenance hash does not match the selected artifact"
fi

# Bind the immutable baseline artifact to the exact rollback target and the
# exact failed deployment that captured it.
python3 - \
  "$BASELINE_DIR/baseline-provenance.env" \
  "$TARGET_SHA" \
  "$INFRASTRUCTURE_RUN_ID" <<'PY' || oci_die "baseline provenance does not authorize this fenced recovery"
import sys
from pathlib import Path

path, target_sha, infrastructure_run_id = sys.argv[1:4]
values = {}
for line in Path(path).read_text(encoding="utf-8").splitlines():
    if not line or "=" not in line:
        raise SystemExit("baseline provenance is malformed")
    key, value = line.split("=", 1)
    if key in values:
        raise SystemExit("baseline provenance has duplicate keys")
    values[key] = value

if values.get("baseline_source_sha") != target_sha:
    raise SystemExit("baseline does not describe the rollback target")
if values.get("database_restore") != "disabled":
    raise SystemExit("baseline requires a database restore")
if values.get("registry_provider") != "ghcr":
    raise SystemExit("baseline is not a public GHCR generation")
if values.get("registry_repository") != "ghcr.io/vasilyevstan/betstan-images":
    raise SystemExit("baseline registry repository is not the reviewed package")
if values.get("registry_public_anonymous") != "true":
    raise SystemExit("baseline registry is not anonymously pullable")
for key in ("baseline_deploy_run_id", "baseline_build_run_id"):
    if not values.get(key, "").isdigit() or int(values[key]) <= 0:
        raise SystemExit(f"baseline {key} is invalid")
if not infrastructure_run_id.isdigit() or int(infrastructure_run_id) <= 0:
    raise SystemExit("infrastructure run id is invalid")
PY

# Build the exact target image map and the expected currently deployed map.
python3 - \
  "$BASELINE_DIR/deployments.tsv" \
  "$BASELINE_DIR/images.tsv" \
  "$PRE_RECOVERY_BUILD_DIR/images.tsv" \
  "$BASELINE_DIR/telemetry-pre-run.env" \
  "$OUTPUT_DIR/fenced-restore-plan.tsv" \
  "$OUTPUT_DIR/fenced-expected-current.tsv" \
  "$OUTPUT_DIR/fenced-telemetry.env" <<'PY' || oci_die "fenced recovery could not build an exact restore plan"
import csv
import re
import sys

(
    deployments_path,
    baseline_images_path,
    current_images_path,
    telemetry_path,
    plan_path,
    expected_current_path,
    telemetry_output_path,
) = sys.argv[1:8]

services = [
    "auth", "bet", "backoffice", "client", "event",
    "moderation", "resulting", "slip", "gamemaster",
]
current_services = set(services) | {"telemetry"}
image_pattern = re.compile(
    r"^ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}$"
)


def rows(path, minimum):
    with open(path, encoding="utf-8", newline="") as handle:
        parsed = [row for row in csv.reader(handle, delimiter="\t") if row]
    if any(len(row) < minimum for row in parsed):
        raise SystemExit(f"{path}: malformed TSV evidence")
    return parsed


deployments = {}
for row in rows(deployments_path, 6):
    service, image, _revision, desired, ready, available = row[:6]
    if not image_pattern.fullmatch(image):
        raise SystemExit(f"{service}: baseline image is not an immutable digest")
    if not desired.isdigit() or int(desired) < 1:
        raise SystemExit(f"{service}: baseline replica count is invalid")
    if ready != desired or available != desired:
        raise SystemExit(f"{service}: baseline replica state was not healthy")
    deployments[service] = (image, desired)

baseline_images = {}
for row in rows(baseline_images_path, 3):
    if not image_pattern.fullmatch(row[2]):
        raise SystemExit(f"{row[0]}: baseline image reference is invalid")
    baseline_images[row[0]] = row[2]

current_images = {}
for row in rows(current_images_path, 3):
    if not image_pattern.fullmatch(row[2]):
        raise SystemExit(f"{row[0]}: deployed image reference is invalid")
    current_images[row[0]] = row[2]

if sorted(deployments) != sorted(services):
    raise SystemExit("baseline deployments do not cover the nine services")
if sorted(baseline_images) != sorted(services):
    raise SystemExit("baseline images do not cover the nine services")
if set(current_images) != current_services:
    raise SystemExit("deployed images do not cover the current ten services")

telemetry = {}
for raw in open(telemetry_path, encoding="utf-8").read().splitlines():
    if not raw or "=" not in raw:
        raise SystemExit("pre-run Telemetry evidence is malformed")
    key, value = raw.split("=", 1)
    if key in telemetry:
        raise SystemExit("pre-run Telemetry evidence contains duplicate keys")
    telemetry[key] = value
if set(telemetry) != {"mode", "image", "database_initialized", "queue_present"}:
    raise SystemExit("pre-run Telemetry evidence key set is invalid")
if (
    telemetry["mode"] not in {"retained", "absent"}
    or telemetry["database_initialized"] not in {"true", "false"}
    or telemetry["queue_present"] not in {"true", "false"}
    or (
        telemetry["mode"] == "retained"
        and (
            not image_pattern.fullmatch(telemetry["image"])
            or telemetry["queue_present"] != "true"
        )
    )
    or (
        telemetry["mode"] == "absent"
        and telemetry["image"] != "none"
    )
):
    raise SystemExit("pre-run Telemetry evidence is invalid")

for service in services:
    if deployments[service][0] != baseline_images[service]:
        raise SystemExit(f"{service}: baseline image evidence is inconsistent")

with open(plan_path, "w", encoding="utf-8", newline="") as handle:
    writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
    for service in services:
        image, desired = deployments[service]
        writer.writerow([service, f"gaming-{service}-depl", image, desired])

with open(expected_current_path, "w", encoding="utf-8", newline="") as handle:
    writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
    for service in services:
        writer.writerow(
            [
                service,
                "ghcr.io/vasilyevstan/betstan-images",
                current_images[service],
            ]
        )
with open(telemetry_output_path, "w", encoding="utf-8") as handle:
    for key in ("mode", "image", "database_initialized", "queue_present"):
        handle.write(f"{key}={telemetry[key]}\n")
    handle.write(f"candidate_image={current_images['telemetry']}\n")
PY

plan_value() {
  awk -F '\t' -v service="$1" -v column="$2" \
    '$1 == service {print $column}' "$OUTPUT_DIR/fenced-restore-plan.tsv"
}

# Pre-mutation gate: positively verify the expected fenced state.
oci_log "oci_fenced_recovery=preflight target_sha=$TARGET_SHA deployed_sha=$DEPLOYED_SOURCE_SHA"
"$MAINTENANCE_SCRIPT" verify-held >"$WORK_DIR/fenced-verify-held.txt" 2>&1 ||
  oci_die "maintenance fence and writer quiescence are not intact"

# Independently confirm that the live legacy generation is an exact rollout
# prefix between the checksum-bound baseline and the selected current build.
: >"$OUTPUT_DIR/fenced-observed-current.tsv"
while IFS=$'\t' read -r service _repository expected_image; do
  [[ -n "$service" ]] || continue
  observed_image="$(
    kubectl get "deployment/gaming-${service}-depl" -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath="{.spec.template.spec.containers[?(@.name=='gaming-${service}')].image}"
  )" || oci_die "unable to read the live image for gaming-${service}-depl"
  printf '%s\t%s\t%s\n' "$service" \
    "ghcr.io/vasilyevstan/betstan-images" "$observed_image" \
    >>"$OUTPUT_DIR/fenced-observed-current.tsv"
done <"$OUTPUT_DIR/fenced-expected-current.tsv"
kubectl get deployment gaming-telemetry-depl -n "$OCI_K8S_NAMESPACE" \
  --ignore-not-found -o json >"$WORK_DIR/fenced-observed-telemetry-deployment.json" ||
  oci_die "unable to inspect the live Telemetry deployment"
kubectl get service gaming-telemetry-srv -n "$OCI_K8S_NAMESPACE" \
  --ignore-not-found -o json >"$WORK_DIR/fenced-observed-telemetry-service.json" ||
  oci_die "unable to inspect the live Telemetry service"
kubectl get ingress gaming-oci-ingress -n "$OCI_K8S_NAMESPACE" \
  -o json >"$WORK_DIR/fenced-observed-ingress.json" ||
  oci_die "unable to inspect the live ingress"
python3 - \
  "$OUTPUT_DIR/fenced-restore-plan.tsv" \
  "$OUTPUT_DIR/fenced-expected-current.tsv" \
  "$OUTPUT_DIR/fenced-observed-current.tsv" \
  "$OUTPUT_DIR/fenced-telemetry.env" \
  "$WORK_DIR/fenced-observed-telemetry-deployment.json" \
  "$WORK_DIR/fenced-observed-telemetry-service.json" \
  "$WORK_DIR/fenced-observed-ingress.json" <<'PY' ||
import csv
import json
import sys

(
    baseline_path,
    candidate_path,
    observed_path,
    telemetry_path,
    telemetry_deployment_path,
    telemetry_service_path,
    ingress_path,
) = sys.argv[1:8]
forward_order = [
    "auth", "bet", "event", "moderation", "resulting",
    "slip", "backoffice", "client", "gamemaster",
]
recovery_order = [
    "auth", "bet", "backoffice", "event", "moderation",
    "resulting", "slip", "client", "gamemaster",
]

def read(path, image_column):
    result = {}
    with open(path, encoding="utf-8", newline="") as handle:
        for row in csv.reader(handle, delimiter="\t"):
            if not row or row[0] in result or len(row) <= image_column:
                raise SystemExit("legacy rollout evidence is malformed")
            result[row[0]] = row[image_column]
    return result

baseline = read(baseline_path, 2)
candidate = read(candidate_path, 2)
observed = read(observed_path, 2)
if set(baseline) != set(forward_order) or set(candidate) != set(forward_order):
    raise SystemExit("legacy rollout evidence does not contain nine services")
if set(observed) != set(forward_order):
    raise SystemExit("observed legacy rollout does not contain nine services")
telemetry = {}
for raw in open(telemetry_path, encoding="utf-8").read().splitlines():
    key, value = raw.split("=", 1)
    telemetry[key] = value
deployment_content = open(telemetry_deployment_path, encoding="utf-8").read()
service_content = open(telemetry_service_path, encoding="utf-8").read()
ingress = json.load(open(ingress_path, encoding="utf-8"))
deployment = json.loads(deployment_content) if deployment_content else None
service = json.loads(service_content) if service_content else None
routes = [
    path
    for rule in ingress.get("spec", {}).get("rules", [])
    for path in rule.get("http", {}).get("paths", [])
    if path.get("path") == "/api/telemetry/?(.*)"
]
if any(
    path.get("backend", {}).get("service", {}).get("name")
    != "gaming-telemetry-srv"
    for path in routes
) or len(routes) not in {0, 1, 2}:
    raise SystemExit("live Telemetry ingress progress is invalid")
telemetry_ready = False
if deployment:
    containers = [
        item
        for item in deployment.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
        if item.get("name") == "gaming-telemetry"
    ]
    desired = deployment.get("spec", {}).get("replicas", 0)
    status = deployment.get("status", {})
    if len(containers) != 1 or containers[0].get("image") not in {
        telemetry["candidate_image"], telemetry["image"]
    }:
        raise SystemExit("live Telemetry image is not baseline or candidate")
    telemetry_ready = (
        desired > 0
        and status.get("updatedReplicas", 0) == desired
        and status.get("readyReplicas", 0) == desired
        and status.get("availableReplicas", 0) == desired
    )
if telemetry["mode"] == "retained" and (
    deployment is None or service is None or len(routes) != 2
):
    raise SystemExit("pre-existing Telemetry resources are missing")

def matches_family(order, left, right):
    for split in range(len(order) + 1):
        if all(
            observed[service] == (
                left[service] if index < split else right[service]
            )
            for index, service in enumerate(order)
        ):
            return True
    return False

for legacy_service in forward_order:
    if observed[legacy_service] not in {
        baseline[legacy_service], candidate[legacy_service]
    }:
        raise SystemExit("legacy workload has an unknown image")
if not (
    matches_family(forward_order, candidate, baseline)
    or matches_family(recovery_order, baseline, candidate)
):
    raise SystemExit("legacy workload state is not an authorized forward or recovery prefix")
resource_progress = (
    deployment is not None,
    service is not None,
    len(routes),
)
allowed_progress = {
    (True, True, 2),
    (True, True, 0),
    (True, False, 0),
    (False, False, 0),
}
if telemetry["mode"] == "absent" and resource_progress not in allowed_progress:
    raise SystemExit("Telemetry cleanup progress is not an authorized prefix")
PY
  oci_die "live legacy workloads are not an authorized rollout prefix"

# The transferred lock must still be ours, or be an expired lease we may
# reclaim. This mirrors the deployment's own maintenance-rehold contract:
# `verify`, else `acquire`. Acquire refuses when another operation holds a live
# lease, and bumps the fencing generation when reclaiming an expired one. The
# fence and writer quiescence verified above are what actually prevent writes,
# and both were independently confirmed before this point.
FENCED_LOCK_ACQUISITION=verified
if NAMESPACE="$OCI_K8S_NAMESPACE" \
  LOCK_TOKEN="live-data-${FENCED_DATA_RUN_ID}-1" \
  OPERATION_ID="live-data-apply-slip-index" \
  SOURCE_SHA="$DEPLOYED_SOURCE_SHA" \
    "$LOCK_SCRIPT" verify >"$WORK_DIR/fenced-lock-verify.txt" 2>&1; then
  :
else
  FENCED_LOCK_ACQUISITION=reclaimed
  NAMESPACE="$OCI_K8S_NAMESPACE" \
  LOCK_TOKEN="live-data-${FENCED_DATA_RUN_ID}-1" \
  OPERATION_ID="live-data-apply-slip-index" \
  LOCK_LEASE_SECONDS="$FENCED_LOCK_LEASE_SECONDS" \
  SOURCE_SHA="$DEPLOYED_SOURCE_SHA" \
    "$LOCK_SCRIPT" acquire >>"$WORK_DIR/fenced-lock-verify.txt" 2>&1 ||
    oci_die "the transferred database lock is held by another live operation"
  NAMESPACE="$OCI_K8S_NAMESPACE" \
  LOCK_TOKEN="live-data-${FENCED_DATA_RUN_ID}-1" \
  OPERATION_ID="live-data-apply-slip-index" \
  SOURCE_SHA="$DEPLOYED_SOURCE_SHA" \
    "$LOCK_SCRIPT" verify >>"$WORK_DIR/fenced-lock-verify.txt" 2>&1 ||
    oci_die "the reclaimed database lock did not verify as held"
fi
FENCED_READINESS_DIR="$OUTPUT_DIR/fenced-readiness"
FENCED_EXPECTED_CURRENT_FILE="$OUTPUT_DIR/fenced-observed-current.tsv"
if ! TARGET_SHA="$TARGET_SHA" \
    ROLLBACK_READINESS_PHASE=maintenance-fenced \
    MAINTENANCE_DEPLOYED_SOURCE_SHA="$DEPLOYED_SOURCE_SHA" \
    MAINTENANCE_LIVE_IMAGES_FILE="$FENCED_EXPECTED_CURRENT_FILE" \
    OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
    OCI_PUBLIC_URL="$OCI_PUBLIC_URL" \
    OCI_REDIRECT_URL="$OCI_REDIRECT_URL" \
    OCI_DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
    OUTPUT_DIR="$FENCED_READINESS_DIR" \
    "$READINESS_SCRIPT" >"$WORK_DIR/fenced-readiness.txt" 2>&1; then
  oci_die "maintenance-fenced readiness rejected the fenced rollback recovery"
fi
[[ "$(awk -F '=' '$1 == "rollback_readiness" {print $2}' \
  "$FENCED_READINESS_DIR/summary.env")" == "GO" ]] ||
  oci_die "maintenance-fenced readiness did not authorize the fenced recovery"
[[ "$(awk -F '=' '$1 == "phase" {print $2}' \
  "$FENCED_READINESS_DIR/summary.env")" == "maintenance-fenced" ]] ||
  oci_die "readiness summary phase is not maintenance-fenced"

# Mutation begins here. Every later failure re-holds maintenance.
FENCED_MUTATION_STARTED=true
telemetry_mode="$(awk -F '=' '$1 == "mode" {print $2}' \
  "$OUTPUT_DIR/fenced-telemetry.env")"
telemetry_pre_run_image="$(awk -F '=' '$1 == "image" {print $2}' \
  "$OUTPUT_DIR/fenced-telemetry.env")"
telemetry_database_initialized="$(awk -F '=' \
  '$1 == "database_initialized" {print $2}' \
  "$OUTPUT_DIR/fenced-telemetry.env")"

: >"$OUTPUT_DIR/fenced-restore-order.tsv"
for service in "${RESTORE_ORDER[@]}"; do
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  image="$(plan_value "$service" 3)"
  replicas="$(plan_value "$service" 4)"
  [[ -n "$image" && -n "$replicas" ]] ||
    fenced_die "restore plan is missing $service"
  printf '%s\t%s\t%s\t%s\n' "$service" "$deployment" "$image" "$replicas" \
    >>"$OUTPUT_DIR/fenced-restore-order.tsv"
  kubectl set image "deployment/${deployment}" -n "$OCI_K8S_NAMESPACE" \
    "${container}=${image}" >/dev/null ||
    fenced_die "failed to restore ${deployment} to the baseline digest"
  if printf '%s\n' "${QUIESCED_SERVICES[@]}" | grep -qx "$service"; then
    kubectl scale "deployment/${deployment}" -n "$OCI_K8S_NAMESPACE" \
      --replicas="$replicas" >/dev/null ||
      fenced_die "failed to restore ${deployment} replica count"
  fi
  kubectl rollout status "deployment/${deployment}" -n "$OCI_K8S_NAMESPACE" \
    --timeout="$ROLLOUT_TIMEOUT" >/dev/null ||
    fenced_die "rollout did not complete for ${deployment}"
  actual_image="$(
    kubectl get "deployment/${deployment}" -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath="{.spec.template.spec.containers[?(@.name=='${container}')].image}"
  )"
  [[ "$actual_image" == "$image" ]] ||
    fenced_die "exact digest verification failed for ${deployment}"
done

# Normalize Telemetry only after every legacy workload has been restored.
if [[ "$telemetry_mode" == "retained" ]]; then
  kubectl set image deployment/gaming-telemetry-depl -n "$OCI_K8S_NAMESPACE" \
    "gaming-telemetry=${telemetry_pre_run_image}" >/dev/null ||
    fenced_die "failed to restore Telemetry to its exact pre-run digest"
  kubectl rollout status deployment/gaming-telemetry-depl \
    -n "$OCI_K8S_NAMESPACE" --timeout="$ROLLOUT_TIMEOUT" >/dev/null ||
    fenced_die "Telemetry did not become ready at its pre-run digest"
else
  [[ "$telemetry_mode" == "absent" ]] ||
    fenced_die "pre-run Telemetry recovery mode is invalid"
  kubectl get ingress gaming-oci-ingress -n "$OCI_K8S_NAMESPACE" -o json \
    >"$WORK_DIR/fenced-ingress-before.json" ||
    fenced_die "failed to inspect the OCI ingress before Telemetry cleanup"
  python3 - "$WORK_DIR/fenced-ingress-before.json" \
    "$WORK_DIR/fenced-telemetry-ingress-patch.json" <<'PY' ||
import json
import sys
from pathlib import Path

document = json.load(open(sys.argv[1], encoding="utf-8"))
removals = []
for rule_index, rule in enumerate(document.get("spec", {}).get("rules", [])):
    for path_index, path in enumerate(rule.get("http", {}).get("paths", [])):
        backend = path.get("backend", {}).get("service", {}).get("name")
        if path.get("path") == "/api/telemetry/?(.*)":
            if backend != "gaming-telemetry-srv":
                raise SystemExit("Telemetry ingress path has an unexpected backend")
            removals.append((rule_index, path_index))
if len(removals) not in {0, 1, 2}:
    raise SystemExit("Telemetry ingress cleanup progress is invalid")
patch = [
    {"op": "remove", "path": f"/spec/rules/{rule_index}/http/paths/{path_index}"}
    for rule_index, path_index in sorted(removals, reverse=True)
]
Path(sys.argv[2]).write_text(
    json.dumps(patch, separators=(",", ":")), encoding="utf-8"
)
PY
    fenced_die "failed to construct the bounded Telemetry ingress cleanup"
  if [[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' \
    "$WORK_DIR/fenced-telemetry-ingress-patch.json")" -gt 0 ]]; then
    kubectl patch ingress gaming-oci-ingress -n "$OCI_K8S_NAMESPACE" \
      --type=json \
      --patch-file "$WORK_DIR/fenced-telemetry-ingress-patch.json" >/dev/null ||
      fenced_die "failed to remove newly created Telemetry ingress paths"
  fi
  kubectl delete service gaming-telemetry-srv -n "$OCI_K8S_NAMESPACE" \
    --ignore-not-found >/dev/null ||
    fenced_die "failed to remove the newly created Telemetry service"
  kubectl delete deployment gaming-telemetry-depl -n "$OCI_K8S_NAMESPACE" \
    --ignore-not-found >/dev/null ||
    fenced_die "failed to remove the newly created Telemetry deployment"
fi

# Moderation crash-looped during the failed deployment. Require its restart
# count to stay stable across a bounded observation window before continuing.
moderation_restarts() {
  kubectl get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-moderation \
    -o jsonpath='{range .items[*]}{.status.containerStatuses[?(@.name=="gaming-moderation")].restartCount}{"\n"}{end}' |
    awk 'NF {sum += $1} END {print sum + 0}'
}
baseline_restarts="$(moderation_restarts)"
for ((attempt = 1; attempt <= MODERATION_OBSERVATION_ATTEMPTS; attempt++)); do
  sleep "$MODERATION_OBSERVATION_SLEEP_SECONDS"
  current_restarts="$(moderation_restarts)"
  printf 'attempt=%s restarts=%s\n' "$attempt" "$current_restarts" \
    >>"$OUTPUT_DIR/fenced-moderation-stability.tsv"
  [[ "$current_restarts" == "$baseline_restarts" ]] ||
    fenced_die "gaming-moderation restarted during the recovery observation window"
done
ready_moderation="$(
  kubectl get deployment gaming-moderation-depl -n "$OCI_K8S_NAMESPACE" \
    -o jsonpath='{.status.readyReplicas}'
)"
[[ "${ready_moderation:-0}" -ge 1 ]] ||
  fenced_die "gaming-moderation did not become ready after the restore"

if [[ "$telemetry_mode" == "retained" ]]; then
  MODE=retained \
  EXPECTED_IMAGE="$telemetry_pre_run_image" \
  EXPECTED_DATABASE_INITIALIZED="$telemetry_database_initialized" \
  OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
  OCI_PUBLIC_URL="$OCI_PUBLIC_URL" \
  OCI_DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
  OUTPUT_DIR="$WORK_DIR/telemetry-validation" \
    "$TELEMETRY_RECOVERY_SCRIPT" \
      >"$WORK_DIR/telemetry-validation.txt" 2>&1 ||
    fenced_die "retained Telemetry state failed terminal recovery validation"
else
  MODE=absent \
  OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
  OUTPUT_DIR="$WORK_DIR/telemetry-validation" \
    "$TELEMETRY_RECOVERY_SCRIPT" \
      >"$WORK_DIR/telemetry-validation.txt" 2>&1 ||
    fenced_die "first-activation Telemetry resources were not cleanly removed"
fi

# Safe established order: release the transferred database lock only after the
# restored workloads are healthy, then remove the public write fence.
DATABASE_LOCK_STATE=release-ambiguous
NAMESPACE="$OCI_K8S_NAMESPACE" \
LOCK_TOKEN="live-data-${FENCED_DATA_RUN_ID}-1" \
OPERATION_ID="live-data-apply-slip-index" \
SOURCE_SHA="$DEPLOYED_SOURCE_SHA" \
  "$LOCK_SCRIPT" release >"$WORK_DIR/fenced-lock-release.txt" 2>&1 ||
  fenced_die "restored workloads are healthy but the database lock could not be released"
NAMESPACE="$OCI_K8S_NAMESPACE" \
LOCK_TOKEN="live-data-${FENCED_DATA_RUN_ID}-1" \
OPERATION_ID="live-data-apply-slip-index" \
SOURCE_SHA="$DEPLOYED_SOURCE_SHA" \
  "$LOCK_SCRIPT" verify-released >>"$WORK_DIR/fenced-lock-release.txt" 2>&1 ||
  fenced_die "the database lock did not verify as released"
DATABASE_LOCK_STATE=released

"$MAINTENANCE_SCRIPT" release >"$WORK_DIR/fenced-fence-release.txt" 2>&1 ||
  fenced_die "restored workloads are healthy but the maintenance fence could not be released safely"

# Final gate: ordinary steady-state readiness, requiring 200 responses again.
STEADY_READINESS_DIR="$OUTPUT_DIR/steady-readiness"
if ! TARGET_SHA="$TARGET_SHA" \
    OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
    OCI_PUBLIC_URL="$OCI_PUBLIC_URL" \
    OCI_REDIRECT_URL="$OCI_REDIRECT_URL" \
    OCI_DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
    OUTPUT_DIR="$STEADY_READINESS_DIR" \
    "$READINESS_SCRIPT" >"$WORK_DIR/steady-readiness.txt" 2>&1; then
  fenced_die "restored generation failed ordinary steady-state readiness"
fi
[[ "$(awk -F '=' '$1 == "phase" {print $2}' \
  "$STEADY_READINESS_DIR/summary.env")" == "steady-state" ]] ||
  fenced_die "final readiness did not run in the steady-state phase"

write_text_atomic "$OUTPUT_DIR/fenced-recovery-summary.env" <<EOF
status=PASS
mode=fenced-rollback-recovery
target_sha=$TARGET_SHA
deployed_source_sha=$DEPLOYED_SOURCE_SHA
fenced_deploy_run_id=$FENCED_DEPLOY_RUN_ID
fenced_data_run_id=$FENCED_DATA_RUN_ID
infrastructure_run_id=$INFRASTRUCTURE_RUN_ID
maintenance_fence=released
database_lock=released
database_lock_acquisition=$FENCED_LOCK_ACQUISITION
database_restore=disabled
restored_services=${#RESTORE_ORDER[@]}
telemetry_state=$telemetry_mode
EOF
oci_log "oci_fenced_rollback_recovery=PASS target_sha=$TARGET_SHA services=${#RESTORE_ORDER[@]}"
