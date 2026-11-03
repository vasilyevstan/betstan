"use strict";

const crypto = require("node:crypto");

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const QUALITY_EVENTS = Object.freeze(["pull_request_target", "workflow_dispatch"]);
const SNAPSHOT_FIELDS = [
  "repository", "number", "headRepository", "headRef",
  "headSha", "baseRef", "baseSha", "mergeSha",
];
const VALIDATOR_FIELDS = [
  "workflowId", "workflowPath", "executingCommitSha", "executingRef",
  "workflowBlobSha", "executableClosureSha256",
];
const VALIDATOR_INPUT_FIELDS = VALIDATOR_FIELDS.filter((field) =>
  !["executingCommitSha", "executingRef"].includes(field),
);

function sourceSnapshot(pull) {
  if (!pull || pull.state !== "open" || pull.mergeable !== true) {
    throw new Error("Source snapshot requires an open, mergeable pull request");
  }

  const snapshot = {
    repository: pull.base?.repo?.full_name,
    number: pull.number,
    headRepository: pull.head?.repo?.full_name,
    headRef: pull.head?.ref,
    headSha: pull.head?.sha,
    baseRef: pull.base?.ref,
    baseSha: pull.base?.sha,
    mergeSha: pull.merge_commit_sha,
  };
  const error = snapshotError(snapshot);
  if (error) throw new Error(error);
  return Object.freeze(snapshot);
}

function snapshotError(snapshot) {
  if (!isRecord(snapshot)) return "Source snapshot is missing";
  if (!Number.isSafeInteger(snapshot.number) || snapshot.number < 1) {
    return "Source snapshot has an invalid pull request number";
  }
  for (const field of ["repository", "headRepository"]) {
    if (
      typeof snapshot[field] !== "string" ||
      !REPOSITORY_PATTERN.test(snapshot[field])
    ) {
      return `Source snapshot has an invalid ${field}`;
    }
  }
  for (const field of ["headRef", "baseRef"]) {
    if (
      typeof snapshot[field] !== "string" ||
      snapshot[field].length === 0 ||
      /[\u0000-\u0020\u007f]/.test(snapshot[field])
    ) {
      return `Source snapshot has an invalid ${field}`;
    }
  }
  for (const field of ["headSha", "baseSha", "mergeSha"]) {
    if (
      typeof snapshot[field] !== "string" ||
      !COMMIT_PATTERN.test(snapshot[field])
    ) {
      return `Source snapshot has an invalid ${field}`;
    }
  }
  if (
    snapshot.mergeSha === snapshot.headSha ||
    snapshot.mergeSha === snapshot.baseSha
  ) {
    return "Source snapshot requires a distinct merge commit";
  }
  return null;
}

