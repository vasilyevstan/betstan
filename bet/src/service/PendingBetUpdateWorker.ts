import { randomBytes } from "crypto";
import { FilterQuery } from "mongoose";
import { Bet } from "../model/Bet";
import {
  PendingBetUpdate,
  PendingBetUpdateDocument,
  PendingBetUpdateRecord,
  PendingBetUpdateStatus,
} from "../model/PendingBetUpdate";
import {
  applyPendingBetUpdatesToBet,
  loadOwnedPendingBetUpdates,
  sanitizePendingBetUpdateError,
} from "./betHistory";

export const DEFAULT_PENDING_UPDATE_BATCH_SIZE = 25;
export const DEFAULT_PENDING_UPDATE_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_PENDING_UPDATE_LEASE_MS = 30_000;
export const DEFAULT_PENDING_UPDATE_BACKOFF_BASE_MS = 5_000;
export const DEFAULT_PENDING_UPDATE_BACKOFF_MAX_MS = 300_000;
export const DEFAULT_PENDING_UPDATE_MAX_ATTEMPTS = 8;
export const DEFAULT_PENDING_UPDATE_MAX_AGE_MS = 21_600_000;

type TimerHandle = ReturnType<typeof setTimeout> | number | unknown;
type PendingBetUpdateId = PendingBetUpdateDocument["_id"];

const CLAIM_SORT = {
  createdAt: 1 as const,
  nextAttemptAt: 1 as const,
  _id: 1 as const,
};
const MIN_HEARTBEAT_INTERVAL_MS = 100;

interface ClaimedPendingBetUpdateBatch {
  claimedAt: Date;
  pendingUpdateIds: PendingBetUpdateId[];
  slipId: string;
}

