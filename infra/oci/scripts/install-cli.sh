#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOUNDED_COMMAND="$SCRIPT_DIR/bounded-command.py"

: "${OCI_CLI_VERSION:?OCI_CLI_VERSION is required}"
OCI_CLI_INSTALL_ATTEMPTS="${OCI_CLI_INSTALL_ATTEMPTS:-3}"
OCI_CLI_INSTALL_TIMEOUT_SECONDS="${OCI_CLI_INSTALL_TIMEOUT_SECONDS:-240}"
OCI_CLI_PIP_TIMEOUT_SECONDS="${OCI_CLI_PIP_TIMEOUT_SECONDS:-60}"
OCI_CLI_PIP_RETRIES="${OCI_CLI_PIP_RETRIES:-1}"

[[ "$OCI_CLI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'OCI_CLI_VERSION must be an exact semantic version\n' >&2
  exit 1
}
[[ "$OCI_CLI_INSTALL_ATTEMPTS" =~ ^[1-5]$ ]] || {
  printf 'OCI_CLI_INSTALL_ATTEMPTS must be between 1 and 5\n' >&2
  exit 1
}
[[ "$OCI_CLI_INSTALL_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,2}$ ]] &&
  ((OCI_CLI_INSTALL_TIMEOUT_SECONDS <= 900)) || {
  printf 'OCI_CLI_INSTALL_TIMEOUT_SECONDS must be between 1 and 900\n' >&2
  exit 1
}
[[ "$OCI_CLI_PIP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,2}$ ]] &&
  ((OCI_CLI_PIP_TIMEOUT_SECONDS <= 300)) || {
  printf 'OCI_CLI_PIP_TIMEOUT_SECONDS must be between 1 and 300\n' >&2
  exit 1
}
[[ "$OCI_CLI_PIP_RETRIES" =~ ^([0-9]|10)$ ]] || {
  printf 'OCI_CLI_PIP_RETRIES must be between 0 and 10\n' >&2
  exit 1
}
install_budget_seconds=$((
  OCI_CLI_INSTALL_ATTEMPTS * OCI_CLI_INSTALL_TIMEOUT_SECONDS +
    OCI_CLI_INSTALL_ATTEMPTS * (OCI_CLI_INSTALL_ATTEMPTS - 1)
))
((install_budget_seconds <= 900)) || {
  printf 'OCI CLI install retry budget must not exceed 900 seconds\n' >&2
  exit 1
}
[[ -x "$BOUNDED_COMMAND" ]] || {
  printf 'bounded command runner is unavailable: %s\n' "$BOUNDED_COMMAND" >&2
  exit 1
}

"$BOUNDED_COMMAND" \
  --timeout-seconds "$OCI_CLI_INSTALL_TIMEOUT_SECONDS" \
  --attempts "$OCI_CLI_INSTALL_ATTEMPTS" \
  --classification oci-cli-install \
  -- \
  python3 -m pip install \
    --disable-pip-version-check \
    --no-input \
    --timeout "$OCI_CLI_PIP_TIMEOUT_SECONDS" \
    --retries "$OCI_CLI_PIP_RETRIES" \
    --user \
    "oci-cli==${OCI_CLI_VERSION}"

actual_version="$(oci --version)"
if [[ "$actual_version" != "$OCI_CLI_VERSION" ]]; then
  printf 'OCI CLI version mismatch: expected %s, got %s\n' \
    "$OCI_CLI_VERSION" \
    "$actual_version" >&2
  exit 1
fi
