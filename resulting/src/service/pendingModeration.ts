import { IAmqpConnection, IModerationResultEvent } from "@betstan/common";
import SettleSlipPublisher from "../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../event/publisher/SettleSlipRowPublisher";
import PendingModerationResult from "../model/PendingModerationResult";
import type { SettlementPublishers } from "./resulting";

export type PendingModerationReplayOutcome =
  | "RESOLVED"
  | "MISSING_AGGREGATE";

export type PendingModerationProcessor = (
  event: IModerationResultEvent,
  publishers: SettlementPublishers
) => Promise<PendingModerationReplayOutcome>;

export interface PendingModerationClock {
  now(): Date;
}

export interface PendingModerationReplayOptions {
  baseBackoffMs?: number;
  batchSize?: number;
  clock?: PendingModerationClock;
  heartbeatIntervalMs?: number;
  leaseMs?: number;
  maxAgeMs?: number;
  maxAttempts?: number;
  maxBackoffMs?: number;
  pollIntervalMs?: number;
  workerId?: string;
}

const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_LEASE_MS = 30000;
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const STATUS_EXHAUSTED = "EXHAUSTED";
const STATUS_PENDING = "PENDING";
const STATUS_PROCESSING = "PROCESSING";

const defaultClock: PendingModerationClock = {
  now: () => new Date(),
};

interface PendingModerationError {
  message: string;
  name: string;
}

interface LeaseHeartbeat {
  hasHealthyLease(): boolean;
  stop(): Promise<void>;
}

interface LeaseHeartbeatState {
  inFlightExtension?: Promise<void>;
  lostOwnership: boolean;
  stopped: boolean;
  timer?: NodeJS.Timeout;
}

function computeBackoffMs(
  attemptCount: number,
  {
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  }: Pick<
    PendingModerationReplayOptions,
    "baseBackoffMs" | "maxBackoffMs"
  > = {}
): number {
  const boundedAttempt = Math.max(1, attemptCount);
  const multiplier = 2 ** (boundedAttempt - 1);
  return Math.min(maxBackoffMs, baseBackoffMs * multiplier);
}

function computeHeartbeatIntervalMs(
  leaseMs: number,
  explicit?: number
): number {
  return explicit ?? Math.max(50, Math.floor(leaseMs / 3));
}

function sanitizeError(error: unknown): PendingModerationError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  return {
    message: typeof error === "string" ? error : JSON.stringify(error),
    name: "Error",
  };
}

function buildMissingAggregateError(): PendingModerationError {
  return {
    message: "Bet aggregate not found yet",
    name: "MissingAggregateError",
  };
}

function toModerationEvent(pendingModeration: any): IModerationResultEvent {
  return {
    data: {
      slipId: pendingModeration.slipId,
      result: pendingModeration.result,
      betKind: pendingModeration.betKind,
      declineReason: pendingModeration.declineReason,
      affectedRows: pendingModeration.affectedRows ?? [],
    },
    timestamp: pendingModeration.timestamp,
  };
}

async function createSettlementPublishers(
  connection: IAmqpConnection
): Promise<SettlementPublishers> {
  const settleSlipRowPublisher = new SettleSlipRowPublisher(connection);
  await settleSlipRowPublisher.init();
  await settleSlipRowPublisher.initConfirmChannel();

  const settleSlipPublisher = new SettleSlipPublisher(connection);
  await settleSlipPublisher.init();
  await settleSlipPublisher.initConfirmChannel();

  return {
    settleSlipPublisher,
    settleSlipRowPublisher,
  };
}

async function fetchPendingModerationResult(slipId: string): Promise<any> {
  return PendingModerationResult.findOne({ slipId });
}

