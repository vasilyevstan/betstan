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
    if [[ "$mode" == "missing-runs" && "$2" == *"status=in_progress"* ]]; then
      printf '%s\n' '{"total_count":0}'
      return
    fi
    if [[ "$mode" == "count-mismatch" && "$2" == *"status=in_progress"* ]]; then
      printf '%s\n' '{"total_count":1,"workflow_runs":[]}'
      return
    fi
    if [[ "$mode" == "non-array-runs" && "$2" == *"status=in_progress"* ]]; then
      printf '%s\n' '{"total_count":0,"workflow_runs":{}}'
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
    local display_title=production-build
    if [[ "$mode" == "data-active" ]]; then
      path=.github/workflows/oci-live-data-rollout.yml
      display_title=oci-live-data-rollout
    elif [[ "$mode" == "activation-active" ]]; then
      path=.github/workflows/oci-live-betting-activate.yml
      display_title=oci-live-betting-activate
    elif [[ "$mode" == "disable-active" ]]; then
      path=.github/workflows/oci-live-betting-disable.yml
      display_title=oci-live-betting-disable
    elif [[ "$mode" == "ghcr-package-active" ]]; then
      path=.github/workflows/ghcr-package-management.yml
      display_title=ghcr-package-management
    elif [[ "$mode" == "cache-recovery-active" ]]; then
      path=.github/workflows/oci-ghcr-cache-recovery.yml
      display_title=oci-ghcr-cache-recovery
    elif [[ "$mode" == "superseded-deploy" ]]; then
      path=.github/workflows/oci-production-deploy.yml
      run_status=queued
      event=workflow_dispatch
      display_title=oci-production-deploy
    elif [[ "$mode" == *superseded-data || "$mode" == "unsuperseded-data" ]]; then
      path=.github/workflows/oci-live-data-rollout.yml
      run_status=queued
      event=workflow_dispatch
      display_title=oci-live-data-rollout
    elif [[ "$mode" == *superseded-activation || "$mode" == "unsuperseded-activation" ]]; then
      path=.github/workflows/oci-live-betting-activate.yml
      run_status=queued
      event=workflow_dispatch
      display_title=oci-live-betting-activate
    elif [[ "$mode" == *capacity* ]]; then
      path=.github/workflows/oci-capacity-acquire.yml
      run_status=queued
      event=workflow_dispatch
      display_title=oci-capacity-acquire
    fi
    if [[ "$mode" == current-superseded-* ]]; then
      head_sha="$MASTER_SHA"
    fi
    if [[ "$mode" == wrong-attempt-superseded-* ]]; then
      run_attempt=2
    fi
    if [[ "$2" != *"status=$run_status"* ]]; then
      printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
      return
    fi
    printf '%s\n' \
      "{\"total_count\":1,\"workflow_runs\":[{\"id\":$RUN_ID,\"workflow_id\":$WORKFLOW_ID,\"path\":\"$path\",\"head_branch\":\"$branch\",\"head_sha\":\"$head_sha\",\"event\":\"$event\",\"run_attempt\":$run_attempt,\"status\":\"$run_status\",\"updated_at\":\"$updated_at\",\"display_title\":\"$display_title\"}]}"
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
      superseded-data | unfenced-superseded-data | nonancestor-superseded-data)
        printf '%s\n' \
          "{\"total_count\":3,\"workflow_runs\":[
            {\"id\":124,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-live-data-rollout.yml\",\"head_branch\":\"master\",\"head_sha\":\"$OLD_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:32:30Z\",\"display_title\":\"oci-live-data dry-run $OLD_SHA\"},
            {\"id\":125,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-live-data-rollout.yml\",\"head_branch\":\"master\",\"head_sha\":\"$OLD_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:33:30Z\",\"display_title\":\"oci-live-data apply-backfills $OLD_SHA\"},
            {\"id\":126,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-live-data-rollout.yml\",\"head_branch\":\"master\",\"head_sha\":\"$OLD_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:34:30Z\",\"display_title\":\"oci-live-data apply-slip-index $OLD_SHA\"}
          ]}"
        ;;
      partial-superseded-data)
        printf '%s\n' \
          "{\"total_count\":2,\"workflow_runs\":[
            {\"id\":124,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-live-data-rollout.yml\",\"head_branch\":\"master\",\"head_sha\":\"$OLD_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:32:30Z\",\"display_title\":\"oci-live-data dry-run $OLD_SHA\"},
            {\"id\":125,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-live-data-rollout.yml\",\"head_branch\":\"master\",\"head_sha\":\"$OLD_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:33:30Z\",\"display_title\":\"oci-live-data apply-backfills $OLD_SHA\"}
          ]}"
        ;;
      superseded-activation)
        printf '%s\n' \
          "{\"total_count\":1,\"workflow_runs\":[{\"id\":124,\"workflow_id\":$WORKFLOW_ID,\"path\":\".github/workflows/oci-live-betting-activate.yml\",\"head_branch\":\"master\",\"head_sha\":\"$OLD_SHA\",\"event\":\"workflow_dispatch\",\"run_attempt\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"created_at\":\"1970-01-01T00:32:30Z\",\"display_title\":\"oci-live-activate $OLD_SHA\"}]}"
        ;;
      *)
        printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
        ;;
    esac
  elif [[ "$1" == "api" && "$2" == *"/compare/"* ]]; then
    if [[ "$STUB_MODE" == "nonancestor-superseded-data" ]]; then
      printf '%s\n' \
        "{\"status\":\"diverged\",\"ahead_by\":1,\"base_commit\":{\"sha\":\"$OLD_SHA\"},\"merge_base_commit\":{\"sha\":\"cccccccccccccccccccccccccccccccccccccccc\"}}"
    else
      printf '%s\n' \
        "{\"status\":\"ahead\",\"ahead_by\":1,\"base_commit\":{\"sha\":\"$OLD_SHA\"},\"merge_base_commit\":{\"sha\":\"$OLD_SHA\"}}"
    fi
  elif [[ "$1" == "api" && "$2" == *"/contents/.github/workflows/"* ]]; then
    local path source encoded
    if [[ "$STUB_MODE" == *activation ]]; then
      path=.github/workflows/oci-live-betting-activate.yml
      source='name: oci-live-betting-activate
