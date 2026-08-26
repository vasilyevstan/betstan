#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
WORK_DIR="$OCI_DIR/tests/.ghcr-contract-work"
OUTPUT_ROOT="artifacts/.ghcr-contract-work"
CURRENT_SHA=1111111111111111111111111111111111111111
DEPLOYED_SHA=2222222222222222222222222222222222222222
LKG_SHA=3333333333333333333333333333333333333333
OBSOLETE_SHA=4444444444444444444444444444444444444444
SERVICES=(auth bet backoffice client event gamemaster moderation resulting slip)

fail() {
  echo "ghcr contract failure: $*" >&2
  exit 1
}

python3 "$OCI_DIR/tests/test_oci_archive_publisher.py" >/dev/null
python3 "$OCI_DIR/tests/test_legacy_oci_provenance.py" >/dev/null
python3 "$OCI_DIR/tests/test_transition_recovery.py" >/dev/null
python3 "$OCI_DIR/tests/test_public_registry_credentials.py" >/dev/null

rm -rf -- "${WORK_DIR:?}" "$ROOT_DIR/${OUTPUT_ROOT:?}"
mkdir -p "$WORK_DIR/bin" "$WORK_DIR/provenance"
cleanup() { rm -rf -- "${WORK_DIR:?}" "$ROOT_DIR/${OUTPUT_ROOT:?}"; }
trap cleanup EXIT
cat > "$WORK_DIR/bin/gh" <<'SH'
#!/usr/bin/env bash
exit 99
SH
chmod +x "$WORK_DIR/bin/gh"
cat > "$WORK_DIR/bin/docker" <<'SH'
#!/usr/bin/env bash
exit 99
SH
chmod +x "$WORK_DIR/bin/docker"

touch "$WORK_DIR/live.tsv" "$WORK_DIR/trusted.tsv" "$WORK_DIR/platform.tsv" "$WORK_DIR/target-key"
recovery_validation_env=(
  "PATH=$WORK_DIR/bin:$PATH"
  "APPLICATION_REGISTRY_PROVIDER=ghcr"
  "APPLICATION_REGISTRY_HOST=ghcr.io"
  "APPLICATION_REGISTRY_REPOSITORY=vasilyevstan/betstan-images"
  "APPLICATION_REGISTRY_TAG_PREFIX=arm64"
  "APPLICATION_REGISTRY_TAG_SCHEMA=v1"
  "SOURCE_SHA=$CURRENT_SHA"
  "TRUSTED_BUILD_RUN_ID=101"
  "TRUSTED_UPSTREAM_RUN_ID=99"
  "LIVE_IMAGES_FILE=$WORK_DIR/live.tsv"
  "TRUSTED_LEGACY_IMAGES_FILE=$WORK_DIR/trusted.tsv"
  "LIVE_PLATFORM_IDS_FILE=$WORK_DIR/platform.tsv"
  "K3S_SSH_PRIVATE_KEY=$WORK_DIR/target-key"
  "K3S_SSH_PORT=12222"
  "K3S_SSH_HOST_KEY_ALIAS=ocid1.instance.oc1..fixture"
)
if env "${recovery_validation_env[@]}" \
    K3S_SSH_KNOWN_HOSTS="$WORK_DIR/missing-known-hosts" \
    "$OCI_DIR/scripts/recover-k3s-cached-images.sh" >/dev/null 2>&1; then
  fail "recovery accepted a missing dedicated target known-hosts file"
fi
ssh-keygen -q -t ed25519 -N '' -f "$WORK_DIR/fixture-host-key"
read -r key_type key_value _ <"$WORK_DIR/fixture-host-key.pub"
printf 'ocid1.instance.oc1..other %s %s\n' "$key_type" "$key_value" \
  >"$WORK_DIR/wrong-known-hosts"
if env "${recovery_validation_env[@]}" \
    K3S_SSH_KNOWN_HOSTS="$WORK_DIR/wrong-known-hosts" \
    "$OCI_DIR/scripts/recover-k3s-cached-images.sh" >/dev/null 2>&1; then
  fail "recovery accepted a known-hosts file bound to a different instance alias"
fi
printf 'ocid1.instance.oc1..fixture %s %s\n' "$key_type" "$key_value" \
  >"$WORK_DIR/correct-known-hosts"
mkdir -p "$WORK_DIR/unsafe-output"
touch \
  "$WORK_DIR/unsafe-output/live.tsv" \
  "$WORK_DIR/unsafe-output/trusted.tsv" \
  "$WORK_DIR/unsafe-output/platform.tsv"
if env "${recovery_validation_env[@]}" \
    LIVE_IMAGES_FILE="$WORK_DIR/unsafe-output/live.tsv" \
    TRUSTED_LEGACY_IMAGES_FILE="$WORK_DIR/unsafe-output/trusted.tsv" \
    LIVE_PLATFORM_IDS_FILE="$WORK_DIR/unsafe-output/platform.tsv" \
    OUTPUT_DIR="$WORK_DIR/unsafe-output" \
    K3S_SSH_KNOWN_HOSTS="$WORK_DIR/correct-known-hosts" \
    "$OCI_DIR/scripts/recover-k3s-cached-images.sh" \
    >"$WORK_DIR/unsafe-output.stdout" 2>"$WORK_DIR/unsafe-output.stderr"; then
  fail "recovery accepted inputs inside its cleared output directory"
fi
grep -Fq 'cache recovery inputs must be outside the cleared output directory' \
  "$WORK_DIR/unsafe-output.stderr" ||
  fail "recovery did not reject the destructive input/output overlap explicitly"
if env "${recovery_validation_env[@]}" \
    LIVE_IMAGES_FILE="$WORK_DIR/live.tsv" \
    TRUSTED_LEGACY_IMAGES_FILE="$WORK_DIR/live.tsv" \
    OUTPUT_DIR="$OUTPUT_ROOT/recovery-identical-inputs" \
    K3S_SSH_KNOWN_HOSTS="$WORK_DIR/correct-known-hosts" \
    "$OCI_DIR/scripts/recover-k3s-cached-images.sh" \
    >"$WORK_DIR/identical-inputs.stdout" 2>"$WORK_DIR/identical-inputs.stderr"; then
  fail "recovery accepted one file as both live observation and trusted provenance"
