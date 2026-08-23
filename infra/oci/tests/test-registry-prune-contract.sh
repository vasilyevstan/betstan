#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
WORK_DIR="$OCI_DIR/tests/.registry-prune-work"
SERVICES=(auth backoffice bet client event gamemaster moderation resulting slip)
TARGET_ONE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DEPLOYED_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
ROLLBACK_SHA="cccccccccccccccccccccccccccccccccccccccc"
CURRENT_SHA="dddddddddddddddddddddddddddddddddddddddd"
TARGET_TWO_SHA="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
FAILED_TARGET_SHA="ffffffffffffffffffffffffffffffffffffffff"
REPOSITORY="fra.ocir.io/example/betstan_images"

fail() {
  echo "OCI registry prune contract failure: $*" >&2
  exit 1
}

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/bin" "$WORK_DIR/state"
trap 'rm -rf "$WORK_DIR"' EXIT

digest_for() {
  local generation="$1"
  local service_index="$2"
  printf 'sha256:%064d' "$((generation * 9 + service_index + 1))"
}

write_generation() {
  local generation="$1"
  local output_file="$2"
  local service_index service digest

  : > "$output_file"
  for service_index in "${!SERVICES[@]}"; do
    service="${SERVICES[$service_index]}"
    digest="$(digest_for "$generation" "$service_index")"
    printf '%s\t%s\t%s@%s\t%s\t%s\n' \
      "$service" "$REPOSITORY" "$REPOSITORY" "$digest" "$digest" "$digest" \
      >> "$output_file"
  done
}

write_generation 0 "$WORK_DIR/target-one.tsv"
write_generation 1 "$WORK_DIR/deployed.tsv"
write_generation 2 "$WORK_DIR/rollback.tsv"
write_generation 3 "$WORK_DIR/current.tsv"
write_generation 4 "$WORK_DIR/target-two.tsv"
write_generation 5 "$WORK_DIR/failed-target.tsv"
cat \
  "$WORK_DIR/current.tsv" \
  "$WORK_DIR/deployed.tsv" \
  "$WORK_DIR/rollback.tsv" \
  > "$WORK_DIR/protected.tsv"
{
  awk -F '\t' -v sha="$CURRENT_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/current.tsv"
  awk -F '\t' -v sha="$DEPLOYED_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/deployed.tsv"
  awk -F '\t' -v sha="$ROLLBACK_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/rollback.tsv"
} > "$WORK_DIR/trusted-protected-images.tsv"
printf '%s\n' \
  "$TARGET_ONE_SHA" \
  "$TARGET_TWO_SHA" \
  "$FAILED_TARGET_SHA" \
  > "$WORK_DIR/target-source-shas.txt"
{
  awk -F '\t' -v sha="$TARGET_ONE_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/target-one.tsv"
  awk -F '\t' -v sha="$TARGET_TWO_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/target-two.tsv"
} > "$WORK_DIR/trusted-target-images.tsv"
jq -cnS \
  --arg source_sha "$CURRENT_SHA" \
  --arg deployed_sha "$DEPLOYED_SHA" \
  --arg rollback_sha "$ROLLBACK_SHA" \
  --arg target_one_sha "$TARGET_ONE_SHA" \
  --arg target_two_sha "$TARGET_TWO_SHA" \
  --arg failed_target_sha "$FAILED_TARGET_SHA" '
    {
      schema: "betstan.oci-registry-prune-request.v1",
      source_sha: $source_sha,
      candidate_build_run_id: "1001",
      deployed_sha: $deployed_sha,
      deployed_run_id: "1002",
      fallback_sha: $rollback_sha,
      fallback_build_run_id: "1003",
      obsolete_generations: [
        {sha: $target_one_sha, build_run_id: "2001"},
        {sha: $target_two_sha, build_run_id: "2002"},
        {sha: $failed_target_sha, build_run_id: "2003"}
      ]
    }
  ' > "$WORK_DIR/request-provenance.json"
cp \
  "$WORK_DIR/request-provenance.json" \
  "$WORK_DIR/request-provenance-original.json"

