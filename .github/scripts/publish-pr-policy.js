"use strict";

const crypto = require("node:crypto");

const BRANCH_CONTEXT_PREFIX = "branch-policy";
const QUALITY_CONTEXT_PREFIX = "pr-quality-gates";
const QUALITY_TRANSITION_CONTEXT_PREFIX = "trusted-quality-transition";
const BRANCH_WORKFLOW = "branch-policy.yml";
const BRANCH_WORKFLOW_PATH = `.github/workflows/${BRANCH_WORKFLOW}`;
const QUALITY_JOB = "pr-quality-gates";
const QUALITY_WORKFLOW = "production-build.yml";
const QUALITY_WORKFLOW_PATH = `.github/workflows/${QUALITY_WORKFLOW}`;
const GITHUB_ACTIONS_BOT = Object.freeze({
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
});
const CLI_MANAGED_LABEL = "copilot-cli-managed";
const QUALITY_TRIGGER_ACTIONS = new Set([
  "edited",
  "opened",
  "reopened",
  "synchronize",
]);
const SUPPORTED_PULL_REQUEST_TARGET_ACTIONS = new Set([
  ...QUALITY_TRIGGER_ACTIONS,
  "labeled",
  "ready_for_review",
  "unlabeled",
]);
const QUALITY_TRANSITION_PENDING = "p";
const QUALITY_TRANSITION_UNCONFIRMED = "u";
const QUALITY_TRANSITION_STALE = "x";
const MAX_STATUS_DESCRIPTION_LENGTH = 140;
const OPENING_RACE_WINDOW_MS = 300_000;
const MAX_WORKFLOW_AUTHORIZATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WORKFLOW_RUN_NONTERMINAL_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);
const WORKFLOW_RUN_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);
const WORKFLOW_RUN_TERMINAL_STATUSES = new Set(
  [...WORKFLOW_RUN_CONCLUSIONS].filter(
    (conclusion) => conclusion !== "startup_failure",
  ),
);
const WORKFLOW_AUTHORIZATION_FIELDS = [
  "authorizedBlob",
  "baseRef",
  "expiresAt",
  "headRef",
  "headRepository",
  "id",
  "issuedAt",
  "pullNumber",
  "receiptSha",
  "repository",
  "trustedBlob",
  "workflowPath",
];

// Exact workflow authorizations are added only in a separately promoted,
// short-lived policy change and removed immediately after their intended PR.
const TRUSTED_WORKFLOW_BLOB_AUTHORIZATIONS = Object.freeze([]);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 32);
}

function canonicalLabels(labels) {
  if (!Array.isArray(labels)) {
    throw new Error("Pull request labels are malformed");
  }
  const names = labels.map((label) => label?.name);
  if (
    names.some(
      (name) =>
        typeof name !== "string" ||
        name.length === 0 ||
        name.includes("\0"),
    )
  ) {
    throw new Error("Pull request labels are malformed");
  }
  names.sort();
  if (names.some((name, index) => index > 0 && name === names[index - 1])) {
    throw new Error("Pull request labels contain duplicate names");
  }
  return names;
}

function labelsFingerprint(labels) {
  return fingerprint(JSON.stringify(labels));
}

const EMPTY_LABELS_FINGERPRINT = labelsFingerprint([]);
const CLI_MANAGED_LABELS_FINGERPRINT = labelsFingerprint([
  CLI_MANAGED_LABEL,
]);

function pullIdentity(pull) {
  const labels = canonicalLabels(pull.labels);
  return {
    number: pull.number,
    state: pull.state,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    headRepository: pull.head.repo?.full_name || "",
    baseRef: pull.base.ref,
    baseSha: pull.base.sha,
    mergeSha: pull.merge_commit_sha || "",
    updatedAt: pull.updated_at,
    contentFingerprint: fingerprint(
      `${pull.title || ""}\0${pull.body || ""}`,
    ),
    labels,
    labelsFingerprint: labelsFingerprint(labels),
  };
}

function assertExpectedPull(actual, expected) {
  for (const key of [
    "number",
    "state",
    "headRef",
    "headSha",
    "headRepository",
    "baseRef",
    "baseSha",
    "updatedAt",
    "contentFingerprint",
    "labelsFingerprint",
  ]) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) {
      throw new Error(
        `Pull request changed during policy evaluation: ${key} ` +
          `expected=${expected[key]} actual=${actual[key]}`,
      );
    }
  }
}

function isOpeningCliLabelRace(actual, expected) {
  if (
    expected.labels?.length !== 0 ||
    actual.labels?.length !== 1 ||
    actual.labels[0] !== CLI_MANAGED_LABEL
  ) {
    return false;
  }
  for (const key of [
    "number",
    "state",
    "headRef",
    "headSha",
    "headRepository",
    "baseRef",
    "baseSha",
    "contentFingerprint",
  ]) {
    if (actual[key] !== expected[key]) {
      return false;
    }
  }
  const actualUpdatedAt = Date.parse(actual.updatedAt);
  const expectedUpdatedAt = Date.parse(expected.updatedAt);
  return (
    Number.isFinite(actualUpdatedAt) &&
    Number.isFinite(expectedUpdatedAt) &&
    actualUpdatedAt >= expectedUpdatedAt
  );
}

function isBoundedOpeningCliLabelRace(actual, expected) {
  if (!isOpeningCliLabelRace(actual, expected)) {
    return false;
  }
  return isWithinOpeningRaceWindow(
    githubTimestampMilliseconds(
      expected.updatedAt,
      "opened pull request updated_at",
    ),
    githubTimestampMilliseconds(
      actual.updatedAt,
      "current pull request updated_at",
    ),
  );
}

function isLabelRefreshSnapshot(actual, expected) {
  for (const key of [
    "number",
    "state",
    "headRef",
    "headSha",
    "headRepository",
    "baseRef",
    "baseSha",
    "contentFingerprint",
  ]) {
    if (actual[key] !== expected[key]) {
      return false;
    }
  }
  const actualUpdatedAt = Date.parse(actual.updatedAt);
  const expectedUpdatedAt = Date.parse(expected.updatedAt);
  return (
    Number.isFinite(actualUpdatedAt) &&
    Number.isFinite(expectedUpdatedAt) &&
    actualUpdatedAt >= expectedUpdatedAt
  );
}

function branchDecision(pull, repository) {
  if (pull.baseRef === "master") {
    const allowed =
      pull.headRef === "dev" && pull.headRepository === repository;
    return {
      allowed,
      description: allowed
        ? "Trusted dev-to-master production promotion"
        : "Only this repository's dev branch may target master",
    };
  }

  if (pull.baseRef === "dev") {
    const allowed = pull.headRef !== "master" && pull.headRef !== "dev";
    return {
      allowed,
      description: allowed
        ? "Normal change targets dev"
        : "Unsupported source branch for dev",
    };
  }

  return {
    allowed: false,
    description: "Pull requests must target dev or master",
  };
}

function assertExactAuthorizationFields(authorization) {
  if (!authorization || typeof authorization !== "object") {
    throw new Error("workflow authorization must be an object");
  }
  const actualFields = Object.keys(authorization).sort();
  if (
    actualFields.length !== WORKFLOW_AUTHORIZATION_FIELDS.length ||
    actualFields.some(
      (field, index) => field !== WORKFLOW_AUTHORIZATION_FIELDS[index],
    )
  ) {
    throw new Error("workflow authorization has unexpected fields");
  }
}

function assertSafeExactString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`workflow authorization ${label} is invalid`);
  }
}

