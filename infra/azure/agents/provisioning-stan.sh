#!/usr/bin/env bash
set -euo pipefail

# Purpose: create or reconcile AKS prerequisites and base platform components.
# Usage:
#   LOCATION=eastus NODE_COUNT=1 ./infra/azure/agents/provisioning-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

bash ./infra/azure/provision.sh

