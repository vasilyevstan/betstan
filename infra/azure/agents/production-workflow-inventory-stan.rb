# frozen_string_literal: true

require "yaml"

directory = ARGV.fetch(0)

AZURE_WORKFLOWS = %w[production-build production-deploy].freeze
OCI_WORKFLOWS = %w[
  oci-infrastructure
  oci-migrate
  oci-production-build
  oci-production-deploy
].freeze
CURRENT_SET = AZURE_WORKFLOWS.sort.freeze
FUTURE_SET = (AZURE_WORKFLOWS + OCI_WORKFLOWS).sort.freeze
PROTECTED_ENVIRONMENTS = {
  "oci-infrastructure" => "oci-infrastructure",
  "oci-migrate" => "oci-migration",
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
  else
    validate_manual_oci_workflow!(name, document, content)
  end

  return if name == "oci-migrate"

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

  next unless production_capable &&
              (push_master || chained_production || manual_production)

  result << name
end

names = names.sort.uniq
unless names == CURRENT_SET || names == FUTURE_SET
  fail_inventory(
    "expected #{CURRENT_SET.join(",")} or #{FUTURE_SET.join(",")}; found #{names.join(",")}"
  )
end

if names == FUTURE_SET
  OCI_WORKFLOWS.each do |name|
    file, document, content = documents.fetch(name)
    validate_oci_workflow!(name, file, document, content)
  end
end

puts names
