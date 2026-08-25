#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=application-registry.sh
source "$SCRIPT_DIR/application-registry.sh"

REPO="${REPO:-${GITHUB_REPOSITORY:-vasilyevstan/betstan}}"
PACKAGE_NAME="${PACKAGE_NAME:-betstan-images}"
PACKAGE_OWNER="${REPO%%/*}"
PACKAGE_API="users/$PACKAGE_OWNER/packages/container/$PACKAGE_NAME"
PRUNE_MODE="${PRUNE_MODE:-validate}"
CURRENT_SOURCE_SHA="${CURRENT_SOURCE_SHA:-}"
DEPLOYED_SOURCE_SHA="${DEPLOYED_SOURCE_SHA:-}"
LAST_KNOWN_GOOD_SOURCE_SHA="${LAST_KNOWN_GOOD_SOURCE_SHA:-}"
OBSOLETE_GENERATIONS="${OBSOLETE_GENERATIONS:-}"
VALIDATED_BEFORE_SUMMARY_FILE="${VALIDATED_BEFORE_SUMMARY_FILE:-}"
VALIDATED_PACKAGE_STATE_FILE="${VALIDATED_PACKAGE_STATE_FILE:-}"
VALIDATED_DELETE_IDS_FILE="${VALIDATED_DELETE_IDS_FILE:-}"
VALIDATED_GENERATIONS_FILE="${VALIDATED_GENERATIONS_FILE:-}"
GHCR_PACKAGE_METADATA_FILE="${GHCR_PACKAGE_METADATA_FILE:-}"
GHCR_VERSIONS_FILE="${GHCR_VERSIONS_FILE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts/ghcr-package-management}"
SENTINEL_TAG="bootstrap-sentinel-v1"
SERVICES=(auth bet backoffice client event gamemaster moderation resulting slip)

oci_require_command gh
oci_require_command jq
application_registry_require_ghcr
[[ "$REPO" == "vasilyevstan/betstan" ]] ||
  oci_die "GHCR package management is restricted to vasilyevstan/betstan"
[[ "$PACKAGE_NAME" == "betstan-images" ]] ||
  oci_die "GHCR package management is restricted to betstan-images"
[[ "$PRUNE_MODE" == "validate" || "$PRUNE_MODE" == "apply" ]] ||
  oci_die "PRUNE_MODE must be validate or apply"
for source_sha in "$CURRENT_SOURCE_SHA" "$DEPLOYED_SOURCE_SHA" "$LAST_KNOWN_GOOD_SOURCE_SHA"; do
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] ||
    oci_die "candidate, deployed, and last-known-good SHAs must be full lowercase SHAs"
done

oci_prepare_safe_private_dir "$OUTPUT_DIR"
WORK_DIR="$OUTPUT_DIR/.work"
rm -rf -- "$WORK_DIR"
oci_prepare_safe_private_dir "$WORK_DIR"
cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

metadata_file="$WORK_DIR/package.json"
versions_file="$WORK_DIR/versions.json"
if [[ -n "$GHCR_PACKAGE_METADATA_FILE" ]]; then
  [[ -f "$GHCR_PACKAGE_METADATA_FILE" && ! -L "$GHCR_PACKAGE_METADATA_FILE" ]] ||
    oci_die "GHCR_PACKAGE_METADATA_FILE must be a regular file"
  cp "$GHCR_PACKAGE_METADATA_FILE" "$metadata_file"
else
  gh api -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$PACKAGE_API" > "$metadata_file"
fi
if [[ -n "$GHCR_VERSIONS_FILE" ]]; then
  [[ -f "$GHCR_VERSIONS_FILE" && ! -L "$GHCR_VERSIONS_FILE" ]] ||
    oci_die "GHCR_VERSIONS_FILE must be a regular file"
  cp "$GHCR_VERSIONS_FILE" "$versions_file"
