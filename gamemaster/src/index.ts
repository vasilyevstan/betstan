import { createServer, Server } from "http";
import mongoose from "mongoose";
import { messengerWrapper } from "@betstan/common";

import NewEventListener from "./event/listener/NewEventListener";
import { GamemasterWorker } from "./worker/GamemasterWorker";
import EventResultListener from "./event/listener/EventResultListener";

export const startWorkerProbeServer = async (
  port = Number(process.env.PORT ?? 3000)
): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.statusCode = 204;
      response.end();
    });
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });

const closeServer = (server: Server | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });

export interface GamemasterProcess {
  exit(code?: number): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export const installGamemasterProcessHandlers = (
  closeResources: () => Promise<void>,
  runtimeProcess: GamemasterProcess = process
) => {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (exitCode: number, code: string): Promise<void> => {
    if (!shutdownPromise) {
      console.log(code);
      shutdownPromise = closeResources().then(
        () => {
          runtimeProcess.exit(exitCode);
        },
        () => {
          console.error("gamemaster_shutdown_failed");
          runtimeProcess.exit(1);
        }
      );
    }
    return shutdownPromise;
  };
  runtimeProcess.on("uncaughtException", () => {
    void shutdown(1, "gamemaster_uncaught_exception");
  });
  const handleSignal = () => {
    void shutdown(0, "gamemaster_signal");
  };
  runtimeProcess.on("SIGINT", handleSignal);
  runtimeProcess.on("SIGTERM", handleSignal);
  return { shutdown };
};

export const startUp = async (listenForProbes = false) => {
  console.log("Starting up...");
  if (!process.env.RABBITMQ_URI) {
    throw new Error("Missing RABBITMQ_URI variable");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }

  let probeServer: Server | undefined;
  console.log("Connecting to: ", process.env.RABBITMQ_URI);
  await messengerWrapper.connect(process.env.RABBITMQ_URI);
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to database");

  const newEventListener = new NewEventListener(messengerWrapper.connection);
  await newEventListener.init();
  const eventResultListener = new EventResultListener(
    messengerWrapper.connection
  );
  await eventResultListener.init();
  const gameMaster = new GamemasterWorker();
  await gameMaster.init();

  newEventListener.listen();
  eventResultListener.listen();
  gameMaster.work();
  if (listenForProbes) {
    probeServer = await startWorkerProbeServer();
  }

  const closeResources = async () => {
    gameMaster.stop();
    await closeServer(probeServer);
    await mongoose.connection.close();
    await mongoose.disconnect();
  };

  installGamemasterProcessHandlers(closeResources);

  return { gameMaster, probeServer };
};

if (require.main === module) {
  void startUp(true).catch(() => {
    console.error("gamemaster_startup_failed");
    process.exit(1);
  });
}
