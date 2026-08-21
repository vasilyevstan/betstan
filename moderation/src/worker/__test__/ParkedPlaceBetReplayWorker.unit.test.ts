import { ParkedPlaceBetStatus } from "../../model/ParkedPlaceBet";
import ModerationService, {
  ParkedPlaceBetRecord,
} from "../../service/ModerationService";
import ParkedPlaceBetReplayWorker, {
  createParkedPlaceBetReplayWorkerOptionsFromEnv,
} from "../ParkedPlaceBetReplayWorker";
import { createDeferred, createPlaceBetEvent } from "../../event/listener/__test__/helpers";

type MockService = {
  claimParkedPlaceBet: jest.Mock;
  replayParkedPlaceBet: jest.Mock;
  rescheduleClaimedParkedPlaceBet: jest.Mock;
  removeParkedPlaceBet: jest.Mock;
};

const createService = (overrides: Partial<MockService> = {}): MockService => ({
  claimParkedPlaceBet: jest.fn(async () => null),
  replayParkedPlaceBet: jest.fn(),
  rescheduleClaimedParkedPlaceBet: jest.fn(
    async () => ParkedPlaceBetStatus.PENDING
  ),
  removeParkedPlaceBet: jest.fn(async () => undefined),
  ...overrides,
});

const createWorker = (
  service: MockService,
  options: Partial<ConstructorParameters<typeof ParkedPlaceBetReplayWorker>[1]> = {}
) =>
  new ParkedPlaceBetReplayWorker(
    service as unknown as ModerationService,
    {
      ownerId: "worker-owner",
      pollIntervalMs: 50,
      leaseDurationMs: 5_000,
      batchSize: 5,
      maxAttempts: 3,
      maxAgeMs: 60_000,
      baseBackoffMs: 25,
      maxBackoffMs: 200,
      ...options,
    }
  );

