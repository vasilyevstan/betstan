import mongoose from "mongoose";
import { messengerWrapper } from "@betstan/common";

import NewEventListener from "./event/listener/NewEventListener";
import { GamemasterWorker } from "./worker/GamemasterWorker";
import EventResultListener from "./event/listener/EventResultListener";

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

    const channel = await messengerWrapper.getChannel();
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

    process.on("uncaughtException", async function (err) {
      console.log("logging general error", err);
      try {
        await mongoose.connection.close();
        await mongoose.disconnect();
        await messengerWrapper.connection.close();
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
        await messengerWrapper.connection.close();
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
        await messengerWrapper.connection.close();
        process.exit(0);
      } catch (err) {
        console.log("Error closing conection", err);
      }
    });
  } catch (err) {
    console.log(err);
  }
};

const gameMasterWorker = () => {
  const gameMaster = new GamemasterWorker();
  gameMaster.work();
};

startUp();
gameMasterWorker();
