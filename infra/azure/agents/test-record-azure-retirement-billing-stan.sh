#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECORDER_SOURCE="$TEST_DIR/record-azure-retirement-billing-stan.sh"
LIBRARY_SOURCE="$TEST_DIR/azure-retirement-billing-lib-stan.sh"
# shellcheck source=azure-retirement-billing-lib-stan.sh
# shellcheck disable=SC1091
source "$LIBRARY_SOURCE"

WORK_PARENT="$(mktemp -d "${TEST_DIR}/.billing-recorder-tests.XXXXXX")"
chmod 0700 "$WORK_PARENT"
trap 'rm -rf "$WORK_PARENT"' EXIT

declare -i passed=0 failed=0
pass() { passed=$((passed + 1)); printf 'PASS %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s%s\n' "$1" "${2:+: $2}"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label" "expected=$expected actual=$actual"
  fi
}

assert_contains() {
  local value="$1" expected="$2" label="$3"
  if grep -Fq "$expected" <<<"$value"; then
    pass "$label"
  else
    fail "$label" "missing=$expected"
  fi
}

epoch_date() {
  local epoch="$1"
  date -u -r "$epoch" +%Y-%m-%d 2>/dev/null ||
    date -u -d "@${epoch}" +%Y-%m-%d
}

readonly SUBSCRIPTION_ID="12345678-1234-1234-1234-123456789abc"
SUBSCRIPTION_FINGERPRINT="$(
  printf '%s' "$SUBSCRIPTION_ID" | betstan_billing_sha256_text
)"
NOW_EPOCH="$(date -u +%s)"
MATURE_CUTOFF_EPOCH=$((NOW_EPOCH - 10 * 86400))
MATURE_CUTOFF_DATE="$(epoch_date "$MATURE_CUTOFF_EPOCH")"
POST_CUTOFF_USAGE_DATE="$(epoch_date "$((MATURE_CUTOFF_EPOCH + 86400))")"
POST_CUTOFF_USAGE_DATE="${POST_CUTOFF_USAGE_DATE//-/}"

make_recorder_fixture() {
  local directory="$1" cutoff_epoch="$2"
  local cutoff_date cutoff_usage query_start
  cutoff_date="$(epoch_date "$cutoff_epoch")"
  cutoff_usage="${cutoff_date//-/}"
  query_start="$(epoch_date "$((cutoff_epoch - 7 * 86400))")"
  mkdir -p "$directory"
  cp "$LIBRARY_SOURCE" "$directory/azure-retirement-billing-lib-stan.sh"
  sed \
    -e "s/^readonly CUTOFF_EPOCH=.*/readonly CUTOFF_EPOCH=${cutoff_epoch}/" \
    -e "s/^readonly CUTOFF_DATE=.*/readonly CUTOFF_DATE=\"${cutoff_date}\"/" \
    -e "s/^readonly CUTOFF_USAGE_DATE=.*/readonly CUTOFF_USAGE_DATE=\"${cutoff_usage}\"/" \
    -e "s/^readonly QUERY_START_DATE=.*/readonly QUERY_START_DATE=\"${query_start}\"/" \
    "$RECORDER_SOURCE" >"$directory/record-azure-retirement-billing-stan.sh"
  chmod 0700 "$directory/record-azure-retirement-billing-stan.sh"
}

create_provider_stub() {
  local directory="$1"
  mkdir -p "$directory"
  cat >"$directory/az" <<'AZ'
#!/usr/bin/env bash
set -euo pipefail
stub_arguments="$*"
trap 'stub_rc=$?; if [[ "$stub_rc" -ne 0 && -n "${STUB_DIAGNOSTIC_FILE:-}" ]]; then printf "rc=%s args=%s\n" "$stub_rc" "$stub_arguments" >"$STUB_DIAGNOSTIC_FILE"; fi' EXIT

if [[ "${1:-}" == "account" && "${2:-}" == "show" ]]; then
  printf '{"id":"%s","state":"Enabled"}\n' \
    "${STUB_SUBSCRIPTION_ID:-12345678-1234-1234-1234-123456789abc}"
  exit 0
fi

[[ "${1:-}" == "rest" ]] || exit 64
method=""
url=""
body=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --method) shift; method="${1:-}" ;;
    --url) shift; url="${1:-}" ;;
    --body) shift; body="${1:-}" ;;
  esac
  shift
done

