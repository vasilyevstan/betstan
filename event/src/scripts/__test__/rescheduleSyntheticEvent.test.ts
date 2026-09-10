import mongoose from "mongoose";
import {
  APPLY_CONFIRMATION,
  RESCHEDULE_BACKOFFICE_ID,
  RESCHEDULE_EVENT_AWAY,
  RESCHEDULE_EVENT_HOME,
  RESCHEDULE_EVENT_ID,
  RESCHEDULE_EVENT_NAME,
  RESCHEDULE_OLD_KICKOFF,
  RESCHEDULE_TARGET_KICKOFF,
  ROLLBACK_CONFIRMATION,
  parseRescheduleArgs,
  rescheduleReportExitCode,
  runSyntheticEventReschedule,
} from "../rescheduleSyntheticEvent";

const SOURCE_SHA = "a".repeat(40);
const LATER_SOURCE_SHA = "b".repeat(40);
const OLD_EVENT_ID = "6a623af592af5a95b1d0bb79";
const OLD_BACKOFFICE_ID = "6a623af592af5a95b1d0bb7a";
const JOURNAL_ID =
  `event-reschedule:${RESCHEDULE_EVENT_ID}:${RESCHEDULE_TARGET_KICKOFF}`;
const safeApplyTime = new Date(
  new Date(RESCHEDULE_TARGET_KICKOFF).getTime() - 60 * 60 * 1000
);
const unsafeApplyTime = new Date(
  new Date(RESCHEDULE_TARGET_KICKOFF).getTime() - 10 * 60 * 1000
);

const databaseNames = () => {
  const prefix = `reschedule_${new mongoose.Types.ObjectId().toHexString()}`;
  return {
    backoffice: `${prefix}_backoffice`,
    event: `${prefix}_event`,
    gamemaster: `${prefix}_gamemaster`,
    moderation: `${prefix}_moderation`,
    resulting: `${prefix}_resulting`,
    bet: `${prefix}_bet`,
    slip: `${prefix}_slip`,
  };
};

type DatabaseNames = ReturnType<typeof databaseNames>;

interface JournalDocument extends mongoose.mongo.Document {
  _id: string;
  state?: string;
  snapshotSha256?: string;
  snapshotEjson?: string;
  targetEjson?: string;
}

const database = (names: DatabaseNames, name: keyof DatabaseNames) =>
  mongoose.connection.useDb(names[name], { useCache: true }).db!;

const canonicalEjson = (value: unknown) =>
  mongoose.mongo.BSON.EJSON.stringify(value, { relaxed: false });

const journalCollection = (names: DatabaseNames) =>
  database(names, "event")
    .collection<JournalDocument>("eventrescheduleoperations");

const oldBackofficeEvent = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  _id: new mongoose.Types.ObjectId(OLD_BACKOFFICE_ID),
  eventId: OLD_EVENT_ID,
  name: RESCHEDULE_EVENT_NAME,
  home: RESCHEDULE_EVENT_HOME,
  away: RESCHEDULE_EVENT_AWAY,
  time: RESCHEDULE_OLD_KICKOFF,
  status: "NO_RESULT",
  visibility: "OFFLINE",
  creationRequestId: "legacy-home-1-away-1",
  creationRequestFingerprint: "reviewed-fixture",
  newEventPublicationPending: false,
  resultPublicationPending: false,
  visibilityPublicationPending: false,
  __v: 0,
  ...overrides,
});

const oldEventProjection = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  _id: new mongoose.Types.ObjectId(),
  eventId: OLD_EVENT_ID,
  name: RESCHEDULE_EVENT_NAME,
  home: RESCHEDULE_EVENT_HOME,
  away: RESCHEDULE_EVENT_AWAY,
  time: new Date(RESCHEDULE_OLD_KICKOFF),
  status: "NO_RESULT",
  visibility: "OFFLINE",
  source: "EXTERNAL",
  visibilityInitialized: true,
  eventMetadataInitialized: true,
  visibilityDecision: "OFFLINE",
  products: [{
    _id: new mongoose.Types.ObjectId(),
    id: "preserved-product",
    type: "1X2",
    name: "1X2",
    odds: [{
      _id: new mongoose.Types.ObjectId(),
      id: "preserved-selection",
      name: RESCHEDULE_EVENT_HOME,
      value: 2,
    }],
  }],
  live: null,
  liveRaceResultedAt: null,
  liveRetiredAt: null,
  newEventPublishedAt: new Date("2026-07-23T16:30:00.000Z"),
  newEventPublishAttempts: 1,
  newEventPublishClaimedAt: null,
  newEventPublishClaimToken: null,
  __v: 0,
  ...overrides,
});

