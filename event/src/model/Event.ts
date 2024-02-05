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

const Event = model("Event", eventSchema);

export { Event };
