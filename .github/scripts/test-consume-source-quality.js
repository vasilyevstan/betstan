"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture } = require("./test-source-quality.js");
const { captureSource, captureCurrentSelection, planFullQuality, collectFullManifest } = require("./source-quality.js");
const { QualityEvidenceError, createQualityManifest, createFullQualityManifest } = require("./pr-source-snapshot.js");
const {
  consumeSourceQuality, authenticateOriginalManifest, consumeFullSourceQuality,
} = require("./consume-source-quality.js");

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
  await testHistoricalManifest();
  console.log("consume_source_quality_tests=PASS");
}

async function historicalFixture({ ref = "refs/heads/dev", event = "pull_request_target" } = {}) {
  const state = await signedFixture();
  state.options.context.sha = "8".repeat(40);
  state.options.context.ref = ref;
  state.options.context.eventName = event;
  state.native.event = event;
  if (event === "workflow_dispatch") {
    state.native.head_sha = state.options.context.sha;
    state.native.pull_requests = [];
    state.options.context.payload = { inputs: { pr_number: String(state.pull.number) } };
    state.artifact.workflow_run.head_sha = state.native.head_sha;
  }
  const inputs = require("./test-source-input-selection.js").fixture();
  const entries = inputs.records.map(({ path, mode, blobSha }) => ({ path, mode, type: "blob", sha: blobSha }));
  const baseEntries = structuredClone(entries);
  baseEntries.find((entry) => entry.path === "client/src/index.ts").sha = "0".repeat(40);
  const controlEntries = [];
  const baseTree = "e".repeat(40);
  const controlTree = "d".repeat(40);
  let truncated = false;
  state.options.github.rest.git.getCommit = async ({ commit_sha }) => {
    if (commit_sha === state.merge.sha) return { data: structuredClone(state.merge) };
    if (commit_sha === state.pull.base.sha) return { data: { sha: commit_sha, tree: { sha: baseTree } } };
    assert.equal(commit_sha, state.options.context.sha);
    return { data: { sha: commit_sha, tree: { sha: controlTree } } };
  };
  state.options.github.rest.git.getTree = async ({ tree_sha }) => {
    const tree = tree_sha === controlTree ? controlEntries
      : tree_sha === baseTree ? baseEntries : entries;
    assert.ok([controlTree, baseTree, state.merge.tree.sha].includes(tree_sha));
    return { data: { sha: tree_sha, truncated, tree: structuredClone(tree) } };
  };
  const source = await captureCurrentSelection(state.options, inputs.executionProfiles, (args) => {
    const output = state.git(args);
    if (args[0] === "ls-tree") {
      controlEntries.splice(0, controlEntries.length, ...output.split("\0").filter(Boolean).map((line) => {
        const [, mode, sha, path] = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
        return { path, mode, sha, type: "blob" };
      }));
    }
    return output;
  });
  state.jobs.splice(0, state.jobs.length, ...source.suites.map((suite, index) => ({
    id: 800 + index, name: suite.jobName, run_id: 102, run_attempt: 2,
    head_sha: state.native.head_sha, status: "completed", conclusion: "success",
  })));
  state.jobs.push({ ...state.jobs[0], id: 900, name: "source" });
  const manifest = createFullQualityManifest({ source, run: source.run, jobs: state.jobs });
  const approvedValidator = { ...source.validator, executingCommitSha: "f".repeat(40) };
  const comparison = {
    status: "ahead",
    base_commit: { sha: state.options.context.sha },
    merge_base_commit: { sha: state.options.context.sha },
  };
  state.options.github.rest.repos.compareCommitsWithBasehead = async ({ basehead }) => {
    assert.equal(basehead, `${state.options.context.sha}...${approvedValidator.executingCommitSha}`);
    return { data: structuredClone(comparison) };
  };
  state.pull.state = "closed";
  state.options.github.rest.pulls.get = async () => {
    assert.fail("Historical authentication must not read current or closed PR tips");
  };
  const input = {
    options: state.options, approvedValidator, artifactId: 701, runId: 102, attempt: 2,
    content: JSON.stringify(manifest),
  };
  const dependencies = {
    verify: async ({ content, expected, approveController }) => {
      assert.equal(expected.validator.executingCommitSha, undefined);
      assert.equal(await approveController({
        repository: "example/repo", repositoryId: 77,
        workflowPath: source.validator.workflowPath,
        controlSha: source.validator.executingCommitSha,
        sourceRef: source.validator.executingRef,
      }), true);
      return { contentSha256: crypto.createHash("sha256").update(content).digest("hex") };
    },
  };
  return {
    ...state, input, dependencies, manifest, controlEntries, comparison, source,
    executionProfiles: inputs.executionProfiles,
    truncate: () => { truncated = true; },
  };
}

