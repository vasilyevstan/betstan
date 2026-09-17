import { createHash } from "crypto";
import mongoose, { Connection } from "mongoose";
import {
  PRE_SEPTEMBER_CLEANUP_CUTOFF,
  PRE_SEPTEMBER_CLEANUP_CUTOFF_MS,
  parseExplicitZoneTimestamp,
} from "../event/preSeptemberCleanupBoundary";

export const CLEANUP_OPERATION_ID =
  "backoffice-events-before:2026-09-01T00:00:00Z" as const;
export const CLEANUP_SCHEMA_VERSION =
  "backoffice-pre-september-events-cleanup-v1" as const;
export const CLEANUP_JOURNAL_COLLECTION =
  "preseptembereventcleanupoperations" as const;
export const CLEANUP_DATABASE_NAME = "gaming_backoffice" as const;
export const APPLY_CONFIRMATION =
  "DELETE_BACKOFFICE_EVENTS_BEFORE:2026-09-01T00:00:00Z" as const;
export const DEFAULT_BATCH_SIZE = 100;
export const MAX_BATCH_SIZE = 1_000;

const EVENTS_COLLECTION = "events";
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PUBLICATION_MARKERS = [
  "newEventPublicationPending",
  "resultPublicationPending",
  "visibilityPublicationPending",
] as const;

export type CleanupMode = "dry-run" | "apply" | "verify";
export type CleanupState =
  | "clear"
  | "candidate"
  | "prepared"
  | "applied"
  | "verified"
  | "blocked";

export type CleanupReasonCode =
  | "invalid_mode"
  | "invalid_batch_size"
  | "confirmation_mismatch"
  | "source_sha_invalid"
  | "mongo_uri_required"
  | "database_unavailable"
  | "database_mismatch"
  | "malformed_time"
  | "candidate_event_id_invalid"
  | "candidate_event_id_duplicate"
  | "new_event_publication_pending_unsafe"
  | "result_publication_pending_unsafe"
  | "visibility_publication_pending_unsafe"
  | "journal_invalid"
  | "journal_conflict"
  | "prepared_source_sha_mismatch"
  | "journal_target_duplicate"
  | "journal_target_drift"
  | "journal_marker_changed"
  | "unjournaled_candidate"
  | "journal_target_remaining"
  | "operation_not_applied"
  | "candidates_remaining"
  | "journal_apply_conflict"
  | "argument_unknown"
  | "argument_missing"
  | "argument_duplicate";

const REASON_ORDER: readonly CleanupReasonCode[] = [
  "invalid_mode",
  "invalid_batch_size",
  "confirmation_mismatch",
  "source_sha_invalid",
  "mongo_uri_required",
  "database_unavailable",
  "database_mismatch",
  "malformed_time",
  "candidate_event_id_invalid",
  "candidate_event_id_duplicate",
  "new_event_publication_pending_unsafe",
  "result_publication_pending_unsafe",
  "visibility_publication_pending_unsafe",
  "journal_invalid",
  "journal_conflict",
  "prepared_source_sha_mismatch",
  "journal_target_duplicate",
  "journal_target_drift",
  "journal_marker_changed",
  "unjournaled_candidate",
  "journal_target_remaining",
  "operation_not_applied",
  "candidates_remaining",
  "journal_apply_conflict",
  "argument_unknown",
  "argument_missing",
  "argument_duplicate",
];

export interface CleanupIdentity {
  eventId: string;
  time: string;
}

type JournalState = "prepared" | "applied";
type RawDocument = Record<string, unknown>;

interface CleanupJournal extends mongoose.mongo.Document {
  _id: typeof CLEANUP_OPERATION_ID;
  schemaVersion: typeof CLEANUP_SCHEMA_VERSION;
  operation: "delete-backoffice-events-before-cutoff";
  cutoff: typeof PRE_SEPTEMBER_CLEANUP_CUTOFF;
  sourceSha: string;
  state: JournalState;
  identities: CleanupIdentity[];
  candidateCount: number;
  digest: string;
  createdAt: Date;
  appliedAt?: Date;
}

