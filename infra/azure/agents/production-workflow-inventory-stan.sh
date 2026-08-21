#!/usr/bin/env bash
set -euo pipefail

# Purpose: discover every production-capable workflow at an exact PR head.
# Usage:
#   PR=63 ./infra/azure/agents/production-workflow-inventory-stan.sh
#   WORKFLOW_DIR=.github/workflows ./infra/azure/agents/production-workflow-inventory-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPO="${REPO:-vasilyevstan/betstan}"
PR_NUMBER="${1:-${PR:-}}"
EXPECTED_HEAD_SHA="${EXPECTED_HEAD_SHA:-}"
WORKFLOW_DIR="${WORKFLOW_DIR:-}"
EXTRA_LOCAL_WORKFLOW_PATHS_FILE="${WORKFLOW_INVENTORY_EXTRA_LOCAL_PATHS_FILE:-}"
tmp_dir=""

create_unique_dir() {
  python3 - "$1" "$2" <<'PY'
import sys
import uuid
from pathlib import Path

parent = Path(sys.argv[1])
prefix = sys.argv[2]
parent.mkdir(mode=0o700, parents=True, exist_ok=True)
for _ in range(64):
    candidate = parent / f"{prefix}-{uuid.uuid4().hex}"
    try:
        candidate.mkdir(mode=0o700)
    except FileExistsError:
        continue
    print(candidate)
    raise SystemExit(0)
raise SystemExit("unable to allocate workflow inventory workdir")
PY
}

fail() {
  echo "$*" >&2
  exit 1
}

require_full_sha() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] ||
    fail "$label must be a complete lowercase 40-character SHA"
}

require_safe_workflow_repo_path() {
  local label="$1"
  local path="$2"
  python3 - "$label" "$path" <<'PY'
import sys

label = sys.argv[1]
path = sys.argv[2]

def render(value: str) -> str:
    return value.encode("unicode_escape").decode("ascii")

parts = path.split("/")
valid_prefix = len(parts) == 3 and parts[0] == ".github" and parts[1] == "workflows"
basename = parts[2] if valid_prefix else ""
valid_extension = basename.endswith(".yml") or basename.endswith(".yaml")
stem = basename[: -5 if basename.endswith(".yaml") else -4] if valid_extension else ""

if (
    any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in path)
    or "\u2028" in path
    or "\u2029" in path
    or "\\" in path
    or "%" in path
    or not valid_prefix
    or basename in {"", ".", ".."}
    or not valid_extension
    or stem == ""
):
    raise SystemExit(f"{label} contained an unsafe path: {render(path)}")
PY
}

url_encode_workflow_repo_path() {
  local path="$1"
  require_safe_workflow_repo_path "workflow API request path" "$path" >/dev/null
  python3 - "$path" <<'PY'
import sys
import urllib.parse

print(urllib.parse.quote(sys.argv[1], safe="/"))
PY
}

validate_workflow_repo_path_stream() {
  local label="$1"
  python3 -c "$(cat <<'PY'
import sys
import unicodedata

label = sys.argv[1]
data = sys.stdin.buffer.read()

def render(value: str) -> str:
    return value.encode("unicode_escape").decode("ascii")

def fail(message: str) -> None:
    raise SystemExit(message)

def decode_chunks(raw: bytes):
    if not raw:
        return []
    chunks = raw.split(b"\0")
    if chunks and chunks[-1] == b"":
        chunks.pop()
    paths = []
    for chunk in chunks:
        try:
            paths.append(chunk.decode("utf-8", "strict"))
        except UnicodeDecodeError as exc:
            fail(f"{label} contained a non-UTF-8 path entry: {exc}")
    return paths

def validate_path(path: str) -> None:
    parts = path.split("/")
    valid_prefix = len(parts) == 3 and parts[0] == ".github" and parts[1] == "workflows"
    basename = parts[2] if valid_prefix else ""
    valid_extension = basename.endswith(".yml") or basename.endswith(".yaml")
    stem = basename[: -5 if basename.endswith(".yaml") else -4] if valid_extension else ""
    if (
        any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in path)
        or "\u2028" in path
        or "\u2029" in path
        or "\\" in path
        or "%" in path
        or not valid_prefix
        or basename in {"", ".", ".."}
        or not valid_extension
        or stem == ""
    ):
        fail(f"{label} contained an unsafe path: {render(path)}")

