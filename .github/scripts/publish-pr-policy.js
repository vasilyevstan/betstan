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
const COVERAGE_ENGINE_PATH = ".github/scripts/test-coverage-matrix.js";
const COVERAGE_HARNESS_PATH =
  ".github/scripts/test-test-coverage-matrix.js";
const COVERAGE_REVIEW_PATH =
  "infra/azure/agents/coverage-engine-review-stan.sh";
const COVERAGE_INVOCATION_PATH =
  "infra/azure/agents/test-deployment-safety-ci-stan.sh";
const COVERAGE_AUTHORIZED_PATHS = Object.freeze([
  COVERAGE_ENGINE_PATH,
  COVERAGE_HARNESS_PATH,
  "LEARNINGS.md",
  "docs/wiki/Engineering-Learnings.md",
]);
const COVERAGE_EXPECTED_TEST_COUNT = 102;
const COVERAGE_AUTHORIZATION_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const COVERAGE_INTEGRATION_CONTEXT_PREFIX =
  "trusted-coverage-integration";
const COVERAGE_PROMOTION_CONTEXT_PREFIX =
  "trusted-coverage-promotion";
const COVERAGE_RESTRICTED_PATH_PREFIXES = Object.freeze([
  ".github/coverage/",
  ".github/scripts/",
  ".github/workflows/",
  "infra/azure/agents/",
]);
const COVERAGE_RECEIPT_VERSION = "v1";
const COVERAGE_RECEIPT_FINGERPRINT_LENGTH = 40;
const GITHUB_ACTIONS_BOT = Object.freeze({
  id: 41898282,
  login: "github-actions[bot]",
  type: "Bot",
});
const CLI_MANAGED_LABEL = "copilot-cli-managed";
const INFORMATIONAL_CONTEXT_LABEL_PATTERN =
  /^(?:feature|session):[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;
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
const MANAGED_LABEL_LEDGER_PAGE_SIZE = 100;
const MANAGED_LABEL_LEDGER_MAX_PAGES = 10;
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
const WORKFLOW_JOB_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
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
const COVERAGE_AUTHORIZATION_FIELDS = [
  "adoptionSha",
  "allowedPaths",
  "authorizedEngineBlob",
  "authorizedHarnessBlob",
  "baseRef",
  "baseSha",
  "enginePath",
  "expectedTests",
  "expiresAt",
  "harnessPath",
  "headRef",
  "headRepository",
  "headSha",
  "id",
  "issuedAt",
  "pullNumber",
  "receiptSha",
  "repository",
  "trustedEngineBlob",
  "trustedHarnessBlob",
];

// Exact workflow authorizations are added only in a separately promoted,
// short-lived policy change and removed immediately after their intended PR.
const TRUSTED_WORKFLOW_BLOB_AUTHORIZATIONS = Object.freeze([]);
const TRUSTED_COVERAGE_ASSET_AUTHORIZATIONS_JSON = String.raw`[]`;
const TRUSTED_COVERAGE_ASSET_AUTHORIZATIONS = Object.freeze(
  JSON.parse(TRUSTED_COVERAGE_ASSET_AUTHORIZATIONS_JSON),
);

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
  return fingerprint(JSON.stringify(policyLabels(labels)));
}

function policyLabels(labels) {
  if (
    !Array.isArray(labels) ||
    labels.some((label) => typeof label !== "string")
  ) {
    throw new Error("Pull request label names are malformed");
  }
  return labels.filter(
    (label) => !INFORMATIONAL_CONTEXT_LABEL_PATTERN.test(label),
  );
}

function hasOnlyCliManagedPolicyLabel(labels) {
  if (!Array.isArray(labels)) {
    return false;
  }
  const names = policyLabels(labels);
  return names.length === 1 && names[0] === CLI_MANAGED_LABEL;
}

const EMPTY_LABELS_FINGERPRINT = labelsFingerprint([]);
const CLI_MANAGED_LABELS_FINGERPRINT = labelsFingerprint([
  CLI_MANAGED_LABEL,
]);

