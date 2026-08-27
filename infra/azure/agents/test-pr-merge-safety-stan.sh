#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MERGE_SAFETY="$ROOT_DIR/infra/azure/agents/pr-merge-safety-stan.sh"
HEAD_SHA="1111111111111111111111111111111111111111"
BASE_SHA="0000000000000000000000000000000000000000"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

for helper in branch-policy pr-validator; do
  cat >"$tmp_dir/$helper" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$tmp_dir/$helper"
done

cat >"$tmp_dir/workflow-inventory" <<'SH'
#!/usr/bin/env bash
echo "production_workflows=oci-production-build,production-build"
SH
chmod +x "$tmp_dir/workflow-inventory"

cat >"$tmp_dir/production-exclusivity" <<'SH'
#!/usr/bin/env bash
[[ "${STUB_ACTIVE:-false}" != "true" ]]
SH
chmod +x "$tmp_dir/production-exclusivity"

cat >"$tmp_dir/work-lease" <<'SH'
#!/usr/bin/env bash
[[ "${STUB_LEASE_VALID:-true}" == "true" ]] || exit 1
[[ "$*" == *"verify"* ]]
[[ "$*" == *"--owner-task task-224"* ]]
[[ "$*" == *"--owner-pr 224"* ]]
[[ "$*" == *"--owner-branch dev"* ]]
[[ "$*" == *"--head-sha $HEAD_SHA"* ]]
SH
chmod +x "$tmp_dir/work-lease"

gh() {
  if [[ "$1 $2" == "pr view" ]]; then
    if [[ "$*" == *"--json headRefOid,baseRefOid"* ]]; then
      printf '{"headRefOid":"%s","baseRefOid":"%s"}\n' \
        "${STUB_LATEST_HEAD_SHA:-$HEAD_SHA}" "$BASE_SHA"
      return
    fi

    local labels='[{"name":"copilot-cli-managed"}]'
    if [[ "${STUB_LABEL:-present}" == "missing" ]]; then
      labels='[]'
    fi
    printf '%s\n' \
      "{\"number\":224,\"title\":\"safe promotion\",\"state\":\"OPEN\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"headRefName\":\"dev\",\"headRefOid\":\"$HEAD_SHA\",\"headRepository\":{\"nameWithOwner\":\"example/repo\"},\"baseRefName\":\"master\",\"baseRefOid\":\"$BASE_SHA\",\"labels\":$labels,\"url\":\"https://example.invalid/pr/224\"}"
  elif [[ "$1 $2" == "api graphql" ]]; then
    local nodes='[]'
    if [[ "${STUB_UNRESOLVED:-false}" == "true" ]]; then
      nodes='[{"isResolved":false}]'
    fi
    printf '%s\n' \
      "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"pageInfo\":{\"hasNextPage\":false},\"nodes\":$nodes}}}}}"
  elif [[ "$1" == "api" && "$2" == *"/compare/"* ]]; then
    echo "ahead"
  else
    echo "unexpected gh invocation: $*" >&2
    return 1
  fi
}
export -f gh
export HEAD_SHA BASE_SHA

common_env=(
  "REPO=example/repo"
  "BRANCH_POLICY_GUARD=$tmp_dir/branch-policy"
  "PR_VALIDATOR=$tmp_dir/pr-validator"
  "WORKFLOW_INVENTORY=$tmp_dir/workflow-inventory"
  "PRODUCTION_RUN_EXCLUSIVITY=$tmp_dir/production-exclusivity"
  "PRODUCTION_WORK_LEASE=$tmp_dir/work-lease"
  "PRODUCTION_WORK_LEASE_OWNER_TASK=task-224"
)

env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true \
  "$MERGE_SAFETY" 224 >/dev/null

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true STUB_LABEL=missing \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "automatic merge safety accepted an unlabelled PR" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true STUB_UNRESOLVED=true \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "automatic merge safety accepted an unresolved review thread" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true STUB_ACTIVE=true \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "automatic merge safety accepted competing production activity" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true STUB_LEASE_VALID=false \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "automatic merge safety accepted an invalid work lease" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true \
  STUB_LATEST_HEAD_SHA=2222222222222222222222222222222222222222 \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "automatic merge safety accepted a changed PR head" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "manual merge safety passed without explicit approval" >&2
  exit 1
fi

env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  APPROVED_SHA="$HEAD_SHA" \
  APPROVED_WORKFLOWS=production-build,oci-production-build \
  "$MERGE_SAFETY" 224 >/dev/null

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true \
  "$MERGE_SAFETY" not-a-number >/dev/null 2>&1; then
  echo "merge safety accepted a non-numeric PR identifier" >&2
  exit 1
fi

echo "pr_merge_safety_tests=PASS"
