# frozen_string_literal: true

require "yaml"

directory = ARGV.fetch(0)

AZURE_WORKFLOWS = %w[
  production-build
  production-deploy
  production-rollback
].freeze
OCI_WORKFLOWS = %w[
  oci-capacity-acquire
  oci-infrastructure
  oci-live-betting-activate
  oci-live-betting-disable
  oci-live-data-rollout
  oci-migrate
  oci-migration-recovery
  ghcr-package-management
  oci-ghcr-cache-recovery
  oci-production-build
  oci-production-deploy
  oci-production-rollback
].freeze
REQUIRED_SET = (AZURE_WORKFLOWS + OCI_WORKFLOWS).sort.freeze
PROTECTED_ENVIRONMENTS = {
  "production-rollback" => "production-emergency",
  "oci-capacity-acquire" => "oci-capacity-acquire",
  "oci-infrastructure" => "oci-infrastructure",
  "oci-live-betting-activate" => "oci-production",
  "oci-live-betting-disable" => "oci-production",
  "oci-live-data-rollout" => "oci-migration",
  "oci-migrate" => "oci-migration",
  "oci-migration-recovery" => "azure-migration-recovery",
  "ghcr-package-management" => "oci-infrastructure",
  "oci-ghcr-cache-recovery" => "oci-production",
  "oci-production-build" => "oci-build",
  "oci-production-deploy" => "oci-production",
  "oci-production-rollback" => "oci-production"
}.freeze
ROLLBACK_ACTION_PINS = {
  "production-rollback" => {
    "actions/checkout" => "11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/upload-artifact" => "ea165f8d65b6e75b540449e92b4886f43607fa02",
    "azure/login" => "a457da9ea143d694b1b9c7c869ebb04ebe844ef5",
    "azure/aks-set-context" => "c7eb093e5a5d47caa333f64974d5fd1cd4bf069d"
  },
  "oci-production-rollback" => {
    "actions/checkout" => "11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/download-artifact" => "d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact" => "ea165f8d65b6e75b540449e92b4886f43607fa02",
    "oracle-actions/configure-kubectl-oke" => "77a733d79446dabe7bf0e58eb56197d33ce4dc58"
  },
  "oci-live-data-rollout" => {
    "actions/checkout" => "11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/download-artifact" => "d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact" => "ea165f8d65b6e75b540449e92b4886f43607fa02",
    "oracle-actions/configure-kubectl-oke" => "77a733d79446dabe7bf0e58eb56197d33ce4dc58"
  },
  "oci-live-betting-activate" => {
    "actions/checkout" => "11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/download-artifact" => "d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/setup-node" => "49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/upload-artifact" => "ea165f8d65b6e75b540449e92b4886f43607fa02",
    "oracle-actions/configure-kubectl-oke" => "77a733d79446dabe7bf0e58eb56197d33ce4dc58"
  },
  "oci-live-betting-disable" => {
    "actions/checkout" => "11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/download-artifact" => "d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact" => "ea165f8d65b6e75b540449e92b4886f43607fa02",
    "oracle-actions/configure-kubectl-oke" => "77a733d79446dabe7bf0e58eb56197d33ce4dc58"
  }
}.freeze
FULL_SHA = /\A[0-9a-f]{40}\z/
AZURE_SECRET_NAME = /\A(?:AZURE[A-Z0-9_]*|ARM[A-Z0-9_]*|ACR[A-Z0-9_]*|
  RESOURCE_GROUP|CLUSTER_NAME)\z/ix
AZURE_DOT_SECRET_REFERENCE = %r{
  \bsecrets\s*\.\s*(?:AZURE[A-Z0-9_]*|ARM[A-Z0-9_]*|ACR[A-Z0-9_]*|
    RESOURCE_GROUP|CLUSTER_NAME)\b
}ix

def fail_inventory(message)
  warn "production workflow inventory rejected: #{message}"
  exit 1
end

def workflow_triggers(document)
  triggers = document["on"] || document[true] || {}
  triggers.is_a?(Hash) ? triggers : {}
end

def workflow_dispatch_inputs(document)
  dispatch = workflow_triggers(document)["workflow_dispatch"]
  inputs = dispatch.is_a?(Hash) ? dispatch["inputs"] : nil
  inputs.is_a?(Hash) ? inputs : {}
end

def require_content(content, pattern, message)
  fail_inventory(message) unless content.match?(pattern)
end

def reject_content(content, pattern, message)
  fail_inventory(message) if content.match?(pattern)
end

def validate_dispatch_only_workflow!(name, document)
  triggers = workflow_triggers(document)
  fail_inventory("#{name} must be workflow_dispatch-only") unless triggers.keys == ["workflow_dispatch"]
end

def validate_required_workflow_dispatch_inputs!(name, document, expected_inputs)
  inputs = workflow_dispatch_inputs(document)
  unless inputs.keys.sort == expected_inputs.sort
    fail_inventory(
      "#{name} must expose exactly these workflow_dispatch inputs: #{expected_inputs.join(",")}"
    )
  end

  expected_inputs.each do |input_name|
    config = inputs[input_name]
    unless config.is_a?(Hash) && config["required"] == true
      fail_inventory("#{name} must require the #{input_name} dispatch input")
    end
  end
end

def validate_exact_permissions!(name, document, expected_permissions)
  permissions = document["permissions"]
  unless permissions.is_a?(Hash) && permissions == expected_permissions
    fail_inventory(
      "#{name} must set exact permissions " \
      "#{expected_permissions.map { |key, value| "#{key}=#{value}" }.join(",")}"
    )
  end
end

