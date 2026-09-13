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

require_legacy_disk_slots_inert() {
  jq -e '
    has("infrastructure_run_id") and .infrastructure_run_id == "" and
    has("diagnosis_run_id") and .diagnosis_run_id == "" and
    has("reclaim_category") and .reclaim_category == "none" and
    has("reclaim_image_ids") and .reclaim_image_ids == "[]"
  ' <<<"$DISPATCH_INPUTS" >/dev/null
}

require_disk_legacy_slots_inert() {
  jq -e '
    [
      .candidate_build_run_id,
      .obsolete_sha,
      .obsolete_build_run_id,
      .obsolete_generations,
      .deployed_sha,
      .deployed_run_id,
      .fallback_sha,
      .fallback_build_run_id,
      .validation_run_id,
      .capacity_acquisition_run_id
    ] | all(. == "")
  ' <<<"$DISPATCH_INPUTS" >/dev/null
}

case "$PHASE" in
  prepare)
    require_legacy_disk_slots_inert
    operation="oci-infrastructure-prepare-$BOUND_RUNTIME_MODE"
    # Capacity acquisition is a k3s-only Free Tier concern and is never a
    # prepare prerequisite in either mode.
    [ -z "$CAPACITY_ACQUISITION_RUN_ID" ]
    echo "infrastructure_binding=$operation prerequisites=none"
    exit 0
    ;;
  finalize)
    require_legacy_disk_slots_inert
    operation="oci-infrastructure-finalize-$BOUND_RUNTIME_MODE"
    ;;
  diagnose-disk)
    [ "$BOUND_RUNTIME_MODE" = "k3s" ]
    require_disk_legacy_slots_inert
    [ -z "$(jq -r '.ghcr_package_validation_run_id // ""' <<<"$DISPATCH_INPUTS")" ]
    operation="oci-k3s-disk-diagnose"
    ;;
  reclaim-disk)
    [ "$BOUND_RUNTIME_MODE" = "k3s" ]
    require_disk_legacy_slots_inert
    case "$(jq -r '.reclaim_category // ""' <<<"$DISPATCH_INPUTS")" in
      apt-package-cache)
        [ -z "$(jq -r '.ghcr_package_validation_run_id // ""' <<<"$DISPATCH_INPUTS")" ]
        operation="oci-k3s-disk-reclaim-apt"
        ;;
      cri-owned-unused-images)
        jq -e '
          (.ghcr_package_validation_run_id // "") |
          test("^[1-9][0-9]*$")
        ' <<<"$DISPATCH_INPUTS" >/dev/null
        operation="oci-k3s-disk-reclaim-cri"
        ;;
      *)
        echo "unsupported reclaim category" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unsupported phase: $PHASE" >&2
    exit 1
    ;;
esac

if [ "$PHASE" = "finalize" ] && [ "$BOUND_RUNTIME_MODE" = "k3s" ]; then
  [ -n "$CAPACITY_ACQUISITION_RUN_ID" ]
else
  # OKE and disk-recovery operations do not consume a capacity acquisition.
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
