const MAX = BigInt(Number.MAX_SAFE_INTEGER);

export function nominalStakeMinor(wager: number): number {
  const text = String(wager);
  if (!Number.isFinite(wager) || wager <= 0 || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text)) {
    throw new Error("LEGACY_PRECISION_UNSUPPORTED");
  }
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (amount <= BigInt(0) || amount > MAX) throw new Error("AMOUNT_UNSUPPORTED");
  return Number(amount);
}

/** Floor once, after the exact fixed-odds product, matching nominal-cent possibleReturn. */
export function fixedOddsReturnMinor(stakeMinor: number, odds: readonly string[]): number {
  if (!Number.isSafeInteger(stakeMinor) || stakeMinor < 0 || odds.length > 10000) throw new Error("AMOUNT_UNSUPPORTED");
  let numerator = BigInt(stakeMinor);
  let denominator = BigInt(1);
  for (const text of odds) {
    if (typeof text !== "string" || text.length > 256 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(text)) {
      throw new Error("AUTHORITY_UNAVAILABLE");
    }
    const [whole, fraction = ""] = text.split(".");
    const factor = BigInt(whole + fraction);
    const scale = BigInt(`1${"0".repeat(fraction.length)}`);
    if (factor < scale) throw new Error("AUTHORITY_UNAVAILABLE");
    numerator *= factor;
    denominator *= scale;
    if (numerator.toString().length > 4096 || denominator.toString().length > 4096
      || numerator / denominator > MAX) throw new Error("AMOUNT_UNSUPPORTED");
  }
  return Number(numerator / denominator);
}

/** Signed loss: wins offset losses. Use bigint for aggregation, never floating sums. */
export function realisedLossMinor(closedStakeMinor: number, returnMinor: number): bigint {
  if (![closedStakeMinor, returnMinor].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("AMOUNT_UNSUPPORTED");
  }
  return BigInt(closedStakeMinor) - BigInt(returnMinor);
}
