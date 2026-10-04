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

# Real Git, not the -C-discarding unit stub below. All repositories, provider
# calls and authority records belong to this synthetic temporary fixture.
python3 -I - "$ROOT_DIR" "$tmp_dir" <<'PY'
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

source, temporary = map(Path, sys.argv[1:])
context = (temporary / "real-context").resolve()
repo = context / "repo"
ambient = context / "non-repository-cwd"
bin_dir = context / "bin"
for directory in (repo, ambient, bin_dir):
    directory.mkdir(parents=True)
clean_env = {
    key: value for key, value in os.environ.items()
    if not key.startswith(("GIT_", "BASH_FUNC_")) and key not in ("BASH_ENV", "ENV")
}
clean_env.update(
    GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_SYSTEM=os.devnull,
    GIT_CONFIG_GLOBAL=os.devnull, GIT_ATTR_NOSYSTEM="1",
)
real_git = shutil.which("git")
assert real_git

def git(*args):
    return subprocess.check_output(
        [real_git, "-C", str(repo), *args], env=clean_env, text=True,
    ).strip()

scripts = repo / "infra/azure/agents"
scripts.mkdir(parents=True)
for name in (
    "copilot-cli-run-approval-stan.sh", "copilot-cli-dispatch-stan.sh",
    "copilot-cli-protected-operation-policy-stan.sh",
    "copilot_cli_authority_stan.py", "production-run-exclusivity-stan.sh",
):
    shutil.copy2(source / "infra/azure/agents" / name, scripts / name)
workflow = repo / ".github/workflows/production-deploy.yml"
workflow.parent.mkdir(parents=True)
shutil.copy2(source / workflow.relative_to(repo), workflow)
binding_validator = repo / "infra/oci/scripts/upstream_run_binding_stan.py"
binding_validator.parent.mkdir(parents=True)
shutil.copy2(source / binding_validator.relative_to(repo), binding_validator)
git("init", "-q", "--template=")
assert Path(git("rev-parse", "--show-toplevel")).resolve() == repo
assert Path(git("rev-parse", "--absolute-git-dir")).resolve() == repo / ".git"
git("config", "--local", "user.name", "fixture")
git("config", "--local", "user.email", "fixture@example.invalid")
git("remote", "add", "origin", "https://github.com/example/repo.git")
git("add", ".")
git("-c", "commit.gpgSign=false", "commit", "-qm", "context fixture")
sha = git("rev-parse", "HEAD")
blob = git("rev-parse", "HEAD:.github/workflows/production-deploy.yml")
provider = bin_dir / "gh"
provider.write_text("#!" + sys.executable + "\n" + r'''
import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
context = Path(os.environ["CONTEXT_FIXTURE"])
root = context / "repo"
with (context / "calls.jsonl").open("a") as log:
    log.write(json.dumps({"args": args, "cwd": os.getcwd(), "repo": os.environ.get("GH_REPO")}) + "\n")
assert Path.cwd() == root, "provider inherited ambient rather than verified script CWD"
assert os.environ.get("GH_HOST") == "github.com", "provider inherited an unverified GitHub host"
sha, blob = os.environ["CONTEXT_SHA"], os.environ["CONTEXT_BLOB"]
prefix = "repos/example/repo/"
if args[:2] == ["repo", "view"]:
    assert not os.environ.get("GH_REPO"), "ambient GH_REPO selected discovery"
    origin = subprocess.check_output(
        [os.environ["CONTEXT_GIT"], "-C", str(root), "remote", "get-url", "origin"], text=True,
    ).strip()
    assert origin == "https://github.com/example/repo.git"
    data = {"nameWithOwner": "example/repo"}
else:
    assert os.environ.get("GH_REPO") == "example/repo", "nested repository context drift"
    if args[:2] == ["workflow", "run"]:
        assert args[2] == "production-deploy.yml"
        json.load(sys.stdin)
        print("https://github.com/example/repo/actions/runs/7001")
        raise SystemExit(0)
    assert args[0] == "api", args
    if args[1:3] == ["--method", "POST"]:
        assert args[3] == prefix + "actions/runs/7001/pending_deployments"
        assert "environment_ids[]=901" in args
        (context / "approved").write_text("approved")
        data = {}
    else:
        endpoint = args[1]
        if endpoint == prefix + "git/ref/heads/master":
            data = {"object": {"sha": os.environ.get("CONTEXT_MASTER", sha)}}
        elif endpoint == prefix + "actions/workflows/production-deploy.yml":
            data = {"id": 302, "path": ".github/workflows/production-deploy.yml", "state": "active"}
        elif endpoint == prefix + f"contents/.github/workflows/production-deploy.yml?ref={sha}":
            data = {"sha": blob}
        elif endpoint == prefix + f"commits/{sha}/pulls":
            data = [{"merged_at": "2026-01-01T00:00:00Z", "merge_commit_sha": sha,
                     "base": {"ref": "master"}, "head": {"ref": "dev"},
                     "labels": [{"name": "copilot-cli-managed"}]}]
        elif endpoint == prefix + "actions/runs/7001":
            data = {"id": 7001, "workflow_id": 302, "path": ".github/workflows/production-deploy.yml",
                    "display_title": f"deploy {sha}", "event": "workflow_dispatch", "head_sha": sha,
                    "head_branch": "master", "head_repository": {"full_name": "example/repo"},
                    "run_attempt": 1, "status": "waiting", "conclusion": None}
        elif endpoint == prefix + "actions/runs/7001/jobs?per_page=100":
            data = {"total_count": 1, "jobs": [{"id": 1, "run_id": 7001, "status": "waiting"}]}
        elif endpoint == prefix + "actions/runs/7001/pending_deployments":
            data = [{"environment": {"id": 901, "name": "production-emergency"},
                     "current_user_can_approve": not (context / "approved").exists(),
                     "wait_timer": 0, "wait_timer_started_at": None}]
        elif endpoint == prefix + "actions/runs/7001/approvals":
            data = []
        elif endpoint.startswith(prefix + "actions/runs?status="):
            data = {"total_count": 0, "workflow_runs": []}
        elif endpoint == "user":
            data = {"login": "copilot-test-user"}
        else:
            raise AssertionError(args)
if "--jq" in args:
    subprocess.run(["jq", "-r", args[args.index("--jq") + 1]], input=json.dumps(data), text=True, check=True)
else:
    print(json.dumps(data))
''')
provider.chmod(0o700)
request = context / "request.json"
request.write_text(json.dumps({
    "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
    "repository": "example/repo", "operation": "production-deploy",
    "controlSha": sha, "subjectSha": sha, "targetSha": None,
    "inputs": {"approved_sha": sha, "build_run_id": "42"},
}))
request.chmod(0o600)
env = dict(
    clean_env, PATH=str(bin_dir) + os.pathsep + clean_env["PATH"],
    CONTEXT_FIXTURE=str(context), CONTEXT_SHA=sha, CONTEXT_BLOB=blob, CONTEXT_GIT=real_git,
    GH_HOST="unrelated.invalid", GH_REPO="unrelated/ambient",
    COPILOT_CLI_AUTHORITY_DIR=str(context / "authority"),
    COPILOT_CLI_AUTO_APPROVE="true", EXPECTED_OPERATION="production-deploy",
    COPILOT_CLI_MATERIALIZATION_ATTEMPTS="2", COPILOT_CLI_MATERIALIZATION_SLEEP_SECONDS="0",
)
dispatcher = scripts / "copilot-cli-dispatch-stan.sh"
approver = scripts / "copilot-cli-run-approval-stan.sh"

def run(script, *args, overrides=None, cwd=ambient):
    return subprocess.run(
        [str(script), *map(str, args)], cwd=cwd, env={**env, **(overrides or {})},
        capture_output=True, text=True, timeout=60,
    )

# A caller's CDPATH must not redirect relative script-root resolution either.
decoy = context / "decoy"
(decoy / "infra/azure/agents").mkdir(parents=True)
relative_dispatch = run(
    Path("infra/azure/agents") / dispatcher.name, request,
    overrides={"CDPATH": str(decoy)}, cwd=repo,
)
assert relative_dispatch.returncode == 0, relative_dispatch.stderr
dispatched = run(dispatcher, request, "--dispatch")
assert dispatched.returncode == 0, dispatched.stderr
assert "authority_state=issued" in dispatched.stdout
assert "job_gate_materialization=UNPROVEN" in dispatched.stdout
approved = run(approver, "7001", "--approve")
assert approved.returncode == 0, approved.stderr
assert "status=APPROVED" in approved.stdout
waiting = run(approver, "7001", "--approve")
assert waiting.returncode == 3, waiting.stderr
assert "status=WAIT" in waiting.stdout and "reason=approved-provider" in waiting.stdout
assert "status=ELIGIBLE" not in waiting.stdout and "status=APPROVED" not in waiting.stdout
relative_wait = run(
    Path("infra/azure/agents") / approver.name, "7001", "--approve",
    overrides={"CDPATH": str(decoy)}, cwd=repo,
)
assert relative_wait.returncode == 3 and "status=WAIT" in relative_wait.stdout, relative_wait.stderr
assert not git("status", "--porcelain", "--untracked-files=all")

def mutations():
    calls = [json.loads(line) for line in (context / "calls.jsonl").read_text().splitlines()]
    return [call for call in calls if call["args"][:2] == ["workflow", "run"] or "POST" in call["args"]]

