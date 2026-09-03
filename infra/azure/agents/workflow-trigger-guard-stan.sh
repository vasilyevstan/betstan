#!/usr/bin/env bash
set -euo pipefail

# Purpose: keep production automation on the trusted exact-SHA workflow chain.

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"
WORKFLOW_PERMISSION_DIR="${WORKFLOW_PERMISSION_DIR:-.github/workflows}"

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
rollback_workflow=".github/workflows/production-rollback.yml"
branch_workflow=".github/workflows/branch-policy.yml"
policy_script=".github/scripts/publish-pr-policy.js"
oci_data_workflow=".github/workflows/oci-live-data-rollout.yml"
oci_live_activate_workflow=".github/workflows/oci-live-betting-activate.yml"
oci_live_disable_workflow=".github/workflows/oci-live-betting-disable.yml"
oci_migrate_workflow=".github/workflows/oci-migrate.yml"
oci_recovery_workflow=".github/workflows/oci-migration-recovery.yml"
oci_rollback_workflow=".github/workflows/oci-production-rollback.yml"
ghcr_package_workflow=".github/workflows/ghcr-package-management.yml"
ghcr_cache_recovery_workflow=".github/workflows/oci-ghcr-cache-recovery.yml"

for file in \
  "$build_workflow" "$deploy_workflow" "$branch_workflow" "$policy_script" \
  "$rollback_workflow" "$oci_data_workflow" "$oci_migrate_workflow" \
  "$oci_recovery_workflow" "$oci_rollback_workflow" \
  "$oci_live_activate_workflow" "$oci_live_disable_workflow" \
  "$ghcr_package_workflow" "$ghcr_cache_recovery_workflow"; do
  [[ -f "$file" ]] || fail "required workflow missing: $file"
done

for workflow in "$ghcr_package_workflow" "$ghcr_cache_recovery_workflow"; do
  require_literal "$workflow" "  workflow_dispatch:" "manual GHCR control trigger"
  reject_literal "$workflow" "  push:" "push-triggered GHCR control mutation"
  require_literal "$workflow" "github.run_attempt == 1" "first-attempt GHCR control guard"
done
require_literal "$ghcr_package_workflow" "packages: write" "scoped GHCR package publication permission"
require_literal "$ghcr_package_workflow" "BOOTSTRAP GHCR PACKAGE SENTINEL" "bounded bootstrap confirmation"
require_literal "$ghcr_package_workflow" "VALIDATE PUBLIC GHCR PACKAGE" "bounded validation confirmation"
require_literal "$ghcr_package_workflow" "PRUNE OBSOLETE GHCR PACKAGE GENERATIONS" "bounded prune confirmation"
require_literal "$ghcr_cache_recovery_workflow" "RECOVER K3S CACHED BASELINE TO GHCR" "exact cache recovery confirmation"
require_literal "$ghcr_cache_recovery_workflow" "name: oci-production" "protected cache recovery environment"
require_literal "$ghcr_cache_recovery_workflow" "K3S_SSH_KNOWN_HOSTS=\"\$target_known_hosts\"" "dedicated target known-hosts handoff"
require_literal "$ghcr_cache_recovery_workflow" "K3S_SSH_HOST_KEY_ALIAS=\"\$instance_ocid\"" "exact instance host-key alias handoff"
require_literal "$ghcr_cache_recovery_workflow" "Sequentially rebind verified GHCR digests" "verified image-rebind phase"
require_literal "$ghcr_cache_recovery_workflow" "needs: [recover, public-validate]" "public validation before OCIR retirement"
require_literal "$ghcr_cache_recovery_workflow" "Retire OCIR credentials and empty repository after public validation" "deferred OCIR retirement phase"
require_literal "$ghcr_cache_recovery_workflow" "transition-k3s-cached-images.sh" "one-time credential retirement operator"
reject_literal "$ghcr_cache_recovery_workflow" "artifacts/ghcr-cache-recovery/k3s-access.env" "secret-bearing access state artifact"

python3 -m py_compile \
  infra/azure/agents/workflow-shell-input-guard-stan.py
bash -n \
  infra/azure/agents/test-workflow-shell-input-guard-stan.sh
./infra/azure/agents/test-workflow-shell-input-guard-stan.sh

if ! python3 \
  infra/azure/agents/workflow-shell-input-guard-stan.py \
  .github/workflows; then
  fail "workflow shell steps interpolate untrusted inputs directly"
fi

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

