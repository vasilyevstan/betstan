import { createHash } from "crypto";
import mongoose, { Connection } from "mongoose";
import { ProductType } from "../data/product/ProductType";
import {
  buildPreMatchPricing,
  expectedGoalsFromSeed,
} from "../data/product/preMatchPricing";

const RESCHEDULE_SOURCE_EVENT_ID = "6a623af592af5a95b1d0bb79";
const RESCHEDULE_SOURCE_BACKOFFICE_ID = "6a623af592af5a95b1d0bb7a";
export const RESCHEDULE_EVENT_ID = "eb4608ac531f5d9578113167";
export const RESCHEDULE_BACKOFFICE_ID = "dc32b275f1514a495f56bc0a";
export const RESCHEDULE_EVENT_NAME = "Home 1 - Away 1";
export const RESCHEDULE_EVENT_HOME = "Home 1";
export const RESCHEDULE_EVENT_AWAY = "Away 1";
export const RESCHEDULE_OLD_KICKOFF = "2026-07-23T16:31:57.215Z";
export const RESCHEDULE_TARGET_KICKOFF = "2026-09-12T08:05:00.000Z";
export const APPLY_CONFIRMATION =
  `RESCHEDULE_EVENT:${RESCHEDULE_EVENT_ID}:${RESCHEDULE_TARGET_KICKOFF}`;
export const ROLLBACK_CONFIRMATION =
  `ROLLBACK_EVENT_RESCHEDULE:${RESCHEDULE_EVENT_ID}`;

const SNAPSHOT_SCHEMA_VERSION = "fixed-event-reschedule-v1";
const JOURNAL_ID =
  `event-reschedule:${RESCHEDULE_EVENT_ID}:${RESCHEDULE_TARGET_KICKOFF}`;
const MAX_SNAPSHOT_BYTES = 6 * 1024 * 1024;
const MINIMUM_APPLY_LEAD_MS = 20 * 60 * 1000;
// Generated once independently of every public/document identity. Keeping the
// reviewed value fixed makes journal targets reproducible without deriving
// private simulation randomness from a public event ID.
const RESCHEDULE_LIVE_SEED =
  "40e2fd54b742be56dc1b503de1cc3102a97642196a21ee0ca6226fa33e46b496";

type RescheduleMode = "dry-run" | "apply" | "verify" | "rollback";
type JournalState = "prepared" | "applied" | "rolled-back";
type RawDocument = Record<string, unknown>;

interface DatabaseNames {
  backoffice: string;
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
  document: RawDocument | null;
}

interface RescheduleBundle {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  targetEventId: typeof RESCHEDULE_EVENT_ID;
  documents: SnapshotDocument[];
}

interface RescheduleJournal extends mongoose.mongo.Document {
  _id: typeof JOURNAL_ID;
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  operation: "fixed-event-reschedule";
  targetEventId: typeof RESCHEDULE_EVENT_ID;
  targetFingerprint: string;
  sourceSha: string;
  state: JournalState;
  snapshotSha256: string;
  snapshotEjson: string;
  targetSha256: string;
  targetEjson: string;
  createdAt: Date;
  appliedAt?: Date;
  rolledBackAt?: Date;
  rollbackSourceSha?: string;
}

interface RescheduleBlocker {
  database: string;
  collection: string;
  count: number;
  reason: string;
}

export interface RescheduleReport {
  mode: RescheduleMode;
  targetEventId: typeof RESCHEDULE_EVENT_ID;
  targetKickoff: typeof RESCHEDULE_TARGET_KICKOFF;
  state:
    | "candidate"
    | "prepared"
    | "applied"
    | "verified"
    | "completed"
    | "rolled-back"
    | "blocked";
  ready: boolean;
  scanned: number;
  matched: number;
  changed: number;
  errorCount: number;
  journalVerified: boolean;
  snapshotDocumentCount: number;
  targetDocumentCount: number;
  snapshotSha256?: string;
  targetSha256?: string;
  blockers: RescheduleBlocker[];
}

export interface RescheduleOptions {
  mode?: RescheduleMode;
  confirmation?: string;
  sourceSha?: string;
  now?: Date;
  connection?: Connection;
  databaseNames?: Partial<DatabaseNames>;
}

const DEFAULT_DATABASE_NAMES: DatabaseNames = {
  backoffice: "gaming_backoffice",
  event: "gaming_event",
  gamemaster: "gaming_gamemaster",
  moderation: "gaming_moderation",
  resulting: "gaming_resulting",
  bet: "gaming_bet",
  slip: "gaming_slip",
};

const TARGET_LOCATIONS: DocumentLocation[] = [
  { database: "backoffice", collection: "events" },
  { database: "event", collection: "events" },
  { database: "gamemaster", collection: "events" },
];

const targetDocumentId = (
  location: DocumentLocation
): mongoose.Types.ObjectId => {
  if (location.database === "backoffice") {
    return new mongoose.Types.ObjectId(RESCHEDULE_BACKOFFICE_ID);
  }
  return deterministicObjectId(
    `${RESCHEDULE_EVENT_ID}:${location.database}-document`
  );
};

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

