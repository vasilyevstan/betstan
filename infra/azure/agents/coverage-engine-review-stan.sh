#!/usr/bin/env bash
set -euo pipefail

umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXPECTED_REPOSITORY="vasilyevstan/betstan"
ENGINE_PATH=".github/scripts/test-coverage-matrix.js"
HARNESS_PATH=".github/scripts/test-test-coverage-matrix.js"
PUBLISHER_PATH=".github/scripts/publish-pr-policy.js"
REVIEW_PATH="infra/azure/agents/coverage-engine-review-stan.sh"
INVOCATION_PATH="infra/azure/agents/test-deployment-safety-ci-stan.sh"
EXPECTED_DEFAULT_BRANCH="master"
PINNED_IMAGE="docker.io/library/node@sha256:4bd021da81659dd1da4a96539550966c493033f5386961ac1201e5de1daca909"
EXPECTED_NODE_VERSION="20.19.5"
EXPECTED_PLATFORM="linux/amd64"
EXPECTED_TEST_COUNT=102
MAX_AUTHORIZATION_AGE_SECONDS=$((7 * 24 * 60 * 60))
MAX_FETCH_BYTES=$((1024 * 1024))
MAX_API_BYTES=$((8 * 1024 * 1024))
MAX_OUTPUT_BYTES=$((4 * 1024 * 1024))
CONTAINER_TIMEOUT_SECONDS=600

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-coverage-review.XXXXXX")"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

fail() {
  printf 'coverage_engine_review=FAIL reason=%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "missing-$1"
}

hash_file() {
  git hash-object --no-filters -- "$1" 2>/dev/null ||
    fail "cannot-hash-coverage-asset"
}

require_regular_file() {
  [[ -f "$1" && ! -L "$1" ]] ||
    fail "coverage-asset-missing-or-symlinked"
}

load_repository_file() {
  local ref="$1"
  local relative_path="$2"
  local destination="$3"

  if git cat-file -e "${ref}:${relative_path}" 2>/dev/null; then
    git show "${ref}:${relative_path}" >"$destination" 2>/dev/null ||
      fail "cannot-read-trusted-coverage-asset"
  else
    require_command curl
    curl -q \
      --fail \
      --silent \
      --show-error \
      --proto '=https' \
      --connect-timeout 10 \
      --max-time 30 \
      --max-filesize "$MAX_FETCH_BYTES" \
      "https://raw.githubusercontent.com/${EXPECTED_REPOSITORY}/${ref}/${relative_path}" \
      >"$destination" 2>/dev/null ||
      fail "cannot-fetch-trusted-coverage-asset"
  fi

  [[ -f "$destination" && ! -L "$destination" ]] ||
    fail "trusted-coverage-asset-is-not-regular"
  [[ "$(wc -c <"$destination" | tr -d ' ')" -le "$MAX_FETCH_BYTES" ]] ||
    fail "trusted-coverage-asset-is-oversized"
}

github_api_get() {
  local endpoint="$1"
  local destination="$2"

  require_command curl
  curl -q \
    --fail \
    --silent \
    --show-error \
    --proto '=https' \
    --connect-timeout 10 \
    --max-time 30 \
    --max-filesize "$MAX_API_BYTES" \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: betstan-coverage-review" \
    "https://api.github.com/repos/${EXPECTED_REPOSITORY}/${endpoint}" \
    >"$destination" 2>/dev/null ||
    fail "cannot-query-trusted-repository"
  [[ -f "$destination" && ! -L "$destination" ]] ||
    fail "trusted-repository-response-is-not-regular"
  [[ "$(wc -c <"$destination" | tr -d ' ')" -le "$MAX_API_BYTES" ]] ||
    fail "trusted-repository-response-is-oversized"
}

resolve_default_branch_sha() {
  local default_branch="$1"
  local destination="$2"
  local response="$work_dir/default-branch.json"

  [[ "$default_branch" == "$EXPECTED_DEFAULT_BRANCH" ]] ||
    fail "unexpected-default-branch"
  github_api_get "commits/${default_branch}" "$response"
  python3 - "$response" "$destination" <<'PY'
import json
import pathlib
import re
import sys

response_path, destination = sys.argv[1:]
value = json.loads(pathlib.Path(response_path).read_text(encoding="utf-8"))
sha = value.get("sha") if isinstance(value, dict) else None
if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
    raise SystemExit(1)
pathlib.Path(destination).write_text(sha + "\n", encoding="ascii")
PY
}

resolve_repository_ref_sha() {
  local ref="$1"
  local destination="$2"
  local response="$work_dir/ref-${ref//\//-}.json"

  github_api_get "commits/${ref}" "$response"
  python3 - "$response" "$destination" <<'PY'
import json
import pathlib
import re
import sys

response_path, destination = sys.argv[1:]
value = json.loads(pathlib.Path(response_path).read_text(encoding="utf-8"))
sha = value.get("sha") if isinstance(value, dict) else None
if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
    raise SystemExit(1)
pathlib.Path(destination).write_text(sha + "\n", encoding="ascii")
PY
}

relationship_counter=0
assert_commit_relationship() {
  local first_sha="$1"
  local second_sha="$2"
  local expected_merge_base="$3"
  local mode="$4"
  local merge_base
  local shallow
  local response

  shallow="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
  if [[ "$shallow" == "false" ]] &&
    git cat-file -e "${first_sha}^{commit}" 2>/dev/null &&
    git cat-file -e "${second_sha}^{commit}" 2>/dev/null; then
    merge_base="$(git merge-base "$first_sha" "$second_sha" 2>/dev/null)" ||
      return 1
    [[ "$merge_base" == "$expected_merge_base" ]] ||
      return 1
    if [[ "$mode" == "ancestor" ]]; then
      [[ "$expected_merge_base" == "$first_sha" ]] ||
        return 1
      git merge-base --is-ancestor "$first_sha" "$second_sha" 2>/dev/null ||
        return 1
    elif [[ "$mode" != "merge-base" ]]; then
      return 1
    fi
    return 0
  fi

  relationship_counter=$((relationship_counter + 1))
  response="$work_dir/compare-${relationship_counter}.json"
  github_api_get "compare/${first_sha}...${second_sha}" "$response"
  python3 - \
    "$response" \
    "$expected_merge_base" \
    "$first_sha" \
    "$mode" <<'PY'
import json
import pathlib
import re
import sys

response_path, expected_merge_base, first_sha, mode = sys.argv[1:]
value = json.loads(pathlib.Path(response_path).read_text(encoding="utf-8"))
status = value.get("status") if isinstance(value, dict) else None
merge_base = (
    (value.get("merge_base_commit") or {}).get("sha")
    if isinstance(value, dict)
    else None
)
if (
    not isinstance(merge_base, str)
    or not re.fullmatch(r"[0-9a-f]{40}", merge_base)
    or merge_base != expected_merge_base
):
    raise SystemExit(1)
if mode == "merge-base":
    if status not in {"ahead", "behind", "diverged", "identical"}:
        raise SystemExit(1)
elif mode == "ancestor":
    if (
        status not in {"ahead", "identical"}
        or expected_merge_base != first_sha
    ):
        raise SystemExit(1)
else:
    raise SystemExit(1)
PY
}

write_changed_paths_from_git() {
  local base_sha="$1"
  local head_sha="$2"
  local expected_count="$3"
  local destination="$4"
  local merge_base
  local raw="$work_dir/changed-paths.raw"

  git cat-file -e "${base_sha}^{commit}" 2>/dev/null || return 1
  git cat-file -e "${head_sha}^{commit}" 2>/dev/null || return 1
  merge_base="$(git merge-base "$base_sha" "$head_sha" 2>/dev/null)" ||
    return 1
  git diff --name-status -z --find-renames "$merge_base" "$head_sha" >"$raw" ||
    return 1
  python3 - "$raw" "$expected_count" "$destination" <<'PY'
import pathlib
import sys

raw_path, expected_text, destination = sys.argv[1:]
expected = int(expected_text)
parts = pathlib.Path(raw_path).read_bytes().split(b"\0")
if parts and parts[-1] == b"":
    parts.pop()

files = []
index = 0
while index < len(parts):
    status_text = parts[index].decode("ascii", "strict")
    index += 1
    status_code = status_text[:1]
    if status_code == "R":
        if index + 1 >= len(parts):
            raise SystemExit(1)
        previous = parts[index].decode("utf-8", "strict")
        path = parts[index + 1].decode("utf-8", "strict")
        index += 2
        status = "renamed"
    elif status_code in {"A", "M", "D"}:
        if index >= len(parts):
            raise SystemExit(1)
        path = parts[index].decode("utf-8", "strict")
        index += 1
        previous = ""
        status = {
            "A": "added",
            "M": "modified",
            "D": "removed",
        }[status_code]
    else:
        raise SystemExit(1)
    for value in [path, previous] if previous else [path]:
        if (
            not value
            or len(value) > 4096
            or value.startswith("/")
            or any(part in {"", ".", ".."} for part in value.split("/"))
            or any(ord(character) < 32 or ord(character) == 127 for character in value)
        ):
            raise SystemExit(1)
    files.append((status, path, previous))

all_paths = [
    value
    for _, path, previous in files
    for value in ([path, previous] if previous else [path])
]
if len(files) != expected or len(set(all_paths)) != len(all_paths):
    raise SystemExit(1)
pathlib.Path(destination).write_text(
    "".join(
        f"{status}\t{path}\t{previous}\n"
        for status, path, previous in sorted(files, key=lambda item: item[1])
    ),
    encoding="utf-8",
)
PY
}

write_changed_paths_from_github() {
  local pull_number="$1"
  local expected_count="$2"
  local destination="$3"
  local page=1
  local collected=0
  local count
  local response
  local pages_file="$work_dir/pull-files-pages-${pull_number}"

  : >"$pages_file"
  while true; do
    response="$work_dir/pull-files-${pull_number}-${page}.json"
    github_api_get \
      "pulls/${pull_number}/files?per_page=100&page=${page}" \
      "$response"
    count="$(
      python3 - "$response" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if not isinstance(value, list) or len(value) > 100:
    raise SystemExit(1)
print(len(value))
PY
    )" || fail "invalid-pull-file-inventory-page"
    collected=$((collected + count))
    [[ "$collected" -le "$expected_count" ]] ||
      fail "pull-file-inventory-exceeds-advertised-count"
    printf '%s\n' "$response" >>"$pages_file"
    if [[ "$collected" -eq "$expected_count" && "$count" -lt 100 ]]; then
      break
    fi
    if [[ "$count" -lt 100 ]]; then
      fail "pull-file-inventory-is-incomplete"
    fi
    page=$((page + 1))
  done

  python3 - "$pages_file" "$expected_count" "$destination" <<'PY'
import json
import pathlib
import sys

pages_path, expected_text, destination = sys.argv[1:]
expected = int(expected_text)
entries = []
for page_path in pathlib.Path(pages_path).read_text(encoding="utf-8").splitlines():
    value = json.loads(pathlib.Path(page_path).read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise SystemExit(1)
    entries.extend(value)
if len(entries) != expected:
    raise SystemExit(1)

files = []
for entry in entries:
    if (
        not isinstance(entry, dict)
        or entry.get("status") not in {"added", "modified", "removed", "renamed"}
    ):
        raise SystemExit(1)
    path = entry.get("filename")
    previous = entry.get("previous_filename")
    if entry.get("status") == "renamed":
        if not isinstance(previous, str):
            raise SystemExit(1)
    elif "previous_filename" in entry:
        raise SystemExit(1)
    else:
        previous = ""
    if (
        not isinstance(path, str)
        or not path
        or len(path) > 4096
        or path.startswith("/")
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or any(ord(character) < 32 or ord(character) == 127 for character in path)
    ):
        raise SystemExit(1)
    if previous and (
        len(previous) > 4096
        or previous.startswith("/")
        or any(part in {"", ".", ".."} for part in previous.split("/"))
        or any(ord(character) < 32 or ord(character) == 127 for character in previous)
    ):
        raise SystemExit(1)
    files.append((entry["status"], path, previous))

all_paths = [
    value
    for _, path, previous in files
    for value in ([path, previous] if previous else [path])
]
if len(set(all_paths)) != len(all_paths):
    raise SystemExit(1)
pathlib.Path(destination).write_text(
    "".join(
        f"{status}\t{path}\t{previous}\n"
        for status, path, previous in sorted(files, key=lambda item: item[1])
    ),
    encoding="utf-8",
)
PY
}

