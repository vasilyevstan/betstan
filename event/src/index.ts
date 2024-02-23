import mongoose from "mongoose";
import { app } from "./app";
import { messengerWrapper } from "@betstan/common";
import NewEventListener from "./messaging/listener/NewEventListener";
import EventResultListener from "./messaging/listener/EventResultListener";
import EventVisibilityListener from "./messaging/listener/EventVisibilityListener";

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

    const eventVisibilityListener = new EventVisibilityListener(
      messengerWrapper.connection
    );
    await eventVisibilityListener.init();
    eventVisibilityListener.listen();

    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to database");
  } catch (err) {
    console.log(err);
  }

  const server = app.listen(3000, () => {
    console.log("listening on port 3000");
  });

  process.on("uncaughtException", async function (err) {
    console.log("logging general error", err);
    try {
      await mongoose.connection.close();
      await mongoose.disconnect();
      // await channel.close();
      await messengerWrapper.connection.close();

      server.close();

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
      server.close();
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
      server.close();
      process.exit(0);
    } catch (err) {
      console.log("Error closing conection", err);
    }
  });
};

startUp();
