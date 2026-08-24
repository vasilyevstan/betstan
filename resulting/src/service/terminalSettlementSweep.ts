import { IAmqpConnection } from "@betstan/common";
import SettleSlipPublisher from "../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../event/publisher/SettleSlipRowPublisher";
import {
  findTerminalPendingSlipIds,
  reconcileSlip,
  SettlementPublishers,
} from "./resulting";

export interface TerminalSettlementSweepOptions {
  batchSize?: number;
  pollIntervalMs?: number;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 5000;

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

/**
 * Independently sweeps for slips whose terminal settlement never converged
 * (row publication succeeded but the terminal settle-slip publish/confirm
 * step failed or was interrupted). Unlike the per-event retry path, this
 * sweep rediscovers such slips directly from Bet state, so it still recovers
 * them even when their triggering rows have already been removed (manual
 * void) and no future event will ever reference them again.
 */
export class TerminalSettlementSweepWorker {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;

  private inFlightRun?: Promise<number>;
  private interval?: NodeJS.Timeout;
  private publishers!: SettlementPublishers;
  private started = false;
  private stopped = false;

  constructor(
    private readonly connection: IAmqpConnection,
    options: TerminalSettlementSweepOptions = {}
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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

    if (this.inFlightRun) {
      await this.inFlightRun;
    }
  }

  async runOnce(): Promise<number> {
    if (!this.publishers) {
      throw new Error(
        "TerminalSettlementSweepWorker must be initialised before running"
      );
    }

    const slipIds = await findTerminalPendingSlipIds(this.batchSize);

    for (const slipId of slipIds) {
      try {
        await reconcileSlip(slipId, this.publishers);
      } catch (error) {
        console.error("Terminal settlement sweep failed for slip:", {
          error,
          slipId,
        });
      }
    }

    return slipIds.length;
  }

  private async triggerRun(): Promise<number> {
    return this.executeTrackedRun(true);
  }

  private async executeTrackedRun(swallowErrors: boolean): Promise<number> {
    if (!this.inFlightRun) {
      const runPromise = this.runOnce();

      this.inFlightRun = (swallowErrors
        ? runPromise.catch((error) => {
          console.error("Terminal settlement sweep run failed:", error);
          return 0;
        })
        : runPromise
      ).finally(() => {
        this.inFlightRun = undefined;
      });
    }

    return this.inFlightRun;
  }
}
