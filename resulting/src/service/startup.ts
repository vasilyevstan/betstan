import mongoose from "mongoose";
import { IAmqpConnection, messengerWrapper } from "@betstan/common";
import EventResultListener from "../event/listener/EventResultListener";
import LiveEventUpdateListener from "../event/listener/LiveEventUpdateListener";
import ModerationResultListener from "../event/listener/ModerationResultListener";
import PlaceBetListener from "../event/listener/PlaceBetListener";
import { replayPendingModerationResult } from "./resulting";
import { PendingModerationReplayWorker } from "./pendingModeration";
import { RetryWorker } from "./retry";
import { TerminalSettlementSweepWorker } from "./terminalSettlementSweep";

export interface ResultingServiceConfig {
  mongoUri: string;
  rabbitmqUri: string;
}

export interface ManagedResultingListener {
  readonly serviceName: string;
  init(): Promise<void>;
  listen(): void;
}

export interface ManagedBackgroundWorker {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ProcessLike {
  exit(code?: number): void;
  on(event: string, listener: (...args: any[]) => void): ProcessLike;
  off?(event: string, listener: (...args: any[]) => void): ProcessLike;
  removeListener?(
    event: string,
    listener: (...args: any[]) => void
  ): ProcessLike;
}

export interface StartupDependencies {
  closeBroker?: () => Promise<void>;
  closeDb?: () => Promise<void>;
  connectBroker?: (uri: string) => Promise<void>;
  connectDb?: (uri: string) => Promise<void>;
  createListeners?: (
    connection: IAmqpConnection
  ) => ManagedResultingListener[];
  createWorkers?: (connection: IAmqpConnection) => ManagedBackgroundWorker[];
  disconnectDb?: () => Promise<void>;
  getBrokerConnection?: () => IAmqpConnection;
  logger?: Pick<Console, "error" | "log">;
  processLike?: ProcessLike;
}

const REGISTERED_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export function resolveResultingConfig(
  env: NodeJS.ProcessEnv = process.env
): ResultingServiceConfig {
  const rabbitmqUri = env.RABBITMQ_URI;
  const mongoUri = env.MONGO_URI;

  if (!rabbitmqUri) {
    throw new Error("Missing RABBITMQ_URI variable");
  }

  if (!mongoUri) {
    throw new Error("Missing MONGO_URI variable");
  }

  return {
    mongoUri,
    rabbitmqUri,
  };
}

function createDefaultDependencies(): Required<StartupDependencies> {
  return {
    closeBroker: async () => {
      await messengerWrapper.connection.close();
    },
    closeDb: async () => {
      await mongoose.connection.close();
    },
    connectBroker: async (uri: string) => {
      await messengerWrapper.connect(uri);
    },
    connectDb: async (uri: string) => {
      await mongoose.connect(uri);
    },
    createListeners: (connection: IAmqpConnection) => [
      new PlaceBetListener(connection),
      new ModerationResultListener(connection),
      new EventResultListener(connection),
      new LiveEventUpdateListener(connection),
    ],
    createWorkers: (connection: IAmqpConnection) => [
      new RetryWorker(connection),
      new PendingModerationReplayWorker(
        connection,
        replayPendingModerationResult
      ),
      new TerminalSettlementSweepWorker(connection),
    ],
    disconnectDb: async () => {
      await mongoose.disconnect();
    },
    getBrokerConnection: () => messengerWrapper.connection,
    logger: console,
    processLike: process,
  };
}

export class ResultingServiceRuntime {
  private brokerConnected = false;
  private dbConnected = false;
  private handlersRegistered = false;
  private listeners: ManagedResultingListener[] = [];
  private workers: ManagedBackgroundWorker[] = [];
  private shutdownPromise?: Promise<void>;

  private readonly handleSigint = async () => {
    this.dependencies.logger.log("Received sigint command");
    await this.shutdown(0);
  };

  private readonly handleSigterm = async () => {
    this.dependencies.logger.log("Received sigterm command");
    await this.shutdown(0);
  };

  private readonly handleUncaughtException = async (error: unknown) => {
    this.dependencies.logger.log("logging general error", error);
    await this.shutdown(1);
  };

