import { EventPhase } from "@betstan/common";
import { Schema } from "mongoose";

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

export const liveStateFields = {
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
  resultPublishedAt: {
    type: Date,
    required: false,
    default: null,
  },
} as const;
