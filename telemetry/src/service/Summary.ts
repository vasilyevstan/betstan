import { METRICS, MetricName } from "../domain/metrics";
import { TelemetryRecordModel } from "../model/TelemetryRecord";

interface AggregateBucket {
  _id: {
    metric: MetricName;
    date: string;
  };
  count: number;
}

export interface MetricValues {
  metric: MetricName;
  values: number[];
}

export interface MetricSummary {
  dates: string[];
  metrics: MetricValues[];
}

export interface SummaryStore {
  aggregate(start: Date, end: Date): Promise<AggregateBucket[]>;
}

interface HourlyBucket {
  _id: number;
  count: number;
}

export interface HourlySummaryStore {
  aggregateHourly(
    metric: MetricName,
    start: Date,
    end: Date
  ): Promise<HourlyBucket[]>;
}

export interface HourlyMetricSummary {
  generatedAt: string;
  metric: MetricName;
  date: string;
  hours: string[];
  values: number[];
}

export class MongoSummaryStore implements SummaryStore, HourlySummaryStore {
  async aggregate(start: Date, end: Date): Promise<AggregateBucket[]> {
    return TelemetryRecordModel.aggregate<AggregateBucket>([
      {
        $match: {
          occurredAt: {
            $gte: start,
            $lt: end,
          },
        },
      },
      {
        $group: {
          _id: {
            metric: "$metric",
            date: {
              $dateToString: {
                date: "$occurredAt",
                format: "%Y-%m-%d",
                timezone: "UTC",
              },
            },
          },
          count: { $sum: 1 },
        },
      },
    ]);
  }

  async aggregateHourly(
    metric: MetricName,
    start: Date,
    end: Date
  ): Promise<HourlyBucket[]> {
    return TelemetryRecordModel.aggregate<HourlyBucket>([
      {
        $match: {
          metric,
          occurredAt: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: { $hour: { date: "$occurredAt", timezone: "UTC" } },
          count: { $sum: 1 },
        },
      },
    ]).option({ timeoutMS: 5000 });
  }
}

const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

export const buildMetricSummary = async (
  generatedAt: Date,
  store: SummaryStore
): Promise<MetricSummary> => {
  const currentDay = Date.UTC(
    generatedAt.getUTCFullYear(),
    generatedAt.getUTCMonth(),
    generatedAt.getUTCDate()
  );
  const start = new Date(currentDay - 13 * 24 * 60 * 60 * 1000);
  const end = new Date(currentDay + 24 * 60 * 60 * 1000);
  const dates = Array.from({ length: 14 }, (_, index) =>
    dateKey(new Date(start.getTime() + index * 24 * 60 * 60 * 1000))
  );
  const dateIndexes = new Map(dates.map((date, index) => [date, index]));
  const metricIndexes = new Map(METRICS.map((metric, index) => [metric, index]));
  const metrics = METRICS.map((metric) => ({
    metric,
    values: Array<number>(14).fill(0),
  }));

  const buckets = await store.aggregate(start, end);
  for (const bucket of buckets) {
    const metricIndex = metricIndexes.get(bucket._id.metric);
    const dateIndex = dateIndexes.get(bucket._id.date);
    if (
      metricIndex !== undefined
      && dateIndex !== undefined
      && Number.isInteger(bucket.count)
      && bucket.count >= 0
    ) {
      metrics[metricIndex].values[dateIndex] = bucket.count;
    }
  }

  return { dates, metrics };
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const parseHourlyDay = (
  date: string,
  generatedAt: Date
): Date | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return undefined;
  }
  const start = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || dateKey(start) !== date) {
    return undefined;
  }
  const today = new Date(`${dateKey(generatedAt)}T00:00:00.000Z`).getTime();
  return start.getTime() >= today - 13 * DAY_MS && start.getTime() <= today
    ? start
    : undefined;
};

export const buildHourlyMetricSummary = async (
  generatedAt: Date,
  metric: MetricName,
  date: string,
  store: HourlySummaryStore
): Promise<HourlyMetricSummary> => {
  const start = new Date(`${date}T00:00:00.000Z`);
  const hours = Array.from({ length: 24 }, (_, hour) =>
    new Date(start.getTime() + hour * HOUR_MS).toISOString()
  );
  const values = Array<number>(24).fill(0);
  const buckets = await store.aggregateHourly(
    metric,
    start,
    new Date(start.getTime() + DAY_MS)
  );
  if (!Array.isArray(buckets) || buckets.length > 24) {
    throw new Error("telemetry_hourly_buckets_invalid");
  }
  const seen = new Set<number>();
  for (const bucket of buckets) {
    if (
      !bucket
      || !Number.isInteger(bucket._id)
      || bucket._id < 0
      || bucket._id > 23
      || seen.has(bucket._id)
      || !Number.isSafeInteger(bucket.count)
      || bucket.count < 0
    ) {
      throw new Error("telemetry_hourly_buckets_invalid");
    }
    seen.add(bucket._id);
    values[bucket._id] = bucket.count;
  }
  // Computation start, not a transactional cutoff: late records can change totals.
  return { generatedAt: generatedAt.toISOString(), metric, date, hours, values };
};
