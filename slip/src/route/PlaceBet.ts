import express, { Request, Response } from "express";
import { BetKind, messengerWrapper } from "@betstan/common";
import {
  createPlacementAttemptId,
  findDraftSlipByIdForUser,
  findSubmittedSlipByIdForUser,
  isValidSlipId,
  legacyBoardConfirmationOf,
  normalizeSlip,
  parseExpectedBoardFingerprint,
  parseExpectedBoardRevision,
  parsePlacementAttemptId,
  parseRequestedBetKind,
  persistSlipBoardIdentityIfNeeded,
  slipHasMixedBetKinds,
  submissionMatchesBoardConfirmation,
  submissionMatchesPlacementAttempt,
  submissionMatchesPlacementPayload,
  submittedPlacementAttemptIdOf,
} from "../model/slipSupport";
import {
  SlipSubmissionWorker,
  submitDraftSlipAtomically,
} from "../service/SlipSubmissionWorker";

const router = express.Router();
const PLACEMENT_ATTEMPT_ID_HEADER = "x-placement-attempt-id";
const PLACEMENT_OUTCOME_HEADER = "x-placement-outcome";
const RELOAD_REQUIRED_REASON = "board-mismatch" as const;
const RELOAD_REQUIRED_MESSAGE =
  "This board changed before placement. Review the latest selections and try again.";

type PlacementOutcome = "accepted" | "idempotent" | "conflict";

interface PlacementMetadata {
  requestedPlacementAttemptId: string | null;
  authoritativePlacementAttemptId: string | null;
  outcome: PlacementOutcome;
  isLegacyRequest: boolean;
}

interface BoardConfirmation {
  expectedBoardRevision: number;
  expectedBoardFingerprint: string;
}

let _submissionWorker: SlipSubmissionWorker | null = null;
const getSubmissionWorker = async (): Promise<SlipSubmissionWorker> => {
  if (!_submissionWorker) {
    const submissionWorker = new SlipSubmissionWorker(
      messengerWrapper.connection
    );
    await submissionWorker.init();
    _submissionWorker = submissionWorker;
  }
  return _submissionWorker;
};

const wasAttemptIdProvided = (value: unknown) =>
  !(value === undefined || value === null || value === "");

const extractPlacementAttemptId = (req: Request) => {
  const rawBodyPlacementAttemptId = req.body?.placementAttemptId;
  const rawHeaderPlacementAttemptId = req.get(PLACEMENT_ATTEMPT_ID_HEADER);
  const bodyPlacementAttemptId = parsePlacementAttemptId(
    rawBodyPlacementAttemptId
  );
  const headerPlacementAttemptId = parsePlacementAttemptId(
    rawHeaderPlacementAttemptId
  );

  if (
    wasAttemptIdProvided(rawBodyPlacementAttemptId)
    && !bodyPlacementAttemptId
  ) {
    return { error: "Invalid placement attempt id" as const };
  }

  if (
    wasAttemptIdProvided(rawHeaderPlacementAttemptId)
    && !headerPlacementAttemptId
  ) {
    return { error: "Invalid placement attempt id" as const };
  }

  if (
    bodyPlacementAttemptId
    && headerPlacementAttemptId
    && bodyPlacementAttemptId !== headerPlacementAttemptId
  ) {
    return { error: "Conflicting placement attempt ids" as const };
  }

  return {
    placementAttemptId: bodyPlacementAttemptId ?? headerPlacementAttemptId ?? null,
    hasExplicitPlacementAttemptId: Boolean(
      bodyPlacementAttemptId ?? headerPlacementAttemptId
    ),
  };
};

const extractBoardConfirmation = (req: Request) => {
  const rawBoardRevision = req.body?.expectedBoardRevision;
  const rawBoardFingerprint = req.body?.expectedBoardFingerprint;
  const hasBoardRevision = wasAttemptIdProvided(rawBoardRevision);
  const hasBoardFingerprint = wasAttemptIdProvided(rawBoardFingerprint);

  if (!hasBoardRevision && !hasBoardFingerprint) {
    return { confirmation: null };
  }

  if (!hasBoardRevision || !hasBoardFingerprint) {
    return { error: "Missing board confirmation" as const };
  }

  const expectedBoardRevision = parseExpectedBoardRevision(rawBoardRevision);
  if (expectedBoardRevision === null) {
    return { error: "Invalid board revision" as const };
  }

  const expectedBoardFingerprint = parseExpectedBoardFingerprint(
    rawBoardFingerprint
  );
  if (!expectedBoardFingerprint) {
    return { error: "Invalid board fingerprint" as const };
  }

  return {
    confirmation: {
      expectedBoardRevision,
      expectedBoardFingerprint,
    } satisfies BoardConfirmation,
  };
};

