export const ENGINE_VERSION = 1 as const;

export const EventPhase = {
  PRE_MATCH: "PRE_MATCH",
  FIRST_HALF: "FIRST_HALF",
  FIRST_HALF_STOPPAGE: "FIRST_HALF_STOPPAGE",
  HALF_TIME: "HALF_TIME",
  SECOND_HALF: "SECOND_HALF",
  SECOND_HALF_STOPPAGE: "SECOND_HALF_STOPPAGE",
  FULL_TIME: "FULL_TIME",
} as const;
export type EventPhase = (typeof EventPhase)[keyof typeof EventPhase];

export const BettingStatus = {
  OPEN: "OPEN",
  SUSPENDED: "SUSPENDED",
  CLOSED: "CLOSED",
} as const;
export type BettingStatus =
  (typeof BettingStatus)[keyof typeof BettingStatus];

export const TeamSide = {
  HOME: "HOME",
  AWAY: "AWAY",
  DRAW: "DRAW",
  NONE: "NONE",
  YES: "YES",
  NO: "NO",
} as const;
export type TeamSide = (typeof TeamSide)[keyof typeof TeamSide];
export type CompetingSide = typeof TeamSide.HOME | typeof TeamSide.AWAY;

export const LiveIncidentType = {
  KICK_OFF: "KICK_OFF",
  GOAL: "GOAL",
  YELLOW_CARD: "YELLOW_CARD",
  RED_CARD: "RED_CARD",
  FREE_KICK: "FREE_KICK",
  CORNER: "CORNER",
  PENALTY_AWARDED: "PENALTY_AWARDED",
  PENALTY_SCORED: "PENALTY_SCORED",
  PENALTY_MISSED: "PENALTY_MISSED",
  ADDED_TIME_ANNOUNCED: "ADDED_TIME_ANNOUNCED",
  HALF_TIME: "HALF_TIME",
  SECOND_HALF_KICK_OFF: "SECOND_HALF_KICK_OFF",
  FULL_TIME: "FULL_TIME",
  FIRST_MINUTE_ELAPSED: "FIRST_MINUTE_ELAPSED",
} as const;
export type LiveIncidentType =
  (typeof LiveIncidentType)[keyof typeof LiveIncidentType];

export const LiveMarketType = {
  NEXT_YELLOW_CARD: "NEXT_YELLOW_CARD",
  NEXT_RED_CARD: "NEXT_RED_CARD",
  NEXT_CORNER: "NEXT_CORNER",
  NEXT_PENALTY: "NEXT_PENALTY",
  HALF_TIME_RESULT: "HALF_TIME_RESULT",
  KICKOFF_TEAM: "KICKOFF_TEAM",
  FIRST_MINUTE_GOAL: "FIRST_MINUTE_GOAL",
} as const;
export type LiveMarketType =
  (typeof LiveMarketType)[keyof typeof LiveMarketType];
export type NextMarketType =
  | typeof LiveMarketType.NEXT_YELLOW_CARD
  | typeof LiveMarketType.NEXT_RED_CARD
  | typeof LiveMarketType.NEXT_CORNER
  | typeof LiveMarketType.NEXT_PENALTY;
export type PreKickoffMarketType =
  | typeof LiveMarketType.KICKOFF_TEAM
  | typeof LiveMarketType.FIRST_MINUTE_GOAL;

export const LiveMarketStatus = {
  OPEN: "OPEN",
  SUSPENDED: "SUSPENDED",
  SETTLED: "SETTLED",
  CLOSED: "CLOSED",
} as const;
export type LiveMarketStatus =
  (typeof LiveMarketStatus)[keyof typeof LiveMarketStatus];

export const LiveSettlementReason = {
  INCIDENT: "INCIDENT",
  HALF_TIME: "HALF_TIME",
  FULL_TIME_NONE: "FULL_TIME_NONE",
  MANUAL_VOID: "MANUAL_VOID",
  KICK_OFF: "KICK_OFF",
  FIRST_MINUTE_GOAL: "FIRST_MINUTE_GOAL",
} as const;
export type LiveSettlementReason =
  (typeof LiveSettlementReason)[keyof typeof LiveSettlementReason];

export interface TeamProfile {
  attack?: number;
  discipline?: number;
}

export interface IncidentRates {
  goals: number;
  yellows: number;
  reds: number;
  corners: number;
  penaltyAwards: number;
  freeKicks: number;
  penaltyScoreProbability: number;
}

export interface IncidentCaps {
  goals: number;
  yellows: number;
  reds: number;
  corners: number;
  penaltyAwards: number;
  freeKicks: number;
}

export interface StoppageRange {
  min: number;
  max: number;
}

export interface StoppageConfig {
  first: StoppageRange;
  second: StoppageRange;
}

export interface SimulationConfig {
  durationMs: number;
  rateScale: number;
  rates: IncidentRates;
  caps: IncidentCaps;
  stoppage: StoppageConfig;
  penaltyOutcomeDelaySeconds: number;
  marketMargin: number;
  minOdds: number;
  maxOdds: number;
}

export interface SimulationConfigOverride {
  durationMs?: number;
  rateScale?: number;
  rates?: Partial<IncidentRates>;
  caps?: Partial<IncidentCaps>;
  stoppage?: Partial<{
    first: Partial<StoppageRange>;
    second: Partial<StoppageRange>;
  }>;
  penaltyOutcomeDelaySeconds?: number;
  marketMargin?: number;
  minOdds?: number;
  maxOdds?: number;
}

export interface SimIncident {
  id: string;
  type: LiveIncidentType;
  side?: CompetingSide;
  penaltyId?: string;
  linkedIncidentId?: string;
}

export interface SimTimelineEntry {
  offsetMs: number;
  phase: EventPhase;
  minute: number;
  addedTime?: number;
  incident: SimIncident;
  order: number;
}

export interface SimTimeline {
  engineVersion: typeof ENGINE_VERSION;
  eventId: string;
  seed: string | number;
  durationMs: number;
  stoppage: {
    first: number;
    second: number;
  };
  config: SimulationConfig;
  pricing?: {
    attackFactor: number;
    disciplineFactor: number;
    homeAttackShare: number;
    homeDisciplineShare: number;
  };
  entries: SimTimelineEntry[];
}

export interface LiveScore {
  home: number;
  away: number;
}

export interface LiveMarketSelection {
  selectionId: string;
  side: TeamSide;
  odds: number;
}

export interface LiveMarketSnapshot {
  marketId: string;
  marketType: LiveMarketType;
  marketVersion: number;
  quoteVersion: number;
  status: LiveMarketStatus;
  selections: LiveMarketSelection[];
}

export interface LiveMarketSettlement {
  marketId: string;
  marketVersion: number;
  settlementReason: LiveSettlementReason;
  settlementSequence: number;
  winningSide: TeamSide;
  winningSelection: string;
}

export interface SimulationTransition {
  eventId: string;
  sequence: number;
  offsetMs: number;
  minute: number;
  addedTime?: number;
  phase: EventPhase;
  homeScore: number;
  awayScore: number;
  scores: LiveScore;
  bettingStatus: BettingStatus;
  incident: SimIncident;
  markets: LiveMarketSnapshot[];
  settlements: LiveMarketSettlement[];
}

export interface SimulationResult {
  engineVersion: typeof ENGINE_VERSION;
  timeline: SimTimeline;
  transitions: SimulationTransition[];
  finalScore: LiveScore;
}

export interface SimulateMatchInput {
  eventId: string;
  seed: string | number;
  homeProfile?: TeamProfile;
  awayProfile?: TeamProfile;
  config?: SimulationConfigOverride;
}
