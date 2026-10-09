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

PYTHONDONTWRITEBYTECODE=1 python3 -I - "$VALIDATOR" "$ROOT_DIR" <<'PY'
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
    def read_native():
        return m.failed_deploy_native_inputs(
            "example/repo", "77", source, "fixture", resume_dispatch=resume_dispatch)
    with patch.object(m, "zip_files", return_value={f"0_{job_name}.txt": raw}):
        direct = read_native()
    assert direct == values
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
git init --quiet --initial-branch=upstream-fixture "$WORK/repository"
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
