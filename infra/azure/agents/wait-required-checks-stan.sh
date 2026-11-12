#!/usr/bin/env bash
set -euo pipefail

# Purpose: bounded, quiet wait until a PR's branch-protection-required checks
# succeed on its exact head (and, for master, merge snapshot). Non-required
# contexts such as trusted-quality-transition/* are ignored.
# This grants no authority: it never merges, approves, or dispatches.
# Run pr-merge-safety-stan.sh afterwards, immediately before merging.
# Usage:
#   ./infra/azure/agents/wait-required-checks-stan.sh 41
# Exit codes: 0 READY, 1 FAILED/error, 2 STALE snapshot, 3 TIMEOUT.

REPO="${REPO:-vasilyevstan/betstan}"
PR_NUMBER="${1:-${PR:-}}"
WAIT_INTERVAL_SECONDS="${WAIT_INTERVAL_SECONDS:-30}"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-1800}"
WAIT_RETRY_SECONDS="${WAIT_RETRY_SECONDS:-5}"

if [[ -z "$PR_NUMBER" ]]; then
  echo "usage: $0 <pr-number>" >&2
  exit 1
fi

# gh with up to 3 attempts; exits 1 when the API stays unavailable.
gh_retry() {
  local attempt output
  for attempt in 1 2 3; do
    if output="$(gh "$@")"; then
      printf '%s\n' "$output"
      return 0
    fi
    [[ "$attempt" == 3 ]] || sleep "$WAIT_RETRY_SECONDS"
  done
  echo "ERROR gh $1 $2 failed after 3 attempts" >&2
  exit 1
}

read_snapshot() {
  local meta
  meta="$(gh_retry pr view "$PR_NUMBER" --repo "$REPO" \
    --json headRefOid,baseRefOid,baseRefName,potentialMergeCommit,state)" || exit 1
  python3 -c '
import json, sys
m = json.loads(sys.argv[1])
print(m.get("headRefOid") or "-", m.get("baseRefOid") or "-",
      (m.get("potentialMergeCommit") or {}).get("oid") or "-",
      m.get("baseRefName") or "-", m.get("state") or "-")
' "$meta"
}

snapshot="$(read_snapshot)"
read -r head_sha base_sha merge_sha base_ref pr_state <<<"$snapshot"
if [[ "$pr_state" != "OPEN" || "$head_sha" == "-" || "$base_sha" == "-" ||
  "$merge_sha" == "-" || "$base_ref" == "-" ]]; then
  echo "ERROR PR #$PR_NUMBER is not open or its head/base/merge snapshot is unavailable" >&2
  exit 1
fi

protection="$(gh_retry api "repos/$REPO/branches/$base_ref/protection/required_status_checks")"
required="$(python3 -c '
import json, sys
try:
    p = json.loads(sys.argv[1])
    names = set(p.get("contexts") or [])
    names.update(c["context"] for c in (p.get("checks") or []))
except Exception:
    names = set()
print("\n".join(sorted(n for n in names if n)))
' "$protection")"
if [[ -z "$required" ]]; then
  echo "ERROR no required status checks readable for $base_ref; failing closed" >&2
  exit 1
fi

echo "waiting pr=$PR_NUMBER base=$base_ref head=$head_sha merge=$merge_sha" \
  "required=$(printf '%s' "$required" | paste -sd, -)" \
  "interval=${WAIT_INTERVAL_SECONDS}s timeout=${WAIT_TIMEOUT_SECONDS}s"

previous_states="{}"
previous_ignored=""
SECONDS=0
while true; do
  snapshot="$(read_snapshot)"
  read -r cur_head cur_base cur_merge cur_ref cur_state <<<"$snapshot"
  if [[ "$cur_head" != "$head_sha" || "$cur_base" != "$base_sha" ||
    "$cur_merge" != "$merge_sha" || "$cur_ref" != "$base_ref" ||
    "$cur_state" != "OPEN" ]]; then
    echo "STALE head=$cur_head base=$cur_base merge=$cur_merge state=$cur_state" \
      "(expected head=$head_sha base=$base_sha merge=$merge_sha)"
    exit 2
  fi

  head_statuses="$(gh_retry api "repos/$REPO/commits/$head_sha/status?per_page=100")"
  head_runs="$(gh_retry api "repos/$REPO/commits/$head_sha/check-runs?per_page=100")"
  merge_statuses="$(gh_retry api "repos/$REPO/commits/$merge_sha/status?per_page=100")"

  evaluation="$(printf '%s\036%s\036%s' "$head_statuses" "$head_runs" "$merge_statuses" |
    python3 -c '
