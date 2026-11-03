---
name: betstan-branch-governance
description: Enforce BetStan's dev-to-master branch flow, exact-SHA CI checks, and production promotion approval.
---

# BetStan branch governance

Use for branches, commits, pushes, PRs, CI gates, merges and production
dispatches. [CONTRIBUTING.md](../../../CONTRIBUTING.md) is the canonical policy;
this skill is its procedure, not another approval hierarchy.

## Retained contract

- Never commit or push directly to protected `dev` or `master`, or rewrite
  their history. Normal work enters `dev` through a focused PR; only an
  up-to-date `dev` PR may target production `master`.
- Use ancestry-preserving merges. Prove required feature commits are included
  in the exact protected aggregate and verify the exact tested snapshot.
  Reconcile branches only when ancestry requires it; a promotion does not
  automatically require a content-identical synchronization PR.
- Require successful trusted, base-scoped branch-policy and quality statuses
  on the current head and unique merge snapshot. Stale, skipped, pending,
  neutral, unrelated or branch-name-only checks are not success.
- Verified CLI-created, CLI-owned work progresses automatically through the
  canonical helpers when technical gates pass, including follow-on Actions.
  Never add `copilot-cli-managed` to human-origin work or treat that label alone
  as proof of origin/ownership. Every other PR requires `APPROVED_SHA` equal to
  its current head; human promotions also require `APPROVED_WORKFLOWS`.
- Preserve comprehensive [PR evidence](../../pull_request_template.md):
  rationale, exact refs, scope/exclusions, compatibility, validation, risks,
  workflow inventory, data, flags, rollback and remaining work. Conditional
  fields stay present as `not applicable` when appropriate.
- Title/body presentation and public-safe session/feature labels are
  informational. Actual missing evidence remains blocking. The candidate merge
  helper no longer rejects title wording, but not-yet-replaced protected
  revisions retain their executable checks. The trusted-master-identical
  `production-build.yml` still runs full legacy validation on
  `pull_request.edited`; lightweight metadata-only validation is staged, not
  active for this compatibility path. Actual protected triggers govern until
  tested cutover; no remote cutover is implied.
- No agent verdict bypasses immutable deployed identity, physical
  single-writer locks/fences, data integrity, compatible recovery or observed
  health. Explicit pauses still apply to otherwise automatic progression.

## Scoped read-only baseline

Inspect only what the authorized action needs. A repository-only policy edit
does not authorize remote configuration changes or a production baseline.

1. Inspect the specified worktree and exact source; preserve unrelated work.
2. For a live PR/merge decision, resolve current remote refs, default branch,
   protection, PR head/base, mergeability and trusted check conclusions.
3. Use ancestry, not branch-tip equality. Run `pr-validation-stan.sh` to bind
   repository, current head/base, merge snapshot and trusted workflow IDs.
4. Check actual PR evidence and origin/ownership. Run
   `pr-merge-safety-stan.sh` in the correct automatic or exact human mode
   immediately before a merge; a stale recommendation is not authorization.
5. For a protected operation, use the canonical dispatcher and approver from
   `CONTRIBUTING.md`, preserving operation-specific prerequisites, current
   workflow identity/state, exact run attempt and one-use authority.
6. Observe jobs and pending environment gates through terminal effects.
   Progress eligible automatic gates promptly; respect an approved wait timer.
   Unknown dispatch/approval outcomes require exact reconciliation, not replay.

## Current trust and cutover

Existing executable controls remain authoritative until replacements are
proven and activated. This skill does not activate a new source-snapshot
verifier or controller. Read the current
[`publish-pr-policy.js`](../../scripts/publish-pr-policy.js) and
[`branch-policy.yml`](../../workflows/branch-policy.yml) for publisher identity,
transition/receipt compatibility and status-writing authority.

When a trusted workflow itself changes, follow `Trusted-check bootstrap` in
`CONTRIBUTING.md` and its tested executable path. Do not invent an authorization
variable, let candidate code authorize itself, reset consumed receipts, weaken
protection or roll back to a reader incompatible with existing authority.
Fresh required statuses and exact source relations must still be proven.

Return `NO_GO` for unauthorized protected pushes, wrong promotion source,
stale ancestry/checks, incomplete approval, unknown mutation outcomes or failed
runtime prerequisites. Name the concrete blocker and smallest safe next action.
Never expose credentials, private logs, infrastructure identifiers or session
paths.
