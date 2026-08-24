import mongoose from "mongoose";
import { BetKind, ModerationStatus } from "@betstan/common";
import { Bet } from "../../model/Bet";
import {
  parseBackfillArgs,
  runBackfillCli,
  runDataCompatibilityBackfill,
} from "../backfillDataCompatibility";

const buildRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  eventId: `${id}-event`,
  eventName: `${id} event`,
  oddsId: `${id}-odds`,
  oddsValue: 1.5,
  oddsName: "Home",
  productName: "1X2",
  productId: `${id}-product`,
  timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
  ...overrides,
});

it("parses backfill CLI arguments and rejects invalid forms", () => {
  const originalArgv = process.argv;

  process.argv = ["node", "backfill"];

  try {
    expect(parseBackfillArgs()).toEqual({ apply: false, batchSize: 100 });
  } finally {
    process.argv = originalArgv;
  }

  expect(
    parseBackfillArgs(["--apply", "--batch-size", "5"])
  ).toEqual({ apply: true, batchSize: 5 });
  expect(parseBackfillArgs(["--batch-size=7"])).toEqual({
    apply: false,
    batchSize: 7,
  });
  expect(() => parseBackfillArgs(["--batch-size"])).toThrow(
    "Missing value for --batch-size"
  );
  expect(() => parseBackfillArgs(["--batch-size=0"])).toThrow(
    "Invalid --batch-size value: 0"
  );
  expect(() => parseBackfillArgs(["--unknown"])).toThrow(
    "Unknown argument: --unknown"
  );
});

it("infers LIVE from legacy row kinds and defaults malformed snapshots to PRE_MATCH", async () => {
  const inferredLiveSlipId = new mongoose.Types.ObjectId().toHexString();
  const malformedSlipId = new mongoose.Types.ObjectId().toHexString();

  await Bet.collection.insertMany([
    {
      userId: "legacy-live-user",
      slipId: inferredLiveSlipId,
      status: ModerationStatus.RECEIVED,
      wager: 12,
      timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
      rows: [
        buildRow("legacy-live-row", { betKind: BetKind.LIVE }),
        buildRow("legacy-missing-row"),
      ],
      affectedRows: [],
    },
    {
      userId: "legacy-prematch-user",
      slipId: malformedSlipId,
      status: ModerationStatus.RECEIVED,
      wager: 15,
      timestamp: new Date("2025-01-01T12:05:00.000Z").toISOString(),
      rows: "not-an-array",
      affectedRows: [],
    },
  ]);

  const applied = await runDataCompatibilityBackfill({
    apply: true,
    batchSize: 10,
  });
  const inferredLiveBet = await Bet.findOne({ slipId: inferredLiveSlipId }).lean();
  const malformedBet = await Bet.collection.findOne({ slipId: malformedSlipId });

  expect(applied.changed).toBe(2);
  expect(inferredLiveBet?.betKind).toBe(BetKind.LIVE);
  expect(
    (inferredLiveBet?.rows as Array<{ betKind?: BetKind }>).map(
      (row) => row.betKind
    )
  ).toEqual([BetKind.LIVE, BetKind.LIVE]);
  expect(malformedBet?.betKind).toBe(BetKind.PRE_MATCH);
  expect(malformedBet?.rows).toBe("not-an-array");
});

it("runs the CLI backfill with logging and still disconnects on completion", async () => {
  const connectSpy = jest
    .spyOn(mongoose, "connect")
    .mockResolvedValue(mongoose as any);
  const disconnectSpy = jest
    .spyOn(mongoose, "disconnect")
    .mockResolvedValue(mongoose as any);
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
  };
  const previousMongoUri = process.env.MONGO_URI;

  process.env.MONGO_URI = "mongodb://memory";

  try {
    const report = await runBackfillCli(["--apply", "--batch-size=1"], logger);

    expect(report.mode).toBe("apply");
    expect(connectSpy).toHaveBeenCalledWith("mongodb://memory", {
      autoIndex: false,
    });
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('"mode": "apply"')
    );
  } finally {
    if (previousMongoUri === undefined) {
      delete process.env.MONGO_URI;
    } else {
      process.env.MONGO_URI = previousMongoUri;
    }
    connectSpy.mockRestore();
    disconnectSpy.mockRestore();
  }
});

it("requires MONGO_URI before running the CLI", async () => {
  const originalArgv = process.argv;
  const previousMongoUri = process.env.MONGO_URI;

  process.argv = ["node", "backfill"];
  delete process.env.MONGO_URI;

  try {
    await expect(runBackfillCli()).rejects.toThrow("Missing MONGO_URI variable");
  } finally {
    process.argv = originalArgv;
    if (previousMongoUri === undefined) {
      delete process.env.MONGO_URI;
    } else {
      process.env.MONGO_URI = previousMongoUri;
    }
  }
});
