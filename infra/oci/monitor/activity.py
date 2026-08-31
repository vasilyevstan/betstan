#!/usr/bin/env python3
"""Classify GitHub production activity without granting maintenance implicitly."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from contracts import ContractError, canonical_json, load_policy, validate_operation


ACTIVE_STATUSES = {"queued", "in_progress", "waiting", "requested", "pending"}


def empty_activity(classification: str = "idle") -> dict[str, Any]:
    return {
        "classification": classification,
        "workflow_path": "",
        "run_id": 0,
        "run_attempt": 0,
        "control_sha": "",
        "target_sha": "",
        "phase": "",
        "repair_id": "",
        "expected_transient_codes": [],
    }


def classify(
    runs: list[dict[str, Any]],
    operation: dict[str, Any] | None,
    policy: dict[str, Any],
) -> dict[str, Any]:
    active = [
        run
        for run in runs
        if isinstance(run, dict)
        and run.get("status") in ACTIVE_STATUSES
        and run.get("path") in policy["maintenance"]
        and run.get("head_branch") == "master"
    ]
    if not active:
        return empty_activity()
    identities = {(run.get("id"), run.get("run_attempt")) for run in active}
    if len(active) != len(identities) or len(active) > 1:
        return empty_activity("unknown")
    run = active[0]
    run_id = run.get("id")
    attempt = run.get("run_attempt")
    if (
        isinstance(run_id, bool)
        or not isinstance(run_id, int)
        or run_id < 1
        or attempt != 1
    ):
        return empty_activity("unknown")
    queued = {
        "classification": "queued-production",
        "workflow_path": run["path"],
        "run_id": run_id,
        "run_attempt": attempt,
        "control_sha": str(run.get("head_sha", "")),
        "target_sha": str(run.get("head_sha", "")),
        "phase": "",
        "repair_id": "",
        "expected_transient_codes": [],
    }
    if operation is None:
        return queued
    try:
        validate_operation(operation, policy)
    except ContractError:
        return empty_activity("unknown")
    if operation["state"] != "active":
        return queued
    exact = (
        operation["workflow_path"] == run["path"]
        and operation["run_id"] == run_id
        and operation["run_attempt"] == attempt
        and operation["control_sha"] == run.get("head_sha")
    )
    if not exact:
        return empty_activity("unknown")
    return {
        "classification": "mutating-production",
        "workflow_path": operation["workflow_path"],
        "run_id": operation["run_id"],
        "run_attempt": operation["run_attempt"],
        "control_sha": operation["control_sha"],
        "target_sha": operation["target_sha"],
        "phase": operation["phase"],
        "repair_id": operation["repair_id"],
        "expected_transient_codes": operation["expected_transient_codes"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", required=True)
    parser.add_argument("--operation")
    parser.add_argument("--policy", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        runs = json.loads(Path(args.runs).read_text(encoding="utf-8"))
        if not isinstance(runs, list) or len(runs) > 100:
            raise ContractError("active production run list is malformed or unbounded")
        operation = None
        if args.operation and Path(args.operation).is_file():
            operation = json.loads(Path(args.operation).read_text(encoding="utf-8"))
        document = classify(runs, operation, load_policy(args.policy))
        Path(args.output).write_text(canonical_json(document) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError, ContractError) as error:
        print(f"production_activity=FAIL reason={error}", file=sys.stderr)
        return 1
    print(f"production_activity=PASS classification={document['classification']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
