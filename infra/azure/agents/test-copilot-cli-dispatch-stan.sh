#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DISPATCHER="$ROOT_DIR/infra/azure/agents/copilot-cli-dispatch-stan.sh"
POLICY="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
HELPER="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"
SHA="1111111111111111111111111111111111111111"
ADVANCED_SHA="3333333333333333333333333333333333333333"
BLOB="2222222222222222222222222222222222222222"
WORKFLOW_ID="301"
REPOSITORY="example/repo"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-dispatch-test.XXXXXX")"
chmod 700 "$tmp_dir"
request_file="$tmp_dir/request.json"
authority_dir="$tmp_dir/authority"
dispatch_count_file="$tmp_dir/dispatch-count"
captured_inputs_file="$tmp_dir/captured-inputs.json"
workflow_state_count_file="$tmp_dir/workflow-state-count"
output_file="$tmp_dir/output"
error_file="$tmp_dir/error"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

write_request() {
  local mode="${1:-valid}"
  python3 - "$request_file" "$SHA" "$REPOSITORY" "$mode" <<'PY'
import json
import os
import sys

path, sha, repository, mode = sys.argv[1:]
request = {
    "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
    "repository": repository,
    "operation": "production-deploy",
    "controlSha": sha,
    "subjectSha": sha,
    "targetSha": None,
    "inputs": {
        "approved_sha": sha,
        "build_run_id": "42",
    },
}
if mode == "unknown-input":
    request["inputs"]["extra"] = "no"
elif mode == "alternate":
    request["inputs"]["build_run_id"] = "43"
elif mode == "crash":
    request["inputs"]["build_run_id"] = "44"
elif mode == "inert":
    request["inputs"]["build_run_id"] = "45"
elif mode == "delayed":
    request["inputs"]["build_run_id"] = "46"
elif mode == "url-less":
    request["inputs"]["build_run_id"] = "47"
elif mode == "url-less-nonzero":
    request["inputs"]["build_run_id"] = "48"
elif mode == "blocked":
    request["inputs"]["build_run_id"] = "49"
elif mode == "state-race":
    request["inputs"]["build_run_id"] = "50"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(request, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
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
    "cat-file -e")
      return 0
      ;;
    "fetch --quiet")
      return 0
      ;;
    "merge-base --is-ancestor")
      return 0
      ;;
    *)
      if [[ "$1" = "rev-parse" && "$2" = "$SHA:.github/workflows/production-deploy.yml" ]]; then
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
  if [[ "$1" = "workflow" && "$2" = "run" ]]; then
    local count=0
    [[ -f "$dispatch_count_file" ]] && count="$(cat "$dispatch_count_file")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$dispatch_count_file"
    python3 -c 'import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data)' \
      >"$captured_inputs_file"
    if [[ "${STUB_DISPATCH_NO_URL:-false}" != "true" ]]; then
      printf 'https://github.com/%s/actions/runs/%s\n' \
        "$REPOSITORY" "${STUB_RUN_ID:-7001}"
      if [[ "${STUB_KILL_AFTER_URL:-false}" = "true" ]]; then
        kill -9 "$BASHPID"
      fi
    fi
    return "${STUB_DISPATCH_STATUS:-0}"
  fi
  if [[ "$1" != "api" ]]; then
    echo "unexpected gh call: $*" >&2
    return 1
  fi

  local endpoint="$2"
  case "$endpoint" in
    "repos/$REPOSITORY/git/ref/heads/master")
      printf '%s\n' "$SHA"
      ;;
    "repos/$REPOSITORY/actions/workflows/production-deploy.yml")
      if [[ "$*" == *"--jq .state"* ]]; then
        local state_count=0
        [[ -f "$workflow_state_count_file" ]] &&
          state_count="$(cat "$workflow_state_count_file")"
        state_count=$((state_count + 1))
        printf '%s\n' "$state_count" >"$workflow_state_count_file"
        if [[
          -n "${STUB_DISABLE_ON_STATE_CALL:-}" &&
            "$state_count" -ge "$STUB_DISABLE_ON_STATE_CALL"
        ]]; then
          printf '%s\n' disabled_manually
        else
          printf '%s\n' "${STUB_WORKFLOW_STATE:-active}"
        fi
      elif [[ "$*" == *"--jq"* ]]; then
        printf '%s\t%s\t%s\n' \
          "$WORKFLOW_ID" ".github/workflows/production-deploy.yml" \
          "${STUB_WORKFLOW_STATE:-active}"
      else
        printf '{"id":%s,"path":".github/workflows/production-deploy.yml","state":"%s"}\n' \
          "$WORKFLOW_ID" "${STUB_WORKFLOW_STATE:-active}"
      fi
      ;;
    "repos/$REPOSITORY/contents/.github/workflows/production-deploy.yml?ref=$SHA")
      printf '%s\n' "$BLOB"
      ;;
    "repos/$REPOSITORY/commits/$SHA/pulls")
      if [[ "${STUB_HUMAN_PROMOTION:-false}" = "true" ]]; then
        printf '[{"merged_at":"2026-01-01T00:00:00Z","merge_commit_sha":"%s","base":{"ref":"master"},"head":{"ref":"dev"},"labels":[]}]\n' "$SHA"
      else
        printf '[{"merged_at":"2026-01-01T00:00:00Z","merge_commit_sha":"%s","base":{"ref":"master"},"head":{"ref":"dev"},"labels":[{"name":"copilot-cli-managed"}]}]\n' "$SHA"
      fi
      ;;
    "repos/$REPOSITORY/actions/runs/"*"/jobs?per_page=100")
      if [[ "${STUB_RUN_JOBLESS:-false}" = "true" ]]; then
        printf '{"total_count":0,"jobs":[]}\n'
      else
        printf '{"total_count":1,"jobs":[{"id":1,"status":"completed"}]}\n'
      fi
      ;;
    "repos/$REPOSITORY/actions/runs/"*"/pending_deployments")
      printf '[]\n'
      ;;
    "repos/$REPOSITORY/actions/runs/"*)
      if [[ "${STUB_MATERIALIZE_FAIL:-false}" = "true" ]]; then
        return 1
      fi
      local run_id
      run_id="${endpoint#repos/$REPOSITORY/actions/runs/}"
      if [[ "${STUB_RUN_COMPLETED:-false}" = "true" ]]; then
        printf '{"id":%s,"workflow_id":%s,"path":".github/workflows/production-deploy.yml","display_title":"deploy %s","event":"workflow_dispatch","head_sha":"%s","head_branch":"master","head_repository":{"full_name":"%s"},"run_attempt":1,"status":"completed","conclusion":"failure"}\n' \
          "$run_id" "$WORKFLOW_ID" "$SHA" "$SHA" "$REPOSITORY"
      else
        printf '{"id":%s,"workflow_id":%s,"path":".github/workflows/production-deploy.yml","display_title":"deploy %s","event":"workflow_dispatch","head_sha":"%s","head_branch":"master","head_repository":{"full_name":"%s"},"run_attempt":1,"status":"waiting","conclusion":null}\n' \
          "$run_id" "$WORKFLOW_ID" "$SHA" "$SHA" "$REPOSITORY"
      fi
      ;;
    "repos/$REPOSITORY/actions/runs?status="*)
      if [[ "${STUB_EXPECT_ACTUAL_MASTER_EXCLUSIVITY:-false}" == "true" ]]; then
        if [[ -n "${PROSPECTIVE_PROMOTION_PR:-}" ]]; then
          echo "normal dispatcher leaked prospective promotion context" >&2
          return 1
        fi
        if [[ -n "${EXCLUDE_RUN_ID:-}" ]]; then
          echo "normal dispatcher leaked an exclusion bypass" >&2
          return 1
        fi
      fi
      printf '{"total_count":0,"workflow_runs":[]}\n'
      ;;
    *)
      echo "unexpected gh api call: $*" >&2
      return 1
      ;;
  esac
}
export -f git gh
export ROOT_DIR SHA BLOB WORKFLOW_ID REPOSITORY
export dispatch_count_file captured_inputs_file workflow_state_count_file

