#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PUBLIC_URL="${OCI_PUBLIC_URL:-${PUBLIC_URL:-}}"
REDIRECT_URL="${OCI_REDIRECT_URL:-}"
DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
EXPECTED_HOME_MARKER="${OCI_EXPECTED_HOME_MARKER:-BetStan.xyz demo app}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-25}"
STABILITY_ATTEMPTS="${STABILITY_ATTEMPTS:-10}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/oci-smoke}"
WORK_DIR="$OUTPUT_DIR/.work"

fail() {
  printf 'NO_GO smoke_reason=%s\n' "$1" >&2
  rm -rf "$WORK_DIR"
  exit 1
}

[[ "$PUBLIC_URL" == "https://betstan.xyz" ]] ||
  fail "canonical public URL must be https://betstan.xyz"
[[ "$REDIRECT_URL" == "https://www.betstan.xyz" ]] ||
  fail "redirect URL must be https://www.betstan.xyz"
[[ "$DIAGNOSTIC_URL" =~ ^https://([0-9]{1,3}\.){3}[0-9]{1,3}\.nip\.io$ ]] ||
  fail "diagnostic URL must be an HTTPS IPv4-derived nip.io hostname"
[[ "$STABILITY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] ||
  fail "STABILITY_ATTEMPTS must be positive"
for command in curl dig jq openssl; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is unavailable"
done

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

canonical_host="${PUBLIC_URL#https://}"
redirect_host="${REDIRECT_URL#https://}"
diagnostic_host="${DIAGNOSTIC_URL#https://}"
ingress_ipv4="${diagnostic_host%.nip.io}"

require_exact_dns() {
  local host="$1"
  local label="$2"
  local ipv4
  ipv4="$(dig +short A "$host" | sed '/^$/d' | sort -u)"
  [[ "$ipv4" == "$ingress_ipv4" ]] ||
    fail "$label A record differs from OCI ingress provenance"
  [[ -z "$(dig +short AAAA "$host" | sed '/^$/d')" ]] ||
    fail "$label has an unexpected AAAA record"
}

require_redirect() {
  local url="$1"
  local expected_location="$2"
  local label="$3"
  local headers="$WORK_DIR/${label}.headers"
  local status location
  status="$(
    curl --silent --show-error --max-time "$REQUEST_TIMEOUT" \
      --output /dev/null --dump-header "$headers" \
      --write-out '%{http_code}' "$url"
  )" || fail "$label request failed"
  [[ "$status" == "301" || "$status" == "302" ||
     "$status" == "307" || "$status" == "308" ]] ||
    fail "$label did not return a redirect"
  location="$(
    awk 'tolower($1)=="location:" {$1=""; sub(/^ /, ""); sub(/\r$/, ""); print}' \
      "$headers" | tail -n 1
  )"
  [[ "$location" == "$expected_location" ]] ||
    fail "$label redirect target differs from the canonical contract"
}

require_served_certificate() {
  local host="$1"
  local label="$2"
  shift 2
  local certificate="$WORK_DIR/${label}.certificate.pem"
  local issuer san_text
  openssl s_client \
    -connect "${host}:443" \
    -servername "$host" \
    -verify_return_error \
    -showcerts </dev/null 2>"$WORK_DIR/${label}.openssl.log" |
    openssl x509 -out "$certificate" ||
    fail "$label did not serve a trusted parseable certificate"
  issuer="$(openssl x509 -in "$certificate" -noout -issuer)"
  [[ "$issuer" == *"Let's Encrypt"* ]] ||
    fail "$label certificate was not issued by Let's Encrypt"
  san_text="$(openssl x509 -in "$certificate" -noout -text)"
  for expected_san in "$@"; do
    grep -Eq "(^|[ ,])DNS:${expected_san}([ ,]|$)" <<<"$san_text" ||
      fail "$label certificate is missing SAN ${expected_san}"
  done
  openssl x509 -in "$certificate" -checkend 604800 -noout >/dev/null ||
    fail "$label certificate expires within seven days"
}

require_exact_dns "$canonical_host" canonical
require_exact_dns "$redirect_host" redirect

probe_path='/api/auth/currentuser?oci-domain-probe=1'
require_redirect \
  "http://${canonical_host}${probe_path}" \
  "https://${canonical_host}${probe_path}" \
  canonical-http
require_redirect \
  "http://${redirect_host}${probe_path}" \
  "https://${canonical_host}${probe_path}" \
  redirect-http
require_redirect \
  "https://${redirect_host}${probe_path}" \
  "https://${canonical_host}${probe_path}" \
  redirect-https
require_redirect \
  "http://${diagnostic_host}${probe_path}" \
  "https://${diagnostic_host}${probe_path}" \
  diagnostic-http
require_served_certificate \
  "$canonical_host" canonical "$canonical_host" "$redirect_host"
require_served_certificate \
  "$diagnostic_host" diagnostic "$diagnostic_host"

home_body="$WORK_DIR/home.body"
home_headers="$WORK_DIR/home.headers"
home_status="$(
  curl --silent --show-error --max-time "$REQUEST_TIMEOUT" \
    --output "$home_body" --dump-header "$home_headers" \
    --write-out '%{http_code}' "${PUBLIC_URL}/"
)" || fail "trusted canonical HTTPS homepage request failed"
[[ "$home_status" == "200" ]] || fail "canonical homepage did not return HTTP 200"
grep -Fqi "$EXPECTED_HOME_MARKER" "$home_body" || fail "canonical homepage marker is missing"

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
      --write-out '%{http_code}' "${PUBLIC_URL}${api_path}"
  )" || fail "canonical API request failed: $api_path"
  [[ "$status" == "200" ]] || fail "canonical API route did not return HTTP 200: $api_path"
  content_type="$(
    awk 'tolower($1)=="content-type:" {$1=""; sub(/^ /,""); sub(/\r$/,""); print}' \
      "$headers" | tail -n 1
  )"
  [[ "$content_type" == application/json* ]] ||
    fail "canonical API returned non-JSON content: $api_path"
  jq -e . "$body" >/dev/null || fail "canonical API returned invalid JSON: $api_path"
  if [[ "$api_path" == "/api/auth/currentuser" ]]; then
    jq -e 'type == "object" and has("currentUser")' "$body" >/dev/null ||
      fail "current-user API JSON shape is invalid"
  fi
