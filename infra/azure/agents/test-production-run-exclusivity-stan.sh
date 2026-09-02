#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXCLUSIVITY="$ROOT_DIR/infra/azure/agents/production-run-exclusivity-stan.sh"
RUN_ID=123
WORKFLOW_ID=456
MASTER_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
OLD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PROSPECTIVE_SHA=dddddddddddddddddddddddddddddddddddddddd
WRONG_FINAL_SHA=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
PROMOTION_PR=224
REPOSITORY=example/repo

run_path() {
  case "${STUB_MODE:-none}" in
    *unmaterialized-unsupported*|*superseded-deploy*)
      printf '%s\n' ".github/workflows/oci-production-deploy.yml"
      ;;
    *data*)
      printf '%s\n' ".github/workflows/oci-live-data-rollout.yml"
      ;;
    *activation*)
      printf '%s\n' ".github/workflows/oci-live-betting-activate.yml"
      ;;
    *capacity*)
      printf '%s\n' ".github/workflows/oci-capacity-acquire.yml"
      ;;
    disable-active)
      printf '%s\n' ".github/workflows/oci-live-betting-disable.yml"
      ;;
    ghcr-package-active)
      printf '%s\n' ".github/workflows/ghcr-package-management.yml"
      ;;
    cache-recovery-active)
      printf '%s\n' ".github/workflows/oci-ghcr-cache-recovery.yml"
      ;;
    *)
      printf '%s\n' ".github/workflows/production-build.yml"
      ;;
  esac
}

run_status() {
  case "${STUB_MODE:-none}" in
    in-progress-unmaterialized-data)
      printf '%s\n' in_progress
      ;;
    prospective-*|*superseded*|*unmaterialized*)
      printf '%s\n' queued
      ;;
    *)
      printf '%s\n' in_progress
      ;;
  esac
}

run_event() {
  case "${STUB_MODE:-none}" in
    wrong-event-unmaterialized-data)
      printf '%s\n' push
      ;;
    prospective-*|*superseded*|*unmaterialized*)
      printf '%s\n' workflow_dispatch
      ;;
    *)
      printf '%s\n' push
      ;;
  esac
}

run_attempt() {
  if [[ "${STUB_MODE:-none}" == wrong-attempt-* ]]; then
    printf '%s\n' 2
  else
    printf '%s\n' 1
  fi
}

run_head() {
  case "${STUB_MODE:-none}" in
    current-unmaterialized-*|current-superseded-*|prospective-*)
      printf '%s\n' "$MASTER_SHA"
      ;;
    *)
      printf '%s\n' "$OLD_SHA"
      ;;
  esac
}

run_title() {
  local path
  path="$(run_path)"
  case "${STUB_MODE:-none}" in
    rendered-title-unmaterialized-data|prospective-rendered-title-data)
      printf 'oci-live-data apply-backfills %s\n' "$OLD_SHA"
      ;;
    rendered-title-unmaterialized-activation)
      printf 'oci-live-activate %s\n' "$OLD_SHA"
      ;;
    rendered-title-unmaterialized-capacity)
      printf 'oci-capacity-acquire %s\n' "$OLD_SHA"
      ;;
    *)
      case "$path" in
        .github/workflows/oci-live-data-rollout.yml)
          printf '%s\n' oci-live-data-rollout
          ;;
        .github/workflows/oci-live-betting-activate.yml)
          printf '%s\n' oci-live-betting-activate
          ;;
        .github/workflows/oci-capacity-acquire.yml)
          printf '%s\n' oci-capacity-acquire
          ;;
        *)
          printf '%s\n' "${path##*/}"
          ;;
      esac
      ;;
  esac
}

workflow_state() {
  case "${STUB_MODE:-none}" in
    active-unmaterialized-data)
      printf '%s\n' active
      ;;
    inactive-workflow-unmaterialized-data)
      printf '%s\n' disabled_inactivity
      ;;
    stale-disabled|*unmaterialized*)
      printf '%s\n' disabled_manually
      ;;
    *)
      printf '%s\n' active
      ;;
  esac
}

