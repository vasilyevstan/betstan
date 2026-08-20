import { IEvent } from "./IEvent";
import { BettingStatus } from "./status/BettingStatus";
import { EventPhase } from "./status/EventPhase";
import { LiveIncidentType } from "./status/LiveIncidentType";
import { LiveMarketStatus } from "./status/LiveMarketStatus";
import { LiveMarketType } from "./status/LiveMarketType";
import { LiveSettlementReason } from "./status/LiveSettlementReason";
import { TeamSide } from "./status/TeamSide";

export interface ILiveScore {
  home: number;
  away: number;
}

export interface ILiveIncident {
  type: LiveIncidentType;
  side?: TeamSide;
  occurredAt?: string;
  minute?: number;
  addedTime?: number;
  teamLabel?: string;
}

export interface ILiveMarketSelection {
  selectionId: string;
  side: TeamSide;
  odds: number;
  label?: string;
}

export interface ILiveMarketSnapshot {
  marketId: string;
  marketType: LiveMarketType;
  marketVersion: number;
  quoteVersion: number;
  quoteValidUntil?: string;
  status: LiveMarketStatus;
  selections: ILiveMarketSelection[];
}

export interface ILiveMarketSettlement {
  marketId: string;
  marketVersion: number;
  settlementReason: LiveSettlementReason;
  settlementSequence: number;
  winningSide: TeamSide;
  winningSelection?: string;
}

export type LiveMarket = ILiveMarketSnapshot;
export type LiveMarketSelection = ILiveMarketSelection;
export type LiveMarketSettlement = ILiveMarketSettlement;

/**
 * Consumers replace event state only when this per-event sequence is strictly
 * greater than the last applied sequence. Market settlements are identified by
 * marketId and marketVersion; quoteVersion is never part of that identity.
 */
export interface ILiveEventUpdateEvent extends IEvent {
  data: {
    eventId: string;
    sequence: number;
    occurredAt: string;
    kickoffAt: string;
    minute: number;
    addedTime?: number;
    phase: EventPhase;
    homeScore: number;
    awayScore: number;
    scores?: ILiveScore;
    bettingStatus: BettingStatus;
    incident?: ILiveIncident;
    markets: ILiveMarketSnapshot[];
    settlements: ILiveMarketSettlement[];
    eventName?: string;
    home?: string;
    away?: string;
    homeTeam?: string;
    awayTeam?: string;
  };
}
