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

async function nativeDispatchPolicy(options) {
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const { dispatchCommit, dispatchControl, DISPATCH_CONTROL_PATHS, DISPATCH_CALLER_BLOBS } = require("./source-quality.js");
  const { github, context } = options;
  const { data: branch } = await github.rest.repos.getBranch({ ...context.repo, branch: "master" });
  if (branch?.protected !== true) throw new QualityEvidenceError("Dispatch approval is not protected master");
  let approvalSha = branch.commit?.sha;
  if (context.eventName === "push") {
    const before = context.payload.before;
    if (context.ref !== "refs/heads/master" || branch.commit?.sha !== context.sha ||
      context.payload.after !== context.sha || context.payload.forced !== false ||
      !/^[0-9a-f]{40}$/.test(before ?? "") || /^0+$/.test(before) ||
      (await dispatchCommit(github, context.repo, context.sha)).parents[0] !== before) {
      throw new QualityEvidenceError("Dispatch approval is not the platform push-before protected predecessor");
    }
    approvalSha = before;
  }
  const approved = await dispatchControl(github, context.repo, approvalSha);
  const records = approved.records.filter((record) => DISPATCH_CONTROL_PATHS.includes(record.path));
  // The verifier runs from the pre-candidate protected checkout. Refuse a stale
  // or substituted copy instead of treating candidate JSON as control approval.
  for (const record of records.filter((entry) => entry.path.startsWith(".github/scripts/"))) {
    const bytes = fs.readFileSync(path.join(__dirname, path.basename(record.path)));
    const actual = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== record.sha) throw new QualityEvidenceError("Executing dispatch verifier differs from protected approval");
  }
  const { data: workflow } = await github.rest.actions.getWorkflow({
    ...context.repo, workflow_id: "oci-validate.yml",
  });
  if (workflow?.path !== ".github/workflows/oci-validate.yml" || workflow.state !== "active" ||
    !Number.isSafeInteger(workflow.id) || workflow.id < 1) {
    throw new QualityEvidenceError("Native dispatch producer workflow is unavailable");
  }
  return { sha: approved.commit.sha, records, workflowId: workflow.id, callers: DISPATCH_CALLER_BLOBS };
}

