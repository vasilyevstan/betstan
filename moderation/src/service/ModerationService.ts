import { randomUUID } from "crypto";
import {
  BetKind,
  BettingStatus,
  EventPhase,
  ILiveEventUpdateEvent,
  IModerationAffectedRow,
  IModerationResultEvent,
  IPlaceBetEvent,
  LiveMarketStatus,
  LiveMarketType,
  ModerationDeclineReason,
  ModerationStatus,
  SlipRow,
  TeamSide,
} from "@betstan/common";
import { Bet } from "../model/Bet";
import { LiveEventMirror } from "../model/LiveEventMirror";
import { ParkedPlaceBet, ParkedPlaceBetStatus } from "../model/ParkedPlaceBet";
import { Resulted } from "../model/Resulted";

interface NormalizedSlipRow extends SlipRow {
  betKind: BetKind;
}

type SubmittedPlaceBetData = IPlaceBetEvent["data"] & {
  submittedAt?: string;
};

type NormalizedPlaceBetEvent = Omit<IPlaceBetEvent, "data"> & {
  data: Omit<SubmittedPlaceBetData, "rows" | "betKind"> & {
    rows: NormalizedSlipRow[];
    betKind?: BetKind;
  };
};

interface StoredBetRecord {
  userId: string;
  slipId: string;
  status: ModerationStatus;
  wager: number;
  timestamp: string;
  submittedAt?: string;
  moderationTimestamp: string;
  publishedAt?: string;
  publishToken?: string;
  publishLeaseOwner?: string;
  publishLeaseUntil?: string;
  betKind?: BetKind;
  declineReason?: ModerationDeclineReason;
  affectedRows?: IModerationAffectedRow[];
  rows: NormalizedSlipRow[];
}

interface PublicationClaim extends StoredBetRecord {
  publishToken: string;
  publishLeaseOwner: string;
  publishLeaseUntil: string;
}

interface MirrorSelection {
  selectionId: string;
  side: TeamSide;
  odds: number;
}

interface MirrorMarket {
  marketId: string;
  marketType: LiveMarketType;
  marketVersion: number;
  quoteVersion: number;
  quoteValidUntil?: string;
  status: LiveMarketStatus;
  selections: MirrorSelection[];
}

interface LiveEventMirrorRecord {
  eventId: string;
  sequence: number;
  occurredAt: string;
  kickoffAt: string;
  minute: number;
  addedTime?: number;
  phase: EventPhase;
  homeScore: number;
  awayScore: number;
  bettingStatus: BettingStatus;
  markets: MirrorMarket[];
}

export interface ParkedPlaceBetRecord {
  slipId: string;
  event: IPlaceBetEvent;
  pendingEventIds: string[];
  status: ParkedPlaceBetStatus;
  attemptCount: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseUntil?: string;
  lastAttemptAt?: string;
  lastError?: string;
  exhaustedAt?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ModerationDecision {
  status: ModerationStatus;
  betKind?: BetKind;
  declineReason?: ModerationDeclineReason;
  affectedRows: IModerationAffectedRow[];
  moderationTimestamp: string;
}

type EvaluationResult =
  | { type: "decision"; decision: ModerationDecision }
  | { type: "park"; pendingEventIds: string[] };

export type PlaceBetProcessingResult =
  | { type: "decision" }
  | { type: "park"; pendingEventIds: string[]; exhausted?: boolean };

export interface ParkedReplayRescheduleOptions {
  now: Date;
  pendingEventIds: string[];
  maxAttempts: number;
  maxAgeMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  lastError: unknown;
}

export interface ModerationPublisher {
  publishWithConfirm(event: IModerationResultEvent): Promise<void>;
}

export interface ModerationServiceOptions {
  publicationLeaseOwner?: string;
  publicationLeaseDurationMs?: number;
  publicationLeaseHeartbeatMs?: number;
}

interface PublicationLeaseHeartbeat {
  stop(): Promise<void>;
  hasLostOwnership(): boolean;
}

const DEFAULT_PUBLICATION_LEASE_DURATION_MS = 30_000;
const DEFAULT_PUBLICATION_LEASE_HEARTBEAT_MS = 10_000;
const LIVE_PHASES = new Set<EventPhase>([
  EventPhase.FIRST_HALF,
  EventPhase.FIRST_HALF_STOPPAGE,
  EventPhase.HALF_TIME,
  EventPhase.SECOND_HALF,
  EventPhase.SECOND_HALF_STOPPAGE,
]);

class ModerationService {
  private readonly publicationLeaseOwner: string;
  private readonly publicationLeaseDurationMs: number;
  private readonly publicationLeaseHeartbeatMs: number;

