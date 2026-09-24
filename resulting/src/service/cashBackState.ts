import { createHash } from "crypto";
import {
  BetKind, BetStatus, CashBackAcceptedSelection, CashBackFinancialSnapshot,
  CashBackOriginalManifest, CashBackUnavailableReason, IPlaceBetEvent,
  ResultingStatus,
} from "@betstan/common";
import { Bet } from "../model/Bet";
import { canonicalOdds, CashBackUnavailable, originalStakeMinor, validateFinancialSnapshot } from "./cashBackPricing";

export type CashBackBet = ReturnType<typeof Bet.hydrate>;

export const cashBackHash = (value: unknown): string => {
  const stable = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input) ?? "null";
    if (Array.isArray(input)) return `[${input.map(stable).join(",")}]`;
    return `{${Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  };
  return createHash("sha256").update(stable(value)).digest("hex");
};

export const publicBetStatus = (status: ResultingStatus): BetStatus => {
  switch (status) {
    case ResultingStatus.BET_PENDING: return BetStatus.PENDING;
    case ResultingStatus.BET_APPROVED: return BetStatus.CONFIRMED;
    case ResultingStatus.BET_DECLINED: return BetStatus.DECLINED;
    case ResultingStatus.BET_WIN: return BetStatus.WIN;
    case ResultingStatus.BET_LOSS: return BetStatus.LOSS;
    case ResultingStatus.BET_VOID: return BetStatus.VOID;
    case ResultingStatus.BET_CASH_BACK: return BetStatus.CASH_BACK;
    default: throw new Error("Invalid Resulting parent status");
  }
};

export const mongoDecisionTime = {
  $dateToString: { date: "$$NOW", format: "%Y-%m-%dT%H:%M:%S.%LZ", timezone: "UTC" },
};
export const cashBackBeforeDeadline = {
  $lt: ["$$NOW", { $toDate: "$cashBackPending.quote.expiresAt" }],
};
export const cashBackAtOrAfterDeadline = {
  $gte: ["$$NOW", { $toDate: "$cashBackPending.quote.expiresAt" }],
};

export const cashBackPlacementState = (data: IPlaceBetEvent["data"]): {
  cashBackFinancial?: CashBackFinancialSnapshot;
  cashBackOriginalManifest?: CashBackOriginalManifest;
  cashBackAnySelectionResolved?: boolean;
  cashBackUnavailableReason?: CashBackUnavailableReason;
} => {
  try {
    const principal = originalStakeMinor(data.wager);
    const selections: CashBackAcceptedSelection[] = [];
    const ids = new Set<string>();
    const kind = data.betKind ?? (data.rows.some(row => row.betKind === BetKind.LIVE) ? BetKind.LIVE : BetKind.PRE_MATCH);
    for (const row of data.rows) {
      if (
        ids.has(row.id) || (row.betKind ?? kind) !== kind
        || ![row.id, row.eventId, row.productId, row.oddsId].every(value => typeof value === "string" && value.length > 0)
      ) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
      ids.add(row.id);
      const common = {
        slipRowId: row.id, eventId: row.eventId, productId: row.productId, oddsId: row.oddsId,
        acceptedOdds: canonicalOdds(row.oddsValue),
      };
      if (kind === BetKind.LIVE) {
        if (
          !row.marketId || !row.marketType || !row.selectionId
          || !Number.isSafeInteger(row.marketVersion) || row.marketVersion! < 1
        ) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
        selections.push({
          ...common, betKind: BetKind.LIVE, marketId: row.marketId,
          marketType: row.marketType, marketVersion: row.marketVersion!, selectionId: row.selectionId,
        });
      } else selections.push({ ...common, betKind: BetKind.PRE_MATCH });
    }
    const [first, ...rest] = selections;
    if (!first) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
    return {
      cashBackFinancial: {
        revision: 0, status: BetStatus.PENDING, originalStakeMinor: principal,
        remainingStakeMinor: principal, cumulativeClosedStakeMinor: 0, cumulativeReturnMinor: 0,
      },
      cashBackOriginalManifest: {
        fingerprint: cashBackHash(selections), selections: [first, ...rest],
      },
      cashBackAnySelectionResolved: false,
    };
  } catch (error) {
    if (!(error instanceof CashBackUnavailable)) throw error;
    return { cashBackUnavailableReason: error.reason };
  }
};

export const rejectionReceiptExpression = (
  bet: CashBackBet, financial: CashBackFinancialSnapshot, reason: CashBackUnavailableReason
): Record<string, unknown> => {
  const pending = bet.cashBackPending;
  if (!pending) throw new Error("No canonical cash-back slot to reject");
  return {
    outcome: "REJECTED",
    decisionId: cashBackHash([pending.operation.operationId, pending.operation.fingerprint, "decision"]),
    decisionTime: mongoDecisionTime,
    operation: { $literal: pending.quote.operation },
    quoteId: { $literal: pending.quote.quoteId },
    expectedRevision: pending.quote.financial.revision,
    reason,
    financial: { $literal: financial },
  };
};

/**
 * Result mutations reject the SAME undecided slot atomically with row/status
 * changes. The operation collection is never a competing decision authority.
 */
export const mutateCashBackBet = async (
  aggregateId: CashBackBet["_id"],
  eligible: (bet: CashBackBet) => boolean,
  changes: (bet: CashBackBet) => { fields: Record<string, unknown>; status: ResultingStatus; resolved?: boolean },
  rejectionReason: CashBackUnavailableReason = "SELECTION_RESOLVED"
): Promise<boolean> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    let bet = await Bet.findById(aggregateId);
    if (!bet || bet.status === ResultingStatus.BET_CASH_BACK || !eligible(bet)) return false;
    if (bet.__v === undefined || bet.__v === null) {
      await Bet.updateOne(
        { _id: bet._id, $or: [{ __v: { $exists: false } }, { __v: null }] },
        { $set: { __v: 0 } }
      );
      bet = await Bet.findById(bet._id);
      if (!bet) throw new Error("Resulting Bet disappeared during version initialization");
      if (bet.status === ResultingStatus.BET_CASH_BACK || !eligible(bet)) return false;
    }
    const old = bet.cashBackFinancial;
    if (!old) throw new Error("Cash-back financial evidence is missing");
    validateFinancialSnapshot(old);
    if (old.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Cash-back revision exhausted");
    const change = changes(bet);
    const financial: CashBackFinancialSnapshot = {
      revision: old.revision + 1, status: publicBetStatus(change.status),
      originalStakeMinor: old.originalStakeMinor, remainingStakeMinor: old.remainingStakeMinor,
      cumulativeClosedStakeMinor: old.cumulativeClosedStakeMinor,
      cumulativeReturnMinor: old.cumulativeReturnMinor,
    };
    const set: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(change.fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, { $literal: value }])),
      status: change.status,
      cashBackFinancial: { $literal: financial },
      __v: bet.__v + 1,
      ...(change.resolved ? { cashBackAnySelectionResolved: true } : {}),
    };
    if (bet.cashBackPending?.state === "UNDECIDED") {
      set["cashBackPending.state"] = "REJECTED";
      set["cashBackPending.receipt"] = rejectionReceiptExpression(bet, financial, rejectionReason);
    }
    const result = await Bet.updateOne(
      {
        _id: bet._id, __v: bet.__v, status: bet.status,
        "cashBackFinancial.revision": old.revision,
      },
      [{ $set: set }]
    );
    if (result.modifiedCount === 1) return true;
  }
  throw new Error("Resulting cash-back mutation exhausted its CAS retries");
};
