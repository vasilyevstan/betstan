#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/oci-live-data-rollout.yml"
VERIFIER="$ROOT_DIR/infra/oci/scripts/incident_manifest_stan.py"
STATE="$ROOT_DIR/infra/oci/scripts/incident_restore_state_stan.py"
LOCK="$ROOT_DIR/infra/azure/agents/shared-mongo-operation-lock-stan.sh"
MAINTENANCE="$ROOT_DIR/infra/oci/scripts/live-data-maintenance-stan.sh"

ruby - "$WORKFLOW" "$VERIFIER" "$STATE" "$LOCK" "$MAINTENANCE" <<'RUBY'
require "open3"
require "json"
require "yaml"

workflow_path, verifier_path, state_path, lock_path, maintenance_path = ARGV
document = YAML.safe_load(File.read(workflow_path), aliases: true)

def fail_contract(message)
  abort("incident restore workflow contract failed: #{message}")
end

jobs = document.fetch("jobs")
unless jobs.keys == ["rollout"]
  fail_contract("workflow must retain exactly the canonical rollout job")
end
rollout = jobs.fetch("rollout")
unless rollout.fetch("if").to_s == "github.run_attempt == 1"
  fail_contract("canonical rollout job lost its first-attempt guard")
end
if rollout.key?("permissions")
  fail_contract("rollout job overrides workflow permissions")
end
unless rollout.dig("environment", "name") == "oci-migration"
  fail_contract("rollout job lost the protected oci-migration environment")
end

permissions = document.fetch("permissions")
unless permissions == { "actions" => "read", "contents" => "read" }
  fail_contract("workflow permissions are not exact read-only actions/contents")
end

trigger = document["on"] || document[true]
inputs = trigger.dig("workflow_dispatch", "inputs")
phases = %w[dry-run apply-backfills apply-slip-index incident-restore]
unless inputs.dig("phase", "options") == phases
  fail_contract("incident phase is not the bounded fourth choice")
end
{
  "incident_continuation_run_id" => "0",
  "incident_continuation_authority_sha256" => "none",
  "incident_continuation_control_sha" => "none",
  "incident_continuation_journal_identity_sha256" => "none",
  "incident_continuation_generation" => "0",
  "incident_access_cleanup_lineage_json" => "[]",
}.each do |name, neutral|
  definition = inputs[name]
  unless definition.is_a?(Hash) &&
         definition["type"] == "string" &&
         definition["required"] == true &&
         definition["default"] == neutral
    fail_contract("incident continuation input #{name} is not exact")
  end
end

steps = rollout.fetch("steps")
shared_names = [
  "Validate dispatch phase and confirmation routing",
  "Initialize isolated OCI data paths",
  "Checkout approved current master commit",
]
unless steps.first(3).map { |step| step["name"] } == shared_names
  fail_contract("explicit dispatch validation is not the first workflow path")
end
if steps.first(3).any? { |step| step.key?("if") }
  fail_contract("shared validation, setup, and checkout unexpectedly became skippable")
end

route = steps.first.fetch("run")
valid_pairs = [
  ["dry-run", "DRY RUN LIVE DATA EXACT SHA"],
  ["apply-backfills", "APPLY LIVE BACKFILLS EXACT SHA"],
  ["apply-slip-index", "APPLY LIVE SLIP INDEX EXACT SHA"],
  ["apply-slip-index", "CONTINUE SUCCESSFUL HELD LIVE DATA EXACT SHA"],
  ["apply-slip-index", "RESUME APPLIED LIVE DATA EXACT SHA"],
  ["apply-slip-index", "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME EXACT SHA"],
  ["apply-slip-index", "RESUME APPLIED LIVE DATA AND CLEAN FAILED ACTIVATION EXACT SHA"],
  [
    "apply-slip-index",
    "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME AND CLEAN FAILED ACTIVATION EXACT SHA",
  ],
  ["incident-restore", "RESTORE AUTHENTICATED HELD BASELINE EXACT SHA"],
]
route_pairs = route.scan(
  /"((?:dry-run|apply-backfills|apply-slip-index|incident-restore)\|[^"]+)"(?=\s*(?:\||\)))/
).flatten.sort
unless route_pairs == valid_pairs.map { |phase, phrase| "#{phase}|#{phrase}" }.sort
  fail_contract("phase/confirmation allowlist differs from the reviewed cross-product")
