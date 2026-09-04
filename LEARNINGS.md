# Betstan — Session Learnings

## Repository overview

`betstan` is a microservices betting platform. Each service lives in its own top-level directory (`auth`, `backoffice`, `bet`, `event`, `gamemaster`, `moderation`, `resulting`, `slip`). Shared types, base classes, and utilities live in the normal tracked `common/` package and are published as `@betstan/common`; never recreate `common/` as a gitlink or submodule.

---

## Architecture patterns

### Shared package source and publication

- `common/src/` is the canonical source for the next `@betstan/common`
  candidate, while each deployable service compiles against its exact
  published manifest/lockfile pin. Always inspect and report both versions;
  repository source being newer does not make it available in a service image.
- npm versions are immutable. After publishing a version, bump the Common
  source version before its next content change so a locally packed artifact
  cannot silently share a name with different registry content.
- Keep all eight backend consumers on one exact version. Never use a caret,
  dist-tag, `file:`, workspace, symlink, gitlink, or submodule as a deployment
  dependency.
- Validate Common with legacy runtime/export checks, immediate-predecessor
  assignability, legacy AMQP types, and `npm pack`. For unpublished consumer
  testing, start from lock-exact `npm ci` and replace only the isolated
  `node_modules/@betstan/common` directory with the unpacked tarball.
  `npm install --no-save <tarball>` is not valid evidence because it can
  re-resolve unrelated TypeScript, Mongoose, or transitive dependencies.
- Record source SHA, packed file list, npm integrity/shasum, independent
  tarball SHA-256, publish authorization, dist-tag, and downloaded registry
  hash. Publish first; repin and clean-install all consumers second.
- Service-local compatibility bridges are temporary rolling-release adapters,
  not another contract owner. Add the wire value to `common/src/` in the same
  feature, keep it additive, and remove the bridge after consumers adopt the
  published package containing it.

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
- Dense pre-match sections and a sparse two/three-card pre-match row use the
  same responsive one/two/three-card grid; a sparse pre-match row must
  consume the stage intentionally: one desktop card uses a bounded two-thirds
  row and two cards complete a half-width row. Keep scores, incidents, active
  markets, selections, and non-terminal availability states visible; omit only
  semantically terminal market cards, whose state remains in the authoritative
  live snapshot and settlement history.
- Superseded narrow-live-card rule: when exactly one countdown, active-live,
  or retained-finished event occupies the separate upper section, it does not
  follow the pre-match two-thirds/half-width sparse rule above. It uses the
  full event-stage width and arranges its semantic regions side by side,
  because a single information-dense live/countdown card should use full-stage
  width and parallel regions when that reduces its vertical footprint below a
  comparable pre-match row. Its collapsed height must stay within a bounded
  budget relative to that pre-match row; only a user-expanded historical
  timeline disclosure may exceed the budget.
- Betting controls in one market share geometry. Wrapped labels may increase
  the row height, but buttons stretch together and odds remain on one baseline.
  Fixed ten-option Correct Score boards use a container-aware five- or
  two-column layout so every row is balanced and every control remains at least
  touch-target width. Recheck the board inside every changed parent layout and
  around container-query transitions: touch width alone misses prices that
  escape their controls. A shared section badge/title must span the whole
  product deck rather than auto-place above one sibling market.
- Read-only review roles must be read-only in their declared capabilities,
  not only in prose. UX reviewers consume rendered evidence from the test
  owner; they do not need unrestricted command execution to assess it.
- `EVENT_RESULT` is terminal domain authority even when it reaches a consumer
  before delayed live snapshots. Earlier snapshots may fill bounded history,
  but only the matching `FULL_TIME` projection may restore the retained result
  card; no live update may reset `RESULTED` or delete Moderation's resulted
  guard.
- Persist the last explicit visibility decision separately from current
  runtime visibility and transient pending delivery. A completed OFFLINE
  decision must survive result retention and delayed live-update races.
- The persisted engine version and generated transitions are authoritative for an in-progress match; never regenerate them after an engine change.
- New simulations use an independent 256-bit lowercase hexadecimal seed. Treat a missing, malformed, short, uppercase, or public-ID-derived seed as unsafe and replace it before persisting the timeline; never expose seeds in public event payloads.
- Only `GOAL` transitions change the score. Penalty awards resolve later in the same half, and a scored penalty emits a linked goal.
- Live settlement identity is `marketId + marketVersion`; quote versions track price changes only, and remaining next-event markets settle explicitly to `NONE` at full-time.
- Every open quote expires at the next persisted simulation transition. Slip records one immutable server-generated submission time during its atomic draft-to-submitted transition, and Moderation requires an exact mirrored expiry plus `submittedAt` strictly before both `quoteValidUntil` and the first later transition that ended that quote's authority. Persist that authority end from the update payload's domain `occurredAt`, choose the earliest later sequence under out-of-order delivery, and use the current terminal mirror timestamp only as a backward-compatible fallback when old history lacks the additive field.
- Missing, malformed, or boundary-equal live expiry evidence fails closed at Event, client, and Moderation boundaries. A delayed market mirror may park a provably pre-cutoff submission, but it must not authorize an outcome-known bet.

### Product-wide UI/UX consistency

- Every user-facing visual or interaction change uses one two-phase
  `betstan-ux-ui-expert` work unit: establish a named consistency baseline
  before implementation, then review the immutable exact-head result in the
  same context.
- Build the baseline from accepted product semantics and stable shared shells,
  components, variables, tokens, and repeated patterns across routes. A single
  screenshot or the newest page is evidence, not a design system.
