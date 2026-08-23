import { NextFunction, Request, Response } from "express";
import { verifyAdminRequest } from "../service/VerifyAdminSession";

const EVENT_ID_PATTERN = /^[a-f0-9]{24}$/;
const MAX_ACCEPTANCE_EVENTS = 10;

declare global {
  namespace Express {
    interface Request {
      visibleOfflineEventIds?: string[];
    }
  }
}

const parseAcceptanceEventIds = (value: unknown): string[] | null => {
  if (value === undefined) {
    return [];
  }
  if (typeof value !== "string") {
    return null;
  }

  const ids = value.split(",");
  if (
    ids.length === 0
    || ids.length > MAX_ACCEPTANCE_EVENTS
    || ids.some((eventId) => !EVENT_ID_PATTERN.test(eventId))
    || new Set(ids).size !== ids.length
  ) {
    return null;
  }

  return ids;
};

export const authorizeAcceptanceEventAccess = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const eventIds = parseAcceptanceEventIds(req.query.acceptanceEventIds);
  if (eventIds === null) {
    return res.status(400).send({
      errors: [{ message: "acceptanceEventIds is invalid" }],
    });
  }
  if (eventIds.length === 0) {
    req.visibleOfflineEventIds = [];
    next();
    return;
  }

  try {
    const status = await verifyAdminRequest(req);
    if (status !== 204) {
      return res.status(status).send({
        errors: [{
          message:
            status === 401
              ? "Authentication required"
              : "Administrator role required",
        }],
      });
    }

    req.visibleOfflineEventIds = eventIds;
    next();
  } catch (_error) {
    console.error("Acceptance event authorization failed");
    return res.status(503).send({
      errors: [{ message: "Authorization service unavailable" }],
    });
  }
};
