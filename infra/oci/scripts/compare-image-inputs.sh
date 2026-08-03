#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${IMAGE_INPUT_REPOSITORY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
BASE_SHA="${BASE_SHA:-${1:-}}"
TARGET_SHA="${TARGET_SHA:-${2:-}}"

[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "ERROR: BASE_SHA must be a full lowercase commit SHA" >&2
  exit 2
}
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "ERROR: TARGET_SHA must be a full lowercase commit SHA" >&2
  exit 2
}
git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "ERROR: image input repository root is not a git worktree" >&2
  exit 2
}

paths=(
  .dockerignore
  auth
  bet
  backoffice
  client
  event
  gamemaster
  moderation
  resulting
  slip
  infra/oci/build
  infra/oci/scripts/build-images.sh
)

set +e
git -C "$ROOT_DIR" diff --quiet "$BASE_SHA" "$TARGET_SHA" -- "${paths[@]}"
path_status=$?
set -e
case "$path_status" in
  0) ;;
  1) exit 1 ;;
  *)
    echo "ERROR: unable to compare immutable image input paths" >&2
    exit 2
    ;;
esac

base_contract="$(mktemp)"
target_contract="$(mktemp)"
cleanup() {
  rm -f "$base_contract" "$target_contract"
}
trap cleanup EXIT

extract_lib_contract() {
  local ref="$1"
  git -C "$ROOT_DIR" show "${ref}:infra/oci/scripts/lib.sh" |
    awk '
      /^OCI_ROOT_DIR=/ {
        print
        next
      }
      /^oci_(die|log|require_command|require_vars|prepare_private_dir)\(\) \{$/ {
        capture = 1
      }
      capture {
        print
      }
      capture && $0 == "}" {
        capture = 0
      }
    '
}

extract_lib_contract "$BASE_SHA" > "$base_contract" || {
  echo "ERROR: unable to read reusable image library contract" >&2
  exit 2
}
extract_lib_contract "$TARGET_SHA" > "$target_contract" || {
  echo "ERROR: unable to read target image library contract" >&2
  exit 2
}
[[ -s "$base_contract" && -s "$target_contract" ]] || {
  echo "ERROR: image library contract is incomplete" >&2
  exit 2
}
cmp -s "$base_contract" "$target_contract" || exit 1

echo "oci_image_inputs=UNCHANGED base=$BASE_SHA target=$TARGET_SHA"
