/** Integration-test child only: separate process + source-owned Mongo database,
 * real Resulting models, exact money, snapshot, page acknowledgements/completion.
 * Only external maintenance infrastructure is replaced with synthetic authority.
 */
import { resolve } from "path";
import { createRequire } from "module";
import type { SnapshotPage } from "../SnapshotContract";
if (process.env.RISK_SOURCE_FIXTURE === "true" && process.send) {
  process.once("message", async (input: any) => {
    const source = resolve(__dirname, "../../../../resulting");
    const sourceRequire = createRequire(resolve(source, "package.json"));
    const mongoose = sourceRequire("mongoose");
    try {
      const fence = require(resolve(source, "src/service/accountingSnapshotFence"));
      fence.verifyAccountingSnapshotFence = async () => input.authority;
      const { Bet, BetArchive } = require(resolve(source, "src/model/Bet"));
      const { accountingPlacementState, accountingPlacementBasis, accountingClosureState } = require(resolve(source, "src/service/betAccounting"));
      const { retainAccountingHistory } = require(resolve(source, "src/service/accountingHistory"));
      const snapshot = require(resolve(source, "src/service/accountingSnapshot"));
      const { cashBackHash } = require(resolve(source, "src/service/cashBackIdentity"));
      await mongoose.connect(input.uri, { dbName: input.database });
      const prefixes: Record<string, unknown> = {};
      for (const item of input.positions) {
        let record = { ...item.data, ...accountingPlacementState(item.data),
          timestamp: "2020-01-01T00:00:00.000Z", status: item.pending ? "BET_PENDING" : "BET_APPROVED" };
        if (item.legacyPlacementFingerprint) {
          record = { ...record, ...accountingPlacementBasis(item.data, item.legacyPlacementFingerprint) };
        }
        for (const movement of item.closes ?? []) {
          record = { ...record, ...accountingClosureState(record, movement.source,
            movement.closed, movement.returned, movement.occurredAt) };
          if (item.retainHistory) await retainAccountingHistory(record.accounting, record.accountingLastMovement);
        }
        prefixes[item.data.slipId] = record.accounting;
        if (item.gap) record = { ...record, accounting: { schemaVersion: 1, status: "UNAVAILABLE", reason: "HISTORY_MISSING" }, accountingPrefixTruncated: true };
        if (item.legacy) {
          await BetArchive.create({ ...item.data, timestamp: record.timestamp, status: "BET_WIN" });
        } else if (record.accounting?.movements?.length && record.accounting.movements[record.accounting.movements.length - 1].remainingStakeMinor === 0) {
          await BetArchive.create({ ...record, status: "BET_WIN" });
        } else await Bet.create(record);
      }
      const manifest = await snapshot.createAccountingSnapshot(input.id, input.from);
      const pages: SnapshotPage[] = [];
      for (let n = 1; n <= manifest.pageCount; n++) {
        const page = await snapshot.readAccountingSnapshotPage(input.id, n);
        pages.push(page);
      }
      const finish = async (acknowledgements: any[]) => {
        try {
          for (const ack of acknowledgements) await snapshot.acknowledgeAccountingSnapshotPage(input.id, ack.page, ack.hash);
          const completion = await snapshot.completeAccountingSnapshot(input.id, cashBackHash(manifest));
          await mongoose.disconnect();
          process.send!({ manifest, pages, completion, prefixes }, () => process.disconnect());
        } catch (error) {
          await mongoose.disconnect();
          process.send!({ error: error instanceof Error ? error.message : "Source completion failed" }, () => process.disconnect());
        }
      };
      if (input.deferCompletion) {
        process.once("message", (message: any) => { void finish(message.acknowledgements); });
        process.send!({ manifest, pages, prefixes });
      } else await finish(pages); // Sealed source fixtures for negative/overlap tests.
    } catch (error) {
      await mongoose.disconnect();
      process.send!({ error: error instanceof Error ? error.message : "Source fixture failed" }, () => process.disconnect());
    }
  });
}
