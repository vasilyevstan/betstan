import mongoose, { FilterQuery } from "mongoose";
import {
  BetKind,
  BetStatus,
  IModerationResultEvent,
  IPlaceBetEvent,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  LiveMarketType,
  LiveSettlementReason,
  ModerationDeclineReason,
  ModerationStatus,
  ResultingStatus,
  SlipRowStatus,
  TeamSide,
} from "@betstan/common";
import { Bet } from "../../model/Bet";
import {
  PendingBetUpdate,
  PendingBetUpdateKind,
  PendingBetUpdateStatus,
} from "../../model/PendingBetUpdate";
import {
  PendingBetUpdateWorker,
  PendingBetUpdateWorkerClock,
} from "../PendingBetUpdateWorker";
import { parkPendingBetUpdate, upsertPlaceBet } from "../betHistory";

class FakeClock implements PendingBetUpdateWorkerClock {
  private currentTimeMs: number;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  constructor(now: string) {
    this.currentTimeMs = new Date(now).getTime();
  }

  now() {
    return new Date(this.currentTimeMs);
  }

  setTimeout(callback: () => void, delayMs: number) {
    const timerId = this.nextTimerId++;
    this.timers.set(timerId, {
      callback,
      dueAt: this.currentTimeMs + delayMs,
    });
    return timerId;
  }

  clearTimeout(handle: number) {
    this.timers.delete(handle);
  }

  advanceBy(delayMs: number) {
    const targetTimeMs = this.currentTimeMs + delayMs;
    const dueTimers = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= targetTimeMs)
      .sort((left, right) => {
        if (left[1].dueAt !== right[1].dueAt) {
          return left[1].dueAt - right[1].dueAt;
        }

        return left[0] - right[0];
      });

    for (const [timerId, timer] of dueTimers) {
      this.currentTimeMs = timer.dueAt;
      this.timers.delete(timerId);
      timer.callback();
    }

    this.currentTimeMs = targetTimeMs;
  }

  pendingTimerCount() {
    return this.timers.size;
  }
}

const createTestClock = (offsetMs: number = 5_000) =>
  new FakeClock(new Date(Date.now() + offsetMs).toISOString());

const createDeferred = () => {
  let resolve!: () => void;

  return {
    promise: new Promise<void>((innerResolve) => {
      resolve = innerResolve;
    }),
    resolve,
  };
};

const waitForCondition = async (
  predicate: () => Promise<boolean>,
  attempts: number = 20
) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) {
      return;
    }

    await Promise.resolve();
  }

  throw new Error("Condition was not met");
};

const buildPlaceBetEvent = ({
  slipId = new mongoose.Types.ObjectId().toHexString(),
  rowId = new mongoose.Types.ObjectId().toHexString(),
  betKind = BetKind.LIVE,
}: {
  slipId?: string;
  rowId?: string;
  betKind?: BetKind;
} = {}): IPlaceBetEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testuser@example.com",
    slipId,
    wager: 10,
    betKind,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "Next corner",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
        id: rowId,
        betKind,
        marketId: "event-one:NEXT_CORNER",
        marketType: LiveMarketType.NEXT_CORNER,
      },
    ],
  },
});

const buildModerationResultEvent = ({
  slipId,
  rowId = new mongoose.Types.ObjectId().toHexString(),
  result = ModerationStatus.DECLINED,
}: {
  slipId: string;
  rowId?: string;
  result?: ModerationStatus;
}): IModerationResultEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    slipId,
    result,
    betKind: BetKind.LIVE,
    declineReason: ModerationDeclineReason.STALE_QUOTE,
    affectedRows: [
      {
        rowId,
        declineReason: ModerationDeclineReason.STALE_QUOTE,
        marketId: "event-one:NEXT_CORNER",
        marketVersion: 2,
      },
    ],
  },
});

const buildSettleSlipEvent = ({
  slipId,
  result = ResultingStatus.BET_VOID,
}: {
  slipId: string;
  result?: ResultingStatus;
}): ISettleSlipEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    slipId,
    result,
    betKind: BetKind.LIVE,
  },
});

