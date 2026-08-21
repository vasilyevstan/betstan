import { Schema, model } from "mongoose";

export enum ParkedPlaceBetStatus {
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  EXHAUSTED = "EXHAUSTED",
}

const parkedPlaceBetSchema = new Schema(
  {
    slipId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    event: {
      type: Schema.Types.Mixed,
      required: true,
    },
    pendingEventIds: {
      type: [String],
      required: true,
      default: [],
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(ParkedPlaceBetStatus),
      default: ParkedPlaceBetStatus.PENDING,
    },
    attemptCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    nextAttemptAt: {
      type: String,
      required: true,
      index: true,
    },
    leaseOwner: {
      type: String,
      required: false,
      default: "",
    },
    leaseUntil: {
      type: String,
      required: false,
      default: "",
    },
    lastAttemptAt: {
      type: String,
      required: false,
      default: "",
    },
    lastError: {
      type: String,
      required: false,
      default: "",
    },
    exhaustedAt: {
      type: String,
      required: false,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

parkedPlaceBetSchema.index({
  status: 1,
  nextAttemptAt: 1,
  leaseUntil: 1,
  createdAt: 1,
});

const ParkedPlaceBet = model("ParkedPlaceBet", parkedPlaceBetSchema);

export { ParkedPlaceBet };
