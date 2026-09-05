import { createHash } from "crypto";
import mongoose, { Connection } from "mongoose";

export const OBSOLETE_EVENT_ID = "6a623af592af5a95b1d0bb79";
export const OBSOLETE_EVENT_NAME = "Home 1 - Away 1";
export const OBSOLETE_EVENT_HOME = "Home 1";
export const OBSOLETE_EVENT_AWAY = "Away 1";
export const APPLY_CONFIRMATION =
  `REMOVE_OBSOLETE_EVENT:${OBSOLETE_EVENT_ID}`;
export const ROLLBACK_CONFIRMATION =
  `RESTORE_OBSOLETE_EVENT:${OBSOLETE_EVENT_ID}`;

const SNAPSHOT_SCHEMA_VERSION = "obsolete-synthetic-event-cleanup-v1";
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

type CleanupMode = "dry-run" | "apply" | "rollback";
type RawDocument = Record<string, unknown>;

interface DatabaseNames {
  event: string;
  gamemaster: string;
  moderation: string;
  resulting: string;
  bet: string;
  slip: string;
}

interface DocumentLocation {
  database: keyof DatabaseNames;
  collection: string;
}

interface SnapshotDocument extends DocumentLocation {
  document: RawDocument;
}

interface CleanupSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  targetEventId: typeof OBSOLETE_EVENT_ID;
  documents: SnapshotDocument[];
}

interface CleanupTombstone {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  targetEventId: typeof OBSOLETE_EVENT_ID;
  targetFingerprint: string;
  sourceSha: string;
  snapshotSha256: string;
  snapshotEjson: string;
  createdAt: Date;
}

interface CleanupBlocker {
  database: string;
  collection: string;
  count: number;
  reason: string;
}

export interface CleanupReport {
  mode: CleanupMode;
  targetEventId: typeof OBSOLETE_EVENT_ID;
  state: "absent" | "candidate" | "partial" | "removed" | "restored" | "blocked";
  ready: boolean;
  scanned: number;
  matched: number;
  changed: number;
  errorCount: number;
  tombstoneVerified: boolean;
  snapshotDocumentCount: number;
  snapshotSha256?: string;
  blockers: CleanupBlocker[];
}

export interface CleanupOptions {
  mode?: CleanupMode;
  confirmation?: string;
  sourceSha?: string;
  connection?: Connection;
  databaseNames?: Partial<DatabaseNames>;
}

const DEFAULT_DATABASE_NAMES: DatabaseNames = {
  event: "gaming_event",
  gamemaster: "gaming_gamemaster",
  moderation: "gaming_moderation",
  resulting: "gaming_resulting",
  bet: "gaming_bet",
  slip: "gaming_slip",
};

const TARGET_LOCATIONS: DocumentLocation[] = [
  { database: "event", collection: "events" },
  { database: "gamemaster", collection: "events" },
  { database: "moderation", collection: "liveeventmirrors" },
];

const DEPENDENCY_LOCATIONS: DocumentLocation[] = [
  { database: "moderation", collection: "bets" },
  { database: "moderation", collection: "resulteds" },
  { database: "moderation", collection: "parkedplacebets" },
  { database: "resulting", collection: "bets" },
  { database: "resulting", collection: "betarchives" },
  { database: "resulting", collection: "finalscoreledgers" },
  { database: "resulting", collection: "livesettlementledgers" },
  { database: "resulting", collection: "pendingmoderationresults" },
  { database: "resulting", collection: "retryrecords" },
  { database: "bet", collection: "bets" },
  { database: "bet", collection: "pendingbetupdates" },
  { database: "bet", collection: "betplacementconflicts" },
  { database: "slip", collection: "slips" },
  { database: "slip", collection: "sliparchives" },
];

