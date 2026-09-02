#!/usr/bin/env bash
set -euo pipefail

# Purpose: block concurrent production-capable activity while ignoring only
#          queue records proven inert by bounded GitHub evidence.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POLICY_SCRIPT="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
REPO="${REPO:-vasilyevstan/betstan}"
EXCLUDE_RUN_ID="${EXCLUDE_RUN_ID:-}"
STALE_DISABLED_MIN_AGE_SECONDS="${STALE_DISABLED_MIN_AGE_SECONDS:-600}"
NOW_EPOCH="${NOW_EPOCH:-$(date +%s)}"

[[ -z "$EXCLUDE_RUN_ID" || "$EXCLUDE_RUN_ID" =~ ^[1-9][0-9]*$ ]] || {
  echo "EXCLUDE_RUN_ID must be empty or a positive integer" >&2
  exit 1
}
[[ "$STALE_DISABLED_MIN_AGE_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  echo "STALE_DISABLED_MIN_AGE_SECONDS must be a positive integer" >&2
  exit 1
}
[[ "$NOW_EPOCH" =~ ^[1-9][0-9]*$ ]] || {
  echo "NOW_EPOCH must be a positive integer" >&2
  exit 1
}

tmp_runs="$(mktemp)"
tmp_candidates="$(mktemp)"
tmp_workflows="$(mktemp)"
tmp_successful_runs="$(mktemp)"
tmp_ancestry="$(mktemp)"
tmp_historical_workflow="$(mktemp)"
cleanup() {
  rm -f \
    "$tmp_runs" "$tmp_candidates" "$tmp_workflows" "$tmp_successful_runs" \
    "$tmp_ancestry" "$tmp_historical_workflow"
}
trap cleanup EXIT

"$POLICY_SCRIPT" workflows |
  sed 's#^#.github/workflows/#' >"$tmp_workflows"

for status in queued in_progress waiting requested pending; do
  gh api "repos/$REPO/actions/runs?status=$status&per_page=100" >>"$tmp_runs"
  printf '\n' >>"$tmp_runs"
done

python3 - "$tmp_runs" "$tmp_workflows" >"$tmp_candidates" <<'PY'
import json
import sys

paths = {
    line.strip()
    for line in open(sys.argv[2], encoding="utf-8")
    if line.strip()
}
if len(paths) != 15:
    raise SystemExit("protected-operation policy must enumerate exactly 15 workflows")
decoder = json.JSONDecoder()
payload = open(sys.argv[1], encoding="utf-8").read()
index = 0
seen = set()
while index < len(payload):
    while index < len(payload) and payload[index].isspace():
        index += 1
    if index >= len(payload):
        break
    response, index = decoder.raw_decode(payload, index)
    if not isinstance(response, dict):
        raise SystemExit("active run inventory response is malformed")
    total_count = response.get("total_count")
    runs = response.get("workflow_runs")
    if not isinstance(total_count, int) or total_count < 0:
        raise SystemExit("active run inventory count is malformed")
    if total_count > 100:
        raise SystemExit("more than 100 active runs requires manual review")
    if not isinstance(runs, list) or len(runs) != total_count:
        raise SystemExit("active run inventory is incomplete")
    for run in runs:
        run_id = run.get("id")
        if (
            run_id in seen
            or run.get("path") not in paths
            or run.get("head_branch") != "master"
        ):
            continue
        seen.add(run_id)
        values = (
            run_id,
            run.get("workflow_id"),
            run.get("path"),
            run.get("status"),
            run.get("updated_at"),
            run.get("head_sha"),
            run.get("event"),
            run.get("run_attempt"),
        )
        if (
            not isinstance(run_id, int)
            or not isinstance(run.get("workflow_id"), int)
            or any(not isinstance(value, str) or not value for value in values[2:7])
            or not isinstance(values[7], int)
            or values[7] < 1
        ):
            raise SystemExit("active run metadata is malformed")
        print("\t".join(str(value) for value in values))
PY

while IFS=$'\t' read -r \
  run_id workflow_id path status updated_at head_sha event run_attempt
do
  [[ -n "${run_id:-}" ]] || continue
  if [[ "$run_id" == "$EXCLUDE_RUN_ID" ]]; then
    continue
  fi

  workflow_json="$(gh api "repos/$REPO/actions/workflows/$workflow_id")"
  jobs_json="$(gh api "repos/$REPO/actions/runs/$run_id/jobs?per_page=1")"
  pending_json="$(gh api "repos/$REPO/actions/runs/$run_id/pending_deployments")"
  master_sha=""
  printf '%s\n' '{"total_count":0,"workflow_runs":[]}' >"$tmp_successful_runs"
  printf '%s\n' '{}' >"$tmp_ancestry"
  printf '%s\n' '{}' >"$tmp_historical_workflow"
  if [[
    (
      "$path" == ".github/workflows/oci-capacity-acquire.yml" ||
      "$path" == ".github/workflows/oci-live-data-rollout.yml" ||
      "$path" == ".github/workflows/oci-live-betting-activate.yml"
    ) &&
      "$status" == "queued"
  ]]; then
    master_sha="$(
      gh api "repos/$REPO/git/ref/heads/master" |
        python3 -c '
import json
import sys

payload = json.load(sys.stdin)
print((payload.get("object") or {}).get("sha", ""))
'
    )"
    [[ "$master_sha" =~ ^[0-9a-f]{40}$ ]] || {
      echo "Current master SHA is unavailable or malformed" >&2
      exit 1
    }
    [[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || {
      echo "Run $run_id has a malformed head SHA" >&2
      exit 1
    }
    gh api \
      "repos/$REPO/actions/workflows/$workflow_id/runs?head_sha=$head_sha&event=workflow_dispatch&status=success&per_page=100" \
      >"$tmp_successful_runs"
    gh api "repos/$REPO/compare/$head_sha...$master_sha" >"$tmp_ancestry"
    if [[
      "$path" == ".github/workflows/oci-live-data-rollout.yml" ||
        "$path" == ".github/workflows/oci-live-betting-activate.yml"
    ]]; then
      gh api "repos/$REPO/contents/$path?ref=$head_sha" \
        >"$tmp_historical_workflow"
    fi
  fi
  classification="$(
    python3 - "$workflow_json" "$jobs_json" "$pending_json" \
      "$tmp_successful_runs" "$tmp_ancestry" "$tmp_historical_workflow" \
      "$run_id" "$workflow_id" "$path" "$status" "$updated_at" "$head_sha" \
      "$event" "$run_attempt" "$master_sha" "$NOW_EPOCH" \
      "$STALE_DISABLED_MIN_AGE_SECONDS" <<'PY'
import base64
import datetime
import json
import sys

workflow = json.loads(sys.argv[1])
jobs = json.loads(sys.argv[2])
pending = json.loads(sys.argv[3])
with open(sys.argv[4], encoding="utf-8") as successful_file:
    successful_runs = json.load(successful_file)
with open(sys.argv[5], encoding="utf-8") as ancestry_file:
    ancestry = json.load(ancestry_file)
with open(sys.argv[6], encoding="utf-8") as source_file:
    historical_workflow = json.load(source_file)
run_id = int(sys.argv[7])
workflow_id = int(sys.argv[8])
path = sys.argv[9]
status = sys.argv[10]
updated_at = datetime.datetime.fromisoformat(sys.argv[11].replace("Z", "+00:00"))
head_sha = sys.argv[12]
event = sys.argv[13]
run_attempt = int(sys.argv[14])
master_sha = sys.argv[15]
now = datetime.datetime.fromtimestamp(int(sys.argv[16]), datetime.timezone.utc)
minimum_age = int(sys.argv[17])
state = workflow.get("state")
job_count = jobs.get("total_count")
job_entries = jobs.get("jobs")
successful_count = successful_runs.get("total_count")
successful_entries = successful_runs.get("workflow_runs")
if (
    not isinstance(state, str)
    or workflow.get("path") != path
    or not isinstance(job_count, int)
    or job_count < 0
    or not isinstance(job_entries, list)
    or not isinstance(pending, list)
    or not isinstance(successful_count, int)
    or successful_count < 0
    or not isinstance(successful_entries, list)
    or len(successful_entries) != successful_count
):
    raise SystemExit("production run actionability metadata is malformed")
age_seconds = int((now - updated_at).total_seconds())
jobless_and_old = (
    job_count == 0
    and len(job_entries) == 0
    and len(pending) == 0
    and age_seconds >= minimum_age
)
disabled_inert = (
    state.startswith("disabled_")
    and jobless_and_old
)

supersession_kind = {
    ".github/workflows/oci-capacity-acquire.yml": "capacity",
    ".github/workflows/oci-live-data-rollout.yml": "live-data",
    ".github/workflows/oci-live-betting-activate.yml": "activation",
}.get(path)


def is_stale_ancestor():
    return (
        ancestry.get("status") == "ahead"
        and ancestry.get("ahead_by", 0) > 0
        and (ancestry.get("base_commit") or {}).get("sha") == head_sha
        and (ancestry.get("merge_base_commit") or {}).get("sha") == head_sha
    )


def has_historical_mutation_fence():
    if supersession_kind == "capacity":
        return True
    expected = {
        "live-data": (
            "name: oci-migration",
            "./infra/azure/agents/shared-mongo-operation-lock-stan.sh acquire",
        ),
        "activation": (
            "name: oci-production",
            "run: ./infra/oci/scripts/live-betting-control-stan.sh",
        ),
    }.get(supersession_kind)
    if expected is None:
        return False
    if (
        historical_workflow.get("path") != path
        or historical_workflow.get("encoding") != "base64"
        or not isinstance(historical_workflow.get("content"), str)
    ):
        return False
    try:
        source = base64.b64decode(historical_workflow["content"]).decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        return False
    required_before_mutation = (
        '[ "$SOURCE_SHA" = "$GITHUB_SHA" ]',
        "git fetch --quiet origin master:refs/remotes/origin/master",
        '[ "$SOURCE_SHA" = "$(git rev-parse origin/master)" ]',
    )
    try:
        mutation_index = source.index(expected[1])
        guard_indexes = [source.index(token) for token in required_before_mutation]
    except ValueError:
        return False
    return (
        expected[0] in source
        and "group: oci-control-plane" in source
        and "cancel-in-progress: false" in source
        and max(guard_indexes) < mutation_index
    )


exact_successes = []
if (
    state == "active"
    and supersession_kind is not None
    and status == "queued"
    and event == "workflow_dispatch"
    and run_attempt == 1
    and head_sha != master_sha
    and jobless_and_old
    and is_stale_ancestor()
    and has_historical_mutation_fence()
):
    for successful in successful_entries:
        if not isinstance(successful, dict):
            continue
        try:
            successful_id = int(successful.get("id"))
            successful_created_at = datetime.datetime.fromisoformat(
                successful.get("created_at", "").replace("Z", "+00:00")
            )
        except (AttributeError, TypeError, ValueError):
            continue
        if (
            successful_id > run_id
            and successful_created_at > updated_at
            and successful.get("workflow_id") == workflow_id
            and successful.get("path") == path
            and successful.get("head_sha") == head_sha
            and successful.get("head_branch") == "master"
            and successful.get("event") == event
            and successful.get("status") == "completed"
            and successful.get("conclusion") == "success"
            and successful.get("run_attempt") == 1
        ):
            exact_successes.append((successful_id, successful.get("display_title")))

superseded_by = []
if supersession_kind == "capacity" and exact_successes:
    superseded_by = [min(run[0] for run in exact_successes)]
elif supersession_kind == "activation":
    expected_title = f"oci-live-activate {head_sha}"
    superseded_by = [
        successful_id
        for successful_id, title in exact_successes
        if title == expected_title
    ][:1]
elif supersession_kind == "live-data":
    required_titles = {
        f"oci-live-data dry-run {head_sha}",
        f"oci-live-data apply-backfills {head_sha}",
        f"oci-live-data apply-slip-index {head_sha}",
    }
    successors_by_title = {
        title: successful_id
        for successful_id, title in exact_successes
        if title in required_titles
    }
    if required_titles.issubset(successors_by_title):
        superseded_by = sorted(successors_by_title.values())

inert = disabled_inert or bool(superseded_by)
reason = "disabled" if disabled_inert else "superseded" if superseded_by else "none"
print(
    f"inert={'yes' if inert else 'no'} state={state} jobs={job_count} "
    f"pending={len(pending)} age_seconds={age_seconds} reason={reason}"
    + (
        f" superseded_by={','.join(str(run_id) for run_id in superseded_by)}"
        if superseded_by
        else ""
    )
)
PY
  )"
  if [[ "$classification" == inert=yes* ]]; then
    echo "ignored_inert_run=$run_id path=$path status=$status $classification"
    continue
  fi

  echo "active production run $run_id path=$path status=$status $classification" >&2
  exit 1
done <"$tmp_candidates"

echo "production_run_exclusivity=PASS"
