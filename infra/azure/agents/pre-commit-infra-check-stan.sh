#!/usr/bin/env bash
set -euo pipefail

# Purpose: scan infra changes for secrets, validate ingress routing, and warn on
#          common commit-safety mistakes before pushing a branch.
# Usage:
#   ./infra/azure/agents/pre-commit-infra-check-stan.sh
#   INFRA_DIRS="infra/k8s-prod infra/k8s" ./infra/azure/agents/pre-commit-infra-check-stan.sh

INFRA_DIRS="${INFRA_DIRS:-infra/azure/agents infra/k8s-prod infra/k8s .github/workflows}"
INGRESS_GUARD="${INGRESS_GUARD:-infra/azure/agents/ingress-routing-guard-stan.sh}"

warnings=0
errors=0

warn() {
  echo "WARN: $*" >&2
  warnings=$((warnings + 1))
}

fail() {
  echo "ERROR: $*" >&2
  errors=$((errors + 1))
}

current_branch="${BRANCH_NAME:-$(git branch --show-current 2>/dev/null || true)}"
if [[ "$current_branch" == "master" && "${GITHUB_ACTIONS:-false}" != "true" ]]; then
  echo "ERROR: direct work on master is forbidden; switch to dev or a branch based on dev" >&2
  echo "RESULT=BLOCKED"
  exit 1
fi

# ── 1. Check staged files for common secrets patterns ────────────────────────
echo "=== scanning staged/modified infra files for secrets patterns ==="

target_files=()
for dir in $INFRA_DIRS; do
  if [[ -d "$dir" ]]; then
    while IFS= read -r -d '' f; do
      target_files+=("$f")
    done < <(find "$dir" -type f \( -name "*.sh" -o -name "*.yml" -o -name "*.yaml" \) -print0 2>/dev/null)
  fi
done

for f in "${target_files[@]}"; do
  # Hard-coded password/token/secret values (not env-var references)
  secret_matches="$(
    python3 - "$f" <<'PY'
import re
import sys

path = sys.argv[1]
assignment = re.compile(
    r"(?i)(?<![A-Za-z0-9_-])"
    r"(?P<quote>[\x27\x22]?)"
    r"(?P<key>[A-Za-z_][A-Za-z0-9_-]*)(?P=quote)"
    r"\s*(?P<operator>[=:])\s*"
)
oidc_yaml = re.compile(
    r"^\s*id-token\s*:\s*(?:read|write|none)\s*(?:#.*)?$",
    re.IGNORECASE,
)
oidc_serialized = re.compile(
    r'(^|[,"\s])id-token\s*=\s*(?:read|write|none)(?=$|[,"\s])',
    re.IGNORECASE,
)
safe_values = (
    re.compile(r"^\$\{\{[^{}\r\n]+\}\}$"),
    re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-+?=])?\}$"),
    re.compile(r"^\$[A-Za-z_][A-Za-z0-9_]*$"),
    re.compile(r"^\$\([^\r\n]+\)$"),
    re.compile(r"^secrets\.[A-Za-z0-9_]+$", re.IGNORECASE),
    re.compile(r"^(?:placeholder|CHANGE_ME)$", re.IGNORECASE),
    re.compile(r"^<[^>\r\n]+>$"),
)


def is_sensitive_key(key: str) -> bool:
    compact = re.sub(r"[-_]", "", key).lower()
    if compact.endswith(("password", "secret", "apikey", "privatekey", "jwtkey")):
        return True
    if compact.endswith("token"):
        return not compact.endswith("locktoken")
    return False


def scalar_at(text: str, offset: int) -> tuple[str, str, bool]:
    remainder = text[offset:].lstrip()
    if not remainder:
        return "", "", True
    if remainder[0] in {'"', "'"}:
        quote = remainder[0]
        end = remainder.find(quote, 1)
        if end < 0:
            return remainder[1:], "", False
        return remainder[1:end], remainder[end + 1 :], True
    if remainder.startswith("${{"):
        end = remainder.find("}}", 3)
        if end < 0:
            return remainder, "", False
        return remainder[: end + 2], remainder[end + 2 :], True
    if remainder.startswith("${"):
        end = remainder.find("}", 2)
        if end < 0:
            return remainder, "", False
        return remainder[: end + 1], remainder[end + 1 :], True
    if remainder.startswith("$("):
        end = remainder.find(")", 2)
        if end < 0:
            return remainder, "", False
        return remainder[: end + 1], remainder[end + 1 :], True
    variable = re.match(r"\$[A-Za-z_][A-Za-z0-9_]*", remainder)
    if variable:
        return variable.group(0), remainder[variable.end() :], True
    match = re.match(r"[^,;#\s]+", remainder)
    if not match:
        return "", remainder, True
    return match.group(0), remainder[match.end() :], True


