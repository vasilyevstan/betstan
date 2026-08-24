import mongoose from "mongoose";
import { BetKind, SlipStatus } from "@betstan/common";
import { Slip, SlipArchive } from "../../model/Slip";
import {
  findDuplicateDrafts,
  parseBackfillArgs,
  runBackfillCli,
  runDataCompatibilityBackfill,
} from "../backfillDataCompatibility";

const buildRow = (id: string, overrides: Record<string, unknown> = {}) => ({
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

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MONGO_URI;
});

it("supports dry-run, batched apply, active/archive coverage, LIVE preservation, and idempotence", async () => {
  const legacySlipId = new mongoose.Types.ObjectId().toHexString();
  const liveSlipId = new mongoose.Types.ObjectId().toHexString();
  const archiveSlipId = new mongoose.Types.ObjectId().toHexString();

  await Slip.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(legacySlipId),
      userId: "legacy-user",
      status: SlipStatus.DRAFT,
      timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
      rows: [buildRow("legacy-row")],
    },
    {
      _id: new mongoose.Types.ObjectId(liveSlipId),
      userId: "live-user",
      status: SlipStatus.SUBMITTED,
      timestamp: new Date("2025-01-01T12:05:00.000Z").toISOString(),
      submittedAt: new Date("2025-01-01T12:05:05.000Z").toISOString(),
      betKind: BetKind.LIVE,
      draftKey: BetKind.LIVE,
      rows: [
        buildRow("live-row-a"),
        buildRow("live-row-b", { betKind: BetKind.LIVE }),
      ],
    },
  ]);

  await SlipArchive.collection.insertOne({
    _id: new mongoose.Types.ObjectId(archiveSlipId),
    userId: "archive-user",
    status: SlipStatus.COMPLETE,
    timestamp: new Date("2025-01-01T11:00:00.000Z").toISOString(),
    rows: [buildRow("archive-row")],
  });

  const dryRun = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(dryRun.changed).toBe(0);
  expect(dryRun.matched).toBe(3);

  const untouchedLegacy = await Slip.findById(legacySlipId).lean();
  expect(untouchedLegacy?.betKind).toBeUndefined();
  expect(untouchedLegacy?.draftKey).toBeUndefined();

  const applied = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(applied.changed).toBe(3);

  const legacySlip = await Slip.findById(legacySlipId).lean();
  expect(legacySlip?.betKind).toBe(BetKind.PRE_MATCH);
  expect(legacySlip?.draftKey).toBe(BetKind.PRE_MATCH);
  expect(legacySlip?.boardRevision).toBe(1);
  expect(legacySlip?.boardFingerprint).toEqual(expect.any(String));
  expect(legacySlip?.legacyBoardRevision).toBe(legacySlip?.boardRevision);
  expect(legacySlip?.legacyBoardFingerprint).toBe(
    legacySlip?.boardFingerprint
  );
  expect(legacySlip?.legacyBoardConfirmedAt).toEqual(expect.any(String));
  expect((legacySlip?.rows as Array<{ betKind?: BetKind }>)[0].betKind).toBe(
    BetKind.PRE_MATCH
  );

  const liveSlip = await Slip.findById(liveSlipId).lean();
  expect(liveSlip?.betKind).toBe(BetKind.LIVE);
  expect(
    (liveSlip?.rows as Array<{ betKind?: BetKind }>).map((row) => row.betKind)
  ).toEqual([BetKind.LIVE, BetKind.LIVE]);

  const archivedSlip = await SlipArchive.findById(archiveSlipId).lean();
  expect(archivedSlip?.betKind).toBe(BetKind.PRE_MATCH);
  expect(archivedSlip?.draftKey).toBe(BetKind.PRE_MATCH);
  expect((archivedSlip?.rows as Array<{ betKind?: BetKind }>)[0].betKind).toBe(
    BetKind.PRE_MATCH
  );

  const idempotent = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(idempotent.changed).toBe(0);
});

