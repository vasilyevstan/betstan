# Contributing to BetStan

Current executable controls remain authoritative: workflows, helpers and branch protection decide, and this page summarizes them. Details live in the [branch skill](.github/skills/betstan-branch-governance/SKILL.md), [Release Orchestration](docs/wiki/Release-Orchestration.md) and [OCI runbook](infra/oci/README.md).

## Branch flow

Never commit or push directly to `dev` or `master`, and never rewrite or force-push them.

1. Integrate feature, fix and operations branches into `dev` by pull request.
2. Promote to `master` only by an up-to-date PR from `dev`; other PRs into `master` are forbidden.
3. Use ancestry-preserving merges. After a promotion, merge `origin/master` into the next `dev`-bound branch (a standalone sync PR only when nothing else precedes the next promotion).
4. Exact-SHA CI is required: every required status must pass on the exact head and current tested merge snapshot; skipped, stale or pending checks are not success. `pr-merge-safety-stan.sh` decides, not GitHub's mergeable state. Read live protection for the required check names.

Preserve unrelated tracked, staged and untracked work.

### Concurrent feature delivery

A promotion may aggregate several features. Before claiming release completion, prove every required commit is an ancestor of the exact `master` SHA built and deployed. Additional protected commits are allowed, but the aggregate passes its own exact-SHA checks, rollback readiness and production acceptance. If `master` advances mid-release, adopt the new candidate; never reset `master` or deploy an older SHA.

## Pull requests

Use the [PR template](.github/pull_request_template.md); the description is durable review and release evidence (why, exact SHAs, scope, compatibility, commands with outcomes, production/rollback evidence or `not applicable`). User-facing changes record affected routes, states, themes and viewports, exceptions, verification source and any evidence gap.

Every PR carries public-safe `session:<slug>` and `feature:<slug>` labels via `pr-context-labels-stan.sh`. These labels are discoverability metadata only: they never grant authority or affect checks, release or rollback.

## Origin and approval

- A human-origin PR, including one into `dev`, requires `APPROVED_SHA` equal to its exact current head; human `master` promotions also need the exact `APPROVED_WORKFLOWS`.
- CLI-created, CLI-owned work is auto-approved via canonical helpers (`COPILOT_CLI_AUTO_APPROVE=true`, `copilot-cli-dispatch-stan.sh`, `copilot-cli-run-approval-stan.sh`) without a separate personal prompt, only after the helpers verify ownership, exact refs, checks and production inventory.
- Only Copilot CLI may add `copilot-cli-managed`, only to its own PR; the label proves nothing. Never adopt human-origin work or another owner's operation.
- Ambiguous dispatch or approval uses the helpers' resume or reconcile paths; never redispatch, replay or hand-edit authority records.

## Verification

- One accountable owner; the smallest verification covering the exact diff, then one full validation of the final SHA. Do not rerun unchanged tests.
- Changed trust/state boundaries (authorization, CI trust, release authority, writer ownership, data integrity, migration, recovery) need independent verification by someone other than the author.
- No mandatory agent chain or review-of-review ([agent roles](.github/agents/README.md)). Name an unmet criterion before adding process.
- Never expose credentials, private records or local session paths.

## Production safety

- Merge to `master` builds images; production deploys only by a separate exact-SHA dispatch of immutable digests.
- Always keep immutable deployed identity, physical single-writer locks/fences, data integrity, compatible recovery and observed health.
- Production mutations stay serialized. Preserve failed-run locks/fences; timeout or lease expiry is not proof that a writer stopped.
- Rollback targets a validated earlier generation, never a failed one.
- `https://betstan.xyz` is canonical; a homepage `200` alone is not health.

## Public documentation impact

Every change records a documentation-impact assessment (owner or `betstan-public-wiki-editor`); a no-impact result names the inspected paths. Public behavior, architecture, contracts, security, infrastructure, quality, release, UI/UX or agent changes update `docs/wiki/` in the same PR, published byte-for-byte after merge without private details.

## Shared Common package

Follow [common/README.md](common/README.md): `common/` is tracked source, consumers pin one exact published version, and only `common-package-publish.yml` publishes.

## Trusted-check bootstrap

The trusted publisher requires the protected quality workflow to match the default branch. Prefer extending a guard `production-build.yml` already runs. Changing that workflow needs a separately promoted one-use exact-blob authorization in the publisher, removed after use. Marker, ledger and receipt rules live in [`publish-pr-policy.js`](.github/scripts/publish-pr-policy.js) and [`branch-policy.yml`](.github/workflows/branch-policy.yml); keep readers for every emitted version.

## Commands

```bash
./infra/azure/agents/pre-commit-infra-check-stan.sh
./infra/azure/agents/wait-required-checks-stan.sh <pr>
./infra/azure/agents/pr-merge-safety-stan.sh <pr>
APPROVED_SHA=<sha> APPROVED_WORKFLOWS=<list> ./infra/azure/agents/pr-merge-safety-stan.sh <pr>
PR=<promotion-pr> ./infra/azure/agents/post-merge-verification-stan.sh
```
