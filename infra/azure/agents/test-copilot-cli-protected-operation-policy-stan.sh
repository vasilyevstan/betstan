#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POLICY="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
INVENTORY="$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.sh"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-policy-test.XXXXXX")"
policy_file="$tmp_dir/policy.json"
cleanup() {
  rm -f "$policy_file" "$tmp_dir/unknown.out"
  rmdir "$tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT

bash -n "$POLICY"
"$POLICY" all >"$policy_file"

operation_count="$("$POLICY" operations | wc -l | tr -d ' ')"
[[ "$operation_count" = "31" ]] || {
  echo "expected 31 protected operations, got $operation_count" >&2
  exit 1
}

inventory="$(
  WORKFLOW_DIR="$ROOT_DIR/.github/workflows" "$INVENTORY"
)"
inventory_names="${inventory#production_workflows=}"
policy_names="$("$POLICY" workflows | sed -E 's/\.ya?ml$//' | paste -sd, -)"
[[ "$policy_names" = "$inventory_names" ]] || {
  echo "protected-operation policy does not match production workflow inventory" >&2
  echo "policy=$policy_names" >&2
  echo "inventory=$inventory_names" >&2
  exit 1
}

ruby - "$ROOT_DIR" "$policy_file" <<'RUBY'
require "json"
require "yaml"

root = ARGV.fetch(0)
policies = JSON.parse(File.read(ARGV.fetch(1)))
expected_policy_keys = %w[
  approvalWorkflowState
  authority
  allowEmptyInputs
  booleanInputs
  derivedOperations
  environment
  event
  fixedInputs
  forbiddenInputValues
  fullShaInputs
  inputNames
  inputPatterns
  inputTemplates
  objectIdOrLiterals
  operation
  optionalPositiveIntegerInputs
  positiveIntegerInputs
  requiresConsumedUpstream
  subjectInput
  subjectRelation
  targetInput
  targetRelation
  titleTemplate
  upstreamConclusion
  upstreamEvent
  upstreamOperations
  upstreamWorkflow
  workflow
  zeroOrPositiveIntegerInputs
].sort

def fail(message)
  abort message
end

def triggers(document)
  value = document["on"] || document[true]
  value.is_a?(Hash) ? value : {}
end

def environments(document)
  jobs = document["jobs"]
  return [] unless jobs.is_a?(Hash)

  jobs.values.map do |job|
    next unless job.is_a?(Hash)

    environment = job["environment"]
    if environment.is_a?(Hash)
      environment["name"]
    elsif environment.is_a?(String)
      environment
    end
  end.compact.uniq
end

by_workflow = policies.group_by { |policy| policy.fetch("workflow") }
disabled_before_approval = %w[
  oci-capacity-acquire.yml
  oci-infrastructure.yml
  oci-live-betting-activate.yml
  oci-live-data-rollout.yml
  oci-migration-recovery.yml
  oci-production-deploy.yml
].sort
policies.each do |policy|
  operation = policy.fetch("operation")
  fail("#{operation} has unexpected fields") unless policy.keys.sort == expected_policy_keys
  workflow = policy.fetch("workflow")
  path = File.join(root, ".github", "workflows", workflow)
  fail("#{operation} references a missing workflow") unless File.file?(path)
  document = YAML.safe_load(File.read(path), aliases: true)
  workflow_triggers = triggers(document)
  event = policy.fetch("event")
  fail("#{operation} references an absent trigger") unless workflow_triggers.key?(event)
  fail("#{operation} auto-approves a scheduled run") if event == "schedule"
  unless environments(document).include?(policy.fetch("environment"))
    fail("#{operation} references an absent protected environment")
  end
  expected_state = disabled_before_approval.include?(workflow) ?
    "disabled_manually" : "active"
  unless policy.fetch("approvalWorkflowState") == expected_state
    fail("#{operation} has the wrong approval workflow state")
  end

  if policy.fetch("authority") == "dispatch-record"
    dispatch = workflow_triggers.fetch("workflow_dispatch")
    inputs = dispatch.is_a?(Hash) ? dispatch["inputs"] : nil
    actual_inputs = inputs.is_a?(Hash) ? inputs.keys.sort : []
    unless actual_inputs == policy.fetch("inputNames").sort
      fail("#{operation} policy inputs differ from #{workflow}")
    end
    fail("#{operation} is missing an exact title") if policy["titleTemplate"].to_s.empty?
  elsif !policy.fetch("inputNames").empty?
    fail("#{operation} automatic policy unexpectedly declares dispatch inputs")
  end
end

by_workflow.each do |workflow, entries|
  fail("#{workflow} has no operation policy") if entries.empty?
end

required_derived = {
  "ghcr-package-repair-build" => ["oci-production-build-repair"],
  "oci-migrate" => ["oci-migration-recovery-automatic"],
  "oci-migrate-recover-closed" => ["oci-migration-recovery-automatic"],
}
required_derived.each do |operation, expected|
  policy = policies.find { |entry| entry["operation"] == operation }
  fail("missing #{operation}") unless policy
  fail("#{operation} lost derived authority") unless policy["derivedOperations"] == expected
end

puts "protected_operation_policy=PASS operations=#{policies.length} workflows=#{by_workflow.length}"
RUBY

if "$POLICY" get not-a-real-operation >"$tmp_dir/unknown.out" 2>&1; then
  echo "unknown operation unexpectedly passed" >&2
  exit 1
fi

echo "copilot_cli_protected_operation_policy_tests=PASS"
