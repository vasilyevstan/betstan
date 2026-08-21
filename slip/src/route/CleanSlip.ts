import express, { Request, Response } from "express";
import {
  findDraftSlipByIdForUser,
  isValidSlipId,
  parseRequestedBetKind,
} from "../model/slipSupport";

const router = express.Router();

router.post("/api/slip/row/clean", async (req: Request, res: Response) => {
  const { slipId, betKind: requestedBetKind } = req.body;

  if (!req.currentUser) {
    return res.status(400).send({ message: "must login first" });
  }

  const betKind = parseRequestedBetKind(requestedBetKind);

  if (!betKind) {
    return res.status(400).send({ message: "Invalid bet kind" });
  }

  if (!isValidSlipId(slipId)) {
    return res.status(400).send({ message: "slip does not exist" });
  }

  const slip = await findDraftSlipByIdForUser(
    slipId,
    req.currentUser.id,
    betKind
  );

  if (!slip) {
    return res.status(400).send({ message: "slip does not exist" });
  }

  await slip.deleteOne();

  return res.sendStatus(200);
});

export { router as CleanSlip };
