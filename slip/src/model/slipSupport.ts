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
import { createHash, randomUUID } from "crypto";
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
  boardRevision?: number | null;
  boardFingerprint?: string | null;
  legacyBoardRevision?: number | null;
  legacyBoardFingerprint?: string | null;
  legacyBoardConfirmedAt?: string | null;
  legacyBoardConfirmations?: unknown;
  submittedEvent?: SubmittedEventData | null;
  publication?: MutablePublicationState | null;
  rows: ArrayLike<MutableSlipRow> & Iterable<MutableSlipRow>;
}

const MAX_LEGACY_BOARD_CONFIRMATIONS = 8;
const LEGACY_BOARD_SESSION_SCOPE_PATTERN = /^[a-f0-9]{64}$/;

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
  submittedAt?: string | null;
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
  boardRevision?: number | null;
  boardFingerprint?: string | null;
  legacyBoardRevision?: number | null;
  legacyBoardFingerprint?: string | null;
  legacyBoardConfirmedAt?: string | null;
  submittedEvent?: SubmittedEventData | null;
  publication?: MutablePublicationState | null;
  rows: PlainSlipRow[];
}

export type PublishedSubmittedEventData = IPlaceBetEvent["data"] & {
  placementAttemptId?: string;
  submittedAt?: string;
};

const MAX_PLACEMENT_ATTEMPT_ID_LENGTH = 200;
const MAX_BOARD_FINGERPRINT_LENGTH = 200;
const MIN_BOARD_REVISION = 1;
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

const normalizeBoardFingerprintValue = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();

  if (
    trimmedValue.length === 0
    || trimmedValue.length > MAX_BOARD_FINGERPRINT_LENGTH
  ) {
    return null;
  }

  return trimmedValue;
};

const normalizeBoardRevisionValue = (value: unknown): number | null => {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (
    !Number.isSafeInteger(numericValue)
    || numericValue < MIN_BOARD_REVISION
  ) {
    return null;
  }

  return numericValue;
};

export const normalizeBetKind = (betKind?: string | null): BetKind =>
  betKind === BetKind.LIVE ? BetKind.LIVE : BetKind.PRE_MATCH;

export const parsePlacementAttemptId = (value: unknown) =>
  normalizePlacementAttemptIdValue(value);

export const parseExpectedBoardRevision = (value: unknown) =>
  normalizeBoardRevisionValue(value);

export const parseExpectedBoardFingerprint = (value: unknown) =>
  normalizeBoardFingerprintValue(value);

export const createPlacementAttemptId = () => randomUUID();

export const createBoardFingerprint = () => new Types.ObjectId().toHexString();

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

export const boardRevisionOf = (slip?: { boardRevision?: unknown } | null) =>
  normalizeBoardRevisionValue(slip?.boardRevision) ?? MIN_BOARD_REVISION;

export const boardFingerprintOf = (slip?: {
  boardFingerprint?: unknown;
} | null) => normalizeBoardFingerprintValue(slip?.boardFingerprint);

export const buildLegacyBoardSessionScope = (sessionJwt: unknown) => {
  if (typeof sessionJwt !== "string" || sessionJwt.length === 0) {
    return null;
  }

  return createHash("sha256").update(sessionJwt).digest("hex");
};

export const advanceSlipBoardIdentity = (slip: MutableSlip) => {
  setField(slip, "boardRevision", boardRevisionOf(slip) + 1);
  setField(slip, "boardFingerprint", createBoardFingerprint());
};

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

export const ensureSlipBoardIdentity = (slip: MutableSlip) => {
  let changed = false;

  if (!normalizeBoardRevisionValue(slip.boardRevision)) {
    setField(slip, "boardRevision", MIN_BOARD_REVISION);
    changed = true;
  }

  if (!normalizeBoardFingerprintValue(slip.boardFingerprint)) {
    setField(slip, "boardFingerprint", createBoardFingerprint());
    changed = true;
  }

  return changed;
};

