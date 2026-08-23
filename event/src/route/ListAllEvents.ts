import express, { Request, Response } from "express";
import { listPublicEvents } from "../live/LiveEventReadModel";
import { authorizeAcceptanceEventAccess } from "../middleware/AcceptanceEventAccess";

const router = express.Router();

router.get(
  "/api/event",
  authorizeAcceptanceEventAccess,
  async (req: Request, res: Response) => {
    res.send(await listPublicEvents(new Date(), req.visibleOfflineEventIds));
  }
);

export { router as ListllEvents };
