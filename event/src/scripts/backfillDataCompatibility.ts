import mongoose from "mongoose";
import { EventPhase, EventStatus } from "@betstan/common";
import { createHash } from "crypto";
import { ProductType } from "../data/product/ProductType";
import {
  buildPreMatchPricing,
  CORRECT_SCORE_OPTION_COUNT,
  expectedGoalsFromSeed,
  MAX_GOALS_PER_SIDE,
} from "../data/product/preMatchPricing";
import { Event } from "../model/Event";

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

const asRecordArray = (value: unknown): RawDocument[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const records = value.map(asRecord);
  return records.some((entry) => entry === null)
    ? null
    : (records as RawDocument[]);
};

const SCORE_LABEL_PATTERN = /^(\d+) - (\d+)$/;
const normalizeSelectionLabel = (value: string): string =>
  value.trim().toLowerCase();

const deterministicSelectionId = (seed: string): string => {
  const characters = createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 32)
    .split("");
  characters[12] = "5";
  characters[16] = (
    (Number.parseInt(characters[16], 16) & 0x3) | 0x8
  ).toString(16);
  const hex = characters.join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const isImplausibleCorrectScoreBoard = (odds: RawDocument[]): boolean => {
  const labels = odds.map((odd) => odd.name as string);
  if (new Set(labels).size !== labels.length) {
    return true;
  }

  return labels.some((label) => {
    const match = SCORE_LABEL_PATTERN.exec(label);
    if (!match) {
      return true;
    }

    return Number(match[1]) > MAX_GOALS_PER_SIDE
      || Number(match[2]) > MAX_GOALS_PER_SIDE;
  });
};

const buildLegacyPricingUpdateSet = (
  document: RawDocument
): Record<string, unknown> => {
  if (
    document.status === EventStatus.RESULTED
    || !isMissing(document.liveRetiredAt)
    || !isMissing(document.liveRaceResultedAt)
    || typeof document.eventId !== "string"
  ) {
    return {};
  }

  const live = asRecord(document.live);
  if (live?.phase === EventPhase.FULL_TIME) {
    return {};
  }

  const products = asRecordArray(document.products);
  if (
    !products
    || products.length === 0
    || typeof document.home !== "string"
    || typeof document.away !== "string"
  ) {
    return {};
  }

  const oneCrossTwoIndexes = products
    .map((product, index) => (
      product.type === ProductType.ONE_CROSS_TWO ? index : -1
    ))
    .filter((index) => index >= 0);
  const correctScoreIndexes = products
    .map((product, index) => (
      product.type === ProductType.CORRECT_SCORE ? index : -1
    ))
    .filter((index) => index >= 0);
  if (
    oneCrossTwoIndexes.length !== 1
    || correctScoreIndexes.length !== 1
  ) {
    return {};
  }
  const [oneCrossTwoIndex] = oneCrossTwoIndexes;
  const [correctScoreIndex] = correctScoreIndexes;
  if (
    typeof products[oneCrossTwoIndex].id !== "string"
    || typeof products[correctScoreIndex].id !== "string"
    || products[oneCrossTwoIndex].id === products[correctScoreIndex].id
  ) {
    return {};
  }

  const oneCrossTwoOdds = asRecordArray(products[oneCrossTwoIndex].odds);
  const correctScoreOdds = asRecordArray(products[correctScoreIndex].odds);
  if (
    !oneCrossTwoOdds
    || oneCrossTwoOdds.length !== 3
    || oneCrossTwoOdds.some((odd) => (
      typeof odd.id !== "string" || typeof odd.name !== "string"
    ))
    || new Set(oneCrossTwoOdds.map((odd) => odd.id)).size
      !== oneCrossTwoOdds.length
    || !correctScoreOdds
    || correctScoreOdds.length !== CORRECT_SCORE_OPTION_COUNT
    || correctScoreOdds.some((odd) => (
      typeof odd.id !== "string" || typeof odd.name !== "string"
    ))
    || new Set(correctScoreOdds.map((odd) => odd.id)).size
      !== correctScoreOdds.length
    || !isImplausibleCorrectScoreBoard(correctScoreOdds)
  ) {
    return {};
  }

  const expectedOneCrossTwoLabels = [
    document.home,
    "draw",
    document.away,
  ].map(normalizeSelectionLabel);
  if (
    expectedOneCrossTwoLabels.some((label) => label.length === 0)
    || new Set(expectedOneCrossTwoLabels).size !== 3
  ) {
    return {};
  }
  const normalizedOneCrossTwoLabels = oneCrossTwoOdds.map((odd) => (
    normalizeSelectionLabel(odd.name as string)
  ));
  const oneCrossTwoIndexesByRole = expectedOneCrossTwoLabels.map(
    (expectedLabel) => {
      const matchingIndexes = normalizedOneCrossTwoLabels
        .map((label, index) => label === expectedLabel ? index : -1)
        .filter((index) => index >= 0);
      return matchingIndexes.length === 1 ? matchingIndexes[0] : -1;
    }
  );
  if (
    oneCrossTwoIndexesByRole.some((index) => index < 0)
    || new Set(oneCrossTwoIndexesByRole).size !== 3
  ) {
    return {};
  }

  // Existing rows snapshot their label and price. Keep an odds ID only when the repaired board
  // still represents that same score; otherwise a stale draft could highlight a different outcome.
  const pricing = buildPreMatchPricing(expectedGoalsFromSeed(document.eventId));
  const updateSet: Record<string, unknown> = {};
  const oneCrossTwoValues = [
    pricing.oneCrossTwoOdds.home,
    pricing.oneCrossTwoOdds.draw,
    pricing.oneCrossTwoOdds.away,
  ];
  oneCrossTwoValues.forEach((value, index) => {
    const oddsIndex = oneCrossTwoIndexesByRole[index];
    updateSet[`products.${oneCrossTwoIndex}.odds.${oddsIndex}.value`] = value;
  });

  const existingIdsByLabel = new Map<string, string>();
  correctScoreOdds.forEach((odd) => {
    const label = odd.name as string;
    if (!existingIdsByLabel.has(label)) {
      existingIdsByLabel.set(label, odd.id as string);
    }
  });

  pricing.correctScoreOdds.forEach((score, index) => {
    const label = `${score.homeGoals} - ${score.awayGoals}`;
    const prefix = `products.${correctScoreIndex}.odds.${index}`;
    updateSet[`${prefix}.id`] = existingIdsByLabel.get(label)
      ?? deterministicSelectionId(`${document.eventId}:cs:${label}`);
    updateSet[`${prefix}.name`] = label;
    updateSet[`${prefix}.value`] = score.odds;
  });

  return updateSet;
};

