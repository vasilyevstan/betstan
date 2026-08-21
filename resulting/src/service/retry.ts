import {
  IAmqpConnection,
  IEventResultEvent,
  ILiveEventUpdateEvent,
  IModerationResultEvent,
  IPlaceBetEvent,
} from "@betstan/common";
import SettleSlipPublisher from "../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../event/publisher/SettleSlipRowPublisher";
import RetryRecord, {
  RetryRecordKind,
  RetryRecordStatus,
} from "../model/RetryRecord";
import {
  SettlementPublishers,
  applyModerationResult,
  processFinalScore,
  processLiveUpdate,
  upsertPlaceBet,
} from "./resulting";
import {
  buildRetryPayloadStorage,
  MAX_RETRY_ERROR_MESSAGE_BYTES,
  MAX_RETRY_ERROR_NAME_BYTES,
  MAX_RETRY_ERROR_STACK_BYTES,
  MAX_RETRY_PAYLOAD_BYTES,
  sanitizeRetryStack,
  sanitizeRetryText,
} from "./retryRetention";

export interface RetryDescriptor<TPayload = unknown> {
  identity: string;
  kind: RetryRecordKind;
  listenerServiceName: string;
  payload: TPayload;
}

export interface RetryClock {
  now(): Date;
}

export interface RetryWorkerOptions {
  baseBackoffMs?: number;
  batchSize?: number;
  clock?: RetryClock;
  heartbeatIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  maxBackoffMs?: number;
  pollIntervalMs?: number;
  workerId?: string;
}

const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_LEASE_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const STATUS_COMPLETED: RetryRecordStatus = "COMPLETED";
const STATUS_DEAD_LETTER: RetryRecordStatus = "DEAD_LETTER";
const STATUS_PENDING: RetryRecordStatus = "PENDING";
const STATUS_PROCESSING: RetryRecordStatus = "PROCESSING";
const RETRY_PAYLOAD_TOO_LARGE_ERROR_NAME = "RetryPayloadTooLargeError";
const defaultClock: RetryClock = {
  now: () => new Date(),
};

interface ErrorMetadata {
  lastErrorAt: Date;
  lastErrorMessage: string;
  lastErrorName: string;
  lastErrorStack: string;
}

interface TerminalPayloadRetention {
  payloadByteCount: number;
  payloadHash: string;
  payloadSummary: unknown;
}

interface LeaseHeartbeat {
  hasHealthyLease(): boolean;
  stop(): Promise<void>;
}

interface LeaseHeartbeatState {
  inFlightExtension?: Promise<void>;
  lostOwnership: boolean;
  recordId: string;
  stopped: boolean;
  timer?: NodeJS.Timeout;
  workerId: string;
}

export function retryIdentityForPlaceBet(event: IPlaceBetEvent): string {
  return event.data.slipId;
}

export function retryIdentityForModerationResult(
  event: IModerationResultEvent
): string {
  return event.data.slipId;
}

export function retryIdentityForEventResult(event: IEventResultEvent): string {
  return event.data.eventId;
}

export function retryIdentityForLiveEventUpdate(
  event: ILiveEventUpdateEvent
): string {
  return `${event.data.eventId}:${event.data.sequence}`;
}

export function buildRetryKey(
  kind: RetryRecordKind,
  identity: string
): string {
  return `${kind}:${identity}`;
}

