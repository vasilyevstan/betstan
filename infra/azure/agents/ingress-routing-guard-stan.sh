#!/usr/bin/env bash
set -euo pipefail

# Purpose: fail fast when prod ingress host/path routing is unsafe.

INGRESS_FILE="${INGRESS_FILE:-infra/k8s-prod/ingress-srv.yaml}"

if [[ ! -f "$INGRESS_FILE" ]]; then
  echo "ERROR: ingress file not found: $INGRESS_FILE" >&2
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
  block="$(host_block "$host")"
  if [[ -z "$block" ]]; then
    echo "ERROR: host block missing for $host" >&2
    exit 1
  fi

  for path in "/api/auth/?(.*)" "/api/event/?(.*)" "/api/slip/?(.*)" "/api/bet/?(.*)" "/api/backoffice/?(.*)"; do
    if ! grep -Fq "$path" <<<"$block"; then
      echo "ERROR: host $host missing path $path" >&2
      exit 1
    fi
  done
}

require_in_file "secretName:[[:space:]]*betstan-tls" "TLS secret betstan-tls"
require_in_file "^[[:space:]]*-[[:space:]]*betstan\\.xyz$" "TLS host betstan.xyz"
require_in_file "^[[:space:]]*-[[:space:]]*www\\.betstan\\.xyz$" "TLS host www.betstan.xyz"

assert_host_has_paths "betstan.xyz"
assert_host_has_paths "www.betstan.xyz"
echo "ingress_routing_guard=PASS"

