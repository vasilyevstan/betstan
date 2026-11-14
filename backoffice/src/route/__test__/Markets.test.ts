import request from "supertest";
import { createHash } from "crypto";
import { APublisher, compileScoreRule, EventStatus, messengerWrapper, parseMarketDefinition } from "@betstan/common";
import { ConsumeMessage } from "amqplib";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { MarketTemplate } from "../../model/MarketTemplate";
import { MarketPublishedListener } from "../../event/listener/MarketPublishedListener";
import { BackofficePublicationService } from "../../service/BackofficePublicationService";
import { gridLayout, parseMarketLayout } from "../../service/MarketLayout";
import { marketStarters } from "../../service/MarketStarters";

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
const layout = () => gridLayout(parseMarketDefinition(definition), 2);
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

it("snapshots versioned layouts outside pricing authority and retains them after edits and archival", async () => {
  const { template } = await setupMarket();
  const designed = { ...layout(), tiles: [
    { outcomeKey: "a", row: 1, column: 1, width: 2, height: 1 },
    { outcomeKey: "b", row: 2, column: 2, width: 1, height: 2 },
  ] };
  await request(app).put(`/api/backoffice/market-templates/${template.templateId}`)
    .send({ revision: 1, definition, layout: designed }).expect(200);
  await Event.create({ eventId: "event-b", name: "Other - Match", home: "Other", away: "Match", time: "2030-01-01T12:00:00Z" });
  for (const eventId of ["event-a", "event-b"]) {
    const draft = await request(app).post(`/api/backoffice/events/${eventId}/markets`)
      .send({ requestId: "designed", templateId: template.templateId, templateVersion: 2, parameters: {},
        pricing: { method: "OPERATOR", odds: { a: 2, b: 2 } } }).expect(201);
    expect(draft.body.layout).toEqual(designed);
    expect(draft.body.template.layout).toBeUndefined();
    const published = await request(app).put(`/api/backoffice/events/${eventId}/markets/${draft.body.marketId}`)
      .send({ revision: 1, publish: true }).expect(202);
    expect(published.body.layout).toEqual(designed);
    expect(published.body.configuration).not.toHaveProperty("layout");
    expect(published.body.configuration.template).not.toHaveProperty("layout");
  }
  await request(app).put(`/api/backoffice/market-templates/${template.templateId}`)
    .send({ revision: 2, definition, layout: layout() }).expect(200);
  await request(app).put(`/api/backoffice/market-templates/${template.templateId}`)
    .send({ revision: 3, archived: true }).expect(200);
  const listed = await request(app).get("/api/backoffice/events/event-a/markets").expect(200);
  expect(listed.body.markets.find((market: { layout?: unknown }) => market.layout).layout).toEqual(designed);
  const library = await request(app).get("/api/backoffice/market-templates").expect(200);
  expect(library.body.templates[0].versions[1].layout).toEqual(designed);
  expect(library.body.templates[0].versions[2].layout).toEqual(layout());
});

it("includes design content in idempotency and rejects edits through archive or instance requests", async () => {
  const body = { requestId: "designed-template", definition, layout: layout() };
  const created = await request(app).post("/api/backoffice/market-templates").send(body).expect(201);
  await request(app).post("/api/backoffice/market-templates").send(body).expect(200);
  await request(app).post("/api/backoffice/market-templates")
    .send({ ...body, layout: { ...layout(), tileShape: "pill" } }).expect(409);
  await request(app).put(`/api/backoffice/market-templates/${created.body.templateId}`)
    .send({ revision: 1, archived: true, layout: layout() }).expect(400);
  const { market } = await setupMarket();
  await request(app).put(`/api/backoffice/events/event-a/markets/${market.marketId}`)
    .send({ revision: 1, layout: layout() }).expect(400);
});

