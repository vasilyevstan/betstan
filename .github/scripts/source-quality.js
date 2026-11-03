"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const { isDeepStrictEqual } = require("node:util");
const { execFileSync } = require("node:child_process");
const {
  QUALITY_EVENTS, QualityEvidenceError, sourceSnapshot, createQualityManifest, createReuseReference,
  createFullQualityManifest, sourceCaptureAttempt,
} = require("./pr-source-snapshot.js");

const WORKFLOW_PATH = ".github/workflows/source-quality.yml";
const CONTROL_PATHS = [
  WORKFLOW_PATH,
  ".github/scripts/source-quality.js",
  ".github/scripts/pr-source-snapshot.js",
];
const FULL_CONTROL_PATHS = Object.freeze([
  ...CONTROL_PATHS,
  ".github/scripts/source-input-selection.js",
  ".github/scripts/quality-attestation.js",
  ".github/scripts/consume-source-quality.js",
  ".github/scripts/source-quality-suite.sh",
]);

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function captureExecutionProfiles(runner = {
  imageVersion: process.env.ImageVersion,
  imageOS: process.env.ImageOS,
  platform: process.platform,
  architecture: process.arch,
  kernel: os.release(),
  nodeVersion: process.version,
  nodeSha256: crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex"),
}) {
  if (runner.nodeVersion !== "v20.19.5") {
    throw new Error("Source quality requires the approved Node 20.19.5 toolchain");
  }
  const resolved = runner.platform === "linux" && runner.architecture === "x64" &&
    runner.imageOS === "ubuntu24" &&
    typeof runner.imageVersion === "string" && /^\d{8}\.\d+\.\d+$/.test(runner.imageVersion) &&
    typeof runner.kernel === "string" && /^[A-Za-z0-9._+-]{1,128}$/.test(runner.kernel) &&
    typeof runner.nodeSha256 === "string" && /^[0-9a-f]{64}$/.test(runner.nodeSha256);
  return Object.fromEntries(["node-policy", "package", "docker", "contracts"].map((name) => {
    const immutable = name === "node-policy" && resolved;
    const identity = immutable
      ? digest(["betstan.resolved-node-policy.v1", runner.imageVersion, runner.imageOS,
        runner.platform, runner.architecture, runner.kernel, runner.nodeVersion, runner.nodeSha256])
      : digest(["betstan.unresolved-profile.v1", name, "ubuntu-24.04", runner.nodeVersion]);
    return [name, { identity, immutable }];
  }));
}

function readGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });
}

async function execution({ github, context, attempt }, git, controlPaths = CONTROL_PATHS) {
  if (
    !QUALITY_EVENTS.includes(context.eventName) ||
    !["refs/heads/dev", "refs/heads/master"].includes(context.ref) ||
    !Number.isSafeInteger(attempt) || attempt < 1 ||
    !/^[0-9a-f]{40}$/.test(context.sha) ||
    git(["rev-parse", "HEAD"]).trim() !== context.sha
  ) {
    throw new Error("Quality control must execute an exact protected source");
  }
  const { data: native } = await github.rest.actions.getWorkflowRun({
    ...context.repo, run_id: context.runId,
  });
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (
    native.id !== context.runId || native.run_attempt !== attempt ||
    native.event !== context.eventName || native.path !== WORKFLOW_PATH ||
    native.repository?.full_name !== repository ||
    !Number.isSafeInteger(native.repository?.id) || native.repository.id < 1 ||
    !Number.isSafeInteger(native.workflow_id) || native.workflow_id < 1 ||
    !/^[0-9a-f]{40}$/.test(native.head_sha)
  ) {
    throw new Error("Native quality execution identity mismatch");
  }
  const records = git(["ls-tree", "-z", "HEAD", "--", ...controlPaths])
    .split("\0").filter(Boolean).map((record) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
      if (!match || !controlPaths.includes(match[3])) {
        throw new Error("Unsupported quality control input");
      }
      return { path: match[3], mode: match[1], blobSha: match[2] };
    }).sort((a, b) => a.path.localeCompare(b.path));
  if (
    records.length !== controlPaths.length ||
    new Set(records.map((record) => record.path)).size !== controlPaths.length
  ) {
    throw new Error("Quality control input closure is incomplete");
  }
  const validator = {
    workflowId: native.workflow_id,
    workflowPath: WORKFLOW_PATH,
    executingCommitSha: context.sha,
    executingRef: context.ref,
    workflowBlobSha: records.find((record) => record.path === WORKFLOW_PATH).blobSha,
    executableClosureSha256: digest(["betstan.source-control.v1", records]),
  };
  // REST head_sha belongs to the triggering event, not the control checkout.
  const run = {
    repository,
    runId: native.id,
    attempt: native.run_attempt,
    event: native.event,
    headSha: native.head_sha,
    controlSha: context.sha,
    workflowId: native.workflow_id,
    workflowPath: native.path,
    status: native.status,
    conclusion: native.conclusion,
  };
  return { native, run, validator };
}

