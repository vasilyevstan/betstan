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
oci_migrate_workflow=".github/workflows/oci-migrate.yml"
oci_recovery_workflow=".github/workflows/oci-migration-recovery.yml"

for file in \
  "$build_workflow" "$deploy_workflow" "$branch_workflow" "$policy_script" \
  "$oci_migrate_workflow" "$oci_recovery_workflow"; do
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
  .github/workflows/deploy-stage-shared-db.yml
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
require_literal "$deploy_workflow" "shared-mongo-topology-guard-stan.sh" "validated shared-Mongo topology guard"
require_literal "$deploy_workflow" "shared-mongo-operation-lock-stan.sh acquire" "database operation lock acquisition"
require_literal "$deploy_workflow" "shared-mongo-operation-lock-stan.sh release" "database operation lock release"
require_literal "$deploy_workflow" "Release database operation lock" "always-run database lock cleanup"
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

require_literal "$oci_migrate_workflow" "build_run_id:" "exact OCI build provenance input"
require_literal "$oci_migrate_workflow" "replace_oci_data:" "explicit destructive replacement input"
require_literal "$oci_migrate_workflow" "inputs.replace_oci_data == true" "destructive replacement guard"
require_literal "$oci_migrate_workflow" "REPLACE OCI DATA FROM AZURE" "destructive confirmation"
require_literal "$oci_migrate_workflow" "group: oci-control-plane" "shared OCI control-plane concurrency"
require_literal "$oci_migrate_workflow" "az aks start" "synchronous exact Azure start"
require_literal "$oci_migrate_workflow" "az aks stop" "always-path Azure deallocation"
require_literal "$oci_migrate_workflow" 'public_url: ${{ steps.provenance.outputs.public_url }}' "canonical URL output"
require_literal "$oci_migrate_workflow" 'redirect_url: ${{ steps.provenance.outputs.redirect_url }}' "redirect URL output"
require_literal "$oci_migrate_workflow" 'diagnostic_url: ${{ steps.provenance.outputs.diagnostic_url }}' "diagnostic URL output"
require_literal "$oci_migrate_workflow" 'OCI_PUBLIC_URL:' "canonical health target"
require_literal "$oci_migrate_workflow" 'OCI_REDIRECT_URL:' "redirect health target"
require_literal "$oci_migrate_workflow" 'OCI_DIAGNOSTIC_URL:' "diagnostic health target"
require_literal "$oci_migrate_workflow" 'https://betstan.xyz' "exact canonical identity"
require_literal "$oci_migrate_workflow" 'https://www.betstan.xyz' "exact redirect identity"
require_literal "$oci_migrate_workflow" 'name: oci-migration-success-provenance-${{ github.run_id }}-${{ github.run_attempt }}' "run-attempt-bound retirement provenance artifact"
require_literal "$oci_migrate_workflow" 'migration-summary.env' "machine-readable retirement provenance file"
require_literal "$oci_migrate_workflow" 'terminal_status=DEPLOYED_HEALTHY' "terminal healthy migration status"
require_literal "$oci_migrate_workflow" 'journal_heartbeat_epoch=' "terminal heartbeat provenance"
require_literal "$oci_migrate_workflow" 'fencing_generation=' "fencing generation provenance"
require_literal "$oci_migrate_workflow" 'artifact_run_binding=' "run-attempt summary binding"
require_literal "$oci_migrate_workflow" 'azure_cluster_stopped_deallocated=true' "Azure deallocation provenance"
reject_literal "$oci_migrate_workflow" "az aks create" "Azure cluster creation"
reject_literal "$oci_migrate_workflow" "az aks nodepool" "Azure cluster resize"
reject_literal "$oci_migrate_workflow" "Object Storage" "retained database artifact path"

require_literal "$oci_recovery_workflow" "name: oci-migration-recovery" "migration recovery identity"
require_literal "$oci_recovery_workflow" 'workflows: ["oci-migrate"]' "migration completion trigger"
require_literal "$oci_recovery_workflow" 'cron: "*/15 * * * *"' "bounded recovery schedule"
require_literal "$oci_recovery_workflow" "workflow_dispatch:" "manual recovery trigger"
require_literal "$oci_recovery_workflow" "OCI_MIGRATION_RECOVERY_ENABLED" "false-by-default recovery guard"
require_literal "$oci_recovery_workflow" "OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH" "bounded recovery arm deadline"
require_literal "$oci_recovery_workflow" "86400" "one-day recovery arm bound"
require_literal "$oci_recovery_workflow" "name: azure-migration-recovery" "stop-only protected environment"
require_literal "$oci_recovery_workflow" "AZURE_MIGRATION_RECOVERY_CREDENTIALS" "dedicated stop-only credential"
require_literal "$oci_recovery_workflow" "group: azure-migration-recovery" "collapsed recovery concurrency"
require_literal "$oci_recovery_workflow" "cancel-in-progress: true" "duplicate recovery collapse"
require_literal "$oci_recovery_workflow" "az aks stop" "exact Azure stop operation"
reject_literal "$oci_recovery_workflow" "OCI_MIGRATION_AZURE_CREDENTIALS" "broader migration credential"
reject_literal "$oci_recovery_workflow" "az aks start" "Azure start permission"
reject_literal "$oci_recovery_workflow" "az aks create" "Azure create permission"
reject_literal "$oci_recovery_workflow" "OCI_CI_PRIVATE_KEY_PEM" "OCI API credential"

workflow_set="$(
  ./infra/azure/agents/production-workflow-inventory-stan.sh |
    sed -n 's/^production_workflows=//p'
)"
oci_workflow_set="oci-capacity-acquire,oci-infrastructure,oci-migrate,oci-migration-recovery,oci-production-build,oci-production-deploy,production-build,production-deploy"
[[ "$workflow_set" == "$oci_workflow_set" ]] ||
  fail "unexpected production workflow set: ${workflow_set:-none}"

echo "workflow_trigger_guard=PASS retired_workflows=${#retired[@]}"
