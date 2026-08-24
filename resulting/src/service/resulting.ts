import {
  BetKind,
  IEventResultEvent,
  ILiveEventUpdateEvent,
  IModerationResultEvent,
  IPlaceBetEvent,
  ISettleSlipRowEvent,
  LiveMarketType,
  LiveSettlementReason,
  ModerationStatus,
  ResultingStatus,
  TeamSide,
} from "@betstan/common";
import { randomUUID } from "crypto";
import SettleSlipPublisher from "../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../event/publisher/SettleSlipRowPublisher";
import { Bet, BetArchive } from "../model/Bet";
import FinalScoreLedger from "../model/FinalScoreLedger";
import LiveSettlementLedger from "../model/LiveSettlementLedger";
import {
  clearPendingModerationResult,
  parkPendingModerationResult,
  PendingModerationReplayOutcome,
  recoverPendingModerationForSlip,
} from "./pendingModeration";

const PRE_MATCH_PRODUCTS = new Set(["1X2", "Correct Score"]);
const SETTLED_BET_STATUS_VALUES = [
  ResultingStatus.BET_WIN,
  ResultingStatus.BET_LOSS,
  ResultingStatus.BET_VOID,
] as const;
const ACTIVE_SETTLEMENT_STATUS_VALUES = [
  ResultingStatus.BET_APPROVED,
  ...SETTLED_BET_STATUS_VALUES,
] as const;
const TERMINAL_BET_STATUS_VALUES = [
  ...SETTLED_BET_STATUS_VALUES,
  ResultingStatus.BET_DECLINED,
] as const;
const SETTLED_BET_STATUSES = new Set<ResultingStatus>(SETTLED_BET_STATUS_VALUES);
const TERMINAL_BET_STATUSES = new Set<ResultingStatus>(
  TERMINAL_BET_STATUS_VALUES
);
const PUBLICATION_STATE_PENDING = "PENDING";
const PUBLICATION_STATE_PUBLISHING = "PUBLISHING";
const PUBLICATION_STATE_PUBLISHED = "PUBLISHED";
// If a terminal publish claim is never confirmed (process crash between the
// broker confirming the publish and us persisting PUBLISHED), the sweep is
// allowed to reclaim it after this long so the slip can never get stuck
// forever. Downstream consumers must treat repeat settle-slip events for an
// already-terminal slip as no-ops (see bet/ moderation + settlement guards)
// so a reclaim that turns out to duplicate a successful publish stays safe.
const TERMINAL_CLAIM_STALE_MS = 30_000;

const slipLocks = new Map<string, Promise<void>>();

export interface SettlementPublishers {
  settleSlipPublisher: SettleSlipPublisher;
  settleSlipRowPublisher: SettleSlipRowPublisher;
}

interface StoredLiveSettlement {
  eventId: string;
  occurredAt: string;
  marketId: string;
  marketType?: LiveMarketType;
  marketVersion: number;
  settlementReason: LiveSettlementReason;
  settlementSequence: number;
  winningSide: TeamSide;
  winningSelection?: string;
}

interface StoredFinalScore {
  eventId: string;
  occurredAt: string;
  homeScore: number;
  awayScore: number;
  home: string;
  away: string;
  correctScoreResult: string;
  oneCrossTwoResult: string;
}

interface RowDecision {
  result:
    | ResultingStatus.ROW_WIN
    | ResultingStatus.ROW_LOSS
    | ResultingStatus.ROW_VOID;
  removeRow?: boolean;
  winningSelection?: string;
  winningSide?: TeamSide;
  settlementReason?: LiveSettlementReason;
  settlementSequence?: number;
}

function normalizeBetKind(kind?: BetKind): BetKind {
  return kind === BetKind.LIVE ? BetKind.LIVE : BetKind.PRE_MATCH;
}

function resolveRowBetKind(bet: any, row: any): BetKind {
  return normalizeBetKind((row.betKind ?? bet.betKind) as BetKind | undefined);
}

function isLiveRow(bet: any, row: any): boolean {
  return resolveRowBetKind(bet, row) === BetKind.LIVE;
}

function isPreMatchRow(bet: any, row: any): boolean {
  return !isLiveRow(bet, row) && PRE_MATCH_PRODUCTS.has(row.productName);
}

function inferMarketType(marketId: string): LiveMarketType | undefined {
  return Object.values(LiveMarketType).find((type) =>
    marketId.endsWith(`:${type}`)
  );
}

