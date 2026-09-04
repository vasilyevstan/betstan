#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

PARTIAL_RECOVERY_DIR="${PARTIAL_RECOVERY_DIR:-${1:-}}"
PARTIAL_RECOVERY_IMAGES_FILE="${PARTIAL_RECOVERY_IMAGES_FILE:-$PARTIAL_RECOVERY_DIR/images.tsv}"
EXPECTED_RECOVERY_RUN_ID="${EXPECTED_RECOVERY_RUN_ID:-}"
EXPECTED_SOURCE_SHA="${EXPECTED_SOURCE_SHA:-}"
EXPECTED_BUILD_RUN_ID="${EXPECTED_BUILD_RUN_ID:-}"
EXPECTED_SOURCE_ROLLBACK_RUN_ID="${EXPECTED_SOURCE_ROLLBACK_RUN_ID:-}"

[[ -n "$PARTIAL_RECOVERY_DIR" &&
   -d "$PARTIAL_RECOVERY_DIR" &&
   ! -L "$PARTIAL_RECOVERY_DIR" ]] ||
  oci_die "PARTIAL_RECOVERY_DIR must be a regular directory"
[[ -f "$PARTIAL_RECOVERY_IMAGES_FILE" &&
   ! -L "$PARTIAL_RECOVERY_IMAGES_FILE" ]] ||
  oci_die "partial recovery image provenance must be a regular file"
oci_require_command python3

python3 - \
  "$PARTIAL_RECOVERY_DIR" \
  "$PARTIAL_RECOVERY_IMAGES_FILE" \
  "$EXPECTED_RECOVERY_RUN_ID" \
  "$EXPECTED_SOURCE_SHA" \
  "$EXPECTED_BUILD_RUN_ID" \
  "$EXPECTED_SOURCE_ROLLBACK_RUN_ID" <<'PY'
import csv
import hashlib
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
images_path = Path(sys.argv[2])
(
    expected_run_id,
    expected_source_sha,
    expected_build_run_id,
    expected_source_rollback_run_id,
) = sys.argv[3:7]
services = {
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip",
}
repository = "ghcr.io/vasilyevstan/betstan-images"
image_pattern = re.compile(
    r"ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}"
)
digest_pattern = re.compile(r"sha256:[0-9a-f]{64}")
authority_files = {
    "images.tsv": images_path,
    "partial-recovery-authority.env": root / "partial-recovery-authority.env",
    "partial-recovery-summary.env": root / "partial-recovery-summary.env",
    "recovery-plan.tsv": root / "recovery-plan.tsv",
    "recovery-rollout-order.tsv": root / "recovery-rollout-order.tsv",
    "final-state.tsv": root / "final-state.tsv",
    "rollback-readiness/summary.env": root / "rollback-readiness/summary.env",
    "rollback-readiness/workload-state.tsv": (
        root / "rollback-readiness/workload-state.tsv"
    ),
    "rollback-readiness/failures.txt": root / "rollback-readiness/failures.txt",
}
manifest_path = root / "partial-recovery-SHA256SUMS"

for name, path in authority_files.items():
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"partial recovery authority file is invalid: {name}")
if not manifest_path.is_file() or manifest_path.is_symlink():
    raise SystemExit("partial recovery authority checksum manifest is invalid")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


manifest = {}
for raw in manifest_path.read_text(encoding="utf-8").splitlines():
    match = re.fullmatch(
        r"([0-9a-f]{64})  ((?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+)",
        raw,
    )
    if not match or match.group(2) in manifest:
        raise SystemExit("partial recovery authority checksum manifest is malformed")
    manifest[match.group(2)] = match.group(1)
if set(manifest) != set(authority_files):
    raise SystemExit("partial recovery authority manifest does not bind the exact file set")
for name, expected_digest in manifest.items():
    if sha256(authority_files[name]) != expected_digest:
        raise SystemExit(f"partial recovery authority checksum mismatch: {name}")


def exact_env(path, expected_keys, optional_keys=frozenset()):
    values = {}
    allowed_keys = expected_keys | optional_keys
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or "=" not in raw:
            raise SystemExit(f"{path.name} is malformed")
        key, value = raw.split("=", 1)
        if (
            not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", key)
            or key in values
            or key not in allowed_keys
        ):
            raise SystemExit(f"{path.name} has an unexpected or duplicate key")
        values[key] = value
    if not expected_keys.issubset(values):
        raise SystemExit(f"{path.name} key set is incomplete")
    return values


