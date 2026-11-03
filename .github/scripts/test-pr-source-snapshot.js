"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  sourceSnapshot,
  createQualityManifest,
  evaluateQualityCandidate,
} = require("./pr-source-snapshot.js");

function pull() {
  return {
    number: 63,
    state: "open",
    mergeable: true,
    merge_commit_sha: "3".repeat(40),
    title: "Restore service availability",
    body: "Reviewed recovery change",
    labels: [],
    updated_at: "2026-09-02T09:00:00.000Z",
    head: {
      ref: "fix/recovery",
      sha: "1".repeat(40),
      repo: { full_name: "example/repo" },
    },
    base: {
      ref: "dev",
      sha: "2".repeat(40),
      repo: { full_name: "example/repo" },
    },
  };
}

const original = sourceSnapshot(pull());
const metadataEdit = pull();
metadataEdit.title = "Restore public services";
metadataEdit.body = "Additional review evidence";
metadataEdit.labels = [{ name: "copilot-cli-managed" }];
metadataEdit.updated_at = "2026-09-02T10:00:00.000Z";
assert.deepEqual(sourceSnapshot(metadataEdit), original);

for (const mutate of [
  (value) => { value.number += 1; },
  (value) => { value.head.sha = "4".repeat(40); },
  (value) => { value.base.sha = "4".repeat(40); },
  (value) => { value.merge_commit_sha = "4".repeat(40); },
  (value) => { value.head.ref = "fix/another-recovery"; },
  (value) => { value.base.ref = "master"; },
  (value) => { value.head.repo.full_name = "contributor/repo"; },
  (value) => { value.base.repo.full_name = "example/another-repo"; },
]) {
  const changed = pull();
  mutate(changed);
  assert.notDeepEqual(sourceSnapshot(changed), original);
}

for (const mutate of [
  (value) => { value.state = "closed"; },
  (value) => { value.mergeable = null; },
  (value) => { value.mergeable = false; },
  (value) => { delete value.head; },
  (value) => { delete value.base; },
  (value) => { delete value.head.repo; },
  (value) => { delete value.base.repo; },
  (value) => { value.number = 0; },
  (value) => { value.number = "63"; },
  (value) => { value.head.sha = "refs/heads/dev"; },
  (value) => { value.base.sha = "2".repeat(39); },
  (value) => { value.merge_commit_sha = ""; },
  (value) => { value.merge_commit_sha = value.head.sha; },
  (value) => { value.merge_commit_sha = value.base.sha; },
  (value) => { value.head.repo.full_name = "example/repo/extra"; },
  (value) => { value.base.repo.full_name = "example/repo\n"; },
  (value) => { value.head.ref = "fix/recovery\n"; },
  (value) => { value.base.ref = ""; },
]) {
  const invalid = pull();
  mutate(invalid);
  assert.throws(() => sourceSnapshot(invalid), /Source snapshot/);
}
assert.throws(() => sourceSnapshot(null), /Source snapshot/);

function fixture() {
  const snapshot = sourceSnapshot(pull());
  const validator = {
    workflowId: 202,
    workflowPath: ".github/workflows/production-build.yml",
    executingCommitSha: snapshot.baseSha,
    executingRef: "refs/heads/dev",
    workflowBlobSha: "5".repeat(40),
    executableClosureSha256: "6".repeat(64),
  };
  const run = {
    repository: snapshot.repository,
    runId: 102,
    attempt: 2,
    workflowId: validator.workflowId,
    workflowPath: validator.workflowPath,
    headSha: snapshot.headSha,
    controlSha: validator.executingCommitSha,
    event: "pull_request_target",
    status: "completed",
    conclusion: "success",
  };
  const checkout = {
    commitSha: snapshot.mergeSha,
    treeSha: "7".repeat(40),
    parents: [snapshot.baseSha, snapshot.headSha],
  };
  const suite = {
    suiteId: "source-policy",
    jobId: 501,
    jobName: "quality (source-policy)",
    executionAttempt: 2,
    inputClosureSha256: "9".repeat(64),
    conclusion: "success",
  };
  const proof = {
    schemaVersion: 1,
    sourceSnapshot: snapshot,
    checkout,
    validator,
    run,
    inputClosureSha256: "8".repeat(64),
    expectedSuiteIds: ["source-policy"],
    suites: [suite],
  };
  const input = {
    snapshot,
    checkoutProof: null,
    selectedResults: [],
    authenticatedRunArtifactFacts: { run, checkout, artifacts: [] },
    trustedValidatorPolicy: {
      validator,
      inputClosureSha256: proof.inputClosureSha256,
      suites: [{
        suiteId: suite.suiteId,
        jobName: suite.jobName,
        inputClosureSha256: suite.inputClosureSha256,
      }],
    },
  };
  function bind(artifactId, document) {
    const content = JSON.stringify(document);
    input.authenticatedRunArtifactFacts.artifacts.push({
      artifactId,
      contentSha256: crypto.createHash("sha256").update(content).digest("hex"),
      run: { ...structuredClone(run), ...structuredClone(document.run) },
      validator: structuredClone(document.validator),
      checkout: structuredClone(document.checkout),
      jobs: document.suites.map((item) => ({
        id: item.jobId,
        name: item.jobName,
        run_id: document.run.runId,
        run_attempt: item.executionAttempt,
        head_sha: document.run.headSha,
        status: "completed",
        conclusion: item.conclusion,
      })),
    });
    return { artifactId, content };
  }
  input.checkoutProof = bind(11, proof);
  input.selectedResults = [{ ...input.checkoutProof, suiteId: suite.suiteId }];
  return { input, proof, suite, bind };
}

