#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LIVE_BETTING_STACK="azure"
PUBLIC_HOSTS_REQUIRED="${PUBLIC_HOSTS_REQUIRED:-0}"
DIAGNOSTIC_URL_REQUIRED="${DIAGNOSTIC_URL_REQUIRED:-0}"
REQUIRE_HTTPS_PRIMARY="${REQUIRE_HTTPS_PRIMARY:-0}"
REQUIRE_HTTPS_SECONDARY="${REQUIRE_HTTPS_SECONDARY:-0}"
REQUIRE_HTTPS_DIAGNOSTIC="${REQUIRE_HTTPS_DIAGNOSTIC:-0}"
# shellcheck source=live-betting-readiness-lib.sh
source "$ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"
live_betting_readiness_main "$@"