const buildSettleSlipRowEvent = ({
  slipId,
  rowId,
  result = ResultingStatus.ROW_VOID,
}: {
  slipId: string;
  rowId: string;
  result?: ResultingStatus;
}): ISettleSlipRowEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    slipId,
    slipRowId: rowId,
    result,
    winningSelection: "Home",
    winningSide: TeamSide.NONE,
    betKind: BetKind.LIVE,
    marketId: "event-one:NEXT_CORNER",
    marketType: LiveMarketType.NEXT_CORNER,
    marketVersion: 2,
    settlementReason: LiveSettlementReason.MANUAL_VOID,
    settlementSequence: 4,
  },
});

const createWorker = (
  clock: FakeClock,
  overrides: Partial<ConstructorParameters<typeof PendingBetUpdateWorker>[0]> = {}
) =>
  new PendingBetUpdateWorker({
    backoffBaseMs: 1_000,
    backoffMaxMs: 4_000,
    batchSize: 10,
    clock,
    leaseMs: 5_000,
    maxAgeMs: 60_000,
    maxAttempts: 5,
    pollIntervalMs: 1_000,
    ...overrides,
  });

it("replays due parked updates on start and cleans timers on shutdown", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock);

  await upsertPlaceBet(buildPlaceBetEvent({ slipId, rowId }));
  await parkPendingBetUpdate(
    PendingBetUpdateKind.MODERATION_RESULT,
    buildModerationResultEvent({
      result: ModerationStatus.APPROVED,
      rowId,
      slipId,
    })
  );

  await worker.start();

  const bet = await Bet.findOne({ slipId });
  expect(bet!.status).toEqual(BetStatus.CONFIRMED);
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(0);
  expect(clock.pendingTimerCount()).toEqual(1);

  await worker.start();
  expect(clock.pendingTimerCount()).toEqual(1);

  await worker.stop();
  expect(clock.pendingTimerCount()).toEqual(0);

  await worker.stop();
  expect(clock.pendingTimerCount()).toEqual(0);
});

it("extends the lease during slow replay so a second worker cannot steal it", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const workerOne = createWorker(clock, {
    leaseMs: 1_000,
  });
  const workerTwo = createWorker(clock, {
    leaseMs: 1_000,
  });
  const saveDeferred = createDeferred();
  const originalSave = Bet.prototype.save;
  const saveSpy = jest.spyOn(Bet.prototype, "save").mockImplementation(function (
    this: typeof Bet.prototype,
    ...args: unknown[]
  ) {
    if ((this as unknown as { slipId?: string }).slipId === slipId) {
      return saveDeferred.promise.then(() =>
        (originalSave as (...innerArgs: unknown[]) => Promise<unknown>).apply(
          this,
          args
        )
      ) as never;
    }

    return (originalSave as (...innerArgs: unknown[]) => Promise<unknown>).apply(
      this,
      args
    ) as never;
  });

  await upsertPlaceBet(buildPlaceBetEvent({ slipId, rowId }));
  await parkPendingBetUpdate(
    PendingBetUpdateKind.MODERATION_RESULT,
    buildModerationResultEvent({
      result: ModerationStatus.APPROVED,
      rowId,
      slipId,
    })
  );

  const workerOneRun = workerOne.runNow();
  await waitForCondition(async () =>
    Boolean(
      await PendingBetUpdate.findOne({
        leaseOwner: workerOne.getLeaseOwner(),
        slipId,
        status: PendingBetUpdateStatus.PROCESSING,
      })
    )
  );

  clock.advanceBy(1_500);
  const workerTwoRun = workerTwo.runNow();
  await Promise.resolve();

  const pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.leaseOwner).toEqual(workerOne.getLeaseOwner());

  saveDeferred.resolve();
  await workerOneRun;
  await workerTwoRun;

  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(0);
  expect((await Bet.findOne({ slipId }))!.status).toEqual(BetStatus.CONFIRMED);

  saveSpy.mockRestore();
});

