import mongoose from "mongoose";
import { messengerWrapper } from "@betstan/common";
import PlaceBetListener from "./event/listener/PlaceBetListener";
import ModerationResultListener from "./event/listener/ModerationResultListener";
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
    const listener = new PlaceBetListener(messengerWrapper.connection);
    await listener.init();
    listener.listen();

    const moderationResultListener = new ModerationResultListener(
      messengerWrapper.connection
    );
    await moderationResultListener.init();
    moderationResultListener.listen();

    const eventResultListener = new EventResultListener(
      messengerWrapper.connection
    );
    await eventResultListener.init();
    eventResultListener.listen();

    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to database");
  } catch (err) {
    console.log(err);
  }
};

startUp();
