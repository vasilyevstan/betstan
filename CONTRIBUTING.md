# Contributing to BetStan

## Branch flow

`master` is the production branch. Never commit or push directly to it.

1. Make changes on a feature, fix, or operations branch and integrate them into `dev` by pull request. Never push directly to `dev`.
2. Validate the complete `dev` branch.
3. Promote only with an up-to-date pull request from `dev` to `master`. PRs into `master` from any other branch are forbidden.
4. Require the trusted, base-scoped `branch-policy/master` and `pr-quality-gates/master` statuses to pass on both the promotion head and current merge snapshot.
5. Before merging a promotion, verify origin/ownership and the applicable exact-head approval, including every production-capable workflow.
6. Use ancestry-preserving merges. Verify protected ancestry and the exact tested snapshot before merging.
7. After a promotion, merge the current `origin/master` into the next `dev`-bound branch (content-neutral) so the next promotion head contains the previous promotion merge. Open a standalone sync PR only when no other `dev` work precedes the next promotion.

Never rewrite or force-push `master` or `dev`. Preserve unrelated tracked, staged, and untracked work.

### Concurrent feature delivery

Sessions may merge compatible changes independently; a promotion may aggregate several features. Before claiming release completion, prove every required commit is an ancestor of the exact `master` SHA built and deployed. Additional protected commits are allowed, but the aggregate must pass its own exact-SHA checks, workflow inventory, rollback readiness and production acceptance. If `master` advances mid-release, adopt the new exact candidate; never reset `master` or deploy an older SHA. Production dispatches, data mutations, deployments, activation, rollback and recovery stay serialized by the exclusivity and operation-lock contracts.

## Pull request evidence

Use `.github/pull_request_template.md`; the description is durable review and release evidence. Every PR records:

- why the change exists;
- exact base/head SHAs and, for promotions or syncs, the merge SHA;
- scope, compatibility effects and exclusions;
- commands and exact outcomes;
- production, data, feature-flag and rollback evidence, or `not applicable`;
- the reason for any closure, replacement or zero-diff ancestry change.

For user-facing changes, record affected routes, components, states, themes and viewports, reference patterns, intentional exceptions, verification source and any evidence gap. Otherwise write `not applicable`.

Use short, plain titles. Title wording and presentation are informational; missing rationale, source, approval, compatibility or validation evidence is blocking.

### Context labels

Every PR carries one public-safe `session:<slug>` (bounded session) and one `feature:<slug>` (durable feature) label, kept across implementation, promotion and sync PRs; aggregate promotions may carry several. Never use a session UUID, local path, identity, credential or production identifier. Apply with:

```bash
PR_SESSION_TAG=<slug> PR_FEATURE_TAG=<slug> ./infra/azure/agents/pr-context-labels-stan.sh <pr>
```

These labels are discoverability metadata only. They never grant authority, select approval, satisfy or block a check, or affect release or rollback, and are excluded from the trusted label fingerprint. The helper only adds labels and warns instead of blocking.

### Origin and approval

Only Copilot CLI may apply `copilot-cli-managed`, and only to a PR the active CLI workflow created and owns; never relabel a human PR. The CLI and `gh` share one GitHub identity, so the label is an operational convention, not proof of origin.

Verified CLI-created and CLI-owned PRs use `COPILOT_CLI_AUTO_APPROVE=true` without a separate personal prompt, only after `pr-merge-safety-stan.sh` verifies the label, exact refs, trusted checks, resolved threads, production workflow inventory and no competing production activity. Every other PR requires `APPROVED_SHA` equal to its exact current head, including PRs into `dev`; human `master` promotions also require the exact `APPROVED_WORKFLOWS`. Automatic mode never skips checks or production safety.

Progress eligible CLI-owned merges and follow-on protected Actions promptly through the canonical approval path, and respect approved wait timers. Never adopt human-origin work or another owner's operation. Do not merge until `pr-merge-safety-stan.sh` passes for the exact current head.

## Public documentation impact

Every change records a documentation-impact assessment before source acceptance (the owner may do it; use `betstan-public-wiki-editor` when expertise is needed). A no-impact result names the inspected paths and why. Changes to product behavior, architecture, contracts, data lifecycle, security, infrastructure, quality gates, release, UI/UX or agent responsibilities update the relevant `docs/wiki/` pages in the same PR. After merge, publish `docs/wiki/*.md` byte-for-byte to the GitHub wiki and verify. Public docs omit credentials, private approval records, local/session paths, private infrastructure identifiers, production data and bypass procedures.

## Verification

- One accountable owner; the smallest verification covering the exact diff. Targeted checks during correction, one full validation of the final SHA.
- Trust or state-boundary changes (authorization, CI trust, release authority, physical writer ownership, data integrity, migration, recovery) need independent verification; the author cannot supply it.
- No mandatory agent conveyor, model quorum, review-of-review or status-only handoff ([agent routing](.github/agents/README.md)). Name an unmet criterion before adding process.
- Always keep current-SHA CI, protected ancestry, origin/ownership approval, immutable deployed identity, physical single-writer locks/fences, data integrity, compatible recovery and observed health. Existing executable controls stay authoritative until replacements are proven and activated.
- Precise UI geometry or interaction claims need the smallest rendered evidence; see `docs/wiki/UI-UX-Consistency.md`.