function parseAuthorizationTime(value, label) {
  if (typeof value !== "string") {
    throw new Error(`workflow authorization ${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`workflow authorization ${label} is invalid`);
  }
  return milliseconds;
}

function validateWorkflowAuthorization(authorization, nowMilliseconds) {
  assertExactAuthorizationFields(authorization);
  assertSafeExactString(
    authorization.id,
    "id",
    /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/,
  );
  assertSafeExactString(
    authorization.repository,
    "repository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  assertSafeExactString(
    authorization.headRepository,
    "headRepository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  if (
    authorization.workflowPath !== QUALITY_WORKFLOW_PATH ||
    authorization.workflowPath.includes("*")
  ) {
    throw new Error("workflow authorization workflowPath is invalid");
  }
  for (const field of ["trustedBlob", "authorizedBlob", "receiptSha"]) {
    assertSafeExactString(
      authorization[field],
      field,
      /^[0-9a-f]{40}$/,
    );
  }
  if (authorization.trustedBlob === authorization.authorizedBlob) {
    throw new Error("workflow authorization does not authorize a change");
  }
  if (
    !Number.isInteger(authorization.pullNumber) ||
    authorization.pullNumber < 1
  ) {
    throw new Error("workflow authorization pullNumber is invalid");
  }
  for (const field of ["headRef", "baseRef"]) {
    assertSafeExactString(
      authorization[field],
      field,
      /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,253}[A-Za-z0-9._-])?$/,
    );
    if (
      authorization[field].includes("..") ||
      authorization[field].includes("//") ||
      authorization[field].includes("@{") ||
      /[*?\[\]\\]/.test(authorization[field])
    ) {
      throw new Error(`workflow authorization ${field} is invalid`);
    }
  }
  if (!["dev", "master"].includes(authorization.baseRef)) {
    throw new Error("workflow authorization baseRef is invalid");
  }

  const issuedAt = parseAuthorizationTime(authorization.issuedAt, "issuedAt");
  const expiresAt = parseAuthorizationTime(
    authorization.expiresAt,
    "expiresAt",
  );
  if (
    issuedAt > nowMilliseconds ||
    expiresAt <= nowMilliseconds ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_WORKFLOW_AUTHORIZATION_AGE_MS
  ) {
    throw new Error("workflow authorization is stale or expired");
  }
}

function findWorkflowAuthorization({
  authorizations,
  repository,
  workflowPath,
  trustedBlob,
  authorizedBlob,
  pull,
  now,
}) {
  if (!Array.isArray(authorizations)) {
    throw new Error("workflow authorizations must be an array");
  }
  const nowMilliseconds =
    now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("workflow authorization clock is invalid");
  }

  const seenIds = new Set();
  for (const authorization of authorizations) {
    validateWorkflowAuthorization(authorization, nowMilliseconds);
    if (seenIds.has(authorization.id)) {
      throw new Error(`duplicate workflow authorization id ${authorization.id}`);
    }
    seenIds.add(authorization.id);
  }

  const matches = authorizations.filter(
    (authorization) =>
      authorization.repository === repository &&
      authorization.headRepository === repository &&
      pull.headRepository === repository &&
      authorization.workflowPath === workflowPath &&
      authorization.trustedBlob === trustedBlob &&
      authorization.authorizedBlob === authorizedBlob &&
      authorization.pullNumber === pull.number &&
      authorization.headRepository === pull.headRepository &&
      authorization.headRef === pull.headRef &&
      authorization.baseRef === pull.baseRef,
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length !== 1) {
    throw new Error("multiple workflow authorizations match one pull request");
  }

  return matches[0];
}

function workflowAuthorizationContext(authorization) {
  return `trusted-workflow-authorization/${authorization.id}`;
}

async function listCommitStatuses(github, owner, repo, ref) {
  const statuses = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await github.rest.repos.listCommitStatusesForRef({
      owner,
      repo,
      ref,
      per_page: 100,
      page,
    });
    if (!Array.isArray(response.data)) {
      throw new Error("workflow authorization receipt response is malformed");
    }
    for (const status of response.data) {
      if (
        !status ||
        typeof status !== "object" ||
        !Number.isInteger(status.id) ||
        status.id < 1 ||
        typeof status.context !== "string" ||
        status.context.length < 1 ||
        status.context.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(status.context) ||
        !["error", "failure", "pending", "success"].includes(status.state) ||
        !(
          status.description === null ||
          typeof status.description === "string"
        ) ||
        !(status.target_url === null || typeof status.target_url === "string")
      ) {
        throw new Error(
          "workflow authorization receipt entry is malformed",
        );
      }
    }
    statuses.push(...response.data);
    if (response.data.length < 100) {
      return statuses;
    }
  }
  throw new Error("workflow authorization receipt inventory is incomplete");
}

async function claimWorkflowAuthorization({
  github,
  owner,
  repo,
  authorization,
  pull,
  targetUrl,
}) {
  const comparison = await github.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${authorization.receiptSha}...${pull.headSha}`,
  });
  if (
    !["ahead", "identical"].includes(comparison.data.status) ||
    comparison.data.merge_base_commit?.sha !== authorization.receiptSha
  ) {
    throw new Error(
      `workflow authorization ${authorization.id} receipt is not an ancestor`,
    );
  }

  const context = workflowAuthorizationContext(authorization);
  const statuses = await listCommitStatuses(
    github,
    owner,
    repo,
    authorization.receiptSha,
  );
  if (statuses.some((status) => status.context === context)) {
    throw new Error(
      `workflow authorization ${authorization.id} was already consumed`,
    );
  }

  const description =
    `PR #${pull.number} ${authorization.workflowPath} ` +
    `${authorization.authorizedBlob.slice(0, 12)}`;
  await publishStatus(
    github,
    owner,
    repo,
    authorization.receiptSha,
    context,
    "pending",
    description,
    targetUrl,
  );
  await publishStatus(
    github,
    owner,
    repo,
    authorization.receiptSha,
    context,
    "success",
    description,
    targetUrl,
  );
}

function runMatchesPull(run, pull, workflowId) {
  const relations = run.pull_requests;
  const relation =
    Array.isArray(relations) && relations.length === 1
      ? relations[0]
      : null;
  const relationMatches =
    relation?.number === pull.number &&
    relation.head?.sha === pull.headSha &&
    relation.base?.sha === pull.baseSha;
  return (
    run.workflow_id === workflowId &&
    run.path === QUALITY_WORKFLOW_PATH &&
    run.event === "pull_request" &&
    run.head_sha === pull.headSha &&
    run.head_repository?.full_name === pull.headRepository &&
    relationMatches
  );
}

function qualityTransitionContext(pull) {
  return `${QUALITY_TRANSITION_CONTEXT_PREFIX}/${pull.baseRef}`;
}

function transitionTimestampMilliseconds(timestamp) {
  const transitionAt =
    typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (
    !Number.isSafeInteger(transitionAt) ||
    transitionAt < 0
  ) {
    throw new Error("workflow-producing transition timestamp is invalid");
  }
  return transitionAt;
}

function githubTimestampMilliseconds(timestamp, label) {
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      timestamp,
    )
  ) {
    throw new Error(`${label} timestamp is malformed`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error(`${label} timestamp is malformed`);
  }
  return milliseconds;
}

function isWithinOpeningRaceWindow(transitionAt, labelAt) {
  return (
    labelAt >= transitionAt &&
    labelAt - transitionAt <= OPENING_RACE_WINDOW_MS
  );
}

function workflowRunUrl(serverUrl, owner, repo, runId) {
  return (
    `${serverUrl.replace(/\/$/, "")}/${owner}/${repo}/actions/runs/` +
    runId
  );
}

function qualityTransitionDescription(pull, action, timestamp, binding) {
  if (
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    !QUALITY_TRIGGER_ACTIONS.has(action)
  ) {
    throw new Error("quality transition marker fields are invalid");
  }
  const transitionAt = transitionTimestampMilliseconds(timestamp);
  let bindingText;
  if (binding === null) {
    bindingText = QUALITY_TRANSITION_PENDING;
  } else if (binding === QUALITY_TRANSITION_UNCONFIRMED) {
    bindingText = QUALITY_TRANSITION_UNCONFIRMED;
  } else if (binding === QUALITY_TRANSITION_STALE) {
    bindingText = QUALITY_TRANSITION_STALE;
  } else if (Number.isSafeInteger(binding) && binding > 0) {
    bindingText = String(binding);
  } else {
    throw new Error("quality transition marker binding is invalid");
  }
  const description =
    `v3|${pull.number}|${action}|${transitionAt}|${bindingText}|` +
    `${pull.contentFingerprint}|${pull.labelsFingerprint}`;
  if (
    description.length > MAX_STATUS_DESCRIPTION_LENGTH ||
    Buffer.byteLength(description, "utf8") > MAX_STATUS_DESCRIPTION_LENGTH
  ) {
    throw new Error("quality transition marker description is too long");
  }
  return description;
}

