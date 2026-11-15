import http, { Server } from "http";
import { AddressInfo } from "net";
import { handleRiskHttp } from "../Http";
import { initializeRisk } from "../Store";
import { verifyRiskSource } from "../SourceVerifier";

let server: Server;
let origin: string;
beforeEach(async () => {
  process.env.RISK_CENTRE_ENABLED = "true";
  await initializeRisk();
  server = http.createServer((req, res) => { void handleRiskHttp(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  delete process.env.RISK_CENTRE_ENABLED;
  delete process.env.EVENT_SERVICE_URL;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
function request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(origin + path, { method, headers: { "Content-Type": "application/json" } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => { resolve({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }); });
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

it("serves immediate anonymous CAS saves, exact operation replay, history and encoded default reset", async () => {
  const base = "/api/moderation/risk-centre";
  const policy = await request("GET", base);
  expect(policy.status).toBe(200);
  expect(policy.data.readiness.accounting).toMatchObject({ openPositionsReady: false, readyLossWindows: [] });
  expect(policy.data.readiness.activity).toMatchObject({ tracking: false, readyWindows: [] });
  const delay = policy.data.rules.find((r: any) => r.type === "DELAY_MS");
  const save = { expectedRevision: 1, requestId: "save", rule: { ...delay, parameters: { limit: 1000 } } };
  expect((await request("PUT", `${base}/rules/default%3ADELAY_MS`, save)).data.revision).toBe(2);
  expect((await request("PUT", `${base}/rules/default%3ADELAY_MS`, save)).data.revision).toBe(2);
  expect((await request("POST", `${base}/reset`, { expectedRevision: 1, requestId: "stale" })).status).toBe(409);
  expect((await request("GET", `${base}/operations/save`)).data.requestId).toBe("save");
  const history = await request("GET", `${base}/history?limit=1`);
  expect(history.data.items).toHaveLength(1);
  expect(history.data.nextBeforeRevision).toBe(2);
  expect((await request("POST", `${base}/reset`, { expectedRevision: 2, requestId: "reset", ruleId: "default:DELAY_MS" })).data.rules.find((r: any) => r.type === "DELAY_MS").parameters.limit).toBe(0);
  expect((await request("GET", `${base}/history?limit=51`)).status).toBe(400);
  expect(JSON.stringify(history)).not.toContain("userId");
});

it("checks current visibility and exact ordinary selection IDs/prices over bounded Event HTTP", async () => {
  const source = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(catalogue));
  });
  const catalogue: any = { event: { eventId: "event-one", time: new Date(Date.now() + 60000).toISOString(), status: "NO_RESULT", visibility: "ONLINE" },
    standardSelections: [{ origin: "STANDARD", marketId: "product", outcomeKey: "selection", odds: 2 }] };
  await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
  process.env.EVENT_SERVICE_URL = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const row = { id: "original-row", productId: "product", oddsId: "selection", oddsValue: 2, betKind: "PRE_MATCH" };
  try {
    expect(await verifyRiskSource("event-one", [row])).toEqual({ kickoffAt: catalogue.event.time, affectedRows: [] });
    expect((await verifyRiskSource("event-one", [{ ...row, oddsValue: 3 }, { ...row, id: "unchanged-row" }])).affectedRows)
      .toEqual([{ rowId: "original-row", declineReason: "STALE_QUOTE", currentOdds: 2 }]);
    await expect(verifyRiskSource("event-one", [{ ...row, oddsId: "wrong" }])).rejects.toThrow();
    catalogue.event.visibility = "OFFLINE";
    expect((await verifyRiskSource("event-one", [row])).affectedRows).toEqual([{ rowId: "original-row", declineReason: "RISK_POLICY" }]);
    delete catalogue.event.visibility;
    await expect(verifyRiskSource("event-one", [row])).rejects.toThrow("Incomplete");
  } finally { await new Promise<void>(resolve => source.close(() => resolve())); }
});
