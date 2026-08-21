import { messengerWrapper } from "@betstan/common";
import RetryRecord, {
  RETRY_RECORD_DEAD_LETTER_RETENTION_SECONDS,
} from "../../model/RetryRecord";
import {
  RetryWorker,
  buildRetryKey,
  parkFailedEvent,
  retryIdentityForPlaceBet,
} from "../retry";
import {
  MAX_RETRY_ERROR_MESSAGE_BYTES,
  MAX_RETRY_ERROR_NAME_BYTES,
  MAX_RETRY_ERROR_STACK_BYTES,
  MAX_RETRY_ERROR_STACK_FRAMES,
  MAX_RETRY_PAYLOAD_BYTES,
  buildRetryPayloadStorage,
  buildRetryPayloadSummary,
  sanitizeRetryStack,
  sanitizeRetryText,
} from "../retryRetention";
import * as resultingService from "../resulting";
import {
  createLiveSettlement,
  createLiveUpdateEvent,
  createModerationEvent,
  createLiveRow,
  createPlaceBetEvent,
  createPreMatchRow,
  setupPublisherSpies,
} from "../../test/resultingTestUtils";

setupPublisherSpies();

afterEach(() => {
  jest.restoreAllMocks();
});

const createWorker = async (
  options: ConstructorParameters<typeof RetryWorker>[1] = {}
) => {
  const worker = new RetryWorker(messengerWrapper.connection, options);
  await worker.init();
  return worker;
};

const makeRetryDue = async (key: string) => {
  await RetryRecord.updateOne(
    { key },
    {
      $set: {
        leaseOwner: "",
        leasedUntil: null,
        nextAttemptAt: new Date(Date.now() - 1000),
        status: "PENDING",
      },
    }
  );
};

const findReadyRetryRecords = async (now = new Date()) => {
  return RetryRecord.find({
    nextAttemptAt: {
      $lte: now,
    },
    status: {
      $in: ["PENDING", "PROCESSING"],
    },
    $or: [
      {
        leasedUntil: {
          $exists: false,
        },
      },
      {
        leasedUntil: null,
      },
      {
        leasedUntil: {
          $lte: now,
        },
      },
    ],
  });
};

