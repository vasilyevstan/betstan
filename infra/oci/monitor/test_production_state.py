#!/usr/bin/env python3

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from contracts import ContractError, load_policy
from production_state import (
    CONFIGMAP_KEY,
    ConfigMapStore,
    advance_operation,
    finish_operation,
    image_digests,
    new_active_release,
    new_operation,
)


ROOT = Path(__file__).resolve().parent
POLICY = load_policy(ROOT / "policy-v1.json")
NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
SHA = "a" * 40


class ProductionStateTest(unittest.TestCase):
    def begin(self):
        return new_operation(
            previous=None,
            operation_id="repair-42-1",
            repair_id="incident-42-1",
            workflow_path=".github/workflows/oci-production-repair-deploy.yml",
            run_id=20,
            run_attempt=1,
            control_sha=SHA,
            target_sha=SHA,
            phase="deploying",
            lease_seconds=1800,
            now=NOW,
            policy=POLICY,
        )

    def test_operation_owner_and_phase_are_cas_bound(self):
        operation = self.begin()
        validating = advance_operation(
            operation,
            operation_id="repair-42-1",
            workflow_path=".github/workflows/oci-production-repair-deploy.yml",
            run_id=20,
            run_attempt=1,
            control_sha=SHA,
            target_sha=SHA,
            phase="validating",
            lease_seconds=900,
            now=NOW + dt.timedelta(minutes=5),
            policy=POLICY,
        )
        self.assertEqual(2, validating["generation"])
        self.assertEqual([], validating["expected_transient_codes"])
        finished = finish_operation(
            validating,
            operation_id="repair-42-1",
            workflow_path=".github/workflows/oci-production-repair-deploy.yml",
            run_id=20,
            run_attempt=1,
            control_sha=SHA,
            target_sha=SHA,
            succeeded=True,
            now=NOW + dt.timedelta(minutes=10),
            policy=POLICY,
        )
        self.assertEqual("succeeded", finished["state"])
        with self.assertRaisesRegex(ContractError, "terminal"):
            advance_operation(
                finished,
                operation_id="repair-42-1",
                workflow_path=".github/workflows/oci-production-repair-deploy.yml",
                run_id=20,
                run_attempt=1,
                control_sha=SHA,
                target_sha=SHA,
                phase="deploying",
                lease_seconds=900,
                now=NOW + dt.timedelta(minutes=15),
                policy=POLICY,
            )

    def test_unexpired_different_owner_is_rejected(self):
        with self.assertRaisesRegex(ContractError, "another unexpired"):
            new_operation(
                previous=self.begin(),
                operation_id="repair-99-1",
                repair_id="incident-99-1",
                workflow_path=".github/workflows/oci-production-repair-deploy.yml",
                run_id=21,
                run_attempt=1,
                control_sha=SHA,
                target_sha=SHA,
                phase="deploying",
                lease_seconds=1800,
                now=NOW + dt.timedelta(minutes=1),
                policy=POLICY,
            )

    def test_exact_terminal_recovery_run_can_transfer_ownership(self):
        previous = new_operation(
            previous=None,
            operation_id="ghcr-cache-recovery-50-1",
            repair_id="",
            workflow_path=".github/workflows/oci-ghcr-cache-recovery.yml",
            run_id=50,
            run_attempt=1,
            control_sha="d" * 40,
            target_sha="b" * 40,
            phase="rebinding",
            lease_seconds=14400,
            now=NOW,
            policy=POLICY,
        )
        resumed = new_operation(
            previous=previous,
            operation_id="ghcr-cache-recovery-51-1",
            repair_id="",
            workflow_path=".github/workflows/oci-ghcr-cache-recovery.yml",
            run_id=51,
            run_attempt=1,
            control_sha="e" * 40,
            target_sha="c" * 40,
            phase="rebinding",
            lease_seconds=14400,
            now=NOW + dt.timedelta(minutes=1),
            policy=POLICY,
            superseded_run_id=50,
        )
        self.assertEqual(2, resumed["generation"])
        self.assertEqual(51, resumed["run_id"])

    def test_recovery_cannot_transfer_a_different_active_owner(self):
        previous = new_operation(
            previous=None,
            operation_id="ghcr-cache-recovery-50-1",
            repair_id="",
            workflow_path=".github/workflows/oci-ghcr-cache-recovery.yml",
            run_id=50,
            run_attempt=1,
            control_sha="d" * 40,
            target_sha="b" * 40,
            phase="rebinding",
            lease_seconds=14400,
            now=NOW,
            policy=POLICY,
        )
        with self.assertRaisesRegex(ContractError, "another unexpired"):
            new_operation(
                previous=previous,
                operation_id="ghcr-cache-recovery-51-1",
                repair_id="",
                workflow_path=".github/workflows/oci-ghcr-cache-recovery.yml",
                run_id=51,
                run_attempt=1,
                control_sha="e" * 40,
                target_sha="c" * 40,
                phase="rebinding",
                lease_seconds=14400,
                now=NOW + dt.timedelta(minutes=1),
                policy=POLICY,
                superseded_run_id=49,
            )

    def test_non_recovery_workflow_cannot_transfer_operation_ownership(self):
        with self.assertRaisesRegex(ContractError, "does not support"):
            new_operation(
                previous=self.begin(),
                operation_id="repair-99-1",
                repair_id="incident-99-1",
                workflow_path=".github/workflows/oci-production-repair-deploy.yml",
                run_id=21,
                run_attempt=1,
                control_sha=SHA,
                target_sha=SHA,
                phase="deploying",
                lease_seconds=1800,
                now=NOW + dt.timedelta(minutes=1),
                policy=POLICY,
                superseded_run_id=20,
            )

    def test_release_requires_nine_exact_digests(self):
        services = (
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
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "images.tsv"
            path.write_text(
                "\n".join(
                    f"{service}\tghcr.io/vasilyevstan/betstan-images\t"
                    f"ghcr.io/vasilyevstan/betstan-images@sha256:{index:064x}\t"
                    f"sha256:{index:064x}\tsha256:{index:064x}"
                    for index, service in enumerate(services, 1)
                )
                + "\n",
                encoding="utf-8",
            )
            images = image_digests(path)
        release = new_active_release(
            previous=None,
            source_sha=SHA,
            workflow_path=".github/workflows/oci-production-deploy.yml",
            run_id=30,
            run_attempt=1,
            infrastructure_run_id=20,
            images=images,
            infrastructure_fingerprint_sha256="f" * 64,
            now=NOW,
        )
        self.assertEqual(9, len(release["image_digests"]))

    @mock.patch("production_state.subprocess.run")
    def test_configmap_write_uses_resource_version_cas(self, run):
        store = ConfigMapStore("betstan-oci")
        document = self.begin()
        store.write("betstan-production-operation-v1", document, "123")

        payload = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(
            ["kubectl", "replace", "-f", "-"],
            run.call_args.args[0],
        )
        self.assertEqual("123", payload["metadata"]["resourceVersion"])
        self.assertEqual(
            document,
            json.loads(payload["data"][CONFIGMAP_KEY]),
        )


if __name__ == "__main__":
    unittest.main()
