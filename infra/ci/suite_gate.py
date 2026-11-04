#!/usr/bin/env python3
"""Decide whether a heavy contract suite must run for the current CI diff.

Usage: suite_gate.py <suite-path>. Exit 0 runs the suite; exit 3 skips it.

A suite is skipped only for a GitHub Actions pull_request or push whose
first-parent diff touches none of the suite's inputs. Inputs are the suite,
the files it names, and, transitively, the files named by non-test scripts it
names. Anything uncertain runs the suite: BETSTAN_CI_FULL=1, another event,
a local run or a copied tree outside GITHUB_WORKSPACE, a missing parent commit, a change under infra/ci/, or a changed
infra or workflow file that no guarded suite references. A suite started by an
already running guarded suite always runs.
"""
import os
import pathlib
import subprocess
import sys

SKIP = 3
ROOT = pathlib.Path(__file__).resolve().parents[2]
GUARD_MARKER = "# Skip when the CI diff cannot affect this suite (infra/ci/suite_gate.py)."
GENERIC_NAMES = {
    ".dockerignore", "Dockerfile", "app.js", "app.ts", "index.js", "index.ts",
    "package.json", "package-lock.json", "tsconfig.json",
}
SCRIPT_SUFFIXES = (".sh", ".py", ".js")


def git(*args):
    return subprocess.run(
        ["git", "-C", str(ROOT), *args], check=True, capture_output=True, text=True,
    ).stdout


def is_suite(path):
    name = path.rsplit("/", 1)[-1]
    return name.startswith(("test-", "test_")) or name.endswith(("contract.sh", "contracts.sh"))


def read(path):
    try:
        return (ROOT / path).read_text(errors="ignore")
    except OSError:
        return ""


class Inputs:
    def __init__(self, tracked):
        self.files = {
            path for path in tracked
            if not path.endswith(".md") and not path.startswith("infra/azure/archive/")
        }
        self.by_name = {}
        for path in sorted(self.files):
            name = path.rsplit("/", 1)[-1]
            if len(name) >= 6 and name not in GENERIC_NAMES:
                self.by_name.setdefault(name, []).append(path)
        self.refs = {}

    def direct(self, path):
        if path not in self.refs:
            text = read(path)
            self.refs[path] = [p for name, paths in self.by_name.items() if name in text for p in paths]
        return self.refs[path]

    def closure(self, suite):
        seen, queue = {suite}, [suite]
        while queue:
            for ref in self.direct(queue.pop()):
                if ref not in seen:
                    seen.add(ref)
                    if ref.endswith(SCRIPT_SUFFIXES) and not is_suite(ref):
                        queue.append(ref)
        return seen


def changed_paths():
    head = git("rev-parse", "HEAD").strip()
    has_parent = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "-q", "--verify", "HEAD^1"], capture_output=True,
    ).returncode == 0
    if not has_parent:
        subprocess.run(
            ["git", "-C", str(ROOT), "fetch", "--no-tags", "-q", "--depth=2", "origin", head],
            capture_output=True, timeout=120,
        )
    return git("diff", "--no-renames", "--name-only", "HEAD^1", "HEAD").splitlines()


def decide(suite_arg):
    if os.environ.get("BETSTAN_CI_FULL") == "1":
        return "run", "full-requested"
    if os.environ.get("BETSTAN_SUITE_GATE_PASSED") == "1":
        return "run", "nested"
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("GITHUB_EVENT_NAME") not in {"pull_request", "push"}
    ):
        return "run", "unscoped-event"
    workspace = os.environ.get("GITHUB_WORKSPACE", "")
    if not workspace or pathlib.Path(workspace).resolve() != ROOT:
        return "run", "not-workspace"
    try:
        if pathlib.Path(git("rev-parse", "--show-toplevel").strip()).resolve() != ROOT:
            return "run", "not-repository"
        suite = pathlib.Path(suite_arg).resolve().relative_to(ROOT).as_posix()
        changed = changed_paths()
        tracked = git("ls-files").splitlines()
    except (OSError, ValueError, subprocess.SubprocessError):
        return "run", "diff-unavailable"
    if any(path.startswith("infra/ci/") for path in changed):
        return "run", "gate-changed"
    # Deleted paths stay matchable so removing a suite input still runs it.
    inputs = Inputs(tracked + changed)
    hits = [path for path in changed if path in inputs.closure(suite)]
    if hits:
        return "run", "input-changed:" + ",".join(hits[:3])
    guarded = [
        path for path in sorted(inputs.files)
        if path.startswith("infra/") and not path.startswith("infra/ci/")
        and path.endswith(SCRIPT_SUFFIXES) and GUARD_MARKER in read(path)
    ]
    known = set().union(*(inputs.closure(path) for path in guarded))
    unknown = [
        path for path in changed
        if path in inputs.files and path.startswith(("infra/", ".github/workflows/")) and path not in known
    ]
    if unknown:
        return "run", "unclassified:" + ",".join(unknown[:3])
    return "skip", f"no-input-changed changed={len(changed)}"


def main():
    if len(sys.argv) != 2:
        print("usage: suite_gate.py <suite-path>", file=sys.stderr)
        return 2
    verdict, reason = decide(sys.argv[1])
    if reason != "nested":
        print(f"suite_gate={verdict} suite={sys.argv[1]} reason={reason}", file=sys.stderr)
    return SKIP if verdict == "skip" else 0


if __name__ == "__main__":
    sys.exit(main())