  constructor(
    private readonly publisher: ModerationPublisher,
    options: ModerationServiceOptions = {}
  ) {
    this.publicationLeaseOwner =
      options.publicationLeaseOwner ?? randomUUID();
    this.publicationLeaseDurationMs =
      options.publicationLeaseDurationMs
      ?? DEFAULT_PUBLICATION_LEASE_DURATION_MS;
    this.publicationLeaseHeartbeatMs =
      options.publicationLeaseHeartbeatMs
      ?? DEFAULT_PUBLICATION_LEASE_HEARTBEAT_MS;

    this.validatePositiveInteger(
      "publicationLeaseDurationMs",
      this.publicationLeaseDurationMs
    );
    this.validatePositiveInteger(
      "publicationLeaseHeartbeatMs",
      this.publicationLeaseHeartbeatMs
    );

    if (this.publicationLeaseHeartbeatMs >= this.publicationLeaseDurationMs) {
      throw new Error(
        "publicationLeaseHeartbeatMs must be shorter than publicationLeaseDurationMs"
      );
    }
  }

  async handlePlaceBet(event: IPlaceBetEvent): Promise<PlaceBetProcessingResult> {
    return this.processPlaceBet(event, false);
  }

  async replayParkedPlaceBet(
    parkedPlaceBet: ParkedPlaceBetRecord
  ): Promise<PlaceBetProcessingResult> {
    return this.processPlaceBet(parkedPlaceBet.event, true);
  }

  async upsertLiveEventMirror(event: ILiveEventUpdateEvent): Promise<boolean> {
    const { data } = event;

    try {
      const result = await LiveEventMirror.updateOne(
        {
          eventId: data.eventId,
          sequence: {
            $lt: data.sequence,
          },
        },
        {
          $set: {
            eventId: data.eventId,
            sequence: data.sequence,
            occurredAt: data.occurredAt,
            kickoffAt: data.kickoffAt,
            minute: data.minute,
            addedTime: data.addedTime,
            phase: data.phase,
            homeScore: data.homeScore,
            awayScore: data.awayScore,
            bettingStatus: data.bettingStatus,
            markets: data.markets,
            settlements: data.settlements,
            eventName: data.eventName,
            home: data.home,
            away: data.away,
          },
        },
        { upsert: true }
      );

      return result.modifiedCount > 0 || result.upsertedCount > 0;
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        return false;
      }

      throw error;
    }
  }

  async upsertResulted(eventId: string, timestamp: string): Promise<void> {
    await Resulted.findOneAndUpdate(
      { eventId },
      {
        $set: {
          eventId,
          timestamp,
        },
      },
      { upsert: true }
    );
  }

  async replayParkedForEvent(eventId: string): Promise<number> {
    const dueAt = new Date().toISOString();
    const result = await ParkedPlaceBet.updateMany(
      {
        pendingEventIds: eventId,
        status: {
          $in: [ParkedPlaceBetStatus.PENDING, ParkedPlaceBetStatus.PROCESSING],
        },
      },
      {
        $min: {
          nextAttemptAt: dueAt,
        },
      }
    );

    return result.modifiedCount;
  }

  async claimParkedPlaceBet(
    leaseOwner: string,
    leaseDurationMs: number,
    now: Date
  ): Promise<ParkedPlaceBetRecord | null> {
    const claimedAt = now.toISOString();
    const leaseUntil = this.addMilliseconds(now, leaseDurationMs);

    return (await ParkedPlaceBet.findOneAndUpdate(
      {
        status: {
          $in: [ParkedPlaceBetStatus.PENDING, ParkedPlaceBetStatus.PROCESSING],
        },
        nextAttemptAt: {
          $lte: claimedAt,
        },
        $or: [
          {
            status: ParkedPlaceBetStatus.PENDING,
          },
          {
            status: ParkedPlaceBetStatus.PROCESSING,
            leaseUntil: "",
          },
          {
            status: ParkedPlaceBetStatus.PROCESSING,
            leaseUntil: {
              $exists: false,
            },
          },
          {
            status: ParkedPlaceBetStatus.PROCESSING,
            leaseUntil: null,
          },
          {
            status: ParkedPlaceBetStatus.PROCESSING,
            leaseUntil: {
              $lte: claimedAt,
            },
          },
        ],
      },
      {
        $set: {
          status: ParkedPlaceBetStatus.PROCESSING,
          leaseOwner,
          leaseUntil,
          nextAttemptAt: leaseUntil,
          lastAttemptAt: claimedAt,
          lastError: "",
        },
        $inc: {
          attemptCount: 1,
        },
      },
      {
        new: true,
        sort: {
          nextAttemptAt: 1,
          createdAt: 1,
        },
      }
    ).lean()) as ParkedPlaceBetRecord | null;
  }

