"use strict";

const { captureSource } = require("./source-quality.js");
const { createQualityManifest, evaluateQualityCandidate } = require("./pr-source-snapshot.js");
const { verifyQualityManifest } = require("./quality-attestation.js");

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
  const captures = jobs.filter((job) => job.name === "source");
  const captureAttempt = captures.reduce((latest, job) => Math.max(latest, job.run_attempt), 0);
  const latestCaptures = captures.filter((job) => job.run_attempt === captureAttempt);
  if (
    latestCaptures.length !== 1 ||
    latestCaptures[0].status !== "completed" ||
    latestCaptures[0].conclusion !== "success"
  ) {
    throw new Error("Native source capture is missing, ambiguous or unsuccessful");
  }
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

module.exports = { consumeSourceQuality };
