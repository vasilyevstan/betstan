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

# Required CI uses a depth-one checkout. Reject fixed historical object reads
# in this supported test path, including Python argv that bypass shell stubs.
python3 -I - "$ROOT_DIR" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
historical_read = re.compile(
    r"\b[0-9a-fA-F]{40}:[A-Za-z_.]"
    r"|\bshow[\s'\",\[\]]+[0-9a-fA-F]{40}\b"
)
for sample in (
    "git show " + "a" * 40 + ":infra/reader.py",
    '["git", "-C", str(root), "show",\n"' + "b" * 40 + ':infra/reader.py"]',
    "git show " + "c" * 40 + " -- infra/reader.py",
):
    assert historical_read.search(sample), "historical-read guard missed a regression"
assert not historical_read.search("git show HEAD:infra/reader.py")
for relative in (
    "infra/azure/agents/test-copilot-cli-dispatch-stan.sh",
    "infra/azure/agents/test-deployment-safety-ci-stan.sh",
    "infra/azure/agents/fixtures/copilot-cli-intent-v1-reader.py",
):
    assert not historical_read.search((root / relative).read_text()), \
        f"hardcoded historical Git object in shallow-supported test: {relative}"
print("dispatch_test_history_independence_contract=PASS")
PY

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
      if [[
        "${STUB_EXCLUSIVITY_FAIL_WHEN_INTENT:-false}" == "true" &&
          -n "${COPILOT_CLI_AUTHORITY_DIR:-}" &&
          -n "$(
            find "$COPILOT_CLI_AUTHORITY_DIR" \
              -maxdepth 1 -type f -name 'request-*.json' -print -quit \
              2>/dev/null
          )"
      ]]; then
        printf '%s\n' '{'
        return
      fi
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
if mode == "changed-blob-missing-current-tokens":
    for token in (
        b"./infra/oci/scripts/live-data-maintenance-stan.sh hold",
        b"./infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh",
    ):
        if token not in source:
            raise SystemExit(f"current live-data fixture is missing {token!r}")
        source = source.replace(token, b"", 1)
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
approvals = [] if mode != "approved" else [{"state": "approved"}]
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
    "approvals.json": approvals,
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
    --approvals-json "$UNMATERIALIZED_EVIDENCE_DIR/approvals.json" \
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

PYTHONDONTWRITEBYTECODE=1 python3 - "$HELPER" <<'PY'
import importlib.util
import sys

