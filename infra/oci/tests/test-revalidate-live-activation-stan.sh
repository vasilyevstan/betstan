#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/scripts/revalidate-live-activation-stan.sh"
WORKFLOW="$ROOT_DIR/.github/workflows/oci-live-betting-activate.yml"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

SOURCE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
mkdir -p "$WORK_DIR/bin"

fail() {
  echo "live activation revalidation contract failed: $*" >&2
  exit 1
}

cat >"$WORK_DIR/bin/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "fetch" ]]; then
  exit 0
fi
if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then
  printf '%s\n' "${STUB_HEAD_SHA:?}"
  exit 0
fi
if [[ "$1" == "rev-parse" && "$2" == "origin/master" ]]; then
  printf '%s\n' "${STUB_MASTER_SHA:?}"
  exit 0
fi
echo "unexpected git invocation: $*" >&2
exit 1
STUB

cat >"$WORK_DIR/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
endpoint="$2"
run_id="${endpoint##*/}"
case "$run_id" in
  101) path=".github/workflows/oci-production-build.yml"; event="workflow_run" ;;
  102) path=".github/workflows/oci-infrastructure.yml"; event="workflow_dispatch" ;;
  103) path=".github/workflows/oci-production-deploy.yml"; event="workflow_dispatch" ;;
  *) echo "unexpected run ID: $run_id" >&2; exit 1 ;;
esac
printf '%s\t%s\t%s\tmaster\texample/repo\tcompleted\tsuccess\t%s\n' \
  "$path" "$event" "${STUB_RUN_SHA:?}" "${STUB_RUN_ATTEMPT:-1}"
STUB
chmod +x "$WORK_DIR/bin/git" "$WORK_DIR/bin/gh"

run_revalidation() {
  PATH="$WORK_DIR/bin:$PATH" \
  STUB_HEAD_SHA="${STUB_HEAD_SHA:-$SOURCE_SHA}" \
  STUB_MASTER_SHA="${STUB_MASTER_SHA:-$SOURCE_SHA}" \
  STUB_RUN_SHA="${STUB_RUN_SHA:-$SOURCE_SHA}" \
  STUB_RUN_ATTEMPT="${STUB_RUN_ATTEMPT:-1}" \
  SOURCE_SHA="$SOURCE_SHA" \
  BUILD_RUN_ID=101 \
  INFRASTRUCTURE_RUN_ID=102 \
  DEPLOYMENT_RUN_ID=103 \
  REPOSITORY=example/repo \
  GITHUB_REF_NAME=master \
  GITHUB_RUN_ATTEMPT=1 \
  GITHUB_RUN_ID=104 \
    "$SCRIPT"
}

run_revalidation >/dev/null

if STUB_MASTER_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  run_revalidation >/dev/null 2>&1; then
  echo "revalidation accepted an advanced master" >&2
  exit 1
fi

if STUB_RUN_ATTEMPT=2 run_revalidation >/dev/null 2>&1; then
  echo "revalidation accepted rerun provenance" >&2
  exit 1
fi

python3 - "$WORK_DIR" <<'PY'
import copy
import json
from pathlib import Path
import sys
root = Path(sys.argv[1])
def financial(remaining, closed, revision, status="CONFIRMED"):
    return {"originalStakeMinor": 1000, "remainingStakeMinor": remaining,
            "cumulativeClosedStakeMinor": closed, "cumulativeReturnMinor": closed,
            "revision": revision, "status": status}
def accepted(mode, remaining, closed, revision):
    return {"state": "ACCEPTED", "receipt": {
        "outcome": "ACCEPTED", "mode": mode,
        "financial": financial(remaining, closed, revision, "CASH_BACK" if mode == "FULL" else "CONFIRMED"),
    }}
compatibility = {"runId": "104", "cashBack": {"mode": "compatibility", "compatibility": {
    "newAdmissionRefused": True, "historyReadable": True, "noPendingIdentifier": True,
}}}
active = {"runId": "104", "cashBack": {
    "mode": "active", "liveFull": {"operation": accepted("FULL", 0, 1000, 1)},
    "preMatchFull": {"operation": accepted("FULL", 0, 1000, 1), "confirmedThroughUI": True},
    "partial": {
        "operations": [accepted("PARTIAL", 900, 100, 1), accepted("PARTIAL", 800, 200, 2)],
        "settlement": financial(800, 200, 3, "WIN"),
    },
    "recovery": {
        "interruption": {
            "sourceSha": "a" * 40, "runId": "104", "stopped": True, "restored": True,
            "replicas": 1, "beforePodFingerprints": ["a" * 64], "afterPodFingerprints": ["b" * 64],
            "checkpoint": {"pendingObservedWithZeroWorkers": True, "operationId": "c" * 64},
        },
        "operation": {"state": "REJECTED", "operationId": "c" * 64, "receipt": {
            "outcome": "REJECTED", "reason": "QUOTE_EXPIRED", "financial": financial(1000, 0, 1),
        }},
        "sameIdentityReplay": True,
        "drained": {key: True for key in ("rootPresent", "slotDrained", "terminalHistory",
                                        "outcomePublished", "projectionComplete", "receiptMatches")},
    },
    "fullImmutableAfterResults": True,
}}
for name, value in (("compatibility", compatibility), ("active", active)):
    (root / f"{name}.json").write_text(json.dumps(value))
