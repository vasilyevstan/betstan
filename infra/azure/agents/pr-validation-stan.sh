#!/usr/bin/env bash
set -euo pipefail

# Purpose: diagnose the latest build-push validation run for a PR.
# Usage:
#   ./infra/azure/agents/pr-validation-stan.sh 41
#   PR=41 ./infra/azure/agents/pr-validation-stan.sh

PR_NUMBER="${1:-${PR:-}}"
WORKFLOW="${WORKFLOW:-build-push.yml}"
TAIL_LINES="${TAIL_LINES:-120}"

if [[ -z "$PR_NUMBER" ]]; then
  echo "usage: $0 <pr-number>" >&2
  exit 1
fi

tmp_meta="$(mktemp)"
tmp_run="$(mktemp)"
cleanup() {
  rm -f "$tmp_meta" "$tmp_run"
}
trap cleanup EXIT

log() {
  printf '%s\n' "$*"
}

section() {
  printf '\n=== %s ===\n' "$1"
}

classify_log() {
  local log_file="$1"
  if grep -qi 'Exceeded timeout of 5000 ms' "$log_file"; then
    echo "test-timeout"
  elif grep -qi 'Jest did not exit one second after the test run has completed' "$log_file"; then
    echo "open-handles"
  elif grep -qi 'Cannot read properties of undefined (reading '\''ack'\'')' "$log_file"; then
    echo "listener-mock-bug"
  elif grep -qi 'MONGOMS_DOWNLOAD_DIR\|Cache not found for input keys' "$log_file"; then
    echo "mongodb-cache"
  elif grep -qi 'No tests found, exiting with code 1' "$log_file"; then
    echo "no-tests"
  elif grep -qi 'The operation was canceled' "$log_file"; then
    echo "canceled-after-failure"
  else
    echo "uncategorized"
  fi
}

section "pr metadata"
gh pr view "$PR_NUMBER" --json number,title,state,mergeable,headRefName,baseRefName,url > "$tmp_meta"
python3 - "$tmp_meta" <<'PY'
import json,sys
meta=json.load(open(sys.argv[1]))
for k in ["number","title","state","mergeable","headRefName","baseRefName","url"]:
    print(f"{k}={meta.get(k)}")
PY

branch="$(python3 - "$tmp_meta" <<'PY'
import json,sys
print(json.load(open(sys.argv[1])).get("headRefName",""))
PY
)"

section "latest workflow run"
gh run list --workflow "$WORKFLOW" --branch "$branch" --limit 1 --json databaseId,status,conclusion,createdAt,updatedAt > "$tmp_run"
if [[ "$(python3 - "$tmp_run" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
print("NO_RUN" if not r else "HAS_RUN")
PY
)" == "NO_RUN" ]]; then
  log "no workflow run found for branch=$branch workflow=$WORKFLOW"
  exit 1
fi

python3 - "$tmp_run" <<'PY'
import json,sys
run=json.load(open(sys.argv[1]))[0]
print(f"run_id={run.get('databaseId')}")
print(f"run_status={run.get('status')}")
print(f"run_conclusion={run.get('conclusion')}")
print(f"created_at={run.get('createdAt')}")
print(f"updated_at={run.get('updatedAt')}")
PY

run_id="$(python3 - "$tmp_run" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))[0].get("databaseId",""))
PY
)"

section "job summary"
gh run view "$run_id" --json status,conclusion,updatedAt,jobs > "$tmp_run"
python3 - "$tmp_run" <<'PY'
import json,sys
run=json.load(open(sys.argv[1]))
jobs=run.get("jobs", [])
for j in jobs:
    print(f"{j.get('name')}\t{j.get('status')}\t{j.get('conclusion')}\t{j.get('databaseId')}")
PY

failed_jobs="$(python3 - "$tmp_run" <<'PY'
import json,sys
run=json.load(open(sys.argv[1]))
jobs=run.get("jobs", [])
for j in jobs:
    if j.get("conclusion") != "success":
        print(f"{j.get('databaseId')}\t{j.get('name')}\t{j.get('status')}\t{j.get('conclusion')}")
PY
)"

if [[ -z "$failed_jobs" ]]; then
  section "diagnosis"
  log "all checks passed"
  exit 0
fi

section "failed job diagnosis"
while IFS=$'\t' read -r job_id job_name job_status job_conclusion; do
  [[ -z "${job_id:-}" ]] && continue
  log "job=$job_name id=$job_id status=$job_status conclusion=$job_conclusion"
  log_file="$(mktemp)"
  gh run view "$run_id" --job "$job_id" --log > "$log_file" || true
  log "classification=$(classify_log "$log_file")"
  grep -Ei 'Exceeded timeout of 5000 ms|Jest did not exit|Cannot read properties of undefined \(reading '\''ack'\''\)|MONGOMS_DOWNLOAD_DIR|Cache not found for input keys|No tests found, exiting with code 1|The operation was canceled' "$log_file" | tail -n 20 || true
  rm -f "$log_file"
done <<< "$failed_jobs"

section "recommendation"
log "merge_safe=no"
log "next_step=split the PR; keep deploy-recovery changes separate from coverage/test-harness fixes"
exit 1
