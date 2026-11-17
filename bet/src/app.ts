import express from "express";
import mongoose from "mongoose";
import { json } from "body-parser";
import { currentUser, errorHandler } from "@betstan/common";
import cookieSession from "cookie-session";
import { ShowBets } from "./route/ShowBets";
import { ShowStats } from "./route/ShowStats";
import { CashBack } from "./route/CashBack";
import { ShowProfileStats } from "./route/ShowProfileStats";

const cors = require("cors");
const app = express();
export const runtimeHealth = { ready: false, brokerConnected: false };
app.get("/health", (_req, res) => {
  const ready = runtimeHealth.ready && runtimeHealth.brokerConnected
    && mongoose.connection.readyState === 1;
  res.set("Cache-Control", "no-store").status(ready ? 200 : 503)
    .send({ status: ready ? "green" : "red" });
});

app.use(cors());
app.use(json());
app.use(
  cookieSession({
    signed: false,
    secure: false,
    // secure: process.env.NODE_ENV !== "test",
  })
);
app.use(currentUser);

app.use(ShowBets);
app.use(ShowStats);
app.use(ShowProfileStats);
app.use(CashBack);

app.use(errorHandler);

export { app };
