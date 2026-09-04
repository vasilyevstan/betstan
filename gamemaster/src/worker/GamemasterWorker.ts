import { randomUUID } from "crypto";
import {
  BettingStatus,
  EventPhase,
  EventStatus,
  IEventResultEvent,
  ILiveEventUpdateEvent,
  LiveMarketStatus,
  messengerWrapper,
} from "@betstan/common";

import { Event } from "../model/Event";
import { EventArchive } from "../model/EventArchive";
import LiveEventUpdatePublisher from "../event/publisher/LiveEventUpdatePublisher";
import ResultSetPublisher from "../event/publisher/ResultSetPublisher";
import { LiveResultSource } from "../model/liveStateFields";
import {
  buildPreKickoffMarkets,
  LiveIncidentType,
  LiveMarketType,
  LiveSettlementReason,
  SimulationResult,
  SimulationTransition,
  simulateMatch,
  TeamSide,
} from "../simulation";
import { createLiveSeed, isPrivateLiveSeed } from "../simulation/liveSeed";

const DEFAULT_WORK_CADENCE_MS = 1000;
const DEFAULT_LEASE_DURATION_MS = 30000;
const LIVE_KICKOFF_CUTOVER_WINDOW_MS = 10 * 60 * 1000;
/**
 * How far ahead of kickoff an event becomes a live-betting candidate: the
 * simulation is generated early and the two pre-kickoff live-slip markets
 * (kickoff team, goal in first minute) are published, OPEN, at sequence 0.
 * Distinct from `LIVE_KICKOFF_CUTOVER_WINDOW_MS`, which governs unrelated
 * post-kickoff catch-up/fast-forward behavior for events claimed late.
 */
const LIVE_PRE_KICKOFF_WINDOW_MS = 10 * 60 * 1000;
const MAX_EVENTS_PER_TICK = 100;
const MAX_SIMULATION_FAILURES = 3;

type TimerHandle = unknown;
type LiveUpdateIncident = NonNullable<ILiveEventUpdateEvent["data"]["incident"]>;
type LiveUpdateMarket = ILiveEventUpdateEvent["data"]["markets"][number];
type LiveUpdateSettlement =
  ILiveEventUpdateEvent["data"]["settlements"][number];
type LiveUpdateData = ILiveEventUpdateEvent["data"] & {
  incidents?: LiveUpdateIncident[];
  incidentsComplete?: boolean;
};

function asPublishedIncidentType(
  value: LiveIncidentType
): LiveUpdateIncident["type"] {
  return value as unknown as LiveUpdateIncident["type"];
}

function asPublishedMarketType(
  value: LiveMarketType
): LiveUpdateMarket["marketType"] {
  return value as unknown as LiveUpdateMarket["marketType"];
}

function asPublishedTeamSide(
  value: TeamSide
): LiveUpdateMarket["selections"][number]["side"] {
  return value as unknown as LiveUpdateMarket["selections"][number]["side"];
}

function asPublishedSettlementReason(
  value: LiveSettlementReason
): LiveUpdateSettlement["settlementReason"] {
  return value as unknown as LiveUpdateSettlement["settlementReason"];
}

export interface WorkerClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

interface GamemasterWorkerOptions {
  clock?: WorkerClock;
  cadenceMs?: number;
  leaseDurationMs?: number;
  liveKickoffsEnabled?: (now: Date) => boolean;
  simulate?: typeof simulateMatch;
  createLiveSeed?: () => string;
}

const systemClock: WorkerClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function liveKickoffsAllowedAt(
  now: Date,
  enabledValue = process.env.LIVE_KICKOFFS_ENABLED,
  leaseUntilEpochValue = process.env.LIVE_KICKOFFS_LEASE_UNTIL_EPOCH
): boolean {
  if (enabledValue?.trim().toLowerCase() !== "true") {
    return false;
  }

  if (leaseUntilEpochValue === undefined) {
    return true;
  }

  const normalisedLease = leaseUntilEpochValue.trim();
  if (!/^[1-9][0-9]*$/.test(normalisedLease)) {
    return false;
  }

  const leaseUntilEpoch = Number(normalisedLease);
  if (!Number.isSafeInteger(leaseUntilEpoch)) {
    return false;
  }

  return now.getTime() < leaseUntilEpoch * 1000;
}

function asDate(value: Date | string | null | undefined): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number") {
    return new Date(value);
  }

  return new Date();
}

function asIsoString(value: Date | string | null | undefined): string {
  return asDate(value).toISOString();
}

function currentPhase(event: any): EventPhase {
  return event.phase ?? EventPhase.PRE_MATCH;
}

function hasStoredSimulation(event: any): boolean {
  return Array.isArray(event.liveTransitions) && event.liveTransitions.length > 0;
}

function hasPublishedPreKickoffMarkets(event: any): boolean {
  return Boolean(event.livePreKickoffPublishedAt);
}

function confirmedReplayCursor(event: any): number {
  return Number(event.liveConfirmedReplayCursor ?? 0);
}

function currentSequence(event: any): number {
  return Number(event.liveSequence ?? confirmedReplayCursor(event));
}

function storedTransitions(event: any): SimulationTransition[] {
  return Array.isArray(event.liveTransitions)
    ? (event.liveTransitions as SimulationTransition[])
    : [];
}

function nextStoredTransition(event: any): SimulationTransition | undefined {
  return storedTransitions(event)[confirmedReplayCursor(event)];
}