interface ScannedEvent {
  eventId: unknown;
  time: unknown;
  newEventPublicationPending?: unknown;
  resultPublicationPending?: unknown;
  visibilityPublicationPending?: unknown;
}

interface ScanResult {
  scannedCount: number;
  candidateCount: number;
  malformedTimeCount: number;
  identities: CleanupIdentity[];
  rows: ScannedEvent[];
  reasons: CleanupReasonCode[];
}

interface Reconciliation {
  reasons: CleanupReasonCode[];
  presentIdentities: CleanupIdentity[];
  remainingJournalCount: number;
}

export interface CleanupCounts {
  scannedCount: number;
  candidateCount: number;
  journaledCount: number;
  deletedCount: number;
  remainingCandidateCount: number;
  remainingJournalCount: number;
  malformedTimeCount: number;
}

export interface CleanupReport {
  operationId: typeof CLEANUP_OPERATION_ID;
  schemaVersion: typeof CLEANUP_SCHEMA_VERSION;
  mode: CleanupMode;
  state: CleanupState;
  cutoff: typeof PRE_SEPTEMBER_CLEANUP_CUTOFF;
  counts: CleanupCounts;
  digest: string | null;
  reasonCodes: CleanupReasonCode[];
}

export interface CleanupOptions {
  mode?: CleanupMode;
  confirmation?: string;
  sourceSha?: string;
  batchSize?: number;
  database?: mongoose.mongo.Db;
  connection?: Connection;
  now?: Date | (() => Date);
}

export interface ParsedCleanupArgs {
  mode: CleanupMode;
  confirmation?: string;
  batchSize: number;
}

interface CleanupCliConnection {
  db?: mongoose.mongo.Db;
  close(): Promise<void>;
}

export interface CleanupCliRuntime {
  env?: Pick<NodeJS.ProcessEnv, "MONGO_URI" | "SOURCE_SHA">;
  connect?: (mongoUri: string) => Promise<CleanupCliConnection>;
  write?: (line: string) => void;
}

class CleanupArgumentError extends Error {
  constructor(readonly reasonCode: CleanupReasonCode) {
    super(reasonCode);
  }
}

const validModes: readonly CleanupMode[] = ["dry-run", "apply", "verify"];

const isCleanupMode = (value: unknown): value is CleanupMode =>
  typeof value === "string"
  && validModes.includes(value as CleanupMode);

const uniqueReasons = (
  reasons: readonly CleanupReasonCode[]
): CleanupReasonCode[] => {
  const reasonSet = new Set(reasons);
  return REASON_ORDER.filter((reason) => reasonSet.has(reason));
};

const identityKey = ({ eventId, time }: CleanupIdentity): string =>
  JSON.stringify([eventId, time]);

const compareIdentities = (
  left: CleanupIdentity,
  right: CleanupIdentity
): number =>
  left.eventId < right.eventId
    ? -1
    : left.eventId > right.eventId
      ? 1
      : left.time < right.time
        ? -1
        : left.time > right.time
          ? 1
          : 0;

const canonicalIdentities = (
  identities: readonly CleanupIdentity[]
): string =>
  JSON.stringify(
    [...identities]
      .sort(compareIdentities)
      .map(({ eventId, time }) => ({ eventId, time }))
  );

export const cleanupIdentityDigest = (
  identities: readonly CleanupIdentity[]
): string =>
  createHash("sha256").update(canonicalIdentities(identities)).digest("hex");

const currentDate = (now: CleanupOptions["now"]): Date => {
  const value = typeof now === "function" ? now() : now ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("cleanup clock is invalid");
  }
  return new Date(value.getTime());
};

const emptyCounts = (): CleanupCounts => ({
  scannedCount: 0,
  candidateCount: 0,
  journaledCount: 0,
  deletedCount: 0,
  remainingCandidateCount: 0,
  remainingJournalCount: 0,
  malformedTimeCount: 0,
});

