import http, { Server } from "http";
import { AddressInfo } from "net";
import { handleRiskHttp } from "../Http";
import { initializeRisk, RiskBaseline, RiskPosition, RiskState } from "../Store";
import { defaults, parseRule } from "../Policy";
import { facts } from "../Evaluation";
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
const openEvent = { eventId: "event-a", name: "Open event", time: "2099-01-01T12:00:00.000Z", phase: "PRE_MATCH" };
const choice = {
  origin: "STANDARD", marketId: "result", outcomeKey: "home", marketName: "1X2", label: "Home",
  odds: 3, betKind: "PRE_MATCH", sourceOpen: true,
};
async function withEventSource(handler: http.RequestListener, action: () => Promise<void>) {
  const source = http.createServer(handler);
  await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
  process.env.EVENT_SERVICE_URL = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  try { await action(); }
  finally { await new Promise<void>(resolve => source.close(() => resolve())); }
}
const catalogueResponse: http.RequestListener = (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url?.startsWith("/api/event/risk-events?")
    ? { events: [openEvent], nextAfter: null } : { event: openEvent, choices: [choice] }));
};

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
    catalogue.event.liveEnabled = false;
    expect((await verifyRiskSource("event-one", [{ ...row, betKind: "LIVE" }])).affectedRows)
      .toEqual([{ rowId: "original-row", declineReason: "RISK_POLICY" }]);
    expect((await verifyRiskSource("event-one", [row])).affectedRows).toEqual([]);
    catalogue.event.visibility = "OFFLINE";
    expect((await verifyRiskSource("event-one", [row])).affectedRows).toEqual([{ rowId: "original-row", declineReason: "RISK_POLICY" }]);
    delete catalogue.event.visibility;
    await expect(verifyRiskSource("event-one", [row])).rejects.toThrow("Incomplete");
  } finally { await new Promise<void>(resolve => source.close(() => resolve())); }
});

it("classifies random native product IDs from Event authority, including Standard selections in a Builder", async () => {
  const catalogue = {
    event: { eventId: "event-a", time: new Date(Date.now() + 600000).toISOString(), status: "NO_RESULT", visibility: "ONLINE" },
    standardMarkets: [{ marketId: "random-product-id", marketType: "CS" }],
    standardSelections: [{ origin: "STANDARD", marketId: "random-product-id", outcomeKey: "selection", odds: 2 }],
  };
  await withEventSource((_req, res) => { res.end(JSON.stringify(catalogue)); }, async () => {
    const row = { id: "row", productId: "random-product-id", oddsId: "selection", oddsValue: 2, marketType: "1X2", betKind: "PRE_MATCH" };
    expect(await verifyRiskSource("event-a", [row], new Date(), true)).toMatchObject({ marketTypes: ["PRE_MATCH:CS"] });
    const builder = { ...row, marketBet: { kind: "BUILDER", selections: [
      { origin: "STANDARD", marketId: "random-product-id", outcomeKey: "selection" },
      { origin: "TEMPLATE", marketId: "manual-1x2", outcomeKey: "home" },
    ] } };
    expect(await verifyRiskSource("event-a", [builder], new Date(), true)).toMatchObject({ marketTypes: ["PRE_MATCH:CS"] });
    catalogue.standardMarkets = [];
    await expect(verifyRiskSource("event-a", [builder], new Date(), true)).rejects.toThrow("Incomplete built-in");
    expect(await verifyRiskSource("event-a", [row])).not.toHaveProperty("marketTypes");
  });
});

it("reflects global native blocks in the event view and refuses missing classification instead of showing on", async () => {
  await RiskState.updateOne({ _id: "active" }, { $set: { rules: [...defaults(), parseRule({
    id: "market:PRE_MATCH:1X2", type: "DENY", enabled: true, scope: { marketTypes: ["PRE_MATCH:1X2"] }, parameters: {},
  })] } });
  const detail: { event: typeof openEvent; choices: (typeof choice & { marketType?: string })[] } = {
    event: openEvent, choices: [{ ...choice, marketType: "1X2" }],
  };
  await withEventSource((_req, res) => { res.end(JSON.stringify(detail)); }, async () => {
    const response = await request("GET", "/api/moderation/risk-centre/events/event-a");
    expect(response).toMatchObject({ status: 200, data: { choices: [{ singleBlockedByOtherRule: true }] } });
    detail.choices = [choice];
    expect(await request("GET", "/api/moderation/risk-centre/events/event-a")).toMatchObject({ status: 503 });
  });
});

