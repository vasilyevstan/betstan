#!/usr/bin/env python3
"""Versioned, fail-closed contracts for OCI production monitoring."""

from __future__ import annotations

import datetime as dt
import hashlib
import ipaddress
import json
import re
from pathlib import Path
from typing import Any, Iterable


REPOSITORY = "vasilyevstan/betstan"
ENVIRONMENT = "oci-production"
ACTIVE_RELEASE_SCHEMA = "betstan.active-release.v1"
OPERATION_SCHEMA = "betstan.production-operation.v1"
OBSERVATION_SCHEMA = "betstan.production-observation.v1"
INCIDENT_SCHEMA = "betstan.production-incident.v1"
REPAIR_SCHEMA = "betstan.production-repair.v1"
PROMOTION_SCHEMA = "betstan.production-repair-promotion.v1"
POLICY_SCHEMA = "betstan.production-monitor.policy.v1"
SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
HASH = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._:/-]{0,159}$")
WORKFLOW_PATH = re.compile(r"^\.github/workflows/[a-z0-9][a-z0-9._-]*\.ya?ml$")
SERVICE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
APPLICATION_SERVICES = {
    "auth",
    "backoffice",
    "bet",
    "client",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
}
ANOMALY_CODE = re.compile(r"^[a-z][a-z0-9-]{0,95}$")
SEVERITIES = {"critical", "high", "medium", "low"}
ANOMALY_CLASSIFICATIONS = {"anomaly", "maintenance", "unknown"}
INCIDENT_STATUSES = {"observing", "confirmed", "repairing", "validating", "resolved", "escalated"}
REPAIR_PHASES = {
    "claimed",
    "self-healing",
    "coding",
    "review",
    "merging",
    "promoting",
    "building",
    "deploying",
    "validating",
    "resolved",
    "failed",
    "unsupported-runbook",
}
OPERATION_STATES = {"active", "succeeded", "failed"}
SENSITIVE_KEY = re.compile(
    r"(?:authorization|cookie|password|passwd|secret|token|private[_-]?key|"
    r"kubeconfig|connection[_-]?string|ocid)",
    re.IGNORECASE,
)
SENSITIVE_VALUE = re.compile(
    r"(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/-]+=*|"
    r"ocid1\.[a-z0-9.-]+)",
    re.IGNORECASE,
)

ACTIVE_RELEASE_KEYS = {
    "schema",
    "environment",
    "generation",
    "source_sha",
    "workflow_path",
    "run_id",
    "run_attempt",
    "infrastructure_run_id",
    "image_digests",
    "infrastructure_fingerprint_sha256",
    "validated_at",
    "state",
}
OPERATION_KEYS = {
    "schema",
    "environment",
    "generation",
    "operation_id",
    "repair_id",
    "workflow_path",
    "run_id",
    "run_attempt",
    "control_sha",
    "target_sha",
    "phase",
    "expected_transient_codes",
    "heartbeat_at",
    "expires_at",
    "state",
}
ACTIVITY_KEYS = {
    "classification",
    "workflow_path",
    "run_id",
    "run_attempt",
    "control_sha",
    "target_sha",
    "phase",
    "repair_id",
    "expected_transient_codes",
}
ANOMALY_KEYS = {
    "code",
    "service",
    "severity",
    "classification",
    "message",
    "evidence",
}
OBSERVATION_KEYS = {
    "schema",
    "environment",
    "observed_at",
    "monitor_run_id",
    "monitor_run_attempt",
    "source_sha",
    "status",
    "baseline_status",
    "active_release",
    "production_operation",
    "activity",
    "public",
    "deep",
    "anomalies",
}
INCIDENT_KEYS = {
    "schema",
    "environment",
    "issue_number",
    "anomaly_key",
    "fingerprint",
    "episode",
    "service",
    "code",
    "severity",
    "status",
    "failure_count",
    "healthy_count",
    "total_observations",
    "first_seen",
    "last_seen",
    "last_monitor_run_id",
    "last_observation_sha256",
    "active_release_sha",
    "generation",
    "repair_generation",
}
REPAIR_KEYS = {
    "schema",
    "environment",
    "incident_issue",
    "incident_fingerprint",
    "generation",
    "owner",
    "task_id",
    "base_branch",
    "base_sha",
    "agent_branch",
    "head_sha",
    "repair_pr",
    "merge_sha",
    "promotion_pr",
    "target_sha",
    "workflow_runs",
    "owned_paths",
    "phase",
    "attempts",
    "self_heal_attempted",
    "heartbeat_at",
    "expires_at",
    "terminal_reason",
}
PROMOTION_KEYS = {
    "schema",
    "environment",
    "repository",
    "promotion_pr",
    "base_sha",
    "target_sha",
    "repairs",
    "files",
    "created_at",
}


