#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/agents/deploy-validation-loop-stan.sh"
SAFE_PARENT="${BETSTAN_TEST_TMPDIR:-$ROOT_DIR/.test-workdirs}"
mkdir -p "$SAFE_PARENT"
WORK_DIR="$(mktemp -d "$SAFE_PARENT/oci-deploy-validation-loop-XXXXXX")"
ORIGINAL_PATH="$PATH"

mkdir -p "$WORK_DIR"
trap '[[ "${KEEP_TEST_WORKDIR:-0}" == "1" ]] || rm -rf "$WORK_DIR"' EXIT

fail() {
  echo "oci_deploy_validation_loop_tests=FAIL reason=$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  grep -Fq "$pattern" "$file" || fail "missing '$pattern' in $file"
}

create_image_provenance() {
  local file="$1"
  : >"$file"
  for service in auth bet backoffice client event gamemaster moderation resulting slip; do
    printf '%s\tfixture.invalid/%s\tfixture.invalid/%s@sha256:%064d\tsha256:%064d\tsha256:%064d\n' \
      "$service" "$service" "$service" 1 1 1 >>"$file"
  done
}

cat >"$WORK_DIR/validation.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'validation\n' >>"${CALL_LOG:?}"
if [[ "${STUB_VALIDATION_FAIL:-0}" == "1" ]]; then
  exit 1
fi
EOF
chmod +x "$WORK_DIR/validation.sh"

cat >"$WORK_DIR/readiness.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'readiness\n' >>"${CALL_LOG:?}"
{
  printf 'MODE=%s\n' "${MODE:-}"
  printf 'BASE_URL=%s\n' "${BASE_URL:-}"
  printf 'SECONDARY_PUBLIC_URL=%s\n' "${SECONDARY_PUBLIC_URL:-}"
  printf 'DIAGNOSTIC_URL=%s\n' "${DIAGNOSTIC_URL:-}"
  printf 'IMAGE_PROVENANCE_FILE=%s\n' "${IMAGE_PROVENANCE_FILE:-}"
  printf 'REQUEST_TIMEOUT=%s\n' "${REQUEST_TIMEOUT:-}"
  printf 'SSE_TIMEOUT=%s\n' "${SSE_TIMEOUT:-}"
  printf 'OUTPUT_DIR=%s\n' "${OUTPUT_DIR:-}"
} >"${READINESS_ENV_FILE:?}"
mkdir -p "${OUTPUT_DIR:?}"
printf 'live_betting_readiness=%s\n' "${STUB_READINESS_RESULT:-GO}" >"${OUTPUT_DIR}/summary.env"
if [[ "${STUB_READINESS_FAIL:-0}" == "1" ]]; then
  exit 1
fi
EOF
chmod +x "$WORK_DIR/readiness.sh"

cat >"$WORK_DIR/service-ops.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo 'fixture-oci-service-ops'
EOF
chmod +x "$WORK_DIR/service-ops.sh"

cat >"$WORK_DIR/node-logs.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo 'fixture-oci-node-logs'
EOF
chmod +x "$WORK_DIR/node-logs.sh"

run_scenario() {
  local scenario="$1"
  shift
  local output_dir="$WORK_DIR/$scenario"
  local stdout_file="$WORK_DIR/${scenario}.stdout"
  local stderr_file="$WORK_DIR/${scenario}.stderr"
  local image_file="$WORK_DIR/${scenario}.images.tsv"
  create_image_provenance "$image_file"
  : >"$WORK_DIR/${scenario}.calls"
  if (
    export PATH="$ORIGINAL_PATH"
    export CALL_LOG="$WORK_DIR/${scenario}.calls"
    export READINESS_ENV_FILE="$WORK_DIR/${scenario}.readiness.env"
    export IMAGE_PROVENANCE_FILE="$image_file"
    export VALIDATION_SCRIPT="$WORK_DIR/validation.sh"
    export LIVE_BETTING_READINESS_SCRIPT="$WORK_DIR/readiness.sh"
    export SERVICE_OPS_SCRIPT="$WORK_DIR/service-ops.sh"
    export NODE_LOGS_SCRIPT="$WORK_DIR/node-logs.sh"
    export MAX_ATTEMPTS=1
    export VALIDATION_MAX_LOOPS=1
    export SLEEP_SECONDS=1
    export VALIDATION_SLEEP_SECONDS=1
    export OCI_PUBLIC_URL='https://betstan.xyz'
    export OCI_REDIRECT_URL='https://www.betstan.xyz'
    export OCI_DIAGNOSTIC_URL='https://203.0.113.10.nip.io'
    export LIVE_READINESS_REQUEST_TIMEOUT=9
    export LIVE_READINESS_SSE_TIMEOUT=13
    export OUTPUT_DIR="$output_dir"
    "$@"
  ) >"$stdout_file" 2>"$stderr_file"; then
    RUN_RC=0
  else
    RUN_RC=$?
  fi
  RUN_STDOUT="$stdout_file"
  RUN_STDERR="$stderr_file"
  RUN_OUTPUT_DIR="$output_dir"
  RUN_IMAGE_FILE="$image_file"
}

