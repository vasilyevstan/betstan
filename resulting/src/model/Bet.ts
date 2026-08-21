import {
  BetKind,
  LiveMarketType,
  LiveSettlementReason,
  ResultingStatus,
  TeamSide,
} from "@betstan/common";
import { Schema, model } from "mongoose";

const rowSchema = new Schema({
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
    required: true,
    enum: Object.values(BetKind),
    default: BetKind.PRE_MATCH,
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
  winningSelection: {
    type: String,
    required: false,
    default: "",
  },
  winningSide: {
    type: String,
    required: false,
    enum: Object.values(TeamSide),
  },
  settlementReason: {
    type: String,
    required: false,
    enum: Object.values(LiveSettlementReason),
  },
  settlementSequence: {
    type: Number,
    required: false,
  },
  resultingTimestamp: {
    type: String,
    required: false,
    default: "",
  },
  settlementPublicationState: {
    type: String,
    required: false,
    default: "",
  },
  pendingRemoval: {
    type: Boolean,
    required: false,
    default: false,
  },
  result: {
    type: String,
    required: true,
    enum: Object.values(ResultingStatus),
    default: ResultingStatus.ROW_NO_RESULT,
  },
});

const betSchema = new Schema({
  userId: {
    type: String,
    required: true,
  },
  slipId: {
    type: String,
    required: true,
  },
  betKind: {
    type: String,
    required: true,
    enum: Object.values(BetKind),
    default: BetKind.PRE_MATCH,
  },
  status: {
    type: String,
    required: true,
    enum: Object.values(ResultingStatus),
    default: ResultingStatus.BET_PENDING,
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
  resultingTimestamp: {
    type: String,
    required: false,
    default: "",
  },
  terminalPublicationState: {
    type: String,
    required: false,
    default: "",
  },
  rows: [rowSchema],
});

betSchema.index({ slipId: 1 }, { unique: true });
betSchema.index({
  status: 1,
  "rows.eventId": 1,
  "rows.productName": 1,
  "rows.result": 1,
});
betSchema.index({
  status: 1,
  terminalPublicationState: 1,
  "rows.eventId": 1,
  "rows.productName": 1,
});
betSchema.index({
  status: 1,
  "rows.marketId": 1,
  "rows.marketVersion": 1,
  "rows.result": 1,
});
betSchema.index({
  status: 1,
  terminalPublicationState: 1,
  "rows.marketId": 1,
  "rows.marketVersion": 1,
});

const Bet = model("Bet", betSchema);
const BetArchive = model("BetArchive", betSchema);

export { Bet, BetArchive };
