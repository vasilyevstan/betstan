import {
  bindScoreRule,
  assertMarketScore,
  BoundScoreRule,
  compileScoreRule,
  MarketDefinition,
  marketKey,
  marketNumber,
  marketObject,
  marketText,
  MarketValidationError,
  MAX_BUILDER_SELECTIONS,
  parseMarketDefinition,
} from "./MarketRules";
import { MAX_MARKET_ODDS, MIN_MARKET_ODDS } from "./MarketPricing";

export const CUSTOM_MARKET_PRODUCT_NAME = "Custom market";
export const BUILDER_PRODUCT_NAME = "Bet Builder";
export const MARKET_QUOTE_MAX_AGE_MS = 30_000;

export interface MarketSelectionIdentity {
  origin: "TEMPLATE" | "STANDARD";
  marketId: string;
  outcomeKey: string;
}

interface MarketSelectionDetails extends MarketSelectionIdentity {
  rulesRevision: number;
  quoteRevision: number;
  templateId: string;
  templateVersion: number;
  marketName: string;
  label: string;
  terms: string;
}

export type MarketSelectionSnapshot = MarketSelectionDetails & (
  | { settlementMode: "FINAL_SCORE"; pricingMethod: "SCORE_MODEL" | "OPERATOR"; rule: BoundScoreRule }
  | { settlementMode: "MANUAL"; pricingMethod: "OPERATOR" }
);

export interface MarketBet {
  schemaVersion: 1;
  kind: "SINGLE" | "BUILDER";
  eventId: string;
  quoteId: string;
  issuedAt: string;
  expiresAt: string;
  odds: number;
  modelId?: string;
  selections: MarketSelectionSnapshot[];
}

export interface ManualMarketDecision {
  schemaVersion: 1;
  decisionId: string;
  eventId: string;
  marketId: string;
  rulesRevision: number;
  reviewedRevision: number;
  decidedAt: string;
  result: "SETTLED" | "VOID";
  winningOutcomeKeys: string[];
}

export function marketRevision(value: unknown): number {
  const revision = marketNumber(value, "Revision");
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new MarketValidationError("A revision must be a positive safe integer");
  }
  return revision;
}

export function marketOdds(value: unknown): number {
  const odds = marketNumber(value, "Decimal odds");
  if (odds < MIN_MARKET_ODDS || odds > MAX_MARKET_ODDS || Math.abs(odds * 100 - Math.round(odds * 100)) > 1e-8) {
    throw new MarketValidationError(`Decimal odds must be ${MIN_MARKET_ODDS}-${MAX_MARKET_ODDS}, with at most two decimal places`);
  }
  return odds;
}

export const marketDomainTime = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MarketValidationError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
};

export function parseMarketSelectionIdentity(value: unknown): MarketSelectionIdentity {
  const input = marketObject(value, ["origin", "marketId", "outcomeKey"], "Selection identity");
  if (input.origin !== "TEMPLATE" && input.origin !== "STANDARD") {
    throw new MarketValidationError("Unsupported selection origin");
  }
  return {
    origin: input.origin,
    marketId: marketKey(input.marketId, "Market id"),
    outcomeKey: marketKey(input.outcomeKey, "Outcome key"),
  };
}

export const marketSelectionKey = (selection: MarketSelectionIdentity): string =>
  `${selection.origin}:${selection.marketId}:${selection.outcomeKey}`;

