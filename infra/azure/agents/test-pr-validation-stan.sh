#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VALIDATOR="$ROOT_DIR/infra/azure/agents/pr-validation-stan.sh"
HEAD_SHA="1111111111111111111111111111111111111111"
BASE_SHA="0000000000000000000000000000000000000000"
MERGE_SHA="2222222222222222222222222222222222222222"

gh() {
  if [[ "$1 $2" == "pr view" ]]; then
    if [[ "$*" == *"number,title,state"* ]]; then
      printf '%s\n' \
        "{\"number\":63,\"title\":\"policy\",\"state\":\"OPEN\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"headRefName\":\"dev\",\"headRefOid\":\"$HEAD_SHA\",\"headRepository\":{\"nameWithOwner\":\"example/repo\"},\"baseRefName\":\"master\",\"baseRefOid\":\"$BASE_SHA\",\"potentialMergeCommit\":{\"oid\":\"$MERGE_SHA\"},\"url\":\"https://example.invalid/pr/63\"}"
    else
      printf '%s\n' \
        "{\"headRefOid\":\"$HEAD_SHA\",\"baseRefOid\":\"$BASE_SHA\",\"potentialMergeCommit\":{\"oid\":\"$MERGE_SHA\"}}"
    fi
  elif [[ "$1" == "api" &&
    ( "$2" == *"/commits/$MERGE_SHA/status" || "$2" == *"/commits/$HEAD_SHA/status" ) ]]; then
    local branch_run_id=101
    local quality_run_id=102
    if [[ "$2" == *"/commits/$HEAD_SHA/status" ]]; then
      branch_run_id="${STUB_HEAD_BRANCH_RUN_ID:-101}"
      quality_run_id="${STUB_HEAD_QUALITY_RUN_ID:-102}"
    fi
    printf '%s\n' \
      "{\"statuses\":[{\"context\":\"branch-policy/master\",\"state\":\"${STUB_BRANCH_STATE:-success}\",\"target_url\":\"https://example.invalid/actions/runs/$branch_run_id\",\"avatar_url\":\"https://avatars.example.invalid/in/${STUB_STATUS_APP_ID:-15368}?v=4\"},{\"context\":\"pr-quality-gates/master\",\"state\":\"success\",\"target_url\":\"https://example.invalid/actions/runs/$quality_run_id\",\"avatar_url\":\"https://avatars.example.invalid/in/15368?v=4\"}]}"
  elif [[ "$1" == "api" && "$2" == *"/actions/workflows/branch-policy.yml" ]]; then
    echo "201"
  elif [[ "$1" == "api" && "$2" == *"/actions/workflows/production-build.yml" ]]; then
    echo "202"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/101" ]]; then
    printf '%s\n' \
      "{\"id\":101,\"workflow_id\":201,\"name\":\"branch-policy\",\"path\":\".github/workflows/branch-policy.yml\",\"display_title\":\"branch-policy PR ${STUB_BRANCH_UPSTREAM_ID:-102}\",\"event\":\"workflow_run\",\"head_sha\":\"$BASE_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"html_url\":\"https://example.invalid/actions/runs/101\",\"pull_requests\":[{\"number\":99,\"head\":{\"sha\":\"$BASE_SHA\"},\"base\":{\"sha\":\"$BASE_SHA\"}}]}"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/102" ]]; then
    printf '%s\n' \
      "{\"id\":102,\"workflow_id\":${STUB_BUILD_WORKFLOW_ID:-202},\"name\":\"production-build\",\"path\":\".github/workflows/production-build.yml\",\"event\":\"pull_request\",\"head_sha\":\"${STUB_RUN_HEAD_SHA:-$HEAD_SHA}\",\"status\":\"completed\",\"conclusion\":\"success\",\"html_url\":\"https://example.invalid/actions/runs/102\",\"pull_requests\":[{\"number\":63,\"head\":{\"sha\":\"$HEAD_SHA\"},\"base\":{\"sha\":\"${STUB_RUN_BASE_SHA:-$BASE_SHA}\"}}]}"
  else
    echo "unexpected gh invocation: $*" >&2
    return 1
  fi
}
export -f gh
export HEAD_SHA BASE_SHA MERGE_SHA

REPO=example/repo "$VALIDATOR" 63 >/dev/null

if STUB_RUN_HEAD_SHA="3333333333333333333333333333333333333333" \
  REPO=example/repo "$VALIDATOR" 63 >/dev/null 2>&1; then
  echo "validator accepted a quality run for the wrong SHA" >&2
  exit 1
fi

if STUB_BRANCH_STATE="pending" REPO=example/repo \
  "$VALIDATOR" 63 >/dev/null 2>&1; then
  echo "validator accepted an incomplete required status" >&2
  exit 1
fi

if STUB_BUILD_WORKFLOW_ID="999" REPO=example/repo \
  "$VALIDATOR" 63 >/dev/null 2>&1; then
  echo "validator accepted an untrusted workflow ID" >&2
  exit 1
fi

if STUB_RUN_BASE_SHA="4444444444444444444444444444444444444444" \
  REPO=example/repo "$VALIDATOR" 63 >/dev/null 2>&1; then
  echo "validator accepted a status from a stale PR base" >&2
  exit 1
fi

if STUB_BRANCH_UPSTREAM_ID=999 REPO=example/repo \
  "$VALIDATOR" 63 >/dev/null 2>&1; then
  echo "validator accepted a branch status from an unrelated quality run" >&2
  exit 1
fi

if STUB_STATUS_APP_ID="999" REPO=example/repo \
  "$VALIDATOR" 63 >/dev/null 2>&1; then
  echo "validator accepted an untrusted status app" >&2
  exit 1
fi

if STUB_HEAD_QUALITY_RUN_ID=999 REPO=example/repo \
  "$VALIDATOR" 63 >/dev/null 2>&1; then
  echo "validator accepted a head status from a different quality run" >&2
  exit 1
fi

echo "pr_validation_tests=PASS"