historical_source() {
  local path="$1"
  local source
  case "$path" in
    .github/workflows/oci-live-data-rollout.yml)
      source="$(cat <<'EOF'
name: oci-live-data-rollout
run-name: oci-live-data ${{ inputs.phase }} ${{ inputs.approved_sha }}
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
          ./infra/oci/scripts/authorize-github-runner.sh cleanup-stale
          ./infra/oci/scripts/authorize-github-runner.sh authorize
          ./infra/oci/scripts/configure-k3s-access.sh open
          ./infra/azure/agents/shared-mongo-operation-lock-stan.sh acquire
          ./infra/oci/scripts/live-data-maintenance-stan.sh enter
          ./infra/oci/scripts/live-data-maintenance-stan.sh hold
          ./infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh
          ./infra/oci/scripts/live-betting-data-rollout-stan.sh
          ./infra/oci/scripts/live-data-maintenance-stan.sh restore
          ./infra/azure/agents/shared-mongo-operation-lock-stan.sh renew
          ./infra/azure/agents/shared-mongo-operation-lock-stan.sh release
          ./infra/oci/scripts/revoke-github-runner.sh
          ./infra/oci/scripts/configure-k3s-access.sh cleanup
EOF
)"
      ;;
    .github/workflows/oci-live-betting-activate.yml)
      source="$(cat <<'EOF'
name: oci-live-betting-activate
run-name: oci-live-activate ${{ inputs.approved_sha }}
concurrency:
  group: oci-control-plane
  cancel-in-progress: false
jobs:
  activate-and-validate:
    environment:
      name: oci-production
    steps:
      - run: |
          [ "$SOURCE_SHA" = "$GITHUB_SHA" ]
          git fetch --quiet origin master:refs/remotes/origin/master
          [ "$SOURCE_SHA" = "$(git rev-parse origin/master)" ]
          ./infra/oci/scripts/authorize-github-runner.sh cleanup-stale
          ./infra/oci/scripts/authorize-github-runner.sh authorize
          ./infra/oci/scripts/configure-k3s-access.sh open
          kubectl exec -n "$OCI_K8S_NAMESPACE"
          node dist/scripts/SetUserRole.js
          curl --fail-with-body
          ./client/node_modules/.bin/playwright test
      - run: ./infra/oci/scripts/live-betting-control-stan.sh
          ./infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh
          ./infra/oci/scripts/revoke-github-runner.sh
          ./infra/oci/scripts/configure-k3s-access.sh cleanup
EOF
)"
      ;;
    .github/workflows/oci-capacity-acquire.yml)
      source="$(cat <<'EOF'
name: oci-capacity-acquire
run-name: oci-capacity-acquire ${{ inputs.approved_sha || 'scheduled-master' }}
concurrency:
  group: oci-control-plane
  cancel-in-progress: false
jobs:
  acquire:
    environment:
      name: oci-capacity-acquire
    steps:
      - run: |
          [ "$SOURCE_SHA" = "$GITHUB_SHA" ]
          git fetch --quiet origin master:refs/remotes/origin/master
          [ "$SOURCE_SHA" = "$(git rev-parse origin/master)" ]
          ./infra/oci/scripts/acquire-a1.sh
EOF
)"
      ;;
    *)
      return 1
      ;;
  esac

  HISTORICAL_SOURCE="$source" python3 - "${STUB_MODE:-none}" <<'PY'
import os
import sys

mode = sys.argv[1]
source = os.environ["HISTORICAL_SOURCE"]
if mode in {
    "missing-guards-unmaterialized-data",
    "unfenced-superseded-data",
}:
    source = source.replace(
        '          [ "$SOURCE_SHA" = "$(git rev-parse origin/master)" ]',
        "",
        1,
    )
