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
  ModerationDeclineReason,
  ModerationStatus,
  SlipRow,
} from "@betstan/common";
import { LiveMarketType, TeamSide } from "../compat/LiveContract";
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
  label?: string;
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

/**
 * A market quote as it existed at a specific event sequence. `sequence` is
 * carried purely for recency ordering/pruning; identity for lookups is the
 * (marketId, marketVersion, quoteVersion) triple, never `sequence`. `phase`
 * and `bettingStatus` are the event's overall live state at that same
 * sequence, captured so a later suspension/full-time snapshot can never
 * retroactively hide that the event was genuinely live when this quote was
 * issued.
 */
interface MirrorMarketHistoryEntry extends MirrorMarket {
  sequence: number;
  occurredAt?: string;
  authorityEndedAt?: string;
  authorityEndSequence?: number;
  phase: EventPhase;
  bettingStatus: BettingStatus;
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
  marketHistory?: MirrorMarketHistoryEntry[];
  historyRevision?: number;
}

/**
 * The minimal shape `recordMarketHistory` needs to fold a batch of markets
 * into persisted history: either a freshly-arrived live update payload, or
 * the mirror's own pre-update "current" snapshot being archived before it is
 * replaced (see `upsertLiveEventMirror`).
 */
interface MarketHistorySnapshot {
  eventId: string;
  sequence: number;
  occurredAt?: string;
  authorityEndedAt?: string;
  authorityEndSequence?: number;
  phase: EventPhase;
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
/**
 * Bounds the persisted market quote history so a single event can never grow
 * without limit: only the most recent N distinct (marketVersion, quoteVersion)
 * entries are retained per marketId, regardless of how many live snapshots
 * have been observed. This must be large enough that a genuinely valid early
 * quote can never be pruned while it could still be authoritative for a
 * pending moderation decision.
 *
 * The bound below is an exact (not merely heuristic) worst case, derived from
 * the live match simulator (see gamemaster/src/simulation/config.ts HARD_CAPS
 * and gamemaster/src/simulation/markets.ts). Every "material" incident in a
 * match can advance at most one (marketVersion, quoteVersion) entry for any
 * single marketId: either it is that market's own trigger incident (bumping
 * its marketVersion, or closing it once its own cap is reached), or it is a
 * *different* market's incident that reprices every other still-open market
 * by at most one quoteVersion step (`repriceOpenMarkets` skips the market it
 * just triggered). HARD_CAPS bounds the total number of such incidents for an
 * entire match regardless of configured duration (caps do not scale with
 * `durationMs`):
 *   own-type trigger incidents: goals(12) + yellows(14) + reds(4)
 *     + corners(30) + penaltyAwards(6) + freeKicks(24)
 *     + throwIns(60) + goalKicks(30)                               = 180
 *   + one PENALTY_SCORED/PENALTY_MISSED outcome per penaltyAwards  = 186
 *   + ADDED_TIME_ANNOUNCED (fixed: exactly once per half)          = 188
 *   + SECOND_HALF_KICK_OFF (fixed: exactly once)                   = 189
 *   + the market's own initial KICK_OFF creation                   = 190
 * If the simulator's HARD_CAPS or fixed-incident schedule ever changes, this
 * bound must be re-derived alongside it.
 */
export const MAX_MARKET_HISTORY_VERSIONS_PER_MARKET = 256;
/** Bounded optimistic-concurrency retries when two updates race to append history. */
export const MAX_MARKET_HISTORY_WRITE_ATTEMPTS = 5;
const LIVE_PHASES = new Set<EventPhase>([
  // Pre-kickoff live-slip candidacy: from `LIVE_PRE_KICKOFF_WINDOW_MS`
  // before kickoff, gamemaster publishes a PRE_MATCH-phase snapshot
  // exposing exactly the two pre-kickoff live markets (kickoff team, goal
  // in first minute). This set alone is used only for whole-event/record
  // level "is this event still in an authoritative live window" checks
  // (e.g. whether to close out market history on a phase change); it is
  // deliberately NOT sufficient, on its own, to decide whether any given
  // *market* row is eligible while PRE_MATCH -- see
  // `isMarketLiveEligibleForPhase` below, which every per-market/per-row
  // check must go through instead so a forged or stale row can never be
  // treated as live merely because the event happens to be PRE_MATCH.
  EventPhase.PRE_MATCH,
  EventPhase.FIRST_HALF,
  EventPhase.FIRST_HALF_STOPPAGE,
  EventPhase.HALF_TIME,
  EventPhase.SECOND_HALF,
  EventPhase.SECOND_HALF_STOPPAGE,
]);
/**
 * By construction, gamemaster never publishes any market type other than
 * these two while phase is PRE_MATCH. Every per-market/per-row live-phase
 * check must gate PRE_MATCH eligibility on market type through
 * `isMarketLiveEligibleForPhase` rather than relying on `LIVE_PHASES`
 * alone, so an ordinary NEXT_* live market can never be treated as live
 * during PRE_MATCH regardless of what a submitted row happens to claim.
 */
const PRE_KICKOFF_MARKET_TYPES = new Set<LiveMarketType>([
  LiveMarketType.KICKOFF_TEAM,
  LiveMarketType.FIRST_MINUTE_GOAL,
]);

function isMarketLiveEligibleForPhase(
  phase: EventPhase,
  marketType: LiveMarketType
): boolean {
  if (phase === EventPhase.PRE_MATCH) {
    return PRE_KICKOFF_MARKET_TYPES.has(marketType);
  }
  return LIVE_PHASES.has(phase);
}

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
    let currentChanged: boolean;

