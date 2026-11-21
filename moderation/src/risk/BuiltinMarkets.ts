import { LiveMarketType } from "../compat/LiveContract";

export interface BuiltinMarket {
  id: string;
  name: string;
  betKind: "PRE_MATCH" | "LIVE";
}
export const builtinMarkets: BuiltinMarket[] = [
  { id: "PRE_MATCH:1X2", name: "1X2", betKind: "PRE_MATCH" },
  { id: "PRE_MATCH:CS", name: "Correct Score", betKind: "PRE_MATCH" },
  ...Object.values(LiveMarketType).map(type => ({
    id: `LIVE:${type}`,
    name: `${type.toLowerCase().replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase())} (live)`,
    betKind: "LIVE" as const,
  })),
];
export const builtinMarketId = (betKind: string, marketType: unknown): string | undefined =>
  typeof marketType === "string" ? builtinMarkets.find(market => market.id === `${betKind}:${marketType}`)?.id : undefined;
