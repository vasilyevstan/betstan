import mongoose from "mongoose";
import { BetKind, ResultingStatus } from "@betstan/common";
import { Bet, BetArchive } from "../../model/Bet";
import {
  AccountingSnapshot, AccountingSnapshotPageRecord, acknowledgeAccountingSnapshotPage,
  createAccountingSnapshot, readAccountingSnapshotPage,
} from "../../service/accountingSnapshot";
import * as fence from "../../service/accountingSnapshotFence";
import { accountingPlacementState } from "../../service/betAccounting";
import { cashBackHash } from "../../service/cashBackIdentity";
import { createPlaceBetEvent } from "../../test/resultingTestUtils";
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
      autoCreate: false,
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

it("diagnoses every sealed page without changing financial records or the acknowledgement cursor", async () => {
  const check = jest.spyOn(fence, "verifyAccountingSnapshotFence").mockResolvedValue({
    namespace: "test-only", operationId: "test-bootstrap", sourceSha: "a".repeat(40),
    generation: "1", identityHash: "b".repeat(64),
  });
  try {
    await Bet.collection.insertMany(Array.from({ length: 51 }, (_, number) => ({
      userId: "private-source-owner", slipId: `private-slip-${number}`,
      status: ResultingStatus.BET_APPROVED, wager: 10, betKind: BetKind.PRE_MATCH,
      timestamp: "2020-01-01T00:00:00.000Z", rows: [buildRow(`private-row-${number}`)],
    })));
    const event = createPlaceBetEvent({ slipId: "known-open", userId: "private-source-owner" });
    await Bet.create({
      ...event.data, ...accountingPlacementState(event.data),
      timestamp: "2020-01-01T00:00:00.000Z", status: ResultingStatus.BET_APPROVED,
    });
    const manifest = await createAccountingSnapshot("risk_101_1", "2019-01-01T00:00:00.000Z");
    const first = (await readAccountingSnapshotPage(manifest.snapshotId, 1))!;
    await acknowledgeAccountingSnapshotPage(manifest.snapshotId, 1, first.hash);
    const jobBefore = await AccountingSnapshot.findById(manifest.snapshotId).lean();
    const bookBefore = await Bet.collection.find({}).sort({ _id: 1 }).toArray();
    check.mockRejectedValue(new Error("Original maintenance was released"));
    const update = jest.spyOn(AccountingSnapshot, "updateOne");
    const report = await runDataCompatibilityBackfill({ batchSize: 1 });
    expect(report.accountingSnapshot).toEqual({
      status: "SEALED_SNAPSHOT_DIAGNOSED", snapshotId: manifest.snapshotId,
      cutAt: manifest.cutAt, manifestHash: cashBackHash(manifest), openPositions: "UNAVAILABLE",
      positions: 52, movements: 0, unavailableOpenPositions: 51, unavailableHistories: 51,
      missingEvidence: { scope: 51, placement: 51, principal: 51, other: 0 },
      sourceEvidence: {
        matchedCut: 51, changedSinceCut: 0, missingSource: 0, missingBasis: 51,
        originalManifestPresent: 0, principalSnapshotPresent: 0,
        accountingReasons: {
          NOT_RECORDED: 51, COMPLETE: 0, HISTORY_MISSING: 0, AUTHORITY_UNAVAILABLE: 0,
          LEGACY_PRECISION_UNSUPPORTED: 0, AMOUNT_UNSUPPORTED: 0, INVALID: 0,
        },
      },
    });
    expect(update).not.toHaveBeenCalled();
    expect(await AccountingSnapshot.findById(manifest.snapshotId).lean()).toEqual(jobBefore);
    expect(await Bet.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(bookBefore);
    expect(JSON.stringify(report)).not.toMatch(/private-source-owner|private-slip|private-row|wager|originalStakeMinor/);
  } finally {
    jest.restoreAllMocks();
  }
});

it("reports only exact-cut stored reasons and authority presence, not changed or missing sources", async () => {
  jest.spyOn(fence, "verifyAccountingSnapshotFence").mockResolvedValue({
    namespace: "test-only", operationId: "test-bootstrap", sourceSha: "a".repeat(40),
    generation: "1", identityHash: "b".repeat(64),
  });
  try {
    await Bet.collection.insertMany(["legacy", "precision", "changed", "missing"].map(slipId => ({
      userId: "private-source-owner", slipId, status: ResultingStatus.BET_APPROVED,
      wager: slipId === "precision" ? 10.123 : 10, betKind: BetKind.PRE_MATCH,
      timestamp: "2020-01-01T00:00:00.000Z", rows: [buildRow(`private-${slipId}`)],
      ...(slipId === "precision" ? {
        accounting: { schemaVersion: 1, status: "UNAVAILABLE", reason: "LEGACY_PRECISION_UNSUPPORTED" },
        cashBackOriginalManifest: { fingerprint: "a".repeat(64), selections: [] },
        cashBackFinancial: { revision: 0 },
      } : {}),
    })));
    await createAccountingSnapshot("risk_103_1", "2019-01-01T00:00:00.000Z");
    await Bet.collection.updateOne({ slipId: "changed" }, { $set: { wager: 11 } });
    await Bet.collection.deleteOne({ slipId: "missing" });
    const before = await Bet.collection.find({}).sort({ _id: 1 }).toArray();
    const report = await runDataCompatibilityBackfill();
    expect(report.accountingSnapshot).toMatchObject({
      sourceEvidence: {
        matchedCut: 2, changedSinceCut: 1, missingSource: 1, missingBasis: 2,
        originalManifestPresent: 1, principalSnapshotPresent: 1,
        accountingReasons: {
          NOT_RECORDED: 1, COMPLETE: 0, HISTORY_MISSING: 0, AUTHORITY_UNAVAILABLE: 0,
          LEGACY_PRECISION_UNSUPPORTED: 1, AMOUNT_UNSUPPORTED: 0, INVALID: 0,
        },
      },
    });
    expect(await Bet.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(JSON.stringify(report)).not.toMatch(/private-source-owner|private-legacy|selections|wager/);
  } finally {
    jest.restoreAllMocks();
  }
});

it("rejects a hash-valid broken page chain without changing the existing apply path", async () => {
  jest.spyOn(fence, "verifyAccountingSnapshotFence").mockResolvedValue({
    namespace: "test-only", operationId: "test-bootstrap", sourceSha: "a".repeat(40),
    generation: "1", identityHash: "b".repeat(64),
  });
  try {
    const event = createPlaceBetEvent({ slipId: "chain" });
    await Bet.create({
      ...event.data, ...accountingPlacementState(event.data),
      timestamp: "2020-01-01T00:00:00.000Z", status: ResultingStatus.BET_APPROVED,
    });
    await createAccountingSnapshot("risk_102_1", "2019-01-01T00:00:00.000Z");
    const { hash, ...payload } = (await readAccountingSnapshotPage("risk_102_1", 1))!;
    payload.previousHash = "c".repeat(64);
    await AccountingSnapshotPageRecord.updateOne({ snapshotId: "risk_102_1", page: 1 }, {
      $set: { data: { ...payload, hash: cashBackHash(payload) } },
    });
    await expect(runDataCompatibilityBackfill()).rejects.toThrow("page integrity or budget failed");
    expect((await runDataCompatibilityBackfill({ apply: true })).accountingSnapshot).toBeUndefined();
  } finally {
    jest.restoreAllMocks();
  }
});