jq -n \
  --arg target_one_sha "$TARGET_ONE_SHA" \
  --arg deployed_sha "$DEPLOYED_SHA" \
  --arg rollback_sha "$ROLLBACK_SHA" \
  --arg current_sha "$CURRENT_SHA" \
  --arg target_two_sha "$TARGET_TWO_SHA" \
  --arg failed_target_sha "$FAILED_TARGET_SHA" '
    def services: [
      "auth", "backoffice", "bet", "client", "event", "gamemaster",
      "moderation", "resulting", "slip"
    ];
    def pad($value; $width):
      ($value | tostring) as $text
      | ("0" * ($width - ($text | length))) + $text;
    [
      [$target_one_sha, 0],
      [$deployed_sha, 1],
      [$rollback_sha, 2],
      [$current_sha, 3],
      [$target_two_sha, 4],
      [$failed_target_sha, 5]
    ] as $generations
    | {
        data: {
          items: [
            $generations[] as $generation
            | range(0; 9) as $service_index
            | (
                if $generation[1] < 4
                then 7
                else 6
                end
              ) as $tag_count
            | range(0; $tag_count) as $tag_index
            | (
                if $tag_index == 0
                then $generation[0]
                else pad(
                  100 + ($generation[1] * 10) + $tag_index;
                  40
                )
                end
              ) as $tag_source_sha
            | {
                id: (
                  "ocid1.containerimage.oc1..fixture" +
                  pad(($generation[1] * 9) + $service_index + 1; 3)
                ),
                "repository-name": "betstan_images",
                version: (
                  "oci-\(services[$service_index])-\($tag_source_sha)"
                ),
                digest: (
                  "sha256:" +
                  pad(($generation[1] * 9) + $service_index + 1; 64)
                ),
                "lifecycle-state": "AVAILABLE"
              }
          ]
        }
      }
  ' > "$WORK_DIR/state/images.json"
cp "$WORK_DIR/state/images.json" "$WORK_DIR/state/images-original.json"

cat > "$WORK_DIR/bin/oci" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  echo "3.90.0"
  exit 0
