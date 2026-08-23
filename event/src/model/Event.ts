import {
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
  LiveIncidentType,
  LiveMarketStatus,
  LiveMarketType,
  TeamSide,
} from "@betstan/common";
import { Schema, model } from "mongoose";

const liveIncidentSchema = new Schema(
  {
    id: {
      type: String,
      required: false,
    },
    relatedIncidentId: {
      type: String,
      required: false,
    },
    type: {
      type: String,
      required: true,
      enum: Object.values(LiveIncidentType),
    },
    side: {
      type: String,
      required: false,
      enum: Object.values(TeamSide),
    },
    occurredAt: {
      type: String,
      required: false,
    },
    minute: {
      type: Number,
      required: false,
    },
    addedTime: {
      type: Number,
      required: false,
    },
  },
  { _id: false }
);

const liveMarketSelectionSchema = new Schema(
  {
    selectionId: {
      type: String,
      required: true,
    },
    side: {
      type: String,
      required: true,
      enum: Object.values(TeamSide),
    },
    odds: {
      type: Number,
      required: true,
    },
  },
  { _id: false }
);

const liveMarketSchema = new Schema(
  {
    marketId: {
      type: String,
      required: true,
    },
    marketType: {
      type: String,
      required: true,
      enum: Object.values(LiveMarketType),
    },
    marketVersion: {
      type: Number,
      required: true,
    },
    quoteVersion: {
      type: Number,
      required: true,
    },
    quoteValidUntil: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(LiveMarketStatus),
    },
    selections: {
      type: [liveMarketSelectionSchema],
      required: true,
      default: [],
    },
  },
  { _id: false }
);

const liveStateSchema = new Schema(
  {
    sequence: {
      type: Number,
      required: true,
    },
    occurredAt: {
      type: String,
      required: true,
    },
    kickoffAt: {
      type: String,
      required: true,
    },
    minute: {
      type: Number,
      required: true,
    },
    addedTime: {
      type: Number,
      required: false,
    },
    phase: {
      type: String,
      required: true,
      enum: Object.values(EventPhase),
    },
    homeScore: {
      type: Number,
      required: true,
    },
    awayScore: {
      type: Number,
      required: true,
    },
    bettingStatus: {
      type: String,
      required: true,
      enum: Object.values(BettingStatus),
    },
    incidentHistory: {
      type: [liveIncidentSchema],
      required: true,
      default: [],
    },
    currentMarkets: {
      type: [liveMarketSchema],
      required: true,
      default: [],
    },
  },
  { _id: false }
);

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
  visibilityInitialized: {
    type: Boolean,
    required: false,
  },
  eventMetadataInitialized: {
    type: Boolean,
    required: false,
  },
  pendingVisibility: {
    type: String,
    required: false,
    enum: Object.values(EventVisibility),
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
  live: {
    type: liveStateSchema,
    required: false,
    default: null,
  },
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
