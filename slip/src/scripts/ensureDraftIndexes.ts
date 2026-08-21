import mongoose from "mongoose";
import { BetKind, SlipStatus } from "@betstan/common";
import {
  Slip,
  SLIP_DRAFT_UNIQUE_INDEX_KEYS,
  SLIP_DRAFT_UNIQUE_INDEX_NAME,
  SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
} from "../model/Slip";
import { findDuplicateDrafts } from "./backfillDataCompatibility";

export interface ParsedEnsureArgs {
  apply: boolean;
}

export interface DraftNormalizationCounts {
  draftCount: number;
  duplicateGroupCount: number;
  duplicateDraftCount: number;
  missingBetKindCount: number;
  invalidBetKindCount: number;
  missingDraftKeyCount: number;
  invalidDraftKeyCount: number;
  mismatchedDraftKeyCount: number;
  missingRowKindCount: number;
  invalidRowKindCount: number;
  mismatchedRowKindCount: number;
  unnormalizedDraftCount: number;
}

export interface DraftIndexReport {
  mode: "dry-run" | "apply";
  ready: boolean;
  scanned: number;
  matched: number;
  changed: number;
  skipped: number;
  errorCount: number;
  existingIndex: "missing" | "matching" | "conflicting";
  indexName: string;
  blocking: DraftNormalizationCounts;
}

type RawDocument = Record<string, unknown>;

const DEFAULT_SCAN_BATCH_SIZE = 100;

const isMissing = (value: unknown): value is null | undefined =>
  value === undefined || value === null;

const explicitBetKind = (value: unknown): BetKind | undefined =>
  value === BetKind.LIVE || value === BetKind.PRE_MATCH
    ? value
    : undefined;

const asRecord = (value: unknown): RawDocument | null =>
  value && typeof value === "object" ? (value as RawDocument) : null;

const isMatchingIndex = (index: any): boolean =>
  index?.name === SLIP_DRAFT_UNIQUE_INDEX_NAME
  && index?.unique === true
  && index?.key?.userId === SLIP_DRAFT_UNIQUE_INDEX_KEYS.userId
  && index?.key?.status === SLIP_DRAFT_UNIQUE_INDEX_KEYS.status
  && index?.key?.draftKey === SLIP_DRAFT_UNIQUE_INDEX_KEYS.draftKey
  && index?.partialFilterExpression?.status
    === SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER.status
  && index?.partialFilterExpression?.draftKey?.$type
    === SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER.draftKey.$type;

const isSameDraftUniqueShape = (index: any): boolean =>
  index?.unique === true
  && index?.key?.userId === SLIP_DRAFT_UNIQUE_INDEX_KEYS.userId
  && index?.key?.status === SLIP_DRAFT_UNIQUE_INDEX_KEYS.status
  && index?.key?.draftKey === SLIP_DRAFT_UNIQUE_INDEX_KEYS.draftKey;

const detectExistingIndex = (indexes: any[]): DraftIndexReport["existingIndex"] => {
  const namedIndex = indexes.find(
    (index) => index?.name === SLIP_DRAFT_UNIQUE_INDEX_NAME
  );

  if (namedIndex) {
    return isMatchingIndex(namedIndex) ? "matching" : "conflicting";
  }

  if (indexes.some(isSameDraftUniqueShape)) {
    return "conflicting";
  }

  return "missing";
};

const countNonZeroBlocks = (
  existingIndex: DraftIndexReport["existingIndex"],
  blocking: DraftNormalizationCounts
): number => {
  const blockers = [
    blocking.duplicateGroupCount,
    blocking.missingBetKindCount,
    blocking.invalidBetKindCount,
    blocking.missingDraftKeyCount,
    blocking.invalidDraftKeyCount,
    blocking.mismatchedDraftKeyCount,
    blocking.missingRowKindCount,
    blocking.invalidRowKindCount,
    blocking.mismatchedRowKindCount,
  ].filter((count) => count > 0).length;

  return blockers + (existingIndex === "conflicting" ? 1 : 0);
};

