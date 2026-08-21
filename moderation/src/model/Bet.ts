import {
  BetKind,
  LiveMarketStatus,
  LiveMarketType,
  ModerationDeclineReason,
  ModerationStatus,
  TeamSide,
} from "@betstan/common";
import { Schema, model } from "mongoose";

const affectedRowSchema = new Schema(
  {
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
  },
  { _id: false }
);

const betRowSchema = new Schema(
  {
    id: {
      type: String,
      required: true,
    },
    eventId: {
      type: String,
      required: true,
    },
    eventName: {
      type: String,
      required: true,
    },
    oddsId: {
      type: String,
      required: true,
    },
    oddsValue: {
      type: Number,
      required: true,
    },
    oddsName: {
      type: String,
      required: true,
    },
    productName: {
      type: String,
      required: true,
    },
    productId: {
      type: String,
      required: true,
    },
    timestamp: {
      type: String,
      required: true,
    },
    eventTime: {
      type: String,
      required: false,
    },
    betKind: {
      type: String,
      required: false,
      enum: Object.values(BetKind),
    },
    marketId: {
      type: String,
      required: false,
    },
    marketType: {
      type: String,
      required: false,
      enum: Object.values(LiveMarketType),
    },
    marketVersion: {
      type: Number,
      required: false,
    },
    quoteVersion: {
      type: Number,
      required: false,
    },
    selectionId: {
      type: String,
      required: false,
    },
    side: {
      type: String,
      required: false,
      enum: Object.values(TeamSide),
    },
    selectedAt: {
      type: String,
      required: false,
    },
    quoteValidUntil: {
      type: String,
      required: false,
    },
  },
  { _id: false }
);

const betSchema = new Schema({
  userId: {
    type: String,
    required: true,
  },
  slipId: {
    type: String,
    required: true,
    index: true,
    unique: true,
  },
  status: {
    type: String,
    required: true,
    enum: Object.values(ModerationStatus),
    default: ModerationStatus.RECEIVED,
  },
  wager: {
    type: Number,
    required: true,
  },
  timestamp: {
    type: String,
    required: true,
  },
  moderationTimestamp: {
    type: String,
    required: false,
    default: "",
  },
  publishedAt: {
    type: String,
    required: false,
    default: "",
  },
  publishToken: {
    type: String,
    required: false,
    default: "",
  },
  publishLeaseOwner: {
    type: String,
    required: false,
    default: "",
  },
  publishLeaseUntil: {
    type: String,
    required: false,
    default: "",
  },
  betKind: {
    type: String,
    required: false,
    enum: Object.values(BetKind),
  },
  declineReason: {
    type: String,
    required: false,
    enum: Object.values(ModerationDeclineReason),
  },
  affectedRows: {
    type: [affectedRowSchema],
    required: true,
    default: [],
  },
  rows: {
    type: [betRowSchema],
    required: true,
    default: [],
  },
});

betSchema.index({
  publishedAt: 1,
  publishLeaseUntil: 1,
  moderationTimestamp: 1,
});

betSchema.index({
  publishLeaseOwner: 1,
  publishToken: 1,
});

const Bet = model("Bet", betSchema);

export { Bet };
