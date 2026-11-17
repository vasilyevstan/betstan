import mongoose from "mongoose";
import { app, runtimeHealth } from "./app";
import { messengerWrapper } from "@betstan/common";
import NewEventListener from "./event/listener/NewEventListener";
import EventResultListener from "./event/listener/EventResultListener";
import { CashBackSourceListener } from "./event/listener/CashBackSourceListener";
import { MarketPublishedListener } from "./event/listener/MarketPublishedListener";
import { MarketTemplate } from "./model/MarketTemplate";
import {
  BackofficePublicationService,
  getBackofficePublicationService,
} from "./service/BackofficePublicationService";

let publicationService: BackofficePublicationService | null = null;

const startUp = async () => {
  console.log("Starting up...");
  if (!process.env.RABBITMQ_URI) {
    throw new Error("Missing RABBITMQ_URI variable");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI variable");
  }

  try {
    console.log("Connecting to: ", process.env.RABBITMQ_URI);
    await messengerWrapper.connect(process.env.RABBITMQ_URI);
    runtimeHealth.brokerConnected = true;
    const connection = messengerWrapper.connection;
    if ("on" in connection && typeof connection.on === "function") {
      const brokerFailed = () => {
        runtimeHealth.brokerConnected = false;
        console.error("backoffice_broker_failed");
        process.exit(1);
      };
      connection.on("close", brokerFailed);
      connection.on("error", brokerFailed);
    }

    const newEventListener = new NewEventListener(messengerWrapper.connection);
    await newEventListener.init();
    newEventListener.listen();

    const eventResultListener = new EventResultListener(
      messengerWrapper.connection
    );
    await eventResultListener.init();
    eventResultListener.listen();

    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to database");
    await MarketTemplate.init();
    const marketPublishedListener = new MarketPublishedListener(messengerWrapper.connection);
    await marketPublishedListener.init();
    marketPublishedListener.listen();

    const cashBackSourceListener = new CashBackSourceListener(messengerWrapper.connection);
    await cashBackSourceListener.init();
    cashBackSourceListener.listen();

    publicationService = getBackofficePublicationService(
      messengerWrapper.connection
    );
    await publicationService.start();
    runtimeHealth.ready = true;
  } catch (err) {
    console.log(err);
  }

  const server = app.listen(3000, () => {
    console.log("listening on port 3000");
  });

  process.on("uncaughtException", async function (err) {
    runtimeHealth.ready = false;
    console.log("logging general error", err);
    try {
      await publicationService?.stop();
      await mongoose.connection.close();
      await mongoose.disconnect();
      // await channel.close();

      server.close();

      process.exit(1);
    } catch (err) {
      console.log("error inside error", err);
    }
  });

  process.on("SIGINT", async () => {
    runtimeHealth.ready = false;
    console.log("Received sigint command");
    try {
      await publicationService?.stop();
      await mongoose.connection.close();
      await mongoose.disconnect();
      server.close();
      process.exit(0);
    } catch (err) {
      console.log("error closing connections", err);
    }
  });

  process.on("SIGTERM", async () => {
    runtimeHealth.ready = false;
    console.log("Received sigterm command");
    try {
      await publicationService?.stop();
      await mongoose.connection.close();
      await mongoose.disconnect();
      server.close();
      process.exit(0);
    } catch (err) {
      console.log("Error closing conection", err);
    }
  });
};

process.on("unhandledRejection", () => {
  runtimeHealth.ready = false;
  console.error("backoffice_unhandled_rejection");
  process.exit(1);
});

startUp();