authority = exact_env(
    authority_files["partial-recovery-authority.env"],
    {
        "schema",
        "recovery_workflow",
        "recovery_run_id",
        "recovery_run_attempt",
        "recovery_head_sha",
        "source_rollback_run_id",
        "target_sha",
        "restored_source_sha",
        "restored_build_workflow",
        "restored_build_run_id",
        "restored_build_run_attempt",
        "restored_build_artifact",
        "infrastructure_run_id",
        "infrastructure_run_attempt",
        "infrastructure_provenance_sha256",
        "runtime_mode",
        "runtime_fingerprint",
        "registry_provider",
        "registry_host",
        "registry_repository",
        "registry_public_anonymous",
        "public_host",
        "canonical_host",
        "redirect_host",
        "diagnostic_host",
        "images_sha256",
        "final_state_sha256",
        "recovery_plan_sha256",
        "recovery_rollout_order_sha256",
        "recovery_summary_sha256",
        "rollback_readiness_summary_sha256",
        "rollback_readiness_workload_sha256",
        "rollback_readiness_failures_sha256",
        "database_restore",
        "status",
    },
)
if (
    authority["schema"] != "betstan.partial-rollback-recovery-authority.v1"
    or authority["recovery_workflow"] != "oci-production-rollback"
    or authority["recovery_run_attempt"] != "1"
    or authority["restored_build_workflow"] != "oci-production-build"
    or authority["restored_build_run_attempt"] != "1"
    or authority["database_restore"] != "disabled"
    or authority["status"] != "PASS"
):
    raise SystemExit("partial recovery authority identity is invalid")
for key in ("recovery_run_id", "source_rollback_run_id", "restored_build_run_id"):
    if not re.fullmatch(r"[1-9][0-9]*", authority[key]):
        raise SystemExit(f"partial recovery authority {key} is invalid")
if not re.fullmatch(r"[1-9][0-9]*", authority["infrastructure_run_id"]):
    raise SystemExit("partial recovery authority infrastructure run is invalid")
if authority["infrastructure_run_attempt"] != "1":
    raise SystemExit("partial recovery authority infrastructure run is not first attempt")
if authority["runtime_mode"] not in {"oke", "k3s"}:
    raise SystemExit("partial recovery authority runtime mode is invalid")
if (
    authority["registry_provider"] != "ghcr"
    or authority["registry_host"] != "ghcr.io"
    or authority["registry_repository"]
    != "ghcr.io/vasilyevstan/betstan-images"
    or authority["registry_public_anonymous"] != "true"
):
    raise SystemExit("partial recovery authority registry identity is invalid")
if authority["canonical_host"] != authority["public_host"]:
    raise SystemExit("partial recovery authority public host identity is invalid")
for key in ("public_host", "canonical_host", "redirect_host", "diagnostic_host"):
    if not re.fullmatch(r"[A-Za-z0-9.-]+", authority[key]):
        raise SystemExit(f"partial recovery authority {key} is invalid")
for key in ("recovery_head_sha", "target_sha", "restored_source_sha"):
    if not re.fullmatch(r"[0-9a-f]{40}", authority[key]):
        raise SystemExit(f"partial recovery authority {key} is invalid")
for key in (
    "infrastructure_provenance_sha256",
    "runtime_fingerprint",
    "images_sha256",
    "final_state_sha256",
    "recovery_plan_sha256",
    "recovery_rollout_order_sha256",
    "recovery_summary_sha256",
    "rollback_readiness_summary_sha256",
    "rollback_readiness_workload_sha256",
    "rollback_readiness_failures_sha256",
):
    if not re.fullmatch(r"[0-9a-f]{64}", authority[key]):
        raise SystemExit(f"partial recovery authority {key} is invalid")
if expected_run_id and authority["recovery_run_id"] != expected_run_id:
    raise SystemExit("partial recovery authority does not match the selected run")
if expected_source_sha and authority["restored_source_sha"] != expected_source_sha:
    raise SystemExit("partial recovery authority source does not match")
if expected_build_run_id and authority["restored_build_run_id"] != expected_build_run_id:
    raise SystemExit("partial recovery authority build does not match")
expected_build_artifact = (
    "oci-image-provenance-"
    f"{authority['restored_source_sha']}-"
    f"{authority['restored_build_run_id']}-1"
)
if authority["restored_build_artifact"] != expected_build_artifact:
    raise SystemExit("partial recovery authority build artifact identity is invalid")
if (
    expected_source_rollback_run_id
    and authority["source_rollback_run_id"] != expected_source_rollback_run_id
):
    raise SystemExit("partial recovery authority failed source run does not match")

hash_bindings = {
    "images_sha256": "images.tsv",
    "final_state_sha256": "final-state.tsv",
    "recovery_plan_sha256": "recovery-plan.tsv",
    "recovery_rollout_order_sha256": "recovery-rollout-order.tsv",
    "recovery_summary_sha256": "partial-recovery-summary.env",
    "rollback_readiness_summary_sha256": "rollback-readiness/summary.env",
    "rollback_readiness_workload_sha256": (
        "rollback-readiness/workload-state.tsv"
    ),
    "rollback_readiness_failures_sha256": "rollback-readiness/failures.txt",
}
for key, name in hash_bindings.items():
    if authority[key] != sha256(authority_files[name]):
        raise SystemExit(f"partial recovery authority hash differs: {name}")