function pullIdentity(pull) {
  const labels = canonicalLabels(pull.labels);
  githubTimestampMilliseconds(
    pull.updated_at,
    "pull request updated_at",
  );
  return {
    number: pull.number,
    state: pull.state,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    headRepository: pull.head.repo?.full_name || "",
    baseRef: pull.base.ref,
    baseSha: pull.base.sha,
    mergeSha: pull.merge_commit_sha || "",
    changedFiles: pull.changed_files,
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
    "changedFiles",
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
  const expectedPolicyLabels = policyLabels(expected.labels);
  const actualPolicyLabels = policyLabels(actual.labels);
  if (
    expectedPolicyLabels.length !== 0 ||
    actualPolicyLabels.length !== 1 ||
    actualPolicyLabels[0] !== CLI_MANAGED_LABEL
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
  const actualUpdatedAt = githubTimestampMilliseconds(
    actual.updatedAt,
    "current pull request updated_at",
  );
  const expectedUpdatedAt = githubTimestampMilliseconds(
    expected.updatedAt,
    "opened pull request updated_at",
  );
  return (
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
  const actualUpdatedAt = githubTimestampMilliseconds(
    actual.updatedAt,
    "current pull request updated_at",
  );
  const expectedUpdatedAt = githubTimestampMilliseconds(
    expected.updatedAt,
    "label event pull request updated_at",
  );
  return (
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

function assertExactCoverageAuthorizationFields(authorization) {
  if (!authorization || typeof authorization !== "object") {
    throw new Error("coverage authorization must be an object");
  }
  const actualFields = Object.keys(authorization).sort();
  if (
    actualFields.length !== COVERAGE_AUTHORIZATION_FIELDS.length ||
    actualFields.some(
      (field, index) => field !== COVERAGE_AUTHORIZATION_FIELDS[index],
    )
  ) {
    throw new Error("coverage authorization has unexpected fields");
  }
}

function assertSafeCoverageString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`coverage authorization ${label} is invalid`);
  }
}

function parseCoverageAuthorizationTime(value, label) {
  if (typeof value !== "string") {
    throw new Error(`coverage authorization ${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`coverage authorization ${label} is invalid`);
  }
  return milliseconds;
}

function validateCoverageAssetAuthorization(
  authorization,
  expectedRepository = null,
) {
  assertExactCoverageAuthorizationFields(authorization);
  assertSafeCoverageString(
    authorization.id,
    "id",
    COVERAGE_AUTHORIZATION_ID_PATTERN,
  );
  for (const field of ["repository", "headRepository"]) {
    assertSafeCoverageString(
      authorization[field],
      field,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    );
  }
  if (authorization.headRepository !== authorization.repository) {
    throw new Error(
      "coverage authorization must use the current repository",
    );
  }
  if (
    expectedRepository !== null &&
    (authorization.repository !== expectedRepository ||
      authorization.headRepository !== expectedRepository)
  ) {
    throw new Error(
      "coverage authorization repository is not the current repository",
    );
  }
  if (authorization.enginePath !== COVERAGE_ENGINE_PATH) {
    throw new Error("coverage authorization enginePath is invalid");
  }
  if (authorization.harnessPath !== COVERAGE_HARNESS_PATH) {
    throw new Error("coverage authorization harnessPath is invalid");
  }
  if (
    !Array.isArray(authorization.allowedPaths) ||
    JSON.stringify(authorization.allowedPaths) !==
      JSON.stringify(COVERAGE_AUTHORIZED_PATHS)
  ) {
    throw new Error("coverage authorization allowedPaths is invalid");
  }
  for (const field of [
    "trustedEngineBlob",
    "authorizedEngineBlob",
    "trustedHarnessBlob",
    "authorizedHarnessBlob",
    "headSha",
    "baseSha",
    "receiptSha",
    "adoptionSha",
  ]) {
    assertSafeCoverageString(
      authorization[field],
      field,
      /^[0-9a-f]{40}$/,
    );
  }
  if (
    authorization.trustedEngineBlob ===
      authorization.authorizedEngineBlob ||
    authorization.trustedHarnessBlob ===
      authorization.authorizedHarnessBlob
  ) {
    throw new Error(
      "coverage authorization must authorize one complete changed pair",
    );
  }
  if (
    !Number.isInteger(authorization.pullNumber) ||
    authorization.pullNumber < 1
  ) {
    throw new Error("coverage authorization pullNumber is invalid");
  }
  if (
    !Number.isInteger(authorization.expectedTests) ||
    authorization.expectedTests !== COVERAGE_EXPECTED_TEST_COUNT
  ) {
    throw new Error("coverage authorization expectedTests is invalid");
  }
  for (const field of ["headRef", "baseRef"]) {
    assertSafeCoverageString(
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
      throw new Error(`coverage authorization ${field} is invalid`);
    }
  }
  if (
    authorization.headRef === "dev" ||
    authorization.headRef === "master" ||
    authorization.baseRef !== "dev"
  ) {
    throw new Error("coverage authorization branch is invalid");
  }

  const issuedAt = parseCoverageAuthorizationTime(
    authorization.issuedAt,
    "issuedAt",
  );
  const expiresAt = parseCoverageAuthorizationTime(
    authorization.expiresAt,
    "expiresAt",
  );
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_WORKFLOW_AUTHORIZATION_AGE_MS
  ) {
    throw new Error("coverage authorization interval is invalid");
  }
}

function validateCoverageAssetAuthorizations(
  authorizations,
  repository,
) {
  if (!Array.isArray(authorizations)) {
    throw new Error("coverage authorizations must be an array");
  }
  const seenIds = new Set();
  for (const authorization of authorizations) {
    validateCoverageAssetAuthorization(authorization, repository);
    if (seenIds.has(authorization.id)) {
      throw new Error(
        `duplicate coverage authorization id ${authorization.id}`,
      );
    }
    seenIds.add(authorization.id);
  }
}

function findCoverageAssetAuthorization({
  authorizations,
  repository,
  trustedEngineBlob,
  authorizedEngineBlob,
  trustedHarnessBlob,
  authorizedHarnessBlob,
  changedPaths,
  pull,
}) {
  validateCoverageAssetAuthorizations(authorizations, repository);
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.some((path) => typeof path !== "string")
  ) {
    throw new Error("coverage changed paths are invalid");
  }

  const matches = authorizations.filter(
    (authorization) =>
      authorization.repository === repository &&
      authorization.headRepository === repository &&
      pull.headRepository === repository &&
      authorization.enginePath === COVERAGE_ENGINE_PATH &&
      authorization.harnessPath === COVERAGE_HARNESS_PATH &&
      authorization.trustedEngineBlob === trustedEngineBlob &&
      authorization.authorizedEngineBlob === authorizedEngineBlob &&
      authorization.trustedHarnessBlob === trustedHarnessBlob &&
      authorization.authorizedHarnessBlob === authorizedHarnessBlob &&
      authorization.pullNumber === pull.number &&
      authorization.headRef === pull.headRef &&
      authorization.headSha === pull.headSha &&
      authorization.baseRef === pull.baseRef &&
      JSON.stringify(authorization.allowedPaths) ===
        JSON.stringify(changedPaths),
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length !== 1) {
    throw new Error(
      "multiple coverage authorizations match one pull request",
    );
  }
  return matches[0];
}

function findCoveragePromotionAuthorization({
  authorizations,
  repository,
  trustedEngineBlob,
  authorizedEngineBlob,
  trustedHarnessBlob,
  authorizedHarnessBlob,
}) {
  validateCoverageAssetAuthorizations(authorizations, repository);
  const matches = authorizations.filter(
    (authorization) =>
      authorization.repository === repository &&
      authorization.headRepository === repository &&
      authorization.trustedEngineBlob === trustedEngineBlob &&
      authorization.authorizedEngineBlob === authorizedEngineBlob &&
      authorization.trustedHarnessBlob === trustedHarnessBlob &&
      authorization.authorizedHarnessBlob === authorizedHarnessBlob,
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length !== 1) {
    throw new Error(
      "multiple coverage authorizations match one promotion",
    );
  }
  return matches[0];
}

function workflowAuthorizationContext(authorization) {
  return `trusted-workflow-authorization/${authorization.id}`;
}

function coverageAuthorizationFingerprint(authorization) {
  validateCoverageAssetAuthorization(authorization);
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        "betstan.coverage.authorization.v1",
        authorization.id,
        authorization.repository,
        authorization.headRepository,
        authorization.pullNumber,
        authorization.headRef,
        authorization.headSha,
        authorization.baseRef,
        authorization.baseSha,
        authorization.enginePath,
        authorization.trustedEngineBlob,
        authorization.authorizedEngineBlob,
        authorization.harnessPath,
        authorization.trustedHarnessBlob,
        authorization.authorizedHarnessBlob,
        authorization.allowedPaths,
        authorization.expectedTests,
        authorization.issuedAt,
        authorization.expiresAt,
        authorization.receiptSha,
        authorization.adoptionSha,
      ]),
    )
    .digest("hex")
    .slice(0, COVERAGE_RECEIPT_FINGERPRINT_LENGTH);
}

function coverageAuthorizationContext(authorization, leg) {
  const prefix =
    leg === "integration"
      ? COVERAGE_INTEGRATION_CONTEXT_PREFIX
      : leg === "promotion"
        ? COVERAGE_PROMOTION_CONTEXT_PREFIX
        : null;
  if (!prefix) {
    throw new Error("coverage authorization receipt leg is invalid");
  }
  const context = `${prefix}/${authorization.id}`;
  if (Buffer.byteLength(context, "utf8") > 100) {
    throw new Error("coverage authorization receipt context is too long");
  }
  return context;
}

async function listCommitStatuses(github, owner, repo, ref) {
  const statuses = [];
  const seenIds = new Set();
  for (let page = 1; Number.isSafeInteger(page); page += 1) {
    const response = await github.rest.repos.listCommitStatusesForRef({
      owner,
      repo,
      ref,
      per_page: 100,
      page,
    });
    if (!Array.isArray(response.data)) {
      throw new Error("authorization receipt response is malformed");
    }
    for (const status of response.data) {
      let validCreatedAt = true;
      try {
        githubTimestampMilliseconds(
          status?.created_at,
          "commit status created_at",
        );
      } catch {
        validCreatedAt = false;
      }
      const creator = status?.creator;
      if (
        !status ||
        typeof status !== "object" ||
        Array.isArray(status) ||
        !Number.isInteger(status.id) ||
        status.id < 1 ||
        typeof status.context !== "string" ||
        status.context.length < 1 ||
        Buffer.byteLength(status.context, "utf8") > 100 ||
        /[\u0000-\u001f\u007f]/.test(status.context) ||
        !["error", "failure", "pending", "success"].includes(status.state) ||
        !(
          status.description === null ||
          (typeof status.description === "string" &&
            Buffer.byteLength(status.description, "utf8") <=
              MAX_STATUS_DESCRIPTION_LENGTH &&
            !/[\u0000-\u001f\u007f]/.test(status.description))
        ) ||
        !(
          status.target_url === null ||
          (typeof status.target_url === "string" &&
            status.target_url.length > 0 &&
            status.target_url.length <= 2048 &&
            !/[\u0000-\u001f\u007f]/.test(status.target_url))
        ) ||
        !validCreatedAt ||
        !creator ||
        typeof creator !== "object" ||
        Array.isArray(creator) ||
        !Number.isSafeInteger(creator.id) ||
        creator.id < 1 ||
        typeof creator.login !== "string" ||
        creator.login.length < 1 ||
        creator.login.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(creator.login) ||
        typeof creator.type !== "string" ||
        creator.type.length < 1 ||
        creator.type.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(creator.type)
      ) {
        throw new Error(
          "commit status entry is malformed",
        );
      }
      if (seenIds.has(status.id)) {
        throw new Error(
          "authorization receipt inventory contains duplicate IDs",
        );
      }
      seenIds.add(status.id);
    }
    statuses.push(...response.data);
    if (response.data.length < 100) {
      return statuses;
    }
  }
  throw new Error("authorization receipt inventory exceeds safe pagination");
}

function isValidPullRequestPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith("/") &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") &&
    !/[\u0000-\u001f\u007f]/.test(path)
  );
}

async function listPullRequestFiles(
  github,
  owner,
  repo,
  pullNumber,
  expectedCount,
) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new Error("pull request changed file count is invalid");
  }
  const files = [];
  const seenPaths = new Set();
  const lastDataPage = Math.max(1, Math.ceil(expectedCount / 100));
  for (let page = 1; page <= lastDataPage + 1; page += 1) {
    const response = await github.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    if (!Array.isArray(response.data) || response.data.length > 100) {
      throw new Error("pull request file inventory is malformed");
    }
    const expectedPageLength =
      page <= lastDataPage
        ? Math.min(100, Math.max(0, expectedCount - files.length))
        : 0;
    if (response.data.length !== expectedPageLength) {
      throw new Error("pull request file inventory is incomplete");
    }
    for (const file of response.data) {
      const filename = file?.filename;
      const hasPrevious = Object.prototype.hasOwnProperty.call(
        file || {},
        "previous_filename",
      );
      const previousFilename = hasPrevious
        ? file.previous_filename
        : null;
      if (
        !file ||
        typeof file !== "object" ||
        !["added", "modified", "removed", "renamed"].includes(
          file.status,
        ) ||
        !isValidPullRequestPath(filename) ||
        (file.status === "renamed"
          ? !hasPrevious || !isValidPullRequestPath(previousFilename)
          : hasPrevious) ||
        seenPaths.has(filename) ||
        (previousFilename !== null && seenPaths.has(previousFilename))
      ) {
        throw new Error("pull request file inventory entry is malformed");
      }
      seenPaths.add(filename);
      if (previousFilename !== null) {
        seenPaths.add(previousFilename);
      }
      files.push({
        filename,
        status: file.status,
        previousFilename,
      });
    }
  }
  if (files.length !== expectedCount) {
    throw new Error("pull request file inventory count changed");
  }
  return files;
}

function assertCoverageSourceFiles(files) {
  if (
    files.length !== COVERAGE_AUTHORIZED_PATHS.length ||
    files.some(
      (file) =>
        file.status !== "modified" || file.previousFilename !== null,
    ) ||
    JSON.stringify(files.map(({ filename }) => filename).sort()) !==
      JSON.stringify([...COVERAGE_AUTHORIZED_PATHS].sort())
  ) {
    throw new Error(
      "coverage authorization requires the exact reviewed source paths",
    );
  }
}

function isCoverageRestrictedPath(path) {
  return COVERAGE_RESTRICTED_PATH_PREFIXES.some((prefix) =>
    path.startsWith(prefix),
  );
}

function assertCoveragePromotionFiles(files) {
  const restrictedPaths = [];
  for (const file of files) {
    const touchedPaths = [
      file.filename,
      ...(file.previousFilename ? [file.previousFilename] : []),
    ];
    if (!touchedPaths.some(isCoverageRestrictedPath)) {
      continue;
    }
    if (
      file.status !== "modified" ||
      file.previousFilename !== null ||
      ![COVERAGE_ENGINE_PATH, COVERAGE_HARNESS_PATH].includes(
        file.filename,
      )
    ) {
      throw new Error(
        "coverage promotion contains an unauthorized restricted path change",
      );
    }
    restrictedPaths.push(file.filename);
  }
  if (
    JSON.stringify(restrictedPaths.sort()) !==
    JSON.stringify([COVERAGE_ENGINE_PATH, COVERAGE_HARNESS_PATH].sort())
  ) {
    throw new Error(
      "coverage promotion must contain the exact authorized restricted pair",
    );
  }
}

async function inspectManagedLabelLedger({
  github,
  owner,
  repo,
  pull,
  transition,
}) {
  const seenIds = new Set();
  let managedLabelAt = null;
  for (let page = 1; page <= MANAGED_LABEL_LEDGER_MAX_PAGES; page += 1) {
    let response;
    try {
      response = await github.rest.issues.listEvents({
        owner,
        repo,
        issue_number: pull.number,
        per_page: MANAGED_LABEL_LEDGER_PAGE_SIZE,
        page,
      });
    } catch {
      return {
        status: "inconclusive",
        reason: "managed-label-ledger-unavailable",
      };
    }
    if (
      !Array.isArray(response.data) ||
      response.data.length > MANAGED_LABEL_LEDGER_PAGE_SIZE
    ) {
      return {
        status: "inconclusive",
        reason: "managed-label-ledger-malformed-page",
      };
    }
    for (const event of response.data) {
      if (
        !event ||
        typeof event !== "object" ||
        !Number.isSafeInteger(event.id) ||
        event.id < 1 ||
        seenIds.has(event.id) ||
        typeof event.event !== "string" ||
        event.event.length < 1 ||
        /[\u0000-\u001f\u007f]/.test(event.event)
      ) {
        return {
          status: "inconclusive",
          reason: "managed-label-ledger-malformed-event",
        };
      }
      seenIds.add(event.id);
      if (event.event !== "labeled" && event.event !== "unlabeled") {
        continue;
      }
      const labelName = event.label?.name;
      if (
        typeof labelName !== "string" ||
        labelName.length < 1 ||
        labelName.includes("\0")
      ) {
        return {
          status: "inconclusive",
          reason: "managed-label-ledger-malformed-event",
        };
      }
      if (labelName !== CLI_MANAGED_LABEL) {
        continue;
      }
      let eventAt;
      try {
        eventAt = githubTimestampMilliseconds(
          event.created_at,
          "managed label event created_at",
        );
      } catch {
        return {
          status: "inconclusive",
          reason: "managed-label-ledger-malformed-event",
        };
      }
      if (event.event === "unlabeled") {
        return {
          status: "drift",
          reason: "managed-label-ledger-unlabeled",
        };
      }
      if (managedLabelAt !== null) {
        return {
          status: "drift",
          reason: "managed-label-ledger-multiple-labeled",
        };
      }
      if (
        !isWithinOpeningRaceWindow(transition.transitionAt, eventAt)
      ) {
        return {
          status: "drift",
          reason: "managed-label-ledger-outside-window",
        };
      }
      if (
        transition.unconfirmed &&
        eventAt > transition.lineageCreatedAt
      ) {
        return {
          status: "drift",
          reason: "managed-label-ledger-after-provisional-marker",
        };
      }
      managedLabelAt = eventAt;
    }
    if (response.data.length < MANAGED_LABEL_LEDGER_PAGE_SIZE) {
      return managedLabelAt === null
        ? {
            status: "inconclusive",
            reason: "managed-label-ledger-missing-proof",
          }
        : { status: "satisfied", reason: null };
    }
  }
  return {
    status: "inconclusive",
    reason: "managed-label-ledger-incomplete",
  };
}

function assertReceiptStatusEntry(
  status,
  { context, state, description, targetUrl },
) {
  let createdAt;
  try {
    createdAt = githubTimestampMilliseconds(
      status.created_at,
      "authorization receipt",
    );
  } catch {
    throw new Error("authorization receipt status is malformed");
  }
  if (
    status.context !== context ||
    status.state !== state ||
    status.description !== description ||
    status.target_url !== targetUrl ||
    status.creator?.id !== GITHUB_ACTIONS_BOT.id ||
    status.creator?.login !== GITHUB_ACTIONS_BOT.login ||
    status.creator?.type !== GITHUB_ACTIONS_BOT.type ||
    description.length > MAX_STATUS_DESCRIPTION_LENGTH ||
    Buffer.byteLength(description, "utf8") >
      MAX_STATUS_DESCRIPTION_LENGTH
  ) {
    throw new Error("authorization receipt status is malformed");
  }
  return createdAt;
}

function assertReceiptLedger(
  statuses,
  { context, description, targetUrl, states },
) {
  const ledger = statuses
    .filter((status) => status.context === context)
    .map((status) => ({
      status,
      createdAt: assertReceiptStatusEntry(status, {
        context,
        state: status.state,
        description,
        targetUrl,
      }),
    }))
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.status.id - right.status.id,
    );
  if (
    ledger.length !== states.length ||
    ledger.some(
      ({ status }, index) => status.state !== states[index],
    )
  ) {
    throw new Error("authorization receipt ledger is incomplete");
  }
  return ledger;
}

async function claimOneUseReceipt({
  github,
  owner,
  repo,
  anchorSha,
  context,
  description,
  targetUrl,
  revalidate,
}) {
  if (revalidate) {
    await revalidate();
  }
  let statuses = await listCommitStatuses(
    github,
    owner,
    repo,
    anchorSha,
  );
  if (statuses.some((status) => status.context === context)) {
    throw new Error("authorization receipt was already started");
  }
  await publishStatus(
    github,
    owner,
    repo,
    anchorSha,
    context,
    "pending",
    description,
    targetUrl,
  );
  statuses = await listCommitStatuses(
    github,
    owner,
    repo,
    anchorSha,
  );
  assertReceiptLedger(statuses, {
    context,
    description,
    targetUrl,
    states: ["pending"],
  });
  await publishStatus(
    github,
    owner,
    repo,
    anchorSha,
    context,
    "success",
    description,
    targetUrl,
  );
  statuses = await listCommitStatuses(
    github,
    owner,
    repo,
    anchorSha,
  );
  assertReceiptLedger(statuses, {
    context,
    description,
    targetUrl,
    states: ["pending", "success"],
  });
}

async function claimWorkflowAuthorization({
  github,
  owner,
  repo,
  authorization,
  pull,
  targetUrl,
  revalidate,
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
  const description =
    `PR #${pull.number} ${authorization.workflowPath} ` +
    `${authorization.authorizedBlob.slice(0, 12)}`;
  await claimOneUseReceipt({
    github,
    owner,
    repo,
    anchorSha: authorization.receiptSha,
    context,
    description,
    targetUrl,
    revalidate,
  });
}

function coverageReceiptDescription({
  authorization,
  leg,
  mergeSha,
  run,
  transition,
}) {
  if (
    !["integration", "promotion"].includes(leg) ||
    !/^[0-9a-f]{40}$/.test(mergeSha) ||
    !Number.isSafeInteger(run?.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run?.run_attempt) ||
    run.run_attempt < 1 ||
    !Number.isSafeInteger(transition?.transitionAt) ||
    transition.transitionAt < 0
  ) {
    throw new Error("coverage authorization receipt fields are invalid");
  }
  const legCode = leg === "integration" ? "i" : "p";
  const description =
    `${COVERAGE_RECEIPT_VERSION}|${legCode}|` +
    `${coverageAuthorizationFingerprint(authorization)}|${mergeSha}|` +
    `${run.id}|${run.run_attempt}|${transition.transitionAt}`;
  if (
    description.length > MAX_STATUS_DESCRIPTION_LENGTH ||
    Buffer.byteLength(description, "utf8") >
      MAX_STATUS_DESCRIPTION_LENGTH
  ) {
    throw new Error(
      "coverage authorization receipt description is too long",
    );
  }
  return description;
}

function parseCoverageReceiptDescription(description) {
  if (typeof description !== "string") {
    throw new Error("coverage authorization receipt description is malformed");
  }
  const match = description.match(
    /^v1\|(i|p)\|([0-9a-f]{40})\|([0-9a-f]{40})\|([1-9][0-9]*)\|([1-9][0-9]*)\|(0|[1-9][0-9]*)$/,
  );
  if (!match) {
    throw new Error("coverage authorization receipt description is malformed");
  }
  const runId = Number(match[4]);
  const runAttempt = Number(match[5]);
  const transitionAt = Number(match[6]);
  if (
    !Number.isSafeInteger(runId) ||
    !Number.isSafeInteger(runAttempt) ||
    !Number.isSafeInteger(transitionAt)
  ) {
    throw new Error("coverage authorization receipt description is malformed");
  }
  return {
    leg: match[1] === "i" ? "integration" : "promotion",
    fingerprint: match[2],
    mergeSha: match[3],
    runId,
    runAttempt,
    transitionAt,
  };
}

async function claimCoverageAssetAuthorization({
  github,
  owner,
  repo,
  authorization,
  pull,
  leg,
  anchorSha,
  run,
  transition,
  targetUrl,
  revalidate,
}) {
  const comparison = await github.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${anchorSha}...${pull.headSha}`,
  });
  if (
    !["ahead", "identical"].includes(comparison.data.status) ||
    comparison.data.merge_base_commit?.sha !== anchorSha
  ) {
    throw new Error(
      `coverage authorization ${authorization.id} receipt is not an ancestor`,
    );
  }

  const context = coverageAuthorizationContext(authorization, leg);
  const description = coverageReceiptDescription({
    authorization,
    leg,
    mergeSha: pull.mergeSha,
    run,
    transition,
  });
  await claimOneUseReceipt({
    github,
    owner,
    repo,
    anchorSha,
    context,
    description,
    targetUrl,
    revalidate,
  });
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
    typeof timestamp === "number"
      ? timestamp
      : githubTimestampMilliseconds(
          timestamp,
          "workflow-producing transition",
        );
  if (
    !Number.isSafeInteger(transitionAt) ||
    transitionAt < 0
  ) {
    throw new Error("workflow-producing transition timestamp is invalid");
  }
  return transitionAt;
}

function githubTimestampMilliseconds(timestamp, label) {
  const match =
    typeof timestamp === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
          timestamp,
        )
      : null;
  if (!match) {
    throw new Error(`${label} timestamp is malformed`);
  }
  const [
    year,
    month,
    day,
    hour,
    minute,
    second,
  ] = match.slice(1, 7).map(Number);
  const fraction = (match[7] || "").padEnd(3, "0");
  const milliseconds = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    Number(fraction || 0),
  );
  const parsed = new Date(milliseconds);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
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
  const transitionAt = githubTimestampMilliseconds(
    legacyMatch[2],
    "legacy quality transition",
  );
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
  const hasDirectOpeningLabelPredecessor = unconfirmed.length > 0;
  let hasInverseOpeningLabelPredecessor = false;
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
    hasInverseOpeningLabelPredecessor = true;
  }

  const resolved = candidates.sort(
    (left, right) =>
      qualityTransitionRank(right) - qualityTransitionRank(left) ||
      right.statusId - left.statusId,
  )[0];
  return {
    ...resolved,
    hasDirectOpeningLabelPredecessor,
    hasInverseOpeningLabelPredecessor,
  };
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
  if (
    !Number.isSafeInteger(workflowResponse.data?.id) ||
    workflowResponse.data.id < 1 ||
    workflowResponse.data.path !== BRANCH_WORKFLOW_PATH
  ) {
    throw new Error("branch-policy workflow identity is malformed");
  }
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
    let policyRunCreatedAt = null;
    try {
      policyRunCreatedAt = githubTimestampMilliseconds(
        policyRun?.created_at,
        "quality transition policy run created_at",
      );
    } catch {
      throw new Error(
        "quality transition marker does not originate from branch-policy",
      );
    }
    if (
      !policyRun ||
      policyRun.id !== candidate.policyRunId ||
      policyRun.workflow_id !== workflowResponse.data.id ||
      policyRun.path !== BRANCH_WORKFLOW_PATH ||
      policyRun.event !== "pull_request_target" ||
      policyRun.repository?.full_name !== `${owner}/${repo}` ||
      policyRun.html_url !== candidate.targetUrl ||
      policyRun.status !== "completed" ||
      policyRun.conclusion !== "success" ||
      relations.length !== 1 ||
      relation.number !== pull.number ||
      relation.head?.sha !== pull.headSha ||
      relation.base?.sha !== pull.baseSha ||
      policyRunCreatedAt < candidate.transitionAt ||
      candidate.statusCreatedAt < candidate.transitionAt ||
      candidate.statusCreatedAt < policyRunCreatedAt
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
  if (!/^[0-9a-f]{40}$/.test(response.data.sha)) {
    throw new Error(
      `Expected ${repository}:${path}@${ref} to have a Git blob SHA`,
    );
  }
  return response.data.sha;
}

async function getBranchSha(github, owner, repo, branch) {
  const response = await github.rest.repos.getCommit({
    owner,
    repo,
    ref: branch,
  });
  const sha = response.data?.sha;
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`trusted branch ${branch} has an invalid SHA`);
  }
  return sha;
}

async function listOpenPromotionPulls(github, owner, repo, repository) {
  const pulls = [];
  const seenNumbers = new Set();
  for (let page = 1; Number.isSafeInteger(page); page += 1) {
    const response = await github.rest.pulls.list({
      owner,
      repo,
      state: "open",
      base: "master",
      per_page: 100,
      page,
    });
    const pagePulls = response.data;
    if (!Array.isArray(pagePulls) || pagePulls.length > 100) {
      throw new Error("open promotion inventory is malformed");
    }
    for (const candidate of pagePulls) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        !Number.isSafeInteger(candidate.number) ||
        candidate.number < 1 ||
        candidate.state !== "open" ||
        typeof candidate.head?.ref !== "string" ||
        typeof candidate.base?.ref !== "string" ||
        typeof candidate.head?.repo?.full_name !== "string" ||
        seenNumbers.has(candidate.number)
      ) {
        throw new Error("open promotion inventory entry is malformed");
      }
      seenNumbers.add(candidate.number);
      if (
        candidate.head.ref === "dev" &&
        candidate.base.ref === "master" &&
        candidate.head.repo.full_name === repository
      ) {
        pulls.push(candidate.number);
      }
    }
    if (pagePulls.length < 100) {
      return pulls.sort((left, right) => left - right);
    }
  }
  throw new Error("open promotion inventory exceeds safe pagination");
}

function completedCoverageReceipt({
  statuses,
  authorization,
  leg,
}) {
  const context = coverageAuthorizationContext(authorization, leg);
  const ledger = statuses.filter((status) => status.context === context);
  if (ledger.length !== 2) {
    throw new Error(
      `coverage ${leg} authorization receipt is incomplete`,
    );
  }
  const description = ledger[0].description;
  const targetUrl = ledger[0].target_url;
  if (
    typeof description !== "string" ||
    typeof targetUrl !== "string" ||
    ledger.some(
      (status) =>
        status.description !== description ||
        status.target_url !== targetUrl,
    )
  ) {
    throw new Error(
      `coverage ${leg} authorization receipt is malformed`,
    );
  }
  assertReceiptLedger(statuses, {
    context,
    description,
    targetUrl,
    states: ["pending", "success"],
  });
  const receipt = parseCoverageReceiptDescription(description);
  if (
    receipt.leg !== leg ||
    receipt.fingerprint !==
      coverageAuthorizationFingerprint(authorization)
  ) {
    throw new Error(
      `coverage ${leg} authorization receipt is for another authority`,
    );
  }
  return { ...receipt, targetUrl };
}

async function assertCoverageReceiptPolicyRun({
  github,
  owner,
  repo,
  repository,
  serverUrl,
  receipt,
  pull,
  qualityRun,
}) {
  const prefix =
    `${serverUrl.replace(/\/$/, "")}/${owner}/${repo}/actions/runs/`;
  if (!receipt.targetUrl.startsWith(prefix)) {
    throw new Error("coverage authorization receipt run URL is malformed");
  }
  const policyRunIdText = receipt.targetUrl.slice(prefix.length);
  const policyRunId = Number(policyRunIdText);
  if (
    !/^[1-9][0-9]*$/.test(policyRunIdText) ||
    !Number.isSafeInteger(policyRunId)
  ) {
    throw new Error("coverage authorization receipt run URL is malformed");
  }
  const [workflowResponse, runResponse] = await Promise.all([
    github.rest.actions.getWorkflow({
      owner,
      repo,
      workflow_id: BRANCH_WORKFLOW,
    }),
    github.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: policyRunId,
    }),
  ]);
  const run = runResponse.data;
  const relations = Array.isArray(run?.pull_requests)
    ? run.pull_requests
    : [];
  const relation = relations[0];
  const runCreatedAt = githubTimestampMilliseconds(
    run?.created_at,
    "coverage receipt policy run created_at",
  );
  const qualityCompletedAt = githubTimestampMilliseconds(
    qualityRun.updated_at,
    "quality workflow run updated_at",
  );
  if (
    workflowResponse.data?.id !== run?.workflow_id ||
    workflowResponse.data?.path !== BRANCH_WORKFLOW_PATH ||
    run.path !== BRANCH_WORKFLOW_PATH ||
    run.event !== "workflow_run" ||
    run.repository?.full_name !== repository ||
    run.html_url !== receipt.targetUrl ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    runCreatedAt < qualityCompletedAt ||
    relations.length !== 1 ||
    relation.number !== pull.number ||
    relation.head?.sha !== pull.headSha ||
    relation.base?.sha !== pull.baseSha
  ) {
    throw new Error(
      "coverage authorization receipt does not originate from trusted branch-policy",
    );
  }
}

async function getMergedAuthorizedSourcePull({
  github,
  owner,
  repo,
  repository,
  authorization,
}) {
  const response = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: authorization.pullNumber,
  });
  const rawPull = response.data;
  const pull = pullIdentity(rawPull);
  if (
    pull.state !== "closed" ||
    rawPull.merged !== true ||
    typeof rawPull.merged_at !== "string" ||
    !Number.isSafeInteger(
      githubTimestampMilliseconds(
        rawPull.merged_at,
        "authorized source pull merged_at",
      ),
    ) ||
    !/^[0-9a-f]{40}$/.test(rawPull.merge_commit_sha) ||
    pull.number !== authorization.pullNumber ||
    pull.headRepository !== repository ||
    pull.headRepository !== authorization.headRepository ||
    pull.headRef !== authorization.headRef ||
    pull.headSha !== authorization.headSha ||
    pull.baseRef !== authorization.baseRef ||
    pull.changedFiles !== COVERAGE_AUTHORIZED_PATHS.length
  ) {
    throw new Error("authorized coverage source pull is not exactly merged");
  }
  return { pull, mergeCommitSha: rawPull.merge_commit_sha };
}

async function assertCoverageMergeSnapshotLineage({
  github,
  owner,
  repo,
  pull,
  mergeSha = pull.mergeSha,
}) {
  if (mergeSha === pull.headSha || mergeSha === pull.baseSha) {
    throw new Error("coverage pull has no unique merge snapshot");
  }
  const [baseSnapshotComparison, headSnapshotComparison] =
    await Promise.all([
      github.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${pull.baseSha}...${mergeSha}`,
      }),
      github.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${pull.headSha}...${mergeSha}`,
      }),
    ]);
  if (
    baseSnapshotComparison.data.status !== "ahead" ||
    baseSnapshotComparison.data.merge_base_commit?.sha !== pull.baseSha ||
    headSnapshotComparison.data.status !== "ahead" ||
    headSnapshotComparison.data.merge_base_commit?.sha !== pull.headSha
  ) {
    throw new Error("coverage pull merge snapshot lineage is invalid");
  }
}

async function assertAuthorizedSourceQuality({
  github,
  owner,
  repo,
  repository,
  serverUrl,
  authorization,
  sourcePull,
  integrationReceipt,
}) {
  const snapshotPull = {
    ...sourcePull,
    mergeSha: integrationReceipt.mergeSha,
  };
  await assertCoverageMergeSnapshotLineage({
    github,
    owner,
    repo,
    pull: sourcePull,
    mergeSha: snapshotPull.mergeSha,
  });
  const transition = await getQualityTransition({
    github,
    owner,
    repo,
    pull: snapshotPull,
    serverUrl,
  });
  if (
    !transition ||
    transition.version !== 3 ||
    transition.stale ||
    transition.unconfirmed ||
    transition.runId !== integrationReceipt.runId ||
    transition.transitionAt !== integrationReceipt.transitionAt ||
    !transitionMatchesPullIdentity(transition, snapshotPull)
  ) {
    throw new Error(
      "authorized coverage source transition is incomplete",
    );
  }
  const [workflowResponse, runResponse] = await Promise.all([
    github.rest.actions.getWorkflow({
      owner,
      repo,
      workflow_id: QUALITY_WORKFLOW,
    }),
    github.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: integrationReceipt.runId,
    }),
  ]);
  const run = runResponse.data;
  assertQualityWorkflowRunCandidate({
    run,
    owner,
    repo,
    serverUrl,
  });
  if (
    workflowResponse.data?.id !== run.workflow_id ||
    workflowResponse.data?.path !== QUALITY_WORKFLOW_PATH ||
    !runMatchesPull(run, snapshotPull, workflowResponse.data.id) ||
    run.run_attempt !== integrationReceipt.runAttempt ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error(
      "authorized coverage source quality run is invalid",
    );
  }
  assertCoverageAuthorizationRunEligibility(
    authorization,
    transition,
    run,
  );
  try {
    await requireSuccessfulAggregateQualityJob({
      github,
      owner,
      repo,
      run,
    });
  } catch {
    throw new Error(
      "authorized coverage source aggregate quality job is invalid",
    );
  }
  await assertCoverageReceiptPolicyRun({
    github,
    owner,
    repo,
    repository,
    serverUrl,
    receipt: integrationReceipt,
    pull: snapshotPull,
    qualityRun: run,
  });
  return { snapshotPull, run, transition };
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

async function assertCoverageAuthorizationLineage({
  github,
  owner,
  repo,
  authorization,
  pull,
}) {
  const pullComparison =
    await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${pull.headSha}...${pull.baseSha}`,
    });
  if (
    !["ahead", "behind", "diverged", "identical"].includes(
      pullComparison.data.status,
    ) ||
    pullComparison.data.merge_base_commit?.sha !== authorization.baseSha
  ) {
    throw new Error(
      `coverage authorization ${authorization.id} base is not the pull merge base`,
    );
  }

  const adoptionComparison =
    await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${authorization.adoptionSha}...${authorization.baseSha}`,
    });
  if (
    !["ahead", "identical"].includes(adoptionComparison.data.status) ||
    adoptionComparison.data.merge_base_commit?.sha !==
      authorization.adoptionSha
  ) {
    throw new Error(
      `coverage authorization ${authorization.id} predates trusted adoption`,
    );
  }

  const receiptComparison =
    await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${authorization.receiptSha}...${pull.headSha}`,
    });
  if (
    !["ahead", "identical"].includes(receiptComparison.data.status) ||
    receiptComparison.data.merge_base_commit?.sha !==
      authorization.receiptSha
  ) {
    throw new Error(
      `coverage authorization ${authorization.id} receipt is not an ancestor`,
    );
  }
}

