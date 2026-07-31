#!/usr/bin/env bash
set -euo pipefail

# Purpose: discover every production-capable workflow at an exact PR head.
# Usage:
#   PR=63 ./infra/azure/agents/production-workflow-inventory-stan.sh
#   WORKFLOW_DIR=.github/workflows ./infra/azure/agents/production-workflow-inventory-stan.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPO="${REPO:-vasilyevstan/betstan}"
PR_NUMBER="${1:-${PR:-}}"
EXPECTED_HEAD_SHA="${EXPECTED_HEAD_SHA:-}"
WORKFLOW_DIR="${WORKFLOW_DIR:-}"
tmp_dir=""

cleanup() {
  if [[ -n "$tmp_dir" ]]; then
    rm -rf -- "$tmp_dir"
  fi
}
trap cleanup EXIT

if [[ -z "$WORKFLOW_DIR" && -n "$PR_NUMBER" ]]; then
  initial_head="$(
    gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq '.headRefOid'
  )"
  [[ -z "$EXPECTED_HEAD_SHA" || "$initial_head" == "$EXPECTED_HEAD_SHA" ]] || {
    echo "PR head changed before workflow inventory" >&2
    exit 1
  }

  tmp_dir="$(mktemp -d)"
  WORKFLOW_DIR="$tmp_dir/.github/workflows"
  mkdir -p "$WORKFLOW_DIR"
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    output="$tmp_dir/$path"
    mkdir -p "$(dirname "$output")"
    gh api "repos/$REPO/contents/$path?ref=$initial_head" --jq '.content' |
      tr -d '\n' |
      python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))' \
        > "$output"
  done < <(
    gh api "repos/$REPO/git/trees/$initial_head?recursive=1" \
      --jq '.tree[] | select(.type == "blob" and (.path | startswith(".github/workflows/"))) | .path'
  )

  final_head="$(
    gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq '.headRefOid'
  )"
  [[ "$final_head" == "$initial_head" ]] || {
    echo "PR head changed during workflow inventory" >&2
    exit 1
  }
elif [[ -z "$WORKFLOW_DIR" ]]; then
  WORKFLOW_DIR="$ROOT_DIR/.github/workflows"
fi

[[ -d "$WORKFLOW_DIR" ]] || {
  echo "workflow directory not found: $WORKFLOW_DIR" >&2
  exit 1
}

workflow_set="$(
  ruby -ryaml - "$WORKFLOW_DIR" <<'RUBY'
directory = ARGV.fetch(0)

names = Dir.glob(File.join(directory, "*.{yml,yaml}")).each_with_object([]) do |file, result|
  content = File.read(file)
  document = YAML.safe_load(content, aliases: true) || {}
  triggers = document["on"] || document[true] || {}
  next unless triggers.is_a?(Hash)

  push_master = false
  if triggers.key?("push")
    push = triggers["push"]
    push_master =
      if push.nil?
        true
      elsif push.is_a?(Hash)
        branches = push["branches"]
        branches.nil? || Array(branches).include?("master")
      else
        true
      end
  end

  workflow_run = triggers["workflow_run"]
  chained_production =
    workflow_run.is_a?(Hash) &&
    Array(workflow_run["workflows"]).include?("production-build")

  production_capable = content.match?(
    %r{
      production-(?:automatic|emergency)|
      infra/k8s-prod|
      docker/build-push-action|
      kubectl\s+(?:apply|set\ image)|
      deploy-stan\.sh|
      secrets\.(?:AZURE_CREDENTIALS|RESOURCE_GROUP|CLUSTER_NAME)\b
    }x
  )
  manual_production = triggers.key?("workflow_dispatch")

  next unless production_capable &&
    (push_master || chained_production || manual_production)

  result << (document["name"] || File.basename(file, File.extname(file)))
end

puts names.sort.uniq
RUBY
)"

grep -qx "production-build" <<<"$workflow_set" || {
  echo "production-build was not found in the workflow inventory" >&2
  exit 1
}
grep -qx "production-deploy" <<<"$workflow_set" || {
  echo "production-deploy was not found in the workflow inventory" >&2
  exit 1
}

echo "production_workflows=$(paste -sd, - <<<"$workflow_set")"