export const scanDraftNormalization = async (): Promise<DraftNormalizationCounts> => {
  const duplicateDrafts = await findDuplicateDrafts();
  const duplicateDraftIds = new Set<string>();
  for (const duplicate of duplicateDrafts) {
    for (const slipId of duplicate.slipIds) {
      duplicateDraftIds.add(slipId);
    }
  }

  const blockingDraftIds = new Set<string>(duplicateDraftIds);
  const counts: DraftNormalizationCounts = {
    draftCount: 0,
    duplicateGroupCount: duplicateDrafts.length,
    duplicateDraftCount: duplicateDraftIds.size,
    missingBetKindCount: 0,
    invalidBetKindCount: 0,
    missingDraftKeyCount: 0,
    invalidDraftKeyCount: 0,
    mismatchedDraftKeyCount: 0,
    missingRowKindCount: 0,
    invalidRowKindCount: 0,
    mismatchedRowKindCount: 0,
    unnormalizedDraftCount: 0,
  };

  let lastId: any;
  while (true) {
    const filter: any = lastId
      ? {
          status: SlipStatus.DRAFT,
          _id: { $gt: lastId },
        }
      : { status: SlipStatus.DRAFT };
    const batch = await Slip.collection
      .find(filter, {
        projection: {
          _id: 1,
          betKind: 1,
          draftKey: 1,
          rows: 1,
        },
      })
      .sort({ _id: 1 })
      .limit(DEFAULT_SCAN_BATCH_SIZE)
      .toArray();

    if (batch.length === 0) {
      counts.unnormalizedDraftCount = blockingDraftIds.size;
      return counts;
    }

    lastId = batch[batch.length - 1]._id;
    counts.draftCount += batch.length;

    for (const draft of batch as RawDocument[]) {
      const draftId = String(draft._id);
      let blocked = blockingDraftIds.has(draftId);
      const betKind = explicitBetKind(draft.betKind);
      const draftKey = explicitBetKind(draft.draftKey);

      if (isMissing(draft.betKind)) {
        counts.missingBetKindCount += 1;
        blocked = true;
      } else if (!betKind) {
        counts.invalidBetKindCount += 1;
        blocked = true;
      }

      if (isMissing(draft.draftKey)) {
        counts.missingDraftKeyCount += 1;
        blocked = true;
      } else if (!draftKey) {
        counts.invalidDraftKeyCount += 1;
        blocked = true;
      }

      if (betKind && draftKey && betKind !== draftKey) {
        counts.mismatchedDraftKeyCount += 1;
        blocked = true;
      }

      const expectedKind = betKind ?? draftKey;
      const rows = Array.isArray(draft.rows) ? draft.rows : [];
      for (const row of rows) {
        const rowRecord = asRecord(row);
        if (!rowRecord) {
          continue;
        }

        const rowKind = explicitBetKind(rowRecord.betKind);
        if (isMissing(rowRecord.betKind)) {
          counts.missingRowKindCount += 1;
          blocked = true;
          continue;
        }

        if (!rowKind) {
          counts.invalidRowKindCount += 1;
          blocked = true;
          continue;
        }

        if (expectedKind && rowKind !== expectedKind) {
          counts.mismatchedRowKindCount += 1;
          blocked = true;
        }
      }

      if (blocked) {
        blockingDraftIds.add(draftId);
      }
    }
  }
};

export const parseEnsureArgs = (
  argv: string[] = process.argv.slice(2)
): ParsedEnsureArgs => {
  let apply = false;

  for (const argument of argv) {
    if (argument === "--apply") {
      apply = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { apply };
};

export const ensureSlipDraftIndex = async (
  options: Partial<ParsedEnsureArgs> = {}
): Promise<DraftIndexReport> => {
  const apply = options.apply ?? false;
  const existingIndex = detectExistingIndex(await Slip.collection.indexes());
  const blocking = await scanDraftNormalization();
  const ready = existingIndex !== "conflicting" && blocking.unnormalizedDraftCount === 0;

  if (ready && apply && existingIndex === "missing") {
    await Slip.collection.createIndex(SLIP_DRAFT_UNIQUE_INDEX_KEYS, {
      name: SLIP_DRAFT_UNIQUE_INDEX_NAME,
      unique: true,
      partialFilterExpression: SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
    });
  }

  return {
    mode: apply ? "apply" : "dry-run",
    ready,
    scanned: blocking.draftCount,
    matched: blocking.unnormalizedDraftCount,
    changed: ready && apply && existingIndex === "missing" ? 1 : 0,
    skipped: Math.max(blocking.draftCount - blocking.unnormalizedDraftCount, 0),
    errorCount: ready ? 0 : countNonZeroBlocks(existingIndex, blocking),
    existingIndex,
    indexName: SLIP_DRAFT_UNIQUE_INDEX_NAME,
    blocking,
  };
};

export const runEnsureDraftIndexCli = async (
  argv: string[] = process.argv.slice(2),
  logger: Pick<Console, "log" | "error"> = console
): Promise<DraftIndexReport> => {
  const parsed = parseEnsureArgs(argv);
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }

  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
  });
  try {
    const report = await ensureSlipDraftIndex(parsed);
    logger.log(JSON.stringify(report, null, 2));
    if (!report.ready) {
      process.exitCode = 1;
    }
    return report;
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  void runEnsureDraftIndexCli().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