it("reschedules missing aggregates and replays once the bet arrives later", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock);

  await parkPendingBetUpdate(
    PendingBetUpdateKind.SETTLE_SLIP_ROW,
    buildSettleSlipRowEvent({ rowId, slipId })
  );
  await parkPendingBetUpdate(
    PendingBetUpdateKind.SETTLE_SLIP,
    buildSettleSlipEvent({ slipId })
  );

  await worker.start();

  const pendingUpdates = await PendingBetUpdate.find({ slipId }).sort({ kind: 1 });
  expect(pendingUpdates).toHaveLength(2);
  expect(pendingUpdates[0].status).toEqual(PendingBetUpdateStatus.PENDING);
  expect(pendingUpdates[0].attemptCount).toEqual(1);
  expect(pendingUpdates[0].nextAttemptAt.getTime() - clock.now().getTime()).toEqual(
    1_000
  );
  expect(pendingUpdates[0].lastError).toEqual(
    "Bet aggregate is not available yet"
  );
  expect(pendingUpdates[0].leaseOwner).toBeUndefined();
  expect(pendingUpdates[0].leaseUntil).toBeUndefined();

  await upsertPlaceBet(buildPlaceBetEvent({ slipId, rowId }));

  clock.advanceBy(999);
  await worker.waitForIdle();
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(2);

  clock.advanceBy(1);
  await worker.waitForIdle();

  const bet = await Bet.findOne({ slipId });
  expect(bet!.status).toEqual(BetStatus.VOID);
  expect(bet!.rows[0].status).toEqual(SlipRowStatus.VOID);
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(0);

  await worker.stop();
});

it("coalesces duplicate parked updates and preserves terminal bet state", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock);

  const { bet } = await upsertPlaceBet(buildPlaceBetEvent({ slipId, rowId }));
  bet.status = BetStatus.WIN;
  await bet.save();

  const duplicateEvent = buildSettleSlipEvent({
    slipId,
    result: ResultingStatus.BET_LOSS,
  });
  await parkPendingBetUpdate(PendingBetUpdateKind.SETTLE_SLIP, duplicateEvent);
  await parkPendingBetUpdate(PendingBetUpdateKind.SETTLE_SLIP, duplicateEvent);

  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(1);

  await worker.runNow();

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.status).toEqual(BetStatus.WIN);
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(0);
});

it("stops applying additional records after ownership loss without deleting another owner's record", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock);

  await upsertPlaceBet(buildPlaceBetEvent({ slipId, rowId }));
  await parkPendingBetUpdate(
    PendingBetUpdateKind.MODERATION_RESULT,
    buildModerationResultEvent({
      result: ModerationStatus.APPROVED,
      rowId,
      slipId,
    })
  );
  await parkPendingBetUpdate(
    PendingBetUpdateKind.SETTLE_SLIP,
    buildSettleSlipEvent({ slipId })
  );

  const pendingUpdates = await PendingBetUpdate.find({ slipId }).sort({ kind: 1 });
  const moderationUpdateId = pendingUpdates.find(
    (pendingUpdate) => pendingUpdate.kind === PendingBetUpdateKind.MODERATION_RESULT
  )!._id;
  const settlementUpdateId = pendingUpdates.find(
    (pendingUpdate) => pendingUpdate.kind === PendingBetUpdateKind.SETTLE_SLIP
  )!._id;
  const originalUpdateMany = PendingBetUpdate.updateMany.bind(PendingBetUpdate);
  let ownershipRefreshCount = 0;
  const updateManySpy = jest.spyOn(PendingBetUpdate, "updateMany").mockImplementation(
    (async (...args: unknown[]) => {
      const [filter, update] = args as [
        FilterQuery<unknown>,
        Record<string, unknown>,
      ];
      const isLeaseRefresh =
        Boolean(update?.$set && "leaseUntil" in (update.$set as object))
        && !("$inc" in update);

      if (isLeaseRefresh) {
        ownershipRefreshCount += 1;

        if (ownershipRefreshCount === 2) {
          await PendingBetUpdate.updateOne(
            { _id: settlementUpdateId },
            {
              $set: {
                leaseOwner: "worker-two",
                leaseUntil: new Date(clock.now().getTime() + 5_000),
                status: PendingBetUpdateStatus.PROCESSING,
              },
            }
          );
        }
      }

      return originalUpdateMany(filter as never, update as never);
    }) as never
  );

  await worker.runNow();

  const bet = await Bet.findOne({ slipId });
  const moderationUpdate = await PendingBetUpdate.findById(moderationUpdateId);
  const settlementUpdate = await PendingBetUpdate.findById(settlementUpdateId);
  expect(bet!.status).toEqual(BetStatus.CONFIRMED);
  expect(moderationUpdate!.status).toEqual(PendingBetUpdateStatus.PROCESSING);
  expect(moderationUpdate!.leaseOwner).toEqual(worker.getLeaseOwner());
  expect(settlementUpdate!.status).toEqual(PendingBetUpdateStatus.PROCESSING);
  expect(settlementUpdate!.leaseOwner).toEqual("worker-two");
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(2);

  updateManySpy.mockRestore();
});

