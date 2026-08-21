import express, { Request, Response } from "express";
import {
  clearSlipDeclineReason,
  findDraftSlipByIdForUser,
  isValidSlipId,
  parseRequestedBetKind,
  rowIdOf,
} from "../model/slipSupport";

const router = express.Router();

router.post("/api/slip/row", async (req: Request, res: Response) => {
  const { slipId, slipRowId, betKind: requestedBetKind } = req.body;

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

  const targetRowId = typeof slipRowId === "string" ? slipRowId : "";
  const updatedSlipRows = slip.rows.filter((row) => rowIdOf(row) !== targetRowId);

  if (updatedSlipRows.length === slip.rows.length) {
    return res.sendStatus(200);
  }

  if (updatedSlipRows.length === 0) {
    await slip.deleteOne();
  } else {
    slip.set({ rows: updatedSlipRows });
    clearSlipDeclineReason(slip);
    await slip.save();
  }

  return res.sendStatus(200);
});

export { router as DeleteSlipRow };
