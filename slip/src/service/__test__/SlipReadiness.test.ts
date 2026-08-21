import { BetKind, SlipStatus } from "@betstan/common";
import {
  Slip,
  SLIP_DRAFT_UNIQUE_INDEX_NAME,
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
