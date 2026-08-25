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
      "{\"id\":$RUN_ID,\"path\":\".github/workflows/${STUB_WORKFLOW:-production-build.yml}\",\"display_title\":\"${STUB_DISPLAY_TITLE:-production-build}\",\"event\":\"${STUB_EVENT:-push}\",\"head_sha\":\"$SHA\",\"head_branch\":\"master\",\"head_repository\":{\"full_name\":\"example/repo\"},\"run_attempt\":${STUB_ATTEMPT:-1},\"status\":\"waiting\"}"
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

env \
  REPO=example/repo \
  EXPECTED_SHA="$SHA" \
  EXPECTED_WORKFLOW=oci-live-betting-activate.yml \
  EXPECTED_ENVIRONMENT=oci-production \
  PRODUCTION_RUN_EXCLUSIVITY="$tmp_dir/production-exclusivity" \
  STUB_WORKFLOW=oci-live-betting-activate.yml \
  STUB_EVENT=workflow_dispatch \
  STUB_ENVIRONMENT=oci-production \
    "$APPROVER" "$RUN_ID" >/dev/null

env \
  REPO=example/repo \
  EXPECTED_SHA="$SHA" \
  EXPECTED_WORKFLOW=oci-live-betting-disable.yml \
  EXPECTED_ENVIRONMENT=oci-production \
  PRODUCTION_RUN_EXCLUSIVITY="$tmp_dir/production-exclusivity" \
  STUB_WORKFLOW=oci-live-betting-disable.yml \
  STUB_EVENT=workflow_dispatch \
  STUB_ENVIRONMENT=oci-production \
    "$APPROVER" "$RUN_ID" >/dev/null

env \
  REPO=example/repo \
  EXPECTED_SHA="$SHA" \
  EXPECTED_WORKFLOW=oci-infrastructure.yml \
  EXPECTED_ENVIRONMENT=oci-infrastructure \
  EXPECTED_DISPLAY_TITLE="oci-infrastructure finalize $SHA" \
  PRODUCTION_RUN_EXCLUSIVITY="$tmp_dir/production-exclusivity" \
  STUB_WORKFLOW=oci-infrastructure.yml \
  STUB_EVENT=workflow_dispatch \
  STUB_ENVIRONMENT=oci-infrastructure \
  STUB_DISPLAY_TITLE="oci-infrastructure finalize $SHA" \
    "$APPROVER" "$RUN_ID" >/dev/null

env \
  REPO=example/repo \
  EXPECTED_SHA="$SHA" \
  EXPECTED_WORKFLOW=oci-capacity-acquire.yml \
  EXPECTED_ENVIRONMENT=oci-capacity-acquire \
  EXPECTED_DISPLAY_TITLE="oci-capacity-acquire $SHA" \
  PRODUCTION_RUN_EXCLUSIVITY="$tmp_dir/production-exclusivity" \
  STUB_WORKFLOW=oci-capacity-acquire.yml \
  STUB_EVENT=workflow_dispatch \
  STUB_ENVIRONMENT=oci-capacity-acquire \
  STUB_DISPLAY_TITLE="oci-capacity-acquire $SHA" \
    "$APPROVER" "$RUN_ID" >/dev/null

for phase in dry-run apply-backfills apply-slip-index; do
  env \
    REPO=example/repo \
    EXPECTED_SHA="$SHA" \
    EXPECTED_WORKFLOW=oci-live-data-rollout.yml \
    EXPECTED_ENVIRONMENT=oci-migration \
    EXPECTED_DISPLAY_TITLE="oci-live-data $phase $SHA" \
    PRODUCTION_RUN_EXCLUSIVITY="$tmp_dir/production-exclusivity" \
    STUB_WORKFLOW=oci-live-data-rollout.yml \
    STUB_EVENT=workflow_dispatch \
    STUB_ENVIRONMENT=oci-migration \
    STUB_DISPLAY_TITLE="oci-live-data $phase $SHA" \
      "$APPROVER" "$RUN_ID" >/dev/null
done

if env \
  REPO=example/repo \
  EXPECTED_SHA="$SHA" \
  EXPECTED_WORKFLOW=oci-infrastructure.yml \
  EXPECTED_ENVIRONMENT=oci-infrastructure \
  EXPECTED_DISPLAY_TITLE="oci-infrastructure finalize $SHA" \
  PRODUCTION_RUN_EXCLUSIVITY="$tmp_dir/production-exclusivity" \
  STUB_WORKFLOW=oci-infrastructure.yml \
  STUB_EVENT=workflow_dispatch \
  STUB_ENVIRONMENT=oci-infrastructure \
  STUB_DISPLAY_TITLE="oci-infrastructure prepare $SHA" \
    "$APPROVER" "$RUN_ID" >/dev/null 2>&1; then
  echo "run approver accepted a different infrastructure phase" >&2
  exit 1
fi

if env \
  REPO=example/repo \
  EXPECTED_SHA="$SHA" \
  EXPECTED_WORKFLOW=oci-live-data-rollout.yml \
  EXPECTED_ENVIRONMENT=oci-migration \
  EXPECTED_DISPLAY_TITLE="oci-live-data dry-run $SHA" \
  PRODUCTION_RUN_EXCLUSIVITY="$tmp_dir/production-exclusivity" \
  STUB_WORKFLOW=oci-live-data-rollout.yml \
  STUB_EVENT=workflow_dispatch \
  STUB_ENVIRONMENT=oci-migration \
  STUB_DISPLAY_TITLE="oci-live-data apply-backfills $SHA" \
    "$APPROVER" "$RUN_ID" >/dev/null 2>&1; then
  echo "run approver accepted a different live-data phase" >&2
  exit 1
fi

if env \
  REPO=example/repo \
  EXPECTED_SHA="$SHA" \
  EXPECTED_WORKFLOW=oci-migrate.yml \
  EXPECTED_ENVIRONMENT=oci-migration \
  EXPECTED_DISPLAY_TITLE="oci-migrate $SHA" \
  PRODUCTION_RUN_EXCLUSIVITY="$tmp_dir/production-exclusivity" \
  STUB_WORKFLOW=oci-migrate.yml \
  STUB_EVENT=workflow_dispatch \
  STUB_ENVIRONMENT=oci-migration \
  STUB_DISPLAY_TITLE="oci-migrate $SHA" \
    "$APPROVER" "$RUN_ID" >/dev/null 2>&1; then
  echo "run approver accepted the broad OCI migration workflow" >&2
  exit 1
fi

for workflow_environment in \
  'ghcr-package-management.yml:oci-infrastructure' \
  'oci-ghcr-cache-recovery.yml:oci-production'; do
  IFS=: read -r workflow environment <<<"$workflow_environment"
  if env \
    REPO=example/repo \
    EXPECTED_SHA="$SHA" \
    EXPECTED_WORKFLOW="$workflow" \
    EXPECTED_ENVIRONMENT="$environment" \
    PRODUCTION_RUN_EXCLUSIVITY="$tmp_dir/production-exclusivity" \
    STUB_WORKFLOW="$workflow" \
    STUB_EVENT=workflow_dispatch \
    STUB_ENVIRONMENT="$environment" \
      "$APPROVER" "$RUN_ID" >/dev/null 2>&1; then
    echo "run approver accepted human-gated GHCR workflow $workflow" >&2
    exit 1
  fi
done

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
