#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=application-registry.sh
source "$SCRIPT_DIR/application-registry.sh"

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

inspect_image_tag_digest() {
  local tag="$1"
  local inspect_error="$2"
  local output status
  set +e
  output="$(
    docker buildx imagetools inspect "$tag" \
      --format '{{json .Manifest.Digest}}' \
      2>"$inspect_error"
  )"
  status=$?
  set -e
  if [[ "$status" == "0" ]]; then
    rm -f "$inspect_error"
    output="${output//\"/}"
    [[ "$output" =~ ^sha256:[0-9a-f]{64}$ ]] || return 20
    printf '%s\n' "$output"
    return 0
  fi
  if grep -Eiq '404|manifest unknown|name unknown|not found' "$inspect_error"; then
    rm -f "$inspect_error"
    return 10
  fi
  cat "$inspect_error" >&2
  return 20
}

SOURCE_SHA="${SOURCE_SHA:-${1:-}}"
REUSE_SOURCE_SHA="${REUSE_SOURCE_SHA:-${2:-}}"
REUSE_BUILD_RUN_ID="${REUSE_BUILD_RUN_ID:-${3:-}}"
REUSE_PROVENANCE_DIR="${REUSE_PROVENANCE_DIR:-${4:-}}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-build}"
PLATFORM="${PLATFORM:-linux/arm64}"

oci_require_command docker
application_registry_require_ghcr
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

oci_prepare_private_dir "$OUTPUT_DIR"
if compgen -G "$OUTPUT_DIR/*.env" >/dev/null; then
  oci_die "output directory already contains image provenance"
fi

repository="$(application_registry_repository)"
services=(auth bet backoffice client event gamemaster moderation resulting slip)
plan_file="$OUTPUT_DIR/reuse-plan.tsv"
artifact_service=""
artifact_schema=""
artifact_registry_provider=""
artifact_registry_host=""
artifact_registry_tag_prefix=""
artifact_registry_tag_schema=""
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

if [[ "${APPLICATION_REGISTRY_ALREADY_AUTHENTICATED:-false}" != "true" ]]; then
  oci_require_vars APPLICATION_REGISTRY_USERNAME APPLICATION_REGISTRY_TOKEN
  printf '%s' "$APPLICATION_REGISTRY_TOKEN" |
    docker login "$APPLICATION_REGISTRY_HOST" \
      --username "$APPLICATION_REGISTRY_USERNAME" --password-stdin >/dev/null
  trap 'docker logout "$APPLICATION_REGISTRY_HOST" >/dev/null 2>&1 || true' EXIT
fi

