#!/usr/bin/env python3

import datetime as dt
import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

from activity import classify as classify_activity
from contracts import ACTIVE_RELEASE_SCHEMA, ENVIRONMENT, canonical_json, load_policy, timestamp
from detector import build_observation, validate_artifact


ROOT = Path(__file__).resolve().parent
POLICY = load_policy(ROOT / "policy-v1.json")
NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
SHA = "a" * 40
IMAGE_DIGESTS = {
    service: "sha256:" + character * 64
    for service, character in zip(
        (
            "auth",
            "backoffice",
            "bet",
            "client",
            "event",
            "gamemaster",
            "moderation",
            "resulting",
            "slip",
        ),
        "bcdef0123",
    )
}


def release():
    return {
        "schema": ACTIVE_RELEASE_SCHEMA,
        "environment": ENVIRONMENT,
        "generation": 1,
        "source_sha": SHA,
        "workflow_path": ".github/workflows/oci-production-deploy.yml",
        "run_id": 10,
        "run_attempt": 1,
        "infrastructure_run_id": 9,
        "image_digests": IMAGE_DIGESTS,
        "infrastructure_fingerprint_sha256": "c" * 64,
        "validated_at": timestamp(NOW),
        "state": "active",
    }


def operation(phase="deploying"):
    return {
        "schema": "betstan.production-operation.v1",
        "environment": ENVIRONMENT,
        "generation": 2,
        "operation_id": "repair-42-1",
        "repair_id": "incident-42-1",
        "workflow_path": ".github/workflows/oci-production-repair-deploy.yml",
        "run_id": 20,
        "run_attempt": 1,
        "control_sha": SHA,
        "target_sha": SHA,
        "phase": phase,
        "expected_transient_codes": POLICY["maintenance"][
            ".github/workflows/oci-production-repair-deploy.yml"
        ][phase],
        "heartbeat_at": timestamp(NOW),
        "expires_at": timestamp(NOW + dt.timedelta(minutes=30)),
        "state": "active",
    }


def public(valid=True):
    names = (
        "canonical-home",
        "auth-currentuser",
        "event-api",
        "slip-api",
        "bet-api",
        "bet-stats-api",
        "backoffice-boundary",
        "www-redirect",
        "diagnostic-auth",
    )
    return {
        "schema": "betstan.public-health.v1",
        "checks": {
            name: {
                "valid": valid,
                "status": 200 if name != "backoffice-boundary" else 401,
                "latency_ms": 20,
                "content_type": "application/json",
                "location": "https://betstan.xyz/" if name == "www-redirect" else "",
                "body_kind": "json",
                "body_sha256": "d" * 64,
                "body_length": 10,
                "error": "",
            }
            for name in names
        },
    }


def deep(active_operation=None, client_ready=True):
    return {
        "schema": "betstan.deep-health.v1",
        "observed_at": timestamp(NOW),
        "status": "ok",
        "errors": [],
        "active_release": release(),
        "production_operation": active_operation,
        "kubernetes": {
            "node": {
                "count": 1,
                "architecture": "arm64",
                "ready": True,
                "memory_pressure": False,
                "disk_pressure": False,
                "pid_pressure": False,
                "cpu_percent": 20,
                "memory_percent": 30,
            },
            "workloads": [
                *[
                    {
                        "name": f"gaming-{service}-depl",
                        "desired": 1,
                        "ready": 1 if service != "client" or client_ready else 0,
                    }
                    for service in IMAGE_DIGESTS
                ],
                {"name": "gaming-auth-mongo-depl", "desired": 1, "ready": 1},
                {"name": "gaming-rabbitmq-depl", "desired": 1, "ready": 1},
                {"name": "betstan-monitor-exporter", "desired": 1, "ready": 1},
                {"name": "betstan-monitor-repair", "desired": 1, "ready": 1},
            ],
            "pods": [
                {
                    "name": "gaming-client-pod",
                    "service": "client",
                    "reason": "",
                    "restart_count": 0,
                    "restart_delta": 0,
                    "digest_match": True,
                }
            ],
            "endpoints": [
                *[
                    {
                        "name": f"gaming-{service}-srv",
                        "service": service,
                        "ready": True,
                    }
                    for service in IMAGE_DIGESTS
                ],
                {"name": "gaming-auth-mongo-srv", "service": "platform", "ready": True},
                {"name": "gaming-shared-mongo-srv", "service": "platform", "ready": True},
                {"name": "gaming-rabbitmq-srv", "service": "platform", "ready": True},
            ],
            "certificates": [
                {"name": "betstan-oci-canonical-tls", "ready": True, "days_remaining": 80}
            ],
        },
        "mongo": {"ready": True, "status": "ok"},
        "rabbitmq": {"ready": True, "status": "ok", "queue_count": 22, "backlog": 0},
    }


