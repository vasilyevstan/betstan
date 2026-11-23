import {
  assertBetAccountingEvidence, BetAccountingEvidence, BetAccountingMovement,
  BetAccountingUnavailableReason, BetPayoutBound, fixedOddsReturnMinor,
  IPlaceBetEvent, nominalStakeMinor, parseMarketBet, ResultingStatus,
} from "@betstan/common";
import { canonicalOdds } from "./cashBackPricing";
import { cashBackHash } from "./cashBackIdentity";
import { placementAccountingScope, RetainedAccountingScope } from "./accountingScope";

export interface AccountingBasis {
  originalStakeMinor: number;
  placementFingerprint: string;
  /** One factor per row: a Builder is one composite exposure. */
  rows: { id: string; odds: string }[];
}
export type AccountingPlacementTerms = Pick<IPlaceBetEvent["data"], "wager" | "betKind"> & {
  rows: Pick<IPlaceBetEvent["data"]["rows"][number],
    "id" | "eventId" | "productId" | "oddsId" | "oddsValue" | "betKind"
    | "marketId" | "marketType" | "marketVersion" | "quoteVersion" | "selectionId"
    | "side" | "selectedAt" | "quoteValidUntil" | "marketBet">[];
};
export interface AccountingClosureState {
  accounting: BetAccountingEvidence;
  accountingRevision?: number;
  accountingCumulativeReturnMinor?: number;
  accountingLastMovement?: BetAccountingMovement;
  accountingPrefixTruncated?: boolean;
}
// This bounds evidence, never the number of cash-back operations. Scalar
// movements remain durable and recoverable in the source-owned movement export.
const MAX_PREFIX_BYTES = 128 * 1024;

export const unavailableAccounting = (
  reason: BetAccountingUnavailableReason = "HISTORY_MISSING"
): BetAccountingEvidence => ({ schemaVersion: 1, status: "UNAVAILABLE", reason });

function unavailable(error: unknown): BetAccountingEvidence {
  const reason = error instanceof Error ? error.message : "";
  return unavailableAccounting(
    reason === "LEGACY_PRECISION_UNSUPPORTED" || reason === "AMOUNT_UNSUPPORTED"
      ? reason : "AUTHORITY_UNAVAILABLE"
  );
}

/** Financial terms only: the caller must establish identity and closure history. */
export function accountingPlacementBasis(
  data: AccountingPlacementTerms,
  placementFingerprint: string
): {
  accountingBasis: AccountingBasis; accountingPayoutBound: BetPayoutBound;
  accountingScope?: RetainedAccountingScope;
} {
  const originalStakeMinor = nominalStakeMinor(data.wager);
  if (!/^[0-9a-f]{64}$/.test(placementFingerprint) || !data.rows.length
    || new Set(data.rows.map(row => row.id)).size !== data.rows.length) {
    throw new Error("AUTHORITY_UNAVAILABLE");
  }
  const rows = data.rows.map(row => {
    if (!row.id) throw new Error("AUTHORITY_UNAVAILABLE");
    if (row.marketBet !== undefined) {
      const quote = parseMarketBet(row.marketBet);
      if (quote.odds !== row.oddsValue || quote.eventId !== row.eventId) throw new Error("AUTHORITY_UNAVAILABLE");
    }
    return { id: row.id, odds: canonicalOdds(row.oddsValue) };
  });
  const maximumReturnMinor = fixedOddsReturnMinor(originalStakeMinor, rows.map(row => row.odds));
  const facts = placementAccountingScope(data);
  return {
    accountingBasis: { originalStakeMinor, placementFingerprint, rows },
    ...(facts ? { accountingScope: { schemaVersion: 1 as const, placementFingerprint, facts } } : {}),
    accountingPayoutBound: {
      schemaVersion: 1, method: "STANDALONE_FIXED_ODDS",
      originalStakeMinor, maximumReturnMinor, placementFingerprint,
    },
  };
}

export function accountingPlacementState(data: IPlaceBetEvent["data"]): {
  accounting: BetAccountingEvidence; accountingBasis?: AccountingBasis; accountingPayoutBound?: BetPayoutBound;
  accountingScope?: RetainedAccountingScope;
} {
  try {
    // Fingerprint excludes publisher envelope metadata, includes exact placement content.
    const placementFingerprint = cashBackHash(data);
    return {
      accounting: { schemaVersion: 1, status: "COMPLETE", movements: [] },
      ...accountingPlacementBasis(data, placementFingerprint),
    };
  } catch (error) {
    return { accounting: unavailable(error) };
  }
}

interface AccountingBet {
  slipId: string;
  userId: string;
  accounting?: BetAccountingEvidence;
  accountingBasis?: AccountingBasis;
  accountingRemovedVoidRowIds?: readonly string[] | null;
  accountingRevision?: number | null;
  accountingCumulativeReturnMinor?: number | null;
  accountingLastMovement?: BetAccountingMovement;
  accountingPrefixTruncated?: boolean | null;
  accountingTimeUnavailable?: boolean | null;
  cashBackFinancial?: { remainingStakeMinor: number; cumulativeClosedStakeMinor: number; cumulativeReturnMinor: number } | null;
}

