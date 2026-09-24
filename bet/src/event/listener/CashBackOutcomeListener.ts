import { ConsumeMessage } from "amqplib";
import { AListener, ICashBackOutcomeEvent, QueueNames } from "@betstan/common";
import { getCashBackFacade } from "../../service/CashBackFacade";

export class CashBackOutcomeListener extends AListener<ICashBackOutcomeEvent> {
  queue = QueueNames.CASH_BACK_OUTCOME;
  serviceName = "bet_cash_back_outcome";

  async init(): Promise<void> {
    await super.init();
    await this.channel.prefetch(1);
  }

  async onMessage(event: ICashBackOutcomeEvent, message: ConsumeMessage): Promise<void> {
    if (event.sender !== "resulting_cash_back_outcome") {
      console.error("bet_cash_back_invalid_outcome_sender");
      this.channel.nack(message, false, false);
      return;
    }
    await getCashBackFacade(this.connection).receiveOutcome(event.data);
    this.ack(message);
  }
}
