import { Schema, model } from "mongoose";
import {
  LiveMarketType,
  LiveSettlementReason,
  TeamSide,
} from "../compat/LiveContract";

const liveSettlementLedgerSchema = new Schema({
  eventId: {
    type: String,
    required: true,
  },
  occurredAt: {
    type: String,
    required: true,
  },
  marketId: {
    type: String,
    required: true,
  },
  marketType: {
    type: String,
    required: false,
    enum: Object.values(LiveMarketType),
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
    default: "",
  },
});

liveSettlementLedgerSchema.index(
  { marketId: 1, marketVersion: 1 },
  { unique: true }
);
liveSettlementLedgerSchema.index({ occurredAt: 1, settlementSequence: 1 });

const LiveSettlementLedger = model(
  "LiveSettlementLedger",
  liveSettlementLedgerSchema
);

export default LiveSettlementLedger;