- Compare hierarchy, typography, spacing, content width, surfaces, control
  geometry, semantic status cues, copy, loading/empty/error/disabled/live/
  terminal states, responsive modes, v1/v2/v3, light/dark, keyboard/focus
  order, and live-update movement where applicable.
- Every material divergence is a required consistency fix, an intentional
  product exception with a semantic rationale, or optional polish. Do not make
  subjective preference a blocker, and do not silently normalize an
  unexplained exception into a new pattern.
- Source, stable references, and supplied screenshots can establish a design
  inconsistency through bounded expert judgment. Exact collision, clipping,
  overflow, touch-target, pixel-geometry, or dynamic-interaction claims still
  require the smallest suitable rendered evidence; a user-facing change alone
  does not require a new visual-regression matrix.

### Live timeline completeness and market alignment

- Active-tail versus full timeline semantics: an active-live view may keep
  showing only its latest incidents, but a finished/retained view must never
  present a `.slice(-5).reverse()` latest-events tail as a complete match
  summary. Preserve the authoritative oldest-to-newest source order and show a
  compact chronological key-moments list plus a native, expandable
  chronological full timeline.
- Explicit completeness attestation: label a timeline `Full timeline (N)` only
  when the producer attested a validated cumulative payload
  (`incidentsComplete`/`incidentHistoryComplete`) built from its authoritative
  transition history and every raw incident validated within the phase-aware
  limit. The attestation is optional and additive so old producers stay
  compatible with new consumers and new producers stay safe for old consumers.
- Partial legacy copy: a stored row, single-incident compatibility update,
  malformed/truncated input, or non-terminal phase must keep the completeness
  flag absent/false and be labelled `Available timeline (N)` with an explicit
  note that earlier incidents may be unavailable. A previously finished row
  cannot be reconstructed after the fact; honesty about partial history beats
  a false completeness claim.
- Penalty linkage: suppress a derived scoring incident (for example a goal
  linked to a scored penalty) only via an exact relation-ID match against a
  displayed incident, never a team/minute heuristic that can hide or duplicate
  an unrelated incident.
- Stable identity-preserving presentation order: a presentation sort (for
  example a numeric scoreline order) is all-or-nothing against a fully valid
  board and must preserve each option's original ID/name/value tuple; a
  malformed board keeps its original order instead of a partial re-sort.
  Selection identity stays ID-based, so a presentation reorder never
  reinterprets an open or historical bet.
- Full-stage compact live regions: a single upper-section countdown,
  active-live, or retained-finished event uses full event-stage width and
  parallel semantic regions instead of vertical stacking, staying within a
  bounded height budget relative to the comparable pre-match row; an
  intentionally expanded historical disclosure is the one allowed exception.
- Sparse-grid and alignment lessons: a compact market grid collapses phantom
  empty tracks with `auto-fit` (not `auto-fill`); market cards sharing a row
  stretch to equal height and top alignment; a status badge wraps only between
  words; and sibling pre-match cards keep aligned market headings, control
  bounds, and odds baselines regardless of team-name length.
- Access wording must be validated at the capability level: “visible” means a
  discoverable entry point, while “available” or “accessible” means the real
  routed data and intended actions work in every named authentication state.
  A public Backoffice link followed by a denial/login-guidance screen is not
  anonymous access. Backoffice is intentionally a public, no-store control
  surface; preserve bounded input validation and idempotent/atomic writes
  rather than reintroducing an inferred administrator gate.
- Public irreversible mutations must not convert absent values into valid
  destructive defaults or return success for a conflicting write. Require
  explicit scores, return `404` for a missing event, treat only an identical
  repeated result as idempotent, and return `409` for a different terminal
  result or an overlapping visibility change.
- A database write plus an unconfirmed broker send is not a completed
  mutation. Persist a retry marker in the same event write, publish through a
  confirm channel, clear the marker only after confirmation, and replay
  pending markers after restart. Creation retries also need a stable request
  ID so an ambiguous response cannot create a second event.
- Terminal ordering and auth safeguards: a result/`FULL_TIME` write decision
  must be atomic against the current live phase and explicit/legacy offline
  intent so no interleaving can leave a fully onboarded, non-retired terminal
  event `OFFLINE`. Apply that predicate to every terminal writer and delayed
  recovery path at write time; a stale pre-read must not overwrite a
  concurrent administrator `OFFLINE` decision. The inverse is equally
  important: a placeholder stays fail-dark until event metadata and visibility
  authority are initialized, even with pending `ONLINE` intent. An
  equal-sequence authoritative merge keeps the stronger terminal history while
  adopting repaired status/visibility; and an acceptance-scoped retained
  `OFFLINE` snapshot must not render, clear, or leak while current-user
  authorization is unresolved.
- Exact-SHA production evidence: when this class of change reaches
  production, extend the existing post-deploy acceptance journey to verify
  full bounded timeline completeness/labelling, penalty-linked deduplication,
  live-card relative height and pre-kickoff market alignment, stable Correct
  Score order, and visible administrator navigation, and record the exact
  master SHA and run evidence in `docs/wiki/Live-Betting-Production.md`
  alongside the existing release chain.