summary = exact_env(
    authority_files["partial-recovery-summary.env"],
    {
        "status",
        "mode",
        "target_sha",
        "source_rollback_run_id",
        "recovered_services",
        "database_restore",
    },
    {"rollback_http_mutation_fence"},
)
summary_fence = summary.get(
    "rollback_http_mutation_fence",
    "legacy-not-recorded",
)
if (
    summary["status"] != "PASS"
    or summary["mode"] != "abort-partial-rollback"
    or summary["target_sha"] != authority["target_sha"]
    or summary["source_rollback_run_id"] != authority["source_rollback_run_id"]
    or summary["database_restore"] != "disabled"
    or summary_fence not in {"released", "not-required", "legacy-not-recorded"}
):
    raise SystemExit("partial recovery summary is invalid")


def tsv(path, width, allow_empty=False):
    with path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.reader(handle, delimiter="\t"))
    if (not rows and not allow_empty) or any(len(row) != width for row in rows):
        raise SystemExit(f"{path}: malformed TSV evidence")
    return rows


images = {}
for row in tsv(images_path, 5):
    service, row_repository, image_ref, manifest_digest, platform_digest = row
    if service in images or service not in services:
        raise SystemExit("partial recovery image service set is invalid")
    if (
        row_repository != repository
        or not digest_pattern.fullmatch(manifest_digest)
        or not digest_pattern.fullmatch(platform_digest)
        or image_ref != f"{repository}@{manifest_digest}"
    ):
        raise SystemExit("partial recovery images are not immutable GHCR provenance")
    images[service] = image_ref
if set(images) != services:
    raise SystemExit("partial recovery image provenance does not contain nine services")

final = {}
for row in tsv(authority_files["final-state.tsv"], 7):
    service, deployment, image_ref, desired, updated, ready, available = row
    if service in final or service not in services:
        raise SystemExit("partial recovery final-state service set is invalid")
    if (
        deployment != f"gaming-{service}-depl"
        or not image_pattern.fullmatch(image_ref)
        or image_ref != images.get(service)
    ):
        raise SystemExit(f"{service}: final state is not the restored build image")
    try:
        counts = tuple(map(int, (desired, updated, ready, available)))
    except ValueError as error:
        raise SystemExit(f"{service}: final readiness counts are invalid") from error
    if counts[0] < 1 or counts[1:] != (counts[0], counts[0], counts[0]):
        raise SystemExit(f"{service}: final deployment is not fully ready")
    final[service] = row
if set(final) != services:
    raise SystemExit("partial recovery final state does not contain nine services")

plan = tsv(authority_files["recovery-plan.tsv"], 4)
plan_services = []
for service, deployment, pre_image, partial_image in plan:
    if service in plan_services or service not in services:
        raise SystemExit("partial recovery plan service set is invalid")
    if (
        deployment != f"gaming-{service}-depl"
        or pre_image != images.get(service)
        or not image_pattern.fullmatch(partial_image)
        or pre_image == partial_image
    ):
        raise SystemExit(f"{service}: partial recovery plan is invalid")
    plan_services.append(service)
if summary["recovered_services"].split(" ") != plan_services:
    raise SystemExit("partial recovery summary service order differs from the plan")

rollout = tsv(authority_files["recovery-rollout-order.tsv"], 2)
if [row[0] for row in rollout] != plan_services:
    raise SystemExit("partial recovery rollout order differs from the plan")
if any(row[1] not in {"restored", "already-restored"} for row in rollout):
    raise SystemExit("partial recovery rollout status is invalid")

readiness = {}
for raw in authority_files["rollback-readiness/summary.env"].read_text(
    encoding="utf-8"
).splitlines():
    if not raw or "=" not in raw:
        raise SystemExit("partial recovery readiness summary is malformed")
    key, value = raw.split("=", 1)
    if (
        not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", key)
        or key in readiness
    ):
        raise SystemExit("partial recovery readiness summary has duplicate keys")
    readiness[key] = value
if (
    readiness.get("rollback_readiness") != "GO"
    or readiness.get("mode") != "application-rollback"
    or readiness.get("target_sha") != authority["target_sha"]
):
    raise SystemExit("partial recovery readiness decision is invalid")

workload = {}
for row in tsv(authority_files["rollback-readiness/workload-state.tsv"], 6):
    service, image_ref, desired, ready, updated, available = row
    if service in workload or service not in services:
        raise SystemExit("partial recovery readiness workload service set is invalid")
    if image_ref != images.get(service):
        raise SystemExit(f"{service}: readiness image differs from restored build")
    try:
        counts = tuple(map(int, (desired, ready, updated, available)))
    except ValueError as error:
        raise SystemExit(f"{service}: readiness counts are invalid") from error
    if counts[0] < 1 or counts[1:] != (counts[0], counts[0], counts[0]):
        raise SystemExit(f"{service}: readiness workload is not fully ready")
    workload[service] = row
if set(workload) != services:
    raise SystemExit("partial recovery readiness does not contain nine services")
if authority_files["rollback-readiness/failures.txt"].read_bytes():
    raise SystemExit("partial recovery readiness contains failures")

print(
    "partial_recovery_authority_validation=PASS "
    f"recovery_run_id={authority['recovery_run_id']} "
    f"source_sha={authority['restored_source_sha']} "
    f"build_run_id={authority['restored_build_run_id']}"
)
PY