helper_path = sys.argv[1]
spec = importlib.util.spec_from_file_location("authority_helper", helper_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
path = ".github/workflows/oci-live-data-rollout.yml"
full_profile = module.UNMATERIALIZED_WORKFLOWS[path]["mutationTokens"]
historical_profile = module.historical_mutation_tokens(
    path,
    module.LIVE_DATA_HISTORICAL_PROFILE_BLOB,
)
expected_historical = (
    "./infra/oci/scripts/authorize-github-runner.sh cleanup-stale",
    "./infra/oci/scripts/authorize-github-runner.sh authorize",
    "./infra/oci/scripts/configure-k3s-access.sh open",
    "./infra/azure/agents/shared-mongo-operation-lock-stan.sh acquire",
    "./infra/oci/scripts/live-data-maintenance-stan.sh enter",
    "./infra/oci/scripts/live-betting-data-rollout-stan.sh",
    "./infra/oci/scripts/live-data-maintenance-stan.sh restore",
    "./infra/azure/agents/shared-mongo-operation-lock-stan.sh renew",
    "./infra/azure/agents/shared-mongo-operation-lock-stan.sh release",
    "./infra/oci/scripts/revoke-github-runner.sh",
    "./infra/oci/scripts/configure-k3s-access.sh cleanup",
)
if (
    historical_profile != expected_historical
    or module.LIVE_DATA_HISTORICAL_PROFILE_TOKENS != expected_historical
):
    raise SystemExit("exact historical live-data mutation profile drifted")
for missing_token in (
    "./infra/oci/scripts/live-data-maintenance-stan.sh hold",
    "./infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh",
):
    if missing_token in historical_profile or missing_token not in full_profile:
        raise SystemExit("historical live-data mutation profile omissions drifted")
if module.historical_mutation_tokens(path, "0" * 40) != full_profile:
    raise SystemExit("non-profile live-data blob did not require current mutations")
if len(module.HISTORICAL_MUTATION_PROFILES) != 1:
    raise SystemExit("unexpected historical mutation profile was allowlisted")
PY

concurrent_authority_dir="$tmp_dir/concurrent-authority"
concurrent_policy="$tmp_dir/concurrent-policy.json"
concurrent_request_a="$tmp_dir/concurrent-request-a.json"
concurrent_request_b="$tmp_dir/concurrent-request-b.json"
concurrent_normalized_a="$tmp_dir/concurrent-normalized-a.json"
concurrent_normalized_b="$tmp_dir/concurrent-normalized-b.json"
"$POLICY" get production-deploy >"$concurrent_policy"
chmod 600 "$concurrent_policy"
python3 - \
  "$concurrent_request_a" \
  "$concurrent_request_b" \
  "$SHA" \
  "$REPOSITORY" <<'PY'
import json
import os
import sys

request_a, request_b, sha, repository = sys.argv[1:]
for path, build_run_id in (
    (request_a, "9101"),
    (request_b, "9102"),
):
    request = {
        "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
        "repository": repository,
        "operation": "production-deploy",
        "controlSha": sha,
        "subjectSha": sha,
        "targetSha": None,
        "inputs": {
            "approved_sha": sha,
            "build_run_id": build_run_id,
        },
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(request, handle)
        handle.write("\n")
    os.chmod(path, 0o600)
PY
for request_and_normalized in \
  "$concurrent_request_a:$concurrent_normalized_a" \
  "$concurrent_request_b:$concurrent_normalized_b"; do
  concurrent_request="${request_and_normalized%%:*}"
  concurrent_normalized="${request_and_normalized#*:}"
  "$HELPER" validate-request \
    --request "$concurrent_request" \
    --policy-json "$(cat "$concurrent_policy")" \
    --repository "$REPOSITORY" \
    --current-master "$SHA" \
    --repo-root "$ROOT_DIR" \
    --output "$concurrent_normalized"
done
python3 - \
  "$HELPER" \
  "$concurrent_policy" \
  "$concurrent_normalized_a" \
  "$concurrent_normalized_b" \
  "$concurrent_authority_dir" \
  "$ROOT_DIR" \
  "$REPOSITORY" \
  "$SHA" \
  "$WORKFLOW_ID" \
  "$BLOB" <<'PY'
import fcntl
import os
import pathlib
import subprocess
import sys
import time

(
    helper,
    policy_path,
    normalized_a,
    normalized_b,
    authority_dir_text,
    repo_root,
    repository,
    current_master,
    workflow_id,
    workflow_blob_sha,
) = sys.argv[1:]
authority_dir = pathlib.Path(authority_dir_text)
authority_dir.mkdir(mode=0o700)
lock_path = authority_dir / ".repository-claim.lock"
lock_descriptor = os.open(
    lock_path,
    os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW,
    0o600,
)
policy_json = pathlib.Path(policy_path).read_text(encoding="utf-8")

def command(normalized):
    return [
        helper,
        "claim-request",
        "--normalized",
        normalized,
        "--policy-json",
        policy_json,
        "--repository",
        repository,
        "--current-master",
        current_master,
        "--workflow-id",
        workflow_id,
        "--workflow-blob-sha",
        workflow_blob_sha,
        "--owner-pid",
        str(os.getpid()),
        "--authority-dir",
        str(authority_dir),
        "--repo-root",
        repo_root,
    ]

try:
    fcntl.flock(lock_descriptor, fcntl.LOCK_EX)
    processes = [
        subprocess.Popen(
            command(normalized),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for normalized in (normalized_a, normalized_b)
    ]
    time.sleep(0.1)
    fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
    results = [
        (*process.communicate(timeout=10), process.returncode)
        for process in processes
    ]
finally:
    os.close(lock_descriptor)

if sorted(result[2] for result in results) != [0, 1]:
    raise SystemExit(f"concurrent claim results were not one success and one rejection: {results!r}")
failure = next(result for result in results if result[2] != 0)
if "blocked by dispatching authority intent:" not in failure[1]:
    raise SystemExit(f"concurrent claim rejection was not repository-global: {failure!r}")
intent_files = list(authority_dir.glob("request-*.json"))
capture_files = list(authority_dir.glob("dispatch-*.log"))
if len(intent_files) != 1 or len(capture_files) != 1:
    raise SystemExit(
        "concurrent distinct requests created more than one repository claim"
    )
PY

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
[[ -z "$(
  find "$authority_dir" \
    -maxdepth 1 -type f ! -name '.repository-claim.lock' -print -quit
)" ]]
rm -f "$workflow_state_count_file"

write_request
final_exclusivity_authority="$tmp_dir/final-exclusivity-authority"
if TEST_AUTHORITY_DIR="$final_exclusivity_authority" \
  STUB_EXCLUSIVITY_FAIL_WHEN_INTENT=true \
  STUB_RUN_ID=7098 \
  run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
  echo "post-claim production exclusivity failure unexpectedly dispatched" >&2
  exit 1
fi
[[ ! -e "$dispatch_count_file" ]]
[[ -z "$(
  find "$final_exclusivity_authority" \
    -maxdepth 1 -type f -name 'request-*.json' -print -quit
)" ]]

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
unmaterialized_record_before="$tmp_dir/unmaterialized-record-before.json"
jq -e '
  .schemaVersion == "betstan.copilot-cli-authority.v1" and
  .state == "claimed" and
  .version == 1 and
  (has("retirement") | not)
' "$unmaterialized_record" >/dev/null
cp "$unmaterialized_record" "$unmaterialized_record_before"
retire_unmaterialized_claim >"$output_file"
unmaterialized_digests="$(
  PYTHONDONTWRITEBYTECODE=1 python3 - \
    "$unmaterialized_record_before" \
    "$UNMATERIALIZED_EVIDENCE_DIR" \
    "$REPOSITORY" \
    "$ADVANCED_SHA" <<'PY'
import hashlib
import json
import pathlib
import sys

record_path, evidence_dir, repository, current_master = sys.argv[1:]
directory = pathlib.Path(evidence_dir)
record = json.loads(pathlib.Path(record_path).read_text(encoding="utf-8"))
payload = {
    "schemaVersion": "betstan.copilot-cli-unmaterialized-evidence.v2",
    "repository": repository,
    "currentMaster": current_master,
    "minimumAgeSeconds": 600,
    "nowEpoch": 2000,
    "authorityRecord": {
        "controlSha": record["controlSha"],
        "displayTitle": record["displayTitle"],
        "inputHash": record["inputHash"],
        "runId": record["runId"],
        "version": record["version"],
        "workflowBlobSha": record["workflowBlobSha"],
        "workflowId": record["workflowId"],
    },
    "run": json.loads((directory / "run.json").read_text(encoding="utf-8")),
    "workflow": json.loads(
        (directory / "workflow.json").read_text(encoding="utf-8")
    ),
    "jobs": json.loads((directory / "jobs.json").read_text(encoding="utf-8")),
    "pending": json.loads(
        (directory / "pending.json").read_text(encoding="utf-8")
    ),
    "approvals": json.loads(
        (directory / "approvals.json").read_text(encoding="utf-8")
    ),
    "artifacts": json.loads(
        (directory / "artifacts.json").read_text(encoding="utf-8")
    ),
    "compare": json.loads(
        (directory / "compare.json").read_text(encoding="utf-8")
    ),
    "historicalWorkflow": json.loads(
        (directory / "historical.json").read_text(encoding="utf-8")
    ),
}

def digest(value):
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

expected = digest(payload)
payload["approvals"] = [{"reviewer": "tampered"}]
print(expected, digest(payload))
PY
)"
expected_unmaterialized_digest="${unmaterialized_digests%% *}"
tampered_unmaterialized_digest="${unmaterialized_digests#* }"
[ "$expected_unmaterialized_digest" != "$tampered_unmaterialized_digest" ]
jq -e '
  .runId == 7300 and
  .state == "retired" and
  .version == 2 and
  .retirement.reason == "unmaterialized" and
  (.retirement.evidenceDigest | test("^[0-9a-f]{64}$")) and
  .retirement.masterShaAtRetirement == $master and
  .retirement.evidenceDigest == $digest and
  (.retirement.retiredAt | type == "string")
' --arg master "$ADVANCED_SHA" \
  --arg digest "$expected_unmaterialized_digest" \
  "$output_file" >/dev/null
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
  approved malformed wrong-final head-present-not-final \
  changed-blob-missing-current-tokens; do
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

PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT_DIR" "$tmp_dir" <<'PY'
import base64
import concurrent.futures
import contextlib
import copy
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

root, temporary = map(Path, sys.argv[1:])
helper = root / "infra/azure/agents/copilot_cli_authority_stan.py"
dispatcher = root / "infra/azure/agents/copilot-cli-dispatch-stan.sh"
policy_script = root / "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
spec = importlib.util.spec_from_file_location("authority", helper)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
master, old = "b" * 40, "a" * 40
repository = "example/repo"
workflow = a.LIVE_DATA_PATH
source = (root / workflow).read_bytes()
blob = hashlib.sha1(f"blob {len(source)}\0".encode() + source).hexdigest()
policy = json.loads(subprocess.check_output([policy_script, "get", "oci-live-data-dry-run"]))
request = {
    "schemaVersion": a.REQUEST_SCHEMA, "repository": repository,
    "operation": policy["operation"], "controlSha": master,
    "subjectSha": master, "targetSha": None,
    "inputs": {
        **policy["fixedInputs"], "approved_sha": master, "build_run_id": "42",
        "infrastructure_run_id": "43", "baseline_recovery_run_id": "0",
    },
}
provider = temporary / "transition-provider.py"
# This provider has exactly one permitted mutation: the dispatcher's existing
# captured workflow-run command. Every other unexpected call is a test failure.
provider.write_text(r'''
import base64, fcntl, hashlib, json, os, sys
from pathlib import Path
d = Path(os.environ["TRANSITION_CASE"])
lock = open(d / "provider.lock", "a")
fcntl.flock(lock, fcntl.LOCK_EX)
f = json.loads((d / "fixture.json").read_text())
args = sys.argv[1:]
mutation = os.environ.get("TRANSITION_DRIFT", "")
count = int((d / "collections").read_text()) if (d / "collections").exists() else 0
active = count >= int(os.environ.get("TRANSITION_DRIFT_AT", "1"))
def save(name, value):
    (d / name).write_text(str(value))
def identified(run, run_id):
    return {**run, "id": run_id,
            "html_url": f'https://github.com/{f["repository"]}/actions/runs/{run_id}',
            "url": f'https://api.github.com/repos/{f["repository"]}/actions/runs/{run_id}'}
def concurrent_run():
    return identified({**f["runs"][0], "workflow_id": 998,
                       "path": ".github/workflows/production-deploy.yml",
                       "status": "queued", "event": "workflow_dispatch", "head_sha": f["master"],
                       "display_title": f'deploy {f["master"]}'}, f["newRun"] + 5)
def output(value):
    query = args[args.index("--jq") + 1] if "--jq" in args else ""
    if query == ".object.sha":
        print(value["object"]["sha"])
    elif query == ".sha":
        print(value["sha"])
    elif query == ".state":
        print(value["state"])
    elif query == "[.id,.path,.state] | @tsv":
        print("\t".join(str(value[k]) for k in ("id", "path", "state")))
    else:
        print(json.dumps(value, separators=(",", ":")))
if args[:2] == ["repo", "view"]:
    print(f["repository"]); sys.exit()
if args[:2] == ["workflow", "run"]:
    assert args[2] == "oci-live-data-rollout.yml"
    assert args[args.index("--ref") + 1] == "master"
    assert json.load(sys.stdin) == f["inputs"]
    save("dispatches", int((d / "dispatches").read_text()) + 1)
    mode = os.environ.get("TRANSITION_CAPTURE", "")
    if mode != "empty":
        print(f'https://github.com/{f["repository"]}/actions/runs/{f["newRun"]}')
    if mode == "multiple":
        print(f'https://github.com/{f["repository"]}/actions/runs/{f["newRun"] + 1}')
    sys.exit(1 if mode == "nonzero" else 0)
assert args[0] == "api" and "--method" not in args, args
endpoint = args[1].removeprefix(f'repos/{f["repository"]}/')
if endpoint.startswith("actions/runs?status=queued"):
    count += 1
    save("collections", count)
    active = count >= int(os.environ.get("TRANSITION_DRIFT_AT", "1"))
    if active and mutation and not (d / "mutated").exists():
        save("mutated", mutation)
        if mutation == "request":
            p = d / "request.json"; v = json.loads(p.read_text())
            v["inputs"]["build_run_id"] = "99"; p.write_text(json.dumps(v))
        if mutation in {"seal", "intent-mode", "capture", "capture-replace"}:
            p = next((d / "authority").glob("request-*.json")); v = json.loads(p.read_text())
            if mutation == "seal":
                v["preparedSeal"]["sealSha256"] = "0" * 64; p.write_text(json.dumps(v))
            elif mutation == "intent-mode":
                p.chmod(0o644)
            else:
                p = d / "authority" / v["captureFile"]
                if mutation == "capture-replace":
                    p.unlink()
                p.write_text("x" if mutation == "capture" else ""); p.chmod(0o600)
state = os.environ.get("TRANSITION_STATE", "disabled_manually")
if active and mutation == "state": state = "disabled_manually"
wf = {"id": f["workflowId"], "path": f["path"], "state": state}
if active and mutation == "workflow-id": wf["id"] += 1
if active and mutation == "workflow-path": wf["path"] = ".github/workflows/oci-production-deploy.yml"
if endpoint == "git/ref/heads/master":
    output({"object": {"sha": "c" * 40 if active and mutation == "master" else f["master"]}})
elif endpoint.startswith("commits/") and endpoint.endswith("/pulls"):
    output([{"merged_at": "2026-01-01T00:00:00Z", "merge_commit_sha": f["master"],
             "base": {"ref": "master"}, "head": {"ref": "dev"},
             "labels": [] if mutation == "promotion" else [{"name": "copilot-cli-managed"}]}])
elif endpoint in ("actions/workflows/oci-live-data-rollout.yml", f'actions/workflows/{f["workflowId"]}'):
    output(wf)
elif endpoint.startswith("contents/"):
    if endpoint.endswith("?ref=" + f["master"]):
        output({"sha": "d" * 40 if active and mutation == "blob" else f["blob"]})
    else:
        history = f["historical"]
        if active and mutation in {"historical-guard", "historical-source"}:
            source = base64.b64decode(history["content"])
            if mutation == "historical-guard":
                source = source.replace(b'[ "$SOURCE_SHA" = "$GITHUB_SHA" ]', b"true")
            else: source += b"\n# different verified blob\n"
            history.update(content=base64.b64encode(source).decode(), size=len(source),
                           sha=hashlib.sha1(f"blob {len(source)}\0".encode() + source).hexdigest())
        output(history)
elif endpoint.startswith("actions/runs?status="):
    runs = f["runs"] if "status=queued" in endpoint else []
    if active:
        if mutation == "empty": runs = []
        if runs and mutation == "added": runs.append(identified(runs[-1], runs[-1]["id"] + 1))
        if runs and mutation == "missing": runs.pop()
        if runs and mutation == "replaced": runs[-1] = identified(runs[-1], runs[-1]["id"] + 1)
        if runs and mutation == "duplicate": runs.append(runs[-1])
        if mutation == "all-timestamps":
            for run in runs:
                for key in ("created_at", "run_started_at", "updated_at"):
                    run[key] = "2001-01-01T00:00:01Z"
    result = {"total_count": len(runs), "workflow_runs": runs}
    if active and "status=queued" in endpoint:
        if mutation == "overflow": result["total_count"] = 101
        if mutation == "incomplete": result["total_count"] += 1
    if active and mutation == "other" and "status=in_progress" in endpoint:
        result = {"total_count": 1, "workflow_runs": [{**concurrent_run(), "status": "in_progress"}]}
    if active and mutation.startswith("malformed-") and "status=queued" in endpoint:
        _, field, kind = mutation.split("-")
        row = identified(f["runs"][0], f["newRun"] + 6)
        if kind == "missing": row.pop(field)
        else: row[field] = None
        result["workflow_runs"].append(row)
        result["total_count"] += 1
    if active and mutation.startswith("forged-"):
        forged = concurrent_run()
        if mutation == "forged-disabled":
            # This formerly reached generic disabled_inert with zero jobs and
            # pending gates, despite a real protected manual run behind the ID.
            forged.update(workflow_id=999, path=".github/workflows/oci-infrastructure.yml",
                          status="in_progress", event="push", head_sha=f["runs"][0]["head_sha"])
        elif mutation == "forged-unprotected-path":
            forged["path"] = ".github/workflows/branch-policy.yml"
        elif mutation == "forged-nonmaster-branch":
            forged["head_branch"] = "dev"
        if f'status={forged["status"]}&' in endpoint:
            result["workflow_runs"].append(forged)
            result["total_count"] += 1
    output(result)
elif endpoint.startswith("actions/workflows/") and "/runs?" in endpoint:
    output({"total_count": 0, "workflow_runs": []})
elif endpoint == "actions/workflows/998":
    output({"id": 998, "path": ".github/workflows/production-deploy.yml", "state": "active"})
elif endpoint == "actions/workflows/999":
    output({"id": 999, "path": ".github/workflows/oci-infrastructure.yml", "state": "disabled_manually"})
elif endpoint.startswith("compare/"):
    assert "--paginate" in args
    value = f["compare"]
    if active and mutation == "ancestry": value["status"] = "diverged"
    if active and mutation == "compare-final": value["commits"][-1]["sha"] = "e" * 40
    output(value)
elif endpoint.startswith("actions/runs/"):
    suffix = endpoint.removeprefix("actions/runs/")
    run_id = int(suffix.split("/")[0])
    if "/" not in suffix:
        if run_id == f["newRun"] + 5:
            run = concurrent_run()
            if mutation == "other": run["status"] = "in_progress"
        elif run_id == f["newRun"]:
            run = identified({**f["runs"][0], "head_sha": f["master"], "status": "waiting",
                              "display_title": f'oci-live-data dry-run {f["master"]}'}, run_id)
        else:
            run = identified(f["runs"][0], run_id)
            if active:
                changes = {
                    "run-id": ("id", run_id + 1), "run-workflow": ("workflow_id", 1),
                    "run-path": ("path", ".github/workflows/oci-migrate.yml"),
                    "event": ("event", "push"), "head": ("head_sha", "f" * 40),
                    "branch": ("head_branch", "dev"), "attempt": ("run_attempt", 2),
                    "repository": ("head_repository", {"full_name": "another/repo"}),
                    "url": ("html_url", "https://github.com/another/repo/actions/runs/1"),
                    "title": ("display_title", "rendered title"), "status": ("status", "waiting"),
                    "conclusion": ("conclusion", "cancelled"),
                }
                if mutation in changes: run[changes[mutation][0]] = changes[mutation][1]
                if mutation in {"created_at", "updated_at", "run_started_at"}:
                    run[mutation] = "2001-01-01T00:00:01Z"
                if mutation == "all-timestamps":
                    for key in ("created_at", "updated_at", "run_started_at"):
                        run[key] = "2001-01-01T00:00:01Z"
        output(run)
    elif "/jobs?" in suffix:
        real = (active and mutation == "jobs") or run_id >= f["newRun"]
        if mutation.startswith("forged-") and run_id == f["newRun"] + 5:
            real = False
        output({"total_count": 1, "jobs": [{"id": 1}]} if real else {"total_count": 0, "jobs": []})
    elif suffix.endswith("/pending_deployments"):
        output([{"environment": {"id": 1, "name": "oci-migration"}}] if active and mutation == "pending" else [])
    elif suffix.endswith("/approvals"):
        output([{"state": "approved"}] if active and mutation == "approvals" else [])
    elif "/artifacts?" in suffix:
        output({"total_count": 1, "artifacts": [{"id": 1}]} if active and mutation == "artifacts"
               else {"total_count": 0, "artifacts": []})
    else: raise AssertionError(args)
else: raise AssertionError(args)
''')
stub = r'''
gh() { python3 "$TRANSITION_PROVIDER" "$@"; }
git() {
  [[ "$1" != -C ]] || shift 2
  case "$1 $2" in
    "status --porcelain")
      if [[ "${TRANSITION_DRIFT:-}" = dirty && -f "$TRANSITION_CASE/mutated" ]]; then
        printf ' M dirty\n'
      fi ;;
    "rev-parse --show-toplevel") printf '%s\n' "$TRANSITION_ROOT" ;;
    "rev-parse HEAD") printf '%s\n' "$TRANSITION_MASTER" ;;
    "rev-parse "*) printf '%s\n' "$TRANSITION_BLOB" ;;
    *) return 1 ;;
  esac
}
export -f gh git
exec "$@"
'''

def write(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)

def setup():
    d = temporary / ("transition-" + secrets.token_hex(6))
    d.mkdir(mode=0o700)
    ids = set()
    while len(ids) < 3:
        ids.add(secrets.randbelow(100000) + 1000)
    ids = sorted(ids)
    runs = [{
        "id": n, "workflow_id": 313, "path": workflow, "head_sha": old,
        "head_branch": "master", "head_repository": {"id": 101, "full_name": repository},
        "repository": {"id": 101, "full_name": repository},
        "event": "workflow_dispatch", "run_attempt": 1, "status": "queued",
        "conclusion": None, "display_title": "oci-live-data-rollout",
        "created_at": "2000-01-01T00:00:00Z", "updated_at": "2000-01-01T00:00:00Z",
        "run_started_at": "2000-01-01T00:00:00Z",
        "html_url": f"https://github.com/{repository}/actions/runs/{n}",
        "url": f"https://api.github.com/repos/{repository}/actions/runs/{n}",
    } for n in ids]
    write(d / "fixture.json", {
        "repository": repository, "master": master, "blob": blob, "workflowId": 313,
        "path": workflow, "runs": runs, "newRun": max(ids) + 1000, "inputs": request["inputs"],
        "historical": {"path": workflow, "type": "file", "encoding": "base64", "sha": blob,
                       "size": len(source), "content": base64.b64encode(source).decode()},
        "compare": {"status": "ahead", "ahead_by": 1, "behind_by": 0, "total_commits": 1,
                    "base_commit": {"sha": old}, "merge_base_commit": {"sha": old},
                    "commits": [{"sha": master}]},
    })
    write(d / "request.json", request)
    (d / "dispatches").write_text("0")
    return d

def run(d, action, *, state="disabled_manually", drift="", at=1, capture="", ok=True, actual=master):
    env = {**os.environ, "TRANSITION_CASE": str(d), "TRANSITION_ROOT": str(root),
           "TRANSITION_PROVIDER": str(provider), "TRANSITION_MASTER": actual,
           "TRANSITION_BLOB": blob, "TRANSITION_STATE": state, "TRANSITION_DRIFT": drift,
           "TRANSITION_DRIFT_AT": str(at), "TRANSITION_CAPTURE": capture,
           "COPILOT_CLI_AUTHORITY_DIR": str(d / "authority"),
           "COPILOT_CLI_MATERIALIZATION_ATTEMPTS": "2",
           "COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS": "0"}
    result = subprocess.run(["bash", "-c", stub, "fixture", str(dispatcher),
                             str(d / "request.json"), action],
                            env=env, text=True, capture_output=True, timeout=60)
    if ok is not None:
        assert (result.returncode == 0) == ok, (action, drift, at, result.stdout, result.stderr)
    return result

def intent(d):
    paths = list((d / "authority").glob("request-*.json"))
    assert len(paths) == 1
    return json.loads(paths[0].read_text())

def prepare(d):
    run(d, "--prepare-disabled-ghosts")
    assert (d / "dispatches").read_text() == "0"
    value = intent(d)
    assert value["schemaVersion"] == a.PREPARED_INTENT_SCHEMA and value["state"] == "prepared"
    assert len(value["preparedSeal"]["candidates"]) == 3
    assert not list((d / "authority").glob("[0-9]*.json")), "prepare granted run/approval authority"
    (d / "collections").write_text("0")
    return value

def invoke(command, options, *, ok=True):
    argv = [command]
    for name, value in options.items():
        argv.extend(["--" + name.replace("_", "-"), str(value)])
    args = a.build_parser().parse_args(argv)
    result = io.StringIO()
    try:
        with contextlib.redirect_stdout(result):
            args.function(args)
    except SystemExit as error:
        assert not ok, (command, error)
        return str(error)
    assert ok, f"{command} unexpectedly passed"
    return result.getvalue().strip()

def local_prepare(d):
    # Unit setup uses the SAME validated evidence/semantic projection as the
    # collector. Dispatch integration still performs both real shell collections.
    f = json.loads((d / "fixture.json").read_text())
    candidates = []
    for run_value in f["runs"]:
        evidence = {
            "run": run_value, "workflow": {"id": 313, "path": workflow, "state": "disabled_manually"},
            "jobs": {"total_count": 0, "jobs": []}, "pending": [], "approvals": [],
            "artifacts": {"total_count": 0, "artifacts": []},
            "compare": f["compare"], "historical_workflow": f["historical"],
            "now_epoch": int(a.utc_now().timestamp()), "minimum_age_seconds": 600,
        }
        facts = a.validate_unmaterialized_run_evidence(
            **evidence, repository=repository, current_master=master,
            require_disabled_workflow=True,
        )
        candidates.append(a.semantic_ghost_evidence(evidence, facts)["candidate"])
    paths = subprocess.check_output([policy_script, "workflows"], text=True).splitlines()
    inventory = {"paths": sorted(".github/workflows/" + p for p in paths),
                 "statuses": ["queued", "in_progress", "waiting", "requested", "pending"],
                 "limitPerStatus": 100}
    observation = {"schemaVersion": a.TRANSITION_OBSERVATION_SCHEMA,
                   "repository": repository, "controlSha": master,
                   "inventorySha256": a.evidence_digest(inventory), "blockers": [],
                   "candidates": candidates,
                   "workflows": [{"id": 313, "path": workflow, "state": "disabled_manually"}] * len(candidates)}
    write(d / "observation.json", observation)
    normalized = a.validate_request_data(request, policy, repository, master)
    write(d / "normalized.json", normalized)
    write(d / "inputs.json", normalized["dispatchInputs"])
    options = {
        "request": d / "request.json", "normalized": d / "normalized.json",
        "inputs_file": d / "inputs.json", "policy_json": json.dumps(policy),
        "repository": repository, "current_master": master, "workflow_id": 313,
        "workflow_blob_sha": blob, "observation_json": d / "observation.json",
        "authority_dir": d / "authority", "repo_root": root,
    }
    invoke("prepare-disabled-ghosts", {**options, "owner_pid": os.getpid()})
    observation["workflows"] = [{"id": 313, "path": workflow, "state": "active"}] * len(candidates)
    write(d / "observation.json", observation)
    return options

def cleanup_options(d):
    return {
        "request": d / "request.json", "repository": repository, "workflow_id": 313,
        "workflow_path": workflow, "authority_dir": d / "authority", "repo_root": root,
    }

d = setup()
sealed = prepare(d)
run(d, "--prepare-disabled-ghosts", ok=False)
assert intent(d) == sealed, "repeat prepare renewed the seal"
for action in ("--resume-captured", "--dispatch", "--dispatch-prepared"):
    run(d, action, ok=False)
assert intent(d) == sealed
(d / "collections").write_text("0")
run(d, "--dispatch-prepared", state="active")
assert (d / "collections").read_text() == "2", "POST-A/POST-B did not both freshly collect"
assert (d / "dispatches").read_text() == "1"
assert intent(d)["state"] == "bound" and intent(d)["preparedSeal"] == sealed["preparedSeal"]
for action in ("--dispatch-prepared", "--discard-prepared", "--prepare-disabled-ghosts"):
    run(d, action, state="active" if action == "--dispatch-prepared" else "disabled_manually", ok=False)
assert (d / "dispatches").read_text() == "1", "post-CAS replay"
run(d, "--resume-captured", state="active")

# Every boundary drift is tested at BOTH fresh checkpoints. Failures before CAS
# retain prepared authority; cleanup is tested separately without fabricating a
# restored file identity for cases that deliberately corrupt private metadata.
malformed_filters = [f"malformed-{field}-{kind}" for field in ("path", "head_branch")
                     for kind in ("missing", "null")]
forged_inventory = ["forged-disabled", "forged-unprotected-path", "forged-nonmaster-branch"]
for mutation in malformed_filters + forged_inventory:
    d = setup()
    result = run(d, "--prepare-disabled-ghosts", drift=mutation, ok=False)
    if mutation in forged_inventory:
        assert "observation run detail rejected" in result.stderr, result.stderr
    assert (d / "dispatches").read_text() == "0"
    assert not list((d / "authority").glob("request-*.json")), "malformed PRE created authority"
mutations = (
    "added missing replaced duplicate empty overflow incomplete other "
    "run-id run-workflow run-path event head branch attempt repository url title status conclusion "
    "created_at updated_at run_started_at all-timestamps jobs pending approvals artifacts "
    "ancestry compare-final historical-guard historical-source workflow-id workflow-path "
    "blob master state dirty request seal intent-mode capture capture-replace"
).split() + malformed_filters + forged_inventory
for at in (1, 2):
    for mutation in mutations:
        d = setup()
        local_prepare(d)
        previous = intent(d)
        result = run(d, "--dispatch-prepared", state="active", drift=mutation, at=at, ok=False)
        if mutation in forged_inventory:
            assert "observation run detail rejected" in result.stderr, result.stderr
            assert intent(d) == previous, "forged inventory advanced prepared authority"
            assert (d / "authority" / previous["captureFile"]).stat().st_size == 0
        assert (d / "dispatches").read_text() == "0", (at, mutation)
        assert intent(d)["state"] == "prepared", (at, mutation)
        if mutation not in {"request", "seal", "intent-mode", "capture", "capture-replace"}:
            run(d, "--discard-prepared")
            assert not list((d / "authority").glob("request-*.json"))
    print(f"prepared_checkpoint_mutations=PASS checkpoint={at} cases={len(mutations)}", flush=True)

for state, mutation in (
    ("active", ""), ("disabled_manually", "empty"), ("disabled_manually", "jobs"),
    ("disabled_manually", "other"), ("disabled_manually", "promotion"),
):
    d = setup()
    run(d, "--prepare-disabled-ghosts", state=state, drift=mutation, ok=False)
    assert (d / "dispatches").read_text() == "0"
    assert not list((d / "authority").glob("request-*.json"))
d = setup()
run(d, "--dispatch-prepared", state="active", ok=False)
run(d, "--discard-prepared", ok=False)
prepare(d)
run(d, "--discard-prepared", state="active", ok=False)
run(d, "--discard-prepared")

# Two processes may observe the same provider state; only the repository-lock
# winner may create or consume the generation.
for action in ("--prepare-disabled-ghosts", "--dispatch-prepared"):
    d = setup()
    if action == "--dispatch-prepared": prepare(d)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: run(d, action, state=(
            "active" if action == "--dispatch-prepared" else "disabled_manually"
        ), ok=None), range(2)))
    assert sorted(result.returncode == 0 for result in results) == [False, True], [
        (result.stdout, result.stderr) for result in results]
    assert (d / "dispatches").read_text() == ("1" if action == "--dispatch-prepared" else "0")

for capture in ("empty", "multiple", "nonzero"):
    d = setup()
    prepare(d)
    run(d, "--dispatch-prepared", state="active", capture=capture, ok=capture == "nonzero")
    for action in ("--discard-prepared", "--dispatch-prepared"):
        run(d, action, state="active" if action == "--dispatch-prepared" else "disabled_manually", ok=False)
    assert (d / "dispatches").read_text() == "1", "ambiguous capture redispatched"

# Stale-control and expired prepares remain blocking, but clean actual-current
# master may explicitly discard them after freshly observing disabled state.
d = setup()
options = local_prepare(d)
old_now = a.utc_now
a.utc_now = lambda: old_now() + a.dt.timedelta(seconds=a.PREPARED_TTL_SECONDS + 1)
invoke("verify-prepared", options, ok=False)
assert a.find_blocking_authorities(d / "authority", json.loads((d / "normalized.json").read_text()))
discard_snapshot = invoke("prepared-context", cleanup_options(d))
invoke("discard-prepared", {**cleanup_options(d), "expected_snapshot": discard_snapshot})
a.utc_now = old_now
d = setup(); options = local_prepare(d)
f = json.loads((d / "fixture.json").read_text()); f["master"] = "c" * 40
write(d / "fixture.json", f)
run(d, "--dispatch-prepared", state="active", actual="c" * 40, ok=False)
run(d, "--discard-prepared", actual="c" * 40)

for field, change in (
    ("policy_json", json.dumps({**policy, "titleTemplate": "different {subject_sha}"})),
    ("workflow_id", 314), ("workflow_blob_sha", "e" * 40),
    ("current_master", "c" * 40),
):
    for checkpoint in ("verify-prepared", "dispatch-prepared"):
        d = setup(); options = local_prepare(d)
        snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
        extras = {"expected_snapshot": snapshot, "owner_pid": os.getpid()} if checkpoint == "dispatch-prepared" else {}
        invoke(checkpoint, {**options, **extras, field: change}, ok=False)
        assert intent(d)["state"] == "prepared"

for mutation in ("request-mode", "request-hardlink", "request-symlink", "intent-mode",
                 "intent-hardlink", "intent-symlink", "capture-mode", "capture-hardlink",
                 "capture-symlink", "capture-replace", "seal", "inventory", "version", "owner",
                 "event-metadata", "environment-metadata", "title-metadata", "inputs-file"):
    for checkpoint in ("verify-prepared", "dispatch-prepared"):
        d = setup(); options = local_prepare(d)
        snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
        value = intent(d); path = next((d / "authority").glob("request-*.json"))
        target = d / "request.json" if mutation.startswith("request") else (
            d / "authority" / value["captureFile"] if mutation.startswith("capture") else path)
        if mutation.endswith("-mode"): target.chmod(0o644)
        elif mutation.endswith("-hardlink"): os.link(target, d / "alias")
        elif mutation.endswith("-symlink"):
            saved = d / "saved"; target.rename(saved); target.symlink_to(saved)
        elif mutation == "capture-replace":
            target.unlink(); target.touch(mode=0o600)
        elif mutation == "inventory":
            observation = json.loads((d / "observation.json").read_text())
            observation["inventorySha256"] = "e" * 64
            write(d / "observation.json", observation)
        elif mutation == "inputs-file":
            write(d / "inputs.json", {**request["inputs"], "build_run_id": "99"})
        else:
            if mutation == "seal": value["preparedSeal"]["sealSha256"] = "e" * 64
            if mutation == "version": value["version"] += 1
            if mutation == "owner": value["ownerPid"] += 1
            if mutation == "event-metadata": value["event"] = "push"
            if mutation == "environment-metadata": value["environment"] = "oci-production"
            if mutation == "title-metadata": value["displayTitleTemplate"] = "different"
            write(path, value)
        extras = {"expected_snapshot": snapshot, "owner_pid": os.getpid()} if checkpoint == "dispatch-prepared" else {}
        invoke(checkpoint, {**options, **extras}, ok=False)
        if mutation.endswith("-metadata"):
            invoke("prepared-context", cleanup_options(d), ok=False)

# The frozen old payload reader must accept v1 and reject actual generated v2,
# never reinterpret prepared as dispatching. No Git history is needed in CI.
d = setup(); options = local_prepare(d)
old_reader_path = root / "infra/azure/agents/fixtures/copilot-cli-intent-v1-reader.py"
old_source = old_reader_path.read_bytes()
assert hashlib.sha256(old_source).hexdigest() == "d5a876f447030b0720afd3fc1f33f6ed8d512a220b3f7fbd7f465fddbec9e2d7", \
    "historical v1 reader fixture integrity changed"
namespace = {"__name__": "old_authority"}
exec(compile(old_source, str(old_reader_path), "exec"), namespace)
legacy_read = namespace["validate_intent"]
# Independent v1 payload, not derived from the current helper or the v2 intent.
v1 = {
    "schemaVersion": "betstan.copilot-cli-dispatch-intent.v1",
    "requestKey": "f" * 64,
    "repository": "example/repo",
    "operation": "production-deploy",
    "workflow": ".github/workflows/production-deploy.yml",
    "workflowId": 301,
    "workflowBlobSha": "2" * 40,
    "event": "workflow_dispatch",
    "environment": "production-emergency",
    "controlSha": "1" * 40,
    "subjectSha": "1" * 40,
    "targetSha": None,
    "inputs": {"approved_sha": "1" * 40, "build_run_id": "42"},
    "inputHash": hashlib.sha256(json.dumps(
        {"approved_sha": "1" * 40, "build_run_id": "42"},
        sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest(),
    "displayTitleTemplate": "deploy {subject_sha}",
    "authorityOwner": "github-copilot-cli",
    "createdAt": "2026-01-01T00:00:00Z",
    "expiresAt": "2026-01-02T00:00:00Z",
    "state": "dispatching",
    "version": 1,
    "ownerPid": 123,
    "captureFile": "dispatch-" + "0" * 32 + ".log",
    "dispatchStatus": None,
    "runId": None,
    "runUrl": None,
}
assert legacy_read(copy.deepcopy(v1), v1["requestKey"]) == v1
bound_v1 = {**v1, "state": "bound", "runId": 7001,
            "runUrl": "https://github.com/example/repo/actions/runs/7001",
            "dispatchStatus": 0, "version": 2}
assert legacy_read(copy.deepcopy(bound_v1), v1["requestKey"]) == bound_v1

def legacy_rejects(value, key, message):
    before = copy.deepcopy(value)
    try:
        legacy_read(value, key)
    except SystemExit as error:
        assert str(error) == message, str(error)
    else:
        raise AssertionError("legacy reader accepted an incompatible intent")
    assert value == before, "legacy rejection mutated the input"

for missing in v1:
    legacy_rejects({k: v for k, v in v1.items() if k != missing}, v1["requestKey"],
                   "dispatch intent has an unexpected schema")
legacy_rejects({**v1, "extra": None}, v1["requestKey"],
               "dispatch intent has an unexpected schema")
legacy_rejects([], v1["requestKey"], "dispatch intent has an unexpected schema")
for state in ("prepared", "issued", "retired", "", None):
    legacy_rejects({**v1, "state": state}, v1["requestKey"],
                   "dispatch intent state is invalid")
prepared_v2 = intent(d)
assert prepared_v2["schemaVersion"] == "betstan.copilot-cli-dispatch-intent.v2"
assert prepared_v2["state"] == "prepared"
assert prepared_v2["preparedSeal"], "probe did not generate a sealed prepare"
legacy_rejects(prepared_v2, prepared_v2["requestKey"],
               "dispatch intent has an unexpected schema")
# Independently exercise the version and state barriers even without v2's keys.
legacy_rejects({**v1, "schemaVersion": prepared_v2["schemaVersion"]}, v1["requestKey"],
               "dispatch intent schema version is unsupported")
legacy_rejects({**v1, "state": prepared_v2["state"]}, v1["requestKey"],
               "dispatch intent state is invalid")
assert intent(d) == prepared_v2, "old-reader probe changed prepared authority"
print("offline_v1_reader_compatibility=PASS", flush=True)

# Discard-versus-CAS and ABA use exact internal snapshot tokens, not run IDs.
snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
discard_snapshot = invoke("prepared-context", cleanup_options(d))
with open(d / "authority/.repository-claim.lock", "r+") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()}, ok=False)
    invoke("discard-prepared", {**cleanup_options(d), "expected_snapshot": discard_snapshot}, ok=False)
    assert intent(d)["state"] == "prepared"
    fcntl.flock(lock, fcntl.LOCK_UN)
invoke("discard-prepared", {**cleanup_options(d), "expected_snapshot": discard_snapshot})
invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()}, ok=False)
options = local_prepare(d)
invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()}, ok=False)
snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
discard_snapshot = invoke("prepared-context", cleanup_options(d))
invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()})
invoke("discard-prepared", {**cleanup_options(d), "expected_snapshot": discard_snapshot}, ok=False)
assert intent(d)["state"] == "dispatching"
base_options = {k: v for k, v in options.items() if k not in {"request", "inputs_file", "observation_json"}}
invoke("cancel-intent", {**base_options, "expected_version": 2, "owner_pid": os.getpid()}, ok=False)
invoke("bind-intent", base_options, ok=False)  # crash after CAS, no captured URL
invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()}, ok=False)
for _ in range(3):
    d = setup(); options = local_prepare(d)
    snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
    cleanup = {**cleanup_options(d), "expected_snapshot": invoke("prepared-context", cleanup_options(d))}
    dispatch = {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()}
    commands = []
    for command, values in (("discard-prepared", cleanup), ("dispatch-prepared", dispatch)):
        argv = [str(helper), command]
        for name, value in values.items():
            argv.extend(["--" + name.replace("_", "-"), str(value)])
        commands.append(argv)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda argv: subprocess.run(
            argv, capture_output=True, text=True, timeout=15,
        ), commands))
    assert sorted(result.returncode == 0 for result in results) == [False, True]
    assert not list((d / "authority").glob("request-*.json")) or intent(d)["state"] == "dispatching"