### Privileged authorization and synthetic fixtures
- A signed JWT role is only a request hint. Every privileged mutation and every server-side acceptance-fixture scope must revalidate the current persisted role through auth and fail closed when auth is unavailable.
- Signup never accepts an administrator role. Persisted demotion or deletion revokes privileged mutations immediately, and `/currentuser` invalidates expired, deleted, or role-mismatched sessions, including bounded legacy tokens without `exp`.
- Routine production E2E checks reuse the dedicated low-privilege `betstan-e2e-protected-v2` account with one stable 4-20 character credential supplied identically by the reviewer-gated `oci-production` and `oci-migration` environments: rotate both bindings together, log in first and create the account only when absent, never keep a source fallback, elevate it only for the bounded administrator action, always revoke it to `USER`, and delete only exact proven acceptance drafts rather than deleting the account. Resolve first creation through the API so browser `maxLength` behavior cannot silently truncate a protected credential, and clear a UI password field before surfacing login failure diagnostics. If a credential or its deterministic truncation reaches an artifact, rotate both protected bindings immediately, delete that exact artifact, and retire the affected identity at `USER` instead of elevating it or restoring the exposed secret.
- Synthetic production-acceptance events remain `OFFLINE`. Ordinary REST and SSE queries exclude them server-side; an acceptance view may request at most ten exact lowercase ObjectIDs and only a currently persisted administrator may receive them.
- Offline-event odds requests repeat authoritative administrator verification. Client filtering and a stale JWT claim are never security boundaries.
- Backoffice catalog reads and mutations are intentionally public. Production
  acceptance must prove anonymous `200` array responses and usable controls,
  while rollback probes may accept the historical protected `401` shape only
  when validating an older generation.
- Keep the legacy Backoffice `AUTH_SERVICE_URL` and `JWT_KEY` deployment
  bindings even when the current public image no longer reads them. An
  image-only rollback reuses the current Deployment environment, and the
  immediately previous protected image still needs both values to boot.
- A durable publication marker is forward-compatible data but not a backward
  replay mechanism. Before rolling back to an image without the worker,
  establish the reviewed HTTP write fence, keep the current worker alive, and
  fail closed until every pending marker drains. Skip the drain only when exact
  target source proves that the rollback image starts the compatible worker,
  and keep the fence active after partial image mutation. Record that state in
  failure evidence so partial recovery can re-establish the fence, restore the
  exact pre-run images, and release writes only after readiness passes;
  otherwise the older image can strand a database mutation that never reached
  RabbitMQ.
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
- Mongo index introspection fails with `NamespaceNotFound` on a brand-new
  database. Readiness guards may treat only error code 26 as an empty index
  set, then create the guarded index; every other inspection error remains a
  startup failure.
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
- The conductor owns every registered unit from before launch through terminal
  evidence and accepted handoff. Pair event notifications with a maximum
  wall-clock checkpoint, reconstruct lost observation from exact references,
  and treat an unstarted downstream handoff as a stall.
- A stalled watcher is not a stalled job, and a running watcher is not job
  progress. Recover read-side observation directly; route mutations to one
  exact owner with a deadline and keep the same unit open until evidence moves.
- Before declaring an executing GitHub job stalled, compare its current step
  and elapsed time with recent successful runs of the same workflow and job on
  a comparable runner. Local execution time is not a CI baseline, and
  historical duration never excuses an actionable approval or missing
  progress signal.
- A workflow dispatch URL is event-acceptance evidence, not job
  materialization. Keep a manually enabled workflow active until the exact run
  has a real job and expected protected gate, then disable it before approval.
  Capture the run ID from the URL, and inspect that run before retrying when a
  local assertion fails after dispatch.
- Pull-request title and body edits trigger `pull_request.edited` validation.
  Treat PR metadata changes as workflow-producing work and keep them outside
  active data-to-deploy handoffs or other production-exclusivity windows.
  Derive the exact head SHA from Git or GitHub when preparing evidence and
  prefer one complete edit over repeated manual SHA corrections that start
  duplicate runs.
- A late specialist report must be revalidated against its recorded SHA,
  current authoritative branch, and runtime topology. Tool-heavy work that
  returns after the release state changed cannot reopen a gate with stale
  assumptions.
- When the user explicitly prioritizes the production critical path, freeze
  unrelated documentation and metadata changes until the safe terminal gate.
  Required safety checks still run; the scope freeze prevents self-created
  workflow conflicts rather than weakening release evidence.
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

### Agent orchestration and review governance

- The conductor spans the quality chain but never substitutes for a gate.
  `.github/agents/README.md` owns the exact chain and handoff taxonomy.
- A process can be running and still be stalled. Tool activity, logs, and
  watchers do not replace a bounded first response, objective progress,
  checkpoint, or accepted downstream handoff.
- Keep corrections in the originating agent context with a bounded attempt
  count. Replacement, summary-only, or status-only agents create lost context
  and conflicting ownership.
- Three independent simplifier passes need distinct model families, identical
  sealed input, high reasoning, and one conservative synthesis. Fewer than
  three completed passes blocks; safety and compatibility cannot be removed by
  majority vote.
- PR descriptions are durable evidence. Use
  `.github/pull_request_template.md` for the exact core and conditional fields.
- Copilot CLI automatic approval removes only the personal prompt. It never
  removes exact-SHA, trusted-check, review-thread, workflow-inventory,
  environment, or exclusivity gates. Human/default PRs require approval bound
  to their current head SHA.
- `copilot-cli-managed` is a repository convention rather than cryptographic
  provenance because CLI and human `gh` operations share one GitHub identity.
