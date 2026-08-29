import request from "supertest";
import jwt from "jsonwebtoken";
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
import { setAdminSessionVerifierForTests } from "../../service/VerifyAdminSession";

const buildSessionCookie = (role: "USER" | "ADMIN") => {
  const token = jwt.sign(
    {
      id: "user-id",
      email: "acceptance-admin",
      role,
      timestamp: new Date(),
    },
    process.env.JWT_KEY!
  );
  const session = Buffer.from(JSON.stringify({ jwt: token })).toString("base64");
  return [`session=${session}`];
};

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
          quoteValidUntil: new Date(now + 60 * 1000).toISOString(),
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

it("keeps offline acceptance events unavailable to non-admin users", async () => {
  const event = await createPreMatchEvent();
  event.visibility = EventVisibility.OFFLINE;
  await event.save();
  const selection = {
    eventId: "test-event-id",
    productId: "product-1",
    oddsId: "odds-1",
  };

  await request(app).post("/api/event/odds").send(selection).expect(401);
  await request(app)
    .post("/api/event/odds")
    .set("Cookie", buildSessionCookie("USER"))
    .send(selection)
    .expect(403);
  expect(EventOddsSelectedPublisher.prototype.publish).not.toHaveBeenCalled();

  await request(app)
    .post("/api/event/odds")
    .set("Cookie", buildSessionCookie("ADMIN"))
    .send(selection)
    .expect(200);
  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});

it("rejects a demoted administrator for an offline acceptance event", async () => {
  const event = await createPreMatchEvent();
  event.visibility = EventVisibility.OFFLINE;
  await event.save();
  setAdminSessionVerifierForTests(async () => 403);

  await request(app)
    .post("/api/event/odds")
    .set("Cookie", buildSessionCookie("ADMIN"))
    .send({
      eventId: "test-event-id",
      productId: "product-1",
      oddsId: "odds-1",
    })
    .expect(403);

  expect(EventOddsSelectedPublisher.prototype.publish).not.toHaveBeenCalled();
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

it.each([
  ["missing", undefined],
  ["invalid", "not-a-date"],
  ["expired", new Date(Date.now() - 1_000).toISOString()],
])("rejects live selections with %s quote expiry", async (_label, quoteValidUntil) => {
  await createLiveEvent();

  if (quoteValidUntil === undefined) {
    await Event.updateOne(
      { eventId: "test-event-id" },
      { $unset: { "live.currentMarkets.0.quoteValidUntil": 1 } }
    );
  } else {
    await Event.updateOne(
      { eventId: "test-event-id" },
      { $set: { "live.currentMarkets.0.quoteValidUntil": quoteValidUntil } }
    );
  }

  const response = await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "market-1",
      marketVersion: 2,
      quoteVersion: 4,
      selectionId: "home",
    })
    .expect(400);

  expect(response.body.errors[0].msg).toEqual("Live quote is stale");
  expect(EventOddsSelectedPublisher.prototype.publish).not.toHaveBeenCalled();
});

it("accepts string live versions, away selections, and string event times", async () => {
  const quoteValidUntil = new Date(Date.now() + 60_000).toISOString();
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
          quoteValidUntil,
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
      quoteValidUntil,
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
  const quoteValidUntil = new Date(Date.now() + 60_000).toISOString();
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
          quoteValidUntil,
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
          quoteValidUntil,
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
        quoteValidUntil,
      }),
    }
  );
});

const createPreKickoffLiveEvent = async (
  overrides: Partial<Record<string, unknown>> = {}
) => {
  const now = Date.now();
  // Within the 10-minute pre-kickoff live-betting window: kickoff is still
  // ahead, but the two pre-kickoff markets have already been published.
  const kickoffAt = new Date(now + 5 * 60 * 1000);
  return Event.create({
    eventId: "test-event-id",
    name: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    time: kickoffAt,
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 0,
      occurredAt: new Date(now).toISOString(),
      kickoffAt: kickoffAt.toISOString(),
      minute: 0,
      phase: EventPhase.PRE_MATCH,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [],
      currentMarkets: [
        {
          marketId: "test-event-id:KICKOFF_TEAM",
          marketType: LiveMarketType.KICKOFF_TEAM,
          marketVersion: 1,
          quoteVersion: 1,
          quoteValidUntil: kickoffAt.toISOString(),
          status: LiveMarketStatus.OPEN,
          selections: [
            {
              selectionId: "test-event-id:KICKOFF_TEAM:1:HOME",
              side: TeamSide.HOME,
              odds: 1.95,
            },
            {
              selectionId: "test-event-id:KICKOFF_TEAM:1:AWAY",
              side: TeamSide.AWAY,
              odds: 1.95,
            },
          ],
        },
        {
          marketId: "test-event-id:FIRST_MINUTE_GOAL",
          marketType: LiveMarketType.FIRST_MINUTE_GOAL,
          marketVersion: 1,
          quoteVersion: 1,
          quoteValidUntil: kickoffAt.toISOString(),
          status: LiveMarketStatus.OPEN,
          selections: [
            {
              selectionId: "test-event-id:FIRST_MINUTE_GOAL:1:YES",
              side: TeamSide.YES,
              odds: 12.5,
            },
            {
              selectionId: "test-event-id:FIRST_MINUTE_GOAL:1:NO",
              side: TeamSide.NO,
              odds: 1.05,
            },
          ],
        },
      ],
      ...overrides,
    },
  });
};

