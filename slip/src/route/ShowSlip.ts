import express, { Request, Response } from "express";
import { BetKind } from "@betstan/common";
import {
  buildLegacyBoardSessionScope,
  findActiveSlipForUser,
  findDraftSlipForUser,
  normalizeSlip,
  parseRequestedBetKind,
  persistSlipBoardIdentityIfNeeded,
} from "../model/slipSupport";

const router = express.Router();

const prepareSlipForResponse = async (
  slip: Parameters<typeof normalizeSlip>[0],
  betKind: Parameters<typeof normalizeSlip>[1],
  legacyConfirmationScope: string | null = null
) => {
  const authoritativeSlip = await persistSlipBoardIdentityIfNeeded(slip, {
    legacyConfirmationScope,
  });
  normalizeSlip(authoritativeSlip, betKind);
  return authoritativeSlip;
};

router.get("/api/slip/boards", async (req: Request, res: Response) => {
  if (!req.currentUser) {
    return res.send({
      [BetKind.PRE_MATCH]: null,
      [BetKind.LIVE]: null,
    });
  }

  const [foundPreMatchSlip, foundLiveSlip] = await Promise.all([
    findActiveSlipForUser(req.currentUser.id, BetKind.PRE_MATCH),
    findActiveSlipForUser(req.currentUser.id, BetKind.LIVE),
  ]);
  const legacyConfirmationScope = buildLegacyBoardSessionScope(
    req.session?.jwt
  );

  const [preMatchSlip, liveSlip] = await Promise.all([
    foundPreMatchSlip
      ? prepareSlipForResponse(
          foundPreMatchSlip,
          BetKind.PRE_MATCH,
          legacyConfirmationScope
        )
      : Promise.resolve(null),
    foundLiveSlip
      ? prepareSlipForResponse(
          foundLiveSlip,
          BetKind.LIVE,
          legacyConfirmationScope
        )
      : Promise.resolve(null),
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

  const foundSlip = await findDraftSlipForUser(req.currentUser.id, betKind);
  const legacyConfirmationScope = buildLegacyBoardSessionScope(
    req.session?.jwt
  );
  const slip = foundSlip
    ? await prepareSlipForResponse(
        foundSlip,
        betKind,
        legacyConfirmationScope
      )
    : null;

  return res.send(slip ?? null);
});

export { router as ShowSlip };