require_literal "$rollback_workflow" "name: production-rollback" "production rollback identity"
require_literal "$rollback_workflow" "run-name: rollback \${{ inputs.target_sha }}" "SHA-specific rollback run name"
require_literal "$rollback_workflow" "  workflow_dispatch:" "manual rollback trigger"
reject_literal "$rollback_workflow" "  workflow_run:" "automatic rollback trigger"
reject_literal "$rollback_workflow" "  push:" "push-triggered rollback"
reject_literal "$rollback_workflow" "  schedule:" "scheduled rollback"
require_literal "$rollback_workflow" "  actions: read" "read-only actions permission"
require_literal "$rollback_workflow" "  contents: read" "read-only contents permission"
reject_literal "$rollback_workflow" "  actions: write" "write-capable actions permission"
reject_literal "$rollback_workflow" "  contents: write" "write-capable contents permission"
require_literal "$rollback_workflow" "if: github.run_attempt == 1" "first-attempt-only rollback"
require_literal "$rollback_workflow" "baseline_source_run_id:" "baseline source run input"
require_literal "$rollback_workflow" "baseline_source_run_attempt:" "baseline source run attempt input"
require_literal "$rollback_workflow" "baseline_artifact_name:" "baseline artifact input"
require_literal "$rollback_workflow" "confirmation:" "manual rollback confirmation input"
require_literal "$rollback_workflow" 'CONFIRMATION: ${{ inputs.confirmation }}' "environment-bound rollback confirmation"
require_literal "$rollback_workflow" '[ "$GITHUB_REF_NAME" = "master" ]' "master rollback branch guard"
require_literal "$rollback_workflow" '[ "$CONFIRMATION" = "ROLLBACK PRODUCTION EXACT DIGEST" ]' "exact rollback confirmation"
reject_literal "$rollback_workflow" '[ "${{ inputs.confirmation }}"' "direct rollback input interpolation"
require_literal "$rollback_workflow" '[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]' "exact rollback target SHA validation"
require_literal "$rollback_workflow" '[[ "$BASELINE_SOURCE_RUN_ID" =~ ^[1-9][0-9]*$ ]]' "numeric rollback provenance run ID validation"
require_literal "$rollback_workflow" '[ "$BASELINE_SOURCE_RUN_ATTEMPT" = "1" ]' "first-attempt rollback provenance guard"
require_literal "$rollback_workflow" '[ "$BASELINE_ARTIFACT_NAME" = "production-baseline-${BASELINE_SOURCE_RUN_ID}-${BASELINE_SOURCE_RUN_ATTEMPT}" ]' "exact rollback provenance artifact binding"
require_literal "$rollback_workflow" '[ "$GITHUB_RUN_ATTEMPT" = "1" ]' "in-step rerun rejection"
require_literal "$rollback_workflow" "git merge-base --is-ancestor" "master-history rollback guard"
require_literal "$rollback_workflow" "shared-mongo-operation-lock-stan.sh acquire" "rollback operation lock acquisition"
require_literal "$rollback_workflow" "shared-mongo-operation-lock-stan.sh release" "rollback operation lock release"
require_literal "$rollback_workflow" "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683" "reviewed checkout pin"
require_literal "$rollback_workflow" "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02" "reviewed upload-artifact pin"
require_literal "$rollback_workflow" "azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5" "reviewed azure/login pin"
require_literal "$rollback_workflow" "azure/aks-set-context@c7eb093e5a5d47caa333f64974d5fd1cd4bf069d" "reviewed aks-set-context pin"