const SLIP_ID_SOURCE_LOCATIONS: DocumentLocation[] = [
  { database: "moderation", collection: "bets" },
  { database: "moderation", collection: "parkedplacebets" },
  { database: "resulting", collection: "bets" },
  { database: "resulting", collection: "betarchives" },
  { database: "resulting", collection: "retryrecords" },
  { database: "bet", collection: "bets" },
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

const SLIP_REFERENCE_PATHS = [
  "slipId",
  "data.slipId",
  "payload.slipId",
  "payload.data.slipId",
  "payloadSummary.slipId",
  "event.slipId",
  "event.data.slipId",
  "message.data.slipId",
  "request.slipId",
  "request.data.slipId",
  "submittedEvent.slipId",
  "identity",
];

const MAX_REFERENCED_SLIP_IDS = 128;

const canonicalEjson = (value: unknown): string =>
  mongoose.mongo.BSON.EJSON.stringify(value, { relaxed: false });

const parseEjson = <T>(value: string): T =>
  mongoose.mongo.BSON.EJSON.parse(value, { relaxed: false }) as T;

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const deterministicHex = (seed: string, length: number): string =>
  createHash("sha256").update(seed).digest("hex").slice(0, length);

const deterministicObjectId = (seed: string): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(deterministicHex(seed, 24));

const deterministicUuid = (seed: string): string => {
  const characters = deterministicHex(seed, 32).split("");
  characters[12] = "5";
  characters[16] = (
    (Number.parseInt(characters[16], 16) & 0x3) | 0x8
  ).toString(16);
  const value = characters.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
};

const targetFingerprint = (): string =>
  digest([
    RESCHEDULE_BACKOFFICE_ID,
    RESCHEDULE_EVENT_ID,
    RESCHEDULE_EVENT_NAME,
    RESCHEDULE_EVENT_HOME,
    RESCHEDULE_EVENT_AWAY,
    RESCHEDULE_TARGET_KICKOFF,
    RESCHEDULE_LIVE_SEED,
    "OFFLINE",
    "NO_RESULT",
  ].join("\n"));

const locationKey = ({ database: name, collection }: DocumentLocation): string =>
  `${name}:${collection}`;

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

const valueAtPath = (document: RawDocument, path: string): unknown =>
  path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return (value as RawDocument)[segment];
  }, document);

const normalizedSlipId = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) {
    if (value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
      throw new Error("reschedule found an invalid referenced Slip identity");
    }
    return value;
  }
  if (value instanceof mongoose.Types.ObjectId) {
    return value.toHexString();
  }
  return undefined;
};

const eventReferenceFilter = () => ({
  $or: EVENT_REFERENCE_PATHS.map((path) => ({
    [path]: RESCHEDULE_EVENT_ID,
  })),
});

const dependencyReferenceFilter = (slipIds: string[]) => ({
  $or: [
    ...eventReferenceFilter().$or,
    ...SLIP_REFERENCE_PATHS.map((path) => ({
      [path]: { $in: slipIds },
    })),
  ],
});

const findReferencedSlipIds = async (
  connection: Connection,
  names: DatabaseNames
): Promise<string[]> => {
  const slipIds = new Set<string>();
  const projection = Object.fromEntries([
    ["_id", 1],
    ...SLIP_REFERENCE_PATHS.map((path) => [path, 1]),
  ]);

  for (const location of SLIP_ID_SOURCE_LOCATIONS) {
    const documents = (
      await database(connection, names, location.database)
        .collection(location.collection)
        .find(eventReferenceFilter())
        .project(projection)
        .limit(MAX_REFERENCED_SLIP_IDS + 1)
        .toArray()
    ) as RawDocument[];
    if (documents.length > MAX_REFERENCED_SLIP_IDS) {
      throw new Error(
        "reschedule referenced-slip set exceeds the reviewed bound"
      );
    }
    for (const document of documents) {
      const values = SLIP_REFERENCE_PATHS.map((path) =>
        valueAtPath(document, path)
      );
      if (location.database === "slip") {
        values.push(document._id);
      }
      for (const value of values) {
        const slipId = normalizedSlipId(value);
        if (slipId) {
          slipIds.add(slipId);
        }
      }
      if (slipIds.size > MAX_REFERENCED_SLIP_IDS) {
        throw new Error(
          "reschedule referenced-slip set exceeds the reviewed bound"
        );
      }
    }
  }

  return [...slipIds];
};

const scanDependencies = async (
  connection: Connection,
  names: DatabaseNames
): Promise<RescheduleBlocker[]> => {
  const slipIds = await findReferencedSlipIds(connection, names);
  const filter = dependencyReferenceFilter(slipIds);
  const blockers: RescheduleBlocker[] = [];
  for (const location of DEPENDENCY_LOCATIONS) {
    const count = await database(connection, names, location.database)
      .collection(location.collection)
      .countDocuments(filter, { limit: 1 });
    if (count > 0) {
      blockers.push({
        database: names[location.database],
        collection: location.collection,
        count,
        reason: "event or Slip dependency",
      });
    }
  }
  return blockers;
};

const countMatchingTargetDocuments = async (
  connection: Connection,
  names: DatabaseNames,
  target: RescheduleBundle
): Promise<number> => {
  let matches = 0;
  for (const targetDocument of target.documents) {
    if (!targetDocument.document) {
      throw new Error("reschedule journal target document is missing");
    }
    const current = await currentDocument(connection, names, targetDocument);
    if (
      current
      && canonicalEjson(current) === canonicalEjson(targetDocument.document)
    ) {
      matches += 1;
    }
  }
  return matches;
};

const findLocationDocuments = async (
  connection: Connection,
  names: DatabaseNames,
  location: DocumentLocation
): Promise<RawDocument[]> => {
  const collection = database(
    connection,
    names,
    location.database
  ).collection(location.collection);
  return collection.find({
    $or: [
      { _id: targetDocumentId(location) },
      { eventId: RESCHEDULE_EVENT_ID },
    ],
  }).limit(3).toArray() as Promise<RawDocument[]>;
};

const findTargetDocuments = async (
  connection: Connection,
  names: DatabaseNames
): Promise<{ documents: SnapshotDocument[]; blockers: RescheduleBlocker[] }> => {
  const documents: SnapshotDocument[] = [];
  const blockers: RescheduleBlocker[] = [];

  for (const location of TARGET_LOCATIONS) {
    const rows = await findLocationDocuments(connection, names, location);
    if (rows.length > 0) {
      blockers.push({
        database: names[location.database],
        collection: location.collection,
        count: rows.length,
        reason: "duplicate target documents",
      });
    }
    documents.push({ ...location, document: null });
  }

  return { documents, blockers };
};

