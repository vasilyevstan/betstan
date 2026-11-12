#!/usr/bin/env bash
set -euo pipefail

# Invoke the protected copy from the candidate repository root. This runner
# executes candidate code; it must never receive publishing or release authority.
fail() {
  printf 'source_quality_suite=FAIL reason=%s\n' "$*" >&2
  exit 1
}

[[ "$#" == 1 ]] || fail "usage: source-quality-suite.sh <suite-id>"
suite="$1"
case "$suite" in
  source-policy|package-auth|package-backoffice|package-bet|package-client|\
  package-common|package-event|package-gamemaster|package-moderation|\
  package-resulting|package-slip|package-telemetry|auth-image|manifest|ingress|\
  workflow|runtime-contracts|azure-contracts|oci-core|oci-live|oci-provenance|oci-rollback)
    ;;
  *) fail "unknown suite ID: $suite" ;;
esac

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
  done
}

require_files() {
  local file
  for file in "$@"; do
    [[ -f "$file" && -r "$file" ]] || fail "missing required file: $file"
  done
}

require_tools git
repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  fail "working directory must be a candidate Git checkout"
[[ "$(pwd -P)" == "$(cd "$repo_root" && pwd -P)" ]] ||
  fail "working directory must be the candidate repository root"
export CI=true

case "$suite" in
  source-policy)
    require_tools node
    require_files .github/scripts/publish-pr-policy.js .github/scripts/test-publish-pr-policy.js
    node --check .github/scripts/publish-pr-policy.js
    node --check .github/scripts/test-publish-pr-policy.js
    node .github/scripts/test-publish-pr-policy.js
    ;;

  package-*)
    require_tools node npm
    package="${suite#package-}"
    require_files "$package/package.json" "$package/package-lock.json"
    cd "$package"
    npm ci
    if [[ "$package" == common ]]; then
      # Common owns its build, both TypeScript compatibility checks and Node tests.
      npm run test:ci
    else
      export MONGOMS_DOWNLOAD_DIR="${MONGOMS_DOWNLOAD_DIR:-${RUNNER_TEMP:-$repo_root/.cache}/mongodb-binaries}"
      rm -f coverage/coverage-summary.json
      if [[ "$package" == client ]]; then
        npm test -- --watchAll=false --coverage --coverageReporters=json-summary \
          --collectCoverageFrom=src/hook/UseRequest.js \
          --collectCoverageFrom=src/pages/auth/NewUser.js \
          --collectCoverageFrom=src/pages/auth/LogIn.js \
          --collectCoverageFrom=src/pages/auth/LogOut.js
        npm run build
      else
        [[ -x ./node_modules/.bin/tsc ]] || fail "missing package TypeScript compiler"
        ./node_modules/.bin/tsc --noEmit
        npm run test:ci -- --runInBand --coverage --coverageReporters=json-summary
      fi
      node <<'JS'