write_pull_metadata() {
  local destination="$1"
  python3 - "${GITHUB_EVENT_PATH:-}" "$destination" <<'PY'
import datetime
import hashlib
import json
import pathlib
import re
import sys

event_path, destination = sys.argv[1:]
if not event_path:
    raise SystemExit(1)
payload = json.loads(pathlib.Path(event_path).read_text(encoding="utf-8"))
pull = payload.get("pull_request")
repository = payload.get("repository")
if not isinstance(pull, dict) or not isinstance(repository, dict):
    raise SystemExit(1)

repository_name = repository.get("full_name")
default_branch = repository.get("default_branch")
number = pull.get("number")
head = pull.get("head")
base = pull.get("base")
merge_sha = pull.get("merge_commit_sha")
changed_files = pull.get("changed_files")
updated_at = pull.get("updated_at")
title = pull.get("title")
body = pull.get("body")
labels = pull.get("labels")
if (
    repository_name != "vasilyevstan/betstan"
    or default_branch != "master"
    or type(number) is not int
    or number < 1
    or number > 9007199254740991
    or not isinstance(head, dict)
    or not isinstance(base, dict)
    or type(changed_files) is not int
    or changed_files < 0
    or changed_files > 9007199254740991
    or pull.get("state") != "open"
    or pull.get("mergeable") is False
    or not isinstance(updated_at, str)
    or not isinstance(title, str)
    or not isinstance(body, str)
    or not isinstance(labels, list)
):
    raise SystemExit(1)

head_repository = (head.get("repo") or {}).get("full_name")
head_ref = head.get("ref")
head_sha = head.get("sha")
base_ref = base.get("ref")
base_sha = base.get("sha")
ref_pattern = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,253}[A-Za-z0-9._-])?$")
sha_pattern = re.compile(r"^[0-9a-f]{40}$")
repository_pattern = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
timestamp_pattern = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$"
)

def github_timestamp(value):
    if not isinstance(value, str) or not timestamp_pattern.fullmatch(value):
        raise ValueError
    pattern = (
        "%Y-%m-%dT%H:%M:%S.%fZ"
        if "." in value
        else "%Y-%m-%dT%H:%M:%SZ"
    )
    parsed = datetime.datetime.strptime(value, pattern).replace(
        tzinfo=datetime.timezone.utc
    )
    if parsed < datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc):
        raise ValueError
    return parsed

def epoch_milliseconds(parsed):
    delta = parsed - datetime.datetime(
        1970, 1, 1, tzinfo=datetime.timezone.utc
    )
    return (
        delta.days * 86_400_000
        + delta.seconds * 1000
        + delta.microseconds // 1000
    )

if (
    not isinstance(head_repository, str)
    or not repository_pattern.fullmatch(head_repository)
    or not isinstance(head_ref, str)
    or not ref_pattern.fullmatch(head_ref)
    or ".." in head_ref
    or "//" in head_ref
    or "@{" in head_ref
    or not isinstance(base_ref, str)
    or not ref_pattern.fullmatch(base_ref)
    or ".." in base_ref
    or "//" in base_ref
    or "@{" in base_ref
    or base_ref not in {"dev", "master"}
    or not isinstance(head_sha, str)
    or not sha_pattern.fullmatch(head_sha)
    or not isinstance(base_sha, str)
    or not sha_pattern.fullmatch(base_sha)
    or not isinstance(merge_sha, str)
    or not sha_pattern.fullmatch(merge_sha)
):
    raise SystemExit(1)

try:
    parsed_updated_at = github_timestamp(updated_at)
except (TypeError, ValueError):
    raise SystemExit(1)
updated_at_ms = epoch_milliseconds(parsed_updated_at)

label_names = []
for label in labels:
    name = label.get("name") if isinstance(label, dict) else None
    if (
        not isinstance(name, str)
        or not name
        or len(name) > 100
        or any(ord(character) < 32 or ord(character) == 127 for character in name)
    ):
        raise SystemExit(1)
    label_names.append(name)
label_names.sort()
if len(set(label_names)) != len(label_names):
    raise SystemExit(1)
informational = re.compile(
    r"^(?:feature|session):[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$"
)
policy_labels = [name for name in label_names if not informational.fullmatch(name)]
content_fingerprint = hashlib.sha256(
    (title + "\0" + body).encode("utf-8")
).hexdigest()[:32]
labels_fingerprint = hashlib.sha256(
    json.dumps(policy_labels, separators=(",", ":")).encode("utf-8")
).hexdigest()[:32]

values = [
    repository_name,
    default_branch,
    str(number),
    head_repository,
    head_ref,
    head_sha,
    base_ref,
    base_sha,
    merge_sha,
    str(changed_files),
    str(updated_at_ms),
    content_fingerprint,
    labels_fingerprint,
]
if any("\t" in value or "\n" in value for value in values):
    raise SystemExit(1)
pathlib.Path(destination).write_text("\t".join(values) + "\n", encoding="utf-8")
PY
}

assert_current_pull_metadata() {
  local expected_metadata="$1"
  local current_response="$2"

  python3 - "$expected_metadata" "$current_response" <<'PY'
import datetime
import hashlib
import json
import pathlib
import re
import sys

metadata_path, response_path = sys.argv[1:]
expected = pathlib.Path(metadata_path).read_text(encoding="utf-8").rstrip("\n").split("\t")
if len(expected) != 13:
    raise SystemExit(1)
(
    repository,
    _default_branch,
    number,
    head_repository,
    head_ref,
    head_sha,
    base_ref,
    base_sha,
    merge_sha,
    changed_files,
    updated_at_ms,
    content_fingerprint,
    labels_fingerprint,
) = expected
pull = json.loads(pathlib.Path(response_path).read_text(encoding="utf-8"))
if not isinstance(pull, dict):
    raise SystemExit(1)

def github_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z",
        value,
    ):
        raise ValueError
    pattern = (
        "%Y-%m-%dT%H:%M:%S.%fZ"
        if "." in value
        else "%Y-%m-%dT%H:%M:%SZ"
    )
    parsed = datetime.datetime.strptime(value, pattern).replace(
        tzinfo=datetime.timezone.utc
    )
    if parsed < datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc):
        raise ValueError
    return parsed

def epoch_milliseconds(parsed):
    delta = parsed - datetime.datetime(
        1970, 1, 1, tzinfo=datetime.timezone.utc
    )
    return (
        delta.days * 86_400_000
        + delta.seconds * 1000
        + delta.microseconds // 1000
    )

head = pull.get("head")
base = pull.get("base")
labels = pull.get("labels")
if (
    type(pull.get("number")) is not int
    or pull["number"] < 1
    or pull["number"] > 9007199254740991
    or pull.get("number") != int(number)
    or pull.get("state") != "open"
    or pull.get("mergeable") is False
    or pull.get("merge_commit_sha") != merge_sha
    or type(pull.get("changed_files")) is not int
    or pull["changed_files"] < 0
    or pull["changed_files"] > 9007199254740991
    or pull.get("changed_files") != int(changed_files)
    or not isinstance(head, dict)
    or not isinstance(base, dict)
    or (head.get("repo") or {}).get("full_name") != head_repository
    or head.get("ref") != head_ref
    or head.get("sha") != head_sha
    or base.get("ref") != base_ref
    or base.get("sha") != base_sha
    or not isinstance(pull.get("title"), str)
    or not isinstance(pull.get("body"), str)
    or not isinstance(pull.get("updated_at"), str)
    or not isinstance(labels, list)
):
    raise SystemExit(1)
try:
    updated = github_timestamp(pull["updated_at"])
except ValueError:
    raise SystemExit(1)
if epoch_milliseconds(updated) != int(updated_at_ms):
    raise SystemExit(1)
names = []
for label in labels:
    name = label.get("name") if isinstance(label, dict) else None
    if not isinstance(name, str) or not name:
        raise SystemExit(1)
    names.append(name)
names.sort()
if len(set(names)) != len(names):
    raise SystemExit(1)
informational = re.compile(
    r"^(?:feature|session):[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$"
)
policy_labels = [name for name in names if not informational.fullmatch(name)]
actual_content = hashlib.sha256(
    (pull["title"] + "\0" + pull["body"]).encode("utf-8")
).hexdigest()[:32]
actual_labels = hashlib.sha256(
    json.dumps(policy_labels, separators=(",", ":")).encode("utf-8")
).hexdigest()[:32]
if (
    actual_content != content_fingerprint
    or actual_labels != labels_fingerprint
    or repository != "vasilyevstan/betstan"
):
    raise SystemExit(1)
PY
}

write_paged_json_array() {
  local endpoint="$1"
  local destination="$2"
  local separator="?"
  local page=1
  local response
  local count
  local pages_file="$work_dir/paged-array-$RANDOM"

  [[ "$endpoint" == *"?"* ]] && separator="&"
  : >"$pages_file"
  while true; do
    response="$work_dir/paged-array-$RANDOM-$page.json"
    github_api_get \
      "${endpoint}${separator}per_page=100&page=${page}" \
      "$response"
    count="$(
      python3 - "$response" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if not isinstance(value, list) or len(value) > 100:
    raise SystemExit(1)
print(len(value))
PY
    )" || fail "paged-repository-response-is-malformed"
    printf '%s\n' "$response" >>"$pages_file"
    [[ "$count" -lt 100 ]] && break
    page=$((page + 1))
  done
  python3 - "$pages_file" "$destination" <<'PY'
import json
import pathlib
import sys

pages_path, destination = sys.argv[1:]
entries = []
for page_path in pathlib.Path(pages_path).read_text(encoding="utf-8").splitlines():
    value = json.loads(pathlib.Path(page_path).read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise SystemExit(1)
    entries.extend(value)
pathlib.Path(destination).write_text(
    json.dumps(entries, separators=(",", ":")),
    encoding="utf-8",
)
PY
}

validate_commit_status_inventory() {
  local statuses_path="$1"

  python3 - "$statuses_path" <<'PY'
import datetime
import json
import pathlib
import re
import sys

statuses = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if not isinstance(statuses, list):
    raise SystemExit(1)
timestamp_pattern = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z"
)

def github_timestamp(value):
    if not isinstance(value, str) or not timestamp_pattern.fullmatch(value):
        raise ValueError
    pattern = (
        "%Y-%m-%dT%H:%M:%S.%fZ"
        if "." in value
        else "%Y-%m-%dT%H:%M:%SZ"
    )
    parsed = datetime.datetime.strptime(value, pattern).replace(
        tzinfo=datetime.timezone.utc
    )
    if parsed < datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc):
        raise ValueError
    return parsed

seen = set()
for status in statuses:
    creator = status.get("creator") if isinstance(status, dict) else None
    description = (
        status.get("description") if isinstance(status, dict) else None
    )
    target_url = (
        status.get("target_url") if isinstance(status, dict) else None
    )
    created_at = (
        status.get("created_at") if isinstance(status, dict) else None
    )
    try:
        github_timestamp(created_at)
    except (AttributeError, ValueError):
        raise SystemExit(1)
    if (
        not isinstance(status, dict)
        or type(status.get("id")) is not int
        or status["id"] < 1
        or status["id"] > 9007199254740991
        or status["id"] in seen
        or not isinstance(status.get("context"), str)
        or not status["context"]
        or len(status["context"].encode("utf-8")) > 100
        or any(
            ord(character) < 32 or ord(character) == 127
            for character in status["context"]
        )
        or status.get("state")
        not in {"error", "failure", "pending", "success"}
        or not (
            description is None
            or (
                isinstance(description, str)
                and len(description.encode("utf-8")) <= 140
                and not any(
                    ord(character) < 32 or ord(character) == 127
                    for character in description
                )
            )
        )
        or not (
            target_url is None
            or (
                isinstance(target_url, str)
                and 0 < len(target_url) <= 2048
                and not any(
                    ord(character) < 32 or ord(character) == 127
                    for character in target_url
                )
            )
        )
        or not isinstance(creator, dict)
        or type(creator.get("id")) is not int
        or creator["id"] < 1
        or creator["id"] > 9007199254740991
        or not isinstance(creator.get("login"), str)
        or not creator["login"]
        or len(creator["login"]) > 100
        or any(
            ord(character) < 32 or ord(character) == 127
            for character in creator["login"]
        )
        or not isinstance(creator.get("type"), str)
        or not creator["type"]
        or len(creator["type"]) > 100
        or any(
            ord(character) < 32 or ord(character) == 127
            for character in creator["type"]
        )
    ):
        raise SystemExit(1)
    seen.add(status["id"])
PY
}

