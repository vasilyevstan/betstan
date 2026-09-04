import {
  LiveMarketType as PublishedLiveMarketType,
  LiveSettlementReason as PublishedLiveSettlementReason,
  TeamSide as PublishedTeamSide,
} from "@betstan/common";

// Runtime bridge for additive wire values while service images remain pinned
// to the previously published compatible common package.
export const LiveMarketType = {
  ...PublishedLiveMarketType,
  KICKOFF_TEAM: "KICKOFF_TEAM" as PublishedLiveMarketType,
  FIRST_MINUTE_GOAL: "FIRST_MINUTE_GOAL" as PublishedLiveMarketType,
  NEXT_THROW_IN: "NEXT_THROW_IN" as PublishedLiveMarketType,
  NEXT_FREE_KICK: "NEXT_FREE_KICK" as PublishedLiveMarketType,
  NEXT_GOAL_KICK: "NEXT_GOAL_KICK" as PublishedLiveMarketType,
  SECOND_HALF_SCORE: "SECOND_HALF_SCORE" as PublishedLiveMarketType,
};
export type LiveMarketType = PublishedLiveMarketType;

export const LiveSettlementReason = {
  ...PublishedLiveSettlementReason,
  KICK_OFF: "KICK_OFF" as PublishedLiveSettlementReason,
  FIRST_MINUTE_GOAL:
    "FIRST_MINUTE_GOAL" as PublishedLiveSettlementReason,
  SECOND_HALF_SCORE:
    "SECOND_HALF_SCORE" as PublishedLiveSettlementReason,
};
export type LiveSettlementReason = PublishedLiveSettlementReason;

export const TeamSide = {
  ...PublishedTeamSide,
  YES: "YES" as PublishedTeamSide,
  NO: "NO" as PublishedTeamSide,
};
export type TeamSide = PublishedTeamSide;
