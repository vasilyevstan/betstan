#!/usr/bin/env bash
set -euo pipefail

# Purpose: validate trusted required statuses for a PR's exact head and merge snapshots.
# Usage:
#   ./infra/azure/agents/pr-validation-stan.sh 41
#   PR=41 ./infra/azure/agents/pr-validation-stan.sh

REPO="${REPO:-vasilyevstan/betstan}"
PR_NUMBER="${1:-${PR:-}}"
EXPECTED_HEAD_SHA="${EXPECTED_HEAD_SHA:-}"
EXPECTED_BASE_SHA="${EXPECTED_BASE_SHA:-}"
TRUSTED_STATUS_APP_ID="${TRUSTED_STATUS_APP_ID:-15368}"

if [[ -z "$PR_NUMBER" ]]; then
  echo "usage: $0 <pr-number>" >&2
  exit 1
fi

tmp_meta="$(mktemp)"
tmp_statuses="$(mktemp)"
tmp_head_statuses="$(mktemp)"
tmp_required="$(mktemp)"
tmp_run="$(mktemp)"
cleanup() {
  rm -f "$tmp_meta" "$tmp_statuses" "$tmp_head_statuses" "$tmp_required" "$tmp_run"
}
trap cleanup EXIT

section() {
  printf '\n=== %s ===\n' "$1"
}

section "pr metadata"
gh pr view "$PR_NUMBER" --repo "$REPO" \
  --json number,title,state,mergeable,mergeStateStatus,headRefName,headRefOid,headRepository,baseRefName,baseRefOid,potentialMergeCommit,url \
  > "$tmp_meta"
python3 - "$tmp_meta" <<'PY'
import json
import sys

meta = json.load(open(sys.argv[1], encoding="utf-8"))
for key in [
    "number",
    "title",
    "state",
    "mergeable",
    "mergeStateStatus",
    "headRefName",
    "headRefOid",
    "baseRefName",
    "baseRefOid",
    "url",
]:
    print(f"{key}={meta.get(key)}")
print(f"headRepository={(meta.get('headRepository') or {}).get('nameWithOwner', '')}")
print(f"mergeSnapshot={(meta.get('potentialMergeCommit') or {}).get('oid', '')}")
PY

read -r head_sha base_sha merge_sha base_ref <<<"$(
  python3 - "$tmp_meta" <<'PY'
import json
import sys

meta = json.load(open(sys.argv[1], encoding="utf-8"))
print(
    meta.get("headRefOid", ""),
    meta.get("baseRefOid", ""),
    (meta.get("potentialMergeCommit") or {}).get("oid", ""),
    meta.get("baseRefName", ""),
)
PY
)"
[[ -n "$head_sha" && -n "$base_sha" && -n "$merge_sha" && -n "$base_ref" ]] || {
  echo "PR head, base, or merge snapshot SHA is missing" >&2
  exit 1
}
[[ "$merge_sha" != "$head_sha" ]] || {
  echo "PR merge snapshot is not distinct from the reusable head SHA" >&2
  exit 1
}
[[ -z "$EXPECTED_HEAD_SHA" || "$head_sha" == "$EXPECTED_HEAD_SHA" ]] || {
  echo "PR head changed: expected=$EXPECTED_HEAD_SHA actual=$head_sha" >&2
  exit 1
}
[[ -z "$EXPECTED_BASE_SHA" || "$base_sha" == "$EXPECTED_BASE_SHA" ]] || {
  echo "PR base changed: expected=$EXPECTED_BASE_SHA actual=$base_sha" >&2
  exit 1
}

section "required merge-snapshot statuses"
gh api "repos/$REPO/commits/$merge_sha/status" > "$tmp_statuses"
if ! python3 - "$tmp_statuses" "$tmp_required" "$TRUSTED_STATUS_APP_ID" "$base_ref" <<'PY'
import json
import re
import sys

