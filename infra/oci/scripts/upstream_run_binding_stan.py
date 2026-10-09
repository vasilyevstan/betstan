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
import os
import re
import stat
import subprocess
import sys
import tempfile
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
    "oci-successful-held-handoff-v1",
}
CURRENT_SERVICES = {
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry",
}
RECOVERY_APPLICATION_SERVICES = CURRENT_SERVICES - {"telemetry"}
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
DEPLOYMENT_RECOVERY_INTENT_KEYS = {
    "schema_version",
    "source_sha",
    "source_ref",
    "deployment_workflow",
    "deployment_run_id",
    "deployment_run_attempt",
    "runtime_mode",
    "build_run_id",
    "candidate_images_sha256",
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
    "baseline_sha256",
    "baseline_capture_run_id",
    "baseline_recovery_run_id",
    "baseline_recovery_source_sha",
}
DEPLOYMENT_FAILURE_LINEAGE_KEYS = {
    "schema_version",
    "source_sha",
    "deployment_run_id",
    "deployment_run_attempt",
    "intent_sha256",
    "workflow_result",
    "lock_release_outcome",
    "fence_release_outcome",
    "rehold_outcome",
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
LIVE_RESUME_AUTHORITY_V2_KEYS = {
    "schema_version",
    "applied_data_run_id",
    "applied_source_sha",
    "failed_deploy_run_id",
    "resume_maintenance_mode",
    "failed_deploy_job_conclusion",
    "public_validate_job_conclusion",
    "lock_release_step_conclusion",
    "fence_release_step_conclusion",
    "rehold_step_conclusion",
    "failed_activation_run_id",
    "current_source_sha",
    "baseline_sha256",
    "runtime_images_sha256",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "disk_checkpoint_sha256",
    "disk_checkpoint_disposition",
    "application_change_scope",
    "status",
}
LIVE_RESUME_AUTHORITY_V3_KEYS = LIVE_RESUME_AUTHORITY_V2_KEYS | {
    "held_handoff_run_id", "held_handoff_source_sha", "held_handoff_evidence_sha256",
}
HELD_HANDOFF_CONFIRMATION = "CONTINUE SUCCESSFUL HELD LIVE DATA EXACT SHA"
HELD_HANDOFF_DEFAULTS = {
    "held_handoff_run_id": "0",
    "held_handoff_source_sha": "none",
}


def fail(message):
    print(f"upstream binding rejected: {message}", file=sys.stderr)
    raise SystemExit(1)


def live_data_native_inputs(inputs, expected_names):
    if not isinstance(inputs, dict):
        fail("live data native inputs must be an object")
    values = dict(inputs)
    expected = set(expected_names)
    held_fields = set(HELD_HANDOFF_DEFAULTS)
    if held_fields & expected:
        if not held_fields <= expected:
            fail("live data held-handoff input contract is incomplete")
        if (
            type(values.get("held_handoff_run_id")) is not str
            or POSITIVE_INTEGER.fullmatch(values["held_handoff_run_id"]) is None
            or type(values.get("held_handoff_source_sha")) is not str
            or FULL_SHA.fullmatch(values["held_handoff_source_sha"]) is None
            or values.get("confirmation") != HELD_HANDOFF_CONFIRMATION
        ):
            fail("live data held-handoff native inputs are invalid")
    elif held_fields & values.keys():
        if any(type(values.get(key)) is not str or values[key] != value
               for key, value in HELD_HANDOFF_DEFAULTS.items()):
            fail("legacy live data inputs require exact neutral held-handoff defaults")
        for key in held_fields:
            del values[key]
    if set(values) != expected or any(type(value) is not str for value in values.values()):
        fail("live data native input key set or types are invalid")
    return values


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


def _artifact_download_diagnostic(stderr):
    try:
        text = (stderr or b"").decode("utf-8").strip()
    except UnicodeDecodeError:
        return "unclassified"
    prefix = r'(?:gh: )?(?:(?:Get|Head) "[^"\r\n]+": )?'
    signatures = (
        (r"net/http: TLS handshake timeout", "tls-handshake-timeout"),
        (
            r"context deadline exceeded(?: \(Client\.Timeout exceeded while awaiting headers\))?",
            "deadline-exceeded",
        ),
        (r"i/o timeout", "io-timeout"),
    )
    matches = [
        code for signature, code in signatures
        if re.fullmatch(prefix + signature, text)
    ]
    return matches[0] if len(matches) == 1 else "unclassified"


def gh_api_bytes(path):
    if re.fullmatch(r"repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/artifacts/[1-9][0-9]*/zip", path):
        request_kind = "artifact-zip"
    elif re.fullmatch(r"repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/jobs/[1-9][0-9]*/logs", path):
        request_kind = "job-log"
    elif re.fullmatch(r"repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[1-9][0-9]*/attempts/1/logs", path):
        request_kind = "attempt-log-zip"
    else:
        request_kind = "unrecognized"
    for attempt in range(1, ARTIFACT_DOWNLOAD_ATTEMPTS + 1):
        captured_stderr = None
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
                captured_stderr = result.stderr
                classification, status, retryable = (
                    _classify_artifact_download_failure(
                        result.returncode, result.stderr
                    )
                )
        disposition = (
            "retry" if attempt < ARTIFACT_DOWNLOAD_ATTEMPTS else "exhausted"
        ) if retryable else "not-retryable"
        diagnostic = (
            _artifact_download_diagnostic(captured_stderr)
            if classification == "network" else "unclassified"
        )
        message = f"artifact download classification={classification}"
        if status is not None:
            message += f" status={status}"
        message += (
            f" attempt={attempt}/{ARTIFACT_DOWNLOAD_ATTEMPTS}"
            f" disposition={disposition}"
            f" request_kind={request_kind} diagnostic={diagnostic}"
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
    held_profile = run_profile == "oci-successful-held-handoff-v1"
    if held_profile:
        if (
            expected_conclusion != "success"
            or binding["input"] != "held_handoff_run_id"
            or binding.get("expectedHeadShaInput") != "held_handoff_source_sha"
            or binding["workflow"] != "oci-live-data-rollout.yml"
        ):
            fail("successful held-handoff profile has a substituted binding")
    elif (expected_conclusion == "failure") != (run_profile is not None):
        fail("failure conclusions are permitted only with a fixed recovery runProfile")
    if run_profile is not None and not held_profile:
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


def artifact_files(
    repository,
    artifact,
    label,
    *,
    allowed_empty_suffixes=frozenset(),
):
    artifact_id = artifact.get("id")
    if type(artifact_id) is not int or artifact_id < 1:
        fail(f"{label} artifact has an invalid ID")
    archive = gh_api_bytes(
        f"repos/{repository}/actions/artifacts/{artifact_id}/zip"
    )
    return zip_files(archive, label, allowed_empty_suffixes=allowed_empty_suffixes)


def zip_files(
    archive, label, *, allowed_empty_suffixes=frozenset(), require_original_names=False,
):
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            infos = bundle.infolist()
            files = {}
            total_size = 0
            for info in infos:
                if require_original_names and info.orig_filename != info.filename:
                    fail(f"{label} native log archive contains a modified entry name")
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
                empty_allowed = any(
                    normalized == suffix
                    or normalized.endswith(f"/{suffix}")
                    for suffix in allowed_empty_suffixes
                )
                if (
                    (info.file_size < 1 and not empty_allowed)
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


def parse_live_v6_artifact(repository, run_id, label, *, include_files=False):
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
    if include_files:
        return values, manifest_sha256, files
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


def parse_deployment_recovery_artifact(
    repository,
    deployment_run,
    subject_sha,
    dispatch_inputs,
    checkpoint,
    predecessor,
    predecessor_manifest_sha256,
    baseline_manifest_sha256,
    runtime_mode,
    lock_outcome,
    fence_outcome,
    rehold_outcome,
    label,
    *,
    baseline_capture_run_id=None,
):
    artifact = exact_artifact(
        repository,
        deployment_run,
        f"oci-deploy-recovery-authority-{deployment_run}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    validate_checksum_manifest(files, label)
    expected_files = {
        "deployment-intent.env",
        "deployment-intent.sha256",
        "failure-lineage.env",
        "images.tsv",
        "SHA256SUMS",
    }
    if exact_basename_set(files) != expected_files or len(files) != len(expected_files):
        fail(f"{label} artifact has an unexpected file set")
    _, intent_raw = unique_artifact_file(
        files, "deployment-intent.env", label
    )
    intent = parse_env(
        intent_raw,
        f"{label} intent",
        DEPLOYMENT_RECOVERY_INTENT_KEYS,
    )
    _, seal_raw = unique_artifact_file(
        files, "deployment-intent.sha256", label
    )
    intent_sha256 = hashlib.sha256(intent_raw).hexdigest()
    if seal_raw != f"{intent_sha256}  deployment-intent.env\n".encode():
        fail(f"{label} pre-mutation intent seal differs")
    _, failure_raw = unique_artifact_file(files, "failure-lineage.env", label)
    failure = parse_env(
        failure_raw,
        f"{label} failure lineage",
        DEPLOYMENT_FAILURE_LINEAGE_KEYS,
    )
    _, images_raw = unique_artifact_file(files, "images.tsv", label)

    checkpoint_source = require_dispatch_sha(
        dispatch_inputs, "checkpoint_source_sha"
    )
    build_run = require_dispatch_run(dispatch_inputs, "build_run_id")
    infrastructure_run = require_dispatch_run(
        dispatch_inputs, "infrastructure_run_id"
    )
    predecessor_run = predecessor["workflow_run_id"]
    expected_intent = {
        "schema_version": "oci-deployment-recovery-authority-v1",
        "source_sha": subject_sha,
        "source_ref": "refs/heads/master",
        "deployment_workflow": "oci-production-deploy",
        "deployment_run_id": deployment_run,
        "deployment_run_attempt": "1",
        "runtime_mode": runtime_mode,
        "build_run_id": build_run,
        "candidate_images_sha256": hashlib.sha256(images_raw).hexdigest(),
        "data_run_id": predecessor_run,
        "data_run_attempt": "1",
        "data_evidence_sha256": predecessor_manifest_sha256,
        "infrastructure_run_id": infrastructure_run,
        "infrastructure_run_attempt": "1",
        "checkpoint_source_sha": checkpoint_source,
        "disk_checkpoint_run_id": checkpoint["producerRunId"],
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": checkpoint["disposition"],
        "baseline_sha256": baseline_manifest_sha256,
        "baseline_capture_run_id": baseline_capture_run_id or predecessor_run,
        "baseline_recovery_run_id": predecessor["baseline_recovery_run_id"],
        "baseline_recovery_source_sha":
            predecessor["baseline_recovery_source_sha"],
    }
    for key, expected_value in expected_intent.items():
        if intent.get(key) != expected_value:
            fail(f"{label} intent field {key} differs from the exact lineage")

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
    if intent["infrastructure_provenance_sha256"] != infrastructure_sha256:
        fail(f"{label} infrastructure checksum differs")

    expected_failure = {
        "schema_version": "oci-deployment-failure-lineage-v1",
        "source_sha": subject_sha,
        "deployment_run_id": deployment_run,
        "deployment_run_attempt": "1",
        "intent_sha256": intent_sha256,
        "workflow_result": "failure",
        "lock_release_outcome": lock_outcome,
        "fence_release_outcome": fence_outcome,
        "rehold_outcome": rehold_outcome,
    }
    for key, expected_value in expected_failure.items():
        if failure.get(key) != expected_value:
            fail(f"{label} failure field {key} differs from the exact run")


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
    profile,
    lock_outcome,
    fence_outcome,
    rehold_outcome,
    label,
    *,
    pre_runtime=False,
    seen=None,
):
    checkpoint = parse_checkpoint_artifact(
        repository, dispatch_inputs, runtime_mode, f"{label} checkpoint"
    )
    predecessor_run = require_dispatch_run(dispatch_inputs, "prerequisite_run_id")
    predecessor, predecessor_manifest_sha256, predecessor_files = parse_live_v6_artifact(
        repository, predecessor_run, f"{label} predecessor", include_files=True
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

    root_run, root_source = predecessor_run, subject_sha
    predecessor_authority = parse_resume_authority(
        predecessor_files, predecessor, f"{label} predecessor"
    )
    if predecessor_authority is not None and (
        predecessor_authority["resume_maintenance_mode"] == "pre-runtime-hold"
    ):
        root_run, root_source = validate_pre_runtime_resume_chain(
            repository, predecessor_run, runtime_mode, seen=seen
        )
    if pre_runtime:
        native = failed_deploy_native_inputs(repository, run_id, subject_sha, label)
        expected_native = {
            "approved_sha": subject_sha,
            "build_run_id": predecessor["build_run_id"],
            "infrastructure_run_id": predecessor["infrastructure_run_id"],
            "data_run_id": predecessor_run,
            "checkpoint_source_sha": predecessor["checkpoint_source_sha"],
            "disk_checkpoint_run_id": predecessor["disk_checkpoint_run_id"],
            "baseline_recovery_run_id": predecessor["baseline_recovery_run_id"],
            "baseline_recovery_source_sha": predecessor["baseline_recovery_source_sha"],
            "confirmation": "DEPLOY OCI EXACT SHA",
        }
        if native != expected_native:
            fail(f"{label} native failed dispatch differs from the original data tuple")
        dependency_completions = []
        for dependency, workflow, event in (
            ("build_run_id", "oci-production-build.yml", "workflow_run"),
            ("infrastructure_run_id", "oci-infrastructure.yml", "workflow_dispatch"),
            ("disk_checkpoint_run_id", "oci-infrastructure.yml", "workflow_dispatch"),
        ):
            metadata = fixed_run_metadata(
                repository, native[dependency], workflow, "success", label, event
            )
            if metadata["head_sha"] != native["checkpoint_source_sha"]:
                fail(f"{label} original release dependency source differs")
            dependency_completions.append(parse_timestamp(metadata.get("updated_at"), label))
        parse_infrastructure_provenance(
            repository, native["checkpoint_source_sha"],
            native["infrastructure_run_id"], native["build_run_id"], label
        )
        prior = require_fixed_run(
            repository, predecessor_run, "oci-live-data-rollout.yml", "success",
            subject_sha, f"oci-live-data apply-slip-index {subject_sha}", label,
        )
        if any(
            completion > parse_timestamp(prior.get("created_at"), label)
            for completion in dependency_completions
        ):
            fail(f"{label} original release dependency postdates its data run")
        failed = require_fixed_run(
            repository, run_id, "oci-production-deploy.yml", "failure",
            subject_sha, f"oci-deploy {subject_sha}", label,
        )
        if parse_timestamp(prior.get("updated_at"), label) > parse_timestamp(
            failed.get("created_at"), label
        ):
            fail(f"{label} failed deployment predates its data handoff")
        if predecessor_authority is not None and (
            predecessor_authority["resume_maintenance_mode"] != "pre-runtime-hold"
        ):
            fail("pre-runtime hold cannot substitute a post-runtime recovery lineage")
        artifact = exact_artifact(
            repository, root_run, f"oci-live-data-baselines-{root_run}-1", label
        )
        baseline_files = original_before_baseline(
            artifact_files(repository, artifact, label), label
        )
    else:
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
        baseline["baseline_capture_run_id"] != root_run
        or baseline["baseline_capture_run_attempt"] != "1"
        or baseline["registry_provider"] != "ghcr"
        or baseline["registry_host"] != "ghcr.io"
        or baseline["registry_repository"] != APPLICATION_REPOSITORY
        or baseline["registry_public_anonymous"] != "true"
        or baseline_manifest_sha256 != predecessor["baseline_sha256"]
    ):
        fail(f"{label} rollback baseline does not match its predecessor capture")
    if pre_runtime:
        return {
            "resume_maintenance_mode": "pre-runtime-hold",
            "baseline_run_id": root_run,
            "baseline_artifact_name": f"oci-live-data-baselines-{root_run}-1",
            "applied_data_run_id": root_run,
            "applied_source_sha": root_source,
            "_baseline_files": baseline_files,
        }
    if profile == "oci-failed-deploy-retained-hold-v1":
        parse_deployment_recovery_artifact(
            repository,
            run_id,
            subject_sha,
            dispatch_inputs,
            checkpoint,
            predecessor,
            predecessor_manifest_sha256,
            baseline_manifest_sha256,
            runtime_mode,
            lock_outcome,
            fence_outcome,
            rehold_outcome,
            f"{label} recovery authority",
            baseline_capture_run_id=root_run,
        )
    else:
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


def require_fixed_run(
    repository,
    run_id,
    workflow,
    conclusion,
    head_sha,
    title,
    label,
):
    metadata = fixed_run_metadata(
        repository, run_id, workflow, conclusion, label
    )
    if metadata.get("head_sha") != head_sha:
        fail(f"{label} source SHA differs from its artifact lineage")
    if metadata.get("display_title") != title:
        fail(f"{label} title differs from its fixed workflow title")
    return metadata


def parse_resume_authority(files, predecessor, label):
    matches = [
        raw
        for path, raw in files.items()
        if path == "resume-authority.env"
        or path.endswith("/resume-authority.env")
    ]
    if not matches:
        return None
    if len(matches) != 1:
        fail(f"{label} has duplicate resume authority")
    authority = parse_env(matches[0], f"{label} resume authority")
    version = authority.get("schema_version")
    required_keys = (
        LIVE_RESUME_AUTHORITY_V3_KEYS if version == "live-betting-data-resume-v3"
        else LIVE_RESUME_AUTHORITY_V2_KEYS
    )
    if set(authority) != required_keys or version not in {
        "live-betting-data-resume-v2", "live-betting-data-resume-v3",
    }:
        fail(f"{label} resume authority version or key set is invalid")
    expected = {
        "schema_version": version,
        "current_source_sha": predecessor["source_sha"],
        "baseline_sha256": predecessor["baseline_sha256"],
        "checkpoint_source_sha": predecessor["checkpoint_source_sha"],
        "disk_checkpoint_run_id": predecessor["disk_checkpoint_run_id"],
        "disk_checkpoint_sha256": predecessor["disk_checkpoint_sha256"],
        "disk_checkpoint_disposition":
            predecessor["disk_checkpoint_disposition"],
        "application_change_scope": "github-infra-docs-only",
        "status": "PASS",
        "failed_activation_run_id": "0",
    }
    for key, expected_value in expected.items():
        if authority.get(key) != expected_value:
            fail(f"{label} resume authority substituted {key}")
    for key in {"applied_data_run_id", "failed_deploy_run_id"}:
        if POSITIVE_INTEGER.fullmatch(authority[key]) is None:
            fail(f"{label} resume authority has an invalid {key}")
    if FULL_SHA.fullmatch(authority["applied_source_sha"]) is None:
        fail(f"{label} resume authority applied source is invalid")
    if version == "live-betting-data-resume-v3":
        if (
            POSITIVE_INTEGER.fullmatch(authority["held_handoff_run_id"]) is None
            or FULL_SHA.fullmatch(authority["held_handoff_source_sha"]) is None
            or re.fullmatch(r"[0-9a-f]{64}", authority["held_handoff_evidence_sha256"]) is None
            or authority["held_handoff_run_id"] in {
                authority["applied_data_run_id"], authority["failed_deploy_run_id"],
                predecessor["workflow_run_id"],
            }
            or authority["resume_maintenance_mode"] != "pre-runtime-hold"
        ):
            fail(f"{label} held-handoff authority roles are invalid")
        unique_artifact_file(files, "held-handoff-history.json", label)
        unique_artifact_file(files, "held-handoff-transfer.json", label)
    if re.fullmatch(r"[0-9a-f]{64}", authority["runtime_images_sha256"]) is None:
        fail(f"{label} resume authority runtime images checksum is invalid")
    _, resume_images = unique_artifact_file(
        files, "resume-images.tsv", f"{label} resume images"
    )
    if (
        hashlib.sha256(resume_images).hexdigest()
        != authority["runtime_images_sha256"]
    ):
        fail(f"{label} resume authority runtime images were substituted")
    outcome = (
        authority["failed_deploy_job_conclusion"],
        authority["public_validate_job_conclusion"],
        authority["lock_release_step_conclusion"],
        authority["fence_release_step_conclusion"],
        authority["rehold_step_conclusion"],
    )
    mode = authority["resume_maintenance_mode"]
    if mode == "pre-runtime-hold":
        if outcome != ("failure", "skipped", "skipped", "skipped", "skipped"):
            fail(f"{label} pre-runtime resume authority outcome is invalid")
    elif mode == "released-runtime":
        if outcome != ("success", "failure", "success", "success", "skipped"):
            fail(f"{label} released resume authority outcome is invalid")
    elif mode == "retained-hold":
        if (
            outcome[0:2] != ("failure", "skipped")
            or outcome[2:4] not in {
                ("skipped", "skipped"),
                ("failure", "skipped"),
                ("success", "failure"),
            }
            or outcome[4] != "success"
        ):
            fail(f"{label} retained resume authority outcome is invalid")
    else:
        fail(f"{label} resume authority maintenance mode is invalid")
    return authority


def original_before_baseline(files, label):
    manifests = [
        path for path in files
        if path.endswith("/oci-data-baseline-before/SHA256SUMS")
        or path == "oci-data-baseline-before/SHA256SUMS"
    ]
    if len(manifests) != 1:
        fail(f"{label} must contain one original before baseline")
    prefix = manifests[0].removesuffix("SHA256SUMS")
    selected = {
        path.removeprefix(prefix): raw
        for path, raw in files.items() if path.startswith(prefix)
    }
    validate_checksum_manifest(selected, label)
    return selected


def failed_deploy_native_inputs(repository, run_id, source_sha, label, *, resume_dispatch=False):
    """Read only runner-generated environment in the exact failed step log.

    Raw logs stay in captured process memory: never persist or echo them.
    """
    jobs = jobs_for_run(repository, run_id, label)
    deploy = exact_job(jobs, "rollout" if resume_dispatch else "deploy", label)
    job_id = deploy.get("id")
    if type(job_id) is not int or job_id < 1 or deploy.get("run_id") != int(run_id):
        fail(f"{label} native job identity is invalid")
    step_name = (
        "Validate exact SHA phase and trusted upstream runs" if resume_dispatch
        else "Verify immutable image and infrastructure provenance"
    )
    step = [
        item for item in deploy["steps"]
        if item.get("name") == step_name
    ]
    if len(step) != 1:
        fail(f"{label} native provenance step is ambiguous")
    if step[0].get("conclusion") != ("success" if resume_dispatch else "failure"):
        fail(f"{label} native input step outcome differs")
    start = parse_timestamp(step[0].get("started_at"), label)
    end = parse_timestamp(step[0].get("completed_at"), label)
    if end < start:
        fail(f"{label} native provenance step chronology is invalid")
    files = zip_files(
        gh_api_bytes(f"repos/{repository}/actions/runs/{run_id}/attempts/1/logs"),
        label, require_original_names=True,
    )
    matches = [
        raw for name, raw in files.items()
        if re.fullmatch(r"-?[0-9]+_" + re.escape(deploy["name"]) + r"\.txt", name)
    ]
    if len(matches) != 1:
        fail(f"{label} native full-job log is absent or ambiguous")
    try:
        raw = matches[0].decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} native log encoding is invalid")
    lines = []
    timestamp = None
    for line in raw.splitlines():
        match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\S+Z) (.*)", line)
        if match:
            timestamp = re.sub(r"(\.\d{6})\d+(?=Z$)", r"\1", match[1])
        if timestamp and start <= parse_timestamp(timestamp, label) < end + dt.timedelta(seconds=1):
            lines.append(match[2] if match else line)
    blocks = []
    current = None
    in_step_group = False
    for line in lines:
        line = re.sub(r"\x1b\[[0-9;]*m", "", line)
        if line.startswith("##[group]"):
            if current is not None:
                fail(f"{label} native environment group is incomplete")
            in_step_group = line == "##[group]Run set -euo pipefail"
        elif line == "##[endgroup]":
            if in_step_group and current is not None:
                blocks.append("\n".join(current))
                current = None
            in_step_group = False
        elif in_step_group and line in {"env:", "  env:"}:
            if current is not None:
                fail(f"{label} native environment is ambiguous")
            current = []
        elif in_step_group and current is not None:
            current.append(line)
    if len(blocks) != 1 or current is not None:
        fail(f"{label} native failed-step environment is absent or ambiguous")
    text = blocks[0]
    matches = list(re.finditer(r"(?m)^  DISPATCH_INPUTS: ", text))
    if len(matches) != 1:
        fail(f"{label} native dispatch inputs are absent or duplicated")
    def unique_pairs(pairs):
        values = {}
        for key, value in pairs:
            if key in values:
                fail(f"{label} native dispatch input is duplicated")
            values[key] = value
        return values
    try:
        inputs, _ = json.JSONDecoder(object_pairs_hook=unique_pairs).raw_decode(
            text[matches[0].end():]
        )
    except (ValueError, TypeError):
        fail(f"{label} native dispatch input is malformed")
    mapping = {
        "approved_sha": "SOURCE_SHA", "build_run_id": "BUILD_RUN_ID",
        "infrastructure_run_id": "INFRASTRUCTURE_RUN_ID",
        "data_run_id": "DATA_RUN_ID", "checkpoint_source_sha": "CHECKPOINT_SOURCE_SHA",
        "disk_checkpoint_run_id": "DISK_CHECKPOINT_RUN_ID",
        "baseline_recovery_run_id": "BASELINE_RECOVERY_RUN_ID",
        "baseline_recovery_source_sha": "BASELINE_RECOVERY_SOURCE_SHA",
        "confirmation": "CONFIRMATION",
    }
    if resume_dispatch:
        del mapping["data_run_id"]
        mapping.update({
            "resume_source_sha": "RESUME_SOURCE_SHA", "phase": "PHASE",
            "prerequisite_run_id": "PREREQUISITE_RUN_ID",
            "failed_deploy_run_id": "FAILED_DEPLOY_RUN_ID",
            "failed_activation_run_id": "FAILED_ACTIVATION_RUN_ID",
            "failed_activation_user_id": "FAILED_ACTIVATION_USER_ID",
        })
        if isinstance(inputs, dict) and inputs.get("confirmation") == HELD_HANDOFF_CONFIRMATION:
            mapping.update({key: key.upper() for key in HELD_HANDOFF_DEFAULTS})
        normalized = live_data_native_inputs(inputs, mapping)
        mapping.update({key: key.upper() for key in HELD_HANDOFF_DEFAULTS if key in inputs})
    else:
        normalized = inputs
    if not isinstance(inputs, dict) or set(inputs) != set(mapping):
        fail(f"{label} native dispatch input key set is invalid")
    for key, env_key in mapping.items():
        values = re.findall(rf"(?m)^  {env_key}: ([^\r\n]*)$", text)
        if len(values) != 1 or values[0] != inputs[key]:
            fail(f"{label} native environment disagrees with dispatch input {key}")
    if inputs["approved_sha"] != source_sha:
        fail(f"{label} native dispatch source is substituted")
    for key in (
        "build_run_id", "infrastructure_run_id", "disk_checkpoint_run_id",
        "prerequisite_run_id" if resume_dispatch else "data_run_id",
    ):
        require_dispatch_run(inputs, key)
    require_dispatch_sha(inputs, "checkpoint_source_sha")
    return normalized


def validate_held_handoff_native(
    repository, run_id, source_sha, dispatch_inputs, runtime_mode, label,
):
    metadata = require_fixed_run(
        repository, run_id, "oci-live-data-rollout.yml", "success", source_sha,
        f"oci-live-data apply-slip-index {source_sha}", label,
    )
    if runtime_mode not in {"k3s", "oke"}:
        fail(f"{label} held-handoff runtime mode is unsupported")
    for path, expected_blob in (
        (".github/workflows/oci-live-data-rollout.yml",
         "27a98e345050fefb799c706fde03d8f79e14ed6c"),
        ("infra/oci/scripts/live-betting-data-rollout-stan.sh",
         "1752489383424fa4bd55bbc7d36e4cac95e14d31"),
    ):
        observed = gh_api(f"repos/{repository}/contents/{path}?ref={source_sha}")
        if not isinstance(observed, dict) or observed.get("sha") != expected_blob:
            fail(f"{label} does not have the known historical held-handoff producer")
    names = (
        "Initialize isolated OCI data paths",
        "Checkout approved current master commit",
        "Validate exact SHA phase and trusted upstream runs",
        "Reject competing production activity",
        "Download exact OCI image provenance",
        "Download exact OCI infrastructure provenance",
        "Download exact release disk checkpoint",
        "Download prerequisite data evidence",
        "Download failed deploy protected baseline",
        "Download explicitly selected recovery baseline authority",
        "Bind historical recovery source through its exact artifact",
        "Verify immutable release and phase provenance",
        "Install pinned OCI CLI",
        "Verify OKE identity",
        "Verify k3s identity",
        "Reconcile expired and authorize current runner IPv4",
        "Configure kubectl from exact cluster OCID",
        "Open ephemeral OCI Bastion access to k3s",
        "Verify exact failed-deploy resume state",
        "Capture and validate pre-mutation rollback baseline",
        "Revalidate exact release disk checkpoint before lock mutation",
        "Acquire database operation lock",
        "Enter or re-establish live data maintenance",
        "Demote and verify exact retained live-acceptance account",
        "Delete exact orphaned live-acceptance slips",
        "Execute exact-digest live data phase",
        "Restore runtime or verify final deploy handoff",
        "Capture post-phase runtime baseline",
        "Require executed data-step evidence",
        "Upload exact sanitized data evidence",
        "Upload protected rollout baselines",
        "Restore runtime or retain hold if final handoff packaging failed",
        "Release database operation lock unless handed to deploy",
        "Revoke exact runner rule",
        "Close ephemeral OCI Bastion access",
        "Remove isolated OCI client state",
    )
    expected_names = [
        "Set up job", *names, "Post Checkout approved current master commit", "Complete job",
    ]
    jobs = jobs_for_run(repository, run_id, label)
    if len(jobs) != 1:
        fail(f"{label} held-handoff job inventory is not exact")
    job = exact_job(jobs, "rollout", label)
    if (
        type(job.get("id")) is not int or job["id"] < 1
        or job.get("run_id") != int(run_id)
        or job.get("status") != "completed"
        or job.get("conclusion") != "success"
    ):
        fail(f"{label} held-handoff job did not complete successfully")
    created = parse_timestamp(metadata.get("created_at"), label)
    started = parse_timestamp(job.get("started_at"), label)
    completed = parse_timestamp(job.get("completed_at"), label)
    if not created <= started <= completed <= parse_timestamp(metadata.get("updated_at"), label):
        fail(f"{label} held-handoff job chronology is invalid")
    if [step.get("name") for step in job["steps"]] != expected_names:
        fail(f"{label} held-handoff step inventory is not exact")
    skipped = {
        "Download failed deploy protected baseline",
        "Demote and verify exact retained live-acceptance account",
        "Delete exact orphaned live-acceptance slips",
        "Capture post-phase runtime baseline",
        "Restore runtime or retain hold if final handoff packaging failed",
        "Release database operation lock unless handed to deploy",
    }
    if str(dispatch_inputs.get("baseline_recovery_run_id")) == "0":
        skipped.update({
            "Download explicitly selected recovery baseline authority",
            "Bind historical recovery source through its exact artifact",
        })
    skipped.update({
        "Verify OKE identity", "Reconcile expired and authorize current runner IPv4",
        "Configure kubectl from exact cluster OCID", "Revoke exact runner rule",
    } if runtime_mode == "k3s" else {
        "Verify k3s identity", "Open ephemeral OCI Bastion access to k3s",
        "Revalidate exact release disk checkpoint before lock mutation",
        "Close ephemeral OCI Bastion access",
    })
    for number, step in zip((*range(1, 38), 74, 75), job["steps"]):
        if (
            type(step.get("number")) is not int or step["number"] != number
            or step.get("status") != "completed"
            or step.get("conclusion") != ("skipped" if step["name"] in skipped else "success")
        ):
            fail(f"{label} held-handoff step outcome is invalid")
        if step["name"] in names and step["name"] not in skipped:
            step_started = parse_timestamp(step.get("started_at"), label)
            step_completed = parse_timestamp(step.get("completed_at"), label)
            if not started <= step_started <= step_completed <= completed:
                fail(f"{label} held-handoff step chronology is invalid")
    native = failed_deploy_native_inputs(
        repository, run_id, source_sha, label, resume_dispatch=True,
    )
    expected = {
        key: dispatch_inputs.get(key) for key in (
            "resume_source_sha", "build_run_id", "infrastructure_run_id",
            "checkpoint_source_sha", "disk_checkpoint_run_id", "prerequisite_run_id",
            "baseline_recovery_run_id", "baseline_recovery_source_sha", "failed_deploy_run_id",
        )
    }
    expected.update({
        "approved_sha": source_sha, "phase": "apply-slip-index",
        "failed_activation_run_id": "0", "failed_activation_user_id": "0",
        "confirmation": "RESUME APPLIED LIVE DATA EXACT SHA",
    })
    if native != expected:
        fail(f"{label} held handoff substituted the original root dispatch tuple")
    return metadata


def held_handoff_history(repository, held, subject_sha, successor_run_id=""):
    policy = subprocess.run(
        ["git", "show", f"{subject_sha}:infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"],
        capture_output=True, text=True, check=False,
    )
    if policy.returncode:
        fail("held-handoff source-bound policy inventory is unavailable")
    result = subprocess.run(
        ["bash", "-s", "--", "workflows"], input=policy.stdout,
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        fail("held-handoff protected workflow inventory is unavailable")
    workflows = result.stdout.splitlines()
    if not workflows or len(workflows) != len(set(workflows)) or any(
        re.fullmatch(r"[a-z0-9-]+\.yml", name) is None for name in workflows
    ):
        fail("held-handoff protected workflow inventory is invalid")
    workflows = sorted(set(workflows) - {
        "common-package-publish.yml", "production-build.yml", "oci-production-build.yml",
    })
    lower = parse_timestamp(held.get("created_at"), "held-handoff history")
    cutoff = None
    if successor_run_id:
        if POSITIVE_INTEGER.fullmatch(successor_run_id) is None:
            fail("held-handoff successor run is invalid")
        latest = gh_api(f"repos/{repository}/actions/runs/{successor_run_id}")
        first = gh_api(f"repos/{repository}/actions/runs/{successor_run_id}/attempts/1")
        workflow = gh_api(f"repos/{repository}/actions/workflows/oci-live-data-rollout.yml")
        expected = {
            "id": int(successor_run_id), "run_attempt": 1, "head_sha": subject_sha,
            "path": ".github/workflows/oci-live-data-rollout.yml",
            "workflow_id": workflow.get("id"), "event": "workflow_dispatch",
            "head_branch": "master", "display_title": f"oci-live-data apply-slip-index {subject_sha}",
        }
        for native in (latest, first):
            if not isinstance(native, dict) or any(native.get(k) != v for k, v in expected.items()):
                fail("held-handoff successor native identity differs")
            if (native.get("head_repository") or {}).get("full_name") != repository:
                fail("held-handoff successor repository differs")
        if latest.get("status") != first.get("status") or latest.get("conclusion") != first.get("conclusion"):
            fail("held-handoff successor attempt state differs")
        if first.get("status") == "completed" and first.get("conclusion") != "success":
            fail("held-handoff completed successor is not successful")
        if parse_timestamp(held.get("updated_at"), "held handoff") > parse_timestamp(
            first.get("created_at"), "successor",
        ):
            fail("held-handoff successor predates the held handoff")
        if first.get("status") in {"in_progress", "completed"}:
            job = exact_job(jobs_for_run(repository, successor_run_id, "successor"), "rollout", "successor")
            if (
                type(job.get("id")) is not int or job["id"] < 1
                or job.get("run_id") != int(successor_run_id)
                or job.get("status") != first["status"]
            ):
                fail("held-handoff successor cutoff belongs to another job")
            steps = [step for step in job["steps"]
                     if step.get("name") == "Validate exact SHA phase and trusted upstream runs"]
            if len(steps) != 1:
                fail("held-handoff successor cutoff is ambiguous")
            cutoff = parse_timestamp(steps[0].get("started_at"), "successor cutoff")
            if not parse_timestamp(first.get("created_at"), "successor") <= parse_timestamp(
                job.get("started_at"), "successor job",
            ) <= cutoff:
                fail("held-handoff successor cutoff chronology is invalid")
        elif first.get("status") not in {"queued", "waiting", "requested", "pending"}:
            fail("held-handoff successor state is invalid")
    counts = {}
    for workflow in workflows:
        endpoint = f"repos/{repository}/actions/workflows/{workflow}/runs?per_page=100"
        if cutoff is not None:
            endpoint += "&created=%3C%3D" + cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
        pages = gh_api_pages(endpoint)
        totals = {page.get("total_count") for page in pages}
        if len(totals) != 1 or any(type(n) is not int or not 0 <= n < 1000 for n in totals):
            fail("held-handoff historical inventory is incomplete or exceeds its bound")
        rows = []
        for page in pages:
            if not isinstance(page.get("workflow_runs"), list):
                fail("held-handoff historical inventory is malformed")
            rows.extend(page["workflow_runs"])
        if len(rows) != next(iter(totals)):
            fail("held-handoff historical inventory is incomplete")
        ids = set()
        for row in rows:
            if (
                not isinstance(row, dict) or type(row.get("id")) is not int
                or row["id"] < 1 or row["id"] in ids
                or row.get("path") != f".github/workflows/{workflow}"
                or (row.get("head_repository") or {}).get("full_name") != repository
                or type(row.get("head_branch")) is not str or not row["head_branch"]
            ):
                fail("held-handoff historical inventory identity is invalid")
            ids.add(row["id"])
            created = parse_timestamp(row.get("created_at"), "historical run")
            updated = parse_timestamp(row.get("updated_at"), "historical run")
            if updated < created or cutoff is not None and created > cutoff:
                fail("held-handoff historical interval is inconsistent")
            if row["id"] in {held["id"], int(successor_run_id or "0")}:
                if workflow != "oci-live-data-rollout.yml":
                    fail("held-handoff historical owner is bound to another workflow")
                continue
            if row.get("head_branch") != "master":
                continue
            if updated >= lower:
                fail("an intervening protected production transition excludes this held handoff")
            if row.get("status") != "completed":
                fail("an unresolved historical production run excludes this held handoff")
        if workflow == "oci-live-data-rollout.yml":
            required_ids = {held["id"]}
            if successor_run_id:
                required_ids.add(int(successor_run_id))
            if not required_ids <= ids:
                fail("held-handoff history omitted an independently authenticated run")
        counts[workflow] = len(rows)
    return {
        "schema_version": "live-betting-held-handoff-history-v1",
        "repository": repository, "held_handoff_run_id": str(held["id"]),
        "held_handoff_source_sha": held["head_sha"],
        "successor_run_id": successor_run_id, "successor_source_sha": subject_sha,
        "start_at": held["created_at"],
        "cutoff_at": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ") if cutoff is not None else None,
        "workflow_counts": counts,
    }


def record_held_handoff_transfer(path, snapshot_path, held_run, held_source, run_id, source, stage, state):
    path, snapshot_path = Path(path), Path(snapshot_path)
    raw = snapshot_path.read_bytes()
    snapshot = json.loads(raw)
    expected = {
        "schema_version": "live-betting-held-handoff-transfer-v1",
        "held_handoff_run_id": held_run, "held_handoff_source_sha": held_source,
        "successor_run_id": run_id, "successor_source_sha": source,
        "snapshot_sha256": hashlib.sha256(raw).hexdigest(),
        "lock_uid": snapshot["metadata"]["uid"],
        "observed_resource_version": snapshot["metadata"]["resourceVersion"],
        "observed_fencing_generation": snapshot["data"]["fencing-generation"],
        "observed_lease_until_epoch": snapshot["data"]["lease-until-epoch"],
    }
    if (
        snapshot["data"].get("state") != "active"
        or snapshot["data"].get("holder") != f"live-data-{held_run}-1"
        or snapshot["data"].get("source-sha") != held_source
        or snapshot["data"].get("operation-id") != "live-data-apply-slip-index"
    ):
        fail("held-handoff transfer snapshot substituted the physical owner")
    if path.is_symlink():
        fail("held-handoff transfer evidence cannot be a symbolic link")
    if path.exists():
        record = json.loads(path.read_bytes())
        if any(record.get(key) != value for key, value in expected.items()):
            fail("held-handoff transfer snapshot or owner drifted")
    else:
        record = dict(expected, release_result="not-attempted", acquire_result="not-attempted",
                      verify_result="not-attempted")
    previous = tuple(record.get(f"{name}_result") for name in ("release", "acquire", "verify"))
    transitions = {
        ("release", "unconfirmed"): ("not-attempted", "not-attempted", "not-attempted"),
        ("release", "confirmed"): ("unconfirmed", "not-attempted", "not-attempted"),
        ("acquire", "unconfirmed"): ("confirmed", "not-attempted", "not-attempted"),
        ("acquire", "confirmed"): ("confirmed", "unconfirmed", "not-attempted"),
        ("verify", "unconfirmed"): ("confirmed", "confirmed", "not-attempted"),
        ("verify", "confirmed"): ("confirmed", "confirmed", "unconfirmed"),
    }
    if transitions.get((stage, state)) != previous:
        fail("held-handoff transfer evidence cannot replay or skip a transition")
    record[f"{stage}_result"] = state
    temporary = path.with_name(path.name + ".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(record, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def validate_held_handoff_transfer(transfer, authority, current):
    keys = {
        "schema_version", "held_handoff_run_id", "held_handoff_source_sha",
        "successor_run_id", "successor_source_sha", "snapshot_sha256", "lock_uid",
        "observed_resource_version", "observed_fencing_generation", "observed_lease_until_epoch",
        "release_result", "acquire_result", "verify_result",
    }
    if not isinstance(transfer, dict) or set(transfer) != keys:
        fail("held-handoff transfer evidence has an invalid key set")
    expected = {
        "schema_version": "live-betting-held-handoff-transfer-v1",
        "held_handoff_run_id": authority["held_handoff_run_id"],
        "held_handoff_source_sha": authority["held_handoff_source_sha"],
        "successor_run_id": str(current["id"]), "successor_source_sha": current["head_sha"],
        "release_result": "confirmed", "acquire_result": "confirmed", "verify_result": "confirmed",
    }
    if any(transfer[key] != value for key, value in expected.items()):
        fail("held-handoff transfer was not confirmed for the exact owners")
    for key, pattern in (
        ("snapshot_sha256", r"[0-9a-f]{64}"), ("lock_uid", r"[A-Za-z0-9._:-]+"),
        ("observed_resource_version", r"[1-9][0-9]*"),
        ("observed_fencing_generation", r"[1-9][0-9]*"),
        ("observed_lease_until_epoch", r"[1-9][0-9]*"),
    ):
        if type(transfer[key]) is not str or re.fullmatch(pattern, transfer[key]) is None:
            fail("held-handoff transfer snapshot binding is malformed")


def validate_held_handoff_reports(files, evidence):
    with tempfile.TemporaryDirectory(prefix=".held-handoff-evidence-", dir=Path.cwd()) as temporary:
        directory = Path(temporary)
        for relative, raw in files.items():
            destination = directory / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        environment = os.environ.copy()
        environment.update({
            "EVIDENCE_DIR": str(directory), "EXPECTED_PHASE": "apply-slip-index",
            "EXPECTED_RUN_ID": evidence["workflow_run_id"], "EXPECTED_RUN_ATTEMPT": "1",
            "RESUME_BASELINE_DIR": "", "VERIFY_RESUME_APPLIED_RUN": "false", "RESUME_REPOSITORY": "",
            **{f"EXPECTED_{key.upper()}": evidence[key] for key in (
                "source_sha", "build_run_id", "infrastructure_run_id",
                "baseline_recovery_run_id", "baseline_recovery_source_sha",
                "checkpoint_source_sha", "disk_checkpoint_run_id",
                "disk_checkpoint_sha256", "disk_checkpoint_disposition",
            )},
        })
        result = subprocess.run(
            [str(Path(__file__).with_name("verify-live-betting-data-evidence-stan.sh"))],
            env=environment, capture_output=True, check=False,
        )
        if result.returncode != 0:
            fail("held-handoff schema, journal, or sanitized reports are invalid")


def validate_held_handoff_artifact(
    repository, run_id, source_sha, subject_sha, dispatch_inputs, runtime_mode, label,
    *, successor_run_id="",
):
    if dispatch_inputs.get("confirmation") != HELD_HANDOFF_CONFIRMATION:
        fail("held-handoff profile is restricted to its fixed continuation operation")
    if run_id in {
        require_dispatch_run(dispatch_inputs, "prerequisite_run_id"),
        require_dispatch_run(dispatch_inputs, "failed_deploy_run_id"),
    }:
        fail("held-handoff physical owner cannot substitute the original root")
    validate_descendant_scope(source_sha, subject_sha)
    held = validate_held_handoff_native(
        repository, run_id, source_sha, dispatch_inputs, runtime_mode, label,
    )
    evidence, manifest_sha, files = parse_live_v6_artifact(
        repository, run_id, label, include_files=True,
    )
    reports = {f"reports/{stage}-{service}.json"
               for stage in ("preflight", "apply", "verify")
               for service in ("event", "gamemaster", "moderation", "resulting", "bet", "slip")}
    reports |= {f"reports/{stage}-slip-index.json" for stage in ("preflight", "apply", "verify", "final")}
    reports |= {"reports/preflight-event-reschedule.json"}
    reports |= {f"reports/{stage}-backoffice-pre-september-cleanup.json"
                for stage in ("preflight", "apply", "verify")}
    if set(files) != reports | {
        "SHA256SUMS", "provenance.env", "schema.env", "journal.json", "resume-authority.env",
    }:
        fail("held handoff does not have exactly the known historical packaging omission")
    authority = parse_env(files["resume-authority.env"], label, LIVE_RESUME_AUTHORITY_V2_KEYS)
    root_source = require_dispatch_sha(dispatch_inputs, "resume_source_sha")
    failed_run = require_dispatch_run(dispatch_inputs, "failed_deploy_run_id")
    profile = "oci-failed-deploy-retained-hold-v1"
    outcomes = validate_failed_deploy_jobs(repository, failed_run, profile, label)
    if outcomes != ("skipped", "skipped", "skipped"):
        fail("held handoff does not preserve the original pre-runtime failure")
    root = validate_failed_deploy_artifacts(
        repository, failed_run, root_source, None, dispatch_inputs, runtime_mode,
        profile, *outcomes, label, pre_runtime=True,
    )
    checkpoint = parse_checkpoint_artifact(repository, dispatch_inputs, runtime_mode, label)
    validate_live_v6_lineage(
        evidence, checkpoint, dispatch_inputs, run_id, source_sha, "apply-slip-index", label,
    )
    expected_authority = {
        "schema_version": "live-betting-data-resume-v2",
        "applied_data_run_id": root["applied_data_run_id"],
        "applied_source_sha": root["applied_source_sha"], "failed_deploy_run_id": failed_run,
        "resume_maintenance_mode": "pre-runtime-hold", "failed_deploy_job_conclusion": "failure",
        "public_validate_job_conclusion": "skipped", "lock_release_step_conclusion": "skipped",
        "fence_release_step_conclusion": "skipped", "rehold_step_conclusion": "skipped",
        "failed_activation_run_id": "0", "current_source_sha": source_sha,
        "baseline_sha256": validate_checksum_manifest(root["_baseline_files"], label),
        "application_change_scope": "github-infra-docs-only", "status": "PASS",
        **{key: evidence[key] for key in (
            "checkpoint_source_sha", "disk_checkpoint_run_id",
            "disk_checkpoint_sha256", "disk_checkpoint_disposition",
        )},
    }
    build_run = require_dispatch_run(dispatch_inputs, "build_run_id")
    checkpoint_source = require_dispatch_sha(dispatch_inputs, "checkpoint_source_sha")
    build = exact_artifact(
        repository, build_run, f"oci-image-provenance-{checkpoint_source}-{build_run}-1", label,
    )
    image_bytes = artifact_member(repository, build, "images.tsv", label)
    candidate_images_checksum(image_bytes)
    expected_authority["runtime_images_sha256"] = hashlib.sha256(image_bytes).hexdigest()
    if authority != expected_authority:
        fail("held-handoff authority substituted its root, checkpoint, or original image bytes")
    validate_held_handoff_reports(files, evidence)
    history = held_handoff_history(repository, held, subject_sha, successor_run_id)
    return {
        "artifactName": f"oci-live-data-rollout-{run_id}-1",
        "createdAt": held["created_at"], "completedAt": held["updated_at"],
        "baselineFiles": root.pop("_baseline_files"), "heldHistory": history,
        "resume": {
            **root, "held_handoff_run_id": run_id, "held_handoff_source_sha": source_sha,
            "held_handoff_evidence_sha256": manifest_sha,
            **{key: authority[key] for key in (
                "failed_deploy_job_conclusion", "public_validate_job_conclusion",
                "lock_release_step_conclusion", "fence_release_step_conclusion", "rehold_step_conclusion",
            )},
        },
    }


def validate_pre_runtime_resume_chain(repository, run_id, runtime_mode, *, seen=None):
    seen = set() if seen is None else set(seen)
    if run_id in seen or len(seen) >= 20:
        fail("resume authority is cyclic or exceeds the lineage bound")
    seen.add(run_id)
    evidence, _, files = parse_live_v6_artifact(
        repository, run_id, "resume predecessor", include_files=True
    )
    authority = parse_resume_authority(files, evidence, "resume predecessor")
    if authority is None:
        return run_id, evidence["source_sha"]
    if authority["schema_version"] == "live-betting-data-resume-v3":
        current = require_fixed_run(
            repository, run_id, "oci-live-data-rollout.yml", "success", evidence["source_sha"],
            f"oci-live-data apply-slip-index {evidence['source_sha']}", "held-handoff successor",
        )
        request = failed_deploy_native_inputs(
            repository, run_id, evidence["source_sha"], "held-handoff successor", resume_dispatch=True,
        )
        expected_request = {
            "approved_sha": evidence["source_sha"],
            "resume_source_sha": authority["applied_source_sha"],
            "prerequisite_run_id": authority["applied_data_run_id"],
            "failed_deploy_run_id": authority["failed_deploy_run_id"],
            "held_handoff_run_id": authority["held_handoff_run_id"],
            "held_handoff_source_sha": authority["held_handoff_source_sha"],
            "phase": "apply-slip-index", "failed_activation_run_id": "0",
            "failed_activation_user_id": "0", "confirmation": HELD_HANDOFF_CONFIRMATION,
            **{key: evidence[key] for key in (
                "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
                "disk_checkpoint_run_id", "baseline_recovery_run_id", "baseline_recovery_source_sha",
            )},
        }
        if request != expected_request:
            fail("held-handoff successor substituted its native root or previous physical holder")
        result = validate_held_handoff_artifact(
            repository, authority["held_handoff_run_id"], authority["held_handoff_source_sha"],
            evidence["source_sha"], request, runtime_mode, "held-handoff predecessor",
            successor_run_id=run_id,
        )
        for key in (
            "applied_data_run_id", "applied_source_sha", "held_handoff_run_id",
            "held_handoff_source_sha", "held_handoff_evidence_sha256",
            "resume_maintenance_mode", "failed_deploy_job_conclusion", "public_validate_job_conclusion",
            "lock_release_step_conclusion", "fence_release_step_conclusion", "rehold_step_conclusion",
        ):
            if authority[key] != result["resume"][key]:
                fail("held-handoff successor substituted authenticated predecessor evidence")
        _, raw_history = unique_artifact_file(files, "held-handoff-history.json", "held history")
        try:
            history = json.loads(raw_history)
            _, raw_transfer = unique_artifact_file(files, "held-handoff-transfer.json", "held transfer")
            transfer = json.loads(raw_transfer)
        except (ValueError, UnicodeDecodeError):
            fail("held-handoff successor transition evidence is malformed")
        if history != result["heldHistory"]:
            fail("held-handoff successor history differs from its immutable native cutoff")
        validate_held_handoff_transfer(transfer, authority, current)
        if authority["baseline_sha256"] != validate_checksum_manifest(
            result["baselineFiles"], "held-handoff original baseline",
        ):
            fail("held-handoff successor substituted its authenticated original baseline")
        return authority["applied_data_run_id"], authority["applied_source_sha"]
    if authority["resume_maintenance_mode"] != "pre-runtime-hold":
        fail("pre-runtime hold cannot substitute a post-runtime recovery lineage")
    failed_run = authority["failed_deploy_run_id"]
    metadata = fixed_run_metadata(
        repository, failed_run, "oci-production-deploy.yml", "failure",
        "resume failed deployment",
    )
    source_sha = metadata["head_sha"]
    validate_descendant_scope(source_sha, evidence["source_sha"])
    profile = "oci-failed-deploy-retained-hold-v1"
    outcomes = validate_failed_deploy_jobs(repository, failed_run, profile, "resume")
    if outcomes != ("skipped", "skipped", "skipped"):
        fail("pre-runtime resume authority relabels another failed-deploy profile")
    native = failed_deploy_native_inputs(repository, failed_run, source_sha, "resume")
    request = failed_deploy_native_inputs(
        repository, run_id, evidence["source_sha"], "resume request", resume_dispatch=True
    )
    expected_request = {
        key: native[key] for key in (
            "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
            "disk_checkpoint_run_id", "baseline_recovery_run_id",
            "baseline_recovery_source_sha",
        )
    }
    expected_request.update({
        "approved_sha": evidence["source_sha"], "resume_source_sha": source_sha,
        "prerequisite_run_id": native["data_run_id"], "failed_deploy_run_id": failed_run,
        "phase": "apply-slip-index", "failed_activation_run_id": "0",
        "failed_activation_user_id": "0", "confirmation": "RESUME APPLIED LIVE DATA EXACT SHA",
    })
    if request != expected_request:
        fail("pre-runtime resume request substituted its native predecessor or failed deployment")
    dispatch = dict(native, prerequisite_run_id=native["data_run_id"])
    result = validate_failed_deploy_artifacts(
        repository, failed_run, source_sha, None, dispatch, runtime_mode,
        profile, *outcomes, "resume", pre_runtime=True, seen=seen,
    )
    prior, _ = parse_live_v6_artifact(repository, native["data_run_id"], "resume")
    for key in LIVE_V6_KEYS - {
        "source_sha", "workflow_run_id", "completed_at",
    }:
        if evidence[key] != prior[key]:
            fail(f"pre-runtime resume substituted {key}")
    if (
        result["applied_data_run_id"] != authority["applied_data_run_id"]
        or result["applied_source_sha"] != authority["applied_source_sha"]
    ):
        fail("pre-runtime resume substituted its original applied authority")
    current = require_fixed_run(
        repository, run_id, "oci-live-data-rollout.yml", "success",
        evidence["source_sha"], f"oci-live-data apply-slip-index {evidence['source_sha']}",
        "resume",
    )
    if parse_timestamp(metadata.get("updated_at"), "resume") > parse_timestamp(
        current.get("created_at"), "resume"
    ):
        fail("pre-runtime resume predates the failed deployment")
    return result["applied_data_run_id"], result["applied_source_sha"]


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
    files = artifact_files(repository, artifact, label)
    validate_checksum_manifest(files, label)
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
    deployment_artifact = exact_artifact(
        repository,
        deployment_run,
        f"oci-deploy-provenance-{deployment_run}-1",
        f"{label} deployment",
    )
    deployment_files = artifact_files(
        repository, deployment_artifact, f"{label} deployment"
    )
    _, deployment_raw = unique_artifact_file(
        deployment_files, "provenance.txt", f"{label} deployment"
    )
    deployment_provenance = parse_env(
        deployment_raw,
        f"{label} deployment provenance",
        DEPLOYMENT_PROVENANCE_KEYS,
    )
    if deployment_provenance["source_sha"] != subject_sha:
        fail(f"{label} deployment source differs from activation source")
    predecessor_run = deployment_provenance["data_run_id"]
    if (
        POSITIVE_INTEGER.fullmatch(predecessor_run) is None
        or predecessor_run
        != require_dispatch_run(dispatch_inputs, "prerequisite_run_id")
    ):
        fail(f"{label} deployment substituted its v6 handoff")
    predecessor, predecessor_manifest_sha256, predecessor_files = (
        parse_live_v6_artifact(
            repository,
            predecessor_run,
            f"{label} predecessor",
            include_files=True,
        )
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
    predecessor_metadata = require_fixed_run(
        repository,
        predecessor_run,
        "oci-live-data-rollout.yml",
        "success",
        subject_sha,
        f"oci-live-data apply-slip-index {subject_sha}",
        f"{label} predecessor",
    )
    deployment_metadata = require_fixed_run(
        repository,
        deployment_run,
        "oci-production-deploy.yml",
        "success",
        subject_sha,
        f"oci-deploy {subject_sha}",
        f"{label} deployment",
    )
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
    if activation["deployment_run_id"] != deployment_run:
        fail(f"{label} activation deployment lineage is inconsistent")
    resume_authority = parse_resume_authority(
        predecessor_files, predecessor, f"{label} predecessor"
    )
    failed_deploy_input = str(dispatch_inputs.get("failed_deploy_run_id", ""))
    if failed_deploy_input == "0":
        if resume_authority is not None:
            fail(f"{label} omitted the predecessor failed deployment")
    elif resume_authority is not None and (
        resume_authority["resume_maintenance_mode"] == "pre-runtime-hold"
    ):
        if resume_authority["failed_deploy_run_id"] != failed_deploy_input:
            fail(f"{label} failed deployment lineage is inconsistent")
        validate_pre_runtime_resume_chain(repository, predecessor_run, runtime_mode)
    else:
        if (
            POSITIVE_INTEGER.fullmatch(failed_deploy_input) is None
            or resume_authority is None
            or resume_authority["failed_deploy_run_id"]
            != failed_deploy_input
        ):
            fail(f"{label} failed deployment lineage is inconsistent")
        applied_run = resume_authority["applied_data_run_id"]
        applied_source = resume_authority["applied_source_sha"]
        applied, applied_manifest_sha256 = parse_live_v6_artifact(
            repository, applied_run, f"{label} applied predecessor"
        )
        applied_metadata = require_fixed_run(
            repository,
            applied_run,
            "oci-live-data-rollout.yml",
            "success",
            applied_source,
            f"oci-live-data apply-slip-index {applied_source}",
            f"{label} applied predecessor",
        )
        historical_dispatch = dict(dispatch_inputs)
        historical_dispatch.update({
            "checkpoint_source_sha": applied["checkpoint_source_sha"],
            "disk_checkpoint_run_id": applied["disk_checkpoint_run_id"],
            "build_run_id": applied["build_run_id"],
            "infrastructure_run_id": applied["infrastructure_run_id"],
            "prerequisite_run_id": applied_run,
            "baseline_recovery_run_id": applied["baseline_recovery_run_id"],
            "baseline_recovery_source_sha":
                applied["baseline_recovery_source_sha"],
        })
        validate_live_v6_lineage(
            applied,
            checkpoint,
            historical_dispatch,
            applied_run,
            applied_source,
            "apply-slip-index",
            f"{label} applied predecessor",
        )
        for key in {
            "build_run_id",
            "infrastructure_run_id",
            "checkpoint_source_sha",
            "disk_checkpoint_run_id",
            "disk_checkpoint_sha256",
            "disk_checkpoint_disposition",
            "baseline_sha256",
            "baseline_recovery_run_id",
            "baseline_recovery_source_sha",
        }:
            if predecessor[key] != applied[key]:
                fail(f"{label} resumed predecessor substituted {key}")
        failed_metadata = fixed_run_metadata(
            repository,
            failed_deploy_input,
            "oci-production-deploy.yml",
            "failure",
            f"{label} failed deployment",
        )
        if (
            failed_metadata.get("head_sha") != applied_source
            or failed_metadata.get("display_title")
            != f"oci-deploy {applied_source}"
        ):
            fail(f"{label} failed deployment source lineage is invalid")
        failed_baseline = exact_artifact(
            repository,
            failed_deploy_input,
            f"oci-production-baseline-{failed_deploy_input}-1",
            f"{label} failed deployment",
        )
        failed_profile = (
            "oci-failed-deploy-retained-hold-v1"
            if resume_authority["resume_maintenance_mode"] == "retained-hold"
            else "oci-failed-deploy-released-runtime-v1"
        )
        lock_outcome, fence_outcome, rehold_outcome = (
            validate_failed_deploy_jobs(
                repository,
                failed_deploy_input,
                failed_profile,
                f"{label} failed deployment",
            )
        )
        validate_failed_deploy_artifacts(
            repository,
            failed_deploy_input,
            applied_source,
            failed_baseline,
            historical_dispatch,
            runtime_mode,
            failed_profile,
            lock_outcome,
            fence_outcome,
            rehold_outcome,
            f"{label} failed deployment",
        )
        if not (
            parse_timestamp(
                applied_metadata.get("updated_at"),
                f"{label} applied predecessor completion",
            )
            <= parse_timestamp(
                failed_metadata.get("created_at"),
                f"{label} failed deployment creation",
            )
            <= parse_timestamp(
                predecessor_metadata.get("created_at"),
                f"{label} predecessor creation",
            )
        ):
            fail(f"{label} failed-deployment recovery chronology is invalid")
    activation_metadata = gh_api(
        f"repos/{repository}/actions/runs/{run_id}"
    )
    if not (
        parse_timestamp(
            predecessor_metadata.get("updated_at"),
            f"{label} predecessor completion",
        )
        <= parse_timestamp(
            deployment_metadata.get("created_at"),
            f"{label} deployment creation",
        )
        <= parse_timestamp(
            activation_metadata.get("created_at"),
            f"{label} activation creation",
        )
    ):
        fail(f"{label} activation recovery chronology is invalid")
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
    expected_relatives = {"provenance.env", "SHA256SUMS"}
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


def validate_failed_deploy_jobs(repository, run_id, profile, label):
    jobs = jobs_for_run(repository, run_id, label)
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
    if profile == "oci-failed-deploy-retained-hold-v1" and reenter == "skipped":
        metadata = fixed_run_metadata(
            repository, run_id, "oci-production-deploy.yml", "failure", label
        )
        source_sha = metadata["head_sha"]
        path = ".github/workflows/oci-production-deploy.yml"
        blob = subprocess.run(
            ["git", "show", f"{source_sha}:{path}"],
            capture_output=True, check=False,
        )
        if blob.returncode != 0:
            fail(f"{label} trusted failed workflow blob is unavailable")
        blob_sha = hashlib.sha1(
            f"blob {len(blob.stdout)}\0".encode() + blob.stdout
        ).hexdigest()
        if gh_api(f"repos/{repository}/contents/{path}?ref={source_sha}").get("sha") != blob_sha:
            fail(f"{label} native failed workflow blob differs")
        try:
            workflow = blob.stdout.decode("utf-8")
        except UnicodeDecodeError:
            fail(f"{label} trusted workflow is not UTF-8")
        if re.findall(r"(?m)^  ([a-z][a-z-]*):$", workflow.partition("\njobs:\n")[2]) != [
            "deploy", "public-validate"
        ]:
            fail(f"{label} trusted workflow job inventory changed")
        names = re.findall(
            r"(?m)^      - name: (.+)$",
            workflow.split("\n  public-validate:\n")[0],
        )
        boundary = "Verify immutable image and infrastructure provenance"
        if len(names) != len(set(names)) or names.count(boundary) != 1:
            fail(f"{label} trusted workflow step inventory is ambiguous")
        index = names.index(boundary)
        required_admissions = {
            "Initialize isolated OCI paths", "Checkout approved master commit",
            "Validate exact SHA and trusted upstream runs",
            "Download exact OCI image provenance",
            "Download exact OCI infrastructure provenance",
            "Download exact live data readiness evidence",
            "Download exact release disk checkpoint",
            "Download exact pre-mutation rollback baseline",
        }
        if set(names[:index]) != required_admissions:
            fail(f"{label} trusted pre-runtime admission inventory changed")
        expected = {
            name: "success" if offset < index else
            "failure" if offset == index else "skipped"
            for offset, name in enumerate(names)
        }
        expected.update({
            "Set up job": "success",
            "Post Checkout approved master commit": "success",
            "Complete job": "success",
            "Remove isolated OCI client state": "success",
            "Upload sanitized live readiness evidence": "success",
        })
        actual_names = [item.get("name") for item in deploy["steps"]]
        numbers = [item.get("number") for item in deploy["steps"]]
        if (
            len(jobs) != 2 or deploy.get("conclusion") != "failure"
            or deploy.get("status") != "completed"
            or public.get("conclusion") != "skipped"
            or public.get("status") != "completed" or public["steps"]
            or len(actual_names) != len(set(actual_names))
            or set(actual_names) != set(expected)
            or [name for name in actual_names if name in names] != names
            or not all(type(number) is int and number > 0 for number in numbers)
            or numbers != sorted(set(numbers))
        ):
            fail(f"{label} pre-runtime job/step inventory differs")
        for step in deploy["steps"]:
            if step.get("status") != "completed" or step["conclusion"] != expected[step["name"]]:
                fail(f"{label} pre-runtime step outcome differs")
        if artifact_inventory(repository, run_id, label):
            fail(f"{label} pre-runtime failed run must have zero artifacts")
        return lock, fence, reenter
    if profile == "oci-failed-deploy-retained-hold-v1":
        recovery_intent = step_conclusion(
            deploy,
            "Write checksum-bound deployment recovery intent",
            label,
        )
        recovery_finalize = step_conclusion(
            deploy,
            "Finalize deployment recovery authority",
            label,
        )
        recovery_upload = step_conclusion(
            deploy,
            "Upload deployment recovery authority",
            label,
        )
        if (
            deploy.get("conclusion") != "failure"
            or public.get("conclusion") != "skipped"
            or reenter != "success"
            or recovery_intent != "success"
            or recovery_finalize != "success"
            or recovery_upload != "success"
            or (lock, fence) not in {
                ("skipped", "skipped"),
                ("failure", "skipped"),
                ("success", "failure"),
            }
        ):
            fail("failed deployment does not match the retained-hold profile")
    elif (
        profile == "oci-failed-deploy-released-runtime-v1"
        and (
            deploy.get("conclusion") != "success"
            or public.get("conclusion") != "failure"
            or lock != "success"
            or fence != "success"
            or reenter != "skipped"
        )
    ):
        fail("failed deployment does not match the released-runtime profile")
    else:
        if profile != "oci-failed-deploy-released-runtime-v1":
            fail("failed deployment profile is invalid")
    return lock, fence, reenter


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
    if profile in {
        "oci-failed-deploy-retained-hold-v1",
        "oci-failed-deploy-released-runtime-v1",
    }:
        lock, fence, reenter = validate_failed_deploy_jobs(
            repository, run_id, profile, label
        )
        validate_failed_deploy_artifacts(
            repository,
            run_id,
            subject_sha,
            artifact,
            dispatch_inputs,
            runtime_mode,
            profile,
            lock,
            fence,
            reenter,
            label,
        )
        return
    jobs = jobs_for_run(repository, run_id, label)
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
        or step_conclusion(
            activation, "Upload activation recovery authority", label
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


def fixed_run_metadata(
    repository,
    run_id,
    workflow,
    conclusion,
    label,
    event="workflow_dispatch",
):
    workflow_metadata = gh_api(
        f"repos/{repository}/actions/workflows/{workflow}"
    )
    if not isinstance(workflow_metadata, dict) or type(
        workflow_metadata.get("id")
    ) is not int:
        fail(f"{label} workflow metadata is invalid")
    workflow_id = workflow_metadata["id"]
    base = gh_api(f"repos/{repository}/actions/runs/{run_id}")
    attempt = gh_api(
        f"repos/{repository}/actions/runs/{run_id}/attempts/1"
    )
    if not isinstance(base, dict) or not isinstance(attempt, dict):
        fail(f"{label} run metadata is invalid")
    expected_path = f".github/workflows/{workflow}"
    checks = {
        "id": (base.get("id"), int(run_id)),
        "workflow_id": (base.get("workflow_id"), workflow_id),
        "path": (base.get("path"), expected_path),
        "repository": (
            (base.get("head_repository") or {}).get("full_name"),
            repository,
        ),
        "head_branch": (base.get("head_branch"), "master"),
        "status": (base.get("status"), "completed"),
        "conclusion": (base.get("conclusion"), conclusion),
        "run_attempt": (base.get("run_attempt"), 1),
        "event": (base.get("event"), event),
    }
    for field, (observed, expected) in checks.items():
        if observed != expected:
            fail(
                f"{label} run {run_id} {field} is {observed!r}, "
                f"expected {expected!r}"
            )
    for field in {
        "id",
        "workflow_id",
        "path",
        "head_branch",
        "head_sha",
        "status",
        "conclusion",
        "run_attempt",
        "event",
        "display_title",
    }:
        if attempt.get(field) != base.get(field):
            fail(f"{label} first attempt {field} differs from the run")
    if (
        (attempt.get("head_repository") or {}).get("full_name")
        != repository
    ):
        fail(f"{label} first attempt repository differs from the run")
    head_sha = base.get("head_sha")
    if not isinstance(head_sha, str) or FULL_SHA.fullmatch(head_sha) is None:
        fail(f"{label} control SHA is invalid")
    return base


def validate_recovery_image_rows(raw, label):
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail(f"{label} images are not UTF-8")
    rows = {}
    digest = re.compile(r"^sha256:[0-9a-f]{64}$")
    for line in lines:
        fields = line.split("\t")
        if len(fields) != 5:
            fail(f"{label} images have an invalid schema")
        service, repository, image_ref, manifest, platform = fields
        if (
            service in rows
            or service not in RECOVERY_APPLICATION_SERVICES
            or repository != APPLICATION_REPOSITORY
            or image_ref != f"{repository}@{manifest}"
            or digest.fullmatch(manifest) is None
            or digest.fullmatch(platform) is None
        ):
            fail(f"{label} images are invalid")
        rows[service] = {
            "image_ref": image_ref,
            "manifest": manifest,
            "platform": platform,
        }
    if set(rows) != RECOVERY_APPLICATION_SERVICES:
        fail(f"{label} images do not contain the exact application services")
    return rows


def artifact_sibling_files(files, required_names, label):
    locations = {}
    for name in required_names:
        path, raw = unique_artifact_file(files, name, label)
        locations[name] = (path, raw)
    prefixes = {
        path.rsplit("/", 1)[0] if "/" in path else ""
        for path, _ in locations.values()
    }
    if len(prefixes) != 1:
        fail(f"{label} artifact has inconsistent evidence roots")
    return {name: raw for name, (_, raw) in locations.items()}


def validate_production_upstream_run(
    repository, run_id, source_sha, label
):
    metadata = fixed_run_metadata(
        repository,
        run_id,
        "production-build.yml",
        "success",
        label,
        "push",
    )
    if metadata.get("head_sha") != source_sha:
        fail(f"{label} source differs from the image build")


def validate_legacy_build_artifact(
    repository, run_id, source_sha, label
):
    metadata = fixed_run_metadata(
        repository,
        run_id,
        "oci-production-build.yml",
        "success",
        label,
        "workflow_run",
    )
    if metadata.get("head_sha") != source_sha:
        fail(f"{label} source differs")
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-image-provenance-{source_sha}-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    names = {"build-chain.txt"} | {
        f"{service}.env" for service in RECOVERY_APPLICATION_SERVICES
    }
    evidence = artifact_sibling_files(files, names, label)
    with tempfile.TemporaryDirectory(
        prefix=".upstream-binding-legacy-build-",
        dir=Path.cwd(),
    ) as temporary:
        root = Path(temporary)
        for name, raw in evidence.items():
            (root / name).write_bytes(raw)
        helper = Path(__file__).with_name(
            "validate-legacy-oci-provenance.py"
        )
        result = subprocess.run(
            [sys.executable, str(helper), str(root), source_sha, run_id],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            fail(f"repository-fixed validator rejected {label}")
        match = re.fullmatch(
            r"TRUSTED_UPSTREAM_RUN_ID=([1-9][0-9]*)\n?",
            result.stdout,
        )
        if match is None:
            fail(f"{label} upstream build result is invalid")
    services = {}
    for service in RECOVERY_APPLICATION_SERVICES:
        values = parse_env(
            evidence[f"{service}.env"], f"{label} {service}"
        )
        services[service] = {
            "repository": values["repository"],
            "manifest": values["digest"],
            "platform": values["platform_digest"],
        }
    upstream_run = match.group(1)
    if (
        metadata.get("display_title")
        != f"oci-build {source_sha} upstream-{upstream_run}"
    ):
        fail(f"{label} title differs from its upstream build")
    validate_production_upstream_run(
        repository, upstream_run, source_sha, f"{label} upstream"
    )
    return services, upstream_run


def validate_current_build_artifact(
    repository, run_id, source_sha, label
):
    metadata = fixed_run_metadata(
        repository,
        run_id,
        "oci-production-build.yml",
        "success",
        label,
        "workflow_run",
    )
    if metadata.get("head_sha") != source_sha:
        fail(f"{label} source differs")
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-image-provenance-{source_sha}-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    names = {"build-chain.txt"} | {
        f"{service}.env" for service in RECOVERY_APPLICATION_SERVICES
    }
    evidence = artifact_sibling_files(files, names, label)
    chain = parse_env(evidence["build-chain.txt"], f"{label} build chain")
    chain_keys = {
        "source_sha",
        "upstream_workflow",
        "upstream_run_id",
        "upstream_run_attempt",
        "build_run_id",
        "build_run_attempt",
        "build_trigger_workflow",
        "build_trigger_run_id",
        "repair_mode",
        "image_mode",
        "platform",
        "registry_provider",
        "registry_host",
        "registry_repository",
        "registry_public",
        "anonymous_pull",
    }
    if chain.get("image_mode") == "reuse":
        chain_keys |= {"reuse_source_sha", "reuse_build_run_id"}
    if (
        set(chain) != chain_keys
        or chain["source_sha"] != source_sha
        or chain["upstream_workflow"] != "production-build"
        or POSITIVE_INTEGER.fullmatch(chain["upstream_run_id"]) is None
        or chain["upstream_run_attempt"] != "1"
        or chain["build_run_id"] != run_id
        or chain["build_run_attempt"] != "1"
        or chain["image_mode"] not in {"build", "reuse"}
        or chain["platform"] != "linux/arm64"
        or chain["registry_provider"] != "ghcr"
        or chain["registry_host"] != "ghcr.io"
        or chain["registry_repository"] != APPLICATION_REPOSITORY
        or chain["registry_public"] != "true"
        or chain["anonymous_pull"] != "pass"
    ):
        fail(f"{label} build chain is invalid")
    with tempfile.TemporaryDirectory(
        prefix=".upstream-binding-current-build-",
        dir=Path.cwd(),
    ) as temporary:
        root = Path(temporary)
        for name, raw in evidence.items():
            (root / name).write_bytes(raw)
        output = root / "validated-images.tsv"
        helper = Path(__file__).with_name("verify-images.sh")
        environment = os.environ.copy()
        environment.update({
            "PROVENANCE_DIR": str(root),
            "SOURCE_SHA": source_sha,
            "OUTPUT_FILE": str(output),
            "VERIFY_REMOTE": "0",
            "BOOT_IMAGES": "0",
            "EXPECTED_BUILD_RUN_ID": run_id,
            "EXPECTED_BUILD_RUN_ATTEMPT": "1",
            "EXPECTED_UPSTREAM_RUN_ID": chain["upstream_run_id"],
            "GENERATION_PROFILE": "compatible",
        })
        result = subprocess.run(
            [str(helper)],
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )
        if result.returncode != 0:
            fail(f"repository-fixed validator rejected {label}")
        images = validate_recovery_image_rows(
            b"\n".join(
                line
                for line in output.read_bytes().splitlines()
                if not line.startswith(b"telemetry\t")
            )
            + b"\n",
            label,
        )
    validate_production_upstream_run(
        repository,
        chain["upstream_run_id"],
        source_sha,
        f"{label} upstream",
    )
    if (
        metadata.get("display_title")
        != f"oci-build {source_sha} upstream-{chain['upstream_run_id']}"
    ):
        fail(f"{label} title differs from its upstream build")
    return images


def validate_infrastructure_artifact(
    repository,
    run_id,
    expected_hash,
    runtime_mode,
    runtime_fingerprint,
    endpoints,
    label,
):
    metadata = fixed_run_metadata(
        repository,
        run_id,
        "oci-infrastructure.yml",
        "success",
        label,
    )
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-infrastructure-provenance-{run_id}-1",
        label,
    )
    raw = artifact_member(repository, artifact, "provenance.env", label)
    if hashlib.sha256(raw).hexdigest() != expected_hash:
        fail(f"{label} provenance checksum differs")
    values = parse_env(raw, f"{label} provenance")
    source_sha = values.get("source_sha")
    fingerprint_key = (
        "cluster_fingerprint"
        if runtime_mode == "oke"
        else "instance_fingerprint"
    )
    expected = {
        "source_sha": metadata.get("head_sha"),
        "infrastructure_run_id": run_id,
        "infrastructure_run_attempt": "1",
        "runtime_mode": runtime_mode,
        fingerprint_key: runtime_fingerprint,
        **endpoints,
    }
    for key, expected_value in expected.items():
        if values.get(key) != expected_value:
            fail(f"{label} substituted {key}")
    allowed_titles = {
        f"oci-infrastructure finalize {runtime_mode} {source_sha}",
        f"oci-infrastructure finalize {source_sha}",
    }
    if metadata.get("display_title") not in allowed_titles:
        fail(f"{label} title differs from its finalized source")
    return source_sha


def validate_cache_plan_artifact(
    repository,
    run_id,
    source_sha,
    plan_raw,
    rabbit_raw,
    expected_origin,
    label,
):
    artifact = exact_artifact(
        repository,
        run_id,
        f"ghcr-cache-recovery-plan-{source_sha}-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    expected = {
        "transition-plan.tsv",
        "rabbitmq-baseline.txt",
        "transition-plan-evidence.env",
    }
    if (
        {path.rsplit("/", 1)[-1] for path in files} != expected
        or len(files) != len(expected)
    ):
        fail(f"{label} artifact has an unexpected file set")
    siblings = artifact_sibling_files(files, expected, label)
    if (
        siblings["transition-plan.tsv"] != plan_raw
        or siblings["rabbitmq-baseline.txt"] != rabbit_raw
    ):
        fail(f"{label} plan payload differs")
    evidence = parse_env(
        siblings["transition-plan-evidence.env"],
        f"{label} evidence",
        {
            "schema",
            "source_sha",
            "plan_origin_recovery_run_id",
            "plan_carrier_recovery_run_id",
            "plan_carrier_recovery_run_attempt",
            "images_sha256",
            "infrastructure_provenance_sha256",
            "transition_plan_sha256",
            "rabbitmq_baseline_sha256",
        },
    )
    if (
        evidence["schema"] != "betstan.ghcr-cache-transition-plan.v1"
        or evidence["source_sha"] != source_sha
        or evidence["plan_origin_recovery_run_id"] != expected_origin
        or evidence["plan_carrier_recovery_run_id"] != run_id
        or evidence["plan_carrier_recovery_run_attempt"] != "1"
        or evidence["transition_plan_sha256"]
        != hashlib.sha256(plan_raw).hexdigest()
        or evidence["rabbitmq_baseline_sha256"]
        != hashlib.sha256(rabbit_raw).hexdigest()
    ):
        fail(f"{label} evidence is invalid")
    return evidence


def parse_tsv(raw, width, label, *, allow_empty=False):
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail(f"{label} is not UTF-8")
    rows = [line.split("\t") for line in lines]
    if (
        (not rows and not allow_empty)
        or any(len(row) != width for row in rows)
    ):
        fail(f"{label} is malformed")
    return rows


def validate_failed_partial_rollback_artifact(
    repository,
    run_id,
    source_sha,
    target_sha,
    restored_images,
    recovery_plan,
    recovered_telemetry,
    label,
):
    failed = fixed_run_metadata(
        repository,
        run_id,
        "oci-production-rollback.yml",
        "failure",
        label,
    )
    if (
        failed.get("head_sha") != source_sha
        or failed.get("display_title") != f"oci-rollback {target_sha}"
    ):
        fail(f"{label} target title differs")
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-production-rollback-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    required = {
        "failure-state.env",
        "pre-rollback-state.tsv",
        "partial-state.tsv",
        "rollout-order.tsv",
        "baseline-provenance.env",
        "telemetry-pre-run.env",
    }
    evidence = {
        name: unique_artifact_file(files, name, label)[1]
        for name in required
    }
    failure = parse_env(
        evidence["failure-state.env"], f"{label} failure state"
    )
    failed_service = failure.get("failed_service")
    service_order = [
        "auth",
        "bet",
        "backoffice",
        "client",
        "event",
        "moderation",
        "resulting",
        "slip",
        "gamemaster",
    ]
    if (
        failure.get("status") != "FAIL"
        or failed_service not in set(service_order) | {"post-rollback"}
        or failure.get("rollback_http_mutation_fence")
        not in {"active", "not-required", "legacy-not-recorded"}
    ):
        fail(f"{label} failure state is invalid")
    if failed_service in service_order and (
        failure.get("failed_deployment")
        != f"gaming-{failed_service}-depl"
        or failure.get("failed_step_label") != f"failed-{failed_service}"
    ):
        fail(f"{label} failed service lineage is invalid")
    baseline = parse_env(
        evidence["baseline-provenance.env"], f"{label} baseline"
    )
    if baseline.get("baseline_source_sha") != target_sha:
        fail(f"{label} baseline target differs")

    pre_rows = parse_tsv(
        evidence["pre-rollback-state.tsv"], 5, f"{label} pre-rollback state"
    )
    partial_rows = parse_tsv(
        evidence["partial-state.tsv"], 3, f"{label} partial state"
    )
    if (
        [row[0] for row in pre_rows] != service_order
        or [row[0] for row in partial_rows] != service_order
    ):
        fail(f"{label} service order is invalid")
    pre = {row[0]: row for row in pre_rows}
    partial = {row[0]: row for row in partial_rows}
    image_pattern = re.compile(
        r"^ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}$"
    )
    for service in service_order:
        if (
            pre[service][1] != f"gaming-{service}-depl"
            or image_pattern.fullmatch(pre[service][2]) is None
            or image_pattern.fullmatch(partial[service][1]) is None
            or pre[service][2] != restored_images[service]["image_ref"]
        ):
            fail(f"{label} {service} pre-rollback image lineage is invalid")
    order = [
        row[0]
        for row in parse_tsv(
            evidence["rollout-order.tsv"], 1, f"{label} rollout order"
        )
    ]
    if (
        len(order) != len(set(order))
        or order != service_order[:len(order)]
        or (
            failed_service in service_order
            and (not order or order[-1] != failed_service)
        )
        or (failed_service == "post-rollback" and order != service_order)
    ):
        fail(f"{label} rollout order is invalid")
    for service in service_order[len(order):]:
        if pre[service][2] != partial[service][1]:
            fail(f"{label} unattempted service changed")
    if (
        failed_service in service_order
        and pre[failed_service][2] == partial[failed_service][1]
    ):
        fail(f"{label} failed service did not change")
    changed_services = [
        service
        for service in reversed(order)
        if pre[service][2] != partial[service][1]
    ]
    if (
        [row[0] for row in recovery_plan] != changed_services
        or any(
            row[2] != pre[row[0]][2]
            or row[3] != partial[row[0]][1]
            for row in recovery_plan
        )
    ):
        fail(f"{label} recovery plan differs from the failed partial state")

    telemetry = parse_env(
        evidence["telemetry-pre-run.env"], f"{label} telemetry"
    )
    if (
        telemetry.get("mode") != "retained"
        or telemetry.get("image") != recovered_telemetry.get("image")
        or telemetry.get("database_initialized")
        != recovered_telemetry.get("database_initialized")
        or telemetry.get("queue_present") != "true"
        or recovered_telemetry.get("queue_present") != "true"
    ):
        fail(f"{label} telemetry lineage differs")
    return failed


def validate_cache_recovery_artifact(
    repository,
    run_id,
    source_sha,
    artifact,
    label,
):
    files = artifact_files(repository, artifact, label)
    validate_checksum_manifest(files, label)
    expected_files = {
        "SHA256SUMS",
        "images.tsv",
        "recovery-evidence.env",
        "transition-plan.tsv",
        "transition-plan-evidence.env",
        "rabbitmq-baseline.txt",
        "rebind-provenance.env",
        "transition-provenance.env",
    } | {f"{service}.env" for service in RECOVERY_APPLICATION_SERVICES}
    relatives = {path.rsplit("/", 1)[-1] for path in files}
    if relatives != expected_files or len(files) != len(expected_files):
        fail(f"{label} artifact has an unexpected file set")

    _, images_raw = unique_artifact_file(files, "images.tsv", label)
    images = validate_recovery_image_rows(images_raw, label)
    image_hash = hashlib.sha256(images_raw).hexdigest()
    _, evidence_raw = unique_artifact_file(
        files, "recovery-evidence.env", label
    )
    evidence = parse_env(
        evidence_raw,
        f"{label} recovery evidence",
        {
            "schema",
            "recovery_origin",
            "registry_provider",
            "registry_repository",
            "anonymous_pull",
            "source_sha",
            "trusted_build_run_id",
            "trusted_upstream_run_id",
            "recovery_run_id",
            "recovery_run_attempt",
            "images_sha256",
        },
    )
    if (
        evidence["schema"] != "betstan.ghcr-cache-recovery.v1"
        or evidence["recovery_origin"] != "containerd-cache"
        or evidence["registry_provider"] != "ghcr"
        or evidence["registry_repository"] != APPLICATION_REPOSITORY
        or evidence["anonymous_pull"] != "pass"
        or evidence["source_sha"] != source_sha
        or evidence["recovery_run_id"] != run_id
        or evidence["recovery_run_attempt"] != "1"
        or evidence["images_sha256"] != image_hash
        or POSITIVE_INTEGER.fullmatch(
            evidence["trusted_build_run_id"]
        ) is None
        or POSITIVE_INTEGER.fullmatch(
            evidence["trusted_upstream_run_id"]
        ) is None
    ):
        fail(f"{label} recovery evidence is invalid")

    service_keys = {
        "schema",
        "registry_provider",
        "registry_host",
        "registry_tag_prefix",
        "registry_tag_schema",
        "service",
        "repository",
        "source_sha",
        "tag",
        "digest",
        "platform_digest",
        "image_ref",
        "platform",
        "build_workflow",
        "build_run_id",
        "build_run_attempt",
        "upstream_workflow",
        "upstream_run_id",
        "upstream_run_attempt",
        "recovery_workflow",
        "recovery_run_id",
        "recovery_run_attempt",
        "recovery_origin",
        "recovery_origin_repository",
        "recovery_origin_manifest_digest",
        "recovery_origin_platform_digest",
    }
    digest = re.compile(r"^sha256:[0-9a-f]{64}$")
    service_provenance = {}
    for service, image in images.items():
        _, raw = unique_artifact_file(files, f"{service}.env", label)
        values = parse_env(raw, f"{label} {service} provenance", service_keys)
        if (
            values["schema"] != "betstan.application-image-provenance.v1"
            or values["registry_provider"] != "ghcr"
            or values["registry_host"] != "ghcr.io"
            or values["registry_tag_prefix"] != "arm64"
            or values["registry_tag_schema"] != "v1"
            or values["service"] != service
            or values["repository"] != APPLICATION_REPOSITORY
            or values["source_sha"] != source_sha
            or values["tag"]
            != f"{APPLICATION_REPOSITORY}:{service}-{source_sha}-arm64"
            or values["digest"] != image["manifest"]
            or values["platform_digest"] != image["platform"]
            or values["image_ref"] != image["image_ref"]
            or values["platform"] != "linux/arm64"
            or values["build_workflow"] != "oci-production-build"
            or values["build_run_id"] != evidence["trusted_build_run_id"]
            or values["build_run_attempt"] != "1"
            or values["upstream_workflow"] != "production-build"
            or values["upstream_run_id"]
            != evidence["trusted_upstream_run_id"]
            or values["upstream_run_attempt"] != "1"
            or values["recovery_workflow"] != "oci-ghcr-cache-recovery"
            or values["recovery_run_id"] != run_id
            or values["recovery_run_attempt"] != "1"
            or values["recovery_origin"] != "containerd-cache"
            or not values["recovery_origin_repository"]
            or digest.fullmatch(
                values["recovery_origin_manifest_digest"]
            ) is None
            or values["recovery_origin_platform_digest"] != image["platform"]
        ):
            fail(f"{label} {service} provenance is invalid")
        service_provenance[service] = values

    transition_keys = {
        "schema",
        "transition_workflow",
        "transition_run_id",
        "transition_run_attempt",
        "source_sha",
        "images_sha256",
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
        "transition_plan_state_sha256",
        "rabbitmq_baseline_sha256",
        "credential_retirement",
        "ocir_repository_retirement",
        "transition_status",
    }
    _, transition_raw = unique_artifact_file(
        files, "transition-provenance.env", label
    )
    transition = parse_env(
        transition_raw, f"{label} transition provenance", transition_keys
    )
    if (
        transition["schema"]
        != "betstan.ghcr-cache-recovery-transition.v1"
        or transition["transition_workflow"] != "oci-ghcr-cache-recovery"
        or transition["transition_run_id"] != run_id
        or transition["transition_run_attempt"] != "1"
        or transition["source_sha"] != source_sha
        or transition["images_sha256"] != image_hash
        or transition["runtime_mode"] != "k3s"
        or transition["registry_provider"] != "ghcr"
        or transition["registry_host"] != "ghcr.io"
        or transition["registry_repository"] != APPLICATION_REPOSITORY
        or transition["registry_public_anonymous"] != "true"
        or transition["credential_retirement"] != "pass"
        or transition["ocir_repository_retirement"] != "pass"
        or transition["transition_status"] != "PASS"
    ):
        fail(f"{label} transition provenance is invalid")
    for key in {
        "infrastructure_provenance_sha256",
        "runtime_fingerprint",
        "transition_plan_state_sha256",
        "rabbitmq_baseline_sha256",
    }:
        if re.fullmatch(r"[0-9a-f]{64}", transition[key]) is None:
            fail(f"{label} transition hash is invalid")
    if (
        POSITIVE_INTEGER.fullmatch(transition["infrastructure_run_id"])
        is None
        or transition["infrastructure_run_attempt"] != "1"
    ):
        fail(f"{label} transition infrastructure lineage is invalid")
    for key in {
        "public_host",
        "canonical_host",
        "redirect_host",
        "diagnostic_host",
    }:
        if re.fullmatch(r"[A-Za-z0-9.-]+", transition[key]) is None:
            fail(f"{label} transition endpoint is invalid")
    if transition["canonical_host"] != transition["public_host"]:
        fail(f"{label} transition canonical endpoint differs")

    _, plan_raw = unique_artifact_file(
        files, "transition-plan.tsv", label
    )
    plan_rows = {}
    try:
        plan_lines = plan_raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail(f"{label} transition plan is not UTF-8")
    for line in plan_lines:
        fields = line.split("\t")
        if len(fields) != 5:
            fail(f"{label} transition plan is malformed")
        service, old_ref, new_ref, platform, state = fields
        if (
            service in plan_rows
            or service not in RECOVERY_APPLICATION_SERVICES
            or new_ref != images[service]["image_ref"]
            or platform != images[service]["platform"]
            or re.fullmatch(
                r"[A-Za-z0-9./_-]+@sha256:[0-9a-f]{64}",
                old_ref,
            )
            is None
            or state not in {"pending", "already-ghcr"}
        ):
            fail(f"{label} transition plan is invalid")
        plan_rows[service] = fields
    if set(plan_rows) != RECOVERY_APPLICATION_SERVICES:
        fail(f"{label} transition plan service set is incomplete")
    plan_hash = hashlib.sha256(plan_raw).hexdigest()
    _, rabbit_raw = unique_artifact_file(
        files, "rabbitmq-baseline.txt", label
    )
    rabbit_hash = hashlib.sha256(rabbit_raw).hexdigest()
    if (
        transition["transition_plan_state_sha256"] != plan_hash
        or transition["rabbitmq_baseline_sha256"] != rabbit_hash
    ):
        fail(f"{label} transition plan hashes differ")

    _, plan_evidence_raw = unique_artifact_file(
        files, "transition-plan-evidence.env", label
    )
    plan_evidence = parse_env(
        plan_evidence_raw,
        f"{label} transition plan evidence",
        {
            "schema",
            "source_sha",
            "plan_origin_recovery_run_id",
            "plan_carrier_recovery_run_id",
            "plan_carrier_recovery_run_attempt",
            "images_sha256",
            "infrastructure_provenance_sha256",
            "transition_plan_sha256",
            "rabbitmq_baseline_sha256",
        },
    )
    if (
        plan_evidence["schema"]
        != "betstan.ghcr-cache-transition-plan.v1"
        or plan_evidence["source_sha"] != source_sha
        or POSITIVE_INTEGER.fullmatch(
            plan_evidence["plan_origin_recovery_run_id"]
        )
        is None
        or POSITIVE_INTEGER.fullmatch(
            plan_evidence["plan_carrier_recovery_run_id"]
        )
        is None
        or plan_evidence["plan_carrier_recovery_run_id"] != run_id
        or plan_evidence["plan_carrier_recovery_run_attempt"] != "1"
        or plan_evidence["images_sha256"] != image_hash
        or plan_evidence["infrastructure_provenance_sha256"]
        != transition["infrastructure_provenance_sha256"]
        or plan_evidence["transition_plan_sha256"] != plan_hash
        or plan_evidence["rabbitmq_baseline_sha256"] != rabbit_hash
    ):
        fail(f"{label} transition plan evidence is invalid")

    _, rebind_raw = unique_artifact_file(
        files, "rebind-provenance.env", label
    )
    rebind = parse_env(
        rebind_raw,
        f"{label} rebind provenance",
        {
            "schema",
            "transition_workflow",
            "recovery_run_id",
            "recovery_run_attempt",
            "source_sha",
            "images_sha256",
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
            "transition_plan_state_sha256",
            "rabbitmq_baseline_sha256",
            "transition_plan_evidence_sha256",
            "plan_origin_recovery_run_id",
            "credential_retirement",
            "transition_status",
        },
    )
    shared_keys = {
        "source_sha",
        "images_sha256",
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
        "transition_plan_state_sha256",
        "rabbitmq_baseline_sha256",
    }
    if (
        rebind["schema"] != "betstan.ghcr-cache-recovery-rebind.v1"
        or rebind["transition_workflow"] != "oci-ghcr-cache-recovery"
        or rebind["recovery_run_id"] != run_id
        or rebind["recovery_run_attempt"] != "1"
        or any(rebind[key] != transition[key] for key in shared_keys)
        or rebind["transition_plan_evidence_sha256"]
        != hashlib.sha256(plan_evidence_raw).hexdigest()
        or rebind["plan_origin_recovery_run_id"]
        != plan_evidence["plan_origin_recovery_run_id"]
        or rebind["credential_retirement"] != "pending"
        or rebind["transition_status"] != "REBIND_VERIFIED"
    ):
        fail(f"{label} rebind provenance is invalid")

    current_plan_evidence = validate_cache_plan_artifact(
        repository,
        run_id,
        source_sha,
        plan_raw,
        rabbit_raw,
        plan_evidence["plan_origin_recovery_run_id"],
        f"{label} plan carrier",
    )
    if current_plan_evidence != plan_evidence:
        fail(f"{label} plan carrier evidence differs from final evidence")
    origin_run = plan_evidence["plan_origin_recovery_run_id"]
    if origin_run != run_id:
        origin_base = gh_api(f"repos/{repository}/actions/runs/{origin_run}")
        origin_conclusion = (
            origin_base.get("conclusion")
            if isinstance(origin_base, dict)
            else None
        )
        if origin_conclusion not in {"failure", "cancelled"}:
            fail(f"{label} plan origin is not a failed or cancelled run")
        origin_metadata = fixed_run_metadata(
            repository,
            origin_run,
            "oci-ghcr-cache-recovery.yml",
            origin_conclusion,
            f"{label} plan origin",
        )
        if (
            origin_metadata.get("display_title")
            != f"oci-ghcr-cache-recovery {source_sha}"
        ):
            fail(f"{label} plan origin title differs")
        origin_evidence = validate_cache_plan_artifact(
            repository,
            origin_run,
            source_sha,
            plan_raw,
            rabbit_raw,
            origin_run,
            f"{label} plan origin",
        )
        for key in {
            "schema",
            "source_sha",
            "plan_origin_recovery_run_id",
            "images_sha256",
            "infrastructure_provenance_sha256",
            "transition_plan_sha256",
            "rabbitmq_baseline_sha256",
        }:
            if origin_evidence[key] != plan_evidence[key]:
                fail(f"{label} plan origin substituted {key}")

    infrastructure_source = validate_infrastructure_artifact(
        repository,
        transition["infrastructure_run_id"],
        transition["infrastructure_provenance_sha256"],
        transition["runtime_mode"],
        transition["runtime_fingerprint"],
        {
            "public_host": transition["public_host"],
            "canonical_host": transition["canonical_host"],
            "redirect_host": transition["redirect_host"],
            "diagnostic_host": transition["diagnostic_host"],
        },
        f"{label} infrastructure",
    )
    if infrastructure_source != source_sha:
        fail(f"{label} infrastructure source differs")

    build_run = evidence["trusted_build_run_id"]
    legacy_services, upstream_run = validate_legacy_build_artifact(
        repository,
        build_run,
        source_sha,
        f"{label} historical build",
    )
    if upstream_run != evidence["trusted_upstream_run_id"]:
        fail(f"{label} trusted upstream build differs")
    for service, values in service_provenance.items():
        legacy = legacy_services[service]
        if (
            values["recovery_origin_repository"] != legacy["repository"]
            or values["recovery_origin_manifest_digest"]
            != legacy["manifest"]
            or values["recovery_origin_platform_digest"]
            != legacy["platform"]
        ):
            fail(f"{label} {service} recovery origin differs from the build")


def validate_partial_recovery_artifact(
    repository,
    run_id,
    source_sha,
    artifact,
    metadata,
    label,
):
    files = artifact_files(
        repository,
        artifact,
        label,
        allowed_empty_suffixes={"rollback-readiness/failures.txt"},
    )
    manifest_path, _ = unique_artifact_file(
        files, "partial-recovery-SHA256SUMS", label
    )
    prefix = (
        manifest_path.rsplit("/", 1)[0] + "/"
        if "/" in manifest_path
        else ""
    )
    expected_relatives = {
        "images.tsv",
        "partial-recovery-authority.env",
        "partial-recovery-summary.env",
        "recovery-plan.tsv",
        "recovery-rollout-order.tsv",
        "final-state.tsv",
        "rollback-readiness/summary.env",
        "rollback-readiness/workload-state.tsv",
        "rollback-readiness/failures.txt",
        "telemetry-recovery.env",
        "partial-recovery-SHA256SUMS",
    }
    relatives = {
        path[len(prefix):]
        for path in files
        if path.startswith(prefix)
    }
    if (
        len(relatives) != len(files)
        or relatives != expected_relatives
    ):
        fail(f"{label} artifact has an unexpected file set")
    with tempfile.TemporaryDirectory(
        prefix=".upstream-binding-recovery-",
        dir=Path.cwd(),
    ) as temporary:
        root = Path(temporary)
        for path, raw in files.items():
            if not path.startswith(prefix):
                fail(f"{label} artifact has inconsistent paths")
            relative = path[len(prefix):]
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        helper = Path(__file__).with_name(
            "validate-partial-recovery-authority-stan.sh"
        )
        environment = os.environ.copy()
        environment.update(
            {
                "PARTIAL_RECOVERY_DIR": str(root),
                "EXPECTED_RECOVERY_RUN_ID": run_id,
                "EXPECTED_SOURCE_SHA": source_sha,
            }
        )
        result = subprocess.run(
            [str(helper)],
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )
        if result.returncode != 0:
            fail(f"repository-fixed validator rejected {label}")
        authority = parse_env(
            (root / "partial-recovery-authority.env").read_bytes(),
            f"{label} authority",
        )
    if (
        authority.get("recovery_run_id") != run_id
        or authority.get("recovery_head_sha") != metadata.get("head_sha")
        or authority.get("restored_source_sha") != source_sha
        or metadata.get("display_title")
        != f"oci-rollback {authority.get('target_sha')}"
    ):
        fail(f"{label} metadata differs from its recovery authority")

    _, images_raw = unique_artifact_file(files, "images.tsv", label)
    recovered_images = validate_recovery_image_rows(images_raw, label)
    build_run = authority.get("restored_build_run_id", "")
    build_images = validate_current_build_artifact(
        repository,
        build_run,
        source_sha,
        f"{label} restored build",
    )
    if build_images != recovered_images:
        fail(f"{label} restored images differ from the selected build")

    infrastructure_source = validate_infrastructure_artifact(
        repository,
        authority["infrastructure_run_id"],
        authority["infrastructure_provenance_sha256"],
        authority["runtime_mode"],
        authority["runtime_fingerprint"],
        {
            "public_host": authority["public_host"],
            "canonical_host": authority["canonical_host"],
            "redirect_host": authority["redirect_host"],
            "diagnostic_host": authority["diagnostic_host"],
        },
        f"{label} infrastructure",
    )
    if infrastructure_source != source_sha:
        fail(f"{label} infrastructure source differs")
    _, recovery_plan_raw = unique_artifact_file(
        files, "recovery-plan.tsv", label
    )
    recovery_plan = parse_tsv(
        recovery_plan_raw, 4, f"{label} recovery plan"
    )
    _, telemetry_raw = unique_artifact_file(
        files, "telemetry-recovery.env", label
    )
    recovered_telemetry = parse_env(
        telemetry_raw, f"{label} recovered telemetry"
    )
    failed_run = authority.get("source_rollback_run_id", "")
    failed = validate_failed_partial_rollback_artifact(
        repository,
        failed_run,
        source_sha,
        authority["target_sha"],
        recovered_images,
        recovery_plan,
        recovered_telemetry,
        f"{label} failed rollback",
    )
    if not (
        parse_timestamp(
            failed.get("updated_at"), f"{label} failed rollback completion"
        )
        <= parse_timestamp(
            metadata.get("created_at"), f"{label} recovery creation"
        )
    ):
        fail(f"{label} failed rollback chronology is invalid")


def validate_baseline_recovery_profile(
    repository,
    dispatch_inputs,
    subject_sha,
):
    run_id = str(dispatch_inputs.get("baseline_recovery_run_id", ""))
    source_sha = dispatch_inputs.get("baseline_recovery_source_sha")
    if not run_id and source_sha is None:
        return
    if run_id == "0":
        if source_sha != "none":
            fail("zero baseline recovery run requires source none")
        return
    if (
        POSITIVE_INTEGER.fullmatch(run_id) is None
        or not isinstance(source_sha, str)
        or FULL_SHA.fullmatch(source_sha) is None
    ):
        fail("baseline recovery run and source are invalid")

    candidates = (
        (
            "oci-ghcr-cache-recovery.yml",
            f"ghcr-cache-recovery-{source_sha}-{run_id}-1",
            f"oci-ghcr-cache-recovery {source_sha}",
            "cache",
        ),
        (
            "oci-production-rollback.yml",
            f"oci-production-rollback-{run_id}-1",
            None,
            "partial",
        ),
    )
    selected = None
    for workflow, artifact_name, title, kind in candidates:
        workflow_metadata = gh_api(
            f"repos/{repository}/actions/workflows/{workflow}"
        )
        if not isinstance(workflow_metadata, dict) or type(
            workflow_metadata.get("id")
        ) is not int:
            fail("baseline recovery workflow metadata is invalid")
        base = gh_api(f"repos/{repository}/actions/runs/{run_id}")
        if base.get("workflow_id") == workflow_metadata["id"]:
            selected = (workflow, artifact_name, title, kind)
            break
    if selected is None:
        fail("baseline recovery run is not a fixed trusted workflow")
    workflow, artifact_name, title, kind = selected
    metadata = fixed_run_metadata(
        repository,
        run_id,
        workflow,
        "success",
        "baseline recovery",
    )
    if title is not None and metadata.get("display_title") != title:
        fail("baseline recovery title differs from its selected source")
    validate_descendant_scope(metadata["head_sha"], subject_sha)
    validate_descendant_scope(source_sha, subject_sha)
    artifact = exact_artifact(
        repository, run_id, artifact_name, "baseline recovery"
    )
    if kind == "cache":
        validate_cache_recovery_artifact(
            repository,
            run_id,
            source_sha,
            artifact,
            "baseline recovery",
        )
    else:
        validate_partial_recovery_artifact(
            repository,
            run_id,
            source_sha,
            artifact,
            metadata,
            "baseline recovery",
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
    validate_baseline_recovery_profile(
        repository,
        dispatch_inputs,
        subject_sha,
    )


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
    evidence, _, files = parse_live_v6_artifact(
        repository, run_id, binding["input"], include_files=True
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
    authority = parse_resume_authority(files, evidence, binding["input"])
    if authority and authority["resume_maintenance_mode"] == "pre-runtime-hold":
        validate_pre_runtime_resume_chain(repository, run_id, runtime_mode)


def validate_binding(
    repository,
    binding,
    subject_sha,
    run_id,
    dispatch_inputs=None,
    runtime_mode=None,
    successor_run_id="",
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
        if expected_head_input in {"resume_source_sha", "held_handoff_source_sha"}:
            validate_descendant_scope(expected_head_sha, subject_sha)
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
    profile = binding.get("runProfile")
    if profile == "oci-successful-held-handoff-v1":
        return validate_held_handoff_artifact(
            repository, run_id, expected_head_sha, subject_sha, dispatch_inputs,
            runtime_mode, binding["input"], successor_run_id=successor_run_id,
        )
    if profile == "oci-failed-deploy-retained-hold-v1":
        outcomes = validate_failed_deploy_jobs(repository, run_id, profile, binding["input"])
        if outcomes == ("skipped", "skipped", "skipped"):
            result = validate_failed_deploy_artifacts(
                repository, run_id, expected_head_sha, None, dispatch_inputs,
                runtime_mode, profile, *outcomes, binding["input"], pre_runtime=True,
            )
            return {
                "baselineFiles": result.pop("_baseline_files"),
                "artifactName": result["baseline_artifact_name"],
                "createdAt": base.get("created_at"),
                "completedAt": base.get("updated_at"),
                "resume": dict(result, failed_deploy_job_conclusion="failure",
                    public_validate_job_conclusion="skipped",
                    lock_release_step_conclusion="skipped",
                    fence_release_step_conclusion="skipped",
                    rehold_step_conclusion="skipped"),
            }
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
        expected_head_sha,
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
    facts = {
        "artifactName": artifact_name,
        "createdAt": base.get("created_at"),
        "completedAt": base.get("updated_at"),
    }
    if profile in RUN_PROFILES - {"oci-failed-activation-cleanup-v1"}:
        lock, fence, rehold = validate_failed_deploy_jobs(repository, run_id, profile, binding["input"])
        retained = profile == "oci-failed-deploy-retained-hold-v1"
        facts["resume"] = {
            "resume_maintenance_mode": "retained-hold" if retained else "released-runtime",
            "baseline_run_id": run_id,
            "baseline_artifact_name": artifact_name,
            "failed_deploy_job_conclusion": "failure" if retained else "success",
            "public_validate_job_conclusion": "skipped" if retained else "failure",
            "lock_release_step_conclusion": lock,
            "fence_release_step_conclusion": fence,
            "rehold_step_conclusion": rehold,
        }
    return facts


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
    if args.policy_json and not args.manifest:
        policy = json.loads(args.policy_json)
        if isinstance(policy, dict) and policy.get("workflow") == "oci-live-data-rollout.yml":
            if not isinstance(policy.get("inputNames"), list):
                fail("live data policy input contract is missing")
            inputs = live_data_native_inputs(inputs, policy["inputNames"])
        if isinstance(policy, dict) and any(binding.get("runProfile") == "oci-successful-held-handoff-v1"
               for binding in policy.get("upstreamRunBindings", [])):
            if policy.get("operation") != "oci-live-data-continue-held-handoff":
                fail("successful held-handoff profile is restricted to its fixed operation")
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
            getattr(args, "successor_run_id", ""),
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
    if args.result_json:
        safe_results = {
            name: facts["resume"] for name, facts in validated.items()
            if "resume" in facts
        }
        with open(args.result_json, "x", encoding="utf-8") as handle:
            json.dump(safe_results, handle, sort_keys=True)
    if getattr(args, "held_history_file", ""):
        histories = [facts["heldHistory"] for facts in validated.values() if "heldHistory" in facts]
        if len(histories) != 1 or histories[0]["cutoff_at"] is None:
            fail("held-handoff history requires an authenticated running successor cutoff")
        output = Path(args.held_history_file)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as handle:
            json.dump(histories[0], handle, sort_keys=True)
    if args.baseline_dir:
        baselines = [facts["baselineFiles"] for facts in validated.values() if "baselineFiles" in facts]
        if any(files != baselines[0] for files in baselines):
            fail("held-handoff and original root baselines disagree")
        for files in baselines[:1]:
            root = Path(args.baseline_dir)
            if root.is_symlink() or (root.exists() and any(root.iterdir())):
                fail("original before baseline output must be empty")
            root.mkdir(parents=True, exist_ok=True)
            for relative, raw in files.items():
                destination = root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open("xb") as handle:
                    handle.write(raw)


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
    every.add_argument("--result-json", default="")
    every.add_argument("--baseline-dir", default="")
    every.add_argument("--successor-run-id", default="")
    every.add_argument("--held-history-file", default="")
    every.set_defaults(func=command_validate_all)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
