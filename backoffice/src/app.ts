import express from "express";
import { json } from "body-parser";
import { errorHandler } from "@betstan/common";
import { ShowEvents } from "./route/ShowEvents";
import { SetResult } from "./route/SetResult";
import { NewEvent } from "./route/NewEvent";
import { EventVisibility } from "./route/EventVisibility";
import { publicBackofficeAccess } from "./middleware/PublicBackofficeAccess";
import { Markets } from "./route/Markets";

const cors = require("cors");
const app = express();

app.use(cors());
app.use(json());
app.use("/api/backoffice", publicBackofficeAccess);

app.use(ShowEvents);
app.use(SetResult);
app.use(NewEvent);
app.use(EventVisibility);
app.use(Markets);

app.use(errorHandler);

export { app };
