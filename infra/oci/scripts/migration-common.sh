#!/usr/bin/env bash

MIGRATION_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_BOUNDED_COMMAND="$MIGRATION_COMMON_DIR/bounded-command.py"
MIGRATION_HEARTBEAT_INTERVAL_SECONDS="${MIGRATION_HEARTBEAT_INTERVAL_SECONDS:-30}"
MIGRATION_LAST_HEARTBEAT_EPOCH=0

migration_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

migration_log() {
  printf '%s\n' "$*"
}

migration_require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    migration_die "required command is unavailable: $1"
}

migration_is_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

migration_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

migration_fingerprint() {
  printf '%s' "$1" | migration_sha256
}

migration_epoch() {
  date -u +%s
}

migration_iso8601() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

migration_raw() {
  local classification="$1"
  local timeout_seconds="$2"
  local attempts="$3"
  shift 3
  "$MIGRATION_BOUNDED_COMMAND" \
    --timeout-seconds "$timeout_seconds" \
    --attempts "$attempts" \
    --classification "$classification" \
    -- "$@"
}

migration_maybe_heartbeat() {
  local force="${1:-0}"
  local now
  declare -F migration_heartbeat >/dev/null 2>&1 || return 0
  now="$(migration_epoch)"
  if [[ "$force" == "1" ]] ||
      (( now - MIGRATION_LAST_HEARTBEAT_EPOCH >=
        MIGRATION_HEARTBEAT_INTERVAL_SECONDS )); then
    migration_heartbeat "$now"
    MIGRATION_LAST_HEARTBEAT_EPOCH="$now"
  fi
}

migration_run() {
  local classification="$1"
  local timeout_seconds="$2"
  local attempts="$3"
  shift 3
  migration_maybe_heartbeat
  migration_log \
    "external_command=START classification=$classification timeout_seconds=$timeout_seconds attempts=$attempts"
  migration_raw "$classification" "$timeout_seconds" "$attempts" "$@"
  local status=$?
  migration_maybe_heartbeat 1
  if [[ "$status" -ne 0 ]]; then
    migration_log \
      "external_command=FAIL classification=$classification status=$status"
    return "$status"
  fi
  migration_log "external_command=PASS classification=$classification"
}

migration_sleep() {
  local seconds="$1"
  migration_run wait "$((seconds + 5))" 1 sleep "$seconds"
}

migration_failure_hook() {
  local point="$1"
  [[ "${MIGRATION_FAIL_AT:-}" != "$point" ]] || {
    migration_log "failure_injection=$point"
    return 97
  }
  if [[ "${MIGRATION_HANG_AT:-}" == "$point" ]]; then
    migration_raw injected-hang "${MIGRATION_HANG_TIMEOUT_SECONDS:-2}" 1 \
      sleep "${MIGRATION_HANG_SLEEP_SECONDS:-30}"
  fi
}

migration_safe_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]
}
