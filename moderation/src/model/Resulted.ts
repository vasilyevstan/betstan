import { Schema, model } from "mongoose";
import { ModerationStatus } from "@betstan/common";

const resultedSchema = new Schema({
  eventId: {
    type: String,
    required: true,
  },
  timestamp: {
    type: String,
    required: true,
  },
});

const Resulted = model("Resulted", resultedSchema);

export { Resulted };
