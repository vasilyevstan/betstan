#!/usr/bin/env python3
"""Verify the one fixed held-baseline incident restoration manifest."""

from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
from typing import Any
import zipfile


MANIFEST_RELATIVE_PATH = Path("infra/oci/incident/manifest.json")
IMAGE_INPUT_COMPARATOR = Path("infra/oci/scripts/compare-image-inputs.sh")
MAX_MANIFEST_BYTES = 16 * 1024
MAX_API_REQUESTS = 24
MAX_API_JSON_BYTES = 1024 * 1024
MAX_API_RESPONSE_BYTES = MAX_API_JSON_BYTES + 64 * 1024
MAX_ARCHIVE_FILES = 128
MAX_ARCHIVE_FILE_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_TOTAL_BYTES = 8 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
SHA_RE = re.compile(r"[0-9a-f]{40}")
DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}")
RAW_DIGEST_RE = re.compile(r"[0-9a-f]{64}")
POSITIVE_INT_RE = re.compile(r"[1-9][0-9]*")
SAFE_FILE_RE = re.compile(r"[A-Za-z0-9._/-]+")

FIXED_TOP_LEVEL = {
    "schemaVersion": "betstan.oci-live-data-incident-restore.v1",
    "operation": "oci-live-data-incident-restore",
    "repository": "vasilyevstan/betstan",
    "workflow": ".github/workflows/oci-live-data-rollout.yml",
    "environment": "oci-migration",
    "confirmation": "RESTORE AUTHENTICATED HELD BASELINE EXACT SHA",
    "baseControlSha": "55d9e9704fc981a66b601c8252187b317d22ea38",
}
FIXED_HELD_OWNER = {
    "runId": 39945618182,
    "workflowId": 339733789,
    "workflow": ".github/workflows/oci-live-data-rollout.yml",
    "event": "workflow_dispatch",
    "headBranch": "master",
    "headSha": "70679a6179df2167cb39f185cb0c26dca2ce649d",
    "status": "completed",
    "conclusion": "success",
    "runAttempt": 1,
    "createdAt": "2026-10-23T11:22:28Z",
    "updatedAt": "2026-10-23T13:30:40Z",
}
FIXED_IMAGE_BUILD = {
    "runId": 37576331905,
    "workflowId": 325229376,
    "workflow": ".github/workflows/oci-production-build.yml",
    "event": "workflow_run",
    "headBranch": "master",
    "headSha": "1bf86112ba2458161e6039091b1aa6289fdfce1d",
    "status": "completed",
    "conclusion": "success",
    "runAttempt": 1,
    "createdAt": "2026-10-07T05:26:43Z",
    "updatedAt": "2026-10-07T05:37:02Z",
}
FIXED_INFRASTRUCTURE = {
    "runId": 37582984293,
    "workflowId": 325223330,
    "workflow": ".github/workflows/oci-infrastructure.yml",
    "event": "workflow_dispatch",
    "headBranch": "master",
    "headSha": "1bf86112ba2458161e6039091b1aa6289fdfce1d",
    "status": "completed",
    "conclusion": "success",
    "runAttempt": 1,
    "createdAt": "2026-10-07T06:42:16Z",
    "updatedAt": "2026-10-07T06:59:55Z",
}
FIXED_ROLLOUT_ARTIFACT = {
    "artifactId": 12505156215,
    "name": "oci-live-data-rollout-39945618182-1",
    "digest": "sha256:652b2f5f7ba2ebb729a824f2ac387aa91aeba33a8a19cd572ec3249002efa549",
    "sizeInBytes": 17320,
    "createdAt": "2026-10-23T13:30:21Z",
    "updatedAt": "2026-10-23T13:30:21Z",
    "expiresAt": "2026-11-22T13:30:20Z",
    "workflowRunId": 39945618182,
}
FIXED_BASELINE_ARTIFACT = {
    "artifactId": 12504303358,
    "name": "oci-live-data-baselines-39945618182-1",
    "digest": "sha256:be6f0ad952738bad9e917c41fd0d77aaecd1244853621116e0dba20598b8ccda",
    "sizeInBytes": 11677,
    "createdAt": "2026-10-23T13:30:22Z",
    "updatedAt": "2026-10-23T13:30:22Z",
    "expiresAt": "2026-11-22T13:30:21Z",
    "workflowRunId": 39945618182,
}
FIXED_INFRASTRUCTURE_ARTIFACT = {
    "artifactId": 11465198380,
    "name": "oci-infrastructure-provenance-37582984293-1",
    "digest": "sha256:635826680d7cf55841e259a4b3a7e55ac243e3c3b5a69000ce01e9240e673717",
    "sizeInBytes": 3069,
    "createdAt": "2026-10-07T06:59:43Z",
    "updatedAt": "2026-10-07T06:59:43Z",
    "expiresAt": "2026-11-06T06:59:43Z",
    "workflowRunId": 37582984293,
}
FIXED_HELD_LOCK = {
    "uid": "4b0a6691-6c27-4b54-a40b-a236e1368760",
    "resourceVersion": "4155167",
    "state": "active",
    "holder": "live-data-39945618182-1",
    "operationId": "live-data-apply-slip-index",
    "sourceSha": "70679a6179df2167cb39f185cb0c26dca2ce649d",
    "acquiredAtEpoch": 1792761824,
    "leaseDurationSeconds": 7200,
    "leaseUntilEpoch": 1792769419,
    "releasedAtEpoch": 0,
    "fencingGeneration": 519,
}
FIXED_CONTINUATION_JOURNAL = {
    "schemaVersion": "betstan.oci-live-data-incident-restore-state.v1",
    "namespace": "betstan-oci",
    "name": "gaming-oci-live-data-incident-restore",
    "operationId": "live-data-incident-restore",
    "ownerRunId": 39945618182,
}
CONTINUATION_INPUT_DEFAULTS = {
    "incident_continuation_run_id": "0",
    "incident_continuation_authority_sha256": "none",
    "incident_continuation_control_sha": "none",
    "incident_continuation_journal_identity_sha256": "none",
    "incident_continuation_generation": "0",
    "incident_access_cleanup_lineage_json": "[]",
}
CURRENT_RUN_METADATA_SCHEMA = (
    "betstan.oci-live-data-incident-current-run.v1"
)
PROVIDER_TRANSITION_SCHEMA = (
    "betstan.oci-live-data-incident-provider-transition.v1"
)
INCIDENT_ACCESS_CLEANUP_MAX_LINEAGE = 32
EXPECTED_SERVICES = (
    "auth",
    "bet",
    "backoffice",
    "client",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
    "telemetry",
)
EXPECTED_WRITERS = (
    "backoffice",
    "bet",
    "event",
    "moderation",
    "resulting",
    "slip",
    "gamemaster",
)


class IncidentManifestError(RuntimeError):
    pass


def reject(message: str) -> None:
    raise IncidentManifestError(message)


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            reject(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json_bytes(raw: bytes, label: str, *, max_bytes: int) -> Any:
    if len(raw) > max_bytes:
        reject(f"{label} exceeds the reviewed size limit")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        reject(f"{label} is not UTF-8")
    try:
        return json.loads(
            text,
            object_pairs_hook=unique_object,
            parse_constant=lambda value: reject(
                f"{label} contains non-finite JSON value {value}"
            ),
        )
    except IncidentManifestError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError):
        reject(f"{label} is malformed JSON")


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        reject(f"{label} must be an object")
    return value


def require_exact_keys(
    value: dict[str, Any], expected: set[str], label: str
) -> None:
    actual = set(value)
    if actual != expected:
        missing = ",".join(sorted(expected - actual)) or "none"
        unknown = ",".join(sorted(actual - expected)) or "none"
        reject(f"{label} keys differ (missing={missing} unknown={unknown})")


