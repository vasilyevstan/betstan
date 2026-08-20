import { EventStatus, EventVisibility } from "@betstan/common";
import { Schema, model } from "mongoose";

const eventSchema = new Schema({
  eventId: {
    type: String,
    required: true,
  },
  home: {
    type: String,
    required: false,
  },
  away: {
    type: String,
    required: false,
  },
  source: {
    type: String,
    required: false,
    enum: ["SCHEDULER", "EXTERNAL"],
  },
  slotKey: {
    type: String,
    required: false,
  },
  newEventPublishedAt: {
    type: Date,
    required: false,
    default: null,
  },
  newEventPublishAttempts: {
    type: Number,
    required: false,
    default: 0,
  },
  newEventPublishClaimedAt: {
    type: Date,
    required: false,
    default: null,
  },
  newEventPublishClaimToken: {
    type: String,
    required: false,
    default: null,
  },
  name: {
    type: String,
    required: true,
  },
  time: {
    type: Date,
    required: true,
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
  products: [
    new Schema({
      id: {
        type: String,
        required: true,
      },
      type: {
        type: String,
        required: true,
      },
      name: {
        type: String,
        required: true,
      },
      odds: [
        new Schema({
          id: {
            type: String,
            required: true,
          },
          name: {
            type: String,
            required: true,
          },
          value: {
            type: Number,
            required: true,
          },
        }),
      ],
    }),
  ],
});

eventSchema.index({ eventId: 1 }, { unique: true });
eventSchema.index(
  { slotKey: 1 },
  {
    unique: true,
    partialFilterExpression: { slotKey: { $type: "string" } },
    name: "event_slot_key_unique",
  }
);

const Event = model("Event", eventSchema);

export { Event };
