import { createHash } from "crypto";
import { ConfirmChannel } from "amqplib";
import {
  APublisher, bindScoreRule, EventMarketConfiguration, generateScoreMarketOdds, IAmqpConnection,
  IMarketPublishedEvent, MarketPublication, MarketSelectionSnapshot, MarketValidationError,
  parseEventMarketConfiguration, parseScorePricingModel, priceScoreCombination, QueueNames,
} from "@betstan/common";
import { Event } from "../model/Event";
import { MarketProjection, MarketProjectionRecord } from "../model/Market";

export const marketFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const findMarketEvent = (eventId: string) => Event.findOne({ eventId, eventMetadataInitialized: { $ne: false } })
  .select("+pricingModel +pricingModelCreatedAt +pricingRules").lean();
export type MarketEvent = NonNullable<Awaited<ReturnType<typeof findMarketEvent>>>;

export function standardSelections(event: MarketEvent): Array<MarketSelectionSnapshot & { odds: number }> {
  if (!event.pricingModel) return [];
  parseScorePricingModel(event.pricingModel);
  return (event.pricingRules ?? []).map(retained => {
    const product = event.products.find(item => item.id === retained.productId);
    const odd = product?.odds.find(item => item.id === retained.oddsId);
    if (!product || !odd) throw new MarketValidationError("Retained standard selection is missing");
    return {
      origin: "STANDARD", marketId: product.id, outcomeKey: odd.id, rulesRevision: 1, quoteRevision: 1,
      templateId: product.id, templateVersion: 1, marketName: product.name, label: odd.name,
      terms: "Full-time score", settlementMode: "FINAL_SCORE", pricingMethod: "SCORE_MODEL",
      rule: bindScoreRule(retained.rule, {}), odds: odd.value,
    };
  });
}

export async function storeMarketConfiguration(value: unknown): Promise<void> {
  const configuration = parseEventMarketConfiguration(value);
  const { eventId, marketId, revision } = configuration;
  const fingerprint = marketFingerprint(configuration);
  try {
    await MarketProjection.updateOne({ marketId, revision }, {
      $setOnInsert: { eventId, marketId, revision, fingerprint, configuration, processingPending: true, publicationPending: false },
    }, { upsert: true });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
  }
  const stored = await MarketProjection.findOne({ marketId, revision }).lean();
  if (!stored || stored.fingerprint !== fingerprint) {
    throw new MarketValidationError("Conflicting immutable market configuration");
  }
}

