#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
WORK_DIR="$OCI_DIR/tests/.image-reuse-work"
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

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/bin" "$WORK_DIR/source" "$WORK_DIR/state"
trap 'rm -rf "$WORK_DIR"' EXIT

cat > "$WORK_DIR/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${MOCK_DOCKER_LOG:?}"

tag_key() {
  printf '%s' "$1" | cksum | awk '{print $1}'
}

case "${1:-} ${2:-}" in
  "login fixture.invalid")
    cat >/dev/null
    ;;
  "logout fixture.invalid")
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

services=(auth bet backoffice client event gamemaster moderation resulting slip)
index=1
repository=fixture.invalid/namespace/betstan_images
for service in "${services[@]}"; do
  digest="$(printf '%064d' "$index")"
  cat > "$WORK_DIR/source/${service}.env" <<ENV
service=${service}
repository=${repository}
source_sha=${OLD_SHA}
tag=${repository}:oci-${service}-${OLD_SHA}
digest=sha256:${digest}
platform_digest=sha256:${digest}
image_ref=${repository}@sha256:${digest}
platform=linux/arm64
build_run_id=${OLD_RUN_ID}
build_run_attempt=1
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
OCI_REGISTRY_HOST=fixture.invalid \
OCI_REGISTRY_NAMESPACE=namespace \
OCI_IMAGE_PREFIX=betstan \
OCI_REGISTRY_USERNAME=fixture \
OCI_REGISTRY_AUTH_TOKEN=fixture \
GITHUB_RUN_ID="$NEW_RUN_ID" \
GITHUB_RUN_ATTEMPT=1 \
  "$OCI_DIR/scripts/reuse-images.sh" >/dev/null

[[ "$(grep -c '^buildx imagetools create --prefer-index=false --tag ' "$WORK_DIR/docker.log")" == "9" ]] ||
  fail "reuse did not create exactly nine immutable tags"
for service in "${services[@]}"; do
  provenance="$WORK_DIR/output/${service}.env"
  [[ -s "$provenance" ]] || fail "reuse provenance is missing for $service"
  grep -Fxq "service=$service" "$provenance"
  grep -Fxq "source_sha=$NEW_SHA" "$provenance"
  grep -Fxq "tag=${repository}:oci-${service}-${NEW_SHA}" "$provenance"
  grep -Fxq "build_run_id=$NEW_RUN_ID" "$provenance"
  grep -Fxq "reuse_source_sha=$OLD_SHA" "$provenance"
  grep -Fxq "reuse_build_run_id=$OLD_RUN_ID" "$provenance"
done

if PATH="$WORK_DIR/bin:$PATH" \
    MOCK_DOCKER_LOG="$WORK_DIR/docker.log" \
    MOCK_DOCKER_STATE="$WORK_DIR/state" \
    MOCK_DOCKER_FAIL_TAG="oci-event-${RETRY_SHA}" \
    SOURCE_SHA="$RETRY_SHA" \
    REUSE_SOURCE_SHA="$OLD_SHA" \
    REUSE_BUILD_RUN_ID="$OLD_RUN_ID" \
    REUSE_PROVENANCE_DIR="$WORK_DIR/source" \
    OUTPUT_DIR="$WORK_DIR/retry-first" \
    PLATFORM=linux/arm64 \
    OCI_REGISTRY_HOST=fixture.invalid \
    OCI_REGISTRY_NAMESPACE=namespace \
    OCI_IMAGE_PREFIX=betstan \
    OCI_REGISTRY_USERNAME=fixture \
    OCI_REGISTRY_AUTH_TOKEN=fixture \
    "$OCI_DIR/scripts/reuse-images.sh" >/dev/null 2>&1; then
  fail "injected mid-publication failure unexpectedly succeeded"
fi
PATH="$WORK_DIR/bin:$PATH" \
MOCK_DOCKER_LOG="$WORK_DIR/docker.log" \
MOCK_DOCKER_STATE="$WORK_DIR/state" \
MOCK_DOCKER_FAIL_TAG="oci-event-${RETRY_SHA}" \
SOURCE_SHA="$RETRY_SHA" \
REUSE_SOURCE_SHA="$OLD_SHA" \
REUSE_BUILD_RUN_ID="$OLD_RUN_ID" \
REUSE_PROVENANCE_DIR="$WORK_DIR/source" \
OUTPUT_DIR="$WORK_DIR/retry-second" \
PLATFORM=linux/arm64 \
OCI_REGISTRY_HOST=fixture.invalid \
OCI_REGISTRY_NAMESPACE=namespace \
OCI_IMAGE_PREFIX=betstan \
OCI_REGISTRY_USERNAME=fixture \
OCI_REGISTRY_AUTH_TOKEN=fixture \
GITHUB_RUN_ID="$NEW_RUN_ID" \
GITHUB_RUN_ATTEMPT=1 \
  "$OCI_DIR/scripts/reuse-images.sh" >/dev/null
for service in "${services[@]}"; do
  [[ -s "$WORK_DIR/retry-second/${service}.env" ]] ||
    fail "retry did not recover provenance for $service"
done

auth_tag="${repository}:oci-auth-${MISMATCH_SHA}"
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
    OCI_REGISTRY_HOST=fixture.invalid \
    OCI_REGISTRY_NAMESPACE=namespace \
    OCI_IMAGE_PREFIX=betstan \
    OCI_REGISTRY_USERNAME=fixture \
    OCI_REGISTRY_AUTH_TOKEN=fixture \
    "$OCI_DIR/scripts/reuse-images.sh" >/dev/null 2>&1; then
  fail "reuse accepted an existing exact target tag with a mismatched digest"
fi
create_count_after="$(
  grep -c '^buildx imagetools create --prefer-index=false --tag ' "$WORK_DIR/docker.log"
)"
[[ "$create_count_after" == "$create_count_before" ]] ||
  fail "reuse mutated the registry before completing all tag-absence checks"

input_repo="$WORK_DIR/input-repository"
git -C "$WORK_DIR" init -q input-repository
git -C "$input_repo" config user.name fixture
git -C "$input_repo" config user.email fixture@example.invalid
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

echo "oci_image_reuse_contract=PASS"
