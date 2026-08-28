#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

TARGET_SHA="${TARGET_SHA:-}"
PARTIAL_ROLLBACK_RUN_ID="${PARTIAL_ROLLBACK_RUN_ID:-}"
PARTIAL_ROLLBACK_SOURCE_DIR="${PARTIAL_ROLLBACK_SOURCE_DIR:-}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-rollback}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_PUBLIC_URL="${OCI_PUBLIC_URL:-https://betstan.xyz}"
OCI_REDIRECT_URL="${OCI_REDIRECT_URL:-https://www.betstan.xyz}"
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
OCI_INFRASTRUCTURE_PROVENANCE_FILE="${OCI_INFRASTRUCTURE_PROVENANCE_FILE:-}"
ROLLBACK_READINESS_SCRIPT="${ROLLBACK_READINESS_SCRIPT:-$SCRIPT_DIR/rollback-readiness-stan.sh}"
SERVICE_OPS_SCRIPT="${SERVICE_OPS_SCRIPT:-$OCI_ROOT_DIR/infra/oci/agents/service-ops-stan.sh}"
CONFIRMATION="${CONFIRMATION:-}"
SERVICES=(auth bet backoffice client event moderation resulting slip gamemaster)

write_text_atomic() {
  local target="$1"
  local temporary="${target}.tmp.$$.$RANDOM"
  cat >"$temporary"
  mv "$temporary" "$target"
}

capture_runtime_state() {
  local output_file="$1"
  local service deployment deployment_file
  : >"$output_file"
  for service in "${SERVICES[@]}"; do
    deployment="gaming-${service}-depl"
    deployment_file="$WORK_DIR/${service}-deployment.json"
    kubectl get deployment "$deployment" \
      -n "$OCI_K8S_NAMESPACE" -o json >"$deployment_file"
    python3 - "$deployment_file" "$service" "$deployment" >>"$output_file" <<'PY'
import json
import sys

path, service, deployment = sys.argv[1:4]
document = json.load(open(path, encoding="utf-8"))
container = f"gaming-{service}"
images = [
    item.get("image", "")
    for item in document.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    if item.get("name") == container
]
if len(images) != 1:
    raise SystemExit(f"{deployment}: expected exactly one {container} image")
status = document.get("status", {})
spec = document.get("spec", {})
print(
    service,
    deployment,
    images[0],
    spec.get("replicas", 0),
    status.get("updatedReplicas", 0),
    status.get("readyReplicas", 0),
    status.get("availableReplicas", 0),
    sep="\t",
)
PY
  done
}

validate_runtime_progress() {
  local runtime_state_file="$1"
  python3 - \
    "$runtime_state_file" \
    "$PARTIAL_ROLLBACK_SOURCE_DIR/pre-rollback-state.tsv" \
    "$PARTIAL_ROLLBACK_SOURCE_DIR/partial-state.tsv" \
    "$OUTPUT_DIR/recovery-plan.tsv" <<'PY'
import csv
import sys

runtime_path, pre_path, partial_path, plan_path = sys.argv[1:5]

def rows(path, width):
    with open(path, encoding="utf-8", newline="") as handle:
        parsed = list(csv.reader(handle, delimiter="\t"))
    if any(len(row) != width for row in parsed):
        raise SystemExit(f"{path}: malformed row")
    return parsed

runtime = {row[0]: row for row in rows(runtime_path, 7)}
pre = {row[0]: row[2] for row in rows(pre_path, 5)}
partial = {row[0]: row[1] for row in rows(partial_path, 3)}
plan = rows(plan_path, 4)
planned = {row[0] for row in plan}

if set(runtime) != set(pre) or set(pre) != set(partial):
    raise SystemExit("runtime service set does not match the recovery artifact")

for service in set(runtime) - planned:
    if pre[service] != partial[service] or runtime[service][2] != pre[service]:
        raise SystemExit(f"{service}: unplanned runtime state differs from the recovery artifact")

encountered_partial = False
for service, _deployment, pre_image, partial_image in plan:
    actual = runtime[service][2]
    if actual == partial_image:
        encountered_partial = True
    elif actual == pre_image:
        if encountered_partial:
            raise SystemExit("runtime recovery progress is not a valid plan prefix")
    else:
        raise SystemExit(f"{service}: runtime image differs from both authorized states")
PY
}

verify_ready_image() {
  local service="$1"
  local expected_image="$2"
  local deployment="gaming-${service}-depl"
  local deployment_file="$WORK_DIR/${service}-verified-deployment.json"
  kubectl get deployment "$deployment" \
    -n "$OCI_K8S_NAMESPACE" -o json >"$deployment_file"
  python3 - "$deployment_file" "$service" "$expected_image" <<'PY'
import json
import sys

path, service, expected_image = sys.argv[1:4]
document = json.load(open(path, encoding="utf-8"))
container = f"gaming-{service}"
images = [
    item.get("image", "")
    for item in document.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    if item.get("name") == container
]
if images != [expected_image]:
    raise SystemExit(f"{service}: deployment does not use the authorized recovery image")
desired = document.get("spec", {}).get("replicas", 0)
status = document.get("status", {})
if desired < 1 or any(
    status.get(field, 0) != desired
    for field in ("updatedReplicas", "readyReplicas", "availableReplicas")
):
    raise SystemExit(f"{service}: recovered deployment is not fully ready")
if status.get("observedGeneration", 0) != document.get("metadata", {}).get("generation", 0):
    raise SystemExit(f"{service}: recovered deployment generation is not observed")
PY
}

validate_final_state() {
  local runtime_state_file="$1"
  python3 - \
    "$runtime_state_file" \
    "$PARTIAL_ROLLBACK_SOURCE_DIR/pre-rollback-state.tsv" <<'PY'
import csv
import sys

runtime_path, pre_path = sys.argv[1:3]
with open(runtime_path, encoding="utf-8", newline="") as handle:
    runtime_rows = list(csv.reader(handle, delimiter="\t"))
with open(pre_path, encoding="utf-8", newline="") as handle:
    pre_rows = list(csv.reader(handle, delimiter="\t"))
runtime = {row[0]: row for row in runtime_rows}
pre = {row[0]: row for row in pre_rows}
if set(runtime) != set(pre):
    raise SystemExit("final runtime service set does not match the authorized pre-run state")
for service, row in runtime.items():
    if row[2] != pre[service][2]:
        raise SystemExit(f"{service}: final image does not match the authorized pre-run state")
    desired, updated, ready, available = map(int, row[3:7])
    if desired < 1 or (updated, ready, available) != (desired, desired, desired):
        raise SystemExit(f"{service}: final deployment is not fully ready")
PY
}

oci_require_command kubectl
oci_require_command python3
oci_require_vars \
  TARGET_SHA \
  PARTIAL_ROLLBACK_RUN_ID \
  PARTIAL_ROLLBACK_SOURCE_DIR \
  OCI_INFRASTRUCTURE_PROVENANCE_FILE
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "TARGET_SHA must be a full lowercase commit SHA"
oci_is_positive_int "$PARTIAL_ROLLBACK_RUN_ID" ||
  oci_die "PARTIAL_ROLLBACK_RUN_ID must be positive"
[[ "$CONFIRMATION" == "RECOVER OCI PARTIAL ROLLBACK" ]] ||
  oci_die "partial rollback recovery confirmation is invalid"
if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
  [[ "$GITHUB_REF_NAME" == "master" ]] ||
    oci_die "partial rollback recovery must run from master"
fi
[[ -x "$ROLLBACK_READINESS_SCRIPT" ]] ||
  oci_die "rollback readiness script is not executable"
[[ -x "$SERVICE_OPS_SCRIPT" ]] ||
  oci_die "service diagnostics script is not executable"
[[ -f "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" &&
   ! -L "$OCI_INFRASTRUCTURE_PROVENANCE_FILE" ]] ||
  oci_die "infrastructure provenance file is invalid"

python3 - "$PARTIAL_ROLLBACK_SOURCE_DIR" "$OUTPUT_DIR" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
if source == output or source in output.parents or output in source.parents:
    raise SystemExit("partial rollback source and output directories must not overlap")
PY
oci_prepare_safe_private_dir "$OUTPUT_DIR"

python3 - \
  "$PARTIAL_ROLLBACK_SOURCE_DIR" \
  "$TARGET_SHA" \
  "$OUTPUT_DIR/recovery-plan.tsv" <<'PY'
import csv
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
target_sha = sys.argv[2]
output = Path(sys.argv[3])
services = ["auth", "bet", "backoffice", "client", "event", "moderation", "resulting", "slip", "gamemaster"]
image_pattern = re.compile(r"^ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}$")
required = {
    "failure-state.env",
    "pre-rollback-state.tsv",
    "partial-state.tsv",
    "rollout-order.tsv",
    "baseline/baseline-provenance.env",
}

if not root.is_dir() or root.is_symlink():
    raise SystemExit("partial rollback artifact directory is invalid")
for relative in required:
    path = root / relative
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"partial rollback artifact file is invalid: {relative}")

