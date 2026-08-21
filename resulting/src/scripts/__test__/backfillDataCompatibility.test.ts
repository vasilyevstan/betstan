import mongoose from "mongoose";
import { BetKind, ResultingStatus } from "@betstan/common";
import { Bet, BetArchive } from "../../model/Bet";
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