const makeReport = ({
  mode,
  state,
  scan,
  journal,
  deletedCount = 0,
  remainingJournalCount = 0,
  digest = journal?.digest ?? null,
  reasons = [],
}: {
  mode: CleanupMode;
  state: CleanupState;
  scan?: ScanResult;
  journal?: CleanupJournal;
  deletedCount?: number;
  remainingJournalCount?: number;
  digest?: string | null;
  reasons?: readonly CleanupReasonCode[];
}): CleanupReport => ({
  operationId: CLEANUP_OPERATION_ID,
  schemaVersion: CLEANUP_SCHEMA_VERSION,
  mode,
  state,
  cutoff: PRE_SEPTEMBER_CLEANUP_CUTOFF,
  counts: scan
    ? {
        scannedCount: scan.scannedCount,
        candidateCount: journal?.candidateCount ?? scan.candidateCount,
        journaledCount: journal?.candidateCount ?? 0,
        deletedCount,
        remainingCandidateCount: scan.candidateCount,
        remainingJournalCount,
        malformedTimeCount: scan.malformedTimeCount,
      }
    : emptyCounts(),
  digest,
  reasonCodes: uniqueReasons(reasons),
});

const markerReason = (
  marker: typeof PUBLICATION_MARKERS[number]
): CleanupReasonCode => {
  switch (marker) {
    case "newEventPublicationPending":
      return "new_event_publication_pending_unsafe";
    case "resultPublicationPending":
      return "result_publication_pending_unsafe";
    case "visibilityPublicationPending":
      return "visibility_publication_pending_unsafe";
  }
};

const markerReasons = (row: ScannedEvent): CleanupReasonCode[] => {
  const reasons: CleanupReasonCode[] = [];
  for (const marker of PUBLICATION_MARKERS) {
    if (
      Object.prototype.hasOwnProperty.call(row, marker)
      && row[marker] !== false
    ) {
      reasons.push(markerReason(marker));
    }
  }
  return reasons;
};

const scanEvents = async (
  database: mongoose.mongo.Db,
  batchSize: number
): Promise<ScanResult> => {
  const cursor = database
    .collection<ScannedEvent>(EVENTS_COLLECTION)
    .find(
      {},
      {
        projection: {
          _id: 0,
          eventId: 1,
          time: 1,
          newEventPublicationPending: 1,
          resultPublicationPending: 1,
          visibilityPublicationPending: 1,
        },
      }
    )
    .batchSize(batchSize);

  const rows: ScannedEvent[] = [];
  const candidateRows: Array<{
    row: ScannedEvent;
    identity?: CleanupIdentity;
  }> = [];
  const eventIdCounts = new Map<string, number>();
  const reasons: CleanupReasonCode[] = [];
  let malformedTimeCount = 0;

  try {
    while (await cursor.hasNext()) {
      const row = await cursor.next();
      if (!row) {
        continue;
      }
      rows.push(row);
      if (typeof row.eventId === "string") {
        eventIdCounts.set(
          row.eventId,
          (eventIdCounts.get(row.eventId) ?? 0) + 1
        );
      }
      reasons.push(...markerReasons(row));

      const parsedTime = parseExplicitZoneTimestamp(row.time);
      if (parsedTime === null) {
        malformedTimeCount += 1;
        reasons.push("malformed_time");
        continue;
      }
      if (parsedTime >= PRE_SEPTEMBER_CLEANUP_CUTOFF_MS) {
        continue;
      }

      const candidate: {
        row: ScannedEvent;
        identity?: CleanupIdentity;
      } = { row };
      if (
        typeof row.eventId !== "string"
        || row.eventId.trim().length === 0
      ) {
        reasons.push("candidate_event_id_invalid");
      } else {
        candidate.identity = {
          eventId: row.eventId,
          time: row.time as string,
        };
      }
      candidateRows.push(candidate);
    }
  } finally {
    await cursor.close();
  }

  for (const { identity } of candidateRows) {
    if (
      identity
      && (eventIdCounts.get(identity.eventId) ?? 0) !== 1
    ) {
      reasons.push("candidate_event_id_duplicate");
    }
  }

  const identities = candidateRows
    .flatMap(({ identity }) => identity ? [identity] : [])
    .sort(compareIdentities);

  return {
    scannedCount: rows.length,
    candidateCount: candidateRows.length,
    malformedTimeCount,
    identities,
    rows,
    reasons: uniqueReasons(reasons),
  };
};

