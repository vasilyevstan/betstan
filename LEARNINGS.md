# Betstan — Session Learnings

## Repository overview

`betstan` is a microservices betting platform. Each service lives in its own top-level directory (`auth`, `backoffice`, `bet`, `event`, `gamemaster`, `moderation`, `resulting`, `slip`). Shared types, base classes, and utilities live in the normal tracked `common/` package and are published as `@betstan/common`; never recreate `common/` as a gitlink or submodule.

---

## Architecture patterns

### Messaging (AMQP / RabbitMQ)
- Every service communicates through RabbitMQ exchanges.
- Base classes live in `@betstan/common`: `AListener<T>` (consumers) and `APublisher<T>` (producers).
- The public base classes accept the structural `IAmqpConnection`; do not expose version-specific `Connection`/`ChannelModel` types because services intentionally carry different compatible `@types/amqplib` versions.
- `APublisher.publish()` stamps `data.timestamp` and `data.sender` onto every outgoing event before serialising it. This means the `timestamp` field on an `IEvent` is **set by the publisher at send time**, not by the originating request.
- A publisher retry stamps a different envelope timestamp. Persisted domain time, ordering, and idempotency fingerprints must prefer an immutable timestamp captured in the event data, such as placement `submittedAt`; use the envelope or row timestamp only for backward-compatible messages that lack it.
- Because of the above, when creating events manually in tests (without going through a publisher), `event.timestamp` is `undefined`. Any code that reads `event.timestamp` to populate a required model field must provide a fallback (e.g. `event.timestamp ?? new Date().toISOString()`).

### Singleton publishers — channel-leak fix (PR #29)
- The original code opened a new AMQP channel on every message by calling `new XPublisher(...); await publisher.init()` inside `onMessage`.
- Under load this drains RabbitMQ's per-connection channel limit.
- The fix makes each listener / worker store its publisher(s) as instance fields and initialise them once in an overridden `async init()`.
- Pattern for listeners:
  ```typescript
  private myPublisher!: MyPublisher;

  async init() {
    await super.init();
    this.myPublisher = new MyPublisher(messengerWrapper.connection);
    await this.myPublisher.init();
  }
  ```
- Pattern for workers (`GamemasterWorker`): expose an `async init()` and wire it in `index.ts` before calling `worker.work()`.

### Event scheduling ownership
- The `event` service owns future-event generation; `GET /api/event` is read-only and Gamemaster never creates replacement events.
- Scheduler events use deterministic epoch-aligned slots and a partial unique `slotKey` index so rolling event pods converge without leader election.
- A short-lived per-event publish claim and pending marker provide at-least-once `NEW_EVENT` retry while duplicate-safe consumers preserve existing documents.
- Backoffice and legacy events have no scheduler slot and are never counted, modified, deleted, or republished by the scheduler.

### Live simulation engine
- `gamemaster/src/simulation/` is pure and clock-independent: it uses named seeded RNG streams and emits integer offsets, never wall-clock timestamps.
- The persisted engine version and generated transitions are authoritative for an in-progress match; never regenerate them after an engine change.
- New simulations use an independent 256-bit lowercase hexadecimal seed. Treat a missing, malformed, short, uppercase, or public-ID-derived seed as unsafe and replace it before persisting the timeline; never expose seeds in public event payloads.
- Only `GOAL` transitions change the score. Penalty awards resolve later in the same half, and a scored penalty emits a linked goal.
- Live settlement identity is `marketId + marketVersion`; quote versions track price changes only, and remaining next-event markets settle explicitly to `NONE` at full-time.
- Every open quote expires at the next persisted simulation transition. Slip records one immutable server-generated submission time during its atomic draft-to-submitted transition, and Moderation requires an exact mirrored expiry plus `submittedAt` strictly before both `quoteValidUntil` and the first later transition that ended that quote's authority. Persist that authority end from the update payload's domain `occurredAt`, choose the earliest later sequence under out-of-order delivery, and use the current terminal mirror timestamp only as a backward-compatible fallback when old history lacks the additive field.
- Missing, malformed, or boundary-equal live expiry evidence fails closed at Event, client, and Moderation boundaries. A delayed market mirror may park a provably pre-cutoff submission, but it must not authorize an outcome-known bet.