function buildStoredFinalScore(event: IEventResultEvent): StoredFinalScore {
  const oneCrossTwoResult =
    Number(event.data.homeScore) > Number(event.data.awayScore)
      ? event.data.home
      : Number(event.data.homeScore) < Number(event.data.awayScore)
        ? event.data.away
        : "draw";

  return {
    eventId: event.data.eventId,
    occurredAt: event.timestamp ?? new Date().toISOString(),
    homeScore: event.data.homeScore,
    awayScore: event.data.awayScore,
    home: event.data.home,
    away: event.data.away,
    correctScoreResult: `${event.data.homeScore} - ${event.data.awayScore}`,
    oneCrossTwoResult,
  };
}

function buildStoredLiveSettlement(
  update: ILiveEventUpdateEvent["data"],
  settlement: ILiveEventUpdateEvent["data"]["settlements"][number]
): StoredLiveSettlement {
  const currentMarket = update.markets.find(
    (market) => market.marketId === settlement.marketId
  );

  return {
    eventId: update.eventId,
    occurredAt: update.occurredAt,
    marketId: settlement.marketId,
    marketType:
      currentMarket?.marketType ?? inferMarketType(settlement.marketId),
    marketVersion: settlement.marketVersion,
    settlementReason: settlement.settlementReason,
    settlementSequence: settlement.settlementSequence,
    winningSide: settlement.winningSide,
    winningSelection: settlement.winningSelection ?? "",
  };
}

function dedupeRows(
  rows: IPlaceBetEvent["data"]["rows"],
  defaultBetKind: BetKind
): any[] {
  const seen = new Set<string>();
  const normalizedRows: any[] = [];

  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }

    seen.add(row.id);

    normalizedRows.push({
      eventId: row.eventId,
      eventName: row.eventName,
      oddsId: row.oddsId,
      oddsValue: row.oddsValue,
      oddsName: row.oddsName,
      productName: row.productName,
      productId: row.productId,
      timestamp: row.timestamp,
      eventTime: row.eventTime,
      id: row.id,
      betKind: normalizeBetKind(row.betKind ?? defaultBetKind),
      marketId: row.marketId,
      marketType: row.marketType,
      marketVersion: row.marketVersion,
      quoteVersion: row.quoteVersion,
      selectionId: row.selectionId,
      side: row.side,
      selectedAt: row.selectedAt ?? row.timestamp,
      quoteValidUntil: row.quoteValidUntil,
      winningSelection: "",
      resultingTimestamp: "",
      settlementPublicationState: "",
      pendingRemoval: false,
      result: ResultingStatus.ROW_NO_RESULT,
    });
  }

  return normalizedRows;
}

function inferBetKind(rows: any[], explicit?: BetKind): BetKind {
  if (explicit === BetKind.LIVE) {
    return BetKind.LIVE;
  }

  return rows.some((row) => row.betKind === BetKind.LIVE)
    ? BetKind.LIVE
    : BetKind.PRE_MATCH;
}

function isSettledBetStatus(status: string): boolean {
  return SETTLED_BET_STATUSES.has(status as ResultingStatus);
}

function hasPendingRowPublications(bet: any): boolean {
  return bet.rows.some(
    (row: any) =>
      row.result !== ResultingStatus.ROW_NO_RESULT
      && row.settlementPublicationState !== PUBLICATION_STATE_PUBLISHED
  );
}

async function withSlipLock<T>(
  slipId: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = slipLocks.get(slipId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);

  slipLocks.set(slipId, chained);
  await previous;

  try {
    return await action();
  } finally {
    release();
    if (slipLocks.get(slipId) === chained) {
      slipLocks.delete(slipId);
    }
  }
}

function evaluatePreMatchDecision(
  row: any,
  result: StoredFinalScore
): RowDecision | null {
  switch (row.productName) {
    case "1X2":
      return {
        result:
          row.oddsName === result.oneCrossTwoResult
            ? ResultingStatus.ROW_WIN
            : ResultingStatus.ROW_LOSS,
        winningSelection: result.oneCrossTwoResult,
      };
    case "Correct Score":
      return {
        result:
          row.oddsName === result.correctScoreResult
            ? ResultingStatus.ROW_WIN
            : ResultingStatus.ROW_LOSS,
        winningSelection: result.correctScoreResult,
      };
    default:
      return null;
  }
}