async function captureSource(options, git = readGit, controlPaths = CONTROL_PATHS) {
  const { github, context } = options;
  const { native, run, validator } = await execution(options, git, controlPaths);
  const rawNumber = context.eventName === "workflow_dispatch"
    ? context.payload.inputs?.pr_number : context.payload.pull_request?.number;
  const number = Number(rawNumber);
  if (
    !/^[1-9][0-9]*$/.test(String(rawNumber)) ||
    !Number.isSafeInteger(number) ||
    (context.eventName === "pull_request_target" &&
      !native.pull_requests?.some((pull) => pull.number === number))
  ) {
    throw new Error("Quality execution does not identify a pull request");
  }
  const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  const snapshot = sourceSnapshot(pull);
  if (snapshot.repository !== run.repository || !["dev", "master"].includes(snapshot.baseRef)) {
    throw new Error("Quality source repository or target branch mismatch");
  }
  const { data: merge } = await github.rest.git.getCommit({
    ...context.repo, commit_sha: snapshot.mergeSha,
  });
  const checkout = {
    commitSha: merge.sha,
    treeSha: merge.tree?.sha,
    parents: merge.parents?.map((parent) => parent.sha),
  };
  if (
    checkout.commitSha !== snapshot.mergeSha || !/^[0-9a-f]{40}$/.test(checkout.treeSha) ||
    JSON.stringify(checkout.parents) !== JSON.stringify([snapshot.baseSha, snapshot.headSha])
  ) {
    throw new Error("Native merge object does not match the current source snapshot");
  }
  const inputClosureSha256 = digest([
    "betstan.source-policy-shadow.v1", checkout.treeSha,
    validator.executableClosureSha256, "node:20.19.5", "ubuntu-24.04",
  ]);
  return {
    sourceSnapshot: snapshot,
    checkout,
    validator,
    run,
    inputClosureSha256,
    suites: [{
      suiteId: "source-policy",
      jobName: "quality (source-policy)",
      inputClosureSha256,
    }],
  };
}

function captureFullSource(options, git = readGit) {
  return captureSource(options, git, FULL_CONTROL_PATHS);
}