else
  gh api --paginate -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$PACKAGE_API/versions?per_page=100" |
    jq -s '
      if length == 1 and (.[0] | type) == "array" then .[0]
      elif all(.[]; type == "array") then flatten
      else error("unexpected package-version response")
      end
    ' > "$versions_file"
fi

jq -e --arg repo "$REPO" --arg package "$PACKAGE_NAME" '
  type == "object" and
  .package_type == "container" and
  .name == $package and
  .visibility == "public" and
  ((.repository.full_name // "") == $repo)
' "$metadata_file" >/dev/null ||
  oci_die "GHCR package is not a public repository-linked container package"
jq -S '{
  package_type,
  name,
  visibility,
  repository: {full_name: .repository.full_name}
}' "$metadata_file" > "$WORK_DIR/package-metadata-state.json"

jq -e '
  type == "array" and length > 0 and
  all(
    .[];
    (.id | type) == "number" and .id > 0 and
    (.name | type) == "string" and
    (.name | test("^sha256:[0-9a-f]{64}$")) and
    (.metadata.container.tags | type) == "array"
  ) and
  ([.[].id] | unique | length) == length
' "$versions_file" >/dev/null ||
  oci_die "GHCR package version metadata is ambiguous"
jq -S '
  map({
    id,
    name,
    tags: (.metadata.container.tags | sort)
  }) | sort_by(.id)
' "$versions_file" > "$WORK_DIR/package-state.json"

untagged_version_count="$(
  jq '[.[] | select((.metadata.container.tags | length) == 0)] | length' "$versions_file"
)"
tags_file="$WORK_DIR/tags.tsv"
jq -r '
  .[] |
  .id as $id |
  .name as $digest |
  .metadata.container.tags[]? |
  [$id, $digest, .] | @tsv
' "$versions_file" | LC_ALL=C sort > "$tags_file"
[[ -s "$tags_file" ]] || oci_die "GHCR package has no tagged versions"
awk -F '\t' 'NF != 3 || seen[$3]++ { exit 1 }' "$tags_file" ||
  oci_die "GHCR package tags are duplicated or malformed"

sentinel_count="$(
  awk -F '\t' -v tag="$SENTINEL_TAG" '$3 == tag { count++ } END { print count+0 }' "$tags_file"
)"
[[ "$sentinel_count" == "1" ]] ||
  oci_die "GHCR package must contain exactly one protected bootstrap sentinel"
sentinel_version_id="$(
  awk -F '\t' -v tag="$SENTINEL_TAG" '$3 == tag { print $1 }' "$tags_file"
)"

application_tags="$WORK_DIR/application-tags.tsv"
awk -F '\t' -v sentinel="$SENTINEL_TAG" '
  $3 != sentinel { print }
' "$tags_file" > "$application_tags"
[[ -s "$application_tags" ]] ||
  oci_die "GHCR package contains no application image generation"
! awk -F '\t' -v sentinel_id="$sentinel_version_id" '$1 == sentinel_id { found=1 } END { exit(found ? 0 : 1) }' \
  "$application_tags" ||
  oci_die "bootstrap sentinel version must not alias an application image"
awk -F '\t' '
  $3 !~ /^arm64-(auth|bet|backoffice|client|event|gamemaster|moderation|resulting|slip)-[0-9a-f]{40}$/ {
    exit 1
  }
' "$application_tags" ||
  oci_die "GHCR package contains mutable, foreign, or legacy OCIR-style tags"

generations_file="$WORK_DIR/generations.tsv"
awk -F '\t' '
  {
    split($3, pieces, "-")
    source = pieces[length(pieces)]
    service = pieces[2]
    print source "\t" service "\t" $1 "\t" $2
  }
