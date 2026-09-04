# Engineering Learnings

## Purpose

This page distills reusable lessons from BetStan's implementation and release
history. It intentionally shares principles, failure modes, and validation
patterns rather than private operational records or recovery recipes.

## Architecture and service boundaries

### Persist intent before publishing

A successful database write followed by a failed message publish creates a
split-brain outcome. Critical mutations therefore persist a pending
publication marker in the same state change, publish with broker confirmation,
and replay after restart until confirmed.

### Design for duplicate and reordered delivery

At-least-once messaging means duplicates and reordering are normal conditions,
not edge cases. Stable request IDs, placement attempts, versions, sequences,
terminal ledgers, and parked updates make replay safe.

### Keep projections separate from authority

Fast browser projections and SSE streams improve responsiveness, but they do
not become the authoritative source of terminal state. Important transitions
reconcile against the durable read model.

### Make mixed-version behavior explicit

An additive field is safe only when:

- old consumers ignore it;
- new consumers define a safe default when it is absent;
- producer and consumer bounds agree;
- rollback can still read documents written by the new version.

The compatibility proof belongs in the design and tests, not in an assumption
that every service deploys simultaneously.

### Prefer lifecycle-triggered retention when the lifecycle is reliable

A small projection does not always need a new scheduler. Event cleanup is
attached to the already-authoritative pre-match handoff that retires the prior
finished match. The operation removes only terminal or offline projections
older than the retention window, remains idempotent, and lets message retry
surface database failure. Active anomalies remain visible rather than being
silently erased.

## Betting and live-state correctness

### Separate domains at the model boundary

Live and pre-match selections use separate boards and one explicit `betKind`.
The UI distinction is not enough; the Slip and Moderation services enforce the
same invariant.

### Bind a live selection to its quote

A visible odds number is not sufficient authority. A live selection carries
market identity, market version, quote version, selection identity, selection
time, and validity boundary. Moderation rechecks those values against
authoritative history.

### Terminal state must be monotonic

Concurrent result, visibility, and live-update writers can otherwise reopen or
hide a finished event. Terminal transitions use conditional writes and
sequence guards so delayed work cannot reverse a stronger state.

### Realism is statistical, not theatrical

Forcing every match to contain every incident creates less realistic data.
Deterministic corpus tests are a better way to prove that incidents occur
through both halves, stoppage remains a minority, and individual matches may
still be quiet.

## User experience

### Do not confuse a recent tail with a complete history

A bounded "last events" list must not be labelled as a full match summary.
Completeness requires producer attestation and successful bounded retention;
legacy or partial data is labelled honestly.

### Preserve identity while changing presentation

Compact labels, sorting, and responsive movement must keep the original
selection ID, name, value, and click payload together. Never reconnect values
to options by array index after sorting.

### Consistency is measurable

Long content can shift sibling headings and odds even when every control is
clickable. Cross-card baselines, control bounds, touch targets, overflow,
focus order, and responsive height are testable acceptance criteria.

### Use available width before hiding information

A prominent live card should use the stage width and parallel semantic regions
before introducing clipping, nested scrolling, or avoidable vertical growth.
Sparse grids should collapse empty tracks.

### Public means usable

A visible navigation item is not proof of access. If a capability is public,
anonymous and ordinary users must reach its real data and controls, not an
authorization-denial screen.

## Testing

### Test the invariant, not one convenient fixture

Examples:

- realism across a deterministic seed corpus rather than one match;
- every result/full-time interleaving rather than the common order;
- duplicate and out-of-order messages rather than one ideal delivery;
- asymmetric long names rather than equal placeholder content;
- legacy missing fields rather than only newly written rows.

### Match evidence to the claim

Unit tests prove pure logic. Integration tests prove persistence and message
boundaries. Browser tests prove geometry, accessibility, and interaction.
Production acceptance proves the deployed composition and operational
dependencies.

### Treat first-attempt behavior as a contract

If downstream provenance accepts only attempt one, a failed run is terminal
evidence. Fix the cause and create a new exact candidate rather than rerunning
the failed authority.

## Release and operations

### Build and deploy exact immutable identities

Branch names and mutable tags are convenient pointers, not release identity.
Review, build, artifact, image, deployment, and acceptance evidence should
resolve to one exact source SHA and immutable image digests.

### Release by inclusion, not session exclusivity

Parallel development does not require parallel production mutation or one
release per session. Record the commits each outcome requires, prove they are
ancestors of the exact current `master`, and validate that complete aggregate
candidate. If `master` advances, supersede the stale chain instead of blocking
on unrelated protected commits, resetting shared history, or deploying an
older SHA. Keep deployment, data changes, activation, and rollback serialized.

### Make public documentation part of the change

Documentation should not be a best-effort cleanup after release. Every change
gets a public-wiki impact assessment, relevant canonical pages change in the
same pull request, and merged pages are published byte-identically. Public
documentation explains behavior and safety invariants without exposing
credentials, private approval state, live records, or actionable bypass
procedures.

### Name pull requests by their outcome

A pull request title is release evidence, not an internal work bucket. Prefer
short plain-language outcomes such as `Add second-half score betting` or
`Fix live slip alignment`. Ambiguous prefixes such as `chore`, `misc`, or
`wip` hide intent and should fail merge safety.

### Capture rollback before mutation

Rollback readiness is established before changing production. The baseline
must identify the exact prior application generation and any data or
compatibility constraints required to restore it.

### Separate deployment from activation

A dark deployment can prove images, health, data compatibility, routing, and
readiness before enabling a user-facing feature. Activation remains bounded
until the full acceptance journey passes.

### A watcher is not progress

Long-running output or a queued workflow can hide a waiting approval, missing
job, or completed handoff. Orchestration should inspect the underlying state
at bounded checkpoints and assign the next action immediately.

### Correct false safety blocks without weakening safety

When a repository rule itself causes a proven false block, fix that exact rule
and add a regression test. Do not bypass the gate, broaden authority, or
misclassify a real production risk as policy friction.

## Shared package

`common/src/` is source for a future package release, while deployed services
use immutable published versions. Package publication and consumer repinning
are separate reviewed changes. This distinction prevents an unbuilt local
source edit from being mistaken for runtime compatibility.

## What this public page omits

The following belong in protected operational evidence, not a public wiki:

- credentials, tokens, cookies, private keys, kubeconfigs, or secret values;
- private approval records, dispatch payloads, and automation state files;
- cloud account, resource, cluster, network, or live host identifiers;
- emergency commands and step-by-step bypass or recovery procedures;
- exact operational timing windows, capacity thresholds, or queue limits;
- unredacted production logs, screenshots, user data, and local session paths.

The public lesson should explain the invariant and why it exists. Authorized
operators can use the reviewed private evidence and repository runbooks for
the exact procedure.

## Related pages

- [[Architecture]]
- [[Message Flows]]
- [[Security]]
- [[Quality Gates]]
- [[Release Orchestration]]
- [[UI UX Consistency]]
