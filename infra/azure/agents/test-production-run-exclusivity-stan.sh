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
    active-unmaterialized-data|active-unmaterialized-activation|\
    active-unmaterialized-capacity|prospective-active-unmaterialized-data)
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
  local path status event attempt head branch updated payload
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
  payload="$(printf '{"total_count":1,"workflow_runs":[{"id":%s,"workflow_id":%s,"path":"%s","head_branch":"%s","head_sha":"%s","event":"%s","run_attempt":%s,"status":"%s","updated_at":"%s"}]}\n' \
    "$RUN_ID" "$WORKFLOW_ID" "$path" "$branch" "$head" "$event" \
    "$attempt" "$status" "$updated")"
  payload="$(complete_fixture_identity inventory <<<"$payload")"
  if [[ "${STUB_MODE:-}" = duplicate-unmaterialized-data ]]; then
    python3 -c 'import json,sys; v=json.load(sys.stdin); v["workflow_runs"] *= 2; v["total_count"]=2; print(json.dumps(v))' <<<"$payload"
  elif [[ "${STUB_MODE:-}" = *-filter-unmaterialized-data ]]; then
    python3 -c '
import json,sys
value = json.load(sys.stdin)
kind, field = sys.argv[1].split("-")[:2]
row = {**value["workflow_runs"][0], "id": value["workflow_runs"][0]["id"] + 1}
if kind == "missing":
    row.pop(field)
else:
    row[field] = None
value["workflow_runs"].append(row)
value["total_count"] += 1
print(json.dumps(value))
' "$STUB_MODE" <<<"$payload"
  else
    printf '%s\n' "$payload"
  fi
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

complete_fixture_identity() {
  python3 -c '
import json,sys
form, repository, title, mode = sys.argv[1:]
payload = json.load(sys.stdin)
runs = payload["workflow_runs"] if form == "inventory" else [payload]
for run in runs:
    run["repository"] = {"id": 101, "full_name": repository}
    run.setdefault("head_repository", {"full_name": repository})["id"] = 101
    run["url"] = f"https://api.github.com/repos/{repository}/actions/runs/{run['"'"'id'"'"']}"
    run.setdefault("html_url", f"https://github.com/{repository}/actions/runs/{run['"'"'id'"'"']}")
    if form == "inventory":
        run["display_title"] = title
        run["conclusion"] = None
        run["created_at"] = run["updated_at"] if mode.startswith("recent-") else "1970-01-01T00:00:00Z"
        run["run_started_at"] = run["created_at"]
    if mode == "pr-validation":
        run["head_branch"] = "dev"
print(json.dumps(payload, separators=(",", ":")))
' "$1" "$REPOSITORY" "$(run_title)" "${STUB_MODE:-none}"
}

emit_full_run() {
  emit_run_detail_payload | complete_fixture_identity detail
}

