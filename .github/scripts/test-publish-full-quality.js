"use strict";

const assert = require("node:assert/strict");
const publish = require("./publish-pr-policy.js");
const { historicalFixture } = require("./test-consume-source-quality.js");
const { githubClient, validateFullSourceQuality } = require("./validate-full-source-quality.js");

async function fixture(event = "pull_request_target") {
  const state = await historicalFixture({ ref: "refs/heads/master", event });
  const { github } = state.options;
  state.pull.state = "open";
  state.native.created_at = "2026-11-03T12:00:00Z";
  state.native.display_title = `source-quality PR ${state.pull.number}`;
  state.master = state.options.context.sha;
  state.baseSha = state.pull.base.sha;
  state.runs = [state.native];
  state.artifacts = [state.artifact];
  state.statuses = [];
  state.failures = [];
  state.requiredContexts = ["branch-policy/dev", "source-quality-v2/dev"];
  github.rest.pulls.get = async () => ({ data: structuredClone(state.pull) });
  github.rest.repos.getBranch = async ({ branch }) => {
    if (state.protectionError) throw new Error("Protection read failed");
    return { data: {
      name: branch, protected: true,
      protection: { enabled: true, required_status_checks: { contexts: state.requiredContexts, checks: [] } },
    } };
  };
  github.rest.repos.getCommit = async ({ ref }) => {
    assert.ok(["master", "dev"].includes(ref));
    return { data: { sha: ref === "master" ? state.master : state.baseSha } };
  };
  github.rest.repos.createCommitStatus = async (row) => {
    state.statuses.push(row);
    state.onWrite?.(row);
    return { data: row };
  };
  github.rest.actions.getWorkflow = async ({ workflow_id }) => {
    assert.equal(workflow_id, "source-quality.yml");
    return { data: { id: 202, path: state.native.path, state: "active" } };
  };
  github.rest.actions.listWorkflowRuns = async (args) => {
    assert.equal(args.workflow_id, 202);
    assert.equal(args.per_page, 100);
    assert.equal(args.page, 1);
    return { data: {
      total_count: state.incompleteRuns ? 101 : state.runs.length,
      workflow_runs: structuredClone(state.runs),
    } };
  };
  github.rest.actions.listWorkflowRunArtifacts = async ({ run_id }) => {
    assert.equal(run_id, state.native.id);
    return { data: {
      total_count: state.incompleteArtifacts ? 101 : state.artifacts.length,
      artifacts: structuredClone(state.artifacts),
    } };
  };
  state.arguments = {
    github,
    context: {
      repo: state.options.context.repo, serverUrl: "https://github.com", runId: 500,
      eventName: "pull_request_target",
      payload: { action: "opened", pull_request: { number: state.pull.number } },
    },
    core: { info: () => {}, setFailed: (message) => state.failures.push(message) },
    fullQuality: {
      git: state.git, verify: state.dependencies.verify,
      readArtifact: async ({ artifactId }) => {
        assert.equal(artifactId, state.artifact.id);
        return JSON.stringify(state.manifest);
      },
    },
  };
  return state;
}

function qualityRows(state) {
  return state.statuses.filter((row) => row.context.startsWith("source-quality-v2/"));
}

function assertNoSuccess(state) {
  assert.equal(qualityRows(state).some((row) => row.state === "success"), false);
}

