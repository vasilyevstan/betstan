#!/usr/bin/env python3
"""Read bounded GitHub state used by the production monitor."""

from __future__ import annotations

import argparse
import io
import json
import os
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

from activity import classify, empty_activity
from contracts import ContractError, canonical_json, load_policy
from detector import validate_artifact


API_ROOT = "https://api.github.com"
ACTIVE_STATUSES = {"queued", "in_progress", "waiting", "requested", "pending"}
MAX_API_BYTES = 1024 * 1024
MAX_ARCHIVE_BYTES = 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def _token() -> str:
    value = os.environ.get("GITHUB_TOKEN", "")
    if not value or len(value) > 500:
        raise ContractError("GitHub monitor token is unavailable")
    return value


def _bounded_read(response, maximum: int) -> bytes:
    payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise ContractError("GitHub response exceeded its size limit")
    return payload


def _api_request(path: str, *, allow_redirect: bool = False):
    if not path.startswith("/"):
        raise ContractError("GitHub API path is invalid")
    request = urllib.request.Request(
        f"{API_ROOT}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {_token()}",
            "User-Agent": "betstan-production-monitor/1",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    opener = (
        urllib.request.build_opener()
        if allow_redirect
        else urllib.request.build_opener(NoRedirect)
    )
    return opener.open(request, timeout=20)


def _api_json(path: str) -> dict[str, Any]:
    try:
        with _api_request(path) as response:
            payload = _bounded_read(response, MAX_API_BYTES)
    except (OSError, urllib.error.URLError) as error:
        raise ContractError("GitHub API request failed") from error
    try:
        document = json.loads(payload)
    except json.JSONDecodeError as error:
        raise ContractError("GitHub API returned malformed JSON") from error
    if not isinstance(document, dict):
        raise ContractError("GitHub API returned an unexpected document")
    return document


def _artifact_archive(path: str) -> bytes:
    try:
        with _api_request(path) as response:
            return _bounded_read(response, MAX_ARCHIVE_BYTES)
    except urllib.error.HTTPError as error:
        if error.code not in {301, 302, 303, 307, 308}:
            raise ContractError("GitHub artifact download failed") from error
        location = error.headers.get("Location", "")
    except (OSError, urllib.error.URLError) as error:
        raise ContractError("GitHub artifact download failed") from error
    parsed = urllib.parse.urlparse(location)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ContractError("GitHub artifact redirect is invalid")
    request = urllib.request.Request(
        location,
        headers={"User-Agent": "betstan-production-monitor/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return _bounded_read(response, MAX_ARCHIVE_BYTES)
    except (OSError, urllib.error.URLError) as error:
        raise ContractError("GitHub artifact payload is unavailable") from error


def _active_runs(repository: str, policy: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for workflow_path in sorted(policy["maintenance"]):
        workflow_name = urllib.parse.quote(Path(workflow_path).name, safe="")
        document = _api_json(
            f"/repos/{repository}/actions/workflows/{workflow_name}/runs"
            "?branch=master&per_page=20"
        )
        runs = document.get("workflow_runs")
        if not isinstance(runs, list) or len(runs) > 20:
            raise ContractError("GitHub workflow run list is malformed")
        for run in runs:
            if not isinstance(run, dict) or run.get("status") not in ACTIVE_STATUSES:
                continue
            result.append(
                {
                    "id": run.get("id"),
                    "run_attempt": run.get("run_attempt"),
                    "path": run.get("path"),
                    "status": run.get("status"),
                    "head_branch": run.get("head_branch"),
                    "head_sha": run.get("head_sha"),
                }
            )
    if len(result) > 100:
        raise ContractError("too many active production workflow runs")
    return result


def collect_activity(
    repository: str,
    policy_path: Path,
    deep_path: Path,
) -> dict[str, Any]:
    policy = load_policy(policy_path)
    operation = None
    try:
        deep = json.loads(deep_path.read_text(encoding="utf-8"))
        if isinstance(deep, dict) and isinstance(deep.get("production_operation"), dict):
            operation = deep["production_operation"]
    except (OSError, json.JSONDecodeError):
        pass
    try:
        return classify(_active_runs(repository, policy), operation, policy)
    except ContractError as error:
        print(f"production_activity=UNKNOWN reason={error}", file=sys.stderr)
        return empty_activity("unknown")


def _safe_artifact(
    archive: bytes,
    policy_path: Path,
    expected_run: dict[str, Any],
) -> dict[str, Any]:
    try:
        source = zipfile.ZipFile(io.BytesIO(archive))
    except zipfile.BadZipFile as error:
        raise ContractError("observation artifact archive is malformed") from error
    with source:
        entries = source.infolist()
        if sorted(item.filename for item in entries) != ["SHA256SUMS", "observation.json"]:
            raise ContractError("observation artifact archive file set is invalid")
        if source.testzip() is not None:
            raise ContractError("observation artifact archive checksum failed")
        if any(
            item.is_dir()
            or Path(item.filename).name != item.filename
            or stat.S_ISLNK((item.external_attr >> 16) & 0xFFFF)
            for item in entries
        ):
            raise ContractError("observation artifact archive contains an unsafe entry")
        if sum(item.file_size for item in entries) > MAX_ARCHIVE_BYTES:
            raise ContractError("observation artifact archive expands beyond its limit")
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            for name in ("observation.json", "SHA256SUMS"):
                (directory / name).write_bytes(source.read(name))
            document = validate_artifact(directory, policy_path)
    if (
        document["monitor_run_id"] != expected_run["id"]
        or document["monitor_run_attempt"] != expected_run["run_attempt"]
        or document["source_sha"] != expected_run["head_sha"]
    ):
        raise ContractError("observation artifact provenance does not match its run")
    return document


def _artifact_for_run(
    repository: str,
    run: dict[str, Any],
    policy_path: Path,
) -> tuple[dict[str, Any], bytes]:
    run_id = run["id"]
    artifacts = _api_json(f"/repos/{repository}/actions/runs/{run_id}/artifacts")
    items = artifacts.get("artifacts")
    if not isinstance(items, list) or len(items) > 100:
        raise ContractError("monitor artifact list is malformed")
    expected_name = f"oci-production-observation-{run_id}-1"
    matches = [
        item
        for item in items
        if isinstance(item, dict)
        and item.get("name") == expected_name
        and item.get("expired") is False
    ]
    if len(matches) != 1:
        raise ContractError("trusted monitor run has no unique observation artifact")
    artifact = matches[0]
    artifact_id = artifact.get("id")
    size = artifact.get("size_in_bytes")
    if (
        isinstance(artifact_id, bool)
        or not isinstance(artifact_id, int)
        or artifact_id < 1
        or isinstance(size, bool)
        or not isinstance(size, int)
        or size < 1
        or size > MAX_ARCHIVE_BYTES
    ):
        raise ContractError("observation artifact metadata is outside policy")
    archive = _artifact_archive(
        f"/repos/{repository}/actions/artifacts/{artifact_id}/zip"
    )
    return _safe_artifact(archive, policy_path, run), archive


def download_observation(
    repository: str,
    run_id: int,
    workflow_path: str,
    policy_path: Path,
    destination: Path,
    expected_sha: str,
) -> dict[str, Any]:
    run = _api_json(f"/repos/{repository}/actions/runs/{run_id}")
    repository_name = (run.get("head_repository") or {}).get("full_name")
    if (
        run.get("id") != run_id
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("run_attempt") != 1
        or run.get("head_branch") != "master"
        or run.get("head_sha") != expected_sha
        or run.get("path") != workflow_path
        or run.get("event") not in {"schedule", "workflow_dispatch"}
        or repository_name != repository
    ):
        raise ContractError("triggering monitor run provenance is invalid")
    document, archive = _artifact_for_run(repository, run, policy_path)
    if destination.exists() and (
        destination.is_symlink() or any(destination.iterdir())
    ):
        raise ContractError("observation destination is not empty")
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        for name in ("observation.json", "SHA256SUMS"):
            (destination / name).write_bytes(source.read(name))
    return document


def fetch_baselines(
    repository: str,
    workflow_path: str,
    destination: Path,
    policy_path: Path,
    limit: int,
    exclude_run_id: int,
) -> int:
    if limit < 1 or limit > 32:
        raise ContractError("baseline history limit is outside policy")
    workflow_name = urllib.parse.quote(Path(workflow_path).name, safe="")
    try:
        document = _api_json(
            f"/repos/{repository}/actions/workflows/{workflow_name}/runs"
            "?branch=master&per_page=50"
        )
    except ContractError as error:
        print(f"production_baselines=WARMING reason={error}", file=sys.stderr)
        destination.mkdir(parents=True, exist_ok=True)
        return 0
    runs = document.get("workflow_runs")
    if not isinstance(runs, list) or len(runs) > 50:
        raise ContractError("monitor workflow history is malformed")
    destination.mkdir(parents=True, exist_ok=True)
    accepted = 0
    for run in runs:
        if accepted >= limit or not isinstance(run, dict):
            break
        repository_name = (run.get("head_repository") or {}).get("full_name")
        if (
            run.get("id") == exclude_run_id
            or run.get("status") != "completed"
            or run.get("conclusion") != "success"
            or run.get("run_attempt") != 1
            or run.get("head_branch") != "master"
            or run.get("path") != workflow_path
            or repository_name != repository
            or run.get("event") not in {"schedule", "workflow_dispatch"}
        ):
            continue
        run_id = run.get("id")
        if isinstance(run_id, bool) or not isinstance(run_id, int) or run_id < 1:
            continue
        try:
            observation, _archive = _artifact_for_run(
                repository, run, policy_path
            )
        except ContractError as error:
            print(
                f"production_baseline=REJECTED run_id={run_id} reason={error}",
                file=sys.stderr,
            )
            continue
        target = destination / f"{run_id}.json"
        target.write_text(canonical_json(observation) + "\n", encoding="utf-8")
        accepted += 1
    return accepted


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subparsers = result.add_subparsers(dest="command", required=True)

    activity = subparsers.add_parser("collect-activity")
    activity.add_argument("--repository", required=True)
    activity.add_argument("--policy", required=True)
    activity.add_argument("--deep", required=True)
    activity.add_argument("--output", required=True)

    baselines = subparsers.add_parser("fetch-baselines")
    baselines.add_argument("--repository", required=True)
    baselines.add_argument("--workflow-path", required=True)
    baselines.add_argument("--policy", required=True)
    baselines.add_argument("--destination", required=True)
    baselines.add_argument("--limit", required=True, type=int)
    baselines.add_argument("--exclude-run-id", required=True, type=int)

    download = subparsers.add_parser("download-observation")
    download.add_argument("--repository", required=True)
    download.add_argument("--run-id", required=True, type=int)
    download.add_argument("--workflow-path", required=True)
    download.add_argument("--policy", required=True)
    download.add_argument("--destination", required=True)
    download.add_argument("--expected-sha", required=True)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "collect-activity":
            document = collect_activity(
                args.repository,
                Path(args.policy),
                Path(args.deep),
            )
            Path(args.output).write_text(
                canonical_json(document) + "\n", encoding="utf-8"
            )
            print(
                "production_activity=PASS "
                f"classification={document['classification']}"
            )
        elif args.command == "fetch-baselines":
            count = fetch_baselines(
                args.repository,
                args.workflow_path,
                Path(args.destination),
                Path(args.policy),
                args.limit,
                args.exclude_run_id,
            )
            print(f"production_baselines=PASS accepted={count}")
        else:
            document = download_observation(
                args.repository,
                args.run_id,
                args.workflow_path,
                Path(args.policy),
                Path(args.destination),
                args.expected_sha,
            )
            print(
                "production_observation_download=PASS "
                f"run_id={document['monitor_run_id']}"
            )
    except (ContractError, OSError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        print(f"production_github_observer=FAIL reason={error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
