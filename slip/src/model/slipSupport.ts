import {
  BetKind,
  IModerationAffectedRow,
  IPlaceBetEvent,
  LiveMarketStatus,
  LiveMarketType,
  ModerationDeclineReason,
  SlipStatus,
  TeamSide,
} from "@betstan/common";
import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { Slip, SlipArchive } from "./Slip";
import { SlipPublicationState } from "./SlipPublicationState";

type ModelId = string | { toString(): string };

interface MutableModel {
  set?: (path: string, value: unknown) => void;
}

interface MutableModerationAffectedRow {
  rowId: string;
  declineReason: ModerationDeclineReason;
  marketId?: string | null;
  marketVersion?: number | null;
  quoteVersion?: number | null;
  currentOdds?: number | null;
  marketStatus?: LiveMarketStatus | null;
  selectionId?: string | null;
}

export interface MutableSlipRow extends MutableModel {
  id?: string;
  _id?: ModelId;
  eventId: string;
  eventName: string;
  oddsId: string;
  oddsValue: number;
  oddsName: string;
  productName: string;
  productId: string;
  timestamp: string;
  eventTime?: string | null;
  betKind?: BetKind | null;
  marketId?: string | null;
  marketType?: LiveMarketType | null;
  marketVersion?: number | null;
  quoteVersion?: number | null;
  selectionId?: string | null;
  side?: TeamSide | null;
  selectedAt?: string | null;
  quoteValidUntil?: string | null;
  moderation?: MutableModerationAffectedRow | null;
}

export interface MutableSlip extends MutableModel {
  id?: string;
  _id?: ModelId;
  betKind?: BetKind | null;
  draftKey?: BetKind | null;
  status?: SlipStatus | null;
  timestamp?: string | null;
  submittedAt?: string | null;
  declineReason?: ModerationDeclineReason | null;
  sourceSlipId?: string | null;
  replacementSlipId?: string | null;
  submittedEvent?: SubmittedEventData | null;
  publication?: MutablePublicationState | null;
  rows: ArrayLike<MutableSlipRow> & Iterable<MutableSlipRow>;
}

export interface MutablePublicationState {
  state?: SlipPublicationState | null;
  attemptCount?: number | null;
  nextAttemptAt?: string | null;
  leaseOwner?: string | null;
  leaseUntil?: string | null;
  lastAttemptAt?: string | null;
  heartbeatAt?: string | null;
  lastError?: string | null;
  publishedAt?: string | null;
  exhaustedAt?: string | null;
}

export interface MutableSubmittedEventRow {
  eventId: string;
  eventName: string;
  oddsId: string;
  oddsValue: number;
  oddsName: string;
  productName: string;
  productId: string;
  timestamp: string;
  id: string;
  eventTime?: string | null;
  betKind?: BetKind | null;
  marketId?: string | null;
  marketType?: LiveMarketType | null;
  marketVersion?: number | null;
  quoteVersion?: number | null;
  selectionId?: string | null;
  side?: TeamSide | null;
  selectedAt?: string | null;
  quoteValidUntil?: string | null;
}

export interface SubmittedEventData {
  userId: string;
  userName: string;
  slipId: string;
  placementAttemptId?: string | null;
  wager: number;
  rows: ArrayLike<MutableSubmittedEventRow> & Iterable<MutableSubmittedEventRow>;
  betKind?: BetKind | null;
}

export interface PlainSlipRow {
  _id?: string | Types.ObjectId;
  eventId: string;
  eventName: string;
  oddsId: string;
  oddsValue: number;
  oddsName: string;
  productName: string;
  productId: string;
  timestamp: string;
  eventTime?: string | null;
  betKind?: BetKind | null;
  marketId?: string | null;
  marketType?: LiveMarketType | null;
  marketVersion?: number | null;
  quoteVersion?: number | null;
  selectionId?: string | null;
  side?: TeamSide | null;
  selectedAt?: string | null;
  quoteValidUntil?: string | null;
  moderation?: MutableModerationAffectedRow | null;
}

