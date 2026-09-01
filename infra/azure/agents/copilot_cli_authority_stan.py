#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import tempfile
from pathlib import Path


REQUEST_SCHEMA = "betstan.copilot-cli-dispatch-request.v1"
NORMALIZED_SCHEMA = "betstan.copilot-cli-dispatch-normalized.v1"
INTENT_SCHEMA = "betstan.copilot-cli-dispatch-intent.v1"
RECORD_SCHEMA = "betstan.copilot-cli-authority.v1"
AUTHORITY_OWNER = "github-copilot-cli"
AUTHORITY_TTL_SECONDS = 24 * 60 * 60
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
OBJECT_ID = re.compile(r"^[0-9a-f]{24}$")
POSITIVE_INTEGER = re.compile(r"^[1-9][0-9]*$")
ZERO_OR_POSITIVE_INTEGER = re.compile(r"^(0|[1-9][0-9]*)$")
TEMPLATE_TOKEN = re.compile(
    r"\{(control_sha|subject_sha|target_sha|run_id|upstream_run_id|input:[A-Za-z0-9_]+)\}"
)

REQUEST_KEYS = {
    "schemaVersion",
    "repository",
    "operation",
    "controlSha",
    "subjectSha",
    "targetSha",
    "inputs",
}
NORMALIZED_KEYS = REQUEST_KEYS | {
    "dispatchInputs",
    "inputHash",
    "displayTitleTemplate",
    "subjectRelation",
    "targetRelation",
}
INTENT_KEYS = {
    "schemaVersion",
    "requestKey",
    "repository",
    "operation",
    "workflow",
    "workflowId",
    "workflowBlobSha",
    "event",
    "environment",
    "controlSha",
    "subjectSha",
    "targetSha",
    "inputs",
    "inputHash",
    "displayTitleTemplate",
    "authorityOwner",
    "createdAt",
    "expiresAt",
    "state",
    "version",
    "ownerPid",
    "captureFile",
    "dispatchStatus",
    "runId",
    "runUrl",
}
RECORD_KEYS = {
    "schemaVersion",
    "repository",
    "operation",
    "workflow",
    "workflowId",
    "workflowBlobSha",
    "event",
    "environment",
    "runId",
    "runUrl",
    "runAttempt",
    "displayTitle",
    "controlSha",
    "subjectSha",
    "targetSha",
    "inputs",
    "inputHash",
    "authorityOwner",
    "createdAt",
    "expiresAt",
    "state",
    "version",
    "approvals",
    "inflightApproval",
}
APPROVAL_KEYS = {
    "runId",
    "operation",
    "environmentId",
    "gateKey",
    "approvedAt",
}
INFLIGHT_KEYS = {
    "runId",
    "operation",
    "environmentId",
    "gateKey",
    "claimedAt",
    "previousState",
    "reviewer",
    "approvalComment",
    "approvalCountBefore",
}
LOCK_KEYS = {
    "token",
    "ownerPid",
    "createdAt",
}


def fail(message):
    raise SystemExit(message)


def duplicate_safe_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json_text(text, label):
    try:
        return json.loads(text, object_pairs_hook=duplicate_safe_object)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f"{label} is not valid JSON: {error}")


def recover_atomic_create_link(candidate, metadata):
    if metadata.st_nlink != 2:
        return metadata
    prefix = f".{candidate.name}."
    matches = []
    for sibling in candidate.parent.iterdir():
        if not sibling.name.startswith(prefix):
            continue
        sibling_metadata = sibling.lstat()
        if (
            stat.S_ISREG(sibling_metadata.st_mode)
            and not sibling.is_symlink()
            and sibling_metadata.st_uid == os.getuid()
            and sibling_metadata.st_dev == metadata.st_dev
            and sibling_metadata.st_ino == metadata.st_ino
            and stat.S_IMODE(sibling_metadata.st_mode) == 0o600
        ):
            matches.append(sibling)
    if len(matches) != 1:
        return metadata
    matches[0].unlink()
    directory_fd = os.open(candidate.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return candidate.lstat()


def load_json_file(
    path,
    label,
    *,
    private=False,
    exact_mode=None,
    recover_atomic_link=False,
):
    candidate = Path(path)
    if not candidate.is_absolute():
        fail(f"{label} path must be absolute")
    try:
        metadata = candidate.lstat()
    except FileNotFoundError:
        fail(f"{label} does not exist")
    if not stat.S_ISREG(metadata.st_mode) or candidate.is_symlink():
        fail(f"{label} must be a regular non-symlink file")
    if metadata.st_uid != os.getuid():
        fail(f"{label} must be owned by the current user")
    if recover_atomic_link:
        metadata = recover_atomic_create_link(candidate, metadata)
    if metadata.st_nlink != 1:
        fail(f"{label} must not have hard links")
    mode = stat.S_IMODE(metadata.st_mode)
    if exact_mode is not None and mode != exact_mode:
        fail(f"{label} must have mode {exact_mode:04o}")
    if private and mode & 0o077:
        fail(f"{label} must not be group- or world-accessible")
    if metadata.st_size > 1024 * 1024:
        fail(f"{label} is too large")
    try:
        text = candidate.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        fail(f"{label} must be UTF-8: {error}")
    return load_json_text(text, label)


def canonical_json(value):
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )


def canonical_input_hash(inputs):
    return hashlib.sha256(canonical_json(inputs).encode("utf-8")).hexdigest()


def workflow_dispatch_inputs(inputs):
    return {
        name: (
            str(value).lower()
            if isinstance(value, bool)
            else value
        )
        for name, value in inputs.items()
    }


def parse_utc(value, label):
    if not isinstance(value, str):
        fail(f"{label} must be a timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(f"{label} must be an ISO-8601 timestamp")
    if parsed.tzinfo is None:
        fail(f"{label} must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def utc_text(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def resolved_inside(path, parent):
    path_value = Path(path).resolve()
    parent_value = Path(parent).resolve()
    return path_value == parent_value or parent_value in path_value.parents


def require_outside_repo(path, repo_root, label):
    if resolved_inside(path, repo_root):
        fail(f"{label} must be outside the repository worktree")


def ensure_authority_dir(path, repo_root, *, create):
    directory = Path(path)
    if not directory.is_absolute():
        fail("authority directory must be absolute")
    require_outside_repo(directory, repo_root, "authority directory")
    if not directory.exists():
        if not create:
            fail("authority directory does not exist")
        directory.mkdir(mode=0o700, parents=True)
        directory.chmod(0o700)
    metadata = directory.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or directory.is_symlink():
        fail("authority directory must be a non-symlink directory")
    if metadata.st_uid != os.getuid():
        fail("authority directory must be owned by the current user")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        fail("authority directory must have mode 0700")
    return directory


def atomic_create(path, value):
    path = Path(path)
    if path.exists() or path.is_symlink():
        fail(f"refusing to overwrite existing file: {path.name}")
    descriptor, temporary_name = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.name}.",
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        payload = (canonical_json(value) + "\n").encode("utf-8")
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path)
        temporary.unlink()
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def atomic_replace(path, value):
    path = Path(path)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.name}.",
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        payload = (canonical_json(value) + "\n").encode("utf-8")
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def write_private_json(path, value, repo_root):
    output = Path(path)
    if not output.is_absolute():
        fail("output path must be absolute")
    require_outside_repo(output, repo_root, "normalized request")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if output.exists() or output.is_symlink():
        fail("normalized request output already exists")
    atomic_create(output, value)


def validate_policy(policy):
    if not isinstance(policy, dict):
        fail("policy must be an object")
    required = {
        "operation",
        "workflow",
        "event",
        "environment",
        "authority",
        "approvalWorkflowState",
        "titleTemplate",
        "inputNames",
        "fixedInputs",
        "booleanInputs",
        "allowEmptyInputs",
        "positiveIntegerInputs",
        "zeroOrPositiveIntegerInputs",
        "optionalPositiveIntegerInputs",
        "fullShaInputs",
        "objectIdOrLiterals",
        "inputPatterns",
        "inputTemplates",
        "forbiddenInputValues",
        "subjectInput",
        "subjectRelation",
        "targetInput",
        "targetRelation",
        "upstreamWorkflow",
        "upstreamEvent",
        "upstreamConclusion",
        "upstreamOperations",
        "requiresConsumedUpstream",
        "derivedOperations",
    }
    if set(policy) != required:
        fail("policy has an unexpected schema")
    if policy["approvalWorkflowState"] not in {
        "active",
        "disabled_manually",
    }:
        fail("policy approval workflow state is invalid")
    return policy


