#!/usr/bin/env python3
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "infra/oci/scripts/transition-k3s-cached-images.sh"
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
SOURCE_SHA = "1" * 40


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def env_values(path: Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in path.read_text().splitlines())


class TransitionRecoveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.work = Path(self.temp.name)
        self.bin = self.work / "bin"
        self.bin.mkdir()
        self.state_file = self.work / "state.json"
        self.infrastructure = self.work / "infrastructure.env"
        self.infrastructure.write_text(
            textwrap.dedent(
                """\
                runtime_mode=k3s
                instance_fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
                infrastructure_run_id=300
                infrastructure_run_attempt=1
                namespace=fixture
                public_host=betstan.xyz
                canonical_host=betstan.xyz
                redirect_host=www.betstan.xyz
                diagnostic_host=192.0.2.1.nip.io
                """
            )
        )
        self._write_kubectl_mock()
        self._reset_runtime()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _digest(self, value: int) -> str:
        return f"sha256:{value:064x}"

    def _old_ref(self, index: int, service: str) -> str:
        return (
            f"phx.ocir.io/tenant/betstan/{service}@"
            f"{self._digest(index + 101)}"
        )

    def _target_ref(self, index: int) -> str:
        return (
            "ghcr.io/vasilyevstan/betstan-images@"
            f"{self._digest(index + 1)}"
        )

    def _reset_runtime(self) -> None:
        state = {
            "images": {
                service: self._old_ref(index, service)
                for index, service in enumerate(SERVICES)
            },
            "queue_captures": 0,
        }
        self.state_file.write_text(json.dumps(state))

    def _create_recovery(self, run_id: int) -> Path:
        directory = self.work / f"recovery-{run_id}"
        directory.mkdir()
        rows = []
        for index, service in enumerate(SERVICES):
            digest = self._digest(index + 1)
            origin_digest = self._digest(index + 101)
            origin_platform = self._digest(index + 201)
            repository = "ghcr.io/vasilyevstan/betstan-images"
            tag = f"{repository}:arm64-{service}-{SOURCE_SHA}"
            image_ref = f"{repository}@{digest}"
            (directory / f"{service}.env").write_text(
                textwrap.dedent(
                    f"""\
                    schema=betstan.application-image-provenance.v1
                    registry_provider=ghcr
                    registry_host=ghcr.io
                    registry_tag_prefix=arm64
                    registry_tag_schema=v1
                    service={service}
                    repository={repository}
                    source_sha={SOURCE_SHA}
                    tag={tag}
                    digest={digest}
                    platform_digest={digest}
                    image_ref={image_ref}
                    platform=linux/arm64
                    build_run_id=10
                    build_run_attempt=1
                    build_workflow=oci-production-build
                    upstream_workflow=production-build
                    upstream_run_id=9
                    upstream_run_attempt=1
                    recovery_workflow=oci-ghcr-cache-recovery
                    recovery_run_id={run_id}
                    recovery_run_attempt=1
                    recovery_origin=containerd-cache
                    recovery_origin_repository=phx.ocir.io/tenant/betstan/{service}
                    recovery_origin_manifest_digest={origin_digest}
                    recovery_origin_platform_digest={origin_platform}
                    """
                )
            )
            rows.append(
                "\t".join((service, repository, image_ref, digest, digest))
            )
        images = directory / "images.tsv"
        images.write_text("\n".join(sorted(rows)) + "\n")
        (directory / "recovery-evidence.env").write_text(
            textwrap.dedent(
                f"""\
                schema=betstan.ghcr-cache-recovery.v1
                recovery_origin=containerd-cache
                registry_provider=ghcr
                registry_repository=ghcr.io/vasilyevstan/betstan-images
                anonymous_pull=pass
                source_sha={SOURCE_SHA}
                trusted_build_run_id=10
                trusted_upstream_run_id=9
                recovery_run_id={run_id}
                recovery_run_attempt=1
                images_sha256={sha256(images)}
                """
            )
        )
        return directory

    def _run(
        self,
        recovery: Path,
        run_id: int,
        phase: str,
        resume_run_id: int = 0,
        **extra: str,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin}{os.pathsep}{env['PATH']}",
                "APPLICATION_REGISTRY_PROVIDER": "ghcr",
                "APPLICATION_REGISTRY_HOST": "ghcr.io",
                "APPLICATION_REGISTRY_REPOSITORY": "vasilyevstan/betstan-images",
                "APPLICATION_REGISTRY_TAG_PREFIX": "arm64",
                "APPLICATION_REGISTRY_TAG_SCHEMA": "v1",
                "RECOVERY_DIR": str(recovery),
                "OUTPUT_DIR": str(recovery),
                "INFRA_PROVENANCE_FILE": str(self.infrastructure),
                "SOURCE_SHA": SOURCE_SHA,
                "RECOVERY_RUN_ID": str(run_id),
                "RECOVERY_RUN_ATTEMPT": "1",
                "RESUME_RECOVERY_RUN_ID": str(resume_run_id),
                "TRANSITION_PHASE": phase,
                "RETIRE_OCIR_REPOSITORY": "0",
                "OCI_K8S_NAMESPACE": "fixture",
                "ROLLOUT_TIMEOUT_SECONDS": "5",
                "MOCK_STATE": str(self.state_file),
            }
        )
        env.update(extra)
        return subprocess.run(
            [str(SCRIPT)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def _write_kubectl_mock(self) -> None:
        mock = self.bin / "kubectl"
        mock.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json
                import os
                import sys
                from pathlib import Path

                args = sys.argv[1:]
                state_path = Path(os.environ["MOCK_STATE"])
                state = json.loads(state_path.read_text())

                def save():
                    state_path.write_text(json.dumps(state))

                def service_from_deployment(value):
                    return value.removeprefix("deployment/").removeprefix("gaming-").removesuffix("-depl")

                if args[:2] == ["get", "deployment"]:
                    service = service_from_deployment(args[2])
                    image = state["images"][service]
                    if "jsonpath=" in " ".join(args):
                        print(image)
                    else:
                        print(json.dumps({
                            "spec": {"template": {"spec": {"containers": [{
                                "name": f"gaming-{service}", "image": image
                            }]}}}
                        }))
                    raise SystemExit(0)

                if args[:2] == ["get", "pods"]:
                    selector = args[args.index("-l") + 1]
                    service = selector.removeprefix("app=gaming-")
                    image = state["images"][service]
                    digest = image.rsplit("@", 1)[1]
                    print(json.dumps({"items": [{
                        "metadata": {"name": f"gaming-{service}-pod"},
                        "status": {"containerStatuses": [{
                            "name": f"gaming-{service}",
                            "ready": True,
                            "imageID": f"containerd://{image.rsplit('@', 1)[0]}@{digest}",
                        }]},
                    }]}))
                    raise SystemExit(0)

                if args[:3] == ["get", "serviceaccount", "default"]:
                    print(json.dumps({"imagePullSecrets": [{"name": "ocir-pull"}]}))
                    raise SystemExit(0)

                if args[:3] == ["get", "secret", "ocir-pull"]:
                    if os.environ.get("MOCK_SECRET_ERROR") == "1":
                        print("forbidden", file=sys.stderr)
                        raise SystemExit(9)
                    print(json.dumps({"type": "kubernetes.io/dockerconfigjson"}))
                    raise SystemExit(0)

                if args[:2] == ["get", "pod"]:
                    print("rabbitmq-0")
                    raise SystemExit(0)

                if args and args[0] == "exec":
                    state["queue_captures"] += 1
                    save()
                    queue = os.environ.get("MOCK_QUEUE_NAME", "original-queue")
                    print("name messages_ready messages_unacknowledged consumers")
                    print(f"{queue} 0 0 1")
                    raise SystemExit(0)

                if args[:2] == ["set", "image"]:
                    service = service_from_deployment(args[2])
                    state["images"][service] = args[3].split("=", 1)[1]
                    save()
                    raise SystemExit(0)

                if args[:2] == ["rollout", "status"]:
                    service = service_from_deployment(args[2])
                    if os.environ.get("MOCK_FAIL_SERVICE") == service:
                        raise SystemExit(1)
                    raise SystemExit(0)

                print(f"unexpected kubectl arguments: {args}", file=sys.stderr)
                raise SystemExit(2)
                """
            )
        )
        mock.chmod(0o755)

    def test_resume_preserves_original_plan_and_rabbitmq_baseline(self) -> None:
        first = self._create_recovery(100)
        planned = self._run(first, 100, "plan")
        self.assertEqual(planned.returncode, 0, planned.stderr)
        original_plan = (first / "transition-plan.tsv").read_bytes()
        original_baseline = (first / "rabbitmq-baseline.txt").read_bytes()
        for name in (
            "transition-plan.tsv",
            "rabbitmq-baseline.txt",
            "transition-plan-evidence.env",
        ):
            self.assertEqual(
                stat.S_IMODE((first / name).stat().st_mode), 0o600
            )

        partial = self._run(
            first, 100, "rebind", MOCK_FAIL_SERVICE="client"
        )
        self.assertNotEqual(partial.returncode, 0)

        second = self._create_recovery(200)
        for name in (
            "transition-plan.tsv",
            "rabbitmq-baseline.txt",
            "transition-plan-evidence.env",
        ):
            shutil.copy2(first / name, second / name)

        resumed_plan = self._run(
            second,
            200,
            "plan",
            resume_run_id=100,
            MOCK_QUEUE_NAME="recaptured-queue",
        )
        self.assertEqual(resumed_plan.returncode, 0, resumed_plan.stderr)
        self.assertEqual((second / "transition-plan.tsv").read_bytes(), original_plan)
        self.assertEqual(
            (second / "rabbitmq-baseline.txt").read_bytes(), original_baseline
        )
        state = json.loads(self.state_file.read_text())
        self.assertEqual(state["queue_captures"], 1)
        evidence = env_values(second / "transition-plan-evidence.env")
        self.assertEqual(evidence["plan_origin_recovery_run_id"], "100")
        self.assertEqual(evidence["plan_carrier_recovery_run_id"], "200")

        completed = self._run(second, 200, "rebind", resume_run_id=100)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        state = json.loads(self.state_file.read_text())
        for index, service in enumerate(SERVICES):
            self.assertEqual(state["images"][service], self._target_ref(index))
        rebind = env_values(second / "rebind-provenance.env")
        self.assertEqual(rebind["plan_origin_recovery_run_id"], "100")
        self.assertEqual(
            rebind["transition_plan_evidence_sha256"],
            sha256(second / "transition-plan-evidence.env"),
        )

    def test_secret_api_failure_is_not_treated_as_not_found(self) -> None:
        recovery = self._create_recovery(300)
        result = self._run(
            recovery, 300, "plan", MOCK_SECRET_ERROR="1"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "could not determine whether the OCIR pull secret exists",
            result.stderr,
        )
        state = json.loads(self.state_file.read_text())
        self.assertEqual(state["queue_captures"], 0)
        self.assertFalse((recovery / "transition-plan.tsv").exists())


if __name__ == "__main__":
    unittest.main()