elif mode == "mutation-before-guard-unmaterialized-data":
    guard = '          [ "$SOURCE_SHA" = "$GITHUB_SHA" ]'
    source = source.replace(
        guard,
        "          ./infra/azure/agents/"
        "shared-mongo-operation-lock-stan.sh acquire\n"
        + guard,
        1,
    )
elif mode == "wrong-environment-unmaterialized-data":
    source = source.replace("name: oci-migration", "name: oci-production", 1)
elif mode == "wrong-concurrency-unmaterialized-data":
    source = source.replace(
        "group: oci-control-plane",
        "group: another-control-plane",
        1,
    )
elif mode == "multi-job-unmaterialized-data":
    source += "\n  another-job:\n    environment:\n      name: oci-migration\n"
print(source, end="")
PY
}

emit_historical_workflow() {
  local path="$1"
  local source
  source="$(historical_source "$path")"
  HISTORICAL_SOURCE="$source" python3 - "$path" <<'PY'
import base64
import hashlib
import json
import os
import sys

path = sys.argv[1]
source = os.environ["HISTORICAL_SOURCE"].encode("utf-8")
print(json.dumps({
    "type": "file",
    "path": path,
    "encoding": "base64",
    "size": len(source),
    "sha": hashlib.sha1(
        f"blob {len(source)}\0".encode("utf-8") + source
    ).hexdigest(),
    "content": base64.b64encode(source).decode("ascii"),
}, separators=(",", ":")))
PY
}

emit_inventory() {
  local path status event attempt head branch updated
  path="$(run_path)"
  status="$(run_status)"
  event="$(run_event)"
  attempt="$(run_attempt)"
  head="$(run_head)"
  branch=master
  updated=1970-01-01T00:00:00Z
  if [[ "${STUB_MODE:-none}" == pr-validation ]]; then
    branch=dev
  elif [[ "${STUB_MODE:-none}" == recent-* ]]; then
    updated=1970-01-01T00:31:40Z
  elif [[ "${STUB_MODE:-none}" == touched-timestamps-unmaterialized-data ]]; then
    updated=1970-01-01T00:00:01Z
  fi
  printf '{"total_count":1,"workflow_runs":[{"id":%s,"workflow_id":%s,"path":"%s","head_branch":"%s","head_sha":"%s","event":"%s","run_attempt":%s,"status":"%s","updated_at":"%s"}]}\n' \
    "$RUN_ID" "$WORKFLOW_ID" "$path" "$branch" "$head" "$event" \
    "$attempt" "$status" "$updated"
}

emit_other_active_inventory() {
  printf '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":457,"path":".github/workflows/production-build.yml","head_branch":"master","head_sha":"%s","event":"push","run_attempt":1,"status":"in_progress","updated_at":"1970-01-01T00:00:00Z"}]}\n' \
    "$MASTER_SHA"
}

emit_prospective_promotion() {
  local requested_number="$1"
  local mode="${STUB_MODE:-none}"
  local number="$PROMOTION_PR"
  local state=OPEN
  local base_ref=master
  local base_sha="$MASTER_SHA"
  local head_ref=dev
  local head_repository="$REPOSITORY"
  local labels='[{"name":"copilot-cli-managed"}]'

  [[ "$requested_number" == "$PROMOTION_PR" ]] || {
    echo "prospective promotion did not request the expected PR" >&2
    return 1
  }
  case "$mode" in
    prospective-missing-data)
      return 1
      ;;
    prospective-unlabelled-data)
      labels='[]'
      ;;
    prospective-wrong-repository-data)
      head_repository=another/repository
      ;;
    prospective-wrong-base-data)
      base_ref=dev
      ;;
    prospective-wrong-head-data)
      head_ref=feature/recovery
      ;;
    prospective-stale-data)
      base_sha="$OLD_SHA"
      ;;
    prospective-closed-data)
      state=CLOSED
      ;;
    prospective-wrong-number-data)
      number=$((PROMOTION_PR + 1))
      ;;
  esac
  printf '{"number":%s,"state":"%s","headRefName":"%s","headRefOid":"%s","headRepository":{"nameWithOwner":"%s"},"baseRefName":"%s","baseRefOid":"%s","labels":%s}\n' \
    "$number" "$state" "$head_ref" "$PROSPECTIVE_SHA" "$head_repository" \
    "$base_ref" "$base_sha" "$labels"
}