const exactJournalKeys = (state: JournalState): string[] => [
  "_id",
  "candidateCount",
  "createdAt",
  "cutoff",
  "digest",
  "identities",
  "operation",
  "schemaVersion",
  "sourceSha",
  "state",
  ...(state === "applied" ? ["appliedAt"] : []),
];

const sameStringArray = (left: string[], right: string[]): boolean =>
  left.length === right.length
  && left.every((value, index) => value === right[index]);

const parseJournal = (document: RawDocument): CleanupJournal => {
  const journal = document as unknown as CleanupJournal;
  if (
    journal.state !== "prepared"
    && journal.state !== "applied"
  ) {
    throw new Error("invalid cleanup journal");
  }

  const keys = Object.keys(document).sort();
  const expectedKeys = exactJournalKeys(journal.state).sort();
  const stateTimestampIsValid =
    journal.state === "prepared"
      ? !Object.prototype.hasOwnProperty.call(document, "appliedAt")
      : journal.appliedAt instanceof Date
        && !Number.isNaN(journal.appliedAt.getTime());

  if (
    !sameStringArray(keys, expectedKeys)
    || journal._id !== CLEANUP_OPERATION_ID
    || journal.schemaVersion !== CLEANUP_SCHEMA_VERSION
    || journal.operation !== "delete-backoffice-events-before-cutoff"
    || journal.cutoff !== PRE_SEPTEMBER_CLEANUP_CUTOFF
    || !SOURCE_SHA_PATTERN.test(journal.sourceSha)
    || !(journal.createdAt instanceof Date)
    || Number.isNaN(journal.createdAt.getTime())
    || !stateTimestampIsValid
    || (journal.state === "applied"
      && journal.appliedAt!.getTime() < journal.createdAt.getTime())
    || !Number.isInteger(journal.candidateCount)
    || journal.candidateCount < 0
    || !Array.isArray(journal.identities)
    || journal.identities.length !== journal.candidateCount
    || !DIGEST_PATTERN.test(journal.digest)
  ) {
    throw new Error("invalid cleanup journal");
  }

  const identities: CleanupIdentity[] = [];
  const eventIds = new Set<string>();
  for (const identity of journal.identities) {
    if (
      !identity
      || typeof identity !== "object"
      || !sameStringArray(
        Object.keys(identity).sort(),
        ["eventId", "time"]
      )
      || typeof identity.eventId !== "string"
      || identity.eventId.trim().length === 0
      || typeof identity.time !== "string"
    ) {
      throw new Error("invalid cleanup journal");
    }
    const parsedTime = parseExplicitZoneTimestamp(identity.time);
    if (
      parsedTime === null
      || parsedTime >= PRE_SEPTEMBER_CLEANUP_CUTOFF_MS
      || eventIds.has(identity.eventId)
    ) {
      throw new Error("invalid cleanup journal");
    }
    eventIds.add(identity.eventId);
    identities.push({
      eventId: identity.eventId,
      time: identity.time,
    });
  }

  if (
    identities.some(
      (identity, index) =>
        index > 0
        && compareIdentities(identities[index - 1], identity) >= 0
    )
    || cleanupIdentityDigest(identities) !== journal.digest
  ) {
    throw new Error("invalid cleanup journal");
  }

  return journal;
};

const journalCollection = (database: mongoose.mongo.Db) =>
  database.collection<CleanupJournal>(CLEANUP_JOURNAL_COLLECTION);

