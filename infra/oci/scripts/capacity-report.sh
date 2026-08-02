#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=capacity-common.sh
source "$SCRIPT_DIR/capacity-common.sh"

OUTPUT_FILE="${OUTPUT_FILE:-}"

oci_capacity_require_contract
oci_require_cli_version
oci_capacity_require_home_region

profiles="$(oci_capacity_profiles_json)"
ads="$(oci_capacity_availability_domains)"
[[ "$(jq 'length' <<<"$ads")" -gt 0 ]] ||
  oci_die "no availability domains were discovered"

shape_availabilities="$(
  jq -cn --argjson profiles "$profiles" '
    [
      $profiles[] |
      {
        instanceShape: "VM.Standard.A1.Flex",
        instanceShapeConfig: {
          ocpus: 2,
          memoryInGBs: .
        }
      }
    ]
  '
)"
candidates='[]'
while IFS= read -r ad; do
  report="$(
    oci compute compute-capacity-report create \
      --compartment-id "$OCI_TENANCY_OCID" \
      --availability-domain "$ad" \
      --shape-availabilities "$shape_availabilities"
  )" || oci_die "unable to query A1 host capacity"
  normalized="$(
    jq -c --arg ad "$ad" '
      [
        .data."shape-availabilities"[]? |
        {
          availability_domain: $ad,
          shape: ."instance-shape",
          ocpus: ."instance-shape-config".ocpus,
          memory_gb: ."instance-shape-config"."memory-in-gbs",
          status: ."availability-status"
        }
      ]
    ' <<<"$report"
  )"
  jq -e --argjson expected "$profiles" '
    length == ($expected | length) and
    all(
      . as $candidate |
      $candidate.shape == "VM.Standard.A1.Flex" and
      $candidate.ocpus == 2 and
      ($expected | index($candidate.memory_gb)) != null and
      ($candidate.status == "AVAILABLE" or
       $candidate.status == "OUT_OF_HOST_CAPACITY" or
       $candidate.status == "HARDWARE_NOT_SUPPORTED")
    )
  ' <<<"$normalized" >/dev/null ||
    oci_die "OCI returned an unexpected capacity report"
  candidates="$(jq -cn --argjson current "$candidates" --argjson next "$normalized" '$current + $next')"
done < <(jq -r '.[]' <<<"$ads")

result="$(
  jq -cn \
    --arg region "$OCI_REGION" \
    --arg shape "$OCI_NODE_SHAPE" \
    --argjson profiles "$profiles" \
    --argjson candidates "$candidates" '
      {
        region: $region,
        shape: $shape,
        ocpus: 2,
        profiles: $profiles,
        candidates: (
          $candidates |
          sort_by(.memory_gb as $memory | ($profiles | index($memory)), .availability_domain)
        )
      }
    '
)"

if [[ -n "$OUTPUT_FILE" ]]; then
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  printf '%s\n' "$result" > "$OUTPUT_FILE"
  chmod 600 "$OUTPUT_FILE"
fi
printf '%s\n' "$result"
