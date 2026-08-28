#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

BASELINE_DIR="${BASELINE_DIR:-${1:-}}"
EXPECTED_SOURCE_SHA="${EXPECTED_SOURCE_SHA:-}"
EXPECTED_NAMESPACE="${EXPECTED_NAMESPACE:-}"
EXPECTED_RECOVERY_RUN_ID="${EXPECTED_RECOVERY_RUN_ID:-}"
REQUIRE_CURRENT_DEPLOY_PROVENANCE="${REQUIRE_CURRENT_DEPLOY_PROVENANCE:-false}"
ALLOW_LOCAL_CAPTURE="${ALLOW_LOCAL_CAPTURE:-false}"

[[ -n "$BASELINE_DIR" && -d "$BASELINE_DIR" && ! -L "$BASELINE_DIR" ]] ||
  oci_die "BASELINE_DIR must be a regular directory"
oci_require_command python3

python3 - \
  "$BASELINE_DIR" \
  "$EXPECTED_SOURCE_SHA" \
  "$EXPECTED_NAMESPACE" \
  "$EXPECTED_RECOVERY_RUN_ID" \
  "$REQUIRE_CURRENT_DEPLOY_PROVENANCE" \
  "$ALLOW_LOCAL_CAPTURE" <<'PY'
import hashlib
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
(
    expected_source_sha,
    expected_namespace,
    expected_recovery_run_id,
    require_current_deploy_provenance,
    allow_local_capture,
) = sys.argv[2:7]
if require_current_deploy_provenance not in ("true", "false"):
    raise SystemExit("REQUIRE_CURRENT_DEPLOY_PROVENANCE must be true or false")
if allow_local_capture not in ("true", "false"):
    raise SystemExit("ALLOW_LOCAL_CAPTURE must be true or false")
services = {
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip",
}
repository = "ghcr.io/vasilyevstan/betstan-images"
digest_pattern = re.compile(r"sha256:[0-9a-f]{64}")
required_files = {
    "baseline-provenance.env",
    "images.tsv",
    "live-images.tsv",
    "queues.tsv",
}

if any(path.is_symlink() for path in root.rglob("*")):
    raise SystemExit("rollback baseline contains a symlink")
manifest_path = root / "SHA256SUMS"
if not manifest_path.is_file() or manifest_path.is_symlink():
    raise SystemExit("rollback baseline checksum manifest is missing")
manifest = {}
for raw in manifest_path.read_text(encoding="utf-8").splitlines():
    match = re.fullmatch(
        r"([0-9a-f]{64})  ((?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+)",
        raw,
    )
    if not match or match.group(2) in manifest:
        raise SystemExit("rollback baseline checksum manifest is malformed")
    manifest[match.group(2)] = match.group(1)
if not required_files.issubset(manifest):
    raise SystemExit("rollback baseline checksum manifest omits required evidence")
for name, expected_digest in manifest.items():
    path = root / name
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"rollback baseline evidence is missing: {name}")
    actual_digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual_digest != expected_digest:
        raise SystemExit(f"rollback baseline checksum mismatch: {name}")


def env_file(name):
    values = {}
    for raw in (root / name).read_text(encoding="utf-8").splitlines():
        if not raw or "=" not in raw:
            raise SystemExit(f"{name} is malformed")
        key, value = raw.split("=", 1)
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", key) or key in values:
            raise SystemExit(f"{name} has invalid or duplicate keys")
        values[key] = value
    return values


baseline = env_file("baseline-provenance.env")
for key in (
    "baseline_source_sha",
    "baseline_deploy_workflow",
    "baseline_deploy_run_id",
    "baseline_deploy_run_attempt",
    "baseline_build_workflow",
    "baseline_build_run_id",
    "baseline_build_run_attempt",
    "baseline_capture_run_id",
    "baseline_capture_run_attempt",
    "namespace",
    "database_restore",
    "registry_provider",
    "registry_host",
    "registry_repository",
    "registry_public_anonymous",
):
    if not baseline.get(key):
        raise SystemExit(f"rollback baseline provenance is missing {key}")
source_sha = baseline["baseline_source_sha"]
if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
    raise SystemExit("rollback baseline source SHA is invalid")
if expected_source_sha and source_sha != expected_source_sha:
    raise SystemExit("rollback baseline source SHA does not match the expected source")
if expected_namespace and baseline["namespace"] != expected_namespace:
    raise SystemExit("rollback baseline namespace does not match the expected namespace")
