---
name: betstan-branch-governance
description: Enforce BetStan's dev-to-master branch flow, exact-SHA CI checks, production promotion approval, and post-squash synchronization.
---

# BetStan branch governance

Use this skill whenever a task involves branches, commits, pushes, pull requests, CI gates, merges, or production workflow dispatches.

## Required flow

- Never commit or push directly to `master`.
- Normal changes enter `dev`, either directly or through a focused pull request.
- Only an up-to-date `dev` branch may open a pull request into `master`.
- A production promotion requires green trusted `branch-policy` and `pr-quality-gates` statuses on its current unique merge snapshot.
- Before promotion, identify the exact head SHA and every production-capable workflow triggered by the diff. Require explicit approval covering that exact set.
- Manual central production workflow dispatches are approval-gated through `production-emergency` and require an exact full master SHA. Legacy per-service deploy workflows are not manually dispatchable.
- After a squash promotion, immediately merge `master` back into `dev` and verify `master` is an ancestor of `dev`.

## Read-only baseline

Before recommending an action:

1. Inspect the worktree and preserve unrelated changes.
2. Fetch current remote refs.
3. Check the repository default branch and `master` protection.
4. Inspect PR base, head, exact head SHA, mergeability, and check conclusions.
5. Use ancestry checks rather than comparing branch tips.
6. Use `pr-validation-stan.sh` to bind the current head SHA, base SHA, merge snapshot, and trusted workflow IDs; use `pr-merge-safety-stan.sh` for the final recommendation.

When changing required checks, bootstrap in two phases: first merge the trusted workflow into default `dev` under the existing gates; then verify a fresh status from the new workflow identity before changing protection or disabling the retired identity.

Return `NO_GO` for a direct `master` push, a non-`dev` PR into `master`, a stale promotion, missing or stale checks, incomplete production approval, or unsynchronized branches after promotion.

Never expose secrets, cloud identifiers, kubeconfig data, private logs, or session paths.
