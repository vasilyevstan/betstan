import mongoose from "mongoose";
import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import {
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
  LiveIncidentType,
  LiveMarketStatus,
  LiveMarketType,
  TeamSide,
} from "@betstan/common";
import NewEventPublisher from "../../messaging/publisher/NewEventPublisher";

const createPreMatchEvent = async (
  eventId: string,
  time: Date
) => {
  await Event.create({
    eventId,
    name: `${eventId} match`,
    time,
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [
      {
        id: `${eventId}-product`,
        type: "1X2",
        name: "1X2",
        odds: [{ id: `${eventId}-odds`, name: "Home", value: 1.5 }],
      },
    ],
  });
};

it("returns a bounded event list with live events sorted before pre-match events", async () => {
  const now = Date.now();

  await createPreMatchEvent("future-soon", new Date(now + 10 * 60 * 1000));
  await createPreMatchEvent("future-later", new Date(now + 20 * 60 * 1000));
  await createPreMatchEvent("too-far-future", new Date(now + 30 * 60 * 60 * 1000));
  await createPreMatchEvent("too-far-past", new Date(now - 5 * 60 * 60 * 1000));

  await Event.create({
    eventId: "live-now",
    name: "live-now match",
    time: new Date(now - 30 * 60 * 1000),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 7,
      occurredAt: new Date(now - 60 * 1000).toISOString(),
      kickoffAt: new Date(now - 30 * 60 * 1000).toISOString(),
      minute: 32,
      phase: EventPhase.FIRST_HALF,
      homeScore: 1,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [],
      currentMarkets: [
        {
          marketId: "market-live",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 2,
          quoteVersion: 4,
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

  const res = await request(app).get("/api/event").expect(200);
  expect(res.body.map((event: { eventId: string }) => event.eventId)).toEqual([
    "live-now",
    "future-soon",
    "future-later",
  ]);
  expect(res.body[0].id).toEqual("live-now");
  expect(res.body[0].live.sequence).toEqual(7);
  expect(res.body[0].live.currentMarkets).toHaveLength(1);
});

it("returns an empty array without creating events when DB is empty", async () => {
  const res = await request(app).get("/api/event").expect(200);
  expect(res.body).toEqual([]);
  expect(await Event.countDocuments()).toEqual(0);
  expect(NewEventPublisher.prototype.publish).not.toHaveBeenCalled();
});

it("keeps legacy event documents readable without requiring live fields", async () => {
  await createPreMatchEvent("legacy-event", new Date(Date.now() + 15 * 60 * 1000));

  const res = await request(app).get("/api/event").expect(200);

  expect(res.body).toHaveLength(1);
  expect(res.body[0]._id).toEqual(expect.any(String));
  expect(res.body[0].id).toEqual("legacy-event");
  expect(res.body[0].eventId).toEqual("legacy-event");
  expect(res.body[0].products[0].id).toEqual("legacy-event-product");
  expect(res.body[0].live).toBeUndefined();
});

it("sanitizes REST snapshots to the explicit public allowlist without leaking internal fields", async () => {
  const eventId = "rest-sanitized";
  const eventMongoId = new mongoose.Types.ObjectId();
  const eventTime = new Date(Date.now() + 10 * 60 * 1000);
  const occurredAt = new Date(Date.now() - 60 * 1000).toISOString();
  const quoteValidUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  await Event.collection.insertOne({
    _id: eventMongoId,
    eventId,
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
          occurredAt,
          minute: 12,
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
              traderLimit: 100,
            },
          ],
          internalTraderState: "hidden",
        },
      ],
      internalLiveState: true,
    },
  });

  const res = await request(app).get("/api/event").expect(200);

  expect(res.body).toEqual([
    {
      _id: eventMongoId.toHexString(),
      id: eventId,
      eventId,
      name: "Team A - Team B",
      home: "Team A",
      away: "Team B",
      time: eventTime.toISOString(),
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
            occurredAt,
            minute: 12,
            addedTime: 1,
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
              },
            ],
          },
        ],
      },
    },
  ]);
});
