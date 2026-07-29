import mongoose from "mongoose";
import { messengerWrapper } from "@betstan/common";

import NewEventListener from "./event/listener/NewEventListener";
import { GamemasterWorker } from "./worker/GamemasterWorker";
import EventResultListener from "./event/listener/EventResultListener";

const bootstrap = async () => {
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

    const gameMaster = new GamemasterWorker();
    await gameMaster.init();
    gameMaster.work();

    process.on("uncaughtException", async function (err) {
      console.log("logging general error", err);
      try {
        await mongoose.connection.close();
        await mongoose.disconnect();
        process.exit(1);
      } catch (err) {
        console.log("error inside error", err);
      }
    });

    process.on("SIGINT", async () => {
      console.log("Received sigint command");
      try {
        await mongoose.connection.close();
        await mongoose.disconnect();
        process.exit(0);
      } catch (err) {
        console.log("error closing connections", err);
      }
    });

    process.on("SIGTERM", async () => {
      console.log("Received sigterm command");
      try {
        await mongoose.connection.close();
        await mongoose.disconnect();
        process.exit(0);
      } catch (err) {
        console.log("Error closing conection", err);
      }
    });
  } catch (err) {
    console.log("Bootstrap failed", err);
    process.exit(1);
  }
};

bootstrap();