async function authenticateNativeDispatchOriginal({
  options, current, profile, policy, runId, artifactId, content,
}, { verify = require("./quality-attestation.js").verifyNativeDispatchManifest } = {}) {
  const {
    DISPATCH_WORKFLOW, DISPATCH_CONTROL_PATHS, dispatchControl, assertDispatchProfile, assertDispatchJobs,
    nativeDispatchAssociationsMatch,
  } = require("./source-quality.js");
  const { github, context } = options;
  if (!Number.isSafeInteger(runId) || runId < 1 || runId === current.runId ||
    !Number.isSafeInteger(artifactId) || artifactId < 1 || typeof content !== "string" ||
    Buffer.byteLength(content) > 1024 * 1024) {
    throw new QualityEvidenceError("Invalid or self-referential native dispatch original");
  }
  assertDispatchProfile(profile);
  const fetchNative = async () => {
    const [{ data: run }, { data: artifact }] = await Promise.all([
      github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId }),
      github.rest.actions.getArtifact({ ...context.repo, artifact_id: artifactId }),
    ]);
    if (run?.id !== runId || run.run_attempt !== 1 || run.workflow_id !== policy.workflowId ||
      run.path !== DISPATCH_WORKFLOW || run.event !== "pull_request" ||
      run.repository?.id !== current.repositoryId || run.repository?.full_name !== current.repository ||
      run.status !== "completed" || run.conclusion !== "success" ||
      !/^[0-9a-f]{40}$/.test(run.head_sha ?? "") ||
      artifact?.id !== artifactId || artifact.name !== `dispatch-original-${runId}-1` ||
      artifact.expired !== false || artifact.workflow_run?.id !== runId ||
      artifact.workflow_run?.repository_id !== current.repositoryId ||
      artifact.workflow_run?.head_sha !== run.head_sha) {
      throw new QualityEvidenceError("Original native dispatch run/artifact is unsigned, stale, retried or unsuccessful");
    }
    return { run, artifact };
  };
  const native = await fetchNative();
  const certificate = await verify({
    content,
    expected: {
      repository: current.repository, repositoryId: current.repositoryId, runId, attempt: 1,
      event: "pull_request", validator: { workflowPath: DISPATCH_WORKFLOW },
    },
  });
  // Fetch ACTUAL certified control; hashes claimed in the signed document are
  // not executable approval. The strict inline certificate shape is deliberate.
  if (certificate.signerSha !== certificate.sourceSha || certificate.callerSha !== certificate.sourceSha) {
    throw new QualityEvidenceError("Unsupported native inline signer/caller/source relationship");
  }
  const actual = await dispatchControl(github, context.repo, certificate.sourceSha);
  const helpers = actual.records.filter((record) => DISPATCH_CONTROL_PATHS.includes(record.path));
  const workflow = actual.records.find((record) => record.path === DISPATCH_WORKFLOW);
  // The observational caller remains ineligible even after its helpers land.
  if (!isDeepStrictEqual(helpers, policy.records) || workflow.sha !== policy.callers[DISPATCH_WORKFLOW]?.at(-1)) {
    throw new QualityEvidenceError("Certified dispatch workflow or executed helper closure is not independently approved");
  }
  const manifest = JSON.parse(content);
  const source = manifest?.source;
  if (manifest?.schemaVersion !== 1 || manifest.purpose !== "native-dispatch-original" ||
    manifest.suiteId !== "cli-dispatch" || manifest.execution?.kind !== "EXECUTED" ||
    !source || source.repository !== current.repository || source.repositoryId !== current.repositoryId ||
    source.runId !== runId || source.attempt !== 1 || source.workflowId !== policy.workflowId ||
    source.workflowPath !== DISPATCH_WORKFLOW || source.event !== "pull_request" ||
    source.headSha !== native.run.head_sha || !isDeepStrictEqual(source.commit, actual.commit) ||
    source.ref !== certificate.sourceRef || source.ref !== `refs/pull/${source.snapshot?.number}/merge` ||
    !Number.isSafeInteger(source.snapshot?.number) || source.snapshot.number < 1 ||
    source.snapshot?.repository !== current.repository || !["dev", "master"].includes(source.snapshot?.baseRef) ||
    source.snapshot?.mergeSha !== certificate.sourceSha || source.snapshot?.headSha !== native.run.head_sha ||
    !nativeDispatchAssociationsMatch(native.run.pull_requests, source.snapshot, current.repositoryId) ||
    !isDeepStrictEqual(actual.commit.parents, [source.snapshot?.baseSha, native.run.head_sha]) ||
    actual.commit.treeSha !== current.commit.treeSha || !isDeepStrictEqual(profile, manifest.profile)) {
    throw new QualityEvidenceError("Dispatch original does not bind the exact tested tree, PR merge or execution profile");
  }
  assertDispatchProfile(manifest.profile);
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: runId, filter: "all", per_page: 100,
  });
  if (!isDeepStrictEqual(assertDispatchJobs(jobs, source), manifest.execution)) {
    throw new QualityEvidenceError("Dispatch original does not identify actual complete native execution");
  }
  const final = await fetchNative();
  if (!isDeepStrictEqual(native, final)) throw new QualityEvidenceError("Original dispatch evidence changed during authentication");
  return {
    kind: "REUSED", suiteId: "cli-dispatch", repository: current.repository,
    runId, attempt: 1, artifactId, contentSha256: certificate.contentSha256,
    originalCommitSha: actual.commit.sha, testedTreeSha: actual.commit.treeSha,
  };
}