fi
grep -Fq 'live and trusted cache evidence must be independent files' \
  "$WORK_DIR/identical-inputs.stderr" ||
  fail "recovery did not explain the independent-evidence requirement"

for index in "${!SERVICES[@]}"; do
  service="${SERVICES[$index]}"
  digest="$(printf 'sha256:%064d' "$((index + 1))")"
  cat > "$WORK_DIR/provenance/$service.env" <<EOF
schema=betstan.application-image-provenance.v1
registry_provider=ghcr
registry_host=ghcr.io
registry_tag_prefix=arm64
registry_tag_schema=v1
service=$service
repository=ghcr.io/vasilyevstan/betstan-images
source_sha=$CURRENT_SHA
tag=ghcr.io/vasilyevstan/betstan-images:arm64-$service-$CURRENT_SHA
digest=$digest
platform_digest=$digest
image_ref=ghcr.io/vasilyevstan/betstan-images@$digest
platform=linux/arm64
build_run_id=101
build_run_attempt=1
build_workflow=oci-production-build
upstream_workflow=production-build
upstream_run_id=99
upstream_run_attempt=1
EOF
done
PROVENANCE_DIR="$WORK_DIR/provenance" SOURCE_SHA="$CURRENT_SHA" \
OUTPUT_FILE="$WORK_DIR/images.tsv" VERIFY_REMOTE=0 BOOT_IMAGES=0 \
  "$OCI_DIR/scripts/verify-images.sh" >/dev/null

for service in "${SERVICES[@]}"; do
  cat >>"$WORK_DIR/provenance/$service.env" <<EOF
recovery_workflow=oci-ghcr-cache-recovery
recovery_run_id=777
recovery_run_attempt=1
recovery_origin=containerd-cache
recovery_origin_repository=fixture.ocir.io/tenant/betstan/$service
recovery_origin_manifest_digest=sha256:$(printf '%064d' 71)
recovery_origin_platform_digest=sha256:$(printf '%064d' 72)
EOF
done
PROVENANCE_DIR="$WORK_DIR/provenance" SOURCE_SHA="$CURRENT_SHA" \
EXPECTED_BUILD_RUN_ID=101 EXPECTED_BUILD_RUN_ATTEMPT=1 \
EXPECTED_UPSTREAM_RUN_ID=99 PROVENANCE_MODE=recovery \
EXPECTED_RECOVERY_RUN_ID=777 EXPECTED_RECOVERY_RUN_ATTEMPT=1 \
OUTPUT_FILE="$WORK_DIR/recovery-images.tsv" VERIFY_REMOTE=0 BOOT_IMAGES=0 \
  "$OCI_DIR/scripts/verify-images.sh" >/dev/null
sed -i.bak 's/^build_run_id=101$/build_run_id=777/' "$WORK_DIR/provenance/auth.env"
if PROVENANCE_DIR="$WORK_DIR/provenance" SOURCE_SHA="$CURRENT_SHA" \
    EXPECTED_BUILD_RUN_ID=101 EXPECTED_BUILD_RUN_ATTEMPT=1 \
    EXPECTED_UPSTREAM_RUN_ID=99 PROVENANCE_MODE=recovery \
    EXPECTED_RECOVERY_RUN_ID=777 EXPECTED_RECOVERY_RUN_ATTEMPT=1 \
    OUTPUT_FILE="$WORK_DIR/rejected-recovery.tsv" VERIFY_REMOTE=0 BOOT_IMAGES=0 \
    "$OCI_DIR/scripts/verify-images.sh" >/dev/null 2>&1; then
  fail "recovery provenance accepted false build lineage"
fi
mv "$WORK_DIR/provenance/auth.env.bak" "$WORK_DIR/provenance/auth.env"

sed 's#ghcr.io/vasilyevstan/betstan-images#docker.io/vasilyevstan/betstan-images#' \
  "$WORK_DIR/provenance/auth.env" > "$WORK_DIR/provenance/auth.env.bad"
mv "$WORK_DIR/provenance/auth.env" "$WORK_DIR/provenance/auth.env.good"
mv "$WORK_DIR/provenance/auth.env.bad" "$WORK_DIR/provenance/auth.env"
if PROVENANCE_DIR="$WORK_DIR/provenance" SOURCE_SHA="$CURRENT_SHA" \
    OUTPUT_FILE="$WORK_DIR/rejected.tsv" VERIFY_REMOTE=0 BOOT_IMAGES=0 \
    "$OCI_DIR/scripts/verify-images.sh" >/dev/null 2>&1; then
  fail "Docker Hub provenance was accepted"
fi
mv "$WORK_DIR/provenance/auth.env.good" "$WORK_DIR/provenance/auth.env"

jq -n --arg current "$CURRENT_SHA" --arg deployed "$DEPLOYED_SHA" --arg lkg "$LKG_SHA" '
  def services: ["auth","bet","backoffice","client","event","gamemaster","moderation","resulting","slip"];
  def generation($sha; $start):
    [range(0; 9) | {
      id: ($start + .),
      name: ("sha256:" + ("0" * 64)),
      metadata: {container: {tags: [("arm64-" + services[.] + "-" + $sha)]}}
    }];
  [{
    id: 1,
    name: ("sha256:" + ("f" * 64)),
    metadata: {container: {tags: ["bootstrap-sentinel-v1"]}}
  }, {
    id: 2,
    name: ("sha256:" + ("e" * 64)),
    metadata: {container: {tags: []}}
  }] + generation($current; 10) + generation($deployed; 20) + generation($lkg; 30)
' > "$WORK_DIR/versions.json"
jq -n '{
  package_type:"container", name:"betstan-images", visibility:"public",
  repository:{full_name:"vasilyevstan/betstan"}
}' > "$WORK_DIR/metadata.json"
PATH="$WORK_DIR/bin:$PATH" \
GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/metadata.json" \
GHCR_VERSIONS_FILE="$WORK_DIR/versions.json" \
CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" PRUNE_MODE=validate \
OUTPUT_DIR="$OUTPUT_ROOT/package-valid" \
  "$OCI_DIR/scripts/manage-ghcr-package.sh" >/dev/null