const loadJournal = async (
  database: mongoose.mongo.Db
): Promise<CleanupJournal | null> => {
  const document = await journalCollection(database).findOne({
    _id: CLEANUP_OPERATION_ID,
  });
  return document
    ? parseJournal(document as unknown as RawDocument)
    : null;
};

const reconcileJournal = (
  scan: ScanResult,
  journal: CleanupJournal
): Reconciliation => {
  const rowsByEventId = new Map<string, ScannedEvent[]>();
  for (const row of scan.rows) {
    if (typeof row.eventId !== "string") {
      continue;
    }
    const rows = rowsByEventId.get(row.eventId) ?? [];
    rows.push(row);
    rowsByEventId.set(row.eventId, rows);
  }

  const reasons = [...scan.reasons];
  const journalIdentityKeys = new Set(journal.identities.map(identityKey));
  const presentIdentities: CleanupIdentity[] = [];
  let remainingJournalCount = 0;

  for (const identity of journal.identities) {
    const rows = rowsByEventId.get(identity.eventId) ?? [];
    if (rows.length === 0) {
      continue;
    }
    remainingJournalCount += 1;
    if (rows.length > 1) {
      reasons.push("journal_target_duplicate");
      continue;
    }
    const row = rows[0];
    if (row.time !== identity.time) {
      reasons.push("journal_target_drift");
      continue;
    }
    const unsafeMarkers = markerReasons(row);
    if (unsafeMarkers.length > 0) {
      reasons.push(...unsafeMarkers, "journal_marker_changed");
      continue;
    }
    presentIdentities.push(identity);
  }

  for (const identity of scan.identities) {
    if (!journalIdentityKeys.has(identityKey(identity))) {
      reasons.push("unjournaled_candidate");
    }
  }

  return {
    reasons: uniqueReasons(reasons),
    presentIdentities,
    remainingJournalCount,
  };
};

const safeMarkerClauses = (): RawDocument[] =>
  PUBLICATION_MARKERS.map((marker) => ({
    $or: [
      { [marker]: { $exists: false } },
      { [marker]: false },
    ],
  }));

const deleteJournaledEvents = async (
  database: mongoose.mongo.Db,
  identities: readonly CleanupIdentity[],
  batchSize: number
): Promise<number> => {
  const collection = database.collection(EVENTS_COLLECTION);
  let deletedCount = 0;

  for (let offset = 0; offset < identities.length; offset += batchSize) {
    const batch = identities.slice(offset, offset + batchSize);
    const result = await collection.bulkWrite(
      batch.map(({ eventId, time }) => ({
        deleteOne: {
          filter: {
            $and: [
              { eventId },
              { time },
              ...safeMarkerClauses(),
            ],
          },
        },
      })),
      { ordered: true }
    );
    deletedCount += result.deletedCount;
  }

  return deletedCount;
};

const preparedJournal = (
  identities: CleanupIdentity[],
  sourceSha: string,
  now: CleanupOptions["now"]
): CleanupJournal => ({
  _id: CLEANUP_OPERATION_ID,
  schemaVersion: CLEANUP_SCHEMA_VERSION,
  operation: "delete-backoffice-events-before-cutoff",
  cutoff: PRE_SEPTEMBER_CLEANUP_CUTOFF,
  sourceSha,
  state: "prepared",
  identities,
  candidateCount: identities.length,
  digest: cleanupIdentityDigest(identities),
  createdAt: currentDate(now),
});

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === 11000
  );

const insertOrLoadJournal = async (
  database: mongoose.mongo.Db,
  scan: ScanResult,
  sourceSha: string,
  now: CleanupOptions["now"]
): Promise<{ journal?: CleanupJournal; reason?: CleanupReasonCode }> => {
  const journal = preparedJournal(scan.identities, sourceSha, now);
  try {
    await journalCollection(database).insertOne(journal);
    return { journal };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    try {
      const existing = await loadJournal(database);
      return existing
        ? { journal: existing }
        : { reason: "journal_conflict" };
    } catch {
      return { reason: "journal_invalid" };
    }
  }
};

