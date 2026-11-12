import axios from "axios";
import {
  BetKind, bindScoreRule, BUILDER_PRODUCT_NAME, CUSTOM_MARKET_PRODUCT_NAME, EventPhase, EventStatus,
  EventVisibility, IEventOddsSelectedEvent, MarketBet, marketKey, marketObject, marketRevision,
  marketSelectionKey, MarketSelectionSnapshot, MarketValidationError, MAX_BUILDER_SELECTIONS,
  parseMarketBet, parseMarketSelectionIdentity, parseScorePricingModel, priceScoreCombination,
} from "@betstan/common";
import { MarketQuote } from "../model/Market";
import {
  availableMarketProjections, findMarketEvent, MarketEvent, marketFingerprint, standardSelections,
} from "./MarketProjectionService";

export class MarketUnavailableError extends Error {}
export class MarketAuthorityUnavailableError extends Error {}
export const marketsEnabled = () => process.env.EXTENSIBLE_MARKETS_ENABLED === "true";
export function requireMarketWriting(): void {
  if (!marketsEnabled()) throw new MarketAuthorityUnavailableError("New custom markets are not enabled");
}

function assertEventAvailable(event: MarketEvent | null): asserts event is MarketEvent {
  if (!event || event.visibility !== EventVisibility.ONLINE || event.status === EventStatus.RESULTED
    || !Number.isFinite(new Date(event.time).getTime()) || new Date(event.time).getTime() <= Date.now()
    || (event.live && event.live.phase !== EventPhase.PRE_MATCH)) {
    throw new MarketUnavailableError("This event is no longer available for pre-match bets");
  }
}