jq -e '
  .terminal_status == "VALIDATED" and
  .planned_deletions == 0 and
  .untagged_versions == 1 and
  (.generations_sha256 | test("^[0-9a-f]{64}$"))
' \
  "$ROOT_DIR/$OUTPUT_ROOT/package-valid/validation-summary.json" >/dev/null ||
  fail "public package validation did not preserve safe untagged-version evidence"
PATH="$WORK_DIR/bin:$PATH" \
GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/metadata.json" \
GHCR_VERSIONS_FILE="$WORK_DIR/versions.json" \
CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" PRUNE_MODE=apply \
VALIDATED_BEFORE_SUMMARY_FILE="$ROOT_DIR/$OUTPUT_ROOT/package-valid/before-summary.json" \
VALIDATED_PACKAGE_STATE_FILE="$ROOT_DIR/$OUTPUT_ROOT/package-valid/package-state.json" \
VALIDATED_DELETE_IDS_FILE="$ROOT_DIR/$OUTPUT_ROOT/package-valid/planned-delete-version-ids.txt" \
VALIDATED_GENERATIONS_FILE="$ROOT_DIR/$OUTPUT_ROOT/package-valid/generations.tsv" \
OUTPUT_DIR="$OUTPUT_ROOT/package-apply-converged" \
  "$OCI_DIR/scripts/manage-ghcr-package.sh" >/dev/null
jq -e '.terminal_status == "CONVERGED" and .mode == "apply"' \
  "$ROOT_DIR/$OUTPUT_ROOT/package-apply-converged/after-summary.json" >/dev/null ||
  fail "unchanged GHCR validate-to-apply handoff did not converge"

cp \
  "$ROOT_DIR/$OUTPUT_ROOT/package-valid/generations.tsv" \
  "$WORK_DIR/tampered-generations.tsv"
printf '\n' >> "$WORK_DIR/tampered-generations.tsv"
if PATH="$WORK_DIR/bin:$PATH" \
  GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/metadata.json" \
  GHCR_VERSIONS_FILE="$WORK_DIR/versions.json" \
  CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
  LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" PRUNE_MODE=apply \
  VALIDATED_BEFORE_SUMMARY_FILE="$ROOT_DIR/$OUTPUT_ROOT/package-valid/before-summary.json" \
  VALIDATED_PACKAGE_STATE_FILE="$ROOT_DIR/$OUTPUT_ROOT/package-valid/package-state.json" \
  VALIDATED_DELETE_IDS_FILE="$ROOT_DIR/$OUTPUT_ROOT/package-valid/planned-delete-version-ids.txt" \
  VALIDATED_GENERATIONS_FILE="$WORK_DIR/tampered-generations.tsv" \
  OUTPUT_DIR="$OUTPUT_ROOT/package-generations-tampered" \
    "$OCI_DIR/scripts/manage-ghcr-package.sh" \
    >"$WORK_DIR/tampered-generations.stdout" \
    2>"$WORK_DIR/tampered-generations.stderr"; then
  fail "GHCR apply accepted tampered validated generation evidence"
fi
grep -Fq 'validated GHCR deletion plan hashes differ' \
  "$WORK_DIR/tampered-generations.stderr" ||
  fail "GHCR apply did not reject tampered generation evidence by hash"

jq '.visibility = "private"' "$WORK_DIR/metadata.json" > "$WORK_DIR/private.json"
if PATH="$WORK_DIR/bin:$PATH" \
  GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/private.json" \
  GHCR_VERSIONS_FILE="$WORK_DIR/versions.json" \
  CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
  LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" PRUNE_MODE=validate \
  OUTPUT_DIR="$OUTPUT_ROOT/package-private" \
  "$OCI_DIR/scripts/manage-ghcr-package.sh" >/dev/null 2>&1; then
  fail "private GHCR package was accepted"
fi

