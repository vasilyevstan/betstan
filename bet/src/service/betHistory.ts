import { createHash } from "crypto";
import {
  BetKind,
  BetStatus,
  IModerationAffectedRow,
  IModerationResultEvent,
  IPlaceBetEvent,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  ModerationDeclineReason,
  ModerationStatus,
  ResultingStatus,
  SlipRowStatus,
} from "@betstan/common";
import { BetPlacementConflict } from "../model/BetPlacementConflict";
import { Bet, BetDocument, BetRecord, BetRowRecord } from "../model/Bet";
import {
  PendingBetUpdate,
  PendingBetUpdateDocument,
  PendingBetUpdateKind,
  PendingBetUpdateRecord,
  PendingBetUpdateStatus,
} from "../model/PendingBetUpdate";

type PendingBetEvent =
  | IModerationResultEvent
  | ISettleSlipEvent
  | ISettleSlipRowEvent;
type PlaceBetRow = IPlaceBetEvent["data"]["rows"][number];
type PlaceBetEventData = IPlaceBetEvent["data"] & {
  attemptId?: string;
  placementAttemptId?: string;
};
type PendingUpdateInsert = Pick<
  PendingBetUpdateRecord,
  | "attemptCount"
  | "dedupeKey"
  | "kind"
  | "nextAttemptAt"
  | "payload"
  | "slipId"
  | "status"
  | "timestamp"
>;

export type PendingBetUpdateApplyOutcome =
  | "applied"
  | "bet_missing"
  | "noop";

export interface PendingBetUpdateApplyResult {
  outcome: PendingBetUpdateApplyOutcome;
  pendingUpdates: PendingBetUpdateDocument[];
}

export type PlaceBetPersistenceOutcome =
  | "inserted"
  | "exact_duplicate"
  | "conflicting_duplicate";

export interface PlaceBetPersistenceResult {
  bet: BetDocument;
  outcome: PlaceBetPersistenceOutcome;
}

interface CanonicalPlacedBetRow {
  id: string;
  eventId: string;
  eventName: string;
  oddsId: string;
  oddsValue: number;
  oddsName: string;
  productName: string;
  productId: string;
  timestamp: string;
  eventTime?: string;
  betKind: BetKind;
  marketId?: string;
  marketType?: BetRowRecord["marketType"];
  marketVersion?: number;
  quoteVersion?: number;
  selectionId?: string;
  side?: BetRowRecord["side"];
  selectedAt?: string;
  quoteValidUntil?: string;
}

interface CanonicalPlacedBetPayload {
  betKind: BetKind;
  placedAt: string;
  rows: CanonicalPlacedBetRow[];
  slipId: string;
  userId: string;
  userName: string;
  wager: number;
}

export interface ApplyPendingBetUpdatesToBetControl {
  beforeApply?: (
    pendingUpdate: PendingBetUpdateDocument
  ) => Promise<boolean> | boolean;
}

export interface ApplyPendingBetUpdatesToBetResult {
  changed: boolean;
  ownershipLost: boolean;
  processedPendingUpdates: PendingBetUpdateDocument[];
}

const TERMINAL_BET_STATUSES = new Set<BetStatus>([
  BetStatus.DECLINED,
  BetStatus.LOSS,
  BetStatus.VOID,
  BetStatus.WIN,
]);

const TERMINAL_ROW_STATUSES = new Set<SlipRowStatus>([
  SlipRowStatus.LOSS,
  SlipRowStatus.VOID,
  SlipRowStatus.WIN,
]);

const PENDING_UPDATE_PRIORITY: Record<PendingBetUpdateKind, number> = {
  [PendingBetUpdateKind.MODERATION_RESULT]: 0,
  [PendingBetUpdateKind.SETTLE_SLIP_ROW]: 1,
  [PendingBetUpdateKind.SETTLE_SLIP]: 2,
};

const normalizeBetKind = (betKind?: BetKind | null): BetKind =>
  betKind ?? BetKind.PRE_MATCH;

const resolveEventTimestamp = (timestamp?: string) =>
  timestamp ?? new Date().toISOString();