const isNullish = (value: unknown): boolean =>
  value === undefined || value === null;

const sourceBackofficeIdentityMatches = (
  backoffice: RawDocument
): boolean =>
  backoffice._id instanceof mongoose.Types.ObjectId
  && backoffice._id.toHexString() === RESCHEDULE_SOURCE_BACKOFFICE_ID
  && backoffice.eventId === RESCHEDULE_SOURCE_EVENT_ID
  && backoffice.name === RESCHEDULE_EVENT_NAME
  && backoffice.home === RESCHEDULE_EVENT_HOME
  && backoffice.away === RESCHEDULE_EVENT_AWAY
  && backoffice.time === RESCHEDULE_OLD_KICKOFF
  && backoffice.status === "NO_RESULT"
  && backoffice.visibility === "OFFLINE"
  && isNullish(backoffice.homeResult)
  && isNullish(backoffice.awayResult)
  && backoffice.newEventPublicationPending !== true
  && backoffice.resultPublicationPending !== true
  && backoffice.visibilityPublicationPending !== true
  && isNullish(backoffice.visibilityPublicationTarget);

const validateSourceBackoffice = async (
  connection: Connection,
  names: DatabaseNames
): Promise<RescheduleBlocker[]> => {
  const rows = await database(connection, names, "backoffice")
    .collection("events")
    .find({ _id: new mongoose.Types.ObjectId(RESCHEDULE_SOURCE_BACKOFFICE_ID) })
    .limit(2)
    .toArray() as RawDocument[];
  if (
    rows.length !== 1
    || !sourceBackofficeIdentityMatches(rows[0])
  ) {
    return [{
      database: names.backoffice,
      collection: "events",
      count: Math.max(rows.length, 1),
      reason: "Backoffice source identity does not match the reviewed fixture",
    }];
  }
  return [];
};

const deterministicProducts = (): RawDocument[] => {
  const pricing = buildPreMatchPricing(
    expectedGoalsFromSeed(RESCHEDULE_EVENT_ID)
  );
  const oneCrossTwoSeed = `${RESCHEDULE_EVENT_ID}:1x2`;
  const correctScoreSeed = `${RESCHEDULE_EVENT_ID}:correct-score`;
  return [
    {
      _id: deterministicObjectId(`${oneCrossTwoSeed}:document`),
      id: deterministicUuid(`${oneCrossTwoSeed}:product`),
      type: ProductType.ONE_CROSS_TWO,
      name: "1X2",
      odds: [
        [RESCHEDULE_EVENT_HOME, pricing.oneCrossTwoOdds.home, "home"],
        ["draw", pricing.oneCrossTwoOdds.draw, "draw"],
        [RESCHEDULE_EVENT_AWAY, pricing.oneCrossTwoOdds.away, "away"],
      ].map(([name, value, role]) => ({
        _id: deterministicObjectId(`${oneCrossTwoSeed}:${role}:document`),
        id: deterministicUuid(`${oneCrossTwoSeed}:${role}:selection`),
        name,
        value,
      })),
    },
    {
      _id: deterministicObjectId(`${correctScoreSeed}:document`),
      id: deterministicUuid(`${correctScoreSeed}:product`),
      type: ProductType.CORRECT_SCORE,
      name: "Correct Score",
      odds: pricing.correctScoreOdds.map((score) => {
        const label = `${score.homeGoals} - ${score.awayGoals}`;
        return {
          _id: deterministicObjectId(`${correctScoreSeed}:${label}:document`),
          id: deterministicUuid(`${correctScoreSeed}:${label}:selection`),
          name: label,
          value: score.odds,
        };
      }),
    },
  ];
};

const buildTargetDocuments = (): SnapshotDocument[] => [
  {
    database: "backoffice",
    collection: "events",
    document: {
      _id: targetDocumentId(TARGET_LOCATIONS[0]),
      eventId: RESCHEDULE_EVENT_ID,
      name: RESCHEDULE_EVENT_NAME,
      time: RESCHEDULE_TARGET_KICKOFF,
      home: RESCHEDULE_EVENT_HOME,
      away: RESCHEDULE_EVENT_AWAY,
      status: "NO_RESULT",
      visibility: "OFFLINE",
      __v: 0,
    },
  },
  {
    database: "event",
    collection: "events",
    document: {
      _id: targetDocumentId(TARGET_LOCATIONS[1]),
      eventId: RESCHEDULE_EVENT_ID,
      home: RESCHEDULE_EVENT_HOME,
      away: RESCHEDULE_EVENT_AWAY,
      source: "EXTERNAL",
      newEventPublishedAt: null,
      newEventPublishAttempts: 0,
      newEventPublishClaimedAt: null,
      newEventPublishClaimToken: null,
      name: RESCHEDULE_EVENT_NAME,
      time: new Date(RESCHEDULE_TARGET_KICKOFF),
      status: "NO_RESULT",
      visibility: "OFFLINE",
      visibilityInitialized: true,
      eventMetadataInitialized: true,
      visibilityDecision: "OFFLINE",
      liveRaceResultedAt: null,
      liveRetiredAt: null,
      products: deterministicProducts(),
      live: null,
      __v: 0,
    },
  },
  {
    database: "gamemaster",
    collection: "events",
    document: {
      _id: targetDocumentId(TARGET_LOCATIONS[2]),
      eventId: RESCHEDULE_EVENT_ID,
      name: RESCHEDULE_EVENT_NAME,
      time: new Date(RESCHEDULE_TARGET_KICKOFF),
      home: RESCHEDULE_EVENT_HOME,
      away: RESCHEDULE_EVENT_AWAY,
      status: "NO_RESULT",
      phase: "PRE_MATCH",
      liveSeed: RESCHEDULE_LIVE_SEED,
      liveEngineVersion: null,
      liveStartedAt: null,
      liveEndedAt: null,
      liveSequence: 0,
      liveConfirmedReplayCursor: 0,
      liveNextTransitionAt: null,
      liveHomeScore: 0,
      liveAwayScore: 0,
      liveTimeline: null,
      liveTransitions: [],
      liveMarkets: [],
      livePreKickoffPublishedAt: null,
      resultPublishedAt: null,
      __v: 0,
    },
  },
];

