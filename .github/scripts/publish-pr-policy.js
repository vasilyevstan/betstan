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
const QUALITY_TRIGGER_ACTIONS = new Set([
  "edited",
  "opened",
  "reopened",
  "synchronize",
]);
const MAX_WORKFLOW_AUTHORIZATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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

function pullIdentity(pull) {
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
    contentFingerprint: crypto
      .createHash("sha256")
      .update(`${pull.title || ""}\0${pull.body || ""}`)
      .digest("hex")
      .slice(0, 32),
  };
}

function assertExpectedPull(actual, expected) {
  for (const key of [
    "number",
    "headRef",
    "headSha",
    "headRepository",
    "baseRef",
    "baseSha",
    "updatedAt",
    "contentFingerprint",
  ]) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) {
      throw new Error(
        `Pull request changed during policy evaluation: ${key} ` +
          `expected=${expected[key]} actual=${actual[key]}`,
      );
    }
  }
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

function qualityTransitionDescription(pull, action, timestamp, runId) {
  return (
    `PR #${pull.number} ${action} ${timestamp} run ` +
    `${runId === null ? "pending" : runId} ` +
    `content ${pull.contentFingerprint}`
  );
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
      !marker.target_url.startsWith(expectedRunUrlPrefix)
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
    const escapedNumber = String(pull.number).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const match = marker.description.match(
      new RegExp(
        `^PR #${escapedNumber} ` +
          `(edited|opened|reopened|synchronize) ` +
          `(\\S+) run (pending|[1-9][0-9]*) ` +
          `content ([0-9a-f]{32})$`,
      ),
    );
    if (!match) {
      throw new Error(
        "quality transition marker does not match the pull request",
      );
    }
    const transitionAt = Date.parse(match[2]);
    const runId = match[3] === "pending" ? null : Number(match[3]);
    if (
      !QUALITY_TRIGGER_ACTIONS.has(match[1]) ||
      !Number.isFinite(transitionAt) ||
      !(runId === null || Number.isSafeInteger(runId))
    ) {
      throw new Error("quality transition marker is malformed");
    }
    return {
      action: match[1],
      timestamp: match[2],
      transitionAt,
      runId,
      contentFingerprint: match[4],
      policyRunId,
      targetUrl: marker.target_url,
      statusId: marker.id,
    };
  });
  const transition = parsed.sort(
    (left, right) =>
      right.transitionAt - left.transitionAt ||
      right.statusId - left.statusId,
  )[0];
  const [workflowResponse, runResponse] = await Promise.all([
    github.rest.actions.getWorkflow({
      owner,
      repo,
      workflow_id: BRANCH_WORKFLOW,
    }),
    github.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: transition.policyRunId,
    }),
  ]);
  const policyRun = runResponse.data;
  const relations = policyRun.pull_requests || [];
  const relation = relations[0];
  if (
    policyRun.id !== transition.policyRunId ||
    policyRun.workflow_id !== workflowResponse.data.id ||
    policyRun.path !== BRANCH_WORKFLOW_PATH ||
    policyRun.event !== "pull_request_target" ||
    policyRun.repository?.full_name !== `${owner}/${repo}` ||
    policyRun.html_url !== transition.targetUrl ||
    relations.length !== 1 ||
    relation.number !== pull.number ||
    relation.head?.sha !== pull.headSha ||
    relation.base?.sha !== pull.baseSha
  ) {
    throw new Error(
      "quality transition marker does not originate from branch-policy",
    );
  }
  return transition;
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

