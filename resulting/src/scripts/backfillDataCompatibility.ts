import mongoose from "mongoose";
import { BetKind } from "@betstan/common";
import { Bet, BetArchive } from "../model/Bet";
import {
  AccountingSnapshot,
  AccountingSnapshotItem,
  readAccountingSnapshotManifest,
  readAccountingSnapshotPage,
} from "../service/accountingSnapshot";
import { cashBackHash } from "../service/cashBackIdentity";

const DEFAULT_BATCH_SIZE = 100;

type RawDocument = Record<string, unknown>;

export interface ParsedBackfillArgs {
  apply: boolean;
  batchSize: number;
}

export interface CollectionBackfillReport {
  collection: string;
  scanned: number;
  matched: number;
  changed: number;
  skipped: number;
  errorCount: number;
}

export interface BackfillReport extends CollectionBackfillReport {
  mode: "dry-run" | "apply";
  batchSize: number;
  collections: CollectionBackfillReport[];
  accountingSnapshot?: AccountingSnapshotDiagnostics;
}

interface AccountingSourceEvidence {
  matchedCut: number;
  changedSinceCut: number;
  missingSource: number;
  missingBasis: number;
  originalManifestPresent: number;
  principalSnapshotPresent: number;
  accountingReasons: {
    NOT_RECORDED: number;
    COMPLETE: number;
    HISTORY_MISSING: number;
    AUTHORITY_UNAVAILABLE: number;
    LEGACY_PRECISION_UNSUPPORTED: number;
    AMOUNT_UNSUPPORTED: number;
    INVALID: number;
  };
}

export type AccountingSnapshotDiagnostics = {
  status: "NO_SEALED_SNAPSHOT";
} | {
  status: "SEALED_SNAPSHOT_DIAGNOSED";
  snapshotId: string;
  cutAt: string;
  manifestHash: string;
  openPositions: "COMPLETE" | "UNAVAILABLE";
  positions: number;
  movements: number;
  unavailableOpenPositions: number;
  unavailableHistories: number;
  missingEvidence: { scope: number; placement: number; principal: number; other: number };
  sourceEvidence: AccountingSourceEvidence;
};

