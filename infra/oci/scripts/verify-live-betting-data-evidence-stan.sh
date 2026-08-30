#!/usr/bin/env bash
set -euo pipefail

EVIDENCE_DIR="${EVIDENCE_DIR:-${1:-}}"
EXPECTED_SOURCE_SHA="${EXPECTED_SOURCE_SHA:-}"
EXPECTED_BUILD_RUN_ID="${EXPECTED_BUILD_RUN_ID:-}"
EXPECTED_INFRASTRUCTURE_RUN_ID="${EXPECTED_INFRASTRUCTURE_RUN_ID:-}"
EXPECTED_PHASE="${EXPECTED_PHASE:-}"
EXPECTED_RUN_ID="${EXPECTED_RUN_ID:-}"
EXPECTED_RUN_ATTEMPT="${EXPECTED_RUN_ATTEMPT:-1}"
EXPECTED_BASELINE_RECOVERY_RUN_ID="${EXPECTED_BASELINE_RECOVERY_RUN_ID:-0}"
EXPECTED_BASELINE_RECOVERY_SOURCE_SHA="${EXPECTED_BASELINE_RECOVERY_SOURCE_SHA:-none}"
RESUME_BASELINE_DIR="${RESUME_BASELINE_DIR:-}"
RESOLVED_RESUME_AUTHORITY_FILE="${RESOLVED_RESUME_AUTHORITY_FILE:-}"
VERIFY_RESUME_APPLIED_RUN="${VERIFY_RESUME_APPLIED_RUN:-false}"
RESUME_REPOSITORY="${RESUME_REPOSITORY:-}"

fail() {
  echo "live_betting_data_evidence=FAIL reason=$*" >&2
  exit 1
}