function currentMarkets(event: any): any[] {
  if (Array.isArray(event.liveMarkets) && event.liveMarkets.length > 0) {
    return event.liveMarkets;
  }

  const transitions = storedTransitions(event);
  if (!transitions.length) {
    return [];
  }

  const cursor = confirmedReplayCursor(event);
  if (cursor > 0) {
    return transitions[cursor - 1]?.markets ?? [];
  }

  return transitions[0]?.markets ?? [];
}

function hasPendingManualResult(event: any): boolean {
  return event.pendingResult?.source === LiveResultSource.MANUAL;
}

function hasPublishedManualSnapshot(event: any): boolean {
  return Boolean(
    event.pendingResult?.publishedSequence
    && event.pendingResult?.publishedAt
  );
}

function deriveSimulationFinalScore(
  event: any
): { home: number; away: number } {
  const transitions = storedTransitions(event);
  const last = transitions[transitions.length - 1];
  if (last) {
    return {
      home: last.homeScore,
      away: last.awayScore,
    };
  }

  return {
    home: Number(event.liveHomeScore ?? event.homeResult ?? 0),
    away: Number(event.liveAwayScore ?? event.awayResult ?? 0),
  };
}

function buildPublishedIncident(
  transition: Pick<
    SimulationTransition,
    "incident" | "minute" | "addedTime"
  >,
  occurredAtIso: string
): NonNullable<ILiveEventUpdateEvent["data"]["incident"]> {
  return {
    id: transition.incident.id,
    relatedIncidentId: transition.incident.linkedIncidentId,
    type: asPublishedIncidentType(transition.incident.type),
    side:
      transition.incident.side === undefined
        ? undefined
        : asPublishedTeamSide(transition.incident.side),
    occurredAt: occurredAtIso,
    minute: transition.minute,
    addedTime: transition.addedTime,
  };
}

export class GamemasterWorker {
  private resultSetPublisher?: ResultSetPublisher;
  private liveEventUpdatePublisher?: LiveEventUpdatePublisher;
  private readonly clock: WorkerClock;
  private readonly cadenceMs: number;
  private readonly leaseDurationMs: number;
  private readonly liveKickoffsEnabled: (now: Date) => boolean;
  private readonly simulate: typeof simulateMatch;
  private readonly createLiveSeed: () => string;
  private initPromise?: Promise<void>;
  private scheduledTick?: TimerHandle;
  private running = false;
  private stopped = false;