end
unless route.include?('*)') &&
       route.include?("Invalid live-data phase/confirmation pair") &&
       route.match?(/exit 1/)
  fail_contract("invalid phase/confirmation pairs lack an explicit failing path")
end
confirmations = valid_pairs.map(&:last).uniq
phases.product(confirmations).each do |phase, confirmation|
  _stdout, _stderr, status = Open3.capture3(
    {
      "PHASE" => phase,
      "CONFIRMATION" => confirmation,
      "INCIDENT_CONTINUATION_RUN_ID" => "0",
      "INCIDENT_CONTINUATION_AUTHORITY_SHA256" => "none",
      "INCIDENT_CONTINUATION_CONTROL_SHA" => "none",
      "INCIDENT_CONTINUATION_JOURNAL_IDENTITY_SHA256" => "none",
      "INCIDENT_CONTINUATION_GENERATION" => "0",
      "INCIDENT_ACCESS_CLEANUP_LINEAGE_JSON" => "[]",
    },
    "bash", "-euo", "pipefail", "-c", route,
  )
  expected = valid_pairs.include?([phase, confirmation])
  unless status.success? == expected
    fail_contract("phase/confirmation cross-product routed incorrectly: #{phase}")
  end
end
continuation_environment = {
  "PHASE" => "incident-restore",
  "CONFIRMATION" => "RESTORE AUTHENTICATED HELD BASELINE EXACT SHA",
  "INCIDENT_CONTINUATION_RUN_ID" => "5001",
  "INCIDENT_CONTINUATION_AUTHORITY_SHA256" => "a" * 64,
  "INCIDENT_CONTINUATION_CONTROL_SHA" => "b" * 40,
  "INCIDENT_CONTINUATION_JOURNAL_IDENTITY_SHA256" => "c" * 64,
  "INCIDENT_CONTINUATION_GENERATION" => "1",
  "INCIDENT_ACCESS_CLEANUP_LINEAGE_JSON" => JSON.generate(
    [
      {
        "authorityGeneration" => 0,
        "authoritySha256" => "a" * 64,
        "controlSha" => "b" * 40,
        "runId" => 5001,
      },
    ],
  ),
}
_stdout, _stderr, status = Open3.capture3(
  continuation_environment,
  "bash", "-euo", "pipefail", "-c", route,
)
fail_contract("valid incident continuation inputs were rejected") unless status.success?
partial = continuation_environment.merge(
  "INCIDENT_CONTINUATION_AUTHORITY_SHA256" => "none",
)
_stdout, _stderr, status = Open3.capture3(
  partial,
  "bash", "-euo", "pipefail", "-c", route,
)
fail_contract("partial incident continuation inputs were accepted") if status.success?
ordinary_continuation = continuation_environment.merge(
  "PHASE" => "dry-run",
  "CONFIRMATION" => "DRY RUN LIVE DATA EXACT SHA",
)
_stdout, _stderr, status = Open3.capture3(
  ordinary_continuation,
  "bash", "-euo", "pipefail", "-c", route,
)
fail_contract("ordinary phase accepted incident continuation inputs") if status.success?

incident_start = steps.index do |step|
  step["name"] == "Verify fixed incident manifest and immutable evidence"
end
fail_contract("incident path is missing") unless incident_start
steps[3...incident_start].each do |step|
  unless step.fetch("if", "").to_s.include?("inputs.phase != 'incident-restore'")
    fail_contract("ordinary step does not exclude incident mode: #{step["name"]}")
  end
end
steps[incident_start..].each do |step|
  unless step.fetch("if", "").to_s.include?("inputs.phase == 'incident-restore'")
    fail_contract("incident step can execute outside incident mode: #{step["name"]}")
  end
end

names = steps.map { |step| step["name"] }.compact
ordinary_names = [
  "Validate exact SHA phase and trusted upstream runs",
  "Acquire database operation lock",
  "Execute exact-digest live data phase",
  "Upload exact sanitized data evidence",
  "Release database operation lock unless handed to deploy",
]
ordinary_names.each do |name|
  fail_contract("existing rollout path lost #{name}") unless names.include?(name)