async function captureCurrentSelection(options, executionProfiles, git = readGit) {
  const { selectSourceInputs } = require("./source-input-selection.js");
  const source = await captureFullSource(options, git);
  const { github, context } = options;
  const { data: base } = await github.rest.git.getCommit({
    ...context.repo, commit_sha: source.sourceSnapshot.baseSha,
  });
  if (base.sha !== source.sourceSnapshot.baseSha || !/^[0-9a-f]{40}$/.test(base.tree?.sha)) {
    throw new Error("Native base commit does not match the current source snapshot");
  }
  async function readTree(treeSha) {
    const { data: tree } = await github.rest.git.getTree({
      ...context.repo, tree_sha: treeSha, recursive: "1",
    });
    if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) {
      throw new Error("Complete immutable Git tree is unavailable");
    }
    const entries = tree.tree.filter((entry) => {
      if (entry?.type === "tree" && entry.mode === "040000") return false;
      if (entry?.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
        throw new Error("Unsupported candidate Git tree entry");
      }
      return true;
    });
    return entries.map(({ path, mode, sha }) => ({ path, mode, blobSha: sha }));
  }
  const [records, baseRecords] = await Promise.all([
    readTree(source.checkout.treeSha),
    readTree(base.tree.sha),
  ]);
  // Validate both complete trees, including deleted dependencies.
  selectSourceInputs({ records: baseRecords, changedPaths: [], executionProfiles });
  const current = new Map(records.map((record) => [record.path, record]));
  const previous = new Map(baseRecords.map((record) => [record.path, record]));
  const changedPaths = [...new Set([...current.keys(), ...previous.keys()])].filter((path) => {
    const before = previous.get(path);
    const after = current.get(path);
    return !before || !after || before.mode !== after.mode || before.blobSha !== after.blobSha;
  }).sort();
  const selection = selectSourceInputs({ records, changedPaths, executionProfiles });
  const fresh = await captureSource(options, git, FULL_CONTROL_PATHS);
  if (
    JSON.stringify(fresh.sourceSnapshot) !== JSON.stringify(source.sourceSnapshot) ||
    JSON.stringify(fresh.validator) !== JSON.stringify(source.validator) ||
    fresh.run.runId !== source.run.runId || fresh.run.attempt !== source.run.attempt ||
    fresh.run.headSha !== source.run.headSha
  ) {
    throw new Error("Source or controller changed during input capture");
  }
  return {
    ...source, ...selection, purpose: "full-source-quality",
    executionProfiles: structuredClone(executionProfiles),
  };
}

async function resolveHistoricalController({ github, repo, validator, certificate }) {
  if (
    certificate.repository !== `${repo.owner}/${repo.repo}` ||
    certificate.workflowPath !== WORKFLOW_PATH || validator.workflowPath !== WORKFLOW_PATH ||
    !/^[0-9a-f]{40}$/.test(certificate.controlSha) ||
    !/^[0-9a-f]{40}$/.test(validator.executingCommitSha) ||
    !["refs/heads/dev", "refs/heads/master"].includes(certificate.sourceRef)
  ) {
    throw new QualityEvidenceError("Historical controller is outside the approved workflow");
  }
  if (certificate.controlSha !== validator.executingCommitSha) {
    const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
      ...repo, basehead: `${certificate.controlSha}...${validator.executingCommitSha}`,
    });
    if (
      !["ahead", "identical"].includes(comparison.status) ||
      comparison.base_commit?.sha !== certificate.controlSha ||
      comparison.merge_base_commit?.sha !== certificate.controlSha
    ) {
      throw new QualityEvidenceError("Historical controller is not an ancestor of approved protected control");
    }
  }
  const { data: commit } = await github.rest.git.getCommit({
    ...repo, commit_sha: certificate.controlSha,
  });
  if (commit.sha !== certificate.controlSha || !/^[0-9a-f]{40}$/.test(commit.tree?.sha)) {
    throw new QualityEvidenceError("Historical controller commit identity mismatch");
  }
  const { data: tree } = await github.rest.git.getTree({
    ...repo, tree_sha: commit.tree.sha, recursive: "1",
  });
  if (tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new QualityEvidenceError("Historical controller closure is incomplete");
  }
  const records = tree.tree.filter((entry) => FULL_CONTROL_PATHS.includes(entry.path)).map((entry) => {
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) ||
      !/^[0-9a-f]{40}$/.test(entry.sha)) {
      throw new QualityEvidenceError("Historical controller has an unsupported input");
    }
    return { path: entry.path, mode: entry.mode, blobSha: entry.sha };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (
    records.length !== FULL_CONTROL_PATHS.length ||
    new Set(records.map((record) => record.path)).size !== FULL_CONTROL_PATHS.length ||
    digest(["betstan.source-control.v1", records]) !== validator.executableClosureSha256 ||
    records.find((record) => record.path === WORKFLOW_PATH).blobSha !== validator.workflowBlobSha
  ) {
    throw new QualityEvidenceError("Historical controller closure differs from independently approved policy");
  }
  return {
    ...validator,
    executingCommitSha: certificate.controlSha,
    executingRef: certificate.sourceRef,
  };
}