response = json.load(open(sys.argv[1], encoding="utf-8"))
required_path = sys.argv[2]
trusted_status_app_id = sys.argv[3]
base_ref = sys.argv[4]
required = {
    f"branch-policy/{base_ref}": {
        "workflow_file": "branch-policy.yml",
        "events": "pull_request_target,workflow_run,workflow_dispatch",
        "require_head_sha": "no",
    },
    f"pr-quality-gates/{base_ref}": {
        "workflow_file": "production-build.yml",
        "events": "pull_request",
        "require_head_sha": "yes",
    },
}

failed = False
required_runs = []
statuses = response.get("statuses") or []
for context, spec in required.items():
    matches = [status for status in statuses if status.get("context") == context]
    if not matches:
        print(f"{context}\tMISSING\t\t")
        failed = True
        continue

    status = matches[0]
    state = status.get("state") or ""
    target_url = status.get("target_url") or ""
    avatar_url = status.get("avatar_url") or ""
    app_match = re.search(r"/in/(\d+)(?:\?|$)", avatar_url)
    app_id = app_match.group(1) if app_match else ""
    print(f"{context}\t{state}\tapp_id={app_id}\t{target_url}")
    if state != "success":
        failed = True
    if app_id != trusted_status_app_id:
        print(f"{context}: unexpected status app ID {app_id!r}", file=sys.stderr)
        failed = True

    run_match = re.search(r"/actions/runs/(\d+)(?:/|$)", target_url)
    if not run_match:
        print(f"{context}: target URL has no Actions run ID", file=sys.stderr)
        failed = True
        continue
    required_runs.append(
        (
            context,
            run_match.group(1),
            spec["workflow_file"],
            spec["events"],
            spec["require_head_sha"],
        )
    )

with open(required_path, "w", encoding="utf-8") as output:
    for values in required_runs:
        output.write("\t".join(values) + "\n")

sys.exit(1 if failed else 0)
PY
then
  echo "required statuses are missing, failed, or untrusted for PR #$PR_NUMBER" >&2
  exit 1
fi

if [[ "$base_ref" == "master" ]]; then
  section "required head-snapshot statuses"
  gh api "repos/$REPO/commits/$head_sha/status" > "$tmp_head_statuses"
  if ! python3 - "$tmp_head_statuses" "$tmp_required" \
    "$TRUSTED_STATUS_APP_ID" <<'PY'
import json
import re
import sys

response = json.load(open(sys.argv[1], encoding="utf-8"))
required_runs = {}
with open(sys.argv[2], encoding="utf-8") as handle:
    for line in handle:
        context, run_id, *_ = line.rstrip("\n").split("\t")
        required_runs[context] = run_id
trusted_status_app_id = sys.argv[3]
statuses = response.get("statuses") or []
failed = False

for context, expected_run_id in required_runs.items():
    matches = [status for status in statuses if status.get("context") == context]
    if not matches:
        print(f"{context}\tMISSING\t\t")
        failed = True
        continue

    status = matches[0]
    state = status.get("state") or ""
    target_url = status.get("target_url") or ""
    avatar_url = status.get("avatar_url") or ""
    app_match = re.search(r"/in/(\d+)(?:\?|$)", avatar_url)
    run_match = re.search(r"/actions/runs/(\d+)(?:/|$)", target_url)
    app_id = app_match.group(1) if app_match else ""
    run_id = run_match.group(1) if run_match else ""
    print(f"{context}\t{state}\tapp_id={app_id}\t{target_url}")
    if (
        state != "success"
        or app_id != trusted_status_app_id
        or run_id != expected_run_id
    ):
        failed = True

sys.exit(1 if failed else 0)
PY
  then
    echo "required head statuses do not match the trusted merge snapshot" >&2
    exit 1
  fi
fi

