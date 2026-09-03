#!/usr/bin/env bash
set -euo pipefail

# Purpose: fail-closed validation and approval of one exact protected gate.
# Direct workflow_dispatch authority comes only from copilot-cli-dispatch-stan.sh.
# Usage:
#   EXPECTED_OPERATION=<policy-operation> ./copilot-cli-run-approval-stan.sh <run-id>
#   COPILOT_CLI_AUTO_APPROVE=true EXPECTED_OPERATION=<policy-operation> \
#     ./copilot-cli-run-approval-stan.sh <run-id> --approve

umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POLICY_SCRIPT="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
AUTHORITY_HELPER="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"
RUN_EXCLUSIVITY_SCRIPT="$ROOT_DIR/infra/azure/agents/production-run-exclusivity-stan.sh"
AUTHORITY_DIR="${COPILOT_CLI_AUTHORITY_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/betstan/copilot-cli-authority}"
MANAGED_LABEL="copilot-cli-managed"

RUN_ID="${1:-}"
ACTION="${2:-}"
EXPECTED_OPERATION="${EXPECTED_OPERATION:-}"
EXPECTED_CONTROL_SHA="${EXPECTED_CONTROL_SHA:-}"
EXPECTED_SUBJECT_SHA="${EXPECTED_SUBJECT_SHA:-}"
EXPECTED_TARGET_SHA="${EXPECTED_TARGET_SHA:-}"
EXPECTED_UPSTREAM_RUN_ID="${EXPECTED_UPSTREAM_RUN_ID:-}"

fail() {
  echo "$*" >&2
  exit 1
}

[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]] || fail "run ID must be a positive integer"
[[ -n "$EXPECTED_OPERATION" ]] || fail "EXPECTED_OPERATION is required"
[[ -z "$ACTION" || "$ACTION" = "--approve" || "$ACTION" = "--reconcile" ]] ||
  fail "second argument must be --approve or --reconcile"
