#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
OCI_DIR="$ROOT_DIR/infra/oci"

# Exercise the complete fixture under hostile inherited Git context, never
# against the caller's repository. The sentinel includes staged, unstaged and
# untracked work; snapshotting .git also covers HEAD, refs, config and index.
if [[ "$#" = 0 ]]; then
  python3 -I - "$OCI_DIR/tests/test-image-reuse-contract.sh" <<'PY'
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

script = sys.argv[1]
clean_env = {
    key: value for key, value in os.environ.items()
    if not key.startswith(("GIT_", "BASH_FUNC_")) and key not in ("BASH_ENV", "ENV")
}
clean_env.update(
    GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_SYSTEM=os.devnull,
    GIT_CONFIG_GLOBAL=os.devnull, GIT_ATTR_NOSYSTEM="1",
)
git = shutil.which("git")
assert git, "real Git is required for the isolation sentinel"
with tempfile.TemporaryDirectory(prefix="betstan-image-reuse-sentinel-") as temporary:
    root = Path(temporary).resolve()
    outside = root / "outside"
    fixtures = root / "fixtures"
    outside.mkdir()
    fixtures.mkdir()

    def run_git(*args):
        return subprocess.check_output(
            [git, "-C", str(outside), *args], env=clean_env, text=True,
        ).strip()

    run_git("init", "-q", "--template=")
    assert Path(run_git("rev-parse", "--show-toplevel")).resolve() == outside
    assert Path(run_git("rev-parse", "--absolute-git-dir")).resolve() == outside / ".git"
    run_git("config", "--local", "user.name", "fixture")
    run_git("config", "--local", "user.email", "fixture@example.invalid")
    (outside / "tracked").write_text("committed sentinel\n")
    run_git("add", "tracked")
    run_git("-c", "commit.gpgSign=false", "commit", "-qm", "sentinel")
    run_git("branch", "sentinel-ref")
    (outside / "tracked").write_text("staged sentinel\n")
    run_git("add", "tracked")
    (outside / "tracked").write_text("unstaged sentinel\n")
    (outside / "untracked").write_text("untracked sentinel\n")
    config = outside / ".git" / "config"
    global_config = outside / ".git" / "sentinel-global-config"
    global_config.write_text("[sentinel]\n\tvalue = unchanged\n")

    def snapshot():
        return {
            str(path.relative_to(outside)): (
                path.stat().st_mode,
                hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None,
            )
            for path in outside.rglob("*")
        }

    before = snapshot()
    hostile_env = dict(
        clean_env, TMPDIR=str(fixtures), GIT_DIR=str(outside / ".git"),
        GIT_COMMON_DIR=str(outside / ".git"), GIT_WORK_TREE=str(outside),
        GIT_INDEX_FILE=str(outside / ".git" / "index"),
        GIT_OBJECT_DIRECTORY=str(outside / ".git" / "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES=str(outside / ".git" / "objects"),
        GIT_CONFIG=str(config), GIT_CONFIG_GLOBAL=str(global_config),
        GIT_CONFIG_SYSTEM=str(global_config), GIT_CONFIG_NOSYSTEM="0",
        GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0="core.worktree",
        GIT_CONFIG_VALUE_0=str(outside), GIT_CONFIG_KEY_1="sentinel.override",
        GIT_CONFIG_VALUE_1="inherited",
        GIT_CONFIG_PARAMETERS="'sentinel.parameters=inherited'",
    )
    for failure in ("0", "1"):
        try:
            result = subprocess.run(
                ["bash", script, "--git-isolation-fixture"], cwd=outside,
                env=dict(hostile_env, IMAGE_REUSE_TEST_INJECT_FAILURE=failure),
                text=True, capture_output=True, timeout=180,
            )
        finally:
            assert snapshot() == before, "image fixture changed the outside Git sentinel"
            assert not list(fixtures.iterdir()), "image fixture leaked its owned temporary paths"
        if failure == "0":
            assert result.returncode == 0, result.stderr
            assert "oci_image_reuse_contract=PASS" in result.stdout
        else:
            assert result.returncode == 1, result.stderr
            assert "injected fixture failure after transitive commit" in result.stderr
        print(f"oci_image_reuse_git_isolation={'failure' if failure == '1' else 'success'} PASS")
print("oci_image_reuse_contract=PASS")
PY
  exit 0
fi
[[ "$#" = 1 && "$1" = "--git-isolation-fixture" ]] || exit 2

# -C alone cannot contain GIT_DIR, index/object or config overrides. Isolate
# this process and every nested comparison, without changing the caller.
while IFS= read -r variable; do
  case "$variable" in
    GIT_*) unset "$variable" ;;
  esac
