import { APublisher, IMarketConfiguredEvent, IMarketSettledEvent, QueueNames } from "@betstan/common";

export class MarketConfiguredPublisher extends APublisher<IMarketConfiguredEvent> {
  serviceName = "backoffice_market_configured";
  queue = QueueNames.MARKET_CONFIGURED;
}

export class MarketSettledPublisher extends APublisher<IMarketSettledEvent> {
  serviceName = "backoffice_market_settled";
  queue = QueueNames.MARKET_SETTLED;
}