def has_safe_tail(remainder: str, operator: str) -> bool:
    if not remainder or re.fullmatch(r"\s*", remainder):
        return True
    if re.match(r"^\s+#", remainder):
        return True
    if re.fullmatch(r"[\s,\]\}\)\x27\x22\x5c\|&;]*", remainder):
        return True
    if operator == "=" and re.match(r"^\s*(?:;|&&|\|\|?)(?:\s|$)", remainder):
        return True
    return False


with open(path, encoding="utf-8", errors="replace") as source:
    for line_number, original in enumerate(source, start=1):
        if original.lstrip().startswith("#") or oidc_yaml.fullmatch(original.rstrip("\n")):
            continue
        line = oidc_serialized.sub(
            lambda match: f"{match.group(1)}oidc-permission=safe",
            original,
        )
        for match in assignment.finditer(line):
            if not is_sensitive_key(match.group("key")):
                continue
            value, remainder, complete = scalar_at(line, match.end())
            if len(value) < 4:
                continue
            if (
                complete
                and has_safe_tail(remainder, match.group("operator"))
                and any(pattern.fullmatch(value) for pattern in safe_values)
            ):
                continue
            print(f"{line_number}:{match.group('key').lower()}=<redacted>")
PY
  )"
  if [[ -n "$secret_matches" ]]; then
    fail "$f: possible hard-coded secret value"
    head -5 <<<"$secret_matches" >&2
  fi

  # Bearer tokens or base64-looking auth strings
  if grep -nE 'Bearer\s+[A-Za-z0-9+/=]{20,}' "$f" 2>/dev/null | grep -q .; then
    fail "$f: possible hard-coded Bearer token"
  fi

  # Private key header (skip this script itself to avoid self-match on the grep pattern)
  this_script="$(basename "${BASH_SOURCE[0]}")"
  if [[ "$(basename "$f")" != "$this_script" ]]; then
    if grep -nF 'BEGIN PRIVATE KEY' "$f" 2>/dev/null | grep -q .; then
      fail "$f: private key block detected"
    fi
  fi
done

echo "secrets_scan: files_checked=${#target_files[@]} errors=$errors"

# ── 2. Warn if artifacts/ is staged ─────────────────────────────────────────
echo ""
echo "=== checking for artifacts/ in staging area ==="
if git diff --cached --name-only 2>/dev/null | grep -q '^artifacts/'; then
  fail "artifacts/ directory is staged — add it to .gitignore and unstage"
elif [[ -d "artifacts" ]]; then
  if ! grep -qF 'artifacts/' .gitignore 2>/dev/null && ! grep -qF '/artifacts' .gitignore 2>/dev/null; then
    warn "artifacts/ directory exists but is not in .gitignore"
  else
    echo "artifacts_check: gitignored=yes"
  fi
else
  echo "artifacts_check: no artifacts/ dir"
fi

# ── 3. Run ingress routing guard ─────────────────────────────────────────────
echo ""
echo "=== running ingress routing guard ==="
if [[ -x "$INGRESS_GUARD" ]]; then
  "$INGRESS_GUARD"
else
  warn "ingress guard not found or not executable: $INGRESS_GUARD"
fi

# ── 4. Warn on hard-coded non-internal IPs in new k8s manifests ──────────────
echo ""
echo "=== checking for hard-coded public IPs in k8s manifests ==="
for dir in infra/k8s-prod infra/k8s infra/k8s-stage; do
  [[ -d "$dir" ]] || continue
  while IFS= read -r -d '' f; do
    # Match IPs that are not internal (10.x, 127.x, 0.0.0.0) and not nip.io lines
    if grep -nE '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' "$f" 2>/dev/null | \
        grep -vE '(10\.|127\.|0\.0\.0\.0|nip\.io|#)' | grep -q .; then
      warn "$f: possible hard-coded public IP (review before committing)"
      grep -nE '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' "$f" 2>/dev/null | \
        grep -vE '(10\.|127\.|0\.0\.0\.0|nip\.io|#)' | head -3 >&2 || true
    fi
  done < <(find "$dir" -name "*.yaml" -print0 2>/dev/null)
done

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "pre_commit_infra_check: errors=$errors warnings=$warnings"
if [[ "$errors" -gt 0 ]]; then
  echo "RESULT=BLOCKED — fix errors before committing" >&2
  exit 1
elif [[ "$warnings" -gt 0 ]]; then
  echo "RESULT=WARN — review warnings before committing"
  exit 0
else
  echo "RESULT=PASS"
fi
