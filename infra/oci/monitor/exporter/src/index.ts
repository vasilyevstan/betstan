import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { collectDeepHealth } from "./kubernetes";
import { verifyGithubOidc } from "./auth";

const port = Number(process.env.PORT ?? "3000");
const namespace = process.env.OCI_K8S_NAMESPACE ?? "betstan-oci";
const audience =
  process.env.MONITOR_OIDC_AUDIENCE ?? "betstan-production-monitor";
const repository = process.env.GITHUB_REPOSITORY ?? "vasilyevstan/betstan";
const workflowPath =
  process.env.MONITOR_WORKFLOW_PATH ??
  ".github/workflows/oci-production-monitor.yml";

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ") || header.length > 8192) {
    throw new Error("missing bearer token");
  }
  return header.slice("Bearer ".length);
}

async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (
    request.method !== "GET" ||
    request.url !== "/__betstan/monitor/v1/observation"
  ) {
    send(response, 404, { error: "not-found" });
    return;
  }
  const expectedSha = request.headers["x-betstan-workflow-sha"];
  if (
    typeof expectedSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(expectedSha)
  ) {
    send(response, 400, { error: "invalid-workflow-sha" });
    return;
  }
  try {
    await verifyGithubOidc(bearer(request), {
      audience,
      repository,
      workflowPath,
      ref: "refs/heads/master",
      subject: `repo:${repository}:ref:refs/heads/master`,
      expectedSha,
      eventNames: ["schedule", "workflow_dispatch"],
    });
    send(response, 200, await collectDeepHealth(namespace));
  } catch (error) {
    const message =
      error instanceof Error && error.message.includes("OIDC")
        ? "unauthorized"
        : "health-unavailable";
    send(response, message === "unauthorized" ? 401 : 503, { error: message });
  }
}

const server = createServer((request, response) => {
  void handler(request, response);
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(port, "0.0.0.0");