async function planFullQuality(options, executionProfiles, {
  git,
  readArtifact,
  verify,
  onReuseMiss = (message) => console.warn(message),
} = {}) {
  const { authenticateOriginalManifest } = require("./consume-source-quality.js");
  const { readQualityArtifact } = require("./quality-attestation.js");
  const source = await captureCurrentSelection(options, executionProfiles, git);
  const read = readArtifact ?? ((reference) => readQualityArtifact({
    repository: source.run.repository, artifactId: reference.artifactId,
  }));
  const reusedResults = [];
  const reuseMisses = [];
  const priority = [
    "source-policy", "azure-contracts", "oci-rollback", "oci-live",
    "oci-provenance", "oci-core", "auth-image",
  ];
  const rank = (suite) => priority.includes(suite.suiteId) ? priority.indexOf(suite.suiteId) : priority.length;
  const finish = () => ({
    ...source, reusedResults, reuseMisses,
    matrix: { include: source.suites.filter((suite) =>
      !reusedResults.some((result) => result.suiteId === suite.suiteId))
      .sort((a, b) => rank(a) - rank(b)) },
  });
  const eligible = source.suites.filter((suite) => suite.reuseAllowed);
  if (eligible.length === 0) return finish();
  const { github, context } = options;
  const { data: recent } = await github.rest.actions.listWorkflowRuns({
    ...context.repo, workflow_id: source.validator.workflowId,
    status: "success", per_page: 5, page: 1,
  });
  if (!Array.isArray(recent.workflow_runs) || recent.workflow_runs.length > 5) {
    throw new Error("Native recent quality execution list is invalid");
  }
  const miss = (runId, reason) => {
    reuseMisses.push({ runId, reason });
    onReuseMiss(`Source-quality reuse miss for run ${runId}: ${reason}; fresh execution remains required`);
  };
  for (const run of recent.workflow_runs) {
    if (run.id === source.run.runId) continue;
    if (eligible.every((suite) => reusedResults.some((result) => result.suiteId === suite.suiteId))) break;
    try {
      if (
        !Number.isSafeInteger(run.id) || run.id < 1 ||
        !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
        run.workflow_id !== source.validator.workflowId || !QUALITY_EVENTS.includes(run.event)
      ) {
        throw new QualityEvidenceError("Recent run does not identify the approved producer");
      }
      const { data: artifacts } = await github.rest.actions.listWorkflowRunArtifacts({
        ...context.repo, run_id: run.id, per_page: 100, page: 1,
      });
      if (
        !Number.isSafeInteger(artifacts.total_count) || artifacts.total_count > 100 ||
        !Array.isArray(artifacts.artifacts) || artifacts.total_count !== artifacts.artifacts.length
      ) {
        throw new QualityEvidenceError("Bounded original artifact inventory is incomplete");
      }
      const matches = artifacts.artifacts.filter((artifact) =>
        artifact.name === `quality-manifest-${run.id}-${run.run_attempt}` && artifact.expired === false);
      if (matches.length !== 1) throw new QualityEvidenceError("Original signed artifact is unavailable or ambiguous");
      const reference = { artifactId: matches[0].id, runId: run.id, attempt: run.run_attempt };
      const content = await read(reference);
      if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) {
        throw new QualityEvidenceError("Original artifact exceeds the manifest boundary");
      }
      const hint = JSON.parse(content);
      if (hint?.schemaVersion !== 2 || hint.purpose !== "full-source-quality" || !Array.isArray(hint.results)) {
        throw new QualityEvidenceError("Artifact is not a full-quality reuse candidate");
      }
      let found = false;
      for (const suite of eligible) {
        if (reusedResults.some((result) => result.suiteId === suite.suiteId)) continue;
        const results = hint.results.filter((result) => result?.suiteId === suite.suiteId &&
          result.inputClosureSha256 === suite.inputClosureSha256);
        if (results.length !== 1) continue;
        const evidence = results[0].evidence;
        // An untrusted hint can locate evidence, but only its independently
        // authenticated, directly executed original may authorize reuse.
        const origin = evidence?.kind === "REUSED" ? evidence : reference;
        if (evidence?.kind === "REUSED" && evidence.repository !== source.run.repository) {
          throw new QualityEvidenceError("Reuse hint points outside the current repository");
        }
        const originalContent = origin === reference ? content : await read(origin);
        const original = await authenticateOriginalManifest({
          options, approvedValidator: source.validator,
          artifactId: origin.artifactId, runId: origin.runId, attempt: origin.attempt,
          content: originalContent,
        }, { verify });
        const bound = createReuseReference({ original, suite, validator: source.validator });
        reusedResults.push({
          suiteId: suite.suiteId, inputClosureSha256: suite.inputClosureSha256, evidence: bound,
        });
        found = true;
      }
      if (!found) miss(run.id, "No eligible directly executed result has identical complete inputs");
    } catch (error) {
      if (!(error instanceof QualityEvidenceError) && !(error instanceof SyntaxError) &&
        ![404, 410].includes(error?.status)) throw error;
      miss(run.id, error instanceof SyntaxError ? "Original artifact is not valid JSON" : error.message);
    }
  }
  const current = await captureFullSource(options, git);
  if (
    JSON.stringify(current.sourceSnapshot) !== JSON.stringify(source.sourceSnapshot) ||
    JSON.stringify(current.checkout) !== JSON.stringify(source.checkout) ||
    JSON.stringify(current.validator) !== JSON.stringify(source.validator) ||
    current.run.runId !== source.run.runId || current.run.attempt !== source.run.attempt ||
    current.run.headSha !== source.run.headSha
  ) {
    throw new Error("Source or control changed during original-result selection");
  }
  return finish();
}

