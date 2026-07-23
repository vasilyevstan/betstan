# Betstan — Session Learnings

## Repository overview

`betstan` is a microservices betting platform. Each service lives in its own top-level directory (`auth`, `backoffice`, `bet`, `event`, `gamemaster`, `moderation`, `resulting`, `slip`). Shared types, base classes, and utilities are published as the `@betstan/common` npm package (hosted on npmjs.org, currently `1.0.54`). The `common/` directory in the repo is a git submodule.

---

## Architecture patterns

### Messaging (AMQP / RabbitMQ)
- Every service communicates through RabbitMQ exchanges.
- Base classes live in `@betstan/common`: `AListener<T>` (consumers) and `APublisher<T>` (producers).
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

---

## Testing conventions

### Setup file (`src/test/setup.ts`)
All three services that have tests (`resulting`, `moderation`, `gamemaster`) share the same setup pattern:
- `jest.mock("@betstan/common")` — **auto-mocks the entire common module** (including `AListener` and `APublisher`).
- `beforeAll` — starts an in-memory MongoDB instance.
- `beforeEach` — calls `jest.clearAllMocks()` (resets call counts but keeps spy implementations) and wipes all MongoDB collections.
- `afterAll` — stops the in-memory Mongo.

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
cd resulting && npm install && npm run test:ci
```

CI runs three separate workflows (`.github/workflows/tests-resulting.yaml`, `tests-moderation.yaml`, `tests-gamemaster.yaml`), each executing `npm install && npm run test:ci` in the corresponding service directory.

---

## Known issues & workarounds

- Backend services run in production via `ts-node-dev` (`npm start`). The `start` scripts use `--transpile-only` so the TypeScript type-checker does **not** run at runtime. This cuts each service's memory from ~384 MB to ~205 MB, which helps fit the workload onto the single cost-optimized AKS node (~4 GB). Without it the node over-commits and pods OOM/CrashLoop. Type-checking still runs in CI via `jest`/`ts-jest` and `npx tsc --noEmit`.
- **Database topology (rolled back):** MongoDB was briefly consolidated into a single shared `gaming-mongo` instance (one StatefulSet, one DB per service on separate logical databases) to save memory. Because the application remained down, this was rolled back to the previous known-good topology of **one MongoDB StatefulSet per service** (`gaming-<svc>-mongo-depl` / `gaming-<svc>-mongo-srv`, 1Gi PVC each), with each service pointing at its own `mongodb://gaming-<svc>-mongo-srv:27017/gaming_<svc>`. Note the tradeoff: running 8 separate MongoDB pods increases baseline memory usage versus a single shared instance, so watch node memory/OOM after this change. `kubectl apply` does not prune deleted resources, so both the deploy workflow (`.github/workflows/deploy-manifests.yml`) and `infra/azure/agents/deploy-stan.sh` explicitly `kubectl delete` the obsolete shared `gaming-mongo-depl` StatefulSet, `gaming-mongo-srv` Service, and its `gaming-mongo-data-gaming-mongo-depl-0` PVC.
- The `common/` git submodule has no registered URL in `.gitmodules`. CI emits a warning (`fatal: No url found for submodule path 'common'`) but this does not affect the build.
- GitHub Actions workflows still use `actions/checkout@v2` (Node 20), which triggers a deprecation warning on current runners. Upgrading to `@v4` would silence it.
