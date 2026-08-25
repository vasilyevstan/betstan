#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=application-registry.sh
source "$SCRIPT_DIR/application-registry.sh"

PROVENANCE_DIR="${PROVENANCE_DIR:-${1:-}}"
SOURCE_SHA="${SOURCE_SHA:-${2:-}}"
OUTPUT_FILE="${OUTPUT_FILE:-$OCI_ROOT_DIR/artifacts/oci-images.tsv}"
VERIFY_REMOTE="${VERIFY_REMOTE:-1}"
BOOT_IMAGES="${BOOT_IMAGES:-0}"
EXPECTED_BUILD_RUN_ID="${EXPECTED_BUILD_RUN_ID:-}"
EXPECTED_BUILD_RUN_ATTEMPT="${EXPECTED_BUILD_RUN_ATTEMPT:-}"
EXPECTED_UPSTREAM_RUN_ID="${EXPECTED_UPSTREAM_RUN_ID:-}"
PROVENANCE_MODE="${PROVENANCE_MODE:-build}"
EXPECTED_RECOVERY_RUN_ID="${EXPECTED_RECOVERY_RUN_ID:-}"
EXPECTED_RECOVERY_RUN_ATTEMPT="${EXPECTED_RECOVERY_RUN_ATTEMPT:-}"
ANONYMOUS_PULL="${ANONYMOUS_PULL:-0}"

[[ -d "$PROVENANCE_DIR" ]] || oci_die "provenance directory not found"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || oci_die "SOURCE_SHA must be a full lowercase commit SHA"
oci_require_command jq
if [[ "$VERIFY_REMOTE" == "1" || "$BOOT_IMAGES" == "1" ]]; then
  oci_require_command docker
fi
[[ "$ANONYMOUS_PULL" == "0" || "$ANONYMOUS_PULL" == "1" ]] ||
  oci_die "ANONYMOUS_PULL must be 0 or 1"
[[ "$PROVENANCE_MODE" == "build" || "$PROVENANCE_MODE" == "recovery" ]] ||
  oci_die "PROVENANCE_MODE must be build or recovery"
if [[ "$PROVENANCE_MODE" == "recovery" ]]; then
  [[ "$EXPECTED_RECOVERY_RUN_ID" =~ ^([1-9][0-9]*|local)$ &&
     "$EXPECTED_RECOVERY_RUN_ATTEMPT" == "1" ]] ||
    oci_die "recovery provenance requires an explicit first-attempt recovery run"
else
  [[ -z "$EXPECTED_RECOVERY_RUN_ID" && -z "$EXPECTED_RECOVERY_RUN_ATTEMPT" ]] ||
    oci_die "normal build provenance cannot carry recovery expectations"
fi
if [[ "$ANONYMOUS_PULL" == "1" ]]; then
  [[ "$VERIFY_REMOTE" == "1" ]] ||
    oci_die "anonymous pull verification requires remote digest verification"
  anonymous_docker_config="${ANONYMOUS_DOCKER_CONFIG:-$PROVENANCE_DIR/.anonymous-docker-config}"
  [[ ! -e "$anonymous_docker_config" ]] ||
    oci_die "anonymous Docker configuration path already exists"
  mkdir -p "$anonymous_docker_config"
  chmod 700 "$anonymous_docker_config"
  export DOCKER_CONFIG="$anonymous_docker_config"
  trap cleanup_anonymous_docker_config EXIT
fi

cleanup_anonymous_docker_config() {
  if [[ -n "${anonymous_docker_config:-}" ]]; then
    rm -rf -- "$anonymous_docker_config"
  fi
}

expected=(auth bet backoffice client event gamemaster moderation resulting slip)
seen_services=" "
rows=()
application_registry_require_ghcr

provenance_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '
    $1 == key {
      if (found++) exit 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (found != 1) exit 1
      print value
    }
  ' "$file"
}

validate_provenance_shape() {
  local file="$1"
  awk -F= '
    /^[A-Za-z_][A-Za-z0-9_]*=[^[:cntrl:]]*$/ {
      if (seen[$1]++) exit 1
      next
    }
    { exit 1 }
  ' "$file"
}

