#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXCLUSIVITY="$ROOT_DIR/infra/azure/agents/production-run-exclusivity-stan.sh"
RUN_ID=123
WORKFLOW_ID=456
MASTER_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
OLD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

gh() {
  if [[ "$1" == "api" && "$2" == *"/actions/runs?status="* ]]; then
    local mode="${STUB_MODE:-none}"
    if [[ "$mode" == "none" ]]; then
      printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
      return
    fi
    if [[ "$mode" == "overflow" && "$2" == *"status=in_progress"* ]]; then
      printf '%s\n' '{"total_count":101,"workflow_runs":[]}'
      return
    fi

    local branch=master
    if [[ "$mode" == "pr-validation" ]]; then
      branch=dev
    fi
    local updated_at=1970-01-01T00:00:00Z
    if [[ "$mode" == "recent-disabled" || "$mode" == "recent-superseded-capacity" ]]; then
      updated_at=1970-01-01T00:31:40Z
    fi
    local path=.github/workflows/production-build.yml
    local run_status=in_progress
    local event=push
    local head_sha="$OLD_SHA"
    local run_attempt=1
    if [[ "$mode" == "data-active" ]]; then
      path=.github/workflows/oci-live-data-rollout.yml
    elif [[ "$mode" == "activation-active" ]]; then
      path=.github/workflows/oci-live-betting-activate.yml
    elif [[ "$mode" == "disable-active" ]]; then
      path=.github/workflows/oci-live-betting-disable.yml
    elif [[ "$mode" == "superseded-deploy" ]]; then
      path=.github/workflows/oci-production-deploy.yml
      run_status=queued
      event=workflow_dispatch
    elif [[ "$mode" == *capacity* ]]; then
      path=.github/workflows/oci-capacity-acquire.yml
      run_status=queued
      event=workflow_dispatch
    fi
    if [[ "$mode" == "current-superseded-capacity" ]]; then
      head_sha="$MASTER_SHA"
    fi
    if [[ "$mode" == "wrong-attempt-superseded-capacity" ]]; then
      run_attempt=2
    fi
    if [[ "$2" != *"status=$run_status"* ]]; then
      printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
      return
    fi
    printf '%s\n' \
      "{\"total_count\":1,\"workflow_runs\":[{\"id\":$RUN_ID,\"workflow_id\":$WORKFLOW_ID,\"path\":\"$path\",\"head_branch\":\"$branch\",\"head_sha\":\"$head_sha\",\"event\":\"$event\",\"run_attempt\":$run_attempt,\"status\":\"$run_status\",\"updated_at\":\"$updated_at\"}]}"
  elif [[ "$1" == "api" && "$2" == *"/actions/workflows/$WORKFLOW_ID/runs?"* ]]; then
    [[ "$2" == *"event=workflow_dispatch"* ]] || {
      echo "successful-run proof was not limited to manual dispatches" >&2
      return 1
    }
    local mode="${STUB_MODE:-none}"
    case "$mode" in
      superseded-capacity | current-superseded-capacity | \
        recent-superseded-capacity | pending-superseded-capacity | \
        jobs-superseded-capacity | wrong-attempt-superseded-capacity)
        local successful_sha="$OLD_SHA"
        if [[ "$mode" == "current-superseded-capacity" ]]; then
          successful_sha="$MASTER_SHA"
        fi
        printf '%s\n' \
          "{\"total_count\":1,\"workflow_runs\":[{\"id\":124,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-capacity-acquire.yml\",\"head_branch\":\"master\",\"head_sha\":\"$successful_sha\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:32:30Z\"}]}"
        ;;
      rerun-superseded-capacity)
        printf '%s\n' \
          "{\"total_count\":1,\"workflow_runs\":[{\"id\":124,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-capacity-acquire.yml\",\"head_branch\":\"master\",\"head_sha\":\"$OLD_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":2,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:32:30Z\"}]}"
        ;;
      older-success-capacity)
        printf '%s\n' \
          "{\"total_count\":1,\"workflow_runs\":[{\"id\":124,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-capacity-acquire.yml\",\"head_branch\":\"master\",\"head_sha\":\"$OLD_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1969-12-31T23:59:59Z\"}]}"
        ;;
      earlier-id-success-capacity)
        printf '%s\n' \
          "{\"total_count\":1,\"workflow_runs\":[{\"id\":122,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-capacity-acquire.yml\",\"head_branch\":\"master\",\"head_sha\":\"$OLD_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:32:30Z\"}]}"
        ;;
      different-sha-success-capacity)
        printf '%s\n' \
          "{\"total_count\":1,\"workflow_runs\":[{\"id\":124,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-capacity-acquire.yml\",\"head_branch\":\"master\",\"head_sha\":\"$MASTER_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:32:30Z\"}]}"
        ;;
      *)
        printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
        ;;
    esac
  elif [[ "$1" == "api" && "$2" == *"/git/ref/heads/master" ]]; then
    printf '%s\n' "{\"object\":{\"sha\":\"$MASTER_SHA\"}}"
  elif [[ "$1" == "api" && "$2" == *"/actions/workflows/$WORKFLOW_ID"* ]]; then
    local state=active
    if [[ "$STUB_MODE" == *disabled* ]]; then
      state=disabled_manually
    fi
    local path=.github/workflows/production-build.yml
    if [[ "$STUB_MODE" == "data-active" ]]; then
      path=.github/workflows/oci-live-data-rollout.yml
    elif [[ "$STUB_MODE" == "activation-active" ]]; then
      path=.github/workflows/oci-live-betting-activate.yml
    elif [[ "$STUB_MODE" == "disable-active" ]]; then
      path=.github/workflows/oci-live-betting-disable.yml
    elif [[ "$STUB_MODE" == "superseded-deploy" ]]; then
      path=.github/workflows/oci-production-deploy.yml
    elif [[ "$STUB_MODE" == *capacity* ]]; then
      path=.github/workflows/oci-capacity-acquire.yml
    fi
    printf '%s\n' "{\"id\":$WORKFLOW_ID,\"state\":\"$state\",\"path\":\"$path\"}"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/$RUN_ID/jobs"* ]]; then
    local count=1
    case "$STUB_MODE" in
      stale-disabled | recent-disabled | pending-disabled | \
        superseded-capacity | unsuperseded-capacity | \
        current-superseded-capacity | recent-superseded-capacity | \
        pending-superseded-capacity | wrong-attempt-superseded-capacity | \
        rerun-superseded-capacity | older-success-capacity | \
        earlier-id-success-capacity | different-sha-success-capacity | \
        superseded-deploy)
        count=0
        ;;
    esac
    if [[ "$STUB_MODE" == "jobs-superseded-capacity" ]]; then
      count=1
    fi
    local jobs='[{"id":1}]'
    if [[ "$count" == "0" ]]; then
      jobs='[]'
    fi
    printf '%s\n' "{\"total_count\":$count,\"jobs\":$jobs}"
  elif [[ "$1" == "api" && "$2" == *"/actions/runs/$RUN_ID/pending_deployments"* ]]; then
    if [[ "$STUB_MODE" == "pending-disabled" || "$STUB_MODE" == "pending-superseded-capacity" ]]; then
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
export RUN_ID WORKFLOW_ID MASTER_SHA OLD_SHA

