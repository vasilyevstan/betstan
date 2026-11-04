#!/usr/bin/env bash

# Shared, source-only Cost Management and billing-observation contract.

readonly BETSTAN_BILLING_SCHEMA="betstan.billing-observation.v4"
readonly BETSTAN_BILLING_RECORDER_VERSION="3"
readonly BETSTAN_BILLING_API_VERSION="2023-11-01"
readonly BETSTAN_BILLING_USAGE_API_VERSION="2023-05-01"
readonly BETSTAN_BILLING_MAX_NEXTLINK_PAGES=10
readonly BETSTAN_BILLING_API_MAX_ATTEMPTS=4
readonly BETSTAN_BILLING_API_RETRY_SECONDS=2
readonly BETSTAN_BILLING_GRACE_SECONDS=$((96 * 3600))
readonly BETSTAN_BILLING_MIN_GAP_SECONDS=$((24 * 3600))
readonly BETSTAN_BILLING_ZERO_CHAIN="0000000000000000000000000000000000000000000000000000000000000000"
readonly BETSTAN_BILLING_RESOURCE_GROUP="betstan-rg"
readonly BETSTAN_BILLING_MANAGED_GROUP="MC_betstan-rg_betstan-aks_eastus"

# shellcheck disable=SC2034 # Public outputs consumed by sourcing operators.
BETSTAN_BILLING_ERROR_REASON=""
# shellcheck disable=SC2034
BETSTAN_BILLING_OBS_COUNT=0
# shellcheck disable=SC2034
BETSTAN_BILLING_OBS_FIRST_EPOCH=""
# shellcheck disable=SC2034
BETSTAN_BILLING_OBS_LAST_EPOCH=""
# shellcheck disable=SC2034
BETSTAN_BILLING_OBS_SPAN_HOURS=0
# shellcheck disable=SC2034
BETSTAN_BILLING_OBS_LAST_CURRENCY=""
# shellcheck disable=SC2034
BETSTAN_BILLING_OBS_CURRENCY=""

betstan_billing_sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

betstan_billing_fail() {
  BETSTAN_BILLING_ERROR_REASON="$1"
  return 1
}

betstan_billing_state_field() {
  local file="$1" key="$2" count
  count="$(grep -c "^${key}=" "$file" || true)"
  [[ "$count" == "1" ]] || return 1
  sed -n "s/^${key}=//p" "$file"
}

betstan_billing_chain_hash() {
  local previous="$1" subscription_fingerprint="$2" cutoff_epoch="$3"
  local currency="$4" epoch="$5" actual_result="$6"
  local amortized_result="$7" response_digests="$8"

  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' \
    "$previous" \
    "$subscription_fingerprint" \
    "$cutoff_epoch" \
    "$BETSTAN_BILLING_API_VERSION" \
    "$BETSTAN_BILLING_USAGE_API_VERSION" \
    "$currency" \
    "$epoch" \
    "$actual_result" \
    "$amortized_result" \
    "$response_digests" |
    betstan_billing_sha256_text
}

betstan_billing_next_date() {
  local value="$1"
  date -u -j -v+1d -f '%Y-%m-%d' "$value" +%Y-%m-%d 2>/dev/null ||
    date -u -d "${value} + 1 day" +%Y-%m-%d 2>/dev/null
}

