import mongoose from "mongoose";
import { EventPhase, EventStatus } from "@betstan/common";
import { Event } from "../../model/Event";
import { EventArchive } from "../../model/EventArchive";
import {
  parseBackfillArgs,
  runBackfillCli,
  runDataCompatibilityBackfill,
} from "../backfillDataCompatibility";

describe("parseBackfillArgs", () => {
  it("parses default, explicit, and inline batch-size options", () => {
    const originalArgv = process.argv;
    process.argv = ["node", "backfill-script"];

    try {
      expect(parseBackfillArgs()).toEqual({ apply: false, batchSize: 100 });
    } finally {
      process.argv = originalArgv;
    }

    expect(parseBackfillArgs(["--apply", "--batch-size", "25"])).toEqual({
      apply: true,
      batchSize: 25,
    });
    expect(parseBackfillArgs(["--batch-size=7"])).toEqual({
      apply: false,
      batchSize: 7,
    });
  });

  it("rejects missing, invalid, and unknown arguments", () => {
    expect(() => parseBackfillArgs(["--batch-size"])).toThrow(
      "Missing value for --batch-size"
    );
    expect(() => parseBackfillArgs(["--batch-size", "0"])).toThrow(
      "Invalid --batch-size value: 0"
    );
    expect(() => parseBackfillArgs(["--batch-size=not-a-number"])).toThrow(
      "Invalid --batch-size value: not-a-number"
    );
    expect(() => parseBackfillArgs(["--mystery-flag"])).toThrow(
      "Unknown argument: --mystery-flag"
    );
  });
});

it("supports dry-run, batched apply, active/archive coverage, terminal preservation, and idempotence", async () => {
  await Event.collection.insertMany([
    {
      eventId: "legacy-event",
      name: "Legacy",
      time: new Date("2025-01-01T12:00:00.000Z"),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      liveConfirmedReplayCursor: 0,
    },
    {
      eventId: "active-event",
      name: "Active",
      time: new Date("2025-01-01T12:10:00.000Z"),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      phase: EventPhase.FIRST_HALF,
      liveConfirmedReplayCursor: 2,
    },
  ]);

  await EventArchive.collection.insertMany([
    {
      eventId: "archive-legacy",
      name: "Archive legacy",
      time: new Date("2025-01-01T11:00:00.000Z").toISOString(),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      liveConfirmedReplayCursor: 0,
    },
    {
      eventId: "archive-resulted",
      name: "Archive resulted",
      time: new Date("2025-01-01T10:00:00.000Z").toISOString(),
      home: "A",
      away: "B",
      status: EventStatus.RESULTED,
      resultPublishedAt: new Date("2025-01-01T12:00:00.000Z"),
    },
  ]);

  const dryRun = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(dryRun.changed).toBe(0);
  expect(dryRun.matched).toBe(2);

  const applied = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(applied.changed).toBe(2);

  const legacyEvent = await Event.findOne({ eventId: "legacy-event" }).lean();
  expect(legacyEvent?.phase).toBe(EventPhase.PRE_MATCH);

  const activeEvent = await Event.findOne({ eventId: "active-event" }).lean();
  expect(activeEvent?.phase).toBe(EventPhase.FIRST_HALF);

  const archiveLegacy = await EventArchive.findOne({ eventId: "archive-legacy" }).lean();
  expect(archiveLegacy?.phase).toBe(EventPhase.PRE_MATCH);

  const archiveResulted = await EventArchive.findOne({ eventId: "archive-resulted" }).lean();
  expect(archiveResulted?.phase).toBeUndefined();

  const idempotent = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(idempotent.changed).toBe(0);
});

it("preserves phased, published, and replayed documents while defaulting legacy zero-cursor rows", async () => {
  await Event.collection.insertMany([
    {
      eventId: "already-phased",
      name: "Already phased",
      time: new Date("2025-01-01T12:00:00.000Z"),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      phase: EventPhase.SECOND_HALF,
      liveConfirmedReplayCursor: 0,
    },
    {
      eventId: "published-result",
      name: "Published result",
      time: new Date("2025-01-01T12:10:00.000Z"),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      resultPublishedAt: new Date("2025-01-01T12:30:00.000Z"),
      liveConfirmedReplayCursor: 0,
    },
    {
      eventId: "replayed-string-cursor",
      name: "Replayed string cursor",
      time: new Date("2025-01-01T12:20:00.000Z"),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      liveConfirmedReplayCursor: "2",
    },
    {
      eventId: "legacy-string-zero",
      name: "Legacy string zero",
      time: new Date("2025-01-01T12:30:00.000Z"),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      liveConfirmedReplayCursor: "0",
    },
  ]);

  const report = await runDataCompatibilityBackfill();
  expect(report.mode).toBe("dry-run");
  expect(report.batchSize).toBe(100);
  expect(report.matched).toBe(1);
  expect(report.changed).toBe(0);

  const applied = await runDataCompatibilityBackfill({ apply: true });
  expect(applied.changed).toBe(1);
  expect(applied.collection).toBe("all");
  expect(applied.collections).toHaveLength(2);

  const alreadyPhased = await Event.findOne({ eventId: "already-phased" }).lean();
  expect(alreadyPhased?.phase).toBe(EventPhase.SECOND_HALF);

  const published = await Event.findOne({ eventId: "published-result" }).lean();
  expect(published?.phase).toBeUndefined();

  const replayed = await Event.findOne({ eventId: "replayed-string-cursor" }).lean();
  expect(replayed?.phase).toBeUndefined();

  const legacy = await Event.findOne({ eventId: "legacy-string-zero" }).lean();
  expect(legacy?.phase).toBe(EventPhase.PRE_MATCH);
});

describe("runBackfillCli", () => {
  it("rejects missing Mongo configuration", async () => {
    const originalMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;

    try {
      await expect(runBackfillCli([])).rejects.toThrow("Missing MONGO_URI variable");
    } finally {
      if (originalMongoUri === undefined) {
        delete process.env.MONGO_URI;
      } else {
        process.env.MONGO_URI = originalMongoUri;
      }
    }
  });

  it("connects, logs the report, and disconnects on success", async () => {
    const originalMongoUri = process.env.MONGO_URI;
    process.env.MONGO_URI = "mongodb://example.test/gamemaster";

    await Event.create({
      eventId: new mongoose.Types.ObjectId().toHexString(),
      name: "CLI legacy",
      time: new Date("2025-01-01T12:00:00.000Z"),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      liveConfirmedReplayCursor: 0,
    });

    const connectSpy = jest.spyOn(mongoose, "connect").mockResolvedValue(mongoose);
    const disconnectSpy = jest
      .spyOn(mongoose, "disconnect")
      .mockResolvedValue(undefined);
    const logger = {
      log: jest.fn(),
      error: jest.fn(),
    };

    try {
      const report = await runBackfillCli(["--apply", "--batch-size=2"], logger);
      expect(connectSpy).toHaveBeenCalledWith("mongodb://example.test/gamemaster");
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      expect(report.mode).toBe("apply");
      expect(report.changed).toBe(1);
      expect(logger.log).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
    } finally {
      connectSpy.mockRestore();
      disconnectSpy.mockRestore();
      if (originalMongoUri === undefined) {
        delete process.env.MONGO_URI;
      } else {
        process.env.MONGO_URI = originalMongoUri;
      }
    }
  });
});
