#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DISPATCHER="$ROOT_DIR/infra/azure/agents/copilot-cli-dispatch-stan.sh"
POLICY="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
HELPER="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"
SHA=1111111111111111111111111111111111111111
BLOB=2222222222222222222222222222222222222222
REPOSITORY=example/repo
WORKFLOW_ID=310

WORK="$(mktemp -d "${TMPDIR:-/tmp}/betstan-prerequisite-rejection.XXXXXX")"
chmod 700 "$WORK"
STATE_DIR="$WORK/run-state"
mkdir "$STATE_DIR"
MODE_FILE="$WORK/runtime-mode"
MODE_COUNT_FILE="$WORK/runtime-mode-count"
DISPATCH_COUNT_FILE="$WORK/dispatch-count"
CANCEL_COUNT_FILE="$WORK/cancel-count"
trap 'rm -rf "$WORK"' EXIT

make_request() {
  local operation="$1"
  local path="$2"
  local policy_json
  policy_json="$("$POLICY" get "$operation")"
  python3 - "$path" "$policy_json" "$SHA" "$REPOSITORY" <<'PY'
import json
import os
import sys

path, policy_text, sha, repository = sys.argv[1:]
policy = json.loads(policy_text)
allow_empty = set(policy["allowEmptyInputs"])
booleans = set(policy["booleanInputs"])
inputs = {
    name: (False if name in booleans else ("" if name in allow_empty else "value"))
    for name in policy["inputNames"]
}
inputs.update(policy["fixedInputs"])
for name in policy["positiveIntegerInputs"]:
    inputs[name] = "42"
for name in policy["zeroOrPositiveIntegerInputs"]:
    inputs[name] = "0"
for name in policy["fullShaInputs"]:
    inputs[name] = sha
request = {
    "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
    "repository": repository,
    "operation": policy["operation"],
    "controlSha": sha,
    "subjectSha": sha,
    "targetSha": None,
    "inputs": inputs,
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(request, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
}

prepare_unresolved() {
  local operation="$1"
  local run_id="$2"
  local materialization="$3"
  local authority_dir="$4"
  local request="$5"
  local normalized="$6"
  local policy_json intent capture version

  policy_json="$("$POLICY" get "$operation")"
  "$HELPER" validate-request \
    --request "$request" \
    --policy-json "$policy_json" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --repo-root "$ROOT_DIR" \
    --output "$normalized"
  intent="$(
    "$HELPER" claim-request \
      --normalized "$normalized" \
      --policy-json "$policy_json" \
      --repository "$REPOSITORY" \
      --current-master "$SHA" \
      --workflow-id "$WORKFLOW_ID" \
      --workflow-blob-sha "$BLOB" \
      --owner-pid "$$" \
      --authority-dir "$authority_dir" \
      --repo-root "$ROOT_DIR"
  )"
  capture="$(jq -r '.capturePath' <<<"$intent")"
  version="$(jq -r '.version' <<<"$intent")"
  printf 'https://github.com/%s/actions/runs/%s\n' \
    "$REPOSITORY" "$run_id" >"$capture"
  "$HELPER" record-dispatch-status \
    --normalized "$normalized" \
    --policy-json "$policy_json" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --workflow-id "$WORKFLOW_ID" \
    --workflow-blob-sha "$BLOB" \
    --expected-version "$version" \
    --dispatch-status 0 \
    --authority-dir "$authority_dir" \
    --repo-root "$ROOT_DIR" >/dev/null
  if [[ "$materialization" = "claimed" ]]; then
    "$HELPER" bind-intent \
      --normalized "$normalized" \
      --policy-json "$policy_json" \
      --repository "$REPOSITORY" \
      --current-master "$SHA" \
      --workflow-id "$WORKFLOW_ID" \
      --workflow-blob-sha "$BLOB" \
      --expected-run-id "$run_id" \
      --authority-dir "$authority_dir" \
      --repo-root "$ROOT_DIR" >/dev/null
  fi
  printf 'waiting\n' >"$STATE_DIR/$run_id"
}

run_json() {
  local run_id="$1"
  local state operation title status conclusion
  state="$(cat "$STATE_DIR/$run_id")"
  case "$run_id" in
    701)
      operation=oci-infrastructure-prepare-oke
      title="oci-infrastructure prepare oke $SHA"
      ;;
    *)
      operation=oci-infrastructure-prepare-k3s
      title="oci-infrastructure prepare k3s $SHA"
      ;;
  esac
  if [[ "$state" = "cancelled" ]]; then
    status=completed
    conclusion=cancelled
  else
    status="$state"
    conclusion=""
  fi
  jq -cn \
    --argjson id "$run_id" \
    --arg title "$title" \
    --arg status "$status" \
    --arg conclusion "$conclusion" \
    --arg sha "$SHA" \
    --arg repo "$REPOSITORY" \
    '{
      id:$id,
      workflow_id:310,
      path:".github/workflows/oci-infrastructure.yml",
      display_title:$title,
      event:"workflow_dispatch",
      head_sha:$sha,
      head_branch:"master",
      head_repository:{full_name:$repo},
      run_attempt:1,
      status:$status,
      conclusion:(if $conclusion == "" then null else $conclusion end)
    }'
}