const buildBundle = (documents: SnapshotDocument[]): {
  bundle: RescheduleBundle;
  ejson: string;
  sha256: string;
} => {
  const bundle: RescheduleBundle = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    targetEventId: RESCHEDULE_EVENT_ID,
    documents,
  };
  const ejson = canonicalEjson(bundle);
  if (Buffer.byteLength(ejson, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("reschedule snapshot exceeds the reviewed size bound");
  }
  return { bundle, ejson, sha256: digest(ejson) };
};

const validateBundle = (
  bundle: RescheduleBundle,
  targetBundle: boolean
): void => {
  const keys = bundle.documents.map(locationKey);
  if (
    bundle.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || bundle.targetEventId !== RESCHEDULE_EVENT_ID
    || bundle.documents.length !== TARGET_LOCATIONS.length
    || new Set(keys).size !== keys.length
    || TARGET_LOCATIONS.some((location) => !keys.includes(locationKey(location)))
    || bundle.documents.some(({ document }) =>
      document !== null
      && document.eventId !== RESCHEDULE_EVENT_ID
    )
    || bundle.documents.some((entry) => targetBundle
      ? (
          !entry.document
          || !(entry.document._id instanceof mongoose.Types.ObjectId)
          || entry.document._id.toHexString()
            !== targetDocumentId(entry).toHexString()
        )
      : entry.document !== null)
  ) {
    throw new Error("reschedule journal contains an invalid document bundle");
  }
};

const journalCollection = (
  connection: Connection,
  names: DatabaseNames
) => database(connection, names, "event").collection<RescheduleJournal>(
  "eventrescheduleoperations"
);

const findJournal = async (
  connection: Connection,
  names: DatabaseNames
): Promise<RescheduleJournal | null> =>
  journalCollection(connection, names).findOne({ _id: JOURNAL_ID });

const parseJournal = (
  document: RawDocument | RescheduleJournal
): {
  journal: RescheduleJournal;
  snapshot: RescheduleBundle;
  target: RescheduleBundle;
} => {
  const journal = document as unknown as RescheduleJournal;
  const stateMetadataValid = (
    journal.state === "prepared"
    && isNullish(journal.appliedAt)
    && isNullish(journal.rolledBackAt)
    && isNullish(journal.rollbackSourceSha)
  ) || (
    journal.state === "applied"
    && journal.appliedAt instanceof Date
    && isNullish(journal.rolledBackAt)
    && isNullish(journal.rollbackSourceSha)
  ) || (
    journal.state === "rolled-back"
    && (
      isNullish(journal.appliedAt)
      || journal.appliedAt instanceof Date
    )
    && journal.rolledBackAt instanceof Date
    && typeof journal.rollbackSourceSha === "string"
    && /^[0-9a-f]{40}$/.test(journal.rollbackSourceSha)
  );
  if (
    journal._id !== JOURNAL_ID
    || journal.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || journal.operation !== "fixed-event-reschedule"
    || journal.targetEventId !== RESCHEDULE_EVENT_ID
    || journal.targetFingerprint !== targetFingerprint()
    || !/^[0-9a-f]{40}$/.test(journal.sourceSha)
    || !["prepared", "applied", "rolled-back"].includes(journal.state)
    || !(journal.createdAt instanceof Date)
    || !stateMetadataValid
    || typeof journal.snapshotEjson !== "string"
    || typeof journal.targetEjson !== "string"
    || typeof journal.snapshotSha256 !== "string"
    || typeof journal.targetSha256 !== "string"
    || Buffer.byteLength(journal.snapshotEjson, "utf8") > MAX_SNAPSHOT_BYTES
    || Buffer.byteLength(journal.targetEjson, "utf8") > MAX_SNAPSHOT_BYTES
    || digest(journal.snapshotEjson) !== journal.snapshotSha256
    || digest(journal.targetEjson) !== journal.targetSha256
  ) {
    throw new Error("event reschedule journal is invalid");
  }
  const snapshot = parseEjson<RescheduleBundle>(journal.snapshotEjson);
  const target = parseEjson<RescheduleBundle>(journal.targetEjson);
  validateBundle(snapshot, false);
  validateBundle(target, true);
  const rebuiltTargetEjson = canonicalEjson(
    buildTargetDocuments()
  );
  const storedTargetEjson = canonicalEjson(target.documents);
  if (rebuiltTargetEjson !== storedTargetEjson) {
    throw new Error("event reschedule journal target is not reproducible");
  }
  return { journal, snapshot, target };
};

