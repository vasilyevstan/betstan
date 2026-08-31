#!/usr/bin/env python3
"""Collect and classify bounded OCI production observations."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from contracts import (
    APPLICATION_SERVICES,
    ENVIRONMENT,
    OBSERVATION_SCHEMA,
    ContractError,
    canonical_json,
    document_sha256,
    load_policy,
    parse_timestamp,
    timestamp,
    validate_activity,
    validate_active_release,
    validate_observation,
    validate_operation,
    validate_sanitized,
)


MAX_HTTP_BYTES = 65536
STRUCTURAL_CODES = {
    "active-release-missing",
    "active-release-mismatch",
    "production-operation-stale",
    "production-operation-mismatch",
    "image-digest-drift",
    "monitor-unknown",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def _read_bounded(response, maximum: int = MAX_HTTP_BYTES) -> bytes:
    payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise ContractError("HTTP response exceeded the bounded payload size")
    return payload


def _probe(url: str, *, timeout: int = 15, follow_redirects: bool = True) -> dict[str, Any]:
    opener = (
        urllib.request.build_opener()
        if follow_redirects
        else urllib.request.build_opener(NoRedirect)
    )
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json,text/html;q=0.8",
            "User-Agent": "betstan-production-monitor/1",
        },
        method="GET",
    )
    started = time.monotonic()
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, urllib.error.URLError, TimeoutError) as error:
        return {
            "status": 0,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "content_type": "",
            "location": "",
            "body_kind": "none",
            "error": type(error).__name__,
        }
    elapsed = round((time.monotonic() - started) * 1000)
    try:
        payload = _read_bounded(response)
    except ContractError:
        return {
            "status": int(response.status),
            "latency_ms": elapsed,
            "content_type": "",
            "location": "",
            "body_kind": "none",
            "body_sha256": __import__("hashlib").sha256(b"").hexdigest(),
            "body_length": 0,
            "error": "response-too-large",
        }
    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
    body_kind = "other"
    if content_type == "application/json":
        try:
            json.loads(payload)
            body_kind = "json"
        except json.JSONDecodeError:
            body_kind = "invalid-json"
    elif content_type == "text/html":
        body_kind = "html"
    return {
        "status": int(response.status),
        "latency_ms": elapsed,
        "content_type": content_type,
        "location": response.headers.get("Location", ""),
        "body_kind": body_kind,
        "body_sha256": __import__("hashlib").sha256(payload).hexdigest(),
        "body_length": len(payload),
        "error": "",
    }


def collect_public(public_url: str, redirect_url: str, diagnostic_url: str) -> dict[str, Any]:
    urls = {
        "canonical-home": (f"{public_url.rstrip('/')}/", True),
        "auth-currentuser": (
            f"{public_url.rstrip('/')}/api/auth/currentuser",
            True,
        ),
        "event-api": (f"{public_url.rstrip('/')}/api/event", True),
        "slip-api": (f"{public_url.rstrip('/')}/api/slip", True),
        "bet-api": (f"{public_url.rstrip('/')}/api/bet", True),
        "bet-stats-api": (f"{public_url.rstrip('/')}/api/bet/stats", True),
        "backoffice-boundary": (
            f"{public_url.rstrip('/')}/api/backoffice",
            True,
        ),
        "www-redirect": (f"{redirect_url.rstrip('/')}/", False),
        "diagnostic-auth": (
            f"{diagnostic_url.rstrip('/')}/api/auth/currentuser",
            True,
        ),
    }
    checks: dict[str, dict[str, Any]] = {}
    for name, (url, redirects) in urls.items():
        checks[name] = _probe(url, follow_redirects=redirects)

    expected_redirect = f"{public_url.rstrip('/')}/"
    checks["canonical-home"]["valid"] = (
        checks["canonical-home"]["status"] == 200
        and checks["canonical-home"]["body_kind"] == "html"
    )
    for name in (
        "auth-currentuser",
        "event-api",
        "slip-api",
        "bet-api",
        "bet-stats-api",
        "diagnostic-auth",
    ):
        checks[name]["valid"] = (
            checks[name]["status"] == 200 and checks[name]["body_kind"] == "json"
        )
    checks["backoffice-boundary"]["valid"] = (
        checks["backoffice-boundary"]["status"] == 401
        and checks["backoffice-boundary"]["body_kind"] == "json"
    )
    checks["www-redirect"]["valid"] = (
        checks["www-redirect"]["status"] in {301, 302, 307, 308}
        and checks["www-redirect"]["location"] == expected_redirect
    )
    validate_sanitized(checks, "public checks")
    return {"schema": "betstan.public-health.v1", "checks": checks}


def _anomaly(
    policy: dict[str, Any],
    code: str,
    *,
    service: str | None = None,
    classification: str = "anomaly",
    message: str,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    configured = policy["anomalies"][code]
    return {
        "code": code,
        "service": service or configured["service"],
        "severity": configured["severity"],
        "classification": classification,
        "message": message,
        "evidence": evidence,
    }


def _service_from_workload(name: str) -> str:
    if name.startswith("gaming-") and name.endswith("-depl"):
        candidate = name[len("gaming-") : -len("-depl")]
        return candidate if candidate else "platform"
    return "platform"


def _load_deep(path: Path) -> tuple[dict[str, Any] | None, str]:
    if not path.is_file():
        return None, "missing"
    if path.stat().st_size > MAX_HTTP_BYTES * 4:
        return None, "oversized"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        validate_sanitized(document, "deep response")
    except (OSError, json.JSONDecodeError, ContractError):
        return None, "malformed"
    if not isinstance(document, dict) or document.get("schema") != "betstan.deep-health.v1":
        return None, "unsupported-schema"
    return document, ""


def _load_activity(path: Path) -> dict[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ContractError("production activity artifact is unavailable") from error
    return validate_activity(document)


def _classify_public(public: dict[str, Any], policy: dict[str, Any]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    checks = public.get("checks")
    if not isinstance(checks, dict):
        return [
            _anomaly(
                policy,
                "monitor-unknown",
                classification="unknown",
                message="public observation is malformed",
                evidence={"component": "public"},
            )
        ]
    home = checks.get("canonical-home", {})
    if home.get("valid") is not True:
        findings.append(
            _anomaly(
                policy,
                "public-home-failed",
                message="canonical homepage failed its bounded HTTPS probe",
                evidence={
                    "check": "canonical-home",
                    "status": int(home.get("status", 0)),
                    "error": str(home.get("error", "unknown"))[:80] or "none",
                },
            )
        )
    api_names = (
        "auth-currentuser",
        "event-api",
        "slip-api",
        "bet-api",
        "bet-stats-api",
        "diagnostic-auth",
    )
    failed_api = [
        name
        for name in api_names
        if not isinstance(checks.get(name), dict) or checks[name].get("valid") is not True
    ]
    if failed_api:
        findings.append(
            _anomaly(
                policy,
                "public-api-failed",
                message="one or more public API probes failed",
                evidence={"checks": failed_api},
            )
        )
    boundary = checks.get("backoffice-boundary", {})
    if boundary.get("valid") is not True:
        findings.append(
            _anomaly(
                policy,
                "public-auth-boundary-failed",
                message="anonymous Backoffice access did not fail closed",
                evidence={
                    "check": "backoffice-boundary",
                    "status": int(boundary.get("status", 0)),
                },
            )
        )
    redirect = checks.get("www-redirect", {})
    if redirect.get("valid") is not True:
        findings.append(
            _anomaly(
                policy,
                "public-redirect-failed",
                message="www redirect did not target the canonical HTTPS origin",
                evidence={
                    "check": "www-redirect",
                    "status": int(redirect.get("status", 0)),
                },
            )
        )
    return findings


def _classify_deep(
    deep: dict[str, Any] | None,
    deep_error: str,
    policy: dict[str, Any],
    now: dt.datetime,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None, dict[str, Any] | None]:
    if deep is None:
        return (
            [
                _anomaly(
                    policy,
                    "exporter-unavailable",
                    classification="unknown",
                    message="the authenticated deep-health exporter did not return trusted data",
                    evidence={"reason": deep_error},
                )
            ],
            None,
            None,
        )
    findings: list[dict[str, Any]] = []
    if deep.get("status") != "ok":
        errors = deep.get("errors")
        findings.append(
            _anomaly(
                policy,
                "exporter-unavailable",
                classification="unknown",
                message="the deep-health exporter returned an incomplete snapshot",
                evidence={
                    "reason": ",".join(str(item)[:60] for item in errors[:5])
                    if isinstance(errors, list)
                    else "partial",
                },
            )
        )
    active_release = deep.get("active_release")
    operation = deep.get("production_operation")
    try:
        if active_release is None:
            raise ContractError("missing")
        validate_active_release(active_release)
    except ContractError:
        active_release = None
        findings.append(
            _anomaly(
                policy,
                "active-release-missing",
                message="the serving release has no valid durable release record",
                evidence={"component": "active-release"},
            )
        )
    if operation is not None:
        try:
            validate_operation(operation, policy)
            if (
                operation["state"] == "active"
                and parse_timestamp(operation["expires_at"], "operation expires_at") <= now
            ):
                findings.append(
                    _anomaly(
                        policy,
                        "production-operation-stale",
                        message="the active production operation lease expired",
                        evidence={
                            "workflow_path": operation["workflow_path"],
                            "run_id": operation["run_id"],
                            "phase": operation["phase"],
                        },
                    )
                )
        except ContractError:
            operation = None
            findings.append(
                _anomaly(
                    policy,
                    "production-operation-mismatch",
                    message="the production operation record is malformed or outside policy",
                    evidence={"component": "production-operation"},
                )
            )

    kubernetes = deep.get("kubernetes")
    if not isinstance(kubernetes, dict):
        findings.append(
            _anomaly(
                policy,
                "monitor-unknown",
                classification="unknown",
                message="deep health omitted Kubernetes state",
                evidence={"component": "kubernetes"},
            )
        )
        return findings, active_release, operation

    node = kubernetes.get("node", {})
    pressure = [
        name
        for name in ("memory_pressure", "disk_pressure", "pid_pressure")
        if node.get(name) is True
    ]
    if (
        node.get("ready") is not True
        or node.get("count") != 1
        or node.get("architecture") != "arm64"
        or pressure
    ):
        findings.append(
            _anomaly(
                policy,
                "node-pressure",
                message="the production node is not ready or reports pressure",
                evidence={
                    "ready": bool(node.get("ready")),
                    "count": int(node.get("count", 0)),
                    "architecture": str(node.get("architecture", "unknown"))[:20],
                    "conditions": pressure,
                },
            )
        )
    for metric in ("cpu_percent", "memory_percent"):
        value = node.get(metric)
        if isinstance(value, (int, float)) and value > (90 if metric == "cpu_percent" else 70):
            findings.append(
                _anomaly(
                    policy,
                    "resource-outlier",
                    message="node resource use exceeded its static safety threshold",
                    evidence={"metric": metric, "value": round(float(value), 2)},
                )
            )

    workloads = kubernetes.get("workloads", [])
    if not isinstance(workloads, list):
        workloads = []
    for workload in workloads:
        if not isinstance(workload, dict):
            continue
        desired = int(workload.get("desired", 0))
        ready = int(workload.get("ready", 0))
        if desired < 1 or ready != desired:
            findings.append(
                _anomaly(
                    policy,
                    "workload-not-ready",
                    service=_service_from_workload(str(workload.get("name", ""))),
                    message="a production workload is not fully ready",
                    evidence={
                        "workload": str(workload.get("name", "unknown"))[:100],
                        "desired": desired,
                        "ready": ready,
                    },
                )
            )
    workload_names = {
        str(workload.get("name", ""))
        for workload in workloads
        if isinstance(workload, dict)
    }
    expected_workloads = {
        *(f"gaming-{service}-depl" for service in APPLICATION_SERVICES),
        "gaming-auth-mongo-depl",
        "gaming-rabbitmq-depl",
        "betstan-monitor-exporter",
        "betstan-monitor-repair",
    }
    for name in sorted(expected_workloads - workload_names):
        findings.append(
            _anomaly(
                policy,
                "workload-not-ready",
                service=_service_from_workload(name),
                message="an expected production workload is missing",
                evidence={"workload": name, "desired": 0, "ready": 0},
            )
        )
    pods = kubernetes.get("pods", [])
    if not isinstance(pods, list):
        pods = []
    for pod in pods:
        if not isinstance(pod, dict):
            continue
        service = str(pod.get("service", "platform"))
        service = service if service in policy["services"] else "platform"
        reason = str(pod.get("reason", "")).lower()
        if any(value in reason for value in ("crashloopbackoff", "oomkilled", "evicted")):
            findings.append(
                _anomaly(
                    policy,
                    "pod-crash-loop",
                    service=service,
                    message="a production pod reports a crash, OOM, or eviction state",
                    evidence={
                        "pod": str(pod.get("name", "unknown"))[:100],
                        "reason": reason[:80] or "unknown",
                    },
                )
            )
        if int(pod.get("restart_delta", 0)) > 0:
            findings.append(
                _anomaly(
                    policy,
                    "pod-restart-delta",
                    service=service,
                    message="a production pod restarted since the prior trusted observation",
                    evidence={
                        "pod": str(pod.get("name", "unknown"))[:100],
                        "delta": int(pod["restart_delta"]),
                    },
                )
            )
        if pod.get("digest_match") is False:
            findings.append(
                _anomaly(
                    policy,
                    "image-digest-drift",
                    service=service,
                    message="a serving pod digest differs from the active release",
                    evidence={"pod": str(pod.get("name", "unknown"))[:100]},
                )
            )
    endpoints = kubernetes.get("endpoints", [])
    if not isinstance(endpoints, list):
        endpoints = []
    for endpoint in endpoints:
        if not isinstance(endpoint, dict) or endpoint.get("ready") is True:
            continue
        findings.append(
            _anomaly(
                policy,
                "service-endpoint-empty",
                service=str(endpoint.get("service", "platform"))
                if str(endpoint.get("service", "platform")) in policy["services"]
                else "platform",
                message="a production Service has no ready EndpointSlice address",
                evidence={"service": str(endpoint.get("name", "unknown"))[:100]},
            )
        )
    endpoint_names = {
        str(endpoint.get("name", ""))
        for endpoint in endpoints
        if isinstance(endpoint, dict)
    }
    expected_endpoints = {
        *(f"gaming-{service}-srv" for service in APPLICATION_SERVICES),
        "gaming-auth-mongo-srv",
        "gaming-shared-mongo-srv",
        "gaming-rabbitmq-srv",
    }
    for name in sorted(expected_endpoints - endpoint_names):
        findings.append(
            _anomaly(
                policy,
                "service-endpoint-empty",
                service=(
                    name.removeprefix("gaming-").removesuffix("-srv")
                    if name.removeprefix("gaming-").removesuffix("-srv")
                    in policy["services"]
                    else "platform"
                ),
                message="an expected production Service is missing",
                evidence={"service": name},
            )
        )
    mongo = deep.get("mongo", {})
    if not isinstance(mongo, dict) or mongo.get("ready") is not True:
        findings.append(
            _anomaly(
                policy,
                "mongo-unavailable",
                message="the read-only Mongo monitor did not report a healthy database",
                evidence={"sample_status": str(mongo.get("status", "missing"))[:80]},
            )
        )
    rabbit = deep.get("rabbitmq", {})
    if not isinstance(rabbit, dict) or rabbit.get("ready") is not True:
        findings.append(
            _anomaly(
                policy,
                "rabbitmq-unavailable",
                message="the RabbitMQ monitoring API did not report a healthy broker",
                evidence={"sample_status": str(rabbit.get("status", "missing"))[:80]},
            )
        )
    elif int(rabbit.get("backlog", 0)) > 0:
        findings.append(
            _anomaly(
                policy,
                "rabbitmq-backlog",
                message="RabbitMQ reports a non-zero ready or unacknowledged backlog",
                evidence={
                    "backlog": int(rabbit.get("backlog", 0)),
                    "queues": int(rabbit.get("queue_count", 0)),
                },
            )
        )
    certificates = kubernetes.get("certificates", [])
    if isinstance(certificates, list):
        for certificate in certificates:
            if not isinstance(certificate, dict):
                continue
            days = certificate.get("days_remaining")
            if certificate.get("ready") is not True or (
                isinstance(days, (int, float)) and days < 14
            ):
                findings.append(
                    _anomaly(
                        policy,
                        "certificate-expiring",
                        message="a production TLS certificate is not ready or expires soon",
                        evidence={
                            "certificate": str(certificate.get("name", "unknown"))[:100],
                            "days_remaining": int(days) if isinstance(days, (int, float)) else -1,
                        },
                    )
                )
    return findings, active_release, operation


def _apply_restart_deltas(
    deep: dict[str, Any] | None,
    baseline_paths: list[Path],
    policy: dict[str, Any],
) -> None:
    if not isinstance(deep, dict):
        return
    pods = deep.get("kubernetes", {}).get("pods")
    if not isinstance(pods, list):
        return
    previous: dict[str, int] = {}
    for path in reversed(baseline_paths):
        try:
            observation = json.loads(path.read_text(encoding="utf-8"))
            validate_observation(observation, policy)
        except (OSError, json.JSONDecodeError, ContractError):
            continue
        prior_pods = observation.get("deep", {}).get("kubernetes", {}).get("pods")
        if not isinstance(prior_pods, list):
            continue
        previous = {
            str(pod.get("name")): int(pod["restart_count"])
            for pod in prior_pods
            if isinstance(pod, dict)
            and isinstance(pod.get("name"), str)
            and isinstance(pod.get("restart_count"), int)
        }
        break
    for pod in pods:
        if not isinstance(pod, dict) or not isinstance(pod.get("restart_count"), int):
            continue
        prior = previous.get(str(pod.get("name")))
        pod["restart_delta"] = (
            max(0, int(pod["restart_count"]) - prior) if prior is not None else 0
        )


def _operation_matches_activity(
    operation: dict[str, Any],
    activity: dict[str, Any],
) -> bool:
    return (
        operation["state"] == "active"
        and activity["classification"] == "mutating-production"
        and operation["workflow_path"] == activity["workflow_path"]
        and operation["run_id"] == activity["run_id"]
        and operation["run_attempt"] == activity["run_attempt"]
        and operation["control_sha"] == activity["control_sha"]
        and operation["target_sha"] == activity["target_sha"]
        and operation["phase"] == activity["phase"]
        and operation["repair_id"] == activity["repair_id"]
        and sorted(operation["expected_transient_codes"])
        == sorted(activity["expected_transient_codes"])
    )


def _apply_maintenance(
    anomalies: list[dict[str, Any]],
    activity: dict[str, Any],
    operation: dict[str, Any] | None,
    observed_at: dt.datetime,
) -> list[dict[str, Any]]:
    if (
        operation is None
        or not _operation_matches_activity(operation, activity)
        or parse_timestamp(operation["expires_at"], "operation expires_at")
        <= observed_at
    ):
        return anomalies
    allowed = set(operation["expected_transient_codes"])
    result = []
    for anomaly in anomalies:
        item = dict(anomaly)
        if item["code"] in allowed and item["code"] not in STRUCTURAL_CODES:
            item["classification"] = "maintenance"
        result.append(item)
    return result


def _baseline_status(
    public: dict[str, Any],
    baseline_paths: list[Path],
    policy: dict[str, Any],
) -> tuple[str, list[dict[str, Any]]]:
    samples: dict[str, list[float]] = {}
    for path in baseline_paths[-policy["observation"]["baseline_window"] :]:
        try:
            prior = json.loads(path.read_text(encoding="utf-8"))
            validate_observation(prior, policy)
        except (OSError, json.JSONDecodeError, ContractError):
            continue
        if prior["status"] not in {"healthy", "maintenance"}:
            continue
        for name, check in prior["public"].get("checks", {}).items():
            latency = check.get("latency_ms")
            if isinstance(latency, (int, float)) and check.get("valid") is True:
                samples.setdefault(name, []).append(float(latency))
    minimum = policy["observation"]["baseline_minimum_samples"]
    if not samples or any(len(values) < minimum for values in samples.values()):
        return "warming", []
    findings: list[dict[str, Any]] = []
    for name, check in public.get("checks", {}).items():
        values = samples.get(name, [])
        latency = check.get("latency_ms")
        if len(values) < minimum or not isinstance(latency, (int, float)):
            continue
        median = statistics.median(values)
        deviations = [abs(value - median) for value in values]
        mad = statistics.median(deviations) or max(median * 0.1, 1.0)
        threshold = max(median + 8 * mad, median * 3, 1500)
        if latency > threshold:
            findings.append(
                _anomaly(
                    policy,
                    "resource-outlier",
                    message="public request latency exceeded its bounded rolling baseline",
                    evidence={
                        "check": name,
                        "latency_ms": round(float(latency), 2),
                        "threshold_ms": round(float(threshold), 2),
                    },
                )
            )
    return "ready", findings


def build_observation(args: argparse.Namespace) -> dict[str, Any]:
    policy = load_policy(args.policy)
    try:
        public = json.loads(Path(args.public).read_text(encoding="utf-8"))
        validate_sanitized(public, "public observation")
    except (OSError, json.JSONDecodeError, ContractError) as error:
        raise ContractError("public observation artifact is malformed") from error
    activity = _load_activity(Path(args.activity))
    deep, deep_error = _load_deep(Path(args.deep))
    now = (
        parse_timestamp(args.observed_at, "observed_at")
        if args.observed_at
        else dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    )
    baseline_paths = sorted(Path(args.baselines).glob("*.json")) if args.baselines else []
    _apply_restart_deltas(deep, baseline_paths, policy)
    findings = _classify_public(public, policy)
    deep_findings, active_release, operation = _classify_deep(
        deep, deep_error, policy, now
    )
    findings.extend(deep_findings)
    if (
        operation is not None
        and operation["state"] == "active"
        and not _operation_matches_activity(operation, activity)
    ):
        findings.append(
            _anomaly(
                policy,
                "production-operation-mismatch",
                message=(
                    "the active production operation has no exact active "
                    "GitHub workflow"
                ),
                evidence={
                    "workflow_path": operation["workflow_path"],
                    "run_id": operation["run_id"],
                    "activity": activity["classification"],
                    "activity_run_id": activity["run_id"],
                },
            )
        )
    baseline_status, baseline_findings = _baseline_status(public, baseline_paths, policy)
    findings.extend(baseline_findings)
    findings = _apply_maintenance(findings, activity, operation, now)
    deduplicated: dict[tuple[str, str], dict[str, Any]] = {}
    for finding in findings:
        key = (finding["service"], finding["code"])
        existing = deduplicated.get(key)
        if existing is None:
            deduplicated[key] = finding
        elif existing["classification"] == "maintenance" and finding["classification"] == "anomaly":
            deduplicated[key] = finding
    findings = sorted(deduplicated.values(), key=lambda item: (item["service"], item["code"]))
    classifications = {finding["classification"] for finding in findings}
    status = (
        "anomalous"
        if "anomaly" in classifications
        else "unknown"
        if "unknown" in classifications
        else "maintenance"
        if "maintenance" in classifications
        else "healthy"
    )
    document = {
        "schema": OBSERVATION_SCHEMA,
        "environment": ENVIRONMENT,
        "observed_at": timestamp(now),
        "monitor_run_id": int(args.monitor_run_id),
        "monitor_run_attempt": int(args.monitor_run_attempt),
        "source_sha": args.source_sha,
        "status": status,
        "baseline_status": baseline_status,
        "active_release": active_release,
        "production_operation": operation,
        "activity": activity,
        "public": public,
        "deep": deep
        if deep is not None
        else {"available": False, "reason": deep_error},
        "anomalies": findings,
    }
    return validate_observation(document, policy)


def validate_artifact(directory: Path, policy_path: Path) -> dict[str, Any]:
    policy = load_policy(policy_path)
    if not directory.is_dir() or directory.is_symlink():
        raise ContractError("observation artifact directory is invalid")
    entries = sorted(path.name for path in directory.iterdir())
    if entries != ["SHA256SUMS", "observation.json"]:
        raise ContractError("observation artifact file set is invalid")
    if any(path.is_symlink() or not path.is_file() for path in directory.iterdir()):
        raise ContractError("observation artifact contains a symlink or non-file")
    observation_path = directory / "observation.json"
    if observation_path.stat().st_size > policy["observation"]["maximum_artifact_bytes"]:
        raise ContractError("observation artifact exceeds its maximum size")
    checksum_lines = (directory / "SHA256SUMS").read_text(encoding="ascii").splitlines()
    expected_line = f"{__import__('hashlib').sha256(observation_path.read_bytes()).hexdigest()}  observation.json"
    if checksum_lines != [expected_line]:
        raise ContractError("observation artifact checksum is invalid")
    try:
        document = json.loads(observation_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ContractError("observation artifact JSON is malformed") from error
    return validate_observation(document, policy)


def command_collect_public(args: argparse.Namespace) -> None:
    document = collect_public(args.public_url, args.redirect_url, args.diagnostic_url)
    Path(args.output).write_text(canonical_json(document) + "\n", encoding="utf-8")


def command_build(args: argparse.Namespace) -> None:
    document = build_observation(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(canonical_json(document) + "\n", encoding="utf-8")
    checksum = output.parent / "SHA256SUMS"
    checksum.write_text(
        f"{__import__('hashlib').sha256(output.read_bytes()).hexdigest()}  {output.name}\n",
        encoding="ascii",
    )
    print(
        f"production_monitor_observation=PASS status={document['status']} "
        f"anomalies={len(document['anomalies'])} sha256={document_sha256(document)}"
    )


def command_validate_artifact(args: argparse.Namespace) -> None:
    document = validate_artifact(Path(args.directory), Path(args.policy))
    print(
        f"production_monitor_artifact=PASS run_id={document['monitor_run_id']} "
        f"status={document['status']}"
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subparsers = result.add_subparsers(dest="command", required=True)
    public = subparsers.add_parser("collect-public")
    public.add_argument("--public-url", required=True)
    public.add_argument("--redirect-url", required=True)
    public.add_argument("--diagnostic-url", required=True)
    public.add_argument("--output", required=True)
    public.set_defaults(handler=command_collect_public)

    build = subparsers.add_parser("build")
    build.add_argument("--policy", required=True)
    build.add_argument("--public", required=True)
    build.add_argument("--deep", required=True)
    build.add_argument("--activity", required=True)
    build.add_argument("--baselines")
    build.add_argument("--monitor-run-id", required=True)
    build.add_argument("--monitor-run-attempt", required=True)
    build.add_argument("--source-sha", required=True)
    build.add_argument("--observed-at")
    build.add_argument("--output", required=True)
    build.set_defaults(handler=command_build)

    validate = subparsers.add_parser("validate-artifact")
    validate.add_argument("--policy", required=True)
    validate.add_argument("--directory", required=True)
    validate.set_defaults(handler=command_validate_artifact)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (ContractError, ValueError, subprocess.SubprocessError) as error:
        print(f"production_monitor=FAIL reason={error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
