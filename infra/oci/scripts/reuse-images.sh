#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '
    $1 == key {
      sub(/^[^=]*=/, "")
      print
      found = 1
      exit
    }
    END {
      if (!found) {
        exit 1
      }
    }
  ' "$file"
}

require_absent_image_tag() {
  local tag="$1"
  local inspect_error="$2"
  if docker buildx imagetools inspect "$tag" >"$inspect_error" 2>&1; then
    oci_die "exact OCI tag already exists; refusing overwrite for $tag"
  fi
  if ! grep -Eiq '404|manifest unknown|name unknown|not found' "$inspect_error"; then
    oci_die "unable to prove the exact OCI tag is absent for $tag"
  fi
  rm -f "$inspect_error"
}

SOURCE_SHA="${SOURCE_SHA:-${1:-}}"
REUSE_SOURCE_SHA="${REUSE_SOURCE_SHA:-${2:-}}"
REUSE_BUILD_RUN_ID="${REUSE_BUILD_RUN_ID:-${3:-}}"
REUSE_PROVENANCE_DIR="${REUSE_PROVENANCE_DIR:-${4:-}}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-build}"
PLATFORM="${PLATFORM:-linux/arm64}"

oci_require_command docker
oci_require_vars \
  OCI_REGISTRY_HOST OCI_REGISTRY_NAMESPACE OCI_IMAGE_PREFIX \
  OCI_REGISTRY_USERNAME OCI_REGISTRY_AUTH_TOKEN
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "SOURCE_SHA must be a full lowercase commit SHA"
[[ "$REUSE_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "REUSE_SOURCE_SHA must be a full lowercase commit SHA"
[[ "$SOURCE_SHA" != "$REUSE_SOURCE_SHA" ]] ||
  oci_die "reuse source must differ from the requested source SHA"
[[ "$REUSE_BUILD_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "REUSE_BUILD_RUN_ID must be a positive integer"
[[ -d "$REUSE_PROVENANCE_DIR" ]] ||
  oci_die "reusable provenance directory not found"
[[ "$PLATFORM" == "linux/arm64" ]] ||
  oci_die "OCI images must target linux/arm64"
[[ "$OCI_REGISTRY_HOST" != *"://"* ]] ||
  oci_die "OCI_REGISTRY_HOST must not contain a URL scheme"
[[ "$OCI_IMAGE_PREFIX" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] ||
  oci_die "OCI_IMAGE_PREFIX contains unsupported repository characters"

oci_prepare_private_dir "$OUTPUT_DIR"
if compgen -G "$OUTPUT_DIR/*.env" >/dev/null; then
  oci_die "output directory already contains image provenance"
fi

repository="${OCI_REGISTRY_HOST}/${OCI_REGISTRY_NAMESPACE}/${OCI_IMAGE_PREFIX}_images"
services=(auth bet backoffice client event gamemaster moderation resulting slip)
plan_file="$OUTPUT_DIR/reuse-plan.tsv"
artifact_service=""
artifact_repository=""
artifact_source_sha=""
artifact_tag=""
artifact_digest=""
artifact_platform_digest=""
artifact_image_ref=""
artifact_platform=""
artifact_build_run_id=""
artifact_build_run_attempt=""
: > "$plan_file"
chmod 600 "$plan_file"

printf '%s' "$OCI_REGISTRY_AUTH_TOKEN" |
  docker login "$OCI_REGISTRY_HOST" \
    --username "$OCI_REGISTRY_USERNAME" --password-stdin >/dev/null
trap 'docker logout "$OCI_REGISTRY_HOST" >/dev/null 2>&1 || true' EXIT

for expected_service in "${services[@]}"; do
  provenance="$REUSE_PROVENANCE_DIR/${expected_service}.env"
  [[ -f "$provenance" ]] || oci_die "missing reusable provenance for $expected_service"
  artifact_service="$(env_value "$provenance" service)"
  artifact_repository="$(env_value "$provenance" repository)"
  artifact_source_sha="$(env_value "$provenance" source_sha)"
  artifact_tag="$(env_value "$provenance" tag)"
  artifact_digest="$(env_value "$provenance" digest)"
  artifact_platform_digest="$(env_value "$provenance" platform_digest)"
  artifact_image_ref="$(env_value "$provenance" image_ref)"
  artifact_platform="$(env_value "$provenance" platform)"
  artifact_build_run_id="$(env_value "$provenance" build_run_id)"
  artifact_build_run_attempt="$(env_value "$provenance" build_run_attempt)"
  [[ "$artifact_service" == "$expected_service" ]] ||
    oci_die "reusable service mismatch for $expected_service"
  [[ "$artifact_source_sha" == "$REUSE_SOURCE_SHA" ]] ||
    oci_die "reusable source SHA mismatch for $expected_service"
  [[ "$artifact_build_run_id" == "$REUSE_BUILD_RUN_ID" &&
     "$artifact_build_run_attempt" == "1" ]] ||
    oci_die "reusable build provenance mismatch for $expected_service"
  [[ "$artifact_repository" == "$repository" ]] ||
    oci_die "reusable repository mismatch for $expected_service"
  [[ "$artifact_tag" == "${repository}:oci-${expected_service}-${REUSE_SOURCE_SHA}" ]] ||
    oci_die "reusable tag mismatch for $expected_service"
  [[ "$artifact_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "reusable digest is invalid for $expected_service"
  [[ "$artifact_platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "reusable platform digest is invalid for $expected_service"
  [[ "$artifact_image_ref" == "${repository}@${artifact_digest}" ]] ||
    oci_die "reusable image reference mismatch for $expected_service"
  [[ "$artifact_platform" == "$PLATFORM" ]] ||
    oci_die "reusable platform mismatch for $expected_service"

  new_tag="${repository}:oci-${expected_service}-${SOURCE_SHA}"
  inspect_error="$OUTPUT_DIR/${expected_service}.tag-inspect.log"
  require_absent_image_tag "$new_tag" "$inspect_error"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$expected_service" "$repository" "$artifact_digest" \
    "$artifact_platform_digest" "$artifact_image_ref" \
    >> "$plan_file"
done

while IFS=$'\t' read -r service service_repository digest platform_digest image_ref; do
  new_tag="${service_repository}:oci-${service}-${SOURCE_SHA}"
  docker buildx imagetools create \
    --prefer-index=false \
    --tag "$new_tag" \
    "$image_ref"
  observed_digest="$(
    docker buildx imagetools inspect "$new_tag" \
      --format '{{json .Manifest.Digest}}' |
      tr -d '"'
  )"
  [[ "$observed_digest" == "$digest" ]] ||
    oci_die "reused tag digest differs from approved provenance for $service"
  {
    printf 'service=%q\n' "$service"
    printf 'repository=%q\n' "$service_repository"
    printf 'source_sha=%q\n' "$SOURCE_SHA"
    printf 'tag=%q\n' "$new_tag"
    printf 'digest=%q\n' "$digest"
    printf 'platform_digest=%q\n' "$platform_digest"
    printf 'image_ref=%q\n' "$image_ref"
    printf 'platform=%q\n' "$PLATFORM"
    printf 'build_run_id=%q\n' "${GITHUB_RUN_ID:-local}"
    printf 'build_run_attempt=%q\n' "${GITHUB_RUN_ATTEMPT:-1}"
    printf 'reuse_source_sha=%q\n' "$REUSE_SOURCE_SHA"
    printf 'reuse_build_run_id=%q\n' "$REUSE_BUILD_RUN_ID"
  } > "$OUTPUT_DIR/${service}.env"
done < "$plan_file"

rm -f "$plan_file"
oci_log "oci_image_reuse=PASS services=${#services[@]} platform=$PLATFORM source=$REUSE_SOURCE_SHA"