emit_full_run() {
  local path status event attempt head title created updated response_run_id
  path="$(run_path)"
  status="$(run_status)"
  event="$(run_event)"
  attempt="$(run_attempt)"
  head="$(run_head)"
  title="$(run_title)"
  response_run_id="$RUN_ID"
  if [[ "${STUB_MODE:-none}" == inventory-mismatch-unmaterialized-data ]]; then
    response_run_id=$((RUN_ID + 1))
  fi
  created=1970-01-01T00:00:00Z
  updated="$created"
  if [[ "${STUB_MODE:-none}" == recent-* ]]; then
    created=1970-01-01T00:31:40Z
    updated="$created"
  elif [[ "${STUB_MODE:-none}" == touched-timestamps-unmaterialized-data ]]; then
    updated=1970-01-01T00:00:01Z
  fi
  if [[ "${STUB_MODE:-none}" == nonnull-conclusion-unmaterialized-data ]]; then
    printf '{"id":%s,"workflow_id":%s,"path":"%s","display_title":"%s","event":"%s","head_sha":"%s","head_branch":"master","head_repository":{"full_name":"%s"},"run_attempt":%s,"status":"%s","conclusion":"cancelled","created_at":"%s","run_started_at":"%s","updated_at":"%s","html_url":"https://github.com/%s/actions/runs/%s"}\n' \
      "$response_run_id" "$WORKFLOW_ID" "$path" "$title" "$event" "$head" \
      "$REPOSITORY" "$attempt" "$status" "$created" "$created" "$updated" \
      "$REPOSITORY" "$response_run_id"
  elif [[ "${STUB_MODE:-none}" == missing-timestamp-unmaterialized-data ]]; then
    printf '{"id":%s,"workflow_id":%s,"path":"%s","display_title":"%s","event":"%s","head_sha":"%s","head_branch":"master","head_repository":{"full_name":"%s"},"run_attempt":%s,"status":"%s","conclusion":null,"created_at":"%s","updated_at":"%s","html_url":"https://github.com/%s/actions/runs/%s"}\n' \
      "$response_run_id" "$WORKFLOW_ID" "$path" "$title" "$event" "$head" \
      "$REPOSITORY" "$attempt" "$status" "$created" "$updated" \
      "$REPOSITORY" "$response_run_id"
  else
    printf '{"id":%s,"workflow_id":%s,"path":"%s","display_title":"%s","event":"%s","head_sha":"%s","head_branch":"master","head_repository":{"full_name":"%s"},"run_attempt":%s,"status":"%s","conclusion":null,"created_at":"%s","run_started_at":"%s","updated_at":"%s","html_url":"https://github.com/%s/actions/runs/%s"}\n' \
      "$response_run_id" "$WORKFLOW_ID" "$path" "$title" "$event" "$head" \
      "$REPOSITORY" "$attempt" "$status" "$created" "$created" "$updated" \
      "$REPOSITORY" "$response_run_id"
  fi
}

