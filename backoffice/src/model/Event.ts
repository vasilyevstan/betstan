import { CashBackSourceReply, EventStatus, EventVisibility } from "@betstan/common";
import { Schema, model } from "mongoose";

export interface BackofficeCashBackHold {
  requestFingerprint: string;
  grant: Extract<CashBackSourceReply, { outcome: "GRANTED" }>;
}

const cashBackHoldSchema = new Schema<BackofficeCashBackHold>({
  requestFingerprint: { type: String, required: true },
  grant: { type: Schema.Types.Mixed, required: true },
}, { _id: false });

const eventSchema = new Schema({
  cashBackGeneration: { type: Number, required: false, select: false },
  cashBackAuthorityRevision: { type: Number, required: false, select: false },
  cashBackAuthorityAt: { type: Date, required: false, select: false },
  cashBackFenceAt: { type: Date, required: false, select: false },
  cashBackHold: { type: cashBackHoldSchema, required: false, select: false },
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
