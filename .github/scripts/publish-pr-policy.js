"use strict";

const BRANCH_CONTEXT_PREFIX = "branch-policy";
const QUALITY_CONTEXT_PREFIX = "pr-quality-gates";
const QUALITY_JOB = "pr-quality-gates";
const QUALITY_WORKFLOW = "production-build.yml";
const QUALITY_WORKFLOW_PATH = `.github/workflows/${QUALITY_WORKFLOW}`;
// Remove this one-use authorization before promoting the workflow update.
const APPROVED_QUALITY_WORKFLOW_BLOBS = new Set([
  "68c4d8801689b71a4b1a5e37ee24a405f981d24d",
]);

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

function runMatchesPull(run, pull, workflowId) {
  const relationMatches = (run.pull_requests || []).some(
    (relation) =>
      relation.number === pull.number &&
      relation.head?.sha === pull.headSha &&
      relation.base?.sha === pull.baseSha,
  );

  return (
    run.workflow_id === workflowId &&
    run.path === QUALITY_WORKFLOW_PATH &&
    run.event === "pull_request" &&
    run.head_sha === pull.headSha &&
    run.head_repository?.full_name === pull.headRepository &&
    relationMatches
  );
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

async function qualityDecision({
  github,
  owner,
  repo,
  pull,
  candidateRun,
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
      state: "failure",
      description: `PR #${pull.number} cannot verify trusted quality workflow`,
      targetUrl: fallbackUrl,
      reason: error.message,
    };
  }

  if (
    trustedBlob !== headBlob &&
    !APPROVED_QUALITY_WORKFLOW_BLOBS.has(headBlob)
  ) {
    return {
      state: "failure",
      description: `PR #${pull.number} changes the trusted quality workflow`,
      targetUrl: fallbackUrl,
      reason: "quality workflow differs from the current default branch",
    };
  }

  const listed = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: workflowId,
    event: "pull_request",
    per_page: 100,
  });
  const candidates = [...listed.data.workflow_runs];
  if (candidateRun && !candidates.some((run) => run.id === candidateRun.id)) {
    candidates.push(candidateRun);
  }

  const matchingRuns = candidates
    .filter((run) => runMatchesPull(run, pull, workflowId))
    .sort((left, right) => right.id - left.id);
  if (matchingRuns.length === 0) {
    return {
      state: "pending",
      description: `PR #${pull.number} awaits exact-snapshot quality gates`,
      targetUrl: fallbackUrl,
      reason: "no exact trusted workflow run exists yet",
    };
  }

  const run = matchingRuns[0];
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
    reason: "exact trusted quality workflow and aggregate job succeeded",
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

function eventPullIdentity(eventPull) {
  return {
    number: eventPull.number,
    headRef: eventPull.head.ref,
    headSha: eventPull.head.sha,
    headRepository: eventPull.head.repo?.full_name || "",
    baseRef: eventPull.base.ref,
    baseSha: eventPull.base.sha,
  };
}

module.exports = async function publishPrPolicy({ github, context, core }) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  const policyRunUrl =
    `${context.serverUrl}/${repository}/actions/runs/${context.runId}`;

  let work;
  if (context.eventName === "pull_request_target") {
    work = [
      {
        number: context.payload.pull_request.number,
        expected: eventPullIdentity(context.payload.pull_request),
        candidateRun: null,
      },
    ];
  } else if (context.eventName === "workflow_run") {
    const workflowRun = context.payload.workflow_run;
    work = (workflowRun.pull_requests || []).map((relation) => ({
      number: relation.number,
      expected: {
        number: relation.number,
        headSha: relation.head.sha,
        baseSha: relation.base.sha,
      },
      candidateRun: workflowRun,
    }));
    if (work.length === 0) {
      throw new Error("Completed quality workflow has no pull request relation");
    }
  } else if (context.eventName === "workflow_dispatch") {
    const number = Number(context.payload.inputs?.pr_number);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error("workflow_dispatch requires a valid pr_number");
    }
    work = [{ number, expected: { number }, candidateRun: null }];
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
    const quality = await qualityDecision({
      github,
      owner,
      repo,
      pull,
      candidateRun: item.candidateRun,
      fallbackUrl: policyRunUrl,
    });
    const branchContext = `${BRANCH_CONTEXT_PREFIX}/${pull.baseRef}`;
    const qualityContext = `${QUALITY_CONTEXT_PREFIX}/${pull.baseRef}`;
    const targets = statusTargets(pull);

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

    const finalPull = pullIdentity(
      (
        await github.rest.pulls.get({
          owner,
          repo,
          pull_number: pull.number,
        })
      ).data,
    );
    assertExpectedPull(finalPull, pull);
    if (finalPull.mergeSha !== pull.mergeSha || finalPull.state !== "open") {
      throw new Error(`Pull request #${pull.number} changed while publishing`);
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
module.exports.runMatchesPull = runMatchesPull;
