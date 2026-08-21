import mongoose from "mongoose";
import { BetKind, ModerationStatus } from "@betstan/common";
import { Bet } from "../../model/Bet";
import { runDataCompatibilityBackfill } from "../backfillDataCompatibility";

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

it("supports dry-run, batched apply, explicit LIVE preservation, and idempotence", async () => {
  const legacySlipId = new mongoose.Types.ObjectId().toHexString();
  const liveSlipId = new mongoose.Types.ObjectId().toHexString();

  await Bet.collection.insertMany([
    {
      userId: "legacy-user",
      slipId: legacySlipId,
      status: ModerationStatus.RECEIVED,
      wager: 12,
      timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
      rows: [buildRow("legacy-row")],
      affectedRows: [],
    },
    {
      userId: "live-user",
      slipId: liveSlipId,
      status: ModerationStatus.APPROVED,
      wager: 18,
      timestamp: new Date("2025-01-01T12:05:00.000Z").toISOString(),
      betKind: BetKind.LIVE,
      rows: [
        buildRow("live-row-a"),
        buildRow("live-row-b", { betKind: BetKind.LIVE }),
      ],
      affectedRows: [],
    },
  ]);

  const dryRun = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(dryRun.changed).toBe(0);
  expect(dryRun.matched).toBe(2);

  const untouchedLegacy = await Bet.findOne({ slipId: legacySlipId }).lean();
  expect(untouchedLegacy?.betKind).toBeUndefined();
  expect((untouchedLegacy?.rows as Array<{ betKind?: BetKind }>)[0].betKind).toBeUndefined();

  const applied = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(applied.changed).toBe(2);

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

  const idempotent = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(idempotent.changed).toBe(0);
});
