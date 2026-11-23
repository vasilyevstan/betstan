import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ResultingStatus } from "@betstan/common";
import { Bet, BetArchive } from "../../model/Bet";
import { CashBackOperation } from "../../model/CashBackOperation";
import { AccountingMovement } from "../../service/accountingHistory";
import * as fence from "../../service/accountingSnapshotFence";
import { cashBackHash } from "../../service/cashBackIdentity";
import { createPlaceBetEvent, createPreMatchRow } from "../../test/resultingTestUtils";
import { applyLegacyAccounting, planLegacyAccounting, prepareLegacyAccounting } from "../reconcileLegacyAccounting";

process.env.CASH_BACK_INTEGRATION = "1";
const SHA = "a".repeat(40);
const authority: fence.AccountingSnapshotFence = {
  sourceSha: SHA, namespace: "test-only", operationId: "live-data-reconcile-risk-accounting",
  generation: "1", identityHash: "b".repeat(64),
};
let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([Bet.init(), BetArchive.init(), AccountingMovement.init(), CashBackOperation.init()]);
});
beforeEach(async () => {
  for (const collection of await mongoose.connection.db.collections()) await collection.deleteMany({});
  process.env.GITHUB_ACTIONS = "true";
  process.env.SOURCE_SHA = SHA;
  process.env.PHASE = "reconcile-risk-accounting";
  process.env.OPERATION_ID = "live-data-reconcile-risk-accounting";
  jest.spyOn(fence, "verifyAccountingSnapshotFence").mockResolvedValue(authority);
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const name of ["GITHUB_ACTIONS", "SOURCE_SHA", "PHASE", "OPERATION_ID"]) delete process.env[name];
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  delete process.env.CASH_BACK_INTEGRATION;
});
async function legacy(slipId = "legacy") {
  const event = createPlaceBetEvent({ slipId, userId: "source-owner", wager: 10,
    rows: [createPreMatchRow({ id: `${slipId}-row`, eventId: `${slipId}-event`, oddsValue: 2 })] });
  const bet = await Bet.create({ ...event.data, timestamp: "2020-01-01T00:00:00.000Z",
    status: ResultingStatus.BET_APPROVED });
  return { event, bet };
}
async function plan(records: Awaited<ReturnType<typeof legacy>>[]) {
  const packet = await prepareLegacyAccounting(SHA);
  const originals = packet.candidates.map(candidate => {
    const data = records.find(record => record.event.data.slipId === candidate.slipId)!.event.data;
    const terms = { wager: data.wager, betKind: data.betKind,
      rows: data.rows.map(({ id, eventId, productId, oddsId, oddsValue, betKind }) =>
        ({ id, eventId, productId, oddsId, oddsValue, betKind })) };
    const originalModerationFingerprint = cashBackHash({ userId: data.userId, slipId: data.slipId, ...terms });
    return { ...candidate, terms, originalModerationFingerprint,
      identityOrigin: "LEGACY_RECONCILIATION" as const,
      placementFingerprint: cashBackHash({ schemaVersion: 1, kind: "LEGACY_ACCOUNTING_BASIS",
        userId: data.userId, slipId: data.slipId, originalModerationFingerprint }) };
  });
  return planLegacyAccounting({ ...packet, originals });
}

it("preflights without writing, then atomically adds only proven missing accounting fields to all matching copies", async () => {
  const original = await legacy();
  const { _id, ...archive } = original.bet.toObject();
  await BetArchive.create(archive);
  const prepared = await plan([original]);
  expect(prepared.positions[0]).toMatchObject({ openExposure: "COMPLETE", history: "UNAVAILABLE" });
  expect(await Bet.findById(original.bet._id).lean()).toMatchObject({ wager: 10 });
  expect((await Bet.findById(original.bet._id).lean())?.accounting).toBeUndefined();
  const result = await applyLegacyAccounting(prepared);
  expect(result).toMatchObject({ applied: true, positions: 1, documents: 2, planHash: prepared.planHash });
  for (const model of [Bet, BetArchive]) {
    const stored = await model.findOne({ slipId: "legacy" }).lean();
    expect(stored?.accountingBasis).toMatchObject({
      originalStakeMinor: 1000, placementFingerprint: prepared.originals[0].placementFingerprint,
      legacyReconciliation: { identityOrigin: "LEGACY_RECONCILIATION", sourceSha: SHA, planHash: prepared.planHash },
    });
    expect(stored?.accountingBasis.placementFingerprint).not.toBe(cashBackHash(original.event.data));
    expect(stored?.wager).toBe(10);
    expect(stored?.rows.map(row => row.oddsValue)).toEqual([2]);
    expect(stored?.cashBackFinancial).toBeUndefined();
    expect(stored?.cashBackOriginalManifest).toBeUndefined();
    expect(stored?.accountingRevision).toBeUndefined();
  }
  expect(await AccountingMovement.countDocuments()).toBe(0);
  await expect(applyLegacyAccounting(prepared)).rejects.toThrow("LEGACY_SOURCE_CHANGED");
});

