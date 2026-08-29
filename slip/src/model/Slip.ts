import {
  BetKind,
  LiveMarketStatus,
  ModerationDeclineReason,
  SlipStatus,
} from "@betstan/common";
import { Schema, Types, model } from "mongoose";
import { LiveMarketType, TeamSide } from "../compat/LiveContract";
import { SlipPublicationState } from "./SlipPublicationState";

const SLIP_DRAFT_UNIQUE_INDEX_NAME = "slip_draft_unique_by_kind";
const SLIP_DRAFT_UNIQUE_INDEX_KEYS = {
  userId: 1,
  status: 1,
  draftKey: 1,
} as const;
const SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER = {
  status: SlipStatus.DRAFT,
  draftKey: {
    $type: "string",
  },
} as const;

const affectedRowSchema = new Schema(
  {
    rowId: {
      type: String,
      required: true,
    },
    declineReason: {
      type: String,
      required: true,
      enum: Object.values(ModerationDeclineReason),
    },
    marketId: {
      type: String,
    },
    marketVersion: {
      type: Number,
    },
    quoteVersion: {
      type: Number,
    },
    currentOdds: {
      type: Number,
    },
    marketStatus: {
      type: String,
      enum: Object.values(LiveMarketStatus),
    },
    selectionId: {
      type: String,
    },
  },
  { _id: false }
);

const slipRowSchema = new Schema({
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
  eventTime: {
    type: String,
  },
  betKind: {
    type: String,
    enum: Object.values(BetKind),
    default: BetKind.PRE_MATCH,
  },
  marketId: {
    type: String,
  },
  marketType: {
    type: String,
    enum: Object.values(LiveMarketType),
  },
  marketVersion: {
    type: Number,
  },
  quoteVersion: {
    type: Number,
  },
  selectionId: {
    type: String,
  },
  side: {
    type: String,
    enum: Object.values(TeamSide),
  },
  selectedAt: {
    type: String,
  },
  quoteValidUntil: {
    type: String,
  },
  moderation: affectedRowSchema,
});

const submittedSlipRowSchema = new Schema(
  {
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
    id: {
      type: String,
      required: true,
    },
    eventTime: {
      type: String,
    },
    betKind: {
      type: String,
      enum: Object.values(BetKind),
      default: BetKind.PRE_MATCH,
    },
    marketId: {
      type: String,
    },
    marketType: {
      type: String,
      enum: Object.values(LiveMarketType),
    },
    marketVersion: {
      type: Number,
    },
    quoteVersion: {
      type: Number,
    },
    selectionId: {
      type: String,
    },
    side: {
      type: String,
      enum: Object.values(TeamSide),
    },
    selectedAt: {
      type: String,
    },
    quoteValidUntil: {
      type: String,
    },
  },
  { _id: false }
);

const submittedEventSchema = new Schema(
  {
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
    submittedAt: {
      type: String,
    },
    placementAttemptId: {
      type: String,
    },
    wager: {
      type: Number,
      required: true,
    },
    rows: {
      type: [submittedSlipRowSchema],
      default: [],
    },
    betKind: {
      type: String,
      enum: Object.values(BetKind),
      default: BetKind.PRE_MATCH,
    },
  },
  { _id: false }
);

const publicationSchema = new Schema(
  {
    state: {
      type: String,
      enum: Object.values(SlipPublicationState),
      required: true,
    },
    attemptCount: {
      type: Number,
      required: true,
      default: 0,
    },
    nextAttemptAt: {
      type: String,
    },
    leaseOwner: {
      type: String,
    },
    leaseUntil: {
      type: String,
    },
    lastAttemptAt: {
      type: String,
    },
    heartbeatAt: {
      type: String,
    },
    lastError: {
      type: String,
    },
    publishedAt: {
      type: String,
    },
    exhaustedAt: {
      type: String,
    },
  },
  { _id: false }
);

const legacyBoardConfirmationSchema = new Schema(
  {
    sessionScope: {
      type: String,
      required: true,
    },
    boardRevision: {
      type: Number,
      required: true,
    },
    boardFingerprint: {
      type: String,
      required: true,
    },
    confirmedAt: {
      type: String,
      required: true,
    },
  },
  { _id: false }
);

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
  betKind: {
    type: String,
    enum: Object.values(BetKind),
    default: BetKind.PRE_MATCH,
  },
  draftKey: {
    type: String,
    enum: Object.values(BetKind),
    default: BetKind.PRE_MATCH,
  },
  timestamp: {
    type: String,
    required: true,
  },
  submittedAt: {
    type: String,
  },
  declineReason: {
    type: String,
    enum: Object.values(ModerationDeclineReason),
  },
  sourceSlipId: {
    type: String,
  },
  replacementSlipId: {
    type: String,
  },
  boardRevision: {
    type: Number,
    default: 1,
  },
  boardFingerprint: {
    type: String,
    default: () => new Types.ObjectId().toHexString(),
  },
  legacyBoardRevision: {
    type: Number,
  },
  legacyBoardFingerprint: {
    type: String,
  },
  legacyBoardConfirmedAt: {
    type: String,
  },
  legacyBoardConfirmations: {
    type: [legacyBoardConfirmationSchema],
    default: undefined,
    select: false,
  },
  submittedEvent: submittedEventSchema,
  publication: publicationSchema,
  rows: [slipRowSchema],
});

slipSchema.index({ sourceSlipId: 1 }, { sparse: true });

slipSchema.pre("validate", function (next) {
  this.set("draftKey", this.get("betKind") ?? BetKind.PRE_MATCH);

  const currentBoardRevision = this.get("boardRevision");
  if (!Number.isInteger(currentBoardRevision) || currentBoardRevision < 1) {
    this.set("boardRevision", 1);
  }

  const currentBoardFingerprint = this.get("boardFingerprint");
  if (
    typeof currentBoardFingerprint !== "string"
    || currentBoardFingerprint.trim().length === 0
  ) {
    this.set("boardFingerprint", new Types.ObjectId().toHexString());
  }

  next();
});

const Slip = model("Slip", slipSchema);
const SlipArchive = model("SlipArchive", slipSchema);

export {
  Slip,
  SlipArchive,
  SLIP_DRAFT_UNIQUE_INDEX_NAME,
  SLIP_DRAFT_UNIQUE_INDEX_KEYS,
  SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
};
