#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
AZURE_WORKFLOW="$ROOT_DIR/.github/workflows/production-deploy.yml"
OCI_WORKFLOW="$ROOT_DIR/.github/workflows/oci-production-deploy.yml"
BUILD_WORKFLOW="$ROOT_DIR/.github/workflows/production-build.yml"
OCI_DEPLOY_SCRIPT="$ROOT_DIR/infra/oci/scripts/deploy.sh"
PRE_COMMIT_CHECK="$ROOT_DIR/infra/azure/agents/pre-commit-infra-check-stan.sh"
PR_MERGE_SAFETY_TEST="$ROOT_DIR/infra/azure/agents/test-pr-merge-safety-stan.sh"
PROTECTED_OPERATION_POLICY_TEST="$ROOT_DIR/infra/azure/agents/test-copilot-cli-protected-operation-policy-stan.sh"
CLI_DISPATCH_TEST="$ROOT_DIR/infra/azure/agents/test-copilot-cli-dispatch-stan.sh"
RUN_APPROVAL_TEST="$ROOT_DIR/infra/azure/agents/test-copilot-cli-run-approval-stan.sh"
RUN_EXCLUSIVITY_TEST="$ROOT_DIR/infra/azure/agents/test-production-run-exclusivity-stan.sh"
WORKFLOW_TRIGGER_GUARD="$ROOT_DIR/infra/azure/agents/workflow-trigger-guard-stan.sh"
COVERAGE_ENGINE_REVIEW="$ROOT_DIR/infra/azure/agents/coverage-engine-review-stan.sh"
LIVE_DATA_ROLLOUT_TEST="$ROOT_DIR/infra/oci/tests/test-live-betting-data-rollout-stan.sh"
GHCR_CONTRACT_TEST="$ROOT_DIR/infra/oci/tests/test-ghcr-contract.sh"

test_output="$(mktemp)"
secret_fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-secret-scan.XXXXXX")"
permission_fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-status-writers.XXXXXX")"
secret_guard="$secret_fixture_dir/ingress-guard"
node_runtime_fixture_dir="$permission_fixture_dir/node-runtime"
node_poison_dir="$node_runtime_fixture_dir/poison"
node_invocation_sentinel="$node_runtime_fixture_dir/node-invoked"
coverage_tooling_fixture_root="$permission_fixture_dir/coverage-tooling"
coverage_guard_fixture="$permission_fixture_dir/workflow-trigger-guard-stan.sh"
inventory_source_fixture="$permission_fixture_dir/production-workflow-inventory-stan.rb"
inventory_test_source_fixture="$permission_fixture_dir/test-production-workflow-inventory-stan.sh"
deployment_safety_source_fixture="$permission_fixture_dir/test-deployment-safety-ci-stan.sh"
cleanup() {
  rm -f "$test_output"
  rm -f "$secret_fixture_dir/safe.yml" "$secret_fixture_dir/unsafe.yml" "$secret_guard"
  rmdir "$secret_fixture_dir" 2>/dev/null || true
  rm -rf "$permission_fixture_dir"
}
trap cleanup EXIT

write_node_poison_shim() {
  mkdir -p "$node_poison_dir"
  cat >"$node_poison_dir/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
: >"${BETSTAN_NODE_INVOCATION_SENTINEL:?}"
exit 97
SH
  chmod +x "$node_poison_dir/node"
}

run_workflow_trigger_guard_without_node() {
  local guard="${1:-$WORKFLOW_TRIGGER_GUARD}"
  PATH="$node_poison_dir:$PATH" \
    BETSTAN_NODE_INVOCATION_SENTINEL="$node_invocation_sentinel" \
    "$guard"
}

assert_node_not_invoked() {
  if [[ -e "$node_invocation_sentinel" ]]; then
    echo "ERROR: inert coverage guard invoked Node before activation" >&2
    exit 1
  fi
}

write_coverage_review_tap() {
  local destination="$1"
  local count="$2"
  local index=1
  {
    echo "TAP version 13"
    while [[ "$index" -le "$count" ]]; do
      echo "# Subtest: fixture case $index"
      echo "ok $index - fixture case $index"
      echo "  ---"
      echo "  duration_ms: 0.1"
      echo "  ..."
      index=$((index + 1))
    done
    echo "1..$count"
    echo "# tests $count"
    echo "# suites 0"
    echo "# pass $count"
    echo "# fail 0"
    echo "# cancelled 0"
    echo "# skipped 0"
    echo "# todo 0"
    echo "# duration_ms 1"
  } >"$destination"
}