jobs_json() {
  local run_id="$1"
  local state status conclusion
  state="$(cat "$STATE_DIR/$run_id")"
  if [[ "$state" = "cancelled" ]]; then
    status=completed
    conclusion=cancelled
  else
    status="$state"
    conclusion=""
  fi
  jq -cn \
    --arg status "$status" \
    --arg conclusion "$conclusion" \
    '{
      total_count:2,
      jobs:[
        {
          id:1,
          status:$status,
          conclusion:(if $conclusion == "" then null else $conclusion end),
          steps:[]
        },
        {
          id:2,
          status:"completed",
          conclusion:"skipped",
          steps:[]
        }
      ]
    }'
}

runtime_mode() {
  if [[ -n "${STUB_MODE_SEQUENCE:-}" ]]; then
    local count=0
    [[ -f "$MODE_COUNT_FILE" ]] && count="$(cat "$MODE_COUNT_FILE")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$MODE_COUNT_FILE"
    if ((count == 1)); then
      printf 'k3s\n'
    else
      printf 'oke\n'
    fi
  else
    cat "$MODE_FILE"
  fi
}

git() {
  if [[ "$1" = "-C" ]]; then
    shift 2
  fi
  case "$1 $2" in
    "rev-parse --show-toplevel") printf '%s\n' "$ROOT_DIR" ;;
    "rev-parse HEAD") printf '%s\n' "$SHA" ;;
    "status --porcelain") return 0 ;;
    "merge-base --is-ancestor"|"cat-file -e") return 0 ;;
    *)
      if [[ "$1" = "rev-parse" &&
        "$2" = "$SHA:.github/workflows/oci-infrastructure.yml" ]]; then
        printf '%s\n' "$BLOB"
      else
        echo "unexpected git call: $*" >&2
        return 1
      fi
      ;;
  esac
}

