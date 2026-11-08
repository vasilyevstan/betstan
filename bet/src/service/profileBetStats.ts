import { BetStatus } from "@betstan/common";
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
}

type AggregatedStats = Omit<ProfileBetStats, "range" | "acceptedBets"> & {
  invalidRecords: number;
};

const stakedStatuses = [BetStatus.CONFIRMED, BetStatus.WIN, BetStatus.LOSS, BetStatus.CASH_BACK];
const countStatus = (status: BetStatus) => ({
  $sum: { $cond: [{ $eq: ["$status", status] }, 1, 0] },
});

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
  pipeline.push(
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
        totalStaked: { $sum: "$profileStake" },
        invalidRecords: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $not: [{ $in: ["$status", Object.values(BetStatus)] }] },
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
    { $set: { totalStaked: { $toString: "$totalStaked" } } }
  );

  const [row] = await Bet.aggregate<AggregatedStats>(pipeline);
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
  };
};
