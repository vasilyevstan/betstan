import { ConsumeMessage } from "amqplib";
import {
  AListener, APublisher, ICashBackSourceReplyEvent, ICashBackSourceRequestEvent, QueueNames,
} from "@betstan/common";
import { handleCashBackSourceRequest } from "../../service/CashBackSourceService";

class CashBackSourceReplyPublisher extends APublisher<ICashBackSourceReplyEvent> {
  queue = QueueNames.CASH_BACK_SOURCE_REPLY;
  serviceName = "gamemaster_cash_back_source_reply";
}

export class CashBackSourceListener extends AListener<ICashBackSourceRequestEvent> {
  queue = QueueNames.CASH_BACK_SOURCE_REQUEST;
  serviceName = "gamemaster_cash_back_source";
  private readonly publisher = new CashBackSourceReplyPublisher(this.connection);

  async init(): Promise<void> {
    await super.init();
    await this.channel.prefetch(1);
    await this.publisher.initConfirmChannel();
  }

  async onMessage(event: ICashBackSourceRequestEvent, message: ConsumeMessage): Promise<void> {
    if (event.sender !== "resulting_cash_back_source") {
      console.error("gamemaster_cash_back_invalid_sender");
      this.channel.nack(message, false, false);
      return;
    }
    if (event.data?.participant?.owner === "BACKOFFICE") {
      this.ack(message);
      return;
    }
    const reply = await handleCashBackSourceRequest(event.data);
    await this.publisher.publishWithConfirm({ data: reply });
    this.ack(message);
  }
}