async function inspectAccountingSnapshot(): Promise<AccountingSnapshotDiagnostics> {
  const snapshot = await AccountingSnapshot.findOne({
    _id: /^risk_[1-9][0-9]*_1$/, state: "SEALED",
  }).sort({ cutAt: -1, _id: -1 }).select({ _id: 1 }).lean<{ _id: string }>();
  if (!snapshot) return { status: "NO_SEALED_SNAPSHOT" };
  const manifest = await readAccountingSnapshotManifest(snapshot._id);
  const total = manifest.positions + manifest.movements;
  const counts = [manifest.positions, manifest.movements, manifest.pageCount,
    manifest.coverage.unavailableOpenPositions, manifest.coverage.unavailableHistories];
  if (manifest.snapshotId !== snapshot._id || manifest.schemaVersion !== 1
    || manifest.source !== "RESULTING" || manifest.status !== "COMPLETE"
    || !counts.every(value => Number.isSafeInteger(value) && value >= 0)
    || total > 10000 || manifest.pageCount > Math.max(1, total)
    || !["COMPLETE", "UNAVAILABLE"].includes(manifest.coverage.openPositions)
    || !Number.isFinite(Date.parse(manifest.cutAt))
    || new Date(manifest.cutAt).toISOString() !== manifest.cutAt) {
    throw new Error("Accounting snapshot diagnostic manifest is invalid");
  }
  const missingEvidence = { scope: 0, placement: 0, principal: 0, other: 0 };
  const sourceEvidence: AccountingSourceEvidence = {
    matchedCut: 0, changedSinceCut: 0, missingSource: 0, missingBasis: 0,
    originalManifestPresent: 0, principalSnapshotPresent: 0,
    accountingReasons: {
      NOT_RECORDED: 0, COMPLETE: 0, HISTORY_MISSING: 0, AUTHORITY_UNAVAILABLE: 0,
      LEGACY_PRECISION_UNSUPPORTED: 0, AMOUNT_UNSUPPORTED: 0, INVALID: 0,
    },
  };
  let positions = 0, movements = 0, unavailableOpenPositions = 0, unavailableHistories = 0, bytes = 0;
  let previousHash = cashBackHash({ schemaVersion: 1, source: "RESULTING", snapshotId: snapshot._id });
  for (let number = 1; number <= manifest.pageCount; number++) {
    const page = await readAccountingSnapshotPage(snapshot._id, number);
    const size = Buffer.byteLength(JSON.stringify(page));
    bytes += size;
    if (!page || page.previousHash !== previousHash || !Array.isArray(page.entries) || page.entries.length > 50
      || size > 512 * 1024 || bytes > 16 * 1024 * 1024) {
      throw new Error("Accounting snapshot diagnostic page integrity or budget failed");
    }
    previousHash = page.hash;
    for (const entry of page.entries) {
      if (entry.kind === "MOVEMENT") { movements++; continue; }
      if (entry.kind !== "POSITION") throw new Error("Accounting snapshot diagnostic entry is invalid");
      positions++;
      if (entry.history === "UNAVAILABLE") unavailableHistories++;
      if (entry.openExposure !== "UNAVAILABLE") continue;
      unavailableOpenPositions++;
      const scope = entry.facts == null;
      const placement = entry.placementFingerprint == null || entry.originalStakeMinor == null
        || entry.maximumReturnMinor == null;
      const principal = entry.remainingStakeMinor == null || entry.expectedRevision == null;
      if (scope) missingEvidence.scope++;
      if (placement) missingEvidence.placement++;
      if (principal) missingEvidence.principal++;
      if (!scope && !placement && !principal) missingEvidence.other++;
      const retained = await AccountingSnapshotItem.findOne({
        snapshotId: snapshot._id, kind: "POSITION", identity: entry.slipId,
      }).select({ fingerprint: 1, data: 1 }).lean<{ fingerprint: string; data: unknown }>();
      if (!retained || !/^[0-9a-f]{64}$/.test(retained.fingerprint)
        || cashBackHash(retained.data) !== cashBackHash(entry)) {
        throw new Error("Accounting snapshot retained source evidence is invalid");
      }
      const records = (await Promise.all([
        Bet.findOne({ slipId: entry.slipId }).lean<RawDocument>(),
        BetArchive.findOne({ slipId: entry.slipId }).lean<RawDocument>(),
      ])).filter((record): record is RawDocument => record !== null);
      if (!records.length) { sourceEvidence.missingSource++; continue; }
      let changed = false;
      for (const record of records) {
        const economic: RawDocument = JSON.parse(JSON.stringify({ ...record, __v: record.__v ?? 0 }));
        delete economic._id;
        delete economic.cashBackArchiving;
        const size = Buffer.byteLength(JSON.stringify(economic));
        bytes += size;
        if (size > 512 * 1024 || bytes > 16 * 1024 * 1024) {
          throw new Error("Accounting snapshot source diagnostic budget failed");
        }
        if (cashBackHash(economic) !== retained.fingerprint) changed = true;
      }
      if (changed) { sourceEvidence.changedSinceCut++; continue; }
      sourceEvidence.matchedCut++;
      const source = records[0];
      if (isMissing(source.accountingBasis)) sourceEvidence.missingBasis++;
      if (!isMissing(source.cashBackOriginalManifest)) sourceEvidence.originalManifestPresent++;
      if (!isMissing(source.cashBackFinancial)) sourceEvidence.principalSnapshotPresent++;
      const accounting = asRecord(source.accounting);
      if (isMissing(source.accounting)) sourceEvidence.accountingReasons.NOT_RECORDED++;
      else if (accounting?.schemaVersion === 1 && accounting.status === "COMPLETE") {
        sourceEvidence.accountingReasons.COMPLETE++;
      } else if (accounting?.schemaVersion === 1 && accounting.status === "UNAVAILABLE") {
        switch (accounting.reason) {
          case "HISTORY_MISSING":
          case "AUTHORITY_UNAVAILABLE":
          case "LEGACY_PRECISION_UNSUPPORTED":
          case "AMOUNT_UNSUPPORTED":
            sourceEvidence.accountingReasons[accounting.reason]++;
            break;
          default: sourceEvidence.accountingReasons.INVALID++;
        }
      } else sourceEvidence.accountingReasons.INVALID++;
    }
  }
  if (previousHash !== manifest.lastPageHash || positions !== manifest.positions
    || movements !== manifest.movements || unavailableOpenPositions !== manifest.coverage.unavailableOpenPositions
    || unavailableHistories !== manifest.coverage.unavailableHistories) {
    throw new Error("Accounting snapshot diagnostic coverage does not match its sealed manifest");
  }
  return {
    status: "SEALED_SNAPSHOT_DIAGNOSED", snapshotId: snapshot._id, cutAt: manifest.cutAt,
    manifestHash: cashBackHash(manifest), openPositions: manifest.coverage.openPositions,
    positions, movements, unavailableOpenPositions, unavailableHistories, missingEvidence, sourceEvidence,
  };
}

const isMissing = (value: unknown): value is null | undefined =>
  value === undefined || value === null;

const asRecord = (value: unknown): RawDocument | null =>
  value && typeof value === "object" ? (value as RawDocument) : null;

const explicitBetKind = (value: unknown): BetKind | undefined =>
  value === BetKind.LIVE || value === BetKind.PRE_MATCH
    ? value
    : undefined;

const inferBetKind = (document: RawDocument): BetKind => {
  const parentKind = explicitBetKind(document.betKind);
  if (parentKind) {
    return parentKind;
  }

  const rows = Array.isArray(document.rows) ? document.rows : [];
  return rows.some(
    (row) => explicitBetKind(asRecord(row)?.betKind) === BetKind.LIVE
  )
    ? BetKind.LIVE
    : BetKind.PRE_MATCH;
};