paths = decode_chunks(data)
seen_paths = set()
collision_keys = {}
for path in paths:
    validate_path(path)
    if path in seen_paths:
        fail(f"{label} contained a duplicate path: {render(path)}")
    seen_paths.add(path)
    collision_key = unicodedata.normalize(
        "NFC",
        unicodedata.normalize("NFC", path).casefold(),
    )
    other = collision_keys.get(collision_key)
    if other is not None and other != path:
        fail(
            f"{label} contained a normalization collision: "
            f"{render(other)} collides with {render(path)}"
        )
    collision_keys[collision_key] = path

for path in paths:
    sys.stdout.buffer.write(path.encode("utf-8") + b"\0")
PY
)" "$label"
}

read_pr_head_sha() {
  local json
  json="$(
    gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid
  )" || fail "unable to read PR head metadata"
  python3 - "$json" <<'PY'
import json
import re
import sys

try:
    payload = json.loads(sys.argv[1])
except json.JSONDecodeError as exc:
    raise SystemExit(f"PR head metadata response was not valid JSON: {exc}") from exc

head_sha = payload.get("headRefOid")
if not isinstance(head_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", head_sha):
    raise SystemExit("PR head metadata did not contain a complete lowercase commit SHA")

print(head_sha)
PY
}

resolve_pr_head_tree_sha() {
  local commit_sha="$1"
  local json
  json="$(
    gh api "repos/$REPO/git/commits/$commit_sha"
  )" || fail "unable to resolve PR head commit $commit_sha"
  python3 - "$commit_sha" "$json" <<'PY'
import json
import re
import sys

commit_sha = sys.argv[1]

try:
    payload = json.loads(sys.argv[2])
except json.JSONDecodeError as exc:
    raise SystemExit(f"PR head commit response was not valid JSON: {exc}") from exc

resolved_sha = payload.get("sha")
if resolved_sha != commit_sha or not re.fullmatch(r"[0-9a-f]{40}", resolved_sha or ""):
    raise SystemExit("PR head commit response did not bind to the requested commit SHA")

tree = payload.get("tree")
if not isinstance(tree, dict):
    raise SystemExit("PR head commit response did not include a tree object")

tree_sha = tree.get("sha")
if not isinstance(tree_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", tree_sha):
    raise SystemExit("PR head commit response did not include a complete lowercase tree SHA")

tree_url = tree.get("url")
if not isinstance(tree_url, str) or not tree_url.rstrip("/").endswith(f"/git/trees/{tree_sha}"):
    raise SystemExit("PR head commit response did not preserve the commit/tree association")

print(tree_sha)
PY
}

list_pr_workflow_paths() {
  local tree_sha="$1"
  local json
  json="$(
    gh api "repos/$REPO/git/trees/$tree_sha?recursive=1"
  )" || fail "unable to enumerate workflows for PR head tree $tree_sha"
  python3 - "$tree_sha" "$json" <<'PY' | validate_workflow_repo_path_stream "PR workflow tree response"
import json
import sys
import urllib.parse

tree_sha = sys.argv[1]

try:
    payload = json.loads(sys.argv[2])
except json.JSONDecodeError as exc:
    raise SystemExit(f"PR workflow tree response was not valid JSON: {exc}") from exc

if payload.get("sha") != tree_sha:
    raise SystemExit("PR workflow tree response did not match the resolved tree SHA")

if payload.get("truncated") is not False:
    raise SystemExit("PR workflow tree response was truncated")

entries = payload.get("tree")
if not isinstance(entries, list):
    raise SystemExit("PR workflow tree response did not include a tree listing")

def is_workflow_candidate(value: str) -> bool:
    decoded = urllib.parse.unquote(value)
    normalized = decoded.replace("\\", "/")
    while "//" in normalized:
        normalized = normalized.replace("//", "/")
    parts = normalized.split("/")
    return len(parts) >= 2 and parts[0] == ".github" and parts[1] == "workflows"

