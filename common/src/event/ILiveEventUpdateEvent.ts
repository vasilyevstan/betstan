import { IEvent } from "./IEvent";
import { BettingStatus } from "./status/BettingStatus";
import { EventPhase } from "./status/EventPhase";
import { LiveIncidentType } from "./status/LiveIncidentType";
import { LiveMarketStatus } from "./status/LiveMarketStatus";
import { LiveMarketType } from "./status/LiveMarketType";
import { LiveSettlementReason } from "./status/LiveSettlementReason";
import { TeamSide } from "./status/TeamSide";

export interface ILiveIncident {
  id?: string;
  relatedIncidentId?: string;
  type: LiveIncidentType;
  side?: TeamSide;
  occurredAt?: string;
  minute?: number;
  addedTime?: number;
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
  /** When absent, the quote has no time-based expiry. */
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
    bettingStatus: BettingStatus;
    /**
     * Legacy single-incident field kept for existing consumers. New publishers
     * should also provide `incidents` with the complete history through this
     * sequence so snapshot consumers can rebuild state without replay bursts.
     */
    incident?: ILiveIncident;
    /** Complete incident history through `sequence`, ordered oldest -> newest. */
    incidents?: ILiveIncident[];
    /**
     * Producer attestation that `incidents` is the authoritative cumulative
     * incident list through this sequence, with no older items omitted.
     */
    incidentsComplete?: boolean;
    markets: ILiveMarketSnapshot[];
    settlements: ILiveMarketSettlement[];
    eventName?: string;
    home?: string;
    away?: string;
  };
}