run_scenario success "$SCRIPT"
[[ "$RUN_RC" == "0" ]] || fail "success scenario exited with $RUN_RC"
assert_contains "$RUN_STDOUT" 'DEPLOYED_HEALTHY'
assert_contains "$WORK_DIR/success.calls" 'validation'
assert_contains "$WORK_DIR/success.calls" 'readiness'
assert_contains "$WORK_DIR/success.readiness.env" 'MODE=dark'
assert_contains "$WORK_DIR/success.readiness.env" 'BASE_URL=https://betstan.xyz'
assert_contains "$WORK_DIR/success.readiness.env" 'SECONDARY_PUBLIC_URL=https://www.betstan.xyz'
assert_contains "$WORK_DIR/success.readiness.env" 'DIAGNOSTIC_URL=https://203.0.113.10.nip.io'
assert_contains "$WORK_DIR/success.readiness.env" "IMAGE_PROVENANCE_FILE=$RUN_IMAGE_FILE"
assert_contains "$WORK_DIR/success.readiness.env" 'REQUEST_TIMEOUT=9'
assert_contains "$WORK_DIR/success.readiness.env" 'SSE_TIMEOUT=13'
assert_contains "$RUN_OUTPUT_DIR/live-readiness/attempt-1/summary.env" 'live_betting_readiness=GO'

run_scenario readiness-failure env STUB_READINESS_FAIL=1 STUB_READINESS_RESULT=NO_GO "$SCRIPT"
[[ "$RUN_RC" == "1" ]] || fail "readiness failure scenario exited with $RUN_RC"
assert_contains "$RUN_STDERR" 'NO_GO deploy_validation_reason=all bounded attempts failed'
[[ -f "$RUN_OUTPUT_DIR/attempt-1/context.txt" ]] ||
  fail "readiness failure did not capture diagnostics context"
assert_contains "$RUN_OUTPUT_DIR/attempt-1/service-ops.txt" 'fixture-oci-service-ops'
assert_contains "$RUN_OUTPUT_DIR/attempt-1/node-logs.txt" 'fixture-oci-node-logs'

ruby -ryaml -rjson - "$ROOT_DIR/.github/workflows/oci-production-deploy.yml" \
  >"$WORK_DIR/health-step.json" <<'RUBY'
workflow = YAML.load_file(ARGV.fetch(0))
job = workflow.fetch("jobs").fetch("deploy")
steps = job.fetch("steps").select { |step| step["name"] == "Run protected OCI cluster validation loop" }
abort("expected exactly one protected health step") unless steps.length == 1
step = steps.fetch(0)
abort("protected health entrypoint changed") unless step.fetch("run") == "./infra/oci/agents/deploy-validation-loop-stan.sh"
puts JSON.generate((workflow["env"] || {}).merge(job.fetch("env")).merge(step.fetch("env")))
RUBY

python3 - "$ROOT_DIR" "$WORK_DIR" "$ORIGINAL_PATH" <<'PY'
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

root, work = map(Path, sys.argv[1:3])
mapping = json.loads((work / "health-step.json").read_text())
control, checkpoint = "c" * 40, "a" * 40
bin_dir = work / "health-bin"
bin_dir.mkdir()
# Stop at the first provider read AFTER the real health provenance checks.
# This is not healthy-cluster evidence and never uses OCI_HEALTH_FIXTURE_FILE.
stubs = {
    "oci": '''#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--version" ]]; then
  printf '%s\\n' "$OCI_CLI_VERSION"
  exit 0
fi
[[ "$*" == "compute instance get --instance-id fixture-instance" ]] || exit 74
printf '%s\\n' "$OCI_EXPECTED_SOURCE_SHA" "$EXPECTED_OPERATION_LOCK_SOURCE_SHA" "$SOURCE_SHA" >"$PREFLIGHT_CALL_LOG"
exit 73
''',
    "kubectl": "#!/usr/bin/env bash\nexit 74\n",
}
for name, contents in stubs.items():
    path = bin_dir / name
    path.write_text(contents)
    path.chmod(0o700)
