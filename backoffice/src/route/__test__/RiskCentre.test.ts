import { AddressInfo } from "net";
import http, { Server } from "http";
import request from "supertest";
import { app } from "../../app";

let server: Server;
let upstream: jest.Mock;
beforeEach(async () => {
  upstream = jest.fn((req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ revision: 1, rules: [], catalogue: [], defaultsVersion: 1,
      readiness: { transactions: "READY", accounting: { ready: false, code: "HISTORICAL_RECONCILIATION_REQUIRED" } } }));
  });
  server = http.createServer((req, res) => upstream(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.MODERATION_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  delete process.env.MODERATION_SERVICE_URL;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

it("provides anonymous no-store management via the fixed moderation listener", async () => {
  const response = await request(app).get("/api/backoffice/risk-centre").expect(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(upstream.mock.calls[0][0].url).toBe("/api/moderation/risk-centre");
  expect(response.body.readiness.accounting.ready).toBe(false);
});
it("forwards stable mutation bodies and encoded factory identities without auth", async () => {
  let received = "";
  upstream.mockImplementation((req: http.IncomingMessage, res: http.ServerResponse) => {
    req.on("data", chunk => { received += chunk; });
    req.on("end", () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ revision: 2 })); });
  });
  const body = { expectedRevision: 1, requestId: "save", rule: { id: "default:DELAY_MS" } };
  await request(app).put("/api/backoffice/risk-centre/rules/default%3ADELAY_MS").send(body).expect(200);
  expect(JSON.parse(received)).toEqual(body);
  expect(upstream.mock.calls[0][0].url).toBe("/api/moderation/risk-centre/rules/default%3ADELAY_MS");
});
it("forwards bounded event catalogue and stress paths only to the fixed risk authority", async () => {
  await request(app).get("/api/backoffice/risk-centre/events?after=event-a&limit=10").expect(200);
  await request(app).get("/api/backoffice/risk-centre/events/event%3Aa?stakeMinor=29").expect(200);
  expect(upstream.mock.calls.map(call => call[0].url)).toEqual([
    "/api/moderation/risk-centre/events?after=event-a&limit=10",
    "/api/moderation/risk-centre/events/event%3Aa?stakeMinor=29",
  ]);
  await request(app).get("/api/backoffice/risk-centre/events/event-a/other").expect(404);
  await request(app).post("/api/backoffice/risk-centre/events").send({}).expect(404);
  expect(upstream).toHaveBeenCalledTimes(2);
});
it("preserves policy conflicts and never redirects public callers to another authority", async () => {
  upstream.mockImplementation((_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.statusCode = 409; res.end(JSON.stringify({ code: "REVISION_CONFLICT", message: "Reload policy" }));
  });
  expect((await request(app).post("/api/backoffice/risk-centre/reset").send({}).expect(409)).body.code).toBe("REVISION_CONFLICT");
  await request(app).get("/api/backoffice/risk-centre/unknown").expect(404);
  expect(upstream).toHaveBeenCalledTimes(1);
  upstream.mockImplementation((_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.statusCode = 302; res.setHeader("Location", "https://example.invalid"); res.end("{}");
  });
  expect((await request(app).get("/api/backoffice/risk-centre").expect(503)).body).toEqual({
    code: "RISK_UNAVAILABLE", message: "Risk authority is unavailable",
  });
});
it("rejects oversized requests and malformed upstream JSON with bounded public errors", async () => {
  await request(app).post("/api/backoffice/risk-centre/rules").send({ padding: "x".repeat(66000) }).expect(413);
  expect(upstream).not.toHaveBeenCalled();
  upstream.mockImplementation((_req: http.IncomingMessage, res: http.ServerResponse) => res.end("not JSON"));
  await request(app).get("/api/backoffice/risk-centre").expect(503);
});