### Privileged authorization and synthetic fixtures
- A signed JWT role is only a request hint. Every privileged mutation and every server-side acceptance-fixture scope must revalidate the current persisted role through auth and fail closed when auth is unavailable.
- Signup never accepts an administrator role. Persisted demotion or deletion revokes privileged mutations immediately, and `/currentuser` invalidates expired, deleted, or role-mismatched sessions, including bounded legacy tokens without `exp`.
- Synthetic production-acceptance events remain `OFFLINE`. Ordinary REST and SSE queries exclude them server-side; an acceptance view may request at most ten exact lowercase ObjectIDs and only a currently persisted administrator may receive them.
- Offline-event odds requests repeat authoritative administrator verification. Client filtering and a stale JWT claim are never security boundaries.
- Administrative catalog reads are privileged too: `/api/backoffice` revalidates the persisted role and must not return fixture metadata in an unauthorized error.
- A live update received before `NEW_EVENT` creates an `OFFLINE` projection. Metadata and visibility initialize independently so `NEW_EVENT` can repair legacy/event-visibility-first placeholders without undoing a newer visibility change.
- A visibility message may arrive before any event row. Persist it as pending on an `OFFLINE` placeholder, then apply it only after authoritative metadata arrives; ambiguous legacy hidden placeholders stay hidden.
- Competing `NEW_EVENT` and visibility placeholder upserts can race on the unique event ID. Both paths must treat duplicate-key as convergence and retry the pending decision against the winning row before acknowledging.
- Scoped clients immediately purge cached offline events and refresh authentication when REST or SSE access fails. A bounded authoritative REST reconcile continues while SSE is healthy because visibility removals and pre-match changes may not produce live snapshots.
- SSE is a bounded delivery hint, not an unbounded per-client queue. Close and unsubscribe a response when `res.write()` applies backpressure; the client must reconnect, poll REST, reconcile sequence gaps, and reject lower/equal snapshots.

### Fail-dark live activation
- `LIVE_KICKOFFS_ENABLED=true` is permanent only when no activation lease is present. A temporary activation also carries `LIVE_KICKOFFS_LEASE_UNTIL_EPOCH`; malformed or expired leases fail dark inside Gamemaster while already-started matches continue.
- The protected activation workflow first uses a bounded lease. Only the same run and source SHA may remove it, and only after production acceptance, protected evidence upload, and a final current-master/provenance revalidation.
- Disable and every ambiguous control failure set the flag false and remove the lease together. The lease remains the independent safety boundary if the workflow runner is hard-killed before its cleanup trap can execute.
- Deployment provenance must bind source SHA, build/deploy attempts, infrastructure artifact digest, runtime mode, and runtime fingerprint. Rechecking current `master` immediately before mutation and commit closes the preflight-to-mutation race.

### Mongo aggregate concurrency and rolling compatibility
- Raw Mongo inserts and upserts that bypass Mongoose `save()` must initialize
  `__v: 0` when later mutations rely on optimistic concurrency. Before
  mutating a historical versionless document, atomically initialize the
  missing version key and reload the document; compatibility backfills must
  also repair missing version keys.
- A Slip board revision and fingerprint are authorization evidence, not merely
  display metadata. Every row mutation, including deletion, rotates both
  values so a stale tab cannot place a materially changed draft.
- Draft mutation and deletion must be one atomic database operation scoped by
  slip ID, owner, kind, `DRAFT` status, revision, and fingerprint. A document
  loaded as draft must never be saved or deleted later without those
  predicates; placement or another mutation winning the race returns a
  conflict instead of changing the submitted/latest board.
- Decline restoration may merge only into a board that is still `DRAFT`.
  Duplicate delivery treats a replacement that progressed to `SUBMITTED` or
  archive as completed and must never reset or resurrect it.
- Compose reusable Mongo predicates without duplicate logical keys. Spreading
  one filter containing `$or` beside another top-level `$or` silently drops a
  safety condition in JavaScript; combine them under `$and`. Publication
  claims must atomically require both an unpublished decision and a claimable
  lease.
- During a rolling Client/API upgrade, the boards read endpoint records a
  bounded confirmation scoped to a hash of the authenticated session plus the
  user, kind, slip, revision, and fingerprint. Never overwrite one
  slip-global confirmation from every session: another device could otherwise
  authorize a stale tab. The quiesced compatibility backfill seeds a separate
  one-time fallback for active drafts so tabs opened before the API rollout
  remain placeable; normal reads do not overwrite that fallback. Explicit
  confirmation fields from a new Client remain authoritative. Record
  compatibility confirmations only for `DRAFT` boards; submitted-board polling
  must remain read-only with respect to this evidence.
