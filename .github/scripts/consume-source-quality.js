"use strict";

const { isDeepStrictEqual } = require("node:util");
const {
  captureSource, captureFullSource, captureCurrentSelection, resolveHistoricalController,
} = require("./source-quality.js");
const {
  QUALITY_EVENTS, QualityEvidenceError, createQualityManifest, assertFullQualityManifest,
  sourceCaptureAttempt, createReuseReference, evaluateCurrentSelection, evaluateQualityCandidate,
} = require("./pr-source-snapshot.js");
const {
  verifyQualityManifest, verifyHistoricalQualityManifest, readQualityArtifact,
} = require("./quality-attestation.js");

// options identifies an independently trusted signer checkout, never identity
// copied from the artifact. This consumer cannot publish required statuses.
async function consumeSourceQuality({ options, artifactId, content }, {
  git,
  verify = verifyQualityManifest,
} = {}) {
  if (
    !Number.isSafeInteger(artifactId) || artifactId < 1 ||
    typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024
  ) {
    throw new Error("Invalid shadow quality artifact input");
  }
  const { github, context } = options;
  const source = await captureSource(options, git);
  const run = source.run;
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("Shadow quality run is not successfully completed");
  }
  const [{ data: repository }, { data: artifact }] = await Promise.all([
    github.rest.repos.get(context.repo),
    github.rest.actions.getArtifact({ ...context.repo, artifact_id: artifactId }),
  ]);
  if (
    repository.full_name !== run.repository ||
    !Number.isSafeInteger(repository.id) || repository.id < 1 ||
    artifact.id !== artifactId || artifact.expired !== false ||
    artifact.name !== `quality-manifest-${run.runId}-${run.attempt}` ||
    artifact.workflow_run?.id !== run.runId ||
    artifact.workflow_run?.repository_id !== repository.id ||
    artifact.workflow_run?.head_sha !== run.headSha
  ) {
    throw new Error("Native artifact does not identify the expected shadow run");
  }
  const signature = verify({
    content,
    expected: {
      repository: run.repository,
      repositoryId: repository.id,
      runId: run.runId,
      attempt: run.attempt,
      event: run.event,
      validator: source.validator,
    },
  });
  const document = JSON.parse(content);
  if (document?.purpose !== "shadow-source-policy") {
    throw new Error("Signed manifest is not a shadow source-policy proof");
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: run.runId, filter: "all", per_page: 100,
  });
  const captureAttempt = sourceCaptureAttempt(jobs);
  // A partial rerun may retain tests only when its actual source capture is
  // not newer. Reconstruct selection from native jobs, not signed job claims.
  const reconstructed = createQualityManifest({
    source: { ...source, run: { ...run, attempt: captureAttempt } },
    run,
    jobs,
  });
  const proof = { artifactId, content };
  const result = evaluateQualityCandidate({
    snapshot: source.sourceSnapshot,
    checkoutProof: proof,
    selectedResults: source.suites.map(({ suiteId }) => ({ ...proof, suiteId })),
    authenticatedRunArtifactFacts: {
      run,
      checkout: source.checkout,
      artifacts: [{
        artifactId,
        contentSha256: signature.contentSha256,
        validator: source.validator,
        run,
        checkout: source.checkout,
        jobs: reconstructed.suites.map((suite) => jobs.find((job) => job.id === suite.jobId)),
      }],
    },
    trustedValidatorPolicy: source,
  });
  if (!result.candidateMatch) {
    throw new Error(`Authenticated shadow quality rejected: ${result.reasonCodes.join(",")}`);
  }
  const current = await captureSource(options, git);
  if (
    JSON.stringify(current.sourceSnapshot) !== JSON.stringify(source.sourceSnapshot) ||
    JSON.stringify(current.checkout) !== JSON.stringify(source.checkout) ||
    JSON.stringify(current.validator) !== JSON.stringify(source.validator) ||
    JSON.stringify(current.run) !== JSON.stringify(run)
  ) {
    throw new Error("Source or execution changed during shadow verification");
  }
  return Object.freeze({
    ...result,
    purpose: "shadow-source-policy",
    authoritative: false,
    artifactId,
    runId: run.runId,
    attempt: run.attempt,
  });
}

