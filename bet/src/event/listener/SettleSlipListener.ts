import { ConsumeMessage, Connection } from "amqplib";
import {
  AListener,
  BetStatus,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  QueueNames,
  ResultingStatus,
  SlipRowStatus,
} from "@betstan/common";
import { Bet } from "../../model/Bet";

class SettleSlipListener extends AListener<ISettleSlipEvent> {
  serviceName: string = "bet_settle_slip";
  queue: QueueNames.SETTLE_SLIP = QueueNames.SETTLE_SLIP;

  async onMessage(event: ISettleSlipEvent, msg: ConsumeMessage) {
    const { data } = event;

    const bet = await Bet.findOne({ slipId: data.slipId });

    if (!bet) {
      // do not ack, handle concurrency
      this.channel.nack(msg, undefined, true);
      return;
    }

    if (data.result == ResultingStatus.BET_WIN) {
      bet.status = BetStatus.WIN;
    } else {
      bet.status = BetStatus.LOSS;
    }

    await bet.save();

    this.channel.ack(msg);
  }
}

export default SettleSlipListener;
