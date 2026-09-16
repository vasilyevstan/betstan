import mongoose from "mongoose";
import {
  APPLY_CONFIRMATION,
  CLEANUP_DATABASE_NAME,
  CLEANUP_JOURNAL_COLLECTION,
  CLEANUP_OPERATION_ID,
  CLEANUP_SCHEMA_VERSION,
  CleanupIdentity,
  cleanupIdentityDigest,
  cleanupReportExitCode,
  parseCleanupArgs,
  runCleanupCli,
  runPreSeptemberEventCleanup,
  serializeCleanupReport,
} from "../cleanupPreSeptemberEvents";
import {
  PRE_SEPTEMBER_CLEANUP_CUTOFF,
  parseExplicitZoneTimestamp,
} from "../../event/preSeptemberCleanupBoundary";

const SOURCE_SHA = "a".repeat(40);
const LATER_SOURCE_SHA = "b".repeat(40);
const CREATED_AT = new Date("2026-09-16T10:00:00.000Z");

interface TestJournal extends mongoose.mongo.Document {
  _id: string;
  identities?: CleanupIdentity[];
}

const database = () => mongoose.connection.db!;
const events = () => database().collection("events");
const journals = () =>
  database().collection<TestJournal>(CLEANUP_JOURNAL_COLLECTION);

const eventDocument = (
  eventId: unknown,
  time: unknown,
  overrides: Record<string, unknown> = {}
) => ({
  eventId,
  name: `${String(eventId)} home - away`,
  time,
  home: "home",
  away: "away",
  status: "NO_RESULT",
  visibility: "OFFLINE",
  ...overrides,
});

const sortedIdentities = (
  identities: CleanupIdentity[]
): CleanupIdentity[] =>
  [...identities].sort((left, right) =>
    left.eventId < right.eventId
      ? -1
      : left.eventId > right.eventId
        ? 1
        : left.time < right.time
          ? -1
          : left.time > right.time
            ? 1
            : 0
  );

const insertPreparedJournal = async (
  identities: CleanupIdentity[],
  sourceSha = SOURCE_SHA
) => {
  const sorted = sortedIdentities(identities);
  await journals().insertOne({
    _id: CLEANUP_OPERATION_ID,
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    operation: "delete-backoffice-events-before-cutoff",
    cutoff: PRE_SEPTEMBER_CLEANUP_CUTOFF,
    sourceSha,
    state: "prepared",
    identities: sorted,
    candidateCount: sorted.length,
    digest: cleanupIdentityDigest(sorted),
    createdAt: CREATED_AT,
  });
};

const applyCleanup = (
  overrides: Record<string, unknown> = {}
) =>
  runPreSeptemberEventCleanup({
    mode: "apply",
    confirmation: APPLY_CONFIRMATION,
    sourceSha: SOURCE_SHA,
    database: database(),
    now: CREATED_AT,
    ...overrides,
  });

it.each([
  ["2026-08-31T23:59:59.999Z", true],
  ["2026-09-01T01:59:59.999+02:00", true],
  ["2026-09-01T00:00:00Z", true],
  ["2026-08-31T20:00:00-04:00", true],
  ["2026-09-01T00:00:00.000000001Z", true],
  ["2026-09-01T00:00:00", false],
  ["2026-09-01", false],
  ["2026-09-01 00:00:00Z", false],
  ["2026-09-01T00:00:00z", false],
  ["2026-09-01T00:00:00-00:00", false],
  ["2026-09-01T00:00:00+1401", false],
  ["2026-09-01T00:00:00+14:01", false],
  ["2026-02-30T00:00:00Z", false],
  ["not-a-time", false],
  [123, false],
])("strict explicit-zone parsing classifies %p", (value, valid) => {
  expect(parseExplicitZoneTimestamp(value) !== null).toBe(valid);
});