before = mutations()
assert len(before) == 2
for script, args in ((dispatcher, (request, "--dispatch")), (approver, ("7001", "--approve"))):
    (repo / "untracked").write_text("must block\n")
    dirty = run(script, *args)
    (repo / "untracked").unlink()
    assert dirty.returncode == 1 and "status=BLOCK classification=technical reason=local-context" in dirty.stderr
    stale = run(script, *args, overrides={"CONTEXT_MASTER": "0" * 40})
    assert stale.returncode == 1 and "exact current master" in stale.stderr
    redirected = run(script, *args, overrides={"GIT_DIR": str(repo / ".git")})
    assert redirected.returncode == 1 and "inherited Git repository overrides" in redirected.stderr
    index = repo / ".git/index"
    original_index = index.read_bytes()
    try:
        index.write_bytes(b"invalid fixture index")
        unreadable = run(script, *args)
        assert unreadable.returncode == 1 and "unable to prove" in unreadable.stderr
    finally:
        index.write_bytes(original_index)
    git("remote", "remove", "origin")
    missing_origin = run(script, *args)
    git("remote", "add", "origin", "https://github.com/example/repo.git")
    assert missing_origin.returncode == 1 and "repository discovery failed" in missing_origin.stderr
    no_repo_script = context / "no-repository/infra/azure/agents" / script.name
    no_repo_script.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(script, no_repo_script)
    invalid_root = run(no_repo_script, *args)
    assert invalid_root.returncode == 1 and "unable to validate the script repository root" in invalid_root.stderr
    assert mutations() == before, "context failure reached a provider mutation"
print("copilot_cli_real_git_nonrepo_context_tests=PASS")
PY

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
    common-package-publish.yml) echo 316 ;;
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

binding_run_json() {
  local run_id="$1"
  local workflow workflow_id event title created_at updated_at
  local conclusion=success
  local subject_sha="${STUB_BINDING_SHA:-$SHA}"
  case "$run_id" in
    41)
      workflow=oci-production-build.yml
      event=workflow_run
      title="oci-build $subject_sha upstream-40"
      created_at=2026-01-01T00:00:00Z
      updated_at=2026-01-01T00:01:00Z
      ;;
    42)
      workflow=ghcr-package-management.yml
      event=workflow_dispatch
      title="ghcr-package validate $subject_sha"
      created_at="${STUB_PACKAGE_CREATED_AT:-2026-01-01T00:02:00Z}"
      updated_at=2026-01-01T00:03:00Z
      ;;
    43)
      workflow=oci-capacity-acquire.yml
      event=workflow_dispatch
      title="oci-capacity-acquire $subject_sha"
      created_at=2026-01-01T00:04:00Z
      updated_at=2026-01-01T00:05:00Z
      ;;
    44)
      workflow=oci-infrastructure.yml
      event=workflow_dispatch
      title="oci-infrastructure finalize k3s $subject_sha"
      created_at=2026-01-01T00:06:00Z
      updated_at=2026-01-01T00:07:00Z
      ;;
    45)
      workflow=oci-infrastructure.yml
      event=workflow_dispatch
      title="oci-infrastructure diagnose-disk k3s $subject_sha"
      created_at=2026-01-01T00:08:00Z
      updated_at=2026-01-01T00:09:00Z
      ;;
    47)
      workflow=oci-infrastructure.yml
      event=workflow_dispatch
      title="oci-infrastructure finalize oke $subject_sha"
      created_at=2026-01-01T00:10:00Z
      updated_at=2026-01-01T00:11:00Z
      ;;
    48)
      workflow=oci-live-data-rollout.yml
      event=workflow_dispatch
      title="oci-live-data apply-slip-index $subject_sha"
      created_at=2026-01-01T00:16:00Z
      updated_at=2026-01-01T00:17:00Z
      ;;
    49)
      workflow=oci-live-data-rollout.yml
      event=workflow_dispatch
      title="oci-live-data dry-run $subject_sha"
      created_at=2026-01-01T00:12:00Z
      updated_at=2026-01-01T00:13:00Z
      ;;
    50)
      workflow=oci-live-data-rollout.yml
      event=workflow_dispatch
      title="oci-live-data apply-backfills $subject_sha"
      created_at=2026-01-01T00:14:00Z
      updated_at=2026-01-01T00:15:00Z
      ;;
    51|52)
      workflow=oci-production-deploy.yml
      event=workflow_dispatch
      title="oci-production-deploy $subject_sha"
      created_at=2026-01-01T00:18:00Z
      updated_at=2026-01-01T00:19:00Z
      conclusion=failure
      ;;
    54)
      workflow=oci-production-deploy.yml
      event=workflow_dispatch
      title="oci-production-deploy $subject_sha"
      created_at=2026-01-01T00:18:00Z
      updated_at=2026-01-01T00:19:00Z
      ;;
    53)
      workflow=oci-live-betting-activate.yml
      event=workflow_dispatch
      title="oci-live-activate $subject_sha"
      created_at=2026-01-01T00:20:00Z
      updated_at=2026-01-01T00:21:00Z
      conclusion=failure
      ;;
    *)
      return 1
      ;;
  esac
  workflow_id="$(workflow_id_for "$workflow")"
  jq -cn \
    --argjson id "$run_id" \
    --argjson workflow_id "$workflow_id" \
    --arg path ".github/workflows/$workflow" \
    --arg title "$title" \
    --arg event "$event" \
    --arg sha "$subject_sha" \
    --arg repo "$REPOSITORY" \
    --arg created_at "$created_at" \
    --arg updated_at "$updated_at" \
    --arg conclusion "$conclusion" \
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
      conclusion:$conclusion,
      created_at:$created_at,
      updated_at:$updated_at
    }'
}

binding_artifacts_json() {
  local run_id="$1"
  local artifact artifact_id
  local subject_sha="${STUB_BINDING_SHA:-$SHA}"
  case "$run_id" in
    41) artifact="oci-image-provenance-$subject_sha-41-1"; artifact_id=9041 ;;
    42) artifact="ghcr-package-management-validate-42-1"; artifact_id=9042 ;;
    43) artifact="oci-capacity-provenance-43-1"; artifact_id=9043 ;;
    44) artifact="oci-infrastructure-provenance-44-1"; artifact_id=9044 ;;
    45) artifact="oci-k3s-disk-diagnosis-45-1"; artifact_id=9045 ;;
    47)
      jq -cn --arg subject_sha "$subject_sha" '{
        total_count:2,
        artifacts:[
          {
            id:9047,
            name:"oci-infrastructure-provenance-47-1",
            expired:false,
            size_in_bytes:4096
          },
          {
            id:9147,
            name:("oci-release-disk-checkpoint-" + $subject_sha + "-47-1"),
            expired:false,
            size_in_bytes:4096
          }
        ]
      }'
      return
      ;;
    48) artifact="oci-live-data-rollout-48-1"; artifact_id=9048 ;;
    49) artifact="oci-live-data-rollout-49-1"; artifact_id=9049 ;;
    50) artifact="oci-live-data-rollout-50-1"; artifact_id=9050 ;;
    51)
      jq -cn '{
        total_count:3,
        artifacts:[
          {id:9051,name:"oci-production-baseline-51-1",expired:false,size_in_bytes:4096},
          {id:9151,name:"oci-deploy-provenance-51-1",expired:false,size_in_bytes:4096},
          {id:9251,name:"oci-deploy-recovery-authority-51-1",expired:false,size_in_bytes:4096}
        ]
      }'
      return
      ;;
    52)
      jq -cn '{
        total_count:2,
        artifacts:[
          {id:9052,name:"oci-production-baseline-52-1",expired:false,size_in_bytes:4096},
          {id:9152,name:"oci-deploy-provenance-52-1",expired:false,size_in_bytes:4096}
        ]
      }'
      return
      ;;
    53) artifact="oci-live-activation-recovery-53-1"; artifact_id=9053 ;;
    54) artifact="oci-deploy-provenance-54-1"; artifact_id=9154 ;;
    *) return 1 ;;
  esac
  jq -cn --arg artifact "$artifact" --argjson artifact_id "$artifact_id" '{
    total_count:1,
    artifacts:[{
      id:$artifact_id,
      name:$artifact,
      expired:false,
      size_in_bytes:4096
    }]
  }'
}

binding_artifact_zip() {
  local artifact_id="$1"
  local file_name content
  local subject_sha="${STUB_BINDING_SHA:-$SHA}"
  case "$artifact_id" in
    9041|9048|9049|9050|9051|9052|9053|9151|9152|9154|9251)
      python3 - \
        "$artifact_id" \
        "$subject_sha" \
        "${STUB_BASELINE_RECOVERY_RUN_ID:-0}" \
        "${STUB_BASELINE_RECOVERY_SOURCE_SHA:-none}" \
        "${STUB_PROFILE_ARTIFACT_MUTATION:-}" <<'PY'
import hashlib
import io
import json
import sys
import zipfile

artifact_id = int(sys.argv[1])
source = sys.argv[2]
recovery_run = sys.argv[3]
recovery_source = sys.argv[4]
mutation = sys.argv[5]
repository = "ghcr.io/vasilyevstan/betstan-images"
services = [
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry",
]

def env(values):
    return "".join(f"{key}={value}\n" for key, value in values.items()).encode()

def checksummed(files):
    lines = []
    for name in sorted(files):
        lines.append(f"{hashlib.sha256(files[name]).hexdigest()}  {name}\n")
    result = dict(files)
    result["SHA256SUMS"] = "".join(lines).encode()
    return result

def archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, raw in files.items():
            bundle.writestr(name, raw)
    sys.stdout.buffer.write(output.getvalue())

def rewrite_checked_env(files, file_name, key, value):
    values = {}
    for line in files[file_name].decode().splitlines():
        current_key, current_value = line.split("=", 1)
        values[current_key] = current_value
    values[key] = value
    payload = {
        name: raw for name, raw in files.items()
        if name != "SHA256SUMS"
    }
    payload[file_name] = env(values)
    return checksummed(payload)

images = []
for service in services:
    manifest = "sha256:" + hashlib.sha256(
        (service + "-manifest").encode()
    ).hexdigest()
    platform = "sha256:" + hashlib.sha256(
        (service + "-platform").encode()
    ).hexdigest()
    images.append(
        "\t".join(
            (service, repository, f"{repository}@{manifest}", manifest, platform)
        )
    )
