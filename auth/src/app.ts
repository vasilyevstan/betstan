import express from "express";
import mongoose from "mongoose";
import "express-async-errors";
import { json } from "body-parser";
import cookieSession from "cookie-session";
import { currentUserRouter } from "./route/CurrentUser";
import { loginRouter } from "./route/LogIn";
import { logoutRouter } from "./route/LogOut";
import { newUser } from "./route/NewUser";
import { verifyAdminRouter } from "./route/VerifyAdmin";
import { profileRouter } from "./route/Profile";
import { errorHandler } from "@betstan/common";

const app = express();
app.get("/health", (_req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.set("Cache-Control", "no-store").status(ready ? 200 : 503)
    .send({ status: ready ? "green" : "red" });
});
app.set("trust proxy", true);
app.use(json());
app.use(
  cookieSession({
    signed: false,
    secure: false,
    // secure: process.env.NODE_ENV !== "test",
  })
);

app.use(currentUserRouter);
app.use(loginRouter);
app.use(logoutRouter);
app.use(newUser);
app.use(verifyAdminRouter);
app.use(profileRouter);

app.all("*", async (req, res, next) => {
  //next(new NotFoundError());
  throw new Error();
});

app.use(errorHandler);

export { app };
