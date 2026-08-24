import mongoose from "mongoose";
import { BetKind } from "@betstan/common";
import { Bet } from "../model/Bet";

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
  const updateSet: Record<string, unknown> = {};
  const normalizedKind = inferBetKind(document);
  const rowFallbackKind = explicitBetKind(document.betKind) ?? normalizedKind;

  if (isMissing(document.betKind)) {
    updateSet.betKind = normalizedKind;
  }

  if (isMissing(document.__v)) {
    updateSet.__v = 0;
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
          __v: 1,
          betKind: 1,
          rows: 1,
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
            filter: { _id: document._id },
            update: { $set: updateSet },
          },
        });
      }
    }

    if (apply && operations.length > 0) {
      await collection.bulkWrite(operations, { ordered: true });
      report.changed += operations.length;
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
  ];

  return summariseReports(apply, batchSize, collections);
};

export const runBackfillCli = async (
  argv: string[] = process.argv.slice(2),
  logger: Pick<Console, "log" | "error"> = console,
  connection: Pick<typeof mongoose, "connect" | "disconnect"> = mongoose
): Promise<BackfillReport> => {
  const parsed = parseBackfillArgs(argv);
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }

  await connection.connect(process.env.MONGO_URI, {
    autoIndex: false,
  });
  try {
    const report = await runDataCompatibilityBackfill(parsed);
    logger.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await connection.disconnect();
  }
};

export const backfillDataCompatibilityInternals = {
  asRecord,
  buildUpdateSet,
  explicitBetKind,
  inferBetKind,
  isMissing,
};

if (require.main === module) {
  void runBackfillCli().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
