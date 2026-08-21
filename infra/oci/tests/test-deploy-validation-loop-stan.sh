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

echo 'oci_deploy_validation_loop_tests=PASS scenarios=2'
