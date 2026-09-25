import { BetStatus, CashBackFinancialSnapshot, SlipRowStatus } from "@betstan/common";
import { isDeepStrictEqual } from "util";
import { createHash } from "crypto";
import { BetDocument } from "../model/Bet";

export const cashBackReceiptHash = (value: unknown): string => {
  const stable = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input) ?? "null";
    if (Array.isArray(input)) return `[${input.map(stable).join(",")}]`;
    return `{${Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  };
  return createHash("sha256").update(stable(value)).digest("hex");
};

const exactMinor = (wager: number): number => {
  const value = String(wager);
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value)) throw new Error("Original wager is not exactly representable");
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("Invalid original principal");
  return result;
};

export const validateCashBackFinancial = (financial: CashBackFinancialSnapshot, wager: number): void => {
  if (
    !financial
    || ![
      financial.revision, financial.originalStakeMinor, financial.remainingStakeMinor,
      financial.cumulativeClosedStakeMinor, financial.cumulativeReturnMinor,
    ].every(value => Number.isSafeInteger(value) && value >= 0)
    || !Object.values(BetStatus).includes(financial.status)
    || financial.originalStakeMinor !== exactMinor(wager)
    || financial.originalStakeMinor !== financial.remainingStakeMinor + financial.cumulativeClosedStakeMinor
    || (financial.status === BetStatus.CASH_BACK && financial.remainingStakeMinor !== 0)
  ) throw new Error("Invalid authoritative cash-back financial snapshot");
};

export const applyCashBackFinancial = (
  bet: BetDocument, financial: CashBackFinancialSnapshot
): boolean => {
  validateCashBackFinancial(financial, bet.wager);
  const current = bet.cashBackFinancial;
  if (current) {
    if (financial.revision < current.revision) return false;
    if (financial.revision === current.revision) {
      const same = Object.keys(financial).every(key =>
        isDeepStrictEqual(Reflect.get(current, key), Reflect.get(financial, key))
      );
      if (!same) throw new Error("Conflicting cash-back snapshots at the same revision");
      return false;
    }
  }
  if (bet.status === BetStatus.CASH_BACK && financial.status !== BetStatus.CASH_BACK) {
    throw new Error("Cash-back terminal exposure cannot be reopened");
  }
  if (current?.status === BetStatus.CASH_BACK && (
    financial.cumulativeReturnMinor !== current.cumulativeReturnMinor
    || financial.cumulativeClosedStakeMinor !== current.cumulativeClosedStakeMinor
    || financial.remainingStakeMinor !== 0
  )) throw new Error("Full cash-back financial amounts are immutable");
  const terminalFinancial = current && [
    BetStatus.WIN, BetStatus.LOSS, BetStatus.VOID, BetStatus.DECLINED,
  ].includes(current.status);
  const legacyTerminal = [BetStatus.WIN, BetStatus.LOSS, BetStatus.VOID, BetStatus.DECLINED].includes(bet.status);
  if (
    terminalFinancial
    && [BetStatus.PENDING, BetStatus.CONFIRMED, BetStatus.CASH_BACK].includes(financial.status)
  ) {
    throw new Error("A newer cash-back snapshot conflicts with terminal settlement");
  }
  bet.cashBackFinancial = financial;
  // An older portion can supply missing history/amounts after an unversioned
  // legacy terminal envelope, but cannot reopen that terminal exposure.
  if (!(legacyTerminal && financial.status === BetStatus.CONFIRMED)) bet.status = financial.status;
  if (financial.status === BetStatus.CASH_BACK) {
    for (const row of bet.rows) {
      row.status = SlipRowStatus.NOT_SETTLED;
      row.winningSelection = "";
      row.winningSide = undefined;
      row.settlementReason = undefined;
      row.settlementSequence = undefined;
    }
  }
  return true;
};
