import { HydratedDocument, Schema, model } from "mongoose";

export interface BetPlacementConflictRecord {
  conflictKey: string;
  slipId: string;
  placementAttemptId: string;
  firstPlacementFingerprint: string;
  conflictingPlacementFingerprint: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  observedStatus: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type BetPlacementConflictDocument =
  HydratedDocument<BetPlacementConflictRecord>;

const betPlacementConflictSchema = new Schema<BetPlacementConflictRecord>(
  {
    conflictKey: {
      type: String,
      required: true,
      unique: true,
    },
    slipId: {
      type: String,
      required: true,
      index: true,
    },
    placementAttemptId: {
      type: String,
      required: true,
      index: true,
    },
    firstPlacementFingerprint: {
      type: String,
      required: true,
    },
    conflictingPlacementFingerprint: {
      type: String,
      required: true,
    },
    occurrenceCount: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    firstSeenAt: {
      type: String,
      required: true,
    },
    lastSeenAt: {
      type: String,
      required: true,
    },
    observedStatus: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

betPlacementConflictSchema.index({ slipId: 1, placementAttemptId: 1 });

const BetPlacementConflict = model<BetPlacementConflictRecord>(
  "BetPlacementConflict",
  betPlacementConflictSchema
);

export { BetPlacementConflict };
