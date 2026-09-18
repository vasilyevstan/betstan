import mongoose from "mongoose";
import { METRICS } from "../../domain/metrics";
import { TelemetryRecordModel } from "../../model/TelemetryRecord";
import {
  buildHourlyMetricSummary,
  buildMetricSummary,
  MongoSummaryStore,
  parseHourlyDay,
  SummaryStore,
} from "../Summary";

it("aggregates the exact ascending UTC 14-day window and zero-fills in metric order", async () => {
  const aggregate = jest.fn().mockResolvedValue([
    {
      _id: { metric: "BET_PLACED", date: "2026-09-10" },
      count: 7,
    },
    {
      _id: { metric: "MAIN_PAGE_VISIT", date: "2026-08-28" },
      count: 2,
    },
  ]);
  const summary = await buildMetricSummary(
    new Date("2026-09-10T23:59:59.999Z"),
    { aggregate } as SummaryStore
  );

  expect(aggregate).toHaveBeenCalledWith(
    new Date("2026-08-28T00:00:00.000Z"),
    new Date("2026-09-11T00:00:00.000Z")
  );
  expect(summary.dates).toHaveLength(14);
  expect(summary.dates[0]).toBe("2026-08-28");
  expect(summary.dates[13]).toBe("2026-09-10");
  expect(summary.metrics.map(({ metric }) => metric)).toEqual(METRICS);
  expect(summary.metrics[0].values[0]).toBe(2);
  expect(summary.metrics[3].values[13]).toBe(7);
  expect(
    summary.metrics.flatMap(({ values }) => values).reduce((a, b) => a + b, 0)
  ).toBe(9);
});

it("does not fabricate a summary when aggregation fails", async () => {
  await expect(
    buildMetricSummary(new Date(), {
      aggregate: jest.fn().mockRejectedValue(new Error("database unavailable")),
    })
  ).rejects.toThrow("database unavailable");
});

describe("hourly summary", () => {
  const generatedAt = new Date("2026-09-10T12:34:56.789Z");
  const date = "2026-09-10";

  it.each(METRICS)("zero-fills exactly 24 UTC hours for %s", async (metric) => {
    const aggregateHourly = jest.fn().mockResolvedValue([]);
    const summary = await buildHourlyMetricSummary(
      generatedAt, metric, date, { aggregateHourly }
    );
    expect(summary).toEqual({
      generatedAt: generatedAt.toISOString(),
      metric,
      date,
      hours: Array.from({ length: 24 }, (_, hour) =>
        `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`
      ),
      values: Array(24).fill(0),
    });
    expect(aggregateHourly).toHaveBeenCalledWith(
      metric,
      new Date("2026-09-10T00:00:00.000Z"),
      new Date("2026-09-11T00:00:00.000Z")
    );
  });

  it("preserves each hour/count pair regardless of Mongo bucket order", async () => {
    const summary = await buildHourlyMetricSummary(
      generatedAt, "BET_PLACED", date, {
        aggregateHourly: jest.fn().mockResolvedValue([
          { _id: 23, count: Number.MAX_SAFE_INTEGER },
          { _id: 0, count: 2 },
          { _id: 12, count: 0 },
          { _id: 1, count: 7 },
        ]),
      }
    );
    expect(summary.values).toEqual([
      2, 7, ...Array(21).fill(0), Number.MAX_SAFE_INTEGER,
    ]);
  });

  it.each([
    null,
    {},
    [null],
    [{}],
    [{ _id: -1, count: 1 }],
    [{ _id: 24, count: 1 }],
    [{ _id: 1.5, count: 1 }],
    [{ _id: "01", count: 1 }],
    [{ _id: NaN, count: 1 }],
    [{ _id: 0, count: -1 }],
    [{ _id: 0, count: 1.5 }],
    [{ _id: 0, count: "1" }],
    [{ _id: 0, count: NaN }],
    [{ _id: 0, count: Infinity }],
    [{ _id: 0, count: Number.MAX_SAFE_INTEGER + 1 }],
    [{ _id: 0, count: 0 }, { _id: 0, count: 1 }],
    Array.from({ length: 25 }, (_, _id) => ({ _id, count: 1 })),
  ].map((buckets) => [buckets]))("fails closed for invalid hourly buckets: %j", async (buckets) => {
    await expect(buildHourlyMetricSummary(
      generatedAt, "BET_PLACED", date,
      { aggregateHourly: jest.fn().mockResolvedValue(buckets) }
    )).rejects.toThrow("telemetry_hourly_buckets_invalid");
  });

  it("propagates failure rather than fabricating an empty day", async () => {
    await expect(buildHourlyMetricSummary(
      generatedAt, "BET_PLACED", date, {
        aggregateHourly: jest.fn().mockRejectedValue(new Error("query failed")),
      }
    )).rejects.toThrow("query failed");
  });

  it.each([
    ["2026-08-28", true],
    ["2026-09-10", true],
    ["2026-08-27", false],
    ["2026-09-11", false],
    ["2026-09-00", false],
    ["2026-09-31", false],
    ["2026-02-29", false],
    ["2026-13-01", false],
    ["2026-9-10", false],
    ["2026-09-10T00:00:00.000Z", false],
    ["2026-09-10\n", false],
  ])("validates canonical current-window date %j", (day, valid) => {
    expect(parseHourlyDay(day, generatedAt)).toEqual(
      valid ? new Date(`${day}T00:00:00.000Z`) : undefined
    );
  });

  it.each(["2024-02-29", "2026-03-08", "2026-11-01"])(
    "retains 24 UTC hours on leap and daylight-saving dates: %s",
    async (day) => {
      const instant = new Date(`${day}T12:00:00.000Z`);
      expect(parseHourlyDay(day, instant)).toBeDefined();
      const summary = await buildHourlyMetricSummary(
        instant, "BET_PLACED", day,
        { aggregateHourly: jest.fn().mockResolvedValue([]) }
      );
      expect(summary.hours).toHaveLength(24);
      expect(summary.hours[0]).toBe(`${day}T00:00:00.000Z`);
      expect(summary.hours[23]).toBe(`${day}T23:00:00.000Z`);
    }
  );
});

