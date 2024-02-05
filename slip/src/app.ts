import express from "express";
import { json } from "body-parser";
import { currentUser, errorHandler } from "@betstan/common";
import { ShowSlip } from "./route/ShowSlip";
import cookieSession from "cookie-session";
import { DeleteSlipRow } from "./route/DeleteSlipRow";
import { CleanSlip } from "./route/CleanSlip";
import { PlaceBet } from "./route/PlaceBet";

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

app.use(ShowSlip);
app.use(DeleteSlipRow);
app.use(CleanSlip);
app.use(PlaceBet);

app.use(errorHandler);

export { app };