async function getCoveragePair(github, repository, ref) {
  const [engineBlob, harnessBlob] = await Promise.all([
    getWorkflowBlob(
      github,
      repository,
      COVERAGE_ENGINE_PATH,
      ref,
    ),
    getWorkflowBlob(
      github,
      repository,
      COVERAGE_HARNESS_PATH,
      ref,
    ),
  ]);
  return { engineBlob, harnessBlob };
}

function assertCoveragePair(pair, engineBlob, harnessBlob, label) {
  if (
    pair.engineBlob !== engineBlob ||
    pair.harnessBlob !== harnessBlob
  ) {
    throw new Error(`${label} coverage pair is not exact`);
  }
}

async function resolveCoverageAssetTrust({
  github,
  owner,
  repo,
  pull,
  coverageAuthorizations,
  fallbackUrl,
  serverUrl,
}) {
  const repository = `${owner}/${repo}`;
  const repositoryResponse = await github.rest.repos.get({ owner, repo });
  const defaultBranch = repositoryResponse.data.default_branch;
  if (defaultBranch !== "master") {
    return {
      failure: {
        state: "failure",
        description: `PR #${pull.number} cannot verify trusted coverage assets`,
        targetUrl: fallbackUrl,
        reason: "trusted coverage authorization requires master as default",
      },
    };
  }
  if (
    !Number.isSafeInteger(pull.changedFiles) ||
    pull.changedFiles < 0
  ) {
    return {
      failure: {
        state: "failure",
        description: `PR #${pull.number} cannot verify trusted coverage assets`,
        targetUrl: fallbackUrl,
        reason: "pull request changed file count is invalid",
      },
    };
  }
  let trustedPair;
  let basePair;
  let authorizedPair;
  let snapshotPair;
  let trustedReviewBlob;
  let authorizedReviewBlob;
  let snapshotReviewBlob;
  let trustedInvocationBlob;
  let authorizedInvocationBlob;
  let snapshotInvocationBlob;
  try {
    [
      trustedPair,
      basePair,
      authorizedPair,
      snapshotPair,
      trustedReviewBlob,
      authorizedReviewBlob,
      snapshotReviewBlob,
      trustedInvocationBlob,
      authorizedInvocationBlob,
      snapshotInvocationBlob,
    ] = await Promise.all([
      getCoveragePair(github, repository, defaultBranch),
      getCoveragePair(github, repository, pull.baseSha),
      getCoveragePair(github, pull.headRepository, pull.headSha),
      getCoveragePair(github, repository, pull.mergeSha),
      getWorkflowBlob(
        github,
        repository,
        COVERAGE_REVIEW_PATH,
        defaultBranch,
      ),
      getWorkflowBlob(
        github,
        pull.headRepository,
        COVERAGE_REVIEW_PATH,
        pull.headSha,
      ),
      getWorkflowBlob(
        github,
        repository,
        COVERAGE_REVIEW_PATH,
        pull.mergeSha,
      ),
      getWorkflowBlob(
        github,
        repository,
        COVERAGE_INVOCATION_PATH,
        defaultBranch,
      ),
      getWorkflowBlob(
        github,
        pull.headRepository,
        COVERAGE_INVOCATION_PATH,
        pull.headSha,
      ),
      getWorkflowBlob(
        github,
        repository,
        COVERAGE_INVOCATION_PATH,
        pull.mergeSha,
      ),
    ]);
  } catch (error) {
    return {
      failure: {
        state: "failure",
        description: `PR #${pull.number} cannot verify trusted coverage assets`,
        targetUrl: fallbackUrl,
        reason: error.message,
      },
    };
  }

  if (
    trustedReviewBlob !== authorizedReviewBlob ||
    trustedReviewBlob !== snapshotReviewBlob ||
    trustedInvocationBlob !== authorizedInvocationBlob ||
    trustedInvocationBlob !== snapshotInvocationBlob
  ) {
    return {
      failure: {
        state: "failure",
        description: `PR #${pull.number} changes trusted coverage review code`,
        targetUrl: fallbackUrl,
        reason:
          "coverage review validator and invocation must match the current default branch",
      },
    };
  }

  try {
    assertCoveragePair(
      basePair,
      trustedPair.engineBlob,
      trustedPair.harnessBlob,
      "pull base",
    );
    assertCoveragePair(
      snapshotPair,
      authorizedPair.engineBlob,
      authorizedPair.harnessBlob,
      "merge snapshot",
    );
  } catch (error) {
    return {
      failure: {
        state: "failure",
        description: `PR #${pull.number} has inconsistent coverage lineage`,
        targetUrl: fallbackUrl,
        reason: error.message,
      },
    };
  }

  const engineChanged =
    trustedPair.engineBlob !== authorizedPair.engineBlob;
  const harnessChanged =
    trustedPair.harnessBlob !== authorizedPair.harnessBlob;
  if (!engineChanged && !harnessChanged) {
    return { authorization: null, failure: null };
  }
  if (engineChanged !== harnessChanged) {
    return {
      failure: {
        state: "failure",
        description: `PR #${pull.number} changes an incomplete coverage pair`,
        targetUrl: fallbackUrl,
        reason:
          "coverage engine and harness must remain default-equal or change as one authorized pair",
      },
    };
  }

  let files;
  let authorization;
  let leg;
  let anchorSha;
  try {
    files = await listPullRequestFiles(
      github,
      owner,
      repo,
      pull.number,
      pull.changedFiles,
    );
    if (pull.baseRef === "dev") {
      assertCoverageSourceFiles(files);
      authorization = findCoverageAssetAuthorization({
        authorizations: coverageAuthorizations,
        repository,
        trustedEngineBlob: trustedPair.engineBlob,
        authorizedEngineBlob: authorizedPair.engineBlob,
        trustedHarnessBlob: trustedPair.harnessBlob,
        authorizedHarnessBlob: authorizedPair.harnessBlob,
        changedPaths: files.map(({ filename }) => filename).sort(),
        pull,
      });
      if (!authorization) {
        throw new Error(
          "no exact source coverage authorization matches the pull request",
        );
      }
      await assertCoverageAuthorizationLineage({
        github,
        owner,
        repo,
        authorization,
        pull,
      });
      await assertCoverageMergeSnapshotLineage({
        github,
        owner,
        repo,
        pull,
      });
      const statuses = await listCommitStatuses(
        github,
        owner,
        repo,
        authorization.receiptSha,
      );
      const context = coverageAuthorizationContext(
        authorization,
        "integration",
      );
      if (statuses.some((status) => status.context === context)) {
        throw new Error(
          "coverage integration authorization receipt was already started",
        );
      }
      leg = "integration";
      anchorSha = authorization.receiptSha;
    } else if (
      pull.baseRef === "master" &&
      pull.headRef === "dev" &&
      pull.headRepository === repository
    ) {
      assertCoveragePromotionFiles(files);
      authorization = findCoveragePromotionAuthorization({
        authorizations: coverageAuthorizations,
        repository,
        trustedEngineBlob: trustedPair.engineBlob,
        authorizedEngineBlob: authorizedPair.engineBlob,
        trustedHarnessBlob: trustedPair.harnessBlob,
        authorizedHarnessBlob: authorizedPair.harnessBlob,
      });
      if (!authorization) {
        throw new Error(
          "no exact source coverage authorization derives this promotion",
        );
      }
      const [liveMaster, liveDev] = await Promise.all([
        getBranchSha(github, owner, repo, "master"),
        getBranchSha(github, owner, repo, "dev"),
      ]);
      if (
        liveMaster !== pull.baseSha ||
        liveDev !== pull.headSha
      ) {
        throw new Error(
          "coverage promotion does not use the live master and dev tips",
        );
      }
      const promotionComparison =
        await github.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${pull.baseSha}...${pull.headSha}`,
        });
      if (
        !["ahead", "identical"].includes(
          promotionComparison.data.status,
        ) ||
        promotionComparison.data.merge_base_commit?.sha !==
          pull.baseSha
      ) {
        throw new Error(
          "coverage promotion base is not an ancestor of its head",
        );
      }
      const openPromotions = await listOpenPromotionPulls(
        github,
        owner,
        repo,
        repository,
      );
      if (
        openPromotions.length === 0 ||
        openPromotions[0] !== pull.number
      ) {
        throw new Error(
          "coverage promotion is not the canonical lowest-numbered open promotion",
        );
      }
      const source = await getMergedAuthorizedSourcePull({
        github,
        owner,
        repo,
        repository,
        authorization,
      });
      const sourceFiles = await listPullRequestFiles(
        github,
        owner,
        repo,
        source.pull.number,
        source.pull.changedFiles,
      );
      assertCoverageSourceFiles(sourceFiles);
      await assertCoverageAuthorizationLineage({
        github,
        owner,
        repo,
        authorization,
        pull: source.pull,
      });
      const integrationStatuses = await listCommitStatuses(
        github,
        owner,
        repo,
        authorization.receiptSha,
      );
      const integrationReceipt = completedCoverageReceipt({
        statuses: integrationStatuses,
        authorization,
        leg: "integration",
      });
      const sourceQuality = await assertAuthorizedSourceQuality({
        github,
        owner,
        repo,
        repository,
        serverUrl,
        authorization,
        sourcePull: source.pull,
        integrationReceipt,
      });
      const sourceMergeComparison =
        await github.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${source.mergeCommitSha}...${pull.headSha}`,
        });
      if (
        !["ahead", "identical"].includes(
          sourceMergeComparison.data.status,
        ) ||
        sourceMergeComparison.data.merge_base_commit?.sha !==
          source.mergeCommitSha
      ) {
        throw new Error(
          "authorized coverage source merge is not in the promotion head",
        );
      }
      const [
        sourceBasePair,
        sourceHeadPair,
        sourceSnapshotPair,
        sourceMergePair,
      ] = await Promise.all([
        getCoveragePair(github, repository, source.pull.baseSha),
        getCoveragePair(github, repository, source.pull.headSha),
        getCoveragePair(
          github,
          repository,
          sourceQuality.snapshotPull.mergeSha,
        ),
        getCoveragePair(
          github,
          repository,
          source.mergeCommitSha,
        ),
      ]);
      assertCoveragePair(
        sourceBasePair,
        authorization.trustedEngineBlob,
        authorization.trustedHarnessBlob,
        "authorized source base",
      );
      for (const [label, pair] of [
        ["authorized source head", sourceHeadPair],
        ["authorized source snapshot", sourceSnapshotPair],
        ["authorized source merge", sourceMergePair],
      ]) {
        assertCoveragePair(
          pair,
          authorization.authorizedEngineBlob,
          authorization.authorizedHarnessBlob,
          label,
        );
      }
      const promotionStatuses = await listCommitStatuses(
        github,
        owner,
        repo,
        source.mergeCommitSha,
      );
      const promotionContext = coverageAuthorizationContext(
        authorization,
        "promotion",
      );
      if (
        promotionStatuses.some(
          (status) => status.context === promotionContext,
        )
      ) {
        throw new Error(
          "coverage promotion authorization receipt was already started",
        );
      }
      leg = "promotion";
      anchorSha = source.mergeCommitSha;
    } else {
      throw new Error(
        "changed coverage assets are not on an integration or promotion pull request",
      );
    }
  } catch (error) {
    return {
      failure: {
        state: "failure",
        description: `PR #${pull.number} has invalid coverage authorization`,
        targetUrl: fallbackUrl,
        reason: error.message,
      },
    };
  }
  return { authorization, leg, anchorSha, failure: null };
}