for entry in entries:
    if not isinstance(entry, dict):
        raise SystemExit("PR workflow tree response contained a malformed tree entry")
    path = entry.get("path")
    entry_type = entry.get("type")
    if not isinstance(path, str) or not isinstance(entry_type, str):
        raise SystemExit("PR workflow tree response contained a malformed tree entry")
    if not is_workflow_candidate(path):
        continue
    if entry_type != "blob":
        continue
    sys.stdout.buffer.write(path.encode("utf-8") + b"\0")
PY
}

download_pr_workflow_file() {
  local commit_sha="$1"
  local path="$2"
  local output="$3"
  require_safe_workflow_repo_path "PR workflow fetch request" "$path" >/dev/null
  local encoded_path
  encoded_path="$(url_encode_workflow_repo_path "$path")"
  local json
  json="$(
    gh api "repos/$REPO/contents/$encoded_path?ref=$commit_sha"
  )" || fail "unable to fetch workflow $path from PR head $commit_sha"
  python3 - "$path" "$output" "$json" <<'PY'
import base64
import json
import re
import sys
from pathlib import Path

requested_path = sys.argv[1]
output_path = Path(sys.argv[2])

def render(value: str) -> str:
    return value.encode("unicode_escape").decode("ascii")

def require_safe_workflow_path(label: str, value: str) -> str:
    parts = value.split("/")
    valid_prefix = len(parts) == 3 and parts[0] == ".github" and parts[1] == "workflows"
    basename = parts[2] if valid_prefix else ""
    valid_extension = basename.endswith(".yml") or basename.endswith(".yaml")
    stem = basename[: -5 if basename.endswith(".yaml") else -4] if valid_extension else ""
    if (
        any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value)
        or "\u2028" in value
        or "\u2029" in value
        or "\\" in value
        or "%" in value
        or not valid_prefix
        or basename in {"", ".", ".."}
        or not valid_extension
        or stem == ""
    ):
        raise SystemExit(f"{label} contained an unsafe path: {render(value)}")
    return value

try:
    payload = json.loads(sys.argv[3])
except json.JSONDecodeError as exc:
    raise SystemExit(f"workflow contents response for {requested_path} was not valid JSON: {exc}") from exc

require_safe_workflow_path("PR workflow fetch request", requested_path)
response_path = payload.get("path")
if not isinstance(response_path, str):
    raise SystemExit(f"workflow contents response for {requested_path} did not include a valid path")
require_safe_workflow_path("workflow contents response path", response_path)

if response_path != requested_path:
    raise SystemExit(f"workflow contents response for {requested_path} did not match the requested path")

blob_sha = payload.get("sha")
if not isinstance(blob_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", blob_sha):
    raise SystemExit(f"workflow contents response for {requested_path} did not include a valid blob SHA")

if payload.get("type") != "file":
    raise SystemExit(f"workflow contents response for {requested_path} was not a file")

if payload.get("encoding") != "base64":
    raise SystemExit(f"workflow contents response for {requested_path} was not base64 encoded")

content = payload.get("content")
if not isinstance(content, str) or not content.strip():
    raise SystemExit(f"workflow contents response for {requested_path} did not include file content")

try:
    decoded = base64.b64decode("".join(content.split()), validate=True)
except Exception as exc:  # noqa: BLE001
    raise SystemExit(f"workflow contents response for {requested_path} had invalid base64 content: {exc}") from exc

output_path.write_bytes(decoded)
PY
}

list_local_workflow_repo_paths() {
  local workflow_dir="$1"
  {
    python3 - "$workflow_dir" <<'PY'
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
for current_root, dir_names, file_names in os.walk(root, topdown=True, followlinks=False):
    dir_names.sort()
    file_names.sort()
    current_path = Path(current_root)
    relative_root = current_path.relative_to(root)
    for name in file_names:
        relative_path = Path(name) if relative_root == Path(".") else relative_root / name
        repo_path = ".github/workflows/" + relative_path.as_posix()
        sys.stdout.buffer.write(repo_path.encode("utf-8") + b"\0")
PY
    if [[ -n "$EXTRA_LOCAL_WORKFLOW_PATHS_FILE" ]]; then
      [[ -f "$EXTRA_LOCAL_WORKFLOW_PATHS_FILE" ]] || {
        fail "workflow inventory extra local path file not found: $EXTRA_LOCAL_WORKFLOW_PATHS_FILE"
      }
      cat -- "$EXTRA_LOCAL_WORKFLOW_PATHS_FILE"
    fi
  } | validate_workflow_repo_path_stream "local workflow directory"
}