function assertRejected(input, expectedReason) {
  const outcome = evaluateQualityCandidate(input);
  assert.equal(outcome.candidateMatch, false);
  assert.equal(outcome.proofDigestOrNull, null);
  assert(outcome.reasonCodes.length > 0);
  if (expectedReason) assert.deepEqual(outcome.reasonCodes, [expectedReason]);
}

const passing = fixture().input;
const before = structuredClone(passing);
assert.equal(evaluateQualityCandidate(passing).candidateMatch, true);
assert.deepEqual(passing, before, "candidate evaluation must not mutate evidence");

const missingProof = fixture().input;
missingProof.checkoutProof = undefined;
assertRejected(missingProof, "MISSING_OR_UNBOUND_CHECKOUT_PROOF");

for (const commitSha of ["1".repeat(40), "2".repeat(40), "a".repeat(40)]) {
  const { input, proof, bind } = fixture();
  proof.checkout = { ...proof.checkout, commitSha };
  input.checkoutProof = bind(13, proof);
  assertRejected(input);
}

for (const mutate of [
  (value) => { value.authenticatedRunArtifactFacts.run.attempt += 1; },
  (value) => { value.authenticatedRunArtifactFacts.run.workflowId += 1; },
  (value) => { value.authenticatedRunArtifactFacts.run.repository = "other/repo"; },
  (value) => { value.authenticatedRunArtifactFacts.run.conclusion = "skipped"; },
  (value) => { value.authenticatedRunArtifactFacts.artifacts[0].run.attempt += 1; },
  (value) => { value.authenticatedRunArtifactFacts.artifacts[0].contentSha256 = "0".repeat(64); },
  (value) => { value.checkoutProof.artifactId = 99; },
  (value) => { value.checkoutProof.content += " "; },
  (value) => { value.selectedResults = []; },
  (value) => { value.selectedResults.push(value.selectedResults[0]); },
  (value) => { value.selectedResults[0].suiteId = "unselected"; },
  (value) => { value.authenticatedRunArtifactFacts.run.event = "pull_request"; },
  (value) => { value.authenticatedRunArtifactFacts.run.controlSha = "0".repeat(40); },
  (value) => { value.authenticatedRunArtifactFacts.checkout.parents.reverse(); },
  (value) => { value.authenticatedRunArtifactFacts.artifacts[0].jobs = []; },
  (value) => { value.authenticatedRunArtifactFacts.artifacts[0].jobs = [null]; },
  (value) => { value.authenticatedRunArtifactFacts.artifacts[0].jobs[0].head_sha = "0".repeat(40); },
  (value) => { value.authenticatedRunArtifactFacts.artifacts[0].jobs[0].run_id += 1; },
  (value) => { value.authenticatedRunArtifactFacts.artifacts[0].jobs[0].run_attempt += 1; },
  (value) => { value.authenticatedRunArtifactFacts.artifacts[0].jobs[0].conclusion = "skipped"; },
  (value) => { value.authenticatedRunArtifactFacts.artifacts[0].jobs[0].status = "in_progress"; },
  (value) => {
    const jobs = value.authenticatedRunArtifactFacts.artifacts[0].jobs;
    jobs.push({ ...jobs[0], id: jobs[0].id + 1 });
  },
  (value) => { value.trustedValidatorPolicy = undefined; },
  (value) => { value.trustedValidatorPolicy.inputClosureSha256 = "0".repeat(64); },
  (value) => { value.trustedValidatorPolicy.suites[0].inputClosureSha256 = "0".repeat(64); },
  (value) => { value.snapshot = { ...value.snapshot, mergeSha: "a".repeat(40) }; },
  (value) => { value.snapshot = { ...value.snapshot, baseSha: "a".repeat(40) }; },
]) {
  const input = fixture().input;
  mutate(input);
  assertRejected(input);
}

