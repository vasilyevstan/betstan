import { HydratedDocument, Schema, model } from "mongoose";

export enum PendingBetUpdateKind {
  MODERATION_RESULT = "MODERATION_RESULT",
  SETTLE_SLIP = "SETTLE_SLIP",
  SETTLE_SLIP_ROW = "SETTLE_SLIP_ROW",
}

export enum PendingBetUpdateStatus {
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  EXHAUSTED = "EXHAUSTED",
}

export interface PendingBetUpdateRecord {
  slipId: string;
  kind: PendingBetUpdateKind;
  dedupeKey: string;
  timestamp: string;
  payload: unknown;
  status: PendingBetUpdateStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastAttemptAt?: Date;
  lastError?: string;
  exhaustedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type PendingBetUpdateDocument =
  HydratedDocument<PendingBetUpdateRecord>;

const pendingBetUpdateSchema = new Schema<PendingBetUpdateRecord>(
  {
    slipId: {
      type: String,
      required: true,
      index: true,
    },
    kind: {
      type: String,
      required: true,
      enum: Object.values(PendingBetUpdateKind),
    },
    dedupeKey: {
      type: String,
      required: true,
      unique: true,
    },
    timestamp: {
      type: String,
      required: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(PendingBetUpdateStatus),
      default: PendingBetUpdateStatus.PENDING,
    },
    attemptCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    nextAttemptAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    leaseOwner: {
      type: String,
      required: false,
      default: undefined,
    },
    leaseUntil: {
      type: Date,
      required: false,
      default: undefined,
    },
    lastAttemptAt: {
      type: Date,
      required: false,
      default: undefined,
    },
    lastError: {
      type: String,
      required: false,
      default: undefined,
      maxlength: 500,
    },
    exhaustedAt: {
      type: Date,
      required: false,
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);

pendingBetUpdateSchema.index({ status: 1, nextAttemptAt: 1 });
pendingBetUpdateSchema.index({ status: 1, leaseUntil: 1 });
pendingBetUpdateSchema.index({ slipId: 1, kind: 1, timestamp: 1 });

const PendingBetUpdate = model<PendingBetUpdateRecord>(
  "PendingBetUpdate",
  pendingBetUpdateSchema
);

export { PendingBetUpdate };
