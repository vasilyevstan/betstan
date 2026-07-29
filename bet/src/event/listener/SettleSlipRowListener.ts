import { ConsumeMessage, Connection } from "amqplib";
import {
  AListener,
  ISettleSlipRowEvent,
  QueueNames,
  ResultingStatus,
  SlipRowStatus,
} from "@betstan/common";
import { Bet } from "../../model/Bet";

class SettleSlipRowListener extends AListener<ISettleSlipRowEvent> {
  serviceName: string = "bet_settle_slip_row";
  queue: QueueNames.SETTLE_SLIP_ROW = QueueNames.SETTLE_SLIP_ROW;

  async onMessage(event: ISettleSlipRowEvent, msg: ConsumeMessage) {
    const { data } = event;
    const dataWithWinningSelection = data as ISettleSlipRowEvent["data"] & {
      winningSelection?: string;
    };

    const bet = await Bet.findOne({ slipId: data.slipId });

    if (!bet) {
      // do not ack, handle concurrency
      this.channel.nack(msg, undefined, true);
      return;
    }

    const row = bet.rows.find((row) => row.id === data.slipRowId);

    if (!row) {
      this.channel.ack(msg);
      return;
    }

    if (data.result == ResultingStatus.ROW_WIN) {
      row.status = SlipRowStatus.WIN;
    } else {
      row.status = SlipRowStatus.LOSS;
    }
    row.winningSelection = dataWithWinningSelection.winningSelection || "";

    await bet.save();

    this.channel.ack(msg);
  }
}

export default SettleSlipRowListener;