it("parses backfill args, infers duplicate kinds, and leaves duplicate draft keys untouched", async () => {
  expect(parseBackfillArgs([])).toEqual({ apply: false, batchSize: 100 });
  expect(parseBackfillArgs(["--apply", "--batch-size", "10"])).toEqual({
    apply: true,
    batchSize: 10,
  });
  expect(parseBackfillArgs(["--batch-size=5"])).toEqual({
    apply: false,
    batchSize: 5,
  });
  expect(() => parseBackfillArgs(["--batch-size"])).toThrow(
    "Missing value for --batch-size"
  );
  expect(() => parseBackfillArgs(["--batch-size=0"])).toThrow(
    "Invalid --batch-size value: 0"
  );
  expect(() => parseBackfillArgs(["--unknown"])).toThrow("Unknown argument");

  await Slip.collection.insertMany([
    {
      userId: "duplicate-live-user",
      status: SlipStatus.DRAFT,
      timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
      rows: [buildRow("duplicate-live-a", { betKind: BetKind.LIVE })],
    },
    {
      userId: "duplicate-live-user",
      status: SlipStatus.DRAFT,
      timestamp: new Date("2025-01-01T12:01:00.000Z").toISOString(),
      rows: [buildRow("duplicate-live-b", { betKind: BetKind.LIVE })],
    },
    {
      userId: "submitted-user",
      status: SlipStatus.SUBMITTED,
      timestamp: new Date("2025-01-01T12:10:00.000Z").toISOString(),
      rows: [buildRow("submitted-row")],
    },
  ]);

  const duplicateGroups = await findDuplicateDrafts();
  expect(duplicateGroups).toEqual([
    expect.objectContaining({
      userId: "duplicate-live-user",
      betKind: BetKind.LIVE,
      count: 2,
    }),
  ]);

  const report = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(report.duplicateDrafts).toHaveLength(1);

  const duplicateDrafts = await Slip.find({
    userId: "duplicate-live-user",
    status: SlipStatus.DRAFT,
  }).lean();
  expect(duplicateDrafts.every((slip) => typeof slip.draftKey === "undefined")).toBe(
    true
  );
  expect(
    duplicateDrafts.every(
      (slip) =>
        slip.legacyBoardRevision === slip.boardRevision
        && slip.legacyBoardFingerprint === slip.boardFingerprint
    )
  ).toBe(true);

  const submittedSlip = await Slip.findOne({
    userId: "submitted-user",
    status: SlipStatus.SUBMITTED,
  }).lean();
  expect(submittedSlip?.draftKey).toBe(BetKind.PRE_MATCH);
});

it("defensively maps aggregate duplicate results and runs the CLI when mongo is configured", async () => {
  const aggregateSpy = jest.spyOn(Slip.collection, "aggregate").mockReturnValue({
    toArray: async () => [
      {
        _id: {},
        count: "2",
        slipIds: null,
      },
      {
        _id: {
          userId: "explicit-user",
          betKind: BetKind.LIVE,
        },
        count: 3,
        slipIds: [new mongoose.Types.ObjectId()],
      },
    ],
  } as any);

  await expect(findDuplicateDrafts()).resolves.toEqual([
    {
      userId: "",
      betKind: BetKind.PRE_MATCH,
      count: 2,
      slipIds: [],
    },
    {
      userId: "explicit-user",
      betKind: BetKind.LIVE,
      count: 3,
      slipIds: [expect.any(String)],
    },
  ]);
  aggregateSpy.mockRestore();

  await expect(runBackfillCli([], console)).rejects.toThrow(
    "Missing MONGO_URI variable"
  );

  process.env.MONGO_URI = "mongodb://ignored-for-tests";
  const connectSpy = jest
    .spyOn(mongoose, "connect")
    .mockResolvedValue(mongoose as any);
  const disconnectSpy = jest
    .spyOn(mongoose, "disconnect")
    .mockResolvedValue(undefined as any);
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
  };

  const report = await runBackfillCli(["--apply", "--batch-size", "2"], logger);
  expect(report.mode).toBe("apply");
  expect(report.batchSize).toBe(2);
  expect(connectSpy).toHaveBeenCalledWith(process.env.MONGO_URI, {
    autoIndex: false,
  });
  expect(disconnectSpy).toHaveBeenCalled();
  expect(logger.log).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
});