const exactPreparedJournalFilter = (
  journal: CleanupJournal
): RawDocument => ({
  $and: [
    { _id: CLEANUP_OPERATION_ID },
    { schemaVersion: CLEANUP_SCHEMA_VERSION },
    { operation: "delete-backoffice-events-before-cutoff" },
    { cutoff: PRE_SEPTEMBER_CLEANUP_CUTOFF },
    { sourceSha: journal.sourceSha },
    { state: "prepared" },
    { identities: journal.identities },
    { candidateCount: journal.candidateCount },
    { digest: journal.digest },
    { createdAt: journal.createdAt },
    { appliedAt: { $exists: false } },
  ],
});

const markJournalApplied = async (
  database: mongoose.mongo.Db,
  journal: CleanupJournal,
  now: CleanupOptions["now"]
): Promise<CleanupJournal | null> => {
  const appliedAt = currentDate(now);
  const result = await journalCollection(database).updateOne(
    exactPreparedJournalFilter(journal),
    {
      $set: {
        state: "applied",
        appliedAt,
      },
    }
  );
  if (result.matchedCount === 1 && result.modifiedCount === 1) {
    return {
      ...journal,
      state: "applied",
      appliedAt,
    };
  }

  const observed = await loadJournal(database);
  if (
    observed?.state === "applied"
    && observed.sourceSha === journal.sourceSha
    && observed.digest === journal.digest
    && observed.candidateCount === journal.candidateCount
    && canonicalIdentities(observed.identities)
      === canonicalIdentities(journal.identities)
  ) {
    return observed;
  }
  return null;
};

const resolveDatabase = (
  options: CleanupOptions
): mongoose.mongo.Db | undefined =>
  options.database
  ?? options.connection?.db
  ?? mongoose.connection.db;