emit_run_detail_payload() {
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

mutate_run_detail() {
  python3 -c '
import json,sys
mode, master = sys.argv[1:]
run = json.load(sys.stdin)
if mode == "relabeled":
    run.update(workflow_id=run["workflow_id"] + 1, path=".github/workflows/oci-production-deploy.yml",
               status="queued", event="workflow_dispatch", head_sha=master)
elif mode == "outside-relabel":
    run["head_branch"] = "master"
elif mode == "non-first-attempt":
    run["run_attempt"] = 2
elif mode == "ambiguous":
    print(json.dumps(run), json.dumps(run)); sys.exit()
elif mode == "duplicate":
    print("{\"id\":" + str(run["id"]) + "," + json.dumps(run)[1:]); sys.exit()
elif mode == "null-body":
    run = None
elif mode == "non-object":
    run = [run]
elif mode.startswith(("missing:", "null:", "mismatch:")):
    kind, key = mode.split(":", 1)
    if kind == "missing":
        run.pop(key)
    elif kind == "null":
        run[key] = None
    elif type(run[key]) is int:
        run[key] += 1
    elif isinstance(run[key], dict):
        run[key] = {"id": 102, "full_name": "another/repo"}
    elif key in ("created_at", "run_started_at", "updated_at"):
        run[key] = "1970-01-01T00:00:01Z"
    elif key == "head_sha":
        run[key] = master
    elif key == "status":
        run[key] = "queued"
    else:
        run[key] = "different"
print(json.dumps(run, separators=(",", ":")))
' "${STUB_DETAIL_DRIFT:-}" "$MASTER_SHA"
}

emit_successful_runs() {
  local path
  path="$(run_path)"
  case "${STUB_MODE:-none}" in
    large-success-history-unmaterialized-data)
      python3 -c 'import json; print(json.dumps({"total_count":101,"workflow_runs":[{}]*100}))'
      ;;
    superseded-capacity|current-superseded-capacity|\
    recent-superseded-capacity|pending-superseded-capacity|\
    jobs-superseded-capacity|wrong-attempt-superseded-capacity|\
    approved-superseded-capacity|artifacts-superseded-capacity|\
    artifacts-count-mismatch-superseded-capacity|\
    malformed-artifacts-superseded-capacity)
      printf '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:32:30Z","display_title":"oci-capacity-acquire %s"}]}\n' \
        "$WORKFLOW_ID" "$path" "$OLD_SHA" "$OLD_SHA"
      ;;
    wrong-title-superseded-capacity)
      printf '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":%s,"path":"%s","head_branch":"master","head_sha":"%s","event":"workflow_dispatch","run_attempt":1,"status":"completed","conclusion":"success","created_at":"1970-01-01T00:32:30Z","display_title":"wrong title"}]}\n' \
        "$WORKFLOW_ID" "$path" "$OLD_SHA"
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

emit_complete_compare_pages() {
  local base_sha="$1"
  local head_sha="$2"
  local total_commits="$3"
  python3 - "$base_sha" "$head_sha" "$total_commits" <<'PY'
import json
import sys

base_sha, head_sha, total_text = sys.argv[1:]
total = int(total_text)
commits = [{"sha": f"{index:040x}"} for index in range(1, total)]
commits.append({"sha": head_sha})
for start in range(0, total, 100):
    print(json.dumps({
        "status": "ahead",
        "ahead_by": total,
        "behind_by": 0,
        "total_commits": total,
        "base_commit": {"sha": base_sha},
        "merge_base_commit": {"sha": base_sha},
        "commits": commits[start:start + 100],
    }, separators=(",", ":")))
PY
}

emit_inconsistent_compare_pages() {
  local base_sha="$1"
  local head_sha="$2"
  printf '{"status":"ahead","ahead_by":2,"behind_by":0,"total_commits":2,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"0000000000000000000000000000000000000001"}]}\n' \
    "$base_sha" "$base_sha"
  printf '{"status":"ahead","ahead_by":3,"behind_by":0,"total_commits":2,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
    "$base_sha" "$base_sha" "$head_sha"
}

