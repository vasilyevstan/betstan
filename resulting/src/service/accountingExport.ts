import { BetAccountingEvidence, BetAccountingMovement, ResultingStatus } from "@betstan/common";
import { model, Schema } from "mongoose";
import { Bet, BetArchive } from "../model/Bet";
import { accountingEvidenceForBet } from "./betAccounting";
import { AccountingMovement, assertAccountingMovement } from "./accountingHistory";
import { cashBackHash } from "./cashBackIdentity";

/** Internal source-owned pull export; never expose owner/economic records on public routes. */
interface Cursor { collection: "ACTIVE" | "ARCHIVE" | "MOVEMENTS"; after: string | null }
interface Watermark {
  startedAt: string; activeThrough: string | null; archiveThrough: string | null; movementsThrough?: string | null;
}
interface ExportEntry {
  kind: "BET" | "MOVEMENT";
  slipId: string; userId: string; status?: string;
  accounting?: BetAccountingEvidence;
  movement?: BetAccountingMovement;
  canonicalMovements?: BetAccountingMovement[];
  history?: {
    expectedRevision: number | null;
    representation: "COMPLETE_PREFIX" | "PAGED" | "UNAVAILABLE";
    economicTimeUnavailable: boolean;
  };
  payoutBound?: unknown;
}
export interface AccountingExportPage {
  exportId: string;
  page: number;
  watermark: Watermark;
  entries: ExportEntry[];
  next: Cursor | null;
  /** Traversal progress only. Not an assertion about historical or live completeness. */
  scanFinished: boolean;
  bookCompleteness: "NOT_ATTESTED";
}
interface ExportRecord {
  exportId: string; watermark: Watermark; cursor: Cursor | null;
  page: number; pending?: AccountingExportPage;
}
const schema = new Schema<ExportRecord>({
  exportId: { type: String, required: true },
  watermark: { type: Schema.Types.Mixed, required: true },
  cursor: { type: Schema.Types.Mixed },
  page: { type: Number, required: true },
  pending: { type: Schema.Types.Mixed },
});
schema.index({ exportId: 1 }, { unique: true });
export const AccountingExport = model<ExportRecord>("AccountingExport", schema);

const MAX_ENTRIES = 50;
const MAX_BYTES = 512 * 1024;
const pageReads = new Map<string, Promise<AccountingExportPage | null>>();

function identity(exportId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(exportId)) throw new Error("Invalid accounting export identity");
}

/** Retrying the same export ID reuses its durable watermark and unacknowledged page. */
export async function beginAccountingExport(exportId: string): Promise<void> {
  identity(exportId);
  if (await AccountingExport.exists({ exportId })) return;
  const [active, archive, movements] = await Promise.all([
    Bet.findOne().sort({ _id: -1 }).select({ _id: 1 }).lean(),
    BetArchive.findOne().sort({ _id: -1 }).select({ _id: 1 }).lean(),
    AccountingMovement.findOne().sort({ _id: -1 }).select({ _id: 1 }).lean(),
  ]);
  const watermark: Watermark = {
    startedAt: new Date().toISOString(),
    activeThrough: active?._id.toString() ?? null,
    archiveThrough: archive?._id.toString() ?? null,
    movementsThrough: movements?._id.toString() ?? null,
  };
  try {
    await AccountingExport.updateOne({ exportId }, { $setOnInsert: {
      exportId, watermark, cursor: { collection: "ACTIVE", after: null }, page: 1, __v: 0,
    } }, { upsert: true });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
  }
}

/** Bounded, restartable pages from Resulting's own data only. Live overlap is mandatory:
 * migration from active to archive after the watermark can change the scan's cut.
 * Missing/unsupported historical records are explicit, never silently zero-filled.
 */
export async function readAccountingExportPage(exportId: string): Promise<AccountingExportPage | null> {
  identity(exportId);
  const inFlight = pageReads.get(exportId);
  if (inFlight) return inFlight;
  const work = loadAccountingExportPage(exportId);
  pageReads.set(exportId, work);
  try {
    return await work;
  } finally {
    if (pageReads.get(exportId) === work) pageReads.delete(exportId);
  }
}

