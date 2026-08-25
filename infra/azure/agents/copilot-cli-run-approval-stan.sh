#!/usr/bin/env bash
set -euo pipefail

# Purpose: fail-closed validation and optional approval of a bounded
#          Copilot CLI-managed production workflow gate.
# Usage:
#   EXPECTED_SHA=<sha> EXPECTED_WORKFLOW=production-build.yml \
#     EXPECTED_ENVIRONMENT=production-emergency \
#     ./infra/azure/agents/copilot-cli-run-approval-stan.sh <run-id>
#   COPILOT_CLI_AUTO_APPROVE=true ... \
#     ./infra/azure/agents/copilot-cli-run-approval-stan.sh <run-id> --approve
#   EXPECTED_SHA=<sha> EXPECTED_WORKFLOW=oci-infrastructure.yml \
#     EXPECTED_ENVIRONMENT=oci-infrastructure \
#     EXPECTED_DISPLAY_TITLE="oci-infrastructure finalize <sha>" \
#     ./infra/azure/agents/copilot-cli-run-approval-stan.sh <run-id>
#   EXPECTED_SHA=<sha> EXPECTED_WORKFLOW=oci-live-data-rollout.yml \
#     EXPECTED_ENVIRONMENT=oci-migration \
#     EXPECTED_DISPLAY_TITLE="oci-live-data dry-run <sha>" \
#     ./infra/azure/agents/copilot-cli-run-approval-stan.sh <run-id>

REPO="${REPO:-vasilyevstan/betstan}"
RUN_ID="${1:-${RUN_ID:-}}"
ACTION="${2:-}"
EXPECTED_SHA="${EXPECTED_SHA:-}"
EXPECTED_WORKFLOW="${EXPECTED_WORKFLOW:-}"
EXPECTED_ENVIRONMENT="${EXPECTED_ENVIRONMENT:-}"
EXPECTED_DISPLAY_TITLE="${EXPECTED_DISPLAY_TITLE:-}"
CLI_MANAGED_LABEL="${COPILOT_CLI_MANAGED_LABEL:-copilot-cli-managed}"
AUTO_APPROVE="${COPILOT_CLI_AUTO_APPROVE:-false}"
PRODUCTION_RUN_EXCLUSIVITY="${PRODUCTION_RUN_EXCLUSIVITY:-./infra/azure/agents/production-run-exclusivity-stan.sh}"

fail() {
  echo "safe_to_approve=no"
  echo "reason=$*" >&2
  exit 1
}

[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]] || fail "run ID must be a positive integer"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "EXPECTED_SHA must be a complete lowercase SHA"
[[ "$AUTO_APPROVE" == "true" || "$AUTO_APPROVE" == "false" ]] ||
  fail "COPILOT_CLI_AUTO_APPROVE must be true or false"
[[ -z "$ACTION" || "$ACTION" == "--approve" ]] ||
  fail "the only supported action is --approve"
if [[ "$ACTION" == "--approve" && "$AUTO_APPROVE" != "true" ]]; then
  fail "--approve requires COPILOT_CLI_AUTO_APPROVE=true"
fi

case "$EXPECTED_WORKFLOW:$EXPECTED_ENVIRONMENT" in
  production-build.yml:production-emergency)
    expected_event="push"
    ;;
  production-deploy.yml:production-emergency)
    expected_event="workflow_dispatch"
    ;;
  oci-production-build.yml:oci-build)
    expected_event="workflow_run"
    ;;
  oci-production-deploy.yml:oci-production)
    expected_event="workflow_dispatch"
    ;;
  oci-live-betting-activate.yml:oci-production)
    expected_event="workflow_dispatch"
    ;;
  oci-live-betting-disable.yml:oci-production)
    expected_event="workflow_dispatch"
    ;;
  oci-infrastructure.yml:oci-infrastructure)
    expected_event="workflow_dispatch"
    [[ "$EXPECTED_DISPLAY_TITLE" == \
      "oci-infrastructure finalize $EXPECTED_SHA" ]] ||
      fail "OCI infrastructure approval requires the exact finalize run title"
    ;;
  oci-capacity-acquire.yml:oci-capacity-acquire)
    expected_event="workflow_dispatch"
    [[ "$EXPECTED_DISPLAY_TITLE" == \
      "oci-capacity-acquire $EXPECTED_SHA" ]] ||
      fail "OCI capacity approval requires the exact current-master run title"
    ;;
  oci-live-data-rollout.yml:oci-migration)
    expected_event="workflow_dispatch"
    case "$EXPECTED_DISPLAY_TITLE" in
      "oci-live-data dry-run $EXPECTED_SHA" | \
        "oci-live-data apply-backfills $EXPECTED_SHA" | \
        "oci-live-data apply-slip-index $EXPECTED_SHA")
        ;;
        *)
          fail "OCI live-data approval requires an exact bounded phase run title"
          ;;
    esac
    ;;
  ghcr-package-management.yml:oci-infrastructure | \
  oci-ghcr-cache-recovery.yml:oci-production)
    fail "GHCR bootstrap, validation, prune, build repair, and cache recovery require current-user approval"
    ;;
  *)
    fail "workflow/environment pair is not eligible for automatic approval"
    ;;