if [[ "$url" == *"/providers/Microsoft.Consumption/usageDetails?"* ]]; then
  [[ "$method" == "get" && -z "$body" ]] || exit 70
  if [[ "$url" == *"MC_betstan-rg_betstan-aks_eastus"* ]]; then
    usage_group="MC_betstan-rg_betstan-aks_eastus"
  else
    usage_group="betstan-rg"
  fi
  usage_metric="${url#*metric=}"
  usage_metric="${usage_metric%%&*}"
  usage_date="${STUB_USAGE_DATE:-20991231}"
  usage_iso="${usage_date:0:4}-${usage_date:4:2}-${usage_date:6:2}T00:00:00Z"
  usage_subscription="${STUB_SUBSCRIPTION_ID}"
  case "${STUB_MODE:-clean}" in
    usage_subscription_case)
      usage_subscription="$(printf '%s' "$usage_subscription" | tr '[:lower:]' '[:upper:]')"
      ;;
    usage_wrong_subscription)
      usage_subscription="00000000-0000-0000-0000-000000000000"
      ;;
  esac
  usage_item() {
    local id_suffix="$1" cost="$2"
    jq -cn \
      --arg id "/usage/${usage_metric}/${usage_group}/${id_suffix}" \
      --arg subscription "$usage_subscription" \
      --arg resource_group "$usage_group" \
      --arg date "$usage_iso" \
      --argjson cost "$cost" '{
        id:$id,
        kind:"legacy",
        properties:{
          subscriptionId:$subscription,
          resourceGroup:$resource_group,
          cost:$cost,
          date:$date,
          billingCurrency:"USD",
          chargeType:(if $cost < 0 then "Refund" else "Usage" end)
        }
      }'
  }
  case "${STUB_MODE:-clean}" in
    usage_empty)
      ;;
    usage_subscription_case|usage_wrong_subscription)
      if [[ "$usage_group" == "betstan-rg" ]]; then
        item="$(usage_item subscription 0)"
        jq -cn --argjson item "$item" '{value:[$item]}'
      else
        printf '{"value":[]}\n'
      fi
      ;;
    usage_duplicate_arm_id)
      if [[ "$usage_group" == "betstan-rg" ]]; then
        zero_item="$(usage_item repeated 0)"
        positive_item="$(usage_item repeated 2)"
        jq -cn --argjson zero "$zero_item" --argjson positive "$positive_item" \
          '{value:[$zero,$positive]}'
      else
        printf '{"value":[]}\n'
      fi
      ;;
    negative)
      if [[ "$usage_group" == "betstan-rg" ]]; then
        item="$(usage_item negative -1.25)"
        jq -cn --argjson item "$item" '{value:[$item]}'
      else
        printf '{"value":[]}\n'
      fi
      ;;
    cancellation)
      if [[ "$usage_group" == "betstan-rg" ]]; then
        positive_item="$(usage_item positive 5)"
        negative_item="$(usage_item negative -5)"
        jq -cn --argjson positive "$positive_item" --argjson negative "$negative_item" \
          '{value:[$positive,$negative]}'
      else
        printf '{"value":[]}\n'
      fi
      ;;
    usage_paginated)
      usage_next="https://management.azure.com/subscriptions/${STUB_SUBSCRIPTION_ID}/providers/Microsoft.Consumption/usageDetails?api-version=2023-03-01&page=2"
      if [[ "$url" == *"%24filter="* && "$usage_group" == "betstan-rg" ]]; then
        jq -cn --arg next "$usage_next" '{value:[],nextLink:$next}'
      elif [[ "$url" == "$usage_next" ]]; then
        item="$(usage_item page2-positive 3)"
        jq -cn --argjson item "$item" '{value:[$item]}'
      else
        printf '{"value":[]}\n'
      fi
      ;;
    *)
      printf '{"value":[]}\n'
      ;;
  esac
  exit 0
fi

if [[ -n "${STUB_BLOCK_MARKER:-}" ]]; then
  : >"$STUB_BLOCK_MARKER"
  while [[ ! -e "${STUB_BLOCK_RELEASE:?}" ]]; do
    sleep 0.05
  done
fi
if [[ "${STUB_SIGNAL_PARENT:-0}" == "1" ]]; then
  kill -TERM "$PPID"
  exit 75
fi

cost_type=""
if [[ -n "$body" ]]; then
  cost_type="$(printf '%s' "$body" | jq -r '.type')"
