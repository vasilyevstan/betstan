#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATOR="$ROOT_DIR/infra/azure/agents/consolidate-production-mongo-stan.sh"
LOCK_SCRIPT="$ROOT_DIR/infra/azure/agents/shared-mongo-operation-lock-stan.sh"
ROLLBACK_READINESS="$ROOT_DIR/infra/azure/agents/rollback-readiness-stan.sh"
SIGNATURE_SCRIPT="$ROOT_DIR/infra/azure/agents/mongo-database-signature-stan.js"
MIGRATION_AGENT="$ROOT_DIR/.github/agents/betstan-mongo-migration.agent.md"
MONGO_TEST_IMAGE="${MONGO_TEST_IMAGE:-docker.io/library/mongo@sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3}"
SKIP_DOCKER="${SKIP_DOCKER:-0}"

fail() {
  echo "shared_mongo_consolidation_tests=FAIL reason=$*" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
readiness_dir=""
created_readiness_parent=false
cleanup_tmp() {
  rm -rf -- "$tmp_dir"
  [[ -z "$readiness_dir" ]] || rm -rf -- "$readiness_dir"
  if [[ "$created_readiness_parent" == true ]]; then
    rmdir "$ROOT_DIR/.test-workdirs" 2>/dev/null || true
  fi
}
trap cleanup_tmp EXIT

active_mongo_count="$(
  find "$ROOT_DIR/infra/k8s" -maxdepth 1 -type f -name '*-mongo-depl.yaml' |
    wc -l | tr -d ' '
)"
[[ "$active_mongo_count" == "1" ]] ||
  fail "expected one active Mongo manifest"
[[ -f "$ROOT_DIR/infra/k8s/auth-mongo-depl.yaml" ]] ||
  fail "auth Mongo manifest is missing"
grep -Fq 'name: gaming-shared-mongo-srv' "$ROOT_DIR/infra/k8s/auth-mongo-depl.yaml" ||
  fail "shared Mongo Service is missing"

legacy_mongo_count="$(
  find "$ROOT_DIR/infra/k8s/legacy-mongo" -maxdepth 1 -type f -name '*-mongo-depl.yaml' |
    wc -l | tr -d ' '
)"
[[ "$legacy_mongo_count" == "7" ]] ||
  fail "expected seven rollback-only Mongo manifests"

grep -Fq 'shared-mongo-topology-guard-stan.sh' \
  "$ROOT_DIR/.github/workflows/production-deploy.yml" ||
  fail "production deploy does not enforce the shared topology"
grep -Fq 'shared-mongo-operation-lock-stan.sh acquire' \
  "$ROOT_DIR/.github/workflows/production-deploy.yml" ||
  fail "production deploy does not acquire the database operation lock"
grep -Fq 'shared-mongo-operation-lock-stan.sh release' \
  "$ROOT_DIR/.github/workflows/production-deploy.yml" ||
  fail "production deploy does not release the database operation lock"
grep -Fq '"$lock_script" acquire' "$ROOT_DIR/infra/azure/agents/deploy-stan.sh" ||
  fail "direct deploy does not acquire the database operation lock"
[[ -x "$LOCK_SCRIPT" ]] ||
  fail "shared database operation lock helper is missing"
[[ -f "$MIGRATION_AGENT" ]] ||
  fail "shared database migration agent is missing"
for required_reference in \
  'disable-model-invocation: true' \
  'consolidate-production-mongo-stan.sh' \
  'shared-mongo-operation-lock-stan.sh' \
  'shared-mongo-topology-guard-stan.sh' \
  'rollback-readiness-stan.sh' \
  'READY_FOR_CLEANUP' \
  'MIGRATION_COMPLETE'; do
  grep -Fq "$required_reference" "$MIGRATION_AGENT" ||
    fail "migration agent is missing required reference: $required_reference"
done

retired_paths=(
  "$ROOT_DIR/.github/workflows/deploy-stage-shared-db.yml"
  "$ROOT_DIR/infra/azure/agents/deploy-stage-shared-db-stan.sh"
  "$ROOT_DIR/infra/azure/agents/revert-stage-legacy-mongo-stan.sh"
  "$ROOT_DIR/infra/azure/agents/stage-soak-validation-stan.sh"
  "$ROOT_DIR/infra/k8s-stage/shared-mongo.yaml"
)
for retired_path in "${retired_paths[@]}"; do
  [[ ! -e "$retired_path" ]] ||
    fail "retired shared-Mongo path still exists: $retired_path"
done

expected_mappings=(
  "auth:gaming_auth"
  "bet:gaming_bet"
  "backoffice:gaming_backoffice"
  "event:gaming_event"
  "gamemaster:gaming_gamemaster"
  "moderation:gaming_moderation"
  "resulting:gaming_resulting"
  "slip:gaming_slip"
)

for mapping in "${expected_mappings[@]}"; do
  IFS=':' read -r service database <<<"$mapping"
  expected_uri="mongodb://gaming-shared-mongo-srv:27017/${database}"
  grep -Fq "value: \"$expected_uri\"" "$ROOT_DIR/infra/k8s/${service}-depl.yaml" ||
    fail "active URI mapping is wrong for $service"
done

plan_output="$(bash "$OPERATOR" plan)"
[[ "$(grep -c '^migrate=' <<<"$plan_output")" == "7" ]] ||
  fail "operator plan must migrate seven databases"
[[ "$(grep -c '^retire_statefulset=' <<<"$plan_output")" == "7" ]] ||
  fail "operator plan must retire seven exact database resources"
grep -Fq 'target_statefulset=gaming-auth-mongo-depl' <<<"$plan_output" ||
  fail "operator target changed"
grep -Fq 'database_count=8' <<<"$plan_output" ||
  fail "operator database count changed"
[[ "$(grep -c 'dropDatabase()' "$OPERATOR")" -eq 2 ]] ||
  fail "forward and reverse restores must explicitly drop destination databases"
grep -Fq 'gaming-mongo-migration-lock' "$OPERATOR" ||
  fail "migration operation lock is missing"
[[ "$(grep -c '^    acquire_lock$' "$OPERATOR")" -eq 3 ]] ||
  fail "migrate, cleanup, and rollback must acquire the operation lock"