const criticalFields: Record<keyof DatabaseNames, string[]> = {
  backoffice: [
    "_id",
    "eventId",
    "name",
    "time",
    "home",
    "away",
    "homeResult",
    "awayResult",
    "status",
    "visibility",
    "creationRequestId",
    "creationRequestFingerprint",
    "newEventPublicationPending",
    "resultPublicationPending",
    "visibilityPublicationPending",
    "visibilityPublicationTarget",
    "__v",
  ],
  event: [
    "_id",
    "eventId",
    "home",
    "away",
    "source",
    "slotKey",
    "newEventPublishedAt",
    "newEventPublishAttempts",
    "newEventPublishClaimedAt",
    "newEventPublishClaimToken",
    "name",
    "time",
    "status",
    "visibility",
    "visibilityInitialized",
    "eventMetadataInitialized",
    "pendingVisibility",
    "visibilityDecision",
    "liveRaceResultedAt",
    "liveRetiredAt",
    "products",
    "live",
    "__v",
  ],
  gamemaster: [
    "_id",
    "eventId",
    "name",
    "time",
    "home",
    "away",
    "homeResult",
    "awayResult",
    "status",
    "phase",
    "liveSeed",
    "liveEngineVersion",
    "liveStartedAt",
    "liveEndedAt",
    "liveSequence",
    "liveConfirmedReplayCursor",
    "liveNextTransitionAt",
    "liveHomeScore",
    "liveAwayScore",
    "liveTimeline",
    "liveTransitions",
    "liveMarkets",
    "livePreKickoffPublishedAt",
    "processingLease",
    "pendingResult",
    "simulationFailure",
    "resultPublishedAt",
    "__v",
  ],
  moderation: [],
  resulting: [],
  bet: [],
  slip: [],
};

const exactSourceFilter = (
  location: DocumentLocation,
  document: RawDocument
): RawDocument => {
  const filter: RawDocument = {};
  for (const field of criticalFields[location.database]) {
    filter[field] = Object.prototype.hasOwnProperty.call(document, field)
      ? document[field]
      : { $exists: false };
  }
  return filter;
};

const currentDocument = async (
  connection: Connection,
  names: DatabaseNames,
  location: DocumentLocation
): Promise<RawDocument | null> => {
  const rows = await findLocationDocuments(connection, names, location);
  if (rows.length > 1) {
    throw new Error(
      `duplicate target documents in ${names[location.database]}.${location.collection}`
    );
  }
  return rows[0] ?? null;
};

const reconcileTargetDocument = async (
  connection: Connection,
  names: DatabaseNames,
  snapshotDocument: SnapshotDocument,
  targetDocument: SnapshotDocument
): Promise<number> => {
  if (!targetDocument.document) {
    throw new Error("reschedule target document is missing");
  }
  const collection = database(
    connection,
    names,
    targetDocument.database
  ).collection(targetDocument.collection);
  const current = await currentDocument(connection, names, targetDocument);
  if (
    current
    && canonicalEjson(current) === canonicalEjson(targetDocument.document)
  ) {
    return 0;
  }
  if (snapshotDocument.document) {
    if (
      !current
      || canonicalEjson(current) !== canonicalEjson(snapshotDocument.document)
    ) {
      throw new Error(
        `reschedule preimage changed in ${names[targetDocument.database]}.${targetDocument.collection}`
      );
    }
    const result = await collection.replaceOne(
      exactSourceFilter(snapshotDocument, snapshotDocument.document),
      targetDocument.document
    );
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw new Error(
        `reschedule compare-and-set failed in ${names[targetDocument.database]}.${targetDocument.collection}`
      );
    }
    return 1;
  }
  if (current) {
    throw new Error(
      `reschedule found unexpected current data in ${names[targetDocument.database]}.${targetDocument.collection}`
    );
  }
  try {
    await collection.insertOne(targetDocument.document);
  } catch (error) {
    const observed = await currentDocument(connection, names, targetDocument);
    if (
      !observed
      || canonicalEjson(observed) !== canonicalEjson(targetDocument.document)
    ) {
      throw error;
    }
    return 0;
  }
  return 1;
};

const restoreSnapshotDocument = async (
  connection: Connection,
  names: DatabaseNames,
  snapshotDocument: SnapshotDocument,
  targetDocument: SnapshotDocument
): Promise<number> => {
  if (!targetDocument.document) {
    throw new Error("reschedule target document is missing");
  }
  const collection = database(
    connection,
    names,
    targetDocument.database
  ).collection(targetDocument.collection);
  const current = await currentDocument(connection, names, targetDocument);
  if (snapshotDocument.document) {
    if (
      current
      && canonicalEjson(current) === canonicalEjson(snapshotDocument.document)
    ) {
      return 0;
    }
    if (
      !current
      || canonicalEjson(current) !== canonicalEjson(targetDocument.document)
    ) {
      throw new Error(
        `rollback conflicts with current data in ${names[targetDocument.database]}.${targetDocument.collection}`
      );
    }
    const result = await collection.replaceOne(
      exactSourceFilter(targetDocument, targetDocument.document),
      snapshotDocument.document
    );
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw new Error(
        `rollback compare-and-set failed in ${names[targetDocument.database]}.${targetDocument.collection}`
      );
    }
    return 1;
  }
  if (!current) {
    return 0;
  }
  if (canonicalEjson(current) !== canonicalEjson(targetDocument.document)) {
    throw new Error(
      `rollback found unexpected current data in ${names[targetDocument.database]}.${targetDocument.collection}`
    );
  }
  const result = await collection.deleteOne(
    exactSourceFilter(targetDocument, targetDocument.document)
  );
  if (result.deletedCount !== 1) {
    throw new Error(
      `rollback exact delete failed in ${names[targetDocument.database]}.${targetDocument.collection}`
    );
  }
  return 1;
};

const compareCurrentToBundles = async (
  connection: Connection,
  names: DatabaseNames,
  snapshot: RescheduleBundle,
  target: RescheduleBundle,
  targetOnly: boolean
): Promise<RescheduleBlocker[]> => {
  const blockers: RescheduleBlocker[] = [];
  for (const targetDocument of target.documents) {
    const snapshotDocument = snapshot.documents.find(
      (candidate) => locationKey(candidate) === locationKey(targetDocument)
    );
    if (!snapshotDocument || !targetDocument.document) {
      throw new Error("reschedule journal locations are incomplete");
    }
    const current = await currentDocument(connection, names, targetDocument);
    const targetMatches = Boolean(
      current
      && canonicalEjson(current) === canonicalEjson(targetDocument.document)
    );
    const snapshotMatches = snapshotDocument.document === null
      ? current === null
      : Boolean(
          current
          && canonicalEjson(current)
            === canonicalEjson(snapshotDocument.document)
        );
    if (!targetMatches && (targetOnly || !snapshotMatches)) {
      blockers.push({
        database: names[targetDocument.database],
        collection: targetDocument.collection,
        count: 1,
        reason: targetOnly
          ? "rescheduled projection does not match the journal target"
          : "partial reschedule contains an unknown projection state",
      });
    }
  }
  return blockers;
};