write_paged_workflow_attempt_jobs() {
  local run_id="$1"
  local run_attempt="$2"
  local destination="$3"
  local pages_file="$work_dir/workflow-jobs-pages-$RANDOM"
  local page=1
  local collected=0
  local expected_total=""
  local response
  local summary
  local total
  local count
  local remaining
  local expected_count

  : >"$pages_file"
  while true; do
    response="$work_dir/workflow-jobs-$RANDOM-$page.json"
    github_api_get \
      "actions/runs/${run_id}/attempts/${run_attempt}/jobs?per_page=100&page=${page}" \
      "$response"
    summary="$(
      python3 - "$response" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
total = value.get("total_count") if isinstance(value, dict) else None
jobs = value.get("jobs") if isinstance(value, dict) else None
if (
    type(total) is not int
    or total < 0
    or total > 9007199254740991
    or not isinstance(jobs, list)
    or len(jobs) > 100
):
    raise SystemExit(1)
print(total)
print(len(jobs))
PY
    )" || fail "workflow-job-response-is-malformed"
    total="$(sed -n '1p' <<<"$summary")"
    count="$(sed -n '2p' <<<"$summary")"
    if [[ -z "$expected_total" ]]; then
      expected_total="$total"
    elif [[ "$total" != "$expected_total" ]]; then
      fail "workflow-job-inventory-changed-while-paging"
    fi
    remaining=$((expected_total - collected))
    [[ "$remaining" -ge 0 ]] ||
      fail "workflow-job-inventory-is-incomplete"
    expected_count="$remaining"
    [[ "$expected_count" -le 100 ]] || expected_count=100
    [[ "$count" -eq "$expected_count" ]] ||
      fail "workflow-job-inventory-is-incomplete"
    printf '%s\n' "$response" >>"$pages_file"
    collected=$((collected + count))
    [[ "$remaining" -eq 0 ]] && break
    page=$((page + 1))
  done

  python3 - "$pages_file" "$destination" <<'PY'
import json
import pathlib
import sys

pages_path, destination = sys.argv[1:]
jobs = []
total = None
for page_path in pathlib.Path(pages_path).read_text(encoding="utf-8").splitlines():
    value = json.loads(pathlib.Path(page_path).read_text(encoding="utf-8"))
    if total is None:
        total = value["total_count"]
    jobs.extend(value["jobs"])
pathlib.Path(destination).write_text(
    json.dumps(
        {"total_count": 0 if total is None else total, "jobs": jobs},
        separators=(",", ":"),
    ),
    encoding="utf-8",
)
PY
}

select_quality_transition() {
  local statuses_path="$1"
  local base_ref="$2"
  local pull_number="$3"
  local content_fingerprint="$4"
  local labels_fingerprint="$5"
  local expected_run_id="$6"
  local expected_transition_at="$7"
  local destination="$8"

  python3 - \
    "$statuses_path" \
    "$base_ref" \
    "$pull_number" \
    "$content_fingerprint" \
    "$labels_fingerprint" \
    "$expected_run_id" \
    "$expected_transition_at" \
    "$destination" \
    "${GITHUB_SERVER_URL:-https://github.com}" \
    "$EXPECTED_REPOSITORY" <<'PY'
import datetime
import json
import pathlib
import re
import sys

(
    statuses_path,
    base_ref,
    pull_number,
    content_fingerprint,
    labels_fingerprint,
    expected_run_id,
    expected_transition_at,
    destination,
    server_url,
    repository,
) = sys.argv[1:]
statuses = json.loads(pathlib.Path(statuses_path).read_text(encoding="utf-8"))
if not isinstance(statuses, list):
    raise SystemExit(1)
seen_ids = set()
context = f"trusted-quality-transition/{base_ref}"
markers = []
description_pattern = re.compile(
    r"^v3\|([1-9][0-9]*)\|(edited|opened|reopened|synchronize)"
    r"\|(0|[1-9][0-9]*)\|(u|p|x|[1-9][0-9]*)"
    r"\|([0-9a-f]{32})\|([0-9a-f]{32})$"
)
target_prefix = (
    server_url.rstrip("/") + "/" + repository + "/actions/runs/"
)

def github_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z",
        value,
    ):
        raise ValueError
    pattern = (
        "%Y-%m-%dT%H:%M:%S.%fZ"
        if "." in value
        else "%Y-%m-%dT%H:%M:%SZ"
    )
    parsed = datetime.datetime.strptime(value, pattern).replace(
        tzinfo=datetime.timezone.utc
    )
    if parsed < datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc):
        raise ValueError
    return parsed

def epoch_milliseconds(parsed):
    delta = parsed - datetime.datetime(
        1970, 1, 1, tzinfo=datetime.timezone.utc
    )
    return (
        delta.days * 86_400_000
        + delta.seconds * 1000
        + delta.microseconds // 1000
    )

for status in statuses:
    if (
        not isinstance(status, dict)
        or type(status.get("id")) is not int
        or status["id"] < 1
        or status["id"] > 9007199254740991
        or status["id"] in seen_ids
        or not isinstance(status.get("context"), str)
        or not isinstance(status.get("state"), str)
    ):
        raise SystemExit(1)
    seen_ids.add(status["id"])
    if status["context"] != context:
        continue
    description = status.get("description")
    target_url = status.get("target_url")
    creator = status.get("creator")
    created_at = status.get("created_at")
    match = description_pattern.fullmatch(description or "")
    try:
        created_at_ms = epoch_milliseconds(github_timestamp(created_at))
    except (AttributeError, ValueError):
        raise SystemExit(1)
    if (
        status["state"] != "pending"
        or not match
        or not isinstance(creator, dict)
        or type(creator.get("id")) is not int
        or creator.get("id") != 41898282
        or creator.get("login") != "github-actions[bot]"
        or creator.get("type") != "Bot"
        or not isinstance(target_url, str)
        or not target_url.startswith(target_prefix)
        or len(description.encode("utf-8")) > 140
    ):
        raise SystemExit(1)
    run_text = target_url[len(target_prefix):]
    numeric_groups = [match.group(1), match.group(3)]
    if match.group(4) not in {"u", "p", "x"}:
        numeric_groups.append(match.group(4))
    if (
        not re.fullmatch(r"[1-9][0-9]*", run_text)
        or int(run_text) > 9007199254740991
        or any(int(value) > 9007199254740991 for value in numeric_groups)
    ):
        raise SystemExit(1)
    markers.append(
        {
            "status_id": status["id"],
            "pull_number": int(match.group(1)),
            "action": match.group(2),
            "transition_at": int(match.group(3)),
            "binding": match.group(4),
            "content": match.group(5),
            "labels": match.group(6),
            "target_url": target_url,
            "policy_run_id": int(run_text),
            "created_at": created_at_ms,
        }
    )
if not markers:
    raise SystemExit(1)
latest_transition = max(marker["transition_at"] for marker in markers)
latest = [
    marker for marker in markers
    if marker["transition_at"] == latest_transition
]
if (
    int(expected_transition_at) != latest_transition
    or any(marker["pull_number"] != int(pull_number) for marker in latest)
    or len({marker["action"] for marker in latest}) != 1
    or len({marker["content"] for marker in latest}) != 1
    or len({marker["target_url"] for marker in latest}) != 1
    or any(marker["binding"] == "x" for marker in latest)
    or any(marker["created_at"] < latest_transition for marker in latest)
):
    raise SystemExit(1)
positive_bindings = {
    int(marker["binding"])
    for marker in latest
    if marker["binding"] not in {"u", "p", "x"}
}
if positive_bindings != {int(expected_run_id)}:
    raise SystemExit(1)
bound = [
    marker for marker in latest
    if marker["binding"] == expected_run_id
    and marker["content"] == content_fingerprint
    and marker["labels"] == labels_fingerprint
]
if not bound:
    raise SystemExit(1)
selected = sorted(bound, key=lambda marker: marker["status_id"], reverse=True)[0]
pathlib.Path(destination).write_text(
    (
        f"{selected['transition_at']}\n"
        f"{selected['policy_run_id']}\n"
        f"{selected['target_url']}\n"
        f"{selected['created_at']}\n"
    ),
    encoding="utf-8",
)
PY
}

validate_policy_run() {
  local workflow_path="$1"
  local run_path="$2"
  local expected_run_id="$3"
  local expected_target_url="$4"
  local expected_event="$5"
  local pull_number="$6"
  local head_sha="$7"
  local base_sha="$8"
  local require_success="$9"
  local minimum_created_at="${10:-0}"
  local maximum_created_at="${11:-9007199254740991}"

  python3 - \
    "$workflow_path" \
    "$run_path" \
    "$expected_run_id" \
    "$expected_target_url" \
    "$expected_event" \
    "$pull_number" \
    "$head_sha" \
    "$base_sha" \
    "$require_success" \
    "$minimum_created_at" \
    "$maximum_created_at" \
    "$EXPECTED_REPOSITORY" <<'PY'
import datetime
import json
import pathlib
import re
import sys

(
    workflow_path,
    run_path,
    expected_run_id,
    expected_target_url,
    expected_event,
    pull_number,
    head_sha,
    base_sha,
    require_success,
    minimum_created_at,
    maximum_created_at,
    repository,
) = sys.argv[1:]
workflow = json.loads(pathlib.Path(workflow_path).read_text(encoding="utf-8"))
run = json.loads(pathlib.Path(run_path).read_text(encoding="utf-8"))
relations = run.get("pull_requests") if isinstance(run, dict) else None
relation = relations[0] if isinstance(relations, list) and len(relations) == 1 else None
created_at = run.get("created_at") if isinstance(run, dict) else None

def github_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z",
        value,
    ):
        raise ValueError
    pattern = (
        "%Y-%m-%dT%H:%M:%S.%fZ"
        if "." in value
        else "%Y-%m-%dT%H:%M:%SZ"
    )
    parsed = datetime.datetime.strptime(value, pattern).replace(
        tzinfo=datetime.timezone.utc
    )
    if parsed < datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc):
        raise ValueError
    return parsed

try:
    parsed_created_at = github_timestamp(created_at)
except (AttributeError, ValueError):
    raise SystemExit(1)
delta = parsed_created_at - datetime.datetime(
    1970, 1, 1, tzinfo=datetime.timezone.utc
)
created_at_ms = (
    delta.days * 86_400_000
    + delta.seconds * 1000
    + delta.microseconds // 1000
)
if (
    not isinstance(workflow, dict)
    or type(workflow.get("id")) is not int
    or workflow["id"] < 1
    or workflow["id"] > 9007199254740991
    or workflow.get("path") != ".github/workflows/branch-policy.yml"
    or not isinstance(run, dict)
    or type(run.get("id")) is not int
    or run["id"] < 1
    or run["id"] > 9007199254740991
    or run.get("id") != int(expected_run_id)
    or type(run.get("workflow_id")) is not int
    or run["workflow_id"] < 1
    or run["workflow_id"] > 9007199254740991
    or run.get("workflow_id") != workflow["id"]
    or run.get("path") != ".github/workflows/branch-policy.yml"
    or run.get("event") != expected_event
    or (run.get("repository") or {}).get("full_name") != repository
    or run.get("html_url") != expected_target_url
    or not isinstance(relation, dict)
    or type(relation.get("number")) is not int
    or relation["number"] < 1
    or relation["number"] > 9007199254740991
    or relation.get("number") != int(pull_number)
    or (relation.get("head") or {}).get("sha") != head_sha
    or (relation.get("base") or {}).get("sha") != base_sha
    or created_at_ms < int(minimum_created_at)
    or created_at_ms > int(maximum_created_at)
):
    raise SystemExit(1)
if require_success == "true" and (
    run.get("status") != "completed" or run.get("conclusion") != "success"
):
    raise SystemExit(1)
PY
}

validate_quality_run() {
  local workflow_path="$1"
  local run_path="$2"
  local expected_run_id="$3"
  local expected_attempt="$4"
  local pull_number="$5"
  local head_repository="$6"
  local head_sha="$7"
  local base_sha="$8"
  local transition_at="$9"
  shift 9
  local issued_at="$1"
  local expires_at="$2"
  local require_success="$3"
  local destination="$4"

  python3 - \
    "$workflow_path" \
    "$run_path" \
    "$expected_run_id" \
    "$expected_attempt" \
    "$pull_number" \
    "$head_repository" \
    "$head_sha" \
    "$base_sha" \
    "$transition_at" \
    "$issued_at" \
    "$expires_at" \
    "$require_success" \
    "$destination" \
    "${GITHUB_SERVER_URL:-https://github.com}" \
    "$EXPECTED_REPOSITORY" <<'PY'
import datetime
import json
import pathlib
import re
import sys

(
    workflow_path,
    run_path,
    expected_run_id,
    expected_attempt,
    pull_number,
    head_repository,
    head_sha,
    base_sha,
    transition_at,
    issued_at,
    expires_at,
    require_success,
    destination,
    server_url,
    repository,
) = sys.argv[1:]
workflow = json.loads(pathlib.Path(workflow_path).read_text(encoding="utf-8"))
run = json.loads(pathlib.Path(run_path).read_text(encoding="utf-8"))
relations = run.get("pull_requests") if isinstance(run, dict) else None
relation = relations[0] if isinstance(relations, list) and len(relations) == 1 else None

def github_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z", value
    ):
        raise ValueError
    pattern = (
        "%Y-%m-%dT%H:%M:%S.%fZ"
        if "." in value
        else "%Y-%m-%dT%H:%M:%SZ"
    )
    parsed = datetime.datetime.strptime(value, pattern).replace(
        tzinfo=datetime.timezone.utc
    )
    epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    if parsed < epoch:
        raise ValueError
    delta = parsed - epoch
    return (
        delta.days * 86_400_000
        + delta.seconds * 1000
        + delta.microseconds // 1000
    )

