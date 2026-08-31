#!/usr/bin/env python3
"""CAS-backed active-release and production-operation ConfigMap state."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from contracts import (
    ACTIVE_RELEASE_SCHEMA,
    ENVIRONMENT,
    OPERATION_SCHEMA,
    ContractError,
    canonical_json,
    load_policy,
    parse_timestamp,
    timestamp,
    utc_now,
    validate_active_release,
    validate_operation,
)


ACTIVE_RELEASE_CONFIGMAP = "betstan-active-release-v1"
PRODUCTION_OPERATION_CONFIGMAP = "betstan-production-operation-v1"
CONFIGMAP_KEY = "record.json"
RESUMABLE_OPERATION_WORKFLOWS = {
    ".github/workflows/oci-ghcr-cache-recovery.yml",
}


def new_operation(
    *,
    previous: dict[str, Any] | None,
    operation_id: str,
    repair_id: str,
    workflow_path: str,
    run_id: int,
    run_attempt: int,
    control_sha: str,
    target_sha: str,
    phase: str,
    lease_seconds: int,
    now: dt.datetime,
    policy: dict[str, Any],
    superseded_run_id: int = 0,
) -> dict[str, Any]:
    if run_attempt != 1:
        raise ContractError("production operation must be first-attempt")
    if superseded_run_id < 0:
        raise ContractError("superseded production run ID must not be negative")
    if superseded_run_id > 0 and workflow_path not in RESUMABLE_OPERATION_WORKFLOWS:
        raise ContractError("production workflow does not support operation ownership transfer")
    if lease_seconds < 300 or lease_seconds > 14400:
        raise ContractError("production operation lease must be 300-14400 seconds")
    generation = 1
    if previous is not None:
        validate_operation(previous, policy)
        generation = previous["generation"] + 1
        if previous["state"] == "active":
            expires = parse_timestamp(previous["expires_at"], "operation expires_at")
            same_owner = (
                previous["operation_id"] == operation_id
                and previous["workflow_path"] == workflow_path
                and previous["run_id"] == run_id
                and previous["run_attempt"] == run_attempt
                and previous["control_sha"] == control_sha
                and previous["target_sha"] == target_sha
            )
            supersedes_terminal_run = (
                superseded_run_id > 0
                and previous["workflow_path"] == workflow_path
                and previous["run_id"] == superseded_run_id
                and previous["run_attempt"] == 1
            )
            if expires > now and not same_owner and not supersedes_terminal_run:
                raise ContractError("another unexpired production operation owns the control plane")
    maintenance = policy["maintenance"].get(workflow_path)
    if maintenance is None or phase not in maintenance:
        raise ContractError("operation phase has no reviewed maintenance policy")
    document = {
        "schema": OPERATION_SCHEMA,
        "environment": ENVIRONMENT,
        "generation": generation,
        "operation_id": operation_id,
        "repair_id": repair_id,
        "workflow_path": workflow_path,
        "run_id": run_id,
        "run_attempt": run_attempt,
        "control_sha": control_sha,
        "target_sha": target_sha,
        "phase": phase,
        "expected_transient_codes": maintenance[phase],
        "heartbeat_at": timestamp(now),
        "expires_at": timestamp(now + dt.timedelta(seconds=lease_seconds)),
        "state": "active",
    }
    return validate_operation(document, policy)


def advance_operation(
    previous: dict[str, Any],
    *,
    operation_id: str,
    workflow_path: str,
    run_id: int,
    run_attempt: int,
    control_sha: str,
    target_sha: str,
    phase: str,
    lease_seconds: int,
    now: dt.datetime,
    policy: dict[str, Any],
) -> dict[str, Any]:
    current = validate_operation(previous, policy)
    expected = {
        "operation_id": operation_id,
        "workflow_path": workflow_path,
        "run_id": run_id,
        "run_attempt": run_attempt,
        "control_sha": control_sha,
        "target_sha": target_sha,
    }
    for field, value in expected.items():
        if current[field] != value:
            raise ContractError(f"production operation ownership changed: {field}")
    if current["state"] != "active":
        raise ContractError("production operation is already terminal")
    return new_operation(
        previous=current,
        operation_id=operation_id,
        repair_id=current["repair_id"],
        workflow_path=workflow_path,
        run_id=run_id,
        run_attempt=run_attempt,
        control_sha=control_sha,
        target_sha=target_sha,
        phase=phase,
        lease_seconds=lease_seconds,
        now=now,
        policy=policy,
    )


def finish_operation(
    previous: dict[str, Any],
    *,
    operation_id: str,
    workflow_path: str,
    run_id: int,
    run_attempt: int,
    control_sha: str,
    target_sha: str,
    succeeded: bool,
    now: dt.datetime,
    policy: dict[str, Any],
) -> dict[str, Any]:
    current = validate_operation(previous, policy)
    expected = {
        "operation_id": operation_id,
        "workflow_path": workflow_path,
        "run_id": run_id,
        "run_attempt": run_attempt,
        "control_sha": control_sha,
        "target_sha": target_sha,
    }
    for field, value in expected.items():
        if current[field] != value:
            raise ContractError(f"production operation ownership changed: {field}")
    if current["state"] != "active":
        raise ContractError("production operation is already terminal")
    state = "succeeded" if succeeded else "failed"
    updated = dict(current)
    updated.update(
        {
            "generation": current["generation"] + 1,
            "phase": state,
            "expected_transient_codes": [],
            "heartbeat_at": timestamp(now),
            "expires_at": timestamp(now + dt.timedelta(minutes=5)),
            "state": state,
        }
    )
    return validate_operation(updated, policy)


def image_digests(path: Path) -> dict[str, str]:
    expected = {
        "auth",
        "bet",
        "backoffice",
        "client",
        "event",
        "gamemaster",
        "moderation",
        "resulting",
        "slip",
    }
    result: dict[str, str] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        fields = line.split("\t")
        if len(fields) != 5:
            raise ContractError(f"{path}:{line_number}: expected five image columns")
        service, _repository, _image_ref, digest, _platform_digest = fields
        if service in result or service not in expected:
            raise ContractError(f"{path}:{line_number}: invalid or duplicate service")
        result[service] = digest
    if set(result) != expected:
        raise ContractError("active release image evidence is incomplete")
    return result


def new_active_release(
    *,
    previous: dict[str, Any] | None,
    source_sha: str,
    workflow_path: str,
    run_id: int,
    run_attempt: int,
    infrastructure_run_id: int,
    images: dict[str, str],
    infrastructure_fingerprint_sha256: str,
    now: dt.datetime,
) -> dict[str, Any]:
    generation = 1
    if previous is not None:
        validate_active_release(previous)
        generation = previous["generation"] + 1
    document = {
        "schema": ACTIVE_RELEASE_SCHEMA,
        "environment": ENVIRONMENT,
        "generation": generation,
        "source_sha": source_sha,
        "workflow_path": workflow_path,
        "run_id": run_id,
        "run_attempt": run_attempt,
        "infrastructure_run_id": infrastructure_run_id,
        "image_digests": images,
        "infrastructure_fingerprint_sha256": infrastructure_fingerprint_sha256,
        "validated_at": timestamp(now),
        "state": "active",
    }
    return validate_active_release(document)


class ConfigMapStore:
    def __init__(self, namespace: str):
        self.namespace = namespace

    def read(self, name: str) -> tuple[dict[str, Any] | None, str | None]:
        result = subprocess.run(
            ["kubectl", "get", "configmap", name, "-n", self.namespace, "-o", "json"],
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            if "NotFound" in result.stderr or "not found" in result.stderr:
                return None, None
            raise ContractError(f"unable to read ConfigMap {name}")
        try:
            payload = json.loads(result.stdout)
            data = payload.get("data")
            if not isinstance(data, dict) or set(data) != {CONFIGMAP_KEY}:
                raise ContractError(f"ConfigMap {name} has an invalid data contract")
            document = json.loads(data[CONFIGMAP_KEY])
            resource_version = payload.get("metadata", {}).get("resourceVersion")
        except (json.JSONDecodeError, AttributeError) as error:
            raise ContractError(f"ConfigMap {name} is malformed") from error
        if not isinstance(resource_version, str) or not resource_version:
            raise ContractError(f"ConfigMap {name} has no resourceVersion")
        return document, resource_version

    def write(
        self,
        name: str,
        document: dict[str, Any],
        resource_version: str | None,
    ) -> None:
        metadata: dict[str, Any] = {
            "name": name,
            "namespace": self.namespace,
            "labels": {
                "app.kubernetes.io/part-of": "betstan",
                "app.kubernetes.io/managed-by": "production-monitor",
            },
        }
        if resource_version is not None:
            metadata["resourceVersion"] = resource_version
        payload = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": metadata,
            "immutable": False,
            "data": {CONFIGMAP_KEY: canonical_json(document)},
        }
        action = "replace" if resource_version is not None else "create"
        subprocess.run(
            ["kubectl", action, "-f", "-"],
            input=canonical_json(payload),
            text=True,
            check=True,
        )


def _common_operation_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--operation-id", required=True)
    parser.add_argument("--workflow-path", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--run-attempt", required=True, type=int)
    parser.add_argument("--control-sha")
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--output")


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    begin = commands.add_parser("begin-operation")
    _common_operation_arguments(begin)
    begin.add_argument("--repair-id", default="")
    begin.add_argument("--superseded-run-id", default=0, type=int)
    begin.add_argument("--phase", required=True)
    begin.add_argument("--lease-seconds", required=True, type=int)

    phase = commands.add_parser("advance-operation")
    _common_operation_arguments(phase)
    phase.add_argument("--phase", required=True)
    phase.add_argument("--lease-seconds", required=True, type=int)

    finish = commands.add_parser("finish-operation")
    _common_operation_arguments(finish)
    finish.add_argument("--result", choices=("succeeded", "failed"), required=True)

    release = commands.add_parser("publish-release")
    release.add_argument("--namespace", required=True)
    release.add_argument("--source-sha", required=True)
    release.add_argument("--workflow-path", required=True)
    release.add_argument("--run-id", required=True, type=int)
    release.add_argument("--run-attempt", required=True, type=int)
    release.add_argument("--infrastructure-run-id", required=True, type=int)
    release.add_argument("--images", required=True)
    release.add_argument("--infrastructure-fingerprint-sha256", required=True)
    release.add_argument("--output")

    read_release = commands.add_parser("read-release")
    read_release.add_argument("--namespace", required=True)
    read_release.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        store = ConfigMapStore(args.namespace)
        now = utc_now()
        if args.command == "read-release":
            document, _resource_version = store.read(ACTIVE_RELEASE_CONFIGMAP)
            if document is None:
                raise ContractError("active release ConfigMap does not exist")
            document = validate_active_release(document)
        elif args.command == "publish-release":
            previous, resource_version = store.read(ACTIVE_RELEASE_CONFIGMAP)
            document = new_active_release(
                previous=previous,
                source_sha=args.source_sha,
                workflow_path=args.workflow_path,
                run_id=args.run_id,
                run_attempt=args.run_attempt,
                infrastructure_run_id=args.infrastructure_run_id,
                images=image_digests(Path(args.images)),
                infrastructure_fingerprint_sha256=args.infrastructure_fingerprint_sha256,
                now=now,
            )
            store.write(ACTIVE_RELEASE_CONFIGMAP, document, resource_version)
        else:
            policy = load_policy(args.policy)
            previous, resource_version = store.read(PRODUCTION_OPERATION_CONFIGMAP)
            if args.command == "begin-operation":
                document = new_operation(
                    previous=previous,
                    operation_id=args.operation_id,
                    repair_id=args.repair_id,
                    workflow_path=args.workflow_path,
                    run_id=args.run_id,
                    run_attempt=args.run_attempt,
                    control_sha=args.control_sha or args.target_sha,
                    target_sha=args.target_sha,
                    phase=args.phase,
                    lease_seconds=args.lease_seconds,
                    now=now,
                    policy=policy,
                    superseded_run_id=args.superseded_run_id,
                )
            elif args.command == "advance-operation":
                if previous is None:
                    raise ContractError("production operation record is missing")
                document = advance_operation(
                    previous,
                    operation_id=args.operation_id,
                    workflow_path=args.workflow_path,
                    run_id=args.run_id,
                    run_attempt=args.run_attempt,
                    control_sha=args.control_sha or args.target_sha,
                    target_sha=args.target_sha,
                    phase=args.phase,
                    lease_seconds=args.lease_seconds,
                    now=now,
                    policy=policy,
                )
            else:
                if previous is None:
                    raise ContractError("production operation record is missing")
                document = finish_operation(
                    previous,
                    operation_id=args.operation_id,
                    workflow_path=args.workflow_path,
                    run_id=args.run_id,
                    run_attempt=args.run_attempt,
                    control_sha=args.control_sha or args.target_sha,
                    target_sha=args.target_sha,
                    succeeded=args.result == "succeeded",
                    now=now,
                    policy=policy,
                )
            store.write(PRODUCTION_OPERATION_CONFIGMAP, document, resource_version)
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(canonical_json(document) + "\n", encoding="utf-8")
        print(
            f"production_state=PASS command={args.command} generation={document['generation']}"
        )
    except (ContractError, OSError, subprocess.SubprocessError) as error:
        print(f"production_state=FAIL reason={error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
