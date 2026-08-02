#!/usr/bin/env bash
set -euo pipefail

: "${OCI_CLI_VERSION:?OCI_CLI_VERSION is required}"
[[ "$OCI_CLI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'OCI_CLI_VERSION must be an exact semantic version\n' >&2
  exit 1
}

python3 -m pip install \
  --disable-pip-version-check \
  --no-input \
  --user \
  "oci-cli==${OCI_CLI_VERSION}"

actual_version="$(oci --version)"
if [[ "$actual_version" != "$OCI_CLI_VERSION" ]]; then
  printf 'OCI CLI version mismatch: expected %s, got %s\n' \
    "$OCI_CLI_VERSION" \
    "$actual_version" >&2
  exit 1
fi