function digest(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameFields(actual, expected, fields) {
  return isRecord(actual) && isRecord(expected) &&
    fields.every((field) =>
      actual[field] !== undefined && actual[field] === expected[field],
    );
}

function validSnapshot(snapshot) {
  return snapshotError(snapshot) === null;
}

function validValidator(validator) {
  return isRecord(validator) &&
    Number.isSafeInteger(validator.workflowId) && validator.workflowId > 0 &&
    typeof validator.workflowPath === "string" &&
    /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(validator.workflowPath) &&
    typeof validator.executingCommitSha === "string" &&
    COMMIT_PATTERN.test(validator.executingCommitSha) &&
    ["refs/heads/dev", "refs/heads/master"].includes(validator.executingRef) &&
    typeof validator.workflowBlobSha === "string" &&
    COMMIT_PATTERN.test(validator.workflowBlobSha) &&
    typeof validator.executableClosureSha256 === "string" &&
    DIGEST_PATTERN.test(validator.executableClosureSha256);
}

function sameRun(actual, expected) {
  return sameFields(actual, expected, ["repository", "runId", "attempt", "event", "headSha"]);
}

function validRunIdentity(run, repository, validator) {
  return isRecord(run) && run.repository === repository &&
    Number.isSafeInteger(run.runId) && run.runId > 0 &&
    Number.isSafeInteger(run.attempt) && run.attempt > 0 &&
    run.workflowId === validator.workflowId &&
    run.workflowPath === validator.workflowPath &&
    typeof run.headSha === "string" && COMMIT_PATTERN.test(run.headSha) &&
    run.controlSha === validator.executingCommitSha &&
    QUALITY_EVENTS.includes(run.event);
}

function completedRun(run, repository, validator) {
  return validRunIdentity(run, repository, validator) &&
    run.status === "completed" && run.conclusion === "success";
}

function checkoutMatchesSnapshot(checkout, snapshot) {
  return isRecord(checkout) && checkout.commitSha === snapshot.mergeSha &&
    typeof checkout.treeSha === "string" && COMMIT_PATTERN.test(checkout.treeSha) &&
    Array.isArray(checkout.parents) && checkout.parents.length === 2 &&
    checkout.parents[0] === snapshot.baseSha && checkout.parents[1] === snapshot.headSha;
}

function invalidPolicy(policy) {
  return !isRecord(policy) || !validValidator(policy.validator) ||
    typeof policy.inputClosureSha256 !== "string" ||
    !DIGEST_PATTERN.test(policy.inputClosureSha256) ||
    !Array.isArray(policy.suites) ||
    policy.suites.some((suite) =>
      !isRecord(suite) || typeof suite.suiteId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(suite.suiteId) ||
      typeof suite.jobName !== "string" || suite.jobName.length === 0 ||
      typeof suite.inputClosureSha256 !== "string" ||
      !DIGEST_PATTERN.test(suite.inputClosureSha256),
    ) ||
    new Set(policy.suites.map((suite) => suite.suiteId)).size !== policy.suites.length ||
    new Set(policy.suites.map((suite) => suite.jobName)).size !== policy.suites.length ||
    (policy.suites.length === 0 && policy.noWork !== true);
}

function createQualityManifest({ source, run, jobs }) {
  if (
    invalidPolicy(source) || !validSnapshot(source.sourceSnapshot) ||
    !checkoutMatchesSnapshot(source.checkout, source.sourceSnapshot) ||
    !validRunIdentity(run, source.sourceSnapshot.repository, source.validator) ||
    !["in_progress", "completed"].includes(run.status) ||
    (run.status === "completed" && run.conclusion !== "success") ||
    !isRecord(source.run) || source.run.repository !== run.repository ||
    source.run.runId !== run.runId ||
    source.run.event !== run.event ||
    !Number.isSafeInteger(source.run.attempt) || source.run.attempt < 1 ||
    source.run.attempt > run.attempt ||
    !Array.isArray(jobs) || jobs.some((job) =>
      !isRecord(job) || !Number.isSafeInteger(job.id) || job.id < 1 ||
      job.run_id !== run.runId || job.head_sha !== run.headSha ||
      !Number.isSafeInteger(job.run_attempt) ||
      job.run_attempt < 1 || job.run_attempt > run.attempt
    ) ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length
  ) {
    throw new Error("Invalid trusted quality source or execution");
  }
  const suites = source.suites.map((suite) => {
    const matches = jobs.filter((job) => job.name === suite.jobName);
    const latestAttempt = matches.reduce((latest, job) => Math.max(latest, job.run_attempt), 0);
    const latest = matches.filter((job) => job.run_attempt === latestAttempt);
    const job = latest.length === 1 ? latest[0] : null;
    if (
      !job || job.run_attempt < source.run.attempt ||
      job.status !== "completed" || job.conclusion !== "success"
    ) {
      throw new Error(`Missing, ambiguous or unsuccessful selected job: ${suite.suiteId}`);
    }
    return {
      suiteId: suite.suiteId,
      jobId: job.id,
      jobName: job.name,
      executionAttempt: job.run_attempt,
      inputClosureSha256: suite.inputClosureSha256,
      conclusion: job.conclusion,
    };
  });
  return {
    schemaVersion: 1,
    sourceSnapshot: structuredClone(source.sourceSnapshot),
    checkout: structuredClone(source.checkout),
    validator: structuredClone(source.validator),
    run: {
      repository: run.repository, runId: run.runId, attempt: run.attempt,
      event: run.event, headSha: run.headSha,
    },
    inputClosureSha256: source.inputClosureSha256,
    expectedSuiteIds: source.suites.map((suite) => suite.suiteId),
    noWork: source.noWork === true,
    suites,
  };
}

// The caller authenticates whole manifests and native jobs. Suite references
// select members of those manifests; they cannot replace their signed headers.
function evaluateQualityCandidate({
  snapshot,
  checkoutProof,
  selectedResults,
  authenticatedRunArtifactFacts,
  trustedValidatorPolicy,
}) {
  const result = {
    snapshotKey: validSnapshot(snapshot)
      ? digest(JSON.stringify(SNAPSHOT_FIELDS.map((field) => snapshot[field])))
      : null,
    proofDigestOrNull: null,
    candidateMatch: false,
    reasonCodes: [],
  };
  const reject = (reason) => ({ ...result, reasonCodes: [reason] });
  if (!result.snapshotKey) return reject("INVALID_SOURCE_SNAPSHOT");
  const policy = trustedValidatorPolicy;
  if (invalidPolicy(policy)) {
    return reject("INVALID_TRUSTED_POLICY");
  }
  const facts = authenticatedRunArtifactFacts;
  if (
    !isRecord(facts) ||
    !completedRun(facts.run, snapshot.repository, policy.validator) ||
    !checkoutMatchesSnapshot(facts.checkout, snapshot) ||
    !Array.isArray(facts.artifacts) ||
    facts.artifacts.some((artifact) =>
      !isRecord(artifact) ||
      !Number.isSafeInteger(artifact.artifactId) || artifact.artifactId < 1 ||
      typeof artifact.contentSha256 !== "string" ||
      !DIGEST_PATTERN.test(artifact.contentSha256) ||
      !validValidator(artifact.validator) ||
      !completedRun(artifact.run, snapshot.repository, artifact.validator) ||
      !sameFields(artifact.validator, policy.validator, VALIDATOR_INPUT_FIELDS) ||
      !isRecord(artifact.checkout) ||
      typeof artifact.checkout.commitSha !== "string" ||
      !COMMIT_PATTERN.test(artifact.checkout.commitSha) ||
      typeof artifact.checkout.treeSha !== "string" ||
      !COMMIT_PATTERN.test(artifact.checkout.treeSha) ||
      !Array.isArray(artifact.jobs) ||
      artifact.jobs.some((job) => !isRecord(job)) ||
      new Set(artifact.jobs.map((job) => job.id)).size !== artifact.jobs.length,
    ) ||
    new Set(facts.artifacts.map((artifact) => artifact.artifactId)).size !== facts.artifacts.length
  ) {
    return reject("INVALID_AUTHENTICATED_FACTS");
  }

  function readArtifact(artifact) {
    if (
      !isRecord(artifact) || typeof artifact.content !== "string" ||
      !Number.isSafeInteger(artifact.artifactId)
    ) return null;
    const binding = facts.artifacts.find((item) =>
      item.artifactId === artifact.artifactId &&
      item.contentSha256 === digest(artifact.content),
    );
    if (!binding) return null;
    let document;
    try {
      document = JSON.parse(artifact.content);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return null;
    }
    if (
      !isRecord(document) || document.schemaVersion !== 1 ||
      !sameRun(document.run, binding.run) ||
      !sameFields(document.validator, binding.validator, VALIDATOR_FIELDS) ||
      !validSnapshot(document.sourceSnapshot) ||
      document.sourceSnapshot.repository !== snapshot.repository ||
      !checkoutMatchesSnapshot(binding.checkout, document.sourceSnapshot) ||
      !sameFields(document.checkout, binding.checkout, ["commitSha", "treeSha"]) ||
      !Array.isArray(document.expectedSuiteIds) ||
      document.expectedSuiteIds.some((id) => typeof id !== "string") ||
      new Set(document.expectedSuiteIds).size !== document.expectedSuiteIds.length ||
      !Array.isArray(document.suites) ||
      document.suites.some((suite) =>
        !isRecord(suite) || !document.expectedSuiteIds.includes(suite.suiteId),
      ) ||
      new Set(document.suites.map((suite) => suite.suiteId)).size !== document.suites.length
    ) return null;
    return { document, binding };
  }

  const proofArtifact = readArtifact(checkoutProof);
  if (!proofArtifact) return reject("MISSING_OR_UNBOUND_CHECKOUT_PROOF");
  const proof = proofArtifact.document;
  if (
    !sameRun(proof.run, facts.run) ||
    !sameFields(proof.sourceSnapshot, snapshot, SNAPSHOT_FIELDS) ||
    !sameFields(proof.checkout, facts.checkout, ["commitSha", "treeSha"]) ||
    proof.inputClosureSha256 !== policy.inputClosureSha256
  ) return reject("CHECKOUT_PROOF_MISMATCH");
  const expectedSuiteIds = policy.suites.map((suite) => suite.suiteId).sort();
  if (
    !Array.isArray(proof.expectedSuiteIds) ||
    proof.expectedSuiteIds.some((id) => typeof id !== "string") ||
    JSON.stringify([...proof.expectedSuiteIds].sort()) !== JSON.stringify(expectedSuiteIds) ||
    (expectedSuiteIds.length === 0 && proof.noWork !== true)
  ) return reject("SUITE_SELECTION_MISMATCH");
  if (
    !Array.isArray(selectedResults) ||
    selectedResults.length !== expectedSuiteIds.length ||
    new Set(selectedResults.map((item) => item?.suiteId)).size !== selectedResults.length
  ) return reject("MISSING_OR_DUPLICATED_RESULTS");

  const seen = new Set();
  for (const artifact of selectedResults) {
    const authenticated = readArtifact(artifact);
    const evidence = authenticated?.document.suites.find((suite) => suite.suiteId === artifact.suiteId);
    const expected = policy.suites.find((suite) => suite.suiteId === evidence?.suiteId);
    const jobs = authenticated?.binding.jobs.filter((job) => job.name === expected?.jobName);
    const job = jobs?.length === 1 ? jobs[0] : null;
    if (
      !evidence || !expected || seen.has(evidence.suiteId) ||
      evidence.conclusion !== "success" ||
      evidence.inputClosureSha256 !== expected.inputClosureSha256 ||
      !job || !Number.isSafeInteger(job.id) || job.id < 1 ||
      evidence.jobId !== job.id || evidence.jobName !== expected.jobName ||
      !Number.isSafeInteger(evidence.executionAttempt) || evidence.executionAttempt < 1 ||
      evidence.executionAttempt > authenticated.document.run.attempt ||
      job.run_id !== authenticated.document.run.runId ||
      job.run_attempt !== evidence.executionAttempt ||
      job.head_sha !== authenticated.binding.run.headSha ||
      job.status !== "completed" || job.conclusion !== "success"
    ) return reject("INVALID_SUITE_RESULT");
    seen.add(evidence.suiteId);
  }
  return {
    ...result,
    proofDigestOrNull: digest(checkoutProof.content),
    candidateMatch: true,
  };
}

module.exports = { QUALITY_EVENTS, sourceSnapshot, createQualityManifest, evaluateQualityCandidate };