export const persistSlipBoardIdentityIfNeeded = async (
  slip: MutableSlip,
  {
    legacyConfirmationScope = null,
  }: {
    legacyConfirmationScope?: string | null;
  } = {}
) => {
  ensureSlipBoardIdentity(slip);

  const slipId = slipIdOf(slip);
  if (!slipId || !Types.ObjectId.isValid(slipId)) {
    return slip;
  }

  const fallbackRevision = boardRevisionOf(slip);
  const fallbackFingerprint =
    boardFingerprintOf(slip) ?? createBoardFingerprint();
  const updatePipeline: Record<string, unknown>[] = [
    {
      $set: {
        boardRevision: {
          $let: {
            vars: {
              currentRevision: {
                $convert: {
                  input: "$boardRevision",
                  to: "double",
                  onError: null,
                  onNull: null,
                },
              },
            },
            in: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$$currentRevision", null] },
                    { $gte: ["$$currentRevision", MIN_BOARD_REVISION] },
                    {
                      $eq: [
                        "$$currentRevision",
                        { $floor: "$$currentRevision" },
                      ],
                    },
                  ],
                },
                { $toLong: "$$currentRevision" },
                fallbackRevision,
              ],
            },
          },
        },
        boardFingerprint: {
          $let: {
            vars: {
              currentFingerprint: {
                $cond: [
                  { $eq: [{ $type: "$boardFingerprint" }, "string"] },
                  { $trim: { input: "$boardFingerprint" } },
                  "",
                ],
              },
            },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: "$$currentFingerprint" }, 0] },
                "$$currentFingerprint",
                fallbackFingerprint,
              ],
            },
          },
        },
      },
    },
  ];

  if (
    legacyConfirmationScope
    && LEGACY_BOARD_SESSION_SCOPE_PATTERN.test(legacyConfirmationScope)
  ) {
    const confirmedAt = new Date().toISOString();
    const nextLegacyBoardConfirmations = {
      $slice: [
        {
          $concatArrays: [
            {
              $filter: {
                input: {
                  $cond: [
                    { $isArray: "$legacyBoardConfirmations" },
                    "$legacyBoardConfirmations",
                    [],
                  ],
                },
                as: "confirmation",
                cond: {
                  $ne: [
                    "$$confirmation.sessionScope",
                    legacyConfirmationScope,
                  ],
                },
              },
            },
            [
              {
                sessionScope: legacyConfirmationScope,
                boardRevision: "$boardRevision",
                boardFingerprint: "$boardFingerprint",
                confirmedAt,
              },
            ],
          ],
        },
        -MAX_LEGACY_BOARD_CONFIRMATIONS,
      ],
    };
    updatePipeline.push({
      $set: {
        legacyBoardConfirmations: {
          $cond: [
            { $eq: ["$status", SlipStatus.DRAFT] },
            nextLegacyBoardConfirmations,
            "$legacyBoardConfirmations",
          ],
        },
      },
    });
  }

  const updated = await Slip.collection.findOneAndUpdate(
    { _id: new Types.ObjectId(slipId) },
    updatePipeline,
    {
      projection: { legacyBoardConfirmations: 0 },
      returnDocument: "after",
    }
  );
  const authoritativeSlip = asPlainSlip(
    (updated as { value?: unknown })?.value ?? updated
  );

  return authoritativeSlip ?? slip;
};

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

  ensureSlipBoardIdentity(slip);

  return betKind;
};

export const ensurePlainSlipBoardIdentity = (slip: PlainSlip) => {
  slip.boardRevision = boardRevisionOf(slip);
  slip.boardFingerprint = boardFingerprintOf(slip) ?? createBoardFingerprint();

  return slip;
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

  return ensurePlainSlipBoardIdentity(slip);
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

const asPlainSlip = (value: unknown): PlainSlip | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as PlainSlip;
};

const buildRowBetKindExpression = (rowExpression: string) => ({
  $ifNull: [`${rowExpression}.betKind`, BetKind.PRE_MATCH],
});

const buildRowKindCondition = (rowExpression: string, betKind: BetKind) =>
  betKind === BetKind.LIVE
    ? { $eq: [buildRowBetKindExpression(rowExpression), BetKind.LIVE] }
    : { $ne: [buildRowBetKindExpression(rowExpression), BetKind.LIVE] };

