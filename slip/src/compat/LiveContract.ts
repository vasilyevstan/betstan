import {
  LiveMarketType as PublishedLiveMarketType,
  TeamSide as PublishedTeamSide,
} from "@betstan/common";

// Runtime bridge for additive wire values while service images remain pinned
// to the previously published compatible common package.
export const LiveMarketType = {
  ...PublishedLiveMarketType,
  KICKOFF_TEAM: "KICKOFF_TEAM" as PublishedLiveMarketType,
  FIRST_MINUTE_GOAL: "FIRST_MINUTE_GOAL" as PublishedLiveMarketType,
};
export type LiveMarketType = PublishedLiveMarketType;

export const TeamSide = {
  ...PublishedTeamSide,
  YES: "YES" as PublishedTeamSide,
  NO: "NO" as PublishedTeamSide,
};
export type TeamSide = PublishedTeamSide;