images_raw = ("\n".join(images) + "\n").encode()

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
    "terminalStatus": "NOT_APPLICABLE",
}
checkpoint["contentChecksumSha256"] = hashlib.sha256(
    json.dumps(checkpoint, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()

infrastructure_raw = (
    f"source_sha={source}\n"
    "infrastructure_run_id=47\n"
    "infrastructure_run_attempt=1\n"
    "infrastructure_finalized=true\n"
    "runtime_mode=oke\n"
    "ghcr_build_run_id=41\n"
    "ghcr_package_validation_run_id=42\n"
    "capacity_acquisition_run_id=0\n"
).encode()

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
baseline_sha = hashlib.sha256(baseline_files["SHA256SUMS"]).hexdigest()

def predecessor(run_id, phase):
    controls = {
        "backfill_complete": "false",
        "index_ready": "false",
        "event_reschedule_complete": "false",
        "backoffice_pre_september_cleanup_complete": "false",
        "maintenance_fence_enforced": "false",
        "writers_quiesced": "false",
        "runtime_held_for_deploy": "false",
        "operation_lock_enforced": "true",
        "operation_lock_handoff": "false",
    }
    if phase == "apply-backfills":
        controls.update({
            "backfill_complete": "true",
            "event_reschedule_complete": "true",
            "maintenance_fence_enforced": "true",
            "writers_quiesced": "true",
        })
    elif phase == "apply-slip-index":
        controls.update({key: "true" for key in controls})
    values = {
        "schema_version": "live-betting-v6",
        "source_sha": source,
        "build_run_id": "41",
        "infrastructure_run_id": "47",
        "checkpoint_source_sha": source,
        "disk_checkpoint_run_id": "47",
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": "NOT_APPLICABLE",
        "baseline_sha256": baseline_sha,
        "baseline_recovery_run_id": recovery_run,
        "baseline_recovery_source_sha": recovery_source,
        "workflow_run_id": str(run_id),
        "workflow_run_attempt": "1",
        "phase": phase,
        "status": "PASS",
        **controls,
        "completed_at": "2026-01-01T00:00:00Z",
    }
    return checksummed({"provenance.env": env(values)}), values

predecessor_files, predecessor_values = predecessor(48, "apply-slip-index")
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
    "baseline_recovery_run_id": recovery_run,
    "baseline_recovery_source_sha": recovery_source,
    "data_run_id": "48",
    "data_run_attempt": "1",
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
rabbit_raw = b"queue\t0\n"

def deployment(run_id):
    values = {
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
    }
    return {
        "provenance.txt": env(values),
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
        "baseline_recovery_run_id": recovery_run,
        "baseline_recovery_source_sha": recovery_source,
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

if mutation == "metadata-only" and artifact_id == 9051:
    raise SystemExit("artifact bytes intentionally unavailable")
if mutation == "malformed-zip" and artifact_id == 9051:
    sys.stdout.buffer.write(b"not-a-zip")
    raise SystemExit(0)

if artifact_id == 9041:
    archive({
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
elif artifact_id in {9048, 9049, 9050}:
    run_id, phase = {
        9048: (48, "apply-slip-index"),
        9049: (49, "dry-run"),
        9050: (50, "apply-backfills"),
    }[artifact_id]
    files = predecessor(run_id, phase)[0]
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
    if artifact_id == 9048 and mutation in v6_mutations:
        files = rewrite_checked_env(
            files, "provenance.env", *v6_mutations[mutation]
        )
    archive(files)
elif artifact_id in {9051, 9052}:
    files = dict(baseline_files)
    if artifact_id == 9051 and mutation == "missing-zip-content":
        files.pop("evidence.txt")
    elif artifact_id == 9051 and mutation == "bad-checksum":
        files["evidence.txt"] = b"substituted\n"
    elif artifact_id == 9051 and mutation == "bad-capture-run":
        files = rewrite_checked_env(
            files, "baseline-provenance.env",
            "baseline_capture_run_id", "99",
        )
    archive(files)
elif artifact_id in {9151, 9152, 9154}:
    archive(deployment({9151: 51, 9152: 52, 9154: 54}[artifact_id]))
elif artifact_id == 9251:
    archive(deployment_recovery(51))
else:
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
        "final_control_file":
            "artifacts/live-control/failure-disable/control.env",
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
    activation_mutations = {
        "activation-source_sha": ("source_sha", "b" * 40),
        "activation-build_run_id": ("build_run_id", "99"),
        "activation-infrastructure_run_id": ("infrastructure_run_id", "99"),
        "activation-deployment_run_id": ("deployment_run_id", "51"),
        "activation-checkpoint_source_sha": (
            "checkpoint_source_sha", "b" * 40
        ),
        "activation-disk_checkpoint_run_id": ("disk_checkpoint_run_id", "99"),
        "activation-disk_checkpoint_sha256": (
            "disk_checkpoint_sha256", "d" * 64
        ),
        "activation-disk_checkpoint_disposition": (
            "disk_checkpoint_disposition", "READY_NO_RECLAIM"
        ),
    }
    if mutation in activation_mutations:
        key, value = activation_mutations[mutation]
        activation[key] = value
    archive(checksummed({
        "provenance.env": env(activation),
        "failure-disable/control.env": control,
    }))
PY
      return
      ;;
  esac
  case "$artifact_id" in
    9041)
      file_name=build-chain.txt
      content="source_sha=$subject_sha
build_run_id=41
build_run_attempt=1
registry_provider=ghcr
registry_host=ghcr.io
registry_repository=ghcr.io/vasilyevstan/betstan-images
registry_public=true
anonymous_pull=pass
"
      ;;
    9042)
      file_name=validation-summary.json
      content="$(jq -cn \
        --arg candidate_build_run_id \
          "${STUB_PACKAGE_CANDIDATE_BUILD_ID:-41}" \
        '{
          terminal_status:"VALIDATED",
          registry_provider:"ghcr",
          registry_host:"ghcr.io",
          repository:"ghcr.io/vasilyevstan/betstan-images",
          package_visibility:"public",
          repository_linked:true,
          candidate_build_run_id:$candidate_build_run_id
        }')"
      ;;
    9043)
      file_name=provenance.env
      content="source_sha=$subject_sha
acquisition_run_id=43
runtime_mode=k3s
shape=VM.Standard.A1.Flex
ocpus=2
memory_gb=12
boot_volume_gb=50
boot_volume_vpus_per_gb=10
"
      ;;
    9044)
      file_name=provenance.env
      content="source_sha=$subject_sha
infrastructure_run_id=44
infrastructure_run_attempt=1
infrastructure_finalized=true
runtime_mode=k3s
ghcr_build_run_id=41
ghcr_package_validation_run_id=42
capacity_acquisition_run_id=43
"
      ;;
    9045)
      file_name=diagnosis.json
      content="$(jq -cn --arg sha "$subject_sha" \
        --arg schema "${STUB_DISK_DIAGNOSIS_SCHEMA:-k3s-node-disk-diagnosis.v2}" '{
        schemaVersion:$schema,
        sourceSha:$sha,
        workflowRunId:"45",
        workflowRunAttempt:"1",
        infrastructureRunId:"44",
        ghcrBuildRunId:"41",
        phase:"diagnose-disk",
        terminalStatus:"DIAGNOSED",
        thresholdPercent:70
      }')"
      ;;
    9047)
      file_name=provenance.env
      content="source_sha=$subject_sha
infrastructure_run_id=47
infrastructure_run_attempt=1
infrastructure_finalized=true
runtime_mode=oke
ghcr_build_run_id=41
ghcr_package_validation_run_id=42
capacity_acquisition_run_id=0
"
      ;;
    9147)
      file_name=checkpoint.json
      content="$(python3 - "$subject_sha" <<'PY'
import hashlib
import json
import sys

checkpoint = {
    "schemaVersion": "k3s-release-disk-checkpoint.v1",
    "sourceSha": sys.argv[1],
    "controlSha": sys.argv[1],
    "infrastructureRunId": "47",
    "ghcrBuildRunId": "41",
    "producerRunId": "47",
    "producerRunAttempt": "1",
    "runtimeMode": "oke",
    "disposition": "NOT_APPLICABLE",
    "terminalStatus": "NOT_APPLICABLE",
}
canonical = json.dumps(checkpoint, sort_keys=True, separators=(",", ":"))
checkpoint["contentChecksumSha256"] = hashlib.sha256(canonical.encode()).hexdigest()
print(json.dumps(checkpoint, sort_keys=True, separators=(",", ":")))
PY
)"
      ;;
    9048)
      file_name=provenance.env
      content="source_sha=$subject_sha
workflow_run_id=48
workflow_run_attempt=1
phase=apply-slip-index
schema_version=live-betting-v6
checkpoint_source_sha=$subject_sha
disk_checkpoint_run_id=47
"
      ;;
    9049)
      file_name=provenance.env
      content="source_sha=$subject_sha
workflow_run_id=49
workflow_run_attempt=1
phase=dry-run
schema_version=live-betting-v6
checkpoint_source_sha=$subject_sha
disk_checkpoint_run_id=47
"
      ;;
    9050)
      file_name=provenance.env
      content="source_sha=$subject_sha
workflow_run_id=50
workflow_run_attempt=1
phase=apply-backfills
schema_version=live-betting-v6
checkpoint_source_sha=$subject_sha
disk_checkpoint_run_id=47
"
      ;;
    9051|9052)
      file_name=baseline.env
      content="source_sha=$subject_sha
"
      ;;
    9053)
      file_name=provenance.env
      content="source_sha=$subject_sha
activation_run_id=53
activation_run_attempt=1
activation_state=dark
live_kickoffs_enabled=false
workflow_result=failure
live_acceptance_user_id=0123456789abcdef01234567
"
      ;;
    *)
      return 1
      ;;
  esac
  python3 - "$file_name" "$content" <<'PY'
