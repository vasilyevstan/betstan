# Contributing to BetStan

## Branch flow

`master` is the production branch. Never commit or push directly to it.

Use this flow:

1. Make normal changes on a feature, fix, or operations branch and integrate them into `dev`.
2. Validate the complete `dev` branch.
3. Promote production only with an up-to-date pull request from `dev` to `master`.
4. Require the trusted, base-scoped `branch-policy/master` and `pr-quality-gates/master` statuses on both the promotion head and current merge snapshot to pass.
5. Before merging a promotion, bind approval to the exact head SHA and every production-capable workflow the diff will trigger.
6. After a squash promotion, immediately merge the new `master` commit back into `dev`.

Never push directly to `dev`; integrate focused feature, fix, or operations branches through pull requests. Pull requests into `master` from any branch other than `dev` are forbidden.

### Concurrent feature delivery

Independent sessions may develop and merge compatible changes through separate
pull requests. A `dev`-to-`master` promotion may intentionally contain several
reviewed features; a release is not required to reproduce one session's tree
in isolation.

Each releasing session records the commit or commits its requirement depends
on. Before claiming release completion, prove every required commit is an
ancestor of the exact current `master` SHA selected for build and deployment.
Additional protected commits are allowed, but the complete aggregate candidate
must pass its own exact-SHA checks, workflow inventory, rollback readiness, and
production acceptance. If `master` advances during a release chain, supersede
the stale chain and adopt the new exact current-master candidate when it still
contains the required commits; never reset `master` or deploy an older SHA to
preserve session exclusivity.

Development and PR integration may proceed concurrently. Production-capable
workflow dispatches, data mutations, deployments, activation, rollback, and
recovery remain serialized by the existing exclusivity and operation-lock
contracts.

## Pull request evidence

Treat every pull request description as durable review and release evidence,
not as a short notification. Use `.github/pull_request_template.md`. The
following core evidence is required on every PR; conditional operational fields
remain present and say `not applicable` when they do not apply:

- why the change exists and the failure or requirement that triggered it;
- exact base/head SHAs and, for promotions or ancestry syncs, the resulting
  merge SHA;
- changed scope, compatibility effects, and explicit exclusions;
- commands and exact validation outcomes;
- full production, data, feature-flag, and rollback evidence when applicable;
  keep each field present and write `not applicable` otherwise;
- the reason for an intentional closure, replacement, or zero-diff ancestry
  change.

Every pull request that changes what a user sees or how a user interacts must
also include an exact-head `betstan-ux-ui-expert` result. Use one registered
two-phase specialist work unit: establish the named reference pattern before
implementation, then review the immutable result. Record the affected routes,
components, states, UI variants, themes, and viewport classes; the stable
reference screens/components/tokens; every intentional exception and its
product rationale; the final UX status and head SHA; and any evidence gap.
Non-user-facing changes write `not applicable`.

Pull request titles must be short, plain-language outcomes that a reviewer can
understand without opening the diff, such as `Add second-half score betting` or
`Fix live slip alignment`. Do not use ambiguous category labels such as
`chore`, `misc`, or `wip`. Merge safety rejects those prefixes, single-word
titles, and titles longer than 72 characters.

## Public wiki gate

Every change receives a `betstan-public-wiki-editor` assessment after
implementation and before immutable review. Changes to product behavior,
architecture, contracts, data lifecycle, security, infrastructure, quality
gates, release behavior, UI/UX, or agent responsibilities update the relevant
canonical `docs/wiki/` pages in the same pull request. A no-change result is
valid only when the exact diff has no public documentation impact and the
assessment explains why.

The repository files are the reviewed source of truth. After the exact commit
is merged, publish `docs/wiki/*.md` byte-for-byte to the GitHub wiki and verify
the resulting pages and links. Public documentation must omit credentials,
private approval records, local/session paths, private infrastructure
identifiers, unredacted production data, and actionable bypass or emergency
procedures.

The UX specialist may establish a consistency finding from source, stable
references, or supplied screenshots. A new screenshot suite is not mandatory
solely because a change is visual, but precise clipping, collision, overflow,
touch-target, pixel-geometry, or dynamic-interaction claims require the
smallest appropriate rendered evidence. See
`docs/wiki/UI-UX-Consistency.md`.

Keep this detail on implementation, promotion, synchronization, and closed
attempt PRs. `production-build`, `oci-validate`, and branch policy run on
`pull_request.edited`, so title/body restoration is workflow-producing work.
Do not edit historical PR metadata during an active data-to-deploy handoff or
other production-exclusivity window. Make the edit before or after that window
and wait for the resulting checks to become terminal. Derive the exact head SHA
from Git or GitHub immediately before preparing the final description, and
prefer one complete metadata edit over repeated corrections that start
duplicate validation runs.

