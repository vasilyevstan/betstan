import { IEvent } from "./IEvent";
import { MarketDefinition } from "../market/MarketRules";
import { ManualMarketDecision, MarketSelectionSnapshot } from "../market/MarketBet";
import { MarketOddsPreview, ScorePricingModel } from "../market/MarketPricing";

export type ManualOddsGeneration =
  | { method: "EQUAL_CHANCE" }
  | { method: "PROBABILITIES"; values: Record<string, number> }
  | { method: "WEIGHTS"; values: Record<string, number>; unlistedWeight?: number };

export type MarketPricingInstruction =
  | { method: "SCORE_MODEL" }
  | {
    method: "OPERATOR";
    odds: Record<string, number>;
    generatedFrom?: ManualOddsGeneration | { method: "SCORE_MODEL" };
  };

export interface MarketTemplateVersion {
  id: string;
  version: number;
  definition: MarketDefinition;
  publishedAt: string;
}

export interface EventMarketConfiguration {
  schemaVersion: 1;
  marketId: string;
  eventId: string;
  revision: number;
  rulesRevision: number;
  template: MarketTemplateVersion;
  parameters: Record<string, number>;
  availability: "OPEN" | "SUSPENDED";
  pricing: MarketPricingInstruction;
  configuredAt: string;
}

export interface IMarketConfiguredEvent extends IEvent {
  data: EventMarketConfiguration;
}

export type MarketPublication =
  | {
    kind: "MODEL_RETAINED";
    schemaVersion: 1;
    eventId: string;
    occurredAt: string;
    model: ScorePricingModel;
    standardSelections: Array<MarketSelectionSnapshot & { odds: number }>;
  }
  | {
    kind: "MARKET_AVAILABLE";
    schemaVersion: 1;
    eventId: string;
    marketId: string;
    revision: number;
    occurredAt: string;
    configuration: EventMarketConfiguration;
    preview: MarketOddsPreview | { method: "OPERATOR"; odds: Record<string, number> };
    model?: ScorePricingModel;
  }
  | {
    kind: "MARKET_REJECTED";
    schemaVersion: 1;
    eventId: string;
    marketId: string;
    revision: number;
    occurredAt: string;
    reason: string;
  };

export interface IMarketPublishedEvent extends IEvent {
  data: MarketPublication;
}

export interface IMarketSettledEvent extends IEvent {
  data: {
    decision: ManualMarketDecision;
    template: MarketTemplateVersion;
  };
}