- A zero-row approved aggregate is a valid recoverable state after all
  manual-void rows were published and removed before a crash. Terminal sweeps
  must discover it and finalize the parent as void instead of filtering it out
  as having no unsettled rows.
- Terminal recovery must cover every persisted boundary: missing legacy
  publication state, pending state, stale or timestampless publishing claims,
  and `PUBLISHED` records left active by a crash before archival. Archive an
  already-published record without republishing it, exclude live claims from
  bounded sweep batches, and finish auxiliary cleanup before deleting the
  active recovery anchor.

---

## Testing conventions

### Setup file (`src/test/setup.ts`)
Backend services generally use an in-memory MongoDB instance, clear mocks and collections between tests, and stop Mongo in `afterAll`. Read each service's setup instead of assuming they are identical. Listener tests that need `AListener.channel` must use a concrete factory mock; a bare `jest.mock("@betstan/common")` can leave listener state undefined.

Browser API fixtures must preserve concurrency contracts, not only response
shapes. Mock Slip boards carry and rotate revision/fingerprint evidence, and
placement mocks reject mismatched confirmations so Playwright exercises the
same stale-board boundary as the real API.

### Shared mock prototype trap
Because `@betstan/common` is auto-mocked, `APublisher.prototype.init` becomes a single `jest.fn()`. **All publisher classes that extend `APublisher` without defining their own `init` inherit the same mock function.** This means:

```typescript
// SettleSlipRowPublisher.prototype.init === APublisher.prototype.init
// SettleSlipPublisher.prototype.init   === APublisher.prototype.init  (same reference!)
```

A test that calls `init()` on two different publishers and then asserts `toHaveBeenCalledTimes(1)` on either publisher will **fail with count 2** because both calls increment the same underlying mock.

**Fix**: in the test file add a `beforeAll` that creates separate own-property spies on each publisher prototype:
```typescript
beforeAll(() => {
  jest.spyOn(SettleSlipRowPublisher.prototype, "init").mockResolvedValue(undefined);
  jest.spyOn(SettleSlipPublisher.prototype,    "init").mockResolvedValue(undefined);
});
```
`jest.spyOn` sets an own property on the prototype, decoupling it from the inherited mock. `jest.clearAllMocks()` in `beforeEach` resets call counts without removing the spy, so it works correctly across all tests in the file.

### Timestamp in PlaceBetListener tests
Tests construct `IPlaceBetEvent` objects directly (without publishing them), so `event.timestamp` can be `undefined`. The `Bet` Mongoose model has `timestamp: { required: true }`. New placement events use immutable `data.submittedAt`; legacy fixtures and payloads fall back to the envelope timestamp, then a row timestamp, then the current time:
```typescript
timestamp:
  event.data.submittedAt
  ?? event.timestamp
  ?? event.data.rows.find((row) => row.timestamp)?.timestamp
  ?? new Date().toISOString(),
```
Retry tests must keep `submittedAt` fixed while changing `event.timestamp` and prove the second delivery is an exact duplicate with no placement-conflict record.

---

## Build & test commands

```bash
# Per service (replace "resulting" with the service directory name)
cd resulting && npm ci && npm run test:ci
```

`production-build.yml` runs coverage gates for every backend service and the client on pull requests into `dev` or `master`. Per-service `tests-*.yaml` workflows provide additional path-scoped feedback.

---

## Branch and delivery governance

- Never commit or push directly to `master`.
- Normal work enters `dev`; production promotion is an up-to-date `dev`-to-`master` pull request.
- Promotion requires base-scoped statuses whose head and unique merge-snapshot copies point to the same trusted runs and current PR head/base/repository. Head-only, merge-only, or branch-name evidence can be stale or unrelated.
- Skipped, stale, pending, neutral, or unrelated runs are not green gates.
- A squash promotion breaks shared ancestry until the new `master` commit is merged back into `dev`; perform that synchronization immediately.
- Manual central production workflow dispatches and reruns are emergency operations requiring an exact full master SHA and `production-emergency` approval. Old central and per-service workflow identities stay disabled so historical definitions cannot be rerun.
- Live activation and disable are separate protected OCI control-plane workflows. Activation is leased until its complete acceptance evidence is committed; disable may target an older deployed SHA only while that SHA remains an ancestor of current `master`.
- The trusted PR publisher compares the exact `production-build.yml` blob with the default branch. When adding a repository-wide static guard, prefer invoking it from an existing trusted entrypoint already called by that workflow; changing the trusted workflow and its verifier in the same PR intentionally fails closed.
- Workflow-dispatch inputs used by shell steps must enter through a step/job environment binding. A repository-wide parser and adversarial fixtures reject direct `${{ inputs.* }}` and legacy `${{ github.event.inputs.* }}` interpolation inside `run` scripts.
- GitHub status functions such as `failure()` and `cancelled()` belong in
  `if`, not a step `env`. For final provenance scripts, bind
  `${{ job.status }}` and validate its `success`/`failure`/`cancelled` domain.