  constructor(
    private readonly config: ResultingServiceConfig,
    private readonly dependencies: Required<StartupDependencies>
  ) {}

  async start(): Promise<void> {
    this.registerShutdownHandlers();
    this.dependencies.logger.log("Starting up...");

    try {
      this.dependencies.logger.log("Connecting to: ", this.config.rabbitmqUri);
      await this.dependencies.connectBroker(this.config.rabbitmqUri);
      this.brokerConnected = true;

      await this.dependencies.connectDb(this.config.mongoUri);
      this.dbConnected = true;
      this.dependencies.logger.log("Connected to database");

      const connection = this.dependencies.getBrokerConnection();
      this.listeners = this.dependencies.createListeners(connection);

      for (const listener of this.listeners) {
        await listener.init();
      }

      this.workers = this.dependencies.createWorkers(connection);

      for (const worker of this.workers) {
        await worker.init();
      }

      for (const worker of this.workers) {
        await worker.start();
      }

      for (const listener of this.listeners) {
        listener.listen();
      }
    } catch (error) {
      await this.shutdownInternal(1, true);
      throw error;
    }
  }

  async shutdown(exitCode: number = 0): Promise<void> {
    return this.shutdownInternal(exitCode, false);
  }

  private registerShutdownHandlers(): void {
    if (this.handlersRegistered) {
      return;
    }

    this.dependencies.processLike.on(
      "uncaughtException",
      this.handleUncaughtException
    );
    this.dependencies.processLike.on("SIGINT", this.handleSigint);
    this.dependencies.processLike.on("SIGTERM", this.handleSigterm);
    this.handlersRegistered = true;
  }

  private unregisterShutdownHandlers(): void {
    if (!this.handlersRegistered) {
      return;
    }

    const remover = this.dependencies.processLike.off
      ? this.dependencies.processLike.off.bind(this.dependencies.processLike)
      : this.dependencies.processLike.removeListener?.bind(
        this.dependencies.processLike
      );

    if (remover) {
      remover("uncaughtException", this.handleUncaughtException);
      REGISTERED_SIGNALS.forEach((signal) => {
        remover(signal, signal === "SIGINT" ? this.handleSigint : this.handleSigterm);
      });
    }

    this.handlersRegistered = false;
  }

  private async shutdownInternal(
    exitCode: number,
    suppressExit: boolean
  ): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async () => {
        this.unregisterShutdownHandlers();

        for (const worker of this.workers) {
          try {
            await worker.stop();
          } catch (error) {
            this.dependencies.logger.log("error stopping background worker", error);
          }
        }
        this.workers = [];

        if (this.brokerConnected) {
          try {
            await this.dependencies.closeBroker();
          } catch (error) {
            this.dependencies.logger.log("error closing broker connection", error);
          }
          this.brokerConnected = false;
        }

        if (this.dbConnected) {
          try {
            await this.dependencies.closeDb();
          } catch (error) {
            this.dependencies.logger.log("error closing connections", error);
          }

          try {
            await this.dependencies.disconnectDb();
          } catch (error) {
            this.dependencies.logger.log("error disconnecting database", error);
          }
          this.dbConnected = false;
        }

        if (!suppressExit) {
          this.dependencies.processLike.exit(exitCode);
        }
      })();
    }

    return this.shutdownPromise;
  }
}

export async function startResultingService(
  config: ResultingServiceConfig,
  overrides: StartupDependencies = {}
): Promise<ResultingServiceRuntime> {
  const runtime = new ResultingServiceRuntime(config, {
    ...createDefaultDependencies(),
    ...overrides,
  });
  await runtime.start();
  return runtime;
}

export async function runResultingService(
  overrides: StartupDependencies = {}
): Promise<ResultingServiceRuntime | void> {
  const dependencies = {
    ...createDefaultDependencies(),
    ...overrides,
  };

  try {
    const runtime = new ResultingServiceRuntime(
      resolveResultingConfig(),
      dependencies
    );
    await runtime.start();
    return runtime;
  } catch (error) {
    dependencies.logger.error("Fatal startup error", error);
    dependencies.processLike.exit(1);
  }
}
