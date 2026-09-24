import {
  CashBackSourceReply, EventPhase, IEventResultEvent, ILiveEventUpdateEvent,
} from "@betstan/common";
import { Schema } from "mongoose";

export type GamemasterAuthorityIntent = {
  id: string;
  expectedCursor: number;
  createdAt: Date;
  changes: Record<string, unknown>;
} & (
  | { kind: "STATE"; message?: never }
  | { kind: "LIVE"; message: ILiveEventUpdateEvent }
  | { kind: "RESULT"; message: IEventResultEvent }
);

export interface GamemasterCashBackHold {
  requestFingerprint: string;
  grant: Extract<CashBackSourceReply, { outcome: "GRANTED" }>;
}

const authorityIntentSchema = new Schema<GamemasterAuthorityIntent>({
  id: { type: String, required: true },
  kind: { type: String, enum: ["STATE", "LIVE", "RESULT"], required: true },
  expectedCursor: { type: Number, required: true },
  createdAt: { type: Date, required: true },
  changes: { type: Schema.Types.Mixed, required: true },
  message: { type: Schema.Types.Mixed, required: false },
}, { _id: false });

const cashBackHoldSchema = new Schema<GamemasterCashBackHold>({
  requestFingerprint: { type: String, required: true },
  grant: { type: Schema.Types.Mixed, required: true },
}, { _id: false });

export const cashBackAuthorityWritable = {
  cashBackHold: { $exists: false },
  cashBackAuthorityIntent: { $exists: false },
  cashBackArchived: { $ne: true },
  $expr: {
    $lt: [{ $ifNull: ["$cashBackAuthorityRevision", 0] }, Number.MAX_SAFE_INTEGER],
  },
};

export const LiveResultSource = {
  MANUAL: "MANUAL",
  SIMULATION: "SIMULATION",
} as const;

export type LiveResultSource =
  (typeof LiveResultSource)[keyof typeof LiveResultSource];

const processingLeaseSchema = new Schema(
  {
    token: {
      type: String,
      required: true,
    },
    acquiredAt: {
      type: Date,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { _id: false }
);

const pendingResultSchema = new Schema(
  {
    source: {
      type: String,
      required: true,
      enum: Object.values(LiveResultSource),
    },
    homeScore: {
      type: Number,
      required: true,
    },
    awayScore: {
      type: Number,
      required: true,
    },
    requestedAt: {
      type: Date,
      required: true,
    },
    sender: {
      type: String,
      required: false,
      default: null,
    },
    publishedSequence: {
      type: Number,
      required: false,
      default: null,
    },
    publishedAt: {
      type: Date,
      required: false,
      default: null,
    },
  },
  { _id: false }
);

const simulationFailureSchema = new Schema(
  {
    attemptCount: {
      type: Number,
      required: true,
      min: 1,
    },
    lastFailedAt: {
      type: Date,
      required: true,
    },
    quarantinedAt: {
      type: Date,
      required: false,
      default: null,
    },
  },
  { _id: false }
);

export const liveStateFields = {
  cashBackGeneration: { type: Number, required: false, select: false },
  cashBackAuthorityRevision: { type: Number, required: false, select: false },
  cashBackAuthorityAt: { type: Date, required: false, select: false },
  cashBackFenceAt: { type: Date, required: false, select: false },
  cashBackArchived: { type: Boolean, required: false, select: false },
  cashBackArchivePending: { type: Boolean, required: false, select: false },
  cashBackHold: { type: cashBackHoldSchema, required: false, select: false },
  cashBackAuthorityIntent: { type: authorityIntentSchema, required: false, select: false },
  cashBackAuthoritySnapshot: { type: Schema.Types.Mixed, required: false, select: false },
  phase: {
    type: String,
    required: false,
    enum: Object.values(EventPhase),
    default: undefined,
  },
  liveSeed: {
    type: String,
    required: false,
    default: null,
  },
  liveEngineVersion: {
    type: Number,
    required: false,
    default: null,
  },
  liveStartedAt: {
    type: Date,
    required: false,
    default: null,
  },
  liveEndedAt: {
    type: Date,
    required: false,
    default: null,
  },
  liveSequence: {
    type: Number,
    required: false,
    default: 0,
  },
  liveConfirmedReplayCursor: {
    type: Number,
    required: false,
    default: 0,
  },
  liveNextTransitionAt: {
    type: Date,
    required: false,
    default: null,
  },
  liveHomeScore: {
    type: Number,
    required: false,
    default: 0,
  },
  liveAwayScore: {
    type: Number,
    required: false,
    default: 0,
  },
  liveTimeline: {
    type: Schema.Types.Mixed,
    required: false,
    default: null,
  },
  liveTransitions: {
    type: [Schema.Types.Mixed],
    required: false,
    default: [],
  },
  liveMarkets: {
    type: [Schema.Types.Mixed],
    required: false,
    default: [],
  },
  /**
   * Idempotency marker for the synthetic pre-kickoff live-slip snapshot
   * (kickoff team + goal-in-first-minute, published at sequence 0 during
   * the T-10-to-kickoff countdown). Deliberately independent of
   * `hasStoredSimulation`/`liveConfirmedReplayCursor`: if the worker
   * crashes between persisting the simulation and publishing this
   * snapshot, a later retry must still be able to publish it, which a
   * shared flag would prevent once the simulation itself is already
   * stored.
   */
  livePreKickoffPublishedAt: {
    type: Date,
    required: false,
    default: null,
  },
  processingLease: {
    type: processingLeaseSchema,
    required: false,
    default: undefined,
  },
  pendingResult: {
    type: pendingResultSchema,
    required: false,
    default: undefined,
  },
  simulationFailure: {
    type: simulationFailureSchema,
    required: false,
    default: undefined,
  },
  resultPublishedAt: {
    type: Date,
    required: false,
    default: null,
  },
} as const;
