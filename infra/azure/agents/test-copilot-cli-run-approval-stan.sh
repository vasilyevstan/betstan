#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APPROVER="$ROOT_DIR/infra/azure/agents/copilot-cli-run-approval-stan.sh"
POLICY="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
HELPER="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"
SHA="1111111111111111111111111111111111111111"
TARGET_SHA="0000000000000000000000000000000000000000"
BLOB="2222222222222222222222222222222222222222"
REPOSITORY="example/repo"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-approval-test.XXXXXX")"
chmod 700 "$tmp_dir"
authority_dir="$tmp_dir/authority"
records_file="$tmp_dir/records.tsv"
output_file="$tmp_dir/output"
error_file="$tmp_dir/error"
post_count_file="$tmp_dir/post-count"
approval_history_file="$tmp_dir/approval-history.tsv"
workflow_state_count_file="$tmp_dir/workflow-state-count"
: >"$approval_history_file"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

workflow_id_for() {
  case "$1" in
    production-build.yml) echo 301 ;;
    production-deploy.yml) echo 302 ;;
    production-rollback.yml) echo 303 ;;
    oci-production-build.yml) echo 304 ;;
    oci-production-deploy.yml) echo 305 ;;
    oci-production-rollback.yml) echo 306 ;;
    oci-live-betting-activate.yml) echo 307 ;;
    oci-live-betting-disable.yml) echo 308 ;;
    oci-capacity-acquire.yml) echo 309 ;;
    oci-infrastructure.yml) echo 310 ;;
    ghcr-package-management.yml) echo 311 ;;
    oci-ghcr-cache-recovery.yml) echo 312 ;;
    oci-live-data-rollout.yml) echo 313 ;;
    oci-migrate.yml) echo 314 ;;
    oci-migration-recovery.yml) echo 315 ;;
    *) return 1 ;;
  esac
}

approval_state_for() {
  case "$1" in
    oci-capacity-acquire.yml|\
    oci-infrastructure.yml|\
    oci-live-betting-activate.yml|\
    oci-live-data-rollout.yml|\
    oci-migration-recovery.yml|\
    oci-production-deploy.yml)
      echo disabled_manually
      ;;
    *)
      echo active
      ;;
  esac
}

