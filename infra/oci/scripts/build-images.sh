#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SOURCE_SHA="${SOURCE_SHA:-${1:-}}"
PUSH_IMAGES="${PUSH_IMAGES:-1}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-build}"
PLATFORM="${PLATFORM:-linux/arm64}"

oci_require_command docker
oci_require_command jq
oci_require_vars OCI_REGISTRY_HOST OCI_REGISTRY_NAMESPACE OCI_IMAGE_PREFIX
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || oci_die "SOURCE_SHA must be a full lowercase commit SHA"
[[ "$PLATFORM" == "linux/arm64" ]] || oci_die "OCI images must target linux/arm64"
[[ "$OCI_REGISTRY_HOST" != *"://"* ]] || oci_die "OCI_REGISTRY_HOST must not contain a URL scheme"
[[ "$OCI_IMAGE_PREFIX" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] ||
  oci_die "OCI_IMAGE_PREFIX contains unsupported repository characters"

if [[ "$PUSH_IMAGES" == "1" ]]; then
  oci_require_vars OCI_REGISTRY_USERNAME OCI_REGISTRY_AUTH_TOKEN
  printf '%s' "$OCI_REGISTRY_AUTH_TOKEN" |
    docker login "$OCI_REGISTRY_HOST" --username "$OCI_REGISTRY_USERNAME" --password-stdin >/dev/null
  trap 'docker logout "$OCI_REGISTRY_HOST" >/dev/null 2>&1 || true' EXIT
fi

oci_prepare_private_dir "$OUTPUT_DIR"
services=(auth bet backoffice client event gamemaster moderation resulting slip)

for service in "${services[@]}"; do
  repository="${OCI_REGISTRY_HOST}/${OCI_REGISTRY_NAMESPACE}/${OCI_IMAGE_PREFIX}_${service}"
  tag="${repository}:oci-${SOURCE_SHA}"
  metadata="$OUTPUT_DIR/${service}.metadata.json"
  provenance="$OUTPUT_DIR/${service}.env"
  if [[ "$PUSH_IMAGES" == "1" ]]; then
    inspect_error="$OUTPUT_DIR/${service}.tag-inspect.log"
    if docker buildx imagetools inspect "$tag" >"$inspect_error" 2>&1; then
      oci_die "exact OCI tag already exists; refusing overwrite for $service"
    fi
    if ! grep -Eiq '404|manifest unknown|name unknown|not found' "$inspect_error"; then
      oci_die "unable to prove the exact OCI tag is absent for $service"
    fi
    rm -f "$inspect_error"
  fi
  build_args=(
    buildx build
    --platform "$PLATFORM"
    --provenance=false
    --sbom=false
    --metadata-file "$metadata"
    --tag "$tag"
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
    build_args+=(--push)
  else
    build_args+=(--load)
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
  else
    digest="local-only"
    platform_digest="local-only"
    image_ref="$tag"
  fi
  {
    printf 'service=%q\n' "$service"
    printf 'repository=%q\n' "$repository"
    printf 'source_sha=%q\n' "$SOURCE_SHA"
    printf 'tag=%q\n' "$tag"
    printf 'digest=%q\n' "$digest"
    printf 'platform_digest=%q\n' "$platform_digest"
    printf 'image_ref=%q\n' "$image_ref"
    printf 'platform=%q\n' "$PLATFORM"
    printf 'build_run_id=%q\n' "${GITHUB_RUN_ID:-local}"
    printf 'build_run_attempt=%q\n' "${GITHUB_RUN_ATTEMPT:-1}"
  } > "$provenance"
done

oci_log "oci_image_build=PASS services=${#services[@]} platform=$PLATFORM"