it("keeps stored versions safe for predecessor writers and replays their layout-free instances", async () => {
  await Event.create({ eventId: "legacy-event", name: "Old - New", home: "Old", away: "New", time: "2030-01-01T12:00:00Z" });
  const created = await request(app).post("/api/backoffice/market-templates")
    .send({ requestId: "designed", definition, layout: layout() }).expect(201);
  const stored = await MarketTemplate.findOne({ templateId: created.body.templateId }).lean();
  const template = stored!.versions[0];
  expect(template).not.toHaveProperty("layout");
  expect(stored!.layouts?.["1"]).toEqual(layout());
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const marketId = hash(["legacy-event", "legacy-request"]).slice(0, 32);
  const pricing = { method: "OPERATOR", odds: { a: 2, b: 2 } };
  // This is the predecessor writer's exact instance/fingerprint shape.
  await Event.updateOne({ eventId: "legacy-event" }, { $push: { customMarkets: {
    marketId, creationFingerprint: hash({ template, parameters: {}, pricing }), template,
    revision: 1, rulesRevision: 1, parameters: {}, pricing, availability: "OPEN", status: "DRAFT",
    configuredAt: new Date().toISOString(),
  } } });
  const replay = await request(app).post("/api/backoffice/events/legacy-event/markets").send({
    requestId: "legacy-request", templateId: created.body.templateId, templateVersion: 1, parameters: {}, pricing,
  }).expect(200);
  expect(replay.body.marketId).toBe(marketId);
  expect(replay.body.layout).toBeUndefined();
  await request(app).put(`/api/backoffice/events/legacy-event/markets/${marketId}`).send({ revision: 1, publish: true }).expect(202);
  expect(JSON.stringify(jest.mocked(APublisher.prototype.publishWithConfirm).mock.calls)).not.toContain('"layout"');
});

it.each([
  { ...layout(), tiles: [] },
  { ...layout(), columns: 5 },
  { ...layout(), tileShape: "url(javascript:alert(1))" },
  { ...layout(), html: "<script></script>" },
  { ...layout(), tiles: [layout().tiles[0], layout().tiles[0]] },
  { ...layout(), tiles: [layout().tiles[0], { ...layout().tiles[1], column: 1 }] },
  { ...layout(), tiles: [layout().tiles[0], { ...layout().tiles[1], width: 2 }] },
  { ...layout(), tiles: [layout().tiles[0], { ...layout().tiles[1], outcomeKey: "unknown" }] },
  { ...layout(), tiles: [layout().tiles[0], { ...layout().tiles[1], row: 64, height: 2 }] },
  { ...layout(), tiles: [layout().tiles[0], { ...layout().tiles[1], row: 1.5 }] },
])("rejects malformed, overlapping or outcome-changing layouts %#", async invalid => {
  await request(app).post("/api/backoffice/market-templates")
    .send({ requestId: "bad-layout", definition, layout: invalid }).expect(400);
  expect(await MarketTemplate.countDocuments()).toBe(0);
});

it.each(["1x2", "correct-score"])("copies %s into independent versions without changing the starter", async starterId => {
  const library = await request(app).get("/api/backoffice/market-templates").expect(200);
  const original = library.body.starters.find((item: { id: string }) => item.id === starterId);
  const created = await request(app).post("/api/backoffice/market-templates")
    .send({ requestId: starterId, starterId }).expect(201);
  const renamed = { ...original.definition, name: "My match market" };
  const redesigned = { ...original.layout, tileShape: "pill" };
  const updated = await request(app).put(`/api/backoffice/market-templates/${created.body.templateId}`)
    .send({ revision: 1, definition: renamed, layout: redesigned }).expect(200);
  expect(updated.body.versions[0].definition).toEqual(original.definition);
  expect(updated.body.versions[1]).toMatchObject({ definition: renamed, layout: redesigned });
  const unchanged = await request(app).get("/api/backoffice/market-templates").expect(200);
  expect(unchanged.body.starters.find((item: { id: string }) => item.id === starterId)).toEqual(original);
});

it("settles exact-score copies only on their listed score and retains partial coverage", () => {
  const parsed = parseMarketDefinition(marketStarters.find(item => item.id === "correct-score")!.definition);
  expect(parsed.coverage).toBe("PARTIAL");
  const outcomes = parsed.outcomes.map(outcome => ({ label: outcome.label, win: compileScoreRule(outcome.rule) }));
  for (let home = 0; home <= 99; home += 1) {
    for (let away = 0; away <= 99; away += 1) {
      expect(outcomes.filter(outcome => outcome.win(home, away)).map(outcome => outcome.label))
        .toEqual(parsed.outcomes.filter(outcome => outcome.label === `${home} - ${away}`).map(outcome => outcome.label));
    }
  }
});

