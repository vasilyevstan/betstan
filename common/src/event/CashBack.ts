import { BetKind } from "./status/BetKind";
import { BetStatus } from "./status/BetStatus";
import { LiveMarketStatus } from "./status/LiveMarketStatus";
import { LiveMarketType } from "./status/LiveMarketType";

/**
 * Integer nominal Stanbucks minor units (1 = 0.01), not wallet money.
 * Validate Number.isSafeInteger and 0 <= value <= Number.MAX_SAFE_INTEGER at
 * boundaries; closed stake, return and a partial's remainder must each be >= 1.
 * This wire alias is not a runtime validator. Never round a legacy wager to fit.
 */
export type CashBackMinorUnits = number;

/** Canonical positive decimal text, not exponent notation or binary-float math. */
export type CashBackDecimalOdds = string;

/** FULL is explicit; its exact amount comes from the subsequently issued quote. */
export type CashBackPortionRequest =
  | { readonly mode: "FULL"; readonly stakeMinor?: never }
  | { readonly mode: "PARTIAL"; readonly stakeMinor: CashBackMinorUnits };

/** Public input. Ownership, canonical identity and prices are server-owned. */
export interface CashBackQuoteRequest {
  readonly action: "QUOTE";
  readonly clientOperationId: string;
  readonly portion: CashBackPortionRequest;
  readonly quoteId?: never;
}

/** Confirm only the stored offer, never a client-supplied price or new amount. */
export interface CashBackConfirmRequest {
  readonly action: "CONFIRM";
  readonly clientOperationId: string;
  readonly quoteId: string;
  readonly portion?: never;
}

export interface CashBackOperationReference {
  readonly clientOperationId: string;
  readonly operationId: string;
  readonly slipId: string;
  readonly betKind: BetKind;
}

/** Internal authenticated binding; never derive userId from the request body. */
export interface CashBackOperationIdentity extends CashBackOperationReference {
  readonly userId: string;
  readonly fingerprint: string;
}

/**
 * A revision covers the authoritative aggregate, not transport delivery order.
 * original = remaining + cumulativeClosed, including after normal settlement.
 * After settlement, remaining is historical principal, NOT active exposure.
 */
export interface CashBackFinancialSnapshot {
  /** Nonnegative safe integer; advance atomically and never wrap or reset. */
  readonly revision: number;
  readonly status: BetStatus;
  readonly originalStakeMinor: CashBackMinorUnits;
  readonly remainingStakeMinor: CashBackMinorUnits;
  readonly cumulativeClosedStakeMinor: CashBackMinorUnits;
  readonly cumulativeReturnMinor: CashBackMinorUnits;
}

interface CashBackSelectionBase {
  readonly slipRowId: string;
  readonly eventId: string;
  readonly productId: string;
  readonly oddsId: string;
}

/** Preserve original IDs. A side or array position is not selection identity. */
export type CashBackSelectionIdentity = CashBackSelectionBase & (
  | {
      readonly betKind: BetKind.PRE_MATCH;
      readonly marketId?: never;
      readonly marketVersion?: never;
      readonly selectionId?: never;
    }
  | {
      readonly betKind: BetKind.LIVE;
      readonly marketId: string;
      readonly marketType: LiveMarketType;
      readonly marketVersion: number;
      readonly selectionId: string;
    }
);

export type CashBackAcceptedSelection = CashBackSelectionIdentity & {
  readonly acceptedOdds: CashBackDecimalOdds;
};

/**
 * Complete validated placement evidence, retained before any void-row pruning.
 * Surviving rows or unknown legacy evidence cannot establish this manifest.
 */
export interface CashBackOriginalManifest {
  readonly fingerprint: string;
  readonly selections: readonly [
    CashBackAcceptedSelection,
    ...CashBackAcceptedSelection[],
  ];
}

/** One exact quote identity owns one validity window, even at unchanged odds. */
export type CashBackSelectionQuote = {
  readonly odds: CashBackDecimalOdds;
  readonly quoteFingerprint: string;
  readonly quoteValidUntil: string;
} & (
  | (Extract<CashBackSelectionIdentity, { betKind: BetKind.PRE_MATCH }> & {
      readonly quoteVersion?: never;
    })
  | (Extract<CashBackSelectionIdentity, { betKind: BetKind.LIVE }> & {
      readonly quoteVersion: number;
      readonly marketStatus: LiveMarketStatus.OPEN;
    })
);

