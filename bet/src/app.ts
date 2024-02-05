import express from "express";
import { json } from "body-parser";
import { currentUser, errorHandler } from "@betstan/common";
import cookieSession from "cookie-session";
import { ShowBets } from "./route/ShowBets";
import { ShowStats } from "./route/ShowStats";

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

app.use(ShowBets);
app.use(ShowStats);

app.use(errorHandler);

export { app };
