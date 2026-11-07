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

const DISPATCH_WORKFLOW = ".github/workflows/oci-validate.yml";
const DISPATCH_CONTROL_PATHS = Object.freeze([
  ".github/scripts/source-quality.js", ".github/scripts/consume-source-quality.js",
  ".github/scripts/quality-attestation.js", ".github/scripts/pr-source-snapshot.js",
  ".github/scripts/source-input-selection.js",
  "infra/ci/suite_gate.py", "infra/oci/tests/run-contracts.sh",
  "infra/azure/agents/test-deployment-safety-ci-stan.sh",
]);
const DISPATCH_JOB = "oci-full-contracts (dispatch)";
// These are optional proof-eligibility approvals, not publisher/workflow grants.
// Caller adoption is separate and requires an observed ordinary-PR certificate.
const DISPATCH_CALLER_BLOBS = Object.freeze({
  ".github/workflows/oci-validate.yml": [
    "0795b8a7efb191d4dae78850844e0612d4f41d56",
    "7bbe29e2bebd4b2054c27824c07d63dc33d366ca",
    "8a263fb9dd649a68fa94e7fb3eafd36cd43e1e41",
  ],
  ".github/workflows/production-build.yml": ["8d9f264ea75645a7eb2571bfdfa3d771d4f61c84"],
});
const DISPATCH_TOOLS = Object.freeze([
  "bash", "python3", "ruby", "git", "gh", "node", "jq", "curl", "tar", "zip", "unzip",
  "date", "timeout", "flock", "find", "grep", "sed", "awk", "sha256sum", "base64",
]);