if PATH="$WORK_DIR/bin:$PATH" \
  GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/metadata.json" \
  GHCR_VERSIONS_FILE="$WORK_DIR/versions.json" \
  CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
  LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" \
  OBSOLETE_GENERATIONS="[{\"sha\":\"$CURRENT_SHA\",\"build_run_id\":\"900\"}]" \
  PRUNE_MODE=validate OUTPUT_DIR="$OUTPUT_ROOT/package-protected" \
  "$OCI_DIR/scripts/manage-ghcr-package.sh" >/dev/null 2>&1; then
  fail "GHCR prune accepted a protected candidate generation"
fi

jq 'del(.[] | select(.metadata.container.tags[0] == ("arm64-slip-" + "'"$LKG_SHA"'")))' \
  "$WORK_DIR/versions.json" > "$WORK_DIR/partial.json"
if PATH="$WORK_DIR/bin:$PATH" \
  GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/metadata.json" \
  GHCR_VERSIONS_FILE="$WORK_DIR/partial.json" \
  CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
  LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" PRUNE_MODE=validate \
  OUTPUT_DIR="$OUTPUT_ROOT/package-partial" \
  "$OCI_DIR/scripts/manage-ghcr-package.sh" >/dev/null 2>&1; then
  fail "GHCR package accepted a partial generation"
fi

jq --arg current "$CURRENT_SHA" --arg obsolete "$OBSOLETE_SHA" '
  map(
    if any(.metadata.container.tags[]?; endswith($current)) then
      .metadata.container.tags += [
        (.metadata.container.tags[] | select(endswith($current)) |
          sub($current + "$"; $obsolete))
      ]
    else
      .
    end
  )
' "$WORK_DIR/versions.json" > "$WORK_DIR/aliased-versions.json"
PATH="$WORK_DIR/bin:$PATH" \
GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/metadata.json" \
GHCR_VERSIONS_FILE="$WORK_DIR/aliased-versions.json" \
CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" \
OBSOLETE_GENERATIONS="[{\"sha\":\"$OBSOLETE_SHA\",\"build_run_id\":\"904\"}]" \
PRUNE_MODE=validate OUTPUT_DIR="$OUTPUT_ROOT/package-alias-valid" \
  "$OCI_DIR/scripts/manage-ghcr-package.sh" >/dev/null
jq -e '
  .terminal_status == "VALIDATED" and
  .planned_deletions == 0 and
  .retained_alias_versions == 9 and
  .obsolete_origins == [{
    build_run_id: "904",
    sha: "'"$OBSOLETE_SHA"'"
  }]
' "$ROOT_DIR/$OUTPUT_ROOT/package-alias-valid/validation-summary.json" >/dev/null ||
  fail "protected reused-image aliases were not retained safely"

jq --arg obsolete "$OBSOLETE_SHA" '
  def services:
    ["auth","bet","backoffice","client","event","gamemaster","moderation","resulting","slip"];
  . + [range(0; 9) | {
    id: (40 + .),
    name: ("sha256:" + ("4" * 64)),
    metadata: {container: {tags: [
      ("arm64-" + services[.] + "-" + $obsolete)
    ]}}
  }]
' "$WORK_DIR/versions.json" > "$WORK_DIR/prunable-versions.json"
PATH="$WORK_DIR/bin:$PATH" \
GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/metadata.json" \
GHCR_VERSIONS_FILE="$WORK_DIR/prunable-versions.json" \
CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" \
OBSOLETE_GENERATIONS="[{\"sha\":\"$OBSOLETE_SHA\",\"build_run_id\":\"904\"}]" \
PRUNE_MODE=validate OUTPUT_DIR="$OUTPUT_ROOT/package-prune-plan" \
  "$OCI_DIR/scripts/manage-ghcr-package.sh" >/dev/null
jq -e '.planned_deletions == 9 and .retained_alias_versions == 0' \
  "$ROOT_DIR/$OUTPUT_ROOT/package-prune-plan/validation-summary.json" >/dev/null ||
  fail "exclusive obsolete generation did not produce a bounded deletion plan"

cat > "$WORK_DIR/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"--method DELETE"* ]]; then
  count_file="${MOCK_DELETE_COUNT_FILE:?}"
  count=0
  [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$count_file"
  if [[ -n "${MOCK_FAIL_DELETE_AT:-}" &&
        "$count" == "$MOCK_FAIL_DELETE_AT" ]]; then
    exit 42
  fi
  version_id="${*: -1}"
  version_id="${version_id##*/}"
  jq --argjson id "$version_id" 'map(select(.id != $id))' \
    "${GHCR_VERSIONS_FILE:?}" > "${GHCR_VERSIONS_FILE}.next"
  mv "${GHCR_VERSIONS_FILE}.next" "$GHCR_VERSIONS_FILE"
  exit 0
fi
exit 99
SH
chmod +x "$WORK_DIR/bin/gh"
prune_plan_dir="$ROOT_DIR/$OUTPUT_ROOT/package-prune-plan"
if PATH="$WORK_DIR/bin:$PATH" \
  MOCK_DELETE_COUNT_FILE="$WORK_DIR/delete-count" MOCK_FAIL_DELETE_AT=4 \
  GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/metadata.json" \
  GHCR_VERSIONS_FILE="$WORK_DIR/prunable-versions.json" \
  CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
  LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" \
  OBSOLETE_GENERATIONS="[{\"sha\":\"$OBSOLETE_SHA\",\"build_run_id\":\"904\"}]" \
  PRUNE_MODE=apply \
  VALIDATED_BEFORE_SUMMARY_FILE="$prune_plan_dir/before-summary.json" \
  VALIDATED_PACKAGE_STATE_FILE="$prune_plan_dir/package-state.json" \
  VALIDATED_DELETE_IDS_FILE="$prune_plan_dir/planned-delete-version-ids.txt" \
  VALIDATED_GENERATIONS_FILE="$prune_plan_dir/generations.tsv" \
  OUTPUT_DIR="$OUTPUT_ROOT/package-prune-interrupted" \
    "$OCI_DIR/scripts/manage-ghcr-package.sh" >/dev/null 2>&1; then
  fail "interrupted GHCR prune falsely reported terminal success"
fi
[[ "$(jq 'length' "$WORK_DIR/prunable-versions.json")" == "35" ]] ||
  fail "interrupted GHCR prune fixture did not preserve a three-deletion prefix"
PATH="$WORK_DIR/bin:$PATH" \
MOCK_DELETE_COUNT_FILE="$WORK_DIR/delete-count" \
GHCR_PACKAGE_METADATA_FILE="$WORK_DIR/metadata.json" \
GHCR_VERSIONS_FILE="$WORK_DIR/prunable-versions.json" \
CURRENT_SOURCE_SHA="$CURRENT_SHA" DEPLOYED_SOURCE_SHA="$DEPLOYED_SHA" \
LAST_KNOWN_GOOD_SOURCE_SHA="$LKG_SHA" \
OBSOLETE_GENERATIONS="[{\"sha\":\"$OBSOLETE_SHA\",\"build_run_id\":\"904\"}]" \
PRUNE_MODE=apply \
VALIDATED_BEFORE_SUMMARY_FILE="$prune_plan_dir/before-summary.json" \
VALIDATED_PACKAGE_STATE_FILE="$prune_plan_dir/package-state.json" \
VALIDATED_DELETE_IDS_FILE="$prune_plan_dir/planned-delete-version-ids.txt" \
VALIDATED_GENERATIONS_FILE="$prune_plan_dir/generations.tsv" \
OUTPUT_DIR="$OUTPUT_ROOT/package-prune-resumed" \
  "$OCI_DIR/scripts/manage-ghcr-package.sh" >/dev/null
jq -e '
  .terminal_status == "PRUNED" and
  .already_absent_planned_versions == 3 and
  .deleted_in_run == 6 and
  .terminal_total_versions == 29
' "$ROOT_DIR/$OUTPUT_ROOT/package-prune-resumed/after-summary.json" >/dev/null ||
  fail "resumed GHCR prune did not prove its terminal package state"
if jq -e --arg obsolete "$OBSOLETE_SHA" '
    any(.[].metadata.container.tags[]?; endswith($obsolete))
  ' "$WORK_DIR/prunable-versions.json" >/dev/null; then
  fail "resumed GHCR prune left an obsolete generation tag"
fi

cat >"$WORK_DIR/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

state="${MOCK_DOCKER_STATE:?}"
tags="$state/tags.tsv"
mkdir -p "$state"
touch "$tags"

tag_digest() {
  awk -F '\t' -v tag="$1" '$1 == tag { count++; value=$2 } END {
    if (count != 1) exit 1
    print value
  }' "$tags"
}

platform_digest() {
  awk -F '\t' -v digest="$1" '
    $2 == digest && NF >= 3 { seen[$3] = 1; value=$3 }
    END {
      for (item in seen) count++
      if (count != 1) exit 1
      print value
    }
  ' "$tags"
}

if [[ "$1" == "buildx" && "$2" == "build" ]]; then
  metadata=""
  shift 2
  while (($#)); do
    if [[ "$1" == "--metadata-file" ]]; then
      metadata="$2"
      shift 2
    else
      shift
    fi
  done
  [[ -n "$metadata" ]]
  service="$(basename "$metadata" .metadata.json)"
  case "$service" in
    auth) index=1 ;;
    bet) index=2 ;;
    backoffice) index=3 ;;
    client) index=4 ;;
    event) index=5 ;;
    gamemaster) index=6 ;;
    moderation) index=7 ;;
    resulting) index=8 ;;
    slip) index=9 ;;
    *) exit 1 ;;
  esac
  digest="sha256:$(printf '%064d' "$index")"
  jq -n --arg digest "$digest" '{"containerimage.digest":$digest}' >"$metadata"
  exit 0
