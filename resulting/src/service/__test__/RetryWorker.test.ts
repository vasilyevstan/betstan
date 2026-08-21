import { setTimeout as delay } from "node:timers/promises";
import { messengerWrapper } from "@betstan/common";
import RetryRecord from "../../model/RetryRecord";
import {
  RetryWorker,
  buildRetryKey,
  parkFailedEvent,
  retryIdentityForPlaceBet,
} from "../retry";
import * as resultingService from "../resulting";
import { createPlaceBetEvent, setupPublisherSpies } from "../../test/resultingTestUtils";

setupPublisherSpies();

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const createWorker = async (
  options: ConstructorParameters<typeof RetryWorker>[1] = {}
) => {
  const worker = new RetryWorker(messengerWrapper.connection, options);
  await worker.init();
  return worker;
};

const createRetryRecord = async (
  overrides: Partial<Record<string, unknown>> = {}
) => {
  const event = createPlaceBetEvent({
    slipId: String(overrides.identity ?? "retry-slip"),
  });
  const identity = String(overrides.identity ?? retryIdentityForPlaceBet(event));
  const kind = String(overrides.kind ?? "PLACE_BET");
  const now = (overrides.now as Date | undefined) ?? new Date();

  return RetryRecord.create({
    attemptCount: overrides.attemptCount ?? 1,
    identity,
    key: overrides.key ?? buildRetryKey(kind as never, identity),
    kind,
    listenerServiceName: overrides.listenerServiceName ?? "resulting_place_bet",
    nextAttemptAt: overrides.nextAttemptAt ?? now,
    payload: overrides.payload ?? event,
    status: overrides.status ?? "PENDING",
    leasedUntil: overrides.leasedUntil,
    leaseOwner: overrides.leaseOwner ?? "",
    lastErrorAt: overrides.lastErrorAt ?? now,
    lastErrorMessage: overrides.lastErrorMessage ?? "boom",
    lastErrorName: overrides.lastErrorName ?? "Error",
    lastErrorStack: overrides.lastErrorStack ?? "stack",
    deadLetteredAt: overrides.deadLetteredAt,
  });
};