# Query unaggregated usage details so a positive charge cannot be hidden by a
# same-day refund in the Cost Management aggregate.
betstan_billing_query_usage_details() {
  local cost_type="$1" subscription_id="$2" query_start="$3"
  local query_end="$4" first_usage_date="$5" output_file="$6"
  local query_start_int="${query_start//-/}"
  local query_end_int="${query_end//-/}"
  local usage_end

  usage_end="$(betstan_billing_next_date "$query_end")" ||
    betstan_billing_fail "usage_end_date_error" || return 1
  [[ "$usage_end" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
    betstan_billing_fail "usage_end_date_invalid" || return 1

  local all_rows="[]" page_digests=""
  local -a resource_groups=(
    "$BETSTAN_BILLING_RESOURCE_GROUP"
    "$BETSTAN_BILLING_MANAGED_GROUP"
  )
  local resource_group
  for resource_group in "${resource_groups[@]}"; do
    local filter
    filter="properties%2FusageStart%20ge%20%27${query_start}%27%20and%20properties%2FusageEnd%20le%20%27${usage_end}%27%20and%20properties%2FresourceGroup%20eq%20%27${resource_group}%27"
    local page_url
    page_url="https://management.azure.com/subscriptions/${subscription_id}/providers/Microsoft.Consumption/usageDetails?api-version=${BETSTAN_BILLING_USAGE_API_VERSION}&metric=${cost_type}&%24top=1000&%24filter=${filter}"
    local expected_path
    expected_path="https://management.azure.com/subscriptions/${subscription_id}/providers/Microsoft.Consumption/usageDetails"
    local expected_path_lower
    expected_path_lower="$(printf '%s' "$expected_path" | tr '[:upper:]' '[:lower:]')" ||
      betstan_billing_fail "usage_nextlink_path_error" || return 1
    local pages=0 visited_urls=""

    while [[ -n "$page_url" ]]; do
      pages=$((pages + 1))
      [[ "$pages" -le "$BETSTAN_BILLING_MAX_NEXTLINK_PAGES" ]] ||
        betstan_billing_fail "usage_too_many_pages" || return 1
      if printf '%s' "$visited_urls" | grep -Fxq "$page_url"; then
        betstan_billing_fail "usage_nextlink_cycle"
        return 1
      fi
      visited_urls="${visited_urls}${page_url}"$'\n'

      local response="" api_attempt=1
      while [[ "$api_attempt" -le "$BETSTAN_BILLING_API_MAX_ATTEMPTS" ]]; do
        if response="$(az rest --method get --url "$page_url" 2>/dev/null)"; then
          break
        fi
        if [[ "$api_attempt" == "$BETSTAN_BILLING_API_MAX_ATTEMPTS" ]]; then
          betstan_billing_fail "usage_api_error"
          return 1
        fi
        local retry_seconds=$((BETSTAN_BILLING_API_RETRY_SECONDS << (api_attempt - 1)))
        sleep "$retry_seconds" ||
          betstan_billing_fail "usage_retry_sleep_error" || return 1
        api_attempt=$((api_attempt + 1))
      done

      local normalized_rows
      normalized_rows="$(jq -ce \
        --arg subscription "$subscription_id" \
        --arg resource_group "$resource_group" \
        --argjson query_start "$query_start_int" \
        --argjson query_end "$query_end_int" '
          def leap_year($year):
            (($year % 4) == 0 and ($year % 100) != 0) or
            (($year % 400) == 0);
          def days_in_month($year; $month):
            if ($month == 2)
            then (if leap_year($year) then 29 else 28 end)
            elif ([4, 6, 9, 11] | index($month)) != null
            then 30
            else 31
            end;
          def date_number($value):
            ($value[0:10] | gsub("-"; "") | tonumber);
          def valid_date($value):
            if (($value | type) == "string" and
                (try ($value | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")) catch false))
            then
              date_number($value) as $date |
              (($date / 10000) | floor) as $year |
              ((($date % 10000) / 100) | floor) as $month |
              ($date % 100) as $day |
              ($date >= $query_start and $date <= $query_end and
               $month >= 1 and $month <= 12 and
               $day >= 1 and $day <= days_in_month($year; $month))
            else false
            end;
          if type == "object" and
             (.value | type) == "array" and
             all(.value[];
               type == "object" and
               (.id | type) == "string" and (.id | length) > 0 and
               .kind == "legacy" and
               (.properties | type) == "object" and
               (.properties.subscriptionId | type) == "string" and
               (.properties.subscriptionId | ascii_downcase) ==
                 ($subscription | ascii_downcase) and
               (.properties.resourceGroup | type) == "string" and
               (.properties.resourceGroup | ascii_downcase) ==
                 ($resource_group | ascii_downcase) and
               (.properties.cost | type) == "number" and
               valid_date(.properties.date) and
               (.properties.billingCurrency | type) == "string" and
               (try (.properties.billingCurrency | test("^[A-Z]{3}$")) catch false) and
               (.properties.chargeType | type) == "string" and
               (.properties.chargeType | length) > 0
             )
          then [
            .value[] | {
              id: .id,
              cost: .properties.cost,
              date: date_number(.properties.date),
              resource_group: .properties.resourceGroup,
              currency: .properties.billingCurrency,
              charge_type: .properties.chargeType
            }
          ]
          else error("invalid usage details")
          end
        ' <<<"$response" 2>/dev/null)" ||
        betstan_billing_fail "usage_row_contract_error" || return 1

      all_rows="$(jq -cn \
        --argjson prior "$all_rows" \
        --argjson page "$normalized_rows" \
        '$prior + $page' 2>/dev/null)" ||
        betstan_billing_fail "usage_row_merge_error" || return 1

      local page_digest
      page_digest="$(printf '%s' "$response" | betstan_billing_sha256_text)" ||
        betstan_billing_fail "usage_page_digest_error" || return 1
      [[ "$page_digest" =~ ^[0-9a-f]{64}$ ]] ||
        betstan_billing_fail "usage_page_digest_invalid" || return 1
      page_digests="${page_digests}${resource_group}:${page_digest}"$'\n'

      local nextlink_type nextlink=""
      nextlink_type="$(jq -r '
        if has("nextLink") then (.nextLink | type) else "missing" end
      ' <<<"$response" 2>/dev/null)" ||
        betstan_billing_fail "usage_nextlink_parse_error" || return 1
      case "$nextlink_type" in
        missing|null)
          page_url=""
          ;;
        string)
          nextlink="$(jq -r '.nextLink' <<<"$response" 2>/dev/null)" ||
            betstan_billing_fail "usage_nextlink_parse_error" || return 1
          if [[ -z "$nextlink" ]]; then
            page_url=""
          else
            local nextlink_path="${nextlink%%\?*}"
            local nextlink_path_lower
            nextlink_path_lower="$(
              printf '%s' "$nextlink_path" | tr '[:upper:]' '[:lower:]'
            )" || betstan_billing_fail "usage_nextlink_path_error" || return 1
            [[ "$nextlink" == *"?"* &&
               "$nextlink_path_lower" == "$expected_path_lower" &&
               "$nextlink" != *$'\n'* && "$nextlink" != *$'\r'* ]] ||
              betstan_billing_fail "usage_nextlink_invalid" || return 1
            page_url="$nextlink"
          fi
          ;;
        *)
          betstan_billing_fail "usage_nextlink_type_error"
          return 1
          ;;
      esac
    done
  done

  local row_count
  row_count="$(jq -r 'length' <<<"$all_rows" 2>/dev/null)" ||
    betstan_billing_fail "usage_row_count_error" || return 1
  [[ "$row_count" =~ ^[0-9]+$ ]] ||
    betstan_billing_fail "usage_row_count_invalid" || return 1

  local currency_count currency
  currency_count="$(jq -r '[.[].currency] | unique | length' <<<"$all_rows" 2>/dev/null)" ||
    betstan_billing_fail "usage_currency_count_error" || return 1
  if [[ "$currency_count" == "0" ]]; then
    currency="NO_ROWS"
  elif [[ "$currency_count" == "1" ]]; then
    currency="$(jq -r '[.[].currency] | unique | .[0]' <<<"$all_rows")"
  else
    betstan_billing_fail "usage_mixed_currency"
    return 1
  fi

  local analysis positive negative zero result
  analysis="$(jq -c --arg first_usage_date "$first_usage_date" '
    [.[] | select((.date | tostring) >= $first_usage_date)] |
    {
      positive: ([.[] | select(.cost > 0)] | length),
      negative: ([.[] | select(.cost < 0)] | length),
      zero: ([.[] | select(.cost == 0)] | length)
    }
  ' <<<"$all_rows" 2>/dev/null)" ||
    betstan_billing_fail "usage_classification_error" || return 1
  positive="$(jq -r '.positive' <<<"$analysis")"
  negative="$(jq -r '.negative' <<<"$analysis")"
  zero="$(jq -r '.zero' <<<"$analysis")"
  if [[ "$positive" -gt 0 ]]; then
    result="nogo"
  elif [[ "$negative" -gt 0 ]]; then
    result="pending_adjustment"
  else
    result="clean"
  fi

  local response_digest
  response_digest="$(printf '%s' "$page_digests" | betstan_billing_sha256_text)" ||
    betstan_billing_fail "usage_response_digest_error" || return 1
  jq -cn \
    --arg result "$result" \
    --arg currency "$currency" \
    --arg response_digest "$response_digest" \
    --argjson row_count "$row_count" \
    --argjson positive "$positive" \
    --argjson negative "$negative" \
    --argjson zero "$zero" '{
      result: $result,
      currency: $currency,
      response_digest: $response_digest,
      row_count: $row_count,
      positive: $positive,
      negative: $negative,
      zero: $zero
    }' >"$output_file" ||
    betstan_billing_fail "usage_result_write_error" || return 1
}