fi

if [[ "$1" == "buildx" && "$2" == "imagetools" && "$3" == "inspect" ]]; then
  ref="$4"
  arguments="$*"
  if [[ "$ref" == *":arm64-"* ]]; then
    digest="$(tag_digest "$ref")" || {
      echo "manifest unknown" >&2
      exit 1
    }
  else
    digest="${ref##*@}"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
  fi
  if [[ "$arguments" == *"--raw"* ]]; then
    if observed_platform="$(platform_digest "$digest")" &&
        [[ "$observed_platform" != "$digest" ]]; then
      jq -n --arg digest "$observed_platform" '{
        manifests:[{
          platform:{os:"linux", architecture:"arm64"},
          digest:$digest
        }]
      }'
    else
      echo '{}'
    fi
  elif [[ "$arguments" == *".Image.OS"* ]]; then
    echo 'linux/arm64'
  elif [[ "$arguments" == *".Manifest.Digest"* ]]; then
    echo "$digest"
  else
    echo '{}'
  fi
  exit 0
fi

if [[ "$1" == "buildx" && "$2" == "imagetools" && "$3" == "create" ]]; then
  shift 3
  tag=""
  ref=""
  while (($#)); do
    case "$1" in
      --prefer-index=false)
        shift
        ;;
      --tag)
        tag="$2"
        shift 2
        ;;
      *)
        ref="$1"
        shift
        ;;
    esac
  done
  [[ -n "$tag" && "$ref" == *@sha256:* ]]
  digest="${ref##*@}"
  awk -F '\t' -v tag="$tag" '$1 != tag' "$tags" >"$tags.next"
  printf '%s\t%s\t%s\n' "$tag" "$digest" "$digest" >>"$tags.next"
  mv "$tags.next" "$tags"
  exit 0
fi

exit 99
SH
chmod +x "$WORK_DIR/bin/docker"

build_env=(
  "PATH=$WORK_DIR/bin:$PATH"
  "MOCK_DOCKER_STATE=$WORK_DIR/docker-state"
  "APPLICATION_REGISTRY_PROVIDER=ghcr"
  "APPLICATION_REGISTRY_HOST=ghcr.io"
  "APPLICATION_REGISTRY_REPOSITORY=vasilyevstan/betstan-images"
  "APPLICATION_REGISTRY_TAG_PREFIX=arm64"
  "APPLICATION_REGISTRY_TAG_SCHEMA=v1"
  "APPLICATION_REGISTRY_ALREADY_AUTHENTICATED=true"
  "GITHUB_REPOSITORY=vasilyevstan/betstan"
  "GITHUB_RUN_ID=501"
  "GITHUB_RUN_ATTEMPT=1"
  "UPSTREAM_RUN_ID=401"
  "UPSTREAM_RUN_ATTEMPT=1"
  "REPAIR_EXISTING_TAGS=1"
  "SOURCE_DATE_EPOCH=1700000000"
)
mkdir -p "$WORK_DIR/docker-state"
printf 'ghcr.io/vasilyevstan/betstan-images:arm64-auth-%s\tsha256:%064d\tsha256:%064d\n' \
  "$CURRENT_SHA" 99 1 >"$WORK_DIR/docker-state/tags.tsv"
env "${build_env[@]}" SOURCE_SHA="$CURRENT_SHA" PUSH_IMAGES=1 \
  OUTPUT_DIR="$WORK_DIR/repaired-build" \
  "$OCI_DIR/scripts/build-images.sh" >/dev/null
[[ "$(awk 'END { print NR }' "$WORK_DIR/docker-state/tags.tsv")" == "9" ]] ||
  fail "partial GHCR repair did not complete the nine exact tags"
[[ "$(find "$WORK_DIR/repaired-build" -name '*.env' | wc -l | tr -d ' ')" == "9" ]] ||
  fail "partial GHCR repair did not emit complete first-attempt provenance"
grep -Fq 'digest=sha256:0000000000000000000000000000000000000000000000000000000000000099' \
  "$WORK_DIR/repaired-build/auth.env" ||
  fail "partial GHCR repair did not preserve the verified existing manifest identity"