' "$application_tags" | LC_ALL=C sort > "$generations_file"
awk -F '\t' '
  BEGIN {
    split("auth bet backoffice client event gamemaster moderation resulting slip", wanted, " ")
    for (i in wanted) allowed[wanted[i]] = 1
  }
  NF != 4 || !allowed[$2] || seen[$1 SUBSEP $2]++ {
    exit 1
  }
  {
    count[$1]++
    service[$1 SUBSEP $2] = 1
  }
  END {
    for (source in count) {
      if (count[source] > 9) exit 1
    }
  }
' "$generations_file" ||
  oci_die "GHCR package contains malformed application generation aliases"
if [[ "$PRUNE_MODE" == "validate" ]]; then
  awk -F '\t' '
    { count[$1]++ }
    END { for (source in count) if (count[source] != 9) exit 1 }
  ' "$generations_file" ||
    oci_die "GHCR package contains a partial application generation"
fi

protected_sources_file="$WORK_DIR/protected-sources.txt"
printf '%s\n' \
  "$CURRENT_SOURCE_SHA" "$DEPLOYED_SOURCE_SHA" "$LAST_KNOWN_GOOD_SOURCE_SHA" |
  LC_ALL=C sort -u > "$protected_sources_file"
while IFS= read -r source_sha; do
  [[ -n "$source_sha" ]] || continue
  awk -F '\t' -v source="$source_sha" '$1 == source { count++ } END { exit(count == 9 ? 0 : 1) }' \
    "$generations_file" ||
    oci_die "protected GHCR generation is absent or incomplete: $source_sha"
done < "$protected_sources_file"

obsolete_file="$WORK_DIR/obsolete-sources.txt"
if [[ -n "$OBSOLETE_GENERATIONS" ]]; then
  jq -ceS '
    if (
      type == "array" and length >= 1 and length <= 10 and
      all(
        .[];
        type == "object" and
        (keys | sort) == ["build_run_id", "sha"] and
        (.sha | type) == "string" and
        (.sha | test("^[0-9a-f]{40}$")) and
        (.build_run_id | type) == "string" and
        (.build_run_id | test("^[1-9][0-9]*$"))
      ) and
      ([.[].sha] | unique | length) == length
    ) then sort_by(.sha)
    else error("obsolete generation request is malformed")
    end
  ' <<<"$OBSOLETE_GENERATIONS" > "$WORK_DIR/obsolete.json" ||
    oci_die "obsolete generation request is malformed"
  jq -r '.[].sha' "$WORK_DIR/obsolete.json" | LC_ALL=C sort > "$obsolete_file"
else
  printf '[]\n' > "$WORK_DIR/obsolete.json"
  : > "$obsolete_file"
fi

while IFS= read -r source_sha; do
  [[ -n "$source_sha" ]] || continue
  ! grep -Fxq "$source_sha" "$protected_sources_file" ||
    oci_die "a protected generation was requested for pruning"
  if [[ "$PRUNE_MODE" == "validate" ]]; then
    awk -F '\t' -v source="$source_sha" \
      '$1 == source { count++ } END { exit(count == 9 ? 0 : 1) }' \
      "$generations_file" ||
      oci_die "obsolete GHCR generation is absent or incomplete: $source_sha"
  fi
done < "$obsolete_file"

