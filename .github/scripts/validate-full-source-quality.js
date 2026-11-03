"use strict";

const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { sourceSnapshot } = require("./pr-source-snapshot.js");
const { branchDecision, latestFullQualityRun, verifyFullQualityRun } = require("./publish-pr-policy.js");

function githubClient(repository, execute = execFileSync) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid repository name");
  }
  const request = (path, query = {}) => {
    const parameters = new URLSearchParams(query).toString();
    const endpoint = `repos/${repository}${path ? `/${path}` : ""}${parameters ? `?${parameters}` : ""}`;
    return {
      data: JSON.parse(execute("gh", ["api", "--hostname", "github.com", endpoint], {
        encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      })),
    };
  };
  const client = {
    rest: {
      repos: {
        get: () => request(""),
        getCommit: ({ ref }) => request(`commits/${encodeURIComponent(ref)}`),
        getCombinedStatusForRef: ({ ref }) => request(`commits/${ref}/status`, { per_page: 100 }),
        compareCommitsWithBasehead: ({ basehead }) => request(`compare/${encodeURIComponent(basehead)}`),
      },
      pulls: { get: ({ pull_number }) => request(`pulls/${pull_number}`) },
      git: {
        getCommit: ({ commit_sha }) => request(`git/commits/${commit_sha}`),
        getTree: ({ tree_sha, recursive }) => request(`git/trees/${tree_sha}`, { recursive }),
      },
      actions: {
        getWorkflow: ({ workflow_id }) => request(`actions/workflows/${workflow_id}`),
        getWorkflowRun: ({ run_id }) => request(`actions/runs/${run_id}`),
        listWorkflowRuns: ({ workflow_id, owner, repo, ...query }) =>
          request(`actions/workflows/${workflow_id}/runs`, query),
        getArtifact: ({ artifact_id }) => request(`actions/artifacts/${artifact_id}`),
        listWorkflowRunArtifacts: ({ run_id, owner, repo, ...query }) =>
          request(`actions/runs/${run_id}/artifacts`, query),
        listJobsForWorkflowRun: ({ run_id, owner, repo, ...query }) =>
          request(`actions/runs/${run_id}/jobs`, query),
      },
    },
    paginate: async (method, parameters) => {
      if (method !== client.rest.actions.listJobsForWorkflowRun) throw new Error("Unsupported pagination");
      const jobs = [];
      for (let page = 1; page <= 20; page++) {
        const { data } = await method({ ...parameters, per_page: 100, page });
        if (!Array.isArray(data.jobs) || data.jobs.length > 100) throw new Error("Invalid native jobs page");
        jobs.push(...data.jobs);
        if (data.jobs.length < 100) return jobs;
      }
      throw new Error("Native job inventory exceeds the verification bound");
    },
  };
  return client;
}

