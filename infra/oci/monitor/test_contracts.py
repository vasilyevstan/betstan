#!/usr/bin/env python3

import copy
import datetime as dt
import json
import unittest
from pathlib import Path

from contracts import (
    ACTIVE_RELEASE_SCHEMA,
    ENVIRONMENT,
    OBSERVATION_SCHEMA,
    ContractError,
    anomaly_key,
    document_sha256,
    incident_fingerprint,
    load_policy,
    timestamp,
    validate_active_release,
    validate_observation,
    validate_operation,
    validate_sanitized,
)
from state_machine import apply_failure, apply_healthy, new_incident, new_repair


ROOT = Path(__file__).resolve().parent
NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
IMAGE_DIGESTS = {
    service: DIGEST
    for service in (
        "auth",
        "backoffice",
        "bet",
        "client",
        "event",
        "gamemaster",
        "moderation",
        "resulting",
        "slip",
    )
}


def active_release():
    return {
        "schema": ACTIVE_RELEASE_SCHEMA,
        "environment": ENVIRONMENT,
        "generation": 1,
        "source_sha": SHA,
        "workflow_path": ".github/workflows/oci-production-deploy.yml",
        "run_id": 100,
        "run_attempt": 1,
        "infrastructure_run_id": 90,
        "image_digests": IMAGE_DIGESTS,
        "infrastructure_fingerprint_sha256": "c" * 64,
        "validated_at": timestamp(NOW),
        "state": "active",
    }


def activity():
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


def anomaly():
    return {
        "code": "public-home-failed",
        "service": "client",
        "severity": "high",
        "classification": "anomaly",
        "message": "canonical homepage failed its bounded probe",
        "evidence": {"status": 503},
    }


def observation(run_id: int, when: dt.datetime, anomalies=None, status=None):
    findings = list(anomalies or [])
    if status is None:
        status = "anomalous" if findings else "healthy"
    return {
        "schema": OBSERVATION_SCHEMA,
        "environment": ENVIRONMENT,
        "observed_at": timestamp(when),
        "monitor_run_id": run_id,
        "monitor_run_attempt": 1,
        "source_sha": SHA,
        "status": status,
        "baseline_status": "warming",
        "active_release": active_release(),
        "production_operation": None,
        "activity": activity(),
        "public": {"checks": []},
        "deep": {"available": True},
        "anomalies": findings,
    }


class MonitorContractsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy = load_policy(ROOT / "policy-v1.json")

    def test_policy_and_release_validate(self):
        self.assertEqual(2, self.policy["observation"]["confirm_failures"])
        self.assertEqual(SHA, validate_active_release(active_release())["source_sha"])

    def test_operation_requires_exact_reviewed_transients(self):
        operation = {
            "schema": "betstan.production-operation.v1",
            "environment": ENVIRONMENT,
            "generation": 3,
            "operation_id": "repair-42-1",
            "repair_id": "incident-42-1",
            "workflow_path": ".github/workflows/oci-production-repair-deploy.yml",
            "run_id": 300,
            "run_attempt": 1,
            "control_sha": SHA,
            "target_sha": SHA,
            "phase": "deploying",
            "expected_transient_codes": [
                "workload-not-ready",
                "service-endpoint-empty",
                "public-api-failed",
                "public-home-failed",
            ],
            "heartbeat_at": timestamp(NOW),
            "expires_at": timestamp(NOW + dt.timedelta(minutes=30)),
            "state": "active",
        }
        self.assertEqual("deploying", validate_operation(operation, self.policy)["phase"])
        operation["expected_transient_codes"].append("image-digest-drift")
        with self.assertRaisesRegex(ContractError, "differ from policy"):
            validate_operation(operation, self.policy)

    def test_observation_status_is_derived_from_findings(self):
        document = observation(200, NOW, [anomaly()])
        validate_observation(document, self.policy)
        document["status"] = "healthy"
        with self.assertRaisesRegex(ContractError, "does not match"):
            validate_observation(document, self.policy)

    def test_sanitizer_rejects_credentials_and_private_identity(self):
        with self.assertRaises(ContractError):
            validate_sanitized({"authorization": "redacted"})
        with self.assertRaises(ContractError):
            validate_sanitized({"message": "Bearer abc.def.ghi"})
        with self.assertRaises(ContractError):
            validate_sanitized({"message": "target 10.0.0.5"})

    def test_incident_hysteresis_and_recurrence(self):
        first_observation = observation(200, NOW, [anomaly()])
        first_hash = document_sha256(first_observation)
        incident = new_incident(anomaly(), first_observation, first_hash)
        self.assertEqual("observing", incident["status"])

        second_observation = observation(
            201, NOW + dt.timedelta(minutes=15), [anomaly()]
        )
        incident = apply_failure(
            incident,
            anomaly(),
            second_observation,
            document_sha256(second_observation),
            self.policy,
        )
        self.assertEqual("confirmed", incident["status"])

        for index in range(3):
            healthy = observation(
                202 + index, NOW + dt.timedelta(minutes=30 + index * 15)
            )
            incident = apply_healthy(
                incident, healthy, document_sha256(healthy), self.policy
            )
        self.assertEqual("resolved", incident["status"])

        recurrence_observation = observation(
            205, NOW + dt.timedelta(minutes=75), [anomaly()]
        )
        recurrence = apply_failure(
            incident,
            anomaly(),
            recurrence_observation,
            document_sha256(recurrence_observation),
            self.policy,
        )
        self.assertEqual(2, recurrence["episode"])
        self.assertEqual(
            incident_fingerprint(anomaly_key("client", "public-home-failed"), 2),
            recurrence["fingerprint"],
        )

    def test_unknown_observation_does_not_heal(self):
        failing = observation(200, NOW, [anomaly()])
        incident = new_incident(anomaly(), failing, document_sha256(failing))
        unknown = observation(
            201,
            NOW + dt.timedelta(minutes=15),
            [
                {
                    "code": "monitor-unknown",
                    "service": "platform",
                    "severity": "high",
                    "classification": "unknown",
                    "message": "deep health response is unavailable",
                    "evidence": {"reason": "timeout"},
                }
            ],
            "unknown",
        )
        with self.assertRaisesRegex(ContractError, "cannot heal"):
            apply_healthy(incident, unknown, document_sha256(unknown), self.policy)

    def test_repair_claim_is_bound_to_confirmed_incident(self):
        first = observation(200, NOW, [anomaly()])
        incident = new_incident(anomaly(), first, document_sha256(first))
        with self.assertRaisesRegex(ContractError, "confirmed"):
            new_repair(
                incident,
                owner="monitor-controller",
                base_sha=SHA,
                owned_paths=["client/**"],
                now=NOW,
                ttl_seconds=3600,
            )
        second = observation(201, NOW + dt.timedelta(minutes=15), [anomaly()])
        incident = apply_failure(
            incident, anomaly(), second, document_sha256(second), self.policy
        )
        incident["issue_number"] = 42
        repair = new_repair(
            incident,
            owner="monitor-controller",
            base_sha=SHA,
            owned_paths=["client/**"],
            now=NOW,
            ttl_seconds=3600,
        )
        self.assertEqual("dev", repair["base_branch"])
        self.assertEqual("claimed", repair["phase"])

    def test_schema_rejects_extra_fields(self):
        release = active_release()
        release["unexpected"] = True
        with self.assertRaisesRegex(ContractError, "extra"):
            validate_active_release(release)

    def test_canonical_hash_is_order_independent(self):
        self.assertEqual(
            document_sha256({"a": 1, "b": 2}),
            document_sha256(json.loads('{"b":2,"a":1}')),
        )


if __name__ == "__main__":
    unittest.main()