class ContractError(ValueError):
    """Raised when machine-managed monitoring data is malformed or unsafe."""


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def timestamp(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def parse_timestamp(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str):
        raise ContractError(f"{field} must be a timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ContractError(f"{field} must be a timestamp") from error
    if parsed.tzinfo is None:
        raise ContractError(f"{field} must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def exact_integer(value: Any, field: str, *, allow_zero: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ContractError(f"{field} must be an integer")
    minimum = 0 if allow_zero else 1
    if value < minimum:
        raise ContractError(f"{field} is outside its supported range")
    return value


def exact_keys(document: dict[str, Any], expected: set[str], name: str) -> None:
    if set(document) != expected:
        raise ContractError(
            f"{name} keys differ from the reviewed schema "
            f"missing={sorted(expected - set(document))} "
            f"extra={sorted(set(document) - expected)}"
        )


def canonical_json(document: Any) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def document_sha256(document: Any) -> str:
    return hashlib.sha256(canonical_json(document).encode("utf-8")).hexdigest()


def _bounded_text(value: Any, field: str, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ContractError(f"{field} must be non-empty and at most {maximum} characters")
    if any(ord(character) < 32 and character not in "\n\t" for character in value):
        raise ContractError(f"{field} contains a control character")
    if SENSITIVE_VALUE.search(value):
        raise ContractError(f"{field} contains forbidden sensitive data")
    for token in re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", value):
        try:
            address = ipaddress.ip_address(token)
        except ValueError:
            continue
        if address.is_private or address.is_loopback or address.is_link_local:
            raise ContractError(f"{field} contains a private address")
    return value


def validate_sanitized(value: Any, field: str = "evidence", *, depth: int = 0) -> None:
    if depth > 6:
        raise ContractError(f"{field} exceeds the maximum nesting depth")
    if value is None or isinstance(value, (bool, int, float)):
        return
    if isinstance(value, str):
        if len(value) > 1000:
            raise ContractError(f"{field} exceeds 1000 characters")
        if any(ord(character) < 32 and character not in "\n\t" for character in value):
            raise ContractError(f"{field} contains a control character")
        if SENSITIVE_VALUE.search(value):
            raise ContractError(f"{field} contains forbidden sensitive data")
        for token in re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", value):
            try:
                address = ipaddress.ip_address(token)
            except ValueError:
                continue
            if address.is_private or address.is_loopback or address.is_link_local:
                raise ContractError(f"{field} contains a private address")
        return
    if isinstance(value, list):
        if len(value) > 100:
            raise ContractError(f"{field} has too many entries")
        for index, child in enumerate(value):
            validate_sanitized(child, f"{field}[{index}]", depth=depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 100:
            raise ContractError(f"{field} has too many fields")
        for key, child in value.items():
            if not isinstance(key, str) or not key or len(key) > 100:
                raise ContractError(f"{field} has an invalid key")
            if SENSITIVE_KEY.search(key):
                raise ContractError(f"{field}.{key} is a forbidden sensitive field")
            validate_sanitized(child, f"{field}.{key}", depth=depth + 1)
        return
    raise ContractError(f"{field} contains an unsupported value")


def _validate_digest_map(value: Any, field: str) -> dict[str, str]:
    if not isinstance(value, dict) or not value:
        raise ContractError(f"{field} must be a non-empty object")
    result: dict[str, str] = {}
    for service, digest in value.items():
        if not isinstance(service, str) or not SERVICE.fullmatch(service):
            raise ContractError(f"{field} contains an invalid service")
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ContractError(f"{field}.{service} must be an immutable digest")
        result[service] = digest
    return result


def validate_active_release(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ContractError("active release must be an object")
    exact_keys(document, ACTIVE_RELEASE_KEYS, "active release")
    if document["schema"] != ACTIVE_RELEASE_SCHEMA:
        raise ContractError("active release schema is unsupported")
    if document["environment"] != ENVIRONMENT:
        raise ContractError("active release environment is unsupported")
    exact_integer(document["generation"], "active release generation")
    if not isinstance(document["source_sha"], str) or not SHA.fullmatch(document["source_sha"]):
        raise ContractError("active release source SHA is malformed")
    if not isinstance(document["workflow_path"], str) or not WORKFLOW_PATH.fullmatch(
        document["workflow_path"]
    ):
        raise ContractError("active release workflow path is malformed")
    exact_integer(document["run_id"], "active release run ID")
    if document["run_attempt"] != 1:
        raise ContractError("active release must come from a first-attempt run")
    exact_integer(
        document["infrastructure_run_id"],
        "active release infrastructure run ID",
    )
    image_digests = _validate_digest_map(
        document["image_digests"], "active release image digests"
    )
    if set(image_digests) != APPLICATION_SERVICES:
        raise ContractError("active release image evidence is incomplete")
    if not isinstance(document["infrastructure_fingerprint_sha256"], str) or not HASH.fullmatch(
        document["infrastructure_fingerprint_sha256"]
    ):
        raise ContractError("active release infrastructure fingerprint is malformed")
    parse_timestamp(document["validated_at"], "active release validated_at")
    if document["state"] != "active":
        raise ContractError("active release state must be active")
    return document


def validate_operation(document: Any, policy: dict[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ContractError("production operation must be an object")
    exact_keys(document, OPERATION_KEYS, "production operation")
    if document["schema"] != OPERATION_SCHEMA:
        raise ContractError("production operation schema is unsupported")
    if document["environment"] != ENVIRONMENT:
        raise ContractError("production operation environment is unsupported")
    exact_integer(document["generation"], "production operation generation")
    if not isinstance(document["operation_id"], str) or not IDENTIFIER.fullmatch(
        document["operation_id"]
    ):
        raise ContractError("production operation ID is malformed")
    repair_id = document["repair_id"]
    if repair_id and (not isinstance(repair_id, str) or not IDENTIFIER.fullmatch(repair_id)):
        raise ContractError("production operation repair ID is malformed")
    workflow_path = document["workflow_path"]
    if not isinstance(workflow_path, str) or not WORKFLOW_PATH.fullmatch(workflow_path):
        raise ContractError("production operation workflow path is malformed")
    exact_integer(document["run_id"], "production operation run ID")
    if document["run_attempt"] != 1:
        raise ContractError("production operation must come from a first-attempt run")
    for field in ("control_sha", "target_sha"):
        if not isinstance(document[field], str) or not SHA.fullmatch(document[field]):
            raise ContractError(f"production operation {field.replace('_', ' ')} is malformed")
    if not isinstance(document["phase"], str) or not IDENTIFIER.fullmatch(document["phase"]):
        raise ContractError("production operation phase is malformed")
    codes = document["expected_transient_codes"]
    if not isinstance(codes, list) or len(codes) > 20 or len(codes) != len(set(codes)):
        raise ContractError("production operation expected transient codes are invalid")
    if any(not isinstance(code, str) or not ANOMALY_CODE.fullmatch(code) for code in codes):
        raise ContractError("production operation contains a malformed transient code")
    heartbeat = parse_timestamp(document["heartbeat_at"], "production operation heartbeat_at")
    expires = parse_timestamp(document["expires_at"], "production operation expires_at")
    if expires <= heartbeat or expires - heartbeat > dt.timedelta(hours=4):
        raise ContractError("production operation lease is outside the bounded window")
    if document["state"] not in OPERATION_STATES:
        raise ContractError("production operation state is unsupported")
    if policy is not None:
        if document["state"] == "active":
            maintenance = policy["maintenance"].get(workflow_path)
            if maintenance is None or document["phase"] not in maintenance:
                raise ContractError("production operation workflow phase is not reviewed")
            if sorted(codes) != sorted(maintenance[document["phase"]]):
                raise ContractError("production operation transient codes differ from policy")
        elif codes:
            raise ContractError("terminal production operations cannot allow transients")
    return document


def validate_activity(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ContractError("activity must be an object")
    exact_keys(document, ACTIVITY_KEYS, "activity")
    if document["classification"] not in {
        "idle",
        "development",
        "repair",
        "queued-production",
        "mutating-production",
        "unknown",
    }:
        raise ContractError("activity classification is unsupported")
    for field in ("workflow_path", "control_sha", "target_sha", "phase", "repair_id"):
        if not isinstance(document[field], str):
            raise ContractError(f"activity {field} must be a string")
    exact_integer(document["run_id"], "activity run ID", allow_zero=True)
    exact_integer(document["run_attempt"], "activity run attempt", allow_zero=True)
    codes = document["expected_transient_codes"]
    if not isinstance(codes, list) or len(codes) != len(set(codes)):
        raise ContractError("activity expected transient codes are invalid")
    return document


def validate_anomaly(document: Any, policy: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ContractError("anomaly must be an object")
    exact_keys(document, ANOMALY_KEYS, "anomaly")
    code = document["code"]
    service = document["service"]
    if not isinstance(code, str) or not ANOMALY_CODE.fullmatch(code):
        raise ContractError("anomaly code is malformed")
    if code not in policy["anomalies"]:
        raise ContractError(f"anomaly code is not reviewed: {code}")
    if not isinstance(service, str) or service not in policy["services"]:
        raise ContractError("anomaly service is unsupported")
    if document["severity"] not in SEVERITIES:
        raise ContractError("anomaly severity is unsupported")
    configured = policy["anomalies"][code]
    if document["severity"] != configured["severity"]:
        raise ContractError("anomaly severity differs from policy")
    if document["classification"] not in ANOMALY_CLASSIFICATIONS:
        raise ContractError("anomaly classification is unsupported")
    _bounded_text(document["message"], "anomaly message")
    validate_sanitized(document["evidence"], "anomaly evidence")
    return document


def validate_observation(document: Any, policy: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ContractError("observation must be an object")
    exact_keys(document, OBSERVATION_KEYS, "observation")
    if document["schema"] != OBSERVATION_SCHEMA:
        raise ContractError("observation schema is unsupported")
    if document["environment"] != ENVIRONMENT:
        raise ContractError("observation environment is unsupported")
    parse_timestamp(document["observed_at"], "observation observed_at")
    exact_integer(document["monitor_run_id"], "monitor run ID")
    if document["monitor_run_attempt"] != 1:
        raise ContractError("observation must come from a first-attempt run")
    if not isinstance(document["source_sha"], str) or not SHA.fullmatch(document["source_sha"]):
        raise ContractError("observation source SHA is malformed")
    if document["status"] not in {"healthy", "anomalous", "maintenance", "unknown"}:
        raise ContractError("observation status is unsupported")
    if document["baseline_status"] not in {"ready", "warming", "unavailable"}:
        raise ContractError("observation baseline status is unsupported")
    if document["active_release"] is not None:
        validate_active_release(document["active_release"])
    if document["production_operation"] is not None:
        validate_operation(document["production_operation"], policy)
    validate_activity(document["activity"])
    validate_sanitized(document["public"], "public observation")
    validate_sanitized(document["deep"], "deep observation")
    anomalies = document["anomalies"]
    if not isinstance(anomalies, list) or len(anomalies) > policy["observation"][
        "maximum_evidence_items"
    ]:
        raise ContractError("observation anomalies are invalid")
    seen: set[tuple[str, str]] = set()
    for anomaly in anomalies:
        validate_anomaly(anomaly, policy)
        key = (anomaly["service"], anomaly["code"])
        if key in seen:
            raise ContractError("observation contains a duplicate anomaly")
        seen.add(key)
    classifications = {anomaly["classification"] for anomaly in anomalies}
    expected_status = (
        "anomalous"
        if "anomaly" in classifications
        else "unknown"
        if "unknown" in classifications
        else "maintenance"
        if "maintenance" in classifications
        else "healthy"
    )
    if document["status"] != expected_status:
        raise ContractError("observation status does not match its anomalies")
    return document


def anomaly_key(service: str, code: str) -> str:
    if not SERVICE.fullmatch(service) or not ANOMALY_CODE.fullmatch(code):
        raise ContractError("cannot fingerprint a malformed anomaly")
    return hashlib.sha256(f"{ENVIRONMENT}\0{service}\0{code}".encode("utf-8")).hexdigest()


def incident_fingerprint(key: str, episode: int) -> str:
    if not HASH.fullmatch(key):
        raise ContractError("incident anomaly key is malformed")
    exact_integer(episode, "incident episode")
    return hashlib.sha256(f"{key}\0{episode}".encode("utf-8")).hexdigest()


def validate_incident(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ContractError("incident must be an object")
    exact_keys(document, INCIDENT_KEYS, "incident")
    if document["schema"] != INCIDENT_SCHEMA or document["environment"] != ENVIRONMENT:
        raise ContractError("incident identity is unsupported")
    exact_integer(document["issue_number"], "incident issue number", allow_zero=True)
    if not isinstance(document["anomaly_key"], str) or not HASH.fullmatch(document["anomaly_key"]):
        raise ContractError("incident anomaly key is malformed")
    if not isinstance(document["fingerprint"], str) or not HASH.fullmatch(document["fingerprint"]):
        raise ContractError("incident fingerprint is malformed")
    episode = exact_integer(document["episode"], "incident episode")
    if document["fingerprint"] != incident_fingerprint(document["anomaly_key"], episode):
        raise ContractError("incident fingerprint does not match its episode")
    if not isinstance(document["service"], str) or not SERVICE.fullmatch(document["service"]):
        raise ContractError("incident service is malformed")
    if not isinstance(document["code"], str) or not ANOMALY_CODE.fullmatch(document["code"]):
        raise ContractError("incident code is malformed")
    if document["anomaly_key"] != anomaly_key(document["service"], document["code"]):
        raise ContractError("incident anomaly key does not match service and code")
    if document["severity"] not in SEVERITIES or document["status"] not in INCIDENT_STATUSES:
        raise ContractError("incident severity or status is unsupported")
    for field in (
        "failure_count",
        "healthy_count",
        "total_observations",
        "last_monitor_run_id",
        "generation",
        "repair_generation",
    ):
        exact_integer(
            document[field],
            f"incident {field}",
            allow_zero=field in {
                "failure_count",
                "healthy_count",
                "repair_generation",
            },
        )
    first_seen = parse_timestamp(document["first_seen"], "incident first_seen")
    last_seen = parse_timestamp(document["last_seen"], "incident last_seen")
    if last_seen < first_seen:
        raise ContractError("incident last_seen precedes first_seen")
    if not isinstance(document["last_observation_sha256"], str) or not HASH.fullmatch(
        document["last_observation_sha256"]
    ):
        raise ContractError("incident observation hash is malformed")
    if document["active_release_sha"] and (
        not isinstance(document["active_release_sha"], str)
        or not SHA.fullmatch(document["active_release_sha"])
    ):
        raise ContractError("incident active release SHA is malformed")
    return document


def validate_repair(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ContractError("repair must be an object")
    exact_keys(document, REPAIR_KEYS, "repair")
    if document["schema"] != REPAIR_SCHEMA or document["environment"] != ENVIRONMENT:
        raise ContractError("repair identity is unsupported")
    exact_integer(document["incident_issue"], "repair incident issue")
    if not isinstance(document["incident_fingerprint"], str) or not HASH.fullmatch(
        document["incident_fingerprint"]
    ):
        raise ContractError("repair incident fingerprint is malformed")
    exact_integer(document["generation"], "repair generation")
    if not isinstance(document["owner"], str) or not IDENTIFIER.fullmatch(document["owner"]):
        raise ContractError("repair owner is malformed")
    if not isinstance(document["task_id"], str) or len(document["task_id"]) > 160:
        raise ContractError("repair task ID is malformed")
    if document["base_branch"] != "dev":
        raise ContractError("repair base branch must be dev")
    for field in ("base_sha", "head_sha", "merge_sha", "target_sha"):
        value = document[field]
        if value and (not isinstance(value, str) or not SHA.fullmatch(value)):
            raise ContractError(f"repair {field} is malformed")
    branch = document["agent_branch"]
    if branch and (not isinstance(branch, str) or not IDENTIFIER.fullmatch(branch)):
        raise ContractError("repair agent branch is malformed")
    for field in ("repair_pr", "promotion_pr"):
        exact_integer(document[field], f"repair {field}", allow_zero=True)
    runs = document["workflow_runs"]
    if not isinstance(runs, dict) or len(runs) > 20:
        raise ContractError("repair workflow runs are malformed")
    for key, value in runs.items():
        if not IDENTIFIER.fullmatch(str(key)):
            raise ContractError("repair workflow run key is malformed")
        exact_integer(value, f"repair workflow run {key}")
    paths = document["owned_paths"]
    if (
        not isinstance(paths, list)
        or not paths
        or len(paths) > 20
        or len(paths) != len(set(paths))
        or any(not isinstance(path, str) or not path or len(path) > 200 for path in paths)
    ):
        raise ContractError("repair owned paths are malformed")
    if document["phase"] not in REPAIR_PHASES:
        raise ContractError("repair phase is unsupported")
    exact_integer(document["attempts"], "repair attempts", allow_zero=True)
    if not isinstance(document["self_heal_attempted"], bool):
        raise ContractError("repair self-heal flag must be boolean")
    heartbeat = parse_timestamp(document["heartbeat_at"], "repair heartbeat_at")
    expires = parse_timestamp(document["expires_at"], "repair expires_at")
    if expires <= heartbeat or expires - heartbeat > dt.timedelta(hours=24):
        raise ContractError("repair lease is outside the bounded window")
    if not isinstance(document["terminal_reason"], str) or len(document["terminal_reason"]) > 500:
        raise ContractError("repair terminal reason is malformed")
    return document


def validate_promotion(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ContractError("promotion must be an object")
    exact_keys(document, PROMOTION_KEYS, "promotion")
    if (
        document["schema"] != PROMOTION_SCHEMA
        or document["environment"] != ENVIRONMENT
        or document["repository"] != REPOSITORY
    ):
        raise ContractError("promotion identity is unsupported")
    exact_integer(document["promotion_pr"], "promotion pull request", allow_zero=True)
    for field in ("base_sha", "target_sha"):
        if not isinstance(document[field], str) or not SHA.fullmatch(document[field]):
            raise ContractError(f"promotion {field} is malformed")
    repairs = document["repairs"]
    if not isinstance(repairs, list) or not repairs or len(repairs) > 20:
        raise ContractError("promotion repair cohort is malformed")
    identities = []
    for repair in repairs:
        if not isinstance(repair, dict):
            raise ContractError("promotion repair identity is malformed")
        exact_keys(
            repair,
            {
                "incident_issue",
                "generation",
                "repair_pr",
                "merge_sha",
                "owned_paths",
            },
            "promotion repair",
        )
        identity = (
            exact_integer(repair["incident_issue"], "promotion incident issue"),
            exact_integer(repair["generation"], "promotion repair generation"),
        )
        identities.append(identity)
        exact_integer(repair["repair_pr"], "promotion repair pull request")
        if not isinstance(repair["merge_sha"], str) or not SHA.fullmatch(
            repair["merge_sha"]
        ):
            raise ContractError("promotion repair merge SHA is malformed")
        paths = repair["owned_paths"]
        if (
            not isinstance(paths, list)
            or not paths
            or len(paths) > 20
            or len(paths) != len(set(paths))
            or any(
                not isinstance(path, str) or not path or len(path) > 200
                for path in paths
            )
        ):
            raise ContractError("promotion repair owned paths are malformed")
    if identities != sorted(identities) or len(identities) != len(set(identities)):
        raise ContractError("promotion repair cohort is unordered or duplicated")
    files = document["files"]
    if (
        not isinstance(files, list)
        or not files
        or len(files) > 300
        or files != sorted(set(files))
        or any(
            not isinstance(path, str)
            or not path
            or len(path) > 300
            or path.startswith("/")
            or ".." in path.split("/")
            or any(character in path for character in "\r\n\0")
            for path in files
        )
    ):
        raise ContractError("promotion files are malformed")
    parse_timestamp(document["created_at"], "promotion created_at")
    return document


def _positive_policy_integer(document: dict[str, Any], key: str) -> int:
    return exact_integer(document.get(key), f"policy {key}")


def validate_policy(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ContractError("policy must be an object")
    exact_keys(
        document,
        {
            "schema",
            "environment",
            "observation",
            "repair",
            "services",
            "anomalies",
            "maintenance",
            "forbidden_repair_paths",
            "runbooks",
        },
        "policy",
    )
    if document["schema"] != POLICY_SCHEMA or document["environment"] != ENVIRONMENT:
        raise ContractError("policy identity is unsupported")
    observation = document["observation"]
    if not isinstance(observation, dict):
        raise ContractError("policy observation section is missing")
    for key in (
        "confirm_failures",
        "resolve_healthy",
        "maximum_gap_seconds",
        "maximum_artifact_bytes",
        "maximum_evidence_items",
        "baseline_window",
        "baseline_minimum_samples",
    ):
        _positive_policy_integer(observation, key)
    if observation["baseline_minimum_samples"] > observation["baseline_window"]:
        raise ContractError("baseline minimum exceeds its window")
    repair = document["repair"]
    if not isinstance(repair, dict) or repair.get("base_branch") != "dev":
        raise ContractError("policy repair section is invalid")
    for key in ("claim_ttl_seconds", "maximum_attempts", "self_heal_cooldown_seconds"):
        exact_integer(repair.get(key), f"policy repair {key}")
    services = document["services"]
    if not isinstance(services, dict) or "platform" not in services:
        raise ContractError("policy services are incomplete")
    for name, config in services.items():
        if not SERVICE.fullmatch(name) or not isinstance(config, dict):
            raise ContractError("policy service is malformed")
        if set(config) != {"agent", "paths", "restart_safe"}:
            raise ContractError(f"policy service {name} has unexpected fields")
        if not isinstance(config["agent"], str) or not config["agent"]:
            raise ContractError(f"policy service {name} has no agent")
        if not isinstance(config["paths"], list) or len(config["paths"]) != len(
            set(config["paths"])
        ):
            raise ContractError(f"policy service {name} paths are invalid")
        if not isinstance(config["restart_safe"], bool):
            raise ContractError(f"policy service {name} restart safety is invalid")
    anomalies = document["anomalies"]
    if not isinstance(anomalies, dict) or not anomalies:
        raise ContractError("policy anomalies are missing")
    for code, config in anomalies.items():
        if not ANOMALY_CODE.fullmatch(code) or not isinstance(config, dict):
            raise ContractError("policy anomaly is malformed")
        if set(config) != {"severity", "service", "automation"}:
            raise ContractError(f"policy anomaly {code} has unexpected fields")
        if config["severity"] not in SEVERITIES or config["service"] not in services:
            raise ContractError(f"policy anomaly {code} routing is invalid")
        if config["automation"] not in {"code-repair", "self-heal", "unsupported-runbook"}:
            raise ContractError(f"policy anomaly {code} automation is invalid")
    maintenance = document["maintenance"]
    if not isinstance(maintenance, dict):
        raise ContractError("policy maintenance section is invalid")
    for workflow, phases in maintenance.items():
        if not WORKFLOW_PATH.fullmatch(workflow) or not isinstance(phases, dict):
            raise ContractError("policy maintenance workflow is malformed")
        for phase, codes in phases.items():
            if not IDENTIFIER.fullmatch(phase) or not isinstance(codes, list):
                raise ContractError("policy maintenance phase is malformed")
            if len(codes) != len(set(codes)) or any(code not in anomalies for code in codes):
                raise ContractError("policy maintenance codes are invalid")
    forbidden = document["forbidden_repair_paths"]
    if not isinstance(forbidden, list) or not forbidden or len(forbidden) != len(set(forbidden)):
        raise ContractError("policy forbidden paths are invalid")
    runbooks = document["runbooks"]
    if not isinstance(runbooks, dict):
        raise ContractError("policy runbooks are invalid")
    for name, config in runbooks.items():
        if not IDENTIFIER.fullmatch(name) or not isinstance(config, dict):
            raise ContractError("policy runbook is malformed")
        if set(config) != {"enabled", "workflow"} or not isinstance(config["enabled"], bool):
            raise ContractError(f"policy runbook {name} is invalid")
        workflow = config["workflow"]
        if workflow is not None and (
            not isinstance(workflow, str) or not WORKFLOW_PATH.fullmatch(workflow)
        ):
            raise ContractError(f"policy runbook {name} workflow is invalid")
        if config["enabled"] and workflow is None:
            raise ContractError(f"enabled policy runbook {name} has no workflow")
    return document


def load_policy(path: str | Path) -> dict[str, Any]:
    candidate = Path(path)
    try:
        document = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ContractError(f"unable to load monitor policy: {candidate}") from error
    return validate_policy(document)


def require_unique_strings(values: Iterable[str], field: str) -> list[str]:
    result = list(values)
    if len(result) != len(set(result)):
        raise ContractError(f"{field} contains duplicates")
    return result
