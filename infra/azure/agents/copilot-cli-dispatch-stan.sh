#!/usr/bin/env bash
set -euo pipefail

# Purpose: dispatch one policy-defined protected operation and bind the exact
#          returned run ID to a private Copilot CLI authority record.
# Usage:
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json --dispatch
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json --resume-captured
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json --resume-run 123
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json --prepare-disabled-ghosts
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json --dispatch-prepared
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json --discard-prepared

umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POLICY_SCRIPT="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
AUTHORITY_HELPER="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"
RUN_EXCLUSIVITY_SCRIPT="$ROOT_DIR/infra/azure/agents/production-run-exclusivity-stan.sh"
UPSTREAM_BINDING_VALIDATOR="$ROOT_DIR/infra/oci/scripts/upstream_run_binding_stan.py"
AUTHORITY_DIR="${COPILOT_CLI_AUTHORITY_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/betstan/copilot-cli-authority}"
MATERIALIZATION_ATTEMPTS="${COPILOT_CLI_MATERIALIZATION_ATTEMPTS:-12}"
MATERIALIZATION_SLEEP_SECONDS="${COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS:-5}"
# Frozen prepared disabled-workflow transition targets. Separate from the
# broader protected-operation policy inventory; the dispatcher passes only
# the already policy-resolved workflow into this allowlist, and the same
# frozen set is enforced independently by production-run-exclusivity-stan.sh
# and copilot_cli_authority_stan.py. Adding an entry here is a distinct,
# separately reviewed safety-policy change. A plain case statement (rather
# than an associative array) keeps this portable to bash 3.2.
is_disabled_transition_workflow() {
  case "$1" in
    oci-live-data-rollout.yml|oci-live-betting-activate.yml)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

REQUEST_FILE="${1:-}"
ACTION="${2:-}"
RESUME_RUN_ID="${3:-}"

fail() {
  echo "$*" >&2
  exit 1
}

usage() {
  fail "usage: $0 /absolute/path/request.json [--dispatch | --resume-captured | --resume-run <run-id> | --prepare-disabled-ghosts | --dispatch-prepared | --discard-prepared]"
}

[[ -n "$REQUEST_FILE" ]] || usage
case "$ACTION" in
  "")
    ;;
  --dispatch)
    [[ -z "$RESUME_RUN_ID" ]] || usage
    ;;
  --prepare-disabled-ghosts|--dispatch-prepared|--discard-prepared)
    [[ "$#" = 2 ]] || usage
    ;;
  --resume-captured)
    [[ -z "$RESUME_RUN_ID" ]] || usage
    ;;
  --resume-run)
    [[ "$RESUME_RUN_ID" =~ ^[1-9][0-9]*$ ]] || usage
    ;;
  *)
    usage
    ;;
