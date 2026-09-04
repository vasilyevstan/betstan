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
const TRANSITION_STATUS_CREATED_AT = "2026-09-02T09:30:00.000Z";
const PULL_TITLE = "Test pull request";
const PULL_BODY = "Test body";
const CLI_MANAGED_LABEL = "copilot-cli-managed";
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
const PULL_LABELS_FINGERPRINT = publishPrPolicy.labelsFingerprint([]);

function workflowRunUrl(id) {
  return `https://example.invalid/example/repo/actions/runs/${id}`;
}

function timestampAfter(timestamp, milliseconds) {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function permutations(values) {
  if (values.length <= 1) {
    return [values];
  }
  return values.flatMap((value, index) =>
    permutations([
      ...values.slice(0, index),
      ...values.slice(index + 1),
    ]).map((remaining) => [value, ...remaining]),
  );
}

function transitionDescription({
  version = 3,
  number = 63,
  action = "edited",
  timestamp = PULL_UPDATED_AT,
  binding = 102,
  contentFingerprint = PULL_CONTENT_FINGERPRINT,
  labelsFingerprint = PULL_LABELS_FINGERPRINT,
} = {}) {
  const cutoff = Date.parse(timestamp);
  const bindingText = binding === null ? "p" : binding;
  return (
    `v${version}|${number}|${action}|${cutoff}|${bindingText}|` +
    `${contentFingerprint}|${labelsFingerprint}`
  );
}

function transitionBinding(description) {
  return description.split("|")[4];
}

function transitionLabelsFingerprint(description) {
  return description.split("|")[6];
}

function legacyTransitionDescription({
  action = "edited",
  timestamp = PULL_UPDATED_AT,
  runId = 102,
  contentFingerprint = PULL_CONTENT_FINGERPRINT,
} = {}) {
  return (
    `PR #63 ${action} ${timestamp} run ` +
    `${runId === null ? "pending" : runId} ` +
    `content ${contentFingerprint}`
  );
}

function pull(overrides = {}) {
  return {
    number: 63,
    state: "open",
    mergeable: true,
    merge_commit_sha: MERGE_SHA,
    updated_at: PULL_UPDATED_AT,
    title: PULL_TITLE,
    body: PULL_BODY,
    labels: [],
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
  const id = overrides.id ?? 102;
  return {
    id,
    run_attempt: 1,
    workflow_id: 202,
    path: ".github/workflows/production-build.yml",
    event: "pull_request",
    head_sha: HEAD_SHA,
    head_repository: { full_name: "example/repo" },
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-02T10:00:00.000Z",
    html_url: workflowRunUrl(id),
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
    description: transitionDescription(),
    target_url: "https://example.invalid/example/repo/actions/runs/100",
    created_at: TRANSITION_STATUS_CREATED_AT,
    creator: ACTIONS_BOT,
    ...overrides,
  };
}

function issueEvent(overrides = {}) {
  return {
    id: 700,
    event: "labeled",
    label: { name: CLI_MANAGED_LABEL },
    created_at: PULL_UPDATED_AT,
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
  policyRunOverridesById = {},
  eventLabelName,
  contextRunId = 101,
  issueEvents = [issueEvent()],
  issueEventPages,
  issueEventError,
  issueEventListCalls,
  staleTransitionStatusReads = false,
  transitionStatusCreatedAt = NOW,
  workflowRunListCalls,
} = {}) {
  const statuses = statusSink || [];
  const messages = [];
  const transitionStatusReadSnapshot = transitionStatuses.slice();
  let pullGetCount = 0;
  const github = {
    rest: {
      issues: {
        listEvents: async ({
          owner,
          repo,
          issue_number: issueNumber,
          per_page: perPage,
          page,
        }) => {
          assert.equal(owner, "example");
          assert.equal(repo, "repo");
          assert.equal(issueNumber, 63);
          assert.equal(perPage, 100);
          issueEventListCalls?.push({ page, perPage });
          if (issueEventError) {
            throw issueEventError;
          }
          const events = issueEventPages
            ? page <= issueEventPages.length
              ? issueEventPages[page - 1]
              : []
            : issueEvents.slice((page - 1) * perPage, page * perPage);
          return { data: events };
        },
      },
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
              created_at: transitionStatusCreatedAt,
              creator: ACTIONS_BOT,
            });
          }
        },
        listCommitStatusesForRef: async ({ ref, page }) => {
          const inventory =
            ref === MERGE_SHA
              ? staleTransitionStatusReads
                ? transitionStatusReadSnapshot
                : transitionStatuses
              : authorizationStatuses;
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
            ...(policyRunOverridesById[runId] || {}),
          },
        }),
        listWorkflowRuns: async ({ page, per_page: perPage }) => {
          workflowRunListCalls?.push({ page, perPage });
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
          : {
              action: eventAction,
              pull_request: eventPull,
              ...((eventAction === "labeled" ||
                eventAction === "unlabeled") && {
                label: { name: eventLabelName ?? CLI_MANAGED_LABEL },
              }),
            },
    repo: { owner: "example", repo: "repo" },
    runId: contextRunId,
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

  function assertQualityFailure(result) {
    const states = result.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state);
    assert(states.length > 0);
    assert(
      states.every((state) => state === "failure"),
      `expected only quality failures, received: ${states.join(", ")}`,
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
    transitionStatuses: [],
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

  const managedLabels = [{ name: CLI_MANAGED_LABEL }];
  const managedLabelsFingerprint =
    publishPrPolicy.labelsFingerprint([CLI_MANAGED_LABEL]);
  const featureHead = {
    ref: "feature/marker-recovery",
    sha: HEAD_SHA,
    repo: { full_name: "example/repo" },
  };
  const devBase = { ref: "dev", sha: BASE_SHA };
  const openedEventPull = pull({
    labels: [],
    head: featureHead,
    base: devBase,
  });
  const openedRacePull = pull({
    updated_at: "2026-09-02T09:00:02.000Z",
    labels: managedLabels,
    head: featureHead,
    base: devBase,
  });
  const directRaceTransitions = [];
  const directRace = await execute({
    eventName: "pull_request_target",
    eventAction: "opened",
    eventPull: openedEventPull,
    currentPull: openedRacePull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: directRaceTransitions,
  });
  assertNoQualitySuccess(directRace);
  assert.equal(
    directRaceTransitions[0].description,
    transitionDescription({
      action: "opened",
      binding: "u",
      labelsFingerprint: managedLabelsFingerprint,
    }),
  );
  assert(
    directRace.statuses
      .filter(({ context }) =>
        context.startsWith("trusted-quality-transition/"),
      )
      .every(({ sha }) => sha === MERGE_SHA),
  );
  const directRaceTransitionCount = directRaceTransitions.length;
  const directPreLabelManual = await execute({
    currentPull: openedRacePull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: directRaceTransitions,
  });
  assertNoQualitySuccess(directPreLabelManual);
  assert.equal(directRaceTransitions.length, directRaceTransitionCount);
  assert.equal(
    transitionBinding(directRaceTransitions[0].description),
    "u",
  );

  const directPreLabelCompletion = await execute({
    eventName: "workflow_run",
    currentPull: openedRacePull,
    run: workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: directRaceTransitions,
  });
  assertNoQualitySuccess(directPreLabelCompletion);
  assert.equal(directRaceTransitions.length, directRaceTransitionCount);

  const directPreLabelAuthorizationStatuses = [];
  const directPreLabelAuthorizedCompletion = await execute({
    eventName: "workflow_run",
    currentPull: openedRacePull,
    run: workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [
      workflowAuthorization({
        headRef: "feature/marker-recovery",
        baseRef: "dev",
      }),
    ],
    authorizationStatuses: directPreLabelAuthorizationStatuses,
    transitionStatuses: directRaceTransitions,
  });
  assertNoQualitySuccess(directPreLabelAuthorizedCompletion);
  assert.equal(directPreLabelAuthorizationStatuses.length, 0);
  assert.equal(directRaceTransitions.length, directRaceTransitionCount);

  const directPreLabelOpenedReplay = await execute({
    eventName: "pull_request_target",
    eventAction: "opened",
    eventPull: openedEventPull,
    currentPull: openedRacePull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: directRaceTransitions,
  });
  assertNoQualitySuccess(directPreLabelOpenedReplay);
  assert.equal(directRaceTransitions.length, directRaceTransitionCount);

  const directOpeningLabelConfirmation = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: openedRacePull,
    currentPull: openedRacePull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: directRaceTransitions,
  });
  assert.deepEqual(
    directOpeningLabelConfirmation.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success"],
  );
  assert.equal(
    directRaceTransitions.length,
    directRaceTransitionCount + 2,
  );
  assert.equal(
    transitionBinding(directRaceTransitions[0].description),
    "102",
  );
  assert.equal(
    transitionBinding(directRaceTransitions[1].description),
    "p",
  );
  const directRaceCompletion = await execute({
    eventName: "workflow_run",
    currentPull: openedRacePull,
    run: workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: directRaceTransitions,
  });
  assert.deepEqual(
    directRaceCompletion.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success"],
  );
  const confirmedDirectTransitionCount = directRaceTransitions.length;
  const directLabelReplay = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: openedRacePull,
    currentPull: openedRacePull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: directRaceTransitions,
  });
  assert.deepEqual(
    directLabelReplay.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success"],
  );
  assert.equal(
    directRaceTransitions.length,
    confirmedDirectTransitionCount,
  );

  const delayedConfirmedOpeningPull = pull({
    updated_at: timestampAfter(PULL_UPDATED_AT, 86_400_000),
    labels: managedLabels,
    head: featureHead,
    base: devBase,
  });
  const confirmedOpeningTombstoneCount = () =>
    directRaceTransitions.filter(
      ({ description }) =>
        transitionBinding(description) === "x",
    ).length;
  const delayedConfirmedOpenedReplay = await execute({
    eventName: "pull_request_target",
    eventAction: "opened",
    eventPull: openedEventPull,
    currentPull: delayedConfirmedOpeningPull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: directRaceTransitions,
  });
  assert.deepEqual(
    delayedConfirmedOpenedReplay.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success"],
  );
  assert.equal(confirmedOpeningTombstoneCount(), 0);
  assert.equal(
    transitionBinding(directRaceTransitions[0].description),
    "102",
  );
  for (const eventName of ["workflow_dispatch", "workflow_run"]) {
    const confirmedRefresh = await execute({
      eventName,
      currentPull: delayedConfirmedOpeningPull,
      run: workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
      ],
      transitionStatuses: directRaceTransitions,
    });
    assert.deepEqual(
      confirmedRefresh.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["success"],
    );
    assert.equal(confirmedOpeningTombstoneCount(), 0);
    assert.equal(
      transitionBinding(directRaceTransitions[0].description),
      "102",
    );
  }

  const directProofOnlyTransitions = [
    qualityTransitionStatus({
      context: "trusted-quality-transition/dev",
      created_at: "2026-09-02T09:00:03.000Z",
      description: transitionDescription({
        action: "opened",
        binding: "u",
        labelsFingerprint: managedLabelsFingerprint,
      }),
    }),
  ];
  const directProofOnly = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: openedRacePull,
    currentPull: openedRacePull,
    listedRuns: [],
    transitionStatuses: directProofOnlyTransitions,
  });
  assertNoQualitySuccess(directProofOnly);
  assert.equal(
    transitionBinding(directProofOnlyTransitions[0].description),
    "p",
  );
  assert.equal(directProofOnlyTransitions.length, 2);

  const featureAuthorization = workflowAuthorization({
    headRef: "feature/marker-recovery",
    baseRef: "dev",
  });
  const directProofReplayCount = directProofOnlyTransitions.length;
  const directProofReplayReceipts = [];
  const directProofReplayRunCalls = [];
  const directProofReplay = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: openedRacePull,
    currentPull: openedRacePull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
    ],
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [featureAuthorization],
    authorizationStatuses: directProofReplayReceipts,
    transitionStatuses: directProofOnlyTransitions,
    workflowRunListCalls: directProofReplayRunCalls,
  });
  assertNoQualitySuccess(directProofReplay);
  assert.equal(directProofOnlyTransitions.length, directProofReplayCount);
  assert.equal(directProofReplayRunCalls.length, 0);
  assert.equal(directProofReplayReceipts.length, 0);
  assert.equal(
    transitionBinding(directProofOnlyTransitions[0].description),
    "p",
  );

  for (const eventName of ["workflow_dispatch", "workflow_run"]) {
    const delayedBindingTransitions = directProofOnlyTransitions.map(
      (status) => ({ ...status }),
    );
    const delayedBindingRun = workflowRun({
      created_at: "2026-09-02T09:10:00.000Z",
    });
    const delayedBinding = await execute({
      eventName,
      currentPull: openedRacePull,
      run: delayedBindingRun,
      listedRuns: [delayedBindingRun],
      transitionStatuses: delayedBindingTransitions,
    });
    assert.deepEqual(
      delayedBinding.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["success"],
    );
    assert.equal(
      transitionBinding(delayedBindingTransitions[0].description),
      "102",
    );
  }

  const authorizedDirectTransitions = [
    qualityTransitionStatus({
      context: "trusted-quality-transition/dev",
      created_at: "2026-09-02T09:00:03.000Z",
      description: transitionDescription({
        action: "opened",
        binding: "u",
        labelsFingerprint: managedLabelsFingerprint,
      }),
    }),
  ];
  const authorizedDirectReceipts = [];
  const authorizedDirectLabel = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: openedRacePull,
    currentPull: openedRacePull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
    ],
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [featureAuthorization],
    authorizationStatuses: authorizedDirectReceipts,
    transitionStatuses: authorizedDirectTransitions,
  });
  assertNoQualitySuccess(authorizedDirectLabel);
  assert.equal(authorizedDirectReceipts.length, 0);
  assert.equal(
    transitionBinding(authorizedDirectTransitions[0].description),
    "102",
  );
  assert.equal(
    transitionBinding(authorizedDirectTransitions[1].description),
    "p",
  );
  const authorizedDirectCompletion = await execute({
    eventName: "workflow_run",
    currentPull: openedRacePull,
    run: workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
    ],
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [featureAuthorization],
    authorizationStatuses: authorizedDirectReceipts,
    transitionStatuses: authorizedDirectTransitions,
  });
  assert.deepEqual(
    authorizedDirectCompletion.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success"],
  );
  assert.equal(authorizedDirectReceipts.length, 2);

  for (const [eventAction, eventPull, currentPull] of [
    [
      "opened",
      openedEventPull,
      pull({
        updated_at: "2026-09-02T09:00:02.000Z",
        labels: [...managedLabels, { name: "reviewed" }],
        head: featureHead,
        base: devBase,
      }),
    ],
    [
      "opened",
      pull({
        labels: managedLabels,
        head: featureHead,
        base: devBase,
      }),
      openedRacePull,
    ],
    [
      "opened",
      openedEventPull,
      pull({
        updated_at: "2026-09-02T09:00:02.000Z",
        labels: [{ name: "copilot-managed" }],
        head: featureHead,
        base: devBase,
      }),
    ],
    [
      "opened",
      openedEventPull,
      pull({
        updated_at: "2026-09-02T09:00:02.000Z",
        title: "Changed title",
        labels: managedLabels,
        head: featureHead,
        base: devBase,
      }),
    ],
    [
      "opened",
      openedEventPull,
      pull({
        updated_at: "2026-09-02T09:00:02.000Z",
        labels: managedLabels,
        head: { ...featureHead, sha: "3".repeat(40) },
        base: devBase,
      }),
    ],
    [
      "opened",
      openedEventPull,
      pull({
        updated_at: "2026-09-02T09:00:02.000Z",
        labels: managedLabels,
        head: featureHead,
        base: { ...devBase, sha: "4".repeat(40) },
      }),
    ],
    [
      "opened",
      openedEventPull,
      pull({
        updated_at: "2026-09-02T09:00:02.000Z",
        labels: managedLabels,
        head: {
          ...featureHead,
          repo: { full_name: "other/repo" },
        },
        base: devBase,
      }),
    ],
    ["edited", openedEventPull, openedRacePull],
  ]) {
    await assert.rejects(
      execute({
        eventName: "pull_request_target",
        eventAction,
        eventPull,
        currentPull,
        transitionStatuses: [],
      }),
      /Pull request changed during policy evaluation/,
    );
  }

  const inverseTransitions = [];
  const initialOpened = await execute({
    eventName: "pull_request_target",
    eventAction: "opened",
    eventPull: openedEventPull,
    currentPull: openedEventPull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: inverseTransitions,
    contextRunId: 111,
  });
  assertNoQualitySuccess(initialOpened);
  const inverseLabeled = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: openedRacePull,
    currentPull: openedRacePull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: inverseTransitions,
    contextRunId: 112,
  });
  assert.equal(
    inverseTransitions[0].description,
    transitionDescription({
      action: "opened",
      binding: 102,
      labelsFingerprint: managedLabelsFingerprint,
    }),
  );
  assert.equal(
    inverseTransitions[0].target_url,
    "https://example.invalid/example/repo/actions/runs/111",
  );
  assert.deepEqual(
    inverseLabeled.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success"],
  );

  const backwardsOpeningPull = pull({
    updated_at: timestampAfter(PULL_UPDATED_AT, -1),
    labels: managedLabels,
    head: featureHead,
    base: devBase,
  });
  const backwardsOpeningTransitions = [];
  await assert.rejects(
    execute({
      eventName: "pull_request_target",
      eventAction: "opened",
      eventPull: openedEventPull,
      currentPull: backwardsOpeningPull,
      transitionStatuses: backwardsOpeningTransitions,
    }),
    /Pull request changed during policy evaluation/,
  );
  assert.equal(backwardsOpeningTransitions.length, 0);

  const staleDirectTransitions = [
    qualityTransitionStatus({
      context: "trusted-quality-transition/dev",
      description: transitionDescription({
        action: "opened",
        binding: null,
        contentFingerprint: PULL_CONTENT_FINGERPRINT,
        labelsFingerprint: managedLabelsFingerprint,
      }),
    }),
  ];
  const staleDirectLabel = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: backwardsOpeningPull,
    currentPull: backwardsOpeningPull,
    transitionStatuses: staleDirectTransitions,
  });
  assertNoQualitySuccess(staleDirectLabel);
  assert.equal(staleDirectTransitions.length, 1);
  assert.equal(
    staleDirectTransitions[0].description,
    transitionDescription({
      action: "opened",
      binding: null,
      contentFingerprint: PULL_CONTENT_FINGERPRINT,
      labelsFingerprint: managedLabelsFingerprint,
    }),
  );

  const staleInverseTransitions = [
    qualityTransitionStatus({
      context: "trusted-quality-transition/dev",
      description: transitionDescription({
        action: "opened",
        binding: null,
        contentFingerprint: PULL_CONTENT_FINGERPRINT,
      }),
    }),
  ];
  const staleInverseLabel = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: backwardsOpeningPull,
    currentPull: backwardsOpeningPull,
    transitionStatuses: staleInverseTransitions,
  });
  assertNoQualitySuccess(staleInverseLabel);
  assert.equal(staleInverseTransitions.length, 1);
  assert.equal(
    staleInverseTransitions[0].description,
    transitionDescription({
      action: "opened",
      binding: null,
      contentFingerprint: PULL_CONTENT_FINGERPRINT,
    }),
  );

  for (const { offset, reconciles } of [
    { offset: 0, reconciles: true },
    { offset: 1, reconciles: true },
    { offset: 299_999, reconciles: true },
    { offset: 300_000, reconciles: true },
    { offset: 300_001, reconciles: false },
  ]) {
    const labelTimestamp = timestampAfter(PULL_UPDATED_AT, offset);
    const boundaryPull = pull({
      updated_at: labelTimestamp,
      labels: managedLabels,
      head: featureHead,
      base: devBase,
    });
    const boundaryTransitions = [];
    const openedBoundary = await execute({
      eventName: "pull_request_target",
      eventAction: "opened",
      eventPull: openedEventPull,
      currentPull: boundaryPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
      ],
      transitionStatuses: boundaryTransitions,
    });
    assertNoQualitySuccess(openedBoundary);

    if (!reconciles) {
      assert.equal(boundaryTransitions.length, 0);
      continue;
    }

    assert(
      boundaryTransitions.some(
        ({ description }) =>
          transitionLabelsFingerprint(description) ===
          managedLabelsFingerprint,
      ),
    );
    const directBoundaryConfirmation = await execute({
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: boundaryPull,
      currentPull: boundaryPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
      ],
      transitionStatuses: boundaryTransitions,
    });
    const qualityStates = directBoundaryConfirmation.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state);
    assert(qualityStates.length > 0);
    assert(qualityStates.every((state) => state === "success"));
  }

  for (const { offset, reconciles } of [
    { offset: 0, reconciles: true },
    { offset: 1, reconciles: true },
    { offset: 299_999, reconciles: true },
    { offset: 300_000, reconciles: true },
    { offset: 300_001, reconciles: false },
  ]) {
    const labelTimestamp = timestampAfter(PULL_UPDATED_AT, offset);
    const boundaryPull = pull({
      updated_at: labelTimestamp,
      labels: managedLabels,
      head: featureHead,
      base: devBase,
    });
    const boundaryTransitions = [
      qualityTransitionStatus({
        context: "trusted-quality-transition/dev",
        created_at: "2026-09-02T08:59:00.000Z",
        description: transitionDescription({
          action: "opened",
          binding: 102,
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
        }),
      }),
    ];
    const inverseBoundary = await execute({
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: boundaryPull,
      currentPull: boundaryPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
      ],
      transitionStatuses: boundaryTransitions,
    });

    if (reconciles) {
      assert.equal(
        boundaryTransitions[0].description,
        transitionDescription({
          action: "opened",
          binding: 102,
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
          labelsFingerprint: managedLabelsFingerprint,
        }),
      );
      const qualityStates = inverseBoundary.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state);
      assert(qualityStates.length > 0);
      assert(qualityStates.every((state) => state === "success"));
    } else {
      assert.equal(
        boundaryTransitions[0].description,
        transitionDescription({
          action: "opened",
          binding: "x",
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
          labelsFingerprint: managedLabelsFingerprint,
        }),
        `inverse opening offset ${offset} must tombstone`,
      );
      assertNoQualitySuccess(inverseBoundary);
    }
  }

  const wholeSecondTimestamp = "2026-09-02T09:00:00Z";
  const wholeSecondOpenedPull = pull({
    updated_at: wholeSecondTimestamp,
    labels: [],
    head: featureHead,
    base: devBase,
  });
  const wholeSecondManagedPull = pull({
    updated_at: wholeSecondTimestamp,
    labels: managedLabels,
    head: featureHead,
    base: devBase,
  });
  const wholeSecondDirectTransitions = [];
  const wholeSecondOpened = await execute({
    eventName: "pull_request_target",
    eventAction: "opened",
    eventPull: wholeSecondOpenedPull,
    currentPull: wholeSecondManagedPull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: wholeSecondDirectTransitions,
    contextRunId: 121,
  });
  assertNoQualitySuccess(wholeSecondOpened);
  assert(
    wholeSecondDirectTransitions.some(
      ({ description }) =>
        transitionLabelsFingerprint(description) ===
        managedLabelsFingerprint,
    ),
  );
  assert.equal(
    transitionBinding(wholeSecondDirectTransitions[0].description),
    "u",
  );
  const wholeSecondDirectCount = wholeSecondDirectTransitions.length;
  const wholeSecondDirect = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: wholeSecondManagedPull,
    currentPull: wholeSecondManagedPull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: wholeSecondDirectTransitions,
    contextRunId: 122,
  });
  const wholeSecondDirectStates = wholeSecondDirect.statuses
    .filter(({ context }) => context.startsWith("pr-quality-gates/"))
    .map(({ state }) => state);
  assert(wholeSecondDirectStates.length > 0);
  assert(wholeSecondDirectStates.every((state) => state === "success"));
  assert.equal(
    wholeSecondDirectTransitions.length,
    wholeSecondDirectCount + 2,
  );

  const wholeSecondInverseTransitions = [
    qualityTransitionStatus({
      context: "trusted-quality-transition/dev",
      created_at: wholeSecondTimestamp,
      description: transitionDescription({
        action: "opened",
        timestamp: wholeSecondTimestamp,
        binding: 102,
        contentFingerprint: PULL_CONTENT_FINGERPRINT,
      }),
    }),
  ];
  const wholeSecondInverse = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: wholeSecondManagedPull,
    currentPull: wholeSecondManagedPull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    transitionStatuses: wholeSecondInverseTransitions,
    transitionStatusCreatedAt: wholeSecondTimestamp,
  });
  const wholeSecondInverseStates = wholeSecondInverse.statuses
    .filter(({ context }) => context.startsWith("pr-quality-gates/"))
    .map(({ state }) => state);
  assert(wholeSecondInverseStates.length > 0);
  assert(wholeSecondInverseStates.every((state) => state === "success"));
  assert.equal(
    wholeSecondInverseTransitions[0].description,
    transitionDescription({
      action: "opened",
      timestamp: wholeSecondTimestamp,
      binding: 102,
      contentFingerprint: PULL_CONTENT_FINGERPRINT,
      labelsFingerprint: managedLabelsFingerprint,
    }),
  );
  const wholeSecondInverseCount = wholeSecondInverseTransitions.length;
  const wholeSecondInverseReplayReceipts = [];
  const wholeSecondInverseReplay = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: wholeSecondManagedPull,
    currentPull: wholeSecondManagedPull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    workflowAuthorizations: [
      workflowAuthorization({
        headRef: "feature/marker-recovery",
        baseRef: "dev",
      }),
    ],
    authorizationStatuses: wholeSecondInverseReplayReceipts,
    transitionStatuses: wholeSecondInverseTransitions,
    transitionStatusCreatedAt: wholeSecondTimestamp,
  });
  assert.deepEqual(
    wholeSecondInverseReplay.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success"],
  );
  assert.equal(
    wholeSecondInverseTransitions.length,
    wholeSecondInverseCount,
  );
  assert.equal(
    wholeSecondInverseTransitions.some(
      ({ description }) => transitionBinding(description) === "x",
    ),
    false,
  );
  assert.equal(wholeSecondInverseReplayReceipts.length, 0);

  const wholeSecondInversePendingTransitions = [
    qualityTransitionStatus({
      context: "trusted-quality-transition/dev",
      created_at: wholeSecondTimestamp,
      description: transitionDescription({
        action: "opened",
        timestamp: wholeSecondTimestamp,
        binding: null,
        contentFingerprint: PULL_CONTENT_FINGERPRINT,
      }),
    }),
  ];
  const wholeSecondInversePending = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: wholeSecondManagedPull,
    currentPull: wholeSecondManagedPull,
    listedRuns: [],
    transitionStatuses: wholeSecondInversePendingTransitions,
    transitionStatusCreatedAt: wholeSecondTimestamp,
  });
  assertNoQualitySuccess(wholeSecondInversePending);
  assert.equal(
    transitionBinding(
      wholeSecondInversePendingTransitions[0].description,
    ),
    "p",
  );
  assert.equal(
    transitionLabelsFingerprint(
      wholeSecondInversePendingTransitions[0].description,
    ),
    managedLabelsFingerprint,
  );
  const wholeSecondInversePendingCount =
    wholeSecondInversePendingTransitions.length;
  const wholeSecondInversePendingReplayCalls = [];
  const wholeSecondInversePendingReplayReceipts = [];
  const wholeSecondInversePendingReplay = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: wholeSecondManagedPull,
    currentPull: wholeSecondManagedPull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
    ],
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [
      workflowAuthorization({
        headRef: "feature/marker-recovery",
        baseRef: "dev",
      }),
    ],
    authorizationStatuses: wholeSecondInversePendingReplayReceipts,
    transitionStatuses: wholeSecondInversePendingTransitions,
    transitionStatusCreatedAt: wholeSecondTimestamp,
    workflowRunListCalls: wholeSecondInversePendingReplayCalls,
  });
  assertNoQualitySuccess(wholeSecondInversePendingReplay);
  assert.equal(
    wholeSecondInversePendingTransitions.length,
    wholeSecondInversePendingCount,
  );
  assert.equal(
    wholeSecondInversePendingTransitions.some(
      ({ description }) => transitionBinding(description) === "x",
    ),
    false,
  );
  assert.equal(wholeSecondInversePendingReplayCalls.length, 0);
  assert.equal(wholeSecondInversePendingReplayReceipts.length, 0);

  for (const binding of [null, 102]) {
    const laterMarkerReplayTransitions = [
      qualityTransitionStatus({
        id: 901,
        context: "trusted-quality-transition/dev",
        created_at: timestampAfter(wholeSecondTimestamp, 1_000),
        description: transitionDescription({
          action: "opened",
          timestamp: wholeSecondTimestamp,
          binding,
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
      qualityTransitionStatus({
        id: 900,
        context: "trusted-quality-transition/dev",
        created_at: timestampAfter(wholeSecondTimestamp, -1_000),
        description: transitionDescription({
          action: "opened",
          timestamp: wholeSecondTimestamp,
          binding,
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
        }),
      }),
    ];
    const laterMarkerReplayReceipts = [];
    const laterMarkerReplay = await execute({
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: wholeSecondManagedPull,
      currentPull: wholeSecondManagedPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
      ],
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [
        workflowAuthorization({
          headRef: "feature/marker-recovery",
          baseRef: "dev",
        }),
      ],
      authorizationStatuses: laterMarkerReplayReceipts,
      transitionStatuses: laterMarkerReplayTransitions,
    });
    assertNoQualitySuccess(laterMarkerReplay);
    assert.equal(
      laterMarkerReplayTransitions.some(
        ({ description }) => transitionBinding(description) === "x",
      ),
      false,
    );
    assert.equal(laterMarkerReplayTransitions.length, 2);
    assert.equal(laterMarkerReplayReceipts.length, 0);
  }

  for (const binding of [null, 102]) {
    for (const offset of [1, 300_000]) {
      const laterReAddPull = pull({
        updated_at: timestampAfter(wholeSecondTimestamp, offset),
        labels: managedLabels,
        head: featureHead,
        base: devBase,
      });
      const laterReAddTransitions = [
        qualityTransitionStatus({
          id: 901,
          context: "trusted-quality-transition/dev",
          created_at: wholeSecondTimestamp,
          description: transitionDescription({
            action: "opened",
            timestamp: wholeSecondTimestamp,
            binding,
            contentFingerprint: PULL_CONTENT_FINGERPRINT,
            labelsFingerprint: managedLabelsFingerprint,
          }),
        }),
        qualityTransitionStatus({
          id: 900,
          context: "trusted-quality-transition/dev",
          created_at: wholeSecondTimestamp,
          description: transitionDescription({
            action: "opened",
            timestamp: wholeSecondTimestamp,
            binding,
            contentFingerprint: PULL_CONTENT_FINGERPRINT,
          }),
        }),
      ];
      const laterReAddCalls = [];
      const laterReAddReceipts = [];
      for (let replay = 0; replay < 2; replay += 1) {
        const laterReAdd = await execute({
          eventName: "pull_request_target",
          eventAction: "labeled",
          eventLabelName: CLI_MANAGED_LABEL,
          eventPull: laterReAddPull,
          currentPull: laterReAddPull,
          listedRuns: [
            workflowRun({
              created_at: timestampAfter(wholeSecondTimestamp, 300_001),
            }),
          ],
          headBlob: CHANGED_BLOB,
          workflowAuthorizations: [
            workflowAuthorization({
              headRef: "feature/marker-recovery",
              baseRef: "dev",
            }),
          ],
          authorizationStatuses: laterReAddReceipts,
          transitionStatuses: laterReAddTransitions,
          workflowRunListCalls: laterReAddCalls,
        });
        assertNoQualitySuccess(laterReAdd);
      }
      assert.equal(
        laterReAddTransitions.filter(
          ({ description }) => transitionBinding(description) === "x",
        ).length,
        1,
        `inverse ${binding === null ? "p" : "run"} re-add at ${offset} ms must tombstone once`,
      );
      assert.equal(laterReAddCalls.length, 0);
      assert.equal(laterReAddReceipts.length, 0);
    }
  }

  const recoveredOpeningTransitions = ({ ancestry, binding }) => {
    const confirmed = qualityTransitionStatus({
      id: 901,
      context: "trusted-quality-transition/dev",
      created_at: wholeSecondTimestamp,
      description: transitionDescription({
        action: "opened",
        timestamp: wholeSecondTimestamp,
        binding,
        contentFingerprint: PULL_CONTENT_FINGERPRINT,
        labelsFingerprint: managedLabelsFingerprint,
      }),
    });
    const predecessor =
      ancestry === "direct"
        ? qualityTransitionStatus({
            id: 900,
            context: "trusted-quality-transition/dev",
            created_at: timestampAfter(wholeSecondTimestamp, 1_000),
            description: transitionDescription({
              action: "opened",
              timestamp: wholeSecondTimestamp,
              binding: "u",
              contentFingerprint: PULL_CONTENT_FINGERPRINT,
              labelsFingerprint: managedLabelsFingerprint,
            }),
          })
        : qualityTransitionStatus({
            id: 900,
            context: "trusted-quality-transition/dev",
            created_at: timestampAfter(wholeSecondTimestamp, -1_000),
            description: transitionDescription({
              action: "opened",
              timestamp: wholeSecondTimestamp,
              binding,
              contentFingerprint: PULL_CONTENT_FINGERPRINT,
            }),
          });
    return [confirmed, predecessor];
  };
  const sameSecondManagedLabelChurn = [
    issueEvent({ id: 701, created_at: wholeSecondTimestamp }),
    issueEvent({
      id: 702,
      event: "unlabeled",
      created_at: wholeSecondTimestamp,
    }),
    issueEvent({ id: 703, created_at: wholeSecondTimestamp }),
  ];

  for (const ancestry of ["direct", "inverse"]) {
    const firstProofTransitions =
      ancestry === "direct"
        ? [
            qualityTransitionStatus({
              context: "trusted-quality-transition/dev",
              created_at: timestampAfter(wholeSecondTimestamp, 1_000),
              description: transitionDescription({
                action: "opened",
                timestamp: wholeSecondTimestamp,
                binding: "u",
                contentFingerprint: PULL_CONTENT_FINGERPRINT,
                labelsFingerprint: managedLabelsFingerprint,
              }),
            }),
          ]
        : [
            qualityTransitionStatus({
              context: "trusted-quality-transition/dev",
              created_at: timestampAfter(wholeSecondTimestamp, -1_000),
              description: transitionDescription({
                action: "opened",
                timestamp: wholeSecondTimestamp,
                binding: null,
                contentFingerprint: PULL_CONTENT_FINGERPRINT,
              }),
            }),
          ];
    const firstProofCalls = [];
    const firstProofRunCalls = [];
    const firstProofReceipts = [];
    const firstProof = await execute({
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: wholeSecondManagedPull,
      currentPull: wholeSecondManagedPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
      ],
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [
        workflowAuthorization({
          headRef: "feature/marker-recovery",
          baseRef: "dev",
        }),
      ],
      authorizationStatuses: firstProofReceipts,
      transitionStatuses: firstProofTransitions,
      workflowRunListCalls: firstProofRunCalls,
      issueEvents: sameSecondManagedLabelChurn,
      issueEventListCalls: firstProofCalls,
    });
    assertQualityFailure(firstProof);
    assert.equal(
      firstProofTransitions.filter(
        ({ description }) => transitionBinding(description) === "x",
      ).length,
      1,
    );
    assert.equal(firstProofCalls.length, 1);
    assert.equal(firstProofRunCalls.length, 0);
    assert.equal(firstProofReceipts.length, 0);
  }

  for (const { ancestry, binding, eventName } of [
    { ancestry: "direct", binding: null, eventName: "workflow_run" },
    { ancestry: "direct", binding: 102, eventName: "workflow_dispatch" },
    { ancestry: "inverse", binding: null, eventName: "workflow_dispatch" },
    { ancestry: "inverse", binding: 102, eventName: "workflow_run" },
    {
      ancestry: "inverse",
      binding: 102,
      eventName: "pull_request_target",
    },
  ]) {
    const churnTransitions = recoveredOpeningTransitions({
      ancestry,
      binding,
    });
    const churnReceipts = [];
    const churnRunCalls = [];
    const churnLedgerCalls = [];
    const churnEvent =
      eventName === "pull_request_target"
        ? {
            eventName,
            eventAction: "opened",
            eventPull: wholeSecondOpenedPull,
          }
        : { eventName };
    const churn = await execute({
      ...churnEvent,
      currentPull: wholeSecondManagedPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
      ],
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [
        workflowAuthorization({
          headRef: "feature/marker-recovery",
          baseRef: "dev",
        }),
      ],
      authorizationStatuses: churnReceipts,
      transitionStatuses: churnTransitions,
      workflowRunListCalls: churnRunCalls,
      issueEvents: sameSecondManagedLabelChurn,
      issueEventListCalls: churnLedgerCalls,
    });
    assertQualityFailure(churn);
    const churnTombstoneCount = () =>
      churnTransitions.filter(
        ({ description }) => transitionBinding(description) === "x",
      ).length;
    assert.equal(churnTombstoneCount(), 1);
    assert.equal(churnLedgerCalls.length, 1);
    assert.equal(churnRunCalls.length, 0);
    assert.equal(churnReceipts.length, 0);

    const repeatedChurn = await execute({
      ...churnEvent,
      currentPull: wholeSecondManagedPull,
      transitionStatuses: churnTransitions,
      issueEvents: sameSecondManagedLabelChurn,
      issueEventListCalls: churnLedgerCalls,
    });
    assertNoQualitySuccess(repeatedChurn);
    assert.equal(churnTombstoneCount(), 1);
    assert.equal(churnLedgerCalls.length, 1);
  }

  const statusLagTransitions = recoveredOpeningTransitions({
    ancestry: "inverse",
    binding: 102,
  });
  const statusLagReceipts = [];
  const statusLag = await execute({
    eventName: "workflow_run",
    currentPull: wholeSecondManagedPull,
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [
      workflowAuthorization({
        headRef: "feature/marker-recovery",
        baseRef: "dev",
      }),
    ],
    authorizationStatuses: statusLagReceipts,
    transitionStatuses: statusLagTransitions,
    issueEvents: sameSecondManagedLabelChurn,
    staleTransitionStatusReads: true,
  });
  assertQualityFailure(statusLag);
  assert.equal(
    statusLagTransitions.filter(
      ({ description }) => transitionBinding(description) === "x",
    ).length,
    1,
  );
  assert.equal(statusLagReceipts.length, 0);

  const unrelatedLedgerEvents = [
    issueEvent({ id: 711, event: "assigned", label: undefined }),
    issueEvent({
      id: 712,
      event: "labeled",
      label: { name: "reviewed" },
    }),
    issueEvent({ id: 713 }),
  ];
  const pagedPositiveEvents = [
    Array.from({ length: 100 }, (_, index) =>
      issueEvent({
        id: 800 + index,
        event: "assigned",
        label: undefined,
      }),
    ),
    [issueEvent({ id: 900 })],
  ];
  for (const { issueEvents, issueEventPages, expectedCalls } of [
    { issueEvents: unrelatedLedgerEvents, expectedCalls: 1 },
    { issueEventPages: pagedPositiveEvents, expectedCalls: 2 },
  ]) {
    const positiveTransitions = recoveredOpeningTransitions({
      ancestry: "inverse",
      binding: null,
    });
    const positiveLedgerCalls = [];
    const positive = await execute({
      eventName: "workflow_run",
      currentPull: wholeSecondManagedPull,
      transitionStatuses: positiveTransitions,
      issueEvents,
      issueEventPages,
      issueEventListCalls: positiveLedgerCalls,
    });
    assert.deepEqual(
      positive.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["success"],
    );
    assert.equal(positiveLedgerCalls.length, expectedCalls);
    assert.equal(
      positiveTransitions.some(
        ({ description }) => transitionBinding(description) === "x",
      ),
      false,
    );
  }

  const inconclusiveLedgerCases = [
    {
      name: "api error",
      options: { issueEventError: new Error("forbidden") },
      expectedCalls: 1,
    },
    {
      name: "malformed page",
      options: { issueEventPages: [null] },
      expectedCalls: 1,
    },
    {
      name: "oversized page",
      options: {
        issueEventPages: [
          Array.from({ length: 101 }, (_, index) =>
            issueEvent({
              id: 2_100 + index,
              event: "assigned",
              label: undefined,
            }),
          ),
        ],
      },
      expectedCalls: 1,
    },
    {
      name: "malformed event",
      options: { issueEvents: [issueEvent({ event: null })] },
      expectedCalls: 1,
    },
    {
      name: "malformed label",
      options: { issueEvents: [issueEvent({ label: { name: "" } })] },
      expectedCalls: 1,
    },
    {
      name: "malformed timestamp",
      options: { issueEvents: [issueEvent({ created_at: "invalid" })] },
      expectedCalls: 1,
    },
    {
      name: "duplicate event id",
      options: {
        issueEvents: [
          issueEvent({ id: 721 }),
          issueEvent({
            id: 721,
            event: "assigned",
            label: undefined,
          }),
        ],
      },
      expectedCalls: 1,
    },
    {
      name: "missing proof",
      options: { issueEvents: [] },
      expectedCalls: 1,
    },
    {
      name: "incomplete pagination",
      options: {
        issueEventPages: Array.from({ length: 10 }, (_, page) =>
          Array.from({ length: 100 }, (_, index) =>
            issueEvent({
              id: 1_000 + page * 100 + index,
              event: "assigned",
              label: undefined,
            }),
          ),
        ),
      },
      expectedCalls: 10,
    },
  ];
  for (const { name, options, expectedCalls } of inconclusiveLedgerCases) {
    const inconclusiveTransitions = recoveredOpeningTransitions({
      ancestry: "inverse",
      binding: null,
    });
    const inconclusiveLedgerCalls = [];
    const inconclusiveRunCalls = [];
    const inconclusiveReceipts = [];
    const inconclusive = await execute({
      eventName: "workflow_run",
      currentPull: wholeSecondManagedPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:00:01.000Z" }),
      ],
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [
        workflowAuthorization({
          headRef: "feature/marker-recovery",
          baseRef: "dev",
        }),
      ],
      authorizationStatuses: inconclusiveReceipts,
      transitionStatuses: inconclusiveTransitions,
      workflowRunListCalls: inconclusiveRunCalls,
      issueEventListCalls: inconclusiveLedgerCalls,
      ...options,
    });
    assertQualityFailure(inconclusive);
    assert.equal(
      inconclusiveTransitions.some(
        ({ description }) => transitionBinding(description) === "x",
      ),
      false,
      `${name} must remain retriable`,
    );
    assert.equal(inconclusiveLedgerCalls.length, expectedCalls);
    assert.equal(inconclusiveRunCalls.length, 0);
    assert.equal(inconclusiveReceipts.length, 0);

    const retry = await execute({
      eventName: "workflow_run",
      currentPull: wholeSecondManagedPull,
      transitionStatuses: inconclusiveTransitions,
    });
    assert.deepEqual(
      retry.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["success"],
      `${name} must allow a later complete proof`,
    );
  }

  const earlyDriftPage = [
    issueEvent({
      id: 730,
      event: "unlabeled",
      created_at: wholeSecondTimestamp,
    }),
    ...Array.from({ length: 99 }, (_, index) =>
      issueEvent({
        id: 731 + index,
        event: "assigned",
        label: undefined,
      }),
    ),
  ];
  const earlyDriftTransitions = recoveredOpeningTransitions({
    ancestry: "direct",
    binding: null,
  });
  const earlyDriftCalls = [];
  const earlyDrift = await execute({
    eventName: "workflow_run",
    currentPull: wholeSecondManagedPull,
    transitionStatuses: earlyDriftTransitions,
    issueEventPages: [earlyDriftPage],
    issueEventListCalls: earlyDriftCalls,
  });
  assertQualityFailure(earlyDrift);
  assert.equal(earlyDriftCalls.length, 1);
  assert.equal(
    earlyDriftTransitions.filter(
      ({ description }) => transitionBinding(description) === "x",
    ).length,
    1,
  );

  for (const { name, options, expectedCalls } of [
    {
      name: "second managed label",
      options: {
        issueEvents: [
          issueEvent({ id: 740 }),
          issueEvent({ id: 741 }),
        ],
      },
      expectedCalls: 1,
    },
    {
      name: "managed label outside the opening window",
      options: {
        issueEvents: [
          issueEvent({
            id: 742,
            created_at: timestampAfter(
              wholeSecondTimestamp,
              300_001,
            ),
          }),
        ],
      },
      expectedCalls: 1,
    },
    {
      name: "managed removal on the second page",
      options: {
        issueEventPages: [
          pagedPositiveEvents[0],
          [
            issueEvent({
              id: 743,
              event: "unlabeled",
              created_at: wholeSecondTimestamp,
            }),
          ],
        ],
      },
      expectedCalls: 2,
    },
  ]) {
    const provenDriftTransitions = recoveredOpeningTransitions({
      ancestry: "inverse",
      binding: null,
    });
    const provenDriftCalls = [];
    const provenDriftRunCalls = [];
    const provenDriftReceipts = [];
    const provenDrift = await execute({
      eventName: "workflow_run",
      currentPull: wholeSecondManagedPull,
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [
        workflowAuthorization({
          headRef: "feature/marker-recovery",
          baseRef: "dev",
        }),
      ],
      authorizationStatuses: provenDriftReceipts,
      transitionStatuses: provenDriftTransitions,
      workflowRunListCalls: provenDriftRunCalls,
      issueEventListCalls: provenDriftCalls,
      ...options,
    });
    assertQualityFailure(provenDrift);
    assert.equal(
      provenDriftTransitions.filter(
        ({ description }) => transitionBinding(description) === "x",
      ).length,
      1,
      `${name} must tombstone`,
    );
    assert.equal(provenDriftCalls.length, expectedCalls);
    assert.equal(provenDriftRunCalls.length, 0);
    assert.equal(provenDriftReceipts.length, 0);
  }

  const ordinaryLedgerCalls = [];
  await execute({ issueEventListCalls: ordinaryLedgerCalls });
  assert.equal(ordinaryLedgerCalls.length, 0);
  const staleLedgerCalls = [];
  await execute({
    currentPull: wholeSecondManagedPull,
    transitionStatuses: [
      qualityTransitionStatus({
        context: "trusted-quality-transition/dev",
        description: transitionDescription({
          action: "opened",
          timestamp: wholeSecondTimestamp,
          binding: "x",
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
    ],
    issueEventListCalls: staleLedgerCalls,
  });
  assert.equal(staleLedgerCalls.length, 0);
  const legacyLedgerCalls = [];
  await execute({
    currentPull: wholeSecondManagedPull,
    transitionStatuses: [
      qualityTransitionStatus({
        context: "trusted-quality-transition/dev",
        description: transitionDescription({
          version: 2,
          action: "opened",
          timestamp: wholeSecondTimestamp,
          binding: null,
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
    ],
    issueEventListCalls: legacyLedgerCalls,
  });
  assert.equal(legacyLedgerCalls.length, 0);

  const staleOpenedReplayTransitions = [
    qualityTransitionStatus({
      context: "trusted-quality-transition/dev",
      created_at: "2026-09-02T09:00:01.000Z",
      description: transitionDescription({
        action: "opened",
        timestamp: wholeSecondTimestamp,
        binding: null,
      }),
    }),
  ];
  const staleOpenedReplay = await execute({
    eventName: "pull_request_target",
    eventAction: "opened",
    eventPull: wholeSecondOpenedPull,
    currentPull: pull({
      updated_at: timestampAfter(wholeSecondTimestamp, 300_001),
      labels: managedLabels,
      head: featureHead,
      base: devBase,
    }),
    transitionStatuses: staleOpenedReplayTransitions,
    staleTransitionStatusReads: true,
  });
  assertQualityFailure(staleOpenedReplay);
  assert.equal(
    staleOpenedReplayTransitions.filter(
      ({ description }) => transitionBinding(description) === "x",
    ).length,
    1,
  );

  const staleUnconfirmedTransitions = [
    qualityTransitionStatus({
      context: "trusted-quality-transition/dev",
      created_at: wholeSecondTimestamp,
      description: transitionDescription({
        action: "opened",
        timestamp: wholeSecondTimestamp,
        binding: "u",
        labelsFingerprint: managedLabelsFingerprint,
      }),
    }),
  ];
  const staleUnconfirmed = await execute({
    eventName: "pull_request_target",
    eventAction: "unlabeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: pull({
      updated_at: wholeSecondTimestamp,
      labels: [],
      head: featureHead,
      base: devBase,
    }),
    currentPull: pull({
      updated_at: wholeSecondTimestamp,
      labels: [],
      head: featureHead,
      base: devBase,
    }),
    transitionStatuses: staleUnconfirmedTransitions,
    issueEvents: [issueEvent()],
    staleTransitionStatusReads: true,
  });
  assertQualityFailure(staleUnconfirmed);
  assert.equal(
    staleUnconfirmedTransitions.filter(
      ({ description }) => transitionBinding(description) === "x",
    ).length,
    1,
  );

  const staleLabelDriftTransitions = [
    qualityTransitionStatus({
      description: transitionDescription({
        action: "synchronize",
        binding: 102,
      }),
    }),
  ];
  const staleLabelDriftReceipts = [];
  const staleLabelDrift = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: "reviewed",
    eventPull: pull({ labels: [{ name: "reviewed" }] }),
    currentPull: pull(),
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
    authorizationStatuses: staleLabelDriftReceipts,
    transitionStatuses: staleLabelDriftTransitions,
    staleTransitionStatusReads: true,
  });
  assertQualityFailure(staleLabelDrift);
  assert.equal(
    staleLabelDriftTransitions.filter(
      ({ description }) => transitionBinding(description) === "x",
    ).length,
    1,
  );
  assert.equal(staleLabelDriftReceipts.length, 0);

  const inWindowLabelTimestamp = timestampAfter(PULL_UPDATED_AT, 2_000);
  const inWindowLabeledPull = pull({
    updated_at: inWindowLabelTimestamp,
    labels: managedLabels,
    head: featureHead,
    base: devBase,
  });
  for (const { markerOffset, reconciles } of [
    { markerOffset: -1, reconciles: false },
    { markerOffset: 0, reconciles: false },
    { markerOffset: 1, reconciles: true },
  ]) {
    const directTimingTransitions = [
      qualityTransitionStatus({
        context: "trusted-quality-transition/dev",
        created_at: timestampAfter(
          inWindowLabelTimestamp,
          markerOffset,
        ),
        description: transitionDescription({
          action: "opened",
          binding: "u",
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
    ];
    const directTiming = await execute({
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: inWindowLabeledPull,
      currentPull: inWindowLabeledPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
      ],
      transitionStatuses: directTimingTransitions,
    });

    if (reconciles) {
      const qualityStates = directTiming.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state);
      assert(qualityStates.length > 0);
      assert(qualityStates.every((state) => state === "success"));
      assert.equal(
        transitionBinding(directTimingTransitions[0].description),
        "102",
      );
    } else {
      assert.equal(
        transitionBinding(directTimingTransitions[0].description),
        "x",
      );
      assertNoQualitySuccess(directTiming);
    }
  }

  const earliestLineageDescription = transitionDescription({
    action: "opened",
    binding: "u",
    contentFingerprint: PULL_CONTENT_FINGERPRINT,
    labelsFingerprint: managedLabelsFingerprint,
  });
  const earliestLineageTransitions = [
    qualityTransitionStatus({
      id: 899,
      context: "trusted-quality-transition/dev",
      created_at: timestampAfter(inWindowLabelTimestamp, -1),
      description: earliestLineageDescription,
    }),
    qualityTransitionStatus({
      id: 900,
      context: "trusted-quality-transition/dev",
      created_at: timestampAfter(inWindowLabelTimestamp, 1),
      description: earliestLineageDescription,
    }),
  ];
  const earliestLineage = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: inWindowLabeledPull,
    currentPull: inWindowLabeledPull,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
    ],
    transitionStatuses: earliestLineageTransitions,
  });
  assertNoQualitySuccess(earliestLineage);
  assert.equal(
    transitionBinding(earliestLineageTransitions[0].description),
    "x",
  );

  for (const { markerCreatedAt, authorizationNow } of [
    {
      markerCreatedAt: "2026-09-02T08:59:00.000Z",
      authorizationNow: NOW,
    },
    {
      markerCreatedAt: "2026-09-05T12:00:00.000Z",
      authorizationNow: "2026-09-06T12:00:00.000Z",
    },
  ]) {
    const inverseTimingTransitions = [
      qualityTransitionStatus({
        context: "trusted-quality-transition/dev",
        created_at: markerCreatedAt,
        description: transitionDescription({
          action: "opened",
          binding: 102,
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
        }),
      }),
    ];
    const inverseTiming = await execute({
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: inWindowLabeledPull,
      currentPull: inWindowLabeledPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
      ],
      transitionStatuses: inverseTimingTransitions,
      authorizationNow,
    });
    const qualityStates = inverseTiming.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state);
    assert(qualityStates.length > 0);
    assert(qualityStates.every((state) => state === "success"));
    assert.equal(
      inverseTimingTransitions[0].description,
      transitionDescription({
        action: "opened",
        binding: 102,
        contentFingerprint: PULL_CONTENT_FINGERPRINT,
        labelsFingerprint: managedLabelsFingerprint,
      }),
    );
  }

  const lateLabelTimestamp = timestampAfter(PULL_UPDATED_AT, 86_400_000);
  const lateLabeledPull = pull({
    updated_at: lateLabelTimestamp,
    labels: managedLabels,
    head: featureHead,
    base: devBase,
  });
  for (const markerLabelsFingerprint of [
    managedLabelsFingerprint,
    PULL_LABELS_FINGERPRINT,
  ]) {
    const lateLineageTransitions = [
      qualityTransitionStatus({
        context: "trusted-quality-transition/dev",
        created_at: timestampAfter(lateLabelTimestamp, 1_000),
        description: transitionDescription({
          action: "opened",
          binding: 102,
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
          labelsFingerprint: markerLabelsFingerprint,
        }),
      }),
    ];
    const lateLineage = await execute({
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: lateLabeledPull,
      currentPull: lateLabeledPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-04T09:00:00.000Z" }),
      ],
      transitionStatuses: lateLineageTransitions,
    });
    assertNoQualitySuccess(lateLineage);
    assert.equal(
      lateLineageTransitions[0].description,
      transitionDescription({
        action: "opened",
        binding: "x",
        contentFingerprint: PULL_CONTENT_FINGERPRINT,
        labelsFingerprint: managedLabelsFingerprint,
      }),
    );
  }

  const lateOpenedTransitions = [];
  for (let replay = 0; replay < 2; replay += 1) {
    const lateOpenedReplay = await execute({
      eventName: "pull_request_target",
      eventAction: "opened",
      eventPull: openedEventPull,
      currentPull: lateLabeledPull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-04T09:00:00.000Z" }),
      ],
      transitionStatuses: lateOpenedTransitions,
    });
    assertNoQualitySuccess(lateOpenedReplay);
    assert.equal(lateOpenedTransitions.length, 0);
  }

  const matchingOpenedReplayTransitions = [
    qualityTransitionStatus({
      description: transitionDescription({
        action: "opened",
        binding: null,
      }),
    }),
  ];
  const matchingOpenedReplayReceipts = [];
  const matchingOpenedReplayRunCalls = [];
  const matchingOpenedReplay = await execute({
    eventName: "pull_request_target",
    eventAction: "opened",
    eventPull: pull(),
    currentPull: pull(),
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T10:00:00.000Z" }),
    ],
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
    authorizationStatuses: matchingOpenedReplayReceipts,
    transitionStatuses: matchingOpenedReplayTransitions,
    workflowRunListCalls: matchingOpenedReplayRunCalls,
  });
  assert.deepEqual(
    matchingOpenedReplay.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["pending", "pending"],
  );
  assert(
    matchingOpenedReplay.messages.some((message) =>
      message.includes("no bound quality run yet"),
    ),
  );
  assert.equal(matchingOpenedReplayTransitions.length, 1);
  assert.equal(
    transitionBinding(matchingOpenedReplayTransitions[0].description),
    "p",
  );
  assert.equal(matchingOpenedReplayRunCalls.length, 0);
  assert.equal(matchingOpenedReplayReceipts.length, 0);

  for (const binding of ["u", null, 102]) {
    const lateExistingTransitions = [
      qualityTransitionStatus({
        context: "trusted-quality-transition/dev",
        created_at: "2026-09-02T09:00:01.000Z",
        description: transitionDescription({
          action: "opened",
          binding,
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
          labelsFingerprint:
            binding === "u"
              ? managedLabelsFingerprint
              : PULL_LABELS_FINGERPRINT,
        }),
      }),
    ];
    const lateExistingReceipts = [];
    const lateExistingRunCalls = [];
    for (let replay = 0; replay < 2; replay += 1) {
      const lateExistingReplay = await execute({
        eventName: "pull_request_target",
        eventAction: "opened",
        eventPull: openedEventPull,
        currentPull: lateLabeledPull,
        listedRuns: [
          workflowRun({ created_at: "2026-09-04T09:00:00.000Z" }),
        ],
        workflowAuthorizations: [workflowAuthorization()],
        authorizationStatuses: lateExistingReceipts,
        transitionStatuses: lateExistingTransitions,
        workflowRunListCalls: lateExistingRunCalls,
      });
      assertNoQualitySuccess(lateExistingReplay);
    }
    const tombstoneCount = () =>
      lateExistingTransitions.filter(
        ({ description }) =>
          transitionBinding(description) === "x",
      ).length;
    assert.equal(tombstoneCount(), 1);
    assert.equal(lateExistingRunCalls.length, 0);
    assert.equal(lateExistingReceipts.length, 0);

    const lateManualRefresh = await execute({
      currentPull: lateLabeledPull,
      workflowAuthorizations: [workflowAuthorization()],
      authorizationStatuses: lateExistingReceipts,
      transitionStatuses: lateExistingTransitions,
      workflowRunListCalls: lateExistingRunCalls,
    });
    assertNoQualitySuccess(lateManualRefresh);
    const lateWorkflowRefresh = await execute({
      eventName: "workflow_run",
      currentPull: lateLabeledPull,
      run: workflowRun({ created_at: "2026-09-04T09:00:00.000Z" }),
      listedRuns: [
        workflowRun({ created_at: "2026-09-04T09:00:00.000Z" }),
      ],
      workflowAuthorizations: [workflowAuthorization()],
      authorizationStatuses: lateExistingReceipts,
      transitionStatuses: lateExistingTransitions,
      workflowRunListCalls: lateExistingRunCalls,
    });
    assertNoQualitySuccess(lateWorkflowRefresh);
    assert.equal(tombstoneCount(), 1);
    assert.equal(lateExistingRunCalls.length, 0);
    assert.equal(lateExistingReceipts.length, 0);
  }

  for (const markerLabelsFingerprint of [
    PULL_LABELS_FINGERPRINT,
    managedLabelsFingerprint,
  ]) {
    const staleOpeningTransitions = [
      qualityTransitionStatus({
        created_at: "2026-09-02T09:00:02.000Z",
        description: transitionDescription({
          action: "opened",
          binding: 102,
          labelsFingerprint: markerLabelsFingerprint,
        }),
      }),
    ];
    const delayedInitialLabelPull = pull({
      updated_at: "2026-09-02T09:00:01.000Z",
      labels: managedLabels,
    });
    const restoredManagedPull = pull({
      updated_at: "2026-09-02T09:00:04.000Z",
      labels: managedLabels,
    });
    const staleOpeningConfirmation = await execute({
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: delayedInitialLabelPull,
      currentPull: restoredManagedPull,
      transitionStatuses: staleOpeningTransitions,
    });
    assertNoQualitySuccess(staleOpeningConfirmation);
    assert.equal(
      staleOpeningTransitions[0].description,
      transitionDescription({
        action: "opened",
        binding: "x",
        labelsFingerprint: managedLabelsFingerprint,
      }),
    );
    const staleOpeningTombstoneCount = staleOpeningTransitions.length;
    for (const recovery of [
      {
        eventName: "workflow_dispatch",
        currentPull: restoredManagedPull,
      },
      {
        eventName: "workflow_run",
        currentPull: restoredManagedPull,
      },
    ]) {
      const result = await execute({
        ...recovery,
        transitionStatuses: staleOpeningTransitions,
      });
      assertNoQualitySuccess(result);
      assert.equal(
        staleOpeningTransitions.length,
        staleOpeningTombstoneCount,
      );
    }
  }

  const extraLabels = [
    { name: CLI_MANAGED_LABEL },
    { name: "reviewed" },
  ];
  const extraLabelsFingerprint = publishPrPolicy.labelsFingerprint([
    CLI_MANAGED_LABEL,
    "reviewed",
  ]);
  for (const staleLabelEvent of [
    {
      eventAction: "labeled",
      eventLabelName: "reviewed",
      eventPull: pull({
        updated_at: "2026-09-02T11:00:00.000Z",
        labels: extraLabels,
      }),
    },
    {
      eventAction: "unlabeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: pull({
        updated_at: "2026-09-02T11:00:00.000Z",
        labels: [],
      }),
    },
  ]) {
    const rapidRestoreTransitions = [
      qualityTransitionStatus({
        description: transitionDescription({
          action: "opened",
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
    ];
    const rapidRestorePull = pull({
      updated_at: "2026-09-02T11:00:01.000Z",
      labels: managedLabels,
    });
    const rapidRestore = await execute({
      eventName: "pull_request_target",
      ...staleLabelEvent,
      currentPull: rapidRestorePull,
      transitionStatuses: rapidRestoreTransitions,
    });
    assertNoQualitySuccess(rapidRestore);
    assert.equal(
      rapidRestoreTransitions[0].description,
      transitionDescription({
        action: "opened",
        binding: "x",
        labelsFingerprint: managedLabelsFingerprint,
      }),
    );
    const rapidRestoreRefresh = await execute({
      currentPull: rapidRestorePull,
      transitionStatuses: rapidRestoreTransitions,
    });
    assertNoQualitySuccess(rapidRestoreRefresh);
    const rapidRestoreCompletion = await execute({
      eventName: "workflow_run",
      currentPull: rapidRestorePull,
      transitionStatuses: rapidRestoreTransitions,
    });
    assertNoQualitySuccess(rapidRestoreCompletion);
  }

  for (const deliverRemovalAfterReAdd of [false, true]) {
    const reAddFirstTransitions = [
      qualityTransitionStatus({
        created_at: "2026-09-02T10:00:00.000Z",
        description: transitionDescription({
          action: "opened",
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
    ];
    const reAddedPull = pull({
      updated_at: "2026-09-02T11:00:00.000Z",
      labels: managedLabels,
    });
    const reAddFirst = await execute({
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: reAddedPull,
      currentPull: reAddedPull,
      transitionStatuses: reAddFirstTransitions,
    });
    assertNoQualitySuccess(reAddFirst);
    assert.equal(
      reAddFirstTransitions[0].description,
      transitionDescription({
        action: "opened",
        binding: "x",
        labelsFingerprint: managedLabelsFingerprint,
      }),
    );
    const reAddTombstoneCount = reAddFirstTransitions.length;
    if (deliverRemovalAfterReAdd) {
      const delayedRemoval = await execute({
        eventName: "pull_request_target",
        eventAction: "unlabeled",
        eventLabelName: CLI_MANAGED_LABEL,
        eventPull: pull({
          updated_at: "2026-09-02T10:59:59.000Z",
          labels: [],
        }),
        currentPull: reAddedPull,
        transitionStatuses: reAddFirstTransitions,
      });
      assertNoQualitySuccess(delayedRemoval);
      assert.equal(
        reAddFirstTransitions.length,
        reAddTombstoneCount,
      );
    }
    for (const recovery of [
      {
        eventName: "workflow_dispatch",
        currentPull: reAddedPull,
      },
      {
        eventName: "workflow_run",
        currentPull: reAddedPull,
      },
    ]) {
      const result = await execute({
        ...recovery,
        transitionStatuses: reAddFirstTransitions,
      });
      assertNoQualitySuccess(result);
      assert.equal(
        reAddFirstTransitions.length,
        reAddTombstoneCount,
      );
    }
  }

  const reAddBeforeBindingTransitions = [
    qualityTransitionStatus({
      id: 901,
      created_at: "2026-09-02T12:00:00.000Z",
      description: transitionDescription({
        action: "opened",
        labelsFingerprint: managedLabelsFingerprint,
      }),
    }),
    qualityTransitionStatus({
      id: 900,
      created_at: "2026-09-02T10:00:00.000Z",
      description: transitionDescription({
        action: "opened",
        binding: null,
        labelsFingerprint: managedLabelsFingerprint,
      }),
    }),
  ];
  const reAddBeforeBinding = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: pull({
      updated_at: "2026-09-02T11:00:00.000Z",
      labels: managedLabels,
    }),
    currentPull: pull({
      updated_at: "2026-09-02T11:00:00.000Z",
      labels: managedLabels,
    }),
    transitionStatuses: reAddBeforeBindingTransitions,
  });
  assertNoQualitySuccess(reAddBeforeBinding);
  assert.equal(
    reAddBeforeBindingTransitions[0].description,
    transitionDescription({
      action: "opened",
      binding: "x",
      labelsFingerprint: managedLabelsFingerprint,
    }),
  );

  const equalMarkerTimeTransitions = [
    qualityTransitionStatus({
      created_at: "2026-09-02T11:00:00.000Z",
      description: transitionDescription({
        action: "opened",
        labelsFingerprint: managedLabelsFingerprint,
      }),
    }),
  ];
  const equalMarkerTimeReAdd = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: CLI_MANAGED_LABEL,
    eventPull: pull({
      updated_at: "2026-09-02T11:00:00.000Z",
      labels: managedLabels,
    }),
    currentPull: pull({
      updated_at: "2026-09-02T11:00:00.000Z",
      labels: managedLabels,
    }),
    transitionStatuses: equalMarkerTimeTransitions,
  });
  assertNoQualitySuccess(equalMarkerTimeReAdd);
  assert.equal(
    equalMarkerTimeTransitions[0].description,
    transitionDescription({
      action: "opened",
      binding: "x",
      labelsFingerprint: managedLabelsFingerprint,
    }),
  );

  const laterLineageTransitions = [
    qualityTransitionStatus({
      description: transitionDescription({
        action: "edited",
        timestamp: "2026-09-02T11:00:00.000Z",
        binding: 103,
        labelsFingerprint: managedLabelsFingerprint,
      }),
    }),
  ];
  const olderLabelEvent = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: "reviewed",
    eventPull: pull({
      updated_at: "2026-09-02T10:00:00.000Z",
      labels: extraLabels,
    }),
    currentPull: pull({
      updated_at: "2026-09-02T12:00:00.000Z",
      labels: managedLabels,
    }),
    listedRuns: [
      workflowRun({
        id: 103,
        created_at: "2026-09-02T12:00:00.000Z",
        html_url: workflowRunUrl(103),
      }),
    ],
    transitionStatuses: laterLineageTransitions,
  });
  assert.deepEqual(
    olderLabelEvent.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );
  assert.equal(laterLineageTransitions.length, 1);

  const tombstoneTransitions = [
    qualityTransitionStatus({
      description: transitionDescription({
        action: "opened",
        labelsFingerprint: managedLabelsFingerprint,
      }),
    }),
  ];
  const labelDriftPull = pull({
    updated_at: "2026-09-02T11:00:00.000Z",
    labels: extraLabels,
  });
  const labelDrift = await execute({
    eventName: "pull_request_target",
    eventAction: "labeled",
    eventLabelName: "reviewed",
    eventPull: labelDriftPull,
    currentPull: labelDriftPull,
    transitionStatuses: tombstoneTransitions,
  });
  assertNoQualitySuccess(labelDrift);
  assert.equal(
    tombstoneTransitions[0].description,
    transitionDescription({
      action: "opened",
      binding: "x",
      labelsFingerprint: extraLabelsFingerprint,
    }),
  );
  assert.equal(
    tombstoneTransitions[0].target_url,
    "https://example.invalid/example/repo/actions/runs/100",
  );
  const tombstoneCount = tombstoneTransitions.length;
  const restoredLabelPull = pull({
    updated_at: "2026-09-02T11:00:01.000Z",
    labels: managedLabels,
  });
  for (const recovery of [
    {
      eventName: "pull_request_target",
      eventAction: "unlabeled",
      eventLabelName: "reviewed",
      eventPull: restoredLabelPull,
      currentPull: restoredLabelPull,
    },
    {
      eventName: "workflow_dispatch",
      currentPull: restoredLabelPull,
    },
    {
      eventName: "workflow_run",
      currentPull: restoredLabelPull,
    },
  ]) {
    const staleRecovery = await execute({
      ...recovery,
      transitionStatuses: tombstoneTransitions,
    });
    assertNoQualitySuccess(staleRecovery);
    assert.equal(tombstoneTransitions.length, tombstoneCount);
  }
  const laterEditPull = pull({
    updated_at: "2026-09-02T11:00:02.000Z",
    labels: managedLabels,
  });
  await execute({
    eventName: "pull_request_target",
    eventAction: "edited",
    eventPull: laterEditPull,
    currentPull: laterEditPull,
    transitionStatuses: tombstoneTransitions,
    contextRunId: 113,
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T12:00:00.000Z" }),
    ],
  });
  assert.equal(
    tombstoneTransitions[0].description,
    transitionDescription({
      action: "edited",
      timestamp: laterEditPull.updated_at,
      labelsFingerprint: managedLabelsFingerprint,
    }),
  );
  const postTombstoneCompletion = await execute({
    eventName: "workflow_run",
    currentPull: laterEditPull,
    transitionStatuses: tombstoneTransitions,
    run: workflowRun({ created_at: "2026-09-02T12:00:00.000Z" }),
    listedRuns: [
      workflowRun({ created_at: "2026-09-02T12:00:00.000Z" }),
    ],
  });
  assert.deepEqual(
    postTombstoneCompletion.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );

  const equalCutoffTombstones = [
    qualityTransitionStatus({
      description: transitionDescription({
        action: "opened",
        binding: "x",
      }),
    }),
  ];
  const equalCutoffProducingEvent = await execute({
    eventName: "pull_request_target",
    eventAction: "edited",
    transitionStatuses: equalCutoffTombstones,
  });
  assertNoQualitySuccess(equalCutoffProducingEvent);
  assert.equal(equalCutoffTombstones.length, 1);
  const equalCutoffCompletion = await execute({
    eventName: "workflow_run",
    transitionStatuses: equalCutoffTombstones,
  });
  assertNoQualitySuccess(equalCutoffCompletion);

  for (const noBootstrap of [
    {
      eventName: "workflow_dispatch",
      currentPull: pull(),
    },
    {
      eventName: "pull_request_target",
      eventAction: "labeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: pull({ labels: managedLabels }),
      currentPull: pull({ labels: managedLabels }),
    },
    {
      eventName: "pull_request_target",
      eventAction: "unlabeled",
      eventLabelName: CLI_MANAGED_LABEL,
      eventPull: pull(),
      currentPull: pull(),
    },
  ]) {
    const absentTransitions = [];
    const result = await execute({
      ...noBootstrap,
      transitionStatuses: absentTransitions,
    });
    assertNoQualitySuccess(result);
    assert.equal(absentTransitions.length, 0);
  }

  const legacyTransition = await execute({
    transitionStatuses: [
      qualityTransitionStatus({
        description: legacyTransitionDescription(),
      }),
    ],
  });
  assertNoQualitySuccess(legacyTransition);
  assert(
    legacyTransition.messages.some((message) =>
      message.includes("legacy quality transition markers"),
    ),
  );

  const sameCutoffLegacyTransitions = [
    qualityTransitionStatus({
      description: legacyTransitionDescription({ action: "opened" }),
    }),
  ];
  const sameCutoffLegacyReplay = await execute({
    eventName: "pull_request_target",
    eventAction: "opened",
    transitionStatuses: sameCutoffLegacyTransitions,
  });
  assertNoQualitySuccess(sameCutoffLegacyReplay);
  assert.equal(sameCutoffLegacyTransitions.length, 1);
  assert.equal(
    sameCutoffLegacyTransitions[0].description,
    legacyTransitionDescription({ action: "opened" }),
  );

  for (const binding of [null, 102, "x"]) {
    const versionTwo = await execute({
      listedRuns: [],
      transitionStatuses: [
        qualityTransitionStatus({
          description: transitionDescription({
            version: 2,
            binding,
          }),
        }),
      ],
    });
    assert.deepEqual(
      versionTwo.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["pending", "pending"],
    );
    assert(
      versionTwo.messages.some((message) =>
        message.includes("legacy quality transition markers"),
      ),
    );
  }

  const sameCutoffVersionTwoConflict = await execute({
    currentPull: openedRacePull,
    listedRuns: [],
    transitionStatuses: [
      qualityTransitionStatus({
        id: 902,
        context: "trusted-quality-transition/dev",
        target_url: workflowRunUrl(101),
        description: transitionDescription({
          action: "opened",
          binding: null,
          contentFingerprint: "a".repeat(32),
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
      qualityTransitionStatus({
        id: 901,
        context: "trusted-quality-transition/dev",
        description: transitionDescription({
          version: 2,
          action: "edited",
          binding: null,
        }),
      }),
    ],
  });
  assertNoQualitySuccess(sameCutoffVersionTwoConflict);
  assert(
    sameCutoffVersionTwoConflict.messages.some((message) =>
      message.includes("legacy quality transition markers"),
    ),
  );

  for (const binding of [null, 102, "x"]) {
    const versionTwoTransitions = [
      qualityTransitionStatus({
        description: transitionDescription({
          version: 2,
          binding,
        }),
      }),
    ];
    const laterOpenedPull = pull({
      updated_at: "2026-09-02T11:00:00.000Z",
    });
    const laterOpened = await execute({
      eventName: "pull_request_target",
      eventAction: "opened",
      eventPull: laterOpenedPull,
      currentPull: laterOpenedPull,
      transitionStatuses: versionTwoTransitions,
    });
    assertNoQualitySuccess(laterOpened);
    assert.equal(versionTwoTransitions.length, 1);
  }

  const versionTwoRecoveryTransitions = [
    qualityTransitionStatus({
      description: transitionDescription({
        version: 2,
        binding: 102,
      }),
    }),
  ];
  const laterEditedPull = pull({
    updated_at: "2026-09-02T11:00:00.000Z",
  });
  const laterVersionThreeTransition = await execute({
    eventName: "pull_request_target",
    eventAction: "edited",
    eventPull: laterEditedPull,
    currentPull: laterEditedPull,
    listedRuns: [
      workflowRun({
        created_at: "2026-09-02T12:00:00.000Z",
      }),
    ],
    transitionStatuses: versionTwoRecoveryTransitions,
  });
  assertNoQualitySuccess(laterVersionThreeTransition);
  assert.match(versionTwoRecoveryTransitions[0].description, /^v3\|/);
  assert.equal(
    transitionBinding(versionTwoRecoveryTransitions[0].description),
    "102",
  );
  const versionThreeRecoveryCompletion = await execute({
    eventName: "workflow_run",
    currentPull: laterEditedPull,
    run: workflowRun({
      created_at: "2026-09-02T12:00:00.000Z",
    }),
    listedRuns: [
      workflowRun({
        created_at: "2026-09-02T12:00:00.000Z",
      }),
    ],
    transitionStatuses: versionTwoRecoveryTransitions,
  });
  assert.deepEqual(
    versionThreeRecoveryCompletion.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );

  const semanticStates = [
    {
      id: 999,
      binding: "u",
    },
    {
      id: 901,
      binding: null,
    },
    {
      id: 902,
      binding: 102,
    },
  ];
  for (const orderedStates of permutations(semanticStates)) {
    const semanticResolution = await execute({
      currentPull: openedRacePull,
      listedRuns: [
        workflowRun({ created_at: "2026-09-02T09:10:00.000Z" }),
      ],
      transitionStatuses: orderedStates.map(({ id, binding }) =>
        qualityTransitionStatus({
          id,
          context: "trusted-quality-transition/dev",
          description: transitionDescription({
            action: "opened",
            binding,
            labelsFingerprint: managedLabelsFingerprint,
          }),
        }),
      ),
    });
    assert.deepEqual(
      semanticResolution.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["success"],
    );
  }

  for (const orderedStates of permutations(semanticStates.slice(0, 2))) {
    const pendingResolution = await execute({
      currentPull: openedRacePull,
      listedRuns: [],
      transitionStatuses: orderedStates.map(({ id, binding }) =>
        qualityTransitionStatus({
          id,
          context: "trusted-quality-transition/dev",
          description: transitionDescription({
            action: "opened",
            binding,
            labelsFingerprint: managedLabelsFingerprint,
          }),
        }),
      ),
    });
    assertNoQualitySuccess(pendingResolution);
    assert(
      pendingResolution.messages.some((message) =>
        message.includes("no bound quality run yet"),
      ),
    );
  }

  const tombstonedSemanticStates = [
    ...semanticStates,
    {
      id: 904,
      binding: "x",
    },
  ];
  for (const orderedStates of permutations(tombstonedSemanticStates)) {
    const tombstoneResolution = await execute({
      currentPull: openedRacePull,
      transitionStatuses: orderedStates.map(({ id, binding }) =>
        qualityTransitionStatus({
          id,
          context: "trusted-quality-transition/dev",
          description: transitionDescription({
            action: "opened",
            binding,
            labelsFingerprint: managedLabelsFingerprint,
          }),
        }),
      ),
    });
    assertNoQualitySuccess(tombstoneResolution);
    assert(
      tombstoneResolution.messages.some((message) =>
        message.includes("permanently stale"),
      ),
    );
  }

  const conflictingRunBindings = await execute({
    currentPull: openedRacePull,
    transitionStatuses: [102, 103].map((binding) =>
      qualityTransitionStatus({
        id: 800 + binding,
        context: "trusted-quality-transition/dev",
        description: transitionDescription({
          action: "opened",
          binding,
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
    ),
  });
  assertNoQualitySuccess(conflictingRunBindings);
  assert(
    conflictingRunBindings.messages.some((message) =>
      message.includes("quality transition marker run bindings conflict"),
    ),
  );

  for (const conflictTransitions of [
    [
      qualityTransitionStatus({
        id: 901,
        description: transitionDescription({ action: "edited" }),
      }),
      qualityTransitionStatus({
        id: 902,
        description: transitionDescription({ action: "reopened" }),
      }),
    ],
    [
      qualityTransitionStatus({
        id: 901,
        description: transitionDescription(),
      }),
      qualityTransitionStatus({
        id: 902,
        description: transitionDescription({
          contentFingerprint: "a".repeat(32),
        }),
      }),
    ],
    [
      qualityTransitionStatus({
        id: 901,
        target_url: workflowRunUrl(100),
      }),
      qualityTransitionStatus({
        id: 902,
        target_url: workflowRunUrl(101),
      }),
    ],
    [
      qualityTransitionStatus({
        id: 901,
        description: transitionDescription(),
      }),
      qualityTransitionStatus({
        id: 902,
        description: transitionDescription({
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
    ],
    [
      qualityTransitionStatus({
        id: 901,
        description: transitionDescription({
          action: "opened",
          binding: null,
        }),
      }),
      qualityTransitionStatus({
        id: 902,
        description: transitionDescription({
          action: "opened",
          binding: null,
          labelsFingerprint: extraLabelsFingerprint,
        }),
      }),
    ],
    [
      qualityTransitionStatus({
        id: 901,
        description: transitionDescription({
          action: "opened",
          binding: 102,
        }),
      }),
      qualityTransitionStatus({
        id: 902,
        description: transitionDescription({
          action: "opened",
          binding: null,
          labelsFingerprint: managedLabelsFingerprint,
        }),
      }),
    ],
  ]) {
    const conflictingLineage = await execute({
      transitionStatuses: conflictTransitions,
    });
    assertNoQualitySuccess(conflictingLineage);
    assert(
      conflictingLineage.messages.some((message) =>
        message.includes("quality transition marker"),
      ),
    );
  }

  const contentDriftTransitions = [
    qualityTransitionStatus({
      description: transitionDescription({
        binding: null,
      }),
    }),
  ];
  const contentDrift = await execute({
    currentPull: pull({
      title: "Changed title after transition",
    }),
    listedRuns: [],
    transitionStatuses: contentDriftTransitions,
  });
  assertNoQualitySuccess(contentDrift);
  assert.equal(
    transitionBinding(contentDriftTransitions[0].description),
    "x",
  );

  for (const binding of [null, 103]) {
    const absentCandidateTransitions = [
      qualityTransitionStatus({
        description: transitionDescription({ binding }),
      }),
    ];
    const authorizationStatuses = [];
    const absentCandidate = await execute({
      eventName: "workflow_run",
      run: workflowRun({
        id: 103,
        html_url: workflowRunUrl(103),
      }),
      listedRuns: [
        workflowRun({
          id: 102,
          html_url: workflowRunUrl(102),
        }),
      ],
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [workflowAuthorization()],
      authorizationStatuses,
      transitionStatuses: absentCandidateTransitions,
    });
    assertNoQualitySuccess(absentCandidate);
    assert.equal(absentCandidateTransitions.length, 1);
    assert.equal(authorizationStatuses.length, 0);
  }

  for (const binding of [null, 102]) {
    for (const [candidateOverrides, listedOverrides] of [
      [
        {
          run_attempt: 1,
          status: "completed",
          conclusion: "failure",
        },
        {
          run_attempt: 2,
          status: "completed",
          conclusion: "success",
        },
      ],
      [{ run_attempt: 1 }, { run_attempt: 2 }],
      [
        { status: "completed", conclusion: "failure" },
        { status: "completed", conclusion: "success" },
      ],
      [{ workflow_id: 203 }, {}],
      [{ path: ".github/workflows/other.yml" }, {}],
      [{ event: "workflow_dispatch" }, {}],
      [{ head_sha: "9".repeat(40) }, {}],
      [{ head_repository: { full_name: "other/repo" } }, {}],
      [
        {},
        {
          pull_requests: [
            {
              number: 63,
              head: { sha: "9".repeat(40) },
              base: { sha: BASE_SHA },
            },
          ],
        },
      ],
      [{ created_at: "2026-09-02T10:00:01.000Z" }, {}],
    ]) {
      const candidateDisagreementTransitions = [
        qualityTransitionStatus({
          description: transitionDescription({ binding }),
        }),
      ];
      const candidateDisagreementAuthorizations = [];
      const candidateDisagreement = await execute({
        eventName: "workflow_run",
        run: workflowRun(candidateOverrides),
        listedRuns: [workflowRun(listedOverrides)],
        headBlob: CHANGED_BLOB,
        workflowAuthorizations: [workflowAuthorization()],
        authorizationStatuses: candidateDisagreementAuthorizations,
        transitionStatuses: candidateDisagreementTransitions,
      });
      assertNoQualitySuccess(candidateDisagreement);
      assert.equal(candidateDisagreementTransitions.length, 1);
      assert.equal(candidateDisagreementAuthorizations.length, 0);
    }
  }

  const malformedCompletionAuthorizations = [];
  const malformedCompletionStatuses = [];
  const malformedCompletionRunLists = [];
  await assert.rejects(
    execute({
      eventName: "workflow_run",
      run: workflowRun({
        id: 103,
        run_attempt: 0,
        html_url: workflowRunUrl(103),
        pull_requests: [
          {
            number: 0,
            head: { sha: HEAD_SHA },
            base: { sha: BASE_SHA },
          },
        ],
      }),
      listedRuns: [workflowRun()],
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [workflowAuthorization()],
      authorizationStatuses: malformedCompletionAuthorizations,
      statusSink: malformedCompletionStatuses,
      workflowRunListCalls: malformedCompletionRunLists,
    }),
    /quality workflow run inventory entry is malformed/,
  );
  assert.equal(malformedCompletionAuthorizations.length, 0);
  assert.equal(malformedCompletionStatuses.length, 0);
  assert.equal(malformedCompletionRunLists.length, 0);

  const matchingCompletionAuthorizations = [];
  const matchingCompletion = await execute({
    eventName: "workflow_run",
    run: workflowRun({ run_attempt: 2 }),
    listedRuns: [workflowRun({ run_attempt: 2 })],
    headBlob: CHANGED_BLOB,
    workflowAuthorizations: [workflowAuthorization()],
    authorizationStatuses: matchingCompletionAuthorizations,
  });
  assert.deepEqual(
    matchingCompletion.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );
  assert.equal(matchingCompletionAuthorizations.length, 2);

  const maxDescription = publishPrPolicy.qualityTransitionDescription(
    {
      number: Number.MAX_SAFE_INTEGER,
      contentFingerprint: "a".repeat(32),
      labelsFingerprint: "b".repeat(32),
    },
    "synchronize",
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(maxDescription.length, 131);
  assert.equal(Buffer.byteLength(maxDescription, "utf8"), 131);
  assert.throws(
    () =>
      publishPrPolicy.qualityTransitionDescription(
        {
          number: 63,
          contentFingerprint: PULL_CONTENT_FINGERPRINT,
          labelsFingerprint: PULL_LABELS_FINGERPRINT,
        },
        "edited",
        PULL_UPDATED_AT,
        0,
      ),
    /binding is invalid/,
  );
  assert.throws(
    () =>
      publishPrPolicy.pullIdentity(
        pull({ labels: [{ name: "duplicate" }, { name: "duplicate" }] }),
      ),
    /duplicate names/,
  );
  assert.throws(
    () => publishPrPolicy.pullIdentity(pull({ labels: [{}] })),
    /labels are malformed/,
  );

  const duplicateTransitionStatuses = [qualityTransitionStatus()];
  const duplicateTransition = await execute({
    eventName: "pull_request_target",
    eventAction: "edited",
    transitionStatuses: duplicateTransitionStatuses,
  });
  assert.deepEqual(
    duplicateTransition.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );
  assert.equal(duplicateTransitionStatuses.length, 1);
  assert.equal(
    duplicateTransition.statuses.some(({ context }) =>
      context.startsWith("trusted-quality-transition/"),
    ),
    false,
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
    transitionStatuses: [],
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

  const issuedAt = "2026-09-02T10:00:00.000Z";
  for (const createdAt of [
    "2026-09-02T09:59:59.000Z",
    issuedAt,
  ]) {
    const unboundAuthorizedTransitions = [
      qualityTransitionStatus({
        description: transitionDescription({ binding: null }),
      }),
    ];
    const unboundAuthorized = await execute({
      headBlob: CHANGED_BLOB,
      listedRuns: [
        workflowRun({
          created_at: createdAt,
        }),
      ],
      workflowAuthorizations: [
        workflowAuthorization({ issuedAt }),
      ],
      transitionStatuses: unboundAuthorizedTransitions,
    });
    assertNoQualitySuccess(unboundAuthorized);
    assert.equal(
      unboundAuthorizedTransitions[0].description,
      transitionDescription({ binding: null }),
    );
  }

  const delayedAuthorizedTransitions = [
    qualityTransitionStatus({
      description: transitionDescription({ binding: null }),
    }),
  ];
  const delayedAuthorizationStatuses = [];
  const preAuthorizationRun = workflowRun({
    id: 102,
    created_at: "2026-09-02T09:59:59.000Z",
    html_url: workflowRunUrl(102),
  });
  const postAuthorizationRun = workflowRun({
    id: 103,
    created_at: "2026-09-02T10:00:01.000Z",
    html_url: workflowRunUrl(103),
  });
  const beforeDelayedCompletion = await execute({
    headBlob: CHANGED_BLOB,
    listedRuns: [preAuthorizationRun],
    workflowAuthorizations: [
      workflowAuthorization({ issuedAt }),
    ],
    authorizationStatuses: delayedAuthorizationStatuses,
    transitionStatuses: delayedAuthorizedTransitions,
  });
  assertNoQualitySuccess(beforeDelayedCompletion);
  assert.equal(
    delayedAuthorizedTransitions[0].description,
    transitionDescription({ binding: null }),
  );
  const delayedAuthorizedCompletion = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    run: postAuthorizationRun,
    listedRuns: [preAuthorizationRun, postAuthorizationRun],
    workflowAuthorizations: [
      workflowAuthorization({ issuedAt }),
    ],
    authorizationStatuses: delayedAuthorizationStatuses,
    transitionStatuses: delayedAuthorizedTransitions,
  });
  assert.deepEqual(
    delayedAuthorizedCompletion.statuses
      .filter(({ context }) => context.startsWith("pr-quality-gates/"))
      .map(({ state }) => state),
    ["success", "success"],
  );
  assert.equal(
    delayedAuthorizedTransitions[0].description,
    transitionDescription({ binding: 103 }),
  );
  assert.deepEqual(
    delayedAuthorizationStatuses
      .filter(({ context }) =>
        context.startsWith("trusted-workflow-authorization/"),
      )
      .map(({ state }) => state),
    ["success", "pending"],
  );

  const immediateAuthorizedTransitions = [];
  const immediateAuthorized = await execute({
    eventName: "pull_request_target",
    eventAction: "edited",
    headBlob: CHANGED_BLOB,
    listedRuns: [preAuthorizationRun, postAuthorizationRun],
    workflowAuthorizations: [
      workflowAuthorization({ issuedAt }),
    ],
    transitionStatuses: immediateAuthorizedTransitions,
  });
  assertNoQualitySuccess(immediateAuthorized);
  assert.equal(
    immediateAuthorizedTransitions[0].description,
    transitionDescription({ binding: 103 }),
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
    pendingEvaluation.messages.join("\n"),
  );

  for (const status of [
    "in_progress",
    "pending",
    "queued",
    "requested",
    "waiting",
  ]) {
    const nonterminalReceipts = [];
    const nonterminalRun = workflowRun({
      status,
      conclusion: null,
    });
    const nonterminalEvaluation = await execute({
      eventName: "workflow_run",
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [workflowAuthorization()],
      authorizationStatuses: nonterminalReceipts,
      run: nonterminalRun,
      listedRuns: [nonterminalRun],
    });
    assert.deepEqual(
      nonterminalEvaluation.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["pending", "pending"],
    );
    assert.equal(nonterminalReceipts.length, 0);
  }

  for (const conclusion of [
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "startup_failure",
    "timed_out",
  ]) {
    const unsuccessfulReceipts = [];
    const unsuccessfulRun = workflowRun({
      status: "completed",
      conclusion,
    });
    const unsuccessfulEvaluation = await execute({
      eventName: "workflow_run",
      headBlob: CHANGED_BLOB,
      workflowAuthorizations: [workflowAuthorization()],
      authorizationStatuses: unsuccessfulReceipts,
      run: unsuccessfulRun,
      listedRuns: [unsuccessfulRun],
    });
    assert.deepEqual(
      unsuccessfulEvaluation.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["failure", "failure"],
    );
    assert.equal(unsuccessfulReceipts.length, 0);
  }

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
    ["failure", "failure"],
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
      html_url: workflowRunUrl(103),
    }),
    listedRuns: [
      workflowRun({
        id: 102,
        html_url: workflowRunUrl(102),
      }),
      workflowRun({
        id: 103,
        conclusion: "failure",
        html_url: workflowRunUrl(103),
      }),
    ],
    transitionStatuses: [
      qualityTransitionStatus({
        description: transitionDescription({ binding: 103 }),
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
        html_url: workflowRunUrl(103),
      }),
      listedRuns: [
        workflowRun({
          id: 102,
          html_url: workflowRunUrl(102),
        }),
        workflowRun({
          id: 103,
          ...candidateState,
          html_url: workflowRunUrl(103),
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
      html_url: workflowRunUrl(102),
    }),
    listedRuns: [
      workflowRun({
        id: 103,
        status: "in_progress",
        conclusion: null,
        created_at: "2026-09-02T11:00:00.000Z",
        html_url: workflowRunUrl(103),
      }),
    ],
    transitionStatuses: [
      qualityTransitionStatus({
        description: transitionDescription({ binding: 103 }),
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
            html_url: workflowRunUrl(102),
          }),
          workflowRun({
            id: 103,
            ...newerRunState,
            created_at: "2026-09-02T11:00:00.000Z",
            html_url: workflowRunUrl(103),
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
      html_url: workflowRunUrl(101),
    }),
    listedRuns: [
      workflowRun({
        id: 101,
        created_at: "2026-09-02T08:00:00.000Z",
        html_url: workflowRunUrl(101),
      }),
    ],
    workflowAuthorizations: [
      workflowAuthorization({
        issuedAt: "2026-09-01T12:00:00.000Z",
      }),
    ],
    transitionStatuses: [
      qualityTransitionStatus({
        description: transitionDescription({ binding: 103 }),
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

  for (const description of [
    transitionDescription().replace("|102|", "|z|"),
    transitionDescription().replace(
      PULL_CONTENT_FINGERPRINT,
      "a".repeat(31),
    ),
    transitionDescription({ number: Number.MAX_SAFE_INTEGER }),
  ]) {
    const malformedTransition = await execute({
      transitionStatuses: [
        qualityTransitionStatus({ description }),
      ],
    });
    assertNoQualitySuccess(malformedTransition);
    assert(
      malformedTransition.messages.some((message) =>
        message.includes("quality transition"),
      ),
    );
  }

  const malformedTransitionCreatedAt = await execute({
    transitionStatuses: [
      qualityTransitionStatus({ created_at: "not-a-timestamp" }),
    ],
  });
  assertNoQualitySuccess(malformedTransitionCreatedAt);
  assert(
    malformedTransitionCreatedAt.messages.some((message) =>
      message.includes("quality transition marker timestamp is malformed"),
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

  const olderTransitionMarker = qualityTransitionStatus({
    id: 901,
    target_url: workflowRunUrl(100),
    created_at: "2026-09-02T09:30:00.000Z",
    description: transitionDescription({
      action: "opened",
      timestamp: "2026-09-02T09:00:00.000Z",
    }),
  });
  const newerTransitionMarker = qualityTransitionStatus({
    id: 902,
    target_url: workflowRunUrl(101),
    created_at: "2026-09-02T09:31:00.000Z",
    description: transitionDescription({
      action: "edited",
      timestamp: "2026-09-02T09:01:00.000Z",
    }),
  });
  for (const invalidOlderPolicyRun of [
    {
      workflow_id: 999,
      path: ".github/workflows/other.yml",
    },
    {
      repository: { full_name: "other/repo" },
    },
    {
      pull_requests: [
        {
          number: 64,
          head: { sha: HEAD_SHA },
          base: { sha: BASE_SHA },
        },
      ],
    },
    {
      event: "workflow_dispatch",
    },
    {
      html_url: workflowRunUrl(999),
    },
  ]) {
    const invalidHistoricalMarker = await execute({
      transitionStatuses: [
        newerTransitionMarker,
        olderTransitionMarker,
      ],
      policyRunOverridesById: {
        100: invalidOlderPolicyRun,
      },
    });
    assertNoQualitySuccess(invalidHistoricalMarker);
    assert(
      invalidHistoricalMarker.messages.some((message) =>
        message.includes(
          "quality transition marker does not originate from branch-policy",
        ),
      ),
    );
  }

  const malformedNewestMarker = await execute({
    transitionStatuses: [
      qualityTransitionStatus({
        id: 902,
        target_url: workflowRunUrl(101),
        created_at: "2026-09-02T09:31:00.000Z",
        description: "malformed-newest-marker",
      }),
      olderTransitionMarker,
    ],
  });
  assertNoQualitySuccess(malformedNewestMarker);
  assert(
    malformedNewestMarker.messages.some((message) =>
      message.includes("quality transition marker"),
    ),
  );

  const recoveredTransition = await execute({
    transitionStatuses: [
      qualityTransitionStatus({
        description: transitionDescription({ binding: null }),
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
        description: transitionDescription({ binding: null }),
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
        description: transitionDescription({ binding: null }),
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

  const unsafeRunId = Number.MAX_SAFE_INTEGER + 1;
  for (const malformedRun of [
    { id: 103 },
    workflowRun({
      id: unsafeRunId,
      html_url: workflowRunUrl(unsafeRunId),
    }),
    workflowRun({
      id: 103,
      workflow_id: "202",
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      run_attempt: 0,
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      path: 42,
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      head_repository: { full_name: "malformed" },
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      pull_requests: [
        {
          number: 63,
          head: {},
          base: { sha: BASE_SHA },
        },
      ],
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      created_at: "not-a-timestamp",
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      status: "unknown",
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      conclusion: {},
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      status: "queued",
      conclusion: "success",
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      status: "in_progress",
      conclusion: "failure",
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      status: "completed",
      conclusion: null,
      html_url: workflowRunUrl(103),
    }),
    workflowRun({
      id: 103,
      html_url: workflowRunUrl(104),
    }),
  ]) {
    const malformedRunInventory = await execute({
      listedRuns: [workflowRun(), malformedRun],
    });
    assertNoQualitySuccess(malformedRunInventory);
    assert(
      malformedRunInventory.messages.some((message) =>
        message.includes("quality workflow run inventory is malformed"),
      ),
    );
  }

  for (const validNonmatchingState of [
    { status: "queued", conclusion: null },
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "success" },
  ]) {
    const validNonmatchingRunInventory = await execute({
      listedRuns: [
        workflowRun(),
        workflowRun({
          id: 103,
          path: ".github/workflows/other.yml",
          ...validNonmatchingState,
          html_url: workflowRunUrl(103),
        }),
      ],
    });
    assert.deepEqual(
      validNonmatchingRunInventory.statuses
        .filter(({ context }) => context.startsWith("pr-quality-gates/"))
        .map(({ state }) => state),
      ["success", "success"],
    );
  }

  const unrelatedRuns = Array.from({ length: 100 }, (_, index) =>
    workflowRun({
      id: 200 + index,
      head_sha: "9999999999999999999999999999999999999999",
      html_url: workflowRunUrl(200 + index),
    }),
  );
  const pagedSupersedingRun = workflowRun({
    id: 500,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-09-02T11:00:00.000Z",
    html_url: workflowRunUrl(500),
  });
  const pagedSupersededCompletion = await execute({
    eventName: "workflow_run",
    headBlob: CHANGED_BLOB,
    run: workflowRun({
      id: 102,
      html_url: workflowRunUrl(102),
    }),
    listedRuns: [...unrelatedRuns, pagedSupersedingRun],
    workflowAuthorizations: [workflowAuthorization()],
    transitionStatuses: [
      qualityTransitionStatus({
        description: transitionDescription({ binding: 500 }),
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
  assert.match(
    branchPolicy,
    /types:\s*\[opened, synchronize, reopened, edited, ready_for_review, labeled, unlabeled\]/,
  );
  assert.match(
    branchPolicy,
    /permissions:\s*\n\s*actions: read\s*\n\s*contents: read\s*\n\s*issues: read\s*\n\s*pull-requests: read\s*\n\s*statuses: write/,
  );
  assert.doesNotMatch(branchPolicy, /issues: write/);
  assert.match(
    branchPolicy,
    /description: Open pull request number to reconcile an existing trusted transition/,
  );
  const qualityTriggerActions = publisherSource.match(
    /const QUALITY_TRIGGER_ACTIONS = new Set\(\[([\s\S]*?)\]\);/,
  );
  assert(qualityTriggerActions);
  assert.doesNotMatch(qualityTriggerActions[1], /labeled|unlabeled/);

  console.log("publish_pr_policy_tests=PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
