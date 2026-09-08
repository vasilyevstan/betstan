#!/usr/bin/env bash
set -euo pipefail

# Prove the runtime mode and every upstream prerequisite for an
# oci-infrastructure dispatch.
#
# This runs before the OCI CLI install, the cloud identity check, zero-cost
# preflight, runner-rule changes, add-on installation and Bastion access, so a
# direct workflow_dispatch cannot reach cloud access or mutation on a wrong,
# missing, rerun or expired binding. It lives in its own file so the exact gate
# body is executable and testable rather than only statically greppable.

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ROOT_DIR="${ROOT_DIR:-$SCRIPT_ROOT}"
BINDING_MANIFEST="${BINDING_MANIFEST:-$ROOT_DIR/infra/oci/policy/upstream-run-bindings.json}"
BINDING_VALIDATOR="${BINDING_VALIDATOR:-$ROOT_DIR/infra/oci/scripts/upstream_run_binding_stan.py}"

: "${BOUND_RUNTIME_MODE:?bound runtime mode is required}"
: "${OCI_RUNTIME_MODE:?authoritative runtime mode is required}"
: "${PHASE:?phase is required}"
: "${SOURCE_SHA:?source SHA is required}"
: "${REPOSITORY:?repository is required}"
: "${DISPATCH_INPUTS:?dispatch inputs are required}"
CAPACITY_ACQUISITION_RUN_ID="${CAPACITY_ACQUISITION_RUN_ID:-}"

# The dispatch carries an immutable runtime mode; it must equal the
# authoritative environment mode before anything else is considered.
[ "$BOUND_RUNTIME_MODE" = "$OCI_RUNTIME_MODE" ]
case "$BOUND_RUNTIME_MODE" in
  k3s | oke) ;;
  *)
    echo "unsupported bound runtime mode: $BOUND_RUNTIME_MODE" >&2
    exit 1
    ;;
esac

case "$PHASE" in
  prepare)
    operation="oci-infrastructure-prepare-$BOUND_RUNTIME_MODE"
    # Capacity acquisition is a k3s-only Free Tier concern and is never a
    # prepare prerequisite in either mode.
    [ -z "$CAPACITY_ACQUISITION_RUN_ID" ]
    echo "infrastructure_binding=$operation prerequisites=none"
    exit 0
    ;;
  finalize)
    operation="oci-infrastructure-finalize-$BOUND_RUNTIME_MODE"
    ;;
  *)
    echo "unsupported phase: $PHASE" >&2
    exit 1
    ;;
esac

if [ "$BOUND_RUNTIME_MODE" = "k3s" ]; then
  [ -n "$CAPACITY_ACQUISITION_RUN_ID" ]
else
  # OKE has no Free Tier capacity acquisition; a supplied run is a binding
  # error, not an ignorable extra.
  [ -z "$CAPACITY_ACQUISITION_RUN_ID" ]
fi

# Bindings come from the checked-in manifest that a contract proves equal to the
# protected-operation policy the dispatcher and approver use, so no enforcement
# path can drift. A missing, null or empty manifest entry fails closed.
"$BINDING_VALIDATOR" validate-all \
  --repository "$REPOSITORY" \
  --manifest "$BINDING_MANIFEST" \
  --operation "$operation" \
  --subject-sha "$SOURCE_SHA" \
  --dispatch-inputs "$DISPATCH_INPUTS"

echo "infrastructure_binding=$operation prerequisites=validated"
