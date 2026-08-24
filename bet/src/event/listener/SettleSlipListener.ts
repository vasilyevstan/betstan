import { ConsumeMessage } from "amqplib";
import {
  AListener,
  ISettleSlipEvent,
  QueueNames,
} from "@betstan/common";
import { PendingBetUpdateKind } from "../../model/PendingBetUpdate";
import {
  applyBetEventWithRetry,
  applySettleSlip,
  parkPendingBetUpdate,
} from "../../service/betHistory";

class SettleSlipListener extends AListener<ISettleSlipEvent> {
  serviceName: string = "bet_settle_slip";
  queue: QueueNames.SETTLE_SLIP = QueueNames.SETTLE_SLIP;

  async onMessage(event: ISettleSlipEvent, msg: ConsumeMessage) {
    const { data } = event;

    // Loads, applies and saves under optimistic-concurrency retry so a
    // concurrent moderation decision or a redelivered duplicate of this
    // same event can never be silently overwritten by a stale save.
    const bet = await applyBetEventWithRetry(
      data.slipId,
      applySettleSlip,
      event
    );

    if (!bet) {
      await parkPendingBetUpdate(PendingBetUpdateKind.SETTLE_SLIP, event);
    }

    this.channel.ack(msg);
  }
}

export default SettleSlipListener;