fi
[[ "$method" == "post" ]] || exit 67
printf '%s' "$body" | jq -e \
  --arg resource_group "betstan-rg" \
  --arg managed_group "MC_betstan-rg_betstan-aks_eastus" '
    (.timePeriod.from | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$")) and
    (.timePeriod.to | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T23:59:59Z$")) and
    .dataset.filter.dimensions.name == "ResourceGroup" and
    .dataset.filter.dimensions.operator == "In" and
    (.dataset.filter.dimensions.values | sort) ==
      ([$resource_group, $managed_group] | sort)
  ' >/dev/null || exit 68
if [[ -n "${STUB_TRANSIENT_FAILURE_FILE:-}" ]]; then
  transient_attempt=0
  if [[ -f "$STUB_TRANSIENT_FAILURE_FILE" ]]; then
    transient_attempt="$(cat "$STUB_TRANSIENT_FAILURE_FILE")"
  fi
  transient_attempt=$((transient_attempt + 1))
  printf '%s\n' "$transient_attempt" >"$STUB_TRANSIENT_FAILURE_FILE"
  if [[ "$transient_attempt" -le "${STUB_TRANSIENT_FAILURES:-0}" ]]; then
    exit 69
  fi
fi
columns='[
  {"name":"Cost","type":"Number"},
  {"name":"UsageDate","type":"Number"},
  {"name":"ResourceGroup","type":"String"},
  {"name":"Currency","type":"String"}
]'
usage_date="${STUB_USAGE_DATE:-20991231}"

case "${STUB_MODE:-clean}" in
  clean|usage_empty|usage_subscription_case|usage_wrong_subscription|usage_duplicate_arm_id)
    jq -cn --argjson columns "$columns" \
      '{properties:{columns:$columns,rows:[]}}'
    ;;
  positive)
    jq -cn --argjson columns "$columns" --argjson date "$usage_date" \
      '{properties:{columns:$columns,rows:[[5.25,$date,"betstan-rg","USD"]]}}'
    ;;
  negative)
    jq -cn --argjson columns "$columns" --argjson date "$usage_date" \
      '{properties:{columns:$columns,rows:[[-1.25,$date,"betstan-rg","USD"]]}}'
    ;;
  cancellation)
    jq -cn --argjson columns "$columns" --argjson date "$usage_date" \
      '{properties:{columns:$columns,rows:[[0,$date,"betstan-rg","USD"]]}}'
    ;;
  usage_paginated)
    jq -cn --argjson columns "$columns" \
      '{properties:{columns:$columns,rows:[]}}'
    ;;
  mixed_currency)
    jq -cn --argjson columns "$columns" --argjson date "$usage_date" \
      '{properties:{columns:$columns,rows:[
        [1,$date,"unrelated-rg","USD"],
        [1,$date,"unrelated-rg","EUR"]
      ]}}'
    ;;
  bad_nextlink)
    jq -cn --argjson columns "$columns" \
      '{properties:{columns:$columns,rows:[],nextLink:{bad:true}}}'
    ;;
  bad_column_type)
    jq -cn '{
      properties:{
        columns:[
          {name:"Cost",type:"String"},
          {name:"UsageDate",type:"Number"},
          {name:"ResourceGroup",type:"String"},
          {name:"Currency",type:"String"}
        ],
        rows:[]
      }
    }'
    ;;
  paginated_reordered)
    next_url="https://management.azure.com/subscriptions/${STUB_SUBSCRIPTION_ID}/providers/Microsoft.CostManagement/Query?api-version=2021-10-01&page=2"
    if [[ "$url" == /subscriptions/* ]]; then
      jq -cn --argjson columns "$columns" --arg next "$next_url" '{
        properties:{
          columns:$columns,
          rows:[],
          nextLink:$next
        }
      }'
    elif [[ "$url" == "$next_url" ]]; then
      jq -cn --argjson date "$usage_date" '{
        properties:{
          columns:[
            {name:"Currency",type:"String"},
            {name:"ResourceGroup",type:"String"},
            {name:"Cost",type:"Number"},
            {name:"UsageDate",type:"Number"}
          ],
          rows:[["USD","betstan-rg",4.5,$date]]
        }
      }'
    else
      exit 65
    fi
    ;;
  cross_subscription_nextlink)
    jq -cn --argjson columns "$columns" '{
      properties:{
        columns:$columns,
        rows:[],
        nextLink:"https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.CostManagement/query?page=2"
      }
    }'
    ;;
  positive_actual_bad_amortized)
    if [[ "$cost_type" == "ActualCost" ]]; then
      jq -cn --argjson columns "$columns" --argjson date "$usage_date" \
        '{properties:{columns:$columns,rows:[[5.25,$date,"betstan-rg","USD"]]}}'
    else
      jq -cn '{
        properties:{
          columns:[
            {name:"Cost",type:"String"},
            {name:"UsageDate",type:"Number"},
            {name:"ResourceGroup",type:"String"},
            {name:"Currency",type:"String"}
          ],
          rows:[]
        }
      }'
    fi
    ;;
  clean_eur)
    jq -cn --argjson columns "$columns" --argjson date "$usage_date" \
      '{properties:{columns:$columns,rows:[[0,$date,"betstan-rg","EUR"]]}}'
    ;;
  cost_type_currency_mismatch)
    if [[ "$cost_type" == "ActualCost" ]]; then
      currency="USD"
    else
      currency="EUR"
    fi
    jq -cn --argjson columns "$columns" --argjson date "$usage_date" \
      --arg currency "$currency" \
      '{properties:{columns:$columns,rows:[[0,$date,"unrelated-rg",$currency]]}}'
    ;;
  *)
    exit 66
    ;;
esac
AZ
  chmod 0700 "$directory/az"
}

RUN_OUTPUT=""
RUN_RC=0
run_recorder() {
  local recorder="$1" stub_directory="$2" observation_file="$3"
  shift 3
  local -a environment=(
    "PATH=${stub_directory}:${PATH}"
    "OBSERVATION_FILE=${observation_file}"
    "AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}"
    "AZURE_SUBSCRIPTION_FINGERPRINT=${SUBSCRIPTION_FINGERPRINT}"
    "STUB_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}"
    "STUB_USAGE_DATE=${POST_CUTOFF_USAGE_DATE}"
    "STUB_DIAGNOSTIC_FILE=${observation_file}.stub-error"
  )
  while [[ $# -gt 0 ]]; do
    environment+=("$1")
    shift
  done
  RUN_RC=0
  RUN_OUTPUT="$(env -i "${environment[@]}" /bin/bash "$recorder" 2>&1)" ||
    RUN_RC=$?
  if [[ -f "${observation_file}.stub-error" ]]; then
    RUN_OUTPUT="${RUN_OUTPUT}"$'\n'"$(cat "${observation_file}.stub-error")"
  fi
}

write_observation() {
  local file="$1" cutoff_epoch="$2" cutoff_date="$3"
  shift 3
  local -a epochs=("$@")
  local entry epoch currency previous_chain="$BETSTAN_BILLING_ZERO_CHAIN"
  local epoch_csv="" actual_csv="" amortized_csv="" digest_csv=""
  local chain_csv="" currency_csv=""
  local digest_pair
  digest_pair="$(printf 'a%.0s' {1..64}):$(printf 'b%.0s' {1..64})"
  for entry in "${epochs[@]}"; do
    epoch="${entry%%:*}"
    if [[ "$entry" == *:* ]]; then
      currency="${entry#*:}"
    else
      currency="USD"
    fi
    local chain
    chain="$(betstan_billing_chain_hash \
      "$previous_chain" "$SUBSCRIPTION_FINGERPRINT" "$cutoff_epoch" \
      "$currency" "$epoch" "clean" "clean" "$digest_pair")"
    epoch_csv="${epoch_csv:+${epoch_csv},}${epoch}"
    actual_csv="${actual_csv:+${actual_csv},}clean"
    amortized_csv="${amortized_csv:+${amortized_csv},}clean"
    digest_csv="${digest_csv:+${digest_csv},}${digest_pair}"
    chain_csv="${chain_csv:+${chain_csv},}${chain}"
    currency_csv="${currency_csv:+${currency_csv},}${currency}"
    previous_chain="$chain"
  done
  local first_entry="${epochs[0]}"
  local last_entry="${epochs[$((${#epochs[@]} - 1))]}"
  local first="${first_entry%%:*}" last="${last_entry%%:*}"
  printf '%s\n' \
    "api_version=${BETSTAN_BILLING_API_VERSION}" \
    "currencies=${currency_csv}" \
    "cutoff_date=${cutoff_date}" \
    "cutoff_epoch=${cutoff_epoch}" \
    "observation_chain_sha256s=${chain_csv}" \
    "observation_epochs=${epoch_csv}" \
    "recorder_version=${BETSTAN_BILLING_RECORDER_VERSION}" \
    "response_digests=${digest_csv}" \
    "results_actual=${actual_csv}" \
    "results_amortized=${amortized_csv}" \
    "schema=${BETSTAN_BILLING_SCHEMA}" \
    "subscription_fingerprint=${SUBSCRIPTION_FINGERPRINT}" \
    "total_span_hours=$(((last - first) / 3600))" \
    "usage_api_version=${BETSTAN_BILLING_USAGE_API_VERSION}" \
    >"$file"
  chmod 0600 "$file"
}

new_case() {
  local name="$1"
  CASE_DIR="$WORK_PARENT/$name"
  STATE_DIR="$CASE_DIR/state"
  STUB_DIR="$CASE_DIR/bin"
  RUNTIME_DIR="$CASE_DIR/runtime"
  mkdir -p "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
  create_provider_stub "$STUB_DIR"
  make_recorder_fixture "$RUNTIME_DIR" "$MATURE_CUTOFF_EPOCH"
  RECORDER="$RUNTIME_DIR/record-azure-retirement-billing-stan.sh"
  OBSERVATION="$STATE_DIR/billing-observations.env"
}

printf '%s\n' "Running billing recorder contract tests"

new_case missing-input
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" "OBSERVATION_FILE="
assert_eq 2 "$RUN_RC" "missing recorder input is malformed"
assert_contains "$RUN_OUTPUT" "missing_observation_file" \
  "missing recorder input uses the error contract"

new_case first-record
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 0 "$RUN_RC" "first record exits zero"
assert_contains "$RUN_OUTPUT" "recorder_result=recorded" "first record reports success"
if [[ -f "$OBSERVATION" ]]; then
  pass "first record creates evidence"
else
  fail "first record creates evidence"
fi
mode="missing"
if [[ -f "$OBSERVATION" ]]; then
  mode="$(stat -f '%Lp' "$OBSERVATION" 2>/dev/null ||
    stat -c '%a' "$OBSERVATION")"
fi
assert_eq 600 "$mode" "evidence mode is private"
if betstan_billing_validate_observation_file \
  "$OBSERVATION" "$SUBSCRIPTION_FINGERPRINT" \
  "$MATURE_CUTOFF_EPOCH" "$MATURE_CUTOFF_DATE"; then
  pass "first record validates through shared contract"
else
  fail "first record validates through shared contract" "$BETSTAN_BILLING_ERROR_REASON"
fi

new_case append
prior_epoch=$((NOW_EPOCH - 2 * 86400))
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$MATURE_CUTOFF_DATE" "$prior_epoch"
prior_chain="$(betstan_billing_state_field "$OBSERVATION" observation_chain_sha256s)"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 0 "$RUN_RC" "append exits zero"
epoch_list="$(betstan_billing_state_field "$OBSERVATION" observation_epochs)"
assert_contains "$epoch_list" "${prior_epoch}," "append preserves epoch prefix"
chains="$(betstan_billing_state_field "$OBSERVATION" observation_chain_sha256s)"
assert_contains "$chains" "${prior_chain}," "append preserves chain prefix"

new_case grace
recent_cutoff=$((NOW_EPOCH - 3600))
make_recorder_fixture "$RUNTIME_DIR" "$recent_cutoff"
RECORDER="$RUNTIME_DIR/record-azure-retirement-billing-stan.sh"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 1 "$RUN_RC" "grace window exits skip"
assert_contains "$RUN_OUTPUT" "recorder_skip=cutoff_grace_incomplete" \
  "grace window is explicit"
if [[ ! -e "$OBSERVATION" ]]; then
  pass "grace window creates no evidence"
else
  fail "grace window creates no evidence"
fi

new_case positive
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" "STUB_MODE=positive"
assert_eq 1 "$RUN_RC" "positive post-cutoff cost exits skip"
assert_contains "$RUN_OUTPUT" "recorder_result=nogo" "positive cost is NO_GO"
if [[ ! -e "$OBSERVATION" ]]; then
  pass "positive cost creates no evidence"
else
  fail "positive cost creates no evidence"
fi

new_case billing-boundary
boundary_usage_date="${MATURE_CUTOFF_DATE//-/}"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=positive" "STUB_USAGE_DATE=${boundary_usage_date}"
assert_eq 1 "$RUN_RC" "first full UTC billing day is included"
assert_contains "$RUN_OUTPUT" "recorder_result=nogo" \
  "billing boundary has no intra-day attribution claim"

new_case transient-api
transient_counter="$CASE_DIR/transient-attempts"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_TRANSIENT_FAILURE_FILE=${transient_counter}" \
  "STUB_TRANSIENT_FAILURES=1"
assert_eq 0 "$RUN_RC" "transient Cost Management failure is retried"
assert_eq 3 "$(cat "$transient_counter")" \
  "retry repeats only the failed exact request"
assert_contains "$RUN_OUTPUT" "recorder_result=recorded" \
  "transient retry preserves a clean observation"

new_case negative
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" "STUB_MODE=negative"
assert_eq 1 "$RUN_RC" "negative adjustment exits skip"
assert_contains "$RUN_OUTPUT" "recorder_skip=post_cutoff_adjustment" \
  "negative adjustment remains pending"
if [[ ! -e "$OBSERVATION" ]]; then
  pass "negative adjustment creates no evidence"
else
  fail "negative adjustment creates no evidence"
fi

new_case mixed-currency
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" "STUB_MODE=mixed_currency"
assert_eq 2 "$RUN_RC" "mixed currency fails closed"
assert_contains "$RUN_OUTPUT" "mixed_currency" "mixed currency reason is explicit"

new_case cost-type-currency
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=cost_type_currency_mismatch"
assert_eq 2 "$RUN_RC" "cost types with different currencies fail closed"
assert_contains "$RUN_OUTPUT" "cost_type_currency_mismatch" \
  "cost type currency mismatch is explicit"

new_case pagination
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=paginated_reordered"
assert_eq 1 "$RUN_RC" "reordered second page retains positive cost"
assert_contains "$RUN_OUTPUT" "recorder_result=nogo" \
  "pagination is normalized before classification"

new_case cancellation
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=cancellation"
assert_eq 1 "$RUN_RC" "positive charge cannot net against refund"
assert_contains "$RUN_OUTPUT" "recorder_result=nogo" \
  "item-level usage details preserve positive precedence"

new_case usage-pagination
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=usage_paginated"
assert_eq 1 "$RUN_RC" "usage-detail continuation retains positive cost"
assert_contains "$RUN_OUTPUT" "recorder_result=nogo" \
  "usage-detail pagination is classified"

new_case usage-empty-response
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=usage_empty"
assert_eq 2 "$RUN_RC" "empty usage-detail success fails closed"
assert_contains "$RUN_OUTPUT" "usage_row_contract_error" \
  "empty usage-detail success is not treated as no rows"

new_case usage-subscription-case
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=usage_subscription_case"
assert_eq 0 "$RUN_RC" "subscription GUID casing is semantic"
assert_contains "$RUN_OUTPUT" "recorder_result=recorded" \
  "case-variant subscription remains fingerprint-bound"

new_case usage-wrong-subscription
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=usage_wrong_subscription"
assert_eq 2 "$RUN_RC" "foreign usage subscription fails closed"
assert_contains "$RUN_OUTPUT" "usage_row_contract_error" \
  "case-insensitive comparison does not accept another subscription"

new_case usage-duplicate-arm-id
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=usage_duplicate_arm_id"
assert_eq 1 "$RUN_RC" "repeated ARM id retains positive charge"
assert_contains "$RUN_OUTPUT" "recorder_result=nogo" \
  "resource-shaped ARM ids are not treated as line-item keys"

new_case cross-subscription-nextlink
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=cross_subscription_nextlink"
assert_eq 2 "$RUN_RC" "cross-subscription nextLink fails closed"
assert_contains "$RUN_OUTPUT" "nextlink_invalid" \
  "continuation remains bound to the exact subscription endpoint"

new_case positive-with-malformed-peer
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=positive_actual_bad_amortized"
assert_eq 1 "$RUN_RC" "known positive cost dominates malformed peer query"
assert_contains "$RUN_OUTPUT" "recorder_result=nogo" \
  "known positive cost cannot become an unknown result"

new_case malformed-nextlink
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" "STUB_MODE=bad_nextlink"
assert_eq 2 "$RUN_RC" "malformed nextLink fails closed"
assert_contains "$RUN_OUTPUT" "nextlink_type_error" \
  "malformed nextLink reason is explicit"

new_case malformed-columns
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "STUB_MODE=bad_column_type"
assert_eq 2 "$RUN_RC" "wrong column metadata fails closed"
assert_contains "$RUN_OUTPUT" "column_contract_error" \
  "column metadata is validated"

new_case fingerprint
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" \
  "AZURE_SUBSCRIPTION_FINGERPRINT=$(printf '0%.0s' {1..64})"
assert_eq 2 "$RUN_RC" "subscription fingerprint mismatch fails"
assert_contains "$RUN_OUTPUT" "subscription_fingerprint_mismatch" \
  "subscription hash is recomputed"

new_case tampered-chain
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$MATURE_CUTOFF_DATE" "$((NOW_EPOCH - 2 * 86400))"
chain_before="$(betstan_billing_state_field "$OBSERVATION" observation_chain_sha256s)"
if [[ "$chain_before" == 0* ]]; then
  sed -i.bak \
    's/^observation_chain_sha256s=0/observation_chain_sha256s=1/' \
    "$OBSERVATION"
else
  sed -i.bak \
    's/^observation_chain_sha256s=./observation_chain_sha256s=0/' \
    "$OBSERVATION"
fi
rm -f "$OBSERVATION.bak"
chain_after="$(betstan_billing_state_field "$OBSERVATION" observation_chain_sha256s)"
if [[ "$chain_after" != "$chain_before" ]]; then
  pass "chain tamper fixture changes evidence"
else
  fail "chain tamper fixture changes evidence"
fi
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 2 "$RUN_RC" "tampered chain fails closed"
assert_contains "$RUN_OUTPUT" "observation_chain_mismatch" \
  "tampered chain is detected"

new_case duplicate-field
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$MATURE_CUTOFF_DATE" "$((NOW_EPOCH - 2 * 86400))"
printf 'schema=%s\n' "$BETSTAN_BILLING_SCHEMA" >>"$OBSERVATION"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 2 "$RUN_RC" "duplicate prior field fails closed"
assert_contains "$RUN_OUTPUT" "observation_field_set" \
  "duplicate prior field is detected"

new_case span-tamper
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$MATURE_CUTOFF_DATE" "$((NOW_EPOCH - 3 * 86400))" "$((NOW_EPOCH - 2 * 86400))"
sed -i.bak 's/^total_span_hours=.*/total_span_hours=999/' "$OBSERVATION"
rm -f "$OBSERVATION.bak"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 2 "$RUN_RC" "tampered span fails closed"
assert_contains "$RUN_OUTPUT" "observation_span_mismatch" \
  "span is recomputed"

new_case digest-tamper
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$MATURE_CUTOFF_DATE" "$((NOW_EPOCH - 2 * 86400))"
sed -i.bak 's/^response_digests=.*/response_digests=not-a-digest/' \
  "$OBSERVATION"
rm -f "$OBSERVATION.bak"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 2 "$RUN_RC" "malformed response digest fails closed"
assert_contains "$RUN_OUTPUT" "observation_digests_invalid" \
  "response digest format is exact"

new_case interval
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$MATURE_CUTOFF_DATE" "$((NOW_EPOCH - 3600))"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 1 "$RUN_RC" "short append interval is skipped"
assert_contains "$RUN_OUTPUT" "recorder_skip=minimum_interval_not_reached" \
  "minimum interval is explicit"

new_case future-prior
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$MATURE_CUTOFF_DATE" "$((NOW_EPOCH + 3600))"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 2 "$RUN_RC" "future prior observation fails closed"
assert_contains "$RUN_OUTPUT" "observation_last_epoch_not_past" \
  "future prior observation is not an interval skip"

new_case established-currency
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$MATURE_CUTOFF_DATE" \
  "$((NOW_EPOCH - 4 * 86400)):USD" \
  "$((NOW_EPOCH - 2 * 86400)):NO_ROWS"
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION" "STUB_MODE=clean_eur"
assert_eq 2 "$RUN_RC" "currency compares with last established value"
assert_contains "$RUN_OUTPUT" "observation_currency_changed" \
  "trailing NO_ROWS cannot reset currency continuity"

new_case signal-termination
marker="$CASE_DIR/signal.marker"
release="$CASE_DIR/signal.release"
signal_output="$CASE_DIR/signal.out"
env -i \
  "PATH=${STUB_DIR}:${PATH}" \
  "OBSERVATION_FILE=${OBSERVATION}" \
  "AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  "AZURE_SUBSCRIPTION_FINGERPRINT=${SUBSCRIPTION_FINGERPRINT}" \
  "STUB_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  "STUB_USAGE_DATE=${POST_CUTOFF_USAGE_DATE}" \
  "STUB_BLOCK_MARKER=${marker}" \
  "STUB_BLOCK_RELEASE=${release}" \
  /bin/bash "$RECORDER" >"$signal_output" 2>&1 &
signal_pid=$!
for _ in {1..200}; do
  [[ -e "$marker" ]] && break
  sleep 0.05
done
kill -TERM "$signal_pid"
touch "$release"
signal_rc=0
if wait "$signal_pid"; then
  signal_rc=0
else
  signal_rc=$?
fi
assert_eq 143 "$signal_rc" "TERM exits with signal-derived status"
leftovers="$(find "$STATE_DIR" -name '*.tmp.*' -o -name '*.lock' | wc -l | tr -d ' ')"
assert_eq 0 "$leftovers" "TERM cleanup removes the recorder lock"
if [[ ! -e "$OBSERVATION" ]]; then
  pass "TERM creates no billing evidence"
else
  fail "TERM creates no billing evidence"
fi

new_case stale-lock-recovery
marker="$CASE_DIR/stale.marker"
release="$CASE_DIR/stale.release"
stale_output="$CASE_DIR/stale.out"
env -i \
  "PATH=${STUB_DIR}:${PATH}" \
  "OBSERVATION_FILE=${OBSERVATION}" \
  "AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  "AZURE_SUBSCRIPTION_FINGERPRINT=${SUBSCRIPTION_FINGERPRINT}" \
  "STUB_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  "STUB_USAGE_DATE=${POST_CUTOFF_USAGE_DATE}" \
  "STUB_BLOCK_MARKER=${marker}" \
  "STUB_BLOCK_RELEASE=${release}" \
  /bin/bash "$RECORDER" >"$stale_output" 2>&1 &
stale_pid=$!
for _ in {1..200}; do
  [[ -e "$marker" ]] && break
  sleep 0.05
done
kill -KILL "$stale_pid"
stale_rc=0
if wait "$stale_pid"; then
  stale_rc=0
else
  stale_rc=$?
fi
touch "$release"
assert_eq 137 "$stale_rc" "SIGKILL leaves an unclean recorder exit"
if [[ -f "${OBSERVATION}.lock" ]]; then
  pass "SIGKILL leaves recoverable lock evidence"
else
  fail "SIGKILL leaves recoverable lock evidence"
fi
run_recorder "$RECORDER" "$STUB_DIR" "$OBSERVATION"
assert_eq 0 "$RUN_RC" "dead lock owner is recovered"
assert_contains "$RUN_OUTPUT" "recorder_result=recorded" \
  "stale lock recovery preserves the observation contract"
leftovers="$(
  find "$STATE_DIR" \( -name '*.tmp.*' -o -name '*.lock' \
    -o -name '*.lock-owner.*' -o -name '*.query.*' \) |
    wc -l | tr -d ' '
)"
assert_eq 0 "$leftovers" "stale recovery removes exact lock artifacts"

new_case lock-contention
marker="$CASE_DIR/block.marker"
release="$CASE_DIR/block.release"
first_output="$CASE_DIR/first.out"
second_output="$CASE_DIR/second.out"
env -i \
  "PATH=${STUB_DIR}:${PATH}" \
  "OBSERVATION_FILE=${OBSERVATION}" \
  "AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  "AZURE_SUBSCRIPTION_FINGERPRINT=${SUBSCRIPTION_FINGERPRINT}" \
  "STUB_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  "STUB_USAGE_DATE=${POST_CUTOFF_USAGE_DATE}" \
  "STUB_BLOCK_MARKER=${marker}" \
  "STUB_BLOCK_RELEASE=${release}" \
  /bin/bash "$RECORDER" >"$first_output" 2>&1 &
first_pid=$!
for _ in {1..200}; do
  [[ -e "$marker" ]] && break
  sleep 0.05
done
[[ -e "$marker" ]] || {
  touch "$release"
  if wait "$first_pid"; then
    fail "first recorder reaches blocked provider query" "exited before marker"
  else
    fail "first recorder reaches blocked provider query" "rc=$?"
  fi
}
second_rc=0
env -i \
  "PATH=${STUB_DIR}:${PATH}" \
  "OBSERVATION_FILE=${OBSERVATION}" \
  "AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  "AZURE_SUBSCRIPTION_FINGERPRINT=${SUBSCRIPTION_FINGERPRINT}" \
  "STUB_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  /bin/bash "$RECORDER" >"$second_output" 2>&1 ||
  second_rc=$?
touch "$release"
first_rc=0
if wait "$first_pid"; then
  first_rc=0
else
  first_rc=$?
fi
assert_eq 0 "$first_rc" "lock holder records successfully"
assert_eq 2 "$second_rc" "contending recorder fails explicitly"
assert_contains "$(cat "$second_output")" "lock_contended" \
  "contention reports lock state"

new_case write-race
write_observation "$OBSERVATION" "$MATURE_CUTOFF_EPOCH" \
  "$MATURE_CUTOFF_DATE" "$((NOW_EPOCH - 2 * 86400))"
cp "$OBSERVATION" "$CASE_DIR/prior-copy"
marker="$CASE_DIR/race.marker"
release="$CASE_DIR/race.release"
race_output="$CASE_DIR/race.out"
env -i \
  "PATH=${STUB_DIR}:${PATH}" \
  "OBSERVATION_FILE=${OBSERVATION}" \
  "AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  "AZURE_SUBSCRIPTION_FINGERPRINT=${SUBSCRIPTION_FINGERPRINT}" \
  "STUB_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}" \
  "STUB_USAGE_DATE=${POST_CUTOFF_USAGE_DATE}" \
  "STUB_BLOCK_MARKER=${marker}" \
  "STUB_BLOCK_RELEASE=${release}" \
  /bin/bash "$RECORDER" >"$race_output" 2>&1 &