export async function parkPendingModerationResult(
  event: IModerationResultEvent,
  {
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    clock = defaultClock,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  }: Pick<
    PendingModerationReplayOptions,
    "baseBackoffMs" | "clock" | "maxBackoffMs"
  > = {}
): Promise<any> {
  const now = clock.now();
  const existingRecord = await fetchPendingModerationResult(event.data.slipId);

  if (existingRecord) {
    await PendingModerationResult.updateOne(
      {
        _id: existingRecord._id,
      },
      {
        $set: {
          affectedRows: event.data.affectedRows ?? [],
          betKind: event.data.betKind,
          declineReason: event.data.declineReason,
          result: event.data.result,
          timestamp: event.timestamp ?? new Date().toISOString(),
        },
      }
    );

    return fetchPendingModerationResult(event.data.slipId);
  }

  return PendingModerationResult.create({
    affectedRows: event.data.affectedRows ?? [],
    attemptCount: 0,
    betKind: event.data.betKind,
    declineReason: event.data.declineReason,
    lastError: {
      message: "",
      name: "",
    },
    leaseOwner: "",
    nextAttemptAt: new Date(
      now.getTime() + computeBackoffMs(1, { baseBackoffMs, maxBackoffMs })
    ),
    result: event.data.result,
    slipId: event.data.slipId,
    status: STATUS_PENDING,
    timestamp: event.timestamp ?? new Date().toISOString(),
  });
}