export function computeRetryBackoffMs(
  attemptCount: number,
  {
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  }: Pick<RetryWorkerOptions, "baseBackoffMs" | "maxBackoffMs"> = {}
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

function toErrorMetadata(error: unknown, now: Date): ErrorMetadata {
  if (error instanceof Error) {
    return {
      lastErrorAt: now,
      lastErrorMessage: sanitizeRetryText(error.message, {
        maxBytes: MAX_RETRY_ERROR_MESSAGE_BYTES,
      }),
      lastErrorName: sanitizeRetryText(error.name, {
        maxBytes: MAX_RETRY_ERROR_NAME_BYTES,
      }),
      lastErrorStack: sanitizeRetryStack(error.stack ?? ""),
    };
  }

  return {
    lastErrorAt: now,
    lastErrorMessage: sanitizeRetryText(error, {
      maxBytes: MAX_RETRY_ERROR_MESSAGE_BYTES,
    }),
    lastErrorName: "Error",
    lastErrorStack: sanitizeRetryText(error, {
      maxBytes: MAX_RETRY_ERROR_STACK_BYTES,
      preserveNewlines: true,
    }),
  };
}

function buildOversizedPayloadErrorMetadata(
  byteCount: number,
  now: Date
): ErrorMetadata {
  return {
    lastErrorAt: now,
    lastErrorMessage: `Retry payload exceeds ${MAX_RETRY_PAYLOAD_BYTES} byte limit (${byteCount} bytes)`,
    lastErrorName: RETRY_PAYLOAD_TOO_LARGE_ERROR_NAME,
    lastErrorStack: "",
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: number }).code === 11000;
}

async function fetchRetryRecordByKey(key: string): Promise<any> {
  return RetryRecord.findOne({ key });
}

function getTerminalPayloadRetention(
  retryRecord: any
): TerminalPayloadRetention {
  if (
    retryRecord.payloadSummary
    && retryRecord.payloadHash
    && typeof retryRecord.payloadByteCount === "number"
  ) {
    return {
      payloadByteCount: retryRecord.payloadByteCount,
      payloadHash: retryRecord.payloadHash,
      payloadSummary: retryRecord.payloadSummary,
    };
  }

  const payloadStorage = buildRetryPayloadStorage({
    kind: retryRecord.kind as RetryRecordKind,
    payload: retryRecord.payload,
  });

  return {
    payloadByteCount: payloadStorage.byteCount,
    payloadHash: payloadStorage.hash,
    payloadSummary: payloadStorage.summary,
  };
}