async function authenticateOriginalManifest({
  options, approvedValidator, artifactId, runId, attempt, content,
}, { verify = verifyHistoricalQualityManifest } = {}) {
  if (
    !Number.isSafeInteger(artifactId) || artifactId < 1 ||
    !Number.isSafeInteger(runId) || runId < 1 ||
    !Number.isSafeInteger(attempt) || attempt < 1 ||
    typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024
  ) {
    throw new QualityEvidenceError("Invalid original quality artifact input");
  }
  const { github, context } = options;
  const repositoryName = `${context.repo.owner}/${context.repo.repo}`;
  const [{ data: repository }, { data: native }, { data: artifact }] = await Promise.all([
    github.rest.repos.get(context.repo),
    github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId }),
    github.rest.actions.getArtifact({ ...context.repo, artifact_id: artifactId }),
  ]);
  function assertNative(run, metadata) {
    if (
      repository.full_name !== repositoryName || !Number.isSafeInteger(repository.id) || repository.id < 1 ||
      run.id !== runId || run.run_attempt !== attempt ||
      run.repository?.id !== repository.id || run.repository?.full_name !== repositoryName ||
      run.workflow_id !== approvedValidator.workflowId || run.path !== approvedValidator.workflowPath ||
      !QUALITY_EVENTS.includes(run.event) || !/^[0-9a-f]{40}$/.test(run.head_sha) ||
      run.status !== "completed" || run.conclusion !== "success" ||
      metadata.id !== artifactId || metadata.expired !== false ||
      metadata.name !== `quality-manifest-${runId}-${attempt}` ||
      metadata.workflow_run?.id !== runId || metadata.workflow_run?.repository_id !== repository.id ||
      metadata.workflow_run?.head_sha !== run.head_sha
    ) {
      throw new QualityEvidenceError("Original native run or artifact identity mismatch");
    }
  }
  assertNative(native, artifact);
  let validator;
  const signature = await verify({
    content,
    expected: {
      repository: repositoryName, repositoryId: repository.id, runId, attempt,
      event: native.event, validator: { workflowPath: approvedValidator.workflowPath },
    },
    approveController: async (certificate) => {
      validator = await resolveHistoricalController({
        github, repo: context.repo, validator: approvedValidator, certificate,
      });
      return true;
    },
  });
  const manifest = JSON.parse(content);
  assertFullQualityManifest(manifest);
  if (
    !validator || manifest.sourceSnapshot.repository !== repositoryName ||
    Object.entries(validator).some(([key, value]) => manifest.validator[key] !== value) ||
    manifest.run.repository !== repositoryName || manifest.run.runId !== runId ||
    manifest.run.attempt !== attempt || manifest.run.event !== native.event ||
    manifest.run.headSha !== native.head_sha ||
    (native.event === "pull_request_target" && native.pull_requests != null &&
      (!Array.isArray(native.pull_requests) ||
        (native.pull_requests.length > 0 &&
          !native.pull_requests.some((pull) => pull.number === manifest.sourceSnapshot.number))))
  ) {
    throw new QualityEvidenceError("Signed original manifest does not bind approved native control");
  }
  const [{ data: merge }, jobs] = await Promise.all([
    github.rest.git.getCommit({ ...context.repo, commit_sha: manifest.checkout.commitSha }),
    github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...context.repo, run_id: runId, filter: "all", per_page: 100,
    }),
  ]);
  if (
    merge.sha !== manifest.checkout.commitSha || merge.tree?.sha !== manifest.checkout.treeSha ||
    JSON.stringify(merge.parents?.map((parent) => parent.sha)) !== JSON.stringify(manifest.checkout.parents)
  ) {
    throw new QualityEvidenceError("Original checkout does not match its immutable native merge");
  }
  const [{ data: finalRun }, { data: finalArtifact }] = await Promise.all([
    github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId }),
    github.rest.actions.getArtifact({ ...context.repo, artifact_id: artifactId }),
  ]);
  assertNative(finalRun, finalArtifact);
  if (finalRun.event !== native.event || finalRun.head_sha !== native.head_sha) {
    throw new QualityEvidenceError("Original execution changed during verification");
  }
  return Object.freeze({
    artifactId, contentSha256: signature.contentSha256, manifest, jobs,
    run: {
      repository: repositoryName, runId, attempt, event: native.event, headSha: native.head_sha,
      controlSha: validator.executingCommitSha, workflowId: native.workflow_id,
      workflowPath: native.path, status: native.status, conclusion: native.conclusion,
    },
  });
}

