import { ConsumeMessage } from "amqplib";
import {
  AListener,
  ISettleSlipRowEvent,
  QueueNames,
} from "@betstan/common";
import { Bet } from "../../model/Bet";
import { PendingBetUpdateKind } from "../../model/PendingBetUpdate";
import {
  applySettleSlipRow,
  parkPendingBetUpdate,
} from "../../service/betHistory";

class SettleSlipRowListener extends AListener<ISettleSlipRowEvent> {
  serviceName: string = "bet_settle_slip_row";
  queue: QueueNames.SETTLE_SLIP_ROW = QueueNames.SETTLE_SLIP_ROW;

  async onMessage(event: ISettleSlipRowEvent, msg: ConsumeMessage) {
    const { data } = event;

    const bet = await Bet.findOne({ slipId: data.slipId });

    if (!bet) {
      await parkPendingBetUpdate(PendingBetUpdateKind.SETTLE_SLIP_ROW, event);
      this.channel.ack(msg);
      return;
    }

    if (applySettleSlipRow(bet, event)) {
      await bet.save();
    }

    this.channel.ack(msg);
  }
}

export default SettleSlipRowListener;