function parseSelectionSnapshot(value: unknown): MarketSelectionSnapshot {
  const input = marketObject(value, [
    "origin", "marketId", "outcomeKey", "rulesRevision", "quoteRevision", "templateId",
    "templateVersion", "marketName", "label", "terms", "settlementMode", "pricingMethod", "rule",
  ], "Frozen selection");
  const details: MarketSelectionDetails = {
    ...parseMarketSelectionIdentity({ origin: input.origin, marketId: input.marketId, outcomeKey: input.outcomeKey }),
    rulesRevision: marketRevision(input.rulesRevision),
    quoteRevision: marketRevision(input.quoteRevision),
    templateId: marketKey(input.templateId, "Template id"),
    templateVersion: marketRevision(input.templateVersion),
    marketName: marketText(input.marketName, "Market name", 120),
    label: marketText(input.label, "Outcome label", 120),
    terms: marketText(input.terms, "Settlement terms", 2000, input.settlementMode === "FINAL_SCORE"),
  };
  if (input.settlementMode === "MANUAL" && input.pricingMethod === "OPERATOR") {
    if (input.rule !== undefined || details.origin !== "TEMPLATE") {
      throw new MarketValidationError("Manual selections cannot claim modeled rules or standard-product identity");
    }
    return { ...details, settlementMode: "MANUAL", pricingMethod: "OPERATOR" };
  }
  if (input.settlementMode !== "FINAL_SCORE"
    || (input.pricingMethod !== "SCORE_MODEL" && input.pricingMethod !== "OPERATOR")) {
    throw new MarketValidationError("Unsupported selection pricing or settlement mode");
  }
  if (details.origin === "STANDARD" && input.pricingMethod !== "SCORE_MODEL") {
    throw new MarketValidationError("Standard products require retained modeled prices");
  }
  return {
    ...details, settlementMode: "FINAL_SCORE", pricingMethod: input.pricingMethod,
    rule: bindScoreRule(input.rule, {}),
  };
}

export function parseMarketBet(value: unknown): MarketBet {
  const input = marketObject(value, [
    "schemaVersion", "kind", "eventId", "quoteId", "issuedAt", "expiresAt", "odds", "modelId", "selections",
  ], "Market bet");
  if (input.schemaVersion !== 1 || (input.kind !== "SINGLE" && input.kind !== "BUILDER")) {
    throw new MarketValidationError("Unsupported market bet version or kind");
  }
  if (!Array.isArray(input.selections) || !input.selections.length
    || input.selections.length > MAX_BUILDER_SELECTIONS
    || (input.kind === "SINGLE" && input.selections.length !== 1)
    || (input.kind === "BUILDER" && input.selections.length < 2)) {
    throw new MarketValidationError("A single needs one selection; a Builder needs 2-10 selections");
  }
  const selections = input.selections.map(parseSelectionSnapshot).sort((left, right) => {
    const a = marketSelectionKey(left);
    const b = marketSelectionKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (new Set(selections.map(marketSelectionKey)).size !== selections.length) {
    throw new MarketValidationError("A selection cannot appear twice in a market bet");
  }
  if (input.kind === "BUILDER" && selections.some(selection => selection.pricingMethod !== "SCORE_MODEL")) {
    throw new MarketValidationError("Manual and overridden prices cannot enter a same-match Builder");
  }
  const needsModel = selections.some(selection => selection.pricingMethod === "SCORE_MODEL");
  if (needsModel !== (input.modelId !== undefined)) {
    throw new MarketValidationError("Modeled prices require the exact retained model identity");
  }
  if (needsModel && (typeof input.modelId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.modelId))) {
    throw new MarketValidationError("Invalid retained model identity");
  }
  const issuedAt = marketDomainTime(input.issuedAt, "Quote issue time");
  const expiresAt = marketDomainTime(input.expiresAt, "Quote expiry");
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime <= 0 || lifetime > MARKET_QUOTE_MAX_AGE_MS) {
    throw new MarketValidationError("The quote has an invalid validity window");
  }
  return {
    schemaVersion: 1, kind: input.kind,
    eventId: marketKey(input.eventId, "Event id"),
    quoteId: marketKey(input.quoteId, "Quote id"),
    issuedAt, expiresAt, odds: marketOdds(input.odds), selections,
    ...(needsModel ? { modelId: marketText(input.modelId, "Pricing model id", 128) } : {}),
  };
}