export interface PlainSlip {
  _id?: string | Types.ObjectId;
  userId: string;
  status: SlipStatus;
  betKind?: BetKind | null;
  draftKey?: BetKind | null;
  timestamp: string;
  submittedAt?: string | null;
  declineReason?: ModerationDeclineReason | null;
  sourceSlipId?: string | null;
  replacementSlipId?: string | null;
  submittedEvent?: SubmittedEventData | null;
  publication?: MutablePublicationState | null;
  rows: PlainSlipRow[];
}

export type PublishedSubmittedEventData = IPlaceBetEvent["data"] & {
  placementAttemptId?: string;
};

const MAX_PLACEMENT_ATTEMPT_ID_LENGTH = 200;
const LEGACY_PLACEMENT_ATTEMPT_PREFIX = "legacy:";

const setField = (target: MutableModel, key: string, value: unknown) => {
  if (typeof target.set === "function") {
    target.set(key, value);
    return;
  }

  Object.assign(target, { [key]: value });
};

const normalizePlacementAttemptIdValue = (
  value: unknown
): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();

  if (
    trimmedValue.length === 0
    || trimmedValue.length > MAX_PLACEMENT_ATTEMPT_ID_LENGTH
  ) {
    return null;
  }

  return trimmedValue;
};

export const normalizeBetKind = (betKind?: string | null): BetKind =>
  betKind === BetKind.LIVE ? BetKind.LIVE : BetKind.PRE_MATCH;

export const parsePlacementAttemptId = (value: unknown) =>
  normalizePlacementAttemptIdValue(value);

export const createPlacementAttemptId = () => randomUUID();

export const buildLegacyPlacementAttemptId = (slipId: string) =>
  `${LEGACY_PLACEMENT_ATTEMPT_PREFIX}${slipId}`;

export const parseRequestedBetKind = (betKind: unknown): BetKind | null => {
  if (betKind === undefined || betKind === null || betKind === "") {
    return BetKind.PRE_MATCH;
  }

  if (betKind === BetKind.PRE_MATCH || betKind === BetKind.LIVE) {
    return betKind;
  }

  return null;
};

export const isValidSlipId = (slipId: unknown): slipId is string =>
  typeof slipId === "string" && Types.ObjectId.isValid(slipId);

export const createSlipId = (): string => new Types.ObjectId().toHexString();

export const isDuplicateKeyError = (error: unknown): error is { code: number } =>
  typeof error === "object"
  && error !== null
  && "code" in error
  && (error as { code?: number }).code === 11000;

export const buildBetKindScope = (betKind: BetKind): Record<string, unknown> =>
  betKind === BetKind.LIVE
    ? { betKind: BetKind.LIVE }
    : {
        $or: [
          { betKind: BetKind.PRE_MATCH },
          { betKind: { $exists: false } },
          { betKind: null },
        ],
      };

export const buildSlipScope = (
  status: SlipStatus,
  betKind: BetKind,
  userId?: string,
  slipId?: string
): Record<string, unknown> => {
  const scope: Record<string, unknown> = {
    status,
    ...buildBetKindScope(betKind),
  };

  if (userId) {
    scope.userId = userId;
  }

  if (slipId) {
    scope._id = slipId;
  }

  return scope;
};

export const findDraftSlipForUser = (userId: string, betKind: BetKind) =>
  Slip.findOne(buildSlipScope(SlipStatus.DRAFT, betKind, userId)).sort({
    timestamp: -1,
    _id: -1,
  });

export const findDraftSlipByIdForUser = (
  slipId: string,
  userId: string,
  betKind: BetKind
) => Slip.findOne(buildSlipScope(SlipStatus.DRAFT, betKind, userId, slipId));

export const findSubmittedSlipForUser = (userId: string, betKind: BetKind) =>
  Slip.findOne(buildSlipScope(SlipStatus.SUBMITTED, betKind, userId)).sort({
    submittedAt: -1,
    timestamp: -1,
    _id: -1,
  });

export const findSubmittedSlipByIdForUser = (
  slipId: string,
  userId: string,
  betKind: BetKind
) =>
  Slip.findOne(buildSlipScope(SlipStatus.SUBMITTED, betKind, userId, slipId));