if (
    baseline["baseline_deploy_run_attempt"] != "1"
    or baseline["baseline_build_workflow"] != "oci-production-build"
    or baseline["baseline_build_run_attempt"] != "1"
    or baseline["baseline_capture_run_attempt"] != "1"
    or not re.fullmatch(r"[1-9][0-9]*", baseline["baseline_deploy_run_id"])
    or not re.fullmatch(r"[1-9][0-9]*", baseline["baseline_build_run_id"])
    or (
        not re.fullmatch(r"[1-9][0-9]*", baseline["baseline_capture_run_id"])
        and not (
            allow_local_capture == "true"
            and baseline["baseline_capture_run_id"] == "local"
        )
    )
):
    raise SystemExit("rollback baseline workflow provenance is not exact first-attempt evidence")
if baseline["database_restore"] != "disabled":
    raise SystemExit("rollback baseline attempts to authorize database restoration")
if (
    baseline["registry_provider"] != "ghcr"
    or baseline["registry_host"] != "ghcr.io"
    or baseline["registry_repository"] != repository
    or baseline["registry_public_anonymous"] != "true"
):
    raise SystemExit("rollback baseline does not identify the public GHCR registry")

images = {}
for raw in (root / "images.tsv").read_text(encoding="utf-8").splitlines():
    fields = raw.split("\t")
    if len(fields) != 5:
        raise SystemExit("rollback image provenance must contain five columns")
    service, row_repository, image_ref, manifest_digest, platform_digest = fields
    if service in images or service not in services:
        raise SystemExit("rollback image provenance service set is invalid")
    if (
        row_repository != repository
        or not digest_pattern.fullmatch(manifest_digest)
        or not digest_pattern.fullmatch(platform_digest)
        or image_ref != f"{repository}@{manifest_digest}"
    ):
        raise SystemExit("rollback image provenance is not an immutable GHCR reference")
    images[service] = image_ref
if set(images) != services:
    raise SystemExit("rollback image provenance does not contain exactly nine services")

live_images = {}
for raw in (root / "live-images.tsv").read_text(encoding="utf-8").splitlines():
    fields = raw.split("\t")
    if len(fields) != 2:
        raise SystemExit("rollback live-image evidence must contain two columns")
    service, image_ref = fields
    if service in live_images or service not in services:
        raise SystemExit("rollback live-image service set is invalid")
    if image_ref != images.get(service):
        raise SystemExit("rollback live-image evidence differs from GHCR provenance")
    live_images[service] = image_ref
if set(live_images) != services:
    raise SystemExit("rollback live-image evidence does not contain exactly nine services")

deploy_workflow = baseline["baseline_deploy_workflow"]
recovery_run_id = baseline.get("baseline_recovery_run_id", "0")
recovery_attempt = baseline.get("baseline_recovery_run_attempt", "0")
transition_file = baseline.get("baseline_transition_provenance_file", "none")
if expected_recovery_run_id and recovery_run_id != expected_recovery_run_id:
    raise SystemExit("rollback baseline recovery authority differs from the selected run")
if deploy_workflow == "oci-production-deploy":
    if (
        recovery_run_id not in ("", "0")
        or recovery_attempt not in ("", "0")
        or transition_file not in ("", "none")
    ):
        raise SystemExit("ordinary rollback baseline carries recovery authority")
    provenance_name = "trusted-deploy-provenance.txt"
    if provenance_name not in manifest:
        if require_current_deploy_provenance == "true":
            raise SystemExit("ordinary rollback baseline omits trusted deploy provenance")
    else:
        deploy = env_file(provenance_name)
        workflow = deploy.get("deployment_workflow", "")
        if require_current_deploy_provenance == "true" and workflow != "oci-production-deploy":
            raise SystemExit("ordinary rollback baseline omits current deploy-workflow provenance")
        if workflow not in ("", "oci-production-deploy"):
            raise SystemExit("ordinary rollback baseline deploy workflow is not trusted")
        if (
            deploy.get("source_sha") != source_sha
            or deploy.get("deployment_run_id") != baseline["baseline_deploy_run_id"]
            or deploy.get("deployment_run_attempt") != "1"
            or deploy.get("registry_provider") != "ghcr"
            or deploy.get("registry_host") != "ghcr.io"
            or deploy.get("registry_repository") != repository
            or deploy.get("registry_public_anonymous") != "true"
            or deploy.get("image_provenance_sha256")
            != hashlib.sha256((root / "images.tsv").read_bytes()).hexdigest()
        ):
            raise SystemExit("ordinary rollback baseline deploy provenance is not exact GHCR evidence")
