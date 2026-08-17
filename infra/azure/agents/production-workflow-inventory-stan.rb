# frozen_string_literal: true

require "yaml"

directory = ARGV.fetch(0)

AZURE_WORKFLOWS = %w[production-build production-deploy].freeze
OCI_WORKFLOWS = %w[
  oci-capacity-acquire
  oci-infrastructure
  oci-migrate
  oci-migration-recovery
  oci-production-build
  oci-production-deploy
].freeze
REQUIRED_SET = (AZURE_WORKFLOWS + OCI_WORKFLOWS).sort.freeze
PROTECTED_ENVIRONMENTS = {
  "oci-capacity-acquire" => "oci-capacity-acquire",
  "oci-infrastructure" => "oci-infrastructure",
  "oci-migrate" => "oci-migration",
  "oci-migration-recovery" => "azure-migration-recovery",
  "oci-production-build" => "oci-build",
  "oci-production-deploy" => "oci-production"
}.freeze
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

def require_content(content, pattern, message)
  fail_inventory(message) unless content.match?(pattern)
end

def reject_content(content, pattern, message)
  fail_inventory(message) if content.match?(pattern)
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
    %r{run-name:\s*.*\$\{\{\s*inputs\.approved_sha\s*\}\}},
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
    unless workflows == ["production-build"] && types == ["completed"]
      fail_inventory(
        "#{name} must run only after completed production-build workflows"
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
  elsif name == "oci-capacity-acquire"
    validate_scheduled_oci_workflow!(name, document, content)
  elsif name == "oci-migration-recovery"
    validate_migration_recovery_workflow!(name, document, content)
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
names = Dir.glob(File.join(directory, "*.{yml,yaml}")).each_with_object([]) do |file, result|
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

OCI_WORKFLOWS.each do |name|
  file, document, content = documents.fetch(name)
  validate_oci_workflow!(name, file, document, content)
end

puts names