end
ordinary_validation = steps.find do |step|
  step["name"] == "Validate exact SHA phase and trusted upstream runs"
end.fetch("run").to_s
unless ordinary_validation.include?('ordinary_dispatch_inputs="$(') &&
       ordinary_validation.include?(
         '--dispatch-inputs "$ordinary_dispatch_inputs"'
       ) &&
       %w[
         incident_continuation_run_id
         incident_continuation_authority_sha256
         incident_continuation_control_sha
         incident_continuation_journal_identity_sha256
         incident_continuation_generation
         incident_access_cleanup_lineage_json
       ].all? { |name| ordinary_validation.include?(".#{name}") }
  fail_contract("ordinary validator did not remove exact neutral incident inputs")
end
ordinary_text = steps[3...incident_start].map { |step| step["run"].to_s }.join("\n")
unless ordinary_text.include?('resume_native_dispatch_inputs="$(') &&
       ordinary_text.include?('RESUME_NATIVE_DISPATCH_INPUTS="$resume_native_dispatch_inputs"')
  fail_contract("ordinary resume validator retained incident-only inputs")
end

classification_step = steps.find do |step|
  step["name"] == "Classify exact incident continuation state"
end
classification_run = classification_step.fetch("run").to_s
preimage_filter_match = classification_run.match(
  /jq -er '\n(?<filter>.*?)\n\s*' "\$RUNNER_TEMP\/incident-live-lock\.json" >>"\$GITHUB_OUTPUT"/m
)
unless preimage_filter_match
  fail_contract("incident lock preimage jq filter is missing")
end
preimage_fixture = {
  "metadata" => {
    "uid" => "lock-uid",
    "resourceVersion" => "17",
  },
  "data" => {
    "holder" => "restore-owner",
    "operation-id" => "live-data-incident-restore",
    "source-sha" => "a" * 40,
    "acquired-at-epoch" => "100",
    "lease-duration-seconds" => "600",
    "lease-until-epoch" => "700",
    "released-at-epoch" => "0",
    "fencing-generation" => "519",
    "incident-manifest-sha256" => "b" * 64,
    "incident-owner-run-id" => "5001",
    "incident-restore-run-id" => "5002",
    "incident-control-sha" => "c" * 40,
    "incident-current-run-metadata-sha256" => "d" * 64,
    "incident-request-created-at-epoch" => "80",
    "incident-provider-transition-epoch" => "90",
    "incident-predecessor-lease-until-epoch" => "95",
    "incident-new-lease-until-epoch" => "700",
  },
}
preimage_output, preimage_error, preimage_status = Open3.capture3(
  "jq",
  "-er",
  preimage_filter_match[:filter],
  stdin_data: JSON.generate(preimage_fixture),
)
unless preimage_status.success?
  fail_contract("incident lock preimage jq filter does not compile: #{preimage_error}")
end
unless preimage_output.lines.map(&:chomp).include?(
  "preimage_operation=live-data-incident-restore"
)
  fail_contract("incident lock preimage jq filter lost operation output")
end

ordered = [
  "Verify fixed incident manifest and immutable evidence",
  "Reject competing incident production activity",
  "Verify fixed infrastructure checkpoint",
  "Reconcile bounded incident access-cleanup lineage",
  "Capture exact current incident access identity",
  "Authenticate incident journal control handoff",
  "Classify exact incident continuation state",
  "Adopt authenticated active incident successor",
  "Persist current incident access identity",
  "Reconstruct authenticated incident baseline state",
  "Verify original held fence writers and images",
  "Replace exact expired held lock",
  "Reconcile incident writers under exact lock and fence",
  "Restore authenticated baseline while retaining fence",
  "Release incident lock before fence",
  "Persist recovered released-lock transition",
  "Capture persisted incident lock postimages",
  "Reconcile published incident access resources",
  "Release fence after lock",
  "Persist recovered unfenced transition",
  "Capture restored readiness and public availability",
  "Seal non-deployable incident evidence",
  "Re-quiesce incident writers after restoration failure",
  "Seal checksummed incident failure evidence",
  "Upload bounded incident restoration evidence",
  "Mark incident evidence publication complete",
]
positions = ordered.map do |name|
  matches = steps.each_index.select { |index| steps[index]["name"] == name }
  matches = matches.select { |index| index >= incident_start }
  fail_contract("missing or duplicated incident step #{name}") unless matches.length == 1
  matches.first
