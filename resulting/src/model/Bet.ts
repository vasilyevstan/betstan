import {
  BetKind,
  BetStatus,
  CashBackFinancialSnapshot,
  CashBackOriginalManifest,
  ResultingStatus,
} from "@betstan/common";
import { Schema, model } from "mongoose";
import { cashBackPendingSchema } from "./CashBackOperation";
import {
  LiveMarketType,
  LiveSettlementReason,
  TeamSide,
} from "../compat/LiveContract";

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

const financialSchema = new Schema<CashBackFinancialSnapshot>({
  revision: { type: Number, required: true },
  status: { type: String, enum: Object.values(BetStatus), required: true },
  originalStakeMinor: { type: Number, required: true },
  remainingStakeMinor: { type: Number, required: true },
  cumulativeClosedStakeMinor: { type: Number, required: true },
  cumulativeReturnMinor: { type: Number, required: true },
}, { _id: false });

const manifestSchema = new Schema<CashBackOriginalManifest>({
  fingerprint: { type: String, required: true },
  selections: { type: [Schema.Types.Mixed], required: true },
}, { _id: false });

const betSchema = new Schema({
  cashBackFinancial: { type: financialSchema, required: false },
  cashBackOriginalManifest: { type: manifestSchema, required: false },
  cashBackAnySelectionResolved: { type: Boolean, required: false },
  cashBackUnavailableReason: { type: String, required: false },
  cashBackPending: { type: cashBackPendingSchema, required: false },
  cashBackArchiving: { type: Boolean, required: false },
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
  terminalPublicationClaimedAt: {
    type: Date,
    required: false,
  },
  terminalPublicationClaimId: {
    type: String,
    required: false,
  },
  rows: [rowSchema],
});

betSchema.index({ slipId: 1 }, { unique: true });
betSchema.index({ "cashBackPending.state": 1, "cashBackPending.quote.expiresAt": 1 });
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
