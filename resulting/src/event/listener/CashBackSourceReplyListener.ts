import { ConsumeMessage } from "amqplib";
import { AListener, ICashBackSourceReplyEvent, QueueNames } from "@betstan/common";
import { getCashBackCoordinator } from "../../service/CashBackCoordinator";

export class CashBackSourceReplyListener extends AListener<ICashBackSourceReplyEvent> {
  queue = QueueNames.CASH_BACK_SOURCE_REPLY;
  serviceName = "resulting_cash_back_source_reply";

  async init(): Promise<void> {
    await super.init();
    await this.channel.prefetch(1);
  }

  async onMessage(event: ICashBackSourceReplyEvent, message: ConsumeMessage): Promise<void> {
    const owner = event.data?.request?.participant?.owner;
    if (
      (owner !== "BACKOFFICE" && owner !== "GAMEMASTER")
      || event.sender !== `${owner.toLowerCase()}_cash_back_source_reply`
    ) {
      console.error("resulting_cash_back_invalid_source_sender");
      this.channel.nack(message, false, false);
      return;
    }
    await getCashBackCoordinator(this.connection).receiveSourceReply(event.data);
    this.ack(message);
  }
}
