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

reject_literal() {
  local file="$1"
  local value="$2"
  local label="$3"
  grep -Fq "$value" "$file" && fail "$file contains forbidden $label"
  return 0
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
require_literal "$build_workflow" "production-emergency" "protected emergency environment"
reject_literal "$build_workflow" "  workflow_dispatch:" "manual or branch-selected build trigger"
require_literal "$build_workflow" "github.run_attempt == 1" "first-attempt-only image publication"
require_literal "$build_workflow" 'ref: ${{ env.IMAGE_TAG }}' "exact-SHA checkout"
require_literal "$build_workflow" "Reject stale master build" "stale master build guard"
require_literal "$build_workflow" '${{ matrix.image }}:${{ env.IMAGE_TAG }}' "exact-SHA image tag"
reject_literal "$build_workflow" '${{ matrix.image }}:latest' "mutable latest image publication"
require_literal "$build_workflow" 'id: build' "digest-producing build step"
require_literal "$build_workflow" 'steps.build.outputs.digest' "OCI digest capture"
require_literal "$build_workflow" 'image-provenance-${{ matrix.service }}-${{ github.run_id }}-${{ github.run_attempt }}' "attempt-bound image provenance"
require_literal "$build_workflow" "auth-container-smoke:" "production auth container smoke gate"
require_literal "$build_workflow" "./node_modules/.bin/tsc --noEmit" "locked TypeScript gate"
require_literal "$build_workflow" "workflow-trigger-guard-stan.sh" "self-validation guard"

require_literal "$deploy_workflow" "name: production-deploy" "production deploy identity"
require_literal "$deploy_workflow" "  workflow_dispatch:" "manual deployment trigger"
reject_literal "$deploy_workflow" "  workflow_run:" "automatic deployment trigger"
require_literal "$deploy_workflow" "if: github.run_attempt == 1" "first-attempt-only deployment"
require_literal "$deploy_workflow" "approved_sha:" "manual approved SHA input"
require_literal "$deploy_workflow" "build_run_id:" "exact build run input"
require_literal "$deploy_workflow" '[ "$GITHUB_REF_NAME" = "master" ]' "master dispatch guard"
require_literal "$deploy_workflow" '[ "$event" = "push" ]' "trusted push-event guard"
require_literal "$deploy_workflow" '[ "$head_branch" = "master" ]' "master build guard"
require_literal "$deploy_workflow" '[ "$head_repository" = "$REPO" ]' "head-repository guard"
require_literal "$deploy_workflow" '[ "$conclusion" = "success" ]' "successful-build guard"
require_literal "$deploy_workflow" '[ "$run_attempt" = "1" ]' "first-attempt build guard"
require_literal "$deploy_workflow" 'actions/runs/$BUILD_RUN_ID/attempts/1' "immutable build-attempt lookup"
require_literal "$deploy_workflow" "Validate exact SHA and trusted build run" "exact workflow identity guard"
require_literal "$deploy_workflow" '[ "$workflow_path" = ".github/workflows/production-build.yml" ]' "upstream workflow path guard"
require_literal "$deploy_workflow" "production-emergency" "protected emergency environment"
require_literal "$deploy_workflow" 'run-name: deploy ${{ inputs.approved_sha }}' "SHA-specific deploy run name"
require_literal "$deploy_workflow" "image_provenance_stan.py" "immutable image provenance validation"
require_literal "$deploy_workflow" '[[ "$image_id" =~ @sha256:[0-9a-f]{64}$ ]]' "serving OCI image ID verification"
require_literal "$deploy_workflow" 'deploy-provenance-${{ github.run_id }}-${{ github.run_attempt }}' "attempt-specific provenance"
require_literal "$deploy_workflow" 'deploy-validation-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}' "attempt-specific diagnostics"
require_literal "$deploy_workflow" "APP_E2E_BASE_URL:" "explicit browser validation target"
require_literal "$deploy_workflow" "https://betstan.xyz" "public HTTPS browser validation target"
reject_literal "$deploy_workflow" "APP_E2E_BASE_URL: \${{ vars.APP_E2E_BASE_URL || '' }}" "empty browser validation fallback"
require_literal "$deploy_workflow" "ingress/gaming-ingress-service-nip" "legacy ingress cleanup"
require_literal "$deploy_workflow" "certificate/betstan-nip-tls" "legacy certificate cleanup"
require_literal "$deploy_workflow" "secret/betstan-nip-tls" "legacy TLS secret cleanup"
reject_literal "$deploy_workflow" "kubectl apply -f infra/k8s-prod/ingress-srv-nip.yaml" "legacy public ingress application"

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