export const findDraftSlipById = (slipId: string, betKind: BetKind) =>
  Slip.findOne(buildSlipScope(SlipStatus.DRAFT, betKind, undefined, slipId));

export const findSubmittedSlipById = (slipId: string, betKind: BetKind) =>
  Slip.findOne(buildSlipScope(SlipStatus.SUBMITTED, betKind, undefined, slipId));

export const findArchivedSlipById = (slipId: string, betKind: BetKind) =>
  SlipArchive.findOne({
    _id: slipId,
    ...buildBetKindScope(betKind),
  });

export const findDraftSlipBySourceSlipId = (sourceSlipId: string) =>
  Slip.findOne({
    sourceSlipId,
    status: SlipStatus.DRAFT,
  });

export const findSlipById = (slipId: string) => Slip.findById(slipId);

export const findAnyArchivedOrActiveSlipById = async (slipId: string) => {
  const [slip, archivedSlip] = await Promise.all([
    Slip.findById(slipId),
    SlipArchive.findById(slipId),
  ]);

  return slip ?? archivedSlip;
};

const stringifyId = (value?: ModelId): string | null => {
  if (!value) {
    return null;
  }

  return typeof value === "string" ? value : value.toString();
};

export const slipIdOf = (slip?: { id?: string; _id?: ModelId } | null) => {
  if (!slip) {
    return null;
  }

  if (typeof slip.id === "string" && slip.id.length > 0) {
    return slip.id;
  }

  return stringifyId(slip._id);
};

export const rowIdOf = (row: MutableSlipRow): string | null => {
  if (typeof row.id === "string" && row.id.length > 0) {
    return row.id;
  }

  return stringifyId(row._id);
};

const canonicalPlacementAttemptId = (value: {
  slipId: string;
  placementAttemptId?: string | null;
}) =>
  parsePlacementAttemptId(value.placementAttemptId)
  ?? buildLegacyPlacementAttemptId(value.slipId);

export const normalizeSlip = (
  slip: MutableSlip,
  fallbackBetKind?: BetKind
): BetKind => {
  const betKind = normalizeBetKind(slip.betKind ?? fallbackBetKind);

  setField(slip, "betKind", betKind);
  setField(slip, "draftKey", betKind);

  for (const row of slip.rows) {
    if (!row.betKind) {
      setField(row, "betKind", betKind);
    }
  }

  return betKind;
};

export const normalizePlainSlip = (
  slip: PlainSlip,
  fallbackBetKind?: BetKind
): PlainSlip => {
  const betKind = normalizeBetKind(slip.betKind ?? fallbackBetKind);

  slip.betKind = betKind;
  slip.draftKey = betKind;
  slip.rows = slip.rows.map((row) => ({
    ...row,
    betKind: normalizeBetKind(row.betKind ?? betKind),
  }));

  return slip;
};

export const selectActiveSlip = (
  draftSlip: MutableSlip | null,
  submittedSlip: MutableSlip | null
) => {
  if (draftSlip && submittedSlip) {
    const submittedSlipId = slipIdOf(submittedSlip);

    if (
      typeof draftSlip.sourceSlipId === "string"
      && draftSlip.sourceSlipId.length > 0
      && draftSlip.sourceSlipId === submittedSlipId
    ) {
      return draftSlip;
    }

    return submittedSlip;
  }

  return draftSlip ?? submittedSlip ?? null;
};

export const findActiveSlipForUser = async (
  userId: string,
  betKind: BetKind
) => {
  const [draftSlip, submittedSlip] = await Promise.all([
    findDraftSlipForUser(userId, betKind),
    findSubmittedSlipForUser(userId, betKind),
  ]);
  const activeSlip = selectActiveSlip(draftSlip, submittedSlip);

  if (activeSlip) {
    normalizeSlip(activeSlip, betKind);
  }

  return activeSlip;
};