interface CashBackQuoteBase {
  readonly operation: CashBackOperationReference;
  readonly quoteId: string;
  readonly policyVersion: string;
  readonly issuer: "RESULTING";
  /** Immutable database-domain offer time, not IEvent.timestamp. */
  readonly issuedAt: string;
  /** Exclusive, <= issuedAt + 7s and every relevant quote/authority cutoff. */
  readonly expiresAt: string;
  /** Exact before-state; financial.revision is the expected decision revision. */
  readonly financial: CashBackFinancialSnapshot & { readonly status: BetStatus.CONFIRMED };
  readonly closedStakeMinor: CashBackMinorUnits;
  readonly returnMinor: CashBackMinorUnits;
  readonly acceptedCombinedOdds: CashBackDecimalOdds;
  readonly currentCombinedOdds: CashBackDecimalOdds;
}

/** Public offer, not acceptance. Internal source proofs are deliberately absent. */
export type CashBackQuote = CashBackQuoteBase & (
  | { readonly mode: "FULL"; readonly remainingStakeMinorAfter: 0 }
  | { readonly mode: "PARTIAL"; readonly remainingStakeMinorAfter: CashBackMinorUnits }
);

export type CashBackUnavailableReason =
  | "BET_NOT_CONFIRMED"
  | "SELECTION_RESOLVED"
  | "PRE_MATCH_CUTOFF"
  | "MARKET_UNAVAILABLE"
  | "QUOTE_EXPIRED"
  | "QUOTE_CHANGED"
  | "STALE_REVISION"
  | "INVALID_AMOUNT"
  | "LEGACY_PRECISION_UNSUPPORTED"
  | "AUTHORITY_UNAVAILABLE"
  | "OPERATION_CONFLICT"
  | "RESERVATION_DENIED";

interface CashBackReceiptBase {
  readonly decisionId: string;
  /**
   * Same Mongo $$NOW used in the conditional decision and stored receipt.
   * Logical database-domain decision time, NOT physical commit/monotonic time.
   */
  readonly decisionTime: string;
}

/** Immutable winner of the Resulting Bet CAS; a partial does not settle a leg. */
export type CashBackAcceptedReceipt = CashBackReceiptBase & {
  readonly outcome: "ACCEPTED";
} & (
  | {
      readonly mode: "FULL";
      readonly quote: Extract<CashBackQuote, { mode: "FULL" }>;
      readonly financial: CashBackFinancialSnapshot & {
        readonly status: BetStatus.CASH_BACK;
        readonly remainingStakeMinor: 0;
      };
    }
  | {
      readonly mode: "PARTIAL";
      readonly quote: Extract<CashBackQuote, { mode: "PARTIAL" }>;
      readonly financial: CashBackFinancialSnapshot & {
        readonly status: BetStatus.CONFIRMED;
      };
    }
);

/** Rejection/expiry must win the SAME undecided Bet slot as acceptance. */
export interface CashBackRejectedReceipt extends CashBackReceiptBase {
  readonly outcome: "REJECTED";
  readonly operation: CashBackOperationReference;
  readonly quoteId: string;
  readonly expectedRevision: number;
  readonly reason: CashBackUnavailableReason;
  /** Winner's snapshot, including a competing result's terminal state. */
  readonly financial: CashBackFinancialSnapshot;
}

export type CashBackReceipt = CashBackAcceptedReceipt | CashBackRejectedReceipt;

/**
 * Internal reference to the canonical durable Bet receipt, not an independent
 * operation-row decision or a client's assertion. Release validates this exact
 * identity plus the request's operation/fingerprint and participant obligation.
 */
export interface CashBackTerminalDecision {
  readonly issuer: "RESULTING";
  readonly decisionId: string;
  readonly receiptFingerprint: string;
  readonly outcome: "ACCEPTED" | "REJECTED";
  readonly quoteId: string;
  readonly quoteFingerprint: string;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly decisionTime: string;
}

/**
 * Additive normal-settlement evidence. The uncashed principal remains recorded
 * even though terminal active exposure is zero. This is not a payout contract.
 */
export interface CashBackSettlementEvidence {
  readonly settlementId: string;
  readonly occurredAt: string;
  readonly financial: CashBackFinancialSnapshot & {
    readonly status: BetStatus.WIN | BetStatus.LOSS | BetStatus.VOID;
  };
  /** Must equal financial.remainingStakeMinor, never original stake after a partial. */
  readonly settlementBasisStakeMinor: CashBackMinorUnits;
}
