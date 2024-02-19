import express, { Request, Response } from "express";
import { body } from "express-validator";
import { User } from "../model/User";
import { Password } from "../service/Password";
import jwt from "jsonwebtoken";
import { BadRequestError, validateRequest } from "@betstan/common";

const router = express.Router();

router.post(
  "/api/auth/login",
  [
    body("email").isEmail().withMessage("Email must be valid"),
    body("password").trim().notEmpty().withMessage("Password must be provided"),
  ],
  validateRequest,
  async (req: Request, res: Response) => {
    const { email, password } = req.body;

    const existingUser = await User.findOne({ email });

    if (!existingUser) {
      throw new BadRequestError("Invalid credentials");
    }

    if (!(await Password.compare(existingUser.password, password))) {
      throw new BadRequestError("Invalid credentials");
    }

    // generate jwt
    const userJwt = jwt.sign(
      {
        id: existingUser.id,
        email: existingUser.email,
        timestamp: new Date(),
      },
      process.env.JWT_KEY!
    );

    // store jwt in session object
    req.session = {
      jwt: userJwt,
    };

    res.status(200).send(existingUser);
  }
);

export { router as loginRouter };
