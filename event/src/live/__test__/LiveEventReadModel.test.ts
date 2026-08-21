import mongoose from "mongoose";
import {
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
  ILiveEventUpdateEvent,
  LiveIncidentType,
  LiveMarketStatus,
  LiveMarketType,
  TeamSide,
} from "@betstan/common";
import {
  applyLiveEventUpdate,
  createPublicEventSnapshot,
  createPublicEventSnapshotFromLiveUpdate,
  getStoredPublicEventSnapshot,
  listPublicEvents,
  sanitizePublicEventSnapshot,
} from "../LiveEventReadModel";
import { Event } from "../../model/Event";

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const buildRawEventDocument = () => {
  const eventTime = new Date("2030-01-01T12:00:00.000Z");
  const occurredAt = "2030-01-01T12:07:00.000Z";
  const quoteValidUntil = "2030-01-01T12:12:00.000Z";

  return {
    _id: new mongoose.Types.ObjectId(),
    eventId: "event-id",
    name: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    time: eventTime,
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [
      {
        id: "product-1",
        type: "1X2",
        name: "1X2",
        odds: [
          {
            id: "odds-1",
            name: "Home",
            value: 1.5,
            internalProbability: 0.91,
          },
        ],
        internalProductFlag: true,
      },
    ],
    source: "SCHEDULER",
    slotKey: "slot-1",
    newEventPublishedAt: new Date("2030-01-01T12:01:00.000Z"),
    newEventPublishAttempts: 7,
    newEventPublishClaimedAt: new Date("2030-01-01T12:02:00.000Z"),
    newEventPublishClaimToken: "claim-token",
    leaseToken: "lease-token",
    __v: 99,
    futureContractField: "hide-me",
    internalError: { message: "hidden" },
    live: {
      sequence: 7,
      occurredAt,
      kickoffAt: eventTime.toISOString(),
      minute: 32,
      addedTime: 2,
      phase: EventPhase.FIRST_HALF,
      homeScore: 1,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [
        {
          id: "incident-1",
          relatedIncidentId: "incident-0",
          type: LiveIncidentType.GOAL,
          side: TeamSide.HOME,
          occurredAt: "2030-01-01T12:03:00.000Z",
          minute: 3,
          addedTime: 1,
          internalReason: "hidden",
        },
      ],
      currentMarkets: [
        {
          marketId: "market-1",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 2,
          quoteVersion: 4,
          quoteValidUntil,
          status: LiveMarketStatus.OPEN,
          selections: [
            {
              selectionId: "home",
              side: TeamSide.HOME,
              odds: 1.8,
              traderLimit: 10,
            },
          ],
          internalTraderState: "hidden",
        },
      ],
      internalLiveState: true,
    },
  };
};

const buildLiveUpdate = (sequence: number): ILiveEventUpdateEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    eventId: "event-id",
    sequence,
    occurredAt: "2030-01-01T12:09:00.000Z",
    kickoffAt: "2030-01-01T12:00:00.000Z",
    minute: 34,
    addedTime: 3,
    phase: EventPhase.FIRST_HALF_STOPPAGE,
    homeScore: 2,
    awayScore: 0,
    bettingStatus: BettingStatus.OPEN,
    incidents: [
      {
        id: "incident-1",
        relatedIncidentId: "incident-0",
        type: LiveIncidentType.GOAL,
        side: TeamSide.HOME,
        occurredAt: "2030-01-01T12:03:00.000Z",
        minute: 3,
        addedTime: 1,
      },
      {
        id: "incident-2",
        type: LiveIncidentType.YELLOW_CARD,
        side: TeamSide.AWAY,
        occurredAt: "2030-01-01T12:08:00.000Z",
        minute: 8,
      },
    ],
    markets: [
      {
        marketId: "market-2",
        marketType: LiveMarketType.NEXT_YELLOW_CARD,
        marketVersion: 3,
        quoteVersion: 5,
        quoteValidUntil: "2030-01-01T12:14:00.000Z",
        status: LiveMarketStatus.OPEN,
        selections: [
          {
            selectionId: "away",
            side: TeamSide.AWAY,
            odds: 2.2,
          },
        ],
      },
    ],
    settlements: [],
    eventName: "Team A - Team B",
    home: "Team A",
    away: "Team B",
  },
} as unknown as ILiveEventUpdateEvent);

