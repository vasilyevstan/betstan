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
  createPublicEventSnapshot,
  createPublicEventSnapshotFromLiveUpdate,
} from "../LiveEventReadModel";

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
