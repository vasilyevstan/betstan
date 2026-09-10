import amqp, { ChannelModel } from "amqplib";
import { Server } from "http";
import mongoose from "mongoose";
import { app } from "./app";
import { TelemetryConsumer } from "./event/TelemetryConsumer";
import { TelemetryRecordModel } from "./model/TelemetryRecord";
import { MongoMetricRecorder } from "./service/Recorder";

export interface ManagedTelemetryConsumer {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface TelemetryRuntime {
  close(): Promise<void>;
  failed: Promise<void>;
  server: Server;
}

export interface TelemetryStartupDependencies {
  closeServer(server: Server): Promise<void>;
  connectMongo(uri: string): Promise<void>;
  connectRabbit(uri: string): Promise<ChannelModel>;
  createConsumer(
    connection: ChannelModel,
    onFatal: () => void
  ): ManagedTelemetryConsumer;
  disconnectMongo(): Promise<void>;
  initModel(): Promise<unknown>;
  listen(port: number): Promise<Server>;
}

export interface TelemetryProcess {
  exit(code?: number): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

const closeHttpServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const defaultDependencies = (): TelemetryStartupDependencies => ({
  closeServer: closeHttpServer,
  connectMongo: async (uri) => {
    await mongoose.connect(uri);
  },
  connectRabbit: async (uri) => (await amqp.connect(uri)) as ChannelModel,
  createConsumer: (connection, onFatal) =>
    new TelemetryConsumer(connection, new MongoMetricRecorder(), onFatal),
  disconnectMongo: async () => {
    await mongoose.disconnect();
  },
  initModel: () => TelemetryRecordModel.init(),
  listen: (port) =>
    new Promise<Server>((resolve, reject) => {
      const server = app.listen(port, () => resolve(server));
      server.once("error", reject);
    }),
});

export const startTelemetry = async (
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<TelemetryStartupDependencies> = {}
): Promise<TelemetryRuntime> => {
  if (!env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }
  if (!env.RABBITMQ_URI) {
    throw new Error("Missing RABBITMQ_URI variable");
  }

  const dependencies = {
    ...defaultDependencies(),
    ...overrides,
  };
  let mongoConnected = false;
  let connection: ChannelModel | undefined;
  let consumer: ManagedTelemetryConsumer | undefined;
  let server: Server | undefined;
  let startupComplete = false;
  let fatalRequested = false;
  let closePromise: Promise<void> | undefined;
  let resolveFailed!: () => void;
  const failed = new Promise<void>((resolve) => {
    resolveFailed = resolve;
  });

  const closeResources = (): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        const errors: unknown[] = [];
        const close = async (operation: () => Promise<void>) => {
          try {
            await operation();
          } catch (error) {
            errors.push(error);
          }
        };
        if (server) {
          await close(() => dependencies.closeServer(server!));
          server = undefined;
        }
        if (consumer) {
          await close(() => consumer!.close());
          consumer = undefined;
        }
        if (connection) {
          await close(() => connection!.close());
          connection = undefined;
        }
        if (mongoConnected) {
          await close(() => dependencies.disconnectMongo());
          mongoConnected = false;
        }
        if (errors.length > 0) {
          throw new Error("telemetry_shutdown_failed");
        }
      })();
    }
    return closePromise;
  };

  const requestFatal = () => {
    if (fatalRequested) {
      return;
    }
    fatalRequested = true;
    resolveFailed();
    if (startupComplete) {
      void closeResources().catch(() => undefined);
    }
  };

  try {
    await dependencies.connectMongo(env.MONGO_URI);
    mongoConnected = true;
    await dependencies.initModel();
    connection = await dependencies.connectRabbit(env.RABBITMQ_URI);
    consumer = dependencies.createConsumer(connection, requestFatal);
    await consumer.start();
    if (fatalRequested) {
      throw new Error("telemetry_consumer_failed");
    }
    server = await dependencies.listen(Number(env.PORT ?? 3000));
    if (fatalRequested) {
      throw new Error("telemetry_consumer_failed");
    }
    startupComplete = true;
  } catch (error) {
    await closeResources().catch(() => undefined);
    throw error;
  }

  return {
    server,
    failed,
    close: closeResources,
  };
};

export const installTelemetryProcessHandlers = (
  runtime: TelemetryRuntime,
  runtimeProcess: TelemetryProcess = process
) => {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (exitCode: number): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = runtime.close().then(
        () => {
          runtimeProcess.exit(exitCode);
        },
        () => {
          console.error("telemetry_shutdown_failed");
          runtimeProcess.exit(1);
        }
      );
    }
    return shutdownPromise;
  };
  const handleSignal = () => {
    void shutdown(0);
  };
  runtimeProcess.on("SIGINT", handleSignal);
  runtimeProcess.on("SIGTERM", handleSignal);
  void runtime.failed.then(() => shutdown(1));
  return { shutdown };
};

if (require.main === module) {
  void startTelemetry()
    .then((runtime) => {
      installTelemetryProcessHandlers(runtime);
    })
    .catch(() => {
      console.error("telemetry_startup_failed");
      process.exit(1);
    });
}
