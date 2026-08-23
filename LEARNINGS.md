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

### Fail-dark live activation
- `LIVE_KICKOFFS_ENABLED=true` is permanent only when no activation lease is present. A temporary activation also carries `LIVE_KICKOFFS_LEASE_UNTIL_EPOCH`; malformed or expired leases fail dark inside Gamemaster while already-started matches continue.
- The protected activation workflow first uses a bounded lease. Only the same run and source SHA may remove it, and only after production acceptance, protected evidence upload, and a final current-master/provenance revalidation.
- Disable and every ambiguous control failure set the flag false and remove the lease together. The lease remains the independent safety boundary if the workflow runner is hard-killed before its cleanup trap can execute.
- Deployment provenance must bind source SHA, build/deploy attempts, infrastructure artifact digest, runtime mode, and runtime fingerprint. Rechecking current `master` immediately before mutation and commit closes the preflight-to-mutation race.

---

## Testing conventions

### Setup file (`src/test/setup.ts`)
Backend services generally use an in-memory MongoDB instance, clear mocks and collections between tests, and stop Mongo in `afterAll`. Read each service's setup instead of assuming they are identical. Listener tests that need `AListener.channel` must use a concrete factory mock; a bare `jest.mock("@betstan/common")` can leave listener state undefined.

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
Tests construct `IPlaceBetEvent` objects directly (without publishing them), so `event.timestamp` is `undefined`. The `Bet` Mongoose model has `timestamp: { required: true }`. Using `event.timestamp` directly as the bet timestamp causes a `ValidationError`. Always fall back to the current time:
```typescript
timestamp: event.timestamp ?? new Date().toISOString(),
```

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
- A jobless stale GitHub queue record can be an inert provider artifact, but it
  is never authority to recover data or mutate production.
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
