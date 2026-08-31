#!/usr/bin/env python3

import datetime as dt
import io
import tempfile
import unittest
import urllib.parse
import zipfile
from pathlib import Path
from unittest import mock

from active_release_evidence import (
    PRODUCTION_MUTATION_WORKFLOWS,
    _reject_newer_production_runs,
    _safe_images,
    resolve,
)
from contracts import ContractError
from production_state import image_digests, new_active_release


ROOT = Path(__file__).resolve().parent
POLICY = ROOT / "policy-v1.json"
NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
SOURCE_SHA = "a" * 40
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


def images_bytes(offset=0):
    return (
        "\n".join(
            f"{service}\tghcr.io/vasilyevstan/betstan-images\t"
            f"ghcr.io/vasilyevstan/betstan-images@sha256:{index + offset:064x}\t"
            f"sha256:{index + offset:064x}\tsha256:{index + offset:064x}"
            for index, service in enumerate(SERVICES, 1)
        )
        + "\n"
    ).encode()


def digests(content):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "images.tsv"
        path.write_bytes(content)
        return image_digests(path)


def archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as target:
        for name, content in entries:
            target.writestr(name, content)
    return output.getvalue()


def release_observation(*, observed_at=NOW, workflow=None):
    workflow = workflow or ".github/workflows/oci-production-rollback.yml"
    content = images_bytes()
    active = new_active_release(
        previous=None,
        source_sha=SOURCE_SHA,
        workflow_path=workflow,
        run_id=77,
        run_attempt=1,
        infrastructure_run_id=55,
        images=digests(content),
        infrastructure_fingerprint_sha256="f" * 64,
        now=observed_at - dt.timedelta(minutes=1),
    )
    return {
        "observed_at": observed_at.isoformat().replace("+00:00", "Z"),
        "production_operation": None,
        "active_release": active,
    }