it("deletes only valid events strictly before the cutoff and preserves the boundary", async () => {
  const unrelatedCollection = database().collection(
    "cleanupacceptancesentinels"
  );
  const sentinel = {
    _id: new mongoose.Types.ObjectId(),
    purpose: "prove unrelated Backoffice data is retained",
    nested: {
      count: 7,
      observedAt: new Date("2026-09-15T12:34:56.789Z"),
    },
  };
  await unrelatedCollection.insertOne(sentinel);
  const sentinelCountBefore = await unrelatedCollection.countDocuments({});
  const sentinelBefore = mongoose.mongo.BSON.EJSON.stringify(
    await unrelatedCollection.findOne({ _id: sentinel._id }),
    { relaxed: false }
  );

  await events().insertMany([
    eventDocument("old-b", "2026-08-31T23:59:59.999Z"),
    eventDocument(
      "old-a",
      "2026-09-01T01:59:59.998+02:00",
      {
        newEventPublicationPending: false,
        resultPublicationPending: false,
        visibilityPublicationPending: false,
      }
    ),
    eventDocument("equal", PRE_SEPTEMBER_CLEANUP_CUTOFF),
    eventDocument("newer", "2026-09-01T00:00:00.001Z"),
  ]);

  const dryRun = await runPreSeptemberEventCleanup({
    mode: "dry-run",
    batchSize: 1,
    database: database(),
  });
  expect(dryRun).toMatchObject({
    state: "candidate",
    counts: {
      scannedCount: 4,
      candidateCount: 2,
      journaledCount: 0,
      deletedCount: 0,
      remainingCandidateCount: 2,
      malformedTimeCount: 0,
    },
    reasonCodes: [],
  });

  const applied = await applyCleanup({ batchSize: 1 });
  expect(applied).toMatchObject({
    operationId: CLEANUP_OPERATION_ID,
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    mode: "apply",
    state: "applied",
    cutoff: PRE_SEPTEMBER_CLEANUP_CUTOFF,
    counts: {
      scannedCount: 2,
      candidateCount: 2,
      journaledCount: 2,
      deletedCount: 2,
      remainingCandidateCount: 0,
      remainingJournalCount: 0,
      malformedTimeCount: 0,
    },
    digest: dryRun.digest,
    reasonCodes: [],
  });
  expect(
    (await events().find({}, { projection: { _id: 0, eventId: 1 } })
      .sort({ eventId: 1 }).toArray())
      .map(({ eventId }) => eventId)
  ).toEqual(["equal", "newer"]);
  expect(await unrelatedCollection.countDocuments({})).toBe(
    sentinelCountBefore
  );
  expect(
    mongoose.mongo.BSON.EJSON.stringify(
      await unrelatedCollection.findOne({ _id: sentinel._id }),
      { relaxed: false }
    )
  ).toBe(sentinelBefore);

  const journal = await journals().findOne({ _id: CLEANUP_OPERATION_ID });
  expect(journal).toEqual({
    _id: CLEANUP_OPERATION_ID,
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    operation: "delete-backoffice-events-before-cutoff",
    cutoff: PRE_SEPTEMBER_CLEANUP_CUTOFF,
    sourceSha: SOURCE_SHA,
    state: "applied",
    identities: [
      {
        eventId: "old-a",
        time: "2026-09-01T01:59:59.998+02:00",
      },
      {
        eventId: "old-b",
        time: "2026-08-31T23:59:59.999Z",
      },
    ],
    candidateCount: 2,
    digest: dryRun.digest,
    createdAt: CREATED_AT,
    appliedAt: CREATED_AT,
  });
  expect(
    journal!.identities!.every(
      (identity) =>
        Object.keys(identity).sort().join(",") === "eventId,time"
    )
  ).toBe(true);
});

it("blocks all deletion when any scanned event has malformed or ambiguous time", async () => {
  await events().insertMany([
    eventDocument("valid-old", "2026-08-31T23:59:59.999Z"),
    eventDocument("missing-time", undefined),
    eventDocument("non-string-time", 123),
    eventDocument("ambiguous-time", "2026-08-31T23:59:59"),
    eventDocument("invalid-time", "2026-02-30T00:00:00Z"),
  ]);

  const report = await applyCleanup();

  expect(report).toMatchObject({
    state: "blocked",
    counts: {
      scannedCount: 5,
      candidateCount: 1,
      deletedCount: 0,
      malformedTimeCount: 4,
    },
    reasonCodes: ["malformed_time"],
  });
  expect(await events().countDocuments({ eventId: "valid-old" })).toBe(1);
  expect(await journals().countDocuments({})).toBe(0);
});