function parseQualityTransitionDescription(description, pullNumber) {
  const versionedMatch = description.match(
    /^v(2|3)\|([1-9][0-9]*)\|(edited|opened|reopened|synchronize)\|(0|[1-9][0-9]*)\|(u|p|x|[1-9][0-9]*)\|([0-9a-f]{32})\|([0-9a-f]{32})$/,
  );
  if (versionedMatch) {
    const version = Number(versionedMatch[1]);
    const markerPullNumber = Number(versionedMatch[2]);
    const action = versionedMatch[3];
    const transitionAt = Number(versionedMatch[4]);
    const binding = versionedMatch[5];
    const contentFingerprint = versionedMatch[6];
    const labelsFingerprint = versionedMatch[7];
    const runId =
      binding === QUALITY_TRANSITION_PENDING ||
      binding === QUALITY_TRANSITION_UNCONFIRMED ||
      binding === QUALITY_TRANSITION_STALE
        ? null
        : Number(binding);
    if (
      !Number.isSafeInteger(markerPullNumber) ||
      markerPullNumber !== pullNumber ||
      !Number.isSafeInteger(transitionAt) ||
      !(runId === null || Number.isSafeInteger(runId)) ||
      (version === 2 && binding === QUALITY_TRANSITION_UNCONFIRMED) ||
      (binding === QUALITY_TRANSITION_UNCONFIRMED &&
        (action !== "opened" ||
          labelsFingerprint !== CLI_MANAGED_LABELS_FINGERPRINT))
    ) {
      throw new Error(
        "quality transition marker does not match the pull request",
      );
    }
    return {
      version,
      action,
      transitionAt,
      runId,
      unconfirmed: binding === QUALITY_TRANSITION_UNCONFIRMED,
      stale: binding === QUALITY_TRANSITION_STALE,
      contentFingerprint,
      labelsFingerprint,
    };
  }

  const escapedNumber = String(pullNumber).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const legacyMatch = description.match(
    new RegExp(
      `^PR #${escapedNumber} ` +
        `(edited|opened|reopened|synchronize) ` +
        `(\\S+) run (pending|[1-9][0-9]*) ` +
        `content ([0-9a-f]{32})$`,
    ),
  );
  if (!legacyMatch) {
    throw new Error(
      "quality transition marker does not match the pull request",
    );
  }
  const transitionAt = Date.parse(legacyMatch[2]);
  const runId =
    legacyMatch[3] === "pending" ? null : Number(legacyMatch[3]);
  if (
    !Number.isFinite(transitionAt) ||
    !(runId === null || Number.isSafeInteger(runId))
  ) {
    throw new Error("quality transition marker is malformed");
  }
  return {
    version: 1,
    action: legacyMatch[1],
    transitionAt,
    runId,
    unconfirmed: false,
    stale: false,
    contentFingerprint: legacyMatch[4],
    labelsFingerprint: null,
  };
}

function qualityTransitionRank(transition) {
  if (transition.runId !== null) {
    return 3;
  }
  if (!transition.unconfirmed) {
    return 2;
  }
  return 1;
}

function resolveQualityTransition(transitions) {
  const transitionAt = Math.max(
    ...transitions.map((transition) => transition.transitionAt),
  );
  const candidates = transitions.filter(
    (transition) => transition.transitionAt === transitionAt,
  );
  const tombstones = candidates.filter((candidate) => candidate.stale);
  if (tombstones.length > 0) {
    return tombstones.sort(
      (left, right) => right.statusId - left.statusId,
    )[0];
  }
  const legacy = candidates.filter((candidate) => candidate.version !== 3);
  if (legacy.length > 0) {
    return legacy.sort(
      (left, right) => right.statusId - left.statusId,
    )[0];
  }
  for (const field of ["action", "contentFingerprint", "targetUrl"]) {
    if (new Set(candidates.map((candidate) => candidate[field])).size !== 1) {
      throw new Error("quality transition marker lineage conflicts");
    }
  }

  const runIds = new Set(
    candidates
      .map((candidate) => candidate.runId)
      .filter((runId) => runId !== null),
  );
  if (runIds.size > 1) {
    throw new Error("quality transition marker run bindings conflict");
  }

  const action = candidates[0].action;
  const labelsFingerprints = new Set(
    candidates.map((candidate) => candidate.labelsFingerprint),
  );
  const unconfirmed = candidates.filter(
    (candidate) => candidate.unconfirmed,
  );
  if (
    unconfirmed.some(
      (candidate) =>
        candidate.action !== "opened" ||
        candidate.labelsFingerprint !== CLI_MANAGED_LABELS_FINGERPRINT,
    )
  ) {
    throw new Error("quality transition marker provisional state is invalid");
  }
  if (action !== "opened" && labelsFingerprints.size !== 1) {
    throw new Error("quality transition marker label lineage conflicts");
  }
  if (action === "opened" && labelsFingerprints.size > 1) {
    if (
      labelsFingerprints.size !== 2 ||
      !labelsFingerprints.has(EMPTY_LABELS_FINGERPRINT) ||
      !labelsFingerprints.has(CLI_MANAGED_LABELS_FINGERPRINT) ||
      unconfirmed.length > 0
    ) {
      throw new Error("quality transition marker label lineage conflicts");
    }
    const emptyLabelTransitions = candidates.filter(
      (candidate) =>
        candidate.labelsFingerprint === EMPTY_LABELS_FINGERPRINT,
    );
    const managedLabelTransitions = candidates.filter(
      (candidate) =>
        candidate.labelsFingerprint === CLI_MANAGED_LABELS_FINGERPRINT,
    );
    if (
      emptyLabelTransitions.some((candidate) => candidate.runId !== null) &&
      managedLabelTransitions.some((candidate) => candidate.runId === null)
    ) {
      throw new Error("quality transition marker label binding regressed");
    }
  }

  return candidates.sort(
    (left, right) =>
      qualityTransitionRank(right) - qualityTransitionRank(left) ||
      right.statusId - left.statusId,
  )[0];
}

async function getQualityTransition({
  github,
  owner,
  repo,
  pull,
  serverUrl,
}) {
  const context = qualityTransitionContext(pull);
  const statuses = await listCommitStatuses(
    github,
    owner,
    repo,
    pull.mergeSha,
  );
  const markers = statuses.filter((status) => status.context === context);
  if (markers.length === 0) {
    return null;
  }
  const parsed = markers.map((marker) => {
    const expectedRunUrlPrefix =
      `${serverUrl.replace(/\/$/, "")}/${owner}/${repo}/actions/runs/`;
    if (
      !Number.isSafeInteger(marker.id) ||
      marker.id < 1 ||
      marker.state !== "pending" ||
      typeof marker.description !== "string" ||
      marker.creator?.id !== GITHUB_ACTIONS_BOT.id ||
      marker.creator?.login !== GITHUB_ACTIONS_BOT.login ||
      marker.creator?.type !== GITHUB_ACTIONS_BOT.type ||
      typeof marker.target_url !== "string" ||
      !marker.target_url.startsWith(expectedRunUrlPrefix) ||
      marker.description.length > MAX_STATUS_DESCRIPTION_LENGTH ||
      Buffer.byteLength(marker.description, "utf8") >
        MAX_STATUS_DESCRIPTION_LENGTH
    ) {
      throw new Error("quality transition marker is malformed");
    }
    const policyRunIdText = marker.target_url.slice(
      expectedRunUrlPrefix.length,
    );
    const policyRunId = Number(policyRunIdText);
    if (
      !/^[1-9][0-9]*$/.test(policyRunIdText) ||
      !Number.isSafeInteger(policyRunId)
    ) {
      throw new Error("quality transition marker run URL is malformed");
    }
    const transition = parseQualityTransitionDescription(
      marker.description,
      pull.number,
    );
    return {
      ...transition,
      policyRunId,
      targetUrl: marker.target_url,
      statusId: marker.id,
      statusCreatedAt: githubTimestampMilliseconds(
        marker.created_at,
        "quality transition marker",
      ),
    };
  });
  const workflowResponse = await github.rest.actions.getWorkflow({
    owner,
    repo,
    workflow_id: BRANCH_WORKFLOW,
  });
  const policyRuns = new Map(
    await Promise.all(
      [...new Set(parsed.map(({ policyRunId }) => policyRunId))].map(
        async (policyRunId) => {
          const response = await github.rest.actions.getWorkflowRun({
            owner,
            repo,
            run_id: policyRunId,
          });
          return [policyRunId, response.data];
        },
      ),
    ),
  );
  for (const candidate of parsed) {
    const policyRun = policyRuns.get(candidate.policyRunId);
    const relations = Array.isArray(policyRun?.pull_requests)
      ? policyRun.pull_requests
      : [];
    const relation = relations[0];
    if (
      !policyRun ||
      policyRun.id !== candidate.policyRunId ||
      policyRun.workflow_id !== workflowResponse.data.id ||
      policyRun.path !== BRANCH_WORKFLOW_PATH ||
      policyRun.event !== "pull_request_target" ||
      policyRun.repository?.full_name !== `${owner}/${repo}` ||
      policyRun.html_url !== candidate.targetUrl ||
      relations.length !== 1 ||
      relation.number !== pull.number ||
      relation.head?.sha !== pull.headSha ||
      relation.base?.sha !== pull.baseSha
    ) {
      throw new Error(
        "quality transition marker does not originate from branch-policy",
      );
    }
  }
  for (const candidate of parsed) {
    candidate.lineageCreatedAt = Math.min(
      ...parsed
        .filter(
          (marker) =>
            marker.version === candidate.version &&
            marker.action === candidate.action &&
            marker.transitionAt === candidate.transitionAt &&
            marker.contentFingerprint === candidate.contentFingerprint &&
            marker.labelsFingerprint === candidate.labelsFingerprint &&
            marker.targetUrl === candidate.targetUrl,
        )
        .map(({ statusCreatedAt }) => statusCreatedAt),
    );
  }
  return resolveQualityTransition(parsed);
}

