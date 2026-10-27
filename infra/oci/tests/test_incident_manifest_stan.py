#!/usr/bin/env python3
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "infra/oci/scripts/incident_manifest_stan.py"
SPEC = importlib.util.spec_from_file_location("incident_manifest_stan", SCRIPT)
assert SPEC and SPEC.loader
incident = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(incident)


class FakeGit:
    def __init__(
        self,
        control_sha: str,
        manifest_raw: bytes,
        *,
        head_sha: str | None = None,
        blob: bytes | None = None,
        ancestor: bool = True,
        image_error: str | None = None,
    ):
        self.control_sha = control_sha
        self.manifest_raw = manifest_raw
        self.observed_head = head_sha or control_sha
        self.blob = manifest_raw if blob is None else blob
        self.ancestor = ancestor
        self.image_error = image_error

    def head_sha(self):
        return self.observed_head

    def blob_bytes(self, control_sha, path):
        return self.blob

    def is_ancestor(self, base_sha, target_sha):
        return self.ancestor

    def compare_image_inputs(self, base_sha, target_sha, scratch_dir):
        if self.image_error:
            incident.reject(self.image_error)


class IncidentManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work_parent = ROOT / "infra/oci/tests/.incident-manifest-workdirs"
        cls.work_parent.mkdir(parents=True, exist_ok=True)
        cls.manifest, cls.manifest_raw, cls.manifest_digest = (
            incident.read_fixed_manifest(ROOT)
        )
        cls.control_sha = "a" * 40

    @classmethod
    def tearDownClass(cls):
        cls.work_parent.rmdir()

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(dir=self.work_parent))

    def tearDown(self):
        shutil.rmtree(self.work)

    def assertRejected(self, callable_, contains):
        with self.assertRaises(incident.IncidentManifestError) as raised:
            callable_()
        self.assertIn(contains, str(raised.exception))

    def test_fixed_manifest_is_strict_and_bounded(self):
        self.assertLessEqual(len(self.manifest_raw), incident.MAX_MANIFEST_BYTES)
        self.assertEqual(
            self.manifest_digest, hashlib.sha256(self.manifest_raw).hexdigest()
        )
        self.assertEqual(
            self.manifest["operation"], "oci-live-data-incident-restore"
        )
        self.assertEqual(
            self.manifest["artifacts"]["rollout"]["artifactId"], 12505156215
        )
        self.assertEqual(
            self.manifest["artifacts"]["baseline"]["artifactId"], 12504303358
        )
        self.assertEqual(
            self.manifest["artifacts"]["infrastructure"]["artifactId"],
            11465198380,
        )
        self.assertEqual(len(self.manifest["baseline"]["services"]), 10)
        self.assertEqual(len(self.manifest["baseline"]["writerServices"]), 7)

        self.assertRejected(
            lambda: incident.load_json_bytes(
                b'{"schemaVersion":"one","schemaVersion":"two"}',
                "duplicate fixture",
                max_bytes=1024,
            ),
            "duplicate JSON key",
        )
        self.assertRejected(
            lambda: incident.load_json_bytes(
                b"{" + b" " * 1024 + b"}",
                "oversize fixture",
                max_bytes=16,
            ),
            "size limit",
        )
        unknown = copy.deepcopy(self.manifest)
        unknown["unknown"] = True
        self.assertRejected(
            lambda: incident.validate_manifest_document(unknown),
            "unknown=unknown",
        )

    def run_metadata(self, spec):
        return {
            "id": spec["runId"],
            "workflow_id": spec["workflowId"],
            "path": spec["workflow"],
            "event": spec["event"],
            "head_branch": spec["headBranch"],
            "head_sha": spec["headSha"],
            "status": spec["status"],
            "conclusion": spec["conclusion"],
            "run_attempt": spec["runAttempt"],
            "created_at": spec["createdAt"],
            "updated_at": spec["updatedAt"],
            "head_repository": {"full_name": self.manifest["repository"]},
        }

    def current_run_metadata(
        self,
        *,
        run_id=123,
        created_epoch=None,
        updated_epoch=None,
    ):
        cutoff = self.manifest["heldLock"]["leaseUntilEpoch"]
        created_epoch = created_epoch or cutoff + 1
        updated_epoch = updated_epoch or created_epoch + 10
        timestamp = lambda value: dt.datetime.fromtimestamp(
            value, tz=dt.timezone.utc
        ).isoformat().replace("+00:00", "Z")
        return {
            "id": run_id,
            "workflow_id": self.manifest["heldOwner"]["workflowId"],
            "path": self.manifest["heldOwner"]["workflow"],
            "event": "workflow_dispatch",
            "head_branch": "master",
            "head_sha": self.control_sha,
            "run_attempt": 1,
            "created_at": timestamp(created_epoch),
            "updated_at": timestamp(updated_epoch),
            "repository": {"full_name": self.manifest["repository"]},
            "head_repository": {"full_name": self.manifest["repository"]},
        }

    def artifact_metadata(self, spec):
        owner = next(
            root
            for root in (
                self.manifest["heldOwner"],
                self.manifest["imageBuildRoot"],
                self.manifest["infrastructureCheckpointRoot"],
            )
            if root["runId"] == spec["workflowRunId"]
        )
        return {
            "id": spec["artifactId"],
            "name": spec["name"],
            "size_in_bytes": spec["sizeInBytes"],
            "digest": spec["digest"],
            "expired": False,
            "created_at": spec["createdAt"],
            "updated_at": spec["updatedAt"],
            "expires_at": spec["expiresAt"],
            "workflow_run": {
                "id": spec["workflowRunId"],
                "head_branch": owner["headBranch"],
                "head_sha": owner["headSha"],
                "repository_id": 1,
                "head_repository_id": 1,
            },
        }

    def test_exact_run_and_artifact_metadata(self):
        run_spec = self.manifest["heldOwner"]
        incident.validate_run_metadata(
            self.run_metadata(run_spec),
            run_spec,
            self.manifest["repository"],
            "held owner",
        )
        wrong_run = self.run_metadata(run_spec)
        wrong_run["run_attempt"] = 2
        self.assertRejected(
            lambda: incident.validate_run_metadata(
                wrong_run, run_spec, self.manifest["repository"], "held owner"
            ),
            "run_attempt mismatch",
        )

        artifact_spec = self.manifest["artifacts"]["rollout"]
        metadata = self.artifact_metadata(artifact_spec)
        now = incident.parse_utc("2026-10-24T00:00:00Z", "now")
        incident.validate_artifact_metadata(
            metadata,
            artifact_spec,
            self.manifest["heldOwner"],
            now,
            "rollout",
        )
        wrong_digest = copy.deepcopy(metadata)
        wrong_digest["digest"] = "sha256:" + "0" * 64
        self.assertRejected(
            lambda: incident.validate_artifact_metadata(
                wrong_digest,
                artifact_spec,
                self.manifest["heldOwner"],
                now,
                "rollout",
            ),
            "digest mismatch",
        )
        expired = incident.parse_utc(artifact_spec["expiresAt"], "expiry")
        before_expiry = expired - dt.timedelta(seconds=1)
        incident.validate_artifact_metadata(
            metadata,
            artifact_spec,
            self.manifest["heldOwner"],
            before_expiry,
            "rollout",
        )
        self.assertRejected(
            lambda: incident.validate_artifact_metadata(
                metadata,
                artifact_spec,
                self.manifest["heldOwner"],
                expired,
                "rollout",
            ),
            "is expired",
        )

        infrastructure_spec = self.manifest["artifacts"]["infrastructure"]
        infrastructure_metadata = self.artifact_metadata(infrastructure_spec)
        infrastructure_owner = self.manifest["infrastructureCheckpointRoot"]
        incident.validate_artifact_metadata(
            infrastructure_metadata,
            infrastructure_spec,
            infrastructure_owner,
            now,
            "infrastructure",
        )
        for key, value, message in (
            ("name", "wrong", "name mismatch"),
            ("size_in_bytes", 1, "size_in_bytes mismatch"),
            ("digest", "sha256:" + "0" * 64, "digest mismatch"),
        ):
            drifted = copy.deepcopy(infrastructure_metadata)
            drifted[key] = value
            self.assertRejected(
                lambda drifted=drifted: incident.validate_artifact_metadata(
                    drifted,
                    infrastructure_spec,
                    infrastructure_owner,
                    now,
                    "infrastructure",
                ),
                message,
            )

    def test_current_run_metadata_and_strict_creation_cutoff(self):
        cutoff = self.manifest["heldLock"]["leaseUntilEpoch"]
        metadata = self.current_run_metadata(created_epoch=cutoff + 1)
        current = incident.validate_current_run_metadata(
            metadata,
            manifest=self.manifest,
            repository=self.manifest["repository"],
            control_sha=self.control_sha,
            current_run_id=123,
        )
        self.assertEqual(current["createdAtEpoch"], cutoff + 1)
        self.assertRegex(current["metadataSha256"], r"^[0-9a-f]{64}$")
        incident.require_request_created_after_cutoff(
            current["createdAtEpoch"], cutoff
        )
        for created in (cutoff - 1, cutoff):
            rejected = incident.validate_current_run_metadata(
                self.current_run_metadata(created_epoch=created),
                manifest=self.manifest,
                repository=self.manifest["repository"],
                control_sha=self.control_sha,
                current_run_id=123,
            )
            self.assertRejected(
                lambda rejected=rejected:
                    incident.require_request_created_after_cutoff(
                        rejected["createdAtEpoch"], cutoff
                    ),
                "strictly after",
            )
        malformed = self.current_run_metadata()
        malformed.pop("repository")
        self.assertRejected(
            lambda: incident.validate_current_run_metadata(
                malformed,
                manifest=self.manifest,
                repository=self.manifest["repository"],
                control_sha=self.control_sha,
                current_run_id=123,
            ),
            "repository must be an object",
        )
        missing_timestamp = self.current_run_metadata()
        missing_timestamp.pop("created_at")
        self.assertRejected(
            lambda: incident.validate_current_run_metadata(
                missing_timestamp,
                manifest=self.manifest,
                repository=self.manifest["repository"],
                control_sha=self.control_sha,
                current_run_id=123,
            ),
            "timestamps are missing",
        )
        wrong_attempt = self.current_run_metadata()
        wrong_attempt["run_attempt"] = 2
        self.assertRejected(
            lambda: incident.validate_current_run_metadata(
                wrong_attempt,
                manifest=self.manifest,
                repository=self.manifest["repository"],
                control_sha=self.control_sha,
                current_run_id=123,
            ),
            "run_attempt mismatch",
        )

    def test_provider_transition_uses_exact_response_date(self):
        metadata = self.current_run_metadata()
        current = incident.validate_current_run_metadata(
            metadata,
            manifest=self.manifest,
            repository=self.manifest["repository"],
            control_sha=self.control_sha,
            current_run_id=123,
        )
        provider_epoch = current["updatedAtEpoch"] + 20
        provider_date = dt.datetime.fromtimestamp(
            provider_epoch, tz=dt.timezone.utc
        ).strftime("%a, %d %b %Y %H:%M:%S GMT")
        raw = (
            "HTTP/2 200 OK\r\n"
            f"Date: {provider_date}\r\n"
            "Content-Type: application/json\r\n\r\n"
        ).encode() + json.dumps(metadata).encode()
        response = subprocess.CompletedProcess(
            ["gh"], 0, stdout=raw, stderr=b""
        )
        client = incident.GhApiClient(self.manifest["repository"])
        with mock.patch.object(
            incident.subprocess, "run", return_value=response
        ):
            result = incident.capture_provider_transition(
                repo_root=ROOT,
                repository=self.manifest["repository"],
                control_sha=self.control_sha,
                current_run_id=123,
                expected_metadata_sha256=current["metadataSha256"],
                expected_created_at_epoch=current["createdAtEpoch"],
                api=client,
            )
        self.assertEqual(
            result["providerTransitionEpoch"], provider_epoch
        )
        self.assertEqual(result["githubRequestCount"], 1)
        self.assertEqual(
            client.requested_endpoints,
            [
                "repos/vasilyevstan/betstan/actions/runs/"
                "123/attempts/1"
            ],
        )

        for header, message in (
            ("", "Date header is missing"),
            ("Date: malformed\r\n", "Date header is malformed"),
            (
                "Date: Thu, 01 Jan 1970 00:00:01 GMT\r\n",
                "Date is stale",
            ),
        ):
            response = subprocess.CompletedProcess(
                ["gh"],
                0,
                stdout=(
                    "HTTP/2 200 OK\r\n"
                    f"{header}"
                    "Content-Type: application/json\r\n\r\n"
                ).encode()
                + json.dumps(metadata).encode(),
                stderr=b"",
            )
            client = incident.GhApiClient(self.manifest["repository"])
            with mock.patch.object(
                incident.subprocess, "run", return_value=response
            ):
                self.assertRejected(
                    lambda client=client:
                        incident.capture_provider_transition(
                            repo_root=ROOT,
                            repository=self.manifest["repository"],
                            control_sha=self.control_sha,
                            current_run_id=123,
                            expected_metadata_sha256=current[
                                "metadataSha256"
                            ],
                            expected_created_at_epoch=current[
                                "createdAtEpoch"
                            ],
                            api=client,
                        ),
                    message,
                )

    def zip_bytes(self, entries):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, value in entries:
                if isinstance(name, zipfile.ZipInfo):
                    archive.writestr(name, value)
                else:
                    info = zipfile.ZipInfo(name)
                    info.create_system = 3
                    info.external_attr = (stat.S_IFREG | 0o600) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, value)
        return buffer.getvalue()

    def archive_spec(self, raw, files):
        return {
            "sizeInBytes": len(raw),
            "digest": f"sha256:{hashlib.sha256(raw).hexdigest()}",
            "files": {
                name: hashlib.sha256(value).hexdigest()
                for name, value in files.items()
            },
        }

    def test_safe_zip_and_unsafe_archives_fail_closed(self):
        content = b"bounded evidence\n"
        raw = self.zip_bytes([("evidence.txt", content)])
        spec = self.archive_spec(raw, {"evidence.txt": content})
        extracted = incident.extract_verified_archive(
            raw, spec, self.work / "safe", "safe fixture"
        )
        self.assertEqual(extracted, {"evidence.txt": content})

        traversal = self.zip_bytes([("../escape", b"x")])
        traversal_spec = self.archive_spec(traversal, {"safe.txt": b"x"})
        self.assertRejected(
            lambda: incident.extract_verified_archive(
                traversal,
                traversal_spec,
                self.work / "traversal",
                "traversal fixture",
            ),
            "non-canonical path",
        )

        link = zipfile.ZipInfo("link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        symlink = self.zip_bytes([(link, b"target")])
        symlink_spec = self.archive_spec(symlink, {"link": b"target"})
        self.assertRejected(
            lambda: incident.extract_verified_archive(
                symlink,
                symlink_spec,
                self.work / "symlink",
                "symlink fixture",
            ),
            "non-regular file",
        )

        malformed = b"not a zip"
        malformed_spec = self.archive_spec(malformed, {"safe.txt": b"x"})
        self.assertRejected(
            lambda: incident.extract_verified_archive(
                malformed,
                malformed_spec,
                self.work / "malformed",
                "malformed fixture",
            ),
            "not a valid ZIP",
        )

        infrastructure_files = {
            "provenance.env": b"source_sha=fixture\n",
            "inventory.json": b"{}\n",
            "application-registry-evidence.env": b"registry=fixture\n",
        }
        infrastructure_raw = self.zip_bytes(list(infrastructure_files.items()))
        infrastructure_archive_spec = self.archive_spec(
            infrastructure_raw, infrastructure_files
        )
        incident.extract_verified_archive(
            infrastructure_raw,
            infrastructure_archive_spec,
            self.work / "infrastructure",
            "infrastructure fixture",
        )
        for name, entries in (
            (
                "missing",
                list(infrastructure_files.items())[:-1],
            ),
            (
                "extra",
                list(infrastructure_files.items()) + [("extra", b"x")],
            ),
            (
                "wrong",
                [
                    (key, b"wrong" if key == "inventory.json" else value)
                    for key, value in infrastructure_files.items()
                ],
            ),
        ):
            raw = self.zip_bytes(entries)
            spec = dict(infrastructure_archive_spec)
            spec["sizeInBytes"] = len(raw)
            spec["digest"] = f"sha256:{hashlib.sha256(raw).hexdigest()}"
            self.assertRejected(
                lambda raw=raw, spec=spec, name=name:
                    incident.extract_verified_archive(
                        raw,
                        spec,
                        self.work / f"infrastructure-{name}",
                        f"infrastructure {name}",
                    ),
                "file set mismatch" if name != "wrong" else "file digest mismatch",
            )

    def test_github_requests_are_exact_and_bounded(self):
        client = incident.GhApiClient(self.manifest["repository"])
        response = subprocess.CompletedProcess(
            ["gh"], 0, stdout=b"{}", stderr=b""
        )
        with mock.patch.object(incident.subprocess, "run", return_value=response):
            for _ in range(incident.MAX_API_REQUESTS):
                client._request(
                    "repos/vasilyevstan/betstan/actions/runs/39945618182"
                )
            self.assertRejected(
                lambda: client._request(
                    "repos/vasilyevstan/betstan/actions/runs/39945618182"
                ),
                "exceeded 24",
            )

        forbidden = incident.GhApiClient(self.manifest["repository"])
        forbidden.request_count = 1
        forbidden.requested_endpoints = [
            "repos/vasilyevstan/betstan/actions/runs?per_page=100"
        ]
        self.assertRejected(
            lambda: incident.validate_api_endpoints(
                forbidden, self.manifest
            ),
            "forbidden GitHub endpoint",
        )

        exact = incident.GhApiClient(self.manifest["repository"])
        exact.requested_endpoints = [
            (
                f"repos/{self.manifest['repository']}/actions/runs/"
                "123/attempts/1"
            ),
            *[
                (
                    f"repos/{self.manifest['repository']}/actions/runs/"
                    f"{root['runId']}"
                )
                for root in (
                    self.manifest["heldOwner"],
                    self.manifest["imageBuildRoot"],
                    self.manifest["infrastructureCheckpointRoot"],
                )
            ],
            *[
                endpoint
                for artifact in self.manifest["artifacts"].values()
                for endpoint in (
                    (
                        f"repos/{self.manifest['repository']}/actions/artifacts/"
                        f"{artifact['artifactId']}"
                    ),
                    (
                        f"repos/{self.manifest['repository']}/actions/artifacts/"
                        f"{artifact['artifactId']}/zip"
                    ),
                )
            ],
        ]
        exact.request_count = len(exact.requested_endpoints)
        self.assertEqual(exact.request_count, 10)
        incident.validate_api_endpoints(exact, self.manifest, 123)

        malformed_http = incident.GhApiClient(self.manifest["repository"])
        malformed_response = subprocess.CompletedProcess(
            ["gh"], 0, stdout=b"{", stderr=b""
        )
        with mock.patch.object(
            incident.subprocess, "run", return_value=malformed_response
        ):
            self.assertRejected(
                lambda: malformed_http.get_run(39945618182),
                "malformed JSON",
            )

    def early_verify(
        self, git, *, current_run_id=123, now=None, api=None
    ):
        return incident.verify_incident_manifest(
            repo_root=ROOT,
            repository=self.manifest["repository"],
            control_sha=self.control_sha,
            dispatch_inputs_json=json.dumps(
                incident.expected_dispatch_inputs(
                    self.manifest, self.control_sha
                )
            ),
            current_run_id=current_run_id,
            output_dir=self.work / f"output-{len(list(self.work.iterdir()))}",
            git=git,
            api=api,
            now=now,
        )

    def test_verifier_rejects_pre_cutoff_request_before_root_reads(self):
        test = self

        class CurrentOnlyApi:
            request_count = 0
            requested_endpoints = []

            def __init__(self, created_epoch):
                self.created_epoch = created_epoch

            def get_run_attempt(self, run_id, attempt):
                return test.current_run_metadata(
                    run_id=run_id,
                    created_epoch=self.created_epoch,
                )

            def get_run(self, run_id):
                raise AssertionError("immutable roots must not be read")

        cutoff = self.manifest["heldLock"]["leaseUntilEpoch"]
        for created in (cutoff - 1, cutoff):
            self.assertRejected(
                lambda created=created: self.early_verify(
                    FakeGit(self.control_sha, self.manifest_raw),
                    api=CurrentOnlyApi(created),
                ),
                "strictly after",
            )

    def test_control_ancestry_image_inputs_and_self_reference(self):
        self.assertRejected(
            lambda: self.early_verify(
                FakeGit(
                    self.control_sha,
                    self.manifest_raw,
                    head_sha="b" * 40,
                )
            ),
            "not the exact current control",
        )
        self.assertRejected(
            lambda: self.early_verify(
                FakeGit(
                    self.control_sha,
                    self.manifest_raw,
                    blob=b"different",
                )
            ),
            "differs from the control commit",
        )
        self.assertRejected(
            lambda: self.early_verify(
                FakeGit(
                    self.control_sha,
                    self.manifest_raw,
                    ancestor=False,
                )
            ),
            "not a descendant",
        )
        self.assertRejected(
            lambda: self.early_verify(
                FakeGit(
                    self.control_sha,
                    self.manifest_raw,
                    image_error="canonical image inputs changed",
                )
            ),
            "canonical image inputs changed",
        )
        self.assertRejected(
            lambda: self.early_verify(
                FakeGit(self.control_sha, self.manifest_raw),
                current_run_id=self.manifest["heldOwner"]["runId"],
            ),
            "self-references",
        )
        lease_not_expired = dt.datetime.fromtimestamp(
            self.manifest["heldLock"]["leaseUntilEpoch"] - 1,
            tz=dt.timezone.utc,
        )
        self.assertRejected(
            lambda: self.early_verify(
                FakeGit(self.control_sha, self.manifest_raw),
                current_run_id=0,
                now=lease_not_expired,
            ),
            "lease is not expired",
        )

    def test_dispatch_input_drift_is_rejected(self):
        expected = incident.expected_dispatch_inputs(
            self.manifest, self.control_sha
        )
        incident.validate_dispatch_inputs(
            json.dumps(expected),
            self.manifest,
            self.manifest_digest,
            self.control_sha,
            0,
        )
        drifted = dict(expected)
        drifted["build_run_id"] = "1"
        self.assertRejected(
            lambda: incident.validate_dispatch_inputs(
                json.dumps(drifted),
                self.manifest,
                self.manifest_digest,
                self.control_sha,
                0,
            ),
            "differ from the fixed manifest",
        )

    def test_continuation_inputs_and_control_handoff_are_exact(self):
        expected = incident.expected_dispatch_inputs(
            self.manifest, self.control_sha
        )
        _identity, identity_digest = incident.journal_identity(
            self.manifest, self.manifest_digest
        )
        expected.update(
            incident_continuation_run_id="5001",
            incident_continuation_authority_sha256="b" * 64,
            incident_continuation_control_sha=self.control_sha,
            incident_continuation_journal_identity_sha256=identity_digest,
            incident_continuation_generation="1",
            incident_access_cleanup_lineage_json=json.dumps(
                [
                    {
                        "runId": 5001,
                        "controlSha": self.control_sha,
                        "authorityGeneration": 0,
                        "authoritySha256": "b" * 64,
                    }
                ],
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
        continuation = incident.validate_dispatch_inputs(
            json.dumps(expected),
            self.manifest,
            self.manifest_digest,
            self.control_sha,
            5002,
        )
        self.assertEqual(
            continuation["incident_continuation_run_id"], "5001"
        )
        partial = dict(expected)
        partial["incident_continuation_authority_sha256"] = "none"
        self.assertRejected(
            lambda: incident.validate_dispatch_inputs(
                json.dumps(partial),
                self.manifest,
                self.manifest_digest,
                self.control_sha,
                5002,
            ),
            "malformed",
        )
        duplicate_lineage = dict(expected)
        duplicate_lineage["incident_access_cleanup_lineage_json"] = (
            '[{"authorityGeneration":0,"authoritySha256":"'
            + ("b" * 64)
            + '","authoritySha256":"'
            + ("b" * 64)
            + '","controlSha":"'
            + self.control_sha
            + '","runId":5001}]'
        )
        self.assertRejected(
            lambda: incident.validate_dispatch_inputs(
                json.dumps(duplicate_lineage),
                self.manifest,
                self.manifest_digest,
                self.control_sha,
                5002,
            ),
            "duplicate JSON key",
        )
        for lineage, message in (
            (
                json.dumps(
                    [
                        {
                            "runId": 5001,
                            "controlSha": self.control_sha,
                            "authorityGeneration": 0,
                            "authoritySha256": "b" * 64,
                            "unknown": True,
                        }
                    ],
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                "shape",
            ),
            ("[ ]", "not canonical"),
            ("[]", "length differs"),
            (
                json.dumps(
                    [
                        {
                            "runId": 5001,
                            "controlSha": self.control_sha,
                            "authorityGeneration": 1,
                            "authoritySha256": "b" * 64,
                        }
                    ],
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                "entry is invalid",
            ),
            (
                json.dumps(
                    [
                        {
                            "runId": 5000,
                            "controlSha": self.control_sha,
                            "authorityGeneration": 0,
                            "authoritySha256": "b" * 64,
                        }
                    ],
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                "exact predecessor",
            ),
        ):
            malformed = dict(expected)
            malformed["incident_access_cleanup_lineage_json"] = lineage
            self.assertRejected(
                lambda malformed=malformed: incident.validate_dispatch_inputs(
                    json.dumps(malformed),
                    self.manifest,
                    self.manifest_digest,
                    self.control_sha,
                    5002,
                ),
                message,
            )
        oversized = dict(expected)
        oversized["incident_continuation_generation"] = "33"
        oversized["incident_access_cleanup_lineage_json"] = json.dumps(
            [
                {
                    "runId": 6000 + generation,
                    "controlSha": self.control_sha,
                    "authorityGeneration": generation,
                    "authoritySha256": "b" * 64,
                }
                for generation in range(33)
            ],
            sort_keys=True,
            separators=(",", ":"),
        )
        self.assertRejected(
            lambda: incident.validate_dispatch_inputs(
                json.dumps(oversized),
                self.manifest,
                self.manifest_digest,
                self.control_sha,
                5002,
            ),
            "fixed bound",
        )
        self.assertRejected(
            lambda: incident.validate_dispatch_inputs(
                json.dumps(expected),
                self.manifest,
                self.manifest_digest,
                self.control_sha,
                5001,
            ),
            "self-references",
        )

        proof = incident.validate_control_handoff(
            repo_root=ROOT,
            from_control_sha=self.control_sha,
            to_control_sha=self.control_sha,
            scratch_dir=self.work,
            manifest=self.manifest,
            manifest_raw=self.manifest_raw,
            manifest_digest=self.manifest_digest,
            git=FakeGit(self.control_sha, self.manifest_raw),
        )
        self.assertEqual(proof["relation"], "same")
        descendant = "c" * 40
        proof = incident.validate_control_handoff(
            repo_root=ROOT,
            from_control_sha=self.control_sha,
            to_control_sha=descendant,
            scratch_dir=self.work,
            manifest=self.manifest,
            manifest_raw=self.manifest_raw,
            manifest_digest=self.manifest_digest,
            git=FakeGit(
                descendant,
                self.manifest_raw,
                head_sha=descendant,
            ),
        )
        self.assertEqual(proof["relation"], "descendant")
        self.assertRejected(
            lambda: incident.validate_control_handoff(
                repo_root=ROOT,
                from_control_sha=self.control_sha,
                to_control_sha=descendant,
                scratch_dir=self.work,
                manifest=self.manifest,
                manifest_raw=self.manifest_raw,
                manifest_digest=self.manifest_digest,
                git=FakeGit(
                    descendant,
                    self.manifest_raw,
                    head_sha=descendant,
                    ancestor=False,
                ),
            ),
            "not an ancestor",
        )
        unknown = dict(expected)
        unknown["manifest_digest"] = self.manifest_digest
        self.assertRejected(
            lambda: incident.validate_dispatch_inputs(
                json.dumps(unknown),
                self.manifest,
                self.manifest_digest,
                self.control_sha,
                0,
            ),
            "differ from the fixed manifest",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
