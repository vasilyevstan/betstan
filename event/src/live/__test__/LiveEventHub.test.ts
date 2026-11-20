import {
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
} from "@betstan/common";
import { LiveEventHub } from "../LiveEventHub";
import type { PublicEventSnapshot } from "../LiveEventReadModel";

const buildSnapshot = (
  eventId: string,
  sequence: number
): PublicEventSnapshot => ({
  id: eventId,
  eventId,
  name: "Live",
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
    currentMarkets: [],
  },
});

it("ignores snapshots without live state and clears stored state on reset", () => {
  const hub = new LiveEventHub();
  const subscriber = jest.fn();
  hub.subscribe(subscriber);

  expect(
    hub.broadcast({
      id: "event-id",
      eventId: "event-id",
      name: "No live",
      time: "2030-01-01T12:00:00.000Z",
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
    })
  ).toEqual(false);
  expect(subscriber).not.toHaveBeenCalled();
  expect(hub.getSnapshot("event-id")).toBeUndefined();

  hub.reset();
  expect(hub.subscriberCount()).toEqual(0);
  expect(hub.getSnapshot("event-id")).toBeUndefined();
});

it("suppresses duplicate or stale live sequences while keeping the newest snapshot", () => {
  const hub = new LiveEventHub();
  const subscriber = jest.fn();
  hub.subscribe(subscriber);

  const latestSnapshot = buildSnapshot("event-id", 2);

  expect(hub.broadcast(latestSnapshot)).toEqual(true);
  expect(hub.broadcast({ ...latestSnapshot })).toEqual(false);
  expect(
    hub.broadcast({
      ...latestSnapshot,
      live: { ...latestSnapshot.live!, sequence: 1 },
    })
  ).toEqual(false);
  expect(subscriber).toHaveBeenCalledTimes(1);
  expect(hub.getSnapshot("event-id")).toEqual(latestSnapshot);
});

it("bounds retained events without disconnecting subscribers or losing recent sequence guards", () => {
  const hub = new LiveEventHub();
  const subscriber = jest.fn();
  const unsubscribe = hub.subscribe(subscriber);

  for (let index = 0; index < 1000; index += 1) {
    hub.broadcast(buildSnapshot(`event-${index}`, 1));
  }
  expect(hub.getSnapshot("event-0")).toBeUndefined();
  expect(hub.getSnapshot("event-999")).toEqual(buildSnapshot("event-999", 1));
  expect(hub.subscriberCount()).toBe(1);
  expect(subscriber).toHaveBeenCalledTimes(1000);
  expect(hub.broadcast(buildSnapshot("event-999", 2))).toBe(true);
  expect(hub.broadcast(buildSnapshot("event-999", 1))).toBe(false);
  expect(subscriber).toHaveBeenCalledTimes(1001);

  unsubscribe();
  expect(hub.subscriberCount()).toBe(0);
});