require_literal "$oci_rollback_workflow" "name: oci-production-rollback" "OCI production rollback identity"
require_literal "$oci_rollback_workflow" "run-name: oci-rollback \${{ inputs.target_sha }}" "OCI rollback run name"
require_literal "$oci_rollback_workflow" "  workflow_dispatch:" "manual OCI rollback trigger"
reject_literal "$oci_rollback_workflow" "  workflow_run:" "automatic OCI rollback trigger"
reject_literal "$oci_rollback_workflow" "  push:" "push-triggered OCI rollback"
reject_literal "$oci_rollback_workflow" "  schedule:" "scheduled OCI rollback"
require_literal "$oci_rollback_workflow" "  actions: read" "read-only OCI rollback actions permission"
require_literal "$oci_rollback_workflow" "  contents: read" "read-only OCI rollback contents permission"
reject_literal "$oci_rollback_workflow" "  actions: write" "write-capable OCI rollback actions permission"
reject_literal "$oci_rollback_workflow" "  contents: write" "write-capable OCI rollback contents permission"
require_literal "$oci_rollback_workflow" "if: github.run_attempt == 1" "first-attempt-only OCI rollback"
require_literal "$oci_rollback_workflow" "baseline_source_run_id:" "OCI baseline source run input"
require_literal "$oci_rollback_workflow" "baseline_source_run_attempt:" "OCI baseline source run attempt input"
require_literal "$oci_rollback_workflow" "baseline_artifact_name:" "OCI baseline artifact input"
require_literal "$oci_rollback_workflow" "infrastructure_run_id:" "reviewed OCI infrastructure run input"
require_literal "$oci_rollback_workflow" "partial_rollback_run_id:" "failed partial rollback recovery input"
require_literal "$oci_rollback_workflow" "pre_recovery_build_run_id:" "pre-recovery OCI build authority input"
require_literal "$oci_rollback_workflow" "confirmation:" "OCI rollback confirmation input"
require_literal "$oci_rollback_workflow" '[ "$GITHUB_REF_NAME" = "master" ]' "OCI rollback master branch guard"
require_literal "$oci_rollback_workflow" '[ "$CONFIRMATION" = "ROLLBACK OCI EXACT DIGEST" ]' "exact OCI rollback confirmation"
require_literal "$oci_rollback_workflow" '[ "$CONFIRMATION" = "RECOVER OCI PARTIAL ROLLBACK" ]' "exact partial rollback recovery confirmation"
require_literal "$oci_rollback_workflow" '[[ "$PARTIAL_ROLLBACK_RUN_ID" =~ ^(0|[1-9][0-9]*)$ ]]' "numeric partial rollback recovery run validation"
require_literal "$oci_rollback_workflow" '[[ "$PRE_RECOVERY_BUILD_RUN_ID" =~ ^(0|[1-9][0-9]*)$ ]]' "numeric pre-recovery build run validation"
require_literal "$oci_rollback_workflow" '[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]' "exact OCI rollback target SHA validation"
require_literal "$oci_rollback_workflow" '[[ "$BASELINE_SOURCE_RUN_ID" =~ ^[1-9][0-9]*$ ]]' "numeric OCI rollback provenance run ID validation"
require_literal "$oci_rollback_workflow" '[ "$BASELINE_SOURCE_RUN_ATTEMPT" = "1" ]' "first-attempt OCI rollback provenance guard"
require_literal "$oci_rollback_workflow" '[ "$BASELINE_ARTIFACT_NAME" = "oci-production-baseline-${BASELINE_SOURCE_RUN_ID}-${BASELINE_SOURCE_RUN_ATTEMPT}" ]' "exact OCI rollback provenance artifact binding"
require_literal "$oci_rollback_workflow" '[[ "$INFRASTRUCTURE_RUN_ID" =~ ^[1-9][0-9]*$ ]]' "numeric OCI infrastructure run validation"
require_literal "$oci_rollback_workflow" 'actions/runs/$INFRASTRUCTURE_RUN_ID/attempts/1' "immutable OCI infrastructure attempt lookup"
require_literal "$oci_rollback_workflow" 'actions/runs/$PARTIAL_ROLLBACK_RUN_ID/attempts/1' "immutable failed rollback attempt lookup"
require_literal "$oci_rollback_workflow" 'actions/runs/$PRE_RECOVERY_BUILD_RUN_ID/attempts/1' "immutable pre-recovery build attempt lookup"
require_literal "$oci_rollback_workflow" 'oci-image-provenance-${pre_recovery_source_sha}-${PRE_RECOVERY_BUILD_RUN_ID}-1' "exact pre-recovery build artifact binding"
require_literal "$oci_rollback_workflow" '[ "$workflow_path" = ".github/workflows/oci-infrastructure.yml" ]' "trusted OCI infrastructure workflow path guard"
require_literal "$oci_rollback_workflow" '[ "$event" = "workflow_dispatch" ]' "manual OCI infrastructure provenance guard"
require_literal "$oci_rollback_workflow" '[ "$head_branch" = "master" ]' "OCI infrastructure master branch guard"
require_literal "$oci_rollback_workflow" '[ "$repository" = "$REPOSITORY" ]' "OCI infrastructure repository guard"
require_literal "$oci_rollback_workflow" '[ "$status" = "completed" ] && [ "$conclusion" = "success" ] && [ "$attempt" = "1" ]' "successful OCI infrastructure provenance guard"
require_literal "$oci_rollback_workflow" "group: oci-control-plane" "shared OCI control-plane concurrency"
require_literal "$oci_rollback_workflow" "cancel-in-progress: false" "non-cancelling OCI rollback concurrency"
require_literal "$oci_rollback_workflow" "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683" "reviewed OCI rollback checkout pin"
require_literal "$oci_rollback_workflow" "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093" "reviewed download-artifact pin"
require_literal "$oci_rollback_workflow" "oracle-actions/configure-kubectl-oke@77a733d79446dabe7bf0e58eb56197d33ce4dc58" "reviewed OKE kubectl pin"
require_literal "$oci_rollback_workflow" "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02" "reviewed OCI rollback upload-artifact pin"
require_literal "$oci_rollback_workflow" "recover-partial-rollback-stan.sh" "reviewed partial rollback recovery operator"