race_pid=$!
for _ in {1..200}; do
  [[ -e "$marker" ]] && break
  sleep 0.05
done
printf 'external-change=true\n' >"$OBSERVATION"
chmod 0600 "$OBSERVATION"
touch "$release"
race_rc=0
if wait "$race_pid"; then
  race_rc=0
else
  race_rc=$?
fi
assert_eq 2 "$race_rc" "mid-query evidence race fails closed"
assert_contains "$(cat "$race_output")" "observation_changed_during_query" \
  "mid-query race is detected"
assert_eq "external-change=true" "$(cat "$OBSERVATION")" \
  "recorder does not overwrite raced destination"
leftovers="$(
  find "$STATE_DIR" \( -name '*.tmp.*' -o -name '*.lock' \
    -o -name '*.lock-owner.*' -o -name '*.query.*' \) |
    wc -l | tr -d ' '
)"
assert_eq 0 "$leftovers" "race cleanup removes owned temporary state"
if betstan_billing_validate_observation_file \
  "$CASE_DIR/prior-copy" "$SUBSCRIPTION_FINGERPRINT" \
  "$MATURE_CUTOFF_EPOCH" "$MATURE_CUTOFF_DATE"; then
  pass "saved prior evidence remains valid"
else
  fail "saved prior evidence remains valid" "$BETSTAN_BILLING_ERROR_REASON"
fi

printf 'billing_recorder_tests passed=%d failed=%d total=%d\n' \
  "$passed" "$failed" "$((passed + failed))"
[[ "$failed" -eq 0 ]]
