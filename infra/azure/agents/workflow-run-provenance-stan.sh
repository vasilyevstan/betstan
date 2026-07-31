#!/usr/bin/env bash
set -euo pipefail

# Purpose: find a successful trusted workflow run that verifiably built or deployed TARGET_SHA.

REPO="${REPO:-vasilyevstan/betstan}"
WORKFLOW="${WORKFLOW:-}"
TARGET_SHA="${TARGET_SHA:-}"

for bin in gh git python3; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "ERROR: required binary missing: $bin" >&2
    exit 1
  }
done

case "$WORKFLOW" in
  production-build)
    workflow_file="production-build.yml"
    ;;
  production-deploy)
    workflow_file="production-deploy.yml"
    ;;
  *)
    echo "ERROR: WORKFLOW must be production-build or production-deploy" >&2
    exit 1
    ;;
esac

if ! [[ "$TARGET_SHA" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  echo "ERROR: TARGET_SHA must be 7..40 hex characters" >&2
  exit 1
fi
if ! target_sha_full="$(git rev-parse "${TARGET_SHA}^{commit}" 2>/dev/null)"; then
  echo "ERROR: TARGET_SHA is not available in the local repository: $TARGET_SHA" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

trusted_workflow_id="$(
  gh api "repos/$REPO/actions/workflows/$workflow_file" --jq '.id'
)"
[[ -n "$trusted_workflow_id" ]] || exit 1

runs_file="$tmp_dir/runs.json"
if [[ "$WORKFLOW" == "production-build" ]]; then
  gh run list --repo "$REPO" --workflow "$workflow_file" \
    --commit "$target_sha_full" --limit 100 \
    --json databaseId,event,headSha,status,conclusion,url > "$runs_file"
else
  gh run list --repo "$REPO" --workflow "$workflow_file" --limit 200 \
    --json databaseId,displayTitle,event,headSha,status,conclusion,url > "$runs_file"
fi

candidate_file="$tmp_dir/candidates"
python3 - "$runs_file" "$WORKFLOW" "$target_sha_full" > "$candidate_file" <<'PY'
import json
import sys

runs_file, workflow, target_sha = sys.argv[1:]
runs = json.load(open(runs_file, encoding="utf-8"))
expected_title = f"deploy {target_sha}"

for run in runs:
    if workflow == "production-build":
        if run.get("event") != "push":
            continue
        if run.get("headSha") != target_sha:
            continue
    else:
        if run.get("event") != "workflow_dispatch":
            continue
        if run.get("displayTitle") != expected_title:
            continue
    print(run.get("databaseId", ""))
PY

while IFS= read -r run_id; do
  [[ -n "$run_id" ]] || continue
  metadata_file="$tmp_dir/run-$run_id.json"
  gh api "repos/$REPO/actions/runs/$run_id/attempts/1" > "$metadata_file"

  if ! python3 - "$metadata_file" "$trusted_workflow_id" \
    ".github/workflows/$workflow_file" "$WORKFLOW" "$target_sha_full" <<'PY'
import json
import sys

metadata_file, workflow_id, path, workflow, target_sha = sys.argv[1:]
run = json.load(open(metadata_file, encoding="utf-8"))
valid = (
    str(run.get("workflow_id", "")) == workflow_id
    and run.get("path") == path
    and run.get("status") == "completed"
    and run.get("conclusion") == "success"
)
if workflow == "production-build":
    valid = (
        valid
        and run.get("event") == "push"
        and run.get("head_sha") == target_sha
        and run.get("run_attempt") == 1
    )
else:
    valid = (
        valid
        and run.get("event") == "workflow_dispatch"
        and run.get("display_title") == f"deploy {target_sha}"
        and run.get("run_attempt") == 1
    )
sys.exit(0 if valid else 1)
PY
  then
    continue
  fi

  if [[ "$WORKFLOW" == "production-deploy" ]]; then
    read -r run_attempt run_event run_url <<<"$(
      python3 - "$metadata_file" <<'PY'
import json
import sys

run = json.load(open(sys.argv[1], encoding="utf-8"))
print(run.get("run_attempt", ""), run.get("event", ""), run.get("html_url", ""))
PY
    )"
    artifact_dir="$tmp_dir/artifact-$run_id"
    mkdir -p "$artifact_dir"
    if ! gh run download "$run_id" --repo "$REPO" \
      --name "deploy-provenance-${run_id}-${run_attempt}" \
      --dir "$artifact_dir" >/dev/null 2>&1; then
      continue
    fi
    provenance_file="$artifact_dir/provenance.txt"
    images_file="$artifact_dir/images.tsv"
    [[ -f "$provenance_file" ]] || continue
    [[ -f "$images_file" ]] || continue
    deployed_sha="$(sed -n 's/^image_sha=//p' "$provenance_file")"
    upstream_run_id="$(sed -n 's/^upstream_run_id=//p' "$provenance_file")"
    upstream_event="$(sed -n 's/^upstream_event=//p' "$provenance_file")"
    upstream_attempt="$(sed -n 's/^upstream_run_attempt=//p' "$provenance_file")"
    [[ "$deployed_sha" == "$target_sha_full" ]] || continue
    [[ "$run_event" == "workflow_dispatch" ]] || continue
    [[ "$upstream_run_id" =~ ^[0-9]+$ ]] || continue
    [[ "$upstream_event" == "push" ]] || continue
    [[ "$upstream_attempt" == "1" ]] || continue
    [[ "$(wc -l < "$images_file" | tr -d ' ')" == "9" ]] || continue

    upstream_file="$tmp_dir/upstream-$upstream_run_id.json"
    gh api "repos/$REPO/actions/runs/$upstream_run_id/attempts/1" > "$upstream_file"
    trusted_build_id="$(
      gh api "repos/$REPO/actions/workflows/production-build.yml" --jq '.id'
    )"
    if ! python3 - "$upstream_file" "$trusted_build_id" "$target_sha_full" <<'PY'
import json
import sys

run = json.load(open(sys.argv[1], encoding="utf-8"))
valid = (
    str(run.get("workflow_id", "")) == sys.argv[2]
    and run.get("path") == ".github/workflows/production-build.yml"
    and run.get("event") == "push"
    and run.get("head_sha") == sys.argv[3]
    and run.get("status") == "completed"
    and run.get("conclusion") == "success"
    and run.get("run_attempt") == 1
)
sys.exit(0 if valid else 1)
PY
    then
      continue
    fi
  fi

  python3 - "$metadata_file" <<'PY'
import json
import sys

run = json.load(open(sys.argv[1], encoding="utf-8"))
print(
    run.get("id", ""),
    run.get("status", ""),
    run.get("conclusion", ""),
    run.get("html_url", ""),
    sep="\t",
)
PY
  exit 0
done < "$candidate_file"

exit 1
