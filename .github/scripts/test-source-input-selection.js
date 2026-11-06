"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { PACKAGES, selectSourceInputs } = require("./source-input-selection.js");

const ROOT = path.resolve(__dirname, "../..");

function repositoryWorkflow(name) {
  return JSON.parse(execFileSync("ruby", [
    "-rjson", "-ryaml", "-e", "puts JSON.generate(YAML.load_file(ARGV[0]))",
    path.join(ROOT, ".github/workflows", name),
  ], { encoding: "utf8" }));
}

function runScopeSelector(workflow, paths) {
  const step = workflow.jobs["change-scope"]?.steps.find((item) => item.id === "scope") ??
    workflow.jobs.scope.steps.find((item) => item.id === "scope");
  const source = /^python3 - <<'PY'\n([\s\S]*)\nPY\n?$/.exec(step.run)?.[1];
  assert.ok(source, "exercise the actual workflow selector");
  const result = execFileSync("python3", ["-c", `
import contextlib
import io
import json
import os
from unittest.mock import mock_open, patch

source, paths = json.loads(${JSON.stringify(JSON.stringify([source, paths]))})
os.environ.update(GITHUB_EVENT_NAME="pull_request", BASE_SHA="base", HEAD_SHA="head",
                  GITHUB_OUTPUT="test-output")
output = mock_open()
with patch("subprocess.check_output", return_value="\\n".join(paths)) as diff, \\
     patch("builtins.open", output), contextlib.redirect_stdout(io.StringIO()):
    exec(source, {})
diff.assert_called_once_with(
    ["git", "diff", "--no-renames", "--name-only", "base", "head"], text=True)
values = "".join(call.args[0] for call in output().write.call_args_list)
print(json.dumps(dict(line.split("=", 1) for line in values.splitlines())))
`], { encoding: "utf8" });
  return JSON.parse(result);
}

function testServiceFeedback() {
  const feedback = repositoryWorkflow("service-tests.yml");
  const production = repositoryWorkflow("production-build.yml");
  const services = PACKAGES.filter((name) => !["client", "common", "telemetry"].includes(name));
  const trigger = (feedback.on ?? feedback.true).pull_request;
  assert.equal(trigger.branches, undefined, "retain feedback outside protected PR bases");
  for (const service of services) {
    assert.ok(trigger.paths.includes(`${service}/**`));
    assert.equal(fs.existsSync(path.join(ROOT, `.github/workflows/tests-${service}.yaml`)), false);
    const changed = [`${service}/src/route.ts`];
    assert.deepEqual(JSON.parse(runScopeSelector(feedback, changed).matrix).service, [service]);
    assert.ok(JSON.parse(runScopeSelector(production, changed).coverage_matrix).service.includes(service));
  }
  const changed = ["bet/src/deleted.ts", "auth/src/renamed.ts", "docs/wiki/Agents.md"];
  assert.deepEqual(JSON.parse(runScopeSelector(feedback, changed).matrix).service, ["auth", "bet"]);
  for (const shared of ["common/src/index.ts", "betstan-common-1.0.55.tgz"]) {
    assert.deepEqual(JSON.parse(runScopeSelector(feedback, [shared]).matrix).service, services);
    const covered = JSON.parse(runScopeSelector(production, [shared]).coverage_matrix).service;
    for (const service of services) assert.ok(covered.includes(service));
  }
  const unaffected = runScopeSelector(feedback, ["client/src/App.js", "docs/wiki/Agents.md"]);
  assert.equal(unaffected.has_tests, "false");
  const allowed = new Function("github", `return (${feedback.jobs.scope.if});`);
  for (const base of ["dev", "master", "feature/preview"]) {
    assert.equal(allowed({ event: { pull_request: { base: { ref: base } } } }),
      base !== "dev" && base !== "master");
  }
  assert.deepEqual(feedback.permissions, { contents: "read" });
  assert.equal(feedback.jobs.tests.needs, "scope");
  assert.equal(feedback.jobs.tests.if, "needs.scope.outputs.has_tests == 'true'");
  assert.equal(feedback.jobs.tests.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
    .with["node-version"], "20.19.5");
  assert.deepEqual(feedback.jobs.tests.steps.filter((step) => step.run).map((step) => step.run),
    ["npm ci", "npm run test:ci"]);
  for (const job of Object.values(feedback.jobs)) {
    assert.equal(job.environment, undefined);
    assert.equal(job.permissions, undefined);
  }
}

