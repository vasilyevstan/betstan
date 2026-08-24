import { ConsumeMessage } from "amqplib";
import {
  AListener,
  IModerationResultEvent,
  QueueNames,
} from "@betstan/common";
import { PendingBetUpdateKind } from "../../model/PendingBetUpdate";
import {
  applyBetEventWithRetry,
  applyModerationResult,
  parkPendingBetUpdate,
} from "../../service/betHistory";

class PlaceBetListener extends AListener<IModerationResultEvent> {
  serviceName: string = "bet_moderation_result";
  queue: QueueNames.MODERATION_RESULT = QueueNames.MODERATION_RESULT;

  async onMessage(event: IModerationResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    // Loads, applies and saves under optimistic-concurrency retry so a
    // concurrent settlement (WIN/LOSS/VOID) or a redelivered duplicate of
    // this same event can never be silently overwritten by a stale save.
    const bet = await applyBetEventWithRetry(
      data.slipId,
      applyModerationResult,
      event
    );

    if (!bet) {
      await parkPendingBetUpdate(PendingBetUpdateKind.MODERATION_RESULT, event);
    }

    this.channel.ack(msg);
  }
}

export default PlaceBetListener;