- Opening-label reconciliation is authorized only when the server-owned label
  timestamp is at or after the original `opened` transition cutoff and no more
  than 300,000 ms (five minutes) after it; queueing, replay, or re-execution
  cannot extend that window. GitHub may serialize distinct creation and label
  mutations to the same whole-second timestamp. Equality is accepted only with
  the complete direct or inverse proof; a timestamp even 1 ms before the cutoff
  is not reconciliation authority. Direct ordering also requires the label
  timestamp to strictly precede the earliest exact-lineage status creation,
  while inverse ordering requires identical event and live `updated_at` values
  and allows the marker on either side of the label. The broad opening snapshot
  mismatch permits only fail-closed inspection and never grants reconciliation:
  an out-of-window replay without a marker stays pending, an existing mismatch
  writes the permanent tombstone, and any intervening `updated_at` change fails
  closed. A same-cutoff tombstone cannot be replaced or revived; only a strictly
  later `edited`, `synchronize`, or `reopened` transition can recover the
  lineage. Preserve the original event cutoff, run binding, and policy-run
  target. Label events remain non-producing; any other later label drift writes
  a permanent pending tombstone that label restoration, workflow completion,
  or manual refresh cannot revive. Manual refresh may bind an existing marker
  but never creates one or supplies quality evidence. Only an exact quality run
  created strictly after the original cutoff may bind.
- Version 3 quality markers use
  `v3|<pr>|<action>|<cutoff-ms>|<u|p|x|runId>|<content-fingerprint>|<labels-fingerprint>`.
  `u` records only an unconfirmed direct opening-label snapshot mismatch, `p`
  records a confirmed transition without a bound run, a positive run ID
  records the confirmed exact binding, and `x` permanently tombstones the
  cutoff. A `u` marker cannot bind a run, publish quality success, or consume an
  authorization receipt. The qualifying exact `labeled` event appends durable
  `p` before any optional run binding, and a label handler never consumes an
  authorization receipt. An exact replay of the same qualifying `labeled`
  event is inert after `p` or a run is durable; a later label mutation remains
  drift.
- Recovered opening-label authority is revalidated before every success-capable
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
- At the greatest cutoff, `x` dominates every other state; absent `x`, any
  version 1 or version 2 marker makes that cutoff fail-closed legacy; otherwise
  one compatible version 3 lineage resolves positive run ID over `p` over `u`,
  independent of status order. Conflicting positive run IDs or incompatible
  action, content, policy-run target, or label progression fail closed, and a
  lower state cannot downgrade a higher state. Version 1 and version 2 markers
  cannot newly bind, succeed, or consume an authorization receipt; a version 2
  `x` remains a permanent tombstone. Only a strictly later `edited`,
  `synchronize`, or `reopened` transition may recover, never a later or
  replayed `opened` event.
- Once any version 3 marker exists, operational rollback must retain version 3
  parsing and ledger authority: recovered opening-label authority is not
  durable in marker v3, so every publisher able to bind or succeed such a
  lineage must revalidate the ledger; retaining version 3 parsing alone is
  insufficient, and rollback to a publisher lacking ledger authority is
  prohibited; use a reviewed forward correction. A version-2-only publisher
  is fail-closed compatibility, not restored release authority.

## Resolved failures and durable rules

- An orphaned `common` gitlink without `.gitmodules` previously broke checkout cleanup. `common/` is now maintained as a normal tracked package while services consume explicit published versions from npm.
- Per-service workflows use `actions/checkout@v4`; do not reintroduce `checkout@v2`.
- Post-deploy browser tests require both `npm ci` in `client` and `npx playwright install --with-deps chromium`.
- First-attempt-only script fixtures must explicitly set or clear
  `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`. Ambient metadata from a GitHub
  Actions rerun can otherwise reject a fixture before the assertion it was
  intended to exercise.
- Portable command fallbacks must try the current platform's successful form
  first and capture output only from the selected probe. A nominally failed
  GNU/BSD variant can emit partial or misleading stdout, or even succeed with
  unrelated semantics.
- An async `forEach` does not await database operations. Use `for...of` with `await` when completion order or connection lifetime matters.
- Coverage instrumentation can report `branches=0` with a non-zero branch total. Keep line coverage mandatory and apply the branch threshold only when a meaningful branch percentage exists.

## OCI cutover and Azure retirement

### Public GHCR application images

- OCI runtime identity and application-registry identity are separate
  authorities. Production application references must be
  `ghcr.io/vasilyevstan/betstan-images@sha256:...`; verify the GHCR provider,
  host, exact package, exact full-SHA `arm64-<service>-<sha>` tag, manifest
  digest, and ARM64 platform digest independently.
- Bootstrap the tiny repository-linked sentinel with `GITHUB_TOKEN`, then a
  human sets Package visibility to Public once. A successful build must prove
  a clean-config anonymous pull; never infer public visibility from a
  successful authenticated push. Public GHCR runtime pulls need no
  `imagePullSecret`, PAT, or node credential. GitHub Packages REST operations
  for this user-owned container package use `/users/{owner}/packages`, never a
  nonexistent repository-scoped package route.
- OCIR deletion means there is no remote fallback. Before an application
  rollout, recover a still-running OCIR baseline only by comparing all nine
  cached k3s image IDs against trusted provenance and exporting exact
  containerd images through the protected Bastion tunnel. Validate each OCI
  archive and upload its exact ARM64 manifest/config/layer bytes; a Docker
  load/push conversion is not digest-preserving authority. Do not rebuild and
  relabel it as cache recovery.
- Build and recovery workflows need terminal resume paths before they mutate
  a registry or Deployment. Stage normal builds by digest; repair a partial
  generation only through a new human-authorized first-attempt run that
  rebuilds and compares existing ARM64 platform digests while preserving each
  verified tag manifest. Reproducible repair requires commit-derived
  `SOURCE_DATE_EPOCH` plus pinned timestamp, compatibility, media-type, and
  compression exporter behavior. Recovery may adopt and skip work only after
  re-proving the trusted ARM64 digest and live pod identity.
