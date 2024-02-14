import { ConsumeMessage, Connection } from "amqplib";
import {
  AListener,
  BetStatus,
  IModerationResultEvent,
  ModerationStatus,
  QueueNames,
} from "@betstan/common";
import { Bet } from "../../model/Bet";

class PlaceBetListener extends AListener<IModerationResultEvent> {
  serviceName: string = "bet_moderation_result";
  queue: QueueNames.MODERATION_RESULT = QueueNames.MODERATION_RESULT;

  async onMessage(event: IModerationResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    const bet = await Bet.findOne({ slipId: data.slipId });

    if (!bet) {
      // do not ack, handle concurrency
      this.channel.nack(msg, undefined, true);
      return;
    }

    if (data.result === ModerationStatus.APPROVED) {
      bet.status = BetStatus.CONFIRMED;
    } else {
      bet.status = BetStatus.DECLINED;
    }
    await bet.save();

    this.channel.ack(msg);
  }
}

export default PlaceBetListener;