const oldGamemasterProjection = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  _id: new mongoose.Types.ObjectId(),
  eventId: OLD_EVENT_ID,
  name: RESCHEDULE_EVENT_NAME,
  home: RESCHEDULE_EVENT_HOME,
  away: RESCHEDULE_EVENT_AWAY,
  time: new Date(RESCHEDULE_OLD_KICKOFF),
  status: "NO_RESULT",
  phase: "PRE_MATCH",
  liveSeed: "c".repeat(64),
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
  ...overrides,
});

const insertBackofficeEvent = async (
  names: DatabaseNames,
  document = oldBackofficeEvent()
) => {
  await database(names, "backoffice").collection("events").insertOne(document);
};

const dropDatabases = async (names: DatabaseNames) => {
  await Promise.all(
    Object.values(names).map(async (name) => {
      await mongoose.connection.useDb(name, { useCache: true }).db
        ?.dropDatabase();
    })
  );
};

const apply = (
  names: DatabaseNames,
  overrides: Record<string, unknown> = {}
) => runSyntheticEventReschedule({
  mode: "apply",
  confirmation: APPLY_CONFIRMATION,
  sourceSha: SOURCE_SHA,
  now: safeApplyTime,
  connection: mongoose.connection,
  databaseNames: names,
  ...overrides,
});

const setJournalPrepared = async (names: DatabaseNames) => {
  await journalCollection(names).updateOne(
      { _id: JOURNAL_ID },
      {
        $set: { state: "prepared" },
        $unset: {
          appliedAt: "",
          rolledBackAt: "",
          rollbackSourceSha: "",
        },
      }
    );
};

