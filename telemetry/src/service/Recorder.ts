import { MetricName } from "../domain/metrics";
import { TelemetryRecordModel } from "../model/TelemetryRecord";

export interface RecordMetric {
  _id: string;
  metric: MetricName;
  occurredAt: Date;
}

export interface MetricRecorder {
  record(record: RecordMetric): Promise<void>;
}

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && Reflect.get(error, "code") === 11000;

export class MongoMetricRecorder implements MetricRecorder {
  async record(record: RecordMetric): Promise<void> {
    try {
      await TelemetryRecordModel.updateOne(
        { _id: record._id },
        {
          $setOnInsert: {
            _id: record._id,
            metric: record.metric,
            occurredAt: record.occurredAt,
          },
        },
        { upsert: true }
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }
}