const createClaimedParkedPlaceBet = (
  overrides: Partial<ParkedPlaceBetRecord> = {}
): ParkedPlaceBetRecord => {
  const event = createPlaceBetEvent();

  return {
    slipId: event.data.slipId,
    event,
    pendingEventIds: [event.data.rows[0].eventId],
    status: ParkedPlaceBetStatus.PROCESSING,
    attemptCount: 1,
    nextAttemptAt: new Date().toISOString(),
    leaseOwner: "worker-owner",
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastError: "",
    exhaustedAt: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
};

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("uses default worker options and ignores duplicate starts once running", async () => {
  const service = createService();
  const worker = new ParkedPlaceBetReplayWorker(
    service as unknown as ModerationService
  );

  await worker.start();
  await worker.start();
  await worker.stop();

  expect(service.claimParkedPlaceBet).toHaveBeenCalledTimes(1);
  expect(worker.isRunning()).toEqual(false);
});

it("reschedules replay errors and leaves exhausted parked results observable", async () => {
  const firstClaim = createClaimedParkedPlaceBet({ slipId: "slip-1" });
  const secondClaim = createClaimedParkedPlaceBet({ slipId: "slip-2" });
  const service = createService({
    claimParkedPlaceBet: jest.fn()
      .mockResolvedValueOnce(firstClaim)
      .mockResolvedValueOnce(secondClaim)
      .mockResolvedValueOnce(null),
    replayParkedPlaceBet: jest.fn()
      .mockRejectedValueOnce(new Error("replay failed"))
      .mockResolvedValueOnce({
        type: "park",
        pendingEventIds: secondClaim.pendingEventIds,
        exhausted: true,
      }),
  });
  const worker = createWorker(service);

  const processed = await worker.runOnce();

  expect(processed).toEqual(2);
  expect(service.rescheduleClaimedParkedPlaceBet).toHaveBeenCalledTimes(1);
  expect(service.rescheduleClaimedParkedPlaceBet).toHaveBeenCalledWith(
    firstClaim,
    expect.objectContaining({
      pendingEventIds: firstClaim.pendingEventIds,
      lastError: expect.any(Error),
    })
  );
  expect(service.removeParkedPlaceBet).not.toHaveBeenCalled();
});

it("returns zero for concurrent runOnce calls and swallows rejected in-flight shutdown work", async () => {
  const claimedParkedPlaceBet = createClaimedParkedPlaceBet();
  const replayStarted = createDeferred<void>();
  const releaseReplay = createDeferred<void>();
  const service = createService({
    claimParkedPlaceBet: jest.fn()
      .mockResolvedValueOnce(claimedParkedPlaceBet)
      .mockResolvedValueOnce(null),
    replayParkedPlaceBet: jest.fn(async () => {
      replayStarted.resolve();
      await releaseReplay.promise;
      return { type: "decision" };
    }),
  });
  const worker = createWorker(service);

  const firstRun = worker.runOnce();
  await replayStarted.promise;

  expect(await worker.runOnce()).toEqual(0);

  releaseReplay.resolve();
  await firstRun;

  expect(service.removeParkedPlaceBet).toHaveBeenCalledWith(
    claimedParkedPlaceBet.slipId
  );

  (worker as any).started = true;
  (worker as any).currentRun = (async () => {
    throw new Error("in-flight stop failure");
  })();

  await expect(worker.stop()).resolves.toBeUndefined();
});

it("logs timer tick failures and stops scheduling once stopped", async () => {
  jest.useFakeTimers();

  const service = createService();
  const worker = createWorker(service, {
    pollIntervalMs: 10,
  });
  const runOnceSpy = jest.spyOn(worker, "runOnce")
    .mockResolvedValueOnce(0)
    .mockRejectedValueOnce(new Error("tick failure"));
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

  await worker.start();
  await jest.advanceTimersByTimeAsync(10);

  expect(logSpy).toHaveBeenCalledWith(
    "parked place bet replay worker tick failed",
    expect.any(Error)
  );

  await worker.stop();
  await jest.advanceTimersByTimeAsync(10);

  expect(runOnceSpy).toHaveBeenCalledTimes(2);
});

it("does not schedule when stopped and validates env and option parsing", () => {
  const service = createService();
  const worker = createWorker(service);

  (worker as any).scheduleNextRun();

  expect((worker as any).timer).toBeNull();
  expect(createParkedPlaceBetReplayWorkerOptionsFromEnv()).toEqual({
    pollIntervalMs: undefined,
    leaseDurationMs: undefined,
    batchSize: undefined,
    maxAttempts: undefined,
    maxAgeMs: undefined,
    baseBackoffMs: undefined,
    maxBackoffMs: undefined,
  });
  expect(
    createParkedPlaceBetReplayWorkerOptionsFromEnv({
      MODERATION_PARKING_BATCH_SIZE: "2",
      MODERATION_PARKING_MAX_AGE_MS: "0",
    })
  ).toEqual(
    expect.objectContaining({
      batchSize: 2,
      maxAgeMs: 0,
    })
  );
  expect(() =>
    createParkedPlaceBetReplayWorkerOptionsFromEnv({
      MODERATION_PARKING_BATCH_SIZE: "invalid",
    })
  ).toThrow("MODERATION_PARKING_BATCH_SIZE must be an integer when provided");
  expect(() =>
    createWorker(service, { pollIntervalMs: 0 })
  ).toThrow(
    "Parked place bet replay worker requires pollIntervalMs to be a positive integer"
  );
  expect(() =>
    createWorker(service, { maxAgeMs: -1 })
  ).toThrow(
    "Parked place bet replay worker requires maxAgeMs to be a non-negative integer"
  );
  expect(() =>
    createWorker(service, {
      baseBackoffMs: 20,
      maxBackoffMs: 10,
    })
  ).toThrow(
    "Parked place bet replay worker requires maxBackoffMs >= baseBackoffMs"
  );
});

it("formats non-error startup failures before surfacing them", async () => {
  const service = createService();
  const worker = createWorker(service);
  const runOnceSpy = jest
    .spyOn(worker, "runOnce")
    .mockRejectedValueOnce("  startup \n failure  ");

  await expect(worker.start()).rejects.toThrow(
    "Failed to start parked place bet replay worker: startup failure"
  );

  runOnceSpy.mockRestore();
});
