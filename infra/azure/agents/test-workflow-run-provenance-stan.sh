#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROVENANCE="$ROOT_DIR/infra/azure/agents/workflow-run-provenance-stan.sh"
TARGET_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"

gh() {
  if [[ "$1" == "api" && "$2" == *"/actions/workflows/production-build.yml" ]]; then
    echo "201"
  elif [[ "$1" == "api" && "$2" == *"/actions/workflows/production-deploy.yml" ]]; then
    echo "301"
  elif [[ "$1 $2" == "run list" && "$*" == *"production-build.yml"* ]]; then
    printf '[{"databaseId":201,"event":"push","headSha":"%s","status":"completed","conclusion":"success","url":"https://example.invalid/runs/201"}]\n' "$TARGET_SHA"
  elif [[ "$1 $2" == "run list" && "$*" == *"production-deploy.yml"* ]]; then
    printf '[{"databaseId":301,"displayTitle":"deploy %s","event":"workflow_run","headSha":"%s","status":"completed","conclusion":"success","url":"https://example.invalid/runs/301"}]\n' "$TARGET_SHA" "$TARGET_SHA"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/201" ]]; then
    printf '{"id":201,"workflow_id":%s,"path":".github/workflows/production-build.yml","event":"push","head_sha":"%s","status":"completed","conclusion":"success","html_url":"https://example.invalid/runs/201"}\n' \
      "${STUB_BUILD_WORKFLOW_ID:-201}" "$TARGET_SHA"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/301" ]]; then
    printf '{"id":301,"workflow_id":301,"path":".github/workflows/production-deploy.yml","display_title":"deploy %s","event":"workflow_run","run_attempt":1,"status":"completed","conclusion":"success","html_url":"https://example.invalid/runs/301"}\n' "$TARGET_SHA"
  elif [[ "$1 $2" == "run download" ]]; then
    local directory=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--dir" ]]; then
        directory="$2"
        break
      fi
      shift
    done
    [[ -n "$directory" ]] || return 1
    printf 'image_sha=%s\nupstream_run_id=201\nupstream_event=push\n' \
      "${STUB_IMAGE_SHA:-$TARGET_SHA}" > "$directory/provenance.txt"
  else
    echo "unexpected gh invocation: $*" >&2
    return 1
  fi
}
export -f gh
export TARGET_SHA

REPO=example/repo WORKFLOW=production-build TARGET_SHA="$TARGET_SHA" \
  "$PROVENANCE" >/dev/null
REPO=example/repo WORKFLOW=production-deploy TARGET_SHA="$TARGET_SHA" \
  "$PROVENANCE" >/dev/null

if STUB_IMAGE_SHA="0000000000000000000000000000000000000000" \
  REPO=example/repo WORKFLOW=production-deploy TARGET_SHA="$TARGET_SHA" \
  "$PROVENANCE" >/dev/null 2>&1; then
  echo "provenance accepted an artifact for the wrong image SHA" >&2
  exit 1
fi

if STUB_BUILD_WORKFLOW_ID=999 REPO=example/repo \
  WORKFLOW=production-deploy TARGET_SHA="$TARGET_SHA" \
  "$PROVENANCE" >/dev/null 2>&1; then
  echo "provenance accepted an untrusted upstream build workflow" >&2
  exit 1
fi

echo "workflow_run_provenance_tests=PASS"