const resolvePlaceBetTimestamp = (event: IPlaceBetEvent) =>
  event.timestamp
  ?? event.data.rows.find((row) => typeof row.timestamp === "string")?.timestamp
  ?? resolveEventTimestamp(undefined);

const resolvePlacementAttemptId = (data: PlaceBetEventData) => {
  if (
    typeof data.placementAttemptId === "string"
    && data.placementAttemptId.trim()
  ) {
    return data.placementAttemptId;
  }

  if (typeof data.attemptId === "string" && data.attemptId.trim()) {
    return data.attemptId;
  }

  return data.slipId;
};

const normalizeOptionalPlacementValue = <T>(value: T | null | undefined) =>
  value ?? undefined;

const mergeBetKind = (
  current?: BetKind | null,
  incoming?: BetKind | null
): BetKind => {
  if (current === BetKind.LIVE || incoming === BetKind.LIVE) {
    return BetKind.LIVE;
  }

  return current ?? incoming ?? BetKind.PRE_MATCH;
};

const inferBetKind = (data: Pick<IPlaceBetEvent["data"], "betKind" | "rows">) =>
  data.betKind === BetKind.LIVE ||
  data.rows.some((row) => row.betKind === BetKind.LIVE)
    ? BetKind.LIVE
    : BetKind.PRE_MATCH;

const setDefinedValue = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
) => {
  if (typeof value === "undefined" || target[key] === value) {
    return false;
  }

  target[key] = value;
  return true;
};

const setMissingValue = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
) => {
  if (
    typeof value === "undefined" ||
    typeof target[key] !== "undefined" ||
    target[key] === value
  ) {
    return false;
  }

  target[key] = value;
  return true;
};

const updateBetKind = (
  target: { betKind?: BetKind },
  incoming?: BetKind | null
) => {
  const nextBetKind = mergeBetKind(target.betKind, incoming);

  if (target.betKind === nextBetKind) {
    return false;
  }

  target.betKind = nextBetKind;
  return true;
};

const buildBetRow = (row: PlaceBetRow, fallbackBetKind: BetKind): BetRowRecord => ({
  eventId: row.eventId,
  eventName: row.eventName,
  oddsId: row.oddsId,
  oddsValue: row.oddsValue,
  oddsName: row.oddsName,
  productName: row.productName,
  productId: row.productId,
  status: SlipRowStatus.NOT_SETTLED,
  timestamp: row.timestamp,
  winningSelection: "",
  id: row.id,
  eventTime: row.eventTime,
  betKind: mergeBetKind(row.betKind, fallbackBetKind),
  marketId: row.marketId,
  marketType: row.marketType,
  marketVersion: row.marketVersion,
  quoteVersion: row.quoteVersion,
  selectionId: row.selectionId,
  side: row.side,
  selectedAt: row.selectedAt,
  quoteValidUntil: row.quoteValidUntil,
});

const buildBetRecord = (event: IPlaceBetEvent): BetRecord => {
  const betKind = inferBetKind(event.data);

  return {
    status: BetStatus.PENDING,
    userId: event.data.userId,
    userName: event.data.userName,
    slipId: event.data.slipId,
    wager: event.data.wager,
    timestamp: resolvePlaceBetTimestamp(event),
    betKind,
    rows: event.data.rows.map((row) => buildBetRow(row, betKind)),
  };
};

const buildCanonicalPlacedBetRow = (
  row: Pick<
    BetRowRecord,
    | "eventId"
    | "eventName"
    | "oddsId"
    | "oddsName"
    | "oddsValue"
    | "productId"
    | "productName"
    | "timestamp"
    | "id"
    | "eventTime"
    | "betKind"
    | "marketId"
    | "marketType"
    | "marketVersion"
    | "quoteVersion"
    | "selectionId"
    | "side"
    | "selectedAt"
    | "quoteValidUntil"
  >,
  fallbackBetKind: BetKind
): CanonicalPlacedBetRow => ({
  id: row.id,
  eventId: row.eventId,
  eventName: row.eventName,
  oddsId: row.oddsId,
  oddsName: row.oddsName,
  oddsValue: row.oddsValue,
  productId: row.productId,
  productName: row.productName,
  timestamp: row.timestamp,
  eventTime: normalizeOptionalPlacementValue(row.eventTime),
  betKind: normalizeBetKind(row.betKind ?? fallbackBetKind),
  marketId: normalizeOptionalPlacementValue(row.marketId),
  marketType: normalizeOptionalPlacementValue(row.marketType),
  marketVersion: normalizeOptionalPlacementValue(row.marketVersion),
  quoteVersion: normalizeOptionalPlacementValue(row.quoteVersion),
  selectionId: normalizeOptionalPlacementValue(row.selectionId),
  side: normalizeOptionalPlacementValue(row.side),
  selectedAt: normalizeOptionalPlacementValue(row.selectedAt),
  quoteValidUntil: normalizeOptionalPlacementValue(row.quoteValidUntil),
});