async function testPublishFullQuality() {
  for (const event of ["pull_request_target", "workflow_dispatch"]) {
    const valid = await fixture(event);
    await publish(valid.arguments);
    assert.deepEqual(qualityRows(valid).map((row) => [row.sha, row.state]), [
      [valid.pull.head.sha, "success"], [valid.pull.merge_commit_sha, "success"],
    ]);
    assert.ok(qualityRows(valid).every((row) =>
      row.target_url === "https://github.com/example/repo/actions/runs/102/attempts/2"));
  }

  const metadata = await fixture();
  metadata.arguments.context.payload.action = "edited";
  const verify = metadata.arguments.fullQuality.verify;
  metadata.arguments.fullQuality.verify = async (input) => {
    metadata.pull.title = "New title";
    metadata.pull.body = "New explanation";
    metadata.pull.labels = [{ name: "feature:changed" }];
    return verify(input);
  };
  await publish(metadata.arguments);
  assert.equal(qualityRows(metadata)[0].state, "success");

  for (const mutate of [
    (state) => { state.artifacts = []; },
    (state) => { state.runs = []; },
    (state) => { state.native.status = "in_progress"; state.native.conclusion = null; },
    (state) => { state.pull.mergeable = null; },
  ]) {
    const pending = await fixture();
    mutate(pending);
    await publish(pending.arguments);
    assert.ok(qualityRows(pending).every((row) => row.state === "pending"));
  }

  const newestFailed = await fixture();
  newestFailed.runs.push({
    ...newestFailed.native, id: 103, created_at: "2026-11-03T13:00:00Z", conclusion: "failure",
  });
  await publish(newestFailed.arguments);
  assertNoSuccess(newestFailed);
  assert.equal(newestFailed.failures.length, 1);

  for (const mutate of [
    (state) => { state.manifest.schemaVersion = 1; },
    (state) => { state.incompleteRuns = true; },
    (state) => { state.incompleteArtifacts = true; },
    (state) => { state.artifacts.push(structuredClone(state.artifact)); },
    (state) => { state.arguments.fullQuality.verify = () => { throw new Error("bad signature"); }; },
    (state) => { state.master = "f".repeat(40); },
  ]) {
    const invalid = await fixture();
    mutate(invalid);
    await assert.rejects(publish(invalid.arguments));
    assertNoSuccess(invalid);
  }

  for (const drift of [
    (state) => { state.native.run_attempt++; },
    (state) => { state.pull.head.sha = "f".repeat(40); },
    (state) => { state.pull.base.sha = "e".repeat(40); },
    (state) => { state.master = "a".repeat(40); },
    (state) => { state.baseSha = "a".repeat(40); },
    (state) => { state.pull.state = "closed"; },
  ]) {
    const stale = await fixture();
    let changed = false;
    stale.onWrite = (row) => {
      if (!changed && row.context.startsWith("source-quality-v2/") && row.state === "success") {
        changed = true;
        drift(stale);
      }
    };
    await assert.rejects(publish(stale.arguments));
    for (const sha of [stale.source.sourceSnapshot.headSha, stale.source.sourceSnapshot.mergeSha]) {
      assert.equal(qualityRows(stale).filter((row) => row.sha === sha).at(-1).state, "failure");
    }
  }

  const invalidBranch = await fixture();
  invalidBranch.pull.head.ref = "master";
  await publish(invalidBranch.arguments);
  assertNoSuccess(invalidBranch);
  assert.equal(invalidBranch.failures.length, 1);

  const closed = await fixture();
  closed.pull.state = "closed";
  await publish(closed.arguments);
  assert.equal(closed.statuses.length, 0);

  const wakeup = await fixture("workflow_dispatch");
  wakeup.arguments.context.eventName = "workflow_run";
  wakeup.arguments.context.payload = { workflow_run: structuredClone(wakeup.native) };
  await publish(wakeup.arguments);
  assert.equal(qualityRows(wakeup)[0].state, "success");
  const inactiveCompletion = await fixture();
  inactiveCompletion.requiredContexts = ["publish-current-pr-snapshot", "pr-quality-gates"];
  inactiveCompletion.arguments.context.eventName = "workflow_run";
  inactiveCompletion.arguments.context.payload = { workflow_run: structuredClone(inactiveCompletion.native) };
  await publish(inactiveCompletion.arguments);
  assert.equal(inactiveCompletion.statuses.length, 0);
  for (const readFails of [false, true]) {
    const changedProtocol = await fixture();
    changedProtocol.onWrite = () => {
      changedProtocol.requiredContexts = ["publish-current-pr-snapshot", "pr-quality-gates"];
      changedProtocol.protectionError = readFails;
    };
    await assert.rejects(publish(changedProtocol.arguments), /protocol changed|Protection read failed/);
    for (const sha of [changedProtocol.pull.head.sha, changedProtocol.pull.merge_commit_sha]) {
      for (const name of ["branch-policy/dev", "pr-quality-gates/dev", "source-quality-v2/dev"]) {
        assert.equal(changedProtocol.statuses.filter((row) => row.sha === sha && row.context === name).at(-1)?.state,
          "failure", `${sha} ${name} must not retain protocol-incompatible success`);
      }
    }
  }
  for (const readFails of [false, true]) {
    const advanced = await fixture();
    const earlier = structuredClone(advanced.pull);
    earlier.head.sha = "a".repeat(40);
    earlier.merge_commit_sha = "b".repeat(40);
    let reads = 0;
    advanced.options.github.rest.pulls.get = async () => {
      if (++reads === 1) return { data: earlier };
      advanced.requiredContexts = ["publish-current-pr-snapshot", "pr-quality-gates"];
      advanced.protectionError = readFails;
      return { data: structuredClone(advanced.pull) };
    };
    await assert.rejects(publish(advanced.arguments), /changed during policy evaluation/);
    assert.equal(advanced.statuses.length, 0, "advancing source must abort before publishing another snapshot");
  }
  await testMergeValidation();
  console.log("publish_full_quality_tests=PASS");
}

