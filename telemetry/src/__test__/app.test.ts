import request from "supertest";
import { createApp, telemetryErrorHandler } from "../app";
import { METRICS, SERVICES } from "../domain/metrics";

const now = new Date("2026-09-10T12:34:56.789Z");
const uuid = "9a6b8a5f-d9ea-4f4c-8c0a-7d39b9a55c12";
const health = SERVICES.map((service) => ({ service, status: "green" as const }));

const dependencies = () => ({
  clock: { now: jest.fn(() => now) },
  health: { check: jest.fn().mockResolvedValue(health) } as any,
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