esac
[[ "$MATERIALIZATION_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] ||
  fail "COPILOT_CLI_MATERIALIZATION_ATTEMPTS must be a positive integer"
[[ "$MATERIALIZATION_SLEEP_SECONDS" =~ ^[0-9]+$ ]] ||
  fail "COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS must be a non-negative integer"
((MATERIALIZATION_ATTEMPTS <= 60)) ||
  fail "COPILOT_CLI_MATERIALIZATION_ATTEMPTS must not exceed 60"
((MATERIALIZATION_ATTEMPTS >= 2)) ||
  fail "COPILOT_CLI_MATERIALIZATION_ATTEMPTS must be at least 2"
((MATERIALIZATION_SLEEP_SECONDS <= 30)) ||
  fail "COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS must not exceed 30"

for command in gh git jq python3; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done
[[ -x "$POLICY_SCRIPT" ]] || fail "protected-operation policy is unavailable"
[[ -x "$AUTHORITY_HELPER" ]] || fail "authority helper is unavailable"
[[ -x "$RUN_EXCLUSIVITY_SCRIPT" ]] || fail "production exclusivity validator is unavailable"
[[ "$REQUEST_FILE" = /* ]] || fail "request file path must be absolute"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-cli-dispatch.XXXXXX")"
chmod 700 "$tmp_dir"
normalized_file="$tmp_dir/normalized.json"
inputs_file="$tmp_dir/inputs.json"
run_file="$tmp_dir/run.json"
jobs_file="$tmp_dir/jobs.json"
pending_file="$tmp_dir/pending.json"
pre_rejection_run_file="$tmp_dir/pre-rejection-run.json"
pre_rejection_jobs_file="$tmp_dir/pre-rejection-jobs.json"
pre_rejection_pending_file="$tmp_dir/pre-rejection-pending.json"
pre_rejection_approvals_file="$tmp_dir/pre-rejection-approvals.json"
terminal_rejection_run_file="$tmp_dir/terminal-rejection-run.json"
terminal_rejection_jobs_file="$tmp_dir/terminal-rejection-jobs.json"
terminal_rejection_pending_file="$tmp_dir/terminal-rejection-pending.json"
terminal_rejection_approvals_file="$tmp_dir/terminal-rejection-approvals.json"
materialization_error="$tmp_dir/materialization.err"
prerequisite_error_file="$tmp_dir/prerequisite.err"
promotion_file="$tmp_dir/promotion.json"
observation_file="$tmp_dir/transition-observation.json"
authority_lock_run_id=""
authority_lock_token=""
cleanup() {
  if [[ -n "$authority_lock_token" && -n "$authority_lock_run_id" ]]; then
    "$AUTHORITY_HELPER" release-lock \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$authority_lock_run_id" \
      --token "$authority_lock_token" \
      >/dev/null 2>&1 || true
    authority_lock_run_id=""
    authority_lock_token=""
  fi
  rm -f \
    "$normalized_file" \
    "$inputs_file" \
    "$run_file" \
    "$jobs_file" \
    "$pending_file" \
    "$pre_rejection_run_file" \
    "$pre_rejection_jobs_file" \
    "$pre_rejection_pending_file" \
    "$pre_rejection_approvals_file" \
    "$terminal_rejection_run_file" \
    "$terminal_rejection_jobs_file" \
    "$terminal_rejection_pending_file" \
    "$terminal_rejection_approvals_file" \
    "$materialization_error" \
    "$prerequisite_error_file" \
    "$promotion_file" \
    "$observation_file"
  rmdir "$tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT

repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "unable to resolve a safe GitHub repository name"
live_master="$(
  gh api "repos/$repository/git/ref/heads/master" --jq '.object.sha'
)"
[[ "$live_master" =~ ^[0-9a-f]{40}$ ]] ||
  fail "current master is not a complete lowercase SHA"
current_master="$live_master"

local_root="$(git -C "$ROOT_DIR" rev-parse --show-toplevel)"
[[ "$local_root" = "$ROOT_DIR" ]] || fail "script is not running from its repository root"
local_head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
[[ "$local_head" = "$live_master" ]] ||
  fail "dispatch must run from a checkout at exact current master"
[[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] ||
  fail "dispatch checkout is not clean"

operation="$(
  "$AUTHORITY_HELPER" request-operation \
    --request "$REQUEST_FILE" \
    --repo-root "$ROOT_DIR"
)"
cross_master_rejection=false
rejection_context=""
rejection_state=""
if [[ "$ACTION" = "--resume-run" ]] &&
  [[ -e "$AUTHORITY_DIR/$RESUME_RUN_ID.json" ||
    -L "$AUTHORITY_DIR/$RESUME_RUN_ID.json" ]]; then
  rejection_context="$(
    "$AUTHORITY_HELPER" read-resume-context \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$RESUME_RUN_ID" \
      --request "$REQUEST_FILE"
  )"
  current_master="$(jq -r '.controlSha' <<<"$rejection_context")"
  rejection_state="$(jq -r '.state' <<<"$rejection_context")"
  if [[ "$current_master" != "$live_master" ]]; then
    if [[ "$rejection_state" != "rejecting" &&
      "$rejection_state" != "retired" ]] ||
      [[ "$(jq -r '.prerequisiteRejection' <<<"$rejection_context")" != true ]]; then
      fail "only a persisted prerequisite rejection can resume across master advancement"
    fi
    cross_master_rejection=true
  fi
fi

if [[ "$cross_master_rejection" = true ]]; then
  workflow="$(jq -r '.workflow' <<<"$rejection_context")"
  environment="$(jq -r '.environment' <<<"$rejection_context")"
  workflow_id="$(jq -r '.workflowId' <<<"$rejection_context")"
  workflow_blob_sha="$(jq -r '.workflowBlobSha' <<<"$rejection_context")"
  subject_sha="$(jq -r '.subjectSha // ""' <<<"$rejection_context")"
  target_sha="$(jq -r '.targetSha // ""' <<<"$rejection_context")"
  input_hash="$(jq -r '.inputHash' <<<"$rejection_context")"
  policy_json=""

  [[ "$workflow" =~ ^[A-Za-z0-9_.-]+\.yml$ ]] ||
    fail "recorded workflow name is invalid"
  [[ "$workflow_id" =~ ^[1-9][0-9]*$ ]] ||
    fail "recorded workflow ID is invalid"
  [[ "$workflow_blob_sha" =~ ^[0-9a-f]{40}$ ]] ||
    fail "recorded workflow blob SHA is invalid"
  [[ "$current_master" =~ ^[0-9a-f]{40}$ ]] ||
    fail "recorded control SHA is invalid"
  if ! git -C "$ROOT_DIR" cat-file -e "${current_master}^{commit}" 2>/dev/null; then
    git -C "$ROOT_DIR" fetch --quiet origin "$current_master" ||
      fail "unable to fetch recorded control SHA"
  fi
  git -C "$ROOT_DIR" merge-base --is-ancestor "$current_master" "$live_master" ||
    fail "recorded rejecting control SHA is not an ancestor of current master"
  local_workflow_blob="$(
    git -C "$ROOT_DIR" rev-parse \
      "$current_master:.github/workflows/$workflow"
  )"
  [[ "$local_workflow_blob" = "$workflow_blob_sha" ]] ||
    fail "recorded workflow blob differs from the historical control commit"
  historical_workflow_blob="$(
    gh api \
      "repos/$repository/contents/.github/workflows/$workflow?ref=$current_master" \
      --jq '.sha'
  )"
  [[ "$historical_workflow_blob" = "$workflow_blob_sha" ]] ||
    fail "GitHub no longer confirms the recorded workflow blob"
else
  policy_json="$("$POLICY_SCRIPT" get "$operation")"
  workflow="$(jq -r '.workflow' <<<"$policy_json")"
  environment="$(jq -r '.environment' <<<"$policy_json")"
  authority_mode="$(jq -r '.authority' <<<"$policy_json")"
  [[ "$authority_mode" = "dispatch-record" ]] ||
    fail "operation is automatic and cannot be manually dispatched"
  case "$ACTION" in
    --prepare-disabled-ghosts|--dispatch-prepared|--discard-prepared)
      is_disabled_transition_workflow "$workflow" ||
        fail "prepared lifecycle is restricted to the frozen policy-resolved disabled-transition workflows"
      ;;
  esac

  read -r workflow_id workflow_path workflow_state <<<"$(
    gh api "repos/$repository/actions/workflows/$workflow" \
      --jq '[.id,.path,.state] | @tsv'
  )"
  [[ "$workflow_id" =~ ^[1-9][0-9]*$ ]] ||
    fail "trusted workflow ID is invalid"
  [[ "$workflow_path" = ".github/workflows/$workflow" ]] ||
    fail "trusted workflow path does not match policy"
  [[ "$workflow_state" = "active" || "$workflow_state" = "disabled_manually" ]] ||
    fail "trusted workflow has an unsupported state: $workflow_state"

  if [[ "$ACTION" = "--discard-prepared" ]]; then
    # Cleanup needs actual-current-master cleanliness, not the old prepared
    # control's promotion/prerequisites or unexpired release authority.
    discard_snapshot="$(
      "$AUTHORITY_HELPER" prepared-context \
        --request "$REQUEST_FILE" --repository "$repository" \
        --workflow-id "$workflow_id" --workflow-path "$workflow_path" \
        --authority-dir "$AUTHORITY_DIR" --repo-root "$ROOT_DIR"
    )"
    [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$live_master" &&
      -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] ||
      fail "discard checkout changed or is not clean"
    [[ "$(gh api "repos/$repository/git/ref/heads/master" --jq '.object.sha')" = "$live_master" ]] ||
      fail "master changed before prepared discard"
    observed_workflow="$(
      gh api "repos/$repository/actions/workflows/$workflow" \
        --jq '[.id,.path,.state] | @tsv'
    )"
    [[ "$observed_workflow" = "$(printf '%s\t%s\tdisabled_manually' "$workflow_id" "$workflow_path")" ]] ||
      fail "discard requires the exact freshly disabled workflow"
    "$AUTHORITY_HELPER" discard-prepared \
      --request "$REQUEST_FILE" --repository "$repository" \
      --workflow-id "$workflow_id" --workflow-path "$workflow_path" \
      --expected-snapshot "$discard_snapshot" \
      --authority-dir "$AUTHORITY_DIR" --repo-root "$ROOT_DIR"
    exit 0
  fi

  workflow_blob_sha="$(
    gh api \
      "repos/$repository/contents/.github/workflows/$workflow?ref=$current_master" \
      --jq '.sha'
  )"
  [[ "$workflow_blob_sha" =~ ^[0-9a-f]{40}$ ]] ||
    fail "trusted workflow blob SHA is invalid"
  local_workflow_blob="$(
    git -C "$ROOT_DIR" rev-parse \
      "$current_master:.github/workflows/$workflow"
  )"
  [[ "$local_workflow_blob" = "$workflow_blob_sha" ]] ||
    fail "local and GitHub trusted workflow blobs differ"

  "$AUTHORITY_HELPER" validate-request \
    --request "$REQUEST_FILE" \
    --policy-json "$policy_json" \
    --repository "$repository" \
    --current-master "$current_master" \
    --repo-root "$ROOT_DIR" \
    --output "$normalized_file"
  "$AUTHORITY_HELPER" write-inputs \
    --normalized "$normalized_file" \
    --output "$inputs_file" \
    --repo-root "$ROOT_DIR"
fi

validate_ancestor_relation() {
  local relation="$1"
  local sha="$2"
  local label="$3"
  case "$relation" in
    none|current)
      return
      ;;
    ancestor|ancestor-or-current)
      [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "$label SHA is missing"
      if ! git -C "$ROOT_DIR" cat-file -e "${sha}^{commit}" 2>/dev/null; then
        git -C "$ROOT_DIR" fetch --quiet origin "$sha" ||
          fail "unable to fetch $label SHA"
      fi
      git -C "$ROOT_DIR" merge-base --is-ancestor "$sha" "$current_master" ||
        fail "$label SHA is not an ancestor of current master"
      if [[ "$relation" = "ancestor" && "$sha" = "$current_master" ]]; then
        fail "$label SHA must be historical"
      fi
      ;;
    *)
      fail "unsupported $label relation"
      ;;
  esac
}

if [[ "$cross_master_rejection" != true ]]; then
  subject_relation="$(jq -r '.subjectRelation' "$normalized_file")"
  target_relation="$(jq -r '.targetRelation' "$normalized_file")"
  subject_sha="$(jq -r '.subjectSha // ""' "$normalized_file")"
  target_sha="$(jq -r '.targetSha // ""' "$normalized_file")"
  input_hash="$(jq -r '.inputHash' "$normalized_file")"
  title_template="$(jq -r '.displayTitleTemplate' "$normalized_file")"
  validate_ancestor_relation "$subject_relation" "$subject_sha" "subject"
  validate_ancestor_relation "$target_relation" "$target_sha" "target"
fi

gh api "repos/$repository/commits/$current_master/pulls" \
  -H "Accept: application/vnd.github+json" >"$promotion_file"
python3 - "$promotion_file" "$current_master" <<'PY'
import json
import sys

path, sha = sys.argv[1:]
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
        label.get("name") == "copilot-cli-managed"
        for label in pull.get("labels", [])
    )
]
if len(valid) != 1:
    raise SystemExit(
        "current master is not bound to exactly one CLI-managed dev promotion"
    )
PY

revalidate_control() {
  local observed_master observed_blob
  observed_master="$(
    gh api "repos/$repository/git/ref/heads/master" --jq '.object.sha'
  )"
  [[ "$observed_master" = "$current_master" ]] ||
    fail "master changed during dispatch validation"
  observed_blob="$(
    gh api \
      "repos/$repository/contents/.github/workflows/$workflow?ref=$current_master" \
      --jq '.sha'
  )"
  [[ "$observed_blob" = "$workflow_blob_sha" ]] ||
    fail "trusted workflow blob changed during dispatch validation"
}

revalidate_dispatch_target() {
  local observed_workflow_state
  revalidate_control
  observed_workflow_state="$(
    gh api "repos/$repository/actions/workflows/$workflow" --jq '.state'
  )"
  [[ "$observed_workflow_state" = "active" ]] ||
    fail "trusted workflow must be active immediately before dispatch"
}

revalidate_rejection_continuation() {
  local observed_master observed_blob
  observed_master="$(
    gh api "repos/$repository/git/ref/heads/master" --jq '.object.sha'
  )"
  [[ "$observed_master" = "$live_master" ]] ||
    fail "master changed during prerequisite rejection continuation"
  git -C "$ROOT_DIR" merge-base --is-ancestor \
    "$current_master" "$observed_master" ||
    fail "rejecting authority control SHA is no longer an ancestor of master"
  observed_blob="$(
    gh api \
      "repos/$repository/contents/.github/workflows/$workflow?ref=$current_master" \
      --jq '.sha'
  )"
  [[ "$observed_blob" = "$workflow_blob_sha" ]] ||
    fail "recorded workflow blob changed during rejection continuation"
}

acquire_authority_lock() {
  local run_id="$1"
  [[ -z "$authority_lock_token" ]] ||
    fail "authority lock is already held for run $authority_lock_run_id"
  authority_lock_token="$(
    "$AUTHORITY_HELPER" acquire-lock \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$run_id" \
      --owner-pid "$$"
  )"
  [[ "$authority_lock_token" =~ ^[0-9a-f]{64}$ ]] ||
    fail "authority lock returned an invalid token"
  authority_lock_run_id="$run_id"
}

release_authority_lock() {
  [[ -n "$authority_lock_token" && -n "$authority_lock_run_id" ]] || return 0
  "$AUTHORITY_HELPER" release-lock \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" \
    --run-id "$authority_lock_run_id" \
    --token "$authority_lock_token" \
    >/dev/null
  authority_lock_run_id=""
  authority_lock_token=""
}

assert_resume_identity() {
  local summary="$1"
  [[ "$(jq -r '.inputHash' <<<"$summary")" = "$input_hash" ]] ||
    fail "resume request does not match the authority record input hash"
  [[ "$(jq -r '.subjectSha // ""' <<<"$summary")" = "$subject_sha" ]] ||
    fail "resume request does not match the authority record subject SHA"
  [[ "$(jq -r '.targetSha // ""' <<<"$summary")" = "$target_sha" ]] ||
    fail "resume request does not match the authority record target SHA"
}

retire_terminal_claim() {
  local run_id="$1"
  gh api \
    "repos/$repository/actions/runs/$run_id/jobs?per_page=100" \
    >"$jobs_file"
  gh api \
    "repos/$repository/actions/runs/$run_id/pending_deployments" \
    >"$pending_file"
  chmod 600 "$jobs_file" "$pending_file"
  if "$AUTHORITY_HELPER" retire-inert-claim \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" \
    --run-id "$run_id" \
    --run-json "$run_file" \
    --jobs-json "$jobs_file" \
    --pending-json "$pending_file" \
    --policy-json "$policy_json" \
    --repository "$repository" \
    --current-master "$current_master" \
    --workflow-id "$workflow_id" \
    --workflow-blob-sha "$workflow_blob_sha" \
    2>"$materialization_error"; then
    printf 'dispatch=RETIRED run_id=%s authority_state=retired\n' "$run_id"
    return
  fi
  fail "dispatch run $run_id is terminal but not inert; do not redispatch or retire its authority"
}

materialize_record() {
  local run_id="$1"
  local attempt
  local summary state version run_status
  local failure_summary failure_reason failure_evidence_sha256

  summary="$(
    "$AUTHORITY_HELPER" verify \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$run_id" \
      --policy-json "$policy_json" \
      --repository "$repository" \
      --current-master "$current_master" \
      --workflow-id "$workflow_id" \
      --workflow-blob-sha "$workflow_blob_sha"
  )"
  assert_resume_identity "$summary"
  state="$(jq -r '.state' <<<"$summary")"
  version="$(jq -r '.version' <<<"$summary")"
  if [[ "$state" = "rejecting" ]]; then
    acquire_authority_lock "$run_id"
    continue_prerequisite_rejection \
      "$run_id" "$version" \
      "protected prerequisites previously decayed"
  fi
  if [[ "$state" != "claimed" ]]; then
    if [[ "$state" = "retired" ]]; then
      printf 'dispatch=RETIRED run_id=%s authority_state=retired\n' "$run_id"
      return
    fi
    printf 'dispatch=READY run_id=%s authority_state=%s\n' "$run_id" "$state"
    return
  fi

  for ((attempt = 1; attempt <= MATERIALIZATION_ATTEMPTS; attempt += 1)); do
    rm -f "$run_file" "$materialization_error"
    if gh api \
      "repos/$repository/actions/runs/$run_id" \
      >"$run_file" 2>"$materialization_error"; then
      chmod 600 "$run_file"
      run_status="$(jq -r '.status // ""' "$run_file")"
      if [[ "$run_status" = "completed" ]]; then
        retire_terminal_claim "$run_id"
        return
      fi
      acquire_authority_lock "$run_id"
      summary="$(
        "$AUTHORITY_HELPER" verify \
          --authority-dir "$AUTHORITY_DIR" \
          --repo-root "$ROOT_DIR" \
          --run-id "$run_id" \
          --policy-json "$policy_json" \
          --repository "$repository" \
          --current-master "$current_master" \
          --workflow-id "$workflow_id" \
          --workflow-blob-sha "$workflow_blob_sha"
      )"
      assert_resume_identity "$summary"
      state="$(jq -r '.state' <<<"$summary")"
      version="$(jq -r '.version' <<<"$summary")"
      if [[ "$state" = "rejecting" ]]; then
        continue_prerequisite_rejection \
          "$run_id" "$version" \
          "protected prerequisites previously decayed"
      fi
      [[ "$state" = "claimed" ]] ||
        fail "authority changed from claimed before materialization"
      if ! gh api \
        "repos/$repository/actions/runs/$run_id" \
        >"$run_file" 2>>"$materialization_error"; then
        release_authority_lock
        if ((attempt < MATERIALIZATION_ATTEMPTS)); then
          sleep "$MATERIALIZATION_SLEEP_SECONDS"
          continue
        fi
        break
      fi
      chmod 600 "$run_file"
      run_status="$(jq -r '.status // ""' "$run_file")"
      if [[ "$run_status" = "completed" ]]; then
        release_authority_lock
        retire_terminal_claim "$run_id"
        return
      fi
      rm -f "$prerequisite_error_file"
      if ! (
        revalidate_control &&
          validate_protected_prerequisites &&
          revalidate_control
      ) >"$prerequisite_error_file" 2>&1; then
        chmod 600 "$prerequisite_error_file"
        failure_summary="$(
          summarize_prerequisite_failure "$prerequisite_error_file"
        )"
        failure_reason="$(jq -r '.reason' <<<"$failure_summary")"
        failure_evidence_sha256="$(jq -r '.sha256' <<<"$failure_summary")"
        if [[ "$run_status" = "waiting" ]]; then
          begin_prerequisite_rejection \
            "$run_id" "$version" \
            "$failure_reason" "$failure_evidence_sha256"
        fi
        release_authority_lock
        if [[ "$run_status" =~ ^(queued|pending|requested)$ ]]; then
          if ((attempt < MATERIALIZATION_ATTEMPTS)); then
            sleep "$MATERIALIZATION_SLEEP_SECONDS"
            continue
          fi
          fail "$failure_reason; exact run $run_id has not reached its protected gate, so claimed authority remains fenced"
        fi
        fail "$failure_reason; exact run $run_id is not provably unstarted at its protected gate, so claimed authority remains fenced"
      fi
      if ! gh api \
        "repos/$repository/actions/runs/$run_id" \
        >"$run_file" 2>>"$materialization_error"; then
        release_authority_lock
        if ((attempt < MATERIALIZATION_ATTEMPTS)); then
          sleep "$MATERIALIZATION_SLEEP_SECONDS"
          continue
        fi
        break
      fi
      chmod 600 "$run_file"
      run_status="$(jq -r '.status // ""' "$run_file")"
      if [[ "$run_status" = "completed" ]]; then
        release_authority_lock
        retire_terminal_claim "$run_id"
        return
      fi
      revalidate_control
      if "$AUTHORITY_HELPER" issue \
        --authority-dir "$AUTHORITY_DIR" \
        --repo-root "$ROOT_DIR" \
        --run-id "$run_id" \
        --token "$authority_lock_token" \
        --expected-version "$version" \
        --run-json "$run_file" \
        --policy-json "$policy_json" \
        --repository "$repository" \
        --current-master "$current_master" \
        --workflow-id "$workflow_id" \
        --workflow-blob-sha "$workflow_blob_sha" \
        2>"$materialization_error"; then
        release_authority_lock
        printf 'dispatch=ACCEPTED run_id=%s run_url=https://github.com/%s/actions/runs/%s authority_state=issued\n' \
          "$run_id" "$repository" "$run_id"
        return
      fi
      release_authority_lock
    fi
    if ((attempt < MATERIALIZATION_ATTEMPTS)); then
      sleep "$MATERIALIZATION_SLEEP_SECONDS"
    fi
  done

  fail "dispatch was accepted as run $run_id, but it remains in an accepted-but-unmaterialized provider state; exact materialization was not proven, do not redispatch, resume this run"
}

if [[ -n "$ACTION" ]]; then
  "$AUTHORITY_HELPER" preflight-root \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR"
fi

validate_runtime_mode_binding() {
  # A finalize dispatch carries an immutable runtime mode. Prove it equals the
  # authoritative Actions environment mode before any authority exists, so an
  # OKE fleet cannot be finalized with k3s semantics or vice versa.
  local declared observed
  declared="$(jq -r '.fixedInputs.runtime_mode // ""' <<<"$policy_json")"
  [[ -n "$declared" ]] || return 0
  observed="$(
    gh api \
      "repos/$repository/environments/$environment/variables/OCI_RUNTIME_MODE" \
      --jq '.value'
  )" || fail "unable to read the authoritative runtime mode for $environment"
  [[ "$declared" = "$observed" ]] ||
    fail "operation runtime mode '$declared' does not match the authoritative $environment mode '$observed'"
}

validate_upstream_run_bindings() {
  # Enforce declared upstream run bindings BEFORE any authority intent or
  # record exists, so a missing, wrong, rerun or expired upstream cannot
  # consume a one-use protected authority. The bound workflow calls the same
  # shared validator with the same policy bindings, so the two paths cannot
  # drift.
  local dispatch_inputs
  [[ -x "$UPSTREAM_BINDING_VALIDATOR" ]] ||
    fail "upstream run binding validator is unavailable"
  [[ "$(jq -r '.upstreamRunBindings | length' <<<"$policy_json")" != "0" ]] ||
    return 0
  dispatch_inputs="$(jq -c '.dispatchInputs' "$normalized_file")"
  [[ -n "$dispatch_inputs" && "$dispatch_inputs" != "null" ]] ||
    fail "normalized request does not expose dispatch inputs"
  "$UPSTREAM_BINDING_VALIDATOR" validate-all \
    --repository "$repository" \
    --policy-json "$policy_json" \
    --subject-sha "$subject_sha" \
    --dispatch-inputs "$dispatch_inputs" >/dev/null ||
    fail "upstream run bindings were rejected before any authority was issued"
}

validate_protected_prerequisites() {
  validate_runtime_mode_binding
  validate_upstream_run_bindings
}

validate_production_exclusivity() {
  REPO="$repository" EXCLUDE_RUN_ID="" PROSPECTIVE_PROMOTION_PR="" \
    "$RUN_EXCLUSIVITY_SCRIPT"
}

revalidate_transition_target() {
  local required_state="$1" observed_workflow
  [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$current_master" &&
    -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] ||
    fail "prepared transition checkout changed or is not clean"
  revalidate_control
  observed_workflow="$(
    gh api "repos/$repository/actions/workflows/$workflow" \
      --jq '[.id,.path,.state] | @tsv'
  )"
  [[ "$observed_workflow" = "$(printf '%s\t%s\t%s' "$workflow_id" ".github/workflows/$workflow" "$required_state")" ]] ||
    fail "prepared transition workflow identity/state changed"
}

prepared_checkpoint() {
  local command="$1" required_state="$2"
  shift 2
  revalidate_transition_target "$required_state"
  # Observation is explicit, has no run-ID inputs/exclusions, and never grants
  # ordinary exclusivity PASS. The helper compares the whole sealed set.
  # The target is passed only from the already validated protected-operation
  # policy resolution above ($workflow), never named or chosen independently.
  REPO="$repository" "$RUN_EXCLUSIVITY_SCRIPT" \
    --observe-disabled-transition "$workflow" \
    >"$observation_file"
  chmod 600 "$observation_file"
  revalidate_transition_target "$required_state"
  "$AUTHORITY_HELPER" "$command" \
    --request "$REQUEST_FILE" --normalized "$normalized_file" \
    --inputs-file "$inputs_file" \
    --policy-json "$("$POLICY_SCRIPT" get "$operation")" \
    --repository "$repository" --current-master "$current_master" \
    --workflow-id "$workflow_id" --workflow-blob-sha "$workflow_blob_sha" \
    --observation-json "$observation_file" \
    --authority-dir "$AUTHORITY_DIR" --repo-root "$ROOT_DIR" "$@"
}

summarize_prerequisite_failure() {
  local failure_file="$1"
  python3 - "$failure_file" <<'PY'
import hashlib
import json
import pathlib
import re
import sys

raw = pathlib.Path(sys.argv[1]).read_bytes()
text = raw.decode("utf-8", errors="replace")
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
parts = []
for line in text.splitlines():
    line = ansi.sub(" ", line)
    safe = "".join(character if character.isprintable() else " " for character in line)
    normalized = " ".join(safe.split())
    if normalized:
        parts.append(normalized)
reason = " | ".join(parts) or "protected prerequisite validation failed"
while len(reason.encode("utf-8")) > 4096:
    reason = reason[:-1]
print(json.dumps({
    "reason": reason,
    "sha256": hashlib.sha256(raw).hexdigest(),
}, separators=(",", ":"), sort_keys=True))
PY
}

begin_prerequisite_rejection() {
  local run_id="$1"
  local expected_version="$2"
  local failure_reason="$3"
  local failure_evidence_sha256="$4"
  local rejection_summary rejection_version

  rm -f \
    "$pre_rejection_run_file" \
    "$pre_rejection_jobs_file" \
    "$pre_rejection_pending_file" \
    "$pre_rejection_approvals_file" \
    "$terminal_rejection_run_file" \
    "$terminal_rejection_jobs_file" \
    "$terminal_rejection_pending_file" \
    "$terminal_rejection_approvals_file" \
    "$materialization_error"
  gh api "repos/$repository/actions/runs/$run_id" \
    >"$pre_rejection_run_file"
  gh api "repos/$repository/actions/runs/$run_id/jobs?per_page=100" \
    >"$pre_rejection_jobs_file"
  gh api "repos/$repository/actions/runs/$run_id/pending_deployments" \
    >"$pre_rejection_pending_file"
  gh api "repos/$repository/actions/runs/$run_id/approvals" \
    >"$pre_rejection_approvals_file"
  chmod 600 \
    "$pre_rejection_run_file" \
    "$pre_rejection_jobs_file" \
    "$pre_rejection_pending_file" \
    "$pre_rejection_approvals_file"

  [[ -n "$failure_reason" ]] ||
    fail "prerequisite rejection failure summary is empty"
  [[ "$failure_evidence_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    fail "prerequisite rejection failure digest is invalid"

  rejection_summary="$(
    "$AUTHORITY_HELPER" begin-prerequisite-rejection \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$run_id" \
      --token "$authority_lock_token" \
      --failure-reason "$failure_reason" \
      --failure-evidence-sha256 "$failure_evidence_sha256" \
      --expected-version "$expected_version" \
      --pre-run-json "$pre_rejection_run_file" \
      --pre-jobs-json "$pre_rejection_jobs_file" \
      --pre-pending-json "$pre_rejection_pending_file" \
      --pre-approvals-json "$pre_rejection_approvals_file" \
      --policy-json "$policy_json" \
      --repository "$repository" \
      --current-master "$current_master" \
      --workflow-id "$workflow_id" \
      --workflow-blob-sha "$workflow_blob_sha"
  )" ||
    fail "$failure_reason; the exact run is not provably unstarted at its protected gate, so claimed authority remains fenced"
  rejection_version="$(jq -r '.version' <<<"$rejection_summary")"
  [[ "$(jq -r '.state' <<<"$rejection_summary")" = "rejecting" ]] ||
    fail "prerequisite rejection did not persist its authority state"
  continue_prerequisite_rejection \
    "$run_id" "$rejection_version" "$failure_reason"
}

continue_prerequisite_rejection() {
  local run_id="$1"
  local expected_version="$2"
  local prerequisite_error="$3"
  local attempt cancel_status=0 summary
  local terminal_observation="" previous_terminal_observation=""

  summary="$(
    "$AUTHORITY_HELPER" read-resume-context \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$run_id" \
      --request "$REQUEST_FILE"
  )"
  assert_resume_identity "$summary"
  [[ "$(jq -r '.state' <<<"$summary")" = "rejecting" ]] ||
    fail "only a rejecting authority can continue prerequisite cancellation"
  [[ "$(jq -r '.version' <<<"$summary")" = "$expected_version" ]] ||
    fail "rejecting authority changed before cancellation resumed"
  revalidate_rejection_continuation

  rm -f \
    "$terminal_rejection_run_file" \
    "$terminal_rejection_jobs_file" \
    "$terminal_rejection_pending_file" \
    "$terminal_rejection_approvals_file" \
    "$materialization_error"
  set +e
  gh api --method POST \
    "repos/$repository/actions/runs/$run_id/cancel" \
    >/dev/null 2>"$materialization_error"
  cancel_status=$?
  set -e

  for ((attempt = 1; attempt <= MATERIALIZATION_ATTEMPTS; attempt += 1)); do
    rm -f \
      "$terminal_rejection_run_file" \
      "$terminal_rejection_jobs_file" \
      "$terminal_rejection_pending_file" \
      "$terminal_rejection_approvals_file"
    if gh api "repos/$repository/actions/runs/$run_id" \
        >"$terminal_rejection_run_file" 2>>"$materialization_error" &&
      [[ "$(jq -r '.status // ""' "$terminal_rejection_run_file")" = "completed" ]] &&
      gh api "repos/$repository/actions/runs/$run_id/jobs?per_page=100" \
        >"$terminal_rejection_jobs_file" 2>>"$materialization_error" &&
      gh api "repos/$repository/actions/runs/$run_id/pending_deployments" \
        >"$terminal_rejection_pending_file" 2>>"$materialization_error" &&
      gh api "repos/$repository/actions/runs/$run_id/approvals" \
        >"$terminal_rejection_approvals_file" 2>>"$materialization_error"; then
      chmod 600 \
        "$terminal_rejection_run_file" \
        "$terminal_rejection_jobs_file" \
        "$terminal_rejection_pending_file" \
        "$terminal_rejection_approvals_file"
      terminal_observation="$(
        python3 - \
          "$terminal_rejection_run_file" \
          "$terminal_rejection_jobs_file" \
          "$terminal_rejection_pending_file" \
          "$terminal_rejection_approvals_file" <<'PY'
import hashlib
import json
import sys

payload = []
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as handle:
        payload.append(json.load(handle))
encoded = json.dumps(
    payload,
    ensure_ascii=True,
    separators=(",", ":"),
    sort_keys=True,
).encode("utf-8")
print(hashlib.sha256(encoded).hexdigest())
PY
      )"
      if [[ "$terminal_observation" != "$previous_terminal_observation" ]]; then
        previous_terminal_observation="$terminal_observation"
        if ((attempt < MATERIALIZATION_ATTEMPTS)); then
          sleep "$MATERIALIZATION_SLEEP_SECONDS"
        fi
        continue
      fi
      revalidate_rejection_continuation
      if "$AUTHORITY_HELPER" retire-prerequisite-rejected-claim \
        --authority-dir "$AUTHORITY_DIR" \
        --repo-root "$ROOT_DIR" \
        --run-id "$run_id" \
        --token "$authority_lock_token" \
        --expected-version "$expected_version" \
        --terminal-run-json "$terminal_rejection_run_file" \
        --terminal-jobs-json "$terminal_rejection_jobs_file" \
        --terminal-pending-json "$terminal_rejection_pending_file" \
        --terminal-approvals-json "$terminal_rejection_approvals_file" \
        --request "$REQUEST_FILE" \
        --repository "$repository" \
        --control-sha "$current_master" \
        --live-master-sha "$live_master" \
        --workflow-id "$workflow_id" \
        --workflow-blob-sha "$workflow_blob_sha" \
        2>>"$materialization_error"; then
        release_authority_lock
        fail "$prerequisite_error; exact run $run_id was cancelled and its rejecting authority retired, submit a corrected request"
      fi
    fi
    if ((attempt < MATERIALIZATION_ATTEMPTS)); then
      sleep "$MATERIALIZATION_SLEEP_SECONDS"
    fi
  done

  release_authority_lock
  fail "$prerequisite_error; exact run $run_id has persisted rejecting authority but terminal cancellation is not yet proven (cancel status $cancel_status), resume this exact run"
}

resume_with_prerequisite_validation() {
  local run_id="$1"
  local summary state version

  summary="$(
    "$AUTHORITY_HELPER" verify \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR" \
      --run-id "$run_id" \
      --policy-json "$policy_json" \
      --repository "$repository" \
      --current-master "$current_master" \
      --workflow-id "$workflow_id" \
      --workflow-blob-sha "$workflow_blob_sha"
  )"
  assert_resume_identity "$summary"
  state="$(jq -r '.state' <<<"$summary")"
  version="$(jq -r '.version' <<<"$summary")"
  if [[ "$state" = "rejecting" ]]; then
    acquire_authority_lock "$run_id"
    continue_prerequisite_rejection \
      "$run_id" "$version" \
      "protected prerequisites previously decayed"
  fi
  materialize_record "$run_id"
}

if [[ "$cross_master_rejection" = true ]]; then
  if [[ "$rejection_state" = "retired" ]]; then
    printf 'dispatch=RETIRED run_id=%s authority_state=retired\n' \
      "$RESUME_RUN_ID"
    exit 0
  fi
  rejection_version="$(jq -r '.version' <<<"$rejection_context")"
  acquire_authority_lock "$RESUME_RUN_ID"
  continue_prerequisite_rejection \
    "$RESUME_RUN_ID" \
    "$rejection_version" \
    "protected prerequisites previously decayed"
  fail "prerequisite rejection continuation returned unexpectedly"
fi

if [[ "$ACTION" = "--resume-run" ]]; then
  revalidate_control
  bound_run_id="$(
    "$AUTHORITY_HELPER" bind-intent \
      --normalized "$normalized_file" \
      --policy-json "$policy_json" \
      --repository "$repository" \
      --current-master "$current_master" \
      --workflow-id "$workflow_id" \
      --workflow-blob-sha "$workflow_blob_sha" \
      --expected-run-id "$RESUME_RUN_ID" \
      --allow-missing \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR"
  )"
  [[ -z "$bound_run_id" || "$bound_run_id" = "$RESUME_RUN_ID" ]] ||
    fail "resumed dispatch intent returned a different run ID"
  resume_with_prerequisite_validation "$RESUME_RUN_ID"
  exit 0
fi

if [[ "$ACTION" = "--resume-captured" ]]; then
  revalidate_control
  bound_run_id="$(
    "$AUTHORITY_HELPER" bind-intent \
      --normalized "$normalized_file" \
      --policy-json "$policy_json" \
      --repository "$repository" \
      --current-master "$current_master" \
      --workflow-id "$workflow_id" \
      --workflow-blob-sha "$workflow_blob_sha" \
      --authority-dir "$AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR"
  )"
  [[ "$bound_run_id" =~ ^[1-9][0-9]*$ ]] ||
    fail "captured dispatch intent did not identify one exact run"
  resume_with_prerequisite_validation "$bound_run_id"
  exit 0
fi

if [[ "$ACTION" = "--dispatch-prepared" ]]; then
  # POST-A and POST-B are the same verifier around mutable prerequisite/control
  # revalidation. Only the locked POST-B CAS winner can reach the captured call.
  post_a="$(prepared_checkpoint verify-prepared active)"
  validate_protected_prerequisites
  revalidate_transition_target active
  intent_summary="$(
    prepared_checkpoint dispatch-prepared active \
      --expected-snapshot "$(jq -r '.snapshot' <<<"$post_a")" --owner-pid "$$"
  )"
elif [[ "$ACTION" = "--prepare-disabled-ghosts" ]]; then
  validate_protected_prerequisites
  prepared_checkpoint prepare-disabled-ghosts disabled_manually --owner-pid "$$"
  printf 'dispatch=PREPARED authority_state=prepared next_action=external-enable\n'
  exit 0
else
  validate_protected_prerequisites
fi

printf 'dispatch=READY operation=%s workflow=%s environment=%s control_sha=%s input_sha256=%s title_template=%s\n' \
  "$operation" "$workflow" "$environment" "$current_master" "$input_hash" "$title_template"

[[ "$ACTION" = "--dispatch" || "$ACTION" = "--dispatch-prepared" ]] || exit 0

if [[ "$ACTION" = "--dispatch" ]]; then
blocking_record="$(
  "$AUTHORITY_HELPER" blocking-record \
    --normalized "$normalized_file" \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR"
)"
if [[ -n "$blocking_record" ]]; then
  IFS=$'\t' read -r blocking_authority blocking_state <<<"$blocking_record"
  fail "dispatch is blocked by $blocking_state authority $blocking_authority; do not redispatch"
fi

revalidate_dispatch_target
validate_production_exclusivity
revalidate_dispatch_target

intent_summary="$(
  "$AUTHORITY_HELPER" claim-request \
    --normalized "$normalized_file" \
    --policy-json "$policy_json" \
    --repository "$repository" \
    --current-master "$current_master" \
    --workflow-id "$workflow_id" \
    --workflow-blob-sha "$workflow_blob_sha" \
    --owner-pid "$$" \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR"
)"
if [[ "$(jq -r '.created' <<<"$intent_summary")" != "true" ]]; then
  fail "request already has an unresolved dispatch intent; do not redispatch"
fi
capture_path="$(jq -r '.capturePath' <<<"$intent_summary")"
intent_version="$(jq -r '.version' <<<"$intent_summary")"

if ! dispatch_revalidation_error="$(
  {
    revalidate_dispatch_target &&
      validate_protected_prerequisites &&
      revalidate_dispatch_target &&
      validate_production_exclusivity &&
      revalidate_dispatch_target
  } 2>&1
)"; then
  "$AUTHORITY_HELPER" cancel-intent \
    --normalized "$normalized_file" \
    --policy-json "$policy_json" \
    --repository "$repository" \
    --current-master "$current_master" \
    --workflow-id "$workflow_id" \
    --workflow-blob-sha "$workflow_blob_sha" \
    --expected-version "$intent_version" \
    --owner-pid "$$" \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR"
  fail "$dispatch_revalidation_error"
fi
else
  # After this CAS there is deliberately no pre-dispatch cancellation/release.
  # A crash is ambiguous even with an empty capture; only exact resume applies.
  [[ "$(jq -r '.state' <<<"$intent_summary")" = dispatching ]] ||
    fail "prepared CAS did not claim dispatch authority"
  capture_path="$(jq -r '.capturePath' <<<"$intent_summary")"
  intent_version="$(jq -r '.version' <<<"$intent_summary")"
fi

set +e
gh workflow run "$workflow" \
  --repo "$repository" \
  --ref master \
  --json \
  <"$inputs_file" \
  >"$capture_path" \
  2>&1
dispatch_status=$?
set -e

"$AUTHORITY_HELPER" record-dispatch-status \
  --normalized "$normalized_file" \
  --policy-json "$policy_json" \
  --repository "$repository" \
  --current-master "$current_master" \
  --workflow-id "$workflow_id" \
  --workflow-blob-sha "$workflow_blob_sha" \
  --expected-version "$intent_version" \
  --expected-capture-file "${capture_path##*/}" \
  --dispatch-status "$dispatch_status" \
  --authority-dir "$AUTHORITY_DIR" \
  --repo-root "$ROOT_DIR" \
  >"$materialization_error" ||
  fail "dispatch outcome was captured but its intent status was not persisted; do not redispatch"

if ! run_id="$(
  "$AUTHORITY_HELPER" bind-intent \
    --normalized "$normalized_file" \
    --policy-json "$policy_json" \
    --repository "$repository" \
    --current-master "$current_master" \
    --workflow-id "$workflow_id" \
    --workflow-blob-sha "$workflow_blob_sha" \
    --expected-capture-file "${capture_path##*/}" \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" \
    2>"$materialization_error"
)"; then
  fail "dispatch command exited $dispatch_status without one exact persisted run URL; outcome is ambiguous, do not redispatch"
fi
[[ "$run_id" =~ ^[1-9][0-9]*$ ]] || fail "bound dispatch run ID is invalid"

materialize_record "$run_id"