it("rejects changed Source copies and a stale plan before any accounting write", async () => {
  const original = await legacy();
  const prepared = await plan([original]);
  await Bet.updateOne({ slipId: "legacy" }, { $set: { wager: 11 } });
  await expect(applyLegacyAccounting(prepared)).rejects.toThrow("LEGACY_SOURCE_CHANGED");
  expect((await Bet.findOne({ slipId: "legacy" }).lean())?.accountingBasis).toBeUndefined();
  await BetArchive.create({ ...original.event.data, timestamp: "2020-01-01T00:00:00.000Z",
    status: ResultingStatus.BET_APPROVED });
  await expect(prepareLegacyAccounting(SHA)).rejects.toThrow("LEGACY_SOURCE_COPY_CONFLICT");
});

it.each([
  { accountingRevision: 0 },
  { accounting: { schemaVersion: 1, status: "UNAVAILABLE", reason: "HISTORY_MISSING" } },
  { cashBackFinancial: { revision: 0, status: "BET_APPROVED", originalStakeMinor: 1000,
    remainingStakeMinor: 1000, cumulativeClosedStakeMinor: 0, cumulativeReturnMinor: 0 } },
])("never overwrites partial financial authority (%j)", async fields => {
  await legacy();
  await Bet.updateOne({ slipId: "legacy" }, { $set: fields });
  await expect(prepareLegacyAccounting(SHA)).rejects.toThrow("LEGACY_EXISTING_FINANCIAL_AUTHORITY");
});

it("rejects retained movements and accepted or unresolved cash-back authority instead of assuming zero closures", async () => {
  await legacy();
  await AccountingMovement.collection.insertOne({ slipId: "legacy" });
  await expect(prepareLegacyAccounting(SHA)).rejects.toThrow("LEGACY_RETAINED_MOVEMENT_EXISTS");
  await AccountingMovement.deleteMany({});
  for (const operation of [
    { operation: { slipId: "legacy" }, stage: "TERMINAL", confirmRequested: true,
      outcome: { receipt: { outcome: "ACCEPTED" } } },
    { operation: { slipId: "legacy" }, stage: "QUOTED", confirmRequested: true },
    { operation: { slipId: "legacy" }, stage: "UNAVAILABLE", confirmRequested: false,
      outcome: { outcome: "ACCEPTED" } },
    { operation: { slipId: "legacy" }, stage: "UNAVAILABLE", confirmRequested: false,
      outcome: { outcome: "UNKNOWN" } },
    { operation: { slipId: "legacy" }, stage: "TERMINAL", confirmRequested: true,
      outcome: { outcome: "ACCEPTED", receipt: { outcome: "REJECTED" } } },
    { operation: { slipId: "legacy" }, stage: "QUOTED", confirmRequested: false,
      outcome: { outcome: "UNAVAILABLE" } },
  ]) {
    await CashBackOperation.collection.insertOne(operation);
    await expect(prepareLegacyAccounting(SHA)).rejects.toThrow("LEGACY_CASH_BACK_AUTHORITY_UNAVAILABLE");
    await CashBackOperation.deleteMany({});
  }
});

it("rejects original row or accepted-price disagreement without altering Source records", async () => {
  const original = await legacy();
  const prepared = await plan([original]);
  prepared.originals[0].terms.rows[0].oddsValue = 3;
  await expect(planLegacyAccounting(prepared)).rejects.toThrow("LEGACY_ORIGINAL_SOURCE_CONFLICT");
  expect((await Bet.findById(original.bet._id).lean())?.accountingBasis).toBeUndefined();
});

it("rolls back every metadata update if the physical fence changes inside the real transaction", async () => {
  const records = await Promise.all([legacy("first"), legacy("second")]);
  const prepared = await plan(records);
  (fence.verifyAccountingSnapshotFence as jest.Mock)
    .mockResolvedValueOnce(authority).mockResolvedValueOnce({ ...authority, identityHash: "c".repeat(64) });
  await expect(applyLegacyAccounting(prepared)).rejects.toThrow("LEGACY_FENCE_CHANGED");
  for (const record of await Bet.find({}).lean()) {
    expect(record.accountingBasis).toBeUndefined();
    expect(record.accounting).toBeUndefined();
  }
  expect(await Bet.countDocuments({ __v: 0 })).toBe(records.length);
});