const buildCurrentRowsExpression = (betKind: BetKind) => ({
  $filter: {
    input: { $ifNull: ["$rows", []] },
    as: "row",
    cond: buildRowKindCondition("$$row", betKind),
  },
});

const buildBoardRevisionExpression = (boardChangedExpression: unknown) => ({
  $let: {
    vars: {
      currentBoardRevision: { $ifNull: ["$boardRevision", 0] },
      normalizedBoardRevision: {
        $ifNull: ["$boardRevision", MIN_BOARD_REVISION],
      },
    },
    in: {
      $cond: [
        boardChangedExpression,
        { $add: ["$$currentBoardRevision", 1] },
        "$$normalizedBoardRevision",
      ],
    },
  },
});

const buildBoardFingerprintExpression = (boardChangedExpression: unknown) => {
  const fallbackBoardFingerprint = createBoardFingerprint();
  const nextBoardFingerprint = createBoardFingerprint();

  return {
    $let: {
      vars: {
        currentBoardFingerprint: {
          $ifNull: ["$boardFingerprint", fallbackBoardFingerprint],
        },
      },
      in: {
        $cond: [
          boardChangedExpression,
          nextBoardFingerprint,
          "$$currentBoardFingerprint",
        ],
      },
    },
  };
};

const buildSameMarketCondition = (
  row: PlainSlipRow,
  rowExpression = "$$row"
) => {
  if (
    normalizeBetKind(row.betKind) !== BetKind.LIVE
    || !row.marketId
  ) {
    return { $literal: false };
  }

  return {
    $and: [
      {
        $eq: [buildRowBetKindExpression(rowExpression), BetKind.LIVE],
      },
      { $eq: [`${rowExpression}.marketId`, row.marketId] },
    ],
  };
};

const buildMergedDraftRowsExpression = (
  currentRowsExpression: Record<string, unknown>,
  rowsToMerge: PlainSlipRow[]
) =>
  rowsToMerge.reduce<Record<string, unknown>>(
    (mergedRowsExpression, rowToMerge) => {
      const conflictCondition =
        normalizeBetKind(rowToMerge.betKind) === BetKind.LIVE
        && rowToMerge.marketId
          ? buildSameMarketCondition(rowToMerge, "$$row")
          : { $eq: ["$$row.oddsId", rowToMerge.oddsId] };

      return {
        $let: {
          vars: {
            currentRows: mergedRowsExpression,
            hasConflict: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: currentRowsExpression,
                      as: "row",
                      cond: conflictCondition,
                    },
                  },
                },
                0,
              ],
            },
          },
          in: {
            $cond: [
              "$$hasConflict",
              "$$currentRows",
              { $concatArrays: ["$$currentRows", [rowToMerge]] },
            ],
          },
        },
      };
    },
    currentRowsExpression
  );