fi
printf '%s\n' "$*" >> "${MOCK_OCI_LOG:?}"
case "$*" in
  "artifacts container image list "*)
    list_count_file="${MOCK_OCI_STATE:?}/list-count"
    list_count=0
    if [[ -f "$list_count_file" ]]; then
      list_count="$(cat "$list_count_file")"
    fi
    list_count="$((list_count + 1))"
    printf '%s\n' "$list_count" > "$list_count_file"
    if [[ -n "${MOCK_OCI_MUTATE_ON_LIST_CALL:-}" &&
          "$list_count" == "$MOCK_OCI_MUTATE_ON_LIST_CALL" ]]; then
      jq '
        .data.items[0] as $source
        | .data.items += [
            $source + {
              version: "oci-auth-7777777777777777777777777777777777777777"
            }
          ]
      ' "${MOCK_OCI_STATE:?}/images.json" \
        > "${MOCK_OCI_STATE:?}/images.json.tmp"
      mv \
        "${MOCK_OCI_STATE:?}/images.json.tmp" \
        "${MOCK_OCI_STATE:?}/images.json"
    fi
    if [[ -n "${MOCK_OCI_REKEY_ON_LIST_CALL:-}" &&
          "$list_count" == "$MOCK_OCI_REKEY_ON_LIST_CALL" ]]; then
      jq '
        .data.items |= map(
          .id |= sub("fixture"; "rekey")
        )
      ' "${MOCK_OCI_STATE:?}/images.json" \
        > "${MOCK_OCI_STATE:?}/images.json.tmp"
      mv \
        "${MOCK_OCI_STATE:?}/images.json.tmp" \
        "${MOCK_OCI_STATE:?}/images.json"
    fi
    cat "${MOCK_OCI_STATE:?}/images.json"
    ;;
  "artifacts container repository list "*)
    repository_list_count_file="${MOCK_OCI_STATE:?}/repository-list-count"
    repository_list_count=0
    if [[ -f "$repository_list_count_file" ]]; then
      repository_list_count="$(cat "$repository_list_count_file")"
    fi
    repository_list_count="$((repository_list_count + 1))"
    printf '%s\n' "$repository_list_count" > "$repository_list_count_file"
    image_count="$(
      jq '[.data.items[].digest] | unique | length' \
        "${MOCK_OCI_STATE:?}/images.json"
    )"
    if ((image_count > 27)); then
      layers_size_bytes=600000000
    else
      layers_size_bytes=300000000
    fi
    if [[ -n "${MOCK_OCI_ACCOUNTING_DRIFT_ON_LIST_CALL:-}" &&
          "$repository_list_count" == "$MOCK_OCI_ACCOUNTING_DRIFT_ON_LIST_CALL" ]]; then
      layers_size_bytes="$((layers_size_bytes + 1))"
    fi
    jq -n \
      --argjson image_count "$image_count" \
      --argjson layers_size_bytes "$layers_size_bytes" '{
      data: {
        items: [{
          "display-name": "betstan_images",
          "image-count": $image_count,
          "layers-size-in-bytes": $layers_size_bytes
        }]
      }
    }'
    ;;
  "artifacts container image delete "*)
    image_id=""
    while (($#)); do
      if [[ "$1" == "--image-id" ]]; then
        image_id="${2:-}"
        break
      fi
      shift
    done
    [[ -n "$image_id" ]]
    jq --arg image_id "$image_id" '
      .data.items |= map(select(.id != $image_id))
    ' "${MOCK_OCI_STATE:?}/images.json" > "${MOCK_OCI_STATE:?}/images.json.tmp"
    mv "${MOCK_OCI_STATE:?}/images.json.tmp" "${MOCK_OCI_STATE:?}/images.json"
    ;;
  *)
    echo "unexpected mock OCI command: $*" >&2
    exit 1
    ;;
esac
MOCK
chmod +x "$WORK_DIR/bin/oci"

run_prune() {
  local protected_file="${TEST_PROTECTED_IMAGES_FILE:-$WORK_DIR/protected.tsv}"
  local trusted_target_file="${TEST_TRUSTED_TARGET_IMAGES_FILE:-$WORK_DIR/trusted-target-images.tsv}"
  local trusted_protected_file="${TEST_TRUSTED_PROTECTED_IMAGES_FILE:-$WORK_DIR/trusted-protected-images.tsv}"

  env \
    PATH="$WORK_DIR/bin:$PATH" \
    MOCK_OCI_LOG="$WORK_DIR/oci.log" \
    MOCK_OCI_STATE="$WORK_DIR/state" \
    MOCK_OCI_MUTATE_ON_LIST_CALL="${MOCK_OCI_MUTATE_ON_LIST_CALL:-}" \
    MOCK_OCI_REKEY_ON_LIST_CALL="${MOCK_OCI_REKEY_ON_LIST_CALL:-}" \
    MOCK_OCI_ACCOUNTING_DRIFT_ON_LIST_CALL="${MOCK_OCI_ACCOUNTING_DRIFT_ON_LIST_CALL:-}" \
    OCI_CLI_VERSION=3.90.0 \
    OCI_COMPARTMENT_OCID=ocid1.compartment.oc1..fixture \
    OCI_IMAGE_PREFIX=betstan \
    OCI_REGISTRY_MAX_BYTES=500000000 \
    TARGET_SOURCE_SHAS_FILE="$WORK_DIR/target-source-shas.txt" \
    TRUSTED_TARGET_IMAGES_FILE="$trusted_target_file" \
    PROTECTED_IMAGES_FILE="$protected_file" \
    TRUSTED_PROTECTED_IMAGES_FILE="$trusted_protected_file" \
    REQUEST_PROVENANCE_FILE="$WORK_DIR/request-provenance.json" \
    VALIDATED_BEFORE_SUMMARY_FILE="$WORK_DIR/validated-before-summary.json" \
    CURRENT_SOURCE_SHA="$CURRENT_SHA" \
    OUTPUT_DIR="$WORK_DIR/evidence" \
    PRUNE_MODE="${TEST_PRUNE_MODE:-apply}" \
    PRUNE_POLL_ATTEMPTS=1 \
    PRUNE_POLL_SECONDS=0 \
    "$OCI_DIR/scripts/prune-registry-generation.sh"
}

prepare_validation() {
  rm -rf "$WORK_DIR/evidence" "$WORK_DIR/validation-evidence"
  : > "$WORK_DIR/oci.log"
  rm -f \
    "$WORK_DIR/state/list-count" \
    "$WORK_DIR/state/repository-list-count"
  TEST_PRUNE_MODE=validate run_prune
  [[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
    fail "read-only registry validation attempted deletion"
  jq -e '.terminal_status == "VALIDATED"' \
    "$WORK_DIR/evidence/validation-summary.json" >/dev/null ||
    fail "registry validation did not emit terminal evidence"
  cp \
    "$WORK_DIR/evidence/before-summary.json" \
    "$WORK_DIR/validated-before-summary.json"
  mv "$WORK_DIR/evidence" "$WORK_DIR/validation-evidence"
  : > "$WORK_DIR/oci.log"
  rm -f \
    "$WORK_DIR/state/list-count" \
    "$WORK_DIR/state/repository-list-count"
}

prepare_validation
jq -e '
  .terminal_status == "VALIDATED" and
  .present_target_images == 27 and
  .unique_images == 54 and
  .unique_image_ids == 54 and
  .tag_rows == 360 and
  .alias_rows == 306 and
  .tag_generations == 40 and
  .registry_image_count == 54 and
  .registry_layers_size_bytes == 600000000
' "$WORK_DIR/validation-evidence/validation-summary.json" >/dev/null ||
  fail "read-only validation did not capture the production-shaped inventory"
run_prune
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log")" == "27" ]] ||
  fail "batch prune did not delete exactly three complete generations"
jq -e '
  .present_target_images == 27 and
  .protected_unique_generations == 3 and
  .unique_images == 54 and
  .unique_image_ids == 54 and
  .tag_rows == 360 and
  .alias_rows == 306 and
  .tag_generations == 40 and
  .registry_image_count == 54 and
  .registry_layers_size_bytes == 600000000
' "$WORK_DIR/evidence/before-summary.json" >/dev/null ||
  fail "batch prune did not model tag aliases separately from image IDs"
jq -e \
  --arg one "$TARGET_ONE_SHA" \
  --arg two "$TARGET_TWO_SHA" \
  --arg failed "$FAILED_TARGET_SHA" '
    .terminal_status == "PRUNED" and
    .target_source_shas == [$one, $two, $failed] and
    .requested_target_generations == 3 and
    .pruned_target_generations == 3 and
    .protected_unique_generations == 3 and
    .unique_images == 27 and
    .unique_image_ids == 27 and
    .tag_rows == 189 and
    .alias_rows == 162 and
    .tag_generations == 21 and
    .registry_image_count == 27 and
    .registry_layers_size_bytes == 300000000
  ' "$WORK_DIR/evidence/after-summary.json" >/dev/null ||
  fail "batch prune did not emit terminal evidence"
validated_before_summary_sha256="$(
  shasum -a 256 "$WORK_DIR/evidence/validated-before-summary.json" |
    awk '{ print $1 }'
)"
[[ "$(jq -r '.validated_before_summary_sha256' "$WORK_DIR/evidence/after-summary.json")" == \
    "$validated_before_summary_sha256" ]] ||
  fail "batch prune did not bind the exact read-only validation snapshot"
