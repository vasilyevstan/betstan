import { createHash } from "crypto";
import { EventStatus, EventVisibility } from "@betstan/common";
import { Event } from "../../model/Event";
import {
  EventScheduler,
  EventSchedulerConfig,
  getEventSchedulerConfig,
  SchedulerPublisher,
} from "../EventScheduler";

const config = (overrides: Partial<EventSchedulerConfig> = {}) => ({
  enabled: true,
  poolSize: 3,
  horizonMinutes: 10,
  tickMs: 60000,
  maxInsertsPerTick: 3,
  ...overrides,
});

const publisher = (): jest.Mocked<SchedulerPublisher> => ({
  init: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn(),
});

it("uses scheduler defaults and validates environment overrides", () => {
  expect(getEventSchedulerConfig({})).toEqual({
    enabled: true,
    poolSize: 9,
    horizonMinutes: 1440,
    tickMs: 60000,
    maxInsertsPerTick: 9,
  });
  expect(
    getEventSchedulerConfig({
      EVENT_SCHEDULER_ENABLED: "false",
      EVENT_POOL_SIZE: "4",
      EVENT_SCHEDULE_HORIZON_MINUTES: "20",
      EVENT_SCHEDULE_TICK_MS: "5000",
      EVENT_SCHEDULE_MAX_INSERTS_PER_TICK: "2",
    })
  ).toEqual({
    enabled: false,
    poolSize: 4,
    horizonMinutes: 20,
    tickMs: 5000,
    maxInsertsPerTick: 2,
  });
  expect(
    getEventSchedulerConfig({
      EVENT_SCHEDULER_ENABLED: "sometimes",
      EVENT_POOL_SIZE: "0",
      EVENT_SCHEDULE_HORIZON_MINUTES: "bad",
      EVENT_SCHEDULE_TICK_MS: "1",
      EVENT_SCHEDULE_MAX_INSERTS_PER_TICK: "99",
    })
  ).toEqual({
    enabled: true,
    poolSize: 1,
    horizonMinutes: 1440,
    tickMs: 1000,
    maxInsertsPerTick: 1,
  });
  expect(
    getEventSchedulerConfig({
      EVENT_SCHEDULER_ENABLED: "1",
      EVENT_POOL_SIZE: "999999999999999999999999",
    })
  ).toMatchObject({ enabled: true, poolSize: 9 });
  expect(
    getEventSchedulerConfig({
      EVENT_POOL_SIZE: "12",
    })
  ).toMatchObject({ poolSize: 12, maxInsertsPerTick: 12 });
  expect(
    getEventSchedulerConfig({
      EVENT_POOL_SIZE: "9",
      EVENT_SCHEDULE_HORIZON_MINUTES: "5",
    })
  ).toMatchObject({ poolSize: 9, horizonMinutes: 9 });
});

it("creates the exact epoch-aligned slots at the configured spacing", async () => {
  const now = new Date("2030-01-01T00:01:00.001Z");
  const sent = publisher();
  const scheduler = new EventScheduler({
    config: config(),
    now: () => now,
    publisherFactory: () => sent,
  });
  await scheduler.ensureSlotKeyIndex();

  await scheduler.runOnce();

  const events = await Event.find({ source: "SCHEDULER" }).sort({ time: 1 });
  const slotMs = 200000;
  const firstIndex = Math.floor(now.getTime() / slotMs) + 1;
  expect(events).toHaveLength(3);
  expect(events.map((event) => event.time.getTime())).toEqual([
    firstIndex * slotMs,
    (firstIndex + 1) * slotMs,
    (firstIndex + 2) * slotMs,
  ]);
  expect(events.every((event) => event.time > now)).toBe(true);
  expect(
    events.every(
      (event) => event.time.getTime() <= now.getTime() + 10 * 60 * 1000
    )
  ).toBe(true);
  expect(events.map((event) => event.slotKey)).toEqual([
    `${slotMs}:${firstIndex}`,
    `${slotMs}:${firstIndex + 1}`,
    `${slotMs}:${firstIndex + 2}`,
  ]);
  expect(events[0].eventId).toEqual(
    createHash("sha256")
      .update(`${slotMs}:${firstIndex}`)
      .digest("hex")
      .slice(0, 24)
  );
  expect(sent.publish).toHaveBeenCalledTimes(3);
});

