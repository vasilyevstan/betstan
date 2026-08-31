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
if [[ "$(basename "$0")" == "pr-validator" &&
      "${STUB_VALIDATION_FAIL:-false}" == "true" ]]; then
  exit 1
fi
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

gh() {
  if [[ "$1 $2" == "pr view" ]]; then
    if [[ "$*" == *"--json headRefOid,baseRefOid"* ]]; then
      printf '{"headRefOid":"%s","baseRefOid":"%s"}\n' \
        "${STUB_LATEST_HEAD_SHA:-$HEAD_SHA}" \
        "${STUB_LATEST_BASE_SHA:-$BASE_SHA}"
      return
    fi

    local labels='[{"name":"copilot-cli-managed"}]'
    if [[ "${STUB_LABEL:-present}" == "missing" ]]; then
      labels='[]'
    fi
    local base_ref="${STUB_BASE_REF:-master}"
    local head_ref="${STUB_HEAD_REF:-dev}"
    printf '%s\n' \
      "{\"number\":224,\"title\":\"safe change\",\"state\":\"OPEN\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"headRefName\":\"$head_ref\",\"headRefOid\":\"$HEAD_SHA\",\"headRepository\":{\"nameWithOwner\":\"example/repo\"},\"baseRefName\":\"$base_ref\",\"baseRefOid\":\"$BASE_SHA\",\"labels\":$labels,\"url\":\"https://example.invalid/pr/224\"}"
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
)

env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true \
  "$MERGE_SAFETY" 224 >/dev/null

env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true \
  STUB_BASE_REF=dev STUB_HEAD_REF=docs/governance \
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

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true \
  STUB_LATEST_HEAD_SHA=2222222222222222222222222222222222222222 \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "automatic merge safety accepted a changed PR head" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true \
  STUB_LATEST_BASE_SHA=3333333333333333333333333333333333333333 \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "automatic merge safety accepted a changed PR base" >&2
  exit 1
fi

human_master_inspection=""
if human_master_inspection="$(
  env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
    "$MERGE_SAFETY" 224 2>&1
)"; then
  echo "human master merge safety passed without exact-SHA approval" >&2
  exit 1
fi
grep -Fq "head_sha=$HEAD_SHA" <<<"$human_master_inspection"
grep -Fq "production_workflows=oci-production-build,production-build" \
  <<<"$human_master_inspection"

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  STUB_BASE_REF=dev STUB_HEAD_REF=docs/governance \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "human dev merge safety passed without exact-SHA approval" >&2
  exit 1
fi

env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  APPROVED_SHA="$HEAD_SHA" \
  STUB_BASE_REF=dev STUB_HEAD_REF=docs/governance \
  "$MERGE_SAFETY" 224 >/dev/null

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  APPROVED_SHA="$HEAD_SHA" \
  STUB_BASE_REF=dev STUB_HEAD_REF=docs/governance \
  STUB_UNRESOLVED=true \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "human exact-SHA approval bypassed an unresolved review thread" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  APPROVED_SHA="$HEAD_SHA" \
  STUB_BASE_REF=dev STUB_HEAD_REF=docs/governance \
  STUB_LATEST_HEAD_SHA=2222222222222222222222222222222222222222 \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "human exact-SHA approval accepted a changed PR head" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  APPROVED_SHA="$HEAD_SHA" \
  STUB_BASE_REF=dev STUB_HEAD_REF=docs/governance \
  STUB_LATEST_BASE_SHA=3333333333333333333333333333333333333333 \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "human exact-SHA approval accepted a changed PR base" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  APPROVED_SHA="$HEAD_SHA" \
  STUB_BASE_REF=dev STUB_HEAD_REF=docs/governance \
  STUB_VALIDATION_FAIL=true \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "human exact-SHA approval bypassed failed validation" >&2
  exit 1
fi

env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  APPROVED_SHA="$HEAD_SHA" \
  APPROVED_WORKFLOWS=production-build,oci-production-build \
  "$MERGE_SAFETY" 224 >/dev/null

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  APPROVED_SHA="$HEAD_SHA" \
  APPROVED_WORKFLOWS=production-build \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "human exact-SHA approval accepted an incomplete workflow inventory" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  APPROVED_SHA="$HEAD_SHA" \
  APPROVED_WORKFLOWS=production-build,oci-production-build \
  STUB_ACTIVE=true \
  "$MERGE_SAFETY" 224 >/dev/null 2>&1; then
  echo "human exact-SHA approval bypassed production exclusivity" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true \
  "$MERGE_SAFETY" not-a-number >/dev/null 2>&1; then
  echo "merge safety accepted a non-numeric PR identifier" >&2
  exit 1
fi

echo "pr_merge_safety_tests=PASS"
