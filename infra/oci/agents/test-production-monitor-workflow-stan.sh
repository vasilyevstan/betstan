#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
workflow="$ROOT_DIR/.github/workflows/oci-production-monitor.yml"

fail() {
  printf 'production_monitor_workflow_tests=FAIL reason=%s\n' "$1" >&2
  exit 1
}

[[ -f "$workflow" ]] || fail "workflow is missing"
for literal in \
  'schedule:' \
  'cron: "7,22,37,52 * * * *"' \
  'workflow_dispatch:' \
  'contents: read' \
  'actions: read' \
  'issues: write' \
  'pull-requests: read' \
  'group: oci-production-observer' \
  'cancel-in-progress: false' \
  "github.ref == 'refs/heads/master'" \
  'github.run_attempt == 1' \
  'collect-public' \
  '--mode observation' \
  'test ! -s "$WORK_DIR/claim.json"'; do
  grep -Fq -- "$literal" "$workflow" ||
    fail "required observation-only contract is missing: $literal"
done

for forbidden in \
  'id-token:' \
  'deployments:' \
  'packages:' \
  'environment:' \
  'secrets.' \
  'OCI_CLI_' \
  'kubectl ' \
  ' claim ' \
  'set-status' \
  'workflow_call' \
  'repository_dispatch'; do
  ! grep -Fq -- "$forbidden" "$workflow" ||
    fail "production-capable contract is forbidden: $forbidden"
done

printf 'production_monitor_workflow_tests=PASS\n'
