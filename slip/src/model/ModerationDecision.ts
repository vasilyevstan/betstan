import { Schema, model } from "mongoose";

// The transport envelope is deliberately absent from immutable decision identity.
export const ModerationDecision = model("ModerationDecision", new Schema({
  _id: { type: String, required: true },
  slipId: { type: String, required: true },
  result: { type: String, required: true },
  decisionId: String,
  occurredAt: String,
}));
