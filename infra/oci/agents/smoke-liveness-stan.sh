#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PUBLIC_URL="${OCI_PUBLIC_URL:-${PUBLIC_URL:-}}"
EXPECTED_HOME_MARKER="${OCI_EXPECTED_HOME_MARKER:-BetStan.xyz demo app}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-25}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/oci-smoke}"
WORK_DIR="$OUTPUT_DIR/.work"

fail() {
  printf 'NO_GO smoke_reason=%s\n' "$1" >&2
  rm -rf "$WORK_DIR"
  exit 1
}

[[ "$PUBLIC_URL" =~ ^https://[a-z0-9.-]+\.nip\.io/?$ ]] ||
  fail "public URL must be an HTTPS nip.io hostname"
command -v curl >/dev/null 2>&1 || fail "curl is unavailable"
command -v jq >/dev/null 2>&1 || fail "jq is unavailable"
mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

host="${PUBLIC_URL#https://}"
host="${host%/}"
redirect_headers="$WORK_DIR/redirect.headers"
redirect_status="$(
  curl --silent --show-error --max-time "$REQUEST_TIMEOUT" \
    --output /dev/null --dump-header "$redirect_headers" \
    --write-out '%{http_code}' "http://${host}/"
)" || fail "plain HTTP request failed"
[[ "$redirect_status" == "301" || "$redirect_status" == "302" ||
   "$redirect_status" == "307" || "$redirect_status" == "308" ]] ||
  fail "plain HTTP did not return a redirect"
location="$(awk 'tolower($1)=="location:" {sub(/\r$/, "", $2); print $2}' "$redirect_headers" | tail -n 1)"
[[ "$location" == https://"$host"* ]] || fail "plain HTTP redirect did not preserve the trusted HTTPS host"

home_body="$WORK_DIR/home.body"
home_headers="$WORK_DIR/home.headers"
home_status="$(
  curl --silent --show-error --max-time "$REQUEST_TIMEOUT" \
    --output "$home_body" --dump-header "$home_headers" \
    --write-out '%{http_code}' "${PUBLIC_URL%/}/"
)" || fail "trusted HTTPS homepage request failed"
[[ "$home_status" == "200" ]] || fail "homepage did not return HTTP 200"
grep -Fqi "$EXPECTED_HOME_MARKER" "$home_body" || fail "homepage marker is missing"

api_paths=(
  /api/auth/currentuser
  /api/event
  /api/slip
  /api/bet
  /api/bet/stats
  /api/backoffice
)
for api_path in "${api_paths[@]}"; do
  body="$WORK_DIR/api.body"
  headers="$WORK_DIR/api.headers"
  status="$(
    curl --silent --show-error --max-time "$REQUEST_TIMEOUT" \
      --output "$body" --dump-header "$headers" \
      --write-out '%{http_code}' "${PUBLIC_URL%/}${api_path}"
  )" || fail "API request failed: $api_path"
  [[ "$status" == "200" ]] || fail "API route did not return HTTP 200: $api_path"
  content_type="$(awk 'tolower($1)=="content-type:" {$1=""; sub(/^ /,""); sub(/\r$/,""); print}' "$headers" | tail -n 1)"
  [[ "$content_type" == application/json* ]] || fail "API returned non-JSON content: $api_path"
  jq -e . "$body" >/dev/null || fail "API returned invalid JSON: $api_path"
  if [[ "$api_path" == "/api/auth/currentuser" ]]; then
    jq -e 'type == "object" and has("currentUser")' "$body" >/dev/null ||
      fail "current-user API JSON shape is invalid"
  fi
done

printf 'oci_smoke_liveness=PASS https_trusted=1 api_json=1 http_redirect=1\n'
