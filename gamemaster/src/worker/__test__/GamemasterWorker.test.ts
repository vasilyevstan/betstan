import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import { EventStatus, IEventResultEvent, messengerWrapper } from "@betstan/common";

import EventResultListener from "../../event/listener/EventResultListener";
import LiveEventUpdatePublisher from "../../event/publisher/LiveEventUpdatePublisher";
import ResultSetPublisher from "../../event/publisher/ResultSetPublisher";
import { Event } from "../../model/Event";
import { EventArchive } from "../../model/EventArchive";
import { LiveResultSource } from "../../model/liveStateFields";
import {
  BettingStatus,
  EventPhase,
  LiveIncidentType,
  LiveMarketSnapshot,
  LiveMarketStatus,
  LiveMarketType,
  LiveSettlementReason,
  SimulationResult,
  SimulationTransition,
  TeamSide,
} from "../../simulation";
import {
  GamemasterWorker,
  WorkerClock,
  liveKickoffsAllowedAt,
} from "../GamemasterWorker";

beforeAll(() => {
  jest.spyOn(ResultSetPublisher.prototype, "init").mockResolvedValue(undefined);
  jest
    .spyOn(ResultSetPublisher.prototype, "initConfirmChannel")
    .mockResolvedValue(undefined);
  jest
    .spyOn(ResultSetPublisher.prototype, "publishWithConfirm")
    .mockResolvedValue(undefined);
  jest.spyOn(LiveEventUpdatePublisher.prototype, "init").mockResolvedValue(
    undefined
  );
  jest
    .spyOn(LiveEventUpdatePublisher.prototype, "initConfirmChannel")
    .mockResolvedValue(undefined);
  jest
    .spyOn(LiveEventUpdatePublisher.prototype, "publishWithConfirm")
    .mockResolvedValue(undefined);
});

