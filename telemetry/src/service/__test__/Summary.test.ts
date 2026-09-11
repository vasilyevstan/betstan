import { METRICS } from "../../domain/metrics";
import { buildMetricSummary, SummaryStore } from "../Summary";

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
