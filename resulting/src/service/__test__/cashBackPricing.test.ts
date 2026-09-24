import { BetStatus, CashBackFinancialSnapshot } from "@betstan/common";
import {
  canonicalOdds, combinedOdds, originalStakeMinor, priceCashBack,
} from "../cashBackPricing";

const financial = (minor = 10000): CashBackFinancialSnapshot => ({
  revision: 0, status: BetStatus.CONFIRMED, originalStakeMinor: minor,
  remainingStakeMinor: minor, cumulativeClosedStakeMinor: 0, cumulativeReturnMinor: 0,
});

it("prices fixed-point partials exactly and preserves principal", () => {
  expect(priceCashBack(financial(), { mode: "PARTIAL", stakeMinor: 4000 }, "3", "6"))
    .toEqual({ closedStakeMinor: 4000, remainingStakeMinorAfter: 6000, returnMinor: 2000 });
  expect(priceCashBack(financial(), { mode: "PARTIAL", stakeMinor: 4000 }, "3", "1.5").returnMinor).toBe(8000);
});

it("rounds only the final accumulator return and caps portion potential", () => {
  expect(combinedOdds(["1.25", "1.25"])).toBe("1.5625");
  expect(priceCashBack(financial(100), { mode: "FULL" }, "1.5625", "1").returnMinor).toBe(156);
  expect(priceCashBack(financial(100), { mode: "FULL" }, "3", "0.5").returnMinor).toBe(300);
});

it("never gives a rounding gain from splitting and has no operation count cap", () => {
  const full = priceCashBack(financial(100), { mode: "FULL" }, "3", "2").returnMinor;
  let state = financial(100);
  let returned = 0;
  for (let index = 0; index < 100; index++) {
    const quote = priceCashBack(state, index === 99 ? { mode: "FULL" } : { mode: "PARTIAL", stakeMinor: 1 }, "3", "2");
    returned += quote.returnMinor;
    state = {
      ...state, revision: index + 1, remainingStakeMinor: quote.remainingStakeMinorAfter,
      cumulativeClosedStakeMinor: state.cumulativeClosedStakeMinor + quote.closedStakeMinor,
      cumulativeReturnMinor: returned,
    };
    expect(state.remainingStakeMinor + state.cumulativeClosedStakeMinor).toBe(100);
  }
  expect(returned).toBe(100);
  expect(full).toBe(150);
});

it("rejects invalid amounts, zero returns and silent partial-to-full conversion", () => {
  for (const stakeMinor of [0, -1, 0.1, 100, 101, NaN, Infinity]) {
    expect(() => priceCashBack(financial(100), { mode: "PARTIAL", stakeMinor }, "1", "2")).toThrow("INVALID_AMOUNT");
  }
  expect(() => priceCashBack(financial(1), { mode: "FULL" }, "1", "3")).toThrow("INVALID_AMOUNT");
});

it("keeps exact legacy cents and rejects additional precision, exponent odds and overflow", () => {
  expect(originalStakeMinor(1.23)).toBe(123);
  expect(originalStakeMinor(0.01)).toBe(1);
  for (const wager of [1.001, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(() => originalStakeMinor(wager)).toThrow("LEGACY_PRECISION_UNSUPPORTED");
  }
  expect(canonicalOdds(1.25)).toBe("1.25");
  expect(() => combinedOdds(["1e3"])).toThrow("AUTHORITY_UNAVAILABLE");
  expect(() => combinedOdds(["9".repeat(256), "9"])).toThrow("AUTHORITY_UNAVAILABLE");
});