async function getWorkflowBlob(github, repository, path, ref) {
  const [owner, repo] = repository.split("/");
  const response = await github.rest.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });
  if (Array.isArray(response.data) || response.data.type !== "file") {
    throw new Error(`Expected ${repository}:${path}@${ref} to be a file`);
  }
  return response.data.sha;
}

async function resolveQualityWorkflowTrust({
  github,
  owner,
  repo,
  pull,
  workflowAuthorizations,
  authorizationNow,
  fallbackUrl,
}) {
  const repository = `${owner}/${repo}`;
  const repositoryResponse = await github.rest.repos.get({ owner, repo });
  const defaultBranch = repositoryResponse.data.default_branch;
  const workflowResponse = await github.rest.actions.getWorkflow({
    owner,
    repo,
    workflow_id: QUALITY_WORKFLOW,
  });
  const workflowId = workflowResponse.data.id;

  let trustedBlob;
  let headBlob;
  try {
    [trustedBlob, headBlob] = await Promise.all([
      getWorkflowBlob(
        github,
        repository,
        QUALITY_WORKFLOW_PATH,
        defaultBranch,
      ),
      getWorkflowBlob(
        github,
        pull.headRepository,
        QUALITY_WORKFLOW_PATH,
        pull.headSha,
      ),
    ]);
  } catch (error) {
    return {
      failure: {
        state: "failure",
        description: `PR #${pull.number} cannot verify trusted quality workflow`,
        targetUrl: fallbackUrl,
        reason: error.message,
      },
    };
  }

  let authorization = null;
  if (trustedBlob !== headBlob) {
    try {
      authorization = findWorkflowAuthorization({
        authorizations: workflowAuthorizations,
        repository,
        workflowPath: QUALITY_WORKFLOW_PATH,
        trustedBlob,
        authorizedBlob: headBlob,
        pull,
        now: authorizationNow,
      });
    } catch (error) {
      return {
        failure: {
          state: "failure",
          description: `PR #${pull.number} has invalid workflow authorization`,
          targetUrl: fallbackUrl,
          reason: error.message,
        },
      };
    }
    if (!authorization) {
      return {
        failure: {
          state: "failure",
          description: `PR #${pull.number} changes the trusted quality workflow`,
          targetUrl: fallbackUrl,
          reason:
            "quality workflow differs from the current default branch without " +
            "an exact PR-bound authorization",
        },
      };
    }
  }

  return { workflowId, authorization, failure: null };
}

async function getCurrentPull(
  github,
  owner,
  repo,
  number,
  expected,
  {
    allowLabelRefreshReconciliation = false,
    allowOpeningLabelSnapshotMismatch = false,
  } = {},
) {
  let current;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    current = pullIdentity(response.data);
    if (
      !(
        (allowOpeningLabelSnapshotMismatch &&
          isOpeningCliLabelRace(current, expected)) ||
        (allowLabelRefreshReconciliation &&
          isLabelRefreshSnapshot(current, expected))
      )
    ) {
      assertExpectedPull(current, expected);
    }

    if (current.state !== "open") {
      throw new Error(`Pull request #${number} is not open`);
    }
    if (response.data.mergeable === false) {
      throw new Error(`Pull request #${number} has no mergeable snapshot`);
    }
    if (current.mergeSha && response.data.mergeable !== null) {
      if (current.mergeSha === current.headSha) {
        throw new Error(`Pull request #${number} has no unique merge snapshot`);
      }
      return current;
    }
    await sleep(2000);
  }

  throw new Error(`GitHub did not produce a current merge snapshot for #${number}`);
}

async function listQualityWorkflowRuns(
  github,
  owner,
  repo,
  workflowId,
  headSha,
  serverUrl,
) {
  const runs = [];
  const seenRunIds = new Set();
  let expectedTotal = null;
  for (let page = 1; page <= 10; page += 1) {
    const response = await github.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowId,
      event: "pull_request",
      head_sha: headSha,
      per_page: 100,
      page,
    });
    const totalCount = response.data?.total_count;
    const pageRuns = response.data?.workflow_runs;
    if (
      !Number.isInteger(totalCount) ||
      totalCount < 0 ||
      totalCount > 1000 ||
      !Array.isArray(pageRuns) ||
      pageRuns.length > 100 ||
      pageRuns.some(
        (run) => {
          try {
            assertQualityWorkflowRunInventoryEntry({
              run,
              owner,
              repo,
              serverUrl,
            });
            return false;
          } catch {
            return true;
          }
        },
      )
    ) {
      throw new Error("quality workflow run inventory is malformed");
    }
    if (expectedTotal === null) {
      expectedTotal = totalCount;
    } else if (totalCount !== expectedTotal) {
      throw new Error("quality workflow run inventory changed while paging");
    }
    for (const run of pageRuns) {
      if (seenRunIds.has(run.id)) {
        throw new Error("quality workflow run inventory contains duplicate IDs");
      }
      seenRunIds.add(run.id);
    }
    runs.push(...pageRuns);
    if (runs.length === expectedTotal) {
      return runs;
    }
    if (runs.length > expectedTotal || pageRuns.length < 100) {
      throw new Error("quality workflow run inventory is incomplete");
    }
  }
  throw new Error("quality workflow run inventory exceeds the bounded scan");
}

function assertQualityWorkflowRunInventoryEntry({
  run,
  owner,
  repo,
  serverUrl,
}) {
  const safeString = (value, maximumLength) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/.test(value);
  const validRelations =
    Array.isArray(run?.pull_requests) &&
    run.pull_requests.length <= 100 &&
    run.pull_requests.every(
      (relation) =>
        relation &&
        typeof relation === "object" &&
        !Array.isArray(relation) &&
        Number.isSafeInteger(relation.number) &&
        relation.number > 0 &&
        relation.head &&
        typeof relation.head === "object" &&
        !Array.isArray(relation.head) &&
        /^[0-9a-f]{40}$/.test(relation.head.sha) &&
        relation.base &&
        typeof relation.base === "object" &&
        !Array.isArray(relation.base) &&
        /^[0-9a-f]{40}$/.test(relation.base.sha),
    );
  let validCreatedAt = true;
  try {
    githubTimestampMilliseconds(
      run?.created_at,
      "quality workflow run created_at",
    );
  } catch {
    validCreatedAt = false;
  }
  if (
    !run ||
    typeof run !== "object" ||
    Array.isArray(run) ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    !Number.isSafeInteger(run.workflow_id) ||
    run.workflow_id < 1 ||
    !safeString(run.path, 1024) ||
    !safeString(run.event, 100) ||
    !/^[0-9a-f]{40}$/.test(run.head_sha) ||
    !run.head_repository ||
    typeof run.head_repository !== "object" ||
    Array.isArray(run.head_repository) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      run.head_repository.full_name,
    ) ||
    !validRelations ||
    !validCreatedAt ||
    !isValidWorkflowRunState(run.status, run.conclusion) ||
    run.html_url !== workflowRunUrl(serverUrl, owner, repo, run.id)
  ) {
    throw new Error("quality workflow run inventory entry is malformed");
  }
}