require_literal "$branch_workflow" "pull_request_target:" "trusted PR metadata event"
require_literal "$branch_workflow" 'workflows: ["production-build"]' "trusted quality completion event"
require_literal "$branch_workflow" "pr_number:" "trusted bootstrap refresh input"
require_literal "$branch_workflow" "statuses: write" "status publication permission"
require_literal "$branch_workflow" "publish-pr-policy.js" "trusted policy publisher"
permission_inventory="$(
  ruby - "$WORKFLOW_PERMISSION_DIR" <<'RUBY'
require "yaml"

directory = ARGV.fetch(0)
writers = []
implicit = []
Dir[File.join(directory, "*.{yml,yaml}")].sort.each do |path|
  workflow = YAML.safe_load(File.read(path), aliases: false)
  next unless workflow.is_a?(Hash)

  workflow_permissions = workflow["permissions"]
  permission_sets = [workflow_permissions]
  jobs = workflow["jobs"]
  if jobs.is_a?(Hash)
    jobs.each do |name, job|
      next unless job.is_a?(Hash)

      if workflow_permissions.nil? && !job.key?("permissions")
        implicit << "#{File.basename(path)}:#{name}"
      end
      permission_sets << job["permissions"] if job.key?("permissions")
    end
  elsif workflow_permissions.nil?
    implicit << "#{File.basename(path)}:workflow"
  end
  writes_statuses = permission_sets.any? do |permissions|
    permissions == "write-all" ||
      permissions.is_a?(Hash) && permissions["statuses"] == "write"
  end
  writers << File.basename(path) if writes_statuses
end

puts "writers=#{writers.join(",")}"
puts "implicit=#{implicit.join(",")}"
RUBY
)"
status_writers="$(sed -n 's/^writers=//p' <<<"$permission_inventory")"
implicit_permissions="$(sed -n 's/^implicit=//p' <<<"$permission_inventory")"
[[ "$status_writers" = "$(basename "$branch_workflow")" ]] ||
  fail "branch-policy.yml must be the sole explicit statuses:write workflow; found: ${status_writers:-none}"
[[ -z "$implicit_permissions" ]] ||
  fail "every workflow job must declare effective permissions; missing: $implicit_permissions"
require_literal "$policy_script" 'const BRANCH_CONTEXT_PREFIX = "branch-policy"' "stable branch context"
require_literal "$policy_script" 'const QUALITY_CONTEXT_PREFIX = "pr-quality-gates"' "stable quality context"
require_literal "$policy_script" "pull.mergeSha" "unique PR merge snapshot status"
require_literal "$policy_script" "? [pull.headSha, pull.mergeSha]" "promotion head and merge statuses"
require_literal "$policy_script" "invalidatePublishedSnapshot" "stale-status invalidation"
snapshot_check_count="$(
  grep -Fc "await assertCurrentPullSnapshot(github, owner, repo, pull)" \
    "$policy_script"
)"
[[ "$snapshot_check_count" -ge 2 ]] ||
  fail "$policy_script must check the current pull before and after status publication"
require_literal "$policy_script" "relation.base?.sha === pull.baseSha" "exact base snapshot relation"

for live_workflow in "$oci_live_activate_workflow" "$oci_live_disable_workflow"; do
  require_literal "$live_workflow" "  workflow_dispatch:" "manual live control trigger"
  reject_literal "$live_workflow" "  workflow_run:" "automatic live control trigger"
  reject_literal "$live_workflow" "  push:" "push-triggered live control mutation"
  reject_literal "$live_workflow" "  schedule:" "scheduled live control mutation"
  require_literal "$live_workflow" "if: github.run_attempt == 1" "first-attempt-only live control"
  require_literal "$live_workflow" "name: oci-production" "protected OCI production environment"
  require_literal "$live_workflow" "group: oci-control-plane" "shared OCI control-plane concurrency"
  require_literal "$live_workflow" "cancel-in-progress: false" "non-cancelling live control"