def env(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or "=" not in line:
            raise SystemExit(f"{path}: malformed environment evidence")
        key, value = line.split("=", 1)
        if not key or key in values:
            raise SystemExit(f"{path}: duplicate or empty evidence key")
        values[key] = value
    return values

failure = env(root / "failure-state.env")
baseline = env(root / "baseline/baseline-provenance.env")
if baseline.get("baseline_source_sha") != target_sha:
    raise SystemExit("partial rollback artifact target does not match TARGET_SHA")
if failure.get("status") != "FAIL":
    raise SystemExit("partial rollback artifact is not a failed run")
failed_service = failure.get("failed_service", "")
if failed_service not in services:
    raise SystemExit("partial rollback failed service is invalid")
if failure.get("failed_deployment") != f"gaming-{failed_service}-depl":
    raise SystemExit("partial rollback failed deployment is invalid")
if failure.get("failed_step_label") != f"failed-{failed_service}":
    raise SystemExit("partial rollback failed step label is invalid")

def tsv(path, width):
    with path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.reader(handle, delimiter="\t"))
    if not rows or any(len(row) != width for row in rows):
        raise SystemExit(f"{path}: malformed TSV evidence")
    return rows

pre_rows = tsv(root / "pre-rollback-state.tsv", 5)
partial_rows = tsv(root / "partial-state.tsv", 3)
if [row[0] for row in pre_rows] != services or [row[0] for row in partial_rows] != services:
    raise SystemExit("partial rollback service order is invalid")
