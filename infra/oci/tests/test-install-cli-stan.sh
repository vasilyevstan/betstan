#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/scripts/install-cli.sh"
SAFE_PARENT="${BETSTAN_TEST_TMPDIR:-$ROOT_DIR/.test-workdirs}"
mkdir -p "$SAFE_PARENT"
WORK_DIR="$(mktemp -d "$SAFE_PARENT/oci-install-cli-XXXXXX")"
ORIGINAL_PATH="$PATH"

trap '[[ "${KEEP_TEST_WORKDIR:-0}" == "1" ]] || rm -rf "$WORK_DIR"' EXIT

fail() {
  echo "oci_install_cli_tests=FAIL reason=$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  grep -Fq -- "$pattern" "$file" || fail "missing '$pattern' in $file"
}

mkdir -p "$WORK_DIR/bin" "$WORK_DIR/python/pip"

cat >"$WORK_DIR/python/pip/__init__.py" <<'PY'
PY
cat >"$WORK_DIR/python/pip/__main__.py" <<'PY'
import os
import sys
import time
from pathlib import Path

counter_path = Path(os.environ["FAKE_PIP_COUNTER"])
count = int(counter_path.read_text(encoding="utf-8") or "0") + 1 \
    if counter_path.exists() else 1
counter_path.write_text(f"{count}\n", encoding="utf-8")
with Path(os.environ["FAKE_PIP_LOG"]).open("a", encoding="utf-8") as log:
    log.write("\t".join(sys.argv[1:]) + "\n")
time.sleep(float(os.environ.get("FAKE_PIP_SLEEP_SECONDS", "0")))
if count <= int(os.environ.get("FAKE_PIP_FAILURES", "0")):
    raise SystemExit(2)
PY

cat >"$WORK_DIR/bin/oci" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${FAKE_OCI_VERSION:-3.90.0}"
SH
chmod +x "$WORK_DIR/bin/oci"

run_installer() {
  local scenario="$1"
  local failures="$2"
  local sleep_seconds="$3"
  local oci_version="$4"
  local attempts="$5"
  local install_timeout="$6"
  local counter="$WORK_DIR/${scenario}.counter"
  local pip_log="$WORK_DIR/${scenario}.pip.log"
  local stdout_file="$WORK_DIR/${scenario}.stdout"
  local stderr_file="$WORK_DIR/${scenario}.stderr"

  rm -f "$counter" "$pip_log"
  if PATH="$WORK_DIR/bin:$ORIGINAL_PATH" \
    PYTHONPATH="$WORK_DIR/python" \
    FAKE_PIP_COUNTER="$counter" \
    FAKE_PIP_LOG="$pip_log" \
    FAKE_PIP_FAILURES="$failures" \
    FAKE_PIP_SLEEP_SECONDS="$sleep_seconds" \
    FAKE_OCI_VERSION="$oci_version" \
    OCI_CLI_VERSION=3.90.0 \
    OCI_CLI_INSTALL_ATTEMPTS="$attempts" \
    OCI_CLI_INSTALL_TIMEOUT_SECONDS="$install_timeout" \
    OCI_CLI_PIP_TIMEOUT_SECONDS=7 \
    OCI_CLI_PIP_RETRIES=1 \
      "$SCRIPT" >"$stdout_file" 2>"$stderr_file"; then
    RUN_RC=0
  else
    RUN_RC=$?
  fi
  RUN_COUNTER="$counter"
  RUN_PIP_LOG="$pip_log"
  RUN_STDERR="$stderr_file"
}

run_installer transient-success 2 0 3.90.0 3 10
[[ "$RUN_RC" == "0" ]] || fail "transient success exited with $RUN_RC"
[[ "$(tr -d '\n' <"$RUN_COUNTER")" == "3" ]] ||
  fail "transient failure did not retry the complete install three times"
[[ "$(wc -l <"$RUN_PIP_LOG" | tr -d ' ')" == "3" ]] ||
  fail "transient failure produced the wrong pip invocation count"
assert_contains "$RUN_PIP_LOG" $'--timeout\t7'
assert_contains "$RUN_PIP_LOG" $'--retries\t1'
assert_contains "$RUN_PIP_LOG" 'oci-cli==3.90.0'
assert_contains "$RUN_STDERR" \
  'bounded_command=RETRY classification=oci-cli-install attempt=1/3 status=2'

run_installer permanent-failure 99 0 3.90.0 2 10
[[ "$RUN_RC" == "2" ]] || fail "permanent failure exited with $RUN_RC"
[[ "$(tr -d '\n' <"$RUN_COUNTER")" == "2" ]] ||
  fail "permanent failure did not stop at the configured attempt bound"
assert_contains "$RUN_STDERR" \
  'bounded_command=FAIL classification=oci-cli-install attempt=2/2 status=2'

run_installer timeout 0 3 3.90.0 1 1
[[ "$RUN_RC" == "124" ]] || fail "timeout exited with $RUN_RC"
assert_contains "$RUN_STDERR" \
  'bounded_command=FAIL classification=oci-cli-install attempt=1/1 status=124'

run_installer version-mismatch 0 0 3.89.0 1 10
[[ "$RUN_RC" == "1" ]] || fail "version mismatch exited with $RUN_RC"
assert_contains "$RUN_STDERR" \
  'OCI CLI version mismatch: expected 3.90.0, got 3.89.0'

if PATH="$WORK_DIR/bin:$ORIGINAL_PATH" \
  PYTHONPATH="$WORK_DIR/python" \
  OCI_CLI_VERSION=3.90.0 \
  OCI_CLI_INSTALL_ATTEMPTS=0 \
    "$SCRIPT" >"$WORK_DIR/invalid.stdout" 2>"$WORK_DIR/invalid.stderr"; then
  fail "invalid retry bound unexpectedly passed"
fi
assert_contains "$WORK_DIR/invalid.stderr" \
  'OCI_CLI_INSTALL_ATTEMPTS must be between 1 and 5'

if PATH="$WORK_DIR/bin:$ORIGINAL_PATH" \
  PYTHONPATH="$WORK_DIR/python" \
  OCI_CLI_VERSION=3.90.0 \
  OCI_CLI_INSTALL_ATTEMPTS=18446744073709551617 \
    "$SCRIPT" >"$WORK_DIR/overflow.stdout" 2>"$WORK_DIR/overflow.stderr"; then
  fail "overflowing retry bound unexpectedly passed"
fi
assert_contains "$WORK_DIR/overflow.stderr" \
  'OCI_CLI_INSTALL_ATTEMPTS must be between 1 and 5'

if PATH="$WORK_DIR/bin:$ORIGINAL_PATH" \
  PYTHONPATH="$WORK_DIR/python" \
  OCI_CLI_VERSION=3.90.0 \
  OCI_CLI_INSTALL_ATTEMPTS=5 \
  OCI_CLI_INSTALL_TIMEOUT_SECONDS=180 \
    "$SCRIPT" >"$WORK_DIR/budget.stdout" 2>"$WORK_DIR/budget.stderr"; then
  fail "aggregate retry budget unexpectedly passed"
fi
assert_contains "$WORK_DIR/budget.stderr" \
  'OCI CLI install retry budget must not exceed 900 seconds'

echo 'oci_install_cli_tests=PASS scenarios=7'