it("reports an aggregate-only read snapshot with whole-book headroom and authoritative baseline shadowing", async () => {
  const fact = (eventId: string) => facts({ rows: [{ eventId, productId: "result", oddsId: "home" }] });
  const position = {
    userId: "private-user", facts: fact("event-a"), reserved: true, moneyReady: true, state: "ACCEPTED",
    stakeMinor: 100, remainingStakeMinor: 20, returnMinor: 200,
  };
  await RiskState.updateOne({ _id: "active" }, { $set: {
    accountingCoverage: { valid: true, openPositionsReady: true },
    rules: [...defaults(), parseRule({
      id: "ceiling", type: "MAX_OPERATOR_EXPOSURE", enabled: true, scope: {}, parameters: { limit: 1200, perCustomer: false },
    })],
  } });
  await RiskPosition.create([
    { ...position, _id: "private-slip", event: { data: { privateField: "private-row" } } },
    { ...position, _id: "closed", remainingStakeMinor: 0 },
  ]);
  await RiskBaseline.create([
    { ...position, _id: "private-slip", returnMinor: 10000 },
    { ...position, _id: "closed", returnMinor: 600 },
    { ...position, _id: "other-event", facts: fact("event-b"), returnMinor: 950 },
  ]);
  const before = await RiskState.findById("active").lean<{ serial: number }>();
  await withEventSource(catalogueResponse, async () => {
    const list = await request("GET", "/api/moderation/risk-centre/events");
    expect(list.status).toBe(200);
    expect(list.data.events[0].metrics).toEqual({ exposureMinor: "100", openTickets: 1, pendingTickets: 0 });
    const detail = await request("GET", "/api/moderation/risk-centre/events/event-a");
    expect(detail.status).toBe(200);
    expect(detail.data.analysis).toEqual({ ready: true, code: "READY" });
    expect(detail.data.choices[0]).toMatchObject({
      headroomMinor: "250", stressReturnMinor: "300", advice: "LOWER_ODDS", suggestedOdds: 2.5,
    });
    for (const hidden of ["private-user", "private-slip", "private-row", "accountingFingerprint"]) {
      expect(JSON.stringify([list.data, detail.data])).not.toContain(hidden);
    }
    expect((await RiskState.findById("active").lean<{ serial: number }>())?.serial).toBe(before?.serial);
    await RiskState.updateOne({ _id: "active" }, { $unset: { accountingCoverage: 1 } });
    const unavailable = await request("GET", "/api/moderation/risk-centre/events/event-a");
    expect(unavailable.data).toMatchObject({ analysis: { ready: false }, metrics: null });
    expect(unavailable.data.choices[0]).toMatchObject({ advice: "UNAVAILABLE", headroomMinor: null, suggestedOdds: null });
  });
});

it("rejects invalid queries before source reads and never emits a partial oversized event analysis", async () => {
  let sourceStatus = 200;
  const detail = { event: openEvent, choices: Array.from({ length: 1001 }, () => choice) };
  const handler = jest.fn<ReturnType<http.RequestListener>, Parameters<http.RequestListener>>((_req, res) => {
    res.statusCode = sourceStatus;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(detail));
  });
  await withEventSource(handler, async () => {
    for (const path of [
      "/events?limit=26", "/events?limit=1&limit=2", "/events?after=bad%20id", "/events?url=https://example.invalid",
      "/events/event-a?stakeMinor=0", "/events/event-a?stakeMinor=1.5", "/events/event-a?stakeMinor=1000000000001",
      "/events/event-a?stakeMinor=1&stakeMinor=2",
    ]) expect((await request("GET", `/api/moderation/risk-centre${path}`)).status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    const oversized = await request("GET", "/api/moderation/risk-centre/events/event-a");
    expect(oversized).toMatchObject({ status: 503, data: { code: "EVENT_VIEW_CAPACITY_UNAVAILABLE" } });
    expect(oversized.data).not.toHaveProperty("choices");
    sourceStatus = 409;
    expect(await request("GET", "/api/moderation/risk-centre/events/event-a"))
      .toMatchObject({ status: 404, data: { code: "EVENT_NOT_OPEN" } });
  });
});

it("detects raw baseline capacity before closed-live shadowing can disguise truncation as an empty book", async () => {
  const entries = Array.from({ length: 10001 }, (_, index) => ({
    _id: `shadow-${index}`, reserved: true, state: "ACCEPTED", moneyReady: true,
    facts: facts({ rows: [{ eventId: "event-a", productId: "result", oddsId: "home" }] }),
    stakeMinor: 100, remainingStakeMinor: 100, returnMinor: 200,
  }));
  await RiskBaseline.insertMany(entries);
  await RiskPosition.insertMany(entries.map(entry => ({ ...entry, remainingStakeMinor: 0 })));
  await RiskState.updateOne({ _id: "active" }, { $set: { accountingCoverage: { valid: true, openPositionsReady: true } } });
  await withEventSource(catalogueResponse, async () => {
    const response = await request("GET", "/api/moderation/risk-centre/events");
    expect(response.status).toBe(200);
    expect(response.data.analysis).toEqual({ ready: false, code: "EXPOSURE_READ_CAPACITY_UNAVAILABLE" });
    expect(response.data.events[0].metrics).toBeNull();
  });
}, 30000);