it("creates immutable public snapshots without mutating source documents", () => {
  const rawEventDocument = buildRawEventDocument();
  const before = JSON.parse(JSON.stringify(rawEventDocument));

  const snapshot = createPublicEventSnapshot(
    rawEventDocument as Record<string, unknown>
  );

  expect(JSON.parse(JSON.stringify(rawEventDocument))).toEqual(before);
  expect(snapshot).toEqual({
    _id: rawEventDocument._id.toHexString(),
    id: "event-id",
    eventId: "event-id",
    name: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    time: "2030-01-01T12:00:00.000Z",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [
      {
        id: "product-1",
        type: "1X2",
        name: "1X2",
        odds: [
          {
            id: "odds-1",
            name: "Home",
            value: 1.5,
          },
        ],
      },
    ],
    live: {
      sequence: 7,
      minute: 32,
      addedTime: 2,
      phase: EventPhase.FIRST_HALF,
      homeScore: 1,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [
        {
          id: "incident-1",
          relatedIncidentId: "incident-0",
          type: LiveIncidentType.GOAL,
          side: TeamSide.HOME,
          occurredAt: "2030-01-01T12:03:00.000Z",
          minute: 3,
          addedTime: 1,
        },
      ],
      currentMarkets: [
        {
          marketId: "market-1",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 2,
          quoteVersion: 4,
          quoteValidUntil: "2030-01-01T12:12:00.000Z",
          status: LiveMarketStatus.OPEN,
          selections: [
            {
              selectionId: "home",
              side: TeamSide.HOME,
              odds: 1.8,
            },
          ],
        },
      ],
    },
  });
  expect(Object.isFrozen(snapshot)).toEqual(true);
  expect(Object.isFrozen(snapshot.products)).toEqual(true);
  expect(Object.isFrozen(snapshot.products[0])).toEqual(true);
  expect(Object.isFrozen(snapshot.live!)).toEqual(true);
  expect(Object.isFrozen(snapshot.live!.incidentHistory)).toEqual(true);
  expect(Object.isFrozen(snapshot.live!.incidentHistory[0])).toEqual(true);
  expect(Object.isFrozen(snapshot.live!.currentMarkets)).toEqual(true);
  expect(Object.isFrozen(snapshot.live!.currentMarkets[0])).toEqual(true);
  expect(
    Object.isFrozen(snapshot.live!.currentMarkets[0].selections[0])
  ).toEqual(true);
});

it("builds higher-sequence live snapshots without mutating the seed snapshot or leaking extra fields", () => {
  const seedSnapshot = createPublicEventSnapshot(
    buildRawEventDocument() as Record<string, unknown>
  );
  const seedBefore = JSON.parse(JSON.stringify(seedSnapshot));

  const nextSnapshot = createPublicEventSnapshotFromLiveUpdate(
    buildLiveUpdate(8),
    seedSnapshot
  );

  expect(seedSnapshot).toEqual(seedBefore);
  expect(nextSnapshot).not.toBe(seedSnapshot);
  expect(nextSnapshot).toEqual({
    _id: seedSnapshot._id,
    id: "event-id",
    eventId: "event-id",
    name: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    time: "2030-01-01T12:00:00.000Z",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [
      {
        id: "product-1",
        type: "1X2",
        name: "1X2",
        odds: [
          {
            id: "odds-1",
            name: "Home",
            value: 1.5,
          },
        ],
      },
    ],
    live: {
      sequence: 8,
      minute: 34,
      addedTime: 3,
      phase: EventPhase.FIRST_HALF_STOPPAGE,
      homeScore: 2,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [
        {
          id: "incident-1",
          relatedIncidentId: "incident-0",
          type: LiveIncidentType.GOAL,
          side: TeamSide.HOME,
          occurredAt: "2030-01-01T12:03:00.000Z",
          minute: 3,
          addedTime: 1,
        },
        {
          id: "incident-2",
          type: LiveIncidentType.YELLOW_CARD,
          side: TeamSide.AWAY,
          occurredAt: "2030-01-01T12:08:00.000Z",
          minute: 8,
        },
      ],
      currentMarkets: [
        {
          marketId: "market-2",
          marketType: LiveMarketType.NEXT_YELLOW_CARD,
          marketVersion: 3,
          quoteVersion: 5,
          quoteValidUntil: "2030-01-01T12:14:00.000Z",
          status: LiveMarketStatus.OPEN,
          selections: [
            {
              selectionId: "away",
              side: TeamSide.AWAY,
              odds: 2.2,
            },
          ],
        },
      ],
    },
  });
  expect(Object.isFrozen(nextSnapshot)).toEqual(true);
  expect(nextSnapshot.live).not.toHaveProperty("occurredAt");
  expect(nextSnapshot.live).not.toHaveProperty("kickoffAt");
});

