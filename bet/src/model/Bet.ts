import { Schema, model } from "mongoose";
import { BetStatus, SlipRowStatus } from "@betstan/common";

const betSchema = new Schema({
  userId: {
    type: String,
    required: true,
  },
  userName: {
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
    enum: Object.values(BetStatus),
    default: BetStatus.PENDING,
  },
  wager: {
    type: Number,
    required: true,
  },
  timestamp: {
    type: String,
    required: true,
  },
  rows: [
    new Schema({
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
      status: {
        type: String,
        required: true,
        enum: Object.values(SlipRowStatus),
        default: SlipRowStatus.NOT_SETTLED,
      },
      timestamp: {
        type: String,
        required: true,
      },
      id: {
        type: String,
        required: true,
      },
    }),
  ],
});

const Bet = model("Bet", betSchema);

export { Bet };
