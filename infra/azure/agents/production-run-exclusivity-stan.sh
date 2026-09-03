#!/usr/bin/env bash
set -euo pipefail

# Purpose: block concurrent production-capable activity while ignoring only
#          queue records proven inert by bounded GitHub evidence.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POLICY_SCRIPT="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
AUTHORITY_HELPER="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"
REPO="${REPO:-vasilyevstan/betstan}"
EXCLUDE_RUN_ID="${EXCLUDE_RUN_ID:-}"
STALE_DISABLED_MIN_AGE_SECONDS="${STALE_DISABLED_MIN_AGE_SECONDS:-600}"
NOW_EPOCH="${NOW_EPOCH:-$(date +%s)}"
PROSPECTIVE_PROMOTION_PR="${PROSPECTIVE_PROMOTION_PR:-}"
COMPARE_JQ='{status,ahead_by,behind_by,total_commits,base_commit:{sha:.base_commit.sha},merge_base_commit:{sha:.merge_base_commit.sha},commits:[.commits[]|{sha:.sha}]}'

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
[[ -z "$PROSPECTIVE_PROMOTION_PR" ||
  "$PROSPECTIVE_PROMOTION_PR" =~ ^[1-9][0-9]*$ ]] || {
  echo "PROSPECTIVE_PROMOTION_PR must be empty or a positive integer" >&2
  exit 1
}
[[ -z "$PROSPECTIVE_PROMOTION_PR" || -z "$EXCLUDE_RUN_ID" ]] || {
  echo "prospective promotion bootstrap cannot use EXCLUDE_RUN_ID" >&2
  exit 1
}
[[ -x "$AUTHORITY_HELPER" ]] || {
  echo "unmaterialized evidence validator is unavailable" >&2
  exit 1
}

read_current_master() {
  gh api "repos/$REPO/git/ref/heads/master" |
    python3 -c '
import json
import re
import sys

payload = json.load(sys.stdin)
sha = (payload.get("object") or {}).get("sha")
if not isinstance(sha, str) or re.fullmatch(r"[0-9a-f]{40}", sha) is None:
    raise SystemExit("current master SHA is unavailable or malformed")
print(sha)
'
}

fetch_complete_compare() {
  local endpoint="$1"
  local output_file="$2"
  local expected_head_sha="$3"

  chmod 600 "$tmp_compare_pages" "$output_file"
  if ! gh api "$endpoint" --paginate --jq "$COMPARE_JQ" \
    >"$tmp_compare_pages"; then
    : >"$tmp_compare_pages"
    return 1
  fi
  if ! python3 - "$tmp_compare_pages" "$output_file" "$expected_head_sha" <<'PY'
import json
import re
import sys

pages_path, output_path, expected_head_sha = sys.argv[1:]
try:
    payload = open(pages_path, encoding="utf-8").read()
except OSError as error:
    raise SystemExit(f"compact compare evidence is unavailable: {error}")
def duplicate_safe_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result
decoder = json.JSONDecoder(object_pairs_hook=duplicate_safe_object)
index = 0
pages = []
expected_keys = {
    "status",
    "ahead_by",
    "behind_by",
    "total_commits",
    "base_commit",
    "merge_base_commit",
    "commits",
}
sha_pattern = re.compile(r"^[0-9a-f]{40}$")
if sha_pattern.fullmatch(expected_head_sha) is None:
    raise SystemExit("compact compare requested head is malformed")
metadata = None
commits = []
while index < len(payload):
    while index < len(payload) and payload[index].isspace():
        index += 1
    if index >= len(payload):
        break
    try:
        page, index = decoder.raw_decode(payload, index)
    except (json.JSONDecodeError, ValueError) as error:
        raise SystemExit(f"compact compare page is malformed: {error}")
    if not isinstance(page, dict) or set(page) != expected_keys:
        raise SystemExit("compact compare page has an unexpected schema")
    if (
        not isinstance(page["status"], str)
        or not page["status"]
        or any(
            type(page[name]) is not int or page[name] < 0
            for name in ("ahead_by", "behind_by", "total_commits")
        )
    ):
        raise SystemExit("compact compare page metadata is malformed")
    for name in ("base_commit", "merge_base_commit"):
        commit = page[name]
        if (
            not isinstance(commit, dict)
            or set(commit) != {"sha"}
            or not isinstance(commit["sha"], str)
            or sha_pattern.fullmatch(commit["sha"]) is None
        ):
            raise SystemExit(f"compact compare page {name} is malformed")
    if not isinstance(page["commits"], list):
        raise SystemExit("compact compare page commit list is malformed")
    if page["total_commits"] > 0 and not page["commits"]:
        raise SystemExit("compact compare page commit list is empty")
    page_metadata = {
        name: page[name]
        for name in expected_keys - {"commits"}
    }
    if metadata is None:
        metadata = page_metadata
    elif page_metadata != metadata:
        raise SystemExit("compact compare page metadata is inconsistent")
    for commit in page["commits"]:
        if (
            not isinstance(commit, dict)
            or set(commit) != {"sha"}
            or not isinstance(commit["sha"], str)
            or sha_pattern.fullmatch(commit["sha"]) is None
        ):
            raise SystemExit("compact compare page commit is malformed")
        commits.append(commit)
    pages.append(page)
    if len(commits) > page["total_commits"]:
        raise SystemExit("compact compare aggregate exceeds total commits")
if not pages or metadata is None:
    raise SystemExit("compact compare has no pages")
if len(commits) != metadata["total_commits"]:
    raise SystemExit("compact compare aggregate is incomplete")
if len({commit["sha"] for commit in commits}) != len(commits):
    raise SystemExit("compact compare aggregate contains duplicate commits")
if not commits or commits[-1]["sha"] != expected_head_sha:
    raise SystemExit("compact compare aggregate does not end at requested head")
try:
    with open(output_path, "w", encoding="utf-8") as output:
        json.dump(
            {
                **metadata,
                "commits": commits,
            },
            output,
            sort_keys=True,
            separators=(",", ":"),
        )
        output.write("\n")
except OSError as error:
    raise SystemExit(f"compact compare output cannot be written: {error}")
PY
  then
    : >"$tmp_compare_pages"
    return 1
  fi
  : >"$tmp_compare_pages"
}