describe("retained real Mongo hourly data", () => {
  // Mongo's TTL monitor uses actual time, not an injected JavaScript clock.
  const retainedDay = () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return new Date(today.getTime() - 24 * 60 * 60 * 1000);
  };

  it("isolates metrics, honors half-open hour/day boundaries, and matches fixed daily totals", async () => {
    const start = retainedDay();
    const date = start.toISOString().slice(0, 10);
    const offsets = [-1, 0, 3599999, 3600000, 43200000, 86399999, 86400000];
    await TelemetryRecordModel.insertMany(METRICS.flatMap((metric) =>
      offsets.map((offset, index) => ({
        _id: `${metric}-${index}`,
        metric,
        occurredAt: new Date(start.getTime() + offset),
      }))
    ));
    // Only this metric gets an extra record in hour 1.
    await TelemetryRecordModel.create({
      _id: "extra-bet",
      metric: "BET_PLACED",
      occurredAt: new Date(start.getTime() + 3600001),
    });
    const store = new MongoSummaryStore();
    const snapshotTime = new Date(start.getTime() + 1);
    const daily = await buildMetricSummary(snapshotTime, store);
    for (const metric of METRICS) {
      const hourly = await buildHourlyMetricSummary(
        snapshotTime, metric, date, store
      );
      const expected = Array<number>(24).fill(0);
      expected[0] = 2;
      expected[1] = metric === "BET_PLACED" ? 2 : 1;
      expected[12] = 1;
      expected[23] = 1;
      expect(hourly.values).toEqual(expected);
      expect(hourly.values.reduce((sum, count) => sum + count, 0)).toBe(
        daily.metrics.find((item) => item.metric === metric)!.values[13]
      );
    }
  });

  it("returns 24 zeros for an actually empty retained day", async () => {
    const start = retainedDay();
    const summary = await buildHourlyMetricSummary(
      new Date(), "USER_CREATED", start.toISOString().slice(0, 10),
      new MongoSummaryStore()
    );
    expect(summary.values).toEqual(Array(24).fill(0));
  });

  it("forwards only hourly timeoutMS through Mongoose without changing daily options", async () => {
    const start = retainedDay();
    const end = new Date(start.getTime() + 86400000);
    const aggregate = jest.spyOn(TelemetryRecordModel.collection, "aggregate");
    try {
      const store = new MongoSummaryStore();
      await store.aggregateHourly("BET_PLACED", start, end);
      expect(aggregate).toHaveBeenNthCalledWith(1, [
        { $match: { metric: "BET_PLACED", occurredAt: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: { $hour: { date: "$occurredAt", timezone: "UTC" } },
            count: { $sum: 1 },
          },
        },
      ], { timeoutMS: 5000 });
      await store.aggregate(start, end);
      expect(aggregate.mock.calls[1][1]).toEqual({});
    } finally {
      aggregate.mockRestore();
    }
  });

  it("enforces actual driver CSOT on a slow Mongo command and permits a later query", async () => {
    const start = retainedDay();
    await TelemetryRecordModel.create({
      _id: "csot-test",
      metric: "BET_PLACED",
      occurredAt: start,
    });
    // Use the same harness database with the installed Mongoose driver.
    // Command monitoring is test-local, never a production connection option.
    const client = new mongoose.mongo.MongoClient(
      `mongodb://${mongoose.connection.host}:${mongoose.connection.port}`,
      { monitorCommands: true }
    );
    const commands: Record<string, any>[] = [];
    client.on("commandStarted", (event) => {
      if (event.commandName === "aggregate") {
        commands.push(event.command);
      }
    });
    await client.connect();
    const collection = client.db(mongoose.connection.name)
      .collection(TelemetryRecordModel.collection.name);
    const aggregate = jest.spyOn(TelemetryRecordModel.collection, "aggregate")
      .mockImplementationOnce((pipeline, options) =>
        collection.aggregate([
          ...pipeline!,
          {
            $match: {
              $expr: {
                $function: {
                  body: "function() { const end = Date.now() + 15000; "
                    + "while (Date.now() < end) {} return true; }",
                  args: [],
                  lang: "js",
                },
              },
            },
          },
        ], options)
      );
    try {
      const began = Date.now();
      await expect(new MongoSummaryStore().aggregateHourly(
        "BET_PLACED", start, new Date(start.getTime() + 86400000)
      )).rejects.toMatchObject({ name: "MongoOperationTimeoutError" });
      expect(Date.now() - began).toBeLessThan(14000);
      expect(commands).toHaveLength(1);
      // CSOT derives this server-side budget; the application sets no maxTimeMS.
      expect(commands[0].maxTimeMS).toBeGreaterThan(0);
      expect(commands[0].maxTimeMS).toBeLessThanOrEqual(5000);
      expect(commands[0]).not.toHaveProperty("timeoutMS");
      expect(aggregate.mock.calls[0][1]).toEqual({ timeoutMS: 5000 });
      await expect(new MongoSummaryStore().aggregateHourly(
        "BET_PLACED", start, new Date(start.getTime() + 86400000)
      )).resolves.toEqual([{ _id: 0, count: 1 }]);
    } finally {
      aggregate.mockRestore();
      await client.close();
    }
  });
});
