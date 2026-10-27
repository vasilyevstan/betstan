#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "infra/azure/agents/copilot_cli_authority_stan.py"
POLICY = ROOT / (
    "infra/azure/agents/"
    "copilot-cli-protected-operation-policy-stan.sh"
)
SPEC = importlib.util.spec_from_file_location("authority", HELPER)
assert SPEC and SPEC.loader
authority = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(authority)


class IncidentContinuationAuthorityTests(unittest.TestCase):
    repository = "example/repo"
    workflow_id = "301"
    workflow_blob = "b" * 40
    control = "a" * 40
    persisted_phases = (
        "incident-active-fenced",
        "released-fenced",
        "released-unfenced-pending-publication",
        "readiness-captured",
        "sealed-pending-publication",
        "published",
    )

    def setUp(self):
        parent = Path(os.environ["TMPDIR"]).resolve()
        self.work = Path(
            tempfile.mkdtemp(
                prefix="incident-continuation-authority.",
                dir=parent,
            )
        )
        self.repo = self.work / "repo"
        self.directory = self.work / "authority"
        self.repo.mkdir()
        self.directory.mkdir(mode=0o700)
        verifier = (
            self.repo / "infra/oci/scripts/incident_manifest_stan.py"
        )
        verifier.parent.mkdir(parents=True)
        verifier.write_text(
            "#!/usr/bin/env python3\n"
            "import hashlib,json,sys\n"
            "args=sys.argv[1:]\n"
            "def value(name): return args[args.index(name)+1]\n"
            "source=value('--from-control-sha')\n"
            "target=value('--to-control-sha')\n"
            "manifest='d'*64\n"
            "identity={\n"
            "'schemaVersion':'betstan.oci-live-data-incident-restore-state.v1',\n"
            "'namespace':'betstan-oci',\n"
            "'name':'gaming-oci-live-data-incident-restore',\n"
            "'operationId':'live-data-incident-restore',\n"
            "'ownerRunId':39945618182,\n"
            "'manifestSha256':manifest,\n"
            "}\n"
            "digest=lambda value: hashlib.sha256(json.dumps(value,"
            "sort_keys=True,separators=(',',':')).encode()).hexdigest()\n"
            "proof={\n"
            "'schemaVersion':'betstan.oci-live-data-incident-control-handoff.v1',\n"
            "'fromControlSha':source,'toControlSha':target,\n"
            "'relation':'same' if source==target else 'descendant',\n"
            "'manifestSha256':manifest,'journalIdentity':identity,\n"
            "'journalIdentitySha256':digest(identity),\n"
            "'imageInputs':'unchanged',\n"
            "}\n"
            "proof['proofSha256']=digest(proof)\n"
            "print(json.dumps(proof,sort_keys=True,separators=(',',':')))\n",
            encoding="utf-8",
        )
        verifier.chmod(0o700)
        self.policy = json.loads(
            subprocess.check_output(
                [str(POLICY), "get", authority.INCIDENT_OPERATION],
                text=True,
            )
        )
        self.policy_json = json.dumps(
            self.policy, sort_keys=True, separators=(",", ":")
        )
        self.normalized = self.write_normalized(self.control)
        self.issue_initial_consumed()

    def tearDown(self):
        shutil.rmtree(self.work)

    def private_json(self, name: str, value: dict) -> Path:
        path = self.work / name
        path.write_text(
            json.dumps(value, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        path.chmod(0o600)
        return path

    def write_normalized(self, control: str) -> Path:
        inputs = dict(self.policy["fixedInputs"])
        inputs["approved_sha"] = control
        request = {
            "schemaVersion": authority.REQUEST_SCHEMA,
            "repository": self.repository,
            "operation": authority.INCIDENT_OPERATION,
            "controlSha": control,
            "subjectSha": control,
            "targetSha": None,
            "inputs": inputs,
        }
        normalized = authority.validate_request_data(
            request, self.policy, self.repository, control
        )
        return self.private_json(
            f"normalized-{control}.json", normalized
        )

    def run_helper(
        self, *arguments: str, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(HELPER), *map(str, arguments)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env={**os.environ, "TMPDIR": str(self.work)},
        )
        if check and result.returncode != 0:
            self.fail(result.stderr or result.stdout)
        return result

    def authority_args(self) -> list[str]:
        return [
            "--authority-dir",
            str(self.directory),
            "--repo-root",
            str(self.repo),
        ]

    def claim_args(
        self,
        normalized: Path,
        control: str,
        *,
        predecessor: Path | None = None,
        exclusivity: Path | None = None,
    ) -> list[str]:
        arguments = [
            "claim-request",
            "--normalized",
            str(normalized),
            "--policy-json",
            self.policy_json,
            "--repository",
            self.repository,
            "--current-master",
            control,
            "--workflow-id",
            self.workflow_id,
            "--workflow-blob-sha",
            self.workflow_blob,
            "--owner-pid",
            str(os.getpid()),
            *self.authority_args(),
        ]
        if predecessor is not None:
            arguments += [
                "--incident-predecessor-run-json",
                str(predecessor),
                "--incident-exclusivity-json",
                str(exclusivity),
            ]
        return arguments

    def run_document(
        self,
        run_id: int,
        control: str,
        title: str,
        *,
        status: str,
        conclusion: str | None,
    ) -> dict:
        return {
            "id": run_id,
            "workflow_id": int(self.workflow_id),
            "path": ".github/workflows/oci-live-data-rollout.yml",
            "event": "workflow_dispatch",
            "head_sha": control,
            "head_branch": "master",
            "head_repository": {"full_name": self.repository},
            "run_attempt": 1,
            "display_title": title,
            "status": status,
            "conclusion": conclusion,
        }

    def bind_and_issue(
        self,
        normalized: Path,
        control: str,
        claim: dict,
        run_id: int,
    ) -> dict:
        capture = Path(claim["capturePath"])
        capture.write_text(
            f"https://github.com/{self.repository}/actions/runs/{run_id}\n",
            encoding="utf-8",
        )
        common = [
            "--normalized",
            str(normalized),
            "--policy-json",
            self.policy_json,
            "--repository",
            self.repository,
            "--current-master",
            control,
            "--workflow-id",
            self.workflow_id,
            "--workflow-blob-sha",
            self.workflow_blob,
            *self.authority_args(),
        ]
        self.run_helper(
            "bind-intent",
            *common,
            "--expected-run-id",
            str(run_id),
            "--expected-capture-file",
            capture.name,
        )
        record = json.loads(
            (self.directory / f"{run_id}.json").read_text(
                encoding="utf-8"
            )
        )
        run = self.private_json(
            f"run-{run_id}.json",
            self.run_document(
                run_id,
                record["controlSha"],
                record["displayTitle"],
                status="waiting",
                conclusion=None,
            ),
        )
        self.run_helper(
            "issue",
            "--run-id",
            str(run_id),
            "--run-json",
            str(run),
            *common[2:],
        )
        return json.loads(
            (self.directory / f"{run_id}.json").read_text(
                encoding="utf-8"
            )
        )

    def consume(self, run_id: int) -> dict:
        record_path = self.directory / f"{run_id}.json"
        record = json.loads(record_path.read_text(encoding="utf-8"))
        token = self.run_helper(
            "acquire-lock",
            "--run-id",
            str(run_id),
            "--owner-pid",
            str(os.getpid()),
            *self.authority_args(),
        ).stdout.strip()
        gate_key = "e" * 64
        common = [
            "--run-id",
            str(run_id),
            "--token",
            token,
            "--approval-run-id",
            str(run_id),
            "--approval-operation",
            authority.INCIDENT_OPERATION,
            "--environment-id",
            "901",
            "--gate-key",
            gate_key,
            *self.authority_args(),
        ]
        self.run_helper(
            "claim-approval",
            *common,
            "--expected-version",
            str(record["version"]),
            "--reviewer",
            "copilot-test",
            "--approval-comment",
            "exact continuation test",
            "--approval-count-before",
            "0",
        )
        record = json.loads(record_path.read_text(encoding="utf-8"))
        self.run_helper(
            "complete-approval",
            *common,
            "--expected-version",
            str(record["version"]),
        )
        self.run_helper(
            "release-lock",
            "--run-id",
            str(run_id),
            "--token",
            token,
            *self.authority_args(),
        )
        return json.loads(record_path.read_text(encoding="utf-8"))

    def issue_initial_consumed(self):
        claim = json.loads(
            self.run_helper(
                *self.claim_args(self.normalized, self.control)
            ).stdout
        )
        record = self.bind_and_issue(
            self.normalized, self.control, claim, 5001
        )
        self.assertEqual(record["schemaVersion"], authority.RECORD_SCHEMA_V1)
        record = self.consume(5001)
        self.assertEqual(record["state"], "consumed")

    def predecessor_evidence(
        self,
        run_id: int,
        control: str,
        conclusion: str | None,
        *,
        status: str = "completed",
    ) -> tuple[Path, Path]:
        record = json.loads(
            (self.directory / f"{run_id}.json").read_text(
                encoding="utf-8"
            )
        )
        run = self.private_json(
            f"predecessor-{run_id}-{status}-{conclusion}.json",
            self.run_document(
                run_id,
                record["controlSha"],
                record["displayTitle"],
                status=status,
                conclusion=conclusion,
            ),
        )
        result = "production_run_exclusivity=PASS"
        observed = dt.datetime.now(
            dt.timezone.utc
        ).isoformat().replace("+00:00", "Z")
        exclusivity = self.private_json(
            f"exclusivity-{run_id}.json",
            {
                "schemaVersion": authority.INCIDENT_EXCLUSIVITY_SCHEMA,
                "repository": self.repository,
                "controlSha": control,
                "predecessorRunId": run_id,
                "observedAt": observed,
                "result": result,
                "outputSha256": __import__("hashlib").sha256(
                    (result + "\n").encode("utf-8")
                ).hexdigest(),
            },
        )
        return run, exclusivity

    def restore_bound_intent_crash_window(
        self, normalized_path: Path, run_id: int
    ) -> None:
        normalized = json.loads(
            normalized_path.read_text(encoding="utf-8")
        )
        record = json.loads(
            (self.directory / f"{run_id}.json").read_text(
                encoding="utf-8"
            )
        )
        capture_name = "dispatch-" + "f" * 32 + ".log"
        capture = self.directory / capture_name
        capture.write_text(record["runUrl"] + "\n", encoding="utf-8")
        capture.chmod(0o600)
        intent = {
            "schemaVersion": authority.INTENT_SCHEMA,
            "requestKey": authority.request_key(normalized),
            "repository": record["repository"],
            "operation": record["operation"],
            "workflow": record["workflow"],
            "workflowId": record["workflowId"],
            "workflowBlobSha": record["workflowBlobSha"],
            "event": record["event"],
            "environment": record["environment"],
            "controlSha": record["controlSha"],
            "subjectSha": record["subjectSha"],
            "targetSha": record["targetSha"],
            "inputs": record["inputs"],
            "inputHash": record["inputHash"],
            "displayTitleTemplate": normalized[
                "displayTitleTemplate"
            ],
            "authorityOwner": authority.AUTHORITY_OWNER,
            "createdAt": record["createdAt"],
            "expiresAt": record["expiresAt"],
            "state": "bound",
            "version": 3,
            "ownerPid": os.getpid(),
            "captureFile": capture_name,
            "dispatchStatus": 0,
            "runId": run_id,
            "runUrl": record["runUrl"],
        }
        self.private_json(
            f"authority/request-{intent['requestKey']}.json",
            intent,
        )

    def test_same_sha_race_lifecycle_and_repeated_generation(self):
        predecessor, exclusivity = self.predecessor_evidence(
            5001, self.control, "failure"
        )
        self.restore_bound_intent_crash_window(
            self.normalized, 5001
        )
        command = [
            sys.executable,
            str(HELPER),
            *self.claim_args(
                self.normalized,
                self.control,
                predecessor=predecessor,
                exclusivity=exclusivity,
            ),
        ]
        processes = [
            subprocess.Popen(
                command,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**os.environ, "TMPDIR": str(self.work)},
            )
            for _ in range(2)
        ]
        results = [process.communicate(timeout=30) for process in processes]
        self.assertTrue(all(process.returncode == 0 for process in processes))
        claims = [json.loads(stdout) for stdout, _stderr in results]
        self.assertEqual(
            sorted(claim["created"] for claim in claims),
            [False, True],
        )
        claim = next(item for item in claims if item["created"])
        self.assertEqual(
            claim["continuationInputs"]["incident_continuation_run_id"],
            "5001",
        )
        initial_authority = json.loads(
            (self.directory / "5001.json").read_text(encoding="utf-8")
        )
        cleanup_lineage = json.loads(
            claim["continuationInputs"][
                "incident_access_cleanup_lineage_json"
            ]
        )
        self.assertEqual(
            cleanup_lineage,
            [
                {
                    "runId": 5001,
                    "controlSha": self.control,
                    "authorityGeneration": 0,
                    "authoritySha256":
                        authority.evidence_digest(initial_authority),
                }
            ],
        )
        self.assertEqual(
            len(list(self.directory.glob("incident-spent-*.json"))),
            1,
        )
        record = self.bind_and_issue(
            self.normalized, self.control, claim, 5002
        )
        self.assertEqual(record["schemaVersion"], authority.RECORD_SCHEMA_V6)
        self.assertEqual(record["continuation"]["generation"], 1)
        verified = json.loads(
            self.run_helper(
                "verify-incident-continuation",
                "--run-id",
                "5002",
                "--predecessor-run-json",
                str(predecessor),
                "--policy-json",
                self.policy_json,
                "--repository",
                self.repository,
                "--current-master",
                self.control,
                "--workflow-id",
                self.workflow_id,
                "--workflow-blob-sha",
                self.workflow_blob,
                *self.authority_args(),
            ).stdout
        )
        self.assertEqual(verified["generation"], 1)
        self.consume(5002)

        predecessor_two, exclusivity_two = self.predecessor_evidence(
            5002, self.control, "cancelled"
        )
        second = json.loads(
            self.run_helper(
                *self.claim_args(
                    self.normalized,
                    self.control,
                    predecessor=predecessor_two,
                    exclusivity=exclusivity_two,
                )
            ).stdout
        )
        self.assertTrue(second["created"])
        intent = json.loads(
            (
                self.directory
                / f"request-{second['requestKey']}.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(intent["continuation"]["generation"], 2)
        self.assertEqual(
            intent["continuation"]["predecessorRunId"], 5002
        )
        inherited = intent["continuation"]["accessCleanupLineage"]
        self.assertEqual([entry["runId"] for entry in inherited], [5001, 5002])
        self.assertEqual(
            [entry["authorityGeneration"] for entry in inherited],
            [0, 1],
        )
        predecessor_authority = json.loads(
            (self.directory / "5002.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            inherited[-1]["authoritySha256"],
            authority.evidence_digest(predecessor_authority),
        )
        self.assertEqual(
            json.loads(
                second["continuationInputs"][
                    "incident_access_cleanup_lineage_json"
                ]
            ),
            inherited,
        )
        self.bind_and_issue(
            self.normalized, self.control, second, 5003
        )
        tampered_directory = self.work / "tampered-lineage"
        shutil.copytree(self.directory, tampered_directory)
        tampered_path = tampered_directory / "5003.json"
        tampered_record = json.loads(
            tampered_path.read_text(encoding="utf-8")
        )
        tampered_lineage = tampered_record["continuation"][
            "accessCleanupLineage"
        ]
        tampered_lineage[0]["authoritySha256"] = "f" * 64
        tampered_record["continuation"][
            "accessCleanupLineageSha256"
        ] = authority.evidence_digest(tampered_lineage)
        tampered_record["continuation"]["dispatchInputs"][
            "incident_access_cleanup_lineage_json"
        ] = json.dumps(
            tampered_lineage, sort_keys=True, separators=(",", ":")
        )
        tampered_path.write_text(
            json.dumps(
                tampered_record,
                sort_keys=True,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        with self.assertRaises(SystemExit):
            authority.load_record(tampered_directory, 5003)

    def test_descendant_control_and_terminal_negative_cases(self):
        descendant = "c" * 40
        descendant_normalized = self.write_normalized(descendant)
        predecessor, exclusivity = self.predecessor_evidence(
            5001, descendant, "failure"
        )
        claim = json.loads(
            self.run_helper(
                *self.claim_args(
                    descendant_normalized,
                    descendant,
                    predecessor=predecessor,
                    exclusivity=exclusivity,
                )
            ).stdout
        )
        self.assertTrue(claim["created"])
        self.assertEqual(
            claim["continuationInputs"][
                "incident_continuation_control_sha"
            ],
            self.control,
        )

        for status, conclusion in (
            ("completed", "success"),
            ("in_progress", None),
        ):
            other = Path(
                tempfile.mkdtemp(prefix="negative.", dir=self.work)
            )
            try:
                original_directory = self.directory
                self.directory = other / "authority"
                shutil.copytree(original_directory, self.directory)
                run, proof = self.predecessor_evidence(
                    5001, self.control, conclusion, status=status
                )
                result = self.run_helper(
                    *self.claim_args(
                        self.normalized,
                        self.control,
                        predecessor=run,
                        exclusivity=proof,
                    ),
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("terminal failure or cancellation", result.stderr)
            finally:
                self.directory = original_directory
                shutil.rmtree(other)

        result = self.run_helper(
            *self.claim_args(self.normalized, self.control),
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires exact predecessor", result.stderr)

    def test_every_persisted_phase_completes_protected_lifecycle(self):
        seed = self.work / "seed-authority"
        shutil.copytree(self.directory, seed)
        dispatcher = (
            ROOT
            / "infra/azure/agents/copilot-cli-dispatch-stan.sh"
        ).read_text(encoding="utf-8")
        approver = (
            ROOT
            / "infra/azure/agents/copilot-cli-run-approval-stan.sh"
        ).read_text(encoding="utf-8")
        self.assertIn("incident-continuation-candidate", dispatcher)
        self.assertIn("--incident-predecessor-run-json", dispatcher)
        self.assertIn("verify-incident-continuation", approver)
        for index, phase in enumerate(self.persisted_phases, start=1):
            with self.subTest(phase=phase):
                shutil.rmtree(self.directory)
                shutil.copytree(seed, self.directory)
                journal = self.private_json(
                    f"journal-{phase}.json",
                    {
                        "schemaVersion": (
                            "betstan.oci-live-data-incident-restore-state.v1"
                        ),
                        "phase": phase,
                        "ownerRunId": 39945618182,
                        "operationId": "live-data-incident-restore",
                        "manifestSha256": "d" * 64,
                    },
                )
                self.assertEqual(
                    json.loads(journal.read_text(encoding="utf-8"))["phase"],
                    phase,
                )
                predecessor, exclusivity = self.predecessor_evidence(
                    5001, self.control, "failure"
                )
                candidate = json.loads(
                    self.run_helper(
                        "incident-continuation-candidate",
                        "--normalized",
                        str(self.normalized),
                        "--policy-json",
                        self.policy_json,
                        "--repository",
                        self.repository,
                        "--current-master",
                        self.control,
                        "--workflow-id",
                        self.workflow_id,
                        "--workflow-blob-sha",
                        self.workflow_blob,
                        *self.authority_args(),
                    ).stdout
                )
                self.assertEqual(candidate["predecessorRunId"], 5001)
                claim = json.loads(
                    self.run_helper(
                        *self.claim_args(
                            self.normalized,
                            self.control,
                            predecessor=predecessor,
                            exclusivity=exclusivity,
                        )
                    ).stdout
                )
                run_id = 6000 + index
                record = self.bind_and_issue(
                    self.normalized, self.control, claim, run_id
                )
                self.assertEqual(
                    record["continuation"]["predecessorRunId"], 5001
                )
                self.assertEqual(record["continuation"]["generation"], 1)
                verified = json.loads(
                    self.run_helper(
                        "verify-incident-continuation",
                        "--run-id",
                        str(run_id),
                        "--predecessor-run-json",
                        str(predecessor),
                        "--policy-json",
                        self.policy_json,
                        "--repository",
                        self.repository,
                        "--current-master",
                        self.control,
                        "--workflow-id",
                        self.workflow_id,
                        "--workflow-blob-sha",
                        self.workflow_blob,
                        *self.authority_args(),
                    ).stdout
                )
                self.assertEqual(verified["generation"], 1)
                self.assertEqual(self.consume(run_id)["state"], "consumed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
