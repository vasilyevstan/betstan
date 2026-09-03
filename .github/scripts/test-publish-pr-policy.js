"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const publishPrPolicy = require("./publish-pr-policy.js");

const HEAD_SHA = "1111111111111111111111111111111111111111";
const BASE_SHA = "0000000000000000000000000000000000000000";
const MERGE_SHA = "2222222222222222222222222222222222222222";
const TRUSTED_BLOB = "4444444444444444444444444444444444444444";
const CHANGED_BLOB = "5555555555555555555555555555555555555555";
const NOW = "2026-09-02T12:00:00.000Z";
const PULL_UPDATED_AT = "2026-09-02T09:00:00.000Z";
const PULL_TITLE = "Test pull request";
const PULL_BODY = "Test body";
const ACTIONS_BOT = Object.freeze({
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
});
const PULL_CONTENT_FINGERPRINT = crypto
  .createHash("sha256")
  .update(`${PULL_TITLE}\0${PULL_BODY}`)
  .digest("hex")
  .slice(0, 32);

function pull(overrides = {}) {
  return {
    number: 63,
    state: "open",
    mergeable: true,
    merge_commit_sha: MERGE_SHA,
    updated_at: PULL_UPDATED_AT,
    title: PULL_TITLE,
    body: PULL_BODY,
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
    created_at: "2026-09-02T10:00:00.000Z",
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

function workflowAuthorization(overrides = {}) {
  return {
    id: "production-build-555555555555-pr-63",
    repository: "example/repo",
    workflowPath: ".github/workflows/production-build.yml",
    trustedBlob: TRUSTED_BLOB,
    authorizedBlob: CHANGED_BLOB,
    pullNumber: 63,
    receiptSha: HEAD_SHA,
    headRepository: "example/repo",
    headRef: "dev",
    baseRef: "master",
    issuedAt: "2026-09-01T12:00:00.000Z",
    expiresAt: "2026-09-04T12:00:00.000Z",
    ...overrides,
  };
}

function qualityTransitionStatus(overrides = {}) {
  return {
    id: 900,
    context: "trusted-quality-transition/master",
    state: "pending",
    description:
      `PR #63 edited ${PULL_UPDATED_AT} run 102 ` +
      `content ${PULL_CONTENT_FINGERPRINT}`,
    target_url: "https://example.invalid/example/repo/actions/runs/100",
    creator: ACTIONS_BOT,
    ...overrides,
  };
}

async function execute({
  currentPull = pull(),
  currentPulls,
  eventPull = pull(),
  run = workflowRun(),
  headBlob = TRUSTED_BLOB,
  eventName = "workflow_dispatch",
  eventAction = "edited",
  listedRuns,
  listedTotalCount,
  workflowAuthorizations,
  authorizationNow = NOW,
  authorizationStatuses = [],
  transitionStatuses = [qualityTransitionStatus()],
  comparisonStatus = "identical",
  statusSink,
  policyRunOverrides = {},
} = {}) {
  const statuses = statusSink || [];
  const messages = [];
  let pullGetCount = 0;
  const github = {
    rest: {
      pulls: {
        get: async () => {
          const data = currentPulls
            ? currentPulls[
                Math.min(pullGetCount, currentPulls.length - 1)
              ]
            : currentPull;
          pullGetCount += 1;
          return { data };
        },
      },
      repos: {
        get: async () => ({ data: { default_branch: "dev" } }),
        getContent: async ({ ref }) => ({
          data: {
            type: "file",
            sha: ref === "dev" ? TRUSTED_BLOB : headBlob,
          },
        }),
        createCommitStatus: async (status) => {
          statuses.push(status);
          if (
            status.context.startsWith("trusted-workflow-authorization/")
          ) {
            const { sha: _sha, ...storedStatus } = status;
            authorizationStatuses.unshift({
              ...storedStatus,
              id: authorizationStatuses.length + 1,
              description: status.description ?? null,
              target_url: status.target_url ?? null,
            });
          }
          if (
            status.sha === MERGE_SHA &&
            status.context.startsWith("trusted-quality-transition/")
          ) {
            const { sha: _sha, ...storedStatus } = status;
            transitionStatuses.unshift({
              ...storedStatus,
              id: 1000 + transitionStatuses.length,
              description: status.description ?? null,
              target_url: status.target_url ?? null,
              creator: ACTIONS_BOT,
            });
          }
        },
        listCommitStatusesForRef: async ({ ref, page }) => {
          const inventory =
            ref === MERGE_SHA ? transitionStatuses : authorizationStatuses;
          return {
            data: inventory.slice((page - 1) * 100, page * 100),
          };
        },
        compareCommitsWithBasehead: async ({ basehead }) => {
          assert.equal(basehead, `${HEAD_SHA}...${HEAD_SHA}`);
          return {
            data: {
              status: comparisonStatus,
              merge_base_commit: { sha: HEAD_SHA },
            },
          };
        },
      },
      actions: {
        getWorkflow: async ({ workflow_id: workflowId }) => ({
          data:
            workflowId === "branch-policy.yml"
              ? {
                  id: 201,
                  path: ".github/workflows/branch-policy.yml",
                }
              : {
                  id: 202,
                  path: ".github/workflows/production-build.yml",
                },
        }),
        getWorkflowRun: async ({ run_id: runId }) => ({
          data: {
            id: runId,
            workflow_id: 201,
            path: ".github/workflows/branch-policy.yml",
            event: "pull_request_target",
            repository: { full_name: "example/repo" },
            pull_requests: [
              {
                number: 63,
                head: { sha: HEAD_SHA },
                base: { sha: BASE_SHA },
              },
            ],
            html_url:
              `https://example.invalid/example/repo/actions/runs/${runId}`,
            ...policyRunOverrides,
          },
        }),
        listWorkflowRuns: async ({ page, per_page: perPage }) => {
          const runs = listedRuns ?? [run];
          return {
            data: {
              total_count: listedTotalCount ?? runs.length,
              workflow_runs: runs.slice(
                (page - 1) * perPage,
                page * perPage,
              ),
            },
          };
        },
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
        : eventName === "workflow_dispatch"
          ? { inputs: { pr_number: "63" } }
        : { action: eventAction, pull_request: eventPull },
    repo: { owner: "example", repo: "repo" },
    runId: 101,
    serverUrl: "https://example.invalid",
  };

  const policyArguments = {
    github,
    context,
    core,
    authorizationNow,
  };
  if (workflowAuthorizations !== undefined) {
    policyArguments.workflowAuthorizations = workflowAuthorizations;
  }
  await publishPrPolicy(policyArguments);
  return { statuses, messages };
}

async function main() {
  function assertNoQualitySuccess(result) {
    assert.equal(
      result.statuses.some(
        ({ context, state }) =>
          context.startsWith("pr-quality-gates/") && state === "success",
      ),
      false,
    );
  }

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

  const editedTransition = await execute({
    eventName: "pull_request_target",
    listedRuns: [workflowRun()],
  });
  assert.deepEqual(
    editedTransition.statuses
      .filter(
        ({ context }) =>
          !context.startsWith("trusted-quality-transition/"),
      )
      .map(({ context, state }) => ({
        context,
        state,
      })),
    [
      { context: "pr-quality-gates/master", state: "pending" },
      { context: "pr-quality-gates/master", state: "pending" },
      { context: "branch-policy/master", state: "success" },
      { context: "branch-policy/master", state: "success" },
    ],
  );
  assert.deepEqual(
    editedTransition.statuses
      .filter(({ context }) =>
        context.startsWith("trusted-quality-transition/"),
      )
      .map(({ state }) => state),
    ["pending", "pending", "pending", "pending"],
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
  assertNoQualitySuccess(invalid);
  assert(invalid.messages.some((message) => message.startsWith("FAILED:")));

  const invalidWorkflowRun = await execute({
    eventName: "workflow_run",
    currentPull: invalidPull,
  });
  assertNoQualitySuccess(invalidWorkflowRun);

  const invalidAuthorized = await execute({
    currentPull: invalidPull,
    eventPull: invalidPull,
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [
      workflowAuthorization({ headRef: "feature/not-dev" }),
    ],
  });
  assertNoQualitySuccess(invalidAuthorized);
  assert.equal(
    invalidAuthorized.statuses.some(({ context }) =>
      context.startsWith("trusted-workflow-authorization/"),
    ),
    false,
  );

  const invalidAuthorizedWorkflowRun = await execute({
    eventName: "workflow_run",
    currentPull: invalidPull,
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [
      workflowAuthorization({ headRef: "feature/not-dev" }),
    ],
  });
  assertNoQualitySuccess(invalidAuthorizedWorkflowRun);
  assert.equal(
    invalidAuthorizedWorkflowRun.statuses.some(({ context }) =>
      context.startsWith("trusted-workflow-authorization/"),
    ),
    false,
  );

  const changedWorkflow = await execute({ headBlob: CHANGED_BLOB });
  assert.equal(changedWorkflow.statuses[2].state, "failure");
  assert.equal(changedWorkflow.statuses[3].state, "failure");

  assert.deepEqual(
    publishPrPolicy.trustedWorkflowBlobAuthorizations,
    [],
  );
  assert.equal(
    Object.isFrozen(publishPrPolicy.trustedWorkflowBlobAuthorizations),
    true,
  );
  const publisherSource = fs.readFileSync(
    path.join(__dirname, "publish-pr-policy.js"),
    "utf8",
  );
  assert.match(
    publisherSource,
    /const TRUSTED_WORKFLOW_BLOB_AUTHORIZATIONS = Object\.freeze\(\[\]\);/,
  );

  const manualAuthorizedRefresh = await execute({
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
  });
  assert.deepEqual(
    manualAuthorizedRefresh.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["pending", "pending"],
  );
  assert.equal(
    manualAuthorizedRefresh.statuses.some(({ context }) =>
      context.startsWith("trusted-workflow-authorization/"),
    ),
    false,
  );
  assert(
    manualAuthorizedRefresh.messages.some((message) =>
      message.includes(
        "workflow authorization may be consumed only by the selected run's workflow_run",
      ),
    ),
  );

  const editedAuthorizedWorkflow = await execute({
    eventName: "pull_request_target",
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
  });
  assert.deepEqual(
    editedAuthorizedWorkflow.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["pending", "pending"],
  );
  assert.equal(
    editedAuthorizedWorkflow.statuses.some(({ context }) =>
      context.startsWith("trusted-workflow-authorization/"),
    ),
    false,
  );

  const preAuthorizationRefresh = await execute({
    headBlob: CHANGED_BLOB,
    run: workflowRun({
      id: 101,
      created_at: "2026-08-31T12:00:00.000Z",
    }),
    workflowAuthorizations: [workflowAuthorization()],
  });
  assert.deepEqual(
    preAuthorizationRefresh.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["pending", "pending"],
  );
  assert.equal(
    preAuthorizationRefresh.statuses.some(({ context }) =>
      context.startsWith("trusted-workflow-authorization/"),
    ),
    false,
  );

  const equalAuthorizationTimestamp = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [
      workflowAuthorization({ issuedAt: "2026-09-02T10:00:00.000Z" }),
    ],
  });
  assert.deepEqual(
    equalAuthorizationTimestamp.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["pending", "pending"],
  );
  assert.equal(
    equalAuthorizationTimestamp.statuses.some(({ context }) =>
      context.startsWith("trusted-workflow-authorization/"),
    ),
    false,
  );

  const exactAuthorizedCompletion = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
  });
  assert.deepEqual(
    exactAuthorizedCompletion.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );
  assert.deepEqual(
    exactAuthorizedCompletion.statuses
      .filter(({ context }) =>
        context.startsWith("trusted-workflow-authorization/"),
      )
      .map(({ state }) => state),
    ["pending", "success"],
  );

  const mismatchedAuthorizations = [
    { repository: "other/repo" },
    { workflowPath: ".github/workflows/other.yml" },
    { trustedBlob: "6666666666666666666666666666666666666666" },
    { authorizedBlob: "7777777777777777777777777777777777777777" },
    { pullNumber: 64 },
    { headRepository: "other/repo" },
    { headRef: "other-branch" },
    { baseRef: "dev" },
  ];
  for (const override of mismatchedAuthorizations) {
    const result = await execute({
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [workflowAuthorization(override)],
    });
    assert.equal(result.statuses[2].state, "failure");
    assert.equal(result.statuses[3].state, "failure");
  }

  for (const override of [
    { headRef: "*" },
    { issuedAt: "2026-09-03T12:00:00.000Z" },
    {
      issuedAt: "2026-08-20T12:00:00.000Z",
      expiresAt: "2026-09-03T12:00:00.000Z",
    },
    { expiresAt: "2026-09-02T12:00:00.000Z" },
  ]) {
    const result = await execute({
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [workflowAuthorization(override)],
    });
    assert.equal(result.statuses[2].state, "failure");
    assert(
      result.messages.some((message) =>
        message.includes("workflow authorization"),
      ),
    );
  }

  const duplicateAuthorization = workflowAuthorization();
  const duplicateResult = await execute({
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [
      duplicateAuthorization,
      { ...duplicateAuthorization },
    ],
  });
  assert.equal(duplicateResult.statuses[2].state, "failure");
  assert(
    duplicateResult.messages.some((message) =>
      message.includes("duplicate workflow authorization id"),
    ),
  );

  const durableStatuses = [];
  const firstConsumption = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
    authorizationStatuses: durableStatuses,
  });
  assert(
    firstConsumption.statuses.some(
      ({ context, state }) =>
        context ===
          "trusted-workflow-authorization/production-build-555555555555-pr-63" &&
        state === "success",
    ),
  );
  const secondConsumption = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
    authorizationStatuses: durableStatuses,
  });
  assert.deepEqual(
    secondConsumption.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["failure", "failure"],
  );
  assert(
    secondConsumption.messages.some((message) =>
      message.includes("already consumed"),
    ),
  );

  const pendingStatuses = [];
  const pendingEvaluation = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
    authorizationStatuses: pendingStatuses,
    run: workflowRun({ status: "in_progress", conclusion: null }),
  });
  assert.equal(pendingStatuses.length, 0);
  assert.deepEqual(
    pendingEvaluation.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["pending", "pending"],
  );

  const contentUpdatedPull = pull({
    title: "Updated pull request",
    updated_at: "2026-09-02T11:00:00.000Z",
  });
  const staleContentRefresh = await execute({
    currentPull: contentUpdatedPull,
  });
  assert.deepEqual(
    staleContentRefresh.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["pending", "pending"],
  );

  const divergedReceipt = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
    comparisonStatus: "diverged",
  });
  assert.deepEqual(
    divergedReceipt.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["failure", "failure"],
  );

  const validUnrelatedStatus = (id) => ({
    id,
    context: `unrelated-status-${id}`,
    state: "success",
    description: null,
    target_url: null,
  });
  const unrelatedStatuses = [validUnrelatedStatus(1)];
  const unrelatedStatusConsumption = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
    authorizationStatuses: unrelatedStatuses,
  });
  assert.deepEqual(
    unrelatedStatusConsumption.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );

  for (const malformedStatuses of [
    [{}],
    [
      {
        ...validUnrelatedStatus(1),
        context: null,
      },
    ],
    [
      ...Array.from({ length: 100 }, (_, index) =>
        validUnrelatedStatus(index + 1),
      ),
      {
        ...validUnrelatedStatus(101),
        state: "unknown",
      },
    ],
  ]) {
    const malformedInventory = await execute({
      eventName: "workflow_run",
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [workflowAuthorization()],
      authorizationStatuses: malformedStatuses,
    });
    assert.equal(
      malformedInventory.statuses.some(({ context }) =>
        context.startsWith("trusted-workflow-authorization/"),
      ),
      false,
    );
    assert.deepEqual(
      malformedInventory.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["failure", "failure"],
    );
    assert(
      malformedInventory.messages.some((message) =>
        message.includes("receipt entry is malformed"),
      ),
    );
  }

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

  const failedExactCompletion = await execute({
    eventName: "workflow_run",
    run: workflowRun({
      id: 103,
      conclusion: "failure",
      html_url: "https://example.invalid/actions/runs/103",
    }),
    listedRuns: [
      workflowRun({
        id: 102,
        html_url: "https://example.invalid/actions/runs/102",
      }),
    ],
    transitionStatuses: [
      qualityTransitionStatus({
        description:
          `PR #63 edited ${PULL_UPDATED_AT} run 103 ` +
          `content ${PULL_CONTENT_FINGERPRINT}`,
      }),
    ],
  });
  assert.deepEqual(
    failedExactCompletion.statuses.map(({ state }) => state),
    ["failure", "failure"],
  );

  for (const candidateState of [
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
  ]) {
    const mismatchedCompletion = await execute({
      eventName: "workflow_run",
      run: workflowRun({
        id: 103,
        ...candidateState,
        html_url: "https://example.invalid/actions/runs/103",
      }),
      listedRuns: [
        workflowRun({
          id: 102,
          html_url: "https://example.invalid/actions/runs/102",
        }),
        workflowRun({
          id: 103,
          ...candidateState,
          html_url: "https://example.invalid/actions/runs/103",
        }),
      ],
    });
    assert.deepEqual(
      mismatchedCompletion.statuses.map(({ state }) => state),
      ["pending", "pending"],
    );
  }

  const supersededCompletion = await execute({
    eventName: "workflow_run",
    run: workflowRun({
      id: 102,
      html_url: "https://example.invalid/actions/runs/102",
    }),
    listedRuns: [
      workflowRun({
        id: 103,
        status: "in_progress",
        conclusion: null,
        created_at: "2026-09-02T11:00:00.000Z",
        html_url: "https://example.invalid/actions/runs/103",
      }),
    ],
    transitionStatuses: [
      qualityTransitionStatus({
        description:
          `PR #63 edited ${PULL_UPDATED_AT} run 103 ` +
          `content ${PULL_CONTENT_FINGERPRINT}`,
      }),
    ],
  });
  assert.deepEqual(
    supersededCompletion.statuses.map(({ state }) => state),
    ["pending", "pending"],
  );

  for (const eventName of ["workflow_dispatch", "pull_request_target"]) {
    for (const newerRunState of [
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "failure" },
    ]) {
      const staleMarkerRefresh = await execute({
        eventName,
        eventAction: "ready_for_review",
        headBlob: CHANGED_BLOB,
        listedRuns: [
          workflowRun({
            id: 102,
            html_url: "https://example.invalid/actions/runs/102",
          }),
          workflowRun({
            id: 103,
            ...newerRunState,
            created_at: "2026-09-02T11:00:00.000Z",
            html_url: "https://example.invalid/actions/runs/103",
          }),
        ],
        workflowAuthorizations: [workflowAuthorization()],
      });
      assertNoQualitySuccess(staleMarkerRefresh);
      assert.deepEqual(
        staleMarkerRefresh.statuses
          .filter(({ context }) =>
            context.startsWith("pr-quality-gates/"),
          )
          .map(({ state }) => state),
        ["pending", "pending"],
      );
      assert.equal(
        staleMarkerRefresh.statuses.some(({ context }) =>
          context.startsWith("trusted-workflow-authorization/"),
        ),
        false,
      );
    }
  }

  const registrationGapCompletion = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    run: workflowRun({
      id: 101,
      created_at: "2026-09-02T08:00:00.000Z",
      html_url: "https://example.invalid/actions/runs/101",
    }),
    listedRuns: [
      workflowRun({
        id: 101,
        created_at: "2026-09-02T08:00:00.000Z",
        html_url: "https://example.invalid/actions/runs/101",
      }),
    ],
    workflowAuthorizations: [
      workflowAuthorization({
        issuedAt: "2026-09-01T12:00:00.000Z",
      }),
    ],
    transitionStatuses: [
      qualityTransitionStatus({
        description:
          `PR #63 edited ${PULL_UPDATED_AT} run 103 ` +
          `content ${PULL_CONTENT_FINGERPRINT}`,
      }),
    ],
  });
  assert.deepEqual(
    registrationGapCompletion.statuses.map(({ state }) => state),
    ["pending", "pending"],
  );
  assert.equal(
    registrationGapCompletion.statuses.some(({ context }) =>
      context.startsWith("trusted-workflow-authorization/"),
    ),
    false,
  );

  const readyPull = pull({
    updated_at: "2026-09-02T11:00:00.000Z",
  });
  const readyForReview = await execute({
    eventName: "pull_request_target",
    eventAction: "ready_for_review",
    currentPull: readyPull,
    eventPull: readyPull,
  });
  assert.deepEqual(
    readyForReview.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );
  assert.equal(
    readyForReview.statuses.some(({ context }) =>
      context.startsWith("trusted-quality-transition/"),
    ),
    false,
  );

  const metadataRefresh = await execute({
    currentPull: readyPull,
  });
  assert.deepEqual(
    metadataRefresh.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );

  const missingTransition = await execute({
    transitionStatuses: [],
  });
  assert.deepEqual(
    missingTransition.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["pending", "pending"],
  );

  const forgedTransitionCreator = await execute({
    transitionStatuses: [
      qualityTransitionStatus({
        creator: { id: 1, login: "example", type: "User" },
      }),
    ],
  });
  assert.deepEqual(
    forgedTransitionCreator.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["failure", "failure"],
  );
  assert(
    forgedTransitionCreator.messages.some((message) =>
      message.includes("quality transition marker is malformed"),
    ),
  );

  const wrongTransitionWorkflow = await execute({
    policyRunOverrides: {
      workflow_id: 999,
      path: ".github/workflows/other.yml",
    },
  });
  assert.deepEqual(
    wrongTransitionWorkflow.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["failure", "failure"],
  );
  assert(
    wrongTransitionWorkflow.messages.some((message) =>
      message.includes(
        "quality transition marker does not originate from branch-policy",
      ),
    ),
  );

  const wrongTransitionPull = await execute({
    policyRunOverrides: {
      pull_requests: [
        {
          number: 64,
          head: { sha: HEAD_SHA },
          base: { sha: BASE_SHA },
        },
      ],
    },
  });
  assert.deepEqual(
    wrongTransitionPull.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["failure", "failure"],
  );

  const recoveredTransition = await execute({
    transitionStatuses: [
      qualityTransitionStatus({
        description:
          `PR #63 edited ${PULL_UPDATED_AT} run pending ` +
          `content ${PULL_CONTENT_FINGERPRINT}`,
      }),
    ],
  });
  assert.deepEqual(
    recoveredTransition.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );
  assert.deepEqual(
    recoveredTransition.statuses
      .filter(({ context }) =>
        context.startsWith("trusted-quality-transition/"),
      )
      .map(({ state }) => state),
    ["pending", "pending"],
  );

  const recoveredByCompletion = await execute({
    eventName: "workflow_run",
    transitionStatuses: [
      qualityTransitionStatus({
        description:
          `PR #63 edited ${PULL_UPDATED_AT} run pending ` +
          `content ${PULL_CONTENT_FINGERPRINT}`,
      }),
    ],
  });
  assert.deepEqual(
    recoveredByCompletion.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );
  assert.deepEqual(
    recoveredByCompletion.statuses
      .filter(({ context }) =>
        context.startsWith("trusted-quality-transition/"),
      )
      .map(({ state }) => state),
    ["pending", "pending"],
  );

  const unboundTransition = await execute({
    listedRuns: [workflowRun({ created_at: PULL_UPDATED_AT })],
    transitionStatuses: [
      qualityTransitionStatus({
        description:
          `PR #63 edited ${PULL_UPDATED_AT} run pending ` +
          `content ${PULL_CONTENT_FINGERPRINT}`,
      }),
    ],
  });
  assert.deepEqual(
    unboundTransition.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["pending", "pending"],
  );

  const incompleteRunInventory = await execute({
    listedRuns: [workflowRun()],
    listedTotalCount: 2,
  });
  assert.deepEqual(
    incompleteRunInventory.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["failure", "failure"],
  );
  assert(
    incompleteRunInventory.messages.some((message) =>
      message.includes("quality workflow run inventory is incomplete"),
    ),
  );

  const unrelatedRuns = Array.from({ length: 100 }, (_, index) =>
    workflowRun({
      id: 200 + index,
      head_sha: "9999999999999999999999999999999999999999",
      html_url: `https://example.invalid/actions/runs/${200 + index}`,
    }),
  );
  const pagedSupersedingRun = workflowRun({
    id: 500,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-09-02T11:00:00.000Z",
    html_url: "https://example.invalid/actions/runs/500",
  });
  const pagedSupersededCompletion = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    run: workflowRun({
      id: 102,
      html_url: "https://example.invalid/actions/runs/102",
    }),
    listedRuns: [...unrelatedRuns, pagedSupersedingRun],
    workflowAuthorizations: [workflowAuthorization()],
    transitionStatuses: [
      qualityTransitionStatus({
        description:
          `PR #63 edited ${PULL_UPDATED_AT} run 500 ` +
          `content ${PULL_CONTENT_FINGERPRINT}`,
      }),
    ],
  });
  assert.deepEqual(
    pagedSupersededCompletion.statuses.map(({ state }) => state),
    ["pending", "pending"],
  );
  assert.equal(
    pagedSupersededCompletion.statuses.some(({ context }) =>
      context.startsWith("trusted-workflow-authorization/"),
    ),
    false,
  );

  const duplicateRunInventory = await execute({
    listedRuns: [workflowRun(), workflowRun()],
  });
  assert.deepEqual(
    duplicateRunInventory.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["failure", "failure"],
  );
  assert(
    duplicateRunInventory.messages.some((message) =>
      message.includes("quality workflow run inventory contains duplicate IDs"),
    ),
  );

  const equalSecondRun = await execute({
    eventName: "workflow_run",
    run: workflowRun({
      created_at: PULL_UPDATED_AT,
    }),
  });
  assert.deepEqual(
    equalSecondRun.statuses.map(({ state }) => state),
    ["pending", "pending"],
  );

  await assert.rejects(
    execute({
      eventName: "workflow_run",
      run: workflowRun({
        pull_requests: [
          {
            number: 63,
            head: { sha: HEAD_SHA },
            base: { sha: BASE_SHA },
          },
          {
            number: 64,
            head: { sha: HEAD_SHA },
            base: { sha: BASE_SHA },
          },
        ],
      }),
    }),
    /exactly one pull request relation/,
  );

  const multipleRelationRun = workflowRun({
    pull_requests: [
      {
        number: 63,
        head: { sha: HEAD_SHA },
        base: { sha: BASE_SHA },
      },
      {
        number: 64,
        head: { sha: HEAD_SHA },
        base: { sha: BASE_SHA },
      },
    ],
  });
  for (const eventName of ["pull_request_target", "workflow_dispatch"]) {
    const refreshed = await execute({
      eventName,
      run: multipleRelationRun,
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [workflowAuthorization()],
    });
    assertNoQualitySuccess(refreshed);
    assert.equal(
      refreshed.statuses.some(({ context }) =>
        context.startsWith("trusted-workflow-authorization/"),
      ),
      false,
    );
  }

  const changedDuringPublication = pull({
    updated_at: "2026-09-02T11:00:00.000Z",
  });
  const prePublicationStatuses = [];
  await assert.rejects(
    execute({
      currentPulls: [pull(), changedDuringPublication],
      statusSink: prePublicationStatuses,
    }),
    /updatedAt/,
  );
  assert.equal(prePublicationStatuses.length, 4);
  assert(
    prePublicationStatuses.every(({ state }) => state === "pending"),
  );

  const postPublicationStatuses = [];
  await assert.rejects(
    execute({
      currentPulls: [
        pull(),
        pull(),
        changedDuringPublication,
      ],
      statusSink: postPublicationStatuses,
    }),
    /updatedAt/,
  );
  const latestStates = new Map();
  for (const status of postPublicationStatuses) {
    latestStates.set(`${status.sha}:${status.context}`, status.state);
  }
  assert.equal(latestStates.size, 4);
  assert(
    [...latestStates.values()].every((state) => state === "pending"),
  );

  const staleEvent = pull({
    head: {
      ref: "dev",
      sha: "3333333333333333333333333333333333333333",
      repo: { full_name: "example/repo" },
    },
  });
  await assert.rejects(
    execute({ eventName: "pull_request_target", eventPull: staleEvent }),
    /Pull request changed during policy evaluation/,
  );

  const branchPolicy = fs.readFileSync(
    path.join(__dirname, "../workflows/branch-policy.yml"),
    "utf8",
  );
  assert.match(
    branchPolicy,
    /concurrency:\s*\n\s*group: trusted-branch-policy-publisher-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.workflow_run\.pull_requests\[0\]\.number \|\| inputs\.pr_number \}\}\s*\n\s*cancel-in-progress: false/,
  );

  console.log("publish_pr_policy_tests=PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
