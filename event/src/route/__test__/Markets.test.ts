import request from "supertest";
import jwt from "jsonwebtoken";
import axios from "axios";
import {
  APublisher, BettingStatus, EventMarketConfiguration, EventPhase, EventStatus, EventVisibility,
  LiveMarketStatus, LiveMarketType, MarketDefinition, messengerWrapper, parseMarketBet, TeamSide,
  priceScoreCombination,
} from "@betstan/common";
import { app } from "../../app";
import EventTemplate from "../../data/EventTemplate";
import { Event } from "../../model/Event";
import { MarketProjection, MarketQuote } from "../../model/Market";
import {
  findMarketEvent, MarketProjectionService, standardSelections, storeMarketConfiguration,
} from "../../service/MarketProjectionService";
import { createMarketQuote, validateMarketQuote } from "../../service/MarketQuoteService";

const totals: MarketDefinition = {
  schemaVersion: 1, name: "Total goals", settlementMode: "FINAL_SCORE", outcomeMode: "EXCLUSIVE",
  coverage: "COMPLETE", terms: "Full-time score", parameters: [],
  outcomes: [
    { key: "over", label: "Over 2.5", rule: { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "GT", value: 2.5 } },
    { key: "under", label: "Under 2.5", rule: { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "LT", value: 2.5 } },
  ],
};
const manual: MarketDefinition = {
  schemaVersion: 1, name: "1X2", settlementMode: "MANUAL", outcomeMode: "EXCLUSIVE",
  coverage: "COMPLETE", terms: "Operator declares the winner", parameters: [],
  outcomes: [{ key: "one", label: "First nominee" }, { key: "two", label: "Second nominee" }],
};
const configuration = (definition = totals, marketId = "total-goals"): EventMarketConfiguration => ({
  schemaVersion: 1, eventId: "event-a", marketId, revision: 1, rulesRevision: 1,
  template: { id: marketId, version: 1, definition, publishedAt: "2025-01-01T00:00:00.000Z" },
  parameters: {}, availability: "OPEN", configuredAt: "2025-01-01T00:00:00.000Z",
  pricing: definition.settlementMode === "MANUAL"
    ? { method: "OPERATOR", odds: { one: 2, two: 2 } } : { method: "SCORE_MODEL" },
});
const selection = (marketId: string, outcomeKey: string) =>
  ({ origin: "TEMPLATE", marketId, outcomeKey, quoteRevision: 1 });
const createEvent = async () => {
  const template = new EventTemplate("event-a", "Home", "Away", "2030-01-01T12:00:00.000Z");
  await Event.create({
    eventId: template.eventId, name: template.name, time: template.time, home: template.home,
    away: template.away, products: template.products, ...template.pricingPersistenceFields(),
  });
  return template;
};
const worker = () => new MarketProjectionService(messengerWrapper.connection);
const enableMarket = async (definition = totals, marketId = "total-goals") => {
  await storeMarketConfiguration(configuration(definition, marketId));
  const service = worker();
  await service.replayPending();
  await service.stop();
};
const session = (id: string) => [`session=${Buffer.from(JSON.stringify({
  jwt: jwt.sign({ id, email: `${id}@example.invalid` }, process.env.JWT_KEY!),
})).toString("base64")}`];
const previousFlag = process.env.EXTENSIBLE_MARKETS_ENABLED;
const previousAuthority = process.env.BACKOFFICE_SERVICE_URL;

beforeAll(async () => { await Promise.all([MarketProjection.init(), MarketQuote.init()]); });
beforeEach(() => {
  process.env.EXTENSIBLE_MARKETS_ENABLED = "true";
  process.env.BACKOFFICE_SERVICE_URL = "http://backoffice.invalid";
  jest.spyOn(axios, "post").mockResolvedValue({ data: { available: true } });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previousFlag === undefined) delete process.env.EXTENSIBLE_MARKETS_ENABLED;
  else process.env.EXTENSIBLE_MARKETS_ENABLED = previousFlag;
  if (previousAuthority === undefined) delete process.env.BACKOFFICE_SERVICE_URL;
  else process.env.BACKOFFICE_SERVICE_URL = previousAuthority;
});

it("replays pending configurations and confirmed publications without changing their immutable authority", async () => {
  const config = configuration();
  await storeMarketConfiguration(config);
  const service = worker();
  await service.replayPending();
  expect((await MarketProjection.findOne({ marketId: config.marketId }))?.processingPending).toBe(true);
  await createEvent();
  jest.mocked(APublisher.prototype.publishWithConfirm).mockRejectedValueOnce(new Error("broker unavailable"));
  await service.replayPending();
  const failed = await MarketProjection.findOne({ marketId: config.marketId }).lean();
  expect(failed?.publicationPending).toBe(true);
  expect(failed?.publication?.kind).toBe("MARKET_AVAILABLE");
  await service.replayPending();
  const completed = await MarketProjection.findOne({ marketId: config.marketId }).lean();
  expect(completed?.publicationPending).toBe(false);
  expect(completed?.publication).toEqual(failed?.publication);
  await storeMarketConfiguration(config);
  await expect(storeMarketConfiguration({ ...config, availability: "SUSPENDED" })).rejects.toThrow("Conflicting immutable");
  expect((await MarketProjection.findOne({ marketId: config.marketId }))?.configuration).toEqual(config);
  await service.stop();
});

