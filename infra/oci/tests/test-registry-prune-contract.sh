#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
WORK_DIR="$OCI_DIR/tests/.registry-prune-work"
SERVICES=(auth backoffice bet client event gamemaster moderation resulting slip)
TARGET_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DEPLOYED_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
ROLLBACK_SHA="cccccccccccccccccccccccccccccccccccccccc"
CURRENT_SHA="dddddddddddddddddddddddddddddddddddddddd"
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
  local source_sha="$1"
  local generation="$2"
  local output_file="$3"
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

write_generation "$TARGET_SHA" 0 "$WORK_DIR/target.tsv"
write_generation "$DEPLOYED_SHA" 1 "$WORK_DIR/deployed.tsv"
write_generation "$ROLLBACK_SHA" 2 "$WORK_DIR/rollback.tsv"
write_generation "$CURRENT_SHA" 3 "$WORK_DIR/current.tsv"
cat \
  "$WORK_DIR/current.tsv" \
  "$WORK_DIR/deployed.tsv" \
  "$WORK_DIR/rollback.tsv" \
  > "$WORK_DIR/protected.tsv"

jq -n \
  --arg target_sha "$TARGET_SHA" \
  --arg deployed_sha "$DEPLOYED_SHA" \
  --arg rollback_sha "$ROLLBACK_SHA" \
  --arg current_sha "$CURRENT_SHA" '
    def services: [
      "auth", "backoffice", "bet", "client", "event", "gamemaster",
      "moderation", "resulting", "slip"
    ];
    def pad($value; $width):
      ($value | tostring) as $text
      | ("0" * ($width - ($text | length))) + $text;
    [
      [$target_sha, 0],
      [$deployed_sha, 1],
      [$rollback_sha, 2],
      [$current_sha, 3]
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
  env \
    PATH="$WORK_DIR/bin:$PATH" \
    MOCK_OCI_LOG="$WORK_DIR/oci.log" \
    MOCK_OCI_STATE="$WORK_DIR/state" \
    OCI_CLI_VERSION=3.90.0 \
    OCI_COMPARTMENT_OCID=ocid1.compartment.oc1..fixture \
    OCI_REGISTRY_HOST=fra.ocir.io \
    OCI_REGISTRY_NAMESPACE=example \
    OCI_IMAGE_PREFIX=betstan \
    OCI_REGISTRY_MAX_BYTES=500000000 \
    TARGET_IMAGES_FILE="$WORK_DIR/target.tsv" \
    PROTECTED_IMAGES_FILE="$WORK_DIR/protected.tsv" \
    TARGET_SOURCE_SHA="$TARGET_SHA" \
    CURRENT_SOURCE_SHA="$CURRENT_SHA" \
    OUTPUT_DIR="$WORK_DIR/evidence" \
    PRUNE_POLL_ATTEMPTS=1 \
    PRUNE_POLL_SECONDS=0 \
    "$OCI_DIR/scripts/prune-registry-generation.sh"
}

run_prune
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log")" == "9" ]] ||
  fail "prune did not delete exactly one complete generation"
jq -e '
  .terminal_status == "PRUNED" and
  .unique_images == 27
' "$WORK_DIR/evidence/after-summary.json" >/dev/null ||
  fail "prune did not emit terminal evidence"
[[ "$(wc -l < "$WORK_DIR/evidence/deleted-images.tsv" | tr -d ' ')" == "9" ]] ||
  fail "prune evidence does not contain nine deleted service images"
[[ "$(
  jq -c '[.data.items | length, ([.[] | .digest] | unique | length)]' \
    "$WORK_DIR/state/images.json"
)" == "[27,27]" ]] ||
  fail "prune did not retain exactly three complete generations"

rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
run_prune
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "an already-pruned generation was deleted again"
jq -e '
  .deletion_required == false and
  .unique_images == 27
' "$WORK_DIR/evidence/before-summary.json" >/dev/null ||
  fail "an already-pruned generation was not resumed idempotently"

rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
cp "$WORK_DIR/current.tsv" "$WORK_DIR/protected-overlap.tsv"
cat \
  "$WORK_DIR/deployed.tsv" \
  "$WORK_DIR/target.tsv" \
  >> "$WORK_DIR/protected-overlap.tsv"
if env \
  PATH="$WORK_DIR/bin:$PATH" \
  MOCK_OCI_LOG="$WORK_DIR/oci.log" \
  MOCK_OCI_STATE="$WORK_DIR/state" \
  OCI_CLI_VERSION=3.90.0 \
  OCI_COMPARTMENT_OCID=ocid1.compartment.oc1..fixture \
  OCI_REGISTRY_HOST=fra.ocir.io \
  OCI_REGISTRY_NAMESPACE=example \
  OCI_IMAGE_PREFIX=betstan \
  OCI_REGISTRY_MAX_BYTES=500000000 \
  TARGET_IMAGES_FILE="$WORK_DIR/target.tsv" \
  PROTECTED_IMAGES_FILE="$WORK_DIR/protected-overlap.tsv" \
  TARGET_SOURCE_SHA="$TARGET_SHA" \
  CURRENT_SOURCE_SHA="$CURRENT_SHA" \
  OUTPUT_DIR="$WORK_DIR/evidence" \
  PRUNE_POLL_ATTEMPTS=1 \
  PRUNE_POLL_SECONDS=0 \
  "$OCI_DIR/scripts/prune-registry-generation.sh" >/dev/null 2>&1; then
  fail "overlapping protected and target generations were accepted"
fi
[[ "$(grep -c '^artifacts container image delete ' "$WORK_DIR/oci.log" || true)" == "0" ]] ||
  fail "overlap rejection happened after a delete"

rm -rf "$WORK_DIR/evidence"
: > "$WORK_DIR/oci.log"
jq '
  .data.items += [{
    id: "ocid1.containerimage.oc1..fixture999",
    "repository-name": "betstan_images",
    version: "oci-auth-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    digest: ("sha256:" + ("f" * 64)),
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