async function resolveTrustedQualityAssets({
  github,
  owner,
  repo,
  pull,
  workflowAuthorizations,
  coverageAuthorizations,
  authorizationNow,
  fallbackUrl,
  serverUrl,
}) {
  const workflowTrust = await resolveQualityWorkflowTrust({
    github,
    owner,
    repo,
    pull,
    workflowAuthorizations,
    authorizationNow,
    fallbackUrl,
  });
  if (workflowTrust.failure) {
    return workflowTrust;
  }
  const coverageTrust = await resolveCoverageAssetTrust({
    github,
    owner,
    repo,
    pull,
    coverageAuthorizations,
    fallbackUrl,
    serverUrl,
  });
  if (coverageTrust.failure) {
    return {
      workflowId: workflowTrust.workflowId,
      failure: coverageTrust.failure,
    };
  }
  if (workflowTrust.authorization && coverageTrust.authorization) {
    return {
      workflowId: workflowTrust.workflowId,
      failure: {
        state: "failure",
        description: `PR #${pull.number} combines trusted authorization scopes`,
        targetUrl: fallbackUrl,
        reason:
          "workflow and coverage asset authorizations must be consumed by separate pull requests",
      },
    };
  }

  const authorization = workflowTrust.authorization
    ? { kind: "workflow", value: workflowTrust.authorization }
    : coverageTrust.authorization
      ? {
          kind: "coverage",
          leg: coverageTrust.leg,
          anchorSha: coverageTrust.anchorSha,
          value: coverageTrust.authorization,
        }
      : null;
  return {
    workflowId: workflowTrust.workflowId,
    authorization,
    failure: null,
  };
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
      !Number.isSafeInteger(current.changedFiles) ||
      current.changedFiles < 0
    ) {
      throw new Error(`Pull request #${number} changed file count is invalid`);
    }
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
  let validStartedAt = true;
  let validUpdatedAt = true;
  try {
    githubTimestampMilliseconds(
      run?.created_at,
      "quality workflow run created_at",
    );
  } catch {
    validCreatedAt = false;
  }
  try {
    const createdAt = githubTimestampMilliseconds(
      run?.created_at,
      "quality workflow run created_at",
    );
    const startedAt = githubTimestampMilliseconds(
      run?.run_started_at,
      "quality workflow run run_started_at",
    );
    validStartedAt = startedAt >= createdAt;
  } catch {
    validStartedAt = false;
  }
  try {
    const startedAt = githubTimestampMilliseconds(
      run?.run_started_at,
      "quality workflow run run_started_at",
    );
    const updatedAt = githubTimestampMilliseconds(
      run?.updated_at,
      "quality workflow run updated_at",
    );
    validUpdatedAt = updatedAt >= startedAt;
  } catch {
    validUpdatedAt = false;
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
    !run.repository ||
    typeof run.repository !== "object" ||
    Array.isArray(run.repository) ||
    run.repository.full_name !== `${owner}/${repo}` ||
    !validRelations ||
    !validCreatedAt ||
    !validStartedAt ||
    !validUpdatedAt ||
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

function assertWorkflowJobInventoryEntry(job, run) {
  const validState =
    job?.status === "completed"
      ? WORKFLOW_JOB_CONCLUSIONS.has(job.conclusion)
      : WORKFLOW_RUN_NONTERMINAL_STATUSES.has(job?.status) &&
        job.conclusion === null;
  if (
    !job ||
    typeof job !== "object" ||
    Array.isArray(job) ||
    !Number.isSafeInteger(job.id) ||
    job.id < 1 ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    job.head_sha !== run.head_sha ||
    typeof job.name !== "string" ||
    job.name.length < 1 ||
    job.name.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(job.name) ||
    !validState
  ) {
    throw new Error("quality workflow job inventory entry is malformed");
  }
}

async function requireSuccessfulAggregateQualityJob({
  github,
  owner,
  repo,
  run,
}) {
  const jobs = [];
  const seenIds = new Set();
  let expectedTotal = null;
  for (let page = 1; Number.isSafeInteger(page); page += 1) {
    const response =
      await github.rest.actions.listJobsForWorkflowRunAttempt({
        owner,
        repo,
        run_id: run.id,
        attempt_number: run.run_attempt,
        per_page: 100,
        page,
      });
    const total = response.data?.total_count;
    const pageJobs = response.data?.jobs;
    if (
      !Number.isSafeInteger(total) ||
      total < 0 ||
      !Array.isArray(pageJobs) ||
      pageJobs.length > 100
    ) {
      throw new Error("quality workflow job inventory is malformed");
    }
    if (expectedTotal === null) {
      expectedTotal = total;
    } else if (total !== expectedTotal) {
      throw new Error("quality workflow job inventory changed while paging");
    }
    const remaining = expectedTotal - jobs.length;
    if (
      remaining < 0 ||
      pageJobs.length !== Math.min(100, remaining)
    ) {
      throw new Error("quality workflow job inventory is incomplete");
    }
    for (const job of pageJobs) {
      assertWorkflowJobInventoryEntry(job, run);
      if (seenIds.has(job.id)) {
        throw new Error(
          "quality workflow job inventory contains duplicate IDs",
        );
      }
      seenIds.add(job.id);
      jobs.push(job);
    }
    if (remaining === 0) {
      break;
    }
  }
  if (jobs.length !== expectedTotal) {
    throw new Error("quality workflow job inventory is incomplete");
  }
  const aggregate = jobs.filter((job) => job.name === QUALITY_JOB);
  if (
    aggregate.length !== 1 ||
    aggregate[0].status !== "completed" ||
    aggregate[0].conclusion !== "success"
  ) {
    throw new Error(
      "trusted aggregate quality job is missing or unsuccessful",
    );
  }
  return aggregate[0];
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
    run.repository.full_name,
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
    githubTimestampMilliseconds(
      run.run_started_at,
      "quality workflow run run_started_at",
    ),
    githubTimestampMilliseconds(
      run.updated_at,
      "quality workflow run updated_at",
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
  const transitionAt = transitionTimestampMilliseconds(timestamp);
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
        const createdAt = githubTimestampMilliseconds(
          run.created_at,
          "quality workflow run created_at",
        );
        return createdAt > minimumCreatedAt;
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
    parseAuthorizationTime(
      authorization.value.issuedAt,
      "issuedAt",
    ),
  );
}

function authorizationLabel(authorization) {
  return authorization.kind === "coverage"
    ? `coverage ${authorization.leg} authorization`
    : `${authorization.kind} authorization`;
}

function authorizationClaimEvidence(authorization) {
  if (!authorization?.run || !authorization?.transition) {
    throw new Error("authorization claim evidence is incomplete");
  }
  return JSON.stringify([
    authorization.kind,
    authorization.leg || null,
    authorization.anchorSha || authorization.value.receiptSha,
    authorization.value.id,
    authorization.kind === "coverage"
      ? coverageAuthorizationFingerprint(authorization.value)
      : authorization.value.authorizedBlob,
    qualityWorkflowRunEvidence(authorization.run),
    authorization.transition.version,
    authorization.transition.action,
    authorization.transition.transitionAt,
    authorization.transition.runId,
    authorization.transition.contentFingerprint,
    authorization.transition.labelsFingerprint,
  ]);
}

function assertCoverageAuthorizationRunEligibility(
  authorization,
  transition,
  run,
) {
  validateCoverageAssetAuthorization(authorization);
  const issuedAt = parseCoverageAuthorizationTime(
    authorization.issuedAt,
    "issuedAt",
  );
  const expiresAt = parseCoverageAuthorizationTime(
    authorization.expiresAt,
    "expiresAt",
  );
  const createdAt = githubTimestampMilliseconds(
    run.created_at,
    "quality workflow run created_at",
  );
  const startedAt = githubTimestampMilliseconds(
    run.run_started_at,
    "quality workflow run run_started_at",
  );
  if (
    issuedAt >= transition.transitionAt ||
    transition.transitionAt >= createdAt ||
    createdAt >= expiresAt ||
    startedAt >= expiresAt
  ) {
    throw new Error(
      "coverage authorization does not contain the immutable transition and run",
    );
  }
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
    hasOnlyCliManagedPolicyLabel(pull.labels)
  );
}