async function collectFullManifest(options, source, { git, readArtifact, verify } = {}) {
  const { authenticateReuseReferences } = require("./consume-source-quality.js");
  const current = await captureCurrentSelection(options, source.executionProfiles, git);
  const fields = [
    "sourceSnapshot", "checkout", "validator", "suites", "selectionDigest",
    "inputClosureSha256", "noWork", "conservative", "executionProfiles", "purpose",
  ];
  if (
    !fields.every((field) => isDeepStrictEqual(current[field], source[field])) ||
    source.run?.runId !== current.run.runId || source.run?.event !== current.run.event ||
    source.run?.headSha !== current.run.headSha
  ) {
    throw new Error("Full-quality source or selection changed before aggregation");
  }
  const { github, context } = options;
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: context.runId, filter: "all", per_page: 100,
  });
  if (sourceCaptureAttempt(jobs) !== source.run.attempt) {
    throw new Error("Full-quality plan does not belong to the latest native source capture");
  }
  const reusedResults = await authenticateReuseReferences({
    options, source: current, references: source.reusedResults,
  }, { readArtifact, verify });
  const manifest = createFullQualityManifest({
    source: { ...current, run: source.run }, run: current.run, jobs, reusedResults,
  });
  const finalSource = await captureFullSource(options, git);
  if (
    !["sourceSnapshot", "checkout", "validator", "run"].every((field) =>
      isDeepStrictEqual(finalSource[field], current[field]))
  ) {
    throw new Error("Source or execution changed during full-quality aggregation");
  }
  return manifest;
}

async function collectManifest(options, source, git = readGit) {
  const { github, context } = options;
  const { run, validator } = await execution(options, git);
  if (JSON.stringify(validator) !== JSON.stringify(source.validator)) {
    throw new Error("Quality control changed between source capture and aggregation");
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: context.runId, filter: "all", per_page: 100,
  });
  return {
    ...createQualityManifest({ source, run, jobs }),
    purpose: "shadow-source-policy",
  };
}

module.exports = {
  captureSource, captureFullSource, captureCurrentSelection, resolveHistoricalController, collectManifest,
  captureExecutionProfiles,
  planFullQuality,
  collectFullManifest,
};
