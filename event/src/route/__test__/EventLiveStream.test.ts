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
import { liveEventHub, LiveEventHub } from "../../live/LiveEventHub";
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

  end() {
    this.writableEnded = true;
    this.emit("finish");
    return this;
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

const flushPromises = () => new Promise<void>((resolve) => {
  setImmediate(resolve);
});

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

it("streams offline snapshots only to an authorized scoped connection", async () => {
  const offlineSnapshot = {
    ...buildDirtySnapshot(),
    visibility: EventVisibility.OFFLINE,
  };
  const publicHub = new LiveEventHub();
  const publicRequest = new EventEmitter() as Request;
  const publicResponse = new MockResponse() as unknown as Response;
  openEventLiveStream(publicRequest, publicResponse, { hub: publicHub });
  publicHub.broadcast(offlineSnapshot);
  expect((publicResponse as unknown as MockResponse).writes).toEqual([]);

  const adminHub = new LiveEventHub();
  const adminRequest = new EventEmitter() as Request;
  adminRequest.visibleOfflineEventIds = ["event-id"];
  const adminResponse = new MockResponse() as unknown as Response;
  const verifyScopedAccess = jest.fn(async () => true);
  openEventLiveStream(adminRequest, adminResponse, {
    hub: adminHub,
    verifyScopedAccess,
  });
  adminHub.broadcast(offlineSnapshot);
  await flushPromises();
  expect((adminResponse as unknown as MockResponse).writes.join("")).toContain(
    "id: event-id:7"
  );
  expect(verifyScopedAccess).toHaveBeenCalledTimes(1);

  publicRequest.emit("close");
  adminRequest.emit("close");
});

it("closes a scoped stream before sending another offline snapshot after demotion", async () => {
  let authorized = true;
  const hub = new LiveEventHub();
  const req = new EventEmitter() as Request;
  req.visibleOfflineEventIds = ["event-id"];
  const response = new MockResponse();
  openEventLiveStream(req, response as unknown as Response, {
    hub,
    verifyScopedAccess: async () => authorized,
  });

  const firstSnapshot = {
    ...buildDirtySnapshot(),
    visibility: EventVisibility.OFFLINE,
  };
  hub.broadcast(firstSnapshot);
  await flushPromises();
  expect(response.writes.join("")).toContain("id: event-id:7");

  authorized = false;
  hub.broadcast({
    ...firstSnapshot,
    live: {
      ...firstSnapshot.live!,
      sequence: 8,
    },
  });
  await flushPromises();

  expect(response.writes.join("")).not.toContain("id: event-id:8");
  expect(response.writableEnded).toBe(true);
  expect(hub.subscriberCount()).toBe(0);
});

it("uses default options, skips non-live payloads, and tolerates repeated cleanup without flushHeaders", () => {
  jest.useFakeTimers();

  const req = new EventEmitter() as Request;
  const res = new MockResponse();
  delete (res as Partial<MockResponse>).flushHeaders;

  openEventLiveStream(req, res as unknown as Response);

  expect(liveEventHub.subscriberCount()).toEqual(1);

  const writesBeforeLive = res.writes.length;
  const subscribedCallbacks = new Set(res.writes);

  liveEventHub.broadcast({
    id: "event-id",
    eventId: "event-id",
    name: "No live snapshot",
    time: "2030-01-01T12:00:00.000Z",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  } as PublicEventSnapshot);

  expect(res.writes).toHaveLength(writesBeforeLive);
  expect(new Set(res.writes)).toEqual(subscribedCallbacks);

  res.writableEnded = true;
  liveEventHub.broadcast(buildSnapshot(9));
  jest.advanceTimersByTime(15000);
  expect(res.writes).toHaveLength(writesBeforeLive);

  req.emit("close");
  req.emit("close");
  (res as unknown as EventEmitter).emit("close");
  expect(liveEventHub.subscriberCount()).toEqual(0);
});

it("ignores subscribed snapshots that sanitize to non-live payloads", () => {
  const req = new EventEmitter() as Request;
  const res = new MockResponse() as unknown as Response;
  let subscriber: ((snapshot: PublicEventSnapshot) => void) | undefined;
  const fakeHub = {
    subscribe(callback: (snapshot: PublicEventSnapshot) => void) {
      subscriber = callback;
      return jest.fn();
    },
  } as unknown as LiveEventHub;

  openEventLiveStream(req, res, { hub: fakeHub, heartbeatMs: 1000 });

  subscriber?.({
    id: "event-id",
    eventId: "event-id",
    name: "Hidden live snapshot",
    time: "2030-01-01T12:00:00.000Z",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 1,
      minute: 5,
      phase: EventPhase.FIRST_HALF,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  expect((res as unknown as MockResponse).writes.join("")).toContain("event: snapshot");

  subscriber?.({
    _id: "raw-id",
    id: "event-id",
    eventId: "event-id",
    name: "Sanitized away",
    time: "2030-01-01T12:00:00.000Z",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: undefined,
  });

  expect((res as unknown as MockResponse).writes.filter((chunk) => chunk.startsWith("data: "))).toHaveLength(1);
  req.emit("close");
});