done

diagnostic_body="$WORK_DIR/diagnostic.body"
diagnostic_headers="$WORK_DIR/diagnostic.headers"
diagnostic_status="$(
  curl --silent --show-error --max-time "$REQUEST_TIMEOUT" \
    --output "$diagnostic_body" --dump-header "$diagnostic_headers" \
    --write-out '%{http_code}' "${DIAGNOSTIC_URL}/api/auth/currentuser"
)" || fail "trusted diagnostic HTTPS request failed"
[[ "$diagnostic_status" == "200" ]] ||
  fail "diagnostic API route did not return HTTP 200"
diagnostic_content_type="$(
  awk 'tolower($1)=="content-type:" {$1=""; sub(/^ /,""); sub(/\r$/,""); print}' \
    "$diagnostic_headers" | tail -n 1
)"
[[ "$diagnostic_content_type" == application/json* ]] ||
  fail "diagnostic API returned non-JSON content"
jq -e 'type == "object" and has("currentUser")' "$diagnostic_body" >/dev/null ||
  fail "diagnostic API JSON shape is invalid"

for _ in $(seq 1 "$STABILITY_ATTEMPTS"); do
  curl --fail --silent --show-error --max-time "$REQUEST_TIMEOUT" \
    --output /dev/null "${PUBLIC_URL}/" ||
    fail "canonical stability probe failed"
  curl --fail --silent --show-error --max-time "$REQUEST_TIMEOUT" \
    --output /dev/null "${DIAGNOSTIC_URL}/" ||
    fail "diagnostic stability probe failed"
done

printf 'oci_smoke_liveness=PASS canonical_https=1 www_redirect=1 diagnostic_https=1 dns_match=1 api_json=1\n'
