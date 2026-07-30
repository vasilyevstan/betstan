#!/usr/bin/env bash
set -euo pipefail

# Purpose: keep production automation on the trusted exact-SHA workflow chain.

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

build_workflow=".github/workflows/production-build.yml"
deploy_workflow=".github/workflows/production-deploy.yml"
branch_workflow=".github/workflows/branch-policy.yml"
policy_script=".github/scripts/publish-pr-policy.js"

for file in "$build_workflow" "$deploy_workflow" "$branch_workflow" "$policy_script"; do
  [[ -f "$file" ]] || fail "required workflow missing: $file"
done

retired=(
  .github/workflows/build-push.yml
  .github/workflows/deploy-manifests.yml
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
for file in "${retired[@]}"; do
  [[ ! -e "$file" ]] || fail "retired workflow identity still exists: $file"
done

require_literal "$build_workflow" "name: production-build" "production build identity"
require_literal "$build_workflow" "      - master" "master push trigger"
require_literal "$build_workflow" "      - dev" "dev PR trigger"
require_literal "$build_workflow" "approved_sha:" "manual approved SHA input"
require_literal "$build_workflow" "production-emergency" "protected emergency environment"
require_literal "$build_workflow" "(github.event_name == 'push' && github.run_attempt > 1)" "non-PR rerun authorization"
require_literal "$build_workflow" 'ref: ${{ env.IMAGE_TAG }}' "exact-SHA checkout"
require_literal "$build_workflow" '${{ matrix.image }}:${{ env.IMAGE_TAG }}' "exact-SHA image tag"
require_literal "$build_workflow" "workflow-trigger-guard-stan.sh" "self-validation guard"

require_literal "$deploy_workflow" "name: production-deploy" "production deploy identity"
require_literal "$deploy_workflow" 'workflows: ["production-build"]' "trusted upstream workflow"
require_literal "$deploy_workflow" "github.event.workflow_run.event == 'push'" "trusted push-event guard"
require_literal "$deploy_workflow" "github.event.workflow_run.event == 'workflow_dispatch'" "trusted manual build-event guard"
require_literal "$deploy_workflow" "github.event.workflow_run.head_repository.full_name == github.repository" "head-repository guard"
require_literal "$deploy_workflow" "github.event.workflow_run.head_branch == 'master'" "master-branch guard"
require_literal "$deploy_workflow" "github.event.workflow_run.conclusion == 'success'" "successful-build guard"
require_literal "$deploy_workflow" "Validate upstream workflow identity" "exact workflow identity guard"
require_literal "$deploy_workflow" '[ "$workflow_path" = ".github/workflows/production-build.yml" ]' "upstream workflow path guard"
require_literal "$deploy_workflow" "Reject stale automatic deploy" "stale deploy guard"
require_literal "$deploy_workflow" "approved_sha:" "manual approved SHA input"
require_literal "$deploy_workflow" "production-emergency" "protected emergency environment"
require_literal "$deploy_workflow" 'run-name: deploy ${{ github.event.workflow_run.head_sha || inputs.approved_sha }}' "SHA-specific deploy run name"
require_literal "$deploy_workflow" 'deploy-provenance-${{ github.run_id }}-${{ github.run_attempt }}' "attempt-specific provenance"
require_literal "$deploy_workflow" 'deploy-validation-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}' "attempt-specific diagnostics"

require_literal "$branch_workflow" "pull_request_target:" "trusted PR metadata event"
require_literal "$branch_workflow" 'workflows: ["production-build"]' "trusted quality completion event"
require_literal "$branch_workflow" "pr_number:" "trusted bootstrap refresh input"
require_literal "$branch_workflow" "statuses: write" "status publication permission"
require_literal "$branch_workflow" "publish-pr-policy.js" "trusted policy publisher"
require_literal "$policy_script" 'const BRANCH_CONTEXT_PREFIX = "branch-policy"' "stable branch context"
require_literal "$policy_script" 'const QUALITY_CONTEXT_PREFIX = "pr-quality-gates"' "stable quality context"
require_literal "$policy_script" "pull.mergeSha" "unique PR merge snapshot status"
require_literal "$policy_script" "? [pull.headSha, pull.mergeSha]" "promotion head and merge statuses"
require_literal "$policy_script" "assertExpectedPull(finalPull, pull)" "final stale-event check"
require_literal "$policy_script" "relation.base?.sha === pull.baseSha" "exact base snapshot relation"

workflow_set="$(
  ./infra/azure/agents/production-workflow-inventory-stan.sh |
    sed -n 's/^production_workflows=//p'
)"
[[ "$workflow_set" == "production-build,production-deploy" ]] ||
  fail "unexpected production workflow set: ${workflow_set:-none}"

echo "workflow_trigger_guard=PASS retired_workflows=${#retired[@]}"
