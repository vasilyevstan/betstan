import net from "net";
import { AddressInfo } from "net";
import { startWorkerProbeServer } from "../index";

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
