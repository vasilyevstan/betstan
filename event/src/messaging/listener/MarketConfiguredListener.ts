import { AListener, IMarketConfiguredEvent, MarketValidationError, QueueNames } from "@betstan/common";
import { ConsumeMessage } from "amqplib";
import { storeMarketConfiguration } from "../../service/MarketProjectionService";

export class MarketConfiguredListener extends AListener<IMarketConfiguredEvent> {
  serviceName = "event_market_configured";
  queue = QueueNames.MARKET_CONFIGURED;

  async onMessage(event: IMarketConfiguredEvent, message: ConsumeMessage): Promise<void> {
    try {
      await storeMarketConfiguration(event.data);
      this.ack(message);
    } catch (error) {
      console.error("market_configuration_not_applied", error);
      this.channel.nack(message, false, !(error instanceof MarketValidationError));
    }
  }
}
