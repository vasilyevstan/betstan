#!/usr/bin/env bash
set -euo pipefail

# Purpose: fail fast when prod ingress host/path routing is unsafe.

INGRESS_FILE="${INGRESS_FILE:-infra/k8s-prod/ingress-srv.yaml}"
LEGACY_INGRESS_FILE="${LEGACY_INGRESS_FILE:-infra/k8s-prod/ingress-srv-nip.yaml}"
INGRESS_PROFILE="${INGRESS_PROFILE:-production}"

[[ "$INGRESS_PROFILE" == "production" || "$INGRESS_PROFILE" == "local-dev" ]] || {
  echo "ERROR: unsupported ingress profile: $INGRESS_PROFILE" >&2
  exit 1
}

if [[ ! -f "$INGRESS_FILE" ]]; then
  echo "ERROR: ingress file not found: $INGRESS_FILE" >&2
  exit 1
fi

if [[ -e "$LEGACY_INGRESS_FILE" ]]; then
  echo "ERROR: legacy public ingress must be removed: $LEGACY_INGRESS_FILE" >&2
  exit 1
fi

require_in_file() {
  local pattern="$1"
  local label="$2"
  if ! grep -qE "$pattern" "$INGRESS_FILE"; then
    echo "ERROR: missing $label in $INGRESS_FILE" >&2
    exit 1
  fi
}

host_block() {
  local host="$1"
  awk -v h="$host" '
    $0 ~ "^    - host: " h "$" {in_block=1; print; next}
    in_block && $0 ~ "^    - host: " {exit}
    in_block && $0 ~ "^    - http:" {exit}
    in_block {print}
  ' "$INGRESS_FILE"
}

assert_host_has_paths() {
  local host="$1"
  local block
  local telemetry_line catch_all_line
  local -a required_paths
  block="$(host_block "$host")"
  if [[ -z "$block" ]]; then
    echo "ERROR: host block missing for $host" >&2
    exit 1
  fi

  required_paths=(
    "/api/auth/?(.*)" "/api/event/?(.*)" "/api/slip/?(.*)"
    "/api/bet/?(.*)" "/api/backoffice/?(.*)"
  )
  if [[ "$INGRESS_PROFILE" == "local-dev" ]]; then
    required_paths+=("/api/telemetry/?(.*)")
  fi
  required_paths+=("/?(.*)")
  for path in "${required_paths[@]}"; do
    if ! grep -Fq "$path" <<<"$block"; then
      echo "ERROR: host $host missing path $path" >&2
      exit 1
    fi
  done
  if [[ "$INGRESS_PROFILE" == "local-dev" ]]; then
    telemetry_line="$(grep -nF -- '- path: /api/telemetry/?(.*)' <<<"$block" |
      cut -d: -f1)"
    catch_all_line="$(grep -nF -- '- path: /?(.*)' <<<"$block" |
      cut -d: -f1)"
    [[ "$telemetry_line" =~ ^[0-9]+$ && "$catch_all_line" =~ ^[0-9]+$ &&
      "$telemetry_line" -lt "$catch_all_line" ]] || {
      echo "ERROR: local Telemetry API route must precede the client catch-all" >&2
      exit 1
    }
  fi
}

require_in_file 'nginx\.ingress\.kubernetes\.io/proxy-buffering:[[:space:]]*"off"' "disabled SSE proxy buffering"
require_in_file 'nginx\.ingress\.kubernetes\.io/proxy-read-timeout:[[:space:]]*"75"' "SSE proxy read timeout"
require_in_file 'nginx\.ingress\.kubernetes\.io/proxy-send-timeout:[[:space:]]*"75"' "SSE proxy send timeout"

host_count="$(grep -cE '^    - host:' "$INGRESS_FILE" || true)"
if [[ "$INGRESS_PROFILE" == "production" ]]; then
  require_in_file "secretName:[[:space:]]*betstan-tls" "TLS secret betstan-tls"
  require_in_file "^[[:space:]]*-[[:space:]]*betstan\\.xyz$" "TLS host betstan.xyz"
  require_in_file "^[[:space:]]*-[[:space:]]*www\\.betstan\\.xyz$" "TLS host www.betstan.xyz"
  require_in_file 'nginx\.ingress\.kubernetes\.io/ssl-redirect:[[:space:]]*"true"' "HTTPS redirect"
  if grep -qE '^    - http:[[:space:]]*$' "$INGRESS_FILE"; then
    echo "ERROR: hostless production ingress rule exposes the load-balancer IP" >&2
    exit 1
  fi
  [[ "$host_count" -eq 2 ]] || {
    echo "ERROR: expected exactly two canonical production hosts, found $host_count" >&2
    exit 1
  }
  assert_host_has_paths "betstan.xyz"
  assert_host_has_paths "www.betstan.xyz"
else
  [[ "$host_count" -eq 1 ]] || {
    echo "ERROR: expected exactly one local development host, found $host_count" >&2
    exit 1
  }
  assert_host_has_paths "gaming.dev"
fi
echo "ingress_routing_guard=PASS"
