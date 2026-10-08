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
    "infra/azure/agents/fixtures/copilot-cli-observation-v1-reader.py",
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
elif mode == "common":
    request["operation"] = "common-package-publish"
    request["inputs"] = {
        "source_sha": sha,
        "confirmation": "PUBLISH COMMON PACKAGE EXACT SHA",
    }
with open(path, "w", encoding="utf-8") as handle:
    json.dump(request, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PY
}

git() {
  local workflow="production-deploy.yml"
  [[ "${STUB_COMMON_REQUEST:-false}" != "true" ]] || workflow="common-package-publish.yml"
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
      if [[ "$1" = "rev-parse" && "$2" = "$SHA:.github/workflows/$workflow" ]]; then
        printf '%s\n' "$BLOB"
      else
        echo "unexpected git call: $*" >&2
        return 1
      fi
      ;;
  esac
}

gh() {
  local workflow="production-deploy.yml" title="deploy $SHA"
  if [[ "${STUB_COMMON_REQUEST:-false}" = "true" ]]; then
    workflow="common-package-publish.yml"
    title="common-package publish $SHA"
  fi
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
    "user"|"repos/$REPOSITORY/environments/common-package-release"|"repos/$REPOSITORY/environments/common-package-release/deployment-branch-policies?per_page=100"|"repos/$REPOSITORY/environments/common-package-release/secrets?per_page=100")
      [[ "${STUB_COMMON_REQUEST:-false}" = "true" ]] || {
        echo "unrelated operation queried Common prerequisites" >&2
        return 1
      }
      local count=0 mode="${STUB_COMMON_CONFIGURATION:-valid}"
      [[ ! -f "$common_prerequisite_count_file" ]] ||
        count="$(cat "$common_prerequisite_count_file")"
      if [[ "$endpoint" = "repos/$REPOSITORY/environments/common-package-release" ]]; then
        count=$((count + 1))
        printf '%s\n' "$count" >"$common_prerequisite_count_file"
      fi
      if [[ -n "${STUB_COMMON_DRIFT:-}" && "$count" -ge 2 ]]; then
        mode="$STUB_COMMON_DRIFT"
      fi
      if [[ "$endpoint" = *"/secrets?per_page=100" ]]; then
        [[ "$*" = *"--paginate --slurp"* ]] || {
          echo "Common secret metadata was not completely paginated" >&2
          return 1
        }
      fi
      python3 - "$endpoint" "$mode" <<'PY'
import json
import sys

endpoint, mode = sys.argv[1:]
kind = (
    "actor" if endpoint == "user" else
    "branches" if "/deployment-branch-policies?" in endpoint else
    "secrets" if "/secrets?" in endpoint else "environment"
)
if mode == kind + "-api-error":
    raise SystemExit("simulated Common metadata API failure")
if mode == "malformed-" + kind:
    print("{")
    raise SystemExit(0)
actor = {"id": 901}
gate = {
    "type": "required_reviewers", "prevent_self_review": False,
    "reviewers": [{"type": "User", "reviewer": {"id": 901}}],
}
environment = {
    "name": "common-package-release", "can_admins_bypass": False,
    "protection_rules": [gate, {"type": "branch_policy"}],
    "deployment_branch_policy": {
        "protected_branches": False, "custom_branch_policies": True,
    },
}
branches = {"total_count": 1, "branch_policies": [{"name": "master", "type": "branch"}]}
secrets = [{"total_count": 1, "secrets": [{"name": "NPM_TOKEN"}]}]
if mode == "unprotected":
    environment["protection_rules"] = []
    environment["deployment_branch_policy"] = None
elif mode == "wrong-environment":
    environment["name"] = "different-environment"
elif mode == "admin-bypass":
    environment["can_admins_bypass"] = True
elif mode == "missing-bypass":
    del environment["can_admins_bypass"]
elif mode == "no-reviewer":
    gate["reviewers"] = []
elif mode == "wrong-reviewer":
    gate["reviewers"][0]["reviewer"]["id"] = 902
elif mode == "team-reviewer":
    gate["reviewers"][0]["type"] = "Team"
elif mode == "self-review":
    gate["prevent_self_review"] = True
elif mode == "duplicate-reviewer":
    environment["protection_rules"].append(gate.copy())
elif mode == "bad-actor":
    actor["id"] = True
elif mode == "unknown-rule":
    environment["protection_rules"].append({"type": "unknown"})
elif mode == "missing-branch-rule":
    environment["protection_rules"] = [gate]
elif mode == "protected-branches":
    environment["deployment_branch_policy"] = {
        "protected_branches": True, "custom_branch_policies": False,
    }
elif mode == "numeric-branch-flags":
    environment["deployment_branch_policy"] = {
        "protected_branches": 0, "custom_branch_policies": 1,
    }
elif mode == "nonfinite-field":
    environment["unexpected"] = float("nan")
elif mode == "tag-rule":
    branches["branch_policies"][0]["type"] = "tag"
elif mode == "wildcard":
    branches["branch_policies"][0]["name"] = "*"
elif mode == "incomplete-branches":
    branches["total_count"] = 2
elif mode == "missing-token":
    secrets[0]["secrets"][0]["name"] = "UNRELATED_SECRET"
elif mode == "incomplete-secrets":
    secrets[0]["total_count"] = 2
elif mode == "duplicate-secrets":
    secrets[0]["total_count"] = 2
    secrets[0]["secrets"].append({"name": "NPM_TOKEN"})
elif mode == "inconsistent-pages":
    secrets.append({"total_count": 2, "secrets": [{"name": "UNRELATED_SECRET"}]})
elif mode == "bad-secret-name":
    secrets[0]["secrets"][0]["name"] = True
elif mode == "empty-secret-pages":
    secrets = []
elif mode == "paginated":
    secrets = [
        {"total_count": 101, "secrets": [{"name": f"OTHER_{i}"} for i in range(100)]},
        {"total_count": 101, "secrets": [{"name": "NPM_TOKEN"}]},
    ]
elif mode == "wait-timer":
    environment["protection_rules"].append({"type": "wait_timer", "wait_timer": 5})
elif mode == "bad-wait-timer":
    environment["protection_rules"].append({"type": "wait_timer", "wait_timer": True})
encoded = json.dumps({
    "actor": actor, "environment": environment, "branches": branches, "secrets": secrets,
}[kind])
if mode == "duplicate-field" and kind == "environment":
    encoded = encoded.replace(
        '"can_admins_bypass": false',
        '"can_admins_bypass": true, "can_admins_bypass": false',
    )
print(encoded)
PY
      ;;
    "repos/$REPOSITORY/git/ref/heads/master")
      printf '%s\n' "$SHA"
      ;;
    "repos/$REPOSITORY/actions/workflows/$workflow")
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
          "$WORKFLOW_ID" ".github/workflows/$workflow" \
          "${STUB_WORKFLOW_STATE:-active}"
      else
        printf '{"id":%s,"path":".github/workflows/%s","state":"%s"}\n' \
          "$WORKFLOW_ID" "$workflow" "${STUB_WORKFLOW_STATE:-active}"
      fi
      ;;
    "repos/$REPOSITORY/contents/.github/workflows/$workflow?ref=$SHA")
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
        printf '{"id":%s,"workflow_id":%s,"path":".github/workflows/%s","display_title":"%s","event":"workflow_dispatch","head_sha":"%s","head_branch":"master","head_repository":{"full_name":"%s"},"run_attempt":1,"status":"completed","conclusion":"failure"}\n' \
          "$run_id" "$WORKFLOW_ID" "$workflow" "$title" "$SHA" "$REPOSITORY"
      else
        printf '{"id":%s,"workflow_id":%s,"path":".github/workflows/%s","display_title":"%s","event":"workflow_dispatch","head_sha":"%s","head_branch":"master","head_repository":{"full_name":"%s"},"run_attempt":1,"status":"waiting","conclusion":null}\n' \
          "$run_id" "$WORKFLOW_ID" "$workflow" "$title" "$SHA" "$REPOSITORY"
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

(
  export STUB_COMMON_REQUEST=true
  request_file="$tmp_dir/common-request.json"
  write_request common
  for mode in \
    unprotected wrong-environment admin-bypass missing-bypass no-reviewer \
    wrong-reviewer team-reviewer self-review duplicate-reviewer bad-actor \
    unknown-rule missing-branch-rule protected-branches numeric-branch-flags \
    nonfinite-field tag-rule wildcard \
    incomplete-branches missing-token incomplete-secrets duplicate-secrets \
    inconsistent-pages bad-secret-name empty-secret-pages bad-wait-timer \
    duplicate-field actor-api-error environment-api-error branches-api-error \
    secrets-api-error malformed-actor malformed-environment malformed-branches \
    malformed-secrets; do
    case_dir="$tmp_dir/common-$mode"
    mkdir -m 700 "$case_dir"
    export common_prerequisite_count_file="$case_dir/prerequisite-count"
    export dispatch_count_file="$case_dir/dispatch-count"
    if STUB_COMMON_CONFIGURATION="$mode" TEST_AUTHORITY_DIR="$case_dir/authority" \
      run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
      echo "Common publication accepted invalid prerequisites: $mode" >&2
      exit 1
    fi
    grep -Eqi 'Common publication|identify the Common' "$error_file" || {
      cat "$error_file" >&2
      echo "Common fixture failed outside its prerequisite guard: $mode" >&2
      exit 1
    }
    [[ ! -f "$dispatch_count_file" ]] || {
      echo "Common prerequisite failure dispatched a workflow: $mode" >&2
      exit 1
    }
    python3 - "$case_dir/authority" <<'PY'
from pathlib import Path
import sys
authority = Path(sys.argv[1])
assert not list(authority.glob("request-*.json")), "preflight created a one-use intent"
assert not list(authority.glob("[0-9]*.json")), "preflight issued run authority"
PY
  done

  for mode in valid paginated wait-timer; do
    case_dir="$tmp_dir/common-$mode"
    mkdir -m 700 "$case_dir"
    export common_prerequisite_count_file="$case_dir/prerequisite-count"
    export dispatch_count_file="$case_dir/dispatch-count"
    export captured_inputs_file="$case_dir/inputs.json"
    STUB_COMMON_CONFIGURATION="$mode" TEST_AUTHORITY_DIR="$case_dir/authority" \
      run_dispatcher "$request_file" >"$output_file" 2>"$error_file" || {
        cat "$error_file" >&2
        exit 1
      }
    grep -q 'dispatch=READY operation=common-package-publish' "$output_file"
    [[ ! -f "$dispatch_count_file" ]]
    STUB_COMMON_CONFIGURATION="$mode" TEST_AUTHORITY_DIR="$case_dir/authority" \
      run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file" || {
        cat "$error_file" >&2
        exit 1
      }
    grep -q 'dispatch=ACCEPTED run_id=7001' "$output_file"
    [[ "$(cat "$dispatch_count_file")" = 1 ]]
    [[ "$(cat "$common_prerequisite_count_file")" -ge 3 ]]
    python3 - "$captured_inputs_file" "$SHA" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    assert json.load(handle) == {
        "source_sha": sys.argv[2],
        "confirmation": "PUBLISH COMMON PACKAGE EXACT SHA",
    }, "Common transport inputs changed"
PY
    if STUB_COMMON_CONFIGURATION="$mode" TEST_AUTHORITY_DIR="$case_dir/authority" \
      run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
      echo "Common preflight revived an already issued request" >&2
      exit 1
    fi
    [[ "$(cat "$dispatch_count_file")" = 1 ]]
  done

  for drift in admin-bypass missing-token; do
    case_dir="$tmp_dir/common-late-$drift"
    mkdir -m 700 "$case_dir"
    export common_prerequisite_count_file="$case_dir/prerequisite-count"
    export dispatch_count_file="$case_dir/dispatch-count"
    export captured_inputs_file="$case_dir/inputs.json"
    if STUB_COMMON_DRIFT="$drift" TEST_AUTHORITY_DIR="$case_dir/authority" \
      run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file"; then
      echo "Common publication dispatched after prerequisite drift: $drift" >&2
      exit 1
    fi
    grep -qi 'Common publication' "$error_file" || {
      cat "$error_file" >&2
      exit 1
    }
    [[ "$(cat "$common_prerequisite_count_file")" -ge 2 ]]
    [[ ! -f "$dispatch_count_file" ]]
    python3 - "$case_dir/authority" <<'PY'
from pathlib import Path
import sys
assert not list(Path(sys.argv[1]).glob("request-*.json")), "pristine intent was not cancelled"
PY
    TEST_AUTHORITY_DIR="$case_dir/authority" \
      run_dispatcher "$request_file" --dispatch >"$output_file" 2>"$error_file" || {
        cat "$error_file" >&2
        exit 1
      }
    [[ "$(cat "$dispatch_count_file")" = 1 ]]
  done
  echo "common_publication_prerequisite_tests=PASS"
)

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
        "checkpoint_source_sha": control_sha,
        "disk_checkpoint_run_id": "45",
        "resume_source_sha": control_sha,
        "phase": "apply-backfills",
        "prerequisite_run_id": "44",
        "baseline_recovery_run_id": "0",
        "baseline_recovery_source_sha": "none",
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
  STUB_EXPECT_ACTUAL_MASTER_EXCLUSIVITY=true STUB_RUN_JOBLESS=true \
  run_dispatcher "$request_file" --dispatch >"$output_file"
grep -qF "authority_state=issued" "$output_file"
grep -qF "job_gate_materialization=UNPROVEN next_action=observe-exact-run" "$output_file"
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

# Issued metadata with no job or pending gate is not materialization. Resume
# only the captured run; never create a replacement dispatch to make it appear.
STUB_RUN_ID=7001 STUB_RUN_JOBLESS=true \
  run_dispatcher "$request_file" --resume-run 7001 >"$output_file"