it("caps exponential backoff and exhausts after max attempts", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock, {
    maxAttempts: 5,
  });

  await parkPendingBetUpdate(
    PendingBetUpdateKind.SETTLE_SLIP,
    buildSettleSlipEvent({ slipId })
  );

  await worker.runNow();
  let pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.attemptCount).toEqual(1);
  expect(pendingUpdate!.nextAttemptAt.getTime() - clock.now().getTime()).toEqual(
    1_000
  );

  clock.advanceBy(1_000);
  await worker.runNow();
  pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.attemptCount).toEqual(2);
  expect(pendingUpdate!.nextAttemptAt.getTime() - clock.now().getTime()).toEqual(
    2_000
  );

  clock.advanceBy(2_000);
  await worker.runNow();
  pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.attemptCount).toEqual(3);
  expect(pendingUpdate!.nextAttemptAt.getTime() - clock.now().getTime()).toEqual(
    4_000
  );

  clock.advanceBy(4_000);
  await worker.runNow();
  pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.attemptCount).toEqual(4);
  expect(pendingUpdate!.nextAttemptAt.getTime() - clock.now().getTime()).toEqual(
    4_000
  );

  clock.advanceBy(4_000);
  await worker.runNow();
  pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.status).toEqual(PendingBetUpdateStatus.EXHAUSTED);
  expect(pendingUpdate!.attemptCount).toEqual(5);
  expect(pendingUpdate!.exhaustedAt?.toISOString()).toEqual(
    clock.now().toISOString()
  );
  expect(pendingUpdate!.lastError).toContain("Pending bet update exceeded max attempts");
});

it("processes only the claimed record ids from one slip in each bounded run", async () => {
  const clock = createTestClock();
  const firstSlipId = new mongoose.Types.ObjectId().toHexString();
  const firstRowId = new mongoose.Types.ObjectId().toHexString();
  const secondSlipId = new mongoose.Types.ObjectId().toHexString();
  const secondRowId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock, {
    batchSize: 1,
  });

  await upsertPlaceBet(buildPlaceBetEvent({ rowId: firstRowId, slipId: firstSlipId }));
  await upsertPlaceBet(buildPlaceBetEvent({ rowId: secondRowId, slipId: secondSlipId }));
  await parkPendingBetUpdate(
    PendingBetUpdateKind.SETTLE_SLIP,
    buildSettleSlipEvent({ slipId: firstSlipId })
  );
  await parkPendingBetUpdate(
    PendingBetUpdateKind.SETTLE_SLIP,
    buildSettleSlipEvent({ slipId: secondSlipId })
  );

  await worker.runNow();

  expect((await Bet.findOne({ slipId: firstSlipId }))!.status).toEqual(
    BetStatus.VOID
  );
  expect((await Bet.findOne({ slipId: secondSlipId }))!.status).toEqual(
    BetStatus.PENDING
  );
  expect(await PendingBetUpdate.countDocuments({ slipId: firstSlipId })).toEqual(0);
  expect(await PendingBetUpdate.countDocuments({ slipId: secondSlipId })).toEqual(1);

  await worker.runNow();

  expect((await Bet.findOne({ slipId: secondSlipId }))!.status).toEqual(
    BetStatus.VOID
  );
  expect(await PendingBetUpdate.countDocuments({ slipId: secondSlipId })).toEqual(0);
});

it("exhausts stale parked updates after the configured max age", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock, {
    maxAgeMs: 5_000,
  });

  await parkPendingBetUpdate(
    PendingBetUpdateKind.SETTLE_SLIP,
    buildSettleSlipEvent({ slipId })
  );

  await PendingBetUpdate.collection.updateOne(
    { slipId },
    {
      $set: {
        createdAt: new Date(clock.now().getTime() - 6_000),
        nextAttemptAt: new Date(clock.now().getTime() - 1_000),
      },
    }
  );

  await worker.runNow();

  const pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.status).toEqual(PendingBetUpdateStatus.EXHAUSTED);
  expect(pendingUpdate!.lastError).toContain("Pending bet update exceeded max age");
  expect(pendingUpdate!.exhaustedAt?.toISOString()).toEqual(
    clock.now().toISOString()
  );
});