def validate_template_syntax(template, label):
    if not isinstance(template, str) or not template:
        fail(f"{label} must be a non-empty string")
    remainder = TEMPLATE_TOKEN.sub("", template)
    if "{" in remainder or "}" in remainder:
        fail(f"{label} has an unsupported placeholder")


def render_template(template, request, *, run_id=None, upstream_run_id=None):
    validate_template_syntax(template, "template")

    def replacement(match):
        token = match.group(1)
        if token == "control_sha":
            return request["controlSha"]
        if token == "subject_sha":
            return request["subjectSha"] or ""
        if token == "target_sha":
            return request["targetSha"] or ""
        if token == "run_id":
            if run_id is None:
                fail("template requires a run ID")
            return str(run_id)
        if token == "upstream_run_id":
            if upstream_run_id is None:
                fail("template requires an upstream run ID")
            return str(upstream_run_id)
        input_name = token.split(":", 1)[1]
        if input_name not in request["inputs"]:
            fail(f"template references unknown input: {input_name}")
        value = request["inputs"][input_name]
        if not isinstance(value, (str, bool)):
            fail(f"template input is not scalar: {input_name}")
        return str(value).lower() if isinstance(value, bool) else value

    return TEMPLATE_TOKEN.sub(replacement, template)


def validate_scalar_string(value, label, *, allow_empty):
    if not isinstance(value, str):
        fail(f"{label} must be a string")
    if not allow_empty and value == "":
        fail(f"{label} must not be empty")
    if len(value.encode("utf-8")) > 32768:
        fail(f"{label} is too large")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        fail(f"{label} contains a control character")


def validate_request_data(request, policy, repository, current_master):
    policy = validate_policy(policy)
    if not isinstance(request, dict) or set(request) != REQUEST_KEYS:
        fail("request has an unexpected schema")
    if request["schemaVersion"] != REQUEST_SCHEMA:
        fail("request schema version is unsupported")
    if request["repository"] != repository:
        fail("request repository does not match the current repository")
    if request["operation"] != policy["operation"]:
        fail("request operation does not match policy")
    if policy["authority"] != "dispatch-record":
        fail("operation is not directly dispatchable")
    if request["controlSha"] != current_master or not FULL_SHA.fullmatch(
        request["controlSha"]
    ):
        fail("request control SHA must equal current master")
    if request["subjectSha"] is not None and not FULL_SHA.fullmatch(
        request["subjectSha"]
    ):
        fail("request subject SHA must be null or a full lowercase SHA")
    if request["targetSha"] is not None and not FULL_SHA.fullmatch(
        request["targetSha"]
    ):
        fail("request target SHA must be null or a full lowercase SHA")

    inputs = request["inputs"]
    if not isinstance(inputs, dict):
        fail("request inputs must be an object")
    if set(inputs) != set(policy["inputNames"]):
        fail("request input names do not exactly match policy")

    boolean_inputs = set(policy["booleanInputs"])
    allow_empty = set(policy["allowEmptyInputs"])
    for name in policy["inputNames"]:
        value = inputs[name]
        if name in boolean_inputs:
            if not isinstance(value, bool):
                fail(f"input {name} must be a boolean")
        else:
            validate_scalar_string(
                value,
                f"input {name}",
                allow_empty=name in allow_empty,
            )

    for name, value in policy["fixedInputs"].items():
        if inputs[name] != value:
            fail(f"input {name} does not match the fixed policy value")
    for name in policy["positiveIntegerInputs"]:
        if not isinstance(inputs[name], str) or not POSITIVE_INTEGER.fullmatch(
            inputs[name]
        ):
            fail(f"input {name} must be a positive integer")
    for name in policy["zeroOrPositiveIntegerInputs"]:
        if not isinstance(inputs[name], str) or not ZERO_OR_POSITIVE_INTEGER.fullmatch(
            inputs[name]
        ):
            fail(f"input {name} must be zero or a positive integer")
    for name in policy["optionalPositiveIntegerInputs"]:
        value = inputs[name]
        if value != "" and (
            not isinstance(value, str) or not POSITIVE_INTEGER.fullmatch(value)
        ):
            fail(f"input {name} must be empty or a positive integer")
    for name in policy["fullShaInputs"]:
        if not isinstance(inputs[name], str) or not FULL_SHA.fullmatch(inputs[name]):
            fail(f"input {name} must be a full lowercase SHA")
    for name, literals in policy["objectIdOrLiterals"].items():
        value = inputs[name]
        if value not in literals and (
            not isinstance(value, str) or not OBJECT_ID.fullmatch(value)
        ):
            fail(f"input {name} must be a Mongo ObjectId or approved literal")
    for name, pattern in policy["inputPatterns"].items():
        value = inputs[name]
        if not isinstance(value, str) or re.fullmatch(pattern, value) is None:
            fail(f"input {name} does not match policy")
    for name, template in policy["inputTemplates"].items():
        expected = render_template(template, request)
        if inputs[name] != expected:
            fail(f"input {name} does not match its policy-bound template")
    for name, forbidden_values in policy["forbiddenInputValues"].items():
        if inputs[name] in forbidden_values:
            fail(f"input {name} uses a forbidden value")

    subject_input = policy["subjectInput"]
    if subject_input is None:
        if request["subjectSha"] is not None:
            fail("request subject SHA is not applicable to this operation")
    elif request["subjectSha"] is None or inputs[subject_input] != request["subjectSha"]:
        fail("request subject SHA does not match the policy input")

    target_input = policy["targetInput"]
    if target_input is None:
        if request["targetSha"] is not None:
            fail("request target SHA is not applicable to this operation")
    elif request["targetSha"] is None or inputs[target_input] != request["targetSha"]:
        fail("request target SHA does not match the policy input")

    if policy["subjectRelation"] == "current":
        if request["subjectSha"] != request["controlSha"]:
            fail("request subject SHA must equal current master")
    elif policy["subjectRelation"] not in {"none", "ancestor", "ancestor-or-current"}:
        fail("policy has an unsupported subject relation")
    if policy["targetRelation"] not in {"none", "ancestor", "ancestor-or-current"}:
        fail("policy has an unsupported target relation")

    validate_template_syntax(policy["titleTemplate"], "display title template")
    dispatch_inputs = workflow_dispatch_inputs(inputs)
    return {
        **request,
        "dispatchInputs": dispatch_inputs,
        "inputHash": canonical_input_hash(dispatch_inputs),
        "displayTitleTemplate": policy["titleTemplate"],
        "subjectRelation": policy["subjectRelation"],
        "targetRelation": policy["targetRelation"],
        "schemaVersion": NORMALIZED_SCHEMA,
    }


def load_normalized(path, policy, repository, current_master):
    normalized = load_json_file(path, "normalized request", private=True)
    if not isinstance(normalized, dict) or set(normalized) != NORMALIZED_KEYS:
        fail("normalized request has an unexpected schema")
    if normalized["schemaVersion"] != NORMALIZED_SCHEMA:
        fail("normalized request schema version is unsupported")
    request = {key: normalized[key] for key in REQUEST_KEYS}
    request["schemaVersion"] = REQUEST_SCHEMA
    expected = validate_request_data(request, policy, repository, current_master)
    if normalized != expected:
        fail("normalized request does not match canonical policy validation")
    return normalized


def record_path(directory, run_id):
    if not POSITIVE_INTEGER.fullmatch(str(run_id)):
        fail("run ID must be a positive integer")
    return directory / f"{run_id}.json"


def request_key(normalized):
    identity = {
        "repository": normalized["repository"],
        "operation": normalized["operation"],
        "controlSha": normalized["controlSha"],
        "inputHash": normalized["inputHash"],
    }
    return hashlib.sha256(canonical_json(identity).encode("utf-8")).hexdigest()


def intent_path(directory, key):
    if not re.fullmatch(r"[0-9a-f]{64}", key):
        fail("request key must be a lowercase SHA-256")
    return directory / f"request-{key}.json"


