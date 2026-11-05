#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

python3 - "$ROOT_DIR" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1]).resolve()
agents = root / ".github/agents"
roles = {
    path.name.removeprefix("betstan-").removesuffix(".agent.md"): path
    for path in agents.glob("*.agent.md")
}
expected = {
    "architect", "simplifier", "backend-developer", "frontend-developer",
    "test-engineer", "service-contract-reviewer",
    "auth-security-reviewer", "ux-ui-expert", "deployment-safety",
    "oci-operator", "domain-ingress", "mongo-migration",
    "public-wiki-editor",
}
manual_expected = {
    "oci-operator", "domain-ingress", "mongo-migration",
}
if set(roles) != expected:
    raise SystemExit("supported agent inventory changed")

manual = set()
for role, path in roles.items():
    text = path.read_text(encoding="utf-8")
    parts = text.split("---", 2)
    if len(parts) != 3 or parts[0]:
        raise SystemExit(f"{path.name}: missing frontmatter")
    frontmatter = parts[1]
    name = re.search(r"^name:\s*(\S+)\s*$", frontmatter, re.M)
    if not name or name[1] != path.name.removesuffix(".agent.md"):
        raise SystemExit(f"{path.name}: filename/name mismatch")
    if re.search(r"^disable-model-invocation:\s*true\s*$", frontmatter, re.M):
        manual.add(role)
    if role == "ux-ui-expert" and not re.search(
        r"^tools:\s*\[read,\s*search\]\s*$", frontmatter, re.M
    ):
        raise SystemExit("UX gained execution or editing authority")
    if role == "simplifier" and re.search(r"^model:", frontmatter, re.M):
        raise SystemExit("simplifier must remain model-neutral")
if manual != manual_expected:
    raise SystemExit("manual-invocation restrictions changed")
if len(roles["deployment-safety"].read_text(encoding="utf-8").splitlines()) > 150:
    raise SystemExit("deployment safety guidance exceeded the concise role contract")
if len((root / "LEARNINGS.md").read_text(encoding="utf-8").splitlines()) > 200:
    raise SystemExit("working learnings exceeded 200 lines; retain history in the wiki")

sources = [
    root / ".github/copilot-instructions.md",
    agents / "README.md",
    root / ".github/skills/betstan-branch-governance/SKILL.md",
    root / "LEARNINGS.md",
]
for source in sources:
    text = source.read_text(encoding="utf-8")
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        target = target.split("#", 1)[0].split("?", 1)[0]
        resolved = (source.parent / target).resolve()
        if not resolved.is_relative_to(root) or not resolved.exists():
            raise SystemExit(f"{source.name}: invalid repository link {target}")

readme = (agents / "README.md").read_text(encoding="utf-8")
for path in roles.values():
    if path.name.removesuffix(".agent.md") not in readme:
        raise SystemExit(f"{path.name}: capability missing from routing")

def require(path, *outcomes):
    text = " ".join(path.read_text(encoding="utf-8").split())
    for outcome in outcomes:
        if outcome not in text:
            raise SystemExit(f"{path.relative_to(root)}: missing {outcome}")

# Policy assertions cover retained responsibilities, not a prescribed sequence.
require(
    agents / "README.md",
    "one accountable owner",
    "Changes to trust or state boundaries require independent verification",
    "The verifier must not be the author",
    "Current executable controls remain authoritative until a proven cutover",
    "Do not rerun unchanged tests",
)
require(
    root / "CONTRIBUTING.md",
    "Never push directly to `dev`",
    "Never commit or push directly to it",
    "Use ancestry-preserving merges",
    "Every other PR requires `APPROVED_SHA` equal to its exact current head",
    "CLI-created and CLI-owned",
    "without a separate personal prompt",
    "immutable deployed identity",
    "physical single-writer locks/fences",
    "data integrity",
    "compatible recovery",
    "observed health",
)
require(
    agents / "README.md",
    "main owner also owns coordination",
    "one active observer per wait",
    "thirty minutes",
    "Timeout, runner exit or lease expiry is not proof that a writer stopped",
    "Never edit live authority",
)
require(
    root / "docs/copilot-security-guardrails.md",
    "Never commit sensitive information",
    "human-origin work requires exact approval",
    "policy edits grant no production permissions",
)
require(
    agents / "betstan-public-wiki-editor.agent.md",
    "Never publish credentials",
    "byte-identical publication",
    "This editor does not perform Git or publication actions",
)
require(
    root / ".github/pull_request_template.md",
    "## Why this change exists",
    "## Exact source and ancestry",
    "## Scope and compatibility",
    "## Validation",
    "## Release and rollback",
    "## Exceptions and remaining work",
    "Independent verification for changed trust/state boundaries",
    "Reused evidence",
)

# Domain safeguards survive routing consolidation; their executable tests
# remain with the package, authorization, migration and release implementations.
require(
    agents / "betstan-service-contract-reviewer.agent.md",
    "state both versions and never substitute one for the other",
    "a shared contract requires every genuine consumer",
)
require(
    agents / "betstan-test-engineer.agent.md",
    "Never use `npm install --no-save <tarball>` as evidence",
    "Prove Backoffice quiesces first and restores last",
)
require(
    agents / "betstan-deployment-safety.agent.md",
    "exact candidate Auth and Client images plus a valid candidate-prefix/baseline-suffix split",
    "do not apply an AKS journal requirement to an OCI release",
    "compatibility readers and manifest bindings needed by supported old images",
    "drain durable pending publications before incompatible image rollback",
    "Keep retained-maintenance version/FCV/digest finalization",
    "Preserve failed-run locks/fences and use compatible recovery",
    "complete production inventory",
    "Only executable classifiers may exclude proven records",
    "no run-ID exclusion or age-based shortcut",
    "Unknown dispatch/approval outcomes require the supported resume or reconciliation transition",
    "canonical automatic approval without a personal prompt",
)
require(
    agents / "betstan-oci-operator.agent.md",
    "Repository-only implementation uses its exact source/diff contract and performs no live baseline or provider operation",
)
require(
    agents / "betstan-oci-operator.agent.md",
    "For OKE, verify the kubeconfig exec arguments contain the exact cluster OCID",
    "For k3s, verify the recorded instance/runtime identity",
    "A health-only assignment grants no mutation authority",
)
require(
    agents / "betstan-mongo-migration.agent.md",
    "Require exact in-AKS source/target server-version and FCV compatibility",
    "The unattended recovery identity remains stop-only",
    "After `cutover-committed`, recover forward only",
)
PY

echo "agent_governance_contract=PASS"