delete_ids_file="$WORK_DIR/delete-version-ids.txt"
if [[ "$PRUNE_MODE" == "validate" ]]; then
  retained_alias_ids_file="$WORK_DIR/retained-alias-version-ids.txt"
  if [[ -s "$obsolete_file" ]]; then
    awk -F '\t' '
      NR == FNR { wanted[$1] = 1; next }
      {
        if (wanted[$1]) requested[$3] = 1
        else blocked[$3] = 1
      }
      END {
        for (id in requested) if (!blocked[id]) print id
      }
    ' "$obsolete_file" "$generations_file" | LC_ALL=C sort -nu > "$delete_ids_file"
    awk -F '\t' '
      NR == FNR { wanted[$1] = 1; next }
      {
        if (wanted[$1]) requested[$3] = 1
        else blocked[$3] = 1
      }
      END {
        for (id in requested) if (blocked[id]) print id
      }
    ' "$obsolete_file" "$generations_file" |
      LC_ALL=C sort -nu > "$retained_alias_ids_file"
  else
    : > "$delete_ids_file"
    : > "$retained_alias_ids_file"
  fi
  delete_count="$(awk 'END { print NR+0 }' "$delete_ids_file")"
  retained_alias_count="$(awk 'END { print NR+0 }' "$retained_alias_ids_file")"
  total_versions="$(jq 'length' "$versions_file")"
  protected_version_count="$(
    awk -F '\t' '
      NR == FNR { protected[$1] = 1; next }
      protected[$1] { ids[$3] = 1 }
      END { print length(ids) }
    ' "$protected_sources_file" "$generations_file"
  )"
  if awk -F '\t' '
      NR == FNR { protected[$1] = 1; next }
      protected[$1] { ids[$3] = 1; next }
      $1 in ids { exit 1 }
    ' "$protected_sources_file" "$generations_file" "$delete_ids_file"; then
    :
  else
    oci_die "GHCR deletion plan contains a protected alias"
  fi
  ((total_versions - delete_count >= protected_version_count + 1)) ||
    oci_die "GHCR prune would remove every package version or its sentinel"

  metadata_sha256="$(oci_sha256 < "$WORK_DIR/package-metadata-state.json")"
  versions_sha256="$(oci_sha256 < "$versions_file")"
  package_state_sha256="$(oci_sha256 < "$WORK_DIR/package-state.json")"
  generations_sha256="$(oci_sha256 < "$generations_file")"
  deletion_plan_sha256="$(oci_sha256 < "$delete_ids_file")"
  protected_sources_json="$(
    jq -Rsc 'split("\n") | map(select(length > 0))' "$protected_sources_file"
  )"
  obsolete_sources_json="$(
    jq -Rsc 'split("\n") | map(select(length > 0))' "$obsolete_file"
  )"
  jq -nS \
    --arg schema "betstan.ghcr-package-management.v1" \
    --arg registry_provider "ghcr" \
    --arg registry_host "ghcr.io" \
    --arg repository "ghcr.io/vasilyevstan/betstan-images" \
    --arg package_repository "$REPO" \
    --arg package_name "$PACKAGE_NAME" \
    --arg sentinel_tag "$SENTINEL_TAG" \
    --arg sentinel_version_id "$sentinel_version_id" \
    --arg metadata_sha256 "$metadata_sha256" \
    --arg versions_sha256 "$versions_sha256" \
    --arg package_state_sha256 "$package_state_sha256" \
    --arg generations_sha256 "$generations_sha256" \
    --arg deletion_plan_sha256 "$deletion_plan_sha256" \
    --arg mode "validate" \
    --argjson total_versions "$total_versions" \
    --argjson untagged_versions "$untagged_version_count" \
    --argjson planned_deletions "$delete_count" \
    --argjson retained_alias_versions "$retained_alias_count" \
    --argjson protected_sources "$protected_sources_json" \
    --argjson obsolete_sources "$obsolete_sources_json" \
    --slurpfile obsolete_origins "$WORK_DIR/obsolete.json" \
    '{
      schema: $schema,
      registry_provider: $registry_provider,
      registry_host: $registry_host,
      repository: $repository,
      package_repository: $package_repository,
      package_name: $package_name,
      package_visibility: "public",
      repository_linked: true,
      sentinel_tag: $sentinel_tag,
      sentinel_version_id: ($sentinel_version_id | tonumber),
      metadata_sha256: $metadata_sha256,
      versions_sha256: $versions_sha256,
      package_state_sha256: $package_state_sha256,
      generations_sha256: $generations_sha256,
      deletion_plan_sha256: $deletion_plan_sha256,
      mode: $mode,
      total_versions: $total_versions,
      untagged_versions: $untagged_versions,
      planned_deletions: $planned_deletions,
      retained_alias_versions: $retained_alias_versions,
      protected_sources: $protected_sources,
      obsolete_sources: $obsolete_sources,
      obsolete_origins: $obsolete_origins[0]
    }' > "$OUTPUT_DIR/before-summary.json"
  cp "$generations_file" "$OUTPUT_DIR/generations.tsv"
  cp "$WORK_DIR/package-state.json" "$OUTPUT_DIR/package-state.json"
  cp "$delete_ids_file" "$OUTPUT_DIR/planned-delete-version-ids.txt"
  jq '. + {terminal_status: "VALIDATED"}' "$OUTPUT_DIR/before-summary.json" \
    > "$OUTPUT_DIR/validation-summary.json"
  oci_log "ghcr_package_management=VALIDATED planned_deletions=$delete_count retained_alias_versions=$retained_alias_count"
  exit 0
