"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture } = require("./test-source-quality.js");
const { captureSource } = require("./source-quality.js");
const { createQualityManifest } = require("./pr-source-snapshot.js");
const { consumeSourceQuality } = require("./consume-source-quality.js");

async function signedFixture(captureAttempt = 2) {
  const state = fixture();
  state.native.status = "completed";
  state.native.conclusion = "success";
  state.jobs[0].run_attempt = captureAttempt;
  state.jobs.push({
    ...state.jobs[0], id: 502, name: "source",
  });
  const source = await captureSource(state.options, state.git);
  const document = {
    ...createQualityManifest({
      source: { ...source, run: { ...source.run, attempt: captureAttempt } },
      run: source.run,
      jobs: state.jobs,
    }),
    purpose: "shadow-source-policy",
  };
  const artifact = {
    id: 701, name: "quality-manifest-102-2", expired: false,
    workflow_run: { id: 102, repository_id: 77, head_sha: state.native.head_sha },
  };
  state.options.github.rest.repos = {
    get: async () => ({ data: { id: 77, full_name: "example/repo" } }),
  };
  state.options.github.rest.actions.getArtifact = async ({ artifact_id }) => {
    assert.equal(artifact_id, artifact.id);
    return { data: structuredClone(artifact) };
  };
  const input = { options: state.options, artifactId: 701, content: JSON.stringify(document) + "\n" };
  const dependencies = {
    git: state.git,
    verify: ({ content, expected }) => {
      assert.equal(content, input.content);
      assert.deepEqual(expected, {
        repository: "example/repo", repositoryId: 77, runId: 102,
        attempt: 2, event: "pull_request_target", validator: source.validator,
      });
      return { contentSha256: crypto.createHash("sha256").update(content).digest("hex") };
    },
  };
  return { ...state, artifact, document, input, dependencies };
}

async function testConsumeSourceQuality() {
  const valid = await signedFixture();
  const result = await consumeSourceQuality(valid.input, valid.dependencies);
  assert.equal(result.candidateMatch, true);
  assert.equal(result.authoritative, false);
  assert.equal(result.artifactId, 701);
  assert.equal(result.runId, 102);

  for (const mutate of [
    (state) => { state.artifact.expired = true; },
    (state) => { state.artifact.workflow_run.id = 999; },
    (state) => { state.artifact.workflow_run.repository_id = 99; },
    (state) => { state.artifact.workflow_run.head_sha = "f".repeat(40); },
    (state) => { state.artifact.name = "quality-manifest-102-1"; },
    (state) => { state.native.status = "in_progress"; },
    (state) => { state.native.conclusion = "failure"; },
    (state) => { state.native.run_attempt = 3; },
    (state) => { state.jobs.splice(1, 1); },
    (state) => { state.jobs[1].conclusion = "failure"; },
    (state) => { state.jobs.push({ ...state.jobs[1], id: 503 }); },
  ]) {
    const invalid = await signedFixture();
    mutate(invalid);
    await assert.rejects(consumeSourceQuality(invalid.input, invalid.dependencies));
  }

  const unsigned = await signedFixture();
  unsigned.dependencies.verify = () => { throw new Error("invalid native signature"); };
  await assert.rejects(consumeSourceQuality(unsigned.input, unsigned.dependencies), /invalid native signature/);

  for (const mutate of [
    (document) => { document.purpose = "authoritative"; },
    (document) => { document.sourceSnapshot.headSha = "f".repeat(40); },
    (document) => { document.suites[0].jobId = 999; },
    (document) => { document.inputClosureSha256 = "0".repeat(64); },
  ]) {
    const inconsistent = await signedFixture();
    mutate(inconsistent.document);
    inconsistent.input.content = JSON.stringify(inconsistent.document);
    await assert.rejects(consumeSourceQuality(inconsistent.input, inconsistent.dependencies));
  }

  const resumed = await signedFixture(1);
  assert.equal((await consumeSourceQuality(resumed.input, resumed.dependencies)).candidateMatch, true);
  resumed.jobs[1].run_attempt = 2;
  await assert.rejects(consumeSourceQuality(resumed.input, resumed.dependencies), /selected job/);

  const newerFailure = await signedFixture(1);
  newerFailure.jobs.push({ ...newerFailure.jobs[0], id: 504, run_attempt: 2, conclusion: "failure" });
  await assert.rejects(consumeSourceQuality(newerFailure.input, newerFailure.dependencies), /selected job/);

  const advanced = await signedFixture();
  const verify = advanced.dependencies.verify;
  advanced.dependencies.verify = (input) => {
    const signature = verify(input);
    advanced.pull.head.sha = "a".repeat(40);
    advanced.pull.merge_commit_sha = "b".repeat(40);
    advanced.merge.sha = advanced.pull.merge_commit_sha;
    advanced.merge.parents[1].sha = advanced.pull.head.sha;
    return signature;
  };
  await assert.rejects(consumeSourceQuality(advanced.input, advanced.dependencies), /changed during shadow verification/);

  const metadataOnly = await signedFixture();
  const verifyMetadata = metadataOnly.dependencies.verify;
  metadataOnly.dependencies.verify = (input) => {
    metadataOnly.pull.title = "Presentation changes do not invalidate source";
    metadataOnly.pull.body = "Updated explanation";
    metadataOnly.pull.labels = [{ name: "feature:quality" }];
    return verifyMetadata(input);
  };
  assert.equal((await consumeSourceQuality(metadataOnly.input, metadataOnly.dependencies)).candidateMatch, true);
  console.log("consume_source_quality_tests=PASS");
}

if (require.main === module) {
  testConsumeSourceQuality().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = testConsumeSourceQuality;
