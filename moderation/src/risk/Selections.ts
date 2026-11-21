import { fingerprint } from "./Policy";

export interface ChoiceIdentity {
  eventId: string;
  origin: "STANDARD" | "TEMPLATE" | "LIVE";
  marketId: string;
  outcomeKey: string;
}
export const choiceId = (choice: ChoiceIdentity): string => fingerprint({
  eventId: choice.eventId, origin: choice.origin, marketId: choice.marketId, outcomeKey: choice.outcomeKey,
});
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const choiceScopeKey = (betKind: string, eventId: string): string => `${betKind}:${eventId}`;

export function liveOutcomeKey(marketId: string, marketVersion: number, selectionId: string): string | undefined {
  const prefix = `${marketId}:${marketVersion}:`;
  if (!Number.isSafeInteger(marketVersion) || marketVersion < 1 || !selectionId.startsWith(prefix)) return undefined;
  const outcome = selectionId.slice(prefix.length);
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(outcome) ? outcome : undefined;
}

export function placementChoices(data: { rows: unknown[]; betKind?: string }): {
  choices: Map<string, ChoiceIdentity>; unidentified: Set<string>;
} {
  const choices = new Map<string, ChoiceIdentity>();
  const unidentified = new Set<string>();
  const add = (choice: ChoiceIdentity) => choices.set(choiceId(choice), choice);
  const unknown = (eventId: string, betKind: string) => unidentified.add(choiceScopeKey(betKind, eventId));
  for (const value of data.rows) {
    const row = record(value);
    if (!row || !text(row.eventId)) continue;
    const eventId = row.eventId;
    const custom = record(row.marketBet);
    if (custom) {
      if (!Array.isArray(custom.selections) || !custom.selections.length) unknown(eventId, "PRE_MATCH");
      else for (const value of custom.selections) {
        const selection = record(value);
        if (!selection || !["STANDARD", "TEMPLATE"].includes(String(selection.origin))
          || !text(selection.marketId) || !text(selection.outcomeKey)) unknown(eventId, "PRE_MATCH");
        else add({
          eventId, origin: selection.origin === "STANDARD" ? "STANDARD" : "TEMPLATE",
          marketId: selection.marketId, outcomeKey: selection.outcomeKey,
        });
      }
    } else if (row.betKind === "LIVE" || data.betKind === "LIVE") {
      const outcomeKey = text(row.marketId) && typeof row.marketVersion === "number" && text(row.selectionId)
        ? liveOutcomeKey(row.marketId, row.marketVersion, row.selectionId) : undefined;
      if (!outcomeKey || !text(row.marketId)) unknown(eventId, "LIVE");
      else add({ eventId, origin: "LIVE", marketId: row.marketId, outcomeKey });
    } else if (text(row.productId) && text(row.oddsId)) {
      add({ eventId, origin: "STANDARD", marketId: row.productId, outcomeKey: row.oddsId });
    } else unknown(eventId, data.betKind === "LIVE" ? "LIVE" : "PRE_MATCH");
  }
  return { choices, unidentified };
}
