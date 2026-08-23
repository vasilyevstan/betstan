#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

TARGET_SOURCE_SHAS_FILE="${TARGET_SOURCE_SHAS_FILE:-}"
TRUSTED_TARGET_IMAGES_FILE="${TRUSTED_TARGET_IMAGES_FILE:-}"
PROTECTED_IMAGES_FILE="${PROTECTED_IMAGES_FILE:-}"
TRUSTED_PROTECTED_IMAGES_FILE="${TRUSTED_PROTECTED_IMAGES_FILE:-}"
VALIDATED_BEFORE_SUMMARY_FILE="${VALIDATED_BEFORE_SUMMARY_FILE:-}"
REQUEST_PROVENANCE_FILE="${REQUEST_PROVENANCE_FILE:-}"
CURRENT_SOURCE_SHA="${CURRENT_SOURCE_SHA:-}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts/oci-registry-prune}"
PRUNE_MODE="${PRUNE_MODE:-apply}"
PRUNE_POLL_ATTEMPTS="${PRUNE_POLL_ATTEMPTS:-60}"
PRUNE_POLL_SECONDS="${PRUNE_POLL_SECONDS:-10}"
EXPECTED_SERVICES='auth backoffice bet client event gamemaster moderation resulting slip'
IMAGES_PER_GENERATION=9
EXPECTED_PROTECTED_PROVENANCE_ROWS=27
MAX_PROTECTED_IMAGES=27
MAX_TARGET_GENERATIONS=10
MAX_REGISTRY_TAG_ROWS=900
MAX_REGISTRY_TAG_GENERATIONS=100

oci_require_cli_version
oci_require_command jq
oci_require_vars \
  OCI_COMPARTMENT_OCID OCI_IMAGE_PREFIX OCI_REGISTRY_MAX_BYTES
oci_require_ocid OCI_COMPARTMENT_OCID

