import net from "net";
import request from "supertest";
import { EventEmitter } from "events";
import { AddressInfo } from "net";
import {
  GamemasterProcess,
  installGamemasterProcessHandlers,
  startWorkerProbeServer,
} from "../index";

it("does not bind on import and explicitly starts, accepts, and closes", async () => {
  const server = await startWorkerProbeServer(0);
  const address = server.address() as AddressInfo;

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

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  expect(server.listening).toBe(false);
});

it("reports readiness and the effective live switch, including an expired activation lease", async () => {
    const previousEnabled = process.env.LIVE_KICKOFFS_ENABLED;
    const previousLease = process.env.LIVE_KICKOFFS_LEASE_UNTIL_EPOCH;
    let ready = false;
    const server = await startWorkerProbeServer(0, () => ready);
    try {
      process.env.LIVE_KICKOFFS_ENABLED = "true";
      delete process.env.LIVE_KICKOFFS_LEASE_UNTIL_EPOCH;
      await request(server).get("/health").expect(503, { status: "red", liveBettingEnabled: true });
      ready = true;
      await request(server).get("/health").expect(200, { status: "green", liveBettingEnabled: true });
      process.env.LIVE_KICKOFFS_ENABLED = "false";
      await request(server).get("/health").expect(200, { status: "green", liveBettingEnabled: false });
      process.env.LIVE_KICKOFFS_ENABLED = "true";
      process.env.LIVE_KICKOFFS_LEASE_UNTIL_EPOCH = "1";
      await request(server).get("/health").expect(200, { status: "green", liveBettingEnabled: false });
    } finally {
      if (previousEnabled === undefined) delete process.env.LIVE_KICKOFFS_ENABLED;
      else process.env.LIVE_KICKOFFS_ENABLED = previousEnabled;
      if (previousLease === undefined) delete process.env.LIVE_KICKOFFS_LEASE_UNTIL_EPOCH;
      else process.env.LIVE_KICKOFFS_LEASE_UNTIL_EPOCH = previousLease;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

it("closes resources and fails the process on rejected asynchronous message handlers", async () => {
  const close = jest.fn(async () => {});
  const processEmitter = new EventEmitter() as EventEmitter & GamemasterProcess;
  processEmitter.exit = jest.fn();
  installGamemasterProcessHandlers(close, processEmitter);
  processEmitter.emit("unhandledRejection", new Error("message handler failed"));
  await new Promise(resolve => setImmediate(resolve));
  expect(close).toHaveBeenCalledTimes(1);
  expect(processEmitter.exit).toHaveBeenCalledWith(1);
});

it("keeps repeated signal handlers installed while one async cleanup completes", async () => {
  let resolveClose!: () => void;
  const close = jest.fn(
    () => new Promise<void>((resolve) => {
      resolveClose = resolve;
    })
  );
  const processEmitter = new EventEmitter() as EventEmitter & GamemasterProcess;
  processEmitter.exit = jest.fn();
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  installGamemasterProcessHandlers(close, processEmitter);

  processEmitter.emit("SIGINT");
  processEmitter.emit("SIGINT");
  expect(close).toHaveBeenCalledTimes(1);
  expect(processEmitter.listenerCount("SIGINT")).toBe(1);
  expect(processEmitter.exit).not.toHaveBeenCalled();

  resolveClose();
  await new Promise((resolve) => setImmediate(resolve));
  expect(processEmitter.exit).toHaveBeenCalledTimes(1);
  expect(processEmitter.exit).toHaveBeenCalledWith(0);
  expect(log).toHaveBeenCalledTimes(1);
});
