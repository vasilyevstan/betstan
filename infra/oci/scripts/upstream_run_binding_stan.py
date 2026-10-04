#!/usr/bin/env python3
"""Validate protected upstream run bindings.

A protected operation may depend on an exact upstream run (for example the
capacity acquisition or GHCR build that must precede an infrastructure
finalization). Protected authority is one-use, so those dependencies must be
proven before any authority is issued and before any cloud access, and the
identical rules must apply whether the operation is dispatched through the CLI
or executed directly by GitHub Actions.

This module is the single implementation of those rules. The dispatcher and the
workflow both call it with bindings taken from the same policy definition, so
the two paths cannot drift.
"""

import argparse
import datetime as dt
import hashlib
import io
import ipaddress
import json
import re
import stat
import subprocess
import sys
import time
import zipfile
from pathlib import Path

FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
POSITIVE_INTEGER = re.compile(r"^[1-9][0-9]*$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ALLOWED_BINDING_KEYS = {
    "input",
    "workflow",
    "titleTemplates",
    "artifactTemplate",
    "artifactContent",
    "afterInput",
    "expectedHeadShaInput",
    "expectedConclusion",
    "artifactValidatorProfile",
    "runProfile",
}
ARTIFACT_VALIDATOR_PROFILES = {"oci-release-disk-checkpoint-v1"}
RUN_PROFILES = {
    "oci-failed-deploy-retained-hold-v1",
    "oci-failed-deploy-released-runtime-v1",
    "oci-failed-activation-cleanup-v1",
}
CURRENT_SERVICES = {
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry",
}
APPLICATION_REPOSITORY = "ghcr.io/vasilyevstan/betstan-images"
ARTIFACT_CONTENT_KEYS = {"fileName", "format", "equals"}
ARTIFACT_VALUE_TOKEN = re.compile(
    r"^\{(subject_sha|run_id|input:[A-Za-z0-9_]+)\}$"
)
MAX_ARTIFACT_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_ARTIFACT_EVIDENCE_BYTES = 1024 * 1024
ARTIFACT_DOWNLOAD_ATTEMPTS = 3
ARTIFACT_DOWNLOAD_TIMEOUT_SECONDS = 120
ARTIFACT_DOWNLOAD_BACKOFF_SECONDS = (1, 2)
LIVE_V6_KEYS = {
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
LIVE_V6_SCHEMA_KEYS = {
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
BASELINE_PROVENANCE_KEYS = {
    "baseline_source_sha",
    "baseline_deploy_workflow",
    "baseline_deploy_run_id",
    "baseline_deploy_run_attempt",
    "baseline_build_workflow",
    "baseline_build_run_id",
    "baseline_build_run_attempt",
    "baseline_recovery_run_id",
    "baseline_recovery_run_attempt",
    "baseline_transition_provenance_file",
    "baseline_capture_run_id",
    "baseline_capture_run_attempt",
    "namespace",
    "public_url",
    "redirect_url",
    "diagnostic_url",
    "http_attempts",
    "http_retry_seconds",
    "alias_probe_mode",
    "sse_path",
    "sse_requirement",
    "sse_required",
    "database_restore",
    "registry_provider",
    "registry_host",
    "registry_repository",
    "registry_public_anonymous",
}
DEPLOYMENT_PROVENANCE_KEYS = {
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
ACTIVATION_PROVENANCE_KEYS = {
    "source_sha",
    "build_run_id",
    "infrastructure_run_id",
    "deployment_run_id",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "disk_checkpoint_sha256",
    "disk_checkpoint_disposition",
    "live_acceptance_user_id",
    "activation_run_id",
    "activation_run_attempt",
    "activate_control_sha256",
    "acceptance_sha256",
    "accepted_sha256",
    "commit_control_sha256",
    "failure_disable_sha256",
    "final_disable_sha256",
    "final_control_file",
    "final_control_sha256",
    "live_kickoffs_enabled",
    "activation_state",
    "activation_lease_until_epoch",
    "workflow_result",
    "workflow_phase",
    "accepted_outcome",
    "accepted_evidence_upload_outcome",
    "commit_preflight_outcome",
    "commit_outcome",
    "failure_disable_outcome",
    "final_disable_outcome",
    "post_commit_status",
    "revoke_runner_outcome",
    "close_bastion_outcome",
}


def fail(message):
    print(f"upstream binding rejected: {message}", file=sys.stderr)
    raise SystemExit(1)


def gh_api(path):
    result = subprocess.run(
        ["gh", "api", path],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"unable to read {path}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        fail(f"malformed response for {path}")


def gh_api_pages(path):
    result = subprocess.run(
        ["gh", "api", path, "--paginate", "--slurp"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"unable to read all pages of {path}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail(f"malformed paginated response for {path}")
    if isinstance(payload, dict):
        return [payload]
    if not isinstance(payload, list) or not all(
        isinstance(page, dict) for page in payload
    ):
        fail(f"unexpected paginated response for {path}")
    return payload


def _classify_artifact_download_failure(returncode, stderr):
    if returncode < 0:
        return "cancelled", None, False
    if returncode != 1:
        return "command", None, False
    diagnostic = (stderr or b"").decode("utf-8", errors="replace").strip()
    matches = re.findall(
        r"(?m)^(?:gh: HTTP ([1-5][0-9]{2})|"
        r"gh: [^\r\n]+ \(HTTP ([1-5][0-9]{2})\)|"
        r"HTTP ([1-5][0-9]{2}): [^\r\n]+)$",
        diagnostic,
    )
    statuses = {int(value) for match in matches for value in match if value}
    if len(statuses) > 1:
        return "ambiguous", None, False
    status = statuses.pop() if statuses else None
    if status is not None and status not in {500, 502, 503, 504}:
        return "http", status, False
    if (
        len(diagnostic.splitlines()) > 1
        or len(re.findall(r"\bHTTP [1-5][0-9]{2}\b", diagnostic))
        != (1 if status is not None else 0)
        or re.search(
            r"\b(?:unauthorized|forbidden|permission denied|not found|"
            r"authentication|credentials|not authorized|access denied)\b",
            diagnostic,
            re.IGNORECASE,
        )
    ):
        return "ambiguous", status, False
    if status is not None:
        return "http", status, True
    address = (
        r"(?:[0-9.]+|\[[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?\])"
        r":[0-9]{1,5}"
    )
    network = re.fullmatch(
        r'(?:gh: )?(?:(?:Get|Head) "[^"\r\n]+": )?'
        r"(?:net/http: TLS handshake timeout|"
        r"context deadline exceeded"
        r"(?: \(Client\.Timeout exceeded while awaiting headers\))?|"
        rf"(?:(?P<operation>read|write|dial) tcp "
        rf"(?P<addresses>{address}(?:->{address})?): )?(?:read: )?"
        r"(?:i/o timeout|connection reset by peer))",
        diagnostic,
    )
    if network:
        if network.group("addresses") is not None:
            addresses = network.group("addresses").split("->")
            if len(addresses) != (1 if network.group("operation") == "dial" else 2):
                return "unknown", None, False
            for endpoint in addresses:
                host, port = endpoint.rsplit(":", 1)
                try:
                    ipaddress.ip_address(host[1:-1] if host.startswith("[") else host)
                except ValueError:
                    return "unknown", None, False
                if not 1 <= int(port) <= 65535:
                    return "unknown", None, False
        return "network", None, True
    return "unknown", None, False


def gh_api_bytes(path):
    for attempt in range(1, ARTIFACT_DOWNLOAD_ATTEMPTS + 1):
        try:
            result = subprocess.run(
                ["gh", "api", path],
                capture_output=True,
                check=False,
                timeout=ARTIFACT_DOWNLOAD_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            classification, status, retryable = "timeout", None, True
        except OSError:
            classification, status, retryable = "local-execution", None, False
        else:
            if result.returncode == 0:
                if not result.stdout:
                    classification = "empty-body"
                elif len(result.stdout) > MAX_ARTIFACT_ARCHIVE_BYTES:
                    classification = "oversized-body"
                else:
                    return result.stdout
                status, retryable = None, False
            else:
                classification, status, retryable = (
                    _classify_artifact_download_failure(
                        result.returncode, result.stderr
                    )
                )
        disposition = (
            "retry" if attempt < ARTIFACT_DOWNLOAD_ATTEMPTS else "exhausted"
        ) if retryable else "not-retryable"
        message = f"artifact download classification={classification}"
        if status is not None:
            message += f" status={status}"
        message += (
            f" attempt={attempt}/{ARTIFACT_DOWNLOAD_ATTEMPTS}"
            f" disposition={disposition}"
        )
        if disposition != "retry":
            fail(message)
        print(message, file=sys.stderr)
        time.sleep(ARTIFACT_DOWNLOAD_BACKOFF_SECONDS[attempt - 1])


def parse_timestamp(value, label):
    if not isinstance(value, str) or not value:
        fail(f"{label} is missing")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(f"{label} is malformed")
    if parsed.tzinfo is None:
        fail(f"{label} has no timezone")
    return parsed


def substitute(template, subject_sha, run_id):
    return template.replace("{subject_sha}", subject_sha).replace(
        "{run_id}", run_id
    )


def resolve_artifact_value(value, subject_sha, run_id, dispatch_inputs):
    if not isinstance(value, str):
        return value
    token = ARTIFACT_VALUE_TOKEN.fullmatch(value)
    if token is None:
        return value
    name = token.group(1)
    if name == "subject_sha":
        return subject_sha
    if name == "run_id":
        return run_id
    input_name = name.split(":", 1)[1]
    if input_name not in dispatch_inputs:
        fail(f"artifact content references missing input {input_name}")
    return dispatch_inputs[input_name]


def validate_binding_shape(binding):
    if not isinstance(binding, dict):
        fail("binding must be an object")
    unexpected = set(binding) - ALLOWED_BINDING_KEYS
    if unexpected:
        fail(f"binding has unsupported keys: {sorted(unexpected)}")
    for key in ("input", "workflow", "titleTemplates", "artifactTemplate"):
        if key not in binding:
            fail(f"binding is missing {key}")
    if not isinstance(binding["input"], str) or not binding["input"]:
        fail("binding input must be a non-empty string")
    if not isinstance(binding["workflow"], str) or not binding[
        "workflow"
    ].endswith(".yml"):
        fail("binding workflow must be a .yml workflow file name")
    titles = binding["titleTemplates"]
    if not isinstance(titles, dict) or not titles:
        fail("binding must declare at least one permitted event title")
    artifact = binding["artifactTemplate"]
    if not isinstance(artifact, str) or not artifact:
        fail("binding must declare an artifact template")
    for event, template in titles.items():
        if not isinstance(event, str) or not event:
            fail("binding event names must be non-empty strings")
        if template is None:
            # A null title is only acceptable when the artifact itself binds
            # both the subject SHA and the exact run, which is a stronger
            # identity than a title that embeds an unpredictable upstream ID.
            equality_values = (
                (binding.get("artifactContent") or {}).get("equals") or {}
            ).values()
            content_binds_identity = (
                "{subject_sha}" in equality_values
                and "{run_id}" in equality_values
            )
            if (
                ("{subject_sha}" not in artifact or "{run_id}" not in artifact)
                and not content_binds_identity
                and binding.get("artifactValidatorProfile") is None
            ):
                fail(
                    f"event {event} has no stable title, so its artifact "
                    "template must bind both subject SHA and run ID"
                )
            continue
        if not isinstance(template, str) or not template:
            fail(f"binding title for {event} must be a non-empty string or null")
    after_input = binding.get("afterInput")
    if after_input is not None and (
        not isinstance(after_input, str)
        or not after_input
        or after_input == binding["input"]
    ):
        fail("binding afterInput must name a different non-empty input")
    expected_head_input = binding.get("expectedHeadShaInput")
    if expected_head_input is not None and (
        not isinstance(expected_head_input, str)
        or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", expected_head_input)
    ):
        fail("binding expectedHeadShaInput must name a dispatch input")
    expected_conclusion = binding.get("expectedConclusion", "success")
    if expected_conclusion not in {"success", "failure"}:
        fail("binding expectedConclusion is unsupported")
    artifact_profile = binding.get("artifactValidatorProfile")
    if artifact_profile is not None and artifact_profile not in ARTIFACT_VALIDATOR_PROFILES:
        fail("binding artifactValidatorProfile is unsupported")
    run_profile = binding.get("runProfile")
    if run_profile is not None and run_profile not in RUN_PROFILES:
        fail("binding runProfile is unsupported")
    if (expected_conclusion == "failure") != (run_profile is not None):
        fail("failure conclusions are permitted only with a fixed recovery runProfile")
    if run_profile is not None:
        expected_workflow = (
            "oci-live-betting-activate.yml"
            if run_profile == "oci-failed-activation-cleanup-v1"
            else "oci-production-deploy.yml"
        )
        if binding["workflow"] != expected_workflow:
            fail("binding runProfile does not match its fixed workflow")
    if artifact_profile is not None and binding["workflow"] != "oci-infrastructure.yml":
        fail("release checkpoint validation is fixed to oci-infrastructure.yml")
    artifact_content = binding.get("artifactContent")
    if artifact_content is not None:
        if (
            not isinstance(artifact_content, dict)
            or set(artifact_content) != ARTIFACT_CONTENT_KEYS
        ):
            fail("binding artifactContent has an invalid schema")
        file_name = artifact_content["fileName"]
        if (
            not isinstance(file_name, str)
            or not file_name
            or "/" in file_name
            or "\\" in file_name
            or file_name in {".", ".."}
        ):
            fail("binding artifactContent fileName is invalid")
        if artifact_content["format"] not in {"json", "env"}:
            fail("binding artifactContent format is unsupported")
        equals = artifact_content["equals"]
        if not isinstance(equals, dict) or not equals:
            fail("binding artifactContent equals must be a non-empty object")
        for key, value in equals.items():
            if (
                not isinstance(key, str)
                or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                or type(value) not in {str, int, bool}
            ):
                fail("binding artifactContent equality is invalid")
            if isinstance(value, str) and (
                ("{" in value or "}" in value)
                and ARTIFACT_VALUE_TOKEN.fullmatch(value) is None
            ):
                fail("binding artifactContent contains an invalid token")


def load_artifact_content(
    repository,
    binding,
    artifact,
    subject_sha,
    run_id,
    dispatch_inputs,
):
    content_contract = binding.get("artifactContent")
    if content_contract is None:
        return
    artifact_id = artifact.get("id")
    if type(artifact_id) is not int or artifact_id < 1:
        fail(f"{binding['input']} artifact has an invalid ID")
    archive = gh_api_bytes(
        f"repos/{repository}/actions/artifacts/{artifact_id}/zip"
    )
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            infos = bundle.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                fail(f"{binding['input']} artifact contains duplicate paths")
            matches = []
            for info in infos:
                mode = (info.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK:
                    fail(f"{binding['input']} artifact contains a symlink")
                path_parts = info.filename.replace("\\", "/").split("/")
                if (
                    info.filename.startswith("/")
                    or any(part == ".." for part in path_parts)
                ):
                    fail(f"{binding['input']} artifact contains an unsafe path")
                if not info.is_dir() and path_parts[-1] == content_contract[
                    "fileName"
                ]:
                    matches.append(info)
            if len(matches) != 1:
                fail(
                    f"{binding['input']} artifact expects exactly one "
                    f"{content_contract['fileName']}"
                )
            evidence_info = matches[0]
            if (
                evidence_info.file_size < 1
                or evidence_info.file_size > MAX_ARTIFACT_EVIDENCE_BYTES
            ):
                fail(f"{binding['input']} artifact evidence size is invalid")
            raw = bundle.read(evidence_info)
    except zipfile.BadZipFile:
        fail(f"{binding['input']} artifact is not a valid ZIP archive")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{binding['input']} artifact evidence is not UTF-8")

    if content_contract["format"] == "json":
        try:
            observed = json.loads(text)
        except json.JSONDecodeError:
            fail(f"{binding['input']} artifact evidence is malformed JSON")
        if not isinstance(observed, dict):
            fail(f"{binding['input']} artifact JSON evidence is not an object")
    else:
        observed = {}
        for line in text.splitlines():
            if not line:
                continue
            if "=" not in line:
                fail(f"{binding['input']} artifact env evidence is malformed")
            key, value = line.split("=", 1)
            if (
                not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                or key in observed
                or any(ord(character) < 0x20 for character in value)
            ):
                fail(f"{binding['input']} artifact env evidence is unsafe")
            observed[key] = value

    for key, expected_template in content_contract["equals"].items():
        expected = resolve_artifact_value(
            expected_template,
            subject_sha,
            run_id,
            dispatch_inputs,
        )
        if observed.get(key) != expected:
            fail(
                f"{binding['input']} artifact field {key} is "
                f"{observed.get(key)!r}, expected {expected!r}"
            )


def artifact_inventory(repository, run_id, label):
    pages = gh_api_pages(
        f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100"
    )
    total_counts = {page.get("total_count") for page in pages}
    if (
        len(total_counts) != 1
        or not all(type(count) is int and count >= 0 for count in total_counts)
    ):
        fail(f"{label} artifact inventory has an invalid total count")
    artifacts = []
    for page in pages:
        page_artifacts = page.get("artifacts")
        if not isinstance(page_artifacts, list) or not all(
            isinstance(item, dict) for item in page_artifacts
        ):
            fail(f"{label} artifact inventory has an invalid page")
        artifacts.extend(page_artifacts)
    if len(artifacts) != next(iter(total_counts)):
        fail(f"{label} artifact inventory is incomplete")
    return artifacts


def exact_artifact(repository, run_id, name, label):
    matches = [
        item for item in artifact_inventory(repository, run_id, label)
        if item.get("name") == name
    ]
    if len(matches) != 1:
        fail(f"{label} expects exactly one {name} artifact, found {len(matches)}")
    artifact = matches[0]
    if artifact.get("expired") is not False:
        fail(f"{label} artifact {name} is expired")
    size = artifact.get("size_in_bytes")
    if type(size) is not int or size <= 0 or size > MAX_ARTIFACT_ARCHIVE_BYTES:
        fail(f"{label} artifact {name} has an invalid size")
    return artifact


def artifact_files(repository, artifact, label):
    artifact_id = artifact.get("id")
    if type(artifact_id) is not int or artifact_id < 1:
        fail(f"{label} artifact has an invalid ID")
    archive = gh_api_bytes(
        f"repos/{repository}/actions/artifacts/{artifact_id}/zip"
    )
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            infos = bundle.infolist()
            files = {}
            total_size = 0
            for info in infos:
                mode = (info.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK:
                    fail(f"{label} artifact contains a symlink")
                if "\\" in info.filename:
                    fail(f"{label} artifact contains a non-canonical path")
                normalized = (
                    info.filename[:-1]
                    if info.is_dir() and info.filename.endswith("/")
                    else info.filename
                )
                parts = normalized.split("/")
                if (
                    normalized.startswith("/")
                    or any(part in {"", ".", ".."} for part in parts)
                ):
                    fail(f"{label} artifact contains an unsafe path")
                if info.is_dir():
                    continue
                if mode not in {0, stat.S_IFREG}:
                    fail(f"{label} artifact contains a non-regular file")
                if info.flag_bits & 0x1:
                    fail(f"{label} artifact contains encrypted content")
                if normalized in files:
                    fail(f"{label} artifact contains duplicate paths")
                if (
                    info.file_size < 1
                    or info.file_size > MAX_ARTIFACT_EVIDENCE_BYTES
                ):
                    fail(f"{label} artifact evidence size is invalid")
                total_size += info.file_size
                if total_size > MAX_ARTIFACT_ARCHIVE_BYTES:
                    fail(f"{label} artifact expanded content is oversized")
                files[normalized] = bundle.read(info)
            if not files:
                fail(f"{label} artifact contains no evidence files")
            return files
    except zipfile.BadZipFile:
        fail(f"{label} artifact is not a valid ZIP archive")


def unique_artifact_file(files, file_name, label):
    matches = [
        (path, raw)
        for path, raw in files.items()
        if path.rsplit("/", 1)[-1] == file_name
    ]
    if len(matches) != 1:
        fail(f"{label} artifact expects exactly one {file_name}")
    return matches[0]


def artifact_member(repository, artifact, file_name, label):
    _, raw = unique_artifact_file(
        artifact_files(repository, artifact, label),
        file_name,
        label,
    )
    return raw


def parse_env(raw, label, expected_keys=None):
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} is not UTF-8")
    values = {}
    for line in text.splitlines():
        if not line or "=" not in line:
            fail(f"{label} is malformed")
        key, value = line.split("=", 1)
        if (
            not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
            or key in values
            or any(ord(character) < 0x20 for character in value)
        ):
            fail(f"{label} is unsafe")
        values[key] = value
    if expected_keys is not None and set(values) != expected_keys:
        fail(f"{label} has an unexpected key set")
    return values


def validate_checksum_manifest(files, label):
    manifest_path, raw_manifest = unique_artifact_file(
        files, "SHA256SUMS", label
    )
    try:
        lines = raw_manifest.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail(f"{label} checksum manifest is not UTF-8")
    prefix = manifest_path.rsplit("/", 1)[0] + "/" if "/" in manifest_path else ""
    manifest = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._/-]+)", line)
        if match is None:
            fail(f"{label} checksum manifest is malformed")
        relative = match.group(2)
        if (
            relative.startswith("/")
            or "\\" in relative
            or any(part in {"", ".", ".."} for part in relative.split("/"))
            or relative in manifest
            or relative == "SHA256SUMS"
        ):
            fail(f"{label} checksum manifest contains an unsafe path")
        manifest[relative] = match.group(1)
    expected_paths = {prefix + relative for relative in manifest}
    if set(files) != expected_paths | {manifest_path}:
        fail(f"{label} checksum manifest does not bind the exact artifact")
    for relative, digest in manifest.items():
        if hashlib.sha256(files[prefix + relative]).hexdigest() != digest:
            fail(f"{label} checksum mismatch for {relative}")
    return hashlib.sha256(raw_manifest).hexdigest()


def candidate_images_checksum(raw):
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail("current build candidate image evidence is not UTF-8")
    rows = []
    digest = re.compile(r"^sha256:[0-9a-f]{64}$")
    for line in lines:
        fields = line.split("\t")
        if len(fields) != 5:
            fail("current build candidate image evidence has an invalid schema")
        service, repository, image_ref, manifest, platform = fields
        if (
            service not in CURRENT_SERVICES
            or repository != APPLICATION_REPOSITORY
            or image_ref != f"{repository}@{manifest}"
            or digest.fullmatch(manifest) is None
            or digest.fullmatch(platform) is None
        ):
            fail("current build candidate image evidence is invalid")
        rows.append(
            {
                "service": service,
                "imageRef": image_ref,
                "manifestDigest": manifest,
                "platformDigest": platform,
            }
        )
    if len(rows) != 10 or {item["service"] for item in rows} != CURRENT_SERVICES:
        fail("current build candidate image evidence is incomplete")
    canonical = json.dumps(
        sorted(rows, key=lambda item: item["service"]),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(canonical).hexdigest()


def require_dispatch_sha(dispatch_inputs, name):
    value = dispatch_inputs.get(name)
    if not isinstance(value, str) or FULL_SHA.fullmatch(value) is None:
        fail(f"dispatch input {name} is not a full SHA")
    return value


def require_dispatch_run(dispatch_inputs, name):
    value = str(dispatch_inputs.get(name, ""))
    if POSITIVE_INTEGER.fullmatch(value) is None:
        fail(f"dispatch input {name} is not a positive run ID")
    return value


def parse_checkpoint_artifact(
    repository,
    dispatch_inputs,
    runtime_mode,
    label="release checkpoint",
):
    if runtime_mode not in {"k3s", "oke"}:
        fail("authoritative OCI runtime mode is required for checkpoint lineage")
    source_sha = require_dispatch_sha(dispatch_inputs, "checkpoint_source_sha")
    checkpoint_run = require_dispatch_run(dispatch_inputs, "disk_checkpoint_run_id")
    build_run = require_dispatch_run(dispatch_inputs, "build_run_id")
    infrastructure_run = require_dispatch_run(
        dispatch_inputs, "infrastructure_run_id"
    )
    artifact = exact_artifact(
        repository,
        checkpoint_run,
        f"oci-release-disk-checkpoint-{source_sha}-{checkpoint_run}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    checkpoint_path, raw = unique_artifact_file(files, "checkpoint.json", label)
    if set(files) != {checkpoint_path}:
        fail(f"{label} artifact contains unexpected files")
    try:
        checkpoint_text = raw.decode("utf-8")
        checkpoint = json.loads(checkpoint_text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail(f"{label} artifact is malformed JSON")
    if not isinstance(checkpoint, dict):
        fail(f"{label} artifact is not an object")
    helper = Path(__file__).with_name("k3s_disk_recovery_stan.py")
    command = [
        sys.executable,
        str(helper),
        "validate-release-checkpoint",
        "--checkpoint-json",
        checkpoint_text,
        "--source-sha",
        source_sha,
        "--producer-run-id",
        checkpoint_run,
        "--runtime-mode",
        runtime_mode,
        "--infrastructure-run-id",
        infrastructure_run,
        "--ghcr-build-run-id",
        build_run,
    ]
    if runtime_mode == "k3s":
        build_artifact = exact_artifact(
            repository,
            build_run,
            f"oci-image-provenance-{source_sha}-{build_run}-1",
            f"{label} build",
        )
        candidate_hash = candidate_images_checksum(
            artifact_member(
                repository,
                build_artifact,
                "images.tsv",
                f"{label} build",
            )
        )
        command.extend(("--expected-candidate-images-sha256", candidate_hash))
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        fail(f"repository-fixed validator rejected {label}")
    return checkpoint


def parse_live_v6_artifact(repository, run_id, label):
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-live-data-rollout-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    manifest_sha256 = validate_checksum_manifest(files, label)
    _, raw = unique_artifact_file(files, "provenance.env", label)
    values = parse_env(raw, f"{label} provenance", LIVE_V6_KEYS)
    if (
        values["schema_version"] != "live-betting-v6"
        or values["workflow_run_id"] != run_id
        or values["workflow_run_attempt"] != "1"
        or values["status"] != "PASS"
        or FULL_SHA.fullmatch(values["source_sha"]) is None
        or FULL_SHA.fullmatch(values["checkpoint_source_sha"]) is None
        or POSITIVE_INTEGER.fullmatch(values["build_run_id"]) is None
        or POSITIVE_INTEGER.fullmatch(values["infrastructure_run_id"]) is None
        or POSITIVE_INTEGER.fullmatch(values["disk_checkpoint_run_id"]) is None
        or re.fullmatch(r"[0-9a-f]{64}", values["disk_checkpoint_sha256"]) is None
        or values["disk_checkpoint_disposition"]
        not in {"READY_NO_RECLAIM", "READY_RECLAIMED", "NOT_APPLICABLE"}
        or re.fullmatch(r"[0-9a-f]{64}", values["baseline_sha256"]) is None
        or values["baseline_recovery_run_id"] != "0"
        and POSITIVE_INTEGER.fullmatch(values["baseline_recovery_run_id"]) is None
        or values["baseline_recovery_run_id"] == "0"
        and values["baseline_recovery_source_sha"] != "none"
        or values["baseline_recovery_run_id"] != "0"
        and FULL_SHA.fullmatch(values["baseline_recovery_source_sha"]) is None
        or not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z",
            values["completed_at"],
        )
    ):
        fail(f"{label} is not complete live-betting-v6 evidence")
    return values, manifest_sha256


def validate_live_v6_lineage(
    values,
    checkpoint,
    dispatch_inputs,
    expected_run,
    expected_source,
    expected_phase,
    label,
):
    baseline_recovery_run = str(
        dispatch_inputs.get("baseline_recovery_run_id", "")
    )
    baseline_recovery_source = str(
        dispatch_inputs.get(
            "baseline_recovery_source_sha",
            "none" if baseline_recovery_run == "0" else "",
        )
    )
    expected = {
        "source_sha": expected_source,
        "build_run_id": require_dispatch_run(dispatch_inputs, "build_run_id"),
        "infrastructure_run_id": require_dispatch_run(
            dispatch_inputs, "infrastructure_run_id"
        ),
        "checkpoint_source_sha": require_dispatch_sha(
            dispatch_inputs, "checkpoint_source_sha"
        ),
        "disk_checkpoint_run_id": require_dispatch_run(
            dispatch_inputs, "disk_checkpoint_run_id"
        ),
        "disk_checkpoint_sha256": checkpoint.get("contentChecksumSha256"),
        "disk_checkpoint_disposition": checkpoint.get("disposition"),
        "workflow_run_id": expected_run,
        "workflow_run_attempt": "1",
        "phase": expected_phase,
        "baseline_recovery_run_id": baseline_recovery_run,
        "baseline_recovery_source_sha": baseline_recovery_source,
    }
    for key, expected_value in expected.items():
        if values.get(key) != expected_value:
            fail(f"{label} field {key} does not match the exact lineage")
    if (
        checkpoint.get("sourceSha") != expected["checkpoint_source_sha"]
        or checkpoint.get("ghcrBuildRunId") != expected["build_run_id"]
        or checkpoint.get("infrastructureRunId")
        != expected["infrastructure_run_id"]
    ):
        fail(f"{label} checkpoint build or infrastructure lineage differs")
    control_expected = {
        "dry-run": {
            "maintenance_fence_enforced": "false",
            "writers_quiesced": "false",
            "runtime_held_for_deploy": "false",
            "operation_lock_enforced": "true",
            "operation_lock_handoff": "false",
        },
        "apply-backfills": {
            "backfill_complete": "true",
            "event_reschedule_complete": "true",
            "maintenance_fence_enforced": "true",
            "writers_quiesced": "true",
            "runtime_held_for_deploy": "false",
            "operation_lock_enforced": "true",
            "operation_lock_handoff": "false",
        },
        "apply-slip-index": {
            "backfill_complete": "true",
            "index_ready": "true",
            "event_reschedule_complete": "true",
            "backoffice_pre_september_cleanup_complete": "true",
            "maintenance_fence_enforced": "true",
            "writers_quiesced": "true",
            "runtime_held_for_deploy": "true",
            "operation_lock_enforced": "true",
            "operation_lock_handoff": "true",
        },
    }[expected_phase]
    for key, expected_value in control_expected.items():
        if values.get(key) != expected_value:
            fail(f"{label} field {key} does not match the complete v6 state")


def parse_infrastructure_provenance(
    repository,
    source_sha,
    infrastructure_run,
    build_run,
    label,
):
    artifact = exact_artifact(
        repository,
        infrastructure_run,
        f"oci-infrastructure-provenance-{infrastructure_run}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    _, raw = unique_artifact_file(files, "provenance.env", label)
    values = parse_env(raw, f"{label} provenance")
    expected = {
        "source_sha": source_sha,
        "infrastructure_run_id": infrastructure_run,
        "infrastructure_run_attempt": "1",
        "infrastructure_finalized": "true",
        "ghcr_build_run_id": build_run,
    }
    for key, expected_value in expected.items():
        if values.get(key) != expected_value:
            fail(f"{label} field {key} differs from the exact lineage")
    return values, hashlib.sha256(raw).hexdigest()


def exact_basename_set(files):
    return {path.rsplit("/", 1)[-1] for path in files}


def parse_deployment_artifact(
    repository,
    deployment_run,
    subject_sha,
    dispatch_inputs,
    checkpoint,
    predecessor,
    predecessor_manifest_sha256,
    runtime_mode,
    label,
):
    artifact = exact_artifact(
        repository,
        deployment_run,
        f"oci-deploy-provenance-{deployment_run}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    expected_files = {
        "provenance.txt",
        "images.tsv",
        "rabbitmq-baseline.txt",
        "live-schema.env",
    }
    if exact_basename_set(files) != expected_files or len(files) != len(expected_files):
        fail(f"{label} artifact has an unexpected file set")
    _, provenance_raw = unique_artifact_file(files, "provenance.txt", label)
    provenance = parse_env(
        provenance_raw,
        f"{label} provenance",
        DEPLOYMENT_PROVENANCE_KEYS,
    )
    _, images_raw = unique_artifact_file(files, "images.tsv", label)
    _, rabbit_raw = unique_artifact_file(files, "rabbitmq-baseline.txt", label)
    _, schema_raw = unique_artifact_file(files, "live-schema.env", label)
    schema = parse_env(schema_raw, f"{label} live schema", LIVE_V6_SCHEMA_KEYS)
    checkpoint_source = require_dispatch_sha(
        dispatch_inputs, "checkpoint_source_sha"
    )
    build_run = require_dispatch_run(dispatch_inputs, "build_run_id")
    infrastructure_run = require_dispatch_run(
        dispatch_inputs, "infrastructure_run_id"
    )
    data_run = predecessor["workflow_run_id"]
    expected = {
        "source_sha": subject_sha,
        "source_ref": "refs/heads/master",
        "run_attempt": "1",
        "runtime_mode": runtime_mode,
        "deployment_workflow": "oci-production-deploy",
        "deployment_run_id": deployment_run,
        "deployment_run_attempt": "1",
        "registry_provider": "ghcr",
        "registry_host": "ghcr.io",
        "registry_repository": APPLICATION_REPOSITORY,
        "registry_public_anonymous": "true",
        "build_run_id": build_run,
        "data_run_id": data_run,
        "data_run_attempt": "1",
        "data_evidence_sha256": predecessor_manifest_sha256,
        "infrastructure_run_id": infrastructure_run,
        "infrastructure_run_attempt": "1",
        "checkpoint_source_sha": checkpoint_source,
        "disk_checkpoint_run_id": checkpoint["producerRunId"],
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": checkpoint["disposition"],
    }
    for key, expected_value in expected.items():
        if provenance.get(key) != expected_value:
            fail(f"{label} field {key} differs from the exact lineage")
    if (
        hashlib.sha256(images_raw).hexdigest()
        != provenance["image_provenance_sha256"]
        or hashlib.sha256(rabbit_raw).hexdigest()
        != provenance["rabbitmq_baseline_sha256"]
    ):
        fail(f"{label} embedded evidence checksum differs")
    build_artifact = exact_artifact(
        repository,
        build_run,
        f"oci-image-provenance-{checkpoint_source}-{build_run}-1",
        f"{label} build",
    )
    build_images_raw = artifact_member(
        repository,
        build_artifact,
        "images.tsv",
        f"{label} build",
    )
    if candidate_images_checksum(images_raw) != candidate_images_checksum(
        build_images_raw
    ):
        fail(f"{label} candidate images differ from the original build")
    _, infrastructure_sha256 = parse_infrastructure_provenance(
        repository,
        checkpoint_source,
        infrastructure_run,
        build_run,
        f"{label} infrastructure",
    )
    if provenance["infrastructure_provenance_sha256"] != infrastructure_sha256:
        fail(f"{label} infrastructure checksum differs")
    schema_expected = {
        "source_sha": predecessor["source_sha"],
        "build_run_id": build_run,
        "infrastructure_run_id": infrastructure_run,
        "checkpoint_source_sha": checkpoint_source,
        "disk_checkpoint_run_id": checkpoint["producerRunId"],
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": checkpoint["disposition"],
        "baseline_sha256": predecessor["baseline_sha256"],
        "baseline_recovery_run_id": predecessor["baseline_recovery_run_id"],
        "baseline_recovery_source_sha":
            predecessor["baseline_recovery_source_sha"],
        "data_run_id": data_run,
        "data_run_attempt": "1",
        "schema_version": "live-betting-v6",
    }
    for key, expected_value in schema_expected.items():
        if schema.get(key) != expected_value:
            fail(f"{label} live schema field {key} differs")
    for key in (
        "backfill_complete",
        "index_ready",
        "event_reschedule_complete",
        "backoffice_pre_september_cleanup_complete",
        "maintenance_fence_enforced",
        "writers_quiesced",
        "runtime_held_for_deploy",
        "operation_lock_enforced",
        "operation_lock_handoff",
    ):
        if schema.get(key) != "true":
            fail(f"{label} live schema field {key} is not complete")
    return provenance


def validate_descendant_scope(checkpoint_sha, subject_sha):
    if checkpoint_sha == subject_sha:
        return
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", checkpoint_sha, subject_sha],
        capture_output=True,
        check=False,
    )
    if ancestor.returncode != 0:
        fail("checkpoint source is not an ancestor of the current subject")
    changed = subprocess.run(
        ["git", "diff", "--name-only", "-z", checkpoint_sha, subject_sha],
        capture_output=True,
        check=False,
    )
    if changed.returncode != 0:
        fail("unable to prove checkpoint descendant path scope")
    try:
        paths = [
            item.decode("utf-8")
            for item in changed.stdout.split(b"\0")
            if item
        ]
    except UnicodeDecodeError:
        fail("checkpoint descendant path is not UTF-8")
    if not paths or not all(
        path.startswith(".github/")
        or path.startswith("infra/")
        or path.lower().endswith(".md")
        for path in paths
    ):
        fail("checkpoint descendant contains an application or unsupported path")


def jobs_for_run(repository, run_id, label):
    pages = gh_api_pages(
        f"repos/{repository}/actions/runs/{run_id}/attempts/1/jobs?per_page=100"
    )
    total_counts = {page.get("total_count") for page in pages}
    if (
        len(total_counts) != 1
        or not all(type(count) is int and count >= 0 for count in total_counts)
    ):
        fail(f"{label} job inventory has an invalid total count")
    jobs = []
    for page in pages:
        values = page.get("jobs")
        if not isinstance(values, list) or not all(isinstance(item, dict) for item in values):
            fail(f"{label} job inventory has an invalid page")
        jobs.extend(values)
    if len(jobs) != next(iter(total_counts)):
        fail(f"{label} job inventory is incomplete")
    return jobs


def exact_job(jobs, name, label):
    matches = [job for job in jobs if job.get("name") == name]
    if len(matches) != 1:
        fail(f"{label} expects exactly one {name} job")
    if not isinstance(matches[0].get("steps"), list):
        fail(f"{label} job {name} has no step evidence")
    return matches[0]


def step_conclusion(job, name, label):
    matches = [step for step in job["steps"] if step.get("name") == name]
    if len(matches) != 1:
        fail(f"{label} expects exactly one {name} step")
    conclusion = matches[0].get("conclusion")
    if conclusion not in {"success", "failure", "skipped", "cancelled"}:
        fail(f"{label} step {name} has an invalid conclusion")
    return conclusion


def validate_failed_deploy_artifacts(
    repository,
    run_id,
    subject_sha,
    artifact,
    dispatch_inputs,
    runtime_mode,
    label,
):
    checkpoint = parse_checkpoint_artifact(
        repository, dispatch_inputs, runtime_mode, f"{label} checkpoint"
    )
    predecessor_run = require_dispatch_run(dispatch_inputs, "prerequisite_run_id")
    predecessor, predecessor_manifest_sha256 = parse_live_v6_artifact(
        repository, predecessor_run, f"{label} predecessor"
    )
    validate_live_v6_lineage(
        predecessor,
        checkpoint,
        dispatch_inputs,
        predecessor_run,
        subject_sha,
        "apply-slip-index",
        f"{label} predecessor",
    )

    baseline_files = artifact_files(repository, artifact, f"{label} baseline")
    baseline_manifest_sha256 = validate_checksum_manifest(
        baseline_files, f"{label} baseline"
    )
    _, baseline_raw = unique_artifact_file(
        baseline_files, "baseline-provenance.env", f"{label} baseline"
    )
    baseline = parse_env(
        baseline_raw,
        f"{label} baseline provenance",
        BASELINE_PROVENANCE_KEYS,
    )
    if (
        baseline["baseline_capture_run_id"] != predecessor_run
        or baseline["baseline_capture_run_attempt"] != "1"
        or baseline["registry_provider"] != "ghcr"
        or baseline["registry_host"] != "ghcr.io"
        or baseline["registry_repository"] != APPLICATION_REPOSITORY
        or baseline["registry_public_anonymous"] != "true"
        or baseline_manifest_sha256 != predecessor["baseline_sha256"]
    ):
        fail(f"{label} rollback baseline does not match its predecessor capture")
    parse_deployment_artifact(
        repository,
        run_id,
        subject_sha,
        dispatch_inputs,
        checkpoint,
        predecessor,
        predecessor_manifest_sha256,
        runtime_mode,
        f"{label} deployment",
    )
    return checkpoint, predecessor


def activation_file_checksum(files, relative, expected, label):
    matches = [
        raw
        for path, raw in files.items()
        if path == relative or path.endswith("/" + relative)
    ]
    if expected == "none":
        if matches:
            fail(f"{label} unexpectedly contains {relative}")
        return
    if re.fullmatch(r"[0-9a-f]{64}", expected) is None or len(matches) != 1:
        fail(f"{label} checksum binding for {relative} is invalid")
    if hashlib.sha256(matches[0]).hexdigest() != expected:
        fail(f"{label} checksum differs for {relative}")


def validate_failed_activation_artifacts(
    repository,
    run_id,
    subject_sha,
    artifact,
    dispatch_inputs,
    runtime_mode,
    label,
):
    checkpoint = parse_checkpoint_artifact(
        repository, dispatch_inputs, runtime_mode, f"{label} checkpoint"
    )
    predecessor_run = require_dispatch_run(dispatch_inputs, "prerequisite_run_id")
    predecessor, predecessor_manifest_sha256 = parse_live_v6_artifact(
        repository, predecessor_run, f"{label} predecessor"
    )
    validate_live_v6_lineage(
        predecessor,
        checkpoint,
        dispatch_inputs,
        predecessor_run,
        subject_sha,
        "apply-slip-index",
        f"{label} predecessor",
    )
    files = artifact_files(repository, artifact, label)
    _, raw = unique_artifact_file(files, "provenance.env", label)
    activation = parse_env(raw, f"{label} provenance", ACTIVATION_PROVENANCE_KEYS)
    expected = {
        "source_sha": subject_sha,
        "build_run_id": require_dispatch_run(dispatch_inputs, "build_run_id"),
        "infrastructure_run_id": require_dispatch_run(
            dispatch_inputs, "infrastructure_run_id"
        ),
        "checkpoint_source_sha": checkpoint["sourceSha"],
        "disk_checkpoint_run_id": checkpoint["producerRunId"],
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": checkpoint["disposition"],
        "live_acceptance_user_id": str(
            dispatch_inputs.get("failed_activation_user_id", "")
        ),
        "activation_run_id": run_id,
        "activation_run_attempt": "1",
        "workflow_result": "failure",
        "activation_state": "dark",
        "live_kickoffs_enabled": "false",
    }
    for key, expected_value in expected.items():
        if activation.get(key) != expected_value:
            fail(f"{label} field {key} differs from the exact lineage")
    deployment_run = activation["deployment_run_id"]
    if POSITIVE_INTEGER.fullmatch(deployment_run) is None:
        fail(f"{label} deployment run is invalid")
    deployment = gh_api(
        f"repos/{repository}/actions/runs/{deployment_run}"
    )
    workflow = gh_api(
        f"repos/{repository}/actions/workflows/oci-production-deploy.yml"
    )
    if (
        not isinstance(deployment, dict)
        or not isinstance(workflow, dict)
        or deployment.get("id") != int(deployment_run)
        or deployment.get("run_attempt") != 1
        or deployment.get("workflow_id") != workflow.get("id")
        or deployment.get("path")
        != ".github/workflows/oci-production-deploy.yml"
        or deployment.get("head_sha") != subject_sha
        or deployment.get("head_branch") != "master"
        or (deployment.get("head_repository") or {}).get("full_name")
        != repository
        or deployment.get("status") != "completed"
        or deployment.get("conclusion") != "success"
        or deployment.get("event") != "workflow_dispatch"
    ):
        fail(f"{label} deployment run metadata is invalid")
    parse_deployment_artifact(
        repository,
        deployment_run,
        subject_sha,
        dispatch_inputs,
        checkpoint,
        predecessor,
        predecessor_manifest_sha256,
        runtime_mode,
        f"{label} deployment",
    )
    checksum_files = {
        "activate_control_sha256": "activate/control.env",
        "acceptance_sha256": "acceptance/evidence.json",
        "accepted_sha256": "accepted.env",
        "commit_control_sha256": "commit/control.env",
        "failure_disable_sha256": "failure-disable/control.env",
        "final_disable_sha256": "final-failure-disable/control.env",
    }
    for key, relative in checksum_files.items():
        activation_file_checksum(files, relative, activation[key], label)
    final_file = activation["final_control_file"]
    if final_file == "none":
        if activation["final_control_sha256"] != "none":
            fail(f"{label} final control checksum has no file")
    else:
        prefix = "artifacts/live-control/"
        if not final_file.startswith(prefix):
            fail(f"{label} final control path is invalid")
        activation_file_checksum(
            files,
            final_file.removeprefix(prefix),
            activation["final_control_sha256"],
            label,
        )
    expected_relatives = {"provenance.env"}
    for key, relative in checksum_files.items():
        if activation[key] != "none":
            expected_relatives.add(relative)
    if final_file != "none":
        expected_relatives.add(final_file.removeprefix("artifacts/live-control/"))
    observed_relatives = set()
    for path in files:
        matches = [
            relative
            for relative in expected_relatives
            if path == relative or path.endswith("/" + relative)
        ]
        if len(matches) != 1 or matches[0] in observed_relatives:
            fail(f"{label} artifact has an unexpected file set")
        observed_relatives.add(matches[0])
    if observed_relatives != expected_relatives:
        fail(f"{label} artifact is incomplete")


def validate_run_profile(
    repository,
    run_id,
    subject_sha,
    profile,
    label,
    artifact,
    dispatch_inputs,
    runtime_mode,
):
    if profile is None:
        return
    jobs = jobs_for_run(repository, run_id, label)
    if profile in {
        "oci-failed-deploy-retained-hold-v1",
        "oci-failed-deploy-released-runtime-v1",
    }:
        deploy = exact_job(jobs, "deploy", label)
        public = exact_job(jobs, "public-validate", label)
        lock = step_conclusion(
            deploy, "Release transferred lock after protected validation", label
        )
        fence = step_conclusion(
            deploy, "Release live data maintenance fence", label
        )
        reenter = step_conclusion(
            deploy, "Re-enter maintenance after an incomplete deployment", label
        )
        if profile == "oci-failed-deploy-retained-hold-v1":
            if (
                deploy.get("conclusion") != "failure"
                or public.get("conclusion") != "skipped"
                or reenter != "success"
                or (lock, fence) not in {
                    ("skipped", "skipped"),
                    ("failure", "skipped"),
                    ("success", "failure"),
                }
            ):
                fail("failed deployment does not match the retained-hold profile")
        elif (
            deploy.get("conclusion") != "success"
            or public.get("conclusion") != "failure"
            or lock != "success"
            or fence != "success"
            or reenter != "skipped"
        ):
            fail("failed deployment does not match the released-runtime profile")
        validate_failed_deploy_artifacts(
            repository,
            run_id,
            subject_sha,
            artifact,
            dispatch_inputs,
            runtime_mode,
            label,
        )
        return
    activation = exact_job(jobs, "activate-and-validate", label)
    if (
        activation.get("conclusion") != "failure"
        or step_conclusion(
            activation, "Resolve reusable validation account", label
        ) != "success"
        or step_conclusion(
            activation, "Revoke and clean reusable validation account", label
        ) != "failure"
        or step_conclusion(
            activation, "Enforce dark mode unless activation committed", label
        ) != "success"
        or step_conclusion(
            activation, "Write final activation provenance", label
        ) != "success"
        or step_conclusion(
            activation, "Upload protected activation evidence", label
        ) != "success"
    ):
        fail("failed activation does not match the cleanup recovery profile")
    validate_failed_activation_artifacts(
        repository,
        run_id,
        subject_sha,
        artifact,
        dispatch_inputs,
        runtime_mode,
        label,
    )


def validate_checkpoint_profile(
    repository,
    binding,
    artifact,
    expected_head_sha,
    subject_sha,
    run_id,
    dispatch_inputs,
    runtime_mode,
    display_title,
):
    if runtime_mode not in {"k3s", "oke"}:
        fail("authoritative OCI runtime mode is required for checkpoint validation")
    raw = artifact_member(
        repository, artifact, "checkpoint.json", binding["input"]
    )
    try:
        checkpoint_text = raw.decode("utf-8")
        checkpoint = json.loads(checkpoint_text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("release checkpoint artifact is malformed JSON")
    if not isinstance(checkpoint, dict):
        fail("release checkpoint artifact is not an object")
    helper = Path(__file__).with_name("k3s_disk_recovery_stan.py")
    command = [
        sys.executable,
        str(helper),
        "validate-release-checkpoint",
        "--checkpoint-json",
        checkpoint_text,
        "--source-sha",
        expected_head_sha,
        "--producer-run-id",
        run_id,
        "--runtime-mode",
        runtime_mode,
    ]
    infrastructure_run = require_dispatch_run(
        dispatch_inputs, "infrastructure_run_id"
    )
    build_run = (
        dispatch_inputs.get("build_run_id")
        or dispatch_inputs.get("ghcr_build_run_id")
    )
    if not POSITIVE_INTEGER.fullmatch(str(build_run or "")):
        fail("release checkpoint profile requires its original build run")
    build_run = str(build_run)
    command.extend(("--infrastructure-run-id", infrastructure_run))
    command.extend(("--ghcr-build-run-id", build_run))
    if runtime_mode == "k3s":
        build_name = f"oci-image-provenance-{expected_head_sha}-{build_run}-1"
        build_artifact = exact_artifact(
            repository, str(build_run), build_name, "current build"
        )
        candidate_hash = candidate_images_checksum(
            artifact_member(
                repository, build_artifact, "images.tsv", "current build"
            )
        )
        command.extend(("--expected-candidate-images-sha256", candidate_hash))
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        fail("repository-fixed release checkpoint validator rejected the artifact")
    expected_titles = {
        "READY_NO_RECLAIM": {
            f"oci-infrastructure diagnose-disk k3s {expected_head_sha}",
            f"oci-infrastructure finalize k3s {expected_head_sha}",
        },
        "READY_RECLAIMED": {
            f"oci-infrastructure reclaim-disk k3s {expected_head_sha}"
        },
        "NOT_APPLICABLE": {
            f"oci-infrastructure finalize oke {expected_head_sha}"
        },
    }
    disposition = checkpoint.get("disposition")
    if display_title not in expected_titles.get(disposition, set()):
        fail("release checkpoint disposition does not match the producer title")
    if (
        display_title
        == f"oci-infrastructure finalize k3s {expected_head_sha}"
        and checkpoint.get("infrastructureRunId") != run_id
    ):
        fail("k3s finalize checkpoint does not bind its infrastructure run")
    validate_descendant_scope(expected_head_sha, subject_sha)


def validate_live_predecessor_profile(
    repository,
    binding,
    expected_head_sha,
    run_id,
    dispatch_inputs,
    runtime_mode,
):
    if binding["workflow"] != "oci-live-data-rollout.yml":
        return
    content = binding.get("artifactContent") or {}
    equality = content.get("equals") or {}
    if equality.get("schema_version") != "live-betting-v6":
        return
    phase = equality.get("phase")
    if phase not in {"dry-run", "apply-backfills", "apply-slip-index"}:
        fail(f"{binding['input']} predecessor phase is unsupported")
    checkpoint = parse_checkpoint_artifact(
        repository,
        dispatch_inputs,
        runtime_mode,
        f"{binding['input']} checkpoint",
    )
    evidence, _ = parse_live_v6_artifact(
        repository, run_id, binding["input"]
    )
    validate_live_v6_lineage(
        evidence,
        checkpoint,
        dispatch_inputs,
        run_id,
        expected_head_sha,
        phase,
        binding["input"],
    )


def validate_binding(
    repository,
    binding,
    subject_sha,
    run_id,
    dispatch_inputs=None,
    runtime_mode=None,
):
    validate_binding_shape(binding)
    if dispatch_inputs is None:
        dispatch_inputs = {}
    if not REPOSITORY.fullmatch(repository):
        fail("repository must be owner/name")
    if not FULL_SHA.fullmatch(subject_sha):
        fail("subject SHA must be a full lowercase commit SHA")
    if not POSITIVE_INTEGER.fullmatch(run_id):
        fail(f"{binding['input']} must be a positive run ID")
    expected_head_sha = subject_sha
    expected_head_input = binding.get("expectedHeadShaInput")
    if expected_head_input is not None:
        expected_head_sha = dispatch_inputs.get(expected_head_input)
        if not isinstance(expected_head_sha, str) or not FULL_SHA.fullmatch(
            expected_head_sha
        ):
            fail(
                f"{binding['input']} expected head input "
                f"{expected_head_input} is not a full SHA"
            )
    expected_conclusion = binding.get("expectedConclusion", "success")

    workflow = gh_api(
        f"repos/{repository}/actions/workflows/{binding['workflow']}"
    )
    if not isinstance(workflow, dict):
        fail(f"workflow metadata for {binding['workflow']} is not an object")
    workflow_id = workflow.get("id")
    if not isinstance(workflow_id, int):
        fail(f"unable to resolve workflow ID for {binding['workflow']}")

    # The base run endpoint reports the CURRENT attempt. Reading only
    # /attempts/1 is tautological: a rerun still exposes a first attempt, so a
    # rerun upstream would pass. Reject anything whose current attempt is not 1.
    base = gh_api(f"repos/{repository}/actions/runs/{run_id}")
    if not isinstance(base, dict):
        fail(f"{binding['input']} run response is not an object")
    if base.get("id") != int(run_id):
        fail(f"{binding['input']} run endpoint returned a different run ID")
    if base.get("run_attempt") != 1:
        fail(
            f"{binding['input']} run {run_id} has been rerun "
            f"(current attempt {base.get('run_attempt')})"
        )

    expected_path = f".github/workflows/{binding['workflow']}"
    checks = {
        "workflow_id": (base.get("workflow_id"), workflow_id),
        "path": (base.get("path"), expected_path),
        "repository": (
            (base.get("head_repository") or {}).get("full_name"),
            repository,
        ),
        "head_branch": (base.get("head_branch"), "master"),
        "head_sha": (base.get("head_sha"), expected_head_sha),
        "status": (base.get("status"), "completed"),
        "conclusion": (base.get("conclusion"), expected_conclusion),
    }
    for label, (observed, expected) in checks.items():
        if observed != expected:
            fail(
                f"{binding['input']} run {run_id} {label} is {observed!r}, "
                f"expected {expected!r}"
            )

    event = base.get("event")
    titles = binding["titleTemplates"]
    if event not in titles:
        fail(
            f"{binding['input']} run {run_id} event {event!r} is not permitted; "
            f"permitted events are {sorted(titles)}"
        )
    template = titles[event]
    if template is not None:
        expected_title = substitute(template, expected_head_sha, run_id)
        if base.get("display_title") != expected_title:
            fail(
                f"{binding['input']} run {run_id} title "
                f"{base.get('display_title')!r} is not {expected_title!r}"
            )

    # Bind attempt 1 explicitly and confirm it is the same immutable run.
    attempt = gh_api(f"repos/{repository}/actions/runs/{run_id}/attempts/1")
    if not isinstance(attempt, dict):
        fail(f"{binding['input']} first attempt response is not an object")
    if attempt.get("run_attempt") != 1:
        fail(f"{binding['input']} first attempt is not attempt 1")
    attempt_checks = {
        "id": (attempt.get("id"), base.get("id")),
        "workflow_id": (
            attempt.get("workflow_id"),
            base.get("workflow_id"),
        ),
        "path": (attempt.get("path"), base.get("path")),
        "repository": (
            (attempt.get("head_repository") or {}).get("full_name"),
            (base.get("head_repository") or {}).get("full_name"),
        ),
        "head_branch": (
            attempt.get("head_branch"),
            base.get("head_branch"),
        ),
        "head_sha": (attempt.get("head_sha"), base.get("head_sha")),
        "status": (attempt.get("status"), base.get("status")),
        "conclusion": (
            attempt.get("conclusion"),
            base.get("conclusion"),
        ),
        "event": (attempt.get("event"), base.get("event")),
        "display_title": (
            attempt.get("display_title"),
            base.get("display_title"),
        ),
    }
    for label, (observed, expected) in attempt_checks.items():
        if observed != expected:
            fail(
                f"{binding['input']} first attempt {label} differs from the run"
            )

    artifact_name = substitute(
        binding["artifactTemplate"], expected_head_sha, run_id
    )
    artifact = exact_artifact(
        repository, run_id, artifact_name, binding["input"]
    )
    load_artifact_content(
        repository,
        binding,
        artifact,
        expected_head_sha,
        run_id,
        dispatch_inputs,
    )
    validate_live_predecessor_profile(
        repository,
        binding,
        expected_head_sha,
        run_id,
        dispatch_inputs,
        runtime_mode,
    )
    validate_run_profile(
        repository,
        run_id,
        subject_sha,
        binding.get("runProfile"),
        binding["input"],
        artifact,
        dispatch_inputs,
        runtime_mode,
    )
    if binding.get("artifactValidatorProfile") == "oci-release-disk-checkpoint-v1":
        validate_checkpoint_profile(
            repository,
            binding,
            artifact,
            expected_head_sha,
            subject_sha,
            run_id,
            dispatch_inputs,
            runtime_mode,
            base.get("display_title"),
        )
    return {
        "artifactName": artifact_name,
        "createdAt": base.get("created_at"),
        "completedAt": base.get("updated_at"),
    }


def command_validate(args):
    binding = json.loads(args.binding)
    dispatch_inputs = json.loads(args.dispatch_inputs)
    if not isinstance(dispatch_inputs, dict):
        fail("dispatch inputs must be an object")
    facts = validate_binding(
        args.repository,
        binding,
        args.subject_sha,
        args.run_id,
        dispatch_inputs,
        args.runtime_mode,
    )
    print(
        f"upstream_binding={binding['input']} run={args.run_id} "
        f"artifact={facts['artifactName']}"
    )


def resolve_bindings(args):
    """Resolve bindings from an explicit policy or from the shared manifest.

    Fail closed when the requested operation key is absent, null, or an
    unexpectedly empty list, so a typo or a pruned manifest entry can never be
    read as "this operation has no prerequisites".
    """
    if args.manifest:
        if not args.operation:
            fail("--manifest requires --operation")
        try:
            with open(args.manifest, encoding="utf-8") as handle:
                manifest = json.load(handle)
        except OSError as error:
            fail(f"unable to read binding manifest: {error}")
        except json.JSONDecodeError:
            fail("binding manifest is not valid JSON")
        if not isinstance(manifest, dict):
            fail("binding manifest must be an object")
        if args.operation not in manifest:
            fail(f"binding manifest has no entry for {args.operation}")
        bindings = manifest[args.operation]
        if bindings is None:
            fail(f"binding manifest entry for {args.operation} is null")
        if not isinstance(bindings, list):
            fail(f"binding manifest entry for {args.operation} must be a list")
        if not bindings:
            fail(f"binding manifest entry for {args.operation} is empty")
        return bindings
    policy = json.loads(args.policy_json)
    if not isinstance(policy, dict):
        fail("policy must be an object")
    if "upstreamRunBindings" not in policy:
        fail("policy does not declare upstreamRunBindings")
    bindings = policy["upstreamRunBindings"]
    if bindings is None:
        fail("policy upstreamRunBindings is null")
    if not isinstance(bindings, list):
        fail("upstreamRunBindings must be a list")
    return bindings


def command_validate_all(args):
    inputs = json.loads(args.dispatch_inputs)
    if not isinstance(inputs, dict):
        fail("dispatch inputs must be an object")
    bindings = resolve_bindings(args)
    for binding in bindings:
        validate_binding_shape(binding)
    binding_names = [binding["input"] for binding in bindings]
    if len(binding_names) != len(set(binding_names)):
        fail("upstream bindings contain a duplicate input")
    chronology_inputs = set()
    for binding in bindings:
        after_input = binding.get("afterInput")
        if after_input is not None:
            if after_input not in binding_names:
                fail(
                    f"binding {binding['input']} depends on unknown input "
                    f"{after_input}"
                )
            chronology_inputs.update((binding["input"], after_input))
    validated = {}
    for binding in bindings:
        name = binding["input"]
        if name not in inputs:
            fail(f"dispatch inputs are missing bound value {name}")
        if inputs[name] in (None, ""):
            fail(f"dispatch input {name} is empty")
        facts = validate_binding(
            args.repository,
            binding,
            args.subject_sha,
            str(inputs[name]),
            inputs,
            args.runtime_mode,
        )
        if name in chronology_inputs:
            facts["createdAt"] = parse_timestamp(
                facts["createdAt"],
                f"{name} run creation time",
            )
            facts["completedAt"] = parse_timestamp(
                facts["completedAt"],
                f"{name} run completion time",
            )
            if facts["completedAt"] < facts["createdAt"]:
                fail(f"{name} run completion predates creation")
        after_input = binding.get("afterInput")
        if after_input is not None:
            if after_input not in validated:
                fail(
                    f"binding {name} depends on unvalidated input {after_input}"
                )
            if validated[after_input]["completedAt"] > facts["createdAt"]:
                fail(
                    f"binding {name} began before {after_input} completed"
                )
        validated[name] = facts
        print(f"upstream_binding={name} run={inputs[name]} status=OK")
    print(f"upstream_bindings_validated={len(bindings)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    one = sub.add_parser("validate")
    one.add_argument("--repository", required=True)
    one.add_argument("--binding", required=True)
    one.add_argument("--subject-sha", required=True)
    one.add_argument("--run-id", required=True)
    one.add_argument("--dispatch-inputs", default="{}")
    one.add_argument("--runtime-mode", default="")
    one.set_defaults(func=command_validate)

    every = sub.add_parser("validate-all")
    every.add_argument("--repository", required=True)
    every.add_argument("--policy-json", default="")
    every.add_argument("--manifest", default="")
    every.add_argument("--operation", default="")
    every.add_argument("--subject-sha", required=True)
    every.add_argument("--dispatch-inputs", required=True)
    every.add_argument("--runtime-mode", default="")
    every.set_defaults(func=command_validate_all)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