try:
    created_at = github_timestamp(run.get("created_at"))
    started_at = github_timestamp(run.get("run_started_at"))
    updated_at = github_timestamp(run.get("updated_at"))
except (AttributeError, TypeError, ValueError):
    raise SystemExit(1)
if (
    not isinstance(workflow, dict)
    or type(workflow.get("id")) is not int
    or workflow["id"] < 1
    or workflow["id"] > 9007199254740991
    or workflow.get("path") != ".github/workflows/production-build.yml"
    or not isinstance(run, dict)
    or type(run.get("id")) is not int
    or run["id"] < 1
    or run["id"] > 9007199254740991
    or run.get("id") != int(expected_run_id)
    or type(run.get("run_attempt")) is not int
    or run["run_attempt"] < 1
    or run["run_attempt"] > 9007199254740991
    or run.get("run_attempt") != int(expected_attempt)
    or type(run.get("workflow_id")) is not int
    or run["workflow_id"] < 1
    or run["workflow_id"] > 9007199254740991
    or run.get("workflow_id") != workflow["id"]
    or run.get("path") != ".github/workflows/production-build.yml"
    or run.get("event") != "pull_request"
    or run.get("head_sha") != head_sha
    or (run.get("head_repository") or {}).get("full_name") != head_repository
    or (run.get("repository") or {}).get("full_name") != repository
    or run.get("html_url")
    != f"{server_url.rstrip('/')}/{repository}/actions/runs/{expected_run_id}"
    or not isinstance(relation, dict)
    or type(relation.get("number")) is not int
    or relation["number"] < 1
    or relation["number"] > 9007199254740991
    or relation.get("number") != int(pull_number)
    or (relation.get("head") or {}).get("sha") != head_sha
    or (relation.get("base") or {}).get("sha") != base_sha
    or started_at < created_at
    or updated_at < started_at
    or not (
        int(issued_at)
        < int(transition_at)
        < created_at
        < int(expires_at)
    )
    or started_at >= int(expires_at)
):
    raise SystemExit(1)
if require_success == "true":
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise SystemExit(1)
elif not (
    (run.get("status") == "completed" and run.get("conclusion") == "success")
    or (
        run.get("status") in {"in_progress", "queued", "requested", "waiting", "pending"}
        and run.get("conclusion") is None
    )
):
    raise SystemExit(1)
pathlib.Path(destination).write_text(
    f"{created_at}\n{started_at}\n{updated_at}\n",
    encoding="ascii",
)
PY
}

select_authorization() {
  local publisher_source="$1"
  local changed_paths="$2"
  local repository="$3"
  local pull_number="$4"
  local head_repository="$5"
  local head_ref="$6"
  local head_sha="$7"
  local base_ref="$8"
  local base_sha="$9"
  shift 9
  local trusted_engine_blob="$1"
  local authorized_engine_blob="$2"
  local trusted_harness_blob="$3"
  local authorized_harness_blob="$4"
  local destination="$5"

  python3 - \
    "$publisher_source" \
    "$changed_paths" \
    "$repository" \
    "$pull_number" \
    "$head_repository" \
    "$head_ref" \
    "$head_sha" \
    "$base_ref" \
    "$base_sha" \
    "$trusted_engine_blob" \
    "$authorized_engine_blob" \
    "$trusted_harness_blob" \
    "$authorized_harness_blob" \
    "$destination" \
    "$EXPECTED_TEST_COUNT" \
    "$MAX_AUTHORIZATION_AGE_SECONDS" <<'PY'
import datetime
import hashlib
import json
import pathlib
import re
import sys

(
    publisher_path,
    changed_paths_path,
    repository,
    pull_number_text,
    head_repository,
    head_ref,
    head_sha,
    base_ref,
    base_sha,
    trusted_engine_blob,
    authorized_engine_blob,
    trusted_harness_blob,
    authorized_harness_blob,
    destination,
    expected_test_count_text,
    max_age_text,
) = sys.argv[1:]
expected_test_count = int(expected_test_count_text)

expected_fields = sorted(
    [
        "adoptionSha",
        "allowedPaths",
        "authorizedEngineBlob",
        "authorizedHarnessBlob",
        "baseRef",
        "baseSha",
        "enginePath",
        "expectedTests",
        "expiresAt",
        "harnessPath",
        "headRef",
        "headRepository",
        "headSha",
        "id",
        "issuedAt",
        "pullNumber",
        "receiptSha",
        "repository",
        "trustedEngineBlob",
        "trustedHarnessBlob",
    ]
)
required_paths = [
    ".github/scripts/test-coverage-matrix.js",
    ".github/scripts/test-test-coverage-matrix.js",
    "LEARNINGS.md",
    "docs/wiki/Engineering-Learnings.md",
]
source = pathlib.Path(publisher_path).read_text(encoding="utf-8")
matches = re.findall(
    r"const TRUSTED_COVERAGE_ASSET_AUTHORIZATIONS_JSON = String\.raw`([^`]*)`;",
    source,
    re.S,
)
if len(matches) != 1:
    raise SystemExit(1)
authorizations = json.loads(matches[0])
if not isinstance(authorizations, list):
    raise SystemExit(1)

actual_paths = pathlib.Path(changed_paths_path).read_text(
    encoding="utf-8"
).splitlines()
files = []
for line in actual_paths:
    parts = line.split("\t")
    if len(parts) != 3:
        raise SystemExit(1)
    files.append(tuple(parts))

sha_pattern = re.compile(r"^[0-9a-f]{40}$")
id_pattern = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
repository_pattern = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ref_pattern = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,253}[A-Za-z0-9._-])?$")
max_age = datetime.timedelta(seconds=int(max_age_text))
seen_ids = set()
eligible = []

def timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError
    parsed = datetime.datetime.fromisoformat(value[:-1] + "+00:00")
    canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if (
        canonical != value
        or parsed
        < datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    ):
        raise ValueError
    return parsed

def epoch_milliseconds(parsed):
    delta = parsed - datetime.datetime(
        1970, 1, 1, tzinfo=datetime.timezone.utc
    )
    return (
        delta.days * 86_400_000
        + delta.seconds * 1000
        + delta.microseconds // 1000
    )

def fingerprint(authorization):
    values = [
        "betstan.coverage.authorization.v1",
        authorization["id"],
        authorization["repository"],
        authorization["headRepository"],
        authorization["pullNumber"],
        authorization["headRef"],
        authorization["headSha"],
        authorization["baseRef"],
        authorization["baseSha"],
        authorization["enginePath"],
        authorization["trustedEngineBlob"],
        authorization["authorizedEngineBlob"],
        authorization["harnessPath"],
        authorization["trustedHarnessBlob"],
        authorization["authorizedHarnessBlob"],
        authorization["allowedPaths"],
        authorization["expectedTests"],
        authorization["issuedAt"],
        authorization["expiresAt"],
        authorization["receiptSha"],
        authorization["adoptionSha"],
    ]
    return hashlib.sha256(
        json.dumps(values, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:40]

for authorization in authorizations:
    if not isinstance(authorization, dict) or sorted(authorization) != expected_fields:
        raise SystemExit(1)
    identifier = authorization["id"]
    if not isinstance(identifier, str) or not id_pattern.fullmatch(identifier):
        raise SystemExit(1)
    if identifier in seen_ids:
        raise SystemExit(1)
    seen_ids.add(identifier)
    if (
        not isinstance(authorization["repository"], str)
        or not repository_pattern.fullmatch(authorization["repository"])
        or authorization["repository"] != repository
        or not isinstance(authorization["headRepository"], str)
        or not repository_pattern.fullmatch(authorization["headRepository"])
        or authorization["headRepository"] != repository
        or authorization["enginePath"] != ".github/scripts/test-coverage-matrix.js"
        or authorization["harnessPath"]
        != ".github/scripts/test-test-coverage-matrix.js"
        or authorization["allowedPaths"] != required_paths
        or type(authorization["pullNumber"]) is not int
        or authorization["pullNumber"] < 1
        or authorization["pullNumber"] > 9007199254740991
        or type(authorization["expectedTests"]) is not int
        or authorization["expectedTests"] != expected_test_count
    ):
        raise SystemExit(1)
    for field in [
        "trustedEngineBlob",
        "authorizedEngineBlob",
        "trustedHarnessBlob",
        "authorizedHarnessBlob",
        "headSha",
        "baseSha",
        "receiptSha",
        "adoptionSha",
    ]:
        value = authorization[field]
        if not isinstance(value, str) or not sha_pattern.fullmatch(value):
            raise SystemExit(1)
    for field in ["headRef", "baseRef"]:
        value = authorization[field]
        if (
            not isinstance(value, str)
            or not ref_pattern.fullmatch(value)
            or ".." in value
            or "//" in value
            or "@{" in value
            or any(character in value for character in "*?[\\")
        ):
            raise SystemExit(1)
    if (
        authorization["headRef"] in {"dev", "master"}
        or authorization["baseRef"] != "dev"
    ):
        raise SystemExit(1)
    try:
        issued_at = timestamp(authorization["issuedAt"])
        expires_at = timestamp(authorization["expiresAt"])
    except (TypeError, ValueError):
        raise SystemExit(1)
    if (
        expires_at <= issued_at
        or expires_at - issued_at > max_age
    ):
        raise SystemExit(1)
    if (
        authorization["trustedEngineBlob"]
        == authorization["authorizedEngineBlob"]
        or authorization["trustedHarnessBlob"]
        == authorization["authorizedHarnessBlob"]
    ):
        raise SystemExit(1)
    pair_matches = (
        authorization["trustedEngineBlob"] == trusted_engine_blob
        and authorization["authorizedEngineBlob"] == authorized_engine_blob
        and authorization["trustedHarnessBlob"] == trusted_harness_blob
        and authorization["authorizedHarnessBlob"] == authorized_harness_blob
    )
    source_matches = (
        head_repository == repository
        and authorization["pullNumber"] == int(pull_number_text)
        and authorization["headRef"] == head_ref
        and authorization["headSha"] == head_sha
        and authorization["baseRef"] == base_ref
    )
    if pair_matches and (
        (base_ref == "dev" and head_ref not in {"dev", "master"} and source_matches)
        or (
            base_ref == "master"
            and head_ref == "dev"
            and head_repository == repository
        )
    ):
        eligible.append(authorization)

if len(eligible) != 1:
    raise SystemExit(1)
selected = eligible[0]
if base_ref == "dev":
    if files != [("modified", path, "") for path in sorted(required_paths)]:
        raise SystemExit(1)
    mode = "integration"
elif base_ref == "master" and head_ref == "dev" and head_repository == repository:
    restricted_prefixes = [
        ".github/coverage/",
        ".github/scripts/",
        ".github/workflows/",
        "infra/azure/agents/",
    ]
    restricted = []
    for status, path, previous in files:
        touched = [path] + ([previous] if previous else [])
        if not any(
            value.startswith(prefix)
            for value in touched
            for prefix in restricted_prefixes
        ):
            continue
        if (
            status != "modified"
            or previous
            or path not in required_paths[:2]
        ):
            raise SystemExit(1)
        restricted.append(path)
    if sorted(restricted) != sorted(required_paths[:2]):
        raise SystemExit(1)
    mode = "promotion"
else:
    raise SystemExit(1)
issued_at = timestamp(selected["issuedAt"])
expires_at = timestamp(selected["expiresAt"])
pathlib.Path(destination).write_text(
    (
        f"{mode}\n"
        f"{selected['id']}\n"
        f"{selected['expectedTests']}\n"
        f"{selected['baseSha']}\n"
        f"{selected['receiptSha']}\n"
        f"{selected['adoptionSha']}\n"
        f"{fingerprint(selected)}\n"
        f"{epoch_milliseconds(issued_at)}\n"
        f"{epoch_milliseconds(expires_at)}\n"
        f"{selected['pullNumber']}\n"
        f"{selected['headRepository']}\n"
        f"{selected['headRef']}\n"
        f"{selected['headSha']}\n"
        f"{selected['baseRef']}\n"
    ),
    encoding="utf-8",
)
PY
}

assert_empty_coverage_receipt() {
  local statuses_path="$1"
  local authorization_id="$2"
  local leg="$3"

  python3 - "$statuses_path" "$authorization_id" "$leg" <<'PY'
import json
import pathlib
import sys

statuses_path, authorization_id, leg = sys.argv[1:]
prefix = {
    "integration": "trusted-coverage-integration",
    "promotion": "trusted-coverage-promotion",
}.get(leg)
if prefix is None:
    raise SystemExit(1)
context = f"{prefix}/{authorization_id}"
statuses = json.loads(pathlib.Path(statuses_path).read_text(encoding="utf-8"))
if not isinstance(statuses, list):
    raise SystemExit(1)
seen = set()
for status in statuses:
    if (
        not isinstance(status, dict)
        or type(status.get("id")) is not int
        or status["id"] < 1
        or status["id"] > 9007199254740991
        or status["id"] in seen
    ):
        raise SystemExit(1)
    seen.add(status["id"])
    if status.get("context") == context:
        raise SystemExit(1)
PY
}