export function validateManualWinningOutcomes(
  definitionValue: unknown,
  result: unknown,
  winners: unknown,
): string[] {
  const definition: MarketDefinition = parseMarketDefinition(definitionValue);
  if (definition.settlementMode !== "MANUAL") {
    throw new MarketValidationError("Score-rule markets settle from final scores, not manual decisions");
  }
  if ((result !== "SETTLED" && result !== "VOID") || !Array.isArray(winners)) {
    throw new MarketValidationError("A manual result must declare winning outcomes or void the market");
  }
  const validKeys = new Set(definition.outcomes.map(outcome => outcome.key));
  const keys = winners.map(value => marketKey(value, "Winning outcome"));
  if (keys.some(key => !validKeys.has(key)) || new Set(keys).size !== keys.length) {
    throw new MarketValidationError("Winning outcomes must be distinct declared outcome keys");
  }
  if (result === "VOID") {
    if (keys.length) throw new MarketValidationError("A void market cannot declare a winner");
  } else if ((definition.outcomeMode === "EXCLUSIVE" && keys.length > 1)
    || (definition.coverage === "COMPLETE" && keys.length === 0)) {
    throw new MarketValidationError("Winning outcomes do not match the declared outcome semantics");
  }
  return keys.sort();
}

export function assertMarketSlipCompatibility(rows: readonly {
  eventId: string;
  marketBet?: MarketBet;
}[]): void {
  const seen = new Map<string, boolean>();
  for (const row of rows) {
    const hasMarketBet = row.marketBet !== undefined;
    if (hasMarketBet && parseMarketBet(row.marketBet).eventId !== row.eventId) {
      throw new MarketValidationError("Market quote event does not match the slip row");
    }
    if (seen.has(row.eventId) && (seen.get(row.eventId) || hasMarketBet)) {
      throw new MarketValidationError("Use one modeled Builder for a match; manual markets can only combine with other matches");
    }
    seen.set(row.eventId, hasMarketBet);
  }
}

export function parseManualMarketDecision(value: unknown, definition: unknown): ManualMarketDecision {
  const input = marketObject(value, [
    "schemaVersion", "decisionId", "eventId", "marketId", "rulesRevision",
    "reviewedRevision", "decidedAt", "result", "winningOutcomeKeys",
  ], "Manual market decision");
  if (input.schemaVersion !== 1 || (input.result !== "SETTLED" && input.result !== "VOID")) {
    throw new MarketValidationError("Unsupported manual market decision");
  }
  return {
    schemaVersion: 1,
    decisionId: marketKey(input.decisionId, "Decision id"),
    eventId: marketKey(input.eventId, "Event id"),
    marketId: marketKey(input.marketId, "Market id"),
    rulesRevision: marketRevision(input.rulesRevision),
    reviewedRevision: marketRevision(input.reviewedRevision),
    decidedAt: marketDomainTime(input.decidedAt, "Decision time"),
    result: input.result,
    winningOutcomeKeys: validateManualWinningOutcomes(definition, input.result, input.winningOutcomeKeys),
  };
}

export function evaluateMarketBetResult(
  value: unknown,
  evidence: {
    eventId: string;
    finalScore?: { home: number; away: number };
    manualDecision?: ManualMarketDecision;
    voidEvent?: boolean;
  },
): "WIN" | "LOSS" | "VOID" | null {
  const bet = parseMarketBet(value);
  if (bet.eventId !== evidence.eventId) throw new MarketValidationError("Settlement evidence belongs to another event");
  if (evidence.voidEvent === true) return "VOID";
  const manual = bet.selections.find(selection => selection.settlementMode === "MANUAL");
  if (manual) {
    const decision = evidence.manualDecision;
    if (!decision) return null;
    if (decision.schemaVersion !== 1 || decision.eventId !== bet.eventId
      || decision.marketId !== manual.marketId || decision.rulesRevision !== manual.rulesRevision
      || (decision.result !== "VOID" && decision.result !== "SETTLED")) {
      throw new MarketValidationError("Manual result does not match the frozen market revision");
    }
    if (decision.result === "VOID") return "VOID";
    return decision.winningOutcomeKeys.indexOf(manual.outcomeKey) >= 0 ? "WIN" : "LOSS";
  }
  if (evidence.manualDecision) throw new MarketValidationError("Score-rule bets cannot consume manual results");
  const score = evidence.finalScore;
  if (!score) return null;
  assertMarketScore(score.home, score.away);
  return bet.selections.every(selection => selection.settlementMode === "FINAL_SCORE"
    && compileScoreRule(selection.rule)(score.home, score.away)) ? "WIN" : "LOSS";
}
