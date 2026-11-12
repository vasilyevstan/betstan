import { AListener, IMarketPublishedEvent, parseEventMarketConfiguration, QueueNames } from "@betstan/common";
import { ConsumeMessage } from "amqplib";
import { Event } from "../../model/Event";

export class MarketPublishedListener extends AListener<IMarketPublishedEvent> {
  serviceName = "backoffice_market_published";
  queue = QueueNames.MARKET_PUBLISHED;

  async onMessage({ data }: IMarketPublishedEvent, message: ConsumeMessage) {
    if (data.kind === "MODEL_RETAINED") {
      this.channel.ack(message);
      return;
    }
    if (data.schemaVersion !== 1) throw new Error("Unsupported market publication");
    const filter = {
      eventId: data.eventId,
      customMarkets: { $elemMatch: { marketId: data.marketId, revision: data.revision, status: "PUBLISHING" } },
    };
    if (data.kind === "MARKET_AVAILABLE") {
      const configuration = parseEventMarketConfiguration(data.configuration);
      if (configuration.marketId !== data.marketId || configuration.eventId !== data.eventId
        || configuration.revision !== data.revision) throw new Error("Market publication identity mismatch");
      await Event.updateOne({
        ...filter,
        customMarkets: { $elemMatch: { ...filter.customMarkets.$elemMatch, configuration } },
      }, { $set: {
        "customMarkets.$.status": "PUBLISHED",
        "customMarkets.$.publishedConfiguration": configuration,
      }, $unset: { "customMarkets.$.publicationError": 1 } });
    } else if (data.kind === "MARKET_REJECTED") {
      await Event.updateOne(filter, { $set: {
        "customMarkets.$.status": "REJECTED", "customMarkets.$.publicationError": data.reason,
      } });
    } else {
      throw new Error("Unknown market publication kind");
    }
    this.channel.ack(message);
  }
}