export async function availableMarketProjections(eventId: string): Promise<MarketProjectionRecord[]> {
  return MarketProjection.aggregate<MarketProjectionRecord>([
    { $match: { eventId, "publication.kind": "MARKET_AVAILABLE" } },
    { $sort: { revision: -1 } },
    { $group: { _id: "$marketId", projection: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$projection" } },
  ]);
}

function priceConfiguration(event: MarketEvent, configuration: EventMarketConfiguration): MarketPublication {
  const { eventId, marketId, revision, configuredAt: occurredAt, template, parameters, pricing } = configuration;
  const identity = { schemaVersion: 1 as const, eventId, marketId, revision, occurredAt };
  try {
    const model = template.definition.settlementMode === "FINAL_SCORE"
      ? parseScorePricingModel(event.pricingModel) : undefined;
    const modeled = model ? generateScoreMarketOdds(template.definition, parameters, model) : undefined;
    if (pricing.method === "OPERATOR") {
      return { ...identity, kind: "MARKET_AVAILABLE", configuration, preview: { method: "OPERATOR", odds: pricing.odds } };
    }
    if (!model || !modeled) throw new MarketValidationError("This event has no retained pricing model; use a manual market");
    return {
      ...identity, kind: "MARKET_AVAILABLE", configuration, model,
      preview: modeled,
    };
  } catch (error) {
    if (!(error instanceof MarketValidationError)) throw error;
    return { ...identity, kind: "MARKET_REJECTED", reason: error.message };
  }
}

class MarketPublishedPublisher extends APublisher<IMarketPublishedEvent> {
  serviceName = "event_market_published";
  queue = QueueNames.MARKET_PUBLISHED;
  private activeChannel?: ConfirmChannel;
  private closed = false;

  async initConfirmChannel(): Promise<void> {
    const channel = await this.connection.createConfirmChannel();
    if (this.closed) {
      await channel.close();
      throw new Error("Market publisher closed during initialization");
    }
    this.activeChannel = channel;
    this.confirmChannel = this.activeChannel;
    await this.activeChannel.assertExchange(this.queue, "fanout");
  }

  async close(): Promise<void> {
    this.closed = true;
    const channel = this.activeChannel;
    this.activeChannel = undefined;
    if (channel) {
      try { await channel.close(); }
      catch (error) { console.error("market_publisher_close_failed", error); }
    }
  }
}

export class MarketProjectionService {
  private publisher: MarketPublishedPublisher;
  private initialization: Promise<void> | null = null;
  private activeReplay: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private connection: IAmqpConnection) {
    this.publisher = new MarketPublishedPublisher(connection);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.activeReplay;
    await this.publisher.close();
  }

  private async tick(): Promise<void> {
    try { await this.replayPending(); }
    catch (error) { console.error("market_projection_replay_failed", error); }
    if (this.running) {
      this.timer = setTimeout(() => { void this.tick(); }, 5000);
      this.timer.unref();
    }
  }

  replayPending(): Promise<void> {
    if (this.activeReplay) return this.activeReplay;
    this.activeReplay = this.replay().finally(() => { this.activeReplay = null; });
    return this.activeReplay;
  }

  private async publish(data: MarketPublication): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const publisher = this.publisher;
    try {
      await Promise.race([
        (async () => {
          this.initialization ??= publisher.initConfirmChannel();
          await this.initialization;
          await publisher.publishWithConfirm({ data });
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Market publication confirmation timed out")), 5000);
        }),
      ]);
    } catch (error) {
      await publisher.close();
      this.publisher = new MarketPublishedPublisher(this.connection);
      this.initialization = null;
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  private async replay(): Promise<void> {
    const pending = await MarketProjection.find({
      $or: [{ processingPending: true }, { publicationPending: true }],
    }).sort({ lastAttemptedAt: 1, _id: 1 }).limit(25).lean();
    for (const record of pending) {
      try {
        await MarketProjection.updateOne({ _id: record._id }, { $currentDate: { lastAttemptedAt: true } });
        let publication = record.publication;
        if (record.processingPending) {
          const event = await findMarketEvent(record.eventId);
          if (!event) continue;
          publication = priceConfiguration(event, parseEventMarketConfiguration(record.configuration));
          await MarketProjection.updateOne({ _id: record._id, processingPending: true }, {
            $set: { processingPending: false, publicationPending: true, publication },
          });
        }
        if (!publication) throw new Error("Market publication obligation has no frozen payload");
        await this.publish(publication);
        await MarketProjection.updateOne({ _id: record._id, fingerprint: record.fingerprint }, {
          $set: { publicationPending: false },
        });
      } catch (error) { console.error("market_publication_pending", error); }
    }
    const models = await Event.find({ marketModelPublicationPending: true })
      .select("+pricingModel +pricingModelCreatedAt +pricingRules")
      .sort({ marketModelPublicationAttemptedAt: 1, _id: 1 }).limit(25).lean();
    for (const event of models) {
      try {
        await Event.updateOne({ eventId: event.eventId }, { $currentDate: { marketModelPublicationAttemptedAt: true } });
        const model = parseScorePricingModel(event.pricingModel);
        if (!event.pricingModelCreatedAt) throw new Error("Retained model has no creation time");
        const selections = standardSelections(event);
        for (const selection of selections) {
          if (selection.settlementMode !== "FINAL_SCORE"
            || priceScoreCombination(model, [selection.rule]) !== selection.odds) {
            throw new MarketValidationError("Standard price does not match its retained model");
          }
        }
        await this.publish({
          kind: "MODEL_RETAINED", schemaVersion: 1, eventId: event.eventId,
          occurredAt: event.pricingModelCreatedAt, model, standardSelections: selections,
        });
        await Event.updateOne({ eventId: event.eventId, "pricingModel.id": model.id }, {
          $unset: { marketModelPublicationPending: 1, marketModelPublicationAttemptedAt: 1 },
        });
      } catch (error) { console.error("market_model_publication_pending", error); }
    }
  }
}