it("prices a Builder from joint probability, retains one model and deduplicates reordered requests", async () => {
  const event = await createEvent();
  await enableMarket();
  const persisted = await findMarketEvent("event-a");
  const home = standardSelections(persisted!)[0];
  const selections = [
    { origin: "STANDARD", marketId: home.marketId, outcomeKey: home.outcomeKey, quoteRevision: 1 },
    selection("total-goals", "over"),
  ];
  const quote = await createMarketQuote("user-a", "event-a", { requestId: "builder-a", kind: "BUILDER", selections });
  expect(quote.modelId).toBe(event.pricingModel?.id);
  expect(quote.odds).toBe(priceScoreCombination(event.pricingModel, quote.selections.flatMap(item =>
    item.settlementMode === "FINAL_SCORE" ? [item.rule] : [])));
  const replay = await createMarketQuote("user-a", "event-a", {
    requestId: "builder-a", kind: "BUILDER", selections: selections.slice().reverse(),
  });
  expect(replay).toEqual(quote);
  expect(await MarketQuote.countDocuments()).toBe(1);
});

it("rejects impossible combinations, duplicate legs and manual markets disguised by a standard name", async () => {
  await createEvent();
  await enableMarket();
  await enableMarket(manual, "manual");
  await expect(createMarketQuote("user-a", "event-a", {
    requestId: "impossible", kind: "BUILDER",
    selections: [selection("total-goals", "over"), selection("total-goals", "under")],
  })).rejects.toThrow("impossible");
  await expect(createMarketQuote("user-a", "event-a", {
    requestId: "duplicate", kind: "BUILDER",
    selections: [selection("total-goals", "over"), selection("total-goals", "over")],
  })).rejects.toThrow("twice");
  await expect(createMarketQuote("user-a", "event-a", {
    requestId: "manual-builder", kind: "BUILDER",
    selections: [selection("total-goals", "over"), selection("manual", "one")],
  })).rejects.toThrow("Manual and overridden");
  const quote = await createMarketQuote("user-a", "event-a", {
    requestId: "manual-single", kind: "SINGLE", selections: [selection("manual", "one")],
  });
  expect(quote.selections[0]).toMatchObject({ marketName: "1X2", settlementMode: "MANUAL" });
  expect(quote.modelId).toBeUndefined();
});

it("checks source suspension even while the Event projection still says open", async () => {
  await createEvent();
  await enableMarket();
  const quote = await createMarketQuote("user-a", "event-a", {
    requestId: "single", kind: "SINGLE", selections: [selection("total-goals", "over")],
  });
  jest.mocked(axios.post).mockResolvedValue({ data: { available: false } });
  await expect(validateMarketQuote("user-a", quote)).rejects.toThrow("suspended");
  jest.mocked(axios.post).mockRejectedValue(new Error("authority unreachable"));
  await expect(validateMarketQuote("user-a", quote)).rejects.toThrow("could not be verified");
});