grep -qF "dispatch=READY run_id=7001 authority_state=issued" "$output_file"
grep -qF "job_gate_materialization=UNPROVEN next_action=observe-exact-run" "$output_file"
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
workflow = a.PREPARED_TRANSITION_WORKFLOWS["oci-live-data-rollout.yml"]
source = (root / workflow).read_bytes()
blob = hashlib.sha1(f"blob {len(source)}\0".encode() + source).hexdigest()
policy = json.loads(subprocess.check_output([policy_script, "get", "oci-live-data-dry-run"]))
request = {
    "schemaVersion": a.REQUEST_SCHEMA, "repository": repository,
    "operation": policy["operation"], "controlSha": master,
    "subjectSha": master, "targetSha": None,
    "inputs": {
        **policy["fixedInputs"], "approved_sha": master, "build_run_id": "42",
        "infrastructure_run_id": "45", "checkpoint_source_sha": master,
        "disk_checkpoint_run_id": "45", "resume_source_sha": master,
        "baseline_recovery_run_id": "0",
        "baseline_recovery_source_sha": "none",
    },
}
provider = temporary / "transition-provider.py"
# This provider has exactly one permitted mutation: the dispatcher's existing
# captured workflow-run command. Every other unexpected call is a test failure.
provider.write_text(r'''
import base64, fcntl, hashlib, io, json, os, sys, zipfile
from pathlib import Path
d = Path(os.environ["TRANSITION_CASE"])
lock = open(d / "provider.lock", "a")
fcntl.flock(lock, fcntl.LOCK_EX)
f = json.loads((d / "fixture.json").read_text())
args = sys.argv[1:]
if f.get("preflightRead"):
    with (d / "preflight-provider-calls").open("a") as calls:
        calls.write(json.dumps(args) + "\n")
    assert not set(args).intersection({"--method", "-X", "-f", "-F", "--input"}), \
        "retirement attempted a provider write"
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
def archive(files):
    bundle = io.BytesIO()
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as target:
        for name, content in files.items():
            target.writestr(name, content)
    sys.stdout.buffer.write(bundle.getvalue())
def upstream_run(run_id, workflow_id, path, event, title, conclusion="success"):
    return {
        "id": run_id, "workflow_id": workflow_id, "path": path,
        "display_title": title, "event": event, "head_sha": f["master"],
        "head_branch": "master",
        "head_repository": {"full_name": f["repository"]},
        "run_attempt": 1, "status": "completed", "conclusion": conclusion,
        "created_at": f"2026-01-01T00:{run_id:02d}:00Z",
        "updated_at": f"2026-01-01T00:{run_id:02d}:30Z",
    }
if args[:2] == ["repo", "view"]:
    print(f["repository"]); sys.exit()
if args[:2] == ["workflow", "run"]:
    assert not f.get("preflightRead"), "retirement attempted a provider write"
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
if f.get("preflightWorkflowState"):
    wf["state"] = f["preflightWorkflowState"]
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
    if f.get("preflightRead"):
        path = endpoint.removeprefix("contents/").split("?")[0]
        value = f["historical"] if path == f["path"] else {
            "type": "file", "path": path, "sha": f["preflightBlobs"][path],
        }
        if f.get("preflightNativeBlobDrift") == path:
            value = {**value, "sha": "e" * 40}
        output(value)
    elif f.get("zeroExecution"):
        output(f["historical"])
    elif endpoint.endswith("?ref=" + f["master"]):
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
elif endpoint == "environments/oci-migration/variables/OCI_RUNTIME_MODE":
    print("oke")
elif endpoint == "actions/workflows/oci-production-build.yml":
    output({"id": 304})
elif endpoint == "actions/workflows/oci-infrastructure.yml":
    output({"id": 310})
elif endpoint in {"actions/runs/42", "actions/runs/42/attempts/1"}:
    output(upstream_run(
        42, 304, ".github/workflows/oci-production-build.yml",
        "workflow_run", f'oci-build {f["master"]} upstream-41'
    ))
elif endpoint in {"actions/runs/45", "actions/runs/45/attempts/1"}:
    output(upstream_run(
        45, 310, ".github/workflows/oci-infrastructure.yml",
        "workflow_dispatch", f'oci-infrastructure finalize oke {f["master"]}'
    ))
elif endpoint == "actions/runs/42/artifacts?per_page=100":
    output({"total_count": 1, "artifacts": [{
        "id": 9042,
        "name": f'oci-image-provenance-{f["master"]}-42-1',
        "expired": False, "size_in_bytes": 4096,
    }]})
elif endpoint == "actions/runs/45/artifacts?per_page=100":
    output({"total_count": 2, "artifacts": [
        {
            "id": 9045, "name": "oci-infrastructure-provenance-45-1",
            "expired": False, "size_in_bytes": 4096,
        },
        {
            "id": 9145,
            "name": f'oci-release-disk-checkpoint-{f["master"]}-45-1',
            "expired": False, "size_in_bytes": 4096,
        },
    ]})
elif endpoint == "actions/artifacts/9042/zip":
    archive({"build-chain.txt": "\n".join([
        f'source_sha={f["master"]}', "build_run_id=42",
        "build_run_attempt=1", "registry_provider=ghcr",
        "registry_host=ghcr.io",
        "registry_repository=ghcr.io/vasilyevstan/betstan-images",
        "registry_public=true", "anonymous_pull=pass", "",
    ])})
elif endpoint == "actions/artifacts/9045/zip":
    archive({"provenance.env": "\n".join([
        f'source_sha={f["master"]}', "infrastructure_run_id=45",
        "infrastructure_run_attempt=1", "infrastructure_finalized=true",
        "runtime_mode=oke", "ghcr_build_run_id=42", "",
    ])})
elif endpoint == "actions/artifacts/9145/zip":
    checkpoint = {
        "schemaVersion": "k3s-release-disk-checkpoint.v1",
        "sourceSha": f["master"], "controlSha": f["master"],
        "infrastructureRunId": "45",
        "ghcrBuildRunId": "42", "producerRunId": "45",
        "producerRunAttempt": "1", "runtimeMode": "oke",
        "disposition": "NOT_APPLICABLE",
        "terminalStatus": "RELEASE_ELIGIBLE",
    }
    canonical = json.dumps(checkpoint, sort_keys=True, separators=(",", ":"))
    checkpoint["contentChecksumSha256"] = hashlib.sha256(canonical.encode()).hexdigest()
    archive({"checkpoint.json": json.dumps(
        checkpoint, sort_keys=True, separators=(",", ":")
    )})
elif endpoint.startswith("actions/workflows/") and "/runs?" in endpoint:
    output({"total_count": 0, "workflow_runs": []})
elif endpoint == "actions/workflows/998":
    output({"id": 998, "path": ".github/workflows/production-deploy.yml", "state": "active"})
elif endpoint == "actions/workflows/999":
    output({"id": 999, "path": ".github/workflows/oci-infrastructure.yml", "state": "disabled_manually"})
elif endpoint.startswith("compare/"):
    assert "--paginate" in args
    value = f.get("zeroCompare", f["compare"]) if endpoint.startswith(
        "compare/" + f.get("zeroExecution", {}).get("run", {}).get("head_sha", "!") + "..."
    ) else f["compare"]
    if f.get("preflightRead") and endpoint.startswith(
        "compare/" + f["preflightRead"]["run"]["head_sha"] + "..."
    ):
        value = f["preflightRead"]["compare"]
    if active and mutation == "ancestry": value["status"] = "diverged"
    if active and mutation == "compare-final": value["commits"][-1]["sha"] = "e" * 40
    output(value)
elif endpoint.startswith("actions/runs/"):
    suffix = endpoint.removeprefix("actions/runs/")
    run_id = int(suffix.split("/")[0])
    preflight = f.get("preflightRead") if run_id == f["newRun"] else None
    if preflight:
        if "/" not in suffix:
            reads = int((d / "preflight-reads").read_text()) if (d / "preflight-reads").exists() else 0
            reads += 1; save("preflight-reads", reads)
            drift = f.get("preflightDrift", "")
            if reads == f.get("preflightDriftAt", 2):
                if drift == "attempt": preflight["run"]["run_attempt"] = 2
                elif drift == "approval": preflight["approvals"][0]["comment"] += " changed"
                elif drift == "artifact": preflight["artifacts"] = {"total_count": 1, "artifacts": [{"id": 1}]}
                elif drift == "pending": preflight["pending"] = [{"environment": {"id": 91}}]
                elif drift == "master": f["master"] = "e" * 40
                elif drift == "workflow": f["preflightWorkflowState"] = "active"
                elif drift == "helper": f["preflightNativeBlobDrift"] = "infra/oci/scripts/lib.sh"
                elif drift == "local-helper": f["preflightLocalBlobDrift"] = "infra/oci/scripts/lib.sh"
                elif drift == "version":
                    p = d / "authority" / f'{run_id}.json'
                    value = json.loads(p.read_text()); value["version"] += 1
                    p.write_text(json.dumps(value))
                elif drift in {"capture", "capture-replace", "intent"}:
                    p = next((d / "authority").glob("request-*.json"))
                    value = json.loads(p.read_text())
                    if drift == "intent":
                        value["version"] += 1; p.write_text(json.dumps(value))
                    else:
                        p = d / "authority" / value["captureFile"]
                        if drift == "capture":
                            with p.open("a") as stream: stream.write("changed\n")
                        else:
                            p.rename(d / "old-capture")
                            p.write_bytes((d / "old-capture").read_bytes()); p.chmod(0o600)
                elif drift == "request":
                    p = d / "request.json"; value = json.loads(p.read_text())
                    value["inputs"]["build_run_id"] = "99"; p.write_text(json.dumps(value))
                f["preflightRead"] = preflight; save("fixture.json", json.dumps(f))
            output(preflight["run"])
        elif "/attempts/" in suffix:
            assert "/attempts/1" in suffix, "retirement requested a later attempt"
            value = preflight["attempts"][0]["jobs" if "/jobs?" in suffix else "run"]
            if "/jobs?" in suffix:
                assert "--paginate" in args
                pages = f.get("preflightJobPages", [value])
                for page in pages: output(page)
            else: output(value)
        elif "/pending_deployments?" in suffix:
            assert "--paginate" in args
            for page in f.get("preflightPendingPages", [preflight["pending"]]): output(page)
        elif "/approvals?" in suffix:
            assert "--paginate" in args
            for page in f.get("preflightApprovalPages", [preflight["approvals"]]): output(page)
        elif "/artifacts?" in suffix:
            assert "--paginate" in args
            for page in f.get("preflightArtifactPages", [preflight["artifacts"]]): output(page)
        else: raise AssertionError(args)
        sys.exit()
    zero = f.get("zeroExecution") if run_id == f["newRun"] else None
    if zero:
        if "/" not in suffix:
            reads = int((d / "zero-reads").read_text()) if (d / "zero-reads").exists() else 0
            reads += 1; save("zero-reads", reads)
            drift = os.environ.get("TRANSITION_ZERO_DRIFT", "")
            if reads >= int(os.environ.get("TRANSITION_ZERO_AT", "2")):
                if drift == "attempt": zero["run"]["run_attempt"] += 1
                elif drift == "approval": zero["approvals"].append({"state": "rejected"})
                elif drift == "artifact": zero["artifacts"] = {"total_count": 1, "artifacts": [{"id": 1}]}
                elif drift == "pending": zero["pending"] = [{"environment": {"id": 91}}]
                elif drift == "version":
                    p = d / "authority" / f'{run_id}.json'
                    record = json.loads(p.read_text()); record["version"] += 1
                    p.write_text(json.dumps(record))
                elif drift == "capture":
                    record = json.loads(next((d / "authority").glob("request-*.json")).read_text())
                    with (d / "authority" / record["captureFile"]).open("a") as stream:
                        stream.write("changed\n")
                f["zeroExecution"] = zero
                save("fixture.json", json.dumps(f))
            output(zero["run"])
        elif "/attempts/" in suffix:
            number = int(suffix.split("/attempts/")[1].split("/")[0])
            assert 1 <= number <= len(zero["attempts"]), "attempt history missing"
            output(zero["attempts"][number - 1]["jobs" if "/jobs?" in suffix else "run"])
        elif suffix.endswith("/pending_deployments"): output(zero["pending"])
        elif suffix.endswith("/approvals"): output(zero["approvals"])
        elif "/artifacts?" in suffix: output(zero["artifacts"])
        else: raise AssertionError(args)
        sys.exit()
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
provider_bin = temporary / "transition-provider-bin"
provider_bin.mkdir(mode=0o700)
provider_wrapper = provider_bin / "gh"
provider_wrapper.write_text(
    '#!/usr/bin/env bash\nexec python3 "$TRANSITION_PROVIDER" "$@"\n'
)
provider_wrapper.chmod(0o700)
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
    "rev-parse "*)
      if [[ ! -f "$TRANSITION_CASE/preflight-fixture" ]]; then
        printf '%s\n' "$TRANSITION_BLOB"
      else
      python3 -c '
import json, os, sys
from pathlib import Path
f = json.loads((Path(os.environ["TRANSITION_CASE"]) / "fixture.json").read_text())
path = sys.argv[1].split(":", 1)[-1]
print(("e" * 40 if f.get("preflightLocalBlobDrift") == path else
       f["preflightBlobs"][path]) if f.get("preflightRead") else os.environ["TRANSITION_BLOB"])
' "$2"
      fi ;;
    "cat-file -e"|"fetch --quiet"|"merge-base --is-ancestor")
      [[ "${TRANSITION_ZERO_DRIFT:-}" != non-ancestor ]] ;;
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

def run(d, action, *, state="disabled_manually", drift="", at=1, capture="", ok=True,
        actual=master, zero_drift="", zero_at=2):
    env = {**os.environ, "TRANSITION_CASE": str(d), "TRANSITION_ROOT": str(root),
           "TRANSITION_PROVIDER": str(provider), "TRANSITION_MASTER": actual,
           "TRANSITION_BLOB": blob, "TRANSITION_STATE": state, "TRANSITION_DRIFT": drift,
           "TRANSITION_DRIFT_AT": str(at), "TRANSITION_CAPTURE": capture,
           "TRANSITION_ZERO_DRIFT": zero_drift, "TRANSITION_ZERO_AT": str(zero_at),
           "PATH": str(provider_bin) + os.pathsep + os.environ["PATH"],
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
                   "target": {"workflow": "oci-live-data-rollout.yml", "path": workflow},
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

# The frozen v1 observation reader must accept a real v1-shaped projection and
# reject the generated v2 target-bound projection. The current reader must
# independently reject the old version and the missing target at both POST
# checkpoints without consuming or changing the prepared authority.
old_observation_reader_path = (
    root / "infra/azure/agents/fixtures/copilot-cli-observation-v1-reader.py"
)
old_observation_source = old_observation_reader_path.read_bytes()
assert hashlib.sha256(old_observation_source).hexdigest() == \
    "dde0ad0c1809825785670214b95a5e249ec375ba0c572534103a23869cc3bd7a", \
    "historical v1 observation reader fixture integrity changed"
old_observation_namespace = {"__name__": "old_observation_authority"}
exec(
    compile(
        old_observation_source,
        str(old_observation_reader_path),
        "exec",
    ),
    old_observation_namespace,
)
legacy_observation_read = old_observation_namespace["validate_observation"]
v2_observation = json.loads((d / "observation.json").read_text())
assert v2_observation["schemaVersion"] == a.TRANSITION_OBSERVATION_SCHEMA
assert v2_observation["target"] == {
    "workflow": "oci-live-data-rollout.yml",
    "path": workflow,
}
v1_observation = {
    name: copy.deepcopy(value)
    for name, value in v2_observation.items()
    if name != "target"
}
v1_observation["schemaVersion"] = \
    "betstan.live-data-transition-observation.v1"
assert legacy_observation_read(
    copy.deepcopy(v1_observation),
    repository,
    master,
    313,
    "active",
) == v1_observation

def legacy_observation_rejects(value, message):
    before = copy.deepcopy(value)
    try:
        legacy_observation_read(value, repository, master, 313, "active")
    except SystemExit as error:
        assert str(error) == message, str(error)
    else:
        raise AssertionError("legacy reader accepted an incompatible observation")
    assert value == before, "legacy observation rejection mutated the input"

legacy_observation_rejects(
    copy.deepcopy(v2_observation),
    "transition observation schema is invalid",
)
legacy_observation_rejects(
    {
        **copy.deepcopy(v1_observation),
        "schemaVersion": a.TRANSITION_OBSERVATION_SCHEMA,
    },
    "transition observation does not prove exclusive current control",
)

valid_observation_snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
prepared_observation_intent_path = next(
    (d / "authority").glob("request-*.json")
)
prepared_observation_intent_before = prepared_observation_intent_path.read_bytes()
prepared_observation_intent = json.loads(prepared_observation_intent_before)
prepared_observation_capture = (
    d / "authority" / prepared_observation_intent["captureFile"]
)

def observation_capture_identity():
    metadata = prepared_observation_capture.stat()
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )

prepared_observation_capture_before = prepared_observation_capture.read_bytes()
prepared_observation_capture_identity = observation_capture_identity()
assert prepared_observation_capture_before == b""
assert (d / "dispatches").read_text() == "0"

def current_observation_reader_rejects(value, message):
    write(d / "observation.json", value)
    verify_error = invoke("verify-prepared", options, ok=False)
    assert verify_error == message, verify_error
    dispatch_error = invoke(
        "dispatch-prepared",
        {
            **options,
            "expected_snapshot": valid_observation_snapshot,
            "owner_pid": os.getpid(),
        },
        ok=False,
    )
    assert dispatch_error == message, dispatch_error
    assert (
        prepared_observation_intent_path.read_bytes()
        == prepared_observation_intent_before
    )
    assert json.loads(prepared_observation_intent_path.read_text())["state"] == \
        "prepared"
    assert list((d / "authority").glob("dispatch-*.log")) == [
        prepared_observation_capture
    ]
    assert prepared_observation_capture.read_bytes() == \
        prepared_observation_capture_before
    assert observation_capture_identity() == \
        prepared_observation_capture_identity
    assert (d / "dispatches").read_text() == "0"

schema_v1_with_target = copy.deepcopy(v2_observation)
schema_v1_with_target["schemaVersion"] = \
    "betstan.live-data-transition-observation.v1"
current_observation_reader_rejects(
    schema_v1_with_target,
    "transition observation does not prove exclusive current control",
)
v2_without_target = {
    name: copy.deepcopy(value)
    for name, value in v2_observation.items()
    if name != "target"
}
current_observation_reader_rejects(
    v2_without_target,
    "transition observation schema is invalid",
)
current_observation_reader_rejects(
    copy.deepcopy(v1_observation),
    "transition observation schema is invalid",
)
write(d / "observation.json", v2_observation)
assert json.loads(invoke("verify-prepared", options))["snapshot"] == \
    valid_observation_snapshot
print("offline_observation_v1_v2_incompatibility=PASS", flush=True)

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

def consume_fixture_approval(d, run_id):
    common = {"authority_dir": d / "authority", "repo_root": root, "run_id": run_id}
    common["token"] = invoke("acquire-lock", {**common, "owner_pid": os.getpid()})
    record = a.load_record(d / "authority", run_id)
    approval = {
        **common, "approval_run_id": run_id,
        "approval_operation": policy["operation"], "environment_id": 91,
        "gate_key": hashlib.sha256(str(run_id).encode()).hexdigest(),
    }
    version = int(invoke("claim-approval", {
        **approval, "expected_version": record["version"], "reviewer": "fixture",
        "approval_comment": "fixture canonical approval", "approval_count_before": 0,
    }))
    invoke("complete-approval", {**approval, "expected_version": version})
    invoke("release-lock", common)
    return a.load_record(d / "authority", run_id)


def zero_fixture(count=5):
    d = setup()
    prepare(d)
    run(d, "--dispatch-prepared", state="active")
    f = json.loads((d / "fixture.json").read_text())
    run_id = f["newRun"]
    record = consume_fixture_approval(d, run_id)
    attempts = []
    for number in range(1, count + 1):
        conclusion = "failure" if number == 1 else "skipped"
        run_value = {
            **f["runs"][0], "id": run_id, "run_attempt": number,
            "head_sha": master, "display_title": record["displayTitle"],
            "status": "completed", "conclusion": conclusion,
            "html_url": record["runUrl"],
            "url": f"https://api.github.com/repos/{repository}/actions/runs/{run_id}",
        }
        job = {
            "id": run_id * 1000 + number, "run_id": run_id, "run_attempt": number,
            "name": "rollout", "status": "completed", "conclusion": conclusion,
            "runner_id": 0 if number == 1 else None,
            "runner_name": "" if number == 1 else None, "steps": [],
        }
        attempts.append({"run": run_value, "jobs": {"total_count": 1, "jobs": [job]}})
    observation = {
        "schemaVersion": a.ZERO_EXECUTION_EVIDENCE_SCHEMA, "run": attempts[-1]["run"],
        "attempts": attempts, "workflow": {"id": 313, "path": workflow, "state": "disabled_manually"},
        "historicalWorkflow": f["historical"], "compare": None,
        "pending": [], "approvals": [], "artifacts": {"total_count": 0, "artifacts": []},
    }
    f["zeroExecution"] = observation
    write(d / "fixture.json", f)
    return d, record, observation


for count in (1, 5):
    d, original, observation = zero_fixture(count)
    old_intent = intent(d)
    intent_path = next((d / "authority").glob("request-*.json"))
    old_intent_bytes = intent_path.read_bytes()
    capture = d / "authority" / old_intent["captureFile"]
    capture_bytes = capture.read_bytes()
    run(d, "--retire-zero-execution")
    retired = a.load_record(d / "authority", original["runId"])
    assert retired["schemaVersion"] == a.RECORD_SCHEMA_V4 and retired["state"] == "retired"
    assert retired["version"] == original["version"] + 1
    assert all(retired[key] == original[key] for key in a.RECORD_V1_KEYS - {"schemaVersion", "state", "version"})
    assert intent_path.read_bytes() == old_intent_bytes and capture.read_bytes() == capture_bytes
    assert (d / "dispatches").read_text() == "1", "retirement dispatched a replacement"
    assert (d / "zero-reads").read_text() == "3", "retirement did not collect twice and revalidate"
    assert a.retired_bound_intent(d / "authority", old_intent)
    for version in (a.RECORD_SCHEMA_V1, a.RECORD_SCHEMA_V2, a.RECORD_SCHEMA_V3):
        write(d / "authority" / f'{original["runId"]}.json', {**retired, "schemaVersion": version})
        try: a.load_record(d / "authority", original["runId"])
        except SystemExit: pass
        else: raise AssertionError("old schema accepted approval-bearing retirement")
    write(d / "authority" / f'{original["runId"]}.json', retired)
    for mutate in (
        lambda value: value["retirement"].update(evidence={}),
        lambda value: value["retirement"].update(evidenceDigest="0" * 64),
        lambda value: value["retirement"].update(secondObservationDigest="0" * 64),
        lambda value: value.update(retirement={"reason": "approved-zero-execution"}),
    ):
        bad = copy.deepcopy(retired); mutate(bad)
        write(d / "authority" / f'{original["runId"]}.json', bad)
        try: a.load_record(d / "authority", original["runId"])
        except SystemExit: pass
        else: raise AssertionError("incomplete or corrupted v4 proof was accepted")
    write(d / "authority" / f'{original["runId"]}.json', retired)
    run(d, "--retire-zero-execution", ok=False)

    if count == 5:
        f = json.loads((d / "fixture.json").read_text())
        del f["zeroExecution"]
        f["newRun"] += 1
        write(d / "fixture.json", f)
        run(d, "--prepare-disabled-ghosts")
        replacement = intent(d)
        assert replacement["captureFile"] != old_intent["captureFile"]
        assert replacement["preparedSeal"] != old_intent["preparedSeal"]
        archives = list((d / "authority").glob("spent-*.json"))
        assert len(archives) == 1 and json.loads(archives[0].read_text()) == old_intent
        run(d, "--dispatch-prepared", state="active")
        fresh = consume_fixture_approval(d, f["newRun"])
        assert fresh["runId"] != original["runId"] and fresh["runAttempt"] == 1
        assert fresh["approvals"] and fresh["approvals"] != original["approvals"]
        assert a.load_record(d / "authority", original["runId"]) == retired
        assert capture.read_bytes() == capture_bytes

d, original, observation = zero_fixture()
bad_observations = []
for field, value in (
    ("run_attempt", 0), ("run_attempt", True), ("run_attempt", 101),
    ("id", 1), ("workflow_id", 1), ("path", ".github/workflows/oci-capacity-acquire.yml"),
    ("event", "push"), ("head_branch", "dev"), ("head_sha", old),
    ("head_repository", {"full_name": "foreign/repo"}), ("display_title", "wrong"),
    ("status", "in_progress"), ("conclusion", "success"),
):
    bad = copy.deepcopy(observation); bad["run"][field] = value; bad_observations.append(bad)
for mutate in (
    lambda value: value["attempts"].pop(),
    lambda value: value["attempts"].reverse(),
    lambda value: value["attempts"].__setitem__(1, value["attempts"][0]),
    lambda value: value["attempts"][0]["run"].update(conclusion="success"),
    lambda value: value["attempts"][1]["run"].update(conclusion="failure"),
    lambda value: value["attempts"][1]["run"].update(status="queued"),
    lambda value: value["attempts"][0]["jobs"].update(total_count=2),
    lambda value: value.update(pending=[{"environment": {"id": 91}}]),
    lambda value: value.update(artifacts={"total_count": 1, "artifacts": [{"id": 1}]}),
    lambda value: value.update(approvals=None),
    lambda value: value["workflow"].update(id=999),
    lambda value: value["workflow"].update(path=".github/workflows/oci-capacity-acquire.yml"),
    lambda value: value["workflow"].update(state="active"),
):
    bad = copy.deepcopy(observation); mutate(bad); bad_observations.append(bad)
for field, value in (
    ("id", 0), ("run_id", 1), ("run_attempt", 2), ("name", "another-job"),
    ("status", "in_progress"), ("conclusion", "success"),
    ("runner_id", 7), ("runner_id", False), ("runner_name", "worker"),
    ("steps", [{"conclusion": "success"}]), ("steps", None),
):
    bad = copy.deepcopy(observation); bad["attempts"][0]["jobs"]["jobs"][0][field] = value
    bad_observations.append(bad)
for field in ("steps", "runner_id", "runner_name"):
    bad = copy.deepcopy(observation); del bad["attempts"][0]["jobs"]["jobs"][0][field]
    bad_observations.append(bad)
for bad in bad_observations:
    try: a.validate_zero_execution_observation(original, bad, master)
    except SystemExit: pass
    else: raise AssertionError("unsafe zero-execution evidence was accepted")

changed_source = source.replace(b"    if: github.run_attempt == 1\n", b"    if: true\n")
changed_blob = hashlib.sha1(f"blob {len(changed_source)}\0".encode() + changed_source).hexdigest()
bad = copy.deepcopy(observation)
bad["historicalWorkflow"].update(
    sha=changed_blob, size=len(changed_source), content=base64.b64encode(changed_source).decode(),
)
try: a.validate_zero_execution_observation({**original, "workflowBlobSha": changed_blob}, bad, master)
except SystemExit as error: assert "first-attempt" in str(error)
else: raise AssertionError("unguarded historical workflow was accepted")
bad = copy.deepcopy(observation); bad["historicalWorkflow"]["sha"] = "e" * 40
try: a.validate_zero_execution_observation(original, bad, master)
except SystemExit: pass
else: raise AssertionError("mismatched historical workflow blob was accepted")

zero_options = {**cleanup_options(d), "policy_json": json.dumps(policy)}
record_path = d / "authority" / f'{original["runId"]}.json'
for mutation in (
    {"state": state} for state in ("claimed", "issued", "inflight", "rejecting", "retired")
):
    write(record_path, {**original, **mutation})
    invoke("zero-execution-context", zero_options, ok=False)
for mutate in (
    lambda value: value.update(approvals=[]),
    lambda value: value["approvals"][0].update(runId=1),
    lambda value: value["approvals"][0].update(operation="another-operation"),
    lambda value: value.update(inflightApproval={}),
    lambda value: value.update(inputHash="0" * 64),
    lambda value: value.update(workflowBlobSha="c" * 40),
):
    bad = copy.deepcopy(original); mutate(bad); write(record_path, bad)
    invoke("zero-execution-context", zero_options, ok=False)
write(record_path, original)
snapshot = json.loads(invoke("zero-execution-context", zero_options))["snapshot"]
common = {"authority_dir": d / "authority", "repo_root": root, "run_id": original["runId"]}
common["token"] = invoke("acquire-lock", {**common, "owner_pid": os.getpid()})
write(d / "zero-first.json", observation)
changed = copy.deepcopy(observation); changed["approvals"] = [{"state": "rejected"}]
write(d / "zero-second.json", changed)
retire_options = {
    **zero_options, "current_master": master, "expected_snapshot": snapshot,
    "first_observation": d / "zero-first.json", "second_observation": d / "zero-second.json",
}
retire_options["token"] = common["token"]
invoke("retire-zero-execution", retire_options, ok=False)
write(d / "zero-second.json", observation)
invoke("retire-zero-execution", {**retire_options, "expected_snapshot": "f" * 64}, ok=False)
assert a.load_record(d / "authority", original["runId"]) == original
invoke("release-lock", common)

# A consumed generation is one-use for its request, not a perpetual global fence.
normalized = a.validate_request_data(request, policy, repository, master)
assert a.find_blocking_authorities(d / "authority", normalized)
other_request = copy.deepcopy(request); other_request["inputs"]["build_run_id"] = "99"
other_normalized = a.validate_request_data(other_request, policy, repository, master)
assert a.find_blocking_authorities(d / "authority", other_normalized) == []
for mutation in ("attempt", "approval", "artifact", "pending", "version", "capture", "non-ancestor"):
    case, before, _ = zero_fixture()
    run(case, "--retire-zero-execution", zero_drift=mutation, ok=False)
    assert a.load_record(case / "authority", before["runId"])["state"] == "consumed"
    assert (case / "dispatches").read_text() == "1"
run(d, "--retire-zero-execution", drift="other", ok=False)
assert a.load_record(d / "authority", original["runId"]) == original

case, before, proof = zero_fixture()
f = json.loads((case / "fixture.json").read_text())
advanced = "c" * 40
f["master"] = advanced
f["compare"]["commits"] = [{"sha": advanced}]
f["zeroCompare"] = {
    "status": "ahead", "ahead_by": 1, "behind_by": 0, "total_commits": 1,
    "base_commit": {"sha": master}, "merge_base_commit": {"sha": master},
    "commits": [{"sha": advanced}],
}
write(case / "fixture.json", f)
run(case, "--retire-zero-execution", actual=advanced)
retired = a.load_record(case / "authority", before["runId"])
assert retired["controlSha"] == master and retired["retirement"]["masterShaAtRetirement"] == advanced
run(case, "--dispatch", actual=advanced, ok=False)
bad = copy.deepcopy(proof); bad["compare"] = {**f["zeroCompare"], "status": "diverged"}
try: a.validate_zero_execution_observation(before, bad, advanced)
except SystemExit: pass
else: raise AssertionError("non-ancestor retirement control was accepted")
print("approved_zero_execution_retirement_tests=PASS", flush=True)

# Independent native profile: never generate this fixture from the classifier.
preflight_steps = [
    (1, "Set up job", "success"),
    (2, "Initialize isolated OCI data paths", "success"),
    (3, "Checkout approved current master commit", "success"),
    (4, "Validate exact SHA phase and trusted upstream runs", "failure"),
    (5, "Reject competing production activity", "skipped"),
    (6, "Download exact OCI image provenance", "skipped"),
    (7, "Download exact OCI infrastructure provenance", "skipped"),
    (8, "Download exact release disk checkpoint", "skipped"),
    (9, "Download prerequisite data evidence", "skipped"),
    (10, "Download failed deploy protected baseline", "skipped"),
    (11, "Download explicitly selected recovery baseline authority", "skipped"),
    (12, "Bind historical recovery source through its exact artifact", "skipped"),
    (13, "Verify immutable release and phase provenance", "skipped"),
    (14, "Install pinned OCI CLI", "skipped"),
    (15, "Verify OKE identity", "skipped"),
    (16, "Verify k3s identity", "skipped"),
    (17, "Reconcile expired and authorize current runner IPv4", "skipped"),
    (18, "Configure kubectl from exact cluster OCID", "skipped"),
    (19, "Open ephemeral OCI Bastion access to k3s", "skipped"),
    (20, "Verify exact failed-deploy resume state", "skipped"),
    (21, "Capture and validate pre-mutation rollback baseline", "skipped"),
    (22, "Revalidate exact release disk checkpoint before lock mutation", "skipped"),
    (23, "Acquire database operation lock", "skipped"),
    (24, "Enter or re-establish live data maintenance", "skipped"),
    (25, "Demote and verify exact retained live-acceptance account", "skipped"),
    (26, "Delete exact orphaned live-acceptance slips", "skipped"),
    (27, "Execute exact-digest live data phase", "skipped"),
    (28, "Restore runtime or verify final deploy handoff", "skipped"),
    (29, "Capture post-phase runtime baseline", "skipped"),
    (30, "Require executed data-step evidence", "skipped"),
    (31, "Upload exact sanitized data evidence", "success"),
    (32, "Upload protected rollout baselines", "success"),
    (33, "Restore runtime or retain hold if final handoff packaging failed", "skipped"),
    (34, "Release database operation lock unless handed to deploy", "skipped"),
    (35, "Revoke exact runner rule", "skipped"),
    (36, "Close ephemeral OCI Bastion access", "skipped"),
    (37, "Remove isolated OCI client state", "success"),
    (74, "Post Checkout approved current master commit", "success"),
    (75, "Complete job", "success"),
]
preflight_blobs = {
    ".github/workflows/oci-live-data-rollout.yml": "27a98e345050fefb799c706fde03d8f79e14ed6c",
    "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh": "4681e877c673294e1f70974eaa6d2be7ea526f2a",
    "infra/oci/scripts/upstream_run_binding_stan.py": "e2c82998ca820abf25f7b5255a30842253adbf55",
    "infra/oci/scripts/k3s_disk_recovery_stan.py": "6a320e73943b15fec954be2297ea5eaa729c8a11",
    "infra/oci/scripts/validate-legacy-oci-provenance.py": "240a4bf56cd8e5763f475dc3baa0250a7c1add5f",
    "infra/oci/scripts/verify-images.sh": "77ff8ecdcf9b8f86ed5be3550a3cd9f91c57a514",
    "infra/oci/scripts/lib.sh": "caabac06cc16147e12ac536112d3aa5f14d54a34",
    "infra/oci/scripts/application-registry.sh": "c97bc549688b9d04e727fbad175a6f558832c365",
    "infra/oci/scripts/validate-partial-recovery-authority-stan.sh": "bf089777892d70d13b4bcf880d7e5311e26c00b9",
}
preflight_diagnostic_blobs = {
    **preflight_blobs,
    "infra/oci/scripts/upstream_run_binding_stan.py": "972562e235c3f3c7a6c08c88ecd97ec7bb582923",
}
assert a.PREFLIGHT_READ_BLOBS == preflight_blobs
assert a.PREFLIGHT_READ_DIAGNOSTIC_BLOBS == preflight_diagnostic_blobs
assert a.PREFLIGHT_READ_PROFILES == (preflight_blobs, preflight_diagnostic_blobs)
assert {path for path in preflight_blobs if preflight_blobs[path] != preflight_diagnostic_blobs[path]} == {
    "infra/oci/scripts/upstream_run_binding_stan.py",
}
v4_directory, v4_run = case / "authority", before["runId"]
policy = json.loads(subprocess.check_output([policy_script, "get", "oci-live-data-resume-deploy"]))
request = {
    **request, "operation": policy["operation"],
    "inputs": {**request["inputs"], **policy["fixedInputs"],
               "prerequisite_run_id": "46", "failed_deploy_run_id": "47"},
}


def issue_preflight_fixture(d, transport, run_id):
    record = a.load_record(d / "authority", run_id)
    write(d / "issued-run.json", {
        "id": run_id, "workflow_id": 313, "path": workflow, "event": "workflow_dispatch",
        "head_sha": master, "head_branch": "master", "head_repository": {"full_name": repository},
        "run_attempt": 1, "display_title": record["displayTitle"],
        "status": "waiting", "conclusion": None,
    })
    invoke("issue", {**{k: v for k, v in transport.items() if k != "normalized"},
                     "run_id": run_id, "run_json": d / "issued-run.json"})


def preflight_fixture(profile=preflight_diagnostic_blobs):
    d = setup()
    options = local_prepare(d)
    snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
    invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()})
    f = json.loads((d / "fixture.json").read_text())
    run_id = f["newRun"]
    capture = intent(d)["captureFile"]
    (d / "authority" / capture).write_text(f"https://github.com/{repository}/actions/runs/{run_id}\n")
    transport = {k: v for k, v in options.items() if k not in {"request", "inputs_file", "observation_json"}}
    invoke("record-dispatch-status", {**transport, "expected_version": 2,
                                     "expected_capture_file": capture, "dispatch_status": 0})
    invoke("bind-intent", {**transport, "expected_capture_file": capture})
    issue_preflight_fixture(d, transport, run_id)
    record = consume_fixture_approval(d, run_id)
    native_run = {
        **f["runs"][0], "id": run_id, "head_sha": master,
        "display_title": record["displayTitle"], "status": "completed", "conclusion": "failure",
        "html_url": record["runUrl"],
        "url": f"https://api.github.com/repos/{repository}/actions/runs/{run_id}",
        "created_at": "2026-01-01T00:00:00Z", "run_started_at": "2026-01-01T00:00:01Z",
        "updated_at": "2026-01-01T00:01:00Z",
    }
    job = {
        "id": run_id * 100, "run_id": run_id, "run_attempt": 1, "head_sha": master,
        "name": "rollout", "status": "completed", "conclusion": "failure",
        "runner_id": 1001, "runner_name": "native-hosted-runner",
        "started_at": "2026-01-01T00:00:01Z", "completed_at": "2026-01-01T00:00:50Z",
        "steps": [
            {"number": number, "name": name, "status": "completed", "conclusion": conclusion,
             "started_at": None if conclusion == "skipped" else f"2026-01-01T00:00:{index+2:02d}Z",
             "completed_at": None if conclusion == "skipped" else f"2026-01-01T00:00:{index+3:02d}Z"}
            for index, (number, name, conclusion) in enumerate(preflight_steps)
        ],
    }
    files = {path: {"local": sha, "github": sha} for path, sha in profile.items()}
    observation = {
        "schemaVersion": "betstan.copilot-cli-preflight-read-evidence.v1",
        "run": native_run, "attempts": [{"run": copy.deepcopy(native_run),
                                      "jobs": {"total_count": 1, "jobs": [job]}}],
        "workflow": {"id": 313, "path": workflow, "state": "disabled_manually"},
        "historicalWorkflow": f["historical"], "compare": None, "pending": [],
        "approvals": [{"state": "approved", "comment": "fixture canonical approval",
                       "user": {"id": 5, "login": "fixture", "type": "User"},
                       "environments": [{"id": 91, "name": "oci-migration"}]}],
        "artifacts": {"total_count": 0, "artifacts": []},
        "closure": {"historicalControl": master, "currentControl": master,
                    "historical": files, "current": copy.deepcopy(files),
                    "actions": [
                        "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
                        "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
                    ]},
    }
    f.update(preflightRead=observation, preflightBlobs=profile)
    write(d / "fixture.json", f)
    (d / "preflight-fixture").touch()
    (d / "dispatches").write_text("1")
    return d, record, observation


def preflight_retire_options(d):
    context = {**cleanup_options(d), "policy_json": json.dumps(policy)}
    snapshot = json.loads(invoke("preflight-read-context", context))["snapshot"]
    common = {"authority_dir": d / "authority", "repo_root": root, "run_id": intent(d)["runId"]}
    common["token"] = invoke("acquire-lock", {**common, "owner_pid": os.getpid()})
    observation = json.loads((d / "fixture.json").read_text())["preflightRead"]
    write(d / "first.json", observation); write(d / "second.json", observation)
    options = {
        **context, "current_master": master, "expected_snapshot": snapshot,
        "first_observation": d / "first.json",
        "second_observation": d / "second.json",
    }
    options["token"] = common["token"]
    return options, common


# An independent historical v5 fixture, not a new retirement through the
# upgraded writer. Its reference encoding and original profile remain fixed.
case, consumed, historical_observation = preflight_fixture(preflight_blobs)
historical_intent = intent(case)
historical_intent_file = next((case / "authority").glob("request-*.json"))
historical_intent_bytes = historical_intent_file.read_bytes()
historical_capture = case / "authority" / historical_intent["captureFile"]
historical_capture_bytes = historical_capture.read_bytes()
context = json.loads(invoke("preflight-read-context", {
    **cleanup_options(case), "policy_json": json.dumps(policy),
}))
assert context["closureProfile"] == preflight_diagnostic_blobs
options, common = preflight_retire_options(case)
error = invoke("retire-preflight-read-only-failure", options, ok=False)
assert "dependency closure differs" in error
assert a.load_record(case / "authority", consumed["runId"]) == consumed
assert historical_intent_file.read_bytes() == historical_intent_bytes
assert historical_capture.read_bytes() == historical_capture_bytes
invoke("release-lock", common)
run(case, "--retire-preflight-read-only-failure", ok=False)
assert a.load_record(case / "authority", consumed["runId"]) == consumed

def historical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

historical_retirement = {
    "reason": "preflight-read-only-failure", "recordVersion": consumed["version"],
    "retiredAt": consumed["approvals"][-1]["approvedAt"], "masterShaAtRetirement": master,
    "policy": copy.deepcopy(policy), "intentDigest": historical_digest(historical_intent),
    "captureSha256": hashlib.sha256(historical_capture_bytes).hexdigest(),
    "evidence": historical_observation,
    "secondObservationDigest": historical_digest(historical_observation),
}
original_digest = historical_digest({
    "schemaVersion": "betstan.copilot-cli-authority.v5",
    "authority": {key: value for key, value in consumed.items()
                  if key not in {"schemaVersion", "state", "version"}},
    "retirement": historical_retirement,
})
historical_retirement["evidenceDigest"] = original_digest
historical_record = {
    **consumed, "schemaVersion": "betstan.copilot-cli-authority.v5",
    "state": "retired", "version": consumed["version"] + 1,
    "retirement": historical_retirement,
}
historical_record_file = case / "authority" / f'{consumed["runId"]}.json'
write(historical_record_file, historical_record)
original_bytes = historical_record_file.read_bytes()
assert a.load_record(case / "authority", consumed["runId"]) == historical_record
assert a.retired_bound_intent(case / "authority", historical_intent)
a.preserve_spent_intent(case / "authority", historical_intent)
historical_archive = next((case / "authority").glob("spent-*.json"))
archive_bytes = historical_archive.read_bytes()
assert json.loads(archive_bytes) == historical_intent
a.preserve_spent_intent(case / "authority", historical_intent)
assert a.find_blocking_authorities(
    case / "authority", a.validate_request_data(request, policy, repository, master),
) == []
assert historical_record_file.read_bytes() == original_bytes
assert a.load_record(case / "authority", consumed["runId"])["retirement"]["evidenceDigest"] == original_digest
assert historical_intent_file.read_bytes() == historical_intent_bytes
assert historical_capture.read_bytes() == historical_capture_bytes
assert historical_archive.read_bytes() == archive_bytes

profile_negatives = []
diagnostic_files = {
    path: {"local": sha, "github": sha} for path, sha in preflight_diagnostic_blobs.items()
}
for side in ("historical", "current"):
    mixed = copy.deepcopy(historical_observation)
    mixed["closure"][side] = copy.deepcopy(diagnostic_files)
    profile_negatives.append(mixed)
    for origin in ("local", "github"):
        mixed = copy.deepcopy(historical_observation)
        mixed["closure"][side]["infra/oci/scripts/upstream_run_binding_stan.py"][origin] = \
            preflight_diagnostic_blobs["infra/oci/scripts/upstream_run_binding_stan.py"]
        profile_negatives.append(mixed)
for mutate in (
    lambda v: v["closure"]["historical"].pop("infra/oci/scripts/lib.sh"),
    lambda v: v["closure"]["current"].update({"extra": {"local": "e" * 40, "github": "e" * 40}}),
    lambda v: v["closure"]["historical"]["infra/oci/scripts/lib.sh"].update(local="e" * 40, github="e" * 40),
    lambda v: v["closure"]["actions"].__setitem__(0, "actions/checkout@" + "e" * 40),
):
    bad = copy.deepcopy(historical_observation); mutate(bad); profile_negatives.append(bad)
for bad in profile_negatives:
    try:
        a.validate_preflight_read_observation(
            consumed, bad, master, admitted_profiles=a.PREFLIGHT_READ_PROFILES,
        )
    except SystemExit: pass
    else: raise AssertionError("stored-v5 validation admitted a mixed or incomplete profile")
for mutate in (
    lambda v: v["retirement"].update(evidenceDigest="0" * 64),
    lambda v: v["retirement"].update(secondObservationDigest="0" * 64),
    lambda v: v["retirement"]["evidence"]["closure"].update(current=copy.deepcopy(diagnostic_files)),
):
    bad = copy.deepcopy(historical_record); mutate(bad); write(historical_record_file, bad)
    try: a.load_record(case / "authority", consumed["runId"])
    except SystemExit: pass
    else: raise AssertionError("tampered original-profile v5 proof was accepted")
write(historical_record_file, historical_record)
assert historical_record_file.read_bytes() == original_bytes
assert a.retired_bound_intent(case / "authority", historical_intent)
print("preflight_read_original_v5_digest_spent_linkage_and_diagnostic_only_admission=PASS", flush=True)

d, original, observation = preflight_fixture()
intent_file = next((d / "authority").glob("request-*.json"))
old_intent = intent(d)
old_intent_bytes = intent_file.read_bytes()
capture = d / "authority" / old_intent["captureFile"]
capture_bytes, capture_identity = capture.read_bytes(), a.file_identity(capture)
run(d, "--retire-preflight-read-only-failure")
retired = a.load_record(d / "authority", original["runId"])
assert retired["schemaVersion"] == "betstan.copilot-cli-authority.v5"
assert retired["retirement"]["reason"] == "preflight-read-only-failure"
assert retired["version"] == original["version"] + 1 and retired["state"] == "retired"
assert all(retired[key] == original[key] for key in a.RECORD_V1_KEYS - {"schemaVersion", "state", "version"})
assert intent_file.read_bytes() == old_intent_bytes
assert capture.read_bytes() == capture_bytes and a.file_identity(capture) == capture_identity
assert (d / "dispatches").read_text() == "1"
assert (d / "preflight-reads").read_text() == "4"
calls = [json.loads(line) for line in (d / "preflight-provider-calls").read_text().splitlines()]
assert all(call[0] in {"api", "repo"} for call in calls)
assert all(not set(call).intersection({"--method", "-X", "-f", "-F", "--input"}) for call in calls)
assert a.retired_bound_intent(d / "authority", old_intent)
run(d, "--retire-preflight-read-only-failure", ok=False)

# Execute the byte-identical historical v1-v4 loader, pinned independently of
# Git history; only this patch's three additive v5 reader edits are removed.
import inspect
old_loader = inspect.getsource(a.load_record).replace(
    '    elif schema_version == RECORD_SCHEMA_V5:\n'
    '        if set(record) != RECORD_V2_KEYS:\n'
    '            fail("authority record has an unexpected schema")\n', "",
).replace(
    "and schema_version not in {RECORD_SCHEMA_V4, RECORD_SCHEMA_V5}",
    "and schema_version != RECORD_SCHEMA_V4",
).replace(
    "    elif schema_version == RECORD_SCHEMA_V5:\n"
    "        validate_preflight_read_retirement(record)\n", "",
)
assert hashlib.sha256(old_loader.encode()).hexdigest() == \
    "77e2cfc6467df3bc14a0a3080a80febb12ac74e3cdccaa5cb68f46f13e10df41"
old_namespace = {name: value for name, value in vars(a).items()
                 if name != "RECORD_SCHEMA_V5" and not name.startswith("PREFLIGHT_READ_")}
exec(compile(old_loader, "frozen-v4-authority-reader", "exec"), old_namespace)
assert old_namespace["load_record"](v4_directory, v4_run)["schemaVersion"] == a.RECORD_SCHEMA_V4
record_file = d / "authority" / f'{original["runId"]}.json'
try: old_namespace["load_record"](d / "authority", original["runId"])
except SystemExit as error: assert str(error) == "authority record schema version is unsupported"
else: raise AssertionError("actual historical reader accepted v5")
write(record_file, original)
assert old_namespace["load_record"](d / "authority", original["runId"]) == original
write(record_file, retired)

for mutate in (
    lambda value: value["retirement"].update(evidenceDigest="0" * 64),
    lambda value: value["retirement"].update(secondObservationDigest="0" * 64),
    lambda value: value["retirement"].update(captureSha256="0" * 64),
    lambda value: value["retirement"].update(recordVersion=0),
    lambda value: value.update(version=value["version"] + 1),
    lambda value: value["retirement"]["evidence"]["closure"]["current"].pop("infra/oci/scripts/lib.sh"),
):
    bad = copy.deepcopy(retired); mutate(bad); write(record_file, bad)
    try: a.load_record(d / "authority", original["runId"])
    except SystemExit: pass
    else: raise AssertionError("corrupted v5 evidence was accepted")
write(record_file, retired)

# A separate normal preparation archives the spent seal and cannot accept old
# snapshots, capture identities, late status writes, or late bind writes.
options = local_prepare(d)
replacement = intent(d)
assert replacement["captureFile"] != old_intent["captureFile"]
assert json.loads(next((d / "authority").glob("spent-*.json")).read_text()) == old_intent
snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot, "owner_pid": os.getpid()})
transport = {k: v for k, v in options.items() if k not in {"request", "inputs_file", "observation_json"}}
invoke("record-dispatch-status", {**transport, "expected_version": 2,
                                 "expected_capture_file": old_intent["captureFile"], "dispatch_status": 0}, ok=False)
invoke("bind-intent", {**transport, "expected_capture_file": old_intent["captureFile"]}, ok=False)
fresh_run = original["runId"] + 1
(d / "authority" / replacement["captureFile"]).write_text(f"https://github.com/{repository}/actions/runs/{fresh_run}\n")
invoke("record-dispatch-status", {**transport, "expected_version": 2,
                                 "expected_capture_file": replacement["captureFile"], "dispatch_status": 0})
invoke("bind-intent", {**transport, "expected_capture_file": replacement["captureFile"]})
issue_preflight_fixture(d, transport, fresh_run)
fresh = consume_fixture_approval(d, fresh_run)
assert fresh["schemaVersion"] == a.RECORD_SCHEMA_V1 and fresh["approvals"] != original["approvals"]
assert a.load_record(d / "authority", original["runId"]) == retired
assert capture.read_bytes() == capture_bytes and intent_file.read_bytes() != old_intent_bytes
print("preflight_read_retirement_dispatch_preservation_old_reader_replacement=PASS", flush=True)

d, original, observation = preflight_fixture()
bad_observations = []
for field, value in (
    ("id", 0), ("id", True), ("workflow_id", 1), ("run_attempt", 2),
    ("run_attempt", True), ("event", "push"), ("head_branch", "dev"), ("head_sha", old),
    ("head_repository", {"full_name": "foreign/repo"}), ("head_repository", None),
    ("path", ".github/workflows/oci-live-betting-activate.yml"), ("display_title", "wrong"),
    ("status", "queued"), ("conclusion", "success"), ("run_started_at", None),
    ("created_at", "2027-01-01T00:00:00Z"), ("updated_at", "bad"),
):
    for which in ("latest", "attempt"):
        bad = copy.deepcopy(observation)
        (bad["run"] if which == "latest" else bad["attempts"][0]["run"])[field] = value
        bad_observations.append(bad)
for field, value in (
    ("id", 0), ("run_id", 1), ("run_attempt", 2), ("head_sha", old),
    ("name", "unknown"), ("status", "waiting"), ("conclusion", "success"),
    ("runner_id", None), ("runner_id", 0), ("runner_id", True), ("runner_name", ""),
    ("runner_name", None), ("started_at", None), ("completed_at", "2025-01-01T00:00:00Z"),
):
    bad = copy.deepcopy(observation); bad["attempts"][0]["jobs"]["jobs"][0][field] = value
    bad_observations.append(bad)
for index in range(39):
    for field, value in (("number", 0), ("name", "unknown"), ("conclusion", "neutral"),
                         ("status", "in_progress"), ("started_at", "invalid")):
        bad = copy.deepcopy(observation)
        bad["attempts"][0]["jobs"]["jobs"][0]["steps"][index][field] = value
        bad_observations.append(bad)
for mutate in (
    lambda v: v["attempts"].append(copy.deepcopy(v["attempts"][0])),
    lambda v: v.update(attempts=[]),
    lambda v: v["attempts"][0]["jobs"].update(total_count=2),
    lambda v: v["attempts"][0]["jobs"]["jobs"].append(copy.deepcopy(v["attempts"][0]["jobs"]["jobs"][0])),
    lambda v: v["attempts"][0]["jobs"]["jobs"][0]["steps"].pop(),
    lambda v: v["attempts"][0]["jobs"]["jobs"][0]["steps"].reverse(),
    lambda v: v["attempts"][0]["jobs"]["jobs"][0]["steps"].append(v["attempts"][0]["jobs"]["jobs"][0]["steps"][0]),
    lambda v: v["attempts"][0]["jobs"]["jobs"][0]["steps"][1].update(started_at="2026-01-01T00:00:01Z"),
    lambda v: v.update(artifacts={"total_count": 1, "artifacts": [{"id": 1}]}),
    lambda v: v.update(artifacts={"total_count": False, "artifacts": []}),
    lambda v: v.update(pending=[{}]),
    lambda v: v.update(approvals=[]),
    lambda v: v["approvals"].append(copy.deepcopy(v["approvals"][0])),
    lambda v: v["approvals"][0].update(state="rejected"),
    lambda v: v["approvals"][0].pop("user"),
    lambda v: v["approvals"][0].pop("comment"),
    lambda v: v["approvals"][0]["environments"][0].update(id=92),
    lambda v: v["approvals"][0]["environments"].append({"id": 91}),
    lambda v: v["workflow"].update(state="active"),
    lambda v: v["workflow"].update(id=1),
    lambda v: v["historicalWorkflow"].update(sha="e" * 40),
    lambda v: v["closure"]["actions"].pop(),
    lambda v: v["closure"].update(currentControl=old),
    lambda v: v["closure"].update(historicalControl=old),
    lambda v: v.update(unknown=True),
):
    bad = copy.deepcopy(observation); mutate(bad); bad_observations.append(bad)
for side in ("historical", "current"):
    for path in preflight_blobs:
        for origin in ("local", "github"):
            bad = copy.deepcopy(observation); bad["closure"][side][path][origin] = "e" * 40
            bad_observations.append(bad)
for bad in bad_observations:
    try: a.validate_preflight_read_observation(original, bad, master)
    except SystemExit: pass
    else: raise AssertionError("unsafe preflight-read evidence was accepted")
for operation in ("oci-live-data-resume-deploy-released", "oci-live-data-dry-run", "oci-live-data-apply-slip-index"):
    try: a.validate_preflight_read_observation({**original, "operation": operation}, observation, master)
    except SystemExit: pass
    else: raise AssertionError("another operation received preflight-read retirement")
multiple = copy.deepcopy(original)
multiple["approvals"].append({**multiple["approvals"][0], "environmentId": 92, "gateKey": "e" * 64})
proof = copy.deepcopy(observation)
proof["approvals"].append({**copy.deepcopy(proof["approvals"][0]), "comment": "second",
                          "environments": [{"id": 92}]})
a.validate_preflight_read_observation(multiple, proof, master)
for duplicate in (False, True):
    bad = copy.deepcopy(proof)
    bad["approvals"][1] = copy.deepcopy(bad["approvals"][0]) if duplicate else {
        **bad["approvals"][1], "environments": [{"id": 91}],
    }
    try: a.validate_preflight_read_observation(multiple, bad, master)
    except SystemExit: pass
    else: raise AssertionError("duplicate or wrong-multiplicity native approvals passed")
ambiguous = copy.deepcopy(multiple)
ambiguous["approvals"][1]["environmentId"] = 91
bad = copy.deepcopy(proof)
bad["approvals"][1]["environments"] = [{"id": 91}]
try: a.validate_preflight_read_observation(ambiguous, bad, master)
except SystemExit: pass
else: raise AssertionError("ambiguous same-environment reviews were assigned invented join keys")
print(f"preflight_read_native_profile_negatives=PASS cases={len(bad_observations) + 6}", flush=True)

for field, pages in (
    ("preflightJobPages", []),
    ("preflightJobPages", [{"total_count": 1, "jobs": []}]),
    ("preflightJobPages", [observation["attempts"][0]["jobs"]] * 2),
    ("preflightApprovalPages", []),
    ("preflightApprovalPages", [observation["approvals"] * 100]),
    ("preflightApprovalPages", [observation["approvals"], []]),
    ("preflightApprovalPages", [{}]),
    ("preflightPendingPages", [[], []]),
    ("preflightArtifactPages", [{"total_count": 1, "artifacts": []}]),
    ("preflightArtifactPages", [{"total_count": 0, "artifacts": []}] * 2),
):
    f = json.loads((d / "fixture.json").read_text()); f[field] = pages
    write(d / "fixture.json", f)
    run(d, "--retire-preflight-read-only-failure", ok=False)
    assert a.load_record(d / "authority", original["runId"]) == original
    del f[field]; write(d / "fixture.json", f)
for mutation in ("attempt", "approval", "artifact", "pending", "master", "workflow",
                 "helper", "local-helper", "version", "capture", "capture-replace", "intent", "request"):
    case, before, _ = preflight_fixture()
    f = json.loads((case / "fixture.json").read_text()); f["preflightDrift"] = mutation
    write(case / "fixture.json", f)
    run(case, "--retire-preflight-read-only-failure", ok=False)
    assert json.loads((case / "authority" / f'{before["runId"]}.json').read_text())["state"] == "consumed"
    assert (case / "dispatches").read_text() == "1"
case, before, _ = preflight_fixture()
f = json.loads((case / "fixture.json").read_text()); f.update(preflightDrift="attempt", preflightDriftAt=4)
write(case / "fixture.json", f)
run(case, "--retire-preflight-read-only-failure", ok=False)
assert a.load_record(case / "authority", before["runId"]) == before
run(d, "--retire-preflight-read-only-failure", drift="other", ok=False)
run(d, "--retire-preflight-read-only-failure", state="active", ok=False)
print("preflight_read_collector_pagination_drift_write_spy=PASS", flush=True)

case, before, proof = preflight_fixture()
advanced = "c" * 40
f = json.loads((case / "fixture.json").read_text())
f["master"] = advanced
f["compare"]["commits"] = [{"sha": advanced}]
f["preflightRead"]["closure"]["currentControl"] = advanced
f["preflightRead"]["compare"] = {
    "status": "ahead", "ahead_by": 1, "behind_by": 0, "total_commits": 1,
    "base_commit": {"sha": master}, "merge_base_commit": {"sha": master},
    "commits": [{"sha": advanced}],
}
write(case / "fixture.json", f)
run(case, "--retire-preflight-read-only-failure", actual=advanced)
advanced_record = a.load_record(case / "authority", before["runId"])
assert advanced_record["controlSha"] == master
assert advanced_record["retirement"]["masterShaAtRetirement"] == advanced
run(case, "--dispatch", actual=advanced, ok=False)
bad = copy.deepcopy(f["preflightRead"]); bad["compare"]["status"] = "diverged"
try: a.validate_preflight_read_observation(before, bad, advanced)
except SystemExit: pass
else: raise AssertionError("non-ancestor preflight control was accepted")
print("preflight_read_original_control_current_master_binding=PASS", flush=True)

for crash_after_write in (False, True):
    case, before, _ = preflight_fixture()
    options, common = preflight_retire_options(case)
    original_replace = a.atomic_replace
    def interrupted_replace(path, value):
        if crash_after_write: original_replace(path, value)
        raise RuntimeError("fixture crash at atomic persistence boundary")
    a.atomic_replace = interrupted_replace
    try:
        try: invoke("retire-preflight-read-only-failure", options)
        except RuntimeError: pass
        else: raise AssertionError("crash injection was not reached")
    finally:
        a.atomic_replace = original_replace
    observed = a.load_record(case / "authority", before["runId"])
    assert observed["state"] == ("retired" if crash_after_write else "consumed")
    if not crash_after_write: assert observed == before
    else: invoke("retire-preflight-read-only-failure", options, ok=False)
    invoke("release-lock", common)

case, before, _ = preflight_fixture()
options, common = preflight_retire_options(case)
invoke("retire-preflight-read-only-failure", {**options, "second_observation": options["first_observation"]}, ok=False)
invoke("retire-preflight-read-only-failure", {**options, "expected_snapshot": "0" * 64}, ok=False)
with open(case / "authority/.repository-claim.lock", "r+") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    invoke("retire-preflight-read-only-failure", options, ok=False)
    fcntl.flock(lock, fcntl.LOCK_UN)
original_scan = a.find_blocking_authorities
def late_capture_write(*args):
    result = original_scan(*args)
    capture = case / "authority" / intent(case)["captureFile"]
    with capture.open("a") as stream: stream.write("late local generation write\n")
    return result
a.find_blocking_authorities = late_capture_write
try: invoke("retire-preflight-read-only-failure", options, ok=False)
finally: a.find_blocking_authorities = original_scan
assert a.load_record(case / "authority", before["runId"]) == before
invoke("release-lock", common)

case, before, _ = preflight_fixture()
options, common = preflight_retire_options(case)
argv = [str(helper), "retire-preflight-read-only-failure"]
for key, value in options.items(): argv.extend(["--" + key.replace("_", "-"), str(value)])
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(lambda _: subprocess.run(argv, capture_output=True, text=True, timeout=15), range(2)))
assert sorted(result.returncode == 0 for result in results) == [False, True]
assert a.load_record(case / "authority", before["runId"])["version"] == before["version"] + 1
invoke("release-lock", common)
print("preflight_read_generation_cas_race_crash_late_write=PASS", flush=True)
print("prepared_dispatch_integration_tests=PASS")
PY

# Frozen two-entry disabled-transition map: both targets get a real
# prepare/happy-path/discard cycle, cross-target request/observation/seal/
# prepared-context/dispatch/discard are rejected in both directions, and the
# repository-global prepare fence spans both targets. This exercises the
# generalized functions directly rather than re-running the whole single-
# target mutation/race/CAS/expiry/capture/retirement/v1-reader matrix twice.
PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT_DIR" "$tmp_dir" <<'PY'
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys

root, temporary = map(Path, sys.argv[1:])
helper = root / "infra/azure/agents/copilot_cli_authority_stan.py"
policy_script = root / "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
spec = importlib.util.spec_from_file_location("authority_frozen", helper)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

repository = "example/repo"
master = "b" * 40
old = "a" * 40

assert a.PREPARED_TRANSITION_WORKFLOWS == {
    "oci-live-data-rollout.yml": ".github/workflows/oci-live-data-rollout.yml",
    "oci-live-betting-activate.yml": ".github/workflows/oci-live-betting-activate.yml",
}, "frozen prepared-transition map drifted"
assert "oci-capacity-acquire.yml" not in a.PREPARED_TRANSITION_WORKFLOWS
assert set(a.PREPARED_TRANSITION_WORKFLOWS.values()) <= set(a.UNMATERIALIZED_WORKFLOWS)

def invoke(command, options, *, ok=True):
    argv = [command]
    for name, value in options.items():
        argv.extend(["--" + name.replace("_", "-"), str(value)])
    parsed = a.build_parser().parse_args(argv)
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            parsed.function(parsed)
    except SystemExit as error:
        assert not ok, (command, error)
        return str(error)
    assert ok, f"{command} unexpectedly passed"
    return out.getvalue().strip()

def write(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)

TARGETS = {
    "data": {
        "operation": "oci-live-data-dry-run",
        "workflow": "oci-live-data-rollout.yml",
        "workflow_id": 313,
        "extra_inputs": {
            "approved_sha": master, "build_run_id": "42",
            "infrastructure_run_id": "43", "checkpoint_source_sha": master,
            "disk_checkpoint_run_id": "45", "resume_source_sha": master,
            "baseline_recovery_run_id": "0",
            "baseline_recovery_source_sha": "none",
        },
    },
    "activate": {
        "operation": "oci-live-betting-activate",
        "workflow": "oci-live-betting-activate.yml",
        "workflow_id": 415,
        "extra_inputs": {
            "approved_sha": master, "build_run_id": "42",
            "infrastructure_run_id": "43", "deployment_run_id": "44",
        },
    },
}

policy_paths = subprocess.check_output([policy_script, "workflows"], text=True).splitlines()
inventory = {"paths": sorted(".github/workflows/" + p for p in policy_paths),
             "statuses": ["queued", "in_progress", "waiting", "requested", "pending"],
             "limitPerStatus": 100}
inventory_sha256 = a.evidence_digest(inventory)

def build_context(key, run_id):
    info = TARGETS[key]
    path = f".github/workflows/{info['workflow']}"
    policy = json.loads(subprocess.check_output([policy_script, "get", info["operation"]]))
    request = {
        "schemaVersion": a.REQUEST_SCHEMA, "repository": repository,
        "operation": policy["operation"], "controlSha": master,
        "subjectSha": master, "targetSha": None,
        "inputs": {**policy["fixedInputs"], **info["extra_inputs"]},
    }
    normalized = a.validate_request_data(request, policy, repository, master)
    source = (root / path).read_bytes()
    blob = hashlib.sha1(f"blob {len(source)}\0".encode() + source).hexdigest()
    run = {
        "id": run_id, "workflow_id": info["workflow_id"], "path": path,
        "head_sha": old, "head_branch": "master",
        "head_repository": {"full_name": repository},
        "event": "workflow_dispatch", "run_attempt": 1, "status": "queued",
        "conclusion": None, "display_title": a.UNMATERIALIZED_WORKFLOWS[path]["name"],
        "created_at": "1970-01-01T00:00:00Z", "run_started_at": "1970-01-01T00:00:00Z",
        "updated_at": "1970-01-01T00:00:00Z",
        "html_url": f"https://github.com/{repository}/actions/runs/{run_id}",
    }
    compare = {"status": "ahead", "ahead_by": 1, "behind_by": 0, "total_commits": 1,
               "base_commit": {"sha": old}, "merge_base_commit": {"sha": old},
               "commits": [{"sha": master}]}
    historical = {"type": "file", "path": path, "encoding": "base64", "sha": blob,
                  "size": len(source), "content": base64.b64encode(source).decode()}
    evidence = {
        "run": run, "workflow": {"id": info["workflow_id"], "path": path, "state": "disabled_manually"},
        "jobs": {"total_count": 0, "jobs": []}, "pending": [], "approvals": [],
        "artifacts": {"total_count": 0, "artifacts": []}, "compare": compare,
        "historical_workflow": historical, "now_epoch": 10 ** 9, "minimum_age_seconds": 600,
    }
    facts = a.validate_unmaterialized_run_evidence(
        **evidence, repository=repository, current_master=master,
        require_disabled_workflow=False,
    )
    candidate = a.semantic_ghost_evidence(evidence, facts)["candidate"]

    def observation_for(state):
        return {
            "schemaVersion": a.TRANSITION_OBSERVATION_SCHEMA,
            "repository": repository, "controlSha": master,
            "inventorySha256": inventory_sha256,
            "target": {"workflow": info["workflow"], "path": path},
            "candidates": [candidate],
            "workflows": [{"id": info["workflow_id"], "path": path, "state": state}],
            "blockers": [],
        }

    return {
        "key": key, "info": info, "path": path, "policy": policy, "request": request,
        "normalized": normalized, "blob": blob, "observation_for": observation_for,
    }

def write_options(context, directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    write(directory / "request.json", context["request"])
    write(directory / "normalized.json", context["normalized"])
    write(directory / "inputs.json", context["normalized"]["dispatchInputs"])
    write(directory / "observation.json", context["observation_for"]("disabled_manually"))
    authority_dir = directory / "authority"
    authority_dir.mkdir(mode=0o700, exist_ok=True)
    return {
        "request": directory / "request.json", "normalized": directory / "normalized.json",
        "inputs_file": directory / "inputs.json",
        "policy_json": json.dumps(context["policy"]),
        "repository": repository, "current_master": master,
        "workflow_id": context["info"]["workflow_id"],
        "workflow_blob_sha": context["blob"],
        "observation_json": directory / "observation.json",
        "authority_dir": authority_dir, "repo_root": root,
    }

# --- Both-target happy path: prepare -> dispatch, and prepare -> discard. ---
for key in ("data", "activate"):
    run_id = 900001 if key == "data" else 900002
    context = build_context(key, run_id)

    dispatch_dir = temporary / f"frozen-{key}-dispatch"
    options = write_options(context, dispatch_dir)
    invoke("prepare-disabled-ghosts", {**options, "owner_pid": 4242})
    intent_path = next((options["authority_dir"]).glob("request-*.json"))
    intent = json.loads(intent_path.read_text())
    assert intent["schemaVersion"] == a.PREPARED_INTENT_SCHEMA and intent["state"] == "prepared"
    assert intent["workflow"] == context["info"]["workflow"]
    write(dispatch_dir / "observation.json", context["observation_for"]("active"))
    snapshot = json.loads(invoke("verify-prepared", options))["snapshot"]
    invoke("dispatch-prepared", {**options, "expected_snapshot": snapshot, "owner_pid": 4242})
    assert json.loads(intent_path.read_text())["state"] == "dispatching"

    discard_dir = temporary / f"frozen-{key}-discard"
    options = write_options(context, discard_dir)
    invoke("prepare-disabled-ghosts", {**options, "owner_pid": 4242})
    cleanup_options = {
        "request": options["request"], "repository": repository,
        "workflow_id": options["workflow_id"], "workflow_path": context["path"],
        "authority_dir": options["authority_dir"], "repo_root": root,
    }
    discard_snapshot = invoke("prepared-context", cleanup_options)
    invoke("discard-prepared", {**cleanup_options, "expected_snapshot": discard_snapshot})
    assert not list(options["authority_dir"].glob("request-*.json"))

print("frozen_transition_both_targets_tests=PASS", flush=True)

# --- Repository-global prepare fence spans both targets. ---
fence_dir = temporary / "frozen-fence"
data_context = build_context("data", 900101)
activate_context = build_context("activate", 900102)
data_options = write_options(data_context, fence_dir / "data")
data_options["authority_dir"] = fence_dir / "shared-authority"
data_options["authority_dir"].mkdir(mode=0o700, exist_ok=True)
activate_options = write_options(activate_context, fence_dir / "activate")
activate_options["authority_dir"] = data_options["authority_dir"]
invoke("prepare-disabled-ghosts", {**data_options, "owner_pid": 4242})
invoke("prepare-disabled-ghosts", {**activate_options, "owner_pid": 4242}, ok=False)
data_cleanup = {
    "request": data_options["request"], "repository": repository,
    "workflow_id": data_options["workflow_id"], "workflow_path": data_context["path"],
    "authority_dir": data_options["authority_dir"], "repo_root": root,
}
data_snapshot = invoke("prepared-context", data_cleanup)
invoke("discard-prepared", {**data_cleanup, "expected_snapshot": data_snapshot})
invoke("prepare-disabled-ghosts", {**activate_options, "owner_pid": 4242})
activate_cleanup = {
    "request": activate_options["request"], "repository": repository,
    "workflow_id": activate_options["workflow_id"], "workflow_path": activate_context["path"],
    "authority_dir": activate_options["authority_dir"], "repo_root": root,
}
activate_snapshot = invoke("prepared-context", activate_cleanup)
invoke("discard-prepared", {**activate_cleanup, "expected_snapshot": activate_snapshot})
print("frozen_transition_repository_global_fence_tests=PASS", flush=True)

# --- Cross-target rejection, both directions. ---
# (1) special_context's authority-helper gate rejects a non-frozen workflow
#     (the near-miss oci-capacity-acquire.yml, not an arbitrary workflow)
#     before touching any normalized/request evidence.
capacity_policy = json.loads(subprocess.check_output([policy_script, "get", "oci-capacity-acquire"]))
assert capacity_policy["workflow"] == "oci-capacity-acquire.yml"
gate_error = invoke("prepare-disabled-ghosts", {
    "request": "/nonexistent/request.json", "normalized": "/nonexistent/normalized.json",
    "inputs_file": "/nonexistent/inputs.json", "policy_json": json.dumps(capacity_policy),
    "repository": repository, "current_master": master, "workflow_id": 1,
    "workflow_blob_sha": "0" * 40, "observation_json": "/nonexistent/observation.json",
    "owner_pid": 4242, "authority_dir": temporary / "frozen-capacity-gate",
    "repo_root": root,
}, ok=False)
assert "frozen" in gate_error, gate_error

# (2) prepared-context/discard-prepared reject a workflow-path that does not
#     match the frozen entry of the intent's own operation, in both
#     directions.
cross_dir = temporary / "frozen-cross"
data_context2 = build_context("data", 900201)
options = write_options(data_context2, cross_dir)
invoke("prepare-disabled-ghosts", {**options, "owner_pid": 4242})
wrong_path_cleanup = {
    "request": options["request"], "repository": repository,
    "workflow_id": options["workflow_id"],
    "workflow_path": ".github/workflows/oci-live-betting-activate.yml",
    "authority_dir": options["authority_dir"], "repo_root": root,
}
invoke("prepared-context", wrong_path_cleanup, ok=False)
invoke("discard-prepared", {**wrong_path_cleanup, "expected_snapshot": "0" * 64}, ok=False)
right_path_cleanup = {**wrong_path_cleanup, "workflow_path": data_context2["path"]}
right_snapshot = invoke("prepared-context", right_path_cleanup)
invoke("discard-prepared", {**right_path_cleanup, "expected_snapshot": right_snapshot})

# (3) validate_prepared_seal rejects a seal whose workflowPath was rebound to
#     the OTHER frozen entry (simulated tamper/cross-target confusion).
activate_context2 = build_context("activate", 900202)
options2 = write_options(activate_context2, temporary / "frozen-cross-seal")
invoke("prepare-disabled-ghosts", {**options2, "owner_pid": 4242})
tampered_path = next(options2["authority_dir"].glob("request-*.json"))
tampered = json.loads(tampered_path.read_text())
tampered["preparedSeal"]["workflowPath"] = ".github/workflows/oci-live-data-rollout.yml"
try:
    a.validate_prepared_seal(tampered)
    raise AssertionError("tampered seal workflow path was accepted")
except SystemExit as error:
    assert "workflow path" in str(error)

# (4) read_transition_observation rejects an observation whose target does
#     not match the requested operation's own frozen workflow, in both
#     directions, and still requires a nonempty candidate set even when the
#     target is named correctly.
class Args:
    pass

mismatch_args = Args()
mismatch_args.observation_json = str(temporary / "mismatch-observation.json")
mismatch_args.repository = repository
mismatch_args.current_master = master
mismatch_args.workflow_id = data_context2["info"]["workflow_id"]
write(Path(mismatch_args.observation_json), data_context2["observation_for"]("disabled_manually"))
try:
    a.read_transition_observation(mismatch_args, "disabled_manually", "oci-live-betting-activate.yml")
    raise AssertionError("cross-target observation target was accepted")
except SystemExit as error:
    assert "target" in str(error)

empty_args = Args()
empty_args.observation_json = str(temporary / "empty-observation.json")
empty_args.repository = repository
empty_args.current_master = master
empty_args.workflow_id = data_context2["info"]["workflow_id"]
empty_observation = {
    "schemaVersion": a.TRANSITION_OBSERVATION_SCHEMA, "repository": repository,
    "controlSha": master, "inventorySha256": inventory_sha256,
    "target": {"workflow": "oci-live-data-rollout.yml", "path": data_context2["path"]},
    "candidates": [], "workflows": [], "blockers": [],
}
write(Path(empty_args.observation_json), empty_observation)
try:
    a.read_transition_observation(empty_args, "disabled_manually", "oci-live-data-rollout.yml")
    raise AssertionError("empty-candidate observation was accepted")
except SystemExit as error:
    assert "nonempty" in str(error)

print("frozen_transition_cross_target_rejection_tests=PASS", flush=True)

# --- Reverse-direction cross-target rejection (activation presented to
# data). Every check above used a live-data intent/seal/observation presented
# where activation was expected. Prove the mirror image too: an activation
# intent/seal/observation presented where data is expected must be rejected
# by the exact same generic checks, not by a live-data-specific special case.
reverse_cross_dir = temporary / "frozen-cross-reverse"
activate_context3 = build_context("activate", 900301)
options = write_options(activate_context3, reverse_cross_dir)
invoke("prepare-disabled-ghosts", {**options, "owner_pid": 4242})
wrong_path_cleanup_reverse = {
    "request": options["request"], "repository": repository,
    "workflow_id": options["workflow_id"],
    "workflow_path": ".github/workflows/oci-live-data-rollout.yml",
    "authority_dir": options["authority_dir"], "repo_root": root,
}
invoke("prepared-context", wrong_path_cleanup_reverse, ok=False)
invoke("discard-prepared", {**wrong_path_cleanup_reverse, "expected_snapshot": "0" * 64}, ok=False)
right_path_cleanup_reverse = {**wrong_path_cleanup_reverse, "workflow_path": activate_context3["path"]}
right_snapshot_reverse = invoke("prepared-context", right_path_cleanup_reverse)
invoke("discard-prepared", {**right_path_cleanup_reverse, "expected_snapshot": right_snapshot_reverse})

# validate_prepared_seal rejects a DATA seal rebound to the ACTIVATION frozen
# entry (mirror of the earlier activation-seal-rebound-to-data check).
data_context3 = build_context("data", 900302)
options3 = write_options(data_context3, temporary / "frozen-cross-seal-reverse")
invoke("prepare-disabled-ghosts", {**options3, "owner_pid": 4242})
tampered_path_reverse = next(options3["authority_dir"].glob("request-*.json"))
tampered_reverse = json.loads(tampered_path_reverse.read_text())
tampered_reverse["preparedSeal"]["workflowPath"] = ".github/workflows/oci-live-betting-activate.yml"
try:
    a.validate_prepared_seal(tampered_reverse)
    raise AssertionError("tampered seal workflow path was accepted (reverse direction)")
except SystemExit as error:
    assert "workflow path" in str(error)

# read_transition_observation rejects an ACTIVATION-shaped observation
# presented where DATA is the requested operation (mirror of the earlier
# data-shaped-observation-presented-to-activation check).
reverse_mismatch_args = Args()
reverse_mismatch_args.observation_json = str(temporary / "reverse-mismatch-observation.json")
reverse_mismatch_args.repository = repository
reverse_mismatch_args.current_master = master
reverse_mismatch_args.workflow_id = data_context3["info"]["workflow_id"]
write(Path(reverse_mismatch_args.observation_json), activate_context3["observation_for"]("disabled_manually"))
try:
    a.read_transition_observation(reverse_mismatch_args, "disabled_manually", "oci-live-data-rollout.yml")
    raise AssertionError("cross-target observation target was accepted (reverse direction)")
except SystemExit as error:
    assert "target" in str(error)

print("frozen_transition_cross_target_reverse_rejection_tests=PASS", flush=True)

# Exercise the actual POST-A/POST-B authority commands with a valid
# preparation from the other frozen target. Copying that self-bound authority
# under the destination lookup key makes the command inspect and reject the
# foreign identity instead of passing only because no destination file exists.
def assert_cross_target_checkpoint_rejection(source_key, destination_key, source_run, destination_run):
    case_dir = temporary / f"frozen-command-{source_key}-to-{destination_key}"
    source_context = build_context(source_key, source_run)
    destination_context = build_context(destination_key, destination_run)
    source_options = write_options(source_context, case_dir / "source")
    destination_options = write_options(destination_context, case_dir / "destination")

    invoke("prepare-disabled-ghosts", {**source_options, "owner_pid": 4242})
    write(
        Path(source_options["observation_json"]),
        source_context["observation_for"]("active"),
    )
    source_snapshot = json.loads(invoke("verify-prepared", source_options))["snapshot"]

    authority_dir = source_options["authority_dir"]
    source_intent_path = next(authority_dir.glob("request-*.json"))
    source_intent_before = source_intent_path.read_bytes()
    source_intent = json.loads(source_intent_before)
    capture_path = authority_dir / source_intent["captureFile"]
    capture_before = capture_path.read_bytes()
    capture_stat_before = (
        capture_path.stat().st_dev,
        capture_path.stat().st_ino,
        capture_path.stat().st_size,
        capture_path.stat().st_mtime_ns,
        capture_path.stat().st_ctime_ns,
    )
    assert source_intent["state"] == "prepared"
    assert capture_before == b""

    write(
        Path(destination_options["observation_json"]),
        destination_context["observation_for"]("active"),
    )
    destination_options = {
        **destination_options,
        "authority_dir": authority_dir,
    }
    destination_key_hash = a.request_key(destination_context["normalized"])
    foreign_intent_path = a.intent_path(authority_dir, destination_key_hash)
    assert foreign_intent_path != source_intent_path
    foreign_intent_path.write_bytes(source_intent_before)
    foreign_intent_path.chmod(0o600)
    foreign_intent_before = foreign_intent_path.read_bytes()

    verify_error = invoke("verify-prepared", destination_options, ok=False)
    assert verify_error == "dispatch intent request key mismatch", verify_error
    dispatch_error = invoke(
        "dispatch-prepared",
        {
            **destination_options,
            "expected_snapshot": source_snapshot,
            "owner_pid": 4242,
        },
        ok=False,
    )
    assert dispatch_error == "dispatch intent request key mismatch", dispatch_error

    assert source_intent_path.read_bytes() == source_intent_before
    assert foreign_intent_path.read_bytes() == foreign_intent_before
    assert json.loads(source_intent_path.read_text())["state"] == "prepared"
    capture_files = list(authority_dir.glob("dispatch-*.log"))
    assert capture_files == [capture_path], capture_files
    assert capture_path.read_bytes() == capture_before == b""
    assert (
        capture_path.stat().st_dev,
        capture_path.stat().st_ino,
        capture_path.stat().st_size,
        capture_path.stat().st_mtime_ns,
        capture_path.stat().st_ctime_ns,
    ) == capture_stat_before

    foreign_intent_path.unlink()
    cleanup_options = {
        "request": source_options["request"],
        "repository": repository,
        "workflow_id": source_options["workflow_id"],
        "workflow_path": source_context["path"],
        "authority_dir": authority_dir,
        "repo_root": root,
    }
    cleanup_snapshot = invoke("prepared-context", cleanup_options)
    invoke(
        "discard-prepared",
        {**cleanup_options, "expected_snapshot": cleanup_snapshot},
    )
    assert not list(authority_dir.glob("request-*.json"))
    assert not list(authority_dir.glob("dispatch-*.log"))
    print(
        f"frozen_transition_{source_key}_to_{destination_key}_"
        "checkpoint_rejection_tests=PASS",
        flush=True,
    )


assert_cross_target_checkpoint_rejection("activate", "data", 900401, 900402)
assert_cross_target_checkpoint_rejection("data", "activate", 900403, 900404)
print("frozen_transition_cross_target_checkpoint_rejection_tests=PASS", flush=True)
PY

# ============================================================================
# Real-dispatcher activation acceptance (validation-critic remediation).
#
# Every prepared-lifecycle assertion above invokes the Python authority
# helper directly. That proves the authority module's own admission/target
# logic, but never proves the actual bash entrypoint
# (copilot-cli-dispatch-stan.sh) routes a real oci-live-betting-activate.yml
# request through it, or that the real production-run-exclusivity-stan.sh
# observer is actually invoked with the activation target. This section
# drives the real dispatcher end to end -- stubbing only the gh/git process
# boundary, never network -- for both the disabled-only discard path and the
# prepare-then-active-dispatch path, then proves two concrete regressions
# (dispatcher admission reverted to live-data-only; observer call target
# hardcoded to live-data) would make this exact test fail.
# ============================================================================
(
set -euo pipefail

ACT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/betstan-activation-dispatch-test.XXXXXX")"
chmod 700 "$ACT_TMP"
trap 'rm -rf "$ACT_TMP"' EXIT

ACT_REPO="example/repo"
ACT_MASTER="1010101010101010101010101010101010101010"
ACT_OLD_SHA="2020202020202020202020202020202020202020"
ACT_WORKFLOW="oci-live-betting-activate.yml"
ACT_WORKFLOW_PATH=".github/workflows/oci-live-betting-activate.yml"
ACT_WORKFLOW_ID=415
ACT_GHOST_RUN_ID=951001
ACT_NEW_RUN_ID=951101
ACT_CURRENT_BLOB="3030303030303030303030303030303030303030"

ACT_STATE_FILE="$ACT_TMP/workflow-state"
ACT_OBSERVE_LOG="$ACT_TMP/observe-calls.log"
ACT_DISPATCH_COUNT="$ACT_TMP/dispatch-count"
ACT_CAPTURED_INPUTS="$ACT_TMP/captured-inputs.json"

# Exact historical activation source already proven valid (job/environment/
# guard/mutation-token shape required by UNMATERIALIZED_WORKFLOWS) by
# test-production-run-exclusivity-stan.sh's own oci-live-betting-activate.yml
# fixture. Reused verbatim so this section does not silently drift from that
# proof.
read -r -d '' ACT_HISTORICAL_SOURCE <<'EOF' || true
name: oci-live-betting-activate
run-name: oci-live-activate ${{ inputs.approved_sha }}
concurrency:
  group: oci-control-plane
  cancel-in-progress: false
jobs:
  activate-and-validate:
    environment:
      name: oci-production
    steps:
      - run: |
          [ "$SOURCE_SHA" = "$GITHUB_SHA" ]
          git fetch --quiet origin master:refs/remotes/origin/master
          [ "$SOURCE_SHA" = "$(git rev-parse origin/master)" ]
          ./infra/oci/scripts/authorize-github-runner.sh cleanup-stale
          ./infra/oci/scripts/authorize-github-runner.sh authorize
          ./infra/oci/scripts/configure-k3s-access.sh open
          kubectl exec -n "$OCI_K8S_NAMESPACE"
          node dist/scripts/SetUserRole.js
          curl --fail-with-body
          ./client/node_modules/.bin/playwright test
      - run: ./infra/oci/scripts/live-betting-control-stan.sh
          ./infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh
          ./infra/oci/scripts/revoke-github-runner.sh
          ./infra/oci/scripts/configure-k3s-access.sh cleanup
EOF

emit_historical_content() {
  python3 - <<PYEOF
import base64, hashlib, json
source = """$ACT_HISTORICAL_SOURCE""".encode("utf-8")
print(json.dumps({
    "type": "file", "path": "$ACT_WORKFLOW_PATH", "encoding": "base64",
    "size": len(source),
    "sha": hashlib.sha1(f"blob {len(source)}\\0".encode() + source).hexdigest(),
    "content": base64.b64encode(source).decode("ascii"),
}, separators=(",", ":")))
PYEOF
}

emit_run_json() {
  local run_id="$1" head_sha="$2" status="$3" title="$4"
  python3 - "$run_id" "$head_sha" "$status" "$title" \
    "$ACT_WORKFLOW_ID" "$ACT_WORKFLOW_PATH" "$ACT_REPO" <<'PYEOF'
import json, sys
run_id, head_sha, status, title, workflow_id, path, repository = sys.argv[1:]
print(json.dumps({
    "id": int(run_id), "workflow_id": int(workflow_id), "path": path,
    "display_title": title, "event": "workflow_dispatch",
    "head_sha": head_sha, "head_branch": "master",
    "head_repository": {"id": 101, "full_name": repository},
    "repository": {"id": 101, "full_name": repository},
    "run_attempt": 1, "status": status, "conclusion": None,
    "created_at": "1970-01-01T00:00:00Z", "run_started_at": "1970-01-01T00:00:00Z",
    "updated_at": "1970-01-01T00:00:00Z",
    "html_url": f"https://github.com/{repository}/actions/runs/{run_id}",
    "url": f"https://api.github.com/repos/{repository}/actions/runs/{run_id}",
}, separators=(",", ":")))
PYEOF
}

ACT_GHOST_RUN_JSON="$(emit_run_json "$ACT_GHOST_RUN_ID" "$ACT_OLD_SHA" queued oci-live-betting-activate)"
ACT_NEW_RUN_JSON="$(emit_run_json "$ACT_NEW_RUN_ID" "$ACT_MASTER" waiting "oci-live-activate $ACT_MASTER")"
export ACT_GHOST_RUN_JSON ACT_NEW_RUN_JSON

write_activation_request() {
  local path="$1"
  python3 - "$path" "$ACT_MASTER" "$ACT_REPO" <<'PYEOF'
import json, os, sys
path, sha, repository = sys.argv[1:]
request = {
    "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
    "repository": repository, "operation": "oci-live-betting-activate",
    "controlSha": sha, "subjectSha": sha, "targetSha": None,
    "inputs": {
        "approved_sha": sha, "build_run_id": "42",
        "infrastructure_run_id": "43", "deployment_run_id": "44",
        "confirmation": "ACTIVATE OCI LIVE BETTING",
    },
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(request, handle)
    handle.write("\n")
os.chmod(path, 0o600)
PYEOF
}

# Real dispatcher/exclusivity gh(1)/git(1) process-boundary stub. Every
# response is a fixed, deterministic shape for the one activation candidate;
# no STUB_MODE matrix is needed because this section proves one concrete
# real-dispatcher acceptance path, not the full malformed-evidence matrix
# (already covered elsewhere for the shared authority/exclusivity code).
git() {
  if [[ "$1" = "-C" ]]; then shift 2; fi
  case "$1" in
    rev-parse)
      case "$2" in
        --show-toplevel) printf '%s\n' "$ROOT_DIR" ;;
        HEAD) printf '%s\n' "$ACT_MASTER" ;;
        "$ACT_MASTER:$ACT_WORKFLOW_PATH") printf '%s\n' "$ACT_CURRENT_BLOB" ;;
        *) echo "unexpected git rev-parse: $*" >&2; return 1 ;;
      esac
      ;;
    status) return 0 ;;
    *) echo "unexpected git call: $*" >&2; return 1 ;;
  esac
}

gh() {
  if [[ "$1 $2" = "repo view" ]]; then
    printf '%s\n' "$ACT_REPO"
    return 0
  fi
  if [[ "$1" = "workflow" && "$2" = "run" ]]; then
    [[ "$3" = "$ACT_WORKFLOW" ]] ||
      { echo "unexpected workflow run target: $3" >&2; return 1; }
    local count=0
    [[ -f "$ACT_DISPATCH_COUNT" ]] && count="$(cat "$ACT_DISPATCH_COUNT")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$ACT_DISPATCH_COUNT"
    cat >"$ACT_CAPTURED_INPUTS"
    printf 'https://github.com/%s/actions/runs/%s\n' "$ACT_REPO" "$ACT_NEW_RUN_ID"
    return 0
  fi
  [[ "$1" = "api" ]] || { echo "unexpected gh invocation: $*" >&2; return 1; }
  local endpoint="$2"
  shift 2
  local jq_filter=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --jq) jq_filter="$2"; shift 2 ;;
      --paginate) shift ;;
      -H) shift 2 ;;
      *) echo "unexpected gh api flag: $1" >&2; return 1 ;;
    esac
  done
  local body=""
  case "$endpoint" in
    "repos/$ACT_REPO/git/ref/heads/master")
      body="$(printf '{"object":{"sha":"%s"}}' "$ACT_MASTER")"
      ;;
    "repos/$ACT_REPO/actions/workflows/$ACT_WORKFLOW")
      body="$(printf '{"id":%s,"path":"%s","state":"%s"}' \
        "$ACT_WORKFLOW_ID" "$ACT_WORKFLOW_PATH" "$(cat "$ACT_STATE_FILE")")"
      ;;
    "repos/$ACT_REPO/actions/workflows/$ACT_WORKFLOW_ID")
      # Only production-run-exclusivity-stan.sh's per-candidate evidence
      # gathering ever queries the numeric workflow ID form (the dispatcher
      # itself always uses the basename form above). Logging every call here
      # is therefore an exact, unambiguous PRE/POST-A/POST-B observer-
      # invocation trace: one line per real observe-mode subprocess run, in
      # order, carrying the workflow state that run actually observed.
      cat "$ACT_STATE_FILE" >>"$ACT_OBSERVE_LOG"
      body="$(printf '{"id":%s,"path":"%s","state":"%s"}' \
        "$ACT_WORKFLOW_ID" "$ACT_WORKFLOW_PATH" "$(cat "$ACT_STATE_FILE")")"
      ;;
    "repos/$ACT_REPO/contents/$ACT_WORKFLOW_PATH?ref=$ACT_MASTER")
      body="$(printf '{"sha":"%s"}' "$ACT_CURRENT_BLOB")"
      ;;
    "repos/$ACT_REPO/contents/$ACT_WORKFLOW_PATH?ref=$ACT_OLD_SHA")
      body="$(emit_historical_content)"
      ;;
    "repos/$ACT_REPO/commits/$ACT_MASTER/pulls")
      body="$(printf '[{"merged_at":"2026-01-01T00:00:00Z","merge_commit_sha":"%s","base":{"ref":"master"},"head":{"ref":"dev"},"labels":[{"name":"copilot-cli-managed"}]}]' "$ACT_MASTER")"
      ;;
    "repos/$ACT_REPO/actions/runs?status="*)
      if [[ "$endpoint" == *"status=queued"* ]]; then
        body="$(printf '{"total_count":1,"workflow_runs":[%s]}' "$ACT_GHOST_RUN_JSON")"
      else
        body='{"total_count":0,"workflow_runs":[]}'
      fi
      ;;
    "repos/$ACT_REPO/actions/runs/$ACT_GHOST_RUN_ID")
      body="$ACT_GHOST_RUN_JSON"
      ;;
    "repos/$ACT_REPO/actions/runs/$ACT_GHOST_RUN_ID/jobs?per_page=1")
      body='{"total_count":0,"jobs":[]}'
      ;;
    "repos/$ACT_REPO/actions/runs/$ACT_GHOST_RUN_ID/pending_deployments")
      body='[]'
      ;;
    "repos/$ACT_REPO/actions/runs/$ACT_GHOST_RUN_ID/approvals")
      body='[]'
      ;;
    "repos/$ACT_REPO/actions/runs/$ACT_GHOST_RUN_ID/artifacts?per_page=1")
      body='{"total_count":0,"artifacts":[]}'
      ;;
    "repos/$ACT_REPO/compare/$ACT_OLD_SHA...$ACT_MASTER")
      body="$(printf '{"status":"ahead","ahead_by":1,"behind_by":0,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}' \
        "$ACT_OLD_SHA" "$ACT_OLD_SHA" "$ACT_MASTER")"
      ;;
    "repos/$ACT_REPO/actions/runs/$ACT_NEW_RUN_ID")
      body="$ACT_NEW_RUN_JSON"
      ;;
    # Only reached if a regression makes the observer fall through to the
    # generic (non-semantic) classifier for this candidate -- e.g. because
    # its target was hardcoded away from the requested activation path. A
    # real environment would answer this too; answering it here lets the
    # mutation-guard scenario below fail on the *intended* target-mismatch
    # check rather than on an incidental "unexpected endpoint" error.
    "repos/$ACT_REPO/actions/workflows/$ACT_WORKFLOW_ID/runs?head_sha="*)
      body='{"total_count":0,"workflow_runs":[]}'
      ;;
    *)
      echo "unexpected gh api endpoint: $endpoint" >&2
      return 1
      ;;
  esac
  if [[ -n "$jq_filter" ]]; then
    jq -r "$jq_filter" <<<"$body"
  else
    printf '%s\n' "$body"
  fi
}
export -f git gh emit_historical_content
export ROOT_DIR ACT_REPO ACT_MASTER ACT_OLD_SHA ACT_WORKFLOW ACT_WORKFLOW_PATH \
  ACT_WORKFLOW_ID ACT_GHOST_RUN_ID ACT_NEW_RUN_ID ACT_CURRENT_BLOB \
  ACT_STATE_FILE ACT_OBSERVE_LOG ACT_DISPATCH_COUNT ACT_CAPTURED_INPUTS \
  ACT_HISTORICAL_SOURCE

run_activation_dispatcher() {
  local authority_dir="$1"
  shift
  TMPDIR="$ACT_TMP" \
  COPILOT_CLI_AUTHORITY_DIR="$authority_dir" \
  COPILOT_CLI_MATERIALIZATION_ATTEMPTS=2 \
  COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS=0 \
    "$DISPATCHER" "$@"
}

# --- Scenario 1: real disabled-prepare + disabled-only discard. No provider
# call, and exactly one real observer invocation (PRE), ever occurs. ---
discard_authority="$ACT_TMP/authority-discard"
discard_request="$ACT_TMP/discard-request.json"
write_activation_request "$discard_request"
printf 'disabled_manually\n' >"$ACT_STATE_FILE"
: >"$ACT_OBSERVE_LOG"
: >"$ACT_DISPATCH_COUNT"
run_activation_dispatcher "$discard_authority" "$discard_request" \
  --prepare-disabled-ghosts >"$ACT_TMP/discard-prepare.out"
grep -qF "dispatch=PREPARED" "$ACT_TMP/discard-prepare.out"
# Attempting to discard while active is rejected: discard is disabled-only.
printf 'active\n' >"$ACT_STATE_FILE"
if run_activation_dispatcher "$discard_authority" "$discard_request" \
  --discard-prepared >"$ACT_TMP/discard-active.out" 2>"$ACT_TMP/discard-active.err"; then
  echo "discard unexpectedly accepted an active (non-disabled) workflow" >&2
  exit 1
fi
grep -qF "exact freshly disabled workflow" "$ACT_TMP/discard-active.err"
printf 'disabled_manually\n' >"$ACT_STATE_FILE"
run_activation_dispatcher "$discard_authority" "$discard_request" \
  --discard-prepared >"$ACT_TMP/discard.out"
grep -qF "dispatch=DISCARDED" "$ACT_TMP/discard.out"
[[ "$(cat "$ACT_OBSERVE_LOG")" = "disabled_manually" ]] ||
  { echo "discard scenario: expected exactly one PRE observer invocation" >&2; exit 1; }
[[ ! -s "$ACT_DISPATCH_COUNT" ]] ||
  { echo "discard scenario: a provider dispatch call was made" >&2; exit 1; }
[[ -z "$(find "$discard_authority" -maxdepth 1 -type f -name 'request-*.json')" ]] ||
  { echo "discard scenario: prepared intent was not removed" >&2; exit 1; }
echo "activation_real_dispatcher_discard_tests=PASS"

# --- Scenario 2: real disabled-prepare, then real active dispatch, with two
# fresh POST observations (POST-A verify-prepared, POST-B dispatch-prepared),
# exactly one captured provider call, then exact capture recovery with no
# redispatch. ---
dispatch_authority="$ACT_TMP/authority-dispatch"
dispatch_request="$ACT_TMP/dispatch-request.json"
write_activation_request "$dispatch_request"
printf 'disabled_manually\n' >"$ACT_STATE_FILE"
: >"$ACT_OBSERVE_LOG"
: >"$ACT_DISPATCH_COUNT"
run_activation_dispatcher "$dispatch_authority" "$dispatch_request" \
  --prepare-disabled-ghosts >"$ACT_TMP/dispatch-prepare.out"
grep -qF "dispatch=PREPARED" "$ACT_TMP/dispatch-prepare.out"
printf 'active\n' >"$ACT_STATE_FILE"
run_activation_dispatcher "$dispatch_authority" "$dispatch_request" \
  --dispatch-prepared >"$ACT_TMP/dispatch.out"
grep -qF "dispatch=ACCEPTED run_id=$ACT_NEW_RUN_ID" "$ACT_TMP/dispatch.out"
grep -qF "authority_state=issued" "$ACT_TMP/dispatch.out"
[[ "$(cat "$ACT_OBSERVE_LOG")" = "$(printf 'disabled_manually\nactive\nactive')" ]] ||
  {
    echo "dispatch scenario: expected exactly PRE=disabled_manually," \
      "POST-A=active, POST-B=active observer invocations, got:" >&2
    cat "$ACT_OBSERVE_LOG" >&2
    exit 1
  }
[[ "$(cat "$ACT_DISPATCH_COUNT")" = "1" ]] ||
  { echo "dispatch scenario: expected exactly one captured provider call" >&2; exit 1; }
python3 - "$ACT_CAPTURED_INPUTS" "$ACT_MASTER" <<'PYEOF'
import json, sys
path, master = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    captured = json.load(handle)
assert captured == {
    "approved_sha": master, "build_run_id": "42",
    "infrastructure_run_id": "43", "deployment_run_id": "44",
    "confirmation": "ACTIVATE OCI LIVE BETTING",
}, captured
PYEOF
# Exact capture recovery: resuming from the persisted capture must not
# redispatch the provider.
run_activation_dispatcher "$dispatch_authority" "$dispatch_request" \
  --resume-captured >"$ACT_TMP/resume.out"
grep -qF "run_id=$ACT_NEW_RUN_ID" "$ACT_TMP/resume.out"
[[ "$(cat "$ACT_DISPATCH_COUNT")" = "1" ]] ||
  { echo "resume-captured redispatched the provider" >&2; exit 1; }
echo "activation_real_dispatcher_dispatch_tests=PASS"

# --- Mutation guards: prove this exact scenario fails if either safety
# property regresses. Each guard runs the real (unmodified) dispatcher logic
# from a shadow root that is entirely symlinks except for one sed-mutated
# copy of copilot-cli-dispatch-stan.sh, so ROOT_DIR-relative sibling script
# resolution stays correct while only the mutated behavior changes. ---
build_shadow_root() {
  local shadow="$1"
  mkdir -p "$shadow/infra/azure/agents" "$shadow/infra/oci/scripts"
  ln -s "$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py" \
    "$shadow/infra/azure/agents/copilot_cli_authority_stan.py"
  ln -s "$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh" \
    "$shadow/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
  ln -s "$ROOT_DIR/infra/azure/agents/production-run-exclusivity-stan.sh" \
    "$shadow/infra/azure/agents/production-run-exclusivity-stan.sh"
  ln -s "$ROOT_DIR/infra/oci/scripts/upstream_run_binding_stan.py" \
    "$shadow/infra/oci/scripts/upstream_run_binding_stan.py"
}

gate_shadow_root="$ACT_TMP/mutant-admission-gate"
build_shadow_root "$gate_shadow_root"
gate_mutant="$gate_shadow_root/infra/azure/agents/copilot-cli-dispatch-stan.sh"
sed -e 's/is_disabled_transition_workflow "\$workflow" ||/[[ "$workflow" = "oci-live-data-rollout.yml" ]] ||/' \
  "$DISPATCHER" >"$gate_mutant"
chmod +x "$gate_mutant"
diff -q "$DISPATCHER" "$gate_mutant" >/dev/null &&
  { echo "admission-gate mutation did not change the dispatcher source" >&2; exit 1; }
gate_authority="$ACT_TMP/authority-gate-mutant"
gate_request="$ACT_TMP/gate-mutant-request.json"
write_activation_request "$gate_request"
printf 'disabled_manually\n' >"$ACT_STATE_FILE"
: >"$ACT_OBSERVE_LOG"
: >"$ACT_DISPATCH_COUNT"
if TMPDIR="$ACT_TMP" COPILOT_CLI_AUTHORITY_DIR="$gate_authority" \
  COPILOT_CLI_MATERIALIZATION_ATTEMPTS=2 COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS=0 \
  "$gate_mutant" "$gate_request" --prepare-disabled-ghosts \
  >"$ACT_TMP/gate-mutant.out" 2>"$ACT_TMP/gate-mutant.err"; then
  echo "mutation guard failed: admission reverted to live-data-only still accepted activation" >&2
  cat "$ACT_TMP/gate-mutant.out" "$ACT_TMP/gate-mutant.err" >&2
  exit 1
fi
grep -qF "restricted to the frozen" "$ACT_TMP/gate-mutant.err"
echo "activation_real_dispatcher_admission_mutation_guard=PASS"

observer_shadow_root="$ACT_TMP/mutant-observer-target"
build_shadow_root "$observer_shadow_root"
observer_mutant="$observer_shadow_root/infra/azure/agents/copilot-cli-dispatch-stan.sh"
sed -e 's/--observe-disabled-transition "\$workflow" \\/--observe-disabled-transition "oci-live-data-rollout.yml" \\/' \
  "$DISPATCHER" >"$observer_mutant"
chmod +x "$observer_mutant"
diff -q "$DISPATCHER" "$observer_mutant" >/dev/null &&
  { echo "observer-target mutation did not change the dispatcher source" >&2; exit 1; }
grep -qF 'observe-disabled-transition "oci-live-data-rollout.yml"' "$observer_mutant"
observer_authority="$ACT_TMP/authority-observer-mutant"
observer_request="$ACT_TMP/observer-mutant-request.json"
write_activation_request "$observer_request"
printf 'disabled_manually\n' >"$ACT_STATE_FILE"
: >"$ACT_OBSERVE_LOG"
: >"$ACT_DISPATCH_COUNT"
if TMPDIR="$ACT_TMP" COPILOT_CLI_AUTHORITY_DIR="$observer_authority" \
  COPILOT_CLI_MATERIALIZATION_ATTEMPTS=2 COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS=0 \
  "$observer_mutant" "$observer_request" --prepare-disabled-ghosts \
  >"$ACT_TMP/observer-mutant.out" 2>"$ACT_TMP/observer-mutant.err"; then
  echo "mutation guard failed: observer hardcoded to live-data still accepted activation" >&2
  cat "$ACT_TMP/observer-mutant.out" "$ACT_TMP/observer-mutant.err" >&2
  exit 1
fi
grep -qF "transition observation target does not match the requested operation" \
  "$ACT_TMP/observer-mutant.err"
echo "activation_real_dispatcher_observer_mutation_guard=PASS"

echo "activation_real_dispatcher_tests=PASS"
)

PROFILE_DIR="$tmp_dir/profile-dispatch"
PROFILE_BIN="$PROFILE_DIR/bin"
PROFILE_FIXTURES="$PROFILE_DIR/fixtures"
mkdir -m 700 -p "$PROFILE_BIN" "$PROFILE_FIXTURES"

python3 - "$PROFILE_FIXTURES" "$SHA" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
import zipfile

root = Path(sys.argv[1])
source = sys.argv[2]
repository = "ghcr.io/vasilyevstan/betstan-images"
services = [
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry",
]

def env(values):
    return "".join(f"{key}={value}\n" for key, value in values.items()).encode()

def checksummed(files):
    result = dict(files)
    result["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(files[name]).hexdigest()}  {name}\n"
        for name in sorted(files)
    ).encode()
    return result

def archive(artifact_id, files):
    with zipfile.ZipFile(
        root / f"{artifact_id}.zip", "w", zipfile.ZIP_DEFLATED
    ) as bundle:
        for name, raw in files.items():
            bundle.writestr(name, raw)

image_rows = []
for service in services:
    manifest = "sha256:" + hashlib.sha256(
        (service + "-manifest").encode()
    ).hexdigest()
    platform = "sha256:" + hashlib.sha256(
        (service + "-platform").encode()
    ).hexdigest()
    image_rows.append(
        "\t".join(
            (service, repository, f"{repository}@{manifest}", manifest, platform)
        )
    )
images_raw = ("\n".join(image_rows) + "\n").encode()
archive(9041, {
    "build-chain.txt": env({
        "source_sha": source,
        "build_run_id": "41",
        "build_run_attempt": "1",
        "registry_provider": "ghcr",
        "registry_host": "ghcr.io",
        "registry_repository": repository,
        "registry_public": "true",
        "anonymous_pull": "pass",
    }),
    "images.tsv": images_raw,
})

infrastructure_raw = env({
    "source_sha": source,
    "infrastructure_run_id": "47",
    "infrastructure_run_attempt": "1",
    "infrastructure_finalized": "true",
    "runtime_mode": "oke",
    "ghcr_build_run_id": "41",
    "ghcr_package_validation_run_id": "42",
    "capacity_acquisition_run_id": "0",
})
archive(9047, {"provenance.env": infrastructure_raw})

checkpoint = {
    "schemaVersion": "k3s-release-disk-checkpoint.v1",
    "sourceSha": source,
    "controlSha": source,
    "infrastructureRunId": "47",
    "ghcrBuildRunId": "41",
    "producerRunId": "47",
    "producerRunAttempt": "1",
    "runtimeMode": "oke",
    "disposition": "NOT_APPLICABLE",
    "terminalStatus": "RELEASE_ELIGIBLE",
}
checkpoint["contentChecksumSha256"] = hashlib.sha256(
    json.dumps(checkpoint, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
archive(9147, {
    "checkpoint.json": json.dumps(
        checkpoint, sort_keys=True, separators=(",", ":")
    ).encode()
})

baseline = {
    "baseline_source_sha": source,
    "baseline_deploy_workflow": "oci-production-deploy",
    "baseline_deploy_run_id": "40",
    "baseline_deploy_run_attempt": "1",
    "baseline_build_workflow": "oci-production-build",
    "baseline_build_run_id": "39",
    "baseline_build_run_attempt": "1",
    "baseline_recovery_run_id": "0",
    "baseline_recovery_run_attempt": "0",
    "baseline_transition_provenance_file": "none",
    "baseline_capture_run_id": "48",
    "baseline_capture_run_attempt": "1",
    "namespace": "betstan-oci",
    "public_url": "https://betstan.xyz",
    "redirect_url": "https://www.betstan.xyz",
    "diagnostic_url": "https://192.0.2.1.nip.io",
    "http_attempts": "1",
    "http_retry_seconds": "0",
    "alias_probe_mode": "strict",
    "sse_path": "/api/event/events",
    "sse_requirement": "deployed-source",
    "sse_required": "true",
    "database_restore": "disabled",
    "registry_provider": "ghcr",
    "registry_host": "ghcr.io",
    "registry_repository": repository,
    "registry_public_anonymous": "true",
}
baseline_files = checksummed({
    "baseline-provenance.env": env(baseline),
    "evidence.txt": b"baseline\n",
})
archive(9051, baseline_files)
baseline_sha = hashlib.sha256(baseline_files["SHA256SUMS"]).hexdigest()

controls = {
    "backfill_complete": "true",
    "index_ready": "true",
    "event_reschedule_complete": "true",
    "backoffice_pre_september_cleanup_complete": "true",
    "maintenance_fence_enforced": "true",
    "writers_quiesced": "true",
    "runtime_held_for_deploy": "true",
    "operation_lock_enforced": "true",
    "operation_lock_handoff": "true",
}
predecessor = {
    "schema_version": "live-betting-v6",
    "source_sha": source,
    "build_run_id": "41",
    "infrastructure_run_id": "47",
    "checkpoint_source_sha": source,
    "disk_checkpoint_run_id": "47",
    "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
    "disk_checkpoint_disposition": "NOT_APPLICABLE",
    "baseline_sha256": baseline_sha,
    "baseline_recovery_run_id": "0",
    "baseline_recovery_source_sha": "none",
    "workflow_run_id": "48",
    "workflow_run_attempt": "1",
    "phase": "apply-slip-index",
    "status": "PASS",
    **controls,
    "completed_at": "2026-01-01T00:00:00Z",
}
predecessor_files = checksummed({"provenance.env": env(predecessor)})
archive(9048, predecessor_files)
predecessor_sha = hashlib.sha256(
    predecessor_files["SHA256SUMS"]
).hexdigest()

schema = {
    "schema_version": "live-betting-v6",
    "source_sha": source,
    "build_run_id": "41",
    "infrastructure_run_id": "47",
    "checkpoint_source_sha": source,
    "disk_checkpoint_run_id": "47",
    "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
    "disk_checkpoint_disposition": "NOT_APPLICABLE",
    "baseline_sha256": baseline_sha,
    "baseline_recovery_run_id": "0",
    "baseline_recovery_source_sha": "none",
    "data_run_id": "48",
    "data_run_attempt": "1",
    **controls,
}
rabbit_raw = b"queue\t0\n"

def deployment(run_id):
    return {
        "provenance.txt": env({
            "source_sha": source,
            "source_ref": "refs/heads/master",
            "run_attempt": "1",
            "runtime_mode": "oke",
            "runtime_fingerprint": hashlib.sha256(b"runtime").hexdigest(),
            "image_provenance_sha256": hashlib.sha256(images_raw).hexdigest(),
            "rendered_manifest_sha256": hashlib.sha256(b"manifest").hexdigest(),
            "rabbitmq_baseline_sha256": hashlib.sha256(rabbit_raw).hexdigest(),
            "public_host": "betstan.xyz",
            "canonical_host": "betstan.xyz",
            "redirect_host": "www.betstan.xyz",
            "diagnostic_host": "192.0.2.1.nip.io",
            "deployment_workflow": "oci-production-deploy",
            "deployment_run_id": str(run_id),
            "deployment_run_attempt": "1",
            "registry_provider": "ghcr",
            "registry_host": "ghcr.io",
            "registry_repository": repository,
            "registry_public_anonymous": "true",
            "build_run_id": "41",
            "data_run_id": "48",
            "data_run_attempt": "1",
            "data_evidence_sha256": predecessor_sha,
            "infrastructure_run_id": "47",
            "infrastructure_run_attempt": "1",
            "infrastructure_provenance_sha256":
                hashlib.sha256(infrastructure_raw).hexdigest(),
            "checkpoint_source_sha": source,
            "disk_checkpoint_run_id": "47",
            "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
            "disk_checkpoint_disposition": "NOT_APPLICABLE",
        }),
        "images.tsv": images_raw,
        "rabbitmq-baseline.txt": rabbit_raw,
        "live-schema.env": env(schema),
    }

def deployment_recovery(run_id):
    intent = env({
        "schema_version": "oci-deployment-recovery-authority-v1",
        "source_sha": source,
        "source_ref": "refs/heads/master",
        "deployment_workflow": "oci-production-deploy",
        "deployment_run_id": str(run_id),
        "deployment_run_attempt": "1",
        "runtime_mode": "oke",
        "build_run_id": "41",
        "candidate_images_sha256": hashlib.sha256(images_raw).hexdigest(),
        "data_run_id": "48",
        "data_run_attempt": "1",
        "data_evidence_sha256": predecessor_sha,
        "infrastructure_run_id": "47",
        "infrastructure_run_attempt": "1",
        "infrastructure_provenance_sha256":
            hashlib.sha256(infrastructure_raw).hexdigest(),
        "checkpoint_source_sha": source,
        "disk_checkpoint_run_id": "47",
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": "NOT_APPLICABLE",
        "baseline_sha256": baseline_sha,
        "baseline_capture_run_id": "48",
        "baseline_recovery_run_id": "0",
        "baseline_recovery_source_sha": "none",
    })
    intent_sha = hashlib.sha256(intent).hexdigest()
    return checksummed({
        "deployment-intent.env": intent,
        "deployment-intent.sha256":
            f"{intent_sha}  deployment-intent.env\n".encode(),
        "failure-lineage.env": env({
            "schema_version": "oci-deployment-failure-lineage-v1",
            "source_sha": source,
            "deployment_run_id": str(run_id),
            "deployment_run_attempt": "1",
            "intent_sha256": intent_sha,
            "workflow_result": "failure",
            "lock_release_outcome": "skipped",
            "fence_release_outcome": "skipped",
            "rehold_outcome": "success",
        }),
        "images.tsv": images_raw,
    })

archive(9151, deployment(51))
archive(9154, deployment(54))
archive(9251, deployment_recovery(51))

control = b"after_flag=false\nafter_lease_until_epoch=0\n"
control_sha = hashlib.sha256(control).hexdigest()
activation = {
    "source_sha": source,
    "build_run_id": "41",
    "infrastructure_run_id": "47",
    "deployment_run_id": "54",
    "checkpoint_source_sha": source,
    "disk_checkpoint_run_id": "47",
    "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
    "disk_checkpoint_disposition": "NOT_APPLICABLE",
    "live_acceptance_user_id": "0123456789abcdef01234567",
    "activation_run_id": "53",
    "activation_run_attempt": "1",
    "activate_control_sha256": "none",
    "acceptance_sha256": "none",
    "accepted_sha256": "none",
    "commit_control_sha256": "none",
    "failure_disable_sha256": control_sha,
    "final_disable_sha256": "none",
    "final_control_file": "artifacts/live-control/failure-disable/control.env",
    "final_control_sha256": control_sha,
    "live_kickoffs_enabled": "false",
    "activation_state": "dark",
    "activation_lease_until_epoch": "0",
    "workflow_result": "failure",
    "workflow_phase": "acceptance-fallback",
    "accepted_outcome": "failure",
    "accepted_evidence_upload_outcome": "skipped",
    "commit_preflight_outcome": "skipped",
    "commit_outcome": "skipped",
    "failure_disable_outcome": "success",
    "final_disable_outcome": "skipped",
    "post_commit_status": "not-applicable",
    "revoke_runner_outcome": "success",
    "close_bastion_outcome": "success",
}
activation_recovery = checksummed({
    "provenance.env": env(activation),
    "failure-disable/control.env": control,
})
archive(9053, activation_recovery)
archive(9253, {
    "provenance.env": env(activation),
    "failure-disable/control.env": control,
    "images.tsv": images_raw,
    "restarts-before.json": b"[]\n",
    "readiness-before/summary.env": b"status=PASS\n",
    "readiness-activated/summary.env": b"status=PASS\n",
})
PY

cat >"$PROFILE_BIN/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" = -C ]]; then
  shift 2
fi
case "${1:-} ${2:-}" in
  "status --porcelain")
    exit 0
    ;;
  "rev-parse --show-toplevel")
    printf '%s\n' "$PROFILE_ROOT"
    ;;
  "rev-parse HEAD")
    printf '%s\n' "$PROFILE_SHA"
    ;;
  "cat-file -e"|"fetch --quiet"|"merge-base --is-ancestor")
    exit 0
    ;;
  *)
    if [[ "${1:-}" = rev-parse && "${2:-}" = "$PROFILE_SHA:.github/workflows/oci-live-data-rollout.yml" ]]; then
      printf '%s\n' "$PROFILE_BLOB"
    else
      echo "unexpected profile git call: $*" >&2
      exit 1
    fi
    ;;
esac
SH
chmod 755 "$PROFILE_BIN/git"

cat >"$PROFILE_BIN/gh" <<'PY'
#!/usr/bin/env python3
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import zipfile

args = sys.argv[1:]
repository = os.environ["PROFILE_REPOSITORY"]
source = os.environ["PROFILE_SHA"]
fixtures = Path(os.environ["PROFILE_FIXTURES"])
mutation = os.environ.get("PROFILE_MUTATION", "")

def output(value):
    if "--jq" in args:
        query = args[args.index("--jq") + 1]
        if query == ".object.sha":
            print(value["object"]["sha"])
        elif query == ".sha":
            print(value["sha"])
        elif query == ".state":
            print(value["state"])
        elif query in {".value", ".value // empty"}:
            print(value["value"])
        elif query == "[.id,.path,.state] | @tsv":
            print("\t".join(str(value[key]) for key in ("id", "path", "state")))
        else:
            raise SystemExit(f"unexpected jq query: {query}")
    else:
        print(json.dumps(value, separators=(",", ":")))

def env_parse(raw):
    return dict(line.split("=", 1) for line in raw.decode().splitlines())

def env_dump(values):
    return "".join(f"{key}={value}\n" for key, value in values.items()).encode()

def reseal(files):
    files.pop("SHA256SUMS", None)
    files["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(files[name]).hexdigest()}  {name}\n"
        for name in sorted(files)
    ).encode()

def mutated_archive(artifact_id):
    raw = (fixtures / f"{artifact_id}.zip").read_bytes()
    if artifact_id == 9051 and mutation == "metadata-only":
        print("gh: HTTP 404", file=sys.stderr)
        raise SystemExit(1)
    if artifact_id == 9051 and mutation == "malformed-zip":
        return b"not-a-zip"
    with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
        files = {name: bundle.read(name) for name in bundle.namelist()}
    if artifact_id == 9051:
        if mutation == "missing-zip-content":
            files.pop("evidence.txt")
        elif mutation == "bad-checksum":
            files["evidence.txt"] = b"substituted\n"
        elif mutation == "bad-capture-run":
            values = env_parse(files["baseline-provenance.env"])
            values["baseline_capture_run_id"] = "99"
            files["baseline-provenance.env"] = env_dump(values)
            reseal(files)
    if artifact_id == 9048:
        v6_mutations = {
            "v6-source_sha": ("source_sha", "b" * 40),
            "v6-build_run_id": ("build_run_id", "99"),
            "v6-infrastructure_run_id": ("infrastructure_run_id", "99"),
            "v6-checkpoint_source_sha": ("checkpoint_source_sha", "b" * 40),
            "v6-disk_checkpoint_run_id": ("disk_checkpoint_run_id", "99"),
            "v6-disk_checkpoint_sha256": ("disk_checkpoint_sha256", "d" * 64),
            "v6-disk_checkpoint_disposition": (
                "disk_checkpoint_disposition", "READY_NO_RECLAIM"
            ),
            "v6-baseline_sha256": ("baseline_sha256", "e" * 64),
            "v6-recovery_tuple": ("baseline_recovery_run_id", "99"),
            "v6-workflow_run_id": ("workflow_run_id", "99"),
            "v6-phase": ("phase", "dry-run"),
        }
        if mutation in v6_mutations:
            values = env_parse(files["provenance.env"])
            key, value = v6_mutations[mutation]
            values[key] = value
            files["provenance.env"] = env_dump(values)
            reseal(files)
    if artifact_id == 9053:
        activation_mutations = {
            "activation-source_sha": ("source_sha", "b" * 40),
            "activation-build_run_id": ("build_run_id", "99"),
            "activation-infrastructure_run_id": ("infrastructure_run_id", "99"),
            "activation-deployment_run_id": ("deployment_run_id", "51"),
            "activation-checkpoint_source_sha": (
                "checkpoint_source_sha", "b" * 40
            ),
            "activation-disk_checkpoint_run_id": (
                "disk_checkpoint_run_id", "99"
            ),
            "activation-disk_checkpoint_sha256": (
                "disk_checkpoint_sha256", "d" * 64
            ),
            "activation-disk_checkpoint_disposition": (
                "disk_checkpoint_disposition", "READY_NO_RECLAIM"
            ),
        }
        if mutation in activation_mutations:
            values = env_parse(files["provenance.env"])
            key, value = activation_mutations[mutation]
            values[key] = value
            files["provenance.env"] = env_dump(values)
            reseal(files)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, content in files.items():
            bundle.writestr(name, content)
    return archive.getvalue()

def run(run_id):
    values = {
        41: (304, "oci-production-build.yml", "workflow_run",
             f"oci-build {source} upstream-40", "success", "00", "01"),
        47: (310, "oci-infrastructure.yml", "workflow_dispatch",
             f"oci-infrastructure finalize oke {source}", "success", "10", "11"),
        48: (313, "oci-live-data-rollout.yml", "workflow_dispatch",
             f"oci-live-data apply-slip-index {source}", "success", "12", "13"),
        51: (305, "oci-production-deploy.yml", "workflow_dispatch",
             f"oci-deploy {source}", "failure", "18", "19"),
        53: (307, "oci-live-betting-activate.yml", "workflow_dispatch",
             f"oci-live-activate {source}", "failure", "20", "21"),
        54: (305, "oci-production-deploy.yml", "workflow_dispatch",
             f"oci-deploy {source}", "success", "16", "17"),
    }[run_id]
    workflow_id, workflow, event, title, conclusion, created, updated = values
    return {
        "id": run_id,
        "workflow_id": workflow_id,
        "path": f".github/workflows/{workflow}",
        "display_title": title,
        "event": event,
        "head_sha": source,
        "head_branch": "master",
        "head_repository": {"full_name": repository},
        "run_attempt": 1,
        "status": "completed",
        "conclusion": conclusion,
        "created_at": f"2026-01-01T00:{created}:00Z",
        "updated_at": f"2026-01-01T00:{updated}:00Z",
    }

def artifact(artifact_id, name):
    return {
        "id": artifact_id,
        "name": name,
        "expired": False,
        "size_in_bytes": 4096,
    }

if args[:2] == ["repo", "view"]:
    print(repository)
    raise SystemExit(0)
if not args or args[0] != "api":
    raise SystemExit(f"unexpected profile gh call: {args!r}")
endpoint = args[1].removeprefix(f"repos/{repository}/")
slurp = "--slurp" in args

workflow_ids = {
    "oci-production-build.yml": 304,
    "oci-production-deploy.yml": 305,
    "oci-live-betting-activate.yml": 307,
    "oci-infrastructure.yml": 310,
    "oci-live-data-rollout.yml": 313,
}
if endpoint == "git/ref/heads/master":
    output({"object": {"sha": source}})
elif endpoint == f"commits/{source}/pulls":
    output([{
        "merged_at": "2026-01-01T00:00:00Z",
        "merge_commit_sha": source,
        "base": {"ref": "master"},
        "head": {"ref": "dev"},
        "labels": [{"name": "copilot-cli-managed"}],
    }])
elif endpoint.startswith("contents/.github/workflows/"):
    output({"sha": os.environ["PROFILE_BLOB"]})
elif endpoint.startswith("environments/") and endpoint.endswith(
    "/variables/OCI_RUNTIME_MODE"
):
    output({"value": "oke"})
elif endpoint.startswith("actions/workflows/") and "/runs?" in endpoint:
    page = {"total_count": 0, "workflow_runs": []}
    output([page] if slurp else page)
elif endpoint.startswith("actions/runs?status="):
    page = {"total_count": 0, "workflow_runs": []}
    output([page] if slurp else page)
elif endpoint.startswith("actions/workflows/"):
    workflow = endpoint.removeprefix("actions/workflows/")
    if workflow.isdigit():
        workflow_id = int(workflow)
        workflow = next(
            name for name, candidate in workflow_ids.items()
            if candidate == workflow_id
        )
    else:
        workflow_id = workflow_ids[workflow]
    output({
        "id": workflow_id,
        "path": f".github/workflows/{workflow}",
        "state": (
            "disabled_manually"
            if workflow == "oci-live-data-rollout.yml"
            else "active"
        ),
    })
elif endpoint.startswith("actions/runs/") and "/artifacts?" in endpoint:
    run_id = int(endpoint.split("/")[2])
    inventories = {
        41: [[artifact(
            9041, f"oci-image-provenance-{source}-41-1"
        )]],
        47: [[
            artifact(9047, "oci-infrastructure-provenance-47-1"),
            artifact(
                9147, f"oci-release-disk-checkpoint-{source}-47-1"
            ),
        ]],
        48: [[artifact(9048, "oci-live-data-rollout-48-1")]],
        51: [
            [artifact(9051, "oci-production-baseline-51-1")],
            [
                artifact(9151, "oci-deploy-provenance-51-1"),
                artifact(
                    9251, "oci-deploy-recovery-authority-51-1"
                ),
            ],
        ],
        53: [[
            artifact(9053, "oci-live-activation-recovery-53-1"),
            artifact(9253, "oci-live-activation-53-1"),
        ]],
        54: [[artifact(9154, "oci-deploy-provenance-54-1")]],
    }
    pages = [
        {"total_count": sum(map(len, inventories[run_id])), "artifacts": rows}
        for rows in inventories[run_id]
    ]
    output(pages if slurp else pages[0])
elif endpoint.startswith("actions/artifacts/") and endpoint.endswith("/zip"):
    artifact_id = int(endpoint.split("/")[2])
    sys.stdout.buffer.write(mutated_archive(artifact_id))
elif endpoint.startswith("actions/runs/") and "/jobs?" in endpoint:
    run_id = int(endpoint.split("/")[2])
    if run_id == 51:
        jobs = [
            {
                "name": "deploy",
                "conclusion": "failure",
                "steps": [
                    {
                        "name":
                            "Release transferred lock after protected validation",
                        "conclusion": "skipped",
                    },
                    {
                        "name": "Release live data maintenance fence",
                        "conclusion": "skipped",
                    },
                    {
                        "name":
                            "Re-enter maintenance after an incomplete deployment",
                        "conclusion": "success",
                    },
                    {
                        "name":
                            "Write checksum-bound deployment recovery intent",
                        "conclusion": "success",
                    },
                    {
                        "name": "Finalize deployment recovery authority",
                        "conclusion": "success",
                    },
                    {
                        "name": "Upload deployment recovery authority",
                        "conclusion": "success",
                    },
                ],
            },
            {"name": "public-validate", "conclusion": "skipped", "steps": []},
        ]
    elif run_id == 53:
        jobs = [{
            "name": "activate-and-validate",
            "conclusion": "failure",
            "steps": [
                {"name": "Resolve reusable validation account",
                 "conclusion": "success"},
                {"name": "Revoke and clean reusable validation account",
                 "conclusion": "failure"},
                {"name": "Enforce dark mode unless activation committed",
                 "conclusion": "success"},
                {"name": "Write final activation provenance",
                 "conclusion": "success"},
                {"name": "Upload protected activation evidence",
                 "conclusion": "success"},
                {"name": "Upload activation recovery authority",
                 "conclusion": "success"},
            ],
        }]
    else:
        raise SystemExit(f"unexpected jobs run: {run_id}")
    pages = [
        {"total_count": len(jobs), "jobs": [job]}
        for job in jobs
    ]
    output(pages if slurp else pages[0])
elif endpoint.startswith("actions/runs/"):
    run_id = int(endpoint.split("/")[2])
    output(run(run_id))
else:
    raise SystemExit(f"unexpected profile gh endpoint: {endpoint}")
PY
chmod 755 "$PROFILE_BIN/gh"

write_profile_request() {
  local operation="$1"
  local destination="$2"
  local policy_json
  policy_json="$("$POLICY" get "$operation")"
  python3 - \
    "$destination" "$SHA" "$REPOSITORY" "$operation" "$policy_json" <<'PY'
import json
import os
import sys

destination, source, repository, operation, policy_json = sys.argv[1:]
policy = json.loads(policy_json)
inputs = dict(policy["fixedInputs"])
values = {
    "approved_sha": source,
    "build_run_id": "41",
    "infrastructure_run_id": "47",
    "checkpoint_source_sha": source,
    "disk_checkpoint_run_id": "47",
    "resume_source_sha": source,
    "prerequisite_run_id": "48",
    "baseline_recovery_run_id": "0",
    "baseline_recovery_source_sha": "none",
    "failed_deploy_run_id": (
        "0" if "activation" in operation else "51"
    ),
    "failed_activation_run_id": (
        "53" if "activation" in operation else "0"
    ),
    "failed_activation_user_id": (
        "0123456789abcdef01234567" if "activation" in operation else "0"
    ),
}
for name in policy["inputNames"]:
    if name not in inputs:
        inputs[name] = values[name]
request = {
    "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
    "repository": repository,
    "operation": operation,
    "controlSha": source,
    "subjectSha": source,
    "targetSha": None,
    "inputs": inputs,
}
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(request, handle)
    handle.write("\n")
os.chmod(destination, 0o600)
PY
}

PROFILE_RETAINED_REQUEST="$PROFILE_DIR/retained-request.json"
PROFILE_ACTIVATION_REQUEST="$PROFILE_DIR/activation-request.json"
write_profile_request oci-live-data-resume-deploy "$PROFILE_RETAINED_REQUEST"
write_profile_request \
  oci-live-data-resume-activation "$PROFILE_ACTIVATION_REQUEST"

run_profile_dispatch() {
  local request="$1"
  local mutation="${2:-}"
  (
    unset -f git gh
    export PATH="$PROFILE_BIN:$PATH"
    export PROFILE_ROOT="$ROOT_DIR"
    export PROFILE_SHA="$SHA"
    export PROFILE_BLOB="$BLOB"
    export PROFILE_REPOSITORY="$REPOSITORY"
    export PROFILE_FIXTURES PROFILE_MUTATION="$mutation"
    export COPILOT_CLI_AUTHORITY_DIR="$PROFILE_DIR/authority-$mutation"
    "$DISPATCHER" "$request"
  )
}

run_profile_dispatch "$PROFILE_RETAINED_REQUEST" \
  >"$PROFILE_DIR/retained.out" 2>"$PROFILE_DIR/retained.err"
grep -qF "dispatch=READY operation=oci-live-data-resume-deploy" \
  "$PROFILE_DIR/retained.out"
run_profile_dispatch "$PROFILE_ACTIVATION_REQUEST" \
  >"$PROFILE_DIR/activation.out" 2>"$PROFILE_DIR/activation.err"
grep -qF "dispatch=READY operation=oci-live-data-resume-activation" \
  "$PROFILE_DIR/activation.out"

assert_profile_dispatch_rejected() {
  local request="$1"
  local mutation="$2"
  if run_profile_dispatch "$request" "$mutation" \
    >"$PROFILE_DIR/$mutation.out" 2>"$PROFILE_DIR/$mutation.err"; then
    echo "dispatcher accepted fixed-profile artifact mutation: $mutation" >&2
    exit 1
  fi
  grep -qF "upstream run bindings were rejected before any authority was issued" \
    "$PROFILE_DIR/$mutation.err"
}

for mutation in \
  metadata-only malformed-zip missing-zip-content bad-checksum bad-capture-run \
  v6-source_sha v6-build_run_id v6-infrastructure_run_id \
  v6-checkpoint_source_sha v6-disk_checkpoint_run_id \
  v6-disk_checkpoint_sha256 v6-disk_checkpoint_disposition \
  v6-baseline_sha256 v6-recovery_tuple v6-workflow_run_id v6-phase; do
  assert_profile_dispatch_rejected "$PROFILE_RETAINED_REQUEST" "$mutation"
done
for mutation in \
  activation-source_sha activation-build_run_id \
  activation-infrastructure_run_id activation-deployment_run_id \
  activation-checkpoint_source_sha activation-disk_checkpoint_run_id \
  activation-disk_checkpoint_sha256 \
  activation-disk_checkpoint_disposition; do
  assert_profile_dispatch_rejected "$PROFILE_ACTIVATION_REQUEST" "$mutation"
done
echo "dispatcher_profile_artifact_rejection_tests=PASS"

echo "copilot_cli_dispatch_tests=PASS"