require_compact_compare_query() {
  [[ " $* " == *" --paginate "* && " $* " == *" --jq "* ]] || {
    echo "compare query was not fully paginated and projected" >&2
    return 1
  }
  [[ "$*" == *'status,ahead_by,behind_by,total_commits'* &&
    "$*" == *'commits:[.commits[]|{sha:.sha}]'* ]] || {
    echo "compare query did not use the compact SHA-only projection" >&2
    return 1
  }
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
    require_compact_compare_query "$@" || return 1
    case "$mode" in
      prospective-paginated-unmaterialized-data)
        emit_complete_compare_pages \
          "$MASTER_SHA" "$PROSPECTIVE_SHA" 540
        ;;
      prospective-inconsistent-pages-data)
        emit_inconsistent_compare_pages "$MASTER_SHA" "$PROSPECTIVE_SHA"
        ;;
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
      prospective-head-present-not-final-data)
        printf '{"status":"ahead","ahead_by":2,"behind_by":0,"total_commits":2,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"},{"sha":"%s"}]}\n' \
          "$MASTER_SHA" "$MASTER_SHA" "$PROSPECTIVE_SHA" "$WRONG_FINAL_SHA"
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
    "repos/$REPOSITORY/actions/runs/$RUN_ID/approvals")
      if [[ "$mode" == approved-superseded-capacity || "$mode" == approved-unmaterialized-data ]]; then
        printf '%s\n' '[{"state":"approved"}]'
      else
        printf '%s\n' '[]'
      fi
      ;;
    "repos/$REPOSITORY/actions/runs/$RUN_ID/artifacts?per_page=1")
      case "$mode" in
        artifacts-unmaterialized-data|artifacts-superseded-capacity)
          printf '%s\n' '{"total_count":1,"artifacts":[{"id":1}]}'
          ;;
        artifacts-count-mismatch-unmaterialized-data|\
        artifacts-count-mismatch-superseded-capacity)
          printf '%s\n' '{"total_count":0,"artifacts":[{"id":1}]}'
          ;;
        malformed-artifacts-superseded-capacity)
          printf '%s\n' '{"artifacts":[]}'
          ;;
        *)
          printf '%s\n' '{"total_count":0,"artifacts":[]}'
          ;;
      esac
      ;;
    "repos/$REPOSITORY/actions/runs/$RUN_ID")
      if [[ -n "${STUB_DETAIL_TRACE:-}" ]]; then
        printf '%s\n' "$RUN_ID" >>"$STUB_DETAIL_TRACE"
      fi
      [[ "${STUB_DETAIL_DRIFT:-}" != api-failure ]] || return 1
      emit_full_run | mutate_run_detail || return 1
      [[ "${STUB_DETAIL_DRIFT:-}" != api-failure-after-body ]] || return 1
      ;;
    "repos/$REPOSITORY/git/ref/heads/master")
      printf '{"object":{"sha":"%s"}}\n' "$MASTER_SHA"
      ;;
    "repos/$REPOSITORY/compare/"*)
      require_compact_compare_query "$@" || return 1
      case "$mode" in
        paginated-unmaterialized-data)
          emit_complete_compare_pages "$OLD_SHA" "$MASTER_SHA" 540
          ;;
        inconsistent-pages-unmaterialized-data)
          emit_inconsistent_compare_pages "$OLD_SHA" "$MASTER_SHA"
          ;;
        empty-pages-unmaterialized-data)
          ;;
        duplicate-json-page-unmaterialized-data)
          printf '{"status":"ahead","ahead_by":1,"ahead_by":1,"behind_by":0,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
            "$OLD_SHA" "$OLD_SHA" "$MASTER_SHA"
          ;;
        malformed-page-commits-unmaterialized-data)
          printf '{"status":"ahead","ahead_by":1,"behind_by":0,"total_commits":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":{}}\n' \
            "$OLD_SHA" "$OLD_SHA"
          ;;
        duplicate-commits-unmaterialized-data)
          printf '{"status":"ahead","ahead_by":2,"behind_by":0,"total_commits":2,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"},{"sha":"%s"}]}\n' \
            "$OLD_SHA" "$OLD_SHA" "$MASTER_SHA" "$MASTER_SHA"
          ;;
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
        head-present-not-final-compare-unmaterialized-data)
          printf '{"status":"ahead","ahead_by":2,"behind_by":0,"total_commits":2,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"},{"sha":"%s"}]}\n' \
            "$OLD_SHA" "$OLD_SHA" "$MASTER_SHA" "$WRONG_FINAL_SHA"
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
  emit_run_detail_payload complete_fixture_identity mutate_run_detail \
  emit_successful_runs emit_other_active_inventory emit_prospective_promotion \
  emit_complete_compare_pages emit_inconsistent_compare_pages \
  require_compact_compare_query
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

for mode in superseded-capacity; do
  output="$(run_case "$mode")"
  grep -qF 'reason=superseded' <<<"$output" || {
    echo "supersession classifier did not retain reason=superseded mode=$mode" >&2
    exit 1
  }
done

for mode in \
  missing-path-filter-unmaterialized-data null-path-filter-unmaterialized-data \
  missing-head_branch-filter-unmaterialized-data null-head_branch-filter-unmaterialized-data \
  unmaterialized-data \
  paginated-unmaterialized-data \
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

