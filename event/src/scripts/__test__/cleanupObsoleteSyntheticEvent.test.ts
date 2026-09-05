import mongoose from "mongoose";
import {
  APPLY_CONFIRMATION,
  OBSOLETE_EVENT_AWAY,
  OBSOLETE_EVENT_HOME,
  OBSOLETE_EVENT_ID,
  OBSOLETE_EVENT_NAME,
  ROLLBACK_CONFIRMATION,
  cleanupReportExitCode,
  parseCleanupArgs,
  runObsoleteSyntheticEventCleanup,
} from "../cleanupObsoleteSyntheticEvent";

const databaseNames = () => {
  const prefix = `cleanup_${new mongoose.Types.ObjectId().toHexString()}`;
  return {
    event: `${prefix}_event`,
    gamemaster: `${prefix}_gamemaster`,
    moderation: `${prefix}_moderation`,
    resulting: `${prefix}_resulting`,
    bet: `${prefix}_bet`,
    slip: `${prefix}_slip`,
  };
};

const targetEvent = () => ({
  _id: new mongoose.Types.ObjectId(),
  eventId: OBSOLETE_EVENT_ID,
  name: OBSOLETE_EVENT_NAME,
  home: OBSOLETE_EVENT_HOME,
  away: OBSOLETE_EVENT_AWAY,
  time: new Date("2030-01-01T12:00:00.000Z"),
  status: "NO_RESULT",
  visibility: "OFFLINE",
  products: [],
  __v: 0,
});

const targetGamemasterEvent = () => ({
  _id: new mongoose.Types.ObjectId(),
  eventId: OBSOLETE_EVENT_ID,
  name: OBSOLETE_EVENT_NAME,
  home: OBSOLETE_EVENT_HOME,
  away: OBSOLETE_EVENT_AWAY,
  time: new Date("2030-01-01T12:00:00.000Z"),
  status: "NO_RESULT",
  phase: "PRE_MATCH",
  __v: 0,
});

const dropDatabases = async (names: ReturnType<typeof databaseNames>) => {
  await Promise.all(
    Object.values(names).map(async (name) => {
      const db = mongoose.connection.useDb(name, { useCache: true }).db;
      if (db) {
        await db.dropDatabase();
      }
    })
  );
};

