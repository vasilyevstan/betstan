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
    "delivery-coordinator", "backend-developer", "frontend-developer",
    "test-engineer", "auth-security-reviewer", "ux-ui-expert",
    "deployment-safety", "oci-operator", "public-wiki-editor",
}
manual_expected = {"oci-operator"}
archived_migration = root / "archive/azure/github-agents/betstan-mongo-migration.md"
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
    if role == "delivery-coordinator" and re.search(r"^model:", frontmatter, re.M):
        raise SystemExit("coordinator must remain model-neutral")
    if role in {"test-engineer", "auth-security-reviewer", "ux-ui-expert"} and re.search(
        r"^tools:.*\bedit\b", frontmatter, re.M
    ):
        raise SystemExit(f"{role}: read-only verifier gained editing authority")
if manual != manual_expected:
    raise SystemExit("manual-invocation restrictions changed")
budgets = {path: 1600 for path in roles.values()}
budgets.update({
    agents / "README.md": 2600,
    root / "CONTRIBUTING.md": 7000,
    root / "LEARNINGS.md": 3500,
})
for path, limit in budgets.items():
    size = len(path.read_bytes())
    if size > limit:
        raise SystemExit(
            f"{path.relative_to(root)}: {size} bytes exceeds the {limit}-byte budget; "
            "link to canonical docs instead of restating them"
        )
if len((root / "LEARNINGS.md").read_text(encoding="utf-8").splitlines()) > 200:
    raise SystemExit("working learnings exceeded 200 lines; retain history in the wiki")

sources = [
    root / ".github/copilot-instructions.md",
    root / ".github/skills/betstan-branch-governance/SKILL.md",
    root / "CONTRIBUTING.md",
    root / "LEARNINGS.md",
    agents / "README.md",
    *roles.values(),
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

# Essential safety rules live once in canonical docs; role cards link to them.
require(
    root / "CONTRIBUTING.md",
    "Never commit or push directly to `dev` or `master`",
    "Use ancestry-preserving merges",
    "skipped, stale or pending checks are not success",
    "requires `APPROVED_SHA` equal to its exact current head",
    "without a separate personal prompt",
    "immutable deployed identity, physical single-writer locks/fences, data integrity, compatible recovery and observed health",
    "Preserve failed-run locks/fences; timeout or lease expiry is not proof that a writer stopped",
    "`https://betstan.xyz` is canonical",
    "Current executable controls remain authoritative",
)
require(
    agents / "README.md",
    "one accountable owner",
    "The verifier must not be the author",
    "Do not rerun unchanged tests",
)
require(
    root / "docs/copilot-security-guardrails.md",
    "Never commit sensitive information",
    "human-origin work requires exact approval",
    "policy edits grant no production permissions",
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
require(
    archived_migration,
    "disable-model-invocation: true",
    "Require exact in-AKS source/target server-version and FCV compatibility",
    "The unattended recovery identity remains stop-only",
    "After `cutover-committed`, recover forward only",
)
PY

echo "agent_governance_contract=PASS"
