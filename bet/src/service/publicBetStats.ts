import { createHash } from "crypto";
import { PipelineStage } from "mongoose";
import { Bet } from "../model/Bet";

// Keep the public scoreboard bounded even if bet history keeps growing.
export const PUBLIC_SCOREBOARD_LIMIT = 100;
export const LEGACY_PUBLIC_SCOREBOARD_LIMIT = 500;

export interface PublicBetStatsRow {
  userKey: string;
  displayName: string;
  betCount: number;
  wagerTotal: number;
}

export interface AggregatedBetStatsRow {
  _id: string;
  betCount: number;
  wagerTotal: number;
}

interface LegacyBetStatsSourceRow {
  userId: string;
  wager: unknown;
}

export interface LegacyPublicBetStatsRow {
  userId: string;
  userName: string;
  wager: number;
}

const PUBLIC_USER_KEY_LENGTH = 12;
const PUBLIC_DISPLAY_SUFFIX_LENGTH = 6;

const normalizeWagerExpression = {
  $let: {
    vars: {
      wagerNumber: {
        $convert: {
          input: "$wager",
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
    },
    in: {
      $cond: [{ $gte: ["$$wagerNumber", 0] }, "$$wagerNumber", 0],
    },
  },
};

export const createPublicUserKey = (userId: string) =>
  createHash("sha256")
    .update(userId)
    .digest("hex")
    .slice(0, PUBLIC_USER_KEY_LENGTH);

export const createPublicDisplayName = (userKey: string) =>
  `Player ${userKey.slice(-PUBLIC_DISPLAY_SUFFIX_LENGTH).toUpperCase()}`;

const toPublicStatsRow = (
  aggregateRow: AggregatedBetStatsRow
): PublicBetStatsRow => {
  const userKey = createPublicUserKey(aggregateRow._id);

  return {
    userKey,
    displayName: createPublicDisplayName(userKey),
    betCount: aggregateRow.betCount,
    wagerTotal: aggregateRow.wagerTotal,
  };
};

export const buildPublicBetStatsPipeline = (): PipelineStage[] => [
  {
    $match: {
      userId: {
        $type: "string",
        $ne: "",
      },
    },
  },
  {
    $group: {
      _id: "$userId",
      betCount: { $sum: 1 },
      wagerTotal: { $sum: normalizeWagerExpression },
    },
  },
  {
    $sort: {
      betCount: -1 as const,
      wagerTotal: -1 as const,
      _id: 1 as const,
    },
  },
  {
    $limit: PUBLIC_SCOREBOARD_LIMIT,
  },
];

export const buildLegacyPublicBetStatsPipeline = (): PipelineStage[] => [
  {
    $match: {
      userId: {
        $type: "string",
        $ne: "",
      },
    },
  },
  {
    $sort: {
      timestamp: -1 as const,
      _id: -1 as const,
    },
  },
  {
    $limit: LEGACY_PUBLIC_SCOREBOARD_LIMIT,
  },
  {
    $project: {
      _id: 0,
      userId: 1,
      wager: normalizeWagerExpression,
    },
  },
];

export const getPublicBetStats = async (): Promise<PublicBetStatsRow[]> => {
  const aggregatedRows = await Bet.aggregate<AggregatedBetStatsRow>(
    buildPublicBetStatsPipeline()
  );

  return aggregatedRows.map(toPublicStatsRow);
};

export const getLegacyPublicBetStats = async (): Promise<
  LegacyPublicBetStatsRow[]
> => {
  const rows = await Bet.aggregate<LegacyBetStatsSourceRow>(
    buildLegacyPublicBetStatsPipeline()
  );

  return rows.map((row) => {
    const userId = createPublicUserKey(row.userId);

    return {
      userId,
      userName: createPublicDisplayName(userId),
      wager: typeof row.wager === "number" && Number.isFinite(row.wager)
        ? row.wager
        : 0,
    };
  });
};