git() {
  if [[ "$1" = "-C" ]]; then
    shift 2
  fi
  if [[ "$1" = "status" ]]; then
    if [[ "${STUB_DIRTY_CHECKOUT:-false}" = "true" ]]; then
      printf '?? untracked-authority-override.py\n'
    fi
    return 0
  fi
  case "$1 $2" in
    "rev-parse --show-toplevel")
      printf '%s\n' "$ROOT_DIR"
      ;;
    "rev-parse HEAD")
      printf '%s\n' "$SHA"
      ;;
    "cat-file -e"|"merge-base --is-ancestor")
      return 0
      ;;
    *)
      if [[ "$1" = "rev-parse" && "$2" = "$SHA:.github/workflows/"* ]]; then
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

  if [[ "$method" = "POST" ]]; then
    [[ "$endpoint" = "repos/$REPOSITORY/actions/runs/$STUB_RUN_ID/pending_deployments" ]] ||
      return 1
    local expected_environment_id="${STUB_ENV_ID:-901}"
    [[ " $* " == *" -F environment_ids[]=$expected_environment_id "* ]] || {
      echo "approval environment ID was not submitted as an integer field" >&2
      return 1
    }
    [[ " $* " != *" -f environment_ids[]="* ]] || {
      echo "approval environment ID was submitted as a raw string field" >&2
      return 1
    }
    local expected_comment="Copilot CLI exact-run approval: $STUB_OPERATION"
    [[ " $* " == *" -f comment=$expected_comment "* ]] || {
      echo "approval comment did not match the exact operation" >&2
      return 1
    }
    local count=0
    [[ -f "$post_count_file" ]] && count="$(cat "$post_count_file")"
    printf '%s\n' "$((count + 1))" >"$post_count_file"
    if [[
      "${STUB_POST_FAIL:-false}" != "true" ||
        "${STUB_POST_ACCEPTED_AMBIGUOUS:-false}" = "true"
    ]]; then
      printf '%s\t%s\t%s\n' \
        "$STUB_RUN_ID" "$expected_environment_id" "$STUB_OPERATION" \
        >>"$approval_history_file"
    fi
    if [[ "${STUB_POST_FAIL:-false}" = "true" ]]; then
      return 1
    fi
    printf '{}\n'
    return
  fi

  case "$endpoint" in
    "repos/$REPOSITORY/git/ref/heads/master")
      printf '%s\n' "${STUB_MASTER_SHA:-$SHA}"
      ;;
    "repos/$REPOSITORY/commits/$SHA/pulls")
      if [[ "${STUB_HUMAN_PROMOTION:-false}" = "true" ]]; then
        printf '[{"merged_at":"2026-01-01T00:00:00Z","merge_commit_sha":"%s","base":{"ref":"master"},"head":{"ref":"dev"},"labels":[]}]\n' "$SHA"
      else
        printf '[{"merged_at":"2026-01-01T00:00:00Z","merge_commit_sha":"%s","base":{"ref":"master"},"head":{"ref":"dev"},"labels":[{"name":"copilot-cli-managed"}]}]\n' "$SHA"
      fi
      ;;
    "repos/$REPOSITORY/actions/workflows/"*.yml)
      local workflow="${endpoint##*/}"
      local workflow_id workflow_state
      workflow_id="$(workflow_id_for "$workflow")"
      workflow_state="${STUB_WORKFLOW_STATE:-$(approval_state_for "$workflow")}"
      if [[ " $* " == *" --jq .state "* ]]; then
        local state_count=0
        [[ -f "$workflow_state_count_file" ]] &&
          state_count="$(cat "$workflow_state_count_file")"
        state_count=$((state_count + 1))
        printf '%s\n' "$state_count" >"$workflow_state_count_file"
        if [[
          -n "${STUB_CHANGE_STATE_ON_CALL:-}" &&
            "$state_count" -ge "$STUB_CHANGE_STATE_ON_CALL"
        ]]; then
          if [[ "$workflow_state" = "active" ]]; then
            printf '%s\n' disabled_manually
          else
            printf '%s\n' active
          fi
        else
          printf '%s\n' "$workflow_state"
        fi
      else
        printf '{"id":%s,"path":".github/workflows/%s","state":"%s"}\n' \
          "$workflow_id" "$workflow" "$workflow_state"
      fi
      ;;
    "repos/$REPOSITORY/contents/.github/workflows/"*"?ref=$SHA")
      printf '%s\n' "${STUB_API_BLOB:-$BLOB}"
      ;;
    "repos/$REPOSITORY/actions/runs/$STUB_RUN_ID")
      local status="${STUB_RUN_STATUS:-waiting}"
      jq -cn \
        --argjson id "$STUB_RUN_ID" \
        --argjson workflow_id "$STUB_WORKFLOW_ID" \
        --arg path ".github/workflows/$STUB_WORKFLOW" \
        --arg title "$STUB_TITLE" \
        --arg event "$STUB_EVENT" \
        --arg sha "$SHA" \
        --arg repo "$REPOSITORY" \
        --argjson attempt "${STUB_ATTEMPT:-1}" \
        --arg status "$status" \
        --arg conclusion "${STUB_RUN_CONCLUSION:-}" \
        '{
          id:$id,
          workflow_id:$workflow_id,
          path:$path,
          display_title:$title,
          event:$event,
          head_sha:$sha,
          head_branch:"master",
          head_repository:{full_name:$repo},
          run_attempt:$attempt,
          status:$status,
          conclusion:(if $conclusion == "" then null else $conclusion end)
        }'
      ;;
    "repos/$REPOSITORY/actions/runs/${STUB_UPSTREAM_RUN_ID:-__none__}")
      jq -cn \
        --argjson id "$STUB_UPSTREAM_RUN_ID" \
        --argjson workflow_id "$STUB_UPSTREAM_WORKFLOW_ID" \
        --arg path ".github/workflows/$STUB_UPSTREAM_WORKFLOW" \
        --arg title "$STUB_UPSTREAM_TITLE" \
        --arg event "$STUB_UPSTREAM_EVENT" \
        --arg sha "$SHA" \
        --arg repo "$REPOSITORY" \
        --arg conclusion "$STUB_UPSTREAM_CONCLUSION" \
        '{
          id:$id,
          workflow_id:$workflow_id,
          path:$path,
          display_title:$title,
          event:$event,
          head_sha:$sha,
          head_branch:"master",
          head_repository:{full_name:$repo},
          run_attempt:1,
          status:"completed",
          conclusion:$conclusion
        }'
      ;;
    "repos/$REPOSITORY/actions/runs/$STUB_RUN_ID/pending_deployments")
      if [[ "${STUB_NO_PENDING:-false}" = "true" ]]; then
        printf '[]\n'
      else
        jq -cn \
          --arg environment "${STUB_PENDING_ENV:-$STUB_ENV}" \
          --argjson environment_id "${STUB_ENV_ID:-901}" \
          --argjson can_approve "${STUB_CAN_APPROVE:-true}" \
          '[{
            environment:{id:$environment_id,name:$environment},
            current_user_can_approve:$can_approve
          }]'
      fi
      ;;
    "repos/$REPOSITORY/actions/runs/$STUB_RUN_ID/approvals")
      python3 - \
        "$approval_history_file" \
        "$STUB_RUN_ID" \
        "${STUB_ENV:-unknown}" <<'PY'
import json
import pathlib
import sys

path, run_id, environment_name = sys.argv[1:]
reviews = []
for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
    candidate_run_id, environment_id, operation = line.split("\t")
    if candidate_run_id != run_id:
        continue
    reviews.append({
        "comment": f"Copilot CLI exact-run approval: {operation}",
        "environments": [{
            "id": int(environment_id),
            "name": environment_name,
        }],
        "state": "approved",
        "user": {"login": "copilot-test-user"},
    })
print(json.dumps(reviews, separators=(",", ":")))
PY
      ;;
    "repos/$REPOSITORY/actions/runs/$STUB_RUN_ID/jobs?per_page=100")
      if [[ "${STUB_NO_WAITING:-false}" = "true" ]]; then
        printf '{"total_count":1,"jobs":[{"id":%s,"status":"completed"}]}\n' \
          "${STUB_JOB_ID:-1}"
      else
        printf '{"total_count":1,"jobs":[{"id":%s,"status":"waiting"}]}\n' \
          "${STUB_JOB_ID:-1}"
      fi
      ;;
    "repos/$REPOSITORY/actions/runs?status="*)
      if [[
        "${STUB_EXPECT_ACTUAL_MASTER_EXCLUSIVITY:-false}" == "true" &&
          -n "${PROSPECTIVE_PROMOTION_PR:-}"
      ]]; then
        echo "normal approver leaked prospective promotion context" >&2
        return 1
      fi
      printf '{"total_count":0,"workflow_runs":[]}\n'
      ;;
    user)
      printf '%s\n' "copilot-test-user"
      ;;
    *)
      echo "unexpected gh api call: endpoint=$endpoint args=$*" >&2
      return 1
      ;;
  esac
}
export -f git gh workflow_id_for approval_state_for
export ROOT_DIR SHA TARGET_SHA BLOB REPOSITORY post_count_file approval_history_file
export workflow_state_count_file

