import { BetKind, SlipStatus } from "@betstan/common";
import {
  Slip,
  SLIP_DRAFT_UNIQUE_INDEX_NAME,
  SLIP_GUEST_EXPIRY_INDEX_NAME,
  SLIP_GUEST_EXPIRY_INDEX_PARTIAL_FILTER,
} from "../../model/Slip";
import { runDataCompatibilityBackfill } from "../../scripts/backfillDataCompatibility";
import { ensureSlipReadyForTraffic } from "../SlipReadiness";

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

const buildNormalizedDraft = (userId: string) => ({
  ...buildLegacyDraft(userId),
  betKind: BetKind.PRE_MATCH,
  draftKey: BetKind.PRE_MATCH,
  rows: [
    {
      ...buildLegacyDraft(userId).rows[0],
      betKind: BetKind.PRE_MATCH,
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

it("fails startup closed when active drafts remain unbackfilled", async () => {
  await Slip.collection.insertOne(buildLegacyDraft("legacy-user"));

  await expect(ensureSlipReadyForTraffic()).rejects.toThrow(
    "Slip draft index guard failed"
  );
  expect(await guardedIndex()).toBeUndefined();
});

it("fails startup closed when duplicate draft ownership exists", async () => {
  await Slip.collection.insertMany([
    buildNormalizedDraft("duplicate-user"),
    buildNormalizedDraft("duplicate-user"),
  ]);

  await expect(ensureSlipReadyForTraffic()).rejects.toThrow(
    "Slip draft index guard failed"
  );
  expect(await guardedIndex()).toBeUndefined();
});

it("creates and then idempotently verifies the guarded draft index once data is safe", async () => {
  await Slip.collection.insertOne(buildLegacyDraft("normalized-user"));

  await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });

  const firstReport = await ensureSlipReadyForTraffic();
  expect(firstReport.ready).toBe(true);
  expect(firstReport.changed).toBe(1);
  expect(firstReport.existingIndex).toBe("missing");
  expect(await guardedIndex()).toBeTruthy();

  const secondReport = await ensureSlipReadyForTraffic();
  expect(secondReport.ready).toBe(true);
  expect(secondReport.changed).toBe(0);
  expect(secondReport.existingIndex).toBe("matching");
});

describe("guest expiry TTL index", () => {
  const guestExpiryIndexes = async () =>
    (await Slip.collection.indexes()).filter(
      (index) => index.name === SLIP_GUEST_EXPIRY_INDEX_NAME
    );

  it("is created next to the draft index at startup and repeated startups leave it alone", async () => {
    const firstReport = await ensureSlipReadyForTraffic();

    expect(firstReport.indexName).toBe(SLIP_DRAFT_UNIQUE_INDEX_NAME);
    expect(firstReport.changed).toBe(1);
    expect(await guardedIndex()).toBeTruthy();
    const [index, ...others] = await guestExpiryIndexes();
    expect(others).toHaveLength(0);
    expect(index.key).toEqual({ guestExpiresAt: 1 });
    expect(index.expireAfterSeconds).toBe(0);
    expect(index.partialFilterExpression).toEqual(
      SLIP_GUEST_EXPIRY_INDEX_PARTIAL_FILTER
    );

    const secondReport = await ensureSlipReadyForTraffic();

    expect(secondReport.changed).toBe(0);
    expect(secondReport.existingIndex).toBe("matching");
    const afterSecond = await guestExpiryIndexes();
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]).toEqual(index);
  });

  it("is created even when the draft index already exists from an earlier rollout", async () => {
    await ensureSlipReadyForTraffic();
    await Slip.collection.dropIndex(SLIP_GUEST_EXPIRY_INDEX_NAME);

    const report = await ensureSlipReadyForTraffic();

    expect(report.changed).toBe(0);
    expect(report.existingIndex).toBe("matching");
    expect(await guestExpiryIndexes()).toHaveLength(1);
  });

  it("fails startup closed and leaves a conflicting same-named index untouched", async () => {
    await Slip.collection.createIndex(
      { guestExpiresAt: 1 },
      {
        name: SLIP_GUEST_EXPIRY_INDEX_NAME,
        expireAfterSeconds: 5,
        partialFilterExpression: SLIP_GUEST_EXPIRY_INDEX_PARTIAL_FILTER,
      }
    );

    await expect(ensureSlipReadyForTraffic()).rejects.toThrow(
      "Slip guest expiry index guard failed"
    );

    const [index] = await guestExpiryIndexes();
    expect(index.expireAfterSeconds).toBe(5);
  });

  it("is not reached while the draft index guard is failing", async () => {
    await Slip.collection.insertOne(buildLegacyDraft("legacy-user"));

    await expect(ensureSlipReadyForTraffic()).rejects.toThrow(
      "Slip draft index guard failed"
    );
    expect(await guestExpiryIndexes()).toHaveLength(0);
  });
});
