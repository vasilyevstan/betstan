#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="$ROOT_DIR/infra/azure/agents/branch-policy-guard-stan.sh"

expect_pass() {
  local base="$1"
  local head="$2"
  BASE_REF="$base" HEAD_REF="$head" \
    REPOSITORY=example/repo HEAD_REPOSITORY=example/repo \
    "$GUARD" >/dev/null
}

expect_fail() {
  local base="$1"
  local head="$2"
  local head_repository="${3:-example/repo}"
  if BASE_REF="$base" HEAD_REF="$head" \
    REPOSITORY=example/repo HEAD_REPOSITORY="$head_repository" \
    "$GUARD" >/dev/null 2>&1; then
    echo "expected branch policy failure for head=$head base=$base" >&2
    exit 1
  fi
}

expect_pass dev feature/example
expect_pass dev hotfix/example
expect_pass master dev
expect_fail master feature/example
expect_fail dev master
expect_fail dev dev
expect_fail release feature/example
expect_fail master dev fork/repo

echo "branch_policy_tests=PASS"
