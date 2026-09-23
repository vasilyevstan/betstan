# `@betstan/common`

`common/src/` is the canonical source for BetStan's shared TypeScript
contracts, middleware, RabbitMQ base classes, queue names, and status values.
It is a normal tracked directory in this repository, not a submodule or
gitlink.

The npm package is the immutable distribution artifact used by deployable
services. Those two authorities must not be confused:

- change and review the next package source in `common/`;
- build service images against the exact published `@betstan/common` version
  recorded in each service's `package.json` and `package-lock.json`;
- never make a service depend on `file:../common`, a workspace link, a
  symlink, or an unpacked developer directory.

The source tree may therefore be ahead of the package installed by services.
Always report both versions when reviewing a shared-contract change.

## Version ownership

npm versions are immutable. After a version has been published, bump
`common/package.json` and `common/package-lock.json` before making the first
source change for the next package candidate. Never leave changed source
claiming an already-published version: a local tarball would then have the same
name as a different registry artifact.

Use exact prerelease versions while compatibility is being proven. Publish a
prerelease under the `next` dist-tag; do not move `latest` until the stable
release is intentionally approved.

All backend consumers must use the same exact version without `^`, `~`,
`latest`, `next`, `file:`, or workspace ranges:

- `auth`
- `backoffice`
- `bet`
- `event`
- `gamemaster`
- `moderation`
- `resulting`
- `slip`

## Compatibility contract

Shared messages cross independently deployed services, so a source-compatible
TypeScript change is not sufficient by itself.

- Prefer additive optional fields. Old payloads and stored data must remain
  valid when the field is absent.
- Preserve every existing export and the exact runtime value of existing enum
  members. Do not rename, renumber, or reuse a wire value.
- Unknown additive JSON fields must be safe for old consumers to ignore.
- New consumers must define an explicit fallback for old producers and
  historical records.
- Keep message identity and ordering semantics stable. In live betting,
  `marketId + marketVersion` identifies settlement authority, while
  `quoteVersion` validates price freshness.
- Keep selection identity distinct from coarse outcome grouping. An optional
  display label may be added compatibly, but when multiple selections share a
  side value, moderation and settlement must compare exact selection IDs.
- Keep the legacy `APublisher.publish()` behavior stable. Confirmed persistent
  publication remains an explicit opt-in through `publishWithConfirm()`.
- Keep AMQP APIs structural through `IAmqpConnection`; services intentionally
  compile with compatible but not necessarily identical AMQP type packages.

A temporary service-local compatibility bridge may expose additive runtime
wire values while services remain pinned to an older published package. It
must not become a second source of truth: add the value to `common/src/` in the
same feature, keep the bridge narrow, and remove it when consumers move to the
published package that contains the value.

## Cash-back candidate contracts — feature not active

The additive cash-back declarations are available in this source candidate.
They do **not** implement or activate pricing, HTTP routes, database writes,
source reservations, history projection, a UI, or a wallet. All eight service
pins remain on the published predecessor until the separate coordinated
consumer change.

`BetStatus.CASH_BACK` / `ResultingStatus.BET_CASH_BACK` mean full closure of
the currently remaining exposure. They are not cancellation or voiding.
Partial closure keeps `CONFIRMED` / `BET_APPROVED`; it never removes a leg or
adds a partial terminal status. Original wager, selection IDs, accepted odds,
placement identity and placed-bet statistics stay unchanged.

### Amounts, offers and identities

- Every `*Minor` amount is an integer JSON number in
  `[0, 9007199254740991]` (`Number.MAX_SAFE_INTEGER`). One unit is **0.01
  nominal Stanbucks**, not real funds or a wallet balance. Validate safe
  integers, bounds and all sums at runtime; TypeScript aliases do not validate
  external JSON. Never round an unrepresentable legacy wager into eligibility.
- Closed stake and quoted return must each be at least `1`. `PARTIAL` must
  leave at least `1`; `FULL` explicitly closes the exact quoted remainder to
  zero. Repeated partials have no product count cap. Never silently convert a
  partial to full, change its amount, or substitute a different offer.
- Decimal odds use positive, canonical decimal **text** (no exponent,
  non-finite values, or binary-float arithmetic). Arithmetic implementations
  must bound parsing/products and reject unrepresentable results. For closed
  principal `C`, return `C * acceptedCombinedOdds / currentCombinedOdds`,
  capped at that portion's potential return. Round only the final offer
  **down** to one minor unit; no extra fee or time haircut. Accumulators retain
  the existing product-of-odds simulation convention, not a correlation model.
- `CashBackQuote.financial` is the complete before-state and its `revision`
  is the expected decision revision. The quote includes original/remaining/
  closed principal, nominal return, exact after-remainder, policy version,
  issuer and immutable domain issue/expiry times. `expiresAt` is exclusive and
  at most seven seconds after issue, shortened by every relevant cutoff.