initialize_coverage_review_fixture() {
  local mode="$1"
  coverage_review_fixture_root="$permission_fixture_dir/coverage-review-fixture"
  coverage_review_repo="$coverage_review_fixture_root/repository"
  coverage_review_bin="$coverage_review_fixture_root/bin"
  coverage_review_event="$coverage_review_fixture_root/event.json"
  coverage_review_docker_args="$coverage_review_fixture_root/docker.args"
  coverage_review_docker_stdout="$coverage_review_fixture_root/docker.stdout"
  coverage_review_docker_stderr="$coverage_review_fixture_root/docker.stderr"
  coverage_review_docker_exit="$coverage_review_fixture_root/docker.exit"
  coverage_review_node_sentinel="$coverage_review_fixture_root/node-invoked"
  rm -rf "$coverage_review_fixture_root"
  mkdir -p \
    "$coverage_review_repo/.github/scripts" \
    "$coverage_review_repo/infra/azure/agents" \
    "$coverage_review_repo/docs/wiki" \
    "$coverage_review_bin"
  cp \
    "$ROOT_DIR/.github/scripts/test-coverage-matrix.js" \
    "$ROOT_DIR/.github/scripts/test-test-coverage-matrix.js" \
    "$ROOT_DIR/.github/scripts/publish-pr-policy.js" \
    "$coverage_review_repo/.github/scripts/"
  cp \
    "$COVERAGE_ENGINE_REVIEW" \
    "$ROOT_DIR/infra/azure/agents/test-deployment-safety-ci-stan.sh" \
    "$coverage_review_repo/infra/azure/agents/"
  printf 'private fixture learning\n' >"$coverage_review_repo/LEARNINGS.md"
  printf 'public fixture learning\n' \
    >"$coverage_review_repo/docs/wiki/Engineering-Learnings.md"
  chmod +x \
    "$coverage_review_repo/infra/azure/agents/coverage-engine-review-stan.sh"

  git -C "$coverage_review_repo" init --quiet
  git -C "$coverage_review_repo" config user.name "Coverage Review Fixture"
  git -C "$coverage_review_repo" config user.email \
    "coverage-review@example.invalid"
  git -C "$coverage_review_repo" checkout --quiet -b fixture-root
  git -C "$coverage_review_repo" add -A
  git -C "$coverage_review_repo" commit --quiet -m "fixture root"
  coverage_review_root_sha="$(git -C "$coverage_review_repo" rev-parse HEAD)"
  coverage_review_unrelated_sha="$(
    printf 'fixture unrelated\n' |
      git -C "$coverage_review_repo" commit-tree \
        "${coverage_review_root_sha}^{tree}"
  )"
  coverage_review_trusted_engine_blob="$(
    git -C "$coverage_review_repo" \
      rev-parse "$coverage_review_root_sha:.github/scripts/test-coverage-matrix.js"
  )"
  coverage_review_trusted_harness_blob="$(
    git -C "$coverage_review_repo" \
      rev-parse "$coverage_review_root_sha:.github/scripts/test-test-coverage-matrix.js"
  )"

  git -C "$coverage_review_repo" checkout --quiet -b candidate
  if [[ "$mode" != "default-equal" ]]; then
    printf '\n// authorized candidate engine\n' \
      >>"$coverage_review_repo/.github/scripts/test-coverage-matrix.js"
    if [[ "$mode" != "engine-only" ]]; then
      printf '\n// authorized candidate harness\n' \
        >>"$coverage_review_repo/.github/scripts/test-test-coverage-matrix.js"
      printf 'candidate private documentation\n' \
        >>"$coverage_review_repo/LEARNINGS.md"
      printf 'candidate public documentation\n' \
        >>"$coverage_review_repo/docs/wiki/Engineering-Learnings.md"
    fi
    git -C "$coverage_review_repo" add -A
    git -C "$coverage_review_repo" commit --quiet -m "fixture candidate"
  fi
  coverage_review_head_sha="$(git -C "$coverage_review_repo" rev-parse HEAD)"
  coverage_review_engine_blob="$(
    git -C "$coverage_review_repo" \
      rev-parse "$coverage_review_head_sha:.github/scripts/test-coverage-matrix.js"
  )"
  coverage_review_harness_blob="$(
    git -C "$coverage_review_repo" \
      rev-parse "$coverage_review_head_sha:.github/scripts/test-test-coverage-matrix.js"
  )"
  coverage_review_changed_count="$(
    git -C "$coverage_review_repo" \
      diff --name-only "$coverage_review_root_sha" "$coverage_review_head_sha" |
      wc -l |
      tr -d ' '
  )"

  git -C "$coverage_review_repo" checkout --quiet \
    -b trusted-base "$coverage_review_root_sha"
  case "$mode" in
    authorized | base-only-authorization | wrong-base-lineage | \
      wrong-adoption-lineage | wrong-receipt-lineage | \
      invalid-tests-1 | invalid-tests-101 | invalid-tests-103 | \
      invalid-tests-10000)
    python3 - \
      "$coverage_review_repo/.github/scripts/publish-pr-policy.js" \
      "$mode" \
      "$coverage_review_root_sha" \
      "$coverage_review_unrelated_sha" \
      "$coverage_review_head_sha" \
      "$coverage_review_trusted_engine_blob" \
      "$coverage_review_engine_blob" \
      "$coverage_review_trusted_harness_blob" \
      "$coverage_review_harness_blob" <<'PY'
import datetime
import json
import pathlib
import sys

(
    publisher_path,
    mode,
    root_sha,
    unrelated_sha,
    head_sha,
    trusted_engine_blob,
    engine_blob,
    trusted_harness_blob,
    harness_blob,
) = sys.argv[1:]
now = datetime.datetime.now(datetime.timezone.utc)
issued = (now - datetime.timedelta(minutes=1)).isoformat(
    timespec="milliseconds"
).replace("+00:00", "Z")
expires = (now + datetime.timedelta(hours=1)).isoformat(
    timespec="milliseconds"
).replace("+00:00", "Z")
expected_tests = {
    "invalid-tests-1": 1,
    "invalid-tests-101": 101,
    "invalid-tests-103": 103,
    "invalid-tests-10000": 10000,
}.get(mode, 102)
authorization = {
    "id": "coverage-engine-review-fixture",
    "repository": "vasilyevstan/betstan",
    "headRepository": "vasilyevstan/betstan",
    "pullNumber": 518,
    "headRef": "feature/coverage-engine",
    "headSha": head_sha,
    "baseRef": "dev",
    "baseSha": (
        unrelated_sha if mode == "wrong-base-lineage" else root_sha
    ),
    "enginePath": ".github/scripts/test-coverage-matrix.js",
    "trustedEngineBlob": trusted_engine_blob,
    "authorizedEngineBlob": engine_blob,
    "harnessPath": ".github/scripts/test-test-coverage-matrix.js",
    "trustedHarnessBlob": trusted_harness_blob,
    "authorizedHarnessBlob": harness_blob,
    "allowedPaths": [
        ".github/scripts/test-coverage-matrix.js",
        ".github/scripts/test-test-coverage-matrix.js",
        "LEARNINGS.md",
        "docs/wiki/Engineering-Learnings.md",
    ],
    "expectedTests": expected_tests,
    "issuedAt": issued,
    "expiresAt": expires,
    "receiptSha": (
        unrelated_sha if mode == "wrong-receipt-lineage" else root_sha
    ),
    "adoptionSha": (
        unrelated_sha if mode == "wrong-adoption-lineage" else root_sha
    ),
}
path = pathlib.Path(publisher_path)
content = path.read_text(encoding="utf-8")
needle = "const TRUSTED_COVERAGE_ASSET_AUTHORIZATIONS_JSON = String.raw`[]`;"
replacement = (
    "const TRUSTED_COVERAGE_ASSET_AUTHORIZATIONS_JSON = String.raw`"
    + json.dumps([authorization], separators=(",", ":"))
    + "`;"
)
if content.count(needle) != 1:
    raise SystemExit("coverage authorization inventory marker changed")
path.write_text(content.replace(needle, replacement), encoding="utf-8")
PY
    git -C "$coverage_review_repo" add \
      .github/scripts/publish-pr-policy.js
    git -C "$coverage_review_repo" commit --quiet -m "fixture authorization"
    ;;
  esac
  coverage_review_base_sha="$(git -C "$coverage_review_repo" rev-parse HEAD)"
  coverage_review_default_sha="$coverage_review_base_sha"
  if [[ "$mode" == "base-only-authorization" ]]; then
    coverage_review_default_sha="$coverage_review_root_sha"
  fi
  git -C "$coverage_review_repo" merge --quiet --no-ff \
    -m "fixture merge" candidate
  coverage_review_merge_sha="$(git -C "$coverage_review_repo" rev-parse HEAD)"

  python3 - \
    "$coverage_review_event" \
    "$coverage_review_head_sha" \
    "$coverage_review_base_sha" \
    "$coverage_review_merge_sha" \
    "$coverage_review_changed_count" <<'PY'