printf 'ghcr.io/vasilyevstan/betstan-images:arm64-auth-%s\tsha256:%064d\tsha256:%064d\n' \
  "$CURRENT_SHA" 99 98 >"$WORK_DIR/docker-state/tags.tsv"
if env "${build_env[@]}" SOURCE_SHA="$CURRENT_SHA" PUSH_IMAGES=1 \
    OUTPUT_DIR="$WORK_DIR/rejected-build-repair" \
    "$OCI_DIR/scripts/build-images.sh" >/dev/null 2>&1; then
  fail "partial GHCR repair adopted an existing tag with a different rebuilt platform"
fi

grep -Fq 'ANONYMOUS_PULL=1' "$ROOT_DIR/.github/workflows/oci-production-build.yml" ||
  fail "build workflow lacks anonymous public pull proof"
for literal in \
  'options: [bootstrap, validate, prune, repair-build]' \
  'REPAIR PARTIAL GHCR BUILD' \
  '.conclusion == "failure"' \
  'Record exact partial-build repair authorization' \
  'schema=betstan.ghcr-build-repair.v1' \
  'workflows: ["production-build", "ghcr-package-management"]' \
  'ghcr-package-management-repair-build-${TRIGGER_RUN_ID}-1' \
  'existing GHCR exact tag differs from the rebuilt ARM64 platform' \
  'push-by-digest=true' \
  'rewrite-timestamp=true' \
  'compatibility-version=20' \
  'compression-level=6' \
  '--build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"'; do
  if [[ "$literal" == 'existing GHCR exact tag differs from the rebuilt ARM64 platform' ||
        "$literal" == 'push-by-digest=true' ||
        "$literal" == 'rewrite-timestamp=true' ||
        "$literal" == 'compatibility-version=20' ||
        "$literal" == 'compression-level=6' ||
        "$literal" == '--build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"' ]]; then
    target="$OCI_DIR/scripts/build-images.sh"
  elif [[ "$literal" == 'workflows: ["production-build", "ghcr-package-management"]' ||
          "$literal" == 'ghcr-package-management-repair-build-${TRIGGER_RUN_ID}-1' ]]; then
    target="$ROOT_DIR/.github/workflows/oci-production-build.yml"
  else
    target="$ROOT_DIR/.github/workflows/ghcr-package-management.yml"
  fi
  grep -Fq -- "$literal" "$target" ||
    fail "partial GHCR candidate publication lacks first-attempt repair authority: $literal"
done
grep -Fq 'create secret generic ocir-pull' "$OCI_DIR/scripts/deploy.sh" &&
  fail "forward deploy still creates an OCIR pull secret"
grep -Fq 'containerd-cache' "$OCI_DIR/scripts/recover-k3s-cached-images.sh" ||
  fail "exact cached-image recovery path is missing"
grep -Fq 'push-oci-archive-to-ghcr.py' "$OCI_DIR/scripts/recover-k3s-cached-images.sh" ||
  fail "cache recovery does not use the exact OCI archive publisher"
grep -Fq 'sudo k3s ctr -n k8s.io images export $remote_archive_q $remote_ref' \
  "$OCI_DIR/scripts/recover-k3s-cached-images.sh" ||
  fail "cache recovery does not stage the exact image reference on the node"
! grep -Eq 'ctr -n k8s\.io images export -([[:space:]]|")' \
  "$OCI_DIR/scripts/recover-k3s-cached-images.sh" ||
  fail "cache recovery uses the truncating ctr stdout export path"
for literal in \
  'sudo install -o root -g root -m 600 /dev/null $remote_archive_q' \
  "grep -qx '0:0:600'" \
  'sudo tar -tf $remote_archive_q' \
  'sudo sha256sum $remote_archive_q' \
  'sudo cat -- $remote_archive_q' \
  'local_size" == "$remote_size' \
  'local_sha256" == "$remote_sha256' \
  'cleanup_remote_archive' \
  'archive-transfers.tsv' \
  '-o ServerAliveCountMax=3' \
  '-o ServerAliveInterval=30'; do
  grep -Fq -- "$literal" "$OCI_DIR/scripts/recover-k3s-cached-images.sh" ||
    fail "cache recovery lacks staged archive transfer contract: $literal"
done
if grep -Eq 'docker (load|tag|push)' "$OCI_DIR/scripts/recover-k3s-cached-images.sh"; then
  fail "cache recovery still depends on digest-changing Docker conversion"
fi
grep -Fq 'group: oci-control-plane' \
  "$ROOT_DIR/.github/workflows/ghcr-package-management.yml" ||
  fail "GHCR package mutations do not share production control-plane concurrency"
grep -A8 -F 'name: Validate then apply explicit package-generation prune' \
  "$ROOT_DIR/.github/workflows/ghcr-package-management.yml" |
  grep -Fq 'GH_TOKEN: ${{ secrets.GHCR_PACKAGE_ADMIN_TOKEN || github.token }}' ||
  fail "GHCR package validation/prune does not authenticate GitHub API calls"
for literal in \
  'actions/workflows/ghcr-package-management.yml' \
  '.path == ".github/workflows/ghcr-package-management.yml"' \
  '.event == "workflow_dispatch"' \
  '.head_sha == $sha' \
  '.head_branch == "master"' \
  '.status == "completed"' \
  '.conclusion == "success"' \
  '.run_attempt == 1' \
  '.display_title == $title' \
  'validation_artifact_count' \
  'Verify exact read-only package validation evidence' \
  '.terminal_status == "VALIDATED"' \
  '.mode == "validate"' \
  'del(.terminal_status)' \
  'sort_by(.sha)[] | [.sha, .build_run_id] | @tsv' \
  '"obsolete-$obsolete_sha"' \
  'VALIDATED_PACKAGE_STATE_FILE:' \
  '.package_state_sha256' \
  '.generations_sha256'; do
  grep -Fq "$literal" "$ROOT_DIR/.github/workflows/ghcr-package-management.yml" ||
    fail "GHCR prune lacks authenticated validation contract: $literal"
