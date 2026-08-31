#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
AGENT_DIR="$ROOT_DIR/.github/agents"
INSTRUCTIONS="$ROOT_DIR/.github/copilot-instructions.md"
README="$AGENT_DIR/README.md"
SIMPLIFIER="$AGENT_DIR/betstan-simplifier.agent.md"
CONDUCTOR="$AGENT_DIR/betstan-conductor.agent.md"
FINAL_VALIDATOR="$AGENT_DIR/betstan-final-validator.agent.md"
BRANCH_REVIEWER="$AGENT_DIR/betstan-branch-governance-reviewer.agent.md"
PR_TEMPLATE="$ROOT_DIR/.github/pull_request_template.md"
CONTRIBUTING="$ROOT_DIR/CONTRIBUTING.md"
MERGE_SAFETY="$ROOT_DIR/infra/azure/agents/pr-merge-safety-stan.sh"

fail() {
  echo "agent governance contract failed: $*" >&2
  exit 1
}

require_literal() {
  local file="$1"
  local literal="$2"
  grep -Fq "$literal" "$file" ||
    fail "$(basename "$file") is missing: $literal"
}

require_flat_literal() {
  local file="$1"
  local literal="$2"
  local flattened
  flattened="$(tr '\n' ' ' <"$file" | tr -s '[:space:]' ' ')"
  grep -Fq "$literal" <<<"$flattened" ||
    fail "$(basename "$file") is missing: $literal"
}

[[ -f "$INSTRUCTIONS" ]] || fail ".github/copilot-instructions.md is missing"
instruction_lines="$(wc -l <"$INSTRUCTIONS" | tr -d ' ')"
(( instruction_lines <= 60 )) ||
  fail "copilot instructions exceed 60 lines: $instruction_lines"

python3 - "$INSTRUCTIONS" "$ROOT_DIR" <<'PY' ||
import os
import re
import sys

source = os.path.realpath(sys.argv[1])
root = os.path.realpath(sys.argv[2])
text = open(source, encoding="utf-8").read()
failures = []
for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
    if target.startswith(("http://", "https://", "mailto:", "#")):
        continue
    target = target.split("#", 1)[0].split("?", 1)[0]
    resolved = os.path.realpath(os.path.join(os.path.dirname(source), target))
    if os.path.commonpath([root, resolved]) != root:
        failures.append(f"link escapes repository: {target}")
    elif not os.path.exists(resolved):
        failures.append(f"missing link target: {target}")
if failures:
    raise SystemExit("; ".join(failures))
PY
  fail "copilot instructions contain an invalid repository link"

while IFS= read -r -d '' agent_file; do
  expected="$(basename "$agent_file" .agent.md)"
  actual="$(
    awk '
      NR == 1 && $0 == "---" { frontmatter = 1; next }
      frontmatter && $0 == "---" { exit }
      frontmatter && /^name:[[:space:]]*/ {
        sub(/^name:[[:space:]]*/, "")
        print
        exit
      }
    ' "$agent_file"
  )"
  [[ "$actual" == "$expected" ]] ||
    fail "agent filename/name mismatch: $expected != ${actual:-missing}"
done < <(find "$AGENT_DIR" -maxdepth 1 -type f -name '*.agent.md' -print0)

simplifier_count="$(
  find "$AGENT_DIR" -maxdepth 1 -type f -name '*simplifier*.agent.md' |
    wc -l |
    tr -d ' '
)"
[[ "$simplifier_count" == "1" ]] ||
  fail "expected one simplifier agent, found $simplifier_count"

if awk '
  NR == 1 && $0 == "---" { frontmatter = 1; next }
  frontmatter && $0 == "---" { exit }
  frontmatter { print }
' "$SIMPLIFIER" | grep -Eq '^model:[[:space:]]*'; then
  fail "simplifier must remain model-neutral"
fi

python3 - "$README" <<'PY' ||
import sys

