import request from "supertest";
import { APublisher, EventStatus, messengerWrapper } from "@betstan/common";
import { ConsumeMessage } from "amqplib";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { MarketTemplate } from "../../model/MarketTemplate";
import { MarketPublishedListener } from "../../event/listener/MarketPublishedListener";
import { BackofficePublicationService } from "../../service/BackofficePublicationService";

const definition = {
  schemaVersion: 1, name: "Player of the match", settlementMode: "MANUAL", outcomeMode: "EXCLUSIVE",
  coverage: "COMPLETE", terms: "Operator declares the winning nominee.", parameters: [],
  outcomes: [{ key: "a", label: "Nominee A" }, { key: "b", label: "Nominee B" }],
};
const message = (): ConsumeMessage => ({
  content: Buffer.alloc(0),
  fields: { consumerTag: "", deliveryTag: 0, redelivered: false, exchange: "", routingKey: "" },
  properties: {
    contentType: undefined, contentEncoding: undefined, headers: {}, deliveryMode: undefined,
    priority: undefined, correlationId: undefined, replyTo: undefined, expiration: undefined,
    messageId: undefined, timestamp: undefined, type: undefined, userId: undefined, appId: undefined, clusterId: undefined,
  },
});
const previousFlag = process.env.EXTENSIBLE_MARKETS_ENABLED;
beforeAll(async () => { await MarketTemplate.init(); });
beforeEach(() => { process.env.EXTENSIBLE_MARKETS_ENABLED = "true"; });
afterEach(() => {
  if (previousFlag === undefined) delete process.env.EXTENSIBLE_MARKETS_ENABLED;
  else process.env.EXTENSIBLE_MARKETS_ENABLED = previousFlag;
});

const setupMarket = async () => {
  await Event.create({ eventId: "event-a", name: "Home - Away", home: "Home", away: "Away", time: "2030-01-01T12:00:00.000Z" });
  const template = await request(app).post("/api/backoffice/market-templates")
    .send({ requestId: "template-request", definition }).expect(201);
  const market = await request(app).post("/api/backoffice/events/event-a/markets").send({
    requestId: "market-request", templateId: template.body.templateId, templateVersion: 1, parameters: {},
    pricing: { method: "OPERATOR", odds: { a: 2, b: 2 } },
  }).expect(201);
  return { template: template.body, market: market.body };
};
const publishMarket = async (marketId: string) => {
  const published = await request(app).put(`/api/backoffice/events/event-a/markets/${marketId}`)
    .send({ revision: 1, publish: true });
  expect(published.body).toMatchObject({ status: "PUBLISHING" });
  expect(published.status).toBe(202);
  const configuration = published.body.configuration;
  const listener = new MarketPublishedListener(messengerWrapper.connection);
  await listener.onMessage({ data: {
    kind: "MARKET_AVAILABLE", schemaVersion: 1, eventId: "event-a", marketId,
    revision: configuration.revision, occurredAt: configuration.configuredAt, configuration,
    preview: { method: "OPERATOR", odds: { a: 2, b: 2 } },
  } }, message());
  return configuration;
};

it("shares manual-result confirmation between concurrent HTTP publication and replay", async () => {
  const { market } = await setupMarket();
  await publishMarket(market.marketId);
  const send = jest.mocked(APublisher.prototype.publishWithConfirm);
  send.mockRejectedValueOnce(new Error("broker unavailable"));
  await request(app).post(`/api/backoffice/events/event-a/markets/${market.marketId}/result`)
    .send({ requestId: "decision", revision: 2, result: "SETTLED", winningOutcomeKeys: ["a"] }).expect(202);
  send.mockClear();
  let release!: () => void;
  let started!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  send.mockImplementationOnce(() => {
    started();
    return new Promise<void>(resolve => { release = resolve; });
  });
  const service = new BackofficePublicationService(messengerWrapper.connection);
  const first = service.publishMarketsNow("event-a");
  await sending;
  const replay = service.replayPending();
  const identical = service.publishMarketsNow("event-a");
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  release();
  expect(await first).toBe(1);
  expect(await identical).toBe(1);
  await replay;
  expect(send).toHaveBeenCalledTimes(1);
  const saved = await request(app).get("/api/backoffice/events/event-a/markets").expect(200);
  expect(saved.body.markets[0].resultPublicationPending).toBeUndefined();
  await service.stop();
});

it("keeps reusable versions immutable, protects optimistic edits and archives without deleting them", async () => {
  const { template } = await setupMarket();
  await request(app).post("/api/backoffice/market-templates")
    .send({ requestId: "template-request", definition }).expect(200);
  await request(app).post("/api/backoffice/market-templates")
    .send({ requestId: "template-request", definition: { ...definition, name: "Conflicting" } }).expect(409);
  const edited = await request(app).put(`/api/backoffice/market-templates/${template.templateId}`)
    .send({ revision: 1, definition: { ...definition, name: "Updated template" } }).expect(200);
  expect(edited.body.versions.map((version: { definition: { name: string } }) => version.definition.name))
    .toEqual(["Player of the match", "Updated template"]);
  await request(app).put(`/api/backoffice/market-templates/${template.templateId}`)
    .send({ revision: 1, definition }).expect(409);
  await request(app).put(`/api/backoffice/market-templates/${template.templateId}`)
    .send({ revision: 2, archived: true }).expect(200);
  await request(app).post("/api/backoffice/events/event-a/markets").send({
    requestId: "another-market", templateId: template.templateId, templateVersion: 1, parameters: {},
  }).expect(404);
  const event = await request(app).get("/api/backoffice/events/event-a/markets").expect(200);
  expect(event.body.markets[0].template.definition.name).toBe("Player of the match");
});

