import mongoose from "mongoose";
import { BetKind, SlipStatus } from "@betstan/common";
import { Slip, SlipArchive } from "../../model/Slip";
import { runDataCompatibilityBackfill } from "../backfillDataCompatibility";

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