- Rollout-order contracts are runtime-specific. OCI starts API dependencies
  before Client and keeps Gamemaster last; do not make a stale shared expected
  list override a stricter runtime contract.
- Readiness evidence is fail-closed. When its required Mongo safety counters
  expand, update every Azure and OCI rollback fixture in the same change;
  omitted counters are `unknown`, not zero, and must prevent image mutation.
  Queries for optional nested safety markers require explicit field existence
  and a non-null value so the production predicate is reviewable in fixtures.

## Resolved failures and durable rules

- An orphaned `common` gitlink without `.gitmodules` previously broke checkout cleanup. `common/` is now maintained as a normal tracked package while services consume explicit published versions from npm.
- Per-service workflows use `actions/checkout@v4`; do not reintroduce `checkout@v2`.
- Post-deploy browser tests require both `npm ci` in `client` and `npx playwright install --with-deps chromium`.
- An async `forEach` does not await database operations. Use `for...of` with `await` when completion order or connection lifetime matters.
- Coverage instrumentation can report `branches=0` with a non-zero branch total. Keep line coverage mandatory and apply the branch threshold only when a meaningful branch percentage exists.

## OCI cutover and Azure retirement

- Cross-cloud cutover safety comes from independent fences: close public
  writes, freeze producers, preserve exact queue consumers, lock Mongo, bind
  every phase to immutable run/SHA provenance, and recover stop-only.
- A strict evidence consumer must share its schema with the producer. Adding
  valid provenance fields only on one side can block the terminal operation.
- Integration stubs must preserve that command-boundary schema too. A lock
  fixture must return the real ConfigMap JSON, including lease and fencing
  fields, rather than an older pipe summary that production no longer reads.
- A failed deployment may re-enter maintenance only after it successfully
  validated and accepted the exact data handoff. An invalid, stale, or
  unauthorized deployment request must not independently quiesce writers,
  acquire the database lock, or extend an outage.
- Azure resource-ID fingerprints are case-preserving. AKS exposes `eTag`, and
  provider/SDK transformations of `If-Match` must not replace the exact
  optimistic-concurrency value or fall back to a wildcard.
- Resource absence, identity hygiene, and delayed billing are separate
  completion phases. Retain documented zero-cost Azure recreation
  configuration while deleting exact temporary migration access.
- Public TLS checks must account for platform behavior without weakening
  trust. macOS LibreSSL needs a graceful `Q` input after `s_client` validation.
- Contract fixtures must be reentrant. Fixed directories make parallel tests
  erase each other's state, and output pipelines require `pipefail` so a
  failing suite cannot appear green.
- A protected environment wait is active progress. Report the exact run,
  phase, and pending environment instead of presenting a silent wait.
- A jobless stale GitHub queue record can be an inert provider artifact, but
  only the idempotent capacity workflow may ignore one while active: it must
  be an old first-attempt manual dispatch for a non-current SHA, have no jobs
  or approvals, and be superseded by a later successful first-attempt run for
  the same workflow and SHA. Never extend that exception to deploy, activation,
  rollback, infrastructure, or data workflows, and never treat it as authority
  to recover data or mutate production.
- Deleted Entra service principals require a successful list-all,
  client-side exact-ID absence probe; a server-filter 404 is not usable
  evidence. Role-assignment IDs must also bind to their declared parent scope.
- Billing closure starts only after a 96-hour ingestion grace from the first
  full UTC billing day after retirement and requires three clean ActualCost
  and AmortizedCost observations over at least 96 hours. Resource retirement
  remains complete while that separate evidence phase is pending.
- Billing evidence must normalize each bounded page before aggregation and
  append under a lock with exact response-digest pairs and a predecessor hash.
  Continuations repeat the exact filtered POST on the bound subscription, and
  only transient provider failures receive bounded retries. Signal handlers
  terminate before lock cleanup, and verified dead owners are recoverable.
  Item-level usage prevents a charge/refund cancellation from looking clean.
  A second currency query, malformed `nextLink`, trailing `NO_ROWS` reset, or
  rewritten prior prefix invalidates the evidence rather than defaulting to a
  clean window.