export const buildCanonicalPlacedBetPayload = (
  event: IPlaceBetEvent
): CanonicalPlacedBetPayload => {
  const betKind = inferBetKind(event.data);

  return {
    betKind,
    placedAt: resolvePlaceBetTimestamp(event),
    rows: event.data.rows.map((row) =>
      buildCanonicalPlacedBetRow(
        {
          id: row.id,
          eventId: row.eventId,
          eventName: row.eventName,
          oddsId: row.oddsId,
          oddsName: row.oddsName,
          oddsValue: row.oddsValue,
          productId: row.productId,
          productName: row.productName,
          timestamp: row.timestamp,
          eventTime: row.eventTime,
          betKind: row.betKind,
          marketId: row.marketId,
          marketType: row.marketType,
          marketVersion: row.marketVersion,
          quoteVersion: row.quoteVersion,
          selectionId: row.selectionId,
          side: row.side,
          selectedAt: row.selectedAt,
          quoteValidUntil: row.quoteValidUntil,
        },
        betKind
      )
    ),
    slipId: event.data.slipId,
    userId: event.data.userId,
    userName: event.data.userName,
    wager: event.data.wager,
  };
};

export const buildCanonicalPlacedBetPayloadFromBet = (
  bet: Pick<BetRecord, "betKind" | "rows" | "slipId" | "timestamp" | "userId" | "userName" | "wager">
): CanonicalPlacedBetPayload => {
  const betKind = normalizeBetKind(bet.betKind);

  return {
    betKind,
    placedAt: bet.timestamp,
    rows: bet.rows.map((row) => buildCanonicalPlacedBetRow(row, betKind)),
    slipId: bet.slipId,
    userId: bet.userId,
    userName: bet.userName,
    wager: bet.wager,
  };
};

export const hashCanonicalPlacedBetPayload = (payload: CanonicalPlacedBetPayload) =>
  createHash("sha256").update(stableStringify(payload)).digest("hex");

const mergePlaceRow = (
  row: BetRowRecord,
  incoming: PlaceBetRow,
  fallbackBetKind: BetKind
) => {
  let changed = false;

  changed = setDefinedValue(row, "eventId", incoming.eventId) || changed;
  changed = setDefinedValue(row, "eventName", incoming.eventName) || changed;
  changed = setDefinedValue(row, "oddsId", incoming.oddsId) || changed;
  changed = setDefinedValue(row, "oddsValue", incoming.oddsValue) || changed;
  changed = setDefinedValue(row, "oddsName", incoming.oddsName) || changed;
  changed = setDefinedValue(row, "productName", incoming.productName) || changed;
  changed = setDefinedValue(row, "productId", incoming.productId) || changed;
  changed = setDefinedValue(row, "timestamp", incoming.timestamp) || changed;
  changed = setDefinedValue(row, "id", incoming.id) || changed;
  changed = setDefinedValue(row, "eventTime", incoming.eventTime) || changed;
  changed = setMissingValue(row, "marketId", incoming.marketId) || changed;
  changed = setMissingValue(row, "marketType", incoming.marketType) || changed;
  changed =
    setMissingValue(row, "marketVersion", incoming.marketVersion) || changed;
  changed =
    setMissingValue(row, "quoteVersion", incoming.quoteVersion) || changed;
  changed = setMissingValue(row, "selectionId", incoming.selectionId) || changed;
  changed = setMissingValue(row, "side", incoming.side) || changed;
  changed = setMissingValue(row, "selectedAt", incoming.selectedAt) || changed;
  changed =
    setMissingValue(row, "quoteValidUntil", incoming.quoteValidUntil) || changed;

  const nextBetKind = mergeBetKind(row.betKind, incoming.betKind ?? fallbackBetKind);
  if (row.betKind !== nextBetKind) {
    row.betKind = nextBetKind;
    changed = true;
  }

  return changed;
};