select_completed_coverage_receipt() {
  local statuses_path="$1"
  local authorization_id="$2"
  local fingerprint="$3"
  local leg="$4"
  local destination="$5"

  python3 - \
    "$statuses_path" \
    "$authorization_id" \
    "$fingerprint" \
    "$leg" \
    "$destination" \
    "${GITHUB_SERVER_URL:-https://github.com}" \
    "$EXPECTED_REPOSITORY" <<'PY'
import datetime
import json
import pathlib
import re
import sys

(
    statuses_path,
    authorization_id,
    fingerprint,
    leg,
    destination,
    server_url,
    repository,
) = sys.argv[1:]
prefix = {
    "integration": "trusted-coverage-integration",
    "promotion": "trusted-coverage-promotion",
}.get(leg)
leg_code = {"integration": "i", "promotion": "p"}.get(leg)
if prefix is None or leg_code is None:
    raise SystemExit(1)
context = f"{prefix}/{authorization_id}"
statuses = json.loads(pathlib.Path(statuses_path).read_text(encoding="utf-8"))
if not isinstance(statuses, list):
    raise SystemExit(1)
seen = set()
ledger = []
description_pattern = re.compile(
    rf"^v1\|{leg_code}\|([0-9a-f]{{40}})\|([0-9a-f]{{40}})"
    r"\|([1-9][0-9]*)\|([1-9][0-9]*)\|(0|[1-9][0-9]*)$"
)
target_prefix = (
    server_url.rstrip("/") + "/" + repository + "/actions/runs/"
)

def github_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z",
        value,
    ):
        raise ValueError
    pattern = (
        "%Y-%m-%dT%H:%M:%S.%fZ"
        if "." in value
        else "%Y-%m-%dT%H:%M:%SZ"
    )
    parsed = datetime.datetime.strptime(value, pattern).replace(
        tzinfo=datetime.timezone.utc
    )
    if parsed < datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc):
        raise ValueError
    return parsed

def epoch_milliseconds(parsed):
    delta = parsed - datetime.datetime(
        1970, 1, 1, tzinfo=datetime.timezone.utc
    )
    return (
        delta.days * 86_400_000
        + delta.seconds * 1000
        + delta.microseconds // 1000
    )

for status in statuses:
    if (
        not isinstance(status, dict)
        or type(status.get("id")) is not int
        or status["id"] < 1
        or status["id"] > 9007199254740991
        or status["id"] in seen
    ):
        raise SystemExit(1)
    seen.add(status["id"])
    if status.get("context") != context:
        continue
    creator = status.get("creator")
    description = status.get("description")
    target_url = status.get("target_url")
    created_at = status.get("created_at")
    try:
        created_ms = epoch_milliseconds(github_timestamp(created_at))
    except (AttributeError, ValueError):
        raise SystemExit(1)
    match = description_pattern.fullmatch(description or "")
    if (
        status.get("state") not in {"pending", "success"}
        or not match
        or match.group(1) != fingerprint
        or not isinstance(target_url, str)
        or not target_url.startswith(target_prefix)
        or not isinstance(creator, dict)
        or type(creator.get("id")) is not int
        or creator.get("id") != 41898282
        or creator.get("login") != "github-actions[bot]"
        or creator.get("type") != "Bot"
        or len(description.encode("utf-8")) > 140
    ):
        raise SystemExit(1)
    policy_run_text = target_url[len(target_prefix):]
    if (
        not re.fullmatch(r"[1-9][0-9]*", policy_run_text)
        or int(policy_run_text) > 9007199254740991
        or any(
            int(group) > 9007199254740991
            for group in (match.group(3), match.group(4), match.group(5))
        )
    ):
        raise SystemExit(1)
    ledger.append(
        (
            created_ms,
            status["id"],
            status["state"],
            description,
            target_url,
            int(policy_run_text),
            match,
        )
    )
ledger.sort(key=lambda entry: (entry[0], entry[1]))
if (
    len(ledger) != 2
    or [entry[2] for entry in ledger] != ["pending", "success"]
    or ledger[0][3] != ledger[1][3]
    or ledger[0][4] != ledger[1][4]
):
    raise SystemExit(1)
match = ledger[0][6]
pathlib.Path(destination).write_text(
    (
        f"{match.group(2)}\n"
        f"{match.group(3)}\n"
        f"{match.group(4)}\n"
        f"{match.group(5)}\n"
        f"{ledger[0][5]}\n"
        f"{ledger[0][4]}\n"
        f"{ledger[1][0]}\n"
    ),
    encoding="utf-8",
)
PY
}

write_merged_source_metadata() {
  local response_path="$1"
  local authorization_number="$2"
  local authorization_head_repository="$3"
  local authorization_head_ref="$4"
  local authorization_head_sha="$5"
  local authorization_base_ref="$6"
  local authorization_base_sha="$7"
  local destination="$8"

  python3 - \
    "$response_path" \
    "$authorization_number" \
    "$authorization_head_repository" \
    "$authorization_head_ref" \
    "$authorization_head_sha" \
    "$authorization_base_ref" \
    "$authorization_base_sha" \
    "$destination" <<'PY'
import datetime
import hashlib
import json
import pathlib
import re
import sys

(
    response_path,
    authorization_number,
    authorization_head_repository,
    authorization_head_ref,
    authorization_head_sha,
    authorization_base_ref,
    authorization_base_sha,
    destination,
) = sys.argv[1:]
pull = json.loads(pathlib.Path(response_path).read_text(encoding="utf-8"))
head = pull.get("head") if isinstance(pull, dict) else None
base = pull.get("base") if isinstance(pull, dict) else None
labels = pull.get("labels") if isinstance(pull, dict) else None
merge_commit_sha = pull.get("merge_commit_sha") if isinstance(pull, dict) else None
merged_at = pull.get("merged_at") if isinstance(pull, dict) else None
if (
    not isinstance(pull, dict)
    or type(pull.get("number")) is not int
    or pull["number"] < 1
    or pull["number"] > 9007199254740991
    or pull.get("number") != int(authorization_number)
    or pull.get("state") != "closed"
    or pull.get("merged") is not True
    or not isinstance(merged_at, str)
    or not re.fullmatch(r"[0-9a-f]{40}", merge_commit_sha or "")
    or not isinstance(head, dict)
    or not isinstance(base, dict)
    or (head.get("repo") or {}).get("full_name")
    != authorization_head_repository
    or head.get("ref") != authorization_head_ref
    or head.get("sha") != authorization_head_sha
    or base.get("ref") != authorization_base_ref
    or not re.fullmatch(r"[0-9a-f]{40}", base.get("sha") or "")
    or type(pull.get("changed_files")) is not int
    or pull.get("changed_files") != 4
    or not isinstance(pull.get("title"), str)
    or not isinstance(pull.get("body"), str)
    or not isinstance(labels, list)
):
    raise SystemExit(1)
try:
    if not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z",
        merged_at,
    ):
        raise ValueError
    timestamp_pattern = (
        "%Y-%m-%dT%H:%M:%S.%fZ"
        if "." in merged_at
        else "%Y-%m-%dT%H:%M:%SZ"
    )
    parsed_merged_at = datetime.datetime.strptime(
        merged_at,
        timestamp_pattern,
    ).replace(
        tzinfo=datetime.timezone.utc
    )
    if parsed_merged_at < datetime.datetime(
        1970, 1, 1, tzinfo=datetime.timezone.utc
    ):
        raise ValueError
    delta = parsed_merged_at - datetime.datetime(
        1970, 1, 1, tzinfo=datetime.timezone.utc
    )
    merged_at_ms = (
        delta.days * 86_400_000
        + delta.seconds * 1000
        + delta.microseconds // 1000
    )
except ValueError:
    raise SystemExit(1)
names = []
for label in labels:
    name = label.get("name") if isinstance(label, dict) else None
    if not isinstance(name, str) or not name:
        raise SystemExit(1)
    names.append(name)
names.sort()
if len(set(names)) != len(names):
    raise SystemExit(1)
informational = re.compile(
    r"^(?:feature|session):[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$"
)
policy_labels = [name for name in names if not informational.fullmatch(name)]
content_fingerprint = hashlib.sha256(
    (pull["title"] + "\0" + pull["body"]).encode("utf-8")
).hexdigest()[:32]
labels_fingerprint = hashlib.sha256(
    json.dumps(policy_labels, separators=(",", ":")).encode("utf-8")
).hexdigest()[:32]
pathlib.Path(destination).write_text(
    (
        f"{merge_commit_sha}\n"
        f"{base['sha']}\n"
        f"{merged_at_ms}\n"
        f"{content_fingerprint}\n"
        f"{labels_fingerprint}\n"
    ),
    encoding="utf-8",
)
PY
}

assert_exact_source_files() {
  local inventory_path="$1"
  python3 - "$inventory_path" <<'PY'
import pathlib
import sys

required = sorted(
    [
        ".github/scripts/test-coverage-matrix.js",
        ".github/scripts/test-test-coverage-matrix.js",
        "LEARNINGS.md",
        "docs/wiki/Engineering-Learnings.md",
    ]
)
files = []
for line in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    parts = line.split("\t")
    if len(parts) != 3:
        raise SystemExit(1)
    files.append(tuple(parts))
if files != [("modified", path, "") for path in required]:
    raise SystemExit(1)
PY
}

assert_canonical_open_promotion() {
  local pulls_path="$1"
  local pull_number="$2"

  python3 - \
    "$pulls_path" \
    "$pull_number" \
    "$EXPECTED_REPOSITORY" <<'PY'
import json
import pathlib
import sys

pulls_path, pull_number, repository = sys.argv[1:]
pulls = json.loads(pathlib.Path(pulls_path).read_text(encoding="utf-8"))
if not isinstance(pulls, list):
    raise SystemExit(1)
seen = set()
promotions = []
for pull in pulls:
    if (
        not isinstance(pull, dict)
        or type(pull.get("number")) is not int
        or pull["number"] < 1
        or pull["number"] > 9007199254740991
        or pull["number"] in seen
        or pull.get("state") != "open"
        or not isinstance(pull.get("head"), dict)
        or not isinstance(pull.get("base"), dict)
    ):
        raise SystemExit(1)
    seen.add(pull["number"])
    if (
        pull["head"].get("ref") == "dev"
        and (pull["head"].get("repo") or {}).get("full_name") == repository
        and pull["base"].get("ref") == "master"
    ):
        promotions.append(pull["number"])
if not promotions or min(promotions) != int(pull_number):
    raise SystemExit(1)
PY
}

assert_quality_aggregate_job() {
  local jobs_path="$1"
  local run_id="$2"
  local run_attempt="$3"
  local head_sha="$4"
  python3 - "$jobs_path" "$run_id" "$run_attempt" "$head_sha" <<'PY'
import json
import pathlib
import sys

jobs_path, run_id, run_attempt, head_sha = sys.argv[1:]
value = json.loads(pathlib.Path(jobs_path).read_text(encoding="utf-8"))
jobs = value.get("jobs") if isinstance(value, dict) else None
total = value.get("total_count") if isinstance(value, dict) else None
if (
    not isinstance(jobs, list)
    or type(total) is not int
    or total != len(jobs)
):
    raise SystemExit(1)
seen = set()
valid_nonterminal = {"in_progress", "pending", "queued", "requested", "waiting"}
valid_conclusions = {
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "success",
    "timed_out",
}
for job in jobs:
    if (
        not isinstance(job, dict)
        or type(job.get("id")) is not int
        or job["id"] < 1
        or job["id"] > 9007199254740991
        or job["id"] in seen
        or type(job.get("run_id")) is not int
        or job["run_id"] < 1
        or job["run_id"] > 9007199254740991
        or job.get("run_id") != int(run_id)
        or type(job.get("run_attempt")) is not int
        or job["run_attempt"] < 1
        or job["run_attempt"] > 9007199254740991
        or job.get("run_attempt") != int(run_attempt)
        or job.get("head_sha") != head_sha
        or not isinstance(job.get("name"), str)
        or not job["name"]
        or len(job["name"]) > 256
        or any(
            ord(character) < 32 or ord(character) == 127
            for character in job["name"]
        )
        or not (
            (
                job.get("status") == "completed"
                and job.get("conclusion") in valid_conclusions
            )
            or (
                job.get("status") in valid_nonterminal
                and job.get("conclusion") is None
            )
        )
    ):
        raise SystemExit(1)
    seen.add(job["id"])
aggregate = [
    job for job in jobs
    if isinstance(job, dict) and job.get("name") == "pr-quality-gates"
]
if (
    len(aggregate) != 1
    or aggregate[0].get("status") != "completed"
    or aggregate[0].get("conclusion") != "success"
):
    raise SystemExit(1)
PY
}

