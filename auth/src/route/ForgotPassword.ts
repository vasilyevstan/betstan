import express, { Request, Response } from "express";
import { body, oneOf } from "express-validator";
import { validateRequest } from "@betstan/common";
import { User } from "../model/User";
import { Password } from "../service/Password";
import { normalizeIdentifier, usernamePattern } from "../service/Identifier";

const router = express.Router();

// Product decision: anyone who names an account resets it to this public
// constant. It applies to every account and needs no proof of ownership.
const RESET_PASSWORD = "abcdef";

type ForgotPasswordBody = {
  email: string;
};

router.post(
  "/api/auth/forgot-password",
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
  ],
  validateRequest,
  async (req: Request<{}, {}, ForgotPasswordBody>, res: Response) => {
    const { email: identifier } = req.body;
    const identifierNormalized = normalizeIdentifier(identifier);

    // Hash before the lookup so a known and an unknown account take the same time.
    const password = await Password.toHash(RESET_PASSWORD);

    // The User save hook only hashes the password, so one atomic update of that
    // field replaces it. The lookup mirrors login: normalized identifier first,
    // then the legacy email.
    const reset = await User.updateOne({ identifierNormalized }, { $set: { password } });
    if (reset.matchedCount === 0) {
      await User.updateOne({ email: identifier }, { $set: { password } });
    }

    // Identical for every outcome so the response never reveals whether the account exists.
    res.status(200).send({ status: "ok" });
  }
);

export { router as forgotPasswordRouter };