it("does not insert slots twice at the same clock value", async () => {
  const now = new Date("2030-01-01T00:01:00.000Z");
  const scheduler = new EventScheduler({
    config: config(),
    now: () => now,
    publisherFactory: publisher,
  });
  await scheduler.ensureSlotKeyIndex();

  await scheduler.runOnce();
  await scheduler.runOnce();

  expect(await Event.countDocuments({ source: "SCHEDULER" })).toEqual(3);
});

it("deduplicates two concurrent scheduler instances with the slotKey index", async () => {
  const now = new Date("2030-01-01T00:01:00.000Z");
  const firstPublisher = publisher();
  const secondPublisher = publisher();
  const first = new EventScheduler({
    config: config(),
    now: () => now,
    publisherFactory: () => firstPublisher,
  });
  const second = new EventScheduler({
    config: config(),
    now: () => now,
    publisherFactory: () => secondPublisher,
  });
  await first.ensureSlotKeyIndex();

  await Promise.all([first.runOnce(), second.runOnce()]);

  expect(await Event.countDocuments({ source: "SCHEDULER" })).toEqual(3);
  expect(
    firstPublisher.publish.mock.calls.length +
      secondPublisher.publish.mock.calls.length
  ).toEqual(3);
});

it("keeps a failed publish pending and retries it with a new publisher", async () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  const failed = publisher();
  failed.publish.mockImplementation(() => {
    throw new Error("broker unavailable");
  });
  const recovered = publisher();
  const factories = [failed, recovered];
  const scheduler = new EventScheduler({
    config: config({ poolSize: 1, horizonMinutes: 1, maxInsertsPerTick: 1 }),
    now: () => now,
    publisherFactory: () => factories.shift()!,
  });
  await scheduler.ensureSlotKeyIndex();

  await scheduler.runOnce();
  let stored = await Event.findOne({ source: "SCHEDULER" });
  expect(stored!.newEventPublishedAt).toBeNull();
  expect(stored!.newEventPublishAttempts).toEqual(1);

  await scheduler.runOnce();
  stored = await Event.findOne({ source: "SCHEDULER" });
  expect(recovered.init).toHaveBeenCalledTimes(1);
  expect(recovered.publish).toHaveBeenCalledTimes(1);
  expect(stored!.newEventPublishedAt).not.toBeNull();
  expect(stored!.newEventPublishAttempts).toEqual(2);
});

it("reclaims a stale publish claim after the bounded claim timeout", async () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  const slotMs = 60000;
  const firstIndex = Math.floor(now.getTime() / slotMs) + 1;
  await Event.create({
    eventId: "stale-publish-claim",
    name: "Stale A - Stale B",
    time: new Date(firstIndex * slotMs),
    home: "Stale A",
    away: "Stale B",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    source: "SCHEDULER",
    slotKey: `${slotMs}:${firstIndex}`,
    newEventPublishAttempts: 1,
    newEventPublishClaimedAt: new Date(now.getTime() - 120001),
    newEventPublishClaimToken: "abandoned-claim",
  });
  const sent = publisher();
  const scheduler = new EventScheduler({
    config: config({
      poolSize: 1,
      horizonMinutes: 1,
      tickMs: 1000,
      maxInsertsPerTick: 1,
    }),
    now: () => now,
    publisherFactory: () => sent,
  });
  await scheduler.ensureSlotKeyIndex();

  await scheduler.runOnce();

  const stored = await Event.findOne({ eventId: "stale-publish-claim" });
  expect(sent.publish).toHaveBeenCalledTimes(1);
  expect(stored!.newEventPublishedAt).not.toBeNull();
  expect(stored!.newEventPublishAttempts).toEqual(2);
  expect(stored!.newEventPublishClaimToken).toBeNull();
});

