import mongoose from "mongoose";
import { BettingStatus, EventPhase, EventStatus, EventVisibility } from "@betstan/common";
import { Event } from "../../model/Event";
import {
  parseBackfillArgs,
  runBackfillCli,
  runDataCompatibilityBackfill,
} from "../backfillDataCompatibility";

const buildLegacyLiveState = () => ({
  sequence: 0,
  occurredAt: new Date("2025-01-01T12:00:00.000Z").toISOString(),
  kickoffAt: new Date("2025-01-01T12:00:00.000Z").toISOString(),
  minute: 0,
  homeScore: 0,
  awayScore: 0,
  bettingStatus: BettingStatus.OPEN,
  incidentHistory: [],
  currentMarkets: [],
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MONGO_URI;
});

it("supports dry-run, batched apply, terminal preservation, and idempotence", async () => {
  await Event.collection.insertMany([
    {
      eventId: "legacy-event",
      name: "Legacy",
      time: new Date("2025-01-01T12:00:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: buildLegacyLiveState(),
    },
    {
      eventId: "active-event",
      name: "Active",
      time: new Date("2025-01-01T12:10:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        ...buildLegacyLiveState(),
        sequence: 3,
        phase: EventPhase.FIRST_HALF,
        minute: 17,
        homeScore: 1,
      },
    },
    {
      eventId: "resulted-event",
      name: "Resulted",
      time: new Date("2025-01-01T10:00:00.000Z"),
      status: EventStatus.RESULTED,
      visibility: EventVisibility.OFFLINE,
      products: [],
      live: {
        ...buildLegacyLiveState(),
        sequence: 5,
        minute: 90,
        homeScore: 2,
        awayScore: 1,
      },
    },
  ]);

  const dryRun = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(dryRun.changed).toBe(0);
  expect(dryRun.matched).toBe(1);

  const applied = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(applied.changed).toBe(1);

  const legacyEvent = await Event.findOne({ eventId: "legacy-event" }).lean();
  expect((legacyEvent?.live as { phase?: EventPhase }).phase).toBe(
    EventPhase.PRE_MATCH
  );

  const activeEvent = await Event.findOne({ eventId: "active-event" }).lean();
  expect((activeEvent?.live as { phase?: EventPhase }).phase).toBe(
    EventPhase.FIRST_HALF
  );

  const resultedEvent = await Event.findOne({ eventId: "resulted-event" }).lean();
  expect((resultedEvent?.live as { phase?: EventPhase }).phase).toBeUndefined();

  const idempotent = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(idempotent.changed).toBe(0);
});

it("uses defaults and skips documents without live state, with a phase, or with a positive string sequence", async () => {
  await Event.collection.insertMany([
    {
      eventId: "missing-live",
      name: "Missing live",
      time: new Date("2025-01-01T12:00:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
    },
    {
      eventId: "phase-present",
      name: "Phase present",
      time: new Date("2025-01-01T12:05:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        ...buildLegacyLiveState(),
        phase: EventPhase.FIRST_HALF,
      },
    },
    {
      eventId: "string-sequence",
      name: "String sequence",
      time: new Date("2025-01-01T12:10:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        ...buildLegacyLiveState(),
        sequence: "2",
      },
    },
  ]);

  const report = await runDataCompatibilityBackfill();

  expect(report).toMatchObject({
    mode: "dry-run",
    batchSize: 100,
    scanned: 3,
    matched: 0,
    changed: 0,
    skipped: 3,
  });
});

it("parses supported CLI arguments and rejects invalid forms", () => {
  expect(parseBackfillArgs([])).toEqual({ apply: false, batchSize: 100 });
  expect(parseBackfillArgs(["--apply", "--batch-size", "5"])).toEqual({
    apply: true,
    batchSize: 5,
  });
  expect(parseBackfillArgs(["--batch-size=7"])).toEqual({
    apply: false,
    batchSize: 7,
  });

  expect(() => parseBackfillArgs(["--batch-size"])).toThrow(
    "Missing value for --batch-size"
  );
  expect(() => parseBackfillArgs(["--batch-size", "0"])).toThrow(
    "Invalid --batch-size value: 0"
  );
  expect(() => parseBackfillArgs(["--unknown"])).toThrow(
    "Unknown argument: --unknown"
  );
});

it("runs the CLI with mocked connect/disconnect and logs the generated report", async () => {
  process.env.MONGO_URI = "mongodb://unused/test";
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
  };
  jest.spyOn(mongoose, "connect").mockResolvedValue(mongoose as any);
  jest.spyOn(mongoose, "disconnect").mockResolvedValue(undefined as never);

  await Event.collection.insertOne({
    eventId: "cli-event",
    name: "CLI",
    time: new Date("2025-01-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: buildLegacyLiveState(),
  });

  const report = await runBackfillCli(["--apply", "--batch-size=1"], logger);

  expect(report.mode).toEqual("apply");
  expect(report.batchSize).toEqual(1);
  expect(report.changed).toEqual(1);
  expect(mongoose.connect).toHaveBeenCalledWith("mongodb://unused/test");
  expect(mongoose.disconnect).toHaveBeenCalledTimes(1);
  expect(logger.log).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
});

it("fails fast when the CLI is missing MONGO_URI", async () => {
  await expect(runBackfillCli([], { log: jest.fn(), error: jest.fn() })).rejects.toThrow(
    "Missing MONGO_URI variable"
  );
});
