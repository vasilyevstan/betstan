import { ConsumeMessage, Connection } from "amqplib";
import {
  AListener,
  BetStatus,
  IPlaceBetEvent,
  QueueNames,
  SlipRowStatus,
} from "@betstan/common";
import { Bet } from "../../model/Bet";

class PlaceBetListener extends AListener<IPlaceBetEvent> {
  serviceName: string = "bet_place_bet";
  queue: QueueNames.SLIP_BET = QueueNames.SLIP_BET;

  async onMessage(event: IPlaceBetEvent, msg: ConsumeMessage) {
    const { data } = event;

    const bet = new Bet({
      status: BetStatus.PENDING,
      userId: data.userId,
      userName: data.userName,
      slipId: data.slipId,
      wager: data.wager,
      timestamp: event.timestamp,
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
          status: SlipRowStatus.NOT_SETTLED,
          id: row.id,
        };
      }),
    });

    await bet.save();

    this.channel.ack(msg);
  }
}

export default PlaceBetListener;