- Durable recovery planning must precede every workload mutation. Upload the
  original transition plan and queue baseline first; a redispatch explicitly
  selects the prior failed/cancelled first attempt, verifies immutable source,
  image, infrastructure, plan, and baseline hashes, and rewrites only carrier
  lineage. Never recapture a post-mutation state as the rollback baseline.
- Registry retention must bind each protected source to its truthful origin
  artifact. A normal deployed generation requires both build and deployment
  evidence. A recovered baseline is authorized by its successful terminal
  cache-recovery run and recovery provenance, never by relabeling its
  historical OCIR build as a GHCR build. Untagged child or interrupted-staging
  manifests are tracked separately and cannot make a complete tagged
  generation ambiguous.
- Container registry version IDs can own tags from multiple source
  generations after image reuse. Never delete a version that carries any
  protected tag. Authenticate obsolete generations before planning, persist
  and hash-bind the exact normalized state, generation-to-version map, and
  deletion IDs, resume only missing planned deletions, and re-read the registry
  before claiming terminal convergence.
- Registry publication and account-scoped Packages REST administration are
  distinct token capabilities. Use repository `GITHUB_TOKEN` for publication
  and by default for package metadata/retention; a protected least-privilege
  classic PAT may be a metadata/retention fallback only, never a push or
  runtime credential.
- Keep one application-image control plane. Once GHCR owns publication and
  retention, remove legacy OCIR registry phases from dispatch choices and
  hard-disable their retained audit-only job rather than leaving two
  production-capable cleanup paths.
- Keep the trusted `production-build.yml` byte-identical to the default branch
  when adding release validation. Route new GHCR contracts through an existing
  checked-in test entrypoint that workflow already invokes, while
  `oci-validate` exercises the complete OCI matrix; do not weaken the
  branch-policy blob check or edit the trusted workflow only to add test lines.
- A failed `kubectl get` is not evidence that an optional resource is absent.
  Use `--ignore-not-found`, accept only empty successful output as NotFound,
  and block mutation on API, timeout, or authorization errors.
- A green recovery requires more than Kubernetes rollout status. Keep the
  recovery run incomplete until API contracts, RabbitMQ queue readiness, and
  public Playwright checks pass. Keep legacy pull credentials through those
  checks; retire them and the exact empty OCIR repository only afterward.
  Downstream rollback authority may trust only that successful terminal run.
- Pin privileged helper containers as well as Actions. In particular, a
  digest-pinned `docker/setup-qemu-action` still inherits risk from a mutable
  default `tonistiigi/binfmt` image unless its `image` input is also a digest.
- Production SSH must not use trust on first use. Retrieve the target key
  through OCI Instance Agent Run Command. Use that authenticated channel to
  observe the regional Bastion key when an ACTIVE session returns null
  `bastion-public-host-key-info`, while preferring authenticated session
  metadata whenever OCI supplies it. Require strict matching. Normalize any
  remote kubeconfig to one loopback server with inline certificates and reject
  exec, auth-provider, token, proxy, and external-file directives before
  `kubectl` contacts the API.
- Oracle Cloud Agent 1.61 can return successful `TEXT` output with an empty
  `text-sha256`. Keep host-key attestation fail closed by having the target emit
  the target and Bastion keys plus their SHA-256 values, requiring the exact
  four-line payload, and verifying both checksums plus any OCI response
  checksum that is present.
- OCI Run Command can remain `ACCEPTED` for more than three minutes on a healthy
  agent before executing. Poll for the existing bounded five-minute window and
  distinguish acceptance latency from terminal command failure; do not retry a
  production workflow merely because a shorter client poll expired.
- Validate normalized OCI host keys through `ssh-keygen` standard input, matching
  the retained SSH public-key validation path. A runner-specific temporary-file
  parse can reject a key whose checksummed bytes match independently attested
  evidence.
- k3s `ctr images export` does not consume a post-output `--` as a generic
  option terminator; it tries to export an image literally named `--`. Pass the
  validated, shell-escaped immutable reference directly and lock the exact
  remote argv in the recovery contract.
- A successful SSH exit does not prove a complete `ctr` stdout archive. The
  live stdout path truncated 77,824 bytes while a node-staged export was valid.
  Validate the staged tar remotely, stream it with keepalives, compare exact
  remote/local size and SHA-256, and remove the temporary file before upload.
- GHCR starts blob uploads at `/blobs/uploads/` but returns the session under
  singular `/blobs/upload/<id>`. The identifier is opaque and is not guaranteed
  to have RFC UUID shape. Accept one bounded URL-unreserved segment on either
  exact repository-bound path while still rejecting other hosts, paths,
  credentials, fragments, ports, and preselected digests.
- Recovery smoke tests must validate capabilities the historical target
  actually had. Keep current authorization checks strict by default, but scope
  an explicit compatibility switch to historical recovery validation when a
  later UI capability is independently covered by current service/client tests.
- GitHub Actions step-scoped OCI credentials do not persist into later steps.
  Every OCI CLI step must map the reviewed user, tenancy, fingerprint,
  private-key content, and region explicitly; otherwise a noninteractive run
  may report only `Abort:`. Lock the complete credential mapping in a workflow
  contract rather than relying on an earlier authenticated step.
- Capture rollback evidence before any database lock or workload/data
  mutation. A zero-recovery baseline is valid only when all nine live
  references and exact deploy provenance are public GHCR digests; otherwise
  require the exact completed recovery run and its transition evidence.
