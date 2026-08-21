import { ConsumeMessage } from "amqplib";
import {
  AListener,
  IModerationResultEvent,
  QueueNames,
} from "@betstan/common";
import { Bet } from "../../model/Bet";
import { PendingBetUpdateKind } from "../../model/PendingBetUpdate";
import {
  applyModerationResult,
  parkPendingBetUpdate,
} from "../../service/betHistory";

class PlaceBetListener extends AListener<IModerationResultEvent> {
  serviceName: string = "bet_moderation_result";
  queue: QueueNames.MODERATION_RESULT = QueueNames.MODERATION_RESULT;

  async onMessage(event: IModerationResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    const bet = await Bet.findOne({ slipId: data.slipId });

    if (!bet) {
      await parkPendingBetUpdate(PendingBetUpdateKind.MODERATION_RESULT, event);
      this.channel.ack(msg);
      return;
    }

    if (applyModerationResult(bet, event)) {
      await bet.save();
    }

    this.channel.ack(msg);
  }
}

export default PlaceBetListener;
