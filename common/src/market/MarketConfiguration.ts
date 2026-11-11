import {
  EventMarketConfiguration,
  ManualOddsGeneration,
  MarketPricingInstruction,
} from "../event/IMarketEvent";
import {
  bindMarketParameters,
  MarketDefinition,
  marketKey,
  marketNumber,
  marketObject,
  MarketValidationError,
  parseMarketDefinition,
} from "./MarketRules";
import { marketDomainTime, marketOdds, marketRevision } from "./MarketBet";
import { generateManualMarketOdds } from "./MarketPricing";

function parseGeneration(definition: MarketDefinition, value: unknown): ManualOddsGeneration | { method: "SCORE_MODEL" } {
  const input = marketObject(value, ["method", "values", "unlistedWeight"], "Generation inputs");
  if (input.method === "SCORE_MODEL") {
    marketObject(input, ["method"], "Modeled generation");
    if (definition.settlementMode !== "FINAL_SCORE") {
      throw new MarketValidationError("Manual outcomes cannot claim score-model generation");
    }
    return { method: "SCORE_MODEL" };
  }
  generateManualMarketOdds(definition, input);
  if (input.method === "EQUAL_CHANCE") return { method: "EQUAL_CHANCE" };
  const values = marketObject(input.values, definition.outcomes.map(outcome => outcome.key), "Generation values");
  const normalized: Record<string, number> = {};
  definition.outcomes.forEach(outcome => {
    normalized[outcome.key] = marketNumber(values[outcome.key], `Outcome ${outcome.key}`);
  });
  if (input.method === "PROBABILITIES") return { method: "PROBABILITIES", values: normalized };
  return {
    method: "WEIGHTS", values: normalized,
    ...(input.unlistedWeight === undefined
      ? {} : { unlistedWeight: marketNumber(input.unlistedWeight, "Unlisted-outcome weight") }),
  };
}

export function parseMarketPricingInstruction(definition: MarketDefinition, value: unknown): MarketPricingInstruction {
  const input = marketObject(value, ["method", "odds", "generatedFrom"], "Pricing instruction");
  if (input.method === "SCORE_MODEL") {
    marketObject(input, ["method"], "Modeled pricing");
    if (definition.settlementMode !== "FINAL_SCORE") {
      throw new MarketValidationError("Manual markets cannot claim model-derived prices");
    }
    return { method: "SCORE_MODEL" };
  }
  if (input.method !== "OPERATOR") throw new MarketValidationError("Unsupported pricing instruction");
  const values = marketObject(input.odds, definition.outcomes.map(outcome => outcome.key), "Published odds");
  const odds: Record<string, number> = {};
  definition.outcomes.forEach(outcome => { odds[outcome.key] = marketOdds(values[outcome.key]); });
  return {
    method: "OPERATOR", odds,
    ...(input.generatedFrom === undefined ? {} : { generatedFrom: parseGeneration(definition, input.generatedFrom) }),
  };
}

export function parseEventMarketConfiguration(value: unknown): EventMarketConfiguration {
  const input = marketObject(value, [
    "schemaVersion", "marketId", "eventId", "revision", "rulesRevision", "template",
    "parameters", "availability", "pricing", "configuredAt",
  ], "Event market configuration");
  if (input.schemaVersion !== 1 || (input.availability !== "OPEN" && input.availability !== "SUSPENDED")) {
    throw new MarketValidationError("Unsupported market configuration version or availability");
  }
  const template = marketObject(input.template, ["id", "version", "definition", "publishedAt"], "Template version");
  const definition = parseMarketDefinition(template.definition);
  const revision = marketRevision(input.revision);
  const rulesRevision = marketRevision(input.rulesRevision);
  if (rulesRevision > revision) throw new MarketValidationError("Rules cannot refer to a future configuration revision");
  return {
    schemaVersion: 1,
    marketId: marketKey(input.marketId, "Market id"),
    eventId: marketKey(input.eventId, "Event id"),
    revision, rulesRevision,
    template: {
      id: marketKey(template.id, "Template id"),
      version: marketRevision(template.version),
      definition,
      publishedAt: marketDomainTime(template.publishedAt, "Template publication time"),
    },
    parameters: bindMarketParameters(definition, input.parameters),
    availability: input.availability,
    pricing: parseMarketPricingInstruction(definition, input.pricing),
    configuredAt: marketDomainTime(input.configuredAt, "Configuration time"),
  };
}