async function testHistoricalManifest() {
  const valid = await historicalFixture();
  const result = await authenticateOriginalManifest(valid.input, valid.dependencies);
  assert.equal(result.artifactId, 701);
  assert.equal(result.manifest.schemaVersion, 2);
  assert.equal(result.run.controlSha, "8".repeat(40));
  for (const associations of [[], undefined, null]) {
    const closed = await historicalFixture();
    closed.native.pull_requests = associations;
    assert.equal((await authenticateOriginalManifest(closed.input, closed.dependencies)).artifactId, 701);
  }

  for (const mutate of [
    (value) => { value.artifact.expired = true; },
    (value) => { value.artifact.workflow_run.repository_id = 99; },
    (value) => { value.native.run_attempt = 3; },
    (value) => { value.native.workflow_id = 999; },
    (value) => { value.native.pull_requests = [{ number: 999 }]; },
    (value) => { value.native.pull_requests = {}; },
    (value) => { value.comparison.status = "diverged"; },
    (value) => { value.comparison.merge_base_commit.sha = "0".repeat(40); },
    (value) => { value.controlEntries[0].sha = "0".repeat(40); },
    (value) => { value.controlEntries[0].mode = "120000"; },
    (value) => { value.controlEntries.pop(); },
    (value) => { value.truncate(); },
    (value) => { value.manifest.purpose = "shadow-source-policy"; },
    (value) => { value.manifest.run.runId = 103; },
    (value) => { value.manifest.validator.executingCommitSha = "f".repeat(40); },
    (value) => { value.merge.tree.sha = "c".repeat(40); },
  ]) {
    const invalid = await historicalFixture();
    mutate(invalid);
    invalid.input.content = JSON.stringify(invalid.manifest);
    await assert.rejects(authenticateOriginalManifest(invalid.input, invalid.dependencies));
  }
  const changed = await historicalFixture();
  const verify = changed.dependencies.verify;
  changed.dependencies.verify = async (input) => {
    const signature = await verify(input);
    changed.native.run_attempt = 3;
    return signature;
  };
  await assert.rejects(authenticateOriginalManifest(changed.input, changed.dependencies), /identity mismatch/);

  async function currentFixture() {
    const value = await historicalFixture();
    value.pull.state = "open";
    value.options.github.rest.pulls.get = async () => ({ data: structuredClone(value.pull) });
    value.input.executionProfiles = value.executionProfiles;
    value.dependencies.git = value.git;
    return value;
  }
  const current = await currentFixture();
  const accepted = await consumeFullSourceQuality(current.input, current.dependencies);
  assert.equal(accepted.candidateMatch, true);
  assert.equal(accepted.authoritative, false);
  for (const mutate of [
    (value) => { value.manifest.selectionDigest = "0".repeat(64); },
    (value) => { value.manifest.expectedSuiteIds.pop(); value.manifest.results.pop(); },
    (value) => {
      value.manifest.expectedSuiteIds = ["source-policy"];
      value.manifest.results = value.manifest.results.filter((result) => result.suiteId === "source-policy");
    },
    (value) => { value.jobs[1].conclusion = "skipped"; },
    (value) => { value.jobs[value.jobs.length - 1].conclusion = "failure"; },
  ]) {
    const invalid = await currentFixture();
    mutate(invalid);
    invalid.input.content = JSON.stringify(invalid.manifest);
    await assert.rejects(consumeFullSourceQuality(invalid.input, invalid.dependencies));
  }
  const drift = await currentFixture();
  const initialVerify = drift.dependencies.verify;
  drift.dependencies.verify = async (input) => {
    const signature = await initialVerify(input);
    drift.pull.head.sha = "f".repeat(40);
    drift.merge.parents[1].sha = drift.pull.head.sha;
    drift.manifest.checkout.parents[1] = drift.pull.head.sha;
    return signature;
  };
  await assert.rejects(consumeFullSourceQuality(drift.input, drift.dependencies));

  async function planningFixture() {
    const value = await currentFixture();
    const getRun = value.options.github.rest.actions.getWorkflowRun;
    const getCommit = value.options.github.rest.git.getCommit;
    const merge = { ...structuredClone(value.merge), sha: "c".repeat(40) };
    value.pull.number = 64;
    value.pull.merge_commit_sha = merge.sha;
    const currentRun = {
      ...structuredClone(value.native), id: 303, run_attempt: 1,
      status: "in_progress", conclusion: null, pull_requests: [{ number: 64 }],
    };
    value.options.context.runId = 303;
    value.options.context.payload.pull_request.number = 64;
    value.options.attempt = 1;
    value.options.github.rest.actions.getWorkflowRun = async (args) =>
      args.run_id === 303 ? { data: structuredClone(currentRun) } : getRun(args);
    value.options.github.rest.git.getCommit = async (args) =>
      args.commit_sha === merge.sha ? { data: structuredClone(merge) } : getCommit(args);
    value.options.github.rest.actions.listWorkflowRuns = async ({ per_page, page, status }) => {
      assert.equal(per_page, 5);
      assert.equal(page, 1);
      assert.equal(status, "success");
      return { data: { workflow_runs: [structuredClone(value.native)] } };
    };
    value.options.github.rest.actions.listWorkflowRunArtifacts = async ({ run_id }) => {
      assert.equal(run_id, 102);
      return { data: { total_count: 1, artifacts: [structuredClone(value.artifact)] } };
    };
    const misses = [];
    value.dependencies.readArtifact = async ({ artifactId }) => {
      assert.equal(artifactId, 701);
      return value.input.content;
    };
    value.dependencies.onReuseMiss = (message) => misses.push(message);
    return { ...value, misses, currentRun };
  }
  const reuse = await planningFixture();
  const plan = await planFullQuality(reuse.options, reuse.executionProfiles, reuse.dependencies);
  assert.equal(plan.reusedResults.length, 1);
  assert.equal(plan.reusedResults[0].evidence.runId, 102);
  assert.equal(plan.reusedResults[0].evidence.originalJobId, 800);
  assert.equal(plan.matrix.include.some((suite) => suite.suiteId === "source-policy"), false);
  assert.equal(plan.matrix.include.length, plan.suites.length - 1);
  assert.deepEqual(reuse.misses, []);
  reuse.native.pull_requests = [];
  const paginate = reuse.options.github.paginate;
  const currentJobs = plan.matrix.include.map((suite, index) => ({
    id: 1000 + index, name: suite.jobName, run_id: 303, run_attempt: 1,
    head_sha: plan.run.headSha, status: "completed", conclusion: "success",
  }));
  currentJobs.push({ ...currentJobs[0], id: 1100, name: "source" });
  reuse.options.github.paginate = async (method, args) => {
    if (args.run_id === 303) {
      assert.equal(args.filter, "all");
      return structuredClone(currentJobs);
    }
    return paginate(method, args);
  };
  const aggregate = await collectFullManifest(reuse.options, plan, reuse.dependencies);
  assert.equal(aggregate.results.find((result) => result.suiteId === "source-policy").evidence.kind, "REUSED");
  assert.equal(aggregate.results.filter((result) => result.evidence.kind === "EXECUTED").length, plan.matrix.include.length);
  reuse.currentRun.status = "completed";
  reuse.currentRun.conclusion = "success";
  const getArtifact = reuse.options.github.rest.actions.getArtifact;
  reuse.options.github.rest.actions.getArtifact = (args) => args.artifact_id === 702 ? {
    data: {
      ...reuse.artifact, id: 702, name: "quality-manifest-303-1",
      workflow_run: { ...reuse.artifact.workflow_run, id: 303 },
    },
  } : getArtifact(args);
  const currentProof = {
    options: reuse.options, artifactId: 702, content: JSON.stringify(aggregate),
  };
  assert.equal((await consumeFullSourceQuality(currentProof, reuse.dependencies)).candidateMatch, true);
  reuse.native.pull_requests = [{ number: 999 }];
  await assert.rejects(consumeFullSourceQuality(currentProof, reuse.dependencies), /approved native control/);
  reuse.native.pull_requests = [];
  reuse.currentRun.status = "in_progress";
  reuse.currentRun.conclusion = null;
  const changedPlan = structuredClone(plan);
  changedPlan.selectionDigest = "0".repeat(64);
  await assert.rejects(collectFullManifest(reuse.options, changedPlan, reuse.dependencies), /changed before aggregation/);
  currentJobs[0].conclusion = "skipped";
  await assert.rejects(collectFullManifest(reuse.options, plan, reuse.dependencies), /selected job/);
  currentJobs[0].conclusion = "success";
  reuse.artifact.expired = true;
  await assert.rejects(collectFullManifest(reuse.options, plan, reuse.dependencies), /identity mismatch/);
  reuse.artifact.expired = false;

  for (const mutate of [
    (value) => { value.executionProfiles["node-policy"].identity = "0".repeat(64); },
    (value) => { value.controlEntries[0].sha = "0".repeat(40); },
    (value) => { value.dependencies.verify = async () => { throw new QualityEvidenceError("signature rejected"); }; },
    (value) => { value.input.content = "{"; },
    (value) => {
      value.options.github.rest.actions.listWorkflowRunArtifacts = async () =>
        ({ data: { total_count: 0, artifacts: [] } });
    },
  ]) {
    const missed = await planningFixture();
    mutate(missed);
    const fresh = await planFullQuality(missed.options, missed.executionProfiles, missed.dependencies);
    assert.deepEqual(fresh.reusedResults, []);
    assert.equal(fresh.matrix.include.length, fresh.suites.length);
    assert.ok(missed.misses.length > 0);
  }
  const unknownFailure = await planningFixture();
  unknownFailure.dependencies.verify = async () => { throw new TypeError("verifier implementation bug"); };
  await assert.rejects(planFullQuality(
    unknownFailure.options, unknownFailure.executionProfiles, unknownFailure.dependencies,
  ), TypeError);

  const mutable = await planningFixture();
  mutable.executionProfiles["node-policy"].immutable = false;
  mutable.options.github.rest.actions.listWorkflowRuns = async () => assert.fail("no eligible reuse means no cache query");
  assert.deepEqual((await planFullQuality(mutable.options, mutable.executionProfiles, mutable.dependencies)).reusedResults, []);

  const hinted = await planningFixture();
  hinted.options.github.rest.actions.listWorkflowRuns = async () => ({
    data: { workflow_runs: [{ ...hinted.native, id: 104, run_attempt: 1 }] },
  });
  hinted.options.github.rest.actions.listWorkflowRunArtifacts = async () => ({
    data: { total_count: 1, artifacts: [{ id: 702, name: "quality-manifest-104-1", expired: false }] },
  });
  const hint = structuredClone(hinted.manifest);
  hint.results.find((result) => result.suiteId === "source-policy").evidence = {
    kind: "REUSED", repository: "example/repo", runId: 102, attempt: 2, artifactId: 701,
  };
  hinted.dependencies.readArtifact = async ({ artifactId }) =>
    artifactId === 702 ? JSON.stringify(hint) : hinted.input.content;
  const flattened = await planFullQuality(hinted.options, hinted.executionProfiles, hinted.dependencies);
  assert.equal(flattened.reusedResults[0].evidence.runId, 102);
  assert.equal(flattened.reusedResults[0].evidence.artifactId, 701);
}

if (require.main === module) {
  testConsumeSourceQuality().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = testConsumeSourceQuality;
module.exports.historicalFixture = historicalFixture;
