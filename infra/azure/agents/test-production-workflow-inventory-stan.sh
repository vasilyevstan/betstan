#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INVENTORY="$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.sh"
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

cp "$ROOT_DIR/.github/workflows/production-build.yml" "$tmp_dir/"
cp "$ROOT_DIR/.github/workflows/production-deploy.yml" "$tmp_dir/"

assert_set() {
  local expected="$1"
  local actual
  actual="$(
    WORKFLOW_DIR="$tmp_dir" "$INVENTORY" |
      sed -n 's/^production_workflows=//p'
  )"
  [[ "$actual" == "$expected" ]] || {
    echo "expected=$expected actual=$actual" >&2
    exit 1
  }
}

assert_set "production-build,production-deploy"

cat > "$tmp_dir/rogue-production.yml" <<'YAML'
name: rogue-production
on:
  push:
    branches:
      - master
jobs:
  mutate:
    runs-on: ubuntu-latest
    environment: production-emergency
    steps:
      - run: echo unsafe
YAML

assert_set "production-build,production-deploy,rogue-production"

echo "production_workflow_inventory_tests=PASS"
