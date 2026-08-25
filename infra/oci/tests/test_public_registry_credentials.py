#!/usr/bin/env python3
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
VERIFIER = ROOT / "infra/oci/scripts/verify-public-registry-credentials.sh"
DEPLOY = ROOT / "infra/oci/scripts/deploy.sh"
DATA_ROLLOUT = ROOT / "infra/oci/scripts/live-betting-data-rollout-stan.sh"


class PublicRegistryCredentialTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.bin = Path(self.temp.name)
        kubectl = self.bin / "kubectl"
        kubectl.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env bash
                set -euo pipefail
                if [[ "$*" == "get secret ocir-pull -n fixture --ignore-not-found -o name" ]]; then
                  case "${MOCK_SECRET_STATE:?}" in
                    absent) exit 0 ;;
                    present) echo secret/ocir-pull; exit 0 ;;
                    error) echo forbidden >&2; exit 9 ;;
                  esac
                fi
                if [[ "$*" == "get serviceaccount default -n fixture -o json" ]]; then
                  [[ "${MOCK_SERVICE_ACCOUNT_ERROR:-0}" == "0" ]] || exit 8
                  printf '%s\\n' '{"imagePullSecrets":[]}'
                  exit 0
                fi
                exit 2
                """
            )
        )
        kubectl.chmod(0o755)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_verifier(
        self, secret_state: str, service_account_error: bool = False
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin}{os.pathsep}{env['PATH']}",
                "OCI_K8S_NAMESPACE": "fixture",
                "MOCK_SECRET_STATE": secret_state,
                "MOCK_SERVICE_ACCOUNT_ERROR": (
                    "1" if service_account_error else "0"
                ),
            }
        )
        return subprocess.run(
            [str(VERIFIER)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_not_found_is_the_only_absent_secret_state(self) -> None:
        self.assertEqual(self.run_verifier("absent").returncode, 0)
        present = self.run_verifier("present")
        self.assertNotEqual(present.returncode, 0)
        self.assertIn("legacy OCIR application pull secret exists", present.stderr)
        api_error = self.run_verifier("error")
        self.assertNotEqual(api_error.returncode, 0)
        self.assertIn("could not determine whether", api_error.stderr)

    def test_service_account_api_error_is_fatal(self) -> None:
        result = self.run_verifier("absent", service_account_error=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not inspect the default service account", result.stderr)

    def test_both_mutation_paths_use_the_verifier_before_work(self) -> None:
        deploy = DEPLOY.read_text(encoding="utf-8")
        data_rollout = DATA_ROLLOUT.read_text(encoding="utf-8")
        marker = "verify-public-registry-credentials.sh"
        self.assertIn(marker, deploy)
        self.assertIn(marker, data_rollout)
        self.assertLess(
            deploy.index(marker),
            deploy.index("create secret generic jwt-secret"),
        )
        self.assertLess(
            data_rollout.index(marker),
            data_rollout.index("kubectl create -f -"),
        )


if __name__ == "__main__":
    unittest.main()