it("never modifies external events and marks past scheduler events without publishing", async () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  await Event.create({
    eventId: "external-event",
    name: "External A - External B",
    time: new Date("2029-01-01T00:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    source: "EXTERNAL",
    newEventPublishAttempts: 7,
  });
  await Event.create({
    eventId: "past-scheduler-event",
    name: "Past A - Past B",
    time: new Date("2029-01-01T00:00:00.000Z"),
    home: "Past A",
    away: "Past B",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    source: "SCHEDULER",
    slotKey: "60000:1",
    newEventPublishAttempts: 0,
  });
  const sent = publisher();
  const scheduler = new EventScheduler({
    config: config({ poolSize: 1, horizonMinutes: 1, maxInsertsPerTick: 1 }),
    now: () => now,
    publisherFactory: () => sent,
  });
  await scheduler.ensureSlotKeyIndex();

  await scheduler.runOnce();

  const external = await Event.findOne({ eventId: "external-event" });
  const past = await Event.findOne({ eventId: "past-scheduler-event" });
  expect(external!.newEventPublishedAt).toBeNull();
  expect(external!.newEventPublishAttempts).toEqual(7);
  expect(past!.newEventPublishedAt).not.toBeNull();
  expect(sent.publish).toHaveBeenCalledTimes(1);
});

it("stops an unstarted timeout without running it", async () => {
  const scheduler = new EventScheduler({
    config: config({ tickMs: 1000 }),
    publisherFactory: publisher,
  });

  await scheduler.start();
  await scheduler.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(await Event.countDocuments()).toEqual(0);
});

it("does not create an index or schedule work when disabled", async () => {
  const scheduler = new EventScheduler({
    config: config({ enabled: false }),
    publisherFactory: publisher,
  });

  await scheduler.start();
  await scheduler.stop();

  expect(await Event.countDocuments()).toEqual(0);
});

it("shares an in-flight local run instead of overlapping it", async () => {
  const scheduler = new EventScheduler({
    config: config({ poolSize: 1, horizonMinutes: 1 }),
    publisherFactory: publisher,
  });
  await scheduler.ensureSlotKeyIndex();

  const firstRun = scheduler.runOnce();
  expect(scheduler.runOnce()).toBe(firstRun);
  await firstRun;
});

it("treats a duplicate slot insertion as a successful no-op", async () => {
  const scheduler = new EventScheduler({
    config: config({ poolSize: 1, horizonMinutes: 1 }),
    publisherFactory: publisher,
  });
  await scheduler.ensureSlotKeyIndex();
  const updateOne = jest
    .spyOn(Event, "updateOne")
    .mockRejectedValueOnce({ code: 11000 });

  await expect(scheduler.runOnce()).resolves.toBeUndefined();
  updateOne.mockRestore();

  expect(await Event.countDocuments({ source: "SCHEDULER" })).toEqual(0);
});

it("schedules the next run only after the current run completes", async () => {
  const sent = publisher();
  const scheduler = new EventScheduler({
    config: config({ poolSize: 1, horizonMinutes: 1, tickMs: 1000 }),
    publisherFactory: () => sent,
  });

  await scheduler.start();
  await scheduler.start();
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await Event.countDocuments({ source: "SCHEDULER" })) === 1) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await scheduler.stop();

  expect(await Event.countDocuments({ source: "SCHEDULER" })).toEqual(1);
  expect(sent.publish).toHaveBeenCalledTimes(1);
});

it("logs a failed scheduled run and retries on the next tick", async () => {
  const scheduler = new EventScheduler({
    config: config({ tickMs: 1000 }),
    publisherFactory: publisher,
  });
  jest
    .spyOn(scheduler, "ensureSlotKeyIndex")
    .mockResolvedValue(undefined);
  const runOnce = jest
    .spyOn(scheduler, "runOnce")
    .mockRejectedValueOnce(new Error("transient database error"))
    .mockResolvedValueOnce(undefined);
  const consoleError = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  jest.useFakeTimers();

  try {
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(consoleError).toHaveBeenCalledWith(
      "Event scheduler tick failed",
      expect.any(Error)
    );

    await jest.advanceTimersByTimeAsync(1000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  } finally {
    jest.useRealTimers();
    consoleError.mockRestore();
  }
});