mkdir -p "$tmp_dir/bin" "$tmp_dir/backups"
chmod 700 "$tmp_dir/backups"
if [[ ! -d "$ROOT_DIR/.test-workdirs" ]]; then
  mkdir "$ROOT_DIR/.test-workdirs"
  created_readiness_parent=true
fi
readiness_dir="$(mktemp -d "$ROOT_DIR/.test-workdirs/mongo-readiness.XXXXXX")"
cat >"$tmp_dir/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"gaming-mongo-topology"* ]]; then
  printf '%s' "${FAKE_TOPOLOGY_STATE:?}"
elif [[ "$*" == *"gaming-mongo-migration-lock"* ]]; then
  printf '%s' "${FAKE_LOCK_STATE:?}"
else
  echo "unexpected kubectl call: $*" >&2
  exit 1
fi
EOF
chmod +x "$tmp_dir/bin/kubectl"
test_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
transition_output="$(
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_TOPOLOGY_STATE="transition|backing-up|test-migration|$test_sha" \
    FAKE_LOCK_STATE="released" \
    TARGET_SHA="$test_sha" \
    MIGRATION_ID="test-migration" \
    MIGRATION_BACKUP_DIR="$tmp_dir/backups" \
    OUTPUT_DIR="$readiness_dir" \
    "$ROLLBACK_READINESS"
)"
grep -Fxq 'rollback_readiness=GO' <<<"$transition_output" &&
  grep -Fxq 'mode=migration-transition' <<<"$transition_output" &&
  grep -Fxq 'phase=backing-up' <<<"$transition_output" ||
  fail "migration-transition rollback readiness was not accepted"
grep -Fq 'rollback_operator=infra/azure/agents/consolidate-production-mongo-stan.sh' \
  <<<"$transition_output" ||
  fail "migration-transition rollback did not select the consolidation operator"
if PATH="$tmp_dir/bin:$PATH" \
  FAKE_TOPOLOGY_STATE="transition|backing-up|test-migration|$test_sha" \
  FAKE_LOCK_STATE="active" \
  TARGET_SHA="$test_sha" \
  MIGRATION_ID="test-migration" \
  MIGRATION_BACKUP_DIR="$tmp_dir/backups" \
  OUTPUT_DIR="$readiness_dir" \
  "$ROLLBACK_READINESS" >/dev/null 2>&1; then
  fail "migration-transition rollback readiness accepted an active operation lock"
fi
if PATH="$tmp_dir/bin:$PATH" \
  FAKE_TOPOLOGY_STATE="transition|validating-applications|test-migration|$test_sha" \
  FAKE_LOCK_STATE="released" \
  TARGET_SHA="$test_sha" \
  MIGRATION_ID="test-migration" \
  MIGRATION_BACKUP_DIR="$tmp_dir/backups" \
  OUTPUT_DIR="$readiness_dir" \
  "$ROLLBACK_READINESS" >/dev/null 2>&1; then
  fail "late migration rollback readiness accepted missing recovery artifacts"
fi

# Exercise the real journal/PV functions and operation case statement. Only
# unrelated database/lock prerequisites are stubbed; kubectl is a complete,
# recording fake, and the clock advances without waiting ten real minutes.
python3 -I - "$OPERATOR" "$tmp_dir" <<'PY'
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

operator, temporary = map(Path, sys.argv[1:])
# Match Linux's physical paths even when the host's temp directory is an alias.
# The synthetic checkout and recovery fixtures must be siblings, not nested.
root = (temporary / "read-contract").resolve()
root.mkdir()
checkout = root / "checkout"
bin_dir = root / "bin"
bin_dir.mkdir()
guard = checkout / "infra/azure/agents/shared-mongo-topology-guard-stan.sh"
guard.parent.mkdir(parents=True)
guard.write_text('#!/usr/bin/env bash\nprintf "topology-guard\\n" >>"$FIXTURE_TRACE"\n')
guard.chmod(0o700)
source = operator.read_text()
prefix, body = source.split('\ncase "$OPERATION" in\n')
mapping_text = source.split("DATABASE_MAPPINGS=(\n", 1)[1].split("\n)", 1)[0]
mappings = [line.strip().strip('"').split("|") for line in mapping_text.splitlines()]
assert len(mappings) == 7 and all(len(row) == 5 for row in mappings)
pvs = {row[4]: f"pv-legacy-{index}" for index, row in enumerate(mappings)}
allowed_deletes = {
    (resource, name)
    for row in mappings
    for resource, name in (("statefulset", row[1][:-2]), ("service", row[3]), ("pvc", row[4]))
}
stubbed_steps = (
    "validate_exact_checkout", "validate_repository_contract",
    "verify_legacy_runtime", "verify_legacy_applications", "verify_queue_drain",
    "scale_applications", "write_backups", "verify_backups", "prepare_target",
    "restore_shared_databases", "set_shared_uris", "verify_shared_database_presence",
    "verify_shared_applications", "apply_legacy_manifests", "verify_shared_uris",
    "reverse_restore_legacy", "set_legacy_uris",
)
stubs = r'''
ROOT_DIR="$FIXTURE_ROOT"
fixture_step() { printf '%s\n' "$*" >>"$FIXTURE_TRACE"; }
acquire_lock() {
  LOCK_HELD=true
  LOCK_TOKEN=fixture
  fixture_step "acquire-lock:$MIGRATION_ID:$APPROVED_SHA"
}
release_lock() {
  fixture_step "release-lock:$MIGRATION_ID:$APPROVED_SHA"
  LOCK_HELD=false
}
sleep() {
  fixture_step "sleep:$1"
  SECONDS=$((SECONDS + FIXTURE_CLOCK_STEP))
}
'''
for name in stubbed_steps:
    stubs += f'{name}() {{ fixture_step {name} "$@"; }}\n'
