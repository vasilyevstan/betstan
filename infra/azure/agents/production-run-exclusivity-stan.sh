#!/usr/bin/env bash
set -euo pipefail

# Purpose: block concurrent production-capable activity while ignoring only
#          old, disabled GitHub queue records proven to have no jobs or gates.

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
cleanup() {
  rm -f "$tmp_runs" "$tmp_candidates"
}
trap cleanup EXIT

for status in queued in_progress waiting requested pending; do
  gh api "repos/$REPO/actions/runs?status=$status&per_page=100" >>"$tmp_runs"
  printf '\n' >>"$tmp_runs"
done

python3 - "$tmp_runs" >"$tmp_candidates" <<'PY'
import json
import sys

paths = {
    ".github/workflows/production-build.yml",
    ".github/workflows/production-deploy.yml",
    ".github/workflows/production-rollback.yml",
    ".github/workflows/oci-production-build.yml",
    ".github/workflows/oci-production-deploy.yml",
    ".github/workflows/oci-production-rollback.yml",
    ".github/workflows/oci-infrastructure.yml",
    ".github/workflows/oci-capacity-acquire.yml",
    ".github/workflows/oci-live-data-rollout.yml",
    ".github/workflows/oci-live-betting-activate.yml",
    ".github/workflows/oci-live-betting-disable.yml",
    ".github/workflows/oci-migrate.yml",
    ".github/workflows/oci-migration-recovery.yml",
}
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
    if response.get("total_count", 0) > 100:
        raise SystemExit("more than 100 active runs requires manual review")
    for run in response.get("workflow_runs", []):
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
        )
        if (
            not isinstance(run_id, int)
            or not isinstance(run.get("workflow_id"), int)
            or any(not isinstance(value, str) or not value for value in values[2:])
        ):
            raise SystemExit("active run metadata is malformed")
        print("\t".join(str(value) for value in values))
PY

while IFS=$'\t' read -r run_id workflow_id path status updated_at; do
  [[ -n "${run_id:-}" ]] || continue
  if [[ "$run_id" == "$EXCLUDE_RUN_ID" ]]; then
    continue
  fi

  workflow_json="$(gh api "repos/$REPO/actions/workflows/$workflow_id")"
  jobs_json="$(gh api "repos/$REPO/actions/runs/$run_id/jobs?per_page=1")"
  pending_json="$(gh api "repos/$REPO/actions/runs/$run_id/pending_deployments")"
  classification="$(
    python3 - "$workflow_json" "$jobs_json" "$pending_json" "$updated_at" \
      "$NOW_EPOCH" "$STALE_DISABLED_MIN_AGE_SECONDS" <<'PY'
import datetime
import json
import sys

workflow = json.loads(sys.argv[1])
jobs = json.loads(sys.argv[2])
pending = json.loads(sys.argv[3])
updated_at = datetime.datetime.fromisoformat(sys.argv[4].replace("Z", "+00:00"))
now = datetime.datetime.fromtimestamp(int(sys.argv[5]), datetime.timezone.utc)
minimum_age = int(sys.argv[6])
state = workflow.get("state")
job_count = jobs.get("total_count")
if not isinstance(state, str) or not isinstance(job_count, int) or not isinstance(pending, list):
    raise SystemExit("production run actionability metadata is malformed")
age_seconds = int((now - updated_at).total_seconds())
inert = (
    state.startswith("disabled_")
    and job_count == 0
    and len(pending) == 0
    and age_seconds >= minimum_age
)
print(
    f"inert={'yes' if inert else 'no'} state={state} jobs={job_count} "
    f"pending={len(pending)} age_seconds={age_seconds}"
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