function assertQualityWorkflowRunCandidate({
  run,
  owner,
  repo,
  serverUrl,
}) {
  assertQualityWorkflowRunInventoryEntry({
    run,
    owner,
    repo,
    serverUrl,
  });
  if (run.pull_requests.length !== 1) {
    throw new Error(
      "Completed quality workflow must have exactly one pull request relation",
    );
  }
}

function isValidWorkflowRunState(status, conclusion) {
  if (status === "completed") {
    return WORKFLOW_RUN_CONCLUSIONS.has(conclusion);
  }
  if (WORKFLOW_RUN_NONTERMINAL_STATUSES.has(status)) {
    return conclusion === null;
  }
  return (
    WORKFLOW_RUN_TERMINAL_STATUSES.has(status) &&
    conclusion === status
  );
}

function qualityWorkflowRunEvidence(run) {
  return JSON.stringify([
    run.id,
    run.run_attempt,
    run.workflow_id,
    run.path,
    run.event,
    run.head_sha,
    run.head_repository.full_name,
    run.pull_requests.map((relation) => [
      relation.number,
      relation.head.sha,
      relation.base.sha,
    ]),
    run.html_url,
    githubTimestampMilliseconds(
      run.created_at,
      "quality workflow run created_at",
    ),
    run.status,
    run.conclusion,
  ]);
}

function matchingWorkflowRunCandidate({
  candidateRun,
  runs,
  owner,
  repo,
  serverUrl,
}) {
  assertQualityWorkflowRunCandidate({
    run: candidateRun,
    owner,
    repo,
    serverUrl,
  });
  const listedRun = runs.find((run) => run.id === candidateRun.id);
  return (
    listedRun &&
    qualityWorkflowRunEvidence(candidateRun) ===
      qualityWorkflowRunEvidence(listedRun)
      ? listedRun
      : null
  );
}

async function findQualityTransitionRun({
  github,
  owner,
  repo,
  pull,
  timestamp,
  serverUrl,
  authorization = null,
}) {
  const transitionAt = Date.parse(timestamp);
  if (!Number.isFinite(transitionAt)) {
    throw new Error("workflow-producing transition timestamp is invalid");
  }
  const workflowResponse = await github.rest.actions.getWorkflow({
    owner,
    repo,
    workflow_id: QUALITY_WORKFLOW,
  });
  const workflowId = workflowResponse.data.id;
  const minimumCreatedAt = qualityRunSelectionCutoff(
    transitionAt,
    authorization,
  );
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const runs = await listQualityWorkflowRuns(
      github,
      owner,
      repo,
      workflowId,
      pull.headSha,
      serverUrl,
    );
    const candidate = selectQualityTransitionRun(
      runs,
      pull,
      workflowId,
      minimumCreatedAt,
    );
    if (candidate) {
      return candidate;
    }
    if (attempt < 5) {
      await sleep(2000);
    }
  }
  return null;
}

function selectQualityTransitionRun(
  runs,
  pull,
  workflowId,
  minimumCreatedAt,
) {
  return (
    runs
      .filter((run) => runMatchesPull(run, pull, workflowId))
      .filter((run) => {
        const createdAt = Date.parse(run.created_at);
        return Number.isFinite(createdAt) && createdAt > minimumCreatedAt;
      })
      .sort((left, right) => right.id - left.id)[0] || null
  );
}

function qualityRunSelectionCutoff(transitionAt, authorization) {
  if (!authorization) {
    return transitionAt;
  }
  return Math.max(
    transitionAt,
    parseAuthorizationTime(authorization.issuedAt, "issuedAt"),
  );
}

function transitionMatchesPullIdentity(transition, pull) {
  return (
    transition.contentFingerprint === pull.contentFingerprint &&
    transition.labelsFingerprint === pull.labelsFingerprint
  );
}

function hasSameValidatedPullUpdate(eventPull, pull) {
  return (
    githubTimestampMilliseconds(
      eventPull.updatedAt,
      "pull request event updated_at",
    ) ===
    githubTimestampMilliseconds(
      pull.updatedAt,
      "current pull request updated_at",
    )
  );
}

function isOpeningLabelLineage(transition, pull) {
  return (
    transition.version === 3 &&
    transition.action === "opened" &&
    !transition.unconfirmed &&
    !transition.stale &&
    transition.contentFingerprint === pull.contentFingerprint &&
    transition.labelsFingerprint === EMPTY_LABELS_FINGERPRINT &&
    pull.labels.length === 1 &&
    pull.labels[0] === CLI_MANAGED_LABEL
  );
}

function hasInverseOpeningLabelEvidence({
  transition,
  pull,
  eventAction,
  eventLabelName,
  eventPull,
}) {
  if (
    eventAction !== "labeled" ||
    eventLabelName !== CLI_MANAGED_LABEL ||
    eventPull?.labels?.length !== 1 ||
    eventPull.labels[0] !== CLI_MANAGED_LABEL ||
    eventPull.contentFingerprint !== pull.contentFingerprint ||
    eventPull.labelsFingerprint !== pull.labelsFingerprint ||
    !hasSameValidatedPullUpdate(eventPull, pull)
  ) {
    return false;
  }
  return isWithinOpeningRaceWindow(
    transition.transitionAt,
    githubTimestampMilliseconds(
      eventPull.updatedAt,
      "pull request event updated_at",
    ),
  );
}

function canReconcileOpeningLabelLineage({
  transition,
  pull,
  eventAction,
  eventLabelName,
  eventPull,
}) {
  return (
    isOpeningLabelLineage(transition, pull) &&
    hasInverseOpeningLabelEvidence({
      transition,
      pull,
      eventAction,
      eventLabelName,
      eventPull,
    })
  );
}

function hasDirectOpeningLabelEvidence({
  transition,
  pull,
  eventAction,
  eventLabelName,
  eventPull,
}) {
  if (
    eventAction !== "labeled" ||
    eventLabelName !== CLI_MANAGED_LABEL ||
    eventPull?.labels?.length !== 1 ||
    eventPull.labels[0] !== CLI_MANAGED_LABEL ||
    pull.labels.length !== 1 ||
    pull.labels[0] !== CLI_MANAGED_LABEL ||
    transition.version !== 3 ||
    transition.action !== "opened" ||
    transition.stale ||
    !transitionMatchesPullIdentity(transition, pull) ||
    eventPull.contentFingerprint !== pull.contentFingerprint ||
    eventPull.labelsFingerprint !== pull.labelsFingerprint ||
    !hasSameValidatedPullUpdate(eventPull, pull)
  ) {
    return false;
  }
  const eventAt = githubTimestampMilliseconds(
    eventPull.updatedAt,
    "pull request event updated_at",
  );
  return (
    isWithinOpeningRaceWindow(transition.transitionAt, eventAt) &&
    eventAt < transition.lineageCreatedAt
  );
}

async function publishQualityTransitionMarker({
  github,
  owner,
  repo,
  pull,
  action,
  transitionAt,
  binding,
  targetUrl,
}) {
  const description = qualityTransitionDescription(
    pull,
    action,
    transitionAt,
    binding,
  );
  for (const target of statusTargets(pull)) {
    await publishStatus(
      github,
      owner,
      repo,
      target,
      qualityTransitionContext(pull),
      "pending",
      description,
      targetUrl,
    );
  }
}

async function shouldCreateQualityTransition({
  github,
  owner,
  repo,
  pull,
  action,
  timestamp,
  serverUrl,
  hasOpeningSnapshotMismatch,
}) {
  const transitionAt = transitionTimestampMilliseconds(timestamp);
  const transition = await getQualityTransition({
    github,
    owner,
    repo,
    pull,
    serverUrl,
  });
  if (!transition) {
    return (
      !hasOpeningSnapshotMismatch ||
      isWithinOpeningRaceWindow(
        transitionAt,
        githubTimestampMilliseconds(
          pull.updatedAt,
          "current pull request updated_at",
        ),
      )
    );
  }
  return action !== "opened" && transition.transitionAt < transitionAt;
}