## Shared Common package

`common/src/` is the source for the next `@betstan/common` candidate: a normal tracked directory, never a submodule, gitlink, workspace or `file:` dependency. Services compile against their exact published pin. Read `common/README.md` first; keep all eight backend consumers on one exact version, bump after each publish, prove old/new and rollback compatibility, and validate the packed artifact. Only `.github/workflows/common-package-publish.yml` may publish, from an exact current `master` first attempt via `common-package-release`, under `next`, preserving `latest`.

## Protected operations

Approval is classified by origin, not workflow type, for deploy, activation, capacity, infrastructure, GHCR, live-data, migration, recovery and rollback.

- CLI-dispatched operations use `copilot-cli-dispatch-stan.sh` with an operation-specific request stored outside the repository. It binds the exact run, workflow ID/path/blob, input hash, control and subject SHAs, event and environment to a private one-run record; `copilot-cli-run-approval-stan.sh` may approve that exact first attempt. Human dispatches, direct `gh workflow run`, schedules, reruns, stale master or mismatched records stay personally gated. Never create or retrofit a record for a human run.
- Ambiguous dispatch without a captured run stays blocked; recover only via the dispatcher's resume paths, never by inference or redispatch. Ambiguous approval stays `inflight`; use the approver's `--reconcile`, never replay the POST. Terminal zero-job runs may only be `retired`, never approved or rerun.
- Unresolved `dispatching`/`bound`/`claimed`/`inflight` state blocks every protected dispatch for the repository and control SHA; `issued`/`consumed` blocks the same operation and input hash. Only `retired` is inert.
- Authority formats are forward-only: never roll the helper or dispatcher back below a version whose records exist (v2, v5), delete spent archives or hand-edit authority; use exact recovery or a reviewed forward correction.
- Workflow state at approval is policy-defined: the OCI capacity, infrastructure, live-betting activation, live-data rollout, migration-recovery and production-deploy workflows are `disabled_manually`; others `active`. Keep a disabled workflow enabled only until the captured run shows a real job and pending gate. Revalidate control, state, blob and promotion authority after each claim.
- OCI release order: GHCR validation, then (k3s only) capacity acquisition, infrastructure finalization, live-data handoff, deployment. Every prerequisite is an explicit hash-covered input validated before authority is issued, because authority is one-use.
- Data and deploy authority require the exact `k3s-release-disk-checkpoint.v1` artifact; any key, identity, residency or 70-percent drift fails closed.
- Recovery profiles are fixed contracts binding original build, infrastructure and checkpoint lineage; byte-equivalent new runs are not substitutes.
- Every OCI release needs a fresh exact-SHA final `oci-live-data-rollout` handoff before deployment. The handoff keeps maintenance and the shared-Mongo lock until the bound deployment validates; deploy immediately. Deployment renews the lock without acquire fallback and releases lock before fence.
- `oci-production-rollback` maintenance mode is bound to the exact incomplete deployment and baseline; it is never a skip or bypass. A failed generation is never a rollback baseline.
- `oci-live-data-incident-restore` is limited to `infra/oci/incident/manifest.json`, verified by `incident_manifest_stan.py`; no caller-selected inputs, and takeover authority comes from provider timestamps, never runner clocks.

## Production safety

Merging to `master` runs validation and queues the first-attempt image build for approval in `production-emergency`; production never deploys automatically. Dispatch `production-deploy` from `master` with the exact full SHA and build run ID; it needs a second approval and deploys immutable tag-plus-digest images. Rerun builds are not deployable; retired workflows stay disabled.

## Trusted-check bootstrap

The trusted publisher requires the protected quality workflow to be byte-identical to the default branch. Prefer extending an existing guard that `production-build.yml` already runs.

To change the workflow itself: first promote a separate, reviewed, fail-closed one-use exact-blob authorization in the publisher; then authorize and merge only the intended blob, remove the authorization, and verify fresh statuses from the expected workflow IDs. Prove strict base ancestry first. Never invent an authorization variable before the publisher implements and tests it, and never reset a consumed receipt.

Transition markers, label ledger, ancestry-sync provenance and receipt rules are implemented in [`publish-pr-policy.js`](.github/scripts/publish-pr-policy.js) and [`branch-policy.yml`](.github/workflows/branch-policy.yml), the sole status-writing workflow. Rollback must keep readers for every emitted marker version (v3 ledger authority included); tombstones dominate, conflicts fail closed.

## Commands

```bash
./infra/azure/agents/pre-commit-infra-check-stan.sh
./infra/azure/agents/pr-merge-safety-stan.sh <pr>          # review head_sha and production_workflows
APPROVED_SHA=<sha> APPROVED_WORKFLOWS=<list> ./infra/azure/agents/pr-merge-safety-stan.sh <pr>
PR=<promotion-pr> ./infra/azure/agents/post-merge-verification-stan.sh
```
