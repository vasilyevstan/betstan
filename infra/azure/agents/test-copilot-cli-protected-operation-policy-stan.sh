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
[[ "$operation_count" = "41" ]] || {
  echo "expected 41 protected operations, got $operation_count" >&2
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
  upstreamRunBindings
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
    policy_inputs = policy.fetch("inputNames").sort
    unless actual_inputs == policy_inputs
      inert_disk_defaults = {
        "infrastructure_run_id" => "",
        "diagnosis_run_id" => "",
        "reclaim_category" => "none",
        "reclaim_image_ids" => "[]",
      }
      legacy_infrastructure =
        workflow == "oci-infrastructure.yml" &&
        operation.start_with?("oci-infrastructure-") &&
        (actual_inputs - policy_inputs).sort == inert_disk_defaults.keys.sort &&
        inert_disk_defaults.all? do |name, expected|
          inputs.fetch(name).fetch("default") == expected
        end
      inert_live_data_defaults = {
        "held_handoff_run_id" => "0",
        "held_handoff_source_sha" => "none",
        "incident_continuation_run_id" => "0",
        "incident_continuation_authority_sha256" => "none",
        "incident_continuation_control_sha" => "none",
        "incident_continuation_journal_identity_sha256" => "none",
        "incident_continuation_generation" => "0",
        "incident_access_cleanup_lineage_json" => "[]",
      }
      expected_inert_inputs =
        if operation == "oci-live-data-continue-held-handoff"
          inert_live_data_defaults.keys - %w[
            held_handoff_run_id
            held_handoff_source_sha
          ]
        elsif operation == "oci-live-data-incident-restore"
          []
        else
          inert_live_data_defaults.keys
        end
      legacy_live_data =
        workflow == "oci-live-data-rollout.yml" &&
        (policy_inputs - actual_inputs).empty? &&
        (actual_inputs - policy_inputs).sort == expected_inert_inputs.sort &&
        expected_inert_inputs.all? do |name|
          expected = inert_live_data_defaults.fetch(name)
          inputs.fetch(name).fetch("default") == expected &&
            inputs.fetch(name).fetch("type") == "string"
        end
      unless legacy_infrastructure || legacy_live_data
        fail("#{operation} policy inputs differ from #{workflow}")
      end
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

common_publish = policies.find do |entry|
  entry["operation"] == "common-package-publish"
end
fail("missing common-package-publish") unless common_publish
unless common_publish["workflow"] == "common-package-publish.yml" &&
    common_publish["environment"] == "common-package-release" &&
    common_publish["event"] == "workflow_dispatch" &&
    common_publish["authority"] == "dispatch-record" &&
    common_publish["inputNames"] == %w[source_sha confirmation] &&
    common_publish["fixedInputs"] == {
      "confirmation" => "PUBLISH COMMON PACKAGE EXACT SHA"
    } &&
    common_publish["fullShaInputs"] == ["source_sha"] &&
    common_publish["subjectInput"] == "source_sha" &&
    common_publish["subjectRelation"] == "current"
  fail("common-package-publish policy lost exact publication authority")
end

policies.select { |entry| entry["workflow"] == "oci-infrastructure.yml" }.each do |policy|
  expected_relation = policy["operation"] == "oci-k3s-disk-diagnose" ?
    "ancestor-or-current" : "current"
  unless policy["subjectInput"] == "approved_sha" &&
      policy["subjectRelation"] == expected_relation
    fail("#{policy['operation']} lost its diagnostic-only historical exception")
  end
end

live_data = policies.select do |entry|
  entry["workflow"] == "oci-live-data-rollout.yml"
end.to_h { |entry| [entry.fetch("operation"), entry] }
live_data.reject { |operation, _|
  operation.include?("-resume-") ||
    operation == "oci-live-data-continue-held-handoff" ||
    operation == "oci-live-data-incident-restore"
}.each do |operation, policy|
  unless policy.fetch("inputTemplates").slice(
      "resume_source_sha", "checkpoint_source_sha"
    ) == {
      "resume_source_sha" => "{subject_sha}",
      "checkpoint_source_sha" => "{subject_sha}",
    }
    fail("#{operation} lost current-source templates")
  end
end

incident_restore = live_data.fetch("oci-live-data-incident-restore")
unless incident_restore.fetch("environment") == "oci-migration" &&
    incident_restore.fetch("subjectInput") == "approved_sha" &&
    incident_restore.fetch("subjectRelation") == "current" &&
    incident_restore.fetch("fullShaInputs") == ["approved_sha"] &&
    incident_restore.fetch("upstreamRunBindings") == [] &&
    incident_restore.fetch("fixedInputs") == {
      "resume_source_sha" => "70679a6179df2167cb39f185cb0c26dca2ce649d",
      "build_run_id" => "37576331905",
      "infrastructure_run_id" => "37582984293",
      "checkpoint_source_sha" => "1bf86112ba2458161e6039091b1aa6289fdfce1d",
      "disk_checkpoint_run_id" => "37582984293",
      "phase" => "incident-restore",
      "prerequisite_run_id" => "39945618182",
      "baseline_recovery_run_id" => "0",
      "baseline_recovery_source_sha" => "none",
      "failed_deploy_run_id" => "0",
      "failed_activation_run_id" => "0",
      "failed_activation_user_id" => "0",
      "held_handoff_run_id" => "39945618182",
      "held_handoff_source_sha" => "70679a6179df2167cb39f185cb0c26dca2ce649d",
      "incident_continuation_run_id" => "0",
      "incident_continuation_authority_sha256" => "none",
      "incident_continuation_control_sha" => "none",
      "incident_continuation_journal_identity_sha256" => "none",
      "incident_continuation_generation" => "0",
      "incident_access_cleanup_lineage_json" => "[]",
      "confirmation" => "RESTORE AUTHENTICATED HELD BASELINE EXACT SHA",
    }
  fail("incident restoration policy lost its fixed manifest-bound contract")
end
live_data.select { |operation, _|
  operation.include?("-resume-") || operation == "oci-live-data-continue-held-handoff"
}.each do |operation, policy|
  if policy.fetch("inputTemplates").key?("resume_source_sha") ||
      policy.fetch("inputTemplates").key?("checkpoint_source_sha")
    fail("#{operation} blocks hash-covered ancestor resume inputs")
  end
end

ordinary_activation = live_data.fetch("oci-live-data-resume-activation")
released_activation = live_data.fetch("oci-live-data-resume-activation-released")
unless ordinary_activation.fetch("objectIdOrLiterals") == {
    "failed_activation_user_id" => []
  } && released_activation.fetch("objectIdOrLiterals") == {
    "failed_activation_user_id" => ["0"]
  }
  fail("pre-arm sentinel is not restricted to released activation recovery")
end
ordinary_binding = ordinary_activation.fetch("upstreamRunBindings")
  .find { |binding| binding["input"] == "failed_activation_run_id" }
released_binding = released_activation.fetch("upstreamRunBindings")
  .find { |binding| binding["input"] == "failed_activation_run_id" }
unless ordinary_binding.fetch("runProfile") == "oci-failed-activation-cleanup-v1" &&
    released_binding == ordinary_binding.merge(
      "runProfile" => "oci-failed-activation-released-resume-v1"
    ) && ordinary_binding.fetch("artifactContent").fetch("equals").slice(
      "activation_state", "live_kickoffs_enabled", "live_acceptance_user_id"
    ) == {
      "activation_state" => "dark",
      "live_kickoffs_enabled" => "false",
      "live_acceptance_user_id" => "{input:failed_activation_user_id}"
    }
  fail("released activation profile weakened ordinary cleanup comparisons")
end
policies.reject { |policy| policy["operation"] == released_activation["operation"] }
  .each do |policy|
    if policy.fetch("upstreamRunBindings").any? do |binding|
        binding["runProfile"] == "oci-failed-activation-released-resume-v1"
      end
      fail("released activation reader escaped its fixed operation")
    end
  end

puts "protected_operation_policy=PASS operations=#{policies.length} workflows=#{by_workflow.length}"
RUBY

PYTHONDONTWRITEBYTECODE=1 python3 -I - \
  "$ROOT_DIR/infra/oci/scripts/upstream_run_binding_stan.py" "$policy_file" <<'PY'
import contextlib
import copy
import importlib.util
import io
import json
import sys

spec = importlib.util.spec_from_file_location("binding", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
policies = json.load(open(sys.argv[2], encoding="utf-8"))
for policy in policies:
    for binding in policy["upstreamRunBindings"]:
        m.validate_binding_shape(binding)
binding = next(
    item for policy in policies
    if policy["operation"] == "oci-live-data-resume-activation-released"
    for item in policy["upstreamRunBindings"]
    if item["input"] == "failed_activation_run_id"
)
for key, value in (
    ("input", "failed_deploy_run_id"), ("workflow", "oci-production-deploy.yml"),
    ("runProfile", "unregistered-profile"), ("expectedConclusion", "success"),
    ("expectedHeadShaInput", "approved_sha"),
    ("artifactTemplate", "oci-live-activation-recovery-999-1"),
    ("titleTemplates", {"workflow_dispatch": "different title"}),
):
    candidate = copy.deepcopy(binding)
    candidate[key] = value
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            m.validate_binding_shape(candidate)
        except SystemExit:
            continue
    raise AssertionError(f"substituted released binding passed: {key}")
print("released_activation_policy_shape=PASS negative_cases=7")
PY

if "$POLICY" get not-a-real-operation >"$tmp_dir/unknown.out" 2>&1; then
  echo "unknown operation unexpectedly passed" >&2
  exit 1
fi

echo "copilot_cli_protected_operation_policy_tests=PASS"