async function bindPendingQualityTransition({
  github,
  owner,
  repo,
  pull,
  candidateRun,
  serverUrl,
  eventAction,
  eventLabelName,
  eventPull,
  workflowAuthorizations,
  authorizationNow,
  fallbackUrl,
}) {
  if (candidateRun) {
    assertQualityWorkflowRunCandidate({
      run: candidateRun,
      owner,
      repo,
      serverUrl,
    });
  }
  let transition = await getQualityTransition({
    github,
    owner,
    repo,
    pull,
    serverUrl,
  });
  if (!transition || transition.version !== 3 || transition.stale) {
    return false;
  }
  if (eventAction === "opened") {
    if (
      transition.action === "opened" &&
      (transition.unconfirmed ||
        !transitionMatchesPullIdentity(transition, pull)) &&
      isOpeningCliLabelRace(pull, eventPull) &&
      transition.transitionAt ===
        githubTimestampMilliseconds(
          eventPull.updatedAt,
          "opened pull request updated_at",
        ) &&
      !isBoundedOpeningCliLabelRace(pull, eventPull)
    ) {
      await publishQualityTransitionMarker({
        github,
        owner,
        repo,
        pull,
        action: transition.action,
        transitionAt: transition.transitionAt,
        binding: QUALITY_TRANSITION_STALE,
        targetUrl: transition.targetUrl,
      });
    }
    return false;
  }
  const labelRefresh =
    eventAction === "labeled" || eventAction === "unlabeled";
  if (
    labelRefresh &&
    transitionTimestampMilliseconds(eventPull.updatedAt) <
      transition.transitionAt
  ) {
    return false;
  }
  const openingLabelReconciliation =
    canReconcileOpeningLabelLineage({
      transition,
      pull,
      eventAction,
      eventLabelName,
      eventPull,
    });
  const directOpeningLabelEvidence =
    hasDirectOpeningLabelEvidence({
      transition,
      pull,
      eventAction,
      eventLabelName,
      eventPull,
    });
  let confirmedDirectOpeningLabel = false;
  if (transition.unconfirmed) {
    if (!directOpeningLabelEvidence) {
      if (labelRefresh) {
        await publishQualityTransitionMarker({
          github,
          owner,
          repo,
          pull,
          action: transition.action,
          transitionAt: transition.transitionAt,
          binding: QUALITY_TRANSITION_STALE,
          targetUrl: transition.targetUrl,
        });
      }
      return false;
    }
    confirmedDirectOpeningLabel = true;
    await publishQualityTransitionMarker({
      github,
      owner,
      repo,
      pull,
      action: transition.action,
      transitionAt: transition.transitionAt,
      binding: null,
      targetUrl: transition.targetUrl,
    });
    transition = {
      ...transition,
      runId: null,
      unconfirmed: false,
    };
  }
  const labelEventProvesDrift =
    labelRefresh &&
    !openingLabelReconciliation &&
    !directOpeningLabelEvidence;
  if (labelEventProvesDrift) {
    await publishQualityTransitionMarker({
      github,
      owner,
      repo,
      pull,
      action: transition.action,
      transitionAt: transition.transitionAt,
      binding: QUALITY_TRANSITION_STALE,
      targetUrl: transition.targetUrl,
    });
    return false;
  }
  if (
    isOpeningLabelLineage(transition, pull) &&
    !openingLabelReconciliation
  ) {
    return false;
  }
  if (!transitionMatchesPullIdentity(transition, pull)) {
    if (openingLabelReconciliation) {
      await publishQualityTransitionMarker({
        github,
        owner,
        repo,
        pull,
        action: transition.action,
        transitionAt: transition.transitionAt,
        binding: transition.runId,
        targetUrl: transition.targetUrl,
      });
      transition = {
        ...transition,
        contentFingerprint: pull.contentFingerprint,
        labelsFingerprint: pull.labelsFingerprint,
        unconfirmed: false,
      };
    } else {
      await publishQualityTransitionMarker({
        github,
        owner,
        repo,
        pull,
        action: transition.action,
        transitionAt: transition.transitionAt,
        binding: QUALITY_TRANSITION_STALE,
        targetUrl: transition.targetUrl,
      });
      return false;
    }
  }
  if (
    directOpeningLabelEvidence &&
    !confirmedDirectOpeningLabel &&
    !openingLabelReconciliation
  ) {
    return false;
  }
  if (transition.runId !== null) {
    return false;
  }

  const trust = await resolveQualityWorkflowTrust({
    github,
    owner,
    repo,
    pull,
    workflowAuthorizations,
    authorizationNow,
    fallbackUrl,
  });
  if (trust.failure) {
    return false;
  }
  const minimumCreatedAt = qualityRunSelectionCutoff(
    transition.transitionAt,
    trust.authorization,
  );
  const runs = await listQualityWorkflowRuns(
    github,
    owner,
    repo,
    trust.workflowId,
    pull.headSha,
    serverUrl,
  );
  if (
    candidateRun &&
    !matchingWorkflowRunCandidate({
      candidateRun,
      runs,
      owner,
      repo,
      serverUrl,
    })
  ) {
    return false;
  }
  const run = selectQualityTransitionRun(
    runs,
    pull,
    trust.workflowId,
    minimumCreatedAt,
  );
  if (!run) {
    return false;
  }

  await publishQualityTransitionMarker({
    github,
    owner,
    repo,
    pull,
    action: transition.action,
    transitionAt: transition.transitionAt,
    binding: run.id,
    targetUrl: transition.targetUrl,
  });
  return true;
}