[[ "$(wc -l < "$WORK_DIR/evidence/deleted-images.tsv" | tr -d ' ')" == "27" ]] ||
  fail "batch prune evidence does not contain 27 deleted service images"
protected_image_ids_sha256="$(
  shasum -a 256 "$WORK_DIR/evidence/protected-image-ids.txt" |
    awk '{ print $1 }'
)"
[[ "$(wc -l < "$WORK_DIR/evidence/protected-image-ids.txt" | tr -d ' ')" == "27" &&
    "$(jq -r '.protected_image_ids_sha256' "$WORK_DIR/evidence/before-summary.json")" == \
      "$protected_image_ids_sha256" &&
    "$(jq -r '.protected_image_ids_sha256' "$WORK_DIR/evidence/after-summary.json")" == \
      "$protected_image_ids_sha256" ]] ||
  fail "batch prune did not bind exact protected image OCID evidence"
[[ "$(wc -l < "$WORK_DIR/evidence/before-aliases.tsv" | tr -d ' ')" == "360" &&
    "$(wc -l < "$WORK_DIR/evidence/after-aliases.tsv" | tr -d ' ')" == "189" ]] ||
  fail "batch prune did not retain complete before/after alias evidence"
[[ "$(
  jq -c '[
    .data.items | length,
    ([.[] | .id] | unique | length),
    ([.[] | .digest] | unique | length)
  ]' \
    "$WORK_DIR/state/images.json"
)" == "[189,27,27]" ]] ||
  fail "batch prune did not retain exactly three protected alias generations"