emit_successful_runs() {
  local path
  path="$(run_path)"
  case "${STUB_MODE:-none}" in
    superseded-capacity|current-superseded-capacity|\
    recent-superseded-capacity|pending-superseded-capacity|\
    jobs-superseded-capacity|wrong-attempt-superseded-capacity)
      printf '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:32:30Z","display_title":"oci-capacity-acquire %s"}]}\n' \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA"
      ;;
    rerun-superseded-capacity)
      printf '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":2,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:32:30Z","display_title":"oci-capacity-acquire %s"}]}\n' \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA"
      ;;
    older-success-capacity)
      printf '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1969-12-31T23:59:59Z","display_title":"oci-capacity-acquire %s"}]}\n' \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA"
      ;;
    earlier-id-success-capacity)
      printf '{"total_count":1,"workflow_runs":[{"id":122,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:32:30Z","display_title":"oci-capacity-acquire %s"}]}\n' \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA"
      ;;
    different-sha-success-capacity)
      printf '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:32:30Z","display_title":"oci-capacity-acquire %s"}]}\n' \
        "$WORKFLOW_ID" "$path" "$MASTER_SHA" "$MASTER_SHA"
      ;;
    superseded-data|unfenced-superseded-data|nonancestor-superseded-data)
      printf '{"total_count":3,"workflow_runs":[{"id":124,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:32:30Z","display_title":"oci-live-data dry-run %s"},{"id":125,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:33:30Z","display_title":"oci-live-data apply-backfills %s"},{"id":126,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:34:30Z","display_title":"oci-live-data apply-slip-index %s"}]}\n' \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA" \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA" \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA"
      ;;
    partial-superseded-data)
      printf '{"total_count":2,"workflow_runs":[{"id":124,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:32:30Z","display_title":"oci-live-data dry-run %s"},{"id":125,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:33:30Z","display_title":"oci-live-data apply-backfills %s"}]}\n' \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA" \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA"
      ;;
    superseded-activation)
      printf '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:32:30Z","display_title":"oci-live-activate %s"}]}\n' \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA"
      ;;
    *)
      printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
      ;;
  esac
}