make_request() {
  local operation="$1"
  local path="$2"
  local policy_file="$tmp_dir/policy-$operation.json"
  "$POLICY" get "$operation" >"$policy_file"
  python3 - "$policy_file" "$path" "$SHA" "$TARGET_SHA" "$REPOSITORY" <<'PY'
import json
import os
import re
import sys

policy_path, output_path, control_sha, historical_sha, repository = sys.argv[1:]
policy = json.load(open(policy_path, encoding="utf-8"))
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
    inputs[name] = control_sha
for name in policy["objectIdOrLiterals"]:
    inputs[name] = "0123456789abcdef01234567"
for name, forbidden in policy["forbiddenInputValues"].items():
    if inputs[name] in forbidden:
        inputs[name] = "approved-test-reason"

subject_sha = None
if policy["subjectInput"]:
    subject_sha = (
        control_sha
        if policy["subjectRelation"] == "current"
        else historical_sha
    )
    inputs[policy["subjectInput"]] = subject_sha
target_sha = None
if policy["targetInput"]:
    target_sha = historical_sha
    inputs[policy["targetInput"]] = target_sha

request = {
    "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
    "repository": repository,
    "operation": policy["operation"],
    "controlSha": control_sha,
    "subjectSha": subject_sha,
    "targetSha": target_sha,
    "inputs": inputs,
}

template_pattern = re.compile(
    r"\{(control_sha|subject_sha|target_sha|input:[A-Za-z0-9_]+)\}"
)
def render(template):
    def replace(match):
        value = match.group(1)
        if value == "control_sha":
            return control_sha
        if value == "subject_sha":
            return subject_sha or ""
        if value == "target_sha":
            return target_sha or ""
        return str(inputs[value.split(":", 1)[1]])
    return template_pattern.sub(replace, template)

for name, template in policy["inputTemplates"].items():
    inputs[name] = render(template)

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(request, handle)
    handle.write("\n")
os.chmod(output_path, 0o600)
PY
}

make_record() {
  local operation="$1"
  local run_id="$2"
  local policy_json workflow workflow_id environment request normalized record title run_json
  local intent_summary capture_path intent_version
  policy_json="$("$POLICY" get "$operation")"
  workflow="$(jq -r '.workflow' <<<"$policy_json")"
  workflow_id="$(workflow_id_for "$workflow")"
  environment="$(jq -r '.environment' <<<"$policy_json")"
  request="$tmp_dir/request-$run_id.json"
  normalized="$tmp_dir/normalized-$run_id.json"
  run_json="$tmp_dir/run-$run_id.json"
  make_request "$operation" "$request"
  "$HELPER" validate-request \
    --request "$request" \
    --policy-json "$policy_json" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --repo-root "$ROOT_DIR" \
    --output "$normalized"
  intent_summary="$(
    "$HELPER" claim-request \
      --normalized "$normalized" \
      --policy-json "$policy_json" \
      --repository "$REPOSITORY" \
      --current-master "$SHA" \
      --workflow-id "$workflow_id" \
      --workflow-blob-sha "$BLOB" \
      --owner-pid "$$" \
      --authority-dir "$authority_dir" \
      --repo-root "$ROOT_DIR"
  )"
  capture_path="$(jq -r '.capturePath' <<<"$intent_summary")"
  intent_version="$(jq -r '.version' <<<"$intent_summary")"
  printf 'https://github.com/%s/actions/runs/%s\n' \
    "$REPOSITORY" "$run_id" >"$capture_path"
  "$HELPER" record-dispatch-status \
    --normalized "$normalized" \
    --policy-json "$policy_json" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --workflow-id "$workflow_id" \
    --workflow-blob-sha "$BLOB" \
    --expected-version "$intent_version" \
    --dispatch-status 0 \
    --authority-dir "$authority_dir" \
    --repo-root "$ROOT_DIR" >/dev/null
  "$HELPER" bind-intent \
    --normalized "$normalized" \
    --policy-json "$policy_json" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --workflow-id "$workflow_id" \
    --workflow-blob-sha "$BLOB" \
    --expected-run-id "$run_id" \
    --authority-dir "$authority_dir" \
    --repo-root "$ROOT_DIR" >/dev/null
  record="$authority_dir/$run_id.json"
  title="$(jq -r '.displayTitle' "$record")"
  jq -cn \
    --argjson id "$run_id" \
    --argjson workflow_id "$workflow_id" \
    --arg path ".github/workflows/$workflow" \
    --arg title "$title" \
    --arg sha "$SHA" \
    --arg repo "$REPOSITORY" \
    '{
      id:$id,
      workflow_id:$workflow_id,
      path:$path,
      display_title:$title,
      event:"workflow_dispatch",
      head_sha:$sha,
      head_branch:"master",
      head_repository:{full_name:$repo},
      run_attempt:1,
      status:"waiting",
      conclusion:null
    }' >"$run_json"
  chmod 600 "$run_json"
  "$HELPER" issue \
    --authority-dir "$authority_dir" \
    --repo-root "$ROOT_DIR" \
    --run-id "$run_id" \
    --run-json "$run_json" \
    --policy-json "$policy_json" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --workflow-id "$workflow_id" \
    --workflow-blob-sha "$BLOB"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$operation" "$run_id" "$workflow" "$workflow_id" "$title" "$environment" \
    >>"$records_file"
}