def durable_unlink(path):
    candidate = Path(path)
    candidate.unlink()
    directory_fd = os.open(candidate.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def create_private_file(path):
    candidate = Path(path)
    descriptor = os.open(
        candidate,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_fd = os.open(candidate.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def require_private_capture(path):
    candidate = Path(path)
    metadata = candidate.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or candidate.is_symlink()
        or metadata.st_uid != os.getuid()
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        fail("dispatch capture is unsafe")
    return metadata


def fsync_private_capture(path):
    candidate = Path(path)
    metadata = require_private_capture(candidate)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(candidate, flags)
    try:
        observed = os.fstat(descriptor)
        if (
            observed.st_dev != metadata.st_dev
            or observed.st_ino != metadata.st_ino
            or not stat.S_ISREG(observed.st_mode)
        ):
            fail("dispatch capture changed before persistence")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def load_intent(directory, key):
    path = intent_path(directory, key)
    intent = load_json_file(
        path,
        "dispatch intent",
        exact_mode=0o600,
        recover_atomic_link=True,
    )
    if not isinstance(intent, dict) or set(intent) != INTENT_KEYS:
        fail("dispatch intent has an unexpected schema")
    if intent["schemaVersion"] != INTENT_SCHEMA:
        fail("dispatch intent schema version is unsupported")
    if intent["requestKey"] != key:
        fail("dispatch intent request key mismatch")
    if intent["authorityOwner"] != AUTHORITY_OWNER:
        fail("dispatch intent owner is invalid")
    if intent["state"] not in {"dispatching", "bound"}:
        fail("dispatch intent state is invalid")
    if not isinstance(intent["version"], int) or intent["version"] < 1:
        fail("dispatch intent version is invalid")
    if not isinstance(intent["ownerPid"], int) or intent["ownerPid"] < 1:
        fail("dispatch intent owner PID is invalid")
    if (
        not isinstance(intent["captureFile"], str)
        or Path(intent["captureFile"]).name != intent["captureFile"]
        or not re.fullmatch(r"dispatch-[0-9a-f]{32}\.log", intent["captureFile"])
    ):
        fail("dispatch intent capture file is invalid")
    if intent["dispatchStatus"] is not None and (
        not isinstance(intent["dispatchStatus"], int)
        or intent["dispatchStatus"] < 0
        or intent["dispatchStatus"] > 255
    ):
        fail("dispatch intent status is invalid")
    if intent["state"] == "dispatching":
        if intent["runId"] is not None or intent["runUrl"] is not None:
            fail("dispatching intent unexpectedly identifies a run")
    else:
        if not POSITIVE_INTEGER.fullmatch(str(intent["runId"])):
            fail("bound dispatch intent run ID is invalid")
        expected_url = (
            f"https://github.com/{intent['repository']}/actions/runs/"
            f"{intent['runId']}"
        )
        if intent["runUrl"] != expected_url:
            fail("bound dispatch intent run URL is invalid")
    created_at = parse_utc(intent["createdAt"], "dispatch intent creation time")
    expires_at = parse_utc(intent["expiresAt"], "dispatch intent expiry time")
    if (
        expires_at <= created_at
        or (expires_at - created_at).total_seconds() > AUTHORITY_TTL_SECONDS
    ):
        fail("dispatch intent expiry is invalid")
    return intent


def verify_intent(
    intent,
    normalized,
    policy,
    repository,
    current_master,
    workflow_id,
    workflow_blob_sha,
):
    expected = {
        "repository": repository,
        "operation": policy["operation"],
        "workflow": policy["workflow"],
        "workflowId": int(workflow_id),
        "workflowBlobSha": workflow_blob_sha,
        "event": policy["event"],
        "environment": policy["environment"],
        "controlSha": current_master,
        "subjectSha": normalized["subjectSha"],
        "targetSha": normalized["targetSha"],
        "inputs": normalized["inputs"],
        "inputHash": normalized["inputHash"],
        "displayTitleTemplate": normalized["displayTitleTemplate"],
    }
    for name, value in expected.items():
        if intent[name] != value:
            fail(f"dispatch intent {name} mismatch")
    if intent["requestKey"] != request_key(normalized):
        fail("dispatch intent does not match the normalized request")
    return intent


def lock_path(directory, run_id):
    if not POSITIVE_INTEGER.fullmatch(str(run_id)):
        fail("run ID must be a positive integer")
    return directory / f"{run_id}.lock"


def load_record(directory, run_id):
    path = record_path(directory, run_id)
    record = load_json_file(
        path,
        "authority record",
        exact_mode=0o600,
        recover_atomic_link=True,
    )
    if not isinstance(record, dict) or set(record) != RECORD_KEYS:
        fail("authority record has an unexpected schema")
    if record["schemaVersion"] != RECORD_SCHEMA:
        fail("authority record schema version is unsupported")
    if str(record["runId"]) != str(run_id):
        fail("authority record run ID does not match its file")
    if record["authorityOwner"] != AUTHORITY_OWNER:
        fail("authority record owner is invalid")
    if record["runAttempt"] != 1:
        fail("authority record attempt must be one")
    if record["state"] not in {
        "claimed",
        "issued",
        "inflight",
        "consumed",
        "retired",
    }:
        fail("authority record state is invalid")
    if not isinstance(record["version"], int) or record["version"] < 1:
        fail("authority record version is invalid")
    if not isinstance(record["approvals"], list):
        fail("authority record approvals must be a list")
    observed = set()
    for approval in record["approvals"]:
        if not isinstance(approval, dict) or set(approval) != APPROVAL_KEYS:
            fail("authority record approval has an unexpected schema")
        tuple_key = (
            str(approval["runId"]),
            str(approval["environmentId"]),
            approval["gateKey"],
        )
        if tuple_key in observed:
            fail("authority record contains a duplicate approval receipt")
        observed.add(tuple_key)
        if not POSITIVE_INTEGER.fullmatch(str(approval["runId"])):
            fail("authority record approval run ID is invalid")
        if not POSITIVE_INTEGER.fullmatch(str(approval["environmentId"])):
            fail("authority record environment ID is invalid")
        if not re.fullmatch(r"[0-9a-f]{64}", approval["gateKey"]):
            fail("authority record gate key is invalid")
        parse_utc(approval["approvedAt"], "authority approval time")
    inflight = record["inflightApproval"]
    if record["state"] == "inflight":
        if not isinstance(inflight, dict) or set(inflight) != INFLIGHT_KEYS:
            fail("inflight authority record is incomplete")
        if inflight["previousState"] not in {"issued", "consumed"}:
            fail("inflight authority record has an invalid prior state")
        if not POSITIVE_INTEGER.fullmatch(str(inflight["runId"])):
            fail("inflight authority run ID is invalid")
        if not POSITIVE_INTEGER.fullmatch(str(inflight["environmentId"])):
            fail("inflight authority environment ID is invalid")
        if not re.fullmatch(r"[0-9a-f]{64}", inflight["gateKey"]):
            fail("inflight authority gate key is invalid")
        parse_utc(inflight["claimedAt"], "authority claim time")
        validate_scalar_string(
            inflight["reviewer"],
            "inflight authority reviewer",
            allow_empty=False,
        )
        validate_scalar_string(
            inflight["approvalComment"],
            "inflight authority approval comment",
            allow_empty=False,
        )
        if (
            not isinstance(inflight["approvalCountBefore"], int)
            or inflight["approvalCountBefore"] < 0
        ):
            fail("inflight authority approval baseline is invalid")
    elif inflight is not None:
        fail("non-inflight authority record has an inflight claim")
    if record["state"] == "retired" and record["approvals"]:
        fail("retired authority record unexpectedly has approval receipts")
    return record


def verify_record(
    record,
    policy,
    repository,
    current_master,
    workflow_id,
    workflow_blob_sha,
):
    policy = validate_policy(policy)
    if record["repository"] != repository:
        fail("authority record repository mismatch")
    if record["operation"] != policy["operation"]:
        fail("authority record operation mismatch")
    if record["workflow"] != policy["workflow"]:
        fail("authority record workflow mismatch")
    if record["event"] != policy["event"]:
        fail("authority record event mismatch")
    if record["environment"] != policy["environment"]:
        fail("authority record environment mismatch")
    if str(record["workflowId"]) != str(workflow_id):
        fail("authority record workflow ID mismatch")
    if record["workflowBlobSha"] != workflow_blob_sha:
        fail("authority record workflow blob mismatch")
    if record["controlSha"] != current_master:
        fail("authority record control SHA is stale")
    if policy["authority"] == "dispatch-record":
        request = {
            "schemaVersion": REQUEST_SCHEMA,
            "repository": record["repository"],
            "operation": record["operation"],
            "controlSha": record["controlSha"],
            "subjectSha": record["subjectSha"],
            "targetSha": record["targetSha"],
            "inputs": record["inputs"],
        }
        normalized = validate_request_data(
            request,
            policy,
            repository,
            current_master,
        )
        if record["inputHash"] != normalized["inputHash"]:
            fail("authority record input hash mismatch")
        expected_title = render_template(
            policy["titleTemplate"],
            request,
            run_id=record["runId"],
        )
        if record["displayTitle"] != expected_title:
            fail("authority record display title mismatch")
    elif policy["authority"] in {"promotion", "promotion-upstream"}:
        if (
            record["inputs"] != {}
            or record["inputHash"] != canonical_input_hash({})
            or record["subjectSha"] is not None
            or record["targetSha"] is not None
        ):
            fail("automatic authority record has unexpected dispatch data")
        validate_scalar_string(
            record["displayTitle"],
            "automatic authority display title",
            allow_empty=False,
        )
    else:
        fail("policy does not own a standalone authority record")
    allowed_approval_operations = {
        record["operation"],
        *policy["derivedOperations"],
    }
    for approval in record["approvals"]:
        if approval["operation"] not in allowed_approval_operations:
            fail("authority record contains an unauthorized approval operation")
        if (
            approval["operation"] == record["operation"]
            and approval["runId"] != record["runId"]
        ):
            fail("direct authority receipt references a different run")
    if record["inflightApproval"] is not None:
        inflight = record["inflightApproval"]
        if inflight["operation"] not in allowed_approval_operations:
            fail("authority record contains an unauthorized inflight operation")
        if (
            inflight["operation"] == record["operation"]
            and inflight["runId"] != record["runId"]
        ):
            fail("direct inflight authority references a different run")
    expected_url = (
        f"https://github.com/{repository}/actions/runs/{record['runId']}"
    )
    if record["runUrl"] != expected_url:
        fail("authority record run URL mismatch")
    created_at = parse_utc(record["createdAt"], "authority creation time")
    expires_at = parse_utc(record["expiresAt"], "authority expiry time")
    if expires_at <= created_at:
        fail("authority record expiry is invalid")
    if (expires_at - created_at).total_seconds() > AUTHORITY_TTL_SECONDS:
        fail("authority record lifetime exceeds policy")
    if (
        utc_now() >= expires_at
        and record["state"] not in {"claimed", "inflight", "retired"}
    ):
        fail("authority record has expired")
    return record


def validate_run_against_record(run, record):
    if not isinstance(run, dict):
        fail("workflow run response must be an object")
    checks = [
        (str(run.get("id", "")) == str(record["runId"]), "run ID"),
        (
            str(run.get("workflow_id", "")) == str(record["workflowId"]),
            "workflow ID",
        ),
        (
            run.get("path") == f".github/workflows/{record['workflow']}",
            "workflow path",
        ),
        (run.get("event") == record["event"], "event"),
        (run.get("head_sha") == record["controlSha"], "control SHA"),
        (run.get("head_branch") == "master", "head branch"),
        (
            (run.get("head_repository") or {}).get("full_name")
            == record["repository"],
            "head repository",
        ),
        (int(run.get("run_attempt", 0)) == 1, "run attempt"),
        (run.get("display_title") == record["displayTitle"], "display title"),
    ]
    failures = [label for valid, label in checks if not valid]
    if failures:
        fail("workflow run does not match authority record: " + ", ".join(failures))


def load_lock(directory, run_id):
    path = lock_path(directory, run_id)
    metadata = path.lstat()
    metadata = recover_atomic_create_link(path, metadata)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_uid != os.getuid()
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        fail("authority lock is unsafe")
    lock = load_json_text(
        path.read_text(encoding="utf-8"),
        "authority lock",
    )
    if not isinstance(lock, dict) or set(lock) != LOCK_KEYS:
        fail("authority lock has an unexpected schema")
    if not isinstance(lock["ownerPid"], int) or lock["ownerPid"] < 1:
        fail("authority lock owner PID is invalid")
    parse_utc(lock["createdAt"], "authority lock creation time")
    return path, lock


def require_lock(directory, run_id, token):
    path, lock = load_lock(directory, run_id)
    if lock["token"] != token:
        fail("authority lock token mismatch")
    return path


def process_is_alive(process_id):
    try:
        os.kill(process_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def acquire_lock_file(directory, run_id, owner_pid):
    path = lock_path(directory, run_id)
    if path.exists() or path.is_symlink():
        _, existing = load_lock(directory, run_id)
        if process_is_alive(existing["ownerPid"]):
            fail("authority lock is held by a live process")
        fail("authority lock owner is gone; clear the exact stale lock before retrying")
    token = secrets.token_hex(32)
    atomic_create(
        path,
        {
            "token": token,
            "ownerPid": owner_pid,
            "createdAt": utc_text(utc_now()),
        },
    )
    return token


def update_record_with_lock(directory, run_id, token, transform):
    require_lock(directory, run_id, token)
    path = record_path(directory, run_id)
    record = load_record(directory, run_id)
    updated = transform(record)
    atomic_replace(path, updated)
    return updated


def command_validate_request(args):
    policy = validate_policy(load_json_text(args.policy_json, "policy"))
    request_path = Path(args.request)
    require_outside_repo(request_path, args.repo_root, "request file")
    request = load_json_file(
        request_path,
        "request file",
        private=True,
    )
    normalized = validate_request_data(
        request,
        policy,
        args.repository,
        args.current_master,
    )
    write_private_json(args.output, normalized, args.repo_root)


def command_preflight_root(args):
    ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=True,
    )


def command_request_operation(args):
    request_path = Path(args.request)
    require_outside_repo(request_path, args.repo_root, "request file")
    request = load_json_file(
        request_path,
        "request file",
        private=True,
    )
    if not isinstance(request, dict) or set(request) != REQUEST_KEYS:
        fail("request has an unexpected schema")
    validate_scalar_string(
        request["operation"],
        "request operation",
        allow_empty=False,
    )
    print(request["operation"])


def command_write_inputs(args):
    normalized = load_json_file(
        args.normalized,
        "normalized request",
        private=True,
    )
    if not isinstance(normalized, dict) or set(normalized) != NORMALIZED_KEYS:
        fail("normalized request has an unexpected schema")
    if normalized["schemaVersion"] != NORMALIZED_SCHEMA:
        fail("normalized request schema version is unsupported")
    output = Path(args.output)
    if not output.is_absolute():
        fail("input payload output path must be absolute")
    require_outside_repo(output, args.repo_root, "input payload")
    if output.exists() or output.is_symlink():
        fail("input payload output already exists")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        payload = canonical_json(normalized["dispatchInputs"]).encode("utf-8")
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            output.unlink()
        except FileNotFoundError:
            pass
        raise


def build_dispatch_record(
    normalized,
    policy,
    repository,
    workflow_id,
    workflow_blob_sha,
    run_id,
    run_url,
):
    request = {key: normalized[key] for key in REQUEST_KEYS}
    request["schemaVersion"] = REQUEST_SCHEMA
    display_title = render_template(
        policy["titleTemplate"],
        request,
        run_id=run_id,
    )
    created_at = utc_now()
    return {
        "schemaVersion": RECORD_SCHEMA,
        "repository": repository,
        "operation": policy["operation"],
        "workflow": policy["workflow"],
        "workflowId": int(workflow_id),
        "workflowBlobSha": workflow_blob_sha,
        "event": policy["event"],
        "environment": policy["environment"],
        "runId": int(run_id),
        "runUrl": run_url,
        "runAttempt": 1,
        "displayTitle": display_title,
        "controlSha": normalized["controlSha"],
        "subjectSha": normalized["subjectSha"],
        "targetSha": normalized["targetSha"],
        "inputs": normalized["inputs"],
        "inputHash": normalized["inputHash"],
        "authorityOwner": AUTHORITY_OWNER,
        "createdAt": utc_text(created_at),
        "expiresAt": utc_text(
            created_at + dt.timedelta(seconds=AUTHORITY_TTL_SECONDS)
        ),
        "state": "claimed",
        "version": 1,
        "approvals": [],
        "inflightApproval": None,
    }


def command_claim_request(args):
    policy = validate_policy(load_json_text(args.policy_json, "policy"))
    normalized = load_normalized(
        args.normalized,
        policy,
        args.repository,
        args.current_master,
    )
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=True,
    )
    workflow_id = str(args.workflow_id)
    if not POSITIVE_INTEGER.fullmatch(workflow_id):
        fail("workflow ID must be a positive integer")
    if not re.fullmatch(r"[0-9a-f]{40}", args.workflow_blob_sha):
        fail("workflow blob SHA must be a full lowercase Git object ID")
    if args.owner_pid < 1:
        fail("dispatch intent owner PID must be positive")
    key = request_key(normalized)
    path = intent_path(directory, key)
    if path.exists() or path.is_symlink():
        intent = verify_intent(
            load_intent(directory, key),
            normalized,
            policy,
            args.repository,
            args.current_master,
            workflow_id,
            args.workflow_blob_sha,
        )
        print(canonical_json({
            "capturePath": str(directory / intent["captureFile"]),
            "created": False,
            "requestKey": key,
            "state": intent["state"],
            "version": intent["version"],
        }))
        return
    capture_name = f"dispatch-{secrets.token_hex(16)}.log"
    capture_path = directory / capture_name
    create_private_file(capture_path)
    created_at = utc_now()
    intent = {
        "schemaVersion": INTENT_SCHEMA,
        "requestKey": key,
        "repository": args.repository,
        "operation": policy["operation"],
        "workflow": policy["workflow"],
        "workflowId": int(workflow_id),
        "workflowBlobSha": args.workflow_blob_sha,
        "event": policy["event"],
        "environment": policy["environment"],
        "controlSha": normalized["controlSha"],
        "subjectSha": normalized["subjectSha"],
        "targetSha": normalized["targetSha"],
        "inputs": normalized["inputs"],
        "inputHash": normalized["inputHash"],
        "displayTitleTemplate": normalized["displayTitleTemplate"],
        "authorityOwner": AUTHORITY_OWNER,
        "createdAt": utc_text(created_at),
        "expiresAt": utc_text(
            created_at + dt.timedelta(seconds=AUTHORITY_TTL_SECONDS)
        ),
        "state": "dispatching",
        "version": 1,
        "ownerPid": args.owner_pid,
        "captureFile": capture_name,
        "dispatchStatus": None,
        "runId": None,
        "runUrl": None,
    }
    try:
        atomic_create(path, intent)
    except BaseException:
        try:
            durable_unlink(capture_path)
        except FileNotFoundError:
            pass
        raise
    print(canonical_json({
        "capturePath": str(capture_path),
        "created": True,
        "requestKey": key,
        "state": intent["state"],
        "version": intent["version"],
    }))


def command_record_dispatch_status(args):
    policy = validate_policy(load_json_text(args.policy_json, "policy"))
    normalized = load_normalized(
        args.normalized,
        policy,
        args.repository,
        args.current_master,
    )
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    workflow_id = str(args.workflow_id)
    if not POSITIVE_INTEGER.fullmatch(workflow_id):
        fail("workflow ID must be a positive integer")
    if not re.fullmatch(r"[0-9a-f]{40}", args.workflow_blob_sha):
        fail("workflow blob SHA must be a full lowercase Git object ID")
    key = request_key(normalized)
    intent = verify_intent(
        load_intent(directory, key),
        normalized,
        policy,
        args.repository,
        args.current_master,
        workflow_id,
        args.workflow_blob_sha,
    )
    if intent["state"] != "dispatching":
        fail("only a dispatching intent can record command status")
    if intent["version"] != args.expected_version:
        fail("dispatch intent changed before command status was recorded")
    if args.dispatch_status < 0 or args.dispatch_status > 255:
        fail("dispatch command status is invalid")
    fsync_private_capture(directory / intent["captureFile"])
    intent["dispatchStatus"] = args.dispatch_status
    intent["version"] += 1
    atomic_replace(intent_path(directory, key), intent)
    print(intent["version"])


def command_cancel_intent(args):
    policy = validate_policy(load_json_text(args.policy_json, "policy"))
    normalized = load_normalized(
        args.normalized,
        policy,
        args.repository,
        args.current_master,
    )
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    workflow_id = str(args.workflow_id)
    if not POSITIVE_INTEGER.fullmatch(workflow_id):
        fail("workflow ID must be a positive integer")
    if not re.fullmatch(r"[0-9a-f]{40}", args.workflow_blob_sha):
        fail("workflow blob SHA must be a full lowercase Git object ID")
    key = request_key(normalized)
    intent = verify_intent(
        load_intent(directory, key),
        normalized,
        policy,
        args.repository,
        args.current_master,
        workflow_id,
        args.workflow_blob_sha,
    )
    if (
        intent["state"] != "dispatching"
        or intent["version"] != args.expected_version
        or intent["ownerPid"] != args.owner_pid
        or intent["dispatchStatus"] is not None
    ):
        fail("dispatch intent is not a pristine owned pre-dispatch claim")
    capture_path = directory / intent["captureFile"]
    metadata = require_private_capture(capture_path)
    if metadata.st_size != 0:
        fail("pre-dispatch capture is not empty")
    durable_unlink(intent_path(directory, key))
    try:
        durable_unlink(capture_path)
    except FileNotFoundError:
        pass


def command_bind_intent(args):
    policy = validate_policy(load_json_text(args.policy_json, "policy"))
    normalized = load_normalized(
        args.normalized,
        policy,
        args.repository,
        args.current_master,
    )
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    workflow_id = str(args.workflow_id)
    if not POSITIVE_INTEGER.fullmatch(workflow_id):
        fail("workflow ID must be a positive integer")
    if not re.fullmatch(r"[0-9a-f]{40}", args.workflow_blob_sha):
        fail("workflow blob SHA must be a full lowercase Git object ID")
    if args.expected_run_id is not None and not POSITIVE_INTEGER.fullmatch(
        str(args.expected_run_id)
    ):
        fail("expected run ID must be a positive integer")
    key = request_key(normalized)
    path = intent_path(directory, key)
    if not path.exists() and not path.is_symlink():
        if args.allow_missing:
            return
        fail("dispatch intent does not exist")
    intent = verify_intent(
        load_intent(directory, key),
        normalized,
        policy,
        args.repository,
        args.current_master,
        workflow_id,
        args.workflow_blob_sha,
    )
    capture_path = directory / intent["captureFile"]
    require_private_capture(capture_path)
    text = capture_path.read_text(encoding="utf-8", errors="replace")
    pattern = re.compile(
        rf"https://github\.com/{re.escape(args.repository)}/actions/runs/"
        r"([1-9][0-9]*)"
    )
    run_ids = list(dict.fromkeys(pattern.findall(text)))
    if len(run_ids) != 1:
        fail("dispatch capture does not contain exactly one repository run URL")
    run_id = run_ids[0]
    if args.expected_run_id is not None and run_id != str(args.expected_run_id):
        fail("dispatch capture run ID does not match the requested resume run")
    run_url = f"https://github.com/{args.repository}/actions/runs/{run_id}"
    if intent["state"] == "dispatching":
        intent["state"] = "bound"
        intent["runId"] = int(run_id)
        intent["runUrl"] = run_url
        intent["version"] += 1
        atomic_replace(path, intent)
    elif str(intent["runId"]) != run_id or intent["runUrl"] != run_url:
        fail("bound dispatch intent identifies a different run")
    record = build_dispatch_record(
        normalized,
        policy,
        args.repository,
        workflow_id,
        args.workflow_blob_sha,
        run_id,
        run_url,
    )
    record_file = record_path(directory, run_id)
    if record_file.exists() or record_file.is_symlink():
        existing = load_record(directory, run_id)
        verify_record(
            existing,
            policy,
            args.repository,
            args.current_master,
            workflow_id,
            args.workflow_blob_sha,
        )
        if (
            existing["operation"] != record["operation"]
            or existing["inputHash"] != record["inputHash"]
            or existing["runUrl"] != record["runUrl"]
        ):
            fail("existing authority record does not match dispatch intent")
    else:
        atomic_create(record_file, record)
    durable_unlink(path)
    try:
        durable_unlink(capture_path)
    except FileNotFoundError:
        pass
    print(run_id)


def command_ensure_automatic_record(args):
    policy = validate_policy(load_json_text(args.policy_json, "policy"))
    if policy["authority"] not in {"promotion", "promotion-upstream"}:
        fail("policy does not use automatic standalone authority")
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=True,
    )
    run = load_json_file(
        args.run_json,
        "workflow run response",
        private=True,
    )
    run_id = str(args.run_id)
    if not POSITIVE_INTEGER.fullmatch(run_id):
        fail("run ID must be a positive integer")
    workflow_id = str(args.workflow_id)
    if not POSITIVE_INTEGER.fullmatch(workflow_id):
        fail("workflow ID must be a positive integer")
    if not re.fullmatch(r"[0-9a-f]{40}", args.workflow_blob_sha):
        fail("workflow blob SHA must be a full lowercase Git object ID")
    path = record_path(directory, run_id)
    if path.exists() or path.is_symlink():
        record = load_record(directory, run_id)
        verified = verify_record(
            record,
            policy,
            args.repository,
            args.current_master,
            workflow_id,
            args.workflow_blob_sha,
        )
        validate_run_against_record(run, verified)
    else:
        created_at = utc_now()
        display_title = run.get("display_title") if isinstance(run, dict) else None
        validate_scalar_string(
            display_title,
            "workflow run display title",
            allow_empty=False,
        )
        record = {
            "schemaVersion": RECORD_SCHEMA,
            "repository": args.repository,
            "operation": policy["operation"],
            "workflow": policy["workflow"],
            "workflowId": int(workflow_id),
            "workflowBlobSha": args.workflow_blob_sha,
            "event": policy["event"],
            "environment": policy["environment"],
            "runId": int(run_id),
            "runUrl": (
                f"https://github.com/{args.repository}/actions/runs/{run_id}"
            ),
            "runAttempt": 1,
            "displayTitle": display_title,
            "controlSha": args.current_master,
            "subjectSha": None,
            "targetSha": None,
            "inputs": {},
            "inputHash": canonical_input_hash({}),
            "authorityOwner": AUTHORITY_OWNER,
            "createdAt": utc_text(created_at),
            "expiresAt": utc_text(
                created_at + dt.timedelta(seconds=AUTHORITY_TTL_SECONDS)
            ),
            "state": "issued",
            "version": 1,
            "approvals": [],
            "inflightApproval": None,
        }
        validate_run_against_record(run, record)
        atomic_create(path, record)
        verified = record
    print(canonical_json({
        "controlSha": verified["controlSha"],
        "displayTitle": verified["displayTitle"],
        "inputHash": verified["inputHash"],
        "inflightApproval": verified["inflightApproval"],
        "operation": verified["operation"],
        "runId": verified["runId"],
        "state": verified["state"],
        "subjectSha": verified["subjectSha"],
        "targetSha": verified["targetSha"],
        "version": verified["version"],
        "workflow": verified["workflow"],
    }))


def command_blocking_record(args):
    authority_path = Path(args.authority_dir)
    if not authority_path.exists():
        return
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    normalized = load_json_file(
        args.normalized,
        "normalized request",
        private=True,
    )
    if not isinstance(normalized, dict) or set(normalized) != NORMALIZED_KEYS:
        fail("normalized request has an unexpected schema")
    if normalized["schemaVersion"] != NORMALIZED_SCHEMA:
        fail("normalized request schema version is unsupported")
    matches = []
    for candidate in sorted(directory.glob("request-*.json")):
        key = candidate.stem.removeprefix("request-")
        intent = load_intent(directory, key)
        if (
            intent["repository"] == normalized["repository"]
            and intent["controlSha"] == normalized["controlSha"]
        ):
            matches.append((f"intent:{key}", intent["state"]))
    for candidate in sorted(directory.glob("*.json")):
        run_id = candidate.stem
        if run_id.startswith("request-"):
            continue
        if not POSITIVE_INTEGER.fullmatch(run_id):
            fail("authority directory contains an unexpected JSON file")
        record = load_record(directory, run_id)
        if (
            record["repository"] == normalized["repository"]
            and record["controlSha"] == normalized["controlSha"]
        ):
            globally_unresolved = record["state"] in {"claimed", "inflight"}
            exact_one_use = (
                record["operation"] == normalized["operation"]
                and record["inputHash"] == normalized["inputHash"]
                and record["state"] in {"issued", "consumed"}
            )
            if globally_unresolved or exact_one_use:
                matches.append((run_id, record["state"]))
    if matches:
        print(f"{matches[0][0]}\t{matches[0][1]}")


def command_issue(args):
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    token = acquire_lock_file(directory, args.run_id, os.getpid())
    try:
        run = load_json_file(args.run_json, "workflow run response", private=True)
        policy = validate_policy(load_json_text(args.policy_json, "policy"))

        def issue(record):
            verify_record(
                record,
                policy,
                args.repository,
                args.current_master,
                args.workflow_id,
                args.workflow_blob_sha,
            )
            if record["state"] != "claimed":
                fail("only a claimed authority record can be issued")
            validate_run_against_record(run, record)
            if (
                run.get("status")
                not in {"queued", "in_progress", "waiting", "pending", "requested"}
                or run.get("conclusion") not in {None, ""}
            ):
                fail("claimed authority run is not active")
            record["state"] = "issued"
            issued_at = utc_now()
            record["createdAt"] = utc_text(issued_at)
            record["expiresAt"] = utc_text(
                issued_at + dt.timedelta(seconds=AUTHORITY_TTL_SECONDS)
            )
            record["version"] += 1
            return record

        update_record_with_lock(directory, args.run_id, token, issue)
    finally:
        try:
            require_lock(directory, args.run_id, token).unlink()
        except FileNotFoundError:
            pass


def command_retire_inert_claim(args):
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    run = load_json_file(args.run_json, "workflow run response", private=True)
    jobs = load_json_file(args.jobs_json, "workflow jobs response", private=True)
    pending = load_json_file(
        args.pending_json,
        "pending deployments response",
        private=True,
    )
    policy = validate_policy(load_json_text(args.policy_json, "policy"))
    if (
        not isinstance(jobs, dict)
        or jobs.get("total_count") != 0
        or jobs.get("jobs") != []
    ):
        fail("terminal claimed run is not jobless")
    if not isinstance(pending, list) or pending:
        fail("terminal claimed run still has pending deployments")
    token = acquire_lock_file(directory, args.run_id, os.getpid())
    try:
        def retire(record):
            verify_record(
                record,
                policy,
                args.repository,
                args.current_master,
                args.workflow_id,
                args.workflow_blob_sha,
            )
            if record["state"] != "claimed":
                fail("only a claimed authority record can be retired")
            validate_run_against_record(run, record)
            if (
                run.get("status") != "completed"
                or run.get("conclusion") in {None, ""}
            ):
                fail("claimed authority run is not terminal")
            record["state"] = "retired"
            record["version"] += 1
            return record

        update_record_with_lock(directory, args.run_id, token, retire)
    finally:
        try:
            require_lock(directory, args.run_id, token).unlink()
        except FileNotFoundError:
            pass


def command_operation(args):
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    print(load_record(directory, args.run_id)["operation"])


def command_verify(args):
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    policy = validate_policy(load_json_text(args.policy_json, "policy"))
    record = load_record(directory, args.run_id)
    verified = verify_record(
        record,
        policy,
        args.repository,
        args.current_master,
        args.workflow_id,
        args.workflow_blob_sha,
    )
    print(canonical_json({
        "controlSha": verified["controlSha"],
        "displayTitle": verified["displayTitle"],
        "inputHash": verified["inputHash"],
        "inflightApproval": verified["inflightApproval"],
        "operation": verified["operation"],
        "runId": verified["runId"],
        "state": verified["state"],
        "subjectSha": verified["subjectSha"],
        "targetSha": verified["targetSha"],
        "version": verified["version"],
        "workflow": verified["workflow"],
    }))


def command_acquire_lock(args):
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=True,
    )
    if args.owner_pid < 1:
        fail("lock owner PID must be positive")
    token = acquire_lock_file(directory, args.run_id, args.owner_pid)
    print(token)


