#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WAITER="$ROOT_DIR/infra/azure/agents/wait-required-checks-stan.sh"
HEAD_SHA="1111111111111111111111111111111111111111"
BASE_SHA="0000000000000000000000000000000000000000"
MERGE_SHA="2222222222222222222222222222222222222222"
STUB_DIR="$ROOT_DIR/.test-workdirs/wait-required-checks.$$"
mkdir -p "$STUB_DIR"
trap 'rm -rf "$STUB_DIR"' EXIT

gh() {
  if [[ "$1 $2" == "pr view" ]]; then
    local calls=0 head="$HEAD_SHA"
    [[ -f "$STUB_DIR/views" ]] && calls="$(cat "$STUB_DIR/views")"
    calls=$((calls + 1))
    echo "$calls" >"$STUB_DIR/views"
    [[ -n "${STUB_DRIFT:-}" && "$calls" -gt 1 ]] && head="3333333333333333333333333333333333333333"
    echo "{\"headRefOid\":\"$head\",\"baseRefOid\":\"$BASE_SHA\",\"baseRefName\":\"master\",\"potentialMergeCommit\":{\"oid\":\"$MERGE_SHA\"},\"state\":\"OPEN\"}"
  elif [[ "$1" == "api" && "$2" == *"/protection/required_status_checks" ]]; then
    if [[ -n "${STUB_REQUIRE_OCI:-}" ]]; then
      echo '{"contexts":["branch-policy/master"],"checks":[{"context":"pr-quality-gates/master","app_id":15368},{"context":"oci-validate","app_id":15368}]}'
    else
      echo '{"contexts":["branch-policy/master"],"checks":[{"context":"pr-quality-gates/master","app_id":15368}]}'
    fi
  elif [[ "$1" == "api" && "$2" == *"/status?per_page=100" ]]; then
    echo "{\"statuses\":[{\"context\":\"trusted-quality-transition/master\",\"state\":\"pending\"},{\"context\":\"branch-policy/master\",\"state\":\"success\"},{\"context\":\"pr-quality-gates/master\",\"state\":\"${STUB_QUALITY_STATE:-success}\"}]}"
  elif [[ "$1" == "api" && "$2" == *"/check-runs?per_page=100" ]]; then
    echo '{"check_runs":[{"id":7,"name":"oci-validate","status":"completed","conclusion":"success"}]}'
  else
    echo "unexpected gh invocation: $*" >&2
    return 1
  fi
}
export -f gh
export HEAD_SHA BASE_SHA MERGE_SHA STUB_DIR

run_case() {
  local expected="$1" pattern="$2" output status=0
  shift 2
  rm -f "$STUB_DIR/views"
  output="$(env REPO=example/repo WAIT_INTERVAL_SECONDS=1 WAIT_TIMEOUT_SECONDS=2 \
    WAIT_RETRY_SECONDS=0 "$@" "$WAITER" 63 2>&1)" || status=$?
  if [[ "$status" != "$expected" || "$output" != *"$pattern"* ]]; then
    echo "expected exit $expected with '$pattern', got $status:" >&2
    echo "$output" >&2
    exit 1
  fi
  printf '%s\n' "$output"
}

ready="$(run_case 0 "READY head=$HEAD_SHA merge=$MERGE_SHA")"
[[ "$ready" == *"ignored=oci-validate,trusted-quality-transition/master"* ]] || {
  echo "non-required contexts were not reported as ignored" >&2
  exit 1
}
# master: a required check-run exists only on the head, never on the merge snapshot.
run_case 0 "READY head=$HEAD_SHA merge=$MERGE_SHA" STUB_REQUIRE_OCI=1 >/dev/null
run_case 1 "FAILED pr-quality-gates/master" STUB_QUALITY_STATE=failure >/dev/null
run_case 2 "STALE head=3333333333333333333333333333333333333333" STUB_DRIFT=1 >/dev/null
run_case 3 "TIMEOUT pending=pr-quality-gates/master" STUB_QUALITY_STATE=pending >/dev/null

echo "wait_required_checks_tests=PASS"