const fs = require("node:fs");
const path = "coverage/coverage-summary.json";
if (!fs.existsSync(path)) throw new Error(`Missing ${path}`);
const total = JSON.parse(fs.readFileSync(path, "utf8")).total || {};
const lines = total.lines?.pct ?? 0;
const branchTotal = total.branches?.total ?? 0;
const branches = total.branches?.pct ?? 0;
console.log(`lines=${lines} branches=${branches} branchTotal=${branchTotal}`);
if (!Number.isFinite(lines) || lines < 80) throw new Error("Line coverage gate failed (<80%)");
if (!Number.isInteger(branchTotal) || branchTotal < 0 ||
    (branchTotal > 0 && (!Number.isFinite(branches) || branches < 80))) {
  throw new Error("Branch coverage gate failed (<80%)");
}
JS
    fi
    ;;

  auth-image)
    require_tools docker curl openssl
    require_files auth/Dockerfile auth/package.json auth/package-lock.json
    candidate_sha="$(git rev-parse --verify HEAD)"
    [[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || fail "candidate HEAD is not a full commit SHA"
    docker info >/dev/null
    container_name="betstan-auth-smoke-${candidate_sha:0:12}-$$-$RANDOM"
    image="betstan-auth-smoke:${candidate_sha}-$$-$RANDOM"
    scratch="$repo_root/.source-quality-auth-$$-$RANDOM"
    mkdir -m 700 "$scratch"
    cleanup_auth() {
      local container_id
      if [[ -f "$scratch/container-id" ]]; then
        container_id="$(cat "$scratch/container-id")"
        if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
          docker rm -f "$container_id" >/dev/null 2>&1 || true
        fi
      fi
      rm -rf "$scratch"
    }
    trap cleanup_auth EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    docker build --tag "$image" auth
    docker run --rm "$image" ./node_modules/.bin/tsc --noEmit
    export JWT_KEY
    JWT_KEY="$(openssl rand -hex 32)"
    docker run --detach --name "$container_name" \
      --cidfile "$scratch/container-id" --network host \
      --env JWT_KEY --env MONGO_URI=mongodb://127.0.0.1:27017/auth_container_smoke \
      "$image"
    require_files "$scratch/container-id"
    container_id="$(cat "$scratch/container-id")"
    [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || fail "Docker did not return an exact container ID"
    ready=false
    for ((attempt = 0; attempt < 30; attempt++)); do
      if curl --fail --silent --show-error --output "$scratch/response.json" \
          http://127.0.0.1:3000/api/auth/currentuser; then
        ready=true
        break
      fi
      sleep 2
    done
    if [[ "$ready" != true ]]; then
      docker logs "$container_id"
      fail "auth image did not become ready"
    fi
    grep -q '"currentUser":null' "$scratch/response.json"
    ;;

  manifest)
    require_tools ruby
    ruby <<'RUBY'
require "yaml"
directories = %w[infra/k8s infra/k8s-prod infra/k8s-stage]
directories.each { |directory| abort "Missing #{directory}" unless Dir.exist?(directory) }
files = directories.flat_map do |directory|
  Dir.glob(File.join(directory, "**", "*.{yaml,yml}"))
end.sort
abort "No Kubernetes manifest YAML files" if files.empty?
failed = false
files.each do |file|
  begin
    YAML.load_stream(File.read(file))
  rescue Psych::SyntaxError => error
    warn "#{file}: #{error.message}"
    failed = true
  end
end
abort "Kubernetes manifest YAML syntax validation failed" if failed
puts "Validated #{files.length} Kubernetes manifest YAML files"
RUBY
    ;;

  ingress)
    require_files infra/azure/agents/pre-commit-infra-check-stan.sh \
      infra/azure/agents/ingress-routing-guard-stan.sh
    [[ -x infra/azure/agents/ingress-routing-guard-stan.sh ]] ||
      fail "ingress guard must be executable"
    unset INGRESS_PROFILE INGRESS_FILE LEGACY_INGRESS_FILE
    # Precommit owns the production and local-dev ingress invocations plus the
    # infrastructure secret scan; running the production guard again duplicates it.
    INFRA_DIRS='infra .github/workflows' \
      INGRESS_GUARD=infra/azure/agents/ingress-routing-guard-stan.sh \
      bash infra/azure/agents/pre-commit-infra-check-stan.sh
    ;;

  workflow)
    require_tools ruby python3 actionlint
    ruby -ryaml -e '
      %w[
        .github/workflows/production-build.yml
        .github/workflows/production-deploy.yml
        .github/workflows/oci-live-data-rollout.yml
        .github/workflows/oci-live-betting-activate.yml
        .github/workflows/oci-live-betting-disable.yml
        .github/workflows/oci-production-deploy.yml
      ].each { |file| YAML.load_stream(File.read(file)) }
    '
    WORKFLOW_PERMISSION_DIR="$repo_root/.github/workflows" \
      ./infra/azure/agents/workflow-trigger-guard-stan.sh
    actionlint -shellcheck= .github/workflows/oci-*.yml \
      .github/workflows/ghcr-package-management.yml
    ;;

  runtime-contracts)
    require_tools node python3
    shell_scripts=(
      infra/azure/agents/deploy-validation-loop-stan.sh
      infra/azure/agents/smoke-liveness-stan.sh
      infra/azure/agents/validation-loop-stan.sh
      infra/azure/agents/service-ops-stan.sh
      infra/azure/agents/node-logs-stan.sh
      infra/azure/agents/ingress-routing-guard-stan.sh
      infra/azure/agents/branch-policy-guard-stan.sh
      infra/azure/agents/test-branch-policy-guard-stan.sh
      infra/azure/agents/production-workflow-inventory-stan.sh
      infra/azure/agents/test-production-workflow-inventory-stan.sh
      infra/azure/agents/test-pr-validation-stan.sh
      infra/azure/agents/wait-required-checks-stan.sh
      infra/azure/agents/test-wait-required-checks-stan.sh
      infra/azure/agents/test-workflow-run-provenance-stan.sh
      infra/azure/agents/reconcile-nodepool-profile-stan.sh
      infra/azure/agents/pre-commit-infra-check-stan.sh
      infra/azure/agents/post-merge-verification-stan.sh
      infra/azure/agents/rollback-readiness-stan.sh
      infra/azure/agents/live-betting-readiness-lib.sh
      infra/azure/agents/live-betting-readiness-stan.sh
      infra/azure/agents/live-betting-readiness-test-lib.sh
      infra/azure/agents/test-deploy-validation-loop-stan.sh
      infra/azure/agents/test-deployment-safety-ci-stan.sh
      infra/azure/agents/test-live-betting-readiness-stan.sh
      infra/azure/agents/test-live-betting-rollback-readiness-stan.sh
      infra/azure/agents/test-production-rollback-stan.sh
      infra/oci/agents/deploy-validation-loop-stan.sh
      infra/oci/agents/live-betting-readiness-stan.sh
      infra/oci/scripts/deploy.sh
      infra/oci/scripts/live-data-maintenance-stan.sh
      infra/oci/scripts/live-betting-control-stan.sh
      infra/oci/scripts/revalidate-live-activation-stan.sh
      infra/oci/scripts/live-betting-data-rollout-stan.sh
      infra/oci/scripts/shared-mongo-operation-lock-stan.sh
      infra/oci/scripts/verify-live-betting-data-evidence-stan.sh
      infra/oci/tests/test-deploy-validation-loop-stan.sh
      infra/oci/tests/test-live-data-maintenance-stan.sh
      infra/oci/tests/test-live-betting-control-stan.sh
      infra/oci/tests/test-revalidate-live-activation-stan.sh
      infra/oci/tests/test-live-betting-data-rollout-stan.sh
      infra/oci/tests/test-live-betting-readiness-stan.sh
      infra/oci/tests/rollback-live-readiness-contract.sh
      infra/oci/tests/rollback-contract.sh
    )
    require_files "${shell_scripts[@]}"
    for script in "${shell_scripts[@]}"; do
      bash -n "$script"
    done
    python3 -m py_compile infra/azure/agents/image_provenance_stan.py \
      infra/azure/agents/test_image_provenance_stan.py
    ./infra/azure/agents/test-branch-policy-guard-stan.sh
    ./infra/azure/agents/test-production-workflow-inventory-stan.sh
    ./infra/azure/agents/test-pr-validation-stan.sh
    ./infra/azure/agents/test-wait-required-checks-stan.sh
    ./infra/azure/agents/test-workflow-run-provenance-stan.sh
    python3 infra/azure/agents/test_image_provenance_stan.py
    ;;

  azure-contracts)
    # Full producer requires OCI live/provenance results: they own rollout/GHCR.
    BETSTAN_CONTRACT_ORCHESTRATED=1 \
      ./infra/azure/agents/test-deployment-safety-ci-stan.sh
    ./infra/azure/agents/test-deploy-validation-loop-stan.sh
    ./infra/azure/agents/test-live-betting-readiness-stan.sh
    ./infra/azure/agents/test-live-betting-rollback-readiness-stan.sh
    ./infra/azure/agents/test-production-rollback-stan.sh
    ;;

  oci-core|oci-live|oci-provenance|oci-rollback)
    BETSTAN_CONTRACT_SHARD="${suite#oci-}" BETSTAN_RUN_ALL=0 \
      ./infra/oci/tests/run-contracts.sh
    ;;
esac

printf 'source_quality_suite=PASS suite_id=%s\n' "$suite"
