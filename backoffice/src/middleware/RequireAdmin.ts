import { NextFunction, Request, Response } from "express";
import {
  AdminSessionVerifier,
  verifyAdminSession,
} from "../service/VerifyAdminSession";

let sessionVerifier: AdminSessionVerifier = verifyAdminSession;

export const setAdminSessionVerifierForTests = (
  verifier: AdminSessionVerifier
) => {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Admin session verifier can only be replaced in tests");
  }

  sessionVerifier = verifier;
};

export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.currentUser) {
    return res.status(401).send({
      errors: [{ message: "Authentication required" }],
    });
  }

  const role = (req.currentUser as typeof req.currentUser & { role?: string })
    .role;
  if (role !== "ADMIN") {
    return res.status(403).send({
      errors: [{ message: "Administrator role required" }],
    });
  }

  try {
    const status = await sessionVerifier(req.headers.cookie ?? "");
    if (status === 204) {
      next();
      return;
    }

    const message =
      status === 401
        ? "Authentication required"
        : "Administrator role required";
    res.status(status).send({ errors: [{ message }] });
  } catch (_error) {
    console.error("Administrator session verification failed");
    res.status(503).send({
      errors: [{ message: "Authorization service unavailable" }],
    });
  }
};