- A public quote request carries a stable `clientOperationId` and an explicit
  full/partial portion. Confirmation names the exact stored `quoteId`; it
  cannot set price, owner, revision or a replacement portion. Bet supplies
  authenticated `userId`, canonical `operationId` and canonical `fingerprint`.
  Resulting verifies that owner/slip/kind, operation and quote agree. Exact
  retries replay; changed canonical content conflicts. Fingerprints never
  include the publisher's mutable envelope timestamp.
- Pre-match identity keeps the original `productId` / `oddsId`. Live identity
  additionally requires the exact `marketId`, `marketVersion` and
  `selectionId`, with current `quoteVersion`, expiry and open-market evidence.
  Neither side classification nor array position can replace selection ID.
  A new validity window needs a new quote identity even if odds are unchanged.
- The internal `CashBackQuoteEvidence` binds the complete original accepted
  selection/odds manifest, current quote identities and both source owners.
  Its `anySelectionResolved: false` is allowed only after validating **every**
  retained original leg against monotonic resolved/removed-void evidence.
  Missing, partial or unknown legacy evidence is unavailable, not an
  attestation. Persist that evidence before pruning any row.

PRE_MATCH eligibility ends strictly before the earliest trusted kickoff and
never reopens as live cash-back. LIVE eligibility requires every exact
selected market to remain unresolved, not just an unfinished match. Any
resolved original leg, including a removed void leg, disables further
cash-back. Applicable identity, price or lifecycle changes require a new
displayed quote and explicit confirmation.

### Four feature-only message envelopes

| QueueNames member | Direction | Discriminants |
| --- | --- | --- |
| `CASH_BACK_REQUEST` | Bet -> Resulting | `QUOTE`, `CONFIRM` |
| `CASH_BACK_OUTCOME` | Resulting -> Bet | `QUOTED`, `UNAVAILABLE`, durable `ACCEPTED` / `REJECTED` |
| `CASH_BACK_SOURCE_REQUEST` | Resulting -> Backoffice / Gamemaster | `SNAPSHOT`, `RESERVE`, `RELEASE` |
| `CASH_BACK_SOURCE_REPLY` | Source owner -> Resulting | `SNAPSHOT`, `GRANTED`, `RELEASED`, `FENCED`, `DENIED` |

These reuse `IEvent`, `APublisher` and existing fanout/queue conventions, not a
generic RPC platform. Subscribers must use their own durable queue identities.
No cross-queue ordering is assumed. Persist exact request/publication
obligations before sending, use publisher confirms, replay after restart and
deduplicate by exact operation/request/decision identity, not delivery time.
Public DTOs are the public request, quote and receipt types, **not** the
internal operation/source envelopes or quote proofs. They contain no private
simulation seed, timeline, future outcome or financial-accounting instruction.

All new messages carry immutable domain times in `data`. `requestedAt` is
durable authenticated ingress/audit time, not late-acceptance authority.
`issuedAt`/`expiresAt`, source evidence `occurredAt`, grant `decisionTime` and
terminal receipt `decisionTime` survive republication unchanged. The existing
publisher still restamps only envelope `timestamp` / `sender`. Old settlement
messages may lack the new evidence; new cash-back messages cannot substitute
an envelope timestamp for a missing required domain time.

### Authority and generation binding

Quotes do not reserve. Confirmation owns one exact **UNDECIDED** slot in the
Resulting Bet: operation/fingerprint, expected revision, exact quote/proposal,
original manifest, deadline, participant obligations and grants. Both owners
participate for every selected event, grouping same-event selections and
using deterministic `(eventId, owner)` order. Persist each request obligation
**before** publishing it; contention rejects rather than indefinitely queues.

A source snapshot observes an empty hold at base generation `b`; it is not a
grant. It binds owner/event, immutable authority/lifecycle evidence, kickoff,
cutoff and source-owned quote evidence. Backoffice proves its lifecycle, not
Gamemaster prices. `cutoffAt: null` explicitly means that owner has no
additional timed cutoff, never that authority is unknown.

`RESERVE` binds the exact snapshot/authority, operation/fingerprint, original
manifest fingerprint, quote identity, expected Bet revision and deadline. An
atomic source CAS changes `b + empty -> b+1 + exact hold`. `GRANTED` echoes
the exact persisted request with granted generation `b+1`, database decision
time and evidence. Exact retries replay that grant without extending its time.
All source-authority writers must conflict with holds; Gamemaster must persist
its exact authority-change intent **before** publication/cursor advancement.

Only the canonical terminal Bet decision authorizes release. Acceptance,
rejection/expiry and result-first rejection compete for the **same** undecided
slot and observed Bet revision; the winner embeds the immutable receipt and
losers read it. An operation-history projection cannot decide independently.
Use the same Mongo `$$NOW` in the conditional decision and stored
`decisionTime`, strictly before the deadline. This is database-domain decision
time, not physical commit time or a monotonic-clock guarantee. A healthy
continuous shared Mongo clock and complete compatible-writer coverage remain
deployment prerequisites.