import json
import pathlib
import sys

event_path, head_sha, base_sha, merge_sha, changed_count = sys.argv[1:]
payload = {
    "repository": {
        "full_name": "vasilyevstan/betstan",
        "default_branch": "master",
    },
    "pull_request": {
        "number": 518,
        "head": {
            "ref": "feature/coverage-engine",
            "sha": head_sha,
            "repo": {"full_name": "vasilyevstan/betstan"},
        },
        "base": {"ref": "dev", "sha": base_sha},
        "merge_commit_sha": merge_sha,
        "changed_files": int(changed_count),
    },
}
pathlib.Path(event_path).write_text(
    json.dumps(payload, separators=(",", ":")),
    encoding="utf-8",
)
PY

  cat >"$coverage_review_bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
fixture_root="$(cd "$(dirname "$0")/.." && pwd)"
: >"$fixture_root/node-invoked"
exit 97
SH
  cat >"$coverage_review_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
fixture_root="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\0' "$@" >"$fixture_root/docker.args"
if [[ "${1:-}" == "rm" ]]; then
  exit 0
fi
quiet=false
for argument in "$@"; do
  if [[ "$argument" == "--quiet" ]]; then
    quiet=true
  fi
done
if [[ "$quiet" != "true" ]]; then
  echo "Pulling from library/node" >&2
fi
[[ -f "$fixture_root/docker.stdout" ]] &&
  cat "$fixture_root/docker.stdout"
[[ -f "$fixture_root/docker.stderr" ]] &&
  cat "$fixture_root/docker.stderr" >&2
exit "$(cat "$fixture_root/docker.exit")"
SH
  cat >"$coverage_review_bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
url=""
for argument in "$@"; do
  case "$argument" in
    https://*)
      url="$argument"
      ;;
  esac
done
case "$url" in
  https://api.github.com/repos/vasilyevstan/betstan/commits/master)
    printf '{"sha":"%s"}\n' \
      "${BETSTAN_COVERAGE_REVIEW_DEFAULT_SHA:?}"
    ;;
  *)
    echo "unexpected fixture curl request" >&2
    exit 22
    ;;
esac
SH
  chmod +x \
    "$coverage_review_bin/node" \
    "$coverage_review_bin/docker" \
    "$coverage_review_bin/curl"
  : >"$coverage_review_docker_stdout"
  : >"$coverage_review_docker_stderr"
  printf '0\n' >"$coverage_review_docker_exit"
}

run_coverage_review_fixture() {
  (
    cd "$coverage_review_repo"
    PATH="$coverage_review_bin:$PATH" \
      GITHUB_ACTIONS=true \
      GITHUB_REPOSITORY=vasilyevstan/betstan \
      GITHUB_EVENT_NAME=pull_request \
      GITHUB_EVENT_PATH="$coverage_review_event" \
      GITHUB_SHA="$coverage_review_merge_sha" \
      GITHUB_REF=refs/pull/518/merge \
      GITHUB_HEAD_REF=feature/coverage-engine \
      GITHUB_BASE_REF=dev \
      BETSTAN_COVERAGE_REVIEW_DEFAULT_SHA="$coverage_review_default_sha" \
      ./infra/azure/agents/coverage-engine-review-stan.sh
  )
}

prepare_coverage_guard_fixture() {
  local inventory_source="${1:-$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.rb}"
  local deployment_safety_source="${2:-$ROOT_DIR/infra/azure/agents/test-deployment-safety-ci-stan.sh}"
  local inventory_test_source="${3:-$ROOT_DIR/infra/azure/agents/test-production-workflow-inventory-stan.sh}"
  rm -rf "$coverage_tooling_fixture_root"
  mkdir -p \
    "$coverage_tooling_fixture_root/.github/coverage" \
    "$coverage_tooling_fixture_root/.github/scripts"
  cp \
    "$ROOT_DIR/.github/coverage/test-coverage-matrix.json" \
    "$ROOT_DIR/.github/coverage/package.json" \
    "$ROOT_DIR/.github/coverage/package-lock.json" \
    "$coverage_tooling_fixture_root/.github/coverage/"
  cp \
    "$ROOT_DIR/.github/scripts/test-coverage-matrix.js" \
    "$ROOT_DIR/.github/scripts/test-test-coverage-matrix.js" \
    "$coverage_tooling_fixture_root/.github/scripts/"
  cp "$WORKFLOW_TRIGGER_GUARD" "$coverage_guard_fixture"
  python3 - \
    "$coverage_guard_fixture" \
    "$coverage_tooling_fixture_root" \
    "$inventory_source" \
    "$deployment_safety_source" \
    "$inventory_test_source" <<'PY'
import pathlib
import shlex
import sys

guard_path = pathlib.Path(sys.argv[1])
tooling_root = pathlib.Path(sys.argv[2])
inventory_source = pathlib.Path(sys.argv[3])
deployment_safety_source = pathlib.Path(sys.argv[4])
inventory_test_source = pathlib.Path(sys.argv[5])
content = guard_path.read_text(encoding="utf-8")
replacements = {
    'coverage_descriptor=".github/coverage/test-coverage-matrix.json"':
        f"coverage_descriptor={shlex.quote(str(tooling_root / '.github/coverage/test-coverage-matrix.json'))}",
    'coverage_package=".github/coverage/package.json"':
        f"coverage_package={shlex.quote(str(tooling_root / '.github/coverage/package.json'))}",
    'coverage_lock=".github/coverage/package-lock.json"':
        f"coverage_lock={shlex.quote(str(tooling_root / '.github/coverage/package-lock.json'))}",
    'coverage_engine=".github/scripts/test-coverage-matrix.js"':
        f"coverage_engine={shlex.quote(str(tooling_root / '.github/scripts/test-coverage-matrix.js'))}",
    'coverage_engine_tests=".github/scripts/test-test-coverage-matrix.js"':
        f"coverage_engine_tests={shlex.quote(str(tooling_root / '.github/scripts/test-test-coverage-matrix.js'))}",
    'production_workflow_inventory_source="infra/azure/agents/production-workflow-inventory-stan.rb"':
        f"production_workflow_inventory_source={shlex.quote(str(inventory_source))}",
    'deployment_safety_test_source="infra/azure/agents/test-deployment-safety-ci-stan.sh"':
        f"deployment_safety_test_source={shlex.quote(str(deployment_safety_source))}",
    'production_workflow_inventory_test_source="infra/azure/agents/test-production-workflow-inventory-stan.sh"':
        f"production_workflow_inventory_test_source={shlex.quote(str(inventory_test_source))}",
}
for old, new in replacements.items():
    if content.count(old) != 1:
        raise SystemExit(f"guard fixture assignment count changed: {old}")
    content = content.replace(old, new)
guard_path.write_text(content, encoding="utf-8")
PY
  chmod +x "$coverage_guard_fixture"
}

