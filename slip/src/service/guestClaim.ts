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
  const foundDraft = await findDraftSlipForUser(guestPrincipal, betKind).lean();
  if (!foundDraft) {
    return;
  }

  // A bet in flight owns the user's board of this kind; the guest draft is
  // left untouched and claimed on a later load.
  if (await Slip.exists(buildSlipScope(SlipStatus.SUBMITTED, betKind, userId))) {
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

  // The user's board wins: a row it refuses is dropped with the guest draft,
  // never retried, so a pick the user removed cannot come back on a later load.
  for (const row of guestDraft.rows) {
    await upsertDraftSlipRow(userId, betKind, {
      ...row,
      betKind,
    });
  }

  // Placement may have won the race after the first check; nothing was applied,
  // so keep the guest draft for a later load.
  if (await Slip.exists(buildSlipScope(SlipStatus.SUBMITTED, betKind, userId))) {
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
): Promise<void> => {
  for (const betKind of [BetKind.PRE_MATCH, BetKind.LIVE]) {
    await claimGuestDraft(userId, guestPrincipal, betKind);
  }
};