async function selectNativeDispatchOriginal(options, profile, {
  git, verify, policy: readPolicy = nativeDispatchPolicy,
  readArtifact = (reference) => readQualityArtifact({
    repository: `${options.context.repo.owner}/${options.context.repo.repo}`, artifactId: reference.artifactId,
  }),
  onMiss = (reason) => console.warn(`Dispatch proof unavailable: ${reason}; ordinary computation required`),
} = {}) {
  const {
    captureNativeDispatchSource, dispatchControl, DISPATCH_CONTROL_PATHS, assertDispatchProfile,
  } = require("./source-quality.js");
  const misses = [];
  const miss = (error) => {
    if (!(error instanceof QualityEvidenceError) && !(error instanceof SyntaxError) &&
      ![403, 404, 410, 429, 500, 502, 503, 504].includes(error?.status)) throw error;
    const reason = error instanceof SyntaxError ? "Malformed original JSON" : error.message;
    misses.push(reason);
    onMiss(reason);
  };
  try {
    assertDispatchProfile(profile);
    const current = await captureNativeDispatchSource(options, git);
    const policy = await readPolicy(options);
    const control = await dispatchControl(options.github, options.context.repo, current.commit.sha);
    const helpers = control.records.filter((record) => DISPATCH_CONTROL_PATHS.includes(record.path));
    const caller = control.records.find((record) => record.path === current.workflowPath);
    if (!isDeepStrictEqual(helpers, policy.records) || !policy.callers[current.workflowPath]?.includes(caller.sha)) {
      throw new QualityEvidenceError("Current caller/control is not approved for native dispatch reuse");
    }
    const { data: recent } = await options.github.rest.actions.listWorkflowRuns({
      ...options.context.repo, workflow_id: policy.workflowId, status: "success", per_page: 5, page: 1,
    });
    if (!Array.isArray(recent?.workflow_runs) || recent.workflow_runs.length > 5) {
      throw new QualityEvidenceError("Invalid bounded native original discovery");
    }
    for (const run of recent.workflow_runs) {
      try {
        if (!run || run.id === current.runId || run.run_attempt !== 1 || run.event !== "pull_request" ||
          run.workflow_id !== policy.workflowId) {
          throw new QualityEvidenceError("Self, retry or unsupported original candidate");
        }
        const { data: inventory } = await options.github.rest.actions.listWorkflowRunArtifacts({
          ...options.context.repo, run_id: run.id, per_page: 100, page: 1,
        });
        if (!Array.isArray(inventory?.artifacts) || inventory.total_count !== inventory.artifacts.length ||
          inventory.total_count > 100) throw new QualityEvidenceError("Incomplete original artifact inventory");
        const matches = inventory.artifacts.filter((artifact) =>
          artifact?.name === `dispatch-original-${run.id}-1` && artifact.expired === false);
        if (matches.length !== 1) throw new QualityEvidenceError("No unique published original; reused/selected-out jobs cannot seed proof");
        const reference = { runId: run.id, artifactId: matches[0].id };
        const original = await authenticateNativeDispatchOriginal({
          options, current, profile, policy, ...reference, content: await readArtifact(reference),
        }, { verify });
        const final = await captureNativeDispatchSource(options, git);
        const finalPolicy = await readPolicy(options);
        if (!isDeepStrictEqual(final, current) || !isDeepStrictEqual(finalPolicy, policy)) {
          throw new QualityEvidenceError("Current dispatch source or protected approval changed before acceptance");
        }
        return original;
      } catch (error) {
        miss(error);
      }
    }
    if (misses.length === 0) miss(new QualityEvidenceError("No authenticated native originals exist"));
  } catch (error) {
    miss(error);
  }
  return { kind: "EXECUTE", suiteId: "cli-dispatch", reasons: misses };
}

module.exports = {
  consumeSourceQuality, authenticateOriginalManifest, authenticateReuseReferences, consumeFullSourceQuality,
  nativeDispatchPolicy, authenticateNativeDispatchOriginal, selectNativeDispatchOriginal,
};