const EVENT_REFERENCE_PATHS = [
  "eventId",
  "rows.eventId",
  "data.eventId",
  "data.rows.eventId",
  "payload.eventId",
  "payload.rows.eventId",
  "payload.data.eventId",
  "payload.data.rows.eventId",
  "payloadSummary.eventId",
  "payloadSummary.eventIds",
  "event.eventId",
  "event.rows.eventId",
  "event.data.eventId",
  "event.data.rows.eventId",
  "pendingEventIds",
  "message.data.eventId",
  "message.data.rows.eventId",
  "request.eventId",
  "request.rows.eventId",
  "request.data.eventId",
  "request.data.rows.eventId",
];

const canonicalEjson = (value: unknown): string =>
  mongoose.mongo.BSON.EJSON.stringify(value, { relaxed: false });

const snapshotDigest = (snapshotEjson: string): string =>
  createHash("sha256").update(snapshotEjson).digest("hex");

const targetFingerprint = (): string =>
  createHash("sha256")
    .update([
      OBSOLETE_EVENT_ID,
      OBSOLETE_EVENT_NAME,
      OBSOLETE_EVENT_HOME,
      OBSOLETE_EVENT_AWAY,
      "OFFLINE",
      "NO_RESULT",
    ].join("\n"))
    .digest("hex");

const referenceFilter = () => ({
  $or: EVENT_REFERENCE_PATHS.map((path) => ({
    [path]: OBSOLETE_EVENT_ID,
  })),
});

const database = (
  connection: Connection,
  names: DatabaseNames,
  name: keyof DatabaseNames
) => {
  const db = connection.useDb(names[name], { useCache: true }).db;
  if (!db) {
    throw new Error(`Mongo database is unavailable: ${names[name]}`);
  }
  return db;
};

const findTargetDocuments = async (
  connection: Connection,
  names: DatabaseNames
): Promise<SnapshotDocument[]> => {
  const documents: SnapshotDocument[] = [];

  for (const location of TARGET_LOCATIONS) {
    const rows = await database(connection, names, location.database)
      .collection(location.collection)
      .find({ eventId: OBSOLETE_EVENT_ID })
      .limit(2)
      .toArray();
    if (rows.length > 1) {
      throw new Error(
        `duplicate target documents in ${names[location.database]}.${location.collection}`
      );
    }
    if (rows[0]) {
      documents.push({
        ...location,
        document: rows[0] as RawDocument,
      });
    }
  }

  return documents;
};

const identityErrors = (documents: SnapshotDocument[]): string[] => {
  const errors: string[] = [];
  const eventDocument = documents.find(
    ({ database: name, collection }) =>
      name === "event" && collection === "events"
  )?.document;
  const gamemasterDocument = documents.find(
    ({ database: name, collection }) =>
      name === "gamemaster" && collection === "events"
  )?.document;

  if (eventDocument) {
    if (
      eventDocument.eventId !== OBSOLETE_EVENT_ID
      || eventDocument.name !== OBSOLETE_EVENT_NAME
      || eventDocument.home !== OBSOLETE_EVENT_HOME
      || eventDocument.away !== OBSOLETE_EVENT_AWAY
      || eventDocument.visibility !== "OFFLINE"
      || eventDocument.status !== "NO_RESULT"
      || eventDocument.homeResult != null
      || eventDocument.awayResult != null
    ) {
      errors.push("event source identity does not match the reviewed fixture");
    }
  }

  if (gamemasterDocument) {
    if (
      gamemasterDocument.eventId !== OBSOLETE_EVENT_ID
      || gamemasterDocument.name !== OBSOLETE_EVENT_NAME
      || gamemasterDocument.home !== OBSOLETE_EVENT_HOME
      || gamemasterDocument.away !== OBSOLETE_EVENT_AWAY
      || gamemasterDocument.status !== "NO_RESULT"
      || gamemasterDocument.homeResult != null
      || gamemasterDocument.awayResult != null
    ) {
      errors.push("Gamemaster identity does not match the reviewed fixture");
    }
  }

  return errors;
};