/** Legacy/corrupt accounting must not manufacture credit or veto old settlement. */
export function accountingEvidenceForBet(
  bet: Pick<AccountingBet, "slipId" | "userId" | "accounting" | "accountingRevision"
    | "accountingCumulativeReturnMinor" | "accountingLastMovement">, terminal = false
): BetAccountingEvidence {
  if (!bet.accounting) return unavailableAccounting();
  try {
    assertBetAccountingEvidence(bet.accounting);
    if (bet.accounting.status === "COMPLETE") {
      const items = bet.accounting.movements;
      if (items.some(item => item.slipId !== bet.slipId || item.userId !== bet.userId)
        || (bet.accountingRevision != null && bet.accountingRevision !== items.length)
        || (bet.accountingCumulativeReturnMinor != null && (
          !Number.isSafeInteger(bet.accountingCumulativeReturnMinor)
          || BigInt(bet.accountingCumulativeReturnMinor) !== items.reduce((sum, item) => sum + BigInt(item.returnMinor), BigInt(0))))
        || (bet.accountingLastMovement && cashBackHash(bet.accountingLastMovement) !== cashBackHash(items[items.length - 1]))
        || (terminal && (!items.length || items[items.length - 1].remainingStakeMinor !== 0))) {
        throw new Error("AUTHORITY_UNAVAILABLE");
      }
    }
    return bet.accounting;
  } catch {
    return unavailableAccounting("AUTHORITY_UNAVAILABLE");
  }
}

/** Validate continuity against the cash-back authority without treating its snapshot as payout. */
function prefix(bet: AccountingBet): {
  basis: AccountingBasis; movements: readonly BetAccountingMovement[]; remaining: number;
  revision: number; cumulativeReturn: number; complete: boolean;
} {
  assertBetAccountingEvidence(bet.accounting);
  if (!bet.accountingBasis || (bet.accounting.status !== "COMPLETE" && !bet.accountingPrefixTruncated)) {
    throw new Error("AUTHORITY_UNAVAILABLE");
  }
  const basis = bet.accountingBasis;
  const complete = bet.accounting.status === "COMPLETE";
  const movements = bet.accounting.status === "COMPLETE" ? bet.accounting.movements : [];
  const last = complete ? movements[movements.length - 1] : bet.accountingLastMovement;
  const revision = bet.accountingRevision ?? movements.length;
  const prefixReturn = Number(movements.reduce((total, movement) => total + BigInt(movement.returnMinor), BigInt(0)));
  const cumulativeReturn = bet.accountingCumulativeReturnMinor
    ?? prefixReturn;
  if (![revision, cumulativeReturn, basis.originalStakeMinor].every(value => Number.isSafeInteger(value) && value >= 0)
    || revision !== (last?.revision ?? 0) || (!complete && !last)
    || (complete && prefixReturn !== cumulativeReturn)) throw new Error("AUTHORITY_UNAVAILABLE");
  if (last && (last.slipId !== bet.slipId || last.userId !== bet.userId
    || last.placementFingerprint !== basis.placementFingerprint || last.originalStakeMinor !== basis.originalStakeMinor)) {
    throw new Error("AUTHORITY_UNAVAILABLE");
  }
  const remaining = last?.remainingStakeMinor ?? basis.originalStakeMinor;
  if (bet.cashBackFinancial) {
    if (bet.cashBackFinancial.remainingStakeMinor !== remaining
      || bet.cashBackFinancial.cumulativeClosedStakeMinor !== basis.originalStakeMinor - remaining
      || bet.cashBackFinancial.cumulativeReturnMinor !== cumulativeReturn) throw new Error("AUTHORITY_UNAVAILABLE");
  }
  return { basis, movements, remaining, revision, cumulativeReturn, complete };
}

export function accountingClosureState(
  bet: AccountingBet, source: BetAccountingMovement["source"],
  closedStakeMinor: number, returnMinor: number, occurredAt: string
): AccountingClosureState {
  if (!bet.accounting) return { accounting: unavailableAccounting() };
  if (bet.accounting.status === "UNAVAILABLE" && !bet.accountingPrefixTruncated) return { accounting: bet.accounting };
  try {
    const before = prefix(bet);
    const { basis, movements, remaining } = before;
    const revision = before.revision + 1;
    const movement: BetAccountingMovement = {
      schemaVersion: 1, movementId: `${bet.slipId}:accounting:${revision}`,
      slipId: bet.slipId, userId: bet.userId, revision, occurredAt,
      closedStakeMinor, returnMinor, remainingStakeMinor: remaining - closedStakeMinor,
      originalStakeMinor: basis.originalStakeMinor, source,
      placementFingerprint: basis.placementFingerprint,
    };
    const cumulativeReturn = BigInt(before.cumulativeReturn) + BigInt(returnMinor);
    if (![revision, closedStakeMinor, returnMinor, remaining, movement.remainingStakeMinor]
      .every(value => Number.isSafeInteger(value) && value >= 0)
      || closedStakeMinor === 0 || cumulativeReturn > BigInt(Number.MAX_SAFE_INTEGER)
      || (source === "SETTLEMENT" && movement.remainingStakeMinor !== 0)
      || new Date(occurredAt).toISOString() !== occurredAt) throw new Error("AMOUNT_UNSUPPORTED");
    const evidence: BetAccountingEvidence = { schemaVersion: 1, status: "COMPLETE", movements: [...movements, movement] };
    const truncated = !before.complete || Buffer.byteLength(JSON.stringify(evidence)) > MAX_PREFIX_BYTES;
    if (!truncated) assertBetAccountingEvidence(evidence);
    return {
      accounting: truncated ? unavailableAccounting("HISTORY_MISSING") : evidence,
      accountingRevision: revision, accountingCumulativeReturnMinor: Number(cumulativeReturn),
      accountingLastMovement: movement, accountingPrefixTruncated: truncated,
    };
  } catch (error) {
    return { accounting: unavailable(error) };
  }
}