import datetime, json, sys

required = [n for n in sys.argv[1].split("\n") if n]
base_ref = sys.argv[2]
previous = json.loads(sys.argv[3])
head_statuses, head_runs, merge_statuses = (
    json.loads(part) for part in sys.stdin.read().split("\x1e"))

def status_map(response):
    # The combined status lists the latest status per context first.
    result = {}
    for status in response.get("statuses") or []:
        result.setdefault(status.get("context") or "", status.get("state") or "")
    return result

def run_map(response):
    latest = {}
    for run in response.get("check_runs") or []:
        name = run.get("name") or ""
        if name not in latest or (run.get("id") or 0) > (latest[name].get("id") or 0):
            latest[name] = run
    return {
        name: (run.get("conclusion") or "") if run.get("status") == "completed" else "pending"
        for name, run in latest.items()
    }

def combine(states, need_all):
    failed = [s for s in states if s and s not in ("success", "pending", "missing")]
    if failed:
        return failed[0]
    if need_all:
        return "success" if states and all(s == "success" for s in states) else (
            "pending" if any(s for s in states if s != "missing") else "missing")
    if "success" in states:
        return "success"
    return "pending" if "pending" in states else "missing"

head_s, head_r, merge_s = status_map(head_statuses), run_map(head_runs), status_map(merge_statuses)
states = {}
for name in required:
    head_state = combine([s for s in (head_s.get(name), head_r.get(name)) if s], False)
    merge_state = merge_s.get(name, "missing")
    # master statuses publish on head and merge snapshot; dev only on merge snapshot.
    # Check-runs (e.g. oci-validate) attach only to the head, never the merge snapshot.
    is_check_run = name in head_r and name not in head_s and name not in merge_s
    states[name] = combine([head_state, merge_state], base_ref == "master" and not is_check_run)

now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
for name in required:
    if previous.get(name) != states[name]:
        print(f"CHANGE {now} {name} {states[name]}")
ignored = sorted((set(head_s) | set(head_r) | set(merge_s)) - set(required) - {""})
print("IGNORED " + ",".join(ignored))
print("STATES " + json.dumps(states, sort_keys=True))
failed = [n for n in required if states[n] not in ("success", "pending", "missing")]
pending = [n for n in required if states[n] != "success"]
if failed:
    print("VERDICT failed " + failed[0])
elif pending:
    print("VERDICT pending " + ",".join(pending))
else:
    print("VERDICT ready")
' "$required" "$base_ref" "$previous_states")"

  verdict=""
  while IFS= read -r line; do
    case "$line" in
      "CHANGE "*) echo "${line#CHANGE }" ;;
      "IGNORED "*)
        ignored="${line#IGNORED }"
        if [[ -n "$ignored" && "$ignored" != "$previous_ignored" ]]; then
          echo "ignored=$ignored"
          previous_ignored="$ignored"
        fi
        ;;
      "STATES "*) previous_states="${line#STATES }" ;;
      "VERDICT "*) verdict="${line#VERDICT }" ;;
    esac
  done <<<"$evaluation"

  case "$verdict" in
    ready)
      echo "pr-merge-safety-stan.sh must still run immediately before merging;" \
        "this waiter grants no authority and never merges, approves, or dispatches."
      echo "READY head=$head_sha merge=$merge_sha"
      exit 0
      ;;
    "failed "*)
      echo "FAILED ${verdict#failed }"
      exit 1
      ;;
    "pending "*)
      if (( SECONDS + WAIT_INTERVAL_SECONDS > WAIT_TIMEOUT_SECONDS )); then
        echo "TIMEOUT pending=${verdict#pending }"
        exit 3
      fi
      sleep "$WAIT_INTERVAL_SECONDS"
      ;;
    *)
      echo "ERROR could not evaluate required checks" >&2
      exit 1
      ;;
  esac
done
