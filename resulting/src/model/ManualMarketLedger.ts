import { ManualMarketDecision, MarketTemplateVersion } from "@betstan/common";
import { model, Schema } from "mongoose";

interface ManualMarketRecord {
  eventId: string;
  marketId: string;
  rulesRevision: number;
  fingerprint: string;
  decision: ManualMarketDecision;
  template: MarketTemplateVersion;
}

const schema = new Schema<ManualMarketRecord>({
  eventId: { type: String, required: true },
  marketId: { type: String, required: true },
  rulesRevision: { type: Number, required: true },
  fingerprint: { type: String, required: true },
  decision: { type: Schema.Types.Mixed, required: true },
  template: { type: Schema.Types.Mixed, required: true },
}, { minimize: false });
schema.index({ eventId: 1, marketId: 1, rulesRevision: 1 }, { unique: true });

export const ManualMarketLedger = model("ManualMarketLedger", schema);
