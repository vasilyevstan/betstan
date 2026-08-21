import { EventStatus } from "@betstan/common";
import { Schema, model } from "mongoose";
import { liveStateFields } from "./liveStateFields";

const eventSchema = new Schema({
  eventId: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: false,
  },
  time: {
    type: Date,
    required: true,
  },
  home: {
    type: String,
    required: true,
  },
  away: {
    type: String,
    required: true,
  },
  homeResult: {
    type: Number,
    required: false,
  },
  awayResult: {
    type: Number,
    required: false,
  },
  status: {
    type: String,
    required: true,
    enum: Object.values(EventStatus),
    default: EventStatus.NO_RESULT,
  },
  ...liveStateFields,
});

eventSchema.index({ eventId: 1 }, { unique: true });

const Event = model("Event", eventSchema);

export { Event };
