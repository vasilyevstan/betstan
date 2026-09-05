#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/azure/agents/pr-context-labels-stan.sh"
WORK_DIR="$(mktemp -d)"
BIN_DIR="$WORK_DIR/bin"
LOG_FILE="$WORK_DIR/gh.log"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
mkdir -p "$BIN_DIR"

cat >"$BIN_DIR/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$STUB_GH_LOG"
printf '\n' >>"$STUB_GH_LOG"

case "${1:-}:${2:-}" in
  label:create)
    [[ "${STUB_FAIL_MODE:-}" != "create" ]] || exit 1
    ;;
  pr:edit)
    [[ "${STUB_FAIL_MODE:-}" != "edit" ]] || exit 1
    ;;
  pr:view)
    [[ "${STUB_FAIL_MODE:-}" != "view" ]] || exit 1
    printf '%s\n' "$EXPECTED_SESSION_LABEL"
    if [[ "${STUB_FAIL_MODE:-}" != "missing-feature" ]]; then
      printf '%s\n' "$EXPECTED_FEATURE_LABEL"
    fi
    ;;
  *)
    echo "unsupported gh call" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$BIN_DIR/gh"

run_helper() {
  PATH="$BIN_DIR:$PATH" \
  STUB_GH_LOG="$LOG_FILE" \
  EXPECTED_SESSION_LABEL="session:live-betting-2026-09-04" \
  EXPECTED_FEATURE_LABEL="feature:live-betting" \
  PR_SESSION_TAG="live-betting-2026-09-04" \
  PR_FEATURE_TAG="live-betting" \
    "$SCRIPT" 42
}

output="$(run_helper)"
grep -Fqx 'pr_context_labels=APPLIED' <<<"$output"
grep -Fq 'label create session:live-betting-2026-09-04' "$LOG_FILE"
grep -Fq 'label create feature:live-betting' "$LOG_FILE"
grep -Fq 'pr edit 42' "$LOG_FILE"
grep -Fq -- '--add-label session:live-betting-2026-09-04' "$LOG_FILE"
grep -Fq -- '--add-label feature:live-betting' "$LOG_FILE"

: >"$LOG_FILE"
if PATH="$BIN_DIR:$PATH" \
    STUB_GH_LOG="$LOG_FILE" \
    PR_SESSION_TAG="Private Session" \
    PR_FEATURE_TAG="live-betting" \
    "$SCRIPT" 42 >/dev/null 2>&1; then
  echo "invalid session tags must fail before GitHub mutation" >&2
  exit 1
fi
[[ ! -s "$LOG_FILE" ]]

: >"$LOG_FILE"
warning_output="$(
  STUB_FAIL_MODE="edit" run_helper 2>"$WORK_DIR/warning.stderr"
)"
grep -Fqx 'pr_context_labels=WARNING' <<<"$warning_output"
grep -Fq 'could not apply informational context labels' \
  "$WORK_DIR/warning.stderr"

if STUB_FAIL_MODE="missing-feature" \
    PR_CONTEXT_LABELS_STRICT="true" \
    run_helper >/dev/null 2>&1; then
  echo "strict verification must fail when a context label is missing" >&2
  exit 1
fi

echo "pr_context_labels_tests=PASS"
