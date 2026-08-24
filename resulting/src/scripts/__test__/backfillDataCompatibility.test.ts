import mongoose from "mongoose";
import { BetKind, ResultingStatus } from "@betstan/common";
import { Bet, BetArchive } from "../../model/Bet";
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
  winningSelection: "",
  result: ResultingStatus.ROW_NO_RESULT,
  settlementPublicationState: "",
  pendingRemoval: false,
  ...overrides,
});

it("supports dry-run, batched apply, active/archive coverage, LIVE preservation, and idempotence", async () => {
  const legacySlipId = new mongoose.Types.ObjectId().toHexString();
  const liveSlipId = new mongoose.Types.ObjectId().toHexString();
  const archiveSlipId = new mongoose.Types.ObjectId().toHexString();

  await Bet.collection.insertMany([
    {
      userId: "legacy-user",
      slipId: legacySlipId,
      status: ResultingStatus.BET_PENDING,
      wager: 12,
      timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
      moderationTimestamp: "",
      resultingTimestamp: "",
      terminalPublicationState: "",
      rows: [buildRow("legacy-row")],
    },
    {
      userId: "live-user",
      slipId: liveSlipId,
      status: ResultingStatus.BET_APPROVED,
      wager: 18,
      timestamp: new Date("2025-01-01T12:05:00.000Z").toISOString(),
      moderationTimestamp: "",
      resultingTimestamp: "",
      terminalPublicationState: "",
      betKind: BetKind.LIVE,
      rows: [
        buildRow("live-row-a"),
        buildRow("live-row-b", { betKind: BetKind.LIVE }),
      ],
    },
  ]);

  await BetArchive.collection.insertOne({
    userId: "archive-user",
    slipId: archiveSlipId,
    status: ResultingStatus.BET_WIN,
    wager: 25,
    timestamp: new Date("2025-01-01T11:00:00.000Z").toISOString(),
    moderationTimestamp: "",
    resultingTimestamp: "2025-01-01T12:00:00.000Z",
    terminalPublicationState: "PUBLISHED",
    rows: [buildRow("archive-row")],
  });

  const dryRun = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(dryRun.changed).toBe(0);
  expect(dryRun.matched).toBe(3);

  const applied = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(applied.changed).toBe(3);

  const legacyBet = await Bet.findOne({ slipId: legacySlipId }).lean();
  expect(legacyBet?.betKind).toBe(BetKind.PRE_MATCH);
  expect((legacyBet?.rows as Array<{ betKind?: BetKind }>)[0].betKind).toBe(
    BetKind.PRE_MATCH
  );

  const liveBet = await Bet.findOne({ slipId: liveSlipId }).lean();
  expect(liveBet?.betKind).toBe(BetKind.LIVE);
  expect(
    (liveBet?.rows as Array<{ betKind?: BetKind }>).map((row) => row.betKind)
  ).toEqual([BetKind.LIVE, BetKind.LIVE]);

  const archivedBet = await BetArchive.findOne({ slipId: archiveSlipId }).lean();
  expect(archivedBet?.betKind).toBe(BetKind.PRE_MATCH);
  expect((archivedBet?.rows as Array<{ betKind?: BetKind }>)[0].betKind).toBe(
    BetKind.PRE_MATCH
  );

  const idempotent = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(idempotent.changed).toBe(0);
});

it("parses CLI arguments across supported forms", () => {
  expect(parseBackfillArgs([])).toEqual({
    apply: false,
    batchSize: 100,
  });
  expect(parseBackfillArgs(["--apply", "--batch-size", "25"])).toEqual({
    apply: true,
    batchSize: 25,
  });
  expect(parseBackfillArgs(["--batch-size=7"])).toEqual({
    apply: false,
    batchSize: 7,
  });
});

it.each([
  [["--batch-size"], "Missing value for --batch-size"],
  [["--batch-size", "0"], "Invalid --batch-size value: 0"],
  [["--batch-size=abc"], "Invalid --batch-size value: abc"],
  [["--unknown"], "Unknown argument: --unknown"],
])("rejects invalid CLI arguments %j", (argv, message) => {
  expect(() => parseBackfillArgs(argv)).toThrow(message);
});

it("skips already-normalized and malformed row payloads without forcing updates", async () => {
  const malformedSlipId = new mongoose.Types.ObjectId().toHexString();
  const normalizedSlipId = new mongoose.Types.ObjectId().toHexString();

  await Bet.collection.insertMany([
    {
      userId: "malformed-user",
      slipId: malformedSlipId,
      status: ResultingStatus.BET_PENDING,
      wager: 10,
      timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
      moderationTimestamp: "",
      resultingTimestamp: "",
      terminalPublicationState: "",
      rows: ["not-an-object", buildRow("live-fallback-row", { betKind: BetKind.LIVE })],
    },
    {
      userId: "normalized-user",
      slipId: normalizedSlipId,
      status: ResultingStatus.BET_PENDING,
      wager: 10,
      timestamp: new Date("2025-01-01T12:10:00.000Z").toISOString(),
      moderationTimestamp: "",
      resultingTimestamp: "",
      terminalPublicationState: "",
      betKind: BetKind.PRE_MATCH,
      rows: [buildRow("normalized-row", { betKind: BetKind.PRE_MATCH })],
    },
  ]);

  const report = await runDataCompatibilityBackfill({ apply: true, batchSize: 10 });
  const malformedBet = await Bet.findOne({ slipId: malformedSlipId }).lean();
  const normalizedBet = await Bet.findOne({ slipId: normalizedSlipId }).lean();

  expect(report.matched).toBe(1);
  expect(report.changed).toBe(1);
  expect(malformedBet?.betKind).toBe(BetKind.LIVE);
  expect((malformedBet?.rows as Array<{ betKind?: BetKind } | string>)[1]).toMatchObject({
    betKind: BetKind.LIVE,
  });
  expect(normalizedBet?.betKind).toBe(BetKind.PRE_MATCH);
  expect((normalizedBet?.rows as Array<{ betKind?: BetKind }>)[0].betKind).toBe(
    BetKind.PRE_MATCH
  );
});

it("runs the CLI with logging and disconnects even when collections are empty", async () => {
  const logger = {
    error: jest.fn(),
    log: jest.fn(),
  };
  const connectSpy = jest
    .spyOn(mongoose, "connect")
    .mockResolvedValue(mongoose as never);
  const disconnectSpy = jest
    .spyOn(mongoose, "disconnect")
    .mockResolvedValue(undefined);
  const previousMongoUri = process.env.MONGO_URI;
  process.env.MONGO_URI = "mongodb://resulting.test/backfill";

  try {
    const report = await runBackfillCli(["--apply", "--batch-size=2"], logger);

    expect(report.mode).toBe("apply");
    expect(report.batchSize).toBe(2);
    expect(report.collection).toBe("all");
    expect(connectSpy).toHaveBeenCalledWith(process.env.MONGO_URI, {
      autoIndex: false,
    });
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
  } finally {
    process.env.MONGO_URI = previousMongoUri;
  }
});

it("fails the CLI when MONGO_URI is missing", async () => {
  const previousMongoUri = process.env.MONGO_URI;
  delete process.env.MONGO_URI;

  try {
    await expect(runBackfillCli([])).rejects.toThrow("Missing MONGO_URI variable");
  } finally {
    process.env.MONGO_URI = previousMongoUri;
  }
});