fi

for validated_file in \
  "$VALIDATED_BEFORE_SUMMARY_FILE" \
  "$VALIDATED_PACKAGE_STATE_FILE" \
  "$VALIDATED_DELETE_IDS_FILE" \
  "$VALIDATED_GENERATIONS_FILE"; do
  [[ -f "$validated_file" && ! -L "$validated_file" ]] ||
    oci_die "apply mode requires the exact prior validation plan"
done
validated_sha256="$(oci_sha256 < "$VALIDATED_BEFORE_SUMMARY_FILE")"
delete_count="$(awk 'END { print NR+0 }' "$VALIDATED_DELETE_IDS_FILE")"
jq -e \
  --arg current "$CURRENT_SOURCE_SHA" \
  --arg deployed "$DEPLOYED_SOURCE_SHA" \
  --arg lkg "$LAST_KNOWN_GOOD_SOURCE_SHA" \
  --argjson sentinel_version_id "$sentinel_version_id" \
  --argjson planned_deletions "$delete_count" \
  --slurpfile obsolete "$WORK_DIR/obsolete.json" '
    .schema == "betstan.ghcr-package-management.v1" and
    .registry_provider == "ghcr" and .registry_host == "ghcr.io" and
    .repository == "ghcr.io/vasilyevstan/betstan-images" and
    .package_repository == "vasilyevstan/betstan" and
    .package_name == "betstan-images" and .package_visibility == "public" and
    .repository_linked == true and .sentinel_tag == "bootstrap-sentinel-v1" and
    .sentinel_version_id == $sentinel_version_id and
    .mode == "validate" and
    (.protected_sources | sort) == ([$current, $deployed, $lkg] | unique | sort) and
    .obsolete_origins == $obsolete[0] and
    .planned_deletions == $planned_deletions and
    (.package_state_sha256 | test("^[0-9a-f]{64}$")) and
    (.generations_sha256 | test("^[0-9a-f]{64}$")) and
    (.deletion_plan_sha256 | test("^[0-9a-f]{64}$"))
  ' "$VALIDATED_BEFORE_SUMMARY_FILE" >/dev/null ||
  oci_die "validated GHCR deletion plan does not match the apply request"
[[ "$(oci_sha256 < "$VALIDATED_PACKAGE_STATE_FILE")" == \
     "$(jq -r .package_state_sha256 "$VALIDATED_BEFORE_SUMMARY_FILE")" &&
   "$(oci_sha256 < "$VALIDATED_GENERATIONS_FILE")" == \
     "$(jq -r .generations_sha256 "$VALIDATED_BEFORE_SUMMARY_FILE")" &&
   "$(oci_sha256 < "$VALIDATED_DELETE_IDS_FILE")" == \
     "$(jq -r .deletion_plan_sha256 "$VALIDATED_BEFORE_SUMMARY_FILE")" &&
   "$(oci_sha256 < "$WORK_DIR/package-metadata-state.json")" == \
     "$(jq -r .metadata_sha256 "$VALIDATED_BEFORE_SUMMARY_FILE")" ]] ||
  oci_die "validated GHCR deletion plan hashes differ"
