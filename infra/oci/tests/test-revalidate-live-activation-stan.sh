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
PY

echo "live activation revalidation contract: PASS"
