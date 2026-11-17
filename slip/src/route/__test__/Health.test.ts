import mongoose from "mongoose";
import request from "supertest";
import { app, runtimeHealth } from "../../app";

it("requires complete startup, database and broker connectivity", async () => {
  const previous = { ...runtimeHealth };
  const uri = `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`;
  try {
    runtimeHealth.ready = false;
    runtimeHealth.brokerConnected = true;
    await request(app).get("/health").expect(503);
    runtimeHealth.ready = true;
    await request(app).get("/health").expect(200, { status: "green" });
    runtimeHealth.brokerConnected = false;
    await request(app).get("/health").expect(503, { status: "red" });
    runtimeHealth.brokerConnected = true;
    await mongoose.connection.close();
    await request(app).get("/health").expect(503, { status: "red" });
  } finally {
    if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
    Object.assign(runtimeHealth, previous);
  }
});
