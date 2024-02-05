import { messengerWrapper } from "@betstan/common";
import { app } from "./app";
import OddsClickedListener from "./event/listener/OddsClickedListener";
import mongoose from "mongoose";

// app.post("/api/slip", (req: Request, res) => {
//   console.log(req.body);
//   res.sendStatus(200);
// });

const startUp = async () => {
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
    const listener = new OddsClickedListener(messengerWrapper.connection);
    await listener.init();
    listener.listen();

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