it.each([
  [
    "newEventPublicationPending",
    "new_event_publication_pending_unsafe",
  ],
  [
    "resultPublicationPending",
    "result_publication_pending_unsafe",
  ],
  [
    "visibilityPublicationPending",
    "visibility_publication_pending_unsafe",
  ],
] as const)(
  "blocks %s=true before deleting any candidate",
  async (marker, reasonCode) => {
    await events().insertMany([
      eventDocument("blocked-old", "2026-08-31T23:00:00Z", {
        [marker]: true,
      }),
      eventDocument("safe-old", "2026-08-31T22:00:00Z"),
    ]);

    const report = await applyCleanup();

    expect(report.state).toBe("blocked");
    expect(report.reasonCodes).toContain(reasonCode);
    expect(report.counts.deletedCount).toBe(0);
    expect(await events().countDocuments({})).toBe(2);
    expect(await journals().countDocuments({})).toBe(0);
  }
);

it.each([null, "false", 0, { pending: false }])(
  "treats malformed publication marker value %p as unsafe",
  async (markerValue) => {
    await events().insertOne(
      eventDocument("malformed-marker", "2026-08-31T23:00:00Z", {
        newEventPublicationPending: markerValue,
      })
    );

    const report = await applyCleanup();

    expect(report).toMatchObject({
      state: "blocked",
      counts: { deletedCount: 0 },
    });
    expect(report.reasonCodes).toContain(
      "new_event_publication_pending_unsafe"
    );
    expect(await events().countDocuments({})).toBe(1);
  }
);

it("blocks on an unsafe publication marker found on a retained event", async () => {
  await events().insertMany([
    eventDocument("old", "2026-08-31T23:00:00Z"),
    eventDocument("retained", PRE_SEPTEMBER_CLEANUP_CUTOFF, {
      visibilityPublicationPending: true,
    }),
  ]);

  const report = await applyCleanup();

  expect(report.state).toBe("blocked");
  expect(report.reasonCodes).toContain(
    "visibility_publication_pending_unsafe"
  );
  expect(report.counts.deletedCount).toBe(0);
  expect(await events().countDocuments({})).toBe(2);
});

it("requires each candidate eventId to be a unique non-empty string", async () => {
  await events().insertMany([
    eventDocument(" ", "2026-08-31T20:00:00Z"),
    eventDocument("duplicate", "2026-08-31T21:00:00Z"),
    eventDocument("duplicate", "2026-09-02T21:00:00Z"),
  ]);

  const report = await applyCleanup();

  expect(report.state).toBe("blocked");
  expect(report.reasonCodes).toEqual(expect.arrayContaining([
    "candidate_event_id_invalid",
    "candidate_event_id_duplicate",
  ]));
  expect(report.counts.deletedCount).toBe(0);
  expect(await events().countDocuments({})).toBe(3);
});

it("rejects a wrong confirmation or malformed apply source before writing", async () => {
  await events().insertOne(
    eventDocument("old", "2026-08-31T23:59:59.999Z")
  );

  const wrongConfirmation = await runPreSeptemberEventCleanup({
    mode: "apply",
    confirmation: "DELETE_SOMETHING_ELSE",
    sourceSha: SOURCE_SHA,
    database: database(),
  });
  const uppercaseSource = await runPreSeptemberEventCleanup({
    mode: "apply",
    confirmation: APPLY_CONFIRMATION,
    sourceSha: "A".repeat(40),
    database: database(),
  });

  expect(wrongConfirmation).toMatchObject({
    state: "blocked",
    reasonCodes: ["confirmation_mismatch"],
  });
  expect(uppercaseSource).toMatchObject({
    state: "blocked",
    reasonCodes: ["source_sha_invalid"],
  });
  expect(await events().countDocuments({})).toBe(1);
  expect(await journals().countDocuments({})).toBe(0);
});

it("persists a prepared journal before attempting any delete", async () => {
  await events().insertOne(
    eventDocument("old", "2026-08-31T23:59:59.999Z")
  );
  const collectionPrototype = Object.getPrototypeOf(events()) as {
    bulkWrite: (...arguments_: any[]) => Promise<unknown>;
  };
  const bulkWrite = jest
    .spyOn(collectionPrototype, "bulkWrite")
    .mockRejectedValueOnce(new Error("simulated interruption"));

  try {
    await expect(applyCleanup()).rejects.toThrow("simulated interruption");
  } finally {
    bulkWrite.mockRestore();
  }

  expect(await journals().findOne({ _id: CLEANUP_OPERATION_ID }))
    .toMatchObject({
      state: "prepared",
      sourceSha: SOURCE_SHA,
      candidateCount: 1,
    });
  expect(await events().countDocuments({ eventId: "old" })).toBe(1);
});

