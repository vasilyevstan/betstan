import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import {
  BetKind,
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
  LiveMarketStatus,
  LiveMarketType,
  TeamSide,
} from "@betstan/common";
import EventOddsSelectedPublisher from "../../messaging/publisher/EventOddsSelectedPublisher";

const createPreMatchEvent = async (time = new Date(Date.now() + 60 * 60 * 1000)) => {
  return Event.create({
    eventId: "test-event-id",
    name: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    time,
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [
      {
        id: "product-1",
        type: "1X2",
        name: "1X2",
        odds: [
          { id: "odds-1", name: "Team A", value: 1.5 },
          { id: "odds-2", name: "draw", value: 3.0 },
          { id: "odds-3", name: "Team B", value: 2.5 },
        ],
      },
    ],
  });
};

const createLiveEvent = async (
  overrides: Partial<Record<string, unknown>> = {}
) => {
  const now = Date.now();
  return Event.create({
    eventId: "test-event-id",
    name: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    time: new Date(now - 30 * 60 * 1000),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 12,
      occurredAt: new Date(now - 60 * 1000).toISOString(),
      kickoffAt: new Date(now - 30 * 60 * 1000).toISOString(),
      minute: 30,
      phase: EventPhase.FIRST_HALF,
      homeScore: 1,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [],
      currentMarkets: [
        {
          marketId: "market-1",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 2,
          quoteVersion: 4,
          status: LiveMarketStatus.OPEN,
          selections: [
            { selectionId: "home", side: TeamSide.HOME, odds: 1.8 },
            { selectionId: "away", side: TeamSide.AWAY, odds: 2.1 },
          ],
        },
      ],
      ...overrides,
    },
  });
};

const preMatchProducts = [
  {
    id: "product-1",
    type: "1X2",
    name: "1X2",
    odds: [
      { id: "odds-1", name: "Team A", value: 1.5 },
      { id: "odds-2", name: "draw", value: 3.0 },
      { id: "odds-3", name: "Team B", value: 2.5 },
    ],
  },
];

it("publishes server-authoritative pre-match selections and ignores client kind/odds", async () => {
  const event = await createPreMatchEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      productId: "product-1",
      oddsId: "odds-1",
      betKind: BetKind.LIVE,
      oddsValue: 999,
      oddsName: "spoofed",
    })
    .expect(200);

  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenCalledTimes(1);
  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventId: "test-event-id",
      productId: "product-1",
      oddsId: "odds-1",
      oddsValue: 1.5,
      oddsName: "Team A",
      betKind: BetKind.PRE_MATCH,
      eventTime: event.time.toISOString(),
    }),
  });
});

it("returns 400 when event not found", async () => {
  await request(app)
    .post("/api/event/odds")
    .send({ eventId: "nonexistent", productId: "product-1", oddsId: "odds-1" })
    .expect(400);
});

it("returns 400 when eventId is missing", async () => {
  await request(app)
    .post("/api/event/odds")
    .send({ productId: "product-1", oddsId: "odds-1" })
    .expect(400);
});

it("rejects pre-match selections at or after kickoff", async () => {
  await createPreMatchEvent(new Date(Date.now() - 1000));

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      productId: "product-1",
      oddsId: "odds-1",
    })
    .expect(400);
});

it("rejects pre-match selections when product or odds fields are missing", async () => {
  await createPreMatchEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      productId: "product-1",
    })
    .expect(400);
});

it("rejects pre-match selections when the product does not exist", async () => {
  await createPreMatchEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      productId: "missing-product",
      oddsId: "odds-1",
    })
    .expect(400);
});

it("rejects pre-match selections when the odds do not exist", async () => {
  await createPreMatchEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      productId: "product-1",
      oddsId: "missing-odds",
    })
    .expect(400);
});

it("publishes normalized live selections with server-authoritative values", async () => {
  await createLiveEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "market-1",
      marketVersion: 2,
      quoteVersion: 4,
      selectionId: "home",
      productId: "spoofed-product",
      oddsId: "spoofed-odds",
      oddsValue: 999,
      betKind: BetKind.PRE_MATCH,
    })
    .expect(200);

  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenCalledTimes(1);
  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventId: "test-event-id",
      productId: "market-1",
      productName: "Next Corner",
      oddsId: "market-1:home",
      oddsName: "Team A",
      oddsValue: 1.8,
      betKind: BetKind.LIVE,
      marketId: "market-1",
      marketType: LiveMarketType.NEXT_CORNER,
      marketVersion: 2,
      quoteVersion: 4,
      selectionId: "home",
      side: TeamSide.HOME,
    }),
  });
});

it.each([
  [
    "pre-match phase",
    {
      phase: EventPhase.PRE_MATCH,
    },
  ],
  [
    "full-time phase",
    {
      phase: EventPhase.FULL_TIME,
    },
  ],
  [
    "suspended event betting status",
    {
      bettingStatus: BettingStatus.SUSPENDED,
    },
  ],
])("rejects live selections when the event is not open in %s", async (_label, liveOverrides) => {
  await createLiveEvent(liveOverrides);

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "market-1",
      marketVersion: 2,
      quoteVersion: 4,
      selectionId: "home",
    })
    .expect(400);
});

