import mongoose from "mongoose";
import { app } from "./app";
import { messengerWrapper } from "@betstan/common";
import NewEventListener from "./event/listener/NewEventListener";

const startUp = async () => {
  console.log("Starting...");
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

    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to database");
  } catch (err) {
    console.log(err);
  }

  app.listen(3000, () => {
    console.log("listening on port 3000");
  });
};

startUp();