async function qualityDecision({
  github,
  owner,
  repo,
  pull,
  candidateRun,
  fallbackUrl,
  workflowAuthorizations,
  authorizationNow,
  requireFreshRun,
  serverUrl,
}) {
  if (candidateRun) {
    try {
      assertQualityWorkflowRunCandidate({
        run: candidateRun,
        owner,
        repo,
        serverUrl,
      });
    } catch (error) {
      return {
        state: "failure",
        description: `PR #${pull.number} workflow completion is invalid`,
        targetUrl: fallbackUrl,
        reason: error.message,
      };
    }
  }
  const trust = await resolveQualityWorkflowTrust({
    github,
    owner,
    repo,
    pull,
    workflowAuthorizations,
    authorizationNow,
    fallbackUrl,
  });
  if (trust.failure) {
    return trust.failure;
  }
  const { workflowId, authorization } = trust;

  if (requireFreshRun) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits this transition's quality gates`,
      targetUrl: fallbackUrl,
      reason: "workflow-producing pull request transition awaits its exact run",
      authorization,
    };
  }

  let transition;
  try {
    transition = await getQualityTransition({
      github,
      owner,
      repo,
      pull,
      serverUrl,
    });
  } catch (error) {
    return {
      state: "failure",
      description: `PR #${pull.number} quality transition is invalid`,
      targetUrl: fallbackUrl,
      reason: error.message,
    };
  }
  if (!transition) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits a trusted quality transition`,
      targetUrl: fallbackUrl,
      reason: "no workflow-producing pull request transition is recorded",
    };
  }
  if (transition.version !== 3) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits a current quality transition`,
      targetUrl: fallbackUrl,
      reason: "legacy quality transition markers cannot produce new success",
    };
  }
  if (transition.stale) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits a new quality transition`,
      targetUrl: fallbackUrl,
      reason: "the current quality transition lineage is permanently stale",
    };
  }
  if (transition.unconfirmed) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits opening label confirmation`,
      targetUrl: fallbackUrl,
      reason: "the opening quality transition has no durable label proof",
    };
  }
  if (transition.contentFingerprint !== pull.contentFingerprint) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits its current content transition`,
      targetUrl: fallbackUrl,
      reason: "the quality transition marker predates current PR content",
    };
  }
  if (transition.labelsFingerprint !== pull.labelsFingerprint) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits its current label transition`,
      targetUrl: fallbackUrl,
      reason: "the quality transition marker predates current PR labels",
    };
  }
  if (transition.runId === null) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits transition run registration`,
      targetUrl: fallbackUrl,
      reason: "the workflow-producing transition has no bound quality run yet",
    };
  }
  if (candidateRun && candidateRun.id !== transition.runId) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits its transition-bound completion`,
      targetUrl: candidateRun.html_url || fallbackUrl,
      reason: "workflow completion does not match the transition-bound run",
    };
  }

  let candidates;
  try {
    candidates = await listQualityWorkflowRuns(
      github,
      owner,
      repo,
      workflowId,
      pull.headSha,
      serverUrl,
    );
  } catch (error) {
    return {
      state: "failure",
      description: `PR #${pull.number} quality run inventory is invalid`,
      targetUrl: fallbackUrl,
      reason: error.message,
    };
  }
  if (candidateRun) {
    let listedCandidate;
    try {
      listedCandidate = matchingWorkflowRunCandidate({
        candidateRun,
        runs: candidates,
        owner,
        repo,
        serverUrl,
      });
    } catch (error) {
      return {
        state: "failure",
        description: `PR #${pull.number} workflow completion is invalid`,
        targetUrl: fallbackUrl,
        reason: error.message,
      };
    }
    if (!listedCandidate) {
      return {
        state: "pending",
        description: `PR #${pull.number} awaits its exact quality completion`,
        targetUrl: fallbackUrl,
        reason:
          "workflow completion disagrees with trusted run inventory",
      };
    }
  }
  const matchingRuns = candidates.filter((run) =>
    runMatchesPull(run, pull, workflowId),
  );
  const latestMatchingRun =
    matchingRuns.reduce(
      (latest, candidate) =>
        !latest || candidate.id > latest.id ? candidate : latest,
      null,
    );
  if (
    latestMatchingRun &&
    latestMatchingRun.id !== transition.runId
  ) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits its latest quality transition`,
      targetUrl: latestMatchingRun.html_url || fallbackUrl,
      reason:
        "a newer exact quality run exists than the recorded transition",
    };
  }
  const run = matchingRuns.find(
    (candidate) => candidate.id === transition.runId,
  );
  if (!run) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits exact-snapshot quality gates`,
      targetUrl: fallbackUrl,
      reason: "the recorded transition's exact quality run is unavailable",
    };
  }
  const runCreatedAt = Date.parse(run.created_at);
  if (
    !Number.isFinite(runCreatedAt) ||
    runCreatedAt <= transition.transitionAt
  ) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits its transition-bound quality run`,
      targetUrl: fallbackUrl,
      reason: "recorded quality run does not postdate its transition",
    };
  }
  if (authorization) {
    const authorizationIssuedAt = Date.parse(authorization.issuedAt);
    if (runCreatedAt <= authorizationIssuedAt) {
      return {
        state: "pending",
        description: `PR #${pull.number} awaits post-authorization quality gates`,
        targetUrl: fallbackUrl,
        reason: "matching quality workflow run predates its authorization",
      };
    }
    if (!candidateRun || candidateRun.id !== run.id) {
      return {
        state: "pending",
        description: `PR #${pull.number} awaits its exact quality completion event`,
        targetUrl: run.html_url || fallbackUrl,
        reason:
          "workflow authorization may be consumed only by the selected run's workflow_run",
      };
    }
  }
  if (run.status !== "completed") {
    return {
      state: "pending",
      description: `PR #${pull.number} quality gates are ${run.status}`,
      targetUrl: run.html_url,
      reason: `quality workflow status is ${run.status}`,
    };
  }
  if (run.conclusion !== "success") {
    return {
      state: "failure",
      description: `PR #${pull.number} quality workflow did not succeed`,
      targetUrl: run.html_url,
      reason: `quality workflow conclusion is ${run.conclusion}`,
    };
  }

  const jobsResponse = await github.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  const aggregate = jobsResponse.data.jobs.find(
    (job) => job.name === QUALITY_JOB,
  );
  if (
    !aggregate ||
    aggregate.status !== "completed" ||
    aggregate.conclusion !== "success"
  ) {
    return {
      state: "failure",
      description: `PR #${pull.number} trusted aggregate gate did not succeed`,
      targetUrl: run.html_url,
      reason: "trusted aggregate quality job is missing or unsuccessful",
    };
  }

  return {
    state: "success",
    description: `PR #${pull.number} exact trusted quality gates passed`,
    targetUrl: run.html_url,
    reason:
      "exact trusted quality workflow and aggregate job succeeded" +
      (authorization ? ` authorization=${authorization.id}` : ""),
    authorization,
  };
}

async function publishStatus(
  github,
  owner,
  repo,
  sha,
  context,
  state,
  description,
  targetUrl,
) {
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    context,
    state,
    description,
    target_url: targetUrl,
  });
}

function statusTargets(pull) {
  return pull.baseRef === "master"
    ? [pull.headSha, pull.mergeSha]
    : [pull.mergeSha];
}

async function assertCurrentPullSnapshot(github, owner, repo, pull) {
  const current = await getCurrentPull(
    github,
    owner,
    repo,
    pull.number,
    pull,
  );
  if (current.mergeSha !== pull.mergeSha) {
    throw new Error(`Pull request #${pull.number} merge snapshot changed`);
  }
}

async function invalidatePublishedSnapshot({
  github,
  owner,
  repo,
  pull,
  targetUrl,
}) {
  const contexts = [
    `${BRANCH_CONTEXT_PREFIX}/${pull.baseRef}`,
    `${QUALITY_CONTEXT_PREFIX}/${pull.baseRef}`,
  ];
  for (const target of statusTargets(pull)) {
    for (const statusContext of contexts) {
      await publishStatus(
        github,
        owner,
        repo,
        target,
        statusContext,
        "pending",
        `PR #${pull.number} changed during trusted policy publication`,
        targetUrl,
      );
    }
  }
}

function eventPullIdentity(eventPull) {
  return pullIdentity(eventPull);
}