async function consumeFullSourceQuality({
  options, artifactId, content, executionProfiles,
}, { git, verify = verifyHistoricalQualityManifest, readArtifact } = {}) {
  const control = await captureFullSource(options, git);
  const proof = await authenticateOriginalManifest({
    options, approvedValidator: control.validator, artifactId, content,
    runId: control.run.runId, attempt: control.run.attempt,
  }, { verify });
  const profiles = executionProfiles ?? proof.manifest.executionProfiles;
  const source = await captureCurrentSelection(options, profiles, git);
  const reusedResults = await authenticateReuseReferences({
    options, source, references: proof.manifest.results.filter((result) => result.evidence.kind === "REUSED"),
  }, { verify, readArtifact });
  const result = evaluateCurrentSelection({ source, proof, reusedResults });
  const current = await captureCurrentSelection(options, profiles, git);
  if (JSON.stringify(current) !== JSON.stringify(source)) {
    throw new Error("Source, selection or execution changed during full-quality verification");
  }
  return Object.freeze({
    ...result, purpose: "full-source-quality", authoritative: false,
    artifactId, runId: source.run.runId, attempt: source.run.attempt,
  });
}

async function authenticateReuseReferences({ options, source, references }, {
  verify = verifyHistoricalQualityManifest,
  readArtifact = (reference) => readQualityArtifact({
    repository: source.run.repository, artifactId: reference.artifactId,
  }),
} = {}) {
  if (!Array.isArray(references) || new Set(references.map((result) => result?.suiteId)).size !== references.length) {
    throw new QualityEvidenceError("Original-result references are missing or duplicated");
  }
  const originals = new Map();
  const reusedResults = [];
  for (const result of references) {
    const suite = source.suites.find((suite) => suite.suiteId === result?.suiteId &&
      suite.reuseAllowed && suite.inputClosureSha256 === result.inputClosureSha256);
    if (!suite || result.evidence?.kind !== "REUSED" || result.evidence.repository !== source.run.repository) {
      throw new QualityEvidenceError("Reuse reference is not eligible under the current selection");
    }
    const reference = result.evidence;
    const key = `${reference.artifactId}|${reference.runId}|${reference.attempt}|${reference.contentSha256}`;
    if (!originals.has(key)) {
      const originalContent = await readArtifact(reference);
      const original = await authenticateOriginalManifest({
        options, approvedValidator: source.validator,
        artifactId: reference.artifactId, runId: reference.runId,
        attempt: reference.attempt, content: originalContent,
      }, { verify });
      if (original.contentSha256 !== reference.contentSha256) {
        throw new QualityEvidenceError("Original artifact content differs from the signed reuse reference");
      }
      originals.set(key, original);
    }
    const original = originals.get(key);
    if (!isDeepStrictEqual(createReuseReference({ original, suite, validator: source.validator }), reference)) {
      throw new QualityEvidenceError("Reuse reference does not preserve its original native execution");
    }
    reusedResults.push({ suiteId: result.suiteId, original });
  }
  return reusedResults;
}

module.exports = {
  consumeSourceQuality, authenticateOriginalManifest, authenticateReuseReferences, consumeFullSourceQuality,
};