done < <(compgen -e)
unset -f git docker
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/betstan-image-reuse.XXXXXX")"
WORK_DIR="$(cd "$WORK_DIR" && pwd -P)"
readonly WORK_DIR
trap 'rm -rf -- "$WORK_DIR"' EXIT
OLD_SHA=1111111111111111111111111111111111111111
NEW_SHA=2222222222222222222222222222222222222222
RETRY_SHA=3333333333333333333333333333333333333333
MISMATCH_SHA=4444444444444444444444444444444444444444
OLD_RUN_ID=1234
NEW_RUN_ID=5678

fail() {
  echo "OCI image reuse contract failure: $*" >&2
  exit 1
}

mkdir -p "$WORK_DIR/bin" "$WORK_DIR/source" "$WORK_DIR/state"

cat > "$WORK_DIR/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${MOCK_DOCKER_LOG:?}"

tag_key() {
  printf '%s' "$1" | cksum | awk '{print $1}'
}

case "${1:-} ${2:-}" in
  "login ghcr.io")
    cat >/dev/null
    ;;
  "logout ghcr.io")
    ;;
  "buildx imagetools")
    case "${3:-}" in
      inspect)
        tag="${4:?}"
        state="${MOCK_DOCKER_STATE:?}/$(tag_key "$tag")"
        if [[ -f "$state" ]]; then
          if [[ "$*" == *"--format"* ]]; then
            printf '"%s"\n' "$(cat "$state")"
          else
            printf '%s\n' "$(cat "$state")"
          fi
          exit 0
        fi
        echo "manifest unknown" >&2
        exit 1
        ;;
      create)
        [[ "${4:-}" == "--prefer-index=false" ]]
        [[ "${5:-}" == "--tag" ]]
        tag="${6:?}"
        source_ref="${7:?}"
        digest="${source_ref##*@}"
        if [[ -n "${MOCK_DOCKER_FAIL_TAG:-}" &&
              "$tag" == *"$MOCK_DOCKER_FAIL_TAG"* ]]; then
          failure_marker="${MOCK_DOCKER_STATE:?}/failure-injected"
          if [[ ! -f "$failure_marker" ]]; then
            touch "$failure_marker"
            exit 42
          fi
        fi
        printf '%s\n' "$digest" > "${MOCK_DOCKER_STATE:?}/$(tag_key "$tag")"
        ;;
      *)
        echo "unexpected mock imagetools command: $*" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unexpected mock docker command: $*" >&2
    exit 1
    ;;
esac
MOCK
chmod +x "$WORK_DIR/bin/docker"

services=(auth bet backoffice client event gamemaster moderation resulting slip telemetry)
index=1
repository=ghcr.io/vasilyevstan/betstan-images
for service in "${services[@]}"; do
  digest="$(printf '%064d' "$index")"
  cat > "$WORK_DIR/source/${service}.env" <<ENV
service=${service}
schema=betstan.application-image-provenance.v1
registry_provider=ghcr
registry_host=ghcr.io
registry_tag_prefix=arm64
registry_tag_schema=v1
repository=${repository}
source_sha=${OLD_SHA}
tag=${repository}:arm64-${service}-${OLD_SHA}
digest=sha256:${digest}
platform_digest=sha256:${digest}
image_ref=${repository}@sha256:${digest}
platform=linux/arm64
build_run_id=${OLD_RUN_ID}
build_run_attempt=1
build_workflow=oci-production-build
upstream_workflow=production-build
upstream_run_id=99
upstream_run_attempt=1
ENV
  index=$((index + 1))
done