REPO=example/repo NOW_EPOCH=2000 "$EXCLUSIVITY" >/dev/null
REPO=example/repo NOW_EPOCH=2000 STUB_MODE=pr-validation \
  "$EXCLUSIVITY" >/dev/null
REPO=example/repo NOW_EPOCH=2000 STUB_MODE=stale-disabled \
  "$EXCLUSIVITY" >/dev/null
REPO=example/repo NOW_EPOCH=2000 STUB_MODE=active EXCLUDE_RUN_ID=$RUN_ID \
  "$EXCLUSIVITY" >/dev/null
REPO=example/repo NOW_EPOCH=2000 STUB_MODE=superseded-capacity \
  "$EXCLUSIVITY" >/dev/null

for mode in active data-active activation-active disable-active recent-disabled \
  pending-disabled jobs-disabled overflow unsuperseded-capacity \
  current-superseded-capacity recent-superseded-capacity \
  pending-superseded-capacity jobs-superseded-capacity \
  wrong-attempt-superseded-capacity rerun-superseded-capacity \
  older-success-capacity earlier-id-success-capacity \
  different-sha-success-capacity superseded-deploy
do
  if REPO=example/repo NOW_EPOCH=2000 STUB_MODE="$mode" \
    "$EXCLUSIVITY" >/dev/null 2>&1; then
    echo "production exclusivity accepted unsafe mode=$mode" >&2
    exit 1
  fi
done

echo "production_run_exclusivity_tests=PASS"