prepare_validation
run_prune
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "an already-pruned target generation was deleted again"
jq -e '
  .deletion_required == false and
  .present_target_generations == 0 and
  .protected_unique_generations == 3 and
  .unique_images == 27 and
  .unique_image_ids == 27 and
  .tag_rows == 189 and
  .alias_rows == 162
' "$WORK_DIR/evidence/before-summary.json" >/dev/null ||
  fail "an already-pruned batch was not resumed idempotently"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
cp \
  "$WORK_DIR/request-provenance-original.json" \
  "$WORK_DIR/request-provenance.json"
prepare_validation
jq -cS '.candidate_build_run_id = "9999"' \
  "$WORK_DIR/request-provenance.json" \
  > "$WORK_DIR/request-provenance.tmp"
mv "$WORK_DIR/request-provenance.tmp" "$WORK_DIR/request-provenance.json"
if run_prune >/dev/null 2>&1; then
  fail "same-SHA validation replay with a different run ID was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "request provenance replay was rejected after a delete"
cp \
  "$WORK_DIR/request-provenance-original.json" \
  "$WORK_DIR/request-provenance.json"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
prepare_validation
jq --arg current_sha "$CURRENT_SHA" '
  def services: [
    "auth", "backoffice", "bet", "client", "event", "gamemaster",
    "moderation", "resulting", "slip"
  ];
  .data.items as $rows
  | .data.items += [
      range(0; 9) as $service_index
      | ($rows[]
        | select(
            .version ==
            ("oci-" + services[$service_index] + "-" + $current_sha)
          ))
      | . + {
          version: (
            "oci-" + services[$service_index] + "-" +
            "6666666666666666666666666666666666666666"
          )
        }
    ]
' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
if run_prune >/dev/null 2>&1; then
  fail "registry changes after read-only validation were accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "stale validation was rejected after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
prepare_validation
if MOCK_OCI_MUTATE_ON_LIST_CALL=2 run_prune >/dev/null 2>&1; then
  fail "registry alias drift immediately before deletion was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "pre-delete alias drift was rejected after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
prepare_validation
if MOCK_OCI_ACCOUNTING_DRIFT_ON_LIST_CALL=2 \
  run_prune >/dev/null 2>&1; then
  fail "registry accounting drift immediately before deletion was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "pre-delete accounting drift was rejected after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
prepare_validation
if MOCK_OCI_REKEY_ON_LIST_CALL=3 run_prune >/dev/null 2>&1; then
  fail "post-delete protected image OCID substitution was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log")" == "27" ]] ||
  fail "protected OCID substitution fixture did not reach post-delete validation"
[[ ! -e "$WORK_DIR/evidence/after-summary.json" ]] ||
  fail "protected OCID substitution emitted terminal success evidence"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
rm -f "$WORK_DIR/state/list-count"
cat \
  "$WORK_DIR/deployed.tsv" \
  "$WORK_DIR/deployed.tsv" \
  "$WORK_DIR/rollback.tsv" \
  > "$WORK_DIR/protected-reused.tsv"
{
  awk -F '\t' -v sha="$CURRENT_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/deployed.tsv"
  awk -F '\t' -v sha="$DEPLOYED_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/deployed.tsv"
  awk -F '\t' -v sha="$ROLLBACK_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/rollback.tsv"
} > "$WORK_DIR/trusted-protected-reused.tsv"
jq -r \
  --arg deployed_sha "$DEPLOYED_SHA" \
  --arg rollback_sha "$ROLLBACK_SHA" '
    .data.items[]
    | select(
        (.version | endswith("-" + $deployed_sha)) or
        (.version | endswith("-" + $rollback_sha))
      )
    | .id
  ' "$WORK_DIR/state/images.json" |
  LC_ALL=C sort -u > "$WORK_DIR/expected-reused-protected-ids.txt"
jq \
  --arg current_sha "$CURRENT_SHA" \
  --arg deployed_sha "$DEPLOYED_SHA" '
    def services: [
      "auth", "backoffice", "bet", "client", "event", "gamemaster",
      "moderation", "resulting", "slip"
    ];
    .data.items as $rows
    | ([
        $rows[]
        | select(.version | endswith("-" + $current_sha))
        | .id
      ] | unique) as $old_current_ids
    | ([
        range(0; 9) as $service_index
        | ($rows[]
          | select(
              .version ==
              ("oci-" + services[$service_index] + "-" + $deployed_sha)
            ))
        | . + {
            version: (
              "oci-" + services[$service_index] + "-" + $current_sha
            )
          }
      ]) as $reused_current_tags
    | .data.items = (
        [
          $rows[]
          | .id as $id
          | select(($old_current_ids | index($id)) == null)
        ] + $reused_current_tags
      )
  ' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