const buildUpdateSet = (document: RawDocument): Record<string, unknown> => {
  if (["cashBackFinancial", "cashBackPending", "cashBackOriginalManifest"].some(
    field => Object.prototype.hasOwnProperty.call(document, field)
  )) return {};
  const updateSet: Record<string, unknown> = {};
  const normalizedKind = inferBetKind(document);
  const rowFallbackKind = explicitBetKind(document.betKind) ?? normalizedKind;

  if (isMissing(document.betKind)) {
    updateSet.betKind = normalizedKind;
  }

  const rows = Array.isArray(document.rows) ? document.rows : [];
  rows.forEach((row, index) => {
    const rowRecord = asRecord(row);
    if (rowRecord && isMissing(rowRecord.betKind)) {
      updateSet[`rows.${index}.betKind`] = rowFallbackKind;
    }
  });

  return updateSet;
};

async function processCollection(
  collectionName: string,
  collection: any,
  { apply, batchSize }: ParsedBackfillArgs
): Promise<CollectionBackfillReport> {
  const report: CollectionBackfillReport = {
    collection: collectionName,
    scanned: 0,
    matched: 0,
    changed: 0,
    skipped: 0,
    errorCount: 0,
  };
  let lastId: unknown;

  while (true) {
    const filter = lastId ? { _id: { $gt: lastId } } : {};
    const batch = await collection
      .find(filter, {
        projection: {
          _id: 1,
          betKind: 1,
          rows: 1,
          cashBackFinancial: 1,
          cashBackPending: 1,
          cashBackOriginalManifest: 1,
        },
      })
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();

    if (batch.length === 0) {
      return report;
    }

    lastId = batch[batch.length - 1]._id;
    report.scanned += batch.length;

    const operations: any[] = [];

    for (const document of batch as RawDocument[]) {
      const updateSet = buildUpdateSet(document);
      if (Object.keys(updateSet).length === 0) {
        report.skipped += 1;
        continue;
      }

      report.matched += 1;
      if (apply) {
        operations.push({
          updateOne: {
            filter: {
              _id: document._id, cashBackFinancial: { $exists: false },
              cashBackPending: { $exists: false }, cashBackOriginalManifest: { $exists: false },
            },
            update: { $set: updateSet },
          },
        });
      }
    }

    if (apply && operations.length > 0) {
      const result = await collection.bulkWrite(operations, { ordered: true });
      report.changed += result.modifiedCount;
      report.skipped += operations.length - result.modifiedCount;
    }
  }
}

const summariseReports = (
  apply: boolean,
  batchSize: number,
  collections: CollectionBackfillReport[]
): BackfillReport => ({
  mode: apply ? "apply" : "dry-run",
  batchSize,
  collections,
  scanned: collections.reduce((sum, report) => sum + report.scanned, 0),
  matched: collections.reduce((sum, report) => sum + report.matched, 0),
  changed: collections.reduce((sum, report) => sum + report.changed, 0),
  skipped: collections.reduce((sum, report) => sum + report.skipped, 0),
  errorCount: collections.reduce((sum, report) => sum + report.errorCount, 0),
  collection: "all",
});

const parseBatchSize = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --batch-size value: ${value}`);
  }

  return parsed;
};

export const parseBackfillArgs = (
  argv: string[] = process.argv.slice(2)
): ParsedBackfillArgs => {
  let apply = false;
  let batchSize = DEFAULT_BATCH_SIZE;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--apply") {
      apply = true;
      continue;
    }

    if (argument === "--batch-size") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --batch-size");
      }
      batchSize = parseBatchSize(value);
      index += 1;
      continue;
    }

    if (argument.startsWith("--batch-size=")) {
      batchSize = parseBatchSize(argument.slice("--batch-size=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { apply, batchSize };
};

export const runDataCompatibilityBackfill = async (
  options: Partial<ParsedBackfillArgs> = {}
): Promise<BackfillReport> => {
  const apply = options.apply ?? false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const collections = [
    await processCollection("Bet", Bet.collection, { apply, batchSize }),
    await processCollection("BetArchive", BetArchive.collection, {
      apply,
      batchSize,
    }),
  ];

  const report = summariseReports(apply, batchSize, collections);
  return apply ? report : { ...report, accountingSnapshot: await inspectAccountingSnapshot() };
};

export const runBackfillCli = async (
  argv: string[] = process.argv.slice(2),
  logger: Pick<Console, "log" | "error"> = console
): Promise<BackfillReport> => {
  const parsed = parseBackfillArgs(argv);
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }

  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
    autoCreate: false,
  });
  try {
    const report = await runDataCompatibilityBackfill(parsed);
    logger.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  void runBackfillCli().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