const waitForCondition = async (
  predicate: () => Promise<boolean> | boolean,
  label: string,
  {
    intervalMs = 10,
    timeoutMs = 1000,
  }: {
    intervalMs?: number;
    timeoutMs?: number;
  } = {}
): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label}`);
};

const isHeartbeatExtensionUpdate = (update: unknown): boolean => {
  if (!update || typeof update !== "object") {
    return false;
  }

  const set = (update as { $set?: Record<string, unknown> }).$set ?? {};
  return Object.keys(set).length === 1 && "leasedUntil" in set;
};

it("coalesces duplicate parked events into a single retry record", async () => {
  const event = createPlaceBetEvent({ slipId: "duplicate-park-slip" });
  const descriptor = {
    identity: retryIdentityForPlaceBet(event),
    kind: "PLACE_BET" as const,
    listenerServiceName: "resulting_place_bet",
    payload: event,
  };

  await parkFailedEvent(descriptor, new Error("first failure"));
  await parkFailedEvent(descriptor, new Error("second failure"));

  const retryRecords = await RetryRecord.find({
    key: buildRetryKey("PLACE_BET", event.data.slipId),
  });

  expect(retryRecords).toHaveLength(1);
  expect(retryRecords[0].status).toEqual("PENDING");
  expect(retryRecords[0].attemptCount).toEqual(1);
});

it("backs off exponentially and dead-letters after the configured max attempts", async () => {
  const current = { now: new Date("2026-08-20T20:00:00.000Z") };
  const clock = {
    now: () => current.now,
  };
  const processSpy = jest
    .spyOn(resultingService, "upsertPlaceBet")
    .mockRejectedValue(new Error("still failing"));
  const retryRecord = await createRetryRecord({
    attemptCount: 1,
    identity: "backoff-slip",
    nextAttemptAt: current.now,
    now: current.now,
  });
  const worker = await createWorker({
    baseBackoffMs: 1000,
    clock,
    maxAttempts: 3,
    maxBackoffMs: 2000,
    workerId: "worker-backoff",
  });

  await worker.runOnce();

  let updatedRecord = await RetryRecord.findById(retryRecord._id);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("PENDING");
  expect(updatedRecord!.attemptCount).toEqual(2);
  expect(updatedRecord!.nextAttemptAt.toISOString()).toEqual(
    new Date(current.now.getTime() + 2000).toISOString()
  );

  current.now = new Date(current.now.getTime() + 2000);
  await worker.runOnce();

  updatedRecord = await RetryRecord.findById(retryRecord._id);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("DEAD_LETTER");
  expect(updatedRecord!.attemptCount).toEqual(3);
  expect(updatedRecord!.deadLetteredAt?.toISOString()).toEqual(
    current.now.toISOString()
  );
  expect(processSpy).toHaveBeenCalledTimes(2);
});

it("extends the lease during slow replay so a competing worker cannot reclaim mid-flight", async () => {
  let release!: () => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let invocation = 0;
  const processSpy = jest
    .spyOn(resultingService, "upsertPlaceBet")
    .mockImplementation(() => {
      invocation += 1;
      if (invocation === 1) {
        startedResolve();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }

      return Promise.resolve();
    });
  const retryRecord = await createRetryRecord({
    identity: "slow-slip",
    nextAttemptAt: new Date(Date.now() - 1000),
  });
  const workerOne = await createWorker({
    heartbeatIntervalMs: 20,
    leaseMs: 60,
    workerId: "worker-one",
  });
  const workerTwo = await createWorker({
    heartbeatIntervalMs: 20,
    leaseMs: 60,
    workerId: "worker-two",
  });

  const firstRun = workerOne.runOnce();
  await started;

  const claimedRecord = await RetryRecord.findById(retryRecord._id);
  expect(claimedRecord).not.toBeNull();
  expect(claimedRecord?.leasedUntil).toBeDefined();
  const initialLeaseExpiry = claimedRecord!.leasedUntil!.getTime();

  await waitForCondition(async () => {
    const updatedRecord = await RetryRecord.findById(retryRecord._id);
    return (updatedRecord?.leasedUntil?.getTime() ?? 0) > initialLeaseExpiry;
  }, "lease extension");

  await delay(80);
  const secondRunResult = await workerTwo.runOnce();

  release();
  await firstRun;

  const updatedRecord = await RetryRecord.findById(retryRecord._id);

  expect(secondRunResult).toEqual(0);
  expect(processSpy).toHaveBeenCalledTimes(1);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("COMPLETED");
});

it("abandons completion after heartbeat storage failure and allows stale-lease recovery", async () => {
  const consoleErrorSpy = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  let release!: () => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let invocation = 0;
  const processSpy = jest
    .spyOn(resultingService, "upsertPlaceBet")
    .mockImplementation(() => {
      invocation += 1;
      if (invocation === 1) {
        startedResolve();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve();
    });
  const originalUpdateOne = RetryRecord.updateOne.bind(RetryRecord);
  let heartbeatFailed = false;
  jest.spyOn(RetryRecord, "updateOne").mockImplementation((filter, update, options) => {
    if (!heartbeatFailed && isHeartbeatExtensionUpdate(update)) {
      heartbeatFailed = true;
      return Promise.reject(new Error("heartbeat write failed")) as never;
    }

    return originalUpdateOne(filter as never, update as never, options as never) as never;
  });
  const retryRecord = await createRetryRecord({
    identity: "heartbeat-failure-slip",
    nextAttemptAt: new Date(Date.now() - 1000),
  });
  const workerOne = await createWorker({
    heartbeatIntervalMs: 20,
    leaseMs: 60,
    workerId: "worker-one",
  });

  const firstRun = workerOne.runOnce();
  await started;
  await waitForCondition(
    () => consoleErrorSpy.mock.calls.some(
      ([message]) => message === "Retry record heartbeat failed:"
    ),
    "handled heartbeat failure"
  );
  release();
  await firstRun;

  let updatedRecord = await RetryRecord.findById(retryRecord._id);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("PROCESSING");
  expect(updatedRecord!.leaseOwner).toEqual("worker-one");

  await delay(80);
  const workerTwo = await createWorker({
    heartbeatIntervalMs: 20,
    leaseMs: 60,
    workerId: "worker-two",
  });
  await workerTwo.runOnce();

  updatedRecord = await RetryRecord.findById(retryRecord._id);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("COMPLETED");
  expect(processSpy).toHaveBeenCalledTimes(2);
});

it("does not overwrite another worker when ownership is lost during a replay", async () => {
  let release!: () => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const processSpy = jest
    .spyOn(resultingService, "upsertPlaceBet")
    .mockImplementation(() => {
      startedResolve();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
  const retryRecord = await createRetryRecord({
    identity: "ownership-loss-slip",
    nextAttemptAt: new Date(Date.now() - 1000),
  });
  const worker = await createWorker({
    heartbeatIntervalMs: 20,
    leaseMs: 60,
    workerId: "worker-one",
  });

  const runPromise = worker.runOnce();
  await started;

  await RetryRecord.updateOne(
    { _id: retryRecord._id },
    {
      $set: {
        leaseOwner: "worker-two",
        leasedUntil: new Date(Date.now() + 5000),
        status: "PROCESSING",
      },
    }
  );

  await delay(40);
  release();
  await runPromise;

  const updatedRecord = await RetryRecord.findById(retryRecord._id);

  expect(processSpy).toHaveBeenCalledTimes(1);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("PROCESSING");
  expect(updatedRecord!.leaseOwner).toEqual("worker-two");
});

it("cleans up heartbeat timers on successful completion", async () => {
  let release!: () => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  jest.spyOn(resultingService, "upsertPlaceBet").mockImplementation(() => {
    startedResolve();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const originalUpdateOne = RetryRecord.updateOne.bind(RetryRecord);
  let heartbeatWrites = 0;
  jest.spyOn(RetryRecord, "updateOne").mockImplementation((filter, update, options) => {
    if (isHeartbeatExtensionUpdate(update)) {
      heartbeatWrites += 1;
    }

    return originalUpdateOne(filter as never, update as never, options as never) as never;
  });
  await createRetryRecord({
    identity: "timer-cleanup-slip",
    nextAttemptAt: new Date(Date.now() - 1000),
  });
  const worker = await createWorker({
    heartbeatIntervalMs: 20,
    leaseMs: 60,
    workerId: "worker-cleanup",
  });

  const runPromise = worker.runOnce();
  await started;
  await waitForCondition(() => heartbeatWrites > 0, "heartbeat write");
  release();
  await runPromise;

  const heartbeatWritesAfterCompletion = heartbeatWrites;
  await delay(80);
  expect(heartbeatWrites).toEqual(heartbeatWritesAfterCompletion);
});

it("stops heartbeat timers during shutdown even when initial recovery is still in flight", async () => {
  let release!: () => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  jest.spyOn(resultingService, "upsertPlaceBet").mockImplementation(() => {
    startedResolve();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const originalUpdateOne = RetryRecord.updateOne.bind(RetryRecord);
  let heartbeatWrites = 0;
  jest.spyOn(RetryRecord, "updateOne").mockImplementation((filter, update, options) => {
    if (isHeartbeatExtensionUpdate(update)) {
      heartbeatWrites += 1;
    }

    return originalUpdateOne(filter as never, update as never, options as never) as never;
  });
  await createRetryRecord({
    identity: "shutdown-slip",
    nextAttemptAt: new Date(Date.now() - 1000),
  });
  const worker = await createWorker({
    heartbeatIntervalMs: 20,
    leaseMs: 60,
    workerId: "worker-shutdown",
  });

  const startPromise = worker.start();
  await started;
  await waitForCondition(() => heartbeatWrites > 0, "heartbeat write before shutdown");

  const stopPromise = worker.stop();
  const heartbeatWritesAfterStop = heartbeatWrites;
  await delay(80);
  expect(heartbeatWrites).toEqual(heartbeatWritesAfterStop);

  release();
  await Promise.all([startPromise, stopPromise]);
});

it("reclaims stale leases and resumes persisted work after restart", async () => {
  const processSpy = jest
    .spyOn(resultingService, "upsertPlaceBet")
    .mockResolvedValue(undefined);
  const retryRecord = await createRetryRecord({
    identity: "stale-slip",
    leasedUntil: new Date(Date.now() - 60000),
    leaseOwner: "stale-worker",
    nextAttemptAt: new Date(Date.now() - 60000),
    status: "PROCESSING",
  });

  const restartedWorker = await createWorker({ workerId: "worker-restarted" });
  await restartedWorker.runOnce();

  const updatedRecord = await RetryRecord.findById(retryRecord._id);

  expect(processSpy).toHaveBeenCalledTimes(1);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("COMPLETED");
  expect(updatedRecord!.leaseOwner).toEqual("");
});

it("keeps dead-letter records terminal and never reopens them on duplicate parking", async () => {
  const retryRecord = await createRetryRecord({
    attemptCount: 8,
    deadLetteredAt: new Date("2026-08-20T20:10:00.000Z"),
    identity: "terminal-slip",
    status: "DEAD_LETTER",
  });
  const event = createPlaceBetEvent({ slipId: "terminal-slip" });

  await parkFailedEvent(
    {
      identity: event.data.slipId,
      kind: "PLACE_BET",
      listenerServiceName: "resulting_place_bet",
      payload: event,
    },
    new Error("should stay terminal")
  );

  const updatedRecord = await RetryRecord.findById(retryRecord._id);
  const processSpy = jest
    .spyOn(resultingService, "upsertPlaceBet")
    .mockResolvedValue(undefined);
  const worker = await createWorker({ workerId: "worker-terminal" });
  await worker.runOnce();

  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("DEAD_LETTER");
  expect(updatedRecord!.attemptCount).toEqual(8);
  expect(processSpy).not.toHaveBeenCalled();
});
