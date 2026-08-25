#!/usr/bin/env bash
set -euo pipefail

# This is a migration-only cache rescue. It exports the exact containerd image
# selected by a live pod over the existing Bastion tunnel; GHCR credentials are
# intentionally never copied to the node.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=application-registry.sh
source "$SCRIPT_DIR/application-registry.sh"

LIVE_IMAGES_FILE="${LIVE_IMAGES_FILE:-}"
TRUSTED_LEGACY_IMAGES_FILE="${TRUSTED_LEGACY_IMAGES_FILE:-}"
LIVE_PLATFORM_IDS_FILE="${LIVE_PLATFORM_IDS_FILE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts/ghcr-cache-recovery}"
K3S_SSH_PRIVATE_KEY="${K3S_SSH_PRIVATE_KEY:-}"
K3S_SSH_KNOWN_HOSTS="${K3S_SSH_KNOWN_HOSTS:-}"
K3S_SSH_HOST_KEY_ALIAS="${K3S_SSH_HOST_KEY_ALIAS:-}"
K3S_SSH_PORT="${K3S_SSH_PORT:-}"
K3S_SSH_USER="${K3S_SSH_USER:-ubuntu}"
SOURCE_SHA="${SOURCE_SHA:-}"
TRUSTED_BUILD_RUN_ID="${TRUSTED_BUILD_RUN_ID:-}"
TRUSTED_UPSTREAM_RUN_ID="${TRUSTED_UPSTREAM_RUN_ID:-}"
RECOVERY_RUN_ID="${GITHUB_RUN_ID:-local}"
RECOVERY_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
RECOVERY_BOOT_IMAGES="${RECOVERY_BOOT_IMAGES:-1}"
GHCR_ACTOR="${GHCR_ACTOR:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"
ARCHIVE_PUSHER="$SCRIPT_DIR/push-oci-archive-to-ghcr.py"
SERVICES=(auth bet backoffice client event gamemaster moderation resulting slip)

oci_require_command docker
oci_require_command ssh
oci_require_command ssh-keygen
oci_require_command jq
oci_require_command python3
oci_require_command sha256sum
[[ -f "$ARCHIVE_PUSHER" && ! -L "$ARCHIVE_PUSHER" ]] ||
  oci_die "exact OCI archive publisher is missing or unsafe"