  constructor(options: GamemasterWorkerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.cadenceMs = options.cadenceMs ?? DEFAULT_WORK_CADENCE_MS;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.liveKickoffsEnabled =
      options.liveKickoffsEnabled
      ?? ((now: Date) => liveKickoffsAllowedAt(now));
    this.simulate = options.simulate ?? simulateMatch;
    this.createLiveSeed = options.createLiveSeed ?? createLiveSeed;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.resultSetPublisher = new ResultSetPublisher(
          messengerWrapper.connection
        );
        this.liveEventUpdatePublisher = new LiveEventUpdatePublisher(
          messengerWrapper.connection
        );

        await Promise.all([
          this.resultSetPublisher.init(),
          this.resultSetPublisher.initConfirmChannel(),
          this.liveEventUpdatePublisher.init(),
          this.liveEventUpdatePublisher.initConfirmChannel(),
        ]);
      })();
    }

    await this.initPromise;
  }

  async checkEventsOnce() {
    for (let processed = 0; processed < MAX_EVENTS_PER_TICK; processed += 1) {
      if (this.stopped) {
        return;
      }

      const claimed = await this.claimNextEvent();
      if (!claimed) {
        return;
      }

      const token = claimed.processingLease?.token;
      try {
        await this.processClaimedEvent(claimed);
      } finally {
        if (token) {
          await this.releaseLease(claimed._id, token);
        }
      }
    }
  }

  work() {
    if (this.scheduledTick || !this.stopped && this.running) {
      return;
    }

    this.stopped = false;
    this.scheduleNextTick(0);
  }

  stop() {
    this.stopped = true;
    if (this.scheduledTick) {
      this.clock.clearTimeout(this.scheduledTick);
      this.scheduledTick = undefined;
    }
  }

  private get resultPublisher(): ResultSetPublisher {
    if (!this.resultSetPublisher) {
      throw new Error("Result publisher is not initialised");
    }

    return this.resultSetPublisher;
  }

  private get livePublisher(): LiveEventUpdatePublisher {
    if (!this.liveEventUpdatePublisher) {
      throw new Error("Live update publisher is not initialised");
    }

    return this.liveEventUpdatePublisher;
  }

  private scheduleNextTick(delayMs: number) {
    if (this.stopped) {
      return;
    }

    this.scheduledTick = this.clock.setTimeout(() => {
      void this.runScheduledTick();
    }, delayMs);
  }

  private async runScheduledTick() {
    this.scheduledTick = undefined;

    if (this.running) {
      this.scheduleNextTick(this.cadenceMs);
      return;
    }

    this.running = true;
    try {
      await this.checkEventsOnce();
    } catch (err) {
      console.error("GAMEMASTER_TICK_FAILED", err);
    } finally {
      this.running = false;
      this.scheduleNextTick(this.cadenceMs);
    }
  }

  private async claimNextEvent(): Promise<any | null> {
    const now = this.clock.now();
    const preKickoffWindowMs = this.liveKickoffsEnabled(now)
      ? LIVE_PRE_KICKOFF_WINDOW_MS
      : 0;

    return (
      await this.claimEvent(
        {
          status: EventStatus.NO_RESULT,
          "pendingResult.source": LiveResultSource.MANUAL,
        },
        { "pendingResult.requestedAt": 1, time: 1 },
        now
      )
      ?? await this.claimEvent(
        {
          status: EventStatus.NO_RESULT,
          "pendingResult.source": { $ne: LiveResultSource.MANUAL },
          "liveTransitions.0": { $exists: true },
          $or: [
            { liveNextTransitionAt: { $lte: now } },
            {
              liveNextTransitionAt: null,
              phase: EventPhase.FULL_TIME,
            },
            {
              liveNextTransitionAt: null,
              resultPublishedAt: { $ne: null },
            },
            // A stored simulation whose pre-kickoff snapshot has not yet
            // been published: reclaim it even though `liveNextTransitionAt`
            // (the kick-off transition itself) is still in the future.
            // `liveConfirmedReplayCursor: 0` scopes this to events still in
            // the pre-kickoff window/awaiting kick-off, so it never causes
            // repeated reclaiming of already-replayed matches.
            {
              livePreKickoffPublishedAt: null,
              liveConfirmedReplayCursor: 0,
            },
          ],
        },
        { liveNextTransitionAt: 1, time: 1 },
        now
      )
      ?? await this.claimEvent(
        {
          status: EventStatus.NO_RESULT,
          "pendingResult.source": { $ne: LiveResultSource.MANUAL },
          "liveTransitions.0": { $exists: false },
          "simulationFailure.quarantinedAt": null,
          // An event becomes a live-betting candidate up to
          // `LIVE_PRE_KICKOFF_WINDOW_MS` before kickoff (when live kickoffs
          // are enabled), mirroring the same lead time
          // `ensureSimulationPersisted` uses to generate its simulation.
          time: { $lte: new Date(now.getTime() + preKickoffWindowMs) },
        },
        { time: 1 },
        now
      )
    );
  }

  private async claimEvent(
    criteria: Record<string, any>,
    sort: Record<string, 1 | -1>,
    now: Date
  ): Promise<any | null> {
    const token = randomUUID();
    const expiresAt = new Date(now.getTime() + this.leaseDurationMs);

    return Event.findOneAndUpdate(
      {
        $and: [
          criteria,
          {
            $or: [
              { "processingLease.expiresAt": { $exists: false } },
              { "processingLease.expiresAt": null },
              { "processingLease.expiresAt": { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          processingLease: {
            token,
            acquiredAt: now,
            expiresAt,
          },
        },
      },
      {
        sort,
        new: true,
      }
    );
  }

  private async releaseLease(id: any, token: string) {
    await Event.updateOne(
      {
        _id: id,
        "processingLease.token": token,
      },
      {
        $unset: {
          processingLease: 1,
        },
      }
    );
  }

  private async processClaimedEvent(event: any) {
    let current = await this.refreshClaimedEvent(
      event._id,
      event.processingLease?.token
    );
    if (!current) {
      return;
    }

    if (hasPendingManualResult(current)) {
      await this.processManualResult(current);
      return;
    }

    current = await this.ensureSimulationPersisted(current);
    if (!current) {
      return;
    }

    current = await this.publishPendingPreKickoffMarkets(current);
    if (!current) {
      return;
    }

    current = await this.publishDueTransitions(current);
    if (!current) {
      return;
    }

    current = await this.refreshClaimedEvent(
      current._id,
      current.processingLease?.token
    );
    if (!current) {
      return;
    }

    if (hasPendingManualResult(current)) {
      await this.processManualResult(current);
      return;
    }

    if (
      currentPhase(current) === EventPhase.FULL_TIME
      && !current.liveNextTransitionAt
    ) {
      await this.publishFinalResultAndArchive(current);
    }
  }

  private async ensureSimulationPersisted(event: any): Promise<any> {
    if (hasStoredSimulation(event) || hasPendingManualResult(event)) {
      return event;
    }

    const kickoffAt = asDate(event.time);
    const now = this.clock.now();
    // An event only becomes a live-betting candidate (simulation generated
    // and, per `publishPendingPreKickoffMarkets`, its pre-kickoff markets
    // published) starting `LIVE_PRE_KICKOFF_WINDOW_MS` before kickoff -- and
    // only while live kickoffs are enabled; preserves the exact prior
    // "wait until kickoff" gate when the feature is off.
    const simulationLeadTimeMs = this.liveKickoffsEnabled(now)
      ? LIVE_PRE_KICKOFF_WINDOW_MS
      : 0;
    if (kickoffAt.getTime() - now.getTime() > simulationLeadTimeMs) {
      return event;
    }

    const seed = isPrivateLiveSeed(event.liveSeed)
      ? event.liveSeed
      : this.createLiveSeed();
    let simulation: SimulationResult;
    let persistencePlan: {
      confirmedSequence: number;
      liveEndedAt?: Date;
    };
    try {
      simulation = this.simulate({
        eventId: event.eventId,
        seed,
      });
      persistencePlan = this.liveKickoffsEnabled(now)
        ? this.initialSimulationPersistencePlan(kickoffAt, simulation)
        : this.completedSimulationPersistencePlan(simulation);
    } catch (error) {
      await this.recordSimulationFailure(event);
      throw error;
    }

    return (
      await Event.findOneAndUpdate(
        {
          _id: event._id,
          "processingLease.token": event.processingLease?.token,
          status: EventStatus.NO_RESULT,
          "pendingResult.source": { $ne: LiveResultSource.MANUAL },
          "liveTransitions.0": { $exists: false },
        },
        {
          $set: this.simulationPersistenceUpdate(
            kickoffAt,
            simulation,
            persistencePlan.confirmedSequence,
            persistencePlan.liveEndedAt,
            seed
          ),
          $unset: {
            simulationFailure: "",
          },
        },
        { new: true }
      )
      ?? await this.refreshClaimedEvent(event._id, event.processingLease?.token)
    );
  }

  private completedSimulationPersistencePlan(
    simulation: SimulationResult
  ): {
    confirmedSequence: number;
    liveEndedAt: Date;
  } {
    const finalTransition =
      simulation.transitions[simulation.transitions.length - 1];
    if (!finalTransition || finalTransition.phase !== EventPhase.FULL_TIME) {
      throw new Error("Simulation does not contain a full-time transition");
    }

    return {
      confirmedSequence: finalTransition.sequence,
      liveEndedAt: this.clock.now(),
    };
  }

  private async recordSimulationFailure(event: any): Promise<void> {
    const failedAt = this.clock.now();
    const failedEvent = await Event.findOneAndUpdate(
      {
        _id: event._id,
        "processingLease.token": event.processingLease?.token,
        status: EventStatus.NO_RESULT,
        "liveTransitions.0": { $exists: false },
      },
      {
        $inc: {
          "simulationFailure.attemptCount": 1,
        },
        $set: {
          "simulationFailure.lastFailedAt": failedAt,
        },
      },
      { new: true }
    );

    const attemptCount = Number(
      failedEvent?.simulationFailure?.attemptCount ?? 0
    );
    const quarantined = attemptCount >= MAX_SIMULATION_FAILURES;
    if (quarantined && failedEvent) {
      await Event.updateOne(
        {
          _id: failedEvent._id,
          "processingLease.token": event.processingLease?.token,
          "simulationFailure.quarantinedAt": null,
        },
        {
          $set: {
            "simulationFailure.quarantinedAt": failedAt,
          },
        }
      );
    }

    console.error(
      quarantined
        ? "GAMEMASTER_SIMULATION_QUARANTINED"
        : "GAMEMASTER_SIMULATION_FAILED",
      JSON.stringify({
        attemptCount,
        eventId: event.eventId,
      })
    );
  }

  private initialSimulationPersistencePlan(
    kickoffAt: Date,
    simulation: SimulationResult
  ): {
    confirmedSequence: number;
    liveEndedAt?: Date;
  } {
    const overdueMs = this.clock.now().getTime() - kickoffAt.getTime();
    if (overdueMs <= 0) {
      return { confirmedSequence: 0 };
    }

    const latestDueTransition = this.latestDueTransition(
      kickoffAt,
      simulation.transitions
    );
    if (!latestDueTransition) {
      return { confirmedSequence: 0 };
    }

    if (overdueMs >= LIVE_KICKOFF_CUTOVER_WINDOW_MS) {
      const finalTransition =
        simulation.transitions[simulation.transitions.length - 1];
      return {
        confirmedSequence: finalTransition?.sequence ?? 0,
        liveEndedAt: this.clock.now(),
      };
    }

    return {
      confirmedSequence: Math.max(0, latestDueTransition.sequence - 1),
    };
  }

  private simulationPersistenceUpdate(
    kickoffAt: Date,
    simulation: SimulationResult,
    confirmedSequence = 0,
    liveEndedAtOverride?: Date,
    privateSeed = String(simulation.timeline.seed)
  ): Record<string, unknown> {
    const confirmedTransition =
      confirmedSequence > 0
        ? simulation.transitions[confirmedSequence - 1]
        : undefined;

    return {
      phase: confirmedTransition?.phase ?? EventPhase.PRE_MATCH,
      liveSeed: privateSeed,
      liveEngineVersion: simulation.engineVersion,
      liveStartedAt: kickoffAt,
      liveEndedAt:
        liveEndedAtOverride
        ?? (
          confirmedTransition?.phase === EventPhase.FULL_TIME
            ? this.transitionOccurredAtForKickoff(kickoffAt, confirmedTransition)
            : new Date(kickoffAt.getTime() + simulation.timeline.durationMs)
        ),
      liveSequence: confirmedTransition?.sequence ?? 0,
      liveConfirmedReplayCursor: confirmedSequence,
      liveNextTransitionAt: this.nextTransitionAt(
        kickoffAt,
        simulation.transitions,
        confirmedSequence
      ),
      liveHomeScore: confirmedTransition?.homeScore ?? 0,
      liveAwayScore: confirmedTransition?.awayScore ?? 0,
      liveTimeline: simulation.timeline,
      liveTransitions: simulation.transitions,
      liveMarkets:
        confirmedTransition?.markets
        ?? (
          confirmedSequence === 0 && kickoffAt.getTime() > this.clock.now().getTime()
            // Still in the pre-kickoff countdown: expose the standalone
            // pre-kickoff snapshot (both markets OPEN), not the already
            // closed/settled version-1 state `transitions[0]` holds for
            // them post-kickoff.
            ? buildPreKickoffMarkets(simulation.timeline)
            : simulation.transitions[0]?.markets
        )
        ?? [],
    };
  }

  private async publishDueTransitions(event: any): Promise<any | null> {
    let current = event;

    while (true) {
      current = await this.refreshClaimedEvent(
        current._id,
        current.processingLease?.token
      );
      if (!current) {
        return null;
      }

      if (hasPendingManualResult(current)) {
        return current;
      }

      const nextTransition = nextStoredTransition(current);
      if (!nextTransition) {
        return current;
      }

      const occurredAt = this.transitionOccurredAt(current, nextTransition);
      if (occurredAt.getTime() > this.clock.now().getTime()) {
        return current;
      }

      await this.init();
      await this.livePublisher.publishWithConfirm(
        this.buildLiveUpdatePayload(current, nextTransition, occurredAt)
      );

      const now = this.clock.now();
      const updated = await Event.findOneAndUpdate(
        {
          _id: current._id,
          "processingLease.token": current.processingLease?.token,
          liveConfirmedReplayCursor: confirmedReplayCursor(current),
        },
        {
          $set: {
            phase: nextTransition.phase,
            liveSequence: nextTransition.sequence,
            liveConfirmedReplayCursor: nextTransition.sequence,
            liveNextTransitionAt: this.nextTransitionAt(
              this.kickoffAt(current),
              storedTransitions(current),
              nextTransition.sequence
            ),
            liveHomeScore: nextTransition.homeScore,
            liveAwayScore: nextTransition.awayScore,
            liveMarkets: nextTransition.markets,
            liveEndedAt:
              nextTransition.phase === EventPhase.FULL_TIME
                ? occurredAt
                : current.liveEndedAt,
            processingLease: {
              token: current.processingLease?.token,
              acquiredAt: now,
              expiresAt: new Date(now.getTime() + this.leaseDurationMs),
            },
          },
        },
        { new: true }
      );

      current = updated ?? await Event.findById(current._id);
      if (!current) {
        return null;
      }
    }
  }

  private buildLiveUpdatePayload(
    event: any,
    transition: SimulationTransition,
    occurredAt: Date
  ): ILiveEventUpdateEvent {
    const occurredAtIso = occurredAt.toISOString();
    const incident = buildPublishedIncident(transition, occurredAtIso);
    const quoteValidUntil = this.nextQuoteCutoffAt(
      this.kickoffAt(event),
      storedTransitions(event),
      transition.sequence
    )?.toISOString();
    const data: LiveUpdateData = {
      eventId: event.eventId,
      sequence: transition.sequence,
      occurredAt: occurredAtIso,
      kickoffAt: this.kickoffAt(event).toISOString(),
      minute: transition.minute,
      addedTime: transition.addedTime,
      phase: transition.phase as EventPhase,
      homeScore: transition.homeScore,
      awayScore: transition.awayScore,
      bettingStatus: transition.bettingStatus as BettingStatus,
      incident,
      incidents: this.buildCumulativeIncidents(event, transition.sequence, incident),
      incidentsComplete: true,
      markets: transition.markets.map((market) => ({
        marketId: market.marketId,
        marketType: asPublishedMarketType(market.marketType),
        marketVersion: market.marketVersion,
        quoteVersion: market.quoteVersion,
        quoteValidUntil:
          market.status === LiveMarketStatus.OPEN
            ? quoteValidUntil
            : undefined,
        status: market.status as unknown as ILiveEventUpdateEvent["data"]["markets"][number]["status"],
        selections: market.selections.map((selection) => ({
          selectionId: selection.selectionId,
          side: asPublishedTeamSide(selection.side),
          odds: selection.odds,
          ...(selection.label ? { label: selection.label } : {}),
        })),
      })),
      settlements: transition.settlements.map((settlement) => ({
        marketId: settlement.marketId,
        marketVersion: settlement.marketVersion,
        settlementReason: asPublishedSettlementReason(
          settlement.settlementReason
        ),
        settlementSequence: settlement.settlementSequence,
        winningSide: asPublishedTeamSide(settlement.winningSide),
        winningSelection: settlement.winningSelection,
      })),
      eventName: event.name,
      home: event.home,
      away: event.away,
    };

    return {
      data,
    };
  }

  /**
   * Publishes the standalone pre-kickoff live-slip snapshot (kickoff team,
   * goal in first minute; both OPEN at marketVersion 1) once, at sequence 0,
   * for events that have a stored simulation but have not yet reached
   * kickoff. Independently guarded by `livePreKickoffPublishedAt` (rather
   * than folded into `ensureSimulationPersisted`'s `hasStoredSimulation`
   * guard) so a crash between persisting the simulation and publishing this
   * snapshot can still be retried on the next claim.
   */
  private async publishPendingPreKickoffMarkets(event: any): Promise<any> {
    if (
      hasPublishedPreKickoffMarkets(event)
      || hasPendingManualResult(event)
      || !hasStoredSimulation(event)
    ) {
      return event;
    }

    const kickoffAt = this.kickoffAt(event);
    const now = this.clock.now();

    if (kickoffAt.getTime() > now.getTime()) {
      await this.init();
      await this.livePublisher.publishWithConfirm(
        this.buildPreKickoffLiveUpdatePayload(event, kickoffAt, now)
      );
    }
    // If kickoff has already passed (e.g. the worker was unavailable for the
    // entire pre-kickoff window), there is no pre-kickoff snapshot left to
    // publish -- but the marker still must be set so this event is not
    // reclaimed for this step indefinitely.

    return (
      await Event.findOneAndUpdate(
        {
          _id: event._id,
          "processingLease.token": event.processingLease?.token,
          livePreKickoffPublishedAt: null,
        },
        { $set: { livePreKickoffPublishedAt: now } },
        { new: true }
      )
      ?? await this.refreshClaimedEvent(event._id, event.processingLease?.token)
    );
  }

  private buildPreKickoffLiveUpdatePayload(
    event: any,
    kickoffAt: Date,
    occurredAt: Date
  ): ILiveEventUpdateEvent {
    const occurredAtIso = occurredAt.toISOString();
    const kickoffAtIso = kickoffAt.toISOString();
    const markets = currentMarkets(event);
    const data: LiveUpdateData = {
      eventId: event.eventId,
      sequence: 0,
      occurredAt: occurredAtIso,
      kickoffAt: kickoffAtIso,
      minute: 0,
      phase: EventPhase.PRE_MATCH,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidents: [],
      incidentsComplete: true,
      markets: markets.map((market) => ({
        marketId: market.marketId,
        marketType: market.marketType as unknown as ILiveEventUpdateEvent["data"]["markets"][number]["marketType"],
        marketVersion: market.marketVersion,
        quoteVersion: market.quoteVersion,
        // Pre-kickoff quotes are valid up to the atomic kickoff transition,
        // which is exactly when both markets close.
        quoteValidUntil:
          market.status === LiveMarketStatus.OPEN ? kickoffAtIso : undefined,
        status: market.status as unknown as ILiveEventUpdateEvent["data"]["markets"][number]["status"],
        selections: market.selections.map((selection: any) => ({
          selectionId: selection.selectionId,
          side: selection.side as unknown as TeamSide,
          odds: selection.odds,
          ...(selection.label ? { label: selection.label } : {}),
        })),
      })),
      settlements: [],
      eventName: event.name,
      home: event.home,
      away: event.away,
    };

    return {
      data,
    };
  }

  private async processManualResult(event: any) {
    if (hasPublishedManualSnapshot(event)) {
      await this.archiveAndDelete(
        event,
        this.manualArchiveOverrides(event, currentMarkets(event))
      );
      return;
    }

    await this.init();
    const liveUpdate = this.buildManualLiveUpdatePayload(event);
    await this.livePublisher.publishWithConfirm(liveUpdate);

    const now = this.clock.now();
    const updated = await Event.findOneAndUpdate(
      {
        _id: event._id,
        "processingLease.token": event.processingLease?.token,
        "pendingResult.source": LiveResultSource.MANUAL,
      },
      {
        $set: {
          phase: EventPhase.FULL_TIME,
          liveSequence: liveUpdate.data.sequence,
          liveConfirmedReplayCursor: liveUpdate.data.sequence,
          liveNextTransitionAt: null,
          liveHomeScore: liveUpdate.data.homeScore,
          liveAwayScore: liveUpdate.data.awayScore,
          liveMarkets: liveUpdate.data.markets,
          liveEndedAt: asDate(liveUpdate.data.occurredAt),
          "pendingResult.publishedSequence": liveUpdate.data.sequence,
          "pendingResult.publishedAt": now,
          processingLease: {
            token: event.processingLease?.token,
            acquiredAt: now,
            expiresAt: new Date(now.getTime() + this.leaseDurationMs),
          },
        },
      },
      { new: true }
    );

    if (!updated) {
      return;
    }

    await this.archiveAndDelete(
      updated,
      this.manualArchiveOverrides(updated, liveUpdate.data.markets)
    );
  }

  /**
   * Whether a market must be explicitly voided (settled with
   * `LiveSettlementReason.MANUAL_VOID`) when a manual full-time result
   * pre-empts the simulation. OPEN/SUSPENDED markets are always live and
   * unsettled, so they always need this. FIRST_MINUTE_GOAL is the one
   * market type whose CLOSED status is *not* terminal: it closes
   * atomically at kickoff (see `markets.ts`) but is only actually settled
   * later, at the FIRST_MINUTE_ELAPSED marker -- a manual result landing
   * in that in-between window would otherwise archive the event leaving it
   * permanently unsettled. Every other market type only ever reaches
   * CLOSED once its own settlement has already been recorded (e.g.
   * cap-exhausted NEXT_* markets settle via `LiveSettlementReason.INCIDENT`
   * at the very moment they close), so this must not also void those.
   */
  private needsManualVoid(market: {
    marketType: LiveMarketType;
    status: LiveMarketStatus;
  }): boolean {
    if (
      market.status === LiveMarketStatus.OPEN
      || market.status === LiveMarketStatus.SUSPENDED
    ) {
      return true;
    }

    return (
      (
        market.marketType === LiveMarketType.FIRST_MINUTE_GOAL
        || market.marketType === LiveMarketType.SECOND_HALF_SCORE
      )
      && market.status === LiveMarketStatus.CLOSED
    );
  }

  private buildManualLiveUpdatePayload(event: any): ILiveEventUpdateEvent {
    const pending = event.pendingResult;
    const sequence = currentSequence(event) + 1;
    const occurredAt = asDate(pending?.requestedAt ?? this.clock.now());
    const incident: LiveUpdateIncident = {
      id: `manual-full-time-${sequence}`,
      type: asPublishedIncidentType(LiveIncidentType.FULL_TIME),
      occurredAt: occurredAt.toISOString(),
      minute: 90,
    };
    const markets = currentMarkets(event).map((market) => {
      if (this.needsManualVoid(market)) {
        return {
          ...market,
          status: LiveMarketStatus.SETTLED,
        };
      }

      return { ...market };
    });
    const settlements = currentMarkets(event)
      .filter((market) => this.needsManualVoid(market))
      .map((market) => ({
        marketId: market.marketId,
        marketVersion: market.marketVersion,
        settlementReason: asPublishedSettlementReason(
          LiveSettlementReason.MANUAL_VOID
        ),
        settlementSequence: sequence,
        winningSide: asPublishedTeamSide(TeamSide.NONE),
      }));
    const data: LiveUpdateData = {
      eventId: event.eventId,
      sequence,
      occurredAt: occurredAt.toISOString(),
      kickoffAt: this.kickoffAt(event).toISOString(),
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: Number(event.homeResult ?? pending?.homeScore ?? 0),
      awayScore: Number(event.awayResult ?? pending?.awayScore ?? 0),
      bettingStatus: BettingStatus.CLOSED,
      incident,
      incidents: this.buildManualCumulativeIncidents(event, incident),
      incidentsComplete: true,
      markets,
      settlements,
      eventName: event.name,
      home: event.home,
      away: event.away,
    };

    return {
      data,
    };
  }

  private manualArchiveOverrides(
    event: any,
    markets: any[]
  ): Record<string, unknown> {
    const pending = event.pendingResult;
    const requestedAt = asDate(pending?.requestedAt ?? this.clock.now());
    const sequence = Number(
      pending?.publishedSequence ?? currentSequence(event)
    );

    return {
      status: EventStatus.RESULTED,
      phase: EventPhase.FULL_TIME,
      liveSequence: sequence,
      liveConfirmedReplayCursor: sequence,
      liveNextTransitionAt: null,
      liveHomeScore: Number(event.homeResult ?? pending?.homeScore ?? 0),
      liveAwayScore: Number(event.awayResult ?? pending?.awayScore ?? 0),
      liveMarkets: markets,
      liveEndedAt: requestedAt,
      homeResult: Number(event.homeResult ?? pending?.homeScore ?? 0),
      awayResult: Number(event.awayResult ?? pending?.awayScore ?? 0),
      resultPublishedAt: asDate(
        event.resultPublishedAt ?? pending?.requestedAt ?? requestedAt
      ),
      pendingResult: event.pendingResult,
    };
  }

  private async publishFinalResultAndArchive(event: any) {
    if (hasPendingManualResult(event)) {
      return;
    }

    const finalScore = deriveSimulationFinalScore(event);
    if (!event.resultPublishedAt) {
      await this.init();
      await this.resultPublisher.publishWithConfirm(
        this.buildResultEvent(event, finalScore.home, finalScore.away)
      );

      const now = this.clock.now();
      const updated = await Event.findOneAndUpdate(
        {
          _id: event._id,
          "processingLease.token": event.processingLease?.token,
          resultPublishedAt: null,
          "pendingResult.source": { $ne: LiveResultSource.MANUAL },
        },
        {
          $set: {
            homeResult: finalScore.home,
            awayResult: finalScore.away,
            resultPublishedAt: now,
            phase: EventPhase.FULL_TIME,
            liveSequence: Math.max(
              currentSequence(event),
              confirmedReplayCursor(event)
            ),
            liveConfirmedReplayCursor: confirmedReplayCursor(event),
            liveNextTransitionAt: null,
            liveHomeScore: finalScore.home,
            liveAwayScore: finalScore.away,
            processingLease: {
              token: event.processingLease?.token,
              acquiredAt: now,
              expiresAt: new Date(now.getTime() + this.leaseDurationMs),
            },
          },
        },
        { new: true }
      );

      if (!updated) {
        const refreshed = await this.refreshClaimedEvent(
          event._id,
          event.processingLease?.token
        );
        if (refreshed && hasPendingManualResult(refreshed)) {
          await this.processManualResult(refreshed);
        }
        return;
      }

      event = updated;
    }

    await this.archiveAndDelete(event, {
      status: EventStatus.RESULTED,
      phase: EventPhase.FULL_TIME,
      liveSequence: Math.max(
        currentSequence(event),
        confirmedReplayCursor(event)
      ),
      liveConfirmedReplayCursor: confirmedReplayCursor(event),
      liveNextTransitionAt: null,
      liveHomeScore: finalScore.home,
      liveAwayScore: finalScore.away,
      liveEndedAt: event.liveEndedAt ?? this.lastTransitionOccurredAt(event),
      homeResult: Number(event.homeResult ?? finalScore.home),
      awayResult: Number(event.awayResult ?? finalScore.away),
      resultPublishedAt: asDate(
        event.resultPublishedAt ?? this.clock.now()
      ),
    });
  }

  private buildResultEvent(
    event: any,
    homeScore: number,
    awayScore: number
  ): IEventResultEvent {
    return {
      data: {
        eventId: event.eventId,
        homeScore,
        awayScore,
        home: event.home,
        away: event.away,
      },
    };
  }

  private async archiveAndDelete(
    event: any,
    overrides: Record<string, unknown>
  ) {
    await EventArchive.updateOne(
      { eventId: event.eventId },
      {
        $setOnInsert: {
          eventId: event.eventId,
          name: event.name,
          time: asIsoString(event.time),
          home: event.home,
          away: event.away,
          homeResult: event.homeResult,
          awayResult: event.awayResult,
          status: EventStatus.RESULTED,
          phase: currentPhase(event),
          liveSeed: event.liveSeed,
          liveEngineVersion: event.liveEngineVersion,
          liveStartedAt: event.liveStartedAt,
          liveEndedAt: event.liveEndedAt,
          liveSequence: currentSequence(event),
          liveConfirmedReplayCursor: confirmedReplayCursor(event),
          liveNextTransitionAt: event.liveNextTransitionAt,
          liveHomeScore: event.liveHomeScore,
          liveAwayScore: event.liveAwayScore,
          liveTimeline: event.liveTimeline,
          liveTransitions: event.liveTransitions,
          liveMarkets: event.liveMarkets,
          processingLease: event.processingLease,
          pendingResult: event.pendingResult,
          simulationFailure: event.simulationFailure,
          resultPublishedAt: event.resultPublishedAt,
          ...overrides,
        },
      },
      { upsert: true }
    );

    await Event.deleteOne({ _id: event._id });
  }

  private async refreshClaimedEvent(
    id: any,
    token: string | undefined
  ): Promise<any | null> {
    if (!token) {
      return null;
    }

    return Event.findOne({
      _id: id,
      "processingLease.token": token,
    });
  }

  private kickoffAt(event: any): Date {
    return asDate(event.liveStartedAt ?? event.time);
  }

  private transitionOccurredAt(
    event: any,
    transition: Pick<SimulationTransition, "offsetMs">
  ): Date {
    return this.transitionOccurredAtForKickoff(this.kickoffAt(event), transition);
  }

  private transitionOccurredAtForKickoff(
    kickoffAt: Date,
    transition: Pick<SimulationTransition, "offsetMs">
  ): Date {
    return new Date(kickoffAt.getTime() + transition.offsetMs);
  }

  private buildCumulativeIncidents(
    event: any,
    sequence: number,
    currentIncident?: LiveUpdateIncident
  ): NonNullable<LiveUpdateData["incidents"]> {
    const kickoffAt = this.kickoffAt(event);
    const incidents = storedTransitions(event)
      .filter((transition) => transition.sequence <= sequence)
      .map((transition) =>
        buildPublishedIncident(
          transition,
          this.transitionOccurredAtForKickoff(kickoffAt, transition).toISOString()
        )
      );

    if (
      currentIncident
      && !incidents.some((incident) => incident.id === currentIncident.id)
    ) {
      incidents.push(currentIncident);
    }

    return incidents;
  }

  private buildManualCumulativeIncidents(
    event: any,
    currentIncident: LiveUpdateIncident
  ): NonNullable<LiveUpdateData["incidents"]> {
    return this.buildCumulativeIncidents(
      event,
      confirmedReplayCursor(event),
      currentIncident
    );
  }

  private latestDueTransition(
    kickoffAt: Date,
    transitions: SimulationTransition[]
  ): SimulationTransition | undefined {
    const nowMs = this.clock.now().getTime();
    let latest: SimulationTransition | undefined;

    for (const transition of transitions) {
      if (this.transitionOccurredAtForKickoff(kickoffAt, transition).getTime() > nowMs) {
        break;
      }

      latest = transition;
    }

    return latest;
  }

  private nextTransitionAt(
    kickoffAt: Date,
    transitions: SimulationTransition[],
    confirmedSequence: number
  ): Date | null {
    const next = transitions[confirmedSequence];
    return next
      ? new Date(kickoffAt.getTime() + next.offsetMs)
      : null;
  }

  /**
   * Like `nextTransitionAt`, but skips over any FIRST_MINUTE_ELAPSED
   * transition when searching for the boundary a market's `quoteValidUntil`
   * should be pinned to.
   *
   * FIRST_MINUTE_ELAPSED is a non-material marker (it settles
   * FIRST_MINUTE_GOAL in place but never reprices/re-versions any other
   * market) that, unlike prior incident types, is now deterministic and
   * guaranteed to occur very soon after kickoff on every match. If it were
   * left in the search, every OPEN market unrelated to it would have its
   * `quoteValidUntil` recomputed to a *new* value at the FIRST_MINUTE_ELAPSED
   * transition without any change to its (marketId, marketVersion,
   * quoteVersion) identity. Moderation's market history freezes the first
   * open+live observation of a given identity forever, so a bet submitted
   * against the later (correct, current) `quoteValidUntil` could then be
   * rejected as stale against the earlier frozen value. Skipping
   * FIRST_MINUTE_ELAPSED here keeps `quoteValidUntil` for an unaffected
   * market's identity stable across it, exactly preserving pre-existing
   * behavior for every other transition/incident type.
   */
  private nextQuoteCutoffAt(
    kickoffAt: Date,
    transitions: SimulationTransition[],
    confirmedSequence: number
  ): Date | null {
    const next = transitions
      .slice(confirmedSequence)
      .find(
        (transition) => transition.incident.type !== LiveIncidentType.FIRST_MINUTE_ELAPSED
      );
    return next
      ? new Date(kickoffAt.getTime() + next.offsetMs)
      : null;
  }

  private lastTransitionOccurredAt(event: any): Date | null {
    const transitions = storedTransitions(event);
    const last = transitions[transitions.length - 1];
    return last ? this.transitionOccurredAt(event, last) : null;
  }
}