[[ -z "$EXPECTED_CONTROL_SHA" || "$EXPECTED_CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "EXPECTED_CONTROL_SHA must be empty or a full lowercase SHA"
[[ -z "$EXPECTED_SUBJECT_SHA" || "$EXPECTED_SUBJECT_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "EXPECTED_SUBJECT_SHA must be empty or a full lowercase SHA"
[[ -z "$EXPECTED_TARGET_SHA" || "$EXPECTED_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "EXPECTED_TARGET_SHA must be empty or a full lowercase SHA"
[[ -z "$EXPECTED_UPSTREAM_RUN_ID" || "$EXPECTED_UPSTREAM_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "EXPECTED_UPSTREAM_RUN_ID must be empty or a positive integer"

for command in gh git jq python3; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done
[[ -x "$POLICY_SCRIPT" ]] || fail "protected-operation policy is unavailable"
[[ -x "$AUTHORITY_HELPER" ]] || fail "authority helper is unavailable"
[[ -x "$RUN_EXCLUSIVITY_SCRIPT" ]] || fail "production exclusivity validator is unavailable"
"$AUTHORITY_HELPER" preflight-root \
  --authority-dir "$AUTHORITY_DIR" \
  --repo-root "$ROOT_DIR"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-cli-approval.XXXXXX")"
chmod 700 "$tmp_dir"
run_file="$tmp_dir/run.json"
pending_file="$tmp_dir/pending.json"
jobs_file="$tmp_dir/jobs.json"
approvals_file="$tmp_dir/approvals.json"
promotion_file="$tmp_dir/promotion.json"
upstream_run_file="$tmp_dir/upstream-run.json"
lock_token=""
authority_run_id=""

cleanup() {
  if [[ -n "$lock_token" && -n "$authority_run_id" ]]; then
    "$AUTHORITY_HELPER" release-lock \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$authority_run_id" \
      --token "$lock_token" \
      >/dev/null 2>&1 || true
  fi
  rm -f \
    "$run_file" \
    "$pending_file" \
    "$jobs_file" \
    "$approvals_file" \
    "$promotion_file" \
    "$upstream_run_file"
  rmdir "$tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT

repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "unable to resolve a safe GitHub repository name"
current_master="$(
  gh api "repos/$repository/git/ref/heads/master" --jq '.object.sha'
)"
[[ "$current_master" =~ ^[0-9a-f]{40}$ ]] ||
  fail "current master is not a complete lowercase SHA"
if [[ -n "$EXPECTED_CONTROL_SHA" && "$EXPECTED_CONTROL_SHA" != "$current_master" ]]; then
  fail "EXPECTED_CONTROL_SHA is stale"
fi

local_root="$(git -C "$ROOT_DIR" rev-parse --show-toplevel)"
[[ "$local_root" = "$ROOT_DIR" ]] || fail "script is not running from its repository root"
local_head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
[[ "$local_head" = "$current_master" ]] ||
  fail "approval must run from a checkout at exact current master"
[[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] ||
  fail "approval checkout is not clean"

policy_json="$("$POLICY_SCRIPT" get "$EXPECTED_OPERATION")"
expected_workflow="$(jq -r '.workflow' <<<"$policy_json")"
expected_event="$(jq -r '.event' <<<"$policy_json")"
expected_environment="$(jq -r '.environment' <<<"$policy_json")"
authority_mode="$(jq -r '.authority' <<<"$policy_json")"
expected_approval_workflow_state="$(
  jq -r '.approvalWorkflowState' <<<"$policy_json"
)"

workflow_metadata() {
  local workflow="$1"
  local metadata workflow_id workflow_path workflow_state blob local_blob
  metadata="$(gh api "repos/$repository/actions/workflows/$workflow")"
  workflow_id="$(jq -r '.id' <<<"$metadata")"
  workflow_path="$(jq -r '.path' <<<"$metadata")"
  workflow_state="$(jq -r '.state' <<<"$metadata")"
  [[ "$workflow_id" =~ ^[1-9][0-9]*$ ]] ||
    fail "trusted workflow ID is invalid for $workflow"
  [[ "$workflow_path" = ".github/workflows/$workflow" ]] ||
    fail "trusted workflow path mismatch for $workflow"
  [[ "$workflow_state" = "active" || "$workflow_state" = "disabled_manually" ]] ||
    fail "trusted workflow has an unsupported state: $workflow_state"
  blob="$(
    gh api \
      "repos/$repository/contents/.github/workflows/$workflow?ref=$current_master" \
      --jq '.sha'
  )"
  [[ "$blob" =~ ^[0-9a-f]{40}$ ]] ||
    fail "trusted workflow blob is invalid for $workflow"
  local_blob="$(
    git -C "$ROOT_DIR" rev-parse "$current_master:.github/workflows/$workflow"
  )"
  [[ "$local_blob" = "$blob" ]] ||
    fail "local and GitHub workflow blobs differ for $workflow"
  printf '%s\t%s\t%s\n' "$workflow_id" "$blob" "$workflow_state"
}

validate_promotion() {
  gh api "repos/$repository/commits/$current_master/pulls" \
    -H "Accept: application/vnd.github+json" >"$promotion_file"
  python3 - "$promotion_file" "$current_master" "$MANAGED_LABEL" <<'PY'
import json
import sys

path, sha, managed_label = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    pulls = json.load(handle)
valid = [
    pull
    for pull in pulls
    if pull.get("merged_at")
    and (pull.get("base") or {}).get("ref") == "master"
    and (pull.get("head") or {}).get("ref") == "dev"
    and pull.get("merge_commit_sha") == sha
    and any(
        label.get("name") == managed_label
        for label in pull.get("labels", [])
    )
]
if len(valid) != 1:
    raise SystemExit(
        "current master is not bound to exactly one CLI-managed dev promotion"
    )
PY
}

render_automatic_title() {
  local template="$1"
  python3 - "$template" "$current_master" "$EXPECTED_UPSTREAM_RUN_ID" <<'PY'
import re
import sys

template, control_sha, upstream_run_id = sys.argv[1:]
value = template.replace("{control_sha}", control_sha)
value = value.replace("{upstream_run_id}", upstream_run_id)
if re.search(r"\{[^{}]+\}", value):
    raise SystemExit("automatic title template has unresolved fields")
print(value)
PY
}

validate_record_sha_relations() {
  local summary="$1"
  local record_policy="$2"
  local relation sha label
  for label in subject target; do
    if [[ "$label" = "subject" ]]; then
      relation="$(jq -r '.subjectRelation' <<<"$record_policy")"
      sha="$(jq -r '.subjectSha // ""' <<<"$summary")"
    else
      relation="$(jq -r '.targetRelation' <<<"$record_policy")"
      sha="$(jq -r '.targetSha // ""' <<<"$summary")"
    fi
    case "$relation" in
      none)
        [[ -z "$sha" ]] || fail "authority record has an unexpected $label SHA"
        ;;
      current)
        [[ "$sha" = "$current_master" ]] ||
          fail "authority record $label SHA is not current master"
        ;;
      ancestor|ancestor-or-current)
        [[ "$sha" =~ ^[0-9a-f]{40}$ ]] ||
          fail "authority record $label SHA is missing"
        git -C "$ROOT_DIR" cat-file -e "${sha}^{commit}" 2>/dev/null ||
          fail "authority record $label SHA is unavailable locally"
        git -C "$ROOT_DIR" merge-base --is-ancestor "$sha" "$current_master" ||
          fail "authority record $label SHA is not an ancestor of current master"
        if [[ "$relation" = "ancestor" && "$sha" = "$current_master" ]]; then
          fail "authority record $label SHA must be historical"
        fi
        ;;
      *)
        fail "authority record has an unsupported $label relation"
        ;;
    esac
  done
}

validate_run_file() {
  local file="$1"
  local run_id="$2"
  local workflow_id="$3"
  local workflow="$4"
  local event="$5"
  local control_sha="$6"
  local display_title="$7"
  local required_status="$8"
  local required_conclusion="$9"
  python3 - \
    "$file" \
    "$run_id" \
    "$workflow_id" \
    "$workflow" \
    "$event" \
    "$control_sha" \
    "$repository" \
    "$display_title" \
    "$required_status" \
    "$required_conclusion" <<'PY'
import json
import sys

(
    path,
    run_id,
    workflow_id,
    workflow,
    event,
    control_sha,
    repository,
    display_title,
    required_status,
    required_conclusion,
) = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    run = json.load(handle)
failures = []
checks = [
    (str(run.get("id", "")) == run_id, "run ID"),
    (str(run.get("workflow_id", "")) == workflow_id, "workflow ID"),
    (
        run.get("path") == f".github/workflows/{workflow}",
        "workflow path",
    ),
    (run.get("event") == event, "event"),
    (run.get("head_sha") == control_sha, "control SHA"),
    (run.get("head_branch") == "master", "head branch"),
    (
        (run.get("head_repository") or {}).get("full_name") == repository,
        "head repository",
    ),
    (int(run.get("run_attempt", 0)) == 1, "run attempt"),
]
if display_title != "__ANY__":
    checks.append((run.get("display_title") == display_title, "display title"))
if required_status == "approval":
    checks.append(
        (
            run.get("status")
            in {"queued", "in_progress", "waiting", "pending", "requested"},
            "approval status",
        )
    )
elif required_status == "completed":
    checks.append((run.get("status") == "completed", "completed status"))
elif required_status == "reconcile":
    status = run.get("status")
    checks.append(
        (
            status
            in {
                "queued",
                "in_progress",
                "waiting",
                "pending",
                "requested",
                "completed",
            },
            "reconciliation status",
        )
    )
    checks.append(
        (
            (
                status == "completed"
                and run.get("conclusion") not in {None, ""}
            )
            or (
                status != "completed"
                and run.get("conclusion") in {None, ""}
            ),
            "reconciliation conclusion",
        )
    )
if required_conclusion == "success":
    checks.append((run.get("conclusion") == "success", "successful conclusion"))
elif required_conclusion == "non-success":
    checks.append(
        (
            run.get("conclusion") not in {None, "", "success"},
            "non-success conclusion",
        )
    )
elif required_conclusion == "pending":
    checks.append((run.get("conclusion") in {None, ""}, "pending conclusion"))
for valid, label in checks:
    if not valid:
        failures.append(label)
if failures:
    raise SystemExit("workflow run mismatch: " + ", ".join(failures))
PY
}

revalidate_control() {
  local observed_master observed_blob observed_workflow_state
  observed_master="$(
    gh api "repos/$repository/git/ref/heads/master" --jq '.object.sha'
  )"
  [[ "$observed_master" = "$current_master" ]] ||
    fail "master changed during approval validation"
  observed_blob="$(
    gh api \
      "repos/$repository/contents/.github/workflows/$expected_workflow?ref=$current_master" \
      --jq '.sha'
  )"
  [[ "$observed_blob" = "$workflow_blob_sha" ]] ||
    fail "trusted workflow blob changed during approval validation"
  observed_workflow_state="$(
    gh api "repos/$repository/actions/workflows/$expected_workflow" \
      --jq '.state'
  )"
  [[ "$observed_workflow_state" = "$expected_approval_workflow_state" ]] ||
    fail "trusted workflow is not in its required approval state"
}

