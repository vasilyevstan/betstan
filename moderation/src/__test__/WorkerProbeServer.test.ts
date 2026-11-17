import net, { AddressInfo } from "net";
import mongoose from "mongoose";
import http from "http";
import { startWorkerProbeServer } from "../index";

it("reports incomplete startup and database loss as unavailable", async () => {
  let ready = false;
  const listener = await startWorkerProbeServer(0, () => ready);
  const uri = `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`;
  const health = () => new Promise((resolve, reject) => {
    http.get({
      host: "127.0.0.1", port: (listener.server.address() as AddressInfo).port, path: "/health",
    }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ code: response.statusCode, body: JSON.parse(body) }));
      response.on("error", reject);
    }).on("error", reject);
  });
  try {
    expect(await health()).toEqual({ code: 503, body: { status: "red" } });
    ready = true;
    expect(await health()).toEqual({ code: 200, body: { status: "green" } });
    await mongoose.connection.close();
    expect(await health()).toEqual({ code: 503, body: { status: "red" } });
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