for action in ("--prepare-disabled-ghosts", "--dispatch-prepared", "--discard-prepared"):
    d = setup()
    wrong = copy.deepcopy(request)
    wrong["operation"] = "production-deploy"
    wrong["inputs"] = {"approved_sha": master, "build_run_id": "42"}
    write(d / "request.json", wrong)
    run(d, action, ok=False)
    assert (d / "dispatches").read_text() == "0"
dispatch_source = dispatcher.read_text()
assert dispatch_source.count('\ngh workflow run "$workflow" \\') == 1
transition_source = dispatch_source.split("prepared_checkpoint() {", 1)[1].split(
    "summarize_prerequisite_failure()", 1)[0]
for prohibited in ("EXCLUDE_RUN_ID", "/cancel", "/rerun", "/approvals", "workflow enable", "workflow disable"):
    assert prohibited not in transition_source, prohibited
print("prepared_authority_metadata_cas_tests=PASS", flush=True)

# Expiry is checked again after slow work inside the lock, not just on entry.
for slow_phase, overshoot in (("blocker-scan", 0), ("post-b-request", 1)):
    d = setup(); options = local_prepare(d)
    before = intent(d)
    snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
    expiry = a.parse_utc(before["expiresAt"], "expiry")
    clock = [expiry - a.dt.timedelta(seconds=1)]
    original_clock, original_scan, original_request = a.utc_now, a.find_blocking_authorities, a.special_request
    calls = [0]
    def slow_scan(*args):
        result = original_scan(*args)
        clock[0] = expiry
        return result
    def slow_request(*args):
        result = original_request(*args)
        calls[0] += 1
        if calls[0] == 2:  # the second request read is inside POST-B's lock
            clock[0] = expiry + a.dt.timedelta(seconds=overshoot)
        return result
    a.utc_now = lambda: clock[0]
    if slow_phase == "blocker-scan": a.find_blocking_authorities = slow_scan
    else: a.special_request = slow_request
    try:
        error = invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot,
                                           "owner_pid": os.getpid()}, ok=False)
        assert "expired" in error
        assert intent(d) == before and (d / "dispatches").read_text() == "0"
        assert (d / "authority" / before["captureFile"]).stat().st_size == 0
        cleanup = invoke("prepared-context", cleanup_options(d))
        invoke("discard-prepared", {**cleanup_options(d), "expected_snapshot": cleanup})
    finally:
        a.utc_now, a.find_blocking_authorities, a.special_request = original_clock, original_scan, original_request

