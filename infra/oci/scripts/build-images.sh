#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=application-registry.sh
source "$SCRIPT_DIR/application-registry.sh"

SOURCE_SHA="${SOURCE_SHA:-${1:-}}"
PUSH_IMAGES="${PUSH_IMAGES:-1}"
REPAIR_EXISTING_TAGS="${REPAIR_EXISTING_TAGS:-0}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-build}"
PLATFORM="${PLATFORM:-linux/arm64}"

oci_require_command docker
oci_require_command jq
oci_require_command git
application_registry_require_ghcr
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || oci_die "SOURCE_SHA must be a full lowercase commit SHA"
[[ "$PLATFORM" == "linux/arm64" ]] || oci_die "OCI images must target linux/arm64"
[[ "$REPAIR_EXISTING_TAGS" == "0" || "$REPAIR_EXISTING_TAGS" == "1" ]] ||
  oci_die "REPAIR_EXISTING_TAGS must be 0 or 1"
[[ "$PUSH_IMAGES" == "1" || "$REPAIR_EXISTING_TAGS" == "0" ]] ||
  oci_die "existing GHCR tags can be repaired only during remote publication"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(
  git -C "$OCI_ROOT_DIR" show -s --format=%ct "$SOURCE_SHA"
)}"
[[ "$SOURCE_DATE_EPOCH" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "SOURCE_DATE_EPOCH must be the exact source commit timestamp"
export SOURCE_DATE_EPOCH

if [[ "$PUSH_IMAGES" == "1" ]]; then
  if [[ "${APPLICATION_REGISTRY_ALREADY_AUTHENTICATED:-false}" != "true" ]]; then
    oci_require_vars APPLICATION_REGISTRY_USERNAME APPLICATION_REGISTRY_TOKEN
    printf '%s' "$APPLICATION_REGISTRY_TOKEN" |
      docker login "$APPLICATION_REGISTRY_HOST" \
        --username "$APPLICATION_REGISTRY_USERNAME" --password-stdin >/dev/null
    trap 'docker logout "$APPLICATION_REGISTRY_HOST" >/dev/null 2>&1 || true' EXIT
  fi
fi

oci_prepare_private_dir "$OUTPUT_DIR"
services=(auth bet backoffice client event gamemaster moderation resulting slip)
repository="$(application_registry_repository)"

for service in "${services[@]}"; do
  tag="${repository}:$(application_registry_tag "$service" "$SOURCE_SHA")"
  metadata="$OUTPUT_DIR/${service}.metadata.json"
  provenance="$OUTPUT_DIR/${service}.env"
  tag_exists=0
  if [[ "$PUSH_IMAGES" == "1" ]]; then
    inspect_error="$OUTPUT_DIR/${service}.tag-inspect.log"
    if docker buildx imagetools inspect "$tag" >"$inspect_error" 2>&1; then
      tag_exists=1
      [[ "$REPAIR_EXISTING_TAGS" == "1" ]] ||
        oci_die "exact GHCR tag already exists; refusing overwrite for $service"
    elif ! grep -Eiq '404|manifest unknown|name unknown|not found' "$inspect_error"; then
      oci_die "unable to prove the exact GHCR tag is absent for $service"
    fi
    rm -f "$inspect_error"
  fi
  build_args=(
    buildx build
    --platform "$PLATFORM"
    --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
    --provenance=false
    --sbom=false
    --metadata-file "$metadata"
    --build-arg "BUILDKIT_MULTI_PLATFORM=1"
    --label "org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY:-vasilyevstan/betstan}"
    --label "org.opencontainers.image.revision=$SOURCE_SHA"
    --label "org.opencontainers.image.title=betstan-${service}"
    --label "io.betstan.service=$service"
    --label "io.betstan.registry-provider=ghcr"
  )
  if [[ "$service" == "client" ]]; then
    build_args+=(--file infra/oci/build/Dockerfile.client .)
  else
    build_args+=(
      --file infra/oci/build/Dockerfile.backend
      --build-arg "SERVICE=$service"
      .
    )
  fi
  if [[ "$PUSH_IMAGES" == "1" ]]; then
    build_args+=(
      --output
      "type=image,name=${repository},push-by-digest=true,name-canonical=true,push=true,rewrite-timestamp=true,compatibility-version=20,oci-mediatypes=false,compression=gzip,compression-level=6,force-compression=true"
    )
  else
    build_args+=(--tag "$tag" --load)
  fi

  (cd "$OCI_ROOT_DIR" && docker "${build_args[@]}")
  digest="$(jq -r '."containerimage.digest" // empty' "$metadata")"
  if [[ "$PUSH_IMAGES" == "1" ]]; then
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
      oci_die "build did not return an immutable digest for $service"
    image_ref="${repository}@${digest}"
    manifest_json="$(docker buildx imagetools inspect "$image_ref" --raw)"
    platform_digest="$(
      jq -r --arg fallback "$digest" '
        if has("manifests") then
          [.manifests[] | select(
            .platform.os == "linux" and .platform.architecture == "arm64"
          )][0].digest // empty
        else
          $fallback
        end
      ' <<<"$manifest_json"
    )"
    [[ "$platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
      oci_die "unable to resolve the linux/arm64 platform digest for $service"
    if ! jq -e 'has("manifests")' <<<"$manifest_json" >/dev/null; then
      single_platform="$(
        docker buildx imagetools inspect "$image_ref" \
          --format '{{.Image.OS}}/{{.Image.Architecture}}'
      )"
      [[ "$single_platform" == "linux/arm64" ]] ||
        oci_die "pushed image is not linux/arm64 for $service"
    fi
    if [[ "$tag_exists" == "1" ]]; then
      existing_digest="$(
        docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' |
          tr -d '"'
      )"
      [[ "$existing_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
        oci_die "existing GHCR exact tag lacks an immutable digest for $service"
      existing_manifest_json="$(
        docker buildx imagetools inspect "${repository}@${existing_digest}" --raw
      )"
      existing_platform_digest="$(
        jq -r --arg fallback "$existing_digest" '
          if has("manifests") then
            [.manifests[] | select(
              .platform.os == "linux" and .platform.architecture == "arm64"
            )][0].digest // empty
          else
            $fallback
          end
        ' <<<"$existing_manifest_json"
      )"
      [[ "$existing_platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
        oci_die "existing GHCR exact tag lacks a linux/arm64 platform digest for $service"
      if ! jq -e 'has("manifests")' <<<"$existing_manifest_json" >/dev/null; then
        existing_platform="$(
          docker buildx imagetools inspect "${repository}@${existing_digest}" \
            --format '{{.Image.OS}}/{{.Image.Architecture}}'
        )"
        [[ "$existing_platform" == "linux/arm64" ]] ||
          oci_die "existing GHCR exact tag is not linux/arm64 for $service"
      fi
      [[ "$existing_platform_digest" == "$platform_digest" ]] ||
        oci_die "existing GHCR exact tag differs from the rebuilt ARM64 platform for $service"
      digest="$existing_digest"
      platform_digest="$existing_platform_digest"
      image_ref="${repository}@${digest}"
    else
      docker buildx imagetools create --prefer-index=false \
        --tag "$tag" "$image_ref" >/dev/null
    fi
    published_digest="$(
      docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' |
        tr -d '"'
    )"
    [[ "$published_digest" == "$digest" ]] ||
      oci_die "GHCR exact tag does not bind the staged digest for $service"
  else
    digest="local-only"
    platform_digest="local-only"
    image_ref="$tag"
  fi
  {
    printf 'service=%q\n' "$service"
    printf 'schema=%q\n' "betstan.application-image-provenance.v1"
    printf 'registry_provider=%q\n' "$APPLICATION_REGISTRY_PROVIDER"
    printf 'registry_host=%q\n' "$APPLICATION_REGISTRY_HOST"
    printf 'registry_tag_prefix=%q\n' "$APPLICATION_REGISTRY_TAG_PREFIX"
    printf 'registry_tag_schema=%q\n' "$APPLICATION_REGISTRY_TAG_SCHEMA"
    printf 'repository=%q\n' "$repository"
    printf 'source_sha=%q\n' "$SOURCE_SHA"
    printf 'tag=%q\n' "$tag"
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
  } > "$provenance"
done

oci_log "application_image_build=PASS provider=ghcr services=${#services[@]} platform=$PLATFORM repair=${REPAIR_EXISTING_TAGS}"