# Query one cost type and write a validated, normalized result object:
# {cost_type,result,currency,response_digest,row_count,positive,negative,zero}
betstan_billing_query_cost_type() {
  local cost_type="$1" subscription_id="$2" query_start="$3"
  local query_end="$4" first_usage_date="$5" output_file="$6"
  local query_start_int="${query_start//-/}"
  local query_end_int="${query_end//-/}"

  BETSTAN_BILLING_ERROR_REASON=""
  [[ "$cost_type" == "ActualCost" || "$cost_type" == "AmortizedCost" ]] ||
    betstan_billing_fail "invalid_cost_type" || return 1
  [[ "$subscription_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
    betstan_billing_fail "invalid_subscription_id" || return 1
  [[ "$query_start" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ &&
     "$query_end" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ &&
     "$first_usage_date" =~ ^[0-9]{8}$ ]] ||
    betstan_billing_fail "invalid_query_dates" || return 1
  [[ -d "$(dirname "$output_file")" ]] ||
    betstan_billing_fail "result_parent_missing" || return 1

  local request_body
  request_body="$(jq -cn \
    --arg type "$cost_type" \
    --arg from "${query_start}T00:00:00Z" \
    --arg to "${query_end}T23:59:59Z" \
    --arg resource_group "$BETSTAN_BILLING_RESOURCE_GROUP" \
    --arg managed_group "$BETSTAN_BILLING_MANAGED_GROUP" '{
      type: $type,
      timeframe: "Custom",
      timePeriod: {from: $from, to: $to},
      dataset: {
        granularity: "Daily",
        aggregation: {totalCost: {name: "Cost", function: "Sum"}},
        grouping: [{type: "Dimension", name: "ResourceGroup"}],
        filter: {
          dimensions: {
            name: "ResourceGroup",
            operator: "In",
            values: [$resource_group, $managed_group]
          }
        }
      }
    }')" ||
    betstan_billing_fail "request_body_error" || return 1

  local initial_url="/subscriptions/${subscription_id}/providers/Microsoft.CostManagement/query?api-version=${BETSTAN_BILLING_API_VERSION}"
  local continuation_prefix="https://management.azure.com/subscriptions/${subscription_id}/providers/Microsoft.CostManagement/query?"
  local page_url="$initial_url" pages=0
  local all_rows="[]" page_digests="" visited_urls=""

  while [[ -n "$page_url" ]]; do
    pages=$((pages + 1))
    [[ "$pages" -le "$BETSTAN_BILLING_MAX_NEXTLINK_PAGES" ]] ||
      betstan_billing_fail "too_many_pages" || return 1
    if printf '%s' "$visited_urls" | grep -Fxq "$page_url"; then
      betstan_billing_fail "nextlink_cycle"
      return 1
    fi
    visited_urls="${visited_urls}${page_url}"$'\n'

    local response="" api_attempt=1
    while [[ "$api_attempt" -le "$BETSTAN_BILLING_API_MAX_ATTEMPTS" ]]; do
      if response="$(az rest --method post --url "$page_url" \
        --body "$request_body" 2>/dev/null)"; then
        break
      fi
      if [[ "$api_attempt" == "$BETSTAN_BILLING_API_MAX_ATTEMPTS" ]]; then
        betstan_billing_fail "api_error"
        return 1
      fi
      local retry_seconds=$((BETSTAN_BILLING_API_RETRY_SECONDS << (api_attempt - 1)))
      sleep "$retry_seconds" ||
        betstan_billing_fail "retry_sleep_error" || return 1
      api_attempt=$((api_attempt + 1))
    done

    local schema_valid
    schema_valid="$(jq -r '
      type == "object" and
      (.properties | type) == "object" and
      (.properties.columns | type) == "array" and
      (.properties.rows | type) == "array"
    ' <<<"$response" 2>/dev/null)" ||
      betstan_billing_fail "response_parse_error" || return 1
    [[ "$schema_valid" == "true" ]] ||
      betstan_billing_fail "response_schema_error" || return 1

    local columns_valid
    columns_valid="$(jq -r '
      ([.properties.columns[] | {name, type}] | sort_by(.name)) ==
      ([
        {name: "Cost", type: "Number"},
        {name: "Currency", type: "String"},
        {name: "ResourceGroup", type: "String"},
        {name: "UsageDate", type: "Number"}
      ] | sort_by(.name)) and
      (.properties.columns | length) == 4
    ' <<<"$response" 2>/dev/null)" ||
      betstan_billing_fail "column_parse_error" || return 1
    [[ "$columns_valid" == "true" ]] ||
      betstan_billing_fail "column_contract_error" || return 1

    local column_names cost_index date_index resource_group_index currency_index
    column_names="$(jq -c '[.properties.columns[].name]' <<<"$response" 2>/dev/null)" ||
      betstan_billing_fail "column_name_error" || return 1
    cost_index="$(jq -r 'to_entries[] | select(.value == "Cost") | .key' <<<"$column_names" 2>/dev/null)" ||
      betstan_billing_fail "cost_index_error" || return 1
    date_index="$(jq -r 'to_entries[] | select(.value == "UsageDate") | .key' <<<"$column_names" 2>/dev/null)" ||
      betstan_billing_fail "date_index_error" || return 1
    resource_group_index="$(jq -r 'to_entries[] | select(.value == "ResourceGroup") | .key' <<<"$column_names" 2>/dev/null)" ||
      betstan_billing_fail "resource_group_index_error" || return 1
    currency_index="$(jq -r 'to_entries[] | select(.value == "Currency") | .key' <<<"$column_names" 2>/dev/null)" ||
      betstan_billing_fail "currency_index_error" || return 1
    [[ "$cost_index" =~ ^[0-3]$ && "$date_index" =~ ^[0-3]$ &&
       "$resource_group_index" =~ ^[0-3]$ && "$currency_index" =~ ^[0-3]$ ]] ||
      betstan_billing_fail "column_index_error" || return 1

    local normalized_rows
    normalized_rows="$(jq -ce \
      --argjson cost_index "$cost_index" \
      --argjson date_index "$date_index" \
      --argjson resource_group_index "$resource_group_index" \
      --argjson currency_index "$currency_index" \
      --argjson query_start "$query_start_int" \
      --argjson query_end "$query_end_int" '
        def leap_year($year):
          (($year % 4) == 0 and ($year % 100) != 0) or
          (($year % 400) == 0);
        def days_in_month($year; $month):
          if ($month == 2)
          then (if leap_year($year) then 29 else 28 end)
          elif ([4, 6, 9, 11] | index($month)) != null
          then 30
          else 31
          end;
        def valid_date($value):
          if (($value | type) == "number" and
              ($value | floor) == $value and
              $value >= $query_start and $value <= $query_end)
          then
            (($value / 10000) | floor) as $year |
            ((($value % 10000) / 100) | floor) as $month |
            ($value % 100) as $day |
            ($month >= 1 and $month <= 12 and
             $day >= 1 and $day <= days_in_month($year; $month))
          else false
          end;
        def valid_currency($value):
          ($value | type) == "string" and
          (try ($value | test("^[A-Z]{3}$")) catch false);
        if all(.properties.rows[];
          type == "array" and length == 4 and
          (.[ $cost_index ] | type) == "number" and
          valid_date(.[ $date_index ]) and
          (.[ $resource_group_index ] | type) == "string" and
          valid_currency(.[ $currency_index ])
        )
        then [
          .properties.rows[] |
          [
            .[ $cost_index ],
            .[ $date_index ],
            .[ $resource_group_index ],
            .[ $currency_index ]
          ]
        ]
        else error("invalid row")
        end
      ' <<<"$response" 2>/dev/null)" ||
      betstan_billing_fail "row_contract_error" || return 1

    all_rows="$(jq -cn \
      --argjson prior "$all_rows" \
      --argjson page "$normalized_rows" \
      '$prior + $page' 2>/dev/null)" ||
      betstan_billing_fail "row_merge_error" || return 1

    local page_digest
    page_digest="$(printf '%s' "$response" | betstan_billing_sha256_text)" ||
      betstan_billing_fail "page_digest_error" || return 1
    [[ "$page_digest" =~ ^[0-9a-f]{64}$ ]] ||
      betstan_billing_fail "page_digest_invalid" || return 1
    page_digests="${page_digests}${page_digest}"$'\n'

    local nextlink_type nextlink
    nextlink_type="$(jq -r '
      if (.properties | has("nextLink"))
      then (.properties.nextLink | type)
      else "missing"
      end
    ' <<<"$response" 2>/dev/null)" ||
      betstan_billing_fail "nextlink_parse_error" || return 1
    case "$nextlink_type" in
      missing|null)
        page_url=""
        ;;
      string)
        nextlink="$(jq -r '.properties.nextLink' <<<"$response" 2>/dev/null)" ||
          betstan_billing_fail "nextlink_parse_error" || return 1
        local nextlink_path="${nextlink%%\?*}"
        local nextlink_path_lower expected_path_lower
        nextlink_path_lower="$(printf '%s' "$nextlink_path" | tr '[:upper:]' '[:lower:]')" ||
          betstan_billing_fail "nextlink_path_error" || return 1
        expected_path_lower="$(printf '%s' "${continuation_prefix%\?}" | tr '[:upper:]' '[:lower:]')" ||
          betstan_billing_fail "nextlink_path_error" || return 1
        if [[ -z "$nextlink" ]]; then
          page_url=""
        elif [[ "$nextlink" == *"?"* &&
                "$nextlink_path_lower" == "$expected_path_lower" &&
                "$nextlink" != *$'\n'* && "$nextlink" != *$'\r'* ]]; then
          page_url="$nextlink"
        else
          betstan_billing_fail "nextlink_invalid"
          return 1
        fi
        ;;
      *)
        betstan_billing_fail "nextlink_type_error"
        return 1
        ;;
    esac
  done

  local currency_count currency row_count
  currency_count="$(jq -r '[.[][3]] | unique | length' <<<"$all_rows" 2>/dev/null)" ||
    betstan_billing_fail "currency_count_error" || return 1
  [[ "$currency_count" =~ ^[0-9]+$ ]] ||
    betstan_billing_fail "currency_count_invalid" || return 1
  if [[ "$currency_count" == "0" ]]; then
    currency="NO_ROWS"
  elif [[ "$currency_count" == "1" ]]; then
    currency="$(jq -r '[.[][3]] | unique | .[0]' <<<"$all_rows" 2>/dev/null)" ||
      betstan_billing_fail "currency_extract_error" || return 1
  else
    betstan_billing_fail "mixed_currency"
    return 1
  fi

  local analysis positive negative zero
  analysis="$(jq -c --arg first_usage_date "$first_usage_date" '
    [
      .[] |
      select(
        ((.[2] | ascii_downcase) == "betstan-rg" or
         (.[2] | ascii_downcase) == "mc_betstan-rg_betstan-aks_eastus") and
        ((.[1] | tostring) >= $first_usage_date)
      )
    ] |
    {
      positive: ([.[] | select(.[0] > 0)] | length),
      negative: ([.[] | select(.[0] < 0)] | length),
      zero: ([.[] | select(.[0] == 0)] | length)
    }
  ' <<<"$all_rows" 2>/dev/null)" ||
    betstan_billing_fail "classification_error" || return 1
  positive="$(jq -r '.positive' <<<"$analysis")"
  negative="$(jq -r '.negative' <<<"$analysis")"
  zero="$(jq -r '.zero' <<<"$analysis")"
  [[ "$positive" =~ ^[0-9]+$ && "$negative" =~ ^[0-9]+$ && "$zero" =~ ^[0-9]+$ ]] ||
    betstan_billing_fail "classification_count_error" || return 1

  local result
  if [[ "$positive" -gt 0 ]]; then
    result="nogo"
  elif [[ "$negative" -gt 0 ]]; then
    result="pending_adjustment"
  else
    result="clean"
  fi

  local response_digest
  response_digest="$(printf '%s' "$page_digests" | betstan_billing_sha256_text)" ||
    betstan_billing_fail "response_digest_error" || return 1
  [[ "$response_digest" =~ ^[0-9a-f]{64}$ ]] ||
    betstan_billing_fail "response_digest_invalid" || return 1
  row_count="$(jq -r 'length' <<<"$all_rows" 2>/dev/null)" ||
    betstan_billing_fail "row_count_error" || return 1

  if [[ "$result" != "nogo" ]]; then
    local usage_file="${output_file}.usage-details"
    if ! betstan_billing_query_usage_details \
      "$cost_type" "$subscription_id" "$query_start" "$query_end" \
      "$first_usage_date" "$usage_file"; then
      local usage_error="$BETSTAN_BILLING_ERROR_REASON"
      rm -f -- "$usage_file"
      betstan_billing_fail "$usage_error"
      return 1
    fi
    local usage_result usage_currency usage_digest
    local usage_rows usage_positive usage_negative usage_zero
    usage_result="$(jq -r '.result' "$usage_file")"
    usage_currency="$(jq -r '.currency' "$usage_file")"
    usage_digest="$(jq -r '.response_digest' "$usage_file")"
    usage_rows="$(jq -r '.row_count' "$usage_file")"
    usage_positive="$(jq -r '.positive' "$usage_file")"
    usage_negative="$(jq -r '.negative' "$usage_file")"
    usage_zero="$(jq -r '.zero' "$usage_file")"
    rm -f -- "$usage_file"

    [[ "$usage_result" == "clean" ||
       "$usage_result" == "pending_adjustment" ||
       "$usage_result" == "nogo" ]] ||
      betstan_billing_fail "usage_result_invalid" || return 1
    if [[ "$currency" != "NO_ROWS" &&
          "$usage_currency" != "NO_ROWS" &&
          "$currency" != "$usage_currency" ]]; then
      betstan_billing_fail "usage_currency_mismatch"
      return 1
    fi
    if [[ "$currency" == "NO_ROWS" ]]; then
      currency="$usage_currency"
    fi
    if [[ "$usage_result" == "nogo" ]]; then
      result="nogo"
    elif [[ "$usage_result" == "pending_adjustment" ]]; then
      result="pending_adjustment"
    fi
    positive=$((positive + usage_positive))
    negative=$((negative + usage_negative))
    zero=$((zero + usage_zero))
    row_count=$((row_count + usage_rows))
    response_digest="$(
      printf 'query=%s\nusage_details=%s\n' "$response_digest" "$usage_digest" |
        betstan_billing_sha256_text
    )" || betstan_billing_fail "combined_response_digest_error" || return 1
  fi

  jq -cn \
    --arg cost_type "$cost_type" \
    --arg result "$result" \
    --arg currency "$currency" \
    --arg response_digest "$response_digest" \
    --argjson row_count "$row_count" \
    --argjson positive "$positive" \
    --argjson negative "$negative" \
    --argjson zero "$zero" '{
      cost_type: $cost_type,
      result: $result,
      currency: $currency,
      response_digest: $response_digest,
      row_count: $row_count,
      positive: $positive,
      negative: $negative,
      zero: $zero
    }' >"$output_file" ||
    betstan_billing_fail "result_write_error" || return 1
}

