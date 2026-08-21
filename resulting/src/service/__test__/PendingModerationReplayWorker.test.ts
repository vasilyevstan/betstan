import { setTimeout as delay } from "node:timers/promises";
import { BetKind, ModerationStatus, messengerWrapper } from "@betstan/common";
import PendingModerationResult from "../../model/PendingModerationResult";
import {
  PendingModerationProcessor,
  PendingModerationReplayWorker,
  parkPendingModerationResult,
} from "../pendingModeration";
import { createModerationEvent, setupPublisherSpies } from "../../test/resultingTestUtils";

setupPublisherSpies();

afterEach(() => {
  jest.restoreAllMocks();
});

const createWorker = async (
  processor: PendingModerationProcessor,
  options: ConstructorParameters<typeof PendingModerationReplayWorker>[2] = {}
) => {
  const worker = new PendingModerationReplayWorker(
    messengerWrapper.connection,
    processor,
    options
  );
  await worker.init();
  return worker;
};

const createPendingModerationRecord = async (
  overrides: Partial<Record<string, unknown>> = {}
) => {
  const event = createModerationEvent(
    String(overrides.slipId ?? "pending-slip"),
    (overrides.result as ModerationStatus | undefined)
      ?? ModerationStatus.APPROVED,
    {
      betKind: (overrides.betKind as BetKind | undefined) ?? BetKind.PRE_MATCH,
      affectedRows: overrides.affectedRows as [] | undefined,
      declineReason: overrides.declineReason as undefined,
    }
  );

  const record = await PendingModerationResult.create({
    affectedRows: event.data.affectedRows ?? [],
    attemptCount: overrides.attemptCount ?? 0,
    betKind: event.data.betKind,
    declineReason: event.data.declineReason,
    exhaustedAt: overrides.exhaustedAt,
    lastAttemptAt: overrides.lastAttemptAt,
    lastError: overrides.lastError ?? {
      message: "",
      name: "",
    },
    leaseOwner: overrides.leaseOwner ?? "",
    leasedUntil: overrides.leasedUntil,
    nextAttemptAt: overrides.nextAttemptAt ?? new Date(),
    result: event.data.result,
    slipId: event.data.slipId,
    status: overrides.status ?? "PENDING",
    timestamp: event.timestamp ?? new Date().toISOString(),
  });

  if (overrides.createdAt || overrides.updatedAt) {
    await PendingModerationResult.updateOne(
      { _id: record._id },
      {
        $set: {
          ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
          ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
        },
      }
    );
    return PendingModerationResult.findById(record._id);
  }

  return record;
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

it("requeues missing aggregates with exponential backoff and eventually exhausts them", async () => {
  const current = { now: new Date("2026-08-21T01:00:00.000Z") };
  const clock = {
    now: () => current.now,
  };
  const processor = jest.fn<ReturnType<PendingModerationProcessor>, Parameters<PendingModerationProcessor>>()
    .mockResolvedValue("MISSING_AGGREGATE");
  const record = await createPendingModerationRecord({
    nextAttemptAt: current.now,
    slipId: "backoff-slip",
  });
  const worker = await createWorker(processor, {
    baseBackoffMs: 1000,
    clock,
    maxAttempts: 3,
    maxBackoffMs: 2000,
    workerId: "pending-worker-backoff",
  });

  await worker.runOnce();

  let updatedRecord = await PendingModerationResult.findById(record!._id);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("PENDING");
  expect(updatedRecord!.attemptCount).toEqual(1);
  expect(updatedRecord!.lastError?.name).toEqual("MissingAggregateError");
  expect(updatedRecord!.lastError?.message).toEqual(
    "Bet aggregate not found yet"
  );
  expect(updatedRecord!.nextAttemptAt.toISOString()).toEqual(
    new Date(current.now.getTime() + 1000).toISOString()
  );

  current.now = new Date(current.now.getTime() + 1000);
  await worker.runOnce();

  updatedRecord = await PendingModerationResult.findById(record!._id);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("PENDING");
  expect(updatedRecord!.attemptCount).toEqual(2);
  expect(updatedRecord!.nextAttemptAt.toISOString()).toEqual(
    new Date(current.now.getTime() + 2000).toISOString()
  );

  current.now = new Date(current.now.getTime() + 2000);
  await worker.runOnce();

  updatedRecord = await PendingModerationResult.findById(record!._id);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("EXHAUSTED");
  expect(updatedRecord!.attemptCount).toEqual(3);
  expect(updatedRecord!.exhaustedAt?.toISOString()).toEqual(current.now.toISOString());
  expect(processor).toHaveBeenCalledTimes(3);
});

it("exhausts overly old pending moderation records on replay", async () => {
  const current = { now: new Date("2026-08-21T01:00:00.000Z") };
  const clock = {
    now: () => current.now,
  };
  const processor = jest.fn<ReturnType<PendingModerationProcessor>, Parameters<PendingModerationProcessor>>()
    .mockResolvedValue("MISSING_AGGREGATE");
  const record = await createPendingModerationRecord({
    nextAttemptAt: current.now,
    slipId: "aged-slip",
  });
  current.now = new Date(record!.createdAt.getTime() + 10_000);
  const worker = await createWorker(processor, {
    clock,
    maxAgeMs: 5_000,
    workerId: "pending-worker-aged",
  });

  await worker.runOnce();

  const updatedRecord = await PendingModerationResult.findById(record!._id);
  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("EXHAUSTED");
  expect(updatedRecord!.attemptCount).toEqual(1);
  expect(updatedRecord!.exhaustedAt?.toISOString()).toEqual(current.now.toISOString());
});

it("extends leases so a competing worker cannot reclaim a slow replay mid-flight", async () => {
  let release!: () => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let invocation = 0;
  const processor = jest
    .fn<ReturnType<PendingModerationProcessor>, Parameters<PendingModerationProcessor>>()
    .mockImplementation(async () => {
      invocation += 1;
      if (invocation === 1) {
        startedResolve();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }

      return "RESOLVED";
    });
  const record = await createPendingModerationRecord({
    nextAttemptAt: new Date(Date.now() - 1000),
    slipId: "lease-slip",
  });
  const workerOne = await createWorker(processor, {
    heartbeatIntervalMs: 20,
    leaseMs: 60,
    workerId: "pending-worker-one",
  });
  const workerTwo = await createWorker(processor, {
    heartbeatIntervalMs: 20,
    leaseMs: 60,
    workerId: "pending-worker-two",
  });

  const firstRun = workerOne.runOnce();
  await started;

  const claimedRecord = await PendingModerationResult.findById(record!._id);
  expect(claimedRecord).not.toBeNull();
  expect(claimedRecord?.leasedUntil).toBeDefined();
  const initialLeaseExpiry = claimedRecord!.leasedUntil!.getTime();

  await waitForCondition(async () => {
    const updatedRecord = await PendingModerationResult.findById(record!._id);
    return (updatedRecord?.leasedUntil?.getTime() ?? 0) > initialLeaseExpiry;
  }, "lease extension");

  await delay(80);
  const secondRunResult = await workerTwo.runOnce();

  release();
  await firstRun;

  expect(secondRunResult).toEqual(0);
  expect(await PendingModerationResult.findById(record!._id)).toBeNull();
  expect(processor).toHaveBeenCalledTimes(1);
});

it("reclaims stale leases and resumes persisted work after restart", async () => {
  const processor = jest
    .fn<ReturnType<PendingModerationProcessor>, Parameters<PendingModerationProcessor>>()
    .mockResolvedValue("RESOLVED");
  const record = await createPendingModerationRecord({
    leaseOwner: "stale-worker",
    leasedUntil: new Date(Date.now() - 60_000),
    nextAttemptAt: new Date(Date.now() - 60_000),
    slipId: "stale-slip",
    status: "PROCESSING",
  });

  const worker = await createWorker(processor, {
    workerId: "pending-worker-restarted",
  });
  await worker.runOnce();

  expect(await PendingModerationResult.findById(record!._id)).toBeNull();
  expect(processor).toHaveBeenCalledTimes(1);
});

it("keeps exhausted records terminal when duplicate moderation arrives", async () => {
  const exhaustedAt = new Date("2026-08-21T01:10:00.000Z");
  await createPendingModerationRecord({
    attemptCount: 4,
    exhaustedAt,
    nextAttemptAt: new Date("2026-08-21T01:09:00.000Z"),
    slipId: "exhausted-slip",
    status: "EXHAUSTED",
  });

  await parkPendingModerationResult(
    createModerationEvent("exhausted-slip", ModerationStatus.APPROVED, {
      betKind: BetKind.LIVE,
    })
  );

  const updatedRecord = await PendingModerationResult.findOne({
    slipId: "exhausted-slip",
  });

  expect(updatedRecord).not.toBeNull();
  expect(updatedRecord!.status).toEqual("EXHAUSTED");
  expect(updatedRecord!.attemptCount).toEqual(4);
  expect(updatedRecord!.exhaustedAt?.toISOString()).toEqual(exhaustedAt.toISOString());
  expect(updatedRecord!.betKind).toEqual(BetKind.LIVE);
});
