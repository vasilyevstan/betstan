import express, { Request, Response } from "express";
import { body } from "express-validator";
import { User } from "../model/User";
import jwt from "jsonwebtoken";
import { validateRequest, BadRequestError } from "@betstan/common";

const router = express.Router();

router.post(
  "/api/auth/new",
  [
    body("email").isEmail().withMessage("email must be provided"),
    body("password")
      .trim()
      .isLength({ min: 4, max: 20 })
      .withMessage("Password must be between 4 and 20 characters"),
  ],
  validateRequest,
  async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      throw new BadRequestError("Email is in use");
    }

    const user = await User.create({
      email,
      password,
      timestamp: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
    });
    await user.save();

    // generate jwt
    const userJwt = jwt.sign(
      {
        id: user.id,
        email: user.email,
        timestamp: new Date(),
      },
      process.env.JWT_KEY!
    );

    // store jwt in session object
    req.session = {
      jwt: userJwt,
    };

    res.status(201).send(user);
  }
);

export { router as newUser };
