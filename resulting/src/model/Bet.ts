import { ResultingStatus } from "@betstan/common";
import { Schema, model } from "mongoose";

const betSchema = new Schema({
  userId: {
    type: String,
    required: true,
  },
  slipId: {
    type: String,
    required: true,
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
  rows: [
    new Schema({
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
      resultingTimestamp: {
        type: String,
        required: false,
        default: "",
      },
      result: {
        type: String,
        required: true,
        enum: Object.values(ResultingStatus),
        default: ResultingStatus.ROW_NO_RESULT,
      },
    }),
  ],
});

const Bet = model("Bet", betSchema);
const BetArchive = model("BetArchive", betSchema);

export { Bet, BetArchive };
