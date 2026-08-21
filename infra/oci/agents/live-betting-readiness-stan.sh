#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LIVE_BETTING_STACK="oci"
BASE_URL="${BASE_URL:-${OCI_PUBLIC_URL:-}}"
SECONDARY_PUBLIC_URL="${SECONDARY_PUBLIC_URL:-${OCI_REDIRECT_URL:-}}"
DIAGNOSTIC_URL="${DIAGNOSTIC_URL:-${OCI_DIAGNOSTIC_URL:-}}"
PUBLIC_HOSTS_REQUIRED="${PUBLIC_HOSTS_REQUIRED:-1}"
DIAGNOSTIC_URL_REQUIRED="${DIAGNOSTIC_URL_REQUIRED:-1}"
REQUIRE_HTTPS_PRIMARY="${REQUIRE_HTTPS_PRIMARY:-1}"
REQUIRE_HTTPS_SECONDARY="${REQUIRE_HTTPS_SECONDARY:-1}"
REQUIRE_HTTPS_DIAGNOSTIC="${REQUIRE_HTTPS_DIAGNOSTIC:-1}"
# shellcheck source=../../azure/agents/live-betting-readiness-lib.sh
source "$ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"
live_betting_readiness_main "$@"