const ensureBetDefaults = (bet: BetDocument) => {
  let changed = false;

  if (!bet.status) {
    bet.status = BetStatus.PENDING;
    changed = true;
  }

  if (updateBetKind(bet, undefined)) {
    changed = true;
  }

  for (const row of bet.rows) {
    const nextRowKind = mergeBetKind(row.betKind, bet.betKind);
    if (row.betKind !== nextRowKind) {
      row.betKind = nextRowKind;
      changed = true;
    }

    if (typeof row.winningSelection === "undefined") {
      row.winningSelection = "";
      changed = true;
    }
  }

  return changed;
};

const mergePlaceBet = (bet: BetDocument, event: IPlaceBetEvent) => {
  let changed = ensureBetDefaults(bet);
  const incomingBetKind = inferBetKind(event.data);

  changed = setDefinedValue(bet, "userId", event.data.userId) || changed;
  changed = setDefinedValue(bet, "userName", event.data.userName) || changed;
  changed = setDefinedValue(bet, "wager", event.data.wager) || changed;
  changed =
    setMissingValue(bet, "timestamp", resolveEventTimestamp(event.timestamp)) ||
    changed;

  if (updateBetKind(bet, incomingBetKind)) {
    changed = true;
  }

  const betKind = normalizeBetKind(bet.betKind);
  const rowsById = new Map(bet.rows.map((row) => [row.id, row]));

  for (const incomingRow of event.data.rows) {
    const row = rowsById.get(incomingRow.id);

    if (!row) {
      bet.rows.push(buildBetRow(incomingRow, betKind));
      changed = true;
      continue;
    }

    changed = mergePlaceRow(row, incomingRow, betKind) || changed;
  }

  return changed;
};

const mapBetResultToStatus = (result: string) => {
  switch (result) {
    case ResultingStatus.BET_WIN:
      return BetStatus.WIN;
    case ResultingStatus.BET_LOSS:
      return BetStatus.LOSS;
    case ResultingStatus.BET_VOID:
      return BetStatus.VOID;
    case ResultingStatus.BET_APPROVED:
      return BetStatus.CONFIRMED;
    case ResultingStatus.BET_DECLINED:
      return BetStatus.DECLINED;
    case ResultingStatus.BET_PENDING:
      return BetStatus.PENDING;
    default:
      return undefined;
  }
};

const mapRowResultToStatus = (result: string) => {
  switch (result) {
    case ResultingStatus.ROW_WIN:
      return SlipRowStatus.WIN;
    case ResultingStatus.ROW_LOSS:
      return SlipRowStatus.LOSS;
    case ResultingStatus.ROW_VOID:
      return SlipRowStatus.VOID;
    case ResultingStatus.ROW_NO_RESULT:
      return SlipRowStatus.NOT_SETTLED;
    default:
      return undefined;
  }
};

const canAdvanceBetStatus = (current: BetStatus, target: BetStatus) => {
  if (current === target || TERMINAL_BET_STATUSES.has(current)) {
    return false;
  }

  if (current === BetStatus.CONFIRMED && target === BetStatus.PENDING) {
    return false;
  }

  return true;
};

const canAdvanceRowStatus = (current: SlipRowStatus, target: SlipRowStatus) => {
  if (current === target || TERMINAL_ROW_STATUSES.has(current)) {
    return false;
  }

  return target !== SlipRowStatus.NOT_SETTLED;
};

