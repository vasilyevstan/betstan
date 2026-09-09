import amqp, { ChannelModel } from "amqplib";
import { Server } from "http";
import mongoose from "mongoose";
import { app } from "./app";
import { TelemetryConsumer } from "./event/TelemetryConsumer";
import { TelemetryRecordModel } from "./model/TelemetryRecord";
import { MongoMetricRecorder } from "./service/Recorder";

export interface TelemetryRuntime {
  close(): Promise<void>;
  server: Server;
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

export const startTelemetry = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<TelemetryRuntime> => {
  if (!env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }
  if (!env.RABBITMQ_URI) {
    throw new Error("Missing RABBITMQ_URI variable");
  }

  let connection: ChannelModel | undefined;
  let consumer: TelemetryConsumer | undefined;
  let server: Server | undefined;
  try {
    await mongoose.connect(env.MONGO_URI);
    await TelemetryRecordModel.init();
    connection = (await amqp.connect(env.RABBITMQ_URI)) as ChannelModel;
    consumer = new TelemetryConsumer(connection, new MongoMetricRecorder());
    await consumer.start();
    const port = Number(env.PORT ?? 3000);
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(port, () => resolve(listening));
      listening.once("error", reject);
    });
  } catch (error) {
    await consumer?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await mongoose.disconnect().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    server,
    close: async () => {
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
          await close(() => closeServer(server!));
          await close(() => consumer!.close());
          await close(() => connection!.close());
          await close(() => mongoose.disconnect());
          if (errors.length > 0) {
            throw new Error("telemetry_shutdown_failed");
          }
        })();
      }
      await closePromise;
    },
  };
};

if (require.main === module) {
  void startTelemetry()
    .then((runtime) => {
      const shutdown = () => {
        void runtime
          .close()
          .then(() => process.exit(0))
          .catch(() => {
            console.error("telemetry_shutdown_failed");
            process.exit(1);
          });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch(() => {
      console.error("telemetry_startup_failed");
      process.exit(1);
    });
}