it("dry-runs, deterministically creates projections, verifies, and completes for later releases", async () => {
  const firstNames = databaseNames();
  const secondNames = databaseNames();
  try {
    await Promise.all([
      insertBackofficeEvent(firstNames),
      insertBackofficeEvent(secondNames),
    ]);

    const dryRun = await runSyntheticEventReschedule({
      mode: "dry-run",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: firstNames,
    });
    expect(dryRun).toMatchObject({
      state: "candidate",
      ready: true,
      matched: 0,
      changed: 0,
      journalVerified: false,
      snapshotDocumentCount: 0,
      targetDocumentCount: 3,
    });

    const firstApply = await apply(firstNames);
    const secondApply = await apply(secondNames);
    expect(firstApply).toMatchObject({
      state: "applied",
      ready: true,
      matched: 3,
      changed: 4,
      journalVerified: true,
      snapshotDocumentCount: 0,
      targetDocumentCount: 3,
    });
    expect(firstApply.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(firstApply.targetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(secondApply.targetSha256).toBe(firstApply.targetSha256);

    const firstEvent = await database(firstNames, "event")
      .collection("events").findOne({ eventId: RESCHEDULE_EVENT_ID });
    const secondEvent = await database(secondNames, "event")
      .collection("events").findOne({ eventId: RESCHEDULE_EVENT_ID });
    const firstGamemaster = await database(firstNames, "gamemaster")
      .collection("events").findOne({ eventId: RESCHEDULE_EVENT_ID });
    const secondGamemaster = await database(secondNames, "gamemaster")
      .collection("events").findOne({ eventId: RESCHEDULE_EVENT_ID });
    const backoffice = await database(firstNames, "backoffice")
      .collection("events").findOne({ eventId: RESCHEDULE_EVENT_ID });
    const secondBackoffice = await database(secondNames, "backoffice")
      .collection("events").findOne({ eventId: RESCHEDULE_EVENT_ID });
    expect(backoffice).toEqual(secondBackoffice);
    expect(firstEvent).toEqual(secondEvent);
    expect(firstGamemaster).toEqual(secondGamemaster);
    expect(backoffice?._id).toEqual(
      new mongoose.Types.ObjectId(RESCHEDULE_BACKOFFICE_ID)
    );
    expect(firstEvent).toMatchObject({
      eventId: RESCHEDULE_EVENT_ID,
      time: new Date(RESCHEDULE_TARGET_KICKOFF),
      status: "NO_RESULT",
      visibility: "OFFLINE",
      visibilityInitialized: true,
      eventMetadataInitialized: true,
      visibilityDecision: "OFFLINE",
      live: null,
    });
    expect(firstEvent?.products).toEqual([
      expect.objectContaining({
        type: "1X2",
        name: "1X2",
        odds: [
          expect.objectContaining({ name: RESCHEDULE_EVENT_HOME }),
          expect.objectContaining({ name: "draw" }),
          expect.objectContaining({ name: RESCHEDULE_EVENT_AWAY }),
        ],
      }),
      expect.objectContaining({
        type: "CS",
        name: "Correct Score",
      }),
    ]);
    expect(firstGamemaster).toMatchObject({
      eventId: RESCHEDULE_EVENT_ID,
      time: new Date(RESCHEDULE_TARGET_KICKOFF),
      status: "NO_RESULT",
      phase: "PRE_MATCH",
      liveSequence: 0,
      liveConfirmedReplayCursor: 0,
      liveHomeScore: 0,
      liveAwayScore: 0,
      liveTransitions: [],
      liveMarkets: [],
    });
    expect(firstGamemaster?.liveSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(firstGamemaster?.liveSeed).not.toBe(RESCHEDULE_EVENT_ID);
    expect(backoffice?.time).toBe(RESCHEDULE_TARGET_KICKOFF);
    expect(typeof backoffice?.time).toBe("string");
    expect(firstEvent?.time).toBeInstanceOf(Date);
    expect(firstGamemaster?.time).toBeInstanceOf(Date);
    for (const target of [backoffice, firstEvent, firstGamemaster]) {
      for (const field of [
        "creationRequestId",
        "creationRequestFingerprint",
        "newEventPublicationPending",
        "resultPublicationPending",
        "visibilityPublicationPending",
        "visibilityPublicationTarget",
      ]) {
        expect(Object.prototype.hasOwnProperty.call(target, field)).toBe(false);
      }
    }

    const journal = await journalCollection(firstNames).findOne({
      _id: JOURNAL_ID,
    });
    const snapshot = mongoose.mongo.BSON.EJSON.parse(
      journal!.snapshotEjson!,
      { relaxed: false }
    ) as { documents: Array<{ document: unknown }> };
    expect(snapshot.documents).toHaveLength(3);
    expect(snapshot.documents.every(({ document }) => document === null))
      .toBe(true);

    const verified = await runSyntheticEventReschedule({
      mode: "verify",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: firstNames,
    });
    expect(verified).toMatchObject({
      state: "verified",
      ready: true,
      changed: 0,
      journalVerified: true,
    });

    const repeated = await apply(firstNames);
    expect(repeated).toMatchObject({
      state: "applied",
      ready: true,
      changed: 0,
    });

    await database(firstNames, "event").collection("events").updateOne(
      { eventId: RESCHEDULE_EVENT_ID },
      { $set: { phaseAfterRelease: "naturally-progressed" } }
    );
    const completed = await runSyntheticEventReschedule({
      mode: "verify",
      sourceSha: LATER_SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: firstNames,
    });
    expect(completed).toMatchObject({
      state: "completed",
      ready: true,
      changed: 0,
      journalVerified: true,
    });
  } finally {
    await Promise.all([
      dropDatabases(firstNames),
      dropDatabases(secondNames),
    ]);
  }
});

it("leaves the old fixture and its archived Slip mirrors byte-identical", async () => {
  const names = databaseNames();
  const oldDocuments = [
    {
      database: "backoffice" as const,
      collection: "events",
      document: oldBackofficeEvent(),
    },
    {
      database: "event" as const,
      collection: "events",
      document: oldEventProjection({ live: { phase: "FULL_TIME" } }),
    },
    {
      database: "gamemaster" as const,
      collection: "events",
      document: oldGamemasterProjection({
        phase: "FULL_TIME",
        liveSequence: 42,
      }),
    },
    {
      database: "gamemaster" as const,
      collection: "eventarchives",
      document: {
        _id: new mongoose.Types.ObjectId(),
        eventId: OLD_EVENT_ID,
        reason: "historical-old-fixture",
      },
    },
    {
      database: "moderation" as const,
      collection: "liveeventmirrors",
      document: {
        _id: new mongoose.Types.ObjectId(),
        eventId: OLD_EVENT_ID,
        phase: "FULL_TIME",
      },
    },
    {
      database: "slip" as const,
      collection: "sliparchives",
      document: {
        _id: new mongoose.Types.ObjectId(),
        slipId: "archived-old-slip",
        rows: [{ eventId: OLD_EVENT_ID, status: "WIN" }],
      },
    },
    {
      database: "bet" as const,
      collection: "bets",
      document: {
        _id: new mongoose.Types.ObjectId(),
        slipId: "archived-old-slip",
        rows: [{ eventId: OLD_EVENT_ID, status: "WIN" }],
      },
    },
    {
      database: "moderation" as const,
      collection: "bets",
      document: {
        _id: new mongoose.Types.ObjectId(),
        slipId: "archived-old-slip",
        rows: [{ eventId: OLD_EVENT_ID, status: "WIN" }],
      },
    },
    {
      database: "resulting" as const,
      collection: "betarchives",
      document: {
        _id: new mongoose.Types.ObjectId(),
        slipId: "archived-old-slip",
        rows: [{ eventId: OLD_EVENT_ID, status: "WIN" }],
      },
    },
  ];
  try {
    for (const fixture of oldDocuments) {
      await database(names, fixture.database)
        .collection(fixture.collection)
        .insertOne(fixture.document);
    }
    const before = await Promise.all(oldDocuments.map(async (fixture) =>
      canonicalEjson(await database(names, fixture.database)
        .collection(fixture.collection)
        .findOne({
          _id: fixture.document._id as mongoose.Types.ObjectId,
        }))));

    const applied = await apply(names);
    expect(applied).toMatchObject({
      state: "applied",
      ready: true,
      snapshotDocumentCount: 0,
      changed: 4,
    });
    for (let index = 0; index < oldDocuments.length; index += 1) {
      const fixture = oldDocuments[index];
      expect(canonicalEjson(await database(names, fixture.database)
        .collection(fixture.collection)
        .findOne({
          _id: fixture.document._id as mongoose.Types.ObjectId,
        }))).toBe(before[index]);
    }

    const rolledBack = await runSyntheticEventReschedule({
      mode: "rollback",
      confirmation: ROLLBACK_CONFIRMATION,
      sourceSha: LATER_SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(rolledBack).toMatchObject({
      state: "rolled-back",
      ready: true,
      changed: 4,
      journalVerified: true,
    });
    for (let index = 0; index < oldDocuments.length; index += 1) {
      const fixture = oldDocuments[index];
      expect(canonicalEjson(await database(names, fixture.database)
        .collection(fixture.collection)
        .findOne({
          _id: fixture.document._id as mongoose.Types.ObjectId,
        }))).toBe(before[index]);
    }
    for (const databaseName of ["backoffice", "event", "gamemaster"] as const) {
      expect(await database(names, databaseName).collection("events")
        .countDocuments({ eventId: RESCHEDULE_EVENT_ID })).toBe(0);
    }

    const repeatedRollback = await runSyntheticEventReschedule({
      mode: "rollback",
      confirmation: ROLLBACK_CONFIRMATION,
      sourceSha: LATER_SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(repeatedRollback).toMatchObject({
      state: "rolled-back",
      ready: true,
      changed: 0,
    });
    const reapply = await apply(names);
    expect(reapply).toMatchObject({
      state: "blocked",
      ready: false,
    });
    expect(reapply.blockers[0].reason).toBe(
      "event reschedule was explicitly rolled back"
    );
  } finally {
    await dropDatabases(names);
  }
});

it("rolls back a prepared partial operation without invalidating the journal", async () => {
  const names = databaseNames();
  const originalBackoffice = oldBackofficeEvent();
  try {
    await insertBackofficeEvent(names, originalBackoffice);
    await apply(names);
    await setJournalPrepared(names);
    await database(names, "gamemaster").collection("events")
      .deleteOne({ eventId: RESCHEDULE_EVENT_ID });
    await database(names, "backoffice").collection("events").deleteOne(
      { eventId: RESCHEDULE_EVENT_ID },
    );

    const rolledBack = await runSyntheticEventReschedule({
      mode: "rollback",
      confirmation: ROLLBACK_CONFIRMATION,
      sourceSha: LATER_SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(rolledBack).toMatchObject({
      state: "rolled-back",
      ready: true,
      changed: 2,
      journalVerified: true,
    });
    expect(
      await database(names, "event").collection("events")
        .countDocuments({ eventId: RESCHEDULE_EVENT_ID })
    ).toBe(0);
    expect(
      await database(names, "gamemaster").collection("events")
        .countDocuments({ eventId: RESCHEDULE_EVENT_ID })
    ).toBe(0);
    expect(
      await database(names, "backoffice").collection("events")
        .findOne({ eventId: OLD_EVENT_ID })
    ).toEqual(originalBackoffice);
    const journal = await journalCollection(names).findOne({ _id: JOURNAL_ID });
    expect(journal).toMatchObject({
      state: "rolled-back",
      rolledBackAt: expect.any(Date),
      rollbackSourceSha: LATER_SOURCE_SHA,
    });
    expect(journal?.appliedAt).toBeUndefined();

    const repeatedRollback = await runSyntheticEventReschedule({
      mode: "rollback",
      confirmation: ROLLBACK_CONFIRMATION,
      sourceSha: LATER_SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(repeatedRollback).toMatchObject({
      state: "rolled-back",
      ready: true,
      changed: 0,
      journalVerified: true,
    });
  } finally {
    await dropDatabases(names);
  }
});

it.each([
  {
    name: "partially deleted targets",
    removed: ["backoffice", "gamemaster"] as const,
    expectedChanged: 2,
  },
  {
    name: "all deleted targets",
    removed: ["backoffice", "gamemaster", "event"] as const,
    expectedChanged: 1,
  },
])("resumes an interrupted applied rollback with $name", async ({
  removed,
  expectedChanged,
}) => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await apply(names);
    for (const databaseName of removed) {
      await database(names, databaseName).collection("events")
        .deleteOne({ eventId: RESCHEDULE_EVENT_ID });
    }

    const rolledBack = await runSyntheticEventReschedule({
      mode: "rollback",
      confirmation: ROLLBACK_CONFIRMATION,
      sourceSha: LATER_SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(rolledBack).toMatchObject({
      state: "rolled-back",
      ready: true,
      changed: expectedChanged,
      journalVerified: true,
    });
    for (const databaseName of ["backoffice", "event", "gamemaster"] as const) {
      expect(await database(names, databaseName).collection("events")
        .countDocuments({ eventId: RESCHEDULE_EVENT_ID })).toBe(0);
    }
    expect(await journalCollection(names).findOne({ _id: JOURNAL_ID }))
      .toMatchObject({
        state: "rolled-back",
        rollbackSourceSha: LATER_SOURCE_SHA,
      });

    const repeatedRollback = await runSyntheticEventReschedule({
      mode: "rollback",
      confirmation: ROLLBACK_CONFIRMATION,
      sourceSha: LATER_SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(repeatedRollback).toMatchObject({
      state: "rolled-back",
      ready: true,
      changed: 0,
    });
  } finally {
    await dropDatabases(names);
  }
});

it("resumes a prepared partial write, including inside the lead-time window", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await apply(names);
    await setJournalPrepared(names);
    await database(names, "gamemaster").collection("events")
      .deleteOne({ eventId: RESCHEDULE_EVENT_ID });
    await database(names, "backoffice").collection("events").deleteOne(
      { eventId: RESCHEDULE_EVENT_ID },
    );

    const prepared = await runSyntheticEventReschedule({
      mode: "dry-run",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(prepared).toMatchObject({
      state: "prepared",
      ready: true,
      journalVerified: true,
    });

    const resumed = await apply(names, { now: unsafeApplyTime });
    expect(resumed).toMatchObject({
      state: "applied",
      ready: true,
      changed: 3,
      journalVerified: true,
    });
    expect(
      await database(names, "gamemaster").collection("events")
        .countDocuments({ eventId: RESCHEDULE_EVENT_ID })
    ).toBe(1);
    expect(
      await database(names, "backoffice").collection("events")
        .findOne({ eventId: RESCHEDULE_EVENT_ID })
    ).toMatchObject({ time: RESCHEDULE_TARGET_KICKOFF });
  } finally {
    await dropDatabases(names);
  }
});

it("blocks an unstarted apply inside the lead-time window without creating a journal", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    const blocked = await apply(names, { now: unsafeApplyTime });
    expect(blocked).toMatchObject({
      state: "blocked",
      ready: false,
      changed: 0,
    });
    expect(blocked.blockers).toContainEqual({
      database: names.gamemaster,
      collection: "events",
      count: 1,
      reason: "target kickoff is inside the protected lead-time window",
    });
    expect(
      await journalCollection(names).countDocuments({})
    ).toBe(0);
  } finally {
    await dropDatabases(names);
  }
});

it("blocks a prepared but unstarted apply inside the lead-time window", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await apply(names);
    await setJournalPrepared(names);
    await database(names, "event").collection("events")
      .deleteOne({ eventId: RESCHEDULE_EVENT_ID });
    await database(names, "gamemaster").collection("events")
      .deleteOne({ eventId: RESCHEDULE_EVENT_ID });
    await database(names, "backoffice").collection("events").deleteOne(
      { eventId: RESCHEDULE_EVENT_ID },
    );

    const blocked = await apply(names, { now: unsafeApplyTime });
    expect(blocked).toMatchObject({
      state: "blocked",
      ready: false,
      changed: 0,
      journalVerified: true,
    });
    expect(blocked.blockers[0].reason).toBe(
      "target kickoff is inside the protected lead-time window"
    );
  } finally {
    await dropDatabases(names);
  }
});

it("binds a prepared journal to the source SHA that created it", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await apply(names);
    await setJournalPrepared(names);

    for (const mode of ["dry-run", "apply", "verify"] as const) {
      const result = await runSyntheticEventReschedule({
        mode,
        confirmation: mode === "apply" ? APPLY_CONFIRMATION : undefined,
        sourceSha: LATER_SOURCE_SHA,
        now: safeApplyTime,
        connection: mongoose.connection,
        databaseNames: names,
      });
      expect(result).toMatchObject({
        state: "blocked",
        ready: false,
        journalVerified: true,
      });
      expect(result.blockers[0].reason).toBe(
        "prepared event reschedule belongs to a different source SHA"
      );
    }
  } finally {
    await dropDatabases(names);
  }
});

it("blocks direct and Slip-linked financial dependencies", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await database(names, "bet").collection("bets").insertOne({
      _id: new mongoose.Types.ObjectId(),
      rows: [{ eventId: RESCHEDULE_EVENT_ID }],
      slipId: "dependent-slip",
    });
    await database(names, "resulting").collection("retryrecords").insertOne({
      _id: new mongoose.Types.ObjectId(),
      slipId: "dependent-slip",
    });

    const blocked = await runSyntheticEventReschedule({
      mode: "dry-run",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(blocked).toMatchObject({
      state: "blocked",
      ready: false,
      changed: 0,
    });
    expect(blocked.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        database: names.bet,
        collection: "bets",
        reason: "event or Slip dependency",
      }),
      expect.objectContaining({
        database: names.resulting,
        collection: "retryrecords",
        reason: "event or Slip dependency",
      }),
    ]));
  } finally {
    await dropDatabases(names);
  }
});

it("blocks Gamemaster archives and Moderation live mirrors", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await database(names, "gamemaster").collection("eventarchives").insertOne({
      _id: new mongoose.Types.ObjectId(),
      eventId: RESCHEDULE_EVENT_ID,
    });
    await database(names, "moderation").collection("liveeventmirrors")
      .insertOne({
        _id: new mongoose.Types.ObjectId(),
        eventId: RESCHEDULE_EVENT_ID,
      });

    const blocked = await runSyntheticEventReschedule({
      mode: "dry-run",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(blocked.blockers).toEqual(expect.arrayContaining([
      {
        database: names.gamemaster,
        collection: "eventarchives",
        count: 1,
        reason: "Gamemaster archive or cleanup tombstone exists",
      },
      {
        database: names.moderation,
        collection: "liveeventmirrors",
        count: 1,
        reason: "live moderation state exists",
      },
    ]));
  } finally {
    await dropDatabases(names);
  }
});

it.each([
  {
    name: "missing Backoffice row",
    documents: async (_names: DatabaseNames) => undefined,
    reason: "Backoffice source identity does not match the reviewed fixture",
  },
  {
    name: "wrong Backoffice id",
    documents: (names: DatabaseNames) => insertBackofficeEvent(
      names,
      oldBackofficeEvent({ _id: new mongoose.Types.ObjectId() })
    ),
    reason: "Backoffice source identity does not match the reviewed fixture",
  },
  {
    name: "stale Backoffice kickoff",
    documents: (names: DatabaseNames) => insertBackofficeEvent(
      names,
      oldBackofficeEvent({ time: "2026-07-23T16:32:00.000Z" })
    ),
    reason: "Backoffice source identity does not match the reviewed fixture",
  },
  {
    name: "pending Backoffice publication",
    documents: (names: DatabaseNames) => insertBackofficeEvent(
      names,
      oldBackofficeEvent({ newEventPublicationPending: true })
    ),
    reason: "Backoffice source identity does not match the reviewed fixture",
  },
])("enforces the bounded old Backoffice prerequisite: $name", async ({
  documents,
  reason,
}) => {
  const names = databaseNames();
  try {
    await documents(names);
    const blocked = await runSyntheticEventReschedule({
      mode: "dry-run",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(blocked).toMatchObject({
      state: "blocked",
      ready: false,
      journalVerified: false,
      snapshotDocumentCount: 0,
      targetDocumentCount: 0,
    });
    expect(blocked.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ count: 1, reason })])
    );
  } finally {
    await dropDatabases(names);
  }
});

it.each([
  {
    name: "fixed target _id",
    databaseName: "backoffice" as const,
    document: {
      _id: new mongoose.Types.ObjectId(RESCHEDULE_BACKOFFICE_ID),
      eventId: "unrelated-event",
    },
  },
  {
    name: "shared new eventId",
    databaseName: "event" as const,
    document: {
      _id: new mongoose.Types.ObjectId(),
      eventId: RESCHEDULE_EVENT_ID,
    },
  },
])("blocks an unjournaled collision by $name", async ({
  databaseName,
  document,
}) => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await database(names, databaseName).collection("events")
      .insertOne(document);
    const blocked = await runSyntheticEventReschedule({
      mode: "dry-run",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(blocked).toMatchObject({
      state: "blocked",
      ready: false,
      journalVerified: false,
      snapshotDocumentCount: 0,
      targetDocumentCount: 0,
    });
    expect(blocked.blockers).toContainEqual({
      database: names[databaseName],
      collection: "events",
      count: 1,
      reason: "duplicate target documents",
    });
  } finally {
    await dropDatabases(names);
  }
});

it("detects target tampering for the applying source", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await apply(names);
    await database(names, "event").collection("events").updateOne(
      { eventId: RESCHEDULE_EVENT_ID },
      {
        $set: {
          time: new Date(
            new Date(RESCHEDULE_TARGET_KICKOFF).getTime() + 60 * 1000
          ),
        },
      }
    );

    const verified = await runSyntheticEventReschedule({
      mode: "verify",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(verified).toMatchObject({
      state: "blocked",
      ready: false,
      journalVerified: true,
    });
    expect(verified.blockers).toContainEqual({
      database: names.event,
      collection: "events",
      count: 1,
      reason: "rescheduled projection does not match the journal target",
    });
  } finally {
    await dropDatabases(names);
  }
});

it("blocks rollback before writes when new-target visibility drifts", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await apply(names);
    await database(names, "backoffice").collection("events").updateOne(
      { eventId: RESCHEDULE_EVENT_ID },
      { $set: { visibility: "ONLINE" } }
    );

    const rollback = await runSyntheticEventReschedule({
      mode: "rollback",
      confirmation: ROLLBACK_CONFIRMATION,
      sourceSha: LATER_SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(rollback).toMatchObject({
      state: "blocked",
      ready: false,
      changed: 0,
      journalVerified: true,
    });
    expect(rollback.blockers).toContainEqual({
      database: names.backoffice,
      collection: "events",
      count: 1,
      reason: "partial reschedule contains an unknown projection state",
    });
    expect(await database(names, "event").collection("events")
      .countDocuments({ eventId: RESCHEDULE_EVENT_ID })).toBe(1);
    expect(await database(names, "gamemaster").collection("events")
      .countDocuments({ eventId: RESCHEDULE_EVENT_ID })).toBe(1);
    expect(await journalCollection(names).findOne({ _id: JOURNAL_ID }))
      .toMatchObject({ state: "applied" });
  } finally {
    await dropDatabases(names);
  }
});

it("rejects a tampered journal before using its snapshots", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await apply(names);
    await journalCollection(names).updateOne(
        { _id: JOURNAL_ID },
        { $set: { snapshotSha256: "0".repeat(64) } }
      );

    await expect(runSyntheticEventReschedule({
      mode: "verify",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    })).rejects.toThrow("event reschedule journal is invalid");
  } finally {
    await dropDatabases(names);
  }
});