write_safe_output_fingerprint() {
  local stdout_path="$1"
  local stderr_path="$2"
  python3 - "$stdout_path" "$stderr_path" <<'PY'
import hashlib
import pathlib
import sys

values = []
for path in sys.argv[1:]:
    content = pathlib.Path(path).read_bytes()
    values.extend([str(len(content)), hashlib.sha256(content).hexdigest()])
print(" ".join(values))
PY
}

validate_tap_output() {
  local stdout_path="$1"
  local stderr_path="$2"
  local expected_tests="$3"
  local destination="$4"

  python3 - \
    "$stdout_path" \
    "$stderr_path" \
    "$expected_tests" \
    "$destination" \
    "$MAX_OUTPUT_BYTES" <<'PY'
import pathlib
import re
import sys

stdout_path, stderr_path, expected_text, destination, limit_text = sys.argv[1:]
expected = int(expected_text)
limit = int(limit_text)
stdout = pathlib.Path(stdout_path).read_bytes()
stderr = pathlib.Path(stderr_path).read_bytes()
if len(stdout) > limit or len(stderr) > limit or stderr:
    raise SystemExit(1)
try:
    text = stdout.decode("ascii", "strict")
except UnicodeDecodeError:
    raise SystemExit(1)
if (
    any(separator in text for separator in "\r\v\f\x1c\x1d\x1e")
    or not text.endswith("\n")
):
    raise SystemExit(1)
lines = text[:-1].split("\n")
if not lines or lines[0] != "TAP version 13":
    raise SystemExit(1)
cursor = 1
duration_pattern = re.compile(
    r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?"
)

def has_unescaped_directive(value):
    for match in re.finditer(r"#\s*(?:skip|todo)\b", value, re.I):
        backslashes = 0
        index = match.start() - 1
        while index >= 0 and value[index] == "\\":
            backslashes += 1
            index -= 1
        if backslashes % 2 == 0:
            return True
    return False

for number in range(1, expected + 1):
    if cursor >= len(lines) or not lines[cursor].startswith("# Subtest: "):
        raise SystemExit(1)
    description = lines[cursor][11:]
    if not description or not re.fullmatch(r"[\x20-\x7e]+", description):
        raise SystemExit(1)
    cursor += 1
    if (
        cursor >= len(lines)
        or lines[cursor] != f"ok {number} - {description}"
        or has_unescaped_directive(lines[cursor])
    ):
        raise SystemExit(1)
    cursor += 1
    if cursor >= len(lines) or lines[cursor] != "  ---":
        raise SystemExit(1)
    cursor += 1
    if (
        cursor >= len(lines)
        or not re.fullmatch(
            rf"  duration_ms: {duration_pattern.pattern}",
            lines[cursor],
        )
    ):
        raise SystemExit(1)
    cursor += 1
    if cursor >= len(lines) or lines[cursor] != "  ...":
        raise SystemExit(1)
    cursor += 1

expected_tail = [
    f"1..{expected}",
    f"# tests {expected}",
    "# suites 0",
    f"# pass {expected}",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
]
if lines[cursor:cursor + len(expected_tail)] != expected_tail:
    raise SystemExit(1)
cursor += len(expected_tail)
if (
    cursor >= len(lines)
    or not re.fullmatch(
        rf"# duration_ms {duration_pattern.pattern}",
        lines[cursor],
    )
):
    raise SystemExit(1)
cursor += 1
if cursor != len(lines):
    raise SystemExit(1)
pathlib.Path(destination).write_text(
    f"tests={expected} stdout_bytes={len(stdout)} stderr_bytes={len(stderr)}\n",
    encoding="ascii",
)
PY
}

require_command git
require_command python3
require_command tar

cd "$ROOT_DIR"
require_regular_file "$ENGINE_PATH"
require_regular_file "$HARNESS_PATH"
current_engine_blob="$(hash_file "$ENGINE_PATH")"
current_harness_blob="$(hash_file "$HARNESS_PATH")"
head_engine_blob="$(git rev-parse "HEAD:${ENGINE_PATH}" 2>/dev/null)" ||
  fail "coverage-engine-is-not-in-head"
head_harness_blob="$(git rev-parse "HEAD:${HARNESS_PATH}" 2>/dev/null)" ||
  fail "coverage-harness-is-not-in-head"
[[ "$current_engine_blob" == "$head_engine_blob" ]] ||
  fail "coverage-engine-differs-from-head"
[[ "$current_harness_blob" == "$head_harness_blob" ]] ||
  fail "coverage-harness-differs-from-head"

if [[ "${GITHUB_ACTIONS:-false}" != "true" ]]; then
  printf \
    'coverage_engine_review=PASS mode=local-advisory execution=skipped engine=%s harness=%s\n' \
    "${current_engine_blob:0:12}" \
    "${current_harness_blob:0:12}"
  exit 0
fi

[[ "${GITHUB_REPOSITORY:-}" == "$EXPECTED_REPOSITORY" ]] ||
  fail "unexpected-repository"
checkout_sha="$(git rev-parse HEAD 2>/dev/null)" ||
  fail "cannot-resolve-checkout"
[[ "$checkout_sha" == "${GITHUB_SHA:-}" ]] ||
  fail "checkout-sha-mismatch"

case "${GITHUB_EVENT_NAME:-}" in
  push)
    [[ "${GITHUB_REF:-}" == "refs/heads/master" ]] ||
      fail "unexpected-push-ref"
    printf \
      'coverage_engine_review=PASS mode=default-equal execution=skipped engine=%s harness=%s\n' \
      "${current_engine_blob:0:12}" \
      "${current_harness_blob:0:12}"
    exit 0
    ;;
  pull_request)
    ;;
  *)
    fail "unsupported-event"
    ;;
esac

metadata_file="$work_dir/pull-metadata"
write_pull_metadata "$metadata_file" ||
  fail "invalid-pull-metadata"
IFS=$'\t' read -r \
  repository \
  default_branch \
  pull_number \
  head_repository \
  head_ref \
  head_sha \
  base_ref \
  base_sha \
  merge_sha \
  changed_file_count \
  pull_updated_at_ms \
  pull_content_fingerprint \
  pull_labels_fingerprint <"$metadata_file"
[[ "$repository" == "$EXPECTED_REPOSITORY" ]] ||
  fail "pull-repository-mismatch"
[[ "$default_branch" == "$EXPECTED_DEFAULT_BRANCH" ]] ||
  fail "default-branch-mismatch"
[[ "$merge_sha" == "$checkout_sha" ]] ||
  fail "merge-snapshot-mismatch"
[[ "${GITHUB_HEAD_REF:-}" == "$head_ref" ]] ||
  fail "head-ref-mismatch"
[[ "${GITHUB_BASE_REF:-}" == "$base_ref" ]] ||
  fail "base-ref-mismatch"
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] ||
  fail "checkout-is-not-clean"

current_pull_response="$work_dir/current-pull.json"
github_api_get "pulls/${pull_number}" "$current_pull_response"
assert_current_pull_metadata \
  "$metadata_file" \
  "$current_pull_response" ||
  fail "current-pull-snapshot-mismatch"

default_branch_sha_file="$work_dir/default-branch-sha"
resolve_default_branch_sha "$default_branch" "$default_branch_sha_file" ||
  fail "cannot-resolve-default-branch"
default_branch_sha="$(tr -d '[:space:]' <"$default_branch_sha_file")"
[[ "$default_branch_sha" =~ ^[0-9a-f]{40}$ ]] ||
  fail "default-branch-sha-is-invalid"

trusted_engine_file="$work_dir/trusted-engine.js"
trusted_harness_file="$work_dir/trusted-harness.js"
load_repository_file \
  "$default_branch_sha" \
  "$ENGINE_PATH" \
  "$trusted_engine_file"
load_repository_file \
  "$default_branch_sha" \
  "$HARNESS_PATH" \
  "$trusted_harness_file"
trusted_engine_blob="$(hash_file "$trusted_engine_file")"
trusted_harness_blob="$(hash_file "$trusted_harness_file")"

engine_changed=false
harness_changed=false
[[ "$trusted_engine_blob" == "$current_engine_blob" ]] ||
  engine_changed=true
[[ "$trusted_harness_blob" == "$current_harness_blob" ]] ||
  harness_changed=true

if [[ "$engine_changed" == "false" && "$harness_changed" == "false" ]]; then
  printf \
    'coverage_engine_review=PASS mode=default-equal execution=skipped engine=%s harness=%s\n' \
    "${current_engine_blob:0:12}" \
    "${current_harness_blob:0:12}"
  exit 0
fi
if [[ "$engine_changed" != "$harness_changed" ]]; then
  fail "mixed-coverage-asset-pair"
fi

base_engine_file="$work_dir/base-engine.js"
base_harness_file="$work_dir/base-harness.js"
head_engine_file="$work_dir/head-engine.js"
head_harness_file="$work_dir/head-harness.js"
load_repository_file "$base_sha" "$ENGINE_PATH" "$base_engine_file"
load_repository_file "$base_sha" "$HARNESS_PATH" "$base_harness_file"
load_repository_file "$head_sha" "$ENGINE_PATH" "$head_engine_file"
load_repository_file "$head_sha" "$HARNESS_PATH" "$head_harness_file"
[[ "$(hash_file "$base_engine_file")" == "$trusted_engine_blob" ]] ||
  fail "pull-base-engine-differs-from-default"
[[ "$(hash_file "$base_harness_file")" == "$trusted_harness_blob" ]] ||
  fail "pull-base-harness-differs-from-default"
[[ "$(hash_file "$head_engine_file")" == "$current_engine_blob" ]] ||
  fail "pull-head-engine-differs-from-merge-snapshot"
[[ "$(hash_file "$head_harness_file")" == "$current_harness_blob" ]] ||
  fail "pull-head-harness-differs-from-merge-snapshot"

publisher_source="$work_dir/trusted-publisher.js"
trusted_review_file="$work_dir/trusted-review.sh"
trusted_invocation_file="$work_dir/trusted-invocation.sh"
head_review_file="$work_dir/head-review.sh"
head_invocation_file="$work_dir/head-invocation.sh"
changed_paths="$work_dir/changed-paths"
authorization_selection="$work_dir/authorization-selection"
require_regular_file "$REVIEW_PATH"
require_regular_file "$INVOCATION_PATH"
current_review_blob="$(hash_file "$REVIEW_PATH")"
current_invocation_blob="$(hash_file "$INVOCATION_PATH")"
head_review_blob="$(git rev-parse "HEAD:${REVIEW_PATH}" 2>/dev/null)" ||
  fail "coverage-review-is-not-in-head"
head_invocation_blob="$(git rev-parse "HEAD:${INVOCATION_PATH}" 2>/dev/null)" ||
  fail "coverage-invocation-is-not-in-head"
[[ "$current_review_blob" == "$head_review_blob" ]] ||
  fail "coverage-review-differs-from-head"
[[ "$current_invocation_blob" == "$head_invocation_blob" ]] ||
  fail "coverage-invocation-differs-from-head"
load_repository_file \
  "$default_branch_sha" \
  "$REVIEW_PATH" \
  "$trusted_review_file"
load_repository_file \
  "$default_branch_sha" \
  "$INVOCATION_PATH" \
  "$trusted_invocation_file"
load_repository_file \
  "$head_sha" \
  "$REVIEW_PATH" \
  "$head_review_file"
load_repository_file \
  "$head_sha" \
  "$INVOCATION_PATH" \
  "$head_invocation_file"
[[ "$(hash_file "$trusted_review_file")" == "$current_review_blob" ]] ||
  fail "coverage-review-differs-from-default"
[[ "$(hash_file "$trusted_invocation_file")" == "$current_invocation_blob" ]] ||
  fail "coverage-invocation-differs-from-default"
[[ "$(hash_file "$head_review_file")" == "$current_review_blob" ]] ||
  fail "coverage-review-differs-from-head"
[[ "$(hash_file "$head_invocation_file")" == "$current_invocation_blob" ]] ||
  fail "coverage-invocation-differs-from-head"
load_repository_file \
  "$default_branch_sha" \
  "$PUBLISHER_PATH" \
  "$publisher_source"
if ! write_changed_paths_from_git \
  "$base_sha" \
  "$head_sha" \
  "$changed_file_count" \
  "$changed_paths"; then
  write_changed_paths_from_github \
    "$pull_number" \
    "$changed_file_count" \
    "$changed_paths" ||
    fail "invalid-pull-file-inventory"