const scanArchiveAndMirror = async (
  connection: Connection,
  names: DatabaseNames
): Promise<RescheduleBlocker[]> => {
  const blockers: RescheduleBlocker[] = [];
  const archiveCount = await database(connection, names, "gamemaster")
    .collection("eventarchives")
    .countDocuments({ eventId: RESCHEDULE_EVENT_ID }, { limit: 2 });
  if (archiveCount > 0) {
    blockers.push({
      database: names.gamemaster,
      collection: "eventarchives",
      count: archiveCount,
      reason: "Gamemaster archive or cleanup tombstone exists",
    });
  }
  const mirrorCount = await database(connection, names, "moderation")
    .collection("liveeventmirrors")
    .countDocuments({ eventId: RESCHEDULE_EVENT_ID }, { limit: 2 });
  if (mirrorCount > 0) {
    blockers.push({
      database: names.moderation,
      collection: "liveeventmirrors",
      count: mirrorCount,
      reason: "live moderation state exists",
    });
  }
  return blockers;
};

const scanCandidate = async (
  connection: Connection,
  names: DatabaseNames
): Promise<{
  documents: SnapshotDocument[];
  blockers: RescheduleBlocker[];
}> => {
  const targetScan = await findTargetDocuments(connection, names);
  const blockers = [...targetScan.blockers];
  blockers.push(...await validateSourceBackoffice(connection, names));
  blockers.push(...await scanArchiveAndMirror(connection, names));
  blockers.unshift(...await scanDependencies(connection, names));
  return { documents: targetScan.documents, blockers };
};

const report = ({
  mode,
  state,
  ready,
  scanned,
  matched,
  changed,
  journalVerified,
  snapshotDocumentCount,
  targetDocumentCount,
  snapshotSha256,
  targetSha256,
  blockers,
}: Omit<
  RescheduleReport,
  "targetEventId" | "targetKickoff" | "errorCount"
>): RescheduleReport => ({
  mode,
  targetEventId: RESCHEDULE_EVENT_ID,
  targetKickoff: RESCHEDULE_TARGET_KICKOFF,
  state,
  ready,
  scanned,
  matched,
  changed,
  errorCount: ready ? 0 : blockers.length,
  journalVerified,
  snapshotDocumentCount,
  targetDocumentCount,
  ...(snapshotSha256 ? { snapshotSha256 } : {}),
  ...(targetSha256 ? { targetSha256 } : {}),
  blockers,
});

const blockedReport = (
  mode: RescheduleMode,
  blockers: RescheduleBlocker[],
  matched: number,
  journal?: ReturnType<typeof parseJournal>
): RescheduleReport =>
  report({
    mode,
    state: "blocked",
    ready: false,
    scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 3,
    matched,
    changed: 0,
    journalVerified: Boolean(journal),
    snapshotDocumentCount:
      journal?.snapshot.documents.filter(({ document }) => document).length
      ?? 0,
    targetDocumentCount: journal?.target.documents.length ?? 0,
    snapshotSha256: journal?.journal.snapshotSha256,
    targetSha256: journal?.journal.targetSha256,
    blockers,
  });

const requireSourceSha = (sourceSha: string): void => {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("SOURCE_SHA must be a complete lowercase commit SHA");
  }
};

const prepareJournal = async (
  connection: Connection,
  names: DatabaseNames,
  sourceSha: string,
  documents: SnapshotDocument[]
): Promise<ReturnType<typeof parseJournal>> => {
  const snapshot = buildBundle(documents);
  const target = buildBundle(buildTargetDocuments());
  const marker: RescheduleJournal = {
    _id: JOURNAL_ID,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    operation: "fixed-event-reschedule",
    targetEventId: RESCHEDULE_EVENT_ID,
    targetFingerprint: targetFingerprint(),
    sourceSha,
    state: "prepared",
    snapshotSha256: snapshot.sha256,
    snapshotEjson: snapshot.ejson,
    targetSha256: target.sha256,
    targetEjson: target.ejson,
    createdAt: new Date(),
  };
  try {
    await journalCollection(connection, names).insertOne(marker);
  } catch (error) {
    const current = await findJournal(connection, names);
    if (!current) {
      throw error;
    }
    const parsed = parseJournal(current);
    if (parsed.journal.sourceSha !== sourceSha) {
      throw new Error(
        "event reschedule journal belongs to a different source SHA"
      );
    }
    return parsed;
  }
  return parseJournal(marker);
};

const updateJournalState = async (
  connection: Connection,
  names: DatabaseNames,
  journal: RescheduleJournal,
  state: JournalState,
  sourceSha: string
): Promise<void> => {
  const now = new Date();
  const update = state === "applied"
    ? { state, appliedAt: now }
    : { state, rolledBackAt: now, rollbackSourceSha: sourceSha };
  const result = await journalCollection(connection, names).updateOne(
    {
      _id: JOURNAL_ID,
      state: journal.state,
      sourceSha: journal.sourceSha,
      snapshotSha256: journal.snapshotSha256,
      targetSha256: journal.targetSha256,
    },
    { $set: update }
  );
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new Error("event reschedule journal changed before state transition");
  }
};

