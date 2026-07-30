import express, { Request, Response } from "express";
import { body } from "express-validator";
import { User } from "../model/User";
import jwt from "jsonwebtoken";
import { validateRequest, BadRequestError } from "@betstan/common";
import {
  isDuplicateKeyError,
  normalizeIdentifier,
  toPublicUser,
} from "../service/Identifier";

const router = express.Router();
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._%+@-]*$/;

type NewUserBody = {
  email: string;
  password: string;
};

router.post(
  "/api/auth/new",
  [
    body("email")
      .isString()
      .withMessage("Username must be text")
      .bail()
      .trim()
      .isLength({ min: 3, max: 40 })
      .withMessage("Username must be between 3 and 40 characters")
      .bail()
      .matches(identifierPattern)
      .withMessage(
        "Username may contain letters, numbers, dots, underscores, hyphens, +, %, and @"
      ),
    body("password")
      .isString()
      .withMessage("Password must be provided")
      .bail()
      .trim()
      .isLength({ min: 4, max: 20 })
      .withMessage("Password must be between 4 and 20 characters"),
  ],
  validateRequest,
  async (req: Request<{}, {}, NewUserBody>, res: Response) => {
    const { email: identifier, password } = req.body;
    const identifierNormalized = normalizeIdentifier(identifier);
    const existingUser = await User.findOne({
      $or: [{ identifierNormalized }, { email: identifier }],
    }).collation({ locale: "en", strength: 2 });

    if (existingUser) {
      throw new BadRequestError("That username is already in use");
    }

    try {
      const user = await User.create({
        email: identifier,
        identifierNormalized,
        password,
        timestamp: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
      });

      const userJwt = jwt.sign(
        {
          id: user.id,
          email: user.email,
          timestamp: new Date(),
        },
        process.env.JWT_KEY!
      );

      req.session = {
        jwt: userJwt,
      };

      return res.status(201).send(toPublicUser(user));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new BadRequestError("That username is already in use");
      }

      throw error;
    }
  }
);

export { router as newUser };
