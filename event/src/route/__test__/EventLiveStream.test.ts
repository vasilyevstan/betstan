import { EventEmitter } from "events";
import { Request, Response } from "express";
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
import { LiveEventHub } from "../../live/LiveEventHub";
import { PublicEventSnapshot } from "../../live/LiveEventReadModel";
import { openEventLiveStream } from "../EventLiveStream";

class MockResponse extends EventEmitter {
  headers: Record<string, string> = {};
  writes: string[] = [];
  statusCode = 200;
  writableEnded = false;
  flushHeaders = jest.fn();

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }
}

const buildSnapshot = (sequence: number): PublicEventSnapshot => ({
  _id: "event-id",
  id: "event-id",
  eventId: "event-id",
  name: "Team A - Team B",
  home: "Team A",
  away: "Team B",
  time: "2030-01-01T12:00:00.000Z",
  status: EventStatus.NO_RESULT,
  visibility: EventVisibility.ONLINE,
  products: [],
  live: {
    sequence,
    minute: 10,
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

const buildDirtySnapshot = (): PublicEventSnapshot =>
  ({
    _id: "legacy-mongo-id",
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
            internalProbability: 0.91,
          },
        ],
        internalProductFlag: true,
      },
    ],
    source: "SCHEDULER",
    slotKey: "slot-1",
    newEventPublishedAt: "2030-01-01T12:01:00.000Z",
    newEventPublishAttempts: 7,
    newEventPublishClaimedAt: "2030-01-01T12:02:00.000Z",
    newEventPublishClaimToken: "claim-token",
    futureContractField: "hide-me",
    __v: 4,
    live: {
      sequence: 7,
      occurredAt: "2030-01-01T12:07:00.000Z",
      kickoffAt: "2030-01-01T12:00:00.000Z",
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
          quoteValidUntil: "2030-01-01T12:12:00.000Z",
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
  } as unknown as PublicEventSnapshot);

const getDataPayload = (writes: string[]) => {
  const dataChunk = writes.find((chunk) => chunk.startsWith("data: "));
  if (!dataChunk) {
    throw new Error("Missing SSE data chunk");
  }

  return JSON.parse(dataChunk.slice(6));
};

afterEach(() => {
  jest.useRealTimers();
});

it("sets SSE headers, sanitizes snapshots, emits heartbeats, and cleans up disconnected subscribers", () => {
  jest.useFakeTimers();

  const hub = new LiveEventHub();
  const req = new EventEmitter() as Request;
  const res = new MockResponse() as unknown as Response;

  openEventLiveStream(req, res, { hub, heartbeatMs: 1000 });

  expect((res as unknown as MockResponse).statusCode).toEqual(200);
  expect((res as unknown as MockResponse).headers).toEqual({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  expect((res as unknown as MockResponse).flushHeaders).toHaveBeenCalledTimes(1);
  expect(hub.subscriberCount()).toEqual(1);

  hub.broadcast(buildDirtySnapshot());

  expect((res as unknown as MockResponse).writes.join("")).toContain("id: event-id:7");
  expect((res as unknown as MockResponse).writes.join("")).toContain("event: snapshot");
  expect(getDataPayload((res as unknown as MockResponse).writes)).toEqual({
    _id: "legacy-mongo-id",
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

  jest.advanceTimersByTime(1000);
  expect((res as unknown as MockResponse).writes).toContain(": heartbeat\n\n");

  req.emit("close");
  expect(hub.subscriberCount()).toEqual(0);

  const writesBefore = (res as unknown as MockResponse).writes.length;
  hub.broadcast(buildSnapshot(8));
  expect((res as unknown as MockResponse).writes).toHaveLength(writesBefore);
});