record_summary=""
record_version=""
record_state=""
expected_title="__ANY__"
workflow_id=""
workflow_blob_sha=""
workflow_state=""
upstream_workflow_id=""
upstream_workflow_blob_sha=""
upstream_workflow_state=""

require_record_state() {
  local label="$1"
  if [[ "$ACTION" = "--reconcile" ]]; then
    [[ "$record_state" = "inflight" ]] ||
      fail "$label has no inflight approval to reconcile"
  else
    [[ "$record_state" = "issued" || "$record_state" = "consumed" ]] ||
      fail "$label is not issued or safely consumed"
  fi
}

validate_authority_and_run() {
  local required_status="${1:-approval}"
  local required_conclusion="${2:-pending}"
  local metadata upstream_operation upstream_policy upstream_state
  local title_template upstream_workflow upstream_event upstream_conclusion
  local requires_consumed derived_allowed policy_allowed
  local upstream_title

  read -r workflow_id workflow_blob_sha workflow_state <<<"$(
    workflow_metadata "$expected_workflow"
  )"
  [[ "$workflow_state" = "$expected_approval_workflow_state" ]] ||
    fail "trusted workflow is not in its required approval state"
  revalidate_control
  validate_promotion

  case "$authority_mode" in
    dispatch-record)
      authority_run_id="$RUN_ID"
      record_summary="$(
        "$AUTHORITY_HELPER" verify \
          --authority-dir "$AUTHORITY_DIR" \
          --repo-root "$ROOT_DIR" \
          --run-id "$authority_run_id" \
          --policy-json "$policy_json" \
          --repository "$repository" \
          --current-master "$current_master" \
          --workflow-id "$workflow_id" \
          --workflow-blob-sha "$workflow_blob_sha"
      )"
      record_state="$(jq -r '.state' <<<"$record_summary")"
      require_record_state "authority record"
      record_version="$(jq -r '.version' <<<"$record_summary")"
      expected_title="$(jq -r '.displayTitle' <<<"$record_summary")"
      validate_record_sha_relations "$record_summary" "$policy_json"
      if [[ -n "$EXPECTED_SUBJECT_SHA" ]] &&
        [[ "$(jq -r '.subjectSha // ""' <<<"$record_summary")" != "$EXPECTED_SUBJECT_SHA" ]]; then
        fail "EXPECTED_SUBJECT_SHA does not match the authority record"
      fi
      if [[ -n "$EXPECTED_TARGET_SHA" ]] &&
        [[ "$(jq -r '.targetSha // ""' <<<"$record_summary")" != "$EXPECTED_TARGET_SHA" ]]; then
        fail "EXPECTED_TARGET_SHA does not match the authority record"
      fi
      ;;
    promotion)
      authority_run_id="$RUN_ID"
      [[ -n "$EXPECTED_CONTROL_SHA" ]] ||
        fail "EXPECTED_CONTROL_SHA is required for promotion authority"
      ;;
    promotion-upstream)
      authority_run_id="$RUN_ID"
      [[ -n "$EXPECTED_CONTROL_SHA" ]] ||
        fail "EXPECTED_CONTROL_SHA is required for promotion-upstream authority"
      [[ -n "$EXPECTED_UPSTREAM_RUN_ID" ]] ||
        fail "EXPECTED_UPSTREAM_RUN_ID is required for promotion-upstream authority"
      upstream_workflow="$(jq -r '.upstreamWorkflow' <<<"$policy_json")"
      upstream_event="$(jq -r '.upstreamEvent' <<<"$policy_json")"
      upstream_conclusion="$(jq -r '.upstreamConclusion' <<<"$policy_json")"
      read -r upstream_workflow_id upstream_workflow_blob_sha upstream_workflow_state <<<"$(
        workflow_metadata "$upstream_workflow"
      )"
      gh api \
        "repos/$repository/actions/runs/$EXPECTED_UPSTREAM_RUN_ID" \
        >"$upstream_run_file"
      validate_run_file \
        "$upstream_run_file" \
        "$EXPECTED_UPSTREAM_RUN_ID" \
        "$upstream_workflow_id" \
        "$upstream_workflow" \
        "$upstream_event" \
        "$current_master" \
        "__ANY__" \
        "completed" \
        "$upstream_conclusion"
      title_template="$(jq -r '.titleTemplate' <<<"$policy_json")"
      expected_title="$(render_automatic_title "$title_template")"
      ;;
    record-upstream)
      [[ -n "$EXPECTED_UPSTREAM_RUN_ID" ]] ||
        fail "EXPECTED_UPSTREAM_RUN_ID is required for record-upstream authority"
      authority_run_id="$EXPECTED_UPSTREAM_RUN_ID"
      upstream_operation="$(
        "$AUTHORITY_HELPER" operation \
          --authority-dir "$AUTHORITY_DIR" \
          --repo-root "$ROOT_DIR" \
          --run-id "$authority_run_id"
      )"
      policy_allowed="$(
        jq -r \
          --arg operation "$upstream_operation" \
          '.upstreamOperations | index($operation) != null' \
          <<<"$policy_json"
      )"
      [[ "$policy_allowed" = "true" ]] ||
        fail "upstream authority operation is not allowed by downstream policy"
      upstream_policy="$("$POLICY_SCRIPT" get "$upstream_operation")"
      derived_allowed="$(
        jq -r \
          --arg operation "$EXPECTED_OPERATION" \
          '.derivedOperations | index($operation) != null' \
          <<<"$upstream_policy"
      )"
      [[ "$derived_allowed" = "true" ]] ||
        fail "upstream authority record does not permit this derived operation"
      upstream_workflow="$(jq -r '.workflow' <<<"$upstream_policy")"
      [[ "$upstream_workflow" = "$(jq -r '.upstreamWorkflow' <<<"$policy_json")" ]] ||
        fail "upstream authority workflow mismatch"
      read -r upstream_workflow_id upstream_workflow_blob_sha upstream_workflow_state <<<"$(
        workflow_metadata "$upstream_workflow"
      )"
      record_summary="$(
        "$AUTHORITY_HELPER" verify \
          --authority-dir "$AUTHORITY_DIR" \
          --repo-root "$ROOT_DIR" \
          --run-id "$authority_run_id" \
          --policy-json "$upstream_policy" \
          --repository "$repository" \
          --current-master "$current_master" \
          --workflow-id "$upstream_workflow_id" \
          --workflow-blob-sha "$upstream_workflow_blob_sha"
      )"
      record_state="$(jq -r '.state' <<<"$record_summary")"
      requires_consumed="$(jq -r '.requiresConsumedUpstream' <<<"$policy_json")"
      if [[
        "$requires_consumed" = "true" &&
          "$record_state" != "consumed" &&
          ! ("$ACTION" = "--reconcile" && "$record_state" = "inflight")
      ]]; then
        fail "derived operation requires a consumed upstream authority receipt"
      fi
      require_record_state "upstream authority record"
      record_version="$(jq -r '.version' <<<"$record_summary")"
      validate_record_sha_relations "$record_summary" "$upstream_policy"
      upstream_title="$(jq -r '.displayTitle' <<<"$record_summary")"
      upstream_event="$(jq -r '.upstreamEvent' <<<"$policy_json")"
      upstream_conclusion="$(jq -r '.upstreamConclusion' <<<"$policy_json")"
      gh api \
        "repos/$repository/actions/runs/$EXPECTED_UPSTREAM_RUN_ID" \
        >"$upstream_run_file"
      validate_run_file \
        "$upstream_run_file" \
        "$EXPECTED_UPSTREAM_RUN_ID" \
        "$upstream_workflow_id" \
        "$upstream_workflow" \
        "$upstream_event" \
        "$current_master" \
        "$upstream_title" \
        "completed" \
        "$upstream_conclusion"
      title_template="$(jq -r '.titleTemplate' <<<"$policy_json")"
      expected_title="$(render_automatic_title "$title_template")"
      ;;
    *)
      fail "unsupported authority mode: $authority_mode"
      ;;
  esac

  gh api "repos/$repository/actions/runs/$RUN_ID" >"$run_file"
  validate_run_file \
    "$run_file" \
    "$RUN_ID" \
    "$workflow_id" \
    "$expected_workflow" \
    "$expected_event" \
    "$current_master" \
    "$expected_title" \
    "$required_status" \
    "$required_conclusion"
}

