#!/usr/bin/env bash

OCI_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$OCI_ROOT_DIR/infra/oci"
OCI_BOOT_VOLUME_VPUS_PER_GB=10

oci_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

oci_log() {
  printf '%s\n' "$*"
}

oci_require_command() {
  command -v "$1" >/dev/null 2>&1 || oci_die "required command is unavailable: $1"
}

oci_require_cli_version() {
  oci_require_command oci
  oci_require_vars OCI_CLI_VERSION
  local actual
  actual="$(oci --version)"
  [[ "$actual" == "$OCI_CLI_VERSION" ]] ||
    oci_die "OCI CLI version '$actual' differs from reviewed version '$OCI_CLI_VERSION'"
}

oci_require_vars() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" && "${!name}" != "REQUIRED" && "${!name}" != REQUIRED_* ]] ||
      oci_die "required environment variable is missing: $name"
  done
}

oci_require_value() {
  local name="$1"
  local expected="$2"
  [[ "${!name:-}" == "$expected" ]] ||
    oci_die "$name must be exactly '$expected' for the approved Free Tier design"
}

oci_require_ocid() {
  local name="$1"
  [[ "${!name:-}" =~ ^ocid1\.[a-z0-9-]+\.oc[0-9]*\..+ ]] ||
    oci_die "$name must contain a complete OCI OCID"
}

oci_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

oci_fingerprint() {
  printf '%s' "$1" | oci_sha256
}

oci_is_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

oci_runtime_mode() {
  local mode="${OCI_RUNTIME_MODE:-}"
  [[ "$mode" == "oke" || "$mode" == "k3s" ]] ||
    oci_die "OCI_RUNTIME_MODE must be exactly 'oke' or 'k3s'"
  printf '%s' "$mode"
}

oci_prepare_private_dir() {
  local directory="$1"
  mkdir -p "$directory"
  chmod 700 "$directory"
}

oci_redact() {
  python3 -c '
import re
import sys

value = sys.stdin.read()
value = re.sub(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    "[REDACTED_PRIVATE_KEY]",
    value,
    flags=re.DOTALL,
)
value = re.sub(r"ocid1\.[A-Za-z0-9._:-]+", "[REDACTED_OCID]", value)
value = re.sub(r"(?:[0-9]{1,3}\.){3}[0-9]{1,3}", "[REDACTED_IP]", value)
value = re.sub(
    r"\b[A-Za-z0-9._-]+\.(?:oraclevcn\.com|internal)\b",
    "[REDACTED_PRIVATE_HOST]",
    value,
    flags=re.IGNORECASE,
)
value = re.sub(
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "[REDACTED_EMAIL]",
    value,
)
value = re.sub(r"mongodb(?:\+srv)?://[^\s]+", "mongodb://[REDACTED]", value)
value = re.sub(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*", r"\1 [REDACTED]", value)
names = [
    "Author" + "ization",
    "to" + "ken",
    "pass" + "word",
    "sec" + "ret",
    "JWT" + "_" + "KEY",
    "set" + "-cookie",
    "cookie",
]
for name in names:
    value = re.sub(
        rf"(?im)({re.escape(name)}\s*[:=]\s*)[^\s\r\n]+",
        rf"\1[REDACTED]",
        value,
    )
sys.stdout.write(value)
'
}

oci_validate_public_ipv4() {
  python3 - "$1" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
if address.version != 4 or not address.is_global:
    raise SystemExit(1)
PY
}

oci_json_array() {
  jq -cn '$ARGS.positional' --args "$@"
}

oci_normalize_list_json() {
  local response="${1:-}"
  local layout="${2:-array}"
  if [[ -z "$response" ]]; then
    if [[ "$layout" == "items" ]]; then
      printf '{"data":{"items":[]}}\n'
    else
      printf '{"data":[]}\n'
    fi
    return
  fi
  jq -e . <<<"$response" >/dev/null ||
    oci_die "OCI list response is not valid JSON"
  printf '%s\n' "$response"
}

oci_assert_repository_root() {
  [[ -f "$OCI_ROOT_DIR/CONTRIBUTING.md" && -d "$OCI_ROOT_DIR/infra/k8s" ]] ||
    oci_die "unable to identify the BetStan repository root"
}