export const runPreSeptemberEventCleanup = async (
  options: CleanupOptions = {}
): Promise<CleanupReport> => {
  const modeValue: unknown = options.mode ?? "dry-run";
  const mode = isCleanupMode(modeValue) ? modeValue : "dry-run";
  if (!isCleanupMode(modeValue)) {
    return makeReport({
      mode,
      state: "blocked",
      reasons: ["invalid_mode"],
    });
  }

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (
    !Number.isInteger(batchSize)
    || batchSize < 1
    || batchSize > MAX_BATCH_SIZE
  ) {
    return makeReport({
      mode,
      state: "blocked",
      reasons: ["invalid_batch_size"],
    });
  }
  if (mode === "apply" && options.confirmation !== APPLY_CONFIRMATION) {
    return makeReport({
      mode,
      state: "blocked",
      reasons: ["confirmation_mismatch"],
    });
  }
  if (
    mode === "apply"
    && (
      typeof options.sourceSha !== "string"
      || !SOURCE_SHA_PATTERN.test(options.sourceSha)
    )
  ) {
    return makeReport({
      mode,
      state: "blocked",
      reasons: ["source_sha_invalid"],
    });
  }

  const database = resolveDatabase(options);
  if (!database) {
    return makeReport({
      mode,
      state: "blocked",
      reasons: ["database_unavailable"],
    });
  }

  let journal: CleanupJournal | null;
  try {
    journal = await loadJournal(database);
  } catch {
    return makeReport({
      mode,
      state: "blocked",
      reasons: ["journal_invalid"],
    });
  }

  if (
    journal?.state === "prepared"
    && options.sourceSha !== journal.sourceSha
  ) {
    return makeReport({
      mode,
      state: "blocked",
      journal,
      reasons: ["prepared_source_sha_mismatch"],
    });
  }

  let scan = await scanEvents(database, batchSize);
  if (!journal && mode === "verify") {
    return makeReport({
      mode,
      state: "blocked",
      scan,
      reasons: [
        ...scan.reasons,
        "operation_not_applied",
        ...(scan.candidateCount > 0
          ? ["candidates_remaining" as const]
          : []),
      ],
    });
  }

  if (!journal && scan.reasons.length > 0) {
    return makeReport({
      mode,
      state: "blocked",
      scan,
      reasons: scan.reasons,
    });
  }

  if (!journal && mode === "dry-run") {
    return makeReport({
      mode,
      state: scan.candidateCount > 0 ? "candidate" : "clear",
      scan,
      digest: scan.candidateCount > 0
        ? cleanupIdentityDigest(scan.identities)
        : null,
    });
  }

  if (!journal) {
    const inserted = await insertOrLoadJournal(
      database,
      scan,
      options.sourceSha!,
      options.now
    );
    if (!inserted.journal) {
      return makeReport({
        mode,
        state: "blocked",
        scan,
        reasons: [inserted.reason ?? "journal_conflict"],
      });
    }
    journal = inserted.journal;
    if (
      journal.state === "prepared"
      && journal.sourceSha !== options.sourceSha
    ) {
      return makeReport({
        mode,
        state: "blocked",
        scan,
        journal,
        reasons: ["prepared_source_sha_mismatch"],
      });
    }
    scan = await scanEvents(database, batchSize);
  }

  let reconciliation = reconcileJournal(scan, journal);
  if (reconciliation.reasons.length > 0) {
    return makeReport({
      mode,
      state: "blocked",
      scan,
      journal,
      remainingJournalCount: reconciliation.remainingJournalCount,
      reasons: reconciliation.reasons,
    });
  }

  if (journal.state === "applied") {
    const appliedReasons: CleanupReasonCode[] = [];
    if (reconciliation.remainingJournalCount > 0) {
      appliedReasons.push("journal_target_remaining");
    }
    if (scan.candidateCount > 0) {
      appliedReasons.push("candidates_remaining");
    }
    if (appliedReasons.length > 0) {
      return makeReport({
        mode,
        state: "blocked",
        scan,
        journal,
        remainingJournalCount: reconciliation.remainingJournalCount,
        reasons: appliedReasons,
      });
    }
    return makeReport({
      mode,
      state: mode === "verify" ? "verified" : "applied",
      scan,
      journal,
    });
  }

  if (mode === "dry-run") {
    return makeReport({
      mode,
      state: "prepared",
      scan,
      journal,
      remainingJournalCount: reconciliation.remainingJournalCount,
    });
  }
  if (mode === "verify") {
    return makeReport({
      mode,
      state: "blocked",
      scan,
      journal,
      remainingJournalCount: reconciliation.remainingJournalCount,
      reasons: ["operation_not_applied"],
    });
  }

  const deletedCount = await deleteJournaledEvents(
    database,
    reconciliation.presentIdentities,
    batchSize
  );

  scan = await scanEvents(database, batchSize);
  reconciliation = reconcileJournal(scan, journal);
  const finalReasons = [...reconciliation.reasons];
  if (reconciliation.remainingJournalCount > 0) {
    finalReasons.push("journal_target_remaining");
  }
  if (scan.candidateCount > 0) {
    finalReasons.push("candidates_remaining");
  }
  if (finalReasons.length > 0) {
    return makeReport({
      mode,
      state: "blocked",
      scan,
      journal,
      deletedCount,
      remainingJournalCount: reconciliation.remainingJournalCount,
      reasons: finalReasons,
    });
  }

  const appliedJournal = await markJournalApplied(
    database,
    journal,
    options.now
  );
  if (!appliedJournal) {
    return makeReport({
      mode,
      state: "blocked",
      scan,
      journal,
      deletedCount,
      reasons: ["journal_apply_conflict"],
    });
  }

  return makeReport({
    mode,
    state: "applied",
    scan,
    journal: appliedJournal,
    deletedCount,
  });
};

