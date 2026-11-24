import express, { Request, Response } from "express";
import { BetKind, SlipStatus } from "@betstan/common";
import {
  buildLegacyBoardSessionScope,
  findActiveSlipForUser,
  findDraftSlipForUser,
  normalizeSlip,
  parseRequestedBetKind,
  persistSlipBoardIdentityIfNeeded,
} from "../model/slipSupport";
import { claimGuestDrafts } from "../service/guestClaim";
import {
  SlipOwner,
  readGuestPrincipal,
  resolveSlipOwner,
  toOwnerFacingSlip,
} from "../service/guestIdentity";

const router = express.Router();

const prepareSlipForResponse = async (
  slip: Parameters<typeof normalizeSlip>[0],
  betKind: Parameters<typeof normalizeSlip>[1],
  owner: SlipOwner,
  legacyConfirmationScope: string | null = null
) => {
  const authoritativeSlip = await persistSlipBoardIdentityIfNeeded(slip, {
    legacyConfirmationScope:
      slip.status === SlipStatus.DRAFT
        ? legacyConfirmationScope
        : null,
  });
  normalizeSlip(authoritativeSlip, betKind);
  return toOwnerFacingSlip(owner, authoritativeSlip);
};

// Legacy confirmations belong to signed-in sessions; a guest never records one.
const legacyConfirmationScopeFor = (owner: SlipOwner, req: Request) =>
  owner.isGuest ? null : buildLegacyBoardSessionScope(req.session?.jwt);

// The guest cookie is left in place: a pick still in flight when the claim ran
// is merged by the next load, and the TTL removes whatever is never claimed.
const claimGuestSlipOnLogin = async (req: Request, userId: string) => {
  const guestPrincipal = readGuestPrincipal(req);

  if (!guestPrincipal) {
    return;
  }

  try {
    await claimGuestDrafts(userId, guestPrincipal);
  } catch {
    // The signed-in boards must still load; the claim is retried on a later load.
    console.error("slip_guest_claim_failed");
  }
};

router.get("/api/slip/boards", async (req: Request, res: Response) => {
  const owner = resolveSlipOwner(req);

  if (!owner) {
    return res.send({
      [BetKind.PRE_MATCH]: null,
      [BetKind.LIVE]: null,
    });
  }

  if (!owner.isGuest) {
    await claimGuestSlipOnLogin(req, owner.id);
  }

  const [foundPreMatchSlip, foundLiveSlip] = await Promise.all([
    findActiveSlipForUser(owner.id, BetKind.PRE_MATCH),
    findActiveSlipForUser(owner.id, BetKind.LIVE),
  ]);
  const legacyConfirmationScope = legacyConfirmationScopeFor(owner, req);

  const [preMatchSlip, liveSlip] = await Promise.all([
    foundPreMatchSlip
      ? prepareSlipForResponse(
          foundPreMatchSlip,
          BetKind.PRE_MATCH,
          owner,
          legacyConfirmationScope
        )
      : Promise.resolve(null),
    foundLiveSlip
      ? prepareSlipForResponse(
          foundLiveSlip,
          BetKind.LIVE,
          owner,
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
  const owner = resolveSlipOwner(req);

  if (!owner) {
    return res.send({});
  }

  const betKind = parseRequestedBetKind(req.query.betKind);

  if (!betKind) {
    return res.status(400).send({ message: "Invalid bet kind" });
  }

  const foundSlip = await findDraftSlipForUser(owner.id, betKind);
  const legacyConfirmationScope = legacyConfirmationScopeFor(owner, req);
  const slip = foundSlip
    ? await prepareSlipForResponse(
        foundSlip,
        betKind,
        owner,
        legacyConfirmationScope
      )
    : null;

  return res.send(slip ?? null);
});

export { router as ShowSlip };