PATH="$WORK_DIR/bin:$PATH" \
MOCK_DOCKER_LOG="$WORK_DIR/docker.log" \
MOCK_DOCKER_STATE="$WORK_DIR/state" \
SOURCE_SHA="$NEW_SHA" \
REUSE_SOURCE_SHA="$OLD_SHA" \
REUSE_BUILD_RUN_ID="$OLD_RUN_ID" \
REUSE_PROVENANCE_DIR="$WORK_DIR/source" \
OUTPUT_DIR="$WORK_DIR/output" \
PLATFORM=linux/arm64 \
APPLICATION_REGISTRY_PROVIDER=ghcr \
APPLICATION_REGISTRY_HOST=ghcr.io \
APPLICATION_REGISTRY_REPOSITORY=vasilyevstan/betstan-images \
APPLICATION_REGISTRY_TAG_PREFIX=arm64 \
APPLICATION_REGISTRY_TAG_SCHEMA=v1 \
APPLICATION_REGISTRY_USERNAME=fixture \
APPLICATION_REGISTRY_TOKEN=fixture \
GITHUB_RUN_ID="$NEW_RUN_ID" \
GITHUB_RUN_ATTEMPT=1 \
  "$OCI_DIR/scripts/reuse-images.sh" >/dev/null

[[ "$(grep -c '^buildx imagetools create --prefer-index=false --tag ' "$WORK_DIR/docker.log")" == "10" ]] ||
  fail "reuse did not create exactly ten immutable tags"
for service in "${services[@]}"; do
  provenance="$WORK_DIR/output/${service}.env"
  [[ -s "$provenance" ]] || fail "reuse provenance is missing for $service"
  grep -Fxq "service=$service" "$provenance"
  grep -Fxq "source_sha=$NEW_SHA" "$provenance"
  grep -Fxq "tag=${repository}:arm64-${service}-${NEW_SHA}" "$provenance"
  grep -Fxq "build_run_id=$NEW_RUN_ID" "$provenance"
  grep -Fxq "reuse_source_sha=$OLD_SHA" "$provenance"
  grep -Fxq "reuse_build_run_id=$OLD_RUN_ID" "$provenance"
done

if PATH="$WORK_DIR/bin:$PATH" \
    MOCK_DOCKER_LOG="$WORK_DIR/docker.log" \
    MOCK_DOCKER_STATE="$WORK_DIR/state" \
    MOCK_DOCKER_FAIL_TAG="arm64-event-${RETRY_SHA}" \
    SOURCE_SHA="$RETRY_SHA" \
    REUSE_SOURCE_SHA="$OLD_SHA" \
    REUSE_BUILD_RUN_ID="$OLD_RUN_ID" \
    REUSE_PROVENANCE_DIR="$WORK_DIR/source" \
    OUTPUT_DIR="$WORK_DIR/retry-first" \
    PLATFORM=linux/arm64 \
    APPLICATION_REGISTRY_USERNAME=fixture \
    APPLICATION_REGISTRY_TOKEN=fixture \
    "$OCI_DIR/scripts/reuse-images.sh" >/dev/null 2>&1; then
  fail "injected mid-publication failure unexpectedly succeeded"
fi
PATH="$WORK_DIR/bin:$PATH" \
MOCK_DOCKER_LOG="$WORK_DIR/docker.log" \
MOCK_DOCKER_STATE="$WORK_DIR/state" \
MOCK_DOCKER_FAIL_TAG="arm64-event-${RETRY_SHA}" \
SOURCE_SHA="$RETRY_SHA" \
REUSE_SOURCE_SHA="$OLD_SHA" \
REUSE_BUILD_RUN_ID="$OLD_RUN_ID" \
REUSE_PROVENANCE_DIR="$WORK_DIR/source" \
OUTPUT_DIR="$WORK_DIR/retry-second" \
PLATFORM=linux/arm64 \
APPLICATION_REGISTRY_USERNAME=fixture \
APPLICATION_REGISTRY_TOKEN=fixture \
GITHUB_RUN_ID="$NEW_RUN_ID" \
GITHUB_RUN_ATTEMPT=1 \
  "$OCI_DIR/scripts/reuse-images.sh" >/dev/null
for service in "${services[@]}"; do
  [[ -s "$WORK_DIR/retry-second/${service}.env" ]] ||
    fail "retry did not recover provenance for $service"
done