function fixture() {
  const paths = [
    ...PACKAGES.flatMap((name) => [`${name}/package.json`, `${name}/package-lock.json`, `${name}/src/index.ts`]),
    ".github/scripts/source-quality-suite.sh",
    ".github/scripts/source-input-selection.js",
    ".github/workflows/source-quality.yml",
    ".github/workflows/branch-policy.yml",
    "infra/azure/agents/pr-validation-stan.sh",
    "infra/azure/agents/test-pr-validation-stan.sh",
    "infra/oci/tests/test-contract.sh",
    "docs/wiki/Quality-Gates.md",
  ];
  return {
    records: paths.map((path) => ({ path, mode: "100644", blobSha: "a".repeat(40) })),
    changedPaths: ["client/src/index.ts"],
    executionProfiles: Object.fromEntries(["node-policy", "package", "docker", "contracts"].map((name) =>
      [name, { identity: "b".repeat(64), immutable: true }],
    )),
  };
}

function testSourceInputSelection() {
  const input = fixture();
  const plan = selectSourceInputs(input);
  const ids = plan.suites.map((suite) => suite.suiteId);
  assert.deepEqual(ids, ["source-policy", "package-client"]);
  assert.equal(plan.conservative, false);
  assert.equal(plan.noWork, false);

  const reversed = fixture();
  reversed.records.reverse();
  assert.deepEqual(selectSourceInputs(reversed), plan);
  const changedLock = fixture();
  changedLock.records.find((record) => record.path === "client/package-lock.json").blobSha = "c".repeat(40);
  const changedPlan = selectSourceInputs(changedLock);
  const hash = (value, id) => value.suites.find((suite) => suite.suiteId === id).inputClosureSha256;
  assert.notEqual(hash(changedPlan, "package-client"), hash(plan, "package-client"));
  assert.equal(hash(changedPlan, "source-policy"), hash(plan, "source-policy"));
  for (const path of [
    ".github/workflows/branch-policy.yml",
    "infra/azure/agents/pr-validation-stan.sh",
    "infra/azure/agents/test-pr-validation-stan.sh",
  ]) {
    const policyChange = fixture();
    policyChange.records.find((record) => record.path === path).blobSha = "f".repeat(40);
    assert.notEqual(hash(selectSourceInputs(policyChange), "source-policy"), hash(plan, "source-policy"));
  }

  for (const path of [".github/scripts/source-quality-suite.sh", ".github/scripts/source-input-selection.js"]) {
    const runnerChange = fixture();
    runnerChange.records.find((record) => record.path === path).blobSha = "d".repeat(40);
    assert.notEqual(hash(selectSourceInputs(runnerChange), "package-client"), hash(plan, "package-client"));
  }
  const profileChange = fixture();
  profileChange.executionProfiles.package.identity = "c".repeat(64);
  assert.notEqual(hash(selectSourceInputs(profileChange), "package-client"), hash(plan, "package-client"));
  assert.equal(plan.suites.find((suite) => suite.suiteId === "package-client").reuseAllowed, false);
  assert.equal(plan.suites.find((suite) => suite.suiteId === "source-policy").reuseAllowed, true);
  const mutable = fixture();
  mutable.executionProfiles["node-policy"].immutable = false;
  assert.equal(selectSourceInputs(mutable).suites.find((suite) => suite.suiteId === "source-policy").reuseAllowed, false);

  const common = fixture();
  common.changedPaths = ["common/src/index.ts"];
  const commonIds = selectSourceInputs(common).suites.map((suite) => suite.suiteId);
  for (const name of PACKAGES) assert.ok(commonIds.includes(`package-${name}`));
  assert.ok(commonIds.includes("auth-image"));
  assert.equal(commonIds.some((id) => id.startsWith("oci-")), false);

  const selectedFor = (file) => selectSourceInputs({ ...fixture(), changedPaths: [file] })
    .suites.map((suite) => suite.suiteId);
  assert.deepEqual(selectedFor("bet/src/routes/read.ts"), ["source-policy", "package-bet"]);
  assert.deepEqual(selectedFor("auth/src/index.ts"), [
    "source-policy", "package-auth", "auth-image", "oci-provenance",
  ]);
  for (const [file, contracts] of [
    ["bet/src/new/AddedListener.ts", ["oci-live"]],
    ["resulting/src/event/listener/CashBackRequestListener.ts", ["oci-core", "oci-live"]],
    ["client/src/styles/ui.css", ["oci-core"]],
    ["moderation/src/runtime/ModerationRuntime.ts", ["oci-core"]],
    ["event/src/scripts/new-script.ts", ["oci-core"]],
    ["telemetry/src/event/TelemetryConsumer.ts", ["oci-live"]],
    ["common/README.md", ["oci-core"]],
    ["docs/wiki/Release-Orchestration.md", ["oci-core", "oci-provenance"]],
  ]) {
    assert.deepEqual(selectedFor(file).filter((id) => id.startsWith("oci-")), contracts, file);
  }
  assert.ok(selectedFor("infra/k8s/new.yaml").includes("manifest"));
  assert.ok(!selectedFor("infra/oci/scripts/changed.sh").includes("manifest"));
  assert.ok(selectedFor(".gitignore").includes("ingress"));
  assert.ok(selectedFor(".gitmodules").includes("oci-core"));

  const broadFingerprint = { ...fixture(), changedPaths: ["client/src/styles/ui.css"] };
  const coreBefore = hash(selectSourceInputs(broadFingerprint), "oci-core");
  broadFingerprint.records.find((record) => record.path === "auth/src/index.ts").blobSha = "c".repeat(40);
  assert.notEqual(hash(selectSourceInputs(broadFingerprint), "oci-core"), coreBefore,
    "narrow selection must not narrow conservative contract fingerprints");

  for (const changedPaths of [
    [".github/scripts/source-input-selection.js"],
    ["unexpected/build-input.conf"],
    ["client/src/old-name.ts", "unexpected/new-name.ts"],
  ]) {
    const unknown = { ...fixture(), changedPaths };
    const selected = selectSourceInputs(unknown);
    assert.equal(selected.conservative, true);
    assert.equal(selected.suites.find((suite) => suite.suiteId === "source-policy").reuseAllowed, false);
    for (const name of PACKAGES) assert.ok(selected.suites.some((suite) => suite.suiteId === `package-${name}`));
  }

  const empty = fixture();
  empty.changedPaths = [];
  const noWork = selectSourceInputs(empty);
  assert.equal(noWork.noWork, true);
  assert.deepEqual(noWork.suites, []);
  assert.match(noWork.selectionDigest, /^[0-9a-f]{64}$/);

  for (const mutate of [
    (value) => { value.changedPaths = ["../outside"]; },
    (value) => { value.changedPaths.push(value.changedPaths[0]); },
    (value) => { value.records.push({ ...value.records[0] }); },
    (value) => { value.records[0].mode = "120000"; },
    (value) => { value.records[0].mode = "160000"; },
    (value) => { value.records[0].blobSha = "invalid"; },
    (value) => { value.records.push({ path: "unknown/package.json", mode: "100644", blobSha: "f".repeat(40) }); },
    (value) => { value.records = value.records.filter((record) => record.path !== "client/package-lock.json"); },
    (value) => { delete value.executionProfiles.package; },
  ]) {
    const invalid = fixture();
    mutate(invalid);
    assert.throws(() => selectSourceInputs(invalid));
  }
  testServiceFeedback();
  console.log("source_input_selection_tests=PASS");
}

if (require.main === module) testSourceInputSelection();
module.exports = testSourceInputSelection;
module.exports.fixture = fixture;