// Numeric array paths are safe only while the scanned source shape is unchanged. A concurrent
// result, live update, or product reorder must turn the write into a mismatch rather than win.
const buildSourceFilter = (document: RawDocument): RawDocument => {
  const filter: RawDocument = { _id: document._id };
  for (const field of [
    "eventId",
    "home",
    "away",
    "status",
    "live",
    "liveRetiredAt",
    "liveRaceResultedAt",
    "products",
  ]) {
    filter[field] = Object.prototype.hasOwnProperty.call(document, field)
      ? document[field]
      : { $exists: false };
  }
  return filter;
};

const buildUpdateSet = (document: RawDocument): Record<string, unknown> => {
  if (document.status === EventStatus.RESULTED) {
    return {};
  }

  const updateSet = buildLegacyPricingUpdateSet(document);
  const live = asRecord(document.live);
  if (!live || !isMissing(live.phase)) {
    return updateSet;
  }

  const sequence =
    typeof live.sequence === "number"
      ? live.sequence
      : Number(live.sequence ?? 0);

  if (sequence <= 0) {
    updateSet["live.phase"] = EventPhase.PRE_MATCH;
  }

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
          eventId: 1,
          home: 1,
          away: 1,
          status: 1,
          live: 1,
          liveRetiredAt: 1,
          liveRaceResultedAt: 1,
          products: 1,
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
            filter: buildSourceFilter(document),
            update: { $set: updateSet },
          },
        });
      }
    }

    if (apply && operations.length > 0) {
      const result = await collection.bulkWrite(operations, { ordered: true });
      if (
        result.matchedCount !== operations.length
        || result.modifiedCount !== operations.length
      ) {
        throw new Error(
          `Event backfill matched ${result.matchedCount} and modified ${result.modifiedCount} of ${operations.length} source-bound documents`
        );
      }
      report.changed += result.modifiedCount;
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
    await processCollection("Event", Event.collection, { apply, batchSize }),
  ];

  return summariseReports(apply, batchSize, collections);
};

export const runBackfillCli = async (
  argv: string[] = process.argv.slice(2),
  logger: Pick<Console, "log" | "error"> = console
): Promise<BackfillReport> => {
  const parsed = parseBackfillArgs(argv);
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }

  await mongoose.connect(process.env.MONGO_URI);
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
