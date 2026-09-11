import net, { AddressInfo } from "net";
import { startWorkerProbeServer } from "../index";

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