gh() {
  if [[ "$1 $2" == "pr view" ]]; then
    emit_prospective_promotion "$3"
    return
  fi
  if [[ "$1" != api ]]; then
    echo "unexpected gh invocation: $*" >&2
    return 1
  fi
  local endpoint="$2"
  local mode="${STUB_MODE:-none}"

  if [[ "$endpoint" == *"/actions/runs?status="* ]]; then
    if [[
      "$mode" == prospective-other-active-data &&
        "$endpoint" == *"status=in_progress"*
    ]]; then
      emit_other_active_inventory
      return
    fi
    case "$mode" in
      none)
        printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
        ;;
      overflow)
        if [[ "$endpoint" == *"status=in_progress"* ]]; then
          printf '%s\n' '{"total_count":101,"workflow_runs":[]}'
        else
          printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
        fi
        ;;
      missing-runs)
        if [[ "$endpoint" == *"status=in_progress"* ]]; then
          printf '%s\n' '{"total_count":0}'
        else
          printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
        fi
        ;;
      count-mismatch)
        if [[ "$endpoint" == *"status=in_progress"* ]]; then
          printf '%s\n' '{"total_count":1,"workflow_runs":[]}'
        else
          printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
        fi
        ;;
      non-array-runs)
        if [[ "$endpoint" == *"status=in_progress"* ]]; then
          printf '%s\n' '{"total_count":0,"workflow_runs":{}}'
        else
          printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
        fi
        ;;
      *)
        if [[ "$endpoint" == *"status=$(run_status)"* ]]; then
          emit_inventory
        else
          printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
        fi
        ;;
    esac
    return
  fi

  if [[ "$mode" == prospective-other-active-data ]]; then
    case "$endpoint" in
      "repos/$REPOSITORY/actions/workflows/457")
        printf '%s\n' \
          '{"id":457,"state":"active","path":".github/workflows/production-build.yml"}'
        return
        ;;
      "repos/$REPOSITORY/actions/runs/124/jobs?per_page=1")
        printf '%s\n' '{"total_count":1,"jobs":[{"id":1}]}'
        return
        ;;
      "repos/$REPOSITORY/actions/runs/124/pending_deployments")
        printf '%s\n' '[]'
        return
        ;;
    esac
  fi

  if [[ "$endpoint" == "repos/$REPOSITORY/compare/$MASTER_SHA...$PROSPECTIVE_SHA" ]]; then
    case "$mode" in
      prospective-nonancestor-data)
        printf '{"status":"diverged","ahead_by":1,"behind_by":1,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
          "$MASTER_SHA" "$OLD_SHA" "$PROSPECTIVE_SHA"
        ;;
      prospective-malformed-compare-data)
        printf '%s\n' '{"status":"ahead","ahead_by":"1"}'
        ;;
      prospective-wrong-final-compare-data)
        printf '{"status":"ahead","ahead_by":1,"behind_by":0,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
          "$MASTER_SHA" "$MASTER_SHA" "$WRONG_FINAL_SHA"
        ;;
      *)
        printf '{"status":"ahead","ahead_by":1,"behind_by":0,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
          "$MASTER_SHA" "$MASTER_SHA" "$PROSPECTIVE_SHA"
        ;;
    esac
    return
  fi

  case "$endpoint" in
    "repos/$REPOSITORY/actions/workflows/$WORKFLOW_ID/runs?head_sha="*)
      [[ "$endpoint" == *"event=workflow_dispatch"* ]] || {
        echo "successful-run proof was not limited to manual dispatches" >&2
        return 1
      }
      emit_successful_runs
      ;;
    "repos/$REPOSITORY/actions/workflows/$WORKFLOW_ID")
      printf '{"id":%s,"state":"%s","path":"%s"}\n' \
        "$WORKFLOW_ID" "$(workflow_state)" "$(run_path)"
      ;;
    "repos/$REPOSITORY/actions/runs/$RUN_ID/jobs?per_page=1")
      case "$mode" in
        jobs-unmaterialized-data|jobs-superseded-capacity)
          printf '%s\n' '{"total_count":1,"jobs":[{"id":1}]}'
          ;;
        jobs-count-mismatch-unmaterialized-data)
          printf '%s\n' '{"total_count":0,"jobs":[{"id":1}]}'
          ;;
        stale-disabled|*superseded*|*unmaterialized*)
          printf '%s\n' '{"total_count":0,"jobs":[]}'
          ;;
        *)
          printf '%s\n' '{"total_count":1,"jobs":[{"id":1}]}'
          ;;
      esac
      ;;
    "repos/$REPOSITORY/actions/runs/$RUN_ID/pending_deployments")
      if [[ "$mode" == pending-*-unmaterialized-* || "$mode" == pending-superseded-capacity ]]; then
        printf '%s\n' '[{"environment":{"id":1,"name":"oci-production"}}]'
      else
        printf '%s\n' '[]'
      fi
      ;;
    "repos/$REPOSITORY/actions/runs/$RUN_ID/artifacts?per_page=1")
      case "$mode" in
        artifacts-unmaterialized-data)
          printf '%s\n' '{"total_count":1,"artifacts":[{"id":1}]}'
          ;;
        artifacts-count-mismatch-unmaterialized-data)
          printf '%s\n' '{"total_count":0,"artifacts":[{"id":1}]}'
          ;;
        *)
          printf '%s\n' '{"total_count":0,"artifacts":[]}'
          ;;
      esac
      ;;
    "repos/$REPOSITORY/actions/runs/$RUN_ID")
      emit_full_run
      ;;
    "repos/$REPOSITORY/git/ref/heads/master")
      printf '{"object":{"sha":"%s"}}\n' "$MASTER_SHA"
      ;;
    "repos/$REPOSITORY/compare/"*)
      case "$mode" in
        nonancestor-*|nonancestor-superseded-data)
          printf '{"status":"diverged","ahead_by":1,"behind_by":1,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"cccccccccccccccccccccccccccccccccccccccc"},"commits":[{"sha":"%s"}]}\n' \
            "$OLD_SHA" "$MASTER_SHA"
          ;;
        missing-compare-unmaterialized-data)
          printf '%s\n' '{}'
          ;;
        malformed-compare-unmaterialized-data)
          printf '{"status":"ahead","ahead_by":"1","behind_by":0,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
            "$OLD_SHA" "$OLD_SHA" "$MASTER_SHA"
          ;;
        incomplete-compare-unmaterialized-data)
          printf '{"status":"ahead","ahead_by":2,"behind_by":0,"total_commits":2,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
            "$OLD_SHA" "$OLD_SHA" "$MASTER_SHA"
          ;;
        wrong-final-compare-unmaterialized-data)
          printf '{"status":"ahead","ahead_by":1,"behind_by":0,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
            "$OLD_SHA" "$OLD_SHA" "$WRONG_FINAL_SHA"
          ;;
        *)
          printf '{"status":"ahead","ahead_by":1,"behind_by":0,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
            "$OLD_SHA" "$OLD_SHA" "$MASTER_SHA"
          ;;
      esac
      ;;
    "repos/$REPOSITORY/contents/.github/workflows/"*"?ref="*)
      if [[ "$mode" == malformed-historical-unmaterialized-data ]]; then
        printf '%s\n' '{"type":"file","path":".github/workflows/oci-live-data-rollout.yml","encoding":"base64","size":1,"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","content":"!"}'
      else
        emit_historical_workflow "$(run_path)"
      fi
      ;;
    *)
      echo "unexpected gh invocation: $*" >&2
      return 1
      ;;
  esac
}
export -f \
  gh run_path run_status run_event run_attempt run_head run_title workflow_state \
  historical_source emit_historical_workflow emit_inventory emit_full_run \
  emit_successful_runs emit_other_active_inventory emit_prospective_promotion
