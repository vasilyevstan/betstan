"""Frozen test-only v1 intent payload reader; not production authority.

Source: infra/azure/agents/copilot_cli_authority_stan.py
Commit: 2168e2b0a80703c860ba3ba8a328756b057e1cd8
The constants, fail, parse_utc, and post-load body of load_intent are
preserved from that source. Only the function name/arguments replace the
private-file loading preamble: this probe starts with a decoded JSON payload.
Filesystem validation, atomic-link recovery, and dispatch/approval machinery
are deliberately excluded. The dispatcher test pins these fixture bytes by
SHA-256; do not refresh that pin to follow the current reader.
"""

import datetime as dt
import re
from pathlib import Path


INTENT_SCHEMA = "betstan.copilot-cli-dispatch-intent.v1"
AUTHORITY_OWNER = "github-copilot-cli"
AUTHORITY_TTL_SECONDS = 24 * 60 * 60
POSITIVE_INTEGER = re.compile(r"^[1-9][0-9]*$")
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


def fail(message):
    raise SystemExit(message)


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


def validate_intent(intent, key):
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