it("resumes a same-SHA prepared operation with exact rows or absent identities", async () => {
  const identities = [
    { eventId: "already-absent", time: "2026-08-31T21:00:00Z" },
    { eventId: "still-present", time: "2026-08-31T22:00:00Z" },
  ];
  await insertPreparedJournal(identities);
  await events().insertOne(
    eventDocument("still-present", "2026-08-31T22:00:00Z")
  );

  const report = await applyCleanup();

  expect(report).toMatchObject({
    state: "applied",
    counts: {
      candidateCount: 2,
      journaledCount: 2,
      deletedCount: 1,
      remainingCandidateCount: 0,
      remainingJournalCount: 0,
    },
    reasonCodes: [],
  });
  expect(await events().countDocuments({})).toBe(0);
  expect(await journals().findOne({ _id: CLEANUP_OPERATION_ID }))
    .toMatchObject({ state: "applied", appliedAt: CREATED_AT });
});

it("rejects a prepared resume from a different source SHA", async () => {
  await insertPreparedJournal([
    { eventId: "old", time: "2026-08-31T22:00:00Z" },
  ]);
  await events().insertOne(
    eventDocument("old", "2026-08-31T22:00:00Z")
  );

  const report = await applyCleanup({ sourceSha: LATER_SOURCE_SHA });

  expect(report).toMatchObject({
    state: "blocked",
    counts: { deletedCount: 0 },
    reasonCodes: ["prepared_source_sha_mismatch"],
  });
  expect(await events().countDocuments({})).toBe(1);
  expect(await journals().findOne({ _id: CLEANUP_OPERATION_ID }))
    .toMatchObject({ state: "prepared" });
});

it("blocks prepared resume when a journaled event drifts", async () => {
  await insertPreparedJournal([
    { eventId: "old", time: "2026-08-31T22:00:00Z" },
  ]);
  await events().insertOne(
    eventDocument("old", PRE_SEPTEMBER_CLEANUP_CUTOFF)
  );

  const report = await applyCleanup();

  expect(report).toMatchObject({
    state: "blocked",
    counts: { deletedCount: 0, remainingJournalCount: 1 },
  });
  expect(report.reasonCodes).toContain("journal_target_drift");
  expect(await events().countDocuments({})).toBe(1);
});

it("blocks prepared resume when a journaled eventId is duplicated", async () => {
  await insertPreparedJournal([
    { eventId: "old", time: "2026-08-31T22:00:00Z" },
  ]);
  await events().insertMany([
    eventDocument("old", "2026-08-31T22:00:00Z"),
    eventDocument("old", PRE_SEPTEMBER_CLEANUP_CUTOFF),
  ]);

  const report = await applyCleanup();

  expect(report.state).toBe("blocked");
  expect(report.reasonCodes).toEqual(expect.arrayContaining([
    "candidate_event_id_duplicate",
    "journal_target_duplicate",
  ]));
  expect(report.counts.deletedCount).toBe(0);
  expect(await events().countDocuments({ eventId: "old" })).toBe(2);
});

it("blocks prepared resume when an unjournaled candidate appears", async () => {
  await insertPreparedJournal([
    { eventId: "journaled", time: "2026-08-31T21:00:00Z" },
  ]);
  await events().insertMany([
    eventDocument("journaled", "2026-08-31T21:00:00Z"),
    eventDocument("not-journaled", "2026-08-31T22:00:00Z"),
  ]);

  const report = await applyCleanup();

  expect(report.state).toBe("blocked");
  expect(report.reasonCodes).toContain("unjournaled_candidate");
  expect(report.counts.deletedCount).toBe(0);
  expect(await events().countDocuments({})).toBe(2);
});

it("blocks prepared resume when a safe publication marker changes", async () => {
  await insertPreparedJournal([
    { eventId: "journaled", time: "2026-08-31T21:00:00Z" },
  ]);
  await events().insertOne(
    eventDocument("journaled", "2026-08-31T21:00:00Z", {
      resultPublicationPending: null,
    })
  );

  const report = await applyCleanup();

  expect(report.state).toBe("blocked");
  expect(report.reasonCodes).toEqual(expect.arrayContaining([
    "result_publication_pending_unsafe",
    "journal_marker_changed",
  ]));
  expect(report.counts.deletedCount).toBe(0);
  expect(await events().countDocuments({})).toBe(1);
});