    // Read the mirror's pre-update "current" snapshot before it is
    // overwritten below. A rolling deployment (new history-aware code
    // replacing a mirror written by the previous version, or a genuinely
    // legacy pre-deploy document) may have current markets that were never
    // independently folded into history; overwriting `markets` first would
    // permanently erase the only persisted evidence that those quotes were
    // ever authoritative. Archiving them first -- before they are replaced --
    // closes that gap. This is a plain read (no lock): under concurrent
    // writers the read can race with another pod's update, but that only
    // ever results in redundant, harmless archival (recordMarketHistory's own
    // dedupe/upgrade merge makes re-archiving the same or an inferior
    // observation a no-op), never data loss or corruption.
    const before = (await LiveEventMirror.findOne(
      { eventId: data.eventId },
      { sequence: 1, occurredAt: 1, phase: 1, bettingStatus: 1, markets: 1 }
    ).lean()) as {
      sequence?: number;
      occurredAt?: string;
      phase?: EventPhase;
      bettingStatus?: BettingStatus;
      markets?: MirrorMarket[];
    } | null;

    let historyChanged = false;

    if (
      before?.markets
      && before.markets.length > 0
      && before.sequence !== undefined
      && data.sequence > before.sequence
    ) {
      historyChanged = await this.recordMarketHistory({
        eventId: data.eventId,
        sequence: before.sequence,
        occurredAt: before.occurredAt,
        authorityEndedAt: this.isLiveSnapshotOpen(data)
          ? undefined
          : data.occurredAt,
        authorityEndSequence: this.isLiveSnapshotOpen(data)
          ? undefined
          : data.sequence,
        phase: before.phase ?? data.phase,
        bettingStatus: before.bettingStatus ?? data.bettingStatus,
        markets: before.markets,
      });
    }

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