function isRecoverableUnconfirmedOpeningLabelLineage(transition, pull) {
  return (
    transition.version === 3 &&
    transition.action === "opened" &&
    transition.unconfirmed &&
    !transition.stale &&
    transitionMatchesPullIdentity(transition, pull) &&
    transition.labelsFingerprint === CLI_MANAGED_LABELS_FINGERPRINT &&
    hasOnlyCliManagedPolicyLabel(pull.labels)
  );
}

function requiresOpeningLabelLedgerAuthority(transition, pull) {
  return (
    transition.action === "opened" &&
    (transition.hasDirectOpeningLabelPredecessor === true ||
      transition.hasInverseOpeningLabelPredecessor === true ||
      isOpeningLabelLineage(transition, pull))
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
    !hasOnlyCliManagedPolicyLabel(eventPull?.labels) ||
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

function isConfirmedInverseOpeningLabelReplay({
  transition,
  pull,
  eventAction,
  eventLabelName,
  eventPull,
}) {
  if (
    transition.hasInverseOpeningLabelPredecessor !== true ||
    !transitionMatchesPullIdentity(transition, pull) ||
    !hasInverseOpeningLabelEvidence({
      transition,
      pull,
      eventAction,
      eventLabelName,
      eventPull,
    })
  ) {
    return false;
  }
  return (
    githubTimestampMilliseconds(
      eventPull.updatedAt,
      "pull request event updated_at",
    ) === transition.lineageCreatedAt
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
    !hasOnlyCliManagedPolicyLabel(eventPull?.labels) ||
    !hasOnlyCliManagedPolicyLabel(pull.labels) ||
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
  coverageAuthorizations,
  authorizationNow,
  fallbackUrl,
}) {
  const labelRefresh =
    eventAction === "labeled" || eventAction === "unlabeled";
  if (
    labelRefresh &&
    INFORMATIONAL_CONTEXT_LABEL_PATTERN.test(eventLabelName || "")
  ) {
    return false;
  }
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
  const recoverUnconfirmedOpeningLabel =
    isRecoverableUnconfirmedOpeningLabelLineage(transition, pull) &&
    eventAction === null;
  if (
    requiresOpeningLabelLedgerAuthority(transition, pull) ||
    recoverUnconfirmedOpeningLabel
  ) {
    const ledger = await inspectManagedLabelLedger({
      github,
      owner,
      repo,
      pull,
      transition,
    });
    if (ledger.status === "drift") {
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
      throw new Error("opening managed-label ledger proves drift");
    }
    if (ledger.status !== "satisfied") {
      throw new Error(
        `opening managed-label ledger is inconclusive: ${ledger.reason}`,
      );
    }
  }
  if (recoverUnconfirmedOpeningLabel) {
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
      throw new Error("quality transition lineage is permanently stale");
    }
    return false;
  }
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
  const confirmedInverseOpeningLabelReplay =
    isConfirmedInverseOpeningLabelReplay({
      transition,
      pull,
      eventAction,
      eventLabelName,
      eventPull,
    });
  if (confirmedInverseOpeningLabelReplay) {
    return false;
  }
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
        throw new Error("quality transition lineage is permanently stale");
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
    throw new Error("quality transition lineage is permanently stale");
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
      throw new Error("quality transition lineage is permanently stale");
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

  const trust = await resolveTrustedQualityAssets({
    github,
    owner,
    repo,
    pull,
    workflowAuthorizations,
    coverageAuthorizations,
    authorizationNow,
    fallbackUrl,
    serverUrl,
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
  coverageAuthorizations,
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
  const trust = await resolveTrustedQualityAssets({
    github,
    owner,
    repo,
    pull,
    workflowAuthorizations,
    coverageAuthorizations,
    authorizationNow,
    fallbackUrl,
    serverUrl,
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
  const runCreatedAt = githubTimestampMilliseconds(
    run.created_at,
    "quality workflow run created_at",
  );
  if (
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
    const label = authorizationLabel(authorization);
    if (authorization.kind === "coverage") {
      try {
        assertCoverageAuthorizationRunEligibility(
          authorization.value,
          transition,
          run,
        );
      } catch (error) {
        return {
          state: "failure",
          description: `PR #${pull.number} has invalid coverage timing`,
          targetUrl: fallbackUrl,
          reason: error.message,
        };
      }
    } else {
      const authorizationIssuedAt = parseAuthorizationTime(
        authorization.value.issuedAt,
        "issuedAt",
      );
      if (runCreatedAt <= authorizationIssuedAt) {
        return {
          state: "pending",
          description: `PR #${pull.number} awaits post-authorization quality gates`,
          targetUrl: fallbackUrl,
          reason: `matching quality workflow run predates its ${label}`,
        };
      }
    }
    if (!candidateRun || candidateRun.id !== run.id) {
      return {
        state: "pending",
        description: `PR #${pull.number} awaits its exact quality completion event`,
        targetUrl: run.html_url || fallbackUrl,
        reason:
          `${label} may be consumed only by the selected run's workflow_run`,
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

  try {
    await requireSuccessfulAggregateQualityJob({
      github,
      owner,
      repo,
      run,
    });
  } catch (error) {
    return {
      state: "failure",
      description: `PR #${pull.number} trusted aggregate gate did not succeed`,
      targetUrl: run.html_url,
      reason: error.message,
    };
  }

  return {
    state: "success",
    description: `PR #${pull.number} exact trusted quality gates passed`,
    targetUrl: run.html_url,
    reason:
      "exact trusted quality workflow and aggregate job succeeded" +
      (authorization
        ? ` authorization=${authorization.value.id}`
        : ""),
    authorization: authorization
      ? { ...authorization, run, transition }
      : null,
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
  coverageAuthorizations = TRUSTED_COVERAGE_ASSET_AUTHORIZATIONS,
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
          coverageAuthorizations,
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
      coverageAuthorizations,
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
        `${authorizationLabel(quality.authorization)} may be consumed only by its exact workflow_run`;
    }
    if (quality.state === "success" && quality.authorization) {
      try {
        const expectedClaimEvidence = authorizationClaimEvidence(
          quality.authorization,
        );
        const revalidate = async () => {
          const currentPull = await getCurrentPull(
            github,
            owner,
            repo,
            pull.number,
            pull,
          );
          const currentQuality = await qualityDecision({
            github,
            owner,
            repo,
            pull: currentPull,
            candidateRun: item.candidateRun,
            fallbackUrl: policyRunUrl,
            workflowAuthorizations,
            coverageAuthorizations,
            authorizationNow,
            requireFreshRun: false,
            serverUrl: context.serverUrl,
          });
          if (
            currentQuality.state !== "success" ||
            !currentQuality.authorization ||
            authorizationClaimEvidence(currentQuality.authorization) !==
              expectedClaimEvidence
          ) {
            throw new Error(
              "authorization authority changed immediately before receipt claim",
            );
          }
        };
        if (quality.authorization.kind === "workflow") {
          await claimWorkflowAuthorization({
            github,
            owner,
            repo,
            authorization: quality.authorization.value,
            pull,
            targetUrl: policyRunUrl,
            revalidate,
          });
        } else {
          await claimCoverageAssetAuthorization({
            github,
            owner,
            repo,
            authorization: quality.authorization.value,
            pull,
            leg: quality.authorization.leg,
            anchorSha: quality.authorization.anchorSha,
            run: quality.authorization.run,
            transition: quality.authorization.transition,
            targetUrl: policyRunUrl,
            revalidate,
          });
        }
      } catch (error) {
        const label = authorizationLabel(quality.authorization);
        quality.state = "failure";
        quality.description =
          `PR #${pull.number} could not consume ${label}`;
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
module.exports.claimCoverageAssetAuthorization =
  claimCoverageAssetAuthorization;
module.exports.claimWorkflowAuthorization = claimWorkflowAuthorization;
module.exports.coverageAuthorizationContext =
  coverageAuthorizationContext;
module.exports.coverageAuthorizationFingerprint =
  coverageAuthorizationFingerprint;
module.exports.coverageReceiptDescription = coverageReceiptDescription;
module.exports.findCoverageAssetAuthorization =
  findCoverageAssetAuthorization;
module.exports.findCoveragePromotionAuthorization =
  findCoveragePromotionAuthorization;
module.exports.findWorkflowAuthorization = findWorkflowAuthorization;
module.exports.findQualityTransitionRun = findQualityTransitionRun;
module.exports.labelsFingerprint = labelsFingerprint;
module.exports.listQualityWorkflowRuns = listQualityWorkflowRuns;
module.exports.pullIdentity = pullIdentity;
module.exports.qualityTransitionDescription = qualityTransitionDescription;
module.exports.runMatchesPull = runMatchesPull;
module.exports.trustedWorkflowBlobAuthorizations =
  TRUSTED_WORKFLOW_BLOB_AUTHORIZATIONS;
module.exports.trustedCoverageAssetAuthorizations =
  TRUSTED_COVERAGE_ASSET_AUTHORIZATIONS;
