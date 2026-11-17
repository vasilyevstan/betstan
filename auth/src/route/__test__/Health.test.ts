import mongoose from "mongoose";
import request from "supertest";
import { app } from "../../app";

it("reports database loss rather than HTTP availability", async () => {
  await request(app).get("/health").expect(200, { status: "green" });
  const uri = `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`;
  await mongoose.connection.close();
  try {
    const response = await request(app).get("/health").expect(503, { status: "red" });
    expect(response.headers["cache-control"]).toBe("no-store");
  } finally {
    await mongoose.connect(uri);
  }
});