done
require_literal "$oci_live_activate_workflow" "ACTIVATE OCI LIVE BETTING" "exact activation confirmation"
require_literal "$oci_live_activate_workflow" "COMMIT OCI LIVE BETTING" "exact activation commit"
require_literal "$oci_live_disable_workflow" "DISABLE OCI LIVE BETTING" "exact disable confirmation"

require_literal "$oci_data_workflow" "name: oci-live-data-rollout" "OCI live data workflow identity"
require_literal "$oci_data_workflow" "  workflow_dispatch:" "manual OCI live data trigger"
reject_literal "$oci_data_workflow" "  workflow_run:" "automatic OCI live data trigger"
reject_literal "$oci_data_workflow" "  push:" "push-triggered OCI live data mutation"
reject_literal "$oci_data_workflow" "  schedule:" "scheduled OCI live data mutation"
require_literal "$oci_data_workflow" "if: github.run_attempt == 1" "first-attempt-only OCI live data rollout"
require_literal "$oci_data_workflow" "name: oci-migration" "protected OCI migration environment"
require_literal "$oci_data_workflow" "group: oci-control-plane" "shared OCI control-plane concurrency"
require_literal "$oci_data_workflow" "cancel-in-progress: false" "non-cancelling OCI live data concurrency"
require_literal "$oci_data_workflow" "DRY RUN LIVE DATA EXACT SHA" "exact dry-run confirmation"
require_literal "$oci_data_workflow" "APPLY LIVE BACKFILLS EXACT SHA" "exact backfill confirmation"
require_literal "$oci_data_workflow" "APPLY LIVE SLIP INDEX EXACT SHA" "exact index confirmation"
require_literal "$oci_data_workflow" "live-data-maintenance-stan.sh enter" "legacy writer quiescence"
require_literal "$oci_data_workflow" "shared-mongo-operation-lock-stan.sh acquire" "database lock acquisition"
require_literal "$oci_data_workflow" "verify-live-betting-data-evidence-stan.sh" "tamper-evident data evidence"
require_literal "$oci_data_workflow" "baseline_recovery_run_id:" "bounded recovery baseline input"
require_literal "$oci_data_workflow" "ghcr-cache-recovery-" "exact recovery artifact binding"
require_literal "$oci_data_workflow" 'oci-production-rollback-${BASELINE_RECOVERY_RUN_ID}-1' "exact partial-recovery artifact binding"
require_literal "$oci_data_workflow" "validate-partial-recovery-authority-stan.sh" "partial-recovery evidence validator"
require_literal "$oci_data_workflow" "EXPECTED_BASELINE_RECOVERY_RUN_ID=\"\$BASELINE_RECOVERY_RUN_ID\"" "recovery authority chain verification"
require_literal "$oci_data_workflow" "Bind historical recovery source through its exact artifact" "historical recovery source binding"
require_literal "$oci_data_workflow" "BASELINE_RECOVERY_DIR=artifacts/recovery" "explicit recovery baseline handoff"

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
require_literal "$oci_recovery_workflow" 'CONFIRMATION: ${{ inputs.confirmation }}' "environment-bound recovery confirmation"
require_literal "$oci_recovery_workflow" '[ "$CONFIRMATION" = "STOP AZURE FOR EXACT MIGRATION" ]' "exact recovery confirmation"
reject_literal "$oci_recovery_workflow" '[ "${{ inputs.confirmation }}"' "direct recovery input interpolation"
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
oci_workflow_set="common-package-publish,ghcr-package-management,oci-capacity-acquire,oci-ghcr-cache-recovery,oci-infrastructure,oci-live-betting-activate,oci-live-betting-disable,oci-live-data-rollout,oci-migrate,oci-migration-recovery,oci-production-build,oci-production-deploy,oci-production-rollback,production-build,production-deploy,production-rollback"
[[ "$workflow_set" == "$oci_workflow_set" ]] ||
  fail "unexpected production workflow set: ${workflow_set:-none}"

echo "workflow_trigger_guard=PASS retired_workflows=${#retired[@]}"