export function appendAccountingMovement(
  bet: AccountingBet, source: BetAccountingMovement["source"], closed: number, returned: number, occurredAt: string
): BetAccountingEvidence {
  return accountingClosureState(bet, source, closed, returned, occurredAt).accounting;
}

export function terminalAccountingState(
  bet: AccountingBet, status: ResultingStatus, rows: readonly { id: string; result: string; oddsValue: number }[],
  occurredAt: string
): AccountingClosureState {
  if (bet.accountingTimeUnavailable) return { accounting: unavailableAccounting("HISTORY_MISSING") };
  if (!bet.accounting) return { accounting: unavailableAccounting() };
  if (bet.accounting.status === "UNAVAILABLE" && !bet.accountingPrefixTruncated) return { accounting: bet.accounting };
  try {
    const { basis, remaining } = prefix(bet);
    const factors: string[] = [];
    if (![ResultingStatus.BET_WIN, ResultingStatus.BET_LOSS, ResultingStatus.BET_VOID].includes(status)) {
      throw new Error("AUTHORITY_UNAVAILABLE");
    }
    const ids = new Set(rows.map(row => row.id));
    if (ids.size !== rows.length || basis.rows.some(row =>
      !ids.has(row.id) && !bet.accountingRemovedVoidRowIds?.includes(row.id))) {
      throw new Error("AUTHORITY_UNAVAILABLE");
    }
    if ((status === ResultingStatus.BET_WIN && !rows.some(row => row.result === ResultingStatus.ROW_WIN))
      || (status === ResultingStatus.BET_VOID && rows.some(row => row.result !== ResultingStatus.ROW_VOID))
      || (status === ResultingStatus.BET_LOSS && !rows.some(row => row.result === ResultingStatus.ROW_LOSS))) {
      throw new Error("AUTHORITY_UNAVAILABLE");
    }
    for (const row of rows) {
      const accepted = basis.rows.find(item => item.id === row.id);
      if (!accepted || canonicalOdds(row.oddsValue) !== accepted.odds) throw new Error("AUTHORITY_UNAVAILABLE");
      if (row.result === ResultingStatus.ROW_WIN) factors.push(accepted.odds);
      else if (row.result !== ResultingStatus.ROW_VOID && status !== ResultingStatus.BET_LOSS) throw new Error("AUTHORITY_UNAVAILABLE");
    }
    // Voids remove one ROW factor, never Builder internal selections. Loss pays zero.
    const returnMinor = status === ResultingStatus.BET_LOSS ? 0 : fixedOddsReturnMinor(remaining, factors);
    return accountingClosureState(bet, "SETTLEMENT", remaining, returnMinor, occurredAt);
  } catch (error) {
    return { accounting: unavailable(error) };
  }
}

export function terminalAccounting(
  bet: AccountingBet, status: ResultingStatus, rows: readonly { id: string; result: string; oddsValue: number }[], occurredAt: string
): BetAccountingEvidence {
  return terminalAccountingState(bet, status, rows, occurredAt).accounting;
}

/** Same Mongo $$NOW as canonical acceptance receipt, not a pre-read application clock. */
export function cashBackAccountingFields(
  bet: AccountingBet, closedStakeMinor: number, returnMinor: number, mongoTime: Record<string, unknown>
): Record<string, unknown> {
  const state = accountingClosureState(bet, "CASH_BACK", closedStakeMinor, returnMinor, "1970-01-01T00:00:00.000Z");
  const evidence = state.accounting;
  const fields = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, { $literal: value }]));
  const movement = state.accountingLastMovement
    ? { $mergeObjects: [{ $literal: state.accountingLastMovement }, { occurredAt: mongoTime }] } : undefined;
  const accounting = evidence.status !== "COMPLETE" ? { $literal: evidence } : {
    schemaVersion: 1, status: "COMPLETE",
    movements: { $concatArrays: [
      { $literal: evidence.movements.slice(0, -1) },
      [movement],
    ] },
  };
  return { ...fields, accounting, "cashBackPending.accounting": accounting,
    ...(movement ? { accountingLastMovement: movement, "cashBackPending.accountingMovement": movement } : {}) };
}