ensure_automatic_authority_record() {
  case "$authority_mode" in
    promotion|promotion-upstream)
      record_summary="$(
        "$AUTHORITY_HELPER" ensure-automatic-record \
          --authority-dir "$AUTHORITY_DIR" \
          --repo-root "$ROOT_DIR" \
          --run-id "$RUN_ID" \
          --run-json "$run_file" \
          --policy-json "$policy_json" \
          --repository "$repository" \
          --current-master "$current_master" \
          --workflow-id "$workflow_id" \
          --workflow-blob-sha "$workflow_blob_sha"
      )"
      record_state="$(jq -r '.state' <<<"$record_summary")"
      require_record_state "automatic authority record"
      record_version="$(jq -r '.version' <<<"$record_summary")"
      ;;
  esac
}

environment_id=""
gate_key=""
observe_pending_gate() {
  local observation
  gh api "repos/$repository/actions/runs/$RUN_ID/pending_deployments" >"$pending_file"
  gh api "repos/$repository/actions/runs/$RUN_ID/jobs?per_page=100" >"$jobs_file"
  observation="$(
    python3 - "$pending_file" "$jobs_file" "$expected_environment" <<'PY'
import hashlib
import json
import sys

pending_path, jobs_path, expected_environment = sys.argv[1:]
with open(pending_path, encoding="utf-8") as handle:
    pending = json.load(handle)
with open(jobs_path, encoding="utf-8") as handle:
    payload = json.load(handle)
if not isinstance(pending, list):
    raise SystemExit("pending deployment inventory is incomplete")
jobs = payload.get("jobs")
if (
    not isinstance(jobs, list)
    or payload.get("total_count") != len(jobs)
    or len(jobs) > 100
):
    raise SystemExit("protected job inventory is incomplete")
if not pending:
    print('{"environmentId":null,"gateKey":null}')
    raise SystemExit(0)
matches = [
    item
    for item in pending
    if isinstance(item, dict)
    and isinstance(item.get("environment"), dict)
    and item["environment"].get("name") == expected_environment
    and item.get("current_user_can_approve") is True
]
if len(pending) != 1 or len(matches) != 1:
    raise SystemExit("expected exactly one approvable pending environment")
environment_id = matches[0]["environment"].get("id")
if not isinstance(environment_id, int) or environment_id < 1:
    raise SystemExit("pending environment ID is invalid")
waiting_ids = sorted(
    job.get("id")
    for job in jobs
    if isinstance(job, dict)
    and job.get("status") == "waiting"
    and isinstance(job.get("id"), int)
)
if not waiting_ids:
    raise SystemExit("protected run has no waiting materialized job")
canonical = json.dumps(
    {
        "environmentId": int(environment_id),
        "jobIds": waiting_ids,
    },
    sort_keys=True,
    separators=(",", ":"),
).encode("utf-8")
print(json.dumps({
    "environmentId": environment_id,
    "gateKey": hashlib.sha256(canonical).hexdigest(),
}, sort_keys=True, separators=(",", ":")))
PY
  )"
  environment_id="$(jq -r '.environmentId // ""' <<<"$observation")"
  gate_key="$(jq -r '.gateKey // ""' <<<"$observation")"
  if [[ -n "$environment_id" ]]; then
    [[ "$environment_id" =~ ^[1-9][0-9]*$ ]] ||
      fail "pending environment ID is invalid"
    [[ "$gate_key" =~ ^[0-9a-f]{64}$ ]] ||
      fail "protected gate fingerprint is invalid"
    current_user="$(gh api user --jq '.login')"
    [[ -n "$current_user" ]] || fail "unable to resolve current GitHub user"
  fi
}

