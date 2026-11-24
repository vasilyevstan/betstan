import express, { Request, Response } from "express";
import { SlipStatus } from "@betstan/common";
import { Slip } from "../model/Slip";
import {
  boardFingerprintOf,
  boardRevisionOf,
  buildSlipScope,
  findDraftSlipByIdForUser,
  isValidSlipId,
  normalizeSlip,
  parseRequestedBetKind,
  persistSlipBoardIdentityIfNeeded,
} from "../model/slipSupport";
import { resolveSlipOwner } from "../service/guestIdentity";

const router = express.Router();
const BOARD_CHANGED_MESSAGE =
  "This board changed before it was cleaned. Reload and try again.";

const sendBoardConflict = (res: Response) =>
  res.status(409).send({ message: BOARD_CHANGED_MESSAGE });

router.post("/api/slip/row/clean", async (req: Request, res: Response) => {
  const { slipId, betKind: requestedBetKind } = req.body;
  const owner = resolveSlipOwner(req);

  if (!owner) {
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
    owner.id,
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

  const boardFingerprint = boardFingerprintOf(authoritativeSlip);
  if (!boardFingerprint) {
    return sendBoardConflict(res);
  }

  const deleted = await Slip.deleteOne({
    ...buildSlipScope(
      SlipStatus.DRAFT,
      betKind,
      owner.id,
      slipId
    ),
    boardRevision: boardRevisionOf(authoritativeSlip),
    boardFingerprint,
  });

  if (deleted.deletedCount !== 1) {
    return sendBoardConflict(res);
  }

  return res.sendStatus(200);
});

export { router as CleanSlip };
