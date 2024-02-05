import { SlipStatus } from "@betstan/common";
import { Schema, model } from "mongoose";

const slipSchema = new Schema({
  userId: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    required: true,
    enum: Object.values(SlipStatus),
    default: SlipStatus.DRAFT,
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
      timestamp: {
        type: String,
        required: true,
      },
    }),
  ],
});

const Slip = model("Slip", slipSchema);

export { Slip };
