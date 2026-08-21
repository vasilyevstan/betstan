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
import { GamemasterWorker, WorkerClock } from "../GamemasterWorker";

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
  (
    ResultSetPublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mockResolvedValue(undefined);
  (
    LiveEventUpdatePublisher.prototype.publishWithConfirm as unknown as jest.Mock
  ).mockResolvedValue(undefined);
});

const baseKickoff = new Date("2025-01-01T12:00:00.000Z");

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

  const firstWorker = new GamemasterWorker({ clock: firstClock, simulate });
  await firstWorker.checkEventsOnce();

  const afterKickoff = await Event.findOne({ eventId: event.eventId });
  expect(simulate).toHaveBeenCalledTimes(1);
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