verify_prospective_promotion() {
  local compare_file="$1"
  local actual_master promotion_json prospective_sha rechecked_master

  actual_master="$(read_current_master)" || return 1
  promotion_json="$(
    gh pr view "$PROSPECTIVE_PROMOTION_PR" --repo "$REPO" \
      --json number,state,headRefName,headRefOid,headRepository,baseRefName,baseRefOid,labels
  )" || return 1
  prospective_sha="$(
    python3 - "$promotion_json" "$REPO" "$PROSPECTIVE_PROMOTION_PR" \
      "$actual_master" <<'PY'
import json
import re
import sys

payload, repository, requested_number, actual_master = sys.argv[1:]
try:
    pull = json.loads(payload)
except json.JSONDecodeError as error:
    raise SystemExit(f"prospective promotion metadata is malformed: {error}")
if not isinstance(pull, dict):
    raise SystemExit("prospective promotion metadata is malformed")
if type(pull.get("number")) is not int or pull["number"] != int(requested_number):
    raise SystemExit("prospective promotion number does not match")
if pull.get("state") != "OPEN":
    raise SystemExit("prospective promotion is not open")
if pull.get("baseRefName") != "master" or pull.get("baseRefOid") != actual_master:
    raise SystemExit("prospective promotion base is not exact current master")
if pull.get("headRefName") != "dev":
    raise SystemExit("prospective promotion head is not dev")
head_repository = pull.get("headRepository")
if (
    not isinstance(head_repository, dict)
    or head_repository.get("nameWithOwner") != repository
):
    raise SystemExit("prospective promotion head repository does not match")
labels = pull.get("labels")
if (
    not isinstance(labels, list)
    or any(
        not isinstance(label, dict) or not isinstance(label.get("name"), str)
        for label in labels
    )
    or not any(label["name"] == "copilot-cli-managed" for label in labels)
):
    raise SystemExit("prospective promotion is not CLI-managed")
head_sha = pull.get("headRefOid")
if not isinstance(head_sha, str) or re.fullmatch(r"[0-9a-f]{40}", head_sha) is None:
    raise SystemExit("prospective promotion head SHA is malformed")
print(head_sha)
PY
  )" || return 1
  fetch_complete_compare \
    "repos/$REPO/compare/${actual_master}...${prospective_sha}" \
    "$compare_file" "$prospective_sha" || return 1
  python3 - "$compare_file" "$actual_master" "$prospective_sha" <<'PY' || return 1
import json
import re
import sys

