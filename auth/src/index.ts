import mongoose from "mongoose";
import { app } from "./app";
import { User } from "./model/User";
import { authTelemetryReporter } from "./service/TelemetryReporter";
import { Server } from "http";

export const listenWithOptionalTelemetry = (
  listen: (callback: () => void) => Server = (callback) =>
    app.listen(3000, callback),
  reporter: Pick<typeof authTelemetryReporter, "initialize"> =
    authTelemetryReporter,
  rabbitmqUri: string | undefined = process.env.RABBITMQ_URI
): Server =>
  listen(() => {
    console.log("Listening on 3000");
    void Promise.resolve()
      .then(() => reporter.initialize(rabbitmqUri))
      .catch(() => {
        console.error("auth_telemetry_disabled");
      });
  });

export const startUp = async () => {
  if (!process.env.JWT_KEY) {
    throw new Error("JWT_KEY must be defined");
  }

  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI must be defined");
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    await User.init();
    console.log("Connected to database");
  } catch (err) {
    throw new Error();
  }

  const server = listenWithOptionalTelemetry();

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
    console.log("Received sigint command");
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
    console.log("Received sigterm command");
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

if (require.main === module) {
  void startUp().catch(() => {
    console.error("auth_startup_failed");
    process.exit(1);
  });
}