it("respects active leases and reclaims stale ones once they expire", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock);

  await upsertPlaceBet(buildPlaceBetEvent({ slipId, rowId }));
  await parkPendingBetUpdate(
    PendingBetUpdateKind.MODERATION_RESULT,
    buildModerationResultEvent({
      result: ModerationStatus.APPROVED,
      rowId,
      slipId,
    })
  );

  await PendingBetUpdate.updateOne(
    { slipId },
    {
      $set: {
        attemptCount: 1,
        leaseOwner: "other-worker",
        leaseUntil: new Date(clock.now().getTime() + 5_000),
        status: PendingBetUpdateStatus.PROCESSING,
      },
    }
  );

  await worker.runNow();
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(1);

  clock.advanceBy(5_001);
  await worker.runNow();

  const bet = await Bet.findOne({ slipId });
  expect(bet!.status).toEqual(BetStatus.CONFIRMED);
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(0);
});

it("replays due updates immediately when restarted after being stopped", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock);

  await worker.start();
  await worker.stop();

  await parkPendingBetUpdate(
    PendingBetUpdateKind.SETTLE_SLIP_ROW,
    buildSettleSlipRowEvent({ rowId, slipId })
  );
  await upsertPlaceBet(buildPlaceBetEvent({ slipId, rowId }));

  clock.advanceBy(30_000);
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(1);

  await worker.start();

  const bet = await Bet.findOne({ slipId });
  expect(bet!.rows[0].status).toEqual(SlipRowStatus.VOID);
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(0);

  await worker.stop();
});

it("waits for in-flight work to finish before stopping and cleans heartbeat timers", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const worker = createWorker(clock, {
    leaseMs: 1_000,
  });
  const saveDeferred = createDeferred();
  const originalSave = Bet.prototype.save;
  const saveSpy = jest.spyOn(Bet.prototype, "save").mockImplementation(function (
    this: typeof Bet.prototype,
    ...args: unknown[]
  ) {
    if ((this as unknown as { slipId?: string }).slipId === slipId) {
      return saveDeferred.promise.then(() =>
        (originalSave as (...innerArgs: unknown[]) => Promise<unknown>).apply(
          this,
          args
        )
      ) as never;
    }

    return (originalSave as (...innerArgs: unknown[]) => Promise<unknown>).apply(
      this,
      args
    ) as never;
  });

  await upsertPlaceBet(buildPlaceBetEvent({ slipId, rowId }));
  await parkPendingBetUpdate(
    PendingBetUpdateKind.MODERATION_RESULT,
    buildModerationResultEvent({
      result: ModerationStatus.APPROVED,
      rowId,
      slipId,
    })
  );

  const startPromise = worker.start();
  await waitForCondition(async () =>
    Boolean(
      await PendingBetUpdate.findOne({
        leaseOwner: worker.getLeaseOwner(),
        slipId,
        status: PendingBetUpdateStatus.PROCESSING,
      })
    )
  );

  const stopPromise = worker.stop();
  let stopped = false;
  void stopPromise.then(() => {
    stopped = true;
  });

  clock.advanceBy(1_500);
  await Promise.resolve();
  const pendingUpdateWhileStopping = await PendingBetUpdate.findOne({ slipId });
  expect(stopped).toBe(false);
  expect(pendingUpdateWhileStopping!.leaseOwner).toEqual(worker.getLeaseOwner());
  expect(pendingUpdateWhileStopping!.status).toEqual(
    PendingBetUpdateStatus.PROCESSING
  );

  saveDeferred.resolve();
  await stopPromise;
  await startPromise;

  await waitForCondition(async () => clock.pendingTimerCount() === 0);
  expect(clock.pendingTimerCount()).toEqual(0);
  expect((await Bet.findOne({ slipId }))!.status).toEqual(BetStatus.CONFIRMED);

  saveSpy.mockRestore();
});

it("logs processing failures and sanitizes stored errors", async () => {
  const clock = createTestClock();
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const logger = {
    error: jest.fn(),
  };
  const worker = createWorker(clock, { logger });
  const findOneSpy = jest
    .spyOn(Bet, "findOne")
    .mockRejectedValueOnce(new Error("boom\nwith stack"));

  await parkPendingBetUpdate(
    PendingBetUpdateKind.SETTLE_SLIP,
    buildSettleSlipEvent({ slipId })
  );

  await worker.runNow();

  const pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(logger.error).toHaveBeenCalled();
  expect(pendingUpdate!.status).toEqual(PendingBetUpdateStatus.PENDING);
  expect(pendingUpdate!.lastError).toEqual("boom with stack");

  findOneSpy.mockRestore();
});