const applyModerationAffectedRow = (
  row: BetRowRecord,
  affectedRow: IModerationAffectedRow,
  fallbackBetKind: BetKind,
  defaultDeclineReason?: ModerationDeclineReason
) => {
  let changed = false;

  const nextBetKind = mergeBetKind(row.betKind, fallbackBetKind);
  if (row.betKind !== nextBetKind) {
    row.betKind = nextBetKind;
    changed = true;
  }

  changed =
    setDefinedValue(
      row,
      "declineReason",
      affectedRow.declineReason ?? defaultDeclineReason
    ) || changed;
  changed = setDefinedValue(row, "marketId", affectedRow.marketId) || changed;
  changed =
    setDefinedValue(row, "marketVersion", affectedRow.marketVersion) || changed;
  changed =
    setDefinedValue(row, "quoteVersion", affectedRow.quoteVersion) || changed;
  changed = setDefinedValue(row, "currentOdds", affectedRow.currentOdds) || changed;
  changed =
    setDefinedValue(row, "marketStatus", affectedRow.marketStatus) || changed;
  changed =
    setDefinedValue(row, "selectionId", affectedRow.selectionId) || changed;

  return changed;
};

const resolvePendingTimestamp = (timestamp: string) => {
  const time = new Date(timestamp).getTime();
  return Number.isNaN(time) ? 0 : time;
};

const resolvePendingSequence = (update: PendingBetUpdateDocument) => {
  if (update.kind !== PendingBetUpdateKind.SETTLE_SLIP_ROW) {
    return 0;
  }

  const payload = update.payload as ISettleSlipRowEvent;
  return payload.data.settlementSequence ?? 0;
};

const comparePendingUpdates = (
  left: PendingBetUpdateDocument,
  right: PendingBetUpdateDocument
) => {
  const priority =
    PENDING_UPDATE_PRIORITY[left.kind] - PENDING_UPDATE_PRIORITY[right.kind];
  if (priority !== 0) {
    return priority;
  }

  const sequence = resolvePendingSequence(left) - resolvePendingSequence(right);
  if (sequence !== 0) {
    return sequence;
  }

  const timestamp =
    resolvePendingTimestamp(left.timestamp) - resolvePendingTimestamp(right.timestamp);
  if (timestamp !== 0) {
    return timestamp;
  }

  return (
    (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0)
  );
};

const stableStringify = (value: unknown): string => {
  if (typeof value === "undefined") {
    return "undefined";
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right)
  );

  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
};

const MAX_PENDING_UPDATE_ERROR_LENGTH = 500;

export const sanitizePendingBetUpdateError = (error: unknown) => {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : JSON.stringify(error) ?? String(error ?? "Unknown error");

  return rawMessage
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PENDING_UPDATE_ERROR_LENGTH);
};

const buildPendingUpdateInsert = (
  kind: PendingBetUpdateKind,
  event: PendingBetEvent
): PendingUpdateInsert => {
  const nextAttemptAt = new Date();
  const dedupeKey = createHash("sha256")
    .update(`${kind}:${stableStringify(event.data)}`)
    .digest("hex");

  return {
    attemptCount: 0,
    slipId: event.data.slipId,
    kind,
    dedupeKey,
    nextAttemptAt,
    timestamp: resolveEventTimestamp(event.timestamp),
    payload: event,
    status: PendingBetUpdateStatus.PENDING,
  };
};

const isDuplicateKeyError = (error: unknown): error is { code: number } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: number }).code === 11000;

const recordPlacementConflict = async (
  bet: BetDocument,
  event: IPlaceBetEvent,
  existingFingerprint: string,
  incomingFingerprint: string
) => {
  const observedAt = resolveEventTimestamp(undefined);
  const placementAttemptId = resolvePlacementAttemptId(
    event.data as PlaceBetEventData
  );
  const conflictKey = createHash("sha256")
    .update(
      `${event.data.slipId}:${placementAttemptId}:${existingFingerprint}:${incomingFingerprint}`
    )
    .digest("hex");

  await BetPlacementConflict.updateOne(
    { conflictKey },
    {
      $inc: {
        occurrenceCount: 1,
      },
      $set: {
        lastSeenAt: observedAt,
        observedStatus: bet.status,
      },
      $setOnInsert: {
        conflictKey,
        slipId: event.data.slipId,
        placementAttemptId,
        firstPlacementFingerprint: existingFingerprint,
        conflictingPlacementFingerprint: incomingFingerprint,
        firstSeenAt: observedAt,
      },
    },
    { upsert: true }
  );
};