const findTombstones = async (
  connection: Connection,
  names: DatabaseNames
): Promise<RawDocument[]> =>
  database(connection, names, "gamemaster")
    .collection("eventarchives")
    .find({ eventId: OBSOLETE_EVENT_ID })
    .limit(2)
    .toArray() as Promise<RawDocument[]>;

const parseTombstoneSnapshot = (
  tombstone: RawDocument
): { snapshot: CleanupSnapshot; snapshotEjson: string; snapshotSha256: string } => {
  const marker = tombstone.cleanupTombstone as
    | Partial<CleanupTombstone>
    | undefined;
  if (
    marker?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || marker.targetEventId !== OBSOLETE_EVENT_ID
    || marker.targetFingerprint !== targetFingerprint()
    || typeof marker.snapshotEjson !== "string"
    || typeof marker.snapshotSha256 !== "string"
    || snapshotDigest(marker.snapshotEjson) !== marker.snapshotSha256
  ) {
    throw new Error("Gamemaster archive contains an unrelated or invalid record");
  }

  const snapshot = mongoose.mongo.BSON.EJSON.parse(
    marker.snapshotEjson,
    { relaxed: false }
  ) as CleanupSnapshot;
  const documentLocations = snapshot.documents?.map(
    ({ database: name, collection }) => `${name}:${collection}`
  ) ?? [];
  if (
    Buffer.byteLength(marker.snapshotEjson, "utf8") > MAX_SNAPSHOT_BYTES
    || snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || snapshot.targetEventId !== OBSOLETE_EVENT_ID
    || !Array.isArray(snapshot.documents)
    || snapshot.documents.length > TARGET_LOCATIONS.length
    || new Set(documentLocations).size !== documentLocations.length
    || snapshot.documents.some(({ database: name, collection, document }) =>
      !TARGET_LOCATIONS.some(
        (location) =>
          location.database === name && location.collection === collection
      )
      || !document
      || document.eventId !== OBSOLETE_EVENT_ID
    )
    || identityErrors(snapshot.documents).length > 0
    || !snapshot.documents.some(
      ({ database: name, collection }) =>
        (name === "event" || name === "gamemaster") && collection === "events"
    )
  ) {
    throw new Error("Gamemaster tombstone snapshot is invalid");
  }

  return {
    snapshot,
    snapshotEjson: marker.snapshotEjson,
    snapshotSha256: marker.snapshotSha256,
  };
};

const scanDependencies = async (
  connection: Connection,
  names: DatabaseNames
): Promise<CleanupBlocker[]> => {
  const blockers: CleanupBlocker[] = [];
  for (const location of DEPENDENCY_LOCATIONS) {
    const count = await database(connection, names, location.database)
      .collection(location.collection)
      .countDocuments(referenceFilter(), { limit: 1 });
    if (count > 0) {
      blockers.push({
        database: names[location.database],
        collection: location.collection,
        count,
        reason: "event reference",
      });
    }
  }
  return blockers;
};

const buildSnapshot = (documents: SnapshotDocument[]): {
  snapshot: CleanupSnapshot;
  snapshotEjson: string;
  snapshotSha256: string;
} => {
  const snapshot: CleanupSnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    targetEventId: OBSOLETE_EVENT_ID,
    documents,
  };
  const snapshotEjson = canonicalEjson(snapshot);
  if (Buffer.byteLength(snapshotEjson, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("cleanup snapshot exceeds the reviewed size bound");
  }
  return {
    snapshot,
    snapshotEjson,
    snapshotSha256: snapshotDigest(snapshotEjson),
  };
};

