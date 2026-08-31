#!/usr/bin/env python3
"""Incident and repair state transitions for the production monitor."""

from __future__ import annotations

import datetime as dt
from copy import deepcopy
from typing import Any

from contracts import (
    ENVIRONMENT,
    INCIDENT_SCHEMA,
    REPAIR_SCHEMA,
    ContractError,
    anomaly_key,
    incident_fingerprint,
    parse_timestamp,
    timestamp,
    validate_incident,
    validate_repair,
)


def _active_release_sha(observation: dict[str, Any]) -> str:
    release = observation.get("active_release")
    return release["source_sha"] if isinstance(release, dict) else ""


def new_incident(
    anomaly: dict[str, Any],
    observation: dict[str, Any],
    observation_sha256: str,
    *,
    episode: int = 1,
) -> dict[str, Any]:
    key = anomaly_key(anomaly["service"], anomaly["code"])
    document = {
        "schema": INCIDENT_SCHEMA,
        "environment": ENVIRONMENT,
        "issue_number": 0,
        "anomaly_key": key,
        "fingerprint": incident_fingerprint(key, episode),
        "episode": episode,
        "service": anomaly["service"],
        "code": anomaly["code"],
        "severity": anomaly["severity"],
        "status": "observing",
        "failure_count": 1,
        "healthy_count": 0,
        "total_observations": 1,
        "first_seen": observation["observed_at"],
        "last_seen": observation["observed_at"],
        "last_monitor_run_id": observation["monitor_run_id"],
        "last_observation_sha256": observation_sha256,
        "active_release_sha": _active_release_sha(observation),
        "generation": 1,
        "repair_generation": 0,
    }
    return validate_incident(document)


def apply_failure(
    incident: dict[str, Any],
    anomaly: dict[str, Any],
    observation: dict[str, Any],
    observation_sha256: str,
    policy: dict[str, Any],
) -> dict[str, Any]:
    current = validate_incident(deepcopy(incident))
    if current["status"] == "resolved":
        return new_incident(
            anomaly,
            observation,
            observation_sha256,
            episode=current["episode"] + 1,
        )
    if (
        current["service"] != anomaly["service"]
        or current["code"] != anomaly["code"]
        or current["severity"] != anomaly["severity"]
    ):
        raise ContractError("incident failure does not match its anomaly")
    if observation["monitor_run_id"] <= current["last_monitor_run_id"]:
        raise ContractError("incident observation is replayed or out of order")
    observed_at = parse_timestamp(observation["observed_at"], "observation observed_at")
    last_seen = parse_timestamp(current["last_seen"], "incident last_seen")
    if observed_at <= last_seen:
        raise ContractError("incident timestamp is replayed or out of order")
    maximum_gap = dt.timedelta(seconds=policy["observation"]["maximum_gap_seconds"])
    failures = current["failure_count"] + 1 if observed_at - last_seen <= maximum_gap else 1
    updated = dict(current)
    updated.update(
        {
            "failure_count": failures,
            "healthy_count": 0,
            "total_observations": current["total_observations"] + 1,
            "last_seen": observation["observed_at"],
            "last_monitor_run_id": observation["monitor_run_id"],
            "last_observation_sha256": observation_sha256,
            "active_release_sha": _active_release_sha(observation),
            "generation": current["generation"] + 1,
        }
    )
    if failures >= policy["observation"]["confirm_failures"] and current["status"] == "observing":
        updated["status"] = "confirmed"
    return validate_incident(updated)