async function validateFullSourceQuality({
  github, repo, number, expectedHeadSha, expectedBaseSha,
}, dependencies = {}) {
  const repository = `${repo.owner}/${repo.repo}`;
  const git = dependencies.git ?? ((args) => execFileSync("git", args, {
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  }));
  const controlSha = git(["rev-parse", "HEAD"]).trim();
  const branchSha = async (ref) => (await github.rest.repos.getCommit({ ...repo, ref })).data.sha;
  if (
    !Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(controlSha) ||
    await branchSha("master") !== controlSha ||
    git(["status", "--porcelain", "--untracked-files=no", "--", ".github/scripts"]).trim()
  ) {
    throw new Error("Full-quality validation requires an unchanged current-master verifier checkout");
  }
  const readSnapshot = async () => sourceSnapshot((await github.rest.pulls.get({
    ...repo, pull_number: number,
  })).data);
  const snapshot = await readSnapshot();
  if (
    snapshot.repository !== repository || !branchDecision(snapshot, repository).allowed ||
    await branchSha(snapshot.baseRef) !== snapshot.baseSha ||
    (expectedHeadSha && snapshot.headSha !== expectedHeadSha) ||
    (expectedBaseSha && snapshot.baseSha !== expectedBaseSha)
  ) {
    throw new Error("Current source does not match the approved branch/head/base");
  }
  const { data: workflow } = await github.rest.actions.getWorkflow({
    ...repo, workflow_id: "source-quality.yml",
  });
  if (
    !Number.isSafeInteger(workflow.id) || workflow.id < 1 || workflow.state !== "active" ||
    workflow.path !== ".github/workflows/source-quality.yml"
  ) {
    throw new Error("Full-quality producer is not registered and active");
  }
  const latest = () => latestFullQualityRun({ github, ...repo, workflowId: workflow.id, number });
  const run = await latest();
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("Latest source-quality run has not succeeded");
  }
  const qualityUrl = `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  const statuses = async () => {
    const bound = [];
    for (const sha of [snapshot.headSha, snapshot.mergeSha]) {
      const { data } = await github.rest.repos.getCombinedStatusForRef({ ...repo, ref: sha });
      if (data.sha !== sha || !Array.isArray(data.statuses)) throw new Error("Invalid native status inventory");
      for (const name of [`branch-policy/${snapshot.baseRef}`, `source-quality-v2/${snapshot.baseRef}`]) {
        const status = data.statuses.find((row) => row.context === name);
        if (
          status?.state !== "success" || status.creator?.id !== 41898282 ||
          status.creator?.login !== "github-actions[bot]"
        ) {
          throw new Error(`Missing successful trusted status: ${name}`);
        }
        if (name.startsWith("source-quality-v2/") && status.target_url !== qualityUrl) {
          throw new Error("Quality status does not bind the newest exact run and attempt");
        }
        bound.push({ sha, context: name, target: status.target_url });
      }
    }
    return bound;
  };
  const bindings = await statuses();
  const policyUrls = bindings.filter((binding) => binding.context.startsWith("branch-policy/"))
    .map((binding) => binding.target);
  const prefix = `https://github.com/${repository}/actions/runs/`;
  const suffix = typeof policyUrls[0] === "string" && policyUrls[0].startsWith(prefix)
    ? policyUrls[0].slice(prefix.length) : "";
  if (policyUrls[0] !== policyUrls[1] || !/^[1-9][0-9]*$/.test(suffix)) {
    throw new Error("Branch statuses do not bind one native repository publisher");
  }
  const [{ data: policy }, { data: policyWorkflow }] = await Promise.all([
    github.rest.actions.getWorkflowRun({ ...repo, run_id: Number(suffix) }),
    github.rest.actions.getWorkflow({ ...repo, workflow_id: "branch-policy.yml" }),
  ]);
  if (
    policy.id !== Number(suffix) || policy.repository?.full_name !== repository ||
    policy.workflow_id !== policyWorkflow.id || policy.path !== ".github/workflows/branch-policy.yml" ||
    policy.status !== "completed" || policy.conclusion !== "success" ||
    !["pull_request_target", "workflow_run", "workflow_dispatch"].includes(policy.event) ||
    policy.display_title !== `branch-policy PR ${policy.event === "workflow_run" ? run.id : number}`
  ) {
    throw new Error("Branch status publisher provenance does not match the current proof");
  }
  const proof = await verifyFullQualityRun({ github, repo, controlSha, run, number }, { ...dependencies, git });
  if (!proof) throw new Error("Current full-quality artifact is missing");
  const current = await latest();
  if (
    !isDeepStrictEqual(await readSnapshot(), snapshot) || await branchSha("master") !== controlSha ||
    await branchSha(snapshot.baseRef) !== snapshot.baseSha ||
    current?.id !== run.id || current?.run_attempt !== run.run_attempt ||
    current?.status !== run.status || current?.conclusion !== run.conclusion ||
    !isDeepStrictEqual(await statuses(), bindings)
  ) {
    throw new Error("Source, policy, run or statuses changed during merge verification");
  }
  return { snapshot, runId: run.id, attempt: run.run_attempt };
}

if (require.main === module) {
  const repository = process.env.REPO ?? "vasilyevstan/betstan";
  const [owner, repo] = repository.split("/");
  validateFullSourceQuality({
    github: githubClient(repository), repo: { owner, repo }, number: Number(process.argv[2]),
    expectedHeadSha: process.env.EXPECTED_HEAD_SHA, expectedBaseSha: process.env.EXPECTED_BASE_SHA,
  }).then(({ snapshot, runId, attempt }) => {
    console.log(`exact_head_sha=${snapshot.headSha}\nexact_base_sha=${snapshot.baseSha}`);
    console.log(`exact_merge_snapshot_sha=${snapshot.mergeSha}\nquality_run=${runId}\nquality_attempt=${attempt}`);
    console.log("all_required_checks=PASS");
  }).catch((error) => {
    console.error(`Full source-quality verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { githubClient, validateFullSourceQuality };
