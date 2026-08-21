import express, { Request, Response } from "express";
import { messengerWrapper } from "@betstan/common";
import {
  createPlacementAttemptId,
  findDraftSlipByIdForUser,
  findSubmittedSlipByIdForUser,
  isValidSlipId,
  normalizeSlip,
  parsePlacementAttemptId,
  parseRequestedBetKind,
  slipHasMixedBetKinds,
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

type PlacementOutcome = "accepted" | "idempotent" | "conflict";

interface PlacementMetadata {
  requestedPlacementAttemptId: string | null;
  authoritativePlacementAttemptId: string | null;
  outcome: PlacementOutcome;
  isLegacyRequest: boolean;
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

  const requestedPlacementAttemptId = placementAttemptResult.placementAttemptId;
  const hasExplicitPlacementAttemptId =
    placementAttemptResult.hasExplicitPlacementAttemptId;
  const placementAttemptId =
    requestedPlacementAttemptId ?? createPlacementAttemptId();
  const userName = req.currentUser.email ?? req.currentUser.id;
  const submittedDraft = await submitDraftSlipAtomically({
    slipId,
    userId: req.currentUser.id,
    userName,
    placementAttemptId,
    wager: parsedWager,
    betKind,
  });

  if (!submittedDraft) {
    const submittedSlip = await findSubmittedSlipByIdForUser(
      slipId,
      req.currentUser.id,
      betKind
    );

    if (!submittedSlip) {
      const draftSlip = await findDraftSlipByIdForUser(
        slipId,
        req.currentUser.id,
        betKind
      );

      if (draftSlip) {
        const normalizedBetKind = normalizeSlip(draftSlip, betKind);
        if (slipHasMixedBetKinds(draftSlip, normalizedBetKind)) {
          return res.status(400).send({ message: "slip contains mixed bet kinds" });
        }
      }

      return res.status(400).send({ message: "slip does not exist" });
    }

    const authoritativePlacementAttemptId =
      submittedPlacementAttemptIdOf(submittedSlip);

    if (
      !hasExplicitPlacementAttemptId
      || !submissionMatchesPlacementAttempt(
        submittedSlip,
        requestedPlacementAttemptId
      )
    ) {
      const placement = {
        requestedPlacementAttemptId,
        authoritativePlacementAttemptId,
        outcome: "conflict" as const,
        isLegacyRequest: !hasExplicitPlacementAttemptId,
      };
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
      const placement = {
        requestedPlacementAttemptId,
        authoritativePlacementAttemptId,
        outcome: "conflict" as const,
        isLegacyRequest: false,
      };
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