path, actual_master, prospective_sha = sys.argv[1:]
try:
    compare = json.load(open(path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"prospective promotion compare is malformed: {error}")
if not isinstance(compare, dict):
    raise SystemExit("prospective promotion compare is malformed")
def integer(value):
    return type(value) is int
ahead_by = compare.get("ahead_by")
behind_by = compare.get("behind_by")
total_commits = compare.get("total_commits")
if (
    compare.get("status") != "ahead"
    or not integer(ahead_by)
    or ahead_by < 1
    or not integer(behind_by)
    or behind_by != 0
    or not integer(total_commits)
    or total_commits != ahead_by
):
    raise SystemExit("prospective promotion compare does not prove strict ancestry")
for field, expected in (
    ("base_commit", actual_master),
    ("merge_base_commit", actual_master),
):
    commit = compare.get(field)
    if not isinstance(commit, dict) or commit.get("sha") != expected:
        raise SystemExit(f"prospective promotion compare {field} is not exact")
commits = compare.get("commits")
if not isinstance(commits, list) or len(commits) != total_commits:
    raise SystemExit("prospective promotion compare commit list is incomplete")
commit_shas = []
for commit in commits:
    if not isinstance(commit, dict):
        raise SystemExit("prospective promotion compare commit is malformed")
    sha = commit.get("sha")
    if not isinstance(sha, str) or re.fullmatch(r"[0-9a-f]{40}", sha) is None:
        raise SystemExit("prospective promotion compare commit SHA is malformed")
    commit_shas.append(sha)
if (
    not commit_shas
    or len(set(commit_shas)) != len(commit_shas)
    or commit_shas[-1] != prospective_sha
):
    raise SystemExit("prospective promotion compare commit list does not end at its head")
PY
  rechecked_master="$(read_current_master)" || return 1
  [[ "$rechecked_master" == "$actual_master" ]] || {
    echo "current master changed while verifying prospective promotion" >&2
    return 1
  }
  printf '%s\t%s\n' "$actual_master" "$prospective_sha"
}

