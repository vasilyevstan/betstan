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
LIVE_DATA_ROLLOUT_TEST="$ROOT_DIR/infra/oci/tests/test-live-betting-data-rollout-stan.sh"
GHCR_CONTRACT_TEST="$ROOT_DIR/infra/oci/tests/test-ghcr-contract.sh"

test_output="$(mktemp)"
secret_fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-secret-scan.XXXXXX")"
permission_fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-status-writers.XXXXXX")"
secret_guard="$secret_fixture_dir/ingress-guard"
cleanup() {
  rm -f "$test_output"
  rm -f "$secret_fixture_dir/safe.yml" "$secret_fixture_dir/unsafe.yml" "$secret_guard"
  rmdir "$secret_fixture_dir" 2>/dev/null || true
  rm -rf "$permission_fixture_dir"
}
trap cleanup EXIT

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
  "$WORKFLOW_TRIGGER_GUARD" >"$test_output" 2>&1
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
    "$WORKFLOW_TRIGGER_GUARD" >"$test_output" 2>&1; then
  echo "ERROR: secondary statuses:write workflow unexpectedly passed" >&2
  exit 1
fi
grep -qF "branch-policy.yml must be the sole explicit statuses:write workflow" \
  "$test_output"
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
    "$WORKFLOW_TRIGGER_GUARD" >"$test_output" 2>&1; then
  echo "ERROR: implicit workflow permissions unexpectedly passed" >&2
  exit 1
fi
grep -qF "every workflow job must declare effective permissions" "$test_output"

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