def apply_healthy(
    incident: dict[str, Any],
    observation: dict[str, Any],
    observation_sha256: str,
    policy: dict[str, Any],
) -> dict[str, Any]:
    current = validate_incident(deepcopy(incident))
    if current["status"] == "resolved":
        return current
    if observation["status"] not in {"healthy", "anomalous"} or any(
        anomaly.get("classification") == "unknown"
        for anomaly in observation.get("anomalies", [])
        if isinstance(anomaly, dict)
    ):
        raise ContractError("unknown or maintenance observations cannot heal incidents")
    if observation["monitor_run_id"] <= current["last_monitor_run_id"]:
        raise ContractError("incident observation is replayed or out of order")
    observed_at = parse_timestamp(observation["observed_at"], "observation observed_at")
    last_seen = parse_timestamp(current["last_seen"], "incident last_seen")
    if observed_at <= last_seen:
        raise ContractError("incident timestamp is replayed or out of order")
    maximum_gap = dt.timedelta(seconds=policy["observation"]["maximum_gap_seconds"])
    healthy = current["healthy_count"] + 1 if observed_at - last_seen <= maximum_gap else 1
    updated = dict(current)
    updated.update(
        {
            "failure_count": 0,
            "healthy_count": healthy,
            "total_observations": current["total_observations"] + 1,
            "last_seen": observation["observed_at"],
            "last_monitor_run_id": observation["monitor_run_id"],
            "last_observation_sha256": observation_sha256,
            "active_release_sha": _active_release_sha(observation),
            "generation": current["generation"] + 1,
        }
    )
    if healthy >= policy["observation"]["resolve_healthy"]:
        updated["status"] = "resolved"
    return validate_incident(updated)


def new_repair(
    incident: dict[str, Any],
    *,
    owner: str,
    base_sha: str,
    owned_paths: list[str],
    now: dt.datetime,
    ttl_seconds: int,
) -> dict[str, Any]:
    current = validate_incident(deepcopy(incident))
    if current["status"] not in {"confirmed", "repairing"}:
        raise ContractError("only an active confirmed incident may acquire repair ownership")
    document = {
        "schema": REPAIR_SCHEMA,
        "environment": ENVIRONMENT,
        "incident_issue": current["issue_number"],
        "incident_fingerprint": current["fingerprint"],
        "generation": current["repair_generation"] + 1,
        "owner": owner,
        "task_id": "",
        "base_branch": "dev",
        "base_sha": base_sha,
        "agent_branch": "",
        "head_sha": "",
        "repair_pr": 0,
        "merge_sha": "",
        "promotion_pr": 0,
        "target_sha": "",
        "workflow_runs": {},
        "owned_paths": owned_paths,
        "phase": "claimed",
        "attempts": 0,
        "self_heal_attempted": False,
        "heartbeat_at": timestamp(now),
        "expires_at": timestamp(now + dt.timedelta(seconds=ttl_seconds)),
        "terminal_reason": "",
    }
    return validate_repair(document)


def transition_repair(
    repair: dict[str, Any],
    phase: str,
    *,
    now: dt.datetime,
    ttl_seconds: int,
    updates: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current = validate_repair(deepcopy(repair))
    allowed = {
        "claimed": {"self-healing", "coding", "unsupported-runbook", "failed"},
        "self-healing": {"self-healing", "validating", "failed"},
        "coding": {"review", "failed"},
        "review": {"merging", "failed"},
        "merging": {"promoting", "failed"},
        "promoting": {"building", "failed"},
        "building": {"deploying", "failed"},
        "deploying": {"validating", "failed"},
        "validating": {"resolved", "failed"},
        "unsupported-runbook": {"failed"},
        "failed": set(),
        "resolved": set(),
    }
    if phase not in allowed[current["phase"]]:
        raise ContractError(
            f"repair transition {current['phase']} -> {phase} is not allowed"
        )
    updated = dict(current)
    if updates:
        unknown = set(updates) - set(updated)
        if unknown:
            raise ContractError(f"repair update contains unknown fields: {sorted(unknown)}")
        updated.update(updates)
    updated["phase"] = phase
    updated["heartbeat_at"] = timestamp(now)
    updated["expires_at"] = timestamp(now + dt.timedelta(seconds=ttl_seconds))
    if phase in {"failed", "resolved", "unsupported-runbook"}:
        updated["expires_at"] = timestamp(now + dt.timedelta(seconds=300))
    return validate_repair(updated)