const toResponseSlip = (slip: unknown, placement: PlacementMetadata) => ({
  ...(JSON.parse(JSON.stringify(slip)) as Record<string, unknown>),
  placement,
});

const setPlacementHeaders = (res: Response, placement: PlacementMetadata) => {
  res.set(PLACEMENT_OUTCOME_HEADER, placement.outcome);

  if (placement.authoritativePlacementAttemptId) {
    res.set(
      PLACEMENT_ATTEMPT_ID_HEADER,
      placement.authoritativePlacementAttemptId
    );
  }
};

const prepareSlipForResponse = async (
  slip: any,
  betKind: Parameters<typeof normalizeSlip>[1]
): Promise<any> => {
  const authoritativeSlip = await persistSlipBoardIdentityIfNeeded(slip);
  normalizeSlip(authoritativeSlip, betKind);
  return authoritativeSlip;
};

const buildConflictPlacement = (
  requestedPlacementAttemptId: string | null,
  authoritativePlacementAttemptId: string | null,
  isLegacyRequest: boolean
): PlacementMetadata => ({
  requestedPlacementAttemptId,
  authoritativePlacementAttemptId,
  outcome: "conflict",
  isLegacyRequest,
});

const sendReloadConflict = async (
  res: Response,
  {
    draftSlip,
    requestedPlacementAttemptId,
    isLegacyRequest,
  }: {
    draftSlip?: Awaited<ReturnType<typeof findDraftSlipByIdForUser>> | null;
    requestedPlacementAttemptId: string | null;
    isLegacyRequest: boolean;
  }
) => {
  if (draftSlip) {
    draftSlip = await prepareSlipForResponse(draftSlip, draftSlip.betKind);
  }

  const placement = buildConflictPlacement(
    requestedPlacementAttemptId,
    null,
    isLegacyRequest
  );
  setPlacementHeaders(res, placement);

  return res.status(409).send({
    message: RELOAD_REQUIRED_MESSAGE,
    slip: draftSlip ? toResponseSlip(draftSlip, placement) : null,
    placement,
    reload: {
      required: true,
      reason: RELOAD_REQUIRED_REASON,
    },
  });
};

const sendSubmittedPlacementResponse = async (
  res: Response,
  {
    submittedSlip,
    requestedPlacementAttemptId,
    hasExplicitPlacementAttemptId,
    parsedWager,
    betKind,
  }: {
    submittedSlip: any;
    requestedPlacementAttemptId: string | null;
    hasExplicitPlacementAttemptId: boolean;
    parsedWager: number;
    betKind: NonNullable<ReturnType<typeof parseRequestedBetKind>>;
  }
) => {
  submittedSlip = await prepareSlipForResponse(submittedSlip, betKind);

  const authoritativePlacementAttemptId =
    submittedPlacementAttemptIdOf(submittedSlip);

  if (
    !hasExplicitPlacementAttemptId
    || !submissionMatchesPlacementAttempt(
      submittedSlip,
      requestedPlacementAttemptId
    )
  ) {
    const placement = buildConflictPlacement(
      requestedPlacementAttemptId,
      authoritativePlacementAttemptId,
      !hasExplicitPlacementAttemptId
    );
    setPlacementHeaders(res, placement);
    return res.status(409).send({
      message: "slip already submitted by another placement attempt",
      slip: toResponseSlip(submittedSlip, placement),
      placement,
    });
  }

  if (
    !submissionMatchesPlacementPayload(submittedSlip, {
      placementAttemptId: requestedPlacementAttemptId,
      wager: parsedWager,
      betKind,
    })
  ) {
    const placement = buildConflictPlacement(
      requestedPlacementAttemptId,
      authoritativePlacementAttemptId,
      false
    );
    setPlacementHeaders(res, placement);
    return res.status(409).send({
      message: "placement attempt conflicts with submitted slip",
      slip: toResponseSlip(submittedSlip, placement),
      placement,
    });
  }

  const placement = {
    requestedPlacementAttemptId,
    authoritativePlacementAttemptId,
    outcome: "idempotent" as const,
    isLegacyRequest: false,
  };
  setPlacementHeaders(res, placement);
  return res.status(200).send(toResponseSlip(submittedSlip, placement));
};

