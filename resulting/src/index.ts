import { createServer, Server } from "http";
import mongoose from "mongoose";
import { runResultingService } from "./service/startup";

export const startWorkerProbeServer = async (
  port = Number(process.env.PORT ?? 3000),
  isReady: () => boolean = () => false
): Promise<{ close(): Promise<void>; server: Server }> =>
  new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        const ready = mongoose.connection.readyState === 1 && isReady();
        response.writeHead(ready ? 200 : 503, {
          "Content-Type": "application/json", "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ status: ready ? "green" : "red" }));
        return;
      }
      response.statusCode = 204;
      response.end();
    });
    server.once("error", reject);
    server.listen(port, () => {
      resolve({
        server,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) =>
              error ? closeReject(error) : closeResolve()
            );
          }),
      });
    });
  });

if (require.main === module) {
  void runResultingService({
    startProbeListener: (isReady) => startWorkerProbeServer(undefined, isReady),
  });
}
