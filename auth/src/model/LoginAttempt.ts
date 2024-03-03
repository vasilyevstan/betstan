import { Schema, model } from "mongoose";

const loginAttemptSchema = new Schema({
  email: {
    type: String,
    required: false,
  },
  timestamp: {
    type: String,
    required: true,
  },
  origin: {
    type: String,
    required: true,
  },
});

const LoginAttempt = model("LoginAttempt", loginAttemptSchema);

export { LoginAttempt };