Copilot CLI-created pull requests carry the `copilot-cli-managed` label. Only
Copilot CLI may apply it, and only to a PR that the active CLI workflow created
and owns; never relabel an existing human PR. Because the CLI and a human using
`gh` share the same GitHub identity, this label is an operational convention,
not cryptographic attestation.

CLI-managed PRs may use `COPILOT_CLI_AUTO_APPROVE=true` without a separate
personal prompt only after the merge-safety script verifies the label, exact
refs, trusted required checks, resolved review threads, production workflow
inventory, and absence of actionable competing production activity. Every
other PR requires `APPROVED_SHA` equal to its exact current head, including
PRs targeting `dev`. Human `master` promotions also require the exact
`APPROVED_WORKFLOWS` inventory. Automatic mode never skips required checks,
immutable-SHA gates, or production safety.

Do not merge a PR until `pr-merge-safety-stan.sh` passes in the correct
automatic or human mode for its exact current head.

## Shared Common package

`common/src/` is the repository-owned source for the next
`@betstan/common` package candidate. It must remain a normal tracked directory,
never a submodule, gitlink, workspace dependency, or `file:` dependency.
Deployable services compile against the exact published version in their own
manifest and lockfile; source existing in this repository is not implicitly
available to those images.

Read `common/README.md` before changing a shared contract. Keep all eight
backend consumers on one exact published version, bump the Common source
version after an immutable version has been published, prove old/new
producer-consumer and rollback compatibility, and validate the packed artifact
without allowing npm to re-resolve unrelated dependencies. Package publication
and consumer repinning are separate reviewed release steps.

Only `.github/workflows/common-package-publish.yml` may publish this package.
It is a protected, first-attempt, exact-current-`master` dispatch through
`common-package-release`; it publishes one reviewed tarball under `next`,
preserves `latest`, and retains registry byte-identity and provenance evidence.

Protected environment approval is classified by origin, not workflow type.
Every protected operation dispatched by the active Copilot CLI must use
`copilot-cli-dispatch-stan.sh` with an operation-specific JSON request stored
outside the repository. Before calling GitHub, the dispatcher persists a
private `dispatching` intent and mode-`0600` output capture. It then binds the
exact returned run ID, workflow ID/path/blob, transport input hash, current
control SHA, subject or historical target SHA, title, event, and environment
to a private one-run authority record. `copilot-cli-run-approval-stan.sh` may
approve that exact first attempt without a personal prompt. Automatic build
chains receive the same durable approval record after deriving authority from
the labelled promotion and exact upstream run; recovery chains must derive
from an exact consumed upstream record. A human dispatch, direct
`gh workflow run`, scheduled run, stale master, rerun, mismatched record, or
competing production run remains personally gated.

This authority applies equally to deploy, activation, capacity,
infrastructure, GHCR package management and cache repair, live-data work,
broad migration, recovery, and rollback. It never bypasses workflow
confirmations, package visibility checks, provenance, rollback readiness,
runtime locks, or post-operation validation. A package sentinel still does
not replace the one-time Package settings visibility change or anonymous-pull
proof. Build repair must cite the exact failed first-attempt build and its
successful first-attempt `production-build`; it rebuilds and digest-compares
existing tags instead of trusting or overwriting them.

The repository and `gh` use one GitHub identity, so the private one-run record
is an operational ownership boundary rather than cryptographic identity.
Never create, copy, or retrofit a record for a human-created run. An ambiguous
dispatch with no captured run URL remains blocked for explicit operator
reconciliation; never infer a run from timing or title. After a dispatcher
crash, use `--resume-captured` when the durable capture contains the URL, or
`--resume-run <run-id>` after a bound run has not materialized. A terminal
first-attempt run may become `retired` only when it has zero jobs and zero
pending deployments. An ambiguous approval response leaves the record
`inflight`; use the approver's explicit `--reconcile` path and never replay the
POST directly. Reconciliation may consume the gate only when GitHub review
history contains a new exact approved review for the recorded reviewer,
comment, environment, downstream run, and operation. Otherwise it restores
retry authority only while the same active gate remains, or stays unresolved
and fail-closed.