module.exports = async function publishPrPolicy({
  github,
  context,
  core,
  workflowAuthorizations = TRUSTED_WORKFLOW_BLOB_AUTHORIZATIONS,
  authorizationNow = new Date(),
}) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  const policyRunUrl =
    `${context.serverUrl}/${repository}/actions/runs/${context.runId}`;

  let work;
  if (context.eventName === "pull_request_target") {
    const action = context.payload.action;
    if (!SUPPORTED_PULL_REQUEST_TARGET_ACTIONS.has(action)) {
      throw new Error(`Unsupported pull_request_target action: ${action}`);
    }
    const eventLabelName =
      action === "labeled" || action === "unlabeled"
        ? context.payload.label?.name
        : null;
    if (
      (action === "labeled" || action === "unlabeled") &&
      (typeof eventLabelName !== "string" || eventLabelName.length === 0)
    ) {
      throw new Error(`${action} requires a valid label name`);
    }
    const eventPull = eventPullIdentity(context.payload.pull_request);
    work = [
      {
        number: context.payload.pull_request.number,
        expected: eventPull,
        eventPull,
        candidateRun: null,
        eventAction: action,
        eventLabelName,
        allowLabelRefreshReconciliation:
          action === "labeled" || action === "unlabeled",
        allowOpeningLabelSnapshotMismatch: action === "opened",
        requireFreshRun: QUALITY_TRIGGER_ACTIONS.has(action),
        transitionAction: QUALITY_TRIGGER_ACTIONS.has(action)
          ? action
          : null,
        transitionTimestamp: QUALITY_TRIGGER_ACTIONS.has(action)
          ? context.payload.pull_request.updated_at
          : null,
      },
    ];
  } else if (context.eventName === "workflow_run") {
    const workflowRun = context.payload.workflow_run;
    assertQualityWorkflowRunCandidate({
      run: workflowRun,
      owner,
      repo,
      serverUrl: context.serverUrl,
    });
    const relations = workflowRun.pull_requests;
    work = relations.map((relation) => ({
      number: relation.number,
      expected: {
        number: relation.number,
        headSha: relation.head.sha,
        baseSha: relation.base.sha,
      },
      candidateRun: workflowRun,
      eventPull: null,
      eventAction: null,
      eventLabelName: null,
      allowLabelRefreshReconciliation: false,
      allowOpeningLabelSnapshotMismatch: false,
      requireFreshRun: false,
      transitionAction: null,
      transitionTimestamp: null,
    }));
  } else if (context.eventName === "workflow_dispatch") {
    const number = Number(context.payload.inputs?.pr_number);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error("workflow_dispatch requires a valid pr_number");
    }
    work = [
      {
        number,
        expected: { number },
        eventPull: null,
        candidateRun: null,
        eventAction: null,
        eventLabelName: null,
        allowLabelRefreshReconciliation: false,
        allowOpeningLabelSnapshotMismatch: false,
        requireFreshRun: false,
        transitionAction: null,
        transitionTimestamp: null,
      },
    ];
  } else {
    throw new Error(`Unsupported event: ${context.eventName}`);
  }

  let failed = false;
  for (const item of work) {
    const pull = await getCurrentPull(
      github,
      owner,
      repo,
      item.number,
      item.expected,
      {
        allowLabelRefreshReconciliation:
          item.allowLabelRefreshReconciliation,
        allowOpeningLabelSnapshotMismatch:
          item.allowOpeningLabelSnapshotMismatch,
      },
    );
    const branch = branchDecision(pull, repository);
    const branchContext = `${BRANCH_CONTEXT_PREFIX}/${pull.baseRef}`;
    const qualityContext = `${QUALITY_CONTEXT_PREFIX}/${pull.baseRef}`;
    const targets = statusTargets(pull);
    let transitionBindingError = null;
    let createTransition = Boolean(item.transitionAction);
    const hasOpeningSnapshotMismatch =
      item.allowOpeningLabelSnapshotMismatch &&
      isOpeningCliLabelRace(pull, item.expected);
    const hasBoundedOpeningSnapshotMismatch =
      item.allowOpeningLabelSnapshotMismatch &&
      isBoundedOpeningCliLabelRace(pull, item.expected);
    if (branch.allowed && item.transitionAction) {
      try {
        createTransition = await shouldCreateQualityTransition({
          github,
          owner,
          repo,
          pull,
          action: item.transitionAction,
          timestamp: item.transitionTimestamp,
          serverUrl: context.serverUrl,
          hasOpeningSnapshotMismatch,
        });
      } catch (error) {
        transitionBindingError = error;
        createTransition = false;
      }
    }
    if (
      branch.allowed &&
      !transitionBindingError &&
      (!item.transitionAction || !createTransition)
    ) {
      try {
        await bindPendingQualityTransition({
          github,
          owner,
          repo,
          pull,
          candidateRun: item.candidateRun,
          serverUrl: context.serverUrl,
          eventAction: item.eventAction,
          eventLabelName: item.eventLabelName,
          eventPull: item.eventPull,
          workflowAuthorizations,
          authorizationNow,
          fallbackUrl: policyRunUrl,
        });
      } catch (error) {
        transitionBindingError = error;
      }
    }
    let quality = await qualityDecision({
      github,
      owner,
      repo,
      pull,
      candidateRun: item.candidateRun,
      fallbackUrl: policyRunUrl,
      workflowAuthorizations,
      authorizationNow,
      requireFreshRun: item.requireFreshRun && createTransition,
      serverUrl: context.serverUrl,
    });
    if (transitionBindingError) {
      quality = {
        state: "failure",
        description: `PR #${pull.number} cannot bind its quality transition`,
        targetUrl: policyRunUrl,
        reason: transitionBindingError.message,
      };
    }
    if (!branch.allowed) {
      quality.state = "failure";
      quality.description =
        `PR #${pull.number} source branch is not eligible for quality success`;
      quality.targetUrl = policyRunUrl;
      quality.reason = "quality success requires an allowed branch";
    }
    let qualityPrepublished = false;
    if (
      branch.allowed &&
      item.transitionAction &&
      createTransition &&
      quality.state === "pending"
    ) {
      for (const target of targets) {
        await publishStatus(
          github,
          owner,
          repo,
          target,
          qualityContext,
          "pending",
          quality.description,
          policyRunUrl,
        );
      }
      qualityPrepublished = true;
      await publishQualityTransitionMarker({
        github,
        owner,
        repo,
        pull,
        action: item.transitionAction,
        transitionAt: item.transitionTimestamp,
        binding: hasBoundedOpeningSnapshotMismatch
          ? QUALITY_TRANSITION_UNCONFIRMED
          : null,
        targetUrl: policyRunUrl,
      });
      if (!hasBoundedOpeningSnapshotMismatch) {
        try {
          const transitionRun = await findQualityTransitionRun({
            github,
            owner,
            repo,
            pull,
            timestamp: item.transitionTimestamp,
            serverUrl: context.serverUrl,
            authorization: quality.authorization,
          });
          if (transitionRun) {
            await publishQualityTransitionMarker({
              github,
              owner,
              repo,
              pull,
              action: item.transitionAction,
              transitionAt: item.transitionTimestamp,
              binding: transitionRun.id,
              targetUrl: policyRunUrl,
            });
          }
        } catch (error) {
          quality = {
            state: "failure",
            description: `PR #${pull.number} cannot register its quality run`,
            targetUrl: policyRunUrl,
            reason: error.message,
          };
        }
      }
    }
    try {
      await assertCurrentPullSnapshot(github, owner, repo, pull);
    } catch (error) {
      await invalidatePublishedSnapshot({
        github,
        owner,
        repo,
        pull,
        targetUrl: policyRunUrl,
      });
      throw error;
    }
    if (
      quality.state === "success" &&
      quality.authorization &&
      context.eventName !== "workflow_run"
    ) {
      quality.state = "pending";
      quality.description =
        `PR #${pull.number} awaits its exact quality completion event`;
      quality.targetUrl = policyRunUrl;
      quality.reason =
        "workflow authorization may be consumed only by its exact workflow_run";
    }
    if (quality.state === "success" && quality.authorization) {
      try {
        await claimWorkflowAuthorization({
          github,
          owner,
          repo,
          authorization: quality.authorization,
          pull,
          targetUrl: policyRunUrl,
        });
      } catch (error) {
        quality.state = "failure";
        quality.description =
          `PR #${pull.number} could not consume workflow authorization`;
        quality.targetUrl = policyRunUrl;
        quality.reason = error.message;
      }
    }

    if (context.eventName !== "workflow_run") {
      for (const target of targets) {
        await publishStatus(
          github,
          owner,
          repo,
          target,
          branchContext,
          branch.allowed ? "success" : "failure",
          `PR #${pull.number}: ${branch.description}`,
          policyRunUrl,
        );
      }
    }
    if (!qualityPrepublished || quality.state !== "pending") {
      for (const target of targets) {
        await publishStatus(
          github,
          owner,
          repo,
          target,
          qualityContext,
          quality.state,
          quality.description,
          quality.targetUrl,
        );
      }
    }

    try {
      await assertCurrentPullSnapshot(github, owner, repo, pull);
    } catch (error) {
      await invalidatePublishedSnapshot({
        github,
        owner,
        repo,
        pull,
        targetUrl: policyRunUrl,
      });
      throw error;
    }

    core.info(
      `pr=${pull.number} merge_sha=${pull.mergeSha} ` +
        `branch=${branch.allowed ? "success" : "failure"} ` +
        `branch_published=${context.eventName !== "workflow_run"} ` +
        `quality=${quality.state} reason=${quality.reason}`,
    );
    failed ||= !branch.allowed || quality.state === "failure";
  }

  if (failed) {
    core.setFailed("Current pull request snapshot did not satisfy every gate");
  }
};

module.exports.branchDecision = branchDecision;
module.exports.claimWorkflowAuthorization = claimWorkflowAuthorization;
module.exports.findWorkflowAuthorization = findWorkflowAuthorization;
module.exports.findQualityTransitionRun = findQualityTransitionRun;
module.exports.labelsFingerprint = labelsFingerprint;
module.exports.listQualityWorkflowRuns = listQualityWorkflowRuns;
module.exports.pullIdentity = pullIdentity;
module.exports.qualityTransitionDescription = qualityTransitionDescription;
module.exports.runMatchesPull = runMatchesPull;
module.exports.trustedWorkflowBlobAuthorizations =
  TRUSTED_WORKFLOW_BLOB_AUTHORIZATIONS;