def command_release_lock(args):
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    require_lock(directory, args.run_id, args.token).unlink()


def command_clear_stale_lock(args):
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    _, lock = load_lock(directory, args.run_id)
    if process_is_alive(lock["ownerPid"]):
        fail("authority lock is still held by a live process")
    require_lock(directory, args.run_id, lock["token"]).unlink()


def command_claim_approval(args):
    if not POSITIVE_INTEGER.fullmatch(str(args.approval_run_id)):
        fail("approval run ID must be a positive integer")
    if not POSITIVE_INTEGER.fullmatch(str(args.environment_id)):
        fail("environment ID must be a positive integer")
    if not re.fullmatch(r"[0-9a-f]{64}", args.gate_key):
        fail("gate key must be a lowercase SHA-256")
    validate_scalar_string(
        args.approval_operation,
        "approval operation",
        allow_empty=False,
    )
    validate_scalar_string(
        args.reviewer,
        "approval reviewer",
        allow_empty=False,
    )
    validate_scalar_string(
        args.approval_comment,
        "approval comment",
        allow_empty=False,
    )
    if args.approval_count_before < 0:
        fail("approval history baseline must be zero or positive")
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )

    def claim(record):
        if record["version"] != args.expected_version:
            fail("authority record changed before approval claim")
        if record["state"] not in {"issued", "consumed"}:
            fail("authority record is not available for a new approval")
        tuple_key = (
            str(args.approval_run_id),
            str(args.environment_id),
            args.gate_key,
        )
        if any(
            (
                str(receipt["runId"]),
                str(receipt["environmentId"]),
                receipt["gateKey"],
            )
            == tuple_key
            for receipt in record["approvals"]
        ):
            fail("authority record already approved this exact gate")
        record["inflightApproval"] = {
            "runId": int(args.approval_run_id),
            "operation": args.approval_operation,
            "environmentId": int(args.environment_id),
            "gateKey": args.gate_key,
            "claimedAt": utc_text(utc_now()),
            "previousState": record["state"],
            "reviewer": args.reviewer,
            "approvalComment": args.approval_comment,
            "approvalCountBefore": args.approval_count_before,
        }
        record["state"] = "inflight"
        record["version"] += 1
        return record

    updated = update_record_with_lock(
        directory,
        args.run_id,
        args.token,
        claim,
    )
    print(updated["version"])