fixture_operator = root / "operator.sh"
fixture_operator.write_text(
    prefix + stubs + '\nrun_fixture_operation() {\ncase "$OPERATION" in\n' + body
    + '\n}\nSECONDS=0\n'
    + 'if [[ "$FIXTURE_CONDITIONAL" = 1 ]]; then\n'
    + '  if run_fixture_operation; then exit 0; else exit "$?"; fi\n'
    + 'else\n  run_fixture_operation\nfi\n'
)
provider = bin_dir / "kubectl"
provider.write_text("#!" + sys.executable + "\n" + r'''
import json, os, re, signal, subprocess, sys, time
from pathlib import Path
d = Path(os.environ["FIXTURE_CASE"])
f = json.loads((d / "fixture.json").read_text())
args = sys.argv[1:]
def log(value):
    with (d / "calls.jsonl").open("a") as handle:
        handle.write(json.dumps(value) + "\n")
def emit(value, code=0, stderr=False):
    text = value if isinstance(value, str) else json.dumps(value)
    print(text, file=sys.stderr if stderr else sys.stdout)
    raise SystemExit(code)
def namespace():
    return args[args.index("-n") + 1] if "-n" in args else None
if args[:2] == ["apply", "-f"]:
    assert args == ["apply", "-f", "-"]
    journal = json.load(sys.stdin)
    assert journal["metadata"] == {"name": "gaming-mongo-topology", "namespace": f["namespace"]}
    assert journal["data"]["migration-id"] == f["migration_id"]
    assert journal["data"]["source-sha"] == f["sha"]
    log({"command": "journal", **journal["data"]})
    (d / "journal.json").write_text(json.dumps(journal))
    emit("configured")
assert len(args) >= 3, args
command, resource, name = args[:3]
log({"command": command, "resource": resource, "name": name, "args": args})
if command == "delete":
    assert [resource, name] in f["allowed_deletes"], "out-of-map deletion"
    assert namespace() == f["namespace"]
    assert "--ignore-not-found" in args
    emit("deleted")
if command == "create":
    assert resource == "configmap" and name == "gaming-mongo-topology"
    assert namespace() == f["namespace"] and "--dry-run=client" in args
    data = dict(value[len("--from-literal="):].split("=", 1)
                for value in args if value.startswith("--from-literal="))
    emit({"apiVersion": "v1", "kind": "ConfigMap",
          "metadata": {"name": name, "namespace": f["namespace"]}, "data": data})
assert command == "get" and resource in ("configmap", "pv", "pvc"), args
timeouts = [value for value in args if value.startswith("--request-timeout=")]
assert len(timeouts) == 1 and re.fullmatch(r"--request-timeout=[1-9][0-9]*s", timeouts[0])
assert 1 <= int(timeouts[0].split("=")[1][:-1]) <= 15
assert namespace() == (None if resource == "pv" else f["namespace"])
if resource == "pvc":
    assert name in f["pvs"] and args[-1] == "jsonpath={.spec.volumeName}"
    if f.get("capture_error") and name == list(f["pvs"])[2]:
        print(f["pvs"][name])
        emit("context deadline exceeded", 1, True)
    emit(f["pvs"][name])
assert args[-2:] == ["-o", "json"]
if resource == "configmap":
    assert name == "gaming-mongo-topology"
    mode = f["journal_read"]
    present = json.loads((d / "journal.json").read_text())
    plural = "configmaps"
else:
    assert name in f["pvs"].values(), "out-of-map PV read"
    counts_path = d / "counts.json"
    counts = json.loads(counts_path.read_text()) if counts_path.exists() else {}
    count = counts.get(name, 0)
    counts[name] = count + 1
    counts_path.write_text(json.dumps(counts))
    sequence = f["pv_reads"].get(name, ["notfound"])
    mode = sequence[min(count, len(sequence) - 1)]
    present = {"apiVersion": "v1", "kind": "PersistentVolume",
               "metadata": {"name": name}, "spec": {}, "status": {"phase": "Released"}}
    plural = "persistentvolumes"
message = f'{plural} "{name}" not found'
native = f"Error from server (NotFound): {message}"
status = {"apiVersion": "v1", "kind": "Status", "status": "Failure",
          "code": 404, "reason": "NotFound", "message": message,
          "details": {"kind": plural, "name": name}}
if mode in ("hang-client", "hang-credential", "hang-native-notfound",
            "hang-status-notfound", "hang-malformed", "exited-client-open-pipe"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with (d / "lifetimes.jsonl").open("a") as handle:
        handle.write(json.dumps({"role": "client", "pid": os.getpid(),
                                "pgid": os.getpgrp(), "sid": os.getsid(0),
                                "supervisor": os.getppid()}) + "\n")
    if mode == "hang-client":
        while True: time.sleep(60)
    ready = d / f"credential-{os.getpid()}.ready"
    child = subprocess.Popen([sys.executable, "-c", """
import json, os, signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with Path(sys.argv[1]).open("a") as handle:
    handle.write(json.dumps({"role": "credential", "pid": os.getpid(),
                            "pgid": os.getpgrp(), "sid": os.getsid(0)}) + "\\n")
Path(sys.argv[2]).write_text("ready")
while True: time.sleep(60)
""", str(d / "lifetimes.jsonl"), str(ready)], stdin=subprocess.DEVNULL)
    # The credential helper deliberately inherits both output pipes and ignores
    # SIGTERM. HTTP --request-timeout cannot end either blocking client below.
    while not ready.exists(): time.sleep(0.01)
    if mode in ("hang-native-notfound", "exited-client-open-pipe"):
        print(native, file=sys.stderr, flush=True)
    if mode == "hang-status-notfound":
        print(json.dumps(status), flush=True)
    if mode == "hang-malformed":
        sys.stdout.buffer.write(b"\xff")
        sys.stdout.buffer.flush()
    marker = d / f"cancel-ready-{os.getpid()}"
    marker.with_suffix(".partial").write_text(json.dumps({
        "client": os.getpid(), "supervisor": os.getppid(),
    }))
    marker.with_suffix(".partial").replace(marker.with_suffix(".json"))
    if mode == "exited-client-open-pipe":
        raise SystemExit(1)
    child.wait()
    raise SystemExit(1)
if mode == "present": emit(present)
if mode == "notfound": emit(native, 1, True)
if mode == "status-notfound": emit(status, 1)
if mode == "status-notfound-stderr": emit(status, 1, True)
if mode == "forbidden": emit("Error from server (Forbidden): access denied", 1, True)
if mode == "unauthorized": emit("Error from server (Unauthorized): authentication required", 1, True)
if mode == "login-required": emit("error: You must be logged in to the server (Unauthorized)", 1, True)
if mode == "timeout": emit("error: context deadline exceeded", 1, True)
if mode == "transport": emit("Unable to connect to the server: connection refused", 1, True)
if mode == "server":
    emit({"apiVersion": "v1", "kind": "Status", "status": "Failure",
          "code": 503, "reason": "ServiceUnavailable"}, 1, True)
if mode == "empty-error": emit("", 1)
if mode == "empty-success": emit("")
if mode == "malformed-success": emit("{")
if mode == "arbitrary-notfound": emit("local cache entry not found", 1, True)
if mode == "prefixed-notfound": emit("untrusted diagnostic: " + native, 1, True)
if mode == "suffixed-notfound": emit(native + "\nadditional error", 1, True)
if mode == "duplicate-present":
    emit('{"kind":"untrusted",' + json.dumps(present)[1:])
if mode == "duplicate-status":
    emit('{"code":500,' + json.dumps(status)[1:], 1, True)
if mode == "nonfinite-present":
    present["metadata"]["invalid"] = float("nan")
    emit(present)
if mode == "nonfinite-status":
    status["metadata"] = {"invalid": float("nan")}
    emit(status, 1, True)
if mode == "success-with-error":
    print(json.dumps(present))
    emit("Error from server (Forbidden): access denied", 0, True)
if mode == "wrong-resource-native": emit('Error from server (NotFound): namespaces "other" not found', 1, True)
if mode == "wrong-name-native": emit(f'Error from server (NotFound): {plural} "other" not found', 1, True)
if mode == "wrong-reason-native": emit(f"Error from server (Forbidden): {message}", 1, True)
if mode == "wrong-namespace-status": status["details"]["namespace"] = "other"
elif mode == "wrong-resource-status": status["details"]["kind"] = "namespaces"
elif mode == "wrong-name-status": status["details"]["name"] = "other"
elif mode == "wrong-group-status": status["details"]["group"] = "other.example"
elif mode == "wrong-code-status": status["code"] = 403
elif mode == "wrong-message-status": status["message"] = 'namespaces "other" not found'
elif mode == "wrong-kind-status": status["kind"] = "ConfigMap"
elif mode == "success-status": emit(status)
elif mode == "native-success": emit(native, 0, True)
elif mode == "native-stdout": emit(native, 1)
elif mode == "terminated-notfound": emit(native, 124, True)
elif mode == "contradictory-streams":
    print(json.dumps(present))
    emit(native, 1, True)
elif mode == "wrong-present-name":
    present["metadata"]["name"] = "other"
    emit(present)
elif mode == "wrong-present-namespace":
    present["metadata"]["namespace"] = "other"
    emit(present)
elif mode == "missing-identity": emit({"apiVersion": "v1"})
elif mode == "missing-journal-data":
    present["data"] = {}
    emit(present)
else: raise AssertionError(mode)
emit(status, 1, True)
''')
provider.chmod(0o700)
docker = bin_dir / "docker"
docker.write_text('#!/usr/bin/env bash\necho "unexpected Docker operation" >&2\nexit 99\n')
docker.chmod(0o700)
clean_env = {
    key: value for key, value in os.environ.items()
    if not key.startswith(("GIT_", "BASH_FUNC_")) and key not in ("BASH_ENV", "ENV")
}
clean_env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
index = 0