for expected_service in "${services[@]}"; do
  provenance="$REUSE_PROVENANCE_DIR/${expected_service}.env"
  [[ -f "$provenance" ]] || oci_die "missing reusable provenance for $expected_service"
  artifact_schema="$(env_value "$provenance" schema)"
  artifact_registry_provider="$(env_value "$provenance" registry_provider)"
  artifact_registry_host="$(env_value "$provenance" registry_host)"
  artifact_registry_tag_prefix="$(env_value "$provenance" registry_tag_prefix)"
  artifact_registry_tag_schema="$(env_value "$provenance" registry_tag_schema)"
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
  [[ "$artifact_schema" == "betstan.application-image-provenance.v1" &&
     "$artifact_registry_provider" == "ghcr" &&
     "$artifact_registry_host" == "ghcr.io" &&
     "$artifact_registry_tag_prefix" == "arm64" &&
     "$artifact_registry_tag_schema" == "v1" ]] ||
    oci_die "reusable provenance is not a trusted GHCR application generation"
  [[ "$artifact_source_sha" == "$REUSE_SOURCE_SHA" ]] ||
    oci_die "reusable source SHA mismatch for $expected_service"
  [[ "$artifact_build_run_id" == "$REUSE_BUILD_RUN_ID" &&
     "$artifact_build_run_attempt" == "1" ]] ||
    oci_die "reusable build provenance mismatch for $expected_service"
  [[ "$artifact_repository" == "$repository" ]] ||
    oci_die "reusable repository mismatch for $expected_service"
  application_registry_validate_tag \
    "$expected_service" "$REUSE_SOURCE_SHA" "$artifact_tag"
  [[ "$artifact_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "reusable digest is invalid for $expected_service"
  [[ "$artifact_platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "reusable platform digest is invalid for $expected_service"
  [[ "$artifact_image_ref" == "${repository}@${artifact_digest}" ]] ||
    oci_die "reusable image reference mismatch for $expected_service"
  [[ "$artifact_platform" == "$PLATFORM" ]] ||
    oci_die "reusable platform mismatch for $expected_service"

  new_tag="${repository}:$(application_registry_tag "$expected_service" "$SOURCE_SHA")"
  inspect_error="$OUTPUT_DIR/${expected_service}.tag-inspect.log"
  set +e
  observed_digest="$(inspect_image_tag_digest "$new_tag" "$inspect_error")"
  inspect_status=$?
  set -e
  case "$inspect_status" in
    0)
      [[ "$observed_digest" == "$artifact_digest" ]] ||
        oci_die "existing exact OCI tag has an unexpected digest for $expected_service"
      action=existing
      ;;
    10)
      action=create
      ;;
    *)
      oci_die "unable to validate the exact OCI tag for $expected_service"
      ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$action" "$expected_service" "$repository" "$artifact_digest" \
    "$artifact_platform_digest" "$artifact_image_ref" \
    >> "$plan_file"
done

while IFS=$'\t' read -r action service service_repository digest platform_digest image_ref; do
  new_tag="${service_repository}:$(application_registry_tag "$service" "$SOURCE_SHA")"
  if [[ "$action" == "create" ]]; then
    docker buildx imagetools create \
      --prefer-index=false \
      --tag "$new_tag" \
      "$image_ref"
  fi
  set +e
  observed_digest="$(
    inspect_image_tag_digest "$new_tag" "$OUTPUT_DIR/${service}.created-tag-inspect.log"
  )"
  inspect_status=$?
  set -e
  [[ "$inspect_status" == "0" ]] ||
    oci_die "unable to verify reused tag after publication for $service"
  [[ "$observed_digest" == "$digest" ]] ||
    oci_die "reused tag digest differs from approved provenance for $service"
  {
    printf 'service=%q\n' "$service"
    printf 'schema=%q\n' "betstan.application-image-provenance.v1"
    printf 'registry_provider=%q\n' "$APPLICATION_REGISTRY_PROVIDER"
    printf 'registry_host=%q\n' "$APPLICATION_REGISTRY_HOST"
    printf 'registry_tag_prefix=%q\n' "$APPLICATION_REGISTRY_TAG_PREFIX"
    printf 'registry_tag_schema=%q\n' "$APPLICATION_REGISTRY_TAG_SCHEMA"
    printf 'repository=%q\n' "$service_repository"
    printf 'source_sha=%q\n' "$SOURCE_SHA"
    printf 'tag=%q\n' "$new_tag"
    printf 'digest=%q\n' "$digest"
    printf 'platform_digest=%q\n' "$platform_digest"
    printf 'image_ref=%q\n' "$image_ref"
    printf 'platform=%q\n' "$PLATFORM"
    printf 'build_run_id=%q\n' "${GITHUB_RUN_ID:-local}"
    printf 'build_run_attempt=%q\n' "${GITHUB_RUN_ATTEMPT:-1}"
    printf 'build_workflow=%q\n' "${BUILD_WORKFLOW_IDENTITY:-oci-production-build}"
    printf 'upstream_workflow=%q\n' "${UPSTREAM_BUILD_WORKFLOW:-production-build}"
    printf 'upstream_run_id=%q\n' "${UPSTREAM_RUN_ID:-local}"
    printf 'upstream_run_attempt=%q\n' "${UPSTREAM_RUN_ATTEMPT:-1}"
    printf 'reuse_source_sha=%q\n' "$REUSE_SOURCE_SHA"
    printf 'reuse_build_run_id=%q\n' "$REUSE_BUILD_RUN_ID"
  } > "$OUTPUT_DIR/${service}.env"
done < "$plan_file"

rm -f "$plan_file"
oci_log "oci_image_reuse=PASS services=${#services[@]} platform=$PLATFORM source=$REUSE_SOURCE_SHA"