def command_release_approval(args):
    if not POSITIVE_INTEGER.fullmatch(str(args.approval_run_id)):
        fail("approval run ID must be a positive integer")
    if not POSITIVE_INTEGER.fullmatch(str(args.environment_id)):
        fail("environment ID must be a positive integer")
    if not re.fullmatch(r"[0-9a-f]{64}", args.gate_key):
        fail("gate key must be a lowercase SHA-256")
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )

    def release(record):
        inflight = record["inflightApproval"]
        if record["state"] != "inflight" or not isinstance(inflight, dict):
            fail("authority record has no inflight approval")
        if (
            str(inflight["runId"]) != str(args.approval_run_id)
            or str(inflight["environmentId"]) != str(args.environment_id)
            or inflight["operation"] != args.approval_operation
            or inflight["gateKey"] != args.gate_key
        ):
            fail("inflight approval does not match the requested release")
        record["state"] = inflight["previousState"]
        record["inflightApproval"] = None
        record["version"] += 1
        return record

    update_record_with_lock(directory, args.run_id, args.token, release)


def command_complete_approval(args):
    if not POSITIVE_INTEGER.fullmatch(str(args.approval_run_id)):
        fail("approval run ID must be a positive integer")
    if not POSITIVE_INTEGER.fullmatch(str(args.environment_id)):
        fail("environment ID must be a positive integer")
    if not re.fullmatch(r"[0-9a-f]{64}", args.gate_key):
        fail("gate key must be a lowercase SHA-256")
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )

    def complete(record):
        if record["version"] != args.expected_version:
            fail("authority record changed after approval claim")
        inflight = record["inflightApproval"]
        if record["state"] != "inflight" or not isinstance(inflight, dict):
            fail("authority record has no inflight approval")
        if (
            str(inflight["runId"]) != str(args.approval_run_id)
            or str(inflight["environmentId"]) != str(args.environment_id)
            or inflight["operation"] != args.approval_operation
            or inflight["gateKey"] != args.gate_key
        ):
            fail("inflight approval does not match GitHub acceptance")
        record["approvals"].append(
            {
                "runId": int(args.approval_run_id),
                "operation": args.approval_operation,
                "environmentId": int(args.environment_id),
                "gateKey": args.gate_key,
                "approvedAt": utc_text(utc_now()),
            }
        )
        record["state"] = "consumed"
        record["inflightApproval"] = None
        record["version"] += 1
        return record

    update_record_with_lock(
        directory,
        args.run_id,
        args.token,
        complete,
    )


