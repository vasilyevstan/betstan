#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="$ROOT_DIR/infra/azure/agents/workflow-shell-input-guard-stan.py"
WORK_DIR="$(mktemp -d "$ROOT_DIR/.workflow-shell-input-guard.XXXXXX")"
trap 'rm -rf -- "$WORK_DIR"' EXIT

fail() {
  echo "workflow_shell_input_guard_tests=FAIL reason=$*" >&2
  exit 1
}

cat > "$WORK_DIR/safe.yml" <<'YAML'
name: safe
on:
  workflow_dispatch:
    inputs:
      confirmation:
        required: true
        type: string
env:
  CONFIRMATION: ${{ inputs.confirmation }}
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - run: |
          [ "$CONFIRMATION" = "EXPECTED" ]
      - uses: actions/checkout@0000000000000000000000000000000000000000
        with:
          ref: ${{ inputs.confirmation }}
YAML

python3 "$GUARD" "$WORK_DIR/safe.yml" >/dev/null ||
  fail "environment and action input bindings were rejected"

assert_rejected() {
  local name="$1"
  local expected_line="$2"
  local file="$WORK_DIR/$name.yml"
  shift 2
  printf '%s\n' "$@" > "$file"

  if python3 "$GUARD" "$file" >"$WORK_DIR/$name.out" 2>&1; then
    fail "$name direct shell interpolation was accepted"
  fi
  grep -Fq "$file:$expected_line" "$WORK_DIR/$name.out" ||
    fail "$name diagnostic did not identify the exact workflow line"
}

assert_rejected block 9 \
  'name: block' \
  'on: workflow_dispatch' \
  'jobs:' \
  '  validate:' \
  '    runs-on: ubuntu-latest' \
  '    steps:' \
  '      - run: |' \
  '          set -euo pipefail' \
  '          [ "${{ inputs.confirmation }}" = "EXPECTED" ]'

assert_rejected whitespace 8 \
  'name: whitespace' \
  'on: workflow_dispatch' \
  'jobs:' \
  '  validate:' \
  '    runs-on: ubuntu-latest' \
  '    steps:' \
  '      - run: |' \
  '          echo "${{   inputs.confirmation }}"'

assert_rejected legacy 7 \
  'name: legacy' \
  'on: workflow_dispatch' \
  'jobs:' \
  '  validate:' \
  '    runs-on: ubuntu-latest' \
  '    steps:' \
  '      - run: echo "${{ github.event.inputs.confirmation }}"'

echo "workflow_shell_input_guard_tests=PASS"