# Retire the exact claimed run through the existing terminal/jobless validator.
# The old bound generation stays spent; only retirement admits a NEW prepare.
d = setup(); options = local_prepare(d)
old_snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
old_capture = intent(d)["captureFile"]
invoke("dispatch-prepared", {**options, "expected_snapshot": old_snapshot, "owner_pid": os.getpid()})
new_run = json.loads((d / "fixture.json").read_text())["newRun"]
(d / "authority" / old_capture).write_text(f"https://github.com/{repository}/actions/runs/{new_run}\n")
transport_options = {k: v for k, v in options.items() if k not in {"request", "inputs_file", "observation_json"}}
invoke("record-dispatch-status", {**transport_options, "expected_version": 2,
                                 "expected_capture_file": old_capture, "dispatch_status": 0})
invoke("bind-intent", {**transport_options, "expected_capture_file": old_capture})
spent = intent(d)
observation = json.loads((d / "observation.json").read_text())
observation["workflows"] = [{"id": 313, "path": workflow, "state": "disabled_manually"}] * 3
write(d / "observation.json", observation)
invoke("prepare-disabled-ghosts", {**options, "owner_pid": os.getpid()}, ok=False)
record = json.loads((d / "authority" / f"{new_run}.json").read_text())
terminal = {
    "id": new_run, "workflow_id": 313, "path": workflow, "event": "workflow_dispatch",
    "head_sha": master, "head_branch": "master", "head_repository": {"full_name": repository},
    "display_title": record["displayTitle"], "run_attempt": 1,
    "status": "completed", "conclusion": "cancelled",
}
write(d / "terminal.json", terminal)
write(d / "jobs.json", {"total_count": 0, "jobs": []})
write(d / "pending.json", [])
retire_options = {k: v for k, v in transport_options.items() if k != "normalized"}
invoke("retire-inert-claim", {**retire_options, "run_id": new_run,
                            "run_json": d / "terminal.json", "jobs_json": d / "jobs.json",
                            "pending_json": d / "pending.json"})