it("blocks a tampered journal without deleting its target", async () => {
  await insertPreparedJournal([
    { eventId: "journaled", time: "2026-08-31T21:00:00Z" },
  ]);
  await journals().updateOne(
    { _id: CLEANUP_OPERATION_ID },
    { $set: { digest: "0".repeat(64) } }
  );
  await events().insertOne(
    eventDocument("journaled", "2026-08-31T21:00:00Z")
  );

  const report = await applyCleanup();

  expect(report).toMatchObject({
    state: "blocked",
    reasonCodes: ["journal_invalid"],
  });
  expect(report.counts.deletedCount).toBe(0);
  expect(await events().countDocuments({})).toBe(1);
});

it("rescans the full collection and leaves the journal prepared on concurrent scope expansion", async () => {
  await events().insertOne(
    eventDocument("journaled", "2026-08-31T21:00:00Z")
  );
  const collection = events();
  const collectionPrototype = Object.getPrototypeOf(collection) as {
    bulkWrite: (...arguments_: any[]) => Promise<any>;
  };
  const originalBulkWrite = collectionPrototype.bulkWrite;
  const bulkWrite = jest
    .spyOn(collectionPrototype, "bulkWrite")
    .mockImplementationOnce(async function (
      this: unknown,
      ...arguments_: any[]
    ) {
      const result = await originalBulkWrite.apply(this, arguments_);
      await collection.insertOne(
        eventDocument("late-candidate", "2026-08-31T22:00:00Z")
      );
      return result;
    });

  let report;
  try {
    report = await applyCleanup();
  } finally {
    bulkWrite.mockRestore();
  }

  expect(report).toMatchObject({
    state: "blocked",
    counts: {
      deletedCount: 1,
      remainingCandidateCount: 1,
    },
  });
  expect(report!.reasonCodes).toEqual(expect.arrayContaining([
    "unjournaled_candidate",
    "candidates_remaining",
  ]));
  expect(await journals().findOne({ _id: CLEANUP_OPERATION_ID }))
    .toMatchObject({ state: "prepared" });
  expect(await events().countDocuments({ eventId: "late-candidate" })).toBe(1);
});

it("keeps an applied operation idempotent and allows later-SHA verification without scope expansion", async () => {
  await events().insertOne(
    eventDocument("old", "2026-08-31T21:00:00Z")
  );
  const first = await applyCleanup();
  const repeated = await applyCleanup({ sourceSha: LATER_SOURCE_SHA });
  const verified = await runPreSeptemberEventCleanup({
    mode: "verify",
    sourceSha: LATER_SOURCE_SHA,
    database: database(),
  });

  expect(first.state).toBe("applied");
  expect(repeated).toMatchObject({
    state: "applied",
    counts: { deletedCount: 0 },
    digest: first.digest,
  });
  expect(verified).toMatchObject({
    state: "verified",
    counts: {
      journaledCount: 1,
      deletedCount: 0,
      remainingCandidateCount: 0,
    },
    digest: first.digest,
    reasonCodes: [],
  });

  await events().insertOne(
    eventDocument("later-old-arrival", "2026-08-31T22:00:00Z")
  );
  const expandedVerify = await runPreSeptemberEventCleanup({
    mode: "verify",
    sourceSha: LATER_SOURCE_SHA,
    database: database(),
  });
  expect(expandedVerify.state).toBe("blocked");
  expect(expandedVerify.reasonCodes).toContain("unjournaled_candidate");
  expect(
    await events().countDocuments({ eventId: "later-old-arrival" })
  ).toBe(1);
});

