# Engineering Learnings

## Purpose

This page distills reusable lessons from BetStan's implementation and release
history. It intentionally shares principles, failure modes, and validation
patterns rather than private operational records or recovery recipes.

This page also archives the useful historical detail from
[the original session learnings](https://github.com/vasilyevstan/betstan/blob/42ea4ce073f45dd28108e297d4d2dd658f216bd1/LEARNINGS.md),
organized by topic rather than incident chronology. Operational records and
privileged recovery recipes are generalized, not reproduced.

These are historical lessons, not a second delivery policy or evidence of
current runtime health, deployment, or controller activation. Imperative
wording below explains failure prevention; it creates no additional mandatory
agent gates. Current
[CONTRIBUTING.md](https://github.com/vasilyevstan/betstan/blob/master/CONTRIBUTING.md)
owns branch and approval rules, and
[the agents README](https://github.com/vasilyevstan/betstan/blob/master/.github/agents/README.md)
owns conditional routing and evidence reuse. [[Agents]] explains those
capabilities publicly; [[Quality Gates]] distinguishes active controls from
candidate-only work. Existing executable controls govern until a replacement
is proven and activated. Historical counts, versions and incident outcomes
are not a current service inventory or rollback baseline.

## Architecture and service boundaries

### Persist intent before publishing

A successful database write followed by a failed message publish creates a
split-brain outcome. Critical mutations therefore persist a pending
publication marker in the same state change, publish with broker confirmation,
and replay after restart until confirmed.

A pending marker is restart recovery, not same-process serialization. For an
immutable terminal operation, share the active publication promise by exact
operation and aggregate identity. Mutable targets need their version or exact
target in that key. Rolling pods can still publish duplicates, so consumers
remain duplicate-safe. Creation retries also need a stable request identity:
an ambiguous response must not create another event.

### Design for duplicate and reordered delivery

At-least-once messaging means duplicates and reordering are normal conditions,
not edge cases. Stable request IDs, placement attempts, versions, sequences,
terminal ledgers, and parked updates make replay safe.

`APublisher.publish()` stamps envelope timestamp and sender at send time;
the timestamp changes on retry. Domain ordering and idempotency
therefore prefer immutable event data such as server-generated `submittedAt`,
not transport time. Historical placement compatibility used submission time,
then envelope time, then a row timestamp, then current time. Tests that
construct events without a publisher need those missing-envelope cases.

Historical AMQP lessons:

- Shared `AListener`/`APublisher` APIs used structural `IAmqpConnection`, not
  version-specific connection types that broke consumers with different
  compatible AMQP type packages.
- Creating and initializing a publisher for every message exhausted channel
  limits. Listener-owned publishers were initialized once after
  `super.init()`; workers exposed initialization before starting work.
- Producer and consumer schemas, including command-boundary fixtures, evolve
  together. A realistic structured lock fixture cannot be replaced by an
  obsolete text summary without losing lease and fencing semantics.

### Treat broker backpressure as a consistency boundary

One service replica can still process many unacknowledged messages
concurrently. When a consumer updates one aggregate through bounded
compare-and-swap retries, its prefetch limit and rollout strategy must preserve
that write-concurrency bound. Tests should hold one consumed message open and
prove the next message does not enter the handler until acknowledgement.
Rejected async handlers also need an explicit shutdown path so redelivery does
not depend on a runtime default.

For a queue-only singleton whose durable queue buffers startup, a
non-overlapping Deployment strategy prevents a second aggregate writer
during rollout. One replica alone does not establish that guarantee.

### Keep projections separate from authority

Fast browser projections and SSE streams improve responsiveness, but they do
not become the authoritative source of terminal state. Important transitions
reconcile against the durable read model.

SSE is a bounded delivery hint. Backpressure should close and unsubscribe
the response rather than accumulate an unbounded per-client queue. Clients
reconnect, reconcile gaps through REST, and reject lower/equal snapshots.
Periodic authoritative reconciliation still matters while SSE is healthy:
visibility removal and pre-match changes may not emit live snapshots.

### Make mixed-version behavior explicit

An additive field is safe only when:

- old consumers ignore it;
- new consumers define a safe default when it is absent;
- producer and consumer bounds agree;
- rollback can still read documents written by the new version.

The compatibility proof belongs in the design and tests, not in an assumption
that every service deploys simultaneously.

Before a producer persists a new enum value, a compatibility baseline can
accept and replay it without generating it. That baseline, not the older
generation, becomes the compatible rollback target. Likewise, removing
environment bindings unused by a new image can break an image-only rollback
whose predecessor still requires them.

Durable pending-publication data is forward-compatible but cannot make an
older image replay it. Rollback compatibility must account for unconfirmed
writes and the target's replay worker; partial failure must preserve write
containment. An older image that strands acknowledged database mutations is
not a safe rollback merely because it starts.

### Give scheduling one owner

Historical scheduling assigned future-event generation to Event, not a
catalog GET or Gamemaster replacement logic. Deterministic epoch-aligned
slots and a partial unique `slotKey` index let rolling pods converge without
leader election. Short-lived publication claims plus pending markers support
at-least-once retry. Backoffice and legacy events without a scheduler slot
stay outside scheduler counting, modification, deletion and republication.

### Make aggregate mutation predicates atomic

- Index inspection on a new Mongo database may report `NamespaceNotFound`.
  Only that known empty-namespace case (code 26) permits guarded
  initialization; other inspection errors remain failures.
- Raw inserts/upserts bypassing Mongoose `save()` need an initialized version
  key (`__v: 0`) when later writes use optimistic concurrency. Historical
  versionless rows need atomic initialization and reload, including in
  backfills.
- Board revision and fingerprint are authorization evidence. Every draft-row
  mutation, including deletion, rotates them. Mutation predicates bind owner,
  slip, kind, draft status and both values at write time; a stale pre-read
  cannot authorize changing a submitted or newer board.
- A decline-restoration merge targets only a still-draft replacement.
  Duplicate delivery must not resurrect a submitted or archived replacement.
- Compose independent `$or` predicates under `$and`: object spreading two
  top-level `$or` keys silently removes one safety condition. Publication
  claims atomically require both an unpublished decision and a claimable
  lease.
- Rolling-client confirmation evidence is session-scoped as well as bound to
  user, kind, slip, revision and fingerprint. A single slip-global confirmation
  lets one device authorize another device's stale tab. The historical
  compatibility fallback was separate, one-time and not overwritten by
  ordinary reads; explicit new-client confirmation remained authoritative.
  Submitted-board polling must not create draft authorization.
- Terminal recovery includes zero-row approved parents after manual-void
  publication, missing legacy publication state, pending state, stale or
  timestampless claims, and published-but-not-archived records. Published
  records are archived without republication; live claims stay outside
  bounded sweeps, and auxiliary cleanup finishes before removing the recovery
  anchor.

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

Historical quote corrections separated settlement identity
(`marketId + marketVersion`) from quote authority (also `quoteVersion`).
One quote identity maps to one validity boundary: a material expiry advance
increments the quote version even if odds do not change; fresh markets start
at version one, while non-material markers preserve identity.

Submission time is captured once during the atomic draft-to-submitted
transition. Acceptance requires an exact mirrored expiry and submission
strictly before both that expiry and the first later transition ending the
quote's authority. Domain `occurredAt`, not delivery time, records that end;
out-of-order history chooses the earliest later sequence. Old histories may
use a terminal mirror timestamp only as a defined compatibility fallback.
Missing, malformed or boundary-equal evidence fails closed. Parking a
provably pre-cutoff submission is not permission to accept an outcome-known
bet.

Selection IDs outrank sides: several exact-score options can all be neutral.
Legacy side fallback is safe only when it identifies one unique option.
Optional display labels should survive persistence, REST/SSE, click payloads,
slip snapshots and history without changing wire identity.

### Terminal state must be monotonic

Concurrent result, visibility, and live-update writers can otherwise reopen or
hide a finished event. Terminal transitions use conditional writes and
sequence guards so delayed work cannot reverse a stronger state.

`EVENT_RESULT` remains terminal authority even if it precedes live snapshots.
Older snapshots can fill bounded history, but only a matching `FULL_TIME`
projection restores a retained result card; they cannot reset `RESULTED` or
remove Moderation's terminal guard.

Persist explicit visibility intent separately from current runtime visibility
and transient delivery state. A completed offline decision must survive
retention and delayed updates. Terminal writes atomically consider phase,
metadata initialization and explicit/legacy offline intent. A stale read must
not overwrite a concurrent visibility decision.

Live or visibility messages arriving before event metadata create fail-dark
placeholders. Metadata and visibility initialize independently; competing
unique-ID upserts treat duplicate-key errors as convergence and retry against
the winning row before acknowledgement. Ambiguous legacy hidden placeholders
remain hidden. An equal-sequence authoritative repair can retain stronger
terminal history while adopting corrected visibility.

### Realism is statistical, not theatrical

Forcing every match to contain every incident creates less realistic data.
Deterministic corpus tests are a better way to prove that incidents occur
through both halves, stoppage remains a minority, and individual matches may
still be quiet.

The historical simulation engine was pure and clock-independent: named seeded
random streams emitted integer offsets, while persisted engine version and
transitions governed an in-progress match after upgrades. New incident
categories need independent streams so adding one draw does not change goals,
cards and golden simulations. Historical seeds were independent 256-bit
lowercase hexadecimal values, validated before persistence; missing, short,
uppercase, public-ID-derived or otherwise malformed seeds needed replacement.
Seeds do not belong in public payloads.

Only goal transitions change score. A penalty award resolves later in the
same half, with a scored penalty linked to its goal. Remaining next-event
markets settle explicitly to `NONE` at full-time. Rotation is persisted
deterministic state, not UI sampling: replacement follows settlement/closure,
and a returning market type advances its version. Retention bounds derive
from configured worst-case incident and quote-version counts, not averages.

### Repair persisted boards without reinterpreting bets

Scheduler insert-only convergence preserves existing products; fixing a price
generator alone does not repair an already visible pool. Historical repairs
used the existing compatibility backfill rather than catalog filtering,
deleting slots or changing visibility provenance.

Immutable selected-row snapshots let bounded catalog repricing leave drafts
and bets unchanged. Preserve an odds ID only while its label still means the
same selection. Removed labels receive deterministic new identities; duplicate
labels retain one deterministic canonical ID. A displaced draft can remain
visible, placeable and settleable from its snapshot without highlighting a
different ID on the repaired board.

Derive repair prices deterministically from event identity and one coherent
distribution for 1X2 and Correct Score. Preserve product/embedded identities
and map home/draw/away by validated labels, not array positions. Dry-run,
apply and verify should converge to no remaining matches. A scan predicate
is not a write guard: bind array-path updates to the exact scanned arrays,
live state and terminal markers so concurrent result/reorder becomes a
mismatch instead of an overwrite.

### Separate public controls from privileged fixture access

The historical public Backoffice change deliberately removed an inferred
administrator gate from catalog controls. Public access still needs bounded
input, explicit scores, atomic/idempotent terminal writes and no-store
responses. Missing events return `404`; only identical terminal retries are
idempotent, while conflicting results or overlapping visibility writes return
`409`. Absent values must not become destructive defaults.

Privileged synthetic-fixture access is a different boundary. A signed JWT
role is only a hint: current persisted authorization is rechecked server-side
and fails closed when Auth is unavailable. Signup does not grant
administrator status; demotion, deletion, expiry and role mismatch invalidate
privileged access, including bounded legacy sessions.

Synthetic acceptance events remain offline and excluded server-side from
ordinary REST/SSE. Any privileged scope is bounded to exact event identities,
including odds reads. While authorization is unresolved, retained offline
snapshots must not render or leak; failed access purges scoped caches and
refreshes authentication.

Reusable acceptance identities stay low-privilege outside narrowly scoped
actions. Protected credential bindings must agree, with no source fallback;
browser length constraints
must not silently alter credentials. Failure diagnostics must not capture
password fields. Exposure, including deterministic truncation, requires
credential incident handling rather than restoring the exposed value.
Cleanup is identity- and state-scoped, not wholesale account or data deletion.
See [[Security]] for the current public and privileged boundaries.

## User experience

### Do not confuse a recent tail with a complete history

A bounded "last events" list must not be labelled as a full match summary.
Completeness requires producer attestation and successful bounded retention;
legacy or partial data is labelled honestly.

Historical completeness flags (`incidentsComplete` and
`incidentHistoryComplete`) were optional, additive producer attestations,
derived from validated cumulative transition history within phase-aware
bounds. A single-incident update, malformed/truncated payload, nonterminal
phase or legacy row does not establish completeness. Lost earlier history
cannot be reconstructed by relabelling it.

Finished views used chronological key moments and a native expandable
chronological timeline: `Full timeline (N)` only with attestation, otherwise
`Available timeline (N)` with a partial-history explanation. Active views
could still show a recent tail. Suppress a derived goal only through an exact
relation-ID match to a displayed scored penalty, not a team/minute heuristic.

### Preserve identity while changing presentation

Compact labels, sorting, and responsive movement must keep the original
selection ID, name, value, and click payload together. Never reconnect values
to options by array index after sorting.

Presentation sorting of a score board is all-or-nothing against a fully valid
board. Malformed options retain original order rather than a partial sort.
Mixed live/countdown sections use the same ordered collection for counting
and rendering: active first, then countdown, each by canonical displayed
kickoff with unavailable times last and event identity breaking ties.
Keep that rule local rather than changing unrelated shared sorting.
Tests cover exact accessible order in every variant and keyed focus during
updates; a future fixture outside the countdown window misses that regression.

When compacting bet cards, retain useful summary context: event time stays
distinct from placement time, and an accumulator's time describes its shown
event, not an invented earliest kickoff.

### Consistency is measurable

Long content can shift sibling headings and odds even when every control is
clickable. Cross-card baselines, control bounds, touch targets, overflow,
focus order, and responsive height are testable acceptance criteria.

When changing geometry, absence of overflow is not proof of equal tracks,
aligned baselines, or compactness. Measure those outcomes under matched
fixture, viewport, and font conditions. Use the actual lifecycle state:
offer-request pending is not confirmation pending. For hourly values, include
ordinary mixed counts, zeros, and complete supported large integers; neither
extreme-only coverage nor one observed column count proves responsive density.

Use accepted product semantics and stable shared shells, components and tokens
as references, not one screenshot or the newest page. Compare hierarchy,
spacing, content width, surfaces, geometry, status cues, copy, lifecycle states,
themes, responsive modes, UI variants, keyboard/focus order and live movement
where affected. Divergences can be required fixes, intentional semantic
exceptions or optional polish; preference alone is not a blocker. Precise
geometry/interaction claims need rendered evidence, but not a compulsory new
visual matrix or agent sequence.

A historical Backoffice review passed mechanical geometry checks yet missed
the composition: identity/status and scores/actions were separated by a large
unexplained gap, weak baseline rhythm and unrelated group edges. That was a
review failure, not evidence of a corrected layout. Whole-task relationships,
intentional whitespace and shared-column alignment need judgment too;
unlike primary and secondary actions need not have equal widths.

### Use available width before hiding information

A prominent live card should use the stage width and parallel semantic regions
before introducing clipping, nested scrolling, or avoidable vertical growth.
Sparse grids should collapse empty tracks.

Historical layout corrections distinguished sparse pre-match rows from a
single information-dense upper live/countdown/retained card. Pre-match cards
used responsive one/two/three-card grids, with a bounded two-thirds desktop
row for one card and a complete half-width row for two. The later upper-card
rule superseded the narrow-card approach: use full stage width and parallel
semantic regions, with a bounded collapsed height relative to pre-match.
Only an intentionally expanded historical timeline could exceed that budget.
These are archived design decisions, not new universal geometry requirements.

Within market decks, `auto-fit` avoids phantom tracks left by `auto-fill`.
Sibling cards align at the top and stretch together; badges wrap between
words, and shared headings span the whole deck. One live product occupies
one normal grid slot rather than widening according to market type.
Multi-option density is solved inside the card.

Betting controls in a row stretch together and keep odds on one baseline
despite wrapped labels or unequal team names. Historical ten-option Correct
Score boards used container-aware five- or two-column layouts. Recheck inside
each changed parent and around query transitions: adequate touch width alone
does not prove prices stay within controls.

Scores, incidents, active markets, selections and nonterminal availability
states remain useful context. A visible-card limit is not domain retention.
A historical activation assertion incorrectly expected terminal countdown
cards after the compact UI hid them; the authoritative snapshot still retained
those markets for moderation, settlement and audit. Rendered acceptance,
workflow assertions and documentation must describe the same presentation,
without shrinking authoritative history to match the screen.

### Public means usable

A visible navigation item is not proof of access. If a capability is public,
anonymous and ordinary users must reach its real data and controls, not an
authorization-denial screen.

Visibility is discoverability; availability means routed data and intended
actions work for every named authentication state. Historical rollback probes
may validate an older protected shape, but that compatibility allowance must
not weaken current public-access acceptance.

## Testing

### Reduce repeated work without losing the assertion

Assign each behavioral assertion an execution owner within its validation
scope. Share immutable fixture inputs but isolate mutable repositories,
locks, ports, and remote state. Retain representative real process,
cancellation, and concurrency tests rather than replacing physical boundaries
with mocks.

Historical compatibility-stage CI work reduced repeated repository construction and
removed obsolete inactive-feature fixtures while retaining the 35 OCI suites.
An intermediate seven-fixture macOS timing sample is not comparable GitHub
performance acceptance. At that stage, further retirement and matched
measurements remained; neither the half-baseline target nor complete redesign
acceptance had been proven.

### Charge a timeout to the work it bounds

Receipt visibility IO and full quality revalidation have different costs.
Charging unrelated revalidation against a receipt-read allowance can reject
valid work after a successful immutable receipt. The historical local publisher
correction charged receipt/selector IO and retry waits without increasing the
allowance. Cancellation, cumulative exhaustion, exact same-owner semantics,
expiry, and fresh authority checks remained. A timeout never renews consumed
authority. See [[Quality Gates]] for the compatibility-stage contract.

### Test the invariant, not one convenient fixture

Examples:

- realism across a deterministic seed corpus rather than one match;
- every result/full-time interleaving rather than the common order;
- duplicate and out-of-order messages rather than one ideal delivery;
- asymmetric long names rather than equal placeholder content;
- legacy missing fields rather than only newly written rows.

### Keep fixtures faithful to language and process boundaries

- Read each service's Mongo test setup rather than assuming identical cleanup
  and connection lifetimes. An async `forEach` does not await database work;
  awaited iteration matters before closing the connection.
- A bare Common auto-mock can leave listener channel state undefined; use a
  concrete listener factory where that state is exercised.
- Inherited `APublisher.prototype.init` auto-mocks are shared across subclasses.
  Two publishers increment the same function's count unless each prototype
  gets its own `jest.spyOn`. `jest.clearAllMocks()` resets counts without
  removing those spies.
- Placement retry fixtures keep `submittedAt` fixed while changing transport
  timestamps, proving exact duplicate handling without a conflict record.
  Browser board mocks also rotate revisions/fingerprints and reject stale
  confirmation rather than merely matching API response shapes.
- First-attempt script fixtures explicitly set or clear ambient run/attempt
  metadata, so a surrounding CI rerun cannot fail a fixture before its intended
  assertion. Mutable repositories, directories and ports are isolated so
  parallel tests cannot erase each other's state.
- Shell pipelines preserve failure with `pipefail`. Platform fallbacks try the
  appropriate form and retain only the selected probe's output: a nominally
  failed GNU/BSD variant can emit misleading partial output or succeed with
  unrelated semantics.
- Historical coverage reporting could show zero branch percentage with a
  nonzero total. Line coverage remained mandatory; branch thresholds needed
  meaningful instrumentation rather than treating the anomaly as missing tests.
- Root ignore patterns can hide newly reconstructed coverage-tool inputs.
  A clean status does not prove intended ignored files exist in the candidate
  tree; inspect exact tracked blobs.

Historical test setup used `npm ci` and service-local `npm run test:ci`.
Post-deploy browser tests also needed browser/system dependencies, not just
the Client package install. Service-selective coverage expanded shared or
unknown service-impacting paths conservatively; documentation-only changes
did not require service coverage. Old checkout-action versions and historical
service counts are not templates for new workflows; inspect current manifests.

### Match evidence to the claim

Unit tests prove pure logic. Integration tests prove persistence and message
boundaries. Browser tests prove geometry, accessibility, and interaction.
Production acceptance proves the deployed composition and operational
dependencies.

When claiming deployed layout evidence, local `HEAD` or `sourceBinding()`
identifies the local test context, not the served JavaScript/CSS. Bind served
bytes to immutable image and deployment evidence. Loading those assets with
HTTP-mocked fixtures proves only the exercised frontend behavior, not real
financial acceptance.

Read acceptance facts from their owning projection. Event proves phase,
score, incidents and terminal markets; Bet history proves accepted quote,
winning selection, settlement reason/sequence and row outcome. A broker-only
field missing from an unrelated API is not a reason to enlarge that API for a
test. A non-void synthetic market should resolve to exact `WIN` or `LOSS`;
unexpected `VOID` does not prove successful settlement.

### Exercise protected acceptance through the actual helper

When a harness correction affects scoped fixtures or additional pages, run the
actual helper on a fresh page, not just the primary page. Preserve the existing
administrator-only offline fixture scope through affected LIVE and PRE_MATCH
navigation and reload; exclude sibling fixtures and grant nothing to anonymous
users. Browser route mocks do not intercept `APIRequestContext`: stub only
required request-context reads and resolve selections by the submitted event
identity. Await restored form values; a visible confirmation button alone does
not prove asynchronous restoration. Keep mock-HTTP evidence distinct from real
protected acceptance.

Drain pending error captures before the final audit. A known retry needs exact
handled-request attribution, never a blanket HTTP or console exemption. Keep
diagnostics bounded and sanitized; unknown errors, ambiguity, and overflow
remain failures. A snapshot of another tab cannot explain the failing page.
See [[Release Orchestration]] for the acceptance and artifact boundaries.

### Treat first-attempt behavior as a contract

If downstream provenance accepts only attempt one, a failed run is terminal
evidence. Fix the cause and create a new exact candidate rather than rerunning
the failed authority.

When changing artifact reads, keep bounded retries inside the idempotent
artifact GET, not the protected operation or its validation. Permission or
authentication failures and contradictory or unrecognized diagnostics must
defeat otherwise positive HTTP/network retry signals. Discard all failed or
timed-out attempt bytes. Do not infer an unobserved historical HTTP status or
replay/reset consumed operations. Existing archive, provenance, and one-use
safeguards in [[Release Orchestration]] still apply.

### Prove prerequisites before spending one-use authority

A protected operation should bind every prerequisite to explicit, hash-covered
run, source, artifact, and lineage evidence, then revalidate that evidence at
each trust boundary before authority or mutation. Package validation must name
the exact build run it inspected, and bounded artifact contents must be
validated rather than trusted by name. Repository-wide blocker evaluation and
authority creation remain serialized so concurrent requests cannot both claim
an apparently empty authority set.
If a previously dispatched but unissued run loses a prerequisite, match its
exact request and keep the operation serialized until bounded, reviewed
recovery proves that exact run and source identity safe to retire. Recovery
must preserve one-use authority evidence, treat ambiguity or partial execution
as a blocker, and never create dispatch, approval, or mutation authority.
Active mutating work remains a fence. Provider-boundary revalidation preserves
the exact source, runtime mode, protected approval, and provenance before any
mutation.

Check protected configuration, publishing prerequisites, and packed-manifest
provenance metadata before expensive or one-use work. Registry reachability,
a successful pack, or a consumer build does not prove publishability. Absence
requires an exact prerequisite lookup or a complete paginated inventory, not
the first page of results. See [[Release Orchestration]] for existing preflight
requirements; inspect metadata without exposing secret values.

### Preserve independent CI identities

Historical publisher migrations exposed several distinct failure modes:

- Restoring trusted workflow bytes did not prove its triggers matched the
  publisher. Metadata edits could start validation without creating usable
  source binding; cancelling the original bound run then stranded a successful
  replacement. Check binding early rather than after expensive CI.
- New static guards reused an existing trusted workflow entrypoint. Changing
  the trusted workflow and its verifier together did not establish trust;
  protected workflow identity remained independently checked.
- Producer and reader must select the same protocol from protected
  required-check policy. A new producer URL under an old status name is not
  backward compatibility, and an enforced full-quality proof cannot fall back
  to legacy evidence.
- Native PR run/job `head_sha`, tested merge and protected signer/control
  commit are separate identities. Neither the event head nor PR base supplies
  an expected signer; a manifest cannot authenticate its own signer.
  Historical native PR associations may disappear after merge: absence can be
  compatible with signed source, immutable merge, approved controller closure
  and native execution evidence; contradictory associations cannot.
- Successful local lint and other PR jobs missed a zero-job native
  workflow-definition failure. Runner-dependent environment expressions belong
  at step scope, and native run/check-suite inventory must include failures
  outside a fixed expected-run list.
- `actions/github-script` provides `context.repo` and `context.issue` as
  prototype getters. `{ ...context }` loses them. Derive modified contexts
  from the original prototype and test with real-shaped Context fixtures,
  not only plain objects.
- Workflow inputs belong in environment bindings, not direct expression
  interpolation into shell scripts. Status functions belong in conditions;
  provenance scripts can validate the bounded `job.status` domain instead.
- Step credentials do not persist into later steps. Verify every caller's
  effective environment, including nested provenance helpers; an earlier
  authenticated step or an artifact action's token input does not supply it.
  Removing an environment block requires checking all remaining consumers.

Legacy label-lineage regressions also taught general state-machine lessons.
Informational context labels are not ownership or approval evidence. Original
server-owned transition time bounds reconciliation; queue delay, replay or
metadata edits cannot renew it. Equal timestamp serialization needs complete
ordering evidence, not a widened time window.

Provisional, confirmed and exact-run-bound states are distinct. Provisional
evidence grants no success or receipt authority; exact replay is inert after
confirmation. Irreversible disproof dominates positive or lower states at the
same cutoff, regardless of status order. Conflicting identities and
incompatible legacy markers fail closed; restoring a label does not erase
observed drift. Complete ledgers are needed for positive authority, while one
validated disqualifying event can establish failure even before pagination
finishes. API/schema/incomplete evidence is uncertainty, not positive proof.

Rollback must preserve both parsing and the independent authority semantics
of already-emitted evidence. A reader that understands the newer syntax but
omits its ledger checks is not compatible; a legacy fail-closed reader does
not restore release authority. Historical marker formats and reconciliation
mechanics are intentionally not reproduced here. [[Quality Gates]] owns the
active versus candidate protocol description.

## Release and operations

### Resume evidence, not remembered plans

An interrupted conversation is not evidence that accepted work failed.
Recover and scope-check original reviews using [[Agents]] rather than
repeating unchanged specialist passes or reconstructing missing verdicts.
After another session releases, reconcile current protected source, the
actual deployed generation, and exact artifacts as described in
[[Release Orchestration]]. Old notes are context, not permission to replay
data, infrastructure, deployment, activation, or recovery operations. An
explicit pause remains a pause until the user resumes the work.

### Build and deploy exact immutable identities

Branch names and mutable tags are convenient pointers, not release identity.
Review, build, artifact, image, deployment, and acceptance evidence should
resolve to one exact source SHA and immutable image digests.

Current safety control, deployed subject and historical rollback target are
different source identities. An old target does not authorize old control
code. A failed generation, or the promotion preceding it, is not an accepted
rollback baseline.

Complete evidence matters as much as matching fields. Count/list agreement,
typed metadata and full bounded inventory are required before interpreting
absence. GitHub Compare does not supply a `head_commit` field: a complete
unique ordered commit list must end at the requested head, not merely contain
it. Compact SHA-only pagination avoids retaining unnecessary patch detail
without truncating ancestry proof.

### Release by inclusion, not session exclusivity

Parallel development does not require parallel production mutation or one
release per session. Record the commits each outcome requires, prove they are
ancestors of the exact current `master`, and validate that complete aggregate
candidate. If `master` advances, supersede the stale chain instead of blocking
on unrelated protected commits, resetting shared history, or deploying an
older SHA. Keep deployment, data changes, activation, and rollback serialized.

### Implement the smallest compatible slice before optimizing

Quality does not require front-loading every possible improvement. Start with
the smallest end-to-end behavior that satisfies the accepted outcome and reuse
existing patterns. Add a prerequisite only when a current incompatibility,
failing test, or mandatory safety gate proves it is needed. Repeated
governance work that never reaches product implementation triggers a scope
reset rather than another hardening layer.

For a localized production bug, follow the actual cause through a surgical
patch, proportionate verification, and the normal
protected release. Defer unrelated redesign to one evidence-rich issue
covering reproduction and evidence, user or operational impact, root cause,
direction and acceptance, exclusions and dependencies, compatibility or
migration, rollback, and source PR/run links. Keep redesign before production
only to prevent concrete data or user invalidity, a security or authorization
defect, a backward-compatibility break, or unsafe or irreversible rollback. Do
not add agents, gates, or frameworks, duplicate owners, repeat reviews without
new failing evidence, perform speculative cleanup, add arbitrary fixture or
time gates, or invent ETAs.

After implementation, review the result, record applicable learning, and
optimize where evidence shows concrete value. Security, compatibility, data,
branch, test, and production safeguards remain unchanged.

Before expanding a hotfix, refresh concurrent work. A smaller accepted fix
may already resolve the same blocker: reuse its compatible source and valid
reviews rather than finishing a larger design because effort was spent.
Keep corrections with the original context; replacement or status-only agents
lose evidence and ownership. Late reports need their recorded source and
runtime assumptions checked again. Read-only review roles should also have
read-only capabilities, consuming supplied evidence rather than unrestricted
execution.

### Make public documentation part of the change

Documentation should not be a best-effort cleanup after release. Every change
records documentation impact; use specialist help when needed. Publicly
affected canonical pages change in the same pull request and accepted merged
pages are published byte-identically, never ahead of source acceptance. A clearly internal change may retain
path-specific no-public-change evidence without creating another handoff.
Public documentation explains behavior and safety invariants without exposing
credentials, private approval state, live records, or actionable bypass
procedures.

### Name pull requests by their outcome

A pull request title helps readers understand intent. Prefer
short plain-language outcomes such as `Add second-half score betting` or
`Fix live slip alignment`. Wording and presentation are not source quality or
approval authority; actual missing rationale and safety evidence still matter.
During the compatibility transition, not-yet-replaced protected revisions
retained their executable checks. Policy edits did not bypass those controls;
current behavior belongs to contributor policy and the checked-in helpers.

### Replace choreography with accountable evidence

Compulsory agent sequences, model quorums, unanimity, recursive review, and
status-only transfers do not prove correctness. Use one accountable owner,
proportionate checks, and independent verification of changed trust/state
boundaries. Request design, UX, testing, or process expertise for an evidenced
gap; reuse accepted decisions and unaffected results. No additional
PerfettoStan/simplifier round is needed to remove optional duplication.
Repository instruction edits do not reload the running session.

Preserve ancestry during protected integration and promotion. Reconciliation
is needed when ancestry requires it, not automatically after every release.
Evidence reuse never substitutes for current exact-source checks, origin-bound
approval, immutable deployed identity, physical writer exclusion, compatible
rollback, or observed health.

Historical squash promotions lost ancestry and caused extra validation.
An ancestry-preserving promotion still leaves a merge commit that strict
up-to-date protection requires in the next candidate; a local merge-helper
relaxation cannot override native protection. Current contributor policy owns
how that ancestry is reconciled.

Presentation and public-safe session/feature labels provide continuity across
related PRs, not authorization. The durable PR description records rationale,
scope, compatibility and verification. When the production critical path is
explicitly prioritized, unrelated metadata churn can create avoidable
validation/exclusivity conflicts; that scope discipline never waives safety.

### Capture rollback before mutation

Rollback readiness is established before changing production. The baseline
must identify the exact prior application generation and any data or
compatibility constraints required to restore it.

Rollback evidence has both retention and freshness bounds; the earlier
applicable limit matters. A historical successful baseline is not permanent
authority. Capture plans and queue/data baselines before mutation, never from
post-mutation state during resume. A successor may carry verified lineage
without relabelling the original capture as its own.

One-off data corrections should be fixed-target, journaled and deterministic,
not reusable delete APIs. Exact preimage/target identity, canonical hashes and
concurrency predicates distinguish safe partial convergence from unrelated
changes. Cross-store references and identity cleanup belong in the analysis;
a lead-time failure does not authorize moving the target without review.
Historical journal schemas must remain readable as tooling evolves.

### Separate deployment from activation

A dark deployment can prove images, health, data compatibility, routing, and
readiness before enabling a user-facing feature. Activation remains bounded
until the full acceptance journey passes.

Historical live activation used a lease as an independent fail-dark boundary
if its runner disappeared before cleanup. Malformed or expired temporary
activation prevented new kickoffs while already-started matches continued.
Permanent state required the same source/run's complete committed evidence,
not an intermediate acceptance artifact. Ambiguous control failures could not
be interpreted as permanent enablement.

Activation state and public activity are different observations. Offline
acceptance matches do not replace ordinary public history; a retained result
can remain visible until the next countdown. Report the public schedule with
its timezone and claim actual kickoff only from observed public activity.

Failed acceptance does not by itself establish failed-deployment recovery
authority or automatically invalidate accepted design, but an actual application
or architectural defect can invalidate accepted assumptions and must block
closure. Classify the exact assertion as an application,
harness, or provider problem before routing a bounded correction. A harness
fix reopens affected evidence and required exact-source release checks, not
unchanged contracts, package publication, or specialist reviews.

After success, distinguish the leased acceptance artifact from final
committed/no-lease evidence. Compare downloaded bytes and declared hashes,
bind the verified image inventory, and inspect actual cleanup outcomes after
upload; an earlier provenance snapshot cannot prove later work. Finish source
inclusion and required byte-identical documentation publication, record one
terminal result, and close. Reuse successful canonical revalidation when its
inputs are unchanged. Failed attempts stay failed; completion does not require
extra probes, reviews, handoffs, or status-only releases. See
[[Release Orchestration]] for the existing release boundaries.

### A watcher is not progress

Long-running output or a queued workflow can hide a waiting approval, missing
job, or completed handoff. Orchestration should inspect the underlying state
at bounded checkpoints and assign the next action immediately. Compare
timestamps only after parsing them as timezone-aware absolute instants and
normalizing them to UTC; a missing or unparseable timezone makes timing
unknown, not stalled. `run.updated_at` is metadata, not a heartbeat. Progress
requires actual job, step, or log milestones compared with recent successful
runs of the same workflow and job on a comparable runner.

Executing is not reporting. A safe checkpoint identifies source, completed
milestone and timestamp, evidence so far, active work, blocker and next bounded
action. Approval is not job execution; a green workflow proves only its
assertions. A watcher for an ancestry PR does not cover downstream builds or
their protected waits. Distinguish provider queueing, actionable approval and
local observation failure rather than silently polling or inventing an ETA.
Time alone never proves a writer stopped or permits releasing its lock.

Prefer bounded sanitized artifacts and field allowlists to raw logs. Log
prefixes can cause a search for one step to capture all its injected
environment. Multi-response HTTP probes must suppress every unintended body.
Redaction must preserve structured delimiters; parse redacted JSON fixtures
so a URI scrub does not consume surrounding quotes or fields.

### Approval policy outranks agent memory

Automatic approval eligibility is determined by the checked-in operation
policy and the exact durable CLI authority record. A sensitive workflow is not
human-only merely because an agent remembers it that way. When a listed
CLI-issued operation reaches a waiting gate, route the bounded approver in the
same checkpoint; polling an eligible gate is an orchestration defect.
Inspect pending gates first on startup, resume, and each monitoring checkpoint.
Eligible CLI-owned approvals and merges are the automation owner's execution
responsibility, not another request for the user to approve manually. This
does not remove technical checks or change approval of human-originated work.

A retry for incomplete approval inventory is limited to a failure proven
before approval submission, refreshed complete evidence, and still-valid
original authority for the same canonical approval. Keep the same observer
and wait bound. An ambiguous submission requires canonical reconciliation,
not another dispatch, workflow rerun, or an authority change.

### Preserve one-use authority through interruption

The following are historical safety lessons, not dispatch or recovery
instructions:

- A managed label and a shared GitHub identity do not cryptographically prove
  CLI origin. Durable operation ownership cannot be retrofitted onto human
  work. Policy, source, workflow identity, typed inputs, attempt and exact
  downstream run all matter.
- A dispatch response proves event acceptance, not job materialization.
  Intent must survive a crash at the external-call boundary, and uncertain
  calls remain unresolved instead of being reconstructed from title/timing
  or dispatched again.
- Unresolved ownership is repository-wide and survives control-source
  promotion, changed inputs and expiry. Local per-request atomic creation
  alone cannot serialize two requests that both observe an empty authority
  set. Spent authority remains spent.
- Approval submission is another ambiguity boundary. Missing gates, terminal
  status or temporary read failure do not prove acceptance. Reconciliation
  needs exact before/after evidence, while sequential protected jobs on one
  run remain distinct gates rather than reusable approval.
- Workflow lifecycle state and environment inputs are policy data, rechecked
  with source and prerequisites at the actual mutation boundary. Runtime
  injected values must agree with approved intent; repository tokens cannot
  be assumed able to reread protected configuration.
- Prerequisite failure during resume does not authorize replacement work.
  Exact rejection/cleanup evidence stays durable through interruption and
  descendant control changes; a historical-control recovery path grants no
  new dispatch, issuance or approval.
- Jobless or old provider records are not automatically inert. Positive
  evidence must exclude work, approvals, deployments and artifacts before
  any policy-scoped classification. Active mutation remains a fence;
  narrow historical exceptions never become generic exclusions, permission
  to reset history, or new authority.
- Alternative-state recovery is a positively verified, bounded state model,
  not a force/skip switch. Evidence sealed before an external lifecycle
  transition must be re-collected at its boundary, remain operation-scoped,
  and never be cross-consumed by another workflow.
- The final mutable-source, provenance and runtime-mode refresh belongs in
  the live job before provider access, not a similarly named retired job.
  Approval checks short-circuit on failure and remain bound to their original
  gate; invalid evidence must not reach a later success-capable action.

Bounded package-install retries and artifact GET retries address transport
fragility, not authority reuse. Complete-command deadlines, finite backoff,
transport timeouts and final version checks distinguish transient success,
permanent failure and timeout. Failed bytes are discarded, and a consumed
first attempt remains historical failure even when it failed before mutation.

### Recovery is not diagnosis

A service returning `200` again proves current availability, not why it
failed. Keep risky feature activation fenced until container-level previous
state, exit code, reason, timestamps, and bounded previous logs are captured.
Separate startup allowance from steady-state liveness so a dead listener is
restarted promptly without penalizing normal boot time.

Aggregate pod readiness can hide one failed container. Evidence distinguishes
each container's restart count, current/previous state, termination reason,
exit code and timestamps; previous logs are requested only where restart
evidence supports them. A localized infrastructure fix should not silently
change one service's PID-1 supervision while leaving the shared backend
process chain inconsistent.

### Maintenance recovery preserves dependency order

Planned maintenance may intentionally hold a component at zero replicas; that
state alone does not identify provider failure or corrupted configuration.
Inspect the operation and its ordering, prove a prerequisite ready before
applying resources that depend on it, and recover only from explicitly modeled
partial rollout states rather than arbitrary image mixtures. Restore affected
services before continuing feature work, validate affected APIs rather than a
generic `200`, and report observed evidence instead of an unsupported ETA.

Historical retained maintenance intentionally stopped ingress. Applying a new
Ingress before restoring its admission dependency failed despite intact
configuration. Real deploy-shell and helper tests needed every modeled
cleanup-produced rollout state, not a text-order assertion or one example.
Dependency ordering and image/replica expectations are runtime-specific;
an obsolete shared service list cannot override the target runtime.

A pre-mutation rollback failure is not a partial rollback: it has no changed
image state to recover. Deployment failure with a retained hold differs from
successful deployment/cleanup followed by failed public validation. Neither
an invalid request nor failed acceptance alone authorizes entering maintenance.
Recovery validates the expected state positively, preserves containment during
partial mutation and reports locks actually held, not locks already released.

Handoff deadlines follow physical lock authority, not artifact upload time.
Dispatch and approval do not establish takeover. Receiving verification and
valid ownership must occur within the real bound; queue delay, runner exit
and a successful-but-expired artifact cannot extend it. Physical holder,
failed receiver, baseline capture and ancestral applied-data root stay
distinct through successor lineage.

Emergency evidence must be bounded independently of growing provider history.
Exact fixed manifests, authenticated executable trees, immutable artifacts
and producer-to-verifier roundtrips provide stronger evidence than open-ended
search. Provider time and immutable execution identity avoid runner-clock
skew in lease decisions. Uncertain mutations need an exact bounded reread and
an applied/not-applied/ambiguous result, never assumed success.

Cleanup obligations can outlive generations that failed before writing their
own receipt. Preserve authenticated predecessor obligations across restarts,
including cleanup-only predecessors; immediate-predecessor-only cleanup can
orphan older resources. Completion requires accounting for every obligation
while preserving unrelated resources.

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

Example: deploy health once required an absolute zero restart count, so pods
that restarted during an earlier node reboot failed every later deploy forever.
Health now counts a restart only when its last termination is recent; missing
or malformed termination evidence still counts, and crash loops still fail.

### Keep registry identity and recovery provenance truthful

Historical OCI/GHCR migration lessons:

- Cloud runtime identity and application-registry authority are separate.
  Validate provider, host, package, full-source tag, manifest digest and
  platform digest independently. An authenticated push does not prove public
  availability; a clean anonymous pull does. Public runtime pulls do not need
  long-lived registry credentials.
- Repository linkage and package visibility are separate setup facts.
  Historical package bootstrap did not by itself establish public visibility.
- Package publication and account-scoped registry administration have distinct
  token capabilities. User-owned package administration uses account routes,
  not an invented repository-scoped API. A metadata/retention credential is
  not a push or runtime credential.
- Removing the old registry removes its remote fallback. Verified cache
  recovery preserves the original platform manifest, config and layer bytes;
  rebuilding/relabeling or converting through another image representation
  is not digest-preserving recovery.
- Normal builds and recovered baselines have different truthful provenance.
  A normal generation needs build/deployment evidence; cache recovery needs
  its own successful terminal evidence. Historical registry builds must not
  be relabelled as new-registry builds. Readiness includes API, queue and
  public-browser behavior, not rollout status alone.
- Partial publication needs a terminal resume model before mutation.
  Reproducibility depends on commit-derived time plus pinned exporter
  timestamp, compatibility, media-type and compression behavior. Reuse
  requires proving existing platform bytes, not merely matching a tag.
- Retention protects every tag on a registry version, since one version may
  belong to several source generations. Authenticate obsolete generations,
  bind the exact normalized generation/version/deletion plan, and re-read
  terminal state. Untagged child and interrupted-staging manifests are not
  complete tagged generations.
- One registry control plane avoids competing cleanup authorities. Retired
  registry phases remain audit-only, not alternate production paths.
  Historical package pricing was provider policy, not permanent capacity;
  pricing changes cannot justify weakening immutable rollback protection.
- Pin helper container images as well as Actions: a pinned setup action can
  still launch a mutable default helper image.

### Validate transport bytes and provider semantics

- A successful remote command exit does not prove a complete streamed archive.
  Validate archive structure and compare exact source/destination size and
  hashes. Historical stdout truncation showed why transport success was
  insufficient.
- Command interfaces differ: a container export tool treated an apparent
  option terminator as another image name. Tests need the actual validated
  argument vector rather than assuming generic CLI behavior.
- Registry upload locations can change between plural and singular endpoint
  forms, and session identifiers may be opaque rather than UUIDs. Validation
  can accept the documented bounded forms while preserving exact host,
  repository and path boundaries and rejecting injected URL authority.
- SSH trust must come from authenticated provider/target evidence, not first
  use. Provider host-key metadata may be absent, and a successful text response
  may omit its checksum; alternative attestation still needs exact bounded
  structure and independently checked bytes. Key parsing must be portable
  rather than dependent on a runner-specific temporary-file path.
- Imported cluster configuration is untrusted input. Normalize to the
  reviewed minimal connection shape and reject external execution, proxy,
  credential and file-loading directives before contacting the API.
- Accepted cloud-agent work can have substantial scheduling latency before
  execution. Distinguish acceptance delay from terminal failure within the
  existing bound rather than issuing replacement work.
- Optional-resource absence requires a successful exact lookup with an empty
  result. API, timeout or authorization failure is not NotFound. Identity
  deletion may require complete listing and exact comparison when filtered
  endpoints do not prove absence.
- Provider identifiers and optimistic-concurrency values must preserve their
  exact documented representation, including case and `eTag` spelling;
  transformed values or wildcard fallback discard concurrency protection.
- TLS probes can require platform-specific graceful shutdown behavior without
  weakening certificate verification.

### Separate retirement, capacity and workload observations

Cross-cloud cutover used independent write, producer, consumer and database
fences bound to immutable provenance. Validated data handoff precedes any
maintenance authority; invalid requests must not extend an outage. Root
applied-data provenance stays distinct from later resume carriers. Resource
absence, temporary-access removal and delayed billing are separate completion
claims; retained recreation configuration is not a running resource.

Historical billing closure waited for ingestion and multiple observations,
not an immediate empty response. Bounded pages were normalized before
aggregation, with exact response/digest pairs and an append-only predecessor
chain under a lock. Continuations preserved the original query and account
scope; only transient provider failures received retries. Item-level usage
prevented charge/refund cancellation from looking clean. Currency changes,
malformed continuation, a trailing empty marker or rewritten history
invalidated evidence. Signal handling and dead-owner recovery must preserve
the journal rather than leave concurrent writers.

Disk checkpoints are sealed observations, not waivers. Compare raw integer
bytes against the policy bound, not rounded display percentages. Stable
identity must survive reboot: kernel device names can change while filesystem,
capacity, separation and runtime identity remain unchanged. Report the exact
differing evidence fields without treating a diagnostic reboot as harmless.

Public health collection and deliberately held-maintenance collection have
different scopes. Stable-only held evidence must not depend on mutable HTTP,
queue or workload health that maintenance intentionally suppresses. Complete
safe archives, checksum manifests and predecessor/build/deployment/activation
lineage matter more than metadata alone. Current approved source, historical
resume source and original checkpoint source are distinct; newly produced
byte-equivalent artifacts are not the original authority.

Baseline service inventories follow the exact supported generation, not a
historical count. Missing readiness counters are unknown, not zero, including
in rollback fixtures. Optional nested safety markers need explicit existence
and non-null checks. Mutable observations belong at the final authority
boundary; success cleanup must not be inferred from an earlier snapshot.

## Shared package

`common/src/` is source for a future package release, while deployed services
use immutable published versions. Package publication and consumer repinning
are separate reviewed changes. This distinction prevents an unbuilt local
source edit from being mistaken for runtime compatibility.

Historical Common publication lessons:

- `common/` is normal tracked source, not a gitlink/submodule. An orphaned
  gitlink broke checkout cleanup. Consumers compile against published
  manifest/lockfile pins, not a newer repository source tree.
- Package versions are immutable. After publication, the next content change
  needs a new source version so locally packed bytes cannot share a version
  name with different registry content.
- Backend consumers use one exact compatible version, not caret ranges,
  dist-tags, local files, workspaces or symlinks as deployment dependencies.
  Inspect the actual consumer inventory rather than copying an old count.
- Compatibility evidence includes runtime/exports, immediate-predecessor
  assignability, legacy AMQP types and `npm pack` contents. For unpublished
  testing, begin with lock-exact installs and replace only the isolated Common
  package with the unpacked candidate. Installing a tarball through the
  package resolver can change unrelated TypeScript, Mongoose or transitive
  dependencies and confound the test.
- Source identity, packed file list, registry integrity/shasum and independent
  tarball hash establish what was tested and published. Packed repository
  metadata must agree with provenance; reachability is not publishing
  authority. Published downloaded bytes precede consumer repinning and clean
  installs.
- Service-local bridges are temporary additive rolling-release adapters, not
  another contract owner. The shared wire value belongs in Common in the same
  feature; remove the bridge after consumers adopt the published contract.

## What this public page omits

The following belong in protected operational evidence, not a public wiki:

- credentials, tokens, cookies, private keys, kubeconfigs, or secret values;
- private approval records, dispatch payloads, and automation state files;
- cloud account, resource, cluster, network, or live host identifiers;
- emergency commands and step-by-step bypass or recovery procedures;
- exact operational timing windows, capacity thresholds, or queue limits;
- unredacted production logs, screenshots, user data, and local session paths.

The archive omits historical run inventories, deployed/rollback identifiers,
expired artifact dates, account names, exact private authority formats and
privileged command sequences. It retains their lessons about identity,
freshness, cleanup, concurrency and fail-closed recovery. Incident-specific
counts and timing/geometry measurements that were observations rather than
reusable requirements are not new acceptance targets. Superseded mandatory
agent choreography is retained only as a lesson about accountable completion,
not an instruction to recreate those gates.

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