def setup(operation, *, journal_read="present", state=None, pv_reads=None,
          cold_map=False, invalid_map=None, capture_error=False):
    global index
    index += 1
    directory = root / f"case-{index}"
    directory.mkdir(mode=0o700)
    backup = directory / "backups"
    backup.mkdir(mode=0o700)
    assert checkout.resolve() not in backup.resolve().parents, "fixture backup is inside its checkout"
    for name in ("auth-preserved", "backup-preserved"):
        (backup / name).write_bytes(b"unchanged fixture recovery bytes\n")
    data = {
        "mode": "transition", "phase": "awaiting-cleanup" if operation == "cleanup" else "backing-up",
        "migration-id": "read-fixture", "source-sha": "a" * 40, "validated": "false",
    }
    data.update(state or {})
    (directory / "journal.json").write_text(json.dumps({
        "apiVersion": "v1", "kind": "ConfigMap",
        "metadata": {"name": "gaming-mongo-topology", "namespace": "read-fixture-ns"},
        "data": data,
    }))
    (directory / "fixture.json").write_text(json.dumps({
        "namespace": "read-fixture-ns", "migration_id": "read-fixture", "sha": "a" * 40,
        "journal_read": journal_read, "pv_reads": pv_reads or {},
        "pvs": pvs, "allowed_deletes": sorted(allowed_deletes), "capture_error": capture_error,
    }))
    cleanup_map = backup / "read-fixture-cleanup-pvs.tsv"
    if not cold_map:
        rows = list(pvs.items())
        if invalid_map == "extra-auth": rows.append(("gaming-auth-mongo-data-gaming-auth-mongo-depl-0", "pv-auth"))
        if invalid_map == "wrong-pvc": rows[0] = ("gaming-auth-mongo-data-gaming-auth-mongo-depl-0", rows[0][1])
        if invalid_map == "duplicate-pv": rows[1] = (rows[1][0], rows[0][1])
        cleanup_map.write_text("".join(f"{pvc}\t{pv}\n" for pvc, pv in rows))
        cleanup_map.chmod(0o600)
    return directory