export async function assertSourceAvailable(eventId: string, selections: MarketSelectionSnapshot[]): Promise<void> {
  const serviceUrl = process.env.BACKOFFICE_SERVICE_URL;
  if (!serviceUrl) throw new MarketAuthorityUnavailableError("Market authority is not configured");
  const url = new URL(`/api/backoffice/events/${encodeURIComponent(eventId)}/markets/validate`, serviceUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new MarketAuthorityUnavailableError("Market authority requires HTTP or HTTPS");
  let available: unknown;
  try {
    const response = await axios.post<unknown>(url.toString(), {
      markets: selections.filter(selection => selection.origin === "TEMPLATE").map(selection => ({
        marketId: selection.marketId, revision: selection.quoteRevision, rulesRevision: selection.rulesRevision,
      })),
    }, { timeout: 3000, maxContentLength: 16384, maxRedirects: 0 });
    available = marketObject(response.data, ["available"], "Market authority response").available;
    if (typeof available !== "boolean") throw new Error("Missing authoritative availability");
  } catch (error) {
    console.error("market_authority_unavailable", error instanceof Error ? error.message : "Invalid authority response");
    throw new MarketAuthorityUnavailableError("Market availability could not be verified; try again");
  }
  if (!available) throw new MarketUnavailableError("A market changed, is suspended, or has already settled; refresh its prices");
}

export async function marketCatalog(eventId: string) {
  const event = await findMarketEvent(eventId);
  if (!event) throw new MarketUnavailableError("Event not found");
  const projections = await availableMarketProjections(eventId);
  return {
    enabled: marketsEnabled(),
    event: { eventId, name: event.name, time: event.time, status: event.status, visibility: event.visibility },
    hasRetainedModel: Boolean(event.pricingModel),
    standardSelections: standardSelections(event),
    markets: projections.flatMap(record => record.publication?.kind === "MARKET_AVAILABLE" ? [{
      configuration: record.publication.configuration, preview: record.publication.preview,
      builderEligible: record.publication.configuration.pricing.method === "SCORE_MODEL",
    }] : []),
  };
}

async function resolveSelections(event: MarketEvent, values: unknown) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_BUILDER_SELECTIONS) {
    throw new MarketValidationError("Choose 1-10 selections");
  }
  const standard = standardSelections(event);
  const custom = await availableMarketProjections(event.eventId);
  const requested = values.map(value => {
    const input = marketObject(value, ["origin", "marketId", "outcomeKey", "quoteRevision"], "Requested selection");
    return {
      ...parseMarketSelectionIdentity({ origin: input.origin, marketId: input.marketId, outcomeKey: input.outcomeKey }),
      quoteRevision: marketRevision(input.quoteRevision),
    };
  }).sort((a, b) => marketSelectionKey(a).localeCompare(marketSelectionKey(b)));
  if (new Set(requested.map(marketSelectionKey)).size !== requested.length) {
    throw new MarketValidationError("A selection cannot appear twice");
  }
  const resolved: Array<{ selection: MarketSelectionSnapshot; odds: number }> = requested.map(identity => {
    if (identity.origin === "STANDARD") {
      const current = standard.find(item => marketSelectionKey(item) === marketSelectionKey(identity));
      if (!current || identity.quoteRevision !== current.quoteRevision) {
        throw new MarketUnavailableError("The standard selection has no matching retained price");
      }
      const { odds, ...selection } = current;
      if (selection.settlementMode !== "FINAL_SCORE"
        || priceScoreCombination(event.pricingModel, [selection.rule]) !== odds) {
        throw new MarketUnavailableError("The standard selection no longer matches its retained model");
      }
      return { selection, odds };
    }
    const publication = custom.find(item => item.marketId === identity.marketId)?.publication;
    if (publication?.kind !== "MARKET_AVAILABLE" || publication.revision !== identity.quoteRevision
      || publication.configuration.availability !== "OPEN") {
      throw new MarketUnavailableError("Market prices changed or the market is suspended");
    }
    const configuration = publication.configuration;
    const definition = configuration.template.definition;
    const outcome = definition.outcomes.find(item => item.key === identity.outcomeKey);
    if (!outcome) throw new MarketValidationError("Unknown market outcome");
    const details = {
      ...identity, rulesRevision: configuration.rulesRevision, templateId: configuration.template.id,
      templateVersion: configuration.template.version, marketName: definition.name,
      label: outcome.label, terms: definition.terms,
    };
    const selection: MarketSelectionSnapshot = definition.settlementMode === "MANUAL"
      ? { ...details, settlementMode: "MANUAL", pricingMethod: "OPERATOR" }
      : { ...details, settlementMode: "FINAL_SCORE", pricingMethod: configuration.pricing.method,
        rule: bindScoreRule(outcome.rule, configuration.parameters) };
    if (selection.pricingMethod === "SCORE_MODEL" && publication.model?.id !== event.pricingModel?.id) {
      throw new MarketUnavailableError("Market model identity changed");
    }
    return { selection, odds: publication.preview.odds[identity.outcomeKey] };
  });
  return { requested, resolved };
}

export async function createMarketQuote(ownerId: string, eventId: string, value: unknown): Promise<MarketBet> {
  requireMarketWriting();
  const input = marketObject(value, ["requestId", "kind", "selections"], "Quote request");
  if (input.kind !== "SINGLE" && input.kind !== "BUILDER") throw new MarketValidationError("Choose a single or a Builder");
  const requestId = marketKey(input.requestId, "Request id");
  const event = await findMarketEvent(eventId);
  assertEventAvailable(event);
  const { requested, resolved } = await resolveSelections(event, input.selections);
  const requestFingerprint = marketFingerprint({ eventId, kind: input.kind, selections: requested });
  const quoteId = marketFingerprint([ownerId, requestId]).slice(0, 32);
  const existing = await MarketQuote.findOne({ quoteId, ownerId }).select("+requestFingerprint").lean();
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) throw new MarketUnavailableError("Request id was already used for a different quote");
    await validateMarketQuote(ownerId, existing.quote);
    return parseMarketBet(existing.quote);
  }
  const selections = resolved.map(item => item.selection);
  if ((input.kind === "SINGLE" && selections.length !== 1) || (input.kind === "BUILDER" && selections.length < 2)) {
    throw new MarketValidationError("A single needs one selection; a Builder needs 2-10 selections");
  }
  const rules = selections.flatMap(selection =>
    selection.settlementMode === "FINAL_SCORE" && selection.pricingMethod === "SCORE_MODEL" ? [selection.rule] : []);
  if (input.kind === "BUILDER" && rules.length !== selections.length) {
    throw new MarketValidationError("Manual and overridden prices cannot enter a same-match Builder");
  }
  const odds = input.kind === "BUILDER" ? priceScoreCombination(event.pricingModel, rules) : resolved[0].odds;
  await assertSourceAvailable(eventId, selections);
  assertEventAvailable(event);
  const issuedAt = new Date();
  const expiresAt = new Date(Math.min(issuedAt.getTime() + 30_000, new Date(event.time).getTime()));
  const quote = parseMarketBet({
    schemaVersion: 1, kind: input.kind, eventId, quoteId, issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(), odds, selections,
    ...(rules.length ? { modelId: parseScorePricingModel(event.pricingModel).id } : {}),
  });
  try { await MarketQuote.create({ quoteId, ownerId, requestFingerprint, quote }); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
    const winner = await MarketQuote.findOne({ quoteId, ownerId }).select("+requestFingerprint").lean();
    if (!winner || winner.requestFingerprint !== requestFingerprint) {
      throw new MarketUnavailableError("Concurrent quote request used different selections");
    }
    await validateMarketQuote(ownerId, winner.quote);
    return parseMarketBet(winner.quote);
  }
  return quote;
}