Any unresolved `dispatching` or `bound` intent, or `claimed` or `inflight`
record, blocks every protected dispatch for the same repository and control
SHA even when the requested operation or inputs differ. An `issued` or
`consumed` record blocks the same operation and exact transport input hash;
changed inputs are a new request and still require all normal policy,
lineage, exclusivity, and recovery checks. `retired` is the only inert
replacement exception. After persisting a pristine dispatch intent, recheck
master, workflow blob, and active state before dispatch and cancel only that
untouched intent if authority drifted.

The shared policy also declares the required workflow state at approval.
`oci-capacity-acquire.yml`, `oci-infrastructure.yml`,
`oci-live-betting-activate.yml`, `oci-live-data-rollout.yml`,
`oci-migration-recovery.yml`, and `oci-production-deploy.yml` must be
`disabled_manually`; every other protected workflow must be `active`.
Revalidate control, workflow state/blob, and promotion authority after the
local `inflight` claim. If they changed, release the exact claim back to its
previous `issued` or `consumed` state and do not call GitHub.

Every OCI release requires a new exact-SHA final
`oci-live-data-rollout` handoff before deployment. Application or schema
changes chain `dry-run` → `apply-backfills` → `apply-slip-index`; only the
workflow's validated GitHub/infra/Markdown-only descendant resume may reuse an
already applied chain, and it still produces a new final handoff.
`oci-production-deploy` requires that hash-bound evidence and pre-mutation
rollback baseline from the same build and infrastructure runs. Mutating phases
fence public writes and quiesce legacy data writers. A successful final phase
deliberately retains that maintenance state and the shared-Mongo operation lock
until the exact deployment passes protected validation, so dispatch the bound
deployment immediately; an incomplete deployment re-enters the same
fail-closed state for a safe retry.

## Production safety

Merging to `master` runs validation, then queues the first-attempt image build for approval through the master-only `production-emergency` environment. Production never deploys automatically. After the build succeeds, dispatch `production-deploy` from `master` with the exact full SHA and build run ID; the same environment requires a second approval. The workflow validates all nine build artifacts and deploys immutable tag-plus-digest image references. Rerun builds are not deployable, and retired workflow identities remain disabled.

For a manually disabled production workflow, a successful dispatch command or
returned run URL proves only that GitHub accepted the event. Keep the workflow
enabled until the captured exact run has a real job and, when protected, the
expected `pending_deployments` gate. Then disable it before approval. Capture
the run ID through the policy dispatcher's durable capture instead of
depending on an early display title. Recover a captured URL or delayed bound
run through the exact resume path; never redispatch it. A terminal record with
zero jobs and zero pending deployments is not release authority and may only
be persisted as `retired`; it must never be approved or rerun.

Do not rewrite or force-push `master` or `dev`. Preserve unrelated tracked, staged, and untracked work.

## Trusted-check bootstrap

The trusted publisher currently requires the protected quality workflow to be byte-identical to the default-branch copy. Prefer extending an existing checked-in guard or test entrypoint that `production-build.yml` already invokes; this preserves the trusted workflow identity while still exercising the new validation.

If the workflow file itself must change, first add and independently review a fail-closed, one-use exact-blob authorization mechanism in the trusted publisher without changing the workflow. Promote that policy separately, then authorize and merge only the intended workflow blob, remove the authorization, and verify fresh statuses come from the expected workflow IDs. Do not invent or document an authorization variable before the publisher implements and tests it.

