import net from "net";
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