done
for literal in \
  'retained_alias_versions' \
  'GHCR package gained versions after validation' \
  'validated GHCR deletion plan would remove a protected alias' \
  'terminal-package-state.json' \
  'terminal GHCR state does not equal the validated state minus the deletion plan'; do
  grep -Fq "$literal" "$OCI_DIR/scripts/manage-ghcr-package.sh" ||
    fail "GHCR prune lacks alias-safe resumable terminal verification: $literal"
done
for literal in \
  'deployed_recovery_run_id:' \
  'deployed_deploy_run_id:' \
  'last_known_good_recovery_run_id:' \
  'last_known_good_deploy_run_id:' \
  'require_one_generation_origin' \
  'validate_recovery()' \
  'validate_deploy()' \
  '.path == ".github/workflows/oci-ghcr-cache-recovery.yml"' \
  'artifact_name="ghcr-cache-recovery-${source_sha}-${run_id}-1"' \
  'PROVENANCE_MODE=recovery EXPECTED_RECOVERY_RUN_ID="$run_id"' \
  'VERIFY_REMOTE=1 BOOT_IMAGES=0 ANONYMOUS_PULL=1'; do
  grep -Fq "$literal" "$ROOT_DIR/.github/workflows/ghcr-package-management.yml" ||
    fail "GHCR protected generation lacks truthful build/recovery authority: $literal"
done
qemu_image='tonistiigi/binfmt@sha256:8db0f28060565399642110b798c6c35efcac7c5b3b48c56d36503d3b4d8f93c8'
for workflow in \
  "$ROOT_DIR/.github/workflows/oci-production-build.yml" \
  "$ROOT_DIR/.github/workflows/oci-ghcr-cache-recovery.yml"; do
  grep -Fq "image: $qemu_image" "$workflow" ||
    fail "privileged QEMU helper image is not pinned by reviewed digest in $workflow"
  ! grep -Eq 'image:[[:space:]]+tonistiigi/binfmt:(latest|[A-Za-z0-9._-]+)' "$workflow" ||
    fail "privileged QEMU helper image uses a mutable tag in $workflow"
done
for literal in \
  'K3S_SSH_KNOWN_HOSTS' \
  'K3S_SSH_HOST_KEY_ALIAS' \
  'ssh-keygen -F "$K3S_SSH_HOST_KEY_ALIAS" -f "$K3S_SSH_KNOWN_HOSTS"' \
  '-o UserKnownHostsFile="$K3S_SSH_KNOWN_HOSTS"' \
  '-o HostKeyAlias="$K3S_SSH_HOST_KEY_ALIAS"' \
  '-o StrictHostKeyChecking=yes' \
  'build_run_id=%s\nbuild_run_attempt=1' \
  'PROVENANCE_MODE=recovery'; do
  grep -Fq -- "$literal" "$OCI_DIR/scripts/recover-k3s-cached-images.sh" ||
    fail "cache recovery lacks required host or truthful lineage guard: $literal"
done
grep -Fq 'K3S_SSH_KNOWN_HOSTS="$target_known_hosts"' \
  "$ROOT_DIR/.github/workflows/oci-ghcr-cache-recovery.yml" ||
  fail "recovery workflow does not pass the protected target known-hosts file"
grep -Fq 'K3S_SSH_HOST_KEY_ALIAS="$instance_ocid"' \
  "$ROOT_DIR/.github/workflows/oci-ghcr-cache-recovery.yml" ||
  fail "recovery workflow does not pass the exact instance OCID host-key alias"
for literal in \
  'input_dir=artifacts/ghcr-cache-recovery-inputs' \
  'LIVE_IMAGES_FILE: artifacts/ghcr-cache-recovery-inputs/live-images.tsv' \
  'OUTPUT_DIR: artifacts/ghcr-cache-recovery' \
  'resume_recovery_run_id:' \
  'Download immutable pre-rebind plan selected for resume' \
  'Capture immutable plan before any Deployment mutation' \
  'Upload immutable pre-rebind plan before rollout' \
  'TRANSITION_PHASE: plan' \
  'Require post-transition API, queue, and rollback readiness' \
  './infra/oci/scripts/rollback-readiness-stan.sh' \
  'public-validate:' \
  'retire-ocir:' \
  'TRANSITION_PHASE: retire' \
  'RETIRE_OCIR_REPOSITORY: "1"' \
  'OCI_ALLOW_LEGACY_ADMIN_UI: "1"' \
  './infra/oci/agents/validation-loop-stan.sh'; do
  grep -Fq -- "$literal" "$ROOT_DIR/.github/workflows/oci-ghcr-cache-recovery.yml" ||
    fail "recovery workflow lacks resumable inputs or terminal health validation: $literal"
done
grep -Fq 'Sequentially rebind verified GHCR digests' \
  "$ROOT_DIR/.github/workflows/oci-ghcr-cache-recovery.yml" ||
  fail "recovery workflow does not protect the post-verification GHCR transition"
for file in \
  "$OCI_DIR/scripts/manage-ghcr-package.sh" \
  "$ROOT_DIR/.github/workflows/ghcr-package-management.yml"; do
  grep -Fq 'users/' "$file" ||
    fail "GHCR package API does not use a supported user-owner route in $file"
  ! grep -Eq 'repos/[^[:space:]"]+/packages/container|repos/\$[A-Z_]+/packages/container' "$file" ||
    fail "GHCR package API still uses a nonexistent repository-scoped route in $file"
done
grep -Fq '.github/workflows/ghcr-package-management.yml' \
  "$ROOT_DIR/.github/workflows/oci-validate.yml" ||
  fail "OCI pull-request lint omits the production-capable GHCR package workflow"
grep -A8 -F 'name: Record exact partial-build repair authorization' \
  "$ROOT_DIR/.github/workflows/ghcr-package-management.yml" |
  grep -Fq 'mkdir -p "$OUTPUT_DIR"' ||
  fail "partial-build repair writes evidence before creating its output directory"
grep -Fq "inputs.phase == 'prune'" \
  "$ROOT_DIR/.github/workflows/ghcr-package-management.yml" ||
  fail "GHCR prune does not set up Buildx before public manifest inspection"