text = open(sys.argv[1], encoding="utf-8").read()
tokens = [
    "1. `betstan-architect`",
    "2. `betstan-simplifier`",
    "3. **Developer gate**",
    "4. `betstan-validation-critic`",
    "5. `betstan-test-engineer`",
    "6. `betstan-final-validator`",
]
positions = [text.find(token) for token in tokens]
if any(position < 0 for position in positions) or positions != sorted(positions):
    raise SystemExit("universal quality chain is missing or out of order")
PY
  fail "agent README does not define the fixed quality chain"

for marker in \
  '## Work-unit taxonomy' \
  '## Canonical policy sources' \
  '## Three-model simplifier gate' \
  'infrastructure/governance implementation owner for its owned paths' \
  'distinct model families' \
  'requested_reasoning: high' \
  'synthesis_model_id' \
  'A `BLOCKED` pass is attempt evidence, not a completed family' \
  'SIMPLIFICATION_INCOMPLETE' \
  'SIMPLIFICATION_DISPUTED' \
  'Only `SIMPLIFICATION_READY` produces the single artifact' \
  'same agent conversation' \
  'bounded correction budget'; do
  require_literal "$README" "$marker"
done
require_flat_literal "$README" \
  'Start `betstan-conductor` before every unit whose result can block, approve, satisfy a gate, authorize mutation, or become dependency evidence'
require_flat_literal "$README" \
  'Every authority-bearing unit is registered regardless of synchronous or background execution'
require_flat_literal "$README" \
  'Every handoff preserves the original `root_task_authority_id`'

simplifier_flat="$(tr '\n' ' ' <"$SIMPLIFIER" | tr -s '[:space:]' ' ')"
for marker in \
  'three eligible reports from distinct model families' \
  'requested reasoning effort `high`' \
  'Request `xhigh` reasoning when supported' \
  'Never synthesize two reports as a degraded 2-of-3 result' \
  'a `BLOCKED` pass requires substitution and never counts toward the three' \
  '`REMOVE` requires unanimous support' \
  'Do not invent a simplification that no independent pass proposed' \
  'SIMPLIFICATION_READY' \
  'SIMPLIFICATION_DISPUTED' \
  'SIMPLIFICATION_INCOMPLETE'; do
  grep -Fq "$marker" <<<"$simplifier_flat" ||
    fail "simplifier contract is missing: $marker"
done

for marker in \
  'unit_class: quality-gate|intra-gate|specialist|supporting' \
  'logical_gate:' \
  'task_authority: <immutable-root-user-request-or-canonical-pr-reference>' \
  'root_task_authority_id: <stable-root-authority-id>' \
  'repository_id: <canonical-owner-repository-or-not-applicable>' \
  'workspace_root: <absolute-registered-worktree-or-not-applicable>' \
  'repository_root: <resolved-git-root-or-not-applicable>' \
  'expected_base_ref: <authoritative-git-ref-or-not-applicable>' \
  'expected_base_sha: <full-sha-or-not-applicable>' \
  'expected_head_ref: <authoritative-remote-or-pr-ref-or-not-applicable>' \
  'expected_head_sha: <full-sha-or-not-applicable>' \
  'expected_merge_base_sha: <full-sha-or-not-applicable>' \
  'expected_tree_sha: <full-git-tree-sha-or-not-applicable>' \
  'changed_paths_sha256: <canonical-compare-manifest-sha256-or-not-applicable>' \
  'evidence_scope: <all-changed-paths-or-explicit-paths-or-not-applicable>' \
  'policy_source_path: <repo-relative-path-or-not-applicable>' \
  'policy_source_sha: <full-sha-or-not-applicable>' \
  'max_attempts:' \
  'handoff_ack_due_at:' \
  'Never create status-only, summary-only, or handoff-only agents' \
  'Use background agents only for genuinely independent parallel work' \
  'three independent simplifier passes plus synthesis'; do
  require_literal "$CONDUCTOR" "$marker"
done
require_flat_literal "$CONDUCTOR" \
  'Never accept repository evidence from an ambient or sibling worktree'
require_flat_literal "$CONDUCTOR" \
  'Before any work unit starts whose output can block, approve, satisfy a gate, authorize mutation, or become dependency evidence, require one registration regardless of synchronous/background execution or expected duration'
