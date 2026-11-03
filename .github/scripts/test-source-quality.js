"use strict";

const assert = require("node:assert/strict");
const { captureSource, collectManifest } = require("./source-quality.js");

function fixture() {
  const pull = {
    number: 63, state: "open", mergeable: true, merge_commit_sha: "3".repeat(40),
    head: { ref: "feature", sha: "1".repeat(40), repo: { full_name: "example/repo" } },
    base: { ref: "dev", sha: "2".repeat(40), repo: { full_name: "example/repo" } },
  };
  const merge = {
    sha: pull.merge_commit_sha,
    tree: { sha: "4".repeat(40) },
    parents: [{ sha: pull.base.sha }, { sha: pull.head.sha }],
  };
  const native = {
    id: 102, run_attempt: 2, workflow_id: 202,
    event: "pull_request_target", path: ".github/workflows/source-quality.yml",
    head_sha: pull.head.sha, status: "in_progress", conclusion: null,
    repository: { id: 77, full_name: "example/repo" },
    pull_requests: [{ number: pull.number }],
  };
  const jobs = [{
    id: 501, name: "quality (source-policy)", run_id: native.id, run_attempt: 2,
    head_sha: native.head_sha, status: "completed", conclusion: "success",
  }];
  const context = {
    repo: { owner: "example", repo: "repo" },
    runId: native.id, sha: pull.base.sha, ref: "refs/heads/dev",
    eventName: native.event, payload: { pull_request: { number: pull.number } },
  };
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async ({ run_id }) => {
          assert.equal(run_id, native.id);
          return { data: structuredClone(native) };
        },
        listJobsForWorkflowRun: () => { assert.fail("use complete pagination"); },
      },
      pulls: {
        get: async ({ pull_number }) => {
          assert.equal(pull_number, pull.number);
          return { data: structuredClone(pull) };
        },
      },
      git: {
        getCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, pull.merge_commit_sha);
          return { data: structuredClone(merge) };
        },
      },
    },
    paginate: async (method, { run_id, filter }) => {
      assert.equal(method, github.rest.actions.listJobsForWorkflowRun);
      assert.equal(run_id, native.id);
      assert.equal(filter, "all");
      return structuredClone(jobs);
    },
  };
  const git = (args) => {
    if (args[0] === "rev-parse") {
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      return `${context.sha}\n`;
    }
    assert.deepEqual(args.slice(0, 4), ["ls-tree", "-z", "HEAD", "--"]);
    return args.slice(4).map((file, index) =>
      `100644 blob ${String(index + 5).repeat(40)}\t${file}\0`,
    ).join("");
  };
  return { options: { github, context, attempt: 2 }, pull, merge, native, jobs, git };
}

async function testSourceQuality() {
  const initial = fixture();
  const source = await captureSource(initial.options, initial.git);
  assert.equal(source.run.headSha, initial.pull.head.sha);
  assert.equal(source.validator.executingCommitSha, initial.pull.base.sha);
  assert.equal(source.checkout.commitSha, initial.pull.merge_commit_sha);
  const manifest = await collectManifest(initial.options, source, initial.git);
  assert.equal(manifest.purpose, "shadow-source-policy");
  assert.equal(manifest.suites[0].jobId, initial.jobs[0].id);
  assert.equal(manifest.run.headSha, initial.pull.head.sha);

  for (const mutate of [
    (value) => { value.options.context.ref = "refs/heads/feature"; },
    (value) => { value.options.context.eventName = "pull_request"; },
    (value) => { value.native.run_attempt = 1; },
    (value) => { value.native.path = ".github/workflows/forged.yml"; },
    (value) => { value.native.repository.full_name = "other/repo"; },
    (value) => { value.native.pull_requests = []; },
    (value) => { value.pull.mergeable = null; },
    (value) => { value.merge.parents.reverse(); },
    (value) => { value.merge.sha = value.pull.head.sha; },
  ]) {
    const invalid = fixture();
    mutate(invalid);
    await assert.rejects(captureSource(invalid.options, invalid.git));
  }
  await assert.rejects(captureSource(fixture().options, () => "0".repeat(40)), /exact protected source/);
  const incomplete = fixture();
  await assert.rejects(captureSource(incomplete.options, (args) =>
    args[0] === "ls-tree" ? "" : incomplete.git(args),
  ), /closure is incomplete/);
  const symlinked = fixture();
  await assert.rejects(captureSource(symlinked.options, (args) =>
    symlinked.git(args).replace("100644", "120000"),
  ), /Unsupported quality control input/);

  const advanced = fixture();
  advanced.pull.base.sha = "a".repeat(40);
  advanced.pull.head.sha = "b".repeat(40);
  advanced.pull.merge_commit_sha = "c".repeat(40);
  advanced.merge.sha = advanced.pull.merge_commit_sha;
  advanced.merge.tree.sha = "d".repeat(40);
  advanced.merge.parents = [{ sha: advanced.pull.base.sha }, { sha: advanced.pull.head.sha }];
  const updated = await captureSource(advanced.options, advanced.git);
  assert.equal(updated.validator.executingCommitSha, "2".repeat(40));
  assert.equal(updated.run.headSha, "1".repeat(40));
  assert.equal(updated.sourceSnapshot.headSha, "b".repeat(40));
  assert.notEqual(updated.inputClosureSha256, source.inputClosureSha256);

  const dispatched = fixture();
  dispatched.native.event = "workflow_dispatch";
  dispatched.native.head_sha = dispatched.options.context.sha;
  dispatched.native.pull_requests = [];
  dispatched.options.context.eventName = "workflow_dispatch";
  dispatched.options.context.payload = { inputs: { pr_number: "63" } };
  assert.equal((await captureSource(dispatched.options, dispatched.git)).sourceSnapshot.number, 63);

  const resumed = fixture();
  const previous = await captureSource(resumed.options, resumed.git);
  resumed.native.run_attempt = 3;
  resumed.options.attempt = 3;
  assert.equal((await collectManifest(resumed.options, previous, resumed.git)).suites[0].executionAttempt, 2);
  resumed.jobs[0].conclusion = "failure";
  await assert.rejects(collectManifest(resumed.options, previous, resumed.git), /selected job/);
  resumed.jobs[0].conclusion = "success";
  previous.validator.workflowBlobSha = "0".repeat(40);
  await assert.rejects(collectManifest(resumed.options, previous, resumed.git), /control changed/);

  console.log("source_quality_tests=PASS");
}

if (require.main === module) {
  testSourceQuality().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = testSourceQuality;