validate_pending_gate() {
  observe_pending_gate
  [[ -n "$environment_id" ]] ||
    fail "expected exactly one approvable pending environment"
}

guard_missing_pending_against_waiting_gate() {
  local observed_approval_count="$1"
  local inflight_environment_id inflight_gate_key observed_waiting_gate
  local approval_count_before
  [[ -z "$environment_id" ]] || return 0
  approval_count_before="$(
    jq -r '.inflightApproval.approvalCountBefore // -1' <<<"$record_summary"
  )"
  [[ "$approval_count_before" =~ ^[0-9]+$ ]] ||
    fail "inflight approval history baseline is unavailable"
  if ((observed_approval_count > approval_count_before)); then
    return 0
  fi
  inflight_environment_id="$(
    jq -r '.inflightApproval.environmentId // ""' <<<"$record_summary"
  )"
  inflight_gate_key="$(
    jq -r '.inflightApproval.gateKey // ""' <<<"$record_summary"
  )"
  [[ "$inflight_environment_id" =~ ^[1-9][0-9]*$ ]] ||
    fail "inflight approval environment ID is unavailable"
  [[ "$inflight_gate_key" =~ ^[0-9a-f]{64}$ ]] ||
    fail "inflight approval gate key is unavailable"
  observed_waiting_gate="$(
    python3 - "$jobs_file" "$inflight_environment_id" <<'PY'