gh() {
  if [[ "$1 $2" = "repo view" ]]; then
    printf '%s\n' "$REPOSITORY"
    return
  fi
  if [[ "$1 $2" = "workflow run" ]]; then
    local count=0 run_id=799
    [[ -f "$DISPATCH_COUNT_FILE" ]] && count="$(cat "$DISPATCH_COUNT_FILE")"
    printf '%s\n' "$((count + 1))" >"$DISPATCH_COUNT_FILE"
    cat >/dev/null
    printf 'waiting\n' >"$STATE_DIR/$run_id"
    printf 'https://github.com/%s/actions/runs/%s\n' "$REPOSITORY" "$run_id"
    return
  fi
  [[ "$1" = "api" ]] || {
    echo "unexpected gh call: $*" >&2
    return 1
  }
  shift
  local method=GET
  if [[ "${1:-}" = "--method" ]]; then
    method="$2"
    shift 2
  fi
  local endpoint="$1"
  shift
  if [[ "$method" = POST && "$endpoint" == */cancel ]]; then
    local run_id count=0
    run_id="${endpoint%/cancel}"
    run_id="${run_id##*/}"
    [[ -f "$CANCEL_COUNT_FILE" ]] && count="$(cat "$CANCEL_COUNT_FILE")"
    printf '%s\n' "$((count + 1))" >"$CANCEL_COUNT_FILE"
    printf 'cancelled\n' >"$STATE_DIR/$run_id"
    printf '{}\n'
    return
  fi
  case "$endpoint" in
    "repos/$REPOSITORY/git/ref/heads/master")
      printf '%s\n' "$SHA"
      ;;
    "repos/$REPOSITORY/actions/workflows/oci-infrastructure.yml")
      if [[ " $* " == *" --jq "* ]]; then
        if [[ " $* " == *"@tsv"* ]]; then
          printf '%s\t%s\t%s\n' \
            "$WORKFLOW_ID" ".github/workflows/oci-infrastructure.yml" active
        else
          printf 'active\n'
        fi
      else
        printf '{"id":310,"path":".github/workflows/oci-infrastructure.yml","state":"active"}\n'
      fi
      ;;
    "repos/$REPOSITORY/contents/.github/workflows/oci-infrastructure.yml?ref=$SHA")
      printf '%s\n' "$BLOB"
      ;;
    "repos/$REPOSITORY/commits/$SHA/pulls")
      printf '[{"merged_at":"2026-01-01T00:00:00Z","merge_commit_sha":"%s","base":{"ref":"master"},"head":{"ref":"dev"},"labels":[{"name":"copilot-cli-managed"}]}]\n' "$SHA"
      ;;
    "repos/$REPOSITORY/environments/oci-infrastructure/variables/OCI_RUNTIME_MODE")
      runtime_mode
      ;;
    "repos/$REPOSITORY/actions/runs?status="*)
      printf '{"total_count":0,"workflow_runs":[]}\n'
      ;;
    "repos/$REPOSITORY/actions/runs/"*"/jobs?per_page=100")
      local run_id
      run_id="${endpoint#repos/"$REPOSITORY"/actions/runs/}"
      run_id="${run_id%%/*}"
      jobs_json "$run_id"
      ;;
    "repos/$REPOSITORY/actions/runs/"*"/pending_deployments")
      local run_id state
      run_id="${endpoint#repos/"$REPOSITORY"/actions/runs/}"
      run_id="${run_id%%/*}"
      state="$(cat "$STATE_DIR/$run_id")"
      if [[ "$state" = "waiting" ]]; then
        printf '[{"environment":{"id":901,"name":"oci-infrastructure"},"current_user_can_approve":true}]\n'
      else
        printf '[]\n'
      fi
      ;;
    "repos/$REPOSITORY/actions/runs/"*"/approvals")
      local run_id state
      run_id="${endpoint#repos/"$REPOSITORY"/actions/runs/}"
      run_id="${run_id%%/*}"
      state="$(cat "$STATE_DIR/$run_id")"
      if [[
        "${STUB_APPROVED_RUN:-}" = "$run_id" &&
          "$state" = "cancelled"
      ]]; then
        printf '[{"state":"approved","environments":[{"id":901,"name":"oci-infrastructure"}]}]\n'
      else
        printf '[]\n'
      fi
      ;;
    "repos/$REPOSITORY/actions/runs/"*)
      local run_id
      run_id="${endpoint##*/}"
      run_json "$run_id"
      ;;
    *)
      echo "unexpected gh api call: endpoint=$endpoint args=$*" >&2
      return 1
      ;;
  esac
}

export -f git gh run_json jobs_json runtime_mode
export ROOT_DIR SHA BLOB REPOSITORY WORKFLOW_ID
export STATE_DIR MODE_FILE MODE_COUNT_FILE DISPATCH_COUNT_FILE CANCEL_COUNT_FILE
export STUB_APPROVED_RUN

run_dispatcher() {
  local authority_dir="$1"
  shift
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  COPILOT_CLI_MATERIALIZATION_ATTEMPTS=2 \
  COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS=0 \
    "$DISPATCHER" "$@"
}

captured_authority="$WORK/captured-authority"
captured_request="$WORK/captured-request.json"
captured_normalized="$WORK/captured-normalized.json"
make_request oci-infrastructure-prepare-k3s "$captured_request"
prepare_unresolved \
  oci-infrastructure-prepare-k3s \
  700 \
  captured \
  "$captured_authority" \
  "$captured_request" \
  "$captured_normalized"
printf 'oke\n' >"$MODE_FILE"
if run_dispatcher "$captured_authority" \
  "$captured_request" --resume-captured >"$WORK/out" 2>"$WORK/err"; then
  echo "captured resume with decayed mode unexpectedly passed" >&2
  exit 1
