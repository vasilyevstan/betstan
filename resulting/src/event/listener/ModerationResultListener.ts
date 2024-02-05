import { ConsumeMessage, Connection } from "amqplib";
import {
  AListener,
  IModerationResultEvent,
  ModerationStatus,
  QueueNames,
  ResultingStatus,
} from "@betstan/common";
import { Bet } from "../../model/Bet";

class PlaceBetListener extends AListener<IModerationResultEvent> {
  serviceName: string = "resulting_moderation_result";
  queue: QueueNames.MODERATION_RESULT = QueueNames.MODERATION_RESULT;

  async onMessage(event: IModerationResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    const bet = await Bet.findOne({ slipId: data.slipId });

    if (!bet) {
      return;
      // throw new Error("No bet exists");
    }

    if (data.result === ModerationStatus.APPROVED) {
      bet.status = ResultingStatus.BET_APPROVED;
    } else {
      bet.status = ResultingStatus.BET_DECLINED;
    }
    await bet.save();

    this.channel.ack(msg);
  }
}

export default PlaceBetListener;
