import express, { Request, Response } from "express";
import { body, oneOf } from "express-validator";
import { User, UserRole } from "../model/User";
import jwt from "jsonwebtoken";
import { validateRequest, BadRequestError } from "@betstan/common";
import {
  isDuplicateKeyError,
  normalizeIdentifier,
  toPublicUser,
  usernamePattern,
} from "../service/Identifier";

const router = express.Router();

type NewUserBody = {
  email: string;
  password: string;
};

router.post(
  "/api/auth/new",
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
      {
        message:
          "Enter a valid email or a username containing letters, numbers, dots, underscores, hyphens, +, %, or @",
      }
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
        role: UserRole.USER,
        timestamp: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
      });

      const userJwt = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          timestamp: new Date(),
        },
        process.env.JWT_KEY!,
        { expiresIn: "12h" }
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