jq -e '
  type == "array" and
  all(.[]; (keys | sort) == ["id", "name", "tags"] and
    (.id | type) == "number" and .id > 0 and
    (.name | test("^sha256:[0-9a-f]{64}$")) and
    (.tags | type) == "array") and
  ([.[].id] | unique | length) == length
' "$VALIDATED_PACKAGE_STATE_FILE" >/dev/null ||
  oci_die "validated GHCR package state is malformed"
awk '/^[1-9][0-9]*$/ && !seen[$1]++ { next } { exit 1 }' \
  "$VALIDATED_DELETE_IDS_FILE" ||
  oci_die "validated GHCR deletion plan contains invalid version IDs"
if awk -F '\t' '
    NR == FNR { protected[$1] = 1; next }
    protected[$1] { ids[$3] = 1; next }
    $1 in ids { exit 1 }
  ' "$protected_sources_file" "$generations_file" "$VALIDATED_DELETE_IDS_FILE"; then
  :
else
  oci_die "validated GHCR deletion plan would remove a protected alias"
fi

remaining_ids_file="$WORK_DIR/remaining-delete-version-ids.txt"
python3 - \
  "$VALIDATED_PACKAGE_STATE_FILE" \
  "$WORK_DIR/package-state.json" \
  "$VALIDATED_DELETE_IDS_FILE" \
  "$remaining_ids_file" <<'PY'
import json
import sys
from pathlib import Path

expected_path, current_path, plan_path, remaining_path = map(Path, sys.argv[1:])
expected = {item["id"]: item for item in json.loads(expected_path.read_text())}
current = {item["id"]: item for item in json.loads(current_path.read_text())}
plan = {
    int(line)
    for line in plan_path.read_text().splitlines()
    if line
}
if not plan <= set(expected):
    raise SystemExit("deletion plan references an unknown validated version")
if not set(current) <= set(expected):
    raise SystemExit("GHCR package gained versions after validation")
for version_id, value in current.items():
    if value != expected[version_id]:
        raise SystemExit("GHCR package version or tag identity changed after validation")
missing = set(expected) - set(current)
if not missing <= plan:
    raise SystemExit("GHCR package lost an unplanned version after validation")
remaining_path.write_text(
    "".join(f"{version_id}\n" for version_id in sorted(plan & set(current))),
    encoding="utf-8",
)
PY

cp "$VALIDATED_BEFORE_SUMMARY_FILE" "$OUTPUT_DIR/before-summary.json"
cp "$VALIDATED_PACKAGE_STATE_FILE" "$OUTPUT_DIR/package-state.json"
cp "$VALIDATED_DELETE_IDS_FILE" "$OUTPUT_DIR/planned-delete-version-ids.txt"
cp "$VALIDATED_GENERATIONS_FILE" "$OUTPUT_DIR/generations.tsv"
cp "$WORK_DIR/package-state.json" "$OUTPUT_DIR/observed-package-state.json"
cp "$remaining_ids_file" "$OUTPUT_DIR/remaining-delete-version-ids.txt"
remaining_count="$(awk 'END { print NR+0 }' "$remaining_ids_file")"
already_absent_count=$((delete_count - remaining_count))

while IFS= read -r version_id; do
  [[ "$version_id" =~ ^[1-9][0-9]*$ ]] ||
    oci_die "GHCR deletion plan contains an invalid version ID"
  [[ "$version_id" != "$sentinel_version_id" ]] ||
    oci_die "GHCR deletion plan includes the protected sentinel"
  gh api --method DELETE -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$PACKAGE_API/versions/$version_id" >/dev/null
done < "$remaining_ids_file"

final_metadata="$WORK_DIR/final-package.json"
final_versions="$WORK_DIR/final-versions.json"
if [[ -n "$GHCR_PACKAGE_METADATA_FILE" ]]; then
  cp "$GHCR_PACKAGE_METADATA_FILE" "$final_metadata"
