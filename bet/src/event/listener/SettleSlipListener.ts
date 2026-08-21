import { ConsumeMessage } from "amqplib";
import {
  AListener,
  ISettleSlipEvent,
  QueueNames,
} from "@betstan/common";
import { Bet } from "../../model/Bet";
import { PendingBetUpdateKind } from "../../model/PendingBetUpdate";
import {
  applySettleSlip,
  parkPendingBetUpdate,
} from "../../service/betHistory";

class SettleSlipListener extends AListener<ISettleSlipEvent> {
  serviceName: string = "bet_settle_slip";
  queue: QueueNames.SETTLE_SLIP = QueueNames.SETTLE_SLIP;

  async onMessage(event: ISettleSlipEvent, msg: ConsumeMessage) {
    const { data } = event;

    const bet = await Bet.findOne({ slipId: data.slipId });

    if (!bet) {
      await parkPendingBetUpdate(PendingBetUpdateKind.SETTLE_SLIP, event);
      this.channel.ack(msg);
      return;
    }

    if (applySettleSlip(bet, event)) {
      await bet.save();
    }

    this.channel.ack(msg);
  }
}

export default SettleSlipListener;
