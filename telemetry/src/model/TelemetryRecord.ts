import mongoose from "mongoose";
import { METRICS, MetricName } from "../domain/metrics";

export interface TelemetryRecord {
  _id: string;
  metric: MetricName;
  occurredAt: Date;
}

const telemetryRecordSchema = new mongoose.Schema<TelemetryRecord>(
  {
    _id: {
      type: String,
      required: true,
    },
    metric: {
      type: String,
      enum: METRICS,
      required: true,
    },
    occurredAt: {
      type: Date,
      required: true,
    },
  },
  {
    strict: "throw",
    versionKey: false,
  }
);

telemetryRecordSchema.index(
  { occurredAt: 1 },
  { expireAfterSeconds: 2592000 }
);

export const TelemetryRecordModel = mongoose.model<TelemetryRecord>(
  "TelemetryRecord",
  telemetryRecordSchema
);
