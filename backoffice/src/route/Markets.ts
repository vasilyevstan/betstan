import express, { Request, Response, RequestHandler } from "express";
import { createHash } from "crypto";
import {
  bindMarketParameters, EventStatus, EventVisibility, marketKey, marketObject, marketRevision, MarketValidationError,
  messengerWrapper, parseEventMarketConfiguration, parseManualMarketDecision, parseMarketDefinition,
  parseMarketPricingInstruction,
} from "@betstan/common";
import { Event } from "../model/Event";
import { EventMarket, publicEventMarket } from "../model/EventMarket";
import { MarketTemplate, publicMarketTemplate } from "../model/MarketTemplate";
import { cashBackAuthorityWritable } from "../service/CashBackSourceService";
import { marketStarters } from "../service/MarketStarters";
import { parseMarketLayout } from "../service/MarketLayout";
import { getBackofficePublicationService } from "../service/BackofficePublicationService";

const router = express.Router();
const writingEnabled = () => process.env.EXTENSIBLE_MARKETS_ENABLED === "true";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nextRevision = (value: unknown) => {
  const revision = marketRevision(value);
  if (revision === Number.MAX_SAFE_INTEGER) throw new MarketValidationError("Revision is exhausted");
  return revision + 1;
};
const run = (action: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { void action(req, res).catch(error => {
    if (error instanceof MarketValidationError) res.status(400).send({ message: error.message });
    else next(error);
  }); };
const requireWriting: RequestHandler = (_req, res, next) => {
  if (!writingEnabled()) { res.status(503).send({ message: "New custom markets are not enabled" }); return; }
  next();
};

router.get("/api/backoffice/market-templates", run(async (_req, res) => {
  const templates = await MarketTemplate.find().sort({ templateId: 1 }).lean();
  res.send({ enabled: writingEnabled(), templates: templates.map(publicMarketTemplate), starters: marketStarters });
}));

router.post("/api/backoffice/market-templates", requireWriting, run(async (req, res) => {
  const body = marketObject(req.body, ["requestId", "definition", "starterId", "layout"], "Template creation");
  const requestId = marketKey(body.requestId, "Request id");
  const starter = body.starterId === undefined ? undefined : marketStarters.find(item => item.id === body.starterId);
  if (body.starterId !== undefined && !starter) throw new MarketValidationError("Unknown starter template");
  const definition = parseMarketDefinition(starter?.definition ?? body.definition);
  const layout = body.layout === undefined ? undefined : parseMarketLayout(body.layout, definition);
  const templateId = hash(["template", requestId]).slice(0, 32);
  const fingerprint = hash(layout ? { definition, layout } : definition);
  try {
    const template = await MarketTemplate.create({
      templateId, revision: 1, archived: false, creationFingerprint: fingerprint,
      versions: [{ id: templateId, version: 1, definition, publishedAt: new Date().toISOString() }],
      ...(layout ? { layouts: { "1": layout } } : {}),
    });
    res.status(201).send(publicMarketTemplate(template.toObject()));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
    const existing = await MarketTemplate.findOne({ templateId }).select("+creationFingerprint").lean();
    if (existing?.creationFingerprint !== fingerprint) {
      res.status(409).send({ message: "Request id was already used for a different template" }); return;
    }
    res.send(publicMarketTemplate(existing));
  }
}));

router.put("/api/backoffice/market-templates/:templateId", requireWriting, run(async (req, res) => {
  const body = marketObject(req.body, ["revision", "definition", "archived", "layout"], "Template update");
  const templateId = marketKey(req.params.templateId, "Template id");
  const revision = marketRevision(body.revision);
  const updatedRevision = nextRevision(revision);
  const current = await MarketTemplate.findOne({ templateId, revision }).lean();
  if (!current) { res.status(409).send({ message: "Template changed or does not exist; reload it" }); return; }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean" || body.definition !== undefined || body.layout !== undefined) {
      throw new MarketValidationError("Archive changes cannot edit a template definition");
    }
    const updated = await MarketTemplate.findOneAndUpdate({ templateId, revision }, {
      $set: { archived: body.archived, revision: updatedRevision },
    }, { new: true });
    if (!updated) { res.status(409).send({ message: "Template changed; reload it" }); return; }
    res.send(publicMarketTemplate(updated.toObject())); return;
  }
  if (current.archived) { res.status(409).send({ message: "Restore the template before adding a version" }); return; }
  const definition = parseMarketDefinition(body.definition);
  const layout = body.layout === undefined ? undefined : parseMarketLayout(body.layout, definition);
  const version = nextRevision(current.versions[current.versions.length - 1].version);
  const updated = await MarketTemplate.findOneAndUpdate({ templateId, revision, archived: false }, {
    $set: { revision: updatedRevision, ...(layout ? { [`layouts.${version}`]: layout } : {}) },
    $push: { versions: { id: templateId, version, definition, publishedAt: new Date().toISOString() } },
  }, { new: true });
  if (!updated) { res.status(409).send({ message: "Template changed; reload it" }); return; }
  res.send(publicMarketTemplate(updated.toObject()));
}));

