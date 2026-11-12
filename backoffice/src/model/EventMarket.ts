import {
  EventMarketConfiguration, ManualMarketDecision, MarketPricingInstruction, MarketTemplateVersion,
} from "@betstan/common";
import { Schema } from "mongoose";

export interface EventMarket {
  marketId: string;
  creationFingerprint: string;
  revision: number;
  rulesRevision: number;
  template: MarketTemplateVersion;
  parameters: Record<string, number>;
  availability: "OPEN" | "SUSPENDED";
  pricing?: MarketPricingInstruction;
  status: "DRAFT" | "PUBLISHING" | "PUBLISHED" | "REJECTED";
  configuredAt: string;
  configuration?: EventMarketConfiguration;
  publishedConfiguration?: EventMarketConfiguration;
  publicationPending?: boolean;
  publicationError?: string;
  decision?: ManualMarketDecision;
  resultPublicationPending?: boolean;
}

export const eventMarketSchema = new Schema<EventMarket>({
  marketId: { type: String, required: true },
  creationFingerprint: { type: String, required: true },
  revision: { type: Number, required: true },
  rulesRevision: { type: Number, required: true },
  template: { type: Schema.Types.Mixed, required: true },
  parameters: { type: Schema.Types.Mixed, required: true },
  availability: { type: String, required: true, enum: ["OPEN", "SUSPENDED"] },
  pricing: { type: Schema.Types.Mixed, required: false },
  status: { type: String, required: true, enum: ["DRAFT", "PUBLISHING", "PUBLISHED", "REJECTED"] },
  configuredAt: { type: String, required: true },
  configuration: { type: Schema.Types.Mixed, required: false },
  publishedConfiguration: { type: Schema.Types.Mixed, required: false },
  publicationPending: { type: Boolean, required: false },
  publicationError: { type: String, required: false },
  decision: { type: Schema.Types.Mixed, required: false },
  resultPublicationPending: { type: Boolean, required: false },
}, { _id: false, minimize: false });

export const publicEventMarket = ({ creationFingerprint: _fingerprint, ...market }: EventMarket) => market;
