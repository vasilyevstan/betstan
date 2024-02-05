import express from "express";
import { json } from "body-parser";
import { ListllEvents } from "./route/ListAllEvents";
import { EventOddsClicked } from "./route/EventOddsClicked";
import { currentUser, errorHandler } from "@betstan/common";
import cookieSession from "cookie-session";

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

app.use(ListllEvents);
app.use(EventOddsClicked);

app.use(errorHandler);

export { app };
