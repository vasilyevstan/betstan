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

### Treat broker backpressure as a consistency boundary

One service replica can still process many unacknowledged messages
concurrently. When a consumer updates one aggregate through bounded
compare-and-swap retries, its prefetch limit and rollout strategy must preserve
that write-concurrency bound. Tests should hold one consumed message open and
prove the next message does not enter the handler until acknowledgement.
Rejected async handlers also need an explicit shutdown path so redelivery does
not depend on a runtime default.

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

### Prove prerequisites before spending one-use authority

A protected operation should carry explicit, hash-covered identities for every
upstream run it depends on. Validate the exact workflow, source revision,
current first-attempt status, title, complete paginated artifact inventory, and
chronological lineage before authority is issued, again immediately before
approval, and inside the workflow before cloud access. Bind package validation
to the exact build run it inspected rather than only to a shared source SHA,
and validate the bounded contents of the exact selected artifacts rather than
trusting names alone. Serialize the global blocker scan and intent creation
with a repository claim lock; atomic per-request files do not prevent two
different requests from claiming an empty store concurrently.
If a previously dispatched but unissued run loses a prerequisite, match its
exact request, hold its authority lock, and persist pre-cancel evidence in a
`rejecting` state before cancellation. Resume delayed terminalization from
that persisted state. Release the serialization fence only after two stable
observations prove exact cancellation, no approval, no successful job step,
and no pending deployment; otherwise preserve the rejecting fence for explicit
recovery.
Persist the exact pre-cancel and terminal snapshots as well as canonical
hashes. Hash exact multiline diagnostics while storing only a bounded one-line
summary so diagnostic formatting cannot block durable recovery. If `master`
advances while the fence is unresolved, allow only the matching old request to
continue cancellation from a clean current-master checkout after proving the
recorded control remains an ancestor and its historical workflow blob is
unchanged. Record both the historical control and the actual live retirement
master. Never extend that historical-control exception to dispatch, issue, or
approval, and ignore a current-master ghost only after refreshed evidence
proves it is pristine and its workflow is manually disabled.

Do not generalize ghost supersession across mutating workflows. Active stale
data and activation runs remain fences; only a pristine approval-free capacity
ghost may be superseded by an exact later successful first attempt. After an
approval claim, use an explicit short-circuiting check sequence and operate
only on the originally claimed gate identity. Place final provider-boundary
checks in the live mutating job and bracket upstream validation with fresh
`master` and runtime-mode observations.

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

### Approval policy outranks agent memory

Automatic approval eligibility is determined by the checked-in operation
policy and the exact durable CLI authority record. A sensitive workflow is not
human-only merely because an agent remembers it that way. When a listed
CLI-issued operation reaches a waiting gate, route the bounded approver in the
same checkpoint; polling an eligible gate is an orchestration defect.

### Recovery is not diagnosis

A service returning `200` again proves current availability, not why it
failed. Keep risky feature activation fenced until container-level previous
state, exit code, reason, timestamps, and bounded previous logs are captured.
Separate startup allowance from steady-state liveness so a dead listener is
restarted promptly without penalizing normal boot time.

### A read-only HTTP probe can still change availability

An unknown URL still executes application fallback code. Express 4 does not
automatically forward a rejected async handler unless the service loads an
explicit integration, so an async catch-all that throws can turn an anonymous
probe into a process exit. Fallbacks should pass errors through `next` or an
established wrapper. Tests must repeat unmatched requests, then prove a valid
route remains available; production checks also compare restart counts and use
documented routes rather than guessed health URLs.

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
