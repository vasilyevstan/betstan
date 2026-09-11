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

export class MongoSummaryStore implements SummaryStore {
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
