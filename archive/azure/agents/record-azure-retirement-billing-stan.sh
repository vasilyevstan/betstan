#!/usr/bin/env bash
set -euo pipefail

# Append one independently queried clean billing window to private evidence.
# Exit 0: recorded; 1: intentionally skipped; 2: malformed or unknown state.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=azure-retirement-billing-lib-stan.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/azure-retirement-billing-lib-stan.sh"

readonly CUTOFF_EPOCH=1787184000
readonly CUTOFF_DATE="2026-08-20"
readonly CUTOFF_USAGE_DATE="20260820"
readonly QUERY_START_DATE="2026-08-12"

OBSERVATION_FILE="${OBSERVATION_FILE:-}"
AZURE_SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-}"
AZURE_SUBSCRIPTION_FINGERPRINT="${AZURE_SUBSCRIPTION_FINGERPRINT:-}"

emit() {
  printf '%s\n' "$1"
}

die() {
  printf 'RECORDER_ERROR reason=%s\n' "$1" >&2
  exit 2
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[[ -n "$OBSERVATION_FILE" ]] || die "missing_observation_file"
[[ -n "$AZURE_SUBSCRIPTION_ID" ]] || die "missing_subscription_id"
[[ -n "$AZURE_SUBSCRIPTION_FINGERPRINT" ]] ||
  die "missing_subscription_fingerprint"

for command_name in az jq date stat mktemp mkdir mv sleep tr ln; do
  command -v "$command_name" >/dev/null 2>&1 ||
    die "missing_command_${command_name}"
done

[[ "$OBSERVATION_FILE" == /* ]] || die "observation_file_not_absolute"
observation_parent="$(dirname "$OBSERVATION_FILE")"
[[ -d "$observation_parent" && ! -L "$observation_parent" ]] ||
  die "observation_parent_invalid"
parent_mode="$(stat -c '%a' "$observation_parent" 2>/dev/null ||
  stat -f '%Lp' "$observation_parent" 2>/dev/null)" ||
  die "observation_parent_stat_error"
[[ "$parent_mode" == "700" ]] || die "observation_parent_unsafe_mode"
if [[ -e "$OBSERVATION_FILE" || -L "$OBSERVATION_FILE" ]]; then
  [[ -f "$OBSERVATION_FILE" && ! -L "$OBSERVATION_FILE" ]] ||
    die "observation_not_regular"
fi

[[ "$AZURE_SUBSCRIPTION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
  die "invalid_subscription_id"
[[ "$AZURE_SUBSCRIPTION_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] ||
  die "invalid_subscription_fingerprint"
calculated_subscription_fingerprint="$(
  printf '%s' "$AZURE_SUBSCRIPTION_ID" | betstan_billing_sha256_text
)" || die "subscription_fingerprint_hash_error"
[[ "$calculated_subscription_fingerprint" == "$AZURE_SUBSCRIPTION_FINGERPRINT" ]] ||
  die "subscription_fingerprint_mismatch"

umask 077
readonly LOCK_SCHEMA="betstan.billing-recorder-lock.v1"
lock_file="${OBSERVATION_FILE}.lock"
lock_candidate=""
lock_inode=""
query_directory=""
temporary_file=""
lock_acquired=false

file_inode() {
  stat -c '%d:%i' "$1" 2>/dev/null ||
    stat -f '%d:%i' "$1" 2>/dev/null
}

cleanup() {
  if [[ -n "$temporary_file" ]]; then
    rm -f -- "$temporary_file"
  fi
  if [[ -n "$query_directory" ]]; then
    rm -f -- \
      "$query_directory/actual.json" \
      "$query_directory/amortized.json" \
      "$query_directory/actual.json.usage-details" \
      "$query_directory/amortized.json.usage-details"
    rmdir "$query_directory" 2>/dev/null || true
  fi
  if [[ "$lock_acquired" == "true" ]]; then
    local current_lock_inode=""
    current_lock_inode="$(file_inode "$lock_file" 2>/dev/null)" || true
    if [[ -n "$lock_inode" && "$current_lock_inode" == "$lock_inode" ]]; then
      rm -f -- "$lock_file"
    fi
  fi
  if [[ -n "$lock_candidate" ]]; then
    rm -f -- "$lock_candidate"
  fi
}
terminate() {
  trap - HUP INT TERM
  exit "$1"
}
trap cleanup EXIT
trap 'terminate 129' HUP
trap 'terminate 130' INT
trap 'terminate 143' TERM

query_directory="$(mktemp -d "${OBSERVATION_FILE}.query.XXXXXX")" ||
  die "query_directory_error"
chmod 0700 "$query_directory"
lock_candidate="$(mktemp "${OBSERVATION_FILE}.lock-owner.XXXXXX")" ||
  die "lock_candidate_error"
chmod 0600 "$lock_candidate"
printf '%s\n' \
  "candidate=${lock_candidate}" \
  "pid=$$" \
  "query_directory=${query_directory}" \
  "schema=${LOCK_SCHEMA}" \
  >"$lock_candidate" ||
  die "lock_candidate_write_error"

if ! ln "$lock_candidate" "$lock_file" 2>/dev/null; then
  [[ -f "$lock_file" && ! -L "$lock_file" ]] ||
    die "lock_invalid"
  lock_mode="$(stat -c '%a' "$lock_file" 2>/dev/null ||
    stat -f '%Lp' "$lock_file" 2>/dev/null)" ||
    die "lock_stat_error"
  [[ "$lock_mode" == "600" ]] || die "lock_unsafe_mode"
  lock_fields="$(sed 's/=.*//' "$lock_file" | LC_ALL=C sort)"
  [[ "$lock_fields" == $'candidate\npid\nquery_directory\nschema' ]] ||
    die "lock_field_set"
  lock_owner_schema="$(betstan_billing_state_field "$lock_file" schema)" ||
    die "lock_schema_missing"
  lock_owner_pid="$(betstan_billing_state_field "$lock_file" pid)" ||
    die "lock_pid_missing"
  stale_candidate="$(betstan_billing_state_field "$lock_file" candidate)" ||
    die "lock_candidate_missing"
  stale_query_directory="$(
    betstan_billing_state_field "$lock_file" query_directory
  )" || die "lock_query_directory_missing"
  [[ "$lock_owner_schema" == "$LOCK_SCHEMA" ]] ||
    die "lock_schema_mismatch"
  [[ "$lock_owner_pid" =~ ^[1-9][0-9]*$ ]] ||
    die "lock_pid_invalid"
  [[ "$stale_candidate" == "${OBSERVATION_FILE}.lock-owner."* &&
     "$stale_candidate" != *$'\n'* && "$stale_candidate" != *$'\r'* ]] ||
    die "lock_candidate_invalid"
  [[ "$stale_query_directory" == "${OBSERVATION_FILE}.query."* &&
     "$stale_query_directory" != *$'\n'* &&
     "$stale_query_directory" != *$'\r'* ]] ||
    die "lock_query_directory_invalid"
  if kill -0 "$lock_owner_pid" 2>/dev/null; then
    die "lock_contended"
  fi
  stale_lock_inode="$(file_inode "$lock_file")" ||
    die "lock_inode_error"
  stale_candidate_inode="$(file_inode "$stale_candidate")" ||
    die "lock_candidate_inode_error"
  [[ "$stale_lock_inode" == "$stale_candidate_inode" ]] ||
    die "lock_inode_mismatch"
  current_lock_inode="$(file_inode "$lock_file")" ||
    die "lock_inode_error"
  [[ "$current_lock_inode" == "$stale_lock_inode" ]] ||
    die "lock_changed"
  rm -f -- "$lock_file" "$stale_candidate" ||
    die "stale_lock_cleanup_error"
  [[ -d "$stale_query_directory" && ! -L "$stale_query_directory" ]] ||
    die "stale_query_directory_invalid"
  rm -f -- \
    "$stale_query_directory/actual.json" \
    "$stale_query_directory/amortized.json" \
    "$stale_query_directory/actual.json.usage-details" \
    "$stale_query_directory/amortized.json.usage-details" ||
    die "stale_query_cleanup_error"
  rmdir "$stale_query_directory" ||
    die "stale_query_directory_not_empty"
  ln "$lock_candidate" "$lock_file" 2>/dev/null ||
    die "lock_contended"
fi
lock_acquired=true
lock_inode="$(file_inode "$lock_file")" || die "lock_inode_error"

account_json="$(az account show --subscription "$AZURE_SUBSCRIPTION_ID" -o json 2>/dev/null)" ||
  die "azure_account_error"
account_valid="$(jq -r \
  --arg subscription "$AZURE_SUBSCRIPTION_ID" '
    type == "object" and
    .id == $subscription and
    .state == "Enabled"
  ' <<<"$account_json" 2>/dev/null)" ||
  die "azure_account_parse_error"
[[ "$account_valid" == "true" ]] || die "azure_account_binding_error"

now_epoch="$(date -u +%s)" || die "date_epoch_error"
today="$(date -u +%Y-%m-%d)" || die "date_today_error"
[[ "$now_epoch" =~ ^[1-9][0-9]*$ ]] || die "date_epoch_invalid"
[[ "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
  die "date_today_invalid"
if [[ "$now_epoch" -le $((CUTOFF_EPOCH + BETSTAN_BILLING_GRACE_SECONDS)) ]]; then
  emit "recorder_skip=cutoff_grace_incomplete"
  exit 1
fi

previous_exists=false
previous_hash=""
previous_epochs=""
previous_actual_results=""
previous_amortized_results=""
previous_digests=""
previous_chains=""
previous_currencies=""
previous_currency=""
previous_count=0

if [[ -e "$OBSERVATION_FILE" || -L "$OBSERVATION_FILE" ]]; then
  [[ -f "$OBSERVATION_FILE" && ! -L "$OBSERVATION_FILE" ]] ||
    die "observation_not_regular"
  observation_mode="$(stat -c '%a' "$OBSERVATION_FILE" 2>/dev/null ||
    stat -f '%Lp' "$OBSERVATION_FILE" 2>/dev/null)" ||
    die "observation_stat_error"
  [[ "$observation_mode" == "600" ]] || die "observation_unsafe_mode"
  if ! betstan_billing_validate_observation_file \
    "$OBSERVATION_FILE" \
    "$AZURE_SUBSCRIPTION_FINGERPRINT" \
    "$CUTOFF_EPOCH" \
    "$CUTOFF_DATE"; then
    die "$BETSTAN_BILLING_ERROR_REASON"
  fi
  previous_exists=true
  previous_hash="$(sha256_file "$OBSERVATION_FILE")" ||
    die "observation_hash_error"
  previous_epochs="$(betstan_billing_state_field "$OBSERVATION_FILE" observation_epochs)"
  previous_actual_results="$(betstan_billing_state_field "$OBSERVATION_FILE" results_actual)"
  previous_amortized_results="$(betstan_billing_state_field "$OBSERVATION_FILE" results_amortized)"
  previous_digests="$(betstan_billing_state_field "$OBSERVATION_FILE" response_digests)"
  previous_chains="$(betstan_billing_state_field "$OBSERVATION_FILE" observation_chain_sha256s)"
  previous_currencies="$(betstan_billing_state_field "$OBSERVATION_FILE" currencies)"
  previous_currency="$BETSTAN_BILLING_OBS_CURRENCY"
  previous_count="$BETSTAN_BILLING_OBS_COUNT"
  [[ "$BETSTAN_BILLING_OBS_LAST_EPOCH" -lt "$now_epoch" ]] ||
    die "observation_last_epoch_not_past"
  if [[ $((now_epoch - BETSTAN_BILLING_OBS_LAST_EPOCH)) -lt "$BETSTAN_BILLING_MIN_GAP_SECONDS" ]]; then
    emit "recorder_skip=minimum_interval_not_reached"
    exit 1
  fi
fi

actual_result_file="$query_directory/actual.json"
amortized_result_file="$query_directory/amortized.json"
actual_query_ok=true
amortized_query_ok=true
actual_query_error=""
amortized_query_error=""
if ! betstan_billing_query_cost_type \
  "ActualCost" \
  "$AZURE_SUBSCRIPTION_ID" \
  "$QUERY_START_DATE" \
  "$today" \
  "$CUTOFF_USAGE_DATE" \
  "$actual_result_file"; then
  actual_query_ok=false
  actual_query_error="$BETSTAN_BILLING_ERROR_REASON"
fi
if ! betstan_billing_query_cost_type \
  "AmortizedCost" \
  "$AZURE_SUBSCRIPTION_ID" \
  "$QUERY_START_DATE" \
  "$today" \
  "$CUTOFF_USAGE_DATE" \
  "$amortized_result_file"; then
  amortized_query_ok=false
  amortized_query_error="$BETSTAN_BILLING_ERROR_REASON"
fi

actual_result=""
amortized_result=""
if [[ "$actual_query_ok" == "true" ]]; then
  actual_result="$(jq -r '.result' "$actual_result_file")"
fi
if [[ "$amortized_query_ok" == "true" ]]; then
  amortized_result="$(jq -r '.result' "$amortized_result_file")"
fi
if [[ "$actual_result" == "nogo" || "$amortized_result" == "nogo" ]]; then
  emit "recorder_result=nogo"
  exit 1
fi
[[ "$actual_query_ok" == "true" ]] || die "actual_${actual_query_error}"
[[ "$amortized_query_ok" == "true" ]] ||
  die "amortized_${amortized_query_error}"
if [[ "$actual_result" == "pending_adjustment" ||
      "$amortized_result" == "pending_adjustment" ]]; then
  emit "recorder_skip=post_cutoff_adjustment"
  exit 1
fi
[[ "$actual_result" == "clean" && "$amortized_result" == "clean" ]] ||
  die "unexpected_query_result"

actual_currency="$(jq -r '.currency' "$actual_result_file")"
amortized_currency="$(jq -r '.currency' "$amortized_result_file")"
if [[ "$actual_currency" != "NO_ROWS" &&
      "$amortized_currency" != "NO_ROWS" &&
      "$actual_currency" != "$amortized_currency" ]]; then
  die "cost_type_currency_mismatch"
fi
if [[ "$actual_currency" != "NO_ROWS" ]]; then
  observation_currency="$actual_currency"
else
  observation_currency="$amortized_currency"
fi
if [[ "$observation_currency" != "NO_ROWS" &&
      -n "$previous_currency" &&
      "$observation_currency" != "$previous_currency" ]]; then
  die "observation_currency_changed"
fi

actual_digest="$(jq -r '.response_digest' "$actual_result_file")"
amortized_digest="$(jq -r '.response_digest' "$amortized_result_file")"
response_digest_pair="${actual_digest}:${amortized_digest}"
previous_chain="$BETSTAN_BILLING_ZERO_CHAIN"
if [[ -n "$previous_chains" ]]; then
  previous_chain="${previous_chains##*,}"
fi
new_chain="$(betstan_billing_chain_hash \
  "$previous_chain" \
  "$AZURE_SUBSCRIPTION_FINGERPRINT" \
  "$CUTOFF_EPOCH" \
  "$observation_currency" \
  "$now_epoch" \
  "$actual_result" \
  "$amortized_result" \
  "$response_digest_pair")" ||
  die "new_chain_hash_error"

new_epochs="${previous_epochs:+${previous_epochs},}${now_epoch}"
new_actual_results="${previous_actual_results:+${previous_actual_results},}${actual_result}"
new_amortized_results="${previous_amortized_results:+${previous_amortized_results},}${amortized_result}"
new_digests="${previous_digests:+${previous_digests},}${response_digest_pair}"
new_chains="${previous_chains:+${previous_chains},}${new_chain}"
new_currencies="${previous_currencies:+${previous_currencies},}${observation_currency}"

first_epoch="${new_epochs%%,*}"
span_hours=$(((now_epoch - first_epoch) / 3600))

temporary_file="$(mktemp "${OBSERVATION_FILE}.tmp.XXXXXX")" ||
  die "temporary_file_error"
chmod 0600 "$temporary_file"
printf '%s\n' \
  "api_version=${BETSTAN_BILLING_API_VERSION}" \
  "currencies=${new_currencies}" \
  "cutoff_date=${CUTOFF_DATE}" \
  "cutoff_epoch=${CUTOFF_EPOCH}" \
  "observation_chain_sha256s=${new_chains}" \
  "observation_epochs=${new_epochs}" \
  "recorder_version=${BETSTAN_BILLING_RECORDER_VERSION}" \
  "response_digests=${new_digests}" \
  "results_actual=${new_actual_results}" \
  "results_amortized=${new_amortized_results}" \
  "schema=${BETSTAN_BILLING_SCHEMA}" \
  "subscription_fingerprint=${AZURE_SUBSCRIPTION_FINGERPRINT}" \
  "total_span_hours=${span_hours}" \
  "usage_api_version=${BETSTAN_BILLING_USAGE_API_VERSION}" \
  >"$temporary_file" ||
  die "temporary_write_error"

if ! betstan_billing_validate_observation_file \
  "$temporary_file" \
  "$AZURE_SUBSCRIPTION_FINGERPRINT" \
  "$CUTOFF_EPOCH" \
  "$CUTOFF_DATE"; then
  die "generated_${BETSTAN_BILLING_ERROR_REASON}"
fi
[[ "$BETSTAN_BILLING_OBS_COUNT" == $((previous_count + 1)) ]] ||
  die "generated_observation_count_error"

if [[ "$previous_exists" == "true" ]]; then
  [[ -f "$OBSERVATION_FILE" && ! -L "$OBSERVATION_FILE" ]] ||
    die "observation_changed_during_query"
  current_hash="$(sha256_file "$OBSERVATION_FILE")" ||
    die "observation_rehash_error"
  [[ "$current_hash" == "$previous_hash" ]] ||
    die "observation_changed_during_query"
else
  [[ ! -e "$OBSERVATION_FILE" && ! -L "$OBSERVATION_FILE" ]] ||
    die "observation_created_during_query"
fi

mv "$temporary_file" "$OBSERVATION_FILE" ||
  die "atomic_replace_error"
temporary_file=""

emit "recorder_result=recorded"
emit "recorder_observation_count=$BETSTAN_BILLING_OBS_COUNT"
emit "recorder_span_hours=$BETSTAN_BILLING_OBS_SPAN_HOURS"