else
  gh api -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$PACKAGE_API" > "$final_metadata"
fi
if [[ -n "$GHCR_VERSIONS_FILE" ]]; then
  cp "$GHCR_VERSIONS_FILE" "$final_versions"
else
  gh api --paginate -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$PACKAGE_API/versions?per_page=100" |
    jq -s '
      if length == 1 and (.[0] | type) == "array" then .[0]
      elif all(.[]; type == "array") then flatten
      else error("unexpected package-version response")
      end
    ' > "$final_versions"
fi
jq -e --arg repo "$REPO" --arg package "$PACKAGE_NAME" '
  type == "object" and .package_type == "container" and
  .name == $package and .visibility == "public" and
  ((.repository.full_name // "") == $repo)
' "$final_metadata" >/dev/null ||
  oci_die "GHCR package identity changed during pruning"
jq -S '{
  package_type,
  name,
  visibility,
  repository: {full_name: .repository.full_name}
}' "$final_metadata" > "$WORK_DIR/final-package-metadata-state.json"
[[ "$(oci_sha256 < "$WORK_DIR/final-package-metadata-state.json")" == \
   "$(jq -r .metadata_sha256 "$VALIDATED_BEFORE_SUMMARY_FILE")" ]] ||
  oci_die "GHCR package metadata changed during pruning"
jq -e '
  type == "array" and
  all(
    .[];
    (.id | type) == "number" and .id > 0 and
    (.name | type) == "string" and
    (.name | test("^sha256:[0-9a-f]{64}$")) and
    (.metadata.container.tags | type) == "array"
  ) and
  ([.[].id] | unique | length) == length
' "$final_versions" >/dev/null ||
  oci_die "terminal GHCR package version metadata is ambiguous"
jq -S '
  map({
    id,
    name,
    tags: (.metadata.container.tags | sort)
  }) | sort_by(.id)
' "$final_versions" > "$WORK_DIR/final-package-state.json"
python3 - \
  "$VALIDATED_PACKAGE_STATE_FILE" \
  "$WORK_DIR/final-package-state.json" \
  "$VALIDATED_DELETE_IDS_FILE" <<'PY'
import json
import sys
from pathlib import Path

expected_path, final_path, plan_path = map(Path, sys.argv[1:])
expected = {item["id"]: item for item in json.loads(expected_path.read_text())}
final = {item["id"]: item for item in json.loads(final_path.read_text())}
plan = {int(line) for line in plan_path.read_text().splitlines() if line}
terminal = {key: value for key, value in expected.items() if key not in plan}
if final != terminal:
    raise SystemExit("terminal GHCR state does not equal the validated state minus the deletion plan")
PY
cp "$WORK_DIR/final-package-state.json" "$OUTPUT_DIR/terminal-package-state.json"
terminal_state_sha256="$(oci_sha256 < "$WORK_DIR/final-package-state.json")"
terminal_total_versions="$(jq 'length' "$WORK_DIR/final-package-state.json")"
terminal_status=CONVERGED
((remaining_count == 0)) || terminal_status=PRUNED
jq '. + {
  mode: "apply",
  terminal_status: $status,
  validated_before_summary_sha256: $validated_sha,
  already_absent_planned_versions: $already_absent,
  deleted_in_run: $deleted,
  terminal_total_versions: $terminal_total,
  terminal_package_state_sha256: $terminal_sha
}' \
  --arg status "$terminal_status" \
  --arg validated_sha "$validated_sha256" \
  --arg terminal_sha "$terminal_state_sha256" \
  --argjson already_absent "$already_absent_count" \
  --argjson deleted "$remaining_count" \
  --argjson terminal_total "$terminal_total_versions" \
  "$OUTPUT_DIR/before-summary.json" > "$OUTPUT_DIR/after-summary.json"
oci_log "ghcr_package_management=$terminal_status deleted_versions=$remaining_count already_absent=$already_absent_count"
