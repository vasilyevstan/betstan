import express, { Request, Response } from "express";
import { SlipStatus } from "@betstan/common";
import { Slip } from "../model/Slip";
import {
  boardFingerprintOf,
  boardRevisionOf,
  buildSlipScope,
  createBoardFingerprint,
  findDraftSlipByIdForUser,
  isValidSlipId,
  normalizeSlip,
  parseRequestedBetKind,
  persistSlipBoardIdentityIfNeeded,
  rowIdOf,
} from "../model/slipSupport";

const router = express.Router();
const BOARD_CHANGED_MESSAGE =
  "This board changed before the row was removed. Reload and try again.";

const sendBoardConflict = (res: Response) =>
  res.status(409).send({ message: BOARD_CHANGED_MESSAGE });

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

  const authoritativeSlip = await persistSlipBoardIdentityIfNeeded(slip);
  normalizeSlip(authoritativeSlip, betKind);

  if (authoritativeSlip.status !== SlipStatus.DRAFT) {
    return sendBoardConflict(res);
  }

  const rows = Array.from(authoritativeSlip.rows);
  const targetRowId = typeof slipRowId === "string" ? slipRowId : "";
  const updatedSlipRows = rows.filter((row) => rowIdOf(row) !== targetRowId);

  if (updatedSlipRows.length === rows.length) {
    return res.sendStatus(200);
  }

  const expectedBoardRevision = boardRevisionOf(authoritativeSlip);
  const expectedBoardFingerprint = boardFingerprintOf(authoritativeSlip);

  if (!expectedBoardFingerprint) {
    return sendBoardConflict(res);
  }

  const mutationScope = {
    ...buildSlipScope(
      SlipStatus.DRAFT,
      betKind,
      req.currentUser.id,
      slipId
    ),
    boardRevision: expectedBoardRevision,
    boardFingerprint: expectedBoardFingerprint,
  };

  if (updatedSlipRows.length === 0) {
    const deleted = await Slip.deleteOne(mutationScope);

    if (deleted.deletedCount !== 1) {
      return sendBoardConflict(res);
    }
  } else {
    const updatedSlip = await Slip.findOneAndUpdate(
      mutationScope,
      {
        $set: {
          betKind,
          draftKey: betKind,
          rows: updatedSlipRows,
          boardRevision: expectedBoardRevision + 1,
          boardFingerprint: createBoardFingerprint(),
        },
        $unset: {
          declineReason: 1,
        },
      },
      { new: true }
    );

    if (!updatedSlip) {
      return sendBoardConflict(res);
    }
  }

  return res.sendStatus(200);
});

export { router as DeleteSlipRow };