it.each([
  {
    label: "an empty event collection",
    candidateTime: undefined,
    expectedCandidateCount: 0,
    expectedReasons: ["operation_not_applied"],
  },
  {
    label: "a remaining pre-cutoff candidate",
    candidateTime: "2026-08-31T22:00:00Z",
    expectedCandidateCount: 1,
    expectedReasons: [
      "operation_not_applied",
      "candidates_remaining",
    ],
  },
] as const)(
  "verify blocks without a fixed journal for $label",
  async ({
    candidateTime,
    expectedCandidateCount,
    expectedReasons,
  }) => {
    if (candidateTime) {
      await events().insertOne(
        eventDocument("not-yet-journaled", candidateTime)
      );
    }
    const before = await events().find({}).toArray();

    const report = await runPreSeptemberEventCleanup({
      mode: "verify",
      database: database(),
    });

    expect(report).toMatchObject({
      state: "blocked",
      counts: {
        candidateCount: expectedCandidateCount,
        journaledCount: 0,
        deletedCount: 0,
        remainingCandidateCount: expectedCandidateCount,
      },
      digest: null,
      reasonCodes: expectedReasons,
    });
    expect(cleanupReportExitCode(report)).toBe(1);
    expect(await events().find({}).toArray()).toEqual(before);
    expect(await journals().countDocuments({})).toBe(0);
  }
);

it("parses only fixed modes and bounded batches and maps blocked reports to failure", () => {
  expect(parseCleanupArgs([])).toEqual({
    mode: "dry-run",
    confirmation: undefined,
    batchSize: 100,
  });
  expect(parseCleanupArgs([
    "--mode",
    "apply",
    "--confirmation",
    APPLY_CONFIRMATION,
    "--batch-size",
    "1000",
  ])).toEqual({
    mode: "apply",
    confirmation: APPLY_CONFIRMATION,
    batchSize: 1000,
  });
  expect(() => parseCleanupArgs(["--mode", "rollback"])).toThrow(
    "invalid_mode"
  );
  expect(() => parseCleanupArgs(["--cutoff", "2026-01-01T00:00:00Z"]))
    .toThrow("argument_unknown");
  expect(() => parseCleanupArgs(["--batch-size", "1001"]))
    .toThrow("invalid_batch_size");
  expect(cleanupReportExitCode({
    state: "blocked",
  })).toBe(1);
  expect(cleanupReportExitCode({
    state: "verified",
  })).toBe(0);
});

it("emits one allowlisted JSON report without event data or connection details", async () => {
  const cliDatabase = mongoose.connection
    .getClient()
    .db(CLEANUP_DATABASE_NAME);
  await cliDatabase.dropDatabase();
  await cliDatabase.collection("events").insertOne(
    eventDocument(
      "private-event-id",
      "2026-08-31T21:00:00Z",
      { secretField: "private-event-payload" }
    )
  );
  const output: string[] = [];
  const close = jest.fn(async () => {});
  const privateUri =
    "mongodb://private-user:private-password@private-host/gaming_backoffice";

  try {
    const report = await runCleanupCli(
      ["--mode", "dry-run"],
      {
        env: {
          MONGO_URI: privateUri,
          SOURCE_SHA,
        },
        connect: async (receivedUri) => {
          expect(receivedUri).toBe(privateUri);
          return { db: cliDatabase, close };
        },
        write: (line) => output.push(line),
      }
    );

    expect(report.state).toBe("candidate");
    expect(output).toHaveLength(1);
    expect(output[0].endsWith("\n")).toBe(true);
    const parsed = JSON.parse(output[0]);
    expect(Object.keys(parsed).sort()).toEqual([
      "counts",
      "cutoff",
      "digest",
      "mode",
      "operationId",
      "reasonCodes",
      "schemaVersion",
      "state",
    ]);
    expect(output[0]).not.toContain("private-event-id");
    expect(output[0]).not.toContain("private-event-payload");
    expect(output[0]).not.toContain("private-user");
    expect(output[0]).not.toContain("private-password");
    expect(output[0]).not.toContain("private-host");
    expect(close).toHaveBeenCalledTimes(1);
    expect(serializeCleanupReport(report)).toBe(output[0].trim());
  } finally {
    await cliDatabase.dropDatabase();
  }
});

it("rejects a CLI connection to any database other than gaming_backoffice", async () => {
  const output: string[] = [];
  const close = jest.fn(async () => {});
  const report = await runCleanupCli([], {
    env: {
      MONGO_URI: "mongodb://redacted/wrong_database",
      SOURCE_SHA,
    },
    connect: async () => ({ db: database(), close }),
    write: (line) => output.push(line),
  });

  expect(report).toMatchObject({
    state: "blocked",
    reasonCodes: ["database_mismatch"],
  });
  expect(output).toHaveLength(1);
  expect(output[0]).not.toContain("wrong_database");
  expect(close).toHaveBeenCalledTimes(1);
});
