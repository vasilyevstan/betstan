import { Schema, model } from "mongoose";

export const RETRY_RECORD_DEAD_LETTER_RETENTION_DAYS = 7;
export const RETRY_RECORD_DEAD_LETTER_RETENTION_SECONDS =
  RETRY_RECORD_DEAD_LETTER_RETENTION_DAYS * 24 * 60 * 60;

export const RETRY_RECORD_KINDS = [
  "PLACE_BET",
  "MODERATION_RESULT",
  "EVENT_RESULT",
  "LIVE_EVENT_UPDATE",
] as const;

export type RetryRecordKind = (typeof RETRY_RECORD_KINDS)[number];

export const RETRY_RECORD_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "DEAD_LETTER",
] as const;

export type RetryRecordStatus = (typeof RETRY_RECORD_STATUSES)[number];

const retryRecordSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
    },
    listenerServiceName: {
      type: String,
      required: true,
    },
    kind: {
      type: String,
      required: true,
      enum: RETRY_RECORD_KINDS,
    },
    identity: {
      type: String,
      required: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: false,
    },
    payloadSummary: {
      type: Schema.Types.Mixed,
      required: false,
    },
    payloadHash: {
      type: String,
      required: false,
      default: "",
    },
    payloadByteCount: {
      type: Number,
      required: false,
      default: 0,
    },
    status: {
      type: String,
      required: true,
      enum: RETRY_RECORD_STATUSES,
      default: "PENDING",
    },
    attemptCount: {
      type: Number,
      required: true,
      default: 1,
    },
    nextAttemptAt: {
      type: Date,
      required: true,
    },
    lastErrorName: {
      type: String,
      required: false,
      default: "",
    },
    lastErrorMessage: {
      type: String,
      required: false,
      default: "",
    },
    lastErrorStack: {
      type: String,
      required: false,
      default: "",
    },
    lastErrorAt: {
      type: Date,
      required: false,
    },
    lastAttemptAt: {
      type: Date,
      required: false,
    },
    leasedUntil: {
      type: Date,
      required: false,
    },
    leaseOwner: {
      type: String,
      required: false,
      default: "",
    },
    completedAt: {
      type: Date,
      required: false,
    },
    deadLetteredAt: {
      type: Date,
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

retryRecordSchema.index({ key: 1 }, { unique: true });
retryRecordSchema.index({ status: 1, nextAttemptAt: 1, leasedUntil: 1 });
retryRecordSchema.index({ status: 1, deadLetteredAt: 1, updatedAt: 1 });
retryRecordSchema.index(
  { deadLetteredAt: 1 },
  {
    expireAfterSeconds: RETRY_RECORD_DEAD_LETTER_RETENTION_SECONDS,
    partialFilterExpression: {
      status: "DEAD_LETTER",
    },
  }
);

const RetryRecord = model("RetryRecord", retryRecordSchema);

export default RetryRecord;