export async function validateMarketQuote(ownerId: string, value: unknown): Promise<MarketBet> {
  requireMarketWriting();
  const quote = parseMarketBet(value);
  const stored = await MarketQuote.findOne({ quoteId: quote.quoteId, ownerId }).lean();
  if (!stored || marketFingerprint(parseMarketBet(stored.quote)) !== marketFingerprint(quote)) {
    throw new MarketUnavailableError("Quote does not match the owner's issued price and selections");
  }
  const event = await findMarketEvent(quote.eventId);
  assertEventAvailable(event);
  if (quote.modelId !== undefined && quote.modelId !== event.pricingModel?.id) {
    throw new MarketUnavailableError("The retained pricing model changed");
  }
  const { resolved } = await resolveSelections(event, quote.selections.map(selection => ({
    origin: selection.origin, marketId: selection.marketId, outcomeKey: selection.outcomeKey,
    quoteRevision: selection.quoteRevision,
  })));
  const currentSelections = resolved.map(item => item.selection);
  if (marketFingerprint(parseMarketBet({ ...quote, selections: currentSelections })) !== marketFingerprint(quote)) {
    throw new MarketUnavailableError("The frozen selections no longer match their source");
  }
  await assertSourceAvailable(quote.eventId, quote.selections);
  assertEventAvailable(event);
  if (Date.now() < Date.parse(quote.issuedAt) || Date.now() >= Date.parse(quote.expiresAt)) {
    throw new MarketUnavailableError("Quote expired; generate a new price before placing the bet");
  }
  return quote;
}

export async function marketQuoteSelection(ownerId: string, quoteId: string): Promise<IEventOddsSelectedEvent["data"]> {
  const stored = await MarketQuote.findOne({ quoteId, ownerId }).lean();
  if (!stored) throw new MarketUnavailableError("Quote not found");
  const quote = await validateMarketQuote(ownerId, stored.quote);
  const event = await findMarketEvent(quote.eventId);
  assertEventAvailable(event);
  return {
    userId: ownerId, eventId: quote.eventId, eventName: event.name, eventTime: new Date(event.time).toISOString(),
    oddsId: marketFingerprint(quote.selections.map(marketSelectionKey)).slice(0, 32),
    oddsValue: quote.odds, oddsName: quote.selections.map(selection => selection.label).join(" + "),
    productName: quote.kind === "BUILDER" ? BUILDER_PRODUCT_NAME : CUSTOM_MARKET_PRODUCT_NAME,
    productId: quote.kind === "BUILDER" ? `${quote.eventId}-builder` : quote.selections[0].marketId,
    betKind: BetKind.PRE_MATCH, selectedAt: quote.issuedAt, quoteValidUntil: quote.expiresAt, marketBet: quote,
  };
}