class ActiveReleaseEvidenceTest(unittest.TestCase):
    def test_rejects_future_and_stale_observations(self):
        for observed_at, message in (
            (NOW + dt.timedelta(seconds=1), "future-dated"),
            (NOW - dt.timedelta(hours=1), "stale"),
        ):
            with self.subTest(message=message), mock.patch(
                "active_release_evidence._trusted_observation",
                return_value=release_observation(observed_at=observed_at),
            ), mock.patch(
                "active_release_evidence._reject_newer_production_runs"
            ), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(ContractError, message):
                    resolve(
                        "vasilyevstan/betstan",
                        POLICY,
                        Path(directory) / "result",
                        now=NOW,
                    )

    def test_rejects_unsafe_mismatched_and_ambiguous_image_archives(self):
        content = images_bytes()
        expected = digests(content)
        symlink = zipfile.ZipInfo("images.tsv")
        symlink.external_attr = (0o120777 << 16)
        with io.BytesIO() as output:
            with zipfile.ZipFile(output, "w") as target:
                target.writestr(symlink, content)
            unsafe = output.getvalue()
        cases = (
            (unsafe, "unsafe entry"),
            (archive([("images.tsv", images_bytes(20))]), "no unique"),
            (
                archive(
                    [
                        ("first/images.tsv", content),
                        ("second/images.tsv", content),
                    ]
                ),
                "no unique",
            ),
        )
        for payload, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ContractError, message):
                    _safe_images(payload, expected)

    @mock.patch("active_release_evidence._artifact_archive")
    @mock.patch("active_release_evidence._api_json")
    @mock.patch("active_release_evidence._reject_newer_production_runs")
    @mock.patch("active_release_evidence._trusted_observation")
    def test_resolves_exact_rollback_artifact(
        self,
        trusted_observation,
        reject_newer,
        api_json,
        artifact_archive,
    ):
        observation = release_observation()
        trusted_observation.return_value = observation
        api_json.side_effect = [
            {
                "id": 77,
                "path": ".github/workflows/oci-production-rollback.yml",
                "run_attempt": 1,
                "status": "completed",
                "conclusion": "success",
                "run_started_at": "2026-09-01T11:55:00Z",
                "updated_at": "2026-09-01T11:59:30Z",
                "head_branch": "master",
                "head_repository": {"full_name": "vasilyevstan/betstan"},
                "display_title": f"oci-rollback {SOURCE_SHA}",
            },
            {
                "artifacts": [
                    {
                        "id": 90,
                        "name": "oci-production-rollback-77-1",
                        "expired": False,
                        "size_in_bytes": 1000,
                    }
                ]
            },
        ]
        artifact_archive.return_value = archive([("nested/images.tsv", images_bytes())])
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "result"
            result = resolve(
                "vasilyevstan/betstan",
                POLICY,
                destination,
                now=NOW,
                exclude_run_id=88,
            )
            self.assertEqual(SOURCE_SHA, result["source_sha"])
            self.assertEqual(images_bytes(), (destination / "images.tsv").read_bytes())
        reject_newer.assert_called_once_with(
            "vasilyevstan/betstan",
            NOW,
            NOW,
            88,
        )

    @mock.patch("active_release_evidence._artifact_archive")
    @mock.patch("active_release_evidence._api_json")
    @mock.patch("active_release_evidence._reject_newer_production_runs")
    @mock.patch("active_release_evidence._trusted_observation")
    def test_accepts_terminal_failure_after_release_publication(
        self,
        trusted_observation,
        reject_newer,
        api_json,
        artifact_archive,
    ):
        observation = release_observation(
            workflow=".github/workflows/oci-production-repair-deploy.yml"
        )
        trusted_observation.return_value = observation
        artifact_archive.return_value = archive([("images.tsv", images_bytes())])
        for conclusion in ("failure", "cancelled", "timed_out"):
            with self.subTest(conclusion=conclusion), tempfile.TemporaryDirectory() as directory:
                api_json.side_effect = [
                    {
                        "id": 77,
                        "path": ".github/workflows/oci-production-repair-deploy.yml",
                        "run_attempt": 1,
                        "status": "completed",
                        "conclusion": conclusion,
                        "run_started_at": "2026-09-01T11:55:00Z",
                        "updated_at": "2026-09-01T11:59:30Z",
                        "head_branch": "master",
                        "head_sha": SOURCE_SHA,
                        "head_repository": {"full_name": "vasilyevstan/betstan"},
                    },
                    {
                        "artifacts": [
                            {
                                "id": 90,
                                "name": "oci-production-repair-deploy-77-1",
                                "expired": False,
                                "size_in_bytes": 1000,
                            }
                        ]
                    },
                ]
                result = resolve(
                    "vasilyevstan/betstan",
                    POLICY,
                    Path(directory) / "result",
                    now=NOW,
                )
                self.assertEqual(SOURCE_SHA, result["source_sha"])

    @mock.patch("active_release_evidence._api_json")
    @mock.patch("active_release_evidence._reject_newer_production_runs")
    @mock.patch("active_release_evidence._trusted_observation")
    def test_rejects_failed_run_without_publication_timing(
        self,
        trusted_observation,
        reject_newer,
        api_json,
    ):
        trusted_observation.return_value = release_observation(
            workflow=".github/workflows/oci-production-repair-deploy.yml"
        )
        api_json.return_value = {
            "id": 77,
            "path": ".github/workflows/oci-production-repair-deploy.yml",
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "failure",
            "run_started_at": "2026-09-01T12:01:00Z",
            "updated_at": "2026-09-01T12:02:00Z",
            "head_branch": "master",
            "head_sha": SOURCE_SHA,
            "head_repository": {"full_name": "vasilyevstan/betstan"},
        }
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(
            ContractError, "outside its workflow execution"
        ):
            resolve(
                "vasilyevstan/betstan",
                POLICY,
                Path(directory) / "result",
                now=NOW + dt.timedelta(minutes=5),
            )

    @mock.patch("active_release_evidence._api_json")
    def test_rejects_production_run_after_observation(self, api_json):
        newer_workflow = PRODUCTION_MUTATION_WORKFLOWS[0]

        def history(path):
            encoded = path.split("/workflows/", 1)[1].split("/runs", 1)[0]
            workflow = f".github/workflows/{urllib.parse.unquote(encoded)}"
            runs = []
            if workflow == newer_workflow:
                runs.append(
                    {
                        "id": 99,
                        "path": workflow,
                        "head_repository": {"full_name": "vasilyevstan/betstan"},
                        "run_started_at": "2026-09-01T12:01:00Z",
                        "updated_at": "2026-09-01T12:02:00Z",
                    }
                )
            return {"workflow_runs": runs}

        api_json.side_effect = history
        with self.assertRaisesRegex(ContractError, "changed after"):
            _reject_newer_production_runs(
                "vasilyevstan/betstan",
                NOW,
                NOW + dt.timedelta(minutes=5),
                None,
            )

    @mock.patch("active_release_evidence._api_json")
    def test_ignores_only_the_explicit_current_production_run(self, api_json):
        def history(path):
            encoded = path.split("/workflows/", 1)[1].split("/runs", 1)[0]
            workflow = f".github/workflows/{urllib.parse.unquote(encoded)}"
            return {
                "workflow_runs": [
                    {
                        "id": 99,
                        "path": workflow,
                        "head_repository": {"full_name": "vasilyevstan/betstan"},
                        "run_started_at": "2026-09-01T12:01:00Z",
                        "updated_at": "2026-09-01T12:02:00Z",
                    }
                ]
            }

        api_json.side_effect = history
        _reject_newer_production_runs(
            "vasilyevstan/betstan",
            NOW,
            NOW + dt.timedelta(minutes=5),
            99,
        )


if __name__ == "__main__":
    unittest.main()