def require_string(value: Any, label: str, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value:
        reject(f"{label} must be a non-empty string")
    if pattern is not None and pattern.fullmatch(value) is None:
        reject(f"{label} has an invalid format")
    return value


def require_integer(value: Any, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        reject(f"{label} must be an integer >= {minimum}")
    return value


def parse_utc(value: str, label: str) -> dt.datetime:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        reject(f"{label} must be a second-precision UTC timestamp")
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError:
        reject(f"{label} is not a valid UTC timestamp")


def validate_run_spec(value: Any, label: str, fixed: dict[str, Any]) -> dict[str, Any]:
    run = require_object(value, label)
    require_exact_keys(run, set(fixed), label)
    if run != fixed:
        reject(f"{label} differs from the accepted immutable run")
    return run


def validate_file_map(value: Any, label: str) -> dict[str, str]:
    files = require_object(value, label)
    if not files or len(files) > MAX_ARCHIVE_FILES:
        reject(f"{label} file count is outside the reviewed bound")
    normalized: dict[str, str] = {}
    folded: set[str] = set()
    for name, digest in files.items():
        require_string(name, f"{label} file name", SAFE_FILE_RE)
        path = PurePosixPath(name)
        if (
            path.is_absolute()
            or name.startswith("/")
            or "\\" in name
            or "\x00" in name
            or any(part in {"", ".", ".."} for part in path.parts)
            or str(path) != name
        ):
            reject(f"{label} contains an unsafe file name")
        if name.casefold() in folded:
            reject(f"{label} contains case-colliding file names")
        folded.add(name.casefold())
        normalized[name] = require_string(
            digest, f"{label} digest for {name}", RAW_DIGEST_RE
        )
    return normalized


def validate_artifact_spec(
    value: Any, label: str, fixed: dict[str, Any]
) -> dict[str, Any]:
    artifact = require_object(value, label)
    require_exact_keys(artifact, set(fixed) | {"files"}, label)
    for key, expected in fixed.items():
        if artifact.get(key) != expected:
            reject(f"{label}.{key} differs from the accepted artifact")
    validate_file_map(artifact["files"], f"{label}.files")
    return artifact


def validate_manifest_document(document: Any) -> dict[str, Any]:
    manifest = require_object(document, "incident manifest")
    top_keys = set(FIXED_TOP_LEVEL) | {
        "heldOwner",
        "imageBuildRoot",
        "infrastructureCheckpointRoot",
        "artifacts",
        "baseline",
        "continuationJournal",
        "heldLock",
    }
    require_exact_keys(manifest, top_keys, "incident manifest")
    for key, expected in FIXED_TOP_LEVEL.items():
        if manifest.get(key) != expected:
            reject(f"incident manifest {key} differs from the accepted design")

    validate_run_spec(manifest["heldOwner"], "heldOwner", FIXED_HELD_OWNER)
    validate_run_spec(
        manifest["imageBuildRoot"], "imageBuildRoot", FIXED_IMAGE_BUILD
    )
    validate_run_spec(
        manifest["infrastructureCheckpointRoot"],
        "infrastructureCheckpointRoot",
        FIXED_INFRASTRUCTURE,
    )

    artifacts = require_object(manifest["artifacts"], "artifacts")
    require_exact_keys(
        artifacts, {"rollout", "baseline", "infrastructure"}, "artifacts"
    )
    validate_artifact_spec(
        artifacts["rollout"], "artifacts.rollout", FIXED_ROLLOUT_ARTIFACT
    )
    validate_artifact_spec(
        artifacts["baseline"], "artifacts.baseline", FIXED_BASELINE_ARTIFACT
    )
    validate_artifact_spec(
        artifacts["infrastructure"],
        "artifacts.infrastructure",
        FIXED_INFRASTRUCTURE_ARTIFACT,
    )

    baseline = require_object(manifest["baseline"], "baseline")
    require_exact_keys(
        baseline,
        {
            "archiveRoot",
            "deploymentsFile",
            "liveImagesFile",
            "preRuntimeLockFile",
            "services",
            "writerServices",
            "expectedReplicas",
        },
        "baseline",
    )
    expected_root = "betstan/betstan/artifacts/oci-data-baseline-before"
    expected_baseline = {
        "archiveRoot": expected_root,
        "deploymentsFile": f"{expected_root}/deployments.tsv",
        "liveImagesFile": f"{expected_root}/live-images.tsv",
        "preRuntimeLockFile": "_temp/pre-runtime-lock.json",
        "services": list(EXPECTED_SERVICES),
        "writerServices": list(EXPECTED_WRITERS),
        "expectedReplicas": 1,
    }
    if baseline != expected_baseline:
        reject("baseline semantic contract differs from the accepted design")

    continuation_journal = require_object(
        manifest["continuationJournal"], "continuationJournal"
    )
    require_exact_keys(
        continuation_journal,
        set(FIXED_CONTINUATION_JOURNAL),
        "continuationJournal",
    )
    if continuation_journal != FIXED_CONTINUATION_JOURNAL:
        reject("continuationJournal differs from the accepted design")

    held_lock = require_object(manifest["heldLock"], "heldLock")
    require_exact_keys(held_lock, set(FIXED_HELD_LOCK), "heldLock")
    if held_lock != FIXED_HELD_LOCK:
        reject("heldLock differs from the accepted active preimage")
    return manifest


def read_fixed_manifest(repo_root: Path) -> tuple[dict[str, Any], bytes, str]:
    path = repo_root / MANIFEST_RELATIVE_PATH
    if not path.is_file() or path.is_symlink():
        reject("fixed incident manifest is missing or unsafe")
    raw = path.read_bytes()
    if len(raw) > MAX_MANIFEST_BYTES:
        reject("incident manifest exceeds 16 KiB")
    manifest = validate_manifest_document(
        load_json_bytes(raw, "incident manifest", max_bytes=MAX_MANIFEST_BYTES)
    )
    return manifest, raw, hashlib.sha256(raw).hexdigest()


class GitClient:
    def __init__(self, repo_root: Path):
        self.repo_root = repo_root

    def _run(
        self,
        *arguments: str,
        text: bool = True,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[Any]:
        try:
            return subprocess.run(
                ["git", "-C", str(self.repo_root), *arguments],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=text,
                env=env,
            )
        except OSError:
            reject("unable to execute Git for incident verification")

    def head_sha(self) -> str:
        result = self._run("rev-parse", "HEAD")
        value = result.stdout.strip()
        if result.returncode != 0 or SHA_RE.fullmatch(value) is None:
            reject("unable to read the checked-out control SHA")
        return value

    def blob_bytes(self, control_sha: str, path: Path) -> bytes:
        result = self._run("show", f"{control_sha}:{path.as_posix()}", text=False)
        if result.returncode != 0:
            reject("fixed incident manifest is absent from the control commit")
        return bytes(result.stdout)

    def is_ancestor(self, base_sha: str, target_sha: str) -> bool:
        result = self._run("merge-base", "--is-ancestor", base_sha, target_sha)
        if result.returncode == 0:
            return True
        if result.returncode == 1:
            return False
        reject("unable to evaluate control ancestry")

    def compare_image_inputs(
        self, base_sha: str, target_sha: str, scratch_dir: Path
    ) -> None:
        comparator = self.repo_root / IMAGE_INPUT_COMPARATOR
        if not comparator.is_file() or comparator.is_symlink():
            reject("canonical image-input comparator is unavailable")
        env = dict(os.environ)
        env["IMAGE_INPUT_REPOSITORY_ROOT"] = str(self.repo_root)
        env["TMPDIR"] = str(scratch_dir)
        try:
            result = subprocess.run(
                [str(comparator), base_sha, target_sha],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
        except OSError:
            reject("unable to execute canonical image-input comparison")
        if result.returncode == 1:
            reject("canonical image inputs changed after the base control")
        if result.returncode != 0:
            reject("canonical image-input equality could not be established")


class GhApiClient:
    def __init__(self, repository: str):
        self.repository = repository
        self.request_count = 0
        self.requested_endpoints: list[str] = []

    def _request(self, endpoint: str) -> bytes:
        self.request_count += 1
        if self.request_count > MAX_API_REQUESTS:
            reject("incident verification exceeded 24 GitHub metadata requests")
        self.requested_endpoints.append(endpoint)
        try:
            result = subprocess.run(
                ["gh", "api", endpoint],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError:
            reject("unable to execute the GitHub API client")
        if result.returncode != 0:
            reject("exact GitHub evidence request failed")
        return bytes(result.stdout)

    def _request_with_headers(
        self, endpoint: str
    ) -> tuple[bytes, dict[str, list[str]]]:
        self.request_count += 1
        if self.request_count > MAX_API_REQUESTS:
            reject("incident verification exceeded 24 GitHub metadata requests")
        self.requested_endpoints.append(endpoint)
        try:
            result = subprocess.run(
                [
                    "gh",
                    "api",
                    "--include",
                    "-H",
                    "Cache-Control: no-cache",
                    endpoint,
                ],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError:
            reject("unable to execute the GitHub API client")
        if result.returncode != 0:
            reject("exact GitHub evidence request failed")
        raw = bytes(result.stdout)
        if len(raw) > MAX_API_RESPONSE_BYTES:
            reject("exact GitHub response exceeded its size limit")
        separator = b"\r\n\r\n" if b"\r\n\r\n" in raw else b"\n\n"
        if separator not in raw:
            reject("exact GitHub response headers are malformed")
        header_raw, body = raw.split(separator, 1)
        try:
            lines = (
                header_raw.decode("ascii")
                .replace("\r\n", "\n")
                .split("\n")
            )
        except UnicodeDecodeError:
            reject("exact GitHub response headers are malformed")
        if (
            not lines
            or re.fullmatch(
                r"HTTP/(?:1\.[01]|2(?:\.0)?) 200(?: .*)?", lines[0]
            )
            is None
        ):
            reject("exact GitHub response status is invalid")
        headers: dict[str, list[str]] = {}
        for line in lines[1:]:
            if not line or ":" not in line:
                reject("exact GitHub response headers are malformed")
            name, value = line.split(":", 1)
            normalized = name.strip().lower()
            if re.fullmatch(r"[a-z0-9-]+", normalized) is None:
                reject("exact GitHub response header name is invalid")
            headers.setdefault(normalized, []).append(value.strip())
        return body, headers

    def get_run(self, run_id: int) -> dict[str, Any]:
        endpoint = f"repos/{self.repository}/actions/runs/{run_id}"
        value = load_json_bytes(
            self._request(endpoint),
            f"run {run_id} metadata",
            max_bytes=MAX_API_JSON_BYTES,
        )
        return require_object(value, f"run {run_id} metadata")

    def get_run_attempt(
        self, run_id: int, attempt: int = 1
    ) -> dict[str, Any]:
        endpoint = (
            f"repos/{self.repository}/actions/runs/{run_id}/attempts/{attempt}"
        )
        value = load_json_bytes(
            self._request(endpoint),
            f"run {run_id} attempt {attempt} metadata",
            max_bytes=MAX_API_JSON_BYTES,
        )
        return require_object(
            value, f"run {run_id} attempt {attempt} metadata"
        )

    def get_run_attempt_with_headers(
        self, run_id: int, attempt: int = 1
    ) -> tuple[dict[str, Any], dict[str, list[str]]]:
        endpoint = (
            f"repos/{self.repository}/actions/runs/{run_id}/attempts/{attempt}"
        )
        body, headers = self._request_with_headers(endpoint)
        value = load_json_bytes(
            body,
            f"run {run_id} attempt {attempt} metadata",
            max_bytes=MAX_API_JSON_BYTES,
        )
        return (
            require_object(
                value, f"run {run_id} attempt {attempt} metadata"
            ),
            headers,
        )

    def get_artifact(self, artifact_id: int) -> dict[str, Any]:
        endpoint = f"repos/{self.repository}/actions/artifacts/{artifact_id}"
        value = load_json_bytes(
            self._request(endpoint),
            f"artifact {artifact_id} metadata",
            max_bytes=MAX_API_JSON_BYTES,
        )
        return require_object(value, f"artifact {artifact_id} metadata")

    def download_artifact(self, artifact_id: int) -> bytes:
        endpoint = (
            f"repos/{self.repository}/actions/artifacts/{artifact_id}/zip"
        )
        return self._request(endpoint)


def validate_api_endpoints(
    api: GhApiClient,
    manifest: dict[str, Any],
    current_run_id: int = 0,
) -> None:
    allowed = {
        f"repos/{manifest['repository']}/actions/runs/{spec['runId']}"
        for spec in (
            manifest["heldOwner"],
            manifest["imageBuildRoot"],
            manifest["infrastructureCheckpointRoot"],
        )
    }
    for artifact in manifest["artifacts"].values():
        base = (
            f"repos/{manifest['repository']}/actions/artifacts/"
            f"{artifact['artifactId']}"
        )
        allowed.update({base, f"{base}/zip"})
    if current_run_id:
        allowed.add(
            f"repos/{manifest['repository']}/actions/runs/"
            f"{current_run_id}/attempts/1"
        )
    if api.request_count > MAX_API_REQUESTS:
        reject("incident verification exceeded 24 GitHub metadata requests")
    if any(endpoint not in allowed for endpoint in api.requested_endpoints):
        reject("incident verification used a forbidden GitHub endpoint")


def require_metadata_field(
    metadata: dict[str, Any], key: str, expected: Any, label: str
) -> None:
    if key not in metadata or metadata[key] != expected:
        reject(f"{label} {key} mismatch")


def validate_run_metadata(
    metadata: dict[str, Any], spec: dict[str, Any], repository: str, label: str
) -> None:
    mapping = {
        "id": spec["runId"],
        "workflow_id": spec["workflowId"],
        "path": spec["workflow"],
        "event": spec["event"],
        "head_branch": spec["headBranch"],
        "head_sha": spec["headSha"],
        "status": spec["status"],
        "conclusion": spec["conclusion"],
        "run_attempt": spec["runAttempt"],
        "created_at": spec["createdAt"],
        "updated_at": spec["updatedAt"],
    }
    for key, expected in mapping.items():
        require_metadata_field(metadata, key, expected, label)
    head_repository = require_object(
        metadata.get("head_repository"), f"{label} head_repository"
    )
    require_metadata_field(
        head_repository, "full_name", repository, f"{label} head_repository"
    )
    parse_utc(spec["createdAt"], f"{label} createdAt")
    parse_utc(spec["updatedAt"], f"{label} updatedAt")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def epoch_seconds(value: dt.datetime, label: str) -> int:
    if value.microsecond != 0:
        reject(f"{label} must have whole-second precision")
    epoch = int(value.timestamp())
    if epoch <= 0:
        reject(f"{label} is outside the accepted epoch range")
    return epoch


def validate_current_run_metadata(
    metadata: dict[str, Any],
    *,
    manifest: dict[str, Any],
    repository: str,
    control_sha: str,
    current_run_id: int,
) -> dict[str, Any]:
    mapping = {
        "id": current_run_id,
        "workflow_id": manifest["heldOwner"]["workflowId"],
        "path": manifest["heldOwner"]["workflow"],
        "event": "workflow_dispatch",
        "head_branch": "master",
        "head_sha": control_sha,
        "run_attempt": 1,
    }
    for key, expected in mapping.items():
        require_metadata_field(
            metadata, key, expected, "current incident run"
        )
    for key in ("repository", "head_repository"):
        owner = require_object(
            metadata.get(key), f"current incident run {key}"
        )
        require_metadata_field(
            owner,
            "full_name",
            repository,
            f"current incident run {key}",
        )
    created_raw = metadata.get("created_at")
    updated_raw = metadata.get("updated_at")
    if not isinstance(created_raw, str) or not isinstance(updated_raw, str):
        reject("current incident run timestamps are missing")
    created = parse_utc(created_raw, "current incident run created_at")
    updated = parse_utc(updated_raw, "current incident run updated_at")
    created_epoch = epoch_seconds(
        created, "current incident run created_at"
    )
    updated_epoch = epoch_seconds(
        updated, "current incident run updated_at"
    )
    if updated_epoch < created_epoch:
        reject("current incident run updated_at precedes created_at")
    identity = {
        "schemaVersion": CURRENT_RUN_METADATA_SCHEMA,
        "repository": repository,
        "endpoint": (
            f"repos/{repository}/actions/runs/{current_run_id}/attempts/1"
        ),
        "runId": current_run_id,
        "workflowId": manifest["heldOwner"]["workflowId"],
        "workflow": manifest["heldOwner"]["workflow"],
        "event": "workflow_dispatch",
        "headBranch": "master",
        "headSha": control_sha,
        "runAttempt": 1,
        "createdAt": created_raw,
        "createdAtEpoch": created_epoch,
    }
    return {
        "identity": identity,
        "metadataSha256": hashlib.sha256(
            canonical_json(identity).encode("utf-8")
        ).hexdigest(),
        "createdAtEpoch": created_epoch,
        "updatedAtEpoch": updated_epoch,
    }


def require_request_created_after_cutoff(
    request_created_at_epoch: int, cutoff_epoch: int
) -> None:
    if request_created_at_epoch <= cutoff_epoch:
        reject(
            "current incident run was not created strictly after the "
            "exact lock lease cutoff"
        )


def parse_provider_date(headers: dict[str, list[str]]) -> tuple[str, int]:
    values = headers.get("date", [])
    if len(values) != 1 or not values[0]:
        reject("exact GitHub response Date header is missing or duplicated")
    raw = values[0]
    try:
        parsed = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError, OverflowError):
        reject("exact GitHub response Date header is malformed")
    if parsed is None or parsed.tzinfo is None:
        reject("exact GitHub response Date header is malformed")
    parsed = parsed.astimezone(dt.timezone.utc)
    return raw, epoch_seconds(parsed, "exact GitHub response Date")


def capture_provider_transition(
    *,
    repo_root: Path,
    repository: str,
    control_sha: str,
    current_run_id: int,
    expected_metadata_sha256: str,
    expected_created_at_epoch: int,
    api: GhApiClient | None = None,
) -> dict[str, Any]:
    manifest, _, _ = read_fixed_manifest(repo_root.resolve())
    if repository != manifest["repository"]:
        reject("repository differs from the fixed incident manifest")
    if SHA_RE.fullmatch(control_sha) is None:
        reject("control SHA must be a complete lowercase commit SHA")
    if current_run_id <= 0:
        reject("current run ID must be positive")
    if RAW_DIGEST_RE.fullmatch(expected_metadata_sha256) is None:
        reject("expected current-run metadata digest is invalid")
    if expected_created_at_epoch <= 0:
        reject("expected request creation epoch is invalid")
    api = api or GhApiClient(repository)
    metadata, headers = api.get_run_attempt_with_headers(current_run_id, 1)
    current = validate_current_run_metadata(
        metadata,
        manifest=manifest,
        repository=repository,
        control_sha=control_sha,
        current_run_id=current_run_id,
    )
    if (
        current["metadataSha256"] != expected_metadata_sha256
        or current["createdAtEpoch"] != expected_created_at_epoch
    ):
        reject("current incident run immutable metadata changed")
    provider_date, transition_epoch = parse_provider_date(headers)
    if transition_epoch < current["updatedAtEpoch"]:
        reject("exact GitHub response Date is stale")
    if transition_epoch < current["createdAtEpoch"]:
        reject("exact GitHub response Date precedes run creation")
    validate_api_endpoints(api, manifest, current_run_id)
    result = {
        "schemaVersion": PROVIDER_TRANSITION_SCHEMA,
        "repository": repository,
        "endpoint": (
            f"repos/{repository}/actions/runs/{current_run_id}/attempts/1"
        ),
        "runId": current_run_id,
        "controlSha": control_sha,
        "currentRunMetadataSha256": expected_metadata_sha256,
        "requestCreatedAtEpoch": expected_created_at_epoch,
        "providerDate": provider_date,
        "providerTransitionEpoch": transition_epoch,
        "observedRunUpdatedAtEpoch": current["updatedAtEpoch"],
        "githubRequestCount": api.request_count,
    }
    result["evidenceSha256"] = hashlib.sha256(
        canonical_json(result).encode("utf-8")
    ).hexdigest()
    return result


def validate_artifact_metadata(
    metadata: dict[str, Any],
    spec: dict[str, Any],
    owner_run: dict[str, Any],
    now: dt.datetime,
    label: str,
) -> None:
    mapping = {
        "id": spec["artifactId"],
        "name": spec["name"],
        "size_in_bytes": spec["sizeInBytes"],
        "digest": spec["digest"],
        "expired": False,
        "created_at": spec["createdAt"],
        "updated_at": spec["updatedAt"],
        "expires_at": spec["expiresAt"],
    }
    for key, expected in mapping.items():
        require_metadata_field(metadata, key, expected, label)
    workflow_run = require_object(
        metadata.get("workflow_run"), f"{label} workflow_run"
    )
    for key, expected in {
        "id": spec["workflowRunId"],
        "head_branch": owner_run["headBranch"],
        "head_sha": owner_run["headSha"],
    }.items():
        require_metadata_field(workflow_run, key, expected, f"{label} workflow_run")
    repository_id = require_integer(
        workflow_run.get("repository_id"),
        f"{label} workflow_run.repository_id",
        minimum=1,
    )
    head_repository_id = require_integer(
        workflow_run.get("head_repository_id"),
        f"{label} workflow_run.head_repository_id",
        minimum=1,
    )
    if repository_id != head_repository_id:
        reject(f"{label} belongs to a different head repository")
    expires_at = parse_utc(spec["expiresAt"], f"{label} expiresAt")
    if expires_at <= now:
        reject(f"{label} is expired")


def ensure_output_directory(path: Path) -> None:
    if path.exists():
        if not path.is_dir() or path.is_symlink() or any(path.iterdir()):
            reject("incident verification output directory must be empty and safe")
    else:
        path.mkdir(parents=True, mode=0o700)
    path.chmod(0o700)


def validate_zip_member(info: zipfile.ZipInfo, seen_folded: set[str]) -> None:
    name = info.filename
    if (
        not name
        or "\x00" in name
        or "\\" in name
        or name.startswith("/")
        or SAFE_FILE_RE.fullmatch(name) is None
    ):
        reject("artifact archive contains an unsafe path")
    path = PurePosixPath(name)
    if any(part in {"", ".", ".."} for part in path.parts) or str(path) != name:
        reject("artifact archive contains a non-canonical path")
    folded = name.casefold()
    if folded in seen_folded:
        reject("artifact archive contains duplicate or case-colliding paths")
    seen_folded.add(folded)
    if info.flag_bits & 0x1:
        reject("artifact archive contains encrypted content")
    if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
        reject("artifact archive uses an unsupported compression method")
    mode = (info.external_attr >> 16) & 0xFFFF
    if info.is_dir():
        if mode and not stat.S_ISDIR(mode):
            reject("artifact archive directory mode is unsafe")
        return
    if mode and not stat.S_ISREG(mode):
        reject("artifact archive contains a non-regular file")
    if info.file_size > MAX_ARCHIVE_FILE_BYTES:
        reject("artifact archive member exceeds the reviewed size")
    if (
        info.file_size > 0
        and info.compress_size == 0
        or info.compress_size > 0
        and info.file_size > info.compress_size * MAX_COMPRESSION_RATIO
    ):
        reject("artifact archive has an unsafe compression ratio")


def extract_verified_archive(
    raw: bytes,
    spec: dict[str, Any],
    destination: Path,
    label: str,
) -> dict[str, bytes]:
    if len(raw) != spec["sizeInBytes"]:
        reject(f"{label} archive size mismatch")
    digest = f"sha256:{hashlib.sha256(raw).hexdigest()}"
    if digest != spec["digest"]:
        reject(f"{label} archive digest mismatch")
    destination.mkdir(mode=0o700)
    expected_files = validate_file_map(spec["files"], f"{label}.files")
    extracted: dict[str, bytes] = {}
    total = 0
    seen_folded: set[str] = set()
    try:
        with zipfile.ZipFile(io_bytes(raw)) as archive:
            if archive.comment:
                reject(f"{label} archive comment is not allowed")
            infos = archive.infolist()
            if len(infos) > MAX_ARCHIVE_FILES:
                reject(f"{label} archive file count exceeds the reviewed bound")
            for info in infos:
                validate_zip_member(info, seen_folded)
                if info.is_dir():
                    continue
                total += info.file_size
                if total > MAX_ARCHIVE_TOTAL_BYTES:
                    reject(f"{label} archive expands beyond the reviewed bound")
                try:
                    content = archive.read(info)
                except (RuntimeError, zipfile.BadZipFile, OSError):
                    reject(f"{label} archive content is malformed")
                if len(content) != info.file_size:
                    reject(f"{label} archive member size mismatch")
                extracted[info.filename] = content
    except IncidentManifestError:
        raise
    except (zipfile.BadZipFile, OSError, ValueError):
        reject(f"{label} is not a valid ZIP archive")
    if set(extracted) != set(expected_files):
        reject(f"{label} archive file set mismatch")
    for name, expected_digest in expected_files.items():
        if hashlib.sha256(extracted[name]).hexdigest() != expected_digest:
            reject(f"{label} archive file digest mismatch: {name}")
        target = destination.joinpath(*PurePosixPath(name).parts)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.exists() or target.is_symlink():
            reject(f"{label} extraction target is unsafe")
        with target.open("xb") as handle:
            handle.write(extracted[name])
        target.chmod(0o600)
    return extracted


def io_bytes(raw: bytes):
    import io

    return io.BytesIO(raw)


def parse_checksum_manifest(raw: bytes, label: str) -> dict[str, str]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        reject(f"{label} is not UTF-8")
    result: dict[str, str] = {}
    for line in text.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._/-]+)", line)
        if match is None or match.group(2) in result:
            reject(f"{label} is malformed")
        path = PurePosixPath(match.group(2))
        if (
            path.is_absolute()
            or any(part in {"", ".", ".."} for part in path.parts)
            or str(path) != match.group(2)
        ):
            reject(f"{label} contains an unsafe path")
        result[match.group(2)] = match.group(1)
    if not result:
        reject(f"{label} is empty")
    return result


def parse_env(raw: bytes, expected_keys: set[str], label: str) -> dict[str, str]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        reject(f"{label} is not UTF-8")
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line or "=" not in line:
            reject(f"{label} is malformed")
        key, value = line.split("=", 1)
        if (
            not re.fullmatch(r"[a-z][a-z0-9_]*", key)
            or key in values
            or key not in expected_keys
            or "\x00" in value
        ):
            reject(f"{label} contains a duplicate or unknown key")
        values[key] = value
    if set(values) != expected_keys:
        reject(f"{label} key set is incomplete")
    return values


def validate_rollout_semantics(
    manifest: dict[str, Any],
    rollout: dict[str, bytes],
    baseline: dict[str, bytes],
) -> dict[str, str]:
    rollout_checksums = parse_checksum_manifest(
        rollout["SHA256SUMS"], "rollout SHA256SUMS"
    )
    if set(rollout_checksums) != set(rollout) - {"SHA256SUMS"}:
        reject("rollout SHA256SUMS does not bind the exact archive file set")
    for name, digest in rollout_checksums.items():
        if hashlib.sha256(rollout[name]).hexdigest() != digest:
            reject(f"rollout checksum mismatch: {name}")

    provenance_keys = {
        "schema_version",
        "source_sha",
        "build_run_id",
        "infrastructure_run_id",
        "checkpoint_source_sha",
        "disk_checkpoint_run_id",
        "disk_checkpoint_sha256",
        "disk_checkpoint_disposition",
        "baseline_sha256",
        "baseline_recovery_run_id",
        "baseline_recovery_source_sha",
        "workflow_run_id",
        "workflow_run_attempt",
        "phase",
        "status",
        "backfill_complete",
        "index_ready",
        "event_reschedule_complete",
        "backoffice_pre_september_cleanup_complete",
        "maintenance_fence_enforced",
        "writers_quiesced",
        "runtime_held_for_deploy",
        "operation_lock_enforced",
        "operation_lock_handoff",
        "completed_at",
    }
    provenance = parse_env(
        rollout["provenance.env"], provenance_keys, "rollout provenance"
    )
    expected = {
        "schema_version": "live-betting-v6",
        "source_sha": str(manifest["heldOwner"]["headSha"]),
        "build_run_id": str(manifest["imageBuildRoot"]["runId"]),
        "infrastructure_run_id": str(
            manifest["infrastructureCheckpointRoot"]["runId"]
        ),
        "checkpoint_source_sha": str(manifest["imageBuildRoot"]["headSha"]),
        "disk_checkpoint_run_id": str(
            manifest["infrastructureCheckpointRoot"]["runId"]
        ),
        "disk_checkpoint_disposition": "READY_NO_RECLAIM",
        "baseline_recovery_run_id": "0",
        "baseline_recovery_source_sha": "none",
        "workflow_run_id": str(manifest["heldOwner"]["runId"]),
        "workflow_run_attempt": "1",
        "phase": "apply-slip-index",
        "status": "PASS",
        "backfill_complete": "true",
        "index_ready": "true",
        "event_reschedule_complete": "true",
        "backoffice_pre_september_cleanup_complete": "true",
        "maintenance_fence_enforced": "true",
        "writers_quiesced": "true",
        "runtime_held_for_deploy": "true",
        "operation_lock_enforced": "true",
        "operation_lock_handoff": "true",
    }
    for key, value in expected.items():
        if provenance[key] != value:
            reject(f"rollout provenance mismatch: {key}")
    for key in ("disk_checkpoint_sha256", "baseline_sha256"):
        if RAW_DIGEST_RE.fullmatch(provenance[key]) is None:
            reject(f"rollout provenance {key} is invalid")
    completed = parse_utc(provenance["completed_at"], "rollout completed_at")
    created = parse_utc(manifest["heldOwner"]["createdAt"], "heldOwner createdAt")
    updated = parse_utc(manifest["heldOwner"]["updatedAt"], "heldOwner updatedAt")
    if not created <= completed <= updated:
        reject("rollout completion time is outside the exact run")

    schema_keys = {
        "schema_version",
        "source_sha",
        "build_run_id",
        "infrastructure_run_id",
        "checkpoint_source_sha",
        "disk_checkpoint_run_id",
        "disk_checkpoint_sha256",
        "disk_checkpoint_disposition",
        "baseline_sha256",
        "baseline_recovery_run_id",
        "baseline_recovery_source_sha",
        "data_run_id",
        "data_run_attempt",
        "backfill_complete",
        "index_ready",
        "event_reschedule_complete",
        "backoffice_pre_september_cleanup_complete",
        "maintenance_fence_enforced",
        "writers_quiesced",
        "runtime_held_for_deploy",
        "operation_lock_enforced",
        "operation_lock_handoff",
    }
    schema = parse_env(rollout["schema.env"], schema_keys, "rollout schema")
    schema_expected = {
        key: value
        for key, value in expected.items()
        if key not in {"workflow_run_id", "workflow_run_attempt", "phase", "status"}
    }
    schema_expected.update(
        {
            "data_run_id": str(manifest["heldOwner"]["runId"]),
            "data_run_attempt": "1",
            "disk_checkpoint_sha256": provenance["disk_checkpoint_sha256"],
            "baseline_sha256": provenance["baseline_sha256"],
        }
    )
    for key, value in schema_expected.items():
        if schema.get(key) != value:
            reject(f"rollout schema mismatch: {key}")

    transfer = require_object(
        load_json_bytes(
            rollout["held-handoff-transfer.json"],
            "held handoff transfer",
            max_bytes=MAX_API_JSON_BYTES,
        ),
        "held handoff transfer",
    )
    transfer_keys = {
        "schema_version",
        "held_handoff_run_id",
        "held_handoff_source_sha",
        "lock_uid",
        "observed_fencing_generation",
        "observed_lease_until_epoch",
        "observed_resource_version",
        "snapshot_sha256",
        "successor_run_id",
        "successor_source_sha",
        "acquire_result",
        "release_result",
        "verify_result",
    }
    require_exact_keys(transfer, transfer_keys, "held handoff transfer")
    if (
        transfer["schema_version"] != "live-betting-held-handoff-transfer-v1"
        or transfer["successor_run_id"] != str(manifest["heldOwner"]["runId"])
        or transfer["successor_source_sha"] != manifest["heldOwner"]["headSha"]
        or transfer["lock_uid"] != manifest["heldLock"]["uid"]
        or transfer["snapshot_sha256"]
        != hashlib.sha256(
            baseline[manifest["baseline"]["preRuntimeLockFile"]]
        ).hexdigest()
        or any(
            transfer[key] != "confirmed"
            for key in ("acquire_result", "release_result", "verify_result")
        )
    ):
        reject("held handoff transfer is not the accepted confirmed transfer")
    for key in (
        "held_handoff_run_id",
        "observed_fencing_generation",
        "observed_lease_until_epoch",
        "observed_resource_version",
    ):
        if POSITIVE_INT_RE.fullmatch(str(transfer[key])) is None:
            reject(f"held handoff transfer {key} is invalid")
    if SHA_RE.fullmatch(str(transfer["held_handoff_source_sha"])) is None:
        reject("held handoff predecessor source is invalid")
    return provenance


def parse_tab_rows(
    raw: bytes, columns: int, label: str
) -> list[list[str]]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        reject(f"{label} is not UTF-8")
    rows: list[list[str]] = []
    for line in text.splitlines():
        fields = line.split("\t")
        if len(fields) != columns or any(field == "" for field in fields):
            reject(f"{label} is malformed")
        rows.append(fields)
    if not rows:
        reject(f"{label} is empty")
    return rows


def validate_lock_snapshot(raw: bytes, label: str) -> None:
    value = require_object(
        load_json_bytes(raw, label, max_bytes=MAX_API_JSON_BYTES), label
    )
    require_exact_keys(
        value, {"apiVersion", "kind", "metadata", "data"}, label
    )
    if value["apiVersion"] != "v1" or value["kind"] != "ConfigMap":
        reject(f"{label} is not a ConfigMap")
    metadata = require_object(value["metadata"], f"{label}.metadata")
    require_exact_keys(
        metadata,
        {"creationTimestamp", "name", "namespace", "resourceVersion", "uid"},
        f"{label}.metadata",
    )
    if (
        metadata["name"] != "gaming-mongo-migration-lock"
        or metadata["namespace"] != "betstan-oci"
        or POSITIVE_INT_RE.fullmatch(str(metadata["resourceVersion"])) is None
    ):
        reject(f"{label} metadata is invalid")
    require_string(metadata["uid"], f"{label}.metadata.uid")
    parse_utc(metadata["creationTimestamp"], f"{label}.metadata.creationTimestamp")
    data = require_object(value["data"], f"{label}.data")
    expected_keys = {
        "state",
        "holder",
        "operation-id",
        "source-sha",
        "acquired-at-epoch",
        "lease-duration-seconds",
        "lease-until-epoch",
        "released-at-epoch",
        "fencing-generation",
    }
    require_exact_keys(data, expected_keys, f"{label}.data")
    if (
        data["state"] != "active"
        or not data["holder"]
        or not data["operation-id"]
        or SHA_RE.fullmatch(str(data["source-sha"])) is None
        or str(data["released-at-epoch"]) != "0"
    ):
        reject(f"{label} active lock identity is invalid")
    for key in (
        "acquired-at-epoch",
        "lease-duration-seconds",
        "lease-until-epoch",
        "fencing-generation",
    ):
        if POSITIVE_INT_RE.fullmatch(str(data[key])) is None:
            reject(f"{label} {key} is invalid")


def validate_baseline_semantics(
    manifest: dict[str, Any],
    baseline: dict[str, bytes],
    rollout: dict[str, bytes],
    provenance: dict[str, str],
) -> None:
    root = manifest["baseline"]["archiveRoot"]
    checksum_name = f"{root}/SHA256SUMS"
    checksums = parse_checksum_manifest(
        baseline[checksum_name], "baseline SHA256SUMS"
    )
    expected_checksums = {
        name.removeprefix(f"{root}/"): digest
        for name, digest in manifest["artifacts"]["baseline"]["files"].items()
        if name.startswith(f"{root}/") and name != checksum_name
    }
    if checksums != expected_checksums:
        reject("baseline SHA256SUMS does not bind the exact baseline file set")
    if hashlib.sha256(baseline[checksum_name]).hexdigest() != provenance[
        "baseline_sha256"
    ]:
        reject("rollout baseline checksum identity mismatch")

    deployments = parse_tab_rows(
        baseline[manifest["baseline"]["deploymentsFile"]],
        6,
        "baseline deployments",
    )
    live_rows = parse_tab_rows(
        baseline[manifest["baseline"]["liveImagesFile"]],
        2,
        "baseline live images",
    )
    live_images: dict[str, str] = {}
    for service, image in live_rows:
        if service in live_images or service not in EXPECTED_SERVICES:
            reject("baseline live images have duplicate or unknown services")
        if not re.fullmatch(
            r"ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}",
            image,
        ):
            reject("baseline live image is not an exact GHCR digest")
        live_images[service] = image
    if tuple(sorted(live_images)) != tuple(sorted(EXPECTED_SERVICES)):
        reject("baseline live images have incomplete service coverage")

    deployment_images: dict[str, str] = {}
    for service, image, generation, desired, ready, available in deployments:
        if service in deployment_images or service not in EXPECTED_SERVICES:
            reject("baseline deployments have duplicate or unknown services")
        if (
            POSITIVE_INT_RE.fullmatch(generation) is None
            or desired != str(manifest["baseline"]["expectedReplicas"])
            or ready != desired
            or available != desired
            or image != live_images.get(service)
        ):
            reject("baseline deployment replica or image evidence is invalid")
        deployment_images[service] = image
    if tuple(sorted(deployment_images)) != tuple(sorted(EXPECTED_SERVICES)):
        reject("baseline deployments have incomplete service coverage")

    resume_rows = parse_tab_rows(
        rollout["resume-images.tsv"], 5, "rollout resume images"
    )
    resume_images: dict[str, str] = {}
    for service, repository, image, manifest_digest, platform_digest in resume_rows:
        if service in resume_images or service not in EXPECTED_SERVICES:
            reject("rollout resume images have duplicate or unknown services")
        if (
            repository != "ghcr.io/vasilyevstan/betstan-images"
            or image != live_images.get(service)
            or DIGEST_RE.fullmatch(manifest_digest) is None
            or DIGEST_RE.fullmatch(platform_digest) is None
            or not image.endswith(manifest_digest)
        ):
            reject("rollout resume image differs from the held baseline")
        resume_images[service] = image
    if resume_images != live_images:
        reject("rollout resume images do not equal the held baseline")
    if baseline[f"{root}/images.tsv"] != rollout["resume-images.tsv"]:
        reject("baseline image provenance differs from the held rollout")

    validate_lock_snapshot(
        baseline[manifest["baseline"]["preRuntimeLockFile"]],
        "baseline pre-runtime lock",
    )

    trusted_keys = {
        "source_sha",
        "source_ref",
        "run_attempt",
        "runtime_mode",
        "runtime_fingerprint",
        "image_provenance_sha256",
        "rendered_manifest_sha256",
        "rabbitmq_baseline_sha256",
        "public_host",
        "canonical_host",
        "redirect_host",
        "diagnostic_host",
        "deployment_workflow",
        "deployment_run_id",
        "deployment_run_attempt",
        "registry_provider",
        "registry_host",
        "registry_repository",
        "registry_public_anonymous",
        "build_run_id",
        "data_run_id",
        "data_run_attempt",
        "data_evidence_sha256",
        "infrastructure_run_id",
        "infrastructure_run_attempt",
        "infrastructure_provenance_sha256",
        "checkpoint_source_sha",
        "disk_checkpoint_run_id",
        "disk_checkpoint_sha256",
        "disk_checkpoint_disposition",
    }
    trusted = parse_env(
        baseline[f"{root}/trusted-deploy-provenance.txt"],
        trusted_keys,
        "trusted deploy provenance",
    )
    trusted_expected = {
        "source_ref": "refs/heads/master",
        "run_attempt": "1",
        "runtime_mode": "k3s",
        "registry_provider": "ghcr",
        "registry_host": "ghcr.io",
        "registry_repository": "ghcr.io/vasilyevstan/betstan-images",
        "registry_public_anonymous": "true",
        "build_run_id": str(manifest["imageBuildRoot"]["runId"]),
        "infrastructure_run_id": str(
            manifest["infrastructureCheckpointRoot"]["runId"]
        ),
        "infrastructure_run_attempt": "1",
        "checkpoint_source_sha": manifest["imageBuildRoot"]["headSha"],
        "disk_checkpoint_run_id": str(
            manifest["infrastructureCheckpointRoot"]["runId"]
        ),
        "disk_checkpoint_sha256": provenance["disk_checkpoint_sha256"],
        "disk_checkpoint_disposition": "READY_NO_RECLAIM",
        "image_provenance_sha256": hashlib.sha256(
            rollout["resume-images.tsv"]
        ).hexdigest(),
    }
    for key, value in trusted_expected.items():
        if trusted[key] != value:
            reject(f"trusted deploy provenance mismatch: {key}")


def expected_dispatch_inputs(
    manifest: dict[str, Any], control_sha: str
) -> dict[str, str]:
    return {
        "approved_sha": control_sha,
        "resume_source_sha": manifest["heldOwner"]["headSha"],
        "build_run_id": str(manifest["imageBuildRoot"]["runId"]),
        "infrastructure_run_id": str(
            manifest["infrastructureCheckpointRoot"]["runId"]
        ),
        "checkpoint_source_sha": manifest["imageBuildRoot"]["headSha"],
        "disk_checkpoint_run_id": str(
            manifest["infrastructureCheckpointRoot"]["runId"]
        ),
        "phase": "incident-restore",
        "prerequisite_run_id": str(manifest["heldOwner"]["runId"]),
        "baseline_recovery_run_id": "0",
        "baseline_recovery_source_sha": "none",
        "failed_deploy_run_id": "0",
        "failed_activation_run_id": "0",
        "failed_activation_user_id": "0",
        "held_handoff_run_id": str(manifest["heldOwner"]["runId"]),
        "held_handoff_source_sha": manifest["heldOwner"]["headSha"],
        "confirmation": manifest["confirmation"],
        **CONTINUATION_INPUT_DEFAULTS,
    }


def journal_identity(
    manifest: dict[str, Any], manifest_digest: str
) -> tuple[dict[str, Any], str]:
    identity = {
        **manifest["continuationJournal"],
        "manifestSha256": manifest_digest,
    }
    raw = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    return identity, hashlib.sha256(raw.encode("utf-8")).hexdigest()


def validate_control_handoff(
    *,
    repo_root: Path,
    from_control_sha: str,
    to_control_sha: str,
    scratch_dir: Path,
    manifest: dict[str, Any] | None = None,
    manifest_raw: bytes | None = None,
    manifest_digest: str | None = None,
    git: GitClient | None = None,
) -> dict[str, Any]:
    repo_root = repo_root.resolve()
    scratch_dir = scratch_dir.resolve()
    if not repo_root.is_dir() or not scratch_dir.is_dir():
        reject("control handoff repository or scratch directory is invalid")
    if (
        SHA_RE.fullmatch(from_control_sha) is None
        or SHA_RE.fullmatch(to_control_sha) is None
    ):
        reject("control handoff requires complete lowercase commit SHAs")
    if manifest is None or manifest_raw is None or manifest_digest is None:
        manifest, manifest_raw, manifest_digest = read_fixed_manifest(repo_root)
    git = git or GitClient(repo_root)
    if git.head_sha() != to_control_sha:
        reject("control handoff target is not the checked-out control")
    if git.blob_bytes(to_control_sha, MANIFEST_RELATIVE_PATH) != manifest_raw:
        reject("control handoff target manifest differs")
    if git.blob_bytes(from_control_sha, MANIFEST_RELATIVE_PATH) != manifest_raw:
        reject("control handoff predecessor manifest differs")
    if not git.is_ancestor(from_control_sha, to_control_sha):
        reject("control handoff predecessor is not an ancestor")
    git.compare_image_inputs(
        from_control_sha, to_control_sha, scratch_dir
    )
    identity, identity_digest = journal_identity(
        manifest, manifest_digest
    )
    proof = {
        "schemaVersion":
            "betstan.oci-live-data-incident-control-handoff.v1",
        "fromControlSha": from_control_sha,
        "toControlSha": to_control_sha,
        "relation": (
            "same" if from_control_sha == to_control_sha else "descendant"
        ),
        "manifestSha256": manifest_digest,
        "journalIdentity": identity,
        "journalIdentitySha256": identity_digest,
        "imageInputs": "unchanged",
    }
    proof["proofSha256"] = hashlib.sha256(
        json.dumps(
            proof, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    return proof


def validate_access_cleanup_lineage_input(
    raw_value: str,
    *,
    generation: int,
    predecessor_run_id: str,
    predecessor_control_sha: str,
    predecessor_authority_sha256: str,
) -> list[dict[str, Any]]:
    try:
        value = json.loads(raw_value, object_pairs_hook=unique_object)
    except IncidentManifestError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        reject(f"incident access-cleanup lineage is malformed: {exc}")
    if (
        json.dumps(value, sort_keys=True, separators=(",", ":"))
        != raw_value
    ):
        reject("incident access-cleanup lineage is not canonical JSON")
    if not isinstance(value, list):
        reject("incident access-cleanup lineage must be an array")
    if len(value) > INCIDENT_ACCESS_CLEANUP_MAX_LINEAGE:
        reject("incident access-cleanup lineage exceeds its fixed bound")
    if len(value) != generation:
        reject(
            "incident access-cleanup lineage length differs from generation"
        )
    seen_runs: set[int] = set()
    for expected_generation, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != {
            "runId",
            "controlSha",
            "authorityGeneration",
            "authoritySha256",
        }:
            reject("incident access-cleanup lineage entry shape is invalid")
        if (
            not isinstance(item["runId"], int)
            or isinstance(item["runId"], bool)
            or item["runId"] <= 0
            or not isinstance(item["authorityGeneration"], int)
            or isinstance(item["authorityGeneration"], bool)
            or item["authorityGeneration"] != expected_generation
            or not isinstance(item["controlSha"], str)
            or SHA_RE.fullmatch(item["controlSha"]) is None
            or not isinstance(item["authoritySha256"], str)
            or RAW_DIGEST_RE.fullmatch(item["authoritySha256"]) is None
        ):
            reject("incident access-cleanup lineage entry is invalid")
        if item["runId"] in seen_runs:
            reject("incident access-cleanup lineage run IDs are duplicated")
        seen_runs.add(item["runId"])
    if generation:
        last = value[-1]
        if (
            str(last["runId"]) != predecessor_run_id
            or last["controlSha"] != predecessor_control_sha
            or last["authoritySha256"]
            != predecessor_authority_sha256
        ):
            reject(
                "incident access-cleanup lineage does not bind the exact "
                "predecessor authority"
            )
    return value


def validate_dispatch_inputs(
    raw_inputs: str,
    manifest: dict[str, Any],
    manifest_digest: str,
    control_sha: str,
    current_run_id: int,
) -> dict[str, str]:
    inputs = require_object(
        load_json_bytes(
            raw_inputs.encode("utf-8"),
            "incident dispatch inputs",
            max_bytes=MAX_API_JSON_BYTES,
        ),
        "incident dispatch inputs",
    )
    expected = expected_dispatch_inputs(manifest, control_sha)
    if set(inputs) != set(expected):
        reject("incident dispatch inputs differ from the fixed manifest")
    for key, value in expected.items():
        if key not in CONTINUATION_INPUT_DEFAULTS and inputs.get(key) != value:
            reject("incident dispatch inputs differ from the fixed manifest")
    continuation = {
        key: inputs[key] for key in CONTINUATION_INPUT_DEFAULTS
    }
    if continuation == CONTINUATION_INPUT_DEFAULTS:
        return continuation
    if (
        POSITIVE_INT_RE.fullmatch(
            continuation["incident_continuation_run_id"]
        )
        is None
        or RAW_DIGEST_RE.fullmatch(
            continuation["incident_continuation_authority_sha256"]
        )
        is None
        or SHA_RE.fullmatch(
            continuation["incident_continuation_control_sha"]
        )
        is None
        or RAW_DIGEST_RE.fullmatch(
            continuation["incident_continuation_journal_identity_sha256"]
        )
        is None
        or POSITIVE_INT_RE.fullmatch(
            continuation["incident_continuation_generation"]
        )
        is None
    ):
        reject("incident continuation dispatch inputs are malformed")
    validate_access_cleanup_lineage_input(
        continuation["incident_access_cleanup_lineage_json"],
        generation=int(
            continuation["incident_continuation_generation"]
        ),
        predecessor_run_id=continuation[
            "incident_continuation_run_id"
        ],
        predecessor_control_sha=continuation[
            "incident_continuation_control_sha"
        ],
        predecessor_authority_sha256=continuation[
            "incident_continuation_authority_sha256"
        ],
    )
    _, expected_journal_digest = journal_identity(
        manifest, manifest_digest
    )
    if (
        continuation["incident_continuation_journal_identity_sha256"]
        != expected_journal_digest
    ):
        reject("incident continuation journal identity differs")
    if (
        current_run_id
        and int(continuation["incident_continuation_run_id"])
        == current_run_id
    ):
        reject("incident continuation self-references its current run")
    return continuation


def verify_incident_manifest(
    *,
    repo_root: Path,
    repository: str,
    control_sha: str,
    dispatch_inputs_json: str,
    current_run_id: int,
    output_dir: Path,
    result_json: Path | None = None,
    api: GhApiClient | None = None,
    git: GitClient | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    repo_root = repo_root.resolve()
    if not repo_root.is_dir():
        reject("repository root is invalid")
    if SHA_RE.fullmatch(control_sha) is None:
        reject("control SHA must be a complete lowercase commit SHA")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        reject("repository name is invalid")
    if isinstance(current_run_id, bool) or current_run_id < 0:
        reject("current run ID is invalid")

    ensure_output_directory(output_dir)
    manifest, manifest_raw, manifest_digest = read_fixed_manifest(repo_root)
    if repository != manifest["repository"]:
        reject("repository differs from the fixed incident manifest")
    continuation = validate_dispatch_inputs(
        dispatch_inputs_json,
        manifest,
        manifest_digest,
        control_sha,
        current_run_id,
    )

    git = git or GitClient(repo_root)
    if git.head_sha() != control_sha:
        reject("checked-out control SHA is not the exact current control")
    if git.blob_bytes(control_sha, MANIFEST_RELATIVE_PATH) != manifest_raw:
        reject("fixed incident manifest differs from the control commit")
    if not git.is_ancestor(manifest["baseControlSha"], control_sha):
        reject("final control SHA is not a descendant of the base control")
    git.compare_image_inputs(
        manifest["baseControlSha"], control_sha, output_dir
    )
    control_handoff = None
    if continuation != CONTINUATION_INPUT_DEFAULTS:
        control_handoff = validate_control_handoff(
            repo_root=repo_root,
            from_control_sha=continuation[
                "incident_continuation_control_sha"
            ],
            to_control_sha=control_sha,
            scratch_dir=output_dir,
            manifest=manifest,
            manifest_raw=manifest_raw,
            manifest_digest=manifest_digest,
            git=git,
        )

    root_run_ids = {
        manifest["heldOwner"]["runId"],
        manifest["imageBuildRoot"]["runId"],
        manifest["infrastructureCheckpointRoot"]["runId"],
    }
    if current_run_id and current_run_id in root_run_ids:
        reject("incident run self-references an immutable evidence root")

    held_lock = manifest["heldLock"]
    now = now or dt.datetime.now(tz=dt.timezone.utc)
    if (
        not current_run_id
        and dt.datetime.fromtimestamp(
            held_lock["leaseUntilEpoch"], tz=dt.timezone.utc
        )
        > now
    ):
        reject("held lock lease is not expired")
    if (
        held_lock["state"] != "active"
        or held_lock["releasedAtEpoch"] != 0
        or held_lock["acquiredAtEpoch"] >= held_lock["leaseUntilEpoch"]
        or not 60 <= held_lock["leaseDurationSeconds"] <= 86400
    ):
        reject("held lock preimage lease metadata is invalid")

    api = api or GhApiClient(repository)
    current_run = None
    if current_run_id:
        current_run = validate_current_run_metadata(
            api.get_run_attempt(current_run_id, 1),
            manifest=manifest,
            repository=repository,
            control_sha=control_sha,
            current_run_id=current_run_id,
        )
        require_request_created_after_cutoff(
            current_run["createdAtEpoch"],
            held_lock["leaseUntilEpoch"],
        )
    for label, spec in (
        ("held owner run", manifest["heldOwner"]),
        ("image build root", manifest["imageBuildRoot"]),
        (
            "infrastructure checkpoint root",
            manifest["infrastructureCheckpointRoot"],
        ),
    ):
        validate_run_metadata(
            api.get_run(spec["runId"]), spec, repository, label
        )

    run_by_id = {
        spec["runId"]: spec
        for spec in (
            manifest["heldOwner"],
            manifest["imageBuildRoot"],
            manifest["infrastructureCheckpointRoot"],
        )
    }
    artifact_metadata: dict[str, dict[str, Any]] = {}
    artifact_archives: dict[str, bytes] = {}
    for label, spec in manifest["artifacts"].items():
        metadata = api.get_artifact(spec["artifactId"])
        owner_run = run_by_id.get(spec["workflowRunId"])
        if owner_run is None:
            reject(f"{label} artifact owner is not an immutable root")
        validate_artifact_metadata(
            metadata, spec, owner_run, now, f"{label} artifact"
        )
        artifact_metadata[label] = metadata
        artifact_archives[label] = api.download_artifact(spec["artifactId"])

    validate_api_endpoints(api, manifest, current_run_id)
    rollout = extract_verified_archive(
        artifact_archives["rollout"],
        manifest["artifacts"]["rollout"],
        output_dir / "rollout",
        "rollout artifact",
    )
    baseline = extract_verified_archive(
        artifact_archives["baseline"],
        manifest["artifacts"]["baseline"],
        output_dir / "baseline",
        "baseline artifact",
    )
    extract_verified_archive(
        artifact_archives["infrastructure"],
        manifest["artifacts"]["infrastructure"],
        output_dir / "infrastructure",
        "infrastructure artifact",
    )
    provenance = validate_rollout_semantics(manifest, rollout, baseline)
    validate_baseline_semantics(manifest, baseline, rollout, provenance)

    identity, identity_digest = journal_identity(
        manifest, manifest_digest
    )
    result = {
        "schemaVersion": "betstan.oci-live-data-incident-restore-verification.v1",
        "operation": manifest["operation"],
        "manifestSha256": manifest_digest,
        "controlSha": control_sha,
        "baseControlSha": manifest["baseControlSha"],
        "heldOwnerRunId": manifest["heldOwner"]["runId"],
        "heldOwnerSourceSha": manifest["heldOwner"]["headSha"],
        "buildRunId": manifest["imageBuildRoot"]["runId"],
        "checkpointSourceSha": manifest["imageBuildRoot"]["headSha"],
        "infrastructureRunId": manifest["infrastructureCheckpointRoot"]["runId"],
        "infrastructureRoot": "infrastructure",
        "baselineRoot": (
            f"baseline/{manifest['baseline']['archiveRoot']}"
        ),
        "rolloutRoot": "rollout",
        "heldLock": manifest["heldLock"],
        "currentRun": current_run,
        "continuation": continuation,
        "continuationJournal": identity,
        "continuationJournalIdentitySha256": identity_digest,
        "controlHandoff": control_handoff,
        "githubRequestCount": api.request_count,
        "artifactExpiresAt": {
            key: spec["expiresAt"]
            for key, spec in manifest["artifacts"].items()
        },
    }
    if result_json is not None:
        resolved_result = result_json.resolve()
        try:
            resolved_result.relative_to(output_dir.resolve())
        except ValueError:
            reject("result JSON must be inside the verification output directory")
        if result_json.exists() or result_json.is_symlink():
            reject("result JSON target already exists or is unsafe")
        result_json.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        result_json.write_text(
            json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        result_json.chmod(0o600)
    return result


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify the one fixed OCI held-baseline incident manifest"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify = subparsers.add_parser("verify")
    verify.add_argument("--repository", required=True)
    verify.add_argument("--repo-root", required=True)
    verify.add_argument("--control-sha", required=True)
    verify.add_argument("--dispatch-inputs-json", required=True)
    verify.add_argument("--current-run-id", default="0")
    verify.add_argument("--output-dir", required=True)
    verify.add_argument("--result-json")
    handoff = subparsers.add_parser("verify-control-handoff")
    handoff.add_argument("--repo-root", required=True)
    handoff.add_argument("--from-control-sha", required=True)
    handoff.add_argument("--to-control-sha", required=True)
    handoff.add_argument("--scratch-dir", required=True)
    transition = subparsers.add_parser("provider-transition-time")
    transition.add_argument("--repository", required=True)
    transition.add_argument("--repo-root", required=True)
    transition.add_argument("--control-sha", required=True)
    transition.add_argument("--current-run-id", required=True)
    transition.add_argument("--expected-metadata-sha256", required=True)
    transition.add_argument("--expected-created-at-epoch", required=True)
    transition.add_argument("--result-json", required=True)
    return parser.parse_args(argv)


def write_new_private_json(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        reject("result JSON target already exists or is unsafe")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(canonical_json(value) + "\n", encoding="utf-8")
    path.chmod(0o600)


def main(argv: list[str]) -> int:
    arguments = parse_args(argv)
    if arguments.command == "verify-control-handoff":
        proof = validate_control_handoff(
            repo_root=Path(arguments.repo_root),
            from_control_sha=arguments.from_control_sha,
            to_control_sha=arguments.to_control_sha,
            scratch_dir=Path(arguments.scratch_dir),
        )
        print(json.dumps(proof, sort_keys=True, separators=(",", ":")))
        return 0
    if arguments.command == "provider-transition-time":
        if re.fullmatch(r"[1-9][0-9]*", arguments.current_run_id) is None:
            reject("current run ID must be positive")
        if (
            re.fullmatch(
                r"[1-9][0-9]*", arguments.expected_created_at_epoch
            )
            is None
        ):
            reject("expected request creation epoch is invalid")
        result = capture_provider_transition(
            repo_root=Path(arguments.repo_root),
            repository=arguments.repository,
            control_sha=arguments.control_sha,
            current_run_id=int(arguments.current_run_id),
            expected_metadata_sha256=arguments.expected_metadata_sha256,
            expected_created_at_epoch=int(
                arguments.expected_created_at_epoch
            ),
        )
        write_new_private_json(Path(arguments.result_json), result)
        print(
            "incident_provider_transition=PASS "
            f"run_id={result['runId']} "
            f"provider_transition_epoch="
            f"{result['providerTransitionEpoch']} "
            f"github_requests={result['githubRequestCount']}"
        )
        return 0
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)", arguments.current_run_id):
        reject("current run ID must be zero or a positive integer")
    result = verify_incident_manifest(
        repo_root=Path(arguments.repo_root),
        repository=arguments.repository,
        control_sha=arguments.control_sha,
        dispatch_inputs_json=arguments.dispatch_inputs_json,
        current_run_id=int(arguments.current_run_id),
        output_dir=Path(arguments.output_dir),
        result_json=Path(arguments.result_json) if arguments.result_json else None,
    )
    print(
        "incident_manifest=PASS "
        f"operation={result['operation']} "
        f"control_sha={result['controlSha']} "
        f"owner_run_id={result['heldOwnerRunId']} "
        f"github_requests={result['githubRequestCount']}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except IncidentManifestError as error:
        print(f"incident_manifest=FAIL reason={error}", file=sys.stderr)
        raise SystemExit(1)