- GitHub currently documents public Container Registry package storage and
  bandwidth as free, but this is policy rather than permanent capacity.
  Monitor the documented one-month policy-change notice and never weaken
  immutable rollback gates to avoid a future pricing change.

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
- A deployment-job failure and a later public-validation failure have different
  maintenance state. Resume the former only from a proven retained hold; when
  deployment and cleanup succeeded but `public-validate` failed, prove those
  exact job outcomes and running images, then reacquire the lock and enter
  maintenance from the released healthy runtime so any pre-handoff failure can
  restore the captured replica state.
- A successful resume handoff can itself become the prerequisite for another
  failed-deployment recovery. Its protected rollback baseline remains bound to
  the original applied-data run, not the newer prerequisite run. Validate the
  checksum-covered prior resume authority, preserve its original run and source
  through each hop, and compare the baseline capture against that root
  authority rather than rejecting a valid chain.
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
  age and an empty job list are not enough. The bounded classifier requires an
  old first-attempt manual dispatch for a non-current ancestor SHA, no jobs or
  approvals, and exact successful successor work. Capacity needs one exact
  later success; live data needs the complete later dry-run, backfill, and
  slip-index chain; activation needs one exact later activation. Data and
  activation additionally require their historical workflow revision to use
  the protected environment, shared control-plane concurrency, and a
  current-master check before mutation. Never extend this to deployment,
  disable, rollback, infrastructure, package, cache-recovery, or build work,
  and never treat an ignored artifact as approval or recovery authority.
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

## Live betting terminal release — 2026-08-30

Live betting is permanently active on source
`0bf1d01981e454cd6ca661d8e6d99997462c558c`. The release preserved the normal
feature-to-`dev`-to-`master` path and immutable rollback authority.

### Exact release chain

- production build `33307059664`;
- OCI/GHCR build `33307558371`;
- public GHCR validation `33308076137`;
- bounded capacity acquisition `33308191145`;
- infrastructure finalization `33308306279`;
- data dry-run `33308673229`;
- idempotent backfill `33309055711`;
- final Slip index and deployment handoff `33309897271`;
- dark deployment and public validation `33310369637`;
- committed activation `33311534616`.

Failed index dispatch `33309600827` remains immutable. It failed before lock
acquisition or mutation because detailed edits to PRs #425–#429 triggered
`pull_request.edited` CI and the production-exclusivity guard correctly found
run `33309358639`. Jobless activation dispatch `33310925721` has zero jobs and
zero approvals and is not activation authority. The materialized replacement
was captured before workflow disable and completed once.

### Acceptance and runtime evidence

- in this historical release, two enabled countdown products were available
  before kickoff and all seven market cards were retained after kickoff; the
  later compact presentation intentionally hides terminal countdown cards and
  shows only the five active in-play cards;
- independent live and pre-match slips, quote/revision handling, live
  incidents, half-time/stoppage/full-time transitions, immediate live
  settlement, and pre-match settlement all passed;
- the reusable protected account was returned to `USER`, its stale privileged
  session was rejected, and zero active synthetic slips remained;
- page errors, console errors, API failures, queue residue, retry/dead-letter
  residue, and pod restart deltas were all zero;
- final readiness reported shared-Mongo topology valid, the retained PVC
  `Bound`, four live queue consumers, REST/SSE/legacy API success, and
  `LIVE_KICKOFFS_ENABLED=true`;
- the final control state is `committed` with no activation lease.

Protected rollback remains source
`3ce5ddcc031081f1658e91fa658000aa9a9f9ab4`, OCI build `33249834065`, and
deployment `33252255145` only while all required immutable artifacts remain
retained. The earliest current required artifact expires at
`2026-09-28T11:28:54Z`, but the build run reaches the workflow's 30-day age
limit earlier at `2026-09-28T11:18:50Z`. Rotate or recertify rollback authority
before the earlier cutoff or when a newer accepted release supersedes it.

### Process outcome

Activation is not the end of a long task when durable learning was requested.
The conductor must register a terminal documentation unit covering Markdown,
wiki, reusable-agent guidance, PR/release evidence, and todo reconciliation.
It may report orchestration complete only after that handoff is persisted and
validated.

## Compact live activation acceptance regression — 2026-08-31

- Dark deployment `33418318240` successfully placed exact master
  `e7ca18a52696b50d27c5d7a18ed00eeeeaa18423` in production.
- Activation `33419673381` failed because its browser assertion still expected
  seven visible cards after kickoff. The intended compact UI showed
  five active in-play cards and hid the two terminal countdown cards.
- The authoritative snapshot still carries all seven markets for transition,
  audit, and settlement logic. Production acceptance must distinguish that
  domain inventory from the filtered visible-card contract.
- Failure cleanup returned production to dark mode, disabled new kickoffs,
  removed the exact synthetic active Slip, restored the reusable test account
  to `USER`, and left no activation lease. Later browser, queue, restart, and
  permanent-commit gates were not evaluated. Preserve the failed first attempt
  and promote the corrected assertion through a new exact-SHA release chain.
- A UX change that alters terminal-state visibility is incomplete until the
  browser acceptance journey, static workflow contract, reusable UX guidance,
  and production documentation agree with the rendered behavior.
- Scheduler `$setOnInsert` convergence deliberately preserves existing event
  products, so a pricing-generator correction does not repair the current
  24-hour pool. When persisted boards remain user-visible, extend the existing
  event compatibility backfill instead of adding read-path filtering, deleting
  slots, or changing explicit visibility provenance.
