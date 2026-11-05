#!/usr/bin/env python3
"""Fixture tests for infra/ci/suite_gate.py and the guard embedded in suites."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

REPO = pathlib.Path(__file__).resolve().parents[2]
GATE = REPO / "infra/ci/suite_gate.py"
GUARD = (
    "# Skip when the CI diff cannot affect this suite (infra/ci/suite_gate.py).\n"
    'betstan_gate="$(dirname "${BASH_SOURCE[0]}")/../../ci/suite_gate.py"; betstan_gate_rc=0\n'
    '[[ ! -f "$betstan_gate" ]] || python3 -I "$betstan_gate" "${BASH_SOURCE[0]}" || betstan_gate_rc=$?\n'
    '[[ "$betstan_gate_rc" != 3 ]] || exit 0; [[ "$betstan_gate_rc" == 0 ]] || exit "$betstan_gate_rc"; '
    "export BETSTAN_SUITE_GATE_PASSED=1\n"
)
SUITE = "infra/oci/tests/test-alpha-suite.sh"
BASE_FILES = {
    SUITE: "#!/usr/bin/env bash\nset -euo pipefail\n" + GUARD
    + 'echo "body-ran nested=${BETSTAN_SUITE_GATE_PASSED:-}"\n# uses helper-alpha.sh\n',
    "infra/oci/scripts/helper-alpha.sh": "#!/usr/bin/env bash\ncat deep-input.json\n",
    "infra/oci/scripts/deep-input.json": "{}\n",
    "infra/oci/scripts/unrelated-tool.sh": "#!/usr/bin/env bash\ntrue\n",
    "infra/oci/README.md": "docs\n",
    "services/app/src/feature.ts": "export const a = 1;\n",
}
GIT_ENV = {
    "GIT_AUTHOR_NAME": "fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
    "GIT_COMMITTER_NAME": "fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
}


class SuiteGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name).resolve() / "repo"
        for path, text in BASE_FILES.items():
            self.write(path, text)
        (self.root / "infra/ci").mkdir(parents=True)
        shutil.copy(GATE, self.root / "infra/ci/suite_gate.py")
        self.git("init", "-q")
        self.commit("base")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True,
                       env={**os.environ, **GIT_ENV})

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)

    def change(self, path, text="changed\n"):
        self.write(path, text)
        self.commit("change " + path)

    def env(self, **overrides):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("BETSTAN_", "GITHUB_"))}
        env.update(GIT_ENV, GITHUB_ACTIONS="true", GITHUB_EVENT_NAME="pull_request",
                   GITHUB_WORKSPACE=str(self.root))
        env.update(overrides)
        return {k: v for k, v in env.items() if v is not None}

    def gate(self, **overrides):
        result = subprocess.run(
            ["python3", "-I", str(self.root / "infra/ci/suite_gate.py"), str(self.root / SUITE)],
            capture_output=True, text=True, env=self.env(**overrides), timeout=60,
        )
        return result.returncode, result.stderr

    def assertGate(self, code, reason, **overrides):
        actual, stderr = self.gate(**overrides)
        self.assertEqual(actual, code, stderr)
        self.assertIn("reason=" + reason, stderr)

    def test_app_only_diff_skips(self):
        self.change("services/app/src/feature.ts")
        self.assertGate(3, "no-input-changed")

    def test_push_app_only_diff_skips(self):
        self.change("services/app/src/feature.ts")
        self.assertGate(3, "no-input-changed", GITHUB_EVENT_NAME="push")

    def test_docs_only_infra_diff_skips(self):
        self.change("infra/oci/README.md")
        self.assertGate(3, "no-input-changed")

    def test_suite_change_runs(self):
        self.change(SUITE, BASE_FILES[SUITE] + "# edit\n")
        self.assertGate(0, "input-changed:" + SUITE)

    def test_transitive_input_change_runs(self):
        self.change("infra/oci/scripts/deep-input.json")
        self.assertGate(0, "input-changed:infra/oci/scripts/deep-input.json")

    def test_deleted_input_runs(self):
        (self.root / "infra/oci/scripts/helper-alpha.sh").unlink()
        self.commit("delete helper")
        self.assertGate(0, "input-changed:infra/oci/scripts/helper-alpha.sh")

    def test_unclassified_infra_change_runs(self):
        self.change("infra/oci/scripts/unrelated-tool.sh")
        self.assertGate(0, "unclassified:infra/oci/scripts/unrelated-tool.sh")

    def test_unclassified_workflow_change_runs(self):
        self.change(".github/workflows/other.yml")
        self.assertGate(0, "unclassified:.github/workflows/other.yml")

    def test_gate_change_runs(self):
        self.change("infra/ci/notes.txt")
        self.assertGate(0, "gate-changed")

    def test_full_request_runs(self):
        self.change("services/app/src/feature.ts")
        self.assertGate(0, "full-requested", BETSTAN_CI_FULL="1")

    def test_local_and_other_events_run(self):
        self.change("services/app/src/feature.ts")
        self.assertGate(0, "unscoped-event", GITHUB_ACTIONS=None)
        self.assertGate(0, "unscoped-event", GITHUB_EVENT_NAME="workflow_dispatch")

    def test_copied_tree_outside_workspace_runs(self):
        self.change("services/app/src/feature.ts")
        self.assertGate(0, "not-workspace", GITHUB_WORKSPACE=str(REPO))

    def test_missing_parent_runs(self):
        shutil.rmtree(self.root / ".git")
        self.git("init", "-q")
        self.commit("root only")
        self.assertGate(0, "diff-unavailable")

    def test_concurrent_shallow_fetches_skip_unaffected_suite(self):
        self.change("services/app/src/feature.ts")
        clone = self.root.parent / "shallow"
        subprocess.run(
            ["git", "clone", "-q", "--depth=1", self.root.as_uri(), str(clone)],
            check=True, capture_output=True, env=self.env(),
        )
        self.root = clone
        start = Barrier(8)

        def select_suite(_):
            start.wait(timeout=60)
            return self.gate()

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(select_suite, range(8)))
        for code, stderr in results:
            self.assertEqual(code, 3, stderr)
            self.assertIn("reason=no-input-changed", stderr)

    def test_nested_suite_runs_silently(self):
        self.change("services/app/src/feature.ts")
        code, stderr = self.gate(BETSTAN_SUITE_GATE_PASSED="1")
        self.assertEqual((code, stderr), (0, ""))

    def test_embedded_guard_skips_or_runs_body(self):
        self.change("services/app/src/feature.ts")
        skipped = subprocess.run(["bash", str(self.root / SUITE)], capture_output=True,
                                 text=True, env=self.env(), timeout=60)
        self.assertEqual((skipped.returncode, skipped.stdout), (0, ""), skipped.stderr)
        ran = subprocess.run(["bash", str(self.root / SUITE)], capture_output=True,
                             text=True, env=self.env(BETSTAN_CI_FULL="1"), timeout=60)
        self.assertEqual((ran.returncode, ran.stdout), (0, "body-ran nested=1\n"), ran.stderr)

    def test_repository_guards_match_canonical_text(self):
        tracked = subprocess.run(["git", "-C", str(REPO), "ls-files", "infra"], check=True,
                                 capture_output=True, text=True).stdout.splitlines()
        guarded = []
        for path in tracked:
            if path.startswith(("infra/ci/", "infra/azure/archive/")) or not path.endswith(".sh"):
                continue
            text = (REPO / path).read_text(errors="ignore")
            if GUARD.splitlines()[0] in text or "betstan_gate" in text:
                guarded.append(path)
                self.assertTrue(text.startswith("#!/usr/bin/env bash\nset -euo pipefail\n" + GUARD), path)
        self.assertGreaterEqual(len(guarded), 11)


if __name__ == "__main__":
    unittest.main()
