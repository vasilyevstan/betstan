import { ChildProcess, fork } from "child_process";
import { resolve } from "path";
import axios from "axios";
import request from "supertest";
import jwt from "jsonwebtoken";
import { APublisher, EventMarketConfiguration, messengerWrapper, QueueNames } from "@betstan/common";
import { app } from "../../app";
import EventTemplate from "../../data/EventTemplate";
import { Event } from "../../model/Event";
import { MarketProjectionService, storeMarketConfiguration } from "../../service/MarketProjectionService";

interface FixtureMessage {
  type: string;
  port?: number;
  time?: string;
  error?: string;
  queue?: string;
  event?: { data: EventMarketConfiguration };
}
let child: ChildProcess;
let endpoint: string;
let eventTime: string;
const messages: FixtureMessage[] = [];
const previousFlag = process.env.EXTENSIBLE_MARKETS_ENABLED;
const previousAuthority = process.env.BACKOFFICE_SERVICE_URL;

const waitForMessage = async (type: string) => {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const failure = messages.find(message => message.type === "failed");
    if (failure) throw new Error(failure.error);
    const match = messages.find(message => message.type === type);
    if (match) return match;
    await new Promise(complete => setTimeout(complete, 10));
  }
  throw new Error(`Authority fixture did not report ${type}`);
};
beforeAll(async () => {
  child = fork(resolve(__dirname, "../../test/marketAuthorityProcess.ts"), [], {
    cwd: resolve(__dirname, "../../../../backoffice"),
    execArgv: ["-r", require.resolve("ts-node/register/transpile-only")],
    env: { ...process.env, MARKET_AUTHORITY_FIXTURE: "1", EXTENSIBLE_MARKETS_ENABLED: "true",
      TS_NODE_PROJECT: resolve(__dirname, "../../../../backoffice/tsconfig.json") },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr?.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
  // Decode into this realm, like the real AMQP JSON boundary, not Node's outer IPC realm.
  child.on("message", (message: FixtureMessage) => messages.push(JSON.parse(JSON.stringify(message))));
  child.on("exit", code => {
    if (code) messages.push({ type: "failed", error: `Authority fixture exited ${code}: ${diagnostics}` });
  });
  const ready = await waitForMessage("ready");
  endpoint = `http://127.0.0.1:${ready.port}`;
  eventTime = ready.time!;
  process.env.BACKOFFICE_SERVICE_URL = endpoint;
  process.env.EXTENSIBLE_MARKETS_ENABLED = "true";
});
afterAll(async () => {
  if (previousFlag === undefined) delete process.env.EXTENSIBLE_MARKETS_ENABLED;
  else process.env.EXTENSIBLE_MARKETS_ENABLED = previousFlag;
  if (previousAuthority === undefined) delete process.env.BACKOFFICE_SERVICE_URL;
  else process.env.BACKOFFICE_SERVICE_URL = previousAuthority;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(complete => child.once("exit", () => complete()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
});

it("round-trips real source publication and refuses a quoted market when only Backoffice becomes unavailable", async () => {
  const definition = {
    schemaVersion: 1, name: "Total goals", settlementMode: "FINAL_SCORE", outcomeMode: "EXCLUSIVE",
    coverage: "COMPLETE", terms: "Full-time score", parameters: [],
    outcomes: [
      { key: "over", label: "Over 2.5", rule: { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "GT", value: 2.5 } },
      { key: "under", label: "Under 2.5", rule: { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "LT", value: 2.5 } },
    ],
  };
  const source = new EventTemplate("authority-fixture", "Home", "Away", eventTime);
  await Event.create({ eventId: source.eventId, name: source.name, time: source.time, home: source.home,
    away: source.away, products: source.products, ...source.pricingPersistenceFields() });
  const { data: template } = await axios.post(`${endpoint}/api/backoffice/market-templates`, {
    requestId: "template-request", definition,
  });
  const path = `${endpoint}/api/backoffice/events/${source.eventId}/markets`;
  const { data: draft } = await axios.post(path, { requestId: "draft-request", templateId: template.templateId,
    templateVersion: 1, parameters: {} });
  const { data: configured } = await axios.put(`${path}/${draft.marketId}`, { revision: draft.revision, publish: true });
  expect(configured.status).toBe("PUBLISHING");
  expect(configured).toHaveProperty("configuration");
  const configuration = messages.find(message => message.queue === QueueNames.MARKET_CONFIGURED)?.event?.data;
  expect(configuration).toEqual(configured.configuration);
  await storeMarketConfiguration(configuration);
  const worker = new MarketProjectionService(messengerWrapper.connection);
  try { await worker.replayPending(); } finally { await worker.stop(); }
  const publication = jest.mocked(APublisher.prototype.publishWithConfirm).mock.calls
    .map(([message]) => message.data).find(data => data?.kind === "MARKET_AVAILABLE");
  expect(publication?.configuration).toEqual(configuration);
  child.send({ id: 1, publication });
  await waitForMessage("acknowledged");
  expect((await axios.get(path)).data.markets[0].status).toBe("PUBLISHED");
  const cookie = `session=${Buffer.from(JSON.stringify({
    jwt: jwt.sign({ id: "owner", email: "owner@example.test" }, process.env.JWT_KEY!),
  })).toString("base64")}`;
  const quoted = await request(app).post(`/api/event/events/${source.eventId}/market-quotes`)
    .set("Cookie", cookie).send({ requestId: "quote-request", kind: "SINGLE", selections: [{
      origin: "TEMPLATE", marketId: draft.marketId, outcomeKey: "over", quoteRevision: configured.revision,
    }] }).expect(201);
  await axios.post(`${endpoint}/api/backoffice/event_visibility`, { eventId: source.eventId, visibility: "OFFLINE" });
  expect((await Event.findOne({ eventId: source.eventId }))?.visibility).toBe("ONLINE");
  await request(app).get(`/api/event/market-quotes/${quoted.body.quoteId}`).set("Cookie", cookie).expect(409);
});
