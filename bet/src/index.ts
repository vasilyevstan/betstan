import mongoose from "mongoose";
import { app } from "./app";
import { messengerWrapper } from "@betstan/common";

import ModerationResultListener from "./event/listener/ModerationResultListener";
import PlaceBetListener from "./event/listener/PlaceBetListener";
import SettleSlipRowListener from "./event/listener/SettleSlipRowListener";
import SettleSlipListener from "./event/listener/SettleSlipListener";

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
    const placeBetListener = new PlaceBetListener(messengerWrapper.connection);
    await placeBetListener.init();
    placeBetListener.listen();

    const moderationResultListener = new ModerationResultListener(
      messengerWrapper.connection
    );
    await moderationResultListener.init();
    moderationResultListener.listen();

    const settleSlipRowListener = new SettleSlipRowListener(
      messengerWrapper.connection
    );
    await settleSlipRowListener.init();
    settleSlipRowListener.listen();

    const settleSlipListener = new SettleSlipListener(
      messengerWrapper.connection
    );
    await settleSlipListener.init();
    settleSlipListener.listen();

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