def run_interrupted(directory, script, operation, env, interruption):
    scope, signals = interruption
    output_path, error_path = directory / "interrupt.out", directory / "interrupt.err"
    delivered = set()
    with output_path.open("wb") as output, error_path.open("wb") as error:
        worker = subprocess.Popen(
            ["bash", str(script), operation], cwd=root, env=env,
            stdin=subprocess.DEVNULL, stdout=output, stderr=error, start_new_session=True,
        )
        try:
            stop = time.monotonic() + 8
            while worker.poll() is None:
                for marker in directory.glob("cancel-ready-*.json"):
                    ready = json.loads(marker.read_text())
                    if ready["supervisor"] in delivered:
                        continue
                    for signum in signals:
                        try:
                            # Both targets belong to this still-owned worker's
                            # foreground session, never the unrelated sentinel.
                            assert os.getpgid(ready["supervisor"]) == worker.pid
                            assert os.getsid(ready["supervisor"]) == worker.pid
                            if scope == "foreground":
                                os.killpg(worker.pid, signum)
                            else:
                                os.kill(ready["supervisor"], signum)
                            delivered.add(ready["supervisor"])
                        except ProcessLookupError:
                            break
                assert time.monotonic() < stop, "interrupted controller exceeded its bound"
                time.sleep(0.005)
            assert delivered, "cancellation never reached a ready credential operation"
            # Foreground cancellation can exit bash before Python finishes
            # cleanup; observe that exact owned supervisor/child set boundedly.
            records = [json.loads(line) for line in (directory / "lifetimes.jsonl").read_text().splitlines()]
            owned = {item["pid"] for item in records}
            owned.update(item["supervisor"] for item in records if item["role"] == "client")
            stop = time.monotonic() + 2
            while any(alive(pid) for pid in owned) and time.monotonic() < stop:
                time.sleep(0.01)
            assert not any(alive(pid) for pid in owned), "cancellation left an owned process alive"
        finally:
            if worker.poll() is None:
                os.killpg(worker.pid, signal.SIGKILL)
            worker.wait(timeout=2)
    return subprocess.CompletedProcess(
        [str(script), operation], worker.returncode,
        output_path.read_text(errors="replace"), error_path.read_text(errors="replace"),
    )

def run(directory, operation, *, ok=False, conditional=False, clock_step=200,
        script=fixture_operator, interruption=None):
    backup = directory / "backups"
    cleanup_map = backup / "read-fixture-cleanup-pvs.tsv"
    map_before = cleanup_map.read_bytes() if cleanup_map.exists() else None
    journal_before = (directory / "journal.json").read_bytes()
    trace = directory / "trace"
    trace.write_text("")
    (directory / "calls.jsonl").write_text("")
    env = dict(
        clean_env, PATH=str(bin_dir) + os.pathsep + clean_env["PATH"],
        FIXTURE_ROOT=str(checkout), FIXTURE_CASE=str(directory), FIXTURE_TRACE=str(trace),
        FIXTURE_CONDITIONAL=str(int(conditional)), FIXTURE_CLOCK_STEP=str(clock_step),
        NAMESPACE="read-fixture-ns", APPROVED_SHA="a" * 40, MIGRATION_ID="read-fixture",
        BACKUP_DIR=str(backup), TMPDIR=str(directory), SKIP_DOCKER="1",
        CONFIRM_MAINTENANCE="writers-paused",
        CONFIRM_RECOVERY_COPIES="verified-eight-recovery-copies",
        CONFIRM_APPLICATION_VALIDATED="shared-mongo-application-validation-passed",
        CONFIRM_DELETE_LEGACY_MONGO="delete-seven-legacy-mongo-volumes",
        CONFIRM_ROLLBACK="restore-seven-legacy-databases",
    )
    if interruption is None:
        result = subprocess.run(
            ["bash", str(script), operation], cwd=root, env=env,
            capture_output=True, text=True, timeout=20,
        )
    else:
        result = run_interrupted(directory, script, operation, env, interruption)
    steps = trace.read_text().splitlines()
    fixture = json.loads((directory / "fixture.json").read_text())
    context = json.dumps({
        "case": directory.name, "operation": operation, "script": script.name,
        "conditional": conditional, "expected_success": ok, "exit_code": result.returncode,
        "journal_read": fixture["journal_read"], "pv_reads": fixture["pv_reads"],
        "acquire_count": steps.count("acquire-lock:read-fixture:" + "a" * 40),
        "release_count": steps.count("release-lock:read-fixture:" + "a" * 40),
        "trace": steps,
        "stdout_tail": result.stdout[-4096:].replace(str(root), "<fixture>"),
        "stderr_tail": result.stderr[-4096:].replace(str(root), "<fixture>"),
    }, sort_keys=True)
    assert (result.returncode == 0) == ok, context
    calls = [json.loads(line) for line in (directory / "calls.jsonl").read_text().splitlines()]
    assert all((call["resource"], call["name"]) in allowed_deletes
               for call in calls if call["command"] == "delete")
    if not ok:
        if interruption is None or interruption[0] != "foreground":
            assert f"shared_mongo_operation={operation} status=FAIL" in result.stderr
        assert f"shared_mongo_operation={operation} status=PASS" not in result.stdout
        assert (directory / "journal.json").read_bytes() == journal_before
        assert not any(call["command"] in ("journal", "create", "apply") for call in calls)
        if operation != "cleanup":
            assert not any(call["command"] == "delete" for call in calls)
            assert "scale_applications" not in trace.read_text()
            assert "write_backups" not in trace.read_text()
    if map_before is not None:
        assert cleanup_map.read_bytes() == map_before, "partial cleanup changed its map"
    for name in ("auth-preserved", "backup-preserved"):
        assert (backup / name).read_bytes() == b"unchanged fixture recovery bytes\n"
    assert steps.count("acquire-lock:read-fixture:" + "a" * 40) == 1, context
    assert steps.count("release-lock:read-fixture:" + "a" * 40) == 1, context
    assert not list(directory.glob("tmp.*")), "temporary read evidence leaked"
    return calls, steps

# Use the existing internal timeout argument, not a production testing knob.
# Everything else (parser, journal, budget and operation case) is unchanged.
lifetime_operator = root / "lifetime-operator.sh"
lifetime_source = fixture_operator.read_text()
assert lifetime_source.count("read_transition_resource() (") == 1
lifetime_operator.write_text(
    lifetime_source.replace("read_transition_resource() (", "fixture_bounded_read() (", 1)
    .replace("\nrun_fixture_operation() {", """
read_transition_resource() { fixture_bounded_read "$1" "$2" 1; }
run_fixture_operation() {""", 1)
)

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

