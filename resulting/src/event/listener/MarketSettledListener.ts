import { IMarketSettledEvent, QueueNames } from "@betstan/common";
import { ManualMarketLedger } from "../../model/ManualMarketLedger";
import { processManualMarketResult, SettlementPublishers } from "../../service/resulting";
import { RetryDescriptor } from "../../service/retry";
import RetriableResultingListener from "./RetriableResultingListener";

export class MarketSettledListener extends RetriableResultingListener<IMarketSettledEvent> {
  serviceName = "resulting_market_settled";
  queue = QueueNames.MARKET_SETTLED;
  protected readonly failureLogMessage = "Error processing manual market result:";

  async init(): Promise<void> {
    await ManualMarketLedger.init();
    await super.init();
  }

  protected buildRetryDescriptor(event: IMarketSettledEvent): RetryDescriptor<IMarketSettledEvent> {
    return {
      identity: event.data.decision.decisionId, kind: "MARKET_SETTLED",
      listenerServiceName: this.serviceName, payload: event,
    };
  }

  protected async handleEvent(event: IMarketSettledEvent, publishers: SettlementPublishers): Promise<void> {
    await processManualMarketResult(event, publishers);
  }
}
