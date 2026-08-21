import {
  BetKind,
  LiveMarketStatus,
  ModerationDeclineReason,
  ModerationStatus,
} from "@betstan/common";
import { Schema, model } from "mongoose";

export const PENDING_MODERATION_RESULT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "EXHAUSTED",
] as const;

export type PendingModerationResultStatus =
  (typeof PENDING_MODERATION_RESULT_STATUSES)[number];

const affectedRowSchema = new Schema({
  rowId: {
    type: String,
    required: true,
  },
  declineReason: {
    type: String,
    required: true,
    enum: Object.values(ModerationDeclineReason),
  },
  marketId: {
    type: String,
    required: false,
  },
  marketVersion: {
    type: Number,
    required: false,
  },
  quoteVersion: {
    type: Number,
    required: false,
  },
  currentOdds: {
    type: Number,
    required: false,
  },
  marketStatus: {
    type: String,
    required: false,
    enum: Object.values(LiveMarketStatus),
  },
  selectionId: {
    type: String,
    required: false,
  },
});

const lastErrorSchema = new Schema(
  {
    name: {
      type: String,
      required: false,
      default: "",
    },
    message: {
      type: String,
      required: false,
      default: "",
    },
  },
  {
    _id: false,
  }
);

const pendingModerationResultSchema = new Schema(
  {
    slipId: {
      type: String,
      required: true,
    },
    result: {
      type: String,
      required: true,
      enum: Object.values(ModerationStatus),
    },
    betKind: {
      type: String,
      required: true,
      enum: Object.values(BetKind),
      default: BetKind.PRE_MATCH,
    },
    declineReason: {
      type: String,
      required: false,
      enum: Object.values(ModerationDeclineReason),
    },
    affectedRows: [affectedRowSchema],
    timestamp: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: PENDING_MODERATION_RESULT_STATUSES,
      default: "PENDING",
    },
    attemptCount: {
      type: Number,
      required: true,
      default: 0,
    },
    nextAttemptAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    lastAttemptAt: {
      type: Date,
      required: false,
    },
    leaseOwner: {
      type: String,
      required: false,
      default: "",
    },
    leasedUntil: {
      type: Date,
      required: false,
    },
    lastError: {
      type: lastErrorSchema,
      required: true,
      default: () => ({
        name: "",
        message: "",
      }),
    },
    exhaustedAt: {
      type: Date,
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

pendingModerationResultSchema.index({ slipId: 1 }, { unique: true });
pendingModerationResultSchema.index({
  status: 1,
  nextAttemptAt: 1,
  leasedUntil: 1,
});
pendingModerationResultSchema.index({
  status: 1,
  exhaustedAt: 1,
  updatedAt: 1,
});

const PendingModerationResult = model(
  "PendingModerationResult",
  pendingModerationResultSchema
);

export default PendingModerationResult;
