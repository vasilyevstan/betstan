import request from "supertest";
import { createApp, telemetryErrorHandler } from "../app";
import { METRICS, SERVICES } from "../domain/metrics";

const now = new Date("2026-09-10T12:34:56.789Z");
const uuid = "9a6b8a5f-d9ea-4f4c-8c0a-7d39b9a55c12";
const health = SERVICES.map((service) => ({ service, status: "green" as const }));

const dependencies = () => ({
  clock: { now: jest.fn(() => now) },
  health: { check: jest.fn().mockResolvedValue(health) } as any,
  hourlyStore: { aggregateHourly: jest.fn().mockResolvedValue([]) },
  processClock: { nowMs: jest.fn(() => 0) },
  recorder: { record: jest.fn().mockResolvedValue(undefined) },
  summaryStore: { aggregate: jest.fn().mockResolvedValue([]) },
  uuid: jest.fn(() => uuid),
});

const expectRateLimited = (response: request.Response) => {
  expect(response.status).toBe(429);
  expect(response.body).toEqual({ error: "Too many requests" });
  expect(response.headers["retry-after"]).toBe("1");
};

describe("POST /api/telemetry/page-view", () => {
  it.each([
    ["main", "MAIN_PAGE_VISIT"],
    ["admin", "ADMIN_PAGE_VISIT"],
  ])("records %s directly and returns exact 202", async (page, metric) => {
    const deps = dependencies();
    const response = await request(createApp(deps))
      .post("/api/telemetry/page-view")
      .send({ page })
      .expect(202);

    expect(response.body).toEqual({ accepted: true });
    expect(deps.recorder.record).toHaveBeenCalledWith({
      _id: uuid,
      metric,
      occurredAt: now,
    });
    expect(deps.clock.now).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, "empty"],
    [{ page: "other" }, "unknown"],
    [{ page: "main", timestamp: now.toISOString() }, "extra"],
    [[], "array"],
    [null, "null"],
  ])("rejects invalid body with sanitized 400", async (body, _description) => {
    const deps = dependencies();
    const response = await request(createApp(deps))
      .post("/api/telemetry/page-view")
      .send(body as any)
      .expect(400);
    expect(response.body).toEqual({ error: "Invalid request" });
    expect(deps.recorder.record).not.toHaveBeenCalled();
  });

  it("requires application/json and returns sanitized 503 after write failure", async () => {
    await request(createApp(dependencies()))
      .post("/api/telemetry/page-view")
      .type("text")
      .send('{"page":"main"}')
      .expect(400);

    const deps = dependencies();
    deps.recorder.record.mockRejectedValueOnce(new Error("private write"));
    const response = await request(createApp(deps))
      .post("/api/telemetry/page-view")
      .send({ page: "main" })
      .expect(503);
    expect(response.body).toEqual({
      error: "Telemetry temporarily unavailable",
    });
  });

  it("returns sanitized 400 for malformed JSON", async () => {
    const response = await request(createApp(dependencies()))
      .post("/api/telemetry/page-view")
      .set("Content-Type", "application/json")
      .send('{"page":')
      .expect(400);

    expect(response.body).toEqual({ error: "Invalid request" });
  });

  it.each([
    {
      name: "unsupported charset",
      headers: { "Content-Type": "application/json; charset=iso-8859-1" },
      body: '{"page":"main"}',
    },
    {
      name: "unsupported encoding",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "compress",
      },
      body: '{"page":"main"}',
    },
    {
      name: "oversized JSON",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: "main", padding: "x".repeat(101 * 1024) }),
    },
    {
      name: "primitive JSON",
      headers: { "Content-Type": "application/json" },
      body: "true",
    },
  ])("returns sanitized 400 for $name without recording", async ({ headers, body }) => {
    const deps = dependencies();
    const unexpected = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const operation = request(createApp(deps)).post(
      "/api/telemetry/page-view"
    );
    for (const [name, value] of Object.entries(headers)) {
      operation.set(name, value);
    }

    const response = await operation.send(body).expect(400);

    expect(response.body).toEqual({ error: "Invalid request" });
    expect(deps.recorder.record).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalledWith(
      "telemetry_http_unexpected_error"
    );
  });

  it("allows a burst of 20, then returns the fixed 429 without affecting GET", async () => {
    const deps = dependencies();
    const app = createApp(deps);

    for (let index = 0; index < 20; index += 1) {
      await request(app)
        .post("/api/telemetry/page-view")
        .send({ page: "main" })
        .expect(202);
    }
    const limited = await request(app)
      .post("/api/telemetry/page-view")
      .send({ page: "main" });

    expectRateLimited(limited);
    expect(deps.recorder.record).toHaveBeenCalledTimes(20);
    await request(app).get("/api/telemetry/summary").expect(200);
  });

  it("refills continuously and accepts exactly at the one-token boundary", async () => {
    let processNow = 0;
    const deps = dependencies();
    deps.processClock.nowMs.mockImplementation(() => processNow);
    const app = createApp(deps);

    for (let index = 0; index < 20; index += 1) {
      await request(app)
        .post("/api/telemetry/page-view")
        .send({ page: "main" })
        .expect(202);
    }
    processNow = 999;
    expectRateLimited(
      await request(app)
        .post("/api/telemetry/page-view")
        .send({ page: "main" })
    );
    processNow = 1000;
    await request(app)
      .post("/api/telemetry/page-view")
      .send({ page: "main" })
      .expect(202);
    expect(deps.recorder.record).toHaveBeenCalledTimes(21);
  });

  it("rejects malformed and oversized bodies before parsing or recording", async () => {
    const deps = dependencies();
    const app = createApp(deps);
    for (let index = 0; index < 20; index += 1) {
      await request(app)
        .post("/api/telemetry/page-view")
        .send({ page: "admin" })
        .expect(202);
    }

    const malformed = await request(app)
      .post("/api/telemetry/page-view")
      .set("Content-Type", "application/json")
      .send('{"page":');
    const oversized = await request(app)
      .post("/api/telemetry/page-view")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ page: "main", padding: "x".repeat(101 * 1024) }));

    expectRateLimited(malformed);
    expectRateLimited(oversized);
    expect(deps.recorder.record).toHaveBeenCalledTimes(20);
  });
});

