#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="${1:-authorize}"
OCI_RUNNER_RULE_TTL_MINUTES="${OCI_RUNNER_RULE_TTL_MINUTES:-90}"
RULE_STATE_FILE="${RULE_STATE_FILE:-$OCI_ROOT_DIR/artifacts/oci-runner-rule.env}"

oci_require_cli_version
oci_require_command jq
oci_require_command python3
oci_require_vars OCI_ENDPOINT_NSG_OCID
oci_require_ocid OCI_ENDPOINT_NSG_OCID
oci_is_positive_int "$OCI_RUNNER_RULE_TTL_MINUTES" ||
  oci_die "OCI_RUNNER_RULE_TTL_MINUTES must be a positive integer"
(( OCI_RUNNER_RULE_TTL_MINUTES <= 120 )) ||
  oci_die "runner authorization may not exceed 120 minutes"

cleanup_stale() {
  local now rules stale_ids
  now="$(date -u +%s)"
  rules="$(oci network nsg rules list --nsg-id "$OCI_ENDPOINT_NSG_OCID" --direction INGRESS --all)"
  rules="$(oci_normalize_list_json "$rules")"
  stale_ids="$(
    jq -r --argjson now "$now" '
      .data[]?
      | select(.description | startswith("betstan-github-runner "))
      | (try (.description | capture("expires=(?<expires>[0-9]+)").expires) catch "0") as $expires
      | select(($expires | tonumber) < $now)
      | .id
    ' <<<"$rules"
  )"
  if [[ -n "$stale_ids" ]]; then
    while IFS= read -r rule_id; do
      [[ -n "$rule_id" ]] || continue
      ids="$(jq -cn --arg id "$rule_id" '[$id]')"
      oci network nsg rules remove \
        --nsg-id "$OCI_ENDPOINT_NSG_OCID" \
        --security-rule-ids "$ids" --force >/dev/null
    done <<<"$stale_ids"
  fi
  remaining="$(
    oci network nsg rules list \
      --nsg-id "$OCI_ENDPOINT_NSG_OCID" --direction INGRESS --all
  )"
  remaining="$(oci_normalize_list_json "$remaining")"
  jq -e --argjson now "$now" '
    [.data[]?
      | select(.description | startswith("betstan-github-runner "))
      | (try (.description | capture("expires=(?<expires>[0-9]+)").expires) catch "0") as $expires
      | select(($expires | tonumber) < $now)
    ] | length == 0
  ' <<<"$remaining" >/dev/null || oci_die "expired GitHub runner NSG rules remain"
  oci_log "oci_runner_rule_cleanup=PASS"
}

if [[ "$MODE" == "cleanup-stale" ]]; then
  cleanup_stale
  exit 0
fi
[[ "$MODE" == "authorize" ]] || oci_die "usage: authorize-github-runner.sh [authorize|cleanup-stale]"

oci_require_vars RUNNER_PUBLIC_IPV4 GITHUB_RUN_ID GITHUB_RUN_ATTEMPT
oci_validate_public_ipv4 "$RUNNER_PUBLIC_IPV4" ||
  oci_die "runner address must be a globally routable IPv4 address"
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ && "$GITHUB_RUN_ATTEMPT" == "1" ]] ||
  oci_die "runner authorization requires a first-attempt GitHub run identity"

cleanup_stale
expiry="$(
  python3 - "$OCI_RUNNER_RULE_TTL_MINUTES" <<'PY'
import datetime
import sys
ttl = int(sys.argv[1])
print(int((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=ttl)).timestamp()))
PY
)"
description="betstan-github-runner run=${GITHUB_RUN_ID} attempt=1 expires=${expiry}"
cidr="${RUNNER_PUBLIC_IPV4}/32"
existing="$(
  oci network nsg rules list \
    --nsg-id "$OCI_ENDPOINT_NSG_OCID" --direction INGRESS --all
)"
existing="$(oci_normalize_list_json "$existing")"
rule_id="$(
  jq -r --arg description "$description" --arg cidr "$cidr" '
    [.data[]? | select(
      .description == $description and .source == $cidr and
      .protocol == "6" and ."tcp-options"."destination-port-range".min == 6443 and
      ."tcp-options"."destination-port-range".max == 6443
    )][0].id // empty
  ' <<<"$existing"
)"

if [[ -z "$rule_id" ]]; then
  rules="$(
    jq -cn --arg source "$cidr" --arg description "$description" '[
      {
        direction: "INGRESS",
        protocol: "6",
        sourceType: "CIDR_BLOCK",
        source: $source,
        isStateless: false,
        description: $description,
        tcpOptions: {
          destinationPortRange: {min: 6443, max: 6443}
        }
      }
    ]'
  )"
  result="$(
    oci network nsg rules add \
      --nsg-id "$OCI_ENDPOINT_NSG_OCID" \
      --security-rules "$rules"
  )"
  rule_id="$(jq -r '.data."security-rules"[0].id // empty' <<<"$result")"
fi
[[ -n "$rule_id" ]] || oci_die "OCI did not return the authorized NSG rule identifier"

rollback_unrecorded_rule() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && -n "${rule_id:-}" ]]; then
    ids="$(jq -cn --arg id "$rule_id" '[$id]')"
    oci network nsg rules remove \
      --nsg-id "$OCI_ENDPOINT_NSG_OCID" \
      --security-rule-ids "$ids" --force >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback_unrecorded_rule EXIT

oci_prepare_private_dir "$(dirname "$RULE_STATE_FILE")"
{
  printf 'OCI_ENDPOINT_NSG_OCID=%q\n' "$OCI_ENDPOINT_NSG_OCID"
  printf 'OCI_RUNNER_RULE_ID=%q\n' "$rule_id"
  printf 'OCI_RUNNER_RULE_DESCRIPTION=%q\n' "$description"
  printf 'OCI_RUNNER_RULE_CIDR=%q\n' "$cidr"
  printf 'OCI_RUNNER_RULE_EXPIRES=%q\n' "$expiry"
} > "$RULE_STATE_FILE"
chmod 600 "$RULE_STATE_FILE"
trap - EXIT
oci_log "oci_runner_authorization=PASS rule_recorded=1 expires_epoch=$expiry"
