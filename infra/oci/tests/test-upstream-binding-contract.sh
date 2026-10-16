#!/usr/bin/env bash
set -euo pipefail

# Behavioural contract for protected upstream run bindings.
#
# A release chain once consumed a one-use protected authority and only then
# discovered that a required upstream run did not exist for that SHA, which
# permanently stranded that master commit. These cases exercise the shared
# validator against recorded GitHub API fixtures so every rejection is proven by
# behaviour rather than by grepping source text.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POLICY="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
VALIDATOR="$ROOT_DIR/infra/oci/scripts/upstream_run_binding_stan.py"
BINDING_MANIFEST="$ROOT_DIR/infra/oci/policy/upstream-run-bindings.json"
DISPATCHER="$ROOT_DIR/infra/azure/agents/copilot-cli-dispatch-stan.sh"
WORKFLOW="$ROOT_DIR/.github/workflows/oci-infrastructure.yml"
AUTHORITY_HELPER="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"

REPO="vasilyevstan/betstan"
SUBJECT_SHA="ac1008081411d64d96dd0221126090577ea72c6b"
CAPACITY_RUN=34122018082
WORKFLOW_ID=325567150

WORK="$ROOT_DIR/infra/oci/tests/.upstream-binding-work.$$"
mkdir -m 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/repository"

passed=0
fail() {
  printf 'upstream binding contract failed: %s\n' "$*" >&2
  exit 1
}
ok() {
  passed=$((passed + 1))
  printf 'PASS %s\n' "$1"
}

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" "$WORK" <<'PY'
import argparse, contextlib, importlib.util, io, json, sys, threading, time
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("upstream_pool", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
bindings = [
    dict(input=f"run_{i}", workflow="test.yml",
         titleTemplates={"workflow_dispatch": "test {subject_sha}"},
         artifactTemplate="test-{subject_sha}-{run_id}")
    for i in range(6)
]
args = argparse.Namespace(
    repository="example/repo", policy_json=json.dumps({"upstreamRunBindings": bindings}),
    manifest="", operation="", subject_sha="1" * 40,
    dispatch_inputs=json.dumps({b["input"]: str(i + 1) for i, b in enumerate(bindings)}),
    runtime_mode="", successor_run_id="", result_json="", baseline_dir="",
    held_history_file="",
)
lock = threading.Lock()
state = dict(active=0, peak=0, done=0)
def read(*values):
    with lock:
        state["active"] += 1
        state["peak"] = max(state["peak"], state["active"])
    try:
        time.sleep(.02)
        if values[1]["input"] == "run_0" and state.get("fail"):
            raise SystemExit("synthetic worker failure")
        return dict(artifactName="synthetic", createdAt="2026-10-01T00:00:00Z",
                    completedAt="2026-10-01T00:00:01Z")
    finally:
        with lock:
            state["active"] -= 1
            state["done"] += 1

with patch.object(m, "validate_binding", side_effect=read):
    with contextlib.redirect_stdout(io.StringIO()):
        m.command_validate_all(args)
    assert state["peak"] == 4 and state["done"] == 6
    state.update(done=0, fail=True)
    args.result_json = str(Path(sys.argv[2]) / "pool-result.json")
    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output):
            m.command_validate_all(args)
    except SystemExit:
        pass
    else:
        raise AssertionError("worker SystemExit passed")
    assert state["done"] == 6 and not output.getvalue()
    assert not Path(args.result_json).exists()
    state.update(done=0, fail=False)
    inputs = json.loads(args.dispatch_inputs)
    del inputs["run_5"]
    args.dispatch_inputs = json.dumps(inputs)
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            m.command_validate_all(args)
    except SystemExit:
        pass
    else:
        raise AssertionError("missing required input passed")
    assert state["done"] == 0
    inputs["run_5"] = "6"
    args.dispatch_inputs = json.dumps(inputs)
    bindings[1]["afterInput"] = "run_0"
    args.policy_json = json.dumps({"upstreamRunBindings": bindings})
    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            m.command_validate_all(args)
    except SystemExit:
        pass
    else:
        raise AssertionError("overlapping chronology passed")
    assert state["done"] == 6 and not output.getvalue()
    assert not Path(args.result_json).exists()
PY
ok "bounded binding pool joins SystemExit and defers all acceptance"

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" "$WORK" <<'PY'
import concurrent.futures, contextlib, hashlib, importlib.util, io, os, sys
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("upstream_bytes", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
workspace = Path(sys.argv[2]) / "private-bytes"
workspace.mkdir(mode=0o700)
owner = str(os.getppid())
(workspace / "owner").write_bytes(owner.encode())
(workspace / "owner").chmod(0o600)
descriptor = os.open(workspace, os.O_RDONLY)
os.dup2(descriptor, 9)
os.close(descriptor) if descriptor != 9 else None
payload = b"synthetic immutable bytes"
digest = hashlib.sha256(payload).hexdigest()
reads = []
def load():
    reads.append(1)
    return payload
def reject(action):
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            action()
    except SystemExit:
        return
    raise AssertionError("unsafe byte reuse passed")
with patch.dict(os.environ, {"BETSTAN_APPROVAL_BYTES_OWNER": owner}):
    context = {"repository": "example/repo", "policy": "first", "validator": "reviewed"}
    identity = ("artifact", "77", "1", 5, digest, "1" * 40, "2" * 40)
    first = m.ImmutableBindingBytes(context)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        values = list(pool.map(lambda _: first.read(identity, load, expected_sha256=digest), range(12)))
    assert values == [payload] * 12 and len(reads) == 1
    for _ in range(2):
        other_process = m.ImmutableBindingBytes(context)
        assert other_process.read(identity, load, expected_sha256=digest) == payload
    assert len(reads) == 1
    for changed in (
        {"repository": "other/repo"}, {"policy": "second"}, {"validator": "changed"},
    ):
        m.ImmutableBindingBytes({**context, **changed}).read(identity, load, expected_sha256=digest)
    for changed in (
        ("artifact", "78", "1", 5, digest, "1" * 40, "2" * 40),
        ("artifact", "77", "2", 5, digest, "1" * 40, "2" * 40),
        ("artifact", "77", "1", 6, digest, "1" * 40, "2" * 40),
        ("artifact", "77", "1", 5, digest, "3" * 40, "2" * 40),
        ("artifact", "77", "1", 5, digest, "1" * 40, "3" * 40),
    ):
        first.read(changed, load, expected_sha256=digest)
    assert len(reads) == 9
    stored = set(workspace.iterdir())
    with patch.object(m, "gh_api_bytes", side_effect=lambda _: load()):
        for _ in range(2):
            token = m.BYTE_CONTEXT.set(m.ImmutableBindingBytes(context))
            try:
                for _ in range(2):
                    assert m.artifact_archive("example/repo", {"id": 81}, "legacy fixture") == payload
            finally:
                m.BYTE_CONTEXT.reset(token)
    assert len(reads) == 11 and set(workspace.iterdir()) == stored
    original = next(path for path in workspace.glob("*.bin")
                    if path.read_bytes() == payload)
    saved = original.read_bytes()
    original.write_bytes(b"tampered")
    damaged = m.ImmutableBindingBytes(context)
    for known in (identity,):
        key = hashlib.sha256(__import__("json").dumps(
            [context, known], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        target = workspace / (key + ".bin")
        target.write_bytes(b"tampered")
        reject(lambda: damaged.read(known, load, expected_sha256=digest))
        target.unlink()
        target.symlink_to(workspace / "owner")
        reject(lambda: m.ImmutableBindingBytes(context).read(known, load, expected_sha256=digest))
        target.unlink()
        target.write_bytes(saved); target.chmod(0o600)
        target.chmod(0o644)
        reject(lambda: m.ImmutableBindingBytes(context).read(known, load, expected_sha256=digest))
    (workspace / "owner").write_bytes(b"1")
    reject(lambda: m.ImmutableBindingBytes(context))
os.close(9)
PY
ok "immutable bytes full-context isolation, single fetch, rehash and unsafe workspace rejection"

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" <<'PY'
import contextlib, copy, hashlib, importlib.util, io, sys, zipfile
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("upstream_complete_owned", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        for name, raw in files.items():
            bundle.writestr(zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0)), raw)
    return output.getvalue()
def reject(action):
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            action()
    except SystemExit:
        return
    raise AssertionError("unowned or incomplete current package passed")
files = {"proof": b"synthetic", "SHA256SUMS": b"synthetic package tested separately"}
baseline = {
    "oci-data-baseline-before/proof": b"original root",
    "oci-data-baseline-before/SHA256SUMS":
        f'{hashlib.sha256(b"original root").hexdigest()}  proof\n'.encode(),
}
zips = {1: archive(files), 2: archive(baseline)}
source = "1" * 40
inventory = [
    dict(id=i, name=f"oci-live-data-{kind}-77-1", expired=False,
         size_in_bytes=len(zips[i]), digest="sha256:" + hashlib.sha256(zips[i]).hexdigest(),
         workflow_run=dict(id=77, head_sha=source, head_branch="master"),
         created_at="1970-01-01T00:16:40Z", expires_at="1970-01-01T00:33:20Z")
    for i, kind in ((1, "rollout"), (2, "baselines"))
]
held = dict(created_at="1970-01-01T00:15:00Z", updated_at="1970-01-01T00:20:00Z")
def read():
    return m.complete_held_artifacts("example/repo", "77", source, held, files, "fixture")
def pages(_):
    return [dict(total_count=len(inventory), artifacts=inventory[:1]),
            dict(total_count=len(inventory), artifacts=inventory[1:])]
with patch.object(m, "gh_api_pages", side_effect=pages), \
        patch.object(m, "gh_api_bytes", side_effect=lambda path: zips[int(path.split("/")[-2])]), \
        patch.object(m.time, "time", return_value=1000):
    assert read()["proof"] == b"original root"
    saved = copy.deepcopy(inventory)
    for mutate in (
        lambda: inventory.pop(),
        lambda: inventory[1].update(id=1),
        lambda: inventory[0].update(expired=True),
        lambda: inventory[0].update(expires_at="1970-01-01T00:16:40Z"),
        lambda: inventory[0]["workflow_run"].update(id=78),
        lambda: inventory[0]["workflow_run"].update(head_sha="2" * 40),
        lambda: inventory[0]["workflow_run"].update(head_branch="dev"),
        lambda: inventory[0].pop("workflow_run"),
        lambda: inventory[0].pop("digest"),
        lambda: inventory[0].update(digest="sha256:" + "0" * 64),
        lambda: inventory[0].update(created_at="1970-01-01T00:20:01Z"),
    ):
        mutate(); reject(read); inventory[:] = copy.deepcopy(saved)
    with patch.object(m, "gh_api_pages", return_value=[dict(total_count=3, artifacts=inventory)]):
        reject(read)
    with patch.object(m, "gh_api_pages", return_value=[dict(artifacts=inventory)]):
        reject(read)
    zips[1] = archive({**files, "proof": b"tampered"})
    reject(read)
PY
ok "current owned ZIP digests, complete pagination, expiry equality and original rollback bytes"

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" <<'PY'
import contextlib, copy, datetime as dt, importlib.util, io, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("upstream_timing", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def reject(action):
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            action()
        except SystemExit:
            return
    raise AssertionError("unsafe or reset physical handoff budget passed")
base = 1800000000
deadline = base + 1800
tails = {
    "dispatch": 1080, "materialization": 900, "approval-1": 780,
    "approval-2": 700, "approval-3": 620, "native-validation": 540,
    "startup-snapshot": 360, "receiver-renewal": 120,
}
for boundary, tail in tails.items():
    equality = deadline - tail - 600
    assert m.handoff_remaining_guard(deadline, equality - 1, boundary) == tail
    reject(lambda: m.handoff_remaining_guard(deadline, equality, boundary))
    reject(lambda: m.handoff_remaining_guard(deadline, equality + 1, boundary))
    reject(lambda: m.handoff_remaining_guard(deadline, deadline + 1, boundary))
for changed in (dict(m.HANDOFF_STAGE_CEILINGS, packaging=0),
                dict(m.HANDOFF_STAGE_CEILINGS, approval=True),
                dict(m.HANDOFF_STAGE_CEILINGS, approval=1000)):
    with patch.object(m, "HANDOFF_STAGE_CEILINGS", changed):
        reject(lambda: m.handoff_remaining_guard(deadline, base, "dispatch"))
reject(lambda: m.handoff_remaining_guard(deadline, base, "caller-zero-tail"))
source, producer_run, receiver_run = "1" * 40, "77", "78"
stamp = lambda seconds: dt.datetime.fromtimestamp(base + seconds, dt.timezone.utc).isoformat()
producer = dict(updated_at=stamp(50))
workflow = dict(id=8, path=".github/workflows/oci-production-deploy.yml", state="active")
receiver = dict(
    id=78, workflow_id=8, path=workflow["path"], run_attempt=1, head_sha=source,
    event="workflow_dispatch", head_branch="master", head_repository={"full_name": "example/repo"},
    display_title=f"oci-deploy {source}", status="in_progress", conclusion=None, created_at=stamp(100))
job = dict(run_id=78, name="deploy", status="in_progress", started_at=stamp(150), steps=[
    dict(name="Validate exact SHA and trusted upstream runs", conclusion="success", completed_at=stamp(200)),
    dict(name="Verify transferred database lock and maintenance fence", started_at=stamp(250)),
])
physical = dict(run_id=77, name="rollout", status="completed", conclusion="success", steps=[])
package = dict(source_sha=source, workflow_run_id=producer_run)
def api(path):
    return copy.deepcopy(workflow if "/workflows/" in path else receiver)
with patch.object(m, "require_fixed_run", return_value=producer), \
        patch.object(m, "parse_live_v6_artifact", return_value=(package, None, {})), \
        patch.object(m, "parse_resume_authority", return_value={"schema_version": "live-betting-data-resume-v3"}), \
        patch.object(m, "current_held_source") as closure, \
        patch.object(m, "native_handoff_renewal", return_value=(deadline, 11)), \
        patch.object(m, "jobs_for_run", side_effect=lambda repo, run, label: [physical if run == producer_run else job]), \
        patch.object(m, "gh_api", side_effect=api):
    for boundary, now in (
        ("dispatch", 60), ("materialization", 160), ("approval-1", 200),
        ("approval-2", 260), ("approval-3", 320), ("native-validation", 330),
        ("startup-snapshot", 340), ("receiver-renewal", 350),
    ):
        expected_state = "active" if boundary in ("dispatch", "materialization") else "disabled_manually"
        workflow["state"] = expected_state
        with patch.object(m.time, "time", return_value=base + now):
            result = m.validate_receiver_handoff_timing(
                "example/repo", producer_run, source, boundary,
                "" if boundary == "dispatch" else receiver_run)
            assert result["deadline"] == deadline and result["generation"] == 11
            assert result["unfinished_seconds"] == tails[boundary]
            if boundary != "dispatch":
                for wrong_state in ("active", "disabled_manually", "disabled_inactivity"):
                    if wrong_state == expected_state:
                        continue
                    workflow["state"] = wrong_state
                    reject(lambda: m.validate_receiver_handoff_timing(
                        "example/repo", producer_run, source, boundary, receiver_run))
                workflow["state"] = expected_state
    with patch.object(m.time, "time", return_value=base + 330):
        reject(lambda: m.validate_receiver_handoff_timing(
            "example/repo", producer_run, source, "caller-zero-tail", receiver_run))
    with patch.object(m.time, "time", return_value=base + 60):
        for mutate in (
            lambda: producer.update(updated_at=stamp(-1)),
            lambda: producer.update(updated_at=stamp(121)),
        ):
            mutate()
            reject(lambda: m.validate_receiver_handoff_timing(
                "example/repo", producer_run, source, "dispatch"))
            producer["updated_at"] = stamp(50)
    for mutate in (
        lambda: receiver.update(run_attempt=2),
        lambda: receiver.update(head_sha="2" * 40),
        lambda: receiver.update(status="completed"),
        lambda: workflow.update(state="active"),
    ):
        saved_receiver, saved_workflow = copy.deepcopy(receiver), copy.deepcopy(workflow)
        mutate()
        with patch.object(m.time, "time", return_value=base + 200):
            reject(lambda: m.validate_receiver_handoff_timing(
                "example/repo", producer_run, source, "approval-1", receiver_run))
        receiver.clear(); receiver.update(saved_receiver)
        workflow.clear(); workflow.update(saved_workflow)
    with patch.object(m.time, "time", return_value=base + 371):
        reject(lambda: m.validate_receiver_handoff_timing(
            "example/repo", producer_run, source, "receiver-renewal", receiver_run))
    with patch.object(m.time, "time", side_effect=[base + 60, deadline]):
        reject(lambda: m.validate_receiver_handoff_timing(
            "example/repo", producer_run, source, "dispatch"))
    for legacy in (None, {"schema_version": "live-betting-data-resume-v2"}):
        closure.reset_mock()
        with patch.object(m, "parse_resume_authority", return_value=legacy), \
                patch.object(m.time, "time", return_value=deadline + 86400):
            assert m.validate_receiver_handoff_timing(
                "example/repo", producer_run, source, "dispatch") is None
            closure.assert_not_called()
    with patch.object(m, "parse_resume_authority", side_effect=SystemExit("malformed v3")):
        reject(lambda: m.validate_receiver_handoff_timing(
            "example/repo", producer_run, source, "dispatch"))
PY
ok "authentic new-capture budget shrinks at all boundaries, equality and renewal reject, legacy evidence clock unchanged"

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" "$WORK" <<'PY'
import contextlib, copy, datetime as dt, hashlib, importlib.util, io, json, os, shutil, subprocess, sys
from pathlib import Path
from unittest.mock import patch
original, work = map(Path, sys.argv[1:])
source = work / "authority-source"
module_path = source / "infra/oci/scripts/upstream_run_binding_stan.py"
module_path.parent.mkdir(parents=True)
shutil.copy2(original, module_path)
helper_path = source / "infra/azure/agents/copilot_cli_authority_stan.py"
helper_path.parent.mkdir(parents=True)
shutil.copy2(original.parents[2] / "azure/agents/copilot_cli_authority_stan.py", helper_path)
spec = importlib.util.spec_from_file_location("upstream_authority", module_path)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = m.provenance_read_authority()
directory = work / "private-held-authority"; directory.mkdir(mode=0o700)
repository, old, new = "example/repo", "1" * 40, "2" * 40
policy_path = original.parents[2] / "azure/agents/copilot-cli-protected-operation-policy-stan.sh"
policy_bytes = policy_path.read_text()
workflow = (original.parents[3] / ".github/workflows/oci-live-data-rollout.yml").read_text()
workflow_blob = hashlib.sha1(f"blob {len(workflow.encode())}\0".encode() + workflow.encode()).hexdigest()
policies = {operation: json.loads(subprocess.check_output(
    ["bash", str(policy_path), "get", operation], text=True))
    for operation in ("oci-live-data-resume-deploy", "oci-live-data-continue-held-handoff")}
common = dict(phase="apply-slip-index", build_run_id="21", infrastructure_run_id="22",
              checkpoint_source_sha=old, disk_checkpoint_run_id="23", prerequisite_run_id="24",
              resume_source_sha=old, failed_deploy_run_id="25",
              failed_activation_run_id="0", failed_activation_user_id="0",
              baseline_recovery_run_id="0", baseline_recovery_source_sha="none")
native = m.live_data_native_inputs(
    dict(common, approved_sha=old, confirmation="RESUME APPLIED LIVE DATA EXACT SHA"),
    policies["oci-live-data-resume-deploy"]["inputNames"])
dispatch = m.live_data_native_inputs(
    dict(common, approved_sha=new, held_handoff_run_id="77", held_handoff_source_sha=old,
         confirmation=m.HELD_HANDOFF_CONFIRMATION),
    policies["oci-live-data-continue-held-handoff"]["inputNames"])
def record(operation, run, sha, inputs, state):
    policy = policies[operation]
    normalized = a.validate_request_data(dict(
        schemaVersion=a.REQUEST_SCHEMA, repository=repository, operation=operation,
        controlSha=sha, subjectSha=sha, targetSha=None, inputs=inputs),
        policy, repository, sha)
    result = a.build_dispatch_record(
        normalized, policy, repository, 313, workflow_blob, run,
        f"https://github.com/{repository}/actions/runs/{run}")
    result["state"] = state
    if state == "consumed":
        created = a.utc_now() - dt.timedelta(seconds=2 * a.AUTHORITY_TTL_SECONDS)
        result.update(createdAt=a.utc_text(created),
                      expiresAt=a.utc_text(created + dt.timedelta(seconds=a.AUTHORITY_TTL_SECONDS)))
        result["approvals"] = [dict(
            runId=run, operation=operation, environmentId=901,
            gateKey="a" * 64, approvedAt=a.utc_text(created))]
    return result
producer = record("oci-live-data-resume-deploy", 77, old, native, "consumed")
successor_record = record("oci-live-data-continue-held-handoff", 78, new, dispatch, "issued")
def save(value):
    path = directory / f'{value["runId"]}.json'
    path.write_text(json.dumps(value)); path.chmod(0o600)
save(producer); save(successor_record)
def native_run(value, status, conclusion):
    return dict(id=value["runId"], workflow_id=313, path=".github/workflows/oci-live-data-rollout.yml",
                head_sha=value["controlSha"], head_branch="master", event="workflow_dispatch",
                head_repository={"full_name": repository}, run_attempt=1,
                display_title=value["displayTitle"], status=status, conclusion=conclusion)
held = native_run(producer, "completed", "success")
held["_held_native_inputs"] = native
held["created_at"] = "2026-10-07T08:00:00Z"
successor = native_run(successor_record, "waiting", None)
historical = record("oci-live-data-resume-deploy", 80, old, native, "issued")
historical.update(createdAt="2026-10-07T06:00:01Z", expiresAt="2026-10-07T06:01:01Z")
historical_run = dict(
    native_run(historical, "completed", "success"),
    html_url=historical["runUrl"], created_at="2026-10-07T06:00:00Z",
    run_started_at="2026-10-07T06:00:02Z", updated_at="2026-10-07T06:01:00Z",
)
historical_first = copy.deepcopy(historical_run)
historical_jobs = [{
    "id": 8001, "run_id": 80, "run_attempt": 1, "head_sha": old, "head_branch": "master",
    "name": "rollout", "status": "completed", "conclusion": "success",
    "created_at": "2026-10-07T06:00:03Z", "started_at": "2026-10-07T06:00:04Z",
    "completed_at": "2026-10-07T06:00:59Z",
    "steps": [{"name": "Complete historical operation", "status": "completed", "conclusion": "success",
               "started_at": "2026-10-07T06:00:05Z", "completed_at": "2026-10-07T06:00:58Z"}],
}]
historical_inventory = {"total_count": 1, "jobs": historical_jobs}
historical_pending = []
historical_drift = False
historical_reads = 0
review = dict(state="approved", comment="Copilot CLI exact-run approval: oci-live-data-resume-deploy",
              user={"id": 1, "login": "fixture-cli"}, environments=[{"id": 901, "name": "oci-migration"}])
def api(path):
    global historical_reads
    if "/actions/runs/80" in path:
        historical_reads += 1
        if path.endswith("/pending_deployments"):
            return copy.deepcopy(historical_pending)
        value = copy.deepcopy(historical_first if path.endswith("/attempts/1") else historical_run)
        if historical_drift and historical_reads > 3:
            value["updated_at"] = "2026-10-07T06:01:01Z"
        return value
    if path.endswith("/pending_deployments"): return []
    if path.endswith("/approvals"): return [copy.deepcopy(review)]
    assert path.endswith("/actions/runs/78"), path
    return copy.deepcopy(successor)
def pages(path):
    assert path == f"repos/{repository}/actions/runs/80/attempts/1/jobs?per_page=100", path
    return [copy.deepcopy(historical_inventory)]
def read():
    return m.held_handoff_authority(repository, held, new, dispatch, "78", "fixture fresh authority")
def reject():
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            read()
        except (SystemExit, OSError):
            return
    raise AssertionError("missing, stale or competing owned authority proved absence")
with patch.dict(os.environ, {"COPILOT_CLI_AUTHORITY_DIR": str(directory), "GITHUB_ACTIONS": "false"}), \
        patch.object(m, "held_source_bytes", side_effect=lambda repo, sha, path, label:
                     policy_bytes if path.endswith("policy-stan.sh") else workflow), \
        patch.object(m, "gh_api", side_effect=api), \
        patch.object(m, "gh_api_pages", side_effect=pages):
    read()
    for mutate in (
        lambda value: value.update(state="retired"),
        lambda value: value.update(subjectSha=old),
        lambda value: value.update(workflowBlobSha="f" * 40),
        lambda value: value.update(runAttempt=2),
        lambda value: value.update(version=0),
        lambda value: value.update(expiresAt=producer["expiresAt"]),
        lambda value: value["inputs"].update(prerequisite_run_id="99"),
    ):
        changed = copy.deepcopy(successor_record); mutate(changed); save(changed)
        reject(); save(successor_record)
    (directory / "77.json").unlink(); reject(); save(producer)
    (directory / "78.json").unlink(); reject(); save(successor_record)
    unconsumed = dict(producer, state="issued"); save(unconsumed); reject(); save(producer)
    other = record("oci-live-data-continue-held-handoff", 79, new, dispatch, "issued")
    save(other); reject(); (directory / "79.json").unlink()
    unknown = directory / "unexplained.json"; unknown.write_text("{}"); unknown.chmod(0o600)
    reject(); unknown.unlink()
    intent = directory / ("request-" + "b" * 64 + ".json")
    intent.write_text("{}"); intent.chmod(0o600)
    reject(); intent.unlink()
    saved = copy.deepcopy(review)
    for key, value in (("comment", "different owner"), ("state", "rejected"),
                       ("environments", [{"id": 902, "name": "wrong"}])):
        review[key] = value; reject(); review.clear(); review.update(copy.deepcopy(saved))
    successor["run_attempt"] = 2; reject(); successor["run_attempt"] = 1
    with patch.dict(os.environ, {"COPILOT_CLI_AUTHORITY_DIR": str(directory / "missing")}):
        reject()
    save(historical)
    before = {path.name: path.read_bytes() for path in directory.iterdir()}
    read()
    assert {path.name: path.read_bytes() for path in directory.iterdir()} == before
    for state in ("claimed", "inflight", "rejecting"):
        save(dict(historical, state=state)); reject(); save(historical)
    original_historical_run = copy.deepcopy(historical_run)
    for field, bad in (
        ("status", "in_progress"), ("conclusion", None), ("run_attempt", 2),
        ("head_sha", new), ("workflow_id", 314), ("display_title", "unowned"),
        ("html_url", "https://github.com/other/repo/actions/runs/80"),
        ("updated_at", held["created_at"]), ("updated_at", "2026-10-07T08:00:01Z"),
        ("run_started_at", None),
    ):
        historical_run[field] = bad; reject()
        historical_run.clear(); historical_run.update(copy.deepcopy(original_historical_run))
    historical_first["updated_at"] = "2026-10-07T06:01:01Z"; reject()
    historical_first["updated_at"] = historical_run["updated_at"]
    original_job = copy.deepcopy(historical_jobs[0])
    historical_jobs[0].pop("id"); reject(); historical_jobs[0]["id"] = original_job["id"]
    for field, bad in (
        ("id", 0), ("id", True), ("id", None),
        ("run_id", 81), ("run_attempt", 2), ("head_sha", new), ("head_branch", "dev"),
        ("status", "in_progress"), ("conclusion", None),
        ("created_at", None), ("completed_at", None), ("completed_at", held["created_at"]),
        ("started_at", None), ("started_at", "2026-10-07T06:01:01Z"),
        ("steps", {}), ("steps", None), ("steps", "unknown"), ("steps", [None]),
        ("steps", [dict(original_job["steps"][0], completed_at=held["created_at"])]),
        ("steps", [dict(original_job["steps"][0], started_at="2026-10-07T06:00:02Z")]),
        ("steps", [dict(original_job["steps"][0], completed_at=None)]),
        ("steps", [{"name": "still running", "status": "in_progress", "conclusion": None}]),
    ):
        historical_jobs[0][field] = bad; reject()
        historical_jobs[0].clear(); historical_jobs[0].update(copy.deepcopy(original_job))
    historical_jobs.append(copy.deepcopy(original_job)); historical_inventory["total_count"] = 2
    reject(); historical_jobs.pop(); historical_inventory["total_count"] = 1
    historical_inventory["total_count"] = 2; reject(); historical_inventory["total_count"] = 1
    historical_pending.append({"environment": {"name": "oci-migration"}}); reject(); historical_pending.clear()
    historical_reads = 0; historical_drift = True; reject(); historical_drift = False
    historical_jobs[0].update(conclusion="skipped", started_at=None, steps=[])
    read()
    historical_jobs[0].clear(); historical_jobs[0].update(copy.deepcopy(original_job))
    historical_jobs[0]["steps"] = [dict(original_job["steps"][0], conclusion="skipped",
                                      started_at=None, completed_at=None)]
    read()
    historical_jobs[0].clear(); historical_jobs[0].update(copy.deepcopy(original_job))
    intent = directory / ("request-" + "b" * 64 + ".json")
    intent.write_text("{}"); intent.chmod(0o600)
    reject(); intent.unlink()
    read()
    assert {path.name: path.read_bytes() for path in directory.iterdir()} == before
PY
ok "fresh private authority and immutable pre-producer issued history; reruns, partial jobs, pending gates, drift and unresolved owners reject without ledger mutation"

# Keep the frozen source and ancestry fixtures offline in depth-one checkouts.
historical_fixture="$ROOT_DIR/infra/oci/tests/fixtures/upstream-historical-source.pack"
[[ "$(sha256sum "$historical_fixture" | awk '{print $1}')" = \
  c117f905c92aedb4bf8b105889272cf9b149281908c911a7d1c58dfec53487fb ]] ||
  fail "historical source fixture checksum differs"
git init --quiet --initial-branch=upstream-fixture "$WORK/repository"
git -C "$WORK/repository" unpack-objects -q <"$historical_fixture"
printf '%s\n' \
  1bf86112ba2458161e6039091b1aa6289fdfce1d \
  daa5cffe56d008c948cc8654e903c4a48450c5a2 \
  >"$WORK/repository/.git/shallow"

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" <<'PY'
import contextlib
import importlib.util
import io
import sys
import zipfile

path = sys.argv[1]
spec = importlib.util.spec_from_file_location("upstream_binding", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        for name, raw in entries.items():
            bundle.writestr(name, raw)
    return output.getvalue()


module.gh_api_bytes = lambda _: archive({
    "rollback-readiness/failures.txt": b"",
    "rollback-readiness/status.txt": b"PASS\n",
})
files = module.artifact_files(
    "example/repo",
    {"id": 1},
    "partial recovery",
    allowed_empty_suffixes={"rollback-readiness/failures.txt"},
)
assert files["rollback-readiness/failures.txt"] == b""

for entries, allowed in (
    ({"rollback-readiness/failures.txt": b""}, frozenset()),
    (
        {
            "rollback-readiness/failures.txt": b"",
            "rollback-readiness/status.txt": b"",
        },
        {"rollback-readiness/failures.txt"},
    ),
):
    module.gh_api_bytes = lambda _, entries=entries: archive(entries)
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            module.artifact_files(
                "example/repo",
                {"id": 1},
                "partial recovery",
                allowed_empty_suffixes=allowed,
            )
    except SystemExit:
        pass
    else:
        raise AssertionError("unexpected empty artifact evidence passed")
PY
ok "partial-recovery empty failures scope"

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" "$ROOT_DIR" "$WORK/repository" <<'PY'
import contextlib, copy, datetime as dt, hashlib, importlib.util, io, json, re, subprocess, sys, zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("upstream_binding", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
source, prefix = "3" * 40, "repos/example/repo"
native = dict(approved_sha=source, build_run_id="21", infrastructure_run_id="22", data_run_id="23",
              checkpoint_source_sha="1" * 40, disk_checkpoint_run_id="24",
              baseline_recovery_run_id="0", baseline_recovery_source_sha="none",
              confirmation="DEPLOY OCI EXACT SHA")
workflow = Path(sys.argv[2]) / ".github/workflows/oci-production-deploy.yml"
raw = subprocess.check_output([
    "git", "-C", sys.argv[3], "cat-file", "blob",
    m.EXPIRED_HANDOFF_CLOSURE[".github/workflows/oci-production-deploy.yml"],
])
assert hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest() == m.EXPIRED_HANDOFF_CLOSURE[
    ".github/workflows/oci-production-deploy.yml"]
names = ["Set up job", *re.findall(r"(?m)^      - name: (.+)$",
         raw.decode().split("\n  public-validate:\n")[0]), "Post Checkout approved master commit", "Complete job"]
success = set(names[:17]) - {"Verify OKE identity", "Reconcile expired and authorize current runner IPv4",
                            "Configure kubectl from exact cluster OCID",
                            "Verify transferred database lock and maintenance fence"}
success.update({"Upload sanitized live readiness evidence", "Close ephemeral OCI Bastion access",
                "Remove isolated OCI client state", "Post Checkout approved master commit", "Complete job"})
steps = []
for index, name in enumerate(names):
    start = dt.datetime(2026, 1, 1, 1, 40, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=index * 3)
    steps.append(dict(name=name, number=index + 1 if index < 38 else index + 38,
        status="completed", conclusion="failure" if index == 16 else "success" if name in success else "skipped",
        started_at=start.isoformat().replace("+00:00", "Z"),
        completed_at=(start + dt.timedelta(seconds=2)).isoformat().replace("+00:00", "Z")))
metadata = dict(id=77, workflow_id=101, path=".github/workflows/oci-production-deploy.yml",
    head_sha=source, head_branch="master", event="workflow_dispatch", run_attempt=1,
    head_repository={"full_name": "example/repo"}, status="completed", conclusion="failure",
    display_title=f"oci-deploy {source}", created_at="2026-01-01T01:39:00Z", updated_at="2026-01-01T01:44:00Z")
jobs = [
    dict(id=7700, run_id=77, name="deploy", status="completed", conclusion="failure",
         started_at="2026-01-01T01:40:00Z", completed_at="2026-01-01T01:43:00Z", steps=steps),
    dict(id=7701, run_id=77, name="public-validate", status="completed", conclusion="skipped",
         started_at="2026-01-01T01:43:00Z", completed_at="2026-01-01T01:43:00Z", steps=[]),
]
records = {
    f"{prefix}/actions/workflows/oci-production-deploy.yml": {"id": 101},
    f"{prefix}/actions/runs/77": metadata,
    f"{prefix}/actions/runs/77/attempts/1": copy.deepcopy(metadata),
    f"{prefix}/actions/runs/77/attempts/1/jobs?per_page=100": {"total_count": 2, "jobs": jobs},
    f"{prefix}/actions/runs/77/artifacts?per_page=100": {"total_count": 0, "artifacts": []},
    f"{prefix}/git/commits/{source}": {"sha": source, "tree": {"sha": m.EXPIRED_HANDOFF_TREE}},
}
records.update({f"{prefix}/contents/{path}?ref={source}": {"sha": blob}
                for path, blob in m.EXPIRED_HANDOFF_CLOSURE.items()})
def timestamp(step):
    return (dt.datetime.fromisoformat(step["started_at"].replace("Z", "+00:00"))
            + dt.timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
def log(values=native, output=None, name="0_deploy.txt"):
    lines = ["##[group]Run set -euo pipefail", "env:"]
    lines += [f"  {'SOURCE_SHA' if key == 'approved_sha' else key.upper()}: {value}" for key, value in values.items()]
    lines += ["  DISPATCH_INPUTS: " + json.dumps(values), "##[endgroup]"]
    text = "".join(f"{timestamp(steps[9])} {line}\n" for line in lines)
    execution = output if output is not None else [
        "##[group]Run set -euo pipefail",
        "echo live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true",
        "##[endgroup]",
        "live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true",
        "shared_mongo_lock=verify status=FAIL reason=active database operation lock has expired",
        "##[error]Process completed with exit code 1.",
    ]
    text += "".join(f"{timestamp(steps[16])} {line}\n" for line in execution)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle: bundle.writestr(name, text)
    return output.getvalue()
raw_log = log()
def transport(argv, **kwargs):
    assert argv[:2] == ["gh", "api"]
    endpoint = argv[2]
    if endpoint == f"{prefix}/actions/runs/77/attempts/1/logs":
        result = raw_log
    else:
        assert endpoint in records, endpoint
        value = records[endpoint]
        result = json.dumps([value] if "--slurp" in argv else value).encode()
    return subprocess.CompletedProcess(argv, 0, result, b"")
def proof(runtime="k3s"):
    with patch.object(m.subprocess, "run", side_effect=transport):
        return m.expired_handoff_native_inputs("example/repo", "77", runtime, "frozen native fixture")
def reject():
    with contextlib.redirect_stderr(io.StringIO()):
        try: proof()
        except SystemExit: return
    raise AssertionError("unqualified native expired receiver passed")
assert proof()[0] == native
original = copy.deepcopy(records)
mutations = (
    lambda: records[f"{prefix}/git/commits/{source}"]["tree"].update(sha="9" * 40),
    lambda: records[f"{prefix}/contents/infra/oci/scripts/live-data-maintenance-stan.sh?ref={source}"].update(sha="9" * 40),
    lambda: records[f"{prefix}/actions/runs/77"].update(run_attempt=2),
    lambda: records[f"{prefix}/actions/runs/77"].update(head_sha="9" * 40),
    lambda: records[f"{prefix}/actions/runs/77"].update(display_title="different"),
    lambda: records[f"{prefix}/actions/runs/77/attempts/1/jobs?per_page=100"]["jobs"][0]["steps"][17].update(conclusion="success"),
    lambda: records[f"{prefix}/actions/runs/77/attempts/1/jobs?per_page=100"]["jobs"][0]["steps"][9].update(conclusion="failure"),
    lambda: records[f"{prefix}/actions/runs/77/attempts/1/jobs?per_page=100"]["jobs"][0]["steps"][16].update(started_at="2026-01-01T01:39:00Z"),
    lambda: records[f"{prefix}/actions/runs/77/attempts/1/jobs?per_page=100"]["jobs"].append(dict(jobs[1], id=7799, name="hidden")),
    lambda: records[f"{prefix}/actions/runs/77/artifacts?per_page=100"].update(
        total_count=1, artifacts=[{"id": 900, "name": "unexpected", "expired": False, "size_in_bytes": 1}]),
)
for mutation in mutations:
    records = copy.deepcopy(original); mutation(); reject()
records = copy.deepcopy(original)
for body in (
    ["##[group]Run set -euo pipefail", "live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true",
     "shared_mongo_lock=verify status=FAIL reason=active database operation lock has expired", "##[endgroup]"],
    ["live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true",
     "shared_mongo_lock=verify status=FAIL reason=foreign holder"],
    ["shared_mongo_lock=verify status=FAIL reason=active database operation lock has expired",
     "live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true"],
):
    raw_log = log(output=body); reject()
raw_log = log(dict(native, data_run_id="99")).replace(b"  DATA_RUN_ID: 99", b"  DATA_RUN_ID: 23")
reject()
raw_log = log()
assert proof()[0] == native
print(f"PASS frozen read-only step17 predicate, historical full-tree/library closure and hostile provider fixtures={len(mutations) + 4}")
PY
ok "frozen no-takeover native qualification and unchanged legacy routing"

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" "$ROOT_DIR" "$WORK/repository" <<'PY'
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import re
import stat
import subprocess
import sys
import warnings
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("upstream_binding", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
native_byte_reader = m.gh_api_bytes
native_jobs_inventory = m.jobs_for_run
native_artifacts_inventory = m.artifact_inventory
source = subprocess.check_output(["git", "-C", sys.argv[2], "rev-parse", "HEAD"], text=True).strip()
blob = subprocess.check_output([
    "git", "-C", sys.argv[2], "show",
    f"{source}:.github/workflows/oci-production-deploy.yml",
])
names = re.findall(r"(?m)^      - name: (.+)$", blob.decode().split("\n  public-validate:\n")[0])
boundary = names.index("Verify immutable image and infrastructure provenance")
steps = [{
    "name": name, "number": index + 2, "status": "completed",
    "conclusion": "success" if index < boundary else "failure" if index == boundary else "skipped",
    "started_at": "2026-10-07T09:09:15Z", "completed_at": "2026-10-07T09:09:17Z",
} for index, name in enumerate(names)]
for step in steps:
    if step["name"] in {"Remove isolated OCI client state", "Upload sanitized live readiness evidence"}:
        step["conclusion"] = "success"
steps.insert(0, {"name": "Set up job", "number": 1, "status": "completed", "conclusion": "success"})
for name in ("Post Checkout approved master commit", "Complete job"):
    steps.append({"name": name, "number": len(steps) + 1, "status": "completed", "conclusion": "success"})
original = [
    {"id": 1234, "run_id": 77, "name": "deploy", "status": "completed", "conclusion": "failure", "steps": steps},
    {"id": 1235, "run_id": 77, "name": "public-validate", "status": "completed", "conclusion": "skipped", "steps": []},
]
jobs = copy.deepcopy(original)
artifacts = []
m.jobs_for_run = lambda *_: jobs
m.artifact_inventory = lambda *_: artifacts
m.fixed_run_metadata = lambda *_: {"head_sha": source}
m.gh_api = lambda _: {"sha": hashlib.sha1(f"blob {len(blob)}\0".encode() + blob).hexdigest()}
profile = "oci-failed-deploy-retained-hold-v1"
def validate():
    return m.validate_failed_deploy_jobs("example/repo", "77", profile, "fixture")
def reject(call):
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            call()
        except SystemExit:
            return
    raise AssertionError("invalid pre-runtime evidence accepted")
assert validate() == ("skipped", "skipped", "skipped")
for name in names[boundary + 1:]:
    if name in {"Remove isolated OCI client state", "Upload sanitized live readiness evidence"}:
        continue
    jobs = copy.deepcopy(original)
    next(s for s in jobs[0]["steps"] if s["name"] == name)["conclusion"] = "success"
    reject(validate)
for mutation in ("unknown", "missing", "duplicate-step", "duplicate-job", "cancelled", "public"):
    jobs = copy.deepcopy(original)
    if mutation == "unknown":
        jobs[0]["steps"][1]["name"] = "Unexpected runtime operation"
    elif mutation == "missing":
        jobs[0]["steps"].pop(1)
    elif mutation == "duplicate-step":
        jobs[0]["steps"].append(copy.deepcopy(jobs[0]["steps"][1]))
    elif mutation == "duplicate-job":
        jobs.append(copy.deepcopy(jobs[1]))
    elif mutation == "cancelled":
        jobs[0]["conclusion"] = "cancelled"
    else:
        jobs[1]["conclusion"] = "success"
    reject(validate)
jobs = copy.deepcopy(original)
artifacts = [{"id": 1}]
reject(validate)
artifacts = []
mapping = {
    "approved_sha": "SOURCE_SHA", "build_run_id": "BUILD_RUN_ID",
    "infrastructure_run_id": "INFRASTRUCTURE_RUN_ID", "data_run_id": "DATA_RUN_ID",
    "checkpoint_source_sha": "CHECKPOINT_SOURCE_SHA", "disk_checkpoint_run_id": "DISK_CHECKPOINT_RUN_ID",
    "baseline_recovery_run_id": "BASELINE_RECOVERY_RUN_ID",
    "baseline_recovery_source_sha": "BASELINE_RECOVERY_SOURCE_SHA", "confirmation": "CONFIRMATION",
}
inputs = dict(zip(mapping, (source, "21", "22", "23", source, "24", "0", "none", "DEPLOY OCI EXACT SHA")))
def log(values=inputs, env_names=mapping):
    lines = ["##[group]Run set -euo pipefail", "env:"]
    lines += [f"  {env}: {values[key]}" for key, env in env_names.items()]
    lines += ["  DISPATCH_INPUTS: " + json.dumps(values, indent=2), "  PRIVATE_CREDENTIAL: do-not-emit", "##[endgroup]"]
    return ("\n".join("2026-10-07T09:09:16.1234567Z " + line for line in "\n".join(lines).splitlines()) + "\n").encode()
def log_archive(raw, names=("0_deploy.txt",)):
    output = io.BytesIO()
    with warnings.catch_warnings(), zipfile.ZipFile(output, "w") as bundle:
        warnings.simplefilter("ignore", UserWarning)
        for name in names:
            bundle.writestr(name, raw)
    return output.getvalue()

m.gh_api_bytes = lambda _: log_archive(log())
output = io.StringIO()
with contextlib.redirect_stdout(output):
    assert m.failed_deploy_native_inputs("example/repo", "77", source, "fixture") == inputs
assert output.getvalue() == ""
native_log = re.sub(rb"(?m)^2026-10-07T09:09:16.1234567Z (?=  \"|})", b"", log())
native_log += b"2026-10-07T09:09:17Z env:\n2026-10-07T09:09:17Z   GH_TOKEN: instructional-placeholder\n"
native_log += b"2026-10-07T09:09:17Z ##[group]Run actions/upload-artifact\n2026-10-07T09:09:17Z env:\n2026-10-07T09:09:17Z ##[endgroup]\n"
m.gh_api_bytes = lambda _: log_archive(native_log)
assert m.failed_deploy_native_inputs("example/repo", "77", source, "fixture") == inputs
archive_endpoint = "repos/example/repo/actions/runs/77/attempts/1/logs"
for resume_dispatch in (False, True):
    job_name = "rollout" if resume_dispatch else "deploy"
    values, env_names = dict(inputs), dict(mapping)
    jobs = copy.deepcopy(original)
    if resume_dispatch:
        values.pop("data_run_id"); env_names.pop("data_run_id")
        values.update(
            resume_source_sha=source, phase="apply-slip-index", prerequisite_run_id="23",
            failed_deploy_run_id="76", failed_activation_run_id="0", failed_activation_user_id="0",
            confirmation="RESUME APPLIED LIVE DATA EXACT SHA",
        )
        env_names.update({key: key.upper() for key in values if key not in env_names})
        jobs = [jobs[0]]
        jobs[0]["name"] = job_name
        jobs[0]["steps"] = [{
            "name": "Validate exact SHA phase and trusted upstream runs", "conclusion": "success",
            "started_at": "2026-10-07T09:09:15Z", "completed_at": "2026-10-07T09:09:17Z",
        }]
    raw = log(values, env_names)
    def read_native(**kwargs):
        return m.failed_deploy_native_inputs(
            "example/repo", "77", source, "fixture",
            resume_dispatch=resume_dispatch, **kwargs)
    with patch.object(m, "zip_files", return_value={f"0_{job_name}.txt": raw}):
        direct = read_native()
    assert direct == values
    original_steps = copy.deepcopy(jobs[0]["steps"])
    step_name = (
        "Validate exact SHA phase and trusted upstream runs" if resume_dispatch
        else "Verify immutable image and infrastructure provenance"
    )
    with patch.object(m, "gh_api_bytes", return_value=log_archive(raw, (f"0_{job_name}.txt",))):
        step = next(item for item in jobs[0]["steps"] if item["name"] == step_name)
        for expected in ("failure", "success"):
            for conclusion in ("failure", "success", "skipped", None):
                step["conclusion"] = conclusion
                if conclusion == ("success" if resume_dispatch else expected):
                    assert read_native(expected_step_conclusion=expected) == values
                else:
                    reject(lambda: read_native(expected_step_conclusion=expected))
        step["conclusion"] = "success"
        if resume_dispatch:
            assert read_native() == values
        else:
            reject(read_native)
        for unsupported in ("pending", "SUCCESS", None, True, []):
            reject(lambda: read_native(expected_step_conclusion=unsupported))
        for duplicate in (False, True):
            jobs[0]["steps"] = (
                original_steps + [copy.deepcopy(step)] if duplicate
                else [item for item in original_steps if item["name"] != step_name]
            )
            reject(lambda: read_native(expected_step_conclusion="success"))
    jobs[0]["steps"] = original_steps
    if resume_dispatch:
        defaults = {"held_handoff_run_id": "0", "held_handoff_source_sha": "none"}
        native_values = {**values, **defaults}
        native_names = {**env_names, **{key: key.upper() for key in defaults}}
        with patch.object(m, "gh_api_bytes", return_value=log_archive(
            log(native_values, native_names), ("0_rollout.txt",),
        )):
            assert read_native() == values
        assert native_values == {**values, **defaults}
        for key, value in (
            ("held_handoff_run_id", 0), ("held_handoff_run_id", "0 "),
            ("held_handoff_run_id", "77"), ("held_handoff_source_sha", None),
            ("held_handoff_source_sha", source), ("unknown", "0"),
        ):
            bad = {**native_values, key: value}
            names = {**native_names, key: key.upper()}
            with patch.object(m, "gh_api_bytes", return_value=log_archive(
                log(bad, names), ("0_rollout.txt",),
            )):
                reject(read_native)
        for absent in defaults:
            bad = dict(native_values); del bad[absent]
            names = dict(native_names); del names[absent]
            with patch.object(m, "gh_api_bytes", return_value=log_archive(
                log(bad, names), ("0_rollout.txt",),
            )):
                reject(read_native)
        continuation = {
            **values, "held_handoff_run_id": "76", "held_handoff_source_sha": source,
            "confirmation": "CONTINUE SUCCESSFUL HELD LIVE DATA EXACT SHA",
        }
        with patch.object(m, "gh_api_bytes", return_value=log_archive(
            log(continuation, native_names), ("0_rollout.txt",),
        )):
            assert read_native() == continuation
        for key, value in (
            ("held_handoff_run_id", "0"), ("held_handoff_run_id", 76),
            ("held_handoff_source_sha", "none"), ("held_handoff_source_sha", True),
        ):
            with patch.object(m, "gh_api_bytes", return_value=log_archive(
                log({**continuation, key: value}, native_names), ("0_rollout.txt",),
            )):
                reject(read_native)
    for prefix in ("0", "77", "-1"):
        name = f"{prefix}_{job_name}.txt"
        packed = log_archive(raw, (name, f"{job_name}/step.txt"))
        assert m.zip_files(packed, "fixture")[name] == raw
        with patch.object(m, "gh_api_bytes", return_value=packed) as read, \
                contextlib.redirect_stdout(io.StringIO()) as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            assert read_native() == direct
        read.assert_called_once_with(archive_endpoint)
        assert not stdout.getvalue() and not stderr.getvalue()
    original_name = f"0_{job_name}.txt!/other"
    nul_name = original_name.replace("!", "\0")
    packed = log_archive(raw, (original_name,))
    assert packed.count(original_name.encode()) == 2
    packed = packed.replace(original_name.encode(), nul_name.encode())
    assert packed.count(nul_name.encode()) == 2
    with zipfile.ZipFile(io.BytesIO(packed)) as bundle:
        info, = bundle.infolist()
        assert info.orig_filename == nul_name
        assert info.filename == f"0_{job_name}.txt" != info.orig_filename
    with patch.object(m, "gh_api_bytes", return_value=packed) as read:
        assert m.artifact_files("example/repo", {"id": 9}, "fixture")[info.filename] == raw
    read.assert_called_once_with("repos/example/repo/actions/artifacts/9/zip")
    with patch.object(m, "gh_api_bytes", return_value=packed) as read, \
            contextlib.redirect_stdout(io.StringIO()) as stdout, \
            contextlib.redirect_stderr(io.StringIO()) as stderr:
        try:
            read_native()
        except SystemExit as error:
            assert error.code == 1
        else:
            raise AssertionError("NUL-truncated native log identity was accepted")
    read.assert_called_once_with(archive_endpoint)
    assert not stdout.getvalue()
    assert stderr.getvalue() == (
        "upstream binding rejected: fixture native log archive contains a modified entry name\n"
    )
    for names in (
        (f"0_{job_name}.txt", f"-1_{job_name}.txt"),
        (f"0_{job_name}.txt", f"2_{job_name}.txt"),
        (f"-1_{job_name}.txt", f"-2_{job_name}.txt"),
        (f"0_{job_name}.txt", f"0_{job_name}.txt"),
        ("unrelated.txt",), ("0_wrong-job.txt",),
        (f"nested/0_{job_name}.txt",), (f"١_{job_name}.txt",),
        (f"../0_{job_name}.txt",), (f"/0_{job_name}.txt",),
        (f"nested\\0_{job_name}.txt",),
    ):
        with patch.object(m, "gh_api_bytes", return_value=log_archive(raw, names)) as read:
            reject(read_native)
        read.assert_called_once_with(archive_endpoint)
    for file_type in (stat.S_IFLNK, stat.S_IFIFO):
        unsafe = zipfile.ZipInfo("unsafe")
        unsafe.create_system = 3
        unsafe.external_attr = (file_type | 0o600) << 16
        with patch.object(m, "gh_api_bytes", return_value=log_archive(raw, (f"0_{job_name}.txt", unsafe))):
            reject(read_native)
    packed = log_archive(raw, (f"0_{job_name}.txt",))
    encrypted = bytearray(packed)
    encrypted[6] |= 1
    encrypted[encrypted.index(b"PK\x01\x02") + 8] |= 1
    for bad_archive in (b"not a ZIP", bytes(encrypted), log_archive(b"", (f"0_{job_name}.txt",)),
                        log_archive(b"\xff", (f"0_{job_name}.txt",))):
        with patch.object(m, "gh_api_bytes", return_value=bad_archive):
            reject(read_native)
    with patch.object(m, "gh_api_bytes", return_value=packed), \
            patch.object(m, "MAX_ARTIFACT_EVIDENCE_BYTES", len(raw) - 1):
        reject(read_native)
    with patch.object(m, "gh_api_bytes", return_value=log_archive(raw, (f"0_{job_name}.txt", "other.txt"))), \
            patch.object(m, "MAX_ARTIFACT_ARCHIVE_BYTES", 2 * len(raw) - 1):
        reject(read_native)
jobs = copy.deepcopy(original)
print("PASS primary attempt-one archive mapping, direct parser equivalence, and bounded ZIP rejection")
held_workflow = subprocess.check_output([
    "git", "-C", sys.argv[3], "cat-file", "blob", "27a98e345050fefb799c706fde03d8f79e14ed6c",
])
assert hashlib.sha1(f"blob {len(held_workflow)}\0".encode() + held_workflow).hexdigest() == (
    "27a98e345050fefb799c706fde03d8f79e14ed6c")
held_names = re.findall(r"(?m)^      - name: (.+)$", held_workflow.decode())
held_skipped = {
    "Download failed deploy protected baseline",
    "Download explicitly selected recovery baseline authority",
    "Bind historical recovery source through its exact artifact",
    "Verify OKE identity",
    "Reconcile expired and authorize current runner IPv4",
    "Configure kubectl from exact cluster OCID",
    "Demote and verify exact retained live-acceptance account",
    "Delete exact orphaned live-acceptance slips",
    "Capture post-phase runtime baseline",
    "Restore runtime or retain hold if final handoff packaging failed",
    "Release database operation lock unless handed to deploy",
    "Revoke exact runner rule",
}
held_steps = [{
    "name": name, "number": number, "status": "completed",
    "conclusion": "skipped" if name in held_skipped else "success",
    "started_at": "2026-10-07T09:09:15Z", "completed_at": "2026-10-07T09:09:17Z",
} for number, name in enumerate([
    "Set up job", *held_names, "Post Checkout approved current master commit", "Complete job",
], 1)]
held_steps[-2]["number"] = 74
held_steps[-1]["number"] = 75
assert [step["number"] for step in held_steps] == [*range(1, 38), 74, 75]
held_original = [{
    "id": 1234, "run_id": 77, "name": "rollout", "status": "completed",
    "conclusion": "success", "steps": held_steps,
    "started_at": "2026-10-07T09:09:14Z", "completed_at": "2026-10-07T09:09:20Z",
}]
held_jobs = copy.deepcopy(held_original)
held_metadata = {
    "head_sha": source, "created_at": "2026-10-07T09:00:00Z",
    "updated_at": "2026-10-07T09:09:21Z",
}
def held_blob(endpoint):
    return {"sha": "27a98e345050fefb799c706fde03d8f79e14ed6c" if ".yml?" in endpoint
            else "1752489383424fa4bd55bbc7d36e4cac95e14d31"}
def held_native(request=None):
    return m.validate_held_handoff_native(
        "example/repo", "77", source, values if request is None else request, "k3s", "fixture")
with patch.object(m, "require_fixed_run", return_value=held_metadata), \
        patch.object(m, "jobs_for_run", side_effect=lambda *_: held_jobs), \
        patch.object(m, "gh_api", side_effect=held_blob), \
        patch.object(m, "gh_api_bytes", return_value=log_archive(log(values, env_names), ("0_rollout.txt",))):
    assert held_native() == held_metadata
    assert held_jobs == held_original
    for index in range(len(held_steps)):
        held_jobs = copy.deepcopy(held_original)
        step = held_jobs[0]["steps"][index]
        step["conclusion"] = "success" if step["conclusion"] == "skipped" else "skipped"
        reject(held_native)
    for index, wrong in (
        (0, True), (0, "1"), (0, 0), (0, -1), (1, 1), (36, 38),
        (37, 38), (38, 39), (37, 73), (37, 75), (38, 74), (38, 76),
        (37, "74"), (37, 0), (37, -74), (37, None), (38, 75.0),
    ):
        held_jobs = copy.deepcopy(held_original)
        held_jobs[0]["steps"][index]["number"] = wrong
        reject(held_native)
    for cleanup_numbers in ((38, 39), (75, 74), (74, 74), (75, 75)):
        held_jobs = copy.deepcopy(held_original)
        held_jobs[0]["steps"][-2]["number"], held_jobs[0]["steps"][-1]["number"] = cleanup_numbers
        reject(held_native)
    for mutation in ("missing", "missing-post", "missing-number", "order",
                     "duplicate", "unknown", "job", "run", "number", "time", "failure"):
        held_jobs = copy.deepcopy(held_original)
        if mutation == "missing": held_jobs[0]["steps"].pop()
        elif mutation == "missing-post": held_jobs[0]["steps"].pop(-2)
        elif mutation == "missing-number": held_jobs[0]["steps"][-2].pop("number")
        elif mutation == "order":
            held_jobs[0]["steps"][-2:] = reversed(held_jobs[0]["steps"][-2:])
        elif mutation == "duplicate": held_jobs[0]["steps"].append(copy.deepcopy(held_steps[1]))
        elif mutation == "unknown": held_jobs[0]["steps"][1]["name"] = "Untrusted operation"
        elif mutation == "job": held_jobs.append(copy.deepcopy(held_jobs[0]))
        elif mutation == "run": held_jobs[0]["run_id"] = 78
        elif mutation == "number": held_jobs[0]["steps"][1]["number"] = True
        elif mutation == "time": held_jobs[0]["completed_at"] = "2026-10-07T09:09:13Z"
        else: held_jobs[0]["conclusion"] = "failure"
        reject(held_native)
    held_jobs = copy.deepcopy(held_original)
    for key in (
        "resume_source_sha", "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
        "disk_checkpoint_run_id", "prerequisite_run_id", "failed_deploy_run_id",
    ):
        reject(lambda key=key: held_native({**values, key: "substituted"}))
    for changed in (".yml?", ".sh?"):
        with patch.object(m, "gh_api", side_effect=lambda endpoint:
                          {"sha": "0" * 40} if changed in endpoint else held_blob(endpoint)):
            reject(held_native)
print("PASS fixed successful held producer, exact native slots 1..37/74/75, complete outcomes, and original root tuple")
current_workflow = subprocess.check_output([
    "git", "-C", sys.argv[2], "show", source + ":.github/workflows/oci-live-data-rollout.yml",
]).decode()
current_names = re.findall(r"(?m)^      - name: (.+)$", current_workflow)
current_skipped = held_skipped | {"Verify reader-qualified released activation state"}
current_start = m.dt.datetime(2026, 10, 7, 9, 9, tzinfo=m.dt.timezone.utc)
current_steps = []
for index, name in enumerate([
    "Set up job", *current_names, "Post Checkout approved current master commit", "Complete job",
]):
    began = current_start + m.dt.timedelta(seconds=2 * index)
    current_steps.append(dict(
        name=name, number=index + 1, status="completed",
        conclusion="skipped" if name in current_skipped else "success",
        started_at=began.isoformat(), completed_at=(began + m.dt.timedelta(seconds=1)).isoformat(),
    ))
current_steps[-2]["number"] = 2 * (len(current_names) + 1)
current_steps[-1]["number"] = current_steps[-2]["number"] + 1
current_job = dict(held_original[0], steps=current_steps,
                  started_at=current_start.isoformat(), completed_at="2026-10-07T09:12:00Z")
current_metadata = dict(held_metadata, updated_at="2026-10-07T09:12:01Z")
renewal_step = next(step for step in current_steps
                    if step["name"] == "Restore runtime or verify final deploy handoff")
renewal_epoch = int(m.parse_timestamp(renewal_step["started_at"], "fixture").timestamp())
def renewal_log(deadline=renewal_epoch + 1800, generation=12):
    timestamp = renewal_step["started_at"].replace("+00:00", "Z")
    output = [
        "##[group]Run shell",
        "echo shared_mongo_lock=renew status=PASS lease_until_epoch=9999999999 fencing_generation=999",
        "##[endgroup]",
        "live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true",
        f"shared_mongo_lock=verify status=PASS lease_until_epoch={renewal_epoch + 14400} fencing_generation=11",
        f"shared_mongo_lock=renew status=PASS lease_until_epoch={deadline} fencing_generation={generation}",
    ]
    return log_archive("\n".join(f"{timestamp} {line}" for line in output).encode(), ("0_rollout.txt",))
with patch.object(m, "require_fixed_run", return_value=current_metadata), \
        patch.object(m, "jobs_for_run", side_effect=lambda *_: [current_job]), \
        patch.object(m, "gh_api", return_value={"sha": "0" * 40}), \
        patch.object(m, "current_held_source", return_value=current_workflow), \
        patch.object(m, "failed_deploy_native_inputs", return_value=values), \
        patch.object(m, "gh_api_bytes", return_value=renewal_log()):
    observed = held_native()
    assert observed["_held_complete"] is True
    assert observed["_handoff_deadline"] == renewal_epoch + 1800
    assert current_job["steps"] == current_steps
    for deadline, generation in ((renewal_epoch + 1802, 12), (renewal_epoch + 1800, 11),
                                 (renewal_epoch + 3600, 12), (renewal_epoch - 1, 12)):
        with patch.object(m, "gh_api_bytes", return_value=renewal_log(deadline, generation)):
            reject(held_native)
    for field, bad in (("conclusion", "failure"), ("run_id", 78), ("id", True)):
        with patch.dict(current_job, {field: bad}):
            reject(held_native)
    with patch.dict(current_steps[3], {"started_at": current_steps[0]["started_at"]}):
        reject(held_native)
    with patch.dict(current_steps[4], {"conclusion": "skipped"}):
        reject(held_native)
    with patch.object(m, "failed_deploy_native_inputs", return_value=dict(values, build_run_id="99")):
        reject(held_native)
tree = subprocess.check_output(["git", "-C", sys.argv[2], "rev-parse", source + "^{tree}"], text=True).strip()
with patch.object(m, "gh_api", return_value={"sha": source, "tree": {"sha": tree}}):
    assert m.current_held_source("example/repo", source, "fixture") == current_workflow
for bad in ({"sha": source, "tree": {"sha": "0" * 40}}, {"sha": "0" * 40, "tree": {"sha": tree}}):
    with patch.object(m, "gh_api", return_value=bad):
        reject(lambda: m.current_held_source("example/repo", source, "fixture"))
print("PASS complete current producer closure, native chronology, authentic final renewal and no historical fallback")
history_held = {
    "id": 77, "head_sha": source, "created_at": "2026-10-07T08:00:00Z",
    "updated_at": "2026-10-07T09:00:00Z",
}
successor = {
    "id": 78, "run_attempt": 1, "head_sha": source, "workflow_id": 4,
    "path": ".github/workflows/oci-live-data-rollout.yml", "event": "workflow_dispatch",
    "head_branch": "master", "head_repository": {"full_name": "example/repo"},
    "display_title": f"oci-live-data apply-slip-index {source}",
    "status": "completed", "conclusion": "success",
    "created_at": "2026-10-07T09:30:00Z", "updated_at": "2026-10-07T10:30:00Z",
}
cutoff_job = {
    "id": 1236, "run_id": 78, "name": "rollout", "status": "completed",
    "started_at": "2026-10-07T09:59:00Z",
    "steps": [{"name": "Validate exact SHA phase and trusted upstream runs",
               "started_at": "2026-10-07T10:00:00Z"}],
}
history_mutation = ""
history_reads = []
correction_builds = {
    name: {
        "id": run_id, "path": ".github/workflows/" + name,
        "head_repository": {"full_name": "example/repo"}, "head_branch": "master",
        "created_at": "2026-10-07T09:05:00Z", "updated_at": "2026-10-07T09:20:00Z",
        "status": "completed",
    }
    for name, run_id in (("production-build.yml", 80), ("oci-production-build.yml", 81))
}
def history_api(endpoint):
    if "/actions/workflows/" in endpoint:
        return {"id": 4}
    return copy.deepcopy(successor)
def history_pages(endpoint):
    history_reads.append(endpoint)
    name = endpoint.split("/workflows/", 1)[1].split("/", 1)[0]
    rows = [copy.deepcopy(correction_builds[name])] if name in correction_builds else []
    if name == "oci-live-data-rollout.yml":
        rows = [
            {**history_held, "path": ".github/workflows/" + name,
             "head_repository": {"full_name": "example/repo"}, "head_branch": "master", "status": "completed"},
            copy.deepcopy(successor),
        ]
        if history_mutation == "omitted-authenticated":
            rows = []
    if name == "oci-production-deploy.yml":
        rows = [{
            "id": 76, "path": ".github/workflows/" + name,
            "head_repository": {"full_name": "example/repo"}, "head_branch": "master",
            "created_at": "2026-10-07T07:00:00Z", "updated_at": "2026-10-07T07:30:00Z",
            "status": "completed",
        }]
        if history_mutation in {"intervening", "older-intervening"}:
            rows[0]["updated_at"] = "2026-10-07T09:45:00Z"
            if history_mutation == "intervening":
                rows[0]["created_at"] = "2026-10-07T09:40:00Z"
        if history_mutation == "duplicate": rows.append(copy.deepcopy(rows[0]))
        if history_mutation == "foreign": rows[0]["head_repository"]["full_name"] = "other/repo"
        if history_mutation == "foreign-workflow-owner": rows[0]["id"] = 78
        if history_mutation == "missing-branch": rows[0].pop("head_branch")
        if history_mutation == "unresolved": rows[0]["status"] = "waiting"
        if history_mutation == "later" and "&created=" not in endpoint:
            rows.append({**rows[0], "id": 79, "created_at": "2026-10-07T11:00:00Z",
                         "updated_at": "2026-10-07T11:30:00Z"})
    total = len(rows)
    if history_mutation == "incomplete": total += 1
    if history_mutation == "bound": total = 1000
    if history_mutation in {"paginated", "incoherent-pages"}:
        return [{"total_count": total, "workflow_runs": rows[:1]},
                {"total_count": total + (history_mutation == "incoherent-pages"), "workflow_runs": rows[1:]}]
    return [{"total_count": total, "workflow_runs": rows}]
with patch.object(m, "gh_api", side_effect=history_api), \
        patch.object(m, "gh_api_pages", side_effect=history_pages), \
        patch.object(m, "jobs_for_run", return_value=[cutoff_job]):
    proof = m.held_handoff_history("example/repo", history_held, source, "78")
    assert proof["cutoff_at"] == "2026-10-07T10:00:00Z"
    assert history_reads and all("&created=%3C%3D2026-10-07T10:00:00Z" in p for p in history_reads)
    assert all(not any("/workflows/" + name + "/" in p for p in history_reads) for name in correction_builds)
    history_mutation = "paginated"
    assert m.held_handoff_history("example/repo", history_held, source, "78") == proof
    history_mutation = ""
    successor.update(status="waiting", conclusion=None)
    waiting = m.held_handoff_history("example/repo", history_held, source, "78")
    assert waiting["cutoff_at"] is None
    successor.update(status="completed", conclusion="success")
    history_mutation = "later"
    assert m.held_handoff_history("example/repo", history_held, source, "78") == proof
    reject(lambda: m.held_handoff_history("example/repo", history_held, source))
    for history_mutation in ("intervening", "older-intervening", "duplicate", "foreign", "unresolved",
                             "incomplete", "bound", "omitted-authenticated", "incoherent-pages",
                             "foreign-workflow-owner", "missing-branch"):
        reject(lambda: m.held_handoff_history("example/repo", history_held, source, "78"))
    history_mutation = ""
    reject(lambda: m.held_handoff_history("example/repo", history_held, source, "99"))
    for key, wrong in (
        ("head_sha", "f" * 40), ("run_attempt", 2), ("path", ".github/workflows/other.yml"),
        ("display_title", "another operation"), ("conclusion", "failure"),
    ):
        saved = successor[key]; successor[key] = wrong
        reject(lambda: m.held_handoff_history("example/repo", history_held, source, "78"))
        successor[key] = saved
    cutoff_job["run_id"] = 99
    reject(lambda: m.held_handoff_history("example/repo", history_held, source, "78"))
    cutoff_job["run_id"] = 78
print("PASS complete bounded held history, immutable cutoff, later deployment and unrelated exclusions")
import base64
from pathlib import Path

authority_spec = importlib.util.spec_from_file_location(
    "history_shared_authority", Path(sys.argv[2]) / "infra/azure/agents/copilot_cli_authority_stan.py")
shared_authority = importlib.util.module_from_spec(authority_spec)
authority_spec.loader.exec_module(shared_authority)
assert set(shared_authority.UNMATERIALIZED_WORKFLOWS) == {
    ".github/workflows/oci-live-data-rollout.yml",
    ".github/workflows/oci-live-betting-activate.yml",
    ".github/workflows/oci-capacity-acquire.yml",
}
assert set(shared_authority.PREPARED_TRANSITION_WORKFLOWS) == {
    "oci-live-data-rollout.yml", "oci-live-betting-activate.yml",
}
ghost_rows, ghost_responses, ghost_compares = [], {}, {}
def historical_response(path, raw):
    return {
        "path": path, "type": "file", "encoding": "base64", "size": len(raw),
        "sha": hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest(),
        "content": base64.b64encode(raw).decode(),
    }
for offset, workflow_name in enumerate((
    "oci-live-data-rollout.yml", "oci-live-betting-activate.yml", "oci-capacity-acquire.yml",
)):
    run_id, workflow_id = 610 + offset, 710 + offset
    path = ".github/workflows/" + workflow_name
    old_sha = "abc"[offset] * 40
    row = {
        "id": run_id, "workflow_id": workflow_id, "path": path, "head_sha": old_sha,
        "head_branch": "master", "head_repository": {"full_name": "example/repo"},
        "event": "workflow_dispatch", "run_attempt": 1, "status": "queued", "conclusion": None,
        "display_title": workflow_name.removesuffix(".yml"),
        "created_at": "2026-10-07T07:00:00Z", "updated_at": "2026-10-07T07:00:00Z",
        "run_started_at": "2026-10-07T07:00:00Z",
        "html_url": f"https://github.com/example/repo/actions/runs/{run_id}",
    }
    ghost_rows.append(row)
    endpoint = f"repos/example/repo/actions/runs/{run_id}"
    ghost_responses.update({
        endpoint: copy.deepcopy(row),
        f"repos/example/repo/actions/workflows/{workflow_id}": {
            "id": workflow_id, "path": path, "state": "disabled_manually",
        },
        endpoint + "/jobs?filter=all&per_page=100": {"total_count": 0, "jobs": []},
        endpoint + "/pending_deployments": [],
        endpoint + "/approvals": [],
        endpoint + "/artifacts?per_page=100": {"total_count": 0, "artifacts": []},
        f"repos/example/repo/contents/{path}?ref={old_sha}": historical_response(
            path, (Path(sys.argv[2]) / path).read_bytes()),
    })
    compare = {
        "status": "ahead", "ahead_by": 2, "behind_by": 0, "total_commits": 2,
        "base_commit": {"sha": old_sha}, "merge_base_commit": {"sha": old_sha},
    }
    ghost_compares[f"repos/example/repo/compare/{old_sha}...{source}?per_page=100"] = [
        {**compare, "commits": [{"sha": "d" * 40}]},
        {**compare, "commits": [{"sha": source}]},
    ]
original_ghost_rows = copy.deepcopy(ghost_rows)
original_ghost_responses = copy.deepcopy(ghost_responses)
original_ghost_compares = copy.deepcopy(ghost_compares)
ghost_reads, ghost_run_reads = [], {}
ghost_api_failure, ghost_reread_drift = "", False
def ghost_api(endpoint):
    ghost_reads.append(endpoint)
    if endpoint == ghost_api_failure:
        m.fail("fresh historical provider evidence is unavailable")
    if endpoint in ghost_responses:
        response = copy.deepcopy(ghost_responses[endpoint])
        if endpoint == "repos/example/repo/actions/runs/610":
            ghost_run_reads[endpoint] = ghost_run_reads.get(endpoint, 0) + 1
            if ghost_reread_drift and ghost_run_reads[endpoint] == 2:
                response["updated_at"] = "2026-10-07T07:00:01Z"
        return response
    assert endpoint in {
        "repos/example/repo/actions/runs/78",
        "repos/example/repo/actions/runs/78/attempts/1",
        "repos/example/repo/actions/workflows/oci-live-data-rollout.yml",
    }, endpoint
    return history_api(endpoint)
def ghost_pages(endpoint):
    ghost_reads.append(endpoint)
    if endpoint == ghost_api_failure:
        m.fail("fresh historical pagination is unavailable")
    if "/compare/" in endpoint:
        return copy.deepcopy(ghost_compares[endpoint])
    pages = history_pages(endpoint)
    name = endpoint.split("/workflows/", 1)[1].split("/", 1)[0]
    extra = [copy.deepcopy(row) for row in ghost_rows if row["path"] == ".github/workflows/" + name]
    pages[0]["workflow_runs"].extend(extra)
    for page in pages:
        page["total_count"] += len(extra)
    return pages
def ghost_history():
    return m.held_handoff_history("example/repo", history_held, source, "78")
history_now = int(m.parse_timestamp("2026-10-07T10:31:00Z", "fixture clock").timestamp())
with patch.object(m, "gh_api", side_effect=ghost_api), \
        patch.object(m, "gh_api_pages", side_effect=ghost_pages), \
        patch.object(m, "jobs_for_run", return_value=[cutoff_job]), \
        patch.object(m, "time", wraps=m.time) as history_clock:
    history_clock.time.return_value = history_now
    ghost_proof = ghost_history()
    for row in ghost_rows:
        name = row["path"].split("/")[-1]
        assert ghost_proof["workflow_counts"][name] == proof["workflow_counts"][name] + 1
        assert ghost_reads.count(f"repos/example/repo/actions/runs/{row['id']}") == 2
        ghost_responses[f"repos/example/repo/actions/workflows/{row['workflow_id']}"]["state"] = "active"
    assert ghost_history() == ghost_proof
    assert all("..."+source+"?per_page=100" in endpoint for endpoint in ghost_reads if "/compare/" in endpoint)
    assert not any("/git/ref/" in endpoint for endpoint in ghost_reads)
    for row in ghost_rows:
        endpoint = f"repos/example/repo/actions/runs/{row['id']}"
        compare_pages = ghost_compares[f"repos/example/repo/compare/{row['head_sha']}...{source}?per_page=100"]
        evidence = {
            "run": ghost_responses[endpoint],
            "workflow": ghost_responses[f"repos/example/repo/actions/workflows/{row['workflow_id']}"],
            "jobs": ghost_responses[endpoint + "/jobs?filter=all&per_page=100"],
            "pending": ghost_responses[endpoint + "/pending_deployments"],
            "approvals": ghost_responses[endpoint + "/approvals"],
            "artifacts": ghost_responses[endpoint + "/artifacts?per_page=100"],
            "compare": {**compare_pages[0], "commits": [page["commits"][0] for page in compare_pages]},
            "historical_workflow": ghost_responses[
                f"repos/example/repo/contents/{row['path']}?ref={row['head_sha']}"],
            "repository": "example/repo", "current_master": source,
            "now_epoch": history_now, "minimum_age_seconds": 600,
            "expected_run_id": row["id"], "expected_workflow_id": row["workflow_id"],
            "expected_path": row["path"], "expected_head_sha": row["head_sha"],
            "require_disabled_workflow": True,
        }
        reject(lambda: shared_authority.validate_unmaterialized_run_evidence(**evidence))
        evidence["workflow"] = {**evidence["workflow"], "state": "disabled_manually"}
        assert shared_authority.validate_unmaterialized_run_evidence(**evidence)["runId"] == row["id"]
    ghost_responses = copy.deepcopy(original_ghost_responses)
    target = "repos/example/repo/actions/runs/610"
    for field, bad in (
        ("run_attempt", 2), ("run_attempt", True), ("status", "in_progress"),
        ("conclusion", "success"), ("event", "push"),
        ("display_title", f"oci-live-data apply-slip-index {'a' * 40}"),
        ("run_started_at", "2026-10-07T07:00:01Z"),
        ("updated_at", "2026-10-07T07:00:01Z"),
        ("updated_at", "2026-10-07T08:00:00Z"),
        ("updated_at", "2026-10-07T08:00:01Z"),
    ):
        ghost_rows = copy.deepcopy(original_ghost_rows)
        ghost_responses = copy.deepcopy(original_ghost_responses)
        ghost_rows[0][field] = bad
        ghost_responses[target][field] = bad
        ghost_reads.clear()
        reject(ghost_history)
        if field == "updated_at" and bad >= history_held["created_at"]:
            assert target not in ghost_reads
    ghost_rows = copy.deepcopy(original_ghost_rows)
    for suffix, bad in (
        ("/jobs?filter=all&per_page=100", {"total_count": 1, "jobs": [{"id": 1}]}),
        ("/jobs?filter=all&per_page=100", {"total_count": 1, "jobs": []}),
        ("/pending_deployments", [{"environment": {"name": "oci-migration"}}]),
        ("/approvals", [{"state": "approved"}]),
        ("/artifacts?per_page=100", {"total_count": 1, "artifacts": [{"id": 1}]}),
        ("/artifacts?per_page=100", {"total_count": False, "artifacts": []}),
    ):
        ghost_responses = copy.deepcopy(original_ghost_responses)
        ghost_responses[target + suffix] = bad
        reject(ghost_history)
    for field, bad in (
        ("id", 999), ("workflow_id", 999), ("path", ".github/workflows/other.yml"),
        ("head_sha", "e" * 40), ("head_branch", "other"),
        ("event", "push"), ("run_attempt", 2), ("status", "waiting"),
        ("conclusion", "success"), ("display_title", "substituted"),
        ("created_at", "2026-10-07T06:00:00Z"),
        ("run_started_at", "2026-10-07T06:00:00Z"),
        ("updated_at", "2026-10-07T06:00:00Z"),
        ("html_url", "https://github.com/example/repo/actions/runs/999"),
        ("head_repository", {"full_name": "foreign/repo"}),
    ):
        ghost_responses = copy.deepcopy(original_ghost_responses)
        ghost_responses[target][field] = bad
        reject(ghost_history)
    ghost_responses = copy.deepcopy(original_ghost_responses)
    ghost_run_reads.clear()
    ghost_reread_drift = True
    reject(ghost_history)
    ghost_reread_drift = False
    for endpoint in [*original_ghost_responses, *original_ghost_compares]:
        ghost_api_failure = endpoint
        reject(ghost_history)
    ghost_api_failure = ""
    history_clock.time.return_value = int(m.parse_timestamp("2026-10-07T07:09:59Z", "age fixture").timestamp())
    reject(ghost_history)
    history_clock.time.return_value = history_now
    historical_endpoint = f"repos/example/repo/contents/.github/workflows/oci-live-data-rollout.yml?ref={'a' * 40}"
    original_source = base64.b64decode(original_ghost_responses[historical_endpoint]["content"])
    for old, new in (
        (shared_authority.CURRENT_MASTER_GUARD_LINES[0].encode(), b"# exact source guard removed"),
        (b"group: oci-control-plane", b"group: unrelated-control-plane"),
        (b"name: oci-migration", b"name: unrelated-environment"),
        (b"./infra/oci/scripts/live-betting-data-rollout-stan.sh", b"./unrelated-producer.sh"),
    ):
        assert old in original_source
        ghost_responses = copy.deepcopy(original_ghost_responses)
        ghost_responses[historical_endpoint] = historical_response(
            ".github/workflows/oci-live-data-rollout.yml", original_source.replace(old, new))
        reject(ghost_history)
    ghost_responses = copy.deepcopy(original_ghost_responses)
    compare_endpoint = f"repos/example/repo/compare/{'a' * 40}...{source}?per_page=100"
    for mutation in ("truncated", "inconsistent", "duplicate", "wrong-head", "wrong-base",
                     "diverged", "behind", "empty", "malformed", "bool-metadata"):
        ghost_compares = copy.deepcopy(original_ghost_compares)
        pages = ghost_compares[compare_endpoint]
        if mutation == "truncated": pages.pop()
        elif mutation == "inconsistent": pages[1]["total_commits"] = 3
        elif mutation == "duplicate": pages[0]["commits"] = copy.deepcopy(pages[1]["commits"])
        elif mutation == "wrong-head": pages[1]["commits"][0]["sha"] = "e" * 40
        elif mutation == "wrong-base":
            for page in pages: page["base_commit"] = {"sha": "e" * 40}
        elif mutation == "diverged":
            for page in pages: page["status"] = "diverged"
        elif mutation == "behind":
            for page in pages: page["behind_by"] = 1
        elif mutation == "empty": pages.clear()
        elif mutation == "malformed": pages[1]["commits"] = {}
        else: pages[1]["behind_by"] = False
        reject(ghost_history)
    ghost_compares = copy.deepcopy(original_ghost_compares)
    with patch.object(m.importlib.util, "spec_from_file_location", return_value=None):
        reject(ghost_history)
        ghost_rows = []
        assert ghost_history() == proof
    ghost_rows = copy.deepcopy(original_ghost_rows)
    with patch.object(m.importlib.util, "spec_from_file_location", side_effect=ImportError):
        reject(ghost_history)
    assert ghost_history() == ghost_proof
print("PASS real shared historical ghost proof, all three workflows, strict outer disabled boundary, fresh drift and complete ancestry")

import gzip
import os
import tempfile

cancelled_path = ".github/workflows/oci-live-data-rollout.yml"
# Frozen c3c9332 native source, independent of the current workflow and shallow Git history.
cancelled_source = gzip.decompress(base64.b64decode(
    b"H4sIAAAAAAAC/+09W3vbtpLv/hUo17uWWlO2c63dqlvHlhNtbMsryTnNOj76aImy2UiiDkk5dRPvb98ZACRxpShZuZw97UOaiMBg"
    b"gBkMZgYzg4k39vdI2A/cUXDruwMv8dwoHI3CWbIWzSbuRP9O1j9+JMFkOkvi2vTGi31yfy/+5k2nUXjrD3rxjQef1tbCyd4aIR/C"
    b"6P1wFH7oDYJ46iX9G/yR8E7s74SIfdPfCBn4cT8KpkkAkEjjD6+fkP4sivxJQsZenPgR6bzaz/qSYRiR5MYnFOMrP0mCyTWhmFN0"
    b"M7CR/49ZEPmDPZJEs/zn5G4KU46TCLqtpS3j2djvxeEs6vtzcWPNKE7hkGIyhVH8vh/HgJk3AQy9YASIwgLHP2VTwfaI+hBGu2Go"
    b"xkvgejULRoMegO4FAwuanVkfkRnORmQYRHHieknij6cJpTMs4mDWx4YuBYVYkubhEpgEk2EE5IkA2izyl0RpGEy8UfAnrBYiJ4Nc"
    b"HrX+jd9/Pw2DSbI8USN/5CP3Az+/FwAugQ1C6AkoLbdSFnwIIyhskqVXi/KiBZ227w02yZXXfz8MRqNNAgzcj3wv8Smj3/pRMLyj"
    b"y9UZBVNgiYH/RzkM+jdh0M9/DOl4cY4FIS4ZRHcuzEr6DcTA6M5NEYoN32LAxBUxge1JUYmDZA6bnkUBTDDOScAEIFtZOvltuodV"
    b"xCwzHfhDbzZK9oiz7RTuaRhkFEwAOb8PIi66K8aScazMHX0PWAIRnHpREngjKuVxlUgKk3iz5CaMgj9RXKbyk7x8ddDOxmcz/Hyz"
    b"KrkXb4I4AUT73ijdliAy4RcQEleM2QCw309QxHLQFPNJOPFLIy81NmDPZHhv4E9H4Rx6HDFxP/Ci94S1J0nIDxXiDfEAo8fTBy8m"
    b"3gh2z+COsmrgD1a74hxnWMPg1kPcSuFN+SDvAwvsJWTkDxPiM9F4N4E1T4I+2+M4lc+N9iz2o3n8n6OFrWF/wskajhn2/ADOIa4W"
    b"4RsfjuAbEIDhcFhmqwoCBbsS3hW5pB9OQH+Z+YJw8eluDWFyEYhFP6IT+Cyoz92PHbb96InoWeex+s0HqwLibUxnbkGtC72oLGBM"
    b"KvYAqR2h2E4VxUxaLK4frsH6j4M4Ts8mr8+OKYK7eI0imoByl/6wBv9m+l7/DptfR+FsyvRrbAky2Z2OPDr3vjfp+yM4p1AjuwZh"
    b"ATCG3gjwW/s9vKKDcUWdK9LDPXIdJDezqxpyXCr363WyQ7+jsuniwsyuZpNk5o7gjI6ZtpIEYx/guGNgNPhxj+z8yLaCP7kNonAy"
    b"hhmkq5wbBOPgWmA9aJo26bTO2weNHqhKe0V2AWvcbnTOT6CxuY+meOcdX5w3jw977fPTXvNQ6iMqwHnz5ulRe7/TbZ8fdM/bDVM/"
    b"o7qaAzh41Th4fdZqnnZtyBqVyhzAYbPzuidAMaBgVgRzEGev9juNPZMBljZoN9qN/z5vdppd4xwNmo6wogD8uHkKHRsHrTeN9lvj"
    b"6lpUkSIwlvUqOv9zcEf7zePGYe+wcXbcMmJkOoi17vsH3eab/W6zdVoAQjsXi8Ccdxrt+XD4QZUDetUArn21f3rYOjoyoWI4Oiyd"
    b"LatqEeACI7dOj5rtEzoLmX9FESmy7dl+9+BVr3l6dt7tsB5J+F+d1mmFdazmjVsHTZxUtwlb+qR1yHn11ovimvpJ7nRw3OwBr3Qo"
    b"Ts7j2u52LTunaM/GywzdHBz9UQbUbZzunx687cHfD5Xm4idl9CYjp6GT+Enr9LrxtnfUPH3ZaJ+1YUvrXZUGCoDWydl+u3vSAGFg"
    b"Gln5LHfefwMcuf+iedzsvu0dtk72m+rqGFrIIF7/2Omd7p80gL4HKqWkb0q3x/AJCEi/q93Eb+TTJ7Jx5Sdx4k3c94/jDRkOyAm6"
    b"kQ4bR/vnx11kAZwqzLQNJ9Duo9p27VFtZ+vxI95n/+zsuHnA9zBQHoT5295Zu/WmediAHtc3/aio5atWp8ta1YKwqGG7cdYC+dlq"
    b"v92DicXB6M6/xSlspVMJxt515poxgujuvwTMGkfN3/aIF42fPZnXuAPnwgns49sdYYFOGieARO9k/7feWQO2usZgegN5hemJY++u"
    b"fla48+xc7uvsZjsSZE4bpOFJ6/Rlq3fcOnjd67ZeN4ABcycijiSoI1SKqT+mOko2rg63BcNzSSXDNp9/OoDjBhxHvQ4cRaeHILyc"
    b"nSdPts3zSOWquduP2It2ixN/mvkhXK4QNScBWtXBnz4J4hB1qwGuInc7esmN4MqbgRL2SfBLfBT+DopU/yYkzqvWSaO+DvLyFGRP"
    b"t3FytoUq10049h1D69fnLxpUrL8099mqvZ9d+VtUwF+LAO7JL78QZ/1ls/vq/EWvcfpG/MhgWwCOQjC/t66CiSOBgKPilQhj/H4Q"
    b"RMSdkncS2k4Bmo7SFv0VQzhS4y3mj7R9VXyDtmaoY7mCe8zWTlSVrI0y34m9ASqwbjHmRvd7YWvaMNWf3CsfLBl/gQ7U5yC07t+M"
    b"wwF5vr1tIYxTTLA1ZTMc4OriFDKXvOKu74fjcZB7SkFJAqODm05bfd771+FV/9nw8e7uo8GjJ1fPd58NnnrbT34cDh89fzx8Puz3"
    b"n3jPr571t3fJv5Hbp7WdWm6+fwAZI3oKI39YwhShrgY/6d+4oEsCALKtTuwN7PAB+jaZTYnOYCaA0NcJnBfjtp9NgQl9b0wtrgx0"
    b"AGYkHXSCdl0PWSs1vxTzCf97+SqVqILITML3/kRGVzyrROHqT0Pg2xAYU2iuCZ7YT4jrz0IyDaY+6q7Ct4t8T8NBRs9zh9SJwyjo"
    b"kEtLW9Bo97vIJF3afEdpiU1zxRWa/C/5+8W2u+u5w8uPT7bv18ml1l4zEct1Ew1E3mPH3b3EbpffmzoYTcRSPY22YTkszVZhqVFt"
    b"9pqDRr+z7YD+JUmE4i6F4wVDMmdEOuDlT+hPmUijmvtJy0Qc9PfInOKPBE9MwZQXWO9hoK6gybYsWD1L8/mUshmh88cydSlDqYLu"
    b"hZSy2rlZx7k0KgIhEujRk0IC8YmI1irFAX7oNk/PG6RzfnDQ6HSOzo+pXUyOm28a5HC/u08av8HghLKEcZ4I12CHz1taU88F2I8t"
    b"MHXh0Imol1Hy2krkUDjuO50UpBzVC4lnXRXLaPaFMG1oibh9PDSzxQhk+vDLs6q8JczccNh+SwBPC/ENEAweMvMMiwgwt30pCqR9"
    b"TOebckyautkOnTldQQlJqLe7l90d1GUFVL9Vxf9++klWL+Vr1lLEQvP3LSPVi/2D10fN4+NOIb3sBJuzUf91iWe//rYSMRdB1RUS"
    b"YO5B9J39JBJEhMxEgd4ODktGA+ZdaYgHAcgmcgCm/Cn335IcDYHvqgaYZZaa23bCzaiyvPPQO2q3TkCFp76GQ8Kdo18aaZfHjQzM"
    b"2H9vHsj/I0jIjvGTAYwfe33lRzBEh/M3qYU35kmXznHzjDRPDxu/FYmXpTfwg7Zw+U2sxalYj+4F98tCKtSyjJZeXLt4IeGmN9oL"
    b"7pCV8TsPu1jJBl0xUl9pA0r6mKGbNq5xRKmTMso1tKf+FOK6/5gFfkLCKLgOJtwLtBf5Q3SQjWG14i32aYt9UnwL6vbivgZte5na"
    b"VhCLyL91p14U+0Qapip3x5Z9L3Hh4PSJi5vpoyYc7v/+kTmv7h2l59iPrn3qYoPpBrGLbh4MSjKLGAnRRQztglPTgH+RvWyeypzJ"
    b"vFPoP88kt81T4r5pOAr6d73fY9goQDFpiBrz6255f84if8u7xmCKrX44DUZh4vZHNF6V7TY3220uA+jibU0tvtGQvgZWdNYN21TE"
    b"sCr+gwszdqfrRddxvVLVqWa0ngoIZoCqYOq6PKQmjFAld4OB7GqDAbQeTN7SELk7xgtzPM1b/m0w8IHCW6KoTkHUkCzSIFUbHVNa"
    b"wShbLBIn3kq9ofQu+wpOs2By3aOEmd6RW+5Pdb3RSKGS6wpOTNxCqaPT0RpyaiOeSNacmfSm8ezqd6C5i35fWVaoLdModZe5jJmn"
    b"TrwI17vADDGSxh2HA9x86oW3oQMcA6MkRVx0sOc0StePN66Z55V59vG2ZeGrAhAUGite/Hp5nzn28b+UVkjISlW5tKK3QXmIP3Id"
    b"7OQdx9CI3QbC10emr/4fU7Yn/VvY6dDqcWEroCO0eVLYBkOuRjOM0IKmT50ivIOB9FX4XZNLIEVuwH4KiEP5dEvg0K30JiPtD1+l"
    b"pXGAYr//g2zUgsGGvLNk7DBkjLgRCa9iP8LrihQKvVEkdInIDTSi9xj0L1cRiOobIuwd2GvJLCb5KpD02vXnn39eZlZ4rbG1zsi4"
    b"xWHFWzuOJmYJn+ZFTVjIzRrivlmjyG/WUuz53xj6/B/5JGrD2WjUwzuYzRqbz2Ytn9CmeJl8ST6RX5P4tnBhUVhri8r0BQFVk88L"
    b"kacNa+yqpYDGemc6ZzaMzOemxunKKO3pL5bWbPWs1zSsZb6qDLIoWfXWbLVpS1AWpiMfcDC1y6mh4Ct+0Ltxopmuiu5twkfhM1PO"
    b"Su1uPNJugDLy6DCsxhw/fctjIl9CczwsF0taRtTyWD1EbaSZAXkM3uqEHq4Hxtu4dAQ3HQEXpbQE5EkKnws9gXHSoRZCjwtoASlR"
    b"NGdIG2W0Ki5LyWxklZF310uCBBS7B0lwG7N8ezJ9syZNu7SIz+WtttU0YcREo0Kvknc6X1j4kv/4D5PM5VJBaFAgXY3Wojb/pUxE"
    b"4zra7MBMdEnnLi6NXSyxGa4ZXHIFp3OhMDL7GbOx34PZUs8725qlejdlaoNwWsXWTFX7/wSTtTcFc7i+s71t2qbpRq1lXS5w37BU"
    b"h0oNzmdMbcD7Z5pUUIVvNcR7g3wywPI+vCfuba672w+ad0aX1Mb6NvlfUnH+biCBK+4v1+GDEMfdWXfAzgApCHbVDz/8RGNw6gDo"
    b"njROD+EDcE6FfsTTbafKHVQ/kWmEcV3YmtxvKOgoUiLzQmvsV3jymDmwFA9aT5wyPKjm7pmuayRRyQQYjpt2eUcKxZmdnS3IuyYn"
    b"E2OGe3dH9U5kMCndvpE94lxYNgllIdgh7wSRJq3KO4dGfum7CaGM/Mk1sEIxA3I1WFoWs7w2OP1ZgGaWvZQa+XlGZ2YvBjGZhEka"
    b"ouaQX/7j0XzvruIhpttqSDYsDPLv8bvJBrGtlBwl2jrvnp13nWLwlOM1qPjrPGCmOBIeaoB6ML/fNm85KUMmT5+om7y4UscCw4CY"
    b"Cyxw68B4v6oC0G0FdGAaUTXZB8LOy3ezhhDsZQMy2jaeu4nLbmHDYAvs3tJ792Fb1qBXltmuOTsrGWycpXVHupWc83ZO4UVqavhZ"
    b"NKZl4sTm8LpmkrNrLs7tZix1GAsxPMaugrmtnWToMU2dznVTnphBFheFQGFGiwLVkK+lAAUudf0I2NWLrgnvRiWaCMchG9oS1C7W"
    b"+ddLg1LGGR2zUWkUYUg926Ax6U2TsAeGUBT4bIs47yq19/5dtQ7/B0rOfO1M2ljQHT2PQ5WT5GGhIcrOGnsBptjSqGr0vNfT69TU"
    b"H2/abWQxlOEfSiR428fVxkD2qU/ry+T8zrLKg+RuFcHdJcK6CWn8dnB8fignfKq5N3IUuPFWTdTuZhPX/4NalziT9CZNXYXD8MNk"
    b"FHoDHg+PCS80OUqIdLcE+Q94TzeVpb8+fr77ePtqp//Iu/K8J7tXV/7T3Wf9wY+PnvUf93/c9fzh46fbO493MNr/eW27INo/T1Gm"
    b"yLg5Mm6JbF3XnkrsivoR6vl7anKKfCcMBHApXedROidsKXqzm8DCpOcShJLTZb4ViklYWUhny9QupI/c6asRypplXkyxecWGvgat"
    b"OE6uklG16CazJr0XklMZ9KvR056ybyOolFhG8wPT+/c8WWi4Jyc4woG4wc2Wja9Kc5PNMKe6QCEZxS5fjYaWqgg2AvLiMTykLAsj"
    b"yexviYy/uKItWlCxAEm8vSGr6fPKE9QNfWh6ak1PNasBscSaGqreRBGAlcjCGG7C0eDrMRuSZ+5UsgoSkokn01vlOFtMxJfnvvLT"
    b"K3NKTEdBP0hGd3rtq9wxxCt8CaqpIGmslT0YZ37bnGD2OhVzQtrn6yltBbVUFEK/AENQrHuW0ZYXQEtuonB2fUOCJOYaQzpPKQM1"
    b"X6ZVcIJi1+ge2dfN08NFCYgOPnnlvn4ybIpcvZB5rJfwuAzUh6D6780mbkabeu733Mq6prcmWasakEG2XbFsSHP/OEfgsNkWYKnu"
    b"lsZvZ42DLljiiid9oXseU+xfFt5nRz6zLCXXhuh2rdC7pyPgvPUd6uhIa/1JHiDhmoi6NOrrj0reE9Hm5B5dHhlWjuIREa2rQpTE"
    b"hp8bKe2W1YyZdhX7ebHiRMmvz6yLZm75ufFLvOjaT2zLlX/97NRLp/1NBbSsNHbkk8kRanTkw6rTIFgxjka4gpVuXi396XFcGCic"
    b"N83CcYyhCrZeLOTGES9TybrIMBuGC0YxTAY5TLxoxosIUxcaQVRf/AbZAo7FItXNUTCWPtkKIcrZP4oa86CmuhD+UtTcFAdEB6Nk"
    b"tPTkYVF1OR7G0lgInqqL0TGW5mrNRFs7OQALMaZ/05pukF+2Bv7t1gRmt9QWM4vHf44N9i+3Vb517ucXZF+f+zlXl44tMe8C7Uoa"
    b"9e5lb6FtG231F9GmyS9xH228b2aa52dTJrKw6lVrEqLGvFLhpi3ISiSb4MXO6PmVJJpAkvLijMa9lDn0hYn+Kx375SUZ4y+DIDNc"
    b"OuaLiTcfIsuvVJLJe2n18ssw5VWJL0M0srBoBWHInymEWdza9tjl1cVBa9F96Z2Q6APK3CfpR931k8B+hA3Gkt2yjvmvAl/qnS+I"
    b"O6Rh8wx6FklOf81hyL9ng7CyqLUkvlWJW+zPWbkbJ8Pf5jApcuRITb4UQlwCzcUoC+j/rGjllOYuti9CNYG/7PjYKac1+pJoFdBP"
    b"wWu1FLQjRzdj78aLb0xIsa2KxHv09Nln5iYalC5yS6mUGm0j1gvT2woAFCbBXEiLyNmdDSaiXNhpWQx1/rHjmJOTV7VgpItnY5sE"
    b"/kRzNjY+Mjqt79xvVLUzF/QJYIs/QJvv4wNlE/TRg4qWwEmOTz7Up14cK2xmAwCKTyRod0tCEUlBlb762X6nY+8sV3RU+WxucQpx"
    b"OdKoQi1QVwZqChtUi8SyN6+C8XiWeFej/KEwVJRYOIch2EquD1v+iu1BbyuwW7MlH+D4Nq7m4FuP3SFqRQlSkv57nJFyBzWwR/MC"
    b"VkXMscA8fTegQW/RiopR50tYt6buvlsz3LuJecp1NW15Tg9ebLe+IzVkc+odNY8b9XnVP3KpIYEA7moeYTX8k1a3Ud8mL1qtbq95"
    b"sv+y0YF/vVube/lHtwEvli/EjtKU4zxeylD2JLs2TAPMjGFeaLcIZbytkWFb+V/1UiauyzibFwQxE00tN8Lf08sLslhq+C5YHmTN"
    b"XGFFWasflMVy1ZDJDCtz1rnSmebjUVbOO0r8Z8GK33XrNU5A6r5/HFsyzYunQikKQpIRnzEOKc+9y9eoAYR7NI4vF5a8QI1eJ0We"
    b"AquSkrdQowHZMa254nhKwEaNPw9FC6aDoO3Q5nq4+jLMXS3CC/24YWYnWpATGm08HIVcUFtWieUuGj6UhCKgawAlfJXK2vwbiW/8"
    b"0Yi2RJB4Ytc7Bzvbu6IviEfZ2KKJt2Sreo5SYjka1EpmxkhhBsFSUKIEhAJNk6WUjzFWA/W2HuwQPpzpNRq9L2o/8dRL9WftFRm9"
    b"B5eINPww7yTLkzlzyp6Hpf3xnTa9C31Ksc8DJ/3rAHrf9ZBiYLBEtB9KwZL9bsI4yfrUgrBkNyXxn3feKnhfpuw8ZlfwY8+bhJO7"
    b"ccirBZjXgeroMpBMX/eu4rRWgt6ZC3uNXKDnmQU9S0zd2/MGA3fsxe/39tbRKZv4EeOqeY39yYDt2kl8beghCAERLPKvdRShjwYd"
    b"rdeiEXXnnI5yMEHawTYvHFpqRbnZ0ks6swQAnNyzaEScmySZxntbW+v8R8qa5m5g3oE51k+UjtnPBV0HgXc9gc/aqMIH1n2RKvQF"
    b"GV4NfNBJ17cL3mPJ1GJJAzdUXbR0K61/C32MIrhuFc0WKMajoJz1IEAx6591++MSJeHAmEx7sZzLZeFg5Tw0/4AB6sUnsw0izd6u"
    b"q2VxrXGM6fxLpFZLnczGlMgpFv/OAqGSBbAkFih2XZQKv2QWGNWZ4WzBNEWmO6euOkPwZVYQw5gvX5xEXLqEc1YcjHpD6qZ68woK"
    b"hrcSMBdXAVRU+3xVUuUvcfL/RpwIVeoo/zh/yZPPJ0+KqxOYhAQH2qN3DJpzL63d+d6/0yuN8oJFR3UsWsRawJ+mIA12IQIfNfBc"
    b"jakMw9lk8MMPVXvFbXYJUifx7ApU8sr69ia/+a5glj35gTzSS3jfa7/Q65YiHKQLGEND4UZm7nAblhQ8uyGrFGSkw4WRXCGlItNM"
    b"uPetOoa+alS90lv8bOxvNJANgIztjBCN6aoGiMZ2Rojm9FADSHPDUjBzJ9McmKxhKZhFDiJ1bxZ5YopCxDgXWJKNTBxhaVoSrkzS"
    b"4ikV9Z5XHkbdGWmpP80cubR0lbNI6lolU1u/h3mMJAwsK734Led8Yix6UyfCNW7E0l42EZJ5/zFQNr2nLKxUv6nbXZylYUnqTd1Q"
    b"Rqiww+Ui4Us6H9sjoT7cYAxW86hTz4qi9m+8yTXqVl5y8xMZhAqm/L0SsZXxvZI0DvL7T0wj+f7T97XxoGp65cL4VAbz1eznbi9W"
    b"oZWPS+hTqPQhpABzukGd2SMKUnqxNEvBNPafhpj2+MYgnPjkZ/IzfZtiEAyHsPToPXXDyehu/sJD6+ramlrpaIybKw5HM4vMXtwA"
    b"splAOnrWfoopZBJv1r42k6hQ1lmhPcg0Wp1xtDrz6HMYSIt6XJa0kUpaSau1kz6XpcTP9ayTvL1KvsAgXLdTaPwpIpxKHf3xtlHz"
    b"uIr6vPj1VVl0hiLYqdT5y1T7LKYarfKtiXhnzd5LcN+/MxTFAzj8wOshtdPsfl2XqKi0JYZ+VWfJsYWgokWGtlpcRa/wFBWUuyg9"
    b"XHnFUql4Zx7CYkYa1brS6qw+jM20NI5TXtedP1Bqb5bSU+2K8PyBhCOt+mCtOA8bS0vPajvPpHyVywQpMFvus8+FCSLXNxggR9K6"
    b"K6ScVsWeU5qT5MS00HzKSgVfvbn82hB/1U4thFcQQyf2UMAbNE6LsVfOCz9/kUoH1y0WXsfnaImyWyzOrmSknWRmjafEjQsiihYK"
    b"CizTVZtwYSHNJt6Aj0ZkGkwmYIBhZcKD46YUFgvD9PqjwFzBUlyIgMHCZ+EMxSp5XG7rdYMENNhZKX7jT25ravwJrbAVvvetNW9o"
    b"aMxxkz5xzkJbb70opnAO2K80WkaOhk07demmeKv0478W9Dtqnr5stM/aIJ/1MV833ooNzBCwEb4C2kghxH4/8pMMCHR9sw/6O7Y7"
    b"a5yYgbQbL8HCUDBgP5o6nHe6fDXMJYGyUkBSTEdRXDA0IH0/jQGhz/qpD6PxbyywUcVDf0ftHzOsqbSB/Fz7iKV19/CPTQxG9/ec"
    b"UTD0+3f9EVWLE9+5VyP1hFRBM/O9fxwvyHzQ4y/meyjzNU87XXr8lOA+OURnLvuFY+jlZ4E9RiZMP+ZcKCE0hw3hkAM+pH+ugBHb"
    b"PmbIorMuTdnEtARepuZP2EyzKKJvF81AHkekeXb75C8p+cUYFSxLpnafdl6WYVY9lE1Ouzg/BhWqiziirrI3/+ymVHej2Ui+/1so"
    b"JcN0NGcM5vISe2wkfJ0V2NibzKbIylIlCV6A/Oz8xXHzoNc8e/MEvZp9DEJzXRwSo/eBkYFZ4S834QfXj6IQC62PvT9cjFQkO09J"
    b"Gq7mTYNaMAUZXAuja8lwhH0QRolhuOWnlH1Sd99BOBkG11hv+f3syu8nIzKMwjGv2JeeY0j3JfYcq8sYRh7KhTQxvJ8O6PIBXejz"
    b"6/Pn3vPHjwfPd588eTbwrvznV8Nt/+mP/tXTZzu7zwePH/f9J4P+0x+xRONO7alQovGvjb3oxlaLWnIqL6gDKXzUmvoT4k9v/LEf"
    b"eSOqNb/wYl59HgsekCREZeMvHeOLie7Xjzu9TueVCFkf2dDIDKnd6O43T3vd/fbLRhe77PHAbKEtvSDpCca1KuPLJil0Gp0OBucu"
    b"clIAz7iM1RRgf2u1X6OZzybPZSImHcBEsxD3vPdyR4z5bJAN31UcFLZklmXPDEEc5+sHB0YI+9liMrCzgZWA5k+pcJcTfSbyi1eb"
    b"tgmKB+WR8s4nwPNdzswonUrXjjVXtJaG+Dyps63jNxjgzq9rDve7+9IrHFb5XuCGLx5CRbrsCOY5LFgFl0Jkjp36Q9xAzBmXlThZ"
    b"NBYto9AgiOoLVfbOapYIM5HLmcioyb7hLFw0Q8AUS6QWWxAbs3ILa4teXaVVGeQrH+M9VKk7KNv9Ey3koKyATQRm72cXLoZYp0Ak"
    b"2xa77YZd3zHVKrANyq94jGOzaNJ1I5GK05TocbC312ZSNatYmJVNHwTAJixSw49iprIDsIKXHJQMJ5UGct2CCxYdZhUlvGTGjrt7"
    b"iXUzLr9XKmaYAYi3RHNKbhTGAakpsIUDzXklz0CbPCbP1E6NCVzRk9eFeMwJADAD0oMXrYjZ+ECKIJB3i6UKgHRHUjQnS/8sNbNu"
    b"TNc09tEDMGxrIAOgMSHtRu/gvN3GHFIeCJ5rr6Y4h8Ki4lmVyEzcK69UCVFmFv1CCzhT3w5TowGU2C71uYxqidua/KQU9JUUdcLv"
    b"cvBVueKhwaSA7oDpSscFYebHfV8dewFGwf+OWwevWV2QupMPa31cUuvfOmu0WbogMlgOQc8CUnsulgBoWyrYMRGs7DicXIcuqOYR"
    b"VYPdUQjMJi9YMY20eER24JxP4tkU7Qf6Rgc9cwSSEFRdQbezsmypt1sVXGgIovwYBU3l5bqcqhFJCmF0G8BRUK+gU4uAAUdw04XD"
    b"YUCvXgI0q1ihyWswW1gRSDoHtmr8vUR8Ig8JJ64IXwX41FNGYWAN9Sasi4KPKyib0Sz6tZlLWolQQUkJamH4/VCvJCAixn4S3cnE"
    b"NUzG3phGNXzoE3dEfs7zqlN19BNJwDgdkA2yQaMZdrYlLVR+mRBOaD4eyDJaNpGPTktTaHG3grAeGoJEme5KNt4lGxiPxWFBQ/43"
    b"e1xWioReS+yxLYKqXG0xw9OUyoIVBacxq5fWoXKAPzHALVuie2pOK2/b9pMZLYJlWp3UZ4t3PDlgjC7J/uEQd0JKCUkw9EOCBTMw"
    b"yLi+8bEWA2Woo2QEpxv7F5YHQSkfxRfblzU63fvCqrsr2ya84kC2Giz0SeQenoKpx8EpWvVZPl6uUbNXIsdBPKZPuyIX52Rx1krF"
    b"WqucgYsVTBSLRonD4upAxs1avDmKn0+6+JFWV1yV7wzLYlxOu72Rl7yh4d8CYy24StaYdGURjEHquVD/BDL+E5Xon3KJ/imX6J8y"
    b"if5JleilmVDVs4pW7aGr/gXWvSAbwLD2WU7k0lOC/t+JKUomYbW8QDeKdUsrkop763cU8qdHOL9HVdhvVH2v71ibG10dRcG4xSG5"
    b"OQ75QYNiiyNSEKM7P1K3CKMN1d9BtVibepHKcsQMrPnvxM5M+IIBjzVj3s0pGvMr87fsZcb+syfU2F94cyiSOvVrkCBOl45uiw9R"
    b"gOreKneHfcPLS7LQnARbKcW5cJPvZYoSfVEtExUEWqUG6ICEHybKQj18+vNltZJOhMlEa8Uaoa6azlEOx94kGPpx8oU0xCdfU0PM"
    b"awCA3gWLN/5Ck376z6QWZ4qoobncMtWR+TUA4cX7nXzELUld1oKKLeqzSy/qAGL90dhWkn8aDuIeqtRzdHdst4iePqIFSOr6zFMV"
    b"/gup5AM/xogt42G/3EG/zM58CJsaDsacGYwHY1X9gXq7+UrM84yndky2BoBpZpIz+0WGBsrB5SqNPs4f2mMm6XMm+eMlHAcRG+OT"
    b"ItQujHyazUrfxEjbF7+eUUuvTF76k9QzA51rsBIeDTO8zn8vBrTE2LMpPS/bi/fEXOK7Jfp5t14wwlKOpr7l3/goRSb2MEwmIWkV"
    b"Rf53Ew0rNVA/xnH2PEZ17rTyHt5oZFLzcyoOgLmRhl0QJbAU4ykCx2nNWS9WlhpvK9uzyQSknO3BlMpF2gUmOaD5M/HF5X8K74Vg"
    b"wDSDhLTjz4MIT7h0MYpFeB6kWvTglDQcW9MO/bevjJo9JJO104bQwFer5lS77BhxbHyhKGnUHCt8n8jGHrbmqQIm2oTpb/ZeqQYj"
    b"9kp/M4uTC6O+yvgNX4Exfk7XfD7XVS0QiolaOKiB0Ib2lwS2/HrMoRpBVoTPGZ/8QrZtnCg2t+xDfE8ImR7xo7dZZlAAzGJLVpiP"
    b"r3kIY/iTQYyxgxXnV4f8QNZT8lerYIQs0T9lhGrV2Nn0q6Fp0RYx6izZVT17wiAYxEb1BXdPZGBssqh4tXP1XL5eBWcvxduF3G3t"
    b"kxN7a4s4YMjGKLfN1EVZOJsE/wCe/ER+D4NJxdk0NtXoO08dM7sPcpMTle3StnYm9tY/amLvHm3v/fbJsyekf4P5gkKblLfvNzN+"
    b"g8866+25E7CWNSeFwT6XJLxqYq9MpV/d/TCMdxuEs7iHg/kRXsFbajEUdsve+ykM4yhOtf6uKNfajKcJzpyOGaZSXxu+yoE9vUtu"
    b"wslj4iIVWQwnJnpuiVTD294aE3F6OrFB1cfAKW1upr7mmTiw8TbO3ooCLRjTIFPEAfg63iSRv4mVC6ZRiHGj8Pc7+AORFXnVHxIa"
    b"lBT5FWqDVff0CLFJyA20PYMIiLwAdMHOXQzCsgE7o+IEkxsfnWYDLOTwnsQTbxrfAIjcGSjJErzQ2iRZOfBNpN3AR5RDuiibaTn1"
    b"Os6gBuL99mJn71KJNBwlrE4Dny2+1KceGxcON86cTeKAfYb/YxG2Y29Kf2MWO7vIHwfXwkW+s6lO3XEnjoS244YIhPLA5Sbpe1Na"
    b"aoYFWNZRj91kKfz07+IK0GWqU8rVMEk7rrAZwdkwgO5iUzxqNlnwWJ32u3DS0wcHZb+wf0kLxCjMPr8PJgPnkmrXLMHkBKZPFW/2"
    b"3ZsGb/wI30TkrW53JIKl0HDgC4cme7N2RetXDIAVgqdQsn+aeuDMLhyWxcbGpHHHvmNvzLYNaz0UokM+KmyGoSV2KHlYR5CuXUGg"
    b"SQHq2fshDAr7t6l95NM3L+kRWImci333fzz3z213t9bbcy9/AFZjyzdDhKplIOR+j6wzVilABDJ6S4Dw4MUCKsGEVGChKdSB6yWu"
    b"Pw37N8js7MGVwYyvTYzZgoNY3yzpnmHtUWSOciBDf9JHvsl9Co4mhUrNiS4xIHypaaJpdzghK3kr8jPZ3d5+vrO7++jpk+dPtnd3"
    b"t03rmHWyTfeSWYw/bs/pri8h4lDX9Ht1QHG9oIdLSmAkhsTiGNgFZX8N/6hUqzYWrYFgrOQXrhmmdIpwUEv8MQAhFMY1TEeoMDEO"
    b"/2r1/tZunR6/BdWR/uug3djvpv9o/HZwvEm2w2fyWqHlgQ2GAwprOAC2+ABjglnG5KfKD1RWDmbjKZVpm7yVSnb2a204msU3Fe0j"
    b"DBffTfqVtBXmfIQVaWXO3hqrEVBJ/B7LWbjTuakv6WWYHhofw3Ew9up6PSUeDH/7SHmSoahWDXony8J9LIU8JuSXsnNIw/R5xmJy"
    b"h6H2oIo0WkdipBYdv3fLhEp9XUJLaGdIZ6gXhjYb+gqRuEWxxiIZDQkudWPBYZ1ias5I3abVW8f7Pbzq5Y8O10slrBRBkPM/+NMO"
    b"6Z3jUqMVw5DHw83X48Kih5AXHq0IgjzW0Gf9HzBYIQh5tMhHxWG5Ycx9ldlY0qbq1lcw1qRkNcy6l5jfyOtKMkndnAphjfTMuikP"
    b"SErpMIanI83vkYnYGutTFbxAlS6Oud7U/Ce1CnOfLA9MSfQqqni8EHDx3SlpBPGpHVZRFCQmHId1ni9ObX93EPZjGoEkytv88Usx"
    b"Bl+SyUua4Og5yJJ7LLWQsxfAaGPAfBAOh5xi8m8iIFxh3VfFPVvZrUCcROn1Aklgj1Wcv0vBKk61umHwA8p2en6ezaYA0PfGLjew"
    b"dJ+V4rH6aEqFGpINw1SzVyNLuScMYAxviZbyVljAKYudwdRIqpQGJL88TB0orN90wKxiSs/0hKF5Efj6KQsAV/OpbBmkizwmWuIZ"
    b"0axMF01GXihN8DPkiqLHiOcJn7eP5+RuCq88aUDaDZhP46BbAoz06pMG6LC5//K01emWwkh5BUoC1ungQtH0nhOab8/0GjA22GLY"
    b"s01LvQ2hPTpT/LKUXfTRDM/5fCCkJsrZn6O5KWf2sU2e3mxc7lkyPp+hvDymj61W1GN8WKpwXAkEJMep/DSQ+Vkew9y5t8/s7L5C"
    b"rzZ9ykfzwZfNFiyXL1giY3BekdDiwsDQG28XmOWmHWBYxG4Q+Hk6MMlIxdeHG+0x8fihSdODeBv0Ja8ZwyQLH18yYbL8y2yFS729"
    b"VhjIqHEyj+QpoIYa2qM/PkXmE8WQ+VpInmzpdTplBMKQUDwhsY5bn0aCchIaTvKVpZo+ONlUI8lD80iXyyRdQS7pktmkjMqcir00"
    b"gbKXBYRhiVdQInx8GxR9R3jPk2kQjs41Gc/QR0iZD5/rajn3cJ0IFSFmIVrzf1OdL6MlLwjP1Dw1DVsw4BY70gzWnbq64uvojdM3"
    b"jl5DLtP0WHWS9IV7NI0EA5HwWuf0OiTVBx9ekujzFAuBM2gD5feGotyssjbOyir2HIAF0TxEjFil2JKIGYtxCMa3CqX8U8+FVX9y"
    b"RBSAy9Uh4duzzrTkL6NOar0+lshxErIOzGfxUlEE94aTOV0SJS5Aki+LPnuB5bParePyHV6+OmiXf/zwQQ9ptBtv9o9xAyCpYD/R"
    b"Ssx4tU6XwSlRRgD36AT2PWPJ9LjJ4iyiTMSpwm+f3flQcU/LZWQ3iVTOyZWL00896dPntnvxTub8sCFVIkq7aDWGFiwB1A8jODIj"
    b"bxIP/Uh76mGuR4pdaoBwm5BtS0jGovWmM98FMr/LD2A3RZEKKkMUxlJhH8ap2Z06Bgj8VM37ytVTdvCPR/ZYEPY/tJpmSTCiESAi"
    b"5UB5ArEhN6IR4z2sWdPDvYGcSFlSdfo5qSutdwW2HProNomj75usFXISb9mju2Z6J90lwqE6G/k6Oux3hhCiVsE/qsosaNQEEM//"
    b"A3BnPSrsf/oQNc6Ukq8s49DvxRAT603gvX6KPKzw2AJBYGk4Tb0MU+oODWc9BZAVsvqOuMfy72ZrecZe2cvcvVnYI3zYEAEoPtTs"
    b"ziG/4JfgsJtsQxTAZRHU9IpagVoxjEZ+IDvV6opC0tLTwfsTVS5QkCa0EBnwFq2hikRw/T/onc9tkNwZn8TRJGOmEs8mNCIpGit5"
    b"B4otll5hMTe2wSf/gBIsCmVqLIBGIcWcIiwadeX4mXnAJN1DBSWG0MwDlNmOdILnstE4K3wBDC+TKRZgcnbY01gG1lcCaErjc9Q4"
    b"PWievuy9bJzydasLdcqEPVAwpQZYfj20hI57cNQfvDKslSF+ZB6KFg4vU+SGc+WanqVscNdRd47Mxw678qEj9ehIVBGqp5tDuOci"
    b"zvfMNbMI6O8dgvdJ/aSXCVFq93PRI0qSdYN4cewj2razeTOrrXlckHXz0+/synBFO17a77DN2sBPJ63Tl61e/kXto+xwvVfWwCl6"
    b"nMWu8FAgjKs7DTAnDjvGYaQWVmdRyQ1fvCGNTLDCDcMJ76bjlNs5Sx9dFyxPXmUm27ZTsSu9/4pHgl1o2nCVimG1+cltH0qN1FYe"
    b"YzKgUGonltu3LLreum3/+XfkA1ibr005cckbm5eR9t+ec8n0RZw4K9LzVU+PYa8uzTqL189btnreorXzlq2cpysVEv0XWKnFt9iy"
    b"G+zhJ1nJDfrQk0f1VjUmWOskRAXGxQy2q1EAjZEp2H2FwNKS50pkdR9hSG57Hv3AsoaxlPggukM76Rtx2Quu+kJvtABQ8okv5BKT"
    b"5VXBharm/1389nY1ZbUWzzqTOcBwmbsKb/hyznBTDbovV2bz/oELi/MoDK869MdhwqOrxPcA0uWkW5leNk3Z+1PwV6zJYdqu1sL+"
    b"38mF/Rdi/7Q8BnrqStZUEUrB8AQjvEynVWfUl7D6RGhBXNU5jLHqmo+VvkkC4t2wJfkn/SyjH9qt40Yd/2aBid97B6Cgv2zg2yJH"
    b"zfYJsys6jS79uGcfcg//r4+LNxB4a5pk/NLxk/PYj9rhyK/9Hov5CfbqNkvXtnFHRChsQ6lADxlDXRvJ28ZsChhKQyV1V6zNy8gu"
    b"yMXmIaNfqNCFXhbCgFI+MG7LNS25Wg/NYRUFWG0LlMCkdrGtlpZBMUpo4nTFyXKgQww5YbiRE0oMWGctV9tXZlmUt20gHeM2/c0U"
    b"L9FyP0CHjxN8XCpqDmgRUPu2+snYLYZegytMQ+oEoH5Mrg9fVHhmYQ9ZzqnWaDO9N00K87E/bVAbgt4qI/yxh8pK6+p3WLvmoMKw"
    b"rN5vGhrtbGIkKojUHVFoV2tJuB9F3l2l+pN8qFf46DVOye/qvHQg/x0rsiJA+oEKCEe9DUtuovADmfgfSIMReZ7Uphim7ww4Ekb3"
    b"aqRI5b86rdMaC6eGc6EiD00Pi8CHeaNDTF4PXKUDHG6PyHOUm7HVUmYrYlSVEJS5RuK5yPtgc3OVOj6c9UzgOPohwHk6vqEPJwZ4"
    b"VrmTMAJwLl7iZr0Zz1s3Ro5gQp8MmgC12cvrGfbyjQUr+CJLuizMPaQsqVfRqaWEsdYIqWXkMRfGYUyX8Zz2HV+yxxolMWg+NMfv"
    b"wsEeeJuXQcZ/pIhIecXCY/Po3NGfkcyT8Oql72X520UKz2M7Xw0jQR09jLzoDujwkY1zX0vGU3Hdk8ibko1ozC6/sh7OBmn81uwq"
    b"BOp3tMc1sZwIV3yK1Hb1CNOri7L0N35RsEeconne7hhyaFmH/UwfgyOpCTt2nWGnt883dcZGeiNhd+espDdju1vd07pOq3KEuOJS"
    b"VhDo0+TZ9jaxNBjfSl/wERdKXo2yLiOjpgfDeZ+Gm4URHOMmMYrOjfghqq/6+F3+zvceeSi/83cuZZbXdO0F3B+SDuocNo4baPYy"
    b"hj5uvmn0Dtv7R909K4/vldWQM5/6/nn3FWty0Do/Vd9F3z8+bv0N308Hdfh1E30kiMXmWRvNq+7BK6nxyf5vbNxGr3PcPOvUH5UI"
    b"2kmfClWXltJdff4jc4HA0TJLecflb/nkHhCqEUq+D/zZxhE03K4ogm+BwDt7ekqpnOP/ar3oYdAkgEldTiCEMGndkVJZYOV7neb/"
    b"NPCj/E00evG6pNFrnB612geNQynJRXfzyP6Wv7Wb3Ua70/vv82ajs2jnNPKTXn7A4NwVYoCBYaGqD1MBlrv3qDsun432dqLSkt+6"
    b"LDeqLfh6TqaQ6bm3z5B4pIbTsVDguek+8xMoVcDw77NWp9nNnsx8aAYllY1Wn4qcB8+2iU0EtFlgd5oMS6s4M28KD91mzyry4CGb"
    b"I1Q6WLzRB+8urlQx4oZNVHOZ4nz7ISvotRHPaECw9aihSfGwlQ9aJ5JblBqdKaAv8GbiN+FTTQPxw6jH6JRH66PHTAs7XDIxaQUe"
    b"u9VW8XpYmE/JS8aHXDOu5k5/gevKBwWvgOX9z7a8X2JhjE9XsaDcOVVOl8k3W9VTIIvvMi5F5qahLX5zYX31ZuV3DiXfvlmdCJKI"
    b"robFikLWKGXhMHTWxaOMh6Kww88xv0RBy+c+aAZGhplziCxYA5Kj+ZcAyVb+r0Vf4FBMw7q+qcPxC1BQk7flwdtrTYCxkLjMPFNf"
    b"FrO/hm5Qp0W93PgUem686iag1L6i2YyZtQunhWYfGDGofnN1MbyhfO3/Vw0Lew2Lf7GiEJqBzcIsfeZrG1AfmouUIJrnymw9SxsT"
    b"d1z8PphO/UFBWAKWD9JLehQ4ZsUsaFWHY/pbI8U/g0LRI4NgQIvmsrQQn+U4g3o3hqb5W/Gq+qYJx3t13c6nmOjE3dqxNwmS4E++"
    b"esULtya4++M9fLYSX2LYmlF4broiv1497z999sx7/vyR/+zq2dXw6umP/mB70H/0dPvp40fek+e7g+fPf9wdkn8jt89q27U8KhML"
    b"OIpCiOFrXGDXlF+o/ugl6CtIlOp2HgyyjO8zGLqT0MV8ttilr93vkQD2diTXZEywQAOcfANYsj3yeNuy+kDUhJfb4I8WpXsg/nbX"
    b"PkPxoasvG2wLlUkiC50eRPRfGspt8bsYFAlYy91LKhsft+/NeXAbm6IHqkq9VorHajUsYvAcMn2FOoJQ+DMPYlr3Yer133vXGLvB"
    b"boEkX6J3BZZhT/MyqpqKIBxFFQMBgjyu0Nn28WQbwQCVarVAdanPV11W4bz8st7BBzvtVmUt/xWqvBLH3De5jJ97EbgTThM3vJCK"
    b"ubgAmU1AnMVU2sBxlYRcTV1UlrA9L1cnKGEVVUqYRbIDcJ5w+c5o/zzkUvz/D4foeRL/whslz6jTaxGBJZxGRdNzB/43spsb1pJD"
    b"AMYeCAIdDo6bNPaBHXG3XhRTOAfs1x78/VA3ULET8/G+VfrxXwv6HTVPXzbaZ+0m2qPqmK8bb8UGZgjYCMu4NFIIsd8H9SUDAl3f"
    b"4MmN7c4aJ2Yg7cbL7Eo3w4D9qF7lHzcWqpPEyOUiuaT6RmYbm4Z7KWOUt6sjyicuL73LFRRgLx1ksQtqFGLM7vTGHwO3jnCRyAsv"
    b"Zu8mUjm2qCwuLIFlFNv9oNcfBQspaH/xbwn+XWmpr8KCWOmj3Xnv+UEP7GEbdMgIYwID85goXS6Ow1t8rzsc0QqFyKjANfh0KX1t"
    b"pdiypVhgiGU0VGrl4DLcANs5a/8HDsUWAjs8AQA=",
    validate=True,
))
cancelled_historical = historical_response(cancelled_path, cancelled_source)
assert cancelled_historical["sha"] == "c3c9332f4b23b55de6c32ae2183b89478f97884f"
expired_cancelled_source = gzip.decompress(base64.b64decode(
    "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"
))
expired_cancelled_historical = historical_response(cancelled_path, expired_cancelled_source)
assert len(expired_cancelled_source) == 111190
assert expired_cancelled_historical["sha"] == "472896760221c61ef517d656b0ef102d7344f2c9"
cancelled_run = {
    "id": 90, "workflow_id": 4, "path": cancelled_path,
    "head_sha": source, "head_branch": "master", "event": "workflow_dispatch",
    "head_repository": {"full_name": "example/repo"}, "run_attempt": 1,
    "status": "completed", "conclusion": "cancelled",
    "display_title": f"oci-live-data apply-slip-index {source}",
    "html_url": "https://github.com/example/repo/actions/runs/90",
    "created_at": "2026-10-07T09:05:00Z", "run_started_at": "2026-10-07T09:05:00Z",
    "updated_at": "2026-10-07T09:20:03Z",
}
cancelled_endpoint = "repos/example/repo/actions/runs/90"
cancelled_workflow_endpoint = "repos/example/repo/actions/workflows/oci-live-data-rollout.yml"
cancelled_source_endpoint = f"repos/example/repo/contents/{cancelled_path}?ref={source}"
cancelled_job_endpoint = cancelled_endpoint + "/attempts/1/jobs?per_page=100"
cancelled_artifact_endpoint = cancelled_endpoint + "/artifacts?per_page=100"
cancelled_job = {
    "id": 901, "run_id": 90, "run_attempt": 1, "head_sha": source,
    "head_branch": "master", "name": "rollout", "status": "completed",
    "conclusion": "cancelled", "steps": [], "runner_id": 0, "runner_name": "",
    "created_at": "2026-10-07T09:06:00Z", "started_at": "2026-10-07T09:06:00Z",
    "completed_at": "2026-10-07T09:20:00Z",
}
cancelled_original_api = {
    cancelled_endpoint: cancelled_run,
    cancelled_endpoint + "/attempts/1": {**cancelled_run, "updated_at": "2026-10-07T09:20:01Z"},
    cancelled_workflow_endpoint: {"id": 4, "path": cancelled_path, "state": "active"},
    cancelled_endpoint + "/pending_deployments": [],
    cancelled_endpoint + "/approvals": [],
    cancelled_source_endpoint: cancelled_historical,
}
cancelled_original_pages = {
    cancelled_job_endpoint: [{"total_count": 1, "jobs": [cancelled_job]}],
    cancelled_artifact_endpoint: [{"total_count": 0, "artifacts": []}],
}
cancelled_rows = [copy.deepcopy(cancelled_run)]
cancelled_responses = copy.deepcopy(cancelled_original_api)
cancelled_pages = copy.deepcopy(cancelled_original_pages)
cancelled_reads = {}
cancelled_failure = cancelled_drift = ""
def cancelled_api(path):
    if path == cancelled_failure:
        raise SystemExit("fixture authenticated API failure")
    if path not in cancelled_responses:
        return history_api(path)
    cancelled_reads[path] = cancelled_reads.get(path, 0) + 1
    response = copy.deepcopy(cancelled_responses[path])
    if path == cancelled_drift and cancelled_reads[path] % 2 == 0:
        response["state"] = "disabled_manually"
    return response
def cancelled_page_api(path):
    if path == cancelled_failure:
        raise SystemExit("fixture authenticated pagination failure")
    if path in cancelled_pages:
        cancelled_reads[path] = cancelled_reads.get(path, 0) + 1
        response = copy.deepcopy(cancelled_pages[path])
        if path == cancelled_drift and cancelled_reads[path] % 2 == 0:
            response[0]["jobs"][0]["id"] += 1
        return response
    response = copy.deepcopy(history_pages(path))
    if "/workflows/oci-live-data-rollout.yml/runs?" in path:
        response[0]["workflow_runs"].extend(copy.deepcopy(cancelled_rows))
        response[0]["total_count"] += len(cancelled_rows)
    return response
def cancelled_history(successor_id="78"):
    return m.held_handoff_history("example/repo", history_held, source, successor_id)
def reset_cancelled():
    global cancelled_rows, cancelled_responses, cancelled_pages, cancelled_failure, cancelled_drift
    cancelled_rows = [copy.deepcopy(cancelled_run)]
    cancelled_responses = copy.deepcopy(cancelled_original_api)
    cancelled_pages = copy.deepcopy(cancelled_original_pages)
    cancelled_failure = cancelled_drift = ""
    cancelled_reads.clear()
with tempfile.TemporaryDirectory(dir=Path(sys.argv[2]) / "infra/oci/tests") as isolated_home, \
     patch.dict(os.environ, {"HOME": isolated_home, "COPILOT_CLI_AUTHORITY_DIR": isolated_home + "/absent"}), \
     patch.object(m, "gh_api", side_effect=cancelled_api), \
     patch.object(m, "gh_api_pages", side_effect=cancelled_page_api), \
     patch.object(m, "jobs_for_run", side_effect=lambda repo, run, label:
                  [cutoff_job] if run == "78" else native_jobs_inventory(repo, run, label)), \
     patch.object(m, "artifact_inventory", native_artifacts_inventory):
    cancelled_proof = cancelled_history()
    assert cancelled_proof["workflow_counts"]["oci-live-data-rollout.yml"] == proof["workflow_counts"]["oci-live-data-rollout.yml"] + 1
    assert all(cancelled_reads[path] == (3 if path == cancelled_workflow_endpoint else 2)
               for path in (*cancelled_original_api, *cancelled_original_pages))
    assert list(Path(isolated_home).iterdir()) == []  # no private retirement/authority record
    for state, conclusion in (("waiting", None), ("in_progress", None), ("completed", "success")):
        successor.update(status=state, conclusion=conclusion)
        cutoff_job["status"] = "in_progress" if state == "in_progress" else "completed"
        for mutation in (
            "none", "missing-self", "wrong-self", "unknown-source", "altered-bytes",
            "runner", "executed", "pending", "approved", "artifact", "drift",
            "ancestry", "other-waiting", "other-running", "other-executed",
        ):
            reset_cancelled()
            cancelled_responses[cancelled_source_endpoint] = copy.deepcopy(expired_cancelled_historical)
            selected_self = "78"
            if mutation == "missing-self":
                selected_self = ""
            elif mutation == "wrong-self":
                selected_self = "99"
            elif mutation == "unknown-source":
                cancelled_responses[cancelled_source_endpoint]["sha"] = "0" * 40
            elif mutation == "altered-bytes":
                changed = historical_response(cancelled_path, expired_cancelled_source.replace(
                    shared_authority.CURRENT_MASTER_GUARD_LINES[0].encode(), b"# guard removed"))
                changed["sha"] = expired_cancelled_historical["sha"]
                cancelled_responses[cancelled_source_endpoint] = changed
            elif mutation in ("runner", "executed"):
                job = cancelled_pages[cancelled_job_endpoint][0]["jobs"][0]
                if mutation == "runner":
                    job["runner_id"] = 1
                else:
                    job["steps"] = [{"name": "Set up job", "conclusion": "success"}]
            elif mutation in ("pending", "approved"):
                suffix = "/pending_deployments" if mutation == "pending" else "/approvals"
                cancelled_responses[cancelled_endpoint + suffix] = [{"state": "approved"}]
            elif mutation == "artifact":
                cancelled_pages[cancelled_artifact_endpoint] = [
                    {"total_count": 1, "artifacts": [{"id": 991}]}]
            elif mutation == "drift":
                cancelled_drift = cancelled_workflow_endpoint
            elif mutation == "ancestry":
                ancestor = "a" * 40
                for run in (cancelled_rows[0], cancelled_responses[cancelled_endpoint],
                            cancelled_responses[cancelled_endpoint + "/attempts/1"]):
                    run.update(head_sha=ancestor, display_title=f"oci-live-data apply-slip-index {ancestor}")
                cancelled_pages[cancelled_job_endpoint][0]["jobs"][0]["head_sha"] = ancestor
                cancelled_responses[f"repos/example/repo/contents/{cancelled_path}?ref={ancestor}"] = (
                    cancelled_responses.pop(cancelled_source_endpoint))
                endpoint = f"repos/example/repo/compare/{ancestor}...{source}?per_page=100"
                cancelled_pages[endpoint] = copy.deepcopy(original_ghost_compares[endpoint])
                for page in cancelled_pages[endpoint]:
                    page["status"] = "diverged"
            elif mutation.startswith("other-"):
                cancelled_rows.append({
                    **cancelled_run, "id": 91,
                    "status": "waiting" if mutation == "other-waiting" else (
                        "in_progress" if mutation == "other-running" else "completed"),
                    "conclusion": "success" if mutation == "other-executed" else None,
                })
            if mutation == "none":
                result = cancelled_history(selected_self)
                assert result["workflow_counts"] == cancelled_proof["workflow_counts"]
                assert bool(result["cutoff_at"]) == (state != "waiting")
                assert result["successor_run_id"] == "78"
                assert all(cancelled_reads[path] == (3 if path == cancelled_workflow_endpoint else 2)
                           for path in (*cancelled_original_api, *cancelled_original_pages))
                assert list(Path(isolated_home).iterdir()) == []
            else:
                reject(lambda: cancelled_history(selected_self))
    successor.update(status="completed", conclusion="success")
    cutoff_job["status"] = "completed"
    reset_cancelled()
    for state in ("active", "disabled_manually"):
        for runner_id, runner_name in ((0, ""), (None, None)):
            reset_cancelled()
            cancelled_responses[cancelled_workflow_endpoint]["state"] = state
            job = cancelled_pages[cancelled_job_endpoint][0]["jobs"][0]
            job.update(runner_id=runner_id, runner_name=runner_name)
            assert cancelled_history() == cancelled_proof
    reset_cancelled()
    for state, conclusion in (("waiting", None), ("in_progress", None), ("completed", "success")):
        successor.update(status=state, conclusion=conclusion)
        cutoff_job["status"] = "in_progress" if state == "in_progress" else "completed"
        result = cancelled_history()
        assert result["workflow_counts"] == cancelled_proof["workflow_counts"]
        assert bool(result["cutoff_at"]) == (state != "waiting")
    successor.update(status="completed", conclusion="success")
    cutoff_job["status"] = "completed"
    for endpoint, fields in (
        (cancelled_endpoint, tuple(cancelled_run)),
        (cancelled_endpoint + "/attempts/1", tuple(cancelled_run)),
        (cancelled_workflow_endpoint, ("id", "path", "state")),
    ):
        for field in fields:
            reset_cancelled()
            del cancelled_responses[endpoint][field]
            reject(cancelled_history)
    for field in cancelled_job:
        reset_cancelled()
        del cancelled_pages[cancelled_job_endpoint][0]["jobs"][0][field]
        reject(cancelled_history)
    for field, bad in (
        ("id", 0), ("id", True), ("run_id", 91), ("run_attempt", 2), ("run_attempt", True),
        ("head_sha", "e" * 40), ("head_branch", "other"), ("name", "other"),
        ("status", "queued"), ("conclusion", "success"),
        ("steps", [{"name": "Set up job", "conclusion": "skipped"}]), ("steps", None),
        ("runner_id", 1), ("runner_id", False), ("runner_id", "0"),
        ("runner_name", "assigned-runner"), ("runner_name", False),
        ("created_at", "2026-10-07T09:04:00Z"),
        ("started_at", "2026-10-07T09:21:00Z"),
        ("completed_at", "2026-10-07T09:20:02Z"),
    ):
        reset_cancelled()
        cancelled_pages[cancelled_job_endpoint][0]["jobs"][0][field] = bad
        reject(cancelled_history)
    for field, bad in (
        ("id", 91), ("workflow_id", 99), ("path", ".github/workflows/oci-production-deploy.yml"),
        ("head_sha", "e" * 40), ("head_branch", "other"), ("run_attempt", 2),
        ("run_attempt", True), ("event", "push"), ("status", "waiting"),
        ("conclusion", "failure"), ("display_title", f"oci-live-data dry-run {source}"),
        ("head_repository", {"full_name": "foreign/repo"}),
        ("created_at", "2026-10-07T09:06:00Z"),
        ("run_started_at", "2026-10-07T09:04:00Z"),
        ("updated_at", "2026-10-07T09:19:00Z"),
    ):
        for endpoint in (cancelled_endpoint, cancelled_endpoint + "/attempts/1"):
            reset_cancelled()
            cancelled_responses[endpoint][field] = bad
            reject(cancelled_history)
    for field, bad in (("run_attempt", 2), ("display_title", "unbound"), ("updated_at", "2026-10-07T09:21:00Z")):
        reset_cancelled()
        cancelled_rows[0][field] = bad
        reject(cancelled_history)
    for endpoint in (cancelled_job_endpoint, cancelled_artifact_endpoint):
        key = "jobs" if endpoint == cancelled_job_endpoint else "artifacts"
        for mutation in ("missing-list", "missing-total", "bad-total", "truncated", "extra", "duplicate-page"):
            reset_cancelled()
            page = cancelled_pages[endpoint][0]
            if mutation == "missing-list": del page[key]
            elif mutation == "missing-total": del page["total_count"]
            elif mutation == "bad-total": page["total_count"] = False
            elif mutation == "truncated": page["total_count"] += 1
            elif mutation == "extra":
                page[key].append(copy.deepcopy(cancelled_job) if key == "jobs" else {"id": 991})
                page["total_count"] += 1
            else:
                page[key] = [copy.deepcopy(cancelled_job) if key == "jobs" else {"id": 991}]
                page["total_count"] = 1
                cancelled_pages[endpoint].append(copy.deepcopy(page))
            reject(cancelled_history)
    for endpoint in (cancelled_endpoint + "/pending_deployments", cancelled_endpoint + "/approvals"):
        for bad in ([{"state": "approved"}], {}, None):
            reset_cancelled()
            cancelled_responses[endpoint] = bad
            reject(cancelled_history)
    for endpoint in (*cancelled_original_api, *cancelled_original_pages):
        reset_cancelled()
        cancelled_failure = endpoint
        reject(cancelled_history)
    for endpoint in (cancelled_workflow_endpoint, cancelled_job_endpoint):
        reset_cancelled()
        cancelled_drift = endpoint
        reject(cancelled_history)
    reset_cancelled()
    cancelled_rows[0]["updated_at"] = "2026-10-07T10:00:01Z"
    for endpoint in (cancelled_endpoint, cancelled_endpoint + "/attempts/1"):
        cancelled_responses[endpoint]["updated_at"] = "2026-10-07T10:00:01Z"
    assert cancelled_history() == cancelled_proof
    reset_cancelled()
    changed_source = historical_response(cancelled_path, (Path(sys.argv[2]) / cancelled_path).read_bytes())
    if changed_source["sha"] != cancelled_historical["sha"]:
        cancelled_responses[cancelled_source_endpoint] = changed_source
        reject(cancelled_history)
    for old_guard, replacement in (
        (b"    if: github.run_attempt == 1", b"    if: true"),
        (b"group: oci-control-plane", b"group: unrelated"),
        (b"name: oci-migration", b"name: unrelated"),
        (shared_authority.CURRENT_MASTER_GUARD_LINES[0].encode(), b"# guard removed"),
        (b"jobs:\n", b"jobs:\n  extra:\n    runs-on: ubuntu-latest\n"),
    ):
        reset_cancelled()
        original_source = base64.b64decode(cancelled_original_api[cancelled_source_endpoint]["content"])
        assert old_guard in original_source
        cancelled_responses[cancelled_source_endpoint] = historical_response(
            cancelled_path, original_source.replace(old_guard, replacement))
        reject(cancelled_history)
    reset_cancelled()
    ancestor = "a" * 40
    for run in (cancelled_rows[0], cancelled_responses[cancelled_endpoint],
                cancelled_responses[cancelled_endpoint + "/attempts/1"]):
        run.update(head_sha=ancestor, display_title=f"oci-live-data apply-slip-index {ancestor}")
    cancelled_pages[cancelled_job_endpoint][0]["jobs"][0]["head_sha"] = ancestor
    cancelled_responses[f"repos/example/repo/contents/{cancelled_path}?ref={ancestor}"] = cancelled_responses.pop(cancelled_source_endpoint)
    compare_endpoint = f"repos/example/repo/compare/{ancestor}...{source}?per_page=100"
    cancelled_pages[compare_endpoint] = copy.deepcopy(original_ghost_compares[compare_endpoint])
    assert cancelled_history() == cancelled_proof
    complete_compare = copy.deepcopy(cancelled_pages[compare_endpoint])
    for mutation in ("truncated", "inconsistent", "duplicate", "wrong-head", "wrong-base",
                     "diverged", "behind", "empty", "malformed", "bool-metadata"):
        pages = copy.deepcopy(complete_compare)
        if mutation == "truncated": pages.pop()
        elif mutation == "inconsistent": pages[1]["total_commits"] += 1
        elif mutation == "duplicate": pages[0]["commits"] = copy.deepcopy(pages[1]["commits"])
        elif mutation == "wrong-head": pages[1]["commits"][0]["sha"] = "e" * 40
        elif mutation == "wrong-base":
            for page in pages: page["base_commit"] = {"sha": "e" * 40}
        elif mutation == "diverged":
            for page in pages: page["status"] = "diverged"
        elif mutation == "behind":
            for page in pages: page["behind_by"] = 1
        elif mutation == "empty": pages.clear()
        elif mutation == "malformed": pages[1]["commits"] = {}
        else: pages[1]["behind_by"] = False
        cancelled_pages[compare_endpoint] = pages
        reject(cancelled_history)
    cancelled_pages[compare_endpoint] = complete_compare
    with patch.object(m.importlib.util, "spec_from_file_location", return_value=None):
        reject(cancelled_history)
    assert cancelled_history() == cancelled_proof
    assert list(Path(isolated_home).iterdir()) == []
print("PASS native cancelled no-execution history: both frozen profiles, coupled authenticated self, two complete collections, isolated HOME and cutoff/source/runner/ancestry/drift negatives")

for raw in (
    b"native log unavailable",
    log().replace(b"  DATA_RUN_ID: 23", b"  DATA_RUN_ID: 99"),
    log().replace(b"DISPATCH_INPUTS:", b"ABSENT_INPUTS:"),
    log().replace(b"  DATA_RUN_ID: 23", b"  DATA_RUN_ID: 23\n2026-10-07T09:09:16Z   DATA_RUN_ID: 23"),
    log().replace(b'"data_run_id": "23",', b'"data_run_id": "23", "data_run_id": "99",'),
):
    m.gh_api_bytes = lambda _, raw=raw: log_archive(raw)
    reject(lambda: m.failed_deploy_native_inputs("example/repo", "77", source, "fixture"))
before = b"original before"
after = b"later after"
def sealed(prefix, payload):
    return {prefix + "/baseline": payload, prefix + "/SHA256SUMS":
        f"{hashlib.sha256(payload).hexdigest()}  baseline\n".encode()}
files = sealed("oci-data-baseline-before", before) | sealed("oci-data-baseline-after", after)
assert m.original_before_baseline(files, "fixture")["baseline"] == before
reject(lambda: m.original_before_baseline(files | sealed("duplicate/oci-data-baseline-before", before), "fixture"))
reject(lambda: m.original_before_baseline(sealed("oci-data-baseline-after", after), "fixture"))
baseline = dict.fromkeys(m.BASELINE_PROVENANCE_KEYS, "fixture")
baseline.update(
    baseline_capture_run_id="23", baseline_capture_run_attempt="1",
    registry_provider="ghcr", registry_host="ghcr.io",
    registry_repository=m.APPLICATION_REPOSITORY, registry_public_anonymous="true",
)
baseline_raw = "".join(f"{key}={value}\n" for key, value in sorted(baseline.items())).encode()
baseline_manifest = f"{hashlib.sha256(baseline_raw).hexdigest()}  baseline-provenance.env\n".encode()
baseline_files = {
    "oci-data-baseline-before/baseline-provenance.env": baseline_raw,
    "oci-data-baseline-before/SHA256SUMS": baseline_manifest,
} | sealed("oci-data-baseline-after", after)
data = dict.fromkeys(m.LIVE_V6_KEYS, "true")
data.update(
    schema_version="live-betting-v6", source_sha=source, build_run_id="21",
    infrastructure_run_id="22", checkpoint_source_sha=source, disk_checkpoint_run_id="24",
    disk_checkpoint_sha256="c" * 64, disk_checkpoint_disposition="NOT_APPLICABLE",
    baseline_sha256=hashlib.sha256(baseline_manifest).hexdigest(),
    baseline_recovery_run_id="0", baseline_recovery_source_sha="none",
    workflow_run_id="23", workflow_run_attempt="1", phase="apply-slip-index",
    status="PASS", completed_at="2026-10-07T08:50:00Z",
)
checkpoint = dict(sourceSha=source, producerRunId="24", ghcrBuildRunId="21",
                  infrastructureRunId="22", contentChecksumSha256="c" * 64,
                  disposition="NOT_APPLICABLE")
m.parse_checkpoint_artifact = lambda *_: checkpoint
m.parse_infrastructure_provenance = lambda *_: ({}, "d" * 64)
m.parse_live_v6_artifact = lambda *_, include_files=False: (
    (data, "b" * 64, {}) if include_files else (data, "b" * 64))
def metadata(repo, run, workflow, *_):
    return {
        "head_sha": source,
        "display_title": f"oci-live-data apply-slip-index {source}" if workflow == "oci-live-data-rollout.yml"
                         else f"oci-deploy {source}",
        "updated_at": "2026-10-07T09:09:17Z" if run == "77" else "2026-10-07T08:50:00Z",
        "created_at": "2026-10-07T09:00:00Z",
    }
m.fixed_run_metadata = metadata
m.exact_artifact = lambda repo, run, name, label: (
    {"id": 1} if (run, name) == ("23", "oci-live-data-baselines-23-1")
    else m.fail("invented failed-deployment baseline"))
m.artifact_files = lambda *_: baseline_files
m.gh_api_bytes = lambda _: log_archive(log())
dispatch = dict(inputs, prerequisite_run_id="23")
def validate_artifacts():
    return m.validate_failed_deploy_artifacts(
        "example/repo", "77", source, None, dispatch, "oke",
        profile, "skipped", "skipped", "skipped", "fixture", pre_runtime=True)
assert validate_artifacts()["baseline_run_id"] == "23"
assert validate_artifacts()["resume_maintenance_mode"] == "pre-runtime-hold"

# Exercise the real failed-deploy call order and native-log parser while the
# existing parsed-artifact fixtures isolate this transport-only correction.
reads_in_order = [
    "repos/example/repo/actions/artifacts/901/zip",
    "repos/example/repo/actions/artifacts/902/zip",
    "repos/example/repo/actions/runs/77/attempts/1/logs",
    "repos/example/repo/actions/artifacts/903/zip",
]
def transported(endpoint, reader):
    def read(*args, **kwargs):
        m.gh_api_bytes(endpoint)
        return reader(*args, **kwargs)
    return read

for failed_index in range(4):
    observed_reads = []
    def transport(argv, **kwargs):
        assert kwargs == {"capture_output": True, "check": False, "timeout": 120}
        assert argv[:2] == ["gh", "api"] and len(argv) == 3
        observed_reads.append(argv[2])
        if argv[2] == reads_in_order[failed_index]:
            return subprocess.CompletedProcess(argv, 1, b"private-body-do-not-emit", b"unproven-private-error")
        return subprocess.CompletedProcess(argv, 0, log_archive(log()) if argv[2].endswith("/logs") else b"fixture archive", b"")
    stdout, stderr = io.StringIO(), io.StringIO()
    with patch.object(m, "gh_api_bytes", native_byte_reader), \
            patch.object(m, "parse_checkpoint_artifact", transported(reads_in_order[0], m.parse_checkpoint_artifact)), \
            patch.object(m, "parse_live_v6_artifact", transported(reads_in_order[1], m.parse_live_v6_artifact)), \
            patch.object(m, "parse_infrastructure_provenance", transported(reads_in_order[3], m.parse_infrastructure_provenance)), \
            patch.object(m.subprocess, "run", side_effect=transport), \
            patch.object(m.time, "sleep") as sleep, \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        print("preceding binding status=OK\n" * 4, end="")
        try:
            validate_artifacts()
        except SystemExit as error:
            assert error.code == 1
        else:
            raise AssertionError("failed-deploy byte-read fault was accepted")
    kind = "attempt-log-zip" if failed_index == 2 else "artifact-zip"
    assert stderr.getvalue() == (
        "upstream binding rejected: artifact download classification=unknown"
        f" attempt=1/3 disposition=not-retryable request_kind={kind} diagnostic=unclassified\n"
    )
    assert stdout.getvalue() == "preceding binding status=OK\n" * 4
    assert observed_reads == reads_in_order[:failed_index + 1]
    sleep.assert_not_called()
print("PASS bounded diagnostics before, at, and after the failed-deploy native-log read")

for key, bad in (
    ("data_run_id", "99"), ("approved_sha", "9" * 40),
    ("build_run_id", "99"), ("infrastructure_run_id", "99"),
    ("disk_checkpoint_run_id", "99"), ("checkpoint_source_sha", "9" * 40),
    ("baseline_recovery_run_id", "99"), ("baseline_recovery_source_sha", "9" * 40),
):
    changed = dict(inputs, **{key: bad})
    m.gh_api_bytes = lambda _, changed=changed: log_archive(log(changed))
    reject(validate_artifacts)
m.gh_api_bytes = lambda _: log_archive(log())
data["baseline_sha256"] = "0" * 64
reject(validate_artifacts)
data["baseline_sha256"] = hashlib.sha256(baseline_manifest).hexdigest()

# Two resumptions must retain the root capture while each failed native
# dispatch binds its actual immediate predecessor, not that root.
resume_images = b"checksum-bound candidate image fixture\n"
def resumed(run, failed):
    evidence = dict(data, workflow_run_id=run)
    authority = {
        "schema_version": "live-betting-data-resume-v2",
        "applied_data_run_id": "23", "applied_source_sha": source,
        "failed_deploy_run_id": failed, "resume_maintenance_mode": "pre-runtime-hold",
        "failed_deploy_job_conclusion": "failure",
        "public_validate_job_conclusion": "skipped",
        "lock_release_step_conclusion": "skipped",
        "fence_release_step_conclusion": "skipped",
        "rehold_step_conclusion": "skipped", "failed_activation_run_id": "0",
        "current_source_sha": source, "baseline_sha256": data["baseline_sha256"],
        "runtime_images_sha256": hashlib.sha256(resume_images).hexdigest(),
        "checkpoint_source_sha": source, "disk_checkpoint_run_id": "24",
        "disk_checkpoint_sha256": "c" * 64, "disk_checkpoint_disposition": "NOT_APPLICABLE",
        "application_change_scope": "github-infra-docs-only", "status": "PASS",
    }
    return evidence, {
        "resume-authority.env": "".join(f"{k}={v}\n" for k, v in authority.items()).encode(),
        "resume-images.tsv": resume_images,
    }
lineages = {"23": (data, {}), "25": resumed("25", "77"), "26": resumed("26", "78")}
def parse_data(repo, run, label, *, include_files=False):
    evidence, files = lineages[run]
    return (evidence, "b" * 64, files) if include_files else (evidence, "b" * 64)
m.parse_live_v6_artifact = parse_data
times = {
    "23": ("08:40", "08:50"), "77": ("09:00", "09:09"),
    "25": ("09:10", "09:20"), "78": ("09:30", "09:39"),
    "26": ("09:40", "09:50"),
}
def chain_metadata(repo, run, workflow, *_):
    created, completed = times.get(run, ("08:00", "08:10"))
    return dict(
        head_sha=source,
        display_title=f"oci-live-data apply-slip-index {source}" if workflow == "oci-live-data-rollout.yml"
                      else f"oci-deploy {source}",
        created_at=f"2026-10-07T{created}:00Z", updated_at=f"2026-10-07T{completed}:30Z",
    )
m.fixed_run_metadata = chain_metadata
chain_jobs = {}
for run, minute in (("77", "09"), ("78", "39")):
    these_jobs = copy.deepcopy(original)
    for offset, job in enumerate(these_jobs):
        job.update(run_id=int(run), id=int(run) * 100 + offset)
        for step in job["steps"]:
            if "started_at" in step:
                step["started_at"] = f"2026-10-07T09:{minute}:15Z"
                step["completed_at"] = f"2026-10-07T09:{minute}:17Z"
    chain_jobs[run] = these_jobs
m.jobs_for_run = lambda repo, run, label: chain_jobs[run]
native_inputs = {"77": inputs, "78": dict(inputs, data_run_id="25")}
resume_requests = {}
for run, failed, prerequisite, minute in (("25", "77", "23", "10"), ("26", "78", "25", "40")):
    values = {k: v for k, v in inputs.items() if k != "data_run_id"}
    values.update(
        resume_source_sha=source, phase="apply-slip-index", prerequisite_run_id=prerequisite,
        failed_deploy_run_id=failed, failed_activation_run_id="0", failed_activation_user_id="0",
        confirmation="RESUME APPLIED LIVE DATA EXACT SHA",
    )
    resume_requests[run] = values
    chain_jobs[run] = [{
        "id": int(run) * 100, "run_id": int(run), "name": "rollout",
        "steps": [{
            "name": "Validate exact SHA phase and trusted upstream runs", "conclusion": "success",
            "started_at": f"2026-10-07T09:{minute}:15Z", "completed_at": f"2026-10-07T09:{minute}:17Z",
        }],
    }]
native_reads = []
def chain_log(endpoint):
    for run, minute in (("25", "10"), ("26", "40")):
        if endpoint == f"repos/example/repo/actions/runs/{run}/attempts/1/logs":
            values = resume_requests[run]
            env_names = dict(mapping, resume_source_sha="RESUME_SOURCE_SHA", phase="PHASE",
                prerequisite_run_id="PREREQUISITE_RUN_ID", failed_deploy_run_id="FAILED_DEPLOY_RUN_ID",
                failed_activation_run_id="FAILED_ACTIVATION_RUN_ID", failed_activation_user_id="FAILED_ACTIVATION_USER_ID")
            lines = ["##[group]Run set -euo pipefail", "env:"]
            lines += [f"  {env_names[k]}: {v}" for k, v in values.items()]
            lines += ["  DISPATCH_INPUTS: " + json.dumps(values), "##[endgroup]"]
            raw = "".join(f"2026-10-07T09:{minute}:16Z {line}\n" for line in lines).encode()
            return log_archive(raw, ("-1_rollout.txt",))
    run = next((run for run in ("77", "78")
                if endpoint == f"repos/example/repo/actions/runs/{run}/attempts/1/logs"), None)
    assert run is not None
    native_reads.append(run)
    raw = log(native_inputs[run])
    return log_archive(raw if run == "77" else raw.replace(b"T09:09:", b"T09:39:"))
m.gh_api_bytes = chain_log
def deployment_predecessor():
    m.validate_live_predecessor_profile(
        "example/repo",
        {"workflow": "oci-live-data-rollout.yml", "input": "data_run_id",
         "artifactContent": {"equals": {"schema_version": "live-betting-v6", "phase": "apply-slip-index"}}},
        source, "26", dispatch, "oke",
    )
assert m.validate_pre_runtime_resume_chain("example/repo", "26", "oke") == ("23", source)
deployment_predecessor()
assert {"77", "78"}.issubset(native_reads)
native_inputs["78"] = dict(inputs, data_run_id="23")
reject(deployment_predecessor)
native_inputs["78"] = dict(inputs, data_run_id="25")
saved = copy.deepcopy(lineages)
for key, bad in (
    ("applied_data_run_id", "25"), ("applied_source_sha", "9" * 40),
    ("failed_deploy_run_id", "77"), ("baseline_sha256", "0" * 64),
    ("disk_checkpoint_run_id", "99"),
):
    raw = saved["26"][1]["resume-authority.env"].decode()
    lineages["26"][1]["resume-authority.env"] = re.sub(
        rf"(?m)^{key}=.*$", f"{key}={bad}", raw).encode()
    reject(deployment_predecessor)
    lineages = copy.deepcopy(saved)
native_inputs["78"] = dict(inputs, data_run_id="26")
reject(deployment_predecessor)
native_inputs["78"] = dict(inputs, data_run_id="25")
deployment_predecessor()
print("PASS root -> resume -> failed deployment -> successor -> deployment recursive native lineage")

held_images = "".join(
    f"{name}\t{m.APPLICATION_REPOSITORY}\t{m.APPLICATION_REPOSITORY}@sha256:{index:064x}"
    f"\tsha256:{index:064x}\tsha256:{index:064x}\n"
    for index, name in enumerate(sorted(m.CURRENT_SERVICES), 1)
).encode()
held_evidence, held_files = resumed("39", "77")
held_authority = m.parse_env(held_files["resume-authority.env"], "fixture")
held_authority["runtime_images_sha256"] = hashlib.sha256(held_images).hexdigest()
held_files = {
    "resume-authority.env": "".join(f"{k}={v}\n" for k, v in held_authority.items()).encode(),
    "provenance.env": "".join(f"{k}={v}\n" for k, v in held_evidence.items()).encode(),
    "schema.env": b"fixture reports are exercised by the real producer suite\n",
    "journal.json": b"{}",
}
for stage in ("preflight", "apply", "verify"):
    for service in ("event", "gamemaster", "moderation", "resulting", "bet", "slip"):
        held_files[f"reports/{stage}-{service}.json"] = b"{}"
    held_files[f"reports/{stage}-backoffice-pre-september-cleanup.json"] = b"{}"
for stage in ("preflight", "apply", "verify", "final"):
    held_files[f"reports/{stage}-slip-index.json"] = b"{}"
held_files["reports/preflight-event-reschedule.json"] = b"{}"
held_files["SHA256SUMS"] = "".join(
    f"{hashlib.sha256(raw).hexdigest()}  {name}\n" for name, raw in sorted(held_files.items())
).encode()
held_manifest_sha = m.validate_checksum_manifest(held_files, "known omission fixture")
assert len(held_files) == 31
reject(lambda: m.parse_resume_authority(held_files, held_evidence, "ordinary consumer"))
held_request = dict(
    resume_requests["25"], held_handoff_run_id="39", held_handoff_source_sha=source,
    confirmation=m.HELD_HANDOFF_CONFIRMATION)
held_history = dict(proof, held_handoff_run_id="39", successor_run_id="40")
held_metadata = dict(history_held, id=39, head_sha=source)
saved_artifact_reader = m.exact_artifact
saved_native_parser = m.failed_deploy_native_inputs
saved_history_reader = m.held_handoff_history
successor_files = {}
successor_evidence = dict(held_evidence, workflow_run_id="40")
def continuation_data(repo, run, label, *, include_files=False):
    if run not in {"39", "40"}:
        return parse_data(repo, run, label, include_files=include_files)
    evidence, members = (held_evidence, held_files) if run == "39" else (successor_evidence, successor_files)
    digest = m.validate_checksum_manifest(members, label)
    return (evidence, digest, members) if include_files else (evidence, digest)
def held_admission():
    return m.validate_held_handoff_artifact(
        "example/repo", "39", source, source, held_request, "oke", "held fixture", successor_run_id="40")
with patch.object(m, "parse_live_v6_artifact", side_effect=continuation_data), \
        patch.object(m, "validate_held_handoff_native", return_value=held_metadata), \
        patch.object(m, "held_handoff_history", side_effect=lambda *_, **__: copy.deepcopy(held_history)), \
        patch.object(m, "validate_held_handoff_reports") as report_check, \
        patch.object(m, "exact_artifact", side_effect=lambda repo, run, name, label: (
            {"id": 2100} if (run, name) == ("21", f"oci-image-provenance-{source}-21-1")
            else saved_artifact_reader(repo, run, name, label))), \
        patch.object(m, "artifact_member", return_value=held_images):
    admitted = held_admission()
    assert admitted["resume"]["applied_data_run_id"] == "23"
    assert admitted["resume"]["held_handoff_run_id"] == "39"
    assert admitted["resume"]["held_handoff_evidence_sha256"] == held_manifest_sha
    report_check.assert_called_once_with(held_files, held_evidence)
    for key, wrong in (
        ("confirmation", "RESUME APPLIED LIVE DATA EXACT SHA"),
        ("prerequisite_run_id", "39"), ("failed_deploy_run_id", "39"),
        ("resume_source_sha", "9" * 40), ("build_run_id", "99"),
        ("disk_checkpoint_run_id", "99"),
    ):
        old = held_request[key]; held_request[key] = wrong
        reject(held_admission); held_request[key] = old
    original_members = copy.deepcopy(held_files)
    for mutation in ("missing-report", "unexpected-images", "bad-checksum", "root-authority"):
        held_files = copy.deepcopy(original_members)
        if mutation == "missing-report": held_files.pop("reports/final-slip-index.json")
        elif mutation == "unexpected-images": held_files["resume-images.tsv"] = held_images
        elif mutation == "bad-checksum": held_files["journal.json"] += b"\n"
        else:
            held_files["resume-authority.env"] = held_files["resume-authority.env"].replace(
                b"applied_data_run_id=23\n", b"applied_data_run_id=25\n")
        if mutation != "bad-checksum":
            held_files["SHA256SUMS"] = "".join(
                f"{hashlib.sha256(raw).hexdigest()}  {name}\n"
                for name, raw in sorted(held_files.items()) if name != "SHA256SUMS").encode()
        reject(held_admission)
    held_files = original_members
    complete_members = dict(original_members, **{"resume-images.tsv": held_images})
    complete_members["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(raw).hexdigest()}  {name}\n"
        for name, raw in sorted(complete_members.items()) if name != "SHA256SUMS").encode()
    current_held = dict(
        held_metadata, _held_complete=True, _held_native_inputs=resume_requests["25"],
        _handoff_deadline=1234567890,
    )
    held_files = complete_members
    with patch.object(m, "validate_held_handoff_native", return_value=current_held), \
            patch.object(m, "complete_held_artifacts",
                         return_value=m.original_before_baseline(baseline_files, "fixture")), \
            patch.object(m, "held_handoff_authority") as owner_check:
        current = held_admission()
        assert current["resume"]["applied_data_run_id"] == "23"
        owner_check.assert_called_once()
        for mutation in ("missing-images", "wrong-images", "wrong-owner", "wrong-root", "missing-report"):
            held_files = copy.deepcopy(complete_members)
            if mutation == "missing-images": held_files.pop("resume-images.tsv")
            elif mutation == "wrong-images": held_files["resume-images.tsv"] = held_images.replace(b"0001", b"9999")
            elif mutation == "missing-report": held_files.pop("reports/final-slip-index.json")
            elif mutation == "wrong-owner":
                held_files["resume-authority.env"] = held_files["resume-authority.env"].replace(
                    b"failed_deploy_run_id=77", b"failed_deploy_run_id=99")
            else:
                held_files["resume-authority.env"] = held_files["resume-authority.env"].replace(
                    b"applied_data_run_id=23", b"applied_data_run_id=25")
            held_files["SHA256SUMS"] = "".join(
                f"{hashlib.sha256(raw).hexdigest()}  {name}\n"
                for name, raw in sorted(held_files.items()) if name != "SHA256SUMS").encode()
            reject(held_admission)
        held_files = complete_members
        with patch.object(m, "complete_held_artifacts", return_value={"substituted": b"root"}):
            reject(held_admission)
    held_files = original_members
    print("PASS complete current package admission and root/image/owner omissions without historical fallback")
    successor_authority = dict(
        held_authority, schema_version="live-betting-data-resume-v3",
        held_handoff_run_id="39", held_handoff_source_sha=source,
        held_handoff_evidence_sha256=held_manifest_sha,
    )
    transfer = {
        "schema_version": "live-betting-held-handoff-transfer-v1",
        "held_handoff_run_id": "39", "held_handoff_source_sha": source,
        "successor_run_id": "40", "successor_source_sha": source,
        "snapshot_sha256": "d" * 64, "lock_uid": "fixture-uid",
        "observed_resource_version": "42", "observed_fencing_generation": "11",
        "observed_lease_until_epoch": "2900",
        "release_result": "confirmed", "acquire_result": "confirmed", "verify_result": "confirmed",
    }
    successor_files.update({
        "resume-authority.env": "".join(f"{k}={v}\n" for k, v in successor_authority.items()).encode(),
        "provenance.env": "".join(f"{k}={v}\n" for k, v in successor_evidence.items()).encode(),
        "resume-images.tsv": held_images,
        "held-handoff-history.json": json.dumps(held_history).encode(),
        "held-handoff-transfer.json": json.dumps(transfer).encode(),
    })
    successor_files["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(raw).hexdigest()}  {name}\n"
        for name, raw in sorted(successor_files.items())).encode()
    native_run_reader = m.require_fixed_run
    with patch.object(m, "require_fixed_run", side_effect=lambda repo, run, *args: (
                {"id": 40, "head_sha": source} if run == "40" else native_run_reader(repo, run, *args))), \
            patch.object(m, "failed_deploy_native_inputs", side_effect=lambda repo, run, *args, **kwargs: (
                dict(held_request) if run == "40" else saved_native_parser(repo, run, *args, **kwargs))):
        consume_successor = lambda: m.validate_pre_runtime_resume_chain("example/repo", "40", "oke")
        assert consume_successor() == ("23", source)
        transition_successor = dict(successor, id=40, status="in_progress", conclusion=None)
        transition_job = dict(cutoff_job, run_id=40, status="in_progress")
        transition_reads = []
        transition_extra = []
        transition_api_reader, transition_jobs_reader = m.gh_api, m.jobs_for_run
        transition_pages_reader, transition_artifacts_reader = m.gh_api_pages, m.artifact_inventory
        original_successor_package = copy.deepcopy(successor_files)
        reset_cancelled()
        cancelled_rows[0]["updated_at"] = "2026-10-07T10:00:01Z"
        for endpoint in (cancelled_endpoint, cancelled_endpoint + "/attempts/1"):
            cancelled_responses[endpoint]["updated_at"] = "2026-10-07T10:00:01Z"
        def transition_api(endpoint):
            if endpoint in cancelled_responses:
                return copy.deepcopy(cancelled_responses[endpoint])
            if endpoint in (
                "repos/example/repo/actions/runs/40",
                "repos/example/repo/actions/runs/40/attempts/1",
            ):
                return copy.deepcopy(transition_successor)
            return transition_api_reader(endpoint)
        def transition_pages(endpoint):
            if endpoint in cancelled_pages:
                return copy.deepcopy(cancelled_pages[endpoint])
            if "/workflows/" not in endpoint:
                return transition_pages_reader(endpoint)
            transition_reads.append(endpoint)
            name = endpoint.split("/workflows/", 1)[1].split("/", 1)[0]
            rows = []
            if name == "oci-live-data-rollout.yml":
                rows = [
                    dict(history_held, id=39, path=cancelled_path, head_branch="master",
                         head_repository={"full_name": "example/repo"}, status="completed"),
                    copy.deepcopy(transition_successor),
                    *copy.deepcopy(cancelled_rows), *copy.deepcopy(transition_extra),
                ]
            if "&created=%3C%3D" in endpoint:
                cutoff = m.parse_timestamp(endpoint.split("&created=%3C%3D", 1)[1], "fixture cutoff")
                rows = [row for row in rows if m.parse_timestamp(row["created_at"], "fixture row") <= cutoff]
            return [{"total_count": len(rows), "workflow_runs": rows}]
        held_files = complete_members
        with patch.object(m, "validate_held_handoff_native", return_value=current_held), \
                patch.object(m, "complete_held_artifacts",
                             return_value=m.original_before_baseline(baseline_files, "fixture")), \
                patch.object(m, "held_handoff_authority"), \
                patch.object(m, "held_handoff_history", wraps=saved_history_reader) as fresh_history, \
                patch.object(m, "gh_api", side_effect=transition_api), \
                patch.object(m, "gh_api_pages", side_effect=transition_pages), \
                patch.object(m, "jobs_for_run", side_effect=lambda repo, run, label:
                             [copy.deepcopy(transition_job)] if run == "40" else (
                                 native_jobs_inventory(repo, run, label) if run == "90" else
                                 transition_jobs_reader(repo, run, label))), \
                patch.object(m, "artifact_inventory", side_effect=lambda repo, run, label:
                             native_artifacts_inventory(repo, run, label) if run == "90" else
                             transition_artifacts_reader(repo, run, label)):
            before_completion = held_admission()
            successor_files["held-handoff-history.json"] = json.dumps(
                before_completion["heldHistory"]).encode()
            successor_files["resume-authority.env"] = "".join(
                f"{key}={value}\n" for key, value in dict(
                    successor_authority,
                    held_handoff_evidence_sha256=before_completion["resume"][
                        "held_handoff_evidence_sha256"],
                ).items()).encode()
            successor_files["SHA256SUMS"] = "".join(
                f"{hashlib.sha256(raw).hexdigest()}  {name}\n"
                for name, raw in sorted(successor_files.items()) if name != "SHA256SUMS").encode()
            transition_successor.update(status="completed", conclusion="success")
            transition_job["status"] = "completed"
            assert held_admission()["heldHistory"] == before_completion["heldHistory"]
            assert consume_successor() == ("23", source)
            assert all(call.kwargs == {} for call in fresh_history.call_args_list)
            assert any("&created=" not in endpoint for endpoint in transition_reads)
            assert any("&created=" in endpoint for endpoint in transition_reads)
            assert saved_history_reader(
                "example/repo", dict(history_held, id=39), source, "40") == before_completion["heldHistory"]
            for mutation in ("created-after-cutoff", "mutating", "unknown-proof"):
                job = cancelled_pages[cancelled_job_endpoint][0]["jobs"][0]
                if mutation == "created-after-cutoff":
                    transition_extra.append(dict(
                        cancelled_run, id=91, status="in_progress", conclusion=None,
                        created_at="2026-10-07T10:00:01Z", updated_at="2026-10-07T10:00:02Z"))
                elif mutation == "mutating":
                    job["steps"] = [{"name": "Set up job", "conclusion": "success"}]
                else:
                    cancelled_responses[cancelled_source_endpoint]["sha"] = "0" * 40
                transition_successor.update(status="in_progress", conclusion=None)
                transition_job["status"] = "in_progress"
                reject(held_admission)
                transition_successor.update(status="completed", conclusion="success")
                transition_job["status"] = "completed"
                if mutation == "created-after-cutoff":
                    assert consume_successor() == ("23", source)
                else:
                    reject(consume_successor)
                transition_extra.clear()
                job["steps"] = []
                cancelled_responses[cancelled_source_endpoint] = copy.deepcopy(cancelled_historical)
            assert consume_successor() == ("23", source)
        held_files = original_members
        successor_files = original_successor_package
        reset_cancelled()
        print("PASS fresh held qualification and recursive v3 completion retain native no-execution history")
        for key, wrong in (
            ("held_handoff_run_id", "23"), ("held_handoff_source_sha", "9" * 40),
            ("prerequisite_run_id", "39"), ("resume_source_sha", "9" * 40),
            ("failed_deploy_run_id", "78"), ("build_run_id", "99"), ("disk_checkpoint_run_id", "99"),
        ):
            old = held_request[key]; held_request[key] = wrong
            reject(consume_successor); held_request[key] = old
        held_history["cutoff_at"] = "2026-10-07T10:00:01Z"
        reject(consume_successor)
        held_history["cutoff_at"] = proof["cutoff_at"]
        assert consume_successor() == ("23", source)
        def ordinary_successor():
            return m.validate_live_predecessor_profile(
                "example/repo",
                {"workflow": "oci-live-data-rollout.yml", "input": "data_run_id",
                 "artifactContent": {"equals": {"schema_version": "live-betting-v6", "phase": "apply-slip-index"}}},
                source, "40", dispatch, "oke",
            )
        ordinary_successor()
        original_successor_files = copy.deepcopy(successor_files)
        original_baseline_sha = successor_evidence["baseline_sha256"]
        substituted_baseline_sha = m.validate_checksum_manifest(
            sealed("different-before", b"substituted before baseline"), "substituted baseline fixture")
        assert substituted_baseline_sha != original_baseline_sha
        successor_evidence["baseline_sha256"] = substituted_baseline_sha
        successor_files["provenance.env"] = "".join(
            f"{k}={v}\n" for k, v in successor_evidence.items()).encode()
        successor_files["resume-authority.env"] = "".join(
            f"{k}={v}\n" for k, v in
            dict(successor_authority, baseline_sha256=substituted_baseline_sha).items()).encode()
        successor_files["SHA256SUMS"] = "".join(
            f"{hashlib.sha256(raw).hexdigest()}  {name}\n"
            for name, raw in sorted(successor_files.items()) if name != "SHA256SUMS").encode()
        m.validate_checksum_manifest(successor_files, "resealed successor fixture")
        assert m.parse_resume_authority(
            successor_files, successor_evidence, "resealed successor fixture"
        )["baseline_sha256"] == substituted_baseline_sha
        reject(ordinary_successor)
        successor_evidence["baseline_sha256"] = original_baseline_sha
        successor_files = original_successor_files
        ordinary_successor()
        print("PASS v3 upstream rejects internally resealed original-baseline substitution")
print("PASS sole historical omission eligible only for continuation; v3 native roles and immutable history")
PY
ok "pre-runtime strict inventory, native private tuple, and original before-baseline"

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" <<'PY'
import contextlib
import hashlib
import importlib.util
import io
import sys

path = sys.argv[1]
spec = importlib.util.spec_from_file_location("upstream_binding", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

repository = "ghcr.io/vasilyevstan/betstan-images"
source_sha = "1" * 40
target_sha = "2" * 40
services = [
    "auth", "bet", "backoffice", "client", "event", "moderation",
    "resulting", "slip", "gamemaster",
]
changed = {"auth", "bet", "backoffice"}
restored = {}
pre_rows = []
partial_rows = []
for index, service in enumerate(services, 1):
    restored_ref = f"{repository}@sha256:{index:064x}"
    partial_ref = (
        f"{repository}@sha256:{index + 100:064x}"
        if service in changed
        else restored_ref
    )
    restored[service] = {"image_ref": restored_ref}
    pre_rows.append(
        f"{service}\tgaming-{service}-depl\t{restored_ref}\t1\t1/1"
    )
    partial_rows.append(f"{service}\t{partial_ref}\t1")

evidence = {
    "failure-state.env": (
        "status=FAIL\n"
        "failed_service=backoffice\n"
        "failed_deployment=gaming-backoffice-depl\n"
        "failed_step_label=failed-backoffice\n"
        "rollback_http_mutation_fence=active\n"
    ).encode(),
    "pre-rollback-state.tsv": ("\n".join(pre_rows) + "\n").encode(),
    "partial-state.tsv": ("\n".join(partial_rows) + "\n").encode(),
    "rollout-order.tsv": b"auth\nbet\nbackoffice\n",
    "baseline-provenance.env": (
        f"baseline_source_sha={target_sha}\n"
    ).encode(),
    "telemetry-pre-run.env": (
        f"mode=retained\nimage={repository}@sha256:{'f' * 64}\n"
        "database_initialized=true\nqueue_present=true\n"
    ).encode(),
}
module.fixed_run_metadata = lambda *_args: {
    "head_sha": source_sha,
    "display_title": f"oci-rollback {target_sha}",
    "updated_at": "2026-01-01T00:00:00Z",
}
module.exact_artifact = lambda *_args: {"id": 1}
module.artifact_files = lambda *_args, **_kwargs: evidence
telemetry = {
    "mode": "retained",
    "image": f"{repository}@sha256:{'f' * 64}",
    "database_initialized": "true",
    "queue_present": "true",
}


def sealed_plan(order):
    rows = []
    for service in order:
        rows.append([
            service,
            f"gaming-{service}-depl",
            restored[service]["image_ref"],
            next(
                row.split("\t")[1]
                for row in partial_rows
                if row.startswith(f"{service}\t")
            ),
        ])
    raw = (
        "\n".join("\t".join(row) for row in rows) + "\n"
    ).encode()
    sealed = {
        "recovery-plan.tsv": raw,
        "SHA256SUMS": (
            f"{hashlib.sha256(raw).hexdigest()}  recovery-plan.tsv\n"
        ).encode(),
    }
    module.validate_checksum_manifest(sealed, "sealed recovery plan")
    return module.parse_tsv(raw, 4, "sealed recovery plan")


module.validate_failed_partial_rollback_artifact(
    "example/repo",
    "88",
    source_sha,
    target_sha,
    restored,
    sealed_plan(["backoffice", "bet", "auth"]),
    telemetry,
    "partial recovery",
)
for invalid_order in (
    ["auth", "bet", "backoffice"],
    ["bet", "backoffice", "auth"],
):
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            module.validate_failed_partial_rollback_artifact(
                "example/repo",
                "88",
                source_sha,
                target_sha,
                restored,
                sealed_plan(invalid_order),
                telemetry,
                "partial recovery",
            )
    except SystemExit:
        pass
    else:
        raise AssertionError(
            "checksum-consistent non-producer recovery order passed"
        )
PY
ok "partial recovery accepts only reverse producer order"

mkdir -p "$WORK/bin"
cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "api" ] || { echo "unexpected gh invocation: $*" >&2; exit 1; }
file="$FIXTURE_DIR/$(printf '%s' "$2" | tr '/?=&' '____')"
[ -f "$file" ] || { echo "no fixture for $2" >&2; exit 1; }
if [[ "$2" == */zip || -f "$file.1.status" || -f "$file.1.sleep" || -f "$file.calls" ]]; then
  attempt=0
  if [ -f "$file.calls" ]; then read -r attempt <"$file.calls"; fi
  attempt=$((attempt + 1))
  printf '%s\n' "$attempt" >"$file.calls"
  prefix="$file.$attempt"
  if [ -f "$prefix.status" ] || [ -f "$prefix.sleep" ]; then
    if [ -f "$prefix.stdout" ]; then cat "$prefix.stdout"; fi
    if [ -f "$prefix.stderr" ]; then cat "$prefix.stderr" >&2; fi
    if [ -f "$prefix.sleep" ]; then
      printf '%s\n' "$$" >"$file.pid"
      exec sleep "$(cat "$prefix.sleep")"
    fi
    exit "$(cat "$prefix.status")"
  fi
fi
cat "$file"
EOF
chmod 755 "$WORK/bin/gh"

fixture() {
  cat >"$FIXTURE_DIR/$(printf '%s' "$1" | tr '/?=&' '____')"
}

reset_fixtures() {
  FIXTURE_DIR="$WORK/api"
  rm -rf "$FIXTURE_DIR"
  mkdir -p "$FIXTURE_DIR"
  export FIXTURE_DIR
}

artifact_zip_fixture() {
  local artifact_id="$1"
  local file_name="$2"
  local content="$3"
  local destination
  destination="$FIXTURE_DIR/$(printf '%s' \
    "repos/$REPO/actions/artifacts/$artifact_id/zip" | tr '/?=&' '____')"
  python3 - "$destination" "$file_name" "$content" <<'PY'
import sys
import zipfile

destination, file_name, content = sys.argv[1:]
with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as bundle:
    bundle.writestr(file_name, content)
PY
}

artifact_zip_directory_fixture() {
  local artifact_id="$1"
  local source_directory="$2"
  local destination
  destination="$FIXTURE_DIR/$(printf '%s' \
    "repos/$REPO/actions/artifacts/$artifact_id/zip" | tr '/?=&' '____')"
  python3 - "$destination" "$source_directory" <<'PY'
import pathlib
import sys
import zipfile

destination = pathlib.Path(sys.argv[1])
source = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as bundle:
    for path in sorted(source.rglob("*")):
        if path.is_file():
            bundle.write(path, path.relative_to(source).as_posix())
PY
}

artifact_zip_duplicate_fixture() {
  local artifact_id="$1"
  local source_directory="$2"
  local duplicate_relative="$3"
  local destination
  destination="$FIXTURE_DIR/$(printf '%s' \
    "repos/$REPO/actions/artifacts/$artifact_id/zip" | tr '/?=&' '____')"
  python3 - \
    "$destination" "$source_directory" "$duplicate_relative" <<'PY'
import pathlib
import sys
import warnings
import zipfile

destination = pathlib.Path(sys.argv[1])
source = pathlib.Path(sys.argv[2])
duplicate = sys.argv[3]
with warnings.catch_warnings():
    warnings.simplefilter("ignore", UserWarning)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                bundle.write(path, path.relative_to(source).as_posix())
        bundle.writestr(duplicate, (source / duplicate).read_bytes())
PY
}

# attempt event title path repo branch sha status conclusion workflow_id
write_capacity_fixtures() {
  local attempt="${1:-1}" event="${2:-workflow_dispatch}" title="${3:-}"
  local path="${4:-.github/workflows/oci-capacity-acquire.yml}"
  local repo="${5:-$REPO}" branch="${6:-master}" sha="${7:-$SUBJECT_SHA}"
  local status="${8:-completed}" conclusion="${9:-success}"
  local wfid="${10:-$WORKFLOW_ID}"
  [ -n "$title" ] || title="oci-capacity-acquire $SUBJECT_SHA"
  fixture "repos/$REPO/actions/workflows/oci-capacity-acquire.yml" <<EOF2
{"id": $WORKFLOW_ID}
EOF2
  fixture "repos/$REPO/actions/runs/$CAPACITY_RUN" <<EOF2
{"id": $CAPACITY_RUN, "run_attempt": $attempt, "workflow_id": $wfid, "path": "$path",
 "head_repository": {"full_name": "$repo"}, "head_branch": "$branch",
 "head_sha": "$sha", "status": "$status", "conclusion": "$conclusion",
 "event": "$event", "display_title": "$title"}
EOF2
  fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/attempts/1" <<EOF2
{"id": $CAPACITY_RUN, "run_attempt": 1, "workflow_id": $wfid, "path": "$path",
 "head_repository": {"full_name": "$repo"}, "head_branch": "$branch",
 "head_sha": "$sha", "status": "$status", "conclusion": "$conclusion",
 "event": "$event", "display_title": "$title"}
EOF2
  fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/artifacts?per_page=100" <<EOF2
{"total_count": 1, "artifacts": [{"name": "oci-capacity-provenance-$CAPACITY_RUN-1",
 "id": 9001, "expired": false, "size_in_bytes": 1361}]}
EOF2
  artifact_zip_fixture 9001 provenance.env \
    "source_sha=$sha
acquisition_run_id=$CAPACITY_RUN
runtime_mode=k3s
shape=VM.Standard.A1.Flex
ocpus=2
memory_gb=12
boot_volume_gb=50
boot_volume_vpus_per_gb=10
"
}

binding_json() {
  "$POLICY" get oci-infrastructure-finalize-k3s |
    python3 -c '
import json, sys
for binding in json.load(sys.stdin)["upstreamRunBindings"]:
    if binding["input"] == "capacity_acquisition_run_id":
        print(json.dumps(binding))
        break
'
}
CAPACITY_BINDING_JSON="$(binding_json)"

run_validator() {
  PATH="$WORK/bin:$PATH" "$VALIDATOR" validate \
    --repository "$REPO" \
    --binding "$CAPACITY_BINDING_JSON" \
    --subject-sha "$SUBJECT_SHA" \
    --run-id "$CAPACITY_RUN" 2>"$WORK/err.txt"
}

expect_reject() {
  local label="$1"; shift
  reset_fixtures
  write_capacity_fixtures "$@"
  if run_validator >/dev/null; then
    fail "$label was accepted"
  fi
  ok "reject $label"
}

# ------------------------------------------------------------ accept good ---
reset_fixtures
write_capacity_fixtures
run_validator >/dev/null || fail "exact capacity run rejected: $(cat "$WORK/err.txt")"
ok "accept exact first-attempt dispatched capacity run"

reset_fixtures
write_capacity_fixtures
artifact_endpoint="repos/$REPO/actions/artifacts/9001/zip"
artifact_file="$FIXTURE_DIR/$(printf '%s' "$artifact_endpoint" | tr '/?=&' '____')"
printf '1\n' >"$artifact_file.1.status"
printf 'gh: Bad Gateway (HTTP 502)\n' >"$artifact_file.1.stderr"
printf 'discarded partial archive' >"$artifact_file.1.stdout"
run_validator >/dev/null || fail "transient artifact failure was not recovered"
[ "$(cat "$artifact_file.calls")" = 2 ] || fail "artifact recovery changed attempt count"
ok "retry a transient artifact GET without bypassing binding validation"

reset_fixtures
write_capacity_fixtures
PATH="$WORK/bin:$PATH" python3 -B - "$VALIDATOR" "$artifact_endpoint" "$artifact_file" <<'PY'
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import re
import subprocess
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("binding_transport", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
endpoint, fixture = sys.argv[2], Path(sys.argv[3])
valid_archive = fixture.read_bytes()
assert module.ARTIFACT_DOWNLOAD_ATTEMPTS == 3
assert module.ARTIFACT_DOWNLOAD_TIMEOUT_SECONDS == 120
assert module.ARTIFACT_DOWNLOAD_BACKOFF_SECONDS == (1, 2)
assert 3 * 120 + sum(module.ARTIFACT_DOWNLOAD_BACKOFF_SECONDS) == 363
backoffs = []
secret = "synthetic-private-token"
signed_url = "https://example.invalid/archive?signature=synthetic-private-token"


def sidecar(suffix):
    return Path(str(fixture) + suffix)


def reset_download(body=valid_archive):
    for suffix in [".calls", ".pid"] + [
        f".{attempt}.{kind}"
        for attempt in range(1, 4)
        for kind in ("status", "stdout", "stderr", "sleep")
    ]:
        sidecar(suffix).unlink(missing_ok=True)
    fixture.write_bytes(body)
    backoffs.clear()


def failure(attempt, diagnostic, output=valid_archive):
    sidecar(f".{attempt}.status").write_text("1\n")
    sidecar(f".{attempt}.stderr").write_bytes(
        diagnostic if isinstance(diagnostic, bytes) else diagnostic.encode()
    )
    sidecar(f".{attempt}.stdout").write_bytes(output)


def invoke(accepted, calls, sleeps, expected=valid_archive, expected_kind="artifact-zip"):
    stdout, stderr = io.StringIO(), io.StringIO()
    with patch.object(module.subprocess, "run", wraps=subprocess.run) as run, \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            value = module.gh_api_bytes(endpoint)
        except SystemExit as error:
            assert not accepted and error.code == 1
        else:
            assert accepted and value == expected
    assert int(sidecar(".calls").read_text()) == calls
    assert backoffs == sleeps
    assert stdout.getvalue() == ""
    assert secret not in stderr.getvalue() and signed_url not in stderr.getvalue()
    for call in run.call_args_list:
        assert call.args == (["gh", "api", endpoint],)
        assert call.kwargs == {
            "capture_output": True, "check": False,
            "timeout": module.ARTIFACT_DOWNLOAD_TIMEOUT_SECONDS,
        }
    for line in stderr.getvalue().splitlines():
        assert re.fullmatch(
            r"(?:upstream binding rejected: )?artifact download "
            r"classification=(?:http|network|ambiguous|unknown|timeout|local-execution|command|cancelled|empty-body|oversized-body)"
            r"(?: status=[1-5][0-9]{2})? attempt=[1-3]/3 disposition=(?:retry|exhausted|not-retryable)"
            rf" request_kind={expected_kind}"
            r" diagnostic=(?:unclassified|tls-handshake-timeout|deadline-exceeded|io-timeout)",
            line,
        ), "byte-read diagnostics exposed nonconstant material"
    return stderr.getvalue()


with patch.object(module, "time", wraps=module.time) as clock:
    clock.sleep.side_effect = backoffs.append
    subprocess.time.sleep(0)
    assert backoffs == []
    module.time.sleep(1)
    assert backoffs == [1]
    print("artifact_transport_clock_isolation=PASS")
    reset_download()
    assert invoke(True, 1, []) == ""
    for status in (500, 502, 503, 504):
        reset_download()
        failure(1, f"gh: {secret} {signed_url} (HTTP {status})\n")
        diagnostic = invoke(True, 2, [1])
        assert f"status={status}" in diagnostic and "disposition=retry" in diagnostic
        assert "diagnostic=unclassified" in diagnostic

    reset_download()
    failure(1, "gh: HTTP 502\n", b"")
    failure(2, "HTTP 503: Service Unavailable\n", b"")
    invoke(True, 3, [1, 2])

    reset_download()
    for attempt in range(1, 4):
        failure(attempt, "gh: HTTP 504\n")
    assert "disposition=exhausted" in invoke(False, 3, [1, 2])

    for diagnostic, code in (
        (f'Get "{signed_url}": net/http: TLS handshake timeout', "tls-handshake-timeout"),
        (f'Get "{signed_url}": context deadline exceeded (Client.Timeout exceeded while awaiting headers)', "deadline-exceeded"),
        ("read tcp 192.0.2.1:1234->192.0.2.2:443: read: connection reset by peer", "unclassified"),
        ("dial tcp 192.0.2.2:443: i/o timeout", "unclassified"),
        ("write tcp 192.0.2.1:1234->192.0.2.2:443: i/o timeout", "unclassified"),
        ("read tcp [2001:db8::1]:1234->[2001:db8::2]:443: read: connection reset by peer", "unclassified"),
        ("dial tcp [fe80::1%eth0]:443: i/o timeout", "unclassified"),
        ("gh: i/o timeout", "io-timeout"),
    ):
        reset_download()
        failure(1, diagnostic)
        assert f"diagnostic={code}" in invoke(True, 2, [1])

    for diagnostic in (
        "gh: i/o timeout (HTTP 401)",
        "gh: connection reset by peer (HTTP 403)",
        "gh: Not Found (HTTP 404)",
        "gh: rate limited (HTTP 429)",
        "gh: Not Implemented (HTTP 501)",
        "gh: HTTP 502\ngh: Forbidden (HTTP 403)",
        "gh: HTTP 502\ngh: HTTP 503",
        "gh: Bad Gateway (HTTP 502) versus Service Unavailable (HTTP 503)",
        "HTTP 502: conflicting HTTP 503",
        "gh: permission denied (HTTP 503)",
        "gh: Bad credentials (HTTP 503)",
        "gh: Requires authentication (HTTP 500)",
        "gh: Not authorized (HTTP 504)",
        "dial tcp permission denied: i/o timeout",
        'Get "https://example.invalid/archive": read tcp 192.0.2.1:1234->192.0.2.2:443: Forbidden (HTTP 403): read: connection reset by peer',
        f"read tcp {secret}: i/o timeout",
        "read tcp 192.0.2.1:1234->192.0.2.2:443: HTTP 503: i/o timeout",
        "dial tcp 999.0.2.1:443: i/o timeout",
        "dial tcp [dead:beef]:443: i/o timeout",
        "dial tcp 192.0.2.1:65536: i/o timeout",
        "read tcp 192.0.2.1:443: i/o timeout",
        "dial tcp 192.0.2.1:1234->192.0.2.2:443: i/o timeout",
        "gh: HTTP 502\nunclassified second diagnostic",
        f"{secret}: arbitrary timeout or reset and 502",
        "context canceled",
        f'Get "{signed_url}": x509: certificate signed by unknown authority',
    ):
        reset_download()
        failure(1, diagnostic)
        output = invoke(False, 1, [])
        assert "disposition=not-retryable" in output and "diagnostic=unclassified" in output

    original_endpoint, original_fixture = endpoint, fixture
    for endpoint, kind in (
        (original_endpoint, "artifact-zip"),
        ("repos/example/repo/actions/jobs/771/logs", "job-log"),
        ("repos/example/repo/actions/runs/771/attempts/1/logs", "attempt-log-zip"),
        ("repos/example/repo/actions/runs/771/attempts/2/logs", "unrecognized"),
        ("repos/example/repo/actions/runs/771/attempts/1/logs?private=value", "unrecognized"),
        ("repos/example/repo/actions/runs/771/logs", "unrecognized"),
        (original_endpoint + "?signed=private", "unrecognized"),
        (original_endpoint + "/", "unrecognized"),
        ("repos/example/repo/actions/artifacts/0/zip", "unrecognized"),
    ):
        fixture = original_fixture.parent / endpoint.translate(str.maketrans("/?=&", "____"))
        reset_download()
        failure(1, f'Get "{signed_url}": net/http: TLS handshake timeout')
        output = invoke(True, 2, [1], expected_kind=kind)
        assert output == (
            "artifact download classification=network attempt=1/3 disposition=retry"
            f" request_kind={kind} diagnostic=tls-handshake-timeout\n"
        )
    endpoint, fixture = original_endpoint, original_fixture
    for raw, accepted, calls, sleeps in (
        (b"private-error\xff\x00", False, 1, []),
        (f'Get "{signed_url}'.encode() + b'\xff": net/http: TLS handshake timeout', True, 2, [1]),
        (b"net/http: TLS handshake timeout\ni/o timeout", False, 1, []),
        (b"gh: HTTP 503\nAuthorization: Bearer synthetic-private-token", False, 1, []),
    ):
        reset_download()
        failure(1, raw, b"private-job-log-and-body")
        assert "diagnostic=unclassified" in invoke(accepted, calls, sleeps)
    reset_download()
    failure(1, "gh: i/o timeout")
    with patch.object(module, "_artifact_download_diagnostic", return_value="unclassified"):
        assert "classification=network" in invoke(True, 2, [1])

    reset_download(b"")
    invoke(False, 1, [])
    limit = module.MAX_ARTIFACT_ARCHIVE_BYTES
    reset_download(b"x" * limit)
    invoke(True, 1, [], expected=b"x" * limit)
    reset_download(b"x" * (limit + 1))
    invoke(False, 1, [])

    for result in [
        subprocess.CompletedProcess(["gh"], code, valid_archive, b"gh: HTTP 502")
        for code in (-15, 2, 4, 130, 143, 99)
    ] + [OSError(f"{secret} {signed_url}")]:
        reset_download()
        with patch.object(module.subprocess, "run", side_effect=[result]) as run:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                try:
                    module.gh_api_bytes(endpoint)
                except SystemExit as error:
                    assert error.code == 1
                else:
                    raise AssertionError("local failure or cancellation was accepted")
            assert run.call_count == 1 and backoffs == []
            assert secret not in stderr.getvalue() and signed_url not in stderr.getvalue()
            assert stderr.getvalue().endswith(" request_kind=artifact-zip diagnostic=unclassified\n")
            assert run.call_args.args == (["gh", "api", endpoint],)
            assert run.call_args.kwargs == {"capture_output": True, "check": False, "timeout": 120}


def require_child_gone():
    pid = int(sidecar(".pid").read_text())
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    raise AssertionError("timed-out child survived into retry")


def timeout_backoff(seconds):
    require_child_gone()
    backoffs.append(seconds)


with patch.object(module, "ARTIFACT_DOWNLOAD_TIMEOUT_SECONDS", 0.5), \
        patch.object(module, "time", wraps=module.time) as clock:
    clock.sleep.side_effect = timeout_backoff
    for exhausted in (False, True):
        reset_download(b"fresh successful bytes")
        for attempt in range(1, 4 if exhausted else 2):
            sidecar(f".{attempt}.sleep").write_text("10\n")
            sidecar(f".{attempt}.stdout").write_bytes(valid_archive)
            sidecar(f".{attempt}.stderr").write_text(secret + signed_url)
        invoke(not exhausted, 3 if exhausted else 2, [1, 2] if exhausted else [1],
               expected=b"fresh successful bytes")
        require_child_gone()
reset_download()
print("artifact_transport_contract=PASS")
PY
ok "bounded artifact transport, exact bytes, timeout cleanup and diagnostic redaction"

reset_fixtures
write_capacity_fixtures
printf 'not a zip archive' >"$artifact_file"
if run_validator >/dev/null; then fail "malformed downloaded ZIP was accepted"; fi
[ "$(cat "$artifact_file.calls")" = 1 ] || fail "malformed ZIP triggered a retry"
ok "reject malformed downloaded ZIP without transport retry"

reset_fixtures
write_capacity_fixtures
fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/artifacts?per_page=100" <<EOF2
[
  {
    "total_count": 2,
    "artifacts": [
      {"name": "unrelated", "expired": false, "size_in_bytes": 10}
    ]
  },
  {
    "total_count": 2,
    "artifacts": [
      {
        "name": "oci-capacity-provenance-$CAPACITY_RUN-1",
        "id": 9001,
        "expired": false,
        "size_in_bytes": 1361
      }
    ]
  }
]
EOF2
run_validator >/dev/null || fail "artifact on a later page was rejected"
ok "accept exact artifact from the complete paginated inventory"

reset_fixtures
write_capacity_fixtures 1 schedule "oci-capacity-acquire scheduled-master"
run_validator >/dev/null || fail "scheduled capacity run rejected"
ok "accept scheduled capacity run with its exact title"

# ------------------------------------------------------------ reject cases ---
expect_reject "rerun with current attempt 2" 2
expect_reject "wrong event" 1 push
expect_reject "wrong title" 1 workflow_dispatch "oci-capacity-acquire wrong"
expect_reject "scheduled title on a dispatch event" 1 workflow_dispatch \
  "oci-capacity-acquire scheduled-master"
expect_reject "wrong workflow path" 1 workflow_dispatch "" \
  ".github/workflows/oci-production-build.yml"
expect_reject "wrong repository" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "someone/else"
expect_reject "wrong branch" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" "dev"
expect_reject "wrong subject SHA" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" master "$(printf 'b%.0s' {1..40})"
expect_reject "incomplete run" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" master "$SUBJECT_SHA" in_progress
expect_reject "failed run" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" master "$SUBJECT_SHA" completed failure
expect_reject "wrong workflow id" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" master "$SUBJECT_SHA" completed success 999

artifact_case() {
  reset_fixtures
  write_capacity_fixtures
  fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/artifacts?per_page=100" <<<"$2"
  if run_validator >/dev/null; then
    fail "$1 was accepted"
  fi
  ok "reject $1"
}
artifact_case "missing artifact" '{"total_count":0,"artifacts":[]}'
artifact_case "expired artifact" \
  "{\"total_count\":1,\"artifacts\":[{\"name\":\"oci-capacity-provenance-$CAPACITY_RUN-1\",\"expired\":true,\"size_in_bytes\":10}]}"
artifact_case "zero-byte artifact" \
  "{\"total_count\":1,\"artifacts\":[{\"name\":\"oci-capacity-provenance-$CAPACITY_RUN-1\",\"expired\":false,\"size_in_bytes\":0}]}"
artifact_case "duplicate artifact" \
  "{\"total_count\":2,\"artifacts\":[{\"name\":\"oci-capacity-provenance-$CAPACITY_RUN-1\",\"expired\":false,\"size_in_bytes\":5},{\"name\":\"oci-capacity-provenance-$CAPACITY_RUN-1\",\"expired\":false,\"size_in_bytes\":5}]}"

reset_fixtures
write_capacity_fixtures
artifact_zip_fixture 9001 provenance.env \
  "source_sha=$(printf 'b%.0s' {1..40})
acquisition_run_id=$CAPACITY_RUN
runtime_mode=k3s
shape=VM.Standard.A1.Flex
ocpus=2
memory_gb=12
boot_volume_gb=50
boot_volume_vpus_per_gb=10
"
if run_validator >/dev/null; then
  fail "capacity artifact with wrong source SHA was accepted"
fi
[ "$(cat "$artifact_file.calls")" = 1 ] || fail "content mismatch triggered a retry"
ok "reject capacity artifact content mismatch"

reset_fixtures
write_capacity_fixtures
fixture "repos/$REPO/actions/runs/$CAPACITY_RUN" <<EOF2
{"id": 99, "run_attempt": 1, "workflow_id": $WORKFLOW_ID,
 "path": ".github/workflows/oci-capacity-acquire.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_dispatch",
 "display_title": "oci-capacity-acquire $SUBJECT_SHA"}
EOF2
if run_validator >/dev/null; then
  fail "run endpoint with a different ID was accepted"
fi
ok "reject run endpoint identity mismatch"

reset_fixtures
write_capacity_fixtures
fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/attempts/1" <<EOF2
{"id": $CAPACITY_RUN, "run_attempt": 1, "workflow_id": $WORKFLOW_ID,
 "path": ".github/workflows/oci-capacity-acquire.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$(printf 'c%.0s' {1..40})", "status": "completed",
 "conclusion": "success", "event": "workflow_dispatch",
 "display_title": "oci-capacity-acquire $SUBJECT_SHA"}
EOF2
if run_validator >/dev/null; then
  fail "attempt-1 identity mismatch was accepted"
fi
ok "reject attempt-1 identity mismatch"

write_build_package_fixtures() {
  local candidate_build_id="$1"
  local build_run=101 package_run=202
  fixture "repos/$REPO/actions/workflows/oci-production-build.yml" <<'EOF2'
{"id": 401}
EOF2
  fixture "repos/$REPO/actions/runs/$build_run" <<EOF2
{"id": $build_run, "run_attempt": 1, "workflow_id": 401,
 "path": ".github/workflows/oci-production-build.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_run", "display_title": "unpredictable build title",
 "created_at": "2026-01-01T00:00:00Z",
 "updated_at": "2026-01-01T00:10:00Z"}
EOF2
  fixture "repos/$REPO/actions/runs/$build_run/attempts/1" <<EOF2
{"id": $build_run, "run_attempt": 1, "workflow_id": 401,
 "path": ".github/workflows/oci-production-build.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_run", "display_title": "unpredictable build title"}
EOF2
  fixture "repos/$REPO/actions/runs/$build_run/artifacts?per_page=100" <<EOF2
{"total_count": 1, "artifacts": [{
 "id": 9101,
 "name": "oci-image-provenance-$SUBJECT_SHA-$build_run-1",
 "expired": false, "size_in_bytes": 2048}]}
EOF2
  artifact_zip_fixture 9101 build-chain.txt \
    "source_sha=$SUBJECT_SHA
build_run_id=$build_run
build_run_attempt=1
registry_provider=ghcr
registry_host=ghcr.io
registry_repository=ghcr.io/vasilyevstan/betstan-images
registry_public=true
anonymous_pull=pass
"

  fixture "repos/$REPO/actions/workflows/ghcr-package-management.yml" <<'EOF2'
{"id": 402}
EOF2
  fixture "repos/$REPO/actions/runs/$package_run" <<EOF2
{"id": $package_run, "run_attempt": 1, "workflow_id": 402,
 "path": ".github/workflows/ghcr-package-management.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_dispatch",
 "display_title": "ghcr-package validate $SUBJECT_SHA",
 "created_at": "2026-01-01T00:11:00Z",
 "updated_at": "2026-01-01T00:20:00Z"}
EOF2
  fixture "repos/$REPO/actions/runs/$package_run/attempts/1" <<EOF2
{"id": $package_run, "run_attempt": 1, "workflow_id": 402,
 "path": ".github/workflows/ghcr-package-management.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_dispatch",
 "display_title": "ghcr-package validate $SUBJECT_SHA"}
EOF2
  fixture "repos/$REPO/actions/runs/$package_run/artifacts?per_page=100" <<EOF2
{"total_count": 1, "artifacts": [{
 "id": 9102,
 "name": "ghcr-package-management-validate-$package_run-1",
 "expired": false, "size_in_bytes": 2048}]}
EOF2
  artifact_zip_fixture 9102 validation-summary.json \
    "{\"terminal_status\":\"VALIDATED\",\"registry_provider\":\"ghcr\",\"registry_host\":\"ghcr.io\",\"repository\":\"ghcr.io/vasilyevstan/betstan-images\",\"package_visibility\":\"public\",\"repository_linked\":true,\"candidate_build_run_id\":\"$candidate_build_id\"}"
}

reset_fixtures
write_build_package_fixtures 101
PATH="$WORK/bin:$PATH" "$VALIDATOR" validate-all \
  --repository "$REPO" \
  --policy-json "$("$POLICY" get oci-infrastructure-finalize-oke)" \
  --subject-sha "$SUBJECT_SHA" \
  --dispatch-inputs \
    '{"ghcr_build_run_id":"101","ghcr_package_validation_run_id":"202"}' \
  >/dev/null || fail "matching build/package content was rejected"
ok "accept package artifact bound to the exact build"

reset_fixtures
write_build_package_fixtures 999
if PATH="$WORK/bin:$PATH" "$VALIDATOR" validate-all \
  --repository "$REPO" \
  --policy-json "$("$POLICY" get oci-infrastructure-finalize-oke)" \
  --subject-sha "$SUBJECT_SHA" \
  --dispatch-inputs \
    '{"ghcr_build_run_id":"101","ghcr_package_validation_run_id":"202"}' \
  >/dev/null 2>&1; then
  fail "package artifact for a different candidate build was accepted"
fi
ok "reject package artifact for a different candidate build"

write_disk_infrastructure_fixture() {
  local bound_build="$1" bound_package="$2"
  fixture "repos/$REPO/actions/workflows/oci-infrastructure.yml" <<EOF2
{"id":403}
EOF2
  local endpoint
  for endpoint in "runs/303" "runs/303/attempts/1"; do
    fixture "repos/$REPO/actions/$endpoint" <<EOF2
{"id":303,"run_attempt":1,"workflow_id":403,
 "path":".github/workflows/oci-infrastructure.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$SUBJECT_SHA","status":"completed","conclusion":"success",
 "event":"workflow_dispatch",
 "display_title":"oci-infrastructure finalize k3s $SUBJECT_SHA"}
EOF2
  done
  fixture "repos/$REPO/actions/runs/303/artifacts?per_page=100" <<EOF2
{"total_count":1,"artifacts":[{"id":9103,
 "name":"oci-infrastructure-provenance-303-1",
 "expired":false,"size_in_bytes":1024}]}
EOF2
  artifact_zip_fixture 9103 provenance.env \
    "source_sha=$SUBJECT_SHA
infrastructure_run_id=303
infrastructure_run_attempt=1
infrastructure_finalized=true
runtime_mode=k3s
ghcr_build_run_id=$bound_build
ghcr_package_validation_run_id=$bound_package
capacity_acquisition_run_id=250
"
}

validate_disk_infrastructure() {
  local binding
  binding="$("$POLICY" get "$1" |
    jq -c '.upstreamRunBindings[] | select(.input == "infrastructure_run_id")')"
  PATH="$WORK/bin:$PATH" "$VALIDATOR" validate \
    --repository "$REPO" --binding "$binding" \
    --subject-sha "$SUBJECT_SHA" --run-id 303 \
    --dispatch-inputs \
      '{"ghcr_build_run_id":"101","ghcr_package_validation_run_id":"202"}'
}

for operation in oci-k3s-disk-diagnose oci-k3s-disk-reclaim-apt \
  oci-k3s-disk-reclaim-cri oci-k3s-disk-reclaim-journal; do
  reset_fixtures
  write_disk_infrastructure_fixture 101 202
  validate_disk_infrastructure "$operation" >/dev/null ||
    fail "$operation rejected its matching infrastructure build"
  write_disk_infrastructure_fixture 999 202
  if validate_disk_infrastructure "$operation" >/dev/null 2>&1; then
    fail "$operation accepted infrastructure from another same-SHA build"
  fi
  write_disk_infrastructure_fixture "" 202
  if validate_disk_infrastructure "$operation" >/dev/null 2>&1; then
    fail "$operation accepted infrastructure without build linkage"
  fi
done
ok "disk operations reject mismatched or absent infrastructure build linkage"
write_disk_infrastructure_fixture 101 999
if validate_disk_infrastructure oci-k3s-disk-reclaim-cri >/dev/null 2>&1; then
  fail "CRI reclaim accepted a package run not consumed by infrastructure"
fi
ok "CRI reclaim requires the infrastructure protected-package lineage"

reset_fixtures
if PATH="$WORK/bin:$PATH" "$VALIDATOR" validate --repository "$REPO" \
  --binding '{"input":"x","workflow":"a.yml","titleTemplates":{"workflow_run":null},"artifactTemplate":"only-{run_id}"}' \
  --subject-sha "$SUBJECT_SHA" --run-id 1 >/dev/null 2>&1; then
  fail "null title without a SHA-bound artifact was accepted"
fi
ok "reject null title unless the artifact binds subject SHA and run"

if PATH="$WORK/bin:$PATH" "$VALIDATOR" validate-all \
  --repository "$REPO" \
  --policy-json '{
    "upstreamRunBindings": [
      {
        "input": "duplicate",
        "workflow": "a.yml",
        "titleTemplates": {"workflow_dispatch": "a {subject_sha}"},
        "artifactTemplate": "a-{run_id}"
      },
      {
        "input": "duplicate",
        "workflow": "b.yml",
        "titleTemplates": {"workflow_dispatch": "b {subject_sha}"},
        "artifactTemplate": "b-{run_id}"
      }
    ]
  }' \
  --subject-sha "$SUBJECT_SHA" \
  --dispatch-inputs '{"duplicate":"1"}' >/dev/null 2>&1; then
  fail "duplicate binding inputs were accepted"
fi
ok "reject duplicate binding inputs"

if PATH="$WORK/bin:$PATH" "$VALIDATOR" validate-all \
  --repository "$REPO" \
  --policy-json '{
    "upstreamRunBindings": [
      {
        "input": "current",
        "afterInput": "missing",
        "workflow": "a.yml",
        "titleTemplates": {"workflow_dispatch": "a {subject_sha}"},
        "artifactTemplate": "a-{run_id}"
      }
    ]
  }' \
  --subject-sha "$SUBJECT_SHA" \
  --dispatch-inputs '{"current":"1"}' >/dev/null 2>&1; then
  fail "unknown chronology dependency was accepted"
fi
ok "reject unknown chronology dependencies"

# ---------------------------------------------------- k3s / OKE mode split ---
"$POLICY" get oci-infrastructure-finalize-k3s | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert p["fixedInputs"]["runtime_mode"] == "k3s"
assert "capacity_acquisition_run_id" in p["positiveIntegerInputs"]
assert "capacity_acquisition_run_id" not in p["fixedInputs"]
assert [b["input"] for b in p["upstreamRunBindings"]] == [
    "ghcr_build_run_id", "ghcr_package_validation_run_id",
    "capacity_acquisition_run_id"]
' || fail "k3s finalize policy is wrong"
ok "k3s finalize requires the exact capacity run"

"$POLICY" get oci-infrastructure-finalize-oke | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert p["fixedInputs"]["runtime_mode"] == "oke"
assert p["fixedInputs"]["capacity_acquisition_run_id"] == ""
assert "capacity_acquisition_run_id" not in p["positiveIntegerInputs"]
assert [b["input"] for b in p["upstreamRunBindings"]] == [
    "ghcr_build_run_id", "ghcr_package_validation_run_id"]
' || fail "OKE finalize policy is wrong"
ok "OKE finalize forces an empty capacity run and keeps GHCR bindings"

"$POLICY" get oci-infrastructure-finalize-k3s | python3 -c '
import json, sys
by = {b["input"]: b for b in json.load(sys.stdin)["upstreamRunBindings"]}
build = by["ghcr_build_run_id"]
assert build["artifactTemplate"] == "oci-image-provenance-{subject_sha}-{run_id}-1"
assert build["titleTemplates"] == {"workflow_run": None}
pkg = by["ghcr_package_validation_run_id"]
assert pkg["titleTemplates"] == {"workflow_dispatch": "ghcr-package validate {subject_sha}"}
assert pkg["artifactTemplate"] == "ghcr-package-management-validate-{run_id}-1"
assert pkg["afterInput"] == "ghcr_build_run_id"
cap = by["capacity_acquisition_run_id"]
assert cap["titleTemplates"] == {
    "workflow_dispatch": "oci-capacity-acquire {subject_sha}",
    "schedule": "oci-capacity-acquire scheduled-master"}
assert "titleOptionalEvents" not in cap
assert cap["afterInput"] == "ghcr_package_validation_run_id"
' || fail "finalize prerequisite bindings are incomplete"
ok "GHCR build and package validation are bound like capacity"

"$POLICY" get oci-k3s-disk-diagnose | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert p["fixedInputs"]["phase"] == "diagnose-disk"
assert p["fixedInputs"]["runtime_mode"] == "k3s"
assert p["fixedInputs"]["reclaim_category"] == "none"
assert p["fixedInputs"]["reclaim_image_ids"] == "[]"
assert [b["input"] for b in p["upstreamRunBindings"]] == [
    "ghcr_build_run_id", "infrastructure_run_id"]
infra = p["upstreamRunBindings"][1]
assert infra["afterInput"] == "ghcr_build_run_id"
assert infra["titleTemplates"] == {
    "workflow_dispatch": "oci-infrastructure finalize k3s {subject_sha}"}
assert infra["artifactContent"]["equals"]["infrastructure_finalized"] == "true"
assert infra["artifactContent"]["equals"]["ghcr_build_run_id"] == \
    "{input:ghcr_build_run_id}"
' || fail "k3s disk diagnosis policy is wrong"
ok "disk diagnosis binds current-SHA build and finalized k3s infrastructure"

"$POLICY" get oci-k3s-disk-reclaim-apt | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert p["fixedInputs"]["phase"] == "reclaim-disk"
assert p["fixedInputs"]["runtime_mode"] == "k3s"
assert [b["input"] for b in p["upstreamRunBindings"]] == [
    "ghcr_build_run_id", "infrastructure_run_id", "diagnosis_run_id"]
diagnosis = p["upstreamRunBindings"][2]
assert diagnosis["afterInput"] == "infrastructure_run_id"
assert diagnosis["artifactTemplate"] == "oci-k3s-disk-diagnosis-{run_id}-1"
equals = diagnosis["artifactContent"]["equals"]
assert equals["phase"] == "diagnose-disk"
assert equals["sourceSha"] == "{subject_sha}"
assert equals["infrastructureRunId"] == "{input:infrastructure_run_id}"
assert equals["ghcrBuildRunId"] == "{input:ghcr_build_run_id}"
assert equals["terminalStatus"] == "DIAGNOSED"
' || fail "apt disk reclaim policy is wrong"

"$POLICY" all | python3 -c '
import json, sys
policies = {p["operation"]: p for p in json.load(sys.stdin)}
apt = policies["oci-k3s-disk-reclaim-apt"]
journal = policies["oci-k3s-disk-reclaim-journal"]
assert journal["subjectRelation"] == "current"
assert journal["environment"] == "oci-infrastructure"
assert journal["fixedInputs"]["phase"] == "reclaim-disk"
assert journal["fixedInputs"]["reclaim_category"] == "system-journal"
assert journal["fixedInputs"]["reclaim_image_ids"] == "[]"
assert journal["fixedInputs"]["ghcr_package_validation_run_id"] == ""
assert journal["inputNames"] == apt["inputNames"]
assert journal["upstreamRunBindings"] == apt["upstreamRunBindings"]
assert journal["upstreamRunBindings"][-1]["artifactContent"]["equals"]["schemaVersion"] == \
    "k3s-node-disk-diagnosis.v2"
assert set(journal["inputNames"]).isdisjoint(
    {"journal_path", "vacuum_size", "retry", "fallback", "environment"}
)
journal["operation"] = apt["operation"]
journal["fixedInputs"]["reclaim_category"] = "apt-package-cache"
assert journal == apt
' || fail "journal disk reclaim did not preserve exact non-CRI authority"
ok "journal reclaim has distinct fixed operation and unchanged non-CRI bindings"

"$POLICY" get oci-k3s-disk-reclaim-cri | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert p["fixedInputs"]["phase"] == "reclaim-disk"
assert p["fixedInputs"]["runtime_mode"] == "k3s"
assert "ghcr_package_validation_run_id" in p["positiveIntegerInputs"]
assert [b["input"] for b in p["upstreamRunBindings"]] == [
    "ghcr_build_run_id", "ghcr_package_validation_run_id",
    "infrastructure_run_id", "diagnosis_run_id"]
package = p["upstreamRunBindings"][1]
assert package["afterInput"] == "ghcr_build_run_id"
assert package["artifactContent"]["equals"]["terminal_status"] == "VALIDATED"
assert package["artifactContent"]["equals"]["candidate_build_run_id"] == \
    "{input:ghcr_build_run_id}"
infra = p["upstreamRunBindings"][2]
assert infra["afterInput"] == "ghcr_package_validation_run_id"
assert infra["artifactContent"]["equals"]["ghcr_package_validation_run_id"] == \
    "{input:ghcr_package_validation_run_id}"
diagnosis = p["upstreamRunBindings"][3]
assert diagnosis["afterInput"] == "infrastructure_run_id"
assert diagnosis["artifactTemplate"] == "oci-k3s-disk-diagnosis-{run_id}-1"
' || fail "CRI disk reclaim policy is wrong"
ok "disk reclaim binds diagnosis and CRI additionally binds protected generations"

for operation in \
  oci-infrastructure-prepare-k3s \
  oci-infrastructure-prepare-oke \
  oci-infrastructure-finalize-k3s \
  oci-infrastructure-finalize-oke; do
  "$POLICY" get "$operation" | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert len(p["inputNames"]) == 16
assert "infrastructure_run_id" not in p["inputNames"]
assert "diagnosis_run_id" not in p["inputNames"]
assert "reclaim_category" not in p["inputNames"]
assert "reclaim_image_ids" not in p["inputNames"]
' || fail "$operation silently acquired disk-recovery inputs"
done
ok "legacy prepare/finalize policy input contracts remain unchanged"

# ------------------------------------------- input hash must include the run ---
policy_file="$WORK/policy.json"
"$POLICY" get oci-infrastructure-finalize-k3s >"$policy_file"
emit_hash() {
  python3 - "$1" >"$WORK/request.json" <<'PY'
import json
import sys
print(json.dumps({
    "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
    "repository": "vasilyevstan/betstan",
    "operation": "oci-infrastructure-finalize-k3s",
    "controlSha": "a" * 40, "subjectSha": "a" * 40, "targetSha": None,
    "inputs": {
        "approved_sha": "a" * 40,
        "confirmation": "PROVISION OCI ZERO COST", "phase": "finalize",
        "candidate_build_run_id": "", "obsolete_sha": "",
        "obsolete_build_run_id": "", "obsolete_generations": "",
        "deployed_sha": "", "deployed_run_id": "", "fallback_sha": "",
        "fallback_build_run_id": "", "validation_run_id": "",
        "ghcr_build_run_id": "11", "ghcr_package_validation_run_id": "22",
        "capacity_acquisition_run_id": sys.argv[1], "runtime_mode": "k3s",
    },
}))
PY
  chmod 600 "$WORK/request.json"
  "$AUTHORITY_HELPER" validate-request \
    --request "$WORK/request.json" --policy-json "$(cat "$policy_file")" \
    --repository "$REPO" --current-master "$(printf 'a%.0s' {1..40})" \
    --repo-root "$WORK/repository" --output "$WORK/normalized-$1.json" >/dev/null
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["inputHash"])' \
    "$WORK/normalized-$1.json"
}
hash_a="$(emit_hash 4444)" || fail "normalization failed for capacity run 4444"
hash_b="$(emit_hash 5555)" || fail "normalization failed for capacity run 5555"
[ "$hash_a" != "$hash_b" ] ||
  fail "explicit capacity run ID does not change the dispatch input hash"
ok "capacity run ID is covered by the dispatch input hash"

# ----------------------------- validation precedes authority and cloud use ---
# Reuse the canonical lifecycle/locked-CAS assertions; below, bind their
# ordering to the ordinary upstream checks and the one shared provider call.
"$ROOT_DIR/infra/oci/tests/test-contract.sh" --prepared-transition-only ||
  fail "prepared transition contract failed"
python3 - "$DISPATCHER" "$AUTHORITY_HELPER" <<'PY' || fail "prerequisites are not proven before authority"
import ast
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
authority = open(sys.argv[2], encoding="utf-8").read()

def ordered(source, *needles):
    cursor = 0
    for needle in needles:
        cursor = source.index(needle, cursor) + len(needle)

definition = text.index("validate_protected_prerequisites() {")
materialization = text.index("materialize_record() {")
resume_validation = text.index("resume_with_prerequisite_validation() {")
resume_run = text.index('if [[ "$ACTION" = "--resume-run" ]]; then')
resume_captured = text.index('if [[ "$ACTION" = "--resume-captured" ]]; then')
if not materialization < definition < resume_validation < resume_run < resume_captured:
    raise SystemExit("materialization and validator must precede both resume paths")
for start in (resume_run, resume_captured):
    window = text[start:start + 800]
    if "bind-intent" not in window or "resume_with_prerequisite_validation" not in window:
        raise SystemExit("a resume path does not bind and validate its exact run")
    if window.index("bind-intent") > window.index("resume_with_prerequisite_validation"):
        raise SystemExit("a resume path validates before binding the captured run")
materialization_body = text[
    materialization:text.index("\nif [[ -n \"$ACTION\" ]]", materialization)
]
if materialization_body.index("validate_protected_prerequisites") > materialization_body.index(
    '"$AUTHORITY_HELPER" issue'
):
    raise SystemExit("a materialized claim can be issued before prerequisites pass")
if "begin_prerequisite_rejection" not in materialization_body:
    raise SystemExit("materialization does not persist prerequisite rejection")
retirement = text[
    text.index("begin_prerequisite_rejection() {"):resume_validation
]
for required in (
    "begin-prerequisite-rejection",
    'actions/runs/$run_id/cancel',
    "retire-prerequisite-rejected-claim",
):
    if required not in retirement:
        raise SystemExit(f"resume rejection omits safe terminalization: {required}")
ready = text.rfind("\n", 0, text.index("dispatch=READY operation=")) + 1
# Parse the two-action allowlist, not a spelling/order of the old single-action
# guard. A third action, wildcard, or arbitrary nonempty ACTION is not allowed.
guards = list(re.finditer(
    r'(?m)^\[\[\s+"\$ACTION"\s*=\s*"([^"]+)"\s*\|\|\s*'
    r'"\$ACTION"\s*=\s*"([^"]+)"\s*\]\]\s*\|\|\s*exit 0$',
    text[ready:],
))
assert len(guards) == 1 and set(guards[0].groups()) == {"--dispatch", "--dispatch-prepared"}
guard = ready + guards[0].start()
selection = text[text.index('if [[ "$ACTION" = "--dispatch-prepared" ]]; then'):ready]
prepared = selection[:selection.index('\nelif [[ "$ACTION" = "--prepare-disabled-ghosts" ]]; then')]
ordinary = selection[selection.rindex("\nelse\n") + len("\nelse\n"):]
assert [line.strip() for line in ordinary.splitlines() if line.strip()] == [
    "validate_protected_prerequisites", "fi",
], "ordinary validation must remain unconditional before READY"
ordered(prepared, 'post_a="$(prepared_checkpoint verify-prepared active)"',
        "validate_protected_prerequisites", "revalidate_transition_target active",
        'intent_summary="$(', "prepared_checkpoint dispatch-prepared active",
        '--expected-snapshot "$(jq -r \'.snapshot\' <<<"$post_a")"')
ordinary_start = text.index('if [[ "$ACTION" = "--dispatch" ]]; then', guard)
claim = text.index('"$AUTHORITY_HELPER" claim-request', guard)
post_claim = text.index("dispatch_revalidation_error=", claim)
dispatch = text.index("gh workflow run", post_claim)
assert ready < guard < ordinary_start < claim < post_claim < dispatch
ordered(text[ordinary_start:claim], "blocking-record",
        "revalidate_dispatch_target", "validate_production_exclusivity",
        "revalidate_dispatch_target")
post_claim_body = text[post_claim:dispatch]
ordered(post_claim_body, "revalidate_dispatch_target",
        "validate_protected_prerequisites", "revalidate_dispatch_target",
        "validate_production_exclusivity", "revalidate_dispatch_target")
prepared_fallthrough = text[text.rindex("\nelse\n", post_claim, dispatch):dispatch]
ordered(prepared_fallthrough, '= dispatching ]] ||',
        'fail "prepared CAS did not claim dispatch authority"',
        'capture_path="$(jq -r \'.capturePath\' <<<"$intent_summary")"', "set +e")

# Both POST checkpoints freshly collect evidence between exact active-target
# checks; only then may the same verifier inspect the sealed authority.
checkpoint = text[text.index("prepared_checkpoint() {"):
                  text.index("summarize_prerequisite_failure() {")]
ordered(checkpoint, 'revalidate_transition_target "$required_state"',
        '"$RUN_EXCLUSIVITY_SCRIPT" \\\n    --observe-disabled-transition "$workflow"',
        'revalidate_transition_target "$required_state"', '"$AUTHORITY_HELPER" "$command"')
assert '--observe-live-data-transition' not in text, "retired observation flag has no alias"
target = text[text.index("revalidate_transition_target() {"):text.index("prepared_checkpoint() {")]
ordered(target, "rev-parse HEAD", "status --porcelain", "revalidate_control",
        'actions/workflows/$workflow',
        '[[ "$observed_workflow" = "$(printf',
        '"$workflow_id" ".github/workflows/$workflow" "$required_state")" ]] ||')

# The shared contract proves lock containment and cohesive verifier delegation.
# Add ordering, rather than a second policy: slow repository scans and the
# snapshot rejection must precede the final lifetime check and state write.
functions = {node.name: node for node in ast.parse(authority).body
             if isinstance(node, ast.FunctionDef)}
verifier = functions["verify_prepared_checkpoint"]
def call(node, name):
    matches = [item for item in ast.walk(node) if isinstance(item, ast.Call)
               and isinstance(item.func, ast.Name) and item.func.id == name]
    assert len(matches) == 1, f"expected one {name} call in bounded scope"
    return matches[0]
cas = next(node for node in ast.walk(verifier) if isinstance(node, ast.If)
           and isinstance(node.test, ast.Name) and node.test.id == "dispatch")
def rejection(left):
    node = next(node for node in ast.walk(verifier) if isinstance(node, ast.If)
                and isinstance(node.test, ast.Compare)
                and isinstance(node.test.left, ast.Name) and node.test.left.id == left)
    assert len(node.test.ops) == 1 and isinstance(node.test.ops[0], ast.NotEq)
    call(node, "fail")
    return node
blockers = rejection("blockers")
snapshot = rejection("snapshot")
assert ast.dump(blockers.test.comparators[0]) == ast.dump(ast.parse(
    '[(f"intent:{key}", "prepared")]', mode="eval").body)
assert ast.dump(snapshot.test.comparators[0]) == ast.dump(ast.parse(
    "args.expected_snapshot", mode="eval").body)
lock = next(node for node in ast.walk(verifier) if isinstance(node, ast.With)
            and any(isinstance(item.context_expr, ast.Call)
                    and isinstance(item.context_expr.func, ast.Name)
                    and item.context_expr.func.id == "repository_claim_lock"
                    for item in node.items))
locked = {node for statement in lock.body for node in ast.walk(statement)}
assert {cas, blockers, snapshot, call(verifier, "find_blocking_authorities"),
        call(verifier, "prepared_snapshot")} <= locked, (
    "repository scan, snapshot checks and CAS must share the claim lock"
)
state_write = next(node for node in cas.body if isinstance(node, ast.Assign)
                   and ast.dump(node.targets[0]) == ast.dump(ast.parse(
                       'intent["state"] = "dispatching"').body[0].targets[0]))
assert isinstance(state_write.value, ast.Constant) and state_write.value.value == "dispatching"
assert (call(verifier, "find_blocking_authorities").lineno < blockers.lineno
        < call(verifier, "prepared_snapshot").lineno < snapshot.lineno
        < call(cas, "require_prepared_lifetime").lineno < state_write.lineno
        < call(cas, "atomic_replace").lineno)
if ".dispatchInputs" not in text:
    raise SystemExit("dispatcher must read the hashed dispatchInputs map")
if "OCI_RUNTIME_MODE" not in text:
    raise SystemExit("dispatcher must prove the authoritative runtime mode")
print("ordering ok")
PY
ok "ordinary/prepared dispatch and bound resume preserve prerequisite and CAS ordering"

expect_dispatch_usage() {
  if PATH="$WORK/bin:$PATH" COPILOT_CLI_AUTHORITY_DIR="$WORK/rejected-authority" \
    "$DISPATCHER" "$WORK/request.json" "$@" >"$WORK/action-error" 2>&1; then
    fail "invalid dispatcher actions were accepted: $*"
  fi
  grep -q '^usage:' "$WORK/action-error" ||
    fail "invalid dispatcher actions reached validation instead of usage: $*"
}
expect_dispatch_usage --unknown-action
expect_dispatch_usage --dispatch --dispatch-prepared
expect_dispatch_usage --dispatch-prepared --dispatch
expect_dispatch_usage --resume-captured --dispatch
expect_dispatch_usage --resume-run 0
ok "unknown, conflicting and malformed normal actions are rejected"

python3 - "$WORKFLOW" "$ROOT_DIR/infra/oci/scripts/bind-infrastructure-prerequisites-stan.sh" \
  <<'PY' || fail "workflow validates bindings after cloud access"
import sys

text = open(sys.argv[1], encoding="utf-8").read()
gate_body = open(sys.argv[2], encoding="utf-8").read()
provision = text.index("\n  provision:")
gate = text.index("Bind runtime mode and prove upstream prerequisites", provision)
ghcr = text.index("Verify GHCR build and package evidence content", provision)
capacity = text.index("Download bound k3s capacity provenance", provision)
install = text.index("Install pinned OCI CLI", provision)
refresh = text.index("Revalidate exact authority before cloud access", provision)
identity = text.index("Verify OCI identity", provision)
cloud = text.index("Zero-cost preflight and cloud reconciliation", provision)
for name in (
    "Install pinned OCI CLI",
    "Revalidate exact authority before cloud access",
    "Verify OCI identity",
    "Zero-cost preflight and cloud reconciliation",
    "Reconcile expired GitHub runner rules",
    "Install pinned cluster add-ons",
    "Open ephemeral OCI Bastion access",
):
    if not gate < ghcr < capacity < text.index(name, provision):
        raise SystemExit(f"binding validation must precede: {name}")
if not capacity < install < refresh < identity < cloud:
    raise SystemExit(
        "exact authority must be refreshed in provision immediately before OCI identity"
    )
if text.count("Revalidate exact authority before cloud access") != 1:
    raise SystemExit("exact cloud-boundary refresh must exist only in provision")
gate_step_body = text[gate:ghcr]
for required in (
    'GH_TOKEN: ${{ github.token }}',
    'REPOSITORY: ${{ github.repository }}',
):
    if required not in gate_step_body:
        raise SystemExit(f"upstream prerequisite gate omits: {required}")
refresh_body = text[refresh:identity]
for required in (
    'GH_TOKEN: ${{ github.token }}',
    'REPOSITORY: ${{ github.repository }}',
    'git fetch --quiet origin master:refs/remotes/origin/master',
    '[ "$SOURCE_SHA" = "$(git rev-parse origin/master)" ]',
    '[ "$OCI_RUNTIME_MODE" = "$BOUND_RUNTIME_MODE" ]',
    'bind-infrastructure-prerequisites-stan.sh',
):
    if required not in refresh_body:
        raise SystemExit(f"cloud-boundary refresh omits: {required}")
if "/environments/" in refresh_body:
    raise SystemExit("workflow GITHUB_TOKEN cannot query environment variables")
if refresh_body.count("revalidate_mutable_authority") != 3:
    raise SystemExit("cloud-boundary refresh must bracket upstream validation")
first_refresh = refresh_body.index("revalidate_mutable_authority", refresh_body.index("}") + 1)
binding_refresh = refresh_body.index("bind-infrastructure-prerequisites-stan.sh")
last_refresh = refresh_body.rindex("revalidate_mutable_authority")
if not first_refresh < binding_refresh < last_refresh:
    raise SystemExit("mutable authority is not rechecked after upstream validation")
if "--workflow oci-capacity-acquire.yml" in text:
    raise SystemExit("finalize still scans for capacity runs")
# The gate body lives in an executable script so it can be run under `set -u`
# instead of only statically inspected; the workflow must invoke exactly it.
if "bind-infrastructure-prerequisites-stan.sh" not in text:
    raise SystemExit("workflow does not invoke the extracted prerequisite gate")
if "DISPATCH_INPUTS: ${{ toJSON(inputs) }}" not in text:
    raise SystemExit("workflow does not export the real dispatch input map")
if "source artifacts/oci-capacity/provenance.env" in text:
    raise SystemExit("capacity provenance can overwrite values it is checked against")
if "capacity provenance contains an unsafe or duplicate assignment" not in text:
    raise SystemExit("capacity provenance is not parsed without shell evaluation")
if 'BOUND_RUNTIME_MODE" = "$OCI_RUNTIME_MODE' not in gate_body:
    raise SystemExit("gate does not bind runtime mode to the environment")
if "validate-all" not in gate_body:
    raise SystemExit("gate does not use the shared upstream validator")
if "$DISPATCH_INPUTS" not in gate_body:
    raise SystemExit("gate does not forward the exported dispatch input map")
# Run identity for the finalize prerequisites belongs to the shared validator.
# A second, weaker copy inside the GHCR/capacity evidence steps is exactly the
# drift this contract exists to prevent. Unrelated phases (registry prune,
# image provenance) keep their own long-standing validate_run helper.
evidence = text.index("Verify GHCR build and package evidence content", provision)
after_capacity = text.index(
    "Install pinned OCI CLI", provision
)
finalize_region = text[evidence:after_capacity]
for duplicated in ("head_sha", "run_attempt", "actions/workflows/"):
    if duplicated in finalize_region:
        raise SystemExit(
            f"finalize evidence steps duplicate run identity: {duplicated}"
        )
print("workflow ordering ok")
PY
ok "workflow proves bindings before every cloud access and mutation"

for forbidden in SKIP_CAPACITY FORCE_FINALIZE BYPASS_CAPACITY IGNORE_UPSTREAM \
  titleOptionalEvents allow-missing-upstream; do
  if grep -rqF -- "$forbidden" "$DISPATCHER" "$WORKFLOW" "$POLICY" "$VALIDATOR"; then
    fail "a bypass or escape hatch is present: $forbidden"
  fi
done
ok "no force, retry, skip or allow-missing knob was introduced"

# The workflow reads a checked-in manifest so it never depends on the Azure
# agent tree. Prove that manifest is exactly the policy the dispatcher uses.
python3 - "$POLICY" "$BINDING_MANIFEST" <<'EQUIV' || fail "binding manifest drifted from the policy"
import json
import subprocess
import sys

policy_script, manifest_path = sys.argv[1:3]
manifest = json.load(open(manifest_path, encoding="utf-8"))
if sorted(manifest) != [
    "oci-infrastructure-finalize-k3s",
    "oci-infrastructure-finalize-oke",
    "oci-k3s-disk-diagnose",
    "oci-k3s-disk-reclaim-apt",
    "oci-k3s-disk-reclaim-cri",
    "oci-k3s-disk-reclaim-journal",
]:
    raise SystemExit("manifest does not cover the exact bound infrastructure operations")
for operation, bindings in manifest.items():
    policy = json.loads(
        subprocess.run(
            [policy_script, "get", operation],
            capture_output=True, text=True, check=True,
        ).stdout
    )
    if policy["upstreamRunBindings"] != bindings:
        raise SystemExit(f"{operation} manifest differs from the policy")
for operation in (
    "oci-infrastructure-prepare-k3s",
    "oci-infrastructure-prepare-oke",
):
    policy = json.loads(
        subprocess.run(
            [policy_script, "get", operation],
            capture_output=True, text=True, check=True,
        ).stdout
    )
    if policy["upstreamRunBindings"] != []:
        raise SystemExit(f"{operation} silently bypasses declared prerequisites")
print("manifest equivalence ok")
EQUIV
ok "workflow binding manifest is byte-equivalent to the dispatcher policy"

for operation in oci-k3s-disk-reclaim-apt oci-k3s-disk-reclaim-cri \
  oci-k3s-disk-reclaim-journal; do
  reset_fixtures
  diagnosis_binding="$(
    jq -c --arg operation "$operation" \
      '.[$operation][] | select(.input == "diagnosis_run_id")' "$BINDING_MANIFEST"
  )"
  fixture "repos/$REPO/actions/workflows/oci-infrastructure.yml" <<'JSON'
{"id":325567150}
JSON
  for endpoint in actions/runs/45 actions/runs/45/attempts/1; do
    fixture "repos/$REPO/$endpoint" <<JSON
{"id":45,"run_attempt":1,"workflow_id":325567150,
 "path":".github/workflows/oci-infrastructure.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$SUBJECT_SHA","status":"completed","conclusion":"success",
 "event":"workflow_dispatch",
 "display_title":"oci-infrastructure diagnose-disk k3s $SUBJECT_SHA"}
JSON
  done
  fixture "repos/$REPO/actions/runs/45/artifacts?per_page=100" <<'JSON'
{"total_count":1,"artifacts":[{"name":"oci-k3s-disk-diagnosis-45-1",
 "id":9045,"expired":false,"size_in_bytes":1024}]}
JSON
  diagnosis_content="$(jq -cn --arg sha "$SUBJECT_SHA" '{
    schemaVersion:"k3s-node-disk-diagnosis.v2",phase:"diagnose-disk",
    sourceSha:$sha,infrastructureRunId:"44",ghcrBuildRunId:"41",
    workflowRunId:"45",workflowRunAttempt:"1",thresholdPercent:70,
    terminalStatus:"DIAGNOSED"
  }')"
  artifact_zip_fixture 9045 diagnosis.json "$diagnosis_content"
  validator_args=(
    validate --repository "$REPO" --binding "$diagnosis_binding"
    --subject-sha "$SUBJECT_SHA" --run-id 45
    --dispatch-inputs '{"diagnosis_run_id":"45","infrastructure_run_id":"44","ghcr_build_run_id":"41"}'
  )
  PATH="$WORK/bin:$PATH" "$VALIDATOR" "${validator_args[@]}" \
    >"$WORK/diagnosis-result" 2>"$WORK/err.txt" ||
    fail "$operation rejected diagnosis v2: $(cat "$WORK/err.txt")"
  ok "$operation accepts its exact v2 diagnosis binding"
  artifact_zip_fixture 9045 diagnosis.json "$(
    jq -c '.schemaVersion = "k3s-node-disk-diagnosis.v1"' <<<"$diagnosis_content"
  )"
  if PATH="$WORK/bin:$PATH" "$VALIDATOR" "${validator_args[@]}" \
      >"$WORK/diagnosis-result" 2>"$WORK/err.txt"; then
    fail "$operation accepted a legacy v1 diagnosis binding"
  fi
  grep -qF "schemaVersion" "$WORK/err.txt" ||
    fail "$operation failed for a reason other than schema identity"
  ok "$operation rejects legacy v1 diagnosis for current authority"
done

# ---------------- fixed declarative fields and recovery run profiles ----------
run_custom_binding() {
  local binding="$1" run_id="$2" inputs="${3:-}" runtime_mode="${4:-}"
  [ -n "$inputs" ] || inputs='{}'
  local args=(
    validate --repository "$REPO" --binding "$binding"
    --subject-sha "$SUBJECT_SHA" --run-id "$run_id"
    --dispatch-inputs "$inputs"
  )
  [ -z "$runtime_mode" ] || args+=(--runtime-mode "$runtime_mode")
  PATH="$WORK/bin:$PATH" "$VALIDATOR" "${args[@]}" 2>"$WORK/err.txt"
}

for invalid_binding in \
  "$(jq -c '.unexpectedField = true' <<<"$CAPACITY_BINDING_JSON")" \
  "$(jq -c '.artifactValidatorProfile = "arbitrary-plugin"' <<<"$CAPACITY_BINDING_JSON")" \
  "$(jq -c '.runProfile = "arbitrary-command" | .expectedConclusion = "failure"' \
    <<<"$CAPACITY_BINDING_JSON")" \
  "$(jq -c '.expectedConclusion = "failure"' <<<"$CAPACITY_BINDING_JSON")"; do
  reset_fixtures
  if run_custom_binding "$invalid_binding" "$CAPACITY_RUN" >/dev/null; then
    fail "unsupported declarative binding shape was accepted"
  fi
  ok "reject unsupported or unpaired declarative binding field"
done

checkpoint_binding="$(
  jq -cn '{
    input:"disk_checkpoint_run_id",
    workflow:"oci-infrastructure.yml",
    titleTemplates:{workflow_dispatch:null},
    artifactTemplate:"oci-release-disk-checkpoint-{subject_sha}-{run_id}-1",
    expectedHeadShaInput:"checkpoint_source_sha",
    artifactValidatorProfile:"oci-release-disk-checkpoint-v1"
  }'
)"

write_oke_checkpoint_fixtures() {
  local source_sha="$1" run_id="$2" artifact_id="$3"
  local checkpoint
  fixture "repos/$REPO/actions/workflows/oci-infrastructure.yml" <<EOF2
{"id": $WORKFLOW_ID}
EOF2
  for endpoint in \
    "repos/$REPO/actions/runs/$run_id" \
    "repos/$REPO/actions/runs/$run_id/attempts/1"; do
    fixture "$endpoint" <<EOF2
{"id":$run_id,"run_attempt":1,"workflow_id":$WORKFLOW_ID,
 "path":".github/workflows/oci-infrastructure.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$source_sha","status":"completed","conclusion":"success",
 "event":"workflow_dispatch",
 "display_title":"oci-infrastructure finalize oke $source_sha",
 "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:01:00Z"}
EOF2
  done
  fixture "repos/$REPO/actions/runs/$run_id/artifacts?per_page=100" <<EOF2
{"total_count":1,"artifacts":[{
 "name":"oci-release-disk-checkpoint-$source_sha-$run_id-1",
 "id":$artifact_id,"expired":false,"size_in_bytes":1024}]}
EOF2
  checkpoint="$(python3 - "$source_sha" "$run_id" <<'PY'
import hashlib
import json
import sys

source_sha, run_id = sys.argv[1:]
value = {
    "schemaVersion": "k3s-release-disk-checkpoint.v1",
    "sourceSha": source_sha,
    "controlSha": source_sha,
    "infrastructureRunId": run_id,
    "ghcrBuildRunId": "41",
    "producerRunId": run_id,
    "producerRunAttempt": "1",
    "runtimeMode": "oke",
    "disposition": "NOT_APPLICABLE",
    "terminalStatus": "RELEASE_ELIGIBLE",
}
value["contentChecksumSha256"] = hashlib.sha256(
    json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
print(json.dumps(value, sort_keys=True, separators=(",", ":")))
PY
)"
  artifact_zip_fixture "$artifact_id" checkpoint.json "$checkpoint"
}

reset_fixtures
write_oke_checkpoint_fixtures "$SUBJECT_SHA" 600 9600
run_custom_binding "$checkpoint_binding" 600 \
  "{\"checkpoint_source_sha\":\"$SUBJECT_SHA\",\"infrastructure_run_id\":\"600\",\"build_run_id\":\"41\"}" \
  oke >/dev/null ||
  fail "valid OKE release checkpoint binding was rejected: $(cat "$WORK/err.txt")"
ok "accept repository-fixed OKE checkpoint profile with authoritative runtime"

if run_custom_binding "$checkpoint_binding" 600 \
    "{\"checkpoint_source_sha\":\"$SUBJECT_SHA\",\"infrastructure_run_id\":\"600\",\"build_run_id\":\"41\"}" \
    k3s >/dev/null; then
  fail "checkpoint runtime mode mismatch was accepted"
fi
ok "reject checkpoint runtime mode mismatch"

if run_custom_binding "$checkpoint_binding" 600 '{}' oke >/dev/null; then
  fail "missing expectedHeadShaInput was accepted"
fi
ok "reject missing hash-covered expected checkpoint source"

profile_binding() {
  local profile="$1" workflow input artifact title
  if [ "$profile" = "oci-failed-activation-cleanup-v1" ]; then
    workflow=oci-live-betting-activate.yml
    input=failed_activation_run_id
    artifact=oci-live-activation-recovery-{run_id}-1
    title='oci-live-activate {subject_sha}'
  else
    workflow=oci-production-deploy.yml
    input=failed_deploy_run_id
    artifact=oci-production-baseline-{run_id}-1
    title='oci-deploy {subject_sha}'
  fi
  jq -cn \
    --arg profile "$profile" --arg workflow "$workflow" --arg input "$input" \
    --arg artifact "$artifact" --arg title "$title" '{
      input:$input,workflow:$workflow,
      titleTemplates:{workflow_dispatch:$title},
      artifactTemplate:$artifact,expectedConclusion:"failure",
      runProfile:$profile
    }'
}

write_profile_run() {
  local run_id="$1" workflow="$2" title="$3"
  local workflow_id="$4" artifact="$5"
  local head_sha="${6:-$SUBJECT_SHA}"
  fixture "repos/$REPO/actions/workflows/$workflow" <<EOF2
{"id":$workflow_id}
EOF2
  for endpoint in \
    "repos/$REPO/actions/runs/$run_id" \
    "repos/$REPO/actions/runs/$run_id/attempts/1"; do
    fixture "$endpoint" <<EOF2
{"id":$run_id,"run_attempt":1,"workflow_id":$workflow_id,
 "path":".github/workflows/$workflow",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$head_sha","status":"completed","conclusion":"failure",
 "event":"workflow_dispatch","display_title":"$title",
 "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:01:00Z"}
EOF2
  done
  fixture "repos/$REPO/actions/runs/$run_id/artifacts?per_page=100" <<EOF2
{"total_count":1,"artifacts":[{
 "name":"$artifact","id":$((9700 + run_id)),
 "expired":false,"size_in_bytes":1024}]}
EOF2
}

profile_dispatch_inputs() {
  local checkpoint_source="${1:-$SUBJECT_SHA}"
  local resume_source="${2:-$checkpoint_source}"
  jq -cn \
    --arg checkpoint_source "$checkpoint_source" \
    --arg resume_source "$resume_source" '{
    checkpoint_source_sha:$checkpoint_source,
    resume_source_sha:$resume_source,
    disk_checkpoint_run_id:"44",
    build_run_id:"41",
    infrastructure_run_id:"44",
    prerequisite_run_id:"43",
    baseline_recovery_run_id:"0",
    baseline_recovery_source_sha:"none",
    failed_deploy_run_id:"0",
    failed_activation_user_id:"0123456789abcdef01234567"
  }'
}

write_profile_artifacts() {
  local failed_run="$1"
  local include_activation="${2:-false}"
  local checkpoint_source="${3:-$SUBJECT_SHA}"
  local operation_source="${4:-$SUBJECT_SHA}"
  local root="$WORK/profile-artifacts-$failed_run"
  rm -rf "$root"
  python3 - \
    "$root" \
    "$operation_source" \
    "$checkpoint_source" \
    "$failed_run" \
    "$include_activation" <<'PY'
import hashlib
import json
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1])
source = sys.argv[2]
checkpoint_source = sys.argv[3]
failed_run = sys.argv[4]
include_activation = sys.argv[5] == "true"
root.mkdir(parents=True)
repository = "ghcr.io/vasilyevstan/betstan-images"
services = [
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry",
]

def write(directory, name, content):
    path = root / directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content if isinstance(content, bytes) else content.encode())

def env(values):
    return "".join(f"{key}={value}\n" for key, value in values.items())

def manifest(directory):
    base = root / directory
    rows = []
    for path in sorted(base.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            relative = path.relative_to(base).as_posix()
            rows.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {relative}\n")
    raw = "".join(rows).encode()
    write(directory, "SHA256SUMS", raw)
    return hashlib.sha256(raw).hexdigest()

images = []
for service in services:
    manifest_digest = "sha256:" + hashlib.sha256(
        (service + "-manifest").encode()
    ).hexdigest()
    platform_digest = "sha256:" + hashlib.sha256(
        (service + "-platform").encode()
    ).hexdigest()
    image_ref = f"{repository}@{manifest_digest}"
    images.append(
        "\t".join(
            (service, repository, image_ref, manifest_digest, platform_digest)
        )
    )
images_raw = ("\n".join(images) + "\n").encode()
write("build", "images.tsv", images_raw)

checkpoint = {
    "schemaVersion": "k3s-release-disk-checkpoint.v1",
    "sourceSha": checkpoint_source,
    "controlSha": checkpoint_source,
    "infrastructureRunId": "44",
    "ghcrBuildRunId": "41",
    "producerRunId": "44",
    "producerRunAttempt": "1",
    "runtimeMode": "oke",
    "disposition": "NOT_APPLICABLE",
    "terminalStatus": "RELEASE_ELIGIBLE",
}
checkpoint["contentChecksumSha256"] = hashlib.sha256(
    json.dumps(checkpoint, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
write(
    "checkpoint",
    "checkpoint.json",
    json.dumps(checkpoint, sort_keys=True, separators=(",", ":")) + "\n",
)

infrastructure = env({
    "source_sha": checkpoint_source,
    "infrastructure_run_id": "44",
    "infrastructure_run_attempt": "1",
    "infrastructure_finalized": "true",
    "ghcr_build_run_id": "41",
})
write("infrastructure", "provenance.env", infrastructure)
infrastructure_sha = hashlib.sha256(infrastructure.encode()).hexdigest()

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
    "baseline_capture_run_id": "43",
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
write("baseline", "baseline-provenance.env", env(baseline))
write("baseline", "evidence.txt", "baseline\n")
baseline_sha = manifest("baseline")

predecessor = {
    "schema_version": "live-betting-v6",
    "source_sha": source,
    "build_run_id": "41",
    "infrastructure_run_id": "44",
    "checkpoint_source_sha": checkpoint_source,
    "disk_checkpoint_run_id": "44",
    "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
    "disk_checkpoint_disposition": "NOT_APPLICABLE",
    "baseline_sha256": baseline_sha,
    "baseline_recovery_run_id": "0",
    "baseline_recovery_source_sha": "none",
    "workflow_run_id": "43",
    "workflow_run_attempt": "1",
    "phase": "apply-slip-index",
    "status": "PASS",
    "backfill_complete": "true",
    "index_ready": "true",
    "event_reschedule_complete": "true",
    "backoffice_pre_september_cleanup_complete": "true",
    "maintenance_fence_enforced": "true",
    "writers_quiesced": "true",
    "runtime_held_for_deploy": "true",
    "operation_lock_enforced": "true",
    "operation_lock_handoff": "true",
    "completed_at": "2026-01-01T00:00:00Z",
}
write("predecessor", "provenance.env", env(predecessor))
predecessor_manifest_sha = manifest("predecessor")

schema = {
    "schema_version": "live-betting-v6",
    "source_sha": source,
    "build_run_id": "41",
    "infrastructure_run_id": "44",
    "checkpoint_source_sha": checkpoint_source,
    "disk_checkpoint_run_id": "44",
    "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
    "disk_checkpoint_disposition": "NOT_APPLICABLE",
    "baseline_sha256": baseline_sha,
    "baseline_recovery_run_id": "0",
    "baseline_recovery_source_sha": "none",
    "data_run_id": "43",
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

def deployment(directory, run_id):
    provenance = {
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
        "data_run_id": "43",
        "data_run_attempt": "1",
        "data_evidence_sha256": predecessor_manifest_sha,
        "infrastructure_run_id": "44",
        "infrastructure_run_attempt": "1",
        "infrastructure_provenance_sha256": infrastructure_sha,
        "checkpoint_source_sha": checkpoint_source,
        "disk_checkpoint_run_id": "44",
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": "NOT_APPLICABLE",
    }
    write(directory, "provenance.txt", env(provenance))
    write(directory, "images.tsv", images_raw)
    write(directory, "rabbitmq-baseline.txt", rabbit_raw)
    write(directory, "live-schema.env", env(schema))

def deployment_recovery(directory, run_id):
    intent = {
        "schema_version": "oci-deployment-recovery-authority-v1",
        "source_sha": source,
        "source_ref": "refs/heads/master",
        "deployment_workflow": "oci-production-deploy",
        "deployment_run_id": str(run_id),
        "deployment_run_attempt": "1",
        "runtime_mode": "oke",
        "build_run_id": "41",
        "candidate_images_sha256": hashlib.sha256(images_raw).hexdigest(),
        "data_run_id": "43",
        "data_run_attempt": "1",
        "data_evidence_sha256": predecessor_manifest_sha,
        "infrastructure_run_id": "44",
        "infrastructure_run_attempt": "1",
        "infrastructure_provenance_sha256": infrastructure_sha,
        "checkpoint_source_sha": checkpoint_source,
        "disk_checkpoint_run_id": "44",
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": "NOT_APPLICABLE",
        "baseline_sha256": baseline_sha,
        "baseline_capture_run_id": "43",
        "baseline_recovery_run_id": "0",
        "baseline_recovery_source_sha": "none",
    }
    intent_raw = env(intent).encode()
    intent_sha = hashlib.sha256(intent_raw).hexdigest()
    write(directory, "deployment-intent.env", intent_raw)
    write(
        directory,
        "deployment-intent.sha256",
        f"{intent_sha}  deployment-intent.env\n",
    )
    write(directory, "images.tsv", images_raw)
    write(directory, "failure-lineage.env", env({
        "schema_version": "oci-deployment-failure-lineage-v1",
        "source_sha": source,
        "deployment_run_id": str(run_id),
        "deployment_run_attempt": "1",
        "intent_sha256": intent_sha,
        "workflow_result": "failure",
        "lock_release_outcome": "skipped",
        "fence_release_outcome": "skipped",
        "rehold_outcome": "success",
    }))
    manifest(directory)

deployment("failed-deployment", failed_run)
deployment_recovery("deployment-recovery", failed_run)
if include_activation:
    deployment("successful-deployment", "45")
    control = b"after_flag=false\nafter_lease_until_epoch=0\n"
    write("activation-full", "images.tsv", images_raw)
    write("activation-full", "restarts-before.json", b"[]\n")
    write("activation-full", "readiness-before/summary.env", b"status=PASS\n")
    write(
        "activation-full",
        "readiness-activated/summary.env",
        b"status=PASS\n",
    )
    write("activation-full", "failure-disable/control.env", control)
    write("activation-recovery", "failure-disable/control.env", control)
    control_sha = hashlib.sha256(control).hexdigest()
    activation = {
        "source_sha": source,
        "build_run_id": "41",
        "infrastructure_run_id": "44",
        "deployment_run_id": "45",
        "checkpoint_source_sha": checkpoint_source,
        "disk_checkpoint_run_id": "44",
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": "NOT_APPLICABLE",
        "live_acceptance_user_id": "0123456789abcdef01234567",
        "activation_run_id": failed_run,
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
    write("activation-full", "provenance.env", env(activation))
    write("activation-recovery", "provenance.env", env(activation))
    manifest("activation-recovery")
PY

  fixture "repos/$REPO/actions/runs/41/artifacts?per_page=100" <<EOF2
{"total_count":1,"artifacts":[{"name":"oci-image-provenance-$checkpoint_source-41-1","id":9811,"expired":false,"size_in_bytes":8192}]}
EOF2
  artifact_zip_directory_fixture 9811 "$root/build"
  fixture "repos/$REPO/actions/runs/44/artifacts?per_page=100" <<EOF2
{"total_count":2,"artifacts":[
 {"name":"oci-release-disk-checkpoint-$checkpoint_source-44-1","id":9812,"expired":false,"size_in_bytes":8192},
 {"name":"oci-infrastructure-provenance-44-1","id":9813,"expired":false,"size_in_bytes":8192}]}
EOF2
  artifact_zip_directory_fixture 9812 "$root/checkpoint"
  artifact_zip_directory_fixture 9813 "$root/infrastructure"
  fixture "repos/$REPO/actions/runs/43/artifacts?per_page=100" <<EOF2
{"total_count":1,"artifacts":[{"name":"oci-live-data-rollout-43-1","id":9814,"expired":false,"size_in_bytes":8192}]}
EOF2
  artifact_zip_directory_fixture 9814 "$root/predecessor"
  fixture "repos/$REPO/actions/workflows/oci-live-data-rollout.yml" <<'EOF2'
{"id":7643}
EOF2
  for endpoint in \
    "repos/$REPO/actions/runs/43" \
    "repos/$REPO/actions/runs/43/attempts/1"; do
    fixture "$endpoint" <<EOF2
{"id":43,"run_attempt":1,"workflow_id":7643,
 "path":".github/workflows/oci-live-data-rollout.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$operation_source","status":"completed","conclusion":"success",
 "event":"workflow_dispatch",
 "display_title":"oci-live-data apply-slip-index $operation_source",
 "created_at":"2025-12-31T22:00:00Z","updated_at":"2025-12-31T22:10:00Z"}
EOF2
  done

  if [[ "$include_activation" == "true" ]]; then
    fixture "repos/$REPO/actions/runs/$failed_run/artifacts?per_page=100" <<EOF2
{"total_count":2,"artifacts":[
 {"name":"oci-live-activation-recovery-$failed_run-1","id":$((9700 + failed_run)),"expired":false,"size_in_bytes":8192},
 {"name":"oci-live-activation-$failed_run-1","id":$((22000 + failed_run)),"expired":false,"size_in_bytes":8192}]}
EOF2
    artifact_zip_directory_fixture \
      "$((9700 + failed_run))" \
      "$root/activation-recovery"
    artifact_zip_directory_fixture \
      "$((22000 + failed_run))" \
      "$root/activation-full"
    fixture "repos/$REPO/actions/workflows/oci-production-deploy.yml" <<'EOF2'
{"id":7645}
EOF2
    for endpoint in \
      "repos/$REPO/actions/runs/45" \
      "repos/$REPO/actions/runs/45/attempts/1"; do
      fixture "$endpoint" <<EOF2
{"id":45,"run_attempt":1,"workflow_id":7645,
 "path":".github/workflows/oci-production-deploy.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$SUBJECT_SHA","status":"completed","conclusion":"success",
 "event":"workflow_dispatch","display_title":"oci-deploy $SUBJECT_SHA",
 "created_at":"2025-12-31T23:00:00Z","updated_at":"2025-12-31T23:10:00Z"}
EOF2
    done
    fixture "repos/$REPO/actions/runs/45/artifacts?per_page=100" <<'EOF2'
{"total_count":1,"artifacts":[{"name":"oci-deploy-provenance-45-1","id":9816,"expired":false,"size_in_bytes":8192}]}
EOF2
    artifact_zip_directory_fixture 9816 "$root/successful-deployment"
  else
    fixture "repos/$REPO/actions/runs/$failed_run/artifacts?per_page=100" <<EOF2
{"total_count":3,"artifacts":[
 {"name":"oci-production-baseline-$failed_run-1","id":$((9700 + failed_run)),"expired":false,"size_in_bytes":8192},
 {"name":"oci-deploy-provenance-$failed_run-1","id":$((20000 + failed_run)),"expired":false,"size_in_bytes":8192},
 {"name":"oci-deploy-recovery-authority-$failed_run-1","id":$((21000 + failed_run)),"expired":false,"size_in_bytes":8192}]}
EOF2
    artifact_zip_directory_fixture "$((9700 + failed_run))" "$root/baseline"
    artifact_zip_directory_fixture "$((20000 + failed_run))" "$root/failed-deployment"
    artifact_zip_directory_fixture \
      "$((21000 + failed_run))" \
      "$root/deployment-recovery"
  fi
}

write_deployment_recovery_outcomes() {
  local run_id="$1" lock="$2" fence="$3" reenter="$4"
  local recovery_dir="$WORK/profile-artifacts-$run_id/deployment-recovery"
  python3 - "$recovery_dir" "$lock" "$fence" "$reenter" <<'PY'
import hashlib
from pathlib import Path
import sys

root = Path(sys.argv[1])
updates = {
    "lock_release_outcome": sys.argv[2],
    "fence_release_outcome": sys.argv[3],
    "rehold_outcome": sys.argv[4],
}
path = root / "failure-lineage.env"
rows = []
seen = set()
for line in path.read_text(encoding="utf-8").splitlines():
    key, value = line.split("=", 1)
    if key in updates:
        value = updates[key]
        seen.add(key)
    rows.append(f"{key}={value}\n")
if seen != set(updates):
    raise SystemExit("deployment recovery fixture is missing an outcome")
path.write_text("".join(rows), encoding="utf-8")
manifest = root / "SHA256SUMS"
members = sorted(
    candidate
    for candidate in root.rglob("*")
    if candidate.is_file() and candidate != manifest
)
manifest.write_text(
    "".join(
        f"{hashlib.sha256(member.read_bytes()).hexdigest()}  "
        f"{member.relative_to(root).as_posix()}\n"
        for member in members
    ),
    encoding="utf-8",
)
PY
  artifact_zip_directory_fixture \
    "$((21000 + run_id))" \
    "$recovery_dir"
}

write_deploy_profile_jobs() {
  local run_id="$1" deploy="$2" public="$3"
  local lock="$4" fence="$5" reenter="$6" paginated="${7:-false}"
  local payload
  payload="$(jq -cn \
    --arg deploy "$deploy" --arg public "$public" \
    --arg lock "$lock" --arg fence "$fence" --arg reenter "$reenter" '{
      total_count:2,
      jobs:[
        {name:"deploy",conclusion:$deploy,steps:[
          {name:"Write checksum-bound deployment recovery intent",conclusion:"success"},
          {name:"Release transferred lock after protected validation",conclusion:$lock},
          {name:"Release live data maintenance fence",conclusion:$fence},
          {name:"Re-enter maintenance after an incomplete deployment",conclusion:$reenter},
          {name:"Finalize deployment recovery authority",conclusion:"success"},
          {name:"Upload deployment recovery authority",conclusion:"success"}
        ]},
        {name:"public-validate",conclusion:$public,steps:[]}
      ]
    }')"
  if [ "$paginated" = true ]; then
    payload="$(jq -c '[{total_count:2,jobs:[.jobs[0]]},{total_count:2,jobs:[.jobs[1]]}]' \
      <<<"$payload")"
  fi
  fixture "repos/$REPO/actions/runs/$run_id/attempts/1/jobs?per_page=100" \
    <<<"$payload"
  write_deployment_recovery_outcomes \
    "$run_id" "$lock" "$fence" "$reenter"
}

retained_binding="$(profile_binding oci-failed-deploy-retained-hold-v1)"
for lock in success failure skipped cancelled; do
  for fence in success failure skipped cancelled; do
    reset_fixtures
    write_profile_run 610 oci-production-deploy.yml \
      "oci-deploy $SUBJECT_SHA" 7610 \
      oci-production-baseline-610-1
    write_profile_artifacts 610 false
    paginated=false
    [ "$lock/$fence" = "skipped/skipped" ] && paginated=true
    write_deploy_profile_jobs 610 failure skipped \
      "$lock" "$fence" success "$paginated"
    accepted=false
    case "$lock/$fence" in
      skipped/skipped|failure/skipped|success/failure) accepted=true ;;
    esac
    if run_custom_binding "$retained_binding" 610 \
        "$(profile_dispatch_inputs)" oke >/dev/null; then
      [ "$accepted" = true ] ||
        fail "retained-hold accepted forbidden release tuple $lock/$fence"
    else
      [ "$accepted" = false ] ||
        fail "retained-hold rejected accepted release tuple $lock/$fence"
    fi
  done
done
ok "retained-hold accepts exactly three release tuples across paginated jobs"

canonical_failed_deploy_binding="$(
  "$POLICY" get oci-live-data-resume-deploy |
    jq -c '
      .upstreamRunBindings[] |
      select(.input == "failed_deploy_run_id")
    '
)"
grep -Fq \
  'run-name: oci-deploy ${{ inputs.approved_sha }}' \
  "$ROOT_DIR/.github/workflows/oci-production-deploy.yml" ||
  fail "deployment workflow no longer exposes the canonical recovery title"
reset_fixtures
write_profile_run 610 oci-production-deploy.yml \
  "oci-deploy $SUBJECT_SHA" 7610 oci-production-baseline-610-1
write_profile_artifacts 610 false
write_deploy_profile_jobs 610 failure skipped skipped skipped success
run_custom_binding "$canonical_failed_deploy_binding" 610 \
  "$(profile_dispatch_inputs)" oke >/dev/null ||
  fail "real deployment title was rejected: $(cat "$WORK/err.txt")"
stale_failed_deploy_binding="$(
  jq -c '
    .titleTemplates.workflow_dispatch =
      "oci-production-deploy {subject_sha}"
  ' <<<"$canonical_failed_deploy_binding"
)"
if run_custom_binding "$stale_failed_deploy_binding" 610 \
    "$(profile_dispatch_inputs)" oke >/dev/null; then
  fail "stale deployment recovery title was accepted"
fi
ok "bind failed-deploy recovery to the real workflow title and reject stale title"

for mutation in deploy public reenter; do
  reset_fixtures
  write_profile_run 611 oci-production-deploy.yml \
    "oci-deploy $SUBJECT_SHA" 7611 \
    oci-production-baseline-611-1
  write_profile_artifacts 611 false
  deploy=failure public=skipped reenter=success
  case "$mutation" in
    deploy) deploy=success ;;
    public) public=failure ;;
    reenter) reenter=skipped ;;
  esac
  write_deploy_profile_jobs 611 "$deploy" "$public" skipped skipped "$reenter"
  if run_custom_binding "$retained_binding" 611 \
      "$(profile_dispatch_inputs)" oke >/dev/null; then
    fail "retained-hold accepted wrong $mutation outcome"
  fi
done
ok "retained-hold rejects wrong deploy, public, or re-entry outcomes"

released_binding="$(profile_binding oci-failed-deploy-released-runtime-v1)"
for lock in success failure skipped cancelled; do
  for fence in success failure skipped cancelled; do
    reset_fixtures
    write_profile_run 612 oci-production-deploy.yml \
      "oci-deploy $SUBJECT_SHA" 7612 \
      oci-production-baseline-612-1
    write_profile_artifacts 612 false
    write_deploy_profile_jobs 612 success failure \
      "$lock" "$fence" skipped
    if run_custom_binding "$released_binding" 612 \
        "$(profile_dispatch_inputs)" oke >/dev/null; then
      [ "$lock/$fence" = "success/success" ] ||
        fail "released-runtime accepted forbidden release tuple $lock/$fence"
    else
      [ "$lock/$fence" != "success/success" ] ||
        fail "released-runtime rejected its exact release tuple"
    fi
  done
done
ok "released-runtime accepts only successful lock and fence release"

activation_binding="$(profile_binding oci-failed-activation-cleanup-v1)"
write_activation_jobs() {
  local run_id="$1" job="$2" resolve="$3" cleanup="$4"
  local dark="$5" provenance="$6" upload="$7"
  local recovery_upload="${8:-success}"
  fixture "repos/$REPO/actions/runs/$run_id/attempts/1/jobs?per_page=100" <<EOF2
{"total_count":1,"jobs":[{
 "name":"activate-and-validate","conclusion":"$job","steps":[
  {"name":"Resolve reusable validation account","conclusion":"$resolve"},
  {"name":"Revoke and clean reusable validation account","conclusion":"$cleanup"},
  {"name":"Enforce dark mode unless activation committed","conclusion":"$dark"},
  {"name":"Write final activation provenance","conclusion":"$provenance"},
  {"name":"Upload protected activation evidence","conclusion":"$upload"},
  {"name":"Upload activation recovery authority","conclusion":"$recovery_upload"}
 ]}]}
EOF2
}

for mutation in none job resolve cleanup dark provenance upload recovery-upload; do
  reset_fixtures
  write_profile_run 613 oci-live-betting-activate.yml \
    "oci-live-activate $SUBJECT_SHA" 7613 \
    oci-live-activation-recovery-613-1
  write_profile_artifacts 613 true
  if [ "$mutation" = none ]; then
    for relative in \
      images.tsv \
      restarts-before.json \
      readiness-before/summary.env \
      readiness-activated/summary.env; do
      [ -f "$WORK/profile-artifacts-613/activation-full/$relative" ] ||
        fail "activation full-upload fixture omits $relative"
    done
  fi
  job=failure resolve=success cleanup=failure dark=success
  provenance=success upload=success recovery_upload=success
  case "$mutation" in
    job) job=success ;;
    resolve) resolve=failure ;;
    cleanup) cleanup=success ;;
    dark) dark=failure ;;
    provenance) provenance=failure ;;
    upload) upload=failure ;;
    recovery-upload) recovery_upload=failure ;;
  esac
  write_activation_jobs 613 "$job" "$resolve" "$cleanup" \
    "$dark" "$provenance" "$upload" "$recovery_upload"
  if run_custom_binding "$activation_binding" 613 \
      "$(profile_dispatch_inputs)" oke >/dev/null; then
    [ "$mutation" = none ] ||
      fail "activation cleanup profile accepted wrong $mutation outcome"
  else
    [ "$mutation" != none ] ||
      fail "activation cleanup profile rejected its exact outcomes"
  fi
  if [ "$mutation" = none ]; then
    legacy_released_binding="$("$POLICY" get oci-live-data-resume-activation-released |
      jq -c '.upstreamRunBindings[] | select(.input == "failed_activation_run_id")')"
    PATH="$WORK/bin:$PATH" python3 -I - "$VALIDATOR" "$REPO" "$SUBJECT_SHA" \
      "$legacy_released_binding" "$(profile_dispatch_inputs)" <<'PY'
import importlib.util, json, sys
validator, repository, source, binding, inputs = sys.argv[1:]
spec = importlib.util.spec_from_file_location("upstream_binding", validator)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
facts = m.validate_binding(repository, json.loads(binding), source, "613", json.loads(inputs), "oke")
assert facts["resume"] == {
    "released_activation_qualification": "cleanup-required",
    "resume_maintenance_mode": "released-runtime",
}
assert "baselineFiles" not in facts
PY
    ok "released ObjectId delegates unchanged cleanup validation without pre-arm baseline authority"
  fi
done
ok "activation cleanup profile binds every required job and step outcome"

rewrite_profile_env() {
  local directory="$1" file_name="$2" key="$3" value="$4"
  local reseal="${5:-true}"
  python3 - "$directory" "$file_name" "$key" "$value" "$reseal" <<'PY'
import hashlib
from pathlib import Path
import sys

root = Path(sys.argv[1])
path = root / sys.argv[2]
key, value = sys.argv[3:5]
reseal = sys.argv[5] == "true"
lines = path.read_text(encoding="utf-8").splitlines()
matches = [index for index, line in enumerate(lines) if line.startswith(key + "=")]
if len(matches) != 1:
    raise SystemExit(f"expected exactly one {key} in {path}")
lines[matches[0]] = f"{key}={value}"
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
if reseal:
    rows = []
    for member in sorted(root.rglob("*")):
        if member.is_file() and member.name != "SHA256SUMS":
            relative = member.relative_to(root).as_posix()
            rows.append(
                f"{hashlib.sha256(member.read_bytes()).hexdigest()}  {relative}\n"
            )
    (root / "SHA256SUMS").write_text("".join(rows), encoding="utf-8")
PY
}

reseal_profile_directory() {
  local directory="$1"
  python3 - "$directory" <<'PY'
import hashlib
from pathlib import Path
import sys

root = Path(sys.argv[1])
manifest = root / "SHA256SUMS"
members = sorted(
    candidate
    for candidate in root.rglob("*")
    if candidate.is_file() and candidate != manifest
)
manifest.write_text(
    "".join(
        f"{hashlib.sha256(member.read_bytes()).hexdigest()}  "
        f"{member.relative_to(root).as_posix()}\n"
        for member in members
    ),
    encoding="utf-8",
)
PY
}

profile_artifact_zip_path() {
  local artifact_id="$1"
  printf '%s/%s\n' \
    "$FIXTURE_DIR" \
    "$(printf '%s' \
      "repos/$REPO/actions/artifacts/$artifact_id/zip" | tr '/?=&' '____')"
}

prepare_retained_profile_artifacts() {
  local run_id="$1"
  reset_fixtures
  write_profile_run "$run_id" oci-production-deploy.yml \
    "oci-deploy $SUBJECT_SHA" 7610 \
    "oci-production-baseline-$run_id-1"
  write_profile_artifacts "$run_id" false
  write_deploy_profile_jobs \
    "$run_id" failure skipped skipped skipped success
}

artifact_profile_run=620
for mutation in \
  metadata-only \
  malformed-zip \
  missing-recovery-artifact \
  partial-recovery-artifact \
  substituted-recovery-intent \
  bad-checksum \
  bad-capture-run; do
  prepare_retained_profile_artifacts "$artifact_profile_run"
  profile_root="$WORK/profile-artifacts-$artifact_profile_run"
  baseline_artifact_id=$((9700 + artifact_profile_run))
  recovery_artifact_id=$((21000 + artifact_profile_run))
  case "$mutation" in
    metadata-only)
      rm "$(profile_artifact_zip_path "$baseline_artifact_id")"
      ;;
    malformed-zip)
      printf 'not a zip archive\n' \
        >"$(profile_artifact_zip_path "$baseline_artifact_id")"
      ;;
    missing-recovery-artifact)
      rm "$(profile_artifact_zip_path "$recovery_artifact_id")"
      ;;
    partial-recovery-artifact)
      rm "$profile_root/deployment-recovery/failure-lineage.env"
      artifact_zip_directory_fixture \
        "$recovery_artifact_id" \
        "$profile_root/deployment-recovery"
      ;;
    substituted-recovery-intent)
      python3 - "$profile_root/deployment-recovery" <<'PY'
import hashlib
from pathlib import Path
import sys

root = Path(sys.argv[1])
intent = root / "deployment-intent.env"
intent.write_text("".join(
    ("source_sha=" + "b" * 40 if line.startswith("source_sha=") else line)
    + "\n"
    for line in intent.read_text(encoding="utf-8").splitlines()
), encoding="utf-8")
intent_sha = hashlib.sha256(intent.read_bytes()).hexdigest()
(root / "deployment-intent.sha256").write_text(
    f"{intent_sha}  deployment-intent.env\n",
    encoding="utf-8",
)
failure = root / "failure-lineage.env"
rows = []
for line in failure.read_text(encoding="utf-8").splitlines():
    if line.startswith("intent_sha256="):
        line = f"intent_sha256={intent_sha}"
    rows.append(line + "\n")
failure.write_text("".join(rows), encoding="utf-8")
manifest = root / "SHA256SUMS"
members = sorted(
    candidate
    for candidate in root.rglob("*")
    if candidate.is_file() and candidate != manifest
)
manifest.write_text(
    "".join(
        f"{hashlib.sha256(member.read_bytes()).hexdigest()}  "
        f"{member.relative_to(root).as_posix()}\n"
        for member in members
    ),
    encoding="utf-8",
)
PY
      artifact_zip_directory_fixture \
        "$recovery_artifact_id" \
        "$profile_root/deployment-recovery"
      ;;
    bad-checksum)
      printf 'tampered\n' >>"$profile_root/baseline/evidence.txt"
      artifact_zip_directory_fixture \
        "$baseline_artifact_id" \
        "$profile_root/baseline"
      ;;
    bad-capture-run)
      rewrite_profile_env \
        "$profile_root/baseline" \
        baseline-provenance.env \
        baseline_capture_run_id \
        999
      artifact_zip_directory_fixture \
        "$baseline_artifact_id" \
        "$profile_root/baseline"
      ;;
  esac
  if run_custom_binding "$retained_binding" "$artifact_profile_run" \
      "$(profile_dispatch_inputs)" oke >/dev/null; then
    fail "recovery profile accepted incomplete artifact evidence: $mutation"
  fi
  ok "reject recovery profile artifact mutation $mutation"
done

for mutation in \
  source_sha \
  build_run_id \
  infrastructure_run_id \
  checkpoint_source_sha \
  disk_checkpoint_run_id \
  disk_checkpoint_sha256 \
  disk_checkpoint_disposition \
  baseline_sha256 \
  recovery_tuple \
  workflow_run_id \
  phase; do
  prepare_retained_profile_artifacts "$artifact_profile_run"
  profile_root="$WORK/profile-artifacts-$artifact_profile_run"
  predecessor_dir="$profile_root/predecessor"
  case "$mutation" in
    source_sha)
      rewrite_profile_env "$predecessor_dir" provenance.env \
        source_sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      ;;
    build_run_id)
      rewrite_profile_env "$predecessor_dir" provenance.env build_run_id 99
      ;;
    infrastructure_run_id)
      rewrite_profile_env \
        "$predecessor_dir" provenance.env infrastructure_run_id 99
      ;;
    checkpoint_source_sha)
      rewrite_profile_env "$predecessor_dir" provenance.env \
        checkpoint_source_sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      ;;
    disk_checkpoint_run_id)
      rewrite_profile_env \
        "$predecessor_dir" provenance.env disk_checkpoint_run_id 99
      ;;
    disk_checkpoint_sha256)
      rewrite_profile_env "$predecessor_dir" provenance.env \
        disk_checkpoint_sha256 \
        dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
      ;;
    disk_checkpoint_disposition)
      rewrite_profile_env "$predecessor_dir" provenance.env \
        disk_checkpoint_disposition READY_NO_RECLAIM
      ;;
    baseline_sha256)
      rewrite_profile_env "$predecessor_dir" provenance.env \
        baseline_sha256 \
        dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
      ;;
    recovery_tuple)
      rewrite_profile_env "$predecessor_dir" provenance.env \
        baseline_recovery_run_id 99 false
      rewrite_profile_env "$predecessor_dir" provenance.env \
        baseline_recovery_source_sha \
        bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      ;;
    workflow_run_id)
      rewrite_profile_env "$predecessor_dir" provenance.env workflow_run_id 99
      ;;
    phase)
      rewrite_profile_env "$predecessor_dir" provenance.env phase dry-run
      ;;
  esac
  artifact_zip_directory_fixture 9814 "$predecessor_dir"
  if run_custom_binding "$retained_binding" "$artifact_profile_run" \
      "$(profile_dispatch_inputs)" oke >/dev/null; then
    fail "recovery profile accepted predecessor v6 substitution: $mutation"
  fi
  ok "reject predecessor v6 substitution $mutation"
done

activation_artifact_run=621
for mutation in \
  source_sha \
  build_run_id \
  infrastructure_run_id \
  deployment_run_id \
  checkpoint_source_sha \
  disk_checkpoint_run_id \
  disk_checkpoint_sha256 \
  disk_checkpoint_disposition; do
  reset_fixtures
  write_profile_run "$activation_artifact_run" \
    oci-live-betting-activate.yml \
    "oci-live-activate $SUBJECT_SHA" \
    7613 \
    "oci-live-activation-recovery-$activation_artifact_run-1"
  write_profile_artifacts "$activation_artifact_run" true
  write_activation_jobs \
    "$activation_artifact_run" \
    failure success failure success success success
  profile_root="$WORK/profile-artifacts-$activation_artifact_run"
  activation_dir="$profile_root/activation-recovery"
  case "$mutation" in
    source_sha)
      rewrite_profile_env "$activation_dir" provenance.env \
        source_sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      ;;
    build_run_id)
      rewrite_profile_env "$activation_dir" provenance.env build_run_id 99
      ;;
    infrastructure_run_id)
      rewrite_profile_env \
        "$activation_dir" provenance.env infrastructure_run_id 99
      ;;
    deployment_run_id)
      rewrite_profile_env \
        "$activation_dir" provenance.env deployment_run_id 46
      ;;
    checkpoint_source_sha)
      rewrite_profile_env "$activation_dir" provenance.env \
        checkpoint_source_sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      ;;
    disk_checkpoint_run_id)
      rewrite_profile_env \
        "$activation_dir" provenance.env disk_checkpoint_run_id 99
      ;;
    disk_checkpoint_sha256)
      rewrite_profile_env "$activation_dir" provenance.env \
        disk_checkpoint_sha256 \
        dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
      ;;
    disk_checkpoint_disposition)
      rewrite_profile_env "$activation_dir" provenance.env \
        disk_checkpoint_disposition READY_NO_RECLAIM
      ;;
  esac
  artifact_zip_directory_fixture \
    "$((9700 + activation_artifact_run))" \
    "$activation_dir"
  if run_custom_binding "$activation_binding" "$activation_artifact_run" \
      "$(profile_dispatch_inputs)" oke >/dev/null; then
    fail "activation profile accepted lineage substitution: $mutation"
  fi
  ok "reject activation lineage substitution $mutation"
done

for mutation in missing modified duplicate additional; do
  reset_fixtures
  write_profile_run "$activation_artifact_run" \
    oci-live-betting-activate.yml \
    "oci-live-activate $SUBJECT_SHA" \
    7613 \
    "oci-live-activation-recovery-$activation_artifact_run-1"
  write_profile_artifacts "$activation_artifact_run" true
  write_activation_jobs \
    "$activation_artifact_run" \
    failure success failure success success success
  profile_root="$WORK/profile-artifacts-$activation_artifact_run"
  activation_dir="$profile_root/activation-recovery"
  case "$mutation" in
    missing)
      rm "$activation_dir/failure-disable/control.env"
      reseal_profile_directory "$activation_dir"
      ;;
    modified)
      printf 'modified=true\n' \
        >>"$activation_dir/failure-disable/control.env"
      reseal_profile_directory "$activation_dir"
      ;;
    duplicate)
      artifact_zip_duplicate_fixture \
        "$((9700 + activation_artifact_run))" \
        "$activation_dir" \
        provenance.env
      ;;
    additional)
      printf 'unexpected\n' >"$activation_dir/unexpected.txt"
      reseal_profile_directory "$activation_dir"
      ;;
  esac
  if [ "$mutation" != duplicate ]; then
    artifact_zip_directory_fixture \
      "$((9700 + activation_artifact_run))" \
      "$activation_dir"
  fi
  if run_custom_binding "$activation_binding" "$activation_artifact_run" \
      "$(profile_dispatch_inputs)" oke >/dev/null; then
    fail "activation profile accepted $mutation recovery-authority evidence"
  fi
  ok "reject activation recovery artifact with $mutation member evidence"
done

APPLIED_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
prepare_activation_chain() {
  local activation_run="$1"
  local failed_deploy_run="$2"
  reset_fixtures
  write_profile_run "$activation_run" \
    oci-live-betting-activate.yml \
    "oci-live-activate $SUBJECT_SHA" \
    7613 \
    "oci-live-activation-recovery-$activation_run-1"
  write_profile_artifacts \
    "$activation_run" true "$APPLIED_SOURCE_SHA" "$SUBJECT_SHA"
  write_activation_jobs \
    "$activation_run" failure success failure success success success

  local activation_root="$WORK/profile-artifacts-$activation_run"
  python3 - \
    "$activation_root" \
    "$APPLIED_SOURCE_SHA" \
    "$SUBJECT_SHA" \
    "$failed_deploy_run" <<'PY'
import hashlib
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1])
applied_source = sys.argv[2]
current_source = sys.argv[3]
failed_run = sys.argv[4]

def read_env(path):
    return dict(
        line.split("=", 1)
        for line in path.read_text(encoding="utf-8").splitlines()
    )

def write_env(path, values):
    path.write_text(
        "".join(f"{key}={value}\n" for key, value in values.items()),
        encoding="utf-8",
    )

def seal(directory):
    manifest = directory / "SHA256SUMS"
    members = sorted(
        path
        for path in directory.rglob("*")
        if path.is_file() and path != manifest
    )
    manifest.write_text(
        "".join(
            f"{hashlib.sha256(path.read_bytes()).hexdigest()}  "
            f"{path.relative_to(directory).as_posix()}\n"
            for path in members
        ),
        encoding="utf-8",
    )
    return hashlib.sha256(manifest.read_bytes()).hexdigest()

baseline = root / "baseline"
baseline_values = read_env(baseline / "baseline-provenance.env")
baseline_values["baseline_source_sha"] = applied_source
baseline_values["baseline_capture_run_id"] = "42"
write_env(baseline / "baseline-provenance.env", baseline_values)
baseline_sha = seal(baseline)

resumed = root / "predecessor"
applied = root / "applied-predecessor"
shutil.copytree(resumed, applied)
applied_values = read_env(applied / "provenance.env")
applied_values.update({
    "source_sha": applied_source,
    "workflow_run_id": "42",
    "baseline_sha256": baseline_sha,
    "completed_at": "2025-12-31T21:10:00Z",
})
write_env(applied / "provenance.env", applied_values)
applied_manifest_sha = seal(applied)

resumed_values = read_env(resumed / "provenance.env")
resumed_values.update({
    "source_sha": current_source,
    "workflow_run_id": "43",
    "baseline_sha256": baseline_sha,
    "completed_at": "2025-12-31T22:10:00Z",
})
write_env(resumed / "provenance.env", resumed_values)
resume_images = (root / "build" / "images.tsv").read_bytes()
(resumed / "resume-images.tsv").write_bytes(resume_images)
resume_authority = {
    "schema_version": "live-betting-data-resume-v2",
    "applied_data_run_id": "42",
    "applied_source_sha": applied_source,
    "failed_deploy_run_id": failed_run,
    "resume_maintenance_mode": "retained-hold",
    "failed_deploy_job_conclusion": "failure",
    "public_validate_job_conclusion": "skipped",
    "lock_release_step_conclusion": "skipped",
    "fence_release_step_conclusion": "skipped",
    "rehold_step_conclusion": "success",
    "failed_activation_run_id": "0",
    "current_source_sha": current_source,
    "baseline_sha256": baseline_sha,
    "runtime_images_sha256": hashlib.sha256(resume_images).hexdigest(),
    "checkpoint_source_sha": applied_source,
    "disk_checkpoint_run_id": "44",
    "disk_checkpoint_sha256": resumed_values["disk_checkpoint_sha256"],
    "disk_checkpoint_disposition":
        resumed_values["disk_checkpoint_disposition"],
    "application_change_scope": "github-infra-docs-only",
    "status": "PASS",
}
write_env(resumed / "resume-authority.env", resume_authority)
resumed_manifest_sha = seal(resumed)

successful = root / "successful-deployment" / "provenance.txt"
successful_values = read_env(successful)
successful_values["data_run_id"] = "43"
successful_values["data_evidence_sha256"] = resumed_manifest_sha
write_env(successful, successful_values)
schema_path = root / "successful-deployment" / "live-schema.env"
schema = read_env(schema_path)
for key in {
    "source_sha",
    "build_run_id",
    "infrastructure_run_id",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "disk_checkpoint_sha256",
    "disk_checkpoint_disposition",
    "baseline_sha256",
    "baseline_recovery_run_id",
    "baseline_recovery_source_sha",
}:
    schema[key] = resumed_values[key]
schema["data_run_id"] = "43"
write_env(schema_path, schema)

intent_path = root / "deployment-recovery" / "deployment-intent.env"
intent = read_env(intent_path)
intent.update({
    "source_sha": applied_source,
    "deployment_run_id": failed_run,
    "data_run_id": "42",
    "data_evidence_sha256": applied_manifest_sha,
    "baseline_sha256": baseline_sha,
    "baseline_capture_run_id": "42",
})
write_env(intent_path, intent)
intent_sha = hashlib.sha256(intent_path.read_bytes()).hexdigest()
(root / "deployment-recovery" / "deployment-intent.sha256").write_text(
    f"{intent_sha}  deployment-intent.env\n",
    encoding="utf-8",
)
failure_path = root / "deployment-recovery" / "failure-lineage.env"
failure = read_env(failure_path)
failure.update({
    "source_sha": applied_source,
    "deployment_run_id": failed_run,
    "intent_sha256": intent_sha,
    "lock_release_outcome": "skipped",
    "fence_release_outcome": "skipped",
    "rehold_outcome": "success",
})
write_env(failure_path, failure)
seal(root / "deployment-recovery")
PY

  local failed_root="$WORK/profile-artifacts-$failed_deploy_run"
  rm -rf "$failed_root"
  mkdir -p "$failed_root"
  cp -R \
    "$activation_root/baseline" \
    "$activation_root/failed-deployment" \
    "$activation_root/deployment-recovery" \
    "$failed_root/"

  fixture "repos/$REPO/actions/runs/42" <<EOF2
{"id":42,"run_attempt":1,"workflow_id":7643,
 "path":".github/workflows/oci-live-data-rollout.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$APPLIED_SOURCE_SHA","status":"completed","conclusion":"success",
 "event":"workflow_dispatch",
 "display_title":"oci-live-data apply-slip-index $APPLIED_SOURCE_SHA",
 "created_at":"2025-12-31T21:00:00Z","updated_at":"2025-12-31T21:10:00Z"}
EOF2
  cp \
    "$FIXTURE_DIR/$(printf '%s' "repos/$REPO/actions/runs/42" | tr '/?=&' '____')" \
    "$FIXTURE_DIR/$(printf '%s' "repos/$REPO/actions/runs/42/attempts/1" | tr '/?=&' '____')"
  fixture "repos/$REPO/actions/runs/42/artifacts?per_page=100" <<'EOF2'
{"total_count":1,"artifacts":[{"name":"oci-live-data-rollout-42-1","id":9817,"expired":false,"size_in_bytes":8192}]}
EOF2
  artifact_zip_directory_fixture 9817 "$activation_root/applied-predecessor"
  artifact_zip_directory_fixture 9814 "$activation_root/predecessor"
  artifact_zip_directory_fixture 9816 "$activation_root/successful-deployment"

  for endpoint in \
    "repos/$REPO/actions/runs/$failed_deploy_run" \
    "repos/$REPO/actions/runs/$failed_deploy_run/attempts/1"; do
    fixture "$endpoint" <<EOF2
{"id":$failed_deploy_run,"run_attempt":1,"workflow_id":7645,
 "path":".github/workflows/oci-production-deploy.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$APPLIED_SOURCE_SHA","status":"completed","conclusion":"failure",
 "event":"workflow_dispatch","display_title":"oci-deploy $APPLIED_SOURCE_SHA",
 "created_at":"2025-12-31T21:20:00Z","updated_at":"2025-12-31T21:30:00Z"}
EOF2
  done
  fixture \
    "repos/$REPO/actions/runs/$failed_deploy_run/artifacts?per_page=100" <<EOF2
{"total_count":3,"artifacts":[
 {"name":"oci-production-baseline-$failed_deploy_run-1","id":$((9700 + failed_deploy_run)),"expired":false,"size_in_bytes":8192},
 {"name":"oci-deploy-provenance-$failed_deploy_run-1","id":$((20000 + failed_deploy_run)),"expired":false,"size_in_bytes":8192},
 {"name":"oci-deploy-recovery-authority-$failed_deploy_run-1","id":$((21000 + failed_deploy_run)),"expired":false,"size_in_bytes":8192}]}
EOF2
  artifact_zip_directory_fixture \
    "$((9700 + failed_deploy_run))" "$failed_root/baseline"
  artifact_zip_directory_fixture \
    "$((20000 + failed_deploy_run))" "$failed_root/failed-deployment"
  artifact_zip_directory_fixture \
    "$((21000 + failed_deploy_run))" "$failed_root/deployment-recovery"
  write_deploy_profile_jobs \
    "$failed_deploy_run" failure skipped skipped skipped success
}

activation_chain_run=623
activation_chain_failed_run=610
prepare_activation_chain \
  "$activation_chain_run" "$activation_chain_failed_run"
activation_chain_inputs="$(
  profile_dispatch_inputs "$APPLIED_SOURCE_SHA" "$SUBJECT_SHA" |
    jq -c --arg failed "$activation_chain_failed_run" \
      '.failed_deploy_run_id = $failed'
)"
run_custom_binding "$activation_binding" "$activation_chain_run" \
  "$activation_chain_inputs" oke >/dev/null ||
  fail "producer-realistic P-D-R-S-A activation chain was rejected: $(cat "$WORK/err.txt")"
ok "accept producer-realistic P-D-R-S-A activation chain with distinct sources"

for restarted_run in \
  "$activation_chain_run" \
  45 \
  43 \
  "$activation_chain_failed_run"; do
  prepare_activation_chain \
    "$activation_chain_run" "$activation_chain_failed_run"
  run_fixture="$FIXTURE_DIR/$(
    printf '%s' "repos/$REPO/actions/runs/$restarted_run" |
      tr '/?=&' '____'
  )"
  python3 - "$run_fixture" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
value["run_attempt"] = 2
path.write_text(json.dumps(value), encoding="utf-8")
PY
  if run_custom_binding "$activation_binding" "$activation_chain_run" \
      "$activation_chain_inputs" oke >/dev/null; then
    fail "activation chain accepted restarted run $restarted_run"
  fi
done
ok "reject restarted activation, deployment, predecessor, and failed-deploy runs"

for mutation in deployment-predecessor failed-deploy applied-run applied-source; do
  prepare_activation_chain \
    "$activation_chain_run" "$activation_chain_failed_run"
  activation_root="$WORK/profile-artifacts-$activation_chain_run"
  case "$mutation" in
    deployment-predecessor)
      rewrite_profile_env \
        "$activation_root/successful-deployment" \
        provenance.txt data_run_id 42 false
      artifact_zip_directory_fixture \
        9816 "$activation_root/successful-deployment"
      ;;
    failed-deploy)
      rewrite_profile_env \
        "$activation_root/predecessor" \
        resume-authority.env failed_deploy_run_id 611
      artifact_zip_directory_fixture 9814 "$activation_root/predecessor"
      ;;
    applied-run)
      rewrite_profile_env \
        "$activation_root/predecessor" \
        resume-authority.env applied_data_run_id 41
      artifact_zip_directory_fixture 9814 "$activation_root/predecessor"
      ;;
    applied-source)
      rewrite_profile_env \
        "$activation_root/predecessor" \
        resume-authority.env applied_source_sha \
        bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      artifact_zip_directory_fixture 9814 "$activation_root/predecessor"
      ;;
  esac
  if run_custom_binding "$activation_binding" "$activation_chain_run" \
      "$activation_chain_inputs" oke >/dev/null; then
    fail "activation chain accepted cross-link substitution: $mutation"
  fi
done
ok "reject deployment, failed-deploy, and applied-predecessor cross-links"

prepare_pre_runtime_activation_chain() {
  prepare_activation_chain 623 610
  local root="$WORK/profile-artifacts-623"
  rewrite_profile_env "$root/predecessor" resume-authority.env resume_maintenance_mode pre-runtime-hold
  rewrite_profile_env "$root/predecessor" resume-authority.env rehold_step_conclusion skipped
  local predecessor_sha
  predecessor_sha="$(sha256sum "$root/predecessor/SHA256SUMS" | awk '{print $1}')"
  rewrite_profile_env "$root/successful-deployment" provenance.txt data_evidence_sha256 "$predecessor_sha" false
  artifact_zip_directory_fixture 9814 "$root/predecessor"
  artifact_zip_directory_fixture 9816 "$root/successful-deployment"
  mkdir -p "$root/original-baselines"
  cp -R "$root/baseline" "$root/original-baselines/oci-data-baseline-before"
  artifact_zip_directory_fixture 9820 "$root/original-baselines"
  python3 - "$FIXTURE_DIR" "$REPO" "$WORK/repository" "$APPLIED_SOURCE_SHA" "$SUBJECT_SHA" <<'PY'
import hashlib, io, json, pathlib, re, subprocess, sys, zipfile
directory, repo, checkout, root_source, resumed_source = sys.argv[1:]
def path(endpoint):
    return pathlib.Path(directory) / endpoint.translate(str.maketrans("/?=&", "____"))
def write(endpoint, value):
    path(endpoint).write_text(json.dumps(value))
def read(endpoint):
    return json.loads(path(endpoint).read_text())
prefix = f"repos/{repo}"
root_artifacts = read(f"{prefix}/actions/runs/42/artifacts?per_page=100")
root_artifacts["artifacts"].append({
    "name": "oci-live-data-baselines-42-1", "id": 9820,
    "expired": False, "size_in_bytes": 8192})
root_artifacts["total_count"] = 2
write(f"{prefix}/actions/runs/42/artifacts?per_page=100", root_artifacts)
write(f"{prefix}/actions/runs/610/artifacts?per_page=100", {"total_count": 0, "artifacts": []})
for run, workflow, wid, event in (
    (41, "oci-production-build.yml", 7641, "workflow_run"),
    (44, "oci-infrastructure.yml", 7644, "workflow_dispatch"),
):
    write(f"{prefix}/actions/workflows/{workflow}", {"id": wid})
    value = {
        "id": run, "run_attempt": 1, "workflow_id": wid,
        "path": f".github/workflows/{workflow}",
        "head_repository": {"full_name": repo}, "head_branch": "master",
        "head_sha": root_source, "status": "completed", "conclusion": "success",
        "event": event, "created_at": "2025-12-31T20:00:00Z", "updated_at": "2025-12-31T20:10:00Z",
    }
    for suffix in ("", "/attempts/1"):
        write(f"{prefix}/actions/runs/{run}{suffix}", value)
blob = subprocess.check_output(["git", "-C", checkout, "show",
    f"{root_source}:.github/workflows/oci-production-deploy.yml"])
write(f"{prefix}/contents/.github/workflows/oci-production-deploy.yml?ref={root_source}",
    {"sha": hashlib.sha1(f"blob {len(blob)}\0".encode() + blob).hexdigest()})
names = re.findall(r"(?m)^      - name: (.+)$", blob.decode().split("\n  public-validate:\n")[0])
boundary = names.index("Verify immutable image and infrastructure provenance")
steps = [{
    "name": name, "number": index + 2, "status": "completed",
    "conclusion": "success" if index < boundary else "failure" if index == boundary else "skipped",
    "started_at": "2025-12-31T21:25:00Z", "completed_at": "2025-12-31T21:26:00Z",
} for index, name in enumerate(names)]
for step in steps:
    if step["name"] in {"Remove isolated OCI client state", "Upload sanitized live readiness evidence"}:
        step["conclusion"] = "success"
steps.insert(0, {"name": "Set up job", "number": 1, "status": "completed", "conclusion": "success"})
for name in ("Post Checkout approved master commit", "Complete job"):
    steps.append({"name": name, "number": len(steps) + 1, "status": "completed", "conclusion": "success"})
write(f"{prefix}/actions/runs/610/attempts/1/jobs?per_page=100", {
    "total_count": 2, "jobs": [
        {"id": 61000, "run_id": 610, "name": "deploy", "status": "completed", "conclusion": "failure", "steps": steps},
        {"id": 61001, "run_id": 610, "name": "public-validate", "status": "completed", "conclusion": "skipped", "steps": []},
    ]})
write(f"{prefix}/actions/runs/43/attempts/1/jobs?per_page=100", {
    "total_count": 1, "jobs": [{"id": 4300, "run_id": 43, "name": "rollout", "steps": [{
        "name": "Validate exact SHA phase and trusted upstream runs", "conclusion": "success",
        "started_at": "2025-12-31T22:01:00Z", "completed_at": "2025-12-31T22:02:00Z"}]}]})
failed = {
    "approved_sha": root_source, "build_run_id": "41", "infrastructure_run_id": "44",
    "data_run_id": "42", "checkpoint_source_sha": root_source, "disk_checkpoint_run_id": "44",
    "baseline_recovery_run_id": "0", "baseline_recovery_source_sha": "none",
    "confirmation": "DEPLOY OCI EXACT SHA",
}
resume = {key: value for key, value in failed.items() if key != "data_run_id"}
resume.update(
    approved_sha=resumed_source, resume_source_sha=root_source, phase="apply-slip-index",
    prerequisite_run_id="42", failed_deploy_run_id="610", failed_activation_run_id="0",
    failed_activation_user_id="0", confirmation="RESUME APPLIED LIVE DATA EXACT SHA")
for run, name, values, timestamp in (
    (610, "deploy", failed, "2025-12-31T21:25:30Z"),
    (43, "rollout", resume, "2025-12-31T22:01:30Z"),
):
    lines = ["##[group]Run set -euo pipefail", "env:"]
    lines += [f"  {'SOURCE_SHA' if key == 'approved_sha' else key.upper()}: {value}" for key, value in values.items()]
    lines += ["  DISPATCH_INPUTS: " + json.dumps(values), "##[endgroup]"]
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        bundle.writestr(f"-1_{name}.txt", "".join(f"{timestamp} {line}\n" for line in lines))
    path(f"{prefix}/actions/runs/{run}/attempts/1/logs").write_bytes(output.getvalue())
PY
}

saved_subject="$SUBJECT_SHA"
saved_applied="$APPLIED_SOURCE_SHA"
saved_directory="$PWD"
cd "$WORK/repository"
git config user.name "Upstream Fixture"
git config user.email "upstream-fixture@example.invalid"
git config commit.gpgsign false
mkdir -p .github/workflows
cp "$ROOT_DIR/.github/workflows/oci-production-deploy.yml" .github/workflows/
git add .github/workflows/oci-production-deploy.yml
git commit --quiet -m "Record fixture workflow" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
APPLIED_SOURCE_SHA="$(git rev-parse HEAD)"
printf '\n# Fixture control-only descendant.\n' >>.github/workflows/oci-production-deploy.yml
git add .github/workflows/oci-production-deploy.yml
git commit --quiet -m "Record fixture control descendant" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
SUBJECT_SHA="$(git rev-parse HEAD)"
prepare_pre_runtime_activation_chain
pre_runtime_cleanup_inputs="$(
  profile_dispatch_inputs "$APPLIED_SOURCE_SHA" "$SUBJECT_SHA" |
    jq -c '.failed_deploy_run_id = "610"'
)"
run_custom_binding "$activation_binding" 623 "$pre_runtime_cleanup_inputs" oke >/dev/null ||
  fail "pre-runtime activation cleanup was rejected: $(cat "$WORK/err.txt")"
for mutation in omitted substituted; do
  failed=0
  [ "$mutation" != substituted ] || failed=611
  bad_inputs="$(jq -c --arg failed "$failed" '.failed_deploy_run_id=$failed' <<<"$pre_runtime_cleanup_inputs")"
  if run_custom_binding "$activation_binding" 623 "$bad_inputs" oke >/dev/null; then
    fail "pre-runtime activation cleanup accepted $mutation historical failure"
  fi
done
for authority_mutation in applied_data_run_id applied_source_sha; do
  prepare_pre_runtime_activation_chain
  bad=99
  [ "$authority_mutation" != applied_source_sha ] || bad=9999999999999999999999999999999999999999
  rewrite_profile_env "$WORK/profile-artifacts-623/predecessor" resume-authority.env "$authority_mutation" "$bad"
  artifact_zip_directory_fixture 9814 "$WORK/profile-artifacts-623/predecessor"
  changed_sha="$(sha256sum "$WORK/profile-artifacts-623/predecessor/SHA256SUMS" | awk '{print $1}')"
  rewrite_profile_env "$WORK/profile-artifacts-623/successful-deployment" provenance.txt data_evidence_sha256 "$changed_sha" false
  artifact_zip_directory_fixture 9816 "$WORK/profile-artifacts-623/successful-deployment"
  if run_custom_binding "$activation_binding" 623 "$pre_runtime_cleanup_inputs" oke >/dev/null; then
    fail "pre-runtime cleanup accepted substituted original $authority_mutation"
  fi
done
ok "pre-runtime resumed activation cleanup authenticates zero-artifact failure and rejects omitted/substituted authority"

for mode in retained released; do
  prepare_pre_runtime_activation_chain
  post_root="$WORK/profile-artifacts-624"
  rm -rf "$post_root"
  mkdir -p "$post_root"
  cp -R "$WORK/profile-artifacts-623/baseline" "$post_root/"
  cp -R "$WORK/profile-artifacts-623/successful-deployment" "$post_root/failed-deployment"
  write_profile_run 624 oci-production-deploy.yml "oci-deploy $SUBJECT_SHA" 7645 oci-production-baseline-624-1
  rewrite_profile_env "$post_root/failed-deployment" provenance.txt deployment_run_id 624 false
  ruby -ryaml - "$ROOT_DIR/.github/workflows/oci-production-deploy.yml" >"$post_root/intent.sh" <<'RUBY'
puts YAML.load_file(ARGV[0]).fetch("jobs").fetch("deploy").fetch("steps")
  .find { |step| step["name"] == "Write checksum-bound deployment recovery intent" }.fetch("run")
RUBY
  mkdir -p "$post_root/artifacts/oci-deploy" "$post_root/artifacts/data" \
    "$post_root/artifacts/infrastructure"
  cp "$WORK/profile-artifacts-623/build/images.tsv" "$post_root/artifacts/oci-deploy/"
  cp "$WORK/profile-artifacts-623/predecessor/SHA256SUMS" "$post_root/artifacts/data/"
  cp "$WORK/profile-artifacts-623/infrastructure/provenance.env" "$post_root/artifacts/infrastructure/"
  cp -R "$post_root/baseline" "$post_root/artifacts/oci-baseline"
  checkpoint_sha="$(jq -r .contentChecksumSha256 "$WORK/profile-artifacts-623/checkpoint/checkpoint.json")"
  (
    cd "$post_root"
    SOURCE_SHA="$SUBJECT_SHA" GITHUB_RUN_ID=624 GITHUB_RUN_ATTEMPT=1 OCI_RUNTIME_MODE=oke \
    BUILD_RUN_ID=41 DATA_RUN_ID=43 INFRASTRUCTURE_RUN_ID=44 CHECKPOINT_SOURCE_SHA="$APPLIED_SOURCE_SHA" \
    DISK_CHECKPOINT_RUN_ID=44 DISK_CHECKPOINT_SHA256="$checkpoint_sha" DISK_CHECKPOINT_DISPOSITION=NOT_APPLICABLE \
    BASELINE_RECOVERY_RUN_ID=0 BASELINE_RECOVERY_SOURCE_SHA=none bash intent.sh
  )
  cp -R "$post_root/artifacts/oci-deploy-recovery" "$post_root/deployment-recovery"
  cp "$WORK/profile-artifacts-623/deployment-recovery/failure-lineage.env" "$post_root/deployment-recovery/"
  intent_sha="$(sha256sum "$post_root/deployment-recovery/deployment-intent.env" | awk '{print $1}')"
  rewrite_profile_env "$post_root/deployment-recovery" failure-lineage.env source_sha "$SUBJECT_SHA"
  rewrite_profile_env "$post_root/deployment-recovery" failure-lineage.env deployment_run_id 624
  rewrite_profile_env "$post_root/deployment-recovery" failure-lineage.env intent_sha256 "$intent_sha"
  fixture "repos/$REPO/actions/runs/624/artifacts?per_page=100" <<'EOF2'
{"total_count":3,"artifacts":[
 {"name":"oci-production-baseline-624-1","id":10324,"expired":false,"size_in_bytes":8192},
 {"name":"oci-deploy-provenance-624-1","id":20624,"expired":false,"size_in_bytes":8192},
 {"name":"oci-deploy-recovery-authority-624-1","id":21624,"expired":false,"size_in_bytes":8192}]}
EOF2
  artifact_zip_directory_fixture 10324 "$post_root/baseline"
  artifact_zip_directory_fixture 20624 "$post_root/failed-deployment"
  artifact_zip_directory_fixture 21624 "$post_root/deployment-recovery"
  if [ "$mode" = retained ]; then
    binding="$retained_binding"
    write_deploy_profile_jobs 624 failure skipped skipped skipped success
  else
    binding="$released_binding"
    write_deploy_profile_jobs 624 success failure success success skipped
  fi
  inputs="$(profile_dispatch_inputs "$APPLIED_SOURCE_SHA" "$SUBJECT_SHA")"
  run_custom_binding "$binding" 624 "$inputs" oke >/dev/null ||
    fail "$mode post-runtime admission after pre-runtime resume failed: $(cat "$WORK/err.txt")"
  for mutation in root hash; do
    cp -R "$post_root/baseline" "$post_root/baseline-save"
    if [ "$mutation" = root ]; then
      rewrite_profile_env "$post_root/baseline" baseline-provenance.env baseline_capture_run_id 43
    else
      printf 'substituted\n' >"$post_root/baseline/evidence.txt"
    fi
    artifact_zip_directory_fixture 10324 "$post_root/baseline"
    if run_custom_binding "$binding" 624 "$inputs" oke >/dev/null; then
      fail "$mode post-runtime admission accepted substituted baseline $mutation"
    fi
    rm -rf "$post_root/baseline"
    mv "$post_root/baseline-save" "$post_root/baseline"
  done
  artifact_zip_directory_fixture 10324 "$post_root/baseline"
  inventory="$FIXTURE_DIR/$(printf '%s' "repos/$REPO/actions/runs/624/artifacts?per_page=100" | tr '/?=&' '____')"
  cp "$inventory" "$post_root/artifact-inventory.json"
  proof=oci-deploy-recovery-authority-624-1
  [ "$mode" != released ] || proof=oci-deploy-provenance-624-1
  for missing in oci-production-baseline-624-1 "$proof"; do
    jq --arg missing "$missing" \
      '.artifacts |= map(select(.name != $missing)) | .total_count=(.artifacts|length)' \
      "$post_root/artifact-inventory.json" >"$inventory"
    if run_custom_binding "$binding" 624 "$inputs" oke >/dev/null; then
      fail "$mode post-runtime admission accepted missing actual $missing"
    fi
  done
  cp "$post_root/artifact-inventory.json" "$inventory"
  run_custom_binding "$binding" 624 "$inputs" oke >/dev/null ||
    fail "$mode post-runtime fixture did not recover after rejected substitutions"
  ok "$mode post-runtime admission preserves original capture with executed deployment-intent producer"
done

APPLIED_SOURCE_SHA=1bf86112ba2458161e6039091b1aa6289fdfce1d
earlier_source=b437710af5f796114ab619260c26f47317771bdf
SUBJECT_SHA=30101f783162b166c75e9d6adaf92fc647c5a6a6
prepare_pre_runtime_activation_chain
write_profile_run 626 oci-production-deploy.yml "oci-deploy $earlier_source" \
  7645 oci-production-baseline-626-1 "$earlier_source"
write_profile_artifacts 626 false "$APPLIED_SOURCE_SHA" "$earlier_source"
write_deploy_profile_jobs 626 failure skipped skipped skipped success
write_profile_run 624 oci-production-deploy.yml "oci-deploy $SUBJECT_SHA" \
  7645 oci-production-baseline-624-1
write_profile_artifacts 624 false "$APPLIED_SOURCE_SHA" "$SUBJECT_SHA"
write_deploy_profile_jobs 624 success failure success success skipped
PATH="$WORK/bin:$PATH" python3 -I - "$VALIDATOR" "$FIXTURE_DIR" "$WORK" \
  "$REPO" "$APPLIED_SOURCE_SHA" "$earlier_source" "$SUBJECT_SHA" \
  "$released_binding" "$(profile_dispatch_inputs "$APPLIED_SOURCE_SHA" "$SUBJECT_SHA")" \
  "$WORK/repository" "$("$POLICY" get oci-live-data-resume-activation-released)" <<'PY'
import base64, copy, datetime as dt, hashlib, io, json, os, pathlib, re, shutil, subprocess, sys, zipfile

validator, fixtures, work, repo, root_source, earlier_source, current_source, binding, inputs, checkout, policy_raw = sys.argv[1:]
base = pathlib.Path(work) / "profile-artifacts-623"
historical = pathlib.Path(work) / "profile-artifacts-626"
public = pathlib.Path(work) / "profile-artifacts-624"
prefix = f"repos/{repo}"

def path(endpoint):
    return pathlib.Path(fixtures) / endpoint.translate(str.maketrans("/?=&", "____"))
def read(endpoint):
    return json.loads(path(endpoint).read_text())
def write(endpoint, value):
    path(endpoint).write_text(json.dumps(value))
def env(directory, name):
    return dict(line.split("=", 1) for line in (directory / name).read_text().splitlines())
def write_env(directory, name, values):
    (directory / name).write_text("".join(f"{key}={value}\n" for key, value in values.items()))
def seal(directory):
    members = sorted(item for item in directory.rglob("*") if item.is_file() and item.name != "SHA256SUMS")
    raw = "".join(f"{hashlib.sha256(item.read_bytes()).hexdigest()}  {item.relative_to(directory).as_posix()}\n" for item in members)
    (directory / "SHA256SUMS").write_text(raw)
    return hashlib.sha256(raw.encode()).hexdigest()
def pack(artifact, directory):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        for member in sorted(directory.rglob("*")):
            if member.is_file():
                bundle.writestr(member.relative_to(directory).as_posix(), member.read_bytes())
    path(f"{prefix}/actions/artifacts/{artifact}/zip").write_bytes(output.getvalue())
def native(run, name, values, timestamp):
    lines = ["##[group]Run set -euo pipefail", "env:"]
    lines += [f"  {'SOURCE_SHA' if key == 'approved_sha' else key.upper()}: {value}" for key, value in values.items()]
    lines += ["  DISPATCH_INPUTS: " + json.dumps(values), "##[endgroup]"]
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        bundle.writestr(f"0_{name}.txt", "".join(f"{timestamp} {line}\n" for line in lines))
    path(f"{prefix}/actions/runs/{run}/attempts/1/logs").write_bytes(output.getvalue())
def run_valid(expected=True):
    result = subprocess.run([
        validator, "validate", "--repository", repo, "--binding", binding,
        "--subject-sha", current_source, "--run-id", "624",
        "--dispatch-inputs", inputs, "--runtime-mode", "oke",
    ], capture_output=True, text=True)
    if expected:
        assert result.returncode == 0, result.stderr
    else:
        assert result.returncode != 0, "substituted released-runtime lineage passed"
        assert "upstream binding rejected:" in result.stderr, result.stderr

earlier = base / "earlier-predecessor"
shutil.copytree(base / "predecessor", earlier)
values = env(earlier, "provenance.env")
values.update(source_sha=earlier_source, workflow_run_id="49", completed_at="2025-12-31T22:10:00Z")
write_env(earlier, "provenance.env", values)
authority = env(earlier, "resume-authority.env")
authority["current_source_sha"] = earlier_source
write_env(earlier, "resume-authority.env", authority)
earlier_sha = seal(earlier)
current = base / "predecessor"
values = env(current, "provenance.env")
values["completed_at"] = "2025-12-31T23:10:00Z"
write_env(current, "provenance.env", values)
authority = env(current, "resume-authority.env")
authority.update(failed_deploy_run_id="626", resume_maintenance_mode="retained-hold", rehold_step_conclusion="success")
write_env(current, "resume-authority.env", authority)
current_sha = seal(current)
baseline_sha = hashlib.sha256((base / "baseline" / "SHA256SUMS").read_bytes()).hexdigest()
for directory in (historical, public):
    shutil.rmtree(directory / "baseline")
    shutil.copytree(base / "baseline", directory / "baseline")
intent = env(historical / "deployment-recovery", "deployment-intent.env")
intent.update(data_run_id="49", data_evidence_sha256=earlier_sha,
              baseline_sha256=baseline_sha, baseline_capture_run_id="42")
write_env(historical / "deployment-recovery", "deployment-intent.env", intent)
intent_sha = hashlib.sha256((historical / "deployment-recovery" / "deployment-intent.env").read_bytes()).hexdigest()
(historical / "deployment-recovery" / "deployment-intent.sha256").write_text(f"{intent_sha}  deployment-intent.env\n")
failure = env(historical / "deployment-recovery", "failure-lineage.env")
failure["intent_sha256"] = intent_sha
write_env(historical / "deployment-recovery", "failure-lineage.env", failure)
seal(historical / "deployment-recovery")
provenance = env(public / "failed-deployment", "provenance.txt")
provenance["data_evidence_sha256"] = current_sha
write_env(public / "failed-deployment", "provenance.txt", provenance)
schema = env(public / "failed-deployment", "live-schema.env")
schema["baseline_sha256"] = baseline_sha
write_env(public / "failed-deployment", "live-schema.env", schema)
for artifact, directory in (
    (9818, earlier), (9814, current), (10326, historical / "baseline"),
    (21626, historical / "deployment-recovery"), (10324, public / "baseline"),
    (20624, public / "failed-deployment"),
):
    pack(artifact, directory)
write(f"{prefix}/actions/runs/49/artifacts?per_page=100", {
    "total_count": 1, "artifacts": [{"name": "oci-live-data-rollout-49-1",
        "id": 9818, "expired": False, "size_in_bytes": 8192}]})
for run, source, created, completed in (
    (49, earlier_source, "22:00:00", "22:10:00"),
    (43, current_source, "23:00:00", "23:10:00"),
    (626, earlier_source, "22:20:00", "22:30:00"),
):
    metadata = read(f"{prefix}/actions/runs/{43 if run == 49 else run}")
    metadata.update(id=run, head_sha=source, created_at=f"2025-12-31T{created}Z",
                    updated_at=f"2025-12-31T{completed}Z")
    if run != 626:
        metadata.update(conclusion="success", display_title=f"oci-live-data apply-slip-index {source}")
    for suffix in ("", "/attempts/1"):
        write(f"{prefix}/actions/runs/{run}{suffix}", metadata)
    jobs = read(f"{prefix}/actions/runs/{43 if run == 49 else run}/attempts/1/jobs?per_page=100")
    job = jobs["jobs"][0]
    job.update(id=run * 100, run_id=run)
    step = {"name": "Verify immutable image and infrastructure provenance" if run == 626
            else "Validate exact SHA phase and trusted upstream runs", "conclusion": "success",
            "started_at": f"2025-12-31T{'22:25:00' if run == 626 else created}Z",
            "completed_at": f"2025-12-31T{'22:26:00' if run == 626 else completed}Z"}
    if run == 626:
        job["steps"].append(step)
    else:
        job["steps"] = [step]
    write(f"{prefix}/actions/runs/{run}/attempts/1/jobs?per_page=100", jobs)
failed = {
    "approved_sha": earlier_source, "build_run_id": "41", "infrastructure_run_id": "44",
    "data_run_id": "49", "checkpoint_source_sha": root_source, "disk_checkpoint_run_id": "44",
    "baseline_recovery_run_id": "0", "baseline_recovery_source_sha": "none",
    "confirmation": "DEPLOY OCI EXACT SHA",
}
resume = {key: value for key, value in failed.items() if key != "data_run_id"}
resume.update(approved_sha=current_source, resume_source_sha=earlier_source, phase="apply-slip-index",
              prerequisite_run_id="49", failed_deploy_run_id="626", failed_activation_run_id="0",
              failed_activation_user_id="0", confirmation="RESUME APPLIED LIVE DATA EXACT SHA")
prior_resume = dict(resume, approved_sha=earlier_source, resume_source_sha=root_source,
                    prerequisite_run_id="42", failed_deploy_run_id="610")
native(626, "deploy", failed, "2025-12-31T22:25:30Z")
native(43, "rollout", resume, "2025-12-31T23:01:30Z")
native(49, "rollout", prior_resume, "2025-12-31T22:01:30Z")
run_valid()
print("PASS distinct root42/earlier49/retained626/resume43/released624 with actual native parser")

def reject_env(directory, name, key, bad, artifact, refresh_current=False):
    saved = {directory / name: (directory / name).read_bytes()}
    if (directory / "SHA256SUMS").exists():
        saved[directory / "SHA256SUMS"] = (directory / "SHA256SUMS").read_bytes()
    archive = path(f"{prefix}/actions/artifacts/{artifact}/zip")
    saved[archive] = archive.read_bytes()
    if refresh_current:
        for member in (public / "failed-deployment" / "provenance.txt",
                       path(f"{prefix}/actions/artifacts/20624/zip")):
            saved[member] = member.read_bytes()
    try:
        values = env(directory, name); values[key] = bad
        write_env(directory, name, values)
        if (directory / "SHA256SUMS").exists():
            changed_sha = seal(directory)
        pack(artifact, directory)
        if refresh_current:
            values = env(public / "failed-deployment", "provenance.txt")
            values["data_evidence_sha256"] = changed_sha
            write_env(public / "failed-deployment", "provenance.txt", values)
            pack(20624, public / "failed-deployment")
        run_valid(False)
    finally:
        for member, raw in saved.items():
            member.write_bytes(raw)
    print(f"PASS reject re-checksummed {name}:{key}")

for key, bad in (
    ("applied_data_run_id", "49"), ("applied_source_sha", earlier_source),
    ("failed_deploy_run_id", "610"), ("resume_maintenance_mode", "released-runtime"),
    ("lock_release_step_conclusion", "failure"),
):
    reject_env(current, "resume-authority.env", key, bad, 9814, True)
for key, bad in (
    ("source_sha", earlier_source), ("workflow_run_id", "49"), ("build_run_id", "99"),
    ("infrastructure_run_id", "99"), ("checkpoint_source_sha", earlier_source),
    ("disk_checkpoint_run_id", "99"), ("disk_checkpoint_sha256", "0" * 64),
    ("disk_checkpoint_disposition", "READY_NO_RECLAIM"), ("baseline_sha256", "0" * 64),
    ("baseline_recovery_run_id", "99"), ("baseline_recovery_source_sha", earlier_source),
):
    reject_env(base / "applied-predecessor", "provenance.env", key, bad, 9817)
reject_env(public / "baseline", "baseline-provenance.env", "baseline_capture_run_id", "43", 10324)
for run, name, values, timestamp, key, bad in (
    (43, "rollout", resume, "2025-12-31T23:01:30Z", "prerequisite_run_id", "42"),
    (43, "rollout", resume, "2025-12-31T23:01:30Z", "resume_source_sha", root_source),
    (43, "rollout", resume, "2025-12-31T23:01:30Z", "failed_deploy_run_id", "610"),
    (43, "rollout", resume, "2025-12-31T23:01:30Z", "confirmation", "DEPLOY OCI EXACT SHA"),
    (626, "deploy", failed, "2025-12-31T22:25:30Z", "data_run_id", "42"),
    (626, "deploy", failed, "2025-12-31T22:25:30Z", "build_run_id", "99"),
    (626, "deploy", failed, "2025-12-31T22:25:30Z", "confirmation", "RESUME APPLIED LIVE DATA EXACT SHA"),
):
    member = path(f"{prefix}/actions/runs/{run}/attempts/1/logs")
    original = member.read_bytes()
    native(run, name, {**values, key: bad}, timestamp)
    run_valid(False)
    member.write_bytes(original)
    print(f"PASS reject native {run}:{key}")
for run, key, bad in (
    (42, "head_sha", earlier_source), (42, "run_attempt", 2),
    (42, "display_title", "substituted"), (42, "conclusion", "failure"),
    (49, "head_sha", current_source), (49, "created_at", "2025-12-31T21:00:00Z"),
    (626, "updated_at", "2025-12-31T23:01:00Z"),
    (43, "created_at", "2025-12-31T22:20:00Z"),
):
    saved = {}
    for suffix in ("", "/attempts/1"):
        endpoint = f"{prefix}/actions/runs/{run}{suffix}"
        saved[path(endpoint)] = path(endpoint).read_bytes()
        metadata = read(endpoint); metadata[key] = bad; write(endpoint, metadata)
    run_valid(False)
    for member, raw in saved.items():
        member.write_bytes(raw)
    print(f"PASS reject native metadata {run}:{key}")
for endpoint in (
    f"{prefix}/actions/runs/626/attempts/1/logs",
    f"{prefix}/actions/runs/43/attempts/1/logs",
    f"{prefix}/actions/runs/42/artifacts?per_page=100",
    f"{prefix}/actions/runs/626/artifacts?per_page=100",
):
    member = path(endpoint); original = member.read_bytes(); member.unlink()
    run_valid(False)
    member.write_bytes(original)
sibling_source = subprocess.check_output([
    "git", "commit-tree", current_source + "^{tree}", "-p", root_source,
    "-m", "Record fixture non-ancestor",
    "-m", "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
], text=True).strip()
saved = {}
for suffix in ("", "/attempts/1"):
    endpoint = f"{prefix}/actions/runs/626{suffix}"
    saved[path(endpoint)] = path(endpoint).read_bytes()
    metadata = read(endpoint)
    metadata.update(head_sha=sibling_source, display_title=f"oci-deploy {sibling_source}")
    write(endpoint, metadata)
run_valid(False)
for member, raw in saved.items():
    member.write_bytes(raw)
run_valid()

policy = json.loads(policy_raw)
activation_binding = next(item for item in policy["upstreamRunBindings"]
                          if item["input"] == "failed_activation_run_id")
assert activation_binding["runProfile"] == "oci-failed-activation-released-resume-v1"
assert policy["operation"] == "oci-live-data-resume-activation-released"
assert policy["workflow"] == "oci-live-data-rollout.yml"

frozen_tree = subprocess.check_output([
    "git", "-C", checkout, "rev-parse", current_source + "^{tree}",
], text=True).strip()
assert frozen_tree == "bda7899f4ce0447ced6d7e119574f11fcdd8c8e4"
commit_endpoint = f"{prefix}/git/commits/{current_source}"
write(commit_endpoint, {"sha": current_source, "tree": {"sha": frozen_tree}})
frozen_blobs = {}
for filename, expected in (
    (".github/workflows/oci-live-betting-activate.yml", "a0f58534cd782b2c8ebff5c60bbf9588fd3f6bb2"),
    ("infra/oci/scripts/cash-back-acceptance-recovery-stan.js", "d899119717f491f6b6cceba2dc0785a0047e944f"),
    ("infra/oci/scripts/revalidate-live-activation-stan.sh", "3fe95e7138132e58599f7e7862843f918c5f45d5"),
):
    raw = subprocess.check_output(["git", "-C", checkout, "show", f"{current_source}:{filename}"])
    observed = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
    assert observed == expected, (filename, observed)
    endpoint = f"{prefix}/contents/{filename}?ref={current_source}"
    write(endpoint, {"sha": expected, "type": "file", "encoding": "base64",
                     "size": len(raw), "content": base64.b64encode(raw).decode()})
    frozen_blobs[filename] = raw

latest = base / "released-predecessor"
shutil.copytree(current, latest)
values = env(latest, "provenance.env")
values.update(workflow_run_id="50", completed_at="2026-01-01T00:10:00Z")
write_env(latest, "provenance.env", values)
authority = env(latest, "resume-authority.env")
authority.update(failed_deploy_run_id="624", resume_maintenance_mode="released-runtime",
                 failed_deploy_job_conclusion="success", public_validate_job_conclusion="failure",
                 lock_release_step_conclusion="success", fence_release_step_conclusion="success",
                 rehold_step_conclusion="skipped")
write_env(latest, "resume-authority.env", authority)
latest_sha = seal(latest)
pack(9850, latest)
write(f"{prefix}/actions/runs/50/artifacts?per_page=100", {
    "total_count": 1, "artifacts": [{"name": "oci-live-data-rollout-50-1", "id": 9850,
                                  "expired": False, "size_in_bytes": 8192}]})
metadata = read(f"{prefix}/actions/runs/43")
metadata.update(id=50, created_at="2026-01-01T00:05:00Z", updated_at="2026-01-01T00:10:00Z")
for suffix in ("", "/attempts/1"):
    write(f"{prefix}/actions/runs/50{suffix}", metadata)
write(f"{prefix}/actions/runs/50/attempts/1/jobs?per_page=100", {
    "total_count": 1, "jobs": [{"id": 5000, "run_id": 50, "name": "rollout",
    "status": "completed", "conclusion": "success", "steps": [{
        "name": "Validate exact SHA phase and trusted upstream runs", "conclusion": "success",
        "started_at": "2026-01-01T00:06:00Z", "completed_at": "2026-01-01T00:07:00Z"}]}]})
release_inputs = dict(resume, prerequisite_run_id="43", resume_source_sha=current_source,
                      failed_deploy_run_id="624",
                      confirmation="RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME EXACT SHA")
native(50, "rollout", release_inputs, "2026-01-01T00:06:30Z")
deployed_inputs = dict(failed, approved_sha=current_source, data_run_id="43")
native(624, "deploy", deployed_inputs, "2026-01-01T00:00:30Z")
jobs = read(f"{prefix}/actions/runs/624/attempts/1/jobs?per_page=100")
for index, job in enumerate(jobs["jobs"]):
    job.update(id=62400 + index, run_id=624, status="completed")
jobs["jobs"][0]["steps"].append({
    "name": "Verify immutable image and infrastructure provenance", "conclusion": "success",
    "started_at": "2026-01-01T00:00:00Z", "completed_at": "2026-01-01T00:01:00Z"})
write(f"{prefix}/actions/runs/624/attempts/1/jobs?per_page=100", jobs)

deployed = base / "released-successful-deployment"
shutil.copytree(public / "failed-deployment", deployed)
values = env(deployed, "provenance.txt")
values.update(deployment_run_id="51", data_run_id="50", data_evidence_sha256=latest_sha)
write_env(deployed, "provenance.txt", values)
values = env(deployed, "live-schema.env")
values["data_run_id"] = "50"
write_env(deployed, "live-schema.env", values)
pack(9851, deployed)
write(f"{prefix}/actions/runs/51/artifacts?per_page=100", {
    "total_count": 1, "artifacts": [{"name": "oci-deploy-provenance-51-1", "id": 9851,
                                  "expired": False, "size_in_bytes": 8192}]})
metadata = read(f"{prefix}/actions/runs/624")
metadata.update(id=51, conclusion="success",
                created_at="2026-01-01T00:20:00Z", updated_at="2026-01-01T00:30:00Z")
for suffix in ("", "/attempts/1"):
    write(f"{prefix}/actions/runs/51{suffix}", metadata)
write(f"{prefix}/actions/runs/51/attempts/1/jobs?per_page=100", {
    "total_count": 2, "jobs": [
        {"id": 5100, "run_id": 51, "name": "deploy", "status": "completed",
         "conclusion": "success", "steps": [{
            "name": "Verify immutable image and infrastructure provenance", "conclusion": "success",
            "started_at": "2026-01-01T00:21:00Z", "completed_at": "2026-01-01T00:22:00Z"}]},
        {"id": 5101, "run_id": 51, "name": "public-validate", "status": "completed",
         "conclusion": "success", "steps": []}]})
native(51, "deploy", dict(deployed_inputs, data_run_id="50"), "2026-01-01T00:21:30Z")

recovery = base / "pre-arm-recovery"
recovery.mkdir()
activation = env(base / "activation-recovery", "provenance.env")
activation.update(activation_run_id="52", deployment_run_id="51",
                  workflow_phase="activation-incomplete", activation_state="unknown",
                  live_kickoffs_enabled="unknown", activation_lease_until_epoch="unknown",
                  live_acceptance_user_id="none", final_control_file="none",
                  post_commit_status="not-applicable", revoke_runner_outcome="skipped",
                  close_bastion_outcome="success")
activation.update({key: "none" for key in (
    "activate_control_sha256", "acceptance_sha256", "accepted_sha256",
    "commit_control_sha256", "failure_disable_sha256", "final_disable_sha256",
    "final_control_sha256")})
activation.update({key: "skipped" for key in (
    "accepted_outcome", "accepted_evidence_upload_outcome", "commit_preflight_outcome",
    "commit_outcome", "failure_disable_outcome", "final_disable_outcome")})
write_env(recovery, "provenance.env", activation)
seal(recovery)
pack(9852, recovery)
write(f"{prefix}/actions/runs/52/artifacts?per_page=100", {
    "total_count": 2, "artifacts": [
        {"name": "oci-live-activation-recovery-52-1", "id": 9852,
         "expired": False, "size_in_bytes": 8192},
        {"name": "oci-live-activation-52-1", "id": 19852,
         "expired": False, "size_in_bytes": 8192}]})
metadata = read(f"{prefix}/actions/runs/623")
metadata.update(id=52, created_at="2026-01-01T00:40:00Z", updated_at="2026-01-01T00:50:00Z")
for suffix in ("", "/attempts/1"):
    write(f"{prefix}/actions/runs/52{suffix}", metadata)
names = re.findall(r"(?m)^      - name: (.+)$",
                   frozen_blobs[".github/workflows/oci-live-betting-activate.yml"].decode())
names = ["Set up job", *names, "Post Install browser acceptance dependencies",
         "Post Checkout exact current master", "Complete job"]
assert len(names) == 50
boundary = names.index("Arm owner-bound activation abort")
successes = {
    "Reconcile protected cash-back worker interruption", "Capture sanitized failure diagnostics",
    "Close ephemeral OCI Bastion access", "Write final activation provenance",
    "Prepare activation recovery authority", "Upload activation recovery authority",
    "Upload protected activation evidence", "Remove isolated client state",
    "Post Checkout exact current master", "Complete job",
}
oke_skips = {"Verify OKE identity", "Authorize current OKE runner",
             "Configure kubectl from exact OKE cluster"}
steps = []
for index, name in enumerate(names):
    conclusion = ("failure" if index == boundary else
                  "success" if (index < boundary and name not in oke_skips)
                  or name in successes else "skipped")
    start = dt.datetime(2026, 1, 1, 0, 40, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=index * 3)
    steps.append({"name": name, "number": index + 1 if index < 47 else index + 46,
                  "status": "completed", "conclusion": conclusion,
                  "started_at": start.isoformat().replace("+00:00", "Z"),
                  "completed_at": (start + dt.timedelta(seconds=2)).isoformat().replace("+00:00", "Z")})
write(f"{prefix}/actions/runs/52/attempts/1/jobs?per_page=100", {
    "total_count": 1, "jobs": [{"id": 5200, "run_id": 52, "name": "activate-and-validate",
                              "status": "completed", "conclusion": "failure", "steps": steps}]})
arm_values = {
    "SOURCE_SHA": current_source, "BUILD_RUN_ID": "41", "INFRASTRUCTURE_RUN_ID": "44",
    "DEPLOYMENT_RUN_ID": "51", "CHECKPOINT_SOURCE_SHA": root_source,
    "DISK_CHECKPOINT_RUN_ID": "44", "DISK_CHECKPOINT_SHA256": activation["disk_checkpoint_sha256"],
    "DISK_CHECKPOINT_DISPOSITION": "NOT_APPLICABLE", "CONFIRMATION": "ACTIVATE OCI LIVE BETTING",
}
marker = "##[group]Run node ./infra/oci/scripts/cash-back-acceptance-recovery-stan.js arm"
arm_lines = [marker, "env:", *[f"  {key}: {value}" for key, value in arm_values.items()],
             "##[endgroup]", "Protected cash-back source revalidation failed (1).",
             "##[error]Process completed with exit code 1."]
arm_time = (dt.datetime.fromisoformat(steps[boundary]["started_at"].replace("Z", "+00:00")) +
            dt.timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
def arm_log(lines, name="0_activate-and-validate.txt", timestamp=arm_time, extra=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        bundle.writestr(name, "".join(f"{timestamp} {line}\n" for line in lines))
        if extra:
            bundle.writestr(extra, "".join(f"{timestamp} {line}\n" for line in lines))
    path(f"{prefix}/actions/runs/52/attempts/1/logs").write_bytes(output.getvalue())
arm_log(arm_lines)
dispatch = dict(release_inputs, approved_sha=current_source, prerequisite_run_id="50",
                failed_activation_run_id="52", failed_activation_user_id="0",
                confirmation="RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME AND CLEAN FAILED ACTIVATION EXACT SHA")
for suffix in ("", "/attempts/1"):
    metadata = read(f"{prefix}/actions/runs/41{suffix}")
    metadata.update(created_at="2025-12-31T19:00:00Z", updated_at="2025-12-31T19:10:00Z")
    write(f"{prefix}/actions/runs/41{suffix}", metadata)
    metadata = read(f"{prefix}/actions/runs/44{suffix}")
    metadata["display_title"] = f"oci-infrastructure finalize oke {root_source}"
    write(f"{prefix}/actions/runs/44{suffix}", metadata)
write_env(base / "build", "build-chain.txt", {
    "source_sha": root_source, "build_run_id": "41", "build_run_attempt": "1",
    "anonymous_pull": "pass", "registry_host": "ghcr.io", "registry_provider": "ghcr",
    "registry_public": "true", "registry_repository": "ghcr.io/vasilyevstan/betstan-images",
})
pack(9811, base / "build")

result_file = pathlib.Path(work) / "pre-arm-result.json"
restored = pathlib.Path(work) / "pre-arm-restored-baseline"
expected_result = {
    "released_activation_qualification": "pre-arm-no-account",
    "resume_maintenance_mode": "released-runtime", "activation_deployment_run_id": "51",
    "applied_data_run_id": "42", "applied_source_sha": root_source,
    "baseline_run_id": "624", "baseline_artifact_name": "oci-production-baseline-624-1",
}
def pre_arm_valid(expected=True, request=None, selected_policy=None):
    result_file.unlink(missing_ok=True)
    if restored.exists():
        shutil.rmtree(restored)
    result = subprocess.run([
        validator, "validate-all", "--repository", repo, "--policy-json",
        json.dumps(policy if selected_policy is None else selected_policy),
        "--subject-sha", current_source, "--dispatch-inputs",
        json.dumps(dispatch if request is None else request), "--runtime-mode", "oke",
        "--result-json", str(result_file), "--baseline-dir", str(restored),
    ], capture_output=True, text=True)
    if expected:
        assert result.returncode == 0, result.stderr
        assert json.loads(result_file.read_text()) == {"failed_activation_run_id": expected_result}
        expected_files = {item.relative_to(public / "baseline").as_posix(): item.read_bytes()
                          for item in (public / "baseline").rglob("*") if item.is_file()}
        actual_files = {item.relative_to(restored).as_posix(): item.read_bytes()
                        for item in restored.rglob("*") if item.is_file()}
        assert actual_files == expected_files
    else:
        assert result.returncode != 0, ("unqualified pre-arm recovery passed", negative_cases)
        assert "upstream binding rejected:" in result.stderr, result.stderr
        assert not result_file.exists() and not restored.exists()
    return result
pre_arm_valid()
print("PASS full fixed-policy frozen pre-arm proof and data50/deployment51/activation52 with original root42")

negative_cases = 0
def reject_json(endpoint, change):
    global negative_cases
    member = path(endpoint)
    original = member.read_bytes()
    value = json.loads(original)
    change(value)
    member.write_text(json.dumps(value))
    try:
        pre_arm_valid(False)
    finally:
        member.write_bytes(original)
    negative_cases += 1

for run, key, value in (
    (52, "run_attempt", 2), (52, "head_sha", earlier_source),
    (52, "display_title", "oci-live-activate substituted"), (52, "event", "push"),
    (52, "path", ".github/workflows/oci-production-deploy.yml"), (52, "workflow_id", 1),
    (52, "head_repository", {"full_name": "other/repo"}), (52, "head_branch", "dev"),
    (52, "status", "waiting"), (52, "conclusion", "success"),
    (50, "head_sha", earlier_source), (50, "created_at", "2026-01-01T00:00:00Z"),
    (51, "head_sha", earlier_source), (51, "created_at", "2026-01-01T00:09:00Z"),
    (51, "updated_at", "2026-01-01T00:41:00Z"), (51, "run_attempt", 2),
    (624, "updated_at", "2026-01-01T00:06:00Z"),
):
    reject_json(f"{prefix}/actions/runs/{run}", lambda item, key=key, value=value: item.update({key: value}))
reject_json(commit_endpoint, lambda item: item["tree"].update(sha="0" * 40))
reject_json(commit_endpoint, lambda item: item.update(sha=earlier_source))
for filename in frozen_blobs:
    endpoint = f"{prefix}/contents/{filename}?ref={current_source}"
    for key, value in (("sha", "0" * 40), ("type", "symlink"), ("encoding", "utf8"),
                       ("size", 1), ("content", "%%%")):
        reject_json(endpoint, lambda item, key=key, value=value: item.update({key: value}))
    changed = frozen_blobs[filename] + b"\n# Changed executable closure.\n"
    reject_json(endpoint, lambda item, changed=changed:
                item.update(size=len(changed), content=base64.b64encode(changed).decode()))
for name in (
    "Resolve reusable validation account", "Activate new live kickoffs",
    "Arm owner-bound activation abort", "Exercise complete production live journey",
    "Write accepted activation lease evidence", "Commit accepted live activation",
    "Revoke and clean reusable validation account", "Grant and verify reusable administrator role",
    "Revalidate release head before permanent activation",
):
    matching = next(index for index, step in enumerate(steps) if step["name"] == name)
    reject_json(f"{prefix}/actions/runs/52/attempts/1/jobs?per_page=100",
                lambda item, matching=matching:
                item["jobs"][0]["steps"][matching].update(conclusion="success"))
for change in (
    lambda item: item["jobs"].append(copy.deepcopy(item["jobs"][0])),
    lambda item: item["jobs"][0]["steps"].append(copy.deepcopy(item["jobs"][0]["steps"][boundary])),
    lambda item: item["jobs"][0]["steps"][boundary].update(number=99),
    lambda item: item["jobs"][0]["steps"][boundary].update(started_at="2025-12-31T00:00:00Z"),
    lambda item: item["jobs"][0]["steps"][boundary].update(status="in_progress"),
):
    reject_json(f"{prefix}/actions/runs/52/attempts/1/jobs?per_page=100", change)
reject_json(f"{prefix}/actions/runs/51/attempts/1/jobs?per_page=100",
            lambda item: item["jobs"][1].update(conclusion="failure"))
reject_json(f"{prefix}/actions/runs/52/artifacts?per_page=100",
            lambda item: item["artifacts"].append(dict(item["artifacts"][0], id=999, name="unproved")))
reject_json(f"{prefix}/actions/runs/52/artifacts?per_page=100",
            lambda item: item["artifacts"][0].update(expired=True))
log_path = path(f"{prefix}/actions/runs/52/attempts/1/logs")
original_log = log_path.read_bytes()
for changed in (
    [*arm_lines[:-2], "echo Protected cash-back source revalidation failed (1).", arm_lines[-1]],
    [*arm_lines[:-2], "Protected cash-back source revalidation failed (1). extra", arm_lines[-1]],
    [*arm_lines, "extra output"], [*arm_lines, *arm_lines],
    [*arm_lines[:2], "  DEPLOYMENT_PROVENANCE_FILE: supplied", *arm_lines[2:]],
    [*arm_lines[:2], "  LIVE_SCHEMA_EVIDENCE_FILE: supplied", *arm_lines[2:]],
    [*arm_lines[:2], "  SOURCE_SHA: " + earlier_source, *arm_lines[2:]],
    [line for line in arm_lines if not line.startswith("  DEPLOYMENT_RUN_ID:")],
):
    arm_log(changed)
    pre_arm_valid(False)
    negative_cases += 1
for options in ({"name": "0_other-step.txt"}, {"extra": "1_activate-and-validate.txt"},
                {"timestamp": "2026-01-01T00:49:00Z"}):
    arm_log(arm_lines, **options)
    pre_arm_valid(False)
    negative_cases += 1
log_path.write_bytes(original_log)
for key in arm_values:
    changed = dict(arm_values, **{key: "substituted"})
    arm_log([marker, "env:", *[f"  {name}: {value}" for name, value in changed.items()],
             *arm_lines[-3:]])
    pre_arm_valid(False)
    negative_cases += 1
log_path.write_bytes(original_log)
for key, bad in (
    ("activation_state", "dark"), ("live_kickoffs_enabled", "false"),
    ("activation_lease_until_epoch", "0"), ("live_acceptance_user_id", "0123456789abcdef01234567"),
    ("activation_run_id", "53"), ("deployment_run_id", "45"), ("source_sha", earlier_source),
    ("checkpoint_source_sha", earlier_source), ("disk_checkpoint_sha256", "0" * 64),
    ("final_control_file", "control.env"), ("activate_control_sha256", "0" * 64),
    ("commit_outcome", "success"), ("revoke_runner_outcome", "success"),
):
    saved = {member: member.read_bytes() for member in (
        recovery / "provenance.env", recovery / "SHA256SUMS", path(f"{prefix}/actions/artifacts/9852/zip"))}
    values = env(recovery, "provenance.env"); values[key] = bad
    write_env(recovery, "provenance.env", values); seal(recovery); pack(9852, recovery)
    pre_arm_valid(False)
    for member, raw in saved.items():
        member.write_bytes(raw)
    negative_cases += 1
for member_name in ("control.env", "history.json", "extra/provenance.env"):
    extra = recovery / member_name
    extra.parent.mkdir(parents=True, exist_ok=True)
    extra.write_bytes(b"unproved\n")
    seal(recovery); pack(9852, recovery)
    pre_arm_valid(False)
    extra.unlink(); seal(recovery); pack(9852, recovery)
    negative_cases += 1
for key, bad in (
    ("failed_activation_user_id", ""), ("failed_activation_user_id", "invalid"),
    ("failed_activation_run_id", "53"), ("failed_deploy_run_id", "626"),
    ("prerequisite_run_id", "43"), ("confirmation", "RESUME APPLIED LIVE DATA EXACT SHA"),
):
    pre_arm_valid(False, request=dict(dispatch, **{key: bad}))
    negative_cases += 1
for key, bad in (("operation", "oci-live-data-resume-activation"), ("workflow", "oci-production-deploy.yml")):
    pre_arm_valid(False, selected_policy=dict(policy, **{key: bad}))
    negative_cases += 1
for run, values, name, timestamp, key, bad in (
    (50, release_inputs, "rollout", "2026-01-01T00:06:30Z", "prerequisite_run_id", "42"),
    (50, release_inputs, "rollout", "2026-01-01T00:06:30Z", "failed_deploy_run_id", "626"),
    (51, dict(deployed_inputs, data_run_id="50"), "deploy", "2026-01-01T00:21:30Z", "data_run_id", "43"),
    (624, deployed_inputs, "deploy", "2026-01-01T00:00:30Z", "data_run_id", "42"),
    (624, deployed_inputs, "deploy", "2026-01-01T00:00:30Z", "confirmation",
     "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME EXACT SHA"),
):
    member = path(f"{prefix}/actions/runs/{run}/attempts/1/logs")
    original = member.read_bytes()
    native(run, name, dict(values, **{key: bad}), timestamp)
    pre_arm_valid(False)
    member.write_bytes(original)
    negative_cases += 1

for key, bad in (
    ("applied_data_run_id", "49"), ("applied_source_sha", earlier_source),
    ("failed_deploy_run_id", "626"), ("failed_activation_run_id", "52"),
    ("resume_maintenance_mode", "retained-hold"), ("lock_release_step_conclusion", "failure"),
    ("resume-images.tsv", None),
):
    saved = {member: member.read_bytes() for member in (
        latest / "resume-authority.env", latest / "resume-images.tsv", latest / "SHA256SUMS",
        deployed / "provenance.txt", path(f"{prefix}/actions/artifacts/9850/zip"),
        path(f"{prefix}/actions/artifacts/9851/zip"))}
    values = env(latest, "resume-authority.env")
    if key == "resume-images.tsv":
        raw = (latest / key).read_bytes()
        changed = re.sub(rb"sha256:[0-9a-f]{64}", b"sha256:" + b"f" * 64, raw, count=1)
        assert changed != raw
        (latest / key).write_bytes(changed)
        values["runtime_images_sha256"] = hashlib.sha256(changed).hexdigest()
    else:
        values[key] = bad
    write_env(latest, "resume-authority.env", values)
    changed_sha = seal(latest)
    values = env(deployed, "provenance.txt")
    values["data_evidence_sha256"] = changed_sha
    write_env(deployed, "provenance.txt", values)
    pack(9850, latest); pack(9851, deployed)
    pre_arm_valid(False)
    for member, raw in saved.items():
        member.write_bytes(raw)
    negative_cases += 1

manifest_path = pathlib.Path(work) / "released-activation-manifest.json"
manifest_path.write_text(json.dumps({policy["operation"]: policy["upstreamRunBindings"]}))
result = subprocess.run([
    validator, "validate-all", "--repository", repo, "--manifest", str(manifest_path),
    "--operation", policy["operation"], "--subject-sha", current_source,
    "--dispatch-inputs", json.dumps(dispatch), "--runtime-mode", "oke",
], capture_output=True, text=True)
assert result.returncode != 0 and "fixed operation policy" in result.stderr, result.stderr
negative_cases += 1

pre_arm_valid()
print(f"PASS frozen pre-arm hostile metadata, executable closure, native output, artifact and immediate lineage cases={negative_cases}")

legacy_members = [
    path(f"{prefix}/actions/runs/52/attempts/1/jobs?per_page=100"),
    path(f"{prefix}/actions/artifacts/9852/zip"),
    path(f"{prefix}/actions/artifacts/19852/zip"),
]
saved = {member: member.read_bytes() if member.exists() else None for member in legacy_members}
legacy = base / "legacy-released-activation"
legacy_full = base / "legacy-released-activation-full"
shutil.copytree(base / "activation-recovery", legacy)
shutil.copytree(base / "activation-full", legacy_full)
for directory in (legacy, legacy_full):
    values = env(directory, "provenance.env")
    values.update(activation_run_id="52", deployment_run_id="51")
    write_env(directory, "provenance.env", values)
seal(legacy); pack(9852, legacy); pack(19852, legacy_full)
write(f"{prefix}/actions/runs/52/attempts/1/jobs?per_page=100", {
    "total_count": 1, "jobs": [{"name": "activate-and-validate", "conclusion": "failure",
    "steps": [{"name": name, "conclusion":
               "failure" if name == "Revoke and clean reusable validation account" else "success"} for name in (
        "Resolve reusable validation account", "Revoke and clean reusable validation account",
        "Enforce dark mode unless activation committed", "Write final activation provenance",
        "Upload protected activation evidence", "Upload activation recovery authority")]}]})
result_file.unlink()
shutil.rmtree(restored)
result = subprocess.run([
    validator, "validate-all", "--repository", repo, "--policy-json", policy_raw,
    "--subject-sha", current_source, "--dispatch-inputs",
    json.dumps(dict(dispatch, failed_activation_user_id="0123456789abcdef01234567")),
    "--runtime-mode", "oke", "--result-json", str(result_file), "--baseline-dir", str(restored),
], capture_output=True, text=True)
assert result.returncode != 0 and "failed deployment source lineage is invalid" in result.stderr, result.stderr
assert not result_file.exists() and not restored.exists()
for member, raw in saved.items():
    if raw is None:
        member.unlink(missing_ok=True)
    else:
        member.write_bytes(raw)
pre_arm_valid()
print("PASS released ObjectId retains original cleanup source equality for distinct-root rejection")

root = pathlib.Path(validator).resolve().parents[3]
def descendant(parent, text):
    subprocess.run(["git", "read-tree", parent], check=True)
    blob = subprocess.check_output(["git", "hash-object", "-w", "--stdin"],
                                   input=text, text=True).strip()
    subprocess.run(["git", "update-index", "--add", "--cacheinfo",
                    f"100644,{blob},docs/expired-handoff-fixture.md"], check=True)
    tree = subprocess.check_output(["git", "write-tree", "--missing-ok"], text=True).strip()
    return subprocess.check_output([
        "git", "commit-tree", tree, "-p", parent, "-m", text,
        "-m", "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
    ], text=True).strip(), tree
expired_source, _ = descendant(current_source, "Record expired holder fixture")
control_source, control_tree = descendant(expired_source, "Record new control fixture")
assert control_tree != "03381913c7ba16a9c9faf8699740e892564a6628"
resume_policy = json.loads(subprocess.check_output([
    str(root / "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"),
    "get", "oci-live-data-resume-deploy",
], text=True))
workflow_json = json.loads(subprocess.check_output([
    "ruby", "-ryaml", "-rjson", "-e",
    'puts JSON.generate(ARGV.map { |file| YAML.load_file(file) })',
    str(root / ".github/workflows/oci-live-data-rollout.yml"),
    str(root / ".github/workflows/oci-production-deploy.yml"),
], text=True))
producer_body = next(step["run"] for step in workflow_json[0]["jobs"]["rollout"]["steps"]
                     if step.get("name") == "Verify exact failed-deploy resume state")
producer_body = producer_body[producer_body.index("mkdir -p artifacts/oci-live-data-rollout/evidence"):
                              producer_body.index('if [ "$HELD_HANDOFF_RUN_ID" != "0" ]; then',
                                                  producer_body.index("resume_schema="))]
producer_template = producer_body
consumer_body = next(step["run"] for step in workflow_json[1]["jobs"]["deploy"]["steps"]
                     if step.get("name") == "Verify immutable image and infrastructure provenance")
consumer_body = consumer_body[consumer_body.index("EVIDENCE_DIR=artifacts/data \\\n"):]
consumer_body = consumer_body[:consumer_body.index(
    "./infra/oci/scripts/verify-live-betting-data-evidence-stan.sh") +
    len("./infra/oci/scripts/verify-live-betting-data-evidence-stan.sh")]

fresh = base / "expired-current-baseline"
shutil.copytree(public / "baseline", fresh / "oci-data-baseline-before")
before = fresh / "oci-data-baseline-before"
images = latest / "resume-images.tsv"
image_rows = [line.split("\t") for line in images.read_text().splitlines()]
assert len(image_rows) == 10
shutil.copyfile(images, before / "images.tsv")
(before / "live-images.tsv").write_text("".join(f"{row[0]}\t{row[2]}\n" for row in image_rows))
(before / "deployments.tsv").write_text("".join(
    f"{row[0]}\t{row[2]}\t1\t1\t1\t1\n" for row in image_rows))
(before / "pod-images.tsv").write_text("".join(
    f"{row[0]}\tbaseline-{row[0]}-0\t{row[1]}@{row[4]}\n" for row in image_rows))
(before / "queues.tsv").write_text("telemetry:events:v1\t0\t0\t1\n")
write_env(before, "telemetry-pre-run.env", {
    "mode": "retained", "image": next(row[2] for row in image_rows if row[0] == "telemetry"),
    "database_initialized": "true", "queue_present": "true"})
baseline_deploy = env(deployed, "provenance.txt")
assert baseline_deploy["image_provenance_sha256"] == hashlib.sha256(images.read_bytes()).hexdigest()
write_env(before, "trusted-deploy-provenance.txt", baseline_deploy)
values = env(before, "baseline-provenance.env")
values.update(baseline_capture_run_id="53", baseline_source_sha=current_source,
              baseline_deploy_run_id="51", baseline_build_run_id=baseline_deploy["build_run_id"])
write_env(before, "baseline-provenance.env", values)
fresh_sha = seal(before)
shutil.copytree(before, fresh / "oci-data-baseline-after")

def produce(run, source, authority="none", baseline=fresh_sha):
    directory = base / f"real-data-{run}"
    request = base / f"real-data-{run}-request.json"
    request.write_text(json.dumps({
        "source_sha": source, "build_run_id": "41", "infrastructure_run_id": "44",
        "checkpoint_source_sha": root_source, "disk_checkpoint_run_id": "44",
        "disk_checkpoint_sha256": activation["disk_checkpoint_sha256"],
        "disk_checkpoint_disposition": "NOT_APPLICABLE", "images_file": str(images),
        "output_dir": str(directory), "workflow_run_id": str(run),
        "baseline_sha256": baseline, "authority_file": str(authority),
    }))
    result = subprocess.run([
        "bash", str(root / "infra/oci/tests/test-live-betting-data-rollout-stan.sh"),
    ], env=dict(os.environ, PRODUCER_FIXTURE_REQUEST=str(request)),
        capture_output=True, text=True)
    assert result.returncode == 0, result.stderr + result.stdout
    return directory

def publish(run, artifact_id, name, directory):
    pack(artifact_id, directory)
    return {"id": artifact_id, "name": name, "expired": False,
            "size_in_bytes": path(f"{prefix}/actions/artifacts/{artifact_id}/zip").stat().st_size}

holder = produce(53, expired_source)
holder_artifacts = [
    publish(53, 9853, "oci-live-data-rollout-53-1", holder),
    publish(53, 19853, "oci-live-data-baselines-53-1", fresh),
]
write(f"{prefix}/actions/runs/53/artifacts?per_page=100",
      {"total_count": 2, "artifacts": holder_artifacts})
metadata = read(f"{prefix}/actions/runs/50")
metadata.update(id=53, head_sha=expired_source,
                display_title=f"oci-live-data apply-slip-index {expired_source}",
                created_at="2026-01-01T01:00:00Z", updated_at="2026-01-01T01:10:00Z")
for suffix in ("", "/attempts/1"):
    write(f"{prefix}/actions/runs/53{suffix}", metadata)
write(f"{prefix}/actions/runs/53/attempts/1/jobs?per_page=100", {
    "total_count": 1, "jobs": [{"id": 5300, "run_id": 53, "name": "rollout",
    "status": "completed", "conclusion": "success", "started_at": "2026-01-01T01:01:00Z",
    "steps": [{"name": "Validate exact SHA phase and trusted upstream runs", "conclusion": "success",
               "started_at": "2026-01-01T01:02:00Z", "completed_at": "2026-01-01T01:03:00Z"}]}]})
native(53, "rollout", dict(dispatch, approved_sha=expired_source,
                          resume_source_sha=current_source), "2026-01-01T01:02:30Z")
write(f"{prefix}/git/commits/{expired_source}", {
    "sha": expired_source, "tree": {"sha": "03381913c7ba16a9c9faf8699740e892564a6628"}})
write(f"{prefix}/git/commits/{control_source}",
      {"sha": control_source, "tree": {"sha": control_tree}})
for filename, blob in (
    (".github/workflows/oci-production-deploy.yml", "b0cf0e993396032f526bbf3304989b3de57a4e0a"),
    ("infra/oci/scripts/live-data-maintenance-stan.sh", "7de9fee1d1f08323b04ef44ce8f58066f88e12ae"),
    ("infra/oci/scripts/shared-mongo-operation-lock-stan.sh", "6b00d8f38ae2adf7c700c1da1509134631298a31"),
    ("infra/azure/agents/shared-mongo-operation-lock-stan.sh", "1bcf7a3a922ad80b83a9170bfaaef3dcf1b2dc63"),
):
    write(f"{prefix}/contents/{filename}?ref={expired_source}", {"sha": blob})
names = ["Set up job", *[step["name"] for step in workflow_json[1]["jobs"]["deploy"]["steps"]],
         "Post Checkout approved master commit", "Complete job"]
successes = set(names[:17]) - {
    "Verify k3s identity", "Open ephemeral OCI Bastion access to k3s",
    "Verify transferred database lock and maintenance fence"}
successes.update({"Upload sanitized live readiness evidence", "Revoke exact runner rule",
                  "Remove isolated OCI client state", "Post Checkout approved master commit", "Complete job"})
receiver_steps = []
for index, name in enumerate(names):
    start = dt.datetime(2026, 1, 1, 1, 20, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=index * 3)
    receiver_steps.append({
        "name": name, "number": index + 1 if index < 38 else index + 38,
        "status": "completed",
        "conclusion": "failure" if index == 16 else "success" if name in successes else "skipped",
        "started_at": start.isoformat().replace("+00:00", "Z"),
        "completed_at": (start + dt.timedelta(seconds=2)).isoformat().replace("+00:00", "Z"),
    })
metadata = read(f"{prefix}/actions/runs/624")
metadata.update(id=54, head_sha=expired_source, display_title=f"oci-deploy {expired_source}",
                created_at="2026-01-01T01:19:00Z", updated_at="2026-01-01T01:24:00Z")
for suffix in ("", "/attempts/1"):
    write(f"{prefix}/actions/runs/54{suffix}", metadata)
write(f"{prefix}/actions/runs/54/attempts/1/jobs?per_page=100", {
    "total_count": 2, "jobs": [
        {"id": 5400, "run_id": 54, "name": "deploy", "status": "completed", "conclusion": "failure",
         "started_at": "2026-01-01T01:20:00Z", "completed_at": "2026-01-01T01:23:00Z",
         "steps": receiver_steps},
        {"id": 5401, "run_id": 54, "name": "public-validate", "status": "completed",
         "conclusion": "skipped", "started_at": "2026-01-01T01:23:00Z",
         "completed_at": "2026-01-01T01:23:00Z", "steps": []}]})
write(f"{prefix}/actions/runs/54/artifacts?per_page=100", {"total_count": 0, "artifacts": []})
native(54, "deploy", dict(deployed_inputs, approved_sha=expired_source, data_run_id="53"),
       "2026-01-01T01:20:28Z")
log_file = path(f"{prefix}/actions/runs/54/attempts/1/logs")
with zipfile.ZipFile(io.BytesIO(log_file.read_bytes())) as bundle:
    raw = bundle.read("0_deploy.txt")
raw += b"2026-01-01T01:20:49Z live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true\n"
raw += b"2026-01-01T01:20:49Z shared_mongo_lock=verify status=FAIL reason=active database operation lock has expired\n"
output = io.BytesIO()
with zipfile.ZipFile(output, "w") as bundle:
    bundle.writestr("0_deploy.txt", raw)
log_file.write_bytes(output.getvalue())
request = dict(resume, approved_sha=control_source, resume_source_sha=expired_source,
               prerequisite_run_id="53", failed_deploy_run_id="54")
workflows = subprocess.check_output([
    str(root / "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"),
    "workflows",
], text=True).splitlines()
for workflow in set(workflows) - {
    "common-package-publish.yml", "production-build.yml", "oci-production-build.yml",
}:
    rows = ([read(f"{prefix}/actions/runs/54")] if workflow == "oci-production-deploy.yml"
            else [read(f"{prefix}/actions/runs/53")] if workflow == "oci-live-data-rollout.yml" else [])
    write(f"{prefix}/actions/workflows/{workflow}/runs?per_page=100",
          {"total_count": len(rows), "workflow_runs": rows})
resolved = pathlib.Path(work) / "expired-result.json"
result = subprocess.run([
    validator, "validate-all", "--repository", repo, "--policy-json", json.dumps(resume_policy),
    "--subject-sha", control_source, "--dispatch-inputs", json.dumps(request),
    "--runtime-mode", "oke", "--result-json", str(resolved),
], capture_output=True, text=True)
assert result.returncode == 0, result.stderr
qualification = json.loads(resolved.read_text())["failed_deploy_run_id"]
assert qualification["no_takeover_handoff_qualification"] == "expired-own-handoff"
assert (qualification["applied_data_run_id"], qualification["applied_source_sha"]) == ("42", root_source)
assert qualification["baseline_capture_run_id"] == "53"

history_endpoint = f"{prefix}/actions/workflows/oci-live-data-rollout.yml/runs?per_page=100"
before_successor_history = read(history_endpoint)
waiting_successor = read(f"{prefix}/actions/runs/53")
waiting_successor.update(
    id=55, head_sha=control_source, display_title=f"oci-live-data apply-slip-index {control_source}",
    status="waiting", conclusion=None, created_at="2026-01-01T01:30:00Z",
    updated_at="2026-01-01T01:30:00Z",
)
for suffix in ("", "/attempts/1"):
    write(f"{prefix}/actions/runs/55{suffix}", waiting_successor)
write(history_endpoint, {
    "total_count": before_successor_history["total_count"] + 1,
    "workflow_runs": [*before_successor_history["workflow_runs"], waiting_successor],
})
for successor_args in ([], ["--successor-run-id", "55"]):
    resolved.unlink(missing_ok=True)
    result = subprocess.run([
        validator, "validate-all", "--repository", repo, "--policy-json", json.dumps(resume_policy),
        "--subject-sha", control_source, "--dispatch-inputs", json.dumps(request),
        "--runtime-mode", "oke", "--result-json", str(resolved), *successor_args,
    ], capture_output=True, text=True)
    if successor_args:
        assert result.returncode == 0, result.stderr
        own_qualification = json.loads(resolved.read_text())["failed_deploy_run_id"]
        assert own_qualification == qualification
    else:
        assert result.returncode != 0 and "not a candidate for native no-execution history" in result.stderr
        assert not resolved.exists()

# Execute the actual step13 consumer before any new resume envelope exists.
provenance_body = next(
    step["run"] for step in workflow_json[0]["jobs"]["rollout"]["steps"]
    if step.get("name") == "Verify immutable release and phase provenance"
)
caller_body = provenance_body[
    provenance_body.index('resume_native_dispatch_inputs=""'):
    provenance_body.index('resume_artifact_name=')
]
caller = pathlib.Path(checkout) / "expired-envelope-free-caller"
(caller / "artifacts").mkdir(parents=True)
(caller / "runner").mkdir()
(caller / "infra").symlink_to(root / "infra", target_is_directory=True)
shutil.copytree(holder, caller / "artifacts/prerequisite")
shutil.copytree(before, caller / "artifacts/oci-data-baseline-before")
assert not (caller / "artifacts/prerequisite/resume-authority.env").exists()
caller_result = caller / "runner/live-data-upstream-result.json"
caller_result.write_text(json.dumps({"failed_deploy_run_id": qualification}))
caller_env = dict(
    os.environ, REPOSITORY=repo, RUNNER_TEMP=str(caller / "runner"),
    GITHUB_RUN_ID="55", GITHUB_OUTPUT=str(caller / "outputs"),
    SOURCE_SHA=control_source, DISPATCH_INPUTS=json.dumps(request),
    prior_source_sha=expired_source, prior_build_run_id="41",
    prior_infrastructure_run_id="44", PREREQUISITE_RUN_ID="53",
    CHECKPOINT_SOURCE_SHA=root_source, DISK_CHECKPOINT_RUN_ID="44",
    disk_checkpoint_sha256=activation["disk_checkpoint_sha256"],
    disk_checkpoint_disposition="NOT_APPLICABLE", BASELINE_RECOVERY_RUN_ID="0",
    BASELINE_RECOVERY_SOURCE_SHA="none", HELD_HANDOFF_RUN_ID="0",
)
def call_envelope_free(expected=True, body=caller_body, changes=None):
    result = subprocess.run(
        ["bash", "-euc", 'set_output() { printf "%s=%s\\n" "$1" "$2" >> "$GITHUB_OUTPUT"; }\n' + body],
        cwd=caller, env=dict(caller_env, **(changes or {})), capture_output=True, text=True,
    )
    assert (result.returncode == 0) == expected, result.stderr + result.stdout
    if expected:
        assert "applied_data_run_id=42" in result.stdout
        assert f"applied_source_sha={root_source}" in result.stdout
        assert "prerequisite_data_run_id=53" in result.stdout
    return result

call_envelope_free()
call_envelope_free(False, caller_body.replace("VERIFY_RESUME_APPLIED_RUN=true", "VERIFY_RESUME_APPLIED_RUN=false"))
call_envelope_free(False, changes={"DISPATCH_INPUTS": json.dumps(dict(request, prerequisite_run_id="42"))})
call_envelope_free(False, changes={"DISPATCH_INPUTS": json.dumps(dict(request, resume_source_sha=root_source))})
call_envelope_free(False, caller_body.replace('RESUME_SUCCESSOR_RUN_ID="$resume_successor_run_id"',
                                             'RESUME_SUCCESSOR_RUN_ID=54'))
caller_result.write_text(json.dumps({"failed_deploy_run_id": {}}))
missing = call_envelope_free(False)
assert "Resolved original applied data source differs" in missing.stderr
caller_result.write_text(json.dumps({"failed_deploy_run_id": qualification}))
for key, bad in (
    ("baseline_capture_run_id", "42"), ("baseline_source_sha", expired_source),
    ("baseline_deploy_run_id", "54"),
):
    directory = caller / "artifacts/oci-data-baseline-before"
    evidence = caller / "artifacts/prerequisite"
    members = [directory / "baseline-provenance.env", directory / "SHA256SUMS",
               evidence / "provenance.env", evidence / "schema.env", evidence / "SHA256SUMS"]
    saved = {member: member.read_bytes() for member in members}
    values = env(directory, "baseline-provenance.env"); values[key] = bad
    write_env(directory, "baseline-provenance.env", values); substituted = seal(directory)
    for name in ("provenance.env", "schema.env"):
        values = env(evidence, name); values["baseline_sha256"] = substituted
        write_env(evidence, name, values)
    seal(evidence); call_envelope_free(False)
    for member, raw in saved.items():
        member.write_bytes(raw)
call_envelope_free()
print("PASS extracted step13 caller -> real envelope-free v6 verifier -> native qualifier preserves capture53/root42; context/native-self/native-verification/capture substitutions reject")

write(history_endpoint, before_successor_history)
for suffix in ("", "/attempts/1"):
    path(f"{prefix}/actions/runs/55{suffix}").unlink()
print("PASS real expired-resume policy rejects omitted waiting self and accepts only authenticated control-source successor")

producer_dir = pathlib.Path(checkout) / "expired-producer"
producer_dir.mkdir()
expressions = {
    **{f"steps.provenance_request.outputs.{key}": qualification[key] for key in (
        "failed_deploy_job_conclusion", "public_validate_job_conclusion",
        "lock_release_step_conclusion", "fence_release_step_conclusion", "rehold_step_conclusion")},
    "steps.provenance.outputs.disk_checkpoint_sha256": activation["disk_checkpoint_sha256"],
    "steps.provenance.outputs.disk_checkpoint_disposition": "NOT_APPLICABLE",
}
producer_body = re.sub(r"\$\{\{\s*([^{}]+?)\s*\}\}",
                       lambda match: expressions[match.group(1)], producer_body)
producer_env = dict(os.environ, HELD_HANDOFF_RUN_ID="0",
    RESOLVED_APPLIED_DATA_RUN_ID=qualification["applied_data_run_id"],
    RESOLVED_APPLIED_SOURCE_SHA=qualification["applied_source_sha"],
    FAILED_DEPLOY_RUN_ID="54", RESUME_MAINTENANCE_MODE="pre-runtime-hold",
    FAILED_ACTIVATION_RUN_ID="0", SOURCE_SHA=control_source, observed_baseline_sha=fresh_sha,
    resume_images=str(images), CHECKPOINT_SOURCE_SHA=root_source, DISK_CHECKPOINT_RUN_ID="44")
result = subprocess.run(["bash", "-euc", producer_body], cwd=producer_dir,
                        env=producer_env, capture_output=True, text=True)
assert result.returncode == 0, result.stderr
authority_file = producer_dir / "artifacts/oci-live-data-rollout/evidence/resume-authority.env"
authority = env(authority_file.parent, authority_file.name)
assert authority["schema_version"] == "live-betting-data-resume-v2"
assert "no_takeover_handoff_qualification" not in authority
successor = produce(55, control_source, authority_file)
write(f"{prefix}/actions/runs/55/artifacts?per_page=100", {
    "total_count": 1, "artifacts": [publish(55, 9855, "oci-live-data-rollout-55-1", successor)]})
metadata = read(f"{prefix}/actions/runs/53")
metadata.update(id=55, head_sha=control_source, display_title=f"oci-live-data apply-slip-index {control_source}",
                created_at="2026-01-01T01:30:00Z", updated_at="2026-01-01T01:40:00Z")
for suffix in ("", "/attempts/1"):
    write(f"{prefix}/actions/runs/55{suffix}", metadata)
write(f"{prefix}/actions/runs/55/attempts/1/jobs?per_page=100", {
    "total_count": 1, "jobs": [{"id": 5500, "run_id": 55, "name": "rollout",
    "status": "completed", "conclusion": "success", "started_at": "2026-01-01T01:31:00Z",
    "steps": [{"name": "Validate exact SHA phase and trusted upstream runs", "conclusion": "success",
               "started_at": "2026-01-01T01:32:00Z", "completed_at": "2026-01-01T01:33:00Z"}]}]})
native(55, "rollout", request, "2026-01-01T01:32:30Z")
for workflow in set(workflows) - {
    "common-package-publish.yml", "production-build.yml", "oci-production-build.yml",
}:
    original = read(f"{prefix}/actions/workflows/{workflow}/runs?per_page=100")
    if workflow == "oci-live-data-rollout.yml":
        original["workflow_runs"].append(read(f"{prefix}/actions/runs/55"))
        original["total_count"] += 1
    write(f"{prefix}/actions/workflows/{workflow}/runs?per_page=100&created=%3C%3D2026-01-01T01:32:00Z",
          original)
consumer_dir = pathlib.Path(checkout) / "expired-consumer"
(consumer_dir / "artifacts").mkdir(parents=True)
(consumer_dir / "infra").symlink_to(root / "infra", target_is_directory=True)
shutil.copytree(successor, consumer_dir / "artifacts/data")
shutil.copytree(before, consumer_dir / "artifacts/oci-baseline")
consumer_env = dict(os.environ, SOURCE_SHA=control_source, BUILD_RUN_ID="41",
    INFRASTRUCTURE_RUN_ID="44", CHECKPOINT_SOURCE_SHA=root_source,
    DISK_CHECKPOINT_RUN_ID="44", DATA_RUN_ID="55",
    disk_checkpoint_sha256=activation["disk_checkpoint_sha256"],
    disk_checkpoint_disposition="NOT_APPLICABLE", BASELINE_RECOVERY_RUN_ID="0",
    BASELINE_RECOVERY_SOURCE_SHA="none", GITHUB_REPOSITORY=repo, OCI_RUNTIME_MODE="oke")
def consume(expected=True, body=consumer_body):
    result = subprocess.run(["bash", "-euc", body], cwd=consumer_dir,
                            env=consumer_env, capture_output=True, text=True)
    assert (result.returncode == 0) == expected, result.stderr + result.stdout
    if expected:
        assert f"applied_source_sha={root_source}" in result.stdout
        assert "applied_data_run_id=42" in result.stdout
    else:
        assert "status=PASS" not in result.stdout
    return result
consume()
print("PASS real YAML v2 authority and complete evidence producer -> native-enabled local verifier -> normal deployment consumer, capture53/root42/new control tree")
for key, bad in (
    ("applied_data_run_id", "53"), ("applied_source_sha", expired_source),
    ("baseline_sha256", "0" * 64), ("no_takeover_handoff_qualification", "expired-own-handoff"),
):
    directory = consumer_dir / "artifacts/data"
    saved = {member: member.read_bytes() for member in (directory / "resume-authority.env",
                                                       directory / "SHA256SUMS")}
    values = env(directory, "resume-authority.env"); values[key] = bad
    write_env(directory, "resume-authority.env", values); seal(directory)
    consume(False)
    for member, raw in saved.items():
        member.write_bytes(raw)
consume(False, consumer_body.replace("VERIFY_RESUME_APPLIED_RUN=true", "VERIFY_RESUME_APPLIED_RUN=false"))
directory = consumer_dir / "artifacts/data"
saved = {member: member.read_bytes() for member in (directory / "resume-authority.env",
                                                   directory / "SHA256SUMS")}
values = env(directory, "resume-authority.env")
values.update(applied_data_run_id="53", applied_source_sha=expired_source)
write_env(directory, "resume-authority.env", values); seal(directory)
consume(False)
for member, raw in saved.items():
    member.write_bytes(raw)

baseline = consumer_dir / "artifacts/oci-baseline"
for key, bad in (("baseline_capture_run_id", "42"), ("baseline_source_sha", expired_source),
                 ("baseline_deploy_run_id", "54")):
    members = [baseline / "baseline-provenance.env", baseline / "SHA256SUMS",
               directory / "provenance.env", directory / "schema.env",
               directory / "resume-authority.env", directory / "SHA256SUMS"]
    saved = {member: member.read_bytes() for member in members}
    values = env(baseline, "baseline-provenance.env"); values[key] = bad
    write_env(baseline, "baseline-provenance.env", values)
    substituted_sha = seal(baseline)
    for name in ("provenance.env", "schema.env", "resume-authority.env"):
        values = env(directory, name); values["baseline_sha256"] = substituted_sha
        write_env(directory, name, values)
    seal(directory)
    consume(False)
    for member, raw in saved.items():
        member.write_bytes(raw)
for member, bad in (
    (log_file, None),
    (path(f"{prefix}/git/commits/{expired_source}"),
     json.dumps({"sha": expired_source, "tree": {"sha": "9" * 40}}).encode()),
):
    original = member.read_bytes()
    if bad is None:
        member.unlink()
    else:
        member.write_bytes(bad)
    consume(False)
    member.write_bytes(original)
endpoint = f"{prefix}/actions/workflows/oci-production-deploy.yml/runs?per_page=100&created=%3C%3D2026-01-01T01:32:00Z"
member = path(endpoint); original = member.read_bytes()
history = json.loads(original)
late = dict(metadata, id=56, path=".github/workflows/oci-production-deploy.yml",
            created_at="2026-01-01T01:25:00Z", updated_at="2026-01-01T01:29:00Z")
history["workflow_runs"].append(late); history["total_count"] += 1
write(endpoint, history); consume(False); member.write_bytes(original)
consume()
print("PASS native-enabled capture/digest/source substitutions, both root relabellings, unknown wire key, disabled/missing/unqualified native proof and late supersession reject")

import argparse, contextlib, importlib.util
from unittest.mock import patch

fixture_snapshot = {item: item.read_bytes() for item in pathlib.Path(fixtures).iterdir() if item.is_file()}
spec = importlib.util.spec_from_file_location("complete_expired_roundtrip", validator)
complete_reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(complete_reader)
subprocess.run(["git", "read-tree", control_source], check=True)
native_paths = {
    ".github/workflows/oci-live-data-rollout.yml",
    "infra/oci/scripts/live-betting-data-rollout-stan.sh",
    "infra/oci/scripts/live-data-maintenance-stan.sh",
    "infra/oci/scripts/shared-mongo-operation-lock-stan.sh",
    "infra/azure/agents/shared-mongo-operation-lock-stan.sh",
    "infra/oci/scripts/upstream_run_binding_stan.py",
    "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh",
    "infra/oci/scripts/baseline-capture-stan.sh",
    "infra/oci/scripts/validate-rollback-baseline-stan.sh",
    "infra/oci/scripts/k3s-node-disk-recovery-stan.sh",
    "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh",
}
native_blobs = {}
for filename in sorted(native_paths):
    member = root / filename
    raw = member.read_bytes()
    blob = subprocess.check_output(["git", "hash-object", "-w", "--stdin"], input=raw).decode().strip()
    mode = "100755" if os.access(member, os.X_OK) else "100644"
    subprocess.run(["git", "update-index", "--add", "--cacheinfo",
                    f"{mode},{blob},{filename}"], check=True)
    native_blobs[filename] = blob
native_tree = subprocess.check_output(["git", "write-tree", "--missing-ok"], text=True).strip()
native_source = subprocess.check_output([
    "git", "commit-tree", native_tree, "-p", control_source, "-m", "Complete native fixture",
    "-m", "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
], text=True).strip()
write(f"{prefix}/git/commits/{native_source}", {"sha": native_source, "tree": {"sha": native_tree}})
for filename, blob in native_blobs.items():
    write(f"{prefix}/contents/{filename}?ref={native_source}", {"type": "file", "sha": blob})

def complete_native(run, values, minute):
    names = ["Set up job", *[step["name"] for step in workflow_json[0]["jobs"]["rollout"]["steps"]],
             "Post Checkout approved current master commit", "Complete job"]
    skipped = {
        "Download failed deploy protected baseline", "Verify reader-qualified released activation state",
        "Demote and verify exact retained live-acceptance account",
        "Delete exact orphaned live-acceptance slips", "Capture post-phase runtime baseline",
        "Restore runtime or retain hold if final handoff packaging failed",
        "Release database operation lock unless handed to deploy",
        "Download explicitly selected recovery baseline authority",
        "Bind historical recovery source through its exact artifact",
        "Verify k3s identity", "Open ephemeral OCI Bastion access to k3s",
        "Revalidate exact release disk checkpoint before lock mutation", "Close ephemeral OCI Bastion access",
    }
    began = dt.datetime(2026, 1, 1, 3, minute, tzinfo=dt.timezone.utc)
    steps = []
    for index, name in enumerate(names):
        start = began + dt.timedelta(seconds=index * 2)
        steps.append(dict(name=name, number=index + 1, status="completed",
            conclusion="skipped" if name in skipped else "success",
            started_at=start.isoformat(), completed_at=(start + dt.timedelta(seconds=1)).isoformat()))
    steps[-2]["number"] = 2 * (len(names) - 2)
    steps[-1]["number"] = steps[-2]["number"] + 1
    ended = began + dt.timedelta(seconds=len(names) * 2)
    metadata = dict(read(f"{prefix}/actions/runs/55"), id=run, head_sha=native_source,
        html_url=f"https://github.com/{repo}/actions/runs/{run}",
        display_title=f"oci-live-data apply-slip-index {native_source}", status="completed",
        conclusion="success", created_at=(began - dt.timedelta(seconds=60)).isoformat(),
        run_started_at=began.isoformat(), updated_at=(ended + dt.timedelta(seconds=2)).isoformat())
    for suffix in ("", "/attempts/1"):
        write(f"{prefix}/actions/runs/{run}{suffix}", metadata)
    write(f"{prefix}/actions/runs/{run}/attempts/1/jobs?per_page=100", {
        "total_count": 1, "jobs": [dict(id=run * 100, run_id=run, name="rollout",
            status="completed", conclusion="success", started_at=began.isoformat(),
            completed_at=ended.isoformat(), steps=steps)]})
    admission = next(step for step in steps if step["name"] == "Validate exact SHA phase and trusted upstream runs")
    native(run, "rollout", values, admission["started_at"].replace("+00:00", "Z"))
    archive = path(f"{prefix}/actions/runs/{run}/attempts/1/logs")
    with zipfile.ZipFile(io.BytesIO(archive.read_bytes())) as bundle:
        raw = bundle.read("0_rollout.txt")
    renewal = next(step for step in steps if step["name"] == "Restore runtime or verify final deploy handoff")
    renewed = dt.datetime.fromisoformat(renewal["started_at"])
    deadline = int(renewed.timestamp()) + 1800
    generation = 12 if run == 155 else 14
    for message in (
        "live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true",
        f"shared_mongo_lock=verify status=PASS lease_until_epoch={deadline + 10800} fencing_generation={generation - 1}",
        f"shared_mongo_lock=renew status=PASS lease_until_epoch={deadline} fencing_generation={generation}",
    ):
        raw += f"{renewal['started_at'].replace('+00:00', 'Z')} {message}\n".encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        bundle.writestr("0_rollout.txt", raw)
    archive.write_bytes(output.getvalue())
    return metadata, admission["started_at"]

def complete_package(run, directory, metadata):
    members = [
        publish(run, 50000 + run, f"oci-live-data-rollout-{run}-1", directory),
        publish(run, 60000 + run, f"oci-live-data-baselines-{run}-1", fresh),
    ]
    for item in members:
        item.update(workflow_run=dict(id=run, head_sha=native_source, head_branch="master"),
            created_at=metadata["updated_at"], expires_at="2099-01-01T00:00:00Z",
            digest="sha256:" + hashlib.sha256(
                path(f"{prefix}/actions/artifacts/{item['id']}/zip").read_bytes()).hexdigest())
    write(f"{prefix}/actions/runs/{run}/artifacts?per_page=100",
          {"total_count": 2, "artifacts": members})

native_request = dict(request, approved_sha=native_source)
native_authority_dir = base / "complete-expired-authority"
native_authority_dir.mkdir()
body = re.sub(r"\$\{\{\s*([^{}]+?)\s*\}\}", lambda match: expressions[match.group(1)], producer_template)
result = subprocess.run(["bash", "-euc", body], cwd=native_authority_dir,
    env=dict(producer_env, SOURCE_SHA=native_source), capture_output=True, text=True)
assert result.returncode == 0, result.stderr
native_authority = native_authority_dir / "artifacts/oci-live-data-rollout/evidence/resume-authority.env"
complete155 = produce(155, native_source, native_authority)
metadata155, cutoff155 = complete_native(155, native_request, 0)
complete_package(155, complete155, metadata155)
continuation = dict(native_request, confirmation=complete_reader.HELD_HANDOFF_CONFIRMATION,
                    held_handoff_run_id="155", held_handoff_source_sha=native_source)
held_policy = json.loads(subprocess.check_output([
    str(root / "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"),
    "get", "oci-live-data-continue-held-handoff",
], text=True))
continuation = {name: continuation[name] for name in held_policy["inputNames"]}
continuation.update(held_policy["fixedInputs"])
assert set(continuation) == set(held_policy["inputNames"])
metadata156, cutoff156 = complete_native(156, continuation, 10)
for workflow in set(workflows) - {
    "common-package-publish.yml", "production-build.yml", "oci-production-build.yml",
}:
    rows = ([read(f"{prefix}/actions/runs/53"), metadata155, metadata156]
            if workflow == "oci-live-data-rollout.yml" else
            [read(f"{prefix}/actions/runs/54")] if workflow == "oci-production-deploy.yml" else [])
    endpoint = f"{prefix}/actions/workflows/{workflow}/runs?per_page=100"
    write(endpoint, {"total_count": len(rows), "workflow_runs": rows})
    for cutoff in (cutoff155, cutoff156):
        selected = [row for row in rows if dt.datetime.fromisoformat(
            row["created_at"].replace("Z", "+00:00")) <= dt.datetime.fromisoformat(cutoff)]
        write(endpoint + "&created=%3C%3D" + cutoff.replace("+00:00", "Z"),
              {"total_count": len(selected), "workflow_runs": selected})
held_binding = next(item for item in held_policy["upstreamRunBindings"]
                    if item["input"] == "held_handoff_run_id")
with patch.object(complete_reader, "held_handoff_authority") as private_authority:
    held155 = complete_reader.validate_binding(
        repo, held_binding, native_source, "155", continuation, "oke", successor_run_id="156")
    assert held155["resume"]["applied_data_run_id"] == "42"
    assert held155["resume"]["baseline_capture_run_id"] == "53"
    failed_binding = next(item for item in held_policy["upstreamRunBindings"]
                          if item["input"] == "failed_deploy_run_id")
    failed_root = complete_reader.validate_binding(
        repo, failed_binding, native_source, "54", continuation, "oke", successor_run_id="156")
    assert failed_root["baselineFiles"] == held155["baselineFiles"]
    assert failed_root["resume"]["baseline_capture_run_id"] == "53"
    assert failed_root["resume"]["applied_data_run_id"] == "42"
    for result in (held155, failed_root):
        assert "no_takeover_handoff_qualification" not in result["resume"]
    canonical_result = native_authority_dir / "live-data-upstream-result.json"
    with contextlib.redirect_stdout(io.StringIO()) as canonical_output:
        complete_reader.command_validate_all(argparse.Namespace(
            repository=repo, policy_json=json.dumps(held_policy), manifest="", operation="",
            subject_sha=native_source, dispatch_inputs=json.dumps(continuation), runtime_mode="oke",
            successor_run_id="156", result_json=str(canonical_result), baseline_dir="",
            held_history_file=""))
    canonical = json.loads(canonical_result.read_text())
    assert "upstream_bindings_validated=6" in canonical_output.getvalue().splitlines()
    assert set(canonical) == {"failed_deploy_run_id", "held_handoff_run_id"}
    header = next(step["run"] for step in workflow_json[0]["jobs"]["rollout"]["steps"]
                  if step.get("name") == "Validate exact SHA phase and trusted upstream runs")
    start = header.index("result_binding=failed_deploy_run_id")
    output_end = '>> "$GITHUB_OUTPUT"'
    header = header[start:header.index(output_end, start) + len(output_end)]
    output_file = native_authority_dir / "upstream-outputs"
    result = subprocess.run(["bash", "-euc", header], cwd=native_authority_dir,
        env=dict(os.environ, HELD_HANDOFF_RUN_ID="155", RUNNER_TEMP=str(native_authority_dir),
                 GITHUB_OUTPUT=str(output_file)), capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    output_values = dict(line.split("=", 1) for line in output_file.read_text().splitlines())
    assert output_values["baseline_capture_run_id"] == "53"
    assert output_values["applied_data_run_id"] == "42"
    assert "no_takeover_handoff_qualification" not in output_values
    for run, operation in ((155, "oci-live-data-resume-deploy"),
                           (156, "oci-live-data-continue-held-handoff")):
        write(f"{prefix}/actions/runs/{run}/pending_deployments", [])
        write(f"{prefix}/actions/runs/{run}/approvals", [{
            "state": "approved", "comment": f"Copilot CLI exact-run approval: {operation}",
            "user": {"id": 123, "login": "fixture-owner"},
            "environments": [{"id": 456, "name": "oci-migration"}]}])
    caller_original = caller_result.read_bytes()
    caller_result.write_bytes(canonical_result.read_bytes())
    held_caller_env = {
        "SOURCE_SHA": native_source, "GITHUB_RUN_ID": "156",
        "HELD_HANDOFF_RUN_ID": "155", "HELD_HANDOFF_SOURCE_SHA": native_source,
        "DISPATCH_INPUTS": json.dumps(continuation)}
    call_envelope_free(changes=held_caller_env)
    call_envelope_free(False, changes=dict(held_caller_env, DISPATCH_INPUTS=json.dumps(
        dict(continuation, held_handoff_run_id="53"))))
    caller_result.write_bytes(caller_original)
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            complete_reader.validate_expired_handoff_resume(
                repo, "54", expired_source, continuation, "oke", "direct CONTINUE remains forbidden")
        except SystemExit:
            pass
        else:
            raise AssertionError("CONTINUE entered the direct expired-receiver helper")
    held_writer = next(step["run"] for step in workflow_json[0]["jobs"]["rollout"]["steps"]
                       if step.get("name") == "Verify exact failed-deploy resume state")
    held_expressions = dict(expressions, **{
        f"steps.provenance_request.outputs.{key}": output_values[key] for key in (
            "failed_deploy_job_conclusion", "public_validate_job_conclusion",
            "lock_release_step_conclusion", "fence_release_step_conclusion", "rehold_step_conclusion")})
    held_writer = re.sub(r"\$\{\{\s*([^{}]+?)\s*\}\}",
                        lambda match: held_expressions[match.group(1)], held_writer)
    (native_authority_dir / "infra").symlink_to(root / "infra", target_is_directory=True)
    shutil.copytree(holder, native_authority_dir / "artifacts/prerequisite")
    shutil.copytree(before, native_authority_dir / "artifacts/oci-data-baseline-before")
    shutil.copyfile(images, native_authority_dir / "artifacts/oci-live-data-rollout/resume-images.tsv")
    namespace = env(before, "baseline-provenance.env")["namespace"]
    runtime = {"images": {}, "deployments": {}, "pods": {},
        "fence": 'if ($host = "www.betstan.xyz") {\n  return 308 https://betstan.xyz$request_uri;\n}'
                 '\nif ($request_method !~ ^(GET|HEAD|OPTIONS)$) {\n  return 503;\n}',
        "lock": {"kind": "ConfigMap", "apiVersion": "v1",
            "metadata": {"name": "gaming-mongo-migration-lock", "namespace": namespace,
                         "uid": "fixture-expired-lineage", "resourceVersion": "42"},
            "data": {"state": "active", "holder": "live-data-155-1", "source-sha": native_source,
                "operation-id": "live-data-apply-slip-index", "fencing-generation": "12",
                "lease-duration-seconds": "1800", "released-at-epoch": "0",
                "acquired-at-epoch": str(int(output_values["held_handoff_lease_until_epoch"]) - 1800),
                "lease-until-epoch": output_values["held_handoff_lease_until_epoch"]}}}
    desired = {row[0]: int(row[3]) for row in (
        line.split("\t") for line in (before / "deployments.tsv").read_text().splitlines())}
    for row in (line.split("\t") for line in (before / "images.tsv").read_text().splitlines()):
        service = row[0]; replicas = desired[service] if service in {"auth", "client", "telemetry"} else 0
        runtime["images"][service] = row[2]
        runtime["deployments"][service] = {
            "kind": "Deployment", "apiVersion": "apps/v1",
            "metadata": {"name": f"gaming-{service}-depl", "namespace": namespace,
                         "uid": f"fixture-{service}", "generation": 1},
            "spec": {"replicas": replicas, "template": {"spec": {"containers": [{
                "name": f"gaming-{service}", "image": row[2],
                "env": [{"name": "LIVE_KICKOFFS_ENABLED", "value": "false"}]}]}}},
            "status": dict(observedGeneration=1, **{key: replicas for key in (
                "replicas", "updatedReplicas", "readyReplicas", "availableReplicas")})}
        runtime["pods"][service] = {"items": [{
            "metadata": {"name": f"fixture-{service}-{index}", "namespace": namespace,
                "uid": f"fixture-{service}-{index}", "labels": {"app": f"gaming-{service}"}},
            "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}],
                "containerStatuses": [{"name": f"gaming-{service}", "ready": True,
                                      "imageID": f"fixture@{row[4]}"}]}}
            for index in range(replicas)]}
    runtime_file = native_authority_dir / "runtime.json"
    runtime_file.write_text(json.dumps(runtime))
    native_bin = native_authority_dir / "bin"
    native_bin.mkdir()
    kubectl = native_bin / "kubectl"
    kubectl.write_text("#!/usr/bin/env python3\n" + r'''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
state = json.loads(Path(os.environ["HELD_NATIVE_RUNTIME"]).read_text())
if args[:2] == ["rollout", "status"]:
    pass
elif args[:3] == ["exec", "-n", "ingress-nginx"] and args[-3:] == ["sh", "-c", "nginx -T 2>&1"]:
    print(state["fence"])
elif args[:2] == ["get", "configmap"]:
    if args[2] == "ingress-nginx-controller":
        print(state["fence"])
    elif args[2] == "gaming-mongo-migration-lock":
        print(json.dumps(state["lock"]))
    else:
        raise SystemExit("unexpected native fixture ConfigMap")
elif args[:2] == ["get", "deployment"]:
    service = args[2].removeprefix("gaming-").removesuffix("-depl")
    output = args[args.index("-o") + 1]
    print(state["images"][service] if output.startswith("jsonpath=")
          else json.dumps(state["deployments"][service]))
elif args[:2] == ["get", "pods"]:
    if args[args.index("-n") + 1] == "ingress-nginx":
        print(json.dumps({"items": [{"metadata": {"name": "fixture-ingress"},
            "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}}]}))
    else:
        service = args[args.index("-l") + 1].removeprefix("app=gaming-")
        print(json.dumps(state["pods"][service]))
else:
    raise SystemExit("unmodelled or mutating native fixture command")
''')
    kubectl.chmod(0o755)
    native_env = dict(producer_env, SOURCE_SHA=native_source, RUNNER_TEMP=str(native_authority_dir),
        OCI_K8S_NAMESPACE=namespace, PREREQUISITE_RUN_ID="53", RESUME_SOURCE_SHA=expired_source,
        BASELINE_RECOVERY_RUN_ID="0",
        RESUME_MAINTENANCE_MODE=output_values["resume_maintenance_mode"],
        RESOLVED_APPLIED_DATA_RUN_ID=output_values["applied_data_run_id"],
        RESOLVED_APPLIED_SOURCE_SHA=output_values["applied_source_sha"],
        NO_TAKEOVER_HANDOFF_QUALIFICATION=output_values.get("no_takeover_handoff_qualification", "none"),
        BASELINE_CAPTURE_RUN_ID=output_values["baseline_capture_run_id"],
        BASELINE_CAPTURE_SOURCE_SHA=output_values["baseline_capture_source_sha"],
        HELD_HANDOFF_RUN_ID="155", HELD_HANDOFF_SOURCE_SHA=native_source,
        HELD_NATIVE_RUNTIME=str(runtime_file), PATH=str(native_bin) + os.pathsep + os.environ["PATH"])
    snapshot = native_authority_dir / "pre-runtime-lock.json"
    def native_prefix(expected=True, changes=None):
        snapshot.unlink(missing_ok=True)
        native_authority.unlink(missing_ok=True)
        result = subprocess.run(["bash", "-euc", held_writer], cwd=native_authority_dir,
            env=dict(native_env, **(changes or {})), capture_output=True, text=True)
        assert (result.returncode == 0) == expected, result.stderr + result.stdout
        assert native_authority.exists() == expected
    native_prefix()
    assert json.loads(snapshot.read_text()) == runtime["lock"]
    native_prefix(False, {"NO_TAKEOVER_HANDOFF_QUALIFICATION": "expired-own-handoff"})
    native_prefix(False, {"BASELINE_CAPTURE_RUN_ID": "42"})
    runtime["lock"]["data"]["holder"] = "live-data-53-1"
    runtime_file.write_text(json.dumps(runtime))
    native_prefix(False)
    runtime["lock"]["data"]["holder"] = "live-data-155-1"
    runtime_file.write_text(json.dumps(runtime))
    native_prefix()
    print("PASS canonical six-binding JSON -> actual YAML outputs -> held prerequisite verifier -> FULL native prefix, capture53/root42/holder155; ancestral classification, capture and physical-owner substitutions reject")
    complete156 = base / "real-data-156"
    complete156.mkdir()
    (complete156 / "held-handoff-history.json").write_text(json.dumps(held155["heldHistory"]))
    for stage in ("release", "acquire", "verify"):
        for state in ("unconfirmed", "confirmed"):
            complete_reader.record_held_handoff_transfer(
                complete156 / "held-handoff-transfer.json", snapshot,
                "155", native_source, "156", native_source, stage, state)
    complete156 = produce(156, native_source, native_authority)
    complete_package(156, complete156, metadata156)
    assert complete_reader.validate_pre_runtime_resume_chain(repo, "156", "oke") == ("42", root_source)
    captured156 = complete_reader.validate_pre_runtime_resume_chain(repo, "156", "oke", include_capture=True)
    assert captured156["baseline_capture_run_id"] == "53"
    assert captured156["applied_data_run_id"] == "42" and captured156["applied_source_sha"] == root_source
    for key in ("baseline_capture_source_sha", "baseline_capture_deploy_run_id", "baseline_sha256"):
        assert captured156[key] == held155["resume"][key]
    log156 = path(f"{prefix}/actions/runs/156/attempts/1/logs")
    original_log156 = log156.read_bytes()
    for key, bad in (("prerequisite_run_id", "42"), ("resume_source_sha", root_source)):
        native(156, "rollout", dict(continuation, **{key: bad}), cutoff156.replace("+00:00", "Z"))
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                complete_reader.validate_pre_runtime_resume_chain(repo, "156", "oke")
            except SystemExit:
                pass
            else:
                raise AssertionError(f"completed v3 lineage relabelled its capture/controller as the root: {key}")
        log156.write_bytes(original_log156)
    held156 = complete_reader.validate_binding(repo, held_binding, native_source, "156",
        dict(continuation, held_handoff_run_id="156"), "oke")
    assert held156["baselineFiles"] == held155["baselineFiles"]
    assert held156["resume"]["applied_data_run_id"] == "42"
    assert private_authority.call_count >= 3
    deploy_policy = json.loads(subprocess.check_output([
        str(root / "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"),
        "get", "oci-production-deploy",
    ], text=True))
    data_binding = next(item for item in deploy_policy["upstreamRunBindings"] if item["input"] == "data_run_id")
    receiver_request = dict(deployed_inputs, approved_sha=native_source, data_run_id="156",
        **{key: native_request[key] for key in (
            "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
            "disk_checkpoint_run_id", "baseline_recovery_run_id", "baseline_recovery_source_sha")})
    receiver_created = dt.datetime.fromisoformat(metadata156["updated_at"]) + dt.timedelta(seconds=1)
    receiver_started = receiver_created + dt.timedelta(seconds=1)
    receiver = dict(metadata156, id=157, workflow_id=read(
        f"{prefix}/actions/workflows/oci-production-deploy.yml")["id"],
        html_url=f"https://github.com/{repo}/actions/runs/157",
        path=".github/workflows/oci-production-deploy.yml", display_title=f"oci-deploy {native_source}",
        status="waiting", conclusion=None, created_at=receiver_created.isoformat(),
        run_started_at=receiver_created.isoformat(), updated_at=receiver_created.isoformat())
    receiver_job = dict(id=15700, run_id=157, name="deploy", status="in_progress", conclusion=None,
        started_at=receiver_started.isoformat(), steps=[])
    receiver_workflow = dict(read(f"{prefix}/actions/workflows/oci-production-deploy.yml"),
                             path=".github/workflows/oci-production-deploy.yml")
    receiver_inventory = f"{prefix}/actions/workflows/oci-production-deploy.yml/runs?per_page=100"
    inventory = read(receiver_inventory)
    inventory["workflow_runs"].append(receiver); inventory["total_count"] += 1
    write(receiver_inventory, inventory)
    competing_inventory = f"{prefix}/actions/workflows/oci-infrastructure.yml/runs?per_page=100"
    competing_filtered = competing_inventory + "&created=%3C%3D" + cutoff156.replace("+00:00", "Z")
    unchanged_inventories = {endpoint: path(endpoint).read_bytes()
                            for endpoint in (competing_inventory, competing_filtered)}
    competitor = dict(receiver, id=158, path=".github/workflows/oci-infrastructure.yml",
        workflow_id=read(f"{prefix}/actions/workflows/oci-infrastructure.yml")["id"],
        display_title=f"oci-infrastructure finalize oke {native_source}", status="in_progress",
        created_at=(dt.datetime.fromisoformat(cutoff156) - dt.timedelta(seconds=1)).isoformat())
    for boundary in ("materialization", "approval-1", "approval-2", "approval-3", "native-validation"):
        receiver["status"] = "in_progress" if boundary == "native-validation" else "waiting"
        receiver_job.update(status=receiver["status"],
                            started_at=receiver_started.isoformat() if boundary == "native-validation" else None)
        receiver_workflow["state"] = "active" if boundary == "materialization" else "disabled_manually"
        write(f"{prefix}/actions/workflows/oci-production-deploy.yml", receiver_workflow)
        write(receiver_inventory, inventory)
        for suffix in ("", "/attempts/1"):
            write(f"{prefix}/actions/runs/157{suffix}", receiver)
        write(f"{prefix}/actions/runs/157/attempts/1/jobs?per_page=100",
              {"total_count": 1, "jobs": [receiver_job]})
        with patch.object(complete_reader.time, "time",
                          return_value=(receiver_started + dt.timedelta(seconds=1)).timestamp()):
            complete_reader.validate_binding(
                repo, data_binding, native_source, "156", receiver_request, "oke")
            timing = complete_reader.validate_receiver_handoff_timing(
                repo, "156", native_source, boundary, "157")
            assert timing["boundary"] == boundary and timing["generation"] == 14
            for endpoint in unchanged_inventories:
                rows = read(endpoint)
                rows["workflow_runs"].append(competitor); rows["total_count"] += 1
                write(endpoint, rows)
            with contextlib.redirect_stderr(io.StringIO()):
                try:
                    complete_reader.validate_binding(
                        repo, data_binding, native_source, "156", receiver_request, "oke")
                except SystemExit:
                    pass
                else:
                    raise AssertionError(f"{boundary} accepted a competing operation in the held interval")
            for endpoint, raw in unchanged_inventories.items():
                path(endpoint).write_bytes(raw)
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            complete_reader.validate_binding(repo, held_binding, native_source, "156",
                dict(continuation, held_handoff_run_id="156"), "oke")
        except SystemExit:
            pass
        else:
            raise AssertionError("fresh held admission ignored the ordinary receiving deployment")
    inventory["workflow_runs"].append(dict(receiver, id=159, status="completed", conclusion="success",
        created_at=(receiver_created + dt.timedelta(hours=1)).isoformat(),
        updated_at=(receiver_created + dt.timedelta(hours=1, minutes=1)).isoformat()))
    inventory["total_count"] += 1; write(receiver_inventory, inventory)
    assert complete_reader.validate_pre_runtime_resume_chain(repo, "156", "oke") == ("42", root_source)
    print("PASS receiver-present complete-v6 -> v3 ordinary binding and authentic timing at materialization/three approvals/native; competing held-interval operation rejects; later deployments preserve immutable lineage")
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            complete_reader.validate_failed_deploy_jobs(
                repo, "54", "oci-failed-deploy-retained-hold-v1", "unchanged retained profile")
        except SystemExit:
            pass
        else:
            raise AssertionError("expired lock-verification failure was relabelled retained-hold")
    original = log_file.read_bytes()
    log_file.unlink()
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            complete_reader.validate_pre_runtime_resume_chain(repo, "156", "oke")
        except SystemExit:
            pass
        else:
            raise AssertionError("completed current lineage accepted missing expired no-takeover proof")
    log_file.write_bytes(original)
for item in pathlib.Path(fixtures).iterdir():
    if item.is_file() and item not in fixture_snapshot:
        item.unlink()
for item, raw in fixture_snapshot.items():
    item.write_bytes(raw)
print("PASS real complete-v6 native producer -> expired-no-takeover held policy binding -> v3 recursive/current reader preserves capture53/root42 without retained-profile relabelling")

def install_consumer(evidence, baseline, run, source=control_source):
    shutil.rmtree(consumer_dir / "artifacts/data")
    shutil.rmtree(consumer_dir / "artifacts/oci-baseline")
    shutil.copytree(evidence, consumer_dir / "artifacts/data")
    shutil.copytree(baseline, consumer_dir / "artifacts/oci-baseline")
    consumer_env.update(DATA_RUN_ID=str(run), SOURCE_SHA=source)

# Keep the unchanged legacy capture/root equality under the complete native proof.
legacy_data = produce(50, current_source, latest / "resume-authority.env", baseline_sha)
pack(9850, legacy_data)
values = env(deployed, "provenance.txt")
values["data_evidence_sha256"] = hashlib.sha256((legacy_data / "SHA256SUMS").read_bytes()).hexdigest()
write_env(deployed, "provenance.txt", values); pack(9851, deployed)
install_consumer(legacy_data, public / "baseline", 50, current_source)
consume()
print("PASS complete native legacy released-runtime consumer retains capture42/root42 equality")

for mode, failed_run, resumed_run, template_run in (
    ("retained-hold", 57, 58, 626),
    ("released-runtime", 59, 60, 624),
):
    retained = mode == "retained-hold"
    post_request = dict(request, approved_sha=control_source, resume_source_sha=control_source,
        prerequisite_run_id="55", failed_deploy_run_id=str(failed_run),
        confirmation="RESUME APPLIED LIVE DATA EXACT SHA" if retained else
            "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME EXACT SHA")
    failed_metadata = read(f"{prefix}/actions/runs/624")
    failed_metadata.update(id=failed_run, head_sha=control_source,
        display_title=f"oci-deploy {control_source}",
        created_at="2026-01-01T02:00:00Z", updated_at="2026-01-01T02:10:00Z")
    for suffix in ("", "/attempts/1"):
        write(f"{prefix}/actions/runs/{failed_run}{suffix}", failed_metadata)
    jobs = read(f"{prefix}/actions/runs/{template_run}/attempts/1/jobs?per_page=100")
    for index, job in enumerate(jobs["jobs"]):
        job.update(id=failed_run * 100 + index, run_id=failed_run, status="completed")
        for step in job["steps"]:
            if step["name"] == "Verify immutable image and infrastructure provenance":
                step.update(started_at="2026-01-01T02:01:00Z", completed_at="2026-01-01T02:02:00Z")
    write(f"{prefix}/actions/runs/{failed_run}/attempts/1/jobs?per_page=100", jobs)
    native(failed_run, "deploy", dict(deployed_inputs, approved_sha=control_source, data_run_id="55"),
           "2026-01-01T02:01:30Z")
    post_artifacts = [publish(failed_run, 20000 + failed_run,
                             f"oci-production-baseline-{failed_run}-1", before)]
    post = base / f"post-runtime-{failed_run}"
    if retained:
        shutil.copytree(historical / "deployment-recovery", post)
        values = env(post, "deployment-intent.env")
        values.update(source_sha=control_source, deployment_run_id=str(failed_run),
                      data_run_id="55", baseline_capture_run_id="53",
                      baseline_sha256=fresh_sha,
                      data_evidence_sha256=hashlib.sha256((successor / "SHA256SUMS").read_bytes()).hexdigest())
        write_env(post, "deployment-intent.env", values)
        intent_sha = hashlib.sha256((post / "deployment-intent.env").read_bytes()).hexdigest()
        (post / "deployment-intent.sha256").write_text(f"{intent_sha}  deployment-intent.env\n")
        values = env(post, "failure-lineage.env")
        values.update(source_sha=control_source, deployment_run_id=str(failed_run), intent_sha256=intent_sha)
        write_env(post, "failure-lineage.env", values); seal(post)
        name = f"oci-deploy-recovery-authority-{failed_run}-1"
    else:
        shutil.copytree(public / "failed-deployment", post)
        values = env(post, "provenance.txt")
        values.update(source_sha=control_source, deployment_run_id=str(failed_run), data_run_id="55",
                      data_evidence_sha256=hashlib.sha256((successor / "SHA256SUMS").read_bytes()).hexdigest())
        write_env(post, "provenance.txt", values)
        values = env(post, "live-schema.env")
        values.update(source_sha=control_source, data_run_id="55", baseline_sha256=fresh_sha)
        write_env(post, "live-schema.env", values)
        name = f"oci-deploy-provenance-{failed_run}-1"
    post_artifacts.append(publish(failed_run, 30000 + failed_run, name, post))
    write(f"{prefix}/actions/runs/{failed_run}/artifacts?per_page=100",
          {"total_count": len(post_artifacts), "artifacts": post_artifacts})
    selected_binding = (next(item for item in resume_policy["upstreamRunBindings"]
                             if item["input"] == "failed_deploy_run_id") if retained else json.loads(binding))
    post_policy = dict(resume_policy, upstreamRunBindings=[
        selected_binding if item["input"] == "failed_deploy_run_id" else item
        for item in resume_policy["upstreamRunBindings"]])
    post_result = base / f"post-runtime-{resumed_run}-result.json"
    result = subprocess.run([
        validator, "validate-all", "--repository", repo, "--policy-json", json.dumps(post_policy),
        "--subject-sha", control_source,
        "--dispatch-inputs", json.dumps(post_request), "--runtime-mode", "oke",
        "--result-json", str(post_result),
    ], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    post_qualification = json.loads(post_result.read_text())["failed_deploy_run_id"]
    assert post_qualification["resume_maintenance_mode"] == mode
    post_expressions = dict(expressions, **{
        f"steps.provenance_request.outputs.{key}": post_qualification[key] for key in (
            "failed_deploy_job_conclusion", "public_validate_job_conclusion",
            "lock_release_step_conclusion", "fence_release_step_conclusion", "rehold_step_conclusion")})
    body = re.sub(r"\$\{\{\s*([^{}]+?)\s*\}\}",
                  lambda match: post_expressions[match.group(1)], producer_template)
    post_env = dict(producer_env, FAILED_DEPLOY_RUN_ID=str(failed_run), RESUME_MAINTENANCE_MODE=mode)
    result = subprocess.run(["bash", "-euc", body], cwd=producer_dir,
                            env=post_env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    resumed = produce(resumed_run, control_source, authority_file)
    write(f"{prefix}/actions/runs/{resumed_run}/artifacts?per_page=100", {
        "total_count": 1, "artifacts": [publish(resumed_run, 40000 + resumed_run,
                                               f"oci-live-data-rollout-{resumed_run}-1", resumed)]})
    resumed_metadata = read(f"{prefix}/actions/runs/55")
    resumed_metadata.update(id=resumed_run, created_at="2026-01-01T02:20:00Z",
                            updated_at="2026-01-01T02:30:00Z")
    for suffix in ("", "/attempts/1"):
        write(f"{prefix}/actions/runs/{resumed_run}{suffix}", resumed_metadata)
    jobs = read(f"{prefix}/actions/runs/55/attempts/1/jobs?per_page=100")
    job = jobs["jobs"][0]
    job.update(id=resumed_run * 100, run_id=resumed_run, started_at="2026-01-01T02:21:00Z")
    job["steps"][0].update(started_at="2026-01-01T02:22:00Z", completed_at="2026-01-01T02:23:00Z")
    write(f"{prefix}/actions/runs/{resumed_run}/attempts/1/jobs?per_page=100", jobs)
    native(resumed_run, "rollout", post_request, "2026-01-01T02:22:30Z")
    install_consumer(resumed, before, resumed_run)
    consume()
    original = log_file.read_bytes(); log_file.unlink(); consume(False); log_file.write_bytes(original)
    directory = consumer_dir / "artifacts/data"
    saved = {item: item.read_bytes() for item in directory.rglob("*") if item.is_file()}
    values = env(directory, "resume-authority.env"); values["applied_data_run_id"] = "53"
    write_env(directory, "resume-authority.env", values); seal(directory); consume(False)
    for member, raw in saved.items():
        member.write_bytes(raw)
    baseline = consumer_dir / "artifacts/oci-baseline"
    saved.update({baseline / name: (baseline / name).read_bytes()
                  for name in ("baseline-provenance.env", "SHA256SUMS")})
    values = env(baseline, "baseline-provenance.env"); values["baseline_capture_run_id"] = "42"
    write_env(baseline, "baseline-provenance.env", values); substituted_sha = seal(baseline)
    for name in ("provenance.env", "schema.env", "resume-authority.env"):
        values = env(directory, name); values["baseline_sha256"] = substituted_sha
        write_env(directory, name, values)
    seal(directory); consume(False)
    for member, raw in saved.items():
        member.write_bytes(raw)
    consume()
    print(f"PASS real {mode} authority/evidence -> native-enabled deployment preserves capture53/root42 and rejects root/capture substitution or missing frozen proof")
PY
ok "released recovery authenticates distinct retained lineage and rejects substituted root, tuple, outcome, chronology and missing evidence"
SUBJECT_SHA="$saved_subject"
APPLIED_SOURCE_SHA="$saved_applied"
cd "$saved_directory"

ANCESTOR_PROFILE_SHA="bd1008081411d64d96dd0221126090577ea72c6b"
ancestor_profile_run=622
reset_fixtures
write_profile_run "$ancestor_profile_run" oci-production-deploy.yml \
  "oci-deploy $SUBJECT_SHA" 7610 \
  "oci-production-baseline-$ancestor_profile_run-1"
write_profile_artifacts "$ancestor_profile_run" false "$ANCESTOR_PROFILE_SHA"
write_deploy_profile_jobs \
  "$ancestor_profile_run" failure skipped skipped skipped success
if ! run_custom_binding "$retained_binding" "$ancestor_profile_run" \
    "$(profile_dispatch_inputs "$ANCESTOR_PROFILE_SHA")" oke >/dev/null; then
  fail "ancestor resume did not preserve original build/infra lineage: $(cat "$WORK/err.txt")"
fi
ok "ancestor resume keeps current workflow source with original OKE identities"

for substituted_input in build_run_id infrastructure_run_id; do
  ancestor_inputs="$(profile_dispatch_inputs "$ANCESTOR_PROFILE_SHA")"
  ancestor_inputs="$(
    jq -c --arg key "$substituted_input" \
      '.[$key] = "99"' <<<"$ancestor_inputs"
  )"
  if run_custom_binding "$retained_binding" "$ancestor_profile_run" \
      "$ancestor_inputs" oke >/dev/null; then
    fail "ancestor resume accepted a new byte-equivalent $substituted_input"
  fi
  ok "reject substituted OKE ancestor identity $substituted_input"
done

# ------------------ cross-SHA path and candidate image equivalence ------------
CROSS_SOURCE_SHA="bc1008081411d64d96dd0221126090577ea72c6b"
mkdir -p "$WORK/cross-bin"
cat >"$WORK/cross-bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  merge-base)
    [ "${GIT_ANCESTOR_FAIL:-false}" != true ]
    ;;
  diff)
    python3 - "${GIT_DIFF_PATH:-infra/oci/checkpoint.md}" <<'PY'
import sys
sys.stdout.buffer.write(sys.argv[1].encode() + b"\0")
PY
    ;;
  *)
    echo "unexpected git invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod 755 "$WORK/cross-bin/git"

cross_resume_run=623
reset_fixtures
write_profile_run "$cross_resume_run" oci-production-deploy.yml \
  "oci-deploy $CROSS_SOURCE_SHA" 7610 \
  "oci-production-baseline-$cross_resume_run-1" \
  "$CROSS_SOURCE_SHA"
write_profile_artifacts \
  "$cross_resume_run" false "$CROSS_SOURCE_SHA" "$CROSS_SOURCE_SHA"
write_deploy_profile_jobs \
  "$cross_resume_run" failure skipped skipped skipped success
fixture "repos/$REPO/actions/workflows/oci-live-data-rollout.yml" <<'EOF2'
{"id":7633}
EOF2
for endpoint in \
  "repos/$REPO/actions/runs/43" \
  "repos/$REPO/actions/runs/43/attempts/1"; do
  fixture "$endpoint" <<EOF2
{"id":43,"run_attempt":1,"workflow_id":7633,
 "path":".github/workflows/oci-live-data-rollout.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$CROSS_SOURCE_SHA","status":"completed","conclusion":"success",
 "event":"workflow_dispatch",
 "display_title":"oci-live-data apply-slip-index $CROSS_SOURCE_SHA",
 "created_at":"2025-12-31T22:00:00Z","updated_at":"2025-12-31T22:10:00Z"}
EOF2
done
cross_resume_inputs="$(profile_dispatch_inputs "$CROSS_SOURCE_SHA")"
cross_predecessor_binding="$(
  "$POLICY" get oci-live-data-resume-deploy |
    jq -c '
      .upstreamRunBindings[] |
      select(.input == "prerequisite_run_id")
    '
)"
PATH="$WORK/cross-bin:$PATH" \
  run_custom_binding "$cross_predecessor_binding" 43 \
    "$cross_resume_inputs" oke >/dev/null ||
  fail "prior-source prerequisite was not reachable: $(cat "$WORK/err.txt")"
PATH="$WORK/cross-bin:$PATH" \
  run_custom_binding "$canonical_failed_deploy_binding" "$cross_resume_run" \
    "$cross_resume_inputs" oke >/dev/null ||
  fail "prior-source failed deploy was not reachable: $(cat "$WORK/err.txt")"
if GIT_DIFF_PATH=auth/src/index.ts PATH="$WORK/cross-bin:$PATH" \
  run_custom_binding "$canonical_failed_deploy_binding" "$cross_resume_run" \
    "$cross_resume_inputs" oke >/dev/null; then
  fail "application-changing descendant accepted a prior-source failed deploy"
fi
ok "ancestor resume reaches exact prior-source prerequisite and failed runs"

python3 - "$WORK/cross-checkpoint.json" "$WORK/cross-images.tsv" \
  "$CROSS_SOURCE_SHA" <<'PY'
import hashlib
import json
import sys

checkpoint_path, images_path, source_sha = sys.argv[1:]
services = [
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry",
]
repository = "ghcr.io/vasilyevstan/betstan-images"
candidates = []
lines = []
for service in services:
    manifest = "sha256:" + hashlib.sha256((service + "-manifest").encode()).hexdigest()
    platform = "sha256:" + hashlib.sha256((service + "-platform").encode()).hexdigest()
    image_ref = repository + "@" + manifest
    candidates.append({
        "service": service, "imageRef": image_ref,
        "manifestDigest": manifest, "platformDigest": platform,
        "residentImageId": "sha256:" + hashlib.sha256((service + "-cri").encode()).hexdigest(),
        "residentRepoDigest": image_ref,
    })
    lines.append("\t".join((service, repository, image_ref, manifest, platform)))
rollback = []
for service in services:
    manifest = "sha256:" + hashlib.sha256((service + "-rollback").encode()).hexdigest()
    rollback.append({
        "service": service,
        "imageRef": repository + "@" + manifest,
        "residentImageId": "sha256:" + hashlib.sha256((service + "-rollback-cri").encode()).hexdigest(),
        "residentRepoDigest": repository + "@" + manifest,
    })
candidates.sort(key=lambda row: row["service"])
rollback.sort(key=lambda row: row["service"])
value = {
    "schemaVersion": "k3s-release-disk-checkpoint.v1",
    "sourceSha": source_sha, "controlSha": source_sha,
    "infrastructureRunId": "699",
    "ghcrBuildRunId": "701", "producerRunId": "700",
    "producerRunAttempt": "1", "runtimeMode": "k3s",
    "disposition": "READY_NO_RECLAIM",
    "terminalStatus": "RELEASE_ELIGIBLE",
    "thresholdPercent": 70,
    "root": {
        "capacityBytes": 1000, "usedBytes": 700,
    },
    "stableIdentity": {
        "nodeNameSha256": hashlib.sha256(b"node").hexdigest(),
        "rootMountSourceSha256": hashlib.sha256(b"root").hexdigest(),
        "rootFsType": "ext4", "rootMountCapacityBytes": 1000,
        "mongoMountSourceSha256": hashlib.sha256(b"mongo").hexdigest(),
        "mongoFsType": "ext4", "mongoMountCapacityBytes": 2000,
        "mongoSeparateFromRoot": True,
        "k3sVersion": "k3s version v1.34.9+k3s1",
        "containerRuntimeVersion": "containerd://2.1.4-k3s1",
        "k3sActive": True,
    },
    "candidateResidency": candidates,
    "rollbackResidency": rollback,
    "publicStateStatus": "PASS",
    "diagnosisRunId": "700",
    "diagnosisChecksumSha256": hashlib.sha256(b"diagnosis").hexdigest(),
    "reclaimRunId": "0",
    "reclaimChecksumSha256": "none",
    "reclaimCategory": "none",
}
value["contentChecksumSha256"] = hashlib.sha256(
    json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
open(checkpoint_path, "w", encoding="utf-8").write(
    json.dumps(value, sort_keys=True, separators=(",", ":"))
)
open(images_path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY

reset_fixtures
fixture "repos/$REPO/actions/workflows/oci-infrastructure.yml" <<EOF2
{"id":$WORKFLOW_ID}
EOF2
for endpoint in \
  "repos/$REPO/actions/runs/700" \
  "repos/$REPO/actions/runs/700/attempts/1"; do
  fixture "$endpoint" <<EOF2
{"id":700,"run_attempt":1,"workflow_id":$WORKFLOW_ID,
 "path":".github/workflows/oci-infrastructure.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$CROSS_SOURCE_SHA","status":"completed","conclusion":"success",
 "event":"workflow_dispatch",
 "display_title":"oci-infrastructure diagnose-disk k3s $CROSS_SOURCE_SHA",
 "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:01:00Z"}
EOF2
done
fixture "repos/$REPO/actions/runs/700/artifacts?per_page=100" <<EOF2
{"total_count":1,"artifacts":[{
 "name":"oci-release-disk-checkpoint-$CROSS_SOURCE_SHA-700-1",
 "id":9700,"expired":false,"size_in_bytes":8192}]}
EOF2
artifact_zip_fixture 9700 checkpoint.json "$(cat "$WORK/cross-checkpoint.json")"
fixture "repos/$REPO/actions/runs/701/artifacts?per_page=100" <<EOF2
{"total_count":1,"artifacts":[{
 "name":"oci-image-provenance-$CROSS_SOURCE_SHA-701-1",
 "id":9701,"expired":false,"size_in_bytes":8192}]}
EOF2
artifact_zip_fixture 9701 images.tsv "$(cat "$WORK/cross-images.tsv")"
fixture "repos/$REPO/actions/runs/702/artifacts?per_page=100" <<EOF2
{"total_count":1,"artifacts":[{
 "name":"oci-image-provenance-$CROSS_SOURCE_SHA-702-1",
 "id":9702,"expired":false,"size_in_bytes":8192}]}
EOF2
artifact_zip_fixture 9702 images.tsv "$(cat "$WORK/cross-images.tsv")"

cross_inputs="$(
  jq -cn --arg source "$CROSS_SOURCE_SHA" '{
    checkpoint_source_sha:$source,build_run_id:"701",
    infrastructure_run_id:"699"
  }'
)"
if ! GIT_DIFF_PATH=infra/oci/checkpoint.md \
  PATH="$WORK/cross-bin:$WORK/bin:$PATH" \
  "$VALIDATOR" validate --repository "$REPO" --binding "$checkpoint_binding" \
    --subject-sha "$SUBJECT_SHA" --run-id 700 \
    --dispatch-inputs "$cross_inputs" --runtime-mode k3s \
    >"$WORK/cross-result" 2>"$WORK/err.txt"; then
  fail "allowed cross-SHA checkpoint was rejected: $(cat "$WORK/err.txt")"
fi
ok "accept ancestor checkpoint across GitHub, infra, or Markdown-only descendants"

substituted_build_inputs="$(
  jq -cn --arg source "$CROSS_SOURCE_SHA" '{
    checkpoint_source_sha:$source,build_run_id:"702",
    infrastructure_run_id:"699"
  }'
)"
if GIT_DIFF_PATH=infra/oci/checkpoint.md \
  PATH="$WORK/cross-bin:$WORK/bin:$PATH" \
  "$VALIDATOR" validate --repository "$REPO" --binding "$checkpoint_binding" \
    --subject-sha "$SUBJECT_SHA" --run-id 700 \
    --dispatch-inputs "$substituted_build_inputs" --runtime-mode k3s \
    >"$WORK/cross-result" 2>"$WORK/err.txt"; then
  fail "new byte-equivalent k3s build run bypassed original checkpoint identity"
fi
ok "reject new byte-equivalent k3s build run"

python3 - "$WORK/cross-checkpoint.json" <<'PY'
import hashlib
import json
import sys

path = sys.argv[1]
value = json.load(open(path, encoding="utf-8"))
value["infrastructureRunId"] = "700"
value.pop("contentChecksumSha256")
value["contentChecksumSha256"] = hashlib.sha256(
    json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
open(path, "w", encoding="utf-8").write(
    json.dumps(value, sort_keys=True, separators=(",", ":"))
)
PY
artifact_zip_fixture 9700 checkpoint.json "$(cat "$WORK/cross-checkpoint.json")"
cross_inputs="$(
  jq -cn --arg source "$CROSS_SOURCE_SHA" '{
    checkpoint_source_sha:$source,build_run_id:"701",
    infrastructure_run_id:"700"
  }'
)"
for endpoint in \
  "repos/$REPO/actions/runs/700" \
  "repos/$REPO/actions/runs/700/attempts/1"; do
  fixture "$endpoint" <<EOF2
{"id":700,"run_attempt":1,"workflow_id":$WORKFLOW_ID,
 "path":".github/workflows/oci-infrastructure.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$CROSS_SOURCE_SHA","status":"completed","conclusion":"success",
 "event":"workflow_dispatch",
 "display_title":"oci-infrastructure finalize k3s $CROSS_SOURCE_SHA",
 "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:01:00Z"}
EOF2
done
if ! GIT_DIFF_PATH=infra/oci/checkpoint.md \
  PATH="$WORK/cross-bin:$WORK/bin:$PATH" \
  "$VALIDATOR" validate --repository "$REPO" --binding "$checkpoint_binding" \
    --subject-sha "$SUBJECT_SHA" --run-id 700 \
    --dispatch-inputs "$cross_inputs" --runtime-mode k3s \
    >"$WORK/cross-result" 2>"$WORK/err.txt"; then
  fail "valid k3s finalize checkpoint was rejected: $(cat "$WORK/err.txt")"
fi
ok "accept release-eligible k3s finalize checkpoint"

python3 - "$WORK/cross-checkpoint.json" <<'PY'
import hashlib
import json
import sys

path = sys.argv[1]
value = json.load(open(path, encoding="utf-8"))
value["infrastructureRunId"] = "699"
value.pop("contentChecksumSha256")
value["contentChecksumSha256"] = hashlib.sha256(
    json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
open(path, "w", encoding="utf-8").write(
    json.dumps(value, sort_keys=True, separators=(",", ":"))
)
PY
artifact_zip_fixture 9700 checkpoint.json "$(cat "$WORK/cross-checkpoint.json")"
if GIT_DIFF_PATH=infra/oci/checkpoint.md \
  PATH="$WORK/cross-bin:$WORK/bin:$PATH" \
  "$VALIDATOR" validate --repository "$REPO" --binding "$checkpoint_binding" \
    --subject-sha "$SUBJECT_SHA" --run-id 700 \
    --dispatch-inputs "$cross_inputs" --runtime-mode k3s \
    >"$WORK/cross-result" 2>"$WORK/err.txt"; then
  fail "k3s finalize checkpoint accepted a different infrastructure run"
fi
ok "reject k3s finalize checkpoint with mismatched infrastructure lineage"
cross_inputs="$(
  jq -cn --arg source "$CROSS_SOURCE_SHA" '{
    checkpoint_source_sha:$source,build_run_id:"701",
    infrastructure_run_id:"699"
  }'
)"

for endpoint in \
  "repos/$REPO/actions/runs/700" \
  "repos/$REPO/actions/runs/700/attempts/1"; do
  fixture "$endpoint" <<EOF2
{"id":700,"run_attempt":1,"workflow_id":$WORKFLOW_ID,
 "path":".github/workflows/oci-infrastructure.yml",
 "head_repository":{"full_name":"$REPO"},"head_branch":"master",
 "head_sha":"$CROSS_SOURCE_SHA","status":"completed","conclusion":"success",
 "event":"workflow_dispatch",
 "display_title":"oci-infrastructure diagnose-disk k3s $CROSS_SOURCE_SHA",
 "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:01:00Z"}
EOF2
done

if GIT_DIFF_PATH=client/src/App.jsx \
  PATH="$WORK/cross-bin:$WORK/bin:$PATH" \
  "$VALIDATOR" validate --repository "$REPO" --binding "$checkpoint_binding" \
    --subject-sha "$SUBJECT_SHA" --run-id 700 \
    --dispatch-inputs "$cross_inputs" --runtime-mode k3s \
    >"$WORK/cross-result" 2>"$WORK/err.txt"; then
  fail "application-changing checkpoint descendant was accepted"
fi
ok "reject cross-SHA checkpoint after application changes"

if GIT_ANCESTOR_FAIL=true GIT_DIFF_PATH=infra/oci/checkpoint.md \
  PATH="$WORK/cross-bin:$WORK/bin:$PATH" \
  "$VALIDATOR" validate --repository "$REPO" --binding "$checkpoint_binding" \
    --subject-sha "$SUBJECT_SHA" --run-id 700 \
    --dispatch-inputs "$cross_inputs" --runtime-mode k3s \
    >"$WORK/cross-result" 2>"$WORK/err.txt"; then
  fail "non-ancestor checkpoint source was accepted"
fi
ok "reject non-ancestor checkpoint source"

python3 - "$WORK/cross-images.tsv" <<'PY'
from pathlib import Path
import hashlib
import sys

path = Path(sys.argv[1])
lines = path.read_text().splitlines()
fields = lines[0].split("\t")
fields[4] = "sha256:" + hashlib.sha256(b"substituted-platform").hexdigest()
lines[0] = "\t".join(fields)
path.write_text("\n".join(lines) + "\n")
PY
artifact_zip_fixture 9701 images.tsv "$(cat "$WORK/cross-images.tsv")"
if GIT_DIFF_PATH=infra/oci/checkpoint.md \
  PATH="$WORK/cross-bin:$WORK/bin:$PATH" \
  "$VALIDATOR" validate --repository "$REPO" --binding "$checkpoint_binding" \
    --subject-sha "$SUBJECT_SHA" --run-id 700 \
    --dispatch-inputs "$cross_inputs" --runtime-mode k3s \
    >"$WORK/cross-result" 2>"$WORK/err.txt"; then
  fail "cross-SHA candidate image substitution was accepted"
fi
ok "reject cross-SHA candidate image substitution"

printf 'oci_upstream_binding_contract=PASS cases=%d\n' "$passed"