run_dispatcher() {
  TMPDIR="$tmp_dir" \
  COPILOT_CLI_AUTHORITY_DIR="${TEST_AUTHORITY_DIR:-$authority_dir}" \
  COPILOT_CLI_MATERIALIZATION_ATTEMPTS=2 \
  COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS=0 \
    "$DISPATCHER" "$@"
}

write_live_data_request() {
  local path="$1"
  local control_sha="$2"
  python3 - "$path" "$control_sha" "$REPOSITORY" <<'PY'
import json
import os
import sys

path, control_sha, repository = sys.argv[1:]
request = {
    "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
    "repository": repository,
    "operation": "oci-live-data-apply-backfills",
    "controlSha": control_sha,
    "subjectSha": control_sha,
    "targetSha": None,
    "inputs": {
        "approved_sha": control_sha,
        "build_run_id": "42",
        "infrastructure_run_id": "43",
        "phase": "apply-backfills",
        "prerequisite_run_id": "44",
        "baseline_recovery_run_id": "0",
        "failed_deploy_run_id": "0",
        "failed_activation_run_id": "0",
        "failed_activation_user_id": "0",
        "confirmation": "APPLY LIVE BACKFILLS EXACT SHA",
    },
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(request, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
}

write_unmaterialized_evidence() {
  local directory="$1"
  local run_id="$2"
  local mode="${3:-valid}"
  python3 - \
    "$ROOT_DIR/.github/workflows/oci-live-data-rollout.yml" \
    "$directory" \
    "$run_id" \
    "$SHA" \
    "$ADVANCED_SHA" \
    "$REPOSITORY" \
    "$mode" <<'PY'
import base64
import hashlib
import json
import os
from pathlib import Path
import sys

source_path, directory, run_id, old_sha, master_sha, repository, mode = sys.argv[1:]
directory_path = Path(directory)
source = Path(source_path).read_bytes()
blob_sha = hashlib.sha1(
    f"blob {len(source)}\0".encode("utf-8") + source
).hexdigest()
title = "oci-live-data-rollout"
if mode == "rendered-title":
    title = f"oci-live-data apply-backfills {old_sha}"
run = {
    "id": int(run_id),
    "workflow_id": 313,
    "path": ".github/workflows/oci-live-data-rollout.yml",
    "display_title": title,
    "event": "workflow_dispatch",
    "head_sha": old_sha,
    "head_branch": "master",
    "head_repository": {"full_name": repository},
    "run_attempt": 1,
    "status": "queued",
    "conclusion": None,
    "created_at": "1970-01-01T00:00:00Z",
    "run_started_at": "1970-01-01T00:00:00Z",
    "updated_at": "1970-01-01T00:00:00Z",
    "html_url": f"https://github.com/{repository}/actions/runs/{run_id}",
}
if mode == "wrong-identity":
    run["workflow_id"] = 314
elif mode == "wrong-run-id":
    run["id"] += 1
elif mode == "wrong-path":
    run["path"] = ".github/workflows/oci-production-deploy.yml"
elif mode == "wrong-event":
    run["event"] = "push"
elif mode == "wrong-head":
    run["head_sha"] = "d" * 40
elif mode == "wrong-branch":
    run["head_branch"] = "dev"
elif mode == "wrong-attempt":
    run["run_attempt"] = 2
elif mode == "wrong-repository":
    run["head_repository"] = {"full_name": "another/repository"}
jobs = {"total_count": 0, "jobs": []}
if mode == "jobs":
    jobs = {"total_count": 1, "jobs": [{"id": 1}]}
pending = [] if mode != "pending" else [{"environment": {"id": 1}}]
artifacts = {"total_count": 0, "artifacts": []}
if mode == "artifacts":
    artifacts = {"total_count": 1, "artifacts": [{"id": 1}]}
compare = {
    "status": "ahead",
    "ahead_by": 1,
    "behind_by": 0,
    "total_commits": 1,
    "base_commit": {"sha": old_sha},
    "merge_base_commit": {"sha": old_sha},
    "commits": [{"sha": master_sha}],
}
if mode == "nonancestor":
    compare["status"] = "diverged"
    compare["behind_by"] = 1
    compare["merge_base_commit"] = {"sha": "c" * 40}
elif mode == "malformed":
    compare = {"status": "ahead"}
elif mode == "wrong-final":
    compare["commits"] = [{"sha": "e" * 40}]
elif mode == "head-present-not-final":
    compare["ahead_by"] = 2
    compare["total_commits"] = 2
    compare["commits"] = [
        {"sha": master_sha},
        {"sha": "e" * 40},
    ]
historical = {
    "type": "file",
    "path": ".github/workflows/oci-live-data-rollout.yml",
    "encoding": "base64",
    "size": len(source),
    "sha": blob_sha,
    "content": base64.b64encode(source).decode("ascii"),
}
directory_path.mkdir(mode=0o700, parents=True, exist_ok=True)
directory_path.chmod(0o700)
for name, value in {
    "run.json": run,
    "workflow.json": {
        "id": 313,
        "path": ".github/workflows/oci-live-data-rollout.yml",
        "state": "disabled_manually",
    },
    "jobs.json": jobs,
    "pending.json": pending,
    "artifacts.json": artifacts,
    "compare.json": compare,
    "historical.json": historical,
}.items():
    path = directory_path / name
    path.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
    path.chmod(0o600)
PY
}

prepare_unmaterialized_claim() {
  local run_id="$1"
  local mode="${2:-valid}"
  local intent_summary capture_path intent_version blob_sha
  UNMATERIALIZED_RUN_ID="$run_id"
  UNMATERIALIZED_EVIDENCE_DIR="$tmp_dir/unmaterialized-evidence-$run_id"
  UNMATERIALIZED_AUTHORITY_DIR="$tmp_dir/unmaterialized-authority-$run_id"
  UNMATERIALIZED_POLICY="$UNMATERIALIZED_EVIDENCE_DIR/policy.json"
  UNMATERIALIZED_REQUEST="$UNMATERIALIZED_EVIDENCE_DIR/request.json"
  UNMATERIALIZED_NORMALIZED="$UNMATERIALIZED_EVIDENCE_DIR/normalized.json"
  write_unmaterialized_evidence \
    "$UNMATERIALIZED_EVIDENCE_DIR" "$run_id" "$mode"
  "$POLICY" get oci-live-data-apply-backfills >"$UNMATERIALIZED_POLICY"
  chmod 600 "$UNMATERIALIZED_POLICY"
  write_live_data_request "$UNMATERIALIZED_REQUEST" "$SHA"
  "$HELPER" validate-request \
    --request "$UNMATERIALIZED_REQUEST" \
    --policy-json "$(cat "$UNMATERIALIZED_POLICY")" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --repo-root "$ROOT_DIR" \
    --output "$UNMATERIALIZED_NORMALIZED"
  blob_sha="$(jq -r '.sha' "$UNMATERIALIZED_EVIDENCE_DIR/historical.json")"
  intent_summary="$(
    "$HELPER" claim-request \
      --normalized "$UNMATERIALIZED_NORMALIZED" \
      --policy-json "$(cat "$UNMATERIALIZED_POLICY")" \
      --repository "$REPOSITORY" \
      --current-master "$SHA" \
      --workflow-id 313 \
      --workflow-blob-sha "$blob_sha" \
      --owner-pid "$$" \
      --authority-dir "$UNMATERIALIZED_AUTHORITY_DIR" \
      --repo-root "$ROOT_DIR"
  )"
  capture_path="$(jq -r '.capturePath' <<<"$intent_summary")"
  intent_version="$(jq -r '.version' <<<"$intent_summary")"
  printf 'https://github.com/%s/actions/runs/%s\n' \
    "$REPOSITORY" "$run_id" >"$capture_path"
  "$HELPER" record-dispatch-status \
    --normalized "$UNMATERIALIZED_NORMALIZED" \
    --policy-json "$(cat "$UNMATERIALIZED_POLICY")" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --workflow-id 313 \
    --workflow-blob-sha "$blob_sha" \
    --expected-version "$intent_version" \
    --dispatch-status 0 \
    --authority-dir "$UNMATERIALIZED_AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" >/dev/null
  "$HELPER" bind-intent \
    --normalized "$UNMATERIALIZED_NORMALIZED" \
    --policy-json "$(cat "$UNMATERIALIZED_POLICY")" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --workflow-id 313 \
    --workflow-blob-sha "$blob_sha" \
    --expected-run-id "$run_id" \
    --authority-dir "$UNMATERIALIZED_AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR" >/dev/null
}

retire_unmaterialized_claim() {
  local current_master="${1:-$ADVANCED_SHA}"
  local expected_version="${2:-1}"
  "$HELPER" retire-unmaterialized-claim \
    --run-id "$UNMATERIALIZED_RUN_ID" \
    --run-json "$UNMATERIALIZED_EVIDENCE_DIR/run.json" \
    --workflow-json "$UNMATERIALIZED_EVIDENCE_DIR/workflow.json" \
    --jobs-json "$UNMATERIALIZED_EVIDENCE_DIR/jobs.json" \
    --pending-json "$UNMATERIALIZED_EVIDENCE_DIR/pending.json" \
    --artifacts-json "$UNMATERIALIZED_EVIDENCE_DIR/artifacts.json" \
    --compare-json "$UNMATERIALIZED_EVIDENCE_DIR/compare.json" \
    --historical-workflow-json "$UNMATERIALIZED_EVIDENCE_DIR/historical.json" \
    --policy-json "$(cat "$UNMATERIALIZED_POLICY")" \
    --repository "$REPOSITORY" \
    --current-master "$current_master" \
    --expected-version "$expected_version" \
    --minimum-age-seconds 600 \
    --now-epoch 2000 \
    --authority-dir "$UNMATERIALIZED_AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR"
}

write_advanced_normalized() {
  local directory="$1"
  local request="$directory/advanced-request.json"
  ADVANCED_NORMALIZED="$directory/advanced-normalized.json"
  write_live_data_request "$request" "$ADVANCED_SHA"
  "$HELPER" validate-request \
    --request "$request" \
    --policy-json "$(cat "$UNMATERIALIZED_POLICY")" \
    --repository "$REPOSITORY" \
    --current-master "$ADVANCED_SHA" \
    --repo-root "$ROOT_DIR" \
    --output "$ADVANCED_NORMALIZED"
}

write_request
if STUB_DIRTY_CHECKOUT=true \
  run_dispatcher "$request_file" >"$output_file" 2>"$error_file"; then
  echo "untracked checkout unexpectedly passed" >&2
  exit 1
fi
grep -qF "dispatch checkout is not clean" "$error_file"

run_dispatcher "$request_file" >"$output_file"
grep -qF "dispatch=READY" "$output_file"
[[ ! -e "$authority_dir" ]]
[[ ! -e "$dispatch_count_file" ]]

write_request state-race
rm -f "$workflow_state_count_file"
if STUB_DISABLE_ON_STATE_CALL=3 \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "workflow state change before dispatch unexpectedly passed" >&2
  exit 1
fi
grep -qF "must be active immediately before dispatch" "$error_file"
[[ ! -e "$dispatch_count_file" ]]
[[ -z "$(find "$authority_dir" -maxdepth 1 -type f -print -quit)" ]]
rm -f "$workflow_state_count_file"

write_request
if TEST_AUTHORITY_DIR="$ROOT_DIR/unsafe-authority-test" \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "in-repository authority root unexpectedly passed" >&2
  exit 1
fi
grep -qF "authority directory must be outside" "$error_file"
[[ ! -e "$dispatch_count_file" ]]

wrong_mode_authority="$tmp_dir/wrong-mode-authority"
mkdir "$wrong_mode_authority"
chmod 755 "$wrong_mode_authority"
if TEST_AUTHORITY_DIR="$wrong_mode_authority" \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "wrong-mode authority root unexpectedly passed" >&2
  exit 1
fi
grep -qF "authority directory must have mode 0700" "$error_file"
[[ ! -e "$dispatch_count_file" ]]

real_authority="$tmp_dir/real-authority"
symlink_authority="$tmp_dir/symlink-authority"
mkdir "$real_authority"
chmod 700 "$real_authority"
ln -s "$real_authority" "$symlink_authority"
if TEST_AUTHORITY_DIR="$symlink_authority" \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "symlink authority root unexpectedly passed" >&2
  exit 1
fi
grep -qF "non-symlink directory" "$error_file"
[[ ! -e "$dispatch_count_file" ]]

EXCLUDE_RUN_ID=9999 PROSPECTIVE_PROMOTION_PR=224 \
  STUB_EXPECT_ACTUAL_MASTER_EXCLUSIVITY=true \
  run_dispatcher "$request_file" --dispatch >"$output_file"
grep -qF "authority_state=issued" "$output_file"
[[ "$(cat "$dispatch_count_file")" = "1" ]]
[[ "$(stat -c '%a' "$authority_dir" 2>/dev/null || stat -f '%Lp' "$authority_dir")" = "700" ]]
record="$authority_dir/7001.json"
[[ -f "$record" ]]
[[ "$(stat -c '%a' "$record" 2>/dev/null || stat -f '%Lp' "$record")" = "600" ]]
jq -e '
  .state == "issued" and
  .operation == "production-deploy" and
  .runId == 7001 and
  .controlSha == $sha and
  .subjectSha == $sha and
  .targetSha == null and
  .inputs.build_run_id == "42"
' --arg sha "$SHA" "$record" >/dev/null
expected_hash="$(python3 - "$captured_inputs_file" <<'PY'
import hashlib
import sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
[[ "$(jq -r '.inputHash' "$record")" = "$expected_hash" ]]

if STUB_RUN_ID=7099 \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "issued exact request unexpectedly redispatched" >&2
  exit 1
fi
grep -qF "blocked by issued authority 7001" "$error_file"
[[ "$(cat "$dispatch_count_file")" = "1" ]]

python3 - "$record" <<'PY'
import json
import os
import sys

path = sys.argv[1]
record = json.load(open(path, encoding="utf-8"))
record["state"] = "consumed"
record["version"] += 1
record["approvals"] = [{
    "runId": record["runId"],
    "operation": record["operation"],
    "environmentId": 1,
    "gateKey": "0" * 64,
    "approvedAt": record["createdAt"],
}]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(record, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
if STUB_RUN_ID=7099 \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "consumed exact request unexpectedly redispatched" >&2
  exit 1
fi
grep -qF "blocked by consumed authority 7001" "$error_file"
[[ "$(cat "$dispatch_count_file")" = "1" ]]

write_request alternate
STUB_RUN_ID=7002 STUB_DISPATCH_STATUS=1 \
  run_dispatcher "$request_file" --dispatch >"$output_file"
[[ "$(cat "$dispatch_count_file")" = "2" ]]
jq -e '.state == "issued" and .runId == 7002' "$authority_dir/7002.json" >/dev/null

write_request delayed
if STUB_RUN_ID=7003 STUB_MATERIALIZE_FAIL=true \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "unmaterialized accepted dispatch unexpectedly passed" >&2
  exit 1
fi
grep -qF "do not redispatch" "$error_file"
grep -qF "accepted-but-unmaterialized provider state" "$error_file"
[[ "$(cat "$dispatch_count_file")" = "3" ]]
jq -e '.state == "claimed" and .runId == 7003' "$authority_dir/7003.json" >/dev/null
write_request blocked
if STUB_RUN_ID=7005 \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "duplicate ambiguous dispatch unexpectedly passed" >&2
  exit 1
fi
grep -qF "blocked by claimed authority 7003" "$error_file"
grep -qF "do not redispatch" "$error_file"
[[ "$(cat "$dispatch_count_file")" = "3" ]]
python3 - "$authority_dir/7003.json" <<'PY'
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
write_request delayed
STUB_RUN_ID=7003 run_dispatcher "$request_file" --resume-run 7003 >"$output_file"
grep -qF "authority_state=issued" "$output_file"
[[ "$(cat "$dispatch_count_file")" = "3" ]]
jq -e '
  .state == "issued" and
  .createdAt != "2000-01-01T00:00:00Z" and
  .expiresAt != "2000-01-02T00:00:00Z"
' "$authority_dir/7003.json" >/dev/null

write_request url-less
if STUB_RUN_ID=7004 STUB_DISPATCH_NO_URL=true \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "URL-less accepted dispatch unexpectedly passed" >&2
  exit 1
fi
grep -qF "outcome is ambiguous, do not redispatch" "$error_file"
[[ "$(cat "$dispatch_count_file")" = "4" ]]
[[ ! -e "$authority_dir/7004.json" ]]
jq -e '.state == "dispatching" and .dispatchStatus == 0' \
  "$authority_dir"/request-*.json >/dev/null
write_request blocked
if STUB_RUN_ID=7007 \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "unresolved dispatch intent unexpectedly redispatched" >&2
  exit 1
fi
grep -qF "blocked by dispatching authority intent:" "$error_file"
[[ "$(cat "$dispatch_count_file")" = "4" ]]

for unresolved_intent in "$authority_dir"/request-*.json; do
  unresolved_capture="$authority_dir/$(jq -r '.captureFile' "$unresolved_intent")"
  rm -f "$unresolved_capture" "$unresolved_intent"
done

write_request url-less-nonzero
if STUB_RUN_ID=7006 STUB_DISPATCH_NO_URL=true STUB_DISPATCH_STATUS=1 \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "URL-less nonzero dispatch unexpectedly passed" >&2
  exit 1
fi
grep -qF "outcome is ambiguous, do not redispatch" "$error_file"
[[ "$(cat "$dispatch_count_file")" = "5" ]]
[[ ! -e "$authority_dir/7006.json" ]]

for unresolved_intent in "$authority_dir"/request-*.json; do
  unresolved_capture="$authority_dir/$(jq -r '.captureFile' "$unresolved_intent")"
  rm -f "$unresolved_capture" "$unresolved_intent"
done

write_request crash
if STUB_RUN_ID=7008 STUB_KILL_AFTER_URL=true \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "crashed dispatcher unexpectedly passed" >&2
  exit 1
fi
[[ "$(cat "$dispatch_count_file")" = "6" ]]
crash_intent="$(
  for candidate in "$authority_dir"/request-*.json; do
    if [[ "$(jq -r '.inputs.build_run_id' "$candidate")" = "44" ]]; then
      printf '%s\n' "$candidate"
    fi
  done
)"
[[ -f "$crash_intent" ]]
crash_capture="$authority_dir/$(jq -r '.captureFile' "$crash_intent")"
grep -qF "https://github.com/$REPOSITORY/actions/runs/7008" "$crash_capture"
python3 - "$crash_intent" <<'PY'
import json
import os
import sys

path = sys.argv[1]
intent = json.load(open(path, encoding="utf-8"))
intent["createdAt"] = "2000-01-01T00:00:00Z"
intent["expiresAt"] = "2000-01-02T00:00:00Z"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(intent, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
STUB_RUN_ID=7008 run_dispatcher "$request_file" --resume-captured >"$output_file"
grep -qF "authority_state=issued" "$output_file"
jq -e '.state == "issued" and .runId == 7008' \
  "$authority_dir/7008.json" >/dev/null
[[ ! -e "$crash_intent" ]]
[[ ! -e "$crash_capture" ]]
[[ "$(cat "$dispatch_count_file")" = "6" ]]

write_request inert
STUB_RUN_ID=7010 STUB_RUN_COMPLETED=true STUB_RUN_JOBLESS=true \
  run_dispatcher "$request_file" --dispatch >"$output_file"
grep -qF "authority_state=retired" "$output_file"
jq -e '.state == "retired" and .runId == 7010' \
  "$authority_dir/7010.json" >/dev/null
[[ "$(cat "$dispatch_count_file")" = "7" ]]
STUB_RUN_ID=7011 run_dispatcher "$request_file" --dispatch >"$output_file"
grep -qF "authority_state=issued" "$output_file"
jq -e '.state == "issued" and .runId == 7011' \
  "$authority_dir/7011.json" >/dev/null
[[ "$(cat "$dispatch_count_file")" = "8" ]]

prepare_unmaterialized_claim 7300
unmaterialized_record="$UNMATERIALIZED_AUTHORITY_DIR/$UNMATERIALIZED_RUN_ID.json"
jq -e '
  .schemaVersion == "betstan.copilot-cli-authority.v1" and
  .state == "claimed" and
  .version == 1 and
  (has("retirement") | not)
' "$unmaterialized_record" >/dev/null
retire_unmaterialized_claim >"$output_file"
jq -e '
  .runId == 7300 and
  .state == "retired" and
  .version == 2 and
  .retirement.reason == "unmaterialized" and
  (.retirement.evidenceDigest | test("^[0-9a-f]{64}$")) and
  .retirement.masterShaAtRetirement == $master and
  (.retirement.retiredAt | type == "string")
' --arg master "$ADVANCED_SHA" "$output_file" >/dev/null
jq -e '
  .schemaVersion == "betstan.copilot-cli-authority.v2" and
  .state == "retired" and
  .version == 2 and
  .retirement.reason == "unmaterialized" and
  .retirement.masterShaAtRetirement == $master
' --arg master "$ADVANCED_SHA" "$unmaterialized_record" >/dev/null

retire_test_run_id=7310
for rejection in \
  nonancestor rendered-title wrong-identity wrong-run-id wrong-path wrong-event \
  wrong-head wrong-branch wrong-attempt wrong-repository jobs pending artifacts \
  malformed wrong-final head-present-not-final; do
  prepare_unmaterialized_claim "$retire_test_run_id" "$rejection"
  if retire_unmaterialized_claim >"$output_file" 2>"$error_file"; then
    echo "unsafe unmaterialized retirement unexpectedly passed: $rejection" >&2
    exit 1
  fi
  jq -e '.schemaVersion == "betstan.copilot-cli-authority.v1" and .state == "claimed"' \
    "$UNMATERIALIZED_AUTHORITY_DIR/$UNMATERIALIZED_RUN_ID.json" >/dev/null
  retire_test_run_id=$((retire_test_run_id + 1))
done

prepare_unmaterialized_claim 7380
if retire_unmaterialized_claim "$SHA" >"$output_file" 2>"$error_file"; then
  echo "current-control authority unexpectedly retired as unmaterialized" >&2
  exit 1
fi
grep -qF "current-master authority record" "$error_file"

prepare_unmaterialized_claim 7381
if retire_unmaterialized_claim "$ADVANCED_SHA" 2 >"$output_file" 2>"$error_file"; then
  echo "wrong-version unmaterialized retirement unexpectedly passed" >&2
  exit 1
fi
grep -qF "changed before unmaterialized retirement" "$error_file"

prepare_unmaterialized_claim 7382
python3 - "$UNMATERIALIZED_AUTHORITY_DIR/$UNMATERIALIZED_RUN_ID.json" <<'PY'
import json
import os
import sys

path = sys.argv[1]
record = json.load(open(path, encoding="utf-8"))
record["state"] = "issued"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(record, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
if retire_unmaterialized_claim >"$output_file" 2>"$error_file"; then
  echo "non-claimed unmaterialized retirement unexpectedly passed" >&2
  exit 1
fi
grep -qF "only a claimed authority record" "$error_file"

prepare_unmaterialized_claim 7383
python3 - "$UNMATERIALIZED_AUTHORITY_DIR/$UNMATERIALIZED_RUN_ID.json" <<'PY'
import json
import os
import sys

path = sys.argv[1]
record = json.load(open(path, encoding="utf-8"))
record["workflowBlobSha"] = "0" * 40
with open(path, "w", encoding="utf-8") as handle:
    json.dump(record, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
if retire_unmaterialized_claim >"$output_file" 2>"$error_file"; then
  echo "wrong historical blob unexpectedly retired an authority record" >&2
  exit 1
fi
grep -qF "historical workflow blob does not match authority record" "$error_file"

prepare_unmaterialized_claim 7390
write_advanced_normalized "$UNMATERIALIZED_EVIDENCE_DIR"
blocking="$(
  "$HELPER" blocking-record \
    --normalized "$ADVANCED_NORMALIZED" \
    --authority-dir "$UNMATERIALIZED_AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR"
)"
[[ "$blocking" == $'7390\tclaimed' ]] || {
  echo "advanced master did not retain a stale claimed authority fence" >&2
  exit 1
}
if "$HELPER" claim-request \
  --normalized "$ADVANCED_NORMALIZED" \
  --policy-json "$(cat "$UNMATERIALIZED_POLICY")" \
  --repository "$REPOSITORY" \
  --current-master "$ADVANCED_SHA" \
  --workflow-id 313 \
  --workflow-blob-sha "$BLOB" \
  --owner-pid "$$" \
  --authority-dir "$UNMATERIALIZED_AUTHORITY_DIR" \
  --repo-root "$ROOT_DIR" >"$output_file" 2>"$error_file"; then
  echo "claim request bypassed an advanced stale authority fence" >&2
  exit 1
fi
grep -qF "blocked by claimed authority 7390" "$error_file"

python3 - "$UNMATERIALIZED_AUTHORITY_DIR/$UNMATERIALIZED_RUN_ID.json" <<'PY'
import json
import os
import sys

path = sys.argv[1]
record = json.load(open(path, encoding="utf-8"))
record["state"] = "inflight"
record["version"] += 1
record["inflightApproval"] = {
    "runId": record["runId"],
    "operation": record["operation"],
    "environmentId": 1,
    "gateKey": "0" * 64,
    "claimedAt": record["createdAt"],
    "previousState": "issued",
    "reviewer": "copilot-test-user",
    "approvalComment": "test",
    "approvalCountBefore": 0,
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(record, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
blocking="$(
  "$HELPER" blocking-record \
    --normalized "$ADVANCED_NORMALIZED" \
    --authority-dir "$UNMATERIALIZED_AUTHORITY_DIR" \
    --repo-root "$ROOT_DIR"
)"
[[ "$blocking" == $'7390\tinflight' ]] || {
  echo "advanced master did not retain a stale inflight authority fence" >&2
  exit 1
}

unresolved_authority_dir="$tmp_dir/unresolved-authority-fence"
unresolved_evidence_dir="$tmp_dir/unresolved-authority-evidence"
write_unmaterialized_evidence "$unresolved_evidence_dir" 7391
"$POLICY" get oci-live-data-apply-backfills >"$unresolved_evidence_dir/policy.json"
chmod 600 "$unresolved_evidence_dir/policy.json"
write_live_data_request "$unresolved_evidence_dir/request.json" "$SHA"
"$HELPER" validate-request \
  --request "$unresolved_evidence_dir/request.json" \
  --policy-json "$(cat "$unresolved_evidence_dir/policy.json")" \
  --repository "$REPOSITORY" \
  --current-master "$SHA" \
  --repo-root "$ROOT_DIR" \
  --output "$unresolved_evidence_dir/normalized.json"
unresolved_blob="$(jq -r '.sha' "$unresolved_evidence_dir/historical.json")"
"$HELPER" claim-request \
  --normalized "$unresolved_evidence_dir/normalized.json" \
  --policy-json "$(cat "$unresolved_evidence_dir/policy.json")" \
  --repository "$REPOSITORY" \
  --current-master "$SHA" \
  --workflow-id 313 \
  --workflow-blob-sha "$unresolved_blob" \
  --owner-pid "$$" \
  --authority-dir "$unresolved_authority_dir" \
  --repo-root "$ROOT_DIR" >/dev/null
blocking="$(
  "$HELPER" blocking-record \
    --normalized "$ADVANCED_NORMALIZED" \
    --authority-dir "$unresolved_authority_dir" \
    --repo-root "$ROOT_DIR"
)"
[[ "$blocking" == intent:*$'\tdispatching' ]] || {
  echo "advanced master did not retain an unresolved dispatch intent fence" >&2
  exit 1
}

chmod 644 "$request_file"
if run_dispatcher "$request_file" >"$output_file" 2>"$error_file"; then
  echo "world-readable request unexpectedly passed" >&2
  exit 1
fi
grep -qF "must not be group- or world-accessible" "$error_file"
chmod 600 "$request_file"

symlink_request="$tmp_dir/request-link.json"
ln -s "$request_file" "$symlink_request"
if run_dispatcher "$symlink_request" >"$output_file" 2>"$error_file"; then
  echo "symlink request unexpectedly passed" >&2
  exit 1
fi
grep -qF "regular non-symlink" "$error_file"

write_request unknown-input
if run_dispatcher "$request_file" >"$output_file" 2>"$error_file"; then
  echo "unknown workflow input unexpectedly passed" >&2
  exit 1
fi
grep -qF "input names do not exactly match policy" "$error_file"

python3 - "$request_file" "$SHA" "$REPOSITORY" <<'PY'
import os
import sys

path, sha, repository = sys.argv[1:]
payload = (
    '{"schemaVersion":"betstan.copilot-cli-dispatch-request.v1",'
    f'"repository":"{repository}","operation":"production-deploy",'
    '"operation":"production-deploy",'
    f'"controlSha":"{sha}","subjectSha":"{sha}","targetSha":null,'
    f'"inputs":{{"approved_sha":"{sha}","build_run_id":"42"}}}}'
)
with open(path, "w", encoding="utf-8") as handle:
    handle.write(payload)
os.chmod(path, 0o600)
PY
if run_dispatcher "$request_file" >"$output_file" 2>"$error_file"; then
  echo "duplicate JSON key unexpectedly passed" >&2
  exit 1
fi
grep -qF "duplicate JSON key" "$error_file"

write_request
if STUB_HUMAN_PROMOTION=true \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "human promotion unexpectedly received dispatch authority" >&2
  exit 1
fi
grep -qF "not bound to exactly one CLI-managed dev promotion" "$error_file"
[[ "$(cat "$dispatch_count_file")" = "8" ]]

echo "copilot_cli_dispatch_tests=PASS"