pre = {row[0]: row for row in pre_rows}
partial = {row[0]: row for row in partial_rows}
for service in services:
    if pre[service][1] != f"gaming-{service}-depl":
        raise SystemExit(f"{service}: pre-run deployment name is invalid")
    if not image_pattern.fullmatch(pre[service][2]) or not image_pattern.fullmatch(partial[service][1]):
        raise SystemExit(f"{service}: recovery image is not an immutable BetStan GHCR digest")

order_rows = tsv(root / "rollout-order.tsv", 1)
order = [row[0] for row in order_rows]
if len(order) != len(set(order)) or order != services[: len(order)]:
    raise SystemExit("partial rollback rollout order is invalid")
if order[-1] != failed_service:
    raise SystemExit("partial rollback failed service is not the final attempted service")
if pre[failed_service][2] == partial[failed_service][1]:
    raise SystemExit("partial rollback did not change the failed service")
for service in services[len(order) :]:
    if pre[service][2] != partial[service][1]:
        raise SystemExit(f"{service}: unattempted service changed during the partial rollback")

plan = []
for service in reversed(order):
    pre_image = pre[service][2]
    partial_image = partial[service][1]
    if pre_image != partial_image:
        plan.append((service, f"gaming-{service}-depl", pre_image, partial_image))
if not plan or plan[0][0] != failed_service:
    raise SystemExit("partial rollback recovery plan does not start with the failed service")

with output.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
    writer.writerows(plan)
PY

WORK_PARENT_DIR="$OUTPUT_DIR/.workdirs"
oci_prepare_private_dir "$WORK_PARENT_DIR"
WORK_DIR="$(mktemp -d "$WORK_PARENT_DIR/recovery.XXXXXX")"
trap 'rm -rf -- "$WORK_DIR"' EXIT

chmod 600 "$OUTPUT_DIR/recovery-plan.tsv"