validate_local_workflow_dir() {
  local workflow_dir="$1"
  [[ -n "$tmp_dir" ]] || tmp_dir="$(create_unique_dir "$ROOT_DIR/.workflow-inventory-workdirs" inventory)"
  local paths_file="$tmp_dir/local-workflow-paths.bin"
  list_local_workflow_repo_paths "$workflow_dir" >"$paths_file"
  local path
  while IFS= read -r -d '' path; do
    [[ -n "$path" ]] || continue
    require_safe_workflow_repo_path "local workflow directory" "$path" >/dev/null
  done <"$paths_file"
}

cleanup() {
  if [[ -n "$tmp_dir" ]]; then
    rm -rf -- "$tmp_dir"
  fi
}
trap cleanup EXIT

if [[ -z "$WORKFLOW_DIR" && -n "$PR_NUMBER" ]]; then
  [[ -z "$EXPECTED_HEAD_SHA" ]] || require_full_sha "EXPECTED_HEAD_SHA" "$EXPECTED_HEAD_SHA"
  initial_head="$(read_pr_head_sha)"
  require_full_sha "PR head SHA" "$initial_head"
  [[ -z "$EXPECTED_HEAD_SHA" || "$initial_head" == "$EXPECTED_HEAD_SHA" ]] || {
    echo "PR head changed before workflow inventory" >&2
    exit 1
  }
  resolved_tree_sha="$(resolve_pr_head_tree_sha "$initial_head")"
  require_full_sha "PR head tree SHA" "$resolved_tree_sha"

  tmp_dir="$(create_unique_dir "$ROOT_DIR/.workflow-inventory-workdirs" inventory)"
  WORKFLOW_DIR="$tmp_dir/.github/workflows"
  local_paths_file="$tmp_dir/pr-workflow-paths.bin"
  mkdir -p "$WORKFLOW_DIR"
  list_pr_workflow_paths "$resolved_tree_sha" >"$local_paths_file"
  while IFS= read -r -d '' path; do
    [[ -n "$path" ]] || continue
    require_safe_workflow_repo_path "PR workflow tree path" "$path" >/dev/null
    output="$tmp_dir/$path"
    mkdir -p "$(dirname "$output")"
    download_pr_workflow_file "$initial_head" "$path" "$output"
  done <"$local_paths_file"

  final_head="$(read_pr_head_sha)"
  require_full_sha "final PR head SHA" "$final_head"
  [[ "$final_head" == "$initial_head" ]] || {
    echo "PR head changed during workflow inventory" >&2
    exit 1
  }
elif [[ -z "$WORKFLOW_DIR" ]]; then
  WORKFLOW_DIR="$ROOT_DIR/.github/workflows"
fi

[[ -d "$WORKFLOW_DIR" ]] || {
  echo "workflow directory not found: $WORKFLOW_DIR" >&2
  exit 1
}

validate_local_workflow_dir "$WORKFLOW_DIR"

workflow_set="$(
  ruby "$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.rb" \
    "$WORKFLOW_DIR"
)"

grep -qx "production-build" <<<"$workflow_set" || {
  echo "production-build was not found in the workflow inventory" >&2
  exit 1
}
grep -qx "production-deploy" <<<"$workflow_set" || {
  echo "production-deploy was not found in the workflow inventory" >&2
  exit 1
}
grep -qx "production-rollback" <<<"$workflow_set" || {
  echo "production-rollback was not found in the workflow inventory" >&2
  exit 1
}
grep -qx "oci-production-rollback" <<<"$workflow_set" || {
  echo "oci-production-rollback was not found in the workflow inventory" >&2
  exit 1
}

echo "production_workflows=$(paste -sd, - <<<"$workflow_set")"
