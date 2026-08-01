#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

RULE_STATE_FILE="${RULE_STATE_FILE:-${1:-$OCI_ROOT_DIR/artifacts/oci-runner-rule.env}}"
[[ -f "$RULE_STATE_FILE" ]] || oci_die "runner rule state file is missing"
oci_require_cli_version
oci_require_command jq

unset OCI_ENDPOINT_NSG_OCID OCI_RUNNER_RULE_ID OCI_RUNNER_RULE_DESCRIPTION OCI_RUNNER_RULE_CIDR
# shellcheck disable=SC1090
source "$RULE_STATE_FILE"
oci_require_vars OCI_ENDPOINT_NSG_OCID OCI_RUNNER_RULE_ID OCI_RUNNER_RULE_DESCRIPTION OCI_RUNNER_RULE_CIDR
oci_require_ocid OCI_ENDPOINT_NSG_OCID

rules="$(
  oci network nsg rules list \
    --network-security-group-id "$OCI_ENDPOINT_NSG_OCID" --direction INGRESS --all
)"
rules="$(oci_normalize_list_json "$rules")"
match_count="$(
  jq -r --arg id "$OCI_RUNNER_RULE_ID" --arg description "$OCI_RUNNER_RULE_DESCRIPTION" \
    --arg cidr "$OCI_RUNNER_RULE_CIDR" '
      [.data[]? | select(.id == $id and .description == $description and .source == $cidr)] | length
    ' <<<"$rules"
)"
if [[ "$match_count" == "1" ]]; then
  ids="$(jq -cn --arg id "$OCI_RUNNER_RULE_ID" '[$id]')"
  oci network nsg rules remove \
    --network-security-group-id "$OCI_ENDPOINT_NSG_OCID" \
    --security-rule-ids "$ids" --force >/dev/null
elif [[ "$match_count" != "0" ]]; then
  oci_die "runner rule identity is ambiguous; refusing broad NSG cleanup"
fi

remaining="$(
  oci network nsg rules list \
    --network-security-group-id "$OCI_ENDPOINT_NSG_OCID" --direction INGRESS --all
)"
remaining="$(oci_normalize_list_json "$remaining")"
jq -e --arg id "$OCI_RUNNER_RULE_ID" '[.data[]? | select(.id == $id)] | length == 0' \
  <<<"$remaining" >/dev/null || oci_die "exact GitHub runner NSG rule still exists"
rm -f "$RULE_STATE_FILE"
oci_log "oci_runner_revocation=PASS exact_rule_absent=1"