export async function parkFailedEvent<TPayload>(
  descriptor: RetryDescriptor<TPayload>,
  error: unknown,
  {
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    clock = defaultClock,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  }: Pick<RetryWorkerOptions, "baseBackoffMs" | "clock" | "maxBackoffMs"> = {}
): Promise<any> {
  const now = clock.now();
  const key = buildRetryKey(descriptor.kind, descriptor.identity);
  const payloadStorage = buildRetryPayloadStorage({
    kind: descriptor.kind,
    payload: descriptor.payload,
  });
  const metadata = payloadStorage.isOversized
    ? buildOversizedPayloadErrorMetadata(payloadStorage.byteCount, now)
    : toErrorMetadata(error, now);
  const existingRecord = await fetchRetryRecordByKey(key);

  if (existingRecord) {
    if (
      existingRecord.status === STATUS_COMPLETED
      || existingRecord.status === STATUS_DEAD_LETTER
    ) {
      return existingRecord;
    }

    await RetryRecord.updateOne(
      {
        _id: existingRecord._id,
        status: {
          $in: [STATUS_PENDING, STATUS_PROCESSING],
        },
      },
      {
        $set: {
          listenerServiceName: descriptor.listenerServiceName,
          ...(payloadStorage.isOversized
            ? {}
            : {
              payload: payloadStorage.payload,
              payloadByteCount: payloadStorage.byteCount,
              payloadHash: payloadStorage.hash,
              payloadSummary: payloadStorage.summary,
            }),
          ...metadata,
        },
      }
    );

    return fetchRetryRecordByKey(key);
  }

  try {
    return await RetryRecord.create({
      attemptCount: 1,
      deadLetteredAt: payloadStorage.isOversized ? now : null,
      identity: descriptor.identity,
      key,
      kind: descriptor.kind,
      listenerServiceName: descriptor.listenerServiceName,
      nextAttemptAt: payloadStorage.isOversized
        ? now
        : new Date(
          now.getTime()
            + computeRetryBackoffMs(1, { baseBackoffMs, maxBackoffMs })
        ),
      payload: payloadStorage.payload,
      payloadByteCount: payloadStorage.byteCount,
      payloadHash: payloadStorage.hash,
      payloadSummary: payloadStorage.summary,
      status: payloadStorage.isOversized ? STATUS_DEAD_LETTER : STATUS_PENDING,
      ...metadata,
    });
  } catch (parkingError) {
    if (!isDuplicateKeyError(parkingError)) {
      throw parkingError;
    }

    const retryRecord = await fetchRetryRecordByKey(key);

    if (!retryRecord) {
      throw parkingError;
    }

    return retryRecord;
  }
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

async function processRetryRecord(
  retryRecord: any,
  publishers: SettlementPublishers
): Promise<void> {
  if (retryRecord.payload === undefined || retryRecord.payload === null) {
    throw new Error("Retry payload is unavailable");
  }

  switch (retryRecord.kind as RetryRecordKind) {
    case "PLACE_BET":
      await upsertPlaceBet(retryRecord.payload as IPlaceBetEvent, publishers);
      return;
    case "MODERATION_RESULT":
      await applyModerationResult(
        retryRecord.payload as IModerationResultEvent,
        publishers
      );
      return;
    case "EVENT_RESULT":
      await processFinalScore(
        retryRecord.payload as IEventResultEvent,
        publishers
      );
      return;
    case "LIVE_EVENT_UPDATE":
      await processLiveUpdate(
        retryRecord.payload as ILiveEventUpdateEvent,
        publishers
      );
      return;
    default:
      throw new Error(`Unsupported retry record kind: ${retryRecord.kind}`);
  }
}

export class RetryWorker {
  private readonly baseBackoffMs: number;
  private readonly batchSize: number;
  private readonly clock: RetryClock;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly maxBackoffMs: number;
  private readonly pollIntervalMs: number;
  private readonly workerId: string;

  private activeHeartbeats = new Set<LeaseHeartbeatState>();
  private inFlightRun?: Promise<number>;
  private interval?: NodeJS.Timeout;
  private publishers!: SettlementPublishers;
  private started = false;
  private stopped = false;

  constructor(
    private readonly connection: IAmqpConnection,
    options: RetryWorkerOptions = {}
  ) {
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.clock = options.clock ?? defaultClock;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatIntervalMs = computeHeartbeatIntervalMs(
      this.leaseMs,
      options.heartbeatIntervalMs
    );
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.workerId =
      options.workerId
      ?? `resulting-retry-${Math.random().toString(36).slice(2, 10)}`;
  }

  async init(): Promise<void> {
    this.publishers = await createSettlementPublishers(this.connection);
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
    if (!this.publishers) {
      throw new Error("RetryWorker must be initialised before running");
    }

    let processed = 0;

    for (let index = 0; index < this.batchSize; index += 1) {
      const retryRecord = await this.claimNextDueRecord();

      if (!retryRecord) {
        break;
      }

      await this.handleClaimedRecord(retryRecord);
      processed += 1;
    }

    return processed;
  }

  private async triggerRun(): Promise<number> {
    return this.executeTrackedRun(true);
  }

  private async executeTrackedRun(swallowErrors: boolean): Promise<number> {
    if (!this.inFlightRun) {
      const runPromise = this.runOnce();

      this.inFlightRun = (swallowErrors
        ? runPromise.catch((error) => {
          console.error("RetryWorker run failed:", error);
          return 0;
        })
        : runPromise
      ).finally(() => {
        this.inFlightRun = undefined;
      });
    }

    return this.inFlightRun;
  }

  private async claimNextDueRecord(): Promise<any | null> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);

    return RetryRecord.findOneAndUpdate(
      {
        nextAttemptAt: {
          $lte: now,
        },
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

  private startLeaseHeartbeat(retryRecord: any): LeaseHeartbeat {
    const state: LeaseHeartbeatState = {
      lostOwnership: false,
      recordId: String(retryRecord._id),
      stopped: false,
      workerId: this.workerId,
    };

    const extendLease = async (): Promise<void> => {
      if (state.stopped || state.lostOwnership) {
        return;
      }

      const now = this.clock.now();
      const leaseUntil = new Date(now.getTime() + this.leaseMs);

      try {
        const result = await RetryRecord.updateOne(
          {
            _id: retryRecord._id,
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
          console.error("Retry record heartbeat lost ownership:", {
            key: retryRecord.key,
            workerId: this.workerId,
          });
          this.cancelLeaseHeartbeat(state);
        }
      } catch (error) {
        state.lostOwnership = true;
        console.error("Retry record heartbeat failed:", {
          error,
          key: retryRecord.key,
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

  private async handleClaimedRecord(retryRecord: any): Promise<void> {
    const heartbeat = this.startLeaseHeartbeat(retryRecord);

    try {
      await processRetryRecord(retryRecord, this.publishers);

      if (!heartbeat.hasHealthyLease()) {
        return;
      }

      await this.completeClaimedRecord(retryRecord);
    } catch (error) {
      if (!heartbeat.hasHealthyLease()) {
        return;
      }

      await this.requeueClaimedRecord(retryRecord, error);
    } finally {
      await heartbeat.stop();
    }
  }

  private async completeClaimedRecord(retryRecord: any): Promise<void> {
    const payloadRetention = getTerminalPayloadRetention(retryRecord);
    const result = await RetryRecord.updateOne(
      {
        _id: retryRecord._id,
        leaseOwner: this.workerId,
        status: STATUS_PROCESSING,
      },
      {
        $set: {
          completedAt: this.clock.now(),
          lastErrorAt: null,
          lastErrorMessage: "",
          lastErrorName: "",
          lastErrorStack: "",
          leaseOwner: "",
          leasedUntil: null,
          payloadByteCount: payloadRetention.payloadByteCount,
          payloadHash: payloadRetention.payloadHash,
          payloadSummary: payloadRetention.payloadSummary,
          status: STATUS_COMPLETED,
        },
        $unset: {
          payload: 1,
        },
      }
    );

    if (result.modifiedCount === 0) {
      console.error("Retry record completion skipped after ownership loss:", {
        key: retryRecord.key,
        workerId: this.workerId,
      });
    }
  }

  private async requeueClaimedRecord(
    retryRecord: any,
    error: unknown
  ): Promise<void> {
    const now = this.clock.now();
    const nextAttemptCount = Number(retryRecord.attemptCount ?? 0) + 1;
    const metadata = toErrorMetadata(error, now);
    const exhausted = nextAttemptCount >= this.maxAttempts;
    const payloadRetention = exhausted
      ? getTerminalPayloadRetention(retryRecord)
      : undefined;

    const result = await RetryRecord.updateOne(
      {
        _id: retryRecord._id,
        leaseOwner: this.workerId,
        status: STATUS_PROCESSING,
      },
      {
        $set: {
          ...metadata,
          attemptCount: nextAttemptCount,
          deadLetteredAt: exhausted ? now : null,
          leaseOwner: "",
          leasedUntil: null,
          nextAttemptAt: exhausted
            ? retryRecord.nextAttemptAt
            : new Date(
              now.getTime()
                + computeRetryBackoffMs(nextAttemptCount, {
                  baseBackoffMs: this.baseBackoffMs,
                  maxBackoffMs: this.maxBackoffMs,
                })
            ),
          ...(payloadRetention
            ? {
              payloadByteCount: payloadRetention.payloadByteCount,
              payloadHash: payloadRetention.payloadHash,
              payloadSummary: payloadRetention.payloadSummary,
            }
            : {}),
          status: exhausted ? STATUS_DEAD_LETTER : STATUS_PENDING,
        },
        ...(exhausted
          ? {
            $unset: {
              payload: 1,
            },
          }
          : {}),
      }
    );

    if (result.modifiedCount === 0) {
      console.error("Retry record requeue skipped after ownership loss:", {
        key: retryRecord.key,
        workerId: this.workerId,
      });
      return;
    }

    if (exhausted) {
      console.error("Retry record exhausted:", {
        attemptCount: nextAttemptCount,
        identity: retryRecord.identity,
        key: retryRecord.key,
        kind: retryRecord.kind,
        lastErrorMessage: metadata.lastErrorMessage,
      });
    }
  }
}
