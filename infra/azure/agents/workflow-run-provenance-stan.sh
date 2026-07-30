#!/usr/bin/env bash
set -euo pipefail

# Purpose: find a successful workflow run that verifiably built or deployed TARGET_SHA.

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
  build-push)
    workflow_file="build-push.yml"
    ;;
  deploy-manifests)
    workflow_file="deploy-manifests.yml"
    ;;
  *)
    echo "ERROR: WORKFLOW must be build-push or deploy-manifests" >&2
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

runs_file="$(mktemp)"
run_metadata_file="$(mktemp)"
run_log_file="$(mktemp)"
cleanup() {
  rm -f "$runs_file" "$run_metadata_file" "$run_log_file"
}
trap cleanup EXIT

if [[ "$WORKFLOW" == "build-push" ]]; then
  gh run list \
    --repo "$REPO" \
    --workflow "$workflow_file" \
    --commit "$target_sha_full" \
    --limit 100 \
    --json databaseId,displayTitle,event,headSha,status,conclusion,url > "$runs_file"
else
  gh run list \
    --repo "$REPO" \
    --workflow "$workflow_file" \
    --limit 100 \
    --json databaseId,displayTitle,event,headSha,status,conclusion,url > "$runs_file"
fi

exact_record="$(
  python3 - "$runs_file" "$WORKFLOW" "$target_sha_full" <<'PY'
import json
import sys

runs_file, workflow, target_sha = sys.argv[1:]
with open(runs_file, "r", encoding="utf-8") as handle:
    runs = json.load(handle)

expected_title = f"deploy-manifests {target_sha}"
for run in runs:
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        continue
    if workflow == "build-push":
        if run.get("event") not in {"push", "workflow_dispatch"}:
            continue
        if run.get("headSha") != target_sha:
            continue
    else:
        if run.get("event") not in {"workflow_run", "workflow_dispatch"}:
            continue
        if run.get("displayTitle") != expected_title:
            continue
    print(
        run.get("databaseId", ""),
        run.get("status", ""),
        run.get("conclusion", ""),
        run.get("url", ""),
        sep="\t",
    )
    break
PY
)"

if [[ -n "$exact_record" ]]; then
  echo "$exact_record"
  exit 0
fi

if [[ "$WORKFLOW" != "deploy-manifests" ]]; then
  exit 1
fi

# Runs created before SHA-specific run names are restricted to audited immutable pairs.
case "$target_sha_full" in
  463c9247ea50166686ab5e3956e5294de4e6931b)
    legacy_run_id=30565277544
    ;;
  4630d76dca8b5707a0648693c75605c49f311ec2)
    legacy_run_id=30565249116
    ;;
  *)
    exit 1
    ;;
esac

gh run view "$legacy_run_id" \
  --repo "$REPO" \
  --json databaseId,displayTitle,event,status,conclusion,url,workflowName \
  > "$run_metadata_file"

legacy_record="$(
  python3 - "$run_metadata_file" "$legacy_run_id" <<'PY'
import json
import sys

metadata_file, expected_run_id = sys.argv[1:]
with open(metadata_file, "r", encoding="utf-8") as handle:
    run = json.load(handle)

if (
    str(run.get("databaseId", "")) == expected_run_id
    and run.get("workflowName") == "deploy-manifests"
    and run.get("displayTitle") == "deploy-manifests"
    and run.get("event") == "workflow_run"
    and run.get("status") == "completed"
    and run.get("conclusion") == "success"
):
    print(
        run.get("databaseId", ""),
        run.get("status", ""),
        run.get("conclusion", ""),
        run.get("url", ""),
        sep="\t",
    )
PY
)"

[[ -n "$legacy_record" ]] || exit 1

if gh run view "$legacy_run_id" --repo "$REPO" --log > "$run_log_file" 2>/dev/null &&
  python3 - "$run_log_file" "$target_sha_full" <<'PY'
import sys

log_file, target_sha = sys.argv[1:]
expected_payload = f"IMAGE_TAG: {target_sha}"

with open(log_file, "r", encoding="utf-8", errors="replace") as handle:
    for line in handle:
        fields = line.rstrip("\r\n").split("\t", 2)
        if len(fields) != 3:
            continue
        timestamp_and_payload = fields[2].split(maxsplit=1)
        if len(timestamp_and_payload) != 2:
            continue
        if timestamp_and_payload[1].strip() == expected_payload:
            sys.exit(0)

sys.exit(1)
PY
then
  echo "$legacy_record"
  exit 0
fi

exit 1