it("dry-runs, removes, verifies, and rolls back only the fixed synthetic event", async () => {
  const names = databaseNames();
  const eventDocument = targetEvent();
  const gamemasterDocument = targetGamemasterEvent();
  const mirrorDocument = {
    _id: new mongoose.Types.ObjectId(),
    eventId: OBSOLETE_EVENT_ID,
    sequence: 0,
    markets: [],
  };
  const eventDb = mongoose.connection.useDb(names.event, { useCache: true }).db!;
  const gamemasterDb = mongoose.connection.useDb(
    names.gamemaster,
    { useCache: true }
  ).db!;
  const moderationDb = mongoose.connection.useDb(
    names.moderation,
    { useCache: true }
  ).db!;

  try {
    await eventDb.collection("events").insertOne(eventDocument);
    await gamemasterDb.collection("events").insertOne(gamemasterDocument);
    await moderationDb.collection("liveeventmirrors").insertOne(mirrorDocument);

    const dryRun = await runObsoleteSyntheticEventCleanup({
      mode: "dry-run",
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(dryRun).toMatchObject({
      state: "candidate",
      ready: true,
      matched: 3,
      changed: 0,
      tombstoneVerified: false,
    });

    const applied = await runObsoleteSyntheticEventCleanup({
      mode: "apply",
      confirmation: APPLY_CONFIRMATION,
      sourceSha: "a".repeat(40),
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(applied).toMatchObject({
      state: "removed",
      ready: true,
      matched: 3,
      changed: 3,
      tombstoneVerified: true,
      snapshotDocumentCount: 3,
    });
    expect(applied.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await eventDb.collection("events").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(0);
    expect(
      await gamemasterDb.collection("events").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(0);
    expect(
      await moderationDb.collection("liveeventmirrors").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(0);
    expect(
      await gamemasterDb.collection("eventarchives").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
        "cleanupTombstone.schemaVersion":
          "obsolete-synthetic-event-cleanup-v1",
      })
    ).toBe(1);

    await eventDb.collection("events").insertOne(eventDocument);
    const partial = await runObsoleteSyntheticEventCleanup({
      mode: "dry-run",
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(partial).toMatchObject({
      state: "partial",
      ready: true,
      matched: 1,
      changed: 0,
      tombstoneVerified: true,
    });

    const repeatedApply = await runObsoleteSyntheticEventCleanup({
      mode: "apply",
      confirmation: APPLY_CONFIRMATION,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(repeatedApply).toMatchObject({
      state: "removed",
      ready: true,
      changed: 1,
      tombstoneVerified: true,
    });

    const rolledBack = await runObsoleteSyntheticEventCleanup({
      mode: "rollback",
      confirmation: ROLLBACK_CONFIRMATION,
      connection: mongoose.connection,
      databaseNames: names,
    });
    expect(rolledBack).toMatchObject({
      state: "restored",
      ready: true,
      changed: 4,
      tombstoneVerified: false,
      snapshotDocumentCount: 3,
    });
    expect(
      await eventDb.collection("events").findOne({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toEqual(eventDocument);
    expect(
      await gamemasterDb.collection("events").findOne({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toEqual(gamemasterDocument);
    expect(
      await moderationDb.collection("liveeventmirrors").findOne({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toEqual(mirrorDocument);
    expect(
      await gamemasterDb.collection("eventarchives").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(0);
  } finally {
    await dropDatabases(names);
  }
});

it("blocks cleanup when a financial record references the event", async () => {
  const names = databaseNames();
  const eventDb = mongoose.connection.useDb(names.event, { useCache: true }).db!;
  const betDb = mongoose.connection.useDb(names.bet, { useCache: true }).db!;

  try {
    await eventDb.collection("events").insertOne(targetEvent());
    await betDb.collection("bets").insertOne({
      _id: new mongoose.Types.ObjectId(),
      rows: [{ eventId: OBSOLETE_EVENT_ID }],
    });

    const cleanup = await runObsoleteSyntheticEventCleanup({
      mode: "apply",
      confirmation: APPLY_CONFIRMATION,
      connection: mongoose.connection,
      databaseNames: names,
    });

    expect(cleanup).toMatchObject({
      state: "blocked",
      ready: false,
      changed: 0,
    });
    expect(cleanup.blockers).toContainEqual({
      database: names.bet,
      collection: "bets",
      count: 1,
      reason: "event reference",
    });
    expect(
      await eventDb.collection("events").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(1);
  } finally {
    await dropDatabases(names);
  }
});

it("blocks queued and summarized event references", async () => {
  const names = databaseNames();
  const moderationDb = mongoose.connection.useDb(
    names.moderation,
    { useCache: true }
  ).db!;
  const resultingDb = mongoose.connection.useDb(
    names.resulting,
    { useCache: true }
  ).db!;

  try {
    await moderationDb.collection("parkedplacebets").insertOne({
      pendingEventIds: [OBSOLETE_EVENT_ID],
    });
    await resultingDb.collection("retryrecords").insertOne({
      payloadSummary: {
        eventIds: [OBSOLETE_EVENT_ID],
      },
    });

    const cleanup = await runObsoleteSyntheticEventCleanup({
      mode: "dry-run",
      connection: mongoose.connection,
      databaseNames: names,
    });

    expect(cleanup).toMatchObject({
      state: "blocked",
      ready: false,
      changed: 0,
    });
    expect(cleanup.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        database: names.moderation,
        collection: "parkedplacebets",
      }),
      expect.objectContaining({
        database: names.resulting,
        collection: "retryrecords",
      }),
    ]));
  } finally {
    await dropDatabases(names);
  }
});

it("blocks a same-ID event whose reviewed identity no longer matches", async () => {
  const names = databaseNames();
  const eventDb = mongoose.connection.useDb(names.event, { useCache: true }).db!;

  try {
    await eventDb.collection("events").insertOne({
      ...targetEvent(),
      visibility: "ONLINE",
    });

    const cleanup = await runObsoleteSyntheticEventCleanup({
      mode: "dry-run",
      connection: mongoose.connection,
      databaseNames: names,
    });

    expect(cleanup.state).toBe("blocked");
    expect(cleanup.ready).toBe(false);
    expect(cleanup.blockers[0].reason).toContain("identity");
  } finally {
    await dropDatabases(names);
  }
});

it("requires explicit independent confirmation for apply and rollback", async () => {
  expect(parseCleanupArgs([])).toEqual({
    mode: "dry-run",
    confirmation: undefined,
  });
  expect(parseCleanupArgs(["--mode", "apply", "--confirmation", APPLY_CONFIRMATION]))
    .toEqual({ mode: "apply", confirmation: APPLY_CONFIRMATION });
  expect(
    parseCleanupArgs([
      "--mode",
      "rollback",
      "--confirmation",
      ROLLBACK_CONFIRMATION,
    ])
  ).toEqual({ mode: "rollback", confirmation: ROLLBACK_CONFIRMATION });
  await expect(
    runObsoleteSyntheticEventCleanup({ mode: "apply" })
  ).rejects.toThrow(APPLY_CONFIRMATION);
  await expect(
    runObsoleteSyntheticEventCleanup({ mode: "rollback" })
  ).rejects.toThrow(ROLLBACK_CONFIRMATION);
});

it("keeps blocked CLI reports nonzero for the rollout wrapper", () => {
  expect(cleanupReportExitCode({ ready: true })).toBe(0);
  expect(cleanupReportExitCode({ ready: false })).toBe(1);
});

it("blocks an unrelated pre-existing Gamemaster archive", async () => {
  const names = databaseNames();
  const eventDb = mongoose.connection.useDb(names.event, { useCache: true }).db!;
  const gamemasterDb = mongoose.connection.useDb(
    names.gamemaster,
    { useCache: true }
  ).db!;

  try {
    await eventDb.collection("events").insertOne(targetEvent());
    await gamemasterDb.collection("eventarchives").insertOne({
      ...targetGamemasterEvent(),
      completedAt: new Date(),
    });

    const cleanup = await runObsoleteSyntheticEventCleanup({
      mode: "dry-run",
      connection: mongoose.connection,
      databaseNames: names,
    });

    expect(cleanup).toMatchObject({
      state: "blocked",
      ready: false,
      changed: 0,
    });
    expect(cleanup.blockers[0].reason).toContain("unrelated or invalid");
  } finally {
    await dropDatabases(names);
  }
});

it("blocks a tombstone whose stored snapshot checksum was changed", async () => {
  const names = databaseNames();
  const eventDb = mongoose.connection.useDb(names.event, { useCache: true }).db!;
  const gamemasterDb = mongoose.connection.useDb(
    names.gamemaster,
    { useCache: true }
  ).db!;

  try {
    await eventDb.collection("events").insertOne(targetEvent());
    await gamemasterDb.collection("events").insertOne(targetGamemasterEvent());
    await runObsoleteSyntheticEventCleanup({
      mode: "apply",
      confirmation: APPLY_CONFIRMATION,
      connection: mongoose.connection,
      databaseNames: names,
    });
    await gamemasterDb.collection("eventarchives").updateOne(
      { eventId: OBSOLETE_EVENT_ID },
      { $set: { "cleanupTombstone.snapshotSha256": "0".repeat(64) } }
    );

    const cleanup = await runObsoleteSyntheticEventCleanup({
      mode: "dry-run",
      connection: mongoose.connection,
      databaseNames: names,
    });

    expect(cleanup).toMatchObject({
      state: "blocked",
      ready: false,
      changed: 0,
      tombstoneVerified: false,
    });
    expect(cleanup.blockers[0].reason).toContain("invalid");
  } finally {
    await dropDatabases(names);
  }
});

it("rejects an oversized snapshot before changing source data", async () => {
  const names = databaseNames();
  const eventDb = mongoose.connection.useDb(names.event, { useCache: true }).db!;
  const gamemasterDb = mongoose.connection.useDb(
    names.gamemaster,
    { useCache: true }
  ).db!;

  try {
    await eventDb.collection("events").insertOne({
      ...targetEvent(),
      oversizedField: "x".repeat(4 * 1024 * 1024),
    });
    await expect(
      runObsoleteSyntheticEventCleanup({
        mode: "apply",
        confirmation: APPLY_CONFIRMATION,
        connection: mongoose.connection,
        databaseNames: names,
      })
    ).rejects.toThrow("snapshot exceeds");
    expect(
      await eventDb.collection("events").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(1);
    expect(
      await gamemasterDb.collection("eventarchives").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(0);
  } finally {
    await dropDatabases(names);
  }
});

it("preflights every rollback target before restoring any document", async () => {
  const names = databaseNames();
  const eventDb = mongoose.connection.useDb(names.event, { useCache: true }).db!;
  const gamemasterDb = mongoose.connection.useDb(
    names.gamemaster,
    { useCache: true }
  ).db!;
  const moderationDb = mongoose.connection.useDb(
    names.moderation,
    { useCache: true }
  ).db!;

  try {
    await eventDb.collection("events").insertOne(targetEvent());
    await gamemasterDb.collection("events").insertOne(targetGamemasterEvent());
    await moderationDb.collection("liveeventmirrors").insertOne({
      eventId: OBSOLETE_EVENT_ID,
      sequence: 0,
      markets: [],
    });
    await runObsoleteSyntheticEventCleanup({
      mode: "apply",
      confirmation: APPLY_CONFIRMATION,
      connection: mongoose.connection,
      databaseNames: names,
    });
    await moderationDb.collection("liveeventmirrors").insertOne({
      eventId: OBSOLETE_EVENT_ID,
      sequence: 99,
      markets: [],
    });

    await expect(
      runObsoleteSyntheticEventCleanup({
        mode: "rollback",
        confirmation: ROLLBACK_CONFIRMATION,
        connection: mongoose.connection,
        databaseNames: names,
      })
    ).rejects.toThrow("rollback conflicts");
    expect(
      await eventDb.collection("events").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(0);
    expect(
      await gamemasterDb.collection("events").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(0);
    expect(
      await gamemasterDb.collection("eventarchives").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(1);
  } finally {
    await dropDatabases(names);
  }
});

it("keeps the tombstone when rollback finds an unexpected target location", async () => {
  const names = databaseNames();
  const eventDb = mongoose.connection.useDb(names.event, { useCache: true }).db!;
  const gamemasterDb = mongoose.connection.useDb(
    names.gamemaster,
    { useCache: true }
  ).db!;
  const moderationDb = mongoose.connection.useDb(
    names.moderation,
    { useCache: true }
  ).db!;

  try {
    await eventDb.collection("events").insertOne(targetEvent());
    await gamemasterDb.collection("events").insertOne(targetGamemasterEvent());
    await runObsoleteSyntheticEventCleanup({
      mode: "apply",
      confirmation: APPLY_CONFIRMATION,
      connection: mongoose.connection,
      databaseNames: names,
    });
    await moderationDb.collection("liveeventmirrors").insertOne({
      eventId: OBSOLETE_EVENT_ID,
      sequence: 99,
      markets: [],
    });

    await expect(
      runObsoleteSyntheticEventCleanup({
        mode: "rollback",
        confirmation: ROLLBACK_CONFIRMATION,
        connection: mongoose.connection,
        databaseNames: names,
      })
    ).rejects.toThrow("unexpected current data");
    expect(
      await eventDb.collection("events").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(0);
    expect(
      await gamemasterDb.collection("events").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(0);
    expect(
      await gamemasterDb.collection("eventarchives").countDocuments({
        eventId: OBSOLETE_EVENT_ID,
      })
    ).toBe(1);
  } finally {
    await dropDatabases(names);
  }
});