const classifyDuplicatePlaceBet = async (
  bet: BetDocument,
  event: IPlaceBetEvent
): Promise<PlaceBetPersistenceOutcome> => {
  const incomingFingerprint = hashCanonicalPlacedBetPayload(
    buildCanonicalPlacedBetPayload(event)
  );
  const existingFingerprint = hashCanonicalPlacedBetPayload(
    buildCanonicalPlacedBetPayloadFromBet(bet)
  );

  if (existingFingerprint === incomingFingerprint) {
    return "exact_duplicate";
  }

  await recordPlacementConflict(
    bet,
    event,
    existingFingerprint,
    incomingFingerprint
  );

  return "conflicting_duplicate";
};

export const upsertPlaceBet = async (
  event: IPlaceBetEvent
): Promise<PlaceBetPersistenceResult> => {
  const insertRecord = buildBetRecord(event);
  let inserted = false;

  try {
    const insertResult = await Bet.collection.updateOne(
      {
        slipId: event.data.slipId,
      },
      {
        $setOnInsert: insertRecord,
      },
      {
        upsert: true,
      }
    );

    inserted = insertResult.upsertedCount > 0;
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }

  const bet = await Bet.findOne({ slipId: event.data.slipId });

  if (!bet) {
    throw new Error("Bet placement insert did not return a persisted record");
  }

  if (inserted) {
    return {
      bet,
      outcome: "inserted",
    };
  }

  return {
    bet,
    outcome: await classifyDuplicatePlaceBet(bet, event),
  };
};

export const parkPendingBetUpdate = async (
  kind: PendingBetUpdateKind,
  event: PendingBetEvent
) => {
  const pendingUpdate = buildPendingUpdateInsert(kind, event);

  await PendingBetUpdate.updateOne(
    { dedupeKey: pendingUpdate.dedupeKey },
    { $setOnInsert: pendingUpdate },
    { upsert: true }
  );
};

export const applyModerationResult = (
  bet: BetDocument,
  event: IModerationResultEvent
) => {
  let changed = ensureBetDefaults(bet);
  changed = updateBetKind(bet, event.data.betKind) || changed;

  if (event.data.result === ModerationStatus.APPROVED) {
    if (!TERMINAL_BET_STATUSES.has(bet.status) && bet.status !== BetStatus.CONFIRMED) {
      bet.status = BetStatus.CONFIRMED;
      changed = true;
    }

    return changed;
  }

  if (event.data.result !== ModerationStatus.DECLINED) {
    return changed;
  }

  if (
    bet.status === BetStatus.WIN ||
    bet.status === BetStatus.LOSS ||
    bet.status === BetStatus.VOID
  ) {
    return changed;
  }

  if (bet.status !== BetStatus.DECLINED) {
    bet.status = BetStatus.DECLINED;
    changed = true;
  }

  changed =
    setDefinedValue(bet, "declineReason", event.data.declineReason) || changed;

  if ((event.data.affectedRows?.length ?? 0) > 0) {
    const betKind = normalizeBetKind(bet.betKind);
    const rowsById = new Map(bet.rows.map((row) => [row.id, row]));

    for (const affectedRow of event.data.affectedRows ?? []) {
      const row = rowsById.get(affectedRow.rowId);

      if (!row) {
        continue;
      }

      changed =
        applyModerationAffectedRow(
          row,
          affectedRow,
          betKind,
          event.data.declineReason
        ) || changed;
    }

    return changed;
  }

  if (typeof event.data.declineReason === "undefined") {
    return changed;
  }

  const betKind = normalizeBetKind(bet.betKind);
  for (const row of bet.rows) {
    changed =
      applyModerationAffectedRow(
        row,
        {
          rowId: row.id,
          declineReason: event.data.declineReason,
        },
        betKind,
        event.data.declineReason
      ) || changed;
  }

  return changed;
};

