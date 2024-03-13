import { EventStatus, EventVisibility } from "@betstan/common";
import { Schema, model } from "mongoose";

const eventSchema = new Schema({
  eventId: {
    type: String,
    required: true,
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
});

const Event = model("Event", eventSchema);

export { Event };