capture_runtime_state "$OUTPUT_DIR/observed-pre-recovery-state.tsv"
validate_runtime_progress "$OUTPUT_DIR/observed-pre-recovery-state.tsv" ||
  oci_die "runtime does not match an authorized partial recovery state"

if ! NAMESPACE="$OCI_K8S_NAMESPACE" \
    OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
    INFRA_PROVENANCE_FILE="$OCI_INFRASTRUCTURE_PROVENANCE_FILE" \
    "$SERVICE_OPS_SCRIPT" >"$OUTPUT_DIR/pre-recovery-service-ops.txt" 2>&1; then
  printf '%s\n' "diagnostic_status=unavailable" \
    >"$OUTPUT_DIR/pre-recovery-diagnostics.env"
else
  printf '%s\n' "diagnostic_status=captured" \
    >"$OUTPUT_DIR/pre-recovery-diagnostics.env"
fi

: >"$OUTPUT_DIR/recovery-rollout-order.tsv"
while IFS=$'\t' read -r service deployment pre_image partial_image; do
  current_file="$WORK_DIR/${service}-current.json"
  kubectl get deployment "$deployment" \
    -n "$OCI_K8S_NAMESPACE" -o json >"$current_file"
  current_image="$(
    python3 - "$current_file" "$service" <<'PY'
import json
import sys

document = json.load(open(sys.argv[1], encoding="utf-8"))
container = f"gaming-{sys.argv[2]}"
images = [
    item.get("image", "")
    for item in document.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    if item.get("name") == container
]
if len(images) != 1:
    raise SystemExit("deployment image is ambiguous")
print(images[0])
PY
  )"
  if [[ "$current_image" == "$pre_image" ]]; then
    printf '%s\t%s\n' "$service" already-restored \
      >>"$OUTPUT_DIR/recovery-rollout-order.tsv"
    verify_ready_image "$service" "$pre_image"
    continue
  fi
  [[ "$current_image" == "$partial_image" ]] ||
    oci_die "${service}: runtime image changed after recovery preflight"
  kubectl set image "deployment/${deployment}" \
    -n "$OCI_K8S_NAMESPACE" "gaming-${service}=${pre_image}" >/dev/null
  kubectl rollout status "deployment/${deployment}" \
    -n "$OCI_K8S_NAMESPACE" --timeout=10m
  verify_ready_image "$service" "$pre_image"
  printf '%s\t%s\n' "$service" restored \
    >>"$OUTPUT_DIR/recovery-rollout-order.tsv"
done <"$OUTPUT_DIR/recovery-plan.tsv"

capture_runtime_state "$OUTPUT_DIR/final-state.tsv"
validate_final_state "$OUTPUT_DIR/final-state.tsv" ||
  oci_die "partial rollback recovery did not restore the exact pre-run state"

if ! TARGET_SHA="$TARGET_SHA" \
    OCI_K8S_NAMESPACE="$OCI_K8S_NAMESPACE" \
    OCI_PUBLIC_URL="$OCI_PUBLIC_URL" \
    OCI_REDIRECT_URL="$OCI_REDIRECT_URL" \
    OCI_DIAGNOSTIC_URL="$OCI_DIAGNOSTIC_URL" \
    OUTPUT_DIR="$OUTPUT_DIR/rollback-readiness" \
    "$ROLLBACK_READINESS_SCRIPT" >"$OUTPUT_DIR/rollback-readiness.txt" 2>&1; then
  oci_die "recovered pre-run state failed rollback readiness"
fi

recovered_services="$(
  awk -F '\t' '{ values = values (values ? " " : "") $1 } END { print values }' \
    "$OUTPUT_DIR/recovery-plan.tsv"
)"
write_text_atomic "$OUTPUT_DIR/partial-recovery-summary.env" <<EOF
status=PASS
mode=abort-partial-rollback
target_sha=$TARGET_SHA
source_rollback_run_id=$PARTIAL_ROLLBACK_RUN_ID
recovered_services=$recovered_services
database_restore=disabled
EOF
oci_log "oci_partial_rollback_recovery=PASS source_run=$PARTIAL_ROLLBACK_RUN_ID services=$recovered_services"
