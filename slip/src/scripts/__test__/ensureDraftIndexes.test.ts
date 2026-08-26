import mongoose from "mongoose";
import { BetKind, SlipStatus } from "@betstan/common";
import {
  Slip,
  SLIP_DRAFT_UNIQUE_INDEX_KEYS,
  SLIP_DRAFT_UNIQUE_INDEX_NAME,
  SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
} from "../../model/Slip";
import { runDataCompatibilityBackfill } from "../backfillDataCompatibility";
import {
  ensureSlipDraftIndex,
  parseEnsureArgs,
  runEnsureDraftIndexCli,
  scanDraftNormalization,
} from "../ensureDraftIndexes";

const buildLegacyDraft = (userId: string) => ({
  userId,
  status: SlipStatus.DRAFT,
  timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
  rows: [
    {
      eventId: `${userId}-event`,
      eventName: `${userId} event`,
      oddsId: `${userId}-odds`,
      oddsValue: 1.5,
      oddsName: "Home",
      productName: "1X2",
      productId: `${userId}-product`,
      timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
    },
  ],
});

const guardedIndex = async () =>
  (await Slip.collection.indexes()).find(
    (index) => index.name === SLIP_DRAFT_UNIQUE_INDEX_NAME
  );

beforeEach(async () => {
  const indexes = await Slip.collection.indexes();
  for (const index of indexes) {
    if (index.name !== "_id_") {
      await Slip.collection.dropIndex(index.name);
    }
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MONGO_URI;
  process.exitCode = 0;
});

it("keeps the guarded unique index absent until the explicit phase and refuses duplicate draft groups", async () => {
  await expect(
    Slip.collection.insertMany([
      buildLegacyDraft("duplicate-user"),
      buildLegacyDraft("duplicate-user"),
    ])
  ).resolves.toBeDefined();

  expect(await guardedIndex()).toBeUndefined();

  const applied = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(applied.changed).toBe(2);
  expect(applied.duplicateDrafts).toHaveLength(1);
  expect(await guardedIndex()).toBeUndefined();

  const storedDrafts = await Slip.find({ userId: "duplicate-user" }).lean();
  expect(storedDrafts).toHaveLength(2);
  expect(storedDrafts.every((slip) => slip.betKind === BetKind.PRE_MATCH)).toBe(
    true
  );
  expect(storedDrafts.every((slip) => typeof slip.draftKey === "undefined")).toBe(
    true
  );

  const report = await ensureSlipDraftIndex({ apply: true });
  expect(report.ready).toBe(false);
  expect(report.changed).toBe(0);
  expect(report.existingIndex).toBe("missing");
  expect(report.blocking.duplicateGroupCount).toBe(1);
  expect(report.blocking.duplicateDraftCount).toBe(2);
  expect(report.blocking.unnormalizedDraftCount).toBe(2);
  expect(await guardedIndex()).toBeUndefined();
});

it("refuses apply while even a single active draft remains unbackfilled", async () => {
  await Slip.collection.insertOne(buildLegacyDraft("single-user"));

  const report = await ensureSlipDraftIndex({ apply: true });
  expect(report.ready).toBe(false);
  expect(report.changed).toBe(0);
  expect(report.matched).toBe(1);
  expect(report.blocking.missingBetKindCount).toBe(1);
  expect(report.blocking.missingDraftKeyCount).toBe(1);
  expect(report.blocking.missingRowKindCount).toBe(1);
  expect(report.blocking.unnormalizedDraftCount).toBe(1);
  expect(await guardedIndex()).toBeUndefined();
});

it("creates the exact guarded index only after normalization and keeps repeated apply safe", async () => {
  await Slip.collection.insertOne(buildLegacyDraft("normalized-user"));

  const applied = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(applied.changed).toBe(1);
  expect(await guardedIndex()).toBeUndefined();

  const created = await ensureSlipDraftIndex({ apply: true });
  expect(created.ready).toBe(true);
  expect(created.changed).toBe(1);
  expect(created.existingIndex).toBe("missing");

  const index = await guardedIndex();
  expect(index).toBeTruthy();
  expect(index?.key).toEqual(SLIP_DRAFT_UNIQUE_INDEX_KEYS);
  expect(index?.partialFilterExpression).toEqual(
    SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER
  );

  const repeated = await ensureSlipDraftIndex({ apply: true });
  expect(repeated.ready).toBe(true);
  expect(repeated.changed).toBe(0);
  expect(repeated.existingIndex).toBe("matching");
});

it("creates the guarded index when the slips collection does not exist yet", async () => {
  await Slip.collection.drop();

  const report = await ensureSlipDraftIndex({ apply: true });

  expect(report.ready).toBe(true);
  expect(report.scanned).toBe(0);
  expect(report.changed).toBe(1);
  expect(report.existingIndex).toBe("missing");
  expect(await guardedIndex()).toBeTruthy();
});

it("fails closed when a conflicting guarded index shape already exists", async () => {
  await Slip.collection.insertOne({
    ...buildLegacyDraft("conflict-user"),
    betKind: BetKind.PRE_MATCH,
    draftKey: BetKind.PRE_MATCH,
    rows: [
      {
        ...buildLegacyDraft("conflict-user").rows[0],
        betKind: BetKind.PRE_MATCH,
      },
    ],
  });

  await Slip.collection.createIndex(SLIP_DRAFT_UNIQUE_INDEX_KEYS, {
    name: SLIP_DRAFT_UNIQUE_INDEX_NAME,
    unique: true,
    partialFilterExpression: {
      status: SlipStatus.DRAFT,
    },
  });

  const report = await ensureSlipDraftIndex({ apply: true });
  expect(report.ready).toBe(false);
  expect(report.changed).toBe(0);
  expect(report.existingIndex).toBe("conflicting");
  expect(report.blocking.unnormalizedDraftCount).toBe(0);
});

it("counts invalid, mismatched, and duplicate draft blockers during readiness scanning", async () => {
  await Slip.collection.insertMany([
    buildLegacyDraft("duplicate-user"),
    buildLegacyDraft("duplicate-user"),
    {
      userId: "invalid-user",
      status: SlipStatus.DRAFT,
      timestamp: new Date("2025-01-01T12:10:00.000Z").toISOString(),
      betKind: "INVALID",
      draftKey: "INVALID",
      rows: [
        {
          ...buildLegacyDraft("invalid-user").rows[0],
          betKind: "INVALID",
        },
      ],
    },
    {
      userId: "mismatch-user",
      status: SlipStatus.DRAFT,
      timestamp: new Date("2025-01-01T12:20:00.000Z").toISOString(),
      betKind: BetKind.PRE_MATCH,
      draftKey: BetKind.LIVE,
      rows: [
        {
          ...buildLegacyDraft("mismatch-user").rows[0],
          betKind: BetKind.LIVE,
        },
        "ignored-row",
      ],
    },
    {
      userId: "missing-row-kind-user",
      status: SlipStatus.DRAFT,
      timestamp: new Date("2025-01-01T12:30:00.000Z").toISOString(),
      betKind: BetKind.PRE_MATCH,
      draftKey: BetKind.PRE_MATCH,
      rows: [buildLegacyDraft("missing-row-kind-user").rows[0]],
    },
  ]);

  const counts = await scanDraftNormalization();
  expect(counts.draftCount).toBe(5);
  expect(counts.duplicateGroupCount).toBe(1);
  expect(counts.duplicateDraftCount).toBe(2);
  expect(counts.missingBetKindCount).toBe(2);
  expect(counts.invalidBetKindCount).toBe(1);
  expect(counts.missingDraftKeyCount).toBe(2);
  expect(counts.invalidDraftKeyCount).toBe(1);
  expect(counts.mismatchedDraftKeyCount).toBe(1);
  expect(counts.missingRowKindCount).toBe(3);
  expect(counts.invalidRowKindCount).toBe(1);
  expect(counts.mismatchedRowKindCount).toBe(1);
  expect(counts.unnormalizedDraftCount).toBe(5);
});

it("treats malformed named indexes and same-shape unnamed indexes as conflicting", async () => {
  const indexesSpy = jest.spyOn(Slip.collection, "indexes");

  indexesSpy.mockResolvedValueOnce([
    { name: SLIP_DRAFT_UNIQUE_INDEX_NAME, unique: false },
  ] as any);
  expect((await ensureSlipDraftIndex()).existingIndex).toBe("conflicting");

  indexesSpy.mockResolvedValueOnce([
    {
      name: SLIP_DRAFT_UNIQUE_INDEX_NAME,
      unique: true,
      key: { status: 1, draftKey: 1 },
      partialFilterExpression: SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
    },
  ] as any);
  expect((await ensureSlipDraftIndex()).existingIndex).toBe("conflicting");

  indexesSpy.mockResolvedValueOnce([
    {
      name: SLIP_DRAFT_UNIQUE_INDEX_NAME,
      unique: true,
      key: {
        userId: 1,
        status: 1,
        draftKey: 1,
      },
      partialFilterExpression: {
        status: SlipStatus.COMPLETE,
        draftKey: { $type: "string" },
      },
    },
  ] as any);
  expect((await ensureSlipDraftIndex()).existingIndex).toBe("conflicting");

  indexesSpy.mockResolvedValueOnce([
    {
      name: SLIP_DRAFT_UNIQUE_INDEX_NAME,
      unique: true,
      key: SLIP_DRAFT_UNIQUE_INDEX_KEYS,
      partialFilterExpression: {
        status: SlipStatus.DRAFT,
        draftKey: { $type: "number" },
      },
    },
  ] as any);
  expect((await ensureSlipDraftIndex()).existingIndex).toBe("conflicting");

  indexesSpy.mockResolvedValueOnce([
    {
      name: "other_name",
      unique: true,
      key: SLIP_DRAFT_UNIQUE_INDEX_KEYS,
    },
  ] as any);
  expect((await ensureSlipDraftIndex()).existingIndex).toBe("conflicting");
});

it("parses ensure args and runs the CLI with fail-closed reporting", async () => {
  expect(parseEnsureArgs([])).toEqual({ apply: false });
  expect(parseEnsureArgs(["--apply"])).toEqual({ apply: true });
  expect(() => parseEnsureArgs(["--unknown"])).toThrow("Unknown argument");

  await expect(runEnsureDraftIndexCli([], console)).rejects.toThrow(
    "Missing MONGO_URI variable"
  );

  await Slip.collection.insertOne(buildLegacyDraft("cli-user"));

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

  const report = await runEnsureDraftIndexCli([], logger);
  expect(report.ready).toBe(false);
  expect(process.exitCode).toBe(1);
  expect(connectSpy).toHaveBeenCalledWith(process.env.MONGO_URI, {
    autoIndex: false,
  });
  expect(disconnectSpy).toHaveBeenCalled();
  expect(logger.log).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
});
