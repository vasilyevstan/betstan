"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { QUALITY_EVENTS, sourceSnapshot, createQualityManifest } = require("./pr-source-snapshot.js");

const WORKFLOW_PATH = ".github/workflows/source-quality.yml";
const CONTROL_PATHS = [
  WORKFLOW_PATH,
  ".github/scripts/source-quality.js",
  ".github/scripts/pr-source-snapshot.js",
];

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });
}

async function execution({ github, context, attempt }, git) {
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
  const records = git(["ls-tree", "-z", "HEAD", "--", ...CONTROL_PATHS])
    .split("\0").filter(Boolean).map((record) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
      if (!match || !CONTROL_PATHS.includes(match[3])) {
        throw new Error("Unsupported quality control input");
      }
      return { path: match[3], mode: match[1], blobSha: match[2] };
    }).sort((a, b) => a.path.localeCompare(b.path));
  if (
    records.length !== CONTROL_PATHS.length ||
    new Set(records.map((record) => record.path)).size !== CONTROL_PATHS.length
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

async function captureSource(options, git = readGit) {
  const { github, context } = options;
  const { native, run, validator } = await execution(options, git);
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

module.exports = { captureSource, collectManifest };