function evaluateLiveDecision(
  row: any,
  settlement: StoredLiveSettlement
): RowDecision {
  if (settlement.settlementReason === LiveSettlementReason.MANUAL_VOID) {
    return {
      result: ResultingStatus.ROW_VOID,
      removeRow: true,
      winningSelection: settlement.winningSelection ?? "",
      winningSide: settlement.winningSide,
      settlementReason: settlement.settlementReason,
      settlementSequence: settlement.settlementSequence,
    };
  }

  const normalizedOddsName = String(row.oddsName ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  const matchesSelection =
    row.selectionId && settlement.winningSelection
      ? row.selectionId === settlement.winningSelection
      : false;
  const matchesSide = row.side
    ? row.side === settlement.winningSide
    : normalizedOddsName === settlement.winningSide;

  return {
    result:
      matchesSelection || matchesSide
        ? ResultingStatus.ROW_WIN
        : ResultingStatus.ROW_LOSS,
    winningSelection: settlement.winningSelection ?? "",
    winningSide: settlement.winningSide,
    settlementReason: settlement.settlementReason,
    settlementSequence: settlement.settlementSequence,
  };
}

async function applyWinningDecision(
  bet: any,
  row: any,
  decision: RowDecision
): Promise<boolean> {
  const resultingTimestamp = new Date().toISOString();
  const setFields: Record<string, unknown> = {
    "rows.$[target].result": ResultingStatus.ROW_WIN,
    "rows.$[target].winningSelection": decision.winningSelection ?? "",
    "rows.$[target].resultingTimestamp": resultingTimestamp,
    "rows.$[target].settlementPublicationState": PUBLICATION_STATE_PENDING,
    "rows.$[target].pendingRemoval": false,
  };

  if (decision.winningSide !== undefined) {
    setFields["rows.$[target].winningSide"] = decision.winningSide;
  }

  if (decision.settlementReason !== undefined) {
    setFields["rows.$[target].settlementReason"] = decision.settlementReason;
  }

  if (decision.settlementSequence !== undefined) {
    setFields["rows.$[target].settlementSequence"] =
      decision.settlementSequence;
  }

  const updatedBet = await Bet.findOneAndUpdate(
    {
      slipId: bet.slipId,
      status: ResultingStatus.BET_APPROVED,
      rows: {
        $elemMatch: {
          id: row.id,
          result: ResultingStatus.ROW_NO_RESULT,
        },
      },
    },
    {
      $set: setFields,
    },
    {
      new: true,
      arrayFilters: [
        {
          "target.id": row.id,
          "target.result": ResultingStatus.ROW_NO_RESULT,
        },
      ],
    }
  );

  return Boolean(updatedBet);
}

async function applyLossDecision(
  bet: any,
  row: any,
  decision: RowDecision
): Promise<boolean> {
  const resultingTimestamp = new Date().toISOString();
  const setFields: Record<string, unknown> = {
    status: ResultingStatus.BET_LOSS,
    resultingTimestamp,
    terminalPublicationState: PUBLICATION_STATE_PENDING,
    "rows.$[target].result": ResultingStatus.ROW_LOSS,
    "rows.$[target].winningSelection": decision.winningSelection ?? "",
    "rows.$[target].resultingTimestamp": resultingTimestamp,
    "rows.$[target].settlementPublicationState": PUBLICATION_STATE_PENDING,
    "rows.$[target].pendingRemoval": false,
    "rows.$[remaining].result": ResultingStatus.ROW_VOID,
    "rows.$[remaining].winningSelection": "",
    "rows.$[remaining].resultingTimestamp": resultingTimestamp,
    "rows.$[remaining].settlementReason":
      LiveSettlementReason.ACCUMULATOR_SETTLED,
    "rows.$[remaining].settlementPublicationState":
      PUBLICATION_STATE_PENDING,
    "rows.$[remaining].pendingRemoval": false,
  };

  if (decision.winningSide !== undefined) {
    setFields["rows.$[target].winningSide"] = decision.winningSide;
  }

  if (decision.settlementReason !== undefined) {
    setFields["rows.$[target].settlementReason"] = decision.settlementReason;
  }

  if (decision.settlementSequence !== undefined) {
    setFields["rows.$[target].settlementSequence"] =
      decision.settlementSequence;
  }

  const updatedBet = await Bet.findOneAndUpdate(
    {
      slipId: bet.slipId,
      status: ResultingStatus.BET_APPROVED,
      rows: {
        $elemMatch: {
          id: row.id,
          result: ResultingStatus.ROW_NO_RESULT,
        },
      },
    },
    {
      $set: setFields,
    },
    {
      new: true,
      arrayFilters: [
        {
          "target.id": row.id,
          "target.result": ResultingStatus.ROW_NO_RESULT,
        },
        {
          "remaining.id": { $ne: row.id },
          "remaining.result": ResultingStatus.ROW_NO_RESULT,
        },
      ],
    }
  );

  return Boolean(updatedBet);
}

async function applyManualVoidDecision(
  bet: any,
  row: any,
  decision: RowDecision
): Promise<boolean> {
  const resultingTimestamp = new Date().toISOString();
  const setFields: Record<string, unknown> = {
    "rows.$[target].result": ResultingStatus.ROW_VOID,
    "rows.$[target].winningSelection": decision.winningSelection ?? "",
    "rows.$[target].resultingTimestamp": resultingTimestamp,
    "rows.$[target].settlementPublicationState": PUBLICATION_STATE_PENDING,
    "rows.$[target].pendingRemoval": true,
  };

  if (decision.winningSide !== undefined) {
    setFields["rows.$[target].winningSide"] = decision.winningSide;
  }

  if (decision.settlementReason !== undefined) {
    setFields["rows.$[target].settlementReason"] = decision.settlementReason;
  }

  if (decision.settlementSequence !== undefined) {
    setFields["rows.$[target].settlementSequence"] =
      decision.settlementSequence;
  }

  const updatedBet = await Bet.findOneAndUpdate(
    {
      slipId: bet.slipId,
      status: ResultingStatus.BET_APPROVED,
      rows: {
        $elemMatch: {
          id: row.id,
          result: ResultingStatus.ROW_NO_RESULT,
        },
      },
    },
    {
      $set: setFields,
    },
    {
      new: true,
      arrayFilters: [
        {
          "target.id": row.id,
          "target.result": ResultingStatus.ROW_NO_RESULT,
        },
      ],
    }
  );

  return Boolean(updatedBet);
}

async function applyRowDecision(
  bet: any,
  row: any,
  decision: RowDecision
): Promise<boolean> {
  if (decision.result === ResultingStatus.ROW_LOSS) {
    return applyLossDecision(bet, row, decision);
  }

  if (decision.result === ResultingStatus.ROW_VOID && decision.removeRow) {
    return applyManualVoidDecision(bet, row, decision);
  }

  return applyWinningDecision(bet, row, decision);
}

function buildRowSettlementData(
  bet: any,
  row: any
): ISettleSlipRowEvent["data"] {
  const settleRowData: ISettleSlipRowEvent["data"] = {
    slipId: bet.slipId,
    slipRowId: row.id,
    result: row.result,
    betKind: resolveRowBetKind(bet, row),
  };

  if (row.winningSelection !== undefined) {
    settleRowData.winningSelection = row.winningSelection;
  }

  if (row.winningSide !== undefined) {
    settleRowData.winningSide = row.winningSide;
  }

  if (row.marketId) {
    settleRowData.marketId = row.marketId;
  }

  if (row.marketType) {
    settleRowData.marketType = row.marketType;
  }

  if (typeof row.marketVersion === "number") {
    settleRowData.marketVersion = row.marketVersion;
  }

  if (row.settlementReason) {
    settleRowData.settlementReason = row.settlementReason;
  }

  if (typeof row.settlementSequence === "number") {
    settleRowData.settlementSequence = row.settlementSequence;
  }

  return settleRowData;
}

async function publishPendingRowSettlements(
  bet: any,
  publishers: SettlementPublishers
): Promise<boolean> {
  let publishedAny = false;

  for (const row of bet.rows) {
    if (
      row.result === ResultingStatus.ROW_NO_RESULT
      || row.settlementPublicationState === PUBLICATION_STATE_PUBLISHED
    ) {
      continue;
    }

    await publishers.settleSlipRowPublisher.publishWithConfirm({
      data: buildRowSettlementData(bet, row),
    });

    await Bet.updateOne(
      {
        slipId: bet.slipId,
      },
      {
        $set: {
          "rows.$[target].settlementPublicationState":
            PUBLICATION_STATE_PUBLISHED,
        },
      },
      {
        arrayFilters: [
          {
            "target.id": row.id,
            "target.settlementPublicationState": {
              $ne: PUBLICATION_STATE_PUBLISHED,
            },
          },
        ],
      }
    );

    publishedAny = true;
  }

  return publishedAny;
}

async function cleanupPublishedManualVoidRows(slipId: string): Promise<boolean> {
  const result = await Bet.updateOne(
    {
      slipId,
      status: ResultingStatus.BET_APPROVED,
      rows: {
        $elemMatch: {
          pendingRemoval: true,
          settlementPublicationState: PUBLICATION_STATE_PUBLISHED,
        },
      },
    },
    {
      $pull: {
        rows: {
          pendingRemoval: true,
          settlementPublicationState: PUBLICATION_STATE_PUBLISHED,
        },
      },
    }
  );

  return result.modifiedCount > 0;
}

async function finalizeApprovedSlipIfReady(slipId: string): Promise<boolean> {
  const bet = await Bet.findOne({
    slipId,
    status: ResultingStatus.BET_APPROVED,
  });

  if (!bet) {
    return false;
  }

  if (
    bet.rows.some(
      (row: any) =>
        row.result === ResultingStatus.ROW_NO_RESULT
        || row.pendingRemoval
        || row.settlementPublicationState !== PUBLICATION_STATE_PUBLISHED
    )
  ) {
    return false;
  }

  const nonVoidRows = bet.rows.filter(
    (row: any) => row.result !== ResultingStatus.ROW_VOID
  );
  const nextStatus =
    nonVoidRows.length === 0
      ? ResultingStatus.BET_VOID
      : ResultingStatus.BET_WIN;

  const updatedBet = await Bet.findOneAndUpdate(
    {
      _id: bet._id,
      status: ResultingStatus.BET_APPROVED,
    },
    {
      $set: {
        status: nextStatus,
        resultingTimestamp: new Date().toISOString(),
        terminalPublicationState: PUBLICATION_STATE_PENDING,
      },
    },
    { new: true }
  );

  return Boolean(updatedBet);
}

async function confirmTerminalSettlement(
  bet: any,
  publishers: SettlementPublishers
): Promise<boolean> {
  if (
    !isSettledBetStatus(bet.status)
    || bet.terminalPublicationState === PUBLICATION_STATE_PUBLISHED
    || bet.rows.some(
      (row: any) =>
        row.pendingRemoval
        || row.result === ResultingStatus.ROW_NO_RESULT
        || row.settlementPublicationState !== PUBLICATION_STATE_PUBLISHED
    )
  ) {
    return false;
  }

  const now = new Date();
  const staleClaimBefore = new Date(now.getTime() - TERMINAL_CLAIM_STALE_MS);
  const claimId = randomUUID();

  // Durably claim the right to publish before we actually publish. This
  // gives us a tombstone (state + timestamp) that survives a crash, and
  // stops two concurrent reconcile passes (e.g. an event handler racing the
  // sweep worker) from both calling publishWithConfirm for the same slip.
  const claimedBet = await Bet.findOneAndUpdate(
    {
      _id: bet._id,
      $or: [
        {
          terminalPublicationState: {
            $in: ["", PUBLICATION_STATE_PENDING],
          },
        },
        {
          terminalPublicationState: PUBLICATION_STATE_PUBLISHING,
          terminalPublicationClaimedAt: {
            $lte: staleClaimBefore,
          },
        },
      ],
    },
    {
      $set: {
        terminalPublicationState: PUBLICATION_STATE_PUBLISHING,
        terminalPublicationClaimedAt: now,
        terminalPublicationClaimId: claimId,
      },
    },
    { new: true }
  );

  if (!claimedBet) {
    return false;
  }

  try {
    await publishers.settleSlipPublisher.publishWithConfirm({
      data: {
        slipId: bet.slipId,
        result: bet.status,
      },
    });
  } catch (error) {
    // The publish definitely failed, so it is safe to release the claim
    // immediately rather than waiting out the stale-claim window.
    await Bet.updateOne(
      {
        _id: bet._id,
        terminalPublicationState: PUBLICATION_STATE_PUBLISHING,
        terminalPublicationClaimId: claimId,
      },
      {
        $set: {
          terminalPublicationState: PUBLICATION_STATE_PENDING,
        },
        $unset: {
          terminalPublicationClaimedAt: "",
          terminalPublicationClaimId: "",
        },
      }
    );

    throw error;
  }

  const updatedBet = await Bet.findOneAndUpdate(
    {
      _id: bet._id,
      terminalPublicationState: PUBLICATION_STATE_PUBLISHING,
      terminalPublicationClaimId: claimId,
    },
    {
      $set: {
        terminalPublicationState: PUBLICATION_STATE_PUBLISHED,
      },
      $unset: {
        terminalPublicationClaimedAt: "",
        terminalPublicationClaimId: "",
      },
    },
    { new: true }
  );

  return Boolean(updatedBet);
}

async function archiveBet(finalizedBet: any): Promise<void> {
  const jsonBet = finalizedBet.toObject();
  delete jsonBet._id;

  await BetArchive.updateOne(
    { slipId: finalizedBet.slipId },
    { $setOnInsert: jsonBet },
    {
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );

  await Bet.deleteOne({
    _id: finalizedBet._id,
    status: finalizedBet.status,
    terminalPublicationState: PUBLICATION_STATE_PUBLISHED,
  });

  await clearPendingModerationResult(finalizedBet.slipId);
}

async function archivePublishedBet(slipId: string): Promise<boolean> {
  const bet = await Bet.findOne({
    slipId,
    status: {
      $in: [...SETTLED_BET_STATUS_VALUES],
    },
    terminalPublicationState: PUBLICATION_STATE_PUBLISHED,
  });

  if (!bet) {
    return false;
  }

  await archiveBet(bet);
  return true;
}

export async function reconcileSlip(
  slipId: string,
  publishers: SettlementPublishers
): Promise<void> {
  await withSlipLock(slipId, async () => {
    while (true) {
      const bet = await Bet.findOne({ slipId });

      if (!bet) {
        return;
      }

      let progressed = false;

      if (hasPendingRowPublications(bet)) {
        if (await publishPendingRowSettlements(bet, publishers)) {
          progressed = true;
        }
      }

      if (await cleanupPublishedManualVoidRows(slipId)) {
        progressed = true;
      }

      if (await finalizeApprovedSlipIfReady(slipId)) {
        progressed = true;
      }

      const refreshedBet = await Bet.findOne({ slipId });

      if (!refreshedBet) {
        return;
      }

      if (await confirmTerminalSettlement(refreshedBet, publishers)) {
        progressed = true;
      }

      if (await archivePublishedBet(slipId)) {
        progressed = true;
      }

      if (!progressed) {
        return;
      }
    }
  });
}

/**
 * Finds slips whose settlement is "terminal-pending": either fully resulted
 * but never finalized into a settled status, or finalized but not yet
 * confirmed as published (and archived). These slips cannot always be
 * rediscovered by replaying the event that originally triggered them - e.g.
 * a manual-void row is removed from `rows` once published, so a later replay
 * of that same live update will no longer find a matching row. This sweep
 * lets the terminal settlement worker recover such slips independently of
 * any future event arriving for them.
 */
export async function findTerminalPendingSlipIds(
  limit: number = 100
): Promise<string[]> {
  const bets = await Bet.find({
    $or: [
      {
        status: {
          $in: [...SETTLED_BET_STATUS_VALUES],
        },
        terminalPublicationState: {
          $ne: PUBLICATION_STATE_PUBLISHED,
        },
      },
      {
        status: ResultingStatus.BET_APPROVED,
        rows: {
          $not: {
            $elemMatch: {
              $or: [
                { result: ResultingStatus.ROW_NO_RESULT },
                { pendingRemoval: true },
                {
                  settlementPublicationState: {
                    $ne: PUBLICATION_STATE_PUBLISHED,
                  },
                },
              ],
            },
          },
        },
      },
    ],
  })
    .select({ slipId: 1 })
    .limit(limit)
    .lean();

  return bets.map((bet: any) => bet.slipId as string);
}

async function settleApprovedPreMatchRows(
  bet: any,
  result: StoredFinalScore
): Promise<void> {
  for (const row of bet.rows) {
    if (
      row.eventId !== result.eventId
      || row.result !== ResultingStatus.ROW_NO_RESULT
      || !isPreMatchRow(bet, row)
    ) {
      continue;
    }

    const decision = evaluatePreMatchDecision(row, result);

    if (!decision) {
      continue;
    }

    const changed = await applyRowDecision(bet, row, decision);

    if (changed && decision.result === ResultingStatus.ROW_LOSS) {
      break;
    }
  }
}

async function settleApprovedLiveRows(
  bet: any,
  settlement: StoredLiveSettlement
): Promise<void> {
  for (const row of bet.rows) {
    if (
      row.marketId !== settlement.marketId
      || row.marketVersion !== settlement.marketVersion
      || row.result !== ResultingStatus.ROW_NO_RESULT
      || !isLiveRow(bet, row)
    ) {
      continue;
    }

    if (
      settlement.marketType
      && row.marketType
      && row.marketType !== settlement.marketType
    ) {
      continue;
    }

    const decision = evaluateLiveDecision(row, settlement);
    const changed = await applyRowDecision(bet, row, decision);

    if (changed && decision.result === ResultingStatus.ROW_LOSS) {
      break;
    }
  }
}

async function replayFinalScoresForSlip(slipId: string): Promise<void> {
  const bet = await Bet.findOne({
    slipId,
    status: ResultingStatus.BET_APPROVED,
  });

  if (!bet) {
    return;
  }

  const eventIds = [...new Set(
    bet.rows
      .filter(
        (row: any) =>
          row.result === ResultingStatus.ROW_NO_RESULT && isPreMatchRow(bet, row)
      )
      .map((row: any) => row.eventId)
  )];

  if (eventIds.length === 0) {
    return;
  }

  const results = await FinalScoreLedger.find({
    eventId: { $in: eventIds },
  }).sort({
    occurredAt: 1,
    eventId: 1,
  });

  for (const result of results) {
    const currentBet = await Bet.findOne({
      slipId,
      status: ResultingStatus.BET_APPROVED,
    });

    if (!currentBet) {
      break;
    }

    await settleApprovedPreMatchRows(currentBet, result.toObject());
  }
}

async function replayLiveSettlementsForSlip(slipId: string): Promise<void> {
  const bet = await Bet.findOne({
    slipId,
    status: ResultingStatus.BET_APPROVED,
  });

  if (!bet) {
    return;
  }

  const keys = new Map<string, { marketId: string; marketVersion: number }>();

  for (const row of bet.rows) {
    if (
      !isLiveRow(bet, row)
      || row.result !== ResultingStatus.ROW_NO_RESULT
      || !row.marketId
      || typeof row.marketVersion !== "number"
    ) {
      continue;
    }

    keys.set(`${row.marketId}:${row.marketVersion}`, {
      marketId: row.marketId,
      marketVersion: row.marketVersion,
    });
  }

  if (keys.size === 0) {
    return;
  }

  const settlements = await LiveSettlementLedger.find({
    $or: [...keys.values()].map((key) => ({
      marketId: key.marketId,
      marketVersion: key.marketVersion,
    })),
  }).sort({
    occurredAt: 1,
    settlementSequence: 1,
    marketId: 1,
    marketVersion: 1,
  });

  for (const settlement of settlements) {
    const currentBet = await Bet.findOne({
      slipId,
      status: ResultingStatus.BET_APPROVED,
    });

    if (!currentBet) {
      break;
    }

    await settleApprovedLiveRows(currentBet, settlement.toObject());
  }
}

async function replayStoredSettlementsForSlip(
  slipId: string,
  publishers: SettlementPublishers
): Promise<void> {
  await replayFinalScoresForSlip(slipId);
  await replayLiveSettlementsForSlip(slipId);
  await reconcileSlip(slipId, publishers);
}

export async function upsertPlaceBet(
  event: IPlaceBetEvent,
  publishers: SettlementPublishers
): Promise<void> {
  const { data } = event;

  if (await BetArchive.exists({ slipId: data.slipId })) {
    await clearPendingModerationResult(data.slipId);
    return;
  }

  const defaultBetKind = normalizeBetKind(data.betKind);
  const rows = dedupeRows(data.rows, defaultBetKind);
  const betKind = inferBetKind(rows, data.betKind);

  await Bet.findOneAndUpdate(
    {
      slipId: data.slipId,
    },
    {
      $setOnInsert: {
        status: ResultingStatus.BET_PENDING,
        userId: data.userId,
        slipId: data.slipId,
        betKind,
        wager: data.wager,
        timestamp: event.timestamp ?? new Date().toISOString(),
        moderationTimestamp: "",
        resultingTimestamp: "",
        terminalPublicationState: "",
        rows,
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );

  if (
    await recoverPendingModerationForSlip(
      data.slipId,
      publishers,
      replayPendingModerationResult
    )
  ) {
    return;
  }

  const activeBet = await Bet.findOne({
    slipId: data.slipId,
  });

  if (activeBet?.status === ResultingStatus.BET_APPROVED) {
    await replayStoredSettlementsForSlip(data.slipId, publishers);
  }
}

export async function replayPendingModerationResult(
  event: IModerationResultEvent,
  publishers: SettlementPublishers
): Promise<PendingModerationReplayOutcome> {
  const { data } = event;

  const bet = await Bet.findOne({ slipId: data.slipId });

  if (!bet) {
    if (await BetArchive.exists({ slipId: data.slipId })) {
      return "RESOLVED";
    }

    return "MISSING_AGGREGATE";
  }

  if (TERMINAL_BET_STATUSES.has(bet.status)) {
    return "RESOLVED";
  }

  const nextStatus =
    data.result === ModerationStatus.APPROVED
      ? ResultingStatus.BET_APPROVED
      : ResultingStatus.BET_DECLINED;

  const updatedBet = await Bet.findOneAndUpdate(
    {
      _id: bet._id,
      status: {
        $in: [ResultingStatus.BET_PENDING, ResultingStatus.BET_APPROVED],
      },
    },
    {
      $set: {
        status: nextStatus,
        betKind: normalizeBetKind(data.betKind ?? bet.betKind),
        moderationTimestamp: event.timestamp ?? new Date().toISOString(),
      },
    },
    { new: true }
  );

  if (!updatedBet) {
    const currentBet = await Bet.findOne({ slipId: data.slipId });
    return !currentBet || TERMINAL_BET_STATUSES.has(currentBet.status)
      ? "RESOLVED"
      : "MISSING_AGGREGATE";
  }

  if (nextStatus === ResultingStatus.BET_APPROVED) {
    await replayStoredSettlementsForSlip(data.slipId, publishers);
  }

  return "RESOLVED";
}

export async function applyModerationResult(
  event: IModerationResultEvent,
  publishers: SettlementPublishers
): Promise<void> {
  const outcome = await replayPendingModerationResult(event, publishers);

  if (outcome === "MISSING_AGGREGATE") {
    await parkPendingModerationResult({
      ...event,
      data: {
        ...event.data,
        betKind: normalizeBetKind(event.data.betKind),
      },
    });
    return;
  }

  await clearPendingModerationResult(event.data.slipId);
}

export async function processFinalScore(
  event: IEventResultEvent,
  publishers: SettlementPublishers
): Promise<void> {
  const storedFinalScore = buildStoredFinalScore(event);

  await FinalScoreLedger.findOneAndUpdate(
    { eventId: storedFinalScore.eventId },
    { $setOnInsert: storedFinalScore },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );

  const bets = await Bet.find({
    status: {
      $in: [...ACTIVE_SETTLEMENT_STATUS_VALUES],
    },
    rows: {
      $elemMatch: {
        eventId: storedFinalScore.eventId,
        productName: {
          $in: [...PRE_MATCH_PRODUCTS],
        },
      },
    },
  });

  const slipIds = new Set<string>();

  for (const bet of bets) {
    slipIds.add(bet.slipId);

    if (bet.status !== ResultingStatus.BET_APPROVED) {
      continue;
    }

    await settleApprovedPreMatchRows(bet, storedFinalScore);
  }

  for (const slipId of slipIds) {
    await reconcileSlip(slipId, publishers);
  }
}

export async function processLiveUpdate(
  event: ILiveEventUpdateEvent,
  publishers: SettlementPublishers
): Promise<void> {
  const seenSettlements = new Set<string>();
  const slipIds = new Set<string>();

  for (const settlement of event.data.settlements) {
    const key = `${settlement.marketId}:${settlement.marketVersion}`;

    if (seenSettlements.has(key)) {
      continue;
    }

    seenSettlements.add(key);

    const storedSettlement = buildStoredLiveSettlement(event.data, settlement);

    await LiveSettlementLedger.findOneAndUpdate(
      {
        marketId: storedSettlement.marketId,
        marketVersion: storedSettlement.marketVersion,
      },
      {
        $setOnInsert: storedSettlement,
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );

    const bets = await Bet.find({
      status: {
        $in: [...ACTIVE_SETTLEMENT_STATUS_VALUES],
      },
      rows: {
        $elemMatch: {
          marketId: storedSettlement.marketId,
          marketVersion: storedSettlement.marketVersion,
        },
      },
    });

    for (const bet of bets) {
      slipIds.add(bet.slipId);

      if (bet.status !== ResultingStatus.BET_APPROVED) {
        continue;
      }

      await settleApprovedLiveRows(bet, storedSettlement);
    }
  }

  for (const slipId of slipIds) {
    await reconcileSlip(slipId, publishers);
  }
}
