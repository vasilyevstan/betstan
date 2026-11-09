import { BetKind, BetStatus } from "@betstan/common";
import { PipelineStage } from "mongoose";
import { Bet } from "../model/Bet";

export interface ProfileStatsRange {
  from: string | null;
  toExclusive: string | null;
}

export interface ProfileBetStats {
  range: ProfileStatsRange;
  acceptedBets: number;
  wins: number;
  losses: number;
  openBets: number;
  voidedBets: number;
  cashBackBets: number;
  pendingSubmissions: number;
  declinedSubmissions: number;
  totalStaked: string;
  preMatchBets: number;
  liveBets: number;
  singleBets: number;
  accumulatorBets: number;
  favouriteMarket: { name: string; selections: number } | null;
}

type AggregatedStats = Omit<ProfileBetStats, "range" | "acceptedBets" | "favouriteMarket"> & {
  invalidRecords: number;
};
type AggregatedMarket = { _id: string; selections: number };

const stakedStatuses = [BetStatus.CONFIRMED, BetStatus.WIN, BetStatus.LOSS, BetStatus.CASH_BACK];
const countStatus = (status: BetStatus) => ({
  $sum: { $cond: [{ $eq: ["$status", status] }, 1, 0] },
});
const countWhen = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });
const isPreMatch = { $eq: [{ $ifNull: ["$betKind", BetKind.PRE_MATCH] }, BetKind.PRE_MATCH] };
const isLive = { $eq: ["$betKind", BetKind.LIVE] };
const isAccumulator = { $gt: [{ $size: { $ifNull: ["$rows", []] } }, 1] };

export const getProfileBetStats = async (
  userId: string,
  range: ProfileStatsRange
): Promise<ProfileBetStats> => {
  const pipeline: PipelineStage[] = [{ $match: { userId } }];
  if (range.from && range.toExclusive) {
    pipeline.push(
      { $set: { profilePlacedAt: { $toDate: { $ifNull: ["$timestamp", "invalid"] } } } },
      { $match: { profilePlacedAt: { $gte: new Date(range.from), $lt: new Date(range.toExclusive) } } }
    );
  }
  const totals: PipelineStage.FacetPipelineStage[] = [
    {
      $set: {
        profileStake: {
          $cond: [
            { $in: ["$status", stakedStatuses] },
            { $toDecimal: { $toString: "$wager" } },
            0,
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        wins: countStatus(BetStatus.WIN),
        losses: countStatus(BetStatus.LOSS),
        openBets: countStatus(BetStatus.CONFIRMED),
        voidedBets: countStatus(BetStatus.VOID),
        cashBackBets: countStatus(BetStatus.CASH_BACK),
        pendingSubmissions: countStatus(BetStatus.PENDING),
        declinedSubmissions: countStatus(BetStatus.DECLINED),
        preMatchBets: countWhen(isPreMatch),
        liveBets: countWhen(isLive),
        singleBets: countWhen({ $not: [isAccumulator] }),
        accumulatorBets: countWhen(isAccumulator),
        totalStaked: { $sum: "$profileStake" },
        invalidRecords: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $not: [{ $in: ["$status", Object.values(BetStatus)] }] },
                  { $not: [{ $or: [isPreMatch, isLive] }] },
                  {
                    $and: [
                      { $in: ["$status", stakedStatuses] },
                      {
                        $or: [
                          { $eq: ["$profileStake", null] },
                          { $lte: ["$profileStake", 0] },
                          { $in: [{ $toString: "$profileStake" }, ["NaN", "Infinity", "-Infinity"]] },
                        ],
                      },
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $set: { totalStaked: { $toString: "$totalStaked" } } },
  ];
  const markets: PipelineStage.FacetPipelineStage[] = [
    { $unwind: "$rows" },
    { $match: { "rows.productName": { $type: "string", $regex: /\S/ } } },
    { $group: { _id: "$rows.productName", selections: { $sum: 1 } } },
    { $sort: { selections: -1, _id: 1 } },
    { $limit: 1 },
  ];
  pipeline.push({ $facet: { totals, markets } });

  const [result] = await Bet.aggregate<{ totals: AggregatedStats[]; markets: AggregatedMarket[] }>(pipeline);
  const [row] = result?.totals ?? [];
  const [market] = result?.markets ?? [];
  if (row && (row.invalidRecords !== 0 || !/^\d+(?:\.\d+)?(?:E[+-]?\d+)?$/.test(row.totalStaked))) {
    throw new Error("Personal statistics contain invalid records");
  }

  const wins = row?.wins ?? 0;
  const losses = row?.losses ?? 0;
  const openBets = row?.openBets ?? 0;
  const voidedBets = row?.voidedBets ?? 0;
  const cashBackBets = row?.cashBackBets ?? 0;
  return {
    range,
    acceptedBets: wins + losses + openBets + voidedBets + cashBackBets,
    wins,
    losses,
    openBets,
    voidedBets,
    cashBackBets,
    pendingSubmissions: row?.pendingSubmissions ?? 0,
    declinedSubmissions: row?.declinedSubmissions ?? 0,
    totalStaked: row?.totalStaked ?? "0",
    preMatchBets: row?.preMatchBets ?? 0,
    liveBets: row?.liveBets ?? 0,
    singleBets: row?.singleBets ?? 0,
    accumulatorBets: row?.accumulatorBets ?? 0,
    favouriteMarket: market ? { name: market._id, selections: market.selections } : null,
  };
};