mutations = {
    "missing-pending": lambda value: value["cashBack"]["recovery"]["interruption"]["checkpoint"].update(pendingObservedWithZeroWorkers=False),
    "stale-source": lambda value: value["cashBack"]["recovery"]["interruption"].update(sourceSha="b" * 40),
    "worker-overlap": lambda value: value["cashBack"]["recovery"]["interruption"].update(afterPodFingerprints=["a" * 64]),
    "pending-release": lambda value: value["cashBack"]["recovery"]["drained"].update(slotDrained=False),
    "principal-reset": lambda value: value["cashBack"]["partial"]["settlement"].update(remainingStakeMinor=1000),
    "mutable-full": lambda value: value["cashBack"].update(fullImmutableAfterResults=False),
    "unknown-receipt": lambda value: value["cashBack"]["liveFull"]["operation"]["receipt"].update(outcome="UNKNOWN"),
    "wrong-mode": lambda value: value["cashBack"].update(mode="compatibility"),
    "wrong-run": lambda value: value.update(runId="105"),
}
for name, mutate in mutations.items():
    value = copy.deepcopy(active)
    mutate(value)
    (root / f"{name}.json").write_text(json.dumps(value))
PY
for cash_back_mode in compatibility active; do
  CASH_BACK_ACCEPTANCE_MODE="$cash_back_mode" \
  CASH_BACK_ACCEPTANCE_EVIDENCE_FILE="$WORK_DIR/$cash_back_mode.json" \
    run_revalidation >/dev/null
done
for negative in missing-pending stale-source worker-overlap pending-release principal-reset mutable-full unknown-receipt wrong-mode wrong-run missing-file; do
  if CASH_BACK_ACCEPTANCE_MODE=active \
      CASH_BACK_ACCEPTANCE_EVIDENCE_FILE="$WORK_DIR/$negative.json" \
      run_revalidation >/dev/null 2>&1; then
    fail "invalid cash-back acceptance passed: $negative"
  fi
done

for literal in \
  'Write accepted activation lease evidence' \
  'activation_state=leased' \
  'accepted.env' \
  'Upload protected accepted activation evidence' \
  'oci-live-activation-accepted-' \
  'steps.accepted_evidence_upload.outcome != '\''success'\''' \
  'Write final activation provenance' \
  'WORKFLOW_RESULT: ${{ job.status }}' \
  'activation_state=committed' \
  'post_commit_status=' \
  'workflow_result=' \
  '!cancelled()' \
  'steps.commit_preflight.outcome != '\''success'\''' \
  'failure() || cancelled()'; do
  grep -Fq "$literal" "$WORKFLOW" ||
    fail "activation workflow is missing safety contract: $literal"
done
grep -Fq 'CASH_BACK_ACCEPTANCE_EVIDENCE_FILE: artifacts/live-control/acceptance/evidence.json' "$WORKFLOW" ||
  fail "final activation revalidation is not bound to cash-back acceptance"

if grep -Fq "steps.evidence_upload.outcome != 'success'" "$WORKFLOW"; then
  fail "activation workflow still disables live based on post-commit evidence upload"
fi

python3 - "$WORKFLOW" <<'PY'
import sys
from pathlib import Path

content = Path(sys.argv[1]).read_text(encoding="utf-8")


def require_order(markers: list[str], label: str) -> None:
    positions: list[int] = []
    for marker in markers:
        position = content.find(marker)
        if position < 0:
            raise SystemExit(f"{label} is missing ordered marker: {marker}")
        positions.append(position)
    if positions != sorted(positions):
        raise SystemExit(f"{label} ordered markers are out of sequence")


require_order(
    [
        "Write accepted activation lease evidence",
        "Upload protected accepted activation evidence",
        "Revalidate release head before permanent activation",
        "Commit accepted live activation",
        "Enforce dark mode unless activation committed",
        "Revoke exact OKE runner rule",
        "Close ephemeral OCI Bastion access",
        "Write final activation provenance",
        "Upload protected activation evidence",
    ],
    "activation workflow",
)
require_order(
    [
        "Verify declared cash-back generation mode",
        "Exercise complete production live journey",
        "Reconcile protected cash-back worker interruption",
        "Revoke and clean reusable validation account",
        "Revalidate release head before acceptance",
        "Write accepted activation lease evidence",
    ],
    "cash-back acceptance",
)
PY

echo "live activation revalidation contract: PASS"