it("sanitizes sparse legacy documents and keeps malformed fields within the public contract", () => {
  const rawEventDocument = {
    _id: new mongoose.Types.ObjectId(),
    id: 42,
    name: 99,
    time: "not-a-date",
    home: false,
    away: { toString: () => "Away FC" },
    products: [
      {
        id: 7,
        type: true,
        name: false,
        odds: [{ id: 1, name: 2, value: "2.5" }],
      },
    ],
    live: {
      sequence: 1,
      phase: EventPhase.PRE_MATCH,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [{ type: LiveIncidentType.CORNER }],
      currentMarkets: [
        {
          marketId: "market-1",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 1,
          quoteVersion: 2,
          quoteValidUntil: "not-a-date",
          status: LiveMarketStatus.OPEN,
          selections: [
            { selectionId: "", side: TeamSide.AWAY, odds: 4.2 },
            { selectionId: "home", side: TeamSide.HOME, odds: 1.2 },
          ],
        },
      ],
    },
  };

  expect(
    sanitizePublicEventSnapshot(rawEventDocument as Record<string, unknown>)
  ).toEqual({
    _id: rawEventDocument._id.toHexString(),
    id: "42",
    eventId: "42",
    name: "99",
    time: "not-a-date",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    home: "false",
    away: "Away FC",
    products: [
      {
        id: "7",
        type: "true",
        name: "false",
        odds: [
          {
            id: "1",
            name: "2",
            value: 2.5,
          },
        ],
      },
    ],
    live: {
      sequence: 1,
      minute: 0,
      phase: EventPhase.PRE_MATCH,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [{ type: LiveIncidentType.CORNER }],
      currentMarkets: [
        {
          marketId: "market-1",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 1,
          quoteVersion: 2,
          quoteValidUntil: "not-a-date",
          status: LiveMarketStatus.OPEN,
          selections: [
            {
              selectionId: "home",
              side: TeamSide.HOME,
              odds: 1.2,
            },
          ],
        },
      ],
    },
  });
});

it("returns the seed snapshot unchanged for duplicate or stale live sequences", () => {
  const seedSnapshot = createPublicEventSnapshot(
    buildRawEventDocument() as Record<string, unknown>
  );

  expect(createPublicEventSnapshotFromLiveUpdate(buildLiveUpdate(7), seedSnapshot)).toBe(
    seedSnapshot
  );
  expect(createPublicEventSnapshotFromLiveUpdate(buildLiveUpdate(6), seedSnapshot)).toBe(
    seedSnapshot
  );
});

it("builds sparse live updates with defaults, deduplicated incidents, and filtered markets", () => {
  jest.useFakeTimers().setSystemTime(new Date("2030-02-01T00:00:00.000Z"));

  const sparseSnapshot = createPublicEventSnapshotFromLiveUpdate(
    {
      data: {
        eventId: "generated-event",
        sequence: 1,
        minute: 1,
        phase: EventPhase.PRE_MATCH,
        homeScore: 0,
        awayScore: 0,
        bettingStatus: BettingStatus.OPEN,
        incidents: [
          { type: LiveIncidentType.CORNER },
          { type: LiveIncidentType.CORNER },
          {
            id: "incident-2",
            type: LiveIncidentType.GOAL,
            side: TeamSide.HOME,
            occurredAt: "not-a-date",
            minute: 2,
            addedTime: 1,
          },
        ],
        markets: [
          {
            marketId: "",
            marketType: LiveMarketType.NEXT_CORNER,
            marketVersion: 1,
            quoteVersion: 1,
            status: LiveMarketStatus.OPEN,
            selections: [],
          },
          {
            marketId: "market-1",
            marketType: LiveMarketType.NEXT_CORNER,
            marketVersion: 1,
            quoteVersion: 1,
            quoteValidUntil: "bad-date",
            status: LiveMarketStatus.OPEN,
            selections: [
              { selectionId: "", side: TeamSide.AWAY, odds: 4.2 },
              { selectionId: "home", side: TeamSide.HOME, odds: 1.2 },
            ],
          },
        ],
        settlements: [],
        eventName: "   ",
      },
    } as any
  );

  expect(sparseSnapshot).toEqual({
    id: "generated-event",
    eventId: "generated-event",
    name: "generated-event",
    time: "2030-02-01T00:00:00.000Z",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 1,
      minute: 1,
      phase: EventPhase.PRE_MATCH,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [
        { type: LiveIncidentType.CORNER },
        {
          id: "incident-2",
          type: LiveIncidentType.GOAL,
          side: TeamSide.HOME,
          occurredAt: "not-a-date",
          minute: 2,
          addedTime: 1,
        },
      ],
      currentMarkets: [
        {
          marketId: "market-1",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 1,
          quoteVersion: 1,
          quoteValidUntil: "bad-date",
          status: LiveMarketStatus.OPEN,
          selections: [
            {
              selectionId: "home",
              side: TeamSide.HOME,
              odds: 1.2,
            },
          ],
        },
      ],
    },
  });
});