def command_reconcile_approval(args):
    if not POSITIVE_INTEGER.fullmatch(str(args.approval_run_id)):
        fail("approval run ID must be a positive integer")
    validate_scalar_string(
        args.approval_operation,
        "approval operation",
        allow_empty=False,
    )
    if args.pending_environment_id < 0:
        fail("pending environment ID must be zero or positive")
    if args.pending_environment_id == 0:
        if args.pending_gate_key != "none":
            fail("absent pending environment must use gate key none")
    elif not re.fullmatch(r"[0-9a-f]{64}", args.pending_gate_key):
        fail("pending gate key must be a lowercase SHA-256")
    if args.observed_approval_count < 0:
        fail("observed approval count must be zero or positive")
    active_statuses = {
        "queued",
        "in_progress",
        "waiting",
        "pending",
        "requested",
    }
    if args.run_status not in {*active_statuses, "completed"}:
        fail("reconciliation run status is invalid")
    directory = ensure_authority_dir(
        args.authority_dir,
        args.repo_root,
        create=False,
    )
    require_lock(directory, args.run_id, args.token)
    path = record_path(directory, args.run_id)
    record = load_record(directory, args.run_id)
    if record["version"] != args.expected_version:
        fail("authority record changed before approval reconciliation")
    inflight = record["inflightApproval"]
    if record["state"] != "inflight" or not isinstance(inflight, dict):
        fail("authority record has no inflight approval")
    if (
        str(inflight["runId"]) != str(args.approval_run_id)
        or inflight["operation"] != args.approval_operation
    ):
        fail("inflight approval does not match the reconciliation target")
    if args.observed_approval_count < inflight["approvalCountBefore"]:
        fail("approval history count moved backwards")

    same_pending_gate = (
        args.pending_environment_id > 0
        and str(inflight["environmentId"])
        == str(args.pending_environment_id)
        and inflight["gateKey"] == args.pending_gate_key
    )
    approval_observed = (
        args.observed_approval_count > inflight["approvalCountBefore"]
    )
    reconciled_at = utc_now()
    if approval_observed:
        tuple_key = (
            str(inflight["runId"]),
            str(inflight["environmentId"]),
            inflight["gateKey"],
        )
        if any(
            (
                str(receipt["runId"]),
                str(receipt["environmentId"]),
                receipt["gateKey"],
            )
            == tuple_key
            for receipt in record["approvals"]
        ):
            fail("inflight approval already has a consumed receipt")
        record["approvals"].append(
            {
                "runId": inflight["runId"],
                "operation": inflight["operation"],
                "environmentId": inflight["environmentId"],
                "gateKey": inflight["gateKey"],
                "approvedAt": utc_text(reconciled_at),
            }
        )
        record["state"] = "consumed"
        record["inflightApproval"] = None
        outcome = "consumed"
    elif same_pending_gate and args.run_status in active_statuses:
        record["state"] = inflight["previousState"]
        record["inflightApproval"] = None
        record["createdAt"] = utc_text(reconciled_at)
        record["expiresAt"] = utc_text(
            reconciled_at + dt.timedelta(seconds=AUTHORITY_TTL_SECONDS)
        )
        outcome = "retry"
    else:
        print("unresolved")
        return
    record["version"] += 1
    atomic_replace(path, record)
    print(outcome)