const deleteExactDocument = async (
  connection: Connection,
  names: DatabaseNames,
  snapshotDocument: SnapshotDocument
): Promise<number> => {
  const collection = database(
    connection,
    names,
    snapshotDocument.database
  ).collection(snapshotDocument.collection);
  const current = await collection.findOne({
    eventId: OBSOLETE_EVENT_ID,
  });
  if (!current) {
    return 0;
  }
  if (canonicalEjson(current) !== canonicalEjson(snapshotDocument.document)) {
    throw new Error(
      `target changed before delete in ${names[snapshotDocument.database]}.${snapshotDocument.collection}`
    );
  }
  const result = await collection.deleteOne(current);
  if (result.deletedCount !== 1) {
    throw new Error(
      `exact delete failed in ${names[snapshotDocument.database]}.${snapshotDocument.collection}`
    );
  }
  return 1;
};

const restoreExactDocument = async (
  connection: Connection,
  names: DatabaseNames,
  snapshotDocument: SnapshotDocument
): Promise<number> => {
  const collection = database(
    connection,
    names,
    snapshotDocument.database
  ).collection(snapshotDocument.collection);
  const current = await collection.findOne({
    eventId: OBSOLETE_EVENT_ID,
  });
  if (current) {
    if (canonicalEjson(current) !== canonicalEjson(snapshotDocument.document)) {
      throw new Error(
        `rollback conflicts with current data in ${names[snapshotDocument.database]}.${snapshotDocument.collection}`
      );
    }
    return 0;
  }
  await collection.insertOne(snapshotDocument.document);
  return 1;
};

const assertRollbackHasNoConflicts = async (
  connection: Connection,
  names: DatabaseNames,
  documents: SnapshotDocument[]
): Promise<void> => {
  const snapshotByLocation = new Map(
    documents.map((snapshotDocument) => [
      `${snapshotDocument.database}:${snapshotDocument.collection}`,
      snapshotDocument,
    ])
  );
  const currentDocuments = await findTargetDocuments(connection, names);

  for (const currentDocument of currentDocuments) {
    const location =
      `${currentDocument.database}:${currentDocument.collection}`;
    const snapshotDocument = snapshotByLocation.get(location);
    if (!snapshotDocument) {
      throw new Error(
        `rollback found unexpected current data in ${names[currentDocument.database]}.${currentDocument.collection}`
      );
    }
    if (
      canonicalEjson(currentDocument.document)
      !== canonicalEjson(snapshotDocument.document)
    ) {
      throw new Error(
        `rollback conflicts with current data in ${names[currentDocument.database]}.${currentDocument.collection}`
      );
    }
  }
};

const report = ({
  mode,
  state,
  ready,
  scanned,
  matched,
  changed,
  tombstoneVerified,
  snapshotDocumentCount,
  snapshotSha256,
  blockers,
}: Omit<CleanupReport, "targetEventId" | "errorCount">): CleanupReport => ({
  mode,
  targetEventId: OBSOLETE_EVENT_ID,
  state,
  ready,
  scanned,
  matched,
  changed,
  errorCount: ready ? 0 : blockers.length,
  tombstoneVerified,
  snapshotDocumentCount,
  ...(snapshotSha256 ? { snapshotSha256 } : {}),
  blockers,
});

