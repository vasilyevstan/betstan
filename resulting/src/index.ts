import { createServer, Server } from "http";
import { runResultingService } from "./service/startup";

export const startWorkerProbeServer = async (
  port = Number(process.env.PORT ?? 3000)
): Promise<{ close(): Promise<void>; server: Server }> =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
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
    startProbeListener: () => startWorkerProbeServer(),
  });
}
