import express from "express";
import { json } from "body-parser";
import { ListllEvents } from "./route/ListAllEvents";
import { EventOddsClicked } from "./route/EventOddsClicked";
import { EventLiveStream } from "./route/EventLiveStream";
import { Markets } from "./route/Markets";
import { BadRequestError, currentUser, errorHandler } from "@betstan/common";
import cookieSession from "cookie-session";

const cors = require("cors");
const app = express();

app.use(cors());
app.use("/api/event/market-quotes", json({ limit: "256kb" }));
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
app.use(EventLiveStream);
app.use(EventOddsClicked);
app.use(Markets);

app.all("*", (req, res, next) => {
  next(new BadRequestError(""));
});

app.use(errorHandler);

export { app };