it("reads stored snapshots, sorts ties by event id, and applies single-incident updates to live-null events", async () => {
  const kickoffAt = "2030-01-01T12:00:00.000Z";
  const event = await Event.create({
    eventId: "legacy-live-null",
    name: "Legacy live null",
    home: "Team A",
    away: "Team B",
    time: new Date(kickoffAt),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: null,
  });

  const updatedSnapshot = await applyLiveEventUpdate({
    data: {
      eventId: event.eventId,
      sequence: 1,
      occurredAt: kickoffAt,
      kickoffAt,
      minute: 1,
      phase: EventPhase.PRE_MATCH,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incident: { type: LiveIncidentType.CORNER },
      markets: [],
      settlements: [],
      home: "Team A",
      away: "Team B",
    },
  } as any);

  expect(updatedSnapshot?.live?.incidentHistory).toEqual([
    { type: LiveIncidentType.CORNER },
  ]);
  expect(await getStoredPublicEventSnapshot(event.eventId)).toEqual(updatedSnapshot);
  expect(await getStoredPublicEventSnapshot("missing-event")).toBeUndefined();

  await Event.create({
    eventId: "alpha",
    name: "Alpha",
    time: new Date("2030-01-01T13:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });
  await Event.create({
    eventId: "beta",
    name: "Beta",
    time: new Date("2030-01-01T13:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });

  const listedEvents = await listPublicEvents(new Date("2030-01-01T12:30:00.000Z"));
  expect(listedEvents.map((listedEvent) => listedEvent.eventId)).toEqual([
    "legacy-live-null",
    "alpha",
    "beta",
  ]);
});

it("retries duplicate key races and handles mismatch, missing document, and non-duplicate failures", async () => {
  const liveUpdate = buildLiveUpdate(9);
  const updateOneSpy = jest.spyOn(Event, "updateOne");
  const findOneSpy = jest.spyOn(Event, "findOne");

  updateOneSpy
    .mockResolvedValueOnce({} as any)
    .mockRejectedValueOnce({ code: 11000 } as any)
    .mockResolvedValueOnce({} as any);
  findOneSpy.mockReturnValueOnce({
    lean: jest.fn().mockResolvedValue({
      eventId: "event-id",
      name: "Recovered",
      time: "2030-01-01T12:00:00.000Z",
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        sequence: 9,
        minute: 34,
        phase: EventPhase.FIRST_HALF_STOPPAGE,
        homeScore: 2,
        awayScore: 0,
        bettingStatus: BettingStatus.OPEN,
        incidentHistory: [],
        currentMarkets: [],
      },
    }),
  } as any);

  expect(await applyLiveEventUpdate(liveUpdate)).toEqual({
    id: "event-id",
    eventId: "event-id",
    name: "Recovered",
    time: "2030-01-01T12:00:00.000Z",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 9,
      minute: 34,
      phase: EventPhase.FIRST_HALF_STOPPAGE,
      homeScore: 2,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  updateOneSpy.mockReset();
  findOneSpy.mockReset();

  updateOneSpy.mockResolvedValueOnce({} as any).mockResolvedValueOnce({} as any);
  findOneSpy.mockReturnValueOnce({
    lean: jest.fn().mockResolvedValue({
      eventId: "event-id",
      name: "Mismatch",
      time: "2030-01-01T12:00:00.000Z",
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        sequence: 8,
        minute: 34,
        phase: EventPhase.FIRST_HALF_STOPPAGE,
        homeScore: 2,
        awayScore: 0,
        bettingStatus: BettingStatus.OPEN,
        incidentHistory: [],
        currentMarkets: [],
      },
    }),
  } as any);
  await expect(applyLiveEventUpdate(liveUpdate)).resolves.toBeNull();

  updateOneSpy.mockReset();
  findOneSpy.mockReset();

  updateOneSpy.mockResolvedValueOnce({} as any).mockResolvedValueOnce({} as any);
  findOneSpy.mockReturnValueOnce({
    lean: jest.fn().mockResolvedValue(null),
  } as any);
  await expect(applyLiveEventUpdate(liveUpdate)).resolves.toBeNull();

  updateOneSpy.mockReset();
  updateOneSpy
    .mockResolvedValueOnce({} as any)
    .mockRejectedValueOnce({ code: 500 } as any);
  await expect(applyLiveEventUpdate(liveUpdate)).rejects.toMatchObject({
    code: 500,
  });
});