prospective_paginated_output="$(
  run_prospective_case prospective-paginated-unmaterialized-data
)"
grep -qF 'prospective_unmaterialized=yes' <<<"$prospective_paginated_output" || {
  echo "prospective paginated compare did not classify the exact ghost" >&2
  exit 1
}

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
  prospective-inconsistent-pages-data \
  prospective-wrong-final-compare-data \
  prospective-head-present-not-final-data \
  prospective-active-unmaterialized-data \
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
  approved-superseded-capacity wrong-title-superseded-capacity \
  artifacts-superseded-capacity \
  artifacts-count-mismatch-superseded-capacity \
  malformed-artifacts-superseded-capacity \
  superseded-deploy \
  superseded-data superseded-activation \
  unfenced-superseded-data nonancestor-superseded-data \
  current-unmaterialized-data \
  active-unmaterialized-data active-unmaterialized-activation \
  active-unmaterialized-capacity approved-unmaterialized-data \
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
  inconsistent-pages-unmaterialized-data \
  empty-pages-unmaterialized-data \
  duplicate-json-page-unmaterialized-data \
  malformed-page-commits-unmaterialized-data \
  duplicate-commits-unmaterialized-data \
  wrong-final-compare-unmaterialized-data \
  head-present-not-final-compare-unmaterialized-data \
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

observe_case() {
  local mode="$1"
  local target="${2:-oci-live-data-rollout.yml}"
  REPO="$REPOSITORY" STUB_MODE="$mode" PROSPECTIVE_PROMOTION_PR="" \
    EXCLUDE_RUN_ID="" "$EXCLUSIVITY" --observe-disabled-transition "$target"
}
disabled_observation="$(observe_case unmaterialized-data)"
active_observation="$(observe_case active-unmaterialized-data)"
python3 - "$disabled_observation" "$active_observation" "$RUN_ID" <<'PY'
import json
import sys
disabled, active = map(json.loads, sys.argv[1:3])
assert disabled["schemaVersion"] == "betstan.disabled-transition-observation.v2"
assert disabled["target"] == active["target"] == {
    "workflow": "oci-live-data-rollout.yml",
    "path": ".github/workflows/oci-live-data-rollout.yml",
}
assert disabled["candidates"] == active["candidates"]
assert disabled["inventorySha256"] == active["inventorySha256"]
assert disabled["blockers"] == active["blockers"] == []
assert disabled["workflows"][0]["state"] == "disabled_manually"
assert active["workflows"][0]["state"] == "active"
assert disabled["candidates"][0]["runId"] == int(sys.argv[3])
serialized = json.dumps(disabled)
for prohibited in ("PASS", "ageSeconds", "age_seconds", "now_epoch", "content", "created_at"):
    assert prohibited not in serialized, prohibited
PY
for mode in \
  duplicate-unmaterialized-data overflow count-mismatch missing-runs non-array-runs \
  jobs-unmaterialized-data pending-deployment-unmaterialized-data \
  approved-unmaterialized-data artifacts-unmaterialized-data \
  touched-timestamps-unmaterialized-data wrong-attempt-unmaterialized-data \
  missing-guards-unmaterialized-data incomplete-compare-unmaterialized-data \
  duplicate-commits-unmaterialized-data; do
  if observe_case "$mode" >/dev/null 2>&1; then
    echo "transition observation accepted unsafe evidence: $mode" >&2
    exit 1
  fi
