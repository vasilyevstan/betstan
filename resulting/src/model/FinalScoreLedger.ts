import { Schema, model } from "mongoose";

const finalScoreLedgerSchema = new Schema({
  eventId: {
    type: String,
    required: true,
  },
  occurredAt: {
    type: String,
    required: true,
  },
  homeScore: {
    type: Number,
    required: true,
  },
  awayScore: {
    type: Number,
    required: true,
  },
  home: {
    type: String,
    required: true,
  },
  away: {
    type: String,
    required: true,
  },
  correctScoreResult: {
    type: String,
    required: true,
  },
  oneCrossTwoResult: {
    type: String,
    required: true,
  },
});

finalScoreLedgerSchema.index({ eventId: 1 }, { unique: true });
finalScoreLedgerSchema.index({ occurredAt: 1, eventId: 1 });

const FinalScoreLedger = model("FinalScoreLedger", finalScoreLedgerSchema);

export default FinalScoreLedger;
