import { createServer, Server } from "http";
import { createDefaultModerationRuntime } from "./runtime/ModerationRuntime";
import { handleRiskHttp } from "./risk/Http";

export const startWorkerProbeServer = async (
  port = Number(process.env.PORT ?? 3000)
): Promise<{ close(): Promise<void>; server: Server }> =>
  new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      void handleRiskHttp(request, response).catch(() => {
        response.statusCode = 503;
        response.end();
      });
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
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

export const startUp = async (listenForProbes = false) => {
  console.log("Starting up...");
  const runtime = createDefaultModerationRuntime(
    process.env,
    process,
    console,
    listenForProbes ? () => startWorkerProbeServer() : undefined
  );
  await runtime.start();
  return runtime;
};

if (require.main === module) {
  void startUp(true).catch(() => {
    console.error("moderation_startup_failed");
    process.exit(1);
  });
}
