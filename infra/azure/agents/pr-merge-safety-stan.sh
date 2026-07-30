#!/usr/bin/env bash
set -euo pipefail

# Purpose: enforce branch policy and give a conservative merge recommendation.
# Usage:
#   ./infra/azure/agents/pr-merge-safety-stan.sh 41
#   APPROVED_SHA=<sha> APPROVED_WORKFLOWS=production-build,production-deploy \
#     ./infra/azure/agents/pr-merge-safety-stan.sh 41

REPO="${REPO:-vasilyevstan/betstan}"
PR_NUMBER="${1:-${PR:-}}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "usage: $0 <pr-number>" >&2
  exit 1
fi

section() {
  printf '\n=== %s ===\n' "$1"
}

fail() {
  section "recommendation"
  echo "safe_to_merge=no"
  echo "reason=$*"
  exit 1
}

meta_json="$(
  gh pr view "$PR_NUMBER" --repo "$REPO" \
    --json number,title,state,mergeable,mergeStateStatus,headRefName,headRefOid,headRepository,baseRefName,baseRefOid,url
)"
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
state="$(python3 - <<'PY' "$meta_json"
import json,sys
print(json.loads(sys.argv[1]).get("state",""))
PY
)"
head_ref="$(python3 - <<'PY' "$meta_json"
import json,sys
print(json.loads(sys.argv[1]).get("headRefName",""))
PY
)"
head_sha="$(python3 - <<'PY' "$meta_json"
import json,sys
print(json.loads(sys.argv[1]).get("headRefOid",""))
PY
)"
base_ref="$(python3 - <<'PY' "$meta_json"
import json,sys
print(json.loads(sys.argv[1]).get("baseRefName",""))
PY
)"
base_sha="$(python3 - <<'PY' "$meta_json"
import json,sys
print(json.loads(sys.argv[1]).get("baseRefOid",""))
PY
)"
merge_state="$(python3 - <<'PY' "$meta_json"
import json,sys
print(json.loads(sys.argv[1]).get("mergeStateStatus",""))
PY
)"
head_repository="$(python3 - <<'PY' "$meta_json"
import json,sys
repo=json.loads(sys.argv[1]).get("headRepository") or {}
print(repo.get("nameWithOwner",""))
PY
)"

section "pr"
echo "title=$title"
echo "state=$state"
echo "mergeable=$mergeable"
echo "merge_state=$merge_state"
echo "head_ref=$head_ref"
echo "head_sha=$head_sha"
echo "head_repository=$head_repository"
echo "base_ref=$base_ref"
echo "base_sha=$base_sha"

[[ "$state" == "OPEN" ]] || fail "pull request is not open"
[[ "$mergeable" == "MERGEABLE" ]] || fail "pull request is not currently mergeable"

BASE_REF="$base_ref" HEAD_REF="$head_ref" REPOSITORY="$REPO" \
  HEAD_REPOSITORY="$head_repository" \
  ./infra/azure/agents/branch-policy-guard-stan.sh || fail "branch policy rejected the pull request"

REPO="$REPO" EXPECTED_HEAD_SHA="$head_sha" EXPECTED_BASE_SHA="$base_sha" \
  ./infra/azure/agents/pr-validation-stan.sh "$PR_NUMBER" ||
  fail "exact-head-SHA validation still has failed or incomplete jobs"

if [[ "$base_ref" == "master" ]]; then
  [[ "$head_repository" == "$REPO" ]] ||
    fail "production promotion must use this repository's dev branch"
  [[ "$merge_state" != "BEHIND" && "$merge_state" != "DIRTY" && "$merge_state" != "UNKNOWN" ]] ||
    fail "production promotion is not current with master merge_state=$merge_state"
  compare_status="$(
    gh api "repos/$REPO/compare/${base_sha}...${head_sha}" --jq '.status'
  )"
  [[ "$compare_status" == "ahead" || "$compare_status" == "identical" ]] ||
    fail "current master tip is not an ancestor of the promotion head status=$compare_status"
  [[ "${APPROVED_SHA:-}" == "$head_sha" ]] ||
    fail "production promotion requires APPROVED_SHA=$head_sha"
  expected_workflows="$(
    REPO="$REPO" PR="$PR_NUMBER" EXPECTED_HEAD_SHA="$head_sha" \
      ./infra/azure/agents/production-workflow-inventory-stan.sh |
      sed -n 's/^production_workflows=//p'
  )"
  approved_workflows="$(
    tr ',' '\n' <<<"${APPROVED_WORKFLOWS:-}" |
      sed '/^$/d' |
      LC_ALL=C sort -u |
      paste -sd, -
  )"
  [[ "$approved_workflows" == "$expected_workflows" ]] ||
    fail "production workflow approval mismatch expected=$expected_workflows approved=${approved_workflows:-none}"
fi

latest_json="$(
  gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid,baseRefOid
)"
latest_head_sha="$(python3 - <<'PY' "$latest_json"
import json,sys
print(json.loads(sys.argv[1]).get("headRefOid",""))
PY
)"
latest_base_sha="$(python3 - <<'PY' "$latest_json"
import json,sys
print(json.loads(sys.argv[1]).get("baseRefOid",""))
PY
)"
[[ "$latest_head_sha" == "$head_sha" && "$latest_base_sha" == "$base_sha" ]] ||
  fail "pull request changed while safety gates were running"

section "recommendation"
echo "safe_to_merge=yes"
echo "reason=branch policy, mergeability, exact-SHA validation, and required approval gates passed"