it("rejects live selections when the market is not open", async () => {
  await createLiveEvent({
    currentMarkets: [
      {
        marketId: "market-1",
        marketType: LiveMarketType.NEXT_CORNER,
        marketVersion: 2,
        quoteVersion: 4,
        status: LiveMarketStatus.SUSPENDED,
        selections: [{ selectionId: "home", side: TeamSide.HOME, odds: 1.8 }],
      },
    ],
  });

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "market-1",
      marketVersion: 2,
      quoteVersion: 4,
      selectionId: "home",
    })
    .expect(400);
});

it("rejects live selections when required live identifiers are missing", async () => {
  await createLiveEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "market-1",
      marketVersion: 2,
      selectionId: "home",
    })
    .expect(400);
});

it("rejects live selections when the event has no live state", async () => {
  await createPreMatchEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "market-1",
      marketVersion: 2,
      quoteVersion: 4,
      selectionId: "home",
    })
    .expect(400);
});

it("rejects live selections when the market does not exist", async () => {
  await createLiveEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "missing-market",
      marketVersion: 2,
      quoteVersion: 4,
      selectionId: "home",
    })
    .expect(400);
});

it("rejects live selections when the market version does not match", async () => {
  await createLiveEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "market-1",
      marketVersion: 3,
      quoteVersion: 4,
      selectionId: "home",
    })
    .expect(400);
});

it("rejects live selections when the quote version does not match", async () => {
  await createLiveEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "market-1",
      marketVersion: 2,
      quoteVersion: 5,
      selectionId: "home",
    })
    .expect(400);
});

it("rejects live selections when the server-side selection does not exist", async () => {
  await createLiveEvent();

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "market-1",
      marketVersion: 2,
      quoteVersion: 4,
      selectionId: "missing",
    })
    .expect(400);
});

it("accepts string live versions, away selections, and string event times", async () => {
  await Event.collection.insertOne({
    eventId: "string-live-event",
    name: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    time: "2030-01-01T12:00:00.000Z",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 4,
      occurredAt: "2030-01-01T12:05:00.000Z",
      kickoffAt: "2030-01-01T12:00:00.000Z",
      minute: 10,
      phase: EventPhase.FIRST_HALF,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [],
      currentMarkets: [
        {
          marketId: "market-1",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 2,
          quoteVersion: 4,
          status: LiveMarketStatus.OPEN,
          selections: [
            { selectionId: "away", side: TeamSide.AWAY, odds: 2.1 },
          ],
        },
      ],
    },
  });

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "string-live-event",
      marketId: "market-1",
      marketVersion: "2",
      quoteVersion: "4",
      selectionId: "away",
    })
    .expect(200);

  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventId: "string-live-event",
      oddsName: "Team B",
      eventTime: "2030-01-01T12:00:00.000Z",
      marketVersion: 2,
      quoteVersion: 4,
    }),
  });
});

it("falls back to stored kickoff time for pre-match eventTime when no event time exists", async () => {
  const kickoffAt = "2030-01-01T12:15:00.000Z";
  await Event.collection.insertOne({
    eventId: "kickoff-fallback-event",
    name: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: preMatchProducts,
    live: {
      sequence: 0,
      occurredAt: kickoffAt,
      kickoffAt,
      minute: 0,
      phase: EventPhase.PRE_MATCH,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "kickoff-fallback-event",
      productId: "product-1",
      oddsId: "odds-1",
    })
    .expect(200);

  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventId: "kickoff-fallback-event",
      eventTime: kickoffAt,
    }),
  });
});

it("uses public fallback labels for live selections when team names or mappings are missing", async () => {
  await Event.collection.insertOne({
    eventId: "label-fallback-event",
    name: "Fallback",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 3,
      occurredAt: "2030-01-01T12:04:00.000Z",
      kickoffAt: "2030-01-01T12:00:00.000Z",
      minute: 4,
      phase: EventPhase.FIRST_HALF,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [],
      currentMarkets: [
        {
          marketId: "market-home",
          marketType: LiveMarketType.NEXT_PENALTY,
          marketVersion: 1,
          quoteVersion: 1,
          status: LiveMarketStatus.OPEN,
          selections: [
            { selectionId: "home", side: TeamSide.HOME, odds: 1.1 },
          ],
        },
        {
          marketId: "market-draw",
          marketType: "CUSTOM_MARKET",
          marketVersion: 2,
          quoteVersion: 2,
          status: LiveMarketStatus.OPEN,
          selections: [
            { selectionId: "draw", side: TeamSide.DRAW, odds: 3.3 },
          ],
        },
      ],
    },
  });

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "label-fallback-event",
      marketId: "market-home",
      marketVersion: 1,
      quoteVersion: 1,
      selectionId: "home",
    })
    .expect(200);

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "label-fallback-event",
      marketId: "market-draw",
      marketVersion: 2,
      quoteVersion: 2,
      selectionId: "draw",
    })
    .expect(200);

  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenNthCalledWith(
    1,
    {
      data: expect.objectContaining({
        eventId: "label-fallback-event",
        oddsName: TeamSide.HOME,
        productName: "Next Penalty",
      }),
    }
  );
  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenNthCalledWith(
    2,
    {
      data: expect.objectContaining({
        eventId: "label-fallback-event",
        oddsName: "Draw",
        productName: "CUSTOM_MARKET",
        quoteValidUntil: undefined,
      }),
    }
  );
});
