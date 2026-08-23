import {
  BettingStatus,
  EventPhase,
  LiveMarketStatus,
  LiveMarketType,
  LiveSettlementReason,
  TeamSide,
} from "@betstan/common";
import { Schema, model } from "mongoose";

const selectionSchema = new Schema(
  {
    selectionId: {
      type: String,
      required: true,
    },
    side: {
      type: String,
      required: true,
      enum: Object.values(TeamSide),
    },
    odds: {
      type: Number,
      required: true,
    },
  },
  { _id: false }
);

const marketSchema = new Schema(
  {
    marketId: {
      type: String,
      required: true,
    },
    marketType: {
      type: String,
      required: true,
      enum: Object.values(LiveMarketType),
    },
    marketVersion: {
      type: Number,
      required: true,
    },
    quoteVersion: {
      type: Number,
      required: true,
    },
    quoteValidUntil: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(LiveMarketStatus),
    },
    selections: {
      type: [selectionSchema],
      required: true,
      default: [],
    },
  },
  { _id: false }
);

/**
 * Bounded, persisted record of every distinct marketId+marketVersion+quoteVersion
 * quote ever observed for an event, so a live snapshot replacing the current
 * mirror can never erase evidence of a quote that was authoritative when a bet
 * was submitted. `sequence` is the event sequence the quote was first observed
 * at and is used only for recency ordering/pruning, never for quote identity.
 * `phase`/`bettingStatus` capture the event's overall live state at that same
 * sequence, so a later suspension/full-time snapshot can never retroactively
 * hide that the event was genuinely live when this specific quote was issued.
 */
const marketHistorySchema = new Schema(
  {
    marketId: {
      type: String,
      required: true,
    },
    marketType: {
      type: String,
      required: true,
      enum: Object.values(LiveMarketType),
    },
    marketVersion: {
      type: Number,
      required: true,
    },
    quoteVersion: {
      type: Number,
      required: true,
    },
    quoteValidUntil: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(LiveMarketStatus),
    },
    selections: {
      type: [selectionSchema],
      required: true,
      default: [],
    },
    sequence: {
      type: Number,
      required: true,
    },
    phase: {
      type: String,
      required: true,
      enum: Object.values(EventPhase),
    },
    bettingStatus: {
      type: String,
      required: true,
      enum: Object.values(BettingStatus),
    },
  },
  { _id: false }
);

const settlementSchema = new Schema(
  {
    marketId: {
      type: String,
      required: true,
    },
    marketVersion: {
      type: Number,
      required: true,
    },
    settlementReason: {
      type: String,
      required: true,
      enum: Object.values(LiveSettlementReason),
    },
    settlementSequence: {
      type: Number,
      required: true,
    },
    winningSide: {
      type: String,
      required: true,
      enum: Object.values(TeamSide),
    },
    winningSelection: {
      type: String,
      required: false,
    },
  },
  { _id: false }
);

const liveEventMirrorSchema = new Schema({
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  sequence: {
    type: Number,
    required: true,
  },
  occurredAt: {
    type: String,
    required: true,
  },
  kickoffAt: {
    type: String,
    required: true,
  },
  minute: {
    type: Number,
    required: true,
  },
  addedTime: {
    type: Number,
    required: false,
  },
  phase: {
    type: String,
    required: true,
    enum: Object.values(EventPhase),
  },
  homeScore: {
    type: Number,
    required: true,
  },
  awayScore: {
    type: Number,
    required: true,
  },
  bettingStatus: {
    type: String,
    required: true,
    enum: Object.values(BettingStatus),
  },
  markets: {
    type: [marketSchema],
    required: true,
    default: [],
  },
  marketHistory: {
    type: [marketHistorySchema],
    required: true,
    default: [],
  },
  historyRevision: {
    type: Number,
    required: true,
    default: 0,
  },
  settlements: {
    type: [settlementSchema],
    required: true,
    default: [],
  },
  eventName: {
    type: String,
    required: false,
  },
  home: {
    type: String,
    required: false,
  },
  away: {
    type: String,
    required: false,
  },
});

const LiveEventMirror = model("LiveEventMirror", liveEventMirrorSchema);

export { LiveEventMirror };