sentinel = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(120)"],
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    start_new_session=True,
)
lifetime_cases = 0
try:
    for mode in ("hang-client", "hang-credential", "hang-native-notfound",
                 "hang-status-notfound", "hang-malformed", "exited-client-open-pipe"):
        for operation in ("migrate", "cleanup"):
            target = list(pvs.values())[3]
            directory = (
                setup(operation, journal_read=mode) if operation == "migrate"
                else setup(operation, pv_reads={target: [mode]})
            )
            records = []
            try:
                started = time.monotonic()
                calls, _ = run(directory, operation, conditional=True, script=lifetime_operator)
                elapsed = time.monotonic() - started
                assert elapsed < (3 if operation == "migrate" else 6), "client escaped wall-clock deadline"
                records = [json.loads(line) for line in (directory / "lifetimes.jsonl").read_text().splitlines()]
                clients = [item for item in records if item["role"] == "client"]
                credentials = [item for item in records if item["role"] == "credential"]
                expected_reads = 1 if operation == "migrate" else 3
                assert len(clients) == expected_reads, "timeout did not remain an unknown read"
                assert len(credentials) == (0 if mode == "hang-client" else expected_reads)
                groups = {item["pid"] for item in clients}
                assert all(item["pid"] == item["pgid"] == item["sid"] for item in clients)
                assert all(item["pgid"] == item["sid"] and item["pgid"] in groups for item in credentials)
                assert sentinel.pid not in groups and sentinel.poll() is None
                stop = time.monotonic() + 2
                while any(alive(item["pid"]) for item in records) and time.monotonic() < stop:
                    time.sleep(0.02)
                assert not any(alive(item["pid"]) for item in records), "owned client/credential child survived"
                assert not any(call["command"] == "journal" for call in calls)
                if operation == "cleanup":
                    assert sum(call["command"] == "delete" for call in calls) == 12
                lifetime_cases += 1
            finally:
                # Keep a failing regression safe too: signal only the exact
                # fixture PIDs still in their recorded session, never names.
                path = directory / "lifetimes.jsonl"
                if path.exists():
                    records = [json.loads(line) for line in path.read_text().splitlines()]
                for item in records:
                    try:
                        if os.getpgid(item["pid"]) == item["pgid"] and os.getsid(item["pid"]) == item["sid"]:
                            os.kill(item["pid"], signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    # The longer internal read argument makes prompt cancellation observable,
    # rather than letting the ordinary one-second timeout satisfy these tests.
    interrupt_operator = root / "interrupt-operator.sh"
    interrupt_operator.write_text(lifetime_operator.read_text().replace(
        'fixture_bounded_read "$1" "$2" 1', 'fixture_bounded_read "$1" "$2" 5', 1,
    ))
    cancellation_cases = []
    for signum in (signal.SIGINT, signal.SIGTERM):
        for scope in ("supervisor", "foreground"):
            for operation in ("migrate", "cleanup"):
                cancellation_cases.append((operation, interrupt_operator, (scope, (signum,))))
    cancellation_cases.append((
        "cleanup", interrupt_operator,
        ("supervisor", (signal.SIGINT, signal.SIGTERM, signal.SIGINT)),
    ))

    # Signal the supervisor after the real spawn returns but before its caller
    # assigns the PID. A throwing handler here would strand the new session.
    for signum in (signal.SIGINT, signal.SIGTERM):
        spawn_script = root / f"spawn-interrupt-{int(signum)}.sh"
        hook = '''
fixture_spawn = subprocess.Popen
def interrupt_spawn(*args, **kwargs):
    spawned = fixture_spawn(*args, **kwargs)
    marker = Path(os.environ["FIXTURE_CASE"]) / f"cancel-ready-{spawned.pid}.json"
    stop = time.monotonic() + 2
    while not marker.exists() and time.monotonic() < stop:
        time.sleep(0.005)
    if marker.exists():
        (marker.parent / "injection-reached").write_text("spawn")
        os.kill(os.getpid(), FIXTURE_SIGNAL)
    return spawned
subprocess.Popen = interrupt_spawn
'''.replace("FIXTURE_SIGNAL", str(int(signum)))
        spawn_script.write_text(interrupt_operator.read_text().replace(
            "signal.signal(signal.SIGTERM, remember_cancellation)\n",
            "signal.signal(signal.SIGTERM, remember_cancellation)\n" + hook, 1,
        ))
        cancellation_cases.append(("migrate", spawn_script, None))

    cleanup_script = root / "cleanup-interrupt.sh"
    cleanup_script.write_text(lifetime_operator.read_text().replace(
        "                os.killpg(client.pid, signal.SIGKILL)",
        '                Path(os.environ["FIXTURE_CASE"], "injection-reached").write_text("cleanup")\n'
        "                os.kill(os.getpid(), signal.SIGINT)\n"
        "                os.kill(os.getpid(), signal.SIGTERM)\n"
        "                os.killpg(client.pid, signal.SIGKILL)", 1,
    ))
    cancellation_cases.append(("migrate", cleanup_script, None))
    exception_script = root / "lifecycle-exception.sh"
    exception_script.write_text(interrupt_operator.read_text().replace(
        "            output, error = client.communicate(timeout=min(0.1, remaining))",
        '            marker = Path(os.environ["FIXTURE_CASE"]) / f"cancel-ready-{client.pid}.json"\n'
        "            if marker.exists():\n"
        '                (marker.parent / "injection-reached").write_text("exception")\n'
        '                raise RuntimeError("fixture lifecycle exception")\n'
        "            output, error = client.communicate(timeout=min(0.1, remaining))", 1,
    ))
    cancellation_cases.append(("migrate", exception_script, None))

    for operation, script, interruption in cancellation_cases:
        target = list(pvs.values())[3]
        directory = (
            setup(operation, journal_read="hang-native-notfound") if operation == "migrate"
            else setup(operation, pv_reads={target: ["hang-native-notfound"]})
        )
        records = []
        try:
            started = time.monotonic()
            calls, _ = run(directory, operation, conditional=True, script=script, interruption=interruption)
            assert time.monotonic() - started < 4, "cancellation fell back to the normal deadline"
            if interruption is None:
                assert (directory / "injection-reached").exists()
            records = [json.loads(line) for line in (directory / "lifetimes.jsonl").read_text().splitlines()]
            stop = time.monotonic() + 2
            while any(alive(item["pid"]) for item in records) and time.monotonic() < stop:
                time.sleep(0.01)
            assert not any(alive(item["pid"]) for item in records), "cancellation leaked an owned child"
            assert sentinel.poll() is None
            assert not any(call["command"] == "journal" for call in calls)
            if operation == "cleanup":
                assert sum(call["command"] == "delete" for call in calls) == 12
        finally:
            path = directory / "lifetimes.jsonl"
            if path.exists():
                records = [json.loads(line) for line in path.read_text().splitlines()]
            for item in records:
                try:
                    if os.getpgid(item["pid"]) == item["pgid"] and os.getsid(item["pid"]) == item["sid"]:
                        os.kill(item["pid"], signal.SIGKILL)
                except ProcessLookupError:
                    pass
    print(f"issue_85_cancellation_contract=PASS cases={len(cancellation_cases)} no_surviving_children=true", flush=True)
finally:
    if sentinel.poll() is None:
        sentinel.kill()
    sentinel.wait(timeout=2)
print(f"issue_85_client_lifetime_contract=PASS cases={lifetime_cases} no_surviving_children=true", flush=True)

errors = (
    "forbidden", "unauthorized", "login-required", "timeout", "transport", "server",
    "empty-error", "empty-success", "malformed-success", "arbitrary-notfound",
    "prefixed-notfound", "suffixed-notfound", "duplicate-present", "duplicate-status",
    "nonfinite-present", "nonfinite-status", "success-with-error",
    "wrong-resource-native", "wrong-name-native", "wrong-reason-native",
    "wrong-namespace-status", "wrong-resource-status", "wrong-name-status",
    "wrong-group-status", "wrong-code-status", "wrong-message-status", "wrong-kind-status",
    "success-status", "native-success", "native-stdout", "terminated-notfound",
    "contradictory-streams", "wrong-present-name", "wrong-present-namespace", "missing-identity",
)
for conditional in (False, True):
    for mode in (*errors, "missing-journal-data"):
        directory = setup("migrate", journal_read=mode)
        calls, _ = run(directory, "migrate", conditional=conditional)
        assert len(calls) == 1, "journal uncertainty reached subsequent migration work"
    for mode in ("notfound", "status-notfound", "status-notfound-stderr"):
        run(setup("migrate", journal_read=mode), "migrate", ok=True, conditional=conditional)
    for phase in ("backing-up", "preparing-target", "restoring"):
        run(setup("migrate", state={"phase": phase}), "migrate", ok=True, conditional=conditional)
    run(setup("migrate", state={"mode": "legacy", "phase": "rollback-complete",
                               "migration-id": "prior-migration", "source-sha": "b" * 40}),
        "migrate", ok=True, conditional=conditional)
    for state in ({"phase": "switching"}, {"migration-id": "other"}, {"source-sha": "b" * 40},
                  {"mode": "legacy", "phase": "rollback-complete"}):
        run(setup("migrate", state=state), "migrate", conditional=conditional)
    for operation in ("cleanup", "rollback"):
        for mode in ("forbidden", "notfound", "wrong-namespace-status", "empty-success"):
            run(setup(operation, journal_read=mode), operation, conditional=conditional)
print("issue_85_journal_read_contract=PASS", flush=True)

for conditional in (False, True):
    for mode in errors:
        target = list(pvs.values())[3]
        directory = setup("cleanup", pv_reads={target: [mode]})
        calls, _ = run(directory, "cleanup", conditional=conditional)
        assert sum(call["command"] == "delete" for call in calls) == 12
        target_reads = [call for call in calls if call["command"] == "get" and call["name"] == target]
        assert 1 <= len(target_reads) <= 3, "PV error escaped the single bounded budget"
        if mode in ("timeout", "transport", "server", "empty-error"):
            assert len(target_reads) == 3, "transient errors did not consume the existing wait budget"
        if mode in ("forbidden", "unauthorized", "login-required", "empty-success",
                    "malformed-success", "wrong-resource-status", "wrong-name-status",
                    "wrong-namespace-status", "success-with-error"):
            assert len(target_reads) == 1, "permanent authorization/schema errors were retried"
    directory = setup("cleanup", pv_reads={pv: ["present"] for pv in pvs.values()})
    calls, _ = run(directory, "cleanup", conditional=conditional)
    assert sum(call["command"] == "get" and call["resource"] == "pv" for call in calls) == 3
    for mode in ("notfound", "status-notfound", "status-notfound-stderr"):
        directory = setup("cleanup", pv_reads={pv: [mode] for pv in pvs.values()})
        calls, _ = run(directory, "cleanup", ok=True, conditional=conditional)
        assert sum(call["command"] == "delete" for call in calls) == 21
        assert sum(call["command"] == "get" and call["resource"] == "pv" for call in calls) == 7
        assert calls[-1]["command"] == "journal" and calls[-1]["phase"] == "complete"
    sequence = ["present", "timeout", "present", "notfound"]
    directory = setup("cleanup", pv_reads={pv: sequence for pv in pvs.values()})
    calls, _ = run(directory, "cleanup", ok=True, conditional=conditional, clock_step=5)
    assert sum(call["command"] == "get" and call["resource"] == "pv" for call in calls) == 28
    for invalid_map in ("extra-auth", "wrong-pvc", "duplicate-pv"):
        calls, _ = run(setup("cleanup", invalid_map=invalid_map), "cleanup", conditional=conditional)
        assert not any(call["command"] == "delete" for call in calls)
print("issue_85_pv_reclamation_contract=PASS", flush=True)

# A partially deleted topology resumes from exactly the same map, without
# trying to recapture PVC bindings that may no longer exist.
target = list(pvs.values())[3]
directory = setup("cleanup", pv_reads={target: ["transport"]})
run(directory, "cleanup")
fixture = json.loads((directory / "fixture.json").read_text())
fixture["pv_reads"] = {}
(directory / "fixture.json").write_text(json.dumps(fixture))
calls, _ = run(directory, "cleanup", ok=True, conditional=True)
assert not any(call["command"] == "get" and call["resource"] == "pvc" for call in calls)
run(setup("cleanup", cold_map=True), "cleanup", ok=True)
directory = setup("cleanup", cold_map=True, capture_error=True)
calls, _ = run(directory, "cleanup", conditional=True)
assert not any(call["command"] == "delete" for call in calls)
assert not (directory / "backups/read-fixture-cleanup-pvs.tsv").exists()
assert (directory / "backups/read-fixture-cleanup-pvs.tsv.partial").exists()

# Prove the last permitted request is clipped to the remaining time.
first = next(iter(pvs.values()))
calls, _ = run(setup("cleanup", pv_reads={first: ["timeout", "notfound"]}),
              "cleanup", ok=True, clock_step=590)
requests = [call for call in calls if call["command"] == "get" and call["name"] == first]
assert len(requests) == 2
assert int(next(arg for arg in requests[1]["args"] if arg.startswith("--request-timeout=")).split("=")[1][:-1]) <= 10

for state, reverse in (
    ({"mode": "transition", "phase": "restoring"}, False),
    ({"mode": "transition", "phase": "switching"}, False),
    ({"mode": "transition", "phase": "rollback-data-restored"}, False),
    ({"mode": "transition", "phase": "awaiting-cleanup"}, True),
    ({"mode": "shared", "phase": "complete"}, True),
):
    _, steps = run(setup("rollback", state=state), "rollback", ok=True, conditional=True)
    assert ("reverse_restore_legacy" in steps) == reverse
print(f"issue_85_partial_cleanup_and_resume_contract=PASS cases={index}", flush=True)
PY

if [[ "$SKIP_DOCKER" == "1" ]]; then
  echo "shared_mongo_consolidation_tests=PASS docker=skipped"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "docker is required for synthetic migration"

suffix="$$"
source_container="betstan-mongo-source-$suffix"
target_container="betstan-mongo-target-$suffix"

cleanup() {
  docker rm -f "$source_container" "$target_container" >/dev/null 2>&1 || true
  cleanup_tmp
}
trap cleanup EXIT

docker run -d --rm --name "$source_container" "$MONGO_TEST_IMAGE" >/dev/null
docker run -d --rm --name "$target_container" "$MONGO_TEST_IMAGE" >/dev/null

wait_for_mongo() {
  local container="$1"
  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$container" mongosh --quiet \
      --eval 'quit(db.adminCommand({ping:1}).ok === 1 ? 0 : 1)' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Mongo did not become ready: $container"
}

container_signature() {
  local container="$1"
  local database="$2"
  local signature
  signature="$(
    {
      printf 'const DB_NAME = "%s";\n' "$database"
      cat "$SIGNATURE_SCRIPT"
    } | docker exec -i "$container" mongosh --quiet --file /dev/stdin
  )"
  jq -e --arg database "$database" '
    .database == $database and
    (.collections | type) == "array" and
    (.dataHash | type) == "string" and
    (.collectionHashes | type) == "object"
  ' <<<"$signature" >/dev/null ||
    fail "canonical signature is not valid JSON for $database"
  printf '%s\n' "$signature"
}

