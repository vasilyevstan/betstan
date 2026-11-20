import express from "express";
import http from "http";
import https from "https";

const router = express.Router();
const base = "/api/backoffice/risk-centre";
const error = (code: string, message: string) => ({ code, message });

// A fixed deployment authority, never a URL supplied by the public caller.
export function serviceRequest(
  configured: string | undefined, path: string, method: string, body?: unknown,
  statuses: number[] = [200, 400, 404, 409, 413, 503],
): Promise<{ status: number; data: unknown }> {
  if (!configured) return Promise.reject(new Error("Service authority is not configured"));
  const url = new URL(path, configured);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return Promise.reject(new Error("Invalid service authority"));
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload && Buffer.byteLength(payload) > 65536) return Promise.resolve({ status: 413, data: error("BODY_TOO_LARGE", "Request exceeds 64 KiB") });
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
    }, response => {
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { request.destroy(new Error("Oversized service response")); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on("error", reject);
      response.on("end", () => {
        clearTimeout(deadline);
        try {
          const status = response.statusCode ?? 502;
          if (!statuses.includes(status)) throw new Error("Unexpected service status");
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid service response");
          if (status !== 200 && (typeof data.code !== "string" || typeof data.message !== "string")) throw new Error("Invalid service error");
          resolve({ status, data });
        } catch (failure) { reject(failure); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error("Service authority timed out")), 5000);
    request.on("error", failure => { clearTimeout(deadline); reject(failure); });
    request.end(payload);
  });
}

const riskRequest = (path: string, method: string, body?: unknown) =>
  serviceRequest(process.env.MODERATION_SERVICE_URL, `/api/moderation/risk-centre${path}`, method, body);

router.all([base, `${base}/*`], (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const path = req.originalUrl.slice(base.length);
  let pathname: string;
  try { pathname = decodeURIComponent(path.split("?")[0]); }
  catch { res.status(400).send(error("INVALID_PATH", "Invalid path encoding")); return; }
  const allowed = req.method === "GET"
    ? pathname === "" || pathname === "/history" || pathname === "/events"
      || /^\/(?:operations|events)\/[A-Za-z0-9:_.-]{1,96}$/.test(pathname)
    : req.method === "POST" ? ["/rules", "/reset"].includes(pathname)
      : ["PUT", "DELETE"].includes(req.method) && /^\/rules\/[A-Za-z0-9:_.-]{1,96}$/.test(pathname);
  if (!allowed) { res.status(404).send(error("NOT_FOUND", "Route not found")); return; }
  void riskRequest(path, req.method, req.method === "GET" ? undefined : req.body)
    .then(result => { res.status(result.status).send(result.data); })
    .catch(() => {
      try { res.status(503).send(error("RISK_UNAVAILABLE", "Risk authority is unavailable")); }
      catch (failure) { next(failure); }
    });
});
export { router as RiskCentre };