export const runObsoleteSyntheticEventCleanup = async ({
  mode = "dry-run",
  confirmation,
  sourceSha = "unknown",
  connection = mongoose.connection,
  databaseNames: databaseNameOverrides = {},
}: CleanupOptions = {}): Promise<CleanupReport> => {
  const names = { ...DEFAULT_DATABASE_NAMES, ...databaseNameOverrides };
  if (!["dry-run", "apply", "rollback"].includes(mode)) {
    throw new Error("mode must be dry-run, apply, or rollback");
  }
  if (mode === "apply" && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`apply requires confirmation ${APPLY_CONFIRMATION}`);
  }
  if (mode === "rollback" && confirmation !== ROLLBACK_CONFIRMATION) {
    throw new Error(`rollback requires confirmation ${ROLLBACK_CONFIRMATION}`);
  }

  const blockers = await scanDependencies(connection, names);
  let documents = await findTargetDocuments(connection, names);
  const identityProblems = identityErrors(documents);
  blockers.push(...identityProblems.map((reason) => ({
    database: names.event,
    collection: "events",
    count: 1,
    reason,
  })));

  const tombstones = await findTombstones(connection, names);
  const tombstone = tombstones[0] ?? null;
  let storedSnapshot:
    | ReturnType<typeof buildSnapshot>
    | undefined;
  if (tombstones.length > 1) {
    blockers.push({
      database: names.gamemaster,
      collection: "eventarchives",
      count: tombstones.length,
      reason: "duplicate Gamemaster archive records",
    });
  }
  if (tombstone) {
    try {
      storedSnapshot = parseTombstoneSnapshot(tombstone);
    } catch (error) {
      blockers.push({
        database: names.gamemaster,
        collection: "eventarchives",
        count: 1,
        reason: error instanceof Error ? error.message : "invalid tombstone",
      });
    }
  }

  if (blockers.length > 0) {
    return report({
      mode,
      state: "blocked",
      ready: false,
      scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 1,
      matched: documents.length,
      changed: 0,
      tombstoneVerified: Boolean(storedSnapshot),
      snapshotDocumentCount: storedSnapshot?.snapshot.documents.length ?? 0,
      snapshotSha256: storedSnapshot?.snapshotSha256,
      blockers,
    });
  }

  if (mode === "dry-run") {
    const state = storedSnapshot
      ? documents.length === 0
        ? "removed"
        : "partial"
      : documents.length === 0
        ? "absent"
        : "candidate";
    return report({
      mode,
      state,
      ready: true,
      scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 1,
      matched: documents.length,
      changed: 0,
      tombstoneVerified: Boolean(storedSnapshot),
      snapshotDocumentCount: storedSnapshot?.snapshot.documents.length
        ?? documents.length,
      snapshotSha256: storedSnapshot?.snapshotSha256,
      blockers: [],
    });
  }

  if (mode === "apply") {
    if (!storedSnapshot && documents.length === 0) {
      return report({
        mode,
        state: "absent",
        ready: true,
        scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 1,
        matched: 0,
        changed: 0,
        tombstoneVerified: false,
        snapshotDocumentCount: 0,
        blockers: [],
      });
    }

    if (!storedSnapshot) {
      storedSnapshot = buildSnapshot(documents);
      const gamemasterDocument = documents.find(
        ({ database: name, collection }) =>
          name === "gamemaster" && collection === "events"
      )?.document;
      const eventDocument = documents.find(
        ({ database: name, collection }) =>
          name === "event" && collection === "events"
      )?.document;
      const identity = gamemasterDocument ?? eventDocument;
      if (!identity) {
        throw new Error("cleanup candidate has no authoritative event record");
      }
      const tombstoneDocument: RawDocument = {
        ...identity,
        eventId: OBSOLETE_EVENT_ID,
        name: OBSOLETE_EVENT_NAME,
        home: OBSOLETE_EVENT_HOME,
        away: OBSOLETE_EVENT_AWAY,
        status: "NO_RESULT",
        cleanupTombstone: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          targetEventId: OBSOLETE_EVENT_ID,
          targetFingerprint: targetFingerprint(),
          sourceSha,
          snapshotSha256: storedSnapshot.snapshotSha256,
          snapshotEjson: storedSnapshot.snapshotEjson,
          createdAt: new Date(),
        } satisfies CleanupTombstone,
      };
      delete tombstoneDocument._id;
      await database(connection, names, "gamemaster")
        .collection("eventarchives")
        .insertOne(tombstoneDocument);
    } else {
      documents = storedSnapshot.snapshot.documents;
    }

    let changed = 0;
    for (const snapshotDocument of documents) {
      changed += await deleteExactDocument(connection, names, snapshotDocument);
    }
    const remaining = await findTargetDocuments(connection, names);
    const verifiedTombstones = await findTombstones(connection, names);
    if (remaining.length > 0 || verifiedTombstones.length !== 1) {
      throw new Error("cleanup verification failed");
    }
    parseTombstoneSnapshot(verifiedTombstones[0]);

    return report({
      mode,
      state: "removed",
      ready: true,
      scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 1,
      matched: documents.length,
      changed,
      tombstoneVerified: true,
      snapshotDocumentCount: storedSnapshot.snapshot.documents.length,
      snapshotSha256: storedSnapshot.snapshotSha256,
      blockers: [],
    });
  }

  if (!storedSnapshot) {
    if (documents.length > 0 && identityProblems.length === 0) {
      return report({
        mode,
        state: "restored",
        ready: true,
        scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 1,
        matched: documents.length,
        changed: 0,
        tombstoneVerified: false,
        snapshotDocumentCount: documents.length,
        blockers: [],
      });
    }
    throw new Error("rollback requires the verified Gamemaster tombstone");
  }

  let changed = 0;
  await assertRollbackHasNoConflicts(
    connection,
    names,
    storedSnapshot.snapshot.documents
  );
  for (const snapshotDocument of storedSnapshot.snapshot.documents) {
    changed += await restoreExactDocument(connection, names, snapshotDocument);
  }
  const restoredDocuments = await findTargetDocuments(connection, names);
  if (
    canonicalEjson(restoredDocuments)
    !== canonicalEjson(storedSnapshot.snapshot.documents)
  ) {
    throw new Error("rollback verification failed");
  }

  const tombstoneCollection = database(
    connection,
    names,
    "gamemaster"
  ).collection("eventarchives");
  const currentTombstone = await tombstoneCollection.findOne({
    eventId: OBSOLETE_EVENT_ID,
  });
  if (!currentTombstone || canonicalEjson(currentTombstone) !== canonicalEjson(tombstone)) {
    throw new Error("Gamemaster tombstone changed before rollback");
  }
  const deletion = await tombstoneCollection.deleteOne(currentTombstone);
  if (deletion.deletedCount !== 1) {
    throw new Error("Gamemaster tombstone delete failed during rollback");
  }

  return report({
    mode,
    state: "restored",
    ready: true,
    scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 1,
    matched: restoredDocuments.length,
    changed: changed + 1,
    tombstoneVerified: false,
    snapshotDocumentCount: storedSnapshot.snapshot.documents.length,
    snapshotSha256: storedSnapshot.snapshotSha256,
    blockers: [],
  });
};

