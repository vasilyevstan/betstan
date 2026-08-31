#!/usr/bin/env python3

import datetime as dt
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from contracts import (
    ACTIVE_RELEASE_SCHEMA,
    APPLICATION_SERVICES,
    ENVIRONMENT,
    OBSERVATION_SCHEMA,
    canonical_json,
    timestamp,
)
from github_observer import _safe_artifact


ROOT = Path(__file__).resolve().parent
NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
SHA = "a" * 40


def observation():
    release = {
        "schema": ACTIVE_RELEASE_SCHEMA,
        "environment": ENVIRONMENT,
        "generation": 1,
        "source_sha": SHA,
        "workflow_path": ".github/workflows/oci-production-deploy.yml",
        "run_id": 10,
        "run_attempt": 1,
        "infrastructure_run_id": 9,
        "image_digests": {
            service: "sha256:" + "b" * 64 for service in APPLICATION_SERVICES
        },
        "infrastructure_fingerprint_sha256": "c" * 64,
        "validated_at": timestamp(NOW),
        "state": "active",
    }
    return {
        "schema": OBSERVATION_SCHEMA,
        "environment": ENVIRONMENT,
        "observed_at": timestamp(NOW),
        "monitor_run_id": 30,
        "monitor_run_attempt": 1,
        "source_sha": SHA,
        "status": "healthy",
        "baseline_status": "warming",
        "active_release": release,
        "production_operation": None,
        "activity": {
            "classification": "idle",
            "workflow_path": "",
            "run_id": 0,
            "run_attempt": 0,
            "control_sha": "",
            "target_sha": "",
            "phase": "",
            "repair_id": "",
            "expected_transient_codes": [],
        },
        "public": {"schema": "betstan.public-health.v1", "checks": {}},
        "deep": {"schema": "betstan.deep-health.v1", "status": "ok"},
        "anomalies": [],
    }


def archive(document, *, extra=False, checksum=True):
    payload = (canonical_json(document) + "\n").encode()
    digest = hashlib.sha256(payload).hexdigest()
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as target:
        target.writestr("observation.json", payload)
        target.writestr(
            "SHA256SUMS",
            f"{digest if checksum else '0' * 64}  observation.json\n",
        )
        if extra:
            target.writestr("unexpected", b"x")
    return stream.getvalue()


class GithubObserverTest(unittest.TestCase):
    def expected_run(self):
        return {"id": 30, "run_attempt": 1, "head_sha": SHA}

    def test_accepts_exact_observation_archive(self):
        result = _safe_artifact(
            archive(observation()),
            ROOT / "policy-v1.json",
            self.expected_run(),
        )
        self.assertEqual(30, result["monitor_run_id"])

    def test_rejects_extra_archive_entry(self):
        with self.assertRaisesRegex(Exception, "file set"):
            _safe_artifact(
                archive(observation(), extra=True),
                ROOT / "policy-v1.json",
                self.expected_run(),
            )

    def test_rejects_artifact_provenance_mismatch(self):
        run = self.expected_run()
        run["head_sha"] = "d" * 40
        with self.assertRaisesRegex(Exception, "provenance"):
            _safe_artifact(
                archive(observation()),
                ROOT / "policy-v1.json",
                run,
            )


if __name__ == "__main__":
    unittest.main()