export const applySettleSlip = (
  bet: BetDocument,
  event: ISettleSlipEvent
) => {
  let changed = ensureBetDefaults(bet);
  changed = updateBetKind(bet, event.data.betKind) || changed;

  const targetStatus = mapBetResultToStatus(event.data.result);
  if (!targetStatus || !canAdvanceBetStatus(bet.status, targetStatus)) {
    return changed;
  }

  bet.status = targetStatus;
  return true;
};

export const applySettleSlipRow = (
  bet: BetDocument,
  event: ISettleSlipRowEvent
) => {
  let changed = ensureBetDefaults(bet);
  changed = updateBetKind(bet, event.data.betKind) || changed;

  const row = bet.rows.find(
    (candidate) => candidate.id === event.data.slipRowId
  );

  if (!row) {
    return changed;
  }

  const currentBetKind = normalizeBetKind(bet.betKind);
  const nextBetKind = mergeBetKind(row.betKind, event.data.betKind ?? currentBetKind);
  if (row.betKind !== nextBetKind) {
    row.betKind = nextBetKind;
    changed = true;
  }

  changed = setDefinedValue(row, "marketId", event.data.marketId) || changed;
  changed = setDefinedValue(row, "marketType", event.data.marketType) || changed;
  changed =
    setDefinedValue(row, "marketVersion", event.data.marketVersion) || changed;

  const targetStatus = mapRowResultToStatus(event.data.result);
  if (
    targetStatus &&
    TERMINAL_ROW_STATUSES.has(row.status) &&
    row.status !== targetStatus
  ) {
    return changed;
  }

  changed =
    setDefinedValue(row, "winningSelection", event.data.winningSelection) ||
    changed;
  changed = setDefinedValue(row, "winningSide", event.data.winningSide) || changed;
  changed =
    setDefinedValue(row, "settlementReason", event.data.settlementReason) ||
    changed;
  changed =
    setDefinedValue(row, "settlementSequence", event.data.settlementSequence) ||
    changed;

  if (targetStatus && canAdvanceRowStatus(row.status, targetStatus)) {
    row.status = targetStatus;
    changed = true;
  }

  return changed;
};

export const loadOwnedPendingBetUpdates = async (
  pendingUpdateIds: Array<PendingBetUpdateDocument["_id"]>,
  leaseOwner: string
) =>
  PendingBetUpdate.find({
    _id: {
      $in: pendingUpdateIds,
    },
    leaseOwner,
    status: PendingBetUpdateStatus.PROCESSING,
  });

export const applyPendingBetUpdatesToBet = async (
  bet: BetDocument,
  pendingUpdates: PendingBetUpdateDocument[],
  control: ApplyPendingBetUpdatesToBetControl = {}
): Promise<ApplyPendingBetUpdatesToBetResult> => {
  const orderedUpdates = [...pendingUpdates].sort(comparePendingUpdates);
  let changed = ensureBetDefaults(bet);
  let ownershipLost = false;
  const processedPendingUpdates: PendingBetUpdateDocument[] = [];

  for (const pendingUpdate of orderedUpdates) {
    if (control.beforeApply) {
      const shouldContinue = await control.beforeApply(pendingUpdate);

      if (!shouldContinue) {
        ownershipLost = true;
        break;
      }
    }

    switch (pendingUpdate.kind) {
      case PendingBetUpdateKind.MODERATION_RESULT:
        changed =
          applyModerationResult(
            bet,
            pendingUpdate.payload as IModerationResultEvent
          ) || changed;
        break;
      case PendingBetUpdateKind.SETTLE_SLIP_ROW:
        changed =
          applySettleSlipRow(
            bet,
            pendingUpdate.payload as ISettleSlipRowEvent
          ) || changed;
        break;
      case PendingBetUpdateKind.SETTLE_SLIP:
        changed =
          applySettleSlip(bet, pendingUpdate.payload as ISettleSlipEvent) ||
          changed;
        break;
    }

    processedPendingUpdates.push(pendingUpdate);
  }

  if (changed && processedPendingUpdates.length > 0) {
    await bet.save();
  }

  return {
    changed,
    ownershipLost,
    processedPendingUpdates,
  };
};