betstan_billing_validate_observation_file() {
  local file="$1" expected_fingerprint="$2" expected_cutoff_epoch="$3"
  local expected_cutoff_date="$4"
  local expected_fields
  expected_fields="api_version
currencies
cutoff_date
cutoff_epoch
observation_chain_sha256s
observation_epochs
recorder_version
response_digests
results_actual
results_amortized
schema
subscription_fingerprint
total_span_hours
usage_api_version"

  # shellcheck disable=SC2034
  BETSTAN_BILLING_ERROR_REASON=""
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_COUNT=0
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_FIRST_EPOCH=""
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_LAST_EPOCH=""
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_SPAN_HOURS=0
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_LAST_CURRENCY=""
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_CURRENCY=""

  [[ -f "$file" && ! -L "$file" ]] ||
    betstan_billing_fail "observation_not_regular" || return 1
  if grep -q '^[[:space:]]*$' "$file" ||
     grep -qv '^[A-Za-z_][A-Za-z0-9_]*=.*$' "$file"; then
    betstan_billing_fail "observation_malformed_line"
    return 1
  fi

  local actual_fields total_fields unique_fields
  actual_fields="$(sed 's/=.*//' "$file" | LC_ALL=C sort)"
  [[ "$actual_fields" == "$expected_fields" ]] ||
    betstan_billing_fail "observation_field_set" || return 1
  total_fields="$(wc -l <"$file" | tr -d ' ')"
  unique_fields="$(sed 's/=.*//' "$file" | LC_ALL=C sort -u | wc -l | tr -d ' ')"
  [[ "$total_fields" == "14" && "$unique_fields" == "14" ]] ||
    betstan_billing_fail "observation_duplicate_field" || return 1

  local schema recorder_version api_version usage_api_version
  local fingerprint cutoff_epoch cutoff_date
  local epochs actual_results amortized_results digests chains currencies span_hours
  schema="$(betstan_billing_state_field "$file" schema)" ||
    betstan_billing_fail "observation_schema_missing" || return 1
  recorder_version="$(betstan_billing_state_field "$file" recorder_version)" ||
    betstan_billing_fail "observation_recorder_missing" || return 1
  api_version="$(betstan_billing_state_field "$file" api_version)" ||
    betstan_billing_fail "observation_api_missing" || return 1
  usage_api_version="$(betstan_billing_state_field "$file" usage_api_version)" ||
    betstan_billing_fail "observation_usage_api_missing" || return 1
  fingerprint="$(betstan_billing_state_field "$file" subscription_fingerprint)" ||
    betstan_billing_fail "observation_fingerprint_missing" || return 1
  cutoff_epoch="$(betstan_billing_state_field "$file" cutoff_epoch)" ||
    betstan_billing_fail "observation_cutoff_epoch_missing" || return 1
  cutoff_date="$(betstan_billing_state_field "$file" cutoff_date)" ||
    betstan_billing_fail "observation_cutoff_date_missing" || return 1
  epochs="$(betstan_billing_state_field "$file" observation_epochs)" ||
    betstan_billing_fail "observation_epochs_missing" || return 1
  actual_results="$(betstan_billing_state_field "$file" results_actual)" ||
    betstan_billing_fail "observation_actual_results_missing" || return 1
  amortized_results="$(betstan_billing_state_field "$file" results_amortized)" ||
    betstan_billing_fail "observation_amortized_results_missing" || return 1
  digests="$(betstan_billing_state_field "$file" response_digests)" ||
    betstan_billing_fail "observation_digests_missing" || return 1
  chains="$(betstan_billing_state_field "$file" observation_chain_sha256s)" ||
    betstan_billing_fail "observation_chains_missing" || return 1
  currencies="$(betstan_billing_state_field "$file" currencies)" ||
    betstan_billing_fail "observation_currencies_missing" || return 1
  span_hours="$(betstan_billing_state_field "$file" total_span_hours)" ||
    betstan_billing_fail "observation_span_missing" || return 1

  [[ "$schema" == "$BETSTAN_BILLING_SCHEMA" ]] ||
    betstan_billing_fail "observation_schema_mismatch" || return 1
  [[ "$recorder_version" == "$BETSTAN_BILLING_RECORDER_VERSION" ]] ||
    betstan_billing_fail "observation_recorder_mismatch" || return 1
  [[ "$api_version" == "$BETSTAN_BILLING_API_VERSION" ]] ||
    betstan_billing_fail "observation_api_mismatch" || return 1
  [[ "$usage_api_version" == "$BETSTAN_BILLING_USAGE_API_VERSION" ]] ||
    betstan_billing_fail "observation_usage_api_mismatch" || return 1
  [[ "$fingerprint" =~ ^[0-9a-f]{64}$ &&
     "$fingerprint" == "$expected_fingerprint" ]] ||
    betstan_billing_fail "observation_fingerprint_mismatch" || return 1
  [[ "$cutoff_epoch" =~ ^[1-9][0-9]*$ &&
     "$cutoff_epoch" == "$expected_cutoff_epoch" ]] ||
    betstan_billing_fail "observation_cutoff_epoch_mismatch" || return 1
  [[ "$cutoff_date" == "$expected_cutoff_date" ]] ||
    betstan_billing_fail "observation_cutoff_date_mismatch" || return 1
  [[ "$span_hours" =~ ^[0-9]+$ ]] ||
    betstan_billing_fail "observation_span_invalid" || return 1

  [[ "$epochs" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]] ||
    betstan_billing_fail "observation_epochs_invalid" || return 1
  [[ "$actual_results" =~ ^clean(,clean)*$ ]] ||
    betstan_billing_fail "observation_actual_results_invalid" || return 1
  [[ "$amortized_results" =~ ^clean(,clean)*$ ]] ||
    betstan_billing_fail "observation_amortized_results_invalid" || return 1
  [[ "$digests" =~ ^[0-9a-f]{64}:[0-9a-f]{64}(,[0-9a-f]{64}:[0-9a-f]{64})*$ ]] ||
    betstan_billing_fail "observation_digests_invalid" || return 1
  [[ "$chains" =~ ^[0-9a-f]{64}(,[0-9a-f]{64})*$ ]] ||
    betstan_billing_fail "observation_chains_invalid" || return 1
  [[ "$currencies" =~ ^(NO_ROWS|[A-Z]{3})(,(NO_ROWS|[A-Z]{3}))*$ ]] ||
    betstan_billing_fail "observation_currencies_invalid" || return 1

  local -a epoch_values=() actual_values=() amortized_values=()
  local -a digest_values=() chain_values=() currency_values=()
  IFS=',' read -r -a epoch_values <<<"$epochs"
  IFS=',' read -r -a actual_values <<<"$actual_results"
  IFS=',' read -r -a amortized_values <<<"$amortized_results"
  IFS=',' read -r -a digest_values <<<"$digests"
  IFS=',' read -r -a chain_values <<<"$chains"
  IFS=',' read -r -a currency_values <<<"$currencies"

  local count="${#epoch_values[@]}"
  [[ "$count" -gt 0 &&
     "${#actual_values[@]}" == "$count" &&
     "${#amortized_values[@]}" == "$count" &&
     "${#digest_values[@]}" == "$count" &&
     "${#chain_values[@]}" == "$count" &&
     "${#currency_values[@]}" == "$count" ]] ||
    betstan_billing_fail "observation_list_count_mismatch" || return 1

  local index=0 previous_epoch=0 previous_chain="$BETSTAN_BILLING_ZERO_CHAIN"
  local first_epoch="" last_epoch="" nonempty_currency=""
  while [[ "$index" -lt "$count" ]]; do
    local epoch="${epoch_values[$index]}"
    local currency="${currency_values[$index]}"
    local expected_chain
    if [[ "$index" -gt 0 ]]; then
      [[ "$epoch" -gt "$previous_epoch" &&
         $((epoch - previous_epoch)) -ge "$BETSTAN_BILLING_MIN_GAP_SECONDS" ]] ||
        betstan_billing_fail "observation_epoch_order_or_gap" || return 1
    fi
    if [[ "$index" == "0" ]]; then
      [[ "$epoch" -gt $((expected_cutoff_epoch + BETSTAN_BILLING_GRACE_SECONDS)) ]] ||
        betstan_billing_fail "observation_first_before_grace" || return 1
      first_epoch="$epoch"
    fi
    if [[ "$currency" != "NO_ROWS" ]]; then
      if [[ -z "$nonempty_currency" ]]; then
        nonempty_currency="$currency"
      else
        [[ "$currency" == "$nonempty_currency" ]] ||
          betstan_billing_fail "observation_currency_changed" || return 1
      fi
    fi
    expected_chain="$(betstan_billing_chain_hash \
      "$previous_chain" "$fingerprint" "$cutoff_epoch" "$currency" "$epoch" \
      "${actual_values[$index]}" "${amortized_values[$index]}" \
      "${digest_values[$index]}")" ||
      betstan_billing_fail "observation_chain_hash_error" || return 1
    [[ "${chain_values[$index]}" == "$expected_chain" ]] ||
      betstan_billing_fail "observation_chain_mismatch" || return 1

    previous_epoch="$epoch"
    previous_chain="$expected_chain"
    last_epoch="$epoch"
    index=$((index + 1))
  done

  local calculated_span=$(((last_epoch - first_epoch) / 3600))
  [[ "$span_hours" == "$calculated_span" ]] ||
    betstan_billing_fail "observation_span_mismatch" || return 1

  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_COUNT="$count"
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_FIRST_EPOCH="$first_epoch"
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_LAST_EPOCH="$last_epoch"
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_SPAN_HOURS="$calculated_span"
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_LAST_CURRENCY="${currency_values[$((count - 1))]}"
  # shellcheck disable=SC2034
  BETSTAN_BILLING_OBS_CURRENCY="$nonempty_currency"
}
