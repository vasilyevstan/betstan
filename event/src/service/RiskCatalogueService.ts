import { EventPhase, EventStatus, EventVisibility, marketKey, MarketValidationError } from "@betstan/common";
import { Event } from "../model/Event";
import { buildHasOfflineIntentExpression, buildHasUnresolvedVisibilityAuthorityExpression } from "../model/visibilityAuthorityExpressions";
import { createPublicEventSnapshot, PublicEventSnapshot } from "../live/LiveEventReadModel";
import { marketCatalog, MarketUnavailableError } from "./MarketQuoteService";

const activePhases = Object.values(EventPhase).filter(phase => ![EventPhase.PRE_MATCH, EventPhase.FULL_TIME].includes(phase));
const eligible = (now: Date) => ({
  visibility: EventVisibility.ONLINE, status: EventStatus.NO_RESULT,
  $expr: { $not: [{ $or: [buildHasOfflineIntentExpression(), buildHasUnresolvedVisibilityAuthorityExpression()] }] },
  $or: [
    { time: { $gt: now }, $or: [{ "live.phase": { $exists: false } }, { "live.phase": EventPhase.PRE_MATCH }] },
    { "live.phase": { $in: activePhases } },
  ],
});
const identity = (event: PublicEventSnapshot) => ({
  eventId: event.eventId, name: event.name, time: event.time, phase: event.live?.phase ?? EventPhase.PRE_MATCH,
});
export interface RiskChoiceOffer {
  origin: "STANDARD" | "TEMPLATE" | "LIVE";
  marketId: string;
  outcomeKey: string;
  marketName: string;
  label: string;
  odds: number;
  betKind: "PRE_MATCH" | "LIVE";
  sourceOpen: boolean;
  templateId?: string;
  marketVersion?: number;
  selectionId?: string;
  marketType?: string;
}

export async function listRiskEvents(after: unknown, limit: number, now = new Date()) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new MarketValidationError("Choose 1-25 events per page");
  const afterId = after === undefined ? undefined : marketKey(after, "Event cursor");
  const events = await Event.find({ ...eligible(now), ...(afterId ? { eventId: { $gt: afterId } } : {}) })
    .sort({ eventId: 1 }).limit(limit + 1).maxTimeMS(2000).lean();
  const items = events.slice(0, limit).map(event => identity(createPublicEventSnapshot({ ...event })));
  return { events: items, nextAfter: events.length > limit ? items[items.length - 1].eventId : null };
}

export async function riskEventChoices(eventId: string, now = new Date()) {
  const stored = await Event.findOne({ ...eligible(now), eventId }).maxTimeMS(2000).lean();
  if (!stored) throw new MarketUnavailableError("This event is no longer open for betting");
  const event = createPublicEventSnapshot({ ...stored });
  const choices: RiskChoiceOffer[] = [];
  const preMatch = Date.parse(event.time) > now.getTime() && (!event.live || event.live.phase === EventPhase.PRE_MATCH);
  if (preMatch) {
    for (const product of event.products) for (const odd of product.odds) choices.push({
      origin: "STANDARD", marketId: product.id, outcomeKey: odd.id, marketName: product.name,
      label: odd.name, odds: odd.value, betKind: "PRE_MATCH", sourceOpen: true, marketType: product.type,
    });
    const catalogue = await marketCatalog(eventId);
    for (const market of catalogue.markets) {
      const { configuration, preview } = market;
      for (const outcome of configuration.template.definition.outcomes) choices.push({
        origin: "TEMPLATE", marketId: configuration.marketId, outcomeKey: outcome.key,
        marketName: configuration.template.definition.name, label: outcome.label, odds: preview.odds[outcome.key],
        betKind: "PRE_MATCH", templateId: configuration.template.id,
        sourceOpen: catalogue.enabled && configuration.availability === "OPEN",
      });
    }
  }
  for (const market of event.live?.currentMarkets ?? []) {
    if (!["OPEN", "SUSPENDED"].includes(market.status)) continue;
    const quoteUntil = Date.parse(market.quoteValidUntil ?? "");
    for (const selection of market.selections) choices.push({
      origin: "LIVE", marketId: market.marketId, outcomeKey: selection.selectionId,
      marketName: market.marketType.toLowerCase().replace(/_/g, " "), label: selection.label ?? selection.side,
      odds: selection.odds, betKind: "LIVE", marketVersion: market.marketVersion, selectionId: selection.selectionId,
      marketType: market.marketType,
      sourceOpen: event.liveEnabled !== false && event.live?.bettingStatus === "OPEN" && market.status === "OPEN"
        && Number.isFinite(quoteUntil) && quoteUntil > now.getTime(),
    });
  }
  return { event: identity(event), choices };
}
