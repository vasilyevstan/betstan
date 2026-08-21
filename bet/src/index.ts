import { Server } from "http";
import mongoose from "mongoose";
import { app } from "./app";
import { messengerWrapper } from "@betstan/common";

import ModerationResultListener from "./event/listener/ModerationResultListener";
import PlaceBetListener from "./event/listener/PlaceBetListener";
import SettleSlipRowListener from "./event/listener/SettleSlipRowListener";
import SettleSlipListener from "./event/listener/SettleSlipListener";
import { PendingBetUpdateWorker } from "./service/PendingBetUpdateWorker";

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

export const startUp = async () => {
  console.log("Starting up...");
  if (!process.env.RABBITMQ_URI) {
    throw new Error("Missing RABBITMQ_URI variable");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to database");

  console.log("Connecting to: ", process.env.RABBITMQ_URI);
  await messengerWrapper.connect(process.env.RABBITMQ_URI);

  const pendingBetUpdateWorker = new PendingBetUpdateWorker();
  await pendingBetUpdateWorker.start();

  const listeners = [
    new PlaceBetListener(messengerWrapper.connection),
    new ModerationResultListener(messengerWrapper.connection),
    new SettleSlipRowListener(messengerWrapper.connection),
    new SettleSlipListener(messengerWrapper.connection),
  ];

  for (const listener of listeners) {
    await listener.init();
    listener.listen();
  }

  const server = app.listen(3000, () => {
    console.log("listening on port 3000");
  });

  let shuttingDownPromise: Promise<void> | null = null;
  const shutDown = async (exitCode?: number) => {
    if (shuttingDownPromise) {
      await shuttingDownPromise;
      return;
    }

    shuttingDownPromise = (async () => {
      await pendingBetUpdateWorker.stop();
      await closeServer(server);
      await mongoose.connection.close();
      await mongoose.disconnect();
    })();

    try {
      await shuttingDownPromise;
    } finally {
      if (typeof exitCode === "number") {
        process.exit(exitCode);
      }
    }
  };

  process.on("uncaughtException", async function (err) {
    console.log("logging general error", err);
    try {
      await shutDown(1);
    } catch (err) {
      console.log("error inside error", err);
    }
  });

  process.on("SIGINT", async () => {
    console.log("Received sigint command");
    try {
      await shutDown(0);
    } catch (err) {
      console.log("error closing connections", err);
    }
  });

  process.on("SIGTERM", async () => {
    console.log("Received sigterm command");
    try {
      await shutDown(0);
    } catch (err) {
      console.log("Error closing conection", err);
    }
  });

  return { pendingBetUpdateWorker, server, shutDown };
};

if (process.env.NODE_ENV !== "test") {
  void startUp().catch((error) => {
    console.log(error);
    process.exit(1);
  });
}