require_literal "$CONDUCTOR" '`STALE_EVIDENCE`'
require_flat_literal "$CONDUCTOR" \
  '`task_authority` is the immutable root user request that names the target workspace and refs'
require_flat_literal "$CONDUCTOR" \
  'It never changes during the workflow'
require_flat_literal "$CONDUCTOR" \
  'Every downstream handoff carries the same `root_task_authority_id`'
require_flat_literal "$CONDUCTOR" \
  'it cannot redefine the repository, workspace, base, or head'
require_flat_literal "$CONDUCTOR" \
  'Before registration, the conductor derives repository identity, workspace, base, and head from the root authority'
require_flat_literal "$CONDUCTOR" \
  'caller-supplied registration values are comparisons, never the source of truth'
require_flat_literal "$CONDUCTOR" \
  'Any handoff or registration that breaks root-authority continuity is `STALE_EVIDENCE`'
require_flat_literal "$CONDUCTOR" \
  '`repository_id` is the canonical GitHub `owner/repository`'
require_flat_literal "$CONDUCTOR" \
  '`expected_base_ref` identifies the authoritative comparison source for a diff-based unit'
require_flat_literal "$CONDUCTOR" \
  '`expected_base_sha` is its immutable resolved value'
require_flat_literal "$CONDUCTOR" \
  '`expected_head_ref` identifies the authoritative remote branch or PR head'
require_flat_literal "$CONDUCTOR" \
  '`expected_merge_base_sha` is the canonical merge base for diff review'
require_flat_literal "$CONDUCTOR" \
  '`expected_tree_sha` is the immutable Git tree for `expected_head_sha`'
require_flat_literal "$CONDUCTOR" \
  '`changed_paths_sha256` hashes the NUL-delimited name/status manifest returned by `git diff --name-status -z <merge-base> <head>`'
require_flat_literal "$CONDUCTOR" \
  '`evidence_scope` is either every changed path or an explicit subset that cannot approve outside that subset'
require_flat_literal "$CONDUCTOR" \
  '`policy_source_path` names the repository-relative canonical policy file'
require_flat_literal "$CONDUCTOR" \
  '`policy_source_sha` is that file'
require_flat_literal "$CONDUCTOR" \
  'Any repository-derived result that can block, approve, or authorize mutation must be produced from a clean committed snapshot'
require_flat_literal "$CONDUCTOR" \
  'The conductor itself runs `git -C <workspace_root>` probes for the Git top level, `HEAD`, `HEAD^{tree}`, porcelain status, hidden index flags, submodule state, and ancestry at registration and immediately before acceptance'
require_flat_literal "$CONDUCTOR" \
  'independently queries the exact `repository_id` through the GitHub API at those same two checkpoints'
require_flat_literal "$CONDUCTOR" \
  'exact `repository_id` through the GitHub API at those same two checkpoints to resolve the base/head refs, commit tree, merge base, and policy blob'
require_flat_literal "$CONDUCTOR" \
  'fresh isolated bare object store with no alternates, grafts, or replacement refs'
require_flat_literal "$CONDUCTOR" \
  'Every tree, ancestry, diff, and blob command runs with `GIT_NO_REPLACE_OBJECTS=1`'
require_flat_literal "$CONDUCTOR" \
  'derives the complete changed-path manifest there from the registered merge base and head'
require_flat_literal "$CONDUCTOR" \
  'a capped, partial, or otherwise unprovably complete provider file list is unverifiable'
require_flat_literal "$CONDUCTOR" \
  'never treats a local remote alias or tracking ref as authority'
require_flat_literal "$CONDUCTOR" \
  'verifies every evidence-scope file against its canonical blob'
require_flat_literal "$CONDUCTOR" \
  'An all-changed-files gate must consume the complete unfiltered canonical compare manifest'
require_flat_literal "$CONDUCTOR" \
  'Uncommitted advisory review may propose changes, but it cannot satisfy a quality, merge, deployment, or approval gate until rerun on a clean commit'
