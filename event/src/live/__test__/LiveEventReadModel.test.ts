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
              label: "Home scoreline",
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

type LiveUpdateIncident = NonNullable<ILiveEventUpdateEvent["data"]["incident"]>;
type LiveEventUpdateData = ILiveEventUpdateEvent["data"] & {
  incidents?: LiveUpdateIncident[];
  incidentsComplete?: boolean;
};

const buildIncident = (
  sequence: number,
  overrides: Partial<LiveUpdateIncident> = {}
): LiveUpdateIncident => ({
  id: `incident-${sequence}`,
  type: LiveIncidentType.GOAL,
  side: TeamSide.HOME,
  occurredAt: new Date(Date.UTC(2030, 0, 1, 12, sequence, 0)).toISOString(),
  minute: sequence,
  ...overrides,
});

const buildIncidentsThrough = (
  sequence: number
): NonNullable<LiveEventUpdateData["incidents"]> =>
  Array.from({ length: sequence }, (_, index) => buildIncident(index + 1));

const buildLiveUpdate = (
  sequence: number,
  overrides: Partial<LiveEventUpdateData> = {}
): ILiveEventUpdateEvent => ({
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
      buildIncident(1, {
        relatedIncidentId: "incident-0",
        addedTime: 1,
        occurredAt: "2030-01-01T12:03:00.000Z",
        minute: 3,
      }),
      buildIncident(2, {
        type: LiveIncidentType.YELLOW_CARD,
        side: TeamSide.AWAY,
        occurredAt: "2030-01-01T12:08:00.000Z",
        minute: 8,
      }),
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
    ...overrides,
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
              label: "Home scoreline",
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

it("sorts numeric correct-score tuples while preserving malformed legacy board order", () => {
  const rawEventDocument = buildRawEventDocument();
  rawEventDocument.products = [
    {
      id: "correct-score-valid",
      type: "CS",
      name: "Correct Score",
      internalProductFlag: true,
      odds: [
        { id: "cs-2-1", name: "2 - 1", value: 9.2, internalProbability: 0.12 },
        { id: "cs-0-0", name: "0 - 0", value: 6.4, internalProbability: 0.15 },
        { id: "cs-1-0", name: "1 - 0", value: 7.1, internalProbability: 0.14 },
      ],
    },
    {
      id: "correct-score-malformed",
      type: "CS",
      name: "Correct Score",
      internalProductFlag: true,
      odds: [
        { id: "keep-1", name: "1 - 0", value: 7.1, internalProbability: 0.14 },
        { id: "keep-2", name: "legacy", value: 99, internalProbability: 0.01 },
        { id: "keep-3", name: "0 - 0", value: 6.4, internalProbability: 0.15 },
      ],
    },
  ];

  const snapshot = createPublicEventSnapshot(
    rawEventDocument as Record<string, unknown>
  );

  expect(snapshot.products[0].odds).toEqual([
    { id: "cs-0-0", name: "0 - 0", value: 6.4 },
    { id: "cs-1-0", name: "1 - 0", value: 7.1 },
    { id: "cs-2-1", name: "2 - 1", value: 9.2 },
  ]);
  expect(snapshot.products[1].odds).toEqual([
    { id: "keep-1", name: "1 - 0", value: 7.1 },
    { id: "keep-2", name: "legacy", value: 99 },
    { id: "keep-3", name: "0 - 0", value: 6.4 },
  ]);
});

it("preserves full-time completeness across live-update construction, public cloning, and stored snapshot normalization", async () => {
  const completeSnapshot = createPublicEventSnapshotFromLiveUpdate(
    buildLiveUpdate(80, {
      eventId: "full-time-complete",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 4,
      awayScore: 2,
      bettingStatus: BettingStatus.CLOSED,
      incidents: buildIncidentsThrough(80),
      incidentsComplete: true,
      markets: [],
    })
  );

  expect(completeSnapshot.live?.incidentHistory).toHaveLength(80);
  expect(completeSnapshot.live?.incidentHistoryComplete).toBe(true);
  expect(
    sanitizePublicEventSnapshot(completeSnapshot as unknown as Record<string, unknown>)
  ).toEqual(completeSnapshot);

  await Event.create({
    eventId: "stored-full-time-truncated",
    name: "Stored Full Time Truncated",
    time: new Date("2030-01-01T12:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 180,
      occurredAt: "2030-01-01T13:45:00.000Z",
      kickoffAt: "2030-01-01T12:00:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 4,
      awayScore: 2,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: buildIncidentsThrough(260),
      incidentHistoryComplete: true,
      currentMarkets: [],
    },
  });

  const storedSnapshot = await getStoredPublicEventSnapshot(
    "stored-full-time-truncated"
  );
  expect(storedSnapshot?.live?.incidentHistory).toHaveLength(256);
  expect(storedSnapshot?.live?.incidentHistoryComplete).toBeUndefined();
});

it("keeps nonterminal, unattested, malformed, and legacy full-time updates incomplete", () => {
  const nonTerminalSnapshot = createPublicEventSnapshotFromLiveUpdate(
    buildLiveUpdate(40, {
      eventId: "nonterminal-attested",
      incidents: buildIncidentsThrough(40),
      incidentsComplete: true,
    })
  );
  const unattestedSnapshot = createPublicEventSnapshotFromLiveUpdate(
    buildLiveUpdate(41, {
      eventId: "full-time-unattested",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      incidents: buildIncidentsThrough(41),
      markets: [],
    })
  );
  const malformedSnapshot = createPublicEventSnapshotFromLiveUpdate(
    buildLiveUpdate(42, {
      eventId: "full-time-malformed",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      incidents: [
        ...buildIncidentsThrough(2),
        { id: "broken-incident" } as unknown as LiveUpdateIncident,
      ],
      incidentsComplete: true,
      markets: [],
    })
  );
  const legacySnapshot = createPublicEventSnapshotFromLiveUpdate(
    buildLiveUpdate(43, {
      eventId: "full-time-legacy-single",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      incidents: undefined,
      incident: buildIncident(43, {
        type: LiveIncidentType.YELLOW_CARD,
        side: TeamSide.AWAY,
      }),
      markets: [],
    })
  );

  expect(nonTerminalSnapshot.live?.incidentHistoryComplete).toBeUndefined();
  expect(unattestedSnapshot.live?.incidentHistoryComplete).toBeUndefined();
  expect(malformedSnapshot.live?.incidentHistoryComplete).toBeUndefined();
  expect(legacySnapshot.live?.incidentHistoryComplete).toBeUndefined();
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
    visibility: EventVisibility.OFFLINE,
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
    .mockResolvedValueOnce({ modifiedCount: 1 } as any);
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

const buildPreMatchLiveUpdate = (
  eventId: string,
  kickoffAt: string
): ILiveEventUpdateEvent =>
  ({
    timestamp: new Date().toISOString(),
    data: {
      eventId,
      sequence: 0,
      occurredAt: kickoffAt,
      kickoffAt,
      minute: 0,
      phase: EventPhase.PRE_MATCH,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidents: [],
      markets: [],
      settlements: [],
      home: "Team C",
      away: "Team D",
    },
  } as unknown as ILiveEventUpdateEvent);

it("retires a previously retained finished live event once a different event's T-10 PRE_MATCH snapshot becomes authoritative", async () => {
  await Event.create({
    eventId: "retained-full-time",
    name: "Finished Live Match",
    time: new Date("2030-01-01T10:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 40,
      occurredAt: "2030-01-01T11:45:00.000Z",
      kickoffAt: "2030-01-01T10:00:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 3,
      awayScore: 1,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  // Represents the normal onboarding pipeline (scheduler/backoffice)
  // creating the upcoming event as ONLINE well before its own T-10
  // countdown starts populating `live`.
  const kickoffAt = "2030-01-01T14:00:00.000Z";
  await Event.create({
    eventId: "next-event",
    name: "Next Event",
    time: new Date(kickoffAt),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });

  await applyLiveEventUpdate(buildPreMatchLiveUpdate("next-event", kickoffAt));

  const retired = await Event.findOne({ eventId: "retained-full-time" }).lean();
  expect(retired?.visibility).toEqual(EventVisibility.OFFLINE);

  const next = await Event.findOne({ eventId: "next-event" }).lean();
  expect(next?.visibility).toEqual(EventVisibility.ONLINE);
  expect((next?.live as any)?.phase).toEqual(EventPhase.PRE_MATCH);
});

it("does not retire an event's own retained full-time snapshot when its PRE_MATCH update is replayed after a restart", async () => {
  const kickoffAt = "2030-01-01T14:00:00.000Z";
  await Event.create({
    eventId: "self-event",
    name: "Self Event",
    time: new Date(kickoffAt),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 40,
      occurredAt: "2030-01-01T13:45:00.000Z",
      kickoffAt,
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 1,
      awayScore: 1,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  // A restart replaying this event's own opening PRE_MATCH snapshot (e.g.
  // sequence renumbered from 0) must never retire the event's own
  // retained full-time record; the handoff only ever targets *other*
  // events.
  await applyLiveEventUpdate(buildPreMatchLiveUpdate("self-event", kickoffAt));

  const stillRetained = await Event.findOne({ eventId: "self-event" }).lean();
  expect(stillRetained?.visibility).toEqual(EventVisibility.ONLINE);
});

it("bounds retention to one by clearing every stale retained full-time event on the next PRE_MATCH handoff", async () => {
  await Event.create({
    eventId: "stale-a",
    name: "Stale A",
    time: new Date("2030-01-01T09:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 40,
      occurredAt: "2030-01-01T10:45:00.000Z",
      kickoffAt: "2030-01-01T09:00:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 2,
      awayScore: 2,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });
  await Event.create({
    eventId: "stale-b",
    name: "Stale B",
    time: new Date("2030-01-01T09:30:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 40,
      occurredAt: "2030-01-01T11:15:00.000Z",
      kickoffAt: "2030-01-01T09:30:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate("newest-event", "2030-01-01T14:00:00.000Z")
  );

  const staleA = await Event.findOne({ eventId: "stale-a" }).lean();
  const staleB = await Event.findOne({ eventId: "stale-b" }).lean();
  expect(staleA?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(staleB?.visibility).toEqual(EventVisibility.OFFLINE);
});

it("keeps the retained full-time event visible to listPublicEvents purely from persisted state (restart/refresh safety)", async () => {
  await Event.create({
    eventId: "retained-persisted",
    name: "Retained Persisted",
    time: new Date("2030-01-01T10:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 40,
      occurredAt: "2030-01-01T11:45:00.000Z",
      kickoffAt: "2030-01-01T10:00:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 1,
      awayScore: 0,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  // No in-memory hub/cache is involved here: listPublicEvents reads
  // straight from Mongo, so this proves the retention survives a
  // simulated process restart/refresh.
  const listed = await listPublicEvents(new Date("2030-01-01T10:05:00.000Z"));
  expect(listed.map((entry) => entry.eventId)).toContain("retained-persisted");

  // Normal onboarding already created the upcoming event as ONLINE before
  // its T-10 countdown starts populating `live`.
  await Event.create({
    eventId: "handoff-event",
    name: "Handoff Event",
    time: new Date("2030-01-01T14:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });

  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate("handoff-event", "2030-01-01T14:00:00.000Z")
  );

  const listedAfterHandoff = await listPublicEvents(
    new Date("2030-01-01T10:05:00.000Z")
  );
  expect(listedAfterHandoff.map((entry) => entry.eventId)).not.toContain(
    "retained-persisted"
  );
  expect(listedAfterHandoff.map((entry) => entry.eventId)).toContain(
    "handoff-event"
  );
});
