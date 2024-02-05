import express from "express";
import "express-async-errors";
import { json } from "body-parser";
import cookieSession from "cookie-session";
import { errorHandler } from "./middleware/ErrorHandler";
import { currentUserRouter } from "./route/CurrentUser";
import { loginRouter } from "./route/LogIn";
import { logoutRouter } from "./route/LogOut";
import { newUser } from "./route/NewUser";

const app = express();
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

app.all("*", async (req, res, next) => {
  //next(new NotFoundError());
  throw new Error();
});

app.use(errorHandler);

export { app };
