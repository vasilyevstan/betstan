import express, { Request, Response } from "express";
import { body, oneOf } from "express-validator";
import { User } from "../model/User";
import { Password } from "../service/Password";
import jwt from "jsonwebtoken";
import { BadRequestError, validateRequest } from "@betstan/common";
import { LoginAttempt } from "../model/LoginAttempt";
import {
  normalizeIdentifier,
  toPublicUser,
  usernamePattern,
} from "../service/Identifier";

const router = express.Router();

type LoginBody = {
  email: string;
  password: string;
};

const logLoginAttempt = async (req: Request, email: string) => {
  const loginAttempt = new LoginAttempt({
    email,
    timestamp: new Date().toISOString(),
    origin: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
  });

  await loginAttempt.save();
};

router.post(
  "/api/auth/login",
  [
    body("email")
      .isString()
      .withMessage("Username or email must be text")
      .bail()
      .trim()
      .isLength({ min: 3, max: 254 })
      .withMessage("Username or email must be between 3 and 254 characters"),
    oneOf(
      [
        body("email").isEmail(),
        body("email").isLength({ max: 40 }).matches(usernamePattern),
      ],
      { message: "Enter a valid username or email" }
    ),
    body("password")
      .isString()
      .withMessage("Password must be provided")
      .bail()
      .trim()
      .notEmpty()
      .withMessage("Password must be provided"),
  ],
  validateRequest,
  async (req: Request<{}, {}, LoginBody>, res: Response) => {
    const { email: identifier, password } = req.body;
    const identifierNormalized = normalizeIdentifier(identifier);

    const existingUser =
      (await User.findOne({ identifierNormalized })) ||
      (await User.findOne({ email: identifier }));

    if (!existingUser) {
      await logLoginAttempt(req, identifier);
      throw new BadRequestError("Invalid credentials");
    }

    if (!(await Password.compare(existingUser.password, password))) {
      await logLoginAttempt(req, identifier);
      throw new BadRequestError("Invalid credentials");
    }

    const userJwt = jwt.sign(
      {
        id: existingUser.id,
        email: existingUser.email,
        timestamp: new Date(),
      },
      process.env.JWT_KEY!
    );

    req.session = {
      jwt: userJwt,
    };

    existingUser.set({ lastLogin: new Date().toISOString() });
    await existingUser.save();

    res.status(200).send(toPublicUser(existingUser));
  }
);

export { router as loginRouter };
