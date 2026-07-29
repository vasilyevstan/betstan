#!/usr/bin/env bash
set -euo pipefail

# Purpose: give a conservative merge-safe / split recommendation for a PR.
# Usage:
#   ./infra/azure/agents/pr-merge-safety-stan.sh 41

PR_NUMBER="${1:-${PR:-}}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "usage: $0 <pr-number>" >&2
  exit 1
fi

section() {
  printf '\n=== %s ===\n' "$1"
}

meta_json="$(gh pr view "$PR_NUMBER" --json number,title,state,mergeable,headRefName,baseRefName,url)"
mergeable="$(python3 - <<'PY' "$meta_json"
import json,sys
print(json.loads(sys.argv[1]).get("mergeable",""))
PY
)"
title="$(python3 - <<'PY' "$meta_json"
import json,sys
print(json.loads(sys.argv[1]).get("title",""))
PY
)"

section "pr"
echo "title=$title"
echo "mergeable=$mergeable"

if ./infra/azure/agents/pr-validation-stan.sh "$PR_NUMBER"; then
  section "recommendation"
  echo "safe_to_merge=yes"
  echo "reason=latest validation run is green"
else
  section "recommendation"
  echo "safe_to_merge=no"
  echo "reason=validation still has failing jobs"
  echo "decision=split recommended; merge only the deploy-recovery subset after the validation/test-harness subset is fixed"
  exit 1
fi