it("returns sanitized 500 and fixed diagnostics for unexpected middleware errors", () => {
  const send = jest.fn();
  const status = jest.fn().mockReturnValue({ send });
  const error = jest.spyOn(console, "error").mockImplementation(() => {});

  telemetryErrorHandler(
    new Error("private payload-bearing failure"),
    {} as any,
    { status } as any,
    jest.fn()
  );

  expect(status).toHaveBeenCalledWith(500);
  expect(send).toHaveBeenCalledWith({ error: "Internal server error" });
  expect(error).toHaveBeenCalledWith("telemetry_http_unexpected_error");
  expect(JSON.stringify(error.mock.calls)).not.toContain(
    "private payload-bearing failure"
  );
});

describe("GET /api/telemetry/summary", () => {
  it("returns only the exact ordered zero-filled shape", async () => {
    const deps = dependencies();
    const response = await request(createApp(deps))
      .get("/api/telemetry/summary")
      .expect(200);

    expect(Object.keys(response.body)).toEqual([
      "generatedAt",
      "dates",
      "metrics",
      "health",
    ]);
    expect(response.body.generatedAt).toBe(now.toISOString());
    expect(response.body.dates).toHaveLength(14);
    expect(response.body.metrics.map(({ metric }: { metric: string }) => metric)).toEqual(
      METRICS
    );
    expect(response.body.metrics.every(({ values }: { values: number[] }) =>
      values.length === 14 && values.every((value) => value === 0)
    )).toBe(true);
    expect(response.body.health).toEqual(health);
    expect(deps.clock.now).toHaveBeenCalledTimes(1);
  });

  it("rejects query parameters and returns 503 on query failure", async () => {
    await request(createApp(dependencies()))
      .get("/api/telemetry/summary?window=7")
      .expect(400);

    const deps = dependencies();
    deps.summaryStore.aggregate.mockRejectedValueOnce(new Error("private query"));
    const response = await request(createApp(deps))
      .get("/api/telemetry/summary")
      .expect(503);
    expect(response.body).toEqual({
      error: "Telemetry temporarily unavailable",
    });
  });

  it("allows a burst of 10, then returns the fixed 429 without affecting POST", async () => {
    const deps = dependencies();
    const app = createApp(deps);

    for (let index = 0; index < 10; index += 1) {
      await request(app).get("/api/telemetry/summary").expect(200);
    }
    const limited = await request(app).get("/api/telemetry/summary");

    expectRateLimited(limited);
    expect(deps.summaryStore.aggregate).toHaveBeenCalledTimes(1);
    expect(deps.health.check).toHaveBeenCalledTimes(1);
    await request(app)
      .post("/api/telemetry/page-view")
      .send({ page: "main" })
      .expect(202);
  });

  it("does not aggregate or probe when the GET limiter rejects", async () => {
    const deps = dependencies();
    const app = createApp(deps);
    for (let index = 0; index < 10; index += 1) {
      await request(app)
        .get(`/api/telemetry/summary?rejected=${index}`)
        .expect(400);
    }

    expectRateLimited(await request(app).get("/api/telemetry/summary"));
    expect(deps.summaryStore.aggregate).not.toHaveBeenCalled();
    expect(deps.health.check).not.toHaveBeenCalled();
  });

  it("caches the complete response for five seconds and refreshes at expiry", async () => {
    let processNow = 0;
    let generatedAt = new Date("2026-09-10T12:34:56.789Z");
    const deps = dependencies();
    deps.processClock.nowMs.mockImplementation(() => processNow);
    deps.clock.now.mockImplementation(() => generatedAt);
    const app = createApp(deps);

    const first = await request(app).get("/api/telemetry/summary").expect(200);
    processNow = 4999;
    generatedAt = new Date("2026-09-10T12:35:01.788Z");
    const cached = await request(app).get("/api/telemetry/summary").expect(200);

    expect(cached.body).toEqual(first.body);
    expect(deps.summaryStore.aggregate).toHaveBeenCalledTimes(1);
    expect(deps.health.check).toHaveBeenCalledTimes(1);
    expect(deps.clock.now).toHaveBeenCalledTimes(1);

    processNow = 5000;
    const refreshed = await request(app)
      .get("/api/telemetry/summary")
      .expect(200);
    expect(refreshed.body.generatedAt).toBe(generatedAt.toISOString());
    expect(refreshed.body.generatedAt).not.toBe(first.body.generatedAt);
    expect(deps.summaryStore.aggregate).toHaveBeenCalledTimes(2);
    expect(deps.health.check).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent misses into one coherent whole response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = dependencies();
    deps.summaryStore.aggregate.mockImplementationOnce(async () => {
      await gate;
      return [{
        _id: { metric: "BET_PLACED", date: "2026-09-10" },
        count: 4,
      }];
    });
    deps.health.check.mockImplementationOnce(async () => {
      await gate;
      return health;
    });
    const app = createApp(deps);

    const responsesPromise = Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get("/api/telemetry/summary")
      )
    );
    for (
      let attempt = 0;
      attempt < 20 && deps.summaryStore.aggregate.mock.calls.length === 0;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(deps.summaryStore.aggregate).toHaveBeenCalledTimes(1);
    expect(deps.health.check).toHaveBeenCalledTimes(1);
    release();
    const responses = await responsesPromise;

    expect(responses.every(({ status }) => status === 200)).toBe(true);
    expect(
      responses.every(({ body }) =>
        JSON.stringify(body) === JSON.stringify(responses[0].body)
      )
    ).toBe(true);
    expect(Object.keys(responses[0].body)).toEqual([
      "generatedAt",
      "dates",
      "metrics",
      "health",
    ]);
    expect(responses[0].body.metrics[3].values[13]).toBe(4);
    expect(responses[0].body.health).toEqual(health);
  });

  it.each(["aggregation", "health"])(
    "does not cache a failed %s refresh and retries the whole response",
    async (failure) => {
      const deps = dependencies();
      if (failure === "aggregation") {
        deps.summaryStore.aggregate.mockRejectedValueOnce(
          new Error("private aggregation failure")
        );
      } else {
        deps.health.check.mockRejectedValueOnce(
          new Error("private health failure")
        );
      }
      const app = createApp(deps);

      const failed = await request(app)
        .get("/api/telemetry/summary")
        .expect(503);
      expect(failed.body).toEqual({
        error: "Telemetry temporarily unavailable",
      });
      await request(app).get("/api/telemetry/summary").expect(200);

      expect(deps.summaryStore.aggregate).toHaveBeenCalledTimes(2);
      expect(deps.health.check).toHaveBeenCalledTimes(2);
    }
  );
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const waitForCalls = async (mock: jest.Mock, count: number) => {
  for (let attempt = 0; attempt < 100 && mock.mock.calls.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(mock).toHaveBeenCalledTimes(count);
};

const hourlyUrl = (metric = "BET_PLACED", date = "2026-09-10") =>
  `/api/telemetry/metrics/${metric}/days/${date}`;

describe("GET /api/telemetry/metrics/:metric/days/:date", () => {
  it.each(METRICS)("returns the exact hourly DTO for %s without health or daily reads", async (metric) => {
    const deps = dependencies();
    deps.hourlyStore.aggregateHourly.mockResolvedValue([
      { _id: 23, count: Number.MAX_SAFE_INTEGER },
      { _id: 0, count: 7 },
    ]);
    const response = await request(createApp(deps)).get(hourlyUrl(metric)).expect(200);
    expect(Object.keys(response.body)).toEqual([
      "generatedAt", "metric", "date", "hours", "values",
    ]);
    expect(response.body).toEqual({
      generatedAt: now.toISOString(),
      metric,
      date: "2026-09-10",
      hours: Array.from({ length: 24 }, (_, hour) =>
        `2026-09-10T${String(hour).padStart(2, "0")}:00:00.000Z`
      ),
      values: [7, ...Array(22).fill(0), Number.MAX_SAFE_INTEGER],
    });
    expect(deps.clock.now).toHaveBeenCalledTimes(1);
    expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledWith(
      metric, new Date("2026-09-10T00:00:00.000Z"),
      new Date("2026-09-11T00:00:00.000Z")
    );
    expect(deps.health.check).not.toHaveBeenCalled();
    expect(deps.summaryStore.aggregate).not.toHaveBeenCalled();
    expect(deps.recorder.record).not.toHaveBeenCalled();
  });

  it.each([
    hourlyUrl("UNKNOWN"),
    hourlyUrl("bet_placed"),
    hourlyUrl("__proto__"),
    hourlyUrl("BET_PLACED", "2026-08-27"),
    hourlyUrl("BET_PLACED", "2026-09-11"),
    hourlyUrl("BET_PLACED", "2026-09-31"),
    hourlyUrl("BET_PLACED", "2026-02-29"),
    hourlyUrl("BET_PLACED", "2026-00-10"),
    hourlyUrl("BET_PLACED", "2026-9-10"),
    hourlyUrl("BET_PLACED", "2026-09-10T00:00:00.000Z"),
    hourlyUrl("BET_PLACED", "2026-09-10%0A"),
    `${hourlyUrl()}?window=1`,
    `${hourlyUrl()}?unused=`,
    `${hourlyUrl()}?date=2026-09-10&date=2026-09-09`,
    `${hourlyUrl()}?filter[metric]=BET_PLACED`,
    `${hourlyUrl()}?__proto__[ignored]=1`,
    hourlyUrl("%E0%A4%A"),
    hourlyUrl("BET_PLACED", "%E0%A4%A"),
  ])("rejects invalid path/query %s without computing", async (url) => {
    const deps = dependencies();
    const response = await request(createApp(deps)).get(url).expect(400);
    expect(response.body).toEqual({ error: "Invalid request" });
    expect(deps.hourlyStore.aggregateHourly).not.toHaveBeenCalled();
    expect(deps.health.check).not.toHaveBeenCalled();
    expect(deps.summaryStore.aggregate).not.toHaveBeenCalled();
  });

  it("accepts the oldest day and today using domain clock, not elapsed-time clock", async () => {
    const deps = dependencies();
    deps.processClock.nowMs.mockReturnValue(Date.parse("2040-01-01T00:00:00Z"));
    const app = createApp(deps);
    for (const date of ["2026-08-28", "2026-09-10"]) {
      const response = await request(app).get(hourlyUrl("BET_PLACED", date)).expect(200);
      expect(response.body.date).toBe(date);
      expect(response.body.values).toEqual(Array(24).fill(0));
    }
    expect(deps.clock.now).toHaveBeenCalledTimes(2);
  });

  it("validates before joining at midnight and rejects unsupported queries even in flight", async () => {
    const deps = dependencies();
    const gate = deferred<never[]>();
    deps.hourlyStore.aggregateHourly.mockReturnValue(gate.promise);
    const app = createApp(deps);
    const url = hourlyUrl("BET_PLACED", "2026-08-28");
    const first = request(app).get(url).then((response) => response);
    try {
      await waitForCalls(deps.hourlyStore.aggregateHourly, 1);
      await request(app).get(`${url}?unexpected=1`).expect(400);
      deps.clock.now.mockReturnValue(new Date("2026-09-11T00:00:00.000Z"));
      const expired = await request(app).get(url).expect(400);
      expect(expired.body).toEqual({ error: "Invalid request" });
      expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve([]);
      const original = await first;
      expect(original.status).toBe(200);
      expect(original.body.generatedAt).toBe(now.toISOString());
    }
  });

  it("admits 16, refills at 2/second, caps refill, and does not cache completed results", async () => {
    let elapsed = 0;
    const deps = dependencies();
    deps.processClock.nowMs.mockImplementation(() => elapsed);
    const app = createApp(deps);
    for (let index = 0; index < 16; index += 1) {
      await request(app).get(hourlyUrl()).expect(200);
    }
    expectRateLimited(await request(app).get(hourlyUrl()));
    elapsed = 499;
    expectRateLimited(await request(app).get(hourlyUrl()));
    elapsed = 500;
    await request(app).get(hourlyUrl()).expect(200);
    expectRateLimited(await request(app).get(hourlyUrl()));
    elapsed = 100000;
    for (let index = 0; index < 16; index += 1) {
      await request(app).get(hourlyUrl()).expect(200);
    }
    expectRateLimited(await request(app).get(hourlyUrl()));
    expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledTimes(33);
    expect(deps.clock.now).toHaveBeenCalledTimes(33);
    // Daily retains its separate 10-token budget and complete five-second cache.
    for (let index = 0; index < 10; index += 1) {
      await request(app).get("/api/telemetry/summary").expect(200);
    }
    expectRateLimited(await request(app).get("/api/telemetry/summary"));
    expect(deps.summaryStore.aggregate).toHaveBeenCalledTimes(1);
    expect(deps.health.check).toHaveBeenCalledTimes(1);
  });

  it("consumes hourly tokens before application validation without spending daily tokens", async () => {
    const deps = dependencies();
    const app = createApp(deps);
    for (let index = 0; index < 16; index += 1) {
      await request(app).get(hourlyUrl("UNKNOWN")).expect(400);
    }
    expectRateLimited(await request(app).get(hourlyUrl("UNKNOWN")));
    expectRateLimited(await request(app).get(hourlyUrl()));
    expect(deps.clock.now).toHaveBeenCalledTimes(16);
    expect(deps.hourlyStore.aggregateHourly).not.toHaveBeenCalled();
    await request(app).get("/api/telemetry/summary").expect(200);
  });

  it("preserves daily refill at 2/second and keeps hourly admission independent", async () => {
    const deps = dependencies();
    const app = createApp(deps);
    for (let index = 0; index < 10; index += 1) {
      await request(app).get("/api/telemetry/summary").expect(200);
    }
    deps.processClock.nowMs.mockReturnValue(499);
    expectRateLimited(await request(app).get("/api/telemetry/summary"));
    await request(app).get(hourlyUrl()).expect(200);
    deps.processClock.nowMs.mockReturnValue(500);
    await request(app).get("/api/telemetry/summary").expect(200);
    expectRateLimited(await request(app).get("/api/telemetry/summary"));
    expect(deps.summaryStore.aggregate).toHaveBeenCalledTimes(1);
    expect(deps.health.check).toHaveBeenCalledTimes(1);
    expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledTimes(1);
  });

  it("bounds eight distinct computations, joins before saturation, and frees settled keys without caching", async () => {
    const deps = dependencies();
    const gates = METRICS.map(() => deferred<never[]>());
    deps.hourlyStore.aggregateHourly.mockImplementation(
      (metric) => gates[METRICS.indexOf(metric)].promise
    );
    const app = createApp(deps);
    const pending = METRICS.map((metric) =>
      request(app).get(hourlyUrl(metric)).then((response) => response)
    );
    let joined: Promise<request.Response> | undefined;
    try {
      await waitForCalls(deps.hourlyStore.aggregateHourly, 8);
      expectRateLimited(await request(app).get(hourlyUrl(METRICS[0], "2026-09-09")));
      deps.clock.now.mockReturnValue(new Date("2026-09-10T12:35:00.000Z"));
      joined = request(app).get(hourlyUrl(METRICS[0])).then((response) => response);
      await waitForCalls(deps.clock.now, 10);
      expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledTimes(8);
      gates[0].resolve([]);
      const [original, duplicate] = await Promise.all([pending[0], joined]);
      expect(original.status).toBe(200);
      expect(duplicate.body).toEqual(original.body);
      expect(duplicate.body.generatedAt).toBe(now.toISOString());
      // Seven original keys remain active; a newly freed key starts real work.
      await request(app).get(hourlyUrl(METRICS[0], "2026-09-09")).expect(200);
      await request(app).get(hourlyUrl(METRICS[0])).expect(200);
      expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledTimes(10);
      expect(deps.health.check).not.toHaveBeenCalled();
    } finally {
      gates.forEach((gate) => gate.resolve([]));
      await Promise.all([...pending, ...(joined ? [joined] : [])]);
    }
  });

  it.each(["synchronous throw", "rejection", "timeout", "invalid buckets"])(
    "sanitizes %s and releases the actual settled promise for retry",
    async (failure) => {
      const deps = dependencies();
      const aggregate = deps.hourlyStore.aggregateHourly;
      if (failure === "synchronous throw") {
        aggregate.mockImplementationOnce(() => { throw new Error("private sync"); });
      } else if (failure === "invalid buckets") {
        aggregate.mockResolvedValueOnce([{ _id: 0, count: Number.MAX_SAFE_INTEGER + 1 }]);
      } else {
        aggregate.mockRejectedValueOnce(Object.assign(new Error("private query"), {
          name: failure === "timeout" ? "MongoOperationTimeoutError" : "Error",
        }));
      }
      const app = createApp(deps);
      const response = await request(app).get(hourlyUrl()).expect(503);
      expect(response.body).toEqual({ error: "Telemetry temporarily unavailable" });
      expect(response.headers["retry-after"]).toBeUndefined();
      await request(app).get(hourlyUrl()).expect(200);
      expect(aggregate).toHaveBeenCalledTimes(2);
      expect(deps.health.check).not.toHaveBeenCalled();
    }
  );

  it("shares failed in-flight work and frees a saturated slot only when rejection settles", async () => {
    const deps = dependencies();
    const gates = METRICS.map(() => deferred<never[]>());
    deps.hourlyStore.aggregateHourly.mockImplementation(
      (metric) => gates[METRICS.indexOf(metric)].promise
    );
    const app = createApp(deps);
    const pending = METRICS.map((metric) =>
      request(app).get(hourlyUrl(metric)).then((response) => response)
    );
    let joined: Promise<request.Response> | undefined;
    try {
      await waitForCalls(deps.hourlyStore.aggregateHourly, 8);
      joined = request(app).get(hourlyUrl(METRICS[0])).then((response) => response);
      await waitForCalls(deps.clock.now, 9);
      expectRateLimited(await request(app).get(hourlyUrl(METRICS[0], "2026-09-09")));
      gates[0].reject(Object.assign(new Error("private timeout"), {
        name: "MongoOperationTimeoutError",
      }));
      const responses = await Promise.all([pending[0], joined]);
      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: "Telemetry temporarily unavailable" });
      }
      deps.hourlyStore.aggregateHourly.mockResolvedValueOnce([]);
      await request(app).get(hourlyUrl(METRICS[0], "2026-09-09")).expect(200);
      expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledTimes(9);
    } finally {
      gates.forEach((gate) => gate.resolve([]));
      await Promise.all([...pending, ...(joined ? [joined] : [])]);
    }
  });

  it("retains abandoned client work beyond UI timeout until the database actually settles", async () => {
    const deps = dependencies();
    const gates = METRICS.map(() => deferred<never[]>());
    deps.hourlyStore.aggregateHourly.mockImplementation(
      (metric) => gates[METRICS.indexOf(metric)].promise
    );
    // Supertest's auto-created listener is not closed by superagent.abort().
    // Own the listener explicitly so abort coverage also proves clean teardown.
    const server = createApp(deps).listen(0);
    const abandoned = request(server).get(hourlyUrl(METRICS[0]));
    const abandonedResult = abandoned.then(
      () => { throw new Error("aborted client unexpectedly received a response"); },
      (error) => error
    );
    const pending = METRICS.slice(1).map((metric) =>
      request(server).get(hourlyUrl(metric)).then((response) => response)
    );
    try {
      await waitForCalls(deps.hourlyStore.aggregateHourly, 8);
      abandoned.abort();
      expect((await abandonedResult).code).toBe("ABORTED");
      deps.processClock.nowMs.mockReturnValue(11000);
      expectRateLimited(await request(server).get(hourlyUrl(METRICS[0], "2026-09-09")));
      const joined = request(server).get(hourlyUrl(METRICS[0])).then((response) => response);
      await waitForCalls(deps.clock.now, 10);
      expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledTimes(8);
      gates[0].resolve([]);
      expect((await joined).status).toBe(200);
      await request(server).get(hourlyUrl(METRICS[0], "2026-09-09")).expect(200);
      expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledTimes(9);
    } finally {
      gates.forEach((gate) => gate.resolve([]));
      await Promise.all(pending);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

it.each([
  new URIError("private URI failure"),
  Object.assign(new URIError("private URI failure"), { status: 500 }),
  Object.assign(new Error("private unrelated failure"), { status: 400 }),
  Object.assign(new URIError("private string status"), { status: "400" }),
])("keeps non-route-decoding errors sanitized as 500", (error) => {
  const send = jest.fn();
  const status = jest.fn().mockReturnValue({ send });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    telemetryErrorHandler(error, {} as any, { status } as any, jest.fn());
    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(log).toHaveBeenCalledWith("telemetry_http_unexpected_error");
  } finally {
    log.mockRestore();
  }
});

it("forwards an unexpected synchronous hourly dependency error through Express without leaking it", async () => {
  const deps = dependencies();
  deps.clock.now.mockImplementationOnce(() => { throw new Error("private clock"); });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const app = createApp(deps);
    const response = await request(app).get(hourlyUrl()).expect(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    await request(app).get(hourlyUrl()).expect(200);
    expect(deps.hourlyStore.aggregateHourly).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});
