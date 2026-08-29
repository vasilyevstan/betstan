import {
  BetKind,
  BetStatus,
  LiveMarketStatus,
  ModerationDeclineReason,
  SlipRowStatus,
} from "@betstan/common";
import { HydratedDocument, Schema, model } from "mongoose";
import {
  LiveMarketType,
  LiveSettlementReason,
  TeamSide,
} from "../compat/LiveContract";

export interface BetRowRecord {
  id: string;
  eventId: string;
  eventName: string;
  oddsId: string;
  oddsValue: number;
  oddsName: string;
  productName: string;
  productId: string;
  status: SlipRowStatus;
  timestamp: string;
  winningSelection?: string;
  eventTime?: string;
  betKind?: BetKind;
  marketId?: string;
  marketType?: LiveMarketType;
  marketVersion?: number;
  quoteVersion?: number;
  selectionId?: string;
  side?: TeamSide;
  selectedAt?: string;
  quoteValidUntil?: string;
  winningSide?: TeamSide;
  settlementReason?: LiveSettlementReason;
  settlementSequence?: number;
  declineReason?: ModerationDeclineReason;
  marketStatus?: LiveMarketStatus;
  currentOdds?: number;
}

export interface BetRecord {
  userId: string;
  userName: string;
  slipId: string;
  status: BetStatus;
  wager: number;
  timestamp: string;
  betKind?: BetKind;
  declineReason?: ModerationDeclineReason;
  rows: BetRowRecord[];
}

export type BetDocument = HydratedDocument<BetRecord>;

type SerializedBet = Partial<BetRecord> & {
  rows?: Array<Partial<BetRowRecord> & Record<string, unknown>>;
} & Record<string, unknown>;

const betRowSchema = new Schema<BetRowRecord>({
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
  status: {
    type: String,
    required: true,
    enum: Object.values(SlipRowStatus),
    default: SlipRowStatus.NOT_SETTLED,
  },
  timestamp: {
    type: String,
    required: true,
  },
  winningSelection: {
    type: String,
    required: false,
    default: "",
  },
  id: {
    type: String,
    required: true,
  },
  eventTime: {
    type: String,
    required: false,
  },
  betKind: {
    type: String,
    required: false,
    enum: Object.values(BetKind),
    default: BetKind.PRE_MATCH,
  },
  marketId: {
    type: String,
    required: false,
  },
  marketType: {
    type: String,
    required: false,
    enum: Object.values(LiveMarketType),
  },
  marketVersion: {
    type: Number,
    required: false,
  },
  quoteVersion: {
    type: Number,
    required: false,
  },
  selectionId: {
    type: String,
    required: false,
  },
  side: {
    type: String,
    required: false,
    enum: Object.values(TeamSide),
  },
  selectedAt: {
    type: String,
    required: false,
  },
  quoteValidUntil: {
    type: String,
    required: false,
  },
  winningSide: {
    type: String,
    required: false,
    enum: Object.values(TeamSide),
  },
  settlementReason: {
    type: String,
    required: false,
    enum: Object.values(LiveSettlementReason),
  },
  settlementSequence: {
    type: Number,
    required: false,
  },
  declineReason: {
    type: String,
    required: false,
    enum: Object.values(ModerationDeclineReason),
  },
  marketStatus: {
    type: String,
    required: false,
    enum: Object.values(LiveMarketStatus),
  },
  currentOdds: {
    type: Number,
    required: false,
  },
});

const betSchema = new Schema<BetRecord>(
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
    status: {
      type: String,
      required: true,
      enum: Object.values(BetStatus),
      default: BetStatus.PENDING,
    },
    wager: {
      type: Number,
      required: true,
    },
    timestamp: {
      type: String,
      required: true,
    },
    betKind: {
      type: String,
      required: false,
      enum: Object.values(BetKind),
      default: BetKind.PRE_MATCH,
    },
    declineReason: {
      type: String,
      required: false,
      enum: Object.values(ModerationDeclineReason),
    },
    rows: [betRowSchema],
  },
  // Moderation/settlement consumers (ModerationResultListener,
  // SettleSlipListener, SettleSlipRowListener, PendingBetUpdateWorker) all
  // load-mutate-save this document concurrently. Optimistic concurrency
  // makes a stale `save()` fail with a VersionError instead of silently
  // overwriting a terminal status written by a concurrent consumer; callers
  // must reload the fresh document and reapply their guarded/idempotent
  // mutation on conflict (see betHistory.saveBetWithOptimisticRetry).
  { optimisticConcurrency: true }
);

const normalizeSerializedBet = (record: SerializedBet) => {
  const betKind = record.betKind ?? BetKind.PRE_MATCH;
  record.betKind = betKind;
  record.rows = (record.rows ?? []).map((row) => ({
    ...row,
    betKind: row.betKind ?? betKind,
    winningSelection: row.winningSelection ?? "",
  }));
};

betSchema.set("toJSON", {
  transform: (_doc, ret) => {
    normalizeSerializedBet(ret as SerializedBet);
    return ret;
  },
});

betSchema.set("toObject", {
  transform: (_doc, ret) => {
    normalizeSerializedBet(ret as SerializedBet);
    return ret;
  },
});

betSchema.index({ slipId: 1 }, { unique: true });

const Bet = model<BetRecord>("Bet", betSchema);

export { Bet };
