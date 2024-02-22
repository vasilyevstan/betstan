import mongoose from "mongoose";
import { app } from "./app";

const startUp = async () => {
  if (!process.env.JWT_KEY) {
    throw new Error("JWT_KEY must be defined");
  }

  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI must be defined");
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to database");
  } catch (err) {
    throw new Error();
  }

  const server = app.listen(3000, () => {
    console.log("Listening on 3000");
  });

  process.on("uncaughtException", async function (err) {
    console.log("logging general error", err);
    try {
      await mongoose.connection.close();
      await mongoose.disconnect();

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
      server.close();
      process.exit(0);
    } catch (err) {
      console.log("Error closing conection", err);
    }
  });
};

startUp();