assert json.loads((d / "authority" / f"{new_run}.json").read_text())["state"] == "retired"
options = local_prepare(d)
replacement = intent(d)
assert replacement["captureFile"] != old_capture and replacement["state"] == "prepared"
archives = list((d / "authority").glob("spent-*.json"))
assert len(archives) == 1 and json.loads(archives[0].read_text()) == spent
assert (d / "authority" / old_capture).read_text().endswith(f"/{new_run}\n")
invoke("dispatch-prepared", {**options, "expected_snapshot": old_snapshot, "owner_pid": os.getpid()}, ok=False)
replacement_snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
argvs = []
for snapshot in (old_snapshot, replacement_snapshot):
    values = {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()}
    argv = [str(helper), "dispatch-prepared"]
    for name, value in values.items(): argv.extend(["--" + name.replace("_", "-"), str(value)])
    argvs.append(argv)
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(lambda argv: subprocess.run(argv, text=True, capture_output=True, timeout=15), argvs))
assert results[0].returncode != 0, "spent snapshot consumed replacement"
if results[1].returncode != 0:  # nonblocking contention requires a fresh verification
    snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
    invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()})
assert intent(d)["state"] == "dispatching"
before_stale = intent(d)
# Version is deliberately the same in the replacement; the capture generation,
# not a coincidental integer version, rejects delayed old status and bind calls.
invoke("record-dispatch-status", {**transport_options, "expected_version": 2,
                                 "expected_capture_file": old_capture, "dispatch_status": 0}, ok=False)
invoke("bind-intent", {**transport_options, "expected_capture_file": old_capture}, ok=False)
assert intent(d) == before_stale
assert json.loads(archives[0].read_text()) == spent
print("prepared_retirement_replacement_expiry_tests=PASS", flush=True)
print("prepared_dispatch_integration_tests=PASS")
PY

echo "copilot_cli_dispatch_tests=PASS"
