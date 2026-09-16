#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/azure/agents/pr-context-labels-stan.sh"
WORK_DIR="$(mktemp -d)"
BIN_DIR="$WORK_DIR/bin"
LOG_FILE="$WORK_DIR/gh.log"
LABELS_FILE="$WORK_DIR/labels"
EDIT_FILE="$WORK_DIR/edited"

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
    touch "$STUB_EDIT_FILE"
    while (( $# )); do
      if [[ "$1" == "--add-label" ]]; then
        shift
        if ! grep -Fqx "$1" "$STUB_LABELS_FILE"; then
          printf '%s\n' "$1" >>"$STUB_LABELS_FILE"
        fi
      fi
      shift
    done
    ;;
  pr:view)
    [[ "${STUB_FAIL_MODE:-}" != "view" ]] || exit 1
    if [[ "${STUB_FAIL_MODE:-}" == "view-after-edit" &&
          -f "$STUB_EDIT_FILE" ]]; then
      exit 1
    fi
    while IFS= read -r label; do
      if [[ "${STUB_FAIL_MODE:-}" != "missing-feature" ||
            "$label" != "$EXPECTED_FEATURE_LABEL" ]]; then
        printf '%s\n' "$label"
      fi
    done <"$STUB_LABELS_FILE"
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
  STUB_LABELS_FILE="$LABELS_FILE" \
  STUB_EDIT_FILE="$EDIT_FILE" \
  EXPECTED_SESSION_LABEL="session:live-betting-2026-09-04" \
  EXPECTED_FEATURE_LABEL="feature:live-betting" \
  PR_SESSION_TAG="live-betting-2026-09-04" \
  PR_FEATURE_TAG="live-betting" \
    "$SCRIPT" 42
}

reset_fixture() {
  : >"$LOG_FILE"
  : >"$LABELS_FILE"
  rm -f "$EDIT_FILE"
}

assert_no_mutations() {
  if grep -Eq '^(label create|pr edit) ' "$LOG_FILE"; then
    echo "label helper unexpectedly mutated GitHub" >&2
    exit 1
  fi
}

reset_fixture
printf '%s\n' "session:live-betting-2026-09-04" \
  "feature:live-betting" "unrelated-label" >"$LABELS_FILE"
output="$(run_helper)"
grep -Fqx 'pr_context_labels=APPLIED' <<<"$output"
assert_no_mutations
[[ "$(grep -c '^pr view ' "$LOG_FILE")" == "1" ]]
grep -Fqx 'unrelated-label' "$LABELS_FILE"

reset_fixture
output="$(run_helper)"
grep -Fqx 'pr_context_labels=APPLIED' <<<"$output"
grep -Fq 'label create session:live-betting-2026-09-04' "$LOG_FILE"
grep -Fq 'label create feature:live-betting' "$LOG_FILE"
grep -Fq 'pr edit 42' "$LOG_FILE"
grep -Fq -- '--add-label session:live-betting-2026-09-04' "$LOG_FILE"
grep -Fq -- '--add-label feature:live-betting' "$LOG_FILE"
[[ "$(grep -c '^pr edit ' "$LOG_FILE")" == "1" ]]

reset_fixture
printf '%s\n' "session:live-betting-2026-09-04" \
  "unrelated-label" >"$LABELS_FILE"
output="$(run_helper)"
grep -Fqx 'pr_context_labels=APPLIED' <<<"$output"
if grep -Fq 'label create session:' "$LOG_FILE" ||
  grep -Fq -- '--add-label session:' "$LOG_FILE"; then
  echo "an existing session label must not be mutated" >&2
  exit 1
fi
grep -Fq -- '--add-label feature:live-betting' "$LOG_FILE"
[[ "$(grep -c '^pr edit ' "$LOG_FILE")" == "1" ]]
grep -Fqx 'unrelated-label' "$LABELS_FILE"

reset_fixture
if PATH="$BIN_DIR:$PATH" \
    STUB_GH_LOG="$LOG_FILE" \
    PR_SESSION_TAG="Private Session" \
    PR_FEATURE_TAG="live-betting" \
    "$SCRIPT" 42 >/dev/null 2>&1; then
  echo "invalid session tags must fail before GitHub mutation" >&2
  exit 1
fi
[[ ! -s "$LOG_FILE" ]]

reset_fixture
warning_output="$(
  STUB_FAIL_MODE="edit" run_helper 2>"$WORK_DIR/warning.stderr"
)"
grep -Fqx 'pr_context_labels=WARNING' <<<"$warning_output"
grep -Fq 'could not apply informational context labels' \
  "$WORK_DIR/warning.stderr"

for strict in false true; do
  reset_fixture
  if warning_output="$(
    STUB_FAIL_MODE="view" PR_CONTEXT_LABELS_STRICT="$strict" \
      run_helper 2>"$WORK_DIR/warning.stderr"
  )"; then
    [[ "$strict" == "false" ]]
  else
    [[ "$strict" == "true" ]]
  fi
  grep -Fqx 'pr_context_labels=WARNING' <<<"$warning_output"
  assert_no_mutations
  [[ "$(grep -c '^pr view ' "$LOG_FILE")" == "1" ]]
done

reset_fixture
if STUB_FAIL_MODE="missing-feature" \
    PR_CONTEXT_LABELS_STRICT="true" \
    run_helper >/dev/null 2>&1; then
  echo "strict verification must fail when a context label is missing" >&2
  exit 1
fi

reset_fixture
if STUB_FAIL_MODE="view-after-edit" \
    PR_CONTEXT_LABELS_STRICT="true" \
    run_helper >/dev/null 2>&1; then
  echo "strict verification must reject a failed post-edit read" >&2
  exit 1
fi

reset_fixture
warning_output="$(STUB_FAIL_MODE="create" run_helper 2>/dev/null)"
grep -Fqx 'pr_context_labels=WARNING' <<<"$warning_output"

echo "pr_context_labels_tests=PASS"