elif deploy_workflow == "oci-ghcr-cache-recovery":
    if (
        not re.fullmatch(r"[1-9][0-9]*", recovery_run_id)
        or recovery_run_id != baseline["baseline_deploy_run_id"]
        or recovery_attempt != "1"
        or transition_file != "trusted-recovery-transition-provenance.env"
        or transition_file not in manifest
    ):
        raise SystemExit("recovery rollback baseline does not bind exact recovery authority")
    transition = env_file(transition_file)
    if (
        transition.get("schema") != "betstan.ghcr-cache-recovery-transition.v1"
        or transition.get("transition_workflow") != "oci-ghcr-cache-recovery"
        or transition.get("transition_run_id") != recovery_run_id
        or transition.get("transition_run_attempt") != "1"
        or transition.get("source_sha") != source_sha
        or transition.get("registry_provider") != "ghcr"
        or transition.get("registry_host") != "ghcr.io"
        or transition.get("registry_repository") != repository
        or transition.get("registry_public_anonymous") != "true"
        or transition.get("credential_retirement") != "pass"
        or transition.get("ocir_repository_retirement") != "pass"
        or transition.get("transition_status") != "PASS"
        or transition.get("images_sha256")
        != hashlib.sha256((root / "images.tsv").read_bytes()).hexdigest()
    ):
        raise SystemExit("recovery rollback baseline transition provenance is invalid")
elif deploy_workflow == "oci-production-rollback":
    partial_files = {
        "partial-recovery/partial-recovery-authority.env",
        "partial-recovery/partial-recovery-SHA256SUMS",
        "partial-recovery/partial-recovery-summary.env",
        "partial-recovery/recovery-plan.tsv",
        "partial-recovery/recovery-rollout-order.tsv",
        "partial-recovery/final-state.tsv",
        "partial-recovery/rollback-readiness/summary.env",
        "partial-recovery/rollback-readiness/workload-state.tsv",
        "partial-recovery/rollback-readiness/failures.txt",
    }
    if (
        not re.fullmatch(r"[1-9][0-9]*", recovery_run_id)
        or recovery_run_id != baseline["baseline_deploy_run_id"]
        or recovery_attempt != "1"
        or transition_file
        != "partial-recovery/partial-recovery-authority.env"
        or not partial_files.issubset(manifest)
    ):
        raise SystemExit("partial recovery baseline does not bind exact recovery authority")
    authority = env_file(transition_file)
    if (
        authority.get("schema")
        != "betstan.partial-rollback-recovery-authority.v1"
        or authority.get("recovery_workflow") != "oci-production-rollback"
        or authority.get("recovery_run_id") != recovery_run_id
        or authority.get("recovery_run_attempt") != "1"
        or authority.get("restored_source_sha") != source_sha
        or authority.get("restored_build_workflow") != "oci-production-build"
        or authority.get("restored_build_run_id")
        != baseline["baseline_build_run_id"]
        or authority.get("restored_build_run_attempt") != "1"
        or authority.get("images_sha256")
        != hashlib.sha256((root / "images.tsv").read_bytes()).hexdigest()
        or authority.get("database_restore") != "disabled"
        or authority.get("status") != "PASS"
    ):
        raise SystemExit("partial recovery baseline authority is invalid")
else:
    raise SystemExit("rollback baseline deploy workflow is not trusted")
PY

baseline_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $1 == key {
      if (found++) exit 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (found != 1) exit 1
      print value
    }
  ' "$BASELINE_DIR/baseline-provenance.env"
}

baseline_optional_value() {
  local key="$1"
  local default_value="$2"
  awk -F= -v key="$key" -v default_value="$default_value" '
    $1 == key {
      if (found++) exit 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (found > 1) exit 1
      print (found == 1 ? value : default_value)
    }
  ' "$BASELINE_DIR/baseline-provenance.env"
}

source_sha="$(baseline_value baseline_source_sha)"
deploy_workflow="$(baseline_value baseline_deploy_workflow)"
recovery_run_id="$(baseline_optional_value baseline_recovery_run_id 0)"
if [[ "$deploy_workflow" == "oci-production-rollback" ]]; then
  PARTIAL_RECOVERY_DIR="$BASELINE_DIR/partial-recovery" \
  PARTIAL_RECOVERY_IMAGES_FILE="$BASELINE_DIR/images.tsv" \
  EXPECTED_RECOVERY_RUN_ID="$recovery_run_id" \
  EXPECTED_SOURCE_SHA="$source_sha" \
  EXPECTED_BUILD_RUN_ID="$(baseline_value baseline_build_run_id)" \
    "$SCRIPT_DIR/validate-partial-recovery-authority-stan.sh" >/dev/null
fi

printf 'rollback_baseline_validation=PASS source_sha=%s recovery_run_id=%s\n' \
  "$source_sha" "${recovery_run_id:-0}"