end
unless positions == positions.sort
  fail_contract("incident safety and continuation steps changed order")
end

incident_steps = steps[incident_start..]
incident_text = incident_steps.to_s
unless incident_text.include?('([A-Za-z][A-Za-z0-9_]*)=')
  fail_contract("incident infrastructure provenance rejects uppercase keys")
end
access_cleanup = incident_steps.find do |step|
  step["name"] == "Reconcile bounded incident access-cleanup lineage"
end.fetch("run").to_s
unless access_cleanup.include?(
  "mkdir -p artifacts/oci-live-data-incident-restore"
)
  fail_contract("incident access cleanup does not create its artifact directory")
end
for forbidden in [
  "upstream_run_binding_stan.py",
  "/actions/runs?",
  "--paginate",
  "/jobs",
  "gh run list",
  "actions/download-artifact",
  "docker build",
  "build-push-action",
  "kubectl exec",
  "apply-live",
  "backfill-stan",
]
  if incident_text.include?(forbidden)
    fail_contract("incident path contains forbidden history/build/data path #{forbidden}")
  end
end
for required in [
  "incident_manifest_stan.py",
  "incident_access_stan.py",
  "incident_restore_state_stan.py",
  "verify-control-handoff",
  "INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA",
  "INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE",
  "INCIDENT_ACCESS_RECORD_FILE",
  "cleanup-lineage",
  "cleanup-published",
  "record-access",
  "access-records",
  "successor_control_sha",
  "adopted-control-handoff.json",
  "access-lineage-cleanup.json",
  "access-cleanup-lineage.json",
  "access-published-cleanup.json",
  "artifacts/incident-authenticated/infrastructure/provenance.env",
  "provider-transition-time",
  "provider-transition.json",
  "REQUEST_CREATED_AT_EPOCH",
  "PROVIDER_TRANSITION_EPOCH",
  "REQUEST_CURRENT_RUN_METADATA_SHA256",
  "replace-expired-active",
  "RESTORE_KEEP_FENCE",
  "reconstruct-baseline",
  "verify-baseline-images",
  "reconcile-incident-writers",
  "live-betting-readiness-stan.sh",
  "record-active",
  "adopt-active",
  "record-released",
  "record-unfenced",
  "record-readiness",
  "record-sealed",
  "record-published",
  "incident-active-fenced",
  "incident-active-successor-fenced",
  "released-fenced-recovery",
  "released-unfenced-recovery",
  "released-unfenced-pending-publication",
  "active-lock-postimage.json",
  "released-lock-postimage.json",
  "incident-state-postimage.json",
  "failure-live-lock.json",
  "failure-incident-state.json",
  "Seal already-published incident continuation evidence",
  "outcome=already-published",
  "steps.incident_state.outputs.classification != 'published'",
  "readiness-SHA256SUMS",
  "payload-SHA256SUMS",
  "SHA256SUMS",
  "oci-live-data-incident-restore-${{ github.run_id }}-${{ github.run_attempt }}",
  "deployable=false",
]
  fail_contract("incident path lost #{required}") unless incident_text.include?(required)
end
if incident_text.include?("The bounded incident restoration is already published")
  fail_contract("published continuation still fails instead of finishing cleanup")
end
for forbidden_permission in ["packages", "id-token", "contents: write", "actions: write"]
  if incident_text.include?(forbidden_permission)
    fail_contract("incident path gained #{forbidden_permission} permission")
  end
end

replace_step = steps.find { |step| step["name"] == "Replace exact expired held lock" }
replace_guard = replace_step.fetch("if").to_s
unless replace_guard.include?("takeover_required == 'true'") &&
       !replace_guard.include?("released-fenced") &&
       !replace_guard.include?("released-unfenced")
  fail_contract("continuation can replay the strict takeover CAS")