import io
import sys
import zipfile

file_name, content = sys.argv[1:]
archive = io.BytesIO()
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
    bundle.writestr(file_name, content)
sys.stdout.buffer.write(archive.getvalue())
PY
}

binding_jobs_json() {
  local run_id="$1"
  case "$run_id" in
    51)
      jq -cn '{
        total_count:2,
        jobs:[
          {
            name:"deploy",
            conclusion:"failure",
            steps:[
              {name:"Write checksum-bound deployment recovery intent",conclusion:"success"},
              {name:"Release transferred lock after protected validation",conclusion:"skipped"},
              {name:"Release live data maintenance fence",conclusion:"skipped"},
              {name:"Re-enter maintenance after an incomplete deployment",conclusion:"success"},
              {name:"Finalize deployment recovery authority",conclusion:"success"},
              {name:"Upload deployment recovery authority",conclusion:"success"}
            ]
          },
          {name:"public-validate",conclusion:"skipped",steps:[]}
        ]
      }'
      ;;
    52)
      jq -cn '{
        total_count:2,
        jobs:[
          {
            name:"deploy",
            conclusion:"success",
            steps:[
              {name:"Release transferred lock after protected validation",conclusion:"success"},
              {name:"Release live data maintenance fence",conclusion:"success"},
              {name:"Re-enter maintenance after an incomplete deployment",conclusion:"skipped"}
            ]
          },
          {name:"public-validate",conclusion:"failure",steps:[]}
        ]
      }'
      ;;
    53)
      jq -cn '{
        total_count:1,
        jobs:[{
          name:"activate-and-validate",
          conclusion:"failure",
          steps:[
            {name:"Resolve reusable validation account",conclusion:"success"},
            {name:"Revoke and clean reusable validation account",conclusion:"failure"},
            {name:"Enforce dark mode unless activation committed",conclusion:"success"},
            {name:"Write final activation provenance",conclusion:"success"},
            {name:"Upload protected activation evidence",conclusion:"success"},
            {name:"Upload activation recovery authority",conclusion:"success"}
          ]
        }]
      }'
      ;;
    *) return 1 ;;
  esac
}

git() {
  if [[ "$1" = "-C" ]]; then
    shift 2
  fi
  if [[ "$1" = "status" ]]; then
    if [[ "${STUB_STATUS_FAIL_WHEN_INFLIGHT:-false}" = true ]] && authority_is_inflight; then
      return 1
    fi
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
    "merge-base --is-ancestor")
      [[ "${STUB_ANCESTOR_FAIL:-false}" != "true" ]]
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

authority_is_inflight() {
  local record="$authority_dir/${STUB_RUN_ID:-0}.json"
  [[ -f "$record" ]] && jq -e '.state == "inflight"' "$record" >/dev/null 2>&1
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

  if [[ -n "${STUB_GHOST_DIR:-}" ]]; then
    local ghost_fixture="$STUB_GHOST_DIR/ghost.json"
    local ghost_workflow_id="${STUB_GHOST_WORKFLOW_ID:-313}"
    local ghost_path="${STUB_GHOST_PATH:-oci-live-data-rollout.yml}"
    case "$endpoint" in
      "repos/$REPOSITORY/actions/workflows/$ghost_workflow_id")
        jq -c --arg state "${STUB_WORKFLOW_STATE:-disabled_manually}" \
          '.workflow + {state:$state}' "$ghost_fixture"
        return ;;
      "repos/$REPOSITORY/actions/workflows/$ghost_workflow_id/runs?"*)
        printf '{"total_count":0,"workflow_runs":[]}\n'
        return ;;
      "repos/$REPOSITORY/actions/runs/$STUB_GHOST_ID")
        jq -c '.run' "$ghost_fixture"; return ;;
      "repos/$REPOSITORY/actions/runs/$STUB_GHOST_ID/jobs?per_page=1")
        jq -c '.jobs' "$ghost_fixture"; return ;;
      "repos/$REPOSITORY/actions/runs/$STUB_GHOST_ID/pending_deployments")
        jq -c '.pending' "$ghost_fixture"; return ;;
      "repos/$REPOSITORY/actions/runs/$STUB_GHOST_ID/approvals")
        jq -c '.approvals' "$ghost_fixture"; return ;;
      "repos/$REPOSITORY/actions/runs/$STUB_GHOST_ID/artifacts?per_page=1")
        jq -c '.artifacts' "$ghost_fixture"; return ;;
      "repos/$REPOSITORY/compare/$STUB_GHOST_SHA...$SHA")
        jq -c '.compare' "$ghost_fixture"; return ;;
      "repos/$REPOSITORY/contents/.github/workflows/$ghost_path?ref=$STUB_GHOST_SHA")
        jq -c '.historical_workflow' "$ghost_fixture"; return ;;
    esac
  fi
  case "$endpoint" in
    "repos/$REPOSITORY/git/ref/heads/master")
      if [[ -n "${STUB_GHOST_DIR:-}" && " $* " != *" --jq "* ]]; then
        printf '{"object":{"sha":"%s"}}\n' "${STUB_MASTER_SHA:-$SHA}"
      else
        printf '%s\n' "${STUB_MASTER_SHA:-$SHA}"
      fi
      ;;
    "repos/$REPOSITORY/commits/$SHA/pulls")
      if [[
        "${STUB_HUMAN_PROMOTION:-false}" = "true" ||
          (
            "${STUB_PROMOTION_FAIL_WHEN_INFLIGHT:-false}" = "true" &&
              "$(authority_is_inflight && printf true || printf false)" = "true"
          )
      ]]; then
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
    "repos/$REPOSITORY/environments/"*"/variables/OCI_RUNTIME_MODE")
      printf '%s\n' "${STUB_OCI_RUNTIME_MODE:-k3s}"
      ;;
    "repos/$REPOSITORY/actions/runs/41"|\
    "repos/$REPOSITORY/actions/runs/42"|\
    "repos/$REPOSITORY/actions/runs/43"|\
    "repos/$REPOSITORY/actions/runs/44"|\
    "repos/$REPOSITORY/actions/runs/45"|\
    "repos/$REPOSITORY/actions/runs/47"|\
    "repos/$REPOSITORY/actions/runs/48"|\
    "repos/$REPOSITORY/actions/runs/49"|\
    "repos/$REPOSITORY/actions/runs/50"|\
    "repos/$REPOSITORY/actions/runs/51"|\
    "repos/$REPOSITORY/actions/runs/52"|\
    "repos/$REPOSITORY/actions/runs/53"|\
    "repos/$REPOSITORY/actions/runs/54"|\
    "repos/$REPOSITORY/actions/runs/41/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/42/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/43/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/44/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/45/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/47/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/48/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/49/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/50/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/51/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/52/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/53/attempts/1"|\
    "repos/$REPOSITORY/actions/runs/54/attempts/1")
      local binding_run_id
      binding_run_id="${endpoint#repos/"$REPOSITORY"/actions/runs/}"
      binding_run_id="${binding_run_id%%/*}"
      binding_run_json "$binding_run_id"
      ;;
    "repos/$REPOSITORY/actions/runs/41/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/42/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/43/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/44/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/45/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/47/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/48/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/49/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/50/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/51/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/52/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/53/artifacts?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/54/artifacts?per_page=100")
      local binding_artifact_run_id
      binding_artifact_run_id="${endpoint#repos/"$REPOSITORY"/actions/runs/}"
      binding_artifact_run_id="${binding_artifact_run_id%%/*}"
      binding_artifacts_json "$binding_artifact_run_id"
      ;;
    "repos/$REPOSITORY/actions/artifacts/9041/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9042/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9043/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9044/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9045/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9047/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9147/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9048/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9049/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9050/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9051/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9052/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9053/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9151/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9152/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9154/zip"|\
    "repos/$REPOSITORY/actions/artifacts/9251/zip")
      local binding_artifact_id
      binding_artifact_id="${endpoint%/zip}"
      binding_artifact_zip "${binding_artifact_id##*/}"
      ;;
    "repos/$REPOSITORY/actions/runs/51/attempts/1/jobs?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/52/attempts/1/jobs?per_page=100"|\
    "repos/$REPOSITORY/actions/runs/53/attempts/1/jobs?per_page=100")
      local binding_jobs_run_id
      binding_jobs_run_id="${endpoint#repos/"$REPOSITORY"/actions/runs/}"
      binding_jobs_run_id="${binding_jobs_run_id%%/*}"
      binding_jobs_json "$binding_jobs_run_id"
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
      if [[ "${STUB_PENDING_FAIL:-false}" = true ]]; then
        printf '[]\n'
        return 1
      fi
      if [[ -n "${STUB_PENDING_JSON:-}" ]]; then
        printf '%s\n' "$STUB_PENDING_JSON"
        return 0
      fi
      if [[ "${STUB_NO_PENDING:-false}" = "true" ]]; then
        printf '[]\n'
      else
        local pending_environment_id="${STUB_ENV_ID:-901}"
        if [[
          -n "${STUB_ENV_ID_WHEN_INFLIGHT:-}" &&
            "$(authority_is_inflight && printf true || printf false)" = "true"
        ]]; then
          pending_environment_id="$STUB_ENV_ID_WHEN_INFLIGHT"
        fi
        jq -cn \
          --arg environment "${STUB_PENDING_ENV:-$STUB_ENV}" \
          --argjson environment_id "$pending_environment_id" \
          --argjson can_approve "${STUB_CAN_APPROVE:-true}" \
          --argjson wait_timer "${STUB_WAIT_TIMER:-0}" \
          --argjson wait_started "${STUB_WAIT_STARTED_JSON:-null}" \
          '[{
            environment:{id:$environment_id,name:$environment},
            current_user_can_approve:$can_approve,
            wait_timer:$wait_timer,
            wait_timer_started_at:$wait_started
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
      if [[ -n "${STUB_JOBS_JSON:-}" ]]; then
        printf '%s\n' "$STUB_JOBS_JSON"
        return 0
      fi
      if [[ "${STUB_NO_WAITING:-false}" = "true" ]]; then
        printf '{"total_count":1,"jobs":[{"id":%s,"status":"completed"}]}\n' \
          "${STUB_JOB_ID:-1}"
      else
        printf '{"total_count":1,"jobs":[{"id":%s,"status":"waiting"}]}\n' \
          "${STUB_JOB_ID:-1}"
      fi
      ;;
    "repos/$REPOSITORY/actions/runs?status="*)
      if [[ -n "${STUB_GHOST_DIR:-}" && "$endpoint" == *"status=queued&"* ]]; then
        jq -c '{total_count:1,workflow_runs:[.run]}' "$STUB_GHOST_DIR/ghost.json"
        return
      fi
      if [[
        "${STUB_EXCLUSIVITY_FAIL_WHEN_INFLIGHT:-false}" = "true" &&
          "$(authority_is_inflight && printf true || printf false)" = "true"
      ]]; then
        printf '%s\n' '{'
        return
      fi
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
export -f git gh authority_is_inflight workflow_id_for approval_state_for
export -f binding_run_json binding_artifacts_json binding_artifact_zip
export -f binding_jobs_json
export ROOT_DIR SHA TARGET_SHA BLOB REPOSITORY post_count_file approval_history_file
export workflow_state_count_file
export STUB_PACKAGE_CANDIDATE_BUILD_ID
export authority_dir
mkdir "$tmp_dir/bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'gh "$@"' \
  >"$tmp_dir/bin/gh"