export const runSyntheticEventReschedule = async ({
  mode = "dry-run",
  confirmation,
  sourceSha = "unknown",
  now = new Date(),
  connection = mongoose.connection,
  databaseNames: databaseNameOverrides = {},
}: RescheduleOptions = {}): Promise<RescheduleReport> => {
  const names = { ...DEFAULT_DATABASE_NAMES, ...databaseNameOverrides };
  if (!["dry-run", "apply", "verify", "rollback"].includes(mode)) {
    throw new Error("mode must be dry-run, apply, verify, or rollback");
  }
  if (mode === "apply" && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`apply requires confirmation ${APPLY_CONFIRMATION}`);
  }
  if (mode === "rollback" && confirmation !== ROLLBACK_CONFIRMATION) {
    throw new Error(`rollback requires confirmation ${ROLLBACK_CONFIRMATION}`);
  }
  if (mode !== "dry-run") {
    requireSourceSha(sourceSha);
  }

  const storedJournal = await findJournal(connection, names);
  let prepared = storedJournal ? parseJournal(storedJournal) : undefined;

  if (prepared?.journal.state === "rolled-back") {
    if (mode === "rollback") {
      return report({
        mode,
        state: "rolled-back",
        ready: true,
        scanned: TARGET_LOCATIONS.length + 1,
        matched: prepared.snapshot.documents.filter(({ document }) => document)
          .length,
        changed: 0,
        journalVerified: true,
        snapshotDocumentCount: prepared.snapshot.documents.filter(
          ({ document }) => document
        ).length,
        targetDocumentCount: prepared.target.documents.length,
        snapshotSha256: prepared.journal.snapshotSha256,
        targetSha256: prepared.journal.targetSha256,
        blockers: [],
      });
    }
    return blockedReport(mode, [{
      database: names.event,
      collection: "eventrescheduleoperations",
      count: 1,
      reason: "event reschedule was explicitly rolled back",
    }], 0, prepared);
  }

  if (prepared?.journal.state === "applied") {
    if (mode !== "rollback" && prepared.journal.sourceSha !== sourceSha) {
      return report({
        mode,
        state: "completed",
        ready: true,
        scanned: 1,
        matched: 1,
        changed: 0,
        journalVerified: true,
        snapshotDocumentCount: prepared.snapshot.documents.filter(
          ({ document }) => document
        ).length,
        targetDocumentCount: prepared.target.documents.length,
        snapshotSha256: prepared.journal.snapshotSha256,
        targetSha256: prepared.journal.targetSha256,
        blockers: [],
      });
    }
    if (mode !== "rollback") {
      const blockers = [
        ...await scanDependencies(connection, names),
        ...await scanArchiveAndMirror(connection, names),
        ...await compareCurrentToBundles(
          connection,
          names,
          prepared.snapshot,
          prepared.target,
          true
        ),
      ];
      if (blockers.length > 0) {
        return blockedReport(
          mode,
          blockers,
          prepared.target.documents.length,
          prepared
        );
      }
      return report({
        mode,
        state: mode === "verify" ? "verified" : "applied",
        ready: true,
        scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 3,
        matched: prepared.target.documents.length,
        changed: 0,
        journalVerified: true,
        snapshotDocumentCount: prepared.snapshot.documents.filter(
          ({ document }) => document
        ).length,
        targetDocumentCount: prepared.target.documents.length,
        snapshotSha256: prepared.journal.snapshotSha256,
        targetSha256: prepared.journal.targetSha256,
        blockers: [],
      });
    }
  }

  if (
    prepared?.journal.state === "prepared"
    && mode !== "rollback"
    && prepared.journal.sourceSha !== sourceSha
  ) {
    return blockedReport(mode, [{
      database: names.event,
      collection: "eventrescheduleoperations",
      count: 1,
      reason: "prepared event reschedule belongs to a different source SHA",
    }], 0, prepared);
  }

  if (!prepared) {
    const candidate = await scanCandidate(connection, names);
    if (
      mode === "apply"
      && now.getTime() + MINIMUM_APPLY_LEAD_MS
        >= new Date(RESCHEDULE_TARGET_KICKOFF).getTime()
    ) {
      candidate.blockers.push({
        database: names.gamemaster,
        collection: "events",
        count: 1,
        reason: "target kickoff is inside the protected lead-time window",
      });
    }
    if (candidate.blockers.length > 0) {
      return blockedReport(
        mode,
        candidate.blockers,
        candidate.documents.filter(({ document }) => document).length
      );
    }
    if (mode === "dry-run") {
      return report({
        mode,
        state: "candidate",
        ready: true,
        scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 3,
        matched: candidate.documents.filter(({ document }) => document).length,
        changed: 0,
        journalVerified: false,
        snapshotDocumentCount: candidate.documents.filter(
          ({ document }) => document
        ).length,
        targetDocumentCount: TARGET_LOCATIONS.length,
        blockers: [],
      });
    }
    if (mode !== "apply") {
      return blockedReport(mode, [{
        database: names.event,
        collection: "eventrescheduleoperations",
        count: 1,
        reason: "event reschedule journal is missing",
      }], candidate.documents.filter(({ document }) => document).length);
    }
    prepared = await prepareJournal(
      connection,
      names,
      sourceSha,
      candidate.documents
    );
  }

  if (mode === "dry-run") {
    const blockers = [
      ...await scanDependencies(connection, names),
      ...await scanArchiveAndMirror(connection, names),
      ...await compareCurrentToBundles(
        connection,
        names,
        prepared.snapshot,
        prepared.target,
        false
      ),
    ];
    if (blockers.length > 0) {
      return blockedReport(mode, blockers, 0, prepared);
    }
    return report({
      mode,
      state: "prepared",
      ready: true,
      scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 3,
      matched: prepared.snapshot.documents.filter(({ document }) => document)
        .length,
      changed: 0,
      journalVerified: true,
      snapshotDocumentCount: prepared.snapshot.documents.filter(
        ({ document }) => document
      ).length,
      targetDocumentCount: prepared.target.documents.length,
      snapshotSha256: prepared.journal.snapshotSha256,
      targetSha256: prepared.journal.targetSha256,
      blockers: [],
    });
  }

  if (mode === "verify") {
    return blockedReport(mode, [{
      database: names.event,
      collection: "eventrescheduleoperations",
      count: 1,
      reason: "event reschedule is prepared but not applied",
    }], 0, prepared);
  }

  if (
    mode === "apply"
    && now.getTime() + MINIMUM_APPLY_LEAD_MS
      >= new Date(RESCHEDULE_TARGET_KICKOFF).getTime()
    && await countMatchingTargetDocuments(
      connection,
      names,
      prepared.target
    ) === 0
  ) {
    return blockedReport(mode, [{
      database: names.gamemaster,
      collection: "events",
      count: 1,
      reason: "target kickoff is inside the protected lead-time window",
    }], 0, prepared);
  }

  const safetyBlockers = [
    ...await scanDependencies(connection, names),
    ...await scanArchiveAndMirror(connection, names),
    ...await compareCurrentToBundles(
      connection,
      names,
      prepared.snapshot,
      prepared.target,
      false
    ),
  ];
  if (safetyBlockers.length > 0) {
    return blockedReport(mode, safetyBlockers, 0, prepared);
  }

  if (mode === "apply") {
    let changed = 0;
    for (const databaseName of ["event", "gamemaster", "backoffice"] as const) {
      const snapshotDocument = prepared.snapshot.documents.find(
        ({ database: name }) => name === databaseName
      );
      const targetDocument = prepared.target.documents.find(
        ({ database: name }) => name === databaseName
      );
      if (!snapshotDocument || !targetDocument) {
        throw new Error("event reschedule journal is missing a target location");
      }
      changed += await reconcileTargetDocument(
        connection,
        names,
        snapshotDocument,
        targetDocument
      );
    }
    const verification = await compareCurrentToBundles(
      connection,
      names,
      prepared.snapshot,
      prepared.target,
      true
    );
    if (verification.length > 0) {
      throw new Error("event reschedule verification failed after apply");
    }
    await updateJournalState(
      connection,
      names,
      prepared.journal,
      "applied",
      sourceSha
    );
    return report({
      mode,
      state: "applied",
      ready: true,
      scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 3,
      matched: prepared.target.documents.length,
      changed: changed + 1,
      journalVerified: true,
      snapshotDocumentCount: prepared.snapshot.documents.filter(
        ({ document }) => document
      ).length,
      targetDocumentCount: prepared.target.documents.length,
      snapshotSha256: prepared.journal.snapshotSha256,
      targetSha256: prepared.journal.targetSha256,
      blockers: [],
    });
  }

  let changed = 0;
  for (const databaseName of ["backoffice", "gamemaster", "event"] as const) {
    const snapshotDocument = prepared.snapshot.documents.find(
      ({ database: name }) => name === databaseName
    );
    const targetDocument = prepared.target.documents.find(
      ({ database: name }) => name === databaseName
    );
    if (!snapshotDocument || !targetDocument) {
      throw new Error("event reschedule journal is missing a rollback location");
    }
    changed += await restoreSnapshotDocument(
      connection,
      names,
      snapshotDocument,
      targetDocument
    );
  }
  const rollbackVerification = await compareCurrentToBundles(
    connection,
    names,
    prepared.snapshot,
    prepared.target,
    false
  );
  if (rollbackVerification.length > 0) {
    throw new Error("event reschedule rollback verification failed");
  }
  for (const snapshotDocument of prepared.snapshot.documents) {
    const current = await currentDocument(connection, names, snapshotDocument);
    const expected = snapshotDocument.document;
    if (
      (current === null) !== (expected === null)
      || (
        current
        && expected
        && canonicalEjson(current) !== canonicalEjson(expected)
      )
    ) {
      throw new Error("event reschedule rollback did not restore the snapshot");
    }
  }
  await updateJournalState(
    connection,
    names,
    prepared.journal,
    "rolled-back",
    sourceSha
  );
  return report({
    mode,
    state: "rolled-back",
    ready: true,
    scanned: DEPENDENCY_LOCATIONS.length + TARGET_LOCATIONS.length + 3,
    matched: prepared.snapshot.documents.filter(({ document }) => document)
      .length,
    changed: changed + 1,
    journalVerified: true,
    snapshotDocumentCount: prepared.snapshot.documents.filter(
      ({ document }) => document
    ).length,
    targetDocumentCount: prepared.target.documents.length,
    snapshotSha256: prepared.journal.snapshotSha256,
    targetSha256: prepared.journal.targetSha256,
    blockers: [],
  });
};

export const parseRescheduleArgs = (
  argv: string[] = process.argv.slice(2)
): Pick<RescheduleOptions, "mode" | "confirmation"> => {
  let mode: RescheduleMode = "dry-run";
  let confirmation: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      const value = argv[index + 1];
      if (
        !value
        || !["dry-run", "apply", "verify", "rollback"].includes(value)
      ) {
        throw new Error("--mode must be dry-run, apply, verify, or rollback");
      }
      mode = value as RescheduleMode;
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

export const rescheduleReportExitCode = (
  rescheduleReport: Pick<RescheduleReport, "ready">
): 0 | 1 => rescheduleReport.ready ? 0 : 1;

export const runRescheduleCli = async (
  argv: string[] = process.argv.slice(2)
): Promise<void> => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }
  const options = parseRescheduleArgs(argv);
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const rescheduleReport = await runSyntheticEventReschedule({
      ...options,
      sourceSha: process.env.SOURCE_SHA,
    });
    process.stdout.write(`${JSON.stringify(rescheduleReport)}\n`);
    if (rescheduleReportExitCode(rescheduleReport) !== 0) {
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  void runRescheduleCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "reschedule failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
