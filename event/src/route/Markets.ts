import express, { Request, Response, RequestHandler } from "express";
import {
  generateManualMarketOdds, generateScoreMarketOdds, marketKey, marketObject, MarketValidationError,
  parseMarketDefinition,
} from "@betstan/common";
import { findMarketEvent } from "../service/MarketProjectionService";
import {
  createMarketQuote, marketCatalog, marketQuoteSelection, MarketAuthorityUnavailableError,
  MarketUnavailableError, requireMarketWriting, validateMarketQuote,
} from "../service/MarketQuoteService";

const router = express.Router();
const run = (action: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { void action(req, res).catch(error => {
    if (error instanceof MarketAuthorityUnavailableError) res.status(503).send({ message: error.message });
    else if (error instanceof MarketUnavailableError) res.status(409).send({ message: error.message });
    else if (error instanceof MarketValidationError) res.status(400).send({ message: error.message });
    else next(error);
  }); };

router.get("/api/event/events/:eventId/markets", run(async (req, res) => {
  res.send(await marketCatalog(marketKey(req.params.eventId, "Event id")));
}));

router.post("/api/event/events/:eventId/markets/preview", run(async (req, res) => {
  requireMarketWriting();
  const body = marketObject(req.body, ["definition", "parameters", "generation"], "Odds preview");
  const definition = parseMarketDefinition(body.definition);
  const event = await findMarketEvent(marketKey(req.params.eventId, "Event id"));
  if (!event) throw new MarketUnavailableError("Event not found");
  const generation = marketObject(body.generation, ["method", "values", "unlistedWeight"], "Generation inputs");
  if (generation.method === "SCORE_MODEL") {
    marketObject(generation, ["method"], "Modeled generation");
    if (!event.pricingModel) throw new MarketValidationError("This event has no retained pricing model");
    res.send(generateScoreMarketOdds(definition, body.parameters, event.pricingModel));
  } else res.send(generateManualMarketOdds(definition, generation));
}));

router.post("/api/event/events/:eventId/market-quotes", run(async (req, res) => {
  if (!req.currentUser) { res.status(401).send({ message: "Sign in to generate a betting quote" }); return; }
  res.status(201).send(await createMarketQuote(req.currentUser.id, marketKey(req.params.eventId, "Event id"), req.body));
}));

router.get("/api/event/market-quotes/:quoteId", run(async (req, res) => {
  if (!req.currentUser) { res.status(401).send({ message: "Sign in to use a betting quote" }); return; }
  res.send(await marketQuoteSelection(req.currentUser.id, marketKey(req.params.quoteId, "Quote id")));
}));

router.post("/api/event/market-quotes/:quoteId/validate", run(async (req, res) => {
  const body = marketObject(req.body, ["ownerId", "quote"], "Quote validation");
  const quoteId = marketKey(req.params.quoteId, "Quote id");
  const quote = await validateMarketQuote(marketKey(body.ownerId, "Quote owner"), body.quote);
  if (quote.quoteId !== quoteId) throw new MarketValidationError("Quote identity does not match the request");
  res.send({ valid: true });
}));

export { router as Markets };
