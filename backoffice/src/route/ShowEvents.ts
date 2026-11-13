import express, { Request, Response } from "express";
import { EventStatus } from "@betstan/common";
import { Event } from "../model/Event";

const router = express.Router();

// Finished events leave the Backoffice list a day after kickoff. Their records,
// bets and history are kept; only the operator list is trimmed.
export const FINISHED_EVENT_LIST_RETENTION_MS = 24 * 60 * 60 * 1000;

router.get("/api/backoffice", async (_req: Request, res: Response) => {
  const finishedCutoff = new Date(Date.now() - FINISHED_EVENT_LIST_RETENTION_MS).toISOString();
  const events = await Event.find({
    $or: [
      { status: { $ne: EventStatus.RESULTED } },
      { time: { $gte: finishedCutoff } },
      // A published manual market still needs its operator-declared result.
      { customMarkets: { $elemMatch: {
        "template.definition.settlementMode": "MANUAL",
        publishedConfiguration: { $exists: true },
        decision: { $exists: false },
      } } },
    ],
  }).sort({ status: 1, time: 1 });

  res.send(events);
});

export { router as ShowEvents };
