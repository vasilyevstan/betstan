#!/usr/bin/env bash
set -euo pipefail

# Purpose: dispatch one policy-defined protected operation and bind the exact
#          returned run ID to a private Copilot CLI authority record.
# Usage:
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json --dispatch
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json --resume-captured
#   ./copilot-cli-dispatch-stan.sh /absolute/path/request.json --resume-run 123

umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POLICY_SCRIPT="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
AUTHORITY_HELPER="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"
RUN_EXCLUSIVITY_SCRIPT="$ROOT_DIR/infra/azure/agents/production-run-exclusivity-stan.sh"
UPSTREAM_BINDING_VALIDATOR="$ROOT_DIR/infra/oci/scripts/upstream_run_binding_stan.py"
AUTHORITY_DIR="${COPILOT_CLI_AUTHORITY_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/betstan/copilot-cli-authority}"
MATERIALIZATION_ATTEMPTS="${COPILOT_CLI_MATERIALIZATION_ATTEMPTS:-12}"
MATERIALIZATION_SLEEP_SECONDS="${COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS:-5}"

REQUEST_FILE="${1:-}"
ACTION="${2:-}"
RESUME_RUN_ID="${3:-}"

fail() {
  echo "$*" >&2
  exit 1
}

usage() {
  fail "usage: $0 /absolute/path/request.json [--dispatch | --resume-captured | --resume-run <run-id>]"
}

[[ -n "$REQUEST_FILE" ]] || usage
case "$ACTION" in
  "")
    ;;
  --dispatch)
    [[ -z "$RESUME_RUN_ID" ]] || usage
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
promotion_file="$tmp_dir/promotion.json"
cleanup() {
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
    "$promotion_file"
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

local_root="$(git -C "$ROOT_DIR" rev-parse --show-toplevel)"
[[ "$local_root" = "$ROOT_DIR" ]] || fail "script is not running from its repository root"
local_head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
[[ "$local_head" = "$current_master" ]] ||
  fail "dispatch must run from a checkout at exact current master"
[[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] ||
  fail "dispatch checkout is not clean"

operation="$(
  "$AUTHORITY_HELPER" request-operation \
    --request "$REQUEST_FILE" \
    --repo-root "$ROOT_DIR"
)"
policy_json="$("$POLICY_SCRIPT" get "$operation")"
workflow="$(jq -r '.workflow' <<<"$policy_json")"
environment="$(jq -r '.environment' <<<"$policy_json")"
authority_mode="$(jq -r '.authority' <<<"$policy_json")"
[[ "$authority_mode" = "dispatch-record" ]] ||
  fail "operation is automatic and cannot be manually dispatched"

read -r workflow_id workflow_path workflow_state <<<"$(
  gh api "repos/$repository/actions/workflows/$workflow" \
    --jq '[.id,.path,.state] | @tsv'
)"
[[ "$workflow_id" =~ ^[1-9][0-9]*$ ]] || fail "trusted workflow ID is invalid"
[[ "$workflow_path" = ".github/workflows/$workflow" ]] ||
  fail "trusted workflow path does not match policy"
[[ "$workflow_state" = "active" || "$workflow_state" = "disabled_manually" ]] ||
  fail "trusted workflow has an unsupported state: $workflow_state"

workflow_blob_sha="$(
  gh api \
    "repos/$repository/contents/.github/workflows/$workflow?ref=$current_master" \
    --jq '.sha'
)"
[[ "$workflow_blob_sha" =~ ^[0-9a-f]{40}$ ]] ||
  fail "trusted workflow blob SHA is invalid"
local_workflow_blob="$(
  git -C "$ROOT_DIR" rev-parse "$current_master:.github/workflows/$workflow"
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

subject_relation="$(jq -r '.subjectRelation' "$normalized_file")"
target_relation="$(jq -r '.targetRelation' "$normalized_file")"
subject_sha="$(jq -r '.subjectSha // ""' "$normalized_file")"
target_sha="$(jq -r '.targetSha // ""' "$normalized_file")"
input_hash="$(jq -r '.inputHash' "$normalized_file")"
title_template="$(jq -r '.displayTitleTemplate' "$normalized_file")"
validate_ancestor_relation "$subject_relation" "$subject_sha" "subject"
validate_ancestor_relation "$target_relation" "$target_sha" "target"

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