for expected_service in "${expected[@]}"; do
  file="$PROVENANCE_DIR/${expected_service}.env"
  [[ -f "$file" && ! -L "$file" ]] ||
    oci_die "missing regular application image provenance for $expected_service"
  validate_provenance_shape "$file" ||
    oci_die "malformed application image provenance"
  if [[ "$PROVENANCE_MODE" == "build" ]]; then
    ! grep -Eq '^recovery_(workflow|run_id|run_attempt|origin|origin_repository|origin_manifest_digest|origin_platform_digest)=' "$file" ||
      oci_die "normal build provenance cannot be satisfied by recovery metadata"
  fi
  schema="$(provenance_value "$file" schema)" ||
    oci_die "application image provenance is missing schema"
  registry_provider="$(provenance_value "$file" registry_provider)" ||
    oci_die "application image provenance is missing provider"
  registry_host="$(provenance_value "$file" registry_host)" ||
    oci_die "application image provenance is missing host"
  registry_tag_prefix="$(provenance_value "$file" registry_tag_prefix)" ||
    oci_die "application image provenance is missing tag prefix"
  registry_tag_schema="$(provenance_value "$file" registry_tag_schema)" ||
    oci_die "application image provenance is missing tag schema"
  service="$(provenance_value "$file" service)" ||
    oci_die "application image provenance is missing service"
  repository="$(provenance_value "$file" repository)" ||
    oci_die "application image provenance is missing repository"
  source_sha="$(provenance_value "$file" source_sha)" ||
    oci_die "application image provenance is missing source SHA"
  tag="$(provenance_value "$file" tag)" ||
    oci_die "application image provenance is missing tag"
  digest="$(provenance_value "$file" digest)" ||
    oci_die "application image provenance is missing digest"
  platform_digest="$(provenance_value "$file" platform_digest)" ||
    oci_die "application image provenance is missing platform digest"
  image_ref="$(provenance_value "$file" image_ref)" ||
    oci_die "application image provenance is missing image reference"
  platform="$(provenance_value "$file" platform)" ||
    oci_die "application image provenance is missing platform"
  build_run_id="$(provenance_value "$file" build_run_id)" ||
    oci_die "application image provenance is missing build run"
  build_run_attempt="$(provenance_value "$file" build_run_attempt)" ||
    oci_die "application image provenance is missing build attempt"
  build_workflow="$(provenance_value "$file" build_workflow)" ||
    oci_die "application image provenance is missing workflow identity"
  upstream_workflow="$(provenance_value "$file" upstream_workflow)" ||
    oci_die "application image provenance is missing upstream workflow"
  upstream_run_id="$(provenance_value "$file" upstream_run_id)" ||
    oci_die "application image provenance is missing upstream run"
  upstream_run_attempt="$(provenance_value "$file" upstream_run_attempt)" ||
    oci_die "application image provenance is missing upstream attempt"
  if [[ "$PROVENANCE_MODE" == "recovery" ]]; then
    recovery_workflow="$(provenance_value "$file" recovery_workflow)" ||
      oci_die "recovery provenance is missing recovery workflow"
    recovery_run_id="$(provenance_value "$file" recovery_run_id)" ||
      oci_die "recovery provenance is missing recovery run ID"
    recovery_run_attempt="$(provenance_value "$file" recovery_run_attempt)" ||
      oci_die "recovery provenance is missing recovery attempt"
    recovery_origin="$(provenance_value "$file" recovery_origin)" ||
      oci_die "recovery provenance is missing origin"
    recovery_origin_repository="$(provenance_value "$file" recovery_origin_repository)" ||
      oci_die "recovery provenance is missing origin repository"
    recovery_origin_manifest_digest="$(provenance_value "$file" recovery_origin_manifest_digest)" ||
      oci_die "recovery provenance is missing origin manifest digest"
    recovery_origin_platform_digest="$(provenance_value "$file" recovery_origin_platform_digest)" ||
      oci_die "recovery provenance is missing origin platform digest"
  fi
  [[ " ${expected[*]} " == *" $service "* ]] || oci_die "unexpected service provenance"
  [[ "$seen_services" != *" $service "* ]] || oci_die "duplicate provenance for $service"
  seen_services+="$service "
  [[ "$schema" == "betstan.application-image-provenance.v1" ]] ||
    oci_die "image provenance schema is not current"
  [[ "$registry_provider" == "$APPLICATION_REGISTRY_PROVIDER" &&
     "$registry_host" == "$APPLICATION_REGISTRY_HOST" &&
     "$registry_tag_prefix" == "$APPLICATION_REGISTRY_TAG_PREFIX" &&
     "$registry_tag_schema" == "$APPLICATION_REGISTRY_TAG_SCHEMA" ]] ||
    oci_die "image provenance registry identity is mixed or incomplete"
  [[ "$source_sha" == "$SOURCE_SHA" ]] || oci_die "source SHA mismatch for $service"
  [[ "$platform" == "linux/arm64" ]] || oci_die "platform mismatch for $service"
  application_registry_validate_repository "$repository"
  application_registry_validate_tag "$service" "$SOURCE_SHA" "$tag"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || oci_die "invalid digest for $service"
  [[ "$platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    oci_die "invalid linux/arm64 platform digest for $service"
  [[ "$image_ref" == "${repository}@${digest}" ]] || oci_die "image reference mismatch for $service"
  [[ "$build_workflow" == "oci-production-build" &&
     "$build_run_attempt" == "1" &&
     "$upstream_workflow" == "production-build" &&
     "$upstream_run_attempt" == "1" ]] ||
    oci_die "image provenance has untrusted build lineage"
  [[ "$upstream_run_id" =~ ^([1-9][0-9]*|local)$ ]] ||
    oci_die "image provenance upstream run is invalid"
  if [[ -n "$EXPECTED_BUILD_RUN_ID" ]]; then
    [[ "$build_run_id" == "$EXPECTED_BUILD_RUN_ID" ]] ||
      oci_die "build run ID mismatch for $service"
  fi
  if [[ -n "$EXPECTED_BUILD_RUN_ATTEMPT" ]]; then
    [[ "$build_run_attempt" == "$EXPECTED_BUILD_RUN_ATTEMPT" ]] ||
      oci_die "build run attempt mismatch for $service"
  fi
  if [[ -n "$EXPECTED_UPSTREAM_RUN_ID" ]]; then
    [[ "$upstream_run_id" == "$EXPECTED_UPSTREAM_RUN_ID" ]] ||
      oci_die "upstream production-build run mismatch for $service"
  fi
  if [[ "$PROVENANCE_MODE" == "recovery" ]]; then
    [[ "$recovery_workflow" == "oci-ghcr-cache-recovery" &&
       "$recovery_run_id" == "$EXPECTED_RECOVERY_RUN_ID" &&
       "$recovery_run_attempt" == "$EXPECTED_RECOVERY_RUN_ATTEMPT" &&
       "$recovery_origin" == "containerd-cache" &&
       "$recovery_origin_repository" =~ ^[a-z0-9.-]+\.ocir\.io/[a-z0-9._/-]+$ &&
       "$recovery_origin_manifest_digest" =~ ^sha256:[0-9a-f]{64}$ &&
       "$recovery_origin_platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
      oci_die "recovery provenance does not match the exact trusted recovery"
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
    cleanup_anonymous_docker_config
  }
  trap cleanup EXIT
  started=()
  docker network create "$network" >/dev/null
  docker run -d --name "$mongo" --network "$network" \
    --network-alias mongo \
    docker.io/library/mongo@sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3 >/dev/null
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
  mongo_runtime="$(
    docker exec "$mongo" mongosh --quiet --eval '
      const result=db.adminCommand({getParameter:1,featureCompatibilityVersion:1});
      print(db.version()+"|"+result.featureCompatibilityVersion.version);
    '
  )"
  [[ "$mongo_runtime" == "8.2.12|8.2" ]] ||
    oci_die "Mongo verification dependency differs from exact version 8.2.12 and FCV 8.2"

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
        -e AUTH_SERVICE_URL=http://auth:3000 \
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

cleanup_anonymous_docker_config
oci_log "application_image_verification=PASS provider=ghcr services=${#expected[@]} platform=linux/arm64 anonymous_pull=$ANONYMOUS_PULL provenance_mode=$PROVENANCE_MODE"
