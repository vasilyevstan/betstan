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
cleanup() {
  rm -f "$tmp_runs" "$tmp_candidates" "$tmp_workflows"
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
  successful_runs_json='{"total_count":0,"workflow_runs":[]}'
  if [[
    "$path" == ".github/workflows/oci-capacity-acquire.yml" &&
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
    successful_runs_json="$(
      gh api \
        "repos/$REPO/actions/workflows/$workflow_id/runs?head_sha=$head_sha&event=workflow_dispatch&status=success&per_page=100"
    )"
  fi
  classification="$(
    python3 - "$workflow_json" "$jobs_json" "$pending_json" \
      "$successful_runs_json" "$run_id" "$workflow_id" "$path" "$status" \
      "$updated_at" "$head_sha" "$event" "$run_attempt" "$master_sha" \
      "$NOW_EPOCH" "$STALE_DISABLED_MIN_AGE_SECONDS" <<'PY'
import datetime
import json
import sys

workflow = json.loads(sys.argv[1])
jobs = json.loads(sys.argv[2])
pending = json.loads(sys.argv[3])
successful_runs = json.loads(sys.argv[4])
run_id = int(sys.argv[5])
workflow_id = int(sys.argv[6])
path = sys.argv[7]
status = sys.argv[8]
updated_at = datetime.datetime.fromisoformat(sys.argv[9].replace("Z", "+00:00"))
head_sha = sys.argv[10]
event = sys.argv[11]
run_attempt = int(sys.argv[12])
master_sha = sys.argv[13]
now = datetime.datetime.fromtimestamp(int(sys.argv[14]), datetime.timezone.utc)
minimum_age = int(sys.argv[15])
state = workflow.get("state")
job_count = jobs.get("total_count")
job_entries = jobs.get("jobs")
successful_entries = successful_runs.get("workflow_runs")
if (
    not isinstance(state, str)
    or workflow.get("path") != path
    or not isinstance(job_count, int)
    or job_count < 0
    or not isinstance(job_entries, list)
    or not isinstance(pending, list)
    or not isinstance(successful_entries, list)
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

superseded_by = None
if (
    state == "active"
    and path == ".github/workflows/oci-capacity-acquire.yml"
    and status == "queued"
    and event == "workflow_dispatch"
    and run_attempt == 1
    and head_sha != master_sha
    and jobless_and_old
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
            superseded_by = successful_id
            break

inert = disabled_inert or superseded_by is not None
reason = "disabled" if disabled_inert else "superseded" if superseded_by else "none"
print(
    f"inert={'yes' if inert else 'no'} state={state} jobs={job_count} "
    f"pending={len(pending)} age_seconds={age_seconds} reason={reason}"
    + (f" superseded_by={superseded_by}" if superseded_by else "")
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