fi
select_authorization \
  "$publisher_source" \
  "$changed_paths" \
  "$repository" \
  "$pull_number" \
  "$head_repository" \
  "$head_ref" \
  "$head_sha" \
  "$base_ref" \
  "$base_sha" \
  "$trusted_engine_blob" \
  "$current_engine_blob" \
  "$trusted_harness_blob" \
  "$current_harness_blob" \
  "$authorization_selection" ||
  fail "coverage-assets-are-not-authorized"
authorization_mode="$(sed -n '1p' "$authorization_selection")"
authorization_id="$(sed -n '2p' "$authorization_selection")"
expected_tests="$(sed -n '3p' "$authorization_selection")"
authorization_base_sha="$(sed -n '4p' "$authorization_selection")"
authorization_receipt_sha="$(sed -n '5p' "$authorization_selection")"
authorization_adoption_sha="$(sed -n '6p' "$authorization_selection")"
authorization_fingerprint="$(sed -n '7p' "$authorization_selection")"
authorization_issued_at="$(sed -n '8p' "$authorization_selection")"
authorization_expires_at="$(sed -n '9p' "$authorization_selection")"
authorization_pull_number="$(sed -n '10p' "$authorization_selection")"
authorization_head_repository="$(sed -n '11p' "$authorization_selection")"
authorization_head_ref="$(sed -n '12p' "$authorization_selection")"
authorization_head_sha="$(sed -n '13p' "$authorization_selection")"
authorization_base_ref="$(sed -n '14p' "$authorization_selection")"
[[ "$authorization_mode" =~ ^(integration|promotion)$ ]] ||
  fail "selected-authorization-mode-is-invalid"
[[ "$authorization_id" =~ ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$ ]] ||
  fail "selected-authorization-id-is-invalid"
[[ "$authorization_fingerprint" =~ ^[0-9a-f]{40}$ ]] ||
  fail "selected-authorization-fingerprint-is-invalid"
[[ "$expected_tests" == "$EXPECTED_TEST_COUNT" ]] ||
  fail "selected-test-count-is-invalid"

[[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] ||
  fail "quality-run-id-is-invalid"
[[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]] ||
  fail "quality-run-attempt-is-invalid"

branch_workflow_response="$work_dir/branch-workflow.json"
quality_workflow_response="$work_dir/quality-workflow.json"
current_quality_run_response="$work_dir/current-quality-run.json"
github_api_get \
  "actions/workflows/branch-policy.yml" \
  "$branch_workflow_response"
github_api_get \
  "actions/workflows/production-build.yml" \
  "$quality_workflow_response"
github_api_get \
  "actions/runs/${GITHUB_RUN_ID}" \
  "$current_quality_run_response"

current_transition_statuses="$work_dir/current-transition-statuses.json"
current_transition_selection="$work_dir/current-transition-selection"
transition_selected=false
for transition_attempt in 1 2 3 4 5; do
  write_paged_json_array \
    "commits/${merge_sha}/statuses" \
    "$current_transition_statuses"
  validate_commit_status_inventory "$current_transition_statuses" ||
    fail "quality-transition-status-inventory-is-invalid"
  if select_quality_transition \
    "$current_transition_statuses" \
    "$base_ref" \
    "$pull_number" \
    "$pull_content_fingerprint" \
    "$pull_labels_fingerprint" \
    "$GITHUB_RUN_ID" \
    "$pull_updated_at_ms" \
    "$current_transition_selection"; then
    transition_selected=true
    break
  fi
  [[ "$transition_attempt" -eq 5 ]] || sleep 2
done
[[ "$transition_selected" == "true" ]] ||
  fail "quality-transition-is-not-bound"
current_transition_at="$(sed -n '1p' "$current_transition_selection")"
current_policy_run_id="$(sed -n '2p' "$current_transition_selection")"
current_policy_run_url="$(sed -n '3p' "$current_transition_selection")"
current_transition_status_created_at="$(
  sed -n '4p' "$current_transition_selection"
)"
current_policy_run_response="$work_dir/current-policy-run.json"
github_api_get \
  "actions/runs/${current_policy_run_id}" \
  "$current_policy_run_response"
validate_policy_run \
  "$branch_workflow_response" \
  "$current_policy_run_response" \
  "$current_policy_run_id" \
  "$current_policy_run_url" \
  "pull_request_target" \
  "$pull_number" \
  "$head_sha" \
  "$base_sha" \
  "true" \
  "$current_transition_at" \
  "$current_transition_status_created_at" ||
  fail "quality-transition-policy-run-is-invalid"
current_quality_times="$work_dir/current-quality-times"
validate_quality_run \
  "$quality_workflow_response" \
  "$current_quality_run_response" \
  "$GITHUB_RUN_ID" \
  "$GITHUB_RUN_ATTEMPT" \
  "$pull_number" \
  "$head_repository" \
  "$head_sha" \
  "$base_sha" \
  "$current_transition_at" \
  "$authorization_issued_at" \
  "$authorization_expires_at" \
  "false" \
  "$current_quality_times" ||
  fail "current-quality-run-is-invalid"

if [[ "$authorization_mode" == "integration" ]]; then
  [[ "$base_ref" == "dev" && "$head_ref" != "dev" && "$head_ref" != "master" ]] ||
    fail "coverage-integration-branch-is-invalid"
  if ! assert_commit_relationship \
    "$head_sha" \
    "$base_sha" \
    "$authorization_base_sha" \
    "merge-base"; then
    fail "coverage-authorization-base-lineage-is-invalid"
  fi
  if ! assert_commit_relationship \
    "$authorization_adoption_sha" \
    "$authorization_base_sha" \
    "$authorization_adoption_sha" \
    "ancestor"; then
    fail "coverage-authorization-adoption-lineage-is-invalid"
  fi
  if ! assert_commit_relationship \
    "$authorization_receipt_sha" \
    "$head_sha" \
    "$authorization_receipt_sha" \
    "ancestor"; then
    fail "coverage-authorization-receipt-lineage-is-invalid"
  fi
  if ! assert_commit_relationship \
    "$base_sha" \
    "$merge_sha" \
    "$base_sha" \
    "ancestor"; then
    fail "coverage-integration-base-snapshot-lineage-is-invalid"
  fi
  if ! assert_commit_relationship \
    "$head_sha" \
    "$merge_sha" \
    "$head_sha" \
    "ancestor"; then
    fail "coverage-integration-head-snapshot-lineage-is-invalid"
  fi
  integration_receipt_statuses="$work_dir/integration-receipt-statuses.json"
  write_paged_json_array \
    "commits/${authorization_receipt_sha}/statuses" \
    "$integration_receipt_statuses"
  validate_commit_status_inventory "$integration_receipt_statuses" ||
    fail "coverage-integration-receipt-inventory-is-invalid"
  assert_empty_coverage_receipt \
    "$integration_receipt_statuses" \
    "$authorization_id" \
    "integration" ||
    fail "coverage-integration-receipt-is-not-empty"
elif [[ "$authorization_mode" == "promotion" ]]; then
  [[ "$base_ref" == "master" && "$head_ref" == "dev" ]] ||
    fail "coverage-promotion-branch-is-invalid"
  live_master_file="$work_dir/live-master-sha"
  live_dev_file="$work_dir/live-dev-sha"
  resolve_repository_ref_sha "master" "$live_master_file" ||
    fail "cannot-resolve-live-master"
  resolve_repository_ref_sha "dev" "$live_dev_file" ||
    fail "cannot-resolve-live-dev"
  [[ "$(tr -d '[:space:]' <"$live_master_file")" == "$base_sha" ]] ||
    fail "coverage-promotion-master-tip-drift"
  [[ "$(tr -d '[:space:]' <"$live_dev_file")" == "$head_sha" ]] ||
    fail "coverage-promotion-dev-tip-drift"
  if ! assert_commit_relationship \
    "$base_sha" \
    "$head_sha" \
    "$base_sha" \
    "ancestor"; then
    fail "coverage-promotion-lineage-is-invalid"
  fi
  open_promotions="$work_dir/open-promotions.json"
  write_paged_json_array \
    "pulls?state=open&base=master" \
    "$open_promotions"
  assert_canonical_open_promotion \
    "$open_promotions" \
    "$pull_number" ||
    fail "coverage-promotion-is-not-canonical"

  source_pull_response="$work_dir/source-pull.json"
  source_metadata="$work_dir/source-metadata"
  github_api_get \
    "pulls/${authorization_pull_number}" \
    "$source_pull_response"
  write_merged_source_metadata \
    "$source_pull_response" \
    "$authorization_pull_number" \
    "$authorization_head_repository" \
    "$authorization_head_ref" \
    "$authorization_head_sha" \
    "$authorization_base_ref" \
    "$authorization_base_sha" \
    "$source_metadata" ||
    fail "authorized-source-pull-is-not-merged"
  source_merge_commit_sha="$(sed -n '1p' "$source_metadata")"
  source_base_sha="$(sed -n '2p' "$source_metadata")"
  source_content_fingerprint="$(sed -n '4p' "$source_metadata")"
  source_labels_fingerprint="$(sed -n '5p' "$source_metadata")"

  source_changed_paths="$work_dir/source-changed-paths"
  if ! write_changed_paths_from_git \
    "$authorization_base_sha" \
    "$authorization_head_sha" \
    "4" \
    "$source_changed_paths"; then
    write_changed_paths_from_github \
      "$authorization_pull_number" \
      "4" \
      "$source_changed_paths" ||
      fail "invalid-authorized-source-file-inventory"
  fi
  assert_exact_source_files "$source_changed_paths" ||
    fail "authorized-source-file-inventory-is-invalid"

  if ! assert_commit_relationship \
    "$authorization_head_sha" \
    "$source_base_sha" \
    "$authorization_base_sha" \
    "merge-base"; then
    fail "coverage-authorization-base-lineage-is-invalid"
  fi
  if ! assert_commit_relationship \
    "$authorization_adoption_sha" \
    "$authorization_base_sha" \
    "$authorization_adoption_sha" \
    "ancestor"; then
    fail "coverage-authorization-adoption-lineage-is-invalid"
  fi
  if ! assert_commit_relationship \
    "$authorization_receipt_sha" \
    "$authorization_head_sha" \
    "$authorization_receipt_sha" \
    "ancestor"; then
    fail "coverage-authorization-receipt-lineage-is-invalid"
  fi

  source_receipt_statuses="$work_dir/source-receipt-statuses.json"
  source_receipt_selection="$work_dir/source-receipt-selection"
  write_paged_json_array \
    "commits/${authorization_receipt_sha}/statuses" \
    "$source_receipt_statuses"
  validate_commit_status_inventory "$source_receipt_statuses" ||
    fail "coverage-integration-receipt-inventory-is-invalid"
  select_completed_coverage_receipt \
    "$source_receipt_statuses" \
    "$authorization_id" \
    "$authorization_fingerprint" \
    "integration" \
    "$source_receipt_selection" ||
    fail "coverage-integration-receipt-is-invalid"
  source_merge_snapshot_sha="$(sed -n '1p' "$source_receipt_selection")"
  source_quality_run_id="$(sed -n '2p' "$source_receipt_selection")"
  source_quality_run_attempt="$(sed -n '3p' "$source_receipt_selection")"
  source_transition_at="$(sed -n '4p' "$source_receipt_selection")"
  source_receipt_policy_run_id="$(sed -n '5p' "$source_receipt_selection")"
  source_receipt_policy_run_url="$(sed -n '6p' "$source_receipt_selection")"

  if ! assert_commit_relationship \
    "$source_base_sha" \
    "$source_merge_snapshot_sha" \
    "$source_base_sha" \
    "ancestor"; then
    fail "authorized-source-base-snapshot-lineage-is-invalid"
  fi
  if ! assert_commit_relationship \
    "$authorization_head_sha" \
    "$source_merge_snapshot_sha" \
    "$authorization_head_sha" \
    "ancestor"; then
    fail "authorized-source-head-snapshot-lineage-is-invalid"
  fi

  source_transition_statuses="$work_dir/source-transition-statuses.json"
  source_transition_selection="$work_dir/source-transition-selection"
  write_paged_json_array \
    "commits/${source_merge_snapshot_sha}/statuses" \
    "$source_transition_statuses"
  validate_commit_status_inventory "$source_transition_statuses" ||
    fail "authorized-source-transition-inventory-is-invalid"
  select_quality_transition \
    "$source_transition_statuses" \
    "$authorization_base_ref" \
    "$authorization_pull_number" \
    "$source_content_fingerprint" \
    "$source_labels_fingerprint" \
    "$source_quality_run_id" \
    "$source_transition_at" \
    "$source_transition_selection" ||
    fail "authorized-source-transition-is-invalid"
  source_transition_policy_run_id="$(sed -n '2p' "$source_transition_selection")"
  source_transition_policy_run_url="$(sed -n '3p' "$source_transition_selection")"
  source_transition_status_created_at="$(
    sed -n '4p' "$source_transition_selection"
  )"
  source_transition_policy_run="$work_dir/source-transition-policy-run.json"
  github_api_get \
    "actions/runs/${source_transition_policy_run_id}" \
    "$source_transition_policy_run"
  validate_policy_run \
    "$branch_workflow_response" \
    "$source_transition_policy_run" \
    "$source_transition_policy_run_id" \
    "$source_transition_policy_run_url" \
    "pull_request_target" \
    "$authorization_pull_number" \
    "$authorization_head_sha" \
    "$source_base_sha" \
    "true" \
    "$source_transition_at" \
    "$source_transition_status_created_at" ||
    fail "authorized-source-transition-policy-run-is-invalid"

  source_quality_run="$work_dir/source-quality-run.json"
  source_quality_times="$work_dir/source-quality-times"
  github_api_get \
    "actions/runs/${source_quality_run_id}" \
    "$source_quality_run"
  validate_quality_run \
    "$quality_workflow_response" \
    "$source_quality_run" \
    "$source_quality_run_id" \
    "$source_quality_run_attempt" \
    "$authorization_pull_number" \
    "$authorization_head_repository" \
    "$authorization_head_sha" \
    "$source_base_sha" \
    "$source_transition_at" \
    "$authorization_issued_at" \
    "$authorization_expires_at" \
    "true" \
    "$source_quality_times" ||
    fail "authorized-source-quality-run-is-invalid"
  source_quality_updated_at="$(sed -n '3p' "$source_quality_times")"
  source_quality_jobs="$work_dir/source-quality-jobs.json"
  write_paged_workflow_attempt_jobs \
    "$source_quality_run_id" \
    "$source_quality_run_attempt" \
    "$source_quality_jobs"
  assert_quality_aggregate_job \
    "$source_quality_jobs" \
    "$source_quality_run_id" \
    "$source_quality_run_attempt" \
    "$authorization_head_sha" ||
    fail "authorized-source-aggregate-job-is-invalid"

  source_receipt_policy_run="$work_dir/source-receipt-policy-run.json"
  github_api_get \
    "actions/runs/${source_receipt_policy_run_id}" \
    "$source_receipt_policy_run"
  validate_policy_run \
    "$branch_workflow_response" \
    "$source_receipt_policy_run" \
    "$source_receipt_policy_run_id" \
    "$source_receipt_policy_run_url" \
    "workflow_run" \
    "$authorization_pull_number" \
    "$authorization_head_sha" \
    "$source_base_sha" \
    "true" \
    "$source_quality_updated_at" ||
    fail "coverage-integration-receipt-policy-run-is-invalid"

  if ! assert_commit_relationship \
    "$source_merge_commit_sha" \
    "$head_sha" \
    "$source_merge_commit_sha" \
    "ancestor"; then
    fail "authorized-source-merge-is-not-in-promotion"
  fi

  source_base_engine="$work_dir/source-base-engine.js"
  source_base_harness="$work_dir/source-base-harness.js"
  source_head_engine="$work_dir/source-head-engine.js"
  source_head_harness="$work_dir/source-head-harness.js"
  source_snapshot_engine="$work_dir/source-snapshot-engine.js"
  source_snapshot_harness="$work_dir/source-snapshot-harness.js"
  source_merge_engine="$work_dir/source-merge-engine.js"
  source_merge_harness="$work_dir/source-merge-harness.js"
  load_repository_file \
    "$source_base_sha" "$ENGINE_PATH" "$source_base_engine"
  load_repository_file \
    "$source_base_sha" "$HARNESS_PATH" "$source_base_harness"
  load_repository_file \
    "$authorization_head_sha" "$ENGINE_PATH" "$source_head_engine"
  load_repository_file \
    "$authorization_head_sha" "$HARNESS_PATH" "$source_head_harness"
  load_repository_file \
    "$source_merge_snapshot_sha" "$ENGINE_PATH" "$source_snapshot_engine"
  load_repository_file \
    "$source_merge_snapshot_sha" "$HARNESS_PATH" "$source_snapshot_harness"
  load_repository_file \
    "$source_merge_commit_sha" "$ENGINE_PATH" "$source_merge_engine"
  load_repository_file \
    "$source_merge_commit_sha" "$HARNESS_PATH" "$source_merge_harness"
  [[ "$(hash_file "$source_base_engine")" == "$trusted_engine_blob" ]] ||
    fail "authorized-source-base-engine-is-invalid"
  [[ "$(hash_file "$source_base_harness")" == "$trusted_harness_blob" ]] ||
    fail "authorized-source-base-harness-is-invalid"
  for authorized_engine_file in \
    "$source_head_engine" \
    "$source_snapshot_engine" \
    "$source_merge_engine"; do
    [[ "$(hash_file "$authorized_engine_file")" == "$current_engine_blob" ]] ||
      fail "authorized-source-engine-lineage-is-invalid"
  done
  for authorized_harness_file in \
    "$source_head_harness" \
    "$source_snapshot_harness" \
    "$source_merge_harness"; do
    [[ "$(hash_file "$authorized_harness_file")" == "$current_harness_blob" ]] ||
      fail "authorized-source-harness-lineage-is-invalid"
  done

  promotion_receipt_statuses="$work_dir/promotion-receipt-statuses.json"
  write_paged_json_array \
    "commits/${source_merge_commit_sha}/statuses" \
    "$promotion_receipt_statuses"
  validate_commit_status_inventory "$promotion_receipt_statuses" ||
    fail "coverage-promotion-receipt-inventory-is-invalid"
  assert_empty_coverage_receipt \
    "$promotion_receipt_statuses" \
    "$authorization_id" \
    "promotion" ||
    fail "coverage-promotion-receipt-is-not-empty"