import hashlib
import json
import sys

path, environment_id = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    payload = json.load(handle)
waiting_ids = sorted(
    job.get("id")
    for job in payload.get("jobs", [])
    if isinstance(job, dict)
    and job.get("status") == "waiting"
    and isinstance(job.get("id"), int)
)
if waiting_ids:
    canonical = json.dumps(
        {
            "environmentId": int(environment_id),
            "jobIds": waiting_ids,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    print(hashlib.sha256(canonical).hexdigest())
PY
  )"
  if [[ "$observed_waiting_gate" = "$inflight_gate_key" ]]; then
    fail "inflight gate still has the same waiting job without a pending deployment; retry reconciliation"
  fi
}

matching_approval_count() {
  local approval_environment_id="$1"
  local approval_reviewer="$2"
  local approval_comment="$3"
  gh api "repos/$repository/actions/runs/$RUN_ID/approvals" >"$approvals_file"
  chmod 600 "$approvals_file"
  python3 - \
    "$approvals_file" \
    "$approval_environment_id" \
    "$approval_reviewer" \
    "$approval_comment" <<'PY'
import json
import sys

path, environment_id, reviewer, comment = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    reviews = json.load(handle)
if not isinstance(reviews, list):
    raise SystemExit("workflow approval history is incomplete")
count = 0
for review in reviews:
    if not isinstance(review, dict):
        raise SystemExit("workflow approval history contains an invalid review")
    environments = review.get("environments")
    user = review.get("user")
    if not isinstance(environments, list) or not isinstance(user, dict):
        raise SystemExit("workflow approval history contains an incomplete review")
    if (
        review.get("state") == "approved"
        and review.get("comment") == comment
        and user.get("login") == reviewer
        and any(
            isinstance(environment, dict)
            and str(environment.get("id")) == environment_id
            for environment in environments
        )
    ):
        count += 1
print(count)
PY
}