- Pre-match clicks, Slip/Bet rows, moderation, and resulting use immutable row
  snapshots after selection. A bounded event-product repricing can therefore
  leave existing drafts and bets untouched. Preserve a Correct Score odds ID
  only when its label still represents the same selection; removed labels get
  deterministic new identities so the UI cannot highlight an old `8 - 10`
  selection as a new plausible score.
- If a legacy board contains duplicate labels under different IDs, retain one
  deterministic canonical ID. A draft using a displaced duplicate remains
  visible, placeable, and settleable from its own snapshot but is deliberately
  not highlighted on the repaired board; this avoids silently substituting a
  different stored ID.
- Data repairs used by release acceptance must be deterministic and
  self-terminating: derive prices from the stable event ID, repair both 1X2 and
  Correct Score from one distribution, preserve product and embedded Mongo
  identities, map 1X2 prices by validated home/draw/away labels rather than
  array position, and require dry-run/apply/verify to converge to zero matches.
- A migration predicate is not a write guard. Bind each numeric array-path
  update to the exact scanned event, terminal markers, live state, and product
  arrays so a concurrent result or reorder becomes a safe mismatch instead of
  overwriting newer authority.

## Corrected compact live release — 2026-08-31

- Exact master `f4a0b333963b3a458c9b2b48c2aae1f6267f754d` completed a new
  first-attempt release chain: production build `33436391225`, OCI build
  `33437490565`, GHCR validation `33438579478`, capacity `33438984944`,
  infrastructure `33439362885`, data dry-run `33440517994`, backfill
  `33441373219`, Slip-index handoff `33442790087`, dark deployment
  `33443908124`, and activation `33444998653`.
- The Event backfill changed seven eligible legacy boards and verification
  found zero remaining matches. Existing Slip and Bet snapshots were not
  rewritten.
- Permanent activation passed the complete ten-minute browser journey and
  finished two matches `1-2` and `2-1`. Live and pre-match slips remained
  separate; quote refresh, stale-quote handling, moderation, settlement,
  history, SSE, cleanup, queues, and restarts passed. Final state is committed
  with live kickoffs enabled and no lease.
- Terminal production validation bound all nine deployments to immutable
  digests, verified eight logical databases on the retained 50 GiB Mongo PVC,
  zero RabbitMQ backlog, public REST/SSE health, 90 plausible Correct Score
  options, 44 deployed-client regressions, and 24 real-data responsive checks
  through the 320px boundary.
- A failed first attempt is evidence, not a retry candidate. The corrected
  acceptance assertion and persisted-board repair required a new exact master
  SHA and complete release chain.
- A pinned external CLI install can still make a one-use release gate fragile
  when the package host times out. Bound the complete install command with a
  hard per-attempt deadline, finite retries/backoff, and an explicit package
  transport timeout; test transient success, permanent failure, timeout, and
  final version identity. If that bootstrap fails before production access or
  mutation, preserve the consumed authority as terminal evidence and promote a
  substantive hardened SHA instead of replaying the request or changing the
  authority root.

## CLI-originated protected authority — 2026-08-31

- Protected approval is classified by origin, not workflow class. A direct
  Copilot CLI operation must be created by the bounded dispatcher and bound to
  its exact returned run ID. Human `gh workflow run` and scheduled runs receive
  no record and remain personally gated.
- Keep one shared policy for all 15 protected workflows. Bind exact workflow
  ID/path/blob, event, environment, title, first attempt, current control SHA,
  separate subject or historical target, and every workflow input. Keep
  booleans typed in the private request and record, normalize them to lowercase
  strings for `gh workflow run --json`, and hash the exact transport bytes.
- A dispatch URL proves event acceptance, not materialization. Persist a
  `dispatching` intent and mode-`0600` output capture before the external
  mutation, bind the exact captured URL to a `claimed` record, and issue it
  only when that exact run appears. Use `--resume-captured` after a pre-bind
  crash and `--resume-run` after delayed materialization. Never infer identity
  from title or timing, and never redispatch a URL-less unresolved intent.
- Treat unresolved authority as repository-global, not request-local. Any
  `dispatching`/`bound` intent or `claimed`/`inflight` record blocks every
  protected request for that repository even after control SHA advances.
  Promotion cannot silently clear the fence. `issued` and `consumed` remain
  one-use for the same operation and exact transport input hash; changed
  inputs form a new request but do not bypass policy, lineage, recovery, or
  exclusivity. `retired` is the only inert replacement exception.
- Persisting an intent is not the last dispatch check. Revalidate current
  master, workflow blob, and active state after creating it, and cancel only a
  pristine untouched intent if authority drifted before the GitHub call.
- Approval needs a two-phase local state change. Claim the exact
  run/environment/waiting-job-set fingerprint as `inflight` before the GitHub
  POST, then append a consumed receipt only after acceptance. An ambiguous
  response stays inflight and cannot be replayed automatically. Reconciliation
  first binds to the exact downstream run and operation, then compares GitHub
  review history with the reviewer/comment/environment baseline captured
  before the POST. A new exact approved review permits a consumed receipt; no
  new review plus the same active gate permits retry. Every other shape remains
  unresolved and inflight. Gate disappearance, terminal status, and
  temporarily missing pending evidence are not approval.
- Workflow lifecycle is policy data. Capacity, infrastructure, activation,
  live-data, migration-recovery, and production-deploy workflows must be
  `disabled_manually` at approval; all other protected workflows must be
  `active`. Revalidate that state, the workflow blob, current master, and
  promotion authority after the local claim. On drift, release the exact claim
  to its previous state and never send the POST.
