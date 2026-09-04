#!/usr/bin/env bash
set -euo pipefail

# Purpose: enforce branch policy and give a conservative merge recommendation.
# Usage:
#   # Inspection-only human mode; for master it also prints production_workflows.
#   ./infra/azure/agents/pr-merge-safety-stan.sh 41
#   # After explicitly reviewing and copying that exact head SHA:
#   APPROVED_SHA=<sha> ./infra/azure/agents/pr-merge-safety-stan.sh 41
#   APPROVED_SHA=<sha> APPROVED_WORKFLOWS=production-build,production-deploy \
#     ./infra/azure/agents/pr-merge-safety-stan.sh 41
#   COPILOT_CLI_AUTO_APPROVE=true ./infra/azure/agents/pr-merge-safety-stan.sh 41

REPO="${REPO:-vasilyevstan/betstan}"
PR_NUMBER="${1:-${PR:-}}"
AUTO_APPROVE="${COPILOT_CLI_AUTO_APPROVE:-false}"
# Copilot CLI and human gh calls share one GitHub identity, so this label is an
# operational classifier rather than cryptographic provenance.
CLI_MANAGED_LABEL="${COPILOT_CLI_MANAGED_LABEL:-copilot-cli-managed}"
BRANCH_POLICY_GUARD="${BRANCH_POLICY_GUARD:-./infra/azure/agents/branch-policy-guard-stan.sh}"
PR_VALIDATOR="${PR_VALIDATOR:-./infra/azure/agents/pr-validation-stan.sh}"
WORKFLOW_INVENTORY="${WORKFLOW_INVENTORY:-./infra/azure/agents/production-workflow-inventory-stan.sh}"
PRODUCTION_RUN_EXCLUSIVITY="${PRODUCTION_RUN_EXCLUSIVITY:-./infra/azure/agents/production-run-exclusivity-stan.sh}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "usage: $0 <pr-number>" >&2
  exit 1
fi
[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || {
  echo "pull request number must be a positive integer" >&2
  exit 1
}
[[ "$AUTO_APPROVE" == "true" || "$AUTO_APPROVE" == "false" ]] || {
  echo "COPILOT_CLI_AUTO_APPROVE must be true or false" >&2
  exit 1
}

section() {
  printf '\n=== %s ===\n' "$1"
}

fail() {
  section "recommendation"
  echo "safe_to_merge=no"
  echo "reason=$*"
  exit 1
}

validate_pr_title() {
  local raw_title="$1"
  local normalized_title
  local lower_title

  normalized_title="$(
    printf '%s' "$raw_title" |
      sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/[[:space:]]+/ /g'
  )"
  ((${#normalized_title} >= 5 && ${#normalized_title} <= 72)) || return 1
  [[ "$normalized_title" == *" "* ]] || return 1

  lower_title="$(printf '%s' "$normalized_title" | tr '[:upper:]' '[:lower:]')"
  case "$lower_title" in
    chore|chore:*|chore\ *|chore\(*|chore/*|chore-*)
      return 1
      ;;
    misc|misc:*|misc\ *|misc\(*|misc/*|misc-*)
      return 1
      ;;
    wip|wip:*|wip\ *|wip\(*|wip/*|wip-*)
      return 1
      ;;
  esac
}

meta_json="$(
  gh pr view "$PR_NUMBER" --repo "$REPO" \
    --json number,title,state,mergeable,mergeStateStatus,headRefName,headRefOid,headRepository,baseRefName,baseRefOid,labels,url
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
cli_managed="$(python3 - <<'PY' "$meta_json" "$CLI_MANAGED_LABEL"
import json,sys
labels = json.loads(sys.argv[1]).get("labels") or []
print("yes" if any(label.get("name") == sys.argv[2] for label in labels) else "no")
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
echo "cli_managed=$cli_managed"

validate_pr_title "$title" ||
  fail "pull request title must be a short, meaningful plain-language outcome and must not use ambiguous prefixes such as chore, misc, or wip"
[[ "$state" == "OPEN" ]] || fail "pull request is not open"
[[ "$mergeable" == "MERGEABLE" ]] || fail "pull request is not currently mergeable"
if [[ "$AUTO_APPROVE" == "true" ]]; then
  [[ "$cli_managed" == "yes" ]] ||
    fail "automatic approval requires the $CLI_MANAGED_LABEL label"
  [[ "$head_repository" == "$REPO" ]] ||
    fail "automatic approval requires a branch in $REPO"
fi

owner="${REPO%%/*}"
repository="${REPO#*/}"
review_threads="$(
  gh api graphql \
    -f query='
      query($owner: String!, $repository: String!, $number: Int!) {
        repository(owner: $owner, name: $repository) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              pageInfo { hasNextPage }
              nodes { isResolved }
            }
          }
        }
      }
    ' \
    -f owner="$owner" \
    -f repository="$repository" \
    -F number="$PR_NUMBER"
)"
python3 - "$review_threads" <<'PY' || fail "pull request has unresolved or unbounded review threads"
import json
import sys

payload = json.loads(sys.argv[1])
threads = (
    payload.get("data", {})
    .get("repository", {})
    .get("pullRequest", {})
    .get("reviewThreads", {})
)
if threads.get("pageInfo", {}).get("hasNextPage"):
    raise SystemExit("more than 100 review threads requires manual review")
if any(not thread.get("isResolved", False) for thread in threads.get("nodes", [])):
    raise SystemExit("unresolved review thread")
PY

BASE_REF="$base_ref" HEAD_REF="$head_ref" REPOSITORY="$REPO" \
  HEAD_REPOSITORY="$head_repository" \
  "$BRANCH_POLICY_GUARD" || fail "branch policy rejected the pull request"

REPO="$REPO" EXPECTED_HEAD_SHA="$head_sha" EXPECTED_BASE_SHA="$base_sha" \
  "$PR_VALIDATOR" "$PR_NUMBER" ||
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

  REPO="$REPO" EXCLUDE_RUN_ID="" PROSPECTIVE_PROMOTION_PR="$PR_NUMBER" \
    "$PRODUCTION_RUN_EXCLUSIVITY" ||
    fail "another actionable production-capable workflow is active"

  expected_workflows="$(
    REPO="$REPO" PR="$PR_NUMBER" EXPECTED_HEAD_SHA="$head_sha" \
      "$WORKFLOW_INVENTORY" |
      sed -n 's/^production_workflows=//p'
  )"
  echo "production_workflows=$expected_workflows"
  if [[ "$AUTO_APPROVE" == "true" ]]; then
    approved_workflows="$expected_workflows"
  else
    approved_workflows="$(
      tr ',' '\n' <<<"${APPROVED_WORKFLOWS:-}" |
        sed '/^$/d' |
        LC_ALL=C sort -u |
        paste -sd, -
    )"
  fi
fi

if [[ "$AUTO_APPROVE" == "true" ]]; then
  approved_sha="$head_sha"
else
  approved_sha="${APPROVED_SHA:-}"
fi
[[ "$approved_sha" == "$head_sha" ]] ||
  fail "human approval requires APPROVED_SHA=$head_sha"

if [[ "$base_ref" == "master" ]]; then
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
echo "approval_mode=$([[ "$AUTO_APPROVE" == "true" ]] && echo copilot-cli || echo human)"
echo "reason=branch policy, mergeability, exact-SHA validation, and required approval gates passed"
