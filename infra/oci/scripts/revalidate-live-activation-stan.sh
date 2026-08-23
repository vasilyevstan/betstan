#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${SOURCE_SHA:-}"
BUILD_RUN_ID="${BUILD_RUN_ID:-}"
INFRASTRUCTURE_RUN_ID="${INFRASTRUCTURE_RUN_ID:-}"
DEPLOYMENT_RUN_ID="${DEPLOYMENT_RUN_ID:-}"
REPOSITORY="${REPOSITORY:-${GITHUB_REPOSITORY:-}}"

[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "SOURCE_SHA must be a full lowercase commit SHA" >&2
  exit 1
}
for run_id in "$BUILD_RUN_ID" "$INFRASTRUCTURE_RUN_ID" "$DEPLOYMENT_RUN_ID"; do
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || {
    echo "all provenance run IDs must be positive integers" >&2
    exit 1
  }
done
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "REPOSITORY is invalid" >&2
  exit 1
}
[[ "${GITHUB_REF_NAME:-}" == "master" ]] || {
  echo "activation must run from master" >&2
  exit 1
}
[[ "${GITHUB_RUN_ATTEMPT:-}" == "1" ]] || {
  echo "activation reruns are not permitted" >&2
  exit 1
}

for command_name in gh git; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command is unavailable: $command_name" >&2
    exit 1
  }
done

git fetch --quiet origin master:refs/remotes/origin/master
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]] || {
  echo "checked out source no longer matches the approved SHA" >&2
  exit 1
}
[[ "$(git rev-parse origin/master)" == "$SOURCE_SHA" ]] || {
  echo "approved SHA is no longer current master" >&2
  exit 1
}

verify_run() {
  local run_id="$1"
  local workflow_file="$2"
  local expected_event="$3"
  local path event head_sha head_branch repository status conclusion attempt

  read -r path event head_sha head_branch repository status conclusion attempt <<<"$(
    gh api "repos/$REPOSITORY/actions/runs/$run_id" \
      --jq '[.path,.event,.head_sha,.head_branch,.head_repository.full_name,.status,.conclusion,.run_attempt] | @tsv'
  )"
  [[ "$path" == ".github/workflows/$workflow_file" ]]
  [[ "$event" == "$expected_event" ]]
  [[ "$head_sha" == "$SOURCE_SHA" ]]
  [[ "$head_branch" == "master" ]]
  [[ "$repository" == "$REPOSITORY" ]]
  [[ "$status" == "completed" ]]
  [[ "$conclusion" == "success" ]]
  [[ "$attempt" == "1" ]]
}

verify_run "$BUILD_RUN_ID" oci-production-build.yml workflow_run
verify_run "$INFRASTRUCTURE_RUN_ID" oci-infrastructure.yml workflow_dispatch
verify_run "$DEPLOYMENT_RUN_ID" oci-production-deploy.yml workflow_dispatch

echo "live_activation_revalidation=PASS source_sha=$SOURCE_SHA"