router.post("/api/slip/bet", async (req: Request, res: Response) => {
  const { slipId, wager, betKind: requestedBetKind } = req.body;

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

  const parsedWager = typeof wager === "number" ? wager : Number(wager);

  if (!Number.isFinite(parsedWager) || parsedWager <= 0) {
    return res.status(400).send({ message: "Wager must be a number" });
  }

  const placementAttemptResult = extractPlacementAttemptId(req);
  if ("error" in placementAttemptResult) {
    return res.status(400).send({ message: placementAttemptResult.error });
  }

  const boardConfirmationResult = extractBoardConfirmation(req);
  if ("error" in boardConfirmationResult) {
    return res.status(400).send({ message: boardConfirmationResult.error });
  }

  const requestedPlacementAttemptId = placementAttemptResult.placementAttemptId;
  const hasExplicitPlacementAttemptId =
    placementAttemptResult.hasExplicitPlacementAttemptId;
  const placementAttemptId =
    requestedPlacementAttemptId ?? createPlacementAttemptId();
  const userName = req.currentUser.email ?? req.currentUser.id;
  let boardConfirmation = boardConfirmationResult.confirmation;

  let authoritativeDraft = await findDraftSlipByIdForUser(
    slipId,
    req.currentUser.id,
    betKind
  );

  if (authoritativeDraft) {
    const preparedDraft = await prepareSlipForResponse(
      authoritativeDraft,
      betKind
    );
    authoritativeDraft = preparedDraft;
    boardConfirmation =
      boardConfirmation
      ?? (
        betKind === BetKind.PRE_MATCH
        && !hasExplicitPlacementAttemptId
          ? legacyBoardConfirmationOf(preparedDraft)
          : null
      );

    if (!boardConfirmation) {
      return res.status(400).send({ message: "Missing board confirmation" });
    }

    if (slipHasMixedBetKinds(preparedDraft, betKind)) {
      return res.status(400).send({ message: "slip contains mixed bet kinds" });
    }

    if (
      !submissionMatchesBoardConfirmation(
        preparedDraft,
        boardConfirmation
      )
    ) {
      return sendReloadConflict(res, {
        draftSlip: preparedDraft,
        requestedPlacementAttemptId,
        isLegacyRequest: !hasExplicitPlacementAttemptId,
      });
    }
  } else {
    const submittedSlip = await findSubmittedSlipByIdForUser(
      slipId,
      req.currentUser.id,
      betKind
    );

    if (submittedSlip) {
      return sendSubmittedPlacementResponse(res, {
        submittedSlip,
        requestedPlacementAttemptId,
        hasExplicitPlacementAttemptId,
        parsedWager,
        betKind,
      });
    }
  }

  if (!boardConfirmation) {
    return res.status(400).send({ message: "slip does not exist" });
  }

  const submittedDraft = await submitDraftSlipAtomically({
    slipId,
    userId: req.currentUser.id,
    userName,
    placementAttemptId,
    wager: parsedWager,
    betKind,
    expectedBoardRevision: boardConfirmation.expectedBoardRevision,
    expectedBoardFingerprint:
      boardConfirmation.expectedBoardFingerprint,
  });

  if (!submittedDraft) {
    const submittedSlip = await findSubmittedSlipByIdForUser(
      slipId,
      req.currentUser.id,
      betKind
    );

    if (submittedSlip) {
      return sendSubmittedPlacementResponse(res, {
        submittedSlip,
        requestedPlacementAttemptId,
        hasExplicitPlacementAttemptId,
        parsedWager,
        betKind,
      });
    }

    let draftSlip = await findDraftSlipByIdForUser(
      slipId,
      req.currentUser.id,
      betKind
    );

    if (draftSlip) {
      const preparedDraft = await prepareSlipForResponse(draftSlip, betKind);
      draftSlip = preparedDraft;

      if (slipHasMixedBetKinds(preparedDraft, betKind)) {
        return res.status(400).send({ message: "slip contains mixed bet kinds" });
      }

      if (
        !submissionMatchesBoardConfirmation(
          preparedDraft,
          boardConfirmation
        )
      ) {
        return sendReloadConflict(res, {
          draftSlip: preparedDraft,
          requestedPlacementAttemptId,
          isLegacyRequest: !hasExplicitPlacementAttemptId,
        });
      }
    }

    return sendReloadConflict(res, {
      draftSlip: null,
      requestedPlacementAttemptId,
      isLegacyRequest: !hasExplicitPlacementAttemptId,
    });
  }

  try {
    const submissionWorker = await getSubmissionWorker();
    await submissionWorker.publishSlipNow(slipId);
  } catch (error) {
    // keep the slip submitted and pending; the background replay worker will retry
  }

  const authoritativeSlip =
    (await findSubmittedSlipByIdForUser(slipId, req.currentUser.id, betKind))
    ?? submittedDraft;

  const placement = {
    requestedPlacementAttemptId: placementAttemptId,
    authoritativePlacementAttemptId:
      submittedPlacementAttemptIdOf(authoritativeSlip) ?? placementAttemptId,
    outcome: "accepted" as const,
    isLegacyRequest: !hasExplicitPlacementAttemptId,
  };
  setPlacementHeaders(res, placement);

  return res.status(200).send(toResponseSlip(authoritativeSlip, placement));
});

export { router as PlaceBet };
