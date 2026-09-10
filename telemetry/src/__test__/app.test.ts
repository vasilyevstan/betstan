import request from "supertest";
import { createApp, telemetryErrorHandler } from "../app";
import { METRICS, SERVICES } from "../domain/metrics";

const now = new Date("2026-09-10T12:34:56.789Z");
const uuid = "9a6b8a5f-d9ea-4f4c-8c0a-7d39b9a55c12";
const health = SERVICES.map((service) => ({ service, status: "green" as const }));

const dependencies = () => ({
  clock: { now: jest.fn(() => now) },
  health: { check: jest.fn().mockResolvedValue(health) } as any,
  recorder: { record: jest.fn().mockResolvedValue(undefined) },
  summaryStore: { aggregate: jest.fn().mockResolvedValue([]) },
  uuid: jest.fn(() => uuid),
});

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
});