[[ -d "$EVIDENCE_DIR" ]] || fail "evidence directory not found"
[[ "$EXPECTED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "expected source SHA must be complete lowercase hex"
[[ "$EXPECTED_BUILD_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "expected build run ID must be a positive integer"
[[ "$EXPECTED_INFRASTRUCTURE_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "expected infrastructure run ID must be a positive integer"
[[ "$EXPECTED_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "expected workflow run ID must be a positive integer"
[[ "$EXPECTED_RUN_ATTEMPT" == "1" ]] ||
  fail "only first-attempt evidence is accepted"
[[ "$EXPECTED_BASELINE_RECOVERY_RUN_ID" == "0" ||
   "$EXPECTED_BASELINE_RECOVERY_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "expected baseline recovery run ID is invalid"
if [[ "$EXPECTED_BASELINE_RECOVERY_RUN_ID" == "0" ]]; then
  [[ "$EXPECTED_BASELINE_RECOVERY_SOURCE_SHA" == "none" ]] ||
    fail "normal evidence cannot carry recovery source authority"
else
  [[ "$EXPECTED_BASELINE_RECOVERY_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    fail "expected recovery source SHA is invalid"
fi
if [[ -n "$RESUME_BASELINE_DIR" || -n "$RESOLVED_RESUME_AUTHORITY_FILE" ]]; then
  [[ -n "$RESUME_BASELINE_DIR" && -n "$RESOLVED_RESUME_AUTHORITY_FILE" ]] ||
    fail "resume baseline resolution requires both input and output paths"
fi
[[ "$VERIFY_RESUME_APPLIED_RUN" == "true" ||
   "$VERIFY_RESUME_APPLIED_RUN" == "false" ]] ||
  fail "VERIFY_RESUME_APPLIED_RUN must be true or false"
if [[ "$VERIFY_RESUME_APPLIED_RUN" == "true" ]]; then
  [[ -n "$RESOLVED_RESUME_AUTHORITY_FILE" ]] ||
    fail "resume applied-run verification requires resolved authority"
  [[ "$RESUME_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
    fail "RESUME_REPOSITORY is invalid"
fi
case "$EXPECTED_PHASE" in
  dry-run|apply-backfills|apply-slip-index) ;;
  *) fail "unexpected evidence phase" ;;
esac

python3 - "$EVIDENCE_DIR" \
  "$EXPECTED_SOURCE_SHA" \
  "$EXPECTED_BUILD_RUN_ID" \
  "$EXPECTED_INFRASTRUCTURE_RUN_ID" \
  "$EXPECTED_PHASE" \
  "$EXPECTED_RUN_ID" \
  "$EXPECTED_RUN_ATTEMPT" \
  "$EXPECTED_BASELINE_RECOVERY_RUN_ID" \
  "$EXPECTED_BASELINE_RECOVERY_SOURCE_SHA" \
  "$RESUME_BASELINE_DIR" \
  "$RESOLVED_RESUME_AUTHORITY_FILE" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve(strict=True)
expected = {
    "source_sha": sys.argv[2],
    "build_run_id": sys.argv[3],
    "infrastructure_run_id": sys.argv[4],
    "phase": sys.argv[5],
    "workflow_run_id": sys.argv[6],
    "workflow_run_attempt": sys.argv[7],
    "baseline_recovery_run_id": sys.argv[8],
    "baseline_recovery_source_sha": sys.argv[9],
}
resume_baseline_dir = sys.argv[10]
resolved_resume_authority_file = sys.argv[11]


def fail(message: str) -> None:
    raise SystemExit(message)


def read_env(path: Path, allowed=None) -> dict[str, str]:
    if not path.is_file() or path.is_symlink():
        fail(f"required evidence file is missing: {path.name}")
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not raw_line or "=" not in raw_line:
            fail(f"{path.name} line {line_number} is malformed")
        key, value = raw_line.split("=", 1)
        if allowed is not None and key not in allowed:
            fail(f"{path.name} contains unexpected key {key}")
        if key in values:
            fail(f"{path.name} contains duplicate key {key}")
        values[key] = value
    if allowed is not None and set(values) != allowed:
        fail(f"{path.name} does not contain the exact reviewed key set")
    return values


manifest_path = root / "SHA256SUMS"
if not manifest_path.is_file() or manifest_path.is_symlink():
    fail("SHA256SUMS is missing")

manifest_entries: dict[str, str] = {}
for line_number, line in enumerate(
    manifest_path.read_text(encoding="utf-8").splitlines(), start=1
):
    match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._/-]*)", line)
    if not match:
        fail(f"SHA256SUMS line {line_number} is malformed")
    digest, relative = match.groups()
    relative_path = Path(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        fail("SHA256SUMS contains an unsafe path")
    if relative == "SHA256SUMS" or relative in manifest_entries:
        fail("SHA256SUMS contains a duplicate or recursive entry")
    manifest_entries[relative] = digest

actual_files: set[str] = set()
for path in root.rglob("*"):
    if path.is_symlink():
        fail("evidence contains a symbolic link")
    if not path.is_file() or path == manifest_path:
        continue
    relative = path.relative_to(root).as_posix()
    actual_files.add(relative)
    observed = hashlib.sha256(path.read_bytes()).hexdigest()
    if manifest_entries.get(relative) != observed:
        fail(f"evidence digest mismatch for {relative}")

if actual_files != set(manifest_entries):
    fail("SHA256SUMS does not cover the exact evidence file set")

provenance_keys = {
    "schema_version",
    "source_sha",
    "build_run_id",
    "infrastructure_run_id",
    "baseline_sha256",
    "baseline_recovery_run_id",
    "baseline_recovery_source_sha",
    "workflow_run_id",
    "workflow_run_attempt",
    "phase",
    "status",
    "backfill_complete",
    "index_ready",
    "maintenance_fence_enforced",
    "writers_quiesced",
    "runtime_held_for_deploy",
    "operation_lock_enforced",
    "operation_lock_handoff",
    "completed_at",
}
provenance = read_env(root / "provenance.env", provenance_keys)
for key, value in expected.items():
    if provenance.get(key) != value:
        fail(f"provenance mismatch for {key}")
if provenance["schema_version"] != "live-betting-v1":
    fail("unexpected schema evidence version")
if provenance["status"] != "PASS":
    fail("data rollout did not complete successfully")
if provenance["backfill_complete"] not in {"true", "false"}:
    fail("backfill_complete is not boolean")
if provenance["index_ready"] not in {"true", "false"}:
    fail("index_ready is not boolean")
if not re.fullmatch(r"[0-9a-f]{64}", provenance["baseline_sha256"]):
    fail("baseline_sha256 is not a SHA-256 digest")
for key in (
    "maintenance_fence_enforced",
    "writers_quiesced",
    "runtime_held_for_deploy",
    "operation_lock_enforced",
    "operation_lock_handoff",
):
    if provenance[key] not in {"true", "false"}:
        fail(f"{key} is not boolean")
if provenance["operation_lock_enforced"] != "true":
    fail("phase was not covered by the shared database operation lock")
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", provenance["completed_at"]):
    fail("completed_at is not an exact UTC timestamp")

phase = expected["phase"]
resolved_applied_data_run_id = expected["workflow_run_id"]
resolved_applied_source_sha = expected["source_sha"]
resume_authority_path = root / "resume-authority.env"
if resume_authority_path.exists():
    if phase != "apply-slip-index":
        fail("only final data evidence may carry resume authority")
    resume_authority_keys = {
        "schema_version",
        "applied_data_run_id",
        "applied_source_sha",
        "failed_deploy_run_id",
        "resume_maintenance_mode",
        "failed_deploy_job_conclusion",
        "public_validate_job_conclusion",
        "release_step_conclusion",
        "rehold_step_conclusion",
        "failed_activation_run_id",
        "current_source_sha",
        "baseline_sha256",
        "runtime_images_sha256",
        "application_change_scope",
        "status",
    }
    resume_authority = read_env(resume_authority_path, resume_authority_keys)
    if resume_authority["schema_version"] != "live-betting-data-resume-v1":
        fail("unexpected live data resume authority version")
    if not re.fullmatch(r"[1-9][0-9]*", resume_authority["applied_data_run_id"]):
        fail("resume authority applied data run ID is invalid")
    if not re.fullmatch(r"[0-9a-f]{40}", resume_authority["applied_source_sha"]):
        fail("resume authority applied source SHA is invalid")
    if not re.fullmatch(r"[1-9][0-9]*", resume_authority["failed_deploy_run_id"]):
        fail("resume authority failed deploy run ID is invalid")
    failed_activation_run_id = resume_authority["failed_activation_run_id"]
    if failed_activation_run_id != "0" and not re.fullmatch(
        r"[1-9][0-9]*", failed_activation_run_id
    ):
        fail("resume authority failed activation run ID is invalid")
    if resume_authority["current_source_sha"] != expected["source_sha"]:
        fail("resume authority current source differs from data evidence")
    if resume_authority["baseline_sha256"] != provenance["baseline_sha256"]:
        fail("resume authority baseline digest differs from data evidence")
    if not re.fullmatch(
        r"[0-9a-f]{64}", resume_authority["runtime_images_sha256"]
    ):
        fail("resume authority runtime image digest is invalid")
    if resume_authority["application_change_scope"] != "github-infra-docs-only":
        fail("resume authority application change scope is invalid")
    if resume_authority["status"] != "PASS":
        fail("resume authority did not complete successfully")
    outcome = (
        resume_authority["failed_deploy_job_conclusion"],
        resume_authority["public_validate_job_conclusion"],
        resume_authority["release_step_conclusion"],
        resume_authority["rehold_step_conclusion"],
    )
    mode = resume_authority["resume_maintenance_mode"]
    if mode == "released-runtime":
        if outcome != ("success", "failure", "success", "skipped"):
            fail("released-runtime resume authority has an invalid outcome tuple")
    elif mode == "retained-hold":
        if outcome not in {
            ("failure", "skipped", "failure", "success"),
            ("failure", "skipped", "skipped", "success"),
        }:
            fail("retained-hold resume authority has an invalid outcome tuple")
    else:
        fail("resume authority maintenance mode is invalid")
    resolved_applied_data_run_id = resume_authority["applied_data_run_id"]
    resolved_applied_source_sha = resume_authority["applied_source_sha"]

resolved_output_path = None
if bool(resume_baseline_dir) != bool(resolved_resume_authority_file):
    fail("resume baseline resolution paths are inconsistent")
if resume_baseline_dir:
    if phase != "apply-slip-index":
        fail("resume baseline resolution requires final data evidence")
    baseline_input = Path(resume_baseline_dir)
    if baseline_input.is_symlink():
        fail("resume rollback baseline directory is invalid")
    baseline_root = baseline_input.resolve(strict=True)
    if not baseline_root.is_dir():
        fail("resume rollback baseline directory is invalid")
    if any(path.is_symlink() for path in baseline_root.rglob("*")):
        fail("resume rollback baseline contains a symbolic link")
    baseline_manifest = baseline_root / "SHA256SUMS"
    if not baseline_manifest.is_file() or baseline_manifest.is_symlink():
        fail("resume rollback baseline checksum manifest is missing")
    observed_baseline_sha256 = hashlib.sha256(
        baseline_manifest.read_bytes()
    ).hexdigest()
    if observed_baseline_sha256 != provenance["baseline_sha256"]:
        fail("resume rollback baseline digest differs from data evidence")
    baseline_provenance = read_env(baseline_root / "baseline-provenance.env")
    baseline_capture_run_id = baseline_provenance.get("baseline_capture_run_id", "")
    if baseline_capture_run_id != resolved_applied_data_run_id:
        fail(
            "resume rollback baseline capture run differs from the original "
            "applied data authority"
        )
    baseline_recovery_run_id = baseline_provenance.get(
        "baseline_recovery_run_id", "0"
    )
    if baseline_recovery_run_id != expected["baseline_recovery_run_id"]:
        fail("resume rollback baseline recovery authority differs from the selected run")

    output_path = Path(resolved_resume_authority_file)
    output_parent = output_path.parent.resolve(strict=True)
    output_path = output_parent / output_path.name
    if output_path.exists() and output_path.is_symlink():
        fail("resolved resume authority output is a symbolic link")
    if (
        output_path == root
        or root in output_path.parents
        or output_path == baseline_root
        or baseline_root in output_path.parents
    ):
        fail("resolved resume authority output must not modify input evidence")
    resolved_output_path = output_path

if phase in {"apply-backfills", "apply-slip-index"}:
    if provenance["backfill_complete"] != "true":
        fail("mutating phase did not prove completed backfills")
if phase == "apply-slip-index" and provenance["index_ready"] != "true":
    fail("final phase did not prove the Slip index")
if phase == "dry-run":
    expected_maintenance = {
        "maintenance_fence_enforced": "false",
        "writers_quiesced": "false",
        "runtime_held_for_deploy": "false",
        "operation_lock_handoff": "false",
    }
elif phase == "apply-backfills":
    expected_maintenance = {
        "maintenance_fence_enforced": "true",
        "writers_quiesced": "true",
        "runtime_held_for_deploy": "false",
        "operation_lock_handoff": "false",
    }
else:
    expected_maintenance = {
        "maintenance_fence_enforced": "true",
        "writers_quiesced": "true",
        "runtime_held_for_deploy": "true",
        "operation_lock_handoff": "true",
    }
for key, value in expected_maintenance.items():
    if provenance[key] != value:
        fail(f"phase has invalid maintenance state for {key}")

required_reports = {
    "dry-run": {
        *(f"reports/preflight-{service}.json" for service in (
            "event", "gamemaster", "moderation", "resulting", "bet", "slip"
        )),
        "reports/preflight-slip-index.json",
    },
    "apply-backfills": {
        *(f"reports/preflight-{service}.json" for service in (
            "event", "gamemaster", "moderation", "resulting", "bet", "slip"
        )),
        *(f"reports/apply-{service}.json" for service in (
            "event", "gamemaster", "moderation", "resulting", "bet", "slip"
        )),
        *(f"reports/verify-{service}.json" for service in (
            "event", "gamemaster", "moderation", "resulting", "bet", "slip"
        )),
        "reports/preflight-slip-index.json",
        "reports/final-slip-index.json",
    },
    "apply-slip-index": {
        *(f"reports/preflight-{service}.json" for service in (
            "event", "gamemaster", "moderation", "resulting", "bet", "slip"
        )),
        *(f"reports/apply-{service}.json" for service in (
            "event", "gamemaster", "moderation", "resulting", "bet", "slip"
        )),
        *(f"reports/verify-{service}.json" for service in (
            "event", "gamemaster", "moderation", "resulting", "bet", "slip"
        )),
        "reports/preflight-slip-index.json",
        "reports/final-slip-index.json",
        "reports/apply-slip-index.json",
        "reports/verify-slip-index.json",
    },
}[phase]
if not required_reports.issubset(actual_files):
    fail("phase evidence is missing required sanitized reports")

banned_keys = {"duplicateDrafts", "userId", "slipIds", "mongoUri", "MONGO_URI"}


def inspect_json(value: object) -> None:
    if isinstance(value, dict):
        if banned_keys.intersection(value):
            fail("evidence contains an unsanitized sensitive field")
        for child in value.values():
            inspect_json(child)
    elif isinstance(value, list):
        for child in value:
            inspect_json(child)
    elif isinstance(value, str) and "mongodb://" in value.lower():
        fail("evidence contains a Mongo connection string")


for relative in sorted(actual_files):
    if not relative.endswith(".json"):
        continue
    try:
        payload = json.loads((root / relative).read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"{relative} is not valid JSON: {exc}")
    inspect_json(payload)

journal = json.loads((root / "journal.json").read_text(encoding="utf-8"))
for key, value in expected.items():
    if str(journal.get(key, "")) != value:
        fail(f"journal mismatch for {key}")
if journal.get("status") != "PASS":
    fail("journal does not record a successful phase")
if journal.get("baseline_sha256") != provenance["baseline_sha256"]:
    fail("journal baseline digest differs from provenance")
for key in (
    "maintenance_fence_enforced",
    "writers_quiesced",
    "runtime_held_for_deploy",
    "operation_lock_enforced",
    "operation_lock_handoff",
):
    if journal.get(key) is not (provenance[key] == "true"):
        fail(f"journal maintenance state differs from provenance for {key}")

if phase == "apply-slip-index":
    schema_keys = {
        "schema_version",
        "source_sha",
        "build_run_id",
        "infrastructure_run_id",
        "baseline_sha256",
        "baseline_recovery_run_id",
        "baseline_recovery_source_sha",
        "data_run_id",
        "data_run_attempt",
        "backfill_complete",
        "index_ready",
        "maintenance_fence_enforced",
        "writers_quiesced",
        "runtime_held_for_deploy",
        "operation_lock_enforced",
        "operation_lock_handoff",
    }
    schema = read_env(root / "schema.env", schema_keys)
    required_schema = {
        "schema_version": "live-betting-v1",
        "source_sha": expected["source_sha"],
        "build_run_id": expected["build_run_id"],
        "infrastructure_run_id": expected["infrastructure_run_id"],
        "baseline_sha256": provenance["baseline_sha256"],
        "baseline_recovery_run_id": expected["baseline_recovery_run_id"],
        "baseline_recovery_source_sha": expected["baseline_recovery_source_sha"],
        "data_run_id": expected["workflow_run_id"],
        "data_run_attempt": expected["workflow_run_attempt"],
        "backfill_complete": "true",
        "index_ready": "true",
        "maintenance_fence_enforced": "true",
        "writers_quiesced": "true",
        "runtime_held_for_deploy": "true",
        "operation_lock_enforced": "true",
        "operation_lock_handoff": "true",
    }
    if schema != required_schema:
        fail("schema.env does not bind final readiness to the exact rollout")
elif (root / "schema.env").exists():
    fail("non-final phase must not emit schema.env")

if resolved_output_path is not None:
    resolved_output_path.write_text(
        "\n".join(
            (
                "schema_version=live-betting-data-resume-resolution-v1",
                f"prerequisite_data_run_id={expected['workflow_run_id']}",
                f"prerequisite_source_sha={expected['source_sha']}",
                f"applied_data_run_id={resolved_applied_data_run_id}",
                f"applied_source_sha={resolved_applied_source_sha}",
                f"baseline_sha256={provenance['baseline_sha256']}",
            )
        )
        + "\n",
        encoding="utf-8",
    )
PY

if [[ "$VERIFY_RESUME_APPLIED_RUN" == "true" ]]; then
  command -v gh >/dev/null 2>&1 ||
    fail "gh is required to verify the original applied data run"
  command -v jq >/dev/null 2>&1 ||
    fail "jq is required to verify the original applied data run"
  resolved_value() {
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
    ' "$RESOLVED_RESUME_AUTHORITY_FILE"
  }
  applied_data_run_id="$(resolved_value applied_data_run_id)"
  applied_source_sha="$(resolved_value applied_source_sha)"
  [[ "$applied_data_run_id" =~ ^[1-9][0-9]*$ ]] ||
    fail "resolved applied data run ID is invalid"
  [[ "$applied_source_sha" =~ ^[0-9a-f]{40}$ ]] ||
    fail "resolved applied source SHA is invalid"
  workflow_id="$(
    gh api \
      "repos/$RESUME_REPOSITORY/actions/workflows/oci-live-data-rollout.yml" |
      jq -er '.id | select(type == "number" and . > 0)'
  )"
  gh api \
    "repos/$RESUME_REPOSITORY/actions/runs/$applied_data_run_id/attempts/1" |
    jq -e \
      --argjson workflow_id "$workflow_id" \
      --argjson run_id "$applied_data_run_id" \
      --arg repository "$RESUME_REPOSITORY" \
      --arg source_sha "$applied_source_sha" '
        .id == $run_id and
        .workflow_id == $workflow_id and
        .path == ".github/workflows/oci-live-data-rollout.yml" and
        .event == "workflow_dispatch" and
        .head_sha == $source_sha and
        .head_branch == "master" and
        .head_repository.full_name == $repository and
        .status == "completed" and
        .conclusion == "success" and
        .run_attempt == 1 and
        .display_title == ("oci-live-data apply-slip-index " + $source_sha)
      ' >/dev/null ||
    fail "original applied data run does not match the resolved source authority"
fi

echo "live_betting_data_evidence=PASS phase=$EXPECTED_PHASE"
