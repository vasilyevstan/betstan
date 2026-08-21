import { Schema, model } from "mongoose";

const resultedSchema = new Schema({
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  timestamp: {
    type: String,
    required: true,
  },
});

const Resulted = model("Resulted", resultedSchema);

export { Resulted };