assert_coverage_guard_rejected() {
  local label="$1"
  local expected="$2"
  rm -f "$node_invocation_sentinel"
  if run_workflow_trigger_guard_without_node \
      "$coverage_guard_fixture" >"$test_output" 2>&1; then
    echo "ERROR: $label unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "$expected" "$test_output"
  assert_node_not_invoked
}

write_node_poison_shim
masked_node_guard="$node_runtime_fixture_dir/masked-node-guard"
cat >"$masked_node_guard" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
node --version >/dev/null 2>&1 || true
echo "expected negative guard failure" >&2
exit 1
SH
chmod +x "$masked_node_guard"
if (
  rm -f "$node_invocation_sentinel"
  if run_workflow_trigger_guard_without_node "$masked_node_guard"; then
    exit 1
  fi
  assert_node_not_invoked
) >"$test_output" 2>&1; then
  echo "ERROR: Node poison harness accepted a masked Node invocation" >&2
  exit 1
fi
grep -qF "expected negative guard failure" "$test_output"
test -e "$node_invocation_sentinel"
rm -f "$node_invocation_sentinel"

prepare_coverage_guard_fixture
rm -f "$coverage_tooling_fixture_root/.github/coverage/test-coverage-matrix.json"
assert_coverage_guard_rejected \
  "coverage guard with a missing descriptor" \
  "required inert coverage tooling file missing or symlinked"

prepare_coverage_guard_fixture
rm -f "$coverage_tooling_fixture_root/.github/scripts/test-coverage-matrix.js"
ln -s \
  "$ROOT_DIR/.github/scripts/test-coverage-matrix.js" \
  "$coverage_tooling_fixture_root/.github/scripts/test-coverage-matrix.js"
assert_coverage_guard_rejected \
  "coverage guard with a symlinked engine" \
  "required inert coverage tooling file missing or symlinked"

cp "$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.rb" \
  "$inventory_source_fixture"
python3 - "$inventory_source_fixture" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
content = path.read_text(encoding="utf-8")
needle = "%w[tests-telemetry.yml tests-telemetry.yaml]"
if content.count(needle) != 1:
    raise SystemExit("inventory fixture rule count changed")
path.write_text(content.replace(needle, "%w[unreserved.yml]"), encoding="utf-8")
PY
prepare_coverage_guard_fixture "$inventory_source_fixture"
assert_coverage_guard_rejected \
  "coverage guard with a removed inventory filename rule" \
  "reserved Telemetry workflow filename rule"

cp "$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.rb" \
  "$inventory_source_fixture"
python3 - "$inventory_source_fixture" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
content = path.read_text(encoding="utf-8")
needle = 'name.unicode_normalize(:nfc).downcase == "tests-telemetry"'
if content.count(needle) != 1:
    raise SystemExit("inventory fixture name-rule count changed")
path.write_text(content.replace(needle, "false"), encoding="utf-8")
PY
prepare_coverage_guard_fixture "$inventory_source_fixture"
assert_coverage_guard_rejected \
  "coverage guard with a removed inventory name rule" \
  "reserved Telemetry workflow name rule"

cp "$ROOT_DIR/infra/azure/agents/test-production-workflow-inventory-stan.sh" \
  "$inventory_test_source_fixture"
python3 - "$inventory_test_source_fixture" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
content = path.read_text(encoding="utf-8")
needle = "telemetry_workflow_reservation_tests=PASS"
if content.count(needle) != 1:
    raise SystemExit("inventory-test fixture sentinel count changed")
path.write_text(content.replace(needle, "telemetry_workflow_reservation_tests=REMOVED"), encoding="utf-8")
PY
prepare_coverage_guard_fixture \
  "$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.rb" \
  "$ROOT_DIR/infra/azure/agents/test-deployment-safety-ci-stan.sh" \
  "$inventory_test_source_fixture"
assert_coverage_guard_rejected \
  "coverage guard with a removed inventory test sentinel" \
  "reserved Telemetry workflow inventory test sentinel"

cp "$ROOT_DIR/infra/azure/agents/test-deployment-safety-ci-stan.sh" \
  "$deployment_safety_source_fixture"
python3 - "$deployment_safety_source_fixture" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
content = path.read_text(encoding="utf-8")
needle = "coverage_node_non_invocation=PASS"
if content.count(needle) != 2:
    raise SystemExit("deployment-safety fixture sentinel count changed")
path.write_text(content.replace(needle, "coverage_node_non_invocation=REMOVED"), encoding="utf-8")
PY
prepare_coverage_guard_fixture \
  "$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.rb" \
  "$deployment_safety_source_fixture"
assert_coverage_guard_rejected \
  "coverage guard with a removed Node non-invocation sentinel" \
  "coverage guard Node non-invocation harness"

assert_secret_fixture_rejected() {
  local label="$1"
  if BRANCH_NAME=feature/test \
      INFRA_DIRS="$secret_fixture_dir" \
      INGRESS_GUARD="$secret_guard" \
      "$PRE_COMMIT_CHECK" >"$test_output" 2>&1; then
    echo "ERROR: $label unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "possible hard-coded secret value" "$test_output"
}

if BRANCH_NAME=master GITHUB_ACTIONS=false "$PRE_COMMIT_CHECK" >"$test_output" 2>&1; then
  echo "ERROR: local master pre-commit check unexpectedly passed" >&2
  exit 1
fi
grep -qF "direct work on master is forbidden" "$test_output"

BRANCH_NAME=master GITHUB_ACTIONS=true "$PRE_COMMIT_CHECK" >"$test_output" 2>&1
if grep -qF "direct work on master is forbidden" "$test_output"; then
  echo "ERROR: GitHub Actions master validation was blocked" >&2
  exit 1
fi

cat >"$secret_guard" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "ingress_fixture=PASS"
SH
chmod +x "$secret_guard"
cat >"$secret_fixture_dir/safe.yml" <<'YAML'
permissions:
  id-token: read
  id-token: write
  id-token: none
contracts:
  - contents=read,id-token=read
  - contents=read,id-token=write
  - contents=read,id-token=none
