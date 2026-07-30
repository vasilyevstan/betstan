#!/usr/bin/env bash
set -euo pipefail

# Purpose: enforce BetStan's PR branch flow.
# Usage:
#   BASE_REF=dev HEAD_REF=feature/example ./infra/azure/agents/branch-policy-guard-stan.sh
#   BASE_REF=master HEAD_REF=dev REPOSITORY=owner/repo \
#     HEAD_REPOSITORY=owner/repo ./infra/azure/agents/branch-policy-guard-stan.sh

BASE_REF="${BASE_REF:-${GITHUB_BASE_REF:-}}"
HEAD_REF="${HEAD_REF:-${GITHUB_HEAD_REF:-}}"
REPOSITORY="${REPOSITORY:-${GITHUB_REPOSITORY:-}}"
HEAD_REPOSITORY="${HEAD_REPOSITORY:-$REPOSITORY}"

fail() {
  echo "branch_policy=FAIL base=${BASE_REF:-missing} head=${HEAD_REF:-missing} reason=$*" >&2
  exit 1
}

[[ -n "$BASE_REF" ]] || fail "BASE_REF is required"
[[ -n "$HEAD_REF" ]] || fail "HEAD_REF is required"

case "$BASE_REF" in
  dev)
    [[ "$HEAD_REF" != "master" ]] || fail "master-to-dev pull requests are not part of the normal flow"
    [[ "$HEAD_REF" != "dev" ]] || fail "a pull request cannot promote dev into itself"
    ;;
  master)
    [[ "$HEAD_REF" == "dev" ]] || fail "only dev may open a production promotion pull request"
    [[ -n "$REPOSITORY" && "$HEAD_REPOSITORY" == "$REPOSITORY" ]] ||
      fail "production promotion must use this repository's dev branch"
    ;;
  *)
    fail "pull requests must target dev or master"
    ;;
esac

echo "branch_policy=PASS base=$BASE_REF head=$HEAD_REF"