application_registry_require_ghcr
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "SOURCE_SHA must identify the historical trusted build"
[[ "$TRUSTED_BUILD_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "TRUSTED_BUILD_RUN_ID must be a first-attempt build run ID"
[[ "$TRUSTED_UPSTREAM_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "TRUSTED_UPSTREAM_RUN_ID must be the historical production-build run"
[[ "$RECOVERY_RUN_ID" =~ ^([1-9][0-9]*|local)$ &&
   "$RECOVERY_RUN_ATTEMPT" == "1" ]] ||
  oci_die "cache recovery accepts first-attempt evidence only"
[[ "$RECOVERY_BOOT_IMAGES" == "0" || "$RECOVERY_BOOT_IMAGES" == "1" ]] ||
  oci_die "RECOVERY_BOOT_IMAGES must be 0 or 1"
[[ -f "$LIVE_IMAGES_FILE" && ! -L "$LIVE_IMAGES_FILE" ]] ||
  oci_die "LIVE_IMAGES_FILE must be a regular file"
[[ -f "$TRUSTED_LEGACY_IMAGES_FILE" && ! -L "$TRUSTED_LEGACY_IMAGES_FILE" ]] ||
  oci_die "TRUSTED_LEGACY_IMAGES_FILE must be a regular file"
[[ -f "$LIVE_PLATFORM_IDS_FILE" && ! -L "$LIVE_PLATFORM_IDS_FILE" ]] ||
  oci_die "LIVE_PLATFORM_IDS_FILE must be a regular file"
[[ -f "$K3S_SSH_PRIVATE_KEY" && ! -L "$K3S_SSH_PRIVATE_KEY" &&
   -f "$K3S_SSH_KNOWN_HOSTS" && ! -L "$K3S_SSH_KNOWN_HOSTS" &&
   "$K3S_SSH_KNOWN_HOSTS" != "$K3S_SSH_PRIVATE_KEY" &&
   "$K3S_SSH_HOST_KEY_ALIAS" =~ ^ocid1\.instance\.[a-z0-9.-]+$ &&
   "$K3S_SSH_PORT" =~ ^[1-9][0-9]{3,4}$ &&
   "$K3S_SSH_USER" == "ubuntu" ]] ||
  oci_die "cache recovery requires the exact Bastion target key, known-hosts file, and instance OCID alias"
ssh-keygen -F "$K3S_SSH_HOST_KEY_ALIAS" -f "$K3S_SSH_KNOWN_HOSTS" >/dev/null ||
  oci_die "cache recovery known-hosts file does not bind the exact instance OCID alias"

python3 - "$OCI_ROOT_DIR" "$OUTPUT_DIR" \
  "$LIVE_IMAGES_FILE" "$TRUSTED_LEGACY_IMAGES_FILE" "$LIVE_PLATFORM_IDS_FILE" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()

def resolve(value):
    path = Path(value)
    return (path if path.is_absolute() else root / path).resolve()

output = resolve(sys.argv[2])
sources = [resolve(value) for value in sys.argv[3:]]
if sources[0] == sources[1]:
    raise SystemExit("live and trusted cache evidence must be independent files")
for source in sources:
    if source == output or output in source.parents:
        raise SystemExit("cache recovery inputs must be outside the cleared output directory")
PY

oci_prepare_safe_private_dir "$OUTPUT_DIR"
for service in "${SERVICES[@]}"; do
  live_row="$(awk -F '\t' -v service="$service" '$1 == service { count++; line=$0 } END { if (count == 1) print line; else exit 1 }' "$LIVE_IMAGES_FILE")" ||
    oci_die "live cache recovery input is missing or duplicates $service"
  trusted_row="$(awk -F '\t' -v service="$service" '$1 == service { count++; line=$0 } END { if (count == 1) print line; else exit 1 }' "$TRUSTED_LEGACY_IMAGES_FILE")" ||
    oci_die "trusted historical provenance is missing or duplicates $service"
  IFS=$'\t' read -r _ live_repository live_ref live_digest live_platform_digest <<<"$live_row"
  IFS=$'\t' read -r _ trusted_repository trusted_ref trusted_digest trusted_platform_digest <<<"$trusted_row"
  [[ "$trusted_repository" =~ ^[a-z0-9.-]+\.ocir\.io/[a-z0-9._/-]+$ &&
     "$trusted_ref" == "${trusted_repository}@${trusted_digest}" &&
     "$trusted_digest" =~ ^sha256:[0-9a-f]{64}$ &&
     "$trusted_platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "trusted recovery provenance must identify an exact legacy OCIR image"
  [[ "$live_ref" == "${live_repository}@${live_digest}" &&
     "$live_digest" =~ ^sha256:[0-9a-f]{64}$ &&
     "$live_platform_digest" == "$trusted_platform_digest" ]] ||
    oci_die "live cache evidence is malformed or serves a different platform image"
  if [[ "$live_repository" == "$trusted_repository" ]]; then
    [[ "$live_row" == "$trusted_row" ]] ||
      oci_die "live OCIR image differs from the prior trusted deployment/build provenance"
  else
    [[ "$live_repository" == "$(application_registry_repository)" ]] ||
      oci_die "live deployment is neither the trusted OCIR image nor the target GHCR repository"
  fi
  awk -F '\t' -v service="$service" -v platform="$live_platform_digest" '
    $1 == service { count++; if ($2 !~ ("@" platform "$")) invalid=1 }
    END { exit(count >= 1 && !invalid ? 0 : 1) }
  ' "$LIVE_PLATFORM_IDS_FILE" ||
    oci_die "live pod image ID does not prove the trusted linux/arm64 platform digest"
done

[[ "$GHCR_ACTOR" =~ ^[A-Za-z0-9-]+$ && -n "$GHCR_TOKEN" ]] ||
  oci_die "GHCR_ACTOR and GHCR_TOKEN are required for exact archive publication"

ssh_options=(
  -i "$K3S_SSH_PRIVATE_KEY"
  -p "$K3S_SSH_PORT"
  -o BatchMode=yes
  -o CheckHostIP=no
  -o ConnectTimeout=15
  -o IdentitiesOnly=yes
  -o PasswordAuthentication=no
  -o PreferredAuthentications=publickey
  -o UserKnownHostsFile="$K3S_SSH_KNOWN_HOSTS"
  -o HostKeyAlias="$K3S_SSH_HOST_KEY_ALIAS"
  -o StrictHostKeyChecking=yes
)

published_count=0
adopted_count=0
archive_dir="$(mktemp -d)"
anonymous_docker_config="$(mktemp -d)"
chmod 700 "$archive_dir" "$anonymous_docker_config"
cleanup() { rm -rf "$archive_dir" "$anonymous_docker_config"; }
trap cleanup EXIT
export DOCKER_CONFIG="$anonymous_docker_config"
for service in "${SERVICES[@]}"; do
  live_row="$(awk -F '\t' -v service="$service" '$1 == service { print; exit }' "$LIVE_IMAGES_FILE")"
  trusted_row="$(awk -F '\t' -v service="$service" '$1 == service { print; exit }' "$TRUSTED_LEGACY_IMAGES_FILE")"
  IFS=$'\t' read -r _ live_repository live_ref _live_digest _live_platform_digest <<<"$live_row"
  IFS=$'\t' read -r _ old_repository old_ref old_digest old_platform_digest <<<"$trusted_row"
  new_repository="$(application_registry_repository)"
  new_tag="${new_repository}:$(application_registry_tag "$service" "$SOURCE_SHA")"
  inspect_error="$OUTPUT_DIR/.${service}-tag-inspect.log"
  if docker buildx imagetools inspect "$new_tag" >"$inspect_error" 2>&1; then
    adopted_count=$((adopted_count + 1))
  else
    if ! grep -Eiq '404|manifest unknown|name unknown|not found' "$inspect_error"; then
      oci_die "unable to determine whether the recovered GHCR exact tag exists: $service"
    fi
    printf -v remote_ref '%q' "$old_ref"
    archive="$archive_dir/${service}.tar"
    ssh "${ssh_options[@]}" "${K3S_SSH_USER}@127.0.0.1" \
      "sudo k3s ctr -n k8s.io images export - -- $remote_ref" > "$archive"
    [[ -s "$archive" && ! -L "$archive" ]] ||
      oci_die "containerd cache export did not produce a regular OCI archive"
    OCI_ARCHIVE_FILE="$archive" \
      GHCR_TARGET_TAG="$(application_registry_tag "$service" "$SOURCE_SHA")" \
      EXPECTED_PLATFORM_DIGEST="$old_platform_digest" \
      GHCR_ACTOR="$GHCR_ACTOR" \
      GHCR_TOKEN="$GHCR_TOKEN" \
      python3 "$ARCHIVE_PUSHER"
    rm -f -- "$archive"
    published_count=$((published_count + 1))
  fi
  rm -f -- "$inspect_error"
  new_digest="$(docker buildx imagetools inspect "$new_tag" --format '{{.Manifest.Digest}}' | tr -d '"')"
  [[ "$new_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "GHCR cache recovery did not return an immutable manifest digest"
  if [[ "$live_repository" == "$new_repository" ]]; then
    [[ "$live_ref" == "${new_repository}@${new_digest}" ]] ||
      oci_die "live GHCR deployment does not match the recovered exact tag"
  fi
  manifest_json="$(docker buildx imagetools inspect "${new_repository}@${new_digest}" --raw)"
  new_platform_digest="$(
    jq -r --arg fallback "$new_digest" '
      if has("manifests") then
        [.manifests[] | select(.platform.os == "linux" and .platform.architecture == "arm64")][0].digest // empty
      else
        $fallback
      end
    ' <<<"$manifest_json"
  )"
  [[ "$new_platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "GHCR recovered image lacks a linux/arm64 platform digest"
  [[ "$new_platform_digest" == "$old_platform_digest" ]] ||
    oci_die "GHCR promotion changed the live trusted linux/arm64 platform digest"
  {
    printf 'schema=%s\n' 'betstan.application-image-provenance.v1'
    printf 'registry_provider=ghcr\nregistry_host=ghcr.io\n'
    printf 'registry_tag_prefix=arm64\nregistry_tag_schema=v1\n'
    printf 'service=%s\nrepository=%s\nsource_sha=%s\n' "$service" "$new_repository" "$SOURCE_SHA"
    printf 'tag=%s\ndigest=%s\nplatform_digest=%s\nimage_ref=%s@%s\n' \
      "$new_tag" "$new_digest" "$new_platform_digest" "$new_repository" "$new_digest"
    printf 'platform=linux/arm64\nbuild_workflow=oci-production-build\n'
    printf 'build_run_id=%s\nbuild_run_attempt=1\n' "$TRUSTED_BUILD_RUN_ID"
    printf 'upstream_workflow=production-build\nupstream_run_id=%s\nupstream_run_attempt=1\n' "$TRUSTED_UPSTREAM_RUN_ID"
    printf 'recovery_workflow=oci-ghcr-cache-recovery\n'
    printf 'recovery_run_id=%s\nrecovery_run_attempt=1\n' "$RECOVERY_RUN_ID"
    printf 'recovery_origin=containerd-cache\nrecovery_origin_repository=%s\n' "$old_repository"
    printf 'recovery_origin_manifest_digest=%s\nrecovery_origin_platform_digest=%s\n' \
      "$old_digest" "$old_platform_digest"
  } > "$OUTPUT_DIR/${service}.env"
done

PROVENANCE_DIR="$OUTPUT_DIR" SOURCE_SHA="$SOURCE_SHA" \
EXPECTED_BUILD_RUN_ID="$TRUSTED_BUILD_RUN_ID" EXPECTED_BUILD_RUN_ATTEMPT=1 \
EXPECTED_UPSTREAM_RUN_ID="$TRUSTED_UPSTREAM_RUN_ID" \
PROVENANCE_MODE=recovery EXPECTED_RECOVERY_RUN_ID="$RECOVERY_RUN_ID" \
EXPECTED_RECOVERY_RUN_ATTEMPT=1 OUTPUT_FILE="$OUTPUT_DIR/images.tsv" \
VERIFY_REMOTE=1 BOOT_IMAGES="$RECOVERY_BOOT_IMAGES" ANONYMOUS_PULL=1 \
  "$SCRIPT_DIR/verify-images.sh"
images_sha256="$(oci_sha256 < "$OUTPUT_DIR/images.tsv")"
printf '%s\n' \
  'schema=betstan.ghcr-cache-recovery.v1' \
  'recovery_origin=containerd-cache' \
  'registry_provider=ghcr' \
  'registry_repository=ghcr.io/vasilyevstan/betstan-images' \
  'anonymous_pull=pass' \
  "source_sha=$SOURCE_SHA" \
  "trusted_build_run_id=$TRUSTED_BUILD_RUN_ID" \
  "trusted_upstream_run_id=$TRUSTED_UPSTREAM_RUN_ID" \
  "recovery_run_id=$RECOVERY_RUN_ID" \
  'recovery_run_attempt=1' \
  "images_sha256=$images_sha256" \
  > "$OUTPUT_DIR/recovery-evidence.env"
oci_log "ghcr_cache_recovery=PASS services=9 published=${published_count} adopted=${adopted_count} provenance_bound=true"
