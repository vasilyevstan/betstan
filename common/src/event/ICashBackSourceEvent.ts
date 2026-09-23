import { IEvent } from "./IEvent";
import {
  CashBackOperationIdentity,
  CashBackSelectionIdentity,
  CashBackSelectionQuote,
  CashBackTerminalDecision,
} from "./CashBack";
import { BetKind } from "./status/BetKind";
import { BettingStatus } from "./status/BettingStatus";
import { EventPhase } from "./status/EventPhase";
import { EventStatus } from "./status/EventStatus";
import { EventVisibility } from "./status/EventVisibility";

export type CashBackSourceOwner = "BACKOFFICE" | "GAMEMASTER";

export interface CashBackSourceParticipant {
  readonly owner: CashBackSourceOwner;
  readonly eventId: string;
}

interface CashBackSourceEvidenceBase {
  readonly eventId: string;
  readonly authorityFingerprint: string;
  /** Immutable source-domain authority time, never a publisher envelope time. */
  readonly occurredAt: string;
  readonly kickoffAt: string;
  /** null explicitly means no additional timed cutoff at THIS owner, not unknown. */
  readonly cutoffAt: string | null;
}

/**
 * Eligible, non-archived authority with no pending change intent. Each owner
 * proves only its own authority; Backoffice cannot attest Gamemaster prices.
 * No seed, persisted simulation timeline or future outcome belongs here.
 */
export type CashBackSourceEvidence = CashBackSourceEvidenceBase & (
  | {
      readonly owner: "BACKOFFICE";
      readonly lifecycle: {
        readonly status: EventStatus.NO_RESULT;
        readonly visibility: EventVisibility;
      };
      readonly quoteEvidence: { readonly kind: "LIFECYCLE_ONLY" };
    }
  | {
      readonly owner: "GAMEMASTER";
      readonly lifecycle: {
        readonly status: EventStatus.NO_RESULT;
        readonly phase: Exclude<EventPhase, EventPhase.FULL_TIME>;
        readonly bettingStatus: BettingStatus.OPEN;
        readonly sequence: number;
      };
      readonly quoteEvidence:
        | { readonly kind: "PRE_MATCH_STATIC" }
        | {
            readonly kind: "LIVE";
            readonly quotes: readonly [
              Extract<CashBackSelectionQuote, { betKind: BetKind.LIVE }>,
              ...Extract<CashBackSelectionQuote, { betKind: BetKind.LIVE }>[],
            ];
          };
    }
);

/** A non-reserving observation of an empty hold at generation b. */
export interface CashBackSourceSnapshot {
  readonly baseGeneration: number;
  readonly observedAt: string;
  readonly evidence: CashBackSourceEvidence;
}

interface CashBackSourceRequestBase {
  /** Persist this exact participant obligation BEFORE publication; retry unchanged. */
  readonly requestId: string;
  readonly operation: CashBackOperationIdentity;
  readonly participant: CashBackSourceParticipant;
  readonly requestedAt: string;
}

export interface CashBackSourceSnapshotRequest extends CashBackSourceRequestBase {
  readonly action: "SNAPSHOT";
  /** All original selections for this event, including identities of pruned rows. */
  readonly selections: readonly [CashBackSelectionIdentity, ...CashBackSelectionIdentity[]];
}

export interface CashBackSourceReserveRequest extends CashBackSourceRequestBase {
  readonly action: "RESERVE";
  readonly expected: CashBackSourceSnapshot;
  readonly quote: {
    readonly quoteId: string;
    readonly quoteFingerprint: string;
    readonly expectedRevision: number;
    readonly originalManifestFingerprint: string;
  };
  /** Predetermined expected.baseGeneration + 1, not learned only from a reply. */
  readonly grantedGeneration: number;
  /** Exclusive decision deadline, NOT an expiring hold/lease. */
  readonly deadline: string;
}

export interface CashBackSourceReleaseRequest extends CashBackSourceRequestBase {
  readonly action: "RELEASE";
  /** The original RESERVE obligation; release has its own stable requestId. */
  readonly reserveRequestId: string;
  readonly baseGeneration: number;
  /** Predetermined b + 1, required even when the grant acknowledgement was lost. */
  readonly grantedGeneration: number;
  readonly decision: CashBackTerminalDecision;
}

export type CashBackSourceRequest =
  | CashBackSourceSnapshotRequest
  | CashBackSourceReserveRequest
  | CashBackSourceReleaseRequest;

/** Resulting -> source owners; deliberately cash-back-specific, not generic RPC. */
export interface ICashBackSourceRequestEvent extends IEvent {
  data: CashBackSourceRequest;
}

export type CashBackSourceDenialReason =
  | "MISSING"
  | "ARCHIVED"
  | "RESOLVED"
  | "SUSPENDED"
  | "UNKNOWN_AUTHORITY"
  | "AUTHORITY_CHANGE_PENDING"
  | "AUTHORITY_CHANGED"
  | "QUOTE_CHANGED"
  | "DEADLINE_REACHED"
  | "CONTENDED"
  | "GENERATION_CONFLICT"
  | "GENERATION_EXHAUSTED"
  | "INVALID_DECISION"
  | "PROTOCOL_ERROR";

/**
 * Source -> Resulting. Exact echoed requests are correlation/binding evidence,
 * not new requests. Validate every echoed field, owner and event.
 */
export type CashBackSourceReply =
  | {
      readonly outcome: "SNAPSHOT";
      readonly request: CashBackSourceSnapshotRequest;
      readonly snapshot: CashBackSourceSnapshot;
    }
  | {
      readonly outcome: "GRANTED";
      readonly request: CashBackSourceReserveRequest;
      /** Persisted b + 1. An exact retry replays this grant without extending time. */
      readonly grantedGeneration: number;
      readonly decisionTime: string;
      readonly evidence: CashBackSourceEvidence;
    }
  | {
      readonly outcome: "RELEASED";
      readonly request: CashBackSourceReleaseRequest;
      /** Matching b + 1 hold was removed atomically, leaving generation b + 2. */
      readonly fenceGeneration: number;
      readonly decisionTime: string;
    }
  | {
      readonly outcome: "FENCED";
      readonly request: CashBackSourceReleaseRequest;
      /** b + 2: cancellation-before-reserve or an already-consumed generation. */
      readonly fenceGeneration: number;
      /** >= fenceGeneration. A DIFFERENT, newer hold may still exist unchanged. */
      readonly observedGeneration: number;
      readonly observedAt: string;
    }
  | {
      readonly outcome: "DENIED";
      readonly request: CashBackSourceRequest;
      readonly reason: CashBackSourceDenialReason;
      readonly observedAt: string;
    };

export interface ICashBackSourceReplyEvent extends IEvent {
  data: CashBackSourceReply;
}