export const upsertDraftSlipRow = async (
  userId: string,
  betKind: BetKind,
  row: PlainSlipRow
) => {
  const activeScope = {
    userId,
    status: {
      $in: [SlipStatus.DRAFT, SlipStatus.SUBMITTED],
    },
    ...buildBetKindScope(betKind),
  };
  const now = new Date().toISOString();
  const sameMarketCondition = buildSameMarketCondition(row);
  const currentRows = buildCurrentRowsExpression(betKind);
  const updatePipeline = [
    {
      $set: {
        userId: {
          $cond: [{ $eq: ["$status", SlipStatus.SUBMITTED] }, "$userId", userId],
        },
        status: {
          $cond: [{ $eq: ["$status", SlipStatus.SUBMITTED] }, "$status", SlipStatus.DRAFT],
        },
        betKind: {
          $cond: [{ $eq: ["$status", SlipStatus.SUBMITTED] }, "$betKind", betKind],
        },
        draftKey: {
          $cond: [{ $eq: ["$status", SlipStatus.SUBMITTED] }, "$draftKey", betKind],
        },
        timestamp: {
          $cond: [
            { $eq: ["$status", SlipStatus.SUBMITTED] },
            "$timestamp",
            { $ifNull: ["$timestamp", now] },
          ],
        },
        rows: {
          $cond: [
            { $eq: ["$status", SlipStatus.SUBMITTED] },
            "$rows",
            {
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
          ],
        },
        boardRevision: {
          $cond: [
            { $eq: ["$status", SlipStatus.SUBMITTED] },
            { $ifNull: ["$boardRevision", MIN_BOARD_REVISION] },
            {
              $let: {
                vars: {
                  currentRows,
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
                in: buildBoardRevisionExpression({
                  $or: ["$$hasSameMarket", { $not: ["$$hasDuplicateOdds"] }],
                }),
              },
            },
          ],
        },
        boardFingerprint: {
          $cond: [
            { $eq: ["$status", SlipStatus.SUBMITTED] },
            { $ifNull: ["$boardFingerprint", createBoardFingerprint()] },
            {
              $let: {
                vars: {
                  currentRows,
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
                in: buildBoardFingerprintExpression({
                  $or: ["$$hasSameMarket", { $not: ["$$hasDuplicateOdds"] }],
                }),
              },
            },
          ],
        },
      },
    },
  ];

  try {
    await Slip.collection.findOneAndUpdate(activeScope, updatePipeline, {
      upsert: true,
      sort: {
        status: 1,
        timestamp: -1,
        _id: -1,
      },
      returnDocument: "after",
    });
    return;
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }

  await Slip.collection.findOneAndUpdate(activeScope, updatePipeline, {
    upsert: false,
    sort: {
      status: 1,
      timestamp: -1,
      _id: -1,
    },
    returnDocument: "after",
  });
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

export const submissionMatchesBoardConfirmation = (
  slip: {
    boardRevision?: unknown;
    boardFingerprint?: unknown;
  },
  confirmation: {
    expectedBoardRevision: unknown;
    expectedBoardFingerprint: unknown;
  }
) => {
  const expectedBoardRevision = parseExpectedBoardRevision(
    confirmation.expectedBoardRevision
  );
  const expectedBoardFingerprint = parseExpectedBoardFingerprint(
    confirmation.expectedBoardFingerprint
  );

  if (expectedBoardRevision === null || !expectedBoardFingerprint) {
    return false;
  }

  return (
    boardRevisionOf(slip) === expectedBoardRevision
    && boardFingerprintOf(slip) === expectedBoardFingerprint
  );
};

const parseLegacyBoardConfirmation = (
  boardRevision: unknown,
  boardFingerprint: unknown
) => {
  const expectedBoardRevision = parseExpectedBoardRevision(boardRevision);
  const expectedBoardFingerprint =
    parseExpectedBoardFingerprint(boardFingerprint);

  if (expectedBoardRevision === null || !expectedBoardFingerprint) {
    return null;
  }

  return {
    expectedBoardRevision,
    expectedBoardFingerprint,
  };
};

export const legacyBoardConfirmationOf = (
  value: unknown,
  sessionScope?: string | null
) => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const slip = value as {
    legacyBoardRevision?: unknown;
    legacyBoardFingerprint?: unknown;
    legacyBoardConfirmations?: unknown;
  };

  if (
    sessionScope
    && LEGACY_BOARD_SESSION_SCOPE_PATTERN.test(sessionScope)
    && Array.isArray(slip.legacyBoardConfirmations)
  ) {
    const scopedConfirmation = slip.legacyBoardConfirmations.find(
      (value) =>
        value
        && typeof value === "object"
        && (value as { sessionScope?: unknown }).sessionScope === sessionScope
    ) as {
      boardRevision?: unknown;
      boardFingerprint?: unknown;
    } | undefined;

    if (scopedConfirmation) {
      return parseLegacyBoardConfirmation(
        scopedConfirmation.boardRevision,
        scopedConfirmation.boardFingerprint
      );
    }
  }

  return parseLegacyBoardConfirmation(
    slip.legacyBoardRevision,
    slip.legacyBoardFingerprint
  );
};

export const findLegacyBoardConfirmationForSlip = async ({
  slipId,
  userId,
  betKind,
  sessionScope,
}: {
  slipId: string;
  userId: string;
  betKind: BetKind;
  sessionScope: string | null;
}) => {
  const projection: Record<string, unknown> = {
    legacyBoardRevision: 1,
    legacyBoardFingerprint: 1,
  };

  if (
    sessionScope
    && LEGACY_BOARD_SESSION_SCOPE_PATTERN.test(sessionScope)
  ) {
    projection.legacyBoardConfirmations = {
      $elemMatch: { sessionScope },
    };
  }

  const slip = await Slip.collection.findOne(
    {
      _id: new Types.ObjectId(slipId),
      userId,
      status: SlipStatus.DRAFT,
      ...buildBetKindScope(betKind),
    },
    { projection }
  );

  return slip
    ? legacyBoardConfirmationOf(slip, sessionScope)
    : null;
};

export const clearSubmittedAttemptState = (slip: PlainSlip) => {
  slip.submittedAt = undefined;
  slip.submittedEvent = undefined;
  slip.publication = undefined;
};

export const upsertRestoredDraft = async (
  payload: PlainSlip
): Promise<PlainSlip> => {
  const betKind = normalizeBetKind(payload.betKind);
  const replacementSlipId =
    typeof payload._id === "string" ? payload._id : payload._id?.toString();

  if (!replacementSlipId) {
    throw new Error("Replacement slip id is missing");
  }

  const buildUpdatePipeline = () => {
    const currentRows = buildCurrentRowsExpression(betKind);
    const mergedRows = buildMergedDraftRowsExpression(currentRows, payload.rows);
    const boardChanged = {
      $or: [
        { $ne: [mergedRows, currentRows] },
        {
          $ne: [
            { $ifNull: ["$declineReason", null] },
            payload.declineReason ?? null,
          ],
        },
        {
          $ne: [
            { $ifNull: ["$sourceSlipId", null] },
            payload.sourceSlipId ?? null,
          ],
        },
      ],
    };

    return [
      {
        $set: {
          userId: payload.userId,
          status: SlipStatus.DRAFT,
          betKind,
          draftKey: betKind,
          timestamp: {
            $cond: [
              boardChanged,
              payload.timestamp,
              { $ifNull: ["$timestamp", payload.timestamp] },
            ],
          },
          sourceSlipId: payload.sourceSlipId,
          declineReason: payload.declineReason,
          rows: mergedRows,
          boardRevision: buildBoardRevisionExpression(boardChanged),
          boardFingerprint: buildBoardFingerprintExpression(boardChanged),
        },
      },
      {
        $unset: ["submittedAt", "submittedEvent", "publication", "replacementSlipId"],
      },
    ];
  };

  const existingDraft = await findDraftSlipForUser(payload.userId, betKind);
  const initialTargetSlipId = slipIdOf(existingDraft) ?? replacementSlipId;

  const runUpsert = async (targetSlipId: string, upsert: boolean) => {
    const updated = await Slip.collection.findOneAndUpdate(
      { _id: new Types.ObjectId(targetSlipId) },
      buildUpdatePipeline(),
      {
        upsert,
        returnDocument: "after",
      }
    );

    return asPlainSlip((updated as { value?: unknown })?.value ?? updated);
  };

  let plainSlip: PlainSlip | null = null;

  try {
    plainSlip = await runUpsert(initialTargetSlipId, true);
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const concurrentDraft = await findDraftSlipForUser(payload.userId, betKind);
    const concurrentDraftId = slipIdOf(concurrentDraft);

    if (!concurrentDraftId) {
      throw error;
    }

    plainSlip = await runUpsert(concurrentDraftId, false);
  }

  if (!plainSlip) {
    throw new Error("Failed to restore declined draft slip");
  }

  return normalizePlainSlip(plainSlip, betKind);
};

export const toPublishedSubmittedEventData = (
  submittedEvent: SubmittedEventData
): PublishedSubmittedEventData => ({
  userId: submittedEvent.userId,
  userName: submittedEvent.userName,
  slipId: submittedEvent.slipId,
  submittedAt: submittedEvent.submittedAt ?? undefined,
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