async function getCurrentPull(github, owner, repo, number, expected) {
  let current;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    current = pullIdentity(response.data);
    assertExpectedPull(current, expected);

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
        (run) =>
          !run ||
          typeof run !== "object" ||
          !Number.isInteger(run.id) ||
          run.id < 1,
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

async function findQualityTransitionRun({
  github,
  owner,
  repo,
  pull,
  timestamp,
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
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const runs = await listQualityWorkflowRuns(
      github,
      owner,
      repo,
      workflowId,
      pull.headSha,
    );
    const candidate = selectQualityTransitionRun(
      runs,
      pull,
      workflowId,
      transitionAt,
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

function selectQualityTransitionRun(runs, pull, workflowId, transitionAt) {
  return (
    runs
      .filter((run) => runMatchesPull(run, pull, workflowId))
      .filter((run) => {
        const createdAt = Date.parse(run.created_at);
        return Number.isFinite(createdAt) && createdAt > transitionAt;
      })
      .sort((left, right) => right.id - left.id)[0] || null
  );
}

async function bindPendingQualityTransition({
  github,
  owner,
  repo,
  pull,
  candidateRun,
  serverUrl,
}) {
  const transition = await getQualityTransition({
    github,
    owner,
    repo,
    pull,
    serverUrl,
  });
  if (
    !transition ||
    transition.runId !== null ||
    transition.contentFingerprint !== pull.contentFingerprint
  ) {
    return false;
  }

  const workflowResponse = await github.rest.actions.getWorkflow({
    owner,
    repo,
    workflow_id: QUALITY_WORKFLOW,
  });
  const workflowId = workflowResponse.data.id;
  const runs = await listQualityWorkflowRuns(
    github,
    owner,
    repo,
    workflowId,
    pull.headSha,
  );
  if (candidateRun && !runs.some((run) => run.id === candidateRun.id)) {
    runs.push(candidateRun);
  }
  const run = selectQualityTransitionRun(
    runs,
    pull,
    workflowId,
    transition.transitionAt,
  );
  if (!run) {
    return false;
  }

  const description = qualityTransitionDescription(
    pull,
    transition.action,
    transition.timestamp,
    run.id,
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
      transition.targetUrl,
    );
  }
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
      state: "failure",
      description: `PR #${pull.number} cannot verify trusted quality workflow`,
      targetUrl: fallbackUrl,
      reason: error.message,
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
        state: "failure",
        description: `PR #${pull.number} has invalid workflow authorization`,
        targetUrl: fallbackUrl,
        reason: error.message,
      };
    }
    if (!authorization) {
      return {
        state: "failure",
        description: `PR #${pull.number} changes the trusted quality workflow`,
        targetUrl: fallbackUrl,
        reason:
          "quality workflow differs from the current default branch without " +
          "an exact PR-bound authorization",
      };
    }
  }

  if (requireFreshRun) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits this transition's quality gates`,
      targetUrl: fallbackUrl,
      reason: "workflow-producing pull request transition awaits its exact run",
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
  if (transition.runId === null) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits transition run registration`,
      targetUrl: fallbackUrl,
      reason: "the workflow-producing transition has no bound quality run yet",
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
    );
  } catch (error) {
    return {
      state: "failure",
      description: `PR #${pull.number} quality run inventory is invalid`,
      targetUrl: fallbackUrl,
      reason: error.message,
    };
  }
  if (candidateRun && !candidates.some((run) => run.id === candidateRun.id)) {
    candidates.push(candidateRun);
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
    if (
      ![
        "edited",
        "opened",
        "ready_for_review",
        "reopened",
        "synchronize",
      ].includes(action)
    ) {
      throw new Error(`Unsupported pull_request_target action: ${action}`);
    }
    work = [
      {
        number: context.payload.pull_request.number,
        expected: eventPullIdentity(context.payload.pull_request),
        candidateRun: null,
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
    const relations = workflowRun.pull_requests || [];
    if (relations.length !== 1) {
      throw new Error(
        "Completed quality workflow must have exactly one pull request relation",
      );
    }
    work = relations.map((relation) => ({
      number: relation.number,
      expected: {
        number: relation.number,
        headSha: relation.head.sha,
        baseSha: relation.base.sha,
      },
      candidateRun: workflowRun,
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
        candidateRun: null,
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
    );
    const branch = branchDecision(pull, repository);
    const branchContext = `${BRANCH_CONTEXT_PREFIX}/${pull.baseRef}`;
    const qualityContext = `${QUALITY_CONTEXT_PREFIX}/${pull.baseRef}`;
    const targets = statusTargets(pull);
    let transitionBindingError = null;
    if (branch.allowed && !item.transitionAction) {
      try {
        await bindPendingQualityTransition({
          github,
          owner,
          repo,
          pull,
          candidateRun: item.candidateRun,
          serverUrl: context.serverUrl,
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
      requireFreshRun: item.requireFreshRun,
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
      const transitionContext = qualityTransitionContext(pull);
      const transitionBarrier = qualityTransitionDescription(
        pull,
        item.transitionAction,
        item.transitionTimestamp,
        null,
      );
      for (const target of targets) {
        await publishStatus(
          github,
          owner,
          repo,
          target,
          transitionContext,
          "pending",
          transitionBarrier,
          policyRunUrl,
        );
      }
      try {
        const transitionRun = await findQualityTransitionRun({
          github,
          owner,
          repo,
          pull,
          timestamp: item.transitionTimestamp,
        });
        if (transitionRun) {
          const transitionDescription = qualityTransitionDescription(
            pull,
            item.transitionAction,
            item.transitionTimestamp,
            transitionRun.id,
          );
          for (const target of targets) {
            await publishStatus(
              github,
              owner,
              repo,
              target,
              transitionContext,
              "pending",
              transitionDescription,
              policyRunUrl,
            );
          }
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
module.exports.listQualityWorkflowRuns = listQualityWorkflowRuns;
module.exports.runMatchesPull = runMatchesPull;
module.exports.trustedWorkflowBlobAuthorizations =
  TRUSTED_WORKFLOW_BLOB_AUTHORIZATIONS;
