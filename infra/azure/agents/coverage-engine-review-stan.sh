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
  git diff --name-status -z --no-renames "$merge_base" "$head_sha" >"$raw" ||
    return 1
  python3 - "$raw" "$expected_count" "$destination" <<'PY'
import pathlib
import sys

raw_path, expected_text, destination = sys.argv[1:]
expected = int(expected_text)
parts = pathlib.Path(raw_path).read_bytes().split(b"\0")
if parts and parts[-1] == b"":
    parts.pop()
if len(parts) % 2 != 0:
    raise SystemExit(1)

paths = []
for index in range(0, len(parts), 2):
    status = parts[index].decode("ascii", "strict")
    path = parts[index + 1].decode("utf-8", "strict")
    if status not in {"A", "M", "D"}:
        raise SystemExit(1)
    if (
        not path
        or len(path) > 4096
        or path.startswith("/")
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or any(ord(character) < 32 or ord(character) == 127 for character in path)
    ):
        raise SystemExit(1)
    paths.append(path)

if len(paths) != expected or len(set(paths)) != len(paths):
    raise SystemExit(1)
pathlib.Path(destination).write_text(
    "".join(f"{path}\n" for path in sorted(paths)),
    encoding="utf-8",
)
PY
}

write_changed_paths_from_github() {
  local pull_number="$1"
  local expected_count="$2"
  local destination="$3"
  local response="$work_dir/pull-files.json"

  require_command curl
  [[ "$expected_count" -le 100 ]] ||
    fail "coverage-authorization-path-count-is-unbounded"
  curl -q \
    --fail \
    --silent \
    --show-error \
    --proto '=https' \
    --connect-timeout 10 \
    --max-time 30 \
    --max-filesize "$MAX_FETCH_BYTES" \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: betstan-coverage-review" \
    "https://api.github.com/repos/${EXPECTED_REPOSITORY}/pulls/${pull_number}/files?per_page=100&page=1" \
    >"$response" 2>/dev/null ||
    fail "cannot-fetch-pull-file-inventory"

  python3 - "$response" "$expected_count" "$destination" <<'PY'
import json
import pathlib
import sys

response_path, expected_text, destination = sys.argv[1:]
expected = int(expected_text)
value = json.loads(pathlib.Path(response_path).read_text(encoding="utf-8"))
if not isinstance(value, list) or len(value) != expected:
    raise SystemExit(1)

paths = []
for entry in value:
    if (
        not isinstance(entry, dict)
        or entry.get("status") not in {"added", "modified", "removed"}
        or "previous_filename" in entry
    ):
        raise SystemExit(1)
    path = entry.get("filename")
    if (
        not isinstance(path, str)
        or not path
        or len(path) > 4096
        or path.startswith("/")
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or any(ord(character) < 32 or ord(character) == 127 for character in path)
    ):
        raise SystemExit(1)
    paths.append(path)

if len(set(paths)) != len(paths):
    raise SystemExit(1)
pathlib.Path(destination).write_text(
    "".join(f"{path}\n" for path in sorted(paths)),
    encoding="utf-8",
)
PY
}

write_pull_metadata() {
  local destination="$1"
  python3 - "${GITHUB_EVENT_PATH:-}" "$destination" <<'PY'
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
if (
    repository_name != "vasilyevstan/betstan"
    or default_branch != "master"
    or not isinstance(number, int)
    or number < 1
    or not isinstance(head, dict)
    or not isinstance(base, dict)
    or not isinstance(changed_files, int)
    or changed_files < 0
    or changed_files > 100
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
]
if any("\t" in value or "\n" in value for value in values):
    raise SystemExit(1)
pathlib.Path(destination).write_text("\t".join(values) + "\n", encoding="utf-8")
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
  local trusted_engine_blob="$9"
  shift 9
  local authorized_engine_blob="$1"
  local trusted_harness_blob="$2"
  local authorized_harness_blob="$3"
  local destination="$4"

  python3 - \
    "$publisher_source" \
    "$changed_paths" \
    "$repository" \
    "$pull_number" \
    "$head_repository" \
    "$head_ref" \
    "$head_sha" \
    "$base_ref" \
    "$trusted_engine_blob" \
    "$authorized_engine_blob" \
    "$trusted_harness_blob" \
    "$authorized_harness_blob" \
    "$destination" \
    "$EXPECTED_TEST_COUNT" \
    "$MAX_AUTHORIZATION_AGE_SECONDS" <<'PY'
import datetime
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
if actual_paths != sorted(required_paths):
    raise SystemExit(1)

sha_pattern = re.compile(r"^[0-9a-f]{40}$")
id_pattern = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$")
repository_pattern = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ref_pattern = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,253}[A-Za-z0-9._-])?$")
now = datetime.datetime.now(datetime.timezone.utc)
max_age = datetime.timedelta(seconds=int(max_age_text))
seen_ids = set()
eligible = []

def timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError
    parsed = datetime.datetime.fromisoformat(value[:-1] + "+00:00")
    canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if canonical != value:
        raise ValueError
    return parsed

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
        or not isinstance(authorization["headRepository"], str)
        or not repository_pattern.fullmatch(authorization["headRepository"])
        or authorization["enginePath"] != ".github/scripts/test-coverage-matrix.js"
        or authorization["harnessPath"]
        != ".github/scripts/test-test-coverage-matrix.js"
        or authorization["allowedPaths"] != required_paths
        or not isinstance(authorization["pullNumber"], int)
        or authorization["pullNumber"] < 1
        or not isinstance(authorization["expectedTests"], int)
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
    if authorization["baseRef"] not in {"dev", "master"}:
        raise SystemExit(1)
    try:
        issued_at = timestamp(authorization["issuedAt"])
        expires_at = timestamp(authorization["expiresAt"])
    except (TypeError, ValueError):
        raise SystemExit(1)
    if (
        issued_at > now
        or expires_at <= now
        or expires_at <= issued_at
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
    if (
        authorization["repository"] == repository
        and authorization["headRepository"] == repository
        and head_repository == repository
        and authorization["pullNumber"] == int(pull_number_text)
        and authorization["headRef"] == head_ref
        and authorization["headSha"] == head_sha
        and authorization["baseRef"] == base_ref
        and authorization["trustedEngineBlob"] == trusted_engine_blob
        and authorization["authorizedEngineBlob"] == authorized_engine_blob
        and authorization["trustedHarnessBlob"] == trusted_harness_blob
        and authorization["authorizedHarnessBlob"] == authorized_harness_blob
    ):
        eligible.append(authorization)

if len(eligible) != 1:
    raise SystemExit(1)
selected = eligible[0]
pathlib.Path(destination).write_text(
    (
        f"{selected['id']}\n"
        f"{selected['expectedTests']}\n"
        f"{selected['baseSha']}\n"
        f"{selected['receiptSha']}\n"
        f"{selected['adoptionSha']}\n"
    ),
    encoding="utf-8",
)
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
  changed_file_count <"$metadata_file"
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

publisher_source="$work_dir/trusted-publisher.js"
trusted_review_file="$work_dir/trusted-review.sh"
trusted_invocation_file="$work_dir/trusted-invocation.sh"
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
[[ "$(hash_file "$trusted_review_file")" == "$current_review_blob" ]] ||
  fail "coverage-review-differs-from-default"
[[ "$(hash_file "$trusted_invocation_file")" == "$current_invocation_blob" ]] ||
  fail "coverage-invocation-differs-from-default"
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
  "$trusted_engine_blob" \
  "$current_engine_blob" \
  "$trusted_harness_blob" \
  "$current_harness_blob" \
  "$authorization_selection" ||
  fail "coverage-assets-are-not-authorized"
authorization_id="$(sed -n '1p' "$authorization_selection")"
expected_tests="$(sed -n '2p' "$authorization_selection")"
authorization_base_sha="$(sed -n '3p' "$authorization_selection")"
authorization_receipt_sha="$(sed -n '4p' "$authorization_selection")"
authorization_adoption_sha="$(sed -n '5p' "$authorization_selection")"
[[ "$authorization_id" =~ ^[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?$ ]] ||
  fail "selected-authorization-id-is-invalid"
[[ "$expected_tests" == "$EXPECTED_TEST_COUNT" ]] ||
  fail "selected-test-count-is-invalid"
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
  'coverage_engine_review=PASS mode=authorized authorization=%s image=%s platform=%s node=%s engine=%s harness=%s %s %s %s\n' \
  "$authorization_id" \
  "${PINNED_IMAGE##*@}" \
  "$EXPECTED_PLATFORM" \
  "$EXPECTED_NODE_VERSION" \
  "${current_engine_blob:0:12}" \
  "${current_harness_blob:0:12}" \
  "$tests_summary" \
  "$stdout_summary" \
  "$stderr_summary"