infra = work / "health-infrastructure.env"
infra.write_text(
    f"source_sha={checkpoint}\nruntime_mode=k3s\n"
    "compartment_ocid=fixture-compartment\nnamespace=betstan-oci\n"
    "ingress_ipv4=203.0.113.10\npublic_host=betstan.xyz\ncanonical_host=betstan.xyz\n"
    "redirect_host=www.betstan.xyz\ndiagnostic_host=203.0.113.10.nip.io\nlb_ocid=fixture-lb\n"
    "node_shape=VM.Standard.A1.Flex\nnode_ocpus=2\nnode_memory_gb=12\nmongo_volume_gb=50\n"
    "lb_min_mbps=10\nlb_max_mbps=10\nexpected_monthly_cost=0\n"
    "instance_ocid=fixture-instance\nk3s_node_name=fixture-node\n"
    f"instance_fingerprint={hashlib.sha256(b'fixture-instance').hexdigest()}\n"
)

for scenario in ("checkpoint", "old-mapping", "missing", "substituted", "malformed", "equal-source"):
    actual = dict(mapping)
    approved = checkpoint if scenario == "equal-source" else control
    if scenario == "old-mapping":
        actual["OCI_EXPECTED_SOURCE_SHA"] = "${{ env.SOURCE_SHA }}"
    elif scenario == "missing":
        actual.pop("OCI_EXPECTED_SOURCE_SHA", None)
    elif scenario == "substituted":
        actual["OCI_EXPECTED_SOURCE_SHA"] = "b" * 40
    elif scenario == "malformed":
        actual["OCI_EXPECTED_SOURCE_SHA"] = "not-a-sha"
    inputs = {"approved_sha": approved, "checkpoint_source_sha": checkpoint}

    def resolve(value):
        def expression(match):
            context, name = match.group(1).split(".", 1)
            return inputs[name] if context == "inputs" else resolve(actual[name])
        return re.sub(r"\$\{\{\s*((?:inputs|env)\.[A-Za-z_]+)\s*\}\}", expression, value)

    log = work / f"health-{scenario}.calls"
    env = {
        "PATH": str(bin_dir) + ":" + sys.argv[3], "HOME": str(work),
        "TMPDIR": str(work), "OCI_CLI_VERSION": mapping["OCI_CLI_VERSION"], "OCI_RUNTIME_MODE": "k3s",
        "OCI_MEMORY_MAX_PERCENT": "70", "OCI_DISK_MAX_PERCENT": "70",
        "OCI_PUBLIC_URL": "https://betstan.xyz", "OCI_REDIRECT_URL": "https://www.betstan.xyz",
        "OCI_DIAGNOSTIC_URL": "https://203.0.113.10.nip.io",
        "INFRA_PROVENANCE_FILE": str(infra),
        "IMAGE_PROVENANCE_FILE": str(work / "success.images.tsv"),
        "OUTPUT_DIR": str(work / f"health-{scenario}"), "PREFLIGHT_CALL_LOG": str(log),
    }
    for key in ("SOURCE_SHA", "CHECKPOINT_SOURCE_SHA", "OCI_EXPECTED_SOURCE_SHA",
                "EXPECTED_OPERATION_LOCK_SOURCE_SHA", "OCI_PUBLIC_CHECKS_ALREADY_PASSED",
                "OCI_E2E_ALREADY_PASSED", "OCI_EXPECT_HTTP_MUTATION_FENCE"):
        if key in actual:
            env[key] = resolve(actual[key])
    assert env["SOURCE_SHA"] == env["EXPECTED_OPERATION_LOCK_SOURCE_SHA"] == approved
    assert env["CHECKPOINT_SOURCE_SHA"] == checkpoint
    assert "OCI_HEALTH_FIXTURE_FILE" not in env
    result = subprocess.run(
        [str(root / "infra/oci/agents/health-check-stan.sh")],
        env=env, capture_output=True, text=True, timeout=15,
    )
    if scenario in {"checkpoint", "equal-source"}:
        assert result.returncode == 73, (scenario, result.returncode, result.stderr)
        assert log.read_text().splitlines() == [checkpoint, approved, approved]
    else:
        message = {
            "missing": "required environment variable is missing: OCI_EXPECTED_SOURCE_SHA",
            "malformed": "OCI_EXPECTED_SOURCE_SHA must be a full lowercase commit SHA",
        }.get(scenario, "health source SHA differs from infrastructure provenance")
        assert result.returncode == 1 and message in result.stderr, (scenario, result.stderr)
        assert not log.exists(), f"{scenario} reached provider access before source admission"
    print(f"health_source_preflight=PASS scenario={scenario}")
PY

echo 'oci_deploy_validation_loop_tests=PASS scenarios=2'