materialize_record() {
  local run_id="$1"
  local attempt
  local summary state

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
  [[ "$(jq -r '.inputHash' <<<"$summary")" = "$input_hash" ]] ||
    fail "resume request does not match the authority record input hash"
  [[ "$(jq -r '.subjectSha // ""' <<<"$summary")" = "$subject_sha" ]] ||
    fail "resume request does not match the authority record subject SHA"
  [[ "$(jq -r '.targetSha // ""' <<<"$summary")" = "$target_sha" ]] ||
    fail "resume request does not match the authority record target SHA"
  state="$(jq -r '.state' <<<"$summary")"
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
      if [[ "$(jq -r '.status // ""' "$run_file")" = "completed" ]]; then
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
      fi
      if "$AUTHORITY_HELPER" issue \
        --authority-dir "$AUTHORITY_DIR" \
        --repo-root "$ROOT_DIR" \
        --run-id "$run_id" \
        --run-json "$run_file" \
        --policy-json "$policy_json" \
        --repository "$repository" \
        --current-master "$current_master" \
        --workflow-id "$workflow_id" \
        --workflow-blob-sha "$workflow_blob_sha" \
        2>"$materialization_error"; then
        printf 'dispatch=ACCEPTED run_id=%s run_url=https://github.com/%s/actions/runs/%s authority_state=issued\n' \
          "$run_id" "$repository" "$run_id"
        return
      fi
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

retire_prerequisite_rejected_resume() {
  local run_id="$1"
  local expected_version="$2"
  local prerequisite_error="$3"
  local attempt cancel_status=0

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

  "$AUTHORITY_HELPER" check-prerequisite-rejection \
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" \
    --run-id "$run_id" \
    --expected-version "$expected_version" \
    --pre-run-json "$pre_rejection_run_file" \
    --pre-jobs-json "$pre_rejection_jobs_file" \
    --pre-pending-json "$pre_rejection_pending_file" \
    --pre-approvals-json "$pre_rejection_approvals_file" \
    --policy-json "$policy_json" \
    --repository "$repository" \
    --current-master "$current_master" \
    --workflow-id "$workflow_id" \
    --workflow-blob-sha "$workflow_blob_sha" \
    >/dev/null ||
    fail "$prerequisite_error; the exact run is not provably unstarted, so its claimed authority remains fenced"

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
      [[ "$(jq -r '.status // ""' "$terminal_rejection_run_file")" = "completed" ]]; then
      gh api "repos/$repository/actions/runs/$run_id/jobs?per_page=100" \
        >"$terminal_rejection_jobs_file"
      gh api "repos/$repository/actions/runs/$run_id/pending_deployments" \
        >"$terminal_rejection_pending_file"
      gh api "repos/$repository/actions/runs/$run_id/approvals" \
        >"$terminal_rejection_approvals_file"
      chmod 600 \
        "$terminal_rejection_run_file" \
        "$terminal_rejection_jobs_file" \
        "$terminal_rejection_pending_file" \
        "$terminal_rejection_approvals_file"
      if "$AUTHORITY_HELPER" retire-prerequisite-rejected-claim \
        --authority-dir "$AUTHORITY_DIR" \
        --repo-root "$ROOT_DIR" \
        --run-id "$run_id" \
        --expected-version "$expected_version" \
        --pre-run-json "$pre_rejection_run_file" \
        --pre-jobs-json "$pre_rejection_jobs_file" \
        --pre-pending-json "$pre_rejection_pending_file" \
        --pre-approvals-json "$pre_rejection_approvals_file" \
        --terminal-run-json "$terminal_rejection_run_file" \
        --terminal-jobs-json "$terminal_rejection_jobs_file" \
        --terminal-pending-json "$terminal_rejection_pending_file" \
        --terminal-approvals-json "$terminal_rejection_approvals_file" \
        --policy-json "$policy_json" \
        --repository "$repository" \
        --current-master "$current_master" \
        --workflow-id "$workflow_id" \
        --workflow-blob-sha "$workflow_blob_sha" \
        2>>"$materialization_error"; then
        fail "$prerequisite_error; exact run $run_id was cancelled and its claimed authority retired, submit a corrected request"
      fi
    fi
    if ((attempt < MATERIALIZATION_ATTEMPTS)); then
      sleep "$MATERIALIZATION_SLEEP_SECONDS"
    fi
  done

  fail "$prerequisite_error; exact run $run_id could not be proven safely cancelled (cancel status $cancel_status), so its claimed authority remains fenced"
}

resume_with_prerequisite_validation() {
  local run_id="$1"
  local summary state version prerequisite_error

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
  state="$(jq -r '.state' <<<"$summary")"
  version="$(jq -r '.version' <<<"$summary")"
  if ! prerequisite_error="$(
    validate_protected_prerequisites 2>&1
  )"; then
    if [[ "$state" = "claimed" ]]; then
      retire_prerequisite_rejected_resume \
        "$run_id" "$version" "$prerequisite_error"
    fi
    fail "$prerequisite_error; authority state $state cannot be retired as an unissued resume"
  fi
  materialize_record "$run_id"
}

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

validate_protected_prerequisites

printf 'dispatch=READY operation=%s workflow=%s environment=%s control_sha=%s input_sha256=%s title_template=%s\n' \
  "$operation" "$workflow" "$environment" "$current_master" "$input_hash" "$title_template"

[[ "$ACTION" = "--dispatch" ]] || exit 0

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
REPO="$repository" EXCLUDE_RUN_ID="" PROSPECTIVE_PROMOTION_PR="" \
  "$RUN_EXCLUSIVITY_SCRIPT"
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
    revalidate_dispatch_target
    validate_protected_prerequisites
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
    --authority-dir "$AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" \
    2>"$materialization_error"
)"; then
  fail "dispatch command exited $dispatch_status without one exact persisted run URL; outcome is ambiguous, do not redispatch"
fi
[[ "$run_id" =~ ^[1-9][0-9]*$ ]] || fail "bound dispatch run ID is invalid"

materialize_record "$run_id"