it("parks oversized payloads as observable dead letters without storing raw events", async () => {
  const sensitiveSelectionId = "selection-super-secret";
  const event = createPlaceBetEvent({
    betKind: "LIVE" as never,
    slipId: "oversized-slip",
    userId: "sensitive-user-id",
    userName: "sensitive-user-name",
    wager: 98765,
    rows: [
      createLiveRow({
        eventId: "oversized-event",
        selectionId: sensitiveSelectionId,
      }),
    ],
  }) as any;
  event.data.auditBlob = "x".repeat(MAX_RETRY_PAYLOAD_BYTES + 1024);
  const descriptor = {
    identity: retryIdentityForPlaceBet(event),
    kind: "PLACE_BET" as const,
    listenerServiceName: "resulting_place_bet",
    payload: event,
  };

  await parkFailedEvent(descriptor, new Error("password=top-secret"));
  await parkFailedEvent(descriptor, new Error("password=top-secret"));

  const retryRecords = await RetryRecord.find({
    key: buildRetryKey("PLACE_BET", event.data.slipId),
  });

  expect(retryRecords).toHaveLength(1);
  expect(retryRecords[0].status).toEqual("DEAD_LETTER");
  expect(retryRecords[0].payload).toBeUndefined();
  expect(retryRecords[0].payloadByteCount).toBeGreaterThan(MAX_RETRY_PAYLOAD_BYTES);
  expect(retryRecords[0].payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(retryRecords[0].lastErrorName).toEqual("RetryPayloadTooLargeError");
  expect(retryRecords[0].lastErrorMessage).toContain(
    `${MAX_RETRY_PAYLOAD_BYTES}`
  );
  expect(retryRecords[0].lastErrorMessage).not.toContain("top-secret");

  const summaryJson = JSON.stringify(retryRecords[0].payloadSummary);
  expect(summaryJson).toContain("oversized-slip");
  expect(summaryJson).toContain("oversized-event");
  expect(summaryJson).not.toContain("sensitive-user-id");
  expect(summaryJson).not.toContain("sensitive-user-name");
  expect(summaryJson).not.toContain("98765");
  expect(summaryJson).not.toContain(sensitiveSelectionId);
  expect(summaryJson).not.toContain("top-secret");
  expect(await findReadyRetryRecords(new Date(Date.now() + 60_000))).toHaveLength(0);
});

it("sanitizes stored error metadata and caps stack retention", async () => {
  const event = createPlaceBetEvent({
    slipId: "sanitized-error-slip",
    rows: [createPreMatchRow({ eventId: "sanitized-error-event" })],
  });
  const error = new Error(
    "Authorization: Bearer abc123 password=letmein \u0000 Привет😀"
  );
  error.name = "Token\u0007Error";
  error.stack = [
    "Token\\u0007Error: Authorization: Bearer abc123 password=letmein \\u0000 Привет😀",
    ...Array.from({ length: MAX_RETRY_ERROR_STACK_FRAMES + 10 }, (_, index) =>
      `    at frame${index}(cookie=session-${index})`
    ),
  ].join("\n");

  await parkFailedEvent(
    {
      identity: retryIdentityForPlaceBet(event),
      kind: "PLACE_BET",
      listenerServiceName: "resulting_place_bet",
      payload: event,
    },
    error
  );

  const retryRecord = await RetryRecord.findOne({
    key: buildRetryKey("PLACE_BET", event.data.slipId),
  });

  expect(retryRecord).not.toBeNull();
  expect(Buffer.byteLength(retryRecord!.lastErrorName ?? "", "utf8")).toBeLessThanOrEqual(
    MAX_RETRY_ERROR_NAME_BYTES
  );
  expect(Buffer.byteLength(retryRecord!.lastErrorMessage ?? "", "utf8")).toBeLessThanOrEqual(
    MAX_RETRY_ERROR_MESSAGE_BYTES
  );
  expect(Buffer.byteLength(retryRecord!.lastErrorStack ?? "", "utf8")).toBeLessThanOrEqual(
    MAX_RETRY_ERROR_STACK_BYTES
  );
  expect(retryRecord!.lastErrorName).not.toContain("\u0007");
  expect(retryRecord!.lastErrorMessage).toContain("[REDACTED]");
  expect(retryRecord!.lastErrorMessage).toContain("Привет😀");
  expect(retryRecord!.lastErrorMessage).not.toContain("abc123");
  expect(retryRecord!.lastErrorMessage).not.toContain("letmein");
  expect(retryRecord!.lastErrorMessage).not.toContain("\u0000");
  expect(retryRecord!.lastErrorStack).toContain("[REDACTED]");
  expect(retryRecord!.lastErrorStack).not.toContain("session-0");
  expect((retryRecord!.lastErrorStack ?? "").split("\n").length).toBeLessThanOrEqual(
    MAX_RETRY_ERROR_STACK_FRAMES + 1
  );
});

it("produces deterministic payload hashes and summaries for equivalent payloads", async () => {
  const left = buildRetryPayloadStorage({
    kind: "EVENT_RESULT",
    payload: {
      data: {
        away: "Away",
        awayScore: 0,
        eventId: "deterministic-event",
        home: "Home",
        homeScore: 1,
      },
      timestamp: "2026-08-21T01:00:00.000Z",
    },
  });
  const right = buildRetryPayloadStorage({
    kind: "EVENT_RESULT",
    payload: {
      timestamp: "2026-08-21T01:00:00.000Z",
      data: {
        homeScore: 1,
        home: "Home",
        eventId: "deterministic-event",
        awayScore: 0,
        away: "Away",
      },
    },
  });

  expect(left.hash).toEqual(right.hash);
  expect(left.byteCount).toEqual(right.byteCount);
  expect(left.summary).toEqual(right.summary);
});

it("sanitizes complex structured values and empty stacks", () => {
  const circular: Record<string, unknown> = {
    array: [1, new Date("2026-08-21T10:00:00.000Z"), BigInt(2)],
    bool: true,
    token: "apiKey=secret-token",
  };
  circular.self = circular;
  circular.fn = () => "ignored";
  circular.symbol = Symbol("secret-symbol");

  const singleLine = sanitizeRetryText(circular, {
    maxBytes: 512,
  });
  const multiline = sanitizeRetryText(" first\r\nsecond\tline \n", {
    maxBytes: 512,
    preserveNewlines: true,
  });

  expect(singleLine).toContain("[Circular]");
  expect(singleLine).toContain("[REDACTED]");
  expect(singleLine).toContain("2026-08-21T10:00:00.000Z");
  expect(singleLine).not.toContain("secret-token");
  expect(singleLine).not.toContain("\r");
  expect(multiline).toEqual("first\nsecond line");
  expect(sanitizeRetryStack(" \n \n")).toEqual("");
});

it("builds bounded summaries for moderation and live payloads", () => {
  const moderationSummary = buildRetryPayloadSummary({
    kind: "MODERATION_RESULT",
    payload: createModerationEvent("moderation-slip", undefined, {
      betKind: "LIVE" as never,
      affectedRows: [
        { declineReason: "ODDS_CHANGED", rowId: "row-a" },
        { declineReason: "ODDS_CHANGED", rowId: "row-b" },
      ] as never,
    }),
  });
  const liveUpdateEvent = createLiveUpdateEvent({
    eventId: "live-event",
    markets: [],
    sequence: 77,
    settlements: [
      createLiveSettlement({
        eventId: "live-event",
        marketId: "market-a",
      }),
      createLiveSettlement({
        eventId: "live-event",
        marketId: "market-b",
      }),
    ],
  });
  const liveSummary = buildRetryPayloadStorage({
    kind: "LIVE_EVENT_UPDATE",
    payload: liveUpdateEvent,
  }).summary;

  expect(moderationSummary).toEqual({
    affectedRowCount: 2,
    betKind: "LIVE",
    kind: "MODERATION_RESULT",
    result: "APPROVED",
    slipId: "moderation-slip",
  });
  expect(liveSummary).toEqual({
    eventId: "live-event",
    kind: "LIVE_EVENT_UPDATE",
    marketCount: 0,
    sequence: 77,
    settlementCount: 2,
  });
});

it("retains replay payload while retryable and clears it when the retry becomes a dead letter", async () => {
  const processSpy = jest
    .spyOn(resultingService, "upsertPlaceBet")
    .mockRejectedValue(new Error("still failing"));
  const event = createPlaceBetEvent({
    slipId: "transition-slip",
    rows: [createPreMatchRow({ eventId: "transition-event" })],
  });
  const retryKey = buildRetryKey("PLACE_BET", event.data.slipId);

  await parkFailedEvent(
    {
      identity: retryIdentityForPlaceBet(event),
      kind: "PLACE_BET",
      listenerServiceName: "resulting_place_bet",
      payload: event,
    },
    new Error("initial failure")
  );

  let retryRecord = await RetryRecord.findOne({ key: retryKey });
  expect(retryRecord).not.toBeNull();
  expect(retryRecord!.status).toEqual("PENDING");
  expect(retryRecord!.payload).toBeDefined();
  expect((await findReadyRetryRecords()).map((record) => record.key)).not.toContain(
    retryKey
  );

  await makeRetryDue(retryKey);
  expect((await findReadyRetryRecords()).map((record) => record.key)).toContain(retryKey);

  const worker = await createWorker({
    maxAttempts: 3,
    workerId: "retention-worker",
  });
  await worker.runOnce();

  retryRecord = await RetryRecord.findOne({ key: retryKey });
  expect(retryRecord).not.toBeNull();
  expect(retryRecord!.status).toEqual("PENDING");
  expect(retryRecord!.attemptCount).toEqual(2);
  expect(retryRecord!.payload).toBeDefined();

  await makeRetryDue(retryKey);
  await worker.runOnce();

  retryRecord = await RetryRecord.findOne({ key: retryKey });
  expect(retryRecord).not.toBeNull();
  expect(retryRecord!.status).toEqual("DEAD_LETTER");
  expect(retryRecord!.attemptCount).toEqual(3);
  expect(retryRecord!.payload).toBeUndefined();
  expect(retryRecord!.payloadSummary).toBeDefined();
  expect(retryRecord!.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(retryRecord!.payloadByteCount).toBeGreaterThan(0);
  expect(processSpy).toHaveBeenCalledTimes(2);
});

it("clears raw payload after successful retry completion", async () => {
  jest.spyOn(resultingService, "upsertPlaceBet").mockResolvedValue(undefined);
  const event = createPlaceBetEvent({
    slipId: "completed-retention-slip",
    rows: [createPreMatchRow({ eventId: "completed-retention-event" })],
  });
  const retryKey = buildRetryKey("PLACE_BET", event.data.slipId);

  await parkFailedEvent(
    {
      identity: retryIdentityForPlaceBet(event),
      kind: "PLACE_BET",
      listenerServiceName: "resulting_place_bet",
      payload: event,
    },
    new Error("initial failure")
  );
  await makeRetryDue(retryKey);

  const worker = await createWorker({ workerId: "completed-retention-worker" });
  await worker.runOnce();

  const retryRecord = await RetryRecord.findOne({ key: retryKey });
  expect(retryRecord).not.toBeNull();
  expect(retryRecord!.status).toEqual("COMPLETED");
  expect(retryRecord!.payload).toBeUndefined();
  expect(retryRecord!.payloadSummary).toBeDefined();
  expect(retryRecord!.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(retryRecord!.lastErrorMessage).toEqual("");
});

it("applies dead-letter TTL only to terminal records and upgrades legacy docs on terminal transition", async () => {
  const ttlIndex = RetryRecord.schema.indexes().find(
    ([definition, options]) =>
      "deadLetteredAt" in definition && options.expireAfterSeconds !== undefined
  );

  expect(ttlIndex).toBeDefined();
  expect(ttlIndex?.[1].expireAfterSeconds).toEqual(
    RETRY_RECORD_DEAD_LETTER_RETENTION_SECONDS
  );
  expect(ttlIndex?.[1].partialFilterExpression).toEqual({
    status: "DEAD_LETTER",
  });

  const legacyEvent = createPlaceBetEvent({
    slipId: "legacy-slip",
    rows: [createPreMatchRow({ eventId: "legacy-event" })],
  });
  const legacyKey = buildRetryKey("PLACE_BET", legacyEvent.data.slipId);
  await RetryRecord.collection.insertOne({
    attemptCount: 2,
    createdAt: new Date(),
    identity: legacyEvent.data.slipId,
    key: legacyKey,
    kind: "PLACE_BET",
    lastErrorAt: new Date(),
    lastErrorMessage: "old",
    lastErrorName: "Error",
    listenerServiceName: "resulting_place_bet",
    nextAttemptAt: new Date(Date.now() - 1000),
    payload: legacyEvent,
    status: "PENDING",
    updatedAt: new Date(),
  });

  jest.spyOn(resultingService, "upsertPlaceBet").mockRejectedValue(new Error("legacy failure"));
  const worker = await createWorker({
    maxAttempts: 3,
    workerId: "legacy-worker",
  });
  await worker.runOnce();

  const upgradedLegacyRecord = await RetryRecord.findOne({ key: legacyKey });
  expect(upgradedLegacyRecord).not.toBeNull();
  expect(upgradedLegacyRecord!.status).toEqual("DEAD_LETTER");
  expect(upgradedLegacyRecord!.payload).toBeUndefined();
  expect(upgradedLegacyRecord!.payloadSummary).toBeDefined();
  expect(upgradedLegacyRecord!.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(upgradedLegacyRecord!.payloadByteCount).toBeGreaterThan(0);
});