async function loadAccountingExportPage(exportId: string): Promise<AccountingExportPage | null> {
  identity(exportId);
  const job = await AccountingExport.findOne({ exportId }).lean();
  if (!job) throw new Error("Accounting export not found");
  if (job.pending) return job.pending;
  if (!job.cursor) return null;
  const cursor = job.cursor;
  const through = cursor.collection === "ACTIVE" ? job.watermark.activeThrough
    : cursor.collection === "ARCHIVE" ? job.watermark.archiveThrough : job.watermark.movementsThrough;
  const filter = { $and: [
    { _id: { $lte: through } }, ...(cursor.after ? [{ _id: { $gt: cursor.after } }] : []),
  ] };
  const records: { id: string; entry: ExportEntry }[] = [];
  if (through && cursor.collection === "MOVEMENTS") {
    const movements = await AccountingMovement.find(filter).sort({ _id: 1 }).limit(MAX_ENTRIES + 1).lean();
    for (const record of movements) {
      assertAccountingMovement(record.movement);
      if (cashBackHash(record.movement) !== record.fingerprint) throw new Error("Accounting history fingerprint mismatch");
      records.push({ id: record._id.toString(), entry: {
        kind: "MOVEMENT", slipId: record.movement.slipId, userId: record.movement.userId, movement: record.movement,
      } });
    }
  } else if (through) {
    const source = cursor.collection === "ACTIVE" ? Bet : BetArchive;
    const bets = await source.find(filter).sort({ _id: 1 }).limit(MAX_ENTRIES + 1).select({
      slipId: 1, userId: 1, status: 1, accounting: 1, accountingPayoutBound: 1,
      accountingRevision: 1, accountingLastMovement: 1, accountingPrefixTruncated: 1, accountingTimeUnavailable: 1,
      accountingCumulativeReturnMinor: 1,
      "cashBackPending.accountingMovement": 1,
    }).lean();
    for (const record of bets) {
      const accounting = accountingEvidenceForBet(record, [
        ResultingStatus.BET_WIN, ResultingStatus.BET_LOSS, ResultingStatus.BET_VOID, ResultingStatus.BET_CASH_BACK,
      ].includes(record.status));
      const canonicalMovements: BetAccountingMovement[] = [
        record.cashBackPending?.accountingMovement, record.accountingLastMovement,
      ].filter((movement): movement is BetAccountingMovement => Boolean(movement));
      for (const movement of canonicalMovements) {
        assertAccountingMovement(movement);
        if (movement.slipId !== record.slipId || movement.userId !== record.userId) throw new Error("Accounting owner mismatch");
      }
      const expectedRevision = Number.isSafeInteger(record.accountingRevision) && record.accountingRevision! >= 0
        ? record.accountingRevision! : accounting.status === "COMPLETE" ? accounting.movements.length : null;
      const paged = record.accountingPrefixTruncated && !record.accountingTimeUnavailable
        && expectedRevision !== null && expectedRevision === record.accountingLastMovement?.revision;
      records.push({ id: record._id.toString(), entry: {
        kind: "BET", slipId: record.slipId, userId: record.userId, status: record.status, accounting,
        canonicalMovements,
        history: {
          expectedRevision,
          representation: accounting.status === "COMPLETE" ? "COMPLETE_PREFIX"
            : paged ? "PAGED" : "UNAVAILABLE",
          economicTimeUnavailable: record.accountingTimeUnavailable === true,
        },
        ...(record.accountingPayoutBound ? { payoutBound: record.accountingPayoutBound } : {}),
      } });
    }
  }
  const entries: ExportEntry[] = [];
  let after = cursor.after;
  let bytes = 0;
  for (const record of records.slice(0, MAX_ENTRIES)) {
    const entry = record.entry;
    const size = Buffer.byteLength(JSON.stringify(entry));
    // Do not silently truncate an authoritative prefix or skip an oversized record.
    if (size > MAX_BYTES) throw new Error("Accounting export record exceeds page budget");
    if (bytes + size > MAX_BYTES) break;
    entries.push(entry);
    bytes += size;
    after = record.id;
  }
  const exhausted = entries.length === records.length;
  const next: Cursor | null = !exhausted ? { ...cursor, after }
    : cursor.collection === "ACTIVE" ? { collection: "ARCHIVE", after: null }
      : cursor.collection === "ARCHIVE" && job.watermark.movementsThrough
        ? { collection: "MOVEMENTS", after: null } : null;
  const page: AccountingExportPage = {
    exportId, page: job.page, watermark: job.watermark, entries, next,
    scanFinished: next === null, bookCompleteness: "NOT_ATTESTED",
  };
  await AccountingExport.updateOne(
    { exportId, page: job.page, pending: { $exists: false }, cursor: { $ne: null } },
    { $set: { pending: page }, $inc: { __v: 1 } }
  );
  // Another reader may have won with a different live cut. Always return persisted bytes.
  const winner = await AccountingExport.findOne({ exportId }).lean();
  if (winner?.page !== job.page || !winner.pending) throw new Error("Accounting export page advanced; retry");
  return winner.pending;
}

/** Ack only after the receiver durably applied/deduplicated the exact page. */
export async function acknowledgeAccountingExportPage(exportId: string, page: number): Promise<void> {
  identity(exportId);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid accounting export page");
  const job = await AccountingExport.findOne({ exportId }).lean();
  if (!job) throw new Error("Accounting export not found");
  if (job.page > page) return;
  if (job.page !== page || !job.pending) throw new Error("Accounting export page conflict");
  await AccountingExport.updateOne(
    { exportId, page, "pending.page": page },
    { $set: { cursor: job.pending.next }, $unset: { pending: "" }, $inc: { page: 1, __v: 1 } }
  );
}
