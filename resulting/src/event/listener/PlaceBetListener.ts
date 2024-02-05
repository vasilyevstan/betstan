import { ConsumeMessage } from "amqplib";
import {
  AListener,
  IPlaceBetEvent,
  QueueNames,
  ResultingStatus,
} from "@betstan/common";
import { Bet } from "../../model/Bet";

class PlaceBetListener extends AListener<IPlaceBetEvent> {
  serviceName: string = "resulting_place_bet";
  queue: QueueNames.SLIP_BET = QueueNames.SLIP_BET;

  async onMessage(event: IPlaceBetEvent, msg: ConsumeMessage) {
    const { data } = event;

    const bet = new Bet({
      status: ResultingStatus.BET_PENDING,
      userId: data.userId,
      slipId: data.slipId,
      wager: data.wager,
      timestamp: event.timestamp,
      moderationTimestamp: "",
      resultingTimestamp: "",
      rows: data.rows.map((row) => {
        return {
          eventId: row.eventId,
          eventName: row.eventName,
          oddsId: row.oddsId,
          oddsValue: row.oddsValue,
          oddsName: row.oddsName,
          productName: row.productName,
          productId: row.productId,
          timestamp: row.timestamp,
          id: row.id,
          resultingTimestamp: "",
          result: ResultingStatus.ROW_NO_RESULT,
        };
      }),
    });

    await bet.save();

    this.channel.ack(msg);
  }
}

export default PlaceBetListener;