else
  fail "selected-authorization-mode-is-invalid"
fi

snapshot="$work_dir/snapshot"
mkdir -p "$snapshot"
git archive --format=tar "$checkout_sha" 2>/dev/null |
  tar -xf - -C "$snapshot" 2>/dev/null ||
  fail "cannot-materialize-merge-snapshot"
require_regular_file "$snapshot/$ENGINE_PATH"
require_regular_file "$snapshot/$HARNESS_PATH"
[[ "$(hash_file "$snapshot/$ENGINE_PATH")" == "$current_engine_blob" ]] ||
  fail "snapshot-engine-blob-mismatch"
[[ "$(hash_file "$snapshot/$HARNESS_PATH")" == "$current_harness_blob" ]] ||
  fail "snapshot-harness-blob-mismatch"

docker_bin="$(command -v docker 2>/dev/null)" ||
  fail "docker-is-unavailable"
[[ "$docker_bin" == /* && -x "$docker_bin" ]] ||
  fail "docker-path-is-invalid"
stdout_path="$work_dir/container-stdout"
stderr_path="$work_dir/container-stderr"
status_path="$work_dir/container-status"
cid_path="$work_dir/container.cid"
docker_home="$work_dir/docker-home"
docker_config="$work_dir/docker-config"
mkdir -p "$docker_home" "$docker_config"

container_script='
test "$(id -u)" = "0"
test "$(id -g)" = "0"
test "$(node -p "process.versions.node")" = "20.19.5"
test "$(node -p "process.platform")" = "linux"
test "$(node -p "process.arch")" = "x64"
cap_eff="$(awk "/^CapEff:/ { print \$2 }" /proc/self/status)"
cap_prm="$(awk "/^CapPrm:/ { print \$2 }" /proc/self/status)"
cap_bnd="$(awk "/^CapBnd:/ { print \$2 }" /proc/self/status)"
cap_amb="$(awk "/^CapAmb:/ { print \$2 }" /proc/self/status)"
cap_inh="$(awk "/^CapInh:/ { print \$2 }" /proc/self/status)"
test "$cap_eff" = "00000000000000eb"
test "$cap_prm" = "00000000000000eb"
test "$cap_bnd" = "00000000000000eb"
test "$cap_amb" = "0000000000000000"
test "$cap_inh" = "0000000000000000"
test ! -e /var/run/docker.sock
test ! -e /run/docker.sock
mkdir -p "$HOME"
node --check .github/scripts/test-coverage-matrix.js
node --check .github/scripts/test-test-coverage-matrix.js
exec node --test-reporter=tap .github/scripts/test-test-coverage-matrix.js
'

docker_args=(
  run
  --rm
  --pull=always
  --quiet
  --platform "$EXPECTED_PLATFORM"
  --cidfile "$cid_path"
  --read-only
  --network none
  --ipc none
  --hostname coverage-review
  --user 0:0
  --security-opt no-new-privileges=true
  --cap-drop ALL
  --cap-add CHOWN
  --cap-add DAC_OVERRIDE
  --cap-add FOWNER
  --cap-add KILL
  --cap-add SETGID
  --cap-add SETUID
  --pids-limit 256
  --memory 2g
  --memory-swap 2g
  --cpus 2.0
  --ulimit nofile=1024:1024
  --tmpfs /tmp:rw,nosuid,nodev,exec,size=805306368,mode=1777
  --mount "type=bind,src=$snapshot,dst=/workspace,readonly"
  --workdir /workspace
  --env BETSTAN_COVERAGE_CONTAINER=1
  --env HOME=/tmp/home
  --env TMPDIR=/tmp
  --env LANG=C
  --env LC_ALL=C
  --env TZ=UTC
  --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  "$PINNED_IMAGE"
  /bin/bash
  -ceu
  "$container_script"
)

python3 - \
  "$stdout_path" \
  "$stderr_path" \
  "$status_path" \
  "$cid_path" \
  "$docker_home" \
  "$docker_config" \
  "$CONTAINER_TIMEOUT_SECONDS" \
  "$MAX_OUTPUT_BYTES" \
  "$docker_bin" \
  "${docker_args[@]}" <<'PY'
import os
import pathlib
import resource
import signal
import subprocess
import sys
import re

(
    stdout_path,
    stderr_path,
    status_path,
    cid_path,
    docker_home,
    docker_config,
    timeout_text,
    output_limit_text,
    docker_bin,
    *docker_args,
) = sys.argv[1:]
timeout = int(timeout_text)
output_limit = int(output_limit_text)
environment = {
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    "HOME": docker_home,
    "DOCKER_CONFIG": docker_config,
    "TERM": "dumb",
}

def child_limits():
    os.setsid()
    resource.setrlimit(resource.RLIMIT_FSIZE, (output_limit, output_limit))

status = 125
timed_out = False
with open(stdout_path, "wb") as stdout, open(stderr_path, "wb") as stderr:
    process = subprocess.Popen(
        [docker_bin, *docker_args],
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        env=environment,
        close_fds=True,
        preexec_fn=child_limits,
    )
    try:
        status = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            status = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            status = process.wait()

if timed_out:
    status = 124
cid_file = pathlib.Path(cid_path)
if status != 0 and cid_file.is_file():
    cid = cid_file.read_text(encoding="ascii", errors="ignore").strip()
    if re.fullmatch(r"[0-9a-f]{12,64}", cid):
        subprocess.run(
            [docker_bin, "rm", "-f", cid],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            timeout=30,
            check=False,
        )
pathlib.Path(status_path).write_text(f"{status}\n", encoding="ascii")
PY

container_status="$(tr -d '[:space:]' <"$status_path")"
if [[ "$container_status" != "0" ]]; then
  read -r stdout_bytes stdout_sha stderr_bytes stderr_sha < <(
    write_safe_output_fingerprint "$stdout_path" "$stderr_path"
  )
  printf \
    'coverage_engine_review=FAIL reason=contained-execution status=%s stdout_bytes=%s stdout_sha256=%s stderr_bytes=%s stderr_sha256=%s\n' \
    "$container_status" \
    "$stdout_bytes" \
    "$stdout_sha" \
    "$stderr_bytes" \
    "$stderr_sha" >&2
  exit 1
fi

tap_summary="$work_dir/tap-summary"
if ! validate_tap_output \
  "$stdout_path" \
  "$stderr_path" \
  "$expected_tests" \
  "$tap_summary"; then
  read -r stdout_bytes stdout_sha stderr_bytes stderr_sha < <(
    write_safe_output_fingerprint "$stdout_path" "$stderr_path"
  )
  printf \
    'coverage_engine_review=FAIL reason=invalid-tap stdout_bytes=%s stdout_sha256=%s stderr_bytes=%s stderr_sha256=%s\n' \
    "$stdout_bytes" \
    "$stdout_sha" \
    "$stderr_bytes" \
    "$stderr_sha" >&2
  exit 1
fi

read -r tests_summary stdout_summary stderr_summary <"$tap_summary"
printf \
  'coverage_engine_review=PASS mode=%s authorization=%s image=%s platform=%s node=%s engine=%s harness=%s %s %s %s\n' \
  "$authorization_mode" \
  "$authorization_id" \
  "${PINNED_IMAGE##*@}" \
  "$EXPECTED_PLATFORM" \
  "$EXPECTED_NODE_VERSION" \
  "${current_engine_blob:0:12}" \
  "${current_harness_blob:0:12}" \
  "$tests_summary" \
  "$stdout_summary" \
  "$stderr_summary"
