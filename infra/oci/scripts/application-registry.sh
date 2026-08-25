#!/usr/bin/env bash
# shellcheck shell=bash

# Shared application-registry identity. OCI remains the runtime provider; this
# contract deliberately keeps the application image authority independent.

APPLICATION_REGISTRY_PROVIDER="${APPLICATION_REGISTRY_PROVIDER:-ghcr}"
APPLICATION_REGISTRY_HOST="${APPLICATION_REGISTRY_HOST:-ghcr.io}"
APPLICATION_REGISTRY_REPOSITORY="${APPLICATION_REGISTRY_REPOSITORY:-vasilyevstan/betstan-images}"
APPLICATION_REGISTRY_TAG_PREFIX="${APPLICATION_REGISTRY_TAG_PREFIX:-arm64}"
APPLICATION_REGISTRY_TAG_SCHEMA="${APPLICATION_REGISTRY_TAG_SCHEMA:-v1}"

application_registry_repository() {
  printf '%s/%s' "$APPLICATION_REGISTRY_HOST" "$APPLICATION_REGISTRY_REPOSITORY"
}

application_registry_require_ghcr() {
  [[ "$APPLICATION_REGISTRY_PROVIDER" == "ghcr" ]] ||
    oci_die "application registry provider must be ghcr"
  [[ "$APPLICATION_REGISTRY_HOST" == "ghcr.io" ]] ||
    oci_die "application registry host must be ghcr.io"
  [[ "$APPLICATION_REGISTRY_REPOSITORY" == "vasilyevstan/betstan-images" ]] ||
    oci_die "application registry repository must be vasilyevstan/betstan-images"
  [[ "$APPLICATION_REGISTRY_TAG_PREFIX" == "arm64" ]] ||
    oci_die "application registry tag prefix must be arm64"
  [[ "$APPLICATION_REGISTRY_TAG_SCHEMA" == "v1" ]] ||
    oci_die "application registry tag schema must be v1"
}

application_registry_tag() {
  local service="$1"
  local source_sha="$2"
  [[ "$service" =~ ^(auth|bet|backoffice|client|event|gamemaster|moderation|resulting|slip)$ ]] ||
    oci_die "unknown application service: $service"
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] ||
    oci_die "application image source SHA must be a full lowercase SHA"
  printf '%s-%s-%s' "$APPLICATION_REGISTRY_TAG_PREFIX" "$service" "$source_sha"
}

application_registry_validate_repository() {
  local repository="$1"
  application_registry_require_ghcr
  [[ "$repository" == "$(application_registry_repository)" ]] ||
    oci_die "application image repository is not the approved public GHCR package"
  [[ "$repository" != docker.io/* && "$repository" != index.docker.io/* ]] ||
    oci_die "Docker Hub is not an application image authority"
}

application_registry_validate_tag() {
  local service="$1"
  local source_sha="$2"
  local tag="$3"
  local repository
  repository="$(application_registry_repository)"
  [[ "$tag" == "${repository}:$(application_registry_tag "$service" "$source_sha")" ]] ||
    oci_die "application image tag is not an exact GHCR ARM64 source tag"
}