require_flat_literal "$CONDUCTOR" \
  'For units that interpret neither repository code nor policy, every Git provenance field is `not-applicable`'
require_flat_literal "$CONDUCTOR" \
  'Immediately before accepting or consuming the result, the conductor also audits the registered agent runtime'
require_flat_literal "$CONDUCTOR" \
  'Every repository file access must resolve under `workspace_root`'
require_flat_literal "$CONDUCTOR" \
  'every repository command must record that root as its working directory or use an explicit `git -C <workspace_root>`'
require_flat_literal "$CONDUCTOR" \
  'Diff-based reads and commands must use the registered `expected_merge_base_sha..expected_head_sha` endpoints'
require_flat_literal "$CONDUCTOR" \
  'equivalent to Git'
require_flat_literal "$CONDUCTOR" \
  'If tool-path, comparison-range, or changed-path coverage evidence is unavailable, the result is unverifiable'
require_flat_literal "$CONDUCTOR" \
  'Local test output is advisory only and cannot satisfy the test gate'
require_flat_literal "$CONDUCTOR" \
  'require trusted CI bound to the canonical exact commit'
require_flat_literal "$CONDUCTOR" \
  'Merge or deployment authority always requires those trusted exact-SHA checks'
require_flat_literal "$CONDUCTOR" \
  'Authority-bearing code and policy conclusions must read immutable Git objects'
require_flat_literal "$CONDUCTOR" \
  'using an exact-SHA GitHub API request, `git show <sha>:<path>`, or the registered merge-base/head object diff'
require_flat_literal "$CONDUCTOR" \
  'A mutable working-file read is advisory only'
require_flat_literal "$CONDUCTOR" \
  'any authoritative citation must be reproducible from the registered canonical objects'
require_flat_literal "$CONDUCTOR" \
  'A missing required provenance value, failed probe, or mismatch is `STALE_EVIDENCE`'
require_flat_literal "$CONDUCTOR" \
  'it cannot block, approve, authorize mutation, satisfy a gate, or become dependency evidence anywhere'
require_flat_literal "$CONDUCTOR" \
  'Return one bounded correction to the same agent context naming the exact worktree and SHAs'
require_flat_literal "$CONDUCTOR" \
  'if it repeats the mismatch, close that advisory result as unavailable'
require_flat_literal "$CONDUCTOR" \
  'Every other PR remains approval-bound to its exact current head SHA'

require_flat_literal "$FINAL_VALIDATOR" \
  'three distinct model families whose pass statuses are'
require_flat_literal "$FINAL_VALIDATOR" \
  'the single synthesized simplifier artifact and its three sealed pass records'
require_flat_literal "$FINAL_VALIDATOR" \
  'one `SIMPLIFICATION_READY` synthesis'
require_literal "$FINAL_VALIDATOR" '`SIMPLIFICATION_INCOMPLETE` or `SIMPLIFICATION_DISPUTED`'
require_literal "$BRANCH_REVIEWER" '`master` is the GitHub default and production branch'
require_flat_literal "$BRANCH_REVIEWER" \
  'while `dev` is the protected integration branch'

for heading in \
  '## Why this change exists' \
  '## Exact source and ancestry' \
  '## Scope and compatibility' \
  '## Validation' \
  '## Release and rollback' \
  '## Exceptions and remaining work'; do
  require_literal "$PR_TEMPLATE" "$heading"
done

contributing_flat="$(tr '\n' ' ' <"$CONTRIBUTING" | tr -s '[:space:]' ' ')"
grep -Fq 'Every other PR requires `APPROVED_SHA` equal to its exact current head' \
  <<<"$contributing_flat" ||
  fail "CONTRIBUTING.md does not require exact-head human approval"
grep -Fq 'operational convention' <<<"$contributing_flat" ||
  fail "CONTRIBUTING.md does not disclose the label-only limitation"
require_literal "$MERGE_SAFETY" 'human approval requires APPROVED_SHA='

echo "agent_governance_contract=PASS"
