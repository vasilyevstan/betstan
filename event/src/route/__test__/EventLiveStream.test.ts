import { EventEmitter } from "events";
import http from "http";
import { AddressInfo } from "net";
import express, { Request, Response } from "express";
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
import {
  PublicEventSnapshot,
  sanitizePublicEventSnapshot,
} from "../../live/LiveEventReadModel";
import { setAdminSessionVerifierForTests } from "../../service/VerifyAdminSession";
import { EventLiveStream, openEventLiveStream } from "../EventLiveStream";

class MockResponse extends EventEmitter {
  headers: Record<string, string> = {};
  writes: string[] = [];
  statusCode = 200;
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  framingBytes = 0;
  writeResult = true;
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
    this.writableLength += Buffer.byteLength(chunk, "utf8") + this.framingBytes;
    return this.writeResult;
  }

  drain() {
    this.writableLength = 0;
    this.emit("drain");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
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
  const dataChunk = writes
    .join("")
    .split("\n")
    .find((chunk) => chunk.startsWith("data: "));
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
  response.drain();

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

it("rejects streams above the per-pod connection cap", () => {
  const hub = new LiveEventHub();
  const existingUnsubscribe = hub.subscribe(() => undefined);
  const req = new EventEmitter() as Request;
  const res = new MockResponse();

  openEventLiveStream(req, res as unknown as Response, {
    hub,
    maxConnections: 1,
  });

  expect(res.statusCode).toBe(503);
  expect(res.headers["Retry-After"]).toBe("5");
  expect(res.writableEnded).toBe(true);
  expect(hub.subscriberCount()).toBe(1);

  existingUnsubscribe();
});

it("destroys a persistently stalled stream at five seconds rather than ending on backpressure", () => {
  jest.useFakeTimers();
  const hub = new LiveEventHub();
  const req = new EventEmitter() as Request;
  const res = new MockResponse();
  res.writeResult = false;

  openEventLiveStream(req, res as unknown as Response, { hub });
  hub.broadcast(buildSnapshot(1));

  expect(res.writableEnded).toBe(false);
  expect(res.destroyed).toBe(false);
  expect(hub.subscriberCount()).toBe(1);
  jest.advanceTimersByTime(4999);
  expect(res.destroyed).toBe(false);
  jest.advanceTimersByTime(1);
  expect(res.destroyed).toBe(true);
  expect(res.writableEnded).toBe(false);
  expect(hub.subscriberCount()).toBe(0);
});

it("ignores subscribed snapshots that sanitize to non-live payloads", () => {
  const req = new EventEmitter() as Request;
  const res = new MockResponse() as unknown as Response;
  let subscriber: ((snapshot: PublicEventSnapshot) => void) | undefined;
  const fakeHub = {
    subscriberCount() {
      return 0;
    },
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

  expect(
    (res as unknown as MockResponse).writes
      .join("")
      .split("\n")
      .filter((chunk) => chunk.startsWith("data: "))
  ).toHaveLength(1);
  req.emit("close");
});

describe("bounded stream writes", () => {
  const cap = 256 * 1024;
  const frameFor = (snapshot: PublicEventSnapshot) =>
    `id: ${snapshot.eventId}:${snapshot.live!.sequence}\nevent: snapshot\n`
    + `data: ${JSON.stringify(sanitizePublicEventSnapshot(snapshot))}\n\n`;
  const sizedSnapshot = (
    sequence: number,
    bytes: number,
    visibility = EventVisibility.ONLINE
  ) => {
    const snapshot = { ...buildSnapshot(sequence), visibility, name: "" };
    snapshot.name = "x".repeat(bytes - Buffer.byteLength(frameFor(snapshot)));
    expect(Buffer.byteLength(frameFor(snapshot))).toBe(bytes);
    return snapshot;
  };
  const deferredAuthorization = () => {
    let resolve!: (allowed: boolean) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<boolean>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const harness = (options: {
    heartbeatMs?: number;
    verifyScopedAccess?: (req: Request) => Promise<boolean>;
  } = {}) => {
    const req = new EventEmitter() as Request;
    req.visibleOfflineEventIds = options.verifyScopedAccess ? ["event-id"] : [];
    const res = new MockResponse();
    const hub = new LiveEventHub();
    openEventLiveStream(req, res as unknown as Response, {
      hub, heartbeatMs: 60000, ...options,
    });
    return { req, res, hub };
  };
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    log = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
  });

  it("writes each admitted frame once in call order, clears on drain, and permits a fresh stall episode", () => {
    const { req, res, hub } = harness();
    res.writeResult = false;
    hub.broadcast(buildSnapshot(1));
    jest.advanceTimersByTime(4000);
    hub.broadcast(buildSnapshot(2));
    expect(res.destroyed).toBe(false);
    expect(jest.getTimerCount()).toBe(2);
    res.drain();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(6000);
    expect(res.destroyed).toBe(false);
    hub.broadcast(buildSnapshot(3));
    expect(res.writes).toEqual([1, 2, 3].map((sequence) => frameFor(buildSnapshot(sequence))));
    jest.advanceTimersByTime(4999);
    expect(res.destroyed).toBe(false);
    jest.advanceTimersByTime(1);
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    req.emit("close");
  });

  it("never extends the first false-write deadline for later writes or heartbeats", () => {
    const { req, res, hub } = harness({ heartbeatMs: 1000 });
    res.writeResult = false;
    hub.broadcast(buildSnapshot(1));
    jest.advanceTimersByTime(3000);
    hub.broadcast(buildSnapshot(2));
    jest.advanceTimersByTime(1999);
    expect(res.destroyed).toBe(false);
    expect(res.writes).toContain(": heartbeat\n\n");
    jest.advanceTimersByTime(1);
    expect(res.destroyed).toBe(true);
    expect(log.mock.calls).toEqual([["Event stream drain deadline exceeded"]]);
    expect(hub.subscriberCount()).toBe(0);
    expect(res.listenerCount("drain")).toBe(0);
    expect(res.listenerCount("error")).toBe(1);
    const writes = res.writes.length;
    req.emit("close");
    res.emit("finish");
    res.emit("close");
    res.emit("drain");
    res.emit("error", new Error("private teardown error"));
    jest.advanceTimersByTime(60000);
    hub.broadcast(buildSnapshot(3));
    expect(res.writes).toHaveLength(writes);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("applies the same stall deadline to a heartbeat-only connection", () => {
    const { res } = harness({ heartbeatMs: 1000 });
    res.writeResult = false;
    jest.advanceTimersByTime(1000);
    expect(res.writes).toEqual([": heartbeat\n\n"]);
    jest.advanceTimersByTime(4999);
    expect(res.destroyed).toBe(false);
    jest.advanceTimersByTime(1);
    expect(res.destroyed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("admits exactly the byte cap and destroys before an overflowing next frame", () => {
    const { res, hub } = harness();
    hub.broadcast(sizedSnapshot(1, cap));
    expect(res.writes).toHaveLength(1);
    expect(res.writableLength).toBe(cap);
    expect(res.destroyed).toBe(false);
    hub.broadcast(buildSnapshot(2));
    expect(res.writes).toHaveLength(1);
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
    expect(log.mock.calls).toEqual([["Event stream buffer limit exceeded"]]);
  });

  it("destroys after write when HTTP framing pushes the native buffer over the cap", () => {
    const { res, hub } = harness();
    res.framingBytes = 12;
    res.writeResult = false;
    hub.broadcast(sizedSnapshot(1, cap));
    expect(res.writes).toHaveLength(1);
    expect(res.writableLength).toBe(cap + 12);
    expect(res.destroyed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    expect(log.mock.calls).toEqual([["Event stream buffer limit exceeded"]]);
  });

  it.each([
    { label: "oversized ASCII", name: "x".repeat(cap) },
    { label: "UTF-8 bytes rather than character count", name: "界".repeat(100000) },
  ])("rejects $label without writing or starting authorization", async ({ name }) => {
    const verifyScopedAccess = jest.fn(async () => true);
    const { res, hub } = harness({ verifyScopedAccess });
    const snapshot = { ...buildSnapshot(1), name, visibility: EventVisibility.OFFLINE };
    if (name.startsWith("界")) {
      expect(frameFor(snapshot).length).toBeLessThan(cap);
    }
    expect(Buffer.byteLength(frameFor(snapshot))).toBeGreaterThan(cap);
    hub.broadcast(snapshot);
    await jest.advanceTimersByTimeAsync(0);
    expect(res.writes).toEqual([]);
    expect(res.destroyed).toBe(true);
    expect(verifyScopedAccess).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("bounds all pending authorization frames with one counter and one shared verification", async () => {
    const gate = deferredAuthorization();
    const verifyScopedAccess = jest.fn(() => gate.promise);
    const { res, hub } = harness({ verifyScopedAccess });
    hub.broadcast(sizedSnapshot(1, cap / 2, EventVisibility.OFFLINE));
    hub.broadcast(sizedSnapshot(2, cap / 2, EventVisibility.OFFLINE));
    await jest.advanceTimersByTimeAsync(0);
    expect(verifyScopedAccess).toHaveBeenCalledTimes(1);
    expect(res.writes).toEqual([]);
    expect(res.destroyed).toBe(false);
    hub.broadcast(buildSnapshot(3));
    expect(res.destroyed).toBe(true);
    gate.resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(res.writes).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
    expect(hub.subscriberCount()).toBe(0);
    expect(log.mock.calls).toEqual([["Event stream buffer limit exceeded"]]);
  });

  it("releases each auth reservation once before writing, allowing the remaining exact capacity", async () => {
    const gate = deferredAuthorization();
    const verifyScopedAccess = jest.fn(() => gate.promise);
    const { req, res, hub } = harness({ verifyScopedAccess });
    hub.broadcast(sizedSnapshot(1, cap / 4, EventVisibility.OFFLINE));
    hub.broadcast(sizedSnapshot(2, cap / 4, EventVisibility.OFFLINE));
    expect(res.writes).toEqual([]);
    gate.resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(res.writes).toHaveLength(2);
    expect(verifyScopedAccess).toHaveBeenCalledTimes(1);
    hub.broadcast(sizedSnapshot(3, cap / 2));
    expect(res.writes).toHaveLength(3);
    expect(res.writableLength).toBe(cap);
    expect(res.destroyed).toBe(false);
    res.drain();
    hub.broadcast(sizedSnapshot(4, cap, EventVisibility.OFFLINE));
    await jest.advanceTimersByTimeAsync(0);
    expect(verifyScopedAccess).toHaveBeenCalledTimes(2);
    expect(res.writes).toHaveLength(4);
    expect(res.destroyed).toBe(false);
    req.emit("close");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("combines native buffered bytes and pending auth reservations at admission", async () => {
    const gate = deferredAuthorization();
    const { res, hub } = harness({ verifyScopedAccess: () => gate.promise });
    res.writableLength = cap / 4;
    hub.broadcast(sizedSnapshot(1, cap / 2, EventVisibility.OFFLINE));
    hub.broadcast(sizedSnapshot(2, cap / 2, EventVisibility.OFFLINE));
    expect(res.destroyed).toBe(true);
    gate.resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(res.writes).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("rechecks native buffer capacity when authorization completes", async () => {
    const gate = deferredAuthorization();
    const { res, hub } = harness({ verifyScopedAccess: () => gate.promise });
    hub.broadcast(sizedSnapshot(1, cap / 2, EventVisibility.OFFLINE));
    res.writableLength = cap;
    gate.resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(res.writes).toEqual([]);
    expect(res.destroyed).toBe(true);
    expect(log.mock.calls).toEqual([["Event stream buffer limit exceeded"]]);
  });

  it("excludes an out-of-scope offline snapshot before sanitizing or retaining its frame", async () => {
    const verifyScopedAccess = jest.fn(async () => true);
    const { req, res, hub } = harness({ verifyScopedAccess });
    const snapshot = { ...buildSnapshot(1), eventId: "excluded", visibility: EventVisibility.OFFLINE };
    const readName = jest.fn(() => "x".repeat(cap));
    Object.defineProperty(snapshot, "name", { get: readName });
    hub.broadcast(snapshot);
    await jest.advanceTimersByTimeAsync(0);
    expect(readName).not.toHaveBeenCalled();
    expect(verifyScopedAccess).not.toHaveBeenCalled();
    expect(res.writes).toEqual([]);
    expect(res.destroyed).toBe(false);
    req.emit("close");
  });

  it.each(["revoked", "rejected", "synchronous failure", "disconnect"] as const)(
    "does not write or restart timers after pending authorization is %s",
    async (outcome) => {
      const gate = deferredAuthorization();
      const verifyScopedAccess = jest.fn(() => {
        if (outcome === "synchronous failure") {
          throw new Error("private auth details");
        }
        return gate.promise;
      });
      const { req, res, hub } = harness({ verifyScopedAccess, heartbeatMs: 1000 });
      hub.broadcast({ ...buildSnapshot(1), visibility: EventVisibility.OFFLINE });
      hub.broadcast({ ...buildSnapshot(2), visibility: EventVisibility.OFFLINE });
      await jest.advanceTimersByTimeAsync(1000);
      if (outcome === "disconnect") {
        req.emit("close");
        req.emit("close");
        gate.resolve(true);
      } else if (outcome === "rejected") {
        gate.reject(new Error("private auth details"));
      } else {
        gate.resolve(false);
      }
      await jest.advanceTimersByTimeAsync(10000);
      expect(res.writes).toEqual([]);
      expect(hub.subscriberCount()).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      expect(res.listenerCount("drain")).toBe(0);
      expect(verifyScopedAccess).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private auth details");
    }
  );

  it("destroys rather than flushes buffered bytes on authorization revocation", async () => {
    const { res, hub } = harness({ verifyScopedAccess: async () => false });
    res.writeResult = false;
    hub.broadcast(buildSnapshot(1));
    hub.broadcast({ ...buildSnapshot(2), visibility: EventVisibility.OFFLINE });
    await jest.advanceTimersByTimeAsync(0);
    expect(res.writes).toHaveLength(1);
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("shares the auth reservation budget and writer with scoped heartbeats", async () => {
    const gate = deferredAuthorization();
    const { res, hub } = harness({
      verifyScopedAccess: () => gate.promise, heartbeatMs: 1000,
    });
    hub.broadcast(sizedSnapshot(1, cap, EventVisibility.OFFLINE));
    await jest.advanceTimersByTimeAsync(999);
    expect(res.destroyed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(res.destroyed).toBe(true);
    gate.resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(res.writes).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(["throw", "error then false", "close then false", "asynchronous error"] as const)(
    "terminates safely on %s without leaking details or rearming a deadline",
    async (failure) => {
      const { req, res, hub } = harness();
      jest.spyOn(res, "write").mockImplementation(() => {
        if (failure === "throw") {
          throw new Error("private payload-bearing write failure");
        }
        if (failure === "error then false") {
          res.emit("error", new Error("private response error"));
        } else if (failure === "close then false") {
          res.emit("close");
        } else {
          queueMicrotask(() => res.emit("error", new Error("private late error")));
        }
        return false;
      });
      expect(() => hub.broadcast(buildSnapshot(1))).not.toThrow();
      await jest.advanceTimersByTimeAsync(0);
      expect(hub.subscriberCount()).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      expect(res.listenerCount("drain")).toBe(0);
      expect(res.listenerCount("error")).toBe(1);
      req.emit("close");
      res.emit("error", new Error("private teardown error"));
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
      if (failure !== "close then false") {
        expect(res.destroyed).toBe(true);
        expect(log.mock.calls).toEqual([[
          failure === "throw" ? "Event stream write failed" : "Event stream response failed",
        ]]);
      }
    }
  );
});

describe("real HTTP terminal delivery", () => {
  it.each([
    [EventVisibility.ONLINE, 5],
    [EventVisibility.ONLINE, 128],
    [EventVisibility.ONLINE, 256],
    [EventVisibility.OFFLINE, 5],
    [EventVisibility.OFFLINE, 128],
    [EventVisibility.OFFLINE, 256],
  ] as const)("delivers both complete %s snapshots with %i incidents", async (visibility, count) => {
    const ids = ["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"];
    const snapshots = ids.map((eventId) => ({
      ...buildDirtySnapshot(),
      id: eventId,
      eventId,
      visibility,
      status: EventStatus.RESULTED,
      live: {
        ...buildSnapshot(130).live!,
        phase: EventPhase.FULL_TIME,
        minute: 90,
        bettingStatus: BettingStatus.CLOSED,
        currentMarkets: [],
        incidentHistoryComplete: true,
        incidentHistory: Array.from({ length: count }, (_, index) => ({
          id: `${eventId}:incident:${index}`,
          type: index === count - 1 ? LiveIncidentType.FULL_TIME : LiveIncidentType.CORNER,
          side: TeamSide.HOME,
          occurredAt: "2030-01-01T12:09:00.000Z",
          minute: Math.min(index, 90),
        })),
      },
    }));
    let authorize!: (status: 204) => void;
    const authorization = new Promise<204>((resolve) => { authorize = resolve; });
    const verifier = jest.fn().mockResolvedValueOnce(204).mockReturnValue(authorization);
    setAdminSessionVerifierForTests(verifier);

    const writes: { accepted: boolean; bytes: number; highWaterMark: number }[] = [];
    let connection: Response | undefined;
    const app = express();
    app.use((req, res, next) => {
      req.currentUser = { id: "synthetic-admin", email: "synthetic@example.test", role: "ADMIN" } as Request["currentUser"];
      connection = res;
      const write = res.write.bind(res);
      res.write = ((chunk: string) => {
        const accepted = write(chunk);
        writes.push({
          accepted,
          bytes: Buffer.byteLength(chunk, "utf8"),
          highWaterMark: res.writableHighWaterMark,
        });
        return accepted;
      }) as typeof res.write;
      next();
    });
    app.use(EventLiveStream);
    // OCI runs Node 20.19.4; never rely on the Node 24 test host's default HWM.
    const server = http.createServer({ highWaterMark: 16384 }, app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let client: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        let received = "";
        const finish = () => {
          clearTimeout(timer);
          resolve(received);
        };
        client = http.get({
          host: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
          path: "/api/event/stream" + (visibility === EventVisibility.OFFLINE
            ? `?acceptanceEventIds=${ids.join(",")}` : ""),
        }, (incoming) => {
          response = incoming;
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => {
            received += chunk;
            if (received.split("\n\n").length >= 3) {
              finish();
            }
          });
          incoming.on("end", finish);
          incoming.on("error", reject);
          liveEventHub.broadcast(snapshots[0]);
          liveEventHub.broadcast(snapshots[1]);
          authorize(204);
        });
        client.on("error", reject);
        timer = setTimeout(finish, 1000);
      });
      const frames = body.split("\n\n").filter(Boolean);
      expect(frames.length).toBe(2);
      expect(frames.map((frame) => JSON.parse(
        frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)
      ))).toEqual(snapshots.map(sanitizePublicEventSnapshot));
      for (const [index, frame] of frames.entries()) {
        expect(frame.startsWith(`id: ${ids[index]}:130\nevent: snapshot\ndata: `)).toBe(true);
        const payload = getDataPayload([frame]);
        expect(payload.live.incidentHistory).toHaveLength(count);
        expect(payload.live.incidentHistoryComplete).toBe(true);
      }
      expect(writes).toHaveLength(2);
      expect(writes.every((write) => write.highWaterMark === 16384)).toBe(true);
      if (count >= 128) {
        expect(writes.some((write) => !write.accepted && write.bytes > 16384)).toBe(true);
      } else {
        expect(writes.every((write) => write.accepted)).toBe(true);
      }
      expect(verifier).toHaveBeenCalledTimes(visibility === EventVisibility.OFFLINE ? 2 : 0);
      expect(connection!.writableEnded).toBe(false);
      expect(connection!.destroyed).toBe(false);
      expect(liveEventHub.subscriberCount()).toBe(1);
    } finally {
      clearTimeout(timer);
      authorize(204);
      response?.destroy();
      client?.destroy();
      connection?.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
