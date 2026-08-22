#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

TARGET_IMAGES_FILE="${TARGET_IMAGES_FILE:-}"
PROTECTED_IMAGES_FILE="${PROTECTED_IMAGES_FILE:-}"
TARGET_SOURCE_SHA="${TARGET_SOURCE_SHA:-}"
CURRENT_SOURCE_SHA="${CURRENT_SOURCE_SHA:-}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts/oci-registry-prune}"
PRUNE_POLL_ATTEMPTS="${PRUNE_POLL_ATTEMPTS:-60}"
PRUNE_POLL_SECONDS="${PRUNE_POLL_SECONDS:-10}"
EXPECTED_SERVICES='auth backoffice bet client event gamemaster moderation resulting slip'
EXPECTED_TARGET_IMAGES=9
EXPECTED_PROTECTED_IMAGES=27
EXPECTED_IMAGES_BEFORE=36

oci_require_cli_version
oci_require_command jq
oci_require_vars \
  OCI_COMPARTMENT_OCID OCI_IMAGE_PREFIX OCI_REGISTRY_HOST \
  OCI_REGISTRY_NAMESPACE OCI_REGISTRY_MAX_BYTES
oci_require_ocid OCI_COMPARTMENT_OCID

[[ "$TARGET_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "TARGET_SOURCE_SHA must be a full commit SHA"
[[ "$CURRENT_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "CURRENT_SOURCE_SHA must be a full commit SHA"
[[ "$TARGET_SOURCE_SHA" != "$CURRENT_SOURCE_SHA" ]] ||
  oci_die "current master cannot be pruned"
[[ "$PRUNE_POLL_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "PRUNE_POLL_ATTEMPTS must be a positive integer"
[[ "$PRUNE_POLL_SECONDS" =~ ^[0-9]+$ ]] ||
  oci_die "PRUNE_POLL_SECONDS must be a nonnegative integer"
[[ "$OCI_REGISTRY_MAX_BYTES" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "OCI_REGISTRY_MAX_BYTES must be a positive integer"
[[ -f "$TARGET_IMAGES_FILE" ]] ||
  oci_die "TARGET_IMAGES_FILE does not exist"
[[ -f "$PROTECTED_IMAGES_FILE" ]] ||
  oci_die "PROTECTED_IMAGES_FILE does not exist"

mkdir -p "$OUTPUT_DIR"
work_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

repository="${OCI_IMAGE_PREFIX}_images"
provenance_repository="$OCI_REGISTRY_HOST/$OCI_REGISTRY_NAMESPACE/$repository"

normalize_provenance() {
  local source_file="$1"
  local destination_file="$2"
  local expected_rows="$3"
  local expected_per_service="$4"

  awk -F '\t' \
    -v repository="$provenance_repository" \
    -v expected_rows="$expected_rows" \
    -v expected_per_service="$expected_per_service" \
    -v expected_services="$EXPECTED_SERVICES" '
      BEGIN {
        split(expected_services, services, " ")
        for (service_index in services) {
          allowed[services[service_index]] = 1
        }
      }
      function valid_digest(value) {
        return length(value) == 71 &&
          substr(value, 1, 7) == "sha256:" &&
          substr(value, 8) ~ /^[0-9a-f]+$/
      }
      NF != 5 {
        print "invalid image provenance column count" > "/dev/stderr"
        exit 1
      }
      !($1 in allowed) {
        print "unexpected image provenance service: " $1 > "/dev/stderr"
        exit 1
      }
      $2 != repository {
        print "unexpected image provenance repository" > "/dev/stderr"
        exit 1
      }
      $3 != $2 "@" $4 || $4 != $5 || !valid_digest($4) {
        print "invalid image provenance digest identity" > "/dev/stderr"
        exit 1
      }
      {
        rows++
        service_count[$1]++
        digest_count[$4]++
        print $1 "\t" $4
      }
      END {
        if (rows != expected_rows) {
          print "unexpected image provenance row count" > "/dev/stderr"
          exit 1
        }
        for (service in allowed) {
          if (service_count[service] != expected_per_service) {
            print "incomplete image provenance service set" > "/dev/stderr"
            exit 1
          }
        }
        for (digest in digest_count) {
          if (digest_count[digest] != 1) {
            print "duplicate image provenance digest" > "/dev/stderr"
            exit 1
          }
        }
      }
    ' "$source_file" | LC_ALL=C sort -t $'\t' -k1,1 -k2,2 \
      > "$destination_file" ||
    oci_die "image provenance validation failed"
}

normalize_provenance \
  "$TARGET_IMAGES_FILE" "$work_dir/target.tsv" \
  "$EXPECTED_TARGET_IMAGES" 1
normalize_provenance \
  "$PROTECTED_IMAGES_FILE" "$work_dir/protected.tsv" \
  "$EXPECTED_PROTECTED_IMAGES" 3

cut -f2 "$work_dir/target.tsv" | LC_ALL=C sort -u > "$work_dir/target-digests.txt"
cut -f2 "$work_dir/protected.tsv" | LC_ALL=C sort -u > "$work_dir/protected-digests.txt"
if comm -12 "$work_dir/target-digests.txt" "$work_dir/protected-digests.txt" |
    grep -q .; then
  oci_die "obsolete generation overlaps a protected generation"
fi
cat "$work_dir/target-digests.txt" "$work_dir/protected-digests.txt" |
  LC_ALL=C sort -u > "$work_dir/expected-before-digests.txt"
[[ "$(wc -l < "$work_dir/expected-before-digests.txt" | tr -d ' ')" == \
  "$EXPECTED_IMAGES_BEFORE" ]] ||
  oci_die "expected registry generations are not pairwise disjoint"

list_images() {
  local destination="$1"
  local raw="$work_dir/images-raw.json"

  oci artifacts container image list \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --repository-name "$repository" \
    --all \
    --output json > "$raw"
  jq -e '
    if (.data | type) == "array" then
      {data: {items: .data}}
    elif
      (.data | type) == "object" and
      (.data.items | type) == "array"
    then
      .
    else
      error("unexpected OCI container image list shape")
    end
  ' "$raw" > "$destination" ||
    oci_die "unable to normalize OCI container image inventory"
}

validate_registry_rows() {
  local inventory_file="$1"
  local required_state="$2"

  jq -e \
    --arg repository "$repository" \
    --arg required_state "$required_state" '
      def parsed_tag:
        (.version // "")
        | try capture(
            "^oci-(?<service>auth|backoffice|bet|client|event|gamemaster|moderation|resulting|slip)-(?<source_sha>[0-9a-f]{40})$"
          ) catch null;
      [
        .data.items[]?
        | select((."lifecycle-state" // "" | ascii_upcase) != "DELETED")
        | . + {parsed_tag: parsed_tag}
      ] as $rows
      | ($rows | length) > 0
      and all(
        $rows[];
        ."repository-name" == $repository and
        (.digest // "" | test("^sha256:[0-9a-f]{64}$")) and
        (.id // "" | startswith("ocid1.containerimage.")) and
        .parsed_tag != null and
        (
          $required_state == "" or
          (."lifecycle-state" // "" | ascii_upcase) == $required_state
        )
      )
      and ([
        ($rows | group_by(.digest))[]
        | select(([.[].parsed_tag.service] | unique | length) != 1)
      ] | length) == 0
    ' "$inventory_file" >/dev/null ||
    oci_die "OCI registry rows violate the exact tag, digest, or lifecycle contract"
}

registry_digest_set() {
  local inventory_file="$1"
  local destination="$2"

  jq -r '
    .data.items[]?
    | select((."lifecycle-state" // "" | ascii_upcase) != "DELETED")
    | .digest
  ' "$inventory_file" | LC_ALL=C sort -u > "$destination"
}

registry_accounting() {
  local destination="$1"
  local raw="$work_dir/repositories-raw.json"

  oci artifacts container repository list \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --all \
    --output json > "$raw"
  jq -e \
    --arg repository "$repository" '
      (
        if (.data | type) == "array" then
          .data
        elif
          (.data | type) == "object" and
          (.data.items | type) == "array"
        then
          .data.items
        else
          error("unexpected OCI container repository list shape")
        end
      )
      | [.[] | select(."display-name" == $repository)]
      | if length == 1 then
          {
            image_count: .[0]."image-count",
            layers_size_bytes: .[0]."layers-size-in-bytes"
          }
        else
          error("expected exactly one OCI container repository")
        end
      | select(
          (.image_count | type) == "number" and
          (.layers_size_bytes | type) == "number"
        )
    ' "$raw" > "$destination" ||
    oci_die "unable to read exact OCI registry accounting"
}

list_images "$work_dir/before.json"
validate_registry_rows "$work_dir/before.json" AVAILABLE
registry_digest_set "$work_dir/before.json" "$work_dir/before-digests.txt"
deletion_required=true
if cmp -s "$work_dir/expected-before-digests.txt" "$work_dir/before-digests.txt"; then
  before_image_count="$EXPECTED_IMAGES_BEFORE"
elif cmp -s "$work_dir/protected-digests.txt" "$work_dir/before-digests.txt"; then
  deletion_required=false
  before_image_count="$EXPECTED_PROTECTED_IMAGES"
else
  oci_die "registry contains an unknown, missing, or unexpected image generation"
fi

: > "$OUTPUT_DIR/deletion-plan.tsv"
if [[ "$deletion_required" == "true" ]]; then
  while IFS=$'\t' read -r service digest; do
    version="oci-${service}-${TARGET_SOURCE_SHA}"
    image_ids="$(
      jq -r \
        --arg digest "$digest" \
        --arg version "$version" '
          [
            .data.items[]?
            | select(
                .digest == $digest and
                .version == $version and
                (."lifecycle-state" // "" | ascii_upcase) == "AVAILABLE"
              )
            | .id
          ]
          | unique[]
        ' "$work_dir/before.json"
    )"
    [[ "$(awk 'NF {count++} END {print count+0}' <<<"$image_ids")" == "1" ]] ||
      oci_die "target digest does not map to one exact source-tagged image"
    image_id="$(awk 'NF {print; exit}' <<<"$image_ids")"
    printf '%s\t%s\t%s\n' "$service" "$digest" "$image_id" \
      >> "$OUTPUT_DIR/deletion-plan.tsv"
  done < "$work_dir/target.tsv"

  [[ "$(wc -l < "$OUTPUT_DIR/deletion-plan.tsv" | tr -d ' ')" == \
    "$EXPECTED_TARGET_IMAGES" ]] ||
    oci_die "registry deletion plan is incomplete"
  [[ "$(cut -f3 "$OUTPUT_DIR/deletion-plan.tsv" | LC_ALL=C sort -u | wc -l |
    tr -d ' ')" == "$EXPECTED_TARGET_IMAGES" ]] ||
    oci_die "registry deletion plan reuses an image OCID"
fi

target_sha256="$(oci_sha256 < "$work_dir/target.tsv")"
protected_sha256="$(oci_sha256 < "$work_dir/protected.tsv")"
jq -n \
  --arg target_source_sha "$TARGET_SOURCE_SHA" \
  --arg current_source_sha "$CURRENT_SOURCE_SHA" \
  --arg target_sha256 "$target_sha256" \
  --arg protected_sha256 "$protected_sha256" \
  --arg deletion_required "$deletion_required" \
  --argjson unique_images "$before_image_count" \
  '{
    target_source_sha: $target_source_sha,
    current_source_sha: $current_source_sha,
    target_generation_sha256: $target_sha256,
    protected_generations_sha256: $protected_sha256,
    unique_images: $unique_images,
    deletion_required: ($deletion_required == "true")
  }' > "$OUTPUT_DIR/before-summary.json"

if [[ "$deletion_required" == "true" ]]; then
  while IFS=$'\t' read -r _service _digest image_id; do
    oci artifacts container image delete \
      --image-id "$image_id" \
      --force >/dev/null
  done < "$OUTPUT_DIR/deletion-plan.tsv"
fi

pruned=false
for ((attempt = 1; attempt <= PRUNE_POLL_ATTEMPTS; attempt++)); do
  list_images "$work_dir/after.json"
  registry_digest_set "$work_dir/after.json" "$work_dir/after-digests.txt"

  if ! comm -23 \
    "$work_dir/protected-digests.txt" "$work_dir/after-digests.txt" |
      grep -q .; then
    if cmp -s \
      "$work_dir/protected-digests.txt" "$work_dir/after-digests.txt"; then
      registry_accounting "$work_dir/accounting.json"
      if jq -e \
        --argjson expected_images "$EXPECTED_PROTECTED_IMAGES" \
        --argjson max_bytes "$OCI_REGISTRY_MAX_BYTES" '
          .image_count == $expected_images and
          .layers_size_bytes <= $max_bytes
        ' "$work_dir/accounting.json" >/dev/null; then
        pruned=true
        break
      fi
    fi
  else
    oci_die "a protected registry digest disappeared during pruning"
  fi

  if ((attempt < PRUNE_POLL_ATTEMPTS)); then
    sleep "$PRUNE_POLL_SECONDS"
  fi
done
[[ "$pruned" == "true" ]] ||
  oci_die "OCI registry pruning did not reach the exact protected digest set"

validate_registry_rows "$work_dir/after.json" AVAILABLE
if comm -12 "$work_dir/target-digests.txt" "$work_dir/after-digests.txt" |
    grep -q .; then
  oci_die "obsolete registry digests remain after pruning"
fi

cp "$work_dir/target.tsv" "$OUTPUT_DIR/deleted-images.tsv"
jq -e . "$work_dir/accounting.json" > "$OUTPUT_DIR/registry-accounting.json"
jq -n \
  --arg target_source_sha "$TARGET_SOURCE_SHA" \
  --arg current_source_sha "$CURRENT_SOURCE_SHA" \
  --arg protected_sha256 "$protected_sha256" \
  --argjson unique_images "$EXPECTED_PROTECTED_IMAGES" \
  '{
    target_source_sha: $target_source_sha,
    current_source_sha: $current_source_sha,
    protected_generations_sha256: $protected_sha256,
    unique_images: $unique_images,
    terminal_status: "PRUNED"
  }' > "$OUTPUT_DIR/after-summary.json"

echo "registry_generation_pruned=$TARGET_SOURCE_SHA"
