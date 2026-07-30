#!/usr/bin/env bash
set -euo pipefail

# Purpose: keep production automation on the trusted exact-SHA deployment chain.

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

require_literal() {
  local file="$1"
  local value="$2"
  local label="$3"

  grep -Fq "$value" "$file" || fail "$file is missing $label"
}

require_in_block() {
  local block="$1"
  local value="$2"
  local label="$3"

  grep -Fq "$value" <<<"$block" || fail "deployment condition is missing $label"
}

build_workflow=".github/workflows/build-push.yml"
deploy_workflow=".github/workflows/deploy-manifests.yml"
legacy_workflows=(
  .github/workflows/deploy-auth.yaml
  .github/workflows/deploy-backoffice.yaml
  .github/workflows/deploy-bet.yaml
  .github/workflows/deploy-client.yaml
  .github/workflows/deploy-event.yaml
  .github/workflows/deploy-gamemaster.yaml
  .github/workflows/deploy-moderation.yaml
  .github/workflows/deploy-resulting.yaml
  .github/workflows/deploy-slip.yaml
)

push_trigger="$(
  awk '
    /^  push:$/ { in_push=1; print; next }
    in_push && /^  [[:alnum:]_-]+:$/ { exit }
    in_push { print }
  ' "$build_workflow"
)"
grep -q '^  push:' <<<"$push_trigger" ||
  fail "$build_workflow must define a push trigger"
grep -q '^      - master$' <<<"$push_trigger" ||
  fail "$build_workflow must run on master"

deploy_condition="$(sed -n '/^    if: >/,/^    runs-on:/p' "$deploy_workflow")"
require_in_block "$deploy_condition" \
  "github.event.workflow_run.event == 'push'" \
  "trusted push-event guard"
require_in_block "$deploy_condition" \
  "github.event.workflow_run.event == 'workflow_dispatch'" \
  "trusted manual build-event guard"
require_in_block "$deploy_condition" \
  "github.event.workflow_run.head_repository.full_name == github.repository" \
  "head-repository guard"
require_in_block "$deploy_condition" \
  "github.event.workflow_run.head_branch == 'master'" \
  "master-branch guard"
require_in_block "$deploy_condition" \
  "github.event.workflow_run.conclusion == 'success'" \
  "successful-build guard"
require_literal "$deploy_workflow" \
  'github.event.workflow_run.head_sha' \
  "exact-SHA deployment"
require_literal "$deploy_workflow" \
  'contents: read' \
  "read-only GitHub token permissions"

for workflow in "${legacy_workflows[@]}"; do
  trigger_block="$(sed -n '/^on:/,/^env:/p' "$workflow")"
  grep -q '^  workflow_dispatch:' <<<"$trigger_block" ||
    fail "$workflow must retain its manual fallback"

  if grep -q '^  push:' <<<"$trigger_block"; then
    fail "$workflow must not deploy automatically"
  fi
done

echo "workflow_trigger_guard=PASS legacy_manual_only=${#legacy_workflows[@]}"