it("supplies valid complete score starters, including full-time result copies", async () => {
  for (const id of ["1x2", "result-both-score", "winning-margin", "total-goals-bands"]) {
    const starter = marketStarters.find(item => item.id === id)!;
    const parsed = parseMarketDefinition(starter.definition);
    expect(parseMarketLayout(starter.layout, parsed)).toEqual(starter.layout);
    const wins = parsed.outcomes.map(outcome => compileScoreRule(outcome.rule));
    for (let home = 0; home <= 99; home += 1) {
      for (let away = 0; away <= 99; away += 1) {
        expect(wins.filter(win => win(home, away))).toHaveLength(1);
        if (id === "1x2") expect(parsed.outcomes[wins.findIndex(win => win(home, away))].key)
          .toBe(home > away ? "home" : home === away ? "draw" : "away");
      }
    }
    await request(app).post("/api/backoffice/market-templates")
      .send({ requestId: id, starterId: id, layout: starter.layout }).expect(201);
  }
});

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

it("keeps an unpriced manual draft editable when publication or operator prices are invalid", async () => {
  const { template } = await setupMarket();
  const draft = await request(app).post("/api/backoffice/events/event-a/markets").send({
    requestId: "unpriced", templateId: template.templateId, templateVersion: 1, parameters: {},
  }).expect(201);
  const url = `/api/backoffice/events/event-a/markets/${draft.body.marketId}`;
  await request(app).put(url).send({ revision: 1, publish: true }).expect(400);
  await request(app).put(url).send({
    revision: 1, pricing: { method: "OPERATOR", odds: { a: 0, b: 2 } }, publish: true,
  }).expect(400);
  const current = await request(app).get("/api/backoffice/events/event-a/markets").expect(200);
  const unchanged = current.body.markets.find((market: { marketId: string }) => market.marketId === draft.body.marketId);
  expect(unchanged).toMatchObject({ revision: 1, status: "DRAFT" });
  expect(unchanged.configuration).toBeUndefined();
  const published = await request(app).put(url).send({
    revision: 1, pricing: { method: "OPERATOR", odds: { a: 2, b: 2 } }, publish: true,
  }).expect(202);
  expect(published.body.configuration.pricing).toEqual({ method: "OPERATOR", odds: { a: 2, b: 2 } });
});

it("binds a reusable score starter independently and publishes model pricing without operator odds", async () => {
  await setupMarket();
  const template = await request(app).post("/api/backoffice/market-templates")
    .send({ requestId: "score-template", starterId: "total-goals" }).expect(201);
  const first = await request(app).post("/api/backoffice/events/event-a/markets").send({
    requestId: "total-first", templateId: template.body.templateId, templateVersion: 1, parameters: { line: 2.5 },
  }).expect(201);
  const second = await request(app).post("/api/backoffice/events/event-a/markets").send({
    requestId: "total-second", templateId: template.body.templateId, templateVersion: 1, parameters: { line: 3.5 },
  }).expect(201);
  expect(first.body.pricing).toEqual({ method: "SCORE_MODEL" });
  const published = await request(app).put(`/api/backoffice/events/event-a/markets/${first.body.marketId}`)
    .send({ revision: 1, parameters: { line: 1.5 }, publish: true }).expect(202);
  expect(published.body.configuration).toMatchObject({
    parameters: { line: 1.5 }, pricing: { method: "SCORE_MODEL" },
    template: { id: template.body.templateId, version: 1 },
  });
  const current = await request(app).get("/api/backoffice/events/event-a/markets").expect(200);
  expect(current.body.markets.find((market: { marketId: string }) => market.marketId === second.body.marketId))
    .toMatchObject({ parameters: { line: 3.5 }, revision: 1, status: "DRAFT" });
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