load_record_stub() {
  local operation="$1"
  local row
  row="$(awk -F '\t' -v operation="$operation" '$1 == operation { print; exit }' "$records_file")"
  [[ -n "$row" ]] || {
    echo "missing test record for $operation" >&2
    exit 1
  }
  IFS=$'\t' read -r \
    STUB_OPERATION STUB_RUN_ID STUB_WORKFLOW STUB_WORKFLOW_ID STUB_TITLE STUB_ENV \
    <<<"$row"
  STUB_EVENT=workflow_dispatch
  export STUB_OPERATION STUB_RUN_ID STUB_WORKFLOW STUB_WORKFLOW_ID STUB_TITLE STUB_ENV STUB_EVENT
  unset STUB_ATTEMPT STUB_PENDING_ENV STUB_CAN_APPROVE STUB_POST_FAIL
  unset STUB_POST_ACCEPTED_AMBIGUOUS STUB_NO_PENDING STUB_NO_WAITING
  unset STUB_RUN_STATUS STUB_RUN_CONCLUSION
  unset STUB_API_BLOB STUB_JOB_ID STUB_WORKFLOW_STATE
  unset STUB_CHANGE_STATE_ON_CALL
  unset STUB_UPSTREAM_RUN_ID STUB_UPSTREAM_WORKFLOW STUB_UPSTREAM_WORKFLOW_ID
  unset STUB_UPSTREAM_TITLE STUB_UPSTREAM_EVENT STUB_UPSTREAM_CONCLUSION
}

run_approver() {
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION="$STUB_OPERATION" \
    "$APPROVER" "$@"
}

typed_request="$tmp_dir/typed-request.json"
typed_normalized="$tmp_dir/typed-normalized.json"
typed_inputs="$tmp_dir/typed-inputs.json"
make_request oci-migrate "$typed_request"
"$HELPER" validate-request \
  --request "$typed_request" \
  --policy-json "$("$POLICY" get oci-migrate)" \
  --repository "$REPOSITORY" \
  --current-master "$SHA" \
  --repo-root "$ROOT_DIR" \
  --output "$typed_normalized"
"$HELPER" write-inputs \
  --normalized "$typed_normalized" \
  --output "$typed_inputs" \
  --repo-root "$ROOT_DIR"
jq -e '
  .inputs.replace_oci_data == true and
  .inputs.recover_closed_oci == false and
  .dispatchInputs.replace_oci_data == "true" and
  .dispatchInputs.recover_closed_oci == "false"
' "$typed_normalized" >/dev/null
jq -e '
  .replace_oci_data == "true" and
  .recover_closed_oci == "false"
' "$typed_inputs" >/dev/null
typed_hash="$(python3 - "$typed_inputs" <<'PY'
import hashlib
import sys

print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
[[ "$(jq -r '.inputHash' "$typed_normalized")" = "$typed_hash" ]]
rm -f "$typed_normalized"

python3 - "$typed_request" <<'PY'
import json
import os
import sys

