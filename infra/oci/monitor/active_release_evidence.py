#!/usr/bin/env python3
"""Resolve the latest trusted active release and its exact image evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import stat
import sys
import tempfile
import urllib.parse
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from contracts import (
    ContractError,
    canonical_json,
    load_policy,
    parse_timestamp,
    validate_active_release,
)
from github_observer import (
    MAX_API_BYTES,
    _api_json,
    _artifact_archive,
    _artifact_for_run,
)
from production_state import image_digests


SOURCE_ARTIFACTS = {
    ".github/workflows/oci-production-deploy.yml": "oci-deploy-provenance-{run_id}-1",
    ".github/workflows/oci-production-rollback.yml": "oci-production-rollback-{run_id}-1",
    ".github/workflows/oci-production-repair-deploy.yml": (
        "oci-production-repair-deploy-{run_id}-1"
    ),
}
PRODUCTION_MUTATION_WORKFLOWS = (
    ".github/workflows/oci-infrastructure.yml",
    ".github/workflows/oci-live-betting-activate.yml",
    ".github/workflows/oci-live-betting-disable.yml",
    ".github/workflows/oci-live-data-rollout.yml",
    ".github/workflows/oci-migrate.yml",
    ".github/workflows/oci-ghcr-cache-recovery.yml",
    ".github/workflows/oci-production-deploy.yml",
    ".github/workflows/oci-production-repair-deploy.yml",
    ".github/workflows/oci-production-rollback.yml",
    ".github/workflows/oci-production-self-heal.yml",
)
PUBLISHED_RUN_CONCLUSIONS = {"success", "failure", "cancelled", "timed_out"}


def _trusted_observation(
    repository: str,
    policy_path: Path,
) -> dict[str, Any]:
    workflow = ".github/workflows/oci-production-monitor.yml"
    workflow_name = urllib.parse.quote(Path(workflow).name, safe="")
    document = _api_json(
        f"/repos/{repository}/actions/workflows/{workflow_name}/runs"
        "?branch=master&per_page=20"
    )
    runs = document.get("workflow_runs")
    if not isinstance(runs, list) or len(runs) > 20:
        raise ContractError("monitor workflow history is malformed")
    for run in runs:
        if not isinstance(run, dict):
            continue
        repository_name = (run.get("head_repository") or {}).get("full_name")
        if (
            run.get("status") != "completed"
            or run.get("conclusion") != "success"
            or run.get("run_attempt") != 1
            or run.get("head_branch") != "master"
            or run.get("path") != workflow
            or run.get("event") not in {"schedule", "workflow_dispatch"}
            or repository_name != repository
        ):
            continue
        try:
            observation, _archive = _artifact_for_run(repository, run, policy_path)
        except ContractError:
            continue
        return observation
    raise ContractError("no trusted monitor observation is available")


def _safe_images(archive: bytes, expected: dict[str, str]) -> bytes:
    try:
        source = zipfile.ZipFile(io.BytesIO(archive))
    except zipfile.BadZipFile as error:
        raise ContractError("active-release artifact archive is malformed") from error
    matches = []
    with source:
        entries = source.infolist()
        if not entries or len(entries) > 100 or source.testzip() is not None:
            raise ContractError("active-release artifact file set is invalid")
        if sum(item.file_size for item in entries) > MAX_API_BYTES * 5:
            raise ContractError("active-release artifact expands beyond its limit")
        for item in entries:
            path = PurePosixPath(item.filename)
            if (
                item.is_dir()
                or path.is_absolute()
                or ".." in path.parts
                or stat.S_ISLNK((item.external_attr >> 16) & 0xFFFF)
            ):
                raise ContractError("active-release artifact contains an unsafe entry")
            if path.name != "images.tsv":
                continue
            content = source.read(item)
            with tempfile.TemporaryDirectory() as directory_name:
                candidate = Path(directory_name) / "images.tsv"
                candidate.write_bytes(content)
                try:
                    digests = image_digests(candidate)
                except ContractError:
                    continue
            if digests == expected:
                matches.append(content)
    if len(matches) != 1:
        raise ContractError("active release has no unique matching image evidence")
    return matches[0]


def _validate_release_run(
    run: dict[str, Any],
    active: dict[str, Any],
    repository: str,
    observed_at: dt.datetime,
) -> None:
    repository_name = (run.get("head_repository") or {}).get("full_name")
    if (
        run.get("id") != active["run_id"]
        or run.get("path") != active["workflow_path"]
        or run.get("run_attempt") != 1
        or run.get("status") != "completed"
        or run.get("conclusion") not in PUBLISHED_RUN_CONCLUSIONS
        or run.get("head_branch") != "master"
        or repository_name != repository
    ):
        raise ContractError("active release workflow provenance is invalid")
    started_at = parse_timestamp(
        run.get("run_started_at") or run.get("created_at"),
        "active release workflow start",
    )
    completed_at = parse_timestamp(
        run.get("updated_at"),
        "active release workflow completion",
    )
    validated_at = parse_timestamp(active["validated_at"], "active release validation")
    if (
        completed_at < started_at
        or validated_at < started_at
        or validated_at > completed_at
        or completed_at > observed_at
        or validated_at > observed_at
    ):
        raise ContractError("active release publication is outside its workflow execution")


def _reject_newer_production_runs(
    repository: str,
    observed_at: dt.datetime,
    current: dt.datetime,
    exclude_run_id: int | None,
) -> None:
    for workflow in PRODUCTION_MUTATION_WORKFLOWS:
        workflow_name = urllib.parse.quote(Path(workflow).name, safe="")
        document = _api_json(
            f"/repos/{repository}/actions/workflows/{workflow_name}/runs"
            "?branch=master&per_page=5"
        )
        runs = document.get("workflow_runs")
        if not isinstance(runs, list) or len(runs) > 5:
            raise ContractError("production workflow history is malformed")
        for run in runs:
            if not isinstance(run, dict):
                raise ContractError("production workflow run is malformed")
            run_id = run.get("id")
            if (
                isinstance(run_id, bool)
                or not isinstance(run_id, int)
                or run_id < 1
                or run.get("path") != workflow
                or (run.get("head_repository") or {}).get("full_name") != repository
            ):
                raise ContractError("production workflow identity is malformed")
            if run_id == exclude_run_id:
                continue
            for field in ("run_started_at", "updated_at"):
                value = run.get(field)
                if value is None and field == "run_started_at":
                    value = run.get("created_at")
                instant = parse_timestamp(value, f"production run {field}")
                if instant > current:
                    raise ContractError("production workflow history is future-dated")
                if instant > observed_at:
                    raise ContractError(
                        "production workflow changed after the selected observation"
                    )


def resolve(
    repository: str,
    policy_path: Path,
    destination: Path,
    *,
    now: dt.datetime | None = None,
    exclude_run_id: int | None = None,
) -> dict[str, Any]:
    policy = load_policy(policy_path)
    observation = _trusted_observation(repository, policy_path)
    observed_at = parse_timestamp(observation.get("observed_at"), "observation time")
    current = now or dt.datetime.now(dt.timezone.utc)
    if observed_at > current:
        raise ContractError("latest trusted monitor observation is future-dated")
    if current - observed_at > dt.timedelta(
        seconds=policy["observation"]["maximum_gap_seconds"]
    ):
        raise ContractError("latest trusted monitor observation is stale")
    _reject_newer_production_runs(
        repository,
        observed_at,
        current,
        exclude_run_id,
    )
    operation = observation.get("production_operation")
    if isinstance(operation, dict) and operation.get("state") == "active":
        raise ContractError("another production operation is active")
    active = validate_active_release(observation.get("active_release"))
    artifact_pattern = SOURCE_ARTIFACTS.get(active["workflow_path"])
    if artifact_pattern is None:
        raise ContractError("active release workflow has no repair baseline adapter")
    run = _api_json(
        f"/repos/{repository}/actions/runs/{active['run_id']}/attempts/1"
    )
    if not isinstance(run, dict):
        raise ContractError("active release workflow provenance is invalid")
    _validate_release_run(run, active, repository, observed_at)
    if active["workflow_path"] == ".github/workflows/oci-production-rollback.yml":
        if run.get("display_title") != f"oci-rollback {active['source_sha']}":
            raise ContractError("rollback active release title is inconsistent")
    elif run.get("head_sha") != active["source_sha"]:
        raise ContractError("active release source differs from its workflow")
    artifacts = _api_json(
        f"/repos/{repository}/actions/runs/{active['run_id']}/artifacts?per_page=100"
    )
    items = artifacts.get("artifacts")
    if not isinstance(items, list) or len(items) >= 100:
        raise ContractError("active release artifact list is malformed or unbounded")
    expected_name = artifact_pattern.format(run_id=active["run_id"])
    matches = [
        item
        for item in items
        if isinstance(item, dict)
        and item.get("name") == expected_name
        and item.get("expired") is False
    ]
    if len(matches) != 1:
        raise ContractError("active release has no unique provenance artifact")
    artifact_id = matches[0].get("id")
    size = matches[0].get("size_in_bytes")
    if (
        isinstance(artifact_id, bool)
        or not isinstance(artifact_id, int)
        or artifact_id < 1
        or isinstance(size, bool)
        or not isinstance(size, int)
        or size < 1
        or size > MAX_API_BYTES * 5
    ):
        raise ContractError("active release artifact metadata is outside policy")
    images = _safe_images(
        _artifact_archive(
            f"/repos/{repository}/actions/artifacts/{artifact_id}/zip"
        ),
        active["image_digests"],
    )
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "active-release.json").write_text(
        canonical_json(active) + "\n", encoding="utf-8"
    )
    (destination / "images.tsv").write_bytes(images)
    result = {
        "schema": "betstan.active-release-evidence.v1",
        "source_sha": active["source_sha"],
        "release_generation": active["generation"],
        "release_workflow_path": active["workflow_path"],
        "release_run_id": active["run_id"],
        "infrastructure_run_id": active["infrastructure_run_id"],
        "images_sha256": __import__("hashlib").sha256(images).hexdigest(),
        "observed_at": observation["observed_at"],
    }
    (destination / "evidence.json").write_text(
        canonical_json(result) + "\n", encoding="utf-8"
    )
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--exclude-run-id", type=int)
    args = parser.parse_args()
    try:
        result = resolve(
            args.repository,
            Path(args.policy),
            Path(args.destination),
            exclude_run_id=args.exclude_run_id,
        )
    except (ContractError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"active_release_evidence=FAIL reason={error}", file=sys.stderr)
        return 1
    print(
        "active_release_evidence=PASS "
        f"source_sha={result['source_sha']} generation={result['release_generation']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