it.each([
  [LiveMarketType.KICKOFF_TEAM, "test-event-id:KICKOFF_TEAM", "test-event-id:KICKOFF_TEAM:1:HOME", TeamSide.HOME, "Team A"],
  [LiveMarketType.KICKOFF_TEAM, "test-event-id:KICKOFF_TEAM", "test-event-id:KICKOFF_TEAM:1:AWAY", TeamSide.AWAY, "Team B"],
  [LiveMarketType.FIRST_MINUTE_GOAL, "test-event-id:FIRST_MINUTE_GOAL", "test-event-id:FIRST_MINUTE_GOAL:1:YES", TeamSide.YES, "Yes"],
  [LiveMarketType.FIRST_MINUTE_GOAL, "test-event-id:FIRST_MINUTE_GOAL", "test-event-id:FIRST_MINUTE_GOAL:1:NO", TeamSide.NO, "No"],
])(
  "publishes a %s selection (%s) during the pre-kickoff PRE_MATCH phase",
  async (marketType, marketId, selectionId, side, expectedOddsName) => {
    await createPreKickoffLiveEvent();

    await request(app)
      .post("/api/event/odds")
      .send({
        eventId: "test-event-id",
        marketId,
        marketVersion: 1,
        quoteVersion: 1,
        selectionId,
      })
      .expect(200);

    expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: "test-event-id",
        betKind: BetKind.LIVE,
        marketId,
        marketType,
        marketVersion: 1,
        quoteVersion: 1,
        selectionId,
        side,
        oddsName: expectedOddsName,
        productName:
          marketType === LiveMarketType.KICKOFF_TEAM
            ? "Kickoff Team"
            : "Goal In First Minute",
      }),
    });
  }
);

it("rejects a pre-kickoff market selection once its quote has expired at kickoff", async () => {
  const now = Date.now();
  const kickoffAt = new Date(now - 1000);
  await createPreKickoffLiveEvent({
    kickoffAt: kickoffAt.toISOString(),
    currentMarkets: [
      {
        marketId: "test-event-id:KICKOFF_TEAM",
        marketType: LiveMarketType.KICKOFF_TEAM,
        marketVersion: 1,
        quoteVersion: 1,
        quoteValidUntil: kickoffAt.toISOString(),
        status: LiveMarketStatus.OPEN,
        selections: [
          {
            selectionId: "test-event-id:KICKOFF_TEAM:1:HOME",
            side: TeamSide.HOME,
            odds: 1.95,
          },
        ],
      },
    ],
  });

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "test-event-id:KICKOFF_TEAM",
      marketVersion: 1,
      quoteVersion: 1,
      selectionId: "test-event-id:KICKOFF_TEAM:1:HOME",
    })
    .expect(400);

  expect(EventOddsSelectedPublisher.prototype.publish).not.toHaveBeenCalled();
});

it("rejects a pre-kickoff market selection once it has closed at kickoff", async () => {
  await createPreKickoffLiveEvent({
    currentMarkets: [
      {
        marketId: "test-event-id:KICKOFF_TEAM",
        marketType: LiveMarketType.KICKOFF_TEAM,
        marketVersion: 1,
        quoteVersion: 1,
        status: LiveMarketStatus.SETTLED,
        selections: [
          {
            selectionId: "test-event-id:KICKOFF_TEAM:1:HOME",
            side: TeamSide.HOME,
            odds: 1.95,
          },
        ],
      },
    ],
  });

  await request(app)
    .post("/api/event/odds")
    .send({
      eventId: "test-event-id",
      marketId: "test-event-id:KICKOFF_TEAM",
      marketVersion: 1,
      quoteVersion: 1,
      selectionId: "test-event-id:KICKOFF_TEAM:1:HOME",
    })
    .expect(400);

  expect(EventOddsSelectedPublisher.prototype.publish).not.toHaveBeenCalled();
});