esac

read_master_sha() {
  gh api "repos/$REPO/git/ref/heads/master" |
    python3 -c '
import json
import sys

payload = json.load(sys.stdin)
print((payload.get("object") or {}).get("sha", ""))
'
}

read_run() {
  gh api "repos/$REPO/actions/runs/$RUN_ID"
}

read_pending() {
  gh api "repos/$REPO/actions/runs/$RUN_ID/pending_deployments"
}

validate_run() {
  python3 - "$1" "$RUN_ID" "$REPO" "$EXPECTED_SHA" \
    "$EXPECTED_WORKFLOW" "$expected_event" "$EXPECTED_DISPLAY_TITLE" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
run_id, repository, sha, workflow, event, display_title = sys.argv[2:]
failures = []
if str(payload.get("id", "")) != run_id:
    failures.append("run ID changed")
if payload.get("path") != f".github/workflows/{workflow}":
    failures.append("workflow path mismatch")
if payload.get("event") != event:
    failures.append("workflow event mismatch")
if display_title and payload.get("display_title") != display_title:
    failures.append("workflow display title mismatch")
if payload.get("head_sha") != sha:
    failures.append("run SHA mismatch")
if payload.get("head_branch") != "master":
    failures.append("run is not bound to master")
if (payload.get("head_repository") or {}).get("full_name") != repository:
    failures.append("run belongs to another repository")
if payload.get("run_attempt") != 1:
    failures.append("only first-attempt runs are eligible")
if payload.get("status") not in {"queued", "in_progress", "waiting", "pending"}:
    failures.append("run is not awaiting execution or approval")
if failures:
    raise SystemExit("; ".join(failures))
PY
}

master_sha="$(read_master_sha)"
[[ "$master_sha" == "$EXPECTED_SHA" ]] ||
  fail "EXPECTED_SHA is no longer current master"

run_json="$(read_run)"
validate_run "$run_json" || fail "run provenance validation failed"

promotion_json="$(gh api "repos/$REPO/commits/$EXPECTED_SHA/pulls")"
if ! python3 - "$promotion_json" "$EXPECTED_SHA" "$CLI_MANAGED_LABEL" <<'PY'
import json
import sys

pulls = json.loads(sys.argv[1])
sha = sys.argv[2]
label = sys.argv[3]
matches = []
for pull in pulls:
    labels = {entry.get("name") for entry in pull.get("labels", [])}
    if (
        pull.get("merged_at")
        and pull.get("merge_commit_sha") == sha
        and (pull.get("base") or {}).get("ref") == "master"
        and (pull.get("head") or {}).get("ref") == "dev"
        and label in labels
    ):
        matches.append(pull.get("number"))
if len(matches) != 1:
    raise SystemExit(f"expected one CLI-managed promotion, found {matches}")
print(f"promotion_pr={matches[0]}")
PY
then
  fail "current master is not bound to one merged CLI-managed dev promotion"
fi

REPO="$REPO" EXCLUDE_RUN_ID="$RUN_ID" "$PRODUCTION_RUN_EXCLUSIVITY" ||
  fail "another actionable production-capable workflow is active"

pending_json="$(read_pending)"
environment_id="$(
  python3 - "$pending_json" "$EXPECTED_ENVIRONMENT" <<'PY'
import json
import sys

pending = json.loads(sys.argv[1])
expected = sys.argv[2]
if len(pending) != 1:
    raise SystemExit(f"expected one pending environment, found {len(pending)}")
entry = pending[0]
environment = entry.get("environment") or {}
if environment.get("name") != expected:
    raise SystemExit(
        f"expected environment {expected}, found {environment.get('name')}"
    )
if entry.get("current_user_can_approve") is not True:
    raise SystemExit("current user cannot approve the environment")
environment_id = environment.get("id")
if not isinstance(environment_id, int) or environment_id <= 0:
    raise SystemExit("pending environment ID is invalid")
print(environment_id)
PY
)" || fail "pending environment validation failed"

[[ "$(read_master_sha)" == "$EXPECTED_SHA" ]] ||
  fail "master changed while approval gates were running"
latest_run_json="$(read_run)"
validate_run "$latest_run_json" || fail "run changed while approval gates were running"
latest_pending_json="$(read_pending)"
[[ "$latest_pending_json" == "$pending_json" ]] ||
  fail "pending environment changed while approval gates were running"

echo "safe_to_approve=yes"
echo "run_id=$RUN_ID"
echo "sha=$EXPECTED_SHA"
echo "workflow=$EXPECTED_WORKFLOW"
echo "environment=$EXPECTED_ENVIRONMENT"

if [[ "$ACTION" == "--approve" ]]; then
  gh api --method POST \
    "repos/$REPO/actions/runs/$RUN_ID/pending_deployments" \
    -F "environment_ids[]=$environment_id" \
    -f state=approved \
    -f comment="Copilot CLI automatic approval after exact-SHA safety gates passed." \
    >/dev/null
  echo "approved=yes"
else
  echo "approved=no"
fi