wait_for_mongo "$source_container"
wait_for_mongo "$target_container"

docker exec "$target_container" mongosh --quiet --eval '
  const d = db.getSiblingDB("gaming_auth");
  d.users.insertOne({_id: 1, identifierNormalized: "user@example.test"});
  d.users.createIndex(
    {identifierNormalized: 1},
    {unique: true, partialFilterExpression: {identifierNormalized: {$type: "string"}}}
  );
' >/dev/null

auth_before="$tmp_dir/gaming_auth.before.json"
auth_after="$tmp_dir/gaming_auth.after.json"
container_signature "$target_container" gaming_auth >"$auth_before"

databases=(
  gaming_bet
  gaming_backoffice
  gaming_event
  gaming_gamemaster
  gaming_moderation
  gaming_resulting
  gaming_slip
)

for database in "${databases[@]}"; do
  docker exec "$source_container" mongosh --quiet --eval "
    const d = db.getSiblingDB(\"$database\");
    d.createCollection(\"records\", {
      validator: {value: {\$type: \"string\"}},
      validationLevel: \"strict\"
    });
    d.records.insertMany([
      {_id: 1, value: \"$database-a\", enabled: true},
      {_id: 2, value: \"$database-b\", enabled: false}
    ]);
    d.records.createIndex({value: 1}, {name: \"value_unique\", unique: true});
    d.createView(\"enabled_records\", \"records\", [{\$match: {enabled: true}}]);
  " >/dev/null

  source_signature="$tmp_dir/$database.source.json"
  target_signature="$tmp_dir/$database.target.json"
  archive="$tmp_dir/$database.archive.gz"

  container_signature "$source_container" "$database" >"$source_signature"
  docker exec "$source_container" mongodump --quiet --archive --gzip --db "$database" >"$archive"
  [[ -s "$archive" ]] || fail "synthetic archive is empty for $database"
  docker exec "$target_container" mongosh --quiet --eval "
    db.getSiblingDB(\"$database\").stale_records.insertOne({_id: \"stale\"});
    db.getSiblingDB(\"$database\").dropDatabase();
  " >/dev/null
  docker exec -i "$target_container" mongorestore --quiet --archive --gzip \
    --drop --nsInclude="${database}.*" <"$archive"
  container_signature "$target_container" "$database" >"$target_signature"
  cmp -s "$source_signature" "$target_signature" ||
    fail "synthetic parity mismatch for $database"
done

container_signature "$target_container" gaming_auth >"$auth_after"
cmp -s "$auth_before" "$auth_after" ||
  fail "gaming_auth changed while restoring non-auth databases"

docker exec "$target_container" mongosh --quiet --eval '
  const d = db.getSiblingDB("gaming_auth");
  try {
    d.users.insertOne({_id: 2, identifierNormalized: "user@example.test"});
    quit(1);
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
  }
' >/dev/null

echo "shared_mongo_consolidation_tests=PASS docker=executed databases=8"