[[ "$CURRENT_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  oci_die "CURRENT_SOURCE_SHA must be a full commit SHA"
[[ "$PRUNE_POLL_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "PRUNE_POLL_ATTEMPTS must be a positive integer"
[[ "$PRUNE_POLL_SECONDS" =~ ^[0-9]+$ ]] ||
  oci_die "PRUNE_POLL_SECONDS must be a nonnegative integer"
[[ "$OCI_REGISTRY_MAX_BYTES" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "OCI_REGISTRY_MAX_BYTES must be a positive integer"
[[ "$PRUNE_MODE" == "validate" || "$PRUNE_MODE" == "apply" ]] ||
  oci_die "PRUNE_MODE must be validate or apply"
[[ -f "$TARGET_SOURCE_SHAS_FILE" ]] ||
  oci_die "TARGET_SOURCE_SHAS_FILE does not exist"
[[ -f "$TRUSTED_TARGET_IMAGES_FILE" ]] ||
  oci_die "TRUSTED_TARGET_IMAGES_FILE does not exist"
[[ -f "$PROTECTED_IMAGES_FILE" ]] ||
  oci_die "PROTECTED_IMAGES_FILE does not exist"
[[ -f "$TRUSTED_PROTECTED_IMAGES_FILE" ]] ||
  oci_die "TRUSTED_PROTECTED_IMAGES_FILE does not exist"
[[ -f "$REQUEST_PROVENANCE_FILE" && ! -L "$REQUEST_PROVENANCE_FILE" ]] ||
  oci_die "REQUEST_PROVENANCE_FILE must be a regular file"
jq -e 'type == "object"' "$REQUEST_PROVENANCE_FILE" >/dev/null ||
  oci_die "request provenance is not valid JSON"
if [[ "$PRUNE_MODE" == "apply" ]]; then
  [[ -f "$VALIDATED_BEFORE_SUMMARY_FILE" &&
    ! -L "$VALIDATED_BEFORE_SUMMARY_FILE" ]] ||
    oci_die "apply mode requires a regular validated before-summary file"
  jq -e 'type == "object"' "$VALIDATED_BEFORE_SUMMARY_FILE" >/dev/null ||
    oci_die "validated before-summary is not valid JSON"
fi

mkdir -p "$OUTPUT_DIR"
work_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

normalize_target_sources() {
  awk -v current_sha="$CURRENT_SOURCE_SHA" '
    function valid_sha(value) {
      return length(value) == 40 && value ~ /^[0-9a-f]+$/
    }
    NF != 1 || !valid_sha($1) || $1 == current_sha || seen[$1]++ {
      exit 1
    }
    {
      print $1
    }
  ' "$TARGET_SOURCE_SHAS_FILE" | LC_ALL=C sort \
    > "$work_dir/target-source-shas.txt" ||
    oci_die "target source SHA validation failed"
}

normalize_target_sources
target_generation_count="$(
  wc -l < "$work_dir/target-source-shas.txt" | tr -d ' '
)"
((target_generation_count >= 1 && target_generation_count <= MAX_TARGET_GENERATIONS)) ||
  oci_die "target generation count must be between 1 and $MAX_TARGET_GENERATIONS"

repository="${OCI_IMAGE_PREFIX}_images"

read_provenance_repository() {
  local source_file="$1"

  awk -F '\t' -v repository="$repository" '
    function valid_repository(value, suffix) {
      suffix = "/" repository
      return value !~ /[[:space:]]/ && length(value) > length(suffix) &&
        substr(value, length(value) - length(suffix) + 1) == suffix
    }
    NF != 5 || !valid_repository($2) {
      exit 1
    }
    {
      repositories[$2] = 1
    }
    END {
      for (value in repositories) {
        count++
        selected = value
      }
      if (count != 1) {
        exit 1
      }
      print selected
    }
  ' "$source_file"
}

provenance_repository="$(
  read_provenance_repository "$PROTECTED_IMAGES_FILE"
)" || oci_die "protected provenance does not identify one exact registry repository"

normalize_protected_provenance() {
  awk -F '\t' \
    -v repository="$provenance_repository" \
    -v expected_rows="$EXPECTED_PROTECTED_PROVENANCE_ROWS" \
    -v images_per_generation="$IMAGES_PER_GENERATION" \
    -v expected_services="$EXPECTED_SERVICES" '
      BEGIN {
        expected_service_count = expected_rows / images_per_generation
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
      NF != 5 || !($1 in allowed) || $2 != repository ||
        $3 != $2 "@" $4 || $4 != $5 || !valid_digest($4) ||
        ($4 in digest_service && digest_service[$4] != $1) {
        exit 1
      }
      {
        rows++
        service_count[$1]++
        digest_service[$4] = $1
        print $1 "\t" $4
      }
      END {
        if (rows != expected_rows) {
          exit 1
        }
        for (service in allowed) {
          if (service_count[service] != expected_service_count) {
            exit 1
          }
        }
      }
    ' "$PROTECTED_IMAGES_FILE" |
    LC_ALL=C sort -u -t $'\t' -k1,1 -k2,2 \
      > "$work_dir/protected.tsv" ||
    oci_die "protected image provenance validation failed"
}

normalize_trusted_target_provenance() {
  awk -F '\t' \
    -v repository="$provenance_repository" \
    -v target_file="$work_dir/target-source-shas.txt" \
    -v expected_services="$EXPECTED_SERVICES" '
      BEGIN {
        while ((getline source < target_file) > 0) {
          targets[source] = 1
        }
        close(target_file)
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
      NF != 6 || !($1 in targets) || !($2 in allowed) ||
        $3 != repository || $4 != $3 "@" $5 || $5 != $6 ||
        !valid_digest($5) || seen[$1 SUBSEP $2]++ || digest_seen[$5]++ {
        exit 1
      }
      {
        source_count[$1]++
        print $1 "\t" $2 "\t" $5
      }
      END {
        for (source in source_count) {
          if (source_count[source] != 9) {
            exit 1
          }
          for (service in allowed) {
            if (!seen[source SUBSEP service]) {
              exit 1
            }
          }
        }
      }
    ' "$TRUSTED_TARGET_IMAGES_FILE" |
    LC_ALL=C sort -t $'\t' -k1,1 -k2,2 \
      > "$work_dir/trusted-targets.tsv" ||
    oci_die "trusted target image provenance validation failed"
}

normalize_trusted_protected_provenance() {
  awk -F '\t' \
    -v repository="$provenance_repository" \
    -v current_sha="$CURRENT_SOURCE_SHA" \
    -v expected_rows="$EXPECTED_PROTECTED_PROVENANCE_ROWS" \
    -v images_per_generation="$IMAGES_PER_GENERATION" \
    -v expected_services="$EXPECTED_SERVICES" '
      BEGIN {
        split(expected_services, services, " ")
        for (service_index in services) {
          allowed[services[service_index]] = 1
        }
      }
      function valid_sha(value) {
        return length(value) == 40 && value ~ /^[0-9a-f]+$/
      }
      function valid_digest(value) {
        return length(value) == 71 &&
          substr(value, 1, 7) == "sha256:" &&
          substr(value, 8) ~ /^[0-9a-f]+$/
      }
      NF != 6 || !valid_sha($1) || !($2 in allowed) ||
        $3 != repository || $4 != $3 "@" $5 || $5 != $6 ||
        !valid_digest($5) || seen[$1 SUBSEP $2]++ ||
        ($5 in digest_service && digest_service[$5] != $2) {
        exit 1
      }
      {
        rows++
        source_count[$1]++
        source_digest[$1 SUBSEP $2] = $5
        digest_service[$5] = $2
        print $1 "\t" $2 "\t" $5
      }
      END {
        if (rows != expected_rows) {
          exit 1
        }
        for (source in source_count) {
          sources++
          if (source_count[source] != images_per_generation) {
            exit 1
          }
          for (service in allowed) {
            if (!seen[source SUBSEP service]) {
              exit 1
            }
          }
        }
        if (sources != expected_rows / images_per_generation) {
          exit 1
        }
        if (source_count[current_sha] != images_per_generation) {
          exit 1
        }
        for (left in source_count) {
          for (right in source_count) {
            if (left == right) {
              continue
            }
            shared = 0
            equal = 1
            for (service in allowed) {
              left_digest = source_digest[left SUBSEP service]
              right_digest = source_digest[right SUBSEP service]
              if (left_digest == right_digest) {
                shared++
              } else {
                equal = 0
              }
            }
            if (shared > 0 && !equal) {
              exit 1
            }
          }
        }
      }
    ' "$TRUSTED_PROTECTED_IMAGES_FILE" |
    LC_ALL=C sort -t $'\t' -k1,1 -k2,2 \
      > "$work_dir/trusted-protected.tsv" ||
    oci_die "trusted protected image provenance validation failed"
}

normalize_protected_provenance
normalize_trusted_target_provenance
normalize_trusted_protected_provenance

cut -f2 "$work_dir/protected.tsv" |
  LC_ALL=C sort -u > "$work_dir/protected-digests.txt"
protected_image_count="$(
  wc -l < "$work_dir/protected-digests.txt" | tr -d ' '
)"
((protected_image_count >= IMAGES_PER_GENERATION &&
  protected_image_count <= MAX_PROTECTED_IMAGES &&
  protected_image_count % IMAGES_PER_GENERATION == 0)) ||
  oci_die "protected provenance is not one to three complete unique image generations"
protected_unique_generation_count="$(
  printf '%s\n' "$((protected_image_count / IMAGES_PER_GENERATION))"
)"
cut -f2,3 "$work_dir/trusted-protected.tsv" |
  LC_ALL=C sort -u -t $'\t' -k1,1 -k2,2 \
    > "$work_dir/trusted-protected-service-digests.tsv"
cmp -s \
  "$work_dir/protected.tsv" \
  "$work_dir/trusted-protected-service-digests.tsv" ||
  oci_die "trusted protected source tags do not match protected digest provenance"

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
        ($rows | group_by(.version))[]
        | select(length != 1)
      ] | length) == 0
      and ([
        ($rows | group_by(.digest))[]
        | select(
            ([.[].parsed_tag.service] | unique | length) != 1 or
            ([.[].id] | unique | length) != 1
          )
      ] | length) == 0
      and ([
        ($rows | group_by(.id))[]
        | select(
            ([.[].parsed_tag.service] | unique | length) != 1 or
            ([.[].digest] | unique | length) != 1
          )
      ] | length) == 0
    ' "$inventory_file" >/dev/null ||
    oci_die "OCI registry aliases violate the exact tag, identity, digest, or lifecycle contract"
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

registry_image_id_set() {
  local inventory_file="$1"
  local destination="$2"

  jq -r '
    .data.items[]?
    | select((."lifecycle-state" // "" | ascii_upcase) != "DELETED")
    | .id
  ' "$inventory_file" | LC_ALL=C sort -u > "$destination"
}

registry_service_digest_set() {
  local inventory_file="$1"
  local destination="$2"

  jq -r '
    def parsed_tag:
      (.version // "")
      | try capture(
          "^oci-(?<service>auth|backoffice|bet|client|event|gamemaster|moderation|resulting|slip)-(?<source_sha>[0-9a-f]{40})$"
        ) catch null;
    .data.items[]?
    | select((."lifecycle-state" // "" | ascii_upcase) != "DELETED")
    | parsed_tag as $tag
    | [$tag.service, .digest]
    | @tsv
  ' "$inventory_file" | LC_ALL=C sort -u > "$destination"
}

registry_alias_inventory() {
  local inventory_file="$1"
  local destination="$2"

  jq -r '
    def parsed_tag:
      (.version // "")
      | capture(
          "^oci-(?<service>auth|backoffice|bet|client|event|gamemaster|moderation|resulting|slip)-(?<source_sha>[0-9a-f]{40})$"
        );
    .data.items[]?
    | select((."lifecycle-state" // "" | ascii_upcase) != "DELETED")
    | parsed_tag as $tag
    | [$tag.source_sha, $tag.service, .digest, .id, .version]
    | @tsv
  ' "$inventory_file" |
    LC_ALL=C sort -t $'\t' -k1,1 -k2,2 > "$destination"
}

active_registry_row_count() {
  jq -r '[
    .data.items[]?
    | select((."lifecycle-state" // "" | ascii_upcase) != "DELETED")
  ] | length' "$1"
}

validate_alias_generations() {
  local membership_file="$1"
  local alias_file="$2"

  awk -F '\t' -v expected_services="$EXPECTED_SERVICES" '
    FNR == NR {
      kind[$2] = $1
      canonical[$2 SUBSEP $3] = $4
      canonical_count[$2]++
      canonical_sources[$2] = 1
      next
    }
    NF != 5 || alias_seen[$1 SUBSEP $2]++ {
      failed = 1
      exit
    }
    {
      alias[$1 SUBSEP $2] = $3
      alias_count[$1]++
      alias_sources[$1] = 1
    }
    END {
      split(expected_services, services, " ")
      for (source in alias_sources) {
        matched = 0
        for (candidate in canonical_sources) {
          if (alias_count[source] > canonical_count[candidate]) {
            continue
          }
          compatible = 1
          for (service_index in services) {
            service = services[service_index]
            alias_key = source SUBSEP service
            canonical_key = candidate SUBSEP service
            if ((alias_key in alias) &&
              alias[alias_key] != canonical[canonical_key]) {
              compatible = 0
            }
          }
          if (compatible) {
            if (alias_count[source] == canonical_count[candidate] ||
              kind[candidate] == "target") {
              matched = 1
            }
          }
        }
        if (!matched) {
          failed = 1
        }
      }
      exit failed
    }
  ' "$membership_file" "$alias_file"
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
registry_alias_inventory "$work_dir/before.json" "$work_dir/before-aliases.tsv"
before_row_count="$(active_registry_row_count "$work_dir/before.json")"
before_tag_generation_count="$(
  cut -f1 "$work_dir/before-aliases.tsv" | LC_ALL=C sort -u | wc -l |
    tr -d ' '
)"
((before_row_count <= MAX_REGISTRY_TAG_ROWS)) ||
  oci_die "registry tag row count exceeds the bounded alias contract"
((before_tag_generation_count <= MAX_REGISTRY_TAG_GENERATIONS)) ||
  oci_die "registry tag generation count exceeds the bounded alias contract"

jq -r \
  --rawfile target_sources "$work_dir/target-source-shas.txt" '
    def parsed_tag:
      (.version // "")
      | try capture(
          "^oci-(?<service>auth|backoffice|bet|client|event|gamemaster|moderation|resulting|slip)-(?<source_sha>[0-9a-f]{40})$"
        ) catch null;
    ($target_sources | split("\n") | map(select(length > 0))) as $targets
    | .data.items[]?
    | select((."lifecycle-state" // "" | ascii_upcase) != "DELETED")
    | parsed_tag as $tag
    | select($tag != null and ($targets | index($tag.source_sha)) != null)
    | [$tag.source_sha, $tag.service, .digest, .id]
    | @tsv
  ' "$work_dir/before.json" |
  awk -F '\t' \
    -v target_file="$work_dir/target-source-shas.txt" \
    -v expected_services="$EXPECTED_SERVICES" '
      BEGIN {
        while ((getline source < target_file) > 0) {
          targets[source] = 1
        }
        close(target_file)
        split(expected_services, services, " ")
        for (service_index in services) {
          allowed[services[service_index]] = 1
        }
      }
      NF != 4 || !($1 in targets) || !($2 in allowed) ||
        seen_service[$1 SUBSEP $2]++ || seen_digest[$3]++ ||
        seen_image_id[$4]++ {
        exit 1
      }
      {
        source_count[$1]++
        print
      }
      END {
        for (source in targets) {
          if (source_count[source] > 9) {
            exit 1
          }
        }
      }
    ' |
  LC_ALL=C sort -t $'\t' -k1,1 -k2,2 \
    > "$work_dir/target-registry.tsv" ||
  oci_die "target registry rows are ambiguous or exceed one service set"

cut -f1 "$work_dir/target-registry.tsv" |
  LC_ALL=C sort -u > "$work_dir/present-target-sources.txt"
present_target_generation_count="$(
  wc -l < "$work_dir/present-target-sources.txt" | tr -d ' '
)"
present_target_image_count="$(
  wc -l < "$work_dir/target-registry.tsv" | tr -d ' '
)"
cut -f1 "$work_dir/trusted-targets.tsv" |
  LC_ALL=C sort -u > "$work_dir/trusted-target-sources.txt"

while IFS=$'\t' read -r source service digest _image_id; do
  if grep -Fxq "$source" "$work_dir/trusted-target-sources.txt"; then
    expected_row="${source}"$'\t'"${service}"$'\t'"${digest}"
    grep -Fqx "$expected_row" "$work_dir/trusted-targets.tsv" ||
      oci_die "registry target differs from trusted successful-build provenance"
  fi
done < "$work_dir/target-registry.tsv"

cut -f3 "$work_dir/target-registry.tsv" |
  LC_ALL=C sort -u > "$work_dir/target-digests.txt"
if comm -12 "$work_dir/target-digests.txt" "$work_dir/protected-digests.txt" |
    grep -q .; then
  oci_die "obsolete generations overlap a protected generation"
fi

cat "$work_dir/target-digests.txt" "$work_dir/protected-digests.txt" |
  LC_ALL=C sort -u > "$work_dir/expected-before-digests.txt"
expected_images_before="$(
  wc -l < "$work_dir/expected-before-digests.txt" | tr -d ' '
)"
[[ "$expected_images_before" == \
  "$((protected_image_count + present_target_image_count))" ]] ||
  oci_die "expected registry generations are not pairwise disjoint"

{
  cut -f2,3 "$work_dir/target-registry.tsv"
  cat "$work_dir/protected.tsv"
} | LC_ALL=C sort -u > "$work_dir/expected-service-digests.tsv"

{
  awk -F '\t' '{ print "protected\t" $1 "\t" $2 "\t" $3 }' \
    "$work_dir/trusted-protected.tsv"
  awk -F '\t' '{ print "target\t" $1 "\t" $2 "\t" $3 }' \
    "$work_dir/target-registry.tsv"
} > "$work_dir/known-generation-memberships.tsv"
validate_alias_generations \
  "$work_dir/known-generation-memberships.tsv" \
  "$work_dir/before-aliases.tsv" ||
  oci_die "registry alias generations do not match a complete protected or remaining target generation"

cut -f1,2,3 "$work_dir/before-aliases.tsv" |
  LC_ALL=C sort -u > "$work_dir/before-source-service-digests.tsv"
if comm -23 \
    "$work_dir/trusted-protected.tsv" \
    "$work_dir/before-source-service-digests.tsv" |
    grep -q .; then
  oci_die "a canonical protected source tag is missing or has an unexpected digest"
fi

registry_digest_set "$work_dir/before.json" "$work_dir/before-digests.txt"
registry_image_id_set "$work_dir/before.json" "$work_dir/before-image-ids.txt"
registry_service_digest_set \
  "$work_dir/before.json" "$work_dir/before-service-digests.tsv"
before_image_id_count="$(
  wc -l < "$work_dir/before-image-ids.txt" | tr -d ' '
)"
[[ "$before_image_id_count" == "$expected_images_before" ]] ||
  oci_die "registry image IDs are not one-to-one with the expected unique digests"
awk -F '\t' '
  FNR == NR {
    protected[$1] = 1
    next
  }
  $3 in protected {
    print $4
  }
' \
  "$work_dir/protected-digests.txt" \
  "$work_dir/before-aliases.tsv" |
  LC_ALL=C sort -u > "$work_dir/protected-image-ids.txt"
[[ "$(wc -l < "$work_dir/protected-image-ids.txt" | tr -d ' ')" == \
  "$protected_image_count" ]] ||
  oci_die "protected digests do not map one-to-one to immutable image OCIDs"
cut -f4 "$work_dir/target-registry.tsv" |
  LC_ALL=C sort -u > "$work_dir/target-image-ids.txt"
if comm -12 \
    "$work_dir/protected-image-ids.txt" "$work_dir/target-image-ids.txt" |
    grep -q .; then
  oci_die "obsolete generations overlap a protected image OCID"
fi
cmp -s \
  "$work_dir/expected-before-digests.txt" "$work_dir/before-digests.txt" ||
  oci_die "registry contains an unknown, missing, or unexpected image generation"
cmp -s \
  "$work_dir/expected-service-digests.tsv" "$work_dir/before-service-digests.tsv" ||
  oci_die "registry service and digest mappings differ from trusted provenance"
registry_accounting "$work_dir/before-accounting.json"
jq -e \
  --argjson expected_images "$expected_images_before" '
    .image_count == $expected_images
  ' "$work_dir/before-accounting.json" >/dev/null ||
  oci_die "registry accounting does not match validated unique identities"
before_registry_image_count="$(
  jq -r '.image_count' "$work_dir/before-accounting.json"
)"
before_layers_size_bytes="$(
  jq -r '.layers_size_bytes' "$work_dir/before-accounting.json"
)"

deletion_required=true
if [[ "$present_target_generation_count" == "0" ]]; then
  deletion_required=false
fi

: > "$OUTPUT_DIR/deletion-plan.tsv"
if [[ "$deletion_required" == "true" ]]; then
  cp "$work_dir/target-registry.tsv" "$OUTPUT_DIR/deletion-plan.tsv"
  expected_target_images="$present_target_image_count"
  [[ "$(wc -l < "$OUTPUT_DIR/deletion-plan.tsv" | tr -d ' ')" == \
    "$expected_target_images" ]] ||
    oci_die "registry deletion plan is incomplete"
  [[ "$(cut -f4 "$OUTPUT_DIR/deletion-plan.tsv" | LC_ALL=C sort -u | wc -l |
    tr -d ' ')" == "$expected_target_images" ]] ||
    oci_die "registry deletion plan reuses an image OCID"
fi

target_sources_json="$(
  jq -Rsc 'split("\n") | map(select(length > 0))' \
    "$work_dir/target-source-shas.txt"
)"
target_sources_sha256="$(oci_sha256 < "$work_dir/target-source-shas.txt")"
target_images_sha256="$(oci_sha256 < "$work_dir/target-registry.tsv")"
protected_sha256="$(oci_sha256 < "$work_dir/protected.tsv")"
protected_sources_sha256="$(
  oci_sha256 < "$work_dir/trusted-protected.tsv"
)"
protected_image_ids_sha256="$(
  oci_sha256 < "$work_dir/protected-image-ids.txt"
)"
registry_aliases_sha256="$(
  oci_sha256 < "$work_dir/before-aliases.tsv"
)"
request_provenance_sha256="$(
  oci_sha256 < "$REQUEST_PROVENANCE_FILE"
)"
before_alias_count="$((before_row_count - expected_images_before))"
jq -n \
  --argjson target_source_shas "$target_sources_json" \
  --arg current_source_sha "$CURRENT_SOURCE_SHA" \
  --arg target_sources_sha256 "$target_sources_sha256" \
  --arg target_images_sha256 "$target_images_sha256" \
  --arg protected_sha256 "$protected_sha256" \
  --arg protected_sources_sha256 "$protected_sources_sha256" \
  --arg protected_image_ids_sha256 "$protected_image_ids_sha256" \
  --arg registry_aliases_sha256 "$registry_aliases_sha256" \
  --arg request_provenance_sha256 "$request_provenance_sha256" \
  --arg deletion_required "$deletion_required" \
  --argjson requested_target_generations "$target_generation_count" \
  --argjson present_target_generations "$present_target_generation_count" \
  --argjson present_target_images "$present_target_image_count" \
  --argjson protected_unique_generations "$protected_unique_generation_count" \
  --argjson unique_images "$expected_images_before" \
  --argjson unique_image_ids "$before_image_id_count" \
  --argjson tag_rows "$before_row_count" \
  --argjson alias_rows "$before_alias_count" \
  --argjson tag_generations "$before_tag_generation_count" \
  --argjson registry_image_count "$before_registry_image_count" \
  --argjson registry_layers_size_bytes "$before_layers_size_bytes" \
  '{
    target_source_shas: $target_source_shas,
    current_source_sha: $current_source_sha,
    target_sources_sha256: $target_sources_sha256,
    target_images_sha256: $target_images_sha256,
    protected_generations_sha256: $protected_sha256,
    protected_source_tags_sha256: $protected_sources_sha256,
    protected_image_ids_sha256: $protected_image_ids_sha256,
    registry_aliases_sha256: $registry_aliases_sha256,
    request_provenance_sha256: $request_provenance_sha256,
    requested_target_generations: $requested_target_generations,
    present_target_generations: $present_target_generations,
    present_target_images: $present_target_images,
    protected_unique_generations: $protected_unique_generations,
    unique_images: $unique_images,
    unique_image_ids: $unique_image_ids,
    tag_rows: $tag_rows,
    alias_rows: $alias_rows,
    tag_generations: $tag_generations,
    registry_image_count: $registry_image_count,
    registry_layers_size_bytes: $registry_layers_size_bytes,
    deletion_required: ($deletion_required == "true")
  }' > "$OUTPUT_DIR/before-summary.json"

if [[ "$PRUNE_MODE" == "validate" ]]; then
  cp "$work_dir/target-registry.tsv" "$OUTPUT_DIR/planned-images.tsv"
  cp "$work_dir/protected-image-ids.txt" \
    "$OUTPUT_DIR/protected-image-ids.txt"
  cp "$work_dir/before-aliases.tsv" "$OUTPUT_DIR/before-aliases.tsv"
  jq -e . "$work_dir/before-accounting.json" \
    > "$OUTPUT_DIR/registry-accounting.json"
  jq '. + {terminal_status: "VALIDATED"}' \
    "$OUTPUT_DIR/before-summary.json" \
    > "$OUTPUT_DIR/validation-summary.json"
  echo "registry_generations_validated=$(paste -sd, "$work_dir/target-source-shas.txt")"
  exit 0
fi

cmp -s \
  "$VALIDATED_BEFORE_SUMMARY_FILE" "$OUTPUT_DIR/before-summary.json" ||
  oci_die "live registry or trusted provenance changed since validation"
cp "$VALIDATED_BEFORE_SUMMARY_FILE" \
  "$OUTPUT_DIR/validated-before-summary.json"
validated_before_summary_sha256="$(
  oci_sha256 < "$VALIDATED_BEFORE_SUMMARY_FILE"
)"

if [[ "$deletion_required" == "true" ]]; then
  list_images "$work_dir/pre-delete.json"
  validate_registry_rows "$work_dir/pre-delete.json" AVAILABLE
  registry_alias_inventory \
    "$work_dir/pre-delete.json" "$work_dir/pre-delete-aliases.tsv"
  cmp -s \
    "$work_dir/before-aliases.tsv" "$work_dir/pre-delete-aliases.tsv" ||
    oci_die "registry aliases changed after validation and before deletion"
  registry_accounting "$work_dir/pre-delete-accounting.json"
  cmp -s \
    "$work_dir/before-accounting.json" \
    "$work_dir/pre-delete-accounting.json" ||
    oci_die "registry accounting changed after validation and before deletion"

  while IFS=$'\t' read -r _source _service _digest image_id; do
    oci artifacts container image delete \
      --image-id "$image_id" \
      --force >/dev/null
  done < "$OUTPUT_DIR/deletion-plan.tsv"
fi

grep '^protected' "$work_dir/known-generation-memberships.tsv" \
  > "$work_dir/protected-generation-memberships.tsv"

pruned=false
for ((attempt = 1; attempt <= PRUNE_POLL_ATTEMPTS; attempt++)); do
  list_images "$work_dir/after.json"
  registry_digest_set "$work_dir/after.json" "$work_dir/after-digests.txt"

  if ! comm -23 \
    "$work_dir/protected-digests.txt" "$work_dir/after-digests.txt" |
      grep -q .; then
    if cmp -s \
      "$work_dir/protected-digests.txt" "$work_dir/after-digests.txt"; then
      validate_registry_rows "$work_dir/after.json" AVAILABLE
      registry_image_id_set \
        "$work_dir/after.json" "$work_dir/after-image-ids.txt"
      [[ "$(wc -l < "$work_dir/after-image-ids.txt" | tr -d ' ')" == \
        "$protected_image_count" ]] ||
        oci_die "protected digests no longer have one-to-one image IDs"
      cmp -s \
        "$work_dir/protected-image-ids.txt" \
        "$work_dir/after-image-ids.txt" ||
        oci_die "the exact protected image OCID set changed during pruning"
      registry_service_digest_set \
        "$work_dir/after.json" "$work_dir/after-service-digests.tsv"
      cmp -s \
        "$work_dir/protected.tsv" \
        "$work_dir/after-service-digests.tsv" ||
        oci_die "OCI registry retained an unexpected service or digest mapping"
      registry_alias_inventory \
        "$work_dir/after.json" "$work_dir/after-aliases.tsv"
      validate_alias_generations \
        "$work_dir/protected-generation-memberships.tsv" \
        "$work_dir/after-aliases.tsv" ||
        oci_die "OCI registry retained an incomplete or unknown protected alias generation"
      cut -f1,2,3 "$work_dir/after-aliases.tsv" |
        LC_ALL=C sort -u > "$work_dir/after-source-service-digests.tsv"
      if comm -23 \
        "$work_dir/trusted-protected.tsv" \
        "$work_dir/after-source-service-digests.tsv" |
        grep -q .; then
        oci_die "a canonical protected source tag disappeared during pruning"
      fi
      after_row_count="$(active_registry_row_count "$work_dir/after.json")"
      registry_accounting "$work_dir/accounting.json"
      if jq -e \
        --argjson expected_images "$protected_image_count" \
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

if comm -12 "$work_dir/target-digests.txt" "$work_dir/after-digests.txt" |
    grep -q .; then
  oci_die "obsolete registry digests remain after pruning"
fi

cp "$work_dir/target-registry.tsv" "$OUTPUT_DIR/deleted-images.tsv"
cp "$work_dir/protected-image-ids.txt" "$OUTPUT_DIR/protected-image-ids.txt"
cp "$work_dir/before-aliases.tsv" "$OUTPUT_DIR/before-aliases.tsv"
cp "$work_dir/after-aliases.tsv" "$OUTPUT_DIR/after-aliases.tsv"
jq -e . "$work_dir/accounting.json" > "$OUTPUT_DIR/registry-accounting.json"
after_row_count="$(active_registry_row_count "$work_dir/after.json")"
after_alias_count="$((after_row_count - protected_image_count))"
after_registry_image_count="$(
  jq -r '.image_count' "$work_dir/accounting.json"
)"
after_layers_size_bytes="$(
  jq -r '.layers_size_bytes' "$work_dir/accounting.json"
)"
after_tag_generation_count="$(
  cut -f1 "$work_dir/after-aliases.tsv" | LC_ALL=C sort -u | wc -l |
    tr -d ' '
)"
jq -n \
  --argjson target_source_shas "$target_sources_json" \
  --arg current_source_sha "$CURRENT_SOURCE_SHA" \
  --arg protected_sha256 "$protected_sha256" \
  --arg protected_sources_sha256 "$protected_sources_sha256" \
  --arg protected_image_ids_sha256 "$protected_image_ids_sha256" \
  --arg registry_aliases_sha256 "$registry_aliases_sha256" \
  --arg request_provenance_sha256 "$request_provenance_sha256" \
  --arg validated_before_summary_sha256 \
    "$validated_before_summary_sha256" \
  --argjson requested_target_generations "$target_generation_count" \
  --argjson pruned_target_generations "$present_target_generation_count" \
  --argjson protected_unique_generations "$protected_unique_generation_count" \
  --argjson unique_images "$protected_image_count" \
  --argjson unique_image_ids "$protected_image_count" \
  --argjson tag_rows "$after_row_count" \
  --argjson alias_rows "$after_alias_count" \
  --argjson tag_generations "$after_tag_generation_count" \
  --argjson registry_image_count "$after_registry_image_count" \
  --argjson registry_layers_size_bytes "$after_layers_size_bytes" \
  '{
    target_source_shas: $target_source_shas,
    current_source_sha: $current_source_sha,
    protected_generations_sha256: $protected_sha256,
    protected_source_tags_sha256: $protected_sources_sha256,
    protected_image_ids_sha256: $protected_image_ids_sha256,
    registry_aliases_sha256: $registry_aliases_sha256,
    request_provenance_sha256: $request_provenance_sha256,
    validated_before_summary_sha256: $validated_before_summary_sha256,
    requested_target_generations: $requested_target_generations,
    pruned_target_generations: $pruned_target_generations,
    protected_unique_generations: $protected_unique_generations,
    unique_images: $unique_images,
    unique_image_ids: $unique_image_ids,
    tag_rows: $tag_rows,
    alias_rows: $alias_rows,
    tag_generations: $tag_generations,
    registry_image_count: $registry_image_count,
    registry_layers_size_bytes: $registry_layers_size_bytes,
    terminal_status: "PRUNED"
  }' > "$OUTPUT_DIR/after-summary.json"

echo "registry_generations_pruned=$(paste -sd, "$work_dir/target-source-shas.txt")"
