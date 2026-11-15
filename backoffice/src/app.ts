import express from "express";
import { json } from "body-parser";
import { errorHandler } from "@betstan/common";
import { ShowEvents } from "./route/ShowEvents";
import { SetResult } from "./route/SetResult";
import { NewEvent } from "./route/NewEvent";
import { EventVisibility } from "./route/EventVisibility";
import { publicBackofficeAccess } from "./middleware/PublicBackofficeAccess";
import { Markets } from "./route/Markets";
import { RiskCentre } from "./route/RiskCentre";

const cors = require("cors");
const app = express();

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
app.use(Markets);
app.use(RiskCentre);

app.use(errorHandler);

export { app };