An exact-blob authorization is consumed by the first successful exact quality
run for its PR transition. A workflow-producing pull-request event first
publishes an unbound pending transition barrier, then binds the exact newly
registered quality run. Only that transition's completed workflow run may
publish success. The trusted marker is stored on the exact merge snapshot and
includes a bounded title/body fingerprint. The publisher accepts it only from
the GitHub Actions bot with a validated repository `branch-policy` run target,
and that run must carry the exact PR, head, and base relation. Governance keeps
`branch-policy.yml` as the sole status-writing workflow and requires every
workflow job to declare effective token permissions instead of inheriting the
mutable repository default. Only the bound run may satisfy the transition; a
different `workflow_run` completion remains pending, and the selected run must
strictly postdate both the event timestamp and any authorization issuance. A
delayed run can bind an unbound marker through its exact `workflow_run` or a
manual trusted refresh, but a manual refresh cannot create a missing marker or
act as quality evidence. Version 3 quality markers use
`v3|<pr>|<action>|<cutoff-ms>|<u|p|x|runId>|<content-fingerprint>|<labels-fingerprint>`.
`u` records only an unconfirmed direct opening-label snapshot mismatch, `p`
records a confirmed transition without a bound run, a positive run ID records
the confirmed exact binding, and `x` permanently tombstones the cutoff. A `u`
marker cannot bind a run, publish quality success, or consume an authorization
receipt. The qualifying exact `labeled` event appends durable `p` before any
optional run binding, and a label handler never consumes an authorization
receipt. Opening-label reconciliation is authorized only when the server-owned
label timestamp is at or after the original `opened` transition cutoff and no
more than 300,000 ms (five minutes) after it; queueing, replay, or re-execution
cannot extend that window. GitHub may serialize distinct creation and label
mutations to the same whole-second timestamp. Equality is accepted only with
the complete direct or inverse proof; a timestamp even 1 ms before the cutoff
is not reconciliation authority. Direct ordering also requires the label
timestamp to strictly precede the earliest exact-lineage status creation, while
inverse ordering requires identical event and live `updated_at` values and
allows the marker on either side of the label. An exact replay of the same
qualifying `labeled` event is inert after `p` or a run is durable; a later label
mutation remains drift.
Recovered opening-label authority is revalidated before every success-capable
refresh, `workflow_run`, manual dispatch, or replayed `opened` event by a
bounded server-owned issue-event ledger. The ledger must prove exactly one
`copilot-cli-managed` `labeled` event within the original five-minute window
and no matching `unlabeled` event. Any managed-label removal, second
application, or application outside that window is proven drift and writes
permanent `x`. Any fully validated managed `unlabeled` event, second managed
`labeled` event, or out-of-window managed `labeled` event is individually
sufficient, irreversible disproof: it writes permanent `x` immediately even
on a full ledger page because unread appended events cannot restore the
lineage; only positive authority requires scan completion. API, schema,
duplicate-ID, missing, and incomplete ledger evidence remains inconclusive
without `x` only when no disqualifying event has already been observed.
`branch-policy.yml` grants only `issues: read` for this ledger; the publisher
and permission must promote together.
The broad opening snapshot mismatch permits only fail-closed inspection and
never grants reconciliation: an out-of-window replay without a marker stays
pending, an existing mismatch writes the permanent tombstone, and any
intervening `updated_at` change fails closed. A same-cutoff tombstone cannot be
replaced or revived; only a strictly later `edited`, `synchronize`, or
`reopened` transition can recover the lineage. The original transition cutoff,
run binding, and policy-run target remain authoritative. `labeled` and
`unlabeled` are non-producing refreshes. All other post-marker label drift
appends a permanent pending tombstone, so restoring labels, completing an older
run, or manually refreshing cannot revive that lineage. At the greatest
cutoff, `x` dominates every other state; absent `x`, any version 1 or version 2
marker makes that cutoff fail-closed legacy; otherwise one compatible version
3 lineage resolves positive run ID over `p` over `u`, independent of status
order. Conflicting positive run IDs or incompatible action, content, policy-run
target, or label progression fail closed, and a lower state cannot downgrade a
higher state. Version 1 and version 2 markers cannot newly bind, succeed, or
consume an authorization receipt; a version 2 `x` remains a permanent
tombstone. Only a strictly later `edited`, `synchronize`, or `reopened`
transition may recover, never a later or replayed `opened` event. Once any
version 3 marker exists, operational rollback must retain version 3 parsing
and ledger authority: recovered opening-label authority is not durable in
marker v3, so every publisher able to bind or succeed such a lineage must
revalidate the ledger; retaining version 3 parsing alone is insufficient, and
rollback to a publisher lacking ledger authority is prohibited; use a
reviewed forward correction. Other non-producing metadata does not form marker
identity.
The publisher uses the fetched `updated_at` only to recheck the complete PR
snapshot before and after status publication and replaces any concurrent result
with pending. Any later edit, synchronization, base advance, or status refresh
still requires the applicable short-lived authorization and receipt anchor; a
consumed receipt is never reset or reused.

The trusted publisher binds both required status targets to the same current PR head SHA, base SHA, repository, trusted workflow runs, and unique test-merge SHA. Head-only or merge-only evidence is not a promotion gate.

Before proposing a production promotion:

```bash
./infra/azure/agents/pre-commit-infra-check-stan.sh
# Inspect and explicitly review the printed head_sha and production_workflows.
./infra/azure/agents/pr-merge-safety-stan.sh <pr-number>
# Re-run with the exact reviewed SHA and production workflow inventory.
APPROVED_SHA=<head-sha> APPROVED_WORKFLOWS=<comma-separated-workflows> \
  ./infra/azure/agents/pr-merge-safety-stan.sh <pr-number>
```

After an approved promotion:

```bash
PR=<promotion-pr-number> ./infra/azure/agents/post-merge-verification-stan.sh
```
