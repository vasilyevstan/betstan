import { ConsumeMessage } from "amqplib";
import { AListener, IPlaceBetEvent, QueueNames } from "@betstan/common";
import { Bet } from "../../model/Bet";
import { ModerationStatus } from "@betstan/common";
import BetModerationResultPublisher from "../publisher/BetModerationResultPublisher";
import { Resulted } from "../../model/Resulted";

class PlaceBetListener extends AListener<IPlaceBetEvent> {
  serviceName: string = "moderation_place_bet";
  queue: QueueNames.SLIP_BET = QueueNames.SLIP_BET;

  async onMessage(event: IPlaceBetEvent, msg: ConsumeMessage) {
    const { data } = event;

    const affectedEvents = new Set();

    const bet = new Bet({
      status: ModerationStatus.RECEIVED,
      userId: data.userId,
      slipId: data.slipId,
      wager: data.wager,
      timestamp: event.timestamp,
      moderationTimestamp: "",
      rows: data.rows.map((row) => {
        affectedEvents.add(row.eventId);

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
        };
      }),
    });

    await bet.save();

    // here be some fancy logic to validate the bet
    const publisher = new BetModerationResultPublisher(this.connection);
    await publisher.init();

    let moderationStatus: ModerationStatus;

    const resulted = await Resulted.findOne({
      eventId: [...affectedEvents],
    });

    if (!resulted) {
      console.log("event was not resulted");
      moderationStatus = ModerationStatus.APPROVED;
    } else {
      console.log("event was resulted");
      moderationStatus = ModerationStatus.DECLINED;
    }

    bet.status = moderationStatus;
    bet.moderationTimestamp = new Date().toISOString();
    await bet.save();

    publisher.publish({
      data: {
        slipId: data.slipId,
        result: moderationStatus,
      },
    });

    this.channel.ack(msg);
  }
}

export default PlaceBetListener;
