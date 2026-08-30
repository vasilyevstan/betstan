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
  'max_attempts:' \
  'handoff_ack_due_at:' \
  'Never create status-only, summary-only, or handoff-only agents' \
  'Use background agents only for genuinely independent parallel work' \
  'three independent simplifier passes plus synthesis'; do
  require_literal "$CONDUCTOR" "$marker"
done
require_flat_literal "$CONDUCTOR" \
  'Every other PR remains approval-bound to its exact current head SHA'

require_flat_literal "$FINAL_VALIDATOR" \
  'three distinct model families whose pass statuses are'
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
