import { createServer, Server } from "http";
import request from "supertest";
import jwt from "jsonwebtoken";
import { APublisher, EventMarketConfiguration, MarketDefinition, messengerWrapper } from "@betstan/common";
import { app } from "../../app";
import EventTemplate from "../../data/EventTemplate";
import { Event } from "../../model/Event";
import { MarketProjection, MarketQuote } from "../../model/Market";
import { MarketProjectionService, storeMarketConfiguration } from "../../service/MarketProjectionService";

const definition: MarketDefinition = {
  schemaVersion: 1,
  name: "Total goals",
  settlementMode: "FINAL_SCORE",
  outcomeMode: "EXCLUSIVE",
  coverage: "COMPLETE",
  terms: "Full-time score",
  parameters: [],
  outcomes: [
    { key: "over", label: "Over 2.5", rule: { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "GT", value: 2.5 } },
    { key: "under", label: "Under 2.5", rule: { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "LT", value: 2.5 } },
  ],
};
let authorityServer: Server | undefined;
let authorityUrl: string;
let authorityAvailable = true;
let authorityRequests = 0;
const previousFlag = process.env.EXTENSIBLE_MARKETS_ENABLED;
const previousAuthority = process.env.BACKOFFICE_SERVICE_URL;

beforeAll(async () => {
  await Promise.all([Event.init(), MarketProjection.init(), MarketQuote.init()]);
  const server = createServer((_req, res) => {
    authorityRequests += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ available: authorityAvailable }));
  });
  authorityServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Market authority fixture did not bind a loopback port");
  authorityUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  const server = authorityServer;
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
beforeEach(() => {
  authorityAvailable = true;
  authorityRequests = 0;
  process.env.EXTENSIBLE_MARKETS_ENABLED = "true";
  process.env.BACKOFFICE_SERVICE_URL = authorityUrl;
});
afterEach(() => {
  if (previousFlag === undefined) delete process.env.EXTENSIBLE_MARKETS_ENABLED;
  else process.env.EXTENSIBLE_MARKETS_ENABLED = previousFlag;
  if (previousAuthority === undefined) delete process.env.BACKOFFICE_SERVICE_URL;
  else process.env.BACKOFFICE_SERVICE_URL = previousAuthority;
});

it("refuses a published market quote when the HTTP authority later reports it unavailable", async () => {
  const time = new Date(Date.now() + 600_000).toISOString();
  const source = new EventTemplate("authority-fixture", "Home", "Away", time);
  await Event.create({ eventId: source.eventId, name: source.name, time: source.time, home: source.home,
    away: source.away, products: source.products, ...source.pricingPersistenceFields() });
  const configuration: EventMarketConfiguration = {
    schemaVersion: 1,
    eventId: source.eventId,
    marketId: "authority-market",
    revision: 1,
    rulesRevision: 1,
    template: { id: "authority-template", version: 1, definition, publishedAt: time },
    parameters: {},
    availability: "OPEN",
    configuredAt: time,
    pricing: { method: "SCORE_MODEL" },
  };
  await storeMarketConfiguration(configuration);
  const worker = new MarketProjectionService(messengerWrapper.connection);
  try { await worker.replayPending(); } finally { await worker.stop(); }
  expect(jest.mocked(APublisher.prototype.publishWithConfirm).mock.calls
    .map(([message]) => message.data).some(data => data?.kind === "MARKET_AVAILABLE")).toBe(true);
  const cookie = `session=${Buffer.from(JSON.stringify({
    jwt: jwt.sign({ id: "owner", email: "owner@example.test" }, process.env.JWT_KEY!),
  })).toString("base64")}`;
  const quote = await request(app).post(`/api/event/events/${source.eventId}/market-quotes`)
    .set("Cookie", cookie).send({ requestId: "quote-request", kind: "SINGLE", selections: [{
      origin: "TEMPLATE", marketId: configuration.marketId, outcomeKey: "over", quoteRevision: configuration.revision,
    }] }).expect(201);
  expect(authorityRequests).toBe(1);
  authorityAvailable = false;
  await request(app).get(`/api/event/market-quotes/${quote.body.quoteId}`).set("Cookie", cookie).expect(409);
  expect(authorityRequests).toBe(2);
  expect((await Event.findOne({ eventId: source.eventId }))?.visibility).toBe("ONLINE");
});
