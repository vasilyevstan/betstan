import express from "express";
import { json } from "body-parser";
import { currentUser, errorHandler } from "@betstan/common";
import cookieSession from "cookie-session";
import { ShowEvents } from "./route/ShowEvents";
import { SetResult } from "./route/SetResult";
import { NewEvent } from "./route/NewEvent";
import { EventVisibility } from "./route/EventVisibility";

const cors = require("cors");
const app = express();

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

app.use(ShowEvents);
app.use(SetResult);
app.use(NewEvent);
app.use(EventVisibility);

app.use(errorHandler);

export { app };
