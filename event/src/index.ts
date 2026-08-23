import mongoose from "mongoose";
import { app } from "./app";
import { messengerWrapper } from "@betstan/common";
import NewEventListener from "./messaging/listener/NewEventListener";
import EventResultListener from "./messaging/listener/EventResultListener";
import EventVisibilityListener from "./messaging/listener/EventVisibilityListener";
import { createLiveEventListeners } from "./messaging/listener/liveEventListeners";
import { EventScheduler } from "./scheduler/EventScheduler";

type InitialisableListener = {
  init(): Promise<void>;
  listen(): void;
};

const startListeners = async (listeners: InitialisableListener[]) => {
  for (const listener of listeners) {
    await listener.init();
  }

  for (const listener of listeners) {
    listener.listen();
  }
};

const startUp = async () => {
  let scheduler: EventScheduler | null = null;
  let server: ReturnType<typeof app.listen> | null = null;
  let rabbitConnection: { close(): Promise<void> } | null = null;
  let shuttingDown = false;

  const shutdown = async (exitCode: number) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    try {
      await scheduler?.stop();
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => {
            if (err) {
              reject(err);
              return;
            }

            resolve();
          });
        });
      }
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
        await mongoose.disconnect();
      }
      await rabbitConnection?.close();
    } catch (err) {
      console.log("error closing connections", err);
    } finally {
      process.exit(exitCode);
    }
  };

  console.log("Starting up...");
  if (!process.env.RABBITMQ_URI) {
    throw new Error("Missing RABBITMQ_URI variable");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }
  if (!process.env.AUTH_SERVICE_URL) {
    throw new Error("Missing AUTH_SERVICE_URL variable");
  }

  try {
    console.log("Connecting to: ", process.env.RABBITMQ_URI);
    await messengerWrapper.connect(process.env.RABBITMQ_URI);
    rabbitConnection = messengerWrapper.connection;

    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to database");

    const newEventListener = new NewEventListener(messengerWrapper.connection);
    const eventResultListener = new EventResultListener(
      messengerWrapper.connection
    );
    const eventVisibilityListener = new EventVisibilityListener(
      messengerWrapper.connection
    );
    const liveEventListeners = createLiveEventListeners(
      messengerWrapper.connection
    );

    await startListeners([
      newEventListener,
      eventResultListener,
      eventVisibilityListener,
      ...liveEventListeners.all,
    ]);

    scheduler = new EventScheduler();
    await scheduler.start();

    server = app.listen(3000, () => {
      console.log("listening on port 3000");
    });
  } catch (err) {
    console.log(err);
    await shutdown(1);
    return;
  }

  process.on("uncaughtException", (err) => {
    console.log("logging general error", err);
    void shutdown(1);
  });

  process.on("SIGINT", () => {
    console.log("Received sigint command");
    void shutdown(0);
  });

  process.on("SIGTERM", () => {
    console.log("Received sigterm command");
    void shutdown(0);
  });
};

startUp();
