import { EventMarketConfiguration, MarketBet, MarketPublication } from "@betstan/common";
import { model, Schema } from "mongoose";

export interface MarketProjectionRecord {
  eventId: string;
  marketId: string;
  revision: number;
  fingerprint: string;
  configuration: EventMarketConfiguration;
  processingPending: boolean;
  publication?: MarketPublication;
  publicationPending: boolean;
  lastAttemptedAt?: Date;
}

const projectionSchema = new Schema<MarketProjectionRecord>({
  eventId: { type: String, required: true },
  marketId: { type: String, required: true },
  revision: { type: Number, required: true },
  fingerprint: { type: String, required: true },
  configuration: { type: Schema.Types.Mixed, required: true },
  processingPending: { type: Boolean, required: true },
  publication: { type: Schema.Types.Mixed },
  publicationPending: { type: Boolean, required: true },
  lastAttemptedAt: { type: Date },
}, { minimize: false });
projectionSchema.index({ marketId: 1, revision: 1 }, { unique: true });
projectionSchema.index({ eventId: 1, revision: -1 });
projectionSchema.index({ processingPending: 1, publicationPending: 1 });
export const MarketProjection = model("MarketProjection", projectionSchema);

interface MarketQuoteRecord {
  quoteId: string;
  ownerId: string;
  requestFingerprint: string;
  quote: MarketBet;
}
const quoteSchema = new Schema<MarketQuoteRecord>({
  quoteId: { type: String, required: true },
  ownerId: { type: String, required: true, select: false },
  requestFingerprint: { type: String, required: true, select: false },
  quote: { type: Schema.Types.Mixed, required: true },
}, { minimize: false });
quoteSchema.index({ quoteId: 1 }, { unique: true });
export const MarketQuote = model("MarketQuote", quoteSchema);