auth_tag="${repository}:arm64-auth-${MISMATCH_SHA}"
auth_key="$(printf '%s' "$auth_tag" | cksum | awk '{print $1}')"
printf '%s\n' "sha256:$(printf '%064d' 99)" > "$WORK_DIR/state/$auth_key"
create_count_before="$(
  grep -c '^buildx imagetools create --prefer-index=false --tag ' "$WORK_DIR/docker.log"
)"
if PATH="$WORK_DIR/bin:$PATH" \
    MOCK_DOCKER_LOG="$WORK_DIR/docker.log" \
    MOCK_DOCKER_STATE="$WORK_DIR/state" \
    SOURCE_SHA="$MISMATCH_SHA" \
    REUSE_SOURCE_SHA="$OLD_SHA" \
    REUSE_BUILD_RUN_ID="$OLD_RUN_ID" \
    REUSE_PROVENANCE_DIR="$WORK_DIR/source" \
    OUTPUT_DIR="$WORK_DIR/existing-output" \
    PLATFORM=linux/arm64 \
    APPLICATION_REGISTRY_USERNAME=fixture \
    APPLICATION_REGISTRY_TOKEN=fixture \
    "$OCI_DIR/scripts/reuse-images.sh" >/dev/null 2>&1; then
  fail "reuse accepted an existing exact target tag with a mismatched digest"
fi
create_count_after="$(
  grep -c '^buildx imagetools create --prefer-index=false --tag ' "$WORK_DIR/docker.log"
)"
[[ "$create_count_after" == "$create_count_before" ]] ||
  fail "reuse mutated the registry before completing all tag-absence checks"

input_repo="$WORK_DIR/input-repository"
[[ ! -e "$input_repo" ]] || fail "input fixture already exists"
git -C "$WORK_DIR" init --template= -q input-repository
[[ "$(git -C "$input_repo" rev-parse --show-toplevel)" = "$input_repo" &&
   "$(git -C "$input_repo" rev-parse --absolute-git-dir)" = "$input_repo/.git" ]] ||
  fail "input fixture Git root is not the owned temporary repository"
git -C "$input_repo" config --local user.name fixture
git -C "$input_repo" config --local user.email fixture@example.invalid
mkdir -p \
  "$input_repo/infra/oci/build" \
  "$input_repo/infra/oci/scripts"
touch "$input_repo/.dockerignore"
for service in "${services[@]}"; do
  mkdir -p "$input_repo/$service"
  printf '%s\n' "$service" > "$input_repo/$service/input.txt"
done
printf '%s\n' 'fixture image recipe' \
  > "$input_repo/infra/oci/build/Dockerfile.backend"
printf '%s\n' 'fixture build driver' \
  > "$input_repo/infra/oci/scripts/build-images.sh"
cat > "$input_repo/infra/oci/scripts/lib.sh" <<'LIB'
OCI_ROOT_DIR="$(pwd)"
oci_die() {
  exit 1
}
oci_log() {
  printf '%s\n' "$*"
}
oci_require_command() {
  command -v "$1"
}
oci_require_vars() {
  return 0
}
oci_prepare_private_dir() {
  mkdir -p "$1"
}
oci_unrelated_helper() {
  return 0
}
LIB
git -C "$input_repo" add .
git -C "$input_repo" commit -q -m base
input_base="$(git -C "$input_repo" rev-parse HEAD)"

cat >> "$input_repo/infra/oci/scripts/lib.sh" <<'LIB'
oci_another_unrelated_helper() {
  return 0
}
LIB
git -C "$input_repo" add infra/oci/scripts/lib.sh
git -C "$input_repo" commit -q -m unrelated
input_unrelated="$(git -C "$input_repo" rev-parse HEAD)"
IMAGE_INPUT_REPOSITORY_ROOT="$input_repo" \
  "$OCI_DIR/scripts/compare-image-inputs.sh" \
  "$input_base" "$input_unrelated" >/dev/null ||
  fail "unrelated library helper prevented immutable image reuse"

cat >> "$input_repo/infra/oci/scripts/lib.sh" <<'LIB'
oci_log() {
  oci_log_delegate "$*"
}
oci_log_delegate() {
  printf 'delegated: %s\n' "$*"
}
LIB
git -C "$input_repo" add infra/oci/scripts/lib.sh
git -C "$input_repo" commit -q -m transitive
input_transitive="$(git -C "$input_repo" rev-parse HEAD)"
if IMAGE_INPUT_REPOSITORY_ROOT="$input_repo" \
    "$OCI_DIR/scripts/compare-image-inputs.sh" \
    "$input_unrelated" "$input_transitive" >/dev/null 2>&1; then
  fail "untracked transitive build helper was accepted for image reuse"
fi

[[ "${IMAGE_REUSE_TEST_INJECT_FAILURE:-0}" != 1 ]] ||
  fail "injected fixture failure after transitive commit"

echo "oci_image_reuse_contract=PASS"