  async rescheduleClaimedParkedPlaceBet(
    parkedPlaceBet: ParkedPlaceBetRecord,
    options: ParkedReplayRescheduleOptions
  ): Promise<ParkedPlaceBetStatus> {
    const pendingEventIds = this.normalizePendingEventIds(options.pendingEventIds);
    const exhausted = this.shouldExhaustParkedPlaceBet(
      parkedPlaceBet,
      options.now,
      options.maxAttempts,
      options.maxAgeMs
    );
    const releasedLease = {
      leaseOwner: "",
      leaseUntil: "",
    };
    const sanitizedError = this.sanitizeError(options.lastError);

    if (exhausted) {
      await ParkedPlaceBet.updateOne(
        this.claimedParkedPlaceBetFilter(parkedPlaceBet),
        {
          $set: {
            status: ParkedPlaceBetStatus.EXHAUSTED,
            pendingEventIds,
            nextAttemptAt: options.now.toISOString(),
            lastError: sanitizedError,
            exhaustedAt: options.now.toISOString(),
            ...releasedLease,
          },
        }
      );

      return ParkedPlaceBetStatus.EXHAUSTED;
    }

    const nextAttemptAt = this.addMilliseconds(
      options.now,
      this.calculateBackoffMs(
        parkedPlaceBet.attemptCount,
        options.baseBackoffMs,
        options.maxBackoffMs
      )
    );

    await ParkedPlaceBet.updateOne(
      this.claimedParkedPlaceBetFilter(parkedPlaceBet),
      {
        $set: {
          status: ParkedPlaceBetStatus.PENDING,
          pendingEventIds,
          lastError: sanitizedError,
          exhaustedAt: "",
          ...releasedLease,
        },
        $min: {
          nextAttemptAt,
        },
      }
    );

    return ParkedPlaceBetStatus.PENDING;
  }

  async removeParkedPlaceBet(slipId: string): Promise<void> {
    await ParkedPlaceBet.deleteOne({ slipId });
  }

  private async processPlaceBet(
    event: IPlaceBetEvent,
    fromParkedReplay: boolean
  ): Promise<PlaceBetProcessingResult> {
    const evaluatedAt = new Date();
    const normalized = this.normalizePlaceBet(event);
    const storedBet = await this.ensureStoredBet(
      normalized.event,
      evaluatedAt.toISOString()
    );

    if (this.hasFinalDecision(storedBet)) {
      await this.publishStoredDecisionIfNeeded(storedBet);
      return { type: "decision" };
    }

    const parkedPlaceBet = await this.findParkedPlaceBet(event.data.slipId);

    if (
      !fromParkedReplay
      && parkedPlaceBet?.status === ParkedPlaceBetStatus.EXHAUSTED
    ) {
      return {
        type: "park",
        pendingEventIds: parkedPlaceBet.pendingEventIds,
        exhausted: true,
      };
    }

    const evaluation: EvaluationResult = normalized.mixed
      ? {
          type: "decision",
          decision: this.buildDecision(
            normalized.event.data.rows,
            {
              declineReason: ModerationDeclineReason.MIXED_BET_KINDS,
            },
            ModerationStatus.DECLINED,
            evaluatedAt.toISOString()
          ),
        }
      : await this.evaluate(normalized.event, evaluatedAt);

    if (evaluation.type === "park") {
      if (!fromParkedReplay) {
        await this.parkSlip(
          event,
          evaluation.pendingEventIds,
          evaluatedAt.toISOString()
        );
      }

      return {
        type: "park",
        pendingEventIds: evaluation.pendingEventIds,
      };
    }

    const decidedBet = await this.persistDecision(
      normalized.event,
      evaluation.decision
    );
    await this.publishStoredDecisionIfNeeded(decidedBet);

    return { type: "decision" };
  }

