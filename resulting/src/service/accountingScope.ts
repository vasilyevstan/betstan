import { BetKind, parseMarketBet } from "@betstan/common";

/** IDs from accepted placement authority, never names or current market prices. */
export interface AccountingScope {
  betKind: string;
  structure: "SINGLE" | "ACCUMULATOR" | "BUILDER";
  eventIds: string[];
  productIds: string[];
  marketIds: string[];
  templateIds: string[];
}
export interface RetainedAccountingScope {
  schemaVersion: 1;
  placementFingerprint: string;
  facts: AccountingScope;
}
const key = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const unique = (values: string[]) => [...new Set(values)].sort();

export function placementAccountingScope(data: { betKind?: unknown; rows: any[] }): AccountingScope | undefined {
  try {
    if (!Array.isArray(data.rows) || !data.rows.length
      || !data.rows.every(row => key(row.id) && key(row.eventId) && key(row.productId))) return;
    const betKind = data.betKind ?? BetKind.PRE_MATCH;
    if (!Object.values(BetKind).includes(betKind as BetKind)) return;
    const marketIds: string[] = [];
    const templateIds: string[] = [];
    let builder = false;
    for (const row of data.rows) {
      if (row.marketId != null) {
        if (!key(row.marketId)) return;
        marketIds.push(row.marketId);
      }
      if (row.marketBet != null) {
        const quote = parseMarketBet(row.marketBet);
        if (quote.eventId !== row.eventId || quote.odds !== row.oddsValue) return;
        builder = builder || quote.kind === "BUILDER";
        for (const selection of quote.selections) {
          marketIds.push(selection.marketId);
          templateIds.push(selection.templateId);
        }
      }
    }
    if (builder && data.rows.length !== 1) return;
    return {
      betKind: betKind as string,
      structure: builder ? "BUILDER" : data.rows.length === 1 ? "SINGLE" : "ACCUMULATOR",
      eventIds: unique(data.rows.map(row => row.eventId)),
      productIds: unique(data.rows.map(row => row.productId)),
      marketIds: unique(marketIds), templateIds: unique(templateIds),
    };
  } catch {
    return; // Unsupported old metadata must not change legacy settlement decisions.
  }
}

export function accountingScopeForBet(bet: any): AccountingScope | undefined {
  const retained = bet.accountingScope as RetainedAccountingScope | undefined;
  if (retained) {
    const facts = retained.facts;
    if (retained.schemaVersion !== 1 || retained.placementFingerprint !== bet.accountingBasis?.placementFingerprint
      || !facts || !Object.values(BetKind).includes(facts.betKind as BetKind)
      || !["SINGLE", "ACCUMULATOR", "BUILDER"].includes(facts.structure)
      || !["eventIds", "productIds", "marketIds", "templateIds"].every(field => {
        const ids = (facts as any)[field];
        return Array.isArray(ids) && ids.every(key) && JSON.stringify(ids) === JSON.stringify(unique(ids));
      }) || !facts.eventIds.length || !facts.productIds.length) return;
    return facts;
  }
  // Additive predecessor bridge: only complete original row identity coverage.
  // A pruned legacy void row without its original scope is NOT an empty scope.
  const originals = bet.accountingBasis?.rows;
  if (!Array.isArray(originals) || !originals.length || !Array.isArray(bet.rows)
    || new Set(originals.map((row: any) => row.id)).size !== originals.length) return;
  const rows = originals.map((original: any) => bet.rows.find((row: any) => row.id === original.id));
  if (rows.some((row: any) => !row)) return;
  return placementAccountingScope({ betKind: bet.betKind, rows });
}
