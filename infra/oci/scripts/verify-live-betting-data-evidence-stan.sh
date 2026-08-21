#!/usr/bin/env bash
set -euo pipefail

EVIDENCE_DIR="${EVIDENCE_DIR:-${1:-}}"
EXPECTED_SOURCE_SHA="${EXPECTED_SOURCE_SHA:-}"
EXPECTED_BUILD_RUN_ID="${EXPECTED_BUILD_RUN_ID:-}"
EXPECTED_INFRASTRUCTURE_RUN_ID="${EXPECTED_INFRASTRUCTURE_RUN_ID:-}"
EXPECTED_PHASE="${EXPECTED_PHASE:-}"
EXPECTED_RUN_ID="${EXPECTED_RUN_ID:-}"
EXPECTED_RUN_ATTEMPT="${EXPECTED_RUN_ATTEMPT:-1}"

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
  "$EXPECTED_RUN_ATTEMPT" <<'PY'
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
}


def fail(message: str) -> None:
    raise SystemExit(message)


def read_env(path: Path, allowed: set[str]) -> dict[str, str]:
    if not path.is_file() or path.is_symlink():
        fail(f"required evidence file is missing: {path.name}")
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not raw_line or "=" not in raw_line:
            fail(f"{path.name} line {line_number} is malformed")
        key, value = raw_line.split("=", 1)
        if key not in allowed:
            fail(f"{path.name} contains unexpected key {key}")
        if key in values:
            fail(f"{path.name} contains duplicate key {key}")
        values[key] = value
    if set(values) != allowed:
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
PY

echo "live_betting_data_evidence=PASS phase=$EXPECTED_PHASE"