router.get("/api/backoffice/events/:eventId/markets", run(async (req, res) => {
  const event = await Event.findOne({ eventId: req.params.eventId }).select("+customMarkets").lean();
  if (!event) { res.status(404).send({ message: "Event not found" }); return; }
  res.send({
    enabled: writingEnabled(),
    event: { eventId: event.eventId, name: event.name, time: event.time, status: event.status, visibility: event.visibility },
    markets: (event.customMarkets ?? []).map(publicEventMarket),
  });
}));

router.post("/api/backoffice/events/:eventId/markets/validate", requireWriting, run(async (req, res) => {
  const body = marketObject(req.body, ["markets"], "Market availability");
  if (!Array.isArray(body.markets) || body.markets.length > 10) {
    throw new MarketValidationError("Availability requires at most 10 market revisions");
  }
  const markets = body.markets.map(value => {
    const item = marketObject(value, ["marketId", "revision", "rulesRevision"], "Market revision");
    return {
      marketId: marketKey(item.marketId, "Market id"),
      "publishedConfiguration.revision": marketRevision(item.revision),
      "publishedConfiguration.rulesRevision": marketRevision(item.rulesRevision),
      "publishedConfiguration.availability": "OPEN",
      status: { $ne: "PUBLISHING" },
      decision: { $exists: false },
    };
  });
  const event = await Event.exists({
    eventId: marketKey(req.params.eventId, "Event id"),
    status: EventStatus.NO_RESULT, visibility: EventVisibility.ONLINE,
    newEventPublicationPending: { $ne: true },
    $and: [cashBackAuthorityWritable, ...markets.map(market => ({ customMarkets: { $elemMatch: market } }))],
    $expr: { $gt: [{ $convert: { input: "$time", to: "date", onError: null, onNull: null } }, "$$NOW"] },
  });
  res.send({ available: Boolean(event) });
}));

router.post("/api/backoffice/events/:eventId/markets", requireWriting, run(async (req, res) => {
  const body = marketObject(req.body, ["requestId", "templateId", "templateVersion", "parameters", "pricing"], "Market creation");
  const eventId = marketKey(req.params.eventId, "Event id");
  const requestId = marketKey(body.requestId, "Request id");
  const templateId = marketKey(body.templateId, "Template id");
  const version = marketRevision(body.templateVersion);
  const source = await MarketTemplate.findOne({ templateId, archived: false }).lean();
  const template = source?.versions.find(item => item.version === version);
  if (!template) { res.status(404).send({ message: "Published template version not found or template archived" }); return; }
  const layout = source?.layouts?.[version];
  const definition = parseMarketDefinition(template.definition);
  const parameters = bindMarketParameters(definition, body.parameters);
  const pricing = body.pricing === undefined
    ? (definition.settlementMode === "FINAL_SCORE" ? parseMarketPricingInstruction(definition, { method: "SCORE_MODEL" }) : undefined)
    : parseMarketPricingInstruction(definition, body.pricing);
  const marketId = hash([eventId, requestId]).slice(0, 32);
  const fingerprint = hash({ template, parameters, pricing });
  const market: EventMarket = {
    marketId, creationFingerprint: fingerprint, revision: 1, rulesRevision: 1, template,
    parameters, pricing, availability: "OPEN", status: "DRAFT", configuredAt: new Date().toISOString(),
    ...(layout ? { layout: parseMarketLayout(layout, definition) } : {}),
  };
  const event = await Event.findOneAndUpdate({
    eventId, status: { $ne: EventStatus.RESULTED }, newEventPublicationPending: { $ne: true },
    "customMarkets.marketId": { $ne: marketId }, $and: [cashBackAuthorityWritable],
    $expr: { $gt: [{ $convert: { input: "$time", to: "date", onError: null, onNull: null } }, "$$NOW"] },
  }, { $push: { customMarkets: market }, $inc: { cashBackAuthorityRevision: 1 }, $currentDate: { cashBackAuthorityAt: true } }, { new: true })
    .select("+customMarkets").lean();
  if (event) { res.status(201).send(publicEventMarket(market)); return; }
  const existing = await Event.findOne({ eventId }).select("+customMarkets").lean();
  const replay = existing?.customMarkets?.find(item => item.marketId === marketId);
  if (replay?.creationFingerprint === fingerprint) { res.send(publicEventMarket(replay)); return; }
  res.status(409).send({ message: "Event is unavailable, has started, is reserved, or request id conflicts" });
}));

