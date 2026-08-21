import { BetKind, SlipStatus } from "@betstan/common";
import {
  Slip,
  SLIP_DRAFT_UNIQUE_INDEX_KEYS,
  SLIP_DRAFT_UNIQUE_INDEX_NAME,
  SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
} from "../../model/Slip";
import { runDataCompatibilityBackfill } from "../backfillDataCompatibility";
import { ensureSlipDraftIndex } from "../ensureDraftIndexes";

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
