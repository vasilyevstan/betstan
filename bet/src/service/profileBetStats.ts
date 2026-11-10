import { BetKind, BetStatus, SlipRowStatus } from "@betstan/common";
import { PipelineStage } from "mongoose";
import { TeamSide } from "../compat/LiveContract";
import { Bet } from "../model/Bet";
import { getScoreboardRank, ScoreboardRank } from "./publicBetStats";

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
  favouriteTeam: { name: string; selections: number } | null;
  bestWinningPick: { odds: number; eventName: string; pick: string; market: string } | null;
  recentResults: RecentResult[];
  scoreboardRank: ScoreboardRank | null;
}

export interface RecentResult {
  result: BetStatus.WIN | BetStatus.LOSS;
  placedAt: string | null;
  selections: number;
  eventName: string | null;
  pick: string | null;
}

export const RECENT_RESULTS_LIMIT = 5;
// Teams are generated per event, so one pick is not yet a favourite.
export const FAVOURITE_TEAM_MIN_SELECTIONS = 2;
// Picking a team to be booked is not backing it.
const NON_BACKING_MARKETS = ["NEXT_YELLOW_CARD", "NEXT_RED_CARD"];

type AggregatedStats = Omit<
  ProfileBetStats,
  "range" | "acceptedBets" | "favouriteMarket" | "favouriteTeam" | "bestWinningPick" | "recentResults" | "scoreboardRank"
> & {
  invalidRecords: number;
};
type AggregatedMarket = { _id: string; selections: number };
type AggregatedPick = { odds: number; eventName: unknown; pick: unknown; market: unknown };
type AggregatedRecent = {
  result: BetStatus.WIN | BetStatus.LOSS;
  placedAt: Date | null;
  selections: number;
  first: { eventName?: unknown; oddsName?: unknown } | null;
};
type AggregatedProfile = {
  totals: AggregatedStats[];
  markets: AggregatedMarket[];
  teams: AggregatedMarket[];
  best: AggregatedPick[];
  recent: AggregatedRecent[];
};

const stakedStatuses = [BetStatus.CONFIRMED, BetStatus.WIN, BetStatus.LOSS, BetStatus.CASH_BACK];
const countStatus = (status: BetStatus) => ({
  $sum: { $cond: [{ $eq: ["$status", status] }, 1, 0] },
});
const countWhen = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });
const isPreMatch = { $eq: [{ $ifNull: ["$betKind", BetKind.PRE_MATCH] }, BetKind.PRE_MATCH] };
const isLive = { $eq: ["$betKind", BetKind.LIVE] };
const isAccumulator = { $gt: [{ $size: { $ifNull: ["$rows", []] } }, 1] };
const text = (value: unknown) => (typeof value === "string" ? value : "");

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
  // Event names are "Home - Away"; a pick backs a team by side (live) or by naming it (1X2).
  const teams: PipelineStage.FacetPipelineStage[] = [
    { $unwind: "$rows" },
    { $match: { "rows.eventName": { $type: "string" }, "rows.productName": { $nin: NON_BACKING_MARKETS } } },
    { $set: { profileTeams: { $split: ["$rows.eventName", " - "] } } },
    { $match: { profileTeams: { $size: 2 } } },
    {
      $set: {
        profileTeam: {
          $trim: {
            input: {
              $switch: {
                branches: [
                  { case: { $eq: ["$rows.side", TeamSide.HOME] }, then: { $arrayElemAt: ["$profileTeams", 0] } },
                  { case: { $eq: ["$rows.side", TeamSide.AWAY] }, then: { $arrayElemAt: ["$profileTeams", 1] } },
                  {
                    case: {
                      $and: [
                        { $eq: [{ $ifNull: ["$rows.side", null] }, null] },
                        { $in: ["$rows.oddsName", "$profileTeams"] },
                      ],
                    },
                    then: "$rows.oddsName",
                  },
                ],
                default: "",
              },
            },
          },
        },
      },
    },
    { $match: { profileTeam: { $regex: /\S/ } } },
    { $group: { _id: "$profileTeam", selections: { $sum: 1 } } },
    { $match: { selections: { $gte: FAVOURITE_TEAM_MIN_SELECTIONS } } },
    { $sort: { selections: -1, _id: 1 } },
    { $limit: 1 },
  ];
  const best: PipelineStage.FacetPipelineStage[] = [
    { $match: { status: { $nin: [BetStatus.PENDING, BetStatus.DECLINED] } } },
    { $unwind: "$rows" },
    { $match: { "rows.status": SlipRowStatus.WIN, "rows.oddsValue": { $type: "number", $gt: 1, $lt: Infinity } } },
    { $sort: { "rows.oddsValue": -1, timestamp: -1, _id: -1 } },
    { $limit: 1 },
    {
      $project: {
        _id: 0, odds: { $toDouble: "$rows.oddsValue" }, eventName: "$rows.eventName", pick: "$rows.oddsName", market: "$rows.productName",
      },
    },
  ];
  const recent: PipelineStage.FacetPipelineStage[] = [
    { $match: { status: { $in: [BetStatus.WIN, BetStatus.LOSS] } } },
    { $set: { profileRecentAt: { $convert: { input: "$timestamp", to: "date", onError: null, onNull: null } } } },
    { $sort: { profileRecentAt: -1, _id: -1 } },
    { $limit: RECENT_RESULTS_LIMIT },
    {
      $project: {
        _id: 0,
        result: "$status",
        placedAt: "$profileRecentAt",
        selections: { $size: { $ifNull: ["$rows", []] } },
        first: { $ifNull: [{ $arrayElemAt: ["$rows", 0] }, null] },
      },
    },
  ];
  pipeline.push({ $facet: { totals, markets, teams, best, recent } });

  const [[result], scoreboardRank] = await Promise.all([
    Bet.aggregate<AggregatedProfile>(pipeline),
    getScoreboardRank(userId),
  ]);
  const [row] = result?.totals ?? [];
  const [market] = result?.markets ?? [];
  const [team] = result?.teams ?? [];
  const [pick] = result?.best ?? [];
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
    favouriteTeam: team ? { name: team._id, selections: team.selections } : null,
    bestWinningPick: pick
      ? { odds: pick.odds, eventName: text(pick.eventName), pick: text(pick.pick), market: text(pick.market) }
      : null,
    recentResults: (result?.recent ?? []).map(({ result: outcome, placedAt, selections, first }) => ({
      result: outcome,
      placedAt: placedAt instanceof Date && Number.isFinite(placedAt.getTime()) ? placedAt.toISOString() : null,
      selections,
      eventName: selections === 1 ? text(first?.eventName) || null : null,
      pick: selections === 1 ? text(first?.oddsName) || null : null,
    })),
    scoreboardRank,
  };
};