end
held_outputs = {
  "HELD_LOCK_UID" => "uid",
  "HELD_RESOURCE_VERSION" => "resource_version",
  "HELD_LOCK_HOLDER" => "holder",
  "HELD_LOCK_OPERATION_ID" => "operation",
  "HELD_LOCK_SOURCE_SHA" => "source_sha",
  "HELD_ACQUIRED_AT_EPOCH" => "acquired_at",
  "HELD_LEASE_DURATION_SECONDS" => "lease_duration",
  "HELD_LEASE_UNTIL_EPOCH" => "lease_until",
  "HELD_RELEASED_AT_EPOCH" => "released_at",
  "HELD_FENCING_GENERATION" => "generation",
}
{
  "Adopt authenticated active incident successor" => [
    "incident_manifest",
    "lock",
  ],
  "Replace exact expired held lock" => [
    "incident_state",
    "preimage",
  ],
}.each do |step_name, (step_id, output_prefix)|
  step = steps.find { |candidate| candidate["name"] == step_name }
  fail_contract("incident path lost #{step_name}") unless step
  expected = held_outputs.to_h do |env_name, suffix|
    [
      env_name,
      "${{ steps.#{step_id}.outputs.#{output_prefix}_#{suffix} }}",
    ]
  end
  actual = step.fetch("env", {}).select do |env_name, _|
    env_name.start_with?("HELD_")
  end
  unless actual == expected
    fail_contract("#{step_name} lost exact held-lock environment")
  end
end
release_position = names.index("Release incident lock before fence")
fence_position = names.index("Release fence after lock")
unless release_position && fence_position && release_position < fence_position
  fail_contract("incident lock is not released before the fence")
end

incident_position = lambda do |name|
  steps.each_index.find do |index|
    index >= incident_start && steps[index]["name"] == name
  end
end
predecessor_cleanup_position = incident_position.call(
  "Reconcile bounded incident access-cleanup lineage"
)
oke_access_position = incident_position.call(
  "Reconcile expired and authorize incident runner IPv4"
)
k3s_access_position = incident_position.call(
  "Open ephemeral incident OCI Bastion access to k3s"
)
capture_access_position = incident_position.call(
  "Capture exact current incident access identity"
)
authenticate_position = incident_position.call(
  "Authenticate incident journal control handoff"
)
unless predecessor_cleanup_position &&
       oke_access_position &&
       k3s_access_position &&
       capture_access_position &&
       authenticate_position &&
       predecessor_cleanup_position < oke_access_position &&
       predecessor_cleanup_position < k3s_access_position &&
       capture_access_position > oke_access_position &&
       capture_access_position > k3s_access_position &&
       capture_access_position < authenticate_position
  fail_contract("incident access ownership is not reconciled before replacement")
end

published_cleanup_position = incident_position.call(
  "Reconcile published incident access resources"
)
published_seal_position = incident_position.call(
  "Seal already-published incident continuation evidence"
)
unless published_cleanup_position &&
       published_seal_position &&
       published_cleanup_position < published_seal_position
  fail_contract("published continuation can seal before exact access cleanup")
end

reconstruct_step = steps.find do |step|
  step["name"] == "Reconstruct authenticated incident baseline state"
end
unless reconstruct_step.fetch("if").to_s.include?(
  "classification != 'published'"
)
  fail_contract("published continuation can replay baseline reconstruction")
end
published_cleanup_step = steps.fetch(published_cleanup_position)
unless published_cleanup_step.fetch("if").to_s.include?(
  "classification == 'published'"
) &&
       published_cleanup_step.fetch("run").to_s.include?(
         "Current incident access cleanup state is missing"
       )
  fail_contract("published cleanup is not exact and fail-closed")
end
no_replay_guards = {
  "Restore authenticated baseline while retaining fence" =>
    "steps.incident_lock.outcome == 'success'",
  "Capture restored readiness and public availability" =>
    "steps.incident_fence_release.outcome == 'success'",
  "Seal non-deployable incident evidence" =>
    "steps.incident_readiness.outcome == 'success'",
  "Mark incident evidence publication complete" =>
    "steps.incident_seal.outcome == 'success'",
}
no_replay_guards.each do |name, dependency|
  step = steps.find { |candidate| candidate["name"] == name }
  condition = step.fetch("if").to_s
  unless condition.include?(dependency) &&
         !condition.include?("classification == 'published'")
    fail_contract("published continuation can replay #{name}")
  end