def common_authority_arguments(parser):
    parser.add_argument("--authority-dir", required=True)
    parser.add_argument("--repo-root", required=True)


def build_parser():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_request = subparsers.add_parser("validate-request")
    validate_request.add_argument("--request", required=True)
    validate_request.add_argument("--policy-json", required=True)
    validate_request.add_argument("--repository", required=True)
    validate_request.add_argument("--current-master", required=True)
    validate_request.add_argument("--repo-root", required=True)
    validate_request.add_argument("--output", required=True)
    validate_request.set_defaults(function=command_validate_request)

    preflight_root = subparsers.add_parser("preflight-root")
    common_authority_arguments(preflight_root)
    preflight_root.set_defaults(function=command_preflight_root)

    request_operation = subparsers.add_parser("request-operation")
    request_operation.add_argument("--request", required=True)
    request_operation.add_argument("--repo-root", required=True)
    request_operation.set_defaults(function=command_request_operation)

    write_inputs = subparsers.add_parser("write-inputs")
    write_inputs.add_argument("--normalized", required=True)
    write_inputs.add_argument("--output", required=True)
    write_inputs.add_argument("--repo-root", required=True)
    write_inputs.set_defaults(function=command_write_inputs)

    claim_request = subparsers.add_parser("claim-request")
    claim_request.add_argument("--normalized", required=True)
    claim_request.add_argument("--policy-json", required=True)
    claim_request.add_argument("--repository", required=True)
    claim_request.add_argument("--current-master", required=True)
    claim_request.add_argument("--workflow-id", required=True)
    claim_request.add_argument("--workflow-blob-sha", required=True)
    claim_request.add_argument("--owner-pid", required=True, type=int)
    common_authority_arguments(claim_request)
    claim_request.set_defaults(function=command_claim_request)

    record_dispatch_status = subparsers.add_parser(
        "record-dispatch-status"
    )
    record_dispatch_status.add_argument("--normalized", required=True)
    record_dispatch_status.add_argument("--policy-json", required=True)
    record_dispatch_status.add_argument("--repository", required=True)
    record_dispatch_status.add_argument("--current-master", required=True)
    record_dispatch_status.add_argument("--workflow-id", required=True)
    record_dispatch_status.add_argument(
        "--workflow-blob-sha",
        required=True,
    )
    record_dispatch_status.add_argument(
        "--expected-version",
        required=True,
        type=int,
    )
    record_dispatch_status.add_argument(
        "--dispatch-status",
        required=True,
        type=int,
    )
    common_authority_arguments(record_dispatch_status)
    record_dispatch_status.set_defaults(
        function=command_record_dispatch_status
    )

    cancel_intent = subparsers.add_parser("cancel-intent")
    cancel_intent.add_argument("--normalized", required=True)
    cancel_intent.add_argument("--policy-json", required=True)
    cancel_intent.add_argument("--repository", required=True)
    cancel_intent.add_argument("--current-master", required=True)
    cancel_intent.add_argument("--workflow-id", required=True)
    cancel_intent.add_argument("--workflow-blob-sha", required=True)
    cancel_intent.add_argument("--expected-version", required=True, type=int)
    cancel_intent.add_argument("--owner-pid", required=True, type=int)
    common_authority_arguments(cancel_intent)
    cancel_intent.set_defaults(function=command_cancel_intent)

    bind_intent = subparsers.add_parser("bind-intent")
    bind_intent.add_argument("--normalized", required=True)
    bind_intent.add_argument("--policy-json", required=True)
    bind_intent.add_argument("--repository", required=True)
    bind_intent.add_argument("--current-master", required=True)
    bind_intent.add_argument("--workflow-id", required=True)
    bind_intent.add_argument("--workflow-blob-sha", required=True)
    bind_intent.add_argument("--expected-run-id")
    bind_intent.add_argument("--allow-missing", action="store_true")
    common_authority_arguments(bind_intent)
    bind_intent.set_defaults(function=command_bind_intent)

    ensure_automatic_record = subparsers.add_parser(
        "ensure-automatic-record"
    )
    ensure_automatic_record.add_argument("--run-id", required=True)
    ensure_automatic_record.add_argument("--run-json", required=True)
    ensure_automatic_record.add_argument("--policy-json", required=True)
    ensure_automatic_record.add_argument("--repository", required=True)
    ensure_automatic_record.add_argument("--current-master", required=True)
    ensure_automatic_record.add_argument("--workflow-id", required=True)
    ensure_automatic_record.add_argument(
        "--workflow-blob-sha",
        required=True,
    )
    common_authority_arguments(ensure_automatic_record)
    ensure_automatic_record.set_defaults(
        function=command_ensure_automatic_record
    )

    blocking_record = subparsers.add_parser("blocking-record")
    blocking_record.add_argument("--normalized", required=True)
    common_authority_arguments(blocking_record)
    blocking_record.set_defaults(function=command_blocking_record)

    issue = subparsers.add_parser("issue")
    issue.add_argument("--run-id", required=True)
    issue.add_argument("--run-json", required=True)
    issue.add_argument("--policy-json", required=True)
    issue.add_argument("--repository", required=True)
    issue.add_argument("--current-master", required=True)
    issue.add_argument("--workflow-id", required=True)
    issue.add_argument("--workflow-blob-sha", required=True)
    common_authority_arguments(issue)
    issue.set_defaults(function=command_issue)

    retire_inert_claim = subparsers.add_parser("retire-inert-claim")
    retire_inert_claim.add_argument("--run-id", required=True)
    retire_inert_claim.add_argument("--run-json", required=True)
    retire_inert_claim.add_argument("--jobs-json", required=True)
    retire_inert_claim.add_argument("--pending-json", required=True)
    retire_inert_claim.add_argument("--policy-json", required=True)
    retire_inert_claim.add_argument("--repository", required=True)
    retire_inert_claim.add_argument("--current-master", required=True)
    retire_inert_claim.add_argument("--workflow-id", required=True)
    retire_inert_claim.add_argument("--workflow-blob-sha", required=True)
    common_authority_arguments(retire_inert_claim)
    retire_inert_claim.set_defaults(function=command_retire_inert_claim)

    operation = subparsers.add_parser("operation")
    operation.add_argument("--run-id", required=True)
    common_authority_arguments(operation)
    operation.set_defaults(function=command_operation)

    verify = subparsers.add_parser("verify")
    verify.add_argument("--run-id", required=True)
    verify.add_argument("--policy-json", required=True)
    verify.add_argument("--repository", required=True)
    verify.add_argument("--current-master", required=True)
    verify.add_argument("--workflow-id", required=True)
    verify.add_argument("--workflow-blob-sha", required=True)
    common_authority_arguments(verify)
    verify.set_defaults(function=command_verify)

    acquire_lock = subparsers.add_parser("acquire-lock")
    acquire_lock.add_argument("--run-id", required=True)
    acquire_lock.add_argument("--owner-pid", required=True, type=int)
    common_authority_arguments(acquire_lock)
    acquire_lock.set_defaults(function=command_acquire_lock)

    release_lock = subparsers.add_parser("release-lock")
    release_lock.add_argument("--run-id", required=True)
    release_lock.add_argument("--token", required=True)
    common_authority_arguments(release_lock)
    release_lock.set_defaults(function=command_release_lock)

    clear_stale_lock = subparsers.add_parser("clear-stale-lock")
    clear_stale_lock.add_argument("--run-id", required=True)
    common_authority_arguments(clear_stale_lock)
    clear_stale_lock.set_defaults(function=command_clear_stale_lock)

    claim_approval = subparsers.add_parser("claim-approval")
    claim_approval.add_argument("--run-id", required=True)
    claim_approval.add_argument("--token", required=True)
    claim_approval.add_argument("--expected-version", required=True, type=int)
    claim_approval.add_argument("--approval-run-id", required=True)
    claim_approval.add_argument("--approval-operation", required=True)
    claim_approval.add_argument("--environment-id", required=True)
    claim_approval.add_argument("--gate-key", required=True)
    claim_approval.add_argument("--reviewer", required=True)
    claim_approval.add_argument("--approval-comment", required=True)
    claim_approval.add_argument(
        "--approval-count-before",
        required=True,
        type=int,
    )
    common_authority_arguments(claim_approval)
    claim_approval.set_defaults(function=command_claim_approval)

    release_approval = subparsers.add_parser("release-approval")
    release_approval.add_argument("--run-id", required=True)
    release_approval.add_argument("--token", required=True)
    release_approval.add_argument("--approval-run-id", required=True)
    release_approval.add_argument("--approval-operation", required=True)
    release_approval.add_argument("--environment-id", required=True)
    release_approval.add_argument("--gate-key", required=True)
    common_authority_arguments(release_approval)
    release_approval.set_defaults(function=command_release_approval)

    complete_approval = subparsers.add_parser("complete-approval")
    complete_approval.add_argument("--run-id", required=True)
    complete_approval.add_argument("--token", required=True)
    complete_approval.add_argument("--expected-version", required=True, type=int)
    complete_approval.add_argument("--approval-run-id", required=True)
    complete_approval.add_argument("--approval-operation", required=True)
    complete_approval.add_argument("--environment-id", required=True)
    complete_approval.add_argument("--gate-key", required=True)
    common_authority_arguments(complete_approval)
    complete_approval.set_defaults(function=command_complete_approval)

    reconcile_approval = subparsers.add_parser("reconcile-approval")
    reconcile_approval.add_argument("--run-id", required=True)
    reconcile_approval.add_argument("--token", required=True)
    reconcile_approval.add_argument(
        "--expected-version",
        required=True,
        type=int,
    )
    reconcile_approval.add_argument("--approval-run-id", required=True)
    reconcile_approval.add_argument("--approval-operation", required=True)
    reconcile_approval.add_argument(
        "--pending-environment-id",
        required=True,
        type=int,
    )
    reconcile_approval.add_argument("--pending-gate-key", required=True)
    reconcile_approval.add_argument(
        "--observed-approval-count",
        required=True,
        type=int,
    )
    reconcile_approval.add_argument("--run-status", required=True)
    common_authority_arguments(reconcile_approval)
    reconcile_approval.set_defaults(function=command_reconcile_approval)

    return parser


def main():
    arguments = build_parser().parse_args()
    arguments.function(arguments)


if __name__ == "__main__":
    main()
