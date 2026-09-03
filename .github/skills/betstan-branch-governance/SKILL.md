---
name: betstan-branch-governance
description: Enforce BetStan's dev-to-master branch flow, exact-SHA CI checks, production promotion approval, and post-squash synchronization.
---

# BetStan branch governance

Use this skill whenever a task involves branches, commits, pushes, pull requests, CI gates, merges, or production workflow dispatches.

## Required flow

- Never commit or push directly to `master`.
- `master` is the GitHub default and production branch; `dev` is the protected
  integration branch.
- Normal changes enter `dev` through a focused pull request; never push directly
  to protected `dev`.
- Only an up-to-date `dev` branch may open a pull request into `master`.
- A production promotion requires green trusted `branch-policy/master` and `pr-quality-gates/master` statuses on both its current head and unique merge snapshot.
- Before promotion, identify the exact head SHA and every production-capable workflow triggered by the diff. Require explicit approval covering that exact set.
- Use `.github/pull_request_template.md` as the canonical PR evidence
  structure. Core rationale, exact refs, scope/exclusions, compatibility,
  validation, risks, and remaining work are required on every PR; conditional
  operational fields stay present and say `not applicable` when appropriate.
- Only CLI-created and CLI-owned PRs may carry `copilot-cli-managed` and use
  automatic mode. Every other PR requires `APPROVED_SHA` equal to its current
  head; human `master` promotions also require the exact workflow inventory.
- Treat PR title/body edits as workflow-producing when protected workflows
  subscribe to `pull_request.edited`; schedule them outside production
  exclusivity and data-to-deploy handoff windows.
- Manual central production workflow dispatches are approval-gated through `production-emergency` and require an exact full master SHA. Legacy per-service deploy workflows are not manually dispatchable.
- Common package publication is separately approval-gated through
  `common-package-release`; only `common-package-publish.yml` may publish, and
  only from an exact current `master` SHA.
- After a squash promotion, immediately merge `master` back into `dev` and verify `master` is an ancestor of `dev`.

## Read-only baseline

Before recommending an action:

1. Inspect the worktree and preserve unrelated changes.
2. Fetch current remote refs.
3. Confirm the repository default branch is `master`, then inspect protection
   for both `master` and `dev`.
4. Inspect PR base, head, exact head SHA, mergeability, and check conclusions.
5. Use ancestry checks rather than comparing branch tips.
6. Use `pr-validation-stan.sh` to bind the current head SHA, base SHA, merge snapshot, and trusted workflow IDs; use `pr-merge-safety-stan.sh` for the final recommendation.
7. Verify the PR body satisfies `.github/pull_request_template.md`.

When changing a trusted required-check workflow, follow the exact bootstrap in
`CONTRIBUTING.md`: first promote a separate, fail-closed one-use authorization
mechanism without changing the protected workflow; then authorize only the
intended workflow blob, promote it normally, remove the authorization, and
verify fresh statuses before changing protection or disabling an old identity.
The first completed exact quality run created after authorization consumes its
durable receipt. Workflow-producing pull-request events publish pending until
their own run completes. They first publish an unbound exact-snapshot barrier,
then bind the exact newly registered run, which must strictly postdate the
event. The marker also binds a bounded title/body fingerprint, so another run
from the same head/base snapshot or stale PR content cannot satisfy it. Accept
markers only from the GitHub Actions bot with a validated repository
`branch-policy` run target carrying the exact PR/head/base relation. Keep
`branch-policy.yml` as the sole status-writing workflow and require every
workflow job to declare effective token permissions. A completion that differs
from the marker-bound run remains pending. An exact delayed completion or
manual trusted refresh may bind an unbound marker. Recheck the current PR
snapshot before and after publishing statuses and invalidate stale
same-snapshot results with pending.
Non-producing metadata updates do not replace that marker. Any subsequent edit,
synchronization, base advance, or refresh needs a new short-lived
authorization and receipt anchor.

Return `NO_GO` for a direct `master` push, a non-`dev` PR into `master`, a stale promotion, missing or stale checks, incomplete production approval, or unsynchronized branches after promotion.

Never expose secrets, cloud identifiers, kubeconfig data, private logs, or session paths.