export const clearSlipDeclineState = (slip: MutableSlip) => {
  setField(slip, "declineReason", undefined);

  for (const row of slip.rows) {
    setField(row, "moderation", undefined);
  }
};

export const clearSlipDeclineReason = (slip: MutableSlip) => {
  setField(slip, "declineReason", undefined);
};

export const slipHasMixedBetKinds = (
  slip: MutableSlip,
  expectedBetKind?: BetKind
): boolean => {
  const betKind = expectedBetKind ?? normalizeBetKind(slip.betKind);

  return Array.from(slip.rows).some(
    (row) => normalizeBetKind(row.betKind) !== betKind
  );
};

export const applyAffectedRows = (
  slip: MutableSlip,
  affectedRows: IModerationAffectedRow[] = []
) => {
  const affectedByRowId = new Map(
    affectedRows.map((affectedRow) => [affectedRow.rowId, affectedRow])
  );

  for (const row of slip.rows) {
    const rowId = rowIdOf(row);
    setField(row, "moderation", rowId ? affectedByRowId.get(rowId) : undefined);
  }
};

export const toPlainSlip = (slip: MutableSlip): PlainSlip =>
  JSON.parse(JSON.stringify(slip)) as PlainSlip;

const buildSameMarketCondition = (row: PlainSlipRow) => {
  if (
    normalizeBetKind(row.betKind) !== BetKind.LIVE
    || !row.marketId
  ) {
    return { $literal: false };
  }

  return {
    $and: [
      {
        $eq: [
          { $ifNull: ["$$row.betKind", BetKind.PRE_MATCH] },
          BetKind.LIVE,
        ],
      },
      { $eq: ["$$row.marketId", row.marketId] },
    ],
  };
};

