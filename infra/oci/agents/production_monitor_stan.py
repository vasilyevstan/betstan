#!/usr/bin/env python3
"""Read-only OCI production observer and deduplicated incident recorder."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import re
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPOSITORY = "vasilyevstan/betstan"
NAMESPACE = "betstan-oci"
SCHEMA = "betstan.production-monitor.snapshot.v1"
INCIDENT_SCHEMA = "betstan.production-monitor.incident.v1"
INCIDENT_LABEL = "production-monitor-incident"
INCIDENT_MARKER = "betstan-production-monitor-incident"
SERVICES = (
    "auth",
    "bet",
    "backoffice",
    "client",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
)
PLATFORM_SERVICES = ("auth-mongo", "rabbitmq")
PLATFORM_IMAGES = {
    "auth-mongo": {
        "image": "docker.io/library/mongo@sha256:"
        "e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3",
        "runtime_digests": {
            "sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3",
            "sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4",
        },
    },
    "rabbitmq": {
        "image": "docker.io/library/rabbitmq@sha256:"
        "6033d0c2f4e9eb49dda9623067a96d317bc7b550513bd18532fbd3cd9a941c1b",
        "runtime_digests": {
            "sha256:6033d0c2f4e9eb49dda9623067a96d317bc7b550513bd18532fbd3cd9a941c1b"
        },
    },
}
SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
RUN_ID = re.compile(r"^[1-9][0-9]*$")
MODES = {
    "observation": 0,
    "ownership": 1,
    "draft-fix": 2,
    "auto-redeploy": 3,
    "self-heal": 4,
}
SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
INCIDENT_KEYS = {
    "schema",
    "incident_issue",
    "fingerprint",
    "deployment_sha",
    "deployment_run_id",
    "originating_pr",
    "service",
    "anomaly_type",
    "severity",
    "automation_class",
    "first_seen",
    "last_seen",
    "last_observed_at",
    "last_monitor_run_id",
    "last_monitor_run_attempt",
    "consecutive_observations",
    "total_observations",
    "healthy_observations",
    "status",
    "lease_issue",
    "repair_attempts",
    "self_heal_attempted",
    "last_evidence_sha256",
}
INCIDENT_STATUSES = {
    "observing",
    "claimable",
    "claimed",
    "repairing",
    "validating",
    "escalated",
    "resolved",
    "superseded",
}
PROVENANCE_KEYS = {
    "source_sha",
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
    "data_run_id",
    "data_run_attempt",
    "data_evidence_sha256",
    "infrastructure_run_id",
    "infrastructure_run_attempt",
    "infrastructure_provenance_sha256",
}


class MonitorError(RuntimeError):
    pass


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def timestamp(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def parse_timestamp(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str):
        raise MonitorError(f"{field} is not a timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise MonitorError(f"{field} is not a timestamp") from error
    if parsed.tzinfo is None:
        raise MonitorError(f"{field} is not timezone-aware")
    return parsed.astimezone(dt.timezone.utc)


def exact_int(value: Any, field: str, *, allow_zero: bool = False) -> int:
    if isinstance(value, bool):
        raise MonitorError(f"{field} is not an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise MonitorError(f"{field} is not an integer") from error
    if parsed < (0 if allow_zero else 1) or str(parsed) != str(value):
        raise MonitorError(f"{field} is outside its supported range")
    return parsed


def parse_env(path: Path, expected_keys: set[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        key, separator, value = line.partition("=")
        if not separator or not key or not value:
            raise MonitorError(f"{path}:{line_number}: expected non-empty key=value")
        if key in values:
            raise MonitorError(f"{path}:{line_number}: duplicate key {key}")
        values[key] = value
    if set(values) != expected_keys:
        raise MonitorError(
            f"{path} keys differ from deployment provenance "
            f"missing={sorted(expected_keys - set(values))} "
            f"extra={sorted(set(values) - expected_keys)}"
        )
    return values


def validate_images(
    path: Path, source_sha: str
) -> tuple[dict[str, str], dict[str, str]]:
    images: dict[str, str] = {}
    platform_digests: dict[str, str] = {}
    repository = "ghcr.io/vasilyevstan/betstan-images"
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        fields = line.split("\t")
        if len(fields) != 5:
            raise MonitorError(f"{path}:{line_number}: expected five image columns")
        service, actual_repository, image_ref, digest, platform_digest = fields
        if service not in SERVICES or service in images:
            raise MonitorError(f"{path}:{line_number}: invalid or duplicate service")
        if actual_repository != repository:
            raise MonitorError(f"{path}:{line_number}: image repository mismatch")
        if (
            not DIGEST.fullmatch(digest)
            or not DIGEST.fullmatch(platform_digest)
            or image_ref != f"{repository}@{digest}"
        ):
            raise MonitorError(f"{path}:{line_number}: immutable image mismatch")
        images[service] = image_ref
        platform_digests[service] = platform_digest
    if set(images) != set(SERVICES):
        raise MonitorError("deployment image evidence is incomplete")
    if not SHA.fullmatch(source_sha):
        raise MonitorError("deployment source SHA is malformed")
    return images, platform_digests


def validate_deployment_artifact(
    directory: Path, metadata: dict[str, Any]
) -> dict[str, Any]:
    if not directory.is_dir() or any(item.is_symlink() for item in directory.rglob("*")):
        raise MonitorError("deployment artifact directory is missing or has symlinks")
    provenance_path = directory / "provenance.txt"
    images_path = directory / "images.tsv"
    if not provenance_path.is_file() or not images_path.is_file():
        raise MonitorError("deployment artifact is incomplete")
    values = parse_env(provenance_path, PROVENANCE_KEYS)
    run_id = exact_int(metadata.get("id"), "deployment run ID")
    source_sha = values["source_sha"]
    expected = {
        "runtime_mode": "k3s",
        "public_host": "betstan.xyz",
        "canonical_host": "betstan.xyz",
        "redirect_host": "www.betstan.xyz",
        "deployment_workflow": "oci-production-deploy",
        "deployment_run_id": str(run_id),
        "deployment_run_attempt": "1",
        "registry_provider": "ghcr",
        "registry_host": "ghcr.io",
        "registry_repository": "ghcr.io/vasilyevstan/betstan-images",
        "registry_public_anonymous": "true",
        "data_run_attempt": "1",
        "infrastructure_run_attempt": "1",
    }
    for key, expected_value in expected.items():
        if values[key] != expected_value:
            raise MonitorError(f"deployment provenance {key} mismatch")
    for key in (
        "runtime_fingerprint",
        "image_provenance_sha256",
        "rendered_manifest_sha256",
        "rabbitmq_baseline_sha256",
        "data_evidence_sha256",
        "infrastructure_provenance_sha256",
    ):
        if not re.fullmatch(r"[0-9a-f]{64}", values[key]):
            raise MonitorError(f"deployment provenance {key} is malformed")
    for key in ("data_run_id", "infrastructure_run_id"):
        if not RUN_ID.fullmatch(values[key]):
            raise MonitorError(f"deployment provenance {key} is malformed")
    if not SHA.fullmatch(source_sha):
        raise MonitorError("deployment provenance source SHA is malformed")
    if metadata.get("workflow_id") is None:
        raise MonitorError("deployment workflow ID is missing")
    expected_metadata = {
        "path": ".github/workflows/oci-production-deploy.yml",
        "event": "workflow_dispatch",
        "head_sha": source_sha,
        "head_branch": "master",
        "status": "completed",
        "conclusion": "success",
        "run_attempt": 1,
        "display_title": f"oci-deploy {source_sha}",
    }
    for key, expected_value in expected_metadata.items():
        if metadata.get(key) != expected_value:
            raise MonitorError(f"deployment run {key} mismatch")
    if (
        (metadata.get("head_repository") or {}).get("full_name") != REPOSITORY
    ):
        raise MonitorError("deployment run repository mismatch")
    images, platform_digests = validate_images(images_path, source_sha)
    image_hash = hashlib.sha256(images_path.read_bytes()).hexdigest()
    if image_hash != values["image_provenance_sha256"]:
        raise MonitorError("deployment image evidence hash mismatch")
    diagnostic_host = values["diagnostic_host"]
    match = re.fullmatch(
        r"(?P<address>(?:[0-9]{1,3}\.){3}[0-9]{1,3})\.nip\.io",
        diagnostic_host,
    )
    try:
        diagnostic_address = (
            ipaddress.ip_address(match.group("address")) if match else None
        )
    except ValueError:
        diagnostic_address = None
    if (
        diagnostic_address is None
        or not isinstance(diagnostic_address, ipaddress.IPv4Address)
        or not diagnostic_address.is_global
    ):
        raise MonitorError("deployment diagnostic host is malformed")
    completed_at = metadata.get("updated_at")
    parse_timestamp(completed_at, "deployment updated_at")
    return {
        "sha": source_sha,
        "run_id": run_id,
        "completed_at": completed_at,
        "originating_pr": 0,
        "diagnostic_url": f"https://{diagnostic_host}",
        "images": images,
        "platform_digests": platform_digests,
        "runtime_fingerprint": values["runtime_fingerprint"],
        "namespace": NAMESPACE,
        "data_run_id": int(values["data_run_id"]),
        "infrastructure_run_id": int(values["infrastructure_run_id"]),
    }


class GhApi:
    def __init__(self, repository: str):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise MonitorError("repository must be owner/name")
        self.repository = repository

    def api(
        self,
        endpoint: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
        check: bool = True,
    ) -> Any:
        command = ["gh", "api"]
        if method != "GET":
            command += ["--method", method]
        command.append(endpoint)
        if payload is not None:
            command += ["--input", "-"]
        result = subprocess.run(
            command,
            input=None if payload is None else json.dumps(payload),
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            if not check:
                return None
            detail = result.stderr.strip().splitlines()[-1:] or ["GitHub API error"]
            raise MonitorError(detail[0])
        if not result.stdout.strip():
            return {}
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise MonitorError("GitHub API returned invalid JSON") from error

    def ensure_label(self, name: str, color: str, description: str) -> None:
        encoded = urllib.parse.quote(name, safe="")
        current = self.api(
            f"repos/{self.repository}/labels/{encoded}", check=False
        )
        if current is None:
            self.api(
                f"repos/{self.repository}/labels",
                method="POST",
                payload={"name": name, "color": color, "description": description},
            )
        elif current.get("name") != name:
            raise MonitorError(f"label {name} identity mismatch")

    def list_incidents(self) -> list[dict[str, Any]]:
        encoded = urllib.parse.quote(INCIDENT_LABEL, safe="")
        result = self.api(
            f"repos/{self.repository}/issues?state=open&labels={encoded}&per_page=100"
        )
        if not isinstance(result, list) or len(result) >= 100:
            raise MonitorError("incident query is malformed or reached its page bound")
        return result

    def create_issue(self, title: str, body: str) -> dict[str, Any]:
        return self.api(
            f"repos/{self.repository}/issues",
            method="POST",
            payload={"title": title, "body": body, "labels": [INCIDENT_LABEL]},
        )

    def update_issue(
        self, number: int, body: str, *, state: str | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"body": body}
        if state:
            payload["state"] = state
        return self.api(
            f"repos/{self.repository}/issues/{number}",
            method="PATCH",
            payload=payload,
        )

    def comment(self, number: int, body: str) -> None:
        self.api(
            f"repos/{self.repository}/issues/{number}/comments",
            method="POST",
            payload={"body": body},
        )


def resolve_deployment(repository: str, artifact_dir: Path) -> dict[str, Any]:
    gh = GhApi(repository)
    workflow = gh.api(f"repos/{repository}/actions/workflows/oci-production-deploy.yml")
    workflow_id = exact_int(workflow.get("id"), "workflow ID")
    runs = gh.api(
        f"repos/{repository}/actions/workflows/{workflow_id}/runs"
        "?event=workflow_dispatch&status=success&branch=master&per_page=100"
    )
    candidates = runs.get("workflow_runs") if isinstance(runs, dict) else None
    if not isinstance(candidates, list) or not candidates:
        raise MonitorError("no successful OCI deployment run is available")
    candidates = sorted(
        candidates,
        key=lambda item: exact_int(item.get("id"), "candidate run ID"),
        reverse=True,
    )
    selected: dict[str, Any] | None = None
    for candidate in candidates:
        run_id = candidate["id"]
        metadata = gh.api(f"repos/{repository}/actions/runs/{run_id}/attempts/1")
        if (
            metadata.get("workflow_id") == workflow_id
            and metadata.get("path")
            == ".github/workflows/oci-production-deploy.yml"
            and metadata.get("event") == "workflow_dispatch"
            and metadata.get("head_branch") == "master"
            and (metadata.get("head_repository") or {}).get("full_name")
            == repository
            and metadata.get("status") == "completed"
            and metadata.get("conclusion") == "success"
            and metadata.get("run_attempt") == 1
        ):
            selected = metadata
            break
    if selected is None:
        raise MonitorError("no trusted first-attempt OCI deployment run is available")
    artifact_dir.mkdir(parents=True, exist_ok=False)
    result = subprocess.run(
        [
            "gh",
            "run",
            "download",
            str(selected["id"]),
            "--repo",
            repository,
            "--name",
            f"oci-deploy-provenance-{selected['id']}-1",
            "--dir",
            str(artifact_dir),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise MonitorError("trusted deployment provenance artifact is unavailable")
    deployment = validate_deployment_artifact(artifact_dir, selected)
    pulls = gh.api(f"repos/{repository}/commits/{deployment['sha']}/pulls")
    matches = [
        pull
        for pull in pulls
        if pull.get("merged_at")
        and pull.get("merge_commit_sha") == deployment["sha"]
        and (pull.get("base") or {}).get("ref") == "master"
        and (pull.get("head") or {}).get("ref") == "dev"
    ]
    if len(matches) != 1:
        raise MonitorError("deployed SHA is not bound to one dev promotion")
    deployment["originating_pr"] = exact_int(
        matches[0].get("number"), "originating PR"
    )
    return deployment


def run_json(command: list[str], label: str) -> dict[str, Any]:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise MonitorError(f"{label} query failed")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise MonitorError(f"{label} query returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise MonitorError(f"{label} query returned an invalid document")
    return payload


def service_from_app(value: Any) -> str:
    if not isinstance(value, str) or not value.startswith("gaming-"):
        return ""
    service = value.removeprefix("gaming-")
    return service if service in set(SERVICES) | set(PLATFORM_SERVICES) else ""


def condition_true(conditions: Any, condition_type: str) -> bool:
    return any(
        item.get("type") == condition_type and item.get("status") == "True"
        for item in (conditions or [])
        if isinstance(item, dict)
    )


def collect_cluster(namespace: str, runtime_fingerprint: str) -> dict[str, Any]:
    if namespace != NAMESPACE:
        raise MonitorError("monitor namespace differs from the production contract")
    if not re.fullmatch(r"[0-9a-f]{64}", runtime_fingerprint):
        raise MonitorError("monitor runtime fingerprint is malformed")
    context = subprocess.run(
        [
            "kubectl",
            "config",
            "view",
            "--minify",
            "-o",
            "jsonpath={.clusters[0].cluster.server}{'\\t'}"
            "{.contexts[0].context.namespace}{'\\t'}{.contexts[0].context.user}",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if (
        context.returncode != 0
        or context.stdout.strip()
        != "https://127.0.0.1:16444\tbetstan-oci\tbetstan-monitor-oidc"
    ):
        raise MonitorError("kubectl context differs from the monitor contract")
    ready = subprocess.run(
        ["kubectl", "--request-timeout=10s", "get", "--raw=/readyz"],
        text=True,
        capture_output=True,
        check=False,
    )
    nodes_raw = run_json(
        [
            "kubectl",
            "--request-timeout=15s",
            "get",
            "node",
            "betstan-k3s",
            "-o",
            "json",
        ],
        "nodes",
    )
    provider_id = nodes_raw.get("spec", {}).get("providerID", "")
    if (
        not isinstance(provider_id, str)
        or not provider_id.startswith("oci://ocid1.instance.")
        or hashlib.sha256(provider_id.removeprefix("oci://").encode()).hexdigest()
        != runtime_fingerprint
        or nodes_raw.get("metadata", {})
        .get("labels", {})
        .get("betstan.io/runtime")
        != "k3s"
    ):
        raise MonitorError("live node identity differs from deployment provenance")
    deployments_raw = run_json(
        [
            "kubectl",
            "--request-timeout=15s",
            "get",
            "deployments",
            "-n",
            namespace,
            "-o",
            "json",
        ],
        "deployments",
    )
    statefulsets_raw = run_json(
        [
            "kubectl",
            "--request-timeout=15s",
            "get",
            "statefulsets",
            "-n",
            namespace,
            "-o",
            "json",
        ],
        "statefulsets",
    )
    pods_raw = run_json(
        [
            "kubectl",
            "--request-timeout=15s",
            "get",
            "pods",
            "-n",
            namespace,
            "-o",
            "json",
        ],
        "pods",
    )
    endpoints_raw = run_json(
        [
            "kubectl",
            "--request-timeout=15s",
            "get",
            "endpoints",
            "-n",
            namespace,
            "-o",
            "json",
        ],
        "endpoints",
    )
    certificates_raw = run_json(
        [
            "kubectl",
            "--request-timeout=15s",
            "get",
            "certificates.cert-manager.io",
            "-n",
            namespace,
            "-o",
            "json",
        ],
        "certificates",
    )
    lock_raw = run_json(
        [
            "kubectl",
            "--request-timeout=15s",
            "get",
            "configmap",
            "gaming-mongo-migration-lock",
            "-n",
            namespace,
            "-o",
            "json",
        ],
        "shared Mongo lock",
    )
    nodes = []
    for item in [nodes_raw]:
        conditions = item.get("status", {}).get("conditions", [])
        nodes.append(
            {
                "name": item.get("metadata", {}).get("name", ""),
                "ready": condition_true(conditions, "Ready"),
                "memory_pressure": condition_true(conditions, "MemoryPressure"),
                "disk_pressure": condition_true(conditions, "DiskPressure"),
                "pid_pressure": condition_true(conditions, "PIDPressure"),
            }
        )
    deployments = []
    platform_workloads = []
    for item in deployments_raw.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})
        status = item.get("status", {})
        template = spec.get("template", {})
        service = service_from_app(
            template.get("metadata", {}).get("labels", {}).get("app")
        )
        if not service:
            continue
        containers = template.get("spec", {}).get("containers", [])
        matches = [
            container.get("image", "")
            for container in containers
            if container.get("name") == f"gaming-{service}"
        ]
        workload = {
            "kind": "Deployment",
            "name": metadata.get("name", ""),
            "service": service,
            "generation": metadata.get("generation", 0),
            "observed_generation": status.get("observedGeneration", 0),
            "desired": spec.get("replicas", 0),
            "updated": status.get("updatedReplicas", 0),
            "ready": status.get("readyReplicas", 0),
            "available": status.get("availableReplicas", 0),
            "unavailable": status.get("unavailableReplicas", 0),
            "image": matches[0] if len(matches) == 1 else "",
        }
        if service in SERVICES:
            deployments.append(workload)
        elif service == "rabbitmq":
            platform_workloads.append(workload)
    for item in statefulsets_raw.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})
        status = item.get("status", {})
        template = spec.get("template", {})
        service = service_from_app(
            template.get("metadata", {}).get("labels", {}).get("app")
        )
        if service != "auth-mongo":
            continue
        containers = template.get("spec", {}).get("containers", [])
        matches = [
            container.get("image", "")
            for container in containers
            if container.get("name") == "gaming-auth-mongo"
        ]
        platform_workloads.append(
            {
                "kind": "StatefulSet",
                "name": metadata.get("name", ""),
                "service": service,
                "generation": metadata.get("generation", 0),
                "observed_generation": status.get("observedGeneration", 0),
                "desired": spec.get("replicas", 0),
                "updated": status.get("updatedReplicas", 0),
                "ready": status.get("readyReplicas", 0),
                "available": status.get("currentReplicas", 0),
                "unavailable": max(
                    0,
                    int(spec.get("replicas", 0))
                    - int(status.get("readyReplicas", 0)),
                ),
                "image": matches[0] if len(matches) == 1 else "",
            }
        )
    pods = []
    platform_pods = []
    for item in pods_raw.get("items", []):
        metadata = item.get("metadata", {})
        service = service_from_app(metadata.get("labels", {}).get("app"))
        if not service:
            continue
        statuses = item.get("status", {}).get("containerStatuses", [])
        matches = [
            status
            for status in statuses
            if status.get("name") == f"gaming-{service}"
        ]
        status = matches[0] if len(matches) == 1 else {}
        waiting = status.get("state", {}).get("waiting", {})
        terminated = status.get("lastState", {}).get("terminated", {})
        pod = {
            "name": metadata.get("name", ""),
            "service": service,
            "created_at": metadata.get("creationTimestamp", ""),
            "phase": item.get("status", {}).get("phase", ""),
            "ready": bool(status.get("ready", False)),
            "restarts": status.get("restartCount", 0),
            "waiting_reason": waiting.get("reason", ""),
            "last_terminated_reason": terminated.get("reason", ""),
            "last_terminated_at": terminated.get("finishedAt", ""),
            "image": status.get("image", ""),
            "image_id": status.get("imageID", ""),
        }
        if service in SERVICES:
            pods.append(pod)
        else:
            platform_pods.append(pod)
    endpoints: dict[str, int] = {}
    for item in endpoints_raw.get("items", []):
        service = re.sub(
            r"^gaming-|-(?:srv|service)$",
            "",
            item.get("metadata", {}).get("name", ""),
        )
        if service not in set(SERVICES) | set(PLATFORM_SERVICES):
            continue
        endpoints[service] = sum(
            len(subset.get("addresses", [])) for subset in item.get("subsets", [])
        )
    certificates = []
    for item in certificates_raw.get("items", []):
        status = item.get("status", {})
        certificates.append(
            {
                "name": item.get("metadata", {}).get("name", ""),
                "ready": condition_true(status.get("conditions", []), "Ready"),
                "not_after": status.get("notAfter", ""),
                "dns_names": item.get("spec", {}).get("dnsNames", []),
            }
        )
    lock_data = lock_raw.get("data", {})
    lock = {
        "state": lock_data.get("state", ""),
        "holder": lock_data.get("holder", ""),
        "operation_id": lock_data.get("operation-id", ""),
        "source_sha": lock_data.get("source-sha", ""),
        "lease_until_epoch": lock_data.get("lease-until-epoch", ""),
    }
    return {
        "api_ready": ready.returncode == 0 and ready.stdout.strip() == "ok",
        "nodes": nodes,
        "deployments": deployments,
        "pods": pods,
        "platform_workloads": platform_workloads,
        "platform_pods": platform_pods,
        "endpoints": endpoints,
        "certificates": certificates,
        "operation_lock": lock,
    }


def http_check(
    name: str,
    url: str,
    expected_status: set[int],
    validator: str,
) -> dict[str, Any]:
    marker = "\n__BETSTAN_MONITOR_META__"
    command = [
        "curl",
        "--silent",
        "--show-error",
        "--max-time",
        "20",
        "--max-filesize",
        "1048576",
        "--output",
        "-",
        "--write-out",
        f"{marker}%{{http_code}}\t%{{time_total}}\t%{{redirect_url}}",
        url,
    ]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    body, separator, metadata = result.stdout.rpartition(marker)
    status = 0
    latency_ms = 0
    redirect = ""
    if separator:
        fields = metadata.split("\t")
        if len(fields) == 3 and fields[0].isdigit():
            status = int(fields[0])
            try:
                latency_ms = round(float(fields[1]) * 1000)
            except ValueError:
                latency_ms = 0
            redirect = fields[2]
    valid_body = False
    if validator == "home":
        valid_body = "BetStan.xyz demo app" in body
    elif validator == "auth":
        try:
            valid_body = json.loads(body) == {"currentUser": None}
        except (json.JSONDecodeError, TypeError):
            valid_body = False
    elif validator == "array":
        try:
            valid_body = isinstance(json.loads(body), list)
        except json.JSONDecodeError:
            valid_body = False
    elif validator == "redirect":
        valid_body = redirect == "https://betstan.xyz/"
    return {
        "name": name,
        "status": status,
        "valid": (
            result.returncode == 0
            and status in expected_status
            and valid_body
        ),
        "latency_ms": latency_ms,
        "error": "" if result.returncode == 0 else f"curl-exit-{result.returncode}",
    }


def collect_snapshot(
    deployment: dict[str, Any],
    namespace: str,
    monitor_run_id: int,
    monitor_run_attempt: int,
) -> dict[str, Any]:
    public = [
        http_check("canonical-home", "https://betstan.xyz/", {200}, "home"),
        http_check(
            "auth-currentuser",
            "https://betstan.xyz/api/auth/currentuser",
            {200},
            "auth",
        ),
        http_check(
            "event-api", "https://betstan.xyz/api/event", {200}, "array"
        ),
        http_check(
            "www-redirect", "https://www.betstan.xyz/", {301, 302, 307, 308}, "redirect"
        ),
        http_check(
            "diagnostic-event",
            f"{deployment['diagnostic_url']}/api/event",
            {200},
            "array",
        ),
    ]
    return {
        "schema": SCHEMA,
        "observed_at": timestamp(utc_now()),
        "monitor_run_id": monitor_run_id,
        "monitor_run_attempt": monitor_run_attempt,
        "deployment": deployment,
        "cluster": collect_cluster(namespace, deployment["runtime_fingerprint"]),
        "public": public,
    }


def anomaly(
    deployment_sha: str,
    service: str,
    anomaly_type: str,
    severity: str,
    automation_class: str,
    evidence: list[dict[str, Any]],
) -> dict[str, Any]:
    fingerprint = hashlib.sha256(
        f"{deployment_sha}\n{service}\n{anomaly_type}".encode()
    ).hexdigest()
    return {
        "fingerprint": fingerprint,
        "service": service,
        "type": anomaly_type,
        "severity": severity,
        "automation_class": automation_class,
        "evidence": evidence,
    }


def classify(snapshot: dict[str, Any], now: dt.datetime | None = None) -> list[dict[str, Any]]:
    now = (now or utc_now()).astimezone(dt.timezone.utc)
    if snapshot.get("schema") != SCHEMA:
        raise MonitorError("snapshot schema is unsupported")
    parse_timestamp(snapshot.get("observed_at"), "observed_at")
    exact_int(snapshot.get("monitor_run_id"), "monitor_run_id")
    exact_int(snapshot.get("monitor_run_attempt"), "monitor_run_attempt")
    deployment = snapshot.get("deployment")
    cluster = snapshot.get("cluster")
    public = snapshot.get("public")
    if not isinstance(deployment, dict) or not isinstance(cluster, dict):
        raise MonitorError("snapshot deployment or cluster document is missing")
    sha = deployment.get("sha")
    if not SHA.fullmatch(str(sha)):
        raise MonitorError("snapshot deployment SHA is malformed")
    expected_images = deployment.get("images")
    if not isinstance(expected_images, dict) or set(expected_images) != set(SERVICES):
        raise MonitorError("snapshot expected images are incomplete")
    expected_platform_digests = deployment.get("platform_digests")
    if (
        not isinstance(expected_platform_digests, dict)
        or set(expected_platform_digests) != set(SERVICES)
        or any(
            not DIGEST.fullmatch(str(value))
            for value in expected_platform_digests.values()
        )
    ):
        raise MonitorError("snapshot expected platform digests are incomplete")
    if deployment.get("namespace") != NAMESPACE or not re.fullmatch(
        r"[0-9a-f]{64}", str(deployment.get("runtime_fingerprint", ""))
    ):
        raise MonitorError("snapshot runtime identity is malformed")
    grouped: dict[tuple[str, str], tuple[str, str, list[dict[str, Any]]]] = {}

    def add(
        service: str,
        kind: str,
        severity: str,
        automation_class: str,
        evidence: dict[str, Any],
    ) -> None:
        key = (service, kind)
        if key not in grouped:
            grouped[key] = (severity, automation_class, [])
        grouped[key][2].append(evidence)

    if not cluster.get("api_ready"):
        add("platform", "kubernetes-api-unready", "critical", "restricted", {})
    nodes = cluster.get("nodes")
    if not isinstance(nodes, list) or len(nodes) != 1:
        add(
            "platform",
            "node-inventory-mismatch",
            "critical",
            "restricted",
            {"count": len(nodes) if isinstance(nodes, list) else -1},
        )
    else:
        node = nodes[0]
        if not node.get("ready"):
            add("platform", "node-unready", "critical", "restricted", node)
        for condition in ("memory_pressure", "disk_pressure", "pid_pressure"):
            if node.get(condition):
                add(
                    "platform",
                    f"node-{condition.replace('_', '-')}",
                    "critical",
                    "restricted",
                    {"node": node.get("name")},
                )
    deployments = cluster.get("deployments")
    if not isinstance(deployments, list):
        raise MonitorError("snapshot deployments are malformed")
    by_service = {item.get("service"): item for item in deployments}
    if len(by_service) != len(deployments):
        raise MonitorError("snapshot has duplicate deployment services")
    for service in SERVICES:
        item = by_service.get(service)
        if item is None:
            add(service, "workload-missing", "critical", "restricted", {})
            continue
        desired = item.get("desired", 0)
        if item.get("name") != f"gaming-{service}-depl" or desired != 1:
            add(
                service,
                "workload-topology-drift",
                "critical",
                "restricted",
                {"name": item.get("name"), "desired": desired},
            )
        if (
            item.get("ready", 0) != desired
            or item.get("available", 0) != desired
            or item.get("updated", 0) != desired
            or item.get("unavailable", 0) not in (0, None)
            or item.get("observed_generation") != item.get("generation")
        ):
            automation = (
                "self-heal"
                if service in {"client", "backoffice"}
                else "draft-only"
            )
            add(service, "workload-unavailable", "high", automation, item)
        if item.get("image") != expected_images[service]:
            add(
                service,
                "deployment-image-drift",
                "critical",
                "restricted",
                {"actual": item.get("image"), "expected": expected_images[service]},
            )
    platform_workloads = cluster.get("platform_workloads")
    if not isinstance(platform_workloads, list):
        raise MonitorError("snapshot platform workloads are malformed")
    platform_by_service = {
        item.get("service"): item for item in platform_workloads
    }
    if len(platform_by_service) != len(platform_workloads):
        raise MonitorError("snapshot has duplicate platform workloads")
    for service in PLATFORM_SERVICES:
        item = platform_by_service.get(service)
        if item is None:
            add(
                "data" if service == "auth-mongo" else "platform",
                f"{service}-workload-missing",
                "critical",
                "restricted",
                {},
            )
            continue
        desired = item.get("desired", 0)
        if (
            item.get("name") != f"gaming-{service}-depl"
            or desired != 1
            or item.get("image") != PLATFORM_IMAGES[service]["image"]
        ):
            add(
                "data" if service == "auth-mongo" else "platform",
                f"{service}-topology-drift",
                "critical",
                "restricted",
                {
                    "name": item.get("name"),
                    "desired": desired,
                    "image": item.get("image"),
                },
            )
        if (
            item.get("ready", 0) != desired
            or item.get("available", 0) != desired
            or item.get("updated", 0) != desired
            or item.get("unavailable", 0) not in (0, None)
            or item.get("observed_generation") != item.get("generation")
        ):
            add(
                "data" if service == "auth-mongo" else "platform",
                f"{service}-workload-unavailable",
                "critical" if service == "auth-mongo" else "high",
                "restricted",
                item,
            )
    pods = cluster.get("pods")
    if not isinstance(pods, list):
        raise MonitorError("snapshot pods are malformed")
    pod_counts = {service: 0 for service in SERVICES}
    for pod in pods:
        service = pod.get("service")
        if service not in SERVICES:
            raise MonitorError("snapshot pod service is malformed")
        pod_counts[service] += 1
        if not pod.get("ready"):
            add(service, "pod-unready", "high", "draft-only", pod)
        reason = pod.get("waiting_reason")
        if reason in {"CrashLoopBackOff", "RunContainerError"}:
            automation = (
                "self-heal"
                if service in {"client", "backoffice"}
                else "draft-only"
            )
            add(service, "pod-crash-loop", "high", automation, pod)
        elif reason in {"ImagePullBackOff", "ErrImagePull", "InvalidImageName"}:
            add(service, "image-pull-failure", "critical", "restricted", pod)
        if pod.get("last_terminated_reason") == "OOMKilled":
            add(service, "pod-oom", "high", "restricted", pod)
        finished_at = pod.get("last_terminated_at")
        if pod.get("restarts", 0) and finished_at:
            try:
                age = (now - parse_timestamp(finished_at, "pod termination")).total_seconds()
            except MonitorError:
                age = -1
            if 0 <= age <= 1800:
                add(service, "recent-pod-restart", "medium", "draft-only", pod)
        if pod.get("image") != expected_images[service]:
            add(
                service,
                "pod-image-drift",
                "critical",
                "restricted",
                {"pod": pod.get("name"), "actual": pod.get("image")},
            )
        image_id = pod.get("image_id", "")
        if not str(image_id).endswith(
            "@" + expected_platform_digests[service]
        ):
            add(
                service,
                "pod-image-id-drift",
                "critical",
                "restricted",
                {"pod": pod.get("name"), "image_id": image_id},
            )
    for service, count in pod_counts.items():
        if count != 1:
            add(
                service,
                "pod-inventory-mismatch",
                "high",
                "restricted",
                {"count": count},
            )
    platform_pods = cluster.get("platform_pods")
    if not isinstance(platform_pods, list):
        raise MonitorError("snapshot platform pods are malformed")
    platform_pod_counts = {service: 0 for service in PLATFORM_SERVICES}
    for pod in platform_pods:
        service = pod.get("service")
        if service not in PLATFORM_SERVICES:
            raise MonitorError("snapshot platform pod service is malformed")
        platform_pod_counts[service] += 1
        owner = "data" if service == "auth-mongo" else "platform"
        if not pod.get("ready"):
            add(
                owner,
                f"{service}-pod-unready",
                "critical",
                "restricted",
                pod,
            )
        if (
            pod.get("image") != PLATFORM_IMAGES[service]["image"]
            or not any(
                str(pod.get("image_id", "")).endswith("@" + digest)
                for digest in PLATFORM_IMAGES[service]["runtime_digests"]
            )
        ):
            add(
                owner,
                f"{service}-pod-image-drift",
                "critical",
                "restricted",
                {
                    "pod": pod.get("name"),
                    "image": pod.get("image"),
                    "image_id": pod.get("image_id"),
                },
            )
        reason = pod.get("waiting_reason")
        if reason in {
            "CrashLoopBackOff",
            "RunContainerError",
            "ImagePullBackOff",
            "ErrImagePull",
            "InvalidImageName",
        }:
            add(
                owner,
                f"{service}-pod-failure",
                "critical",
                "restricted",
                pod,
            )
        if pod.get("last_terminated_reason") == "OOMKilled":
            add(
                owner,
                f"{service}-pod-oom",
                "critical",
                "restricted",
                pod,
            )
    for service, count in platform_pod_counts.items():
        if count != 1:
            add(
                "data" if service == "auth-mongo" else "platform",
                f"{service}-pod-inventory-mismatch",
                "critical",
                "restricted",
                {"count": count},
            )
    endpoints = cluster.get("endpoints")
    if not isinstance(endpoints, dict):
        raise MonitorError("snapshot endpoints are malformed")
    if set(endpoints) != set(SERVICES) | set(PLATFORM_SERVICES):
        raise MonitorError("snapshot endpoint inventory is incomplete")
    for service in SERVICES:
        if endpoints.get(service, 0) < 1:
            add(service, "service-has-no-endpoints", "high", "draft-only", {})
    for service in PLATFORM_SERVICES:
        if endpoints.get(service, 0) < 1:
            add(
                "data" if service == "auth-mongo" else "platform",
                f"{service}-service-has-no-endpoints",
                "critical",
                "restricted",
                {},
            )
    certificates = cluster.get("certificates")
    if not isinstance(certificates, list):
        raise MonitorError("snapshot certificates are malformed")
    canonical_certificates = [
        certificate
        for certificate in certificates
        if "betstan.xyz" in certificate.get("dns_names", [])
    ]
    if not any(
        certificate.get("ready") for certificate in canonical_certificates
    ):
        add("ingress", "certificate-unready", "critical", "restricted", {})
    for certificate in canonical_certificates:
        not_after = certificate.get("not_after")
        if not not_after:
            add(
                "ingress",
                "certificate-expiry-unverifiable",
                "high",
                "restricted",
                {"name": certificate.get("name")},
            )
            continue
        try:
            remaining = (
                parse_timestamp(not_after, "certificate not_after") - now
            ).total_seconds()
        except MonitorError:
            remaining = -1
        if remaining < 7 * 86400:
            add(
                "ingress",
                "certificate-expiring",
                "critical" if remaining <= 0 else "high",
                "restricted",
                {
                    "name": certificate.get("name"),
                    "not_after": not_after,
                },
            )
    lock = cluster.get("operation_lock")
    if not isinstance(lock, dict):
        raise MonitorError("snapshot operation lock is malformed")
    if lock.get("state") == "active":
        lease_until = lock.get("lease_until_epoch", "")
        if not str(lease_until).isdigit() or int(lease_until) <= int(now.timestamp()):
            add(
                "data",
                "stale-shared-mongo-lock",
                "critical",
                "restricted",
                lock,
            )
    elif lock.get("state") != "released" or lock.get("holder"):
        add("data", "shared-mongo-lock-invalid", "critical", "restricted", lock)
    public_checks = public
    if not isinstance(public_checks, list):
        raise MonitorError("snapshot public checks are malformed")
    public_map = {
        "canonical-home": "client",
        "auth-currentuser": "auth",
        "event-api": "event",
        "www-redirect": "ingress",
        "diagnostic-event": "event",
    }
    public_names = [check.get("name") for check in public_checks]
    if len(public_names) != len(set(public_names)) or set(public_names) != set(
        public_map
    ):
        raise MonitorError("snapshot public check inventory is incomplete")
    for check in public_checks:
        if check.get("name") not in public_map:
            raise MonitorError("snapshot public check name is unsupported")
        if not check.get("valid"):
            service = public_map[check["name"]]
            automation = (
                "draft-only"
                if service not in {"auth", "ingress"}
                else "restricted"
            )
            add(
                service,
                f"public-check-{check['name']}-failed",
                "high",
                automation,
                check,
            )
    result = [
        anomaly(sha, service, kind, severity, automation, evidence)
        for (service, kind), (severity, automation, evidence) in grouped.items()
    ]
    return sorted(
        result,
        key=lambda item: (
            SEVERITY_ORDER[item["severity"]],
            item["service"],
            item["type"],
        ),
    )


def validate_incident(document: dict[str, Any]) -> dict[str, Any]:
    if set(document) != INCIDENT_KEYS or document.get("schema") != INCIDENT_SCHEMA:
        raise MonitorError("incident payload differs from the reviewed schema")
    exact_int(document["incident_issue"], "incident issue", allow_zero=True)
    if not re.fullmatch(r"[0-9a-f]{64}", str(document["fingerprint"])):
        raise MonitorError("incident fingerprint is malformed")
    if not SHA.fullmatch(str(document["deployment_sha"])):
        raise MonitorError("incident deployment SHA is malformed")
    for field in (
        "deployment_run_id",
        "originating_pr",
        "last_monitor_run_id",
        "consecutive_observations",
        "total_observations",
        "last_monitor_run_attempt",
    ):
        exact_int(document[field], field)
    for field in (
        "healthy_observations",
        "lease_issue",
        "repair_attempts",
    ):
        exact_int(document[field], field, allow_zero=True)
    if document["status"] not in INCIDENT_STATUSES:
        raise MonitorError("incident status is unsupported")
    if document["severity"] not in SEVERITY_ORDER:
        raise MonitorError("incident severity is unsupported")
    if document["automation_class"] not in {
        "restricted",
        "draft-only",
        "self-heal",
    }:
        raise MonitorError("incident automation class is unsupported")
    if document["service"] not in set(SERVICES) | {
        "platform",
        "ingress",
        "data",
    }:
        raise MonitorError("incident service is unsupported")
    if not re.fullmatch(r"[a-z0-9-]{3,100}", str(document["anomaly_type"])):
        raise MonitorError("incident anomaly type is malformed")
    parse_timestamp(document["first_seen"], "first_seen")
    parse_timestamp(document["last_seen"], "last_seen")
    parse_timestamp(document["last_observed_at"], "last_observed_at")
    if not isinstance(document["self_heal_attempted"], bool):
        raise MonitorError("incident self-heal marker is malformed")
    if not re.fullmatch(r"[0-9a-f]{64}", str(document["last_evidence_sha256"])):
        raise MonitorError("incident evidence hash is malformed")
    return document


def render_incident(document: dict[str, Any]) -> str:
    validate_incident(document)
    payload = json.dumps(document, sort_keys=True, separators=(",", ":"))
    return (
        "## OCI production anomaly\n\n"
        f"- Service: `{document['service']}`\n"
        f"- Type: `{document['anomaly_type']}`\n"
        f"- Deployment: `{document['deployment_sha']}` "
        f"(run `{document['deployment_run_id']}`)\n"
        f"- State: `{document['status']}`\n"
        f"- Confirmations: `{document['consecutive_observations']}`\n\n"
        "Repair sessions must acquire and register the repository work lease. "
        "Do not access production credentials; all mutations must use reviewed "
        "exact-SHA workflows. Authentication, data/schema, dependency, DNS, IAM, "
        "infrastructure, and provenance changes are never eligible for automatic merge.\n\n"
        f"<!-- {INCIDENT_MARKER}\n{payload}\n-->\n"
    )


def parse_incident(body: Any) -> dict[str, Any]:
    if not isinstance(body, str):
        raise MonitorError("incident body is missing")
    pattern = re.compile(
        rf"<!-- {re.escape(INCIDENT_MARKER)}\n(?P<payload>[^\n]+)\n-->"
    )
    matches = list(pattern.finditer(body))
    if len(matches) != 1:
        raise MonitorError("incident must contain exactly one machine payload")
    try:
        payload = json.loads(matches[0].group("payload"))
    except json.JSONDecodeError as error:
        raise MonitorError("incident payload is invalid JSON") from error
    if not isinstance(payload, dict):
        raise MonitorError("incident payload is not an object")
    return validate_incident(payload)


@dataclass
class Incident:
    issue: dict[str, Any]
    document: dict[str, Any]


class IncidentManager:
    def __init__(self, gh: GhApi, now: dt.datetime | None = None):
        self.gh = gh
        self.now = (now or utc_now()).astimezone(dt.timezone.utc).replace(microsecond=0)

    def open_incidents(self) -> list[Incident]:
        result: list[Incident] = []
        seen: set[str] = set()
        for issue in self.gh.list_incidents():
            number = exact_int(issue.get("number"), "incident issue number")
            document = parse_incident(issue.get("body"))
            if document["incident_issue"] != number:
                raise MonitorError(f"incident #{number} has a mismatched identity")
            fingerprint = document["fingerprint"]
            if fingerprint in seen:
                raise MonitorError("duplicate open incident fingerprint")
            seen.add(fingerprint)
            result.append(Incident(issue, document))
        return result

    def _update(
        self,
        incident: Incident,
        document: dict[str, Any],
        *,
        state: str | None = None,
    ) -> Incident:
        validate_incident(document)
        current = [
            item
            for item in self.gh.list_incidents()
            if item.get("number") == incident.issue.get("number")
        ]
        if len(current) != 1 or current[0].get("body") != incident.issue.get("body"):
            raise MonitorError("incident changed before compare-and-update")
        updated = self.gh.update_issue(
            document["incident_issue"], render_incident(document), state=state
        )
        return Incident(updated, document)

    def observe(
        self,
        snapshot: dict[str, Any],
        mode: str,
        ownership_blocked: bool,
        *,
        minimum_confirmations: int = 2,
        stabilization_seconds: int = 1800,
        maximum_gap_seconds: int = 1800,
        healthy_confirmations: int = 3,
    ) -> list[Incident]:
        if mode not in MODES:
            raise MonitorError("monitor mode is unsupported")
        if mode != "observation":
            raise MonitorError(
                "incident ownership is disabled during observation-only rollout"
            )
        if not 2 <= minimum_confirmations <= 10:
            raise MonitorError("minimum confirmations must be between 2 and 10")
        if not 300 <= stabilization_seconds <= 86400:
            raise MonitorError("stabilization window is outside its supported range")
        monitor_run_id = exact_int(snapshot["monitor_run_id"], "monitor run ID")
        monitor_run_attempt = exact_int(
            snapshot["monitor_run_attempt"], "monitor run attempt"
        )
        observed_at = parse_timestamp(snapshot["observed_at"], "observed_at")
        deployment = snapshot["deployment"]
        deployment_age = (
            observed_at
            - parse_timestamp(deployment["completed_at"], "deployment completed_at")
        ).total_seconds()
        anomalies = classify(snapshot, self.now)
        self.gh.ensure_label(
            INCIDENT_LABEL,
            "d93f0b",
            "Deduplicated evidence from the OCI production monitor",
        )
        open_incidents = self.open_incidents()
        by_fingerprint = {
            incident.document["fingerprint"]: incident for incident in open_incidents
        }
        seen: set[str] = set()
        results: list[Incident] = []
        for finding in anomalies:
            fingerprint = finding["fingerprint"]
            seen.add(fingerprint)
            evidence_payload = {
                "schema": "betstan.production-monitor.evidence.v1",
                "observed_at": snapshot["observed_at"],
                "monitor_run_id": monitor_run_id,
                "deployment_sha": deployment["sha"],
                "finding": finding,
            }
            evidence_json = json.dumps(
                evidence_payload, sort_keys=True, separators=(",", ":")
            )
            evidence_hash = hashlib.sha256(evidence_json.encode()).hexdigest()
            current = by_fingerprint.get(fingerprint)
            if current is None:
                document = {
                    "schema": INCIDENT_SCHEMA,
                    "incident_issue": 0,
                    "fingerprint": fingerprint,
                    "deployment_sha": deployment["sha"],
                    "deployment_run_id": deployment["run_id"],
                    "originating_pr": deployment["originating_pr"],
                    "service": finding["service"],
                    "anomaly_type": finding["type"],
                    "severity": finding["severity"],
                    "automation_class": finding["automation_class"],
                    "first_seen": snapshot["observed_at"],
                    "last_seen": snapshot["observed_at"],
                    "last_observed_at": snapshot["observed_at"],
                    "last_monitor_run_id": monitor_run_id,
                    "last_monitor_run_attempt": monitor_run_attempt,
                    "consecutive_observations": 1,
                    "total_observations": 1,
                    "healthy_observations": 0,
                    "status": "observing",
                    "lease_issue": 0,
                    "repair_attempts": 0,
                    "self_heal_attempted": False,
                    "last_evidence_sha256": evidence_hash,
                }
                created = self.gh.create_issue(
                    "[OCI production] "
                    f"{finding['service']} {finding['type']} "
                    f"{deployment['sha'][:12]}",
                    render_incident(document),
                )
                document["incident_issue"] = exact_int(
                    created.get("number"), "created incident number"
                )
                updated = self.gh.update_issue(
                    document["incident_issue"], render_incident(document)
                )
                current = Incident(updated, document)
            else:
                document = dict(current.document)
                incoming_run = (monitor_run_id, monitor_run_attempt)
                previous_run = (
                    document["last_monitor_run_id"],
                    document["last_monitor_run_attempt"],
                )
                if incoming_run == previous_run:
                    if document["last_evidence_sha256"] != evidence_hash:
                        raise MonitorError(
                            "replayed monitor identity contains different evidence"
                        )
                    results.append(current)
                    continue
                if incoming_run < previous_run or observed_at <= parse_timestamp(
                    document["last_observed_at"], "incident last_observed_at"
                ):
                    raise MonitorError("monitor observation arrived out of order")
                if document["deployment_run_id"] != deployment["run_id"]:
                    if document["status"] not in {"observing", "claimable"}:
                        raise MonitorError(
                            "deployment changed while an incident was owned"
                        )
                    document.update(
                        {
                            "deployment_run_id": deployment["run_id"],
                            "originating_pr": deployment["originating_pr"],
                            "first_seen": snapshot["observed_at"],
                            "consecutive_observations": 0,
                            "total_observations": 0,
                            "healthy_observations": 0,
                            "status": "observing",
                        }
                    )
                gap = (
                    observed_at
                    - parse_timestamp(document["last_seen"], "incident last_seen")
                ).total_seconds()
                document["last_seen"] = snapshot["observed_at"]
                document["last_observed_at"] = snapshot["observed_at"]
                document["last_monitor_run_id"] = monitor_run_id
                document["last_monitor_run_attempt"] = monitor_run_attempt
                document["total_observations"] += 1
                document["consecutive_observations"] = (
                    document["consecutive_observations"] + 1
                    if 0 <= gap <= maximum_gap_seconds
                    else 1
                )
                document["healthy_observations"] = 0
                document["last_evidence_sha256"] = evidence_hash
                current = self._update(current, document)
            document = dict(current.document)
            if (
                document["status"] == "observing"
                and MODES[mode] >= MODES["ownership"]
                and document["consecutive_observations"] >= minimum_confirmations
                and deployment_age >= stabilization_seconds
                and not ownership_blocked
                and document["repair_attempts"] == 0
            ):
                document["status"] = "claimable"
                current = self._update(current, document)
            self.gh.comment(
                document["incident_issue"],
                "### Monitor evidence\n\n"
                f"`sha256:{evidence_hash}`\n\n"
                f"```json\n{evidence_json[:12000]}\n```",
            )
            results.append(current)
        for current in open_incidents:
            document = current.document
            if document["deployment_sha"] != deployment["sha"]:
                if document["status"] in {"observing", "claimable"}:
                    superseded = dict(document)
                    superseded["status"] = "superseded"
                    superseded["last_observed_at"] = snapshot["observed_at"]
                    superseded["last_monitor_run_id"] = monitor_run_id
                    superseded["last_monitor_run_attempt"] = monitor_run_attempt
                    self._update(current, superseded, state="closed")
                continue
            if (
                document["fingerprint"] in seen
                or document["status"]
                not in {"observing", "claimable"}
            ):
                continue
            incoming_run = (monitor_run_id, monitor_run_attempt)
            previous_run = (
                document["last_monitor_run_id"],
                document["last_monitor_run_attempt"],
            )
            if incoming_run == previous_run:
                continue
            if incoming_run < previous_run or observed_at <= parse_timestamp(
                document["last_observed_at"], "incident last_observed_at"
            ):
                raise MonitorError("healthy observation arrived out of order")
            updated_document = dict(document)
            updated_document["healthy_observations"] += 1
            updated_document["last_observed_at"] = snapshot["observed_at"]
            updated_document["last_monitor_run_id"] = monitor_run_id
            updated_document["last_monitor_run_attempt"] = monitor_run_attempt
            if updated_document["healthy_observations"] >= healthy_confirmations:
                updated_document["status"] = "resolved"
                self._update(
                    current,
                    updated_document,
                    state="closed",
                )
            else:
                self._update(current, updated_document)
        return results

    def find(self, issue_number: int, fingerprint: str) -> Incident:
        matches = [
            incident
            for incident in self.open_incidents()
            if incident.issue.get("number") == issue_number
            and incident.document["fingerprint"] == fingerprint
        ]
        if len(matches) != 1:
            raise MonitorError("claimed incident identity is missing or ambiguous")
        return matches[0]

    def verify_claim(self, issue_number: int, fingerprint: str) -> Incident:
        raise MonitorError("repair ownership is disabled during observation-only rollout")

    def claim(
        self, issue_number: int, fingerprint: str, lease_issue: int
    ) -> Incident:
        raise MonitorError("repair ownership is disabled during observation-only rollout")

    def update_status(
        self,
        issue_number: int,
        fingerprint: str,
        status: str,
        *,
        increment_repair: bool = False,
        self_heal_attempted: bool = False,
    ) -> Incident:
        raise MonitorError("repair mutation is disabled during observation-only rollout")


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MonitorError(f"{path} is not readable JSON") from error
    if not isinstance(value, dict):
        raise MonitorError(f"{path} does not contain a JSON object")
    return value


def cli_parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)

    resolve = commands.add_parser("resolve-deployment")
    resolve.add_argument("--repository", default=REPOSITORY)
    resolve.add_argument("--artifact-dir", required=True, type=Path)
    resolve.add_argument("--output", required=True, type=Path)

    collect = commands.add_parser("collect")
    collect.add_argument("--deployment", required=True, type=Path)
    collect.add_argument("--namespace", required=True)
    collect.add_argument("--monitor-run-id", required=True, type=int)
    collect.add_argument("--monitor-run-attempt", required=True, type=int)
    collect.add_argument("--output", required=True, type=Path)

    classify_command = commands.add_parser("classify")
    classify_command.add_argument("--snapshot", required=True, type=Path)
    classify_command.add_argument("--output", required=True, type=Path)

    observe = commands.add_parser("observe")
    observe.add_argument("--snapshot", required=True, type=Path)
    observe.add_argument("--repository", default=REPOSITORY)
    observe.add_argument("--mode", required=True, choices=MODES)
    observe.add_argument("--ownership-blocked", action="store_true")
    observe.add_argument("--claim-output", required=True, type=Path)

    for name in ("verify-claim", "claim", "set-status"):
        command = commands.add_parser(name)
        command.add_argument("--repository", default=REPOSITORY)
        command.add_argument("--issue", required=True, type=int)
        command.add_argument("--fingerprint", required=True)
        if name == "claim":
            command.add_argument("--lease-issue", required=True, type=int)
        if name == "set-status":
            command.add_argument("--status", required=True, choices=INCIDENT_STATUSES)
            command.add_argument("--increment-repair", action="store_true")
            command.add_argument("--self-heal-attempted", action="store_true")
    return root


def main() -> int:
    args = cli_parser().parse_args()
    try:
        if args.command == "resolve-deployment":
            deployment = resolve_deployment(args.repository, args.artifact_dir)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(deployment, sort_keys=True) + "\n", encoding="utf-8"
            )
            print(
                "production_monitor_deployment=PASS "
                f"sha={deployment['sha']} run_id={deployment['run_id']}"
            )
        elif args.command == "collect":
            snapshot = collect_snapshot(
                load_json(args.deployment),
                args.namespace,
                args.monitor_run_id,
                args.monitor_run_attempt,
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(snapshot, sort_keys=True) + "\n", encoding="utf-8"
            )
            print("production_monitor_collect=PASS")
        elif args.command == "classify":
            findings = classify(load_json(args.snapshot))
            args.output.write_text(
                json.dumps(findings, sort_keys=True) + "\n", encoding="utf-8"
            )
            print(f"production_monitor_classify=PASS anomalies={len(findings)}")
        elif args.command == "observe":
            manager = IncidentManager(GhApi(args.repository))
            incidents = manager.observe(
                load_json(args.snapshot), args.mode, args.ownership_blocked
            )
            claimable = sorted(
                (
                    incident.document
                    for incident in incidents
                    if incident.document["status"] == "claimable"
                ),
                key=lambda document: (
                    SEVERITY_ORDER[document["severity"]],
                    document["incident_issue"],
                ),
            )
            args.claim_output.parent.mkdir(parents=True, exist_ok=True)
            args.claim_output.write_text(
                (json.dumps(claimable[0], sort_keys=True) + "\n")
                if claimable
                else "",
                encoding="utf-8",
            )
            print(
                "production_monitor_observe=PASS "
                f"anomalies={len(incidents)} claimable={len(claimable)}"
            )
        else:
            manager = IncidentManager(GhApi(args.repository))
            if args.command == "verify-claim":
                incident = manager.verify_claim(args.issue, args.fingerprint)
            elif args.command == "claim":
                incident = manager.claim(
                    args.issue, args.fingerprint, args.lease_issue
                )
            elif args.command == "set-status":
                incident = manager.update_status(
                    args.issue,
                    args.fingerprint,
                    args.status,
                    increment_repair=args.increment_repair,
                    self_heal_attempted=args.self_heal_attempted,
                )
            else:
                raise MonitorError("unsupported monitor command")
            print(json.dumps(incident.document, sort_keys=True))
            print(f"production_monitor_incident=PASS action={args.command}")
    except MonitorError as error:
        print(f"production_monitor=FAIL reason={error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
