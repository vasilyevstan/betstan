import { EventStatus, EventVisibility } from "@betstan/common";
import { Schema, model } from "mongoose";

const eventSchema = new Schema({
  eventId: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: true,
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
  visibility: {
    type: String,
    required: true,
    enum: Object.values(EventVisibility),
    default: EventVisibility.ONLINE,
  },
  creationRequestId: {
    type: String,
    required: false,
    select: false,
  },
  creationRequestFingerprint: {
    type: String,
    required: false,
    select: false,
  },
  newEventPublicationPending: {
    type: Boolean,
    required: false,
    select: false,
  },
  resultPublicationPending: {
    type: Boolean,
    required: false,
    select: false,
  },
  visibilityPublicationPending: {
    type: Boolean,
    required: false,
    select: false,
  },
  visibilityPublicationTarget: {
    type: String,
    required: false,
    enum: Object.values(EventVisibility),
    select: false,
  },
});

eventSchema.index({ eventId: 1 }, { unique: true });
eventSchema.index({ creationRequestId: 1 }, { unique: true, sparse: true });

const Event = model("Event", eventSchema);

export { Event };
