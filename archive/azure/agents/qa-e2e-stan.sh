#!/usr/bin/env bash
set -euo pipefail

# Purpose: run browser E2E smoke tests against deployed URL.
# Usage:
#   E2E_BASE_URL=http://48.206.235.122 ./infra/azure/agents/qa-e2e-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/client"
E2E_BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:3000}"

cd "$CLIENT_DIR"
E2E_BASE_URL="$E2E_BASE_URL" npx playwright test --config=playwright.config.js