token: ${SAFE_TOKEN}
token: $SAFE_TOKEN
token: "${SAFE_TOKEN}"
token: $(printf safe)
token: ${{ secrets.NPM_TOKEN }}
NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
MONGO_PASSWORD: ${MONGO_PASSWORD}
authToken: "$AUTH_TOKEN"
SSH_PRIVATE_KEY: "${SSH_PRIVATE_KEY:-}"
"NODE_AUTH_TOKEN": "${{ secrets.NPM_TOKEN }}"
'MONGO_PASSWORD': '${MONGO_PASSWORD}'
{"authToken":"${AUTH_TOKEN}"}
YAML
BRANCH_NAME=feature/test \
  INFRA_DIRS="$secret_fixture_dir" \
  INGRESS_GUARD="$secret_guard" \
  "$PRE_COMMIT_CHECK" >"$test_output" 2>&1
printf '%s%s\n%s%s\n' \
  'evil-id-to' 'ken: writehunter2xyz' \
  'contract: id-to' 'ken=writehunter2xyz' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "malformed id-token fixtures"
printf '%s%s\n%s%s\n%s%s\n%s%s\n%s%s\n%s%s\n%s%s\n%s%s\n' \
  'to' 'ken=${SAFE_TOKEN}fixed' \
  'to' 'ken=$SAFE_TOKEN-fixed' \
  'to' 'ken=${{ secrets.NPM_TOKEN }}fixed' \
  'to' 'ken="${SAFE_TOKEN}"fixed' \
  'to' 'ken=$(printf safe)fixed' \
  'to' 'ken=${SAFE_TOKEN},fixed-literal' \
  'to' 'ken=${SAFE_TOKEN}]fixed-literal' \
  'to' 'ken: ${{ secrets.NPM_TOKEN }} fixed-literal' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "safe-value literal suffix fixtures"
printf '%s%s\n' \
  'safe_ref: ${SAFE_TOKEN}, to' \
  'ken: hunter2xyz' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "mixed safe reference and hard-coded token fixture"
printf '%s%s\n' \
  'to' \
  'ken: hunter2xyz # synthetic inline comment' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "commented hard-coded token fixture"
printf '%s%s\n' 'to' 'ken: hunter2xyz' >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "hard-coded token fixture"
printf '%s%s\n%s%s\n%s%s\n%s%s\n' \
  'MONGO_PASS' 'WORD: hunter2xyz' \
  'JWT_SEC' 'RET=hunter2xyz' \
  'NODE_AUTH_TO' 'KEN: hunter2xyz' \
  'authTo' 'ken: hunter2xyz' \
  >"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "prefixed secret-key fixtures"
printf '"NODE_AUTH_TO%s": "hunter2xyz"\n' 'KEN' \
  >"$secret_fixture_dir/unsafe.yml"
printf "'MONGO_PASS%s': 'hunter2xyz'\n" 'WORD' \
  >>"$secret_fixture_dir/unsafe.yml"
printf '{"authTo%s":"hunter2xyz"}\n' 'ken' \
  >>"$secret_fixture_dir/unsafe.yml"
assert_secret_fixture_rejected "quoted secret-key fixtures"
rm -f "$secret_fixture_dir/unsafe.yml"