export const upsertDraftSlipRow = async (
  userId: string,
  betKind: BetKind,
  row: PlainSlipRow
) => {
  const draftScope = buildSlipScope(SlipStatus.DRAFT, betKind, userId);
  const now = new Date().toISOString();
  const sameMarketCondition = buildSameMarketCondition(row);
  const currentRows = { $ifNull: ["$rows", []] };
  const updatePipeline = [
    {
      $set: {
        userId,
        status: SlipStatus.DRAFT,
        betKind,
        draftKey: betKind,
        timestamp: { $ifNull: ["$timestamp", now] },
        rows: {
          $let: {
            vars: {
              currentRows,
              rowsWithoutSameMarket: {
                $filter: {
                  input: currentRows,
                  as: "row",
                  cond: { $not: [sameMarketCondition] },
                },
              },
              hasSameMarket: {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: currentRows,
                        as: "row",
                        cond: sameMarketCondition,
                      },
                    },
                  },
                  0,
                ],
              },
              hasDuplicateOdds: {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: currentRows,
                        as: "row",
                        cond: { $eq: ["$$row.oddsId", row.oddsId] },
                      },
                    },
                  },
                  0,
                ],
              },
            },
            in: {
              $cond: [
                "$$hasSameMarket",
                { $concatArrays: ["$$rowsWithoutSameMarket", [row]] },
                {
                  $cond: [
                    "$$hasDuplicateOdds",
                    "$$currentRows",
                    { $concatArrays: ["$$currentRows", [row]] },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  ];

  try {
    await Slip.collection.updateOne(draftScope, updatePipeline, { upsert: true });
    return;
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }

  await Slip.collection.updateOne(draftScope, updatePipeline, { upsert: false });
};

export const toPlaceBetRows = (
  slip: MutableSlip
): IPlaceBetEvent["data"]["rows"] => {
  const slipBetKind = normalizeBetKind(slip.betKind);

  return Array.from(slip.rows).map((row) => {
    const rowId = rowIdOf(row);

    if (!rowId) {
      throw new Error("Slip row id is missing");
    }

    return {
      eventId: row.eventId,
      eventName: row.eventName,
      oddsId: row.oddsId,
      oddsValue: row.oddsValue,
      oddsName: row.oddsName,
      productName: row.productName,
      productId: row.productId,
      timestamp: row.timestamp,
      id: rowId,
      eventTime: row.eventTime ?? undefined,
      betKind: normalizeBetKind(row.betKind ?? slipBetKind),
      marketId: row.marketId ?? undefined,
      marketType: row.marketType ?? undefined,
      marketVersion: row.marketVersion ?? undefined,
      quoteVersion: row.quoteVersion ?? undefined,
      selectionId: row.selectionId ?? undefined,
      side: row.side ?? undefined,
      selectedAt: row.selectedAt ?? undefined,
      quoteValidUntil: row.quoteValidUntil ?? undefined,
    };
  });
};

export const submittedWagerOf = (slip?: {
  submittedEvent?: SubmittedEventData | null;
} | null): number | null => {
  const wager = slip?.submittedEvent?.wager;
  return typeof wager === "number" && Number.isFinite(wager) ? wager : null;
};

export const submissionMatchesWager = (
  slip: { submittedEvent?: SubmittedEventData | null },
  wager: number
) => submittedWagerOf(slip) === wager;

export const submittedPlacementAttemptIdOf = (slip?: {
  id?: string;
  _id?: ModelId;
  submittedEvent?: SubmittedEventData | null;
} | null) => {
  const submittedEvent = slip?.submittedEvent;

  if (submittedEvent?.slipId) {
    return canonicalPlacementAttemptId(submittedEvent);
  }

  const slipId = slipIdOf(slip ?? null);
  return slipId ? buildLegacyPlacementAttemptId(slipId) : null;
};

export const submissionMatchesPlacementAttempt = (
  slip: {
    id?: string;
    _id?: ModelId;
    betKind?: BetKind | null;
    submittedEvent?: SubmittedEventData | null;
  },
  placementAttemptId: unknown
) => {
  const normalizedPlacementAttemptId = parsePlacementAttemptId(
    placementAttemptId
  );

  if (!normalizedPlacementAttemptId) {
    return false;
  }

  return submittedPlacementAttemptIdOf(slip) === normalizedPlacementAttemptId;
};

export const submissionMatchesPlacementPayload = (
  slip: {
    id?: string;
    _id?: ModelId;
    betKind?: BetKind | null;
    submittedEvent?: SubmittedEventData | null;
  },
  requestPayload: {
    placementAttemptId: unknown;
    wager: number;
    betKind: BetKind;
  }
) =>
  submissionMatchesPlacementAttempt(slip, requestPayload.placementAttemptId)
  && submissionMatchesWager(slip, requestPayload.wager)
  && normalizeBetKind(
    slip.submittedEvent?.betKind ?? slip.betKind ?? requestPayload.betKind
  ) === requestPayload.betKind;

export const clearSubmittedAttemptState = (slip: PlainSlip) => {
  slip.submittedAt = undefined;
  slip.submittedEvent = undefined;
  slip.publication = undefined;
};

export const toPublishedSubmittedEventData = (
  submittedEvent: SubmittedEventData
): PublishedSubmittedEventData => ({
  userId: submittedEvent.userId,
  userName: submittedEvent.userName,
  slipId: submittedEvent.slipId,
  placementAttemptId: canonicalPlacementAttemptId(submittedEvent),
  wager: submittedEvent.wager,
  betKind: submittedEvent.betKind ?? undefined,
  rows: Array.from(submittedEvent.rows).map((row) => ({
    eventId: row.eventId,
    eventName: row.eventName,
    oddsId: row.oddsId,
    oddsValue: row.oddsValue,
    oddsName: row.oddsName,
    productName: row.productName,
    productId: row.productId,
    timestamp: row.timestamp,
    id: row.id,
    eventTime: row.eventTime ?? undefined,
    betKind: row.betKind ?? undefined,
    marketId: row.marketId ?? undefined,
    marketType: row.marketType ?? undefined,
    marketVersion: row.marketVersion ?? undefined,
    quoteVersion: row.quoteVersion ?? undefined,
    selectionId: row.selectionId ?? undefined,
    side: row.side ?? undefined,
    selectedAt: row.selectedAt ?? undefined,
    quoteValidUntil: row.quoteValidUntil ?? undefined,
  })),
});
