#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APPROVER="$ROOT_DIR/infra/azure/agents/copilot-cli-run-approval-stan.sh"
SHA="1111111111111111111111111111111111111111"
RUN_ID=123
tmp_dir="$(mktemp -d)"
approval_log="$tmp_dir/approval.log"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

cat >"$tmp_dir/production-exclusivity" <<'SH'
#!/usr/bin/env bash
[[ "${STUB_ACTIVE:-false}" != "true" ]]
SH
chmod +x "$tmp_dir/production-exclusivity"

gh() {
  if [[ "$*" == *"--method POST"* ]]; then
    [[ "$*" == *"environment_ids[]=456"* ]]
    [[ "$*" == *"state=approved"* ]]
    [[ "$*" == *"Copilot CLI automatic approval"* ]]
    printf 'approved\n' >>"$STUB_APPROVAL_LOG"
    printf '%s\n' '[{"environment":"production-emergency","state":"approved"}]'
  elif [[ "$1" == "api" && "$2" == *"/git/ref/heads/master"* ]]; then
    printf '%s\n' "{\"object\":{\"sha\":\"${STUB_MASTER_SHA:-$SHA}\"}}"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/$RUN_ID/pending_deployments"* ]]; then
    printf '%s\n' \
      "[{\"environment\":{\"id\":456,\"name\":\"${STUB_ENVIRONMENT:-production-emergency}\"},\"current_user_can_approve\":true}]"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/$RUN_ID" ]]; then
    printf '%s\n' \
      "{\"id\":$RUN_ID,\"path\":\".github/workflows/${STUB_WORKFLOW:-production-build.yml}\",\"event\":\"push\",\"head_sha\":\"$SHA\",\"head_branch\":\"master\",\"head_repository\":{\"full_name\":\"example/repo\"},\"run_attempt\":${STUB_ATTEMPT:-1},\"status\":\"waiting\"}"
  elif [[ "$1" == "api" && "$2" == *"/commits/$SHA/pulls"* ]]; then
    local labels='[{"name":"copilot-cli-managed"}]'
    if [[ "${STUB_LABEL:-present}" == "missing" ]]; then
      labels='[]'
    fi
    printf '%s\n' \
      "[{\"number\":225,\"merged_at\":\"2026-08-21T00:00:00Z\",\"merge_commit_sha\":\"$SHA\",\"base\":{\"ref\":\"master\"},\"head\":{\"ref\":\"dev\"},\"labels\":$labels}]"
  else
    echo "unexpected gh invocation: $*" >&2
    return 1
  fi
}
export -f gh
export SHA RUN_ID STUB_APPROVAL_LOG="$approval_log"

common_env=(
  "REPO=example/repo"
  "EXPECTED_SHA=$SHA"
  "EXPECTED_WORKFLOW=production-build.yml"
  "EXPECTED_ENVIRONMENT=production-emergency"
  "PRODUCTION_RUN_EXCLUSIVITY=$tmp_dir/production-exclusivity"
)

env "${common_env[@]}" "$APPROVER" "$RUN_ID" >/dev/null

env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=true \
  "$APPROVER" "$RUN_ID" --approve >/dev/null
[[ "$(wc -l <"$approval_log" | tr -d ' ')" == "1" ]]

if env "${common_env[@]}" STUB_LABEL=missing \
  "$APPROVER" "$RUN_ID" >/dev/null 2>&1; then
  echo "run approver accepted an unlabelled promotion" >&2
  exit 1
fi

if env "${common_env[@]}" STUB_ACTIVE=true \
  "$APPROVER" "$RUN_ID" >/dev/null 2>&1; then
  echo "run approver accepted competing production activity" >&2
  exit 1
fi

if env "${common_env[@]}" STUB_ATTEMPT=2 \
  "$APPROVER" "$RUN_ID" >/dev/null 2>&1; then
  echo "run approver accepted a rerun" >&2
  exit 1
fi

if env "${common_env[@]}" STUB_MASTER_SHA=2222222222222222222222222222222222222222 \
  "$APPROVER" "$RUN_ID" >/dev/null 2>&1; then
  echo "run approver accepted a stale master SHA" >&2
  exit 1
fi

if env "${common_env[@]}" STUB_ENVIRONMENT=unexpected \
  "$APPROVER" "$RUN_ID" >/dev/null 2>&1; then
  echo "run approver accepted an unexpected environment" >&2
  exit 1
fi

if env "${common_env[@]}" COPILOT_CLI_AUTO_APPROVE=false \
  "$APPROVER" "$RUN_ID" --approve >/dev/null 2>&1; then
  echo "run approver mutated without automatic approval mode" >&2
  exit 1
fi

echo "copilot_cli_run_approval_tests=PASS"
