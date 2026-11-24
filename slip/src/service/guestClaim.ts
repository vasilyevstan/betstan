import { BetKind, SlipStatus } from "@betstan/common";
import { Slip } from "../model/Slip";
import {
  MutableSlip,
  PlainSlip,
  boardFingerprintOf,
  boardRevisionOf,
  buildSlipScope,
  findDraftSlipForUser,
  persistSlipBoardIdentityIfNeeded,
  slipIdOf,
  upsertDraftSlipRow,
} from "../model/slipSupport";

const claimGuestDraft = async (
  userId: string,
  guestPrincipal: string,
  betKind: BetKind
) => {
  // A bet in flight owns the user's board of this kind; the guest draft is
  // left untouched and claimed on a later load.
  if (await Slip.exists(buildSlipScope(SlipStatus.SUBMITTED, betKind, userId))) {
    return;
  }

  const foundDraft = await findDraftSlipForUser(guestPrincipal, betKind).lean();
  if (!foundDraft) {
    return;
  }

  const guestDraft = (await persistSlipBoardIdentityIfNeeded(
    foundDraft as unknown as MutableSlip
  )) as PlainSlip;
  const guestDraftId = slipIdOf(guestDraft);
  const boardFingerprint = boardFingerprintOf(guestDraft);
  if (!guestDraftId || !boardFingerprint) {
    return;
  }

  let fullyMerged = true;
  for (const row of guestDraft.rows) {
    const { accepted } = await upsertDraftSlipRow(userId, betKind, {
      ...row,
      betKind,
    });
    fullyMerged = fullyMerged && accepted;
  }

  if (!fullyMerged) {
    return;
  }

  // Scoped to the revision that was merged: a guest write that landed in the
  // meantime keeps the draft for the next claim instead of losing that row.
  await Slip.deleteOne({
    ...buildSlipScope(SlipStatus.DRAFT, betKind, guestPrincipal, guestDraftId),
    boardRevision: boardRevisionOf(guestDraft),
    boardFingerprint,
  });
};

export const claimGuestDrafts = async (
  userId: string,
  guestPrincipal: string
): Promise<{ remaining: boolean }> => {
  for (const betKind of [BetKind.PRE_MATCH, BetKind.LIVE]) {
    await claimGuestDraft(userId, guestPrincipal, betKind);
  }

  return {
    remaining: Boolean(
      await Slip.exists({ userId: guestPrincipal, status: SlipStatus.DRAFT })
    ),
  };
};