it("creates draft instances idempotently and publishes only an explicit reviewed revision", async () => {
  const { template, market } = await setupMarket();
  const replay = await request(app).post("/api/backoffice/events/event-a/markets").send({
    requestId: "market-request", templateId: template.templateId, templateVersion: 1, parameters: {},
    pricing: { method: "OPERATOR", odds: { a: 2, b: 2 } },
  }).expect(200);
  expect(replay.body.marketId).toBe(market.marketId);
  expect(replay.body.status).toBe("DRAFT");
  const configuration = await publishMarket(market.marketId);
  expect(configuration.template.version).toBe(1);
  const current = await request(app).get("/api/backoffice/events/event-a/markets").expect(200);
  expect(current.body.markets[0].publishedConfiguration).toEqual(configuration);
  expect(current.body.markets[0].creationFingerprint).toBeUndefined();
  await request(app).put(`/api/backoffice/events/event-a/markets/${market.marketId}`)
    .send({ revision: 1, availability: "SUSPENDED", publish: true }).expect(409);
});

it("keeps manual settlement available after kickoff and writer disablement, with immutable idempotent decisions", async () => {
  const { market } = await setupMarket();
  await publishMarket(market.marketId);
  await Event.updateOne({ eventId: "event-a" }, { $set: { status: EventStatus.RESULTED, time: "2020-01-01T00:00:00.000Z" } });
  delete process.env.EXTENSIBLE_MARKETS_ENABLED;
  const body = { requestId: "decision", revision: 2, result: "SETTLED", winningOutcomeKeys: ["a"] };
  const first = await request(app).post(`/api/backoffice/events/event-a/markets/${market.marketId}/result`)
    .send(body).expect(200);
  const replay = await request(app).post(`/api/backoffice/events/event-a/markets/${market.marketId}/result`)
    .send(body).expect(200);
  expect(replay.body.decision).toEqual(first.body.decision);
  await request(app).post(`/api/backoffice/events/event-a/markets/${market.marketId}/result`)
    .send({ ...body, winningOutcomeKeys: ["b"] }).expect(409);
  await request(app).post("/api/backoffice/market-templates").send({ requestId: "disabled", definition }).expect(503);
});

it("retains a failed manual publication for replay instead of reporting it published", async () => {
  const { market } = await setupMarket();
  await publishMarket(market.marketId);
  jest.mocked(APublisher.prototype.publishWithConfirm).mockRejectedValueOnce(new Error("broker unavailable"));
  const result = await request(app).post(`/api/backoffice/events/event-a/markets/${market.marketId}/result`)
    .send({ requestId: "decision", revision: 2, result: "VOID", winningOutcomeKeys: [] }).expect(202);
  expect(result.body.publication).toBe("PENDING");
  const saved = await Event.findOne({ eventId: "event-a" }).select("+customMarkets").lean();
  expect(saved?.customMarkets[0].resultPublicationPending).toBe(true);
  const replay = await request(app).post(`/api/backoffice/events/event-a/markets/${market.marketId}/result`)
    .send({ requestId: "decision", revision: 2, result: "VOID", winningOutcomeKeys: [] }).expect(200);
  expect(replay.body.decision).toEqual(result.body.decision);
});

it("does not bypass existing source reservations when declaring a market result", async () => {
  const { market } = await setupMarket();
  await publishMarket(market.marketId);
  await Event.collection.updateOne({ eventId: "event-a" }, { $set: { cashBackHold: { requestFingerprint: "reserved", grant: {} } } });
  await request(app).post(`/api/backoffice/events/event-a/markets/${market.marketId}/result`)
    .send({ requestId: "decision", revision: 2, result: "VOID", winningOutcomeKeys: [] }).expect(409);
  const saved = await Event.findOne({ eventId: "event-a" }).select("+customMarkets").lean();
  expect(saved?.customMarkets[0].decision).toBeUndefined();
});

it("keeps drafts separate from active authority and immediately blocks publishing changes and settled markets", async () => {
  const { market } = await setupMarket();
  await publishMarket(market.marketId);
  const validate = () => request(app).post("/api/backoffice/events/event-a/markets/validate").send({
    markets: [{ marketId: market.marketId, revision: 2, rulesRevision: 1 }],
  });
  expect((await validate().expect(200)).body.available).toBe(true);
  await request(app).put(`/api/backoffice/events/event-a/markets/${market.marketId}`)
    .send({ revision: 2, pricing: { method: "OPERATOR", odds: { a: 3, b: 1.5 } } }).expect(200);
  expect((await validate().expect(200)).body.available).toBe(true);
  await request(app).put(`/api/backoffice/events/event-a/markets/${market.marketId}`)
    .send({ revision: 3, availability: "SUSPENDED", publish: true }).expect(202);
  expect((await validate().expect(200)).body.available).toBe(false);
  const listener = new MarketPublishedListener(messengerWrapper.connection);
  await listener.onMessage({ data: {
    kind: "MARKET_REJECTED", schemaVersion: 1, eventId: "event-a", marketId: market.marketId,
    revision: 4, occurredAt: new Date().toISOString(), reason: "Rejected update",
  } }, message());
  expect((await validate().expect(200)).body.available).toBe(true);
  await request(app).post(`/api/backoffice/events/event-a/markets/${market.marketId}/result`)
    .send({ requestId: "decision", revision: 4, result: "VOID", winningOutcomeKeys: [] }).expect(200);
  expect((await validate().expect(200)).body.available).toBe(false);
});
