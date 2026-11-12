---
name: betstan-branch-governance
description: Enforce BetStan's dev-to-master branch flow, exact-SHA CI checks, and production promotion approval.
---

# BetStan branch governance

Use for branches, commits, pushes, PRs, CI gates, merges and production dispatches; [`betstan-delivery-coordinator`](../../agents/betstan-delivery-coordinator.agent.md) applies it when acting as owner. [CONTRIBUTING.md](../../../CONTRIBUTING.md) is canonical; this is its procedure.

## Required flow

- Never commit or push directly to `dev` or `master`, or rewrite their history. Work enters `dev` by focused PR; only an up-to-date `dev` PR may target `master`.
- Use ancestry-preserving merges. After a promotion, merge `origin/master` into the next `dev`-bound branch (or a standalone sync PR when nothing else precedes the next promotion) so the next promotion head contains it.
- Require every strict, app-bound required status of the target branch on the current head, and the trusted base-scoped statuses on the unique current merge snapshot for `dev` and `master` alike; GitHub's clean merge state is not proof (currently `dev`: `publish-current-pr-snapshot`, `pr-quality-gates`, `oci-validate`; `master`: `branch-policy/master`, `pr-quality-gates/master`, `oci-validate`). Read live protection; this list is not authority.
- PR body follows the [template](../../pull_request_template.md); add `session:`/`feature:` labels with `pr-context-labels-stan.sh` (informational only).
- CLI-created, CLI-owned PRs (`copilot-cli-managed`) progress automatically via canonical helpers when gates pass. Every other PR needs `APPROVED_SHA` equal to its head; human promotions also `APPROVED_WORKFLOWS`.
- Protected operations use the canonical dispatcher/approver; unknown outcomes are reconciled, never replayed.

## Baseline before acting

1. Inspect the worktree; preserve unrelated work.
2. For a live decision, fetch refs and check protection, PR head/base, mergeability and trusted checks.
3. Use ancestry, not tip equality. `pr-validation-stan.sh` binds head/base/merge snapshot and workflow IDs.
4. Run `pr-merge-safety-stan.sh` in the correct mode immediately before merging.
5. Wait for required checks with `wait-required-checks-stan.sh <pr>` (bounded; never `gh pr checks --watch`; `trusted-quality-transition/*` is a pending-by-design ledger, not a gate). Observe jobs and pending gates to terminal state; respect environment reviewers or timers only where configured. Report a definitive job failure immediately; never treat cancelled, skipped or stale results as success.

## Trust mechanics

Quality-marker versions, label ledger and receipt rules are enforced in [`publish-pr-policy.js`](../../scripts/publish-pr-policy.js) and [`branch-policy.yml`](../../workflows/branch-policy.yml); read them, not memory. Trusted-workflow changes follow `Trusted-check bootstrap` in CONTRIBUTING. Never let candidate code authorize itself, reset receipts, weaken protection or roll back to an incompatible reader.

## NO_GO

Return `NO_GO` for: a direct protected push; a non-`dev` PR into `master`; stale ancestry or promotion; missing, stale or failing checks; incomplete approval; unknown mutation outcomes; failed runtime prerequisites; a promotion head missing the previous promotion merge. Name the blocker and smallest safe next action. Never expose credentials, private logs, infrastructure identifiers or session paths.