router.put("/api/backoffice/events/:eventId/markets/:marketId", requireWriting, run(async (req, res) => {
  const body = marketObject(req.body, ["revision", "parameters", "pricing", "availability", "publish"], "Market update");
  const eventId = marketKey(req.params.eventId, "Event id");
  const marketId = marketKey(req.params.marketId, "Market id");
  const revision = marketRevision(body.revision);
  const updatedRevision = nextRevision(revision);
  if (body.publish !== undefined && typeof body.publish !== "boolean") throw new MarketValidationError("publish must be boolean");
  const source = await Event.findOne({ eventId }).select("+customMarkets").lean();
  const current = source?.customMarkets?.find(item => item.marketId === marketId && item.revision === revision);
  if (!current || current.status === "PUBLISHING" || current.decision) {
    res.status(409).send({ message: "Market changed, is still publishing, or is already settled" }); return;
  }
  const definition = parseMarketDefinition(current.template.definition);
  const parameters = body.parameters === undefined ? current.parameters : bindMarketParameters(definition, body.parameters);
  if (current.configuration && JSON.stringify(parameters) !== JSON.stringify(current.parameters)) {
    throw new MarketValidationError("Published rules and parameters are immutable; create a replacement market");
  }
  const pricing = body.pricing === undefined ? current.pricing : parseMarketPricingInstruction(definition, body.pricing);
  const availability = body.availability ?? current.availability;
  if (availability !== "OPEN" && availability !== "SUSPENDED") throw new MarketValidationError("Invalid availability");
  const updated: EventMarket = {
    ...current, revision: updatedRevision, parameters, pricing, availability,
    status: body.publish ? "PUBLISHING" : "DRAFT", configuredAt: new Date().toISOString(),
  };
  if (body.publish) {
    updated.configuration = parseEventMarketConfiguration({
      schemaVersion: 1, marketId, eventId, revision: updatedRevision, rulesRevision: updated.rulesRevision,
      template: updated.template, parameters, pricing, availability, configuredAt: updated.configuredAt,
    });
    updated.publicationPending = true;
  }
  const event = await Event.findOneAndUpdate({
    eventId, status: { $ne: EventStatus.RESULTED },
    customMarkets: { $elemMatch: { marketId, revision, status: { $ne: "PUBLISHING" }, decision: { $exists: false } } },
    $and: [cashBackAuthorityWritable],
    $expr: { $gt: [{ $convert: { input: "$time", to: "date", onError: null, onNull: null } }, "$$NOW"] },
  }, { $set: { "customMarkets.$": updated }, $inc: { cashBackAuthorityRevision: 1 }, $currentDate: { cashBackAuthorityAt: true } }, { new: true });
  if (!event) { res.status(409).send({ message: "Event or market changed, has started, or is reserved" }); return; }
  if (body.publish) await getBackofficePublicationService(messengerWrapper.connection).publishMarketsNow(eventId);
  res.status(body.publish ? 202 : 200).send(publicEventMarket(updated));
}));

router.post("/api/backoffice/events/:eventId/markets/:marketId/result", run(async (req, res) => {
  const body = marketObject(req.body, ["requestId", "revision", "result", "winningOutcomeKeys"], "Manual settlement");
  const eventId = marketKey(req.params.eventId, "Event id");
  const marketId = marketKey(req.params.marketId, "Market id");
  const revision = marketRevision(body.revision);
  const requestId = marketKey(body.requestId, "Request id");
  const source = await Event.findOne({ eventId }).select("+customMarkets").lean();
  const current = source?.customMarkets?.find(item => item.marketId === marketId);
  if (!current?.publishedConfiguration) { res.status(409).send({ message: "Market has not been published" }); return; }
  const decision = parseManualMarketDecision({
    schemaVersion: 1, decisionId: hash([eventId, marketId, requestId]).slice(0, 32),
    eventId, marketId, rulesRevision: current.rulesRevision, reviewedRevision: revision,
    decidedAt: current.decision?.decidedAt ?? new Date().toISOString(),
    result: body.result, winningOutcomeKeys: body.winningOutcomeKeys,
  }, current.template.definition);
  if (current.decision) {
    if (JSON.stringify(parseManualMarketDecision(current.decision, current.template.definition)) !== JSON.stringify(decision)) {
      res.status(409).send({ message: "Market already has a different immutable decision" }); return;
    }
  } else {
    const event = await Event.findOneAndUpdate({
      eventId, $and: [cashBackAuthorityWritable],
      customMarkets: { $elemMatch: { marketId, revision, decision: { $exists: false } } },
    }, {
      $set: { "customMarkets.$.decision": decision, "customMarkets.$.resultPublicationPending": true },
      $inc: { cashBackAuthorityRevision: 1 }, $currentDate: { cashBackAuthorityAt: true },
    });
    if (!event) { res.status(409).send({ message: "Market changed or event is reserved; review it again" }); return; }
  }
  await getBackofficePublicationService(messengerWrapper.connection).publishMarketsNow(eventId);
  const latest = await Event.findOne({ eventId }).select("+customMarkets").lean();
  const pending = latest?.customMarkets?.find(item => item.marketId === marketId)?.resultPublicationPending;
  res.status(pending ? 202 : 200).send({ decision, publication: pending ? "PENDING" : "PUBLISHED" });
}));

export { router as Markets };