chmod 755 "$tmp_dir/bin/gh"
export PATH="$tmp_dir/bin:$PATH"

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
if policy["operation"] == "oci-k3s-disk-reclaim-cri":
    inputs["reclaim_image_ids"] = json.dumps(
        ["sha256:" + "a" * 64], separators=(",", ":")
    )
for name in policy["positiveIntegerInputs"]:
    inputs[name] = "42"
for name, value in {
    "build_run_id": "41",
    "ghcr_build_run_id": "41",
    "ghcr_package_validation_run_id": "42",
    "capacity_acquisition_run_id": "43",
    "infrastructure_run_id": "44",
    "diagnosis_run_id": "45",
    "disk_checkpoint_run_id": "47",
    "data_run_id": "48",
}.items():
    if name in inputs and inputs[name] != "":
        inputs[name] = value
if "disk_checkpoint_run_id" in inputs and "infrastructure_run_id" in inputs:
    inputs["infrastructure_run_id"] = "47"
if "prerequisite_run_id" in inputs:
    if policy["operation"] == "oci-live-data-apply-backfills":
        inputs["prerequisite_run_id"] = "49"
    elif policy["operation"] == "oci-live-data-apply-slip-index":
        inputs["prerequisite_run_id"] = "50"
    elif policy["fixedInputs"].get("phase") == "apply-slip-index":
        inputs["prerequisite_run_id"] = "48"
if "failed_deploy_run_id" in inputs and inputs["failed_deploy_run_id"] != "0":
    inputs["failed_deploy_run_id"] = (
        "52" if policy["operation"].endswith("-released") else "51"
    )
if "failed_activation_run_id" in inputs and inputs["failed_activation_run_id"] != "0":
    inputs["failed_activation_run_id"] = "53"
for name in policy["zeroOrPositiveIntegerInputs"]:
    inputs[name] = "0"
if (
    inputs.get("baseline_recovery_run_id") == "0"
    and "baseline_recovery_source_sha" in inputs
):
    inputs["baseline_recovery_source_sha"] = "none"
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
  local verified_summary
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
  verified_summary="$(
    "$HELPER" verify \
      --authority-dir "$authority_dir" \
      --repo-root "$ROOT_DIR" \
      --run-id "$run_id" \
      --policy-json "$policy_json" \
      --repository "$REPOSITORY" \
      --current-master "$SHA" \
      --workflow-id "$workflow_id" \
      --workflow-blob-sha "$BLOB"
  )"
  jq -e \
    --arg environment "$environment" \
    --slurpfile request "$request" \
    '.environment == $environment and .inputs == $request[0].inputs' \
    <<<"$verified_summary" >/dev/null
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$operation" "$run_id" "$workflow" "$workflow_id" "$title" "$environment" \
    >>"$records_file"
}

load_record_stub() {
  local operation="$1"
  local row runtime_mode
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
  unset STUB_EXCLUSIVITY_FAIL_WHEN_INFLIGHT
  unset STUB_PROMOTION_FAIL_WHEN_INFLIGHT
  unset STUB_ENV_ID_WHEN_INFLIGHT
  unset STUB_WAIT_TIMER STUB_WAIT_STARTED_JSON STUB_STATUS_FAIL_WHEN_INFLIGHT
  unset STUB_PENDING_FAIL STUB_PENDING_JSON STUB_JOBS_JSON
  unset STUB_OCI_RUNTIME_MODE
  unset STUB_PACKAGE_CREATED_AT
  unset STUB_PACKAGE_CANDIDATE_BUILD_ID
  unset STUB_DISK_DIAGNOSIS_SCHEMA
  unset STUB_ANCESTOR_FAIL
  unset STUB_PROFILE_ARTIFACT_MUTATION
  STUB_BINDING_SHA="$SHA"
  if [[ -f "$tmp_dir/request-$STUB_RUN_ID.json" ]]; then
    STUB_BINDING_SHA="$(jq -er '.subjectSha // .controlSha' "$tmp_dir/request-$STUB_RUN_ID.json")"
    STUB_BASELINE_RECOVERY_RUN_ID="$(
      jq -er '.inputs.baseline_recovery_run_id // "0"' \
        "$tmp_dir/request-$STUB_RUN_ID.json"
    )"
    STUB_BASELINE_RECOVERY_SOURCE_SHA="$(
      jq -er '.inputs.baseline_recovery_source_sha // "none"' \
        "$tmp_dir/request-$STUB_RUN_ID.json"
    )"
  else
    STUB_BASELINE_RECOVERY_RUN_ID=0
    STUB_BASELINE_RECOVERY_SOURCE_SHA=none
  fi
  export STUB_BINDING_SHA
  export STUB_BASELINE_RECOVERY_RUN_ID STUB_BASELINE_RECOVERY_SOURCE_SHA
  unset STUB_UPSTREAM_RUN_ID STUB_UPSTREAM_WORKFLOW STUB_UPSTREAM_WORKFLOW_ID
  unset STUB_UPSTREAM_TITLE STUB_UPSTREAM_EVENT STUB_UPSTREAM_CONCLUSION
  runtime_mode="$(
    "$POLICY" get "$operation" | jq -r '.fixedInputs.runtime_mode // ""'
  )"
  if [[ -n "$runtime_mode" ]]; then
    STUB_OCI_RUNTIME_MODE="$runtime_mode"
    export STUB_OCI_RUNTIME_MODE
  elif jq -e '.inputs.disk_checkpoint_run_id? != null' \
    "$tmp_dir/request-$STUB_RUN_ID.json" >/dev/null 2>&1; then
    STUB_OCI_RUNTIME_MODE=oke
    export STUB_OCI_RUNTIME_MODE
  fi
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

assert_profile_artifact_rejected() {
  local operation="$1"
  local mutation="$2"
  load_record_stub "$operation"
  if STUB_PROFILE_ARTIFACT_MUTATION="$mutation" \
    run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
    echo "approver accepted fixed-profile artifact mutation: $mutation" >&2
    exit 1
  fi
  jq -e '.state == "issued" and .inflightApproval == null' \
    "$authority_dir/$STUB_RUN_ID.json" >/dev/null
}

for mutation in \
  metadata-only malformed-zip missing-zip-content bad-checksum bad-capture-run; do
  assert_profile_artifact_rejected oci-live-data-resume-deploy "$mutation"
done
for mutation in \
  v6-source_sha \
  v6-build_run_id \
  v6-infrastructure_run_id \
  v6-checkpoint_source_sha \
  v6-disk_checkpoint_run_id \
  v6-disk_checkpoint_sha256 \
  v6-disk_checkpoint_disposition \
  v6-baseline_sha256 \
  v6-recovery_tuple \
  v6-workflow_run_id \
  v6-phase; do
  assert_profile_artifact_rejected oci-live-data-resume-deploy "$mutation"
done
for mutation in \
  activation-source_sha \
  activation-build_run_id \
  activation-infrastructure_run_id \
  activation-deployment_run_id \
  activation-checkpoint_source_sha \
  activation-disk_checkpoint_run_id \
  activation-disk_checkpoint_sha256 \
  activation-disk_checkpoint_disposition; do
  assert_profile_artifact_rejected oci-live-data-resume-activation "$mutation"
done
echo "copilot_cli_profile_artifact_rejection_tests=PASS"

load_record_stub oci-k3s-disk-diagnose
[[ "$STUB_BINDING_SHA" == "$TARGET_SHA" && "$STUB_BINDING_SHA" != "$SHA" ]]
if STUB_ANCESTOR_FAIL=true COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "non-ancestor diagnostic baseline unexpectedly authorized" >&2
  exit 1
fi
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
if STUB_MASTER_SHA="$TARGET_SHA" COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "stale diagnostic control unexpectedly authorized" >&2
  exit 1
fi
grep -qF "exact current master" "$error_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null

load_record_stub oci-k3s-disk-reclaim-cri
if STUB_DISK_DIAGNOSIS_SCHEMA=k3s-node-disk-diagnosis.v1 \
  COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "legacy diagnosis schema unexpectedly authorized a current reclaim" >&2
  exit 1
fi
grep -qF "schemaVersion" "$error_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null

