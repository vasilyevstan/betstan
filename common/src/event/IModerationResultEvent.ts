import { IEvent } from "./IEvent";
import { BetKind } from "./status/BetKind";
import { LiveMarketStatus } from "./status/LiveMarketStatus";
import { ModerationDeclineReason } from "./status/ModerationDeclineReason";

export type ModerationDecisionReasonCode =
  | ModerationDeclineReason
  | "INPUT_INTEGRITY"
  | "RISK_MIN_STAKE"
  | "RISK_MAX_STAKE"
  | "RISK_MIN_ODDS"
  | "RISK_MAX_ODDS"
  | "RISK_MAX_RETURN"
  | "RISK_MAX_NET_WIN"
  | "RISK_PRE_KICKOFF_CUTOFF_MS"
  | "RISK_MAX_QUOTE_AGE_MS"
  | "RISK_MAX_LEGS"
  | "RISK_MAX_EVENTS"
  | "RISK_MAX_BUILDER_SELECTIONS"
  | "RISK_DENY"
  | "RISK_MAX_SUBMISSIONS"
  | "RISK_MAX_TURNOVER"
  | "RISK_MAX_OPEN_STAKE"
  | "RISK_MAX_OPEN_RETURN"
  | "RISK_MAX_OPERATOR_EXPOSURE"
  | "RISK_MAX_CUSTOMER_LOSS"
  | "RISK_REPEAT_BET_COOLDOWN_MS"
  | "RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE"
  | "RISK_EVIDENCE_CAPACITY_UNAVAILABLE"
  | "RISK_EVIDENCE_UNAVAILABLE"
  | "RISK_EVENT_RESULTED"
  | "RISK_STALE_QUOTE"
  | "RISK_EVENT_STARTED"
  | "RISK_CURRENT_SOURCE_UNSAFE";

/** New risk decisions supply all fields; legacy events may omit the metadata. */
export interface ModerationDecisionMetadata {
  readonly decisionId: string;
  /** Persisted economic decision time, not broker publication time. */
  readonly occurredAt: string;
  readonly policyRevision: number;
  readonly placementFingerprint: string;
  readonly reasonCodes: readonly ModerationDecisionReasonCode[];
}

export interface IModerationAffectedRow {
  rowId: string;
  declineReason: ModerationDeclineReason;
  marketId?: string;
  marketVersion?: number;
  quoteVersion?: number;
  currentOdds?: number;
  marketStatus?: LiveMarketStatus;
  selectionId?: string;
}

export interface IModerationResultEvent extends IEvent {
  data: Partial<ModerationDecisionMetadata> & {
    slipId: string;
    result: string;
    betKind?: BetKind;
    declineReason?: ModerationDeclineReason;
    affectedRows?: IModerationAffectedRow[];
  };
}
