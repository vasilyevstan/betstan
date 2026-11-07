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

async function testNativeDispatchOriginals() {
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const { execFileSync } = require("node:child_process");
  const {
    DISPATCH_CONTROL_PATHS, DISPATCH_CALLER_BLOBS, captureNativeDispatchSource,
    collectNativeDispatchOriginal, assertDispatchProfile, captureDispatchProfile,
  } = require("./source-quality.js");
  const { sourceSnapshot } = require("./pr-source-snapshot.js");
  const {
    nativeDispatchPolicy, authenticateNativeDispatchOriginal, selectNativeDispatchOriginal,
  } = require("./consume-source-quality.js");

  function fixture(event = "pull_request") {
    const sha = (n) => String(n).repeat(40);
    const profile = {
      supported: true, profile: "github-hosted-ubuntu24-dispatch-v1",
      imageVersion: "20261103.1.0", kernel: "6.11.0-1018-azure", nodeVersion: "v24.11.1",
      nodeSha256: "a".repeat(64), toolsSha256: "b".repeat(64), packagesSha256: "c".repeat(64),
      locale: { LANG: "en_US.UTF-8", LC_ALL: "", TZ: "" },
    };
    const pull = (number, head, base, merge, baseRef) => ({
      number, state: "open", mergeable: true, merge_commit_sha: merge,
      head: { ref: "feature", sha: head, repo: { full_name: "example/repo" } },
      base: { ref: baseRef, sha: base, repo: { full_name: "example/repo" } },
    });
    const originalPull = pull(63, sha(1), sha(2), sha(3), "dev");
    const currentPull = pull(64, sha(6), sha(7), sha(5), "master");
    const context = {
      repo: { owner: "example", repo: "repo" }, runId: 303, sha: sha(5),
      eventName: event, ref: event === "push" ? "refs/heads/master" : "refs/pull/64/merge",
      payload: { pull_request: { number: 64 }, before: sha(9), after: sha(5), forced: false,
        deleted: false, ref: event === "push" ? "refs/heads/master" : "refs/pull/64/merge",
        repository: { id: 77, full_name: "example/repo" } },
    };
    const originalRun = {
      id: 101, run_attempt: 1, workflow_id: 202, path: ".github/workflows/oci-validate.yml",
      event: "pull_request", head_sha: sha(1), status: "completed", conclusion: "success",
      repository: { id: 77, full_name: "example/repo" }, pull_requests: [{ number: 63 }],
    };
    const currentRun = {
      ...structuredClone(originalRun), id: 303, event, head_sha: event === "push" ? sha(5) : sha(6),
      path: event === "push" ? ".github/workflows/production-build.yml" : originalRun.path,
      status: "in_progress", conclusion: null, pull_requests: [{ number: 64 }],
    };
    const commits = {
      [sha(3)]: { sha: sha(3), tree: { sha: sha(4) }, parents: [{ sha: sha(2) }, { sha: sha(1) }] },
      [sha(5)]: { sha: sha(5), tree: { sha: sha(4) },
        parents: event === "push" ? [{ sha: sha(9) }] : [{ sha: sha(7) }, { sha: sha(6) }] },
      [sha(9)]: { sha: sha(9), tree: { sha: sha(8) }, parents: [] },
    };
    const records = DISPATCH_CONTROL_PATHS.map((file, index) => {
      const bytes = fs.readFileSync(path.resolve(__dirname, "../..", file));
      return {
        path: file, mode: "100644", type: "blob",
        sha: file.startsWith(".github/scripts/")
          ? crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
          : (index + 10).toString(16).padStart(40, "0"),
      };
    });
    for (const [file, blobs] of Object.entries(DISPATCH_CALLER_BLOBS)) {
      records.push({ path: file, mode: "100644", type: "blob", sha: blobs.at(-1) });
    }
    const approvedRecords = structuredClone(records);
    // Test input differs from protected master, but planner/signer/runner control
    // is identical. Whole candidate trees, NOT protected infra trees, are tested.
    records.push({ path: "infra/azure/agents/test-copilot-cli-dispatch-stan.sh", mode: "100755", type: "blob", sha: sha("a") });
    approvedRecords.push({ ...records.at(-1), sha: sha("b") });
    const branch = { protected: true, commit: { sha: event === "push" ? sha(5) : sha(9) } };
    const source = {
      repository: "example/repo", repositoryId: 77, runId: 101, attempt: 1,
      workflowId: 202, workflowPath: originalRun.path, event: "pull_request", ref: "refs/pull/63/merge",
      headSha: sha(1), commit: { sha: sha(3), treeSha: sha(4), parents: [sha(2), sha(1)] },
      snapshot: structuredClone(sourceSnapshot(originalPull)),
    };
    const names = ["oci-scope", "oci-workflow-syntax", "oci-validate",
      ...["core", "live", "provenance", "rollback", "governance", "dispatch"].map((item) => `oci-full-contracts (${item})`),
      "oci-focused-contracts", "oci-dispatch-original"];
    const step = (name, number, conclusion = "success") => ({
      name, number, status: "completed", conclusion,
      started_at: `2026-11-03T00:0${number}:00Z`, completed_at: `2026-11-03T00:0${number}:30Z`,
    });
    const jobs = names.map((name, index) => ({
      name, id: 500 + index, run_id: 101, run_attempt: 1, head_sha: sha(1),
      status: "completed", conclusion: name === "oci-focused-contracts" ? "skipped" : "success", steps: [],
    }));
    jobs[8].steps = [
      step("Capture dispatch worker before candidate tests", 1),
      step("Execute original dispatch assertions", 2),
      step("Record selected-out dispatch", 3, "skipped"),
      step("Record authenticated dispatch reuse", 4, "skipped"),
    ];
    jobs[10].steps = [
      step("Reconstruct original from native jobs", 1), step("Attest dispatch original", 2),
      step("Upload dispatch original", 3), step("Confirm original publication", 4),
    ];
    const manifest = {
      schemaVersion: 1, purpose: "native-dispatch-original", suiteId: "cli-dispatch",
      source, profile: structuredClone(profile), execution: { jobId: jobs[8].id, kind: "EXECUTED" },
    };
    const artifact = {
      id: 701, name: "dispatch-original-101-1", expired: false,
      workflow_run: { id: 101, repository_id: 77, head_sha: sha(1) },
    };
    const recent = { workflow_runs: [structuredClone(originalRun)] };
    const inventory = { total_count: 1, artifacts: [artifact] };
    const github = {
      rest: {
        actions: {
          getWorkflowRun: async ({ run_id }) => ({ data: structuredClone(run_id === 303 ? currentRun : originalRun) }),
          getWorkflow: async () => ({ data: { id: 202, path: originalRun.path, state: "active" } }),
          getArtifact: async () => ({ data: structuredClone(artifact) }),
          listWorkflowRuns: async () => ({ data: structuredClone(recent) }),
          listWorkflowRunArtifacts: async () => ({ data: structuredClone(inventory) }),
          listJobsForWorkflowRun() { assert.fail("complete pagination required"); },
        },
        pulls: { get: async ({ pull_number }) => ({ data: structuredClone(pull_number === 64 ? currentPull : originalPull) }) },
        repos: { getBranch: async () => ({ data: structuredClone(branch) }) },
        git: {
          getCommit: async ({ commit_sha }) => ({ data: structuredClone(commits[commit_sha]) }),
          getTree: async ({ tree_sha }) => ({
            data: { sha: tree_sha, truncated: false, tree: structuredClone(tree_sha === sha(8) ? approvedRecords : records) },
          }),
        },
      },
      paginate: async (_method, input) => {
        assert.equal(input.run_id, 101);
        assert.equal(input.filter, "all");
        return structuredClone(jobs);
      },
    };
    const options = { github, context, attempt: 1 };
    const dependencies = {
      git: () => context.sha,
      readArtifact: async () => JSON.stringify(manifest),
      verify: async ({ content, expected }) => {
        assert.equal(expected.runId, 101);
        return {
          signerSha: sha(3), callerSha: sha(3), sourceSha: sha(3), sourceRef: "refs/pull/63/merge",
          contentSha256: crypto.createHash("sha256").update(content).digest("hex"),
        };
      },
      onMiss() {},
    };
    return {
      options, dependencies, originalRun, currentRun, originalPull, currentPull, manifest, artifact,
      recent, inventory, jobs, records, approvedRecords, commits, branch, profile, source,
    };
  }
  const select = (value) => selectNativeDispatchOriginal(value.options, value.profile, value.dependencies);
  for (const event of ["pull_request", "push"]) {
    const value = fixture(event);
    const result = await select(value);
    assert.equal(result.kind, "REUSED");
    assert.equal(result.runId, 101, "promotion and master must reference the first execution directly");
    assert.notEqual(result.originalCommitSha, value.originalRun.head_sha, "certified merge is not REST head");
    assert.equal(result.testedTreeSha, value.manifest.source.commit.treeSha);
    value.originalRun.pull_requests = [structuredClone(value.originalPull)];
    value.currentRun.pull_requests = [structuredClone(value.currentPull)];
    assert.equal((await select(value)).runId, 101, "consistent nonempty native associations remain supported");
    // Real merged PR run 42005902131 exposes [] here. This metadata shape
    // does not turn that unsigned historical run into eligible evidence.
    value.originalRun.pull_requests = [];
    value.currentRun.pull_requests = [];
    assert.equal((await select(value)).runId, 101);
  }
  const afterPromotion = fixture("push");
  afterPromotion.recent.workflow_runs.unshift({ ...afterPromotion.originalRun, id: 304 });
  assert.equal((await select(afterPromotion)).runId, 101, "a promotion without an original artifact is not a copy-chain");
  for (const mutate of [
    (f) => { f.options.context.payload.before = "0".repeat(40); },
    (f) => { delete f.options.context.payload.before; },
    (f) => { f.options.context.payload.after = "0".repeat(40); },
    (f) => { f.options.context.payload.forced = true; },
    (f) => { f.commits["5".repeat(40)].parents[0].sha = "7".repeat(40); },
    (f) => { f.records.find((row) => row.path.endsWith("/consume-source-quality.js")).sha = "0".repeat(40); },
  ]) {
    const changed = fixture("push");
    mutate(changed);
    assert.equal((await select(changed)).kind, "EXECUTE", mutate.toString());
  }
  const counterexample = fixture();
  counterexample.recent.workflow_runs = [];
  // HEAD and its second parent may already have the same complete tree. That
  // topology supplies no execution and must not bypass original authentication.
  counterexample.commits["6".repeat(40)] = {
    sha: "6".repeat(40), tree: { sha: "4".repeat(40) }, parents: [],
  };
  assert.equal((await select(counterexample)).kind, "EXECUTE");

  for (const mutate of [
    (f) => { f.originalRun.conclusion = "failure"; },
    (f) => { f.originalRun.conclusion = "cancelled"; },
    (f) => { f.originalRun.status = "in_progress"; },
    (f) => { f.originalRun.run_attempt = 2; },
    (f) => { f.originalRun.repository.id = 78; },
    (f) => { f.originalRun.workflow_id = 203; },
    (f) => { f.originalRun.path = ".github/workflows/reusable-signer.yml"; },
    (f) => { f.originalRun.pull_requests = []; f.originalRun.head_sha = "3".repeat(40); },
    (f) => { f.originalRun.pull_requests = [{ number: 999 }]; },
    (f) => { f.originalRun.pull_requests.push({ number: 999 }); },
    (f) => { f.originalRun.pull_requests[0].head = { sha: "0".repeat(40) }; },
    (f) => { f.originalRun.pull_requests[0].base = { sha: "0".repeat(40) }; },
    (f) => { f.originalRun.pull_requests[0].head = { repo: { id: 78 } }; },
    (f) => { f.originalRun.pull_requests = {}; },
    (f) => { f.currentRun.pull_requests = [{ number: 999 }]; },
    (f) => { f.currentRun.pull_requests[0].head = { sha: "0".repeat(40) }; },
    (f) => { f.currentRun.pull_requests = []; f.currentPull.number = 999; },
    (f) => { f.currentRun.pull_requests = []; f.currentRun.head_sha = "0".repeat(40); },
    (f) => {
      f.originalRun.pull_requests = [];
      const verify = f.dependencies.verify;
      f.dependencies.verify = async (input) => ({ ...await verify(input), sourceRef: "refs/pull/999/merge" });
    },
    (f) => { f.recent.workflow_runs[0].id = 303; },
    (f) => { f.artifact.expired = true; },
    (f) => { f.artifact.name = "dispatch-observation-101-1"; },
    (f) => { f.artifact.workflow_run.repository_id = 78; },
    (f) => { f.artifact.workflow_run.head_sha = "3".repeat(40); },
    (f) => { f.inventory.total_count = 101; },
    (f) => { f.inventory.artifacts = []; f.inventory.total_count = 0; },
    (f) => { f.inventory.artifacts.push(structuredClone(f.artifact)); f.inventory.total_count = 2; },
    (f) => { f.dependencies.readArtifact = async () => "{"; },
    (f) => { f.dependencies.readArtifact = async () => "null"; },
    (f) => { f.dependencies.readArtifact = async () => "x".repeat(1024 * 1024 + 1); },
    (f) => { f.dependencies.verify = async () => { throw new QualityEvidenceError("unsigned/substituted artifact"); }; },
    (f) => { f.manifest.execution.kind = "REUSED"; },
    (f) => { f.manifest.purpose = "native-dispatch-observation"; },
    (f) => { f.manifest.execution.jobId = 999; },
    (f) => { f.manifest.suiteId = "rollback"; },
    (f) => { f.manifest.profile.kernel = "different-kernel"; },
    (f) => { f.profile.supported = false; },
    (f) => { f.manifest.source.commit.treeSha = "0".repeat(40); },
    (f) => { f.manifest.source.snapshot.baseSha = "0".repeat(40); },
    (f) => { f.originalRun.pull_requests = []; f.commits["3".repeat(40)].parents.reverse(); },
    (f) => { f.commits["5".repeat(40)].tree.sha = "a".repeat(40); },
    (f) => { f.records[0].sha = "0".repeat(40); },
    (f) => { f.records.find((row) => row.path === ".github/workflows/oci-validate.yml").sha = "0".repeat(40); },
    (f) => {
      f.records.find((row) => row.path === ".github/workflows/oci-validate.yml").sha =
        DISPATCH_CALLER_BLOBS[".github/workflows/oci-validate.yml"][0];
    },
    (f) => { f.jobs.push(structuredClone(f.jobs[0])); },
    (f) => { f.jobs.pop(); },
    (f) => { f.jobs[8] = null; },
    (f) => { f.jobs[8].run_attempt = 2; },
    (f) => { f.jobs[8].steps[1].conclusion = "skipped"; },
    (f) => { f.jobs[8].steps[2].conclusion = "success"; },
    (f) => { f.jobs[8].steps[3].conclusion = "success"; },
    (f) => { f.jobs[8].steps[0].completed_at = "2026-11-03T00:09:00Z"; },
    (f) => { f.jobs[10].steps[3].conclusion = "skipped"; },
    (f) => { f.options.github.rest.actions.listWorkflowRuns = async () => { throw Object.assign(new Error("Actions read unavailable"), { status: 403 }); }; },
    (f) => {
      const verify = f.dependencies.verify;
      f.dependencies.verify = async (input) => { f.currentPull.head.sha = "0".repeat(40); return verify(input); };
    },
    (f) => {
      const verify = f.dependencies.verify;
      f.dependencies.verify = async (input) => { f.originalRun.run_attempt = 2; return verify(input); };
    },
    (f) => {
      const verify = f.dependencies.verify;
      f.dependencies.verify = async (input) => { f.approvedRecords[0].sha = "0".repeat(40); return verify(input); };
    },
  ]) {
    const invalid = fixture();
    mutate(invalid);
    const result = await select(invalid);
    assert.equal(result.kind, "EXECUTE", mutate.toString());
    assert.ok(result.reasons.length > 0);
  }
  const bug = fixture();
  bug.dependencies.verify = async () => { throw new TypeError("verifier bug"); };
  await assert.rejects(select(bug), TypeError);
  const direct = fixture();
  const current = await captureNativeDispatchSource(direct.options, direct.dependencies.git);
  const policy = await nativeDispatchPolicy(direct.options);
  await assert.rejects(authenticateNativeDispatchOriginal({
    options: direct.options, current, policy, profile: direct.profile,
    runId: 303, artifactId: 701, content: JSON.stringify(direct.manifest),
  }, direct.dependencies), /self-referential/);

  const computed = fixture();
  computed.options.context = {
    ...computed.options.context, runId: 101, sha: "3".repeat(40), ref: "refs/pull/63/merge",
    payload: { pull_request: { number: 63 } },
  };
  computed.jobs[10].status = "in_progress";
  computed.jobs[10].conclusion = null;
  const worker = { source: computed.source, profile: computed.profile, selected: true, controlApproved: true };
  const collectOptions = { git: () => "3".repeat(40), observationOnly: false };
  const original = await collectNativeDispatchOriginal(computed.options, worker, collectOptions);
  assert.deepEqual(original, computed.manifest);
  const observation = await collectNativeDispatchOriginal(computed.options, worker, { git: () => "3".repeat(40) });
  assert.equal(observation.purpose, "native-dispatch-observation", "unqualified collection defaults to observation only");
  const originalControl = computed.records[0].sha;
  computed.records[0].sha = "0".repeat(40);
  await assert.rejects(collectNativeDispatchOriginal(computed.options, worker, collectOptions), /Unapproved candidate control/);
  computed.records[0].sha = originalControl;
  worker.selected = false;
  await assert.rejects(collectNativeDispatchOriginal(computed.options, worker, { git: () => "3".repeat(40) }), /pre-test execution worker/);
  worker.selected = true;
  worker.controlApproved = false;
  assert.equal((await collectNativeDispatchOriginal(computed.options, worker,
    { git: () => "3".repeat(40) })).purpose, "native-dispatch-observation");
  await assert.rejects(collectNativeDispatchOriginal(computed.options, worker, collectOptions), /pre-test execution worker/);
  assert.throws(() => assertDispatchProfile({ supported: true }), /incomplete/);
  assert.equal(captureDispatchProfile({}).supported, false);
  const host = Object.fromEntries(["platform", "arch"].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]));
  try {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    const env = { ImageOS: "ubuntu24", ImageVersion: "20261103.1.0" };
    const unavailable = captureDispatchProfile(env, () => { throw Object.assign(new Error("missing probe"), { status: 127 }); });
    assert.equal(unavailable.supported, false);
    assert.match(unavailable.reason, /bash failed \(127\)/);
    assert.throws(() => assertDispatchProfile(unavailable), /bash failed \(127\)/);
    assert.throws(() => captureDispatchProfile(env, () => { throw new TypeError("probe bug"); }), TypeError);
  } finally {
    for (const [key, descriptor] of Object.entries(host)) Object.defineProperty(process, key, descriptor);
  }

  const root = path.resolve(__dirname, "../..");
  const loadWorkflow = (file) => JSON.parse(execFileSync("ruby", ["-rjson", "-ryaml", "-e",
    "puts JSON.generate(YAML.load_file(ARGV[0]))", path.join(root, file)], { encoding: "utf8" }));
  const oci = loadWorkflow(".github/workflows/oci-validate.yml");
  const jobs = oci.jobs;
  assert.ok(["disabled", "enabled"].includes(oci.env.NATIVE_DISPATCH_REUSE),
    "only the frozen observational or separately qualified adoption caller is supported");
  assert.equal(jobs["dispatch-original"]["continue-on-error"], true);
  for (const id of ["protected-checkout", "protected-copy", "checkout", "collect", "attest", "upload"]) {
    assert.equal(jobs["dispatch-original"].steps.find((step) => step.id === id)["continue-on-error"], true);
  }
  const collectStep = jobs["dispatch-original"].steps.find((step) => step.id === "collect");
  const collectAllowed = new Function("steps", "env", `return (${collectStep.if.replaceAll("steps.protected-copy", "steps.protectedCopy")});`);
  assert.equal(collectAllowed({ checkout: { outcome: "success" }, protectedCopy: { outcome: "failure" } },
    { NATIVE_DISPATCH_REUSE: "enabled" }), false);
  assert.equal(collectAllowed({ checkout: { outcome: "success" }, protectedCopy: { outcome: "skipped" } },
    { NATIVE_DISPATCH_REUSE: "disabled" }), true);
  assert.equal(jobs["dispatch-original"].steps.find((step) => step.id === "attest").if, "steps.collect.outcome == 'success'");
  assert.ok(!jobs["offline-contract"].needs.includes("dispatch-original"));
  assert.ok(jobs["dispatch-original"].needs.includes("offline-contract"));
  const publisherCondition = jobs["dispatch-original"].if;
  assert.match(publisherCondition, /^\$\{\{\s*!cancelled\(\)/,
    "publication needs an explicit status function, not implicit success() across skipped ancestors");
  // This checks the actual predicate, not GitHub's scheduler or implicit success().
  const publisherAllowed = new Function("needs", "cancelled", `return (${publisherCondition.slice(3, -2)
    .replaceAll("needs.offline-contract", "needs['offline-contract']")
    .replaceAll("needs.dispatch-contracts", "needs['dispatch-contracts']")});`);
  const fullGraph = {
    scope: { result: "success" }, syntax: { result: "success" },
    "focused-contracts": { result: "skipped" }, "full-contracts": { result: "success" },
    "dispatch-contracts": { result: "success", outputs: { execution_kind: "EXECUTED" } },
    "offline-contract": { result: "success" },
  };
  const publisherNeeds = Object.fromEntries(jobs["dispatch-original"].needs.map((id) => [id, fullGraph[id]]));
  assert.ok(jobs["offline-contract"].needs.includes("focused-contracts"));
  assert.equal(publisherAllowed(publisherNeeds, () => false), true,
    "the full graph with its intentionally skipped focused ancestor remains eligible");
  assert.equal(publisherAllowed(publisherNeeds, () => true), false, "workflow cancellation stops publication");
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    const needs = structuredClone(publisherNeeds);
    needs["offline-contract"].result = result;
    assert.equal(publisherAllowed(needs, () => false), false, `aggregate ${result} cannot publish`);
  }
  for (const kind of ["REUSED", "SELECTED_OUT", "UNAVAILABLE", ""]) {
    const needs = structuredClone(publisherNeeds);
    needs["dispatch-contracts"].outputs.execution_kind = kind;
    assert.equal(publisherAllowed(needs, () => false), false, `${kind} is not executed original evidence`);
  }
  assert.deepEqual(jobs["dispatch-original"].permissions,
    { contents: "read", actions: "read", attestations: "write", "id-token": "write" });
  assert.deepEqual(jobs["dispatch-contracts"].permissions, { contents: "read", actions: "read", attestations: "read" });
  for (const [id, job] of Object.entries(jobs)) {
    if (id !== "dispatch-original") assert.ok(Object.values(job.permissions ?? oci.permissions).every((scope) => scope === "read"));
    assert.ok(!Object.hasOwn(job.permissions ?? {}, "statuses"), "branch-policy remains the sole status writer");
  }
  assert.deepEqual(jobs["full-contracts"].strategy.matrix.shard, ["core", "live", "provenance", "rollback", "governance"]);
  assert.equal(jobs["full-contracts"].strategy["fail-fast"], true,
    "definitive offline shard failure should cancel sibling offline shards");
  const capture = jobs["dispatch-contracts"].steps.find((step) => step.id === "worker").with.script;
  const observed = fixture();
  const observedOutputs = {};
  const candidateLoads = [];
  await new Function("require", "process", "core", "github", "context",
    `return (async () => { ${capture} })();`)((module) => {
    if (module === "node:util") return require(module);
    if (module === "node:child_process") return {
      execFileSync: () => "", spawnSync: () => ({ status: 3, stdout: "", stderr: "" }),
    };
    candidateLoads.push(module);
    return {
      DISPATCH_CONTROL_PATHS: [],
      captureNativeDispatchSource: async () => observed.source,
      captureDispatchProfile: () => ({ ...observed.profile, selected: false }),
    };
  }, { env: { NATIVE_DISPATCH_REUSE: "disabled", RUNNER_TEMP: "protected-fixture",
    GITHUB_RUN_ATTEMPT: "1", PLANNED_SOURCE: JSON.stringify(observed.source) } },
  { info() {}, warning() {}, setOutput: (key, value) => { observedOutputs[key] = value; } },
  observed.options.github, observed.options.context);
  assert.equal(observedOutputs.selected, "true", "candidate path list, capture and exit-3 selector cannot omit observational assertions");
  assert.deepEqual(candidateLoads, [], "observational execution decisions must not load candidate helpers");
  const observationStep = jobs["dispatch-contracts"].steps.find((step) => step.id === "observation");
  const proofStep = jobs["dispatch-contracts"].steps.find((step) => step.id === "original");
  const executeStep = jobs["dispatch-contracts"].steps.find((step) => step.id === "execute");
  assert.ok(jobs["dispatch-contracts"].steps.indexOf(observationStep) > jobs["dispatch-contracts"].steps.indexOf(proofStep));
  assert.equal(proofStep.if, "steps.worker.outputs.approved == 'true' && steps.worker.outputs.selected == 'true'");
  const forgedOutputs = {};
  await new Function("require", "process", "core", "github", "context",
    `return (async () => { ${observationStep.with.script} })();`)(() => ({
    DISPATCH_CONTROL_PATHS: [],
    captureNativeDispatchSource: async () => ({ ...observed.source, selected: false }),
    captureDispatchProfile: () => ({ selected: false, controlApproved: true }),
  }), { env: { GITHUB_RUN_ATTEMPT: "1" } },
  { setOutput: (key, value) => { forgedOutputs[key] = value; } }, observed.options.github, observed.options.context);
  const executeAllowed = new Function("steps", `return (${executeStep.if});`);
  assert.equal(executeAllowed({ worker: { outputs: observedOutputs }, original: { outputs: {} },
    observation: { outputs: { ...forgedOutputs, selected: "false", kind: "REUSED" } } }), true);
  for (const [approved, gateStatus] of [[true, 0], [true, 3], [false, 3]]) {
    const outputs = {};
    let selectorCalls = 0;
    const state = fixture();
    const policy = { records: [{ path: DISPATCH_CONTROL_PATHS[0], sha: "1".repeat(40) }] };
    const actual = { records: [{ ...policy.records[0], sha: (approved ? "1" : "2").repeat(40) }] };
    const requireControl = (module) => {
      if (module === "node:util") return require(module);
      if (module === "node:child_process") return {
        execFileSync: () => "",
        spawnSync: () => { selectorCalls++; return { status: gateStatus, stdout: "", stderr: "" }; },
      };
      assert.ok(module.startsWith("protected-fixture/dispatch-control/"), "no candidate JS before the protected reader");
      if (module.endsWith("/pr-source-snapshot.js")) return { QualityEvidenceError };
      if (module.endsWith("/consume-source-quality.js")) return { nativeDispatchPolicy: async () => policy };
      assert.ok(module.endsWith("/source-quality.js"));
      return {
        captureNativeDispatchSource: async () => state.source,
        captureDispatchProfile: () => state.profile,
        dispatchControl: async () => actual,
        DISPATCH_CONTROL_PATHS,
      };
    };
    const executeCapture = new Function("require", "process", "core", "github", "context",
      `return (async () => { ${capture} })();`);
    await executeCapture(requireControl, {
      env: {
        NATIVE_DISPATCH_REUSE: "enabled", RUNNER_TEMP: "protected-fixture", PROTECTED_CONTROL_READY: "true",
        GITHUB_RUN_ATTEMPT: "1", PLANNED_SOURCE: JSON.stringify(state.source),
      },
    }, { info() {}, warning() {}, setOutput: (key, value) => { outputs[key] = value; } },
    state.options.github, state.options.context);
    assert.equal(selectorCalls, approved ? 1 : 0, "unapproved selector must not execute before verification");
    assert.equal(outputs.selected, String(!approved || gateStatus === 0));
    assert.equal(JSON.parse(outputs.worker).controlApproved, approved);
  }
  assert.notEqual(jobs["dispatch-contracts"].steps.find((step) => step.id === "worker")["continue-on-error"], true);
  for (const failure of ["missing-copy", "missing-profile", "proof-unavailable", "bug", "unknown-mode"]) {
    const outputs = {};
    const run = () => new Function("require", "process", "core", "github", "context",
      `return (async () => { ${capture} })();`)((module) => {
      if (module.startsWith("node:")) return require(module);
      assert.ok(module.startsWith("protected-fixture/dispatch-control/"));
      if (module.endsWith("/pr-source-snapshot.js")) return { QualityEvidenceError };
      if (module.endsWith("/consume-source-quality.js")) return { nativeDispatchPolicy() {} };
      if (failure === "missing-profile") return {};
      return { captureNativeDispatchSource: async () => {
        if (failure === "bug") throw new TypeError("protected capture bug");
        throw new QualityEvidenceError("expected missing proof");
      } };
    }, { env: { NATIVE_DISPATCH_REUSE: failure === "unknown-mode" ? "unknown" : "enabled",
      RUNNER_TEMP: "protected-fixture", PROTECTED_CONTROL_READY: String(failure !== "missing-copy") } },
    { info() {}, warning() {}, setOutput: (key, value) => { outputs[key] = value; } },
    observed.options.github, observed.options.context);
    if (failure === "bug" || failure === "unknown-mode") await assert.rejects(run);
    else {
      await run();
      assert.equal(outputs.selected, "true");
      assert.equal(outputs.approved, undefined);
    }
  }
  for (const failure of [null, "unknown-mode", "mismatched-control", "missing-control"]) {
    const state = fixture();
    state.options.context = { ...state.options.context, runId: 101, sha: "3".repeat(40),
      ref: "refs/pull/63/merge", payload: { pull_request: { number: 63 } } };
    state.jobs[10].status = "in_progress";
    state.jobs[10].conclusion = null;
    if (failure === "mismatched-control") state.records[0].sha = "0".repeat(40);
    if (failure === "missing-control") state.records.shift();
    const loaded = [];
    const written = [];
    const executeSigner = new Function("require", "process", "github", "context",
      `return (async () => { ${collectStep.with.script} })();`);
    const run = () => executeSigner((module) => {
      if (module === "node:fs") return { writeFileSync: (_file, bytes) => written.push(JSON.parse(bytes)) };
      loaded.push(module);
      assert.equal(module, "protected-fixture/dispatch-signer-control/source-quality.js",
        "adoption must never load candidate signer control");
      return { collectNativeDispatchOriginal: (options, captured, controls) =>
        collectNativeDispatchOriginal(options, captured, { ...controls, git: () => state.options.context.sha }) };
    }, { env: { NATIVE_DISPATCH_REUSE: failure === "unknown-mode" ? "unknown" : "enabled",
      RUNNER_TEMP: "protected-fixture", GITHUB_RUN_ATTEMPT: "1",
      WORKER: JSON.stringify({ source: state.source, profile: state.profile, selected: true, controlApproved: true }) } },
    state.options.github, state.options.context);
    if (failure) {
      await assert.rejects(run());
      assert.deepEqual(written, []);
      if (failure === "unknown-mode") assert.deepEqual(loaded, []);
    } else {
      await run();
      assert.equal(written[0].purpose, "native-dispatch-original");
    }
  }
  const publication = jobs["dispatch-original"].steps.find((step) => step.name === "Confirm original publication");
  const classify = new Function("steps", `return (${jobs["dispatch-contracts"].outputs.execution_kind
    .slice(3, -2).replaceAll("steps.selected-out", "steps.selectedOut")});`);
  const completed = {
    execute: { outcome: "success" }, worker: { outcome: "success", outputs: { selected: "true" } },
    reused: { outcome: "skipped" }, selectedOut: { outcome: "skipped" },
  };
  assert.equal(classify(completed), "EXECUTED");
  completed.worker.outcome = "failure";
  assert.equal(classify(completed), "UNAVAILABLE", "adjusted success cannot publish failed capture");
  completed.execute.outcome = "skipped";
  completed.reused.outcome = "success";
  assert.equal(classify(completed), "REUSED");
  completed.reused.outcome = "skipped";
  completed.selectedOut.outcome = "success";
  assert.equal(classify(completed), "SELECTED_OUT");
  const confirm = new Function("steps", `return (${publication.if});`);
  for (const field of ["collect", "attest", "upload"]) {
    const steps = Object.fromEntries(["collect", "attest", "upload"].map((id) =>
      [id, { outcome: "success", conclusion: "success" }]));
    assert.equal(confirm(steps), true);
    steps[field].outcome = "failure"; // continue-on-error may still have conclusion=success.
    assert.equal(confirm(steps), false);
  }
  const aggregate = jobs["offline-contract"].steps[0].run;
  for (const mode of ["none", "focused", "full"]) {
    const env = {
      ...process.env, MODE: mode, SCOPE_RESULT: "success",
      SYNTAX_RESULT: mode === "none" ? "skipped" : "success",
      FOCUSED_RESULT: mode === "focused" ? "success" : "skipped",
      FULL_RESULT: mode === "full" ? "success" : "skipped",
      DISPATCH_RESULT: mode === "full" ? "success" : "skipped",
    };
    execFileSync("bash", ["-c", aggregate], { env, stdio: "pipe" });
    for (const result of ["failure", "cancelled", ""]) {
      assert.throws(() => execFileSync("bash", ["-c", aggregate], {
        env: { ...env, DISPATCH_RESULT: result }, stdio: "pipe",
      }));
    }
    if (mode === "full") {
      for (const field of ["SCOPE_RESULT", "SYNTAX_RESULT", "FULL_RESULT", "DISPATCH_RESULT"]) {
        for (const result of ["failure", "cancelled", "skipped", ""]) {
          assert.throws(() => execFileSync("bash", ["-c", aggregate], {
            env: { ...env, [field]: result }, stdio: "pipe",
          }), `${field}=${result} cannot authorize a complete full-scope aggregate`);
        }
      }
    }
  }
  const adoptionFile = ".test-workdirs/native-dispatch-adoption/production-build.yml";
  const productionFile = fs.existsSync(path.join(root, adoptionFile)) ? adoptionFile : ".github/workflows/production-build.yml";
  const production = loadWorkflow(productionFile);
  const safety = production.jobs["deployment-safety-contracts"];
  const proof = safety.steps.find((step) => step.id === "dispatch-original");
  if (proof) {
    assert.equal(proof.if, "github.event_name == 'push' && steps.dispatch-control-copy.outcome == 'success'");
    assert.deepEqual(safety.permissions, { contents: "read", actions: "read", attestations: "read" });
    assert.equal(safety.steps.find((step) => step.name === "Validate deployment safety workflow contract").env
      .BETSTAN_NATIVE_DISPATCH_REUSED, "${{ steps.dispatch-original.outputs.kind == 'REUSED' && '1' || '0' }}");
    const bind = safety.steps.find((step) => step.id === "dispatch-control");
    const checkout = safety.steps.find((step) => step.id === "dispatch-control-checkout");
    const preserve = safety.steps.find((step) => step.id === "dispatch-control-copy");
    assert.equal(checkout.with.ref, "${{ steps.dispatch-control.outputs.sha }}");
    assert.ok(safety.steps.indexOf(preserve) < safety.steps.findIndex((step) => step.name === "Checkout repository"));
    for (const mutate of [
      null,
      (f) => { f.options.context.payload.before = "0".repeat(40); },
      (f) => { f.options.context.payload.after = "0".repeat(40); },
      (f) => { f.options.context.payload.forced = true; },
      (f) => { f.options.context.payload.deleted = true; },
      (f) => { f.options.context.payload.repository.full_name = "other/repo"; },
      (f) => { f.options.context.ref = "refs/heads/dev"; },
      (f) => { f.currentRun.head_sha = "0".repeat(40); },
      (f) => { f.currentRun.run_attempt = 2; },
      (f) => { f.branch.protected = false; },
      (f) => { f.commits["5".repeat(40)].parents[0].sha = "7".repeat(40); },
      (f) => { f.options.github.rest.actions.getWorkflowRun = async () => { throw Object.assign(new Error("unavailable"), { status: 403 }); }; },
    ]) {
      const state = fixture("push");
      if (mutate) mutate(state);
      const outputs = {};
      await new Function("process", "core", "github", "context",
        `return (async () => { ${bind.with.script} })();`)({ env: { GITHUB_RUN_ATTEMPT: "1" } },
      { warning() {}, setOutput: (key, value) => { outputs[key] = value; } },
      state.options.github, state.options.context);
      assert.equal(outputs.sha, mutate ? undefined : "9".repeat(40), String(mutate));
    }
    for (const behavior of ["valid", "changed-reader", "missing-profile", "bug"]) {
      const state = fixture("push");
      if (behavior === "changed-reader") state.records.find((row) => row.path.endsWith("/consume-source-quality.js")).sha = "0".repeat(40);
      const outputs = {};
      let candidateLoads = 0;
      const call = () => new Function("require", "process", "core", "github", "context",
        `return (async () => { ${proof.with.script} })();`)((module) => {
        if (module.startsWith("./.github/scripts/")) {
          candidateLoads++;
          return { captureDispatchProfile: () => state.profile,
            selectNativeDispatchOriginal: async () => ({ kind: "REUSED", runId: 666 }) };
        }
        assert.ok(module.startsWith("protected-fixture/dispatch-control/"));
        if (behavior === "missing-profile") return {};
        if (module.endsWith("/source-quality.js")) return { captureDispatchProfile: () => state.profile };
        return { selectNativeDispatchOriginal: async (options, profile) => {
          if (behavior === "bug") throw new TypeError("protected verifier bug");
          return selectNativeDispatchOriginal(options, profile, state.dependencies);
        } };
      }, { env: { RUNNER_TEMP: "protected-fixture", GITHUB_RUN_ATTEMPT: "1" } },
      { info() {}, warning() {}, setOutput: (key, value) => { outputs[key] = value; } },
      state.options.github, state.options.context);
      if (behavior === "bug") await assert.rejects(call, TypeError);
      else {
        await call();
        assert.equal(outputs.kind, behavior === "valid" ? "REUSED" : behavior === "changed-reader" ? "EXECUTE" : undefined);
      }
      assert.equal(candidateLoads, 0, "a candidate reader returning fake REUSED must never load");
    }
  }
  for (const [file, blobs] of Object.entries(DISPATCH_CALLER_BLOBS)) {
    const bytes = fs.readFileSync(path.join(root, file.endsWith("production-build.yml") ? productionFile : file));
    const hash = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (file.endsWith("oci-validate.yml")) {
      assert.equal(hash, oci.env.NATIVE_DISPATCH_REUSE === "disabled" ? blobs[0] : blobs.at(-1));
      const weakened = Buffer.from(bytes.toString().replace(
        '[ "$FULL_RESULT" = success ]', '[ "$FULL_RESULT" != failure ]'));
      const weakenedHash = crypto.createHash("sha1")
        .update(`blob ${weakened.length}\0`).update(weakened).digest("hex");
      assert.ok(!blobs.includes(weakenedHash),
        "the fail-fast caller approval must not accept weakened aggregate proof");
    } else if (proof) {
      assert.ok(blobs.includes(hash), `${file} must match its frozen eligibility profile`);
    }
  }
  const wrapper = fs.readFileSync(path.join(root, "infra/azure/agents/test-deployment-safety-ci-stan.sh"), "utf8");
  const ownershipStart = wrapper.indexOf('contract_suites=("$RUN_APPROVAL_TEST"');
  const ownershipEnd = wrapper.indexOf('run_parallel_contract_suites "${contract_suites[@]}"', ownershipStart);
  assert.ok(ownershipStart > 0 && ownershipEnd > ownershipStart);
  const ownership = wrapper.slice(ownershipStart, ownershipEnd);
  const ownershipScript = `set -eu\nCLI_DISPATCH_TEST=dispatch\nRUN_APPROVAL_TEST=approval\nRUN_EXCLUSIVITY_TEST=exclusive\nLIVE_DATA_ROLLOUT_TEST=live\nGHCR_CONTRACT_TEST=ghcr\n${ownership}\nprintf 'OWNED=%s\\n' \"\${contract_suites[@]}\"`;
  const ownerEnv = { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/master", BETSTAN_CONTRACT_ORCHESTRATED: "0" };
  delete ownerEnv.BETSTAN_NATIVE_DISPATCH_REUSED;
  const owned = (env) => execFileSync("bash", ["-c", ownershipScript], { env, encoding: "utf8" })
    .split("\n").filter((line) => line.startsWith("OWNED=")).map((line) => line.slice(6));
  assert.deepEqual(owned(ownerEnv), ["dispatch", "approval", "exclusive", "live", "ghcr"]);
  assert.deepEqual(owned({ ...ownerEnv, BETSTAN_NATIVE_DISPATCH_REUSED: "0" }), ["dispatch", "approval", "exclusive", "live", "ghcr"]);
  assert.deepEqual(owned({ ...ownerEnv, BETSTAN_NATIVE_DISPATCH_REUSED: "1" }), ["approval", "exclusive", "live", "ghcr"]);
  for (const env of [
    { ...ownerEnv, BETSTAN_NATIVE_DISPATCH_REUSED: "invalid" },
    { ...ownerEnv, BETSTAN_NATIVE_DISPATCH_REUSED: "1", GITHUB_EVENT_NAME: "pull_request" },
    { ...ownerEnv, BETSTAN_NATIVE_DISPATCH_REUSED: "1", GITHUB_REF: "refs/heads/dev" },
    { ...ownerEnv, BETSTAN_NATIVE_DISPATCH_REUSED: "1", GITHUB_ACTIONS: "false" },
  ]) assert.throws(() => execFileSync("bash", ["-c", ownershipScript], { env, stdio: "pipe" }));
  console.log("native_dispatch_original_tests=PASS (fresh, direct promotion/master reuse, rejected evidence, aggregation)");
}

if (require.main === module) {
  testConsumeSourceQuality().then(testNativeDispatchOriginals).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = async () => { await testConsumeSourceQuality(); await testNativeDispatchOriginals(); };
module.exports.historicalFixture = historicalFixture;