for (const modify of [
  (proof) => { proof.expectedSuiteIds = []; },
  (proof) => { proof.expectedSuiteIds.push(proof.expectedSuiteIds[0]); },
  (proof) => { proof.validator = { ...proof.validator, workflowBlobSha: "a".repeat(40) }; },
  (proof) => { proof.trustedValidatorPolicy = { suites: [] }; proof.expectedSuiteIds = []; },
]) {
  const { input, proof, bind } = fixture();
  modify(proof);
  input.checkoutProof = bind(13, proof);
  assertRejected(input);
}

for (const modify of [
  (suite) => { suite.conclusion = "skipped"; },
  (suite) => { suite.conclusion = "failure"; },
  (suite) => { suite.inputClosureSha256 = "0".repeat(64); },
  (suite) => { suite.suiteId = "unselected"; },
  (suite) => { suite.executionAttempt = 3; },
  (suite) => { suite.jobName = "source"; },
]) {
  const { input, proof, suite, bind } = fixture();
  modify(suite);
  input.selectedResults = [{ ...bind(13, proof), suiteId: suite.suiteId }];
  assertRejected(input, "INVALID_SUITE_RESULT");
}

const malformedProof = fixture().input;
malformedProof.checkoutProof.content = "{";
malformedProof.authenticatedRunArtifactFacts.artifacts[0].contentSha256 =
  crypto.createHash("sha256").update("{").digest("hex");
assertRejected(malformedProof, "MISSING_OR_UNBOUND_CHECKOUT_PROOF");

const reused = fixture();
const oldPull = pull();
oldPull.number = 62;
oldPull.head.sha = "b".repeat(40);
oldPull.base.sha = "e".repeat(40);
oldPull.merge_commit_sha = "c".repeat(40);
const oldProof = structuredClone(reused.proof);
oldProof.sourceSnapshot = sourceSnapshot(oldPull);
oldProof.checkout = {
  commitSha: oldPull.merge_commit_sha,
  treeSha: "d".repeat(40),
  parents: [oldPull.base.sha, oldPull.head.sha],
};
oldProof.validator.executingCommitSha = oldPull.base.sha;
oldProof.run = {
  ...oldProof.run,
  runId: 101,
  attempt: 1,
  headSha: oldPull.head.sha,
  controlSha: oldPull.base.sha,
};
oldProof.suites[0].executionAttempt = 1;
reused.input.selectedResults = [{ ...reused.bind(13, oldProof), suiteId: reused.suite.suiteId }];
const originalResult = reused.input.selectedResults[0].content;
assert.equal(evaluateQualityCandidate(reused.input).candidateMatch, true);
assert.equal(reused.input.selectedResults[0].content, originalResult);
reused.input.authenticatedRunArtifactFacts.artifacts.at(-1).checkout.parents[1] = "1".repeat(40);
assertRejected(reused.input);

const resumed = fixture();
resumed.suite.executionAttempt = 1;
resumed.input.checkoutProof = resumed.bind(13, resumed.proof);
resumed.input.selectedResults = [{ ...resumed.input.checkoutProof, suiteId: resumed.suite.suiteId }];
assert.equal(evaluateQualityCandidate(resumed.input).candidateMatch, true);

const bundled = fixture();
bundled.proof.suites.push({
  ...bundled.suite,
  suiteId: "runtime",
  jobId: 502,
  jobName: "quality (runtime)",
});
bundled.proof.expectedSuiteIds.push("runtime");
bundled.input.trustedValidatorPolicy.suites.push({
  suiteId: "runtime",
  jobName: "quality (runtime)",
  inputClosureSha256: bundled.suite.inputClosureSha256,
});
bundled.input.checkoutProof = bundled.bind(13, bundled.proof);
bundled.input.selectedResults = bundled.proof.suites.map((suite) => ({
  ...bundled.input.checkoutProof,
  suiteId: suite.suiteId,
}));
assert.equal(evaluateQualityCandidate(bundled.input).candidateMatch, true);
bundled.input.selectedResults[1].suiteId = bundled.suite.suiteId;
assertRejected(bundled.input, "MISSING_OR_DUPLICATED_RESULTS");

const noWork = fixture();
noWork.proof.expectedSuiteIds = [];
noWork.proof.suites = [];
noWork.input.trustedValidatorPolicy.suites = [];
noWork.input.selectedResults = [];
noWork.input.checkoutProof = noWork.bind(13, noWork.proof);
assertRejected(noWork.input, "INVALID_TRUSTED_POLICY");
noWork.input.trustedValidatorPolicy.noWork = true;
assertRejected(noWork.input, "SUITE_SELECTION_MISMATCH");
noWork.proof.noWork = true;
noWork.input.checkoutProof = noWork.bind(14, noWork.proof);
assert.equal(evaluateQualityCandidate(noWork.input).candidateMatch, true);

