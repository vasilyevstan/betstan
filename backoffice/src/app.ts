import express from "express";
import mongoose from "mongoose";
import { json } from "body-parser";
import { errorHandler } from "@betstan/common";
import { ShowEvents } from "./route/ShowEvents";
import { SetResult } from "./route/SetResult";
import { NewEvent } from "./route/NewEvent";
import { EventVisibility } from "./route/EventVisibility";
import { publicBackofficeAccess } from "./middleware/PublicBackofficeAccess";
import { Markets } from "./route/Markets";
import { RiskCentre } from "./route/RiskCentre";
import { AccessControls } from "./route/AccessControls";
import { EventCashBack } from "./route/EventCashBack";
import { GlobalCashBackSetting } from "./route/CashBackSetting";

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
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!req.path.startsWith("/api/backoffice/risk-centre")) { next(error); return; }
  res.set("Cache-Control", "no-store").status(error?.type === "entity.too.large" ? 413 : 400).send({
    message: error?.type === "entity.too.large" ? "Request body is too large" : "Malformed JSON body",
    code: error?.type === "entity.too.large" ? "BODY_TOO_LARGE" : "INVALID_JSON",
  });
});
app.use("/api/backoffice", publicBackofficeAccess);

app.use(ShowEvents);
app.use(SetResult);
app.use(NewEvent);
app.use(EventVisibility);
app.use(EventCashBack);
app.use(GlobalCashBackSetting);
app.use(Markets);
app.use(RiskCentre);
app.use(AccessControls);

app.use(errorHandler);

export { app };