concurrency:
  group: oci-control-plane
  cancel-in-progress: false
jobs:
  activate:
    environment:
      name: oci-production
    steps:
      - run: |
          [ "$SOURCE_SHA" = "$GITHUB_SHA" ]
          git fetch --quiet origin master:refs/remotes/origin/master
          [ "$SOURCE_SHA" = "$(git rev-parse origin/master)" ]
      - run: ./infra/oci/scripts/live-betting-control-stan.sh'
    else
      path=.github/workflows/oci-live-data-rollout.yml
      source='name: oci-live-data-rollout
concurrency:
  group: oci-control-plane
  cancel-in-progress: false
jobs:
  rollout:
    environment:
      name: oci-migration
    steps:
      - run: |
          [ "$SOURCE_SHA" = "$GITHUB_SHA" ]
          git fetch --quiet origin master:refs/remotes/origin/master
          [ "$SOURCE_SHA" = "$(git rev-parse origin/master)" ]
      - run: ./infra/azure/agents/shared-mongo-operation-lock-stan.sh acquire'
    fi
    if [[ "$STUB_MODE" == "unfenced-superseded-data" ]]; then
      source='name: oci-live-data-rollout
concurrency:
  group: oci-control-plane
  cancel-in-progress: false
jobs:
  rollout:
    environment:
      name: oci-migration
    steps:
      - run: |
          [ "$SOURCE_SHA" = "$GITHUB_SHA" ]
          git fetch --quiet origin master:refs/remotes/origin/master
      - run: ./infra/azure/agents/shared-mongo-operation-lock-stan.sh acquire'
    fi
    encoded="$(printf '%s' "$source" | base64 | tr -d '\n')"
    printf '%s\n' \
      "{\"path\":\"$path\",\"encoding\":\"base64\",\"content\":\"$encoded\"}"
  elif [[ "$1" == "api" && "$2" == *"/git/ref/heads/master" ]]; then
    printf '%s\n' "{\"object\":{\"sha\":\"$MASTER_SHA\"}}"
  elif [[ "$1" == "api" && "$2" == *"/actions/workflows/$WORKFLOW_ID"* ]]; then
    local state=active
    if [[ "$STUB_MODE" == *disabled* ]]; then
      state=disabled_manually
    fi
    local path=.github/workflows/production-build.yml
    if [[ "$STUB_MODE" == "data-active" || "$STUB_MODE" == *superseded-data ||
      "$STUB_MODE" == "unsuperseded-data" ]]; then
      path=.github/workflows/oci-live-data-rollout.yml
    elif [[ "$STUB_MODE" == "activation-active" ||
      "$STUB_MODE" == *superseded-activation ||
      "$STUB_MODE" == "unsuperseded-activation" ]]; then
      path=.github/workflows/oci-live-betting-activate.yml
    elif [[ "$STUB_MODE" == "disable-active" ]]; then
      path=.github/workflows/oci-live-betting-disable.yml
    elif [[ "$STUB_MODE" == "ghcr-package-active" ]]; then
      path=.github/workflows/ghcr-package-management.yml
    elif [[ "$STUB_MODE" == "cache-recovery-active" ]]; then
      path=.github/workflows/oci-ghcr-cache-recovery.yml
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
        superseded-deploy | superseded-data | unsuperseded-data | \
        partial-superseded-data | unfenced-superseded-data | \
        nonancestor-superseded-data | superseded-activation | \
        unsuperseded-activation)
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
    if [[ "$STUB_MODE" == "pending-disabled" ||
      "$STUB_MODE" == "pending-superseded-capacity" ]]; then
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
REPO=example/repo NOW_EPOCH=2000 STUB_MODE=superseded-data \
  "$EXCLUSIVITY" >/dev/null
REPO=example/repo NOW_EPOCH=2000 STUB_MODE=superseded-activation \
  "$EXCLUSIVITY" >/dev/null

for mode in active data-active activation-active disable-active ghcr-package-active \
  cache-recovery-active recent-disabled \
  pending-disabled jobs-disabled overflow missing-runs count-mismatch \
  non-array-runs unsuperseded-capacity \
  current-superseded-capacity recent-superseded-capacity \
  pending-superseded-capacity jobs-superseded-capacity \
  wrong-attempt-superseded-capacity rerun-superseded-capacity \
  older-success-capacity earlier-id-success-capacity \
  different-sha-success-capacity superseded-deploy \
  unsuperseded-data partial-superseded-data unfenced-superseded-data \
  nonancestor-superseded-data unsuperseded-activation
do
  if REPO=example/repo NOW_EPOCH=2000 STUB_MODE="$mode" \
    "$EXCLUSIVITY" >/dev/null 2>&1; then
    echo "production exclusivity accepted unsafe mode=$mode" >&2
    exit 1
  fi
done

echo "production_run_exclusivity_tests=PASS"