load_record_stub oci-infrastructure-finalize-k3s
if STUB_OCI_RUNTIME_MODE=k3s \
  STUB_PACKAGE_CREATED_AT=2025-12-31T23:59:00Z \
  run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "package validation predating its build unexpectedly passed" >&2
  exit 1
fi
grep -qF "began before ghcr_build_run_id completed" "$error_file"
if STUB_OCI_RUNTIME_MODE=k3s \
  STUB_PACKAGE_CANDIDATE_BUILD_ID=999 \
  run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "package validation for a different build unexpectedly passed" >&2
  exit 1
fi
grep -qF "candidate_build_run_id" "$error_file"
STUB_OCI_RUNTIME_MODE=k3s COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file"
grep -qF "status=APPROVED" "$output_file"
jq -e '.state == "consumed"' "$authority_dir/$STUB_RUN_ID.json" >/dev/null

load_record_stub oci-infrastructure-prepare-oke
if STUB_OCI_RUNTIME_MODE=k3s COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "prepare-mode drift unexpectedly passed approval" >&2
  exit 1
fi
grep -qF "authoritative runtime mode changed" "$error_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null

load_record_stub oci-infrastructure-finalize-oke
STUB_OCI_RUNTIME_MODE=oke COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file"
grep -qF "status=APPROVED" "$output_file"
jq -e '.state == "consumed"' "$authority_dir/$STUB_RUN_ID.json" >/dev/null

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
post_count_before=0
[[ -f "$post_count_file" ]] && post_count_before="$(cat "$post_count_file")"
if STUB_PROMOTION_FAIL_WHEN_INFLIGHT=true COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "post-claim promotion failure unexpectedly approved GitHub" >&2
  exit 1
fi
grep -qF "not bound to exactly one CLI-managed dev promotion" "$error_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
observed_post_count=0
[[ -f "$post_count_file" ]] && observed_post_count="$(cat "$post_count_file")"
[[ "$observed_post_count" = "$post_count_before" ]]

load_record_stub production-deploy
post_count_before=0
[[ -f "$post_count_file" ]] && post_count_before="$(cat "$post_count_file")"
if STUB_EXCLUSIVITY_FAIL_WHEN_INFLIGHT=true COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "post-claim exclusivity failure unexpectedly approved GitHub" >&2
  exit 1
fi
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
observed_post_count=0
[[ -f "$post_count_file" ]] && observed_post_count="$(cat "$post_count_file")"
[[ "$observed_post_count" = "$post_count_before" ]]

load_record_stub oci-production-deploy
post_count_before=0
[[ -f "$post_count_file" ]] && post_count_before="$(cat "$post_count_file")"
if STUB_ENV_ID=901 STUB_ENV_ID_WHEN_INFLIGHT=902 \
  COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "changed post-claim gate unexpectedly approved GitHub" >&2
  exit 1
fi
grep -qF "pending environment changed after approval authority claim" "$error_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
observed_post_count=0
[[ -f "$post_count_file" ]] && observed_post_count="$(cat "$post_count_file")"
[[ "$observed_post_count" = "$post_count_before" ]]

load_record_stub production-deploy
if STUB_DIRTY_CHECKOUT=true \
  run_approver "$STUB_RUN_ID" >"$output_file" 2>"$error_file"; then
  echo "untracked approval checkout unexpectedly passed" >&2
  exit 1
fi
grep -qF "approval checkout is not clean" "$error_file"

load_record_stub production-deploy
post_count_before="$(cat "$post_count_file")"
if STUB_STATUS_FAIL_WHEN_INFLIGHT=true COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "post-claim Git status failure unexpectedly approved GitHub" >&2
  exit 1
fi
grep -qF "status=BLOCK classification=technical reason=local-context" "$error_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
[[ "$(cat "$post_count_file")" = "$post_count_before" ]]

# A review comment and can_approve=false cannot stand in for an exact receipt.
printf '%s\t901\tproduction-deploy\n' "$STUB_RUN_ID" >>"$approval_history_file"
if STUB_CAN_APPROVE=false COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "unreceipted non-approvable gate unexpectedly passed" >&2
  exit 1
fi
grep -qF "status=BLOCK classification=technical reason=unproven-approved-wait" "$error_file"
! grep -Eq 'status=(WAIT|ELIGIBLE|APPROVED)' "$output_file"
jq -e '.state == "issued" and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
[[ "$(cat "$post_count_file")" = "$post_count_before" ]]

load_record_stub oci-production-deploy
wait_started_json="$(python3 -c '
import datetime as dt, json
now = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=5)
print(json.dumps(now.astimezone(dt.timezone(dt.timedelta(hours=3))).isoformat()))
')"
# A newly eligible gate is approved normally even while a valid timer runs.
STUB_ENV_ID=901 STUB_WAIT_TIMER=30 STUB_WAIT_STARTED_JSON="$wait_started_json" \
  COPILOT_CLI_AUTO_APPROVE=true \
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

# The same receipted job may remain waiting on a timer or on GitHub. Neither
# observation may repeat the POST or mutate the private authority record.
receipt_before="$(cat "$authority_dir/$STUB_RUN_ID.json")"
post_count_before="$(cat "$post_count_file")"
for wait_kind in timer provider expired-timer; do
  timer=0
  started=null
  expected_reason=approved-provider
  if [[ "$wait_kind" = timer ]]; then
    timer=30
    started="$wait_started_json"
    expected_reason=approved-timer
  elif [[ "$wait_kind" = expired-timer ]]; then
    timer=1
    started='"2000-01-01T00:00:00Z"'
  fi
  wait_status=0
  STUB_ENV_ID=901 STUB_JOB_ID=2 STUB_CAN_APPROVE=false \
    STUB_WAIT_TIMER="$timer" STUB_WAIT_STARTED_JSON="$started" \
    COPILOT_CLI_AUTO_APPROVE=true \
    run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file" ||
    wait_status=$?
  [[ "$wait_status" = 3 ]]
  grep -qF "status=WAIT classification=provider-bound reason=$expected_reason" "$output_file"
  grep -qF "recheck_after_seconds=60 next_action=observe-exact-run" "$output_file"
  ! grep -Eq 'status=(ELIGIBLE|APPROVED)' "$output_file"
  [[ "$(cat "$post_count_file")" = "$post_count_before" ]]
  [[ "$(cat "$authority_dir/$STUB_RUN_ID.json")" = "$receipt_before" ]]
done

for invalid_timer in -1 0.5 true '"30"' 43201 null; do
  if STUB_ENV_ID=901 STUB_JOB_ID=2 STUB_CAN_APPROVE=false \
    STUB_WAIT_TIMER="$invalid_timer" STUB_WAIT_STARTED_JSON="$wait_started_json" \
    COPILOT_CLI_AUTO_APPROVE=true \
    run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
    echo "invalid wait timer unexpectedly passed: $invalid_timer" >&2
    exit 1
  fi
  grep -qF "status=BLOCK classification=technical reason=pending-gate" "$error_file"
  ! grep -Eq 'status=(WAIT|ELIGIBLE|APPROVED)' "$output_file"
done
for invalid_start in null '"2026-01-01T00:00:00"' '"2026-13-01T00:00:00Z"' \
  '"2999-01-01T00:00:00Z"' '"2026-01-01T00:00:00-00:00"' \
  '"2000-01-01T00:00:00+00:99"' true; do
  if STUB_ENV_ID=901 STUB_JOB_ID=2 STUB_CAN_APPROVE=false \
    STUB_WAIT_TIMER=30 STUB_WAIT_STARTED_JSON="$invalid_start" \
    COPILOT_CLI_AUTO_APPROVE=true \
    run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
    echo "invalid wait timestamp unexpectedly passed: $invalid_start" >&2
    exit 1
  fi
  grep -qF "status=BLOCK classification=technical reason=pending-gate" "$error_file"
  ! grep -Eq 'status=(WAIT|ELIGIBLE|APPROVED)' "$output_file"
done
for invalid_jobs in \
  '{"total_count":true,"jobs":[{"id":2,"status":"waiting"}]}' \
  '{"total_count":2,"jobs":[{"id":2,"status":"waiting"}]}' \
  '{"total_count":2,"jobs":[{"id":2,"status":"waiting"},{"id":2,"status":"waiting"}]}' \
  '{"total_count":1,"jobs":[{"id":2,"run_id":999,"status":"waiting"}]}' \
  '{"total_count":1,"jobs":[{"id":true,"status":"waiting"}]}' \
  '{'; do
  if STUB_ENV_ID=901 STUB_CAN_APPROVE=false STUB_JOBS_JSON="$invalid_jobs" \
    run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
    echo "incomplete or mismatched waiting-job proof unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "status=BLOCK classification=technical reason=pending-gate" "$error_file"
  ! grep -Eq 'status=(WAIT|ELIGIBLE|APPROVED)' "$output_file"
done
for missing_timer_field in wait_timer wait_timer_started_at; do
  incomplete_pending="$(jq -cn --arg field "$missing_timer_field" '[
    {environment:{id:901,name:"oci-production"}, current_user_can_approve:false,
     wait_timer:0, wait_timer_started_at:null} | del(.[$field])
  ]')"
  if STUB_JOB_ID=2 STUB_PENDING_JSON="$incomplete_pending" \
    run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
    echo "missing wait timer field unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "status=BLOCK classification=technical reason=pending-gate" "$error_file"
  ! grep -Eq 'status=(WAIT|ELIGIBLE|APPROVED)' "$output_file"
done
if STUB_PENDING_FAIL=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "failed pending-deployment transport unexpectedly passed" >&2
  exit 1
fi
grep -qF "reason=pending-gate unable to read pending deployments" "$error_file"
! grep -Eq 'status=(WAIT|ELIGIBLE|APPROVED)' "$output_file"
for invalid_capability in null '"false"' 0; do
  if STUB_ENV_ID=901 STUB_JOB_ID=2 STUB_CAN_APPROVE="$invalid_capability" \
    run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
    echo "unknown approval capability unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "approval capability is unknown" "$error_file"
  ! grep -Eq 'status=(WAIT|ELIGIBLE|APPROVED)' "$output_file"