  private async evaluate(
    event: NormalizedPlaceBetEvent,
    evaluatedAt: Date
  ): Promise<EvaluationResult> {
    const eventIds = [...new Set(event.data.rows.map((row) => row.eventId))];
    const [resulted, mirrors] = await Promise.all([
      Resulted.find({ eventId: { $in: eventIds } }).lean(),
      LiveEventMirror.find({ eventId: { $in: eventIds } }).lean(),
    ]);

    const resultedIds = new Set(
      (resulted as Array<{ eventId: string }>).map((item) => item.eventId)
    );
    const mirrorByEventId = new Map(
      (mirrors as LiveEventMirrorRecord[]).map((mirror) => [
        mirror.eventId,
        mirror,
      ])
    );
    const pendingEventIds = new Set<string>();
    const affectedRows: IModerationAffectedRow[] = [];

    for (const row of event.data.rows) {
      if (resultedIds.has(row.eventId)) {
        affectedRows.push(
          this.buildAffectedRow(row, ModerationDeclineReason.EVENT_RESULTED)
        );
        continue;
      }

      if (row.betKind === BetKind.PRE_MATCH) {
        const kickoffAt =
          mirrorByEventId.get(row.eventId)?.kickoffAt ?? row.eventTime ?? row.timestamp;

        if (this.hasStarted(kickoffAt, evaluatedAt)) {
          affectedRows.push(
            this.buildAffectedRow(row, ModerationDeclineReason.EVENT_STARTED)
          );
        }

        continue;
      }

      if (
        !this.hasMarketIdentity(row)
        || row.marketVersion == null
        || row.quoteVersion == null
      ) {
        affectedRows.push(
          this.buildAffectedRow(row, ModerationDeclineReason.STALE_QUOTE)
        );
        continue;
      }

      if (!row.selectionId && !row.side) {
        affectedRows.push(
          this.buildAffectedRow(row, ModerationDeclineReason.INVALID_SELECTION)
        );
        continue;
      }

      const mirror = mirrorByEventId.get(row.eventId);
      const currentMarket = mirror
        ? this.findCurrentMarket(mirror, row)
        : undefined;
      const currentSelection = currentMarket
        ? this.findCurrentSelection(currentMarket, row)
        : undefined;

      if (
        !this.isLiveSubmissionBeforeExpiry(
          row.quoteValidUntil,
          event.data.submittedAt
        )
      ) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            ModerationDeclineReason.STALE_QUOTE,
            currentMarket,
            currentSelection
          )
        );
        continue;
      }

      if (!mirror) {
        pendingEventIds.add(row.eventId);
        continue;
      }

      if (!this.isLiveOpen(mirror)) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            ModerationDeclineReason.EVENT_NOT_LIVE,
            currentMarket,
            currentSelection
          )
        );
        continue;
      }

      const exactMarket = this.findExactMarket(mirror, row);

      if (!exactMarket) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            this.reasonForMissingExactMarket(currentMarket),
            currentMarket,
            currentSelection
          )
        );
        continue;
      }

      const exactSelection = this.findExactSelection(exactMarket, row);

      if (exactMarket.status === LiveMarketStatus.SUSPENDED) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            ModerationDeclineReason.MARKET_SUSPENDED,
            exactMarket,
            exactSelection ?? currentSelection
          )
        );
        continue;
      }

      if (exactMarket.status !== LiveMarketStatus.OPEN) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            ModerationDeclineReason.MARKET_CLOSED,
            exactMarket,
            exactSelection ?? currentSelection
          )
        );
        continue;
      }

      if (!exactSelection) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            ModerationDeclineReason.INVALID_SELECTION,
            exactMarket,
            currentSelection
          )
        );
        continue;
      }

      if (
        (row.selectionId && exactSelection.selectionId !== row.selectionId)
        || (row.side && exactSelection.side !== row.side)
      ) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            ModerationDeclineReason.INVALID_SELECTION,
            exactMarket,
            currentSelection ?? exactSelection
          )
        );
        continue;
      }

      if (
        row.quoteVersion !== exactMarket.quoteVersion
        || row.oddsValue !== exactSelection.odds
      ) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            ModerationDeclineReason.STALE_QUOTE,
            exactMarket,
            exactSelection
          )
        );
        continue;
      }

      if (
        !this.isValidLiveQuoteAtSubmission(
          row.quoteValidUntil,
          exactMarket.quoteValidUntil,
          event.data.submittedAt
        )
      ) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            ModerationDeclineReason.STALE_QUOTE,
            exactMarket,
            exactSelection
          )
        );
      }
    }

    if (affectedRows.length > 0) {
      return {
        type: "decision",
        decision: this.buildDecision(
          event.data.rows,
          {
            betKind: event.data.betKind,
            declineReason: affectedRows[0].declineReason,
            affectedRows,
          },
          ModerationStatus.DECLINED,
          evaluatedAt.toISOString()
        ),
      };
    }

    if (pendingEventIds.size > 0) {
      return {
        type: "park",
        pendingEventIds: [...pendingEventIds].sort(),
      };
    }

    return {
      type: "decision",
      decision: this.buildDecision(
        event.data.rows,
        {
          betKind: event.data.betKind,
        },
        ModerationStatus.APPROVED,
        evaluatedAt.toISOString()
      ),
    };
  }

  private buildDecision(
    rows: NormalizedSlipRow[],
    details: {
      betKind?: BetKind;
      declineReason?: ModerationDeclineReason;
      affectedRows?: IModerationAffectedRow[];
    },
    status: ModerationStatus,
    moderationTimestamp: string
  ): ModerationDecision {
    return {
      status,
      betKind: details.betKind,
      declineReason: details.declineReason,
      affectedRows:
        details.affectedRows
        ?? (status === ModerationStatus.DECLINED
          ? rows.map((row) =>
              this.buildAffectedRow(
                row,
                details.declineReason ?? ModerationDeclineReason.EVENT_RESULTED
              )
            )
          : []),
      moderationTimestamp,
    };
  }

  private normalizePlaceBet(
    event: IPlaceBetEvent
  ): { event: NormalizedPlaceBetEvent; mixed: boolean } {
    const topLevelKind = event.data.betKind;
    const rows = event.data.rows.map(
      (row): NormalizedSlipRow => ({
        ...row,
        betKind: row.betKind ?? topLevelKind ?? BetKind.PRE_MATCH,
      })
    );

    const explicitMismatch =
      Boolean(topLevelKind)
      && event.data.rows.some(
        (row) => Boolean(row.betKind) && row.betKind !== topLevelKind
      );
    const uniqueKinds = new Set(rows.map((row) => row.betKind));
    const mixed = explicitMismatch || uniqueKinds.size > 1;
    const betKind = mixed ? undefined : rows[0]?.betKind ?? BetKind.PRE_MATCH;

    return {
      mixed,
      event: {
        ...event,
        data: {
          ...event.data,
          betKind,
          rows,
        },
      },
    };
  }

  private async ensureStoredBet(
    event: NormalizedPlaceBetEvent,
    fallbackTimestamp: string
  ): Promise<StoredBetRecord> {
    const update: {
      $set: Partial<StoredBetRecord>;
      $setOnInsert: Partial<StoredBetRecord>;
    } = {
      $set: {
        userId: event.data.userId,
        slipId: event.data.slipId,
        wager: event.data.wager,
        timestamp: event.timestamp ?? fallbackTimestamp,
        rows: event.data.rows,
      },
      $setOnInsert: {
        status: ModerationStatus.RECEIVED,
        moderationTimestamp: "",
        publishedAt: "",
        publishToken: "",
        publishLeaseOwner: "",
        publishLeaseUntil: "",
        affectedRows: [],
      },
    };

    if (event.data.betKind) {
      update.$set.betKind = event.data.betKind;
    }
    if (event.data.submittedAt) {
      update.$set.submittedAt = event.data.submittedAt;
    }

    try {
      await Bet.findOneAndUpdate({ slipId: event.data.slipId }, update, {
        upsert: true,
      });
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const stored = await this.findStoredBet(event.data.slipId);

    if (!stored) {
      throw new Error(`Missing moderation record for slip ${event.data.slipId}`);
    }

    return stored;
  }

  private async persistDecision(
    event: NormalizedPlaceBetEvent,
    decision: ModerationDecision
  ): Promise<StoredBetRecord> {
    const update: {
      $set: Partial<StoredBetRecord>;
      $unset?: Record<string, number>;
    } = {
      $set: {
        userId: event.data.userId,
        slipId: event.data.slipId,
        wager: event.data.wager,
        timestamp: event.timestamp ?? decision.moderationTimestamp,
        rows: event.data.rows,
        status: decision.status,
        moderationTimestamp: decision.moderationTimestamp,
        affectedRows: decision.affectedRows,
      },
    };

    if (decision.betKind) {
      update.$set.betKind = decision.betKind;
    } else {
      update.$unset = {
        ...(update.$unset ?? {}),
        betKind: 1,
      };
    }
    if (event.data.submittedAt) {
      update.$set.submittedAt = event.data.submittedAt;
    }

    if (decision.declineReason) {
      update.$set.declineReason = decision.declineReason;
    } else {
      update.$unset = {
        ...(update.$unset ?? {}),
        declineReason: 1,
      };
    }

    await Bet.findOneAndUpdate({ slipId: event.data.slipId }, update);

    const stored = await this.findStoredBet(event.data.slipId);

    if (!stored) {
      throw new Error(
        `Missing decided moderation record for slip ${event.data.slipId}`
      );
    }

    return stored;
  }

  private async parkSlip(
    event: IPlaceBetEvent,
    pendingEventIds: string[],
    parkedAt: string
  ): Promise<void> {
    const normalizedPendingEventIds = this.normalizePendingEventIds(pendingEventIds);
    const existing = await this.findParkedPlaceBet(event.data.slipId);

    if (!existing) {
      try {
        await ParkedPlaceBet.create({
          slipId: event.data.slipId,
          event,
          pendingEventIds: normalizedPendingEventIds,
          status: ParkedPlaceBetStatus.PENDING,
          attemptCount: 0,
          nextAttemptAt: parkedAt,
          leaseOwner: "",
          leaseUntil: "",
          lastAttemptAt: "",
          lastError: "",
          exhaustedAt: "",
        });
        return;
      } catch (error) {
        if (!this.isDuplicateKeyError(error)) {
          throw error;
        }
      }
    }

    const current = existing ?? (await this.findParkedPlaceBet(event.data.slipId));

    if (!current || current.status === ParkedPlaceBetStatus.EXHAUSTED) {
      return;
    }

    const targetStatus = current.status === ParkedPlaceBetStatus.PROCESSING
      ? ParkedPlaceBetStatus.PROCESSING
      : ParkedPlaceBetStatus.PENDING;

    await ParkedPlaceBet.updateOne(
      {
        slipId: event.data.slipId,
        status: targetStatus,
      },
      {
        $set: {
          event,
          pendingEventIds: normalizedPendingEventIds,
          lastError: "",
          exhaustedAt: "",
        },
        ...(targetStatus === ParkedPlaceBetStatus.PENDING
          ? {
              $min: {
                nextAttemptAt: parkedAt,
              },
            }
          : {}),
      }
    );
  }

  private async publishStoredDecisionIfNeeded(
    bet: StoredBetRecord
  ): Promise<void> {
    if (!this.hasFinalDecision(bet)) {
      return;
    }

    if (this.isDecisionPublished(bet)) {
      await this.removeParkedPlaceBet(bet.slipId);
      return;
    }

    const claimedBet = await this.claimDecisionForPublication(
      bet.slipId,
      new Date()
    );

    if (!claimedBet) {
      const latestBet = await this.findStoredBet(bet.slipId);

      if (latestBet && this.isDecisionPublished(latestBet)) {
        await this.removeParkedPlaceBet(bet.slipId);
      }

      return;
    }

    const heartbeat = this.startPublicationHeartbeat(claimedBet);

    try {
      await this.publisher.publishWithConfirm(
        this.buildModerationResultEvent(claimedBet)
      );
      await heartbeat.stop();

      const completed = await this.completePublicationClaim(claimedBet);

      if (completed) {
        await this.removeParkedPlaceBet(claimedBet.slipId);
        return;
      }

      const latestBet = await this.findStoredBet(claimedBet.slipId);

      if (latestBet && this.isDecisionPublished(latestBet)) {
        await this.removeParkedPlaceBet(claimedBet.slipId);
      }
    } catch (error) {
      await heartbeat.stop();
      await this.releasePublicationClaim(claimedBet);
      throw error;
    }
  }

  private buildModerationResultEvent(
    bet: StoredBetRecord
  ): IModerationResultEvent {
    const resultEvent: IModerationResultEvent = {
      data: {
        slipId: bet.slipId,
        result: bet.status,
      },
    };

    if (bet.betKind) {
      resultEvent.data.betKind = bet.betKind;
    }

    if (bet.declineReason) {
      resultEvent.data.declineReason = bet.declineReason;
    }

    if (bet.affectedRows && bet.affectedRows.length > 0) {
      resultEvent.data.affectedRows = bet.affectedRows;
    }

    return resultEvent;
  }

  private hasFinalDecision(bet: StoredBetRecord): boolean {
    return bet.status !== ModerationStatus.RECEIVED
      && Boolean(bet.moderationTimestamp);
  }

  private isDecisionPublished(bet: StoredBetRecord): boolean {
    return Boolean(bet.publishedAt && bet.publishedAt !== "");
  }

  private async findStoredBet(slipId: string): Promise<StoredBetRecord | null> {
    return (await Bet.findOne({ slipId }).lean()) as StoredBetRecord | null;
  }

  private async findParkedPlaceBet(
    slipId: string
  ): Promise<ParkedPlaceBetRecord | null> {
    return (await ParkedPlaceBet.findOne({ slipId }).lean()) as ParkedPlaceBetRecord | null;
  }

  private async claimDecisionForPublication(
    slipId: string,
    now: Date
  ): Promise<PublicationClaim | null> {
    const publishToken = randomUUID();
    const publishLeaseUntil = this.addMilliseconds(
      now,
      this.publicationLeaseDurationMs
    );
    const claimedBet = await Bet.findOneAndUpdate(
      {
        slipId,
        status: {
          $ne: ModerationStatus.RECEIVED,
        },
        ...this.unpublishedDecisionFilter(),
        $or: this.claimablePublicationLeaseFilters(now.toISOString()),
      },
      {
        $set: {
          publishToken,
          publishLeaseOwner: this.publicationLeaseOwner,
          publishLeaseUntil,
        },
      },
      {
        new: true,
      }
    ).lean();

    return claimedBet as PublicationClaim | null;
  }

  private async extendPublicationClaim(
    claimedBet: PublicationClaim
  ): Promise<boolean> {
    const publishLeaseUntil = this.addMilliseconds(
      new Date(),
      this.publicationLeaseDurationMs
    );
    const result = await Bet.updateOne(
      this.ownedPublicationClaimFilter(claimedBet),
      {
        $set: {
          publishLeaseUntil,
        },
      }
    );

    if (result.modifiedCount > 0) {
      claimedBet.publishLeaseUntil = publishLeaseUntil;
      return true;
    }

    return false;
  }

  private async completePublicationClaim(
    claimedBet: PublicationClaim
  ): Promise<boolean> {
    const result = await Bet.updateOne(
      this.ownedPublicationClaimFilter(claimedBet),
      {
        $set: {
          publishedAt: new Date().toISOString(),
          publishToken: "",
          publishLeaseOwner: "",
          publishLeaseUntil: "",
        },
      }
    );

    return result.modifiedCount > 0;
  }

  private async releasePublicationClaim(
    claimedBet: PublicationClaim
  ): Promise<void> {
    await Bet.updateOne(this.ownedPublicationClaimFilter(claimedBet), {
      $set: {
        publishToken: "",
        publishLeaseOwner: "",
        publishLeaseUntil: "",
      },
    });
  }

  private startPublicationHeartbeat(
    claimedBet: PublicationClaim
  ): PublicationLeaseHeartbeat {
    let stopped = false;
    let lostOwnership = false;
    let timer: NodeJS.Timeout | null = null;
    let inFlightHeartbeat: Promise<void> = Promise.resolve();

    const schedule = () => {
      if (stopped) {
        return;
      }

      timer = setTimeout(() => {
        inFlightHeartbeat = tick();
      }, this.publicationLeaseHeartbeatMs);
    };

    const tick = async () => {
      if (stopped) {
        return;
      }

      const extended = await this.extendPublicationClaim(claimedBet);

      if (!extended) {
        lostOwnership = true;
        stopped = true;
        return;
      }

      schedule();
    };

    schedule();

    return {
      stop: async () => {
        stopped = true;

        if (timer) {
          clearTimeout(timer);
          timer = null;
        }

        await inFlightHeartbeat;
      },
      hasLostOwnership: () => lostOwnership,
    };
  }

  private buildAffectedRow(
    row: NormalizedSlipRow,
    declineReason: ModerationDeclineReason,
    market?: MirrorMarket,
    selection?: MirrorSelection
  ): IModerationAffectedRow {
    const affectedRow: IModerationAffectedRow = {
      rowId: row.id,
      declineReason,
    };

    if (market) {
      affectedRow.marketId = market.marketId;
      affectedRow.marketVersion = market.marketVersion;
      affectedRow.quoteVersion = market.quoteVersion;
      affectedRow.marketStatus = market.status;
    }

    if (selection) {
      affectedRow.selectionId = selection.selectionId;
      affectedRow.currentOdds = selection.odds;
    }

    return affectedRow;
  }

  private hasMarketIdentity(row: NormalizedSlipRow): boolean {
    return Boolean(row.marketId || row.marketType);
  }

  private hasStarted(kickoffAt: string | undefined, now: Date): boolean {
    if (!kickoffAt) {
      return false;
    }

    const parsedKickoff = this.parseDate(kickoffAt);

    return parsedKickoff ? now.getTime() >= parsedKickoff.getTime() : false;
  }

  private isValidLiveQuoteAtSubmission(
    rowValidUntil: string | undefined,
    marketValidUntil: string | undefined,
    submittedAt: string | undefined
  ): boolean {
    if (
      !marketValidUntil
      || !this.isLiveSubmissionBeforeExpiry(rowValidUntil, submittedAt)
    ) {
      return false;
    }

    const rowExpiryMs = Date.parse(rowValidUntil);
    const marketExpiryMs = Date.parse(marketValidUntil);

    return (
      Number.isFinite(rowExpiryMs)
      && Number.isFinite(marketExpiryMs)
      && rowExpiryMs === marketExpiryMs
    );
  }

  private isLiveSubmissionBeforeExpiry(
    rowValidUntil: string | undefined,
    submittedAt: string | undefined
  ): rowValidUntil is string {
    if (!rowValidUntil || !submittedAt) {
      return false;
    }

    const rowExpiryMs = Date.parse(rowValidUntil);
    const submittedAtMs = Date.parse(submittedAt);

    return (
      Number.isFinite(rowExpiryMs)
      && Number.isFinite(submittedAtMs)
      && submittedAtMs < rowExpiryMs
    );
  }

  private parseDate(value: string): Date | null {
    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private isLiveOpen(mirror: LiveEventMirrorRecord): boolean {
    return LIVE_PHASES.has(mirror.phase) && mirror.bettingStatus === BettingStatus.OPEN;
  }

  private findExactMarket(
    mirror: LiveEventMirrorRecord,
    row: NormalizedSlipRow
  ): MirrorMarket | undefined {
    return mirror.markets.find(
      (market) =>
        this.matchesMarketIdentity(market, row)
        && market.marketVersion === row.marketVersion
    );
  }

  private findCurrentMarket(
    mirror: LiveEventMirrorRecord,
    row: NormalizedSlipRow
  ): MirrorMarket | undefined {
    const candidates = mirror.markets.filter((market) =>
      this.matchesMarketIdentity(market, row)
    );

    return candidates.sort((left, right) => right.marketVersion - left.marketVersion)[0];
  }

  private matchesMarketIdentity(
    market: MirrorMarket,
    row: NormalizedSlipRow
  ): boolean {
    const matchesMarketId = row.marketId ? market.marketId === row.marketId : true;
    const matchesMarketType = row.marketType
      ? market.marketType === row.marketType
      : true;

    return matchesMarketId && matchesMarketType;
  }

  private findExactSelection(
    market: MirrorMarket,
    row: NormalizedSlipRow
  ): MirrorSelection | undefined {
    if (row.selectionId) {
      return market.selections.find(
        (selection) => selection.selectionId === row.selectionId
      );
    }

    if (row.side) {
      return market.selections.find((selection) => selection.side === row.side);
    }

    return undefined;
  }

  private findCurrentSelection(
    market: MirrorMarket,
    row: NormalizedSlipRow
  ): MirrorSelection | undefined {
    const byId = row.selectionId
      ? market.selections.find(
          (selection) => selection.selectionId === row.selectionId
        )
      : undefined;

    if (byId) {
      return byId;
    }

    return row.side
      ? market.selections.find((selection) => selection.side === row.side)
      : undefined;
  }

  private reasonForMissingExactMarket(
    currentMarket: MirrorMarket | undefined
  ): ModerationDeclineReason {
    if (!currentMarket) {
      return ModerationDeclineReason.MARKET_CLOSED;
    }

    if (currentMarket.status === LiveMarketStatus.SUSPENDED) {
      return ModerationDeclineReason.MARKET_SUSPENDED;
    }

    if (currentMarket.status !== LiveMarketStatus.OPEN) {
      return ModerationDeclineReason.MARKET_CLOSED;
    }

    return ModerationDeclineReason.STALE_QUOTE;
  }

  private unpublishedDecisionFilter(): Record<string, unknown> {
    return {
      $or: [
        {
          publishedAt: {
            $exists: false,
          },
        },
        {
          publishedAt: null,
        },
        {
          publishedAt: "",
        },
      ],
    };
  }

  private claimablePublicationLeaseFilters(
    nowIso: string
  ): Record<string, unknown>[] {
    return [
      {
        publishToken: {
          $exists: false,
        },
      },
      {
        publishToken: null,
      },
      {
        publishToken: "",
      },
      {
        publishLeaseOwner: {
          $exists: false,
        },
      },
      {
        publishLeaseOwner: null,
      },
      {
        publishLeaseOwner: "",
      },
      {
        publishLeaseUntil: {
          $exists: false,
        },
      },
      {
        publishLeaseUntil: null,
      },
      {
        publishLeaseUntil: "",
      },
      {
        publishLeaseUntil: {
          $lte: nowIso,
        },
      },
    ];
  }

  private ownedPublicationClaimFilter(
    claimedBet: PublicationClaim
  ): Record<string, unknown> {
    return {
      slipId: claimedBet.slipId,
      publishToken: claimedBet.publishToken,
      publishLeaseOwner: claimedBet.publishLeaseOwner,
      ...this.unpublishedDecisionFilter(),
    };
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: number }).code === 11000
      : false;
  }

  private claimedParkedPlaceBetFilter(
    parkedPlaceBet: ParkedPlaceBetRecord
  ): Record<string, unknown> {
    return {
      slipId: parkedPlaceBet.slipId,
      status: ParkedPlaceBetStatus.PROCESSING,
      leaseOwner: parkedPlaceBet.leaseOwner ?? "",
      leaseUntil: parkedPlaceBet.leaseUntil ?? "",
    };
  }

  private shouldExhaustParkedPlaceBet(
    parkedPlaceBet: ParkedPlaceBetRecord,
    now: Date,
    maxAttempts: number,
    maxAgeMs: number
  ): boolean {
    return parkedPlaceBet.attemptCount >= maxAttempts
      || now.getTime() - this.readDateValue(parkedPlaceBet.createdAt).getTime()
        >= maxAgeMs;
  }

  private calculateBackoffMs(
    attemptCount: number,
    baseBackoffMs: number,
    maxBackoffMs: number
  ): number {
    const exponent = Math.max(0, attemptCount - 1);
    const multiplier = Math.pow(2, exponent);
    return Math.min(maxBackoffMs, baseBackoffMs * multiplier);
  }

  private normalizePendingEventIds(eventIds: string[]): string[] {
    return [...new Set(eventIds)].sort();
  }

  private sanitizeError(error: unknown): string {
    const raw = typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Replay failed";
    const normalized = raw.replace(/\s+/g, " ").trim();

    return normalized.length > 240
      ? normalized.slice(0, 240)
      : normalized || "Replay failed";
  }

  private readDateValue(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }

  private addMilliseconds(date: Date, milliseconds: number): string {
    return new Date(date.getTime() + milliseconds).toISOString();
  }

  private validatePositiveInteger(name: string, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}

export default ModerationService;