it("blocks rollback after a new betting dependency appears", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await apply(names);
    await database(names, "slip").collection("slips").insertOne({
      _id: new mongoose.Types.ObjectId(),
      rows: [{ eventId: RESCHEDULE_EVENT_ID }],
    });

    const rollback = await runSyntheticEventReschedule({
      mode: "rollback",
      confirmation: ROLLBACK_CONFIRMATION,
      sourceSha: LATER_SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(rollback).toMatchObject({
      state: "blocked",
      ready: false,
      changed: 0,
    });
    expect(rollback.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          database: names.slip,
          collection: "slips",
          reason: "event or Slip dependency",
        }),
      ])
    );
    expect(
      await journalCollection(names).findOne({ _id: JOURNAL_ID })
    ).toMatchObject({ state: "applied" });
    for (const databaseName of ["backoffice", "event", "gamemaster"] as const) {
      expect(await database(names, databaseName).collection("events")
        .countDocuments({ eventId: RESCHEDULE_EVENT_ID })).toBe(1);
    }
  } finally {
    await dropDatabases(names);
  }
});

it("reports a missing journal for verify and validates CLI arguments", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    const verify = await runSyntheticEventReschedule({
      mode: "verify",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(verify).toMatchObject({
      state: "blocked",
      ready: false,
      journalVerified: false,
    });
    expect(verify.blockers[0].reason).toBe(
      "event reschedule journal is missing"
    );

    expect(parseRescheduleArgs([])).toEqual({
      mode: "dry-run",
      confirmation: undefined,
    });
    expect(parseRescheduleArgs([
      "--mode",
      "apply",
      "--confirmation",
      APPLY_CONFIRMATION,
    ])).toEqual({
      mode: "apply",
      confirmation: APPLY_CONFIRMATION,
    });
    expect(() => parseRescheduleArgs(["--mode", "invalid"])).toThrow(
      "--mode must be dry-run, apply, verify, or rollback"
    );
    expect(() => parseRescheduleArgs(["--confirmation"])).toThrow(
      "--confirmation requires a value"
    );
    expect(() => parseRescheduleArgs(["--unknown"])).toThrow(
      "unknown argument: --unknown"
    );
    expect(rescheduleReportExitCode({ ready: true })).toBe(0);
    expect(rescheduleReportExitCode({ ready: false })).toBe(1);
  } finally {
    await dropDatabases(names);
  }
});

