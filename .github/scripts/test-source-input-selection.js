"use strict";

const assert = require("node:assert/strict");
const { PACKAGES, selectSourceInputs } = require("./source-input-selection.js");

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
  console.log("source_input_selection_tests=PASS");
}

if (require.main === module) testSourceInputSelection();
module.exports = testSourceInputSelection;
module.exports.fixture = fixture;
