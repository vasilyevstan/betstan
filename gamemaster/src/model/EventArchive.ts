import { EventStatus } from "@betstan/common";
import { Schema, model } from "mongoose";
import { liveStateFields } from "./liveStateFields";

const eventArchiveSchema = new Schema({
  eventId: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: false,
  },
  time: {
    type: String,
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

const EventArchive = model("EventArchive", eventArchiveSchema);

export { EventArchive };
