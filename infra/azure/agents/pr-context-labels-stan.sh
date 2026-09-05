#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-vasilyevstan/betstan}"
PR_NUMBER="${1:-${PR:-}}"
SESSION_TAG="${PR_SESSION_TAG:-}"
FEATURE_TAG="${PR_FEATURE_TAG:-}"
STRICT="${PR_CONTEXT_LABELS_STRICT:-false}"

warn() {
  printf 'warning: %s\n' "$*" >&2
}

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "REPO must be an owner/repository name" >&2
  exit 1
}
[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || {
  echo "PR number must be a positive integer" >&2
  exit 1
}
[[ "$STRICT" == "true" || "$STRICT" == "false" ]] || {
  echo "PR_CONTEXT_LABELS_STRICT must be true or false" >&2
  exit 1
}

validate_tag() {
  local value="$1"
  local name="$2"
  [[ "$value" =~ ^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$ ]] || {
    echo "$name must be a 1-42 character lowercase public-safe slug" >&2
    exit 1
  }
}

validate_tag "$SESSION_TAG" "PR_SESSION_TAG"
validate_tag "$FEATURE_TAG" "PR_FEATURE_TAG"
command -v gh >/dev/null 2>&1 || {
  echo "gh is required" >&2
  exit 1
}

session_label="session:$SESSION_TAG"
feature_label="feature:$FEATURE_TAG"
had_failure=0

ensure_label() {
  local label="$1"
  local color="$2"
  local description="$3"

  if ! gh label create "$label" \
      --repo "$REPO" \
      --color "$color" \
      --description "$description" \
      --force >/dev/null 2>&1; then
    warn "could not ensure informational label $label"
    had_failure=1
  fi
}

ensure_label \
  "$session_label" \
  "5319E7" \
  "Informational public-safe development-session origin"
ensure_label \
  "$feature_label" \
  "1D76DB" \
  "Informational product or engineering feature grouping"

if ! gh pr edit "$PR_NUMBER" \
    --repo "$REPO" \
    --add-label "$session_label" \
    --add-label "$feature_label" >/dev/null 2>&1; then
  warn "could not apply informational context labels to PR #$PR_NUMBER"
  had_failure=1
fi

actual_labels="$(
  gh pr view "$PR_NUMBER" \
    --repo "$REPO" \
    --json labels \
    --jq '.labels[].name' 2>/dev/null || true
)"
for expected_label in "$session_label" "$feature_label"; do
  if ! grep -Fqx "$expected_label" <<<"$actual_labels"; then
    warn "PR #$PR_NUMBER does not currently carry $expected_label"
    had_failure=1
  fi
done

if (( had_failure )); then
  printf '%s\n' \
    "pr_context_labels=WARNING" \
    "pr=$PR_NUMBER" \
    "session_label=$session_label" \
    "feature_label=$feature_label"
  [[ "$STRICT" == "false" ]] || exit 1
  exit 0
fi

printf '%s\n' \
  "pr_context_labels=APPLIED" \
  "pr=$PR_NUMBER" \
  "session_label=$session_label" \
  "feature_label=$feature_label"