      currentChanged = result.modifiedCount > 0 || result.upsertedCount > 0;
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }

      currentChanged = false;
    }

    // Every snapshot's markets are folded into the bounded, persisted history
    // regardless of whether this snapshot won the race to become "current".
    // Otherwise a newer snapshot (or an out-of-order/duplicate delivery) could
    // permanently erase evidence of a quote that was authoritative when a bet
    // referencing it was submitted. This is intentionally left unguarded: if
    // it throws (CAS exhaustion / missing document), the error must propagate
    // to the caller so the message is not acked and gets redelivered instead
    // of silently losing this snapshot's history.
    const incomingHistoryChanged = await this.recordMarketHistory(data);

    // Report "changed" when either the current mirror or the persisted
    // history changed. An out-of-order/duplicate delivery can supply new
    // history-only evidence (e.g. a delayed OPEN observation upgrading a
    // previously-recorded CLOSED/SETTLED placeholder for the same identity)
    // without ever becoming "current" -- callers rely on this to know when
    // it is worth replaying parked bets for this event.
    return currentChanged || historyChanged || incomingHistoryChanged;
  }

  /**
   * Bounded merge of every distinct marketId+marketVersion+quoteVersion quote
   * observed in this snapshot into the event's persisted market history.
   * Uses optimistic concurrency (historyRevision) with bounded retries. If
   * every attempt loses the race (or the mirror document cannot be found
   * immediately after upsert), this throws rather than silently dropping the
   * snapshot: swallowing the failure here could permanently erase the only
   * persisted evidence that an authoritative old quote existed, which is
   * exactly the loss this history exists to prevent. Callers must let this
   * propagate out of `upsertLiveEventMirror` uncaught -- the listener then
   * never acks the message, so it is redelivered. Redelivered processing is
   * safe: recording is idempotent and merges deterministically (see below),
   * so a retry can only add missing history or upgrade an existing entry,
   * never duplicate or corrupt it.
   *
   * Merging is identity-keyed (marketId+marketVersion+quoteVersion), but not
   * strictly first-write-wins: out-of-order or concurrent delivery can
   * persist a CLOSED/SETTLED observation of a triple before its own earlier
   * OPEN observation arrives (or vice versa). An authoritative live+OPEN
   * observation always wins for a given identity -- it is adopted in place
   * of an existing non-open/non-live placeholder for the same triple, but is
   * itself never downgraded once frozen, and two non-open/non-live
   * observations of the same triple are left as whichever was recorded
   * first (their relative ordering carries no evidentiary weight).
   *
   * Returns whether anything in history actually changed, so callers (e.g.
   * `upsertLiveEventMirror`) can tell a history-only change (no "current"
   * mirror update) apart from a genuine no-op.
   */
  private async recordMarketHistory(
    data: MarketHistorySnapshot,
    attempt = 0
  ): Promise<boolean> {
    if (data.markets.length === 0 && this.isLiveSnapshotOpen(data)) {
      return false;
    }

    if (attempt >= MAX_MARKET_HISTORY_WRITE_ATTEMPTS) {
      throw new Error(
        `Failed to persist market history for event ${data.eventId} after `
          + `${MAX_MARKET_HISTORY_WRITE_ATTEMPTS} concurrent-write attempts; `
          + "refusing to silently drop this snapshot's quote history."
      );
    }

    const current = (await LiveEventMirror.findOne(
      { eventId: data.eventId },
      { marketHistory: 1, historyRevision: 1 }
    ).lean()) as {
      marketHistory?: MirrorMarketHistoryEntry[];
      historyRevision?: number;
    } | null;

    if (!current) {
      throw new Error(
        `Failed to persist market history for event ${data.eventId}: `
          + "no live event mirror document was found immediately after upsert."
      );
    }

    const existing = current.marketHistory ?? [];
    const existingByKey = new Map<string, MirrorMarketHistoryEntry>(
      existing.map((entry) => [this.marketHistoryKey(entry), entry] as const)
    );
    let changed = false;

    for (const market of data.markets) {
      const key = this.marketHistoryKey(market);
      const candidate: MirrorMarketHistoryEntry = {
        marketId: market.marketId,
        marketType: market.marketType,
        marketVersion: market.marketVersion,
        quoteVersion: market.quoteVersion,
        quoteValidUntil: market.quoteValidUntil,
        status: market.status,
        selections: market.selections,
        sequence: data.sequence,
        occurredAt: data.occurredAt,
        authorityEndedAt: data.authorityEndedAt,
        authorityEndSequence: data.authorityEndSequence,
        phase: data.phase,
        bettingStatus: data.bettingStatus,
      };
      const priorEntry = existingByKey.get(key);

      if (!priorEntry) {
        existingByKey.set(key, candidate);
        changed = true;
        continue;
      }

      const priorWasOpen = this.wasHistoricallyOpenAndLive(priorEntry);
      const candidateWasOpen = this.wasHistoricallyOpenAndLive(candidate);

      if (!priorWasOpen && candidateWasOpen) {
        const upgradedCandidate =
          priorEntry.sequence > candidate.sequence
            ? this.withEarlierAuthorityEnd(
                candidate,
                priorEntry.sequence,
                priorEntry.occurredAt
              )
            : candidate;
        existingByKey.set(key, upgradedCandidate);
        changed = true;
        continue;
      }

      if (priorWasOpen) {
        let authoritativeEntry = priorEntry;

        if (candidate.authorityEndSequence && candidate.authorityEndedAt) {
          authoritativeEntry = this.withEarlierAuthorityEnd(
            authoritativeEntry,
            candidate.authorityEndSequence,
            candidate.authorityEndedAt
          );
        }

        if (!candidateWasOpen && candidate.sequence > priorEntry.sequence) {
          authoritativeEntry = this.withEarlierAuthorityEnd(
            authoritativeEntry,
            candidate.sequence,
            candidate.occurredAt
          );
        }

        if (authoritativeEntry !== priorEntry) {
          existingByKey.set(key, authoritativeEntry);
          changed = true;
        }
      }
    }

    if (!this.isLiveSnapshotOpen(data)) {
      for (const [key, entry] of existingByKey) {
        if (
          !this.wasHistoricallyOpenAndLive(entry)
          || data.sequence <= entry.sequence
        ) {
          continue;
        }

        const endedEntry = this.withEarlierAuthorityEnd(
          entry,
          data.sequence,
          data.occurredAt
        );

        if (endedEntry !== entry) {
          existingByKey.set(key, endedEntry);
          changed = true;
        }
      }
    }

    const historyEntries = [...existingByKey.entries()];
    for (const [key, entry] of historyEntries) {
      if (!this.wasHistoricallyOpenAndLive(entry)) {
        continue;
      }

      const nextAuthorityChange = historyEntries
        .filter(
          ([candidateKey, candidate]) =>
            candidate.marketId === entry.marketId
            && candidate.sequence > entry.sequence
            && (
              candidateKey !== key
              || !this.wasHistoricallyOpenAndLive(candidate)
            )
            && Boolean(candidate.occurredAt)
        )
        .sort((left, right) => left[1].sequence - right[1].sequence)[0]?.[1];

      if (!nextAuthorityChange) {
        continue;
      }

      const endedEntry = this.withEarlierAuthorityEnd(
        entry,
        nextAuthorityChange.sequence,
        nextAuthorityChange.occurredAt
      );

      if (endedEntry !== entry) {
        existingByKey.set(key, endedEntry);
        changed = true;
      }
    }

    if (!changed) {
      return false;
    }

    const revision = current.historyRevision ?? 0;
    const merged = this.pruneMarketHistory([...existingByKey.values()]);
    // A document written before this history feature existed (or before
    // `historyRevision` was ever set) has no `historyRevision` field at all,
    // not an explicit 0 -- `{ historyRevision: 0 }` does not match a missing
    // field in MongoDB, so a plain equality CAS would exhaust every retry
    // and this snapshot's history would never persist (the listener would
    // redeliver forever). When the inferred revision is 0 because the field
    // is genuinely absent, match either the missing field or an explicit 0;
    // only one concurrent writer's update can actually apply (the other's
    // filter stops matching the instant either succeeds), so this remains a
    // safe compare-and-swap.
    const revisionFilter =
      current.historyRevision === undefined
        ? { $or: [{ historyRevision: { $exists: false } }, { historyRevision: 0 }] }
        : { historyRevision: revision };

    const result = await LiveEventMirror.updateOne(
      { eventId: data.eventId, ...revisionFilter },
      {
        $set: {
          marketHistory: merged,
          historyRevision: revision + 1,
        },
      }
    );

    if (result.matchedCount === 0) {
      return this.recordMarketHistory(data, attempt + 1);
    }

    return true;
  }

  private marketHistoryKey(market: {
    marketId: string;
    marketVersion: number;
    quoteVersion: number;
  }): string {
    return `${market.marketId}\u0000${market.marketVersion}\u0000${market.quoteVersion}`;
  }

  private withEarlierAuthorityEnd(
    entry: MirrorMarketHistoryEntry,
    authorityEndSequence: number | undefined,
    authorityEndedAt: string | undefined
  ): MirrorMarketHistoryEntry {
    if (
      !authorityEndedAt
      || authorityEndSequence === undefined
      || authorityEndSequence <= entry.sequence
      || (
        entry.authorityEndSequence !== undefined
        && entry.authorityEndSequence <= authorityEndSequence
      )
    ) {
      return entry;
    }

    return {
      ...entry,
      authorityEndedAt,
      authorityEndSequence,
    };
  }

  private pruneMarketHistory(
    entries: MirrorMarketHistoryEntry[]
  ): MirrorMarketHistoryEntry[] {
    const byMarket = new Map<string, MirrorMarketHistoryEntry[]>();

    for (const entry of entries) {
      const bucket = byMarket.get(entry.marketId) ?? [];
      bucket.push(entry);
      byMarket.set(entry.marketId, bucket);
    }

    const pruned: MirrorMarketHistoryEntry[] = [];

    for (const bucket of byMarket.values()) {
      bucket.sort(
        (left, right) =>
          right.sequence - left.sequence
          || right.quoteVersion - left.quoteVersion
      );
      pruned.push(...bucket.slice(0, MAX_MARKET_HISTORY_VERSIONS_PER_MARKET));
    }

    return pruned;
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

      const resolvedMarket = this.resolveExactMarket(mirror, row);

      if (!resolvedMarket) {
        // Nothing (current or history) matches this exact marketId+
        // marketVersion+quoteVersion triple. Preserve the event-not-live
        // gate for this case: an event that is not currently live, and for
        // which no historical evidence of this specific quote exists, still
        // declines as not live rather than as a generic missing-market reason.
        affectedRows.push(
          this.buildAffectedRow(
            row,
            this.isLiveOpen(mirror)
              ? this.reasonForMissingExactMarket(currentMarket)
              : ModerationDeclineReason.EVENT_NOT_LIVE,
            currentMarket,
            currentSelection
          )
        );
        continue;
      }

      const {
        market: exactMarket,
        live: wasLiveWhenQuoted,
        authorityEndedAt,
      } = resolvedMarket;
      const exactSelection = this.findExactSelection(exactMarket, row);

      if (!wasLiveWhenQuoted) {
        affectedRows.push(
          this.buildAffectedRow(
            row,
            ModerationDeclineReason.EVENT_NOT_LIVE,
            exactMarket,
            exactSelection ?? currentSelection
          )
        );
        continue;
      }

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
          event.data.submittedAt,
          authorityEndedAt
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
        $and: [
          this.unpublishedDecisionFilter(),
          {
            $or: this.claimablePublicationLeaseFilters(now.toISOString()),
          },
        ],
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
    submittedAt: string | undefined,
    authorityEndedAt?: string
  ): boolean {
    if (
      !marketValidUntil
      || !this.isLiveSubmissionBeforeExpiry(rowValidUntil, submittedAt)
      || !this.isLiveSubmissionBeforeAuthorityEnd(
        submittedAt,
        authorityEndedAt
      )
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

  private isLiveSubmissionBeforeAuthorityEnd(
    submittedAt: string | undefined,
    authorityEndedAt: string | undefined
  ): boolean {
    if (authorityEndedAt === undefined) {
      return true;
    }

    if (!submittedAt) {
      return false;
    }

    const submittedAtMs = Date.parse(submittedAt);
    const authorityEndedAtMs = Date.parse(authorityEndedAt);

    return (
      Number.isFinite(submittedAtMs)
      && Number.isFinite(authorityEndedAtMs)
      && submittedAtMs < authorityEndedAtMs
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
    return this.isLiveSnapshotOpen(mirror);
  }

  /**
   * Market-aware counterpart of `isLiveOpen`: used anywhere a *specific*
   * market's live eligibility is being decided, so PRE_MATCH only ever
   * authorises KICKOFF_TEAM/FIRST_MINUTE_GOAL rather than any live market
   * type. `isLiveOpen`/`isLiveSnapshotOpen` remain in use for genuinely
   * whole-event/record-level checks (e.g. "has this event's live window
   * ended at all") that are not about any one market's type.
   */
  private isLiveOpenForMarket(
    mirror: LiveEventMirrorRecord,
    marketType: LiveMarketType
  ): boolean {
    return (
      isMarketLiveEligibleForPhase(mirror.phase, marketType)
      && mirror.bettingStatus === BettingStatus.OPEN
    );
  }

  private isLiveSnapshotOpen(snapshot: {
    phase: EventPhase;
    bettingStatus: BettingStatus;
  }): boolean {
    return (
      LIVE_PHASES.has(snapshot.phase)
      && snapshot.bettingStatus === BettingStatus.OPEN
    );
  }

  /**
   * Resolves the exact marketId+marketVersion+quoteVersion quote a row
   * references, along with whether the event was genuinely live *at the
   * moment that quote was authoritative*.
   *
   * Gamemaster does not bump marketVersion/quoteVersion when a market is
   * later suspended/settled/closed *in place* (e.g. at half-time or
   * full-time) -- the exact same triple is simply re-broadcast with a
   * different `status` and, once no longer OPEN, no `quoteValidUntil`.
   * `recordMarketHistory` dedupes purely on the (marketId, marketVersion,
   * quoteVersion) key, so whenever a triple was ever genuinely open+live its
   * one persisted historical entry is frozen at that original observation
   * and is never overwritten by a later in-place status mutation of the
   * *same* triple. That frozen, point-in-time observation -- not whatever
   * the mirror's *current* snapshot now shows for the very same triple -- is
   * what must govern a bet that was submitted while it was still
   * authoritative, so it is preferred over the current mirror whenever it
   * shows the quote was open and live. A current live+open entry is still
   * honoured whenever history has nothing better to offer (no entry, or an
   * entry that was never itself open+live, e.g. a version created already
   * CLOSED because its own incident cap was already exhausted).
   */
  private resolveExactMarket(
    mirror: LiveEventMirrorRecord,
    row: NormalizedSlipRow
  ): {
    market: MirrorMarket;
    live: boolean;
    authorityEndedAt?: string;
  } | undefined {
    const historical = this.findHistoricalMarket(mirror, row);

    if (historical && this.wasHistoricallyOpenAndLive(historical)) {
      return {
        market: historical,
        live: true,
        authorityEndedAt: this.authorityEndedAtForHistory(mirror, historical),
      };
    }

    const inCurrentMirror = mirror.markets.find(
      (market) =>
        this.matchesMarketIdentity(market, row)
        && market.marketVersion === row.marketVersion
        && market.quoteVersion === row.quoteVersion
    );

    if (inCurrentMirror) {
      return {
        market: inCurrentMirror,
        live: this.isLiveOpenForMarket(mirror, inCurrentMirror.marketType),
      };
    }

    return historical
      ? {
          market: historical,
          live: this.wasHistoricallyLive(historical),
          authorityEndedAt: this.authorityEndedAtForHistory(
            mirror,
            historical
          ),
        }
      : undefined;
  }

  private authorityEndedAtForHistory(
    mirror: LiveEventMirrorRecord,
    historical: MirrorMarketHistoryEntry
  ): string | undefined {
    if (historical.authorityEndedAt !== undefined) {
      return historical.authorityEndedAt;
    }

    if (
      mirror.sequence > historical.sequence
      && !this.isLiveOpenForMarket(mirror, historical.marketType)
    ) {
      return mirror.occurredAt;
    }

    return undefined;
  }

  private wasHistoricallyLive(entry: MirrorMarketHistoryEntry): boolean {
    return (
      isMarketLiveEligibleForPhase(entry.phase, entry.marketType)
      && entry.bettingStatus === BettingStatus.OPEN
    );
  }

  private wasHistoricallyOpenAndLive(entry: MirrorMarketHistoryEntry): boolean {
    return entry.status === LiveMarketStatus.OPEN && this.wasHistoricallyLive(entry);
  }

  private findHistoricalMarket(
    mirror: LiveEventMirrorRecord,
    row: NormalizedSlipRow
  ): MirrorMarketHistoryEntry | undefined {
    return (mirror.marketHistory ?? []).find(
      (entry) =>
        this.matchesMarketIdentity(entry, row)
        && entry.marketVersion === row.marketVersion
        && entry.quoteVersion === row.quoteVersion
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

    if (row.selectionId) {
      if (byId || !row.side) {
        return byId;
      }
      const sameSideSelections = market.selections.filter(
        (selection) => selection.side === row.side
      );
      return sameSideSelections.length === 1
        ? sameSideSelections[0]
        : undefined;
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