grep -Fq 'secrets.GHCR_PACKAGE_ADMIN_TOKEN || github.token' \
  "$ROOT_DIR/.github/workflows/ghcr-package-management.yml" ||
  fail "account-scoped package administration lacks the bounded token fallback"
deployment_safety_ci="$ROOT_DIR/infra/azure/agents/test-deployment-safety-ci-stan.sh"
for literal in \
  'GHCR_CONTRACT_TEST="$ROOT_DIR/infra/oci/tests/test-ghcr-contract.sh"' \
  '"$GHCR_CONTRACT_TEST"'; do
  grep -Fq -- "$literal" "$deployment_safety_ci" ||
    fail "trusted deployment-safety entrypoint omits GHCR validation: $literal"
done
grep -Fq './infra/azure/agents/test-deployment-safety-ci-stan.sh' \
  "$ROOT_DIR/.github/workflows/production-build.yml" ||
  fail "trusted production quality workflow omits its deployment-safety entrypoint"
grep -Fq './infra/oci/tests/run-contracts.sh' \
  "$ROOT_DIR/.github/workflows/oci-validate.yml" ||
  fail "OCI pull-request validation omits the complete contract entrypoint"
for literal in \
  'transition_plan_state_sha256' \
  'TRANSITION_PHASE must be plan, rebind, or retire' \
  'betstan.ghcr-cache-transition-plan.v1' \
  'plan_origin_recovery_run_id' \
  'plan_carrier_recovery_run_id' \
  'a fresh transition plan requires all nine deployments on the OCIR baseline' \
  'credential_retirement=pending' \
  'credential_retirement=pass' \
  'ocir_repository_retirement=pass' \
  'kubectl delete secret ocir-pull' \
  '(.imagePullSecrets // []) == [{"name":"ocir-pull"}]' \
  'transition_state=already-ghcr' \
  'pending rebinding requires the exact OCIR pull credential to remain intact' \
  'kubectl rollout status'; do
  grep -Fq -- "$literal" "$OCI_DIR/scripts/transition-k3s-cached-images.sh" ||
    fail "transition operator lacks one-time recovery safety: $literal"
done
python3 - "$OCI_DIR/scripts/transition-k3s-cached-images.sh" <<'PY'
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
if text.index("while IFS=$'\\t' read -r service") > text.index(
    "kubectl patch serviceaccount default"
):
    raise SystemExit("OCIR credentials could be retired before all service transitions")
if "pending rebinding requires the exact OCIR pull credential to remain intact" not in text:
    raise SystemExit("partial transition resume does not fail closed on missing credentials")
if "default service account has an unexpected imagePullSecrets state" not in text:
    raise SystemExit("mixed pull credentials are not fail-closed")
capture = 'oci_rabbitmq_queue_rows <"$queue_raw"'
rollout = "while IFS=$'\\t' read -r service _old_ref image_ref"
if text.count(capture) != 1 or text.index(capture) > text.index(rollout):
    raise SystemExit("RabbitMQ rollback baseline is not captured exactly once before rebinding")
for artifact in ("transition-plan.tsv", "rabbitmq-baseline.txt",
                 "transition-plan-evidence.env"):
    if artifact not in text:
        raise SystemExit(f"recovery transition omits immutable plan artifact: {artifact}")

root = Path(sys.argv[1]).parents[3]
workflow = root / ".github/workflows/oci-ghcr-cache-recovery.yml"
workflow_text = workflow.read_text(encoding="utf-8")
if workflow_text.index("Upload immutable pre-rebind plan before rollout") > workflow_text.index(
    "Sequentially rebind verified GHCR digests"
):
    raise SystemExit("pre-rebind plan is not uploaded before Deployment mutation")
if workflow_text.index("public-validate:") > workflow_text.index("retire-ocir:"):
    raise SystemExit("OCIR retirement is not deferred until public validation")
public_validation = workflow_text.split("  public-validate:", 1)[1].split(
    "  retire-ocir:", 1
)[0]
if public_validation.count('OCI_ALLOW_LEGACY_ADMIN_UI: "1"') != 1:
    raise SystemExit("historical baseline UI compatibility is not scoped to public validation")
smoke = root / "infra/oci/agents/oci-live-smoke.spec.js"
smoke_text = smoke.read_text(encoding="utf-8")
if "process.env.OCI_ALLOW_LEGACY_ADMIN_UI === '1'" not in smoke_text:
    raise SystemExit("browser smoke does not consume the historical UI compatibility control")
if "if (!allowLegacyAdminUi)" not in smoke_text:
    raise SystemExit("browser smoke does not default to strict Backoffice authorization")
if 'needs: [recover, public-validate]' not in workflow_text:
    raise SystemExit("OCIR retirement does not depend on successful public validation")
if 'validate_run oci-infrastructure.yml "$INFRASTRUCTURE_RUN_ID" workflow_dispatch \\\n            "$SOURCE_SHA"' not in workflow_text:
    raise SystemExit("cache recovery is not bound to baseline infrastructure provenance")

build_workflow = workflow.parent / "oci-production-build.yml"
build_text = build_workflow.read_text(encoding="utf-8")
if build_text.index("Set up Docker Buildx for public package preflight") > build_text.index(
    "Require a pre-existing public GHCR package"
):
    raise SystemExit("OCI build inspects GHCR before Buildx is initialized")

package_workflow = workflow.parent / "ghcr-package-management.yml"
package_text = package_workflow.read_text(encoding="utf-8")
setup = package_text.index("name: Set up Docker Buildx")
preflight = package_text.index("name: Verify public package metadata")
if setup > preflight or "inputs.phase == 'prune'" not in package_text[setup:preflight]:
    raise SystemExit("package pruning inspects GHCR without a Buildx setup")

verify = Path(sys.argv[1]).parent / "verify-images.sh"
verify_text = verify.read_text(encoding="utf-8")
if verify_text.index("trap cleanup_anonymous_docker_config EXIT") > verify_text.index(
    "docker buildx imagetools inspect"
):
    raise SystemExit("anonymous Docker config cleanup is registered too late")
PY

echo "ghcr_contract=PASS"