fi
grep -qF "exact run 700 was cancelled" "$WORK/err"
jq -e '.state == "retired"' "$captured_authority/700.json" >/dev/null
[[ -z "$(find "$captured_authority" -maxdepth 1 -name 'request-*.json' -print -quit)" ]]
[[ "$(cat "$CANCEL_COUNT_FILE")" = "1" ]]

printf 'k3s\n' >"$MODE_FILE"
run_dispatcher "$captured_authority" \
  "$captured_request" --dispatch >"$WORK/out"
grep -qF "authority_state=issued" "$WORK/out"
jq -e '.state == "issued"' "$captured_authority/799.json" >/dev/null

claimed_authority="$WORK/claimed-authority"
claimed_request="$WORK/claimed-request.json"
claimed_normalized="$WORK/claimed-normalized.json"
make_request oci-infrastructure-prepare-oke "$claimed_request"
prepare_unresolved \
  oci-infrastructure-prepare-oke \
  701 \
  claimed \
  "$claimed_authority" \
  "$claimed_request" \
  "$claimed_normalized"
printf 'k3s\n' >"$MODE_FILE"
if run_dispatcher "$claimed_authority" \
  "$claimed_request" --resume-run 701 >"$WORK/out" 2>"$WORK/err"; then
  echo "claimed resume with decayed mode unexpectedly passed" >&2
  exit 1
fi
grep -qF "exact run 701 was cancelled" "$WORK/err"
jq -e '.state == "retired"' "$claimed_authority/701.json" >/dev/null
[[ "$(cat "$CANCEL_COUNT_FILE")" = "2" ]]

fresh_authority="$WORK/fresh-authority"
fresh_request="$WORK/fresh-request.json"
make_request oci-infrastructure-prepare-k3s "$fresh_request"
rm -f "$MODE_COUNT_FILE" "$DISPATCH_COUNT_FILE"
if STUB_MODE_SEQUENCE=1 \
  run_dispatcher "$fresh_authority" \
    "$fresh_request" --dispatch >"$WORK/out" 2>"$WORK/err"; then
  echo "post-claim prerequisite drift unexpectedly dispatched" >&2
  exit 1
fi
grep -qF "does not match the authoritative" "$WORK/err"
[[ ! -e "$DISPATCH_COUNT_FILE" ]]
[[ -z "$(find "$fresh_authority" -maxdepth 1 -type f -print -quit)" ]]

unsafe_authority="$WORK/unsafe-authority"
unsafe_request="$WORK/unsafe-request.json"
unsafe_normalized="$WORK/unsafe-normalized.json"
make_request oci-infrastructure-prepare-k3s "$unsafe_request"
prepare_unresolved \
  oci-infrastructure-prepare-k3s \
  702 \
  claimed \
  "$unsafe_authority" \
  "$unsafe_request" \
  "$unsafe_normalized"
printf 'in_progress\n' >"$STATE_DIR/702"
printf 'oke\n' >"$MODE_FILE"
cancel_before="$(cat "$CANCEL_COUNT_FILE")"
if run_dispatcher "$unsafe_authority" \
  "$unsafe_request" --resume-run 702 >"$WORK/out" 2>"$WORK/err"; then
  echo "started resume was unsafely retired" >&2
  exit 1
fi
grep -qF "not provably unstarted" "$WORK/err"
jq -e '.state == "claimed"' "$unsafe_authority/702.json" >/dev/null
[[ "$(cat "$CANCEL_COUNT_FILE")" = "$cancel_before" ]]

approved_authority="$WORK/approved-authority"
approved_request="$WORK/approved-request.json"
approved_normalized="$WORK/approved-normalized.json"
make_request oci-infrastructure-prepare-k3s "$approved_request"
prepare_unresolved \
  oci-infrastructure-prepare-k3s \
  703 \
  claimed \
  "$approved_authority" \
  "$approved_request" \
  "$approved_normalized"
printf 'oke\n' >"$MODE_FILE"
STUB_APPROVED_RUN=703
export STUB_APPROVED_RUN
if run_dispatcher "$approved_authority" \
  "$approved_request" --resume-run 703 >"$WORK/out" 2>"$WORK/err"; then
  echo "approved resume was unsafely retired" >&2
  exit 1
fi
grep -qF "could not be proven safely cancelled" "$WORK/err"
jq -e '.state == "claimed"' "$approved_authority/703.json" >/dev/null

echo "dispatch_prerequisite_rejection=PASS"
