import mongoose from "mongoose";
import { messengerWrapper } from "@betstan/common";
import EventResultListener from "../event/listener/EventResultListener";
import LiveEventUpdateListener from "../event/listener/LiveEventUpdateListener";
import PlaceBetListener from "../event/listener/PlaceBetListener";
import BetModerationResultPublisher from "../event/publisher/BetModerationResultPublisher";
import ModerationService from "../service/ModerationService";
import ParkedPlaceBetReplayWorker from "../worker/ParkedPlaceBetReplayWorker";
import {
  createParkedPlaceBetReplayWorkerOptionsFromEnv,
} from "../worker/ParkedPlaceBetReplayWorker";

export interface ModerationRuntimeProcess {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  exit(code?: number): unknown;
}

export interface ModerationRuntimeLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ManagedPublisher {
  init(): Promise<void>;
  initConfirmChannel(): Promise<void>;
  publishWithConfirm(event: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface ManagedListener {
  init(): Promise<void>;
  listen(): void;
  close(): Promise<void>;
}

export interface ManagedWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ModerationRuntimeDependencies {
  env: NodeJS.ProcessEnv;
  process: ModerationRuntimeProcess;
  logger: ModerationRuntimeLogger;
  connectMessaging(uri: string): Promise<void>;
  closeMessaging(): Promise<void>;
  connectDatabase(uri: string): Promise<void>;
  closeDatabase(): Promise<void>;
  disconnectDatabase(): Promise<void>;
  createReplayPublisher(): ManagedPublisher;
  createWorker(replayPublisher: ManagedPublisher): ManagedWorker;
  createListeners(): ManagedListener[];
}

class ModerationRuntime {
  private replayPublisher: ManagedPublisher | null = null;
  private worker: ManagedWorker | null = null;
  private listeners: ManagedListener[] = [];
  private shutdownPromise: Promise<void> | null = null;
  private hooksInstalled = false;
  private exitPromise: Promise<void> | null = null;

  private readonly handleSigint = () => {
    void this.exitAfterShutdown(0, "Received sigint command");
  };

  private readonly handleSigterm = () => {
    void this.exitAfterShutdown(0, "Received sigterm command");
  };

  private readonly handleUncaughtException = (error: unknown) => {
    this.dependencies.logger.error("logging general error", error);
    void this.exitAfterShutdown(1);
  };

  constructor(private readonly dependencies: ModerationRuntimeDependencies) {}

  async start(): Promise<void> {
    this.installHooks();

    try {
      this.validateEnvironment();
      await this.dependencies.connectMessaging(
        this.dependencies.env.RABBITMQ_URI as string
      );
      await this.dependencies.connectDatabase(
        this.dependencies.env.MONGO_URI as string
      );

      this.replayPublisher = this.dependencies.createReplayPublisher();
      await this.replayPublisher.init();
      await this.replayPublisher.initConfirmChannel();

      this.listeners = this.dependencies.createListeners();
      for (const listener of this.listeners) {
        await listener.init();
      }

      this.worker = this.dependencies.createWorker(this.replayPublisher);
      await this.worker.start();

      for (const listener of this.listeners) {
        listener.listen();
      }
    } catch (error) {
      try {
        await this.shutdown();
      } catch (shutdownError) {
        throw new Error(
          `Runtime startup failed: ${this.formatError(error)}; cleanup failed: ${this.formatError(shutdownError)}`
        );
      }

      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.performShutdown();

    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    const errors: unknown[] = [];

    if (this.worker) {
      await this.captureError(errors, () => this.worker!.stop());
      this.worker = null;
    }

    while (this.listeners.length > 0) {
      const listener = this.listeners.pop();

      if (listener) {
        await this.captureError(errors, () => listener.close());
      }
    }

    if (this.replayPublisher) {
      await this.captureError(errors, () => this.replayPublisher!.close());
      this.replayPublisher = null;
    }

    await this.captureError(errors, () => this.dependencies.closeMessaging());
    await this.captureError(errors, () => this.dependencies.closeDatabase());
    await this.captureError(errors, () => this.dependencies.disconnectDatabase());
    this.removeHooks();
    this.removeHooks();

    if (errors.length > 0) {
      throw errors[0] instanceof Error
        ? errors[0]
        : new Error(this.formatError(errors[0]));
    }
  }

  private async exitAfterShutdown(
    exitCode: number,
    message?: string
  ): Promise<void> {
    if (this.exitPromise) {
      return this.exitPromise;
    }

    this.exitPromise = (async () => {
    if (message) {
      this.dependencies.logger.log(message);
    }

    try {
      await this.shutdown();
      this.dependencies.process.exit(exitCode);
    } catch (error) {
      this.dependencies.logger.error("runtime shutdown failed", error);
      this.dependencies.process.exit(1);
    }
    })();

    return this.exitPromise;
  }

  private validateEnvironment(): void {
    if (!this.dependencies.env.RABBITMQ_URI) {
      throw new Error("Missing RABBITMQ_URI variable");
    }

    if (!this.dependencies.env.MONGO_URI) {
      throw new Error("Missing MONGO_URI variable");
    }
  }

  private installHooks(): void {
    if (this.hooksInstalled) {
      return;
    }

    this.dependencies.process.on("SIGINT", this.handleSigint);
    this.dependencies.process.on("SIGTERM", this.handleSigterm);
    this.dependencies.process.on(
      "uncaughtException",
      this.handleUncaughtException
    );
    this.hooksInstalled = true;
  }

  private removeHooks(): void {
    if (!this.hooksInstalled) {
      return;
    }

    this.removeHook("SIGINT", this.handleSigint);
    this.removeHook("SIGTERM", this.handleSigterm);
    this.removeHook("uncaughtException", this.handleUncaughtException);
    this.hooksInstalled = false;
  }

  private removeHook(
    event: string,
    listener: (...args: any[]) => void
  ): void {
    if (this.dependencies.process.off) {
      this.dependencies.process.off(event, listener);
      return;
    }

    if (this.dependencies.process.removeListener) {
      this.dependencies.process.removeListener(event, listener);
    }
  }

  private async captureError(
    errors: unknown[],
    action: () => Promise<void>
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export const createDefaultModerationRuntime = (
  env: NodeJS.ProcessEnv = process.env,
  runtimeProcess: ModerationRuntimeProcess = process,
  logger: ModerationRuntimeLogger = console
): ModerationRuntime => {
  const closeMessaging = async () => {
    const connection = Reflect.get(messengerWrapper, "_connection") as
      | { close?: () => Promise<void> }
      | undefined;

    if (connection?.close) {
      await connection.close();
    }
  };

  const closeDatabase = async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
  };

  const disconnectDatabase = async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  };

  return new ModerationRuntime({
    env,
    process: runtimeProcess,
    logger,
    connectMessaging: async (uri: string) => {
      logger.log("Connecting to: ", uri);
      await messengerWrapper.connect(uri);
    },
    closeMessaging,
    connectDatabase: async (uri: string) => {
      await mongoose.connect(uri);
      logger.log("Connected to database");
    },
    closeDatabase,
    disconnectDatabase,
    createReplayPublisher: () => new BetModerationResultPublisher(messengerWrapper.connection),
    createWorker: (replayPublisher) =>
      new ParkedPlaceBetReplayWorker(
        new ModerationService(replayPublisher),
        createParkedPlaceBetReplayWorkerOptionsFromEnv(env)
      ),
    createListeners: () => [
      new PlaceBetListener(messengerWrapper.connection),
      new LiveEventUpdateListener(messengerWrapper.connection),
      new EventResultListener(messengerWrapper.connection),
    ],
  });
};

export default ModerationRuntime;