export const parseCleanupArgs = (
  argv: string[] = process.argv.slice(2)
): Pick<CleanupOptions, "mode" | "confirmation"> => {
  let mode: CleanupMode = "dry-run";
  let confirmation: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      const value = argv[index + 1];
      if (!value || !["dry-run", "apply", "rollback"].includes(value)) {
        throw new Error("--mode must be dry-run, apply, or rollback");
      }
      mode = value as CleanupMode;
      index += 1;
    } else if (argument === "--confirmation") {
      confirmation = argv[index + 1];
      if (!confirmation) {
        throw new Error("--confirmation requires a value");
      }
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { mode, confirmation };
};

export const cleanupReportExitCode = (
  cleanupReport: Pick<CleanupReport, "ready">
): 0 | 1 => cleanupReport.ready ? 0 : 1;

export const runCleanupCli = async (
  argv: string[] = process.argv.slice(2)
): Promise<void> => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }
  const options = parseCleanupArgs(argv);
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const cleanupReport = await runObsoleteSyntheticEventCleanup({
      ...options,
      sourceSha: process.env.SOURCE_SHA,
    });
    process.stdout.write(`${JSON.stringify(cleanupReport)}\n`);
    if (cleanupReportExitCode(cleanupReport) !== 0) {
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  void runCleanupCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "cleanup failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
