import { messengerWrapper } from "@betstan/common";
import { app, runtimeHealth } from "./app";
import ModerationResultListener from "./event/listener/ModerationResultListener";
import OddsClickedListener from "./event/listener/OddsClickedListener";
import mongoose from "mongoose";
import { Server } from "http";
import { ensureSlipReadyForTraffic } from "./service/SlipReadiness";
import { SlipSubmissionWorker } from "./service/SlipSubmissionWorker";

let server: Server | null = null;
let submissionWorker: SlipSubmissionWorker | null = null;
let shuttingDown = false;

const closeServer = async () => {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server!.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server = null;
};

const disconnectDatabase = async () => {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  await mongoose.connection.close();
  await mongoose.disconnect();
};

const shutDown = async (exitCode: number, error?: unknown) => {
  if (shuttingDown) {
    process.exit(exitCode);
    return;
  }

  shuttingDown = true;
  runtimeHealth.ready = false;

  if (error) {
    console.log(error);
  }

  try {
    await submissionWorker?.stop();
    submissionWorker = null;
    await closeServer();
    await disconnectDatabase();
  } catch (shutdownError) {
    console.log("error closing connections", shutdownError);
  }

  process.exit(exitCode);
};

const startUp = async () => {
  console.log("Starting up...");
  if (!process.env.RABBITMQ_URI) {
    throw new Error("Missing RABBITMQ_URI variable");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }

  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
  });
  console.log("Connected to database");

  await ensureSlipReadyForTraffic();

  console.log("Connecting to: ", process.env.RABBITMQ_URI);
  await messengerWrapper.connect(process.env.RABBITMQ_URI);
  runtimeHealth.brokerConnected = true;
  const connection = messengerWrapper.connection;
  if ("on" in connection && typeof connection.on === "function") {
    const brokerFailed = () => {
      runtimeHealth.brokerConnected = false;
      console.error("slip_broker_unavailable");
    };
    connection.on("close", brokerFailed);
    connection.on("error", brokerFailed);
  }

  submissionWorker = new SlipSubmissionWorker(messengerWrapper.connection);
  await submissionWorker.start();

  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  const moderationResultListener = new ModerationResultListener(
    messengerWrapper.connection
  );
  await moderationResultListener.init();

  if (shuttingDown) throw new Error("slip_startup_interrupted");
  listener.listen();
  moderationResultListener.listen();
  runtimeHealth.ready = true;

  server = app.listen(3000, () => {
    console.log("listening on port 3000");
  });

  return {
    server,
    submissionWorker,
  };
};

process.on("uncaughtException", async function (err) {
  console.log("logging general error");
  await shutDown(1, err);
});

process.on("SIGINT", async () => {
  console.log("Received sigint command");
  await shutDown(0);
});

process.on("SIGTERM", async () => {
  console.log("Received sigter command");
  await shutDown(0);
});

if (require.main === module) {
  void startUp().catch(async (error: unknown) => {
    await shutDown(1, error);
  });
}

export { startUp };
