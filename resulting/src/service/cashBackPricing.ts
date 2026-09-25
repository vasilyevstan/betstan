import {
  CashBackFinancialSnapshot, CashBackPortionRequest, CashBackUnavailableReason,
} from "@betstan/common";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);
const HUNDRED = BigInt(100);
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_DECIMAL_DIGITS = 256;

export class CashBackUnavailable extends Error {
  constructor(public readonly reason: CashBackUnavailableReason) {
    super(reason);
  }
}

interface Decimal {
  coefficient: bigint;
  scale: number;
}

const decimal = (text: string): Decimal => {
  if (
    text.length > MAX_DECIMAL_DIGITS
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(text)
  ) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
  const [whole, fraction = ""] = text.split(".");
  const coefficient = BigInt(whole + fraction);
  if (coefficient <= ZERO) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
  return { coefficient, scale: fraction.length };
};

const decimalText = ({ coefficient, scale }: Decimal): string => {
  let digits = coefficient.toString();
  if (digits.length > MAX_DECIMAL_DIGITS || scale > MAX_DECIMAL_DIGITS) {
    throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
  }
  if (scale === 0) return digits;
  digits = digits.padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "");
};

export const canonicalOdds = (value: number): string => {
  if (!Number.isFinite(value) || value < 1) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
  const text = String(value);
  decimal(text);
  return text;
};

export const originalStakeMinor = (wager: number): number => {
  if (!Number.isFinite(wager) || wager <= 0) throw new CashBackUnavailable("LEGACY_PRECISION_UNSUPPORTED");
  const text = String(wager);
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text)) {
    throw new CashBackUnavailable("LEGACY_PRECISION_UNSUPPORTED");
  }
  const [whole, fraction = ""] = text.split(".");
  const minor = BigInt(whole) * HUNDRED + BigInt(fraction.padEnd(2, "0"));
  if (minor < ONE || minor > MAX_MINOR) throw new CashBackUnavailable("LEGACY_PRECISION_UNSUPPORTED");
  return Number(minor);
};

export const combinedOdds = (odds: readonly string[]): string => {
  if (odds.length === 0) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
  let product: Decimal = { coefficient: ONE, scale: 0 };
  for (const text of odds) {
    const factor = decimal(text);
    product = { coefficient: product.coefficient * factor.coefficient, scale: product.scale + factor.scale };
    while (product.scale > 0 && product.coefficient % TEN === ZERO) {
      product.coefficient /= TEN;
      product.scale--;
    }
    decimalText(product);
  }
  return decimalText(product);
};

export const validateFinancialSnapshot = (financial: CashBackFinancialSnapshot): void => {
  if (
    ![
      financial.revision, financial.originalStakeMinor, financial.remainingStakeMinor,
      financial.cumulativeClosedStakeMinor, financial.cumulativeReturnMinor,
    ].every(value => Number.isSafeInteger(value) && value >= 0)
    || financial.originalStakeMinor === 0
    || BigInt(financial.remainingStakeMinor) + BigInt(financial.cumulativeClosedStakeMinor)
      !== BigInt(financial.originalStakeMinor)
  ) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
};

export const priceCashBack = (
  financial: CashBackFinancialSnapshot,
  portion: CashBackPortionRequest,
  acceptedCombinedOdds: string,
  currentCombinedOdds: string
): { closedStakeMinor: number; remainingStakeMinorAfter: number; returnMinor: number } => {
  validateFinancialSnapshot(financial);
  const stake = portion.mode === "FULL" ? financial.remainingStakeMinor : portion.stakeMinor;
  if (
    !Number.isSafeInteger(stake) || stake < 1 || stake > financial.remainingStakeMinor
    || (portion.mode === "PARTIAL" && financial.remainingStakeMinor - stake < 1)
  ) throw new CashBackUnavailable("INVALID_AMOUNT");
  const accepted = decimal(acceptedCombinedOdds);
  const current = decimal(currentCombinedOdds);
  const numerator = BigInt(stake) * accepted.coefficient;
  const acceptedScale = TEN ** BigInt(accepted.scale);
  const raw = numerator * (TEN ** BigInt(current.scale)) / (acceptedScale * current.coefficient);
  const cap = numerator / acceptedScale;
  const result = raw < cap ? raw : cap;
  if (result < ONE || result + BigInt(financial.cumulativeReturnMinor) > MAX_MINOR) {
    throw new CashBackUnavailable("INVALID_AMOUNT");
  }
  return {
    closedStakeMinor: stake,
    remainingStakeMinorAfter: financial.remainingStakeMinor - stake,
    returnMinor: Number(result),
  };
};
