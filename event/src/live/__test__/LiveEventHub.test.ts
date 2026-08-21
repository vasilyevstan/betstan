import { EventStatus, EventVisibility } from "@betstan/common";
import { LiveEventHub } from "../LiveEventHub";

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

  const latestSnapshot = {
    id: "event-id",
    eventId: "event-id",
    name: "Live",
    time: "2030-01-01T12:00:00.000Z",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 2,
      minute: 10,
      phase: "FIRST_HALF",
      homeScore: 1,
      awayScore: 0,
      bettingStatus: "OPEN",
      incidentHistory: [],
      currentMarkets: [],
    },
  } as any;

  expect(hub.broadcast(latestSnapshot)).toEqual(true);
  expect(hub.broadcast({ ...latestSnapshot })).toEqual(false);
  expect(
    hub.broadcast({
      ...latestSnapshot,
      live: { ...latestSnapshot.live, sequence: 1 },
    })
  ).toEqual(false);
  expect(subscriber).toHaveBeenCalledTimes(1);
  expect(hub.getSnapshot("event-id")).toEqual(latestSnapshot);
});