beforeEach(() => {
  process.env.LIVE_KICKOFFS_ENABLED = "true";
  delete process.env.LIVE_KICKOFFS_LEASE_UNTIL_EPOCH;
  (
    ResultSetPublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mockResolvedValue(undefined);
  (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mockResolvedValue(undefined);
});

const baseKickoff = new Date("2025-01-01T12:00:00.000Z");

function createStaticClock(now: Date): WorkerClock {
  return {
    now: () => new Date(now.getTime()),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

function buildMessage(): ConsumeMessage {
  return {
    content: Buffer.alloc(5),
    fields: {
      consumerTag: "",
      deliveryTag: 0,
      redelivered: false,
      exchange: "",
      routingKey: "",
    },
    properties: {
      contentType: undefined,
      contentEncoding: undefined,
      headers: {},
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  };
}

function selectionId(
  eventId: string,
  marketType: LiveMarketType,
  marketVersion: number,
  side: TeamSide
): string {
  return `${eventId}:${marketType}:${marketVersion}:${side}`;
}

function buildMarket(
  eventId: string,
  marketType: LiveMarketType,
  status: LiveMarketStatus,
  marketVersion = 1,
  quoteVersion = 1
): LiveMarketSnapshot {
  const sides =
    marketType === LiveMarketType.HALF_TIME_RESULT
      ? [TeamSide.HOME, TeamSide.DRAW, TeamSide.AWAY]
      : [TeamSide.HOME, TeamSide.AWAY, TeamSide.NONE];

  return {
    marketId: `${eventId}:${marketType}`,
    marketType,
    marketVersion,
    quoteVersion,
    status,
    selections: sides.map((side, index) => ({
      selectionId: selectionId(eventId, marketType, marketVersion, side),
      side,
      odds: 1.5 + index,
    })),
  };
}

function marketSet(
  eventId: string,
  nextStatus: LiveMarketStatus,
  halfTimeStatus: LiveMarketStatus,
  quoteVersion = 1
): LiveMarketSnapshot[] {
  return [
    buildMarket(
      eventId,
      LiveMarketType.NEXT_YELLOW_CARD,
      nextStatus,
      1,
      quoteVersion
    ),
    buildMarket(
      eventId,
      LiveMarketType.NEXT_RED_CARD,
      nextStatus,
      1,
      quoteVersion
    ),
    buildMarket(
      eventId,
      LiveMarketType.NEXT_CORNER,
      nextStatus,
      1,
      quoteVersion
    ),
    buildMarket(
      eventId,
      LiveMarketType.HALF_TIME_RESULT,
      halfTimeStatus,
      1,
      quoteVersion
    ),
  ];
}

function buildTransition(
  eventId: string,
  sequence: number,
  offsetMs: number,
  phase: EventPhase,
  incidentType: LiveIncidentType,
  markets: LiveMarketSnapshot[],
  {
    homeScore = 0,
    awayScore = 0,
    minute = 0,
    bettingStatus = BettingStatus.OPEN,
    side,
    settlements = [],
  }: Partial<SimulationTransition> & {
    minute?: number;
    side?: "HOME" | "AWAY";
  } = {}
): SimulationTransition {
  return {
    eventId,
    sequence,
    offsetMs,
    minute,
    phase,
    homeScore,
    awayScore,
    scores: { home: homeScore, away: awayScore },
    bettingStatus,
    incident: {
      id: `${incidentType}-${sequence}`,
      type: incidentType,
      side,
    },
    markets,
    settlements,
  };
}

function buildSimulationResult(eventId: string): SimulationResult {
  const kickoffMarkets = marketSet(
    eventId,
    LiveMarketStatus.OPEN,
    LiveMarketStatus.OPEN,
    1
  );
  const goalMarkets = marketSet(
    eventId,
    LiveMarketStatus.OPEN,
    LiveMarketStatus.OPEN,
    2
  );
  const halfTimeMarkets = marketSet(
    eventId,
    LiveMarketStatus.SUSPENDED,
    LiveMarketStatus.SETTLED,
    3
  );
  const secondHalfMarkets = marketSet(
    eventId,
    LiveMarketStatus.OPEN,
    LiveMarketStatus.SETTLED,
    4
  );
  const fullTimeMarkets = marketSet(
    eventId,
    LiveMarketStatus.SETTLED,
    LiveMarketStatus.SETTLED,
    5
  );

  const transitions: SimulationTransition[] = [
    buildTransition(
      eventId,
      1,
      0,
      EventPhase.FIRST_HALF,
      LiveIncidentType.KICK_OFF,
      kickoffMarkets,
      { minute: 0 }
    ),
    buildTransition(
      eventId,
      2,
      500,
      EventPhase.FIRST_HALF,
      LiveIncidentType.GOAL,
      goalMarkets,
      {
        homeScore: 1,
        awayScore: 0,
        minute: 14,
        side: TeamSide.HOME,
      }
    ),
    buildTransition(
      eventId,
      3,
      1000,
      EventPhase.HALF_TIME,
      LiveIncidentType.HALF_TIME,
      halfTimeMarkets,
      {
        homeScore: 1,
        awayScore: 0,
        minute: 45,
        bettingStatus: BettingStatus.SUSPENDED,
        settlements: [
          {
            marketId: `${eventId}:${LiveMarketType.HALF_TIME_RESULT}`,
            marketVersion: 1,
            settlementReason: LiveSettlementReason.HALF_TIME,
            settlementSequence: 3,
            winningSide: TeamSide.HOME,
            winningSelection: selectionId(
              eventId,
              LiveMarketType.HALF_TIME_RESULT,
              1,
              TeamSide.HOME
            ),
          },
        ],
      }
    ),
    buildTransition(
      eventId,
      4,
      1200,
      EventPhase.SECOND_HALF,
      LiveIncidentType.SECOND_HALF_KICK_OFF,
      secondHalfMarkets,
      {
        homeScore: 1,
        awayScore: 0,
        minute: 46,
        bettingStatus: BettingStatus.OPEN,
      }
    ),
    buildTransition(
      eventId,
      5,
      2000,
      EventPhase.FULL_TIME,
      LiveIncidentType.FULL_TIME,
      fullTimeMarkets,
      {
        homeScore: 1,
        awayScore: 0,
        minute: 90,
        bettingStatus: BettingStatus.CLOSED,
        settlements: [
          LiveMarketType.NEXT_YELLOW_CARD,
          LiveMarketType.NEXT_RED_CARD,
          LiveMarketType.NEXT_CORNER,
        ].map((marketType) => ({
          marketId: `${eventId}:${marketType}`,
          marketVersion: 1,
          settlementReason: LiveSettlementReason.FULL_TIME_NONE,
          settlementSequence: 5,
          winningSide: TeamSide.NONE,
          winningSelection: selectionId(eventId, marketType, 1, TeamSide.NONE),
        })),
      }
    ),
  ];

  return {
    engineVersion: 1,
    timeline: {
      engineVersion: 1,
      eventId,
      seed: `seed-${eventId}`,
      durationMs: 2000,
      stoppage: { first: 1, second: 2 },
      config: {
        durationMs: 2000,
        rateScale: 1,
        rates: {
          goals: 0,
          yellows: 0,
          reds: 0,
          corners: 0,
          penaltyAwards: 0,
          freeKicks: 0,
          penaltyScoreProbability: 0.75,
        },
        caps: {
          goals: 5,
          yellows: 5,
          reds: 5,
          corners: 5,
          penaltyAwards: 5,
          freeKicks: 5,
        },
        stoppage: {
          first: { min: 1, max: 1 },
          second: { min: 2, max: 2 },
        },
        penaltyOutcomeDelaySeconds: 15,
        marketMargin: 0.05,
        minOdds: 1.01,
        maxOdds: 101,
      },
      entries: [],
    },
    transitions,
    finalScore: { home: 1, away: 0 },
  };
}

async function createEvent(eventTime = baseKickoff) {
  const event = new Event({
    eventId: new mongoose.Types.ObjectId().toHexString(),
    name: "Match name",
    time: eventTime,
    home: "Team 1",
    away: "Team 2",
    status: EventStatus.NO_RESULT,
  });

  await event.save();
  return event;
}

function nextTransitionAt(
  kickoffAt: Date,
  simulation: SimulationResult,
  confirmedCursor: number
): Date | null {
  const next = simulation.transitions[confirmedCursor];
  return next ? new Date(kickoffAt.getTime() + next.offsetMs) : null;
}

async function storeSimulation(
  event: any,
  simulation: SimulationResult,
  confirmedCursor = 0,
  overrides: Record<string, unknown> = {}
) {
  const confirmedTransition =
    confirmedCursor > 0 ? simulation.transitions[confirmedCursor - 1] : undefined;

  event.set({
    phase: overrides.phase ?? (confirmedTransition?.phase ?? EventPhase.PRE_MATCH),
    liveSeed: simulation.timeline.seed,
    liveEngineVersion: simulation.engineVersion,
    liveStartedAt: event.time,
    liveEndedAt:
      overrides.liveEndedAt
      ?? new Date(event.time.getTime() + simulation.timeline.durationMs),
    liveSequence: overrides.liveSequence ?? (confirmedTransition?.sequence ?? 0),
    liveConfirmedReplayCursor: confirmedCursor,
    liveNextTransitionAt:
      overrides.liveNextTransitionAt
      ?? nextTransitionAt(event.time, simulation, confirmedCursor),
    liveHomeScore: overrides.liveHomeScore ?? (confirmedTransition?.homeScore ?? 0),
    liveAwayScore: overrides.liveAwayScore ?? (confirmedTransition?.awayScore ?? 0),
    liveTimeline: simulation.timeline,
    liveTransitions: simulation.transitions,
    liveMarkets:
      overrides.liveMarkets
      ?? (confirmedTransition?.markets ?? simulation.transitions[0].markets),
    pendingResult: overrides.pendingResult,
    homeResult: overrides.homeResult,
    awayResult: overrides.awayResult,
    resultPublishedAt: overrides.resultPublishedAt ?? null,
  });

  await event.save();
  return event;
}

function buildDelayedSimulationResult(eventId: string): SimulationResult {
  const simulation = buildSimulationResult(eventId);
  simulation.timeline.durationMs = 120000;
  simulation.transitions = simulation.transitions.map((transition, index) => ({
    ...transition,
    offsetMs: index === 0 ? 0 : 60000 + index * 1000,
  }));

  return simulation;
}

function buildCutoverWindowSimulation(eventId: string): SimulationResult {
  const kickoffMarkets = marketSet(
    eventId,
    LiveMarketStatus.OPEN,
    LiveMarketStatus.OPEN,
    1
  );
  const goalMarkets = marketSet(
    eventId,
    LiveMarketStatus.OPEN,
    LiveMarketStatus.OPEN,
    2
  );
  const pressureMarkets = marketSet(
    eventId,
    LiveMarketStatus.OPEN,
    LiveMarketStatus.OPEN,
    3
  );
  const resumedMarkets = marketSet(
    eventId,
    LiveMarketStatus.OPEN,
    LiveMarketStatus.OPEN,
    4
  );
  const fullTimeMarkets = marketSet(
    eventId,
    LiveMarketStatus.SETTLED,
    LiveMarketStatus.SETTLED,
    5
  );

  return {
    engineVersion: 1,
    timeline: {
      ...buildSimulationResult(eventId).timeline,
      durationMs: 90 * 60 * 1000,
    },
    transitions: [
      buildTransition(
        eventId,
        1,
        0,
        EventPhase.FIRST_HALF,
        LiveIncidentType.KICK_OFF,
        kickoffMarkets,
        { minute: 0 }
      ),
      buildTransition(
        eventId,
        2,
        2 * 60 * 1000,
        EventPhase.FIRST_HALF,
        LiveIncidentType.GOAL,
        goalMarkets,
        {
          homeScore: 1,
          awayScore: 0,
          minute: 2,
          side: TeamSide.HOME,
        }
      ),
      buildTransition(
        eventId,
        3,
        5 * 60 * 1000,
        EventPhase.FIRST_HALF,
        LiveIncidentType.YELLOW_CARD,
        pressureMarkets,
        {
          homeScore: 1,
          awayScore: 0,
          minute: 5,
          side: TeamSide.AWAY,
        }
      ),
      buildTransition(
        eventId,
        4,
        30 * 60 * 1000,
        EventPhase.SECOND_HALF,
        LiveIncidentType.SECOND_HALF_KICK_OFF,
        resumedMarkets,
        {
          homeScore: 1,
          awayScore: 0,
          minute: 46,
          bettingStatus: BettingStatus.OPEN,
        }
      ),
      buildTransition(
        eventId,
        5,
        90 * 60 * 1000,
        EventPhase.FULL_TIME,
        LiveIncidentType.FULL_TIME,
        fullTimeMarkets,
        {
          homeScore: 1,
          awayScore: 0,
          minute: 90,
          bettingStatus: BettingStatus.CLOSED,
        }
      ),
    ],
    finalScore: { home: 1, away: 0 },
  };
}

function manualResultEvent(
  eventId: string,
  homeScore: number,
  awayScore: number
): IEventResultEvent {
  return {
    sender: "backoffice_result_set",
    timestamp: new Date("2025-01-01T12:00:01.000Z").toISOString(),
    data: {
      eventId,
      homeScore,
      awayScore,
      home: "Team 1",
      away: "Team 2",
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForMockCalls(mock: jest.Mock, expectedCalls: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (mock.mock.calls.length >= expectedCalls) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

class FakeClock implements WorkerClock {
  private currentMs: number;
  private nextId = 1;
  private readonly timers = new Map<number, { runAt: number; callback: () => void }>();

  constructor(start: Date) {
    this.currentMs = start.getTime();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, {
      runAt: this.currentMs + delayMs,
      callback,
    });

    return id;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  async advanceBy(delayMs: number) {
    const target = this.currentMs + delayMs;

    while (true) {
      const next = [...this.timers.entries()]
        .sort((left, right) => left[1].runAt - right[1].runAt)
        .find(([, timer]) => timer.runAt <= target);

      if (!next) {
        break;
      }

      this.currentMs = next[1].runAt;
      this.timers.delete(next[0]);
      next[1].callback();
      await flushPromises();
    }

    this.currentMs = target;
    await flushPromises();
  }
}

it("persists a simulation before kickoff publication and replays it after restart", async () => {
  const event = await createEvent(baseKickoff);
  const simulation = buildSimulationResult(event.eventId);
  const simulate = jest.fn(() => simulation);
  const privateSeed = "a".repeat(64);
  const firstClock: WorkerClock = {
    now: () => new Date(baseKickoff.getTime()),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };

  (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mockImplementationOnce(async () => {
    const stored = await Event.findOne({ eventId: event.eventId });
    expect(stored?.liveTransitions).toHaveLength(simulation.transitions.length);
    expect(stored?.liveConfirmedReplayCursor).toBe(0);
  });

  const firstWorker = new GamemasterWorker({
    clock: firstClock,
    simulate,
    createLiveSeed: () => privateSeed,
  });
  await firstWorker.checkEventsOnce();

  const afterKickoff = await Event.findOne({ eventId: event.eventId });
  expect(simulate).toHaveBeenCalledTimes(1);
  expect(simulate).toHaveBeenCalledWith({
    eventId: event.eventId,
    seed: privateSeed,
  });
  expect(afterKickoff?.liveSeed).toBe(privateSeed);
  expect(afterKickoff?.liveSeed).not.toBe(event.eventId);
  expect(afterKickoff?.liveConfirmedReplayCursor).toBe(1);
  expect(afterKickoff?.phase).toBe(EventPhase.FIRST_HALF);
  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);
  const kickoffPayload = (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mock.calls[0][0];
  expect(
    kickoffPayload.data.incidents.map((incident: { id: string }) => incident.id)
  ).toEqual([simulation.transitions[0].incident.id]);
  expect(kickoffPayload.data.incident.id).toBe(simulation.transitions[0].incident.id);
  const kickoffOpenMarkets = kickoffPayload.data.markets.filter(
    (market: { status: LiveMarketStatus }) =>
      market.status === LiveMarketStatus.OPEN
  );
  expect(kickoffOpenMarkets.length).toBeGreaterThan(0);
  expect(
    kickoffOpenMarkets.every(
      (market: { quoteValidUntil?: string }) =>
        market.quoteValidUntil
        === new Date(baseKickoff.getTime() + 500).toISOString()
    )
  ).toBe(true);

  const restartClock: WorkerClock = {
    now: () => new Date(baseKickoff.getTime() + 5000),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
  const restartWorker = new GamemasterWorker({
    clock: restartClock,
    simulate,
  });
  await restartWorker.checkEventsOnce();

  expect(simulate).toHaveBeenCalledTimes(1);
  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(5);
  const finalSnapshot = (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mock.calls[4][0];
  expect(finalSnapshot.data.sequence).toBe(5);
  expect(finalSnapshot.data.markets.length).toBeGreaterThan(0);
  expect(
    finalSnapshot.data.markets.every(
      (market: { quoteValidUntil?: string }) =>
        market.quoteValidUntil === undefined
    )
  ).toBe(true);
  expect(
    finalSnapshot.data.incidents.map((incident: { id: string }) => incident.id)
  ).toEqual(simulation.transitions.map((transition) => transition.incident.id));
  expect(
    ResultSetPublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);
  expect(await Event.countDocuments({ eventId: event.eventId })).toBe(0);
  const archived = await EventArchive.findOne({ eventId: event.eventId });
  expect(archived?.homeResult).toBe(1);
  expect(archived?.awayResult).toBe(0);
  expect(archived?.liveConfirmedReplayCursor).toBe(5);
});

it("uses a guarded fake-clock loop without overlapping publishes", async () => {
  const event = await createEvent(baseKickoff);
  const simulation = buildDelayedSimulationResult(event.eventId);
  await storeSimulation(event, simulation, 0);

  const gate = deferred<void>();
  (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mockImplementation(() => gate.promise);

  const clock = new FakeClock(baseKickoff);
  const worker = new GamemasterWorker({ clock, cadenceMs: 200 });
  worker.work();

  await clock.advanceBy(0);
  await waitForMockCalls(
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock,
    1
  );
  await clock.advanceBy(1000);

  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);

  worker.stop();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it("stops only new kickoffs when the feature flag is off", async () => {
  const newEvent = await createEvent(baseKickoff);
  const activeEvent = await createEvent(baseKickoff);
  const activeSimulation = buildSimulationResult(activeEvent.eventId);
  await storeSimulation(activeEvent, activeSimulation, 4);

  const worker = new GamemasterWorker({
    clock: {
      now: () => new Date(baseKickoff.getTime() + 5000),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    liveKickoffsEnabled: () => false,
    simulate: jest.fn(() => buildSimulationResult(newEvent.eventId)),
  });

  await worker.checkEventsOnce();

  const untouchedNewEvent = await Event.findOne({ eventId: newEvent.eventId });
  const completedActiveArchive = await EventArchive.findOne({
    eventId: activeEvent.eventId,
  });

  expect(untouchedNewEvent?.liveTransitions).toEqual([]);
  expect(untouchedNewEvent?.phase ?? EventPhase.PRE_MATCH).toBe(
    EventPhase.PRE_MATCH
  );
  expect(completedActiveArchive?.homeResult).toBe(1);
  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);
  expect(
    ResultSetPublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);
});

it("keeps new kickoffs dark by default when the env flag is missing", async () => {
  const original = process.env.LIVE_KICKOFFS_ENABLED;
  delete process.env.LIVE_KICKOFFS_ENABLED;

  const event = await createEvent(baseKickoff);
  const worker = new GamemasterWorker({
    clock: {
      now: () => new Date(baseKickoff.getTime()),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    simulate: jest.fn(() => buildSimulationResult(event.eventId)),
  });

  try {
    await worker.checkEventsOnce();
  } finally {
    if (original === undefined) {
      delete process.env.LIVE_KICKOFFS_ENABLED;
    } else {
      process.env.LIVE_KICKOFFS_ENABLED = original;
    }
  }

  const untouchedEvent = await Event.findOne({ eventId: event.eventId });
  expect(untouchedEvent?.liveTransitions).toEqual([]);
  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();
  expect(
    ResultSetPublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();
});

it("fails dark when an activation lease is malformed or expired", () => {
  const now = new Date("2025-01-01T12:00:00.500Z");
  const nowEpoch = Math.floor(now.getTime() / 1000);

  expect(liveKickoffsAllowedAt(now, "true", undefined)).toBe(true);
  expect(
    liveKickoffsAllowedAt(now, "true", String(nowEpoch + 60))
  ).toBe(true);
  expect(liveKickoffsAllowedAt(now, "true", String(nowEpoch))).toBe(false);
  expect(
    liveKickoffsAllowedAt(now, "true", String(nowEpoch - 1))
  ).toBe(false);
  expect(liveKickoffsAllowedAt(now, "true", "not-an-epoch")).toBe(false);
  expect(liveKickoffsAllowedAt(now, "true", "0")).toBe(false);
  expect(
    liveKickoffsAllowedAt(now, "false", String(nowEpoch + 60))
  ).toBe(false);
});

it("lets active matches finish but blocks new kickoffs after the lease expires", async () => {
  const newEvent = await createEvent(baseKickoff);
  const activeEvent = await createEvent(baseKickoff);
  const activeSimulation = buildSimulationResult(activeEvent.eventId);
  await storeSimulation(activeEvent, activeSimulation, 4);

  const now = new Date(baseKickoff.getTime() + 5000);
  process.env.LIVE_KICKOFFS_LEASE_UNTIL_EPOCH = String(
    Math.floor(now.getTime() / 1000) - 1
  );
  const worker = new GamemasterWorker({
    clock: createStaticClock(now),
    simulate: jest.fn(() => buildSimulationResult(newEvent.eventId)),
  });

  await worker.checkEventsOnce();

  const untouchedNewEvent = await Event.findOne({ eventId: newEvent.eventId });
  const completedActiveArchive = await EventArchive.findOne({
    eventId: activeEvent.eventId,
  });
  expect(untouchedNewEvent?.liveTransitions).toEqual([]);
  expect(completedActiveArchive?.homeResult).toBe(1);
  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);
  expect(
    ResultSetPublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);
});

it("uses a lease so concurrent workers do not process the same match twice", async () => {
  const event = await createEvent(baseKickoff);
  const simulation = buildSimulationResult(event.eventId);
  await storeSimulation(event, simulation, 0);

  const gate = deferred<void>();
  (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mockImplementation(() => gate.promise);

  const now = new Date(baseKickoff.getTime() + 50);
  const clock: WorkerClock = {
    now: () => now,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };

  const firstWorker = new GamemasterWorker({ clock });
  const secondWorker = new GamemasterWorker({ clock });

  const processing = Promise.all([
    firstWorker.checkEventsOnce(),
    secondWorker.checkEventsOnce(),
  ]);
  await waitForMockCalls(
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock,
    1
  );

  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);

  gate.resolve();
  await processing;

  const stored = await Event.findOne({ eventId: event.eventId });
  expect(stored?.liveConfirmedReplayCursor).toBe(1);
});

it("voids remaining markets and archives once when a manual result arrives", async () => {
  const event = await createEvent(baseKickoff);
  const simulation = buildSimulationResult(event.eventId);
  await storeSimulation(event, simulation, 4, {
    phase: EventPhase.SECOND_HALF,
    liveMarkets: simulation.transitions[3].markets,
    liveHomeScore: 1,
    liveAwayScore: 0,
  });

  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();
  await listener.onMessage(manualResultEvent(event.eventId, 7, 5), buildMessage());

  const pending = await Event.findOne({ eventId: event.eventId });
  expect(pending?.pendingResult?.source).toBe(LiveResultSource.MANUAL);
  expect(pending?.homeResult).toBe(7);
  expect(pending?.awayResult).toBe(5);
  expect(await EventArchive.countDocuments({ eventId: event.eventId })).toBe(0);

  const worker = new GamemasterWorker({
    clock: {
      now: () => new Date(baseKickoff.getTime() + 5000),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  await worker.checkEventsOnce();
  await worker.checkEventsOnce();

  expect(
    ResultSetPublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();
  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);
  const liveUpdate = (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mock.calls[0][0];
  expect(liveUpdate.data.sequence).toBe(5);
  expect(liveUpdate.data.homeScore).toBe(7);
  expect(liveUpdate.data.awayScore).toBe(5);
  expect(liveUpdate.data.settlements).toHaveLength(3);
  expect(
    liveUpdate.data.settlements.every(
      (settlement: any) =>
        settlement.settlementReason === LiveSettlementReason.MANUAL_VOID
        && settlement.winningSide === TeamSide.NONE
    )
  ).toBe(true);

  const archived = await EventArchive.findOne({ eventId: event.eventId });
  expect(archived?.homeResult).toBe(7);
  expect(archived?.awayResult).toBe(5);
  expect(archived?.pendingResult?.publishedSequence).toBe(5);
  expect(await Event.countDocuments({ eventId: event.eventId })).toBe(0);
});

it("publishes a single cutover snapshot for overdue events still inside the rollout window", async () => {
  const event = await createEvent(baseKickoff);
  const simulation = buildCutoverWindowSimulation(event.eventId);
  const worker = new GamemasterWorker({
    clock: {
      now: () => new Date(baseKickoff.getTime() + 6 * 60 * 1000),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    simulate: jest.fn(() => simulation),
  });

  await worker.checkEventsOnce();

  const publishedSequences = (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mock.calls.map(([payload]) => payload.data.sequence);
  expect(publishedSequences).toEqual([3]);
  const cutoverPayload = (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mock.calls[0][0];
  expect(cutoverPayload.data.homeScore).toBe(1);
  expect(cutoverPayload.data.awayScore).toBe(0);
  expect(
    cutoverPayload.data.incidents.map((incident: { id: string }) => incident.id)
  ).toEqual(
    simulation.transitions
      .slice(0, 3)
      .map((transition) => transition.incident.id)
  );
  expect(
    ResultSetPublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();

  const stored = await Event.findOne({ eventId: event.eventId });
  expect(stored?.liveConfirmedReplayCursor).toBe(3);
  expect(stored?.liveSequence).toBe(3);
  expect(stored?.phase).toBe(EventPhase.FIRST_HALF);
  expect(await EventArchive.countDocuments({ eventId: event.eventId })).toBe(0);
});

it("does not republish the cutover snapshot after restart until a new transition is due", async () => {
  const event = await createEvent(baseKickoff);
  const simulation = buildCutoverWindowSimulation(event.eventId);

  const firstWorker = new GamemasterWorker({
    clock: {
      now: () => new Date(baseKickoff.getTime() + 6 * 60 * 1000),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    simulate: jest.fn(() => simulation),
  });

  await firstWorker.checkEventsOnce();

  const secondWorker = new GamemasterWorker({
    clock: {
      now: () => new Date(baseKickoff.getTime() + 6 * 60 * 1000),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });

  await secondWorker.checkEventsOnce();

  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);
  expect(
    ResultSetPublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();
});

it("finalizes older overdue events without replaying stale live bursts", async () => {
  const event = await createEvent(baseKickoff);
  const simulation = buildCutoverWindowSimulation(event.eventId);
  const worker = new GamemasterWorker({
    clock: {
      now: () => new Date(baseKickoff.getTime() + 12 * 60 * 1000),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    simulate: jest.fn(() => simulation),
  });

  await worker.checkEventsOnce();
  await worker.checkEventsOnce();

  expect(
    LiveEventUpdatePublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();
  expect(
    ResultSetPublisher.prototype.publishWithConfirm
  ).toHaveBeenCalledTimes(1);

  const archived = await EventArchive.findOne({ eventId: event.eventId });
  expect(archived?.phase).toBe(EventPhase.FULL_TIME);
  expect(archived?.homeResult).toBe(1);
  expect(archived?.awayResult).toBe(0);
  expect(archived?.liveConfirmedReplayCursor).toBe(5);
  expect(archived?.liveSequence).toBe(5);
  expect(await Event.countDocuments({ eventId: event.eventId })).toBe(0);
});

it("archives without republishing a final result that was already confirmed", async () => {
  const event = await createEvent(baseKickoff);
  const simulation = buildSimulationResult(event.eventId);
  await storeSimulation(event, simulation, 5, {
    phase: EventPhase.FULL_TIME,
    liveMarkets: simulation.transitions[4].markets,
    liveHomeScore: 1,
    liveAwayScore: 0,
    homeResult: 1,
    awayResult: 0,
    resultPublishedAt: new Date(baseKickoff.getTime() + 2500),
    liveNextTransitionAt: null,
  });

  const worker = new GamemasterWorker({
    clock: {
      now: () => new Date(baseKickoff.getTime() + 6000),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });

  await worker.checkEventsOnce();

  expect(
    ResultSetPublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();
  const archived = await EventArchive.findOne({ eventId: event.eventId });
  expect(archived?.resultPublishedAt).toBeTruthy();
  expect(await Event.countDocuments({ eventId: event.eventId })).toBe(0);
});

it("covers helper fallbacks for getters, dates, incidents, and manual payloads", async () => {
  const clock = createStaticClock(new Date(baseKickoff.getTime() + 5000));
  const worker = new GamemasterWorker({ clock });
  const simulation = buildSimulationResult("helper-event");

  expect(() => (worker as any).resultPublisher).toThrow(
    "Result publisher is not initialised"
  );
  expect(() => (worker as any).livePublisher).toThrow(
    "Live update publisher is not initialised"
  );
  await expect((worker as any).refreshClaimedEvent("ignored", undefined)).resolves.toBeNull();

  expect(
    (worker as any)
      .kickoffAt({ time: baseKickoff.toISOString() })
      .toISOString()
  ).toBe(baseKickoff.toISOString());
  expect((worker as any).nextTransitionAt(baseKickoff, simulation.transitions, 99)).toBeNull();
  expect((worker as any).lastTransitionOccurredAt({ liveTransitions: [] })).toBeNull();

  const pushedIncident = {
    id: "synthetic-incident",
    type: LiveIncidentType.FULL_TIME,
    occurredAt: baseKickoff.toISOString(),
    minute: 90,
  };
  expect(
    (worker as any).buildCumulativeIncidents(
      { liveStartedAt: baseKickoff.toISOString(), liveTransitions: [] },
      0,
      pushedIncident
    )
  ).toEqual([pushedIncident]);
  expect(
    (worker as any).buildCumulativeIncidents(
      {
        liveStartedAt: baseKickoff.toISOString(),
        liveTransitions: simulation.transitions,
      },
      1,
      {
        ...pushedIncident,
        id: simulation.transitions[0].incident.id,
      }
    )
  ).toHaveLength(1);

  const payloadFromStoredTransitions = (worker as any).buildManualLiveUpdatePayload(
    {
      eventId: "helper-event",
      time: baseKickoff,
      pendingResult: {
        homeScore: 2,
        awayScore: 1,
        requestedAt: baseKickoff.toISOString(),
      },
      liveTransitions: simulation.transitions,
      liveConfirmedReplayCursor: 1,
      liveSequence: 1,
      home: "Home",
      away: "Away",
    }
  );
  expect(payloadFromStoredTransitions.data.markets).toHaveLength(4);
  expect(payloadFromStoredTransitions.data.settlements).toHaveLength(4);
  expect(payloadFromStoredTransitions.data.incidents).toHaveLength(2);

  const payloadWithoutMarkets = (worker as any).buildManualLiveUpdatePayload({
    eventId: "empty-event",
    time: baseKickoff.valueOf(),
    pendingResult: {
      homeScore: 0,
      awayScore: 0,
    },
    liveTransitions: [],
    liveConfirmedReplayCursor: 0,
    home: "Home",
    away: "Away",
  });
  expect(payloadWithoutMarkets.data.markets).toEqual([]);
  expect(payloadWithoutMarkets.data.settlements).toEqual([]);
  expect(payloadWithoutMarkets.data.occurredAt).toBe(clock.now().toISOString());
});

it("avoids duplicate scheduling and logs scheduled tick failures", async () => {
  const setTimeoutSpy = jest.fn().mockReturnValue(123);
  const clearTimeoutSpy = jest.fn();
  const clock: WorkerClock = {
    now: () => new Date(baseKickoff.getTime()),
    setTimeout: setTimeoutSpy,
    clearTimeout: clearTimeoutSpy,
  };
  const worker = new GamemasterWorker({ clock });

  (worker as any).scheduledTick = 77;
  worker.work();
  expect(setTimeoutSpy).not.toHaveBeenCalled();

  (worker as any).scheduledTick = undefined;
  (worker as any).running = true;
  (worker as any).stopped = false;
  worker.work();
  expect(setTimeoutSpy).not.toHaveBeenCalled();

  worker.stop();
  expect(clearTimeoutSpy).not.toHaveBeenCalled();

  const scheduleGuardWorker = new GamemasterWorker({ clock });
  (scheduleGuardWorker as any).stopped = true;
  (scheduleGuardWorker as any).scheduleNextTick(25);
  expect(setTimeoutSpy).not.toHaveBeenCalled();

  const runningWorker = new GamemasterWorker({ clock });
  const rescheduleSpy = jest
    .spyOn(runningWorker as any, "scheduleNextTick")
    .mockImplementation(() => undefined);
  (runningWorker as any).running = true;
  await (runningWorker as any).runScheduledTick();
  expect(rescheduleSpy).toHaveBeenCalledWith((runningWorker as any).cadenceMs);
  rescheduleSpy.mockRestore();

  const failingWorker = new GamemasterWorker({ clock });
  const failureScheduleSpy = jest
    .spyOn(failingWorker as any, "scheduleNextTick")
    .mockImplementation(() => undefined);
  jest
    .spyOn(failingWorker as any, "checkEventsOnce")
    .mockRejectedValue(new Error("boom"));
  const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

  await (failingWorker as any).runScheduledTick();

  expect(consoleSpy).toHaveBeenCalledWith(
    "Gamemaster tick failed",
    expect.any(Error)
  );
  expect((failingWorker as any).running).toBe(false);
  expect(failureScheduleSpy).toHaveBeenCalledWith(
    (failingWorker as any).cadenceMs
  );

  consoleSpy.mockRestore();
  failureScheduleSpy.mockRestore();
});

it("covers claim selection and persistence planning helper branches", async () => {
  const baseClock = createStaticClock(baseKickoff);
  const kickoffWorker = new GamemasterWorker({
    clock: baseClock,
    liveKickoffsEnabled: () => true,
  });
  const claimSpy = jest.spyOn(kickoffWorker as any, "claimEvent");

  claimSpy.mockResolvedValueOnce({ source: "manual" });
  await expect((kickoffWorker as any).claimNextEvent()).resolves.toEqual({
    source: "manual",
  });

  claimSpy.mockReset();
  claimSpy.mockResolvedValueOnce(null).mockResolvedValueOnce({ source: "replay" });
  await expect((kickoffWorker as any).claimNextEvent()).resolves.toEqual({
    source: "replay",
  });

  claimSpy.mockReset();
  claimSpy
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ source: "kickoff" });
  await expect((kickoffWorker as any).claimNextEvent()).resolves.toEqual({
    source: "kickoff",
  });
  claimSpy.mockRestore();

  const replayOnlyWorker = new GamemasterWorker({
    clock: baseClock,
    liveKickoffsEnabled: () => false,
  });
  const replayClaimSpy = jest
    .spyOn(replayOnlyWorker as any, "claimEvent")
    .mockResolvedValue(null);
  await expect((replayOnlyWorker as any).claimNextEvent()).resolves.toBeNull();
  expect(replayClaimSpy).toHaveBeenCalledTimes(2);
  replayClaimSpy.mockRestore();

  const defaultPlanWorker = new GamemasterWorker({ clock: baseClock });
  const cutoverSimulation = buildCutoverWindowSimulation("cutover-window");
  expect(
    (defaultPlanWorker as any).initialSimulationPersistencePlan(
      baseKickoff,
      cutoverSimulation
    )
  ).toEqual({ confirmedSequence: 0 });

  const noDueTransitionSimulation = buildDelayedSimulationResult("future-only");
  noDueTransitionSimulation.transitions = noDueTransitionSimulation.transitions.slice(1);
  const noDueWorker = new GamemasterWorker({
    clock: createStaticClock(new Date(baseKickoff.getTime() + 1000)),
  });
  expect(
    (noDueWorker as any).initialSimulationPersistencePlan(
      baseKickoff,
      noDueTransitionSimulation
    )
  ).toEqual({ confirmedSequence: 0 });

  const moderateOverdueWorker = new GamemasterWorker({
    clock: createStaticClock(new Date(baseKickoff.getTime() + 6 * 60 * 1000)),
  });
  expect(
    (moderateOverdueWorker as any).initialSimulationPersistencePlan(
      baseKickoff,
      cutoverSimulation
    )
  ).toEqual({ confirmedSequence: 2 });

  const cutoverWorker = new GamemasterWorker({
    clock: createStaticClock(new Date(baseKickoff.getTime() + 12 * 60 * 1000)),
  });
  const cutoverPlan = (cutoverWorker as any).initialSimulationPersistencePlan(
    baseKickoff,
    cutoverSimulation
  );
  expect(cutoverPlan.confirmedSequence).toBe(5);
  expect(cutoverPlan.liveEndedAt?.toISOString()).toBe(
    new Date(baseKickoff.getTime() + 12 * 60 * 1000).toISOString()
  );

  const simulation = buildSimulationResult("persisted-helper");
  const defaultPersistence = (defaultPlanWorker as any).simulationPersistenceUpdate(
    baseKickoff,
    {
      ...simulation,
      transitions: [],
    }
  );
  expect(defaultPersistence.phase).toBe(EventPhase.PRE_MATCH);
  expect(defaultPersistence.liveMarkets).toEqual([]);

  const fullTimePersistence = (defaultPlanWorker as any).simulationPersistenceUpdate(
    baseKickoff,
    simulation,
    5
  );
  expect(fullTimePersistence.liveEndedAt).toEqual(
    new Date(baseKickoff.getTime() + 2000)
  );

  const simulateSpy = jest.fn(() => simulation);
  const persistenceWorker = new GamemasterWorker({
    clock: baseClock,
    liveKickoffsEnabled: () => true,
    simulate: simulateSpy,
    createLiveSeed: () => "b".repeat(64),
  });

  const storedEvent = {
    liveTransitions: [simulation.transitions[0]],
    pendingResult: undefined,
  };
  await expect(
    (persistenceWorker as any).ensureSimulationPersisted(storedEvent)
  ).resolves.toBe(storedEvent);
  expect(simulateSpy).not.toHaveBeenCalled();

  const manualEvent = {
    liveTransitions: [],
    pendingResult: { source: LiveResultSource.MANUAL },
  };
  await expect(
    (persistenceWorker as any).ensureSimulationPersisted(manualEvent)
  ).resolves.toBe(manualEvent);

  const futureEvent = {
    eventId: "future-event",
    time: new Date(baseKickoff.getTime() + 1000),
    liveTransitions: [],
  };
  await expect(
    (persistenceWorker as any).ensureSimulationPersisted(futureEvent)
  ).resolves.toBe(futureEvent);

  const featureDisabledWorker = new GamemasterWorker({
    clock: baseClock,
    liveKickoffsEnabled: () => false,
    simulate: simulateSpy,
  });
  const dueEvent = {
    eventId: "disabled-event",
    time: baseKickoff,
    liveTransitions: [],
  };
  await expect(
    (featureDisabledWorker as any).ensureSimulationPersisted(dueEvent)
  ).resolves.toBe(dueEvent);

  const recoveringEvent = {
    _id: new mongoose.Types.ObjectId(),
    eventId: "recovering-event",
    time: baseKickoff,
    liveSeed: "a".repeat(64),
    processingLease: { token: "lease-token" },
    liveTransitions: [],
  };
  const findOneAndUpdateSpy = jest
    .spyOn(Event, "findOneAndUpdate")
    .mockResolvedValueOnce(null as any);
  const refreshSpy = jest
    .spyOn(persistenceWorker as any, "refreshClaimedEvent")
    .mockResolvedValue({ recovered: true });

  await expect(
    (persistenceWorker as any).ensureSimulationPersisted(recoveringEvent)
  ).resolves.toEqual({ recovered: true });
  expect(simulateSpy).toHaveBeenCalledWith({
    eventId: "recovering-event",
    seed: "a".repeat(64),
  });

  findOneAndUpdateSpy.mockRestore();
  refreshSpy.mockRestore();
});

it("covers due-transition, manual-result, and final-result fallback branches", async () => {
  const clock = createStaticClock(new Date(baseKickoff.getTime() + 5000));
  const worker = new GamemasterWorker({ clock });
  const refreshSpy = jest.spyOn(worker as any, "refreshClaimedEvent");

  refreshSpy.mockResolvedValueOnce(null);
  await expect(
    (worker as any).publishDueTransitions({
      _id: new mongoose.Types.ObjectId(),
      processingLease: { token: "lease" },
    })
  ).resolves.toBeNull();

  refreshSpy.mockReset();
  const manualPendingEvent = {
    _id: new mongoose.Types.ObjectId(),
    processingLease: { token: "lease" },
    pendingResult: { source: LiveResultSource.MANUAL },
  };
  refreshSpy.mockResolvedValueOnce(manualPendingEvent);
  await expect(
    (worker as any).publishDueTransitions(manualPendingEvent)
  ).resolves.toBe(manualPendingEvent);

  refreshSpy.mockReset();
  const exhaustedEvent = {
    _id: new mongoose.Types.ObjectId(),
    processingLease: { token: "lease" },
    liveTransitions: [],
    liveConfirmedReplayCursor: 0,
  };
  refreshSpy.mockResolvedValueOnce(exhaustedEvent);
  await expect(
    (worker as any).publishDueTransitions(exhaustedEvent)
  ).resolves.toBe(exhaustedEvent);

  refreshSpy.mockReset();
  const futureTransition = buildTransition(
    "future-transition",
    1,
    10000,
    EventPhase.FIRST_HALF,
    LiveIncidentType.KICK_OFF,
    marketSet(
      "future-transition",
      LiveMarketStatus.OPEN,
      LiveMarketStatus.OPEN
    ),
    { minute: 0 }
  );
  const futureReplayEvent = {
    _id: new mongoose.Types.ObjectId(),
    eventId: "future-transition",
    time: baseKickoff,
    liveStartedAt: baseKickoff,
    processingLease: { token: "lease" },
    liveTransitions: [futureTransition],
    liveConfirmedReplayCursor: 0,
  };
  refreshSpy.mockResolvedValueOnce(futureReplayEvent);
  await expect(
    (worker as any).publishDueTransitions(futureReplayEvent)
  ).resolves.toBe(futureReplayEvent);
  refreshSpy.mockRestore();

  const recoveryWorker = new GamemasterWorker({ clock });
  jest.spyOn(recoveryWorker as any, "init").mockResolvedValue(undefined);
  (recoveryWorker as any).liveEventUpdatePublisher = {
    publishWithConfirm: jest.fn().mockResolvedValue(undefined),
  };
  const dueTransitionEvent = {
    _id: new mongoose.Types.ObjectId(),
    eventId: "due-transition",
    time: baseKickoff,
    liveStartedAt: baseKickoff,
    processingLease: { token: "lease" },
    liveTransitions: [
      buildTransition(
        "due-transition",
        1,
        0,
        EventPhase.FIRST_HALF,
        LiveIncidentType.KICK_OFF,
        marketSet("due-transition", LiveMarketStatus.OPEN, LiveMarketStatus.OPEN),
        { minute: 0 }
      ),
    ],
    liveConfirmedReplayCursor: 0,
    liveSequence: 0,
    home: "Home",
    away: "Away",
  };
  const publishRefreshSpy = jest
    .spyOn(recoveryWorker as any, "refreshClaimedEvent")
    .mockResolvedValueOnce(dueTransitionEvent);
  const publishUpdateSpy = jest
    .spyOn(Event, "findOneAndUpdate")
    .mockResolvedValueOnce(null as any);
  const findByIdSpy = jest.spyOn(Event, "findById").mockResolvedValueOnce(null as any);

  await expect(
    (recoveryWorker as any).publishDueTransitions(dueTransitionEvent)
  ).resolves.toBeNull();
  expect(
    (recoveryWorker as any).liveEventUpdatePublisher.publishWithConfirm
  ).toHaveBeenCalledTimes(1);

  publishRefreshSpy.mockRestore();
  publishUpdateSpy.mockRestore();
  findByIdSpy.mockRestore();

  const publishedManualWorker = new GamemasterWorker({ clock });
  const archiveSpy = jest
    .spyOn(publishedManualWorker as any, "archiveAndDelete")
    .mockResolvedValue(undefined);
  await (publishedManualWorker as any).processManualResult({
    eventId: "published-manual",
    pendingResult: {
      source: LiveResultSource.MANUAL,
      publishedSequence: 2,
      publishedAt: baseKickoff,
    },
    liveMarkets: [],
  });
  expect(archiveSpy).toHaveBeenCalled();
  archiveSpy.mockRestore();

  const unpublishedManualWorker = new GamemasterWorker({ clock });
  jest.spyOn(unpublishedManualWorker as any, "init").mockResolvedValue(undefined);
  (unpublishedManualWorker as any).liveEventUpdatePublisher = {
    publishWithConfirm: jest.fn().mockResolvedValue(undefined),
  };
  const unpublishedArchiveSpy = jest
    .spyOn(unpublishedManualWorker as any, "archiveAndDelete")
    .mockResolvedValue(undefined);
  const manualUpdateSpy = jest
    .spyOn(Event, "findOneAndUpdate")
    .mockResolvedValueOnce(null as any);

  await (unpublishedManualWorker as any).processManualResult({
    _id: new mongoose.Types.ObjectId(),
    eventId: "unpublished-manual",
    time: baseKickoff.valueOf(),
    pendingResult: {
      source: LiveResultSource.MANUAL,
      homeScore: 4,
      awayScore: 2,
    },
    home: "Home",
    away: "Away",
    processingLease: { token: "lease" },
    liveTransitions: [],
    liveConfirmedReplayCursor: 0,
  });
  expect(unpublishedArchiveSpy).not.toHaveBeenCalled();

  manualUpdateSpy.mockRestore();
  unpublishedArchiveSpy.mockRestore();

  const finalWorker = new GamemasterWorker({ clock });
  (finalWorker as any).resultSetPublisher = {
    publishWithConfirm: jest.fn().mockResolvedValue(undefined),
  };
  await (finalWorker as any).publishFinalResultAndArchive({
    pendingResult: { source: LiveResultSource.MANUAL },
  });
  expect(
    (finalWorker as any).resultSetPublisher.publishWithConfirm
  ).not.toHaveBeenCalled();

  const fallbackFinalWorker = new GamemasterWorker({ clock });
  jest.spyOn(fallbackFinalWorker as any, "init").mockResolvedValue(undefined);
  (fallbackFinalWorker as any).resultSetPublisher = {
    publishWithConfirm: jest.fn().mockResolvedValue(undefined),
  };
  const processManualSpy = jest
    .spyOn(fallbackFinalWorker as any, "processManualResult")
    .mockResolvedValue(undefined);
  const finalUpdateSpy = jest
    .spyOn(Event, "findOneAndUpdate")
    .mockResolvedValueOnce(null as any);
  const finalRefreshSpy = jest
    .spyOn(fallbackFinalWorker as any, "refreshClaimedEvent")
    .mockResolvedValue({
      pendingResult: { source: LiveResultSource.MANUAL },
    });

  await (fallbackFinalWorker as any).publishFinalResultAndArchive({
    _id: new mongoose.Types.ObjectId(),
    eventId: "fallback-final",
    time: baseKickoff,
    home: "Home",
    away: "Away",
    processingLease: { token: "lease" },
    liveTransitions: [],
    liveHomeScore: 2,
    liveAwayScore: 1,
  });
  expect(
    (fallbackFinalWorker as any).resultSetPublisher.publishWithConfirm
  ).toHaveBeenCalledTimes(1);
  expect(processManualSpy).toHaveBeenCalled();

  finalUpdateSpy.mockRestore();
  finalRefreshSpy.mockRestore();
  processManualSpy.mockRestore();

  const archivedFinalWorker = new GamemasterWorker({ clock });
  const finalArchiveSpy = jest
    .spyOn(archivedFinalWorker as any, "archiveAndDelete")
    .mockResolvedValue(undefined);

  await (archivedFinalWorker as any).publishFinalResultAndArchive({
    eventId: "archived-final",
    time: baseKickoff.toISOString(),
    home: "Home",
    away: "Away",
    resultPublishedAt: baseKickoff.toISOString(),
    liveHomeScore: 6,
    liveAwayScore: 4,
    liveTransitions: [],
    liveConfirmedReplayCursor: 0,
    liveSequence: 0,
  });

  expect(finalArchiveSpy).toHaveBeenCalledWith(
    expect.objectContaining({ eventId: "archived-final" }),
    expect.objectContaining({
      liveEndedAt: null,
      homeResult: 6,
      awayResult: 4,
    })
  );

  finalArchiveSpy.mockRestore();
});