path = sys.argv[1]
request = json.load(open(path, encoding="utf-8"))
request["inputs"]["replace_oci_data"] = "true"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(request, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
if "$HELPER" validate-request \
  --request "$typed_request" \
  --policy-json "$("$POLICY" get oci-migrate)" \
  --repository "$REPOSITORY" \
  --current-master "$SHA" \
  --repo-root "$ROOT_DIR" \
  --output "$typed_normalized" \
  >"$output_file" 2>"$error_file"; then
  echo "string boolean input unexpectedly passed" >&2
  exit 1
fi
grep -qF "must be a boolean" "$error_file"

run_id=8000
while IFS= read -r operation; do
  run_id=$((run_id + 1))
  make_record "$operation" "$run_id"
  load_record_stub "$operation"
  run_approver "$STUB_RUN_ID" >"$output_file"
  grep -qF "status=ELIGIBLE" "$output_file"
done < <(
  "$POLICY" all |
    jq -r '.[] | select(.authority == "dispatch-record") | .operation'
)

load_record_stub production-deploy
PROSPECTIVE_PROMOTION_PR=224 STUB_EXPECT_ACTUAL_MASTER_EXCLUSIVITY=true \
  run_approver "$STUB_RUN_ID" >"$output_file"
grep -qF "status=ELIGIBLE" "$output_file"
unset STUB_EXPECT_ACTUAL_MASTER_EXCLUSIVITY

load_record_stub oci-production-deploy
if STUB_WORKFLOW_STATE=active \
  run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "enabled dormant workflow unexpectedly passed approval validation" >&2
  exit 1
fi
grep -qF "required approval state" "$error_file"

load_record_stub production-deploy
if STUB_WORKFLOW_STATE=disabled_manually \
  run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "disabled active workflow unexpectedly passed approval validation" >&2
  exit 1
fi
grep -qF "required approval state" "$error_file"

load_record_stub production-deploy
rm -f "$workflow_state_count_file"
post_count_before=0
[[ -f "$post_count_file" ]] && post_count_before="$(cat "$post_count_file")"
if STUB_CHANGE_STATE_ON_CALL=4 COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "workflow state change after approval claim unexpectedly passed" >&2
  exit 1
fi
grep -qF "required approval state" "$error_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
observed_post_count=0
[[ -f "$post_count_file" ]] && observed_post_count="$(cat "$post_count_file")"
[[ "$observed_post_count" = "$post_count_before" ]]
rm -f "$workflow_state_count_file"

load_record_stub production-deploy
if STUB_DIRTY_CHECKOUT=true \
  run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "untracked approval checkout unexpectedly passed" >&2
  exit 1
fi
grep -qF "approval checkout is not clean" "$error_file"

load_record_stub oci-production-deploy
STUB_ENV_ID=901 COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file"
grep -qF "status=APPROVED" "$output_file"
jq -e '
  .state == "consumed" and
  (.approvals | length) == 1 and
  .approvals[0].environmentId == 901
' "$authority_dir/$STUB_RUN_ID.json" >/dev/null

STUB_ENV_ID=901 STUB_JOB_ID=2 COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file"
jq -e '
  .state == "consumed" and
  (.approvals | length) == 2 and
  .approvals[1].environmentId == 901 and
  .approvals[0].gateKey != .approvals[1].gateKey
' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
if STUB_ENV_ID=901 STUB_JOB_ID=2 COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "reused exact approval receipt unexpectedly passed" >&2
  exit 1
fi
grep -qF "already approved this exact gate" "$error_file"

load_record_stub production-rollback
if STUB_ENV_ID=903 STUB_POST_FAIL=true COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "ambiguous GitHub approval unexpectedly passed" >&2
  exit 1
fi
grep -qF "authority remains inflight" "$error_file"
jq -e '.state == "inflight"' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "inflight authority unexpectedly replayed" >&2
  exit 1
fi
grep -qF "not issued or safely consumed" "$error_file"
python3 - "$authority_dir/$STUB_RUN_ID.json" <<'PY'
import json
import os
import sys

path = sys.argv[1]
record = json.load(open(path, encoding="utf-8"))
record["createdAt"] = "2000-01-01T00:00:00Z"
record["expiresAt"] = "2000-01-02T00:00:00Z"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(record, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
if STUB_ENV_ID=903 STUB_NO_PENDING=true COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --reconcile >"$output_file" 2>"$error_file"; then
  echo "missing pending deployment with unchanged waiting job unexpectedly reconciled" >&2
  exit 1
fi
grep -qF "same waiting job without a pending deployment" "$error_file"
jq -e '.state == "inflight"' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
if STUB_ENV_ID=903 STUB_NO_PENDING=true STUB_NO_WAITING=true \
  STUB_RUN_STATUS=completed STUB_RUN_CONCLUSION=cancelled \
  COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --reconcile >"$output_file" 2>"$error_file"; then
  echo "terminal run without approval history unexpectedly reconciled" >&2
  exit 1
fi
grep -qF "authority stays inflight" "$error_file"
jq -e '
  .state == "inflight" and
  .inflightApproval != null and
  (.approvals | length) == 0
' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
STUB_ENV_ID=903 COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --reconcile >"$output_file"
grep -qF "status=RETRY_READY" "$output_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
python3 - "$authority_dir/$STUB_RUN_ID.json" "$SHA" <<'PY'
import hashlib
import json
import os
import sys

path, sha = sys.argv[1:]
record = json.load(open(path, encoding="utf-8"))
record["targetSha"] = sha
record["inputs"]["target_sha"] = sha
record["displayTitle"] = f"rollback {sha}"
canonical = json.dumps(
    record["inputs"],
    ensure_ascii=True,
    sort_keys=True,
    separators=(",", ":"),
).encode("utf-8")
record["inputHash"] = hashlib.sha256(canonical).hexdigest()
with open(path, "w", encoding="utf-8") as handle:
    json.dump(record, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "non-historical rollback target unexpectedly passed" >&2
  exit 1
fi
grep -qF "target SHA must be historical" "$error_file"

load_record_stub oci-live-betting-disable
chmod 644 "$authority_dir/$STUB_RUN_ID.json"
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "unsafe authority permissions unexpectedly passed" >&2
  exit 1
fi
grep -qF "mode 0600" "$error_file"
chmod 600 "$authority_dir/$STUB_RUN_ID.json"
ln "$authority_dir/$STUB_RUN_ID.json" "$tmp_dir/record-hardlink.json"
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "hard-linked authority unexpectedly passed" >&2
  exit 1
fi
grep -qF "must not have hard links" "$error_file"
rm "$tmp_dir/record-hardlink.json"
mv "$authority_dir/$STUB_RUN_ID.json" "$tmp_dir/real-authority-record.json"
ln -s "$tmp_dir/real-authority-record.json" "$authority_dir/$STUB_RUN_ID.json"
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "symlink authority unexpectedly passed" >&2
  exit 1
fi
grep -qF "regular non-symlink" "$error_file"
rm "$authority_dir/$STUB_RUN_ID.json"
mv "$tmp_dir/real-authority-record.json" "$authority_dir/$STUB_RUN_ID.json"
interrupted_record_link="$authority_dir/.$STUB_RUN_ID.json.interrupted"
ln "$authority_dir/$STUB_RUN_ID.json" "$interrupted_record_link"
run_approver "$STUB_RUN_ID" >"$output_file"
grep -qF "status=ELIGIBLE" "$output_file"
[[ ! -e "$interrupted_record_link" ]]

load_record_stub oci-live-betting-activate
python3 - "$authority_dir/$STUB_RUN_ID.json" <<'PY'
import json
import os
import sys

path = sys.argv[1]
record = json.load(open(path, encoding="utf-8"))
record["inputs"]["build_run_id"] = "999"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(record, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "altered record input unexpectedly passed" >&2
  exit 1
fi
grep -qF "input hash mismatch" "$error_file"

load_record_stub oci-capacity-acquire
STUB_EVENT=schedule
export STUB_EVENT
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "scheduled run unexpectedly received CLI authority" >&2
  exit 1
fi
grep -qF "workflow run mismatch: event" "$error_file"

load_record_stub production-deploy
STUB_ATTEMPT=2
export STUB_ATTEMPT
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "rerun unexpectedly received CLI authority" >&2
  exit 1
fi
grep -qF "run attempt" "$error_file"

load_record_stub production-deploy
STUB_PENDING_ENV=wrong-environment
export STUB_PENDING_ENV
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "wrong pending environment unexpectedly passed" >&2
  exit 1
fi
grep -qF "expected exactly one approvable pending environment" "$error_file"

load_record_stub oci-live-betting-disable
STUB_TITLE="wrong title"
export STUB_TITLE
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "wrong run title unexpectedly passed" >&2
  exit 1
fi
grep -qF "display title" "$error_file"

load_record_stub oci-live-data-apply-backfills
STUB_TITLE="oci-live-data-rollout"
export STUB_TITLE
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "generic-title stale data ghost unexpectedly received CLI approval" >&2
  exit 1
fi
grep -qF "display title" "$error_file"

load_record_stub oci-live-data-dry-run
STUB_API_BLOB="3333333333333333333333333333333333333333"
export STUB_API_BLOB
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "workflow blob mismatch unexpectedly passed" >&2
  exit 1
fi
grep -qF "local and GitHub workflow blobs differ" "$error_file"

load_record_stub production-deploy
if STUB_MASTER_SHA="$TARGET_SHA" \
  run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "stale current-master control unexpectedly passed" >&2
  exit 1
fi
grep -qF "checkout at exact current master" "$error_file"

load_record_stub production-deploy
STUB_RUN_ID=8999
STUB_TITLE="deploy $SHA"
export STUB_RUN_ID STUB_TITLE
if run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "human dispatch without a record unexpectedly passed" >&2
  exit 1
fi
grep -qF "authority record does not exist" "$error_file"

STUB_OPERATION=production-build
STUB_RUN_ID=9001
STUB_WORKFLOW=production-build.yml
STUB_WORKFLOW_ID="$(workflow_id_for "$STUB_WORKFLOW")"
STUB_TITLE="promote current master"
STUB_EVENT=push
STUB_ENV=production-emergency
export STUB_OPERATION STUB_RUN_ID STUB_WORKFLOW STUB_WORKFLOW_ID STUB_TITLE STUB_EVENT STUB_ENV
COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
EXPECTED_OPERATION=production-build \
EXPECTED_CONTROL_SHA="$SHA" \
  "$APPROVER" "$STUB_RUN_ID" >"$output_file"
grep -qF "authority=promotion" "$output_file"
jq -e '.state == "issued" and .operation == "production-build"' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
post_count_before="$(cat "$post_count_file")"
if STUB_POST_FAIL=true COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION=production-build \
  EXPECTED_CONTROL_SHA="$SHA" \
    "$APPROVER" "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "ambiguous promotion approval unexpectedly passed" >&2
  exit 1
fi
grep -qF "authority remains inflight" "$error_file"
jq -e '.state == "inflight"' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
[[ "$(cat "$post_count_file")" = "$((post_count_before + 1))" ]]
if COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION=production-build \
  EXPECTED_CONTROL_SHA="$SHA" \
    "$APPROVER" "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "inflight promotion approval unexpectedly replayed" >&2
  exit 1
fi
grep -qF "automatic authority record is not issued or safely consumed" "$error_file"
[[ "$(cat "$post_count_file")" = "$((post_count_before + 1))" ]]
COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION=production-build \
  EXPECTED_CONTROL_SHA="$SHA" \
    "$APPROVER" "$STUB_RUN_ID" --reconcile >"$output_file"
grep -qF "status=RETRY_READY" "$output_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null

if STUB_HUMAN_PROMOTION=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION=production-build \
  EXPECTED_CONTROL_SHA="$SHA" \
    "$APPROVER" "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "human master promotion unexpectedly passed" >&2
  exit 1
fi
grep -qF "not bound to exactly one CLI-managed dev promotion" "$error_file"

STUB_OPERATION=oci-production-build
STUB_RUN_ID=9101
STUB_WORKFLOW=oci-production-build.yml
STUB_WORKFLOW_ID="$(workflow_id_for "$STUB_WORKFLOW")"
STUB_EVENT=workflow_run
STUB_ENV=oci-build
STUB_UPSTREAM_RUN_ID=9100
STUB_UPSTREAM_WORKFLOW=production-build.yml
STUB_UPSTREAM_WORKFLOW_ID="$(workflow_id_for "$STUB_UPSTREAM_WORKFLOW")"
STUB_UPSTREAM_TITLE="promote current master"
STUB_UPSTREAM_EVENT=push
STUB_UPSTREAM_CONCLUSION=success
STUB_TITLE="oci-build $SHA upstream-$STUB_UPSTREAM_RUN_ID"
export STUB_OPERATION STUB_RUN_ID STUB_WORKFLOW STUB_WORKFLOW_ID STUB_EVENT STUB_ENV
export STUB_UPSTREAM_RUN_ID STUB_UPSTREAM_WORKFLOW STUB_UPSTREAM_WORKFLOW_ID
export STUB_UPSTREAM_TITLE STUB_UPSTREAM_EVENT STUB_UPSTREAM_CONCLUSION STUB_TITLE
COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
EXPECTED_OPERATION="$STUB_OPERATION" \
EXPECTED_CONTROL_SHA="$SHA" \
EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
  "$APPROVER" "$STUB_RUN_ID" >"$output_file"
grep -qF "authority=promotion-upstream" "$output_file"
jq -e '.state == "issued" and .operation == "oci-production-build"' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
post_count_before="$(cat "$post_count_file")"
if STUB_POST_FAIL=true STUB_POST_ACCEPTED_AMBIGUOUS=true \
  COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION="$STUB_OPERATION" \
  EXPECTED_CONTROL_SHA="$SHA" \
  EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
    "$APPROVER" "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "ambiguous promotion-upstream approval unexpectedly passed" >&2
  exit 1
fi
grep -qF "authority remains inflight" "$error_file"
jq -e '.state == "inflight"' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
[[ "$(cat "$post_count_file")" = "$((post_count_before + 1))" ]]
if COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION="$STUB_OPERATION" \
  EXPECTED_CONTROL_SHA="$SHA" \
  EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
    "$APPROVER" "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "inflight promotion-upstream approval unexpectedly replayed" >&2
  exit 1
fi
grep -qF "automatic authority record is not issued or safely consumed" "$error_file"
[[ "$(cat "$post_count_file")" = "$((post_count_before + 1))" ]]
STUB_NO_PENDING=true STUB_NO_WAITING=true \
  STUB_RUN_STATUS=completed STUB_RUN_CONCLUSION=failure \
  COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION="$STUB_OPERATION" \
  EXPECTED_CONTROL_SHA="$SHA" \
  EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
    "$APPROVER" "$STUB_RUN_ID" --reconcile >"$output_file"
grep -qF "status=RECONCILED_CONSUMED" "$output_file"
jq -e '
  .state == "consumed" and
  .inflightApproval == null and
  (.approvals | length) == 1
' "$authority_dir/$STUB_RUN_ID.json" >/dev/null

load_record_stub ghcr-package-repair-build
ghcr_authority_run_id="$STUB_RUN_ID"
ghcr_authority_title="$STUB_TITLE"
STUB_ENV_ID=9201 COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file"
STUB_OPERATION=oci-production-build-repair
STUB_RUN_ID=9202
STUB_WORKFLOW=oci-production-build.yml
STUB_WORKFLOW_ID="$(workflow_id_for "$STUB_WORKFLOW")"
STUB_EVENT=workflow_run
STUB_ENV=oci-build
STUB_UPSTREAM_RUN_ID="$ghcr_authority_run_id"
STUB_UPSTREAM_WORKFLOW=ghcr-package-management.yml
STUB_UPSTREAM_WORKFLOW_ID="$(workflow_id_for "$STUB_UPSTREAM_WORKFLOW")"
STUB_UPSTREAM_TITLE="$ghcr_authority_title"
STUB_UPSTREAM_EVENT=workflow_dispatch
STUB_UPSTREAM_CONCLUSION=success
STUB_TITLE="oci-build $SHA repair-$STUB_UPSTREAM_RUN_ID"
export STUB_OPERATION STUB_RUN_ID STUB_WORKFLOW STUB_WORKFLOW_ID STUB_EVENT STUB_ENV
export STUB_UPSTREAM_RUN_ID STUB_UPSTREAM_WORKFLOW STUB_UPSTREAM_WORKFLOW_ID
export STUB_UPSTREAM_TITLE STUB_UPSTREAM_EVENT STUB_UPSTREAM_CONCLUSION STUB_TITLE
COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
EXPECTED_OPERATION="$STUB_OPERATION" \
EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
  "$APPROVER" "$STUB_RUN_ID" >"$output_file"
grep -qF "authority=record-upstream" "$output_file"

load_record_stub oci-migrate
migration_authority_run_id="$STUB_RUN_ID"
migration_authority_title="$STUB_TITLE"
STUB_ENV_ID=9301 COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file"
STUB_OPERATION=oci-migration-recovery-automatic
STUB_RUN_ID=9302
STUB_WORKFLOW=oci-migration-recovery.yml
STUB_WORKFLOW_ID="$(workflow_id_for "$STUB_WORKFLOW")"
STUB_EVENT=workflow_run
STUB_ENV=azure-migration-recovery
STUB_UPSTREAM_RUN_ID="$migration_authority_run_id"
STUB_UPSTREAM_WORKFLOW=oci-migrate.yml
STUB_UPSTREAM_WORKFLOW_ID="$(workflow_id_for "$STUB_UPSTREAM_WORKFLOW")"
STUB_UPSTREAM_TITLE="$migration_authority_title"
STUB_UPSTREAM_EVENT=workflow_dispatch
STUB_UPSTREAM_CONCLUSION=failure
STUB_TITLE="azure migration recovery $STUB_UPSTREAM_RUN_ID"
export STUB_OPERATION STUB_RUN_ID STUB_WORKFLOW STUB_WORKFLOW_ID STUB_EVENT STUB_ENV
export STUB_UPSTREAM_RUN_ID STUB_UPSTREAM_WORKFLOW STUB_UPSTREAM_WORKFLOW_ID
export STUB_UPSTREAM_TITLE STUB_UPSTREAM_EVENT STUB_UPSTREAM_CONCLUSION STUB_TITLE
COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
EXPECTED_OPERATION="$STUB_OPERATION" \
EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
  "$APPROVER" "$STUB_RUN_ID" >"$output_file"
grep -qF "authority=record-upstream" "$output_file"
first_recovery_run_id="$STUB_RUN_ID"
STUB_ENV_ID=9401 COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION="$STUB_OPERATION" \
  EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
    "$APPROVER" "$STUB_RUN_ID" --approve >"$output_file"
second_recovery_run_id=9303
STUB_RUN_ID="$second_recovery_run_id"
export STUB_RUN_ID
if STUB_ENV_ID=9401 STUB_POST_FAIL=true COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION="$STUB_OPERATION" \
  EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
    "$APPROVER" "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "ambiguous derived approval unexpectedly passed" >&2
  exit 1
fi
jq -e \
  --argjson run_id "$second_recovery_run_id" \
  '.state == "inflight" and .inflightApproval.runId == $run_id' \
  "$authority_dir/$migration_authority_run_id.json" >/dev/null
STUB_RUN_ID="$first_recovery_run_id"
export STUB_RUN_ID
if STUB_ENV_ID=9401 COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION="$STUB_OPERATION" \
  EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
    "$APPROVER" "$STUB_RUN_ID" --reconcile >"$output_file" 2>"$error_file"; then
  echo "wrong downstream run unexpectedly reconciled inflight authority" >&2
  exit 1
fi
grep -qF "inflight approval run ID does not match" "$error_file"
jq -e \
  --argjson run_id "$second_recovery_run_id" \
  '.state == "inflight" and .inflightApproval.runId == $run_id' \
  "$authority_dir/$migration_authority_run_id.json" >/dev/null
STUB_RUN_ID="$second_recovery_run_id"
export STUB_RUN_ID
STUB_ENV_ID=9401 COPILOT_CLI_AUTO_APPROVE=true \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  EXPECTED_OPERATION="$STUB_OPERATION" \
  EXPECTED_UPSTREAM_RUN_ID="$STUB_UPSTREAM_RUN_ID" \
    "$APPROVER" "$STUB_RUN_ID" --reconcile >"$output_file"
grep -qF "status=RETRY_READY" "$output_file"
jq -e \
  --argjson run_id "$second_recovery_run_id" \
  '.state == "consumed" and
   .inflightApproval == null and
   (.approvals | all(.runId != $run_id))' \
  "$authority_dir/$migration_authority_run_id.json" >/dev/null

stale_lock_run_id=9998
"$HELPER" acquire-lock \
  --authority-dir "$authority_dir" \
  --repo-root "$ROOT_DIR" \
  --run-id "$stale_lock_run_id" \
  --owner-pid 2147483647 \
  >"$output_file"
if "$HELPER" acquire-lock \
  --authority-dir "$authority_dir" \
  --repo-root "$ROOT_DIR" \
  --run-id "$stale_lock_run_id" \
  --owner-pid "$$" \
  >"$output_file" 2>"$error_file"; then
  echo "stale authority lock unexpectedly auto-reclaimed" >&2
  exit 1
fi
grep -qF "clear the exact stale lock" "$error_file"
"$HELPER" clear-stale-lock \
  --authority-dir "$authority_dir" \
  --repo-root "$ROOT_DIR" \
  --run-id "$stale_lock_run_id"
fresh_lock_token="$(
  "$HELPER" acquire-lock \
    --authority-dir "$authority_dir" \
    --repo-root "$ROOT_DIR" \
    --run-id "$stale_lock_run_id" \
    --owner-pid "$$"
)"
interrupted_lock_link="$authority_dir/.$stale_lock_run_id.lock.interrupted"
ln "$authority_dir/$stale_lock_run_id.lock" "$interrupted_lock_link"
if "$HELPER" acquire-lock \
  --authority-dir "$authority_dir" \
  --repo-root "$ROOT_DIR" \
  --run-id "$stale_lock_run_id" \
  --owner-pid "$$" \
  >"$output_file" 2>"$error_file"; then
  echo "live authority lock unexpectedly replaced after link recovery" >&2
  exit 1
fi
grep -qF "held by a live process" "$error_file"
[[ ! -e "$interrupted_lock_link" ]]
if "$HELPER" acquire-lock \
  --authority-dir "$authority_dir" \
  --repo-root "$ROOT_DIR" \
  --run-id "$stale_lock_run_id" \
  --owner-pid "$$" \
  >"$output_file" 2>"$error_file"; then
  echo "live authority lock unexpectedly replaced" >&2
  exit 1
fi
grep -qF "held by a live process" "$error_file"
"$HELPER" release-lock \
  --authority-dir "$authority_dir" \
  --repo-root "$ROOT_DIR" \
  --run-id "$stale_lock_run_id" \
  --token "$fresh_lock_token"

echo "copilot_cli_run_approval_tests=PASS"
