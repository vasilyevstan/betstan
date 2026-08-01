#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

PROVENANCE_DIR="${PROVENANCE_DIR:-${1:-}}"
SOURCE_SHA="${SOURCE_SHA:-${2:-}}"
OUTPUT_FILE="${OUTPUT_FILE:-$OCI_ROOT_DIR/artifacts/oci-images.tsv}"
VERIFY_REMOTE="${VERIFY_REMOTE:-1}"
BOOT_IMAGES="${BOOT_IMAGES:-0}"
EXPECTED_BUILD_RUN_ID="${EXPECTED_BUILD_RUN_ID:-}"
EXPECTED_BUILD_RUN_ATTEMPT="${EXPECTED_BUILD_RUN_ATTEMPT:-}"

[[ -d "$PROVENANCE_DIR" ]] || oci_die "provenance directory not found"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || oci_die "SOURCE_SHA must be a full lowercase commit SHA"
oci_require_command jq
if [[ "$VERIFY_REMOTE" == "1" || "$BOOT_IMAGES" == "1" ]]; then
  oci_require_command docker
fi

expected=(auth bet backoffice client event gamemaster moderation resulting slip)
seen_services=" "
rows=()

for file in "$PROVENANCE_DIR"/*.env; do
  [[ -f "$file" ]] || continue
  unset service repository source_sha tag digest platform_digest image_ref platform build_run_id build_run_attempt
  # shellcheck disable=SC1090
  source "$file"
  [[ " ${expected[*]} " == *" ${service:-} "* ]] || oci_die "unexpected service provenance"
  [[ "$seen_services" != *" $service "* ]] || oci_die "duplicate provenance for $service"
  seen_services+="$service "
  [[ "$source_sha" == "$SOURCE_SHA" ]] || oci_die "source SHA mismatch for $service"
  [[ "$platform" == "linux/arm64" ]] || oci_die "platform mismatch for $service"
  [[ "$tag" == "${repository}:oci-${service}-${SOURCE_SHA}" ]] ||
    oci_die "non-exact OCI tag for $service"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || oci_die "invalid digest for $service"
  [[ "$platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "invalid linux/arm64 platform digest for $service"
  [[ "$image_ref" == "${repository}@${digest}" ]] || oci_die "image reference mismatch for $service"
  [[ "$repository" != *docker.io/stanvasilyev* ]] || oci_die "OCI provenance points at Docker Hub"
  if [[ -n "${OCI_REGISTRY_HOST:-}" || -n "${OCI_REGISTRY_NAMESPACE:-}" || -n "${OCI_IMAGE_PREFIX:-}" ]]; then
    oci_require_vars OCI_REGISTRY_HOST OCI_REGISTRY_NAMESPACE OCI_IMAGE_PREFIX
    expected_repository="${OCI_REGISTRY_HOST}/${OCI_REGISTRY_NAMESPACE}/${OCI_IMAGE_PREFIX}_images"
    [[ "$repository" == "$expected_repository" ]] ||
      oci_die "image repository differs from the approved OCIR path for $service"
  fi
  if [[ -n "$EXPECTED_BUILD_RUN_ID" ]]; then
    [[ "$build_run_id" == "$EXPECTED_BUILD_RUN_ID" ]] ||
      oci_die "build run ID mismatch for $service"
  fi
  if [[ -n "$EXPECTED_BUILD_RUN_ATTEMPT" ]]; then
    [[ "$build_run_attempt" == "$EXPECTED_BUILD_RUN_ATTEMPT" ]] ||
      oci_die "build run attempt mismatch for $service"
  fi

  if [[ "$VERIFY_REMOTE" == "1" ]]; then
    tag_digest="$(
      docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' |
        tr -d '"'
    )"
    [[ "$tag_digest" == "$digest" ]] || oci_die "remote tag digest mismatch for $service"
    manifest_json="$(docker buildx imagetools inspect "$image_ref" --raw)"
    observed_platform_digest="$(
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
    [[ "$observed_platform_digest" == "$platform_digest" ]] ||
      oci_die "remote linux/arm64 platform digest mismatch for $service"
    if ! jq -e 'has("manifests")' <<<"$manifest_json" >/dev/null; then
      single_platform="$(
        docker buildx imagetools inspect "$image_ref" \
          --format '{{.Image.OS}}/{{.Image.Architecture}}'
      )"
      [[ "$single_platform" == "linux/arm64" ]] ||
        oci_die "remote image is not linux/arm64 for $service"
    fi
  fi
  rows+=("$service"$'\t'"$repository"$'\t'"$image_ref"$'\t'"$digest"$'\t'"$platform_digest")
done

for service in "${expected[@]}"; do
  [[ "$seen_services" == *" $service "* ]] || oci_die "missing provenance for $service"
done

mkdir -p "$(dirname "$OUTPUT_FILE")"
printf '%s\n' "${rows[@]}" | sort > "$OUTPUT_FILE"

if [[ "$BOOT_IMAGES" == "1" ]]; then
  work_id="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
  network="betstan-oci-verify-${work_id}"
  mongo="betstan-oci-mongo-${work_id}"
  rabbit="betstan-oci-rabbit-${work_id}"
  cleanup() {
    local name
    for name in "${started[@]:-}" "$rabbit" "$mongo"; do
      [[ -n "$name" ]] && docker rm -f "$name" >/dev/null 2>&1 || true
    done
    docker network rm "$network" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  started=()
  docker network create "$network" >/dev/null
  docker run -d --name "$mongo" --network "$network" \
    --network-alias mongo \
    docker.io/library/mongo@sha256:3d715950d83061ff2fbc910d12d3703212538cacf6b3003e3736fa5c7f51a2e1 >/dev/null
  docker run -d --name "$rabbit" --network "$network" \
    --network-alias rabbitmq \
    docker.io/library/rabbitmq@sha256:6033d0c2f4e9eb49dda9623067a96d317bc7b550513bd18532fbd3cd9a941c1b >/dev/null
  mongo_ready=0
  rabbit_ready=0
  for _ in $(seq 1 60); do
    if docker exec "$mongo" mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null |
        grep -qx 1; then
      mongo_ready=1
    fi
    if docker exec --user rabbitmq "$rabbit" rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
      rabbit_ready=1
    fi
    [[ "$mongo_ready" == "1" && "$rabbit_ready" == "1" ]] && break
    sleep 2
  done
  [[ "$mongo_ready" == "1" ]] ||
    oci_die "Mongo verification dependency did not become ready"
  [[ "$rabbit_ready" == "1" ]] ||
    oci_die "RabbitMQ verification dependency did not become ready"

  while IFS=$'\t' read -r service _repository image_ref _digest _platform_digest; do
    container="betstan-oci-${service}-${work_id}"
    started+=("$container")
    if [[ "$service" == "client" ]]; then
      docker run -d --platform linux/arm64 --name "$container" --network "$network" "$image_ref" >/dev/null
    else
      docker run -d --platform linux/arm64 --name "$container" --network "$network" \
        -e JWT_KEY=offline-verification-only \
        -e "MONGO_URI=mongodb://mongo:27017/gaming_${service}" \
        -e RABBITMQ_URI=amqp://rabbitmq \
        -e "CLIENT_ID=oci-verification-${service}" \
        "$image_ref" >/dev/null
    fi
    sleep 8
    [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == "true" ]] ||
      oci_die "ARM64 container exited during startup verification: $service"
    if [[ "$service" == "client" ]]; then
      docker exec "$container" wget -qO- http://127.0.0.1:3000/ |
        grep -qi '<html' ||
        oci_die "ARM64 client did not serve its static application"
    fi
    docker rm -f "$container" >/dev/null
    started=("${started[@]/$container}")
  done < "$OUTPUT_FILE"
fi

oci_log "oci_image_verification=PASS services=${#expected[@]} platform=linux/arm64"