def uses_entries(content)
  entries = []
  content.each_line.with_index(1) do |line, line_number|
    match = line.match(/^\s*uses:\s*([^\s#]+)/)
    next unless match

    entries << [line_number, match[1]]
  end
  entries
end

def validate_expected_action_pins!(name, content)
  expected = ROLLBACK_ACTION_PINS.fetch(name)
  seen = {}

  uses_entries(content).each do |line_number, use|
    match = /\A(?<repository>[^@\s]+)@(?<ref>[^\s]+)\z/.match(use)
    unless match
      fail_inventory("#{name} line #{line_number} must pin actions to a reviewed full SHA")
    end

    repository = match[:repository]
    ref = match[:ref]
    expected_ref = expected[repository]
    unless expected_ref
      fail_inventory("#{name} line #{line_number} references an unexpected action #{repository}")
    end
    unless FULL_SHA.match?(ref)
      fail_inventory(
        "#{name} line #{line_number} must pin #{repository} to a full 40-character lowercase hex commit SHA"
      )
    end
    unless ref == expected_ref
      fail_inventory(
        "#{name} line #{line_number} must pin #{repository} to #{expected_ref}"
      )
    end

    seen[repository] = true
  end

  missing = expected.keys.reject { |repository| seen[repository] }
  return if missing.empty?

  fail_inventory("#{name} is missing reviewed pinned actions: #{missing.join(",")}")
end

def validate_environment!(name, document)
  jobs = document["jobs"]
  fail_inventory("#{name} must define jobs") unless jobs.is_a?(Hash) && !jobs.empty?
  expected_environment = PROTECTED_ENVIRONMENTS.fetch(name)

  jobs.each do |job_name, job|
    if job.is_a?(Hash) && job.key?("uses")
      fail_inventory(
        "#{name} job #{job_name} must not call a reusable workflow"
      )
    end
    environment = job.is_a?(Hash) ? job["environment"] : nil
    environment_name =
      environment.is_a?(Hash) ? environment["name"] : environment
    next if environment_name == expected_environment

    fail_inventory(
      "#{name} job #{job_name} must use reviewer-gated #{expected_environment}"
    )
  end
end

def validate_non_migration_secrets!(name, content)
  reject_content(
    content,
    AZURE_DOT_SECRET_REFERENCE,
    "#{name} must not receive Azure credentials"
  )

  content.scan(/\bsecrets\s*\[([^\]]+)\]/i).each do |match|
    expression = match.fetch(0).strip
    literal = /\A(['"])([A-Z0-9_]+)\1\z/i.match(expression)
    unless literal
      fail_inventory("#{name} must not use dynamic secret contexts")
    end
    if AZURE_SECRET_NAME.match?(literal[2])
      fail_inventory("#{name} must not receive Azure credentials")
    end
  end
end

def validate_azure_rollback_workflow!(file, document, content)
  name = "production-rollback"
  unless File.basename(file) == "#{name}.yml"
    fail_inventory("#{name} must use .github/workflows/#{name}.yml")
  end

  validate_dispatch_only_workflow!(name, document)
  validate_required_workflow_dispatch_inputs!(
    name,
    document,
    %w[
      target_sha
      baseline_source_run_id
      baseline_source_run_attempt
      baseline_artifact_name
      confirmation
    ]
  )
  validate_exact_permissions!(name, document, { "actions" => "read", "contents" => "read" })
  validate_environment!(name, document)
  validate_expected_action_pins!(name, content)

  require_content(
    content,
    %r{run-name:\s*rollback\s+\$\{\{\s*inputs\.target_sha\s*\}\}},
    "#{name} run name must identify the rollback target SHA"
  )
  require_content(
    content,
    /github\.run_attempt\s*==\s*1/,
    "#{name} must reject rerun attempts"
  )
  require_content(
    content,
    /\[\s*"\$GITHUB_REF_NAME"\s*=\s*"master"\s*\]/,
    "#{name} must reject non-master dispatches"
  )
  require_content(
    content,
    /CONFIRMATION:\s*\$\{\{\s*inputs\.confirmation\s*\}\}/,
    "#{name} must bind the production rollback confirmation through the environment"
  )
  require_content(
    content,
    /\[\s*"\$CONFIRMATION"\s*=\s*"ROLLBACK PRODUCTION EXACT DIGEST"\s*\]/,
    "#{name} must require the exact production rollback confirmation phrase"
  )
  reject_content(
    content,
    /\[\s*"\$\{\{\s*inputs\.confirmation\s*\}\}"/,
    "#{name} must not interpolate the rollback confirmation in shell code"
  )
  require_content(
    content,
    /\[\[\s*"\$TARGET_SHA"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]/,
    "#{name} must validate a complete lowercase target SHA"
  )
  require_content(
    content,
    /\[\[\s*"\$BASELINE_SOURCE_RUN_ID"\s*=~\s*\^\[1-9\]\[0-9\]\*\$\s*\]\]/,
    "#{name} must validate a numeric baseline source run ID"
  )
  require_content(
    content,
    /\[\s*"\$BASELINE_SOURCE_RUN_ATTEMPT"\s*=\s*"1"\s*\]/,
    "#{name} must bind rollback provenance to the first deploy attempt"
  )
  require_content(
    content,
    /\[\s*"\$BASELINE_ARTIFACT_NAME"\s*=\s*"production-baseline-\$\{BASELINE_SOURCE_RUN_ID\}-\$\{BASELINE_SOURCE_RUN_ATTEMPT\}"\s*\]/,
    "#{name} must bind rollback provenance to the exact baseline artifact"
  )
  require_content(
    content,
    /\[\s*"\$GITHUB_RUN_ATTEMPT"\s*=\s*"1"\s*\]/,
    "#{name} must reject rerun attempts inside the validation step"
  )
  require_content(
    content,
    %r{git fetch --quiet origin master:refs/remotes/origin/master},
    "#{name} must resolve current master before rollback"
  )
  require_content(
    content,
    /\[\s*"\$TARGET_SHA"\s*!=\s*"\$current_master"\s*\]/,
    "#{name} must reject rollbacks to the current master commit"
  )
  require_content(
    content,
    /git merge-base --is-ancestor "\$TARGET_SHA" "\$current_master"/,
    "#{name} must require the rollback target to remain on master history"
  )
  require_content(
    content,
    /shared-mongo-operation-lock-stan\.sh acquire/,
    "#{name} must acquire the reviewed rollback operation lock"
  )
  require_content(
    content,
    /shared-mongo-operation-lock-stan\.sh release/,
    "#{name} must always release the reviewed rollback operation lock"
  )
  require_content(
    content,
    /rollback-application-stan\.sh/,
    "#{name} must call the reviewed rollback executor"
  )
  require_content(
    content,
    /production-rollback-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/,
    "#{name} must upload attempt-bound rollback diagnostics"
  )
end

def validate_oci_rollback_workflow!(file, document, content)
  name = "oci-production-rollback"
  unless File.basename(file) == "#{name}.yml"
    fail_inventory("#{name} must use .github/workflows/#{name}.yml")
  end

  validate_dispatch_only_workflow!(name, document)
  validate_required_workflow_dispatch_inputs!(
    name,
    document,
    %w[
      target_sha
      baseline_source_run_id
      baseline_source_run_attempt
      baseline_artifact_name
      infrastructure_run_id
      allow_legacy_admin_auth
      legacy_admin_auth_reason
      confirmation
    ]
  )
  validate_exact_permissions!(name, document, { "actions" => "read", "contents" => "read" })
  validate_environment!(name, document)
  validate_expected_action_pins!(name, content)

  require_content(
    content,
    %r{run-name:\s*oci-rollback\s+\$\{\{\s*inputs\.target_sha\s*\}\}},
    "#{name} run name must identify the rollback target SHA"
  )
  require_content(
    content,
    /group:\s*oci-control-plane/,
    "#{name} must use the shared reviewed OCI control-plane concurrency group"
  )
  require_content(
    content,
    /cancel-in-progress:\s*false/,
    "#{name} must keep reviewed rollback concurrency non-cancelling"
  )
  require_content(
    content,
    /github\.run_attempt\s*==\s*1/,
    "#{name} must reject rerun attempts"
  )
  require_content(
    content,
    /\[\s*"\$GITHUB_REF_NAME"\s*=\s*"master"\s*\]/,
    "#{name} must reject non-master dispatches"
  )
  require_content(
    content,
    /\[\s*"\$CONFIRMATION"\s*=\s*"ROLLBACK OCI EXACT DIGEST"\s*\]/,
    "#{name} must require the exact OCI rollback confirmation phrase"
  )
  require_content(
    content,
    /\[\[\s*"\$TARGET_SHA"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]/,
    "#{name} must validate a complete lowercase target SHA"
  )
  require_content(
    content,
    /\[\[\s*"\$BASELINE_SOURCE_RUN_ID"\s*=~\s*\^\[1-9\]\[0-9\]\*\$\s*\]\]/,
    "#{name} must validate a numeric baseline source run ID"
  )
  require_content(
    content,
    /\[\s*"\$BASELINE_SOURCE_RUN_ATTEMPT"\s*=\s*"1"\s*\]/,
    "#{name} must bind rollback provenance to the first deploy attempt"
  )
  require_content(
    content,
    /\[\s*"\$BASELINE_ARTIFACT_NAME"\s*=\s*"oci-production-baseline-\$\{BASELINE_SOURCE_RUN_ID\}-\$\{BASELINE_SOURCE_RUN_ATTEMPT\}"\s*\]/,
    "#{name} must bind rollback provenance to the exact baseline artifact"
  )
  require_content(
    content,
    /\[\[\s*"\$INFRASTRUCTURE_RUN_ID"\s*=~\s*\^\[1-9\]\[0-9\]\*\$\s*\]\]/,
    "#{name} must validate a numeric infrastructure run ID"
  )
  require_content(
    content,
    %r{git fetch --quiet origin master:refs/remotes/origin/master},
    "#{name} must resolve current master before rollback"
  )
  require_content(
    content,
    /gh api "repos\/\$REPOSITORY\/actions\/workflows\/oci-infrastructure\.yml"/,
    "#{name} must resolve the reviewed OCI infrastructure workflow identity"
  )
  require_content(
    content,
    %r{actions/runs/\$INFRASTRUCTURE_RUN_ID/attempts/1},
    "#{name} must inspect the immutable first-attempt infrastructure provenance"
  )
  require_content(
    content,
    /\[\s*"\$workflow_path"\s*=\s*"\.github\/workflows\/oci-infrastructure\.yml"\s*\]/,
    "#{name} must bind rollback provenance to the reviewed infrastructure workflow path"
  )
  require_content(
    content,
    /\[\s*"\$event"\s*=\s*"workflow_dispatch"\s*\]/,
    "#{name} must trust only manually approved infrastructure runs"
  )
  require_content(
    content,
    /\[\s*"\$head_branch"\s*=\s*"master"\s*\]/,
    "#{name} must reject infrastructure provenance from non-master branches"
  )
  require_content(
    content,
    /\[\s*"\$repository"\s*=\s*"\$REPOSITORY"\s*\]/,
    "#{name} must reject infrastructure provenance from another repository"
  )
  require_content(
    content,
    /\[\s*"\$status"\s*=\s*"completed"\s*\]\s*&&\s*\[\s*"\$conclusion"\s*=\s*"success"\s*\]\s*&&\s*\[\s*"\$attempt"\s*=\s*"1"\s*\]/,
    "#{name} must require successful first-attempt infrastructure provenance"
  )
  require_content(
    content,
    /oci-infrastructure-provenance-\$\{\{\s*inputs\.infrastructure_run_id\s*\}\}-1/,
    "#{name} must download the exact reviewed infrastructure provenance artifact"
  )
  require_content(
    content,
    /run-id:\s*\$\{\{\s*inputs\.infrastructure_run_id\s*\}\}/,
    "#{name} must bind the infrastructure provenance artifact to the reviewed run ID"
  )
  require_content(
    content,
    /OCI_INFRASTRUCTURE_PROVENANCE_FILE:\s*artifacts\/infrastructure\/provenance\.env/,
    "#{name} must pass the downloaded infrastructure provenance to the rollback operator"
  )
  require_content(
    content,
    /oci-production-rollback-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/,
    "#{name} must upload attempt-bound rollback diagnostics"
  )
  require_content(
    content,
    /capability=legacy-admin-auth-accepted/,
    "#{name} must record an explicit legacy admin-auth rollback capability"
  )
  require_content(
    content,
    /ADMIN_AUTH_CAPABILITY_FILE:\s*artifacts\/admin-auth-capability\.env/,
    "#{name} must bind any legacy admin-auth override to the rollback operator"
  )
  runner_rule_state = %r{
    RULE_STATE_FILE:\s*
    \$\{\{\s*runner\.temp\s*\}\}/betstan-rollback-control/runner-rule\.env
  }x
  unless content.scan(runner_rule_state).length == 2
    fail_inventory(
      "#{name} must preserve the runner-rule state until its always-run cleanup"
    )
  end
  k3s_access_state = %r{
    SESSION_STATE_FILE:\s*
    \$\{\{\s*runner\.temp\s*\}\}/betstan-rollback-control/k3s-access\.env
  }x
  unless content.scan(k3s_access_state).length == 2
    fail_inventory(
      "#{name} must preserve the k3s access state until its always-run cleanup"
    )
  end
  reject_content(
    content,
    %r{artifacts/oci-rollback/(?:runner-rule|k3s-access)\.env},
    "#{name} must keep cleanup state outside the recreated rollback output directory"
  )
  require_content(
    content,
    /if:\s*inputs\.allow_legacy_admin_auth/,
    "#{name} must keep the legacy admin-auth override explicitly opt-in"
  )
end

def validate_ghcr_cache_recovery_workflow!(name, document, content)
  validate_dispatch_only_workflow!(name, document)
  validate_required_workflow_dispatch_inputs!(
    name,
    document,
    %w[
      baseline_source_sha
      trusted_build_run_id
      trusted_deploy_run_id
      infrastructure_run_id
      resume_recovery_run_id
      confirmation
    ]
  )
  validate_exact_permissions!(
    name,
    document,
    { "actions" => "read", "contents" => "read", "packages" => "write" }
  )
  {
    "RECOVER K3S CACHED BASELINE TO GHCR" => "exact recovery confirmation",
    "recover-k3s-cached-images.sh" => "reviewed cache exporter",
    "oci-production-build.yml" => "historical build provenance",
    "oci-production-deploy.yml" => "historical deployment provenance",
    "oci-infrastructure.yml" => "protected k3s infrastructure provenance",
    "resume_recovery_run_id" => "explicit failed-run resume selector",
    "Download immutable pre-rebind plan selected for resume" => "prior plan recovery",
    "Upload immutable pre-rebind plan before rollout" => "pre-mutation plan persistence",
    "TRANSITION_PHASE: plan" => "non-mutating transition planning",
    "OCI_K3S_RETAIN_TARGET_SSH: \"true\"" => "bounded retained SSH access",
    "GHCR_TOKEN: ${{ github.token }}" => "runner-only GHCR publication token",
    "public-validate" => "credential-retirement health gate",
    "retire-ocir" => "deferred OCIR retirement",
    "TRANSITION_PHASE: retire" => "two-phase transition",
    "group: oci-control-plane" => "control-plane serialization",
    "cancel-in-progress: false" => "non-cancelling recovery serialization"
  }.each do |literal, label|
    require_content(content, /#{Regexp.escape(literal)}/, "#{name} is missing #{label}")
  end
  require_content(
    content,
    /\^\[0-9a-f\]\{40\}\$/,
    "#{name} must validate the historical source SHA"
  )
end

def validate_manual_oci_workflow!(name, document, content)
  triggers = workflow_triggers(document)
  fail_inventory("#{name} must be workflow_dispatch-only") unless triggers.keys == ["workflow_dispatch"]

  dispatch = triggers["workflow_dispatch"]
  inputs = dispatch.is_a?(Hash) ? dispatch["inputs"] : nil
  approved_sha = inputs.is_a?(Hash) ? inputs["approved_sha"] : nil
  unless approved_sha.is_a?(Hash) && approved_sha["required"] == true
    fail_inventory("#{name} must require the approved_sha dispatch input")
  end

  require_content(
    content,
    %r{run-name:\s*.*(?:\$\{\{\s*inputs\.approved_sha\s*\}\}|inputs\.approved_sha)},
    "#{name} run name must identify the approved SHA"
  )
  require_content(
    content,
    %r{ref:\s*\$\{\{\s*inputs\.approved_sha\s*\}\}},
    "#{name} must check out inputs.approved_sha"
  )
  require_content(
    content,
    /github\.run_attempt\s*==\s*1/,
    "#{name} must reject rerun attempts"
  )
  require_content(
    content,
    /(?:GITHUB_REF_NAME["'}\s=]+master|github\.ref_name\s*==\s*['"]master['"])/,
    "#{name} must reject non-master dispatches"
  )
  require_content(
    content,
    /\^\[0-9a-f\]\{40\}\$/,
    "#{name} must validate a complete lowercase SHA"
  )
  require_content(
    content,
    %r{origin/master},
    "#{name} must bind the approved SHA to current master"
  )
  reject_content(
    content,
    /\$\{\{\s*github\.sha\s*\}\}/,
    "#{name} must not use the dispatch workflow github.sha"
  )
end

def validate_scheduled_oci_workflow!(name, document, content)
  triggers = workflow_triggers(document)
  expected_triggers = ["schedule", "workflow_dispatch"]
  unless triggers.keys.sort == expected_triggers
    fail_inventory("#{name} must have schedule and workflow_dispatch only")
  end

  def validate_migration_recovery_workflow!(name, document, content)
    triggers = workflow_triggers(document)
    expected_triggers = ["schedule", "workflow_dispatch", "workflow_run"]
    unless triggers.keys.sort == expected_triggers
      fail_inventory(
        "#{name} must have workflow_run, schedule, and workflow_dispatch only"
      )
    end

    schedules = triggers["schedule"]
    unless schedules.is_a?(Array) &&
           schedules.length == 1 &&
           schedules[0].is_a?(Hash) &&
           schedules[0]["cron"] == "*/15 * * * *"
      fail_inventory("#{name} must use the reviewed bounded fifteen-minute schedule")
    end

    workflow_run = triggers["workflow_run"]
    workflows = workflow_run.is_a?(Hash) ? Array(workflow_run["workflows"]) : []
    types = workflow_run.is_a?(Hash) ? Array(workflow_run["types"]) : []
    branches = workflow_run.is_a?(Hash) ? Array(workflow_run["branches"]) : []
    unless workflows == ["oci-migrate"] &&
           types == ["completed"] &&
           branches == ["master"]
      fail_inventory(
        "#{name} must run only after completed master oci-migrate workflows"
      )
    end

    require_content(
      content,
      /vars\.OCI_MIGRATION_RECOVERY_ENABLED\s*==\s*['"]true['"]/,
      "#{name} schedule must retain the explicit false-by-default activation guard"
    )
    require_content(
      content,
      /vars\.OCI_MIGRATION_RECOVERY_ENABLED\s*\|\|\s*['"]false['"]/,
      "#{name} must default the recovery activation guard to false"
    )
    require_content(
      content,
      /OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH/,
      "#{name} schedule must require an explicit bounded arm deadline"
    )
    require_content(
      content,
      /86400/,
      "#{name} schedule arm deadline must be bounded to one day"
    )
    require_content(
      content,
      /github\.event_name\s*==\s*['"]workflow_dispatch['"]/,
      "#{name} must retain an independently approved manual trigger"
    )
    require_content(
      content,
      /github\.event\.workflow_run\.head_branch\s*==\s*['"]master['"]/,
      "#{name} must reject non-master migration completions"
    )
    require_content(
      content,
      /github\.event\.workflow_run\.head_repository\.full_name\s*==\s*github\.repository/,
      "#{name} must reject migration completions from another repository"
    )
    require_content(
      content,
      /github\.event\.workflow_run\.run_attempt\s*==\s*1/,
      "#{name} must inspect only first-attempt migrations"
    )
    require_content(
      content,
      /actions:\s*write/,
      "#{name} needs only the explicit Actions cancellation permission"
    )
    require_content(
      content,
      /group:\s*azure-migration-recovery/,
      "#{name} must collapse duplicate recovery attempts"
    )
    require_content(
      content,
      /cancel-in-progress:\s*true/,
      "#{name} must collapse duplicate recovery attempts"
    )
    require_content(
      content,
      /secrets\.AZURE_MIGRATION_RECOVERY_CREDENTIALS/,
      "#{name} must use the dedicated Azure stop-only credential"
    )
    reject_content(
      content,
      /secrets\.OCI_MIGRATION_AZURE_CREDENTIALS/,
      "#{name} must not receive the broader migration credential"
    )
    reject_content(
      content,
      /OCI_CI_PRIVATE_KEY_PEM|OCI_K3S_SSH_PRIVATE_KEY|OCI_MIGRATION_AGE_IDENTITY/,
      "#{name} must not receive OCI data-plane credentials"
    )
    reject_content(
      content,
      /\baz\s+aks\s+(?:start|create|update|delete)\b|\baz\s+aks\s+nodepool\b/i,
      "#{name} must never start, create, resize, or delete Azure compute"
    )
    reject_content(
      content,
      /\boci\s+(?:ce|compute|os|bv|lb|network|container|artifacts)\b/i,
      "#{name} must not access OCI"
    )
  end

  schedules = triggers["schedule"]
  unless schedules.is_a?(Array) &&
         schedules.length == 1 &&
         schedules[0].is_a?(Hash) &&
         schedules[0]["cron"] == "*/5 * * * *"
    fail_inventory("#{name} must use the reviewed five-minute schedule")
  end

  dispatch = triggers["workflow_dispatch"]
  inputs = dispatch.is_a?(Hash) ? dispatch["inputs"] : nil
  approved_sha = inputs.is_a?(Hash) ? inputs["approved_sha"] : nil
  unless approved_sha.is_a?(Hash) && approved_sha["required"] == true
    fail_inventory("#{name} must require the approved_sha dispatch input")
  end

  require_content(
    content,
    %r{run-name:\s*.*\$\{\{\s*inputs\.approved_sha\s*},
    "#{name} run name must identify a manual approved SHA"
  )
  require_content(
    content,
    %r{ref:\s*\$\{\{\s*inputs\.approved_sha\s*\}\}},
    "#{name} must check out inputs.approved_sha when manually dispatched"
  )
  require_content(
    content,
    /github\.run_attempt\s*==\s*1/,
    "#{name} must reject rerun attempts"
  )
  require_content(
    content,
    /vars\.OCI_CAPACITY_CATCHER_ENABLED\s*==\s*['"]true['"]/,
    "#{name} schedule must retain the explicit activation kill switch"
  )
  require_content(
    content,
    /github\.event_name\s*==\s*['"]workflow_dispatch['"]/,
    "#{name} must permit an audited manual attempt independently of scheduling"
  )
  require_content(
    content,
    /(?:GITHUB_REF_NAME["'}\s=]+master|github\.ref_name\s*==\s*['"]master['"])/,
    "#{name} must reject non-master executions"
  )
  require_content(
    content,
    /\^\[0-9a-f\]\{40\}\$/,
    "#{name} must validate a complete lowercase SHA"
  )
  require_content(
    content,
    %r{origin/master},
    "#{name} must bind the source SHA to current master"
  )
  reject_content(
    content,
    /\$\{\{\s*github\.sha\s*\}\}/,
    "#{name} must not use the workflow github.sha"
  )
end

def validate_live_data_rollout_workflow!(file, document, content)
  name = "oci-live-data-rollout"
  unless File.basename(file) == "#{name}.yml"
    fail_inventory("#{name} must use .github/workflows/#{name}.yml")
  end

  validate_dispatch_only_workflow!(name, document)
  validate_required_workflow_dispatch_inputs!(
    name,
    document,
    %w[
      approved_sha
      build_run_id
      infrastructure_run_id
      phase
      prerequisite_run_id
      baseline_recovery_run_id
      failed_deploy_run_id
      confirmation
    ]
  )
  validate_exact_permissions!(name, document, { "actions" => "read", "contents" => "read" })
  validate_expected_action_pins!(name, content)

  phase = workflow_dispatch_inputs(document)["phase"]
  unless phase.is_a?(Hash) &&
         phase["type"] == "choice" &&
         phase["options"] == %w[dry-run apply-backfills apply-slip-index]
    fail_inventory("#{name} must expose only the three reviewed rollout phases")
  end

  {
    "DRY RUN LIVE DATA EXACT SHA" => "read-only confirmation",
    "APPLY LIVE BACKFILLS EXACT SHA" => "backfill confirmation",
    "APPLY LIVE SLIP INDEX EXACT SHA" => "index confirmation",
    "RESUME APPLIED LIVE DATA EXACT SHA" => "failed-deploy resume confirmation",
    "oci-production-build.yml" => "exact build provenance",
    "oci-infrastructure.yml" => "exact infrastructure provenance",
    "oci-live-data-rollout.yml" => "phase-chain provenance",
    "oci-ghcr-cache-recovery.yml" => "explicit recovery baseline authority",
    "ghcr-cache-recovery-" => "exact recovery artifact binding",
    "EXPECTED_BASELINE_RECOVERY_RUN_ID" => "recovery authority phase-chain binding",
    "oci-production-baseline-${{ inputs.failed_deploy_run_id }}-1" =>
      "failed-deploy rollback baseline binding",
    "git merge-base --is-ancestor" => "applied-data ancestry proof",
    "Application path changed after applied data" =>
      "application-change rejection",
    "Verify exact failed-deploy resume state" => "running digest verification",
    "application_change_scope=github-infra-docs-only" =>
      "resume evidence scope",
    "production-run-exclusivity-stan.sh" => "production run exclusivity",
    "baseline-capture-stan.sh" => "before and after rollback baselines",
    "shared-mongo-operation-lock-stan.sh acquire" => "database operation lock acquisition",
    "shared-mongo-operation-lock-stan.sh renew" => "bounded database operation lock renewal",
    "shared-mongo-operation-lock-stan.sh verify" => "database operation lock handoff",
    "shared-mongo-operation-lock-stan.sh release" => "always-run database lock release",
    "live-data-maintenance-stan.sh enter" => "legacy writer quiescence",
    "live-data-maintenance-stan.sh verify-held" => "deploy maintenance handoff",
    "live-betting-data-rollout-stan.sh" => "reviewed data operator",
    "verify-live-betting-data-evidence-stan.sh" => "tamper-evident phase validation"
  }.each do |literal, label|
    require_content(
      content,
      /#{Regexp.escape(literal)}/,
      "#{name} is missing #{label}"
    )
  end

  require_content(
    content,
    /group:\s*oci-control-plane/,
    "#{name} must serialize with the OCI control plane"
  )
  require_content(
    content,
    /cancel-in-progress:\s*false/,
    "#{name} must never cancel an in-flight data operation"
  )
  require_content(
    content,
    /expected_phase=apply-backfills/,
    "#{name} must chain the Slip index phase to completed backfills"
  )
end

def validate_live_betting_activation_workflow!(file, document, content)
  name = "oci-live-betting-activate"
  unless File.basename(file) == "#{name}.yml"
    fail_inventory("#{name} must use .github/workflows/#{name}.yml")
  end

  validate_dispatch_only_workflow!(name, document)
  validate_required_workflow_dispatch_inputs!(
    name,
    document,
    %w[
      approved_sha
      build_run_id
      infrastructure_run_id
      deployment_run_id
      confirmation
    ]
  )
  validate_exact_permissions!(name, document, { "actions" => "read", "contents" => "read" })
  validate_expected_action_pins!(name, content)

  {
    "ACTIVATE OCI LIVE BETTING" => "exact activation confirmation",
    "oci-production-build.yml" => "exact build provenance",
    "oci-infrastructure.yml" => "exact infrastructure provenance",
    "oci-production-deploy.yml" => "exact dark deployment provenance",
    "oci-live-readiness-" => "dark readiness evidence",
    "live-betting-control-stan.sh" => "reviewed flag operator",
    "ACTION: activate" => "explicit activation action",
    "LIVE_ACTIVATION_LEASE_SECONDS" => "bounded activation lease",
    "activation_state=leased" => "leased pre-commit provenance",
    "accepted.env" => "leased pre-commit evidence file",
    "COMMIT OCI LIVE BETTING" => "exact permanent activation confirmation",
    "ACTION: commit" => "post-acceptance activation commit",
    "ACTION: disable" => "automatic failure disable action",
    "steps.accepted.outcome != 'success'" => "failure-triggered disable gate",
    "steps.accepted_evidence_upload.outcome != 'success'" => "accepted-evidence failure disable gate",
    "steps.commit_preflight.outcome != 'success'" => "commit preflight failure gate",
    "steps.commit.outcome != 'success'" => "commit failure disable gate",
    "oci-live-activation-accepted-" => "protected pre-commit activation evidence",
    "activation_state=committed" => "final committed provenance",
    "post_commit_status=" => "explicit post-commit handling",
    "workflow_result=" => "final workflow outcome provenance",
    "runtime_fingerprint" => "deployment-to-infrastructure runtime binding",
    "infrastructure_provenance_sha256" => "exact infrastructure artifact binding",
    "revalidate-live-activation-stan.sh" => "immediate master and provenance revalidation",
    "ROLLBACK_BASELINE_FILE" => "dark rollback baseline validation",
    "role:set" => "protected disposable administrator operator",
    "playwright-live-acceptance.config.js" => "production browser acceptance",
    "service-ops-stan.sh" => "sanitized runtime log inspection"
  }.each do |literal, label|
    require_content(
      content,
      /#{Regexp.escape(literal)}/,
      "#{name} is missing #{label}"
    )
  end

  require_content(
    content,
    /group:\s*oci-control-plane/,
    "#{name} must serialize with the OCI control plane"
  )
  require_content(
    content,
    /cancel-in-progress:\s*false/,
    "#{name} must never cancel an in-flight activation"
  )
  if content.scan("revalidate-live-activation-stan.sh").length < 3
    fail_inventory(
      "#{name} must revalidate before mutation, acceptance, and permanent activation"
    )
  end

  accepted_evidence_position = content.index("- name: Write accepted activation lease evidence")
  accepted_upload_position =
    content.index("- name: Upload protected accepted activation evidence")
  commit_revalidation_position =
    content.index("- name: Revalidate release head before permanent activation")
  commit_position = content.index("- name: Commit accepted live activation")
  final_provenance_position = content.index("- name: Write final activation provenance")
  evidence_position = content.index("- name: Upload protected activation evidence")
  unless accepted_evidence_position &&
      accepted_upload_position &&
      commit_revalidation_position &&
      commit_position &&
      final_provenance_position &&
      evidence_position &&
      accepted_evidence_position < accepted_upload_position &&
      accepted_upload_position < commit_revalidation_position &&
      commit_revalidation_position < commit_position &&
      commit_position < final_provenance_position &&
      final_provenance_position < evidence_position
    fail_inventory(
      "#{name} must lease before revalidation and upload final evidence after the permanent activation state is written"
    )
  end
  if content.scan("!cancelled()").length < 3
    fail_inventory(
      "#{name} must block accepted-evidence upload, permanent preflight, and commit after cancellation"
    )
  end
end

def validate_live_betting_disable_workflow!(file, document, content)
  name = "oci-live-betting-disable"
  unless File.basename(file) == "#{name}.yml"
    fail_inventory("#{name} must use .github/workflows/#{name}.yml")
  end

  validate_dispatch_only_workflow!(name, document)
  validate_required_workflow_dispatch_inputs!(
    name,
    document,
    %w[approved_sha deployment_run_id infrastructure_run_id confirmation]
  )
  validate_exact_permissions!(name, document, { "actions" => "read", "contents" => "read" })
  validate_expected_action_pins!(name, content)

  {
    "DISABLE OCI LIVE BETTING" => "exact disable confirmation",
    "oci-production-deploy.yml" => "exact deployment provenance",
    "oci-infrastructure.yml" => "exact infrastructure provenance",
    "authorize-github-runner.sh authorize" => "exact runner authorization",
    "revoke-github-runner.sh" => "always-run runner revocation",
    "configure-k3s-access.sh open" => "k3s runner authorization",
    "configure-k3s-access.sh cleanup" => "always-run k3s access cleanup",
    "runtime_fingerprint" => "deployment-to-infrastructure runtime binding",
    "infrastructure_provenance_sha256" => "exact infrastructure artifact binding",
    "merge-base --is-ancestor" => "deployed-master ancestry validation",
    "live-betting-control-stan.sh" => "reviewed flag operator",
    "ACTION: disable" => "explicit disable action",
    "MODE=rollback-drain" => "live-aware drain gate",
    "live betting did not drain within 20 minutes" => "bounded drain timeout",
    "steps.disable.outcome != 'success'" => "workflow-level dark reassertion",
    "service-ops-stan.sh" => "sanitized runtime diagnostics",
    "oci-live-betting-disable-" => "attempt-bound disable evidence"
  }.each do |literal, label|
    require_content(
      content,
      /#{Regexp.escape(literal)}/,
      "#{name} is missing #{label}"
    )
  end

  require_content(
    content,
    /group:\s*oci-control-plane/,
    "#{name} must serialize with the OCI control plane"
  )
  require_content(
    content,
    /cancel-in-progress:\s*false/,
    "#{name} must never cancel an in-flight disable or drain"
  )
end

def validate_oci_production_deploy_binding!(name, document, content)
  validate_manual_oci_workflow!(name, document, content)
  {
    "infrastructure_run_id=%s" => "infrastructure run binding",
    "infrastructure_run_attempt=1" => "first-attempt infrastructure binding",
    "infrastructure_provenance_sha256=%s" => "infrastructure artifact digest binding",
    "SHARED_MONGO_DEPLOY_LOCK_LEASE_SECONDS" => "bounded deploy lock lease",
    "shared-mongo-operation-lock-stan.sh renew" => "deploy lock lease renewal",
    "steps.handoff.outcome == 'success'" => "verified handoff recovery",
    "steps.release_runtime.outcome != 'success'" => "incomplete deploy maintenance recovery"
  }.each do |literal, label|
    require_content(
      content,
      /#{Regexp.escape(literal)}/,
      "#{name} is missing #{label}"
    )
  end

  lines = content.lines
  acquire_indexes = lines.each_index.select do |index|
    lines[index].include?("shared-mongo-operation-lock-stan.sh acquire")
  end
  unless acquire_indexes.length == 2
    fail_inventory("#{name} must have exactly two guarded deploy-lock acquisition paths")
  end
  acquire_indexes.each do |index|
    invocation = lines[[index - 6, 0].max..index].join
    unless invocation.include?(
      'LOCK_LEASE_SECONDS="$SHARED_MONGO_DEPLOY_LOCK_LEASE_SECONDS"'
    )
      fail_inventory("#{name} deploy-lock acquisition is missing the bounded deploy lease")
    end
  end
  renew_count = lines.count do |line|
    line.include?("shared-mongo-operation-lock-stan.sh renew")
  end
  unless renew_count == 2
    fail_inventory("#{name} must renew each verified deploy-lock path exactly once")
  end
end

def validate_oci_workflow!(name, file, document, content)
  expected_file = "#{name}.yml"
  unless File.basename(file) == expected_file
    fail_inventory("#{name} must use .github/workflows/#{expected_file}")
  end

  validate_environment!(name, document)
  reject_content(
    content,
    /(?:^|:)latest(?:\s|$)/i,
    "#{name} must not use a mutable latest image tag"
  )

  if name == "oci-production-build"
    triggers = workflow_triggers(document)
    fail_inventory("#{name} must be workflow_run-only") unless triggers.keys == ["workflow_run"]

    workflow_run = triggers["workflow_run"]
    workflows = workflow_run.is_a?(Hash) ? Array(workflow_run["workflows"]) : []
    types = workflow_run.is_a?(Hash) ? Array(workflow_run["types"]) : []
    unless workflows.sort == ["ghcr-package-management", "production-build"] &&
        types == ["completed"]
      fail_inventory(
        "#{name} must run only after completed production-build or repair-authority workflows"
      )
    end

    require_content(
      content,
      /\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/,
      "#{name} must use the upstream workflow_run head SHA"
    )
    require_content(
      content,
      %r{ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}},
      "#{name} must check out the upstream workflow_run head SHA"
    )
    reject_content(
      content,
      /\$\{\{\s*github\.sha\s*\}\}/,
      "#{name} must not use the downstream workflow github.sha"
    )
    {
      "conclusion" => "success",
      "event" => "push",
      "head_branch" => "master",
      "head_repository.full_name" => "github.repository",
      "run_attempt" => "1"
    }.each do |field, value|
      require_content(
        content,
        /github\.event\.workflow_run\.#{Regexp.escape(field)}\s*==\s*['"]?#{Regexp.escape(value)}['"]?/,
        "#{name} must validate upstream #{field}=#{value}"
      )
    end
    require_content(
      content,
      /github\.run_attempt\s*==\s*1/,
      "#{name} must reject downstream rerun attempts"
    )
    require_content(
      content,
      /REPAIR_EXISTING_TAGS:\s*\$\{\{\s*steps\.trust\.outputs\.repair_mode\s*\}\}/,
      "#{name} must bind partial-tag adoption to reviewed repair evidence"
    )
  elsif name == "oci-production-rollback"
    validate_oci_rollback_workflow!(file, document, content)
  elsif name == "oci-capacity-acquire"
    validate_scheduled_oci_workflow!(name, document, content)
  elsif name == "oci-migration-recovery"
    validate_migration_recovery_workflow!(name, document, content)
  elsif name == "oci-live-data-rollout"
    validate_live_data_rollout_workflow!(file, document, content)
  elsif name == "oci-live-betting-activate"
    validate_live_betting_activation_workflow!(file, document, content)
  elsif name == "oci-live-betting-disable"
    validate_live_betting_disable_workflow!(file, document, content)
  elsif name == "oci-production-deploy"
    validate_oci_production_deploy_binding!(name, document, content)
  elsif name == "oci-ghcr-cache-recovery"
    validate_ghcr_cache_recovery_workflow!(name, document, content)
  else
    validate_manual_oci_workflow!(name, document, content)
  end

  return if ["oci-migrate", "oci-migration-recovery"].include?(name)

  validate_non_migration_secrets!(name, content)
  reject_content(
    content,
    %r{
      azure/(?:login|CLI|aks-set-context)@|
      \baz\s+(?:login|account|aks\s+get-credentials)\b
    }ix,
    "#{name} must not receive Azure credentials"
  )
end

documents = {}
workflow_files = Dir.children(directory).sort.each_with_object([]) do |entry, files|
  next unless entry.end_with?(".yml", ".yaml")

  file = File.join(directory, entry)
  files << file if File.file?(file)
end

names = workflow_files.each_with_object([]) do |file, result|
  content = File.read(file)
  document = YAML.safe_load(content, aliases: true) || {}
  next unless document.is_a?(Hash)

  name = document["name"] || File.basename(file, File.extname(file))
  fail_inventory("duplicate workflow identity: #{name}") if documents.key?(name)

  documents[name] = [file, document, content]
  triggers = workflow_triggers(document)

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
    Array(workflow_run["workflows"]).any? do |workflow|
      ["production-build", "oci-production-build"].include?(workflow)
    end

  production_capable = content.match?(
    %r{
      production-(?:automatic|emergency)|
      infra/k8s-prod|
      docker/build-push-action|
      kubectl\s+(?:apply|set\ image)|
      deploy-stan\.sh|
      terraform\s+apply|
      uses:\s*\./\.github/workflows/|
      infra/oci|
      [a-z0-9.-]+\.ocir\.io|
      \boci\s+(?:setup|ce|compute|iam|os|bv|lb|network|container|artifacts)\b|
      secrets\s*(?:\.\s*(?:AZURE[A-Z0-9_]*|ARM[A-Z0-9_]*|ACR[A-Z0-9_]*|
        RESOURCE_GROUP|CLUSTER_NAME|
        OCI[A-Z0-9_]*|OCIR[A-Z0-9_]*)\b|\[)
    }ix
  ) || OCI_WORKFLOWS.include?(name)
  manual_production = triggers.key?("workflow_dispatch")
  scheduled_production = triggers.key?("schedule")

  next unless production_capable &&
              (push_master || chained_production || manual_production || scheduled_production)

  result << name
end

names = names.sort.uniq
unless names == REQUIRED_SET
  fail_inventory(
    "expected #{REQUIRED_SET.join(",")}; found #{names.join(",")}"
  )
end

file, document, content = documents.fetch("production-rollback")
validate_azure_rollback_workflow!(file, document, content)

OCI_WORKFLOWS.each do |name|
  file, document, content = documents.fetch(name)
  validate_oci_workflow!(name, file, document, content)
end

puts names