export async function clearPendingModerationResult(
  slipId: string,
  {
    clock = defaultClock,
  }: Pick<PendingModerationReplayOptions, "clock"> = {}
): Promise<void> {
  const now = clock.now();

  await PendingModerationResult.deleteOne({
    slipId,
    status: {
      $ne: STATUS_EXHAUSTED,
    },
    $or: [
      {
        status: STATUS_PENDING,
      },
      {
        status: STATUS_PROCESSING,
        $or: [
          {
            leaseOwner: "",
          },
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
      },
    ],
  });
}

class PendingModerationReplayRunner {
  private activeHeartbeats = new Set<LeaseHeartbeatState>();
  private inFlightRun?: Promise<number>;
  private interval?: NodeJS.Timeout;
  private started = false;
  private stopped = false;

  private readonly baseBackoffMs: number;
  private readonly batchSize: number;
  private readonly clock: PendingModerationClock;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxAgeMs: number;
  private readonly maxAttempts: number;
  private readonly maxBackoffMs: number;
  private readonly pollIntervalMs: number;
  private readonly workerId: string;

  constructor(
    private readonly publishers: SettlementPublishers,
    private readonly processor: PendingModerationProcessor,
    options: PendingModerationReplayOptions = {}
  ) {
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.clock = options.clock ?? defaultClock;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatIntervalMs = computeHeartbeatIntervalMs(
      this.leaseMs,
      options.heartbeatIntervalMs
    );
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.workerId =
      options.workerId
      ?? `resulting-pending-moderation-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.stopped = false;

    await this.executeTrackedRun(false);

    if (this.stopped || this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      void this.triggerRun();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    await Promise.all(
      [...this.activeHeartbeats].map((heartbeat) => this.stopLeaseHeartbeat(heartbeat))
    );

    if (this.inFlightRun) {
      await this.inFlightRun;
    }
  }

  async runOnce(): Promise<number> {
    let processed = 0;

    for (let index = 0; index < this.batchSize; index += 1) {
      const pendingModeration = await this.claimPendingModerationRecord();

      if (!pendingModeration) {
        break;
      }

      await this.handleClaimedRecord(pendingModeration);
      processed += 1;
    }

    return processed;
  }

  async runOnceForSlip(slipId: string): Promise<boolean> {
    const pendingModeration = await this.claimPendingModerationRecordBySlip(slipId);

    if (!pendingModeration) {
      return false;
    }

    await this.handleClaimedRecord(pendingModeration);
    return true;
  }

  private async triggerRun(): Promise<number> {
    return this.executeTrackedRun(true);
  }

  private async executeTrackedRun(swallowErrors: boolean): Promise<number> {
    if (!this.inFlightRun) {
      const runPromise = this.runOnce();

      this.inFlightRun = (swallowErrors
        ? runPromise.catch((error) => {
          console.error("Pending moderation replay failed:", error);
          return 0;
        })
        : runPromise
      ).finally(() => {
        this.inFlightRun = undefined;
      });
    }

    return this.inFlightRun;
  }

  private async claimPendingModerationRecord(): Promise<any | null> {
    const now = this.clock.now();
    return this.claimRecord(
      {
        nextAttemptAt: {
          $lte: now,
        },
      },
      now
    );
  }

  private async claimPendingModerationRecordBySlip(
    slipId: string
  ): Promise<any | null> {
    return this.claimRecord(
      {
        slipId,
      },
      this.clock.now()
    );
  }

  private async claimRecord(
    filter: Record<string, unknown>,
    now: Date
  ): Promise<any | null> {
    const leaseUntil = new Date(now.getTime() + this.leaseMs);

    return PendingModerationResult.findOneAndUpdate(
      {
        ...filter,
        status: {
          $in: [STATUS_PENDING, STATUS_PROCESSING],
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
      },
      {
        $set: {
          lastAttemptAt: now,
          leasedUntil: leaseUntil,
          leaseOwner: this.workerId,
          status: STATUS_PROCESSING,
        },
      },
      {
        new: true,
        sort: {
          nextAttemptAt: 1,
          updatedAt: 1,
        },
      }
    );
  }

  private startLeaseHeartbeat(pendingModeration: any): LeaseHeartbeat {
    const state: LeaseHeartbeatState = {
      lostOwnership: false,
      stopped: false,
    };

    const extendLease = async (): Promise<void> => {
      if (state.stopped || state.lostOwnership) {
        return;
      }

      const now = this.clock.now();
      const leaseUntil = new Date(now.getTime() + this.leaseMs);

      try {
        const result = await PendingModerationResult.updateOne(
          {
            _id: pendingModeration._id,
            leaseOwner: this.workerId,
            status: STATUS_PROCESSING,
          },
          {
            $set: {
              leasedUntil: leaseUntil,
            },
          }
        );

        if (result.modifiedCount === 0) {
          state.lostOwnership = true;
          console.error("Pending moderation heartbeat lost ownership:", {
            slipId: pendingModeration.slipId,
            workerId: this.workerId,
          });
          this.cancelLeaseHeartbeat(state);
        }
      } catch (error) {
        state.lostOwnership = true;
        console.error("Pending moderation heartbeat failed:", {
          error,
          slipId: pendingModeration.slipId,
          workerId: this.workerId,
        });
        this.cancelLeaseHeartbeat(state);
      }
    };

    state.timer = setInterval(() => {
      if (state.stopped || state.inFlightExtension) {
        return;
      }

      state.inFlightExtension = extendLease().finally(() => {
        state.inFlightExtension = undefined;
      });
    }, this.heartbeatIntervalMs);

    this.activeHeartbeats.add(state);

    return {
      hasHealthyLease: () => !state.lostOwnership,
      stop: async () => {
        await this.stopLeaseHeartbeat(state);
      },
    };
  }

  private cancelLeaseHeartbeat(state: LeaseHeartbeatState): void {
    if (state.stopped) {
      return;
    }

    state.stopped = true;

    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }

    this.activeHeartbeats.delete(state);
  }

  private async stopLeaseHeartbeat(state: LeaseHeartbeatState): Promise<void> {
    this.cancelLeaseHeartbeat(state);

    if (state.inFlightExtension) {
      await state.inFlightExtension.catch(() => undefined);
    }
  }

  private async handleClaimedRecord(pendingModeration: any): Promise<void> {
    const heartbeat = this.startLeaseHeartbeat(pendingModeration);

    try {
      const outcome = await this.processor(
        toModerationEvent(pendingModeration),
        this.publishers
      );

      if (!heartbeat.hasHealthyLease()) {
        return;
      }

      if (outcome === "MISSING_AGGREGATE") {
        await this.requeueClaimedRecord(
          pendingModeration,
          buildMissingAggregateError()
        );
        return;
      }

      await this.completeClaimedRecord(pendingModeration);
    } catch (error) {
      if (!heartbeat.hasHealthyLease()) {
        return;
      }

      await this.requeueClaimedRecord(pendingModeration, sanitizeError(error));
    } finally {
      await heartbeat.stop();
    }
  }

  private async completeClaimedRecord(pendingModeration: any): Promise<void> {
    const result = await PendingModerationResult.deleteOne({
      _id: pendingModeration._id,
      leaseOwner: this.workerId,
      status: STATUS_PROCESSING,
    });

    if (result.deletedCount === 0) {
      console.error(
        "Pending moderation completion skipped after ownership loss:",
        {
          slipId: pendingModeration.slipId,
          workerId: this.workerId,
        }
      );
    }
  }

  private async requeueClaimedRecord(
    pendingModeration: any,
    lastError: PendingModerationError
  ): Promise<void> {
    const now = this.clock.now();
    const nextAttemptCount = Number(pendingModeration.attemptCount ?? 0) + 1;
    const ageMs = now.getTime() - new Date(pendingModeration.createdAt).getTime();
    const exhausted =
      nextAttemptCount >= this.maxAttempts || ageMs >= this.maxAgeMs;

    const result = await PendingModerationResult.updateOne(
      {
        _id: pendingModeration._id,
        leaseOwner: this.workerId,
        status: STATUS_PROCESSING,
      },
      {
        $set: {
          attemptCount: nextAttemptCount,
          exhaustedAt: exhausted ? now : null,
          lastError,
          leaseOwner: "",
          leasedUntil: null,
          nextAttemptAt: exhausted
            ? pendingModeration.nextAttemptAt
            : new Date(
              now.getTime()
                + computeBackoffMs(nextAttemptCount, {
                  baseBackoffMs: this.baseBackoffMs,
                  maxBackoffMs: this.maxBackoffMs,
                })
            ),
          status: exhausted ? STATUS_EXHAUSTED : STATUS_PENDING,
        },
      }
    );

    if (result.modifiedCount === 0) {
      console.error("Pending moderation requeue skipped after ownership loss:", {
        slipId: pendingModeration.slipId,
        workerId: this.workerId,
      });
      return;
    }

    if (exhausted) {
      console.error("Pending moderation record exhausted:", {
        attemptCount: nextAttemptCount,
        lastError: lastError.message,
        slipId: pendingModeration.slipId,
      });
    }
  }
}

export class PendingModerationReplayWorker {
  private publishers!: SettlementPublishers;
  private runner?: PendingModerationReplayRunner;

  constructor(
    private readonly connection: IAmqpConnection,
    private readonly processor: PendingModerationProcessor,
    private readonly options: PendingModerationReplayOptions = {}
  ) {}

  async init(): Promise<void> {
    this.publishers = await createSettlementPublishers(this.connection);
    this.runner = new PendingModerationReplayRunner(
      this.publishers,
      this.processor,
      this.options
    );
  }

  async start(): Promise<void> {
    if (!this.runner) {
      throw new Error(
        "PendingModerationReplayWorker must be initialised before starting"
      );
    }

    await this.runner.start();
  }

  async stop(): Promise<void> {
    if (!this.runner) {
      return;
    }

    await this.runner.stop();
  }

  async runOnce(): Promise<number> {
    if (!this.runner) {
      throw new Error(
        "PendingModerationReplayWorker must be initialised before running"
      );
    }

    return this.runner.runOnce();
  }
}

export async function recoverPendingModerationForSlip(
  slipId: string,
  publishers: SettlementPublishers,
  processor: PendingModerationProcessor,
  options: PendingModerationReplayOptions = {}
): Promise<boolean> {
  const runner = new PendingModerationReplayRunner(
    publishers,
    processor,
    options
  );

  try {
    return await runner.runOnceForSlip(slipId);
  } catch (error) {
    console.error("Pending moderation recovery failed:", {
      error,
      slipId,
    });
    return false;
  } finally {
    await runner.stop();
  }
}
