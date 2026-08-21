import { randomUUID } from "crypto";
import ModerationService, {
  ParkedPlaceBetRecord,
  ParkedReplayRescheduleOptions,
  PlaceBetProcessingResult,
} from "../service/ModerationService";
import { ParkedPlaceBetStatus } from "../model/ParkedPlaceBet";

export interface ParkedPlaceBetReplayWorkerOptions {
  ownerId: string;
  pollIntervalMs: number;
  leaseDurationMs: number;
  batchSize: number;
  maxAttempts: number;
  maxAgeMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

const DEFAULT_OPTIONS: Omit<ParkedPlaceBetReplayWorkerOptions, "ownerId"> = {
  pollIntervalMs: 1000,
  leaseDurationMs: 30_000,
  batchSize: 25,
  maxAttempts: 10,
  maxAgeMs: 15 * 60_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

class ParkedPlaceBetReplayWorker {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private running = false;
  private stopping = false;
  private currentRun: Promise<number> | null = null;
  private readonly options: ParkedPlaceBetReplayWorkerOptions;

  constructor(
    private readonly moderationService: ModerationService,
    options: Partial<ParkedPlaceBetReplayWorkerOptions> = {}
  ) {
    this.options = this.resolveOptions(options);
  }

  isRunning(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.stopping = false;

    try {
      await this.runOnce();
      this.scheduleNextRun();
    } catch (error) {
      this.started = false;
      this.clearTimer();
      throw new Error(
        `Failed to start parked place bet replay worker: ${this.formatError(error)}`
      );
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    this.clearTimer();

    if (this.currentRun) {
      try {
        await this.currentRun;
      } catch {
        // allow runtime shutdown to continue after in-flight work settles
      }
    }
  }

  async runOnce(): Promise<number> {
    if (this.running) {
      return 0;
    }

    this.running = true;
    this.currentRun = (async () => {
      let processed = 0;

      while (!this.stopping && processed < this.options.batchSize) {
        const claimed = await this.moderationService.claimParkedPlaceBet(
          this.options.ownerId,
          this.options.leaseDurationMs,
          new Date()
        );

        if (!claimed) {
          break;
        }

        processed += 1;

        try {
          const result = await this.moderationService.replayParkedPlaceBet(
            claimed
          );
          await this.handleReplayResult(claimed, result);
        } catch (error) {
          await this.rescheduleClaimedBet(claimed, claimed.pendingEventIds, error);
        }
      }

      return processed;
    })();

    try {
      return await this.currentRun;
    } finally {
      this.running = false;
      this.currentRun = null;
    }
  }

  private async handleReplayResult(
    claimedParkedPlaceBet: ParkedPlaceBetRecord,
    result: PlaceBetProcessingResult
  ): Promise<void> {
    if (result.type === "decision") {
      await this.moderationService.removeParkedPlaceBet(
        claimedParkedPlaceBet.slipId
      );
      return;
    }

    if (result.exhausted) {
      return;
    }

    await this.rescheduleClaimedBet(
      claimedParkedPlaceBet,
      result.pendingEventIds,
      "Awaiting moderation context"
    );
  }

  private async rescheduleClaimedBet(
    claimedParkedPlaceBet: ParkedPlaceBetRecord,
    pendingEventIds: string[],
    lastError: unknown
  ): Promise<ParkedPlaceBetStatus> {
    const options: ParkedReplayRescheduleOptions = {
      now: new Date(),
      pendingEventIds,
      maxAttempts: this.options.maxAttempts,
      maxAgeMs: this.options.maxAgeMs,
      baseBackoffMs: this.options.baseBackoffMs,
      maxBackoffMs: this.options.maxBackoffMs,
      lastError,
    };

    return this.moderationService.rescheduleClaimedParkedPlaceBet(
      claimedParkedPlaceBet,
      options
    );
  }

  private scheduleNextRun(): void {
    if (!this.started) {
      return;
    }

    this.clearTimer();
    this.timer = setTimeout(async () => {
      try {
        await this.runOnce();
      } catch (error) {
        console.log("parked place bet replay worker tick failed", error);
      } finally {
        if (this.started) {
          this.scheduleNextRun();
        }
      }
    }, this.options.pollIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private resolveOptions(
    options: Partial<ParkedPlaceBetReplayWorkerOptions>
  ): ParkedPlaceBetReplayWorkerOptions {
    const resolved: ParkedPlaceBetReplayWorkerOptions = {
      ownerId: options.ownerId ?? randomUUID(),
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_OPTIONS.pollIntervalMs,
      leaseDurationMs:
        options.leaseDurationMs ?? DEFAULT_OPTIONS.leaseDurationMs,
      batchSize: options.batchSize ?? DEFAULT_OPTIONS.batchSize,
      maxAttempts: options.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts,
      maxAgeMs: options.maxAgeMs ?? DEFAULT_OPTIONS.maxAgeMs,
      baseBackoffMs: options.baseBackoffMs ?? DEFAULT_OPTIONS.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_OPTIONS.maxBackoffMs,
    };

    this.validatePositiveInteger("pollIntervalMs", resolved.pollIntervalMs);
    this.validatePositiveInteger("leaseDurationMs", resolved.leaseDurationMs);
    this.validatePositiveInteger("batchSize", resolved.batchSize);
    this.validatePositiveInteger("maxAttempts", resolved.maxAttempts);
    this.validateNonNegativeInteger("maxAgeMs", resolved.maxAgeMs);
    this.validatePositiveInteger("baseBackoffMs", resolved.baseBackoffMs);
    this.validatePositiveInteger("maxBackoffMs", resolved.maxBackoffMs);

    if (resolved.maxBackoffMs < resolved.baseBackoffMs) {
      throw new Error(
        "Parked place bet replay worker requires maxBackoffMs >= baseBackoffMs"
      );
    }

    return resolved;
  }

  private validatePositiveInteger(name: string, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `Parked place bet replay worker requires ${name} to be a positive integer`
      );
    }
  }

  private validateNonNegativeInteger(name: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Parked place bet replay worker requires ${name} to be a non-negative integer`
      );
    }
  }

  private formatError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/g, " ").trim();
  }
}

export const createParkedPlaceBetReplayWorkerOptionsFromEnv = (
  env: NodeJS.ProcessEnv = process.env
): Partial<ParkedPlaceBetReplayWorkerOptions> => ({
  pollIntervalMs: readOptionalInteger(
    env.MODERATION_PARKING_POLL_INTERVAL_MS,
    "MODERATION_PARKING_POLL_INTERVAL_MS"
  ),
  leaseDurationMs: readOptionalInteger(
    env.MODERATION_PARKING_LEASE_DURATION_MS,
    "MODERATION_PARKING_LEASE_DURATION_MS"
  ),
  batchSize: readOptionalInteger(
    env.MODERATION_PARKING_BATCH_SIZE,
    "MODERATION_PARKING_BATCH_SIZE"
  ),
  maxAttempts: readOptionalInteger(
    env.MODERATION_PARKING_MAX_ATTEMPTS,
    "MODERATION_PARKING_MAX_ATTEMPTS"
  ),
  maxAgeMs: readOptionalInteger(
    env.MODERATION_PARKING_MAX_AGE_MS,
    "MODERATION_PARKING_MAX_AGE_MS"
  ),
  baseBackoffMs: readOptionalInteger(
    env.MODERATION_PARKING_BASE_BACKOFF_MS,
    "MODERATION_PARKING_BASE_BACKOFF_MS"
  ),
  maxBackoffMs: readOptionalInteger(
    env.MODERATION_PARKING_MAX_BACKOFF_MS,
    "MODERATION_PARKING_MAX_BACKOFF_MS"
  ),
});

const readOptionalInteger = (
  value: string | undefined,
  name: string
): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer when provided`);
  }

  return parsed;
};

export default ParkedPlaceBetReplayWorker;