done
for different_gate in job environment; do
  job_id=2
  env_id=901
  [[ "$different_gate" != job ]] || job_id=3
  [[ "$different_gate" != environment ]] || env_id=902
  if STUB_ENV_ID="$env_id" STUB_JOB_ID="$job_id" STUB_CAN_APPROVE=false \
    run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
    echo "a different waiting gate reused an approval receipt" >&2
    exit 1
  fi
  grep -qF "reason=unproven-approved-wait" "$error_file"
  ! grep -Eq 'status=(WAIT|ELIGIBLE|APPROVED)' "$output_file"
done
[[ "$(cat "$post_count_file")" = "$post_count_before" ]]
[[ "$(cat "$authority_dir/$STUB_RUN_ID.json")" = "$receipt_before" ]]
echo "copilot_cli_approved_wait_tests=PASS"

load_record_stub production-rollback
if STUB_ENV_ID=903 STUB_POST_FAIL=true COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "ambiguous GitHub approval unexpectedly passed" >&2
  exit 1
fi
grep -qF "authority remains inflight" "$error_file"
jq -e '.state == "inflight"' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
if STUB_ENV_ID=903 STUB_CAN_APPROVE=false COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --reconcile >"$output_file" 2>"$error_file"; then
  echo "unproven non-approvable inflight gate unexpectedly reconciled" >&2
  exit 1
fi
grep -qF "approval history has not advanced; authority stays inflight" "$error_file"
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

# An accepted but ambiguous POST stays inflight until the existing exact
# canonical review-history proof advances, even when a timer makes the same
# still-materialized gate non-approvable. Reconciliation never repeats POST.
post_count_before="$(cat "$post_count_file")"
if STUB_ENV_ID=904 STUB_POST_FAIL=true STUB_POST_ACCEPTED_AMBIGUOUS=true \
  COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "ambiguous timer-bound approval unexpectedly passed" >&2
  exit 1
fi
jq -e '.state == "inflight"' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
STUB_ENV_ID=904 STUB_CAN_APPROVE=false STUB_WAIT_TIMER=30 \
  STUB_WAIT_STARTED_JSON="$wait_started_json" COPILOT_CLI_AUTO_APPROVE=true \
  run_approver "$STUB_RUN_ID" --reconcile >"$output_file"
grep -qF "status=RECONCILED_CONSUMED" "$output_file"
jq -e '.state == "consumed" and (.approvals | length) == 1 and .inflightApproval == null' \
  "$authority_dir/$STUB_RUN_ID.json" >/dev/null
[[ "$(cat "$post_count_file")" = "$((post_count_before + 1))" ]]

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

# Explicit v2 consumer evidence, isolated from the preceding ordinary v1 matrix.
load_record_stub oci-live-data-dry-run
STUB_RUN_ID=$((STUB_RUN_ID + 500000))
STUB_GHOST_ID=$((STUB_RUN_ID - 1))
STUB_GHOST_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
STUB_GHOST_DIR="$tmp_dir/prepared-consumer"
authority_dir="$STUB_GHOST_DIR/authority"
mkdir -m 700 "$STUB_GHOST_DIR"
export STUB_RUN_ID STUB_GHOST_ID STUB_GHOST_SHA STUB_GHOST_DIR authority_dir
prepared_request="$STUB_GHOST_DIR/request.json"
prepared_normalized="$STUB_GHOST_DIR/normalized.json"
prepared_inputs="$STUB_GHOST_DIR/inputs.json"
prepared_observation="$STUB_GHOST_DIR/observation.json"
prepared_policy="$("$POLICY" get "$STUB_OPERATION")"
make_request "$STUB_OPERATION" "$prepared_request"
PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT_DIR" "$STUB_GHOST_DIR" "$REPOSITORY" \
  "$SHA" "$STUB_GHOST_SHA" "$STUB_GHOST_ID" <<'PY'
import base64
import hashlib
import json
from pathlib import Path
import sys
root, directory, repository, master, old, run_id = sys.argv[1:]
path = ".github/workflows/oci-live-data-rollout.yml"
source = (Path(root) / path).read_bytes()
blob = hashlib.sha1(f"blob {len(source)}\0".encode() + source).hexdigest()
run_id = int(run_id)
evidence = {
    "run": {
        "id": run_id, "workflow_id": 313, "path": path, "head_sha": old,
        "head_branch": "master", "head_repository": {"id": 101, "full_name": repository},
        "repository": {"id": 101, "full_name": repository},
        "event": "workflow_dispatch", "run_attempt": 1, "status": "queued", "conclusion": None,
        "display_title": "oci-live-data-rollout", "created_at": "2000-01-01T00:00:00Z",
        "updated_at": "2000-01-01T00:00:00Z", "run_started_at": "2000-01-01T00:00:00Z",
        "html_url": f"https://github.com/{repository}/actions/runs/{run_id}",
        "url": f"https://api.github.com/repos/{repository}/actions/runs/{run_id}",
    },
    "workflow": {"id": 313, "path": path, "state": "disabled_manually"},
    "jobs": {"total_count": 0, "jobs": []}, "pending": [], "approvals": [],
    "artifacts": {"total_count": 0, "artifacts": []},
    "compare": {
        "status": "ahead", "ahead_by": 1, "behind_by": 0, "total_commits": 1,
        "base_commit": {"sha": old}, "merge_base_commit": {"sha": old}, "commits": [{"sha": master}],
    },
    "historical_workflow": {
        "path": path, "type": "file", "encoding": "base64", "sha": blob,
        "size": len(source), "content": base64.b64encode(source).decode(),
    },
}
output = Path(directory) / "ghost.json"
output.write_text(json.dumps(evidence))
output.chmod(0o600)
PY
"$HELPER" validate-request \
  --request "$prepared_request" --policy-json "$prepared_policy" \
  --repository "$REPOSITORY" --current-master "$SHA" \
  --repo-root "$ROOT_DIR" --output "$prepared_normalized"
"$HELPER" write-inputs --normalized "$prepared_normalized" \
  --repo-root "$ROOT_DIR" --output "$prepared_inputs"
exclusivity="$ROOT_DIR/infra/azure/agents/production-run-exclusivity-stan.sh"
collect_consumer_observation() {
  local target="${1:-oci-live-data-rollout.yml}"
  REPO="$REPOSITORY" EXCLUDE_RUN_ID="" PROSPECTIVE_PROMOTION_PR="" \
    "$exclusivity" --observe-disabled-transition "$target" >"$prepared_observation"
  chmod 600 "$prepared_observation"
}
prepared_args=(
  --request "$prepared_request" --normalized "$prepared_normalized"
  --inputs-file "$prepared_inputs" --policy-json "$prepared_policy"
  --repository "$REPOSITORY" --current-master "$SHA" --workflow-id 313
  --workflow-blob-sha "$BLOB" --observation-json "$prepared_observation"
  --authority-dir "$authority_dir" --repo-root "$ROOT_DIR"
)
collect_consumer_observation
"$HELPER" prepare-disabled-ghosts "${prepared_args[@]}" --owner-pid "$$" >"$output_file"
post_count_before="$(cat "$post_count_file")"
if COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "prepared-only v2 intent unexpectedly approved" >&2
  exit 1
fi
grep -qF 'authority record does not exist' "$error_file"
[[ ! -e "$authority_dir/$STUB_RUN_ID.json" ]]
[[ "$(cat "$post_count_file")" = "$post_count_before" ]]

export STUB_WORKFLOW_STATE=active
collect_consumer_observation
if REPO="$REPOSITORY" EXCLUDE_RUN_ID="" PROSPECTIVE_PROMOTION_PR="" \
  "$exclusivity" >"$output_file" 2>"$error_file"; then
  echo "successful observation incorrectly granted ordinary exclusivity" >&2
  exit 1
fi
grep -qF 'active production run' "$error_file"
if COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "observation unexpectedly became approval authority" >&2
  exit 1
fi
[[ "$(cat "$post_count_file")" = "$post_count_before" ]]
post_a="$("$HELPER" verify-prepared "${prepared_args[@]}")"
collect_consumer_observation
dispatch_claim="$("$HELPER" dispatch-prepared "${prepared_args[@]}" \
  --expected-snapshot "$(jq -r '.snapshot' <<<"$post_a")" --owner-pid "$$")"
capture_path="$(jq -r '.capturePath' <<<"$dispatch_claim")"
capture_file="${capture_path##*/}"
transport_args=(
  --normalized "$prepared_normalized" --policy-json "$prepared_policy"
  --repository "$REPOSITORY" --current-master "$SHA" --workflow-id 313
  --workflow-blob-sha "$BLOB" --authority-dir "$authority_dir" --repo-root "$ROOT_DIR"
)
printf 'https://github.com/%s/actions/runs/%s\n' "$REPOSITORY" "$STUB_RUN_ID" >"$capture_path"
"$HELPER" record-dispatch-status "${transport_args[@]}" \
  --expected-version "$(jq -r '.version' <<<"$dispatch_claim")" \
  --expected-capture-file "$capture_file" --dispatch-status 0 >"$output_file"
"$HELPER" bind-intent "${transport_args[@]}" --expected-capture-file "$capture_file" >"$output_file"
consumer_run="$STUB_GHOST_DIR/current-run.json"
gh api "repos/$REPOSITORY/actions/runs/$STUB_RUN_ID" >"$consumer_run"
chmod 600 "$consumer_run"
"$HELPER" issue --authority-dir "$authority_dir" --repo-root "$ROOT_DIR" \
  --run-id "$STUB_RUN_ID" --run-json "$consumer_run" --policy-json "$prepared_policy" \
  --repository "$REPOSITORY" --current-master "$SHA" --workflow-id 313 --workflow-blob-sha "$BLOB"
if COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "v2-issued run approved before required workflow disablement" >&2
  exit 1
fi
grep -qF 'required approval state' "$error_file"
[[ "$(cat "$post_count_file")" = "$post_count_before" ]]
export STUB_WORKFLOW_STATE=disabled_manually
COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file"
grep -qF 'status=APPROVED' "$output_file"
[[ "$(cat "$post_count_file")" = "$((post_count_before + 1))" ]]
jq -e '.state == "consumed" and (.approvals | length) == 1' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
if COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "consumed v2 authority approved twice" >&2
  exit 1
fi
[[ "$(cat "$post_count_file")" = "$((post_count_before + 1))" ]]
collect_consumer_observation
if "$HELPER" prepare-disabled-ghosts "${prepared_args[@]}" --owner-pid "$$" >"$output_file" 2>"$error_file"; then
  echo "consumed v2 authority admitted a same-request replacement" >&2
  exit 1
fi
jq -e --argjson run_id "$STUB_RUN_ID" \
  '.schemaVersion == "betstan.copilot-cli-dispatch-intent.v2" and .state == "bound" and .runId == $run_id' \
  "$authority_dir"/request-*.json >/dev/null
echo "prepared_v2_approval_consumer_tests=PASS"

# The SAME v2 consumer lifecycle for the second frozen target (activation):
# a prepared observation grants no approval; the materialized issued
# activation authority still refuses while its workflow is active and
# succeeds exactly once after it is disabled; repeat approval and reprepare
# are both rejected.
load_record_stub oci-live-betting-activate
STUB_RUN_ID=$((STUB_RUN_ID + 500000))
STUB_GHOST_ID=$((STUB_RUN_ID - 1))
STUB_GHOST_SHA=cccccccccccccccccccccccccccccccccccccccc
STUB_GHOST_DIR="$tmp_dir/prepared-consumer-activation"
authority_dir="$STUB_GHOST_DIR/authority"
mkdir -m 700 "$STUB_GHOST_DIR"
export STUB_RUN_ID STUB_GHOST_ID STUB_GHOST_SHA STUB_GHOST_DIR authority_dir
export STUB_GHOST_WORKFLOW_ID=307 STUB_GHOST_PATH=oci-live-betting-activate.yml
prepared_request="$STUB_GHOST_DIR/request.json"
prepared_normalized="$STUB_GHOST_DIR/normalized.json"
prepared_inputs="$STUB_GHOST_DIR/inputs.json"
prepared_observation="$STUB_GHOST_DIR/observation.json"
prepared_policy="$("$POLICY" get "$STUB_OPERATION")"
make_request "$STUB_OPERATION" "$prepared_request"
PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT_DIR" "$STUB_GHOST_DIR" "$REPOSITORY" \
  "$SHA" "$STUB_GHOST_SHA" "$STUB_GHOST_ID" <<'PY'
import base64
import hashlib
import json
from pathlib import Path
import sys
root, directory, repository, master, old, run_id = sys.argv[1:]
path = ".github/workflows/oci-live-betting-activate.yml"
source = (Path(root) / path).read_bytes()
blob = hashlib.sha1(f"blob {len(source)}\0".encode() + source).hexdigest()
run_id = int(run_id)
evidence = {
    "run": {
        "id": run_id, "workflow_id": 307, "path": path, "head_sha": old,
        "head_branch": "master", "head_repository": {"id": 101, "full_name": repository},
        "repository": {"id": 101, "full_name": repository},
        "event": "workflow_dispatch", "run_attempt": 1, "status": "queued", "conclusion": None,
        "display_title": "oci-live-betting-activate", "created_at": "2000-01-01T00:00:00Z",
        "updated_at": "2000-01-01T00:00:00Z", "run_started_at": "2000-01-01T00:00:00Z",
        "html_url": f"https://github.com/{repository}/actions/runs/{run_id}",
        "url": f"https://api.github.com/repos/{repository}/actions/runs/{run_id}",
    },
    "workflow": {"id": 307, "path": path, "state": "disabled_manually"},
    "jobs": {"total_count": 0, "jobs": []}, "pending": [], "approvals": [],
    "artifacts": {"total_count": 0, "artifacts": []},
    "compare": {
        "status": "ahead", "ahead_by": 1, "behind_by": 0, "total_commits": 1,
        "base_commit": {"sha": old}, "merge_base_commit": {"sha": old}, "commits": [{"sha": master}],
    },
    "historical_workflow": {
        "path": path, "type": "file", "encoding": "base64", "sha": blob,
        "size": len(source), "content": base64.b64encode(source).decode(),
    },
}
output = Path(directory) / "ghost.json"
output.write_text(json.dumps(evidence))
output.chmod(0o600)
PY
"$HELPER" validate-request \
  --request "$prepared_request" --policy-json "$prepared_policy" \
  --repository "$REPOSITORY" --current-master "$SHA" \
  --repo-root "$ROOT_DIR" --output "$prepared_normalized"
"$HELPER" write-inputs --normalized "$prepared_normalized" \
  --repo-root "$ROOT_DIR" --output "$prepared_inputs"
prepared_args=(
  --request "$prepared_request" --normalized "$prepared_normalized"
  --inputs-file "$prepared_inputs" --policy-json "$prepared_policy"
  --repository "$REPOSITORY" --current-master "$SHA" --workflow-id 307
  --workflow-blob-sha "$BLOB" --observation-json "$prepared_observation"
  --authority-dir "$authority_dir" --repo-root "$ROOT_DIR"
)
collect_consumer_observation oci-live-betting-activate.yml
"$HELPER" prepare-disabled-ghosts "${prepared_args[@]}" --owner-pid "$$" >"$output_file"
post_count_before="$(cat "$post_count_file")"
if COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "prepared-only activation v2 intent unexpectedly approved" >&2
  exit 1
fi
grep -qF 'authority record does not exist' "$error_file"
[[ ! -e "$authority_dir/$STUB_RUN_ID.json" ]]
[[ "$(cat "$post_count_file")" = "$post_count_before" ]]

export STUB_WORKFLOW_STATE=active
collect_consumer_observation oci-live-betting-activate.yml
if COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "activation observation unexpectedly became approval authority" >&2
  exit 1
fi
[[ "$(cat "$post_count_file")" = "$post_count_before" ]]
post_a="$("$HELPER" verify-prepared "${prepared_args[@]}")"
collect_consumer_observation oci-live-betting-activate.yml
dispatch_claim="$("$HELPER" dispatch-prepared "${prepared_args[@]}" \
  --expected-snapshot "$(jq -r '.snapshot' <<<"$post_a")" --owner-pid "$$")"
capture_path="$(jq -r '.capturePath' <<<"$dispatch_claim")"
capture_file="${capture_path##*/}"
transport_args=(
  --normalized "$prepared_normalized" --policy-json "$prepared_policy"
  --repository "$REPOSITORY" --current-master "$SHA" --workflow-id 307
  --workflow-blob-sha "$BLOB" --authority-dir "$authority_dir" --repo-root "$ROOT_DIR"
)
printf 'https://github.com/%s/actions/runs/%s\n' "$REPOSITORY" "$STUB_RUN_ID" >"$capture_path"
"$HELPER" record-dispatch-status "${transport_args[@]}" \
  --expected-version "$(jq -r '.version' <<<"$dispatch_claim")" \
  --expected-capture-file "$capture_file" --dispatch-status 0 >"$output_file"
"$HELPER" bind-intent "${transport_args[@]}" --expected-capture-file "$capture_file" >"$output_file"
consumer_run="$STUB_GHOST_DIR/current-run.json"
gh api "repos/$REPOSITORY/actions/runs/$STUB_RUN_ID" >"$consumer_run"
chmod 600 "$consumer_run"
"$HELPER" issue --authority-dir "$authority_dir" --repo-root "$ROOT_DIR" \
  --run-id "$STUB_RUN_ID" --run-json "$consumer_run" --policy-json "$prepared_policy" \
  --repository "$REPOSITORY" --current-master "$SHA" --workflow-id 307 --workflow-blob-sha "$BLOB"
if COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "v2-issued activation run approved before required workflow disablement" >&2
  exit 1
fi
grep -qF 'required approval state' "$error_file"
[[ "$(cat "$post_count_file")" = "$post_count_before" ]]
export STUB_WORKFLOW_STATE=disabled_manually
COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file"
grep -qF 'status=APPROVED' "$output_file"
[[ "$(cat "$post_count_file")" = "$((post_count_before + 1))" ]]
jq -e '.state == "consumed" and (.approvals | length) == 1' "$authority_dir/$STUB_RUN_ID.json" >/dev/null
if COPILOT_CLI_AUTO_APPROVE=true run_approver "$STUB_RUN_ID" --approve >"$output_file" 2>"$error_file"; then
  echo "consumed activation v2 authority approved twice" >&2
  exit 1
fi
[[ "$(cat "$post_count_file")" = "$((post_count_before + 1))" ]]
collect_consumer_observation oci-live-betting-activate.yml
if "$HELPER" prepare-disabled-ghosts "${prepared_args[@]}" --owner-pid "$$" >"$output_file" 2>"$error_file"; then
  echo "consumed activation v2 authority admitted a same-request replacement" >&2
  exit 1
fi
jq -e --argjson run_id "$STUB_RUN_ID" \
  '.schemaVersion == "betstan.copilot-cli-dispatch-intent.v2" and .state == "bound" and .runId == $run_id' \
  "$authority_dir"/request-*.json >/dev/null
unset STUB_GHOST_WORKFLOW_ID STUB_GHOST_PATH
echo "prepared_v2_approval_consumer_activation_tests=PASS"
echo "copilot_cli_run_approval_tests=PASS"