section "trusted workflow provenance"
quality_status_run_id="$(
  awk -F $'\t' -v context="pr-quality-gates/$base_ref" \
    '$1 == context { print $2 }' "$tmp_required"
)"
[[ -n "$quality_status_run_id" ]] || {
  echo "trusted quality status run ID is missing" >&2
  exit 1
}
while IFS=$'\t' read -r context run_id workflow_file expected_events require_head_sha; do
  [[ -n "${run_id:-}" ]] || continue
  trusted_workflow_id="$(
    gh api "repos/$REPO/actions/workflows/$workflow_file" --jq '.id'
  )"
  gh api "repos/$REPO/actions/runs/$run_id" > "$tmp_run"
  if ! python3 - "$tmp_run" "$context" "$trusted_workflow_id" \
    "$workflow_file" "$expected_events" "$require_head_sha" \
    "$PR_NUMBER" "$head_sha" "$base_sha" "$quality_status_run_id" <<'PY'
import json
import sys

(
    run_file,
    context,
    trusted_workflow_id,
    workflow_file,
    expected_events,
    require_head_sha,
    pr_number,
    head_sha,
    base_sha,
    quality_status_run_id,
) = sys.argv[1:]
run = json.load(open(run_file, encoding="utf-8"))
allowed_events = set(expected_events.split(","))
expected_path = f".github/workflows/{workflow_file}"

print(
    f"check={context} run_id={run.get('id', '')} "
    f"workflow_id={run.get('workflow_id', '')} name={run.get('name', '')} "
    f"path={run.get('path', '')} title={run.get('display_title', '')} "
    f"head_sha={run.get('head_sha', '')} "
    f"event={run.get('event', '')} status={run.get('status', '')} "
    f"conclusion={run.get('conclusion', '')} url={run.get('html_url', '')}"
)

failures = []
if str(run.get("workflow_id", "")) != trusted_workflow_id:
    failures.append("untrusted workflow ID")
if run.get("path") != expected_path:
    failures.append("unexpected workflow path")
if run.get("event") not in allowed_events:
    failures.append("unexpected workflow event")
if run.get("status") != "completed" or run.get("conclusion") != "success":
    failures.append("workflow run is not completed successfully")
if require_head_sha == "yes" and run.get("head_sha") != head_sha:
    failures.append("workflow run belongs to a different head SHA")

if context.startswith("branch-policy/") and run.get("event") == "workflow_run":
    relation_matches = (
        run.get("display_title") == f"branch-policy PR {quality_status_run_id}"
    )
elif run.get("event") == "workflow_dispatch":
    relation_matches = run.get("display_title") == f"branch-policy PR {pr_number}"
else:
    relation_matches = any(
        str(relation.get("number", "")) == pr_number
        and (relation.get("head") or {}).get("sha") == head_sha
        and (relation.get("base") or {}).get("sha") == base_sha
        for relation in (run.get("pull_requests") or [])
    )
if not relation_matches:
    failures.append("workflow run is not bound to the current PR head/base snapshot")

if failures:
    for failure in failures:
        print(f"{context}: {failure}", file=sys.stderr)
    sys.exit(1)
PY
  then
    exit 1
  fi
done < "$tmp_required"

latest_meta="$(
  gh pr view "$PR_NUMBER" --repo "$REPO" \
    --json headRefOid,baseRefOid,potentialMergeCommit
)"
read -r latest_head latest_base latest_merge <<<"$(
  python3 - "$latest_meta" <<'PY'
import json
import sys

meta = json.loads(sys.argv[1])
print(
    meta.get("headRefOid", ""),
    meta.get("baseRefOid", ""),
    (meta.get("potentialMergeCommit") or {}).get("oid", ""),
)
PY
)"
[[ "$latest_head" == "$head_sha" &&
  "$latest_base" == "$base_sha" &&
  "$latest_merge" == "$merge_sha" ]] || {
  echo "PR changed while exact-snapshot validation was running" >&2
  exit 1
}

section "diagnosis"
echo "exact_head_sha=$head_sha"
echo "exact_base_sha=$base_sha"
echo "exact_merge_snapshot_sha=$merge_sha"
echo "all_required_checks=PASS"