async function mergeFixture() {
  const state = await fixture();
  await publish(state.arguments);
  const { github } = state.options;
  const getWorkflow = github.rest.actions.getWorkflow;
  github.rest.actions.getWorkflow = (args) => args.workflow_id === "branch-policy.yml"
    ? { data: { id: 201, path: ".github/workflows/branch-policy.yml", state: "active" } }
    : getWorkflow(args);
  const getWorkflowRun = github.rest.actions.getWorkflowRun;
  state.policyRun = {
    id: 500, workflow_id: 201, repository: { full_name: "example/repo" },
    path: ".github/workflows/branch-policy.yml", status: "completed", conclusion: "success",
    event: "workflow_run", display_title: "branch-policy PR 102",
  };
  github.rest.actions.getWorkflowRun = (args) => args.run_id === 500
    ? { data: structuredClone(state.policyRun) } : getWorkflowRun(args);
  github.rest.repos.getCombinedStatusForRef = async ({ ref }) => ({ data: {
    sha: ref, statuses: state.statuses.filter((row) => row.sha === ref).reverse().map((row) => ({
      ...row, creator: { id: 41898282, login: "github-actions[bot]" },
    })),
  } });
  state.validation = {
    github, repo: state.options.context.repo, number: state.pull.number,
    expectedHeadSha: state.pull.head.sha, expectedBaseSha: state.pull.base.sha,
  };
  state.validationDependencies = {
    ...state.arguments.fullQuality,
    git: (args) => args[0] === "status" ? (state.dirty ? " M modified.js\n" : "") : state.git(args),
  };
  return state;
}

async function testMergeValidation() {
  const valid = await mergeFixture();
  const result = await validateFullSourceQuality(valid.validation, valid.validationDependencies);
  assert.equal(result.runId, 102);
  assert.equal(result.attempt, 2);
  assert.equal(result.snapshot.mergeSha, valid.pull.merge_commit_sha);
  for (const mutate of [
    (state) => { state.statuses = state.statuses.filter((row) => !row.context.startsWith("source-quality-v2/")); },
    (state) => { state.statuses.find((row) => row.context.startsWith("source-quality-v2/")).target_url =
      "https://github.com/example/repo/actions/runs/102/attempts/1"; },
    (state) => { state.statuses.find((row) => row.context.startsWith("source-quality-v2/")).state = "pending"; },
    (state) => { state.policyRun.workflow_id = 999; },
    (state) => { state.policyRun.conclusion = "failure"; },
    (state) => { state.policyRun.display_title = "branch-policy PR 999"; },
    (state) => { state.master = "f".repeat(40); },
    (state) => { state.baseSha = "f".repeat(40); },
    (state) => { state.dirty = true; },
    (state) => { state.artifacts = []; },
    (state) => { state.manifest.schemaVersion = 1; },
    (state) => { state.validation.expectedHeadSha = "f".repeat(40); },
    (state) => { state.native.run_attempt++; },
  ]) {
    const invalid = await mergeFixture();
    mutate(invalid);
    await assert.rejects(validateFullSourceQuality(invalid.validation, invalid.validationDependencies));
  }
  const drift = await mergeFixture();
  const verify = drift.validationDependencies.verify;
  drift.validationDependencies.verify = async (input) => {
    const signature = await verify(input);
    drift.statuses.find((row) => row.context.startsWith("source-quality-v2/")).state = "failure";
    return signature;
  };
  await assert.rejects(validateFullSourceQuality(drift.validation, drift.validationDependencies), /status/);

  const requests = [];
  const client = githubClient("example/repo", (command, args) => {
    assert.equal(command, "gh");
    assert.deepEqual(args.slice(0, 3), ["api", "--hostname", "github.com"]);
    requests.push(args[3]);
    return JSON.stringify({ jobs: [] });
  });
  await client.rest.repos.get();
  await client.rest.repos.compareCommitsWithBasehead({ basehead: "a...b" });
  assert.deepEqual(await client.paginate(client.rest.actions.listJobsForWorkflowRun, {
    run_id: 102, filter: "all", per_page: 100,
  }), []);
  assert.ok(requests.includes("repos/example/repo/actions/runs/102/jobs?filter=all&per_page=100&page=1"));
}

if (require.main === module) {
  testPublishFullQuality().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = testPublishFullQuality;
module.exports.fixture = fixture;