export const parseCleanupArgs = (
  argv: string[] = process.argv.slice(2)
): ParsedCleanupArgs => {
  let mode: CleanupMode = "dry-run";
  let confirmation: string | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument !== "--mode"
      && argument !== "--confirmation"
      && argument !== "--batch-size"
    ) {
      throw new CleanupArgumentError("argument_unknown");
    }
    if (seen.has(argument)) {
      throw new CleanupArgumentError("argument_duplicate");
    }
    seen.add(argument);

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CleanupArgumentError("argument_missing");
    }
    index += 1;

    if (argument === "--mode") {
      if (!isCleanupMode(value)) {
        throw new CleanupArgumentError("invalid_mode");
      }
      mode = value;
    } else if (argument === "--confirmation") {
      confirmation = value;
    } else {
      if (!/^[1-9]\d*$/.test(value)) {
        throw new CleanupArgumentError("invalid_batch_size");
      }
      batchSize = Number(value);
      if (batchSize > MAX_BATCH_SIZE) {
        throw new CleanupArgumentError("invalid_batch_size");
      }
    }
  }

  return { mode, confirmation, batchSize };
};

export const cleanupReportExitCode = (
  report: Pick<CleanupReport, "state">
): 0 | 1 => report.state === "blocked" ? 1 : 0;

export const serializeCleanupReport = (report: CleanupReport): string =>
  JSON.stringify({
    operationId: CLEANUP_OPERATION_ID,
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    mode: report.mode,
    state: report.state,
    cutoff: PRE_SEPTEMBER_CLEANUP_CUTOFF,
    counts: {
      scannedCount: report.counts.scannedCount,
      candidateCount: report.counts.candidateCount,
      journaledCount: report.counts.journaledCount,
      deletedCount: report.counts.deletedCount,
      remainingCandidateCount: report.counts.remainingCandidateCount,
      remainingJournalCount: report.counts.remainingJournalCount,
      malformedTimeCount: report.counts.malformedTimeCount,
    },
    digest: report.digest,
    reasonCodes: uniqueReasons(report.reasonCodes),
  } satisfies CleanupReport);

const defaultConnect = async (
  mongoUri: string
): Promise<CleanupCliConnection> =>
  mongoose.createConnection(mongoUri).asPromise();

export const runCleanupCli = async (
  argv: string[] = process.argv.slice(2),
  runtime: CleanupCliRuntime = {}
): Promise<CleanupReport> => {
  const env = runtime.env ?? process.env;
  const write = runtime.write
    ?? ((line: string) => {
      process.stdout.write(line);
    });
  let mode: CleanupMode = "dry-run";
  let report: CleanupReport;
  let connection: CleanupCliConnection | undefined;

  try {
    const parsed = parseCleanupArgs(argv);
    mode = parsed.mode;
    if (typeof env.MONGO_URI !== "string" || env.MONGO_URI.length === 0) {
      report = makeReport({
        mode,
        state: "blocked",
        reasons: ["mongo_uri_required"],
      });
    } else {
      connection = await (runtime.connect ?? defaultConnect)(env.MONGO_URI);
      if (!connection.db) {
        report = makeReport({
          mode,
          state: "blocked",
          reasons: ["database_unavailable"],
        });
      } else if (connection.db.databaseName !== CLEANUP_DATABASE_NAME) {
        report = makeReport({
          mode,
          state: "blocked",
          reasons: ["database_mismatch"],
        });
      } else {
        report = await runPreSeptemberEventCleanup({
          ...parsed,
          sourceSha: env.SOURCE_SHA,
          database: connection.db,
        });
      }
    }
  } catch (error) {
    report = makeReport({
      mode,
      state: "blocked",
      reasons: [
        error instanceof CleanupArgumentError
          ? error.reasonCode
          : "database_unavailable",
      ],
    });
  }

  if (connection) {
    try {
      await connection.close();
    } catch {
      report = makeReport({
        mode,
        state: "blocked",
        reasons: ["database_unavailable"],
      });
    }
  }

  write(`${serializeCleanupReport(report)}\n`);
  return report;
};

if (require.main === module) {
  void runCleanupCli().then((report) => {
    process.exitCode = cleanupReportExitCode(report);
  });
}
