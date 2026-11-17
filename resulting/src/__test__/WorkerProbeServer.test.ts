import net, { AddressInfo } from "net";
import mongoose from "mongoose";
import request from "supertest";
import { startWorkerProbeServer } from "../index";

it("reports incomplete startup and database loss as unavailable", async () => {
  let ready = false;
  const listener = await startWorkerProbeServer(0, () => ready);
  const uri = `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`;
  try {
    await request(listener.server).get("/health").expect(503, { status: "red" });
    ready = true;
    await request(listener.server).get("/health").expect(200, { status: "green" });
    await mongoose.connection.close();
    await request(listener.server).get("/health").expect(503, { status: "red" });
  } finally {
    if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
    await listener.close();
  }
});

it("does not bind on import and explicitly starts, accepts, and closes", async () => {
  const listener = await startWorkerProbeServer(0);
  const address = listener.server.address() as AddressInfo;

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(
      { host: "127.0.0.1", port: address.port },
      () => {
        socket.end();
        resolve();
      }
    );
    socket.once("error", reject);
  });

  await listener.close();
  expect(listener.server.listening).toBe(false);
});
