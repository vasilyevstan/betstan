import { ConsumeMessage } from "amqplib";
import {
  AListener,
  ISettleSlipRowEvent,
  QueueNames,
} from "@betstan/common";
import { PendingBetUpdateKind } from "../../model/PendingBetUpdate";
import {
  applyBetEventWithRetry,
  applySettleSlipRow,
  parkPendingBetUpdate,
} from "../../service/betHistory";

class SettleSlipRowListener extends AListener<ISettleSlipRowEvent> {
  serviceName: string = "bet_settle_slip_row";
  queue: QueueNames.SETTLE_SLIP_ROW = QueueNames.SETTLE_SLIP_ROW;

  async onMessage(event: ISettleSlipRowEvent, msg: ConsumeMessage) {
    const { data } = event;

    // Loads, applies and saves under optimistic-concurrency retry so a
    // concurrent moderation decision or a redelivered duplicate of this
    // same event can never be silently overwritten by a stale save.
    const bet = await applyBetEventWithRetry(
      data.slipId,
      applySettleSlipRow,
      event
    );

    if (!bet) {
      await parkPendingBetUpdate(PendingBetUpdateKind.SETTLE_SLIP_ROW, event);
    }

    this.channel.ack(msg);
  }
}

export default SettleSlipRowListener;