validate_exclusivity() {
  REPO="$repository" EXCLUDE_RUN_ID="$RUN_ID" PROSPECTIVE_PROMOTION_PR="" \
    "$RUN_EXCLUSIVITY_SCRIPT"
}

if [[ "$ACTION" = "--reconcile" ]]; then
  validate_authority_and_run "reconcile" "__ANY__"
  ensure_automatic_authority_record
  observe_pending_gate
  validate_exclusivity
  printf 'run=%s operation=%s workflow=%s environment=%s control_sha=%s authority=%s status=RECONCILABLE\n' \
    "$RUN_ID" \
    "$EXPECTED_OPERATION" \
    "$expected_workflow" \
    "$expected_environment" \
    "$current_master" \
    "$authority_mode"
  [[ "${COPILOT_CLI_AUTO_APPROVE:-}" = "true" ]] ||
    fail "set COPILOT_CLI_AUTO_APPROVE=true to reconcile approval authority"
  lock_token="$(
    "$AUTHORITY_HELPER" acquire-lock \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$authority_run_id" \
      --owner-pid "$$"
  )"
  validate_authority_and_run "reconcile" "__ANY__"
  ensure_automatic_authority_record
  observe_pending_gate
  inflight_run_id="$(
    jq -r '.inflightApproval.runId // ""' <<<"$record_summary"
  )"
  inflight_operation="$(
    jq -r '.inflightApproval.operation // ""' <<<"$record_summary"
  )"
  inflight_environment_id="$(
    jq -r '.inflightApproval.environmentId // ""' <<<"$record_summary"
  )"
  inflight_reviewer="$(
    jq -r '.inflightApproval.reviewer // ""' <<<"$record_summary"
  )"
  inflight_comment="$(
    jq -r '.inflightApproval.approvalComment // ""' <<<"$record_summary"
  )"
  [[ "$inflight_run_id" = "$RUN_ID" ]] ||
    fail "inflight approval run ID does not match the reconciliation target"
  [[ "$inflight_operation" = "$EXPECTED_OPERATION" ]] ||
    fail "inflight approval operation does not match the reconciliation target"
  [[ "$inflight_environment_id" =~ ^[1-9][0-9]*$ ]] ||
    fail "inflight approval environment ID is unavailable"
  [[ -n "$inflight_reviewer" && -n "$inflight_comment" ]] ||
    fail "inflight approval history identity is unavailable"
  current_user="$(gh api user --jq '.login')"
  [[ "$current_user" = "$inflight_reviewer" ]] ||
    fail "current GitHub user does not match the inflight approval reviewer"
  observed_approval_count="$(
    matching_approval_count \
      "$inflight_environment_id" \
      "$inflight_reviewer" \
      "$inflight_comment"
  )"
  [[ "$observed_approval_count" =~ ^[0-9]+$ ]] ||
    fail "workflow approval history count is invalid"
  guard_missing_pending_against_waiting_gate "$observed_approval_count"
  validate_exclusivity
  revalidate_control
  validate_promotion
  run_status="$(jq -r '.status // ""' "$run_file")"
  reconciliation="$(
    "$AUTHORITY_HELPER" reconcile-approval \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$authority_run_id" \
      --token "$lock_token" \
      --expected-version "$record_version" \
      --approval-run-id "$RUN_ID" \
      --approval-operation "$EXPECTED_OPERATION" \
      --pending-environment-id "${environment_id:-0}" \
      --pending-gate-key "${gate_key:-none}" \
      --observed-approval-count "$observed_approval_count" \
      --run-status "$run_status"
  )"
  "$AUTHORITY_HELPER" release-lock \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" \
    --run-id "$authority_run_id" \
    --token "$lock_token"
  lock_token=""
  if [[ "$reconciliation" = "retry" ]]; then
    printf 'run=%s operation=%s environment=%s status=RETRY_READY\n' \
      "$RUN_ID" "$EXPECTED_OPERATION" "$expected_environment"
  elif [[ "$reconciliation" = "consumed" ]]; then
    printf 'run=%s operation=%s environment=%s status=RECONCILED_CONSUMED\n' \
      "$RUN_ID" "$EXPECTED_OPERATION" "$expected_environment"
  elif [[ "$reconciliation" = "unresolved" ]]; then
    fail "approval reconciliation remains unresolved; authority stays inflight"
  else
    fail "approval reconciliation returned an unsupported outcome"
  fi
  exit 0
