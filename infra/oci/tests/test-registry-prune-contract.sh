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
            | {
                id: (
                  "ocid1.containerimage.oc1..fixture" +
                  pad(($generation[1] * 9) + $service_index + 1; 3)
                ),
                "repository-name": "betstan_images",
                version: (
                  "oci-\(services[$service_index])-\($generation[0])"
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
    cat "${MOCK_OCI_STATE:?}/images.json"
    ;;
  "artifacts container repository list "*)
    image_count="$(
      jq '[.data.items[].digest] | unique | length' \
        "${MOCK_OCI_STATE:?}/images.json"
    )"
    jq -n --argjson image_count "$image_count" '{
      data: {
        items: [{
          "display-name": "betstan_images",
          "image-count": $image_count,
          "layers-size-in-bytes": 300000000
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

  env \
    PATH="$WORK_DIR/bin:$PATH" \
    MOCK_OCI_LOG="$WORK_DIR/oci.log" \
    MOCK_OCI_STATE="$WORK_DIR/state" \
    OCI_CLI_VERSION=3.90.0 \
    OCI_COMPARTMENT_OCID=ocid1.compartment.oc1..fixture \
    OCI_IMAGE_PREFIX=betstan \
    OCI_REGISTRY_MAX_BYTES=500000000 \
    TARGET_SOURCE_SHAS_FILE="$WORK_DIR/target-source-shas.txt" \
    TRUSTED_TARGET_IMAGES_FILE="$trusted_target_file" \
    PROTECTED_IMAGES_FILE="$protected_file" \
    CURRENT_SOURCE_SHA="$CURRENT_SHA" \
    OUTPUT_DIR="$WORK_DIR/evidence" \
    PRUNE_POLL_ATTEMPTS=1 \
    PRUNE_POLL_SECONDS=0 \
    "$OCI_DIR/scripts/prune-registry-generation.sh"
}

: > "$WORK_DIR/oci.log"
run_prune
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log")" == "27" ]] ||
  fail "batch prune did not delete exactly three complete generations"
jq -e \
  --arg one "$TARGET_ONE_SHA" \
  --arg two "$TARGET_TWO_SHA" \
  --arg failed "$FAILED_TARGET_SHA" '
    .terminal_status == "PRUNED" and
    .target_source_shas == [$one, $two, $failed] and
    .requested_target_generations == 3 and
    .pruned_target_generations == 3 and
    .unique_images == 27
  ' "$WORK_DIR/evidence/after-summary.json" >/dev/null ||
  fail "batch prune did not emit terminal evidence"
[[ "$(wc -l < "$WORK_DIR/evidence/deleted-images.tsv" | tr -d ' ')" == "27" ]] ||
  fail "batch prune evidence does not contain 27 deleted service images"
[[ "$(
  jq -c '[.data.items | length, ([.[] | .digest] | unique | length)]' \
    "$WORK_DIR/state/images.json"
)" == "[27,27]" ]] ||
  fail "batch prune did not retain exactly three complete generations"

rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
run_prune
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "an already-pruned target generation was deleted again"
jq -e '
  .deletion_required == false and
  .present_target_generations == 0 and
  .unique_images == 27
' "$WORK_DIR/evidence/before-summary.json" >/dev/null ||
  fail "an already-pruned batch was not resumed idempotently"

cp "$WORK_DIR/state/images-original.json" "$WORK_DIR/state/images.json"
rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
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
  .data.items |= (
    map(select(
      .version != ("oci-auth-" + $trusted_sha) and
      .version != ("oci-auth-" + $failed_sha)
    ))
  )
' "$WORK_DIR/state/images.json" > "$WORK_DIR/state/images.json.tmp"
mv "$WORK_DIR/state/images.json.tmp" "$WORK_DIR/state/images.json"
run_prune
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log")" == "25" ]] ||
  fail "partial batch recovery did not delete every remaining target image"
jq -e '
  .deletion_required == true and
  .present_target_generations == 3 and
  .present_target_images == 25 and
  .unique_images == 52
' "$WORK_DIR/evidence/before-summary.json" >/dev/null ||
  fail "partial batch recovery did not record its exact starting state"
[[ "$(jq '[.data.items[]] | length' "$WORK_DIR/state/images.json")" == "27" ]] ||
  fail "partial batch recovery did not retain exactly the protected images"

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