Release every **requested** participant, including lost grant replies.
`RELEASE` carries the original reserve request ID, operation/fingerprint,
base `b`, predetermined grant `b+1` and canonical terminal decision identity,
receipt/quote fingerprints, outcome, revisions and time. It must not require
an acknowledged grant to construct cancellation:

```text
b + empty                              -> b+2 + empty (FENCED)
b+1 + exact matching operation/hold     -> b+2 + empty (RELEASED)
```

This fences cancellation-before-reserve. A later `FENCED` observation may
prove the target generation is consumed while a **different newer hold still
exists**; it never asserts or clears that hold. Regressed/inconsistent state
is a protocol error. Generations are nonnegative safe integers; require room
for `b+2`, never wrap/reset, and never recreate missing/archived source events.
Holds have **no autonomous TTL**, worker-lease expiry or 15-second override.
Recovery durably decides expired operations first, then releases from the
winner. Receipt, history, publication and release obligations survive crash,
slot reuse and archive. Coordinator outage can block source progress until
recovery; a browser timeout cannot release authority.

### Settlement, rolling versions and late history

`ISettleSlipEvent.data.cashBack` is optional for old producers/documents, but
when present it is a complete immutable settlement ID/domain time, financial
snapshot/revision and remaining-principal settlement basis. `result: string`
is unchanged. No row-event extension is needed: exposure belongs to the
parent; future projection handlers must guard all row/winner-metadata paths.

Snapshots conserve `original = remaining + cumulativeClosed`; cumulative
return is distinct from closed principal. After normal settlement,
`remainingStakeMinor` records the settlement basis, while **active exposure
is zero** for every terminal parent. Full `CASH_BACK` freezes the closed
exposure; it cannot receive normal settlement or later winner metadata.

Projection applies only newer authoritative revisions; equal revisions must
agree exactly. A delayed immutable cash-back receipt can be deduplicated and
added to history after newer settlement **without** replacing its scalar
snapshot, incrementing its already-accounted totals, reopening status or
changing original wager/odds. Lower-revision messages never rewind state.
Legacy fallback to original stake is valid only for proven cash-back-pristine
records; absent evidence cannot reset a reduced remainder. No public
cash-back-history completeness flag is introduced, and existing live-history
attestations are unchanged.

Tests use actual npm aliases for `1.0.54` and the immediate published
`1.1.0-rc.1`, plus one shared type-checked/runtime fixture. They prove old
payload assignability, optional-field tolerance and envelope compatibility,
**not** database/broker race safety or safe mixed writers after activation.
Cash-back production must remain inactive until coordinated compatible
consumers, persistence/recovery and adversarial tests are delivered.
Pre-feature binaries are not a safe rollback target once cash-back state
exists; publication alone neither activates the feature nor changes that rule.

## Change and validation workflow

1. Read this file, the installed package declarations, every affected
   producer and consumer, and the exact service pins.
2. Update `common/src/` and `common/src/index.ts` together.
3. Add compile-time fixtures for old/new assignability and runtime tests for
   exports, enum values, publishers, listeners, and middleware as applicable.
4. Run from `common/`:

   ```bash
   npm ci
   npm test
   npm pack --json --pack-destination /absolute/private/artifact/directory
   ```

   If the shared npm cache has ownership problems, use a session-local
   `--cache` directory. Do not repair a shared cache with broad permission
   changes or deletion.
5. Inspect the packed file list and record the exact source commit, npm
   `shasum`, integrity value, and an independent SHA-256 of the tarball.
6. Test every affected service from a lock-exact `npm ci`. To test an
   unpublished tarball, unpack it and replace only that isolated copy's
   `node_modules/@betstan/common`. Do not use `npm install --no-save <tarball>`;
   npm may re-resolve unrelated TypeScript, Mongoose, or transitive
   dependencies and invalidate the comparison.
7. Exercise the rolling matrix: old producer/new consumer, new producer/old
   consumer, restart from historical data, and rollback to the prior package.
8. Publish only the reviewed tarball and only with explicit package-release
   authorization. Download the registry tarball afterward and require its
   SHA-256 to match the reviewed artifact.
9. Update all eight services to the exact published version in one coordinated
   change, refresh their lockfiles intentionally, run clean-registry
   `npm ci`, and execute the affected service and cross-service tests.

Publishing the package and repinning services are separate release steps.
Source existing in `common/` does not make an unpublished contract available
inside independently built service images.

## Review checklist

- `git ls-tree HEAD common` reports mode `040000`, never `160000`.
- No `.gitmodules` entry or nested `common/.git` exists.
- Source version identifies the next package candidate rather than colliding
  with immutable registry content.
- All eight service manifests and lockfiles use one exact published version.
- The packed artifact contains only the intended `build/**`, npm-required
  package metadata, and this README.
- Legacy runtime exports and enum values still match `1.0.54`.
- Immediate published-predecessor payloads remain assignable to the source
  candidate.
- Every affected service passes against the exact packed or published
  artifact without changing unrelated dependency resolution.