cp "$ROOT_DIR"/.github/workflows/*.yml "$permission_fixture_dir/"
WORKFLOW_PERMISSION_DIR="$permission_fixture_dir" \
  run_workflow_trigger_guard_without_node >"$test_output" 2>&1
assert_node_not_invoked

cat >"$permission_fixture_dir/rogue-status-writer.yml" <<'YAML'
name: rogue-status-writer
on: workflow_dispatch
permissions:
  statuses: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo unsafe
YAML
if WORKFLOW_PERMISSION_DIR="$permission_fixture_dir" \
    run_workflow_trigger_guard_without_node >"$test_output" 2>&1; then
  echo "ERROR: secondary statuses:write workflow unexpectedly passed" >&2
  exit 1
fi
grep -qF "branch-policy.yml must be the sole explicit statuses:write workflow" \
  "$test_output"
assert_node_not_invoked
rm -f "$permission_fixture_dir/rogue-status-writer.yml"
cat >"$permission_fixture_dir/implicit-permissions.yml" <<'YAML'
name: implicit-permissions
on: workflow_dispatch
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo "${{ github.token }}"
YAML
if WORKFLOW_PERMISSION_DIR="$permission_fixture_dir" \
    run_workflow_trigger_guard_without_node >"$test_output" 2>&1; then
  echo "ERROR: implicit workflow permissions unexpectedly passed" >&2
  exit 1
fi
grep -qF "every workflow job must declare effective permissions" "$test_output"
assert_node_not_invoked
echo "coverage_node_non_invocation=PASS"
"$COVERAGE_ENGINE_REVIEW"

coverage_review_poison="$permission_fixture_dir/coverage-review-poison"
coverage_review_node_poison="$permission_fixture_dir/coverage-review-node-invoked"
coverage_review_docker_poison="$permission_fixture_dir/coverage-review-docker-invoked"
mkdir -p "$coverage_review_poison"
cat >"$coverage_review_poison/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
: >"${BETSTAN_COVERAGE_REVIEW_NODE_SENTINEL:?}"
exit 97
SH
cat >"$coverage_review_poison/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
: >"${BETSTAN_COVERAGE_REVIEW_DOCKER_SENTINEL:?}"
exit 97
SH
chmod +x "$coverage_review_poison/node" "$coverage_review_poison/docker"
PATH="$coverage_review_poison:$PATH" \
  GITHUB_ACTIONS=false \
  BETSTAN_COVERAGE_REVIEW_NODE_SENTINEL="$coverage_review_node_poison" \
  BETSTAN_COVERAGE_REVIEW_DOCKER_SENTINEL="$coverage_review_docker_poison" \
  "$COVERAGE_ENGINE_REVIEW" >"$test_output"
grep -qF "mode=local-advisory execution=skipped" "$test_output"
if [[ -e "$coverage_review_node_poison" || -e "$coverage_review_docker_poison" ]]; then
  echo "ERROR: local coverage review invoked Node or Docker" >&2
  exit 1
fi

rm -f "$coverage_review_node_poison" "$coverage_review_docker_poison"
PATH="$coverage_review_poison:$PATH" \
  GITHUB_ACTIONS=true \
  GITHUB_REPOSITORY=vasilyevstan/betstan \
  GITHUB_EVENT_NAME=push \
  GITHUB_REF=refs/heads/master \
  GITHUB_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)" \
  BETSTAN_COVERAGE_REVIEW_NODE_SENTINEL="$coverage_review_node_poison" \
  BETSTAN_COVERAGE_REVIEW_DOCKER_SENTINEL="$coverage_review_docker_poison" \
  "$COVERAGE_ENGINE_REVIEW" >"$test_output"
grep -qF "mode=default-equal execution=skipped" "$test_output"
if [[ -e "$coverage_review_node_poison" || -e "$coverage_review_docker_poison" ]]; then
  echo "ERROR: trusted default coverage review invoked Node or Docker" >&2
  exit 1
fi

initialize_coverage_review_fixture "engine-only"
if run_coverage_review_fixture >"$test_output" 2>&1; then
  echo "ERROR: mixed coverage asset pair unexpectedly passed" >&2
  exit 1
fi
grep -qF "reason=mixed-coverage-asset-pair" "$test_output"
[[ ! -e "$coverage_review_docker_args" ]]
[[ ! -e "$coverage_review_node_sentinel" ]]

initialize_coverage_review_fixture "unauthorized"
if run_coverage_review_fixture >"$test_output" 2>&1; then
  echo "ERROR: unauthorized coverage asset pair unexpectedly passed" >&2
  exit 1
fi
grep -qF "reason=coverage-assets-are-not-authorized" "$test_output"
[[ ! -e "$coverage_review_docker_args" ]]
[[ ! -e "$coverage_review_node_sentinel" ]]

initialize_coverage_review_fixture "base-only-authorization"
if run_coverage_review_fixture >"$test_output" 2>&1; then
  echo "ERROR: base-only coverage authorization unexpectedly passed" >&2
  exit 1
fi
grep -qF "reason=coverage-assets-are-not-authorized" "$test_output"
[[ ! -e "$coverage_review_docker_args" ]]
[[ ! -e "$coverage_review_node_sentinel" ]]

for invalid_test_mode in \
  invalid-tests-1 \
  invalid-tests-101 \
  invalid-tests-103 \
  invalid-tests-10000; do
  initialize_coverage_review_fixture "$invalid_test_mode"
  if run_coverage_review_fixture >"$test_output" 2>&1; then
    echo "ERROR: $invalid_test_mode unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "reason=coverage-assets-are-not-authorized" "$test_output"
  [[ ! -e "$coverage_review_docker_args" ]]
  [[ ! -e "$coverage_review_node_sentinel" ]]
done

for lineage_case in \
  "wrong-base-lineage:coverage-authorization-base-lineage-is-invalid" \
  "wrong-adoption-lineage:coverage-authorization-adoption-lineage-is-invalid" \
  "wrong-receipt-lineage:coverage-authorization-receipt-lineage-is-invalid"; do
  lineage_mode="${lineage_case%%:*}"
  lineage_reason="${lineage_case#*:}"
  initialize_coverage_review_fixture "$lineage_mode"
  if run_coverage_review_fixture >"$test_output" 2>&1; then
    echo "ERROR: $lineage_mode unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "reason=$lineage_reason" "$test_output"
  [[ ! -e "$coverage_review_docker_args" ]]
  [[ ! -e "$coverage_review_node_sentinel" ]]
done

initialize_coverage_review_fixture "authorized"
write_coverage_review_tap "$coverage_review_docker_stdout" 102
run_coverage_review_fixture >"$test_output"
grep -qF \
  "coverage_engine_review=PASS mode=authorized authorization=coverage-engine-review-fixture" \
  "$test_output"
grep -qF "tests=102" "$test_output"
[[ ! -e "$coverage_review_node_sentinel" ]]
python3 - \
  "$coverage_review_docker_args" \
  "$coverage_review_repo" <<'PY'
import pathlib
import sys

arguments_path, repository_path = sys.argv[1:]
parts = pathlib.Path(arguments_path).read_bytes().split(b"\0")
if parts and parts[-1] == b"":
    parts.pop()
arguments = [part.decode("utf-8", "strict") for part in parts]

def value_after(flag):
    positions = [index for index, value in enumerate(arguments) if value == flag]
    if len(positions) != 1 or positions[0] + 1 >= len(arguments):
        raise SystemExit(f"invalid {flag} cardinality")
    return arguments[positions[0] + 1]

required_flags = {
    "--rm",
    "--pull=always",
    "--quiet",
    "--read-only",
}
if not required_flags.issubset(arguments):
    raise SystemExit("missing fixed container flag")
if value_after("--platform") != "linux/amd64":
    raise SystemExit("platform drift")
if value_after("--network") != "none" or value_after("--ipc") != "none":
    raise SystemExit("isolation drift")
if value_after("--user") != "0:0":
    raise SystemExit("controller identity drift")
if value_after("--security-opt") != "no-new-privileges=true":
    raise SystemExit("no-new-privileges drift")
if value_after("--cap-drop") != "ALL":
    raise SystemExit("capability drop drift")
capabilities = {
    arguments[index + 1]
    for index, value in enumerate(arguments)
    if value == "--cap-add"
}
if capabilities != {
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "KILL",
    "SETGID",
    "SETUID",
}:
    raise SystemExit("capability allowlist drift")
if (
    value_after("--pids-limit") != "256"
    or value_after("--memory") != "2g"
    or value_after("--memory-swap") != "2g"
    or value_after("--cpus") != "2.0"
):
    raise SystemExit("resource bound drift")
if value_after("--ulimit") != "nofile=1024:1024":
    raise SystemExit("file descriptor bound drift")
if value_after("--tmpfs") != "/tmp:rw,nosuid,nodev,exec,size=805306368,mode=1777":
    raise SystemExit("tmpfs drift")
mount = value_after("--mount")
if (
    "type=bind," not in mount
    or "dst=/workspace,readonly" not in mount
    or repository_path in mount
):
    raise SystemExit("snapshot mount drift")
environment = [
    arguments[index + 1]
    for index, value in enumerate(arguments)
    if value == "--env"
]
if environment != [
    "BETSTAN_COVERAGE_CONTAINER=1",
    "HOME=/tmp/home",
    "TMPDIR=/tmp",
    "LANG=C",
    "LC_ALL=C",
    "TZ=UTC",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
]:
    raise SystemExit("container environment drift")
if any(
    marker in value.upper()
    for value in environment
    for marker in ["TOKEN", "SECRET", "PROXY", "GITHUB_", "ACTIONS_"]
):
    raise SystemExit("sensitive environment forwarded")
image = (
    "docker.io/library/node@sha256:"
    "4bd021da81659dd1da4a96539550966c493033f5386961ac1201e5de1daca909"
)
if arguments.count(image) != 1:
    raise SystemExit("image digest drift")
if not arguments[-3:] or arguments[-3:-1] != ["/bin/bash", "-ceu"]:
    raise SystemExit("container entrypoint drift")
if (
    "node --check .github/scripts/test-coverage-matrix.js" not in arguments[-1]
    or "node --check .github/scripts/test-test-coverage-matrix.js"
    not in arguments[-1]
    or "node --test-reporter=tap .github/scripts/test-test-coverage-matrix.js"
    not in arguments[-1]
):
    raise SystemExit("container command drift")
PY

python3 - "$coverage_review_docker_stdout" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
lines = path.read_text(encoding="ascii").splitlines()
path.write_text(
    "\n".join(line for line in lines if line != "1..102") + "\n",
    encoding="ascii",
)
PY
if run_coverage_review_fixture >"$test_output" 2>&1; then
  echo "ERROR: incomplete TAP output unexpectedly passed" >&2
  exit 1
fi
grep -qF "reason=invalid-tap" "$test_output"

for tap_directive in SKIP TODO; do
  write_coverage_review_tap "$coverage_review_docker_stdout" 102
  python3 - "$coverage_review_docker_stdout" "$tap_directive" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
directive = sys.argv[2]
content = path.read_text(encoding="ascii")
path.write_text(
    content
    .replace(
        "# Subtest: fixture case 1",
        f"# Subtest: fixture case 1 # {directive}",
        1,
    )
    .replace(
        "ok 1 - fixture case 1",
        f"ok 1 - fixture case 1 # {directive}",
        1,
    ),
    encoding="ascii",
)
PY
  if run_coverage_review_fixture >"$test_output" 2>&1; then
    echo "ERROR: TAP $tap_directive directive unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "reason=invalid-tap" "$test_output"
done

write_coverage_review_tap "$coverage_review_docker_stdout" 102
python3 - "$coverage_review_docker_stdout" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
content = path.read_text(encoding="ascii")
path.write_text(
    content.replace(
        "fixture case 1",
        r"fixture case 1 \# SKIP literal",
    ),
    encoding="ascii",
)
PY
run_coverage_review_fixture >"$test_output"
grep -qF "coverage_engine_review=PASS mode=authorized" "$test_output"

for malformed_tap_fragment in \
  "arbitrary trailing text" \
  "  TAP version 13" \
  "  Bail out! nested failure" \
  "  not ok 1 - nested failure"; do
  write_coverage_review_tap "$coverage_review_docker_stdout" 102
  printf '%s\n' "$malformed_tap_fragment" \
    >>"$coverage_review_docker_stdout"
  if run_coverage_review_fixture >"$test_output" 2>&1; then
    echo "ERROR: malformed TAP fragment unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "reason=invalid-tap" "$test_output"
done

for separator_hex in 0d 0b 0c 1c 1d 1e; do
  write_coverage_review_tap "$coverage_review_docker_stdout" 102
  python3 - "$coverage_review_docker_stdout" "$separator_hex" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
separator = bytes.fromhex(sys.argv[2])
content = path.read_bytes()
path.write_bytes(content.replace(b"\n", separator, 1))
PY
  if run_coverage_review_fixture >"$test_output" 2>&1; then
    echo "ERROR: alternate TAP record separator unexpectedly passed" >&2
    exit 1
  fi
  grep -qF "reason=invalid-tap" "$test_output"
done

write_coverage_review_tap "$coverage_review_docker_stdout" 102
printf 'candidate-secret-diagnostic\n' >"$coverage_review_docker_stderr"
if run_coverage_review_fixture >"$test_output" 2>&1; then
  echo "ERROR: candidate stderr unexpectedly passed" >&2
  exit 1
fi
grep -qF "reason=invalid-tap" "$test_output"
if grep -qF "candidate-secret-diagnostic" "$test_output"; then
  echo "ERROR: candidate stderr escaped private capture" >&2
  exit 1
fi

: >"$coverage_review_docker_stderr"
printf 'candidate-secret-output\n' >"$coverage_review_docker_stdout"
printf '17\n' >"$coverage_review_docker_exit"
if run_coverage_review_fixture >"$test_output" 2>&1; then
  echo "ERROR: failed contained execution unexpectedly passed" >&2
  exit 1
fi
grep -qF "reason=contained-execution status=17" "$test_output"
if grep -qF "candidate-secret-output" "$test_output"; then
  echo "ERROR: candidate stdout escaped private capture" >&2
  exit 1
fi
echo "coverage_engine_review_tests=PASS"

"$PR_MERGE_SAFETY_TEST"
"$PROTECTED_OPERATION_POLICY_TEST"
"$CLI_DISPATCH_TEST"
"$RUN_APPROVAL_TEST"
"$RUN_EXCLUSIVITY_TEST"
"$LIVE_DATA_ROLLOUT_TEST"
"$GHCR_CONTRACT_TEST"
python3 -B -m py_compile "$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"

python3 - "$AZURE_WORKFLOW" "$OCI_WORKFLOW" "$BUILD_WORKFLOW" "$OCI_DEPLOY_SCRIPT" <<'PY'
import pathlib
import re
import sys

azure_workflow = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
oci_workflow = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
build_workflow = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")
oci_deploy_script = pathlib.Path(sys.argv[4]).read_text(encoding="utf-8")

expected_azure_order = [
    "auth",
    "bet",
    "client",
    "event",
    "moderation",
    "resulting",
    "slip",
    "backoffice",
    "gamemaster",
]
expected_oci_order = [
    "auth",
    "bet",
    "event",
    "moderation",
    "resulting",
    "slip",
    "backoffice",
    "client",
    "gamemaster",
]
approved_action_refs = {
    "actions/checkout": "11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/cache": "0400d5f644dc74513175e3cd8d07132dd4860809",
    "docker/setup-buildx-action": "e468171a9de216ec08956ac3ada2f0791b6bd435",
    "docker/login-action": "184bdaa0721073962dff0199f1fb9940f07167d1",
    "docker/build-push-action": "ca052bb54ab0790a636c9b5f226502c73d547a25",
    "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
}
full_sha_pattern = re.compile(r"^[0-9a-f]{40}$")


def fail(message: str) -> None:
    raise SystemExit(message)


def parse_rollouts(text: str) -> list[str]:
    match = re.search(r"rollouts=\(\n(?P<body>.*?)\n\s*\)", text, re.S)
    if not match:
        fail("Azure deploy workflow rollout list is missing")
    return re.findall(r"'([^|']+)\|", match.group("body"))


def parse_services(text: str) -> list[str]:
    match = re.search(r"services=\((?P<body>[^\)]*)\)", text, re.S)
    if not match:
        fail("OCI deploy service list is missing")
    return re.findall(r"\b([a-z]+)\b", match.group("body"))


def parse_uses_entries(text: str) -> list[tuple[int, str]]:
    entries: list[tuple[int, str]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        match = re.match(r"\s*uses:\s*([^\s#]+)", line)
        if match:
            entries.append((line_number, match.group(1)))
    if not entries:
        fail("production-build.yml does not declare any uses entries")
    return entries


def validate_action_pins(text: str, label: str = "production-build.yml") -> list[str]:
    errors: list[str] = []
    seen_repositories: set[str] = set()

    for line_number, use in parse_uses_entries(text):
        match = re.fullmatch(r"(?P<repository>[^@\s]+)@(?P<ref>[^\s]+)", use)
        if not match:
            errors.append(f"{label} line {line_number} does not pin an action ref: {use}")
            continue

        repository = match.group("repository")
        ref = match.group("ref")
        seen_repositories.add(repository)

        expected_ref = approved_action_refs.get(repository)
        if expected_ref is None:
            errors.append(
                f"{label} line {line_number} references an unreviewed third-party action: {repository}"
            )
            continue

        if not full_sha_pattern.fullmatch(ref):
            errors.append(
                f"{label} line {line_number} is not pinned to a full 40-character lowercase hex commit SHA: {use}"
            )
            continue

        if ref != expected_ref:
            errors.append(
                f"{label} line {line_number} is pinned to {repository}@{ref}, expected {repository}@{expected_ref}"
            )

    missing_repositories = sorted(set(approved_action_refs) - seen_repositories)
    unexpected_repositories = sorted(seen_repositories - set(approved_action_refs))
    if missing_repositories or unexpected_repositories:
        fragments: list[str] = []
        if missing_repositories:
            fragments.append("missing reviewed actions: " + ", ".join(missing_repositories))
        if unexpected_repositories:
            fragments.append("unexpected actions: " + ", ".join(unexpected_repositories))
        errors.append(f"{label} action inventory changed ({'; '.join(fragments)})")

    return errors


def mutate_once(text: str, needle: str, replacement: str) -> str:
    mutated = text.replace(needle, replacement, 1)
    if mutated == text:
        fail(f"fixture mutation failed for {needle!r}")
    return mutated


if parse_rollouts(azure_workflow) != expected_azure_order:
    fail("Azure deploy workflow rollout order changed")
if parse_services(oci_deploy_script) != expected_oci_order:
    fail("OCI deploy script rollout order changed")

action_pin_errors = validate_action_pins(build_workflow)
if action_pin_errors:
    fail("\n".join(action_pin_errors))

negative_cases = {
    "floating-major-tag": (
        mutate_once(
            build_workflow,
            f"actions/cache@{approved_action_refs['actions/cache']}",
            "actions/cache@v4",
        ),
        "is not pinned to a full 40-character lowercase hex commit SHA",
    ),
    "short-sha": (
        mutate_once(
            build_workflow,
            f"docker/login-action@{approved_action_refs['docker/login-action']}",
            "docker/login-action@184bdaa0721073962dff0199f1fb9940f07167d",
        ),
        "is not pinned to a full 40-character lowercase hex commit SHA",
    ),
    "uppercase-nonhex": (
        mutate_once(
            build_workflow,
            f"actions/setup-node@{approved_action_refs['actions/setup-node']}",
            f"actions/setup-node@{approved_action_refs['actions/setup-node'].upper()}",
        ),
        "is not pinned to a full 40-character lowercase hex commit SHA",
    ),
    "wrong-full-sha": (
        mutate_once(
            build_workflow,
            f"docker/build-push-action@{approved_action_refs['docker/build-push-action']}",
            "docker/build-push-action@0000000000000000000000000000000000000000",
        ),
        "expected docker/build-push-action@ca052bb54ab0790a636c9b5f226502c73d547a25",
    ),
    "unknown-action": (
        mutate_once(
            build_workflow,
            f"actions/upload-artifact@{approved_action_refs['actions/upload-artifact']}",
            "acme/unknown-action@ea165f8d65b6e75b540449e92b4886f43607fa02",
        ),
        "references an unreviewed third-party action",
    ),
}

for name, (candidate, expected_fragment) in negative_cases.items():
    candidate_errors = validate_action_pins(candidate, name)
    if not candidate_errors:
        fail(f"{name} fixture unexpectedly passed")
    if any(expected_fragment in error for error in candidate_errors):
        continue
    fail(f"{name} fixture failed for the wrong reason: {' | '.join(candidate_errors)}")

for text, label in (
    (azure_workflow, "Azure deploy workflow"),
    (oci_deploy_script, "OCI deploy script"),
):
    if "gamemaster must rollout last" not in text:
        fail(f"{label} lost the gamemaster-last guard")

for expected_fragment in (
    "IMAGE_PROVENANCE_FILE: artifacts/deploy-provenance/images.tsv",
    "SECONDARY_PUBLIC_URL: ${{ format('https://www.{0}', env.APP_DOMAIN) }}",
    "LIVE_BETTING_READINESS_MODE: dark",
    "LIVE_READINESS_REQUEST_TIMEOUT: \"15\"",
    "LIVE_READINESS_SSE_TIMEOUT: \"20\"",
    "path: artifacts/deploy-validation/live-readiness",
):
    if expected_fragment not in azure_workflow:
        fail(f"Azure deploy workflow missing readiness wiring: {expected_fragment}")

for expected_fragment in (
    "IMAGE_PROVENANCE_FILE: artifacts/oci-deploy/images.tsv",
    "OCI_PUBLIC_URL: ${{ steps.provenance.outputs.public_url }}",
    "OCI_REDIRECT_URL: ${{ steps.provenance.outputs.redirect_url }}",
    "OCI_DIAGNOSTIC_URL: ${{ steps.provenance.outputs.diagnostic_url }}",
    "LIVE_BETTING_READINESS_MODE: dark",
    "LIVE_READINESS_REQUEST_TIMEOUT: \"15\"",
    "LIVE_READINESS_SSE_TIMEOUT: \"20\"",
    "path: artifacts/oci-deploy-validation/live-readiness",
):
    if expected_fragment not in oci_workflow:
        fail(f"OCI deploy workflow missing readiness wiring: {expected_fragment}")

for required_test in (
    "./infra/azure/agents/pre-commit-infra-check-stan.sh",
    "./infra/azure/agents/test-deployment-safety-ci-stan.sh",
    "./infra/azure/agents/test-deploy-validation-loop-stan.sh",
    "./infra/azure/agents/test-live-betting-readiness-stan.sh",
    "./infra/azure/agents/test-live-betting-rollback-readiness-stan.sh",
    "./infra/azure/agents/test-production-rollback-stan.sh",
    "./infra/oci/tests/test-deploy-validation-loop-stan.sh",
    "./infra/oci/tests/test-live-betting-readiness-stan.sh",
    "./infra/oci/tests/rollback-live-readiness-contract.sh",
    "./infra/oci/tests/rollback-contract.sh",
):
    if required_test not in build_workflow:
        fail(f"production-build.yml is missing {required_test}")

print(f"production_build_action_pins=PASS cases={len(negative_cases) + 1}")
print("deployment_safety_ci_tests=PASS")
PY
