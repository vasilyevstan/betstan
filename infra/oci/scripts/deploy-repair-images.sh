#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="${MODE:-${1:-}}"
TARGET_IMAGES_FILE="${TARGET_IMAGES_FILE:-${2:-}}"
BASELINE_IMAGES_FILE="${BASELINE_IMAGES_FILE:-${3:-}}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-repair-deploy}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"

case "$MODE" in
  deploy|compensate|verify)
    ;;
  *)
    oci_die "MODE must be deploy, compensate, or verify"
    ;;
esac
[[ -f "$TARGET_IMAGES_FILE" && ! -L "$TARGET_IMAGES_FILE" ]] ||
  oci_die "TARGET_IMAGES_FILE must be a regular file"
[[ -f "$BASELINE_IMAGES_FILE" && ! -L "$BASELINE_IMAGES_FILE" ]] ||
  oci_die "BASELINE_IMAGES_FILE must be a regular file"
[[ "$OCI_K8S_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  oci_die "OCI_K8S_NAMESPACE is invalid"
oci_require_command jq
oci_require_command kubectl

services=(auth bet event moderation resulting slip backoffice client gamemaster)

load_images() {
  local file="$1"
  local label="$2"
  local service repository image_ref digest platform_digest
  local seen=" "
  local count=0
  while IFS=$'\t' read -r service repository image_ref digest platform_digest; do
    [[ -n "$service" ]] || continue
    [[ " ${services[*]} " == *" $service "* ]] ||
      oci_die "image evidence contains an unexpected service: $service"
    [[ "$seen" != *" $service "* ]] ||
      oci_die "$label image evidence duplicates $service"
    [[ "$repository" == "ghcr.io/vasilyevstan/betstan-images" ]] ||
      oci_die "image evidence uses an unexpected repository"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ &&
       "$platform_digest" =~ ^sha256:[0-9a-f]{64}$ &&
       "$image_ref" == "$repository@$digest" ]] ||
      oci_die "image evidence is not immutable for $service"
    seen="$seen$service "
    count=$((count + 1))
  done < "$file"
  [[ "$count" == "${#services[@]}" ]] ||
    oci_die "$label image evidence must contain exactly nine services"
  for service in "${services[@]}"; do
    [[ "$seen" == *" $service "* ]] ||
      oci_die "$label image evidence is missing $service"
  done
}

load_images "$TARGET_IMAGES_FILE" target
load_images "$BASELINE_IMAGES_FILE" baseline

image_from_file() {
  local file="$1"
  local service="$2"
  awk -F '\t' -v service="$service" '
    $1 == service { count++; image=$3 }
    END { if (count != 1) exit 1; print image }
  ' "$file"
}

oci_prepare_private_dir "$OUTPUT_DIR"
before="$OUTPUT_DIR/live-images-before.tsv"
after="$OUTPUT_DIR/live-images-after.tsv"
: > "$before"
: > "$after"

deployment_image() {
  local service="$1"
  local deployment="gaming-${service}-depl"
  local container="gaming-${service}"
  kubectl get deployment "$deployment" -n "$OCI_K8S_NAMESPACE" -o json |
    jq -er --arg container "$container" '
      [.spec.template.spec.containers[] | select(.name == $container) | .image] as $images |
      if ($images | length) == 1 then $images[0]
      else error("deployment container identity is ambiguous")
      end
    '
}

for service in "${services[@]}"; do
  current="$(deployment_image "$service")"
  printf '%s\t%s\n' "$service" "$current" >> "$before"
  case "$MODE" in
    deploy)
      [[ "$current" == "$(image_from_file "$BASELINE_IMAGES_FILE" "$service")" ]] ||
        oci_die "live image differs from the active-release baseline for $service"
      ;;
    compensate)
      [[ "$current" == "$(image_from_file "$BASELINE_IMAGES_FILE" "$service")" ||
         "$current" == "$(image_from_file "$TARGET_IMAGES_FILE" "$service")" ]] ||
        oci_die "live image has unknown provenance during compensation for $service"
      ;;
    verify)
      [[ "$current" == "$(image_from_file "$TARGET_IMAGES_FILE" "$service")" ]] ||
        oci_die "live image differs from the expected target for $service"
      ;;
  esac
done

if [[ "$MODE" != "verify" ]]; then
  for service in "${services[@]}"; do
    deployment="gaming-${service}-depl"
    container="gaming-${service}"
    desired="$(image_from_file "$TARGET_IMAGES_FILE" "$service")"
    kubectl set image "deployment/$deployment" \
      "$container=$desired" -n "$OCI_K8S_NAMESPACE"
    kubectl rollout status "deployment/$deployment" \
      -n "$OCI_K8S_NAMESPACE" --timeout=10m
    [[ "$(deployment_image "$service")" == "$desired" ]] ||
      oci_die "deployment did not retain the exact target image for $service"
  done
fi

for service in "${services[@]}"; do
  printf '%s\t%s\n' "$service" "$(deployment_image "$service")" >> "$after"
done

echo "oci_repair_images=PASS mode=$MODE services=${#services[@]}"