fi

validate_authority_and_run
ensure_automatic_authority_record
validate_pending_gate
validate_exclusivity

printf 'run=%s operation=%s workflow=%s environment=%s control_sha=%s authority=%s status=ELIGIBLE\n' \
  "$RUN_ID" \
  "$EXPECTED_OPERATION" \
  "$expected_workflow" \
  "$expected_environment" \
  "$current_master" \
  "$authority_mode"

[[ "$ACTION" = "--approve" ]] || exit 0
[[ "${COPILOT_CLI_AUTO_APPROVE:-}" = "true" ]] ||
  fail "set COPILOT_CLI_AUTO_APPROVE=true to submit approval"

lock_token="$(
  "$AUTHORITY_HELPER" acquire-lock \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" \
    --run-id "$authority_run_id" \
    --owner-pid "$$"
)"

validate_authority_and_run
ensure_automatic_authority_record
validate_pending_gate
validate_exclusivity
revalidate_control
validate_promotion
approval_comment="Copilot CLI exact-run approval: $EXPECTED_OPERATION"
approval_count_before="$(
  matching_approval_count \
    "$environment_id" \
    "$current_user" \
    "$approval_comment"
)"
[[ "$approval_count_before" =~ ^[0-9]+$ ]] ||
  fail "workflow approval history baseline is invalid"

claimed_version="$(
  "$AUTHORITY_HELPER" claim-approval \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" \
    --run-id "$authority_run_id" \
    --token "$lock_token" \
    --expected-version "$record_version" \
    --approval-run-id "$RUN_ID" \
    --approval-operation "$EXPECTED_OPERATION" \
    --environment-id "$environment_id" \
    --gate-key "$gate_key" \
    --reviewer "$current_user" \
    --approval-comment "$approval_comment" \
    --approval-count-before "$approval_count_before"
)"

if ! approval_revalidation_error="$(
  {
    revalidate_control
    validate_promotion
  } 2>&1
)"; then
  "$AUTHORITY_HELPER" release-approval \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" \
    --run-id "$authority_run_id" \
    --token "$lock_token" \
    --approval-run-id "$RUN_ID" \
    --approval-operation "$EXPECTED_OPERATION" \
    --environment-id "$environment_id" \
    --gate-key "$gate_key"
  fail "$approval_revalidation_error"
fi

if ! gh api \
  --method POST \
  "repos/$repository/actions/runs/$RUN_ID/pending_deployments" \
  -F "environment_ids[]=$environment_id" \
  -f state=approved \
  -f "comment=$approval_comment" \
  >/dev/null; then
  fail "GitHub approval result is ambiguous; authority remains inflight and must not be replayed"
fi

"$AUTHORITY_HELPER" complete-approval \
  --authority-dir "$AUTHORITY_DIR" \
  --repo-root "$ROOT_DIR" \
  --run-id "$authority_run_id" \
  --token "$lock_token" \
  --expected-version "$claimed_version" \
  --approval-run-id "$RUN_ID" \
  --approval-operation "$EXPECTED_OPERATION" \
  --environment-id "$environment_id" \
  --gate-key "$gate_key"

"$AUTHORITY_HELPER" release-lock \
  --authority-dir "$AUTHORITY_DIR" \
  --repo-root "$ROOT_DIR" \
  --run-id "$authority_run_id" \
  --token "$lock_token"
lock_token=""

printf 'run=%s operation=%s environment=%s status=APPROVED\n' \
  "$RUN_ID" "$EXPECTED_OPERATION" "$expected_environment"