done
# Observation success is NOT exclusivity: it reports a blocker without PASS.
other_observation="$(observe_case ghcr-package-active)"
python3 - "$other_observation" <<'PY'
import json
import sys
value = json.loads(sys.argv[1])
assert value["candidates"] == [] and len(value["blockers"]) == 1
assert value["target"] == {
    "workflow": "oci-live-data-rollout.yml",
    "path": ".github/workflows/oci-live-data-rollout.yml",
}
PY
# The second frozen target behaves identically for its own ghost evidence.
data_disabled_observation="$disabled_observation"
activation_disabled_observation="$(observe_case unmaterialized-activation oci-live-betting-activate.yml)"
activation_active_observation="$(observe_case active-unmaterialized-activation oci-live-betting-activate.yml)"
python3 - "$activation_disabled_observation" "$activation_active_observation" "$RUN_ID" <<'PY'
import json
import sys
disabled, active = map(json.loads, sys.argv[1:3])
assert disabled["schemaVersion"] == "betstan.disabled-transition-observation.v2"
assert disabled["target"] == active["target"] == {
    "workflow": "oci-live-betting-activate.yml",
    "path": ".github/workflows/oci-live-betting-activate.yml",
}
assert disabled["candidates"] == active["candidates"]
assert disabled["blockers"] == active["blockers"] == []
assert disabled["workflows"][0]["state"] == "disabled_manually"
assert active["workflows"][0]["state"] == "active"
assert disabled["candidates"][0]["runId"] == int(sys.argv[3])
PY
# Only the requested target's ghost history becomes a candidate. A proven
# disabled ghost of the OTHER allowlisted workflow stays default-inert: no
# candidate, no workflow row, no blocker.
cross_target_observation="$(observe_case unmaterialized-data oci-live-betting-activate.yml)"
python3 - "$cross_target_observation" <<'PY'
import json
import sys
value = json.loads(sys.argv[1])
assert value["target"] == {
    "workflow": "oci-live-betting-activate.yml",
    "path": ".github/workflows/oci-live-betting-activate.yml",
}
assert value["candidates"] == [] and value["workflows"] == [] and value["blockers"] == []
PY
# Unproven/active work on the OTHER allowlisted workflow still blocks, exactly
# like any other unresolved protected run.
other_target_active_observation="$(observe_case data-active oci-live-betting-activate.yml)"
python3 - "$other_target_active_observation" "$RUN_ID" <<'PY'
import json
import sys
value = json.loads(sys.argv[1])
assert value["candidates"] == [] and value["workflows"] == []
assert value["blockers"] == [int(sys.argv[2])]
PY
# Reciprocal direction: a proven-disabled ghost of the ACTIVATION workflow is
# exactly as default-inert when DATA is the requested target as the reverse
# (asserted above) was for activation. Without this, a regression that only
# special-cases live-data-as-observer (rather than the requested target,
# whichever it is) would go undetected.
reciprocal_ghost_observation="$(observe_case unmaterialized-activation oci-live-data-rollout.yml)"
python3 - "$reciprocal_ghost_observation" <<'PY'
import json
import sys
value = json.loads(sys.argv[1])
assert value["target"] == {
    "workflow": "oci-live-data-rollout.yml",
    "path": ".github/workflows/oci-live-data-rollout.yml",
}
assert value["candidates"] == [] and value["workflows"] == [] and value["blockers"] == []
PY
# Reciprocal direction: unproven/active work on the ACTIVATION workflow still
# blocks a DATA-target observation, mirroring the data-active case above.
reciprocal_active_observation="$(observe_case activation-active oci-live-data-rollout.yml)"
python3 - "$reciprocal_active_observation" "$RUN_ID" <<'PY'
import json
import sys
value = json.loads(sys.argv[1])
assert value["candidates"] == [] and value["workflows"] == []
assert value["blockers"] == [int(sys.argv[2])]
PY
# The frozen map is exactly two entries; capacity/path/run-ID/unknown targets
# are rejected at argv parsing, and the retired flag has no alias.
for bad_argv in \
  "--observe-disabled-transition" \
  "--observe-disabled-transition oci-live-data-rollout.yml extra" \
  "--observe-live-data-transition" \
  "--observe-live-data-transition oci-live-data-rollout.yml" \
  "--observe-disabled-transition oci-capacity-acquire.yml" \
  "--observe-disabled-transition .github/workflows/oci-live-data-rollout.yml" \
  "--observe-disabled-transition $RUN_ID" \
  "--observe-disabled-transition oci-production-deploy.yml"; do
  # shellcheck disable=SC2086
  if REPO="$REPOSITORY" "$EXCLUSIVITY" $bad_argv >/dev/null 2>&1; then
    echo "transition observation accepted invalid argv: $bad_argv" >&2
    exit 1
  fi