interface PendingBetUpdateLeaseHeartbeat {
  hasOwnership(): boolean;
  refreshOwnership(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface PendingBetUpdateWorkerClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface PendingBetUpdateWorkerLogger {
  error: (...args: unknown[]) => void;
}

export interface PendingBetUpdateWorkerConfig {
  batchSize?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxAttempts?: number;
  maxAgeMs?: number;
  leaseOwner?: string;
  clock?: PendingBetUpdateWorkerClock;
  logger?: PendingBetUpdateWorkerLogger;
}

const defaultClock: PendingBetUpdateWorkerClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultLogger: PendingBetUpdateWorkerLogger = {
  error: (...args: unknown[]) => console.error(...args),
};

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const createLeaseOwner = () =>
  `bet-pending-worker:${process.pid}:${randomBytes(4).toString("hex")}`;

const buildClaimablePendingClauses = (
  now: Date,
  includeFuturePending: boolean
): FilterQuery<PendingBetUpdateRecord>[] => [
  includeFuturePending
    ? {
        status: PendingBetUpdateStatus.PENDING,
      }
    : {
        status: PendingBetUpdateStatus.PENDING,
        $or: [
          {
            nextAttemptAt: {
              $lte: now,
            },
          },
          {
            nextAttemptAt: {
              $exists: false,
            },
          },
        ],
      },
  includeFuturePending
    ? {
        status: {
          $exists: false,
        },
      }
    : {
        status: {
          $exists: false,
        },
        $or: [
          {
            nextAttemptAt: {
              $lte: now,
            },
          },
          {
            nextAttemptAt: {
              $exists: false,
            },
          },
        ],
      },
  {
    status: PendingBetUpdateStatus.PROCESSING,
    $or: [
      {
        leaseUntil: {
          $lte: now,
        },
      },
      {
        leaseUntil: {
          $exists: false,
        },
      },
    ],
  },
];

const buildClaimableFilter = (
  now: Date,
  includeFuturePending: boolean,
  slipId?: string
): FilterQuery<PendingBetUpdateRecord> => ({
  ...(slipId
    ? {
        slipId,
      }
    : {}),
  $or: buildClaimablePendingClauses(now, includeFuturePending),
});

const buildOwnedProcessingFilter = (
  pendingUpdateIds: PendingBetUpdateId[],
  leaseOwner: string
): FilterQuery<PendingBetUpdateRecord> => ({
  _id: {
    $in: pendingUpdateIds,
  },
  leaseOwner,
  status: PendingBetUpdateStatus.PROCESSING,
});

const buildClaimUpdate = (
  leaseOwner: string,
  now: Date,
  leaseUntil: Date
) => ({
  $inc: {
    attemptCount: 1,
  },
  $set: {
    lastAttemptAt: now,
    leaseOwner,
    leaseUntil,
    status: PendingBetUpdateStatus.PROCESSING,
  },
  $unset: {
    exhaustedAt: 1,
  },
});

let registeredPendingBetUpdateWorker: PendingBetUpdateWorker | null = null;

export const registerPendingBetUpdateWorker = (
  worker: PendingBetUpdateWorker | null
) => {
  registeredPendingBetUpdateWorker = worker;
};

export const requestPendingBetUpdateReplay = async (slipId: string) => {
  const worker = registeredPendingBetUpdateWorker ?? new PendingBetUpdateWorker();
  await worker.runNowForSlip(slipId);
};

export const createPendingBetUpdateWorkerConfigFromEnv = (
  overrides: PendingBetUpdateWorkerConfig = {}
): Required<PendingBetUpdateWorkerConfig> => ({
  batchSize:
    overrides.batchSize
    ?? parsePositiveInteger(
      process.env.BET_PENDING_UPDATE_BATCH_SIZE,
      DEFAULT_PENDING_UPDATE_BATCH_SIZE
    ),
  pollIntervalMs:
    overrides.pollIntervalMs
    ?? parsePositiveInteger(
      process.env.BET_PENDING_UPDATE_POLL_INTERVAL_MS,
      DEFAULT_PENDING_UPDATE_POLL_INTERVAL_MS
    ),
  leaseMs:
    overrides.leaseMs
    ?? parsePositiveInteger(
      process.env.BET_PENDING_UPDATE_LEASE_MS,
      DEFAULT_PENDING_UPDATE_LEASE_MS
    ),
  backoffBaseMs:
    overrides.backoffBaseMs
    ?? parsePositiveInteger(
      process.env.BET_PENDING_UPDATE_BACKOFF_BASE_MS,
      DEFAULT_PENDING_UPDATE_BACKOFF_BASE_MS
    ),
  backoffMaxMs:
    overrides.backoffMaxMs
    ?? parsePositiveInteger(
      process.env.BET_PENDING_UPDATE_BACKOFF_MAX_MS,
      DEFAULT_PENDING_UPDATE_BACKOFF_MAX_MS
    ),
  maxAttempts:
    overrides.maxAttempts
    ?? parsePositiveInteger(
      process.env.BET_PENDING_UPDATE_MAX_ATTEMPTS,
      DEFAULT_PENDING_UPDATE_MAX_ATTEMPTS
    ),
  maxAgeMs:
    overrides.maxAgeMs
    ?? parsePositiveInteger(
      process.env.BET_PENDING_UPDATE_MAX_AGE_MS,
      DEFAULT_PENDING_UPDATE_MAX_AGE_MS
    ),
  leaseOwner: overrides.leaseOwner ?? createLeaseOwner(),
  clock: overrides.clock ?? defaultClock,
  logger: overrides.logger ?? defaultLogger,
});

export class PendingBetUpdateWorker {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxAttempts: number;
  private readonly maxAgeMs: number;
  private readonly leaseOwner: string;
  private readonly clock: PendingBetUpdateWorkerClock;
  private readonly logger: PendingBetUpdateWorkerLogger;
  private readonly requestedSlipIds = new Set<string>();
  private runningPromise: Promise<void> | null = null;
  private started = false;
  private stopRequested = false;
  private timer: TimerHandle | null = null;

  constructor(config: PendingBetUpdateWorkerConfig = {}) {
    const resolvedConfig = createPendingBetUpdateWorkerConfigFromEnv(config);
    this.batchSize = resolvedConfig.batchSize;
    this.pollIntervalMs = resolvedConfig.pollIntervalMs;
    this.leaseMs = resolvedConfig.leaseMs;
    this.backoffBaseMs = resolvedConfig.backoffBaseMs;
    this.backoffMaxMs = resolvedConfig.backoffMaxMs;
    this.maxAttempts = resolvedConfig.maxAttempts;
    this.maxAgeMs = resolvedConfig.maxAgeMs;
    this.leaseOwner = resolvedConfig.leaseOwner;
    this.clock = resolvedConfig.clock;
    this.logger = resolvedConfig.logger;
  }

  getLeaseOwner() {
    return this.leaseOwner;
  }

  async start() {
    if (this.started) {
      await this.waitForIdle();
      return;
    }

    this.started = true;
    this.stopRequested = false;
    registerPendingBetUpdateWorker(this);

    try {
      await this.runNow();
    } catch (error) {
      this.started = false;
      this.stopRequested = true;
      this.clearScheduledRun();

      if (registeredPendingBetUpdateWorker === this) {
        registerPendingBetUpdateWorker(null);
      }

      throw error;
    }
  }

  async stop() {
    this.started = false;
    this.stopRequested = true;
    this.requestedSlipIds.clear();
    this.clearScheduledRun();
    await this.waitForIdle();

    if (registeredPendingBetUpdateWorker === this) {
      registerPendingBetUpdateWorker(null);
    }
  }

  async waitForIdle() {
    await (this.runningPromise ?? Promise.resolve());
  }

  async runNow() {
    if (this.stopRequested) {
      await this.waitForIdle();
      return;
    }

    if (this.runningPromise) {
      await this.runningPromise;
      return;
    }

    this.runningPromise = this.processWorkLoop().finally(() => {
      const shouldContinueImmediately =
        !this.stopRequested && this.requestedSlipIds.size > 0;

      this.runningPromise = null;

      if (shouldContinueImmediately) {
        void this.runNow().catch((error) => {
          this.logger.error("PendingBetUpdateWorker replay run failed", error);
        });
        return;
      }

      if (this.started && !this.stopRequested) {
        this.scheduleNextRun();
      }
    });

    await this.runningPromise;
  }

  async runNowForSlip(slipId: string) {
    if (this.stopRequested) {
      await this.waitForIdle();
      return;
    }

    while (!this.stopRequested) {
      this.requestedSlipIds.add(slipId);
      await this.runNow();

      // Only keep draining immediately while work is actually due now. A
      // pending update that just got rescheduled with a backoff delay must
      // not be reclaimed again here - the scheduled poll loop honors
      // nextAttemptAt, whereas this replay loop otherwise ignores it and
      // would burn through every retry attempt instantly.
      if (!(await this.hasClaimablePendingUpdatesForSlip(slipId, false))) {
        return;
      }
    }
  }

  private scheduleNextRun() {
    if (!this.started || this.stopRequested) {
      return;
    }

    this.clearScheduledRun();
    this.timer = this.clock.setTimeout(() => {
      void this.runNow().catch((error) => {
        this.logger.error("PendingBetUpdateWorker scheduled run failed", error);
      });
    }, this.pollIntervalMs);
  }

  private clearScheduledRun() {
    if (this.timer === null) {
      return;
    }

    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private dequeueRequestedSlipId() {
    const nextValue = this.requestedSlipIds.values().next();
    if (nextValue.done) {
      return null;
    }

    this.requestedSlipIds.delete(nextValue.value);
    return nextValue.value;
  }

  private async processWorkLoop() {
    let remainingBatchSlots = this.batchSize;

    while (!this.stopRequested && remainingBatchSlots > 0) {
      const requestedSlipId = this.dequeueRequestedSlipId();

      if (requestedSlipId) {
        const claimedBatch = await this.claimPendingUpdatesForSlip(
          requestedSlipId,
          true,
          undefined,
          remainingBatchSlots
        );

        if (claimedBatch) {
          remainingBatchSlots -= claimedBatch.pendingUpdateIds.length;
          await this.processClaimedBatch(claimedBatch);
        }

        continue;
      }

      const claimedBatch = await this.claimNextDueBatch(remainingBatchSlots);

      if (!claimedBatch) {
        return;
      }

      remainingBatchSlots -= claimedBatch.pendingUpdateIds.length;
      await this.processClaimedBatch(claimedBatch);
    }
  }

  private async claimNextDueBatch(maxPendingUpdates: number) {
    const now = this.clock.now();
    const nextDuePendingUpdate = await PendingBetUpdate.findOne(
      buildClaimableFilter(now, false)
    )
      .sort(CLAIM_SORT)
      .select({
        slipId: 1,
      })
      .lean();

    if (!nextDuePendingUpdate) {
      return null;
    }

    return this.claimPendingUpdatesForSlip(
      nextDuePendingUpdate.slipId,
      false,
      now,
      maxPendingUpdates
    );
  }

  private async claimPendingUpdatesForSlip(
    slipId: string,
    includeFuturePending: boolean,
    now: Date = this.clock.now(),
    maxPendingUpdates: number = this.batchSize
  ): Promise<ClaimedPendingBetUpdateBatch | null> {
    const claimableFilter = buildClaimableFilter(
      now,
      includeFuturePending,
      slipId
    );
    const candidatePendingUpdates = await PendingBetUpdate.find(claimableFilter)
      .sort(CLAIM_SORT)
      .limit(maxPendingUpdates)
      .select({
        _id: 1,
      })
      .lean();

    if (candidatePendingUpdates.length === 0) {
      return null;
    }

    const pendingUpdateIds = candidatePendingUpdates.map(
      (candidatePendingUpdate) => candidatePendingUpdate._id
    );
    const leaseUntil = new Date(now.getTime() + this.leaseMs);

    await PendingBetUpdate.updateMany(
      {
        _id: {
          $in: pendingUpdateIds,
        },
        ...claimableFilter,
      },
      buildClaimUpdate(this.leaseOwner, now, leaseUntil)
    );

    const claimedPendingUpdates = await PendingBetUpdate.find(
      buildOwnedProcessingFilter(pendingUpdateIds, this.leaseOwner)
    )
      .sort(CLAIM_SORT)
      .select({
        _id: 1,
      })
      .lean();

    if (claimedPendingUpdates.length === 0) {
      return null;
    }

    return {
      claimedAt: now,
      pendingUpdateIds: claimedPendingUpdates.map(
        (claimedPendingUpdate) => claimedPendingUpdate._id
      ),
      slipId,
    };
  }

  private async hasClaimablePendingUpdatesForSlip(
    slipId: string,
    includeFuturePending: boolean
  ) {
    const now = this.clock.now();
    const pendingUpdate = await PendingBetUpdate.findOne(
      buildClaimableFilter(now, includeFuturePending, slipId)
    )
      .select({
        _id: 1,
      })
      .lean();

    return Boolean(pendingUpdate);
  }

  private async processClaimedBatch({
    claimedAt,
    pendingUpdateIds,
    slipId,
  }: ClaimedPendingBetUpdateBatch) {
    const leaseHeartbeat = this.createLeaseHeartbeat(pendingUpdateIds);

    try {
      const pendingUpdates = await loadOwnedPendingBetUpdates(
        pendingUpdateIds,
        this.leaseOwner
      );

      if (pendingUpdates.length !== pendingUpdateIds.length) {
        return;
      }

      const bet = await Bet.findOne({ slipId });

      if (!bet) {
        if (!(await leaseHeartbeat.refreshOwnership())) {
          return;
        }

        await this.handleFailedPendingUpdates(
          pendingUpdates,
          claimedAt,
          "Bet aggregate is not available yet"
        );
        return;
      }

      const applyResult = await applyPendingBetUpdatesToBet(bet, pendingUpdates, {
        beforeApply: async () => leaseHeartbeat.refreshOwnership(),
      });

      if (applyResult.ownershipLost || !leaseHeartbeat.hasOwnership()) {
        return;
      }

      await this.deleteOwnedPendingBetUpdates(
        applyResult.processedPendingUpdates.map(
          (processedPendingUpdate) => processedPendingUpdate._id
        )
      );
    } catch (error) {
      this.logger.error(
        `PendingBetUpdateWorker failed for slip ${slipId}`,
        error
      );

      const pendingUpdates = await loadOwnedPendingBetUpdates(
        pendingUpdateIds,
        this.leaseOwner
      );

      if (pendingUpdates.length === 0 || !(await leaseHeartbeat.refreshOwnership())) {
        return;
      }

      await this.handleFailedPendingUpdates(pendingUpdates, this.clock.now(), error);
    } finally {
      await leaseHeartbeat.stop();
    }
  }

  private createLeaseHeartbeat(
    pendingUpdateIds: PendingBetUpdateId[]
  ): PendingBetUpdateLeaseHeartbeat {
    const heartbeatIntervalMs = Math.max(
      MIN_HEARTBEAT_INTERVAL_MS,
      Math.floor(this.leaseMs / 2)
    );
    let heartbeatPromise: Promise<boolean> | null = null;
    let heartbeatTimer: TimerHandle | null = null;
    let ownershipLost = false;
    let stopped = false;

    const extendLease = async () => {
      const now = this.clock.now();
      const result = await PendingBetUpdate.updateMany(
        buildOwnedProcessingFilter(pendingUpdateIds, this.leaseOwner),
        {
          $set: {
            leaseUntil: new Date(now.getTime() + this.leaseMs),
          },
        }
      );

      if (result.matchedCount !== pendingUpdateIds.length) {
        ownershipLost = true;
        stopped = true;
        return false;
      }

      return true;
    };

    const runHeartbeat = () => {
      if (stopped || ownershipLost) {
        return;
      }

      heartbeatTimer = this.clock.setTimeout(() => {
        heartbeatPromise = extendLease()
          .catch((error) => {
            ownershipLost = true;
            stopped = true;
            this.logger.error("PendingBetUpdateWorker heartbeat failed", error);
            return false;
          })
          .finally(() => {
            heartbeatPromise = null;

            if (!stopped && !ownershipLost) {
              runHeartbeat();
            }
          });
      }, heartbeatIntervalMs);
    };

    runHeartbeat();

    return {
      hasOwnership: () => !ownershipLost,
      refreshOwnership: async () => {
        if (ownershipLost || stopped) {
          return false;
        }

        if (heartbeatTimer !== null) {
          this.clock.clearTimeout(heartbeatTimer);
          heartbeatTimer = null;
        }

        if (heartbeatPromise) {
          await heartbeatPromise;

          if (ownershipLost || stopped) {
            return false;
          }
        }

        const ownsLease = await extendLease().catch((error) => {
          ownershipLost = true;
          stopped = true;
          this.logger.error("PendingBetUpdateWorker ownership refresh failed", error);
          return false;
        });

        if (!stopped && !ownershipLost) {
          runHeartbeat();
        }

        return ownsLease;
      },
      stop: async () => {
        stopped = true;

        if (heartbeatTimer !== null) {
          this.clock.clearTimeout(heartbeatTimer);
          heartbeatTimer = null;
        }

        if (heartbeatPromise) {
          await heartbeatPromise;
        }
      },
    };
  }

  private async deleteOwnedPendingBetUpdates(
    pendingUpdateIds: PendingBetUpdateId[]
  ) {
    if (pendingUpdateIds.length === 0) {
      return;
    }

    await PendingBetUpdate.deleteMany(
      buildOwnedProcessingFilter(pendingUpdateIds, this.leaseOwner)
    );
  }

  private async handleFailedPendingUpdates(
    pendingUpdates: PendingBetUpdateDocument[],
    now: Date,
    reason: unknown
  ) {
    if (pendingUpdates.length === 0) {
      return;
    }

    const sanitizedReason = sanitizePendingBetUpdateError(reason);
    const updatesToReschedule: PendingBetUpdateDocument[] = [];
    const updatesToExhaust: PendingBetUpdateDocument[] = [];

    for (const pendingUpdate of pendingUpdates) {
      if (this.shouldExhaustPendingUpdate(pendingUpdate, now)) {
        updatesToExhaust.push(pendingUpdate);
      } else {
        updatesToReschedule.push(pendingUpdate);
      }
    }

    if (updatesToReschedule.length > 0) {
      await PendingBetUpdate.bulkWrite(
        updatesToReschedule.map((pendingUpdate) => ({
          updateOne: {
            filter: {
              _id: pendingUpdate._id,
              leaseOwner: this.leaseOwner,
              status: PendingBetUpdateStatus.PROCESSING,
            },
            update: {
              $set: {
                lastAttemptAt: now,
                lastError: sanitizedReason,
                nextAttemptAt: new Date(
                  now.getTime() + this.resolveBackoffDelayMs(pendingUpdate)
                ),
                status: PendingBetUpdateStatus.PENDING,
              },
              $unset: {
                exhaustedAt: 1,
                leaseOwner: 1,
                leaseUntil: 1,
              },
            },
          },
        }))
      );
    }

    if (updatesToExhaust.length > 0) {
      await PendingBetUpdate.bulkWrite(
        updatesToExhaust.map((pendingUpdate) => ({
          updateOne: {
            filter: {
              _id: pendingUpdate._id,
              leaseOwner: this.leaseOwner,
              status: PendingBetUpdateStatus.PROCESSING,
            },
            update: {
              $set: {
                exhaustedAt: now,
                lastAttemptAt: now,
                lastError: this.resolveExhaustedReason(
                  pendingUpdate,
                  now,
                  sanitizedReason
                ),
                nextAttemptAt: now,
                status: PendingBetUpdateStatus.EXHAUSTED,
              },
              $unset: {
                leaseOwner: 1,
                leaseUntil: 1,
              },
            },
          },
        }))
      );
    }
  }

  private shouldExhaustPendingUpdate(
    pendingUpdate: PendingBetUpdateDocument,
    now: Date
  ) {
    return (
      this.hasReachedMaxAttempts(pendingUpdate)
      || this.hasExceededMaxAge(pendingUpdate, now)
    );
  }

  private hasReachedMaxAttempts(pendingUpdate: PendingBetUpdateDocument) {
    return pendingUpdate.attemptCount >= this.maxAttempts;
  }

  private hasExceededMaxAge(
    pendingUpdate: PendingBetUpdateDocument,
    now: Date
  ) {
    const createdAtTime = pendingUpdate.createdAt?.getTime() ?? now.getTime();
    return now.getTime() - createdAtTime >= this.maxAgeMs;
  }

  private resolveBackoffDelayMs(pendingUpdate: PendingBetUpdateDocument) {
    const exponent = Math.max(0, pendingUpdate.attemptCount - 1);
    return Math.min(this.backoffBaseMs * 2 ** exponent, this.backoffMaxMs);
  }

  private resolveExhaustedReason(
    pendingUpdate: PendingBetUpdateDocument,
    now: Date,
    sanitizedReason: string
  ) {
    if (this.hasExceededMaxAge(pendingUpdate, now)) {
      return sanitizePendingBetUpdateError(
        `Pending bet update exceeded max age: ${sanitizedReason}`
      );
    }

    return sanitizePendingBetUpdateError(
      `Pending bet update exceeded max attempts: ${sanitizedReason}`
    );
  }
}