function producerFixture() {
  const { input } = fixture();
  return {
    source: {
      ...structuredClone(input.trustedValidatorPolicy),
      sourceSnapshot: structuredClone(input.snapshot),
      checkout: structuredClone(input.authenticatedRunArtifactFacts.checkout),
      run: structuredClone(input.authenticatedRunArtifactFacts.run),
    },
    run: { ...input.authenticatedRunArtifactFacts.run, status: "in_progress", conclusion: null },
    jobs: structuredClone(input.authenticatedRunArtifactFacts.artifacts[0].jobs),
  };
}

const producer = producerFixture();
const producerBefore = structuredClone(producer);
const manifest = createQualityManifest(producer);
assert.deepEqual(producer, producerBefore);
assert.deepEqual(manifest.suites, fixture().proof.suites);
const produced = fixture();
produced.input.checkoutProof = produced.bind(13, manifest);
produced.input.selectedResults = [{ ...produced.input.checkoutProof, suiteId: produced.suite.suiteId }];
assert.equal(evaluateQualityCandidate(produced.input).candidateMatch, true);

for (const mutate of [
  (value) => { value.jobs = []; },
  (value) => { value.jobs.push({ ...value.jobs[0], id: 600 }); },
  (value) => { value.jobs[0].conclusion = "failure"; },
  (value) => { value.jobs[0].conclusion = "skipped"; },
  (value) => { value.jobs[0].status = "in_progress"; },
  (value) => { value.jobs[0].run_id += 1; },
  (value) => { value.jobs[0].run_attempt += 1; },
  (value) => { value.jobs[0].head_sha = value.run.controlSha; },
  (value) => { value.run.controlSha = value.source.sourceSnapshot.headSha; },
  (value) => { value.run.event = "pull_request"; },
  (value) => { value.source.checkout.parents.reverse(); },
  (value) => { value.source.validator.executingRef = "refs/heads/feature"; },
  (value) => { value.source.suites[0].jobName = "source"; },
]) {
  const invalid = producerFixture();
  mutate(invalid);
  assert.throws(() => createQualityManifest(invalid), /selected job|trusted quality/);
}

const resumedProducer = producerFixture();
resumedProducer.source.run.attempt = 1;
resumedProducer.jobs[0].run_attempt = 1;
assert.equal(createQualityManifest(resumedProducer).suites[0].executionAttempt, 1);
resumedProducer.source.run.attempt = 2;
assert.throws(() => createQualityManifest(resumedProducer), /selected job/);

const retriedProducer = producerFixture();
retriedProducer.jobs.unshift({
  ...retriedProducer.jobs[0], id: 500, run_attempt: 1, conclusion: "failure",
});
assert.equal(createQualityManifest(retriedProducer).suites[0].executionAttempt, 2);
retriedProducer.jobs.reverse();
assert.equal(createQualityManifest(retriedProducer).suites[0].executionAttempt, 2);
retriedProducer.source.run.attempt = 1;
retriedProducer.jobs[0].conclusion = "failure";
retriedProducer.jobs[1].conclusion = "success";
assert.throws(() => createQualityManifest(retriedProducer), /selected job/);

const emptyProducer = producerFixture();
emptyProducer.source.suites = [];
emptyProducer.jobs = [];
assert.throws(() => createQualityManifest(emptyProducer), /trusted quality/);
emptyProducer.source.noWork = true;
assert.deepEqual(createQualityManifest(emptyProducer).suites, []);

const refreshed = producerFixture();
refreshed.source.sourceSnapshot.baseSha = "e".repeat(40);
refreshed.source.sourceSnapshot.mergeSha = "f".repeat(40);
refreshed.source.checkout.commitSha = refreshed.source.sourceSnapshot.mergeSha;
refreshed.source.checkout.parents[0] = refreshed.source.sourceSnapshot.baseSha;
refreshed.source.inputClosureSha256 = "a".repeat(64);
const refreshedManifest = createQualityManifest(refreshed);
assert.equal(refreshedManifest.validator.executingCommitSha, "2".repeat(40));
assert.equal(refreshedManifest.sourceSnapshot.baseSha, "e".repeat(40));
const refreshedEvidence = fixture();
refreshedEvidence.input.snapshot = refreshedManifest.sourceSnapshot;
refreshedEvidence.input.authenticatedRunArtifactFacts.checkout = refreshedManifest.checkout;
refreshedEvidence.input.trustedValidatorPolicy.inputClosureSha256 = refreshedManifest.inputClosureSha256;
refreshedEvidence.input.checkoutProof = refreshedEvidence.bind(13, refreshedManifest);
refreshedEvidence.input.selectedResults = [{
  ...refreshedEvidence.input.checkoutProof,
  suiteId: refreshedEvidence.suite.suiteId,
}];
assert.equal(evaluateQualityCandidate(refreshedEvidence.input).candidateMatch, true);

require("./test-quality-attestation.js");
console.log("pr_source_snapshot_tests=PASS");
