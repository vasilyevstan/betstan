#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXCLUSIVITY="$ROOT_DIR/infra/azure/agents/production-run-exclusivity-stan.sh"
RUN_ID=123
WORKFLOW_ID=456

gh() {
  if [[ "$1" == "api" && "$2" == *"/actions/runs?status="* ]]; then
    if [[ "${STUB_MODE:-none}" == "none" || "$2" != *"status=in_progress"* ]]; then
      printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
      return
    fi
    if [[ "$STUB_MODE" == "overflow" ]]; then
      printf '%s\n' '{"total_count":101,"workflow_runs":[]}'
      return
    fi
    local branch=master
    if [[ "$STUB_MODE" == "pr-validation" ]]; then
      branch=dev
    fi
    local updated_at=1970-01-01T00:00:00Z
    if [[ "$STUB_MODE" == "recent-disabled" ]]; then
      updated_at=1970-01-01T00:33:20Z
    fi
    local path=.github/workflows/production-build.yml
    if [[ "$STUB_MODE" == "data-active" ]]; then
      path=.github/workflows/oci-live-data-rollout.yml
    fi
    printf '%s\n' \
      "{\"total_count\":1,\"workflow_runs\":[{\"id\":$RUN_ID,\"workflow_id\":$WORKFLOW_ID,\"path\":\"$path\",\"head_branch\":\"$branch\",\"status\":\"in_progress\",\"updated_at\":\"$updated_at\"}]}"
  elif [[ "$1" == "api" && "$2" == *"/actions/workflows/$WORKFLOW_ID"* ]]; then
    local state=active
    if [[ "$STUB_MODE" == *disabled* ]]; then
      state=disabled_manually
    fi
    printf '%s\n' "{\"id\":$WORKFLOW_ID,\"state\":\"$state\"}"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/$RUN_ID/jobs"* ]]; then
    local count=1
    if [[ "$STUB_MODE" == "stale-disabled" || "$STUB_MODE" == "recent-disabled" || "$STUB_MODE" == "pending-disabled" ]]; then
      count=0
    fi
    printf '%s\n' "{\"total_count\":$count,\"jobs\":[]}"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/$RUN_ID/pending_deployments"* ]]; then
    if [[ "$STUB_MODE" == "pending-disabled" ]]; then
      printf '%s\n' '[{"environment":{"id":1,"name":"production-emergency"}}]'
    else
      printf '%s\n' '[]'
    fi
  else
    echo "unexpected gh invocation: $*" >&2
    return 1
  fi
}
export -f gh
export RUN_ID WORKFLOW_ID

REPO=example/repo NOW_EPOCH=2000 "$EXCLUSIVITY" >/dev/null
REPO=example/repo NOW_EPOCH=2000 STUB_MODE=pr-validation \
  "$EXCLUSIVITY" >/dev/null
REPO=example/repo NOW_EPOCH=2000 STUB_MODE=stale-disabled \
  "$EXCLUSIVITY" >/dev/null
REPO=example/repo NOW_EPOCH=2000 STUB_MODE=active EXCLUDE_RUN_ID=$RUN_ID \
  "$EXCLUSIVITY" >/dev/null

for mode in active data-active recent-disabled pending-disabled jobs-disabled overflow; do
  if REPO=example/repo NOW_EPOCH=2000 STUB_MODE="$mode" \
    "$EXCLUSIVITY" >/dev/null 2>&1; then
    echo "production exclusivity accepted unsafe mode=$mode" >&2
    exit 1
  fi
done

echo "production_run_exclusivity_tests=PASS"