export \
  ROOT_DIR EXCLUSIVITY RUN_ID WORKFLOW_ID MASTER_SHA OLD_SHA PROSPECTIVE_SHA \
  WRONG_FINAL_SHA \
  PROMOTION_PR REPOSITORY

run_case() {
  REPO="$REPOSITORY" NOW_EPOCH=2000 STUB_MODE="$1" \
    PROSPECTIVE_PROMOTION_PR="" "$EXCLUSIVITY"
}

run_prospective_case() {
  REPO="$REPOSITORY" NOW_EPOCH=2000 STUB_MODE="$1" \
    PROSPECTIVE_PROMOTION_PR="$PROMOTION_PR" "$EXCLUSIVITY"
}

expect_rejected() {
  local mode="$1"
  if run_case "$mode" >/dev/null 2>&1; then
    echo "production exclusivity accepted unsafe mode=$mode" >&2
    exit 1
  fi
}

expect_prospective_rejected() {
  local mode="$1"
  if run_prospective_case "$mode" >/dev/null 2>&1; then
    echo "prospective promotion accepted unsafe mode=$mode" >&2
    exit 1
  fi
}

run_case none >/dev/null
run_case pr-validation >/dev/null
run_case stale-disabled >/dev/null
REPO="$REPOSITORY" NOW_EPOCH=2000 STUB_MODE=active EXCLUDE_RUN_ID="$RUN_ID" \
  "$EXCLUSIVITY" >/dev/null

for mode in superseded-capacity superseded-data superseded-activation; do
  output="$(run_case "$mode")"
  grep -qF 'reason=superseded' <<<"$output" || {
    echo "supersession classifier did not retain reason=superseded mode=$mode" >&2
    exit 1
  }
done

for mode in \
  unmaterialized-data \
  active-unmaterialized-data \
  unmaterialized-activation \
  unmaterialized-capacity; do
  output="$(run_case "$mode")"
  grep -qF 'reason=unmaterialized' <<<"$output" || {
    echo "unmaterialized classifier did not retain its distinct reason mode=$mode" >&2
    exit 1
  }
done