TEST_PROTECTED_IMAGES_FILE="$WORK_DIR/protected-reused.tsv" \
  TEST_TRUSTED_PROTECTED_IMAGES_FILE="$WORK_DIR/trusted-protected-reused.tsv" \
  prepare_validation
TEST_PROTECTED_IMAGES_FILE="$WORK_DIR/protected-reused.tsv" \
  TEST_TRUSTED_PROTECTED_IMAGES_FILE="$WORK_DIR/trusted-protected-reused.tsv" \
  run_prune
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log")" == "27" ]] ||
  fail "reused protected generations changed the exact target delete count"
jq -e '
  .terminal_status == "PRUNED" and
  .protected_unique_generations == 2 and
  .unique_images == 18 and
  .unique_image_ids == 18 and
  .tag_rows == 135 and
  .alias_rows == 117 and
  .tag_generations == 15 and
  .registry_image_count == 18
' "$WORK_DIR/evidence/after-summary.json" >/dev/null ||
  fail "reused protected generations did not retain exact alias accounting"
jq -r '.data.items[].id' "$WORK_DIR/state/images.json" |
  LC_ALL=C sort -u > "$WORK_DIR/actual-reused-protected-ids.txt"
cmp -s \
  "$WORK_DIR/expected-reused-protected-ids.txt" \
  "$WORK_DIR/actual-reused-protected-ids.txt" ||
  fail "reused protected generations did not preserve exact protected OCIDs"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
{
  head -n 1 "$WORK_DIR/deployed.tsv"
  tail -n +2 "$WORK_DIR/current.tsv"
  cat "$WORK_DIR/deployed.tsv" "$WORK_DIR/rollback.tsv"
} > "$WORK_DIR/protected-partial-reuse.tsv"
{
  {
    head -n 1 "$WORK_DIR/deployed.tsv"
    tail -n +2 "$WORK_DIR/current.tsv"
  } | awk -F '\t' -v sha="$CURRENT_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }'
  awk -F '\t' -v sha="$DEPLOYED_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/deployed.tsv"
  awk -F '\t' -v sha="$ROLLBACK_SHA" \
    'BEGIN { OFS = "\t" } { print sha, $0 }' \
    "$WORK_DIR/rollback.tsv"
} > "$WORK_DIR/trusted-protected-partial-reuse.tsv"
if TEST_PROTECTED_IMAGES_FILE="$WORK_DIR/protected-partial-reuse.tsv" \
  TEST_TRUSTED_PROTECTED_IMAGES_FILE="$WORK_DIR/trusted-protected-partial-reuse.tsv" \
  run_prune >/dev/null 2>&1; then
  fail "a partially overlapping protected generation was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "partial protected overlap rejection happened after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
rm -f "$WORK_DIR/state/list-count"
cat \
  "$WORK_DIR/current.tsv" \
  "$WORK_DIR/deployed.tsv" \
  "$WORK_DIR/target-one.tsv" \
  > "$WORK_DIR/protected-overlap.tsv"
if TEST_PROTECTED_IMAGES_FILE="$WORK_DIR/protected-overlap.tsv" run_prune \
  >/dev/null 2>&1; then
  fail "overlapping protected and target generations were accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "overlap rejection happened after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
cp "$WORK_DIR/trusted-target-images.tsv" "$WORK_DIR/trusted-target-images-mismatch.tsv"
sed '1s/sha256:[0-9a-f]\{64\}/sha256:9999999999999999999999999999999999999999999999999999999999999999/g' \
  "$WORK_DIR/trusted-target-images-mismatch.tsv" \
  > "$WORK_DIR/trusted-target-images-mismatch.tmp"
mv \
  "$WORK_DIR/trusted-target-images-mismatch.tmp" \
  "$WORK_DIR/trusted-target-images-mismatch.tsv"
if TEST_TRUSTED_TARGET_IMAGES_FILE="$WORK_DIR/trusted-target-images-mismatch.tsv" \
  run_prune >/dev/null 2>&1; then
  fail "registry drift from trusted target provenance was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "trusted target mismatch was rejected after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