function captureDispatchProfile(env = process.env, execute = execFileSync) {
  if (process.platform !== "linux" || process.arch !== "x64" || env.ImageOS !== "ubuntu24" ||
    !/^\d{8}\.\d+\.\d+$/.test(env.ImageVersion ?? "")) {
    return { supported: false, reason: "Unsupported dispatch worker/image; ordinary execution required" };
  }
  const hashes = [];
  let probe = "worker";
  try {
    for (const tool of DISPATCH_TOOLS) {
      probe = tool;
      const file = execute("bash", ["--noprofile", "--norc", "-c", 'command -v -- "$1"', "probe", tool], {
        encoding: "utf8", timeout: 10_000, env: { ...env, BASH_ENV: "/dev/null" },
      }).trim();
      if (!file.startsWith("/")) throw new Error(`Dispatch profile probe did not resolve ${tool}`);
      hashes.push([tool, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
    }
    probe = "dpkg-query";
    const packages = execute("dpkg-query", ["-W", "-f=${binary:Package}=${Version}\\n"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, env,
    }).trim().split("\n").sort();
    return {
      supported: true, profile: "github-hosted-ubuntu24-dispatch-v1",
      imageVersion: env.ImageVersion, kernel: os.release(),
      nodeVersion: process.version,
      nodeSha256: crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex"),
      locale: { LANG: env.LANG ?? "", LC_ALL: env.LC_ALL ?? "", TZ: env.TZ ?? "" },
      toolsSha256: digest(hashes), packagesSha256: digest(packages),
    };
  } catch (error) {
    if (!["ENOENT", "EACCES", "ETIMEDOUT"].includes(error?.code) && !Number.isInteger(error?.status)) throw error;
    return { supported: false, reason: `Dispatch profile probe ${probe} failed (${error.code ?? error.status}); ordinary execution required` };
  }
}

function assertDispatchProfile(profile) {
  if (profile?.supported === false && typeof profile.reason === "string" && profile.reason.length <= 512) {
    throw new QualityEvidenceError(profile.reason);
  }
  if (!profile || profile.supported !== true ||
    profile.profile !== "github-hosted-ubuntu24-dispatch-v1" ||
    !/^\d{8}\.\d+\.\d+$/.test(profile.imageVersion ?? "") ||
    !/^[A-Za-z0-9._+-]{1,128}$/.test(profile.kernel ?? "") ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(profile.nodeVersion ?? "") ||
    !["nodeSha256", "toolsSha256", "packagesSha256"].every((key) => /^[0-9a-f]{64}$/.test(profile[key] ?? "")) ||
    !profile.locale || !["LANG", "LC_ALL", "TZ"].every((key) => typeof profile.locale[key] === "string")) {
    throw new QualityEvidenceError("Unsupported or incomplete native dispatch execution profile");
  }
}

async function dispatchCommit(github, repo, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new QualityEvidenceError("Dispatch commit is not immutable");
  const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
  if (commit?.sha !== sha || !/^[0-9a-f]{40}$/.test(commit.tree?.sha ?? "") ||
    !Array.isArray(commit.parents) || commit.parents.some((parent) => !/^[0-9a-f]{40}$/.test(parent.sha ?? ""))) {
    throw new QualityEvidenceError("Native dispatch Git object is incomplete");
  }
  return { sha, treeSha: commit.tree.sha, parents: commit.parents.map((parent) => parent.sha) };
}

async function dispatchControl(github, repo, sha) {
  const commit = await dispatchCommit(github, repo, sha);
  const { data: tree } = await github.rest.git.getTree({ ...repo, tree_sha: commit.treeSha, recursive: "1" });
  if (tree?.sha !== commit.treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new QualityEvidenceError("Dispatch control inventory is incomplete");
  }
  const paths = [...DISPATCH_CONTROL_PATHS, ...Object.keys(DISPATCH_CALLER_BLOBS)];
  const records = tree.tree.filter((entry) => paths.includes(entry.path)).map((entry) => {
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || !/^[0-9a-f]{40}$/.test(entry.sha)) {
      throw new QualityEvidenceError("Unsupported dispatch executable control");
    }
    return { path: entry.path, mode: entry.mode, sha: entry.sha };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (records.length !== paths.length || new Set(records.map((record) => record.path)).size !== paths.length) {
    throw new QualityEvidenceError("Missing or duplicate dispatch executable control");
  }
  return { commit, records };
}

async function captureNativeDispatchSource(options, git = readGit) {
  const { github, context, attempt } = options;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const pr = context.eventName === "pull_request";
  const workflowPath = pr ? DISPATCH_WORKFLOW : ".github/workflows/production-build.yml";
  if (attempt !== 1 || !Number.isSafeInteger(context.runId) || context.runId < 1 ||
    (!pr && (context.eventName !== "push" || context.ref !== "refs/heads/master")) ||
    git(["rev-parse", "HEAD"]).trim() !== context.sha) {
    throw new QualityEvidenceError("Native dispatch requires an exact first-attempt PR or master checkout");
  }
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: context.runId });
  if (run?.id !== context.runId || run.run_attempt !== 1 || run.path !== workflowPath ||
    run.event !== context.eventName || run.repository?.full_name !== repository ||
    !Number.isSafeInteger(run.repository?.id) || run.repository.id < 1 ||
    !Number.isSafeInteger(run.workflow_id) || run.workflow_id < 1) {
    throw new QualityEvidenceError("Native dispatch caller/run identity mismatch");
  }
  const commit = await dispatchCommit(github, context.repo, context.sha);
  let snapshot;
  if (pr) {
    const number = context.payload.pull_request?.number;
    if (!Number.isSafeInteger(number) || number < 1 || context.ref !== `refs/pull/${number}/merge`) {
      throw new QualityEvidenceError("Native dispatch caller is not the PR merge ref");
    }
    const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    snapshot = sourceSnapshot(pull);
    if (snapshot.number !== number || snapshot.repository !== repository || !["dev", "master"].includes(snapshot.baseRef) ||
      snapshot.mergeSha !== context.sha || run.head_sha !== snapshot.headSha ||
      !isDeepStrictEqual(commit.parents, [snapshot.baseSha, snapshot.headSha]) ||
      !nativeDispatchAssociationsMatch(run.pull_requests, snapshot, run.repository.id)) {
      throw new QualityEvidenceError("Native PR head/base/merge snapshot changed or is incomplete");
    }
  } else {
    const { data: branch } = await github.rest.repos.getBranch({ ...context.repo, branch: "master" });
    if (branch?.protected !== true || branch.commit?.sha !== context.sha || run.head_sha !== context.sha) {
      throw new QualityEvidenceError("Native dispatch push is not exact current protected master");
    }
  }
  return {
    repository, repositoryId: run.repository.id, runId: run.id, attempt: 1,
    workflowId: run.workflow_id, workflowPath, event: run.event, ref: context.ref,
    headSha: run.head_sha, commit, ...(snapshot ? { snapshot } : {}),
  };
}

// Actions can erase PR associations after integration. These optional hints
// must not contradict the live capture or the certificate/immutable Git proof.
function nativeDispatchAssociationsMatch(associations, snapshot, repositoryId) {
  if (associations == null) return true;
  const compatible = (value, expected) => value == null || value === expected;
  return Array.isArray(associations) && associations.every((entry) =>
    entry?.number === snapshot.number && ["head", "base"].every((side) =>
      entry[side] == null || (typeof entry[side] === "object" &&
        compatible(entry[side].sha, snapshot[`${side}Sha`]) &&
        compatible(entry[side].ref, snapshot[`${side}Ref`]) &&
        compatible(entry[side].repo?.id, repositoryId) &&
        compatible(entry[side].repo?.full_name, snapshot.repository))));
}

function assertDispatchJobs(jobs, source, published = true) {
  const success = ["oci-scope", "oci-workflow-syntax", "oci-validate",
    ...["core", "live", "provenance", "rollback", "governance", "dispatch"].map((shard) => `oci-full-contracts (${shard})`)];
  const names = [...success, "oci-focused-contracts", "oci-dispatch-original"];
  if (!Array.isArray(jobs) || jobs.length !== names.length || jobs.some((job) => !job || typeof job !== "object") ||
    new Set(jobs.map((job) => job.name)).size !== names.length ||
    new Set(jobs.map((job) => job.id)).size !== names.length ||
    jobs.some((job) => !names.includes(job.name) || !Number.isSafeInteger(job.id) || job.id < 1 ||
      job.run_id !== source.runId || job.run_attempt !== 1 || job.head_sha !== source.headSha ||
      (job.name !== "oci-dispatch-original" &&
        (job.status !== "completed" || job.conclusion !== (success.includes(job.name) ? "success" : "skipped"))))) {
    throw new QualityEvidenceError("Native dispatch job inventory is incomplete, retried or unsuccessful");
  }
  const worker = jobs.find((job) => job.name === DISPATCH_JOB);
  const step = (job, name, conclusion) => {
    const matches = Array.isArray(job.steps) ? job.steps.filter((item) => item?.name === name) : [];
    if (matches?.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== conclusion) {
      throw new QualityEvidenceError(`Native dispatch step did not actually ${conclusion}: ${name}`);
    }
    return matches[0];
  };
  const capture = step(worker, "Capture dispatch worker before candidate tests", "success");
  const execute = step(worker, "Execute original dispatch assertions", "success");
  step(worker, "Record selected-out dispatch", "skipped");
  step(worker, "Record authenticated dispatch reuse", "skipped");
  if (!(capture.number < execute.number) || !Number.isFinite(Date.parse(capture.completed_at)) ||
    !Number.isFinite(Date.parse(execute.started_at)) || Date.parse(capture.completed_at) > Date.parse(execute.started_at)) {
    throw new QualityEvidenceError("Dispatch worker facts were not captured before candidate execution");
  }
  const signer = jobs.find((job) => job.name === "oci-dispatch-original");
  if (published) {
    if (signer.status !== "completed" || signer.conclusion !== "success") {
      throw new QualityEvidenceError("Native original publication did not complete successfully");
    }
    for (const name of ["Reconstruct original from native jobs", "Attest dispatch original",
      "Upload dispatch original", "Confirm original publication"]) step(signer, name, "success");
  } else if (signer.status !== "in_progress" || signer.conclusion != null) {
    throw new QualityEvidenceError("Native original signer is not the current in-progress job");
  }
  return { jobId: worker.id, kind: "EXECUTED" };
}

async function collectNativeDispatchOriginal(options, worker, { git, observationOnly = true } = {}) {
  const source = await captureNativeDispatchSource(options, git);
  if (!observationOnly) {
    // This module and its policy reader are loaded from the protected copy.
    // Candidate control is inspected as immutable data, never required/executed.
    const { nativeDispatchPolicy } = require("./consume-source-quality.js");
    const policy = await nativeDispatchPolicy(options);
    const actual = await dispatchControl(options.github, options.context.repo, source.commit.sha);
    if (!isDeepStrictEqual(policy.records, actual.records.filter((row) => DISPATCH_CONTROL_PATHS.includes(row.path))) ||
      actual.records.find((row) => row.path === DISPATCH_WORKFLOW).sha !== policy.callers[DISPATCH_WORKFLOW].at(-1)) {
      throw new QualityEvidenceError("Unapproved candidate control cannot produce a native dispatch original");
    }
  }
  if (source.event !== "pull_request" || !worker || worker.selected !== true ||
    (!observationOnly && worker.controlApproved !== true) ||
    !isDeepStrictEqual(worker.source, source)) {
    throw new QualityEvidenceError("Dispatch original does not bind the pre-test execution worker");
  }
  assertDispatchProfile(worker.profile);
  const jobs = await options.github.paginate(options.github.rest.actions.listJobsForWorkflowRun, {
    ...options.context.repo, run_id: source.runId, filter: "all", per_page: 100,
  });
  const execution = assertDispatchJobs(jobs, source, false);
  if (!isDeepStrictEqual(source, await captureNativeDispatchSource(options, git))) {
    throw new QualityEvidenceError("Native dispatch source changed during collection");
  }
  return {
    schemaVersion: 1, purpose: observationOnly ? "native-dispatch-observation" : "native-dispatch-original",
    suiteId: "cli-dispatch",
    source, profile: worker.profile, execution,
  };
}

module.exports = {
  captureSource, captureFullSource, captureCurrentSelection, resolveHistoricalController, collectManifest,
  captureExecutionProfiles,
  planFullQuality,
  collectFullManifest,
  DISPATCH_WORKFLOW, DISPATCH_CONTROL_PATHS, DISPATCH_JOB, DISPATCH_CALLER_BLOBS,
  captureDispatchProfile, assertDispatchProfile, dispatchCommit, dispatchControl,
  captureNativeDispatchSource, assertDispatchJobs, collectNativeDispatchOriginal,
  nativeDispatchAssociationsMatch,
};