prospective_output="$(
  run_prospective_case prospective-unmaterialized-data
)"
for expected in \
  'reason=unmaterialized' \
  'prospective_unmaterialized=yes' \
  "prospective_promotion_pr=$PROMOTION_PR" \
  "actual_master_sha=$MASTER_SHA" \
  "prospective_master_sha=$PROSPECTIVE_SHA"; do
  grep -qF "$expected" <<<"$prospective_output" || {
    echo "prospective bootstrap omitted auditable evidence: $expected" >&2
    exit 1
  }
done

ordinary_output="$(run_prospective_case unmaterialized-data)"
if grep -qF 'prospective_unmaterialized=yes' <<<"$ordinary_output"; then
  echo "prospective context altered an already historical ghost" >&2
  exit 1
fi

for mode in \
  prospective-missing-data \
  prospective-unlabelled-data \
  prospective-wrong-repository-data \
  prospective-wrong-base-data \
  prospective-wrong-head-data \
  prospective-stale-data \
  prospective-closed-data \
  prospective-wrong-number-data \
  prospective-nonancestor-data \
  prospective-malformed-compare-data \
  prospective-wrong-final-compare-data \
  prospective-rendered-title-data \
  prospective-other-active-data; do
  expect_prospective_rejected "$mode"
done

if REPO="$REPOSITORY" NOW_EPOCH=2000 \
  STUB_MODE=current-unmaterialized-data \
  PROSPECTIVE_PROMOTION_PR="" \
  PROSPECTIVE_MASTER_SHA="$PROSPECTIVE_SHA" \
  "$EXCLUSIVITY" >/dev/null 2>&1; then
  echo "raw prospective SHA unexpectedly bypassed a current-master ghost" >&2
  exit 1
fi

if REPO="$REPOSITORY" NOW_EPOCH=2000 \
  STUB_MODE=prospective-unmaterialized-data \
  PROSPECTIVE_PROMOTION_PR="$PROMOTION_PR" \
  EXCLUDE_RUN_ID="$RUN_ID" \
  "$EXCLUSIVITY" >/dev/null 2>&1; then
  echo "prospective bootstrap unexpectedly accepted EXCLUDE_RUN_ID" >&2
  exit 1
fi

for mode in \
  active data-active activation-active disable-active ghcr-package-active \
  cache-recovery-active overflow missing-runs count-mismatch non-array-runs \
  current-superseded-capacity \
  recent-superseded-capacity pending-superseded-capacity \
  jobs-superseded-capacity wrong-attempt-superseded-capacity \
  superseded-deploy \
  unfenced-superseded-data nonancestor-superseded-data \
  current-unmaterialized-data \
  rendered-title-unmaterialized-data \
  rendered-title-unmaterialized-activation \
  rendered-title-unmaterialized-capacity \
  touched-timestamps-unmaterialized-data \
  missing-timestamp-unmaterialized-data \
  nonnull-conclusion-unmaterialized-data \
  wrong-event-unmaterialized-data \
  wrong-attempt-unmaterialized-data \
  in-progress-unmaterialized-data \
  inventory-mismatch-unmaterialized-data \
  jobs-unmaterialized-data \
  jobs-count-mismatch-unmaterialized-data \
  pending-deployment-unmaterialized-data \
  artifacts-unmaterialized-data \
  artifacts-count-mismatch-unmaterialized-data \
  recent-unmaterialized-data \
  nonancestor-unmaterialized-data \
  missing-compare-unmaterialized-data \
  malformed-compare-unmaterialized-data \
  incomplete-compare-unmaterialized-data \
  wrong-final-compare-unmaterialized-data \
  malformed-historical-unmaterialized-data \
  missing-guards-unmaterialized-data \
  mutation-before-guard-unmaterialized-data \
  wrong-environment-unmaterialized-data \
  wrong-concurrency-unmaterialized-data \
  multi-job-unmaterialized-data \
  inactive-workflow-unmaterialized-data \
  unmaterialized-unsupported
do
  expect_rejected "$mode"
done

echo "production_run_exclusivity_tests=PASS"
