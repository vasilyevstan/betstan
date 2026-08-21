import express, { Request, Response } from "express";
import { BetKind } from "@betstan/common";
import {
  findActiveSlipForUser,
  findDraftSlipForUser,
  normalizeSlip,
  parseRequestedBetKind,
} from "../model/slipSupport";

const router = express.Router();

router.get("/api/slip/boards", async (req: Request, res: Response) => {
  if (!req.currentUser) {
    return res.send({
      [BetKind.PRE_MATCH]: null,
      [BetKind.LIVE]: null,
    });
  }

  const [preMatchSlip, liveSlip] = await Promise.all([
    findActiveSlipForUser(req.currentUser.id, BetKind.PRE_MATCH),
    findActiveSlipForUser(req.currentUser.id, BetKind.LIVE),
  ]);

  return res.send({
    [BetKind.PRE_MATCH]: preMatchSlip ?? null,
    [BetKind.LIVE]: liveSlip ?? null,
  });
});

router.get("/api/slip", async (req: Request, res: Response) => {
  if (!req.currentUser) {
    return res.send({});
  }

  const betKind = parseRequestedBetKind(req.query.betKind);

  if (!betKind) {
    return res.status(400).send({ message: "Invalid bet kind" });
  }

  const slip = await findDraftSlipForUser(req.currentUser.id, betKind);

  if (slip) {
    normalizeSlip(slip, betKind);
  }

  return res.send(slip ?? null);
});

export { router as ShowSlip };