it("rejects other owners, price tampering, expiry and disabled new acceptance", async () => {
  await createEvent();
  await enableMarket();
  const quote = await createMarketQuote("user-a", "event-a", {
    requestId: "single", kind: "SINGLE", selections: [selection("total-goals", "over")],
  });
  await expect(validateMarketQuote("user-b", quote)).rejects.toThrow("owner");
  await expect(validateMarketQuote("user-a", { ...quote, odds: 9.99 })).rejects.toThrow("owner");
  const expired = parseMarketBet({ ...quote, issuedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:00:30.000Z" });
  await MarketQuote.updateOne({ quoteId: quote.quoteId }, { $set: { quote: expired } });
  await expect(validateMarketQuote("user-a", expired)).rejects.toThrow("expired");
  delete process.env.EXTENSIBLE_MARKETS_ENABLED;
  await expect(validateMarketQuote("user-a", quote)).rejects.toThrow("not enabled");
});

it("exposes public odds previews but requires the registered owner to issue or retrieve a quote", async () => {
  await createEvent();
  await enableMarket(manual, "manual");
  const preview = await request(app).post("/api/event/events/event-a/markets/preview")
    .send({ definition: manual, parameters: {}, generation: { method: "WEIGHTS", values: { one: 1, two: 3 } } }).expect(200);
  expect(preview.body.odds.one).toBeGreaterThan(preview.body.odds.two);
  const body = { requestId: "single", kind: "SINGLE", selections: [selection("manual", "one")] };
  await request(app).post("/api/event/events/event-a/market-quotes").send(body).expect(401);
  const quote = await request(app).post("/api/event/events/event-a/market-quotes")
    .set("Cookie", session("user-a")).send(body).expect(201);
  const selected = await request(app).get(`/api/event/market-quotes/${quote.body.quoteId}`)
    .set("Cookie", session("user-a")).expect(200);
  expect(selected.body).toMatchObject({ userId: "user-a", productName: "Custom market", marketBet: quote.body });
  await request(app).get(`/api/event/market-quotes/${quote.body.quoteId}`).set("Cookie", session("user-b")).expect(409);
});

it("paginates every open event beyond the public horizon, excluding closed and unresolved visibility", async () => {
  await createEvent();
  const live = {
    sequence: 1, occurredAt: new Date().toISOString(), kickoffAt: "2020-01-01T12:00:00.000Z",
    minute: 70, phase: EventPhase.SECOND_HALF, homeScore: 0, awayScore: 0, bettingStatus: BettingStatus.OPEN,
    incidentHistory: [], currentMarkets: [],
  };
  await Event.create([
    { eventId: "event-z", name: "Far future", time: "2099-01-01T12:00:00.000Z", products: [] },
    { eventId: "event-live", name: "Paused live", time: live.kickoffAt, products: [], live, liveEnabled: false },
    { eventId: "event-offline", name: "Offline", time: "2099-01-01T12:00:00.000Z", products: [], visibility: EventVisibility.OFFLINE },
    { eventId: "event-resulted", name: "Resulted", time: "2099-01-01T12:00:00.000Z", products: [], status: EventStatus.RESULTED },
    { eventId: "event-finished", name: "Finished", time: live.kickoffAt, products: [], live: { ...live, phase: EventPhase.FULL_TIME } },
    { eventId: "event-pending", name: "Pending offline", time: "2099-01-01T12:00:00.000Z", products: [], pendingVisibility: EventVisibility.OFFLINE },
    { eventId: "event-unresolved", name: "Unresolved", time: "2099-01-01T12:00:00.000Z", products: [], visibilityInitialized: false },
  ]);
  const first = await request(app).get("/api/event/risk-events?limit=1").expect(200);
  expect(first.headers["cache-control"]).toBe("no-store");
  expect(first.body.events.map((item: { eventId: string }) => item.eventId)).toEqual(["event-a"]);
  expect(first.body.nextAfter).toBe("event-a");
  const rest = await request(app).get("/api/event/risk-events?after=event-a&limit=25").expect(200);
  expect(rest.body.events.map((item: { eventId: string }) => item.eventId)).toEqual(["event-live", "event-z"]);
  expect(rest.body.nextAfter).toBeNull();
  await request(app).get("/api/event/risk-events/event-pending").expect(409);
  await request(app).get("/api/event/risk-events?limit=0").expect(400);
  await request(app).get("/api/event/risk-events?limit=1&limit=2").expect(400);
  await request(app).get("/api/event/risk-events?after[$ne]=event-a").expect(400);
});

it("retains suspended published custom choices alongside exact standard identities", async () => {
  const event = await createEvent();
  await enableMarket(manual, "award");
  await storeMarketConfiguration({ ...configuration(manual, "award"), revision: 2, availability: "SUSPENDED" });
  const service = worker();
  await service.replayPending();
  await service.stop();
  const response = await request(app).get("/api/event/risk-events/event-a").expect(200);
  expect(response.body.choices).toEqual(expect.arrayContaining([
    expect.objectContaining({ origin: "STANDARD", marketId: event.products[0].id,
      outcomeKey: event.products[0].odds[0].id, sourceOpen: true }),
    expect.objectContaining({ origin: "TEMPLATE", marketId: "award", outcomeKey: "one", sourceOpen: false }),
  ]));
});

it("keeps distinct live score selections and exposes source pauses without dropping the event", async () => {
  await createEvent();
  const marketId = `event-a:${LiveMarketType.SECOND_HALF_SCORE}`;
  await Event.updateOne({ eventId: "event-a" }, { $set: { time: "2020-01-01T12:00:00.000Z", liveEnabled: false, live: {
    sequence: 1, occurredAt: new Date().toISOString(), kickoffAt: "2020-01-01T12:00:00.000Z",
    minute: 70, phase: EventPhase.SECOND_HALF, homeScore: 0, awayScore: 0, bettingStatus: BettingStatus.OPEN,
    incidentHistory: [], currentMarkets: [{
      marketId, marketType: LiveMarketType.SECOND_HALF_SCORE, marketVersion: 3, quoteVersion: 4,
      quoteValidUntil: "2099-01-01T12:00:00.000Z", status: LiveMarketStatus.OPEN,
      selections: ["SCORE_1_0", "SCORE_0_1"].map(key => ({
        selectionId: `${marketId}:3:${key}`, side: TeamSide.NONE, odds: 5, label: key,
      })),
    }],
  } } });
  const response = await request(app).get("/api/event/risk-events/event-a").expect(200);
  expect(response.body.choices.map((item: { outcomeKey: string }) => item.outcomeKey))
    .toEqual([`${marketId}:3:SCORE_1_0`, `${marketId}:3:SCORE_0_1`]);
  expect(response.body.choices.every((item: { sourceOpen: boolean }) => !item.sourceOpen)).toBe(true);
});