done
if REPO="$REPOSITORY" EXCLUDE_RUN_ID="$RUN_ID" \
  "$EXCLUSIVITY" --observe-disabled-transition oci-live-data-rollout.yml >/dev/null 2>&1; then
  echo "transition observation accepted an exclusion" >&2
  exit 1
fi
if REPO="$REPOSITORY" "$EXCLUSIVITY" --observe-disabled-transition oci-live-data-rollout.yml "$RUN_ID" >/dev/null 2>&1; then
  echo "transition observation accepted caller candidate IDs" >&2
  exit 1
fi
expect_rejected active-unmaterialized-data
# Observation does not need successful-run history. The ordinary path retains
# its prior fail-closed treatment of that incomplete, bounded history response.
large_history_observation="$(observe_case large-success-history-unmaterialized-data)"
[[ "$large_history_observation" = "$disabled_observation" ]]
expect_rejected large-success-history-unmaterialized-data
for field in path head_branch; do
  for kind in missing null; do
    # Deliberately preserve the ordinary pre-filter semantics.
    run_case "$kind-$field-filter-unmaterialized-data" >/dev/null
    if observe_case "$kind-$field-filter-unmaterialized-data" >/dev/null 2>&1; then
      echo "observation silently skipped malformed protected filter: $kind $field" >&2
      exit 1
    fi
  done
done
# A real protected queued dispatch is relabeled in inventory as an old disabled
# non-queued push. The ordinary path intentionally retains its exact legacy
# bytes and makes no detail call; observation must never inherit that shortcut.
detail_trace="$(mktemp)"
trap 'rm -f "$detail_trace"' EXIT
default_output="$(STUB_DETAIL_DRIFT=relabeled STUB_DETAIL_TRACE="$detail_trace" run_case stale-disabled)"
expected_default="$(printf '%s\n' \
  "ignored_inert_run=$RUN_ID path=.github/workflows/production-build.yml status=in_progress inert=yes state=disabled_manually jobs=0 pending=0 age_seconds=2000 reason=disabled" \
  "production_run_exclusivity=PASS")"
[[ "$default_output" = "$expected_default" && ! -s "$detail_trace" ]]
if STUB_DETAIL_DRIFT=relabeled STUB_DETAIL_TRACE="$detail_trace" \
  observe_case stale-disabled >/dev/null 2>&1; then
  echo "observation accepted relabeled protected run detail" >&2
  exit 1
fi
[[ "$(cat "$detail_trace")" = "$RUN_ID" ]]
for mode in api-failure api-failure-after-body duplicate ambiguous null-body non-object non-first-attempt; do
  if STUB_DETAIL_DRIFT="$mode" observe_case stale-disabled >/dev/null 2>&1; then
    echo "observation accepted invalid authoritative detail: $mode" >&2
    exit 1
  fi
done
for field in id workflow_id path status event head_sha head_branch run_attempt \
  repository head_repository html_url url created_at run_started_at updated_at display_title; do
  for kind in missing null mismatch; do
    if STUB_DETAIL_DRIFT="$kind:$field" observe_case stale-disabled >/dev/null 2>&1; then
      echo "observation accepted detail drift: $kind $field" >&2
      exit 1
    fi
  done
done
if STUB_DETAIL_DRIFT=missing:conclusion observe_case stale-disabled >/dev/null 2>&1; then
  echo "observation accepted an ambiguous missing conclusion" >&2
  exit 1
fi
if STUB_DETAIL_DRIFT=outside-relabel observe_case pr-validation >/dev/null 2>&1; then
  echo "observation filtered a forged branch before fetching detail" >&2
  exit 1
fi
for mode in unmaterialized-data superseded-capacity pr-validation; do
  : >"$detail_trace"
  STUB_DETAIL_TRACE="$detail_trace" observe_case "$mode" >/dev/null
  [[ "$(cat "$detail_trace")" = "$RUN_ID" ]] || {
    echo "observation did not fetch/cache exactly one detail for $mode" >&2
    exit 1
  }
done
echo "observation_authoritative_rebound_tests=PASS"
echo "production_run_exclusivity_tests=PASS"
