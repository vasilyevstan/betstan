import { ConsumeMessage } from "amqplib";
import { AListener, ICashBackRequestEvent, QueueNames } from "@betstan/common";
import { getCashBackCoordinator } from "../../service/CashBackCoordinator";

export class CashBackRequestListener extends AListener<ICashBackRequestEvent> {
  queue = QueueNames.CASH_BACK_REQUEST;
  serviceName = "resulting_cash_back_request";

  async init(): Promise<void> {
    await super.init();
    await this.channel.prefetch(1);
  }

  async onMessage(event: ICashBackRequestEvent, message: ConsumeMessage): Promise<void> {
    if (event.sender !== "bet_cash_back_request") {
      console.error("resulting_cash_back_invalid_request_sender");
      this.channel.nack(message, false, false);
      return;
    }
    await getCashBackCoordinator(this.connection).receiveRequest(event.data);
    this.ack(message);
  }
}