end
for cleanup_name in [
  "Revoke exact incident runner rule",
  "Close ephemeral incident OCI Bastion access",
]
  cleanup_position = incident_position.call(cleanup_name)
  fail_contract("missing incident cleanup #{cleanup_name}") unless
    cleanup_position
  cleanup_step = steps.fetch(cleanup_position)
  unless cleanup_step.fetch("if").to_s.include?(
    "classification != 'published'"
  )
    fail_contract(
      "published continuation can run duplicate cleanup: #{cleanup_name}"
    )
  end
end

readiness_step = steps.find do |step|
  step["name"] == "Capture restored readiness and public availability"
end
readiness_text = readiness_step.to_s
for required in [
  "live-betting-readiness-stan.sh",
  "EXPECTED_LIVE_KICKOFFS_ENABLED",
  "IMAGE_PROVENANCE_FILE",
  "SECONDARY_PUBLIC_URL",
  "DIAGNOSTIC_URL",
]
  fail_contract("success readiness lost #{required}") unless
    readiness_text.include?(required)
end

upload_step = steps.find do |step|
  step["name"] == "Upload bounded incident restoration evidence"
end
unless upload_step["uses"]&.start_with?("actions/upload-artifact@") &&
       upload_step.dig("with", "if-no-files-found") == "error" &&
       upload_step.dig("with", "retention-days") == 30
  fail_contract("incident evidence upload is not exact and bounded")
end

verifier = File.read(verifier_path)
for forbidden in [
  "actions/runs?",
  "--paginate",
  "/jobs",
  "workflow_runs",
  "run list",
]
  if verifier.include?(forbidden)
    fail_contract("manifest verifier contains forbidden endpoint/history path #{forbidden}")
  end
end
unless verifier.include?("MAX_API_REQUESTS = 24") &&
       verifier.include?("actions/runs/{run_id}") &&
       verifier.include?("actions/runs/{run_id}/attempts/{attempt}") &&
       verifier.include?("Cache-Control: no-cache") &&
       verifier.include?("actions/artifacts/{artifact_id}")
  fail_contract("manifest verifier lost its exact endpoint/request bound")
end

state = File.read(state_path)
for required in [
  "incident-active-fenced",
  "released-fenced",
  "released-unfenced-pending-publication",
  "readiness-captured",
  "sealed-pending-publication",
  "published",
  "applied-after-reread",
  "no retry is permitted",
]
  fail_contract("incident continuation state lost #{required}") unless
    state.include?(required)
end

lock = File.read(lock_path)
unless lock.include?("replace-expired-active") &&
       lock.include?("result=applied-after-reread") &&
       lock.include?("REQUEST_CREATED_AT_EPOCH") &&
       lock.include?("PROVIDER_TRANSITION_EPOCH") &&
       lock.include?("REQUEST_CURRENT_RUN_METADATA_SHA256") &&
       lock.include?("no retry is permitted")
  fail_contract("strict expired-active replacement contract is incomplete")
end
replace_step = steps.find do |step|
  step["name"] == "Replace exact expired held lock"
end.fetch("run").to_s
provider_index = replace_step.index("provider-transition-time")
cas_index = replace_step.index("replace-expired-active")
unless provider_index && cas_index && provider_index < cas_index
  fail_contract("provider transition time is not captured immediately before CAS")
end
replace_case = lock[
  lock.index("  replace-expired-active)")...
  lock.index("  acquire-released)")
]
if replace_case.include?("current_epoch") || replace_case.include?("date -u")
  fail_contract("incident replacement still depends on runner wall clock")
end

maintenance = File.read(maintenance_path)
for required in [
  "reconstruct-baseline",
  "RESTORE_KEEP_FENCE",
  "verify-baseline-images",
  "reconcile-incident-writers",
  "capture-readiness",
]
  fail_contract("maintenance contract lost #{required}") unless
    maintenance.include?(required)
end

puts "incident_restore_workflow_contract=PASS"
RUBY