tmp_runs="$(mktemp)"
tmp_candidates="$(mktemp)"
tmp_workflows="$(mktemp)"
tmp_successful_runs="$(mktemp)"
tmp_ancestry="$(mktemp)"
tmp_historical_workflow="$(mktemp)"
tmp_run="$(mktemp)"
tmp_workflow="$(mktemp)"
tmp_jobs="$(mktemp)"
tmp_pending="$(mktemp)"
tmp_artifacts="$(mktemp)"
tmp_prospective_ancestry="$(mktemp)"
tmp_compare_pages="$(mktemp)"
cleanup() {
  rm -f \
    "$tmp_runs" "$tmp_candidates" "$tmp_workflows" "$tmp_successful_runs" \
    "$tmp_ancestry" "$tmp_historical_workflow" "$tmp_run" "$tmp_workflow" \
    "$tmp_jobs" "$tmp_pending" "$tmp_artifacts" "$tmp_prospective_ancestry" \
    "$tmp_compare_pages"
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
    if type(total_count) is not int or total_count < 0:
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
            type(run_id) is not int
            or type(run.get("workflow_id")) is not int
            or any(not isinstance(value, str) or not value for value in values[2:7])
            or type(values[7]) is not int
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
  printf '%s\n' "$workflow_json" >"$tmp_workflow"
  printf '%s\n' "$jobs_json" >"$tmp_jobs"
  printf '%s\n' "$pending_json" >"$tmp_pending"
  master_sha=""
  unmaterialized="no"
  prospective_annotation=""
  printf '%s\n' '{"total_count":0,"workflow_runs":[]}' >"$tmp_successful_runs"
  printf '%s\n' '{}' >"$tmp_ancestry"
  printf '%s\n' '{}' >"$tmp_historical_workflow"
  printf '%s\n' '{}' >"$tmp_run"
  printf '%s\n' '{}' >"$tmp_artifacts"
  printf '%s\n' '{}' >"$tmp_prospective_ancestry"
  if [[
    (
      "$path" == ".github/workflows/oci-capacity-acquire.yml" ||
      "$path" == ".github/workflows/oci-live-data-rollout.yml" ||
      "$path" == ".github/workflows/oci-live-betting-activate.yml"
    ) &&
      "$status" == "queued"
  ]]; then
    if ! master_sha="$(read_current_master)"; then
      echo "Current master SHA is unavailable or malformed" >&2
      exit 1
    fi
    [[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || {
      echo "Run $run_id has a malformed head SHA" >&2
      exit 1
    }
    gh api \
      "repos/$REPO/actions/workflows/$workflow_id/runs?head_sha=$head_sha&event=workflow_dispatch&status=success&per_page=100" \
      >"$tmp_successful_runs"
    if [[ "$head_sha" != "$master_sha" ]]; then
      fetch_complete_compare \
        "repos/$REPO/compare/$head_sha...$master_sha" \
        "$tmp_ancestry" "$master_sha" || {
        echo "GitHub compare evidence could not be compactly completed" >&2
        exit 1
      }
    fi
    gh api "repos/$REPO/actions/runs/$run_id" >"$tmp_run"
    gh api "repos/$REPO/actions/runs/$run_id/artifacts?per_page=1" \
      >"$tmp_artifacts"
    gh api "repos/$REPO/contents/$path?ref=$head_sha" \
      >"$tmp_historical_workflow"
    if "$AUTHORITY_HELPER" classify-unmaterialized-run \
      --run-json "$tmp_run" \
      --workflow-json "$tmp_workflow" \
      --jobs-json "$tmp_jobs" \
      --pending-json "$tmp_pending" \
      --artifacts-json "$tmp_artifacts" \
      --compare-json "$tmp_ancestry" \
      --historical-workflow-json "$tmp_historical_workflow" \
      --repository "$REPO" \
      --current-master "$master_sha" \
      --expected-run-id "$run_id" \
      --expected-workflow-id "$workflow_id" \
      --expected-path "$path" \
      --expected-head-sha "$head_sha" \
      --minimum-age-seconds "$STALE_DISABLED_MIN_AGE_SECONDS" \
      --now-epoch "$NOW_EPOCH" >/dev/null 2>&1; then
      unmaterialized="yes"
    fi
    if [[
      -n "$PROSPECTIVE_PROMOTION_PR" &&
        "$head_sha" == "$master_sha" &&
        "$event" == "workflow_dispatch" &&
        "$run_attempt" == "1"
    ]]; then
      if ! prospective_context="$(
        verify_prospective_promotion "$tmp_prospective_ancestry"
      )"; then
        echo "prospective promotion bootstrap is invalid" >&2
        exit 1
      fi
      IFS=$'\t' read -r prospective_actual_master prospective_master_sha \
        <<<"$prospective_context"
      [[
        "$prospective_actual_master" == "$master_sha" &&
          "$prospective_master_sha" =~ ^[0-9a-f]{40}$
      ]] || {
        echo "prospective promotion bootstrap context is malformed" >&2
        exit 1
      }
      if "$AUTHORITY_HELPER" classify-unmaterialized-run \
        --run-json "$tmp_run" \
        --workflow-json "$tmp_workflow" \
        --jobs-json "$tmp_jobs" \
        --pending-json "$tmp_pending" \
        --artifacts-json "$tmp_artifacts" \
        --compare-json "$tmp_prospective_ancestry" \
        --historical-workflow-json "$tmp_historical_workflow" \
        --repository "$REPO" \
        --current-master "$prospective_master_sha" \
        --expected-run-id "$run_id" \
        --expected-workflow-id "$workflow_id" \
        --expected-path "$path" \
        --expected-head-sha "$head_sha" \
        --minimum-age-seconds "$STALE_DISABLED_MIN_AGE_SECONDS" \
        --now-epoch "$NOW_EPOCH" >/dev/null 2>&1; then
        unmaterialized="yes"
        prospective_annotation=" prospective_unmaterialized=yes"
        prospective_annotation+=" prospective_promotion_pr=$PROSPECTIVE_PROMOTION_PR"
        prospective_annotation+=" actual_master_sha=$master_sha"
        prospective_annotation+=" prospective_master_sha=$prospective_master_sha"
      fi
    fi
  fi
  classification="$(
    python3 - "$workflow_json" "$jobs_json" "$pending_json" \
      "$tmp_successful_runs" "$tmp_ancestry" "$tmp_historical_workflow" \
      "$run_id" "$workflow_id" "$path" "$status" "$updated_at" "$head_sha" \
      "$event" "$run_attempt" "$master_sha" "$NOW_EPOCH" \
      "$STALE_DISABLED_MIN_AGE_SECONDS" "$unmaterialized" <<'PY'
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
unmaterialized = sys.argv[18]
state = workflow.get("state")
job_count = jobs.get("total_count")
job_entries = jobs.get("jobs")
successful_count = successful_runs.get("total_count")
successful_entries = successful_runs.get("workflow_runs")
if (
    not isinstance(state, str)
    or workflow.get("path") != path
    or type(job_count) is not int
    or job_count < 0
    or not isinstance(job_entries, list)
    or not isinstance(pending, list)
    or type(successful_count) is not int
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
    # A queued jobless record can only be ignored through the exact
    # unmaterialized or supersession classifiers. The generic disabled path
    # must never bypass their current-master and workflow allowlists, including
    # a manual run whose provider status changes before it materializes.
    and status != "queued"
    and event != "workflow_dispatch"
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

if unmaterialized not in {"yes", "no"}:
    raise SystemExit("unmaterialized classifier result is malformed")
inert = disabled_inert or bool(superseded_by) or unmaterialized == "yes"
reason = (
    "disabled"
    if disabled_inert
    else "superseded"
    if superseded_by
    else "unmaterialized"
    if unmaterialized == "yes"
    else "none"
)
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
    echo "ignored_inert_run=$run_id path=$path status=$status $classification$prospective_annotation"
    continue
  fi

  echo "active production run $run_id path=$path status=$status $classification" >&2
  exit 1
done <"$tmp_candidates"

echo "production_run_exclusivity=PASS"
