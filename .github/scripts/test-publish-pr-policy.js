"use strict";

const assert = require("node:assert/strict");
const publishPrPolicy = require("./publish-pr-policy.js");

const HEAD_SHA = "1111111111111111111111111111111111111111";
const BASE_SHA = "0000000000000000000000000000000000000000";
const MERGE_SHA = "2222222222222222222222222222222222222222";

function pull(overrides = {}) {
  return {
    number: 63,
    state: "open",
    mergeable: true,
    merge_commit_sha: MERGE_SHA,
    head: {
      ref: "dev",
      sha: HEAD_SHA,
      repo: { full_name: "example/repo" },
    },
    base: { ref: "master", sha: BASE_SHA },
    ...overrides,
  };
}

function workflowRun(overrides = {}) {
  return {
    id: 102,
    workflow_id: 202,
    path: ".github/workflows/production-build.yml",
    event: "pull_request",
    head_sha: HEAD_SHA,
    head_repository: { full_name: "example/repo" },
    status: "completed",
    conclusion: "success",
    html_url: "https://example.invalid/actions/runs/102",
    pull_requests: [
      {
        number: 63,
        head: { sha: HEAD_SHA },
        base: { sha: BASE_SHA },
      },
    ],
    ...overrides,
  };
}

async function execute({
  currentPull = pull(),
  eventPull = pull(),
  run = workflowRun(),
  headBlob = "trusted-blob",
  eventName = "pull_request_target",
} = {}) {
  const statuses = [];
  const messages = [];
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: currentPull }),
      },
      repos: {
        get: async () => ({ data: { default_branch: "dev" } }),
        getContent: async ({ ref }) => ({
          data: {
            type: "file",
            sha: ref === "dev" ? "trusted-blob" : headBlob,
          },
        }),
        createCommitStatus: async (status) => {
          statuses.push(status);
        },
      },
      actions: {
        getWorkflow: async () => ({
          data: { id: 202, path: ".github/workflows/production-build.yml" },
        }),
        listWorkflowRuns: async () => ({
          data: { workflow_runs: [run] },
        }),
        listJobsForWorkflowRun: async () => ({
          data: {
            jobs: [
              {
                name: "pr-quality-gates",
                status: "completed",
                conclusion: "success",
              },
            ],
          },
        }),
      },
    },
  };
  const core = {
    info: (message) => messages.push(message),
    setFailed: (message) => messages.push(`FAILED: ${message}`),
  };
  const context = {
    eventName,
    payload:
      eventName === "workflow_run"
        ? { workflow_run: run }
        : { pull_request: eventPull },
    repo: { owner: "example", repo: "repo" },
    runId: 101,
    serverUrl: "https://example.invalid",
  };

  await publishPrPolicy({ github, context, core });
  return { statuses, messages };
}

async function main() {
  const allowed = await execute();
  assert.deepEqual(
    allowed.statuses.map(({ context, state, sha }) => ({
      context,
      state,
      sha,
    })),
    [
      { context: "branch-policy/master", state: "success", sha: HEAD_SHA },
      { context: "branch-policy/master", state: "success", sha: MERGE_SHA },
      { context: "pr-quality-gates/master", state: "success", sha: HEAD_SHA },
      {
        context: "pr-quality-gates/master",
        state: "success",
        sha: MERGE_SHA,
      },
    ],
  );

  const invalidPull = pull({
    head: {
      ref: "feature/not-dev",
      sha: HEAD_SHA,
      repo: { full_name: "example/repo" },
    },
  });
  const invalid = await execute({
    currentPull: invalidPull,
    eventPull: invalidPull,
    run: workflowRun(),
  });
  assert.equal(invalid.statuses[0].state, "failure");
  assert(invalid.messages.some((message) => message.startsWith("FAILED:")));

  const changedWorkflow = await execute({ headBlob: "changed-blob" });
  assert.equal(changedWorkflow.statuses[2].state, "failure");
  assert.equal(changedWorkflow.statuses[3].state, "failure");

  const approvedWorkflow = await execute({
    headBlob: "c300f1291fe98565b49a7944743f356981a9f664",
  });
  assert.equal(approvedWorkflow.statuses[2].state, "success");
  assert.equal(approvedWorkflow.statuses[3].state, "success");

  const qualityCompletion = await execute({ eventName: "workflow_run" });
  assert.deepEqual(
    qualityCompletion.statuses.map(({ context, state, sha }) => ({
      context,
      state,
      sha,
    })),
    [
      {
        context: "pr-quality-gates/master",
        state: "success",
        sha: HEAD_SHA,
      },
      {
        context: "pr-quality-gates/master",
        state: "success",
        sha: MERGE_SHA,
      },
    ],
  );

  const staleEvent = pull({
    head: {
      ref: "dev",
      sha: "3333333333333333333333333333333333333333",
      repo: { full_name: "example/repo" },
    },
  });
  await assert.rejects(
    execute({ eventPull: staleEvent }),
    /Pull request changed during policy evaluation/,
  );

  console.log("publish_pr_policy_tests=PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