jq \
  --arg trusted_sha "$TARGET_ONE_SHA" \
  --arg failed_sha "$FAILED_TARGET_SHA" '
  ([.data.items[]
    | select(.version == ("oci-auth-" + $trusted_sha))
    | .id][0]) as $trusted_id
  | ([.data.items[]
    | select(.version == ("oci-auth-" + $failed_sha))
    | .id][0]) as $failed_id
  | .data.items |= map(select(
      .id != $trusted_id and .id != $failed_id
    ))
' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
prepare_validation
run_prune
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log")" == "25" ]] ||
  fail "partial batch recovery did not delete every remaining target image"
jq -e '
  .deletion_required == true and
  .present_target_generations == 3 and
  .present_target_images == 25 and
  .unique_images == 52 and
  .unique_image_ids == 52 and
  .tag_rows == 347 and
  .alias_rows == 295
' "$WORK_DIR/evidence/before-summary.json" >/dev/null ||
  fail "partial batch recovery did not record its exact starting state"
[[ "$(
  jq -c '[
    .data.items | length,
    ([.[] | .id] | unique | length),
    ([.[] | .digest] | unique | length)
  ]' "$WORK_DIR/state/images.json"
)" == "[189,27,27]" ]] ||
  fail "partial batch recovery did not retain protected aliases exactly"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
jq --arg current_sha "$CURRENT_SHA" '
  .data.items |= map(select(.version != ("oci-auth-" + $current_sha)))
' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
if run_prune >/dev/null 2>&1; then
  fail "a missing canonical protected source tag was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "missing protected tag rejection happened after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
jq --arg target_sha "$TARGET_ONE_SHA" '
  (.data.items[]
    | select(.version == ("oci-auth-" + $target_sha))) as $source
  | .data.items += [
      $source + {
        version: "oci-bet-1111111111111111111111111111111111111111"
      }
    ]
' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
if run_prune >/dev/null 2>&1; then
  fail "a cross-service alias was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "cross-service alias rejection happened after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
jq --arg target_sha "$TARGET_ONE_SHA" '
  (.data.items[]
    | select(.version == ("oci-auth-" + $target_sha))) as $source
  | .data.items += [
      $source + {
        id: "ocid1.containerimage.oc1..fixture-conflict",
        version: "oci-auth-2222222222222222222222222222222222222222"
      }
    ]
' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
if run_prune >/dev/null 2>&1; then
  fail "one digest mapped to multiple image IDs"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "image ID conflict rejection happened after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
jq --arg target_sha "$TARGET_ONE_SHA" '
  (.data.items[]
    | select(.version == ("oci-auth-" + $target_sha))) as $source
  | .data.items += [
      $source + {
        version: "oci-auth-4444444444444444444444444444444444444444",
        digest: ("sha256:" + ("8" * 64))
      }
    ]
' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
if run_prune >/dev/null 2>&1; then
  fail "one image ID mapped to multiple digests"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "digest conflict rejection happened after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
jq \
  --arg target_one_sha "$TARGET_ONE_SHA" \
  --arg target_two_sha "$TARGET_TWO_SHA" '
    def services: [
      "auth", "backoffice", "bet", "client", "event", "gamemaster",
      "moderation", "resulting", "slip"
    ];
    .data.items as $rows
    | .data.items += [
        range(0; 9) as $service_index
        | (
            if $service_index == 0
            then $target_one_sha
            else $target_two_sha
            end
          ) as $source_sha
        | ($rows[]
          | select(
              .version ==
              ("oci-" + services[$service_index] + "-" + $source_sha)
            )) as $source
        | $source + {
            version: (
              "oci-" + services[$service_index] + "-" +
              "3333333333333333333333333333333333333333"
            )
          }
      ]
  ' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
if run_prune >/dev/null 2>&1; then
  fail "a mixed-generation alias set was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "mixed alias rejection happened after a delete"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
jq '
  .data.items += [{
    id: "ocid1.containerimage.oc1..fixture999",
    "repository-name": "betstan_images",
    version: "oci-auth-9999999999999999999999999999999999999999",
    digest: ("sha256:" + ("9" * 64)),
    "lifecycle-state": "AVAILABLE"
  }]
' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
if run_prune >/dev/null 2>&1; then
  fail "an unknown registry image was accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "unknown-image rejection happened after a delete"

echo "OCI registry prune contract tests passed"