- One dispatch can legitimately encounter multiple sequential protected jobs.
  Preserve the consumed record and allow a new waiting-job-set fingerprint on
  the same exact run even when it reuses the same environment ID, or a policy-
  declared automatic descendant. Never reuse the same gate fingerprint.
- Promotion-derived build approvals need the same durable automatic records
  and receipt lifecycle as directly dispatched runs. A captured terminal run
  is safe to mark `retired` only with zero jobs and zero pending deployments;
  that proof, not age or a generic conclusion, permits a replacement dispatch.
- A claimed accepted-but-unmaterialized run is not a terminal claim. Keep its
  affected workflow disabled while its generic-title ghost SHA is current,
  and never grant it human or CLI environment approval. Promote the
  current-master safety guard first; never reset master to the poisoned SHA.
  After that SHA is a strict ancestor, only
  `retire-unmaterialized-claim` may migrate the exact v1 claim to a retired
  record, with optimistic version locking and a digest of complete run,
  jobs, pending-deployment, artifact, compare, and historical-workflow
  evidence. The path is restricted to data rollout, live activation, and
  capacity acquisition; it requires queued/null first-attempt manual identity,
  equal untouched timestamps, zero exact count/list jobs and artifacts,
  zero pending deployments, a generic workflow-name title that cannot match
  a legitimate rendered title, and a one-job historical protected workflow
  whose `oci-control-plane` non-cancelling guards precede every mutation.
  Then rebuild the complete exact-SHA chain; retirement never authorizes an
  automatic redispatch or approval. A cancellation `409` is journal
  corroboration only, never classifier or retirement evidence.
- A current-master ghost can block the guard promotion that would make it
  safely historical. The merge-safety path may pass only its exact promotion
  PR number; exclusivity must independently prove an OPEN CLI-managed
  same-repository `dev` -> `master` PR, exact current-master base, and strict
  prospective-head ancestry. Use that prospective SHA only for the
  allowlisted queued unmaterialized ghost, never for normal dispatch,
  approval, another active run, or the repository-global claimed/inflight
  authority fence. `EXCLUDE_RUN_ID` and generic disabled handling cannot
  supply prospective-bootstrap evidence.
- GitHub compare responses do not expose `head_commit`. Bind a complete
  ordered compare list to its requested head by requiring its final unique
  full-SHA commit to equal that head; containment alone is insufficient.
- Raw paginated Compare responses can exceed the private evidence-size bound
  because they carry commit/file/patch detail. Fetch every page with a
  SHA-only projection, require identical typed metadata, normalize the full
  aggregate, and retain no raw pages. A partial 250-entry list is never
  ancestry proof.
- The live-data workflow blob
  `c6c113b49a36518b7b106aa1406998a4abca10a0` predates only the `hold` and
  exact acceptance-slip cleanup mutation tokens. Its cryptographically
  verified blob identity selects that reviewed reduced profile; every other
  historical source requires the full current token profile.
- Keep workflow-specific supersession successor chains: capacity needs one
  later exact success; live data needs later dry-run, backfill, and slip-index
  successes; activation needs a later exact activation success. A recovered
  ghost is not completion—reconcile the entire nonterminal run inventory
  until no unexplained blocker remains. Reject removing live-data or activation
  supersession as a substitute for their successor chains.
- A critical path blocked by a repository-introduced rule, policy, or guard is
  not automatically an external safety wait. The conductor must prove the
  exact self-imposed cause and the intended invariant; if real production
  risk, provenance, approval, health, rollback, or authority evidence remains
  unresolved, keep the block. Otherwise it owns one focused correction through
  branch -> `dev` -> `master`, with a reproducing test. It requires an
  independent deployment-safety challenge, rollback preservation, and
  post-promotion exact-SHA revalidation before automatic resumption of the
  exact original job.
  Never weaken a gate to make progress or edit live authority state ad hoc.
- Expired `claimed` and `inflight` records stay inspectable so exact recovery
  remains possible. Issuing an active claimed run or restoring retry authority
  for the same active gate renews the bounded window; reconciled consumption,
  issued records, and consumed records otherwise remain expiry-bound.
- Current `controlSha` is always current master safety code. `subjectSha` may
  identify the deployed release and `targetSha` may identify a historical
  ancestor for rollback or recovery; an old target never authorizes stale
  control code.
- Active-run exclusivity data is usable only when the response is a complete
  object with a nonnegative integer `total_count`, a `workflow_runs` array,
  exact count/list agreement, and no more than the requested 100 results.
  Missing or malformed completeness evidence fails closed.
- The shared GitHub user cannot cryptographically distinguish a human `gh`
  command from Copilot CLI. Owner-only outside-repository records are an
  operational ownership boundary, so never create, copy, or retrofit one for
  a human-originated run.
- The conductor must treat an issued record plus a pending exact environment
  as an immediate automatic-approval handoff. A surviving intent with a
  captured URL invokes `--resume-captured`, a delayed claimed record invokes
  exact-run resume, an inert terminal claim invokes retirement, and an
  inflight record invokes explicit reconciliation. None should wait for a
  routine polling interval or cause a replacement dispatch.
- A top-level GitHub `waiting` status is not progress to observe. Inspect the
  exact jobs and `pending_deployments` immediately; when durable authority
  proves a CLI-owned automatic gate, run the checked-in approval path before
  retaining a watcher. A watcher transports notifications but never owns the
  pending mutation, and human-originated work remains personally gated.
