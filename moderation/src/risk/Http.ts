import { IncomingMessage, ServerResponse } from "http";
import { getHistory, getOperation, getPolicy, mutatePolicy, Mutation } from "./Store";
import { RiskError } from "./Policy";

async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new RiskError("INVALID_BODY", "JSON content type required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 65536) throw new RiskError("BODY_TOO_LARGE", "Request exceeds 64 KiB", 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RiskError("INVALID_JSON", "Malformed JSON"); }
}
export async function handleRiskHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  const send = (status: number, value: unknown) => { response.statusCode = status; response.end(JSON.stringify(value)); };
  try {
    const url = new URL(request.url ?? "/", "http://moderation");
    if (request.method === "GET" && ["/", "/health", "/ready"].includes(url.pathname)) {
      response.statusCode = 204; response.end(); return;
    }
    const base = "/api/moderation/risk-centre";
    let path: string;
    try { path = decodeURIComponent(url.pathname.slice(base.length)); }
    catch { throw new RiskError("INVALID_PATH", "Invalid path encoding"); }
    if (!url.pathname.startsWith(base)) throw new RiskError("NOT_FOUND", "Route not found", 404);
    if (request.method === "GET" && path === "") { send(200, await getPolicy()); return; }
    if (request.method === "GET" && path === "/history") {
      if ([...url.searchParams.keys()].some(k => !["beforeRevision", "limit"].includes(k))
        || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("beforeRevision").length > 1) throw new RiskError("INVALID_QUERY", "Unsupported history query");
      send(200, await getHistory(
        url.searchParams.has("beforeRevision") ? Number(url.searchParams.get("beforeRevision")) : undefined,
        url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
      )); return;
    }
    const operation = /^\/operations\/([A-Za-z0-9:_.-]+)$/.exec(path);
    if (request.method === "GET" && operation) { send(200, await getOperation(operation[1])); return; }
    const rule = /^\/rules\/([A-Za-z0-9:_.-]+)$/.exec(path);
    let action: Mutation | undefined;
    if (request.method === "POST" && path === "/rules") action = "CREATE";
    if (request.method === "POST" && path === "/reset") action = "RESET";
    if (request.method === "PUT" && rule) action = "UPDATE";
    if (request.method === "DELETE" && rule) action = "DELETE";
    if (!action) throw new RiskError("NOT_FOUND", "Route not found", 404);
    if (url.search) throw new RiskError("INVALID_QUERY", "Mutations do not accept query parameters");
    send(200, await mutatePolicy(action, await body(request), rule?.[1]));
  } catch (error) {
    if (error instanceof RiskError) send(error.status, { message: error.message, code: error.code });
    else send(503, { message: "Risk authority is unavailable", code: "RISK_UNAVAILABLE" });
  }
}