def idle():
    return {
        "classification": "idle",
        "workflow_path": "",
        "run_id": 0,
        "run_attempt": 0,
        "control_sha": "",
        "target_sha": "",
        "phase": "",
        "repair_id": "",
        "expected_transient_codes": [],
    }


class DetectorTest(unittest.TestCase):
    def build(
        self,
        directory: Path,
        *,
        deep_document,
        activity_document=None,
        baselines=None,
    ):
        public_path = directory / "public.json"
        deep_path = directory / "deep.json"
        activity_path = directory / "activity.json"
        output = directory / "observation.json"
        public_path.write_text(canonical_json(public()), encoding="utf-8")
        deep_path.write_text(canonical_json(deep_document), encoding="utf-8")
        activity_path.write_text(
            canonical_json(activity_document or idle()), encoding="utf-8"
        )
        args = Namespace(
            policy=str(ROOT / "policy-v1.json"),
            public=str(public_path),
            deep=str(deep_path),
            activity=str(activity_path),
            baselines=str(baselines) if baselines else None,
            monitor_run_id="30",
            monitor_run_attempt="1",
            source_sha=SHA,
            observed_at=timestamp(NOW),
            output=str(output),
        )
        return build_observation(args)

    def test_healthy_deep_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            document = self.build(Path(directory), deep_document=deep())
        self.assertEqual("healthy", document["status"])

    def test_expected_deploy_transient_is_maintenance(self):
        active_operation = operation()
        runs = [
            {
                "id": 20,
                "run_attempt": 1,
                "path": active_operation["workflow_path"],
                "status": "in_progress",
                "head_branch": "master",
                "head_sha": SHA,
            }
        ]
        activity = classify_activity(runs, active_operation, POLICY)
        with tempfile.TemporaryDirectory() as directory:
            document = self.build(
                Path(directory),
                deep_document=deep(active_operation, client_ready=False),
                activity_document=activity,
            )
        self.assertEqual("maintenance", document["status"])
        self.assertEqual("maintenance", document["anomalies"][0]["classification"])

    def test_orphaned_active_operation_is_an_immediate_mismatch(self):
        active_operation = operation()
        with tempfile.TemporaryDirectory() as directory:
            document = self.build(
                Path(directory),
                deep_document=deep(active_operation),
                activity_document=idle(),
            )
        mismatch = next(
            item
            for item in document["anomalies"]
            if item["code"] == "production-operation-mismatch"
        )
        self.assertEqual("anomaly", mismatch["classification"])
        self.assertEqual("anomalous", document["status"])

    def test_expired_operation_never_grants_maintenance(self):
        active_operation = operation()
        active_operation.update(
            {
                "heartbeat_at": timestamp(NOW - dt.timedelta(hours=2)),
                "expires_at": timestamp(NOW - dt.timedelta(minutes=1)),
            }
        )
        activity = classify_activity(
            [
                {
                    "id": active_operation["run_id"],
                    "run_attempt": 1,
                    "path": active_operation["workflow_path"],
                    "status": "in_progress",
                    "head_branch": "master",
                    "head_sha": active_operation["control_sha"],
                }
            ],
            active_operation,
            POLICY,
        )
        with tempfile.TemporaryDirectory() as directory:
            document = self.build(
                Path(directory),
                deep_document=deep(active_operation, client_ready=False),
                activity_document=activity,
            )
        findings = {item["code"]: item for item in document["anomalies"]}
        self.assertEqual(
            "anomaly",
            findings["production-operation-stale"]["classification"],
        )
        self.assertEqual("anomaly", findings["workload-not-ready"]["classification"])
        self.assertEqual("anomalous", document["status"])

    def test_rollback_activity_binds_control_sha_not_serving_release(self):
        active_operation = operation()
        active_operation.update(
            {
                "workflow_path": ".github/workflows/oci-production-rollback.yml",
                "control_sha": "d" * 40,
                "target_sha": "e" * 40,
                "phase": "rolling-back",
                "expected_transient_codes": POLICY["maintenance"][
                    ".github/workflows/oci-production-rollback.yml"
                ]["rolling-back"],
            }
        )
        activity = classify_activity(
            [
                {
                    "id": active_operation["run_id"],
                    "run_attempt": 1,
                    "path": active_operation["workflow_path"],
                    "status": "in_progress",
                    "head_branch": "master",
                    "head_sha": active_operation["control_sha"],
                }
            ],
            active_operation,
            POLICY,
        )
        self.assertEqual("mutating-production", activity["classification"])
        self.assertEqual("d" * 40, activity["control_sha"])
        self.assertEqual("e" * 40, activity["target_sha"])

    def test_structural_drift_is_never_maintenance(self):
        document = deep(operation())
        document["kubernetes"]["pods"][0]["digest_match"] = False
        runs = [
            {
                "id": 20,
                "run_attempt": 1,
                "path": ".github/workflows/oci-production-repair-deploy.yml",
                "status": "in_progress",
                "head_branch": "master",
                "head_sha": SHA,
            }
        ]
        activity = classify_activity(runs, document["production_operation"], POLICY)
        with tempfile.TemporaryDirectory() as directory:
            result = self.build(
                Path(directory), deep_document=document, activity_document=activity
            )
        drift = next(item for item in result["anomalies"] if item["code"] == "image-digest-drift")
        self.assertEqual("anomaly", drift["classification"])
        self.assertEqual("anomalous", result["status"])

    def test_queued_run_does_not_create_maintenance(self):
        runs = [
            {
                "id": 21,
                "run_attempt": 1,
                "path": ".github/workflows/oci-production-repair-deploy.yml",
                "status": "queued",
                "head_branch": "master",
                "head_sha": SHA,
            }
        ]
        activity = classify_activity(runs, None, POLICY)
        self.assertEqual("queued-production", activity["classification"])
        with tempfile.TemporaryDirectory() as directory:
            result = self.build(
                Path(directory),
                deep_document=deep(None, client_ready=False),
                activity_document=activity,
            )
        self.assertEqual("anomalous", result["status"])

    def test_restart_delta_uses_previous_trusted_observation(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            baseline_directory = directory / "baselines"
            baseline_directory.mkdir()
            previous_deep = deep()
            previous_deep["kubernetes"]["pods"][0]["restart_count"] = 2
            previous = self.build(directory, deep_document=previous_deep)
            (baseline_directory / "previous.json").write_text(
                canonical_json(previous), encoding="utf-8"
            )
            current_deep = deep()
            current_deep["kubernetes"]["pods"][0]["restart_count"] = 3
            current = self.build(
                directory,
                deep_document=current_deep,
                baselines=baseline_directory,
            )
        restart = next(
            item for item in current["anomalies"] if item["code"] == "pod-restart-delta"
        )
        self.assertEqual(1, restart["evidence"]["delta"])

    def test_artifact_rejects_extra_file(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            document = self.build(directory, deep_document=deep())
            artifact = directory / "artifact"
            artifact.mkdir()
            observation = artifact / "observation.json"
            observation.write_text(canonical_json(document) + "\n", encoding="utf-8")
            checksum = __import__("hashlib").sha256(observation.read_bytes()).hexdigest()
            (artifact / "SHA256SUMS").write_text(
                f"{checksum}  observation.json\n", encoding="ascii"
            )
            validate_artifact(artifact, ROOT / "policy-v1.json")
            (artifact / "unexpected").write_text("x", encoding="ascii")
            with self.assertRaisesRegex(Exception, "file set"):
                validate_artifact(artifact, ROOT / "policy-v1.json")


if __name__ == "__main__":
    unittest.main()