it("rejects missing confirmations, invalid source SHAs, and invalid modes", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await expect(runSyntheticEventReschedule({
      mode: "apply",
      sourceSha: SOURCE_SHA,
      now: safeApplyTime,
      connection: mongoose.connection,
      databaseNames: names,
    })).rejects.toThrow(`apply requires confirmation ${APPLY_CONFIRMATION}`);
    await expect(runSyntheticEventReschedule({
      mode: "rollback",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    })).rejects.toThrow(
      `rollback requires confirmation ${ROLLBACK_CONFIRMATION}`
    );
    await expect(runSyntheticEventReschedule({
      mode: "verify",
      sourceSha: "short",
      connection: mongoose.connection,
      databaseNames: names,
    })).rejects.toThrow(
      "SOURCE_SHA must be a complete lowercase commit SHA"
    );
    await expect(runSyntheticEventReschedule({
      mode: "unsupported" as "dry-run",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    })).rejects.toThrow("mode must be dry-run, apply, verify, or rollback");
  } finally {
    await dropDatabases(names);
  }
});

it("rejects invalid referenced Slip identities", async () => {
  const names = databaseNames();
  try {
    await insertBackofficeEvent(names);
    await database(names, "bet").collection("bets").insertOne({
      _id: new mongoose.Types.ObjectId(),
      rows: [{ eventId: RESCHEDULE_EVENT_ID }],
      slipId: "invalid slip identity",
    });
    await expect(runSyntheticEventReschedule({
      mode: "dry-run",
      sourceSha: SOURCE_SHA,
      connection: mongoose.connection,
      databaseNames: names,
    })).rejects.toThrow("reschedule found an invalid referenced Slip identity");
  } finally {
    await dropDatabases(names);
  }
});
