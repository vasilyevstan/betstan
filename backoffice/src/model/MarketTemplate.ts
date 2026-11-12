import { MarketTemplateVersion } from "@betstan/common";
import { Schema, model } from "mongoose";

interface TemplateRecord {
  templateId: string;
  revision: number;
  archived: boolean;
  creationFingerprint: string;
  versions: MarketTemplateVersion[];
}

const versionSchema = new Schema<MarketTemplateVersion>({
  id: { type: String, required: true },
  version: { type: Number, required: true },
  definition: { type: Schema.Types.Mixed, required: true },
  publishedAt: { type: String, required: true },
}, { _id: false });

const schema = new Schema<TemplateRecord>({
  templateId: { type: String, required: true, unique: true },
  revision: { type: Number, required: true },
  archived: { type: Boolean, required: true, default: false },
  creationFingerprint: { type: String, required: true, select: false },
  versions: { type: [versionSchema], required: true },
});

export const MarketTemplate = model("MarketTemplate", schema);
